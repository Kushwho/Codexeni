#!/usr/bin/env node
/**
 * Tiny stand-in for the Antigravity CLI used by the bridge integration tests.
 * It deliberately reads only FAKE_AGY_SCENARIO and never needs credentials.
 */
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync } from "node:fs";

const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (process.env.FAKE_AGY_ARGS_FILE) {
  writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)), "utf8");
}

if (process.argv.includes("--version")) {
  process.stdout.write("agy 0.0.0-test\n");
  process.exit(0);
}

if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\n");
  process.exit(0);
}

switch (scenario) {
  case "success":
    emit({ type: "message", role: "assistant", content: "Fake task started." });
    emit({ type: "message", role: "assistant", content: "Fake task completed." });
    emit({ type: "result", status: "completed", conversation_id: "fake-conversation", usage: { input_tokens: 3, output_tokens: 5 } });
    break;
  case "malformed":
    process.stdout.write("this is not JSON\n");
    break;
  case "failure":
    emit({ type: "error", message: "Fake agy failure" });
    process.stderr.write("Fake agy failure\n");
    process.exitCode = 17;
    break;
  case "slow":
    emit({ type: "message", role: "assistant", content: "Fake task started." });
    await delay(Number(process.env.FAKE_AGY_DELAY_MS ?? 5000));
    emit({ type: "result", status: "completed", conversation_id: "slow-fake" });
    break;
  default:
    process.stderr.write(`Unknown FAKE_AGY_SCENARIO: ${scenario}\n`);
    process.exitCode = 2;
}
