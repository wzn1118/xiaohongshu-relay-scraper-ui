[CmdletBinding()]
param(
  [string]$SourceAppDirectory = $env:XHS_CODEX_SOURCE_APP_DIR,
  [string]$UnpackedAppDirectory,
  [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedAsarSha256 = '55d9fb967596c3cf766b34bc3378d039736eb383c79b89918393df26c646e983'
$hashPrefix = $expectedAsarSha256.Substring(0, 12)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'output'))
if (-not $UnpackedAppDirectory) {
  $UnpackedAppDirectory = Join-Path $outputRoot "app-unpacked-$hashPrefix"
}
if (-not $DestinationDirectory) {
  $DestinationDirectory = Join-Path $outputRoot "codex-desktop-runtime-$hashPrefix"
}

$unpackedRoot = [System.IO.Path]::GetFullPath($UnpackedAppDirectory)
$bundleRoot = [System.IO.Path]::GetFullPath($DestinationDirectory)
if (-not ($bundleRoot.StartsWith($outputRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
  throw "DestinationDirectory must stay inside $outputRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $unpackedRoot 'webview\index.html') -PathType Leaf)) {
  throw "Complete unpacked frontend is missing at $unpackedRoot"
}

function Test-MatchingSource([string]$Candidate) {
  if (-not $Candidate) { return $false }
  $asar = Join-Path $Candidate 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { return $false }
  return (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedAsarSha256
}

$candidates = [System.Collections.Generic.List[string]]::new()
if ($SourceAppDirectory) { $candidates.Add($SourceAppDirectory) }
$candidates.Add('E:\ChatGPT-patched-26.803.10989.0\app')
Get-AppxPackage -Name '*Codex*' -ErrorAction SilentlyContinue | ForEach-Object {
  $candidate = Join-Path $_.InstallLocation 'app'
  if ($candidate) { $candidates.Add($candidate) }
}
$sourceRoot = $candidates | Where-Object { Test-MatchingSource $_ } | Select-Object -First 1
if (-not $sourceRoot) {
  throw "No complete Codex host/backend matching ASAR SHA-256 $expectedAsarSha256 was found."
}
$sourceRoot = [System.IO.Path]::GetFullPath($sourceRoot)

$destinationApp = Join-Path $bundleRoot 'app'
$destinationUnpacked = Join-Path $destinationApp 'resources\app-unpacked'
New-Item -ItemType Directory -Path $destinationApp -Force | Out-Null
New-Item -ItemType Directory -Path $destinationUnpacked -Force | Out-Null

function Copy-CompleteTree([string]$Source, [string]$Destination) {
  & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NP /NFL /NDL /NJH /NJS
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "robocopy failed with exit code $exitCode while copying $Source"
  }
}

Write-Host "Copying complete Codex desktop host and backend from $sourceRoot"
Copy-CompleteTree $sourceRoot $destinationApp
Write-Host "Copying complete unpacked Codex frontend from $unpackedRoot"
Copy-CompleteTree $unpackedRoot $destinationUnpacked

$required = @(
  'ChatGPT.exe',
  'chrome.dll',
  'resources.pak',
  'resources\app.asar',
  'resources\app-unpacked\package.json',
  'resources\app-unpacked\webview\index.html',
  'resources\codex.exe',
  'resources\codex-code-mode-host.exe',
  'resources\codex-command-runner.exe',
  'resources\rg.exe',
  'resources\plugins',
  'resources\skills'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $destinationApp $_)) })
if ($missing.Count -gt 0) {
  throw "Provisioned runtime is incomplete: $($missing -join ', ')"
}

$package = Get-Content -LiteralPath (Join-Path $unpackedRoot 'package.json') -Raw | ConvertFrom-Json
$sourceFiles = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File
$unpackedFiles = Get-ChildItem -LiteralPath $unpackedRoot -Recurse -File
$runtimeFiles = Get-ChildItem -LiteralPath $destinationApp -Recurse -File
$manifest = [ordered]@{
  schemaVersion = 1
  productName = 'Codex'
  version = [string]$package.version
  buildNumber = [string]$package.codexBuildNumber
  sourceAsarSha256 = $expectedAsarSha256
  sourceAppDirectory = $sourceRoot
  unpackedAppDirectory = $unpackedRoot
  provisionedAt = (Get-Date).ToUniversalTime().ToString('o')
  source = [ordered]@{
    fileCount = @($sourceFiles).Count
    totalBytes = [long](($sourceFiles | Measure-Object -Property Length -Sum).Sum)
  }
  unpacked = [ordered]@{
    fileCount = @($unpackedFiles).Count
    totalBytes = [long](($unpackedFiles | Measure-Object -Property Length -Sum).Sum)
  }
  runtime = [ordered]@{
    fileCount = @($runtimeFiles).Count
    totalBytes = [long](($runtimeFiles | Measure-Object -Property Length -Sum).Sum)
  }
  components = [ordered]@{
    frontend = 'app\resources\app-unpacked\webview'
    electronHost = 'app\ChatGPT.exe'
    appServer = 'app\resources\codex.exe'
    codeModeHost = 'app\resources\codex-code-mode-host.exe'
    plugins = 'app\resources\plugins'
    skills = 'app\resources\skills'
  }
}
$manifestPath = Join-Path $bundleRoot 'integration-manifest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

$manifest | ConvertTo-Json -Depth 8
