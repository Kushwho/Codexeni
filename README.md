# Codexeni

Codexeni lets Codex delegate bounded coding and review tasks to Gemini 3.7 Flash through your authenticated local Antigravity CLI (`agy`). Codex remains the orchestrator: it scopes the task, reviews changes, and runs final verification.

> Unofficial project. Not affiliated with Google, Antigravity, Gemini, or OpenAI.

## Install

Requirements:

- Codex CLI with plugin support
- Node.js 22+
- `agy` installed and authenticated
- `gemini-3.7-flash-high` listed by `agy models`

Clone the repository, add its marketplace, and install the plugin:

```powershell
git clone https://github.com/Kushwho/Codexeni.git
cd Codexeni
codex plugin marketplace add .
codex plugin add codexeni@personal
```

Start a new Codex session after installation. No bridge environment variables are required.

## Use

Ask Codex to delegate a small, explicit task, for example:

```text
Use Codexeni to ask Gemini 3.7 Flash to review src/auth.ts for bugs. Do not edit files.
```

For a coding task, name the workspace, allowed files, and required tests. Codexeni exposes:

- `antigravity_health`
- `antigravity_start_task`
- `antigravity_get_task`
- `antigravity_cancel_task`

## Defaults

- Model: `gemini-3.7-flash-high`
- Permission mode: `restricted`
- Maximum concurrent jobs: `4`
- Coding retries: `0`
- Read-only retries: at most `2`
- Workspace boundary: explicit environment roots first, MCP client roots second, otherwise the task's canonical workspace/worker cwd

The zero-config fallback is bounded to the exact canonical workspace requested for that task; it does not grant a parent directory. Allowed-root checks select the worker cwd but are not an operating-system sandbox. Use clean branches or disposable worktrees and review every diff.

Restricted coding tasks use Antigravity's `accept-edits` mode, so file edits at explicit paths inside the workspace can proceed headlessly. Antigravity still denies terminal commands that would normally require interactive approval. If a task must run commands, add narrowly scoped `permissions.allow` rules in Antigravity's `~/.gemini/antigravity-cli/settings.json`; avoid `full` unless you intentionally want every tool request auto-approved.

## Optional configuration

Most users do not need these variables:

- `AGY_BRIDGE_ALLOWED_ROOTS` — explicit path-delimited roots that override automatic workspace selection
- `AGY_BRIDGE_AGY_PATH` — absolute path to `agy` when it is not on `PATH`
- `AGY_BRIDGE_PERMISSION_MODE` — `restricted` by default; `full` grants broad Antigravity tool permissions
- `AGY_BRIDGE_MAX_CONCURRENCY` — local ceiling from 1 through 4
- `AGY_BRIDGE_DEFAULT_MODEL` — exact default model slug
- `AGY_BRIDGE_DEFAULT_TIMEOUT_SECONDS` — maximum task timeout

Restart Codex after changing environment variables so the MCP process inherits them.

## Verify or develop

The install includes a prebuilt runtime. Contributors can run:

```powershell
cd plugins/codexeni
pnpm install
pnpm typecheck
pnpm test
pnpm test:fixture
```

Architecture and security details are in [`docs/architecture.md`](docs/architecture.md), [`docs/poc-runbook.md`](docs/poc-runbook.md), and [`SECURITY.md`](SECURITY.md).

## Limits

Codexeni does not automate the Antigravity IDE or Antigravity 2.0, inspect OAuth stores, switch models/accounts automatically, or guarantee provider quota. A successful worker exit is not completion until Codex reviews and verifies the result.

MIT licensed.
