# Codexeni code walkthrough

This is a plain-English tour of the code in `plugins/codexeni`. It is written for someone who is new to TypeScript and finds reading the source hard going. Every time a TypeScript idea shows up for the first time, it is explained in one line right there, so you can read top to bottom without needing outside references.

## 1. The big picture

Codexeni is a small server. Its job is to let one coding-agent app (Claude Code, Codex, or Antigravity — this project calls each of these a "harness") hand off a bounded task to another harness installed on the same computer, and get back a result: status, a summary, token usage, which files changed, warnings, an error category, and recent output events. It talks over MCP (Model Context Protocol), a standard way for an AI app to call "tools" on another program. The harness that asks for help is the orchestrator; the harness that does the work is the worker.

Every harness can play either or both of two roles. A **host** runs Codexeni itself, as its own MCP server, and calls the `delegate_*` tools — this project also calls that harness the orchestrator. A **worker** is a harness Codexeni can start as a subagent to actually run a task. Claude Code can be both at once: hosting Codexeni's tools in one session while also being available as a worker Codexeni starts as a subagent from any host. Antigravity is currently a worker only; Codex is currently a host only. [`docs/architecture.md`](architecture.md) has the full breakdown of the two roles; this file stays focused on the code.

Here is the life of one delegated task, in order:

