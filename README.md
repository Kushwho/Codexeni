# Codexeni

An experimental, unofficial bridge that lets Codex orchestrate bounded coding work in a local Antigravity CLI session. The bridge is packaged as a Codex plugin and uses the authenticated `agy` executable as the worker transport; Codex remains responsible for decomposition, approvals, conflict review, and final verification.

> This project is not affiliated with, endorsed by, or sponsored by Google, Antigravity, Gemini, or OpenAI. “Antigravity”, “Gemini”, and related names are used only to identify the software this project integrates with.

## What this is—and is not

The supported path is:

```text
Codex CLI → bundled MCP server → local agy CLI → authenticated Antigravity session → Gemini 3.7 Flash
```

These products are intentionally kept distinct:

| Surface | Role in this project |
| --- | --- |
| Antigravity CLI (`agy`) | Required local executable. The bridge starts it headlessly and reads its public JSON events. |
| Antigravity IDE | Not automated, scraped, or modified. Its login state may be shared by the CLI only when the vendor supports that behavior. |
| Antigravity 2.0 | Not assumed to be the same product or command surface. Compatibility must be demonstrated separately. |
| Gemini API / managed Antigravity agent | Not used by the PoC. It has separate credentials, billing, and sandbox semantics. |

The bridge is not a native Codex subagent and cannot guarantee worktree isolation. Treat simultaneous writers as a conflict risk.

## PoC layout

The plugin source lives under `plugins/codexeni/`:

- `src/` — TypeScript MCP server (built by the runtime owner).
- `dist/` — self-contained compiled runtime bundled for installation, so the cached plugin does not depend on pnpm symlinks.
- `.codex-plugin/plugin.json` — plugin metadata.
- `.mcp.json` — portable MCP launch configuration using the installed plugin directory as its working directory.
- `skills/antigravity-delegation/SKILL.md` — bounded delegation and verification workflow.
- `scripts/` — non-secret prerequisite checks.
- `fixtures/` — deterministic fake `agy` used by tests; it never reads credentials.

## Prerequisites

- Codex CLI with plugin and MCP support.
- Node.js 22 or newer.
- The official Antigravity CLI (`agy`) installed and authenticated through its normal interactive OAuth flow.
- The exact model `gemini-3.7-flash-high` visible to `agy models` (the bridge does not silently downgrade to another model).
- An allowed-root source: standard MCP `roots/list` when the Codex client supports it, or the explicit `AGY_BRIDGE_ALLOWED_ROOTS` environment override.

### Bridge environment

The MCP process inherits the environment of the Codex process that launches it. Set or change environment overrides before launching (or restarting) Codex; changing them in an already-running terminal does not reconfigure a running MCP server. Start a new Codex session after changing plugin environment settings.

When `AGY_BRIDGE_ALLOWED_ROOTS` is unset, the server asks the Codex client for standard MCP `roots/list` entries and follows `roots/list_changed`. It accepts only `file://` roots. Clients that advertise the active workspace and additional roots work without an override. Codex CLI 0.149 does not currently advertise roots, so its sessions need the explicit override. The server never falls back to `${PLUGIN_ROOT}` or the MCP process's current directory, and task starts fail closed when neither source is available.

For a per-terminal root that follows the directory from which you launch Codex, use:

```powershell
$env:AGY_BRIDGE_ALLOWED_ROOTS = (Get-Location).Path
$env:AGY_BRIDGE_PERMISSION_MODE = "restricted"
codex
```

Use semicolons to allow multiple Windows roots. The plugin MCP configuration explicitly passes these bridge variables from the Codex parent process; restart existing Codex terminals after changing them.

Configuration:

- `AGY_BRIDGE_ALLOWED_ROOTS` — explicit path-delimited roots for Codex clients that do not advertise MCP roots. When set, it overrides client-provided roots; the bridge canonicalizes the requested workspace and validates that its current working directory is within one of these roots.
- `AGY_BRIDGE_PERMISSION_MODE` — `restricted` by default; set `full` only when the user accepts broad worker permissions. In full mode the bridge passes `--dangerously-skip-permissions` to `agy`.
- `AGY_BRIDGE_AGY_PATH` — optional absolute path to `agy` when it is not on `PATH` (for example, `C:\Tools\agy\agy.exe`).
- `AGY_BRIDGE_MAX_CONCURRENCY` — optional local job ceiling from 1 through 4; defaults to 4. This does not represent or increase provider quota.

Allowed roots are a workspace-selection guard, not a hard containment boundary. In full mode, Antigravity may still reach outside the selected root through its tools. The bridge passes `--sandbox` best-effort, but that flag is not a guaranteed filesystem sandbox for every tool or platform. Use a clean branch or disposable worktree and review every diff.

The setup check only invokes `agy --version` and `agy models`. It never reads OAuth files, browser storage, environment variables containing tokens, or raw auth state:

