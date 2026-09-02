/** Narrow unknown JSON-like values safely before provider-specific parsing. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
