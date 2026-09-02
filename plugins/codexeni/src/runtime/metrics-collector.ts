/**
 * Turns the raw signals a job produces into the `TaskMetrics` snapshot a `MetricsSink`
 * receives. Pure and synchronous — plain-counter bookkeeping, cheap to keep alive for a job's whole lifetime and to query mid-run (`compactRecord` does exactly that).
 */
import type { TaskMetrics, ToolCallObservation, ToolCallStats } from "../core/metrics.js";
import { emptyToolCallStats } from "../core/metrics.js";
import type { TaskRecord } from "../core/types.js";

/**
 * Accumulates one job's tool-call activity into a `ToolCallStats`. Correlation rule: a
 * "started" with an id always counts; a matching "completed" only updates `ok`; an unmatched "completed" (Antigravity's shape) counts on its own — so each real call counts once.
 */
export class TaskMetricsCollector {
  private readonly stats: ToolCallStats = emptyToolCallStats();
  /** Ids from a "started" observation still waiting on their "completed" half. */
  private readonly openIds = new Set<string>();
  private eventCount = 0;

  /** Fold one line's worth of tool-call observations into the running stats. */
  public addToolCalls(observations: readonly ToolCallObservation[] | undefined): void {
    if (!observations?.length) return;
    for (const observation of observations) this.addToolCall(observation);
  }

  private addToolCall(observation: ToolCallObservation): void {
    const { name, phase, ok, id } = observation;
    if (phase === "started") {
      this.stats.total += 1;
      if (name) this.stats.byName[name] = (this.stats.byName[name] ?? 0) + 1;
      if (id !== undefined) this.openIds.add(id);
      return;
    }
    if (id !== undefined && this.openIds.has(id)) {
      // The other half of a pair already counted at "started": update ok only.
      this.openIds.delete(id);
      if (ok === false) this.stats.failed += 1;
      return;
    }
    // No id, or an id nothing opened: a completion the collector only ever sees once.
    this.stats.total += 1;
    if (name) this.stats.byName[name] = (this.stats.byName[name] ?? 0) + 1;
    if (ok === false) this.stats.failed += 1;
  }

  /** Call once per stream event the runtime parses, regardless of ring-buffer trimming. */
  public recordEvent(): void {
    this.eventCount += 1;
  }

  /**
   * Snapshot this job's metrics against its current record state. Safe to call more than
   * once (mid-run for `delegate_status`, then again at finalize) since reading it mutates nothing.
   */
  public build(record: TaskRecord): TaskMetrics {
    const createdMs = new Date(record.createdAt).getTime();
    const startedMs = record.startedAt ? new Date(record.startedAt).getTime() : undefined;
    const finishedMs = record.finishedAt ? new Date(record.finishedAt).getTime() : Date.now();
    const effectiveStartMs = startedMs ?? createdMs;
    const changes = record.fileChanges ?? record.partialChanges;
    return {
      schemaVersion: 1,
      jobId: record.id,
      harness: record.harness,
      model: record.model,
      taskMode: record.taskMode,
      status: record.status,
      outcome: record.outcome,
      errorCategory: record.errorCategory,
      workspace: record.workspace,
      usage: record.usage ?? {},
      toolCalls: { ...this.stats, byName: { ...this.stats.byName } },
      turns: record.turns,
      retryCount: record.retryCount,
      queuedMs: Math.max(0, effectiveStartMs - createdMs),
      runningMs: Math.max(0, finishedMs - effectiveStartMs),
      durationMs: computeDurationMs(record),
      fileChangeCounts: {
        created: changes?.created.length ?? 0,
        modified: changes?.modified.length ?? 0,
        deleted: changes?.deleted.length ?? 0,
      },
      eventCount: this.eventCount,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
    };
  }
}

/**
 * Wall clock from creation to finish (or to now, if still running) — the one definition
 * shared by `TaskMetricsCollector.build` and `compactRecord`'s `durationMs`, so the two can never disagree.
 */
export function computeDurationMs(record: TaskRecord): number {
  const finished = record.finishedAt ? new Date(record.finishedAt).getTime() : Date.now();
  const started = record.startedAt ? new Date(record.startedAt).getTime() : new Date(record.createdAt).getTime();
  return finished - started;
}

const collectors = new WeakMap<TaskRecord, TaskMetricsCollector>();

/**
 * The collector for one job, created on first use and shared by every caller holding the
 * same `TaskRecord` — including a read-only task's retries, which reuse the record so counts accumulate across the whole job, same as `record.toolCalls`.
 */
export function collectorFor(record: TaskRecord): TaskMetricsCollector {
  let collector = collectors.get(record);
  if (!collector) {
    collector = new TaskMetricsCollector();
    collectors.set(record, collector);
  }
  return collector;
}
