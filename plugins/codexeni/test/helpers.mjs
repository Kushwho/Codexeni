import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates the small subset of ChildProcess used by the bridge. Each queued scenario is
 * consumed by one spawn call, making lifecycle tests deterministic without an install or shell invocation.
 */
export function createFakeSpawn(scenarios = []) {
  const calls = [];
  const spawnImpl = (command, args = [], options = {}) => {
    const scenario = scenarios.shift() ?? {};
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const stdinChunks = [];
    child.stdin.on("data", (chunk) => stdinChunks.push(chunk));
    child.pid = scenario.pid ?? 4242 + calls.length;
    child.exitCode = null;
    child.killed = false;
    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      scenario.onKill?.(signal, child);
      if (scenario.closeOnKill !== false) {
        queueMicrotask(() => child.emit("close", null, signal));
      }
      return true;
    };
    // `stdin` reflects whatever has been written to the child's stdin so far;
    // for adapters that pipe the prompt over stdin it is the whole prompt once the pipe closes.
    const call = { command, args, options, child, get stdin() { return Buffer.concat(stdinChunks).toString("utf8"); } };
    calls.push(call);
    scenario.onSpawn?.({ command, args, options, child, calls });
    queueMicrotask(() => {
      if (scenario.stdout) child.stdout.write(scenario.stdout);
      if (scenario.stderr) child.stderr.write(scenario.stderr);
      child.stdout.end();
      child.stderr.end();
      if (scenario.close !== false) {
        child.exitCode = scenario.exitCode ?? 0;
        child.emit("close", child.exitCode, scenario.signal ?? null);
      }
    });
    return child;
  };
  return { spawnImpl, calls };
}

/** Synchronously mutate a workspace from a fake child spawn between snapshots. */
export function writeOnSpawn(file, contents) {
  return () => writeFileSync(file, contents, "utf8");
}

/** Manual timer queue for retry/circuit tests; it never waits on wall-clock time. */
export function createManualTimers() {
  let sequence = 0;
  const handles = [];
  const setTimeoutImpl = (callback, delay) => {
    const handle = { id: ++sequence, callback, delay, canceled: false };
    handles.push(handle);
    return handle;
  };
  const clearTimeoutImpl = (handle) => { if (handle) handle.canceled = true; };
  const pending = () => handles.filter((handle) => !handle.canceled);
  const runNext = (predicate = () => true) => {
    const handle = pending().find(predicate);
    if (!handle) throw new Error("No matching fake timer is pending");
    handle.canceled = true;
    handle.callback();
    return handle;
  };
  return { setTimeoutImpl, clearTimeoutImpl, pending, runNext };
}

export async function makeWorkspace(prefix = "codexeni-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const nested = join(root, "nested");
  await mkdir(nested);
  return { root, nested };
}

export async function createEscapingLink(linkPath, targetPath) {
  try {
    await symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    // Windows developer mode / policy can prohibit unprivileged symlinks; the
    // caller should mark the assertion skipped rather than weakening it.
    if (error?.code === "EPERM" || error?.code === "EACCES") return false;
    throw error;
  }
}

export async function writeWorkspaceFile(root, relativePath, contents) {
  const file = join(root, relativePath);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents, "utf8");
  return file;
}

/** Stops a fake spawned child the way a real stopChildImpl would, without touching the OS. */
export const stopFakeChild = async (child) => {
  child.kill("SIGTERM");
};

/**
 * Build a BridgeRuntime wired to the fake Antigravity adapter for one test. `overrides`
 * extends the config; `deps` extends runtime dependencies — `deps.spawnImpl` is required by nearly every caller since it's what makes process launches deterministic.
 */
export function makeRuntime(bridge, root, overrides = {}, deps = {}) {
  const config = {
    allowedRoots: [root],
    permissionMode: "restricted",
    defaultHarness: "antigravity",
    defaultTimeoutSeconds: 1,
    maxConcurrency: 4,
    harnesses: {},
    ...overrides,
  };
  const runtime = new bridge.BridgeRuntime({
    config,
    stopChildImpl: stopFakeChild,
    ...deps,
  });
  runtime.registerAdapter(new bridge.AntigravityAdapter({ executable: "fake-agy" }));
  runtime.registerAdapter(new bridge.ClaudeCodeAdapter({ executable: "fake-claude" }));
  return runtime;
}

/**
 * Poll an assertion until it stops throwing — lifecycle transitions land on a child
 * process's close event, so tests wait on observable state rather than a fixed delay.
 */
export async function waitFor(assertion, timeoutMs = 500) {
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
