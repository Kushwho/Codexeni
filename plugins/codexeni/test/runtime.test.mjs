import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createEscapingLink, createFakeSpawn, createManualTimers, makeRuntime, makeWorkspace, stopFakeChild, waitFor, writeOnSpawn } from "./helpers.mjs";

// The package test command must build first, so consumers exercise its public
// compiled API exactly as Codex does rather than relying on a TypeScript loader.
const bridge = await import("../dist/index.js");

/**
 * Like `makeRuntime`, but also injects explicit metrics sinks — a hook `makeRuntime`'s
 * single-argument construction doesn't expose, and it lives in test/helpers.mjs, which this suite must not edit.
 */
function makeRuntimeWithSinks(bridgeModule, root, sinks, overrides = {}, deps = {}) {
  const config = {
    allowedRoots: [root],
    permissionMode: "restricted",
    defaultHarness: "antigravity",
    defaultTimeoutSeconds: 5,
    maxConcurrency: 4,
    harnesses: {},
    ...overrides,
  };
  const runtime = new bridgeModule.BridgeRuntime({ config, stopChildImpl: stopFakeChild, ...deps }, { sinks });
  runtime.registerAdapter(new bridgeModule.AntigravityAdapter({ executable: "fake-agy" }));
  runtime.registerAdapter(new bridgeModule.ClaudeCodeAdapter({ executable: "fake-claude" }));
  return runtime;
}

test("resolveBridgeConfig resolves defaults, permission modes, concurrency clamp, harness settings, root precedence, and default-harness normalization", () => {
  const defaults = bridge.resolveBridgeConfig({});
  assert.equal(defaults.permissionMode, "full");
  assert.equal(defaults.defaultHarness, "antigravity");
  assert.equal(defaults.defaultTimeoutSeconds, 900);
  assert.equal(defaults.maxConcurrency, 4);
  assert.deepEqual(defaults.harnesses, {});

  assert.equal(bridge.resolveBridgeConfig({ AGY_BRIDGE_PERMISSION_MODE: "restricted" }).permissionMode, "restricted");
  assert.equal(bridge.resolveBridgeConfig({ BRIDGE_PERMISSION_MODE: "FULL" }).permissionMode, "full");
  // Full is the default; an explicitly-set but unrecognized value still fails closed to restricted.
  assert.equal(bridge.resolveBridgeConfig({ BRIDGE_PERMISSION_MODE: "anything-else" }).permissionMode, "restricted");
  assert.equal(bridge.resolveBridgeConfig({ BRIDGE_MAX_CONCURRENCY: "9" }).maxConcurrency, 4);

  const harnessConfig = bridge.resolveBridgeConfig({ BRIDGE_ANTIGRAVITY_PATH: "/x/agy", AGY_BRIDGE_DEFAULT_MODEL: "m" });
  assert.deepEqual(harnessConfig.harnesses.antigravity, { executable: "/x/agy", defaultModel: "m" });

  const rootsPrecedence = bridge.resolveBridgeConfig({ BRIDGE_ALLOWED_ROOTS: "bridge-root", AGY_BRIDGE_ALLOWED_ROOTS: "legacy-root" });
  assert.deepEqual(rootsPrecedence.allowedRoots, [resolve("bridge-root")]);

  assert.equal(bridge.resolveBridgeConfig({ BRIDGE_DEFAULT_HARNESS: "Claude" }).defaultHarness, "claude");
});

test("explicit allowed roots reject other workspaces; zero-config uses each task workspace", async () => {
  const envWorkspace = await makeWorkspace();
  const clientWorkspace = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const explicitRuntime = makeRuntime(bridge, envWorkspace.root, {}, { spawnImpl });
  assert.equal(explicitRuntime.getAllowedRootSource(), "environment");
  await assert.rejects(
    () => explicitRuntime.startTask({ task: "outside explicit root", workspace: clientWorkspace.root }),
    /outside/,
  );
  await explicitRuntime.shutdown();

  const unsetRuntime = makeRuntime(bridge, envWorkspace.root, { allowedRoots: [] }, { spawnImpl });
  assert.equal(unsetRuntime.getAllowedRootSource(), "task_workspace");
  const started = await unsetRuntime.startTask({ task: "use the requested workspace", workspace: envWorkspace.root });
  assert.equal(started.workspace, await bridge.canonicalizeWorkspace(envWorkspace.root));
  await unsetRuntime.shutdown();
});

test("zero-config discover advertises restricted task-workspace fallback before and after a task", async () => {
  const { root } = await makeWorkspace();
  const other = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{}, {}, {}, {}, { close: false }, {}]);
  const runtime = makeRuntime(bridge, root, { allowedRoots: [] }, { spawnImpl });
  const before = await runtime.discover();
  assert.equal(before.allowedRootSource, "task_workspace");
  assert.equal(before.taskWorkspaceFallback, true);
  assert.equal(before.permissionMode, "restricted");

  const first = await runtime.startTask({ task: "bounded to the first workspace", workspace: root });
  assert.equal(first.workspace, await bridge.canonicalizeWorkspace(root));
  const afterFirst = await runtime.discover();
  assert.equal(afterFirst.allowedRootSource, "task_workspace");
  assert.equal(afterFirst.permissionMode, "restricted");

  const second = await runtime.startTask({ task: "a separate workspace gets its own boundary", workspace: other.root });
  assert.equal(second.workspace, await bridge.canonicalizeWorkspace(other.root));
  await runtime.shutdown();
});

