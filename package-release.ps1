[CmdletBinding()]
param(
    [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[git-safe-commit-tool] $Message"
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $repoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 18+ is required."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found."
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\electron-builder"))) {
    Write-Step "Install dependencies with npm ci..."
    npm ci
}

Write-Step "Increment package patch version..."
$nextVersion = (npm version patch --no-git-tag-version).Trim().TrimStart("v")
Write-Step "Version: $nextVersion"
if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne $nextVersion) {
    throw "The requested artifact version must match the incremented package version: $nextVersion"
}
$Version = $nextVersion

Write-Step "Run tests..."
npm test

Write-Step "Build portable Electron executable..."
npm run package

$artifactPath = Join-Path $repoRoot "output\git-safe-commit-$Version-setup.exe"
if (-not (Test-Path -LiteralPath $artifactPath)) {
    throw "Expected Electron artifact not found: $artifactPath"
}
Write-Step "Package created: $artifactPath"
