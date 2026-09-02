# Security policy

## Scope

This project starts a local worker process — `agy` or `claude` — with the permissions available to the authenticated local user. A worker may read or change files in its selected workspace and may run commands supported by that CLI. Both built-in workers inherit whatever the local user is already logged into: Antigravity's account through `agy`, and Claude's account through `claude`. Delegating a task does not create or use any separate identity — it runs as that same logged-in user. The bridge is not a replacement for OS sandboxing, repository permissions, or human review.

## Claude Code worker's permission mapping

The Claude Code adapter (`plugins/codexeni/src/adapters/claude-code.ts`) turns the bridge's `permissionMode` and `taskMode` into `claude` CLI flags. In plain words:

- **`taskMode: "coding"` in `full` permission mode** passes `--dangerously-skip-permissions`. This is the bridge default, since a headless worker has no human available to answer a prompt. It auto-approves every tool the model tries to use — file edits, shell commands, everything — the same as Antigravity's own flag of that name. Treat it as broad local tool authority for that task.
- **`taskMode: "coding"` in `restricted` permission mode** passes `--permission-mode acceptEdits` instead. This is an explicit opt-in (`BRIDGE_PERMISSION_MODE=restricted`). File edits are still auto-approved, but other tool use still goes through Claude Code's normal prompts — which a headless process cannot answer, so those tools will effectively be unavailable rather than silently approved.
- **`taskMode: "read_only"`**, in either permission mode, never gets either of the flags above. It always runs with `--permission-mode dontAsk --disallowedTools Edit,Write,MultiEdit,NotebookEdit`: the edit tools are removed from what the model can even call, and only Claude Code's own read-only command set is approved automatically. This is stricter than "please don't edit files" in the prompt alone.

None of this is a sandbox. `--dangerously-skip-permissions` and `--permission-mode acceptEdits` both mean the worker's tool calls are not reviewed by a human before they run; the only real boundary is which tools are allowed to be called at all, and the workspace-root check described elsewhere in this file. Review every diff regardless of which mode a task ran in.

## Interactive worker questions

The bridge starts in `full` permission mode by default (`BRIDGE_PERMISSION_MODE=restricted` opts into per-call approval instead). A worker that needs a decision pauses as `awaiting_input`; it does not receive a secret, a permission grant, or a new scope automatically. The MCP server exposes the pending request through the 2026-07-28 MRTR `InputRequiredResult` flow, with a legacy elicitation compatibility shim for older hosts. Answers are bounded and resumed only against the reported worker conversation.

The orchestrator may answer only safe, repository-supported, reversible, in-scope details. Product decisions, scope changes, destructive actions, and permission requests must go to a human. Never use an input request to elicit passwords, API keys, tokens, cookies, browser data, or any other secret.

## Safe use

- Use a clean branch or disposable worktree for mutating tasks.
- Keep task prompts narrow and provide an explicit path allow-list.
- Pass the exact project workspace on every task. The bridge does not call MCP `roots/list`; only that workspace and an explicit `BRIDGE_ALLOWED_ROOTS` allow-list are considered.
- Require approval before every coding task.
- Review the complete diff and rerun tests in the orchestrating harness (Codex or Claude Code).
- Never include OAuth tokens, cookies, credential files, or private auth state in prompts, logs, fixtures, issues, or pull requests.
- Treat worker output and repository instructions as untrusted input; prompt injection inside a file must not expand the task scope.
- Do not run the bridge against production credentials, deployment directories, or a workspace containing secrets.

The setup scripts deliberately check only `agy --version` and `agy models`, plus `claude --version` as an optional worker check; they do not inspect token stores or token-bearing environment variables, and a missing `claude` never fails the check (it is optional, not required).

## Known limits

These controls are best-effort; none of them is a security guarantee.

- **Redaction** is pattern matching over labeled fields (`api_key=`, `authorization:`, …) only. It does not catch unlabeled raw token strings, so never assume worker output is secret-free.
- **Worker NDJSON logs** live in a temporary folder outside the repository and are never returned wholesale. The bridge does not delete them; OS temp-dir cleanup applies.
- **The changed-file inventory** compares file metadata (size and mtime) — not content hashes — and excludes `.git`, `node_modules`, `dist`, `build`, and similar directories even though a worker can write there. Treat all of those as blind spots and review them separately (including git hooks, which `git status` will not show).
- **Windows** requires the native executable for whichever worker is running — `agy` or `claude`. npm-style `.cmd`/`.bat` shims cannot be spawned without a shell; set `BRIDGE_ANTIGRAVITY_PATH` or `BRIDGE_CLAUDE_CODE_PATH` to the real executable if the CLI installed as a shim.

## Reporting

For a suspected vulnerability, do not open a public issue with credentials or exploit details. Contact the repository owner through the security contact configured for `Kushwho/Codexeni` and include a minimal reproduction, affected version, platform, and safe remediation suggestion. Rotate any credential that may have been exposed before reporting.

This project is unofficial and not affiliated with Google, Antigravity, Gemini, Anthropic, Claude, or OpenAI.
