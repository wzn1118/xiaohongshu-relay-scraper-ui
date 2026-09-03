[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [switch]$SkipBrowserRelayCheck,
    [switch]$EnableMcp,
    [switch]$CodexBuiltIn,
    [ValidateRange(0, 65535)]
    [int]$Port = 0,
    [ValidateRange(0, 65535)]
    [int]$McpPort = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

function Enable-BundledRuntime {
    $runtimeRoot = Join-Path $root 'runtime'
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

Initialize-HegelSalonProxyEnvironment
if ($CodexBuiltIn) { $env:XHS_CODEX_BUILT_IN_EDITION = '1' }

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

function Enable-McpRuntime {
    if (-not $EnableMcp) { return }
    $env:XHS_MCP_ENABLED = 'true'
    if (-not $env:XHS_MCP_HOST) { $env:XHS_MCP_HOST = '127.0.0.1' }
    if ($McpPort -gt 0) {
        $env:XHS_MCP_PORT = [string]$McpPort
    } elseif (-not $env:XHS_MCP_PORT) {
        $env:XHS_MCP_PORT = '4328'
    }
}

function Get-RelayLaunchOptions {
    $configPath = if ($env:XHS_RELAY_CONFIG_PATH) {
        $env:XHS_RELAY_CONFIG_PATH
    } else {
        Join-Path $root 'data\relay-config.json'
    }
    $port = 18800
    $profile = 'openclaw'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($null -ne $config.port) {
                $candidate = [int]$config.port
                if ($candidate -lt 1 -or $candidate -gt 65535) { throw 'port must be between 1 and 65535' }
                $port = $candidate
            }
            if ($config.profile) { $profile = ([string]$config.profile).Trim() }
            if (-not $profile) { throw 'profile must not be empty' }
        } catch {
            throw "Relay configuration is invalid: $configPath. $($_.Exception.Message)"
        }
    }
    return [pscustomobject]@{ Port = $port; Profile = $profile; ConfigPath = $configPath }
}

function Get-AvailableAppPort {
    param([ValidateRange(1, 65535)][int]$PreferredPort)
    for ($candidate = $PreferredPort; $candidate -lt [Math]::Min(65536, $PreferredPort + 100); $candidate++) {
        if ($candidate -in @(4318, 4327)) { continue }
        if (-not (Test-PortOpen -HostName '127.0.0.1' -PortNumber $candidate)) { return $candidate }
    }
    throw "No available local application port was found near $PreferredPort."
}

function Resolve-AppUrlPort {
    param([Parameter(Mandatory = $true)][string]$Url)
    if (Test-AppHealth $Url) { return $Url }
    $uri = [Uri]$Url
    if (-not (Test-PortOpen -HostName $uri.Host -PortNumber $uri.Port)) { return $Url }
    $replacement = Get-AvailableAppPort -PreferredPort $uri.Port
    if ($replacement -eq $uri.Port) { return $Url }
    Write-Warning "Port $($uri.Port) is occupied by another service; starting this package on local port $replacement instead."
    $env:PORT = [string]$replacement
    return Get-AppUrl
}

function Test-OllamaEndpoint {
    param([string]$Endpoint)
    try {
        $version = Invoke-RestMethod -Uri "$($Endpoint.TrimEnd('/'))/api/version" -TimeoutSec 2
        return [bool]$version.version
    } catch {
        return $false
    }
}

function Test-EnabledValue {
    param([string]$Value)
    return @('1', 'true', 'yes', 'on') -contains ([string]$Value).Trim().ToLowerInvariant()
}

function Warm-DedicatedOcrModel {
    param([string]$Endpoint)
    $model = if ($env:XHS_APPLICATION_CONTACT_OCR_MODEL) {
        $env:XHS_APPLICATION_CONTACT_OCR_MODEL.Trim()
    } else {
        'qwen2.5vl:3b'
    }
    if (-not $model) { throw 'A dedicated OCR model name is required.' }
    $keepAlive = if ($env:XHS_APPLICATION_CONTACT_OCR_KEEP_ALIVE) {
        $env:XHS_APPLICATION_CONTACT_OCR_KEEP_ALIVE.Trim()
    } else {
        '60m'
    }
    $contextTokens = 4096
    if ($env:XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS -match '^\d+$') {
        $contextTokens = [Math]::Max(2048, [Math]::Min(8192, [int]$env:XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS))
    }
    $payload = @{
        model = $model
        stream = $false
        think = $false
        keep_alive = $keepAlive
        options = @{ num_ctx = $contextTokens; num_predict = 1; temperature = 0 }
        messages = @(@{ role = 'user'; content = 'Reply OK.' })
    } | ConvertTo-Json -Depth 6 -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$($Endpoint.TrimEnd('/'))/api/chat" -ContentType 'application/json' -Body $payload -TimeoutSec 180 | Out-Null
    } catch {
        throw "Dedicated OCR model warm-up failed for ${model}: $($_.Exception.Message)"
    }
    Write-Host "Dedicated OCR model is warm: $model (keep-alive=$keepAlive)"
}

