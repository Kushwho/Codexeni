#!/usr/bin/env node

/**
 * A deliberately small stdio MCP server.  It never proxies Antigravity's
 * stdout to its own stdout: MCP owns stdout and the child process is captured
 * into a temporary NDJSON log instead.
 */
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readdir, realpath, stat, mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DEFAULT_MODEL = "gemini-3.7-flash-high";
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_EVENTS = 200;
const MAX_EVENT_CHARS = 8_000;
const EXCLUDED_SNAPSHOT_DIRECTORIES = new Set([".git", "node_modules", ".next", ".pnpm-store", "dist", "build", ".cache", "coverage", "test-results"]);

export type PermissionMode = "restricted" | "full";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled" | "orphaned";

export interface BridgeConfig {
  executable: string;
  allowedRoots: string[];
  permissionMode: PermissionMode;
  defaultModel: string;
  defaultTimeoutSeconds: number;
  maxConcurrency: number;
}

export interface RuntimeDependencies {
  config?: BridgeConfig;
  spawnImpl?: SpawnFunction;
  stopChildImpl?: StopChildFunction;
  now?: () => Date;
  mkdtempImpl?: typeof mkdtemp;
  randomUUIDImpl?: () => string;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type StopChildFunction = (child: ChildProcess) => Promise<void>;

export interface StreamEvent {
  timestamp: string;
  type: string;
  data: unknown;
}

export interface FileSnapshotEntry {
  size: number;
  mtimeMs: number;
}

export type WorkspaceSnapshot = Map<string, FileSnapshotEntry>;

export interface FileChanges {
  created: string[];
  modified: string[];
  deleted: string[];
  truncated: boolean;
}

export interface TaskRecord {
  id: string;
  task: string;
  workspace: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutSeconds: number;
  permissionMode: PermissionMode;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  conversationId?: string;
  response?: string;
  usage?: unknown;
  upstreamStatus?: string;
  stderrSummary: string;
  logPath: string;
  events: StreamEvent[];
  warnings: string[];
  fileChanges?: FileChanges;
  child?: ChildProcess;
  timeoutHandle?: NodeJS.Timeout;
  beforeSnapshot?: WorkspaceSnapshot;
  cancellationRequested?: boolean;
  forcedTerminalStatus?: "timed_out" | "canceled";
  finalizing?: boolean;
}

const nonEmptyEnv = (value: string | undefined): string | undefined => value?.trim() || undefined;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve all environment configuration without looking at credential files. */
export function resolveBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const permission = nonEmptyEnv(env.AGY_BRIDGE_PERMISSION_MODE)?.toLowerCase();
  const permissionMode: PermissionMode = permission === "full" ? "full" : "restricted";
  const roots = (env.AGY_BRIDGE_ALLOWED_ROOTS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));

  return {
    executable: nonEmptyEnv(env.AGY_BRIDGE_AGY_PATH) ?? "agy",
    allowedRoots: roots,
    permissionMode,
    defaultModel: nonEmptyEnv(env.AGY_BRIDGE_DEFAULT_MODEL) ?? DEFAULT_MODEL,
    defaultTimeoutSeconds: parsePositiveInt(env.AGY_BRIDGE_DEFAULT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    maxConcurrency: Math.min(parsePositiveInt(env.AGY_BRIDGE_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY), DEFAULT_MAX_CONCURRENCY),
  };
}

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
  public constructor(private readonly configuredRoots: readonly string[]) {}

  public async canonicalRoots(): Promise<string[]> {
    return Promise.all(this.configuredRoots.map((root) => canonicalizeWorkspace(root)));
  }

  public async assertAllowed(workspace: string): Promise<string> {
    if (this.configuredRoots.length === 0) {
      throw new Error("AGY_BRIDGE_ALLOWED_ROOTS is required before starting a task.");
    }
    const [canonicalWorkspace, canonicalRoots] = await Promise.all([
      canonicalizeWorkspace(workspace),
      this.canonicalRoots(),
    ]);
    if (!canonicalRoots.some((root) => isPathWithinRoot(canonicalWorkspace, root))) {
      throw new Error("Workspace is outside AGY_BRIDGE_ALLOWED_ROOTS.");
    }
    return canonicalWorkspace;
  }
}

