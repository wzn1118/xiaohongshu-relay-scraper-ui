[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string[]]$AllowedOrigin,
    [Parameter(Mandatory = $true)][string]$LocalRelayOrigin,
    [string]$InstallRoot = '',
    [switch]$SkipStartup,
    [switch]$SkipProtocolRegistration
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$zip = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "Connector package not found: $zip" }
if (-not $InstallRoot) {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $HOME 'AppData\Local' }
    $InstallRoot = Join-Path $localAppData 'XhsCodexConnector'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-connector-package-' + [guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $temporaryRoot -Force
    $installer = Join-Path $temporaryRoot 'scripts\install-codex-local-connector.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Connector package installer is missing.' }
    $installerParameters = @{
        AllowedOrigin = @($AllowedOrigin)
        LocalRelayOrigin = $LocalRelayOrigin
        InstallRoot = $InstallRoot
        SkipStartup = $SkipStartup
        SkipProtocolRegistration = $SkipProtocolRegistration
    }
    & $installer @installerParameters
    if ($LASTEXITCODE -ne 0) { throw "Connector package installation failed with exit code $LASTEXITCODE." }
    Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw
} finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