test("discover reuses recent harness probes and supports explicit refresh", async () => {
  const { root } = await makeWorkspace();
  let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: "agy fixture\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
    { stdout: "2.1.251 (Claude Code)\n", exitCode: 0 },
    { stdout: '{"loggedIn":true}\n', exitCode: 0 },
    { stdout: "agy fixture refreshed\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
    { stdout: "2.1.251 (Claude Code) refreshed\n", exitCode: 0 },
    { stdout: '{"loggedIn":true}\n', exitCode: 0 },
    { stdout: "agy fixture expired\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
    { stdout: "2.1.251 (Claude Code) expired\n", exitCode: 0 },
    { stdout: '{"loggedIn":true}\n', exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, now: () => new Date(milliseconds) });

  await runtime.discover();
  await runtime.discover();
  assert.equal(calls.length, 4, "a repeated discovery must reuse the cached version and model probes for every registered harness");

  await runtime.discover({ refresh: true });
  assert.equal(calls.length, 8, "an explicit refresh must run fresh version and model probes for every registered harness");

  milliseconds += bridge.LIMITS.discoveryCacheMs + 1;
  await runtime.discover();
  assert.equal(calls.length, 12, "an expired discovery cache must be refreshed for every registered harness");
});

/** A paused turn: the structured result the Antigravity adapter reads clarifications from. */
function pauseLine(overrides = {}) {
  return `${JSON.stringify({
    type: "result",
    conversation_id: "fake-interaction",
    structured_output: {
      status: "input_required",
      summary: "Paused before choosing.",
      question: "Which option should I use?",
      options: ["option-a", "option-b"],
      ...overrides,
    },
  })}\n`;
}

const DONE_LINE = `${JSON.stringify({
  type: "result",
  status: "SUCCESS",
  conversation_id: "fake-interaction",
  structured_output: { status: "completed", summary: "Done." },
})}\n`;

/**
 * Connect the MCP client the currently installed Codex speaks (SDK v1) to the v2 bridge
 * server. It advertises roots and sampling on purpose, so a test can prove the bridge never issues either.
 */
async function connectClient(runtime, { elicitation = true, onElicit } = {}) {
  const server = bridge.createMcpServer(runtime);
  const capabilities = { roots: { listChanged: true }, sampling: {} };
  if (elicitation) capabilities.elicitation = {};
  const client = new Client({ name: "bridge-test", version: "1.0.0" }, { capabilities });
  const seen = { roots: 0, sampling: 0, elicits: [] };
  client.setRequestHandler(ListRootsRequestSchema, async () => { seen.roots += 1; return { roots: [] }; });
  client.setRequestHandler(CreateMessageRequestSchema, async () => {
    seen.sampling += 1;
    return { model: "none", role: "assistant", content: { type: "text", text: "" } };
  });
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      seen.elicits.push(request.params);
      return onElicit ? onElicit(request) : { action: "accept", content: { answer: "option-a" } };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, seen, close: async () => { await client.close(); await server.close(); } };
}

const payloadOf = (result) => JSON.parse(result.content[0].text);

/** Start a task through the client and wait until the worker has parked on a question. */
async function parkedJob(client, runtime, root) {
  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "decide something", workspace: root } }));
  await waitFor(async () => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));
  return started.jobId;
}

test("the MCP server exposes the five delegate tools and never asks the client for roots or sampling", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: pauseLine() }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["delegate_cancel", "delegate_discover", "delegate_respond", "delegate_start", "delegate_status"],
  );

  const jobId = await parkedJob(client, runtime, root);
  const status = payloadOf(await client.callTool({ name: "delegate_status", arguments: { jobId } }));
  assert.equal(status.status, "awaiting_input");
  assert.equal(status.inputRequest.question, "Which option should I use?");
  assert.deepEqual(status.inputRequest.options, ["option-a", "option-b"]);
  assert.deepEqual(status.interactionRound, { current: 0, max: bridge.LIMITS.maxInputRounds, remaining: bridge.LIMITS.maxInputRounds });
  assert.equal(status.continuation.supported, true);

  const discovered = payloadOf(await client.callTool({ name: "delegate_discover", arguments: {} }));
  assert.equal(discovered.humanInput.toolName, "delegate_respond");
  assert.deepEqual(discovered.humanInput.modes, ["mrtr", "legacy_elicitation_shim", "external"]);
  assert.equal(discovered.harnesses.antigravity.supportsContinuation, true);
  assert.equal(discovered.harnesses["claude-code"].supportsContinuation, false);
  assert.equal(discovered.limits.maxInputRounds, bridge.LIMITS.maxInputRounds);
  assert.ok(!("sampling" in discovered), "the bridge must not advertise sampling");
  assert.ok(!("roots" in discovered), "the bridge must not advertise roots");

  assert.equal(seen.roots, 0, "the bridge must never issue roots/list");
  assert.equal(seen.sampling, 0, "the bridge must never issue sampling/createMessage");
  await close();
});

