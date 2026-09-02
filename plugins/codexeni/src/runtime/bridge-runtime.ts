import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRunner, HarnessAdapter, HarnessProbe } from "../adapters/adapter.js";
import { defaultClassifyFailure, defaultRetryAfterMs } from "../core/failure.js";
import { LIMITS } from "../core/limits.js";
import type { UsageRollup } from "../core/metrics.js";
import type { PriceTable } from "../core/pricing.js";
import type { AllowedRootSource, BridgeConfig, CircuitBreaker, Effort, InputRequest, RuntimeDependencies, SpawnFunction, StopChildFunction, TaskMode, TaskRecord } from "../core/types.js";
import { DEFAULT_HARNESS, resolveBridgeConfig, resolveMetricsFilePath, resolvePriceTable } from "../platform/config.js";
import { captureCommand, stopChildProcess } from "../platform/process.js";
import { WorkspaceGuard, canonicalizeWorkspace, snapshotWorkspace } from "../platform/workspace.js";
import { compactRecord, redactPotentialSecrets, type EventDetail } from "./events.js";
import { DiscoveryCache } from "./discovery.js";
import { MemoryAggregator, NdjsonSink, type MetricsSink } from "./observability.js";
import { TaskLifecycle } from "./task-lifecycle.js";

export interface StartTaskInput {
  task: string;
  workspace: string;
  harness?: string;
  model?: string;
  effort?: Effort;
  timeoutSeconds?: number;
  taskMode?: TaskMode;
  maxRetries?: number;
}

export interface HarnessReport extends HarnessProbe {
  id: string;
  displayName: string;
  executable: string;
  defaultModel?: string;
}

/**
 * Sinks and pricing this runtime uses for observability, both optional — real usage
 * gets environment defaults, tests inject their own. Travels as a second constructor argument since `RuntimeDependencies` is frozen and couldn't add this seam.
 */
export interface BridgeRuntimeMetricsOptions {
  /** Extra sinks beyond the runtime's own `MemoryAggregator`, which always receives every job and always backs `delegate_discover`'s totals. */
  sinks?: readonly MetricsSink[];
  priceTable?: PriceTable;
}

/** MCP-facing facade for bridge state, adapter selection, and task coordination. */
export class BridgeRuntime {
  public readonly config: BridgeConfig;
  public readonly jobs = new Map<string, TaskRecord>();
  public readonly breakers = new Map<string, CircuitBreaker>();
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly guard: WorkspaceGuard;
  private readonly spawnImpl: SpawnFunction;
  private readonly stopChildImpl: StopChildFunction;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly cancelTimeout: (timeout: NodeJS.Timeout) => void;
  private readonly mkdtempImpl: typeof mkdtemp;
  private readonly createId: () => string;
  private readonly discovery: DiscoveryCache<HarnessProbe>;
  private readonly lifecycle: TaskLifecycle;
  private allowedRootSource: AllowedRootSource;
  /** Every finished job's metrics, in-process, keyed by harness+model. Always present so `delegate_discover` can report totals regardless of which other sinks are configured. */
  private readonly aggregator = new MemoryAggregator();
  private readonly sinks: readonly MetricsSink[];
  private readonly priceTable: PriceTable;
  /** Per-job temp directories this instance created via `mkdtempImpl`, removed on `shutdown()`. */
  private readonly tempDirs = new Set<string>();

