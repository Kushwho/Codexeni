import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createEscapingLink, createFakeSpawn, createManualTimers, makeWorkspace, writeOnSpawn } from "./helpers.mjs";

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
    maxConcurrency: 4,
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
  assert.equal(resolved.maxConcurrency, 4);
});

test("MCP file-root parsing accepts local roots only and handles Windows file URIs", async () => {
  const { root } = await makeWorkspace();
  const uri = pathToFileURL(root).href;
  assert.equal(bridge.fileUriToLocalPath(uri), root);
  assert.equal(bridge.fileUriToLocalPath("https://example.com/workspace"), undefined);
  assert.equal(bridge.fileUriToLocalPath("file://remote-host/workspace"), undefined);
  assert.equal(bridge.fileUriToLocalPath("not a uri"), undefined);
  const windowsPath = bridge.fileUriToLocalPath("file:///C:/Bridge%20Root");
  assert.equal(windowsPath, process.platform === "win32" ? "C:\\Bridge Root" : "/C:/Bridge Root");

  const roots = await bridge.canonicalizeMcpClientRoots([
    uri,
    uri,
    uri.replace("file:///", "file://localhost/"),
    "https://example.com/not-local",
    "file://remote-host/not-local",
    "file:///this-path-does-not-exist",
  ]);
  assert.deepEqual(roots, [await bridge.canonicalizeWorkspace(root)]);
});

test("explicit allowed roots override MCP roots; empty and unsupported MCP roots fail closed", async () => {
  const envWorkspace = await makeWorkspace();
  const clientWorkspace = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const explicitRuntime = new bridge.AgyBridgeRuntime({
    config: config(envWorkspace.root), spawnImpl, stopChildImpl: stopFakeChild,
  });
  assert.deepEqual(await explicitRuntime.adoptMcpClientRoots([pathToFileURL(clientWorkspace.root).href]), [envWorkspace.root]);
  assert.equal(explicitRuntime.getAllowedRootSource(), "environment");
  await assert.rejects(
    () => explicitRuntime.startTask({ task: "outside explicit root", workspace: clientWorkspace.root }),
    /outside/,
  );
  await explicitRuntime.shutdown();

  const unsetRuntime = new bridge.AgyBridgeRuntime({ config: config(envWorkspace.root, { allowedRoots: [] }) });
  await unsetRuntime.adoptMcpClientRoots(["https://example.com/root", "file://remote-host/root", "file:///missing-root"]);
  assert.equal(unsetRuntime.getAllowedRootSource(), "unconfigured");
  await assert.rejects(
    () => unsetRuntime.startTask({ task: "must fail closed", workspace: envWorkspace.root }),
    /allowed workspace roots|ALLOWED_ROOTS/i,
  );
});

test("refreshMcpClientRoots adopts and refreshes dynamic client roots while reporting their source", async () => {
  const first = await makeWorkspace();
  const second = await makeWorkspace();
  let advertised = [pathToFileURL(first.root).href];
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: "agy fixture\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
    { close: false },
  ]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(first.root, { allowedRoots: [] }), spawnImpl, stopChildImpl: stopFakeChild,
  });
  const provider = { listRoots: async () => ({ roots: advertised.map((uri) => ({ uri })) }) };
  assert.deepEqual(await bridge.refreshMcpClientRoots(runtime, provider), [await bridge.canonicalizeWorkspace(first.root)]);
  assert.equal(runtime.getAllowedRootSource(), "mcp_client");
  const health = await runtime.health();
  assert.equal(health.allowedRootSource, "mcp_client");
  advertised = [pathToFileURL(second.root).href];
  await bridge.refreshMcpClientRoots(runtime, provider);
  await assert.rejects(() => runtime.startTask({ task: "old root", workspace: first.root }), /outside/);
  const started = await runtime.startTask({ task: "new root", workspace: second.root });
  assert.equal(started.workspace, await bridge.canonicalizeWorkspace(second.root));
  await runtime.shutdown();
  assert.equal(calls.length, 3);
});

