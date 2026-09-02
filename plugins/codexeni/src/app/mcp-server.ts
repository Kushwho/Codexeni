import { randomBytes } from "node:crypto";
import { createRequestStateCodec, inputRequired, inputResponse, McpServer, type RequestStateCodec } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LIMITS } from "../core/limits.js";
import { hashQuestion, NonceLedger, type SealedInputState } from "./input-state.js";
import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import type { InputRequest } from "../core/types.js";

/** What runtime.getPendingInput reports: the worker's question plus its place in the round budget. */
type PendingInput = InputRequest & { round: number; maxRounds: number };

/** Every tool answers with the same JSON payload as both readable text and structured content. */
function jsonResult(payload: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

/** Report a thrown runtime error as a tool error result; every tool surfaces failures the same way. */
function errorResult(error: unknown, prefix = ""): ReturnType<typeof jsonResult> {
  return jsonResult({ error: `${prefix}${error instanceof Error ? error.message : String(error)}` }, true);
}

/** Key of the single embedded elicitation request delegate_respond ever sends. */
const ELICIT_KEY = "humanAnswer";

/** Longest work-so-far context kept in a prompt; past this the question stops being the first thing read. */
const MAX_CONTEXT_CHARS = 240;

/** Workers often echo the question back as their summary, which would show it twice. */
function restatesQuestion(context: string, question: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedContext = normalize(context);
  const normalizedQuestion = normalize(question);
  return normalizedContext.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedContext);
}

/**
 * The client renders this as the prompt body, so lead with the question and list
 * choices inline — a long or repetitive message pushes the question out of view. Add context only when it says something new.
 */
