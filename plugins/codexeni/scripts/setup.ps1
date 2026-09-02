param(
  [string]$Model = "gemini-3.7-flash-high",
  [string]$AllowedRoots = $(if ($env:BRIDGE_ALLOWED_ROOTS) { $env:BRIDGE_ALLOWED_ROOTS } else { $env:AGY_BRIDGE_ALLOWED_ROOTS }),
  [string]$ClaudeCodePath = $env:BRIDGE_CLAUDE_CODE_PATH
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "check-prerequisites.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}

if (-not [string]::IsNullOrWhiteSpace($AllowedRoots)) {
  $env:BRIDGE_ALLOWED_ROOTS = $AllowedRoots
}

if (-not [string]::IsNullOrWhiteSpace($ClaudeCodePath)) {
  $env:BRIDGE_CLAUDE_CODE_PATH = $ClaudeCodePath
}

$env:BRIDGE_ANTIGRAVITY_MODEL = $Model
node $scriptPath

Write-Host "If the check reports that OAuth is unavailable, authenticate with agy's normal interactive login command and run this check again. No token files or token-bearing environment variables were inspected."
Write-Host "claude (the optional Claude Code worker) is checked too, but a missing or unauthenticated claude never fails this check."
