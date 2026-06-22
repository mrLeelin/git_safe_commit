@echo off
setlocal

REM Call the PowerShell script that creates AI skill junctions.
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%setup-ai-skill-links.ps1"

if not exist "%PS_SCRIPT%" (
    echo [AI-SKILL-LINK] Script not found: %PS_SCRIPT%
    exit /b 1
)

powershell -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo [AI-SKILL-LINK] Failed with exit code: %EXIT_CODE%
    exit /b %EXIT_CODE%
)

echo [AI-SKILL-LINK] Done.
exit /b 0
