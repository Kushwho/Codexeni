/**
 * Default failure classification shared by every harness — rate-limit, quota, context,
 * and authentication error wording is similar across providers; an adapter overrides only when its harness needs it.
 */
import type { ErrorCategory } from "./types.js";

function asText(context: unknown): string {
  return typeof context === "string" ? context : JSON.stringify(context ?? "");
}

export function defaultClassifyFailure(context: unknown): ErrorCategory | undefined {
  const normalized = asText(context).toLowerCase();
  if (/(?:unauthenticated|not authenticated|login required|session expired|invalid (?:auth|credential)|authentication failed)/.test(normalized)) return "authentication";
  if (/(?:session limit|too many sessions|concurrent sessions|session[_ -]?limit)/.test(normalized)) return "session_limit";
  if (/(?:context limit|context window|token limit|maximum (?:context|tokens)|too many tokens|prompt is too long)/.test(normalized)) return "context_limit";
  if (/(?:quota (?:exceeded|exhausted)|quota_exhausted|out of credits|credits? exhausted|resource[_ -]?exhausted)/.test(normalized)) return "quota_exhausted";
  if (/(?:\b429\b|http[_ ]?429|rate[ _-]?limit(?:ed)?|too many requests|resource exhausted)/.test(normalized)) return "rate_limited";
  if (/(?:\b5\d\d\b|upstream|service unavailable|internal error|network error|connection (?:reset|refused|timed out))/i.test(normalized)) return "upstream_error";
  return undefined;
}

/** Returns a provider-directed wait in milliseconds when present, including reset timestamps. */
export function defaultRetryAfterMs(context: unknown, nowMs: number): number | undefined {
  const fromStructuredValue = (candidate: unknown, depth = 0): number | undefined => {
    if (!candidate || typeof candidate !== "object" || depth > 8) return undefined;
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedKey === "retryafterms" && (typeof item === "number" || typeof item === "string")) {
        const milliseconds = Number(item);
        if (Number.isFinite(milliseconds)) return Math.max(0, Math.round(milliseconds));
      }
      if (normalizedKey === "retryafter" && (typeof item === "number" || typeof item === "string")) {
        const seconds = Number(item);
        if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
        const timestamp = Date.parse(String(item));
        if (Number.isFinite(timestamp)) return Math.max(0, timestamp - nowMs);
      }
      if (["reset", "resetat", "retryat", "blockeduntil"].includes(normalizedKey) && typeof item === "string") {
        const timestamp = Date.parse(item);
        if (Number.isFinite(timestamp)) return Math.max(0, timestamp - nowMs);
      }
      const nested = fromStructuredValue(item, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const structured = fromStructuredValue(context);
  if (structured !== undefined) return structured;
  const text = asText(context);
  const seconds = /retry(?:-|_)?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\b/i.exec(text);
  if (seconds) return Math.max(0, Math.round(Number(seconds[1]) * 1_000));
  const milliseconds = /retry(?:-|_)?after(?:_ms|\s*ms)\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(text);
  if (milliseconds) return Math.max(0, Math.round(Number(milliseconds[1])));
  const retryDate = /retry(?:-|_)?after\s*[:=]\s*["']?(\d{4}-\d\d-\d\dT[^"'\s,}]+)/i.exec(text);
  if (retryDate) {
    const retryTime = Date.parse(retryDate[1]);
    if (Number.isFinite(retryTime)) return Math.max(0, retryTime - nowMs);
  }
  const httpDate = /retry(?:-|_)?after\s*:\s*([^\r\n]+)/i.exec(text);
  if (httpDate) {
    const retryTime = Date.parse(httpDate[1].trim().replace(/^['"]|['"]$/g, ""));
    if (Number.isFinite(retryTime)) return Math.max(0, retryTime - nowMs);
  }
  const reset = /(?:reset(?:[_ -]?at)?|retry[_ -]?at|blocked[_ -]?until)\s*[:=]?\s*["']?([^"'\s,}]+)/i.exec(text);
  if (reset) {
    const resetTime = Date.parse(reset[1]);
    if (Number.isFinite(resetTime)) return Math.max(0, resetTime - nowMs);
  }
  return undefined;
}
