# Using Codexeni from Claude Code (local build)

Give this file to Claude Code. It explains how to install the current local build of the bridge and how to delegate a task through it, either to Antigravity or to another Claude Code process.

## 1. What must already be true

- Node.js 22+ is installed.
- Claude Code itself, obviously (you are reading this from inside it).
- This repository is checked out and built:

```powershell
cd C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni
pnpm install
pnpm build
```

- At least one worker is ready:
  - Antigravity worker: `agy` installed and logged in — `agy models` prints a list of models.
  - Claude Code worker: `claude` installed and logged in — `claude auth status --json` reports `"loggedIn": true`.

## 2. Install the plugin into Claude Code

Claude Code caches an installed plugin by its version number, the same way Codex does. Run `pnpm bump` (from `plugins/codexeni`) before every reinstall, so a rebuild is actually picked up.

Three ways to run Codexeni's tools from Claude Code:

**Marketplace install** (persists across sessions). Once this work is on the `main` branch, install straight from GitHub:

```powershell
claude plugin marketplace add Kushwho/Codexeni
claude plugin install codexeni@personal
```

Before that, the local checkout can be added by its folder path instead (`claude plugin marketplace add C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge`) — but the install only succeeds while `plugins\codexeni\node_modules` is absent, because Claude Code copies the whole folder into its cache and pnpm's symlinked `node_modules` cannot be copied on Windows. For day-to-day development use the `--plugin-dir` load below.

Start a new Claude Code session afterward. Check with `/mcp` that `codexeni` is listed, and that the `delegation` skill is listed too.

**One-session dev load** (nothing installed, forgotten when the session ends):

```powershell
claude --plugin-dir plugins\codexeni
```

**No-plugin fallback** (tools only, no `delegation` skill):

```powershell
claude mcp add codexeni -s user -- node C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni\dist\index.js
```

Claude Code passes its entire process environment to the MCP servers it starts, so any `BRIDGE_*` variable set in the shell before starting Claude Code applies — there is no `env_vars` allow-list to edit, unlike Codex's manifest.

Already had an older copy of this plugin installed? Reinstall it (remove, then repeat the marketplace steps above) any time the version in `plugins/codexeni/.claude-plugin/plugin.json` has changed, since Claude Code will otherwise keep running the cached old build.

## 3. Settings

None are required. Optional, set before starting Claude Code (restart Claude Code after changing them):

- `BRIDGE_PERMISSION_MODE=restricted` — require per-call approval instead of auto-approving the worker's tool calls. The default is `full`.
- `BRIDGE_ALLOWED_ROOTS` — explicit list of folders a worker may be started in.
- `BRIDGE_ANTIGRAVITY_MODEL` — default model for the Antigravity worker (default `gemini-3.7-flash-high`).
- `BRIDGE_ANTIGRAVITY_PATH` — full path to `agy` if it is not on `PATH`.
- `BRIDGE_CLAUDE_CODE_MODEL` — default model for the Claude Code worker (default `sonnet`).
- `BRIDGE_CLAUDE_CODE_PATH` — full path to `claude` if it is not on `PATH`.

## 4. How to delegate (instructions for Claude Code)

The bridge exposes five tools: `delegate_discover`, `delegate_start`, `delegate_status`, `delegate_respond`, `delegate_cancel`. The `delegation` skill installed with the plugin has the full rules; the short version:

1. Call `delegate_discover` once per session. Pick a harness whose `installed` is `true` and `authStatus` is `"authenticated"`, and an exact model from that harness's `models` list. Never use a model that is not listed. Repeated calls within 60 seconds reuse the previous harness check; pass `{ "refresh": true }` only when you intentionally need fresh install, login, or model state.
2. Start one small, clearly scoped task. `workspace` must be the absolute path of the repository you are working in.

Delegating to Antigravity:

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

Delegating to another Claude Code process (a separate headless subagent, not the session you are already running in):

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

Use `taskMode: "coding"` only for an isolated, reversible change, and then list the exact files the worker may touch inside `task`. For the `claude-code` worker specifically, `read_only` is enforced by the CLI flags as well as the prompt: the edit tools are removed and only read-only commands are approved, in every permission mode.

3. Poll `delegate_status` with the returned `jobId` every few seconds until `status` is `succeeded`, `failed`, `timed_out`, or `canceled`. Read `summary` (the worker's answer), `usage` (tokens), `fileChanges`, `warnings`, and `errorCategory`.
4. Verify yourself before calling the task done: inspect `git diff`, run the repository's tests, and treat any changed file outside the allowed list as a scope violation.
5. Use `delegate_cancel` with the `jobId` to stop a running task.

Safety: in the default `full` mode a `coding` task's worker approves its own commands. Work on a clean branch, keep tasks small, and never ask the worker to read or print credentials.

## 5. First smoke test

1. `delegate_discover` — expect at least one harness installed and authenticated.
2. `delegate_start` with `taskMode: "read_only"`, `workspace` = `C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge\plugins\codexeni\fixtures\clamp`, task: "Read src/clamp.mjs and test/clamp.test.mjs. Summarize what clamp does and say whether the tests cover an inverted range (min greater than max). Do not edit files." Use whichever harness `delegate_discover` reported as authenticated.
3. `delegate_status` until `succeeded`; expect a `summary` and a `usage` object, and `fileChanges` with no created/modified files.

## 6. If something goes wrong

- `installed: false` for `antigravity` — `agy` is not on `PATH`; set `BRIDGE_ANTIGRAVITY_PATH` and restart Claude Code.
- `installed: false` for `claude-code` — `claude` is not on `PATH`; set `BRIDGE_CLAUDE_CODE_PATH` and restart Claude Code.
- `authStatus` is not `authenticated` — run the CLI once interactively (`agy`, or `claude`) and log in, then retry `delegate_discover`.
- `status: "failed"` with `errorCategory` `rate_limited` or `quota_exhausted` — wait until the `blockedUntil` time shown by `delegate_status` / `delegate_discover`; check that harness's own usage surface. The bridge never switches models or accounts by itself.
- `Unknown harness` — the `harness` value must match an id from `delegate_discover` (currently `antigravity` and `claude-code`).
- `codexeni` missing from `/mcp` after a marketplace install — start a brand-new Claude Code session; a running session does not pick up a newly installed plugin.
- `EPERM: operation not permitted, symlink …` during `claude plugin install` — you are installing from a checkout that contains `plugins\codexeni\node_modules`. Use `claude --plugin-dir`, install from GitHub, or rename `node_modules` aside while installing.
