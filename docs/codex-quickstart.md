# Using Codexeni from Codex (local build)

Give this file to Codex. It explains how to install the current local build of the bridge and how to delegate a task to Antigravity through it.

## 1. What must already be true

- Node.js 22+ is installed.
- The Antigravity CLI is installed and logged in: `agy models` prints a list of models.
- This repository is checked out on the branch with the updated bridge (`refactor/harness-core`) and built:

```powershell
cd C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni
pnpm install
pnpm build
```

## 2. Install the updated plugin into Codex

The version on GitHub `main` is the old one (tools named `antigravity_*`). Install from the local folder instead. Codex caches a plugin by its version, so the manifest version has to change every time you want Codex to pick up a rebuild — run `pnpm bump` (from `plugins/codexeni`) before every reinstall.

**Already installed this plugin before?** The Codex MCP file moved from `plugins/codexeni/.mcp.json` to `plugins/codexeni/.codex-plugin/mcp.json` (Codex's `plugin.json` now points at `./.codex-plugin/mcp.json`), and the manifest version was bumped alongside that move. An old install will not pick either change up on its own — remove and reinstall using the steps below.

```powershell
# remove the old copy (ignore an error if it is not installed)
codex plugin remove codexeni@personal

# point the "personal" marketplace at this repository
codex plugin marketplace remove personal
codex plugin marketplace add C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge

# install and restart Codex
codex plugin add codexeni@personal
```

Start a new Codex session, then check:

```powershell
codex mcp list
```

The `codexeni` row must show a `Cwd` under `.codex\plugins\cache\personal\codexeni\<version>` matching the version currently in `plugins/codexeni/.codex-plugin/plugin.json`, and an `Env` list that starts with `BRIDGE_ALLOWED_ROOTS`. If the tools are still called `antigravity_*`, the old cache is still in use: repeat this step.

Alternative without the plugin system (tools only, no skill): `codex mcp add codexeni -- node C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni\dist\index.js`

## 3. Settings

None are required. Optional, set before starting Codex (restart Codex after changing them):

- `BRIDGE_PERMISSION_MODE=restricted` — explicitly opt into per-call approval instead of broad non-interactive worker permissions. The default is `full`.
- `BRIDGE_ALLOWED_ROOTS` — explicit list of folders the worker may be started in.
- `BRIDGE_ANTIGRAVITY_MODEL` — default model (default `gemini-3.7-flash-high`).
- `BRIDGE_ANTIGRAVITY_PATH` — full path to `agy` if it is not on `PATH`.

## 4. How to delegate (instructions for Codex)

The bridge exposes five tools: `delegate_discover`, `delegate_start`, `delegate_status`, `delegate_respond`, `delegate_cancel`. The `delegation` skill installed with the plugin has the full rules; the short version:

1. Call `delegate_discover` once per session. Confirm `harnesses.antigravity.installed` is `true` and `authStatus` is `"authenticated"`. Choose a model from its `models` list (default `gemini-3.7-flash-high`). Never use a model that is not listed. Repeated calls within 60 seconds reuse the previous harness check; pass `{ "refresh": true }` only when you intentionally need fresh install, login, or model state.
2. Start one small, clearly scoped task. `workspace` must be the absolute path of the repository you are working in.

```json
{
  "task": "Review src/auth.ts for bugs. Do not edit files. Report findings with file and line.",
  "workspace": "C:\\path\\to\\the\\repo",
  "harness": "antigravity",
  "model": "gemini-3.7-flash-high",
  "taskMode": "read_only",
  "maxRetries": 0,
  "timeoutSeconds": 600
}
```

   Use `taskMode: "coding"` only for an isolated, reversible change, and then list the exact files the worker may touch inside `task`.

   Codexeni can also delegate to a `claude-code` worker (the local `claude` CLI), if it is installed and logged in. Example, using a small model for a bounded read-only task:

```json
{
  "task": "Read src/auth.ts. List any obvious bugs with file and line. Do not edit files.",
  "workspace": "C:\\path\\to\\the\\repo",
  "harness": "claude-code",
  "model": "haiku",
  "taskMode": "read_only",
  "maxRetries": 0,
  "timeoutSeconds": 600
}
```

3. Poll `delegate_status` with the returned `jobId` every few seconds until `status` is `succeeded`, `failed`, `timed_out`, or `canceled`. If it is `awaiting_input`, inspect its bounded `inputRequest`, `interactionRound`, and `continuationSupported`. Answer only a safe, repository-supported, reversible, in-scope detail with `delegate_respond` (`action: "answer"`), otherwise use `action: "elicit"` to return it to the human input flow. Never provide or request secrets.
4. Verify yourself before calling the task done: inspect `git diff`, run the repository's tests, and treat any changed file outside the allowed list as a scope violation.
5. Use `delegate_cancel` with the `jobId` to stop a running task.

Safety: `full` is the default, so a headless worker isn't left stalled waiting for a prompt nobody can answer; use it only for a narrow task in a clean branch, and never ask the worker to read or print credentials. Set `BRIDGE_PERMISSION_MODE=restricted` to require per-call approval instead.

## 5. First smoke test

1. `delegate_discover` — expect Antigravity installed and authenticated.
2. `delegate_start` with `taskMode: "read_only"`, `workspace` = `C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni\fixtures\clamp`, task: "Read src/clamp.mjs and test/clamp.test.mjs. Summarize what clamp does and say whether the tests cover an inverted range (min greater than max). Do not edit files."
3. `delegate_status` until `succeeded`; expect a `summary` and a `usage` object, and `fileChanges` with no created/modified files.

## 6. If something goes wrong

- `installed: false` — `agy` is not on `PATH`; set `BRIDGE_ANTIGRAVITY_PATH` and restart Codex.
- `authStatus` is not `authenticated` — run `agy` once interactively and log in, then retry `delegate_discover`.
- `status: "failed"` with `errorCategory` `rate_limited` or `quota_exhausted` — wait until the `blockedUntil` time shown by `delegate_status` / `delegate_discover`; check Antigravity's own `/usage`. The bridge never switches models or accounts by itself.
- `Unknown harness` — the `harness` value must match an id from `delegate_discover` (currently `antigravity` and `claude-code`).
