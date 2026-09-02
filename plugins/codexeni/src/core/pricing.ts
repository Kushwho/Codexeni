/**
 * Turning token counts into dollars, from one shared table, because harnesses disagree
 * about cost (Claude Code computes one, Antigravity reports none). Prices are data, not code — `BRIDGE_PRICING_FILE` can override or extend the built-in table.
 */
import type { Usage } from "./types.js";
import { isRecord } from "./value.js";

/** Dollars per million tokens for one model. Omitted fields mean "not priced separately". */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  /** Cache write at the short (5-minute) TTL, the default tier. */
  cacheWritePerMTok?: number;
  /**
   * Cache write at the long (1-hour) TTL, where the provider offers one.
   *
   * This is not a detail. Claude Code puts the main conversation and its
   * subagents in different TTL buckets, so one run can bill both tiers at once:
   * a measured session matched list price exactly at 1.25x for the subagent and
   * 2x for the orchestrator. Pricing both at one tier was off by 12%.
   */
  cacheWriteLongPerMTok?: number;
  /**
   * Only set this when the provider bills reasoning SEPARATELY from output — leaving it
   * unset means reasoning is already folded into `outputTokens`, and charging it again invents a cost.
   */
  thinkingPerMTok?: number;
  /** Where the numbers came from, so a stale entry can be traced. */
  source: string;
  /** ISO date the rates were last confirmed. Introductory pricing expires; this is how we notice. */
  asOf: string;
}

export type PriceTable = Record<string, ModelPrice>;

/** Key a price by harness and model, because the same model can be reached through more than one harness. */
export function priceKey(harness: string, model: string | undefined): string {
  return `${harness}:${model ?? ""}`;
}

const ANTHROPIC_SOURCE = "platform.claude.com/docs/en/about-claude/pricing";
const GOOGLE_SOURCE = "ai.google.dev/gemini-api/docs/pricing";
const CONFIRMED = "2026-08-31";

/**
 * Anthropic list rates. Cache writes use the 5-minute tier (1.25x input) for an
 * API-equivalent comparison — a subscription's 1-hour TTL (2x) actually costs more, but writes are a small enough share of a coding turn that this stays on published list rates.
 */
function anthropic(inputPerMTok: number, outputPerMTok: number): ModelPrice {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWritePerMTok: inputPerMTok * 1.25,
    cacheWriteLongPerMTok: inputPerMTok * 2,
    cacheReadPerMTok: inputPerMTok * 0.1,
    source: ANTHROPIC_SOURCE,
    asOf: CONFIRMED,
  };
}

/**
 * Match a model to a price entry.
 *
 * Claude Code reports dated snapshot ids in its `modelUsage` map
 * (`claude-haiku-4-5-20251001`) while the price table is keyed by the bare id,
 * so a direct lookup silently misses and the model reads as unpriced. Try the
 * exact key first, then again with a trailing `-YYYYMMDD` removed.
 */
export function lookupPrice(table: PriceTable, key: string): ModelPrice | undefined {
  return table[key] ?? table[key.replace(/-\d{8}$/, "")];
}

/**
 * Built-in rates, each carrying its source and confirmation date since these go stale
 * silently. Two key namespaces point at the same rates: `anthropic:<full model id>` (from a Claude Code `modelUsage` map) and `claude-code:<alias>` (what a bridge job records).
 */
export const BUILT_IN_PRICES: PriceTable = {
  // Anthropic, by full model id.
  "anthropic:claude-opus-5": anthropic(5, 25),
  "anthropic:claude-sonnet-5": anthropic(2, 10),
  "anthropic:claude-haiku-4-5": anthropic(1, 5),
  "anthropic:claude-opus-4-8": anthropic(5, 25),
  "anthropic:claude-sonnet-4-6": anthropic(3, 15),

  // Anthropic, by the alias the Claude Code CLI takes on --model.
  "claude-code:opus": anthropic(5, 25),
  "claude-code:sonnet": anthropic(2, 10),
  "claude-code:haiku": anthropic(1, 5),

  /**
   * Gemini 3.7 Flash paid tier. `thinkingPerMTok` stays unset because a real agy run
   * shows total = input + output, so reasoning is already inside output. Rates are introductory and double 2027-01-01; `asOf`/`PRICE_EXPIRY` flag that.
   */
  "antigravity:gemini-3.7-flash-high": {
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cacheReadPerMTok: 0.075,
    // Google prices cache STORAGE per token-hour, not per written token, so a write can't
    // be derived from a token count — left unset, so it's skipped rather than charged at the input rate.
    source: GOOGLE_SOURCE,
    asOf: CONFIRMED,
  },
};