test("MCP roots/list is ready before the first task and roots/list_changed refreshes it", async () => {
  const first = await makeWorkspace();
  const second = await makeWorkspace();
  let advertised = [pathToFileURL(first.root).href];
  const { spawnImpl, calls } = createFakeSpawn([{ close: false }, { close: false }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(first.root, { allowedRoots: [] }), spawnImpl, stopChildImpl: stopFakeChild,
  });
  const server = bridge.createMcpServer(runtime);
  const client = new Client(
    { name: "bridge-roots-test", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: advertised.map((uri) => ({ uri })) }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // No polling is allowed here: the first task must see the roots returned by
  // the initialization-time standard roots/list request.
  const firstTask = await runtime.startTask({ task: "first task", workspace: first.root });
  assert.equal(firstTask.workspace, await bridge.canonicalizeWorkspace(first.root));
  assert.equal(runtime.getAllowedRootSource(), "mcp_client");
  calls[0].child.emit("close", 0, null);
  await waitFor(() => assert.equal(runtime.getTask(firstTask.jobId).status, "failed"));

  advertised = [pathToFileURL(second.root).href];
  await client.sendRootsListChanged();
  await waitFor(() => assert.equal(runtime.getAllowedRootSource(), "mcp_client"));
  await waitFor(() => assert.rejects(() => runtime.startTask({ task: "stale root", workspace: first.root }), /outside/));
  const secondTask = await runtime.startTask({ task: "refreshed root", workspace: second.root });
  assert.equal(secondTask.workspace, await bridge.canonicalizeWorkspace(second.root));
  await client.close();
  await server.close();
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
  const outside = await mkdtemp(join(tmpdir(), "codexeni-outside-"));
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

test("provider failures are classified without relying on one CLI event shape", () => {
  assert.equal(bridge.classifyFailure("HTTP 429 too many requests"), "rate_limited");
  assert.equal(bridge.classifyFailure({ error: "RESOURCE_EXHAUSTED: quota exceeded" }), "quota_exhausted");
  assert.equal(bridge.classifyFailure("quota exhausted; out of credits"), "quota_exhausted");
  assert.equal(bridge.classifyFailure("session limit reached"), "session_limit");
  assert.equal(bridge.classifyFailure("maximum context window token limit"), "context_limit");
  assert.equal(bridge.classifyFailure("login required: session expired"), "authentication");
  assert.equal(bridge.classifyFailure("unexpected error"), undefined);
});

test("provider retry-after parsing handles seconds, milliseconds, and reset dates", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(bridge.parseRetryAfterMs("retry-after: 1.5 seconds", now), 1_500);
  assert.equal(bridge.parseRetryAfterMs("retry-after_ms=250", now), 250);
  assert.equal(bridge.parseRetryAfterMs({ error: { retry_after: 2 } }, now), 2_000);
  assert.equal(bridge.parseRetryAfterMs({ error: { retry_after_ms: 750 } }, now), 750);
  assert.equal(bridge.parseRetryAfterMs("reset_at=2026-01-01T00:00:02.000Z", now), 2_000);
  assert.equal(bridge.parseRetryAfterMs("Retry-After: Thu, 01 Jan 2026 00:00:05 GMT", now), 5_000);
  assert.equal(bridge.parseRetryAfterMs("no retry hint", now), undefined);
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

test("runtime enforces the four-job ceiling, warns same-workspace writers, and supports cancellation", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ close: false }, { close: false }, { close: false }, { close: false }]);
  let sequence = 0;
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomUUIDImpl: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const first = await runtime.startTask({ task: "one", workspace: root });
  const second = await runtime.startTask({ task: "two", workspace: root });
  await runtime.startTask({ task: "three", workspace: root });
  await runtime.startTask({ task: "four", workspace: root });
  assert.deepEqual(second.warnings, ["Another Antigravity job is already writing to this workspace; changes may overlap."]);
  await assert.rejects(() => runtime.startTask({ task: "five", workspace: root }), /Maximum concurrency/);
  const canceled = await runtime.cancelTask(first.jobId);
  assert.equal(canceled.canceled, true);
  calls[0].child.exitCode = null;
  calls[0].child.emit("close", null, "SIGTERM");
  await waitFor(() => assert.equal(runtime.getTask(first.jobId).status, "canceled"));
  calls[1].child.exitCode = null;
  calls[1].child.emit("close", null, "SIGTERM");
  calls[2].child.exitCode = null;
  calls[2].child.emit("close", null, "SIGTERM");
  calls[3].child.exitCode = null;
  calls[3].child.emit("close", null, "SIGTERM");
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

test("a read-only retry starts with a clean lifecycle after timeout", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([
    { close: false },
    { stdout: '{"event":"result","result":{"status":"SUCCESS","response":"recovered"}}\n', exitCode: 0 },
  ]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root, { defaultTimeoutSeconds: 1 }), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "read-only timeout", workspace: root, taskMode: "read_only", maxRetries: 1, timeoutSeconds: 1 });
  timers.runNext((timer) => timer.delay === 1_000);
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "queued"));
  timers.runNext((timer) => timer.delay === 15_000);
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.response, "recovered");
    assert.equal(job.signal, null);
  });
  assert.equal(calls.length, 2);
});