test("delegate_status compacts echoed schemas unless full events are explicitly requested", async () => {
  const { root } = await makeWorkspace();
  const schema = { type: "object", properties: { summary: { type: "string" } } };
  const line = `${JSON.stringify({ type: "message", conversation_id: "schema-job", content: "Working", json_schema: schema })}\n`;
  const { spawnImpl } = createFakeSpawn([{ stdout: `${line}${DONE_LINE}`, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, close } = await connectClient(runtime);
  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "compact events", workspace: root } }));
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));

  const compact = payloadOf(await client.callTool({ name: "delegate_status", arguments: { jobId: started.jobId } }));
  assert.equal(compact.events[0].message, "Working");
  assert.equal(compact.events[0].data, undefined);
  assert.doesNotMatch(JSON.stringify(compact.events), /json_schema/);

  const full = payloadOf(await client.callTool({ name: "delegate_status", arguments: { jobId: started.jobId, eventDetail: "full" } }));
  assert.deepEqual(full.events[0].data.json_schema, schema);
  await close();
});

test("delegate_respond elicits a human answer through the legacy shim and resumes the same conversation", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: pauseLine() }, { stdout: DONE_LINE }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime, {
    onElicit: async () => ({ action: "accept", content: { answer: "option-b" } }),
  });

  const jobId = await parkedJob(client, runtime, root);
  const responded = await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "elicit" } });
  assert.notEqual(responded.isError, true, "an accepted elicitation must not be an error result");

  // The prompt leads with the question, shows the choices inline so they are readable
  // without opening the picker, and asks for exactly one field.
  assert.equal(seen.elicits.length, 1);
  const message = seen.elicits[0].message;
  assert.ok(message.startsWith("Which option should I use?"), "the question must be the first thing shown");
  assert.match(message, /option-a · option-b/);
  assert.match(message, /Paused before choosing\./);
  assert.match(message, new RegExp(`Round 1 of ${bridge.LIMITS.maxInputRounds}`));
  const schema = seen.elicits[0].requestedSchema;
  assert.deepEqual(schema.properties.answer.enum, ["option-a", "option-b"]);
  assert.deepEqual(Object.keys(schema.properties), ["answer"], "a second field turns a one-tap choice into a form");
  assert.deepEqual(schema.required, ["answer"]);

  await waitFor(async () => assert.equal(runtime.getTask(jobId).status, "succeeded"));

  // The second process continues the SAME Gemini thread rather than starting over.
  const resumeArgs = calls[1].args;
  assert.equal(resumeArgs[resumeArgs.indexOf("--conversation") + 1], "fake-interaction");
  const resumePrompt = resumeArgs[resumeArgs.indexOf("--prompt") + 1];
  assert.match(resumePrompt, /option-b/);

  const finished = runtime.getTask(jobId);
  assert.equal(finished.interactionRound.current, 1);
  assert.ok(finished.warnings.some((warning) => /round 1 answered by human/i.test(warning)));
  await close();
});

test("a declined or cancelled elicitation leaves the job waiting instead of failing it", async () => {
  for (const action of ["decline", "cancel"]) {
    const { root } = await makeWorkspace();
    const { spawnImpl } = createFakeSpawn([{ stdout: pauseLine() }]);
    const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
    const { client, close } = await connectClient(runtime, { onElicit: async () => ({ action }) });

    const jobId = await parkedJob(client, runtime, root);
    const responded = await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "elicit" } });
    assert.notEqual(responded.isError, true, `${action} is a normal outcome, not a tool error`);
    const payload = payloadOf(responded);
    assert.equal(payload.declined, true);
    assert.equal(payload.action, action);
    assert.equal(payload.status, "awaiting_input");
    assert.equal(runtime.getTask(jobId).status, "awaiting_input", `${action} must not fail the job`);
    await close();
  }
});

test("the elicitation prompt stays short: no repeated question, bounded context, one field", async () => {
  const { root } = await makeWorkspace();
  // Mirrors a real worker turn: the summary restates the question and runs long.
  const question = "Which config format should I use for billing-sync: JSON, YAML, or TOML?";
  const restating = `I am asking you this. ${question} It matters because it affects everything downstream.`;
  const { spawnImpl } = createFakeSpawn([{ stdout: pauseLine({ question, summary: restating, recommendedOption: "YAML", options: ["YAML", "JSON", "TOML"] }) }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime, { onElicit: async () => ({ action: "decline" }) });

  const jobId = await parkedJob(client, runtime, root);
  await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "elicit" } });

  const message = seen.elicits[0].message;
  assert.ok(message.startsWith(question), "the question must lead the prompt");
  // A summary that merely echoes the question must not push the question out of view.
  assert.equal(message.split(question).length - 1, 1, "the question must appear exactly once");
  assert.ok(!message.includes("It matters because"), "a restating summary is dropped rather than shown twice");
  // The choices are readable without opening the picker, with the recommendation marked.
  assert.match(message, /YAML \(recommended\) · JSON · TOML/);
  assert.deepEqual(Object.keys(seen.elicits[0].requestedSchema.properties), ["answer"]);
  await close();
});

test("a long work-so-far summary is trimmed instead of burying the question", async () => {
  const { root } = await makeWorkspace();
  const long = `Context: ${"detail ".repeat(120)}`;
  const { spawnImpl } = createFakeSpawn([{ stdout: pauseLine({ summary: long }) }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime, { onElicit: async () => ({ action: "decline" }) });

  const jobId = await parkedJob(client, runtime, root);
  await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "elicit" } });

  const message = seen.elicits[0].message;
  assert.ok(message.length < long.length, "the prompt must be shorter than an unbounded summary");
  assert.match(message, /…/, "a trimmed summary is marked as trimmed");
  await close();
});

