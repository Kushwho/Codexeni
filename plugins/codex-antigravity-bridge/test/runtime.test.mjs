import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEscapingLink, createFakeSpawn, makeWorkspace } from "./helpers.mjs";

// The package test command must build first, so consumers exercise its public
// compiled API exactly as Codex does rather than relying on a TypeScript loader.
const bridge = await import("../dist/index.js");

function config(root, overrides = {}) {
  return {
    executable: "fake-agy",
    allowedRoots: [root],
    permissionMode: "restricted",
    defaultModel: "gemini-3.7-flash-high",
    defaultTimeoutSeconds: 1,
    maxConcurrency: 2,
    ...overrides,
  };
}

const stopFakeChild = async (child) => {
  child.kill("SIGTERM");
};

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

test("configuration parsing has safe defaults and a bounded concurrency", () => {
  const resolved = bridge.resolveBridgeConfig({
    AGY_BRIDGE_PERMISSION_MODE: "FULL",
    AGY_BRIDGE_DEFAULT_TIMEOUT_SECONDS: "not-a-number",
    AGY_BRIDGE_MAX_CONCURRENCY: "99",
  });
  assert.equal(resolved.permissionMode, "full");
  assert.equal(resolved.defaultModel, "gemini-3.7-flash-high");
  assert.equal(resolved.defaultTimeoutSeconds, 900);
  assert.equal(resolved.maxConcurrency, 2);
});

test("Agy arguments retain hostile task text as one prompt argument", () => {
  const hostileTask = "fix it --dangerously-skip-permissions; echo owned $(whoami)";
  const args = bridge.buildAgyArgs({
    task: hostileTask,
    model: "gemini-3.7-flash-high",
    effort: "high",
    permissionMode: "restricted",
  });
  assert.deepEqual(args, [
    "--model", "gemini-3.7-flash-high",
    "--output-format", "stream-json",
    "--effort", "high",
    "--sandbox",
    "--prompt", hostileTask,
  ]);
  assert.equal(args.filter((arg) => arg === hostileTask).length, 1);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(bridge.buildAgyArgs({ task: "x", model: "m", effort: "low", permissionMode: "full" }).includes("--dangerously-skip-permissions"));
});

test("workspace guard rejects traversal, prefix tricks, and escaping symlinks", async (t) => {
  const { root, nested } = await makeWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "codex-antigravity-outside-"));
  const guard = new bridge.WorkspaceGuard([root]);
  assert.equal(await guard.assertAllowed(nested), await bridge.canonicalizeWorkspace(nested));
  assert.equal(bridge.isPathWithinRoot(join(root, "safe-other"), root), true);
  assert.equal(bridge.isPathWithinRoot(`${root}-other`, root), false);
  await assert.rejects(() => guard.assertAllowed(join(root, "..", outside.split(/[\\/]/).at(-1))), /outside/);

  const link = join(root, "escape-link");
  if (!(await createEscapingLink(link, outside))) {
    t.skip("This Windows environment does not permit creating test symlinks.");
    return;
  }
  await assert.rejects(() => guard.assertAllowed(link), /outside/);
});

test("NDJSON preserves success events and captures malformed output", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  assert.equal(bridge.parseNdjsonLine("   ", timestamp), undefined);
  assert.deepEqual(bridge.parseNdjsonLine('{"type":"result","conversation_id":"abc"}', timestamp), {
    timestamp,
    type: "result",
    data: { type: "result", conversation_id: "abc" },
  });
  assert.deepEqual(bridge.parseNdjsonLine("not-json", timestamp), {
    timestamp,
    type: "unparsed_output",
    data: "not-json",
  });
});

test("delegation prompt pins the worker to its selected workspace", () => {
  const prompt = bridge.buildDelegationPrompt("fix the tests", "C:\\safe\\fixture");
  assert.match(prompt, /workspace is exactly: C:\\safe\\fixture/);
  assert.match(prompt, /Do not search, read, write, or run commands outside/);
  assert.match(prompt, /TASK:\nfix the tests/);
});

