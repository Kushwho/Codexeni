/**
 * Shared type definitions used across the bridge runtime, adapters,
 * workspace utilities, and MCP server. Nothing here names a specific harness.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ToolCallObservation } from "./metrics.js";
import type { mkdtemp } from "node:fs/promises";

export type PermissionMode = "restricted" | "full";
export type JobStatus = "queued" | "running" | "awaiting_input" | "succeeded" | "failed" | "timed_out" | "canceled" | "orphaned";
export type TaskMode = "coding" | "read_only";
export type Effort = "low" | "medium" | "high";
export type ErrorCategory = "rate_limited" | "quota_exhausted" | "session_limit" | "context_limit" | "authentication" | "upstream_error";
export type AllowedRootSource = "environment" | "task_workspace";
/** What the harness itself reported about the run, independent of the process exit code. */
export type Outcome = "succeeded" | "failed" | "canceled";

/** Per-harness settings resolved from the environment; adapters supply the defaults. */
export interface HarnessSettings {
  executable?: string;
  defaultModel?: string;
}

export interface BridgeConfig {
  allowedRoots: string[];
  permissionMode: PermissionMode;
  defaultHarness: string;
  defaultTimeoutSeconds: number;
  maxConcurrency: number;
  harnesses: Record<string, HarnessSettings>;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type StopChildFunction = (child: ChildProcess) => Promise<void>;

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

/**
 * Token and cost figures normalized across harnesses. Every field is optional because
 * harnesses report different subsets — Claude Code reports a cost, Antigravity reports tokens only.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Reasoning tokens, when the harness reports them separately. */
  thinkingTokens?: number;
  /** The harness's own total, kept as reported rather than recomputed: harnesses disagree on what it includes. */
  totalTokens?: number;
  costUsd?: number;
  /**
   * Where costUsd came from. A harness-reported cost and one computed from a
   * price table must never be summed or compared without this flag.
   */
  costSource?: "harness" | "estimated";
}

/** A rate-limit or quota block. Keyed by harness and model because the same model can sit behind different quotas. */
export interface CircuitBreaker {
  key: string;
  harness: string;
  model: string;
  category: "rate_limited" | "quota_exhausted";
  openedAt: string;
  blockedUntil: string;
}

/** A bounded clarification requested by an interactive-capable worker. */
export interface InputRequest {
  summary?: string;
  /** Alias for summary that makes the partial-progress intent explicit to callers. */
  workSoFar?: string;
  question: string;
  options?: string[];
  recommendedOption?: string;
  category?: string;
}

/** The result contract requested from workers that support structured output. */
export interface WorkerResult {
  status: "completed" | "input_required";
  summary?: string;
  question?: string;
  options?: string[];
  recommendedOption?: string;
  category?: string;
}

export interface TaskRecord {
  id: string;
  /** Which harness adapter runs this task. */
  harness: string;
  task: string;
  workspace: string;
  model?: string;
  effort: Effort;
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
  /** Harness-side conversation/thread/session identifier when one is reported. */
  sessionId?: string;
  /** Harness-side conversation identifier. Kept separately for explicit continuation support. */
  conversationId?: string;
  /** A pending clarification from the worker, if the process exited awaiting an answer. */
  inputRequest?: InputRequest;
  /** Number of clarification answers submitted to this task. */
  inputRounds: number;
  /** Prior clarification questions, used to stop an answer loop safely. */
  inputQuestionHistory: string[];
  /** Final assistant text reported by the harness. */
  summary?: string;
  usage?: Usage;
  /** Every tool observation the adapter reported, in arrival order. Accumulated, never overwritten. */
  toolCalls?: ToolCallObservation[];
  /** Turn count when the harness reports one. */
  turns?: number;
  outcome?: Outcome;
  outcomeDetail?: string;
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
