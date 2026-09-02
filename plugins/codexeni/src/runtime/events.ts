import { LIMITS } from "../core/limits.js";
import { redactPotentialSecrets, SENSITIVE_FIELD_NAME } from "../core/redaction.js";
import type { FileChanges, StreamEvent, TaskRecord } from "../core/types.js";
import { isRecord } from "../core/value.js";
import { collectorFor, computeDurationMs } from "./metrics-collector.js";

export { redactPotentialSecrets, SENSITIVE_FIELD_NAME } from "../core/redaction.js";

/** Bound and sanitize child-provided JSON before retaining or returning it. */
export function sanitizeEventData(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactPotentialSecrets(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEventData(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key,
      SENSITIVE_FIELD_NAME.test(key) ? "[redacted]" : sanitizeEventData(item, depth + 1),
    ]));
  }
  return String(value).slice(0, LIMITS.maxEventChars);
}

export { isRecord } from "../core/value.js";

/** Parse one line of child output. Every supported harness streams JSON per line; anything else is kept as text. */
export function parseJsonLine(line: string, timestamp: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const data: unknown = JSON.parse(trimmed);
    const eventType = isRecord(data) ? data.event ?? data.type : undefined;
    return { timestamp, type: typeof eventType === "string" ? eventType : "event", data };
  } catch {
    return { timestamp, type: "unparsed_output", data: trimmed.slice(0, LIMITS.maxEventChars) };
  }
}

export function hasWorkspaceChanges(changes: FileChanges | undefined): boolean {
  return Boolean(changes && (changes.created.length || changes.modified.length || changes.deleted.length));
}

/** The harness-neutral view of a job returned to the orchestrator. */
export function compactRecord(record: TaskRecord, eventLimit: number, continuationSupported?: boolean): Record<string, unknown> {
  return {
    jobId: record.id,
    harness: record.harness,
    model: record.model,
    status: record.status,
    summary: record.summary,
    usage: record.usage,
    // Defensive copy so a caller mutating the response cannot touch runtime state.
    inputRequest: record.inputRequest ? { ...record.inputRequest, options: record.inputRequest.options ? [...record.inputRequest.options] : undefined } : undefined,
    interactionRound: { current: record.inputRounds, max: LIMITS.maxInputRounds, remaining: Math.max(0, LIMITS.maxInputRounds - record.inputRounds) },
    continuationSupported,
    fileChanges: record.fileChanges,
    partialChanges: record.partialChanges,
    hasPartialChanges: hasWorkspaceChanges(record.partialChanges),
    warnings: record.warnings,
    errorCategory: record.errorCategory,
    outcome: record.outcome,
    sessionId: record.sessionId,
    workspace: record.workspace,
    effort: record.effort,
    permissionMode: record.permissionMode,
    taskMode: record.taskMode,
    retryable: record.retryable,
    retryCount: record.retryCount,
    maxRetries: record.maxRetries,
    nextRetryAt: record.nextRetryAt,
    blockedUntil: record.blockedUntil,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: computeDurationMs(record),
    pid: record.pid,
    exitCode: record.exitCode,
    signal: record.signal,
    stderrSummary: record.stderrSummary,
    logPath: record.logPath,
    events: record.events.slice(-eventLimit),
    // Live snapshot: accurate mid-run, not just at finalize, since nothing here mutates on read.
    metrics: collectorFor(record).build(record),
  };
}
