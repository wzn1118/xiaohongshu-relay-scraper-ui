[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [string]$NodeExecutable = '',
    [string]$Version = '1.2.18',
    [string[]]$DefaultAllowedOrigin = @('https://relay.hegelsalon.com', 'http://127.0.0.1:4327'),
    [string]$DefaultLocalRelayOrigin = 'http://127.0.0.1:4327'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = $Version.Trim()
if (-not $version -or $version -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'Connector package version is invalid.' }
$defaultOrigins = @($DefaultAllowedOrigin | ForEach-Object {
    try { $uri = [Uri]$_ } catch { throw "Invalid default browser origin: $_" }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw "Default browser origin must be an HTTP(S) origin without a path: $_" }
    $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
} | Select-Object -Unique)
if ($defaultOrigins.Count -eq 0) { throw 'At least one default browser origin is required.' }
try { $defaultRelayUri = [Uri]$DefaultLocalRelayOrigin } catch { throw "Invalid default local Relay origin: $DefaultLocalRelayOrigin" }
if (-not $defaultRelayUri.IsAbsoluteUri -or $defaultRelayUri.Scheme -notin @('http', 'https') -or $defaultRelayUri.UserInfo -or $defaultRelayUri.AbsolutePath -ne '/' -or $defaultRelayUri.Query -or $defaultRelayUri.Fragment) { throw "Default local Relay origin must be an HTTP(S) origin without a path: $DefaultLocalRelayOrigin" }
$defaultRelayOrigin = $defaultRelayUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
if (-not $OutputPath) { $OutputPath = Join-Path $root "output\codex-local-connector-$version.zip" }
if (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $root $OutputPath }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath).ToLowerInvariant() -ne '.zip') { $OutputPath += '.zip' }

function Resolve-NodeExecutable {
    param([string]$Value)
    if ($Value) {
        $resolved = [IO.Path]::GetFullPath($Value)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Node executable was not found: $resolved" }
        return $resolved
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $command) { throw 'node.exe is required to package the local connector.' }
    $candidate = [string]$command.Source
    if (-not $candidate) { $candidate = [string]$command.Path }
    return [IO.Path]::GetFullPath($candidate)
}

function Copy-Tree {
    param([string]$Source, [string]$Destination)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Copy failed with exit code ${LASTEXITCODE}: $Source" }
    $global:LASTEXITCODE = 0
}

$node = Resolve-NodeExecutable $NodeExecutable
$nodeDirectory = Split-Path -Parent $node
$required = @(
    (Join-Path $root 'scripts\codex-local-connector.mjs'),
    (Join-Path $root 'scripts\codex-device-relay.mjs'),
    (Join-Path $root 'scripts\install-codex-local-connector.ps1'),
    (Join-Path $root 'scripts\rollback-codex-local-connector.ps1'),
    (Join-Path $root 'node_modules\ws\index.js')
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required connector source is missing: $path" }
}

$outputParent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
$stage = Join-Path $outputParent ('.codex-local-connector-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
    Copy-Item -LiteralPath $node -Destination (Join-Path $stage 'runtime\node.exe') -Force
    Copy-Tree -Source (Join-Path $root 'node_modules\ws') -Destination (Join-Path $stage 'node_modules\ws')
    New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force | Out-Null
    foreach ($source in @('codex-local-connector.mjs', 'codex-device-relay.mjs', 'install-codex-local-connector.ps1', 'rollback-codex-local-connector.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root "scripts\$source") -Destination (Join-Path $stage "scripts\$source") -Force
    }
    $launcher = "@echo off`r`nsetlocal`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\install-codex-local-connector.ps1`" %*`r`nif errorlevel 1 pause`r`n"
    [IO.File]::WriteAllText((Join-Path $stage 'install-codex-local-connector.cmd'), $launcher, [Text.Encoding]::ASCII)
    $manifest = [ordered]@{
        schemaVersion = 1
        version = $version
        protocol = 'codex-local'
        defaultAllowedOrigins = $defaultOrigins
        defaultLocalRelayOrigin = $defaultRelayOrigin
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        nodeVersion = (& $node --version).Trim()
        files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
            [ordered]@{ path = $_.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'; bytes = [int64]$_.Length }
        })
    }
    [IO.File]::WriteAllText((Join-Path $stage 'connector-manifest.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $OutputPath, [IO.Compression.CompressionLevel]::Fastest, $false)
    $archive = [IO.Compression.ZipFile]::OpenRead($OutputPath)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        foreach ($requiredEntry in @('runtime/node.exe', 'node_modules/ws/index.js', 'scripts/codex-local-connector.mjs', 'scripts/codex-device-relay.mjs', 'scripts/install-codex-local-connector.ps1', 'scripts/rollback-codex-local-connector.ps1', 'install-codex-local-connector.cmd', 'connector-manifest.json')) {
            if (-not ($names -contains $requiredEntry)) { throw "Connector archive is missing: $requiredEntry" }
        }
    } finally {
        $archive.Dispose()
    }
    $sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$OutputPath.sha256", "$sha256  $([IO.Path]::GetFileName($OutputPath))`r`n", [Text.Encoding]::ASCII)
    Write-Host "Connector package created: $OutputPath"
    Write-Host "Connector SHA-256: $sha256"
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$global:LASTEXITCODE = 0
