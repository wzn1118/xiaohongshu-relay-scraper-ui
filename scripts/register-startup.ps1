[CmdletBinding()]
param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupFile = Join-Path $startupDir 'Relay Auto Start.vbs'

if ($Remove) {
    Remove-Item -LiteralPath $startupFile -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $startupFile"
    exit 0
}

New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
$escapedRoot = $root.Replace('"', '""')
$content = @"
Option Explicit

Dim shell
Dim command

Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedRoot\scripts\one-click.ps1"" -NoBrowser"
shell.Run command, 0, False
"@
Set-Content -LiteralPath $startupFile -Value $content -Encoding ascii
Write-Host "Registered $startupFile"
