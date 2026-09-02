/**
 * The contract between the harness-neutral runtime and one coding harness. The
 * runtime owns lifecycle, concurrency, workspace, and retries; an adapter only knows its own CLI's probe, launch, and output shape.
 */
import type { ToolCallObservation } from "../core/metrics.js";
import type { Effort, ErrorCategory, FailureSource, Outcome, PermissionMode, TaskMode, Usage, WorkerResult } from "../core/types.js";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs the adapter's executable with the given arguments; provided by the runtime. */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export interface HarnessProbe {
  installed: boolean;
  version?: string;
  authStatus: "authenticated" | "unauthenticated" | "unknown" | "unavailable";
  models: string[];
  /** "listed" when the CLI enumerated models; "static" for a built-in list; "unknown" when the harness cannot say. */
  modelSource: "listed" | "static" | "unknown";
  error?: string;
}

export interface TaskLaunch {
  /** The finished worker prompt, preamble included. */
  prompt: string;
  workspace: string;
  /** Maximum wall-clock duration for this worker invocation. */
  timeoutSeconds: number;
  model?: string;
  effort: Effort;
  permissionMode: PermissionMode;
  taskMode: TaskMode;
  /** Continue this harness conversation rather than starting a new one. */
  conversationId?: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child's stdin and then closed; use for prompts too long for argv. */
  stdin?: string;
}

/** Normalized fields read from one parsed output line. Everything is optional; later lines overwrite earlier ones. */
export interface Interpretation {
  sessionId?: string;
  summary?: string;
  usage?: Usage;
  outcome?: Outcome;
  /** Human-readable reason when the outcome is not "succeeded". */
  detail?: string;
  /** A concise harness-provided diagnostic for a failed terminal event. */
  failureMessage?: string;
  failureSource?: FailureSource;
  /** A validated structured worker result, when the harness emits one. */
  workerResult?: WorkerResult;
  /**
   * Tool activity seen on this line — unlike every other field here, these are
   * APPENDED across lines rather than overwritten, since a worker streams one event per tool call.
   */
  toolCalls?: ToolCallObservation[];
  /** Turn count, when the harness reports one. Overwritten like the other fields. */
  turns?: number;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly executable: string;
  /** Model used when the caller does not choose one; undefined lets the harness pick its own. */
  readonly defaultModel?: string;
  /** Whether this harness can resume an exited conversation after an input request. */
  readonly supportsContinuation?: boolean;
  /**
   * Reconcile the requested model and effort before launch: return the model to run,
   * plus a warning when the harness can't honour the requested effort. Harnesses that take effort as a plain flag can omit this.
   */
  resolveSelection?(model: string | undefined, effort?: Effort): { model?: string; warning?: string };
  probe(run: CommandRunner): Promise<HarnessProbe>;
  command(input: TaskLaunch): SpawnSpec;
  interpret(event: Record<string, unknown>): Interpretation;
  classifyFailure?(context: unknown): ErrorCategory | undefined;
  retryAfterMs?(context: unknown, nowMs: number): number | undefined;
}
