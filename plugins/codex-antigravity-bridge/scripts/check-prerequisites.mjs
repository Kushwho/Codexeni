#!/usr/bin/env node

/**
 * Non-secret prerequisite check for the Codex–Antigravity Bridge.
 *
 * This script intentionally does not inspect OAuth files, environment values,
 * browser storage, or any token-bearing command output. It only checks the
 * executable, version, and public model listing exposed by agy.
 */
import { execFileSync } from "node:child_process";

const exactModel = process.env.ANTIGRAVITY_MODEL ?? "gemini-3.7-flash-high";
const executable = process.env.AGY_BRIDGE_AGY_PATH ?? process.env.ANTIGRAVITY_CLI ?? "agy";

function run(args) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim();
    throw new Error(detail || error?.message || "agy command failed");
  }
}

try {
  const version = run(["--version"]).trim().split(/\r?\n/, 1)[0] || "unknown";
  const models = run(["models"]);
  const available = models.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = available.some((model) => model === exactModel || model.includes(exactModel));

  console.log(`agy executable: ${executable}`);
  console.log(`agy version: ${version}`);
  console.log(`requested model: ${exactModel}`);
  console.log(`model listed: ${found ? "yes" : "no"}`);
  console.log("OAuth state: not inspected; run the normal agy login flow if a task cannot authenticate.");

  if (!found) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Antigravity prerequisite check failed: ${error.message}`);
  console.error("Install agy and authenticate it through its normal interactive OAuth flow; this script never reads tokens.");
  process.exitCode = 1;
}