function buildElicitMessage(pending: PendingInput): string {
  const lines = [pending.question];
  if (pending.options?.length) {
    lines.push(pending.options.map((option) => (option === pending.recommendedOption ? `${option} (recommended)` : option)).join(" · "));
  } else if (pending.recommendedOption) {
    lines.push(`Suggested: ${pending.recommendedOption}`);
  }
  const context = (pending.workSoFar ?? pending.summary)?.trim();
  if (context && !restatesQuestion(context, pending.question)) {
    lines.push(context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…` : context);
  }
  lines.push(`Round ${pending.round} of ${pending.maxRounds} · answering resumes the task`);
  return lines.join("\n\n");
}

/** Anything that looks like a credential prompt; refused rather than elicited. */
const SECRET_CATEGORY_PATTERN = /credential|secret|token|password|api[_ -]?key/i;

export interface McpServerDeps {
  codec?: RequestStateCodec<SealedInputState>;
  nonces?: NonceLedger;
}

export function createMcpServer(runtime: BridgeRuntime, deps: McpServerDeps = {}): McpServer {
  // requestState is signed per-process: one stdio process must serve every round of a flow it starts.
  const codec = deps.codec ?? createRequestStateCodec<SealedInputState>({
    key: randomBytes(32),
    ttlSeconds: LIMITS.inputRequestStateTtlSeconds,
    bind: (ctx) => ctx.mcpReq.method,
  });
  const nonces = deps.nonces ?? new NonceLedger(LIMITS.inputRequestStateTtlSeconds * 1_000);

  const server = new McpServer({ name: "codexeni", version: "0.1.0" }, { requestState: { verify: codec.verify } });

  const taskInput = {
    task: z.string().min(1).max(100_000).describe("The bounded task for the worker: objective, allowed paths, required checks, and stop condition."),
    workspace: z.string().min(1).describe("Absolute path of the orchestrator's current workspace; in zero-config mode this exact canonical directory is the task boundary."),
    harness: z.string().min(1).max(100).optional().describe("Harness id from delegate_discover (for example \"antigravity\" or \"claude-code\"). Defaults to the configured default harness."),
    model: z.string().min(1).max(200).optional().describe("Exact model slug as listed by delegate_discover. Defaults to the harness's default model."),
    effort: z.enum(["low", "medium", "high"]).optional(),
    taskMode: z.enum(["coding", "read_only"]).optional().describe("read_only forbids workspace changes and allows bounded automatic retries; coding never retries."),
    maxRetries: z.number().int().min(0).max(LIMITS.readOnlyMaxRetries).optional(),
    timeoutSeconds: z.number().int().positive().max(runtime.config.defaultTimeoutSeconds).optional(),
  };

  server.registerTool("delegate_discover", {
    description: "List the local coding harnesses this bridge can delegate to, with install state, login state, and available models, plus the bridge's own limits. Reuses recent checks unless refresh is true. Reads no credentials.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Force a fresh harness check instead of reusing the recent cached result."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ refresh }) => jsonResult({ ...(await runtime.discover({ refresh })), totals: runtime.getUsageTotals() }));

  server.registerTool("delegate_start", {
    description: "Start an asynchronous bounded task on a local coding harness and return a jobId. Then call delegate_status once with waitSeconds set close to timeoutSeconds — that call stays open until the job is done, the same way Claude Code's own Agent tool waits for a subagent, so waiting for a result costs one tool call, never a shell sleep. In full permission mode the worker auto-approves its own tool use; the workspace check selects the working directory but is not a sandbox. Review every change before treating the task as done.",
    inputSchema: taskInput,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await runtime.startTask(input)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("delegate_status", {
    description: "Get a delegated task's status, summary, token usage, changed files, warnings, error category, and recent output events. Pass waitSeconds (up to the bridge's maxStatusWaitSeconds limit) to block this call until the job leaves queued/running instead of returning immediately; call it again with waitSeconds if it is still running. Never try to pause between calls with a shell command — this call already waits, and Claude Code holds it open without costing extra turns.",
    inputSchema: {
      jobId: z.string().uuid(),
      eventLimit: z.number().int().min(1).max(LIMITS.maxEvents).optional(),
      waitSeconds: z.number().int().min(0).max(LIMITS.maxStatusWaitSeconds).optional().describe("Block until the job settles (or this many seconds elapse), instead of returning the current status immediately."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId, eventLimit, waitSeconds }, ctx) => {
    try {
      if (waitSeconds) await runtime.waitForSettled(jobId, waitSeconds * 1_000, ctx.mcpReq.signal);
      return jsonResult(runtime.getTask(jobId, eventLimit));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("delegate_cancel", {
    description: "Cancel a running delegated task and its child process tree.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    try { return jsonResult(await runtime.cancelTask(jobId)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("delegate_respond", {
    description: "Answer a delegated task that is waiting on a clarification (status \"awaiting_input\" from delegate_status). Use action \"answer\" when the orchestrator can settle the question itself — it is covered by the task description or the repository, stays inside the declared scope, and the choice is a reversible implementation detail — or to relay an answer a human already gave outside this tool; pass answer and optionally answeredBy (defaults to \"orchestrator\"). Use action \"elicit\" for product decisions, scope changes, destructive actions, or genuinely ambiguous intent: it asks the connected client to collect the answer directly from a human, and this call must be retried once that answer comes back. Never use either action to collect credentials or secrets; those are always configured out of band, never through this tool.",
    inputSchema: z.object({
      jobId: z.string().uuid(),
      action: z.enum(["answer", "elicit"]),
      answer: z.string().min(1).max(LIMITS.maxInputAnswerChars).optional(),
      answeredBy: z.enum(["orchestrator", "human"]).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ jobId, action, answer, answeredBy }, ctx) => {
    if (action === "answer") {
      if (!answer) return jsonResult({ error: "answer is required for action \"answer\"." }, true);
      try { return jsonResult(await runtime.respondTask(jobId, answer, answeredBy ?? "orchestrator")); } catch (error) { return errorResult(error); }
    }

    // action === "elicit": no verified state means this is the opening round; a verified state means
    // the client is retrying with the human's answer attached.
    const state = ctx.mcpReq.requestState<SealedInputState>();
    if (!state) {
      let pending: PendingInput;
      try { pending = runtime.getPendingInput(jobId); } catch (error) { return errorResult(error); }
      if (pending.category && SECRET_CATEGORY_PATTERN.test(pending.category)) {
        return jsonResult({ error: "This clarification looks like it is asking for a credential or secret. Configure it out of band — delegate_respond never collects credentials." }, true);
      }

      const sealed: SealedInputState = { jobId, round: pending.round, questionRevision: hashQuestion(pending.question), nonce: nonces.issue() };
      const requestState = await codec.mint(sealed, ctx);

      // Exactly one required field — a second optional one turns a one-tap choice into a form.
      // Each branch calls elicit() in full since the schema shapes don't unify through a ternary.
      const message = buildElicitMessage(pending);
      const options = pending.options ?? [];
      const elicitRequest = options.length > 0
        ? inputRequired.elicit({ message, requestedSchema: { type: "object", properties: { answer: { type: "string", enum: options, title: "Answer" } }, required: ["answer"] } })
        : inputRequired.elicit({ message, requestedSchema: { type: "object", properties: { answer: { type: "string", maxLength: LIMITS.maxInputAnswerChars, title: "Answer" } }, required: ["answer"] } });

      return inputRequired({ inputRequests: { [ELICIT_KEY]: elicitRequest }, requestState });
    }

    if (state.jobId !== jobId) return jsonResult({ error: "requestState does not match jobId." }, true);
    if (!nonces.consume(state.nonce)) return jsonResult({ error: "This input request was already answered or has expired." }, true);

    let pending: PendingInput;
    try { pending = runtime.getPendingInput(jobId); } catch (error) { return errorResult(error, "This job is no longer waiting for input: "); }
    if (pending.round !== state.round || hashQuestion(pending.question) !== state.questionRevision) {
      return jsonResult({ error: "The clarification question changed since this request was issued. Call delegate_respond with action \"elicit\" again to get a fresh one." }, true);
    }

    const view = inputResponse(ctx.mcpReq.inputResponses, ELICIT_KEY);
    if (view.kind === "missing" || ctx.mcpReq.droppedInputResponseKeys?.includes(ELICIT_KEY)) {
      return jsonResult({ error: "The elicitation response was missing or malformed. Call delegate_respond with action \"elicit\" again to re-issue the request." }, true);
    }
    if (view.kind !== "elicit") return jsonResult({ error: `Unexpected response kind "${view.kind}" for an elicitation request.` }, true);

    if (view.action === "decline" || view.action === "cancel") {
      return jsonResult({ jobId, status: "awaiting_input", declined: true, action: view.action, note: "The job is still waiting for an answer. Call delegate_respond again with action \"answer\", retry \"elicit\", or cancel the job with delegate_cancel." });
    }

    const answerText = typeof view.content?.answer === "string" ? view.content.answer.trim() : "";
    if (!answerText) return jsonResult({ error: "The elicitation response did not contain an answer." }, true);

    try { return jsonResult(await runtime.respondTask(jobId, answerText, "human")); } catch (error) { return errorResult(error); }
  });

  process.once("SIGINT", () => { void runtime.shutdown(); });
  process.once("SIGTERM", () => { void runtime.shutdown(); });
  return server;
}
