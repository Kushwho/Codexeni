# Architecture and trust boundaries

## Components

```text
Codex (host)                Claude Code (host)
   │ .codex-plugin/mcp.json     │ .claude-plugin/plugin.json (mcpServers inline)
   │ MCP stdio                  │ MCP stdio
   └──────────────┬─────────────┘
                   ▼
     Codexeni runtime (dist/index.js, one Node MCP server, harness-neutral)
                   │ argv + inherited environment; no token handling
                   ▼
           HarnessAdapter interface
                   │
       ┌───────────┴───────────┬───────────┐
       ▼                       ▼           ▼
AntigravityAdapter        ClaudeCodeAdapter CodexAdapter
agy --output-format ...   claude -p --output-format stream-json ...  codex exec --json ...
       │                       │           │
       ▼                       ▼           ▼
Antigravity CLI            Claude Code CLI Codex CLI
auth + local coding tools  auth + local coding tools auth + local coding tools
```

The same adapters can also run as the orchestrator's own harness: `delegate_discover` lists `claude-code` from inside a Claude Code host, or `codex` from either existing host, exactly like any other worker.

## Two roles: host and worker

A harness can be a **host** (it runs Codexeni as its own MCP server and calls the `delegate_*` tools — the orchestrator), a **worker** (Codexeni starts it as a subagent to do a task), or both. These are independent: adding support for a harness in one role never requires the other.

| Harness | Host (orchestrator) | Worker (subagent) |
| --- | --- | --- |
| Codex | yes | yes |
| Claude Code | yes | yes |
| Antigravity | not yet — works today via `agy mcp add codexeni node <abs path to>/dist/index.js` | yes |

Being a host costs only a manifest, in that harness's own format, that points at the same built `dist/index.js`; being a worker costs one small file under `src/adapters/`. That is why N harnesses need N (manifests) + N (adapters) pieces of work, not N × N: every host launches the identical bundled server, and every worker adapter is driven by the identical harness-neutral runtime. The three shared parts that make this possible are one server bundle (`dist/index.js`), one skill (`skills/delegation/SKILL.md`, installed with either plugin manifest), and one environment-variable naming scheme (`BRIDGE_<HARNESS>_PATH` / `BRIDGE_<HARNESS>_MODEL`).

**Layout rule**, so it is always obvious which role a file serves:

- `.codex-plugin/` — the Codex host: `plugin.json` (the manifest) plus `mcp.json` (the MCP server definition, referenced from `plugin.json` as `./.codex-plugin/mcp.json`).
- `.claude-plugin/` — the Claude Code host: `plugin.json`, with the MCP server declared inline using `${CLAUDE_PLUGIN_ROOT}/dist/index.js`.
- `src/adapters/` — the workers: `antigravity.ts`, `claude-code.ts`, `codex.ts`, and the shared `adapter.ts` contract.
- `src/core/`, `src/platform/`, `src/runtime/`, `src/app/` — the shared bridge itself, which never names a specific harness.

**Why the manifests are hand-written, not generated.** Each host reads a different file path and a different schema (Codex wants `mcpServers` as a path to a separate file plus an `env_vars` allow-list; Claude Code wants `mcpServers` inline and uses `${CLAUDE_PLUGIN_ROOT}` instead of an allow-list, because it already passes its whole environment). A generator turning one shared description into both formats would be more code, and a bigger thing to get subtly wrong, than the two small, readable manifests it would replace.

Real snippets, not illustrative ones. The Codex host manifest ([`plugins/codexeni/.codex-plugin/plugin.json`](../plugins/codexeni/.codex-plugin/plugin.json)) points at a separate MCP file and lists every honored `BRIDGE_*`/`AGY_BRIDGE_*` variable explicitly, because Codex only forwards variables it is told about:

```json
{
  "mcpServers": "./.codex-plugin/mcp.json"
}
```

which resolves to [`plugins/codexeni/.codex-plugin/mcp.json`](../plugins/codexeni/.codex-plugin/mcp.json):

