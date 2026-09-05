import type { Usage } from "./types.js";

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Map the token-count names used by common harnesses onto one shape. Unknown
 * fields are dropped; the raw event is still retained in the job's event tail.
 */
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const usage: Usage = {};
  const inputTokens = asNumber(record.input_tokens ?? record.inputTokens ?? record.prompt_tokens);
  const outputTokens = asNumber(record.output_tokens ?? record.outputTokens ?? record.completion_tokens);
  // `cache_read_tokens` is Antigravity's spelling; the longer names are Anthropic's.
  const cacheReadTokens = asNumber(
    record.cache_read_input_tokens ?? record.cached_input_tokens ?? record.cache_read_tokens ?? record.cacheReadTokens,
  );
  const cacheWriteTokens = asNumber(
    record.cache_creation_input_tokens ?? record.cache_write_tokens ?? record.cacheWriteTokens,
  );
  // `reasoningTokens` is ZCode's spelling of thinking tokens.
  const thinkingTokens = asNumber(
    record.thinking_tokens ?? record.thoughts_token_count ?? record.thinkingTokens ?? record.reasoning_tokens ?? record.reasoningTokens,
  );
  const totalTokens = asNumber(record.total_tokens ?? record.totalTokens);
  const costUsd = asNumber(record.total_cost_usd ?? record.cost_usd ?? record.costUsd);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (thinkingTokens !== undefined) usage.thinkingTokens = thinkingTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
