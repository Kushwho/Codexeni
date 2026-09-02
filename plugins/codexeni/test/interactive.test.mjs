import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createFakeSpawn, makeRuntime, makeWorkspace, waitFor, writeOnSpawn } from "./helpers.mjs";

// The package test command must build first, so consumers exercise its public
// compiled API exactly as Codex does rather than relying on a TypeScript loader.
const bridge = await import("../dist/index.js");

// The exact pause/complete lines the Antigravity adapter reads a clarification from:
// a `structured_output` object on a stdout JSON line, with the process exiting 0.
const PAUSE_LINE = '{"type":"result","conversation_id":"fake-interaction","structured_output":{"status":"input_required","summary":"Paused before choosing.","question":"Which option?","options":["option-a","option-b"]}}\n';
const COMPLETE_LINE = '{"type":"result","status":"SUCCESS","conversation_id":"fake-interaction","structured_output":{"status":"completed","summary":"Done."}}\n';
const PAUSE_LINE_NO_CONVERSATION = '{"type":"result","structured_output":{"status":"input_required","summary":"Paused.","question":"Which?"}}\n';

function pauseLineFor(question, conversationId = "fake-interaction") {
  return `${JSON.stringify({ type: "result", conversation_id: conversationId, structured_output: { status: "input_required", summary: `Paused: ${question}`, question } })}\n`;
}

test("a pause parks the job and exposes the question without a live child", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: PAUSE_LINE, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "ask before choosing", workspace: root });

  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "awaiting_input");
    return current;
  });
  assert.equal(job.inputRequest.question, "Which option?");
  assert.deepEqual(job.inputRequest.options, ["option-a", "option-b"]);
  assert.deepEqual(job.interactionRound, { current: 0, max: 3, remaining: 3 });
  assert.deepEqual(job.continuation, { supported: true, available: true, action: "answer" });
  assert.equal(job.finishedAt, undefined, "compactRecord clears finishedAt while awaiting input");
  assert.equal(typeof job.pid, "number", "the finished process's pid is retained for inspection");
  assert.equal(job.exitCode, 0);

  const pending = runtime.getPendingInput(started.jobId);
  assert.equal(pending.question, "Which option?");
  assert.equal(pending.round, 1);
  assert.equal(pending.maxRounds, 3);

  assert.equal(runtime.jobs.get(started.jobId).child, undefined, "the record holds no live child process while parked");
});

test("an orchestrator answer resumes the same conversation and reaches succeeded", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: PAUSE_LINE, exitCode: 0 },
    { stdout: COMPLETE_LINE, exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "ask before choosing", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));

  await runtime.respondTask(started.jobId, "use option-a", "orchestrator");
  assert.equal(calls.length, 2, "the answer must launch a fresh child process");
  const conversationIndex = calls[1].args.indexOf("--conversation");
  assert.ok(conversationIndex >= 0, "the second spawn must continue the reported conversation");
  assert.equal(calls[1].args[conversationIndex + 1], "fake-interaction");
  const promptIndex = calls[1].args.indexOf("--prompt");
  assert.ok(promptIndex >= 0);
  assert.match(calls[1].args[promptIndex + 1], /use option-a/, "the answer text must reach the worker's continuation prompt");

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.interactionRound.current, 1);
    assert.match(job.warnings.join("\n"), /Clarification round 1 answered by orchestrator/);
  });
});

test("a human answer is accepted the same way and is recorded as human-answered", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: PAUSE_LINE, exitCode: 0 },
    { stdout: COMPLETE_LINE, exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "ask before choosing", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));

  await runtime.respondTask(started.jobId, "option-b", "human");
  assert.equal(calls.length, 2);
  const conversationIndex = calls[1].args.indexOf("--conversation");
  assert.equal(calls[1].args[conversationIndex + 1], "fake-interaction");

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    assert.match(job.warnings.join("\n"), /Clarification round 1 answered by human/);
  });
});

