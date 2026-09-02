#!/usr/bin/env node
/**
 * Tiny stand-in for the Claude Code CLI (`claude`), reading only FAKE_CLAUDE_* env vars
 * and never needing credentials. The init/assistant/result lines are trimmed copies of real Claude Code 2.1.251 `--output-format stream-json` output.
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (argv.includes("--version")) {
  process.stdout.write("2.1.251 (Claude Code)\n");
  process.exit(0);
}

if (argv.includes("auth") && argv.includes("status")) {
  const status = process.env.FAKE_CLAUDE_AUTH === "out"
    ? { loggedIn: false }
    : { loggedIn: true, authMethod: "claude.ai", email: "fake@example.com" };
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(argv), "utf8");
}

function run(prompt) {
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) {
    writeFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, prompt, "utf8");
  }
  const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "success";
  const init = {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: "fake-claude-session",
    model: "claude-haiku-4-5-20251001",
    permissionMode: "default",
    claude_code_version: "2.1.251",
  };
  const assistant = {
    type: "assistant",
    message: {
      model: "claude-haiku-4-5-20251001",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 9713, cache_read_input_tokens: 0, output_tokens: 4 },
    },
    session_id: "fake-claude-session",
  };
  // Two tool calls: one that succeeds and one that fails, so integration tests
  // can exercise both a plain completion and an `is_error: true` tool_result.
  const assistantToolUse = {
    type: "assistant",
    message: {
      model: "claude-haiku-4-5-20251001",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_01read", name: "Read", input: { file_path: "a.txt" } },
        { type: "tool_use", id: "toolu_02bash", name: "Bash", input: { command: "false" } },
      ],
      usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 9713, output_tokens: 6 },
    },
    session_id: "fake-claude-session",
  };
  const userToolResult = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01read", content: "file contents", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_02bash", content: "command failed", is_error: true },
      ],
    },
    session_id: "fake-claude-session",
  };
  const successResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1384,
    num_turns: 2,
    result: "OK",
    session_id: "fake-claude-session",
    total_cost_usd: 0.020623,
    usage: { input_tokens: 10, cache_creation_input_tokens: 9713, cache_read_input_tokens: 0, output_tokens: 46 },
    permission_denials: [],
  };
  switch (scenario) {
    case "success":
      emit(init);
      emit(assistantToolUse);
      emit(userToolResult);
      emit(assistant);
      emit(successResult);
      process.exitCode = 0;
      break;
    case "error":
      emit(init);
      emit({ ...successResult, subtype: "error_during_execution", is_error: true, result: "Fake failure" });
      process.exitCode = 1;
      break;
    case "rate_limit":
      emit(init);
      emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 500,
        error_status: 429,
        error: "rate_limit",
        session_id: "fake-claude-session",
      });
      emit({ ...successResult, subtype: "error_during_execution", is_error: true, result: "rate limited" });
      process.exitCode = 1;
      break;
    default:
      process.stderr.write(`Unknown FAKE_CLAUDE_SCENARIO: ${scenario}\n`);
      process.exitCode = 2;
  }
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => run(Buffer.concat(chunks).toString("utf8")));
process.stdin.resume();
