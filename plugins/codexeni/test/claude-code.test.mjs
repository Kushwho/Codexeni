import assert from "node:assert/strict";
import test from "node:test";

import { createFakeSpawn, makeRuntime, makeWorkspace } from "./helpers.mjs";

// The package test command must build first, so consumers exercise its public
// compiled API exactly as Codex does rather than relying on a TypeScript loader.
const bridge = await import("../dist/index.js");

async function waitFor(assertion, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError ?? new Error("Condition did not become true");
}

const SUCCESS_INIT = {
  type: "system",
  subtype: "init",
  cwd: "C:\\fake\\workspace",
  session_id: "fake-claude-session",
  model: "claude-haiku-4-5-20251001",
  permissionMode: "default",
  claude_code_version: "2.1.251",
};

const SUCCESS_ASSISTANT = {
  type: "assistant",
  message: {
    model: "claude-haiku-4-5-20251001",
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 9713, cache_read_input_tokens: 0, output_tokens: 4 },
  },
  session_id: "fake-claude-session",
};

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1384,
  num_turns: 1,
  result: "OK",
  session_id: "fake-claude-session",
  total_cost_usd: 0.020623,
  usage: { input_tokens: 10, cache_creation_input_tokens: 9713, cache_read_input_tokens: 0, output_tokens: 46 },
  permission_denials: [],
};

const SUCCESS_STDOUT = [SUCCESS_INIT, SUCCESS_ASSISTANT, SUCCESS_RESULT].map((event) => JSON.stringify(event)).join("\n");

test("command() sets read-only flags identically across permission modes, coding flags per mode, and defaults the model", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
  const prompt = "fix it --dangerously-skip-permissions; echo owned $(whoami)";

  for (const permissionMode of ["full", "restricted"]) {
    const spec = adapter.command({ prompt, workspace: "C:\\safe\\fixture", model: "opus", effort: "high", permissionMode, taskMode: "read_only" });
    assert.equal(spec.command, "fake-claude");
    assert.equal(spec.cwd, "C:\\safe\\fixture");
    assert.equal(spec.stdin, prompt);
    assert.ok(!spec.args.includes(prompt), "the prompt must travel over stdin, not argv");
    assert.deepEqual(spec.args, [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "opus",
      "--effort", "high",
      "--permission-mode", "dontAsk",
      "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit",
    ]);
    assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
  }

  const codingFull = adapter.command({ prompt, workspace: "w", model: "opus", effort: "low", permissionMode: "full", taskMode: "coding" });
  assert.ok(codingFull.args.includes("--dangerously-skip-permissions"));
  assert.ok(!codingFull.args.includes("--permission-mode"));

  const codingRestricted = adapter.command({ prompt, workspace: "w", model: "opus", effort: "low", permissionMode: "restricted", taskMode: "coding" });
  assert.equal(codingRestricted.args[codingRestricted.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!codingRestricted.args.includes("--dangerously-skip-permissions"));

  const defaultModelSpec = adapter.command({ prompt: "x", workspace: "w", effort: "high", permissionMode: "full", taskMode: "coding" });
  assert.equal(defaultModelSpec.args[defaultModelSpec.args.indexOf("--model") + 1], "sonnet");
});

test("interpret() reads session id, summary, usage, and outcome from init/assistant/result events", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });

  assert.equal(adapter.interpret(SUCCESS_INIT).sessionId, "fake-claude-session");

  const assistantFields = adapter.interpret(SUCCESS_ASSISTANT);
  assert.equal(assistantFields.summary, "OK");

  const resultFields = adapter.interpret(SUCCESS_RESULT);
  assert.equal(resultFields.summary, "OK");
  assert.equal(resultFields.outcome, "succeeded");
  assert.deepEqual(resultFields.usage, {
    inputTokens: 10,
    outputTokens: 46,
    cacheReadTokens: 0,
    cacheWriteTokens: 9713,
    costUsd: 0.020623,
  });

  const errorResult = { ...SUCCESS_RESULT, subtype: "error_during_execution", is_error: true, result: "Fake failure" };
  const errorFields = adapter.interpret(errorResult);
  assert.equal(errorFields.outcome, "failed");
  assert.match(errorFields.detail, /error_during_execution/);

  assert.deepEqual(adapter.interpret({ type: "rate_limit_event" }), {});
});

