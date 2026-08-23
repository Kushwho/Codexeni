# PoC runbook

Run the stages in order. Keep the fixture and test output outside the production repository, and do not paste authentication output into logs or issues.

Start Codex from the repository you want to work in. No bridge environment variables are required; restricted mode and the current task workspace are the defaults:

```powershell
codex
```

The server prefers optional `AGY_BRIDGE_ALLOWED_ROOTS`, then standard MCP `roots/list`. When neither is available, it canonicalizes the workspace supplied with each task and uses that exact directory as the task boundary. It never substitutes `${PLUGIN_ROOT}` or the MCP server's `process.cwd`. `AGY_BRIDGE_AGY_PATH` is optional when `agy` is not on `PATH`. `restricted` is the default; `full` passes `--dangerously-skip-permissions` and is not a hard sandbox. Workspace checks validate the worker's cwd, while `--sandbox` is passed best-effort and cannot guarantee containment for every tool or platform. Restart Codex after changing any optional environment override.

## 1. Prerequisite and model gate

From the plugin directory:

```powershell
node scripts/check-prerequisites.mjs
```

Pass criteria:

- `agy --version` returns successfully.
- `agy models` lists the exact `gemini-3.7-flash-high` model.
- The script reports that OAuth state was not inspected.

If authentication is unavailable, perform the normal interactive OAuth login for your `agy` installation. Never add a token to `.env`, command history, or a bug report.

## 2. Deterministic fixture gate

Build and run the runtime's unit/integration tests (`pnpm test` from `plugins/codexeni/`). The suite uses an in-process fake spawn; the `fixtures/fake-agy` binary is a manual smoke double. Covered scenarios:

- success with assistant messages and a result event;
- malformed NDJSON;
- non-zero CLI exit and stderr;
- timeout on a slow process;
- cancellation of a running process;
- the task-workspace root fallback and explicit-root override behavior;
- partial-change detection that gates read-only retries;
- two jobs targeting one workspace, with an overlap warning;
- argument values containing spaces, quotes, and shell metacharacters.

Pass criteria are structured terminal states, no shell interpolation, bounded event output, and no token-bearing data in results or logs. CI additionally verifies that the committed `dist/` bundle matches a fresh build of `src/` and that the GitHub Actions used are pinned to commit SHAs.

## 3. Real smoke task

Use a disposable directory or a clean branch. Ask Antigravity to create and test a small `clamp(value, min, max)` function, with an explicit allow-list and Node's built-in test runner. Let Codex review the complete diff and rerun the tests itself.

Record:

- exact model and `agy` version;
- bridge job state and duration;
- files changed by the worker;
- worker commands/tests;
- Codex's independent verification;
- any warnings or manual decisions.

## 4. Bounded repository task

Only after the disposable smoke task passes, use a clean worktree for the target repository. Ask the worker to read that repository's instructions and make one agreed, narrowly scoped change. Require its documented verification command, but do not ask it to repair unrelated findings.

Codex must independently run the target repository's documented checks, inspect `git status`, and confirm that no unrelated files changed. If another Luna/Terra/Codex worker writes to overlapping paths, stop and surface the overlap instead of merging automatically.

## 5. Plugin installation check

After runtime tests pass:

1. Run the plugin validator against `plugins/codexeni`.
2. Confirm `plugin.json` references `./skills/` and `./.mcp.json`.
3. Confirm `.mcp.json` resolves `node ${PLUGIN_ROOT}/dist/index.js`.
4. Install from the repo-local marketplace in a fresh Codex session.
5. Call `antigravity_health`, then perform a read-only review request before approving any coding task.

Do not publish until a fresh install works without requiring users to build the package and no credential or raw log artifact is included.

Session log (single Windows machine, August 2026 — a lab record, not a repo guarantee; repeat these checks on your own machine): the PoC passed deterministic runtime/packaging checks, local marketplace installation, an authenticated Windows fixture smoke with `agy` 1.1.19 and `gemini-3.7-flash-high`, and Codex's independent fixture verification (3/3 tests). A bounded repository proof also installed the missing ESLint flat config and replaced a configuration-load failure with actionable existing lint findings. Repeat the authenticated smoke after installation on every supported platform before treating the integration as production-ready.

## 6. Quota and retry checks

The bridge allows up to four concurrent jobs locally; this is not a provider quota. Do not use it to infer account capacity. Flash and Pro draw from shared visible five-hour and weekly usage buckets. When the official Antigravity `/usage` surface is available, use it as the source of account state.

Exercise the policy with a test double or documented provider response:

1. Classify `429` as quota/rate-limit pressure; check `/usage` and do not switch model/account or consume paid/G1 credits.
2. Classify session/disconnect, context, and authentication failures separately and report the required manual repair.
3. Confirm coding tasks use `taskMode: "coding"` and `maxRetries: 0`; they never auto-retry.
4. Confirm a no-change `taskMode: "read_only"` task can retry at most twice, bounded, with the same model/account.
5. Confirm the per-model circuit breaker blocks further attempts after a rate/quota failure until its reported cooldown expires, and that health exposes the active breaker.
6. If a coding task partially changes files, inspect the diff and run tests before considering a Luna/Terra fallback. Never retry or fall back over an unreviewed partial workspace.
