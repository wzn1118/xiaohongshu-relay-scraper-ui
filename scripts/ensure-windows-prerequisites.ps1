[CmdletBinding()]
param(
    [switch]$InstallRuntime,
    [switch]$InstallTools,
    [switch]$CheckOnly,
    [switch]$EnsureBrowserRelay,
    [ValidateRange(1024, 65535)]
    [int]$RelayPort = 18800,
    [ValidatePattern('^[\p{L}\p{N}_.-]+$')]
    [string]$RelayProfile = 'openclaw',
    [string]$BrowserDataDir = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $currentPath = $env:Path
    $pathEntries = @($currentPath, $machinePath, $userPath) |
        Where-Object { $_ } |
        ForEach-Object { $_.Split(';') } |
        Where-Object { $_ } |
        Select-Object -Unique
    $env:Path = [string]::Join(';', [string[]]$pathEntries)
}

function Enable-BundledRuntime {
    $runtimeRoot = Join-Path $projectRoot 'runtime'
    $nodeDir = Join-Path $runtimeRoot 'node'
    $pythonDir = Join-Path $runtimeRoot 'python'
    $pathEntries = @()
    if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe') -PathType Leaf) { $pathEntries += $nodeDir }
    if (Test-Path -LiteralPath (Join-Path $pythonDir 'python.exe') -PathType Leaf) {
        $pathEntries += $pythonDir
        $env:PYTHON_BIN = Join-Path $pythonDir 'python.exe'
    }
    if ($pathEntries.Count -gt 0) { $env:PATH = ([string]::Join(';', $pathEntries) + ';' + $env:PATH) }
}

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    if ($command.Path) { return [string]$command.Path }
    if ($command.Source) { return [string]$command.Source }
    return [string]$command.Definition
}

function Find-BrowserPath {
    $candidates = @(
        $env:XHS_BROWSER_PATH,
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($candidates) { return [string]$candidates }
    return $null
}

function Find-OpenClawPath {
    foreach ($name in @('openclaw.cmd', 'openclaw.exe', 'openclaw')) {
        $path = Find-CommandPath $name
        if ($path) { return $path }
    }
    return $null
}

function Get-WingetPath {
    $winget = Find-CommandPath 'winget.exe'
    if (-not $winget) {
        throw 'Windows App Installer (winget) is required for automatic runtime setup. Install App Installer, then run start-windows.cmd again.'
    }
    return $winget
}

function Install-WingetPackage {
    param([Parameter(Mandatory = $true)][string]$Id)
    $winget = Get-WingetPath
    Write-Host "Installing Windows package $Id..."
    & $winget install --id $Id --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Windows package installation failed: $Id (exit code $LASTEXITCODE)."
    }
    Refresh-ProcessPath
}

function Get-ToolStatus {
    $nodePath = Find-CommandPath 'node.exe'
    if (-not $nodePath) { $nodePath = Find-CommandPath 'node' }
    $npmPath = Find-CommandPath 'npm.cmd'
    if (-not $npmPath) { $npmPath = Find-CommandPath 'npm' }
    $pythonName = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
    $pythonPath = Find-CommandPath $pythonName
    $codexPath = Find-CommandPath 'codex'
    $openclawPath = Find-OpenClawPath
    $browserPath = Find-BrowserPath

    $nodeMajor = 0
    if ($nodePath) {
        try {
            $nodeVersion = ((& $nodePath --version 2>$null) | Select-Object -First 1).TrimStart('v')
            $nodeMajor = [int]$nodeVersion.Split('.')[0]
        } catch { $nodeMajor = 0 }
    }

    $pythonVersion = [Version]'0.0'
    if ($pythonPath) {
        try {
            $pythonVersion = [Version](& $pythonPath -c 'import sys; print(sys.version_info.major,sys.version_info.minor,sep=chr(46))')
        } catch { $pythonVersion = [Version]'0.0' }
    }

    return [ordered]@{
        node = if ($nodePath) { $nodePath } else { '' }
        nodeMajor = $nodeMajor
        npm = if ($npmPath) { $npmPath } else { '' }
        python = if ($pythonPath) { $pythonPath } else { '' }
        pythonVersion = $pythonVersion.ToString()
        codex = if ($codexPath) { $codexPath } else { '' }
        openclaw = if ($openclawPath) { $openclawPath } else { '' }
        browser = if ($browserPath) { $browserPath } else { '' }
    }
}

