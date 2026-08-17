[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$Hostname = 'relay.hegelsalon.com',
    [string]$McpHostname = 'mcp.hegelsalon.com',
    [string]$TunnelName = 'hegelsalon-relay',
    [ValidateRange(1, 65535)][int]$Port = 4327,
    [string]$TunnelTokenFile = '',
    [switch]$UseExistingTunnel,
    [switch]$SkipBrowserRelayCheck,
    [switch]$Loop,
    [ValidateRange(30, 3600)][int]$IntervalSeconds = 300
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

$runtimeRoot = Join-Path $root '.runtime\production'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$logPath = Join-Path $runtimeRoot 'watchdog.log'
$lockPath = Join-Path $runtimeRoot 'watchdog.lock'
$lockStream = $null

function Write-WatchdogLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-AbsoluteInputPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $root $Path))
}

function Enable-PortableRuntime {
    $nodeDir = Join-Path $root 'runtime\node'
    $pythonDir = Join-Path $root 'runtime\python'
    $browser = Join-Path $root 'runtime\browser\chrome.exe'
    if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe') -PathType Leaf) { $env:PATH = "$nodeDir;$env:PATH" }
    if (Test-Path -LiteralPath (Join-Path $pythonDir 'python.exe') -PathType Leaf) {
        $env:PATH = "$pythonDir;$env:PATH"
        $env:PYTHON_BIN = Join-Path $pythonDir 'python.exe'
    }
    if (Test-Path -LiteralPath $browser -PathType Leaf) { $env:XHS_BROWSER_PATH = $browser }
}

function Import-ProductionEnvironment {
    $paths = @()
    if ($EnvFile) { $paths += Get-AbsoluteInputPath $EnvFile }
    $paths += @((Join-Path $root 'production.env.local'), (Join-Path $root '.env.production'))
    $existing = $paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($existing) { Import-HegelSalonDotEnv -Path @($existing) -Override }
    return $existing
}

function Test-HttpHealth {
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 8
        return [bool]($response.ok -eq $true -and $response.service -eq 'xiaohongshu-relay-scraper')
    } catch { return $false }
}

function Test-McpHealth {
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 8
        return [bool]($response.ok -eq $true -and $response.service -eq 'xiaohongshu-relay-scraper-mcp')
    } catch { return $false }
}

function Get-RelaySettings {
    $settings = [ordered]@{ port = 18800; profile = 'openclaw' }
    if (Test-Path -LiteralPath $env:XHS_RELAY_CONFIG_PATH -PathType Leaf) {
        try {
            $value = Get-Content -LiteralPath $env:XHS_RELAY_CONFIG_PATH -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$value.port -ge 1 -and [int]$value.port -le 65535) { $settings.port = [int]$value.port }
            if ([string]$value.profile -match '^[\p{L}\p{N}_.-]+$') { $settings.profile = [string]$value.profile }
        } catch { }
    }
    return [pscustomobject]$settings
}

function Invoke-RelayCheck {
    param([switch]$Repair)
    $node = Get-HegelSalonNodeCommand
    $relay = Get-RelaySettings
    $arguments = @(
        (Join-Path $PSScriptRoot 'start-managed-browser.mjs'),
        '--port', [string]$relay.port,
        '--profile', $relay.profile,
        '--data-dir', $env:XHS_BROWSER_DATA_DIR
    )
    if ($Repair) { $arguments += @('--url', 'https://www.xiaohongshu.com/explore', '--ensure-target') } else { $arguments += '--check-only' }
    $output = @(& (Get-HegelSalonExecutablePath $node) @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ ready = $false; port = $relay.port; profile = $relay.profile } }
    try {
        $status = (($output | Out-String).Trim() | ConvertFrom-Json)
        $status | Add-Member -NotePropertyName ready -NotePropertyValue ([bool]($status.running -and $status.cdpReady -and [int]$status.xiaohongshuTabs -ge 1)) -Force
        return $status
    } catch {
        return [pscustomobject]@{ ready = $false; port = $relay.port; profile = $relay.profile }
    }
}

