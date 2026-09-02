#!/usr/bin/env sh
set -eu

command -v node >/dev/null 2>&1 || {
  echo "Node.js 22 or newer is required." >&2
  exit 1
}

BRIDGE_ANTIGRAVITY_MODEL="${1:-gemini-3.7-flash-high}" \
  BRIDGE_CLAUDE_CODE_PATH="${BRIDGE_CLAUDE_CODE_PATH:-}" \
  node "$(dirname "$0")/check-prerequisites.mjs"

echo "If the check reports that OAuth is unavailable, authenticate with agy's normal interactive login command and run this check again. No token files or token-bearing environment variables were inspected."
echo "claude (the optional Claude Code worker) is checked too, but a missing or unauthenticated claude never fails this check."