```json
{
  "mcpServers": {
    "codexeni": {
      "command": "node",
      "args": [
        "./dist/index.js"
      ],
      "cwd": ".",
      "env_vars": [
        "BRIDGE_ALLOWED_ROOTS",
        "BRIDGE_PERMISSION_MODE",
        "BRIDGE_DEFAULT_HARNESS",
        "BRIDGE_DEFAULT_TIMEOUT_SECONDS",
        "BRIDGE_MAX_CONCURRENCY",
        "BRIDGE_ANTIGRAVITY_PATH",
        "BRIDGE_ANTIGRAVITY_MODEL",
        "BRIDGE_CLAUDE_CODE_PATH",
        "BRIDGE_CLAUDE_CODE_MODEL",
        "BRIDGE_CODEX_PATH",
        "AGY_BRIDGE_ALLOWED_ROOTS",
        "AGY_BRIDGE_AGY_PATH",
        "AGY_BRIDGE_PERMISSION_MODE",
        "AGY_BRIDGE_DEFAULT_MODEL",
        "AGY_BRIDGE_DEFAULT_TIMEOUT_SECONDS",
        "AGY_BRIDGE_MAX_CONCURRENCY"
      ]
    }
  }
}
```

The Claude Code host manifest ([`plugins/codexeni/.claude-plugin/plugin.json`](../plugins/codexeni/.claude-plugin/plugin.json)) declares the same server inline, using the `${CLAUDE_PLUGIN_ROOT}` variable Claude Code substitutes with the installed plugin directory:

```json
{
  "mcpServers": {
    "codexeni": {
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/dist/index.js"
      ]
    }
  }
}
```

No `env_vars` allow-list is needed there: Claude Code passes its whole process environment to the MCP servers it starts, so any `BRIDGE_*` variable set before starting Claude Code reaches the bridge unchanged.

The build bundles runtime dependencies into `dist/index.js` for both hosts; this avoids relying on workspace-specific pnpm links after either host copies the plugin into its own cache.

The MCP server owns process lifecycle, workspace-root checks, job IDs, bounded event retention, cancellation, timeout handling, and sanitized status, the same way for every registered harness regardless of which host is calling it. The root check validates the selected working directory; it does not technically prevent a full-permission worker from reaching outside it. Each harness's CLI owns its own OAuth, model availability, and coding tools — `agy` for the Antigravity worker, `claude` for the Claude Code worker. The orchestrator owns user approval, scope decisions, diff review, and independent verification.

The bridge permits up to four concurrent jobs as a local ceiling. This is an implementation limit for one bridge process, not a published provider concurrency quota. Flash and Pro share the account-visible five-hour and weekly usage buckets; the official Antigravity `/usage` surface (or the equivalent for whichever worker is running) is the source of account state.

## Source organization

`plugins/codexeni/src` is divided by responsibility. `app/` contains MCP registration and stdio startup; `core/` contains shared types, fixed limits, prompts, usage normalization, redaction, and generic failure parsing; `adapters/` contains the harness contract plus the Antigravity, Claude Code, and Codex worker implementations; and `platform/` owns environment configuration, child-process primitives, and workspace/root snapshots. `runtime/` coordinates bridge state: `bridge-runtime.ts` is the public facade, while discovery caching, event/status shaping, retry policy, and worker task lifecycle live in focused modules. `src/index.ts` remains the stable public barrel and bundle entry point.

## Environment contract