test("task mode and read-only retry limits are validated and coding always has zero retries", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const runtime = new bridge.AgyBridgeRuntime({ config: config(root), spawnImpl, stopChildImpl: stopFakeChild });
  await assert.rejects(() => runtime.startTask({ task: "bad mode", workspace: root, taskMode: "anything_else" }), /taskMode/);
  await assert.rejects(() => runtime.startTask({ task: "too many", workspace: root, taskMode: "read_only", maxRetries: 3 }), /maxRetries/);
  const started = await runtime.startTask({ task: "coding", workspace: root, taskMode: "coding", maxRetries: 2 });
  assert.equal(started.taskMode, "coding");
  assert.equal(started.maxRetries, 0);
  await runtime.shutdown();
});

test("a read-only quota error retries a fresh child and honors bounded retry-after", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([
    { stderr: "HTTP 429 rate limit; retry-after: 1 seconds\n", exitCode: 1 },
    { stdout: '{"event":"result","result":{"status":"SUCCESS","response":"review complete"}}\n', exitCode: 0 },
  ]);
  let sequence = 0;
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root),
    spawnImpl,
    stopChildImpl: stopFakeChild,
    randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    randomUUIDImpl: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const started = await runtime.startTask({ task: "inspect only", workspace: root, taskMode: "read_only", maxRetries: 1 });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "queued");
    assert.equal(job.errorCategory, "rate_limited");
    assert.equal(job.retryCount, 1);
    assert.ok(job.nextRetryAt);
  });
  const retryTimer = timers.pending().find((timer) => timer.delay < 900_000);
  assert.ok(retryTimer, "a retry timer should be scheduled separately from the task timeout");
  assert.equal(retryTimer.delay, 1_000, "a bounded provider retry-after should be honored exactly");
  timers.runNext((timer) => timer === retryTimer);
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.retryCount, 1);
    assert.equal(job.model, "gemini-3.7-flash-high");
    assert.equal(job.errorCategory, undefined, "a successful fresh attempt must not retain the earlier 429 classification");
    assert.equal(job.nextRetryAt, undefined);
    assert.equal(job.hasPartialChanges, false, "successful changes are reported as fileChanges, not partialChanges");
  });
  assert.equal(runtime.breakers.size, 0, "a successful retry proves capacity and closes the model circuit");
  assert.equal(calls.length, 2, "a retry must use a fresh agy child process");
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "gemini-3.7-flash-high");
  assert.equal(calls[1].args[calls[1].args.indexOf("--model") + 1], "gemini-3.7-flash-high");
});

test("coding does not retry a retryable provider failure", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([{ stderr: "429 rate limit; retry-after: 1\n", exitCode: 1 }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "change code", workspace: root, taskMode: "coding", maxRetries: 2 });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCategory, "rate_limited");
    assert.equal(job.retryCount, 0);
    assert.equal(job.retryable, false);
  });
  assert.equal(calls.length, 1);
  assert.equal(timers.pending().filter((timer) => timer.delay < 900_000).length, 0);
});

