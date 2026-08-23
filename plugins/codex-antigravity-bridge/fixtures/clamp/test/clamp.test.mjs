import assert from "node:assert/strict";
import test from "node:test";
import { clamp } from "../src/clamp.mjs";

test("clamp preserves an in-range value", () => {
  assert.equal(clamp(4, 1, 8), 4);
});

test("clamp enforces both inclusive bounds", () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});

test("clamp rejects invalid ranges and non-finite numbers", () => {
  assert.throws(() => clamp(1, 5, 4), RangeError);
  assert.throws(() => clamp(Number.NaN, 0, 1), TypeError);
  assert.throws(() => clamp(Infinity, 0, 1), TypeError);
});
