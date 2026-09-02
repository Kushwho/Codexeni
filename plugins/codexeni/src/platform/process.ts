import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import type { CommandResult } from "../adapters/adapter.js";
import { LIMITS } from "../core/limits.js";
import type { SpawnFunction, StopChildFunction } from "../core/types.js";
import { redactPotentialSecrets } from "../core/redaction.js";

/** Stop a child process and, where possible, its process tree. */
export async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, shell: false });
      killer.once("error", () => { try { child.kill("SIGTERM"); } catch { /* best effort */ } done(); });
      killer.once("close", () => done());
    });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* best effort */ } }
}

/** Run a short harness probe without giving adapters direct process ownership. */
export function captureCommand(
  spawnImpl: SpawnFunction,
  stopImpl: StopChildFunction,
  command: string,
  args: readonly string[],
  timeoutMs: number = LIMITS.probeTimeoutMs,
): Promise<CommandResult> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      done({ ...result, stderr: redactPotentialSecrets(result.stderr) });
    };
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, stdout, stderr, error: redactPotentialSecrets(error instanceof Error ? error.message : String(error)) });
      return;
    }
    const timeout = setTimeout(() => {
      void stopImpl(child);
      finish({ ok: false, stdout, stderr, error: "probe timed out" });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data) => { stdout += String(data); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data) => { stderr += String(data); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      finish({ ok: false, stdout, stderr, error: redactPotentialSecrets(error.message) });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0 ? { ok: true, stdout, stderr } : { ok: false, stdout, stderr, error: redactPotentialSecrets(stderr || `exit code ${code}`) });
    });
  });
}
