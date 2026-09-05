import type { ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";

import type { HarnessAdapter } from "../adapters/adapter.js";
import { LIMITS } from "../core/limits.js";
import type { PriceTable } from "../core/pricing.js";
import { priceKey, withEstimatedCost } from "../core/pricing.js";
import { buildDelegationPrompt } from "../core/prompt.js";
import { redactPotentialSecrets } from "../core/redaction.js";
import type { InputRequest, JobStatus, SpawnFunction, StopChildFunction, TaskRecord } from "../core/types.js";
import { describeWorkspaceChanges, diffSnapshots, snapshotWorkspace } from "../platform/workspace.js";
import { isRecord, parseJsonLine, sanitizeEventData } from "./events.js";
import { collectorFor } from "./metrics-collector.js";
import { dispatchToSinks, type MetricsSink } from "./observability.js";
import { mayRetry, retryBackoffMs } from "./retry-policy.js";

const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "timed_out", "canceled"];

export interface TaskLifecycleDependencies {
  spawn: SpawnFunction;
  stopChild: StopChildFunction;
  getAdapter(id: string): HarnessAdapter;
  now(): Date;
  random(): number;
  schedule(callback: () => void, delay: number): NodeJS.Timeout;
  cancelSchedule(handle: NodeJS.Timeout): void;
  classifyAndOpenCircuit(record: TaskRecord, status: JobStatus): number | undefined;
  clearCircuit(record: TaskRecord): void;
  /** Every registered metrics sink, dispatched to once a job reaches a terminal status. */
  metricsSinks: readonly MetricsSink[];
  /** Backs `withEstimatedCost` when a harness reports tokens but no cost. */
  priceTable: PriceTable;
}

/** Owns a worker process from launch through output capture, retry, and final status. */
export class TaskLifecycle {
  public constructor(private readonly dependencies: TaskLifecycleDependencies) {}

  public launch(record: TaskRecord, continuationPrompt?: string): void {
    const adapter = this.dependencies.getAdapter(record.harness);
    const spec = adapter.command({
      prompt: continuationPrompt === undefined
        ? buildDelegationPrompt(record.task, record.workspace, record.taskMode)
        : continuationPrompt,
      workspace: record.workspace,
      timeoutSeconds: record.timeoutSeconds,
      model: record.model,
      effort: record.effort,
      permissionMode: record.permissionMode,
      taskMode: record.taskMode,
      conversationId: continuationPrompt === undefined ? undefined : record.conversationId,
    });
    let child: ChildProcess;
    try {
      child = this.dependencies.spawn(spec.command, spec.args, {
        cwd: spec.cwd ?? record.workspace,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
      });
    } catch (error) {
      void this.finalize(record, "failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* the child may exit before reading its prompt */ });
      child.stdin.end(spec.stdin);
    }
    record.child = child;
    record.pid = child.pid;
    record.status = "running";
    record.finishedAt = undefined;
    record.startedAt ??= this.dependencies.now().toISOString();
    record.timeoutHandle = this.dependencies.schedule(() => {
      if (record.status === "running") {
        record.cancellationRequested = true;
        record.forcedTerminalStatus = "timed_out";
        void this.dependencies.stopChild(child);
        void this.finalize(record, "timed_out", "Task exceeded its configured timeout.");
      }
    }, record.timeoutSeconds * 1_000);
    child.once("error", (error) => void this.finalize(record, "failed", error.message));
    child.once("close", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      const status = this.exitStatus(record, code);
      const harnessReportedEnd = record.outcome === "succeeded" || record.outcome === "canceled";
      const detail = code === 0 && !record.forcedTerminalStatus && !record.cancellationRequested && !harnessReportedEnd
        ? record.outcomeDetail ?? `${adapter.displayName} exited without a terminal result event.`
        : undefined;
      void this.finalize(record, status, detail);
    });
    this.captureStream(child.stdout, record, false);
    this.captureStream(child.stderr, record, true);
  }

