import { LIMITS } from "../core/limits.js";
import { redactPotentialSecrets, SENSITIVE_FIELD_NAME } from "../core/redaction.js";
import type { StreamEvent, TaskRecord, WorkspaceChanges } from "../core/types.js";
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

export type EventDetail = "compact" | "full";

const COMPACT_EVENT_TEXT_CHARS = 1_000;

export function hasWorkspaceChanges(changes: WorkspaceChanges | undefined): boolean {
  return Boolean(changes && (changes.created.length || changes.modified.length || changes.deleted.length));
}

function compactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > COMPACT_EVENT_TEXT_CHARS ? `${value.slice(0, COMPACT_EVENT_TEXT_CHARS)}â€¦` : value;
}

function compactEvent(event: StreamEvent): Record<string, unknown> {
  const compact: Record<string, unknown> = { timestamp: event.timestamp, type: event.type };
  if (!isRecord(event.data)) {
    const message = compactText(event.data);
    if (message) compact.message = message;
    return compact;
  }

  const candidates = [event.data, event.data.result, event.data.message, event.data.step_update].filter(isRecord);
  for (const candidate of candidates) {
    if (compact.status === undefined && typeof candidate.status === "string") compact.status = candidate.status;
    if (compact.conversationId === undefined) {
      const conversationId = candidate.conversation_id ?? candidate.conversationId ?? candidate.session_id;
      if (typeof conversationId === "string") compact.conversationId = conversationId;
    }
    if (compact.message === undefined) {
      const message = compactText(candidate.text ?? candidate.response ?? candidate.message ?? candidate.content);
      if (message) compact.message = message;
    }
    if (compact.error === undefined) {
      const error = candidate.error;
      let errorValue: unknown;
      if (typeof error === "string") errorValue = error;
      else if (isRecord(error)) errorValue = error.message;
      const message = compactText(errorValue);
      if (message) compact.error = message;
    }
    if (compact.tool === undefined) {
      const tool = candidate.tool_name ?? (isRecord(candidate.tool_info) ? candidate.tool_info.name : undefined);
      if (typeof tool === "string") compact.tool = tool;
    }
    if (compact.toolState === undefined && typeof candidate.state === "string") compact.toolState = candidate.state;
  }
  return compact;
}

/** The harness-neutral view of a job returned to the orchestrator. */
export function compactRecord(record: TaskRecord, eventLimit: number, eventDetail: EventDetail, continuationSupported: boolean): Record<string, unknown> {
  const continuation = continuationStatus(record, continuationSupported);
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
    continuation,
    workspaceChanges: record.workspaceChanges,
    partialWorkspaceChanges: record.partialWorkspaceChanges,
    hasPartialWorkspaceChanges: hasWorkspaceChanges(record.partialWorkspaceChanges),
    warnings: record.warnings,
    errorCategory: record.errorCategory,
    failure: record.failure,
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
    events: eventDetail === "full" ? record.events.slice(-eventLimit) : record.events.slice(-eventLimit).map(compactEvent),
    // Live snapshot: accurate mid-run, not just at finalize, since nothing here mutates on read.
    metrics: collectorFor(record).build(record),
  };
}

function continuationStatus(record: TaskRecord, supported: boolean): Record<string, unknown> {
  if (!supported) return { supported: false, available: false, reason: "This harness does not support conversation continuation." };
  if (!record.conversationId) return { supported: true, available: false, reason: "The worker did not report a conversation ID." };
  if (record.status === "awaiting_input" && record.inputRequest) return { supported: true, available: true, action: "answer" };
  if (record.status === "failed" || record.status === "timed_out") return { supported: true, available: true, action: "resume" };
  return { supported: true, available: false, reason: "Continuation is available only while awaiting input or after a failure or timeout." };
}