test("delegate_respond refuses to elicit a credential and never sends the request", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: pauseLine({ question: "Which API token should I use?", category: "credential", options: undefined }) }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime);

  const jobId = await parkedJob(client, runtime, root);
  const responded = await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "elicit" } });
  assert.equal(responded.isError, true);
  assert.match(payloadOf(responded).error, /credential|secret/i);
  assert.equal(seen.elicits.length, 0, "a credential question must never reach the human as an elicitation");
  assert.equal(runtime.getTask(jobId).status, "awaiting_input");
  await close();
});

test("delegate_respond relays an externally collected human answer and validates its arguments", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: pauseLine() }, { stdout: DONE_LINE }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, seen, close } = await connectClient(runtime);

  const jobId = await parkedJob(client, runtime, root);

  const missingAnswer = await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "answer" } });
  assert.equal(missingAnswer.isError, true);
  assert.match(payloadOf(missingAnswer).error, /answer is required/i);

  // The external fallback: a human answered out of band and the orchestrator relays it verbatim.
  const responded = await client.callTool({ name: "delegate_respond", arguments: { jobId, action: "answer", answer: "option-a", answeredBy: "human" } });
  assert.notEqual(responded.isError, true);
  assert.equal(seen.elicits.length, 0, "action answer must not elicit anything");

  await waitFor(async () => assert.equal(runtime.getTask(jobId).status, "succeeded"));
  const resumeArgs = calls[1].args;
  assert.equal(resumeArgs[resumeArgs.indexOf("--conversation") + 1], "fake-interaction");
  assert.match(resumeArgs[resumeArgs.indexOf("--prompt") + 1], /option-a/);
  await close();
});

test("delegate_respond reports a clear error when the job is not waiting for input", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: DONE_LINE }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, close } = await connectClient(runtime);

  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "no questions", workspace: root } }));
  await waitFor(async () => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));

  const elicited = await client.callTool({ name: "delegate_respond", arguments: { jobId: started.jobId, action: "elicit" } });
  assert.equal(elicited.isError, true);
  assert.match(payloadOf(elicited).error, /not awaiting input/i);
  await close();
});

test("a single-use input nonce is consumed once, rejecting replays, unknown and expired state", () => {
  const ledger = new bridge.NonceLedger(60_000);
  const nonce = ledger.issue();
  assert.equal(ledger.consume(nonce), true, "the first reply must be accepted");
  assert.equal(ledger.consume(nonce), false, "replaying the same requestState must be rejected");
  assert.equal(ledger.consume("never-issued"), false);

  const expired = new bridge.NonceLedger(-1);
  assert.equal(expired.consume(expired.issue()), false, "an expired requestState must be rejected");

  // The question fingerprint is what makes an edited or advanced question invalidate sealed state.
  assert.equal(bridge.hashQuestion("Which option?"), bridge.hashQuestion("Which option?"));
  assert.notEqual(bridge.hashQuestion("Which option?"), bridge.hashQuestion("Which option? "));
  assert.equal(bridge.hashQuestion("Which option?").length, 16);
});

test("Antigravity adapter command retains hostile task text as one prompt argument and orders flags correctly", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  const hostileTask = "fix it --dangerously-skip-permissions; echo owned $(whoami)";
  const spec = adapter.command({
    prompt: hostileTask,
    workspace: "C:\\safe\\fixture",
    timeoutSeconds: 900,
    model: "gemini-3.7-flash-high",
    effort: "high",
    permissionMode: "restricted",
    taskMode: "coding",
  });
  assert.equal(spec.command, "fake-agy");
  assert.equal(spec.cwd, "C:\\safe\\fixture");
  const schemaIndex = spec.args.indexOf("--json-schema");
  assert.deepEqual(spec.args.slice(0, schemaIndex), [
    "--model", "gemini-3.7-flash-high",
    "--output-format", "stream-json",
    "--print-timeout", "900s",
    "--sandbox",
    "--mode", "accept-edits",
  ]);
  assert.equal(typeof JSON.parse(spec.args[schemaIndex + 1]), "object", "the worker result schema travels as one JSON argument");
  assert.deepEqual(spec.args.slice(schemaIndex + 2), ["--prompt", hostileTask]);
  assert.equal(spec.args.filter((arg) => arg === hostileTask).length, 1);
  assert.ok(!spec.args.includes("--dangerously-skip-permissions"));

  const fullSpec = adapter.command({ prompt: "x", workspace: "w", timeoutSeconds: 900, model: "m", effort: "low", permissionMode: "full", taskMode: "coding" });
  assert.ok(fullSpec.args.includes("--dangerously-skip-permissions"));

  const readOnlySpec = adapter.command({ prompt: "review", workspace: "w", timeoutSeconds: 900, model: "m", effort: "high", permissionMode: "restricted", taskMode: "read_only" });
  assert.equal(readOnlySpec.args[readOnlySpec.args.indexOf("--mode") + 1], "plan");
});