The MCP configuration allow-lists optional bridge environment variables inherited from the orchestrator's process. Every task supplies its exact workspace; the server canonicalizes that path and uses it as the task boundary. `BRIDGE_ALLOWED_ROOTS` is an optional, additional path-delimited allow-list (`;` on Windows, `:` on POSIX), not a source of workspaces. The bridge does not request MCP `roots/list` or subscribe to root-change notifications. `BRIDGE_PERMISSION_MODE` defaults to `full`, adding the worker harness's broad non-interactive permission flag (Antigravity's equivalent is `--dangerously-skip-permissions`); an explicit `BRIDGE_PERMISSION_MODE=restricted` requires per-call approval instead. `BRIDGE_DEFAULT_HARNESS` selects which registered harness `delegate_start` uses when the caller omits `harness` (default `antigravity`). Per-harness settings follow the `BRIDGE_<HARNESS>_PATH` / `BRIDGE_<HARNESS>_MODEL` pattern, one pair per worker adapter — `BRIDGE_ANTIGRAVITY_PATH` and `BRIDGE_ANTIGRAVITY_MODEL` for the Antigravity adapter, `BRIDGE_CLAUDE_CODE_PATH` and `BRIDGE_CLAUDE_CODE_MODEL` for the Claude Code adapter — each overriding that adapter's executable discovery (when the CLI is not on `PATH`) and default model. `BRIDGE_MAX_CONCURRENCY` defaults to 4 and accepts a local ceiling from 1 through 4; higher values are silently clamped to 4. The older `AGY_BRIDGE_*` names still work as fallbacks.

No environment configuration is required for the default full-permission workflow. Set optional overrides before launching the orchestrator, then restart it so the newly spawned MCP process inherits them. The server never substitutes `${PLUGIN_ROOT}` or its own `process.cwd` for the workspace requested by a task. These checks select the worker cwd; they are not hard operating-system containment. The bridge passes `--sandbox` best-effort, but an explicit full-permission override is not a guaranteed boundary for every Antigravity tool or platform.

## Data flow

1. The server canonicalizes the exact workspace in every task. If `BRIDGE_ALLOWED_ROOTS` is configured, that workspace must also be within one configured root; otherwise it is the sole boundary.
2. The orchestrator calls `delegate_discover`; the server reports each registered harness's install state, version, auth status, available models, model source, and default model, plus live bridge state such as concurrency and active circuit breakers. Expensive harness probes are cached for 60 seconds unless the caller explicitly requests a refresh. Discovery must not read credential stores.
3. The orchestrator calls `delegate_start` with a task, workspace, `harness` (a harness id from `delegate_discover`, defaulting to `BRIDGE_DEFAULT_HARNESS`), `taskMode` (`coding` or `read_only`), `maxRetries`, optional model/effort overrides, and timeout. For the Antigravity adapter, coding tasks launch `agy` with `--mode accept-edits`; read-only tasks use `--mode plan`. Both retain `--sandbox`. Coding tasks use zero automatic retries; no-change read-only tasks may use at most two bounded retries. Permission mode is configured for the whole server process through the environment. The server canonicalizes and validates the workspace before spawning the harness's executable.

### Interactive delegation

An adapter can report a bounded input request instead of a terminal result. The runtime records `awaiting_input`, the sanitized `inputRequest`, `interactionRound`, and `continuationSupported` in `delegate_status`. `delegate_respond` either supplies a bounded answer to `BridgeRuntime.respondTask(jobId, answer, answeredBy)` or returns the request to the host through the MCP 2026-07-28 MRTR `InputRequiredResult` flow. A legacy elicitation shim supports older hosts. Continuations are new worker processes linked to the original conversation, such as `agy --conversation <id>` or `codex exec resume <thread-id>`; the bridge does not run a separate MCP server per worker. One Codexeni MCP server coordinates many CLI adapters and jobs.

The orchestrator may automatically answer only safe, repository-supported, reversible, in-scope details. Product choices, scope changes, destructive actions, permission prompts, and anything secret must be returned to a human. The bridge never elicits credentials or private auth state and caps interaction at three rounds.
4. The worker emits NDJSON. The server stores a bounded, sanitized event tail and a sanitized temporary log outside the repository. Logs are not returned wholesale.
5. The orchestrator polls with `delegate_status`. The server reports lifecycle status, assistant summary, normalized usage when provided, exit diagnostics, and changed-file inventory.
6. The orchestrator reviews the workspace and runs the repository's own checks. A successful worker exit is not a successful task until this review passes.

## Failure and conflict model

- A malformed event, non-zero exit, timeout, or lost server process produces a visible terminal failure state.
- Classify provider failures as quota/rate-limit (`429`), session/disconnect, context, or authentication. A `429` requires checking official `/usage`; authentication/session failures require manual repair; context failures require reducing task scope.
- Coding tasks never auto-retry. Only no-change `read_only` tasks can retry automatically, capped at two retries, with the same model and account.
- Maintain a circuit breaker keyed by harness and model, because the same model can sit behind different quotas depending on which harness is running it. A rate/quota failure blocks new work for that harness/model pair until the reported cooldown expires; `delegate_discover` exposes the active breakers. Never switch harnesses, models, or accounts automatically, purchase paid capacity, or consume G1 credits.
- Cancellation targets only the tracked child process tree.
- Jobs are intentionally in-memory in the PoC. Restarting the MCP server loses their status; the orchestrator must inspect the workspace before retrying an interrupted task.
- Two jobs may overlap in the PoC, but the server reports an overlap warning. It does not merge or isolate changes automatically.
- If a coding task leaves partial changes, the orchestrator reviews the diff and runs tests before any retry or Luna/Terra fallback is considered. Same-workspace simultaneous writers remain unsafe.
- The server inventories workspace changes but does not understand a prompt-level file allow-list. The orchestrator must compare the inventory and full diff against the declared scope; any changed path outside it is a scope violation requiring human review.

## Security boundary

The bridge intentionally inherits the local user's permissions for whichever worker CLI it runs. That can include filesystem writes, shell commands, network access, and access beyond the selected workspace in full mode. The bridge requests a sandbox where the worker offers one (Antigravity's `--sandbox`), but on some platforms or for some tools this is not a complete filesystem boundary. The default workflow therefore requires approval for task starts, validates the selected workspace, uses exact model selection, and asks the worker not to read or print secrets. These controls reduce risk but are not a sandbox or a security guarantee.

