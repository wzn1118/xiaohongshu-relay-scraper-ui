[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed.Split('=', 2)
        if ($parts.Count -eq 2 -and $parts[1]) {
            [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
        }
    }
}

function Get-AppUrl {
    $listenHost = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }
    $browserHost = if ($listenHost -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $listenHost }
    $listenPort = if ($env:PORT) { [int]$env:PORT } else { 4317 }
    return "http://${browserHost}:$listenPort"
}

function Test-AppHealth {
    param([string]$Url)
    try {
        $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
        return $health.ok -eq $true -and $health.service -eq 'xiaohongshu-relay-scraper'
    } catch {
        return $false
    }
}

function Test-PortOpen {
    param([string]$HostName, [int]$PortNumber)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($HostName, $PortNumber, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(1000, $false)) { return $false }
        $client.EndConnect($result)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Open-App {
    param([string]$Url)
    if (-not $NoBrowser) { Start-Process $Url }
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $currentPath = $env:Path
    $pathEntries = @($machinePath, $userPath, $currentPath) |
        Where-Object { $_ } |
        ForEach-Object { $_.Split(';') } |
        Where-Object { $_ } |
        Select-Object -Unique
    $env:Path = [string]::Join(';', [string[]]$pathEntries)
}

function Connect-Relay {
    param([string]$Url)
    try {
        $config = Invoke-RestMethod -Method Get -Uri "$Url/api/relay/config" -TimeoutSec 10
        if ($config.autoConnect -eq $false) {
            Write-Host "Relay auto-connect is disabled by configuration"
            return $true
        }
        $relayPort = if ($config.port) { [int]$config.port } else { 18792 }
        $relayProfile = if ($config.profile) { [string]$config.profile } else { "chrome" }
        $body = @{ port = $relayPort; profile = $relayProfile } | ConvertTo-Json -Compress
        $status = Invoke-RestMethod -Method Post -Uri "$Url/api/relay/connect" -ContentType "application/json" -Body $body -TimeoutSec 35
        $port = if ($status.port) { $status.port } else { $relayPort }
        $tabs = if ($status.tabs) { $status.tabs } else { 0 }
        $ready = $status.ready -or ($status.running -and $status.cdpReady -and $tabs -gt 0)
        Write-Host "Relay code startup: ready=$ready port=$port tabs=$tabs attempted=$($status.attempted)"
        return $ready
    } catch {
        Write-Warning "Relay code startup did not complete: $($_.Exception.Message)"
        return $false
    }
}

Import-DotEnv (Join-Path $root '.env')
if ($Port -gt 0) { $env:PORT = [string]$Port }
$url = Get-AppUrl

if (Test-AppHealth $url) {
    Write-Host "Application is already running at $url"
    if (-not $CheckOnly) { Connect-Relay $url | Out-Null }
    if (-not $CheckOnly) { Open-App $url }
    exit 0
}

if (-not $CheckOnly) {
    Write-Host 'Preparing Windows runtime and command-line tools...'
    & (Join-Path $PSScriptRoot 'ensure-windows-prerequisites.ps1') -InstallRuntime -InstallTools
    if ($LASTEXITCODE -ne 0) { throw 'Windows prerequisites are not ready.' }
    Refresh-ProcessPath
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
$pythonName = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
$pythonCommand = Get-Command $pythonName -ErrorAction SilentlyContinue
$nodeMajor = 0
$pythonVersion = [Version]'0.0'
if ($nodeCommand) {
    try { $nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0]) } catch { $nodeMajor = 0 }
}
if ($pythonCommand) {
    try { $pythonVersion = [Version](& $pythonCommand.Source -c 'import sys; print(sys.version_info.major,sys.version_info.minor,sep=chr(46))') } catch { $pythonVersion = [Version]'0.0' }
}
$prerequisitesReady =
    $null -ne $nodeCommand -and
    $null -ne $npmCommand -and
    $null -ne $pythonCommand -and
    $nodeMajor -ge 22 -and
    $pythonVersion -ge [Version]'3.11'
$pythonDependenciesReady = $false
if ($pythonCommand) {
    & $pythonCommand.Source -c 'import docx, openpyxl, playwright, pypdf' 2>$null
    $pythonDependenciesReady = $LASTEXITCODE -eq 0
}
$installationReady =
    (Test-Path -LiteralPath (Join-Path $root 'node_modules')) -and
    (Test-Path -LiteralPath (Join-Path $root 'dist\index.html')) -and
    $pythonDependenciesReady
$bootstrapRequired = -not $installationReady

if ($CheckOnly) {
    [ordered]@{
        ready = $prerequisitesReady
        bootstrapRequired = $bootstrapRequired
        nodeMajor = $nodeMajor
        pythonVersion = $pythonVersion.ToString()
        node = if ($nodeCommand) { $nodeCommand.Source } else { '' }
        npm = if ($npmCommand) { $npmCommand.Source } else { '' }
        python = if ($pythonCommand) { $pythonCommand.Source } else { '' }
        url = $url
    } | ConvertTo-Json
    if (-not $prerequisitesReady) { exit 2 }
    exit 0
}

if (-not $nodeCommand -or $nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
if (-not $npmCommand) { throw 'npm is required.' }
if (-not $pythonCommand) { throw 'Python 3.11 or newer is required.' }
if ($pythonVersion -lt [Version]'3.11') { throw 'Python 3.11 or newer is required.' }

if ($bootstrapRequired) {
    Write-Host 'First run detected. Installing dependencies and building the application...'
    & (Join-Path $PSScriptRoot 'bootstrap.ps1') -SkipTests
}

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
Import-DotEnv (Join-Path $root '.env')
if ($Port -gt 0) { $env:PORT = [string]$Port }
$url = Get-AppUrl

if (Test-AppHealth $url) {
    Write-Host "Application is already running at $url"
    Connect-Relay $url | Out-Null
    Open-App $url
    exit 0
}

$uri = [Uri]$url
if (Test-PortOpen $uri.Host $uri.Port) {
    throw "Port $($uri.Port) is occupied by another service. Change PORT in .env and try again."
}

Write-Host "Starting application at $url"
$server = Start-Process -FilePath $npmCommand.Source -ArgumentList @('start') -WorkingDirectory $root -NoNewWindow -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($server.HasExited) { throw "Application process exited with code $($server.ExitCode)." }
        if (Test-AppHealth $url) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Application did not become healthy within 60 seconds: $url" }
    Write-Host "Application is ready: $url"
    Connect-Relay $url | Out-Null
    Open-App $url
    $server.WaitForExit()
    exit $server.ExitCode
} finally {
    if ($server -and -not $server.HasExited) {
        & taskkill.exe /PID $server.Id /T /F *> $null
    }
}
