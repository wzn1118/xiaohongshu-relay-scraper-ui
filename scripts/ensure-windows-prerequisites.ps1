[CmdletBinding()]
param(
    [switch]$InstallRuntime,
    [switch]$InstallTools
)

$ErrorActionPreference = 'Stop'

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

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    if ($command.Path) { return [string]$command.Path }
    if ($command.Source) { return [string]$command.Source }
    return [string]$command.Definition
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
    $openclawPath = Find-CommandPath 'openclaw'

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
    if (-not $status.codex) { Install-NpmGlobalPackage '@openai/codex' }
    $status = Get-ToolStatus
    if (-not $status.openclaw) { Install-NpmGlobalPackage 'openclaw' }
    Refresh-ProcessPath
    $status = Get-ToolStatus
}

$status.ready =
    [bool]$status.node -and
    [bool]$status.npm -and
    [bool]$status.python -and
    $status.nodeMajor -ge 22 -and
    ([Version]$status.pythonVersion -ge [Version]'3.11')
$status.toolsReady = [bool]$status.codex -and [bool]$status.openclaw
$status | ConvertTo-Json -Depth 4

if (-not $status.ready) { exit 2 }
if ($InstallTools -and -not $status.toolsReady) { exit 2 }
exit 0
