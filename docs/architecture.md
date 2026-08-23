# Architecture and trust boundaries

## Components

```text
Codex model
   │ MCP stdio
   ▼
codex-antigravity-bridge (Node MCP server)
   │ argv + inherited environment; no token handling
   ▼
agy --output-format stream-json --model gemini-3.7-flash-high
   │
   ▼
Antigravity CLI authentication and local coding tools
```

The plugin manifest points Codex at `.mcp.json`. Codex resolves `${PLUGIN_ROOT}` to the installed plugin directory, so the MCP command remains portable after marketplace installation. The build bundles runtime dependencies into `dist/index.js`; this avoids relying on workspace-specific pnpm links after Codex copies the plugin into its cache:

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

## Environment contract

The MCP process inherits environment variables from the Codex process that starts it. `AGY_BRIDGE_ALLOWED_ROOTS` is mandatory and is split using the platform path delimiter (`;` on Windows, `:` on POSIX). `AGY_BRIDGE_PERMISSION_MODE` defaults to `restricted`; `full` adds Antigravity's `--dangerously-skip-permissions` flag. `AGY_BRIDGE_AGY_PATH` is optional and overrides executable discovery when `agy` is not on `PATH`.

Set or change these values before launching Codex, then restart Codex (and start a new session) so the newly spawned MCP process inherits them. Allowed roots validate the canonical task cwd only; they are not hard containment in full mode. The bridge passes `--sandbox` best-effort, but this is not a guaranteed filesystem boundary for every Antigravity tool or platform.

## Data flow

1. Codex calls `antigravity_health`; the server checks the executable and public model listing. It must not read credential stores.
2. Codex calls `antigravity_start_task` with a task, workspace, optional model/effort overrides, and timeout. Permission mode is configured for the whole server process through the environment. The server canonicalizes and validates the workspace before spawning `agy`.
3. The worker emits NDJSON. The server stores a bounded, sanitized event tail and a sanitized temporary log outside the repository. Logs are not returned wholesale.
4. Codex polls with `antigravity_get_task`. The server reports lifecycle status, assistant summary, usage when provided, exit diagnostics, and changed-file inventory.
5. Codex reviews the workspace and runs the repository's own checks. A successful worker exit is not a successful task until this review passes.

## Failure and conflict model

- A malformed event, non-zero exit, timeout, or lost server process produces a visible terminal failure state.
- Cancellation targets only the tracked child process tree.
- Jobs are intentionally in-memory in the PoC. Restarting the MCP server loses their status; Codex must inspect the workspace before retrying an interrupted task.
- Two jobs may overlap in the PoC, but the server reports an overlap warning. It does not merge or isolate changes automatically.
- The server inventories workspace changes but does not understand a prompt-level file allow-list. Codex must compare the inventory and full diff against the declared scope; any changed path outside it is a scope violation requiring human review.

## Security boundary

The bridge intentionally inherits the local user's `agy` permissions. That can include filesystem writes, shell commands, network access, and access beyond the selected workspace in full mode. The bridge requests Antigravity's terminal sandbox, but on some platforms or for non-terminal tools this is not a complete filesystem boundary. The default workflow therefore requires approval for task starts, validates the selected workspace, uses exact model selection, and asks the worker not to read or print secrets. These controls reduce risk but are not a sandbox or a security guarantee.
