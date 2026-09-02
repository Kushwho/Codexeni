import assert from "node:assert/strict";
import test from "node:test";

// The package test command must build first, so consumers exercise its public
// compiled API exactly as Codex does rather than relying on a TypeScript loader.
const bridge = await import("../dist/index.js");

// --- ClaudeCodeAdapter -------------------------------------------------

test("ClaudeCodeAdapter.interpret() emits a started observation per tool_use block, with name and id", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
  const assistantToolUse = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_01read", name: "Read", input: { file_path: "a.txt" } },
        { type: "tool_use", id: "toolu_02bash", name: "Bash", input: { command: "false" } },
      ],
    },
    session_id: "fake-claude-session",
  };

  const { toolCalls } = adapter.interpret(assistantToolUse);
  assert.deepEqual(toolCalls, [
    { name: "Read", phase: "started", id: "toolu_01read" },
    { name: "Bash", phase: "started", id: "toolu_02bash" },
  ]);
});

test("ClaudeCodeAdapter.interpret() emits a completed observation with ok:false for a tool_result carrying is_error:true", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
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

  const { toolCalls } = adapter.interpret(userToolResult);
  assert.deepEqual(toolCalls, [
    { name: "", phase: "completed", ok: true, id: "toolu_01read" },
    { name: "", phase: "completed", ok: false, id: "toolu_02bash" },
  ]);
});

test("ClaudeCodeAdapter.interpret() reads num_turns off the result event", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    result: "OK",
    session_id: "fake-claude-session",
  };

  assert.equal(adapter.interpret(result).turns, 2);
  // A non-finite value must not be copied through as a turn count.
  assert.equal(adapter.interpret({ ...result, num_turns: Number.NaN }).turns, undefined);
});

test("ClaudeCodeAdapter.interpret() yields no toolCalls for an event with no tool activity", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
  const plainAssistant = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } };
  assert.equal(adapter.interpret(plainAssistant).toolCalls, undefined);
  assert.equal(adapter.interpret({ type: "system", subtype: "init" }).toolCalls, undefined);
});

// --- AntigravityAdapter --------------------------------------------------

// Shapes below are from a real agy 1.1.22 run, not the docs: the docs describe a flat
// `{type:"step_update", tool_info:{...}}`, but the CLI nests it under `event`/`step_update` — an earlier adapter version silently counted zero tool calls on a run that used tools.

test("AntigravityAdapter.interpret() emits exactly ONE observation for one step_update event", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  // A step_update event is itself record-shaped, like several other candidates interpret()
  // inspects — this asserts the step is read once, not once per candidate that happens to match.
  const stepUpdate = {
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 3, state: "DONE", step_type: "tool",
      tool_name: "read_file", tool_info: { name: "read_file", parameters: { path: "a.txt" } },
    },
  };

  const { toolCalls } = adapter.interpret(stepUpdate);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls, [{ name: "read_file", phase: "completed", ok: true, id: "c1:3" }]);
});

test("AntigravityAdapter.interpret() marks ok:false when tool_info carries an error", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  const stepUpdate = {
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 4, state: "DONE", step_type: "tool",
      tool_info: { name: "run_command", parameters: { command: "false" }, error: "exit code 1" },
    },
  };

  const { toolCalls } = adapter.interpret(stepUpdate);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].ok, false);
  assert.equal(toolCalls[0].name, "run_command");
});

test("AntigravityAdapter.interpret() falls back to a sibling tool_name and reads num_turns off the terminal envelope", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  const stepUpdate = {
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 5, state: "DONE", step_type: "tool",
      tool_info: {}, tool_name: "list_files",
    },
  };
  assert.deepEqual(adapter.interpret(stepUpdate).toolCalls, [
    { name: "list_files", phase: "completed", ok: true, id: "c1:5" },
  ]);

  const result = { type: "result", status: "SUCCESS", conversation_id: "fake-conversation", num_turns: 2 };
  assert.equal(adapter.interpret(result).turns, 2);
});

test("AntigravityAdapter.interpret() yields no toolCalls for an event with no tool activity", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  assert.equal(adapter.interpret({ type: "message", role: "assistant", content: "Fake task started." }).toolCalls, undefined);
  assert.equal(adapter.interpret({ type: "result", status: "SUCCESS", conversation_id: "fake-conversation" }).toolCalls, undefined);
});

