[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [string]$TargetRoot = '',
    [switch]$Force,
    [switch]$DryRun,
    [switch]$PreserveMcpGrants
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
$port = if ($env:PORT -match '^\d+$') { [int]$env:PORT } else { 4327 }
$environment = Initialize-HegelSalonEnvironment -Hostname 'relay.hegelsalon.com' -Port $port
$trackedServer = Get-HegelSalonTrackedServerProcess $environment.RuntimeRoot
$trackedTunnel = Get-HegelSalonTrackedTunnelProcess $environment.RuntimeRoot
$targetIsCurrentRelease = $TargetRoot.TrimEnd('\').Equals([IO.Path]::GetFullPath($root).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
if (($trackedServer -or $trackedTunnel) -and $targetIsCurrentRelease -and -not $DryRun -and -not $Force) { throw 'A tracked production origin or Tunnel is running. Stop it first or use -Force.' }
if (($trackedServer -or $trackedTunnel) -and $targetIsCurrentRelease -and -not $DryRun -and $Force) {
    Stop-HegelSalonTrackedTunnel $environment.RuntimeRoot
    Stop-HegelSalonTrackedServer $environment.RuntimeRoot
}

function Resolve-HegelSalonRestorePath {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimePath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$RestoreRoot
    )
    $runtimeFull = [IO.Path]::GetFullPath($RuntimePath)
    $releaseFull = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    $restoreFull = [IO.Path]::GetFullPath($RestoreRoot).TrimEnd('\')
    if ($runtimeFull.Equals($releaseFull, [StringComparison]::OrdinalIgnoreCase)) { return $restoreFull }
    $prefix = $releaseFull + '\'
    if ($runtimeFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        return [IO.Path]::GetFullPath((Join-Path $restoreFull $runtimeFull.Substring($prefix.Length)))
    }
    return $runtimeFull
}

function Copy-HegelSalonRestoreLabel {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$PayloadRoot,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][bool]$FileTarget
    )
    $source = Join-Path $PayloadRoot $Label
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { return }
    if ($FileTarget) {
        $files = @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)
        if ($files.Count -ne 1 -or $files[0].Name -ne (Split-Path -Leaf $Destination)) {
            throw "Backup payload for $Label does not contain the expected file $(Split-Path -Leaf $Destination)."
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
        Copy-Item -LiteralPath $files[0].FullName -Destination $Destination -Force -ErrorAction Stop
        return
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $source -Force) {
        Copy-Item -LiteralPath $child.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
    }
}

$temporaryParent = [IO.Path]::GetTempPath()
if (-not (Test-Path -LiteralPath $temporaryParent -PathType Container)) {
    $temporaryParent = Join-Path $root '.restore-staging'
    New-Item -ItemType Directory -Path $temporaryParent -Force | Out-Null
}
$temporary = Join-Path $temporaryParent ("hegelsalon-restore-" + [guid]::NewGuid().ToString('N'))
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
    if ([int]$manifest.schemaVersion -lt 1 -or [int]$manifest.schemaVersion -gt 2) { throw "Unsupported backup schema version: $($manifest.schemaVersion)" }
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
        if (-not $PreserveMcpGrants) { Write-Host 'Active MCP Grants would be revoked after restore and must be reissued.' }
        exit 0
    }
    $payload = Join-Path $temporary 'payload'
    $runtimePaths = Get-HegelSalonRuntimePaths
    $fileLabels = @('relayConfig', 'aiConfig', 'smtpConfig', 'retention', 'deletionAudit', 'diagnostics')
    foreach ($entry in Get-ChildItem -LiteralPath $payload -Force) {
        $label = [string]$entry.Name
        if (-not $runtimePaths.Contains($label)) { throw "Backup contains an unknown runtime label: $label" }
        $destination = Resolve-HegelSalonRestorePath -RuntimePath ([string]$runtimePaths[$label]) -ReleaseRoot $root -RestoreRoot $TargetRoot
        Copy-HegelSalonRestoreLabel -Label $label -PayloadRoot $payload -Destination $destination -FileTarget ($fileLabels -contains $label)
    }
    if (-not $PreserveMcpGrants) {
        $copilotRoot = Resolve-HegelSalonRestorePath -RuntimePath ([string]$runtimePaths['copilot']) -ReleaseRoot $root -RestoreRoot $TargetRoot
        $copilotDatabase = Join-Path $copilotRoot 'copilot-state.sqlite'
        $revocationScript = Join-Path $root 'scripts\revoke-mcp-grants-after-restore.mjs'
        $bundledNode = Join-Path $TargetRoot 'runtime\node\node.exe'
        $node = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
            $bundledNode
        } else {
            $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
            if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
            if ($nodeCommand) { $nodeCommand.Source } else { '' }
        }
        if (-not (Test-Path -LiteralPath $revocationScript -PathType Leaf)) { throw "MCP restore revocation helper was not found: $revocationScript" }
        if ([string]::IsNullOrWhiteSpace($node)) { throw 'Node.js is required to enforce MCP Grant revocation after restore.' }
        # node:sqlite emits an experimental warning on Node 22. Suppress it so
        # PowerShell does not treat stderr as a terminating native-command error.
        $revocationResult = @(& $node --no-warnings $revocationScript --database $copilotDatabase 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "MCP Grant revocation after restore failed: $($revocationResult -join [Environment]::NewLine)" }
        Write-Host "MCP restore boundary enforced: $($revocationResult -join '')"
        Write-Host 'Any previously active MCP Grant is revoked; create and distribute a replacement token.'
    } else {
        Write-Warning 'Active MCP Grants were preserved explicitly. Previously distributed tokens may remain usable.'
    }
    Write-Host "Restored $($files.Count) verified files to $TargetRoot."
    Write-Host 'Restart the origin and tunnel with start-production-windows.cmd after checking the restored state.'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
