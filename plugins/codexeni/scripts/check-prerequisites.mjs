#!/usr/bin/env node

/**
 * Non-secret prerequisite check: it never inspects OAuth files, environment values, browser
 * storage, or token-bearing output — only the executable, version, and public model listing exposed by agy, plus a best-effort claude-code version check.
 */
import { execFileSync } from "node:child_process";

const exactModel = process.env.BRIDGE_ANTIGRAVITY_MODEL ?? process.env.AGY_BRIDGE_DEFAULT_MODEL ?? process.env.ANTIGRAVITY_MODEL ?? "gemini-3.7-flash-high";
const executable = process.env.BRIDGE_ANTIGRAVITY_PATH ?? process.env.AGY_BRIDGE_AGY_PATH ?? process.env.ANTIGRAVITY_CLI ?? "agy";
const claudeExecutable = process.env.BRIDGE_CLAUDE_CODE_PATH ?? "claude";

function run(exe, args) {
  try {
    return execFileSync(exe, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim();
    throw new Error(detail || error?.message || `${exe} command failed`);
  }
}

/** claude-code is an optional worker: report its state, but never fail the check for it being absent. */
function checkClaudeCodeWorker() {
  try {
    const version = run(claudeExecutable, ["--version"]).trim().split(/\r?\n/, 1)[0] || "unknown";
    console.log(`claude executable (optional worker): ${claudeExecutable}`);
    console.log(`claude version: ${version}`);
  } catch (error) {
    console.log(`claude executable (optional worker): ${claudeExecutable}`);
    console.log(`claude not available: ${error.message}`);
    console.log("This is only a problem if you plan to delegate to the claude-code worker.");
  }
}

try {
  const version = run(executable, ["--version"]).trim().split(/\r?\n/, 1)[0] || "unknown";
  const models = run(executable, ["models"]);
  const available = models.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = available.some((model) => model === exactModel || model.includes(exactModel));

  console.log(`agy executable: ${executable}`);
  console.log(`agy version: ${version}`);
  console.log(`requested model: ${exactModel}`);
  console.log(`model listed: ${found ? "yes" : "no"}`);
  console.log("OAuth state: not inspected; run the normal agy login flow if a task cannot authenticate.");

  checkClaudeCodeWorker();

  if (!found) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Antigravity prerequisite check failed: ${error.message}`);
  console.error("Install agy and authenticate it through its normal interactive OAuth flow; this script never reads tokens.");
  checkClaudeCodeWorker();
  process.exitCode = 1;
}