/** The date after which an entry's rates are known to be superseded. */
export const PRICE_EXPIRY: Record<string, string> = {
  "antigravity:gemini-3.7-flash-high": "2026-12-31",
};

/** Reads a `BRIDGE_PRICING_FILE` payload. Unknown or malformed entries are dropped rather than throwing. */
export function parsePriceTable(raw: unknown): PriceTable {
  if (!isRecord(raw)) return {};
  const table: PriceTable = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const input = value.inputPerMTok;
    const output = value.outputPerMTok;
    if (typeof input !== "number" || !Number.isFinite(input)) continue;
    if (typeof output !== "number" || !Number.isFinite(output)) continue;
    const optional = (field: unknown): number | undefined =>
      typeof field === "number" && Number.isFinite(field) ? field : undefined;
    table[key] = {
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: optional(value.cacheReadPerMTok),
      cacheWritePerMTok: optional(value.cacheWritePerMTok),
      thinkingPerMTok: optional(value.thinkingPerMTok),
      source: typeof value.source === "string" ? value.source : "override",
      asOf: typeof value.asOf === "string" ? value.asOf : "unknown",
    };
  }
  return table;
}

/** Later tables win, so a `BRIDGE_PRICING_FILE` entry overrides a built-in one of the same key. */
export function mergePriceTables(...tables: readonly PriceTable[]): PriceTable {
  return Object.assign({}, ...tables) as PriceTable;
}

const PER_MILLION = 1_000_000;

/**
 * Cost for a usage record, or undefined when unpriced — never 0, since a zero silently
 * reads as "free" where undefined forces the caller to say "unknown". Fields the table doesn't cover are skipped, never charged at the input rate.
 */
export interface CostOptions {
  /**
   * Which cache-write tier the caller's requests actually used. Defaults to the
   * short tier. Pass "1h" for a Claude Code main conversation on a subscription,
   * whose own turns get the long TTL while its subagents keep the short one.
   */
  cacheTtl?: "5m" | "1h";
}

export function estimateCostUsd(
  usage: Usage | undefined,
  price: ModelPrice | undefined,
  options: CostOptions = {},
): number | undefined {
  if (!usage || !price) return undefined;
  let total = 0;
  let priced = false;
  const add = (tokens: number | undefined, rate: number | undefined): void => {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    if (typeof rate !== "number" || !Number.isFinite(rate)) return;
    total += (tokens / PER_MILLION) * rate;
    priced = true;
  };
  const cacheWriteRate =
    options.cacheTtl === "1h" ? price.cacheWriteLongPerMTok ?? price.cacheWritePerMTok : price.cacheWritePerMTok;
  add(usage.inputTokens, price.inputPerMTok);
  add(usage.outputTokens, price.outputPerMTok);
  add(usage.cacheReadTokens, price.cacheReadPerMTok);
  add(usage.cacheWriteTokens, cacheWriteRate);
  add(usage.thinkingTokens, price.thinkingPerMTok);
  return priced ? total : undefined;
}

/**
 * Fill in a cost only when the harness didn't report one — a harness-reported cost is
 * left untouched, since overwriting the provider's own arithmetic would hide a disagreement worth seeing.
 */
export function withEstimatedCost(usage: Usage | undefined, price: ModelPrice | undefined): Usage | undefined {
  if (!usage) return usage;
  if (typeof usage.costUsd === "number") {
    return usage.costSource ? usage : { ...usage, costSource: "harness" };
  }
  const estimated = estimateCostUsd(usage, price);
  return estimated === undefined ? usage : { ...usage, costUsd: estimated, costSource: "estimated" };
}

/** True when an entry's introductory pricing has lapsed, so a report can flag the number instead of trusting it. */
export function isPriceExpired(key: string, on: Date = new Date()): boolean {
  const expiry = PRICE_EXPIRY[key];
  if (!expiry) return false;
  return on.toISOString().slice(0, 10) > expiry;
}
