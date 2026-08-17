[CmdletBinding()]
param(
    [string]$Destination = '',
    [switch]$Quiesce,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

function Add-HegelSalonBackupSource {
    param(
        [hashtable]$SourceMap,
        [string]$Label,
        [string]$Path
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved)) {
        Write-Warning "Backup source is absent and will be skipped: $Label"
        return
    }
    $SourceMap[$Label] = $resolved
}

function Copy-HegelSalonBackupSource {
    param(
        [string]$Label,
        [string]$Source,
        [string]$PayloadRoot
    )
    $target = Join-Path $PayloadRoot $Label
    if (Test-Path -LiteralPath $Source -PathType Container) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
            Copy-Item -LiteralPath $child.FullName -Destination $target -Recurse -Force -ErrorAction Stop
        }
    } else {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item -LiteralPath $Source -Destination (Join-Path $target (Split-Path -Leaf $Source)) -Force -ErrorAction Stop
    }
}

function Get-HegelSalonManifestFiles {
    param([string]$PayloadRoot)
    $files = @()
    foreach ($file in Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse -Force) {
        $relative = $file.FullName.Substring($PayloadRoot.Length).TrimStart('\', '/') -replace '\\', '/'
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $files += [pscustomobject]@{ path = "payload/$relative"; bytes = [int64]$file.Length; sha256 = $hash }
    }
    return $files
}

Import-HegelSalonDotEnv
$port = if ($env:PORT -match '^\d+$') { [int]$env:PORT } else { 4327 }
$environment = Initialize-HegelSalonEnvironment -Hostname 'relay.hegelsalon.com' -Port $port
Ensure-HegelSalonDirectories $environment
$trackedServer = Get-HegelSalonTrackedServerProcess $environment.RuntimeRoot
$trackedTunnel = Get-HegelSalonTrackedTunnelProcess $environment.RuntimeRoot
if (($trackedServer -or $trackedTunnel) -and $Quiesce) {
    Stop-HegelSalonTrackedTunnel $environment.RuntimeRoot
    Stop-HegelSalonTrackedServer $environment.RuntimeRoot
    $trackedServer = $null
    $trackedTunnel = $null
}
if ($trackedServer -or $trackedTunnel) { Write-Warning 'A tracked production origin or Tunnel is running; use -Quiesce for a point-in-time application backup.' }

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $parent = Split-Path -Parent $root
    $Destination = Join-Path $parent ("hegelsalon-backup-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
} elseif (-not [IO.Path]::IsPathRooted($Destination)) {
    $Destination = Join-Path $root $Destination
}
$Destination = [IO.Path]::GetFullPath($Destination)
if ([IO.Path]::GetExtension($Destination).ToLowerInvariant() -ne '.zip') { $Destination += '.zip' }
if ((Test-Path -LiteralPath $Destination) -and -not $Force) { throw "Backup destination exists; use -Force to replace it: $Destination" }
if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null

$sources = @{}
foreach ($entry in (Get-HegelSalonRuntimePaths).GetEnumerator()) {
    Add-HegelSalonBackupSource -SourceMap $sources -Label ([string]$entry.Key) -Path ([string]$entry.Value)
}

$temporaryParent = [IO.Path]::GetTempPath()
if (-not (Test-Path -LiteralPath $temporaryParent -PathType Container)) {
    $temporaryParent = Join-Path $root '.backup-staging'
    New-Item -ItemType Directory -Path $temporaryParent -Force | Out-Null
}
$temporary = Join-Path $temporaryParent ("hegelsalon-backup-" + [guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $temporary 'payload'
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
try {
    foreach ($entry in $sources.GetEnumerator()) {
        Copy-HegelSalonBackupSource -Label $entry.Key -Source $entry.Value -PayloadRoot $payloadRoot
    }
    $manifest = [ordered]@{
        schemaVersion = 2
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        application = 'xiaohongshu-relay-scraper-ui'
        includes = @($sources.Keys)
        files = @(Get-HegelSalonManifestFiles -PayloadRoot $payloadRoot)
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $temporary 'manifest.json') -Encoding UTF8
    $notes = @{
        backup = 'Runtime state archive. Keep this ZIP private; auth, MCP token pepper, Grant hashes, and SMTP configuration may be included.'
        consistency = if ($Quiesce) { 'Tracked origin and Tunnel were quiesced before copying.' } else { 'Origin was not quiesced; use -Quiesce for a point-in-time copy.' }
        sidecars = 'SQLite -wal and -shm files are copied when present.'
        restoreBoundary = 'Restore revokes active MCP Grants by default. Reissue replacement tokens after restore.'
    }
    $notes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $temporary 'backup-notes.json') -Encoding UTF8
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($temporary, $Destination, [IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = [IO.Compression.ZipFile]::OpenRead($Destination)
    try {
        if (-not ($archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' })) { throw 'Created archive is missing manifest.json.' }
    } finally { $archive.Dispose() }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

$hash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Backup created: $Destination"
Write-Host "Archive SHA-256: $hash"
Write-Host 'Sensitive values are not printed; protect the archive with filesystem ACLs or encrypted storage.'
