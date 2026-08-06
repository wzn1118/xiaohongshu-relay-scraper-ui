[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [string]$TargetRoot = '',
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetRoot)) { $TargetRoot = $root }
if (-not [IO.Path]::IsPathRooted($TargetRoot)) { $TargetRoot = Join-Path (Get-Location) $TargetRoot }
$TargetRoot = [IO.Path]::GetFullPath($TargetRoot)
if (-not [IO.Path]::IsPathRooted($Archive)) { $Archive = Join-Path (Get-Location) $Archive }
$Archive = [IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "Backup archive was not found: $Archive" }

. (Join-Path $root 'scripts\hegelsalon-common.ps1')
Import-HegelSalonDotEnv
$port = if ($env:PORT -match '^\d+$') { [int]$env:PORT } else { 4317 }
$environment = Initialize-HegelSalonEnvironment -Hostname 'relay.hegelsalon.com' -Port $port
$tracked = Get-HegelSalonTrackedServerProcess $environment.RuntimeRoot
if ($tracked -and -not $Force) { throw "Tracked origin PID $($tracked.Id) is running. Stop it first or use -Force." }
if ($tracked -and $Force) { Stop-HegelSalonTrackedServer $environment.RuntimeRoot }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("hegelsalon-restore-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $candidate = [IO.Path]::GetFullPath((Join-Path $temporary ($entry.FullName -replace '/', '\')))
            if (-not $candidate.StartsWith($temporary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and $candidate -ne $temporary) {
                throw "Archive contains an unsafe path: $($entry.FullName)"
            }
        }
        foreach ($entry in $zip.Entries) {
            if ([string]::IsNullOrEmpty($entry.Name)) {
                $directory = [IO.Path]::GetFullPath((Join-Path $temporary ($entry.FullName -replace '/', '\')))
                New-Item -ItemType Directory -Path $directory -Force | Out-Null
                continue
            }
            $destination = [IO.Path]::GetFullPath((Join-Path $temporary ($entry.FullName -replace '/', '\')))
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            $input = $entry.Open()
            try {
                $output = [IO.File]::Open($destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $input.CopyTo($output) } finally { $output.Dispose() }
            } finally { $input.Dispose() }
        }
    } finally { $zip.Dispose() }

    $manifestPath = Join-Path $temporary 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Backup archive is missing manifest.json.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $files = @($manifest.files)
    foreach ($entry in $files) {
        $relative = ([string]$entry.path).Replace('/', '\')
        if (-not $relative.StartsWith('payload\', [StringComparison]::OrdinalIgnoreCase)) { throw "Manifest path is outside payload: $relative" }
        $source = Join-Path $temporary $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Manifest file is missing from archive: $relative" }
        $actual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne [string]$entry.sha256) { throw "Manifest hash mismatch: $relative" }
    }

    if ($DryRun) {
        Write-Host "Archive verified. $($files.Count) files would be restored to $TargetRoot."
        exit 0
    }
    $payload = Join-Path $temporary 'payload'
    foreach ($entry in Get-ChildItem -LiteralPath $payload -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination $TargetRoot -Recurse -Force
    }
    Write-Host "Restored $($files.Count) verified files to $TargetRoot."
    Write-Host 'Restart the origin and tunnel with start-hegelsalon.cmd after checking the restored state.'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
