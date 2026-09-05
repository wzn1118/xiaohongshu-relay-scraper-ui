[CmdletBinding()]
param(
    [string]$OutputPath = 'deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-windows-x64.zip',
    [string]$SourceRef = 'HEAD',
    [string]$ArchiveRoot = 'xiaohongshu-relay-scraper-ui-codex-built-in-windows-x64',
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "xhs-codex-package-$([Guid]::NewGuid().ToString('N'))"
$baseOutputPath = Join-Path $temporaryRoot 'base.zip'
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
$basePackager = Join-Path $PSScriptRoot 'package-github-release.ps1'
$baseOutput = @(& $basePackager -OutputPath $baseOutputPath -SourceRef $SourceRef -ArchiveRoot $ArchiveRoot 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Base release packaging failed: $($baseOutput -join [Environment]::NewLine)" }

$resolvedOutputPath = if ([IO.Path]::IsPathRooted($OutputPath)) {
    [IO.Path]::GetFullPath($OutputPath)
} else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
}

$stageRoot = Join-Path $temporaryRoot 'stage'
Expand-Archive -LiteralPath $baseOutputPath -DestinationPath $stageRoot -Force
$projectRoot = Join-Path $stageRoot $ArchiveRoot
$node = Get-Command node.exe -ErrorAction Stop
$runtimeResult = @(& $node.Source (Join-Path $repositoryRoot 'scripts\codex-runtime-artifact.mjs') --mode stage --source-root $repositoryRoot --stage-root $projectRoot --platform win32 --architecture $Architecture 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Windows Codex runtime staging failed: $($runtimeResult -join [Environment]::NewLine)" }

$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$resolvedOutputPath.sha256" -Force -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $resolvedOutputPath, [IO.Compression.CompressionLevel]::Optimal, $false)

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
        'scripts/codex-runtime-artifact.mjs',
        'public/codex/index.html',
        'public/codex/app.js',
        'public/codex-browser-host.js',
        'src/App.tsx',
        'runtime/codex/codex-runtime-manifest.json',
        "runtime/codex/win32-$Architecture/bin/codex.exe"
    )) {
        if ($entryNames -notcontains "$ArchiveRoot/$relativePath") {
            throw "Codex release archive is missing required entry: $relativePath"
        }
    }
} finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedOutputPath).Hash.ToLowerInvariant()
$checksumPath = "$resolvedOutputPath.sha256"
"$hash  $([IO.Path]::GetFileName($resolvedOutputPath))`n" | Set-Content -LiteralPath $checksumPath -Encoding ascii
[ordered]@{
    archive = [IO.Path]::GetFileName($resolvedOutputPath)
    checksum = "$([IO.Path]::GetFileName($resolvedOutputPath)).sha256"
    sha256 = $hash
    sourceRef = $SourceRef
    edition = 'codex-built-in'
    platform = 'win32'
    architecture = $Architecture
    runtimeManifest = 'runtime/codex/codex-runtime-manifest.json'
    launchEntry = 'Start-Codex-App.cmd'
    entryCount = $entryNames.Count
} | ConvertTo-Json
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
