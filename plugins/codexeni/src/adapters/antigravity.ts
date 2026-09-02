import type { ToolCallObservation } from "../core/metrics.js";
import type { Effort, HarnessSettings, Outcome, WorkerResult } from "../core/types.js";
import { normalizeUsage } from "../core/usage.js";
import { isRecord } from "../core/value.js";
import type { CommandRunner, HarnessAdapter, HarnessProbe, Interpretation, SpawnSpec, TaskLaunch } from "./adapter.js";

export const ANTIGRAVITY_DEFAULTS = {
  executable: "agy",
  model: "gemini-3.7-flash-high",
} as const;

const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]*-[a-z0-9._-]+$/i;

/**
 * Model slugs carry their own reasoning tier ("gemini-3.7-flash-high"); `agy` rejects
 * `--effort` when it contradicts or has no tier to match, so effort is expressed through the slug instead of the flag.
 */
const EFFORT_TIER = /-(low|medium|high)$/;

/**
 * Read `agy models` output: each line is "<slug> <display name>"; a status line
 * like "Fetching available models..." has no slug-shaped first token and is skipped. A JSON array or object is also accepted.
 */
export function parseModelList(output: string): string[] {
  const slugs = new Set<string>();
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const collect = (value: unknown): void => {
        if (typeof value === "string") { if (MODEL_SLUG.test(value)) slugs.add(value.toLowerCase()); return; }
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (isRecord(value)) {
          for (const key of ["id", "slug", "name", "model"]) if (typeof value[key] === "string") collect(value[key]);
          for (const key of ["models", "data", "items"]) if (Array.isArray(value[key])) collect(value[key]);
        }
      };
      collect(JSON.parse(trimmed));
      return [...slugs].sort();
    } catch {
      // Not JSON after all; fall through to line parsing.
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0];
    if (first && MODEL_SLUG.test(first)) slugs.add(first.toLowerCase());
  }
  return [...slugs].sort();
}

export function parseAuthenticationStatus(output: string): "authenticated" | "unauthenticated" | "unknown" {
  const normalized = output.toLowerCase();
  if (/not[ _-]?authenticated|unauthenticated|logged[ _-]?out/.test(normalized)) return "unauthenticated";
  if (/authenticated|logged[ _-]?in/.test(normalized)) return "authenticated";
  return "unknown";
}

const TERMINAL_STATUS: Record<string, Outcome> = {
  SUCCESS: "succeeded",
  SUCCEEDED: "succeeded",
  CANCELED: "canceled",
  CANCELLED: "canceled",
  ERROR: "failed",
  FAILED: "failed",
  FAILURE: "failed",
  TIMEOUT: "failed",
  TIMED_OUT: "failed",
  REJECTED: "failed",
  ABORTED: "failed",
};

/** The only worker result shape the bridge asks Antigravity to return. */
export const ANTIGRAVITY_WORKER_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["completed", "input_required"] },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
    question: { type: "string", minLength: 1, maxLength: 8_000 },
    options: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    recommendedOption: { type: "string", maxLength: 2_000 },
    category: { type: "string", maxLength: 200 },
  },
  allOf: [{ if: { properties: { status: { const: "input_required" } } }, then: { required: ["question"] } }],
} as const;

function parseWorkerResult(value: unknown): WorkerResult | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return undefined; }
  }
  if (!isRecord(candidate) || (candidate.status !== "completed" && candidate.status !== "input_required")) return undefined;
  const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
  const question = typeof candidate.question === "string" ? candidate.question : undefined;
  if (candidate.status === "input_required" && !question) return undefined;
  const options = Array.isArray(candidate.options)
    ? candidate.options.filter((option): option is string => typeof option === "string").slice(0, 10)
    : undefined;
  return {
    status: candidate.status,
    summary,
    question,
    options: options?.length ? options : undefined,
    recommendedOption: typeof candidate.recommendedOption === "string" ? candidate.recommendedOption : undefined,
    category: typeof candidate.category === "string" ? candidate.category : undefined,
  };
}

/**
 * Reads one tool step out of an `agy` stream event: labelled `event` (not `type`), nested
 * under `step_update`. Each tool emits ACTIVE then DONE/ERROR sharing one `step_index`, read only at the top level so each pair counts once.
 */
function stepUpdateObservation(event: Record<string, unknown>): ToolCallObservation | undefined {
  if (event.event !== "step_update" && event.type !== "step_update") return undefined;
  const step = isRecord(event.step_update) ? event.step_update : undefined;
  if (!step || step.step_type !== "tool") return undefined;
  const toolInfo = isRecord(step.tool_info) ? step.tool_info : undefined;
  const name = (typeof toolInfo?.name === "string" ? toolInfo.name : undefined)
    ?? (typeof step.tool_name === "string" ? step.tool_name : undefined);
  if (!name) return undefined;
  // Scope the index by conversation: a resumed job restarts step numbering, and
  // an unscoped index would merge two different calls into one.
  const conversation = typeof step.conversation_id === "string" ? step.conversation_id : "";
  const id = typeof step.step_index === "number" ? `${conversation}:${step.step_index}` : undefined;
  const state = typeof step.state === "string" ? step.state.toUpperCase() : "";
  if (state === "ACTIVE") return { name, phase: "started", id };
  return { name, phase: "completed", ok: state !== "ERROR" && toolInfo?.error === undefined, id };
}