test("Antigravity expresses effort through the model slug and never passes --effort", () => {
  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });

  // `agy` rejects the flag in every case, so it must never be built into the command.
  for (const effort of ["low", "medium", "high"]) {
    for (const model of ["gemini-3.7-flash-high", "claude-sonnet-4-6", undefined]) {
      const spec = adapter.command({ prompt: "x", workspace: "w", timeoutSeconds: 900, model, effort, permissionMode: "full", taskMode: "coding" });
      assert.ok(!spec.args.includes("--effort"), `--effort reached agy for model ${model} at effort ${effort}`);
    }
  }

  // With no model pinned the requested effort selects the tier of the default model.
  assert.deepEqual(adapter.resolveSelection(undefined, "low"), { model: "gemini-3.7-flash-low" });
  assert.deepEqual(adapter.resolveSelection(undefined, undefined), { model: "gemini-3.7-flash-high" });

  // A pinned slug wins outright; a matching effort is silent, a conflicting one is reported.
  assert.deepEqual(adapter.resolveSelection("gemini-3.1-pro-high", "high"), { model: "gemini-3.1-pro-high" });
  const conflict = adapter.resolveSelection("gemini-3.7-flash-high", "low");
  assert.equal(conflict.model, "gemini-3.7-flash-high", "the caller's explicit slug is never rewritten");
  assert.match(conflict.warning ?? "", /"low" was not applied/);

  // A model with no tier takes no effort at all.
  const untiered = adapter.resolveSelection("claude-sonnet-4-6", "high");
  assert.equal(untiered.model, "claude-sonnet-4-6");
  assert.match(untiered.warning ?? "", /does not accept a reasoning effort/);
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
  assert.equal(bridge.parseJsonLine("   ", timestamp), undefined);
  assert.deepEqual(bridge.parseJsonLine('{"type":"result","conversation_id":"abc"}', timestamp), {
    timestamp,
    type: "result",
    data: { type: "result", conversation_id: "abc" },
  });
  assert.deepEqual(bridge.parseJsonLine("not-json", timestamp), {
    timestamp,
    type: "unparsed_output",
    data: "not-json",
  });
});

test("provider failures are classified without relying on one CLI event shape", () => {
  assert.equal(bridge.defaultClassifyFailure("HTTP 429 too many requests"), "rate_limited");
  assert.equal(bridge.defaultClassifyFailure({ error: "RESOURCE_EXHAUSTED: quota exceeded" }), "quota_exhausted");
  assert.equal(bridge.defaultClassifyFailure("quota exhausted; out of credits"), "quota_exhausted");
  assert.equal(bridge.defaultClassifyFailure("session limit reached"), "session_limit");
  assert.equal(bridge.defaultClassifyFailure("maximum context window token limit"), "context_limit");
  assert.equal(bridge.defaultClassifyFailure("login required: session expired"), "authentication");
  assert.equal(bridge.defaultClassifyFailure("unexpected error"), undefined);
});

test("provider retry-after parsing handles seconds, milliseconds, and reset dates", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(bridge.defaultRetryAfterMs("retry-after: 1.5 seconds", now), 1_500);
  assert.equal(bridge.defaultRetryAfterMs("retry-after_ms=250", now), 250);
  assert.equal(bridge.defaultRetryAfterMs({ error: { retry_after: 2 } }, now), 2_000);
  assert.equal(bridge.defaultRetryAfterMs({ error: { retry_after_ms: 750 } }, now), 750);
  assert.equal(bridge.defaultRetryAfterMs("reset_at=2026-01-01T00:00:02.000Z", now), 2_000);
  assert.equal(bridge.defaultRetryAfterMs("Retry-After: Thu, 01 Jan 2026 00:00:05 GMT", now), 5_000);
  assert.equal(bridge.defaultRetryAfterMs("no retry hint", now), undefined);
});

test("delegation prompt pins the worker to its selected workspace", () => {
  const prompt = bridge.buildDelegationPrompt("fix the tests", "C:\\safe\\fixture", "coding");
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
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, randomUUIDImpl: () => "00000000-0000-4000-8000-000000000001" });
  const started = await runtime.startTask({ task: "fix --not-a-shell-flag", workspace: root });
  assert.equal(started.status, "running");
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /fix --not-a-shell-flag/);
  assert.match(calls[0].args.at(-1), new RegExp(root.replaceAll("\\", "\\\\")));
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.sessionId, "conversation-1");
    assert.equal(job.summary, "done");
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
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, randomUUIDImpl: () => "00000000-0000-4000-8000-000000000099" });
  const started = await runtime.startTask({ task: "fails upstream", workspace: root });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.outcome, "failed");
    assert.equal(job.sessionId, "conversation-error");
    assert.match(job.stderrSummary, /terminal status ERROR/);
  });
});

test("structured stdout and temporary logs redact sensitive fields", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stdout: '{"event":"result","authorization":"Bearer exposed","result":{"status":"SUCCESS","response":"authorization=hidden","api_key":"also-hidden"}}\n',
    exitCode: 0,
  }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, randomUUIDImpl: () => "00000000-0000-4000-8000-000000000098" });
  const started = await runtime.startTask({ task: "safe output", workspace: root });
  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId, 50, "full");
    assert.equal(current.status, "succeeded");
    assert.equal(current.events[0].data.authorization, "[redacted]");
    assert.equal(current.events[0].data.result.api_key, "[redacted]");
    assert.doesNotMatch(current.summary, /hidden/);
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl,
    randomUUIDImpl: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const first = await runtime.startTask({ task: "one", workspace: root });
  const second = await runtime.startTask({ task: "two", workspace: root });
  await runtime.startTask({ task: "three", workspace: root });
  await runtime.startTask({ task: "four", workspace: root });
  assert.deepEqual(second.warnings, ["Another job is already writing to this workspace; workspace changes cannot be attributed to one job."]);
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
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, randomUUIDImpl: () => "00000000-0000-4000-8000-000000000009" });
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const started = await runtime.startTask({ task: "read-only timeout", workspace: root, taskMode: "read_only", maxRetries: 1, timeoutSeconds: 1 });
  timers.runNext((timer) => timer.delay === 1_000);
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "queued"));
  timers.runNext((timer) => timer.delay === 15_000);
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.summary, "recovered");
    assert.equal(job.signal, null);
  });
  assert.equal(calls.length, 2);
});