  public constructor(dependencies: RuntimeDependencies = {}, metricsOptions: BridgeRuntimeMetricsOptions = {}) {
    const provided = dependencies.config ?? resolveBridgeConfig();
    this.config = {
      ...provided,
      defaultHarness: provided.defaultHarness ?? DEFAULT_HARNESS,
      harnesses: provided.harnesses ?? {},
      maxConcurrency: Math.min(Math.max(1, provided.maxConcurrency), LIMITS.maxConcurrency),
    };
    this.guard = new WorkspaceGuard(this.config.allowedRoots);
    this.allowedRootSource = this.config.allowedRoots.length > 0 ? "environment" : "task_workspace";
    this.spawnImpl = dependencies.spawnImpl ?? nodeSpawn;
    this.stopChildImpl = dependencies.stopChildImpl ?? stopChildProcess;
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.randomImpl ?? Math.random;
    this.scheduleTimeout = dependencies.setTimeoutImpl ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimeout = dependencies.clearTimeoutImpl ?? ((timeout) => clearTimeout(timeout));
    this.mkdtempImpl = dependencies.mkdtempImpl ?? mkdtemp;
    this.createId = dependencies.randomUUIDImpl ?? randomUUID;
    this.discovery = new DiscoveryCache(() => this.now().getTime(), LIMITS.discoveryCacheMs);
    this.priceTable = metricsOptions.priceTable ?? resolvePriceTable();
    this.sinks = [this.aggregator, ...(metricsOptions.sinks ?? this.defaultExtraSinks())];
    this.lifecycle = new TaskLifecycle({
      spawn: this.spawnImpl,
      stopChild: this.stopChildImpl,
      getAdapter: (id) => this.getAdapter(id),
      now: this.now,
      random: this.random,
      schedule: this.scheduleTimeout,
      cancelSchedule: this.cancelTimeout,
      classifyAndOpenCircuit: (record) => this.classifyAndOpenCircuit(record),
      clearCircuit: (record) => this.breakers.delete(this.breakerKey(record.harness, record.model)),
      metricsSinks: this.sinks,
      priceTable: this.priceTable,
    });
  }

  /** `NdjsonSink` from `BRIDGE_METRICS_FILE` when the caller does not inject its own sinks; otherwise none. */
  private defaultExtraSinks(): MetricsSink[] {
    const path = resolveMetricsFilePath();
    return path ? [new NdjsonSink(path)] : [];
  }

  /** Cumulative usage rollups from every job this runtime has finalized, keyed by harness+model. Backs `delegate_discover`'s `totals` block. */
  public getUsageTotals(): UsageRollup[] {
    return this.aggregator.rollups();
  }

  public registerAdapter(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.discovery.clear(adapter.id);
  }

  public getAdapter(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown harness: ${id}. Available: ${[...this.adapters.keys()].join(", ") || "none"}`);
    return adapter;
  }

  /** Probe expensive harness state through a short cache; bridge state stays live. */
  public async discover(options: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
    this.expireBreakers();
    const configuredAllowedRoots = await Promise.all(this.guard.getConfiguredRoots().map(async (root) => {
      try { return { configured: root, canonical: await canonicalizeWorkspace(root) }; }
      catch (error) { return { configured: root, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const harnesses: Record<string, HarnessReport> = {};
    for (const adapter of this.adapters.values()) {
      const probe = await this.discovery.get(adapter.id, options.refresh === true, () => this.runAdapterProbe(adapter));
      harnesses[adapter.id] = { id: adapter.id, displayName: adapter.displayName, executable: adapter.executable, defaultModel: adapter.defaultModel, ...probe };
    }
    return {
      defaultHarness: this.config.defaultHarness,
      permissionMode: this.config.permissionMode,
      maxConcurrency: this.config.maxConcurrency,
      allowedRootSource: this.allowedRootSource,
      configuredAllowedRoots,
      taskWorkspaceFallback: this.allowedRootSource === "task_workspace",
      activeJobs: this.activeJobs().length,
      limits: {
        maxConcurrency: this.config.maxConcurrency,
        maxInputRounds: LIMITS.maxInputRounds,
        maxInputAnswerChars: LIMITS.maxInputAnswerChars,
        maxStatusWaitSeconds: LIMITS.maxStatusWaitSeconds,
      },
      // No sampling or roots capability: the bridge implements neither.
      humanInput: {
        modes: ["mrtr", "legacy_elicitation_shim", "external"],
        toolName: "delegate_respond",
        note: "The bridge asks for human input through delegate_respond with action: \"elicit\". Clients on protocol revision 2026-07-28 get a native input_required round trip; older clients are served by the SDK's legacy elicitation shim. A client that supports neither should collect the answer from the user itself and relay it with action: \"answer\" and answeredBy: \"human\". Credentials and secrets are never requested this way.",
      },
      circuitBreakers: [...this.breakers.values()],
      harnesses: Object.fromEntries(Object.entries(harnesses).map(([id, report]) => [id, {
        ...report,
        supportsContinuation: this.adapters.get(id)?.supportsContinuation === true,
      }])),
    };
  }

  public async startTask(input: StartTaskInput): Promise<Record<string, unknown>> {
    const adapter = this.getAdapter(input.harness ?? this.config.defaultHarness);
    if (!input.task.trim()) throw new Error("Task must not be empty.");
    if (!input.workspace.trim()) throw new Error("Workspace must not be empty.");
    if (input.timeoutSeconds !== undefined && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > this.config.defaultTimeoutSeconds)) {
      throw new Error(`timeoutSeconds must be a positive integer no greater than ${this.config.defaultTimeoutSeconds}.`);
    }
    if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > LIMITS.readOnlyMaxRetries)) {
      throw new Error(`maxRetries must be an integer from 0 to ${LIMITS.readOnlyMaxRetries}.`);
    }
    const taskMode = input.taskMode ?? "coding";
    if (taskMode !== "coding" && taskMode !== "read_only") throw new Error("taskMode must be either coding or read_only.");
    const selection = adapter.resolveSelection?.(input.model, input.effort) ?? {};
    const model = selection.model ?? input.model ?? adapter.defaultModel;
    this.assertModelAvailable(adapter.id, model);
    const workspace = await this.guard.assertAllowed(input.workspace, true);
    const active = this.activeJobs();
    if (active.length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached.`);