```powershell
cd Codexeni/plugins/codexeni
./scripts/setup.ps1
```

```sh
cd Codexeni/plugins/codexeni
./scripts/setup.sh
```

If the check fails for authentication, use the normal interactive `agy` login flow supplied by your installation, then rerun the check. Do not paste a token into Codex or an issue.

## Local plugin testing

Build the runtime first (the runtime package owns its dependency installation and tests):

```powershell
cd Codexeni/plugins/codexeni
pnpm install
pnpm build
```

The repo-local marketplace is at `Codexeni/.agents/plugins/marketplace.json`. Add that marketplace to Codex if it is not already configured, then install `codexeni` and start a new Codex session so its skills and MCP tools are loaded.

Use the plugin skill for bounded work. A safe first request is a read-only review or a small disposable fixture change. For a mutating task, state the allowed paths and required checks explicitly; Codex should inspect the complete diff and rerun verification after Antigravity finishes.

## MCP tools

The PoC exposes the following workflow:

- `antigravity_health` — inspect CLI/model readiness without returning credentials.
- `antigravity_start_task` — start one bounded worker job in an allowed workspace. The input contract includes `workspace`, `taskMode` (`coding` or `read_only`), and `maxRetries`; coding tasks must use `maxRetries: 0`. A workspace must be within the explicit override roots or the usable Codex client roots.
- `antigravity_get_task` — poll a job and retrieve a bounded event tail, result, and change summary.
- `antigravity_cancel_task` — terminate a running job by its bridge job ID.

An Antigravity coding task may execute commands and modify files, so review the task prompt, workspace, and permission mode before starting it. Codex remains responsible for reviewing the worker's diff and independently running verification.

### Quota, retry, and fallback policy

The bridge permits up to four concurrent jobs as a local process ceiling. This is not a published Antigravity or Google concurrency quota, and it does not increase the account's provider allowance. Simultaneous jobs targeting the same workspace remain unsafe because their writes can overlap.

Gemini Flash and Pro usage is reported through shared, account-visible five-hour and weekly buckets. Treat the official Antigravity `/usage` surface as the source of account state; do not infer quota from bridge job count, local logs, or model names. A provider `429` is classified as quota/rate-limit pressure and should trigger a usage check, not an account or model switch. Google’s [Antigravity CLI codelab](https://codelabs.developers.google.com/sdd-agy-cli) likewise directs users to `/usage` when quota is encountered.

Classify failures before deciding what to do:

- `429`, quota, or rate-limit responses: usage/quota pressure; coding tasks never auto-retry.
- Session/disconnect failures: worker session state is unavailable; repair or restart the session manually.
- Context failures: the task is too large for the worker context; reduce scope or prompt size manually.
- Authentication failures: OAuth or account state needs manual repair; never copy tokens into prompts or logs.

Only no-change `read_only` tasks may use bounded automatic retries, with at most two retries and the same model/account. Coding tasks never auto-retry, and no task automatically switches model or account, buys paid capacity, or consumes G1 credits. A per-model circuit breaker stops new attempts after a rate/quota failure until its reported cooldown expires; `antigravity_health` exposes active breakers. If a coding task made partial changes, Codex must inspect the diff and run tests first; after that review, the user may choose a Luna/Terra fallback. Do not retry over an unreviewed partial workspace.

## Verification gate

The PoC has been tested successfully with deterministic fake-`agy` coverage for success, malformed output, failure classification, retry-after formats, safe read-only retries, timeout recovery, cancellation, four-job concurrency, circuit breaking, workspace validation/change gating, and secret redaction, plus the plugin build/typecheck/test flow. It also passed an authenticated Windows smoke run with `agy` 1.1.19 and `gemini-3.7-flash-high`: the worker implemented a disposable fixture, and Codex independently reran all three fixture tests. Repeat the live smoke on each machine and platform before relying on it for a new repository.

The bridge is ready for a public plugin experiment only when all of the following are true:

1. `agy --version`, `agy models`, and one headless Gemini 3.7 Flash smoke task succeed.
2. The fake-`agy` fixture covers success, malformed output, failure, slow/timeout, and cancellation paths.
3. Codex independently reviews the diff and reruns the fixture or target-repository checks after a real bounded task.
4. No credentials, auth state, raw logs, or unrelated files enter the repository.

See [`docs/poc-runbook.md`](docs/poc-runbook.md) for the staged test procedure and [`docs/architecture.md`](docs/architecture.md) for the process and trust boundaries.

## Release posture

Version `0.1.0` is an experimental PoC with deterministic CI, a bundled runtime, a repo-local marketplace, and a successful local install/live proof. The next milestones are fresh-install testing on additional platforms, stronger process persistence and isolation, a frozen runtime API, and a deeper threat-model review. Public releases retain the unofficial integration disclaimer and keep worker starts visibly mutating and approval-aware.