function Ensure-DedicatedOcrRuntime {
    if (-not (Test-EnabledValue $env:XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENABLED)) { return }
    $endpoint = if ($env:XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENDPOINT) {
        $env:XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENDPOINT.TrimEnd('/')
    } else {
        'http://127.0.0.1:11435'
    }
    if (Test-OllamaEndpoint $endpoint) {
        Write-Host "Dedicated OCR runtime is ready: $endpoint"
        Warm-DedicatedOcrModel $endpoint
        return
    }
    $uri = [Uri]$endpoint
    if (Test-PortOpen $uri.Host $uri.Port) {
        throw "Dedicated OCR port $($uri.Port) is occupied by a non-Ollama service."
    }
    $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if (-not $ollamaCommand) { $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue }
    if (-not $ollamaCommand) { throw 'Ollama is required for the dedicated OCR runtime.' }

    $runtimeDir = Join-Path $root '.runtime'
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $stdoutLog = Join-Path $runtimeDir "ollama-ocr-$($uri.Port).out.log"
    $stderrLog = Join-Path $runtimeDir "ollama-ocr-$($uri.Port).err.log"
    $saved = @{}
    foreach ($name in @('OLLAMA_HOST', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_CONTEXT_LENGTH')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        $ocrParallel = 2
        if ($env:XHS_APPLICATION_CONTACT_OCR_MODEL_PARALLEL -match '^\d+$') {
            $ocrParallel = [Math]::Max(1, [Math]::Min(4, [int]$env:XHS_APPLICATION_CONTACT_OCR_MODEL_PARALLEL))
        }
        $env:OLLAMA_HOST = "$($uri.Host):$($uri.Port)"
        $env:OLLAMA_NUM_PARALLEL = [string]$ocrParallel
        $env:OLLAMA_MAX_LOADED_MODELS = '1'
        $env:OLLAMA_CONTEXT_LENGTH = if ($env:XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS) {
            $env:XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS
        } else {
            '4096'
        }
        $process = Start-Process -FilePath $ollamaCommand.Source -ArgumentList @('serve') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    } finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw "Dedicated OCR runtime exited with code $($process.ExitCode)." }
        if (Test-OllamaEndpoint $endpoint) {
            Write-Host "Dedicated OCR runtime started: $endpoint (PID $($process.Id), parallel=$ocrParallel)"
            Warm-DedicatedOcrModel $endpoint
            return
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    throw "Dedicated OCR runtime did not become ready: $endpoint"
}

function Open-App {
    param([string]$Url)
    if (-not $NoBrowser) { Start-Process $Url }
}

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

function Connect-Relay {
    param([string]$Url)
    try {
        $config = Invoke-RestMethod -Method Get -Uri "$Url/api/relay/config" -TimeoutSec 10
        if ($config.autoConnect -eq $false) {
            Write-Host "Relay auto-connect is disabled by configuration"
            return $true
        }
        $relayPort = if ($config.port) { [int]$config.port } else { 18800 }
        $relayProfile = if ($config.profile) { [string]$config.profile } else { "openclaw" }
        $body = @{ port = $relayPort; profile = $relayProfile } | ConvertTo-Json -Compress
        $status = Invoke-RestMethod -Method Post -Uri "$Url/api/relay/connect" -ContentType "application/json" -Body $body -TimeoutSec 35
        $port = if ($status.port) { $status.port } else { $relayPort }
        $tabs = if ($status.tabs) { $status.tabs } else { 0 }
        $ready = $status.ready -or ($status.running -and $status.cdpReady -and $tabs -gt 0)
        $siteTabs = if ($status.xiaohongshuTabs) { [int]$status.xiaohongshuTabs } else { 0 }
        Write-Host "Relay code startup: ready=$ready siteTabs=$siteTabs port=$port tabs=$tabs attempted=$($status.attempted)"
        if (-not $ready) { Write-Warning "Relay is not ready: $($status.message)" }
        if ($status.running -and $status.cdpReady -and $siteTabs -eq 0) {
            try {
                $loginBody = @{ profile = $relayProfile; url = 'https://www.xiaohongshu.com' } | ConvertTo-Json -Compress
                $login = Invoke-RestMethod -Method Post -Uri "$Url/api/relay/login" -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
                if ($login.opened) {
                    Write-Host 'Login page opened in the managed browser. Complete the one-time login there.'
                } else {
                    Write-Warning "Managed browser login page did not open: $($login.message)"
                }
            } catch {
                Write-Warning "Managed browser login page could not be opened: $($_.Exception.Message)"
            }
        }
        return $ready
    } catch {
        Write-Warning "Relay code startup did not complete: $($_.Exception.Message)"
        return $false
    }
}

Enable-BundledRuntime
Import-DotEnv (Join-Path $root '.env')
Enable-McpRuntime
if ($Port -gt 0) { $env:PORT = [string]$Port }
$relayLaunch = Get-RelayLaunchOptions
$url = Get-AppUrl
$url = Resolve-AppUrlPort -Url $url

if (-not $CheckOnly) {
    Write-Host 'Preparing Windows runtime and bundled AI/browser tools...'
    & (Join-Path $PSScriptRoot 'ensure-windows-prerequisites.ps1') -InstallRuntime -InstallTools -EnsureBrowserRelay -RelayPort $relayLaunch.Port -RelayProfile $relayLaunch.Profile
    if ($LASTEXITCODE -ne 0) { throw 'Windows prerequisites are not ready.' }
    Refresh-ProcessPath
    Ensure-DedicatedOcrRuntime
}

if (Test-AppHealth $url -and -not $CheckOnly) {
    Write-Host "Application is already running at $url"
    if (-not $CheckOnly) { Connect-Relay $url | Out-Null }
    if (-not $CheckOnly) { Open-App $url }
    exit 0
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
    & $pythonCommand.Source -c 'import docx, openpyxl, playwright, pypdf, websockets' 2>$null
    $pythonDependenciesReady = $LASTEXITCODE -eq 0
}
$installationReady =
    (Test-Path -LiteralPath (Join-Path $root 'node_modules')) -and
    (Test-Path -LiteralPath (Join-Path $root 'dist\index.html')) -and
    $pythonDependenciesReady
$bootstrapRequired = -not $installationReady

if ($CheckOnly) {
    $relayPreflight = $null
    $relayPreflightExit = 0
    $relayCheckPassed = $true
    if (-not $SkipBrowserRelayCheck) {
        $relayPreflightExit = 2
        try {
            $relayOutput = @(& (Join-Path $PSScriptRoot 'ensure-windows-prerequisites.ps1') -CheckOnly -EnsureBrowserRelay -RelayPort $relayLaunch.Port -RelayProfile $relayLaunch.Profile 2>$null)
            $relayPreflightExit = $LASTEXITCODE
            if ($relayOutput) {
                $relayPreflight = (($relayOutput | Out-String).Trim() | ConvertFrom-Json)
            }
        } catch { $relayPreflight = $null }
        $relayCheckPassed = $relayPreflightExit -eq 0 -and $relayPreflight -and $relayPreflight.browserReady -eq $true -and $relayPreflight.relayCommandReady -eq $true
    }
    [ordered]@{
        ready = $prerequisitesReady -and $relayCheckPassed
        bootstrapRequired = $bootstrapRequired
        nodeMajor = $nodeMajor
        pythonVersion = $pythonVersion.ToString()
        node = if ($nodeCommand) { $nodeCommand.Source } else { '' }
        npm = if ($npmCommand) { $npmCommand.Source } else { '' }
        python = if ($pythonCommand) { $pythonCommand.Source } else { '' }
        browser = if ($relayPreflight) { $relayPreflight.browser } else { '' }
        relayCommandReady = if ($relayPreflight) { $relayPreflight.relayCommandReady } else { $false }
        relayProfile = if ($relayPreflight) { $relayPreflight.relayProfile } else { $relayLaunch.Profile }
        relayPort = if ($relayPreflight) { $relayPreflight.relayPort } else { $relayLaunch.Port }
        relayServiceReady = if ($relayPreflight) { $relayPreflight.relayServiceReady } else { $false }
        relayCheckSkipped = [bool]$SkipBrowserRelayCheck
        url = $url
        mcpEnabled = @('1', 'true', 'yes', 'on') -contains ([string]$env:XHS_MCP_ENABLED).Trim().ToLowerInvariant()
        mcpHost = if ($env:XHS_MCP_HOST) { $env:XHS_MCP_HOST } else { '127.0.0.1' }
        mcpPort = if ($env:XHS_MCP_PORT) { [int]$env:XHS_MCP_PORT } else { 4328 }
        mcpEndpoint = "http://$(if ($env:XHS_MCP_HOST) { $env:XHS_MCP_HOST } else { '127.0.0.1' }):$(if ($env:XHS_MCP_PORT) { [int]$env:XHS_MCP_PORT } else { 4328 })/mcp"
    } | ConvertTo-Json
    if (-not $prerequisitesReady -or -not $relayCheckPassed) { exit 2 }
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

Write-Host 'The built-in AI runtime is ready. Configure the model relay in the app.'

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
Import-DotEnv (Join-Path $root '.env')
Enable-McpRuntime
if ($Port -gt 0) { $env:PORT = [string]$Port }
$url = Get-AppUrl
$url = Resolve-AppUrlPort -Url $url

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
$runtimeDir = Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$logSuffix = "server-$($uri.Port)"
$stdoutLog = Join-Path $runtimeDir "$logSuffix.out.log"
$stderrLog = Join-Path $runtimeDir "$logSuffix.err.log"
$server = Start-Process -FilePath $npmCommand.Source -ArgumentList @('start') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
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
    Write-Host "Application will keep running in the background (PID $($server.Id))."
    Write-Host "Server logs: $stdoutLog"
    exit 0
} catch {
    if ($server -and -not $server.HasExited) {
        & taskkill.exe /PID $server.Id /T /F *> $null
    }
    $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine } else { '' }
    if ($details) { Write-Error "$($_.Exception.Message)`n$details" }
    throw
}
