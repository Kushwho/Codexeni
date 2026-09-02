/**
 * Environment-driven settings: every variable is declared below with its legacy alias,
 * so nothing else touches process.env. Fixed limits live in limits.ts; adapter defaults live with each adapter.
 */
import { readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { LIMITS } from "../core/limits.js";
import { BUILT_IN_PRICES, mergePriceTables, parsePriceTable, type PriceTable } from "../core/pricing.js";
import type { BridgeConfig, HarnessSettings, PermissionMode } from "../core/types.js";

export const DEFAULT_HARNESS = "antigravity";
export const DEFAULT_TIMEOUT_SECONDS = 900;

/** Core settings: the BRIDGE_* name first, then legacy AGY_BRIDGE_* aliases still honored. */
export const CORE_ENV = {
  allowedRoots: ["BRIDGE_ALLOWED_ROOTS", "AGY_BRIDGE_ALLOWED_ROOTS"],
  permissionMode: ["BRIDGE_PERMISSION_MODE", "AGY_BRIDGE_PERMISSION_MODE"],
  defaultHarness: ["BRIDGE_DEFAULT_HARNESS"],
  defaultTimeoutSeconds: ["BRIDGE_DEFAULT_TIMEOUT_SECONDS", "AGY_BRIDGE_DEFAULT_TIMEOUT_SECONDS"],
  maxConcurrency: ["BRIDGE_MAX_CONCURRENCY", "AGY_BRIDGE_MAX_CONCURRENCY"],
} as const;

/**
 * Observability settings, separate from CORE_ENV since neither resolves into a (frozen)
 * `BridgeConfig` field — each gets its own resolver below. Both are new names with no `AGY_BRIDGE_*` predecessor, so neither carries a legacy alias.
 */
export const METRICS_ENV = {
  metricsFile: ["BRIDGE_METRICS_FILE"],
  pricingFile: ["BRIDGE_PRICING_FILE"],
} as const;

/**
 * Per-harness settings follow BRIDGE_<HARNESS>_PATH/_MODEL, with underscores becoming
 * hyphens (CLAUDE_CODE is claude-code). These legacy names predate that convention.
 */
export const LEGACY_HARNESS_ENV: ReadonlyArray<{ name: string; harness: string; setting: keyof HarnessSettings }> = [
  { name: "AGY_BRIDGE_AGY_PATH", harness: "antigravity", setting: "executable" },
  { name: "AGY_BRIDGE_DEFAULT_MODEL", harness: "antigravity", setting: "defaultModel" },
];

const HARNESS_ENV_PATTERN = /^BRIDGE_([A-Z0-9_]+)_(PATH|MODEL)$/;

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function firstEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = nonEmpty(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Collect per-harness settings by scanning for BRIDGE_<HARNESS>_PATH/_MODEL plus the
 * legacy aliases — the config layer never needs to know which adapters exist.
 */
export function resolveHarnessSettings(env: NodeJS.ProcessEnv = process.env): Record<string, HarnessSettings> {
  const harnesses: Record<string, HarnessSettings> = {};
  const assign = (harness: string, setting: keyof HarnessSettings, value: string | undefined): void => {
    if (value === undefined) return;
    const entry = (harnesses[harness] ??= {});
    if (entry[setting] === undefined) entry[setting] = value;
  };
  for (const [name, value] of Object.entries(env)) {
    const match = HARNESS_ENV_PATTERN.exec(name);
    if (match) assign(match[1].toLowerCase().replace(/_/g, "-"), match[2] === "PATH" ? "executable" : "defaultModel", nonEmpty(value));
  }
  for (const legacy of LEGACY_HARNESS_ENV) assign(legacy.harness, legacy.setting, nonEmpty(env[legacy.name]));
  return harnesses;
}

/** Resolve all configuration from the environment without looking at credential files. */
export function resolveBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const permission = firstEnv(env, CORE_ENV.permissionMode)?.toLowerCase();
  // Full is the default so a worker edits files and runs commands without per-call prompts out
  // of the box; set BRIDGE_PERMISSION_MODE=restricted to opt into approval instead. An explicitly-set but unrecognized value still fails closed to restricted, matching the pre-refactor default.
  const permissionMode: PermissionMode = permission === undefined || permission === "full" ? "full" : "restricted";
  const allowedRoots = (firstEnv(env, CORE_ENV.allowedRoots) ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return {
    allowedRoots,
    permissionMode,
    defaultHarness: firstEnv(env, CORE_ENV.defaultHarness)?.toLowerCase() ?? DEFAULT_HARNESS,
    defaultTimeoutSeconds: parsePositiveInt(firstEnv(env, CORE_ENV.defaultTimeoutSeconds), DEFAULT_TIMEOUT_SECONDS),
    maxConcurrency: Math.min(parsePositiveInt(firstEnv(env, CORE_ENV.maxConcurrency), LIMITS.maxConcurrency), LIMITS.maxConcurrency),
    harnesses: resolveHarnessSettings(env),
  };
}

/** Path for the optional NDJSON metrics sink. Absent means no file sink is created. */
export function resolveMetricsFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = firstEnv(env, METRICS_ENV.metricsFile);
  return value === undefined ? undefined : resolve(value);
}

/**
 * `BUILT_IN_PRICES` merged with an optional `BRIDGE_PRICING_FILE` override: unset is
 * silent, but a set-and-unreadable file warns and falls back rather than crashing startup — pricing is convenience data, not a reason to refuse to start.
 */
export function resolvePriceTable(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const path = firstEnv(env, METRICS_ENV.pricingFile);
  if (path === undefined) return { ...BUILT_IN_PRICES };
  try {
    const raw: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    return mergePriceTables(BUILT_IN_PRICES, parsePriceTable(raw));
  } catch (error) {
    console.warn(`[codexeni] Could not read BRIDGE_PRICING_FILE at "${path}": ${error instanceof Error ? error.message : String(error)}. Continuing with built-in prices only.`);
    return { ...BUILT_IN_PRICES };
  }
}