test("a context-limit failure is classified but not replayed with the same prompt", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([{ stderr: "maximum context window exceeded\n", exitCode: 1 }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "oversized review", workspace: root, taskMode: "read_only", maxRetries: 2 });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCategory, "context_limit");
    assert.equal(job.retryable, false);
  });
  assert.equal(calls.length, 1);
  assert.equal(timers.pending().filter((timer) => timer.delay < 900_000).length, 0);
});

test("a provider retry-after beyond the safety cap is reported but never scheduled", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([{ stderr: "429 rate limit retry-after: 999999 seconds\n", exitCode: 1 }]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "inspect", workspace: root, taskMode: "read_only", maxRetries: 2 });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.retryable, false);
    assert.ok(job.nextRetryAt);
    assert.match(job.warnings.join("\n"), /exceeds five minutes/i);
  });
  assert.equal(calls.length, 1);
  assert.equal(timers.pending().filter((timer) => timer.delay < 900_000).length, 0);
});

test("read-only retries stop at two attempts and never retry after workspace changes", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([
    { stderr: "429 rate limit retry-after: 0\n", exitCode: 1 },
    { stderr: "429 rate limit retry-after: 0\n", exitCode: 1 },
    { stderr: "429 rate limit retry-after: 0\n", exitCode: 1 },
  ]);
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "review", workspace: root, taskMode: "read_only", maxRetries: 2 });
  for (let retry = 1; retry <= 2; retry += 1) {
    await waitFor(() => assert.equal(runtime.getTask(started.jobId).retryCount, retry));
    timers.runNext((timer) => timer.delay < 900_000);
  }
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.retryCount, 2);
  });
  assert.equal(calls.length, 3);

  const changedWorkspace = await makeWorkspace();
  const changedTimers = createManualTimers();
  const changed = createFakeSpawn([{
    stderr: "429 rate limit retry-after: 0\n",
    exitCode: 1,
    onSpawn: writeOnSpawn(join(changedWorkspace.root, "unexpected-change.txt"), "changed"),
  }]);
  const changedRuntime = new bridge.AgyBridgeRuntime({
    config: config(changedWorkspace.root), spawnImpl: changed.spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    setTimeoutImpl: changedTimers.setTimeoutImpl, clearTimeoutImpl: changedTimers.clearTimeoutImpl,
  });
  const changedStart = await changedRuntime.startTask({ task: "read only", workspace: changedWorkspace.root, taskMode: "read_only", maxRetries: 2 });
  await waitFor(() => {
    const job = changedRuntime.getTask(changedStart.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.hasPartialChanges, true);
    assert.deepEqual(job.partialChanges.created, ["unexpected-change.txt"]);
  });
  assert.equal(changed.calls.length, 1, "workspace mutations must suppress retries");
});

test("an open same-model quota circuit is visible in health and blocks new starts without fallback", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([
    { stderr: "quota exhausted: out of credits\n", exitCode: 1 },
    { stdout: "agy test version\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
  ]);
  let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  const runtime = new bridge.AgyBridgeRuntime({
    config: config(root), spawnImpl, stopChildImpl: stopFakeChild, randomImpl: () => 0,
    now: () => new Date(milliseconds),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "coding quota failure", workspace: root, taskMode: "coding", model: "gemini-3.7-flash-high" });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.ok(job.blockedUntil, "the completed failure must open a model circuit");
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => runtime.startTask({ task: "must not fallback", workspace: root, taskMode: "coding", model: "gemini-3.7-flash-high" }),
    /circuit|quota|blocked/i,
  );
  assert.equal(calls.length, 1, "a circuit rejection must not spawn a replacement model");
  const health = await runtime.health();
  assert.equal(health.circuitBreakers.length, 1);
  assert.equal(health.circuitBreakers[0].model, "gemini-3.7-flash-high");
  assert.ok(Date.parse(health.circuitBreakers[0].blockedUntil) > milliseconds);
  milliseconds += bridge.CIRCUIT_BREAKER_MS + 1;
  await runtime.startTask({ task: "circuit expired", workspace: root, taskMode: "coding", model: "gemini-3.7-flash-high" });
});
