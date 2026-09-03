[CmdletBinding()]
param(
    [string]$OutputPath = 'deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-windows.zip',
    [string]$SourceRef = 'HEAD',
    [string]$ArchiveRoot = 'xiaohongshu-relay-scraper-ui-codex-built-in'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$basePackager = Join-Path $PSScriptRoot 'package-github-release.ps1'
$baseOutput = @(& $basePackager -OutputPath $OutputPath -SourceRef $SourceRef -ArchiveRoot $ArchiveRoot 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Base release packaging failed: $($baseOutput -join [Environment]::NewLine)" }

$resolvedOutputPath = if ([IO.Path]::IsPathRooted($OutputPath)) {
    [IO.Path]::GetFullPath($OutputPath)
} else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($resolvedOutputPath)
try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($relativePath in @(
        'Start-Codex-App.cmd',
        'CODEX_BUILT_IN_START.md',
        'server/ai-session-store.mjs',
        'server/codex-app-server-transport.mjs',
        'server/codex-browser-service.mjs',
        'server/codex-model-bridge-service.mjs',
        'server/codex-runtime-resolver.mjs',
        'public/codex/index.html',
        'public/codex/app.js',
        'public/codex-browser-host.js',
        'src/App.tsx'
    )) {
        if ($entryNames -notcontains "$ArchiveRoot/$relativePath") {
            throw "Codex release archive is missing required entry: $relativePath"
        }
    }
} finally {
    $archive.Dispose()
}

$sha256 = [Security.Cryptography.SHA256]::Create()
$fileStream = [IO.File]::OpenRead($resolvedOutputPath)
try {
    $hash = ([BitConverter]::ToString($sha256.ComputeHash($fileStream))).Replace('-', '').ToLowerInvariant()
} finally {
    $fileStream.Dispose()
    $sha256.Dispose()
}
[ordered]@{
    archive = $resolvedOutputPath
    checksum = "$resolvedOutputPath.sha256"
    sha256 = $hash
    sourceRef = $SourceRef
    edition = 'codex-built-in'
    launchEntry = 'Start-Codex-App.cmd'
    entryCount = $entryNames.Count
} | ConvertTo-Json