function Get-ManagedRelayStatus {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Status,
        [switch]$CheckOnly,
        [int]$Port = $RelayPort,
        [string]$Profile = $RelayProfile,
        [string]$DataDir = $BrowserDataDir
    )
    if (-not $Status.node) { return $null }
    try {
        $browserScript = Join-Path $PSScriptRoot 'start-managed-browser.mjs'
        $managedDataDir = if ($DataDir) { $DataDir } else { Join-Path $projectRoot 'data\browser' }
        $arguments = @($browserScript, '--port', [string]$Port, '--profile', $Profile, '--data-dir', $managedDataDir)
        if ($CheckOnly) { $arguments += '--check-only' }
        $output = @(& $Status.node @arguments 2>&1)
        if ($LASTEXITCODE -ne 0) { return $null }
        $json = ($output | Out-String).Trim()
        if (-not $json) { return $null }
        return ($json | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Install-NpmGlobalPackage {
    param([Parameter(Mandatory = $true)][string]$Package)
    $status = Get-ToolStatus
    if (-not $status.npm) { throw 'npm is required before installing global command-line tools.' }
    Write-Host "Installing global npm package $Package..."
    & $status.npm install --global $Package --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
        throw "Global npm package installation failed: $Package (exit code $LASTEXITCODE)."
    }
    Refresh-ProcessPath
}

Enable-BundledRuntime
Refresh-ProcessPath
$status = Get-ToolStatus

if ($InstallRuntime) {
    if (-not $status.node -or $status.nodeMajor -lt 22) {
        Install-WingetPackage 'OpenJS.NodeJS.LTS'
    }
    Refresh-ProcessPath
    $status = Get-ToolStatus
    if (-not $status.python -or [Version]$status.pythonVersion -lt [Version]'3.11') {
        Install-WingetPackage 'Python.Python.3.13'
    }
    Refresh-ProcessPath
    $status = Get-ToolStatus
}

if ($InstallTools) {
    Write-Host 'Using the bundled AI runtime; external Codex CLI is optional.'
}

if ($EnsureBrowserRelay -and -not $status.browser -and -not $CheckOnly) {
    Install-WingetPackage 'Google.Chrome'
    $status = Get-ToolStatus
}

if ($EnsureBrowserRelay -and -not $status.browser) {
    Write-Warning 'A Chromium-based browser is required for the managed browser profile.'
}

$managedRelay = Get-ManagedRelayStatus -Status $status -CheckOnly:$CheckOnly -Port $RelayPort -Profile $RelayProfile -DataDir $BrowserDataDir
if ($EnsureBrowserRelay -and -not $CheckOnly) {
    if (-not $status.node) { throw 'Node.js is required to start the managed browser.' }
    if (-not $status.browser) { throw 'A Chromium-based browser is required for the managed browser profile.' }
    Write-Host 'Starting the project-managed browser through native CDP...'
    $browserScript = Join-Path $PSScriptRoot 'start-managed-browser.mjs'
    $managedDataDir = if ($BrowserDataDir) { $BrowserDataDir } else { Join-Path $projectRoot 'data\browser' }
    $output = @(& $status.node $browserScript --port $RelayPort --profile $RelayProfile --data-dir $managedDataDir 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Project-managed browser startup failed (exit code $LASTEXITCODE)."
    }
    $managedRelay = (($output | Out-String).Trim() | ConvertFrom-Json)
}

$status.ready =
    [bool]$status.node -and
    [bool]$status.npm -and
    [bool]$status.python -and
    $status.nodeMajor -ge 22 -and
    ([Version]$status.pythonVersion -ge [Version]'3.11')
$status.builtInAiReady = $true
$status.toolsReady = $status.builtInAiReady
$status.browserReady = [bool]$status.browser
$status.relayCommandReady = [bool]$status.node
$status.relayBackend = 'native-cdp'
$status.relayProfile = $RelayProfile
$status.relayPort = $RelayPort
$status.relayServiceReady = [bool]($managedRelay -and $managedRelay.running -and $managedRelay.cdpReady)
$status | ConvertTo-Json -Depth 4

if (-not $status.ready) { exit 2 }
if ($InstallTools -and -not $status.toolsReady) { exit 2 }
if ($EnsureBrowserRelay -and (-not $status.browserReady -or -not $status.relayCommandReady -or (-not $CheckOnly -and -not $status.relayServiceReady))) { exit 2 }
exit 0
