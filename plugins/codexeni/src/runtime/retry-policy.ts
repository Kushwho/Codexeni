import { LIMITS } from "../core/limits.js";
import type { TaskRecord } from "../core/types.js";
import { hasWorkspaceChanges } from "./events.js";

/** Keep retry eligibility separate from process lifecycle and provider parsing. */
export function mayRetry(record: TaskRecord): boolean {
  const retryableCategory = record.errorCategory === "rate_limited"
    || record.errorCategory === "session_limit"
    || record.errorCategory === "upstream_error";
  const noChanges = Boolean(record.partialChanges && !record.partialChanges.truncated && !hasWorkspaceChanges(record.partialChanges));
  return record.taskMode === "read_only" && retryableCategory && noChanges && record.retryCount < record.maxRetries;
}

export function retryBackoffMs(retryCount: number, random: () => number): number {
  const base = Math.min(LIMITS.backoffBaseMs * 2 ** retryCount, LIMITS.backoffCapMs);
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * LIMITS.backoffJitterMs);
  return Math.min(base + jitter, LIMITS.maxRetryAfterMs);
}