test("task mode and read-only retry limits are validated and coding always has zero retries", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl,
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
    assert.equal(job.hasPartialWorkspaceChanges, false, "successful changes are reported as workspaceChanges, not partialWorkspaceChanges");
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
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
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
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
  const changedRuntime = makeRuntime(bridge, changedWorkspace.root, {}, {
    spawnImpl: changed.spawnImpl, randomImpl: () => 0,
    setTimeoutImpl: changedTimers.setTimeoutImpl, clearTimeoutImpl: changedTimers.clearTimeoutImpl,
  });
  const changedStart = await changedRuntime.startTask({ task: "read only", workspace: changedWorkspace.root, taskMode: "read_only", maxRetries: 2 });
  await waitFor(() => {
    const job = changedRuntime.getTask(changedStart.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.hasPartialWorkspaceChanges, true);
    assert.deepEqual(job.partialWorkspaceChanges.created, ["unexpected-change.txt"]);
  });
  assert.equal(changed.calls.length, 1, "workspace mutations must suppress retries");
});

test("an open same-model quota circuit is visible in discover() and blocks new starts without fallback", async () => {
  const { root } = await makeWorkspace();
  const timers = createManualTimers();
  const { spawnImpl, calls } = createFakeSpawn([
    { stderr: "quota exhausted: out of credits\n", exitCode: 1 },
    { stdout: "agy test version\n", exitCode: 0 },
    { stdout: "gemini-3.7-flash-high\n", exitCode: 0 },
  ]);
  let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  const runtime = makeRuntime(bridge, root, {}, {
    spawnImpl, randomImpl: () => 0,
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
  const health = await runtime.discover();
  assert.equal(health.circuitBreakers.length, 1);
  assert.equal(health.circuitBreakers[0].model, "gemini-3.7-flash-high");
  assert.equal(health.circuitBreakers[0].harness, "antigravity");
  assert.ok(Date.parse(health.circuitBreakers[0].blockedUntil) > milliseconds);
  milliseconds += bridge.LIMITS.circuitBreakerMs + 1;
  await runtime.startTask({ task: "circuit expired", workspace: root, taskMode: "coding", model: "gemini-3.7-flash-high" });
});

test("circuit breaker key includes the harness id", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stderr: "quota exhausted: out of credits\n", exitCode: 1 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl, randomImpl: () => 0 });
  const started = await runtime.startTask({ task: "quota failure", workspace: root, taskMode: "coding", model: "gemini-3.7-flash-high" });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "failed"));
  assert.ok(runtime.breakers.has("antigravity:gemini-3.7-flash-high"));
  const discovered = await runtime.discover();
  assert.equal(discovered.circuitBreakers.length, 1);
  assert.equal(discovered.circuitBreakers[0].harness, "antigravity");
});

test("parseModelList keeps non-Gemini model slugs and skips status lines", () => {
  const output = "Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
  assert.deepEqual(bridge.parseModelList(output), ["claude-sonnet-4-6", "gemini-3.7-flash-high", "gpt-oss-120b-medium"]);
});

test("startTask rejects an unknown harness id", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  await assert.rejects(() => runtime.startTask({ task: "x", workspace: root, harness: "nope" }), /Unknown harness/);
});

test("usage is normalized from provider-reported token fields", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done","usage":{"input_tokens":3,"output_tokens":5}}}\n',
    exitCode: 0,
  }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "usage check", workspace: root });
  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    // The default antigravity model is priced in BUILT_IN_PRICES, so a token-only
    // report picks up an estimated cost — the withEstimatedCost wiring in recordEvent.
    const price = bridge.BUILT_IN_PRICES[bridge.priceKey("antigravity", job.model)];
    const expectedCost = bridge.estimateCostUsd({ inputTokens: 3, outputTokens: 5 }, price);
    assert.deepEqual(job.usage, { inputTokens: 3, outputTokens: 5, costUsd: expectedCost, costSource: "estimated" });
  });

  const adapter = new bridge.AntigravityAdapter({ executable: "fake-agy" });
  assert.equal(adapter.interpret({ result: { usage: { foo: 1 } } }).usage, undefined);
});

test("TaskMetricsCollector counts a start+end pair once and a bare completion once, updating ok without double counting", () => {
  const collector = new bridge.TaskMetricsCollector();
  // Claude Code's shape: a "started" defines the call, a later "completed" sharing its id closes it out.
  collector.addToolCalls([
    { name: "Read", phase: "started", id: "call-1" },
    { name: "Write", phase: "started", id: "call-2" },
  ]);
  collector.addToolCalls([{ name: "", phase: "completed", ok: true, id: "call-1" }]);
  // Antigravity's shape: only ever a "completed", so it must count on its own.
  collector.addToolCalls([{ name: "run_command", phase: "completed", ok: false }]);

  const record = {
    id: "job-1",
    harness: "antigravity",
    model: "gemini-3.7-flash-high",
    taskMode: "coding",
    status: "succeeded",
    workspace: "C:\\fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    retryCount: 0,
  };
  const metrics = collector.build(record);
  assert.equal(metrics.toolCalls.total, 3, "call-1 (start+end), call-2 (start only), and the bare completion each count once");
  assert.equal(metrics.toolCalls.failed, 1, "only the bare completion reported ok:false");
  assert.deepEqual(metrics.toolCalls.byName, { Read: 1, Write: 1, run_command: 1 });
  assert.equal(metrics.schemaVersion, 1);
  assert.equal(metrics.queuedMs, 1_000);
  assert.equal(metrics.runningMs, 4_000);
  // Matches events.ts's existing derivation exactly: "started" prefers startedAt over
  // createdAt, so once a job has actually started, durationMs equals runningMs.
  assert.equal(metrics.durationMs, 4_000);
  assert.equal(metrics.eventCount, 0, "no line was ever recorded through recordEvent()");

  // A second completed for the same id, after it was already consumed, is unmatched again.
  collector.addToolCalls([{ name: "Read", phase: "completed", ok: true, id: "call-1" }]);
  assert.equal(collector.build(record).toolCalls.total, 4);
});

