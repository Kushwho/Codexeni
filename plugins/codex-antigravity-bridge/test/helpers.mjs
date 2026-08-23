import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates the small subset of ChildProcess used by the bridge.  Each queued
 * scenario is consumed by one spawn call, making lifecycle tests deterministic
 * without an Antigravity install or any shell invocation.
 */
export function createFakeSpawn(scenarios = []) {
  const calls = [];
  const spawnImpl = (command, args = [], options = {}) => {
    const scenario = scenarios.shift() ?? {};
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
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
    calls.push({ command, args, options, child });
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

export async function makeWorkspace(prefix = "codex-antigravity-bridge-") {
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
