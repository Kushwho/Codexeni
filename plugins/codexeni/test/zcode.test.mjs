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

// The exact envelope shape a real `zcode --json --prompt` prints on success: one
// pretty-printed JSON document, never valid per line, which is why interpretBuffer exists.
const SUCCESS_ENVELOPE = JSON.stringify(
  {
    sessionId: "sess_f32cdea1-81b9-4140-91cc-c782d4469ac2",
    traceId: "bd5da687-a297-43e3-981b-f7eeecc1e241",
    turnId: "turn_2a2cb83a-36ba-4835-a74d-4d6fcde1a3b9",
    response: "OK",
    usage: {
      source: "provider",
      modelRequestCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      webFetchRequests: 0,
      webSearchRequests: 0,
    },
    eventCount: 11,
    projection: { status: "idle", turnCount: 1, totalTokenCount: 15, contextUsed: 15, contextWindow: 200000 },
  },
  null,
  2,
);

test("command() maps task and permission modes onto --mode, strips mutation tools for read-only, and passes the prompt over argv", () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });
  const prompt = "fix it; rm -rf /";

  const readOnly = adapter.command({ prompt, workspace: "C:\\safe\\fixture", model: "glm-5.3-flash", effort: "high", permissionMode: "full", taskMode: "read_only" });
  assert.equal(readOnly.command, "fake-zcode");
  assert.equal(readOnly.cwd, "C:\\safe\\fixture");
  assert.equal(readOnly.stdin, undefined);
  assert.deepEqual(readOnly.args, [
    "--json",
    "--mode", "plan",
    "--disallowed-tools", "Edit,Write,SendMessage",
    "--prompt", prompt,
  ]);

  const codingFull = adapter.command({ prompt, workspace: "w", effort: "low", permissionMode: "full", taskMode: "coding" });
  assert.deepEqual(codingFull.args, ["--json", "--mode", "yolo", "--prompt", prompt]);

  const codingRestricted = adapter.command({ prompt, workspace: "w", effort: "low", permissionMode: "restricted", taskMode: "coding" });
  assert.deepEqual(codingRestricted.args, ["--json", "--mode", "edit", "--prompt", prompt]);
});

test("command() resumes a reported session with --resume", () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });
  const spec = adapter.command({ prompt: "continue", workspace: "w", effort: "high", permissionMode: "full", taskMode: "coding", conversationId: "sess_abc" });
  assert.deepEqual(spec.args, ["--json", "--mode", "yolo", "--resume", "sess_abc", "--prompt", "continue"]);
});

test("a .js executable is spawned through the current Node on every invocation", async () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "C:/tools/zcode.js" });
  const spec = adapter.command({ prompt: "x", workspace: "w", effort: "high", permissionMode: "full", taskMode: "coding" });
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args[0], "C:/tools/zcode.js");

  const seenArgs = [];
  await adapter.probe(async (args) => {
    seenArgs.push(args);
    return { ok: true, stdout: "zcode-app-cli 3.11.2-19\nzcode-runtime 0.16.5\n", stderr: "" };
  });
  assert.deepEqual(seenArgs[0], ["C:/tools/zcode.js", "--version"]);
});

test("probe() reports install and static models, and never claims an auth state it cannot check", async () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });

  const installed = await adapter.probe(async () => ({ ok: true, stdout: "zcode-app-cli 3.11.2-19\nzcode-runtime 0.16.5\n", stderr: "" }));
  assert.equal(installed.installed, true);
  assert.equal(installed.version, "zcode-app-cli 3.11.2-19\nzcode-runtime 0.16.5");
  assert.equal(installed.authStatus, "unknown");
  assert.deepEqual(installed.models, ["glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo"]);
  assert.equal(installed.modelSource, "static");
  assert.equal(installed.error, undefined);

  const missing = await adapter.probe(async () => ({ ok: false, stdout: "", stderr: "not found", error: "not found" }));
  assert.equal(missing.installed, false);
  assert.equal(missing.authStatus, "unavailable");
  assert.deepEqual(missing.models, []);
  assert.equal(missing.error, "not found");
});

test("resolveSelection() leaves the default alone and warns when a caller-requested model cannot be applied", () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });
  assert.deepEqual(adapter.resolveSelection(undefined, "high"), {});
  const warned = adapter.resolveSelection("glm-5.3", "high");
  assert.equal(warned.model, "glm-5.3");
  assert.match(warned.warning, /model\.main/);
  assert.match(warned.warning, /glm-5\.3/);
});

