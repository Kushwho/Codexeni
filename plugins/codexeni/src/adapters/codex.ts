import { existsSync } from "node:fs";
import { join } from "node:path";

import { defaultClassifyFailure } from "../core/failure.js";
import type { ErrorCategory, HarnessSettings, WorkerResult } from "../core/types.js";
import { normalizeUsage } from "../core/usage.js";
import { isRecord } from "../core/value.js";
import type { CommandRunner, HarnessAdapter, HarnessProbe, Interpretation, SpawnSpec, TaskLaunch } from "./adapter.js";

export const CODEX_DEFAULTS = {
  executable: "codex",
} as const;

/** Codex accepts these current general-purpose model IDs through `--model`, but cannot list account entitlements. */
export const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/** The result Codex returns through `--output-schema` so the bridge can continue an interrupted task. */
// OpenAI's strict structured-output mode (Codex's --output-schema) requires every
// property to be listed in `required`; a genuinely optional field is expressed by
// allowing null instead of by omitting it. parseWorkerResult() below already treats
// a null field the same as an absent one, so nothing is lost by this shape.
export const CODEX_WORKER_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "question", "options", "recommendedOption", "category"],
  properties: {
    status: { type: "string", enum: ["completed", "input_required"] },
    summary: { type: "string", minLength: 1, maxLength: 8_000 },
    question: { type: ["string", "null"], minLength: 1, maxLength: 8_000 },
    options: { type: ["array", "null"], maxItems: 10, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    recommendedOption: { type: ["string", "null"], maxLength: 2_000 },
    category: { type: ["string", "null"], maxLength: 200 },
  },
} as const;

function parseWorkerResult(value: unknown): WorkerResult | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return undefined; }
  }
  if (!isRecord(candidate) || (candidate.status !== "completed" && candidate.status !== "input_required")) return undefined;
  const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
  const question = typeof candidate.question === "string" ? candidate.question : undefined;
  if (!summary || (candidate.status === "input_required" && !question)) return undefined;
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

function errorMessage(event: Record<string, unknown>): string | undefined {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  if (typeof event.error === "string") return event.error;
  return undefined;
}

/** Codex CLI (`codex exec`) runs one headless task and writes structured JSON Lines to stdout. */
export class CodexAdapter implements HarnessAdapter {
  public readonly id = "codex";
  public readonly displayName = "Codex CLI";
  public readonly executable: string;
  public readonly defaultModel?: string;
  public readonly supportsContinuation = true;
  public readonly outputSchema: Record<string, unknown> = CODEX_WORKER_RESULT_SCHEMA;

  /** Prepended when a Windows npm installation is reached through its JS entry. */
  private readonly entryArgs: readonly string[];

  public constructor(settings: HarnessSettings = {}) {
    const configured = settings.executable?.trim();
    if (configured && /\.(m|c)?js$/i.test(configured)) {
      this.executable = process.execPath;
      this.entryArgs = [configured];
    } else if (configured) {
      this.executable = configured;
      this.entryArgs = [];
    } else if (process.platform === "win32") {
      const npmEntry = process.env.APPDATA
        ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
        : undefined;
      if (npmEntry && existsSync(npmEntry)) {
        this.executable = process.execPath;
        this.entryArgs = [npmEntry];
      } else {
        this.executable = CODEX_DEFAULTS.executable;
        this.entryArgs = [];
      }
    } else {
      this.executable = CODEX_DEFAULTS.executable;
      this.entryArgs = [];
    }
    this.defaultModel = settings.defaultModel?.trim() || undefined;
  }

  public async probe(run: CommandRunner): Promise<HarnessProbe> {
    const version = await run([...this.entryArgs, "--version"]);
    const login = version.ok ? await run([...this.entryArgs, "login", "status"]) : undefined;
    return {
      installed: version.ok,
      version: version.ok ? version.stdout.trim() : undefined,
      authStatus: !version.ok ? "unavailable" : login?.ok ? "authenticated" : "unauthenticated",
      // Codex has no command to enumerate account-enabled models, so advertise the
      // maintained CLI-compatible IDs while leaving final entitlement validation to Codex.
      models: [...CODEX_MODELS],
      modelSource: "static",
      error: !version.ok ? version.error : login?.ok ? undefined : "Codex is installed but not authenticated.",
    };
  }

  public command(input: TaskLaunch): SpawnSpec {
    const args = [...this.entryArgs, "exec"];
    if (input.conversationId) args.push("resume", input.conversationId);
    args.push("--json");
    if (input.model) args.push("--model", input.model);
    // Codex has no dedicated --effort flag; model_reasoning_effort is the config key its
    // own config.toml uses for this, so -c overrides it per invocation instead.
    args.push("-c", `model_reasoning_effort=${input.effort}`);
    if (input.outputSchemaPath) args.push("--output-schema", input.outputSchemaPath);

    if (input.taskMode === "coding" && input.permissionMode === "full") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (!input.conversationId) {
      args.push("--sandbox", input.taskMode === "read_only" ? "read-only" : "workspace-write");
    }

    // `-` keeps long prompts and clarification answers out of argv on every platform.
    args.push("-");
    return { command: this.executable, args, cwd: input.workspace, stdin: input.prompt };
  }

  public interpret(event: Record<string, unknown>): Interpretation {
    const interpretation: Interpretation = {};
    if (event.type === "thread.started" && typeof event.thread_id === "string") interpretation.sessionId = event.thread_id;

    const item = isRecord(event.item) ? event.item : undefined;
    if (item?.type === "command_execution" && typeof item.id === "string") {
      if (event.type === "item.started") {
        interpretation.toolCalls = [{ name: "command_execution", phase: "started", id: item.id }];
      } else if (event.type === "item.completed") {
        interpretation.toolCalls = [{ name: "command_execution", phase: "completed", ok: item.status !== "failed" && (item.exit_code === undefined || item.exit_code === 0), id: item.id }];
      }
    }
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      const result = parseWorkerResult(item.text);
      if (result) {
        interpretation.workerResult = result;
        interpretation.summary = result.summary;
      } else {
        interpretation.summary = item.text;
      }
    }
    if (event.type === "turn.completed") {
      const usage = normalizeUsage(event.usage);
      if (usage) interpretation.usage = usage;
      interpretation.outcome = "succeeded";
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = errorMessage(event) ?? "Codex returned an error.";
      interpretation.outcome = "failed";
      interpretation.detail = message;
      interpretation.failureMessage = message;
      interpretation.failureSource = "harness";
    }
    return interpretation;
  }

  public classifyFailure(context: unknown): ErrorCategory | undefined {
    return defaultClassifyFailure(context);
  }
}