export function buildAgyArgs(input: {
  task: string;
  workspace?: string;
  model: string;
  effort: "low" | "medium" | "high";
  permissionMode: PermissionMode;
}): string[] {
  const args = ["--model", input.model, "--output-format", "stream-json", "--effort", input.effort, "--sandbox"];
  if (input.permissionMode === "full") args.push("--dangerously-skip-permissions");
  args.push("--prompt", buildDelegationPrompt(input.task, input.workspace));
  return args;
}

export function buildDelegationPrompt(task: string, workspace?: string): string {
  if (!workspace) return task;
  return [
    "You are a bounded external coding worker.",
    `Your workspace is exactly: ${workspace}`,
    "Treat that directory as the entire project. Start by inspecting '.' relative to the current working directory.",
    "Do not search, read, write, or run commands outside this workspace.",
    "Do not inspect credentials, tokens, browser data, keyrings, or user-profile configuration.",
    "Complete only the task below, run its requested checks, and report changed files and results.",
    "",
    "TASK:",
    task,
  ].join("\n");
}

/** Parse one child-output line; malformed output is preserved as text rather than fatal. */
export function parseNdjsonLine(line: string, timestamp = new Date().toISOString()): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const data: unknown = JSON.parse(trimmed);
    const record = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
    const eventType = record?.event ?? record?.type;
    return { timestamp, type: typeof eventType === "string" ? eventType : "event", data };
  } catch {
    return { timestamp, type: "unparsed_output", data: trimmed.slice(0, MAX_EVENT_CHARS) };
  }
}

export async function snapshotWorkspace(workspace: string, maxEntries = 20_000): Promise<{ snapshot: WorkspaceSnapshot; truncated: boolean }> {
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

function redactPotentialSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(-8_000);
}

const SENSITIVE_FIELD_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)/i;

/** Bound and sanitize child-provided JSON before retaining or returning it. */
function sanitizeEventData(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactPotentialSecrets(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEventData(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key,
      SENSITIVE_FIELD_NAME.test(key) ? "[redacted]" : sanitizeEventData(item, depth + 1),
    ]));
  }
  return String(value).slice(0, MAX_EVENT_CHARS);
}

function extractFields(event: StreamEvent, record: TaskRecord): void {
  if (!event.data || typeof event.data !== "object") return;
  const value = event.data as Record<string, unknown>;
  const nestedRecords = [value, value.result, value.data, value.message]
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate));
  for (const candidate of nestedRecords) {
    const conversationId = candidate.conversation_id ?? candidate.conversationId;
    if (typeof conversationId === "string") record.conversationId = conversationId;
    if (candidate.usage !== undefined) record.usage = candidate.usage;
    if (typeof candidate.status === "string") record.upstreamStatus = candidate.status;
    const text = candidate.text ?? candidate.response ?? candidate.message ?? candidate.content;
    if (typeof text === "string") record.response = text;
  }
}

