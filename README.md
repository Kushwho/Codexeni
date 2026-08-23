# Codex–Antigravity Bridge

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

The plugin source lives under `plugins/codex-antigravity-bridge/`:

- `src/` — TypeScript MCP server (built by the runtime owner).
- `dist/` — self-contained compiled runtime bundled for installation, so the cached plugin does not depend on pnpm symlinks.
- `.codex-plugin/plugin.json` — plugin metadata.
- `.mcp.json` — portable MCP launch configuration using `${PLUGIN_ROOT}`.
- `skills/antigravity-delegation/SKILL.md` — bounded delegation and verification workflow.
- `scripts/` — non-secret prerequisite checks.
- `fixtures/` — deterministic fake `agy` used by tests; it never reads credentials.

## Prerequisites

- Codex CLI with plugin and MCP support.
- Node.js 22 or newer.
- The official Antigravity CLI (`agy`) installed and authenticated through its normal interactive OAuth flow.
- The exact model `gemini-3.7-flash-high` visible to `agy models` (the bridge does not silently downgrade to another model).
- `AGY_BRIDGE_ALLOWED_ROOTS` set before Codex starts. At least one existing directory is mandatory; the bridge refuses task starts when it is missing.

### Bridge environment

The MCP process inherits the environment of the Codex process that launches it. Set these variables before launching (or restarting) Codex; changing them in an already-running terminal does not reconfigure a running MCP server. Start a new Codex session after changing plugin environment settings.

PowerShell uses semicolons between allowed roots:

```powershell
$env:AGY_BRIDGE_ALLOWED_ROOTS = "C:\Users\Kushal\Desktop\BWMI\frontend;C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge"
$env:AGY_BRIDGE_PERMISSION_MODE = "restricted"
codex
```

Configuration:

- `AGY_BRIDGE_ALLOWED_ROOTS` — mandatory, path-delimited roots. The bridge canonicalizes the requested workspace and validates that its current working directory is within one of these roots.
- `AGY_BRIDGE_PERMISSION_MODE` — `restricted` by default; set `full` only when the user accepts broad worker permissions. In full mode the bridge passes `--dangerously-skip-permissions` to `agy`.
- `AGY_BRIDGE_AGY_PATH` — optional absolute path to `agy` when it is not on `PATH` (for example, `C:\Users\Kushal\AppData\Local\agy\bin\agy.exe`).

Allowed roots are a workspace-selection guard, not a hard containment boundary. In full mode, Antigravity may still reach outside the selected root through its tools. The bridge passes `--sandbox` best-effort, but that flag is not a guaranteed filesystem sandbox for every tool or platform. Use a clean branch or disposable worktree and review every diff.

The setup check only invokes `agy --version` and `agy models`. It never reads OAuth files, browser storage, environment variables containing tokens, or raw auth state:

```powershell
cd experiments/codex-antigravity-bridge/plugins/codex-antigravity-bridge
./scripts/setup.ps1 -AllowedRoots "C:\Users\Kushal\Desktop\BWMI\frontend;C:\Users\Kushal\Desktop\BWMI\experiments\codex-antigravity-bridge"
```

```sh
cd experiments/codex-antigravity-bridge/plugins/codex-antigravity-bridge
AGY_BRIDGE_ALLOWED_ROOTS="$PWD/../../.." ./scripts/setup.sh
```

If the check fails for authentication, use the normal interactive `agy` login flow supplied by your installation, then rerun the check. Do not paste a token into Codex or an issue.

## Local plugin testing

Build the runtime first (the runtime package owns its dependency installation and tests):

```powershell
cd experiments/codex-antigravity-bridge/plugins/codex-antigravity-bridge
pnpm install
pnpm build
```

The repo-local marketplace is at `experiments/codex-antigravity-bridge/.agents/plugins/marketplace.json`. Add that marketplace to Codex if it is not already configured, then install `codex-antigravity-bridge` and start a new Codex session so its skills and MCP tools are loaded.

Use the plugin skill for bounded work. A safe first request is a read-only review or a small disposable fixture change. For a mutating task, state the allowed paths and required checks explicitly; Codex should inspect the complete diff and rerun verification after Antigravity finishes.

## MCP tools

The PoC exposes the following workflow:

- `antigravity_health` — inspect CLI/model readiness without returning credentials.
- `antigravity_start_task` — start one bounded worker job in an allowed workspace.
- `antigravity_get_task` — poll a job and retrieve a bounded event tail, result, and change summary.
- `antigravity_cancel_task` — terminate a running job by its bridge job ID.

An Antigravity coding task may execute commands and modify files, so review the task prompt, workspace, and permission mode before starting it. Codex remains responsible for reviewing the worker's diff and independently running verification.

## Verification gate

The PoC has been tested successfully with deterministic fake-`agy` coverage for success, malformed output, failures, timeout, cancellation, workspace validation, concurrency warnings, and secret redaction, plus the plugin build/typecheck/test flow. It also passed an authenticated Windows smoke run with `agy` 1.1.19 and `gemini-3.7-flash-high`: the worker implemented a disposable fixture, and Codex independently reran all three fixture tests. Repeat the live smoke on each machine and platform before relying on it for a new repository.

The bridge is ready for a public plugin experiment only when all of the following are true:

1. `agy --version`, `agy models`, and one headless Gemini 3.7 Flash smoke task succeed.
2. The fake-`agy` fixture covers success, malformed output, failure, slow/timeout, and cancellation paths.
3. Codex independently reviews the diff and reruns the fixture or BWMI checks after a real bounded task.
4. No credentials, auth state, raw logs, or unrelated files enter the repository.

See [`docs/poc-runbook.md`](docs/poc-runbook.md) for the staged test procedure and [`docs/architecture.md`](docs/architecture.md) for the process and trust boundaries.

## Release posture

Version `0.1.0` is an experimental PoC with deterministic CI, a bundled runtime, a repo-local marketplace, and a successful local install/live proof. The next milestones are fresh-install testing on additional platforms, stronger process persistence and isolation, a frozen runtime API, and a deeper threat-model review. Public releases retain the unofficial integration disclaimer and keep worker starts visibly mutating and approval-aware.
