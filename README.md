# Codexeni

Codexeni lets one coding harness delegate bounded tasks to another local coding harness through MCP; Antigravity, Claude Code, and ZCode are the built-in workers, more adapters are planned. The calling harness remains the orchestrator: it scopes the task, reviews changes, and runs final verification.

> Unofficial project. Not affiliated with Google, Antigravity, Gemini, Anthropic, Claude, or OpenAI.

## Harnesses

A harness can play either or both of two roles: **host**, meaning it runs Codexeni as its own MCP server and calls the `delegate_*` tools (the orchestrator); or **worker**, meaning Codexeni can start it as a subagent to actually do a task. Being a host needs only a manifest written in that harness's own format — no code. Being a worker needs one small adapter file under `plugins/codexeni/src/adapters/`.

| Harness | Host (orchestrator) | Worker (subagent) |
| --- | --- | --- |
| Codex | yes | not yet (planned) |
| Claude Code | yes | yes |
| Antigravity | not yet — works today via `agy mcp add codexeni node <abs path to>/dist/index.js` | yes |
| ZCode | not yet | yes |

## Install

Requirement for every setup: Node.js 22+.

Worker requirement, depending on which worker you plan to delegate to:

- Antigravity worker: `agy` installed and authenticated; `gemini-3.7-flash-high` listed by `agy models`.
- Claude Code worker: `claude` installed and logged in (`claude auth status`).
- ZCode worker: `zcode` installed with model access configured in its own config (`~/.zcode/cli/config.json`). Verify with `zcode --json --prompt "Reply with exactly: OK"`; on Windows the adapter reaches the CLI through its npm-global `bin/zcode.js` entry automatically.

Pick the host you want to run Codexeni's tools from.

### Codex (host)

Add the GitHub repository as a Codex marketplace and install the plugin — no clone required:

```powershell
codex plugin marketplace add Kushwho/Codexeni --ref main
codex plugin add codexeni@personal
```

Start a new Codex session after installation. No bridge environment variables are required.

### Claude Code (host)

Three ways to run Codexeni's tools from Claude Code, in order of how permanent they are:

1. **Marketplace install** (persists across sessions), straight from GitHub — no clone needed:

   ```powershell
   claude plugin marketplace add Kushwho/Codexeni
   claude plugin install codexeni@personal
   ```

   Start a new Claude Code session afterward; `/mcp` should list `codexeni`, and the `delegation` skill should be listed too. A local checkout can be added the same way by its folder path, but only while `plugins\codexeni\node_modules` is absent: Claude Code copies the folder into its cache, and pnpm's symlinked `node_modules` cannot be copied on Windows. For a checkout you develop in, use option 2.

2. **One-session dev load** (no install, forgotten when the session ends): start Claude Code with

   ```powershell
   claude --plugin-dir plugins\codexeni
   ```

3. **No-plugin fallback** (tools only, no `delegation` skill):

   ```powershell
   claude mcp add codexeni -s user -- node C:\path\to\codex-antigravity-bridge\plugins\codexeni\dist\index.js
   ```

Claude Code passes its whole environment to the MCP server it starts, so any `BRIDGE_*` variable set before starting Claude Code applies.

## Use

Ask the orchestrating harness to delegate a small, explicit task, for example:

```text
Use delegate_discover to see which harnesses are installed, then delegate a read-only review of src/auth.ts to antigravity.
```

For a coding task, name the workspace, allowed files, and required tests. Codexeni exposes:

- `delegate_discover`
- `delegate_start`
- `delegate_status`
- `delegate_respond`
- `delegate_cancel`

If a worker asks a question, `delegate_status` reports `status: "awaiting_input"` with a bounded `inputRequest`, `interactionRound`, and job-specific `continuation` state. Use `delegate_respond` with `action: "answer"` to continue an existing safe task, `action: "resume"` to recover an eligible timed-out or failed conversation, or `action: "elicit"` to return the question to the host's human-input flow. The bridge never asks for secrets.

`delegate_status` returns compact event summaries by default; set `eventDetail: "full"` only while debugging. Failed jobs expose a structured `failure` diagnostic. `workspaceChanges` reports snapshot activity in the shared workspace and is explicitly marked `unattributed_shared_workspace`; it is not proof that the worker authored those files.

## Defaults

- Default harness: `antigravity`
- Default model: `gemini-3.7-flash-high` for the Antigravity worker, `sonnet` for the Claude Code worker, `glm-5.3-flash` for the ZCode worker. ZCode's CLI takes no model flag: it runs whichever model its own `config.json` selects via `model.main`, so a caller-requested model is reported as a warning rather than applied.
- Permission mode: `full` by default (`--dangerously-skip-permissions`, since there is no human available to answer a prompt in a headless session). Set `BRIDGE_PERMISSION_MODE=restricted` explicitly to require per-call approval instead. ZCode maps full to `--mode yolo`, restricted to `--mode edit`, and read-only tasks to `--mode plan` with `Edit`, `Write`, and `SendMessage` denied.
- Maximum concurrent jobs: `4`
- Coding retries: `0`
- Read-only retries: at most `2`
- Workspace boundary: the exact canonical `workspace` passed to each task, optionally constrained further by explicit `BRIDGE_ALLOWED_ROOTS`