function compactRecord(record: TaskRecord, eventLimit: number): Record<string, unknown> {
  const finished = record.finishedAt ? new Date(record.finishedAt).getTime() : Date.now();
  const started = record.startedAt ? new Date(record.startedAt).getTime() : new Date(record.createdAt).getTime();
  return {
    jobId: record.id,
    status: record.status,
    workspace: record.workspace,
    model: record.model,
    effort: record.effort,
    permissionMode: record.permissionMode,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: finished - started,
    pid: record.pid,
    exitCode: record.exitCode,
    signal: record.signal,
    conversationId: record.conversationId,
    response: record.response,
    usage: record.usage,
    upstreamStatus: record.upstreamStatus,
    stderrSummary: record.stderrSummary,
    logPath: record.logPath,
    warnings: record.warnings,
    fileChanges: record.fileChanges,
    events: record.events.slice(-eventLimit),
  };
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
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

export class AgyBridgeRuntime {
  public readonly config: BridgeConfig;
  public readonly jobs = new Map<string, TaskRecord>();
  private readonly guard: WorkspaceGuard;
  private readonly spawnImpl: SpawnFunction;
  private readonly stopChildImpl: StopChildFunction;
  private readonly now: () => Date;
  private readonly mkdtempImpl: typeof mkdtemp;
  private readonly createId: () => string;

  public constructor(dependencies: RuntimeDependencies = {}) {
    this.config = dependencies.config ?? resolveBridgeConfig();
    this.guard = new WorkspaceGuard(this.config.allowedRoots);
    this.spawnImpl = dependencies.spawnImpl ?? nodeSpawn;
    this.stopChildImpl = dependencies.stopChildImpl ?? stopChildProcess;
    this.now = dependencies.now ?? (() => new Date());
    this.mkdtempImpl = dependencies.mkdtempImpl ?? mkdtemp;
    this.createId = dependencies.randomUUIDImpl ?? randomUUID;
  }

  public async health(): Promise<Record<string, unknown>> {
    const canonicalRoots = await Promise.all(this.config.allowedRoots.map(async (root) => {
      try { return { configured: root, canonical: await canonicalizeWorkspace(root) }; }
      catch (error) { return { configured: root, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const version = await this.capture(["--version"]);
    // `agy models` is deliberately kept in its most widely supported form;
    // the output parser accepts both its human and JSON representations.
    const models = await this.capture(["models"]);
    return {
      executable: this.config.executable,
      executableAvailable: version.ok,
      version: version.ok ? version.stdout.trim() : undefined,
      authenticationStatus: models.ok ? "authenticated" : version.ok ? "unknown" : "unavailable",
      configuredAllowedRoots: canonicalRoots,
      permissionMode: this.config.permissionMode,
      defaultModel: this.config.defaultModel,
      maxConcurrency: this.config.maxConcurrency,
      models: models.ok ? extractModelSlugs(models.stdout) : [],
      modelProbeError: models.ok ? undefined : models.error,
      activeJobs: [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "queued").length,
    };
  }

  public async startTask(input: { task: string; workspace: string; effort?: "low" | "medium" | "high"; timeoutSeconds?: number; model?: string }): Promise<Record<string, unknown>> {
    if (!input.task.trim()) throw new Error("Task must not be empty.");
    if (!input.workspace.trim()) throw new Error("Workspace must not be empty.");
    if (input.timeoutSeconds !== undefined && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > this.config.defaultTimeoutSeconds)) {
      throw new Error(`timeoutSeconds must be a positive integer no greater than ${this.config.defaultTimeoutSeconds}.`);
    }
    const workspace = await this.guard.assertAllowed(input.workspace);
    const active = [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "queued");
    if (active.length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached.`);

    const id = this.createId();
    const folder = await this.mkdtempImpl(join(tmpdir(), "codex-antigravity-bridge-"));
    const record: TaskRecord = {
      id,
      task: input.task,
      workspace,
      model: input.model ?? this.config.defaultModel,
      effort: input.effort ?? "high",
      timeoutSeconds: Math.min(input.timeoutSeconds ?? this.config.defaultTimeoutSeconds, this.config.defaultTimeoutSeconds),
      permissionMode: this.config.permissionMode,
      status: "queued",
      createdAt: this.now().toISOString(),
      stderrSummary: "",
      logPath: join(folder, `${id}.ndjson`),
      events: [],
      warnings: active.some((job) => job.workspace === workspace) ? ["Another Antigravity job is already writing to this workspace; changes may overlap."] : [],
    };
    this.jobs.set(id, record);
    try {
      const initial = await snapshotWorkspace(workspace);
      record.beforeSnapshot = initial.snapshot;
      if (initial.truncated) record.warnings.push("Pre-task file snapshot reached its entry limit; change detection is partial.");
      this.launch(record);
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.now().toISOString();
      record.stderrSummary = error instanceof Error ? error.message : String(error);
    }
    return { jobId: id, status: record.status, warnings: record.warnings, workspace, model: record.model };
  }

  public getTask(jobId: string, eventLimit = 50): Record<string, unknown> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    return compactRecord(record, Math.max(1, Math.min(eventLimit, MAX_EVENTS)));
  }

  public async cancelTask(jobId: string): Promise<Record<string, unknown>> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (!record.child || record.status !== "running") return { jobId, status: record.status, canceled: false };
    record.cancellationRequested = true;
    record.forcedTerminalStatus = "canceled";
    await this.stopChildImpl(record.child);
    return { jobId, status: record.status, canceled: true };
  }

  public async shutdown(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((job) => job.status === "running" && job.child).map(async (job) => {
      job.cancellationRequested = true;
      await this.stopChildImpl(job.child!);
    }));
  }

  private launch(record: TaskRecord): void {
    const args = buildAgyArgs(record);
    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.config.executable, args, { cwd: record.workspace, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.finalize(record, "failed", error instanceof Error ? error.message : String(error));
      return;
    }
    record.child = child;
    record.pid = child.pid;
    record.status = "running";
    record.startedAt = this.now().toISOString();
    record.timeoutHandle = setTimeout(() => {
      if (record.status === "running") {
        record.cancellationRequested = true;
        record.forcedTerminalStatus = "timed_out";
        void this.stopChildImpl(child);
        void this.finalize(record, "timed_out", "Task exceeded its configured timeout.");
      }
    }, record.timeoutSeconds * 1_000);
    child.once("error", (error) => void this.finalize(record, "failed", error.message));
    child.once("close", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      const upstreamStatus = record.upstreamStatus?.toUpperCase();
      const status: JobStatus = record.forcedTerminalStatus
        ?? (record.cancellationRequested
          ? "canceled"
          : code !== 0
            ? "failed"
            : upstreamStatus === "SUCCESS"
              ? "succeeded"
              : upstreamStatus === "CANCELED"
                ? "canceled"
                : "failed");
      const detail = code === 0 && !record.forcedTerminalStatus && upstreamStatus !== "SUCCESS" && upstreamStatus !== "CANCELED"
        ? upstreamStatus
          ? `Antigravity returned terminal status ${upstreamStatus}.`
          : "Antigravity exited without a terminal result event."
        : undefined;
      void this.finalize(record, status, detail);
    });
    this.captureStream(child.stdout, record, false);
    this.captureStream(child.stderr, record, true);
  }

  private captureStream(stream: NodeJS.ReadableStream | null, record: TaskRecord, stderr: boolean): void {
    if (!stream) return;
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const received = String(chunk);
      if (stderr) {
        const sanitized = redactPotentialSecrets(received);
        void appendFile(record.logPath, sanitized, "utf8");
        record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${sanitized}`);
        return;
      }
      pending += received;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.recordEvent(record, line);
    });
    stream.on("end", () => { if (!stderr && pending) this.recordEvent(record, pending); });
  }

  private recordEvent(record: TaskRecord, line: string): void {
    const event = parseNdjsonLine(line, this.now().toISOString());
    if (!event) return;
    event.data = sanitizeEventData(event.data);
    void appendFile(record.logPath, `${JSON.stringify(event)}\n`, "utf8");
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) record.events.shift();
    extractFields(event, record);
  }

  private async finalize(record: TaskRecord, status: JobStatus, detail?: string): Promise<void> {
    if (record.finalizing || ["succeeded", "failed", "timed_out", "canceled"].includes(record.status)) return;
    record.finalizing = true;
    if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
    record.status = status;
    record.finishedAt = this.now().toISOString();
    if (detail) record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${detail}`);
    try {
      if (record.beforeSnapshot) {
        const after = await snapshotWorkspace(record.workspace);
        record.fileChanges = diffSnapshots(record.beforeSnapshot, after.snapshot, after.truncated);
        if (after.truncated) record.warnings.push("Post-task file snapshot reached its entry limit; change detection is partial.");
      }
    } catch (error) {
      record.warnings.push(`Could not collect changed files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.child = undefined;
      record.finalizing = false;
    }
  }

  private capture(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
    return new Promise((done) => {
      let stdout = "";
      let stderr = "";
      let child: ChildProcess;
      try { child = this.spawnImpl(this.config.executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { done({ ok: false, stdout, error: error instanceof Error ? error.message : String(error) }); return; }
      const timeout = setTimeout(() => { void this.stopChildImpl(child); done({ ok: false, stdout, error: "probe timed out" }); }, 8_000);
      child.stdout?.setEncoding("utf8"); child.stdout?.on("data", (data) => { stdout += String(data); });
      child.stderr?.setEncoding("utf8"); child.stderr?.on("data", (data) => { stderr += String(data); });
      child.once("error", (error) => { clearTimeout(timeout); done({ ok: false, stdout, error: redactPotentialSecrets(error.message) }); });
      child.once("close", (code) => { clearTimeout(timeout); done(code === 0 ? { ok: true, stdout } : { ok: false, stdout, error: redactPotentialSecrets(stderr || `exit code ${code}`) }); });
    });
  }
}

export function extractModelSlugs(output: string): string[] {
  const matches = output.match(/gemini-[a-z0-9._-]+/gi) ?? [];
  return [...new Set(matches.map((item) => item.toLowerCase()))].sort();
}

export function parseAuthenticationStatus(output: string): "authenticated" | "unauthenticated" | "unknown" {
  const normalized = output.toLowerCase();
  if (/not[ _-]?authenticated|unauthenticated|logged[ _-]?out/.test(normalized)) return "unauthenticated";
  if (/authenticated|logged[ _-]?in/.test(normalized)) return "authenticated";
  return "unknown";
}

const taskInput = {
  task: z.string().min(1).max(100_000),
  workspace: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().max(DEFAULT_TIMEOUT_SECONDS).optional(),
  model: z.string().min(1).max(200).optional(),
};

const jsonResult = (payload: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload as Record<string, unknown>, isError });

export function createMcpServer(runtime = new AgyBridgeRuntime()): McpServer {
  const server = new McpServer({ name: "codex-antigravity-bridge", version: "0.1.0" });
  server.registerTool("antigravity_health", { description: "Check the local Antigravity CLI bridge without reading credentials.", annotations: { readOnlyHint: true, openWorldHint: false } }, async () => jsonResult(await runtime.health()));
  server.registerTool("antigravity_start_task", { description: "Start an asynchronous Antigravity coding task. Full mode grants broad local tool access; the allowed-root check selects cwd but is not a security sandbox.", inputSchema: taskInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => {
    try { return jsonResult(await runtime.startTask(input)); } catch (error) { return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  server.registerTool("antigravity_get_task", { description: "Get lifecycle status and recent stream events for an Antigravity task.", inputSchema: { jobId: z.string().uuid(), eventLimit: z.number().int().min(1).max(MAX_EVENTS).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ jobId, eventLimit }) => {
    try { return jsonResult(runtime.getTask(jobId, eventLimit)); } catch (error) { return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  server.registerTool("antigravity_cancel_task", { description: "Cancel a running Antigravity task and its child process tree.", inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ jobId }) => {
    try { return jsonResult(await runtime.cancelTask(jobId)); } catch (error) { return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  process.once("SIGINT", () => { void runtime.shutdown(); });
  process.once("SIGTERM", () => { void runtime.shutdown(); });
  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void runStdioServer();
}
