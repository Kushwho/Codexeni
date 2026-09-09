import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as esbuild from "esbuild";

// Test command for Stryker's generic runner. Tests import ../dist/index.js, so each
// mutant needs a fresh bundle in whatever directory this runs in (the repo or a
// Stryker sandbox). Skips tsc and sourcemaps: mutants don't need typechecking.
const DEFAULT_TEST_FILES = [
  "test/runtime.test.mjs",
  "test/interactive.test.mjs",
  "test/claude-code.test.mjs",
  "test/codex.test.mjs",
  "test/adapters.test.mjs",
];

const testFiles = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TEST_FILES;
for (const file of testFiles) {
  if (!existsSync(file)) {
    console.error(`Missing test file: ${file}`);
    process.exit(1);
  }
}

const startedAt = performance.now();
mkdirSync("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  logLevel: "silent",
  // The committed bundle has no external deps; keep the same shape so tests
  // exercising the bundle see production-like output.
  external: [],
});

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
  stdio: ["ignore", "inherit", "inherit"],
});
const elapsedMs = Math.round(performance.now() - startedAt);
console.error(`[stryker-command] ${testFiles.join(" ")} -> exit ${result.status ?? "signal"} in ${elapsedMs}ms`);
process.exit(result.status ?? 1);
