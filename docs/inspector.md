# MCP Inspector

## What it is

Codexeni's MCP server (`plugins/codexeni/dist/index.js`) speaks MCP, the Model
Context Protocol — the same protocol Codex, Claude Code, and other hosts use
to call its five `delegate_*` tools. The
[MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/)
is the reference debugging client for any MCP server, built and maintained by
the protocol itself. It lets you call Codexeni's tools directly, without a
host, and see exactly what goes over the wire.

Codexeni ships a config, `plugins/codexeni/inspector.json`, so the Inspector
already knows how to start the server and which environment variables to set.
You do not need to retype the command by hand.

Requires Node.js 22.19.0 or later. (Codexeni itself only requires Node 22;
the Inspector asks for a slightly newer patch release.)

## The two commands

Run these from `plugins/codexeni/`:

- `pnpm inspect` — opens the Inspector's web client in your browser. This is
  the richest view: a form for each tool's arguments, a full transcript of
  the JSON-RPC calls and responses (JSON-RPC is the message format MCP is
  built on), and the server's stderr (its diagnostic output, separate from
  the JSON-RPC channel) shown live.
- `pnpm inspect:cli` — a command-line client. It makes one request and exits,
  printing JSON, so it is easy to script. For example:

  ```powershell
  pnpm inspect:cli --method tools/list --format json
  ```

Both commands build the server first. That means you are always inspecting
the code you just changed, never a stale bundle — `dist/index.js` is
committed to the repository, and CI compares it byte-for-byte against a
fresh build, so an out-of-date `dist/` would already fail CI on its own.

The web client prints a URL to the terminal that includes a one-time session
token. Open that exact printed URL. Do not type `localhost:6274` from
memory or bookmark it — the Inspector's backend checks that token on every
API request, so a URL without it will not work.

A terminal-only interface also exists (`--tui`), but Codexeni does not wire
it up here; use the two commands above instead.

## Safety warning

Read this before running either command.

Codexeni's permission mode defaults to `full`. In `full` mode, a delegated
worker auto-approves its own tool use — nothing pauses for your review — and
the workspace check only picks which directory the worker runs in; it does
not sandbox the worker away from the rest of your filesystem. Running the
Inspector against this repository in `full` mode would let a delegated task
edit files here without asking.

To avoid that, `inspector.json` pins `BRIDGE_PERMISSION_MODE=restricted`
(which requires approval for each call) and points the server at a scratch
workspace, not this repository. If you ever switch it back to `full` for a
test, point that scratch workspace at a throwaway directory — never at this
repo.

## Use cases

**Read the tool descriptions as a model sees them.** The Inspector shows the
description text for every tool exactly as registered. These are long and
written like instructions, not documentation — `delegate_start`'s
description is a paragraph telling the calling model how to wait for a job
to finish. That text is prompt engineering aimed at the orchestrating model,
and nothing else in the codebase renders it for a human to review, so the
Inspector is the only place to check it reads correctly.

**Read a real `delegate_discover` response.** Call it with no arguments and
you get install state, login state, and the list of available models for
every harness (Antigravity, Claude Code, Codex) found on the machine, plus
the bridge's own limits — all in one response.

**Watch a live delegation.** Call `delegate_start`, then call
`delegate_status` on the returned job ID with `waitSeconds` set close to the
task's timeout. That one call blocks until the job settles, which is how the
tool is designed to be used — do not poll it in a loop. The web client's
Protocol tab shows the JSON-RPC exchange and its Console tab shows the
server's stderr, side by side, while the job is still running. Pin the
monitoring sidebar so both stay visible as you switch between tool calls. A
test suite cannot show you this; it only tells you pass or fail.

**Audit redaction against real output.** `delegate_status` returns a tail of
recent events from the worker process. Reading that raw JSON in the
Inspector is how you check the project's core promise — that account
details and secrets never reach a response — against what a worker actually
printed, not against a unit test's fake input. The redaction logic itself is
in `src/core/redaction.ts`.

**Poke error paths by hand.** Try a malformed `jobId` (not a valid UUID —
the unique ID format every job uses), a `jobId` that is a valid UUID but
does not belong to any job, an `effort` value the chosen harness does not
support, and calling `codex` without the explicit `model` it requires. Each
should fail with a clear, specific error, not a crash.

**Fast scripted checks with `--cli`.** `pnpm inspect:cli` returns a distinct
exit code per failure kind, so a script can branch on it: `5` for a tool
error, `4` when the server is unreachable, `3` for an authentication
failure.

## A known constraint

The `fixtures/fake-agy` fixture — a fast, fake stand-in for the real `agy`
CLI used in the test suite — cannot be spawned end to end on Windows through
the Inspector or through Codexeni itself. The runtime always spawns child
processes with `shell: false` (deliberately, and enforced by the
`no-shell-spawn` Semgrep rule, so task text can never be interpreted as a
shell command). Node refuses to spawn a `.cmd` file that way on Windows,
and the fixture's Windows entry point is a `.cmd` file.

So inspecting the Antigravity worker on Windows means using the real `agy`
CLI, which spends real tokens against your account. `CodexAdapter` already
works around the equivalent problem for Codex: when its executable is a
`.mjs` file, it runs that file through `process.execPath` (Node itself)
instead of asking the shell to interpret it. `AntigravityAdapter` has no
such handling yet. This is a known gap, not something this page fixes.