test("probe() reports install/version/auth/model state without ever leaking the account email", async () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });

  const authenticated = await adapter.probe(async (args) => {
    if (args[0] === "--version") return { ok: true, stdout: "2.1.251 (Claude Code)\n", stderr: "" };
    return { ok: true, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"fake@example.com"}\n', stderr: "" };
  });
  assert.equal(authenticated.installed, true);
  assert.equal(authenticated.version, "2.1.251 (Claude Code)");
  assert.equal(authenticated.authStatus, "authenticated");
  assert.deepEqual(authenticated.models, ["fable", "opus", "sonnet", "haiku"]);
  assert.equal(authenticated.modelSource, "static");
  assert.ok(!JSON.stringify(authenticated).includes("fake@example.com"));

  const unauthenticated = await adapter.probe(async (args) => {
    if (args[0] === "--version") return { ok: true, stdout: "2.1.251 (Claude Code)\n", stderr: "" };
    return { ok: true, stdout: '{"loggedIn":false}\n', stderr: "" };
  });
  assert.equal(unauthenticated.authStatus, "unauthenticated");
  assert.ok(!JSON.stringify(unauthenticated).includes("fake@example.com"));

  const notInstalled = await adapter.probe(async () => ({ ok: false, stdout: "", stderr: "not found", error: "not found" }));
  assert.equal(notInstalled.installed, false);
  assert.equal(notInstalled.authStatus, "unavailable");
  assert.ok(!JSON.stringify(notInstalled).includes("fake@example.com"));

  const malformedAuth = await adapter.probe(async (args) => {
    if (args[0] === "--version") return { ok: true, stdout: "2.1.251 (Claude Code)\n", stderr: "" };
    return { ok: true, stdout: "not json", stderr: "" };
  });
  assert.equal(malformedAuth.authStatus, "unknown");
  assert.ok(malformedAuth.error);
  assert.ok(!JSON.stringify(malformedAuth).includes("fake@example.com"));
});

test("classifyFailure() prefers the named api_retry error before falling back to text matching", () => {
  const adapter = new bridge.ClaudeCodeAdapter({ executable: "fake-claude" });
  assert.equal(adapter.classifyFailure([{ type: "system", subtype: "api_retry", error: "rate_limit" }]), "rate_limited");
  assert.equal(adapter.classifyFailure([{ type: "system", subtype: "api_retry", error: "billing_error" }]), "quota_exhausted");
  assert.equal(adapter.classifyFailure([{ type: "system", subtype: "api_retry", error: "authentication_failed" }]), "authentication");
  assert.equal(adapter.classifyFailure([{ type: "system", subtype: "api_retry", error: "overloaded" }]), "upstream_error");
  assert.equal(adapter.classifyFailure("context window exceeded"), "context_limit");
});

test("resolveBridgeConfig maps BRIDGE_CLAUDE_CODE_* into the claude-code harness settings", () => {
  const config = bridge.resolveBridgeConfig({ BRIDGE_CLAUDE_CODE_PATH: "/x/claude", BRIDGE_CLAUDE_CODE_MODEL: "haiku" });
  assert.deepEqual(config.harnesses["claude-code"], { executable: "/x/claude", defaultModel: "haiku" });
});

test("runtime end to end: claude-code prompt travels over stdin and a successful run is interpreted", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: `${SUCCESS_STDOUT}\n`, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "say OK", workspace: root, harness: "claude-code", taskMode: "read_only" });
  assert.equal(started.harness, "claude-code");

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.summary, "OK");
    assert.equal(job.usage.costUsd, 0.020623);
    assert.equal(job.sessionId, "fake-claude-session");
    assert.equal(job.harness, "claude-code");
  });

  assert.equal(calls[0].command, "fake-claude");
  assert.equal(calls[0].options.stdio[0], "pipe");
  assert.ok(!calls[0].args.some((arg) => arg.includes("say OK")), "the prompt must not appear in argv");
  await waitFor(() => assert.match(calls[0].stdin, /say OK/));
  await runtime.shutdown();
});

test("runtime end to end: a rate-limited claude-code failure opens the claude-code:sonnet circuit", async () => {
  const { root } = await makeWorkspace();
  const rateLimitStdout = [
    SUCCESS_INIT,
    { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 429, error: "rate_limit", session_id: "fake-claude-session" },
    { ...SUCCESS_RESULT, subtype: "error_during_execution", is_error: true, result: "rate limited" },
  ].map((event) => JSON.stringify(event)).join("\n");
  const { spawnImpl } = createFakeSpawn([{ stdout: `${rateLimitStdout}\n`, exitCode: 1 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "will be rate limited", workspace: root, harness: "claude-code" });

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCategory, "rate_limited");
  });

  const health = await runtime.discover();
  const breaker = health.circuitBreakers.find((entry) => entry.key === "claude-code:sonnet");
  assert.ok(breaker, "a circuit breaker keyed claude-code:sonnet must be open");
  await runtime.shutdown();
});

test("discover() lists both harnesses while antigravity stays the default, and an unnamed task still runs fake-agy", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{}, {}, {}, {}, { close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const health = await runtime.discover();
  assert.deepEqual(Object.keys(health.harnesses).sort(), ["antigravity", "claude-code"]);
  assert.equal(health.defaultHarness, "antigravity");

  const started = await runtime.startTask({ task: "use the default harness", workspace: root });
  assert.equal(started.harness, "antigravity");
  assert.equal(calls.at(-1).command, "fake-agy");
  await runtime.shutdown();
});
