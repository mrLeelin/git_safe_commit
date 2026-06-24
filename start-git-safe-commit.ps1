[CmdletBinding()]
param(
    [switch]$SkipInstall
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
    throw "Node.js 18+ is required. Install Node.js, then run this script again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Reinstall Node.js with npm enabled."
}

if (-not $SkipInstall -and -not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
    if (Test-Path -LiteralPath (Join-Path $repoRoot "package-lock.json")) {
        Write-Step "Install dependencies with npm ci..."
        npm ci
    } else {
        Write-Step "Install dependencies with npm install..."
        npm install
    }
}

$hostName = "127.0.0.1"
$port = 19347
$configPath = Join-Path $repoRoot "config.json"
if (Test-Path -LiteralPath $configPath) {
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.server.host) { $hostName = [string]$config.server.host }
        if ($config.server.port) { $port = [int]$config.server.port }
    } catch {
        Write-Step "config.json exists but could not be parsed; falling back to $hostName`:$port."
    }
}

$url = "http://$hostName`:$port"
Write-Step "Open $url"
Start-Process $url | Out-Null

Write-Step "Start local server. Press Ctrl+C in this window to stop it."
if ((Test-Path -LiteralPath (Join-Path $repoRoot "dist")) -and -not (Test-Path -LiteralPath (Join-Path $repoRoot "src"))) {
    $env:NODE_ENV = "production"
}
npm start