1. The orchestrator calls the `delegate_start` tool, describing the task and a workspace folder.
2. The runtime (the harness-neutral core of this project) checks the request — is the workspace allowed, is a harness slot free, is the model not currently blocked — and records a new job.
3. An adapter (a small file that knows one harness's exact command line) builds the command to run.
4. The runtime starts that command as a child process — this actually launches the worker harness's CLI.
5. As the worker prints output, one line at a time, the runtime parses each line.
6. The adapter interprets each parsed line to pull out things like a summary, token usage, or "the task is done."
7. When the process exits, the runtime finalizes the job (records changed files, decides success/failure, maybe schedules a retry) and later reports all of this back through `delegate_status`.

The project was deliberately split this way. An earlier version of this code only knew how to talk to one harness, Antigravity, and its command-building and output-parsing logic was mixed into the core. This version pulls all of that harness-specific knowledge out into small "adapter" files, so the core never needs to know the word "Antigravity" — or "Claude Code" — at all. A later pass split the core itself into `core/`, `platform/`, `runtime/`, and `app/` folders by responsibility, once "the core" had grown past a handful of files; that split is what section 2 and 3 below describe.

## 2. Map of the files

| File | Purpose | Layer |
| --- | --- | --- |
| `src/core/types.ts` | Shared shapes (types) used by every other file | core |
| `src/core/limits.ts` | Fixed safety numbers that are not user-configurable | core |
| `src/core/prompt.ts` | Builds the instruction text sent to the worker | core |
| `src/core/redaction.ts` | Strips secret-shaped text before it is logged, stored, or returned | core |
| `src/core/value.ts` | One tiny type-narrowing helper (`isRecord`), shared by nearly every other file | core |
| `src/core/usage.ts` | Turns different harnesses' token-count field names into one shape | core |
| `src/core/failure.ts` | Default rules for reading an error and deciding a retry delay | core |
| `src/platform/config.ts` | Reads user-configurable settings from environment variables | platform |
| `src/platform/process.ts` | Cross-platform child-process spawning and killing primitives | platform |
| `src/platform/workspace.ts` | Path-safety checks and before/after file snapshots | platform |
| `src/runtime/events.ts` | Parses and sanitizes one line of child output; shapes a job record for replies | runtime |
| `src/runtime/discovery.ts` | Short-lived cache for expensive harness probes | runtime |
| `src/runtime/retry-policy.ts` | Decides whether a failed job is worth an automatic retry, and how long to wait | runtime |
| `src/runtime/task-lifecycle.ts` | Owns one worker process from launch through output capture to final status | runtime |
| `src/runtime/bridge-runtime.ts` | `BridgeRuntime`, the class that runs the whole show | runtime |
| `src/adapters/adapter.ts` | The contract every harness adapter must satisfy | core (contract) |
| `src/adapters/antigravity.ts` | The adapter that knows the `agy` CLI | adapter |
| `src/adapters/claude-code.ts` | The adapter that knows the `claude` CLI | adapter |
| `src/adapters/index.ts` | The single list of which adapters actually exist | wiring |
| `src/app/mcp-server.ts` | Turns runtime methods into the four MCP tools | app |
| `src/app/entry.ts` | Starts the actual program (builds and connects the server) | app |
| `src/index.ts` | Re-exports everything as the package's public surface | wiring |

## 3. File by file

### Core (`src/core/`)

Shapes, fixed numbers, and small pure functions that never name a specific harness — the layer every other layer is built on.

#### types.ts

**What it's for, and why its own file.** No logic here — only shapes: what fields a job record has, what a task mode can be, what a circuit breaker looks like. Nothing in this file names a specific harness. Keeping every shape in one place means every other file is checked against the same definition by the compiler, instead of two files quietly disagreeing until something crashes; it is also how the project's "no harness-specific code in the core" rule stays honest — you can scan this one file and see no field named after a product.

**Main exports.** Union-type aliases (`PermissionMode`, `JobStatus`, `TaskMode`, `Effort`, `ErrorCategory`, `AllowedRootSource`, `Outcome`); shape interfaces (`HarnessSettings`, `BridgeConfig`, `RuntimeDependencies`, `StreamEvent`, `FileSnapshotEntry`, `WorkspaceSnapshot`, `FileChanges`, `Usage`, `CircuitBreaker`, `TaskRecord`); function-shape aliases (`SpawnFunction`, `StopChildFunction`).

```ts
export type PermissionMode = "restricted" | "full";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled" | "orphaned";
export type TaskMode = "coding" | "read_only";
export type Effort = "low" | "medium" | "high";
export type ErrorCategory = "rate_limited" | "quota_exhausted" | "session_limit" | "context_limit" | "authentication" | "upstream_error";
```

- `export` makes a name importable from other files; without it, a name stays private to its own file. `type X = ...` is a "type alias" — a name for a shape that produces no actual code, existing only so the compiler can check your work. `"restricted" | "full"` is a "union type" (`|` means "or"): a `PermissionMode` value must be exactly one of the listed strings, so a typo like `"Full"` fails the build before the program ever runs — `JobStatus`, similarly, lists every state a job can ever be in.

```ts
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
```

- An `interface` is close to a `type` alias but specifically describes what fields an object must have — also producing no code, only compiler checks. The `?` after `executable`/`defaultModel` makes each field optional: an object of this shape may leave it out entirely.
- `Record<string, HarnessSettings>` is a generic — a type parameterized by another type, in angle brackets — meaning "an object whose keys are strings and whose values are `HarnessSettings`," here mapping harness ids like `"antigravity"` or `"claude-code"` to their settings; `WorkspaceSnapshot = Map<string, FileSnapshotEntry>` (seen further down) is another generic, a built-in `Map<K, V>` pairing a file's relative path with its size and modified time. This file's own import, `import type { ChildProcess, SpawnOptions } from "node:child_process";`, uses `import type` — borrowing a name only for type-checking; it is deleted entirely before the real JavaScript runs, since it has no effect there.

#### limits.ts

**What it's for, and why its own file.** Fixed safety numbers — how many jobs can run at once, how many retries are allowed, how long an event tail is kept — deliberately not something a user can change with an environment variable. Keeping them in one object makes every safety bound visible at a glance, and keeps this file explicitly separate from `platform/config.ts`: these are limits regardless of which harness runs the work, while `config.ts` holds settings the user is meant to tune.

**Main export.** A single object, `LIMITS`, with far more fields than the two shown below — concurrency, retry counts and backoff, event/log sizing, snapshot bounds, probe and discovery-cache timeouts, and which directories change detection ignores.

```ts
export const LIMITS = {
  /** Local ceiling on simultaneous jobs; BRIDGE_MAX_CONCURRENCY is clamped to this. */
  maxConcurrency: 4,
  /** Only no-change read-only tasks may retry, and never more than this many times. */
  readOnlyMaxRetries: 2,
  // ...
} as const;
```

- `as const` tells TypeScript to treat every value here as fixed and exactly this value, rather than the general type it would otherwise guess (like `number`). One side effect: every field also becomes `readonly` — code elsewhere that tried `LIMITS.maxConcurrency = 10` would fail to build.

#### prompt.ts

**What it's for, and why its own file.** Builds the instruction text sent to the worker — the same wording no matter which harness runs it — keeping safety instructions ("stay inside this folder," "do not read credentials") in exactly one place instead of duplicated inside every adapter's `command()` method. An adapter only decides how to hand this finished text to its CLI (a flag, or the process's stdin) — never what the text says.

**Main export.** `buildDelegationPrompt(task, workspace, taskMode)`.

```ts
export function buildDelegationPrompt(task: string, workspace: string | undefined, taskMode: TaskMode): string {
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
```

- Builds an array of lines and joins them with newlines into one string. `` `Your workspace is exactly: ${workspace}` `` is a template literal (backticks, splicing a variable in with `${...}`) rather than string concatenation. `...(taskMode === "read_only" ? [...] : [])` only adds the read-only warning line when the task really is read-only; otherwise it contributes nothing to the array.

#### redaction.ts

**What it's for, and why its own file.** Two tiny, stateless exports used everywhere that untrusted or secret-shaped text might end up logged, stored, or returned — separated from `runtime/events.ts` so this piece has no dependency on the job-record shapes that live in `runtime/`, and other files (like `platform/process.ts`, which sanitizes probe output) can import it without pulling in the runtime layer at all.

**Main exports.** `redactPotentialSecrets(value)`, `SENSITIVE_FIELD_NAME`.

```ts
export function redactPotentialSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(-8_000);
}

export const SENSITIVE_FIELD_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)/i;
```

- `redactPotentialSecrets` replaces anything that looks like `api_key: abc123` with `api_key=[redacted]`, and keeps only the last 8,000 characters (so a long, noisy stderr stream cannot grow forever). Applied to stderr, error messages, and probe results before they are stored or returned. `SENSITIVE_FIELD_NAME` is a separate regular expression (a pattern matcher for text) used to redact whole JSON *field names*, not just labeled text — see `sanitizeEventData` in `runtime/events.ts` below.

#### value.ts

**What it's for, and why its own file.** One function, small enough to feel like it should live somewhere else — but it is imported from `core/failure.ts`, `runtime/events.ts`, and both worker adapters, so giving it its own file avoids picking any one of those as its "real" home.

**Main export.** `isRecord(value)`.

```ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```

- The return type `value is Record<string, unknown>` is a "type predicate" — it tells TypeScript that everywhere this function returns `true`, the checked value can safely be treated as `Record<string, unknown>` (a plain object with string keys and unknown-typed values) for the rest of that code path, without an explicit cast. `unknown` is a type that could be anything; unlike `any`, TypeScript still forces you to narrow or check it — with a function exactly like this one — before you can use it as a specific shape.

#### usage.ts

**What it's for, and why its own file.** Different harnesses name their token counts differently — `input_tokens`, `inputTokens`, `prompt_tokens` all mean roughly the same thing. This file turns whichever one shows up into one shared `Usage` shape, so this field-name knowledge stays out of every adapter's `interpret()` method and out of the runtime entirely. The current file also normalizes cache-token field names (`cache_read_input_tokens`/`cacheReadTokens`, `cache_creation_input_tokens`) into `cacheReadTokens`/`cacheWriteTokens`, using the same pattern shown below.

**Main export.** `normalizeUsage(raw)`.

```ts
const inputTokens = asNumber(record.input_tokens ?? record.inputTokens ?? record.prompt_tokens);
const outputTokens = asNumber(record.output_tokens ?? record.outputTokens ?? record.completion_tokens);
const costUsd = asNumber(record.total_cost_usd ?? record.cost_usd ?? record.costUsd);
if (inputTokens !== undefined) usage.inputTokens = inputTokens;
if (outputTokens !== undefined) usage.outputTokens = outputTokens;
if (costUsd !== undefined) usage.costUsd = costUsd;
return Object.keys(usage).length > 0 ? usage : undefined;
```

- Each `??` chain tries several possible field names in order and keeps the first one present. The function returns `undefined` — not an empty object — when nothing was found, so callers can tell "no usage was reported" apart from "usage was all zero."

#### failure.ts

**What it's for, and why its own file.** Default rules for turning error text into one of the `ErrorCategory` buckets, and for figuring out a retry delay, when a harness's adapter does not override this behavior. Its own top comment explains the reasoning: rate-limit, quota, context, and authentication wording is similar across providers, so one shared implementation covers every harness — a harness supplies its own version, via the optional `classifyFailure`/`retryAfterMs` on `HarnessAdapter`, only when its wording genuinely differs. The Claude Code adapter is the first one that does this (see below).

**Main exports.** `defaultClassifyFailure(context)`, `defaultRetryAfterMs(context, nowMs)`.

```ts
export function defaultClassifyFailure(context: unknown): ErrorCategory | undefined {
  const normalized = asText(context).toLowerCase();
  if (/(?:unauthenticated|not authenticated|login required|session expired|invalid (?:auth|credential)|authentication failed)/.test(normalized)) return "authentication";
  if (/(?:session limit|too many sessions|concurrent sessions|session[_ -]?limit)/.test(normalized)) return "session_limit";
  if (/(?:context limit|context window|token limit|maximum (?:context|tokens)|too many tokens|prompt is too long)/.test(normalized)) return "context_limit";
  if (/(?:quota (?:exceeded|exhausted)|quota_exhausted|out of credits|credits? exhausted|resource[_ -]?exhausted)/.test(normalized)) return "quota_exhausted";
  if (/(?:\b429\b|http[_ ]?429|rate[ _-]?limit(?:ed)?|too many requests|resource exhausted)/.test(normalized)) return "rate_limited";
  if (/(?:\b5\d\d\b|upstream|service unavailable|internal error|network error|connection (?:reset|refused|timed out))/i.test(normalized)) return "upstream_error";
  return undefined;
}
```

- Lower-cases the combined error text and checks it against one regular expression per category (a pattern matcher for text), returning the first category that matches. `undefined` means nothing matched; `bridge-runtime.ts` then falls back to `"upstream_error"` itself.

`defaultRetryAfterMs(context, nowMs)` sits below it in the same file — a longer function this walkthrough does not reproduce line by line. It looks for a provider-reported wait, in several shapes (a nested `retryAfterMs`/`retryAfter` field on a structured error object, a `Retry-After` text line in seconds or as an HTTP date, a `reset`/`retryAt`/`blockedUntil` timestamp) and returns however many milliseconds remain until then, or `undefined` if the context contains no such hint. `HarnessAdapter.retryAfterMs` lets an adapter override this the same way `classifyFailure` does.

### Platform (`src/platform/`)

Everything that talks to the operating system or the environment: reading settings, spawning and killing processes, and checking paths.

#### config.ts

**What it's for, and why its own file.** Reads the settings a user is allowed to change, from environment variables such as `BRIDGE_ALLOWED_ROOTS`, honoring older `AGY_BRIDGE_*` names as fallbacks. The file's own top comment says it directly: every variable the bridge reads is declared here, "so nothing else touches process.env" — every other file gets a plain, already-validated `BridgeConfig` object instead of parsing raw environment strings itself.

**Main exports.** `DEFAULT_HARNESS`, `DEFAULT_TIMEOUT_SECONDS`, `CORE_ENV`, `LEGACY_HARNESS_ENV`, `parsePositiveInt`, `resolveHarnessSettings`, `resolveBridgeConfig`.

```ts
function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function firstEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = nonEmpty(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}
```

- `function nonEmpty(...) { ... }` is an ordinary function declaration, written with the word `function`. `value?.trim()` uses `?.` ("optional chaining"): if `value` is `null`/`undefined`, the expression stops and produces `undefined` instead of crashing; otherwise it calls `.trim()` normally. `firstEnv` tries each name in order (a core name, then its legacy alias) and returns the first one actually set. This is also the first file to import from another local file: `import { LIMITS } from "../core/limits.js";` — the real file on disk is `limits.ts`, not `.js`, but every local import in this project ends in `.js` anyway, because Node runs the compiled `.js` files and the project's TypeScript settings require imports to already be written the way they will look after the build; the `.js` you see names the file after the build, not before it.

```ts
const HARNESS_ENV_PATTERN = /^BRIDGE_([A-Z0-9_]+)_(PATH|MODEL)$/;
```

```ts
export function resolveHarnessSettings(env: NodeJS.ProcessEnv = process.env): Record<string, HarnessSettings> {
  const harnesses: Record<string, HarnessSettings> = {};
  const assign = (harness: string, setting: keyof HarnessSettings, value: string | undefined): void => {
    if (value === undefined) return;
    const entry = (harnesses[harness] ??= {});
    if (entry[setting] === undefined) entry[setting] = value;
  };
  for (const [name, value] of Object.entries(env)) {
    const match = HARNESS_ENV_PATTERN.exec(name);
    if (match) assign(match[1].toLowerCase().replace(/_/g, "-"), match[2] === "PATH" ? "executable" : "defaultModel", nonEmpty(value));
  }
  for (const legacy of LEGACY_HARNESS_ENV) assign(legacy.harness, legacy.setting, nonEmpty(env[legacy.name]));
  return harnesses;
}
```

- `const assign = (harness, setting, value) => { ... }` is an "arrow function" — a shorter way of writing a function without the word `function` — assigned here to the local constant `assign`; it runs once per matching `BRIDGE_<HARNESS>_PATH`/`_MODEL` variable, and again for each legacy name, so a harness's explicit `BRIDGE_*` value always wins over its older alias. `??=` (in `harnesses[harness] ??= {}`) is `??` combined with assignment: it sets `harnesses[harness]` to `{}` only when currently `null`/`undefined`, then reuses it. Plain `??` ("nullish coalescing"), used elsewhere in this file as `firstEnv(...) ?? DEFAULT_HARNESS`, means the same without the assignment: "if the left side is `null`/`undefined`, use the right side" — unlike `||`, which would also replace an empty string or `0`.
- This is the important part for adding a new worker: `HARNESS_ENV_PATTERN` scans **every** environment variable shaped like `BRIDGE_<ANYTHING>_PATH` or `BRIDGE_<ANYTHING>_MODEL` and turns the `<ANYTHING>` part into a harness id — `match[1].toLowerCase().replace(/_/g, "-")` turns `CLAUDE_CODE` into `claude-code`, matching `ClaudeCodeAdapter.id`. This file never lists `"antigravity"` or `"claude-code"` by name; a brand-new adapter's `BRIDGE_<ID>_PATH`/`BRIDGE_<ID>_MODEL` variables are picked up automatically, with no change needed here.

#### process.ts

**What it's for, and why its own file.** Cross-platform process primitives — starting a short-lived probe command and killing a process tree — with no knowledge of jobs, adapters, or harnesses. Separating this from `runtime/task-lifecycle.ts` (which owns the *long-lived* worker process for a task) keeps "how do I run *any* child process safely on Windows and POSIX" in one small, easily tested place.

**Main exports.** `stopChildProcess(child)`, `captureCommand(spawnImpl, stopImpl, command, args, timeoutMs)`.

```ts
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
```

- On Windows, killing just the direct child does not reliably kill the whole process tree a CLI may have spawned underneath it, so this shells out to `taskkill /t /f` (`/t` = kill the whole tree, `/f` = force) instead. On POSIX, `process.kill(-child.pid, ...)` — a *negative* pid — sends the signal to the whole process group at once, which only works because `runtime/task-lifecycle.ts` starts the child with `detached: true` on non-Windows. Either branch falls back to a plain `child.kill("SIGTERM")` if the tree-kill attempt itself fails to start.

`captureCommand(...)` is used only for short probe commands (like `agy --version` or `claude auth status --json`), never for a real task: it spawns, buffers stdout/stderr, enforces a timeout, and redacts both streams through `redactPotentialSecrets` from `core/redaction.ts` before resolving.

#### workspace.ts

**What it's for, and why its own file.** Everything about "where is this task allowed to touch" and "what files changed while it ran." Path-safety logic is easy to get subtly wrong — symlinks, case-folding on Windows, `..\` tricks — so keeping it in one file means every "is this workspace allowed" check goes through the same audited function, `isPathWithinRoot`, instead of being reinvented per call site.

**Main exports.** `canonicalizeWorkspace`, `fileUriToLocalPath`, `canonicalizeMcpClientRoots`, `isPathWithinRoot`, the `WorkspaceGuard` class, `snapshotWorkspace`, `diffSnapshots`.

```ts
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const candidateComparable = comparablePath(candidate);
  const rootComparable = comparablePath(root);
  const pathFromRoot = relative(rootComparable, candidateComparable);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.includes(`..${sep}`) && !pathFromRoot.startsWith(sep));
}
```

- `relative(root, candidate)` computes the path from `root` to reach `candidate`; if it starts with `..`, the candidate is outside the root. Returns `true` only when the candidate is the root itself or reachable from it without stepping "up and out."

```ts
export class WorkspaceGuard {
  private configuredRoots: string[];

  public constructor(configuredRoots: readonly string[]) {
    this.configuredRoots = [...configuredRoots];
  }
```

- `private` on `configuredRoots` means only this class's own methods may read or change it — outside code goes through `setConfiguredRoots`/`getConfiguredRoots`. `assertAllowed(workspace)` (used by `bridge-runtime.ts`) canonicalizes the requested workspace and confirms it sits inside a configured root, throwing otherwise. `snapshotWorkspace(workspace)` walks the folder recursively (skipping `.git`, `node_modules`, `dist`, ...), recording each file's size and modified time; `diffSnapshots(before, after)` compares two snapshots into `created`/`modified`/`deleted`.

### Runtime (`src/runtime/`)

Bridge state: turning a start request into a running, tracked job, reading its output, and deciding what happens when it ends. This used to be one file, `runtime.ts`; it is now five, split by responsibility, with `bridge-runtime.ts` as the public facade the rest of the program talks to.

#### events.ts

**What it's for, and why its own file.** Everything about reading and shaping one job's output: sanitizing a raw JSON value before it is kept or returned, parsing one line of child output, and compacting a full `TaskRecord` into the smaller object `delegate_status` actually replies with. It also re-exports `redactPotentialSecrets`, `SENSITIVE_FIELD_NAME`, and `isRecord` from `core/`, so `task-lifecycle.ts` and other runtime files can import everything they need about "one event" from a single place.

**Main exports.** `sanitizeEventData`, `parseJsonLine`, `hasWorkspaceChanges`, `compactRecord`, plus the re-exported `redactPotentialSecrets`, `SENSITIVE_FIELD_NAME`, `isRecord`.

```ts
export function sanitizeEventData(value: unknown, depth = 0): unknown {
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
  return String(value).slice(0, LIMITS.maxEventChars);
}
```

- Walks a JSON value recursively (calling itself again for arrays and nested objects — this is "recursion"), redacting string values and any field whose *name* looks sensitive (`SENSITIVE_FIELD_NAME`, from `core/redaction.ts`), while bounding both array length and object key count to 100 and recursion depth to 8, so a hostile or buggy worker cannot balloon memory with a deeply nested or enormous event.

```ts
export function parseJsonLine(line: string, timestamp: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const data: unknown = JSON.parse(trimmed);
    const eventType = isRecord(data) ? data.event ?? data.type : undefined;
    return { timestamp, type: typeof eventType === "string" ? eventType : "event", data };
  } catch {
    return { timestamp, type: "unparsed_output", data: trimmed.slice(0, LIMITS.maxEventChars) };
  }
}
```

- Every supported harness streams one JSON object per line (NDJSON, short for newline-delimited JSON). Tries to parse a line as JSON; if that fails, it keeps the raw text anyway, tagged `"unparsed_output"`, rather than dropping it.

```ts
export function compactRecord(record: TaskRecord, eventLimit: number): Record<string, unknown> {
  const finished = record.finishedAt ? new Date(record.finishedAt).getTime() : Date.now();
  const started = record.startedAt ? new Date(record.startedAt).getTime() : new Date(record.createdAt).getTime();
  return {
    jobId: record.id,
    harness: record.harness,
    model: record.model,
    status: record.status,
    // ...
    events: record.events.slice(-eventLimit),
  };
}
```

- Turns the full, internal `TaskRecord` (which also carries the live `ChildProcess`, timer handles, and the raw before/after file snapshots) into the plain, JSON-safe object `delegate_status` actually returns, keeping only the last `eventLimit` events.

#### discovery.ts

**What it's for, and why its own file.** `delegate_discover` has to ask every registered adapter's CLI "are you installed? are you logged in? what models do you support?" — and a real check like `agy --version` or `claude --version` is comparatively slow to run on every single call. This file is a small, generic cache that remembers the last probe result per harness id for a short time, so repeated `delegate_discover` calls in one session do not each spawn a fresh process, while `{ refresh: true }` can still force a real check.

**Main export.** The `DiscoveryCache<T>` class.

```ts
export class DiscoveryCache<T> {
  private readonly cached = new Map<string, { value: T; expiresAtMs: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  public constructor(
    private readonly nowMs: () => number,
    private readonly ttlMs: number,
  ) {}
```

- `class DiscoveryCache<T>` is a *generic* class: `T` is a placeholder type filled in wherever the class is used — `bridge-runtime.ts` creates a `DiscoveryCache<HarnessProbe>`, so every value it stores and returns is typed as one adapter's `HarnessProbe`. The constructor here uses a shorthand this project has not used before: writing `private readonly nowMs: () => number` directly as a constructor parameter both declares a class field named `nowMs` *and* assigns it from the matching argument, with no `this.nowMs = nowMs;` line needed inside the body — TypeScript calls these "parameter properties." `() => number` is a function-shape type: "a function taking no arguments and returning a number" — here, a clock the caller controls, so tests can fake the passage of time instead of waiting on the real one.

```ts
  public async get(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
    const cached = this.cached.get(key);
    if (!refresh && cached && cached.expiresAtMs > this.nowMs()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const probe = load();
    this.pending.set(key, probe);
    try {
      const value = await probe;
      this.cached.set(key, { value, expiresAtMs: this.nowMs() + this.ttlMs });
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
```

- Returns the cached value when it exists, is not expired, and a refresh was not explicitly requested. Otherwise it calls `load()` (the actual probe) — but if a probe for that same key is *already in flight* (`this.pending`), it hands back that same in-progress `Promise` rather than starting a second, redundant probe. `finally { this.pending.delete(key); }` runs whether `load()` succeeds or throws, so a failed probe does not permanently "stick" as pending and block every later attempt.

#### retry-policy.ts

**What it's for, and why its own file.** Two small, pure decisions — "is this failed job even eligible for an automatic retry?" and "if it doesn't have a provider-given wait time, how long should the bridge wait before trying again?" — pulled out of what used to be one long method in `runtime.ts`, so each rule can be read (and tested) on its own.

**Main exports.** `mayRetry(record)`, `retryBackoffMs(retryCount, random)`.

```ts
export function mayRetry(record: TaskRecord): boolean {
  const retryableCategory = record.errorCategory === "rate_limited"
    || record.errorCategory === "session_limit"
    || record.errorCategory === "upstream_error";
  const noChanges = Boolean(record.partialChanges && !record.partialChanges.truncated && !hasWorkspaceChanges(record.partialChanges));
  return record.taskMode === "read_only" && retryableCategory && noChanges && record.retryCount < record.maxRetries;
}

export function retryBackoffMs(retryCount: number, random: () => number): number {
  const base = Math.min(LIMITS.backoffBaseMs * 2 ** retryCount, LIMITS.backoffCapMs);
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * LIMITS.backoffJitterMs);
  return Math.min(base + jitter, LIMITS.maxRetryAfterMs);
}
```

- `mayRetry` only allows a retry when the task is `read_only` (never for a coding task with partial edits), the error category plausibly clears up on its own, the workspace snapshot shows no partial changes, and the retry count hasn't hit `maxRetries`. `retryBackoffMs` computes exponential backoff — `2 ** retryCount` is the exponentiation operator (`**`), so the wait roughly doubles each retry — capped at `backoffCapMs`, with a small random amount of jitter added so many simultaneously-retrying jobs do not all wake up at exactly the same moment, then clamped once more to `LIMITS.maxRetryAfterMs` overall.

#### task-lifecycle.ts

**What it's for, and why its own file, this shape.** Owns one worker process end to end: building its command, spawning it, reading its streamed output, and deciding what happens when it exits — success, failure, or a scheduled retry. This was the largest part of the old single-file `runtime.ts`; splitting it out leaves `bridge-runtime.ts` to own only job bookkeeping (the map of jobs, concurrency, circuit breakers), while every "run one process from start to finish" concern lives here, behind a small `TaskLifecycleDependencies` object the caller injects.

**Main export.** The `TaskLifecycle` class.

```ts
export interface TaskLifecycleDependencies {
  spawn: SpawnFunction;
  stopChild: StopChildFunction;
  getAdapter(id: string): HarnessAdapter;
  now(): Date;
  random(): number;
  schedule(callback: () => void, delay: number): NodeJS.Timeout;
  cancelSchedule(handle: NodeJS.Timeout): void;
  classifyAndOpenCircuit(record: TaskRecord): number | undefined;
  clearCircuit(record: TaskRecord): void;
}

export class TaskLifecycle {
  public constructor(private readonly dependencies: TaskLifecycleDependencies) {}
```

- `TaskLifecycleDependencies` lists everything `TaskLifecycle` needs but does not own itself — spawning a process, scheduling a timer, asking `BridgeRuntime` to classify a failure and possibly open a circuit breaker — as plain functions, rather than the class reaching out to `BridgeRuntime` directly. `bridge-runtime.ts` builds one of these objects (wiring `classifyAndOpenCircuit`/`clearCircuit` back to its own private methods) and passes it to `new TaskLifecycle(...)` once, in its constructor. This is the same "parameter properties" shorthand seen in `discovery.ts`: `private readonly dependencies: TaskLifecycleDependencies` both declares and assigns the field from the constructor argument.

**`launch`** builds the command and actually starts the process:

```ts
    try {
      child = this.dependencies.spawn(spec.command, spec.args, {
        cwd: spec.cwd ?? record.workspace,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
      });
    } catch (error) {
      void this.finalize(record, "failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* the child may exit before reading its prompt */ });
      child.stdin.end(spec.stdin);
    }
```

`spec` comes from `adapter.command({ prompt: buildDelegationPrompt(...), ... })` — the prompt from `core/prompt.ts` and the harness-specific flags from the adapter are already combined by the time this runs. `this.dependencies.spawn` defaults to Node's real `child_process.spawn` (wired up in `bridge-runtime.ts`), but tests substitute a fake one (section 5). `shell: false` means arguments are passed directly, with no shell involved. `stdio`'s first entry is `"ignore"` unless the adapter's `SpawnSpec` set a `stdin` string — the Claude Code adapter is the one built-in adapter that does, piping the whole prompt in and then closing the pipe with `child.stdin.end(spec.stdin)`, rather than passing it as a command-line argument. After spawning, `launch` attaches a timeout and a `close` handler that calls a small private helper, `exitStatus(record, code)`, for the final `JobStatus`, then calls `finalize`. `exitStatus`'s own priority order: the bridge's own verdict (a timeout, or a `delegate_cancel` that set `forcedTerminalStatus`/`cancellationRequested`) wins over a non-zero exit code, which wins over the harness's own reported `outcome` (from `interpret()`, defaulting to `"failed"` if the harness never reported one).

**`captureStream`/`recordEvent`** read the child's output — `captureStream` buffers stdout and splits it into lines (stderr is redacted and appended straight to the log file); each stdout line goes to `recordEvent`:

```ts
  private recordEvent(record: TaskRecord, line: string): void {
    const event = parseJsonLine(line, this.dependencies.now().toISOString());
    if (!event) return;
    event.data = sanitizeEventData(event.data);
    void appendFile(record.logPath, `${JSON.stringify(event)}\n`, "utf8");
    record.events.push(event);
    if (record.events.length > LIMITS.maxEvents) record.events.shift();
    if (event.type === "unparsed_output" || !isRecord(event.data)) return;
    const fields = this.dependencies.getAdapter(record.harness).interpret(event.data);
```

Each line is parsed (`parseJsonLine`), sanitized (`sanitizeEventData`), logged, and kept in `events` (capped at `LIMITS.maxEvents`, dropping the oldest with `shift()`). Unless it failed to parse, the current adapter's `interpret()` reads it, and `recordEvent` copies over whichever of `sessionId`, `summary`, `usage`, or `outcome` it found.

**`finalize`** runs once, when a job reaches a terminal state:

```ts
  private async finalize(record: TaskRecord, status: JobStatus, detail?: string): Promise<void> {
    if (record.finalizing || TERMINAL_STATUSES.includes(record.status)) return;
    record.finalizing = true;
    if (record.timeoutHandle) this.dependencies.cancelSchedule(record.timeoutHandle);
    if (detail) record.stderrSummary = redactPotentialSecrets(`${record.stderrSummary}\n${detail}`);
    const retryAfterMs = status === "failed" || status === "timed_out" ? this.dependencies.classifyAndOpenCircuit(record) : undefined;
```

The `finalizing`/`TERMINAL_STATUSES` guard stops it running twice (a timeout and a process close can both fire around the same moment). On failure/timeout it classifies the error first, via the injected `classifyAndOpenCircuit` (implemented in `bridge-runtime.ts`), then re-snapshots the workspace and diffs it for `fileChanges`. On success it calls the injected `clearCircuit`; otherwise it calls `applyFailurePolicy`.

**`applyFailurePolicy`** decides whether a failure is worth an automatic retry, now leaning on `retry-policy.ts` for the actual rules:

```ts
  private applyFailurePolicy(record: TaskRecord, classifiedRetryAfterMs?: number): void {
    if (record.status !== "failed" && record.status !== "timed_out") return;
    const fallbackDelay = classifiedRetryAfterMs === undefined ? retryBackoffMs(record.retryCount, () => this.dependencies.random()) : undefined;
    record.retryable = mayRetry(record);
    if (!record.retryable) return;
```

If retryable, the job goes back to `"queued"` and a timer calls `prepareRetryLaunch`, which resets the record's per-attempt fields and calls `launch` again.

#### bridge-runtime.ts

**What it's for, and why its own file, this shape.** The public facade the rest of the program talks to. `BridgeRuntime` owns the map of jobs, the registered adapters, the circuit breakers, and workspace-root state — and never contains a line naming "agy," "Antigravity," or "claude"; every harness-specific action goes through the small `HarnessAdapter` interface instead, and every "run one process" concern is delegated to a `TaskLifecycle` instance it builds in its own constructor. Nowhere in this file does an `if` branch on which harness is running: it calls `adapter.probe(...)`, `adapter.command(...)` (indirectly, through `TaskLifecycle`), and lets the registered adapter fill in the specifics, so concurrency, retries, circuit breakers, and workspace safety are enforced identically no matter which harness is doing the work.

**Main exports.** The `BridgeRuntime` class, plus the `StartTaskInput` and `HarnessReport` interfaces it uses.

**`startTask`** validates the request, then reserves a slot for the job:

```ts
    const model = input.model ?? adapter.defaultModel;
    this.assertModelAvailable(adapter.id, model);
    const usingTaskWorkspaceFallback = this.guard.getConfiguredRoots().length === 0;
    const workspace = await this.guard.assertAllowed(input.workspace, true);
    if (usingTaskWorkspaceFallback) this.taskWorkspace = workspace;
    const active = this.activeJobs();
    if (active.length >= this.config.maxConcurrency) throw new Error(`Maximum concurrency (${this.config.maxConcurrency}) reached.`);
```

It picks the model, calls `assertModelAvailable` to check no circuit breaker blocks that harness/model pair, then `WorkspaceGuard.assertAllowed` (`platform/workspace.ts`) to confirm the workspace sits inside the allowed roots — or, with no roots configured, to accept this task's own workspace as the boundary going forward — before checking a concurrency slot is free. `startTask` then builds a `TaskRecord`, stores it in `this.jobs` (a `Map<string, TaskRecord>`), snapshots the workspace with `snapshotWorkspace`, and calls `this.lifecycle.launch(record)` — `this.lifecycle` is the `TaskLifecycle` instance built once in the constructor.

**`discover`** reports every registered harness's live state, through the `DiscoveryCache`:

```ts
    const harnesses: Record<string, HarnessReport> = {};
    for (const adapter of this.adapters.values()) {
      const probe = await this.discovery.get(adapter.id, options.refresh === true, () => this.runAdapterProbe(adapter));
      harnesses[adapter.id] = { id: adapter.id, displayName: adapter.displayName, executable: adapter.executable, defaultModel: adapter.defaultModel, ...probe };
    }
```

It loops over every registered adapter and asks `this.discovery` (a `DiscoveryCache<HarnessProbe>`) for that adapter's probe result, only actually running `this.runAdapterProbe(adapter)` when nothing fresh is cached. `runAdapterProbe` wraps `adapter.probe(...)` in a `try`/`catch` so a probe that throws becomes an `"unavailable"` result rather than crashing the whole call — one broken harness cannot hide the others. `discover` also reports `activeJobs`, `circuitBreakers`, and which allowed-root source is in effect.

**The circuit breaker** is keyed by `harness:model`, not just `harness` — the same model name can sit behind a different quota depending on which harness account runs it, so blocking by harness alone would either over-block a still-healthy model or under-block a still-blocked one:

```ts
  private breakerKey(harness: string, model: string | undefined): string {
    return `${harness}:${model ?? "*"}`;
  }
```

`assertModelAvailable`, called at the start of `startTask`, checks `this.breakers` under this same key and refuses new work for a blocked harness/model pair until `blockedUntil` passes; `expireBreakers` removes breakers whose block has already expired.

### App (`src/app/`)

Turns the runtime into an actual running MCP server, over stdio.

#### mcp-server.ts

**What it's for, and why its own file.** Turns `BridgeRuntime`'s plain methods into the four MCP tools an orchestrator calls, and handles the MCP "roots" handshake (the client telling the server which folders it may touch) — keeping protocol-shaped concerns separate from `bridge-runtime.ts`'s plain business logic, which could in principle be reused behind a different protocol.

**Main exports.** `McpRootsProvider` interface, `refreshMcpClientRoots`, `configureMcpClientRootDiscovery`, `createMcpServer(runtime)`.

```ts
function jsonResult(payload: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}
```

- A function declaration with its return type spelled out in full rather than left for TypeScript to guess: `type: "text"` there pins that field to one exact literal value, rather than the wider `string`, which is what the MCP SDK expects. `payload as Record<string, unknown>` is a type assertion — "trust me, treat this as an object." This one helper wraps every tool's return value the same way, both as readable text and as structured JSON.

Each tool is registered with `server.registerTool(name, { description, inputSchema, annotations }, handler)`; `inputSchema` is described with `zod`, a small library that rejects bad input (a missing `task`, an invalid `jobId`) before `bridge-runtime.ts` sees it. `delegate_discover` calls `runtime.discover()`; `delegate_start` calls `runtime.startTask(input)`; `delegate_status` calls `runtime.getTask(jobId, eventLimit)`; `delegate_cancel` calls `runtime.cancelTask(jobId)`; `delegate_respond` answers a task parked in `awaiting_input`, either relaying an answer directly (`action: "answer"`) or asking the connected client to collect one from a human (`action: "elicit"`). The `harness` input field's description gives `"antigravity"` and `"claude-code"` as examples. The bridge never requests `roots/list` or `sampling/createMessage`: a task's boundary comes only from the `workspace` argument and the optional `BRIDGE_ALLOWED_ROOTS` allow-list.

#### entry.ts

**What it's for, and why its own file.** The actual startup sequence: build config, build runtime, register every built-in adapter, build the MCP server, connect it to stdio. Separating this from `index.ts`'s job of "what does this package expose" means the tests can import `BridgeRuntime` and the adapters directly, build their own fake-spawn-backed runtime, and never accidentally start a real, listening MCP server.

**Main export.** `runStdioServer()`.

```ts
export async function runStdioServer(): Promise<void> {
  const config = resolveBridgeConfig();
  const runtime = new BridgeRuntime({ config });
  for (const adapter of createBuiltInAdapters(config)) runtime.registerAdapter(adapter);
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}

// Start only when this bundle is the program being run, not when it is imported (as the tests do).
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void runStdioServer();
}
```

- That final `if` is a guard, explained by its own comment: start the server only when this bundled file is the actual program being run (`node dist/index.js`), not when other code merely imports it — which is exactly what the test suite does.

### Adapters (`src/adapters/`)

The only files allowed to know a specific harness's CLI by name.

#### adapter.ts

**What it's for, and why its own file.** No working code — this is the contract between the harness-neutral core and one harness. Its own opening comment explains the split: the runtime owns job lifecycle, concurrency, workspace rules, redaction, change detection, retries, and circuit breakers; an adapter knows only how to probe its CLI, the exact command to run, how to read one line of its output, and optionally its own failure wording. Writing this down as an `interface` means TypeScript itself enforces it — a class claiming to implement `HarnessAdapter` but missing a method will not build.

**Main exports.** `CommandResult`, `CommandRunner` (a function type), `HarnessProbe`, `TaskLaunch`, `SpawnSpec`, `Interpretation`, and the central `HarnessAdapter` interface.

```ts
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export interface HarnessProbe {
  installed: boolean;
  version?: string;
  authStatus: "authenticated" | "unauthenticated" | "unknown" | "unavailable";
  models: string[];
  /** "listed" when the CLI enumerated models; "static" for a built-in list; "unknown" when the harness cannot say. */
  modelSource: "listed" | "static" | "unknown";
  error?: string;
}
```

- `readonly string[]` means an array of strings the function promises not to modify; `readonly` on an object field (as in `readonly id: string`, below) means once the object exists, that field can never be reassigned. `Promise<CommandResult>` means this function does not hand back a `CommandResult` immediately — it hands back a placeholder for a value that shows up later, once the spawned process finishes; the type in angle brackets is what it eventually resolves to. `modelSource` is a three-way union: the Antigravity adapter reports `"listed"` because `agy models` really enumerates them; the Claude Code adapter reports `"static"` because its CLI has no such command, so the adapter ships a fixed list instead (see below).

```ts
export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child's stdin and then closed; use for prompts too long for argv. */
  stdin?: string;
}
```

- `SpawnSpec.stdin` is optional and new since the first Antigravity-only version of this contract: Antigravity's adapter never sets it (its prompt goes in as a `--prompt` argument), while the Claude Code adapter always sets it — see `claude-code.ts` below for why.

```ts
export interface HarnessAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly executable: string;
  readonly defaultModel?: string;
  probe(run: CommandRunner): Promise<HarnessProbe>;
  command(input: TaskLaunch): SpawnSpec;
  interpret(event: Record<string, unknown>): Interpretation;
  classifyFailure?(context: unknown): ErrorCategory | undefined;
  retryAfterMs?(context: unknown, nowMs: number): number | undefined;
}
```

- The whole contract in one place: `probe` checks install/login/models, `command` builds the exact CLI invocation, `interpret` reads one parsed output line. `classifyFailure`/`retryAfterMs` end in `?` — optional, needed only when a harness's error wording doesn't match `core/failure.ts`'s shared defaults.

#### antigravity.ts

**What it's for, and why its own file.** The one file allowed to know about `agy` specifically — its flags, its models output format, its status words. It is the working example of the contract above: adding another worker means writing a new file shaped like this one, never editing anything under `runtime/`.

**Main exports.** `ANTIGRAVITY_DEFAULTS`, `parseModelList`, `parseAuthenticationStatus`, and the `AntigravityAdapter` class.

```ts
export class AntigravityAdapter implements HarnessAdapter {
  public readonly id = "antigravity";
  public readonly displayName = "Antigravity CLI";
  public readonly executable: string;
  public readonly defaultModel: string;

  public constructor(settings: HarnessSettings = {}) {
    this.executable = settings.executable ?? ANTIGRAVITY_DEFAULTS.executable;
    this.defaultModel = settings.defaultModel ?? ANTIGRAVITY_DEFAULTS.model;
  }
```

- A `class` is a template for building objects that bundle data (fields like `id`) with the functions that act on it (methods like `probe`). `new AntigravityAdapter({...})` runs the `constructor`, the special method that sets up a fresh object's starting fields. `public` in front of a field/method means any code holding the object may read or call it — this project also uses `private` elsewhere (see `WorkspaceGuard` in `workspace.ts`), meaning only the class's own methods may touch it. `implements HarnessAdapter` tells the compiler to check this class really provides every field and method the interface demands. Notice this constructor spells out `this.executable = ...` explicitly, unlike the "parameter properties" shorthand seen in `discovery.ts`/`task-lifecycle.ts` — both styles exist in this codebase; this one is needed here because the assigned value is not simply the raw argument, but a fallback (`??`) onto a default.

```ts
  public async probe(run: CommandRunner): Promise<HarnessProbe> {
    const version = await run(["--version"]);
    // `agy models` is the only non-secret signal of a working login: it fails when logged out.
    const models = await run(["models"]);
    let authStatus: HarnessProbe["authStatus"];
    if (models.ok) authStatus = "authenticated";
    else if (!version.ok) authStatus = "unavailable";
    else if (parseAuthenticationStatus(models.error ?? models.stderr) === "unauthenticated") authStatus = "unauthenticated";
    else authStatus = "unknown";
```

- `async` on a method means it may need to wait on something slow — here, a spawned process — without freezing the program; `await` pauses execution until the `Promise` on the right finishes, then continues with the unwrapped value. `authStatus` is worked out with a plain `if`/`else` chain read top to bottom: authenticated if `agy models` worked, unavailable if `agy --version` didn't even run, unauthenticated if `agy models` failed saying so, otherwise unknown; `HarnessProbe["authStatus"]` reaches into that interface and pulls out just that one field's type, so the variable is guaranteed to end up as one of its exact allowed strings. `command()` builds the actual `agy` invocation (`--model`, `--output-format stream-json`, `--effort`, `--sandbox`, `--mode plan`/`accept-edits`, and `--dangerously-skip-permissions` in full permission mode); `interpret()` reads one parsed JSON line and pulls out `conversation_id`, `usage`, response text, and a terminal `status` word, translating Antigravity's own vocabulary into this project's shared `Outcome` values.

#### claude-code.ts

**What it's for, and why its own file.** The one file allowed to know about `claude` specifically. It looks similar in shape to `antigravity.ts` (same interface, same kind of class), but four choices are genuinely different, each for a reason worth understanding rather than copying blindly.

**Main exports.** `CLAUDE_CODE_DEFAULTS`, `CLAUDE_CODE_MODELS`, `parseLoginStatus`, and the `ClaudeCodeAdapter` class.

**Why the prompt goes over stdin, not an argument.** `command()` returns `stdin: input.prompt` instead of appending `--prompt <text>` to `args`:

```ts
  public command(input: TaskLaunch): SpawnSpec {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", input.model ?? this.defaultModel,
      "--effort", input.effort,
    ];
    if (input.taskMode === "read_only") {
      // Read-only means read-only in every permission mode: the edit tools are
      // removed and nothing outside Claude Code's read-only command set is approved.
      args.push("--permission-mode", "dontAsk", "--disallowedTools", EDIT_TOOLS);
    } else if (input.permissionMode === "full") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "acceptEdits");
    }
    // The prompt travels over stdin: no argv length limit and no quoting.
    return { command: this.executable, args, cwd: input.workspace, stdin: input.prompt };
  }
```

Every operating system caps how long a single command-line invocation can be, and `core/prompt.ts`'s delegation prompt — task text plus the whole safety preamble — can be long. Passing it as one `argv` entry risks silently truncating it or failing to spawn at all, and would also need careful escaping so the shell (or Node's own argument handling) does not mangle quotes or special characters inside the task text. Writing it to the child's stdin instead, then closing the stream (`child.stdin.end(spec.stdin)`, in `task-lifecycle.ts`), has neither limit.

**Why the read-only flags, and why in every permission mode.** The `if`/`else if`/`else` above is read top to bottom, and `read_only` is checked *first*, before permission mode: a `read_only` task always gets `--permission-mode dontAsk --disallowedTools Edit,Write,MultiEdit,NotebookEdit`, regardless of whether the bridge's own permission mode is `full` or `restricted`. `dontAsk` stops Claude Code from pausing for an approval nobody headless can answer; removing `Edit,Write,MultiEdit,NotebookEdit` from the allowed tool list means the model cannot change files even if it tried, rather than relying only on the prompt's own "do not modify files" instruction (`core/prompt.ts`) to hold. Only a `coding` task reaches the `permissionMode` branches below it: `--dangerously-skip-permissions` in `full` mode (auto-approving every tool, the same as Antigravity's flag of the same name), or `--permission-mode acceptEdits` in `restricted` mode (auto-approving file edits, but leaving other tool use to Claude Code's own prompts).

**Why the model list is static.** Unlike `agy models`, the `claude` CLI has no subcommand that lists available models, so there is nothing to run and parse the way `AntigravityAdapter.probe` runs `agy models`:

```ts
export const CLAUDE_CODE_DEFAULTS = {
  executable: "claude",
  model: "sonnet",
} as const;

/** Aliases `claude --model` accepts. The CLI has no command that lists models, so this list is static. */
export const CLAUDE_CODE_MODELS = ["fable", "opus", "sonnet", "haiku"];
```

`probe()` returns this fixed array as `models`, and `modelSource: "static"` (rather than `"listed"`) so `delegate_discover`'s caller can tell the difference — a static list could in principle drift out of date with what `claude --model` really accepts, where a listed one cannot.

**Why `system/api_retry` is checked before the shared text-matching fallback.** Claude Code's own stream sometimes names the exact API error class it hit, rather than leaving the caller to guess from free-text wording:

```ts
/** `system/api_retry` error names mapped onto the bridge's failure categories. */
const API_ERROR_CATEGORY: Record<string, ErrorCategory> = {
  rate_limit: "rate_limited",
  billing_error: "quota_exhausted",
  authentication_failed: "authentication",
  oauth_org_not_allowed: "authentication",
  overloaded: "upstream_error",
  server_error: "upstream_error",
};
```

```ts
  /** Claude Code names the API error class in its retry events; use that before falling back to text matching. */
  public classifyFailure(context: unknown): ErrorCategory | undefined {
    for (const item of Array.isArray(context) ? context : [context]) {
      if (isRecord(item) && item.type === "system" && item.subtype === "api_retry" && typeof item.error === "string") {
        const category = API_ERROR_CATEGORY[item.error];
        if (category) return category;
      }
    }
    return defaultClassifyFailure(context);
  }
```

`context` here is a mixed bag `bridge-runtime.ts` builds from `stderrSummary`, `summary`, `outcomeDetail`, and every raw event `data` value for the job — `Array.isArray(context) ? context : [context]` normalizes that into something always iterable, one item at a time, whether the caller passed a single value or the whole array. If any item is a `system`/`api_retry` event whose `error` name is one this adapter recognizes, that wins outright; only when nothing matches does it fall through to `defaultClassifyFailure` from `core/failure.ts` — the same shared, text-matching rules `AntigravityAdapter` relies on entirely, since it has no such named-error events to read.

One more small difference worth knowing about: `probe()` also runs `claude auth status --json` and reads *only* its `loggedIn` boolean, through `parseLoginStatus`:

```ts
export function parseLoginStatus(output: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) && typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
}
```

Everything else in that JSON output — account details — is discarded, never stored or returned; this matches the project's rule that discovery must never read or copy credential state.

#### index.ts

**What it's for, and why its own file.** The single list of which adapters actually exist. It is what lets `bridge-runtime.ts` and `entry.ts` avoid ever importing `antigravity.ts` or `claude-code.ts` directly — `entry.ts` asks this one file for the current list and hands each one to `runtime.registerAdapter(...)`, so the runtime never needs to name a harness.

**Main export.** `createBuiltInAdapters(config)`, returning an array of adapter instances.

```ts
export function createBuiltInAdapters(config: BridgeConfig): HarnessAdapter[] {
  return [
    new AntigravityAdapter(config.harnesses.antigravity ?? {}),
    new ClaudeCodeAdapter(config.harnesses["claude-code"] ?? {}),
  ];
}
```

- Adding a worker later means adding one more line to this array — nothing else here changes shape. `config.harnesses["claude-code"]` uses bracket notation, not `config.harnesses.claude-code` (dot notation cannot be used with a key containing a hyphen, since `claude-code` would otherwise parse as `claude` minus `code`).

### src/index.ts

**What it's for, and why its own file, this shape.** The package's single public doorway, gathering every other file's exports with repeated `export * from "...js"` lines; this same bundled file doubles as the MCP server's real entry point once built. Its own opening comment says both roles out loud: "Tests and external consumers import from here; the bundled `dist/index.js` is also the MCP server entry point" — keeping this as one thin re-export file means the tests exercise the exact same public surface that ships.

**Main exports.** Everything from every other file, plus `runStdioServer` from `app/entry.ts`.

```ts
export * from "./core/types.js";
export * from "./core/limits.js";
export * from "./core/redaction.js";
export * from "./core/value.js";
export * from "./core/usage.js";
export * from "./core/failure.js";
export * from "./core/prompt.js";
export * from "./platform/config.js";
export * from "./platform/process.js";
export * from "./platform/workspace.js";
export * from "./runtime/events.js";
export * from "./runtime/discovery.js";
export * from "./runtime/retry-policy.js";
export * from "./runtime/task-lifecycle.js";
export * from "./runtime/bridge-runtime.js";
export * from "./app/mcp-server.js";
export * from "./adapters/adapter.js";
export * from "./adapters/antigravity.js";
export * from "./adapters/claude-code.js";
export * from "./adapters/index.js";
export { runStdioServer } from "./app/entry.js";
```

- `export * from "./core/types.js"` re-exports every named export from `types.ts` as if declared directly here — so `import { BridgeRuntime } from "codexeni"` works without needing to know it actually lives in `runtime/bridge-runtime.ts`.

## 4. Following one task through the code

Starting from `delegate_start` and ending at `delegate_status`, in call order:

1. The orchestrator calls the `delegate_start` MCP tool. The handler registered in `app/mcp-server.ts` runs.
2. The handler calls `runtime.startTask(input)` in `runtime/bridge-runtime.ts`.
3. `startTask` calls `awaitMcpRootDiscovery()`, `getAdapter(...)`, `assertModelAvailable(...)` (which checks `expireBreakers()` and `this.breakers`), and `guard.assertAllowed(...)` — `WorkspaceGuard.assertAllowed` in `platform/workspace.ts`, which calls `canonicalizeWorkspace` and `isPathWithinRoot`.
4. `startTask` calls `activeJobs()` to check the concurrency ceiling, builds a `TaskRecord`, and calls `snapshotWorkspace(workspace)` from `platform/workspace.ts` for the "before" file state.
5. `startTask` calls `this.lifecycle.launch(record)` — `this.lifecycle` is the `TaskLifecycle` instance (`runtime/task-lifecycle.ts`) built once in the `BridgeRuntime` constructor.
6. `launch` calls `buildDelegationPrompt(...)` from `core/prompt.ts`, then `adapter.command(...)` — for the built-in Antigravity adapter, `AntigravityAdapter.command()` in `adapters/antigravity.ts` — to get the exact command line.
7. `launch` calls `this.dependencies.spawn(...)` (Node's real `child_process.spawn`, or a fake one under test) to start the worker process.
8. `launch` wires `this.captureStream(...)` on the child's stdout and stderr.
9. As output lines arrive, `captureStream` calls `this.recordEvent(record, line)` for each complete stdout line.
10. `recordEvent` calls `parseJsonLine` and `sanitizeEventData` (both in `runtime/events.ts`), then `adapter.interpret(event.data)` — `AntigravityAdapter.interpret()` — to update `sessionId`, `summary`, `usage`, and `outcome` on the record.
11. `startTask` returns a small `{jobId, status, ...}` object to the tool handler, which wraps it with `jsonResult(...)` and replies to the orchestrator — the job keeps running in the background.
12. When the worker process exits, `launch`'s `close` handler calls `this.exitStatus(record, code)` to decide the final status and calls `this.finalize(record, status, detail)`.
13. `finalize` calls the injected `classifyAndOpenCircuit(record)` (implemented in `bridge-runtime.ts`, which may call `adapter.classifyFailure`/`defaultClassifyFailure` from `core/failure.ts`, and a private `openCircuit`), then `snapshotWorkspace` and `diffSnapshots` (both in `platform/workspace.ts`) for `fileChanges`, then `this.applyFailurePolicy(record, retryAfterMs)`.
14. `applyFailurePolicy` calls `mayRetry(record)` and, when there is no explicit provider-given wait, `retryBackoffMs(...)` — both from `runtime/retry-policy.ts`. If retryable, its timer eventually calls `prepareRetryLaunch`, which calls `launch` again — repeating from step 6.
15. Later, the orchestrator calls the `delegate_status` MCP tool with the `jobId`. The handler in `app/mcp-server.ts` calls `runtime.getTask(jobId, eventLimit)`.
16. `getTask` looks the record up in `this.jobs` and calls `compactRecord(record, eventLimit)` from `runtime/events.ts` to shape the reply, which the handler wraps with `jsonResult(...)` and returns to the orchestrator.

A task delegated to the Claude Code worker instead follows the same 16 steps with `ClaudeCodeAdapter` standing in for `AntigravityAdapter` at steps 6 and 10 — the only other difference worth knowing is that step 7's spawn also writes and closes the prompt on the child's stdin (see `claude-code.ts` above), which `AntigravityAdapter` never needs since its prompt travels as a command-line argument instead.

## 5. How the tests work

The single test file, `test/runtime.test.mjs`, imports the already-built `dist/index.js` — not the TypeScript source directly — so a passing test suite reflects exactly what would run in production, including anything the build step (type-checking and bundling) might have changed. That is also why `package.json`'s `test` script runs `pnpm build` before running the tests.

`test/helpers.mjs` provides `createFakeSpawn`, which replaces the real `spawnImpl` the runtime would otherwise use. Instead of actually launching `agy` or `claude`, each call to the fake spawn consumes one queued "scenario" from a list and immediately (on the next microtask) emits canned stdout, stderr, and an exit code, and reacts to `child.kill(...)` the way a real process would; it also gives each fake child a real `stdin` `PassThrough` stream and buffers whatever is written to it, so a test can assert on exactly what the Claude Code adapter piped in. `makeRuntime` builds a `BridgeRuntime` wired to this fake spawn and registers *both* built-in adapters — a real `AntigravityAdapter` and a real `ClaudeCodeAdapter`, each pointed at a fake executable name (`fake-agy`, `fake-claude`) — so either adapter's command-building and output-interpreting logic is still exercised in a test that chooses to use it; only the actual operating-system process is faked. `createManualTimers` similarly replaces `setTimeout`/`clearTimeout` with a queue the test can step through by hand, so retry and timeout logic can be tested without ever waiting on the real clock.

As far as I can tell, faking `spawn` this way is what makes the whole suite fast and deterministic: no test needs a real Antigravity or Claude Code install, a real login, network access, or tokens, and no test's outcome can vary run to run because of network timing. A broken test therefore reliably points at a real bug in this project's code, not at the environment it happened to run in.

`fixtures/fake-agy/fake-agy.mjs` is a separate, small but real Node script that behaves like `agy` — it reads a `FAKE_AGY_SCENARIO` environment variable and prints matching NDJSON. It is not used by the automated test suite's fake spawn; it exists so a person can point `BRIDGE_ANTIGRAVITY_PATH` at it and manually smoke-test the bridge end to end, with a real child process, without needing a real Antigravity login. There is no equivalent fixture for the Claude Code worker; smoke-testing that adapter against a real process means pointing `BRIDGE_CLAUDE_CODE_PATH` at an actual, logged-in `claude` installation instead.

## 6. Build and packaging

`pnpm build` (defined in `plugins/codexeni/package.json`) runs two tools in sequence:

1. `tsc -p tsconfig.json --noEmit` — type-checks every file under `src/` against the rules in `tsconfig.json` (strict mode is on) but, because of `--noEmit`, writes out no files at all. Its only job is to catch mistakes before anything ships.
2. `esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/index.js --sourcemap` — follows every import starting from `index.ts`, including the `@modelcontextprotocol/sdk` and `zod` dependencies, and produces one single file, `dist/index.js`, containing all of it.

`dist/index.js` is committed to the repository rather than gitignored. Two separate host manifests point at that same built file, one per host, and neither runs a build step of its own after installing:

- Codex reads `plugins/codexeni/.codex-plugin/plugin.json`, whose `mcpServers` field is not inline but a path, `"./.codex-plugin/mcp.json"`, to a second file. That file's `mcpServers.codexeni` entry says `"command": "node", "args": ["./dist/index.js"], "cwd": "."` — relative to the installed plugin directory, and lists every `BRIDGE_*`/`AGY_BRIDGE_*` variable Codex should forward in its `env_vars` array, since Codex only passes variables it is explicitly told about.
- Claude Code reads `plugins/codexeni/.claude-plugin/plugin.json`, whose `mcpServers.codexeni` entry is declared inline in that same file and uses `"args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]` — `${CLAUDE_PLUGIN_ROOT}` is a variable Claude Code substitutes with wherever it installed the plugin. No `env_vars` list is needed here, because Claude Code already passes its whole process environment to the MCP servers it starts.

If `dist/index.js` were not already built and checked in, a fresh install into either host would have nothing runnable to point at — a marketplace install just copies the plugin folder as-is.

Both hosts cache an installed plugin by its `version` field, so rebuilding `dist/index.js` alone is not enough to make either host pick up new code after a reinstall — the version has to change too. `plugins/codexeni/scripts/bump-version.mjs` keeps three files' `version` fields in lockstep: `package.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json`. Run `pnpm bump` with no arguments to write a fresh UTC-timestamp-based version everywhere, or `pnpm bump 0.2.0` to set an explicit one; `pnpm check:manifests` (also run in CI) fails if those three versions ever disagree, or if either host manifest stops launching `dist/index.js`.

## 7. Adding a worker vs. adding a host

Codexeni supports a harness in two independent ways, and a harness can pick up either one or both — see section 1 above and [`docs/architecture.md`](architecture.md) for the concepts. In code terms:

### Adding a worker

1. Create a new file, `plugins/codexeni/src/adapters/<name>.ts`.
2. Write a class that `implements HarnessAdapter` (from `adapters/adapter.ts`) — the compiler will list any required field or method you have not yet provided.
3. Implement `probe(run)` to report install state, version, auth status, and models; `command(input)` to return a `SpawnSpec` describing the exact CLI invocation; and `interpret(event)` to turn one parsed output line into an `Interpretation`.
4. Implement the optional `classifyFailure` and `retryAfterMs` only if your harness's error wording does not already match the shared defaults in `core/failure.ts` — `claude-code.ts` is the example of a harness that needed to (section 3, above).
5. Register an instance of the new class inside `createBuiltInAdapters(config)` in `adapters/index.ts`, following the pattern already used for `AntigravityAdapter` and `ClaudeCodeAdapter`.
6. Add its environment variable names, `BRIDGE_<ID>_PATH` and `BRIDGE_<ID>_MODEL`, to `.codex-plugin/mcp.json`'s `env_vars` array — this is exactly what `adapters/index.ts`'s own top comment instructs. Claude Code needs no equivalent list; it already forwards its whole environment. Mention the new variables in `README.md`.
7. Nothing in `runtime/`, `app/`, or `platform/` needs to change — not even `platform/config.ts`, whose `HARNESS_ENV_PATTERN` already recognizes `BRIDGE_<ANYTHING>_PATH`/`BRIDGE_<ANYTHING>_MODEL` for any harness id automatically (see the `config.ts` subsection above). That is the entire point of the adapter boundary described in section 1: the core only ever talks to the `HarnessAdapter` interface, never to a specific harness by name.

### Adding a host

1. Write a manifest in that harness's own format, in a new `.<harness>-plugin/` directory next to `.codex-plugin/` and `.claude-plugin/`, launching the already-built `dist/index.js` — using whichever path or substitution variable that host provides for "the installed plugin directory" (Codex uses a relative path plus `cwd: "."`; Claude Code uses `${CLAUDE_PLUGIN_ROOT}`).
2. Add the new manifest file to the `VERSIONED` list, and its host to the `serverArgs()` check, in `scripts/bump-version.mjs`, so `pnpm bump` and `pnpm check:manifests` cover it too.
3. Add an install command for the new host to `README.md`'s Install section, and write a `docs/<harness>-quickstart.md` modeled on `docs/codex-quickstart.md` and `docs/claude-code-quickstart.md`.
4. No TypeScript file changes at all — a host is purely a manifest, since it launches the identical, already-harness-neutral `dist/index.js` every other host launches too.

## 8. Glossary

- **Harness** — a coding-agent CLI application, such as Claude Code, Codex, or Antigravity.
- **Host** — a harness that runs Codexeni as its own MCP server and calls its `delegate_*` tools; this project also calls this harness the orchestrator. Codex and Claude Code are both hosts today; supporting one costs only a manifest, no code.
- **Adapter** — a small file implementing `HarnessAdapter`, translating between the harness-neutral runtime and one specific harness's command line and output format.
- **Orchestrator** — the harness that calls Codexeni's tools to delegate a task; it stays responsible for scoping the task and reviewing the result. Synonymous with "host" above.
- **Worker** — a harness Codexeni can start as a subagent to actually run a delegated task, launched as a child process. Antigravity and Claude Code are both workers today; a harness can be a worker, a host, or both at once.
- **MCP (Model Context Protocol)** — a standard way for an AI application to discover and call "tools" exposed by another program, such as this bridge.
- **Stdio** — standard input/output; the orchestrator and this bridge talk to each other by writing to and reading from each other's stdin/stdout, rather than over a network socket.
- **NDJSON / stream-json** — one JSON object printed per line of output; how a worker harness reports progress and results as it runs, instead of printing one big blob at the end.
- **Circuit breaker** — a temporary block on starting new jobs for one harness/model pair, opened after a rate-limit or quota failure, until a computed `blockedUntil` time passes.
- **Snapshot / change detection** — recording every file's size and modified time before and after a task, then comparing the two lists to report which files were created, modified, or deleted.
- **Allowed roots** — the folder(s) a task's workspace is required to sit inside; set explicitly by an environment variable, learned from the connected MCP client, or (as a last resort) fixed to the task's own requested workspace.
- **Permission mode** — `"restricted"` or `"full"`; `"full"` (the default) tells the adapter to pass its harness's equivalent of "skip permission prompts," so the worker does not stall waiting for an approval nobody can answer.
- **Task mode** — `"coding"` (may change files, never auto-retries) or `"read_only"` (must not change files, may auto-retry a bounded number of times if nothing changed and the failure looks temporary).
- **Retry** — an automatic second attempt at a `read_only` task, only when the failure category looks recoverable and the workspace snapshot shows no partial changes.
- **Redaction** — replacing text that looks like a secret (an API key, an access token) with `[redacted]` before it is logged, stored in memory, or returned to the orchestrator.