test("a waiting job holds no concurrency slot, so a second task can still start", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([
    { stdout: PAUSE_LINE, exitCode: 0 },
    { stdout: '{"event":"result","result":{"status":"SUCCESS","response":"second job done"}}\n', exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, { maxConcurrency: 1 }, { spawnImpl });
  const first = await runtime.startTask({ task: "first, will park", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(first.jobId).status, "awaiting_input"));

  const second = await runtime.startTask({ task: "second, its own scenario", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(second.jobId).status, "succeeded"));
  // The parked first job never occupied the single concurrency slot.
  assert.equal(runtime.getTask(first.jobId).status, "awaiting_input");
});

test("cancelling a job while it awaits input marks it canceled and blocks further answers", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: PAUSE_LINE, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "ask before choosing", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));

  const result = await runtime.cancelTask(started.jobId);
  assert.equal(result.canceled, true);
  assert.equal(result.status, "canceled");
  assert.equal(runtime.getTask(started.jobId).status, "canceled");

  await assert.rejects(() => runtime.respondTask(started.jobId, "too late", "orchestrator"), /not awaiting input/);
});

test("the round limit stops a question loop after the maximum clarification rounds", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: pauseLineFor("Question one?"), exitCode: 0 },
    { stdout: pauseLineFor("Question two?"), exitCode: 0 },
    { stdout: pauseLineFor("Question three?"), exitCode: 0 },
    { stdout: pauseLineFor("Question four?"), exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "keeps asking", workspace: root });

  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));
  await runtime.respondTask(started.jobId, "answer one", "orchestrator");
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));
  await runtime.respondTask(started.jobId, "answer two", "orchestrator");
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));
  await runtime.respondTask(started.jobId, "answer three", "orchestrator");

  // maxInputRounds (3) answers have now been accepted; the fourth pause is refused
  // by applyInputRequestPolicy instead of parking a fourth time.
  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "failed");
    return current;
  });
  assert.equal(calls.length, 4, "all four spawns happen before the loop is stopped");
  assert.match(job.stderrSummary, new RegExp(`maximum of ${bridge.LIMITS.maxInputRounds} clarification rounds`));
  assert.match(job.warnings.join("\n"), /Clarification round limit reached/);
});

test("a repeated clarification question stops the loop instead of retrying forever", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: pauseLineFor("Same question every time?"), exitCode: 0 },
    { stdout: pauseLineFor("Same question every time?"), exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "loops on one question", workspace: root });

  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));
  await runtime.respondTask(started.jobId, "an answer", "orchestrator");

  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "failed");
    return current;
  });
  assert.equal(calls.length, 2);
  assert.match(job.stderrSummary, /repeated the same clarification question/);
  assert.match(job.warnings.join("\n"), /Repeated clarification question/);
});

test("a pause without a conversation id fails cleanly instead of parking", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{ stdout: PAUSE_LINE_NO_CONVERSATION, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "asks without reporting a conversation", workspace: root });

  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "failed");
    return current;
  });
  assert.match(job.stderrSummary, /conversation_id/);
  assert.match(job.stderrSummary, /continuation is unavailable/);
});

test("a harness without continuation support never exposes it and refuses respondTask", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl } = createFakeSpawn([{
    stdout: '{"type":"result","result":"all set","is_error":false,"session_id":"claude-session-1"}\n',
    exitCode: 0,
  }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "plain claude-code task", workspace: root, harness: "claude-code" });

  const job = await waitFor(() => {
    const current = runtime.getTask(started.jobId);
    assert.equal(current.status, "succeeded");
    return current;
  });
  // Claude Code's adapter never produces a workerResult/structured clarification, so it
  // can't itself pause into awaiting_input — that shows instead as continuationSupported: false.
  assert.equal(job.continuation.supported, false);
  await assert.rejects(() => runtime.respondTask(started.jobId, "answer", "orchestrator"), /not awaiting input/);
});