test("interpretBuffer() reads session, summary, usage, and turn count from the success envelope, and nothing from noise", () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });

  const fields = adapter.interpretBuffer(`${SUCCESS_ENVELOPE}\n`);
  assert.equal(fields.sessionId, "sess_f32cdea1-81b9-4140-91cc-c782d4469ac2");
  assert.equal(fields.summary, "OK");
  assert.equal(fields.outcome, "succeeded");
  assert.equal(fields.turns, 1);
  assert.deepEqual(fields.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 2,
    totalTokens: 15,
  });

  assert.deepEqual(adapter.interpretBuffer(""), {});
  assert.deepEqual(adapter.interpretBuffer("   \n  "), {});
  assert.deepEqual(adapter.interpretBuffer("ProviderBusinessError: no json here"), {});
  assert.deepEqual(adapter.interpretBuffer("null"), {});
});

test("classifyFailure() maps ZCode provider errors before falling back to shared text matching", () => {
  const adapter = new bridge.ZcodeAdapter({ executable: "fake-zcode" });
  assert.equal(
    adapter.classifyFailure(["ProviderBusinessError: [1113][Insufficient balance or no resource package. Please recharge.]"]),
    "quota_exhausted",
  );
  assert.equal(adapter.classifyFailure(["AI_APICallError [AI_APICallError]: Unauthorized"]), "authentication");
  assert.equal(adapter.classifyFailure(["ProviderBusinessError: captcha verify failed"]), "upstream_error");
  assert.equal(adapter.classifyFailure(["prompt is too long"]), "context_limit");
});

test("resolveBridgeConfig maps BRIDGE_ZCODE_* into the zcode harness settings", () => {
  const config = bridge.resolveBridgeConfig({ BRIDGE_ZCODE_PATH: "/x/zcode.js", BRIDGE_ZCODE_MODEL: "glm-5.3" });
  assert.deepEqual(config.harnesses["zcode"], { executable: "/x/zcode.js", defaultModel: "glm-5.3" });
});

test("runtime end to end: the pretty-printed envelope is interpreted and a successful run is reported", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: `${SUCCESS_ENVELOPE}\n`, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  runtime.registerAdapter(new bridge.ZcodeAdapter({ executable: "fake-zcode" }));
  const started = await runtime.startTask({ task: "say OK", workspace: root, harness: "zcode", taskMode: "read_only" });
  assert.equal(started.harness, "zcode");

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.summary, "OK");
    assert.equal(job.sessionId, "sess_f32cdea1-81b9-4140-91cc-c782d4469ac2");
    assert.equal(job.usage.totalTokens, 15);
    assert.equal(job.harness, "zcode");
  });

  assert.equal(calls[0].command, "fake-zcode");
  assert.equal(calls[0].args[calls[0].args.indexOf("--mode") + 1], "plan");
  assert.match(calls[0].args.at(-1), /say OK/, "the prompt travels over argv for zcode");
  await runtime.shutdown();
});

test("runtime end to end: an exhausted-balance failure classifies as quota and opens the zcode circuit", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stderr: "ProviderBusinessError: [1113][Insufficient balance or no resource package. Please recharge.]",
    exitCode: 1,
  }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  runtime.registerAdapter(new bridge.ZcodeAdapter({ executable: "fake-zcode" }));
  const started = await runtime.startTask({ task: "will fail on quota", workspace: root, harness: "zcode" });

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCategory, "quota_exhausted");
  });

  const health = await runtime.discover();
  const breaker = health.circuitBreakers.find((entry) => entry.key === "zcode:glm-5.3-flash");
  assert.ok(breaker, "a circuit breaker keyed zcode:glm-5.3-flash must be open");
  await runtime.shutdown();
});

test("discover() lists all three built-in harnesses once zcode is registered", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{}, {}, {}, {}, {}]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  runtime.registerAdapter(new bridge.ZcodeAdapter({ executable: "fake-zcode" }));
  const health = await runtime.discover();
  assert.deepEqual(Object.keys(health.harnesses).sort(), ["antigravity", "claude-code", "zcode"]);
  assert.equal(health.harnesses.zcode.supportsContinuation, true);
  await runtime.shutdown();
});