function Get-WatchedRelayStatus {
    param([switch]$Repair)
    if ($SkipBrowserRelayCheck) {
        return [pscustomobject]@{ ready = $false; port = 0; profile = 'disabled' }
    }
    if ($Repair) { return Invoke-RelayCheck -Repair }
    return Invoke-RelayCheck
}

function Invoke-ProductionStart {
    param(
        [string]$LoadedEnv,
        [switch]$SkipBrowserRelayCheck
    )
    $arguments = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'start-production-windows.ps1'),
        '-Hostname', $Hostname,
        '-McpHostname', $McpHostname,
        '-TunnelName', $TunnelName,
        '-Port', [string]$Port,
        '-NoBrowser',
        '-NonInteractive',
        '-SkipStartupRegistration'
    )
    if ($LoadedEnv) { $arguments += @('-EnvFile', $LoadedEnv) }
    if ($TunnelTokenFile) { $arguments += @('-TunnelTokenFile', (Get-AbsoluteInputPath $TunnelTokenFile)) }
    if ($UseExistingTunnel) { $arguments += '-UseExistingTunnel' }
    if ($SkipBrowserRelayCheck) { $arguments += '-SkipBrowserRelayCheck' }
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $output = @(& $powershell @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $details = ($output | Select-Object -Last 30 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        throw "Production restart failed with exit code $LASTEXITCODE. $details"
    }
    $output | ForEach-Object { Write-Output $_ }
}

