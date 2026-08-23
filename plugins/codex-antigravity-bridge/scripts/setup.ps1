param(
  [string]$Model = "gemini-3.7-flash-high",
  [string]$AllowedRoots = $env:AGY_BRIDGE_ALLOWED_ROOTS
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "check-prerequisites.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}

if ([string]::IsNullOrWhiteSpace($AllowedRoots)) {
  throw "AGY_BRIDGE_ALLOWED_ROOTS is required. Pass -AllowedRoots with one or more existing roots separated by semicolons."
}

$env:ANTIGRAVITY_MODEL = $Model
$env:AGY_BRIDGE_ALLOWED_ROOTS = $AllowedRoots
node $scriptPath

Write-Host "If the check reports that OAuth is unavailable, authenticate with agy's normal interactive login command and run this check again. No token files or token-bearing environment variables were inspected."
