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
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const DEFAULT_MODEL = "gemini-3.7-flash-high";
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_READ_ONLY_MAX_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
export const CIRCUIT_BREAKER_MS = 5 * 60 * 1_000;
const MAX_EVENTS = 200;
const MAX_EVENT_CHARS = 8_000;
const EXCLUDED_SNAPSHOT_DIRECTORIES = new Set([".git", "node_modules", ".next", ".pnpm-store", "dist", "build", ".cache", "coverage", "test-results"]);

export type PermissionMode = "restricted" | "full";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled" | "orphaned";
export type TaskMode = "coding" | "read_only";
export type ErrorCategory = "rate_limited" | "quota_exhausted" | "session_limit" | "context_limit" | "authentication" | "upstream_error";
export type AllowedRootSource = "environment" | "mcp_client" | "task_workspace";

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
  randomImpl?: () => number;
  setTimeoutImpl?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimeoutImpl?: (timeout: NodeJS.Timeout) => void;
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

export interface ModelCircuitBreaker {
  model: string;
  category: "rate_limited" | "quota_exhausted";
  openedAt: string;
  blockedUntil: string;
}

export interface TaskRecord {
  id: string;
  task: string;
  workspace: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutSeconds: number;
  permissionMode: PermissionMode;
  taskMode: TaskMode;
  maxRetries: number;
  retryCount: number;
  nextRetryAt?: string;
  blockedUntil?: string;
  errorCategory?: ErrorCategory;
  retryable: boolean;
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
  partialChanges?: FileChanges;
  child?: ChildProcess;
  timeoutHandle?: NodeJS.Timeout;
  retryHandle?: NodeJS.Timeout;
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
  const permissionMode: PermissionMode = permission === undefined || permission === "full" ? "full" : "restricted";
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

/** Convert a local MCP Root URI to a path. Remote hosts and malformed URIs are never accepted. */
export function fileUriToLocalPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || (parsed.hostname && parsed.hostname !== "localhost")) return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Resolve only existing directory roots supplied by an MCP client. Canonical
 * paths are de-duplicated so URI spelling and symlink aliases cannot widen a
 * task's effective allowed-root set.
 */
export async function canonicalizeMcpClientRoots(uris: readonly string[]): Promise<string[]> {
  const canonicalRoots: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const localPath = fileUriToLocalPath(uri);
    if (!localPath) continue;
    try {
      const canonical = await canonicalizeWorkspace(localPath);
      if (!(await stat(canonical)).isDirectory()) continue;
      const key = comparablePath(canonical);
      if (!seen.has(key)) {
        seen.add(key);
        canonicalRoots.push(canonical);
      }
    } catch {
      // A client can send stale or malformed roots. Ignore just that root and
      // retain the fail-closed result for the remainder.
    }
  }
  return canonicalRoots;
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
  taskMode?: TaskMode;
}): string[] {
  const args = [
    "--model", input.model,
    "--output-format", "stream-json",
    "--effort", input.effort,
    "--sandbox",
    "--mode", input.taskMode === "read_only" ? "plan" : "accept-edits",
  ];
  if (input.permissionMode === "full") args.push("--dangerously-skip-permissions");
  args.push("--prompt", buildDelegationPrompt(input.task, input.workspace, input.taskMode));
  return args;
}

