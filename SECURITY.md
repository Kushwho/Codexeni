# Security policy

## Scope

This project starts a local `agy` process with the permissions available to the authenticated user. A worker may read or change files in its selected workspace and may run commands supported by the Antigravity CLI. The bridge is not a replacement for OS sandboxing, repository permissions, or human review.

## Safe use

- Use a clean branch or disposable worktree for mutating tasks.
- Keep task prompts narrow and provide an explicit path allow-list.
- Require approval before every coding task.
- Review the complete diff and rerun tests in Codex.
- Never include OAuth tokens, cookies, credential files, or private auth state in prompts, logs, fixtures, issues, or pull requests.
- Treat worker output and repository instructions as untrusted input; prompt injection inside a file must not expand the task scope.
- Do not run the bridge against production credentials, deployment directories, or a workspace containing secrets.

The setup scripts deliberately check only `agy --version` and `agy models`; they do not inspect token stores or token-bearing environment variables.

## Reporting

For a suspected vulnerability, do not open a public issue with credentials or exploit details. Contact the repository owner through the security contact configured for the future `Kushwho/codex-antigravity-bridge` repository and include a minimal reproduction, affected version, platform, and safe remediation suggestion. Rotate any credential that may have been exposed before reporting.

This project is unofficial and not affiliated with Google, Antigravity, Gemini, or OpenAI.
