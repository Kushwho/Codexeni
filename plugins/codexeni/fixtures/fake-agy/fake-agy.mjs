#!/usr/bin/env node
/**
 * Tiny stand-in for the Antigravity CLI used by the bridge integration tests.
 * It deliberately reads only FAKE_AGY_SCENARIO and never needs credentials.
 */
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync } from "node:fs";

const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** One paused turn: a clean exit that reports the thread id and the structured question. */
const pauseEvent = () => ({
  type: "result",
  conversation_id: "fake-interaction",
  structured_output: {
    status: "input_required",
    summary: "Paused before choosing a fixture option.",
    question: "Which safe fixture option should I use?",
    options: ["option-a", "option-b"],
  },
});

if (process.env.FAKE_AGY_ARGS_FILE) {
  writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)), "utf8");
}

if (process.argv.includes("--version")) {
  process.stdout.write("agy 0.0.0-test\n");
  process.exit(0);
}

if (process.argv.includes("models")) {
  process.stderr.write("Fetching available models...\n");
  process.stdout.write("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n");
  process.stdout.write("claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
  process.exit(0);
}

const effortIndex = process.argv.indexOf("--effort");
if (effortIndex >= 0) {
  // The real CLI rejects --effort outright: a tiered slug already fixes the tier
  // and an untiered model takes none. Fail here so a regression cannot pass.
  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "";
  const effort = process.argv[effortIndex + 1];
  emit({ type: "result", status: "ERROR", conversation_id: "", error: `invalid model selection (--model "${model}" --effort "${effort}")` });
  process.exit(1);
}

switch (scenario) {
  case "success":
    emit({ type: "message", role: "assistant", content: "Fake task started." });
    // One clean step and one that carries an error, to exercise both a completed observation
    // and an ok:false one. Shaped like real agy output: `event`/`step_update` envelope, ACTIVE then DONE/ERROR sharing one step_index — not the flat `{type, tool_info}` the docs describe.
    const step = (index, state, tool, extra = {}) => emit({
      event: "step_update",
      step_update: {
        conversation_id: "fake-conversation", step_index: index, state,
        step_type: "tool", tool_name: tool,
        tool_info: { name: tool, parameters: {}, ...extra },
      },
    });
    step(1, "ACTIVE", "read_file");
    step(1, "DONE", "read_file");
    step(2, "ACTIVE", "run_command");
    step(2, "ERROR", "run_command", { error: { type: "TOOL_ERROR", message: "exit code 1" } });
    emit({ type: "message", role: "assistant", content: "Fake task completed." });
    emit({ type: "result", status: "SUCCESS", conversation_id: "fake-conversation", num_turns: 2, usage: { input_tokens: 3, output_tokens: 5 } });
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
    emit({ type: "result", status: "SUCCESS", conversation_id: "slow-fake" });
    break;
  case "interaction": {
    const conversationIndex = process.argv.indexOf("--conversation");
    const conversationId = conversationIndex >= 0 ? process.argv[conversationIndex + 1] : undefined;
    if (conversationId === "fake-interaction") {
      // The adapter sends the prompt via `--prompt` (argv), never stdin; echo it
      // back so a test can confirm the answer it supplied actually arrived here.
      const promptIndex = process.argv.indexOf("--prompt");
      const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] ?? "" : "";
      emit({ type: "message", role: "assistant", content: `Continuing with: ${prompt.slice(0, 200)}` });
      emit({ type: "result", status: "SUCCESS", conversation_id: conversationId, structured_output: { status: "completed", summary: "Fake interactive task completed." } });
    } else {
      // A pause is a clean exit carrying a conversation_id plus the structured input_required
      // result — the adapter reads clarifications only from structured_output, and the runtime needs the id to resume the thread.
      emit(pauseEvent());
    }
    break;
  }
  case "interaction-loop":
    // Ignores --conversation entirely: every turn re-asks the same question, so a
    // test can drive the repeated-question and max-input-rounds guards.
    emit(pauseEvent());
    break;
  default:
    process.stderr.write(`Unknown FAKE_AGY_SCENARIO: ${scenario}\n`);
    process.exitCode = 2;
}