test("runtime launches without a shell, parses output, redacts errors, and reports changes", async () => {
  const { root } = await makeWorkspace();
  await writeFile(join(root, "created.txt"), "before", "utf8");
  const { spawnImpl, calls } = createFakeSpawn([{
    stdout: '{"type":"message","content":"done","conversation_id":"conversation-1","usage":{"output_tokens":5}}\nnot-json\n',
    stderr: "authorization: very-secret-token api_key=another-secret\n",
    exitCode: 17,
  }]);
  const runtime = new bridge.AgyBridgeRuntime({ config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomUUIDImpl: () => "00000000-0000-4000-8000-000000000001" });
  const started = await runtime.startTask({ task: "fix --not-a-shell-flag", workspace: root });
  assert.equal(started.status, "running");
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /fix --not-a-shell-flag/);
  assert.match(calls[0].args.at(-1), new RegExp(root.replaceAll("\\", "\\\\")));
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.conversationId, "conversation-1");
    assert.equal(job.response, "done");
    assert.equal(job.events.at(-1).type, "unparsed_output");
    assert.match(job.stderrSummary, /\[redacted\]/i);
    assert.doesNotMatch(job.stderrSummary, /very-secret-token|another-secret/);
    return job;
  });
});

test("Antigravity terminal ERROR wins over a zero process exit", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stdout: '{"event":"result","result":{"conversation_id":"conversation-error","status":"ERROR","response":"partial output"}}\n',
    exitCode: 0,
  }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomUUIDImpl: () => "00000000-0000-4000-8000-000000000099",
  });
  const started = await runtime.startTask({ task: "fails upstream", workspace: root });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.upstreamStatus, "ERROR");
    assert.match(job.stderrSummary, /terminal status ERROR/);
  });
});

test("structured stdout and temporary logs redact sensitive fields", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stdout: '{"event":"result","authorization":"Bearer exposed","result":{"status":"SUCCESS","response":"authorization=hidden","api_key":"also-hidden"}}\n',
    exitCode: 0,
  }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomUUIDImpl: () => "00000000-0000-4000-8000-000000000098",
  });
  const started = await runtime.startTask({ task: "safe output", workspace: root });
  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "succeeded");
    assert.equal(current.events[0].data.authorization, "[redacted]");
    assert.equal(current.events[0].data.result.api_key, "[redacted]");
    assert.doesNotMatch(current.response, /hidden/);
    return current;
  });
  await waitFor(async () => {
    const log = await readFile(job.logPath, "utf8");
    assert.doesNotMatch(log, /Bearer exposed|also-hidden|authorization=hidden/);
  });
});

test("runtime enforces concurrency, warns same-workspace writers, and supports cancellation", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ close: false }, { close: false }]);
  let sequence = 0;
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomUUIDImpl: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const first = await runtime.startTask({ task: "one", workspace: root });
  const second = await runtime.startTask({ task: "two", workspace: root });
  assert.deepEqual(second.warnings, ["Another Antigravity job is already writing to this workspace; changes may overlap."]);
  await assert.rejects(() => runtime.startTask({ task: "three", workspace: root }), /Maximum concurrency/);
  const canceled = await runtime.cancelTask(first.jobId);
  assert.equal(canceled.canceled, true);
  calls[0].child.exitCode = null;
  calls[0].child.emit("close", null, "SIGTERM");
  await waitFor(() => assert.equal(runtime.getTask(first.jobId).status, "canceled"));
  calls[1].child.exitCode = null;
  calls[1].child.emit("close", null, "SIGTERM");
  await runtime.shutdown();
});

test("runtime marks a task timed out when its deadline expires", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root, { defaultTimeoutSeconds: 1 }),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomUUIDImpl: () => "00000000-0000-4000-8000-000000000009",
  });
  const started = await runtime.startTask({ task: "slow", workspace: root, timeoutSeconds: 1 });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "timed_out"), 1_500);
});