test("tool-call metrics flow from a worker's stream-json into delegate_status.metrics and a sink", async () => {
  const { root } = await makeWorkspace();
  const assistantLine = `${JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
    ] },
  })}\n`;
  const userLine = `${JSON.stringify({
    type: "user",
    // toolu_1 completes; toolu_2 never does; a stray tool_result answers an id the worker never opened.
    message: { content: [
      { type: "tool_result", tool_use_id: "toolu_1", is_error: false },
      { type: "tool_result", tool_use_id: "toolu_3", is_error: true },
    ] },
  })}\n`;
  const resultLine = `${JSON.stringify({ type: "result", result: "done", num_turns: 2, is_error: false, usage: { input_tokens: 10, output_tokens: 20 } })}\n`;
  const { spawnImpl } = createFakeSpawn([{ stdout: assistantLine + userLine + resultLine, exitCode: 0 }]);
  const received = [];
  const sink = { id: "capture", onTaskFinalized: (metrics) => received.push(metrics) };
  const runtime = makeRuntimeWithSinks(bridge, root, [sink], {}, { spawnImpl });

  const started = await runtime.startTask({ task: "use tools", workspace: root, harness: "claude-code" });
  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "succeeded");
    return current;
  });
  assert.equal(job.metrics.toolCalls.total, 3, "toolu_1 (paired), toolu_2 (started only), toolu_3 (unmatched completion)");
  assert.equal(job.metrics.toolCalls.failed, 1, "only the unmatched toolu_3 completion reported is_error:true");
  assert.deepEqual(job.metrics.toolCalls.byName, { Read: 1, Bash: 1 });
  assert.equal(job.metrics.turns, 2);
  assert.equal(job.metrics.eventCount, 3, "one recorded event per stream-json line");
  const rawToolCalls = runtime.jobs.get(started.jobId).toolCalls;
  assert.deepEqual(rawToolCalls.map((call) => call.phase), ["started", "started", "completed", "completed"], "raw observations are appended onto record.toolCalls, never overwritten");

  assert.equal(received.length, 1, "the sink must receive exactly one dispatch for the finished job");
  assert.equal(received[0].jobId, started.jobId);
  assert.equal(received[0].toolCalls.total, 3);
  await runtime.shutdown();
});

test("NdjsonSink appends exactly one JSON line per finished job, and it parses with schemaVersion 1", async () => {
  const { root } = await makeWorkspace();
  const dir = await mkdtemp(join(tmpdir(), "codexeni-metrics-"));
  const file = join(dir, "metrics.ndjson");
  const sink = new bridge.NdjsonSink(file);
  const { spawnImpl } = createFakeSpawn([{ stdout: DONE_LINE, exitCode: 0 }]);
  const runtime = makeRuntimeWithSinks(bridge, root, [sink], {}, { spawnImpl });

  const started = await runtime.startTask({ task: "ndjson sink", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));

  const rows = await waitFor(async () => {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "exactly one line for the one finished job");
    return lines;
  });
  const parsed = JSON.parse(rows[0]);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.jobId, started.jobId);
  assert.equal(parsed.harness, "antigravity");
  await runtime.shutdown();
});

test("a throwing sink does not fail the job and does not stop a later sink from receiving the event", async () => {
  const { root } = await makeWorkspace();
  const received = [];
  const badSink = { id: "bad", onTaskFinalized: () => { throw new Error("sink exploded"); } };
  const goodSink = { id: "good", onTaskFinalized: (metrics) => received.push(metrics) };
  const { spawnImpl } = createFakeSpawn([{ stdout: DONE_LINE, exitCode: 0 }]);
  // The throwing sink runs first so a later sink's success proves dispatch kept going.
  const runtime = makeRuntimeWithSinks(bridge, root, [badSink, goodSink], {}, { spawnImpl });

  const started = await runtime.startTask({ task: "resilient sinks", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));
  assert.equal(received.length, 1, "a throwing sink must not stop a later sink from receiving the event, and the job itself must still succeed");
  await runtime.shutdown();
});

