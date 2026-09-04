[CmdletBinding()]
param([string]$StateFile = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $root '.runtime\production'
$statePath = if ($StateFile) { if ([IO.Path]::IsPathRooted($StateFile)) { $StateFile } else { Join-Path $root $StateFile } } else { Join-Path $runtimeRoot 'production-state.json' }
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Host 'No production state file found.'; exit 0 }

function Get-RecordedPid {
    param([Parameter(Mandatory = $true)][string]$Path)
    $value = 0
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and [int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$value)) { return $value }
    return 0
}

function Test-ExpectedExecutable {
    param([string]$Expected, [string]$Actual)
    if (-not $Expected) { return $true }
    if (-not $Actual) { return $false }
    return [IO.Path]::GetFullPath($Expected).Equals([IO.Path]::GetFullPath($Actual), [StringComparison]::OrdinalIgnoreCase)
}

$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
$stateRoot = if ($state.root) { [IO.Path]::GetFullPath([string]$state.root).TrimEnd('\') } else { '' }
if (-not $rootFull.Equals($stateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Production state belongs to a different release root: $stateRoot"
}

foreach ($property in @('tunnelPid', 'serverPid')) {
    $pidValue = 0
    if (-not [int]::TryParse([string]$state.$property, [ref]$pidValue) -or $pidValue -le 0) { continue }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) { continue }

    $record = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    $commandLine = [string]$record.CommandLine
    $actualExecutable = if ($record.ExecutablePath) { [string]$record.ExecutablePath } else { try { [string]$process.Path } catch { '' } }
    $owned = $false
    if ($property -eq 'serverPid') {
        $pidFileMatches = (Get-RecordedPid -Path (Join-Path $runtimeRoot 'server.pid')) -eq $pidValue
        $expectedExecutable = [string]$state.serverExecutable
        $owned = $pidFileMatches -and $process.ProcessName -match '^node$' -and $commandLine -match '(?i)server[\\/]index\.mjs' -and (Test-ExpectedExecutable -Expected $expectedExecutable -Actual $actualExecutable)
    } else {
        $pidFileMatches = (Get-RecordedPid -Path (Join-Path $runtimeRoot 'tunnel.pid')) -eq $pidValue
        $expectedExecutable = [string]$state.tunnelExecutable
        $metricsMarker = [regex]::Escape([string]$state.metrics)
        $owned = $pidFileMatches -and $process.ProcessName -match '^cloudflared$' -and $commandLine -match '(?i)\btunnel\b' -and $commandLine -match '(?i)\brun\b' -and $commandLine -match '(?i)--token-file\b' -and ($metricsMarker -eq '' -or $commandLine -match $metricsMarker) -and (Test-ExpectedExecutable -Expected $expectedExecutable -Actual $actualExecutable)
    }

    if ($owned) {
        & taskkill.exe /PID $pidValue /T /F *> $null
        Write-Host "Stopped $property PID $pidValue."
    } else {
        Write-Warning "PID $pidValue did not match this release's recorded process signature; left it running."
    }
}

Remove-Item -LiteralPath (Join-Path $runtimeRoot 'server.pid') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeRoot 'tunnel.pid') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
