#!/usr/bin/env node
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare const DEFAULT_MODEL = "gemini-3.7-flash-high";
export declare const DEFAULT_TIMEOUT_SECONDS = 900;
export declare const DEFAULT_MAX_CONCURRENCY = 4;
export declare const DEFAULT_READ_ONLY_MAX_RETRIES = 2;
export declare const MAX_RETRY_AFTER_MS: number;
export declare const CIRCUIT_BREAKER_MS: number;
export type PermissionMode = "restricted" | "full";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled" | "orphaned";
export type TaskMode = "coding" | "read_only";
export type ErrorCategory = "rate_limited" | "quota_exhausted" | "session_limit" | "context_limit" | "authentication" | "upstream_error";
export type AllowedRootSource = "environment" | "mcp_client" | "unconfigured";
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
/** Resolve all environment configuration without looking at credential files. */
export declare function resolveBridgeConfig(env?: NodeJS.ProcessEnv): BridgeConfig;
export declare function canonicalizeWorkspace(workspace: string): Promise<string>;
/** Convert a local MCP Root URI to a path. Remote hosts and malformed URIs are never accepted. */
export declare function fileUriToLocalPath(uri: string): string | undefined;
/**
 * Resolve only existing directory roots supplied by an MCP client. Canonical
 * paths are de-duplicated so URI spelling and symlink aliases cannot widen a
 * task's effective allowed-root set.
 */
export declare function canonicalizeMcpClientRoots(uris: readonly string[]): Promise<string[]>;
/** Includes the root itself and resists prefix tricks such as C:\\safe-other. */
export declare function isPathWithinRoot(candidate: string, root: string): boolean;
export declare class WorkspaceGuard {
    private configuredRoots;
    constructor(configuredRoots: readonly string[]);
    setConfiguredRoots(roots: readonly string[]): void;
    getConfiguredRoots(): readonly string[];
    canonicalRoots(): Promise<string[]>;
    assertAllowed(workspace: string): Promise<string>;
}
export declare function buildAgyArgs(input: {
    task: string;
    workspace?: string;
    model: string;
    effort: "low" | "medium" | "high";
    permissionMode: PermissionMode;
    taskMode?: TaskMode;
}): string[];
export declare function buildDelegationPrompt(task: string, workspace?: string, taskMode?: TaskMode): string;
/** Parse one child-output line; malformed output is preserved as text rather than fatal. */
export declare function parseNdjsonLine(line: string, timestamp?: string): StreamEvent | undefined;
export declare function snapshotWorkspace(workspace: string, maxEntries?: number): Promise<{
    snapshot: WorkspaceSnapshot;
    truncated: boolean;
}>;
export declare function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, truncated?: boolean): FileChanges;
/** Classify provider failures without relying on a single unstable CLI schema. */
export declare function classifyFailure(value: unknown): ErrorCategory | undefined;
/** Returns a provider-directed wait when present, including reset timestamps. */
export declare function parseRetryAfterMs(value: unknown, now?: number): number | undefined;
export declare class AgyBridgeRuntime {
    readonly config: BridgeConfig;
    readonly jobs: Map<string, TaskRecord>;
    readonly breakers: Map<string, ModelCircuitBreaker>;
    private allowedRootSource;
    private rootRefreshGeneration;
    private pendingMcpRootDiscovery;
    private readonly guard;
    private readonly spawnImpl;
    private readonly stopChildImpl;
    private readonly now;
    private readonly random;
    private readonly scheduleTimeout;
    private readonly cancelTimeout;
    private readonly mkdtempImpl;
    private readonly createId;
    constructor(dependencies?: RuntimeDependencies);
    health(): Promise<Record<string, unknown>>;
    startTask(input: {
        task: string;
        workspace: string;
        effort?: "low" | "medium" | "high";
        timeoutSeconds?: number;
        model?: string;
        taskMode?: TaskMode;
        maxRetries?: number;
    }): Promise<Record<string, unknown>>;
    /**
     * Apply roots advertised by the connected MCP client. Environment roots are
     * intentionally immutable and take precedence over client-provided roots.
     */
    adoptMcpClientRoots(uris: readonly string[]): Promise<string[]>;
    /** Fail closed when the MCP client cannot provide a current usable root list. */
    clearMcpClientRoots(): void;
    getAllowedRootSource(): AllowedRootSource;
    hasEnvironmentRoots(): boolean;
    /** Used by the MCP adapter so health/task requests cannot race a roots refresh. */
    setMcpRootDiscovery(discovery: Promise<unknown>): void;
    awaitMcpRootDiscovery(): Promise<void>;
    getTask(jobId: string, eventLimit?: number): Record<string, unknown>;
    cancelTask(jobId: string): Promise<Record<string, unknown>>;
    shutdown(): Promise<void>;
    private launch;
    private captureStream;
    private recordEvent;
    private finalize;
    private applyFailurePolicy;
    private classifyAndOpenCircuit;
    private prepareRetryLaunch;
    private backoffMs;
    private openCircuit;
    private expireBreakers;
    private assertModelAvailable;
    private capture;
}
export declare function extractModelSlugs(output: string): string[];
export declare function parseAuthenticationStatus(output: string): "authenticated" | "unauthenticated" | "unknown";
export interface McpRootsProvider {
    listRoots(): Promise<{
        roots: Array<{
            uri: string;
        }>;
    }>;
}
/** Request a fresh standard MCP roots/list response, retaining fail-closed behavior on any error. */
export declare function refreshMcpClientRoots(runtime: AgyBridgeRuntime, client: McpRootsProvider): Promise<string[]>;
/** Attach roots discovery only once the MCP initialization handshake has completed. */
export declare function configureMcpClientRootDiscovery(server: McpServer, runtime: AgyBridgeRuntime): () => Promise<string[]>;
export declare function createMcpServer(runtime?: AgyBridgeRuntime): McpServer;
export declare function runStdioServer(): Promise<void>;
