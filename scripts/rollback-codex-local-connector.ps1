[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [switch]$SkipProtocolRegistration,
    [switch]$SkipStartup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Connector state is missing: $Path" }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporaryPath, (($Value | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Assert-ConnectorTree {
    param([Parameter(Mandatory = $true)][string]$Root)
    foreach ($relative in @(
        'runtime\node.exe',
        'scripts\codex-local-connector.mjs',
        'scripts\codex-device-relay.mjs',
        'node_modules\ws\index.js',
        'connector-manifest.json',
        'run-connector.cmd'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Rollback target is incomplete: $relative"
        }
    }
    $node = Join-Path $Root 'runtime\node.exe'
    & $node --check (Join-Path $Root 'scripts\codex-local-connector.mjs') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Rollback target connector validation failed.' }
    $global:LASTEXITCODE = 0
}

if (-not $InstallRoot) {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $HOME 'AppData\Local' }
    $InstallRoot = Join-Path $localAppData 'XhsCodexConnector'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$currentPath = Join-Path $InstallRoot 'current.json'
$previousPath = Join-Path $InstallRoot 'previous.json'
$configPath = Join-Path $InstallRoot 'connector-config.json'
$current = Read-JsonFile $currentPath
$previous = Read-JsonFile $previousPath
Assert-ConnectorTree -Root ([string]$current.root)
Assert-ConnectorTree -Root ([string]$previous.root)
if ([string]$current.version -eq [string]$previous.version) { throw 'Current and previous connector versions are identical.' }

$targetRoot = [IO.Path]::GetFullPath([string]$previous.root)
$runPath = Join-Path $targetRoot 'run-connector.cmd'
if (-not $SkipProtocolRegistration) {
    $schemeKey = 'HKCU:\Software\Classes\codex-local'
    New-Item -Path $schemeKey -Force | Out-Null
    Set-Item -Path $schemeKey -Value 'URL: Codex Local Connector'
    New-ItemProperty -Path $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    $commandKey = Join-Path $schemeKey 'shell\open\command'
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -Path $commandKey -Value "`"$runPath`" --connect-url `"%1`""
}
if (-not $SkipStartup) {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    New-ItemProperty -Path $runKey -Name 'XhsCodexConnector' -Value "`"$runPath`" --background" -PropertyType String -Force | Out-Null
}

$config = Read-JsonFile $configPath
$config.connectorVersion = [string]$previous.version
Write-JsonAtomic -Path $configPath -Value $config
$now = (Get-Date).ToUniversalTime().ToString('o')
$newPrevious = [ordered]@{
    schemaVersion = 1
    version = [string]$current.version
    installedAt = [string]$current.installedAt
    deactivatedAt = $now
    root = [string]$current.root
    protocol = 'codex-local'
}
$newCurrent = [ordered]@{
    schemaVersion = 1
    version = [string]$previous.version
    installedAt = [string]$previous.installedAt
    activatedAt = $now
    rollbackFromVersion = [string]$current.version
    root = $targetRoot
    protocol = 'codex-local'
}
Write-JsonAtomic -Path $previousPath -Value $newPrevious
Write-JsonAtomic -Path $currentPath -Value $newCurrent
[ordered]@{
    state = 'rolled_back'
    fromVersion = [string]$current.version
    toVersion = [string]$previous.version
    root = $targetRoot
} | ConvertTo-Json -Depth 4

$global:LASTEXITCODE = 0