export function buildDelegationPrompt(task: string, workspace?: string, taskMode?: TaskMode): string {
  if (!workspace) return task;
  return [
    "You are a bounded external coding worker.",
    `Your workspace is exactly: ${workspace}`,
    "Treat that directory as the entire project. Start by inspecting '.' relative to the current working directory.",
    "Do not search, read, write, or run commands outside this workspace.",
    "Do not inspect credentials, tokens, browser data, keyrings, or user-profile configuration.",
    ...(taskMode === "read_only" ? ["This is a read-only task: do not modify files or run commands that change workspace state."] : []),
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

/** Classify provider failures without relying on a single unstable CLI schema. */
export function classifyFailure(value: unknown): ErrorCategory | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.toLowerCase();
  if (/(?:unauthenticated|not authenticated|login required|session expired|invalid (?:auth|credential)|authentication failed)/.test(normalized)) return "authentication";
  if (/(?:session limit|too many sessions|concurrent sessions|session[_ -]?limit)/.test(normalized)) return "session_limit";
  if (/(?:context limit|context window|token limit|maximum (?:context|tokens)|too many tokens|prompt is too long)/.test(normalized)) return "context_limit";
  if (/(?:quota (?:exceeded|exhausted)|quota_exhausted|out of credits|credits? exhausted|resource[_ -]?exhausted)/.test(normalized)) return "quota_exhausted";
  if (/(?:\b429\b|http[_ ]?429|rate[ _-]?limit(?:ed)?|too many requests|resource exhausted)/.test(normalized)) return "rate_limited";
  if (/(?:\b5\d\d\b|upstream|service unavailable|internal error|network error|connection (?:reset|refused|timed out))/i.test(normalized)) return "upstream_error";
  return undefined;
}

/** Returns a provider-directed wait when present, including reset timestamps. */
export function parseRetryAfterMs(value: unknown, now = Date.now()): number | undefined {
  const fromStructuredValue = (candidate: unknown, depth = 0): number | undefined => {
    if (!candidate || typeof candidate !== "object" || depth > 8) return undefined;
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedKey === "retryafterms" && (typeof item === "number" || typeof item === "string")) {
        const milliseconds = Number(item);
        if (Number.isFinite(milliseconds)) return Math.max(0, Math.round(milliseconds));
      }
      if (normalizedKey === "retryafter" && (typeof item === "number" || typeof item === "string")) {
        const seconds = Number(item);
        if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
        const timestamp = Date.parse(String(item));
        if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
      }
      if (["reset", "resetat", "retryat", "blockeduntil"].includes(normalizedKey) && typeof item === "string") {
        const timestamp = Date.parse(item);
        if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
      }
      const nested = fromStructuredValue(item, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const structured = fromStructuredValue(value);
  if (structured !== undefined) return structured;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const seconds = /retry(?:-|_)?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\b/i.exec(text);
  if (seconds) return Math.max(0, Math.round(Number(seconds[1]) * 1_000));
  const milliseconds = /retry(?:-|_)?after(?:_ms|\s*ms)\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(text);
  if (milliseconds) return Math.max(0, Math.round(Number(milliseconds[1])));
  const retryDate = /retry(?:-|_)?after\s*[:=]\s*["']?(\d{4}-\d\d-\d\dT[^"'\s,}]+)/i.exec(text);
  if (retryDate) {
    const retryTime = Date.parse(retryDate[1]);
    if (Number.isFinite(retryTime)) return Math.max(0, retryTime - now);
  }
  const httpDate = /retry(?:-|_)?after\s*:\s*([^\r\n]+)/i.exec(text);
  if (httpDate) {
    const retryTime = Date.parse(httpDate[1].trim().replace(/^['"]|['"]$/g, ""));
    if (Number.isFinite(retryTime)) return Math.max(0, retryTime - now);
  }
  const reset = /(?:reset(?:[_ -]?at)?|retry[_ -]?at|blocked[_ -]?until)\s*[:=]?\s*["']?([^"'\s,}]+)/i.exec(text);
  if (reset) {
    const resetTime = Date.parse(reset[1]);
    if (Number.isFinite(resetTime)) return Math.max(0, resetTime - now);
  }
  return undefined;
}

function hasWorkspaceChanges(changes: FileChanges | undefined): boolean {
  return Boolean(changes && (changes.created.length || changes.modified.length || changes.deleted.length));
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
    taskMode: record.taskMode,
    retryable: record.retryable,
    retryCount: record.retryCount,
    maxRetries: record.maxRetries,
    nextRetryAt: record.nextRetryAt,
    blockedUntil: record.blockedUntil,
    errorCategory: record.errorCategory,
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
    partialChanges: record.partialChanges,
    hasPartialChanges: Boolean(record.partialChanges && (record.partialChanges.created.length || record.partialChanges.modified.length || record.partialChanges.deleted.length)),
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
  public readonly breakers = new Map<string, ModelCircuitBreaker>();
  private allowedRootSource: AllowedRootSource;
  private taskWorkspace?: string;
  private rootRefreshGeneration = 0;
  private pendingMcpRootDiscovery: Promise<void> = Promise.resolve();
  private readonly guard: WorkspaceGuard;
  private readonly spawnImpl: SpawnFunction;
  private readonly stopChildImpl: StopChildFunction;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly cancelTimeout: (timeout: NodeJS.Timeout) => void;
  private readonly mkdtempImpl: typeof mkdtemp;
  private readonly createId: () => string;

  public constructor(dependencies: RuntimeDependencies = {}) {
    const provided = dependencies.config ?? resolveBridgeConfig();
    this.config = { ...provided, maxConcurrency: Math.min(Math.max(1, provided.maxConcurrency), DEFAULT_MAX_CONCURRENCY) };
    this.guard = new WorkspaceGuard(this.config.allowedRoots);
    this.allowedRootSource = this.config.allowedRoots.length > 0 ? "environment" : "task_workspace";
    this.spawnImpl = dependencies.spawnImpl ?? nodeSpawn;
    this.stopChildImpl = dependencies.stopChildImpl ?? stopChildProcess;
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.randomImpl ?? Math.random;
    this.scheduleTimeout = dependencies.setTimeoutImpl ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimeout = dependencies.clearTimeoutImpl ?? ((timeout) => clearTimeout(timeout));
    this.mkdtempImpl = dependencies.mkdtempImpl ?? mkdtemp;
    this.createId = dependencies.randomUUIDImpl ?? randomUUID;
  }

  public async health(): Promise<Record<string, unknown>> {
    await this.awaitMcpRootDiscovery();
    this.expireBreakers();
    const canonicalRoots = await Promise.all(this.guard.getConfiguredRoots().map(async (root) => {
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
      allowedRootSource: this.allowedRootSource,
      taskWorkspace: this.taskWorkspace,
      taskWorkspaceFallback: this.allowedRootSource === "task_workspace",
      permissionMode: this.config.permissionMode,
      defaultModel: this.config.defaultModel,
      maxConcurrency: this.config.maxConcurrency,
      circuitBreakers: [...this.breakers.values()],
      models: models.ok ? extractModelSlugs(models.stdout) : [],
      modelProbeError: models.ok ? undefined : models.error,
      activeJobs: [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "queued").length,
    };
  }

  public async startTask(input: { task: string; workspace: string; effort?: "low" | "medium" | "high"; timeoutSeconds?: number; model?: string; taskMode?: TaskMode; maxRetries?: number }): Promise<Record<string, unknown>> {
    await this.awaitMcpRootDiscovery();
    if (!input.task.trim()) throw new Error("Task must not be empty.");
    if (!input.workspace.trim()) throw new Error("Workspace must not be empty.");
    if (input.timeoutSeconds !== undefined && (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > this.config.defaultTimeoutSeconds)) {
      throw new Error(`timeoutSeconds must be a positive integer no greater than ${this.config.defaultTimeoutSeconds}.`);
    }
    if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > DEFAULT_READ_ONLY_MAX_RETRIES)) {
      throw new Error(`maxRetries must be an integer from 0 to ${DEFAULT_READ_ONLY_MAX_RETRIES}.`);
    }
    const taskMode = input.taskMode ?? "coding";
    if (taskMode !== "coding" && taskMode !== "read_only") throw new Error("taskMode must be either coding or read_only.");
    const model = input.model ?? this.config.defaultModel;
    this.assertModelAvailable(model);
    const usingTaskWorkspaceFallback = this.guard.getConfiguredRoots().length === 0;
    const workspace = await this.guard.assertAllowed(input.workspace, true);
    if (usingTaskWorkspaceFallback) this.taskWorkspace = workspace;
    const active = [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "queued");
    if (active.length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached.`);

    const id = this.createId();
    const folder = await this.mkdtempImpl(join(tmpdir(), "codexeni-"));
    const record: TaskRecord = {
      id,
      task: input.task,
      workspace,
      model,
      effort: input.effort ?? "high",
      timeoutSeconds: Math.min(input.timeoutSeconds ?? this.config.defaultTimeoutSeconds, this.config.defaultTimeoutSeconds),
      permissionMode: this.config.permissionMode,
      taskMode,
      maxRetries: taskMode === "read_only" ? input.maxRetries ?? DEFAULT_READ_ONLY_MAX_RETRIES : 0,
      retryCount: 0,
      retryable: false,
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
    return { jobId: id, status: record.status, warnings: record.warnings, workspace, model: record.model, taskMode: record.taskMode, maxRetries: record.maxRetries };
  }

  /**
   * Apply roots advertised by the connected MCP client. Environment roots are
   * intentionally immutable and take precedence over client-provided roots.
   */
  public async adoptMcpClientRoots(uris: readonly string[]): Promise<string[]> {
    if (this.config.allowedRoots.length > 0) return [...this.config.allowedRoots];
    const generation = ++this.rootRefreshGeneration;
    const roots = await canonicalizeMcpClientRoots(uris);
    if (generation !== this.rootRefreshGeneration) return [...this.guard.getConfiguredRoots()];
    this.guard.setConfiguredRoots(roots);
    this.allowedRootSource = roots.length > 0 ? "mcp_client" : "task_workspace";
    return roots;
  }

  /** Fall back to the requested task workspace when no MCP root is usable. */
  public clearMcpClientRoots(): void {
    if (this.config.allowedRoots.length > 0) return;
    this.rootRefreshGeneration += 1;
    this.guard.setConfiguredRoots([]);
    this.allowedRootSource = "task_workspace";
  }

  public getAllowedRootSource(): AllowedRootSource {
    return this.allowedRootSource;
  }

  public hasEnvironmentRoots(): boolean {
    return this.config.allowedRoots.length > 0;
  }

  /** Used by the MCP adapter so health/task requests cannot race a roots refresh. */
  public setMcpRootDiscovery(discovery: Promise<unknown>): void {
    this.pendingMcpRootDiscovery = discovery.then(
      () => undefined,
      () => { this.clearMcpClientRoots(); },
    );
  }

  public async awaitMcpRootDiscovery(): Promise<void> {
    await this.pendingMcpRootDiscovery;
  }

  public getTask(jobId: string, eventLimit = 50): Record<string, unknown> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    return compactRecord(record, Math.max(1, Math.min(eventLimit, MAX_EVENTS)));
  }

  public async cancelTask(jobId: string): Promise<Record<string, unknown>> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ID: ${jobId}`);
    if (record.status === "queued" && record.retryHandle) {
      this.cancelTimeout(record.retryHandle);
      record.retryHandle = undefined;
      record.nextRetryAt = undefined;
      record.forcedTerminalStatus = "canceled";
      record.status = "canceled";
      record.finishedAt = this.now().toISOString();
      return { jobId, status: record.status, canceled: true };
    }
    if (!record.child || record.status !== "running") return { jobId, status: record.status, canceled: false };
    record.cancellationRequested = true;
    record.forcedTerminalStatus = "canceled";
    await this.stopChildImpl(record.child);
    return { jobId, status: record.status, canceled: true };
  }

  public async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.retryHandle) {
        this.cancelTimeout(job.retryHandle);
        job.retryHandle = undefined;
        job.status = "orphaned";
        job.finishedAt = this.now().toISOString();
      }
    }
    await Promise.all([...this.jobs.values()].filter((job) => job.status === "running" && job.child).map(async (job) => {
      job.cancellationRequested = true;
      await this.stopChildImpl(job.child!);
    }));
  }

  private launch(record: TaskRecord): void {
    record.nextRetryAt = undefined;
    record.blockedUntil = undefined;
    record.conversationId = undefined;
    record.upstreamStatus = undefined;
    record.response = undefined;
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
    record.finishedAt = undefined;
    record.startedAt = this.now().toISOString();
    record.timeoutHandle = this.scheduleTimeout(() => {
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
    if (record.timeoutHandle) this.cancelTimeout(record.timeoutHandle);
    if (detail) record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${detail}`);
    const retryAfterMs = status === "failed" || status === "timed_out" ? this.classifyAndOpenCircuit(record) : undefined;
    try {
      if (record.beforeSnapshot) {
        const after = await snapshotWorkspace(record.workspace);
        record.fileChanges = diffSnapshots(record.beforeSnapshot, after.snapshot, after.truncated);
        record.partialChanges = status === "failed" || status === "timed_out" ? record.fileChanges : undefined;
        if (after.truncated) record.warnings.push("Post-task file snapshot reached its entry limit; change detection is partial.");
      }
    } catch (error) {
      record.warnings.push(`Could not collect changed files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.child = undefined;
      record.status = status;
      record.finishedAt = this.now().toISOString();
      record.finalizing = false;
      if (status === "succeeded") {
        this.breakers.delete(record.model);
        record.errorCategory = undefined;
        record.retryable = false;
        record.nextRetryAt = undefined;
        record.blockedUntil = undefined;
      } else {
        this.applyFailurePolicy(record, retryAfterMs);
      }
    }
  }

  private applyFailurePolicy(record: TaskRecord, classifiedRetryAfterMs?: number): void {
    if (record.status !== "failed" && record.status !== "timed_out") return;
    const explicitRetryAfterMs = classifiedRetryAfterMs;
    const fallbackDelay = explicitRetryAfterMs === undefined ? this.backoffMs(record.retryCount) : undefined;
    const categoryCanRetry = record.errorCategory === "rate_limited"
      || record.errorCategory === "session_limit"
      || record.errorCategory === "upstream_error";
    const noChanges = Boolean(record.partialChanges && !record.partialChanges.truncated && !hasWorkspaceChanges(record.partialChanges));
    record.retryable = record.taskMode === "read_only" && categoryCanRetry && noChanges && record.retryCount < record.maxRetries;
    if (!record.retryable) return;

    // A server-provided long delay is useful information for Codex, but it is
    // not an instruction for this local process to sleep indefinitely.
    if (explicitRetryAfterMs !== undefined && explicitRetryAfterMs > MAX_RETRY_AFTER_MS) {
      const retryAt = new Date(this.now().getTime() + explicitRetryAfterMs).toISOString();
      record.nextRetryAt = retryAt;
      record.blockedUntil = retryAt;
      record.retryable = false;
      record.warnings.push("Provider retry window exceeds five minutes; no automatic retry was scheduled.");
      return;
    }
    const delay = explicitRetryAfterMs ?? fallbackDelay!;
    record.retryCount += 1;
    record.nextRetryAt = new Date(this.now().getTime() + delay).toISOString();
    // A timeout stops its child before entering the retry queue. That internal
    // stop is not a user cancellation and must not prevent the fresh attempt.
    record.cancellationRequested = false;
    record.forcedTerminalStatus = undefined;
    record.status = "queued";
    record.retryHandle = this.scheduleTimeout(() => {
      record.retryHandle = undefined;
      if (record.status !== "queued" || record.cancellationRequested) return;
      void this.prepareRetryLaunch(record);
    }, delay);
  }

  private classifyAndOpenCircuit(record: TaskRecord): number | undefined {
    const failureContext = [record.stderrSummary, record.response, record.upstreamStatus, ...record.events.map((event) => event.data)];
    record.errorCategory = classifyFailure(failureContext) ?? "upstream_error";
    const retryAfterMs = parseRetryAfterMs(failureContext, this.now().getTime());
    if (record.errorCategory === "rate_limited" || record.errorCategory === "quota_exhausted") {
      this.openCircuit(record.model, record.errorCategory, retryAfterMs);
      const breaker = this.breakers.get(record.model);
      if (breaker) record.blockedUntil = breaker.blockedUntil;
    }
    return retryAfterMs;
  }

  private async prepareRetryLaunch(record: TaskRecord): Promise<void> {
    try {
      const snapshot = await snapshotWorkspace(record.workspace);
      record.beforeSnapshot = snapshot.snapshot;
      if (snapshot.truncated) record.warnings.push("Retry pre-task file snapshot reached its entry limit; change detection is partial.");
      record.stderrSummary = "";
      record.events = [];
      record.conversationId = undefined;
      record.response = undefined;
      record.usage = undefined;
      record.upstreamStatus = undefined;
      record.startedAt = undefined;
      record.finishedAt = undefined;
      record.pid = undefined;
      record.exitCode = undefined;
      record.signal = undefined;
      record.timeoutHandle = undefined;
      record.forcedTerminalStatus = undefined;
      record.cancellationRequested = false;
      record.fileChanges = undefined;
      record.partialChanges = undefined;
      record.errorCategory = undefined;
      record.retryable = false;
      record.nextRetryAt = undefined;
      this.launch(record);
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.now().toISOString();
      record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\nRetry setup failed: ${error instanceof Error ? error.message : String(error)}`);
      record.errorCategory = "upstream_error";
      record.retryable = false;
    }
  }

  private backoffMs(retryCount: number): number {
    const base = Math.min(15_000 * 2 ** retryCount, 120_000);
    const jitter = Math.floor(Math.min(Math.max(this.random(), 0), 1) * 5_000);
    return Math.min(base + jitter, MAX_RETRY_AFTER_MS);
  }

  private openCircuit(model: string, category: "rate_limited" | "quota_exhausted", retryAfterMs?: number): void {
    const now = this.now();
    const delay = retryAfterMs === undefined ? CIRCUIT_BREAKER_MS : Math.max(retryAfterMs, 1_000);
    const candidate: ModelCircuitBreaker = {
      model,
      category,
      openedAt: now.toISOString(),
      blockedUntil: new Date(now.getTime() + delay).toISOString(),
    };
    const existing = this.breakers.get(model);
    if (!existing || Date.parse(existing.blockedUntil) < Date.parse(candidate.blockedUntil)) this.breakers.set(model, candidate);
  }

  private expireBreakers(): void {
    const now = this.now().getTime();
    for (const [model, breaker] of this.breakers) if (Date.parse(breaker.blockedUntil) <= now) this.breakers.delete(model);
  }

  private assertModelAvailable(model: string): void {
    this.expireBreakers();
    const breaker = this.breakers.get(model);
    if (breaker) throw new Error(`Model ${model} is temporarily blocked after ${breaker.category} until ${breaker.blockedUntil}. Choose a later time; this bridge will not switch models or accounts automatically.`);
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
  workspace: z.string().min(1).describe("Absolute path of the current Codex workspace; in zero-config mode this exact canonical directory is the task boundary."),
  effort: z.enum(["low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().max(DEFAULT_TIMEOUT_SECONDS).optional(),
  model: z.string().min(1).max(200).optional(),
  taskMode: z.enum(["coding", "read_only"]).optional(),
  maxRetries: z.number().int().min(0).max(DEFAULT_READ_ONLY_MAX_RETRIES).optional(),
};

const jsonResult = (payload: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload as Record<string, unknown>, isError });

export interface McpRootsProvider {
  listRoots(): Promise<{ roots: Array<{ uri: string }> }>;
}

/** Request a fresh standard MCP roots/list response, retaining fail-closed behavior on any error. */
export async function refreshMcpClientRoots(runtime: AgyBridgeRuntime, client: McpRootsProvider): Promise<string[]> {
  if (runtime.hasEnvironmentRoots()) return [...runtime.config.allowedRoots];
  try {
    const response = await client.listRoots();
    return await runtime.adoptMcpClientRoots(Array.isArray(response?.roots) ? response.roots.map((root) => root?.uri).filter((uri): uri is string => typeof uri === "string") : []);
  } catch {
    runtime.clearMcpClientRoots();
    return [];
  }
}

/** Attach roots discovery only once the MCP initialization handshake has completed. */
export function configureMcpClientRootDiscovery(server: McpServer, runtime: AgyBridgeRuntime): () => Promise<string[]> {
  const refresh = () => refreshMcpClientRoots(runtime, server.server);
  server.server.oninitialized = () => {
    runtime.setMcpRootDiscovery(refresh());
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    runtime.setMcpRootDiscovery(refresh());
  });
  return refresh;
}

export function createMcpServer(runtime = new AgyBridgeRuntime()): McpServer {
  const server = new McpServer({ name: "codexeni", version: "0.1.0" });
  configureMcpClientRootDiscovery(server, runtime);
  server.registerTool("antigravity_health", { description: "Check the local Antigravity CLI bridge without reading credentials.", annotations: { readOnlyHint: true, openWorldHint: false } }, async () => jsonResult(await runtime.health()));
  server.registerTool("antigravity_start_task", { description: "Start an asynchronous Antigravity coding or read-only task. Full mode grants broad local tool access; the allowed-root check selects cwd but is not a security sandbox.", inputSchema: taskInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => {
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