    const id = this.createId();
    const overlappingJobs = active.filter((job) => job.workspace === workspace);
    for (const job of overlappingJobs) {
      if (!job.overlappingJobIds.includes(id)) job.overlappingJobIds.push(id);
    }
    const folder = await this.mkdtempImpl(join(tmpdir(), "codexeni-"));
    this.tempDirs.add(folder);
    const record: TaskRecord = {
      id,
      harness: adapter.id,
      task: input.task,
      workspace,
      model,
      effort: input.effort ?? "high",
      timeoutSeconds: Math.min(input.timeoutSeconds ?? this.config.defaultTimeoutSeconds, this.config.defaultTimeoutSeconds),
      permissionMode: this.config.permissionMode,
      taskMode,
      maxRetries: taskMode === "read_only" ? input.maxRetries ?? LIMITS.readOnlyMaxRetries : 0,
      retryCount: 0,
      inputRounds: 0,
      inputQuestionHistory: [],
      retryable: false,
      overlappingJobIds: overlappingJobs.map((job) => job.id),
      status: "queued",
      createdAt: this.now().toISOString(),
      stderrSummary: "",
      logPath: join(folder, `${id}.ndjson`),
      events: [],
      warnings: [
        ...(selection.warning ? [selection.warning] : []),
        ...(overlappingJobs.length ? ["Another job is already writing to this workspace; workspace changes cannot be attributed to one job."] : []),
      ],
    };
    this.jobs.set(id, record);
    try {
      const initial = await snapshotWorkspace(workspace);
      record.beforeSnapshot = initial.snapshot;
      record.workspaceSnapshotStartedAt = this.now().toISOString();
      if (initial.truncated) record.warnings.push("Pre-task file snapshot reached its entry limit; change detection is partial.");
      this.lifecycle.launch(record);
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.now().toISOString();
      record.stderrSummary = error instanceof Error ? error.message : String(error);
      record.failure = { message: redactPotentialSecrets(record.stderrSummary), source: "bridge" };
    }
    return { jobId: id, harness: record.harness, status: record.status, warnings: record.warnings, workspace, model: record.model, taskMode: record.taskMode, maxRetries: record.maxRetries };
  }

  public getAllowedRootSource(): AllowedRootSource {
    return this.allowedRootSource;
  }

  public getTask(jobId: string, eventLimit = 50, eventDetail: EventDetail = "compact"): Record<string, unknown> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    // Look up directly rather than getAdapter(), which throws: a job whose adapter was
    // unregistered since it ran must still be inspectable.
    const continuationSupported = this.adapters.get(record.harness)?.supportsContinuation === true;
    return compactRecord(record, Math.max(1, Math.min(eventLimit, LIMITS.maxEvents)), eventDetail, continuationSupported);
  }

  /**
   * Block until jobId leaves queued/running, the wait bound elapses, or signal aborts —
   * whichever comes first. Never throws on timeout; the caller reads the resulting status.
   */
  public async waitForSettled(jobId: string, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    const isSettled = (): boolean => {
      const record = this.jobs.get(jobId);
      if (!record) throw new Error(`Unknown job ID: ${jobId}`);
      return record.status !== "queued" && record.status !== "running";
    };
    const deadline = this.now().getTime() + Math.max(0, maxWaitMs);
    while (!isSettled() && this.now().getTime() < deadline && signal?.aborted !== true) {
      await this.delay(Math.min(LIMITS.statusWaitPollMs, deadline - this.now().getTime()), signal);
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.cancelTimeout(timeout);
        resolve();
      };
      const timeout = this.scheduleTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Return the bounded clarification currently preventing this task from continuing. */
  public getPendingInput(jobId: string): InputRequest & { round: number; maxRounds: number } {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (record.status !== "awaiting_input" || !record.inputRequest) throw new Error(`Job ${jobId} is not awaiting input.`);
    return {
      ...record.inputRequest,
      options: record.inputRequest.options ? [...record.inputRequest.options] : undefined,
      round: record.inputRounds + 1,
      maxRounds: LIMITS.maxInputRounds,
    };
  }

  /** Continue an Antigravity conversation with a bounded orchestrator or human answer. */
  public async respondTask(jobId: string, answer: string, answeredBy: "orchestrator" | "human"): Promise<Record<string, unknown>> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (record.status !== "awaiting_input" || !record.inputRequest) throw new Error(`Job ${jobId} is not awaiting input.`);
    if (answeredBy !== "orchestrator" && answeredBy !== "human") throw new Error("answeredBy must be either orchestrator or human.");
    if (typeof answer !== "string" || !answer.trim()) throw new Error("Answer must not be empty.");
    if (answer.length > LIMITS.maxInputAnswerChars) throw new Error(`Answer must be no more than ${LIMITS.maxInputAnswerChars} characters.`);
    if (record.inputRounds >= LIMITS.maxInputRounds) throw new Error(`Job ${jobId} has reached the maximum of ${LIMITS.maxInputRounds} clarification rounds.`);
    const adapter = this.getAdapter(record.harness);
    if (adapter.supportsContinuation !== true || !record.conversationId) throw new Error(`Harness ${record.harness} cannot continue this task after input is requested.`);
    if (this.activeJobs().length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached; retry this response after an active job finishes.`);
    this.assertModelAvailable(record.harness, record.model);

    record.inputRounds += 1;
    record.warnings.push(`Clarification round ${record.inputRounds} answered by ${answeredBy}.`);
    this.lifecycle.resume(record, answer.trim(), "answer");
    return {
      jobId,
      status: record.status,
      conversationId: record.conversationId,
      inputRounds: record.inputRounds,
      maxInputRounds: LIMITS.maxInputRounds,
    };
  }

  /** Resume a failed or timed-out worker conversation without requiring an input request. */
  public async resumeTask(jobId: string, instruction?: string): Promise<Record<string, unknown>> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (record.status !== "failed" && record.status !== "timed_out") throw new Error(`Job ${jobId} is not failed or timed out.`);
    if (instruction !== undefined && (!instruction.trim() || instruction.length > LIMITS.maxInputAnswerChars)) {
      throw new Error(`instruction must be a non-empty string no more than ${LIMITS.maxInputAnswerChars} characters.`);
    }
    const adapter = this.getAdapter(record.harness);
    if (adapter.supportsContinuation !== true || !record.conversationId) throw new Error(`Harness ${record.harness} cannot resume this task because no worker conversation is available.`);
    if (this.activeJobs().length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached; retry this resume after an active job finishes.`);
    this.assertModelAvailable(record.harness, record.model);

    const recoveryInstruction = instruction?.trim() ?? "Continue the original task from the current workspace state.";
    record.warnings.push("Task resumed after a terminal failure or timeout.");
    this.lifecycle.resume(record, recoveryInstruction, "resume");
    return { jobId, status: record.status, conversationId: record.conversationId };
  }

  public async cancelTask(jobId: string): Promise<Record<string, unknown>> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (record.status === "queued" && record.retryHandle) {
      this.cancelTimeout(record.retryHandle);
      record.retryHandle = undefined;
      record.nextRetryAt = undefined;
      record.forcedTerminalStatus = "canceled";
      record.status = "canceled";
      record.finishedAt = this.now().toISOString();
      return { jobId, status: record.status, canceled: true };
    }
    if (record.status === "awaiting_input") {
      await this.lifecycle.cancelAwaitingInput(record);
      return { jobId, status: record.status, canceled: true };
    }
    if (!record.child || record.status !== "running") return { jobId, status: record.status, canceled: false };
    record.cancellationRequested = true;
    record.forcedTerminalStatus = "canceled";
    await this.stopChildImpl(record.child);
    return { jobId, status: record.status, canceled: true };
  }

  public async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.retryHandle) {
        this.cancelTimeout(job.retryHandle);
        job.retryHandle = undefined;
        job.status = "orphaned";
        job.finishedAt = this.now().toISOString();
      }
    }
    await Promise.all([...this.jobs.values()].filter((job) => job.status === "running" && job.child).map(async (job) => {
      job.cancellationRequested = true;
      await this.stopChildImpl(job.child!);
    }));
    // Only directories this instance itself created via mkdtempImpl are ever removed.
    await Promise.all([...this.tempDirs].map(async (dir) => {
      try { await rm(dir, { recursive: true, force: true }); }
      catch { /* best-effort: a locked or already-missing directory must not block shutdown */ }
    }));
    this.tempDirs.clear();
  }

  private activeJobs(): TaskRecord[] {
    return [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "queued");
  }

  private commandRunner(adapter: HarnessAdapter): CommandRunner {
    return (args) => captureCommand(this.spawnImpl, this.stopChildImpl, adapter.executable, args, LIMITS.probeTimeoutMs);
  }

  private async runAdapterProbe(adapter: HarnessAdapter): Promise<HarnessProbe> {
    try { return await adapter.probe(this.commandRunner(adapter)); }
    catch (error) { return { installed: false, authStatus: "unavailable", models: [], modelSource: "unknown", error: redactPotentialSecrets(error instanceof Error ? error.message : String(error)) }; }
  }

  private classifyAndOpenCircuit(record: TaskRecord): number | undefined {
    const adapter = this.getAdapter(record.harness);
    const context = [record.stderrSummary, record.summary, record.outcomeDetail, ...record.events.map((event) => event.data)];
    record.errorCategory = (adapter.classifyFailure ? adapter.classifyFailure(context) : defaultClassifyFailure(context)) ?? "upstream_error";
    const nowMs = this.now().getTime();
    const retryAfterMs = adapter.retryAfterMs ? adapter.retryAfterMs(context, nowMs) : defaultRetryAfterMs(context, nowMs);
    if (record.errorCategory === "rate_limited" || record.errorCategory === "quota_exhausted") {
      this.openCircuit(record.harness, record.model, record.errorCategory, retryAfterMs);
      const breaker = this.breakers.get(this.breakerKey(record.harness, record.model));
      if (breaker) record.blockedUntil = breaker.blockedUntil;
    }
    return retryAfterMs;
  }

  private breakerKey(harness: string, model: string | undefined): string {
    return `${harness}:${model ?? "*"}`;
  }

  private openCircuit(harness: string, model: string | undefined, category: "rate_limited" | "quota_exhausted", retryAfterMs?: number): void {
    const now = this.now();
    const delay = retryAfterMs === undefined ? LIMITS.circuitBreakerMs : Math.max(retryAfterMs, 1_000);
    const key = this.breakerKey(harness, model);
    const candidate: CircuitBreaker = {
      key,
      harness,
      model: model ?? "*",
      category,
      openedAt: now.toISOString(),
      blockedUntil: new Date(now.getTime() + delay).toISOString(),
    };
    const existing = this.breakers.get(key);
    if (!existing || Date.parse(existing.blockedUntil) < Date.parse(candidate.blockedUntil)) this.breakers.set(key, candidate);
  }

  private expireBreakers(): void {
    const now = this.now().getTime();
    for (const [key, breaker] of this.breakers) if (Date.parse(breaker.blockedUntil) <= now) this.breakers.delete(key);
  }

  private assertModelAvailable(harness: string, model: string | undefined): void {
    this.expireBreakers();
    const breaker = this.breakers.get(this.breakerKey(harness, model));
    if (breaker) throw new Error(`Model ${breaker.model} on ${harness} is temporarily blocked after ${breaker.category} until ${breaker.blockedUntil}. Choose a later time; this bridge will not switch models or accounts automatically.`);
  }
}
