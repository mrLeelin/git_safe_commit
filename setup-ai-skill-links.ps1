[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step
{
    param(
        [string]$Message
    )

    Write-Host "[AI-SKILL-LINK] $Message"
}

function Get-LinkTarget
{
    param(
        [System.IO.DirectoryInfo]$Directory
    )

    if ($null -eq $Directory.LinkType)
    {
        return $null
    }

    if ($Directory.Target -is [System.Array])
    {
        return [string]$Directory.Target[0]
    }

    return [string]$Directory.Target
}

function Ensure-SkillLink
{
    param(
        [string]$RepoRoot,
        [string]$SourcePath,
        [string]$RelativeTargetPath
    )

    $targetPath = Join-Path $RepoRoot $RelativeTargetPath
    $targetParentPath = Split-Path $targetPath -Parent
    $resolvedSourcePath = [System.IO.Path]::GetFullPath($SourcePath)

    if (-not (Test-Path -LiteralPath $targetParentPath))
    {
        Write-Step "Create directory: $targetParentPath"
        New-Item -ItemType Directory -Path $targetParentPath | Out-Null
    }

    if (Test-Path -LiteralPath $targetPath)
    {
        $targetItem = Get-Item -LiteralPath $targetPath -Force
        $existingLinkTarget = Get-LinkTarget -Directory $targetItem

        if ($existingLinkTarget)
        {
            $resolvedExistingLinkTarget = [System.IO.Path]::GetFullPath($existingLinkTarget)
            if ($resolvedExistingLinkTarget -eq $resolvedSourcePath)
            {
                Write-Step "Link already correct, skip: $RelativeTargetPath -> $resolvedSourcePath"
                return
            }

            throw "Existing link points elsewhere: $RelativeTargetPath -> $resolvedExistingLinkTarget"
        }

        $backupSuffix = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupPath = "$targetPath.backup_$backupSuffix"
        Write-Step "Backup existing directory: $RelativeTargetPath -> $backupPath"
        Move-Item -LiteralPath $targetPath -Destination $backupPath
    }

    Write-Step "Create junction: $RelativeTargetPath -> $resolvedSourcePath"
    New-Item -ItemType Junction -Path $targetPath -Target $resolvedSourcePath | Out-Null
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath($scriptRoot)
$sourceSkillsPath = Join-Path $repoRoot ".agents\skills"

if (-not (Test-Path -LiteralPath $sourceSkillsPath))
{
    throw "Unified skill directory not found: $sourceSkillsPath"
}

Write-Step "Repo root: $repoRoot"
Write-Step "Unified skill directory: $sourceSkillsPath"

$targetDirectories = @(
    ".codex\skills",
    ".claude\skills",
    ".kiro\skills"
)

foreach ($targetDirectory in $targetDirectories)
{
    Ensure-SkillLink -RepoRoot $repoRoot -SourcePath $sourceSkillsPath -RelativeTargetPath $targetDirectory
}

Write-Step "Done."
