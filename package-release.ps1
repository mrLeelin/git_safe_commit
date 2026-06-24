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

function Copy-Path {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Source -PathType Container) {
        Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
        return
    }

    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $repoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 18+ is required."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found."
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
    Write-Step "Install dependencies with npm ci..."
    npm ci
}

Write-Step "Increment package patch version..."
$nextVersion = (npm version patch --no-git-tag-version).Trim().TrimStart("v")
Write-Step "Version: $nextVersion"

Write-Step "Run tests..."
npm test

Write-Step "Build frontend..."
npm run build

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $nextVersion
}

$outputRoot = Join-Path $repoRoot "output"
$packageRoot = Join-Path $outputRoot "git-safe-commit-tool"
$zipPath = Join-Path $outputRoot "git-safe-commit-tool-$Version.zip"

if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $packageRoot | Out-Null

$runtimeItems = @(
    "dist",
    "lib",
    ".agents",
    "server.mjs",
    "package.json",
    "package-lock.json",
    "config.example.json",
    "README.md",
    "start-git-safe-commit.bat",
    "start-git-safe-commit.ps1",
    "setup-ai-skill-links.bat",
    "setup-ai-skill-links.ps1"
)

foreach ($item in $runtimeItems) {
    $source = Join-Path $repoRoot $item
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required package item not found: $item"
    }
    Copy-Path -Source $source -Destination (Join-Path $packageRoot $item)
}

Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -Force
Write-Step "Package created: $zipPath"
