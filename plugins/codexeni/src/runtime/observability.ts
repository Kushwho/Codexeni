/**
 * Where a finished job's `TaskMetrics` go. A sink is a passive observer that can never
 * affect a job's outcome — `dispatchToSinks` guarantees that by isolating every sink's failure.
 */
import { appendFile } from "node:fs/promises";
import type { TaskMetrics, UsageRollup } from "../core/metrics.js";
import { priceKey } from "../core/pricing.js";

export interface MetricsSink {
  readonly id: string;
  onTaskFinalized(metrics: TaskMetrics): void;
}

/**
 * Send one finished job's metrics to every sink. A throwing sink is caught and ignored
 * right here, so it can never fail the job or block the next sink from receiving the event.
 */
export function dispatchToSinks(sinks: readonly MetricsSink[], metrics: TaskMetrics): void {
  for (const sink of sinks) {
    try {
      sink.onTaskFinalized(metrics);
    } catch {
      // A misbehaving sink is the sink's problem, never the job's.
    }
  }
}

function newRollup(harness: string, model: string | undefined): UsageRollup {
  return {
    harness,
    model,
    jobs: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
    costIncomplete: false,
    toolCalls: 0,
    durationMs: 0,
  };
}

/**
 * In-process rollups keyed by harness+model, behind `delegate_discover`'s `totals` block.
 * Lives only for this process — a live summary, not a durable record; `NdjsonSink` is for that.
 */
export class MemoryAggregator implements MetricsSink {
  public readonly id = "memory-aggregator";
  private readonly byKey = new Map<string, UsageRollup>();

  public onTaskFinalized(metrics: TaskMetrics): void {
    const key = priceKey(metrics.harness, metrics.model);
    const rollup = this.byKey.get(key) ?? newRollup(metrics.harness, metrics.model);
    rollup.jobs += 1;
    if (metrics.status === "succeeded") rollup.succeeded += 1;
    else if (metrics.status === "failed" || metrics.status === "timed_out") rollup.failed += 1;
    rollup.inputTokens += metrics.usage.inputTokens ?? 0;
    rollup.outputTokens += metrics.usage.outputTokens ?? 0;
    rollup.cacheReadTokens += metrics.usage.cacheReadTokens ?? 0;
    rollup.cacheWriteTokens += metrics.usage.cacheWriteTokens ?? 0;
    rollup.thinkingTokens += metrics.usage.thinkingTokens ?? 0;
    if (typeof metrics.usage.costUsd === "number") rollup.costUsd += metrics.usage.costUsd;
    else rollup.costIncomplete = true;
    rollup.toolCalls += metrics.toolCalls.total;
    rollup.durationMs += metrics.durationMs;
    this.byKey.set(key, rollup);
  }

  public rollups(): UsageRollup[] {
    return [...this.byKey.values()];
  }
}

/**
 * Appends one NDJSON line per finished job to a file outside the repo — the durable
 * counterpart to `MemoryAggregator`. Fire-and-forget: `onTaskFinalized` stays synchronous so a slow disk never makes finalizing a job wait on it.
 */
export class NdjsonSink implements MetricsSink {
  public readonly id: string;

  public constructor(private readonly filePath: string) {
    this.id = `ndjson:${filePath}`;
  }

  public onTaskFinalized(metrics: TaskMetrics): void {
    void appendFile(this.filePath, `${JSON.stringify(metrics)}\n`, "utf8");
  }
}
