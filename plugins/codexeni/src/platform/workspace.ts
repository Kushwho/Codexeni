import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { LIMITS } from "../core/limits.js";
import type { FileChanges, WorkspaceSnapshot } from "../core/types.js";

const EXCLUDED_SNAPSHOT_DIRECTORIES = new Set<string>(LIMITS.excludedSnapshotDirectories);

export async function canonicalizeWorkspace(workspace: string): Promise<string> {
  return realpath(resolve(workspace));
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase() : value;
}

/** Includes the root itself and resists prefix tricks such as C:\\safe-other. */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const candidateComparable = comparablePath(candidate);
  const rootComparable = comparablePath(root);
  const pathFromRoot = relative(rootComparable, candidateComparable);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.includes(`..${sep}`) && !pathFromRoot.startsWith(sep));
}

export class WorkspaceGuard {
  private configuredRoots: string[];

  public constructor(configuredRoots: readonly string[]) {
    this.configuredRoots = [...configuredRoots];
  }

  public setConfiguredRoots(roots: readonly string[]): void {
    this.configuredRoots = [...roots];
  }

  public getConfiguredRoots(): readonly string[] {
    return this.configuredRoots;
  }

  public async canonicalRoots(): Promise<string[]> {
    return Promise.all(this.configuredRoots.map((root) => canonicalizeWorkspace(root)));
  }

  public async assertAllowed(workspace: string, allowTaskWorkspaceFallback = false): Promise<string> {
    if (this.configuredRoots.length === 0) {
      if (allowTaskWorkspaceFallback) return canonicalizeWorkspace(workspace);
      throw new Error("No allowed workspace roots are available for this operation.");
    }
    const [canonicalWorkspace, canonicalRoots] = await Promise.all([
      canonicalizeWorkspace(workspace),
      this.canonicalRoots(),
    ]);
    if (!canonicalRoots.some((root) => isPathWithinRoot(canonicalWorkspace, root))) {
      throw new Error("Workspace is outside the allowed roots (BRIDGE_ALLOWED_ROOTS or MCP client roots).");
    }
    return canonicalWorkspace;
  }
}

export async function snapshotWorkspace(workspace: string, maxEntries: number = LIMITS.snapshotMaxEntries): Promise<{ snapshot: WorkspaceSnapshot; truncated: boolean }> {
  const snapshot: WorkspaceSnapshot = new Map();
  let truncated = false;
  async function visit(directory: string): Promise<void> {
    if (snapshot.size >= maxEntries) { truncated = true; return; }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (snapshot.size >= maxEntries) { truncated = true; return; }
      if (entry.isDirectory()) {
        if (!EXCLUDED_SNAPSHOT_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        const absolute = join(directory, entry.name);
        const metadata = await stat(absolute);
        snapshot.set(relative(workspace, absolute), { size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  await visit(workspace);
  return { snapshot, truncated };
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, truncated = false): FileChanges {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, metadata] of after) {
    const previous = before.get(file);
    if (!previous) created.push(file);
    else if (previous.size !== metadata.size || previous.mtimeMs !== metadata.mtimeMs) modified.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) deleted.push(file);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort(), truncated };
}
