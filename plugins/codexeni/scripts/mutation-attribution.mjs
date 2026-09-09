import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

// Per-test-file mutant kill attribution. For each unit test file, runs a Stryker
// pass that mutates src/core/** but executes only that file, then compares kill
// sets: absolute = mutants this file kills alone; marginal = kills no other file
// also covers (the deletion-relevant number). Reference pass (full suite) comes
// from the pilot campaign's reports/mutation/mutation.json.

const TEST_FILES = [
  "test/runtime.test.mjs",
  "test/interactive.test.mjs",
  "test/claude-code.test.mjs",
  "test/codex.test.mjs",
  "test/adapters.test.mjs",
];

const REFERENCE_REPORT = "reports/mutation/reference-mutation.json";
const ATTRIBUTION_DIR = "reports/attribution";

const mutantKey = (file, mutant) =>
  `${file.replaceAll("\\", "/")}#${mutant.location.start.line}:${mutant.location.start.column}` +
  `-${mutant.location.end.line}:${mutant.location.end.column}#${mutant.replacement}`;

const KILLED_STATUSES = new Set(["Killed", "Timeout"]);

// Stryker 10's json report uses the mutation-testing schema: `files` is an
// object keyed by source path, each holding a flat mutants array.
function readKillSet(reportFile) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const killed = new Set();
  let total = 0;
  for (const [name, file] of Object.entries(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      total += 1;
      if (KILLED_STATUSES.has(mutant.status)) killed.add(mutantKey(name, mutant));
    }
  }
  return { killed, total };
}

function runStryker(testFile, outDir) {
  console.log(`[attribution] mutating src/core/**, running only ${testFile} ...`);
  // Stryker 10 nests runner/reporter options, so per-run values go through a
  // dedicated config file instead of CLI overrides.
  mkdirSync(outDir, { recursive: true });
  const configPath = join(outDir, "stryker.config.json");
  writeFileSync(configPath, JSON.stringify({
    testRunner: "command",
    commandRunner: { command: `node scripts/stryker-command.mjs ${testFile}` },
    mutate: ["src/core/**/*.ts"],
    coverageAnalysis: "off",
    timeoutMS: 30000,
    dryRunTimeoutMinutes: 1,
    reporters: ["json"],
    tempDirName: ".stryker-tmp",
  }, null, 2));
  const result = spawnSync("pnpm", [
    "exec", "stryker", "run", configPath,
  ], { stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`Stryker failed for ${testFile} (exit ${result.status})`);
  }
  // Stryker 10 ignores per-run json output paths, so each pass overwrites the
  // default report location; move it aside before the next pass clobbers it.
  const defaultReport = "reports/mutation/mutation.json";
  if (!existsSync(defaultReport)) {
    throw new Error(`Expected Stryker report at ${defaultReport}`);
  }
  renameSync(defaultReport, join(outDir, "mutation.json"));
}

mkdirSync(ATTRIBUTION_DIR, { recursive: true });
// Each pass overwrites the default report location; keep a full-suite reference
// (the pilot campaign's report) safe before the first pass runs.
if (!existsSync(REFERENCE_REPORT) && existsSync("reports/mutation/mutation.json")) {
  renameSync("reports/mutation/mutation.json", REFERENCE_REPORT);
  console.log(`[attribution] backed up reference report to ${REFERENCE_REPORT}`);
}
const perFile = new Map();

for (const testFile of TEST_FILES) {
  const name = basename(testFile, ".test.mjs");
  const outDir = join(ATTRIBUTION_DIR, name);
  const reportFile = join(outDir, "mutation.json");
  if (!existsSync(reportFile)) {
    runStryker(testFile, outDir);
  } else {
    console.log(`[attribution] reusing ${reportFile}`);
  }
  const { killed, total } = readKillSet(reportFile);
  perFile.set(testFile, { killed, total });
  console.log(`[attribution] ${testFile}: kills ${killed.size}/${total} mutants`);
}

const unionOfOthers = (file) => {
  const union = new Set();
  for (const [other, { killed }] of perFile) {
    if (other !== file) for (const key of killed) union.add(key);
  }
  return union;
};

const lines = [
  "# Core-mutant kill attribution per test file",
  "",
  "| test file | mutants | killed (absolute) | killed (marginal) |",
  "| --- | --- | --- | --- |",
];
for (const [testFile, { killed, total }] of perFile) {
  const marginal = [...killed].filter((key) => !unionOfOthers(testFile).has(key)).length;
  lines.push(`| ${testFile} | ${total} | ${killed.size} | ${marginal} |`);
}

let warnings = [];
if (existsSync(REFERENCE_REPORT)) {
  const reference = readKillSet(REFERENCE_REPORT);
  const union = new Set();
  for (const { killed } of perFile.values()) for (const key of killed) union.add(key);
  const uncovered = [...reference.killed].filter((key) => !union.has(key));
  warnings.push(
    `reference (full suite) kills ${reference.killed.size}/${reference.total}; union of single-file runs kills ${union.size};` +
      ` killed-by-combination-only: ${uncovered.length}`,
  );
}

writeFileSync(join(ATTRIBUTION_DIR, "kill-attribution.md"), `${lines.join("\n")}\n${warnings.map((w) => `\n> ${w}\n`).join("")}`);
console.log(`\n${lines.join("\n")}\n`);
for (const warning of warnings) console.log(`WARNING: ${warning}`);
console.log(`\nWrote ${join(ATTRIBUTION_DIR, "kill-attribution.md")}`);
