/**
 * The harness-neutral vocabulary for observing a delegation: tools called, duration, cost.
 * Field names map onto OpenTelemetry GenAI conventions (`gen_ai.usage.*`, `execute_tool`) so an OTel exporter can later be one more sink, not a rewrite.
 */
import type { ErrorCategory, JobStatus, Outcome, TaskMode, Usage } from "./types.js";

/** One tool invocation observed in a worker's output stream. */
export interface ToolCallObservation {
  name: string;
  phase: "started" | "completed";
  /** Whether the call succeeded. Only meaningful when phase is "completed". */
  ok?: boolean;
  /** Correlates a "started" with its "completed" when the harness supplies an id. */
  id?: string;
}

/** Tool activity for one job, rolled up. */
export interface ToolCallStats {
  /** Distinct invocations, counted once each even when start and end both arrive. */
  total: number;
  failed: number;
  byName: Record<string, number>;
}

export function emptyToolCallStats(): ToolCallStats {
  return { total: 0, failed: 0, byName: {} };
}

/**
 * The record of one finished delegation, what a `MetricsSink` receives and the NDJSON sink
 * writes — must stay JSON-serializable: no class instances, no `undefined`-only semantics a round trip would lose.
 */
export interface TaskMetrics {
  /** Bump when a field changes meaning, so a reader can reject rows it predates. */
  schemaVersion: 1;
  jobId: string;
  harness: string;
  model?: string;
  taskMode: TaskMode;
  status: JobStatus;
  outcome?: Outcome;
  errorCategory?: ErrorCategory;
  /** The canonical workspace. External tooling uses this to attribute a job to a task. */
  workspace: string;
  usage: Usage;
  toolCalls: ToolCallStats;
  /** Turn count when the harness reports one. */
  turns?: number;
  retryCount: number;
  /** Time spent waiting for a concurrency slot. */
  queuedMs: number;
  /** Time the child process was actually running. */
  runningMs: number;
  /**
   * What `delegate_status` has always reported: elapsed time from `startedAt`,
   * falling back to `createdAt` for a job that never started. For a job that did
   * start, this therefore excludes queue time and equals `runningMs`. The
   * creation-to-finish figure is `queuedMs + runningMs`.
   *
   * Kept deliberately, rather than redefined, because callers already read this
   * field off `delegate_status` and changing what it means would break them
   * silently. Prefer the two-part figures for anything new.
   */
  durationMs: number;
  fileChangeCounts: { created: number; modified: number; deleted: number };
  /** How many stream events the runtime parsed, before the 200-event ring buffer trimmed them. */
  eventCount: number;
  createdAt: string;
  finishedAt?: string;
}

/** Cumulative totals for one harness+model pair, as reported by `delegate_discover`. */
export interface UsageRollup {
  harness: string;
  model?: string;
  jobs: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  costUsd: number;
  /** True when at least one job in this rollup contributed no cost figure at all. */
  costIncomplete: boolean;
  toolCalls: number;
  durationMs: number;
}
