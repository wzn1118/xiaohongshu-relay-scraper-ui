[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$codexHome = if ($env:CODEX_HOME) {
    [Environment]::ExpandEnvironmentVariables($env:CODEX_HOME)
} else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
}
$configPath = Join-Path $codexHome 'config.toml'
$templatePath = Join-Path $root 'config\codex-config.example.toml'

if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Codex config template is missing: $templatePath"
}

$created = $false
if (-not (Test-Path -LiteralPath $configPath) -and -not $CheckOnly) {
    New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
    Copy-Item -LiteralPath $templatePath -Destination $configPath
    $created = $true
}

$result = [ordered]@{
    ready = Test-Path -LiteralPath $configPath
    configPath = [IO.Path]::GetFullPath($configPath)
    source = if ($created) { 'project-default' } elseif (Test-Path -LiteralPath $configPath) { 'existing' } else { 'missing' }
    requiresLogin = $true
}
$result | ConvertTo-Json -Compress
if (-not $result.ready) { exit 2 }