Every task is bounded to its exact canonical workspace; it does not grant a parent directory. `BRIDGE_ALLOWED_ROOTS` is the only optional additional root policy. The bridge does not request or use MCP `roots/list`, and allowed-root checks are not an operating-system sandbox. Use clean branches or disposable worktrees and review every diff.

By default the bridge passes a worker CLI's broad "skip permission prompts" flag (`BRIDGE_PERMISSION_MODE=full`). It is not a sandbox and should be used only for a narrow, reviewed task in a disposable worktree; set `BRIDGE_PERMISSION_MODE=restricted` to require per-call approval instead.

## Optional configuration

Most users do not need these variables:

- `BRIDGE_ALLOWED_ROOTS` — explicit path-delimited allow-list; the requested workspace must be inside one of these roots
- `BRIDGE_PERMISSION_MODE` — `full` by default; set exactly `restricted` to require per-call approval instead of broad non-interactive worker permissions
- `BRIDGE_MAX_CONCURRENCY` — local ceiling from 1 through 4
- `BRIDGE_DEFAULT_TIMEOUT_SECONDS` — maximum task timeout
- `BRIDGE_DEFAULT_HARNESS` — harness id used when `delegate_start` omits `harness` (default `antigravity`)
- `BRIDGE_ANTIGRAVITY_PATH` — absolute path to `agy` when it is not on `PATH`
- `BRIDGE_ANTIGRAVITY_MODEL` — exact default model slug for the Antigravity adapter
- `BRIDGE_CLAUDE_CODE_PATH` — absolute path to `claude` when it is not on `PATH`
- `BRIDGE_CLAUDE_CODE_MODEL` — exact default model slug for the Claude Code adapter (default `sonnet`)
- `BRIDGE_ZCODE_PATH` — absolute path to the `zcode` CLI, or to its `bin/zcode.js` entry (run through Node automatically), when the default resolution is wrong
- `BRIDGE_ZCODE_MODEL` — default model slug recorded for the ZCode adapter (default `glm-5.3-flash`; informational, see Defaults)
- `BRIDGE_METRICS_FILE` — append one JSON line of usage metrics per finished job to this path
- `BRIDGE_PRICING_FILE` — JSON price table merged over the built-in rates, so a rate change needs no release

The older `AGY_BRIDGE_*` names still work as fallbacks.

Restart the orchestrating harness after changing environment variables so the MCP process inherits them.

## What a delegation cost

Every job is measured. `delegate_status` returns a `metrics` block alongside the
existing fields — tokens, cost, tool calls made by the worker, turns, and the
queued/running split — and `delegate_discover` returns `totals`, a running rollup
per harness and model for the session so far.

Harnesses report different things: Claude Code gives a cost, Antigravity gives
tokens only. So costs carry a `costSource` of `harness` or `estimated`, and an
estimate is computed from a built-in price table. A model the table does not know
yields **no** cost rather than a zero, because a zero reads as "free" in a
comparison and is the more dangerous answer.

Set `BRIDGE_METRICS_FILE` to have each finished job appended to an NDJSON file,
which is how an external tool can total up spend after the fact.

## Adding a harness

Supporting a harness has two independent parts, and a harness can pick up either one, or both:

- **Worker** — Codexeni starts the harness as a subagent. Implement `HarnessAdapter`: `probe` (version/login/models), `command` (the exact CLI to run), and `interpret` (turn one parsed output line into a normalized result). See [`plugins/codexeni/src/adapters/adapter.ts`](plugins/codexeni/src/adapters/adapter.ts) for the interface and [`plugins/codexeni/src/adapters/index.ts`](plugins/codexeni/src/adapters/index.ts) for where built-in adapters are registered.
- **Host** — the harness runs Codexeni as its own MCP server. This needs only a manifest, written in that harness's own format, that launches `dist/index.js`; no code. See [`plugins/codexeni/.codex-plugin/`](plugins/codexeni/.codex-plugin/) and [`plugins/codexeni/.claude-plugin/`](plugins/codexeni/.claude-plugin/) for the two existing manifests.

The runtime itself is harness-neutral: it owns job lifecycle, concurrency, workspace checks, and circuit breakers regardless of which adapter is running. See [`docs/architecture.md`](docs/architecture.md) for the full breakdown of the two roles.

## Verify or develop

The install includes a prebuilt runtime. Contributors can run:

```powershell
cd plugins/codexeni
pnpm install
pnpm typecheck
pnpm test
pnpm test:fixture
```

Both Codex and Claude Code cache an installed plugin by its version number, so a rebuild alone will not be picked up by an existing install. Run `pnpm bump` (from `plugins/codexeni`) before reinstalling into either host — it writes a fresh version into `package.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json` together. `pnpm check:manifests` (run in CI) fails if those three versions ever disagree, or if a host manifest stops launching `dist/index.js`.

Architecture and security details are in [`docs/architecture.md`](docs/architecture.md), [`docs/poc-runbook.md`](docs/poc-runbook.md), and [`SECURITY.md`](SECURITY.md).

## Limits

Codexeni does not automate the Antigravity IDE or Antigravity 2.0, inspect OAuth stores, switch models/accounts automatically, or guarantee provider quota. A successful worker exit is not completion until the orchestrator reviews and verifies the result.

MIT licensed.