function Invoke-WatchdogPass {
    $loadedEnv = Import-ProductionEnvironment
    Enable-PortableRuntime
    $safeHost = Test-HegelSalonHostname $Hostname
    $safeMcpHost = Test-HegelSalonHostname $McpHostname
    $environment = Initialize-HegelSalonEnvironment -Hostname $safeHost -McpHostname $safeMcpHost -Port $Port
    $environment.RuntimeRoot = $runtimeRoot
    Ensure-HegelSalonDirectories $environment

    $statePath = Join-Path $runtimeRoot 'watchdog-state.json'
    $previousMcpConsecutiveFailures = 0
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $previousState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
            $previousMcpConsecutiveFailures = [Math]::Max(0, [int]$previousState.mcpConsecutiveFailures)
        } catch { }
    }

    $localHealthy = Test-HttpHealth -Url "$($environment.Origin)/api/health"
    $mcpHealthy = Test-McpHealth -Url "$($environment.McpOrigin)/health"
    $publicHealthy = Test-HttpHealth -Url "$($environment.PublicOrigin)/api/health"
    $mcpPublicHealthy = Test-McpHealth -Url "$($environment.McpPublicOrigin)/health"
    $relay = Get-WatchedRelayStatus
    $restarted = $false
    $serviceRestarted = $false
    $tunnelRestarted = $false
    $relayRepaired = $false
    $mcpConsecutiveFailures = if ($localHealthy -and -not $mcpHealthy) {
        [Math]::Min(3, $previousMcpConsecutiveFailures + 1)
    } else {
        0
    }
    $serviceRestartRequired = [bool](
        -not $localHealthy -or
        $mcpConsecutiveFailures -ge 3
    )
    $tunnelRestartRequired = [bool](
        $localHealthy -and
        $mcpHealthy -and
        (-not $publicHealthy -or -not $mcpPublicHealthy)
    )

    if ($serviceRestartRequired) {
        Write-WatchdogLog "service unhealthy local=$localHealthy mcp=$mcpHealthy public=$publicHealthy mcpPublic=$mcpPublicHealthy mcpFailures=$mcpConsecutiveFailures; restarting owned production processes"
        $productionStatePath = Join-Path $runtimeRoot 'production-state.json'
        if (Test-Path -LiteralPath $productionStatePath -PathType Leaf) {
            & (Join-Path $PSScriptRoot 'stop-production-windows.ps1') -StateFile $productionStatePath
        }
        Invoke-ProductionStart -LoadedEnv $loadedEnv -SkipBrowserRelayCheck:$SkipBrowserRelayCheck
        $restarted = $true
        $serviceRestarted = $true
        $localHealthy = Test-HttpHealth -Url "$($environment.Origin)/api/health"
        $mcpHealthy = Test-McpHealth -Url "$($environment.McpOrigin)/health"
        $publicHealthy = Test-HttpHealth -Url "$($environment.PublicOrigin)/api/health"
        $mcpPublicHealthy = Test-McpHealth -Url "$($environment.McpPublicOrigin)/health"
        $mcpConsecutiveFailures = if ($mcpHealthy -and $mcpPublicHealthy) { 0 } else { $mcpConsecutiveFailures }
        $relay = Get-WatchedRelayStatus
    } elseif ($tunnelRestartRequired) {
        if ($UseExistingTunnel) {
            Write-WatchdogLog "public ingress degraded while local API/MCP remain healthy; tunnel is externally managed, preserving the local origin"
        } else {
            Write-WatchdogLog "public ingress degraded while local API/MCP remain healthy; restarting only the owned Cloudflare Tunnel"
            try {
                Stop-HegelSalonTrackedTunnel -RuntimeRoot $runtimeRoot
                Invoke-ProductionStart -LoadedEnv $loadedEnv -SkipBrowserRelayCheck
                $restarted = $true
                $tunnelRestarted = $true
            } catch {
                throw "Tunnel recovery failed while the local origin was preserved: $($_.Exception.Message)"
            }
            $localHealthy = Test-HttpHealth -Url "$($environment.Origin)/api/health"
            $mcpHealthy = Test-McpHealth -Url "$($environment.McpOrigin)/health"
            $publicHealthy = Test-HttpHealth -Url "$($environment.PublicOrigin)/api/health"
            $mcpPublicHealthy = Test-McpHealth -Url "$($environment.McpPublicOrigin)/health"
            $relay = Get-WatchedRelayStatus
        }
    } elseif (-not $mcpHealthy) {
        Write-WatchdogLog "local MCP health check degraded; deferring service restart mcpFailures=$mcpConsecutiveFailures/3"
    }

    if (-not $SkipBrowserRelayCheck -and -not $relay.ready) {
        Write-WatchdogLog "relay unhealthy port=$($relay.port) profile=$($relay.profile); starting packaged browser and target page"
        $relay = Get-WatchedRelayStatus -Repair
        $relayRepaired = $true
    }

    $ready = [bool]($localHealthy -and $mcpHealthy -and $publicHealthy -and $mcpPublicHealthy -and ($SkipBrowserRelayCheck -or $relay.ready))
    $result = [ordered]@{
        ready = $ready
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
        origin = $environment.Origin
        publicOrigin = $environment.PublicOrigin
        localHealthy = $localHealthy
        mcpHealthy = $mcpHealthy
        mcpConsecutiveFailures = $mcpConsecutiveFailures
        mcpOrigin = $environment.McpOrigin
        mcpPublicOrigin = $environment.McpPublicOrigin
        mcpPublicHealthy = $mcpPublicHealthy
        publicHealthy = $publicHealthy
        relayReady = [bool]$relay.ready
        browserRelaySkipped = [bool]$SkipBrowserRelayCheck
        relayPort = [int]$relay.port
        relayProfile = [string]$relay.profile
        restarted = $restarted
        serviceRestarted = $serviceRestarted
        tunnelRestarted = $tunnelRestarted
        relayRepaired = $relayRepaired
    }
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runtimeRoot 'watchdog-state.json') -Encoding UTF8
    Write-WatchdogLog "pass ready=$ready local=$localHealthy mcp=$mcpHealthy mcpPublic=$mcpPublicHealthy mcpFailures=$mcpConsecutiveFailures public=$publicHealthy relay=$([bool]$relay.ready) restarted=$restarted serviceRestarted=$serviceRestarted tunnelRestarted=$tunnelRestarted relayRepaired=$relayRepaired"
    $result | ConvertTo-Json -Depth 4
    if (-not $ready) { throw 'Production watchdog pass completed but one or more required services are still unhealthy.' }
}

try {
    try {
        $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        [ordered]@{ ready = $true; skipped = $true; reason = 'watchdog-already-running' } | ConvertTo-Json
        exit 0
    }

    do {
        try { Invoke-WatchdogPass } catch {
            Write-WatchdogLog "pass failed: $($_.Exception.Message)"
            if (-not $Loop) { throw }
        }
        if ($Loop) { Start-Sleep -Seconds $IntervalSeconds }
    } while ($Loop)
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