  private exitStatus(record: TaskRecord, code: number | null): JobStatus {
    if (record.forcedTerminalStatus) return record.forcedTerminalStatus;
    if (record.cancellationRequested) return "canceled";
    if (code !== 0) return "failed";
    if (record.inputRequest) return "awaiting_input";
    return record.outcome ?? "failed";
  }

  private captureStream(stream: NodeJS.ReadableStream | null, record: TaskRecord, stderr: boolean): void {
    if (!stream) return;
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const received = String(chunk);
      if (stderr) {
        const sanitized = redactPotentialSecrets(received);
        void appendFile(record.logPath, sanitized, "utf8");
        record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${sanitized}`);
        return;
      }
      pending += received;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.recordEvent(record, line);
    });
    stream.on("end", () => { if (!stderr && pending) this.recordEvent(record, pending); });
  }

  private recordEvent(record: TaskRecord, line: string): void {
    const event = parseJsonLine(line, this.dependencies.now().toISOString());
    if (!event) return;
    event.data = sanitizeEventData(event.data);
    void appendFile(record.logPath, `${JSON.stringify(event)}\n`, "utf8");
    record.events.push(event);
    if (record.events.length > LIMITS.maxEvents) record.events.shift();
    const collector = collectorFor(record);
    collector.recordEvent();
    if (event.type === "unparsed_output" || !isRecord(event.data)) return;
    const fields = this.dependencies.getAdapter(record.harness).interpret(event.data);
    if (typeof fields.sessionId === "string") {
      record.sessionId = fields.sessionId;
      record.conversationId = fields.sessionId;
    }
    if (typeof fields.summary === "string") record.summary = fields.summary;
    if (fields.usage) {
      const price = this.dependencies.priceTable[priceKey(record.harness, record.model)];
      record.usage = withEstimatedCost(fields.usage, price);
    }
    if (fields.outcome) {
      record.outcome = fields.outcome;
      record.outcomeDetail = fields.detail;
    }
    if (fields.failureMessage) {
      record.failure = {
        message: redactPotentialSecrets(fields.failureMessage),
        source: fields.failureSource ?? "harness",
      };
    }
    if (fields.workerResult) {
      if (fields.workerResult.status === "input_required") {
        const inputRequest = normalizeInputRequest(fields.workerResult);
        if (inputRequest) record.inputRequest = inputRequest;
      } else {
        record.inputRequest = undefined;
      }
    }
    // Appended, never overwritten: a worker streams one tool event per line, so the
    // last line never carries the whole picture the way the other fields above do.
    if (fields.toolCalls?.length) {
      record.toolCalls = record.toolCalls ? [...record.toolCalls, ...fields.toolCalls] : [...fields.toolCalls];
      collector.addToolCalls(fields.toolCalls);
    }
    if (typeof fields.turns === "number") record.turns = fields.turns;
  }

  /** Resume a worker conversation after a clarification or terminal recovery request. */
  public resume(record: TaskRecord, instruction: string, kind: "answer" | "resume"): void {
    record.inputRequest = undefined;
    record.status = "queued";
    this.resetForRelaunch(record, false);
    const prompt = kind === "answer" ? buildContinuationPrompt(instruction) : buildRecoveryPrompt(instruction);
    this.launch(record, prompt);
  }

  /**
   * Clear the per-attempt output fields every relaunch (clarification answer or retry)
   * starts fresh with. `full` also drops the previous attempt's stream, session, usage,
   * and timing — used by retries, which re-measure the same job from scratch.
   */
  private resetForRelaunch(record: TaskRecord, full: boolean): void {
    record.stderrSummary = "";
    record.summary = undefined;
    record.outcome = undefined;
    record.outcomeDetail = undefined;
    record.failure = undefined;
    record.workspaceChanges = undefined;
    record.partialWorkspaceChanges = undefined;
    record.errorCategory = undefined;
    record.retryable = false;
    record.nextRetryAt = undefined;
    record.blockedUntil = undefined;
    record.exitCode = undefined;
    record.signal = undefined;
    record.pid = undefined;
    record.timeoutHandle = undefined;
    record.forcedTerminalStatus = undefined;
    record.cancellationRequested = false;
    if (full) {
      record.events = [];
      record.sessionId = undefined;
      record.usage = undefined;
      record.startedAt = undefined;
      record.finishedAt = undefined;
    }
  }

  /** Finalize a task that is waiting for input without trying to spawn or stop a child. */
  public async cancelAwaitingInput(record: TaskRecord): Promise<void> {
    await this.finalize(record, "canceled");
  }

  private async finalize(record: TaskRecord, status: JobStatus, detail?: string): Promise<void> {
    if (record.finalizing || TERMINAL_STATUSES.includes(record.status)) return;
    record.finalizing = true;
    if (record.timeoutHandle) this.dependencies.cancelSchedule(record.timeoutHandle);
    if (detail) record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${detail}`);
    const retryAfterMs = status === "failed" || status === "timed_out" ? this.dependencies.classifyAndOpenCircuit(record, status) : undefined;
    try {
      if (record.beforeSnapshot) {
        const after = await snapshotWorkspace(record.workspace);
        const changes = diffSnapshots(record.beforeSnapshot, after.snapshot, after.truncated);
        const workspaceChanges = describeWorkspaceChanges(
          changes,
          record.workspaceSnapshotStartedAt ?? record.createdAt,
          this.dependencies.now().toISOString(),
          record.overlappingJobIds,
        );
        if (status === "awaiting_input") {
          record.partialWorkspaceChanges = workspaceChanges;
        } else {
          record.workspaceChanges = workspaceChanges;
          record.partialWorkspaceChanges = status === "failed" || status === "timed_out" ? workspaceChanges : undefined;
        }
        if (after.truncated) record.warnings.push("Post-task file snapshot reached its entry limit; change detection is partial.");
      }
    } catch (error) {
      record.warnings.push(`Could not collect changed files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.child = undefined;
      record.status = status;
      record.finishedAt = status === "awaiting_input" ? undefined : this.dependencies.now().toISOString();
      record.finalizing = false;
      if (status === "awaiting_input") {
        this.applyInputRequestPolicy(record);
      } else if (status === "succeeded") {
        this.dependencies.clearCircuit(record);
        record.errorCategory = undefined;
        record.retryable = false;
        record.nextRetryAt = undefined;
        record.blockedUntil = undefined;
      } else {
        this.applyFailurePolicy(record, retryAfterMs);
      }
    }
    // applyFailurePolicy may have requeued the job for a retry — not actually finished yet,
    // so only a truly terminal status is reported. The collector carries over, nothing is lost.
    if (TERMINAL_STATUSES.includes(record.status)) {
      this.ensureFailure(record);
      const metrics = collectorFor(record).build(record);
      dispatchToSinks(this.dependencies.metricsSinks, metrics);
    }
  }

  private applyInputRequestPolicy(record: TaskRecord): void {
    const request = record.inputRequest;
    if (!request) {
      this.failWith(record, "Worker requested input without a valid structured question.");
      return;
    }
    if (!record.conversationId) {
      this.failWith(record, "Worker requested input without reporting a conversation_id; continuation is unavailable.");
      return;
    }
    if (record.inputRounds >= LIMITS.maxInputRounds) {
      this.failWith(record, `Worker exceeded the maximum of ${LIMITS.maxInputRounds} clarification rounds.`, "Clarification round limit reached; task was stopped to avoid an input loop.");
      return;
    }
    if (record.inputQuestionHistory.includes(request.question)) {
      this.failWith(record, "Worker repeated the same clarification question after an answer.", "Repeated clarification question; task was stopped to avoid an input loop.");
      return;
    }
    record.inputQuestionHistory.push(request.question);
  }

  /** Terminal failure with a redacted diagnostic, and optionally a warning for the orchestrator. */
  private failWith(record: TaskRecord, message: string, warning?: string): void {
    record.status = "failed";
    record.finishedAt = this.dependencies.now().toISOString();
    record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${message}`);
    if (warning) record.warnings.push(warning);
  }

  private applyFailurePolicy(record: TaskRecord, classifiedRetryAfterMs?: number): void {
    if (record.status !== "failed" && record.status !== "timed_out") return;
    const fallbackDelay = classifiedRetryAfterMs === undefined ? retryBackoffMs(record.retryCount, () => this.dependencies.random()) : undefined;
    record.retryable = mayRetry(record);
    if (!record.retryable) return;
    if (classifiedRetryAfterMs !== undefined && classifiedRetryAfterMs > LIMITS.maxRetryAfterMs) {
      const retryAt = new Date(this.dependencies.now().getTime() + classifiedRetryAfterMs).toISOString();
      record.nextRetryAt = retryAt;
      record.blockedUntil = retryAt;
      record.retryable = false;
      record.warnings.push("Provider retry window exceeds five minutes; no automatic retry was scheduled.");
      return;
    }
    const delay = classifiedRetryAfterMs ?? fallbackDelay!;
    record.retryCount += 1;
    record.nextRetryAt = new Date(this.dependencies.now().getTime() + delay).toISOString();
    record.cancellationRequested = false;
    record.forcedTerminalStatus = undefined;
    record.status = "queued";
    record.retryHandle = this.dependencies.schedule(() => {
      record.retryHandle = undefined;
      if (record.status !== "queued" || record.cancellationRequested) return;
      void this.prepareRetryLaunch(record);
    }, delay);
  }

  private async prepareRetryLaunch(record: TaskRecord): Promise<void> {
    try {
      const snapshot = await snapshotWorkspace(record.workspace);
      record.beforeSnapshot = snapshot.snapshot;
      if (snapshot.truncated) record.warnings.push("Retry pre-task file snapshot reached its entry limit; change detection is partial.");
      this.resetForRelaunch(record, true);
      this.launch(record);
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.dependencies.now().toISOString();
      record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\nRetry setup failed: ${error instanceof Error ? error.message : String(error)}`);
      record.errorCategory = "upstream_error";
      record.retryable = false;
    }
  }

  private ensureFailure(record: TaskRecord): void {
    if (record.status !== "failed" && record.status !== "timed_out") return;
    const fallback = record.status === "timed_out"
      ? "Task exceeded its configured timeout."
      : record.outcomeDetail ?? `Worker process exited with code ${record.exitCode ?? "unknown"}.`;
    const failure = record.failure ?? {
      message: fallback,
      source: record.status === "timed_out" ? "bridge" as const : "process" as const,
    };
    record.failure = {
      ...failure,
      category: record.errorCategory,
      exitCode: record.exitCode,
      signal: record.signal,
    };
    if (!record.stderrSummary.trim()) record.stderrSummary = failure.message;
  }
}

function buildContinuationPrompt(answer: string): string {
  return [
    "The orchestrator answered your clarification. Continue the existing task now.",
    "Use the answer below; do not ask the same question again. Return the required structured result when finished or when genuinely blocked.",
    "ANSWER:",
    answer,
  ].join("\n");
}

function buildRecoveryPrompt(instruction: string): string {
  return [
    "Resume the existing task from the current workspace state.",
    "Review any work already completed, then continue toward the original task's stop condition. Return the required structured result when finished or genuinely blocked.",
    "RECOVERY INSTRUCTION:",
    instruction,
  ].join("\n");
}

function normalizeInputRequest(result: { summary?: string; question?: string; options?: string[]; recommendedOption?: string; category?: string }): InputRequest | undefined {
  const question = result.question?.trim();
  if (!question) return undefined;
  const summary = result.summary?.trim();
  const options = result.options?.map((option) => option.trim()).filter(Boolean).slice(0, LIMITS.maxInputOptions);
  return {
    question: question.slice(0, LIMITS.maxInputAnswerChars),
    summary: summary?.slice(0, LIMITS.maxInputAnswerChars),
    workSoFar: summary?.slice(0, LIMITS.maxInputAnswerChars),
    options: options?.length ? options.map((option) => option.slice(0, LIMITS.maxInputAnswerChars)) : undefined,
    recommendedOption: result.recommendedOption?.trim().slice(0, LIMITS.maxInputAnswerChars) || undefined,
    category: result.category?.trim().slice(0, 200) || undefined,
  };
}
