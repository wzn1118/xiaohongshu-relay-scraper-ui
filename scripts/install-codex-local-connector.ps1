[CmdletBinding()]
param(
    [string[]]$AllowedOrigin = @(),
    [string]$LocalRelayOrigin = '',
    [string]$InstallRoot = '',
    [switch]$SkipProtocolRegistration,
    [switch]$SkipStartup,
    [switch]$DisableAutoUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Normalize-Origin {
    param([Parameter(Mandatory = $true)][string]$Value)
    try { $uri = [Uri]$Value } catch { throw "Invalid origin: $Value" }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
        throw "Origin must be an HTTP(S) origin without a path: $Value"
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
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

function Copy-ConnectorTree {
    param([string]$Source, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Connector copy failed with exit code $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
}

function Assert-ConnectorTree {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowLegacy
    )
    $required = @(
        'runtime\node.exe',
        'scripts\codex-local-connector.mjs',
        'scripts\codex-device-relay.mjs',
        'scripts\install-codex-local-connector.ps1',
        'node_modules\ws\index.js',
        'connector-manifest.json'
    )
    if (-not $AllowLegacy) { $required += 'scripts\rollback-codex-local-connector.ps1' }
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Connector package is incomplete: $relative"
        }
    }
    $node = Join-Path $Root 'runtime\node.exe'
    foreach ($script in @('scripts\codex-local-connector.mjs', 'scripts\codex-device-relay.mjs')) {
        & $node --check (Join-Path $Root $script) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Connector script validation failed: $script" }
    }
    $global:LASTEXITCODE = 0
}

$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Assert-ConnectorTree -Root $sourceRoot
$manifest = Read-JsonFile (Join-Path $sourceRoot 'connector-manifest.json')
$version = [string]$manifest.version
if (-not $version -or $version -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Connector package version is invalid.' }
$originInputs = if (@($AllowedOrigin).Count -gt 0) { @($AllowedOrigin) } else { @($manifest.defaultAllowedOrigins) }
$origins = @($originInputs | ForEach-Object { Normalize-Origin $_ } | Select-Object -Unique)
if ($origins.Count -eq 0) { throw 'At least one allowed browser origin is required.' }
$relayInput = if ($LocalRelayOrigin) { $LocalRelayOrigin } elseif ($manifest.defaultLocalRelayOrigin) { [string]$manifest.defaultLocalRelayOrigin } else { 'http://127.0.0.1:4317' }
$relayOrigin = Normalize-Origin $relayInput

if (-not $InstallRoot) {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $HOME 'AppData\Local' }
    $InstallRoot = Join-Path $localAppData 'XhsCodexConnector'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$versionsRoot = Join-Path $InstallRoot 'versions'
$stagedRoot = Join-Path $InstallRoot 'staged'
$targetRoot = Join-Path $versionsRoot $version
$currentPath = Join-Path $InstallRoot 'current.json'
$previousPath = Join-Path $InstallRoot 'previous.json'
$stagedStatePath = Join-Path $InstallRoot 'staged.json'
$stage = Join-Path $stagedRoot ("$version-$([guid]::NewGuid().ToString('N'))")
New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagedRoot -Force | Out-Null

$oldCurrent = Read-JsonFile $currentPath
$stagedState = [ordered]@{
    schemaVersion = 1
    version = $version
    state = 'copying'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    root = $stage
}
Write-JsonAtomic -Path $stagedStatePath -Value $stagedState

try {
    Copy-ConnectorTree -Source $sourceRoot -Destination $stage
    $runPath = Join-Path $stage 'run-connector.cmd'
    $runContents = "@echo off`r`nsetlocal`r`n`"%~dp0runtime\node.exe`" `"%~dp0scripts\codex-local-connector.mjs`" %*`r`n"
    [IO.File]::WriteAllText($runPath, $runContents, [Text.Encoding]::ASCII)
    Assert-ConnectorTree -Root $stage
    $stagedState.state = 'validated'
    Write-JsonAtomic -Path $stagedStatePath -Value $stagedState

    if (Test-Path -LiteralPath $targetRoot -PathType Container) {
        try {
            Assert-ConnectorTree -Root $targetRoot
            Remove-Item -LiteralPath $stage -Recurse -Force
        } catch {
            Remove-Item -LiteralPath $targetRoot -Recurse -Force
            Move-Item -LiteralPath $stage -Destination $targetRoot
        }
    } else {
        Move-Item -LiteralPath $stage -Destination $targetRoot
    }

    $runPath = Join-Path $targetRoot 'run-connector.cmd'
    if (-not (Test-Path -LiteralPath $runPath -PathType Leaf)) {
        [IO.File]::WriteAllText($runPath, $runContents, [Text.Encoding]::ASCII)
    }
    $stagedState.state = 'activating'
    $stagedState.root = $targetRoot
    Write-JsonAtomic -Path $stagedStatePath -Value $stagedState

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

    $config = [ordered]@{
        schemaVersion = 1
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        allowedOrigins = $origins
        localRelayOrigin = $relayOrigin
        connectorVersion = $version
        autoUpdate = -not $DisableAutoUpdate
    }
    $configPath = Join-Path $InstallRoot 'connector-config.json'
    Write-JsonAtomic -Path $configPath -Value $config

    if ($oldCurrent -and [string]$oldCurrent.version -ne $version -and (Test-Path -LiteralPath ([string]$oldCurrent.root) -PathType Container)) {
        Assert-ConnectorTree -Root ([string]$oldCurrent.root) -AllowLegacy
        $previous = [ordered]@{
            schemaVersion = 1
            version = [string]$oldCurrent.version
            installedAt = [string]$oldCurrent.installedAt
            deactivatedAt = (Get-Date).ToUniversalTime().ToString('o')
            root = [string]$oldCurrent.root
            protocol = 'codex-local'
        }
        Write-JsonAtomic -Path $previousPath -Value $previous
    }

    $current = [ordered]@{
        schemaVersion = 1
        version = $version
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        activatedAt = (Get-Date).ToUniversalTime().ToString('o')
        root = $targetRoot
        protocol = 'codex-local'
    }
    Write-JsonAtomic -Path $currentPath -Value $current
    Remove-Item -LiteralPath $stagedStatePath -Force -ErrorAction SilentlyContinue
    Write-Host "Connector installed: $targetRoot"
    Write-Host "Protocol registered: $(-not $SkipProtocolRegistration)"
    Write-Host "Allowed origins: $($origins -join ', ')"
} catch {
    $stagedState.state = 'failed'
    $stagedState.error = $_.Exception.Message
    $stagedState.failedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-JsonAtomic -Path $stagedStatePath -Value $stagedState
    throw
}

$global:LASTEXITCODE = 0
