# Contributing

Thanks for helping test the Codex–Antigravity Bridge. This is an experimental integration; keep changes small and evidence-based.

## Before opening a change

- Read [`README.md`](README.md), [`SECURITY.md`](SECURITY.md), and [`docs/architecture.md`](docs/architecture.md).
- Do not include credentials, OAuth state, raw Antigravity logs, private repository contents, or generated `node_modules/` in a change.
- Keep runtime changes in the plugin runtime tree and keep packaging/docs changes separate when possible.
- Preserve the distinction between the Antigravity CLI, IDE, Antigravity 2.0, and Gemini API agent.

## Required checks

For runtime changes, run the typecheck, build, and deterministic fake-`agy` tests from `plugins/codex-antigravity-bridge/`. For packaging or skill changes, run the plugin validator and inspect the manifest, `.mcp.json`, skill frontmatter, and all referenced paths.

For BWMI integration experiments, follow the repository instructions and run frontend commands from `frontend/`. Codex must independently verify any files changed by an Antigravity worker.

## Pull requests

Describe the user-facing behavior, exact tests run, platform and `agy` version, model slug, permission mode, changed-file scope, and any known limitations. Include a short security impact statement for changes that affect process execution, workspace validation, logging, or approvals.

Do not claim compatibility with an Antigravity surface that was not tested. The project is not affiliated with Google, Antigravity, Gemini, or OpenAI.
