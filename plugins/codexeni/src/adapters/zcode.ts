import { existsSync } from "node:fs";
import { join } from "node:path";

import { defaultClassifyFailure } from "../core/failure.js";
import { redactPotentialSecrets } from "../core/redaction.js";
import type { ErrorCategory, HarnessSettings } from "../core/types.js";
import { normalizeUsage } from "../core/usage.js";
import { isRecord } from "../core/value.js";
import type { CommandRunner, HarnessAdapter, HarnessProbe, Interpretation, SpawnSpec, TaskLaunch } from "./adapter.js";

export const ZCODE_DEFAULTS = {
  executable: "zcode",
  model: "glm-5.3-flash",
} as const;

/** `zcode` has no command that lists models, so this list is static. */
export const ZCODE_MODELS = ["glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo"];

/** Plan mode already denies workspace mutations; this denylist is belt and braces. */
const MUTATING_TOOLS = "Edit,Write,SendMessage";

/** ZCode provider-error wordings the shared text matcher misses, mapped onto the bridge's categories. */
const ZCODE_ERROR_CATEGORY: ReadonlyArray<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /insufficient balance|no resource package/i, category: "quota_exhausted" },
  { pattern: /unauthorized|invalid api key/i, category: "authentication" },
  { pattern: /captcha verify failed/i, category: "upstream_error" },
];

/**
 * ZCode (`zcode`) run headlessly with `--json --prompt`. Its stdout is one JSON
 * envelope rather than line-delimited events, so the result is read through
 * `interpretBuffer` instead of `interpret`.
 */
export class ZcodeAdapter implements HarnessAdapter {
  public readonly id = "zcode";
  public readonly displayName = "ZCode";
  /** The command the bridge spawns; `node` when ZCode is reached through its JS entry. */
  public readonly executable: string;
  public readonly defaultModel: string;
  public readonly supportsContinuation = true;

  /** Prepended to every invocation; non-empty only when ZCode runs through its JS entry. */
  private readonly entryArgs: readonly string[];

  public constructor(settings: HarnessSettings = {}) {
    const configured = settings.executable?.trim();
    if (configured && /\.(m|c)?js$/i.test(configured)) {
      // A JS entry cannot be spawned directly on Windows; run it through the current Node.
      this.executable = process.execPath;
      this.entryArgs = [configured];
    } else if (configured) {
      this.executable = configured;
      this.entryArgs = [];
    } else if (process.platform === "win32") {
      // `zcode` on PATH is an npm .cmd shim, which spawn without a shell cannot execute;
      // fall back to the well-known npm-global JS entry when it exists.
      const npmEntry = process.env.APPDATA
        ? join(process.env.APPDATA, "npm", "node_modules", "zcode-app-cli", "bin", "zcode.js")
        : undefined;
      if (npmEntry && existsSync(npmEntry)) {
        this.executable = process.execPath;
        this.entryArgs = [npmEntry];
      } else {
        this.executable = ZCODE_DEFAULTS.executable;
        this.entryArgs = [];
      }
    } else {
      this.executable = ZCODE_DEFAULTS.executable;
      this.entryArgs = [];
    }
    this.defaultModel = settings.defaultModel ?? ZCODE_DEFAULTS.model;
  }

  public async probe(run: CommandRunner): Promise<HarnessProbe> {
    const version = await run([...this.entryArgs, "--version"]);
    // ZCode exposes no non-interactive auth check: model access lives in its own
    // config.json, so an installed CLI reports unknown rather than guessing.
    return {
      installed: version.ok,
      version: version.ok ? version.stdout.trim() : undefined,
      authStatus: version.ok ? "unknown" : "unavailable",
      models: version.ok ? [...ZCODE_MODELS] : [],
      modelSource: "static",
      error: version.ok ? undefined : version.error,
    };
  }

  /**
   * The model actually used is whatever ZCode's own config.json selects (model.main);
   * its CLI takes no model flag, so a caller-requested model can only be reported, not applied.
   */
  public resolveSelection(model: string | undefined): { model?: string; warning?: string } {
    if (!model) return {};
    return { model, warning: `ZCode runs the model configured in its own config (model.main); the requested model "${model}" was not applied.` };
  }

  public command(input: TaskLaunch): SpawnSpec {
    const args: string[] = [...this.entryArgs, "--json", "--mode"];
    if (input.taskMode === "read_only") {
      args.push("plan", "--disallowed-tools", MUTATING_TOOLS);
    } else {
      // Headless prompts already default to yolo; restricted keeps per-call approval for
      // anything riskier than an edit.
      args.push(input.permissionMode === "full" ? "yolo" : "edit");
    }
    if (input.conversationId) args.push("--resume", input.conversationId);
    // The prompt travels over argv: ZCode reads it from the option value only.
    args.push("--prompt", input.prompt);
    return { command: this.executable, args, cwd: input.workspace };
  }

  public interpret(_event: Record<string, unknown>): Interpretation {
    // ZCode emits no line-delimited events; the result is read from the whole stdout via interpretBuffer.
    return {};
  }

  public interpretBuffer(stdout: string): Interpretation {
    const interpretation: Interpretation = {};
    const trimmed = stdout.trim();
    if (!trimmed) return interpretation;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return interpretation;
    }
    if (!isRecord(parsed)) return interpretation;
    if (typeof parsed.sessionId === "string") interpretation.sessionId = parsed.sessionId;
    if (typeof parsed.response === "string" && parsed.response.trim()) {
      interpretation.summary = redactPotentialSecrets(parsed.response);
      interpretation.outcome = "succeeded";
    }
    const normalized = normalizeUsage(parsed.usage);
    if (normalized) interpretation.usage = normalized;
    const projection = isRecord(parsed.projection) ? parsed.projection : undefined;
    if (projection && typeof projection.turnCount === "number" && Number.isFinite(projection.turnCount)) {
      interpretation.turns = projection.turnCount;
    }
    return interpretation;
  }

  public classifyFailure(context: unknown): ErrorCategory | undefined {
    for (const item of Array.isArray(context) ? context : [context]) {
      if (typeof item !== "string") continue;
      for (const { pattern, category } of ZCODE_ERROR_CATEGORY) {
        if (pattern.test(item)) return category;
      }
    }
    return defaultClassifyFailure(context);
  }
}