**Claude Code worker's permission mapping.** `taskMode: "coding"` in `full` permission mode passes `--dangerously-skip-permissions`, the same auto-approve-everything behavior as Antigravity's flag of the same name; in `restricted` mode it instead passes `--permission-mode acceptEdits`, which still auto-approves file edits but leaves other tool use to Claude Code's own prompts. `taskMode: "read_only"` never uses either of those: regardless of permission mode it runs with `--permission-mode dontAsk --disallowedTools Edit,Write,MultiEdit,NotebookEdit`, so the edit tools are unavailable to the model and only Claude Code's own read-only command set is approved. This mapping lives in `ClaudeCodeAdapter.command()` in [`plugins/codexeni/src/adapters/claude-code.ts`](../plugins/codexeni/src/adapters/claude-code.ts).

**Codex worker's permission mapping.** `taskMode: "read_only"` uses `codex exec --sandbox read-only`. A restricted coding task uses `--sandbox workspace-write`; a full coding task deliberately uses `--dangerously-bypass-approvals-and-sandbox`, with no sandbox flag, so it matches the bridge's existing broad-authority full mode. Codex emits JSONL through `codex exec --json`; the adapter reads its thread ID, structured final message, command events, terminal usage, and error events. It resumes an eligible job with `codex exec resume <thread-id>`.

Additional limits, consolidated in [`SECURITY.md`](../SECURITY.md): event and log redaction covers labeled fields only; the changed-file inventory is metadata-based (size and mtime) and treats `.git`, `node_modules`, `dist`, `build`, and similar excluded directories as blind spots; and Windows requires the native `agy` executable because `.cmd`/`.bat` shims cannot be spawned without a shell.

## Adding a worker

A new worker adapter implements the `HarnessAdapter` interface from `src/adapters/adapter.ts`: `probe(run)` reports install state, version, auth status, and models; `command(input)` builds the exact CLI invocation; `interpret(event)` turns one parsed output line into a normalized `{sessionId, summary, usage, outcome, detail}`; `classifyFailure` and `retryAfterMs` are optional overrides for harness-specific error wording and backoff. Built-in adapters are constructed and registered in `src/adapters/index.ts` via `createBuiltInAdapters(config)`. Adapters encapsulate harness-specific command construction, output interpretation, and failure wording; the runtime and platform layers own process lifecycle, concurrency, workspace guards, and circuit breakers across every registered harness. Add the new adapter's `BRIDGE_<ID>_PATH` / `BRIDGE_<ID>_MODEL` names to `.codex-plugin/mcp.json`'s `env_vars` list — Claude Code needs no such list, since it forwards its whole environment already.

## Adding a host

A new host needs a manifest in that harness's own format, launching the same `dist/index.js`; no code changes to `src/` are required. Follow the layout rule above: put the manifest under a new `.<harness>-plugin/` directory next to `.codex-plugin/` and `.claude-plugin/`, point it at `dist/index.js` (relative to the installed plugin directory, using whichever variable or working-directory convention that host substitutes), and add the new manifest's file to `bump-version.mjs`'s `VERSIONED` list and `serverArgs()` check so `pnpm bump`/`pnpm check:manifests` cover it too. Then add an install command for that host to `README.md`'s Install section and write a `docs/<harness>-quickstart.md` modeled on the two that already exist.
