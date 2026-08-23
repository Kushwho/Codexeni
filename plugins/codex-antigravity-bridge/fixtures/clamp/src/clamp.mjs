/** Return value constrained to the inclusive min/max range. */
export function clamp(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError("clamp accepts only finite numbers");
  }
  if (min > max) {
    throw new RangeError("min must not exceed max");
  }
  return Math.min(Math.max(value, min), max);
}
