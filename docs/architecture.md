# Architecture and trust boundaries

## Components

```text
Codex model
   │ MCP stdio
   ▼
Codexeni (Node MCP server)
   │ argv + inherited environment; no token handling
   ▼
agy --output-format stream-json --model gemini-3.7-flash-high
   │
   ▼
Antigravity CLI authentication and local coding tools
```

The plugin manifest points Codex at `.mcp.json`. Its stdio entry uses `cwd: "."` and launches `./dist/index.js`, so the command remains relative to the installed plugin directory after marketplace installation. The build bundles runtime dependencies into `dist/index.js`; this avoids relying on workspace-specific pnpm links after Codex copies the plugin into its cache:

```json
{
  "mcpServers": {
    "antigravity-bridge": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/dist/index.js"]
    }
  }
}
```

The MCP server owns process lifecycle, workspace-root checks, job IDs, bounded event retention, cancellation, timeout handling, and sanitized status. The root check validates the selected working directory; it does not technically prevent a full-permission worker from reaching outside it. `agy` owns OAuth, model availability, and the worker's coding tools. Codex owns user approval, scope decisions, diff review, and independent verification.

The bridge permits up to four concurrent jobs as a local ceiling. This is an implementation limit for one bridge process, not a published Antigravity/Google concurrency quota. Flash and Pro share the account-visible five-hour and weekly usage buckets; the official Antigravity `/usage` surface is the source of account state.

## Environment contract

The MCP configuration allow-lists optional bridge environment variables inherited from the Codex process. `AGY_BRIDGE_ALLOWED_ROOTS` is an explicit override, split using the platform path delimiter (`;` on Windows, `:` on POSIX). When it is unset, the server requests standard MCP `roots/list` entries from the Codex client and follows `roots/list_changed`; it accepts only `file://` roots. If the client provides no usable root, the canonical workspace supplied with each task becomes that task's exact boundary. `AGY_BRIDGE_PERMISSION_MODE` defaults to `restricted`; `full` adds Antigravity's `--dangerously-skip-permissions` flag. `AGY_BRIDGE_AGY_PATH` is optional and overrides executable discovery when `agy` is not on `PATH`. `AGY_BRIDGE_MAX_CONCURRENCY` defaults to 4 and accepts a local ceiling from 1 through 4; higher values are silently clamped to 4.

No environment configuration is required for the default restricted workflow. Set optional overrides before launching Codex, then restart Codex so the newly spawned MCP process inherits them. The server never defaults root discovery to `${PLUGIN_ROOT}` or its own `process.cwd`; without an explicit or MCP root, it canonicalizes the workspace requested for each task and uses that exact directory as the task boundary. These checks select the worker cwd; they are not hard operating-system containment. The bridge passes `--sandbox` best-effort, but this is not a guaranteed filesystem boundary for every Antigravity tool or platform.

## Data flow

1. The server prefers an explicit environment root, then the Codex client's `roots/list`; it accepts only `file://` roots and tracks `roots/list_changed`. If neither is available, the task's canonical requested workspace is its exact boundary.
2. Codex calls `antigravity_health`; the server checks the executable and public model listing. It must not read credential stores.
3. Codex calls `antigravity_start_task` with a task, workspace, `taskMode` (`coding` or `read_only`), `maxRetries`, optional model/effort overrides, and timeout. Coding tasks launch Antigravity with `--mode accept-edits`; read-only tasks use `--mode plan`. Both retain `--sandbox`. Coding tasks use zero automatic retries; no-change read-only tasks may use at most two bounded retries. Permission mode is configured for the whole server process through the environment. The server canonicalizes and validates the workspace before spawning `agy`.
4. The worker emits NDJSON. The server stores a bounded, sanitized event tail and a sanitized temporary log outside the repository. Logs are not returned wholesale.
5. Codex polls with `antigravity_get_task`. The server reports lifecycle status, assistant summary, usage when provided, exit diagnostics, and changed-file inventory.
6. Codex reviews the workspace and runs the repository's own checks. A successful worker exit is not a successful task until this review passes.

## Failure and conflict model

- A malformed event, non-zero exit, timeout, or lost server process produces a visible terminal failure state.
- Classify provider failures as quota/rate-limit (`429`), session/disconnect, context, or authentication. A `429` requires checking official `/usage`; authentication/session failures require manual repair; context failures require reducing task scope.
- Coding tasks never auto-retry. Only no-change `read_only` tasks can retry automatically, capped at two retries, with the same model and account.
- Maintain a per-model circuit breaker. A rate/quota failure blocks new work for that model until the reported cooldown expires; health exposes the active breaker. Never switch models or accounts automatically, purchase paid capacity, or consume G1 credits.
- Cancellation targets only the tracked child process tree.
- Jobs are intentionally in-memory in the PoC. Restarting the MCP server loses their status; Codex must inspect the workspace before retrying an interrupted task.
- Two jobs may overlap in the PoC, but the server reports an overlap warning. It does not merge or isolate changes automatically.
- If a coding task leaves partial changes, Codex reviews the diff and runs tests before any retry or Luna/Terra fallback is considered. Same-workspace simultaneous writers remain unsafe.
- The server inventories workspace changes but does not understand a prompt-level file allow-list. Codex must compare the inventory and full diff against the declared scope; any changed path outside it is a scope violation requiring human review.

## Security boundary

The bridge intentionally inherits the local user's `agy` permissions. That can include filesystem writes, shell commands, network access, and access beyond the selected workspace in full mode. The bridge requests Antigravity's terminal sandbox, but on some platforms or for non-terminal tools this is not a complete filesystem boundary. The default workflow therefore requires approval for task starts, validates the selected workspace, uses exact model selection, and asks the worker not to read or print secrets. These controls reduce risk but are not a sandbox or a security guarantee.

Additional limits, consolidated in [`SECURITY.md`](../SECURITY.md): event and log redaction covers labeled fields only; the changed-file inventory is metadata-based (size and mtime) and treats `.git`, `node_modules`, `dist`, `build`, and similar excluded directories as blind spots; and Windows requires the native `agy` executable because `.cmd`/`.bat` shims cannot be spawned without a shell.
