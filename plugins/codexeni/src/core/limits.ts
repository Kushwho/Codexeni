/**
 * Fixed safety limits, deliberately not environment-configurable — they bound
 * what one process may do regardless of harness. User settings live in config.ts.
 */
export const LIMITS = {
  /** Local ceiling on simultaneous jobs; BRIDGE_MAX_CONCURRENCY is clamped to this. */
  maxConcurrency: 4,
  /** Only no-change read-only tasks may retry, and never more than this many times. */
  readOnlyMaxRetries: 2,
  /** A provider retry window longer than this is reported to the caller, never slept on. */
  maxRetryAfterMs: 5 * 60_000,
  /** Default block after a rate-limit or quota failure when the provider gives no window. */
  circuitBreakerMs: 5 * 60_000,
  /** Events retained per job in memory and returnable by delegate_status. */
  maxEvents: 200,
  /** A task may ask for at most this many clarification answers. */
  maxInputRounds: 3,
  /** Bound the answer passed back into a worker continuation prompt. */
  maxInputAnswerChars: 8_000,
  /** Keep worker-provided clarification choices reasonably small. */
  maxInputOptions: 10,
  /** Longest string kept from any single child-output value. */
  maxEventChars: 8_000,
  /** Whole-stdout buffer kept for adapters that interpret one document rather than JSON lines. */
  maxStdoutChars: 1_000_000,
  /** Files inspected when snapshotting a workspace for change detection. */
  snapshotMaxEntries: 20_000,
  /** Time allowed for a harness probe command such as `--version`. */
  probeTimeoutMs: 8_000,
  /** Reuse harness discovery probes briefly instead of repeatedly spawning their CLIs. */
  discoveryCacheMs: 60_000,
  /** Fallback retry backoff for read-only tasks when the provider gives no window. */
  backoffBaseMs: 15_000,
  backoffCapMs: 120_000,
  backoffJitterMs: 5_000,
  /** Directories never included in change detection; changes inside them are blind spots. */
  excludedSnapshotDirectories: [".git", "node_modules", ".next", ".pnpm-store", "dist", "build", ".cache", "coverage", "test-results"],
  /** How long a minted MRTR requestState stays valid. */
  inputRequestStateTtlSeconds: 900,
  /** Cap on tracked single-use nonces. */
  maxPendingInputStates: 1000,
  /** Longest a delegate_status waitSeconds call may block: covers the default 900s job timeout with margin under Claude Code's ~30-minute stdio idle-timeout default. */
  maxStatusWaitSeconds: 1500,
  /** Poll granularity for a delegate_status wait; invisible to the caller. */
  statusWaitPollMs: 250,
} as const;