/** Antigravity CLI (`agy`) run headlessly with `--output-format stream-json`. */
export class AntigravityAdapter implements HarnessAdapter {
  public readonly id = "antigravity";
  public readonly displayName = "Antigravity CLI";
  public readonly executable: string;
  public readonly defaultModel: string;
  public readonly supportsContinuation = true;

  public constructor(settings: HarnessSettings = {}) {
    this.executable = settings.executable ?? ANTIGRAVITY_DEFAULTS.executable;
    this.defaultModel = settings.defaultModel ?? ANTIGRAVITY_DEFAULTS.model;
  }

  public async probe(run: CommandRunner): Promise<HarnessProbe> {
    const version = await run(["--version"]);
    // `agy models` is the only non-secret signal of a working login: it fails when logged out.
    const models = await run(["models"]);
    let authStatus: HarnessProbe["authStatus"];
    if (models.ok) authStatus = "authenticated";
    else if (!version.ok) authStatus = "unavailable";
    else if (parseAuthenticationStatus(models.error ?? models.stderr) === "unauthenticated") authStatus = "unauthenticated";
    else authStatus = "unknown";
    return {
      installed: version.ok,
      version: version.ok ? version.stdout.trim() : undefined,
      authStatus,
      models: models.ok ? parseModelList(models.stdout) : [],
      modelSource: "listed",
      error: models.ok ? undefined : models.error,
    };
  }

  /**
   * With no model pinned, the requested effort picks the tier of the default model.
   * With one pinned, the caller's slug wins and an unhonourable effort is reported rather than applied.
   */
  public resolveSelection(model: string | undefined, effort?: Effort): { model: string; warning?: string } {
    if (!model) return { model: this.defaultModel.replace(EFFORT_TIER, `-${effort ?? "high"}`) };
    const tier = EFFORT_TIER.exec(model)?.[1];
    if (effort && tier && tier !== effort) {
      return { model, warning: `Model ${model} runs at its own "${tier}" reasoning tier on ${this.displayName}; the requested effort "${effort}" was not applied.` };
    }
    if (effort && !tier) {
      return { model, warning: `Model ${model} does not accept a reasoning effort on ${this.displayName}; the requested effort "${effort}" was not applied.` };
    }
    return { model };
  }

  public command(input: TaskLaunch): SpawnSpec {
    const args = [
      "--model", input.model ?? this.defaultModel,
      "--output-format", "stream-json",
      "--sandbox",
      "--mode", input.taskMode === "read_only" ? "plan" : "accept-edits",
      "--json-schema", JSON.stringify(ANTIGRAVITY_WORKER_RESULT_SCHEMA),
    ];
    if (input.permissionMode === "full") args.push("--dangerously-skip-permissions");
    if (input.conversationId) args.push("--conversation", input.conversationId);
    args.push("--prompt", input.prompt);
    return { command: this.executable, args, cwd: input.workspace };
  }

  public interpret(event: Record<string, unknown>): Interpretation {
    const interpretation: Interpretation = {};
    const stepObservation = stepUpdateObservation(event);
    if (stepObservation) interpretation.toolCalls = [stepObservation];
    // `step_update` is included because agy reports per-step usage there, with
    // the reasoning and cache-read counts the terminal envelope omits. Usage is
    // overwrite-semantics and the terminal event arrives last, so the run-level
    // aggregate still wins where the harness provides one.
    const candidates = [event, event.result, event.data, event.message, event.step_update].filter(isRecord);
    for (const candidate of candidates) {
      const sessionId = candidate.conversation_id ?? candidate.conversationId;
      if (typeof sessionId === "string") interpretation.sessionId = sessionId;
      const usage = normalizeUsage(candidate.usage);
      if (usage) interpretation.usage = usage;
      if (typeof candidate.num_turns === "number" && Number.isFinite(candidate.num_turns)) interpretation.turns = candidate.num_turns;
      const text = candidate.text ?? candidate.response ?? candidate.message ?? candidate.content;
      if (typeof text === "string") interpretation.summary = text;
      const structured = parseWorkerResult(candidate.structured_output ?? candidate.structuredOutput);
      if (structured) {
        interpretation.workerResult = structured;
        if (structured.summary) interpretation.summary = structured.summary;
        if (structured.status === "completed") interpretation.outcome = "succeeded";
      }
      if (typeof candidate.status === "string") {
        const status = candidate.status.toUpperCase();
        const outcome = TERMINAL_STATUS[status];
        if (outcome) {
          interpretation.outcome = outcome;
          interpretation.detail = outcome === "failed" ? `${this.displayName} returned terminal status ${status}.` : undefined;
        }
      }
    }
    return interpretation;
  }
}
