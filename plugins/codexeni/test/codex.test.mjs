import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createFakeSpawn, makeRuntime, makeWorkspace, waitFor } from "./helpers.mjs";

const bridge = await import("../dist/index.js");

const SUCCESS_EVENTS = [
  { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
  { type: "item.started", item: { id: "item_command", type: "command_execution", status: "in_progress" } },
  { type: "item.completed", item: { id: "item_command", type: "command_execution", status: "completed", exit_code: 0 } },
  { type: "item.completed", item: { id: "item_message", type: "agent_message", text: JSON.stringify({ status: "completed", summary: "Codex finished the review." }) } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 } },
].map((event) => JSON.stringify(event)).join("\n");

test("command() keeps prompts on stdin and maps each Codex permission mode", () => {
  const adapter = new bridge.CodexAdapter({ executable: "fake-codex", defaultModel: "gpt-test" });
  const readOnly = adapter.command({ prompt: "review", workspace: "w", model: "gpt-test", effort: "high", permissionMode: "full", taskMode: "read_only", outputSchemaPath: "schema.json" });
  assert.deepEqual(readOnly.args, ["exec", "--sandbox", "read-only", "--json", "--model", "gpt-test", "-c", "model_reasoning_effort=high", "--output-schema", "schema.json", "-"]);
  assert.equal(readOnly.stdin, "review");
  assert.ok(!readOnly.args.includes("review"));

  const fullCoding = adapter.command({ prompt: "edit", workspace: "w", effort: "high", permissionMode: "full", taskMode: "coding" });
  assert.ok(fullCoding.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!fullCoding.args.includes("--sandbox"));

  const restrictedCoding = adapter.command({ prompt: "edit", workspace: "w", effort: "high", permissionMode: "restricted", taskMode: "coding" });
  assert.deepEqual(restrictedCoding.args.slice(0, 3), ["exec", "--sandbox", "workspace-write"]);
  assert.equal(restrictedCoding.args.at(-1), "-");

  const resumedReadOnly = adapter.command({ prompt: "continue", workspace: "w", model: "gpt-test", effort: "low", permissionMode: "full", taskMode: "read_only", conversationId: "thread-1" });
  assert.deepEqual(resumedReadOnly.args.slice(0, 5), ["exec", "--sandbox", "read-only", "resume", "thread-1"]);

  const resumedRestrictedCoding = adapter.command({ prompt: "continue", workspace: "w", model: "gpt-test", effort: "low", permissionMode: "restricted", taskMode: "coding", conversationId: "thread-1" });
  assert.deepEqual(resumedRestrictedCoding.args.slice(0, 5), ["exec", "--sandbox", "workspace-write", "resume", "thread-1"]);

  const resumedFullCoding = adapter.command({ prompt: "continue", workspace: "w", model: "gpt-test", effort: "low", permissionMode: "full", taskMode: "coding", conversationId: "thread-1", outputSchemaPath: "schema.json" });
  assert.deepEqual(resumedFullCoding.args.slice(0, 9), ["exec", "--dangerously-bypass-approvals-and-sandbox", "resume", "thread-1", "--json", "--model", "gpt-test", "-c", "model_reasoning_effort=low"]);
  assert.ok(resumedFullCoding.args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("probe() reports CLI state without retaining login output and exposes the static compatible model list", async () => {
  const adapter = new bridge.CodexAdapter({ executable: "fake-codex" });
  const authenticated = await adapter.probe(async (args) => args.includes("login")
    ? { ok: true, stdout: "Logged in as fake@example.com", stderr: "" }
    : { ok: true, stdout: "codex-cli 0.153.2\n", stderr: "" });
  assert.equal(authenticated.authStatus, "authenticated");
  assert.deepEqual(authenticated.models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  assert.equal(authenticated.modelSource, "static");
  assert.ok(!JSON.stringify(authenticated).includes("fake@example.com"));

  const unauthenticated = await adapter.probe(async (args) => args.includes("login")
    ? { ok: false, stdout: "", stderr: "not logged in", error: "not logged in" }
    : { ok: true, stdout: "codex-cli 0.153.2\n", stderr: "" });
  assert.equal(unauthenticated.authStatus, "unauthenticated");
});

test("interpret() reads Codex JSONL thread, tool, structured result, and usage events", () => {
  const adapter = new bridge.CodexAdapter({ executable: "fake-codex" });
  assert.equal(adapter.interpret(JSON.parse(SUCCESS_EVENTS.split("\n")[0])).sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.deepEqual(adapter.interpret(JSON.parse(SUCCESS_EVENTS.split("\n")[1])).toolCalls, [{ name: "command_execution", phase: "started", id: "item_command" }]);
  const message = adapter.interpret(JSON.parse(SUCCESS_EVENTS.split("\n")[3]));
  assert.equal(message.summary, "Codex finished the review.");
  assert.equal(message.workerResult.status, "completed");
  const complete = adapter.interpret(JSON.parse(SUCCESS_EVENTS.split("\n")[4]));
  assert.equal(complete.outcome, "succeeded");
  assert.deepEqual(complete.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, thinkingTokens: 2 });
});

test("runtime creates a private schema and completes a Codex task", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: `${SUCCESS_EVENTS}\n`, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  runtime.registerAdapter(new bridge.CodexAdapter({ executable: "fake-codex" }));
  const started = await runtime.startTask({ task: "review", workspace: root, harness: "codex", model: "gpt-5.6-luna", taskMode: "read_only", maxRetries: 0 });

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.summary, "Codex finished the review.");
    assert.equal(job.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.equal(job.usage.thinkingTokens, 2);
  });

  const schemaPath = calls[0].args[calls[0].args.indexOf("--output-schema") + 1];
  assert.ok(existsSync(schemaPath), "the schema exists while the worker runs");
  assert.ok(calls[0].args.includes("read-only"));
  assert.match(calls[0].stdin, /review/);
  await runtime.shutdown();
});

test("a Codex rate limit opens a circuit for the explicitly selected model", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: `${JSON.stringify({ type: "error", error: { message: "HTTP 429 rate limited" } })}\n`, exitCode: 1 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  runtime.registerAdapter(new bridge.CodexAdapter({ executable: "fake-codex" }));
  const started = await runtime.startTask({ task: "review", workspace: root, harness: "codex", model: "gpt-5.6-luna", taskMode: "read_only", maxRetries: 0 });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "failed"));
  const health = await runtime.discover();
  assert.ok(health.circuitBreakers.some((entry) => entry.key === "codex:gpt-5.6-luna"));
  await runtime.shutdown();
});

test("runtime requires an explicit model before launching a Codex worker", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn();
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const adapter = new bridge.CodexAdapter({ executable: "fake-codex", defaultModel: "gpt-5.6-sol" });
  assert.equal(adapter.requiresExplicitModel, true);
  runtime.registerAdapter(adapter);
  await assert.rejects(
    () => runtime.startTask({ task: "review", workspace: root, harness: "codex", taskMode: "read_only" }),
    { message: "model is required when harness is \"codex\". Choose an exact model from delegate_discover before starting the task." },
  );
  await runtime.shutdown();
});
