import { defaultClassifyFailure } from "../core/failure.js";
import type { ToolCallObservation } from "../core/metrics.js";
import type { ErrorCategory, HarnessSettings } from "../core/types.js";
import { normalizeUsage } from "../core/usage.js";
import { isRecord } from "../core/value.js";
import type { CommandRunner, HarnessAdapter, HarnessProbe, Interpretation, SpawnSpec, TaskLaunch } from "./adapter.js";

export const CLAUDE_CODE_DEFAULTS = {
  executable: "claude",
  model: "sonnet",
} as const;

/** Aliases `claude --model` accepts. The CLI has no command that lists models, so this list is static. */
export const CLAUDE_CODE_MODELS = ["fable", "opus", "sonnet", "haiku"];

/** Removed outright for read-only tasks so the worker cannot change the workspace. */
const EDIT_TOOLS = "Edit,Write,MultiEdit,NotebookEdit";

/** `system/api_retry` error names mapped onto the bridge's failure categories. */
const API_ERROR_CATEGORY: Record<string, ErrorCategory> = {
  rate_limit: "rate_limited",
  billing_error: "quota_exhausted",
  authentication_failed: "authentication",
  oauth_org_not_allowed: "authentication",
  overloaded: "upstream_error",
  server_error: "upstream_error",
};

/** Read `claude auth status --json`. Only the login flag is kept; the account details in that output are never copied. */
export function parseLoginStatus(output: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) && typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

function lastText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let text: string | undefined;
  for (const block of content) if (isRecord(block) && block.type === "text" && typeof block.text === "string") text = block.text;
  return text;
}

/** `tool_use` blocks in an assistant message: one "started" observation per call, keyed by the id the matching `tool_result` will echo back. */
function toolUseObservations(content: unknown): ToolCallObservation[] {
  if (!Array.isArray(content)) return [];
  const observations: ToolCallObservation[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
      observations.push({ name: block.name, phase: "started", id: typeof block.id === "string" ? block.id : undefined });
    }
  }
  return observations;
}

/**
 * `tool_result` blocks in a user message. Claude Code never repeats the tool name at
 * completion, only the id it started with, so name is left empty here and the runtime fills it in by correlating on `id`.
 */
function toolResultObservations(content: unknown): ToolCallObservation[] {
  if (!Array.isArray(content)) return [];
  const observations: ToolCallObservation[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_result") {
      observations.push({
        name: "",
        phase: "completed",
        ok: block.is_error !== true,
        id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
      });
    }
  }
  return observations;
}

/** Claude Code (`claude`) run headlessly with `-p --output-format stream-json`. */
export class ClaudeCodeAdapter implements HarnessAdapter {
  public readonly id = "claude-code";
  public readonly displayName = "Claude Code";
  public readonly executable: string;
  public readonly defaultModel: string;

  public constructor(settings: HarnessSettings = {}) {
    this.executable = settings.executable ?? CLAUDE_CODE_DEFAULTS.executable;
    this.defaultModel = settings.defaultModel ?? CLAUDE_CODE_DEFAULTS.model;
  }

  public async probe(run: CommandRunner): Promise<HarnessProbe> {
    const version = await run(["--version"]);
    const auth = version.ok ? await run(["auth", "status", "--json"]) : undefined;
    const loggedIn = auth ? parseLoginStatus(auth.stdout) : undefined;
    let authStatus: HarnessProbe["authStatus"];
    if (!version.ok) authStatus = "unavailable";
    else if (loggedIn === true) authStatus = "authenticated";
    else if (loggedIn === false) authStatus = "unauthenticated";
    else authStatus = "unknown";
    let error: string | undefined;
    if (!version.ok) error = version.error;
    else if (loggedIn === undefined) error = "Could not read login status from `claude auth status`.";
    return {
      installed: version.ok,
      version: version.ok ? version.stdout.trim() : undefined,
      authStatus,
      models: [...CLAUDE_CODE_MODELS],
      modelSource: "static",
      error,
    };
  }

  public command(input: TaskLaunch): SpawnSpec {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", input.model ?? this.defaultModel,
      "--effort", input.effort,
    ];
    if (input.taskMode === "read_only") {
      // Read-only means read-only in every permission mode: the edit tools are
      // removed and nothing outside Claude Code's read-only command set is approved.
      args.push("--permission-mode", "dontAsk", "--disallowedTools", EDIT_TOOLS);
    } else if (input.permissionMode === "full") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "acceptEdits");
    }
    // The prompt travels over stdin: no argv length limit and no quoting.
    return { command: this.executable, args, cwd: input.workspace, stdin: input.prompt };
  }

  public interpret(event: Record<string, unknown>): Interpretation {
    const interpretation: Interpretation = {};
    if (typeof event.session_id === "string") interpretation.sessionId = event.session_id;
    if (event.type === "assistant" && isRecord(event.message)) {
      const text = lastText(event.message.content);
      if (text) interpretation.summary = text;
      const started = toolUseObservations(event.message.content);
      if (started.length) interpretation.toolCalls = started;
    }
    if (event.type === "user" && isRecord(event.message)) {
      const completed = toolResultObservations(event.message.content);
      if (completed.length) interpretation.toolCalls = completed;
    }
    if (event.type === "result") {
      if (typeof event.result === "string") interpretation.summary = event.result;
      const usage = normalizeUsage({ ...(isRecord(event.usage) ? event.usage : {}), total_cost_usd: event.total_cost_usd });
      if (usage) interpretation.usage = usage;
      if (typeof event.num_turns === "number" && Number.isFinite(event.num_turns)) interpretation.turns = event.num_turns;
      if (event.is_error === true) {
        interpretation.outcome = "failed";
        interpretation.detail = `${this.displayName} ended with ${typeof event.subtype === "string" ? event.subtype : "an error"}.`;
      } else {
        interpretation.outcome = "succeeded";
      }
    }
    return interpretation;
  }

  /** Claude Code names the API error class in its retry events; use that before falling back to text matching. */
  public classifyFailure(context: unknown): ErrorCategory | undefined {
    for (const item of Array.isArray(context) ? context : [context]) {
      if (isRecord(item) && item.type === "system" && item.subtype === "api_retry" && typeof item.error === "string") {
        const category = API_ERROR_CATEGORY[item.error];
        if (category) return category;
      }
    }
    return defaultClassifyFailure(context);
  }
}