test("estimateCostUsd returns undefined rather than zero for an unpriced model and never throws", () => {
  const usage = { inputTokens: 100, outputTokens: 50 };
  assert.equal(bridge.estimateCostUsd(usage, undefined), undefined);
  assert.equal(bridge.estimateCostUsd(undefined, undefined), undefined);
  assert.equal(bridge.estimateCostUsd(usage, bridge.BUILT_IN_PRICES["antigravity:unknown-model"]), undefined, "BUILT_IN_PRICES has no entry for an unknown model, so lookup yields undefined");

  const untouched = bridge.withEstimatedCost(usage, undefined);
  assert.equal(untouched, usage, "with no price available, withEstimatedCost returns the original usage unchanged");
  assert.equal(untouched.costUsd, undefined);

  const priced = bridge.withEstimatedCost(usage, { inputPerMTok: 3, outputPerMTok: 15, source: "test", asOf: "2026-01-01" });
  assert.equal(priced.costUsd, (100 / 1_000_000) * 3 + (50 / 1_000_000) * 15);
  assert.equal(priced.costSource, "estimated");

  const harnessReported = bridge.withEstimatedCost({ costUsd: 1.23 }, { inputPerMTok: 3, outputPerMTok: 15, source: "test", asOf: "2026-01-01" });
  assert.equal(harnessReported.costUsd, 1.23, "a harness-reported cost is never overwritten by an estimate");
  assert.equal(harnessReported.costSource, "harness");
});

test("delegate_discover returns a totals block reflecting finished jobs, unaffected by a failing sink", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: DONE_LINE, exitCode: 0 }]);
  const throwingSink = { id: "bad", onTaskFinalized: () => { throw new Error("nope"); } };
  const runtime = makeRuntimeWithSinks(bridge, root, [throwingSink], {}, { spawnImpl });
  const { client, close } = await connectClient(runtime);

  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "totals check", workspace: root } }));
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));

  const discovered = payloadOf(await client.callTool({ name: "delegate_discover", arguments: {} }));
  assert.ok(Array.isArray(discovered.totals));
  const rollup = discovered.totals.find((row) => row.harness === "antigravity");
  assert.ok(rollup, "the finished antigravity job must appear in totals despite the co-registered throwing sink");
  assert.equal(rollup.jobs, 1);
  assert.equal(rollup.succeeded, 1);
  assert.equal(rollup.failed, 0);
  await close();
  await runtime.shutdown();
});

test("shutdown removes the per-job temp log directory this runtime created, and nothing else", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: DONE_LINE, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const untouched = await mkdtemp(join(tmpdir(), "codexeni-untouched-"));

  const started = await runtime.startTask({ task: "temp dir cleanup", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));
  const logDir = dirname(runtime.getTask(started.jobId).logPath);
  assert.equal(existsSync(logDir), true, "the job's temp log directory must exist once the job has run");

  await runtime.shutdown();
  assert.equal(existsSync(logDir), false, "shutdown must remove the temp log directory this runtime created");
  assert.equal(existsSync(untouched), true, "shutdown must not remove a directory this runtime did not create");
});

test("waitForSettled resolves immediately for an already-settled job", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{}]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "quick", workspace: root });
  await waitFor(() => assert.ok(!["queued", "running"].includes(runtime.getTask(started.jobId).status)));

  const before = Date.now();
  await runtime.waitForSettled(started.jobId, 5_000);
  assert.ok(Date.now() - before < 100, "an already-settled job must not incur the poll delay");
  await runtime.shutdown();
});

test("waitForSettled blocks while the job runs and resolves once it settles", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "slow", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "running"));

  let resolved = false;
  const waitPromise = runtime.waitForSettled(started.jobId, 5_000).then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "must still be waiting while the job is running");

  calls[0].child.exitCode = 0;
  calls[0].child.emit("close", 0, null);
  await waitPromise;
  assert.equal(resolved, true);
  assert.notEqual(runtime.getTask(started.jobId).status, "running");
});

test("waitForSettled gives up after its bound elapses without throwing, leaving the job running", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "never finishes", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "running"));

  await runtime.waitForSettled(started.jobId, 60);
  assert.equal(runtime.getTask(started.jobId).status, "running", "a timed-out wait must not affect the job itself");
  await runtime.shutdown();
});

test("waitForSettled resolves early when its abort signal fires, leaving the job running", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "aborted wait", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "running"));

  const controller = new AbortController();
  const before = Date.now();
  const waitPromise = runtime.waitForSettled(started.jobId, 10_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await waitPromise;
  assert.ok(Date.now() - before < 500, "an aborted wait must not run for its full bound");
  assert.equal(runtime.getTask(started.jobId).status, "running", "aborting the wait must not touch the job itself");
  await runtime.shutdown();
});

test("waitForSettled throws Unknown job ID the same way getTask does", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  await assert.rejects(() => runtime.waitForSettled("f47ac10b-58cc-4372-a567-0e02b2c3d479", 100), /Unknown job ID/);
});

test("delegate_status with waitSeconds blocks until the job settles, through the real MCP client", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ close: false }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, close } = await connectClient(runtime);

  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "wait for me", workspace: root } }));
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "running"));

  let settled = false;
  const statusPromise = client.callTool({ name: "delegate_status", arguments: { jobId: started.jobId, waitSeconds: 5 } }).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "the call must still be pending while the job runs");

  calls[0].child.exitCode = 0;
  calls[0].child.emit("close", 0, null);
  const status = payloadOf(await statusPromise);
  assert.notEqual(status.status, "running");
  await close();
});

test("delegate_status rejects a waitSeconds above maxStatusWaitSeconds instead of silently ignoring it", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{}]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const { client, close } = await connectClient(runtime);
  const started = payloadOf(await client.callTool({ name: "delegate_start", arguments: { task: "quick", workspace: root } }));
  const response = await client.callTool({ name: "delegate_status", arguments: { jobId: started.jobId, waitSeconds: bridge.LIMITS.maxStatusWaitSeconds + 1 } });
  assert.equal(response.isError, true);
  await close();
});