test("a failed conversation exposes a diagnostic and can resume with a recovery instruction", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([
    { stdout: '{"type":"result","conversation_id":"recoverable","status":"ERROR","error":"upstream interrupted"}\n', exitCode: 17 },
    { stdout: COMPLETE_LINE, exitCode: 0 },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "recover a task", workspace: root });

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.failure.message, "upstream interrupted");
    assert.equal(job.failure.source, "harness");
    assert.equal(job.stderrSummary, "upstream interrupted");
    assert.deepEqual(job.continuation, { supported: true, available: true, action: "resume" });
  });

  await runtime.resumeTask(started.jobId, "Continue from the edits already made.");
  const conversationIndex = calls[1].args.indexOf("--conversation");
  assert.equal(calls[1].args[conversationIndex + 1], "recoverable");
  const promptIndex = calls[1].args.indexOf("--prompt");
  assert.match(calls[1].args[promptIndex + 1], /Continue from the edits already made/);
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "succeeded"));
});

test("workspace changes accumulate across a pause and its resuming turn", async () => {
  const { root } = await makeWorkspace();
  const fileA = join(root, "a.txt");
  const fileB = join(root, "b.txt");
  const { spawnImpl } = createFakeSpawn([
    { stdout: PAUSE_LINE, exitCode: 0, onSpawn: writeOnSpawn(fileA, "from the first turn") },
    { stdout: COMPLETE_LINE, exitCode: 0, onSpawn: writeOnSpawn(fileB, "from the second turn") },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "writes across turns", workspace: root });

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "awaiting_input");
    assert.deepEqual(job.partialWorkspaceChanges.created, ["a.txt"]);
    assert.equal(job.hasPartialWorkspaceChanges, true);
    assert.equal(job.partialWorkspaceChanges.attribution, "unattributed_shared_workspace");
  });

  await runtime.respondTask(started.jobId, "use option-a", "orchestrator");

  await waitFor(() => {
    const job = runtime.getTask(started.jobId);
    assert.equal(job.status, "succeeded");
    // The before-snapshot is taken once at task start, so the final diff carries
    // the first turn's file alongside the second turn's.
    assert.deepEqual(job.workspaceChanges.created, ["a.txt", "b.txt"]);
    assert.equal(job.partialWorkspaceChanges, undefined);
  });
});

test("shared-workspace changes are explicitly unattributed when jobs overlap", async () => {
  const { root } = await makeWorkspace();
  const firstFile = join(root, "first.txt");
  const secondFile = join(root, "second.txt");
  const { spawnImpl, calls } = createFakeSpawn([
    { close: false, stdout: COMPLETE_LINE, onSpawn: writeOnSpawn(firstFile, "first") },
    { stdout: COMPLETE_LINE, onSpawn: writeOnSpawn(secondFile, "second") },
  ]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const first = await runtime.startTask({ task: "first writer", workspace: root });
  const second = await runtime.startTask({ task: "second writer", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(second.jobId).status, "succeeded"));
  calls[0].child.exitCode = 0;
  calls[0].child.emit("close", 0, null);

  await waitFor(() => {
    const job = runtime.getTask(first.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.workspaceChanges.attribution, "unattributed_shared_workspace");
    assert.deepEqual(job.workspaceChanges.overlappingJobIds, [second.jobId]);
    assert.deepEqual(job.workspaceChanges.created, ["first.txt", "second.txt"]);
  });
});

test("respondTask validates the answer and the answeredBy value", async () => {
  const { root } = await makeWorkspace();
  const { spawnImpl, calls } = createFakeSpawn([{ stdout: PAUSE_LINE, exitCode: 0 }]);
  const runtime = makeRuntime(bridge, root, {}, { spawnImpl });
  const started = await runtime.startTask({ task: "ask before choosing", workspace: root });
  await waitFor(() => assert.equal(runtime.getTask(started.jobId).status, "awaiting_input"));

  await assert.rejects(() => runtime.respondTask(started.jobId, "   ", "orchestrator"), /Answer must not be empty/);
  await assert.rejects(
    () => runtime.respondTask(started.jobId, "x".repeat(bridge.LIMITS.maxInputAnswerChars + 1), "orchestrator"),
    new RegExp(`no more than ${bridge.LIMITS.maxInputAnswerChars} characters`),
  );
  await assert.rejects(() => runtime.respondTask(started.jobId, "a fine answer", "nobody"), /answeredBy must be either orchestrator or human/);

  // None of the rejected calls should have disturbed the parked job or spawned a worker.
  assert.equal(runtime.getTask(started.jobId).status, "awaiting_input");
  assert.equal(calls.length, 1);
});