test("Antigravity tool steps are read from the real agy step_update shape", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "agy" });

  // Verbatim shape from agy 1.1.22: envelope labelled `event`, payload nested
  // under `step_update`, one ACTIVE followed by one DONE/ERROR per tool.
  const active = adapter.interpret({
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 2, state: "ACTIVE", step_type: "tool",
      tool_name: "list_dir", tool_info: { name: "list_dir", parameters: {} },
    },
  });
  assert.equal(active.toolCalls?.length, 1);
  assert.equal(active.toolCalls[0].name, "list_dir");
  assert.equal(active.toolCalls[0].phase, "started");
  assert.equal(active.toolCalls[0].id, "c1:2");

  const failed = adapter.interpret({
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 2, state: "ERROR", step_type: "tool",
      tool_name: "list_dir",
      tool_info: { name: "list_dir", error: { type: "TOOL_ERROR", message: "permission denied" } },
    },
  });
  assert.equal(failed.toolCalls[0].phase, "completed");
  assert.equal(failed.toolCalls[0].ok, false);
  assert.equal(failed.toolCalls[0].id, "c1:2", "same id so the pair counts as one call");
});

test("Antigravity non-tool steps yield no tool observation", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "agy" });
  for (const stepType of ["user_input", "agent_response"]) {
    const out = adapter.interpret({
      event: "step_update",
      step_update: { conversation_id: "c1", step_index: 1, state: "DONE", step_type: stepType },
    });
    assert.ok(!out.toolCalls?.length, `${stepType} must not count as a tool call`);
  }
});

test("Antigravity per-step usage keeps thinking and cache-read counts", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "agy" });
  const out = adapter.interpret({
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 1, state: "DONE", step_type: "agent_response",
      usage: { input_tokens: 5121, output_tokens: 1726, thinking_tokens: 1641, cache_read_tokens: 12203, total_tokens: 6847 },
    },
  });
  assert.equal(out.usage?.inputTokens, 5121);
  assert.equal(out.usage?.outputTokens, 1726);
  assert.equal(out.usage?.thinkingTokens, 1641);
  assert.equal(out.usage?.cacheReadTokens, 12203, "agy spells this cache_read_tokens");
  assert.equal(out.usage?.totalTokens, 6847);
});

// --- pricing ------------------------------------------------------------

test("a dated model snapshot id resolves to its bare price entry", () => {
  const { BUILT_IN_PRICES, lookupPrice } = bridge;
  // Claude Code's modelUsage map reports dated snapshots. A direct lookup misses
  // and the model silently reads as unpriced, which a comparison shows as free.
  assert.ok(lookupPrice(BUILT_IN_PRICES, "anthropic:claude-haiku-4-5-20251001"), "dated id must resolve");
  assert.equal(
    lookupPrice(BUILT_IN_PRICES, "anthropic:claude-haiku-4-5-20251001"),
    lookupPrice(BUILT_IN_PRICES, "anthropic:claude-haiku-4-5"),
    "and resolve to the same entry as the bare id",
  );
  assert.equal(lookupPrice(BUILT_IN_PRICES, "anthropic:not-a-model-20251001"), undefined);
});

test("the cache-write tier reproduces both roles of a measured Claude Code run", () => {
  const { BUILT_IN_PRICES, estimateCostUsd, lookupPrice } = bridge;

  // Both figures below are from one real session. Claude Code puts the main
  // conversation and its subagents in different cache TTL buckets, so a single
  // tier cannot match both: at one tier the orchestrator was 12% out.
  const opus = lookupPrice(BUILT_IN_PRICES, "anthropic:claude-opus-5");
  const opusUsage = { inputTokens: 34, outputTokens: 15321, cacheReadTokens: 617146, cacheWriteTokens: 32378 };
  assert.equal(Number(estimateCostUsd(opusUsage, opus, { cacheTtl: "1h" }).toFixed(4)), 1.0155);

  const haiku = lookupPrice(BUILT_IN_PRICES, "anthropic:claude-haiku-4-5-20251001");
  const haikuUsage = { inputTokens: 1448, outputTokens: 18511, cacheReadTokens: 343247, cacheWriteTokens: 33108 };
  assert.equal(Number(estimateCostUsd(haikuUsage, haiku, { cacheTtl: "5m" }).toFixed(4)), 0.1697);

  // The short tier is the default, so an unaware caller cannot silently get the long one.
  assert.equal(
    estimateCostUsd(opusUsage, opus),
    estimateCostUsd(opusUsage, opus, { cacheTtl: "5m" }),
  );
});

test("Gemini reasoning tokens are not charged on top of output", () => {
  const { BUILT_IN_PRICES, estimateCostUsd, lookupPrice } = bridge;
  const price = lookupPrice(BUILT_IN_PRICES, "antigravity:gemini-3.7-flash-high");
  // A real agy run reports total = input + output with thinking excluded, so the
  // reasoning count is already inside output. Charging it again would inflate cost.
  const withThinking = { inputTokens: 5121, outputTokens: 1726, thinkingTokens: 1641 };
  const withoutThinking = { inputTokens: 5121, outputTokens: 1726 };
  assert.equal(estimateCostUsd(withThinking, price), estimateCostUsd(withoutThinking, price));
});
