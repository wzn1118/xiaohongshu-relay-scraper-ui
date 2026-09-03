[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [ValidateRange(1024, 65535)]
    [int]$Port = 65431,
    [string]$LaunchEntry = '',
    [switch]$RequireCodexBuiltIn,
    [switch]$BrowserSmoke,
    [string]$ScreenshotPath = '',
    [ValidateSet('x64', 'arm64')]
    [string]$ExpectedArchitecture = 'x64',
    [string]$EvidencePath = ''
)

$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "xhs-github-release-$([Guid]::NewGuid().ToString('N'))"
$extractRoot = Join-Path $temporaryRoot 'extract'
$runtimeRoot = Join-Path $temporaryRoot 'runtime'
$stdoutLog = Join-Path $temporaryRoot 'server.out.log'
$stderrLog = Join-Path $temporaryRoot 'server.err.log'
$server = $null
$applicationPid = $null
$temporaryEnvPath = $null
$savedEnvironment = @{}

function Save-EnvironmentValue {
    param([string]$Name, [string]$Value)
    $script:savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

try {
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force

    $projectRoot = Get-ChildItem -LiteralPath $extractRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $projectRoot) { throw 'The release archive does not contain a project root with package.json.' }
    if ($LaunchEntry -and [IO.Path]::GetFileName($LaunchEntry) -ne $LaunchEntry) {
        throw 'LaunchEntry must be a root-level file name.'
    }
    if ($RequireCodexBuiltIn) {
        if ($LaunchEntry -ne 'Start-Codex-App.cmd') { throw 'The Codex edition must use Start-Codex-App.cmd.' }
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'CODEX_BUILT_IN_START.md') -PathType Leaf)) {
            throw 'The Codex edition marker is missing.'
        }
        $runtimeCheck = @(& (Get-Command node -ErrorAction Stop).Source (Join-Path $projectRoot 'scripts\codex-runtime-artifact.mjs') --mode verify --project-root $projectRoot --platform win32 --architecture $ExpectedArchitecture 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Bundled Windows Codex runtime verification failed: $($runtimeCheck -join [Environment]::NewLine)" }
        $runtimeEvidence = (($runtimeCheck | Out-String).Trim() | ConvertFrom-Json)
    }

    $checkOutput = @(& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\one-click.ps1') -CheckOnly -NoBrowser -SkipBrowserRelayCheck -Port $Port 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "One-click prerequisite check failed: $($checkOutput -join [Environment]::NewLine)" }
    $check = (($checkOutput | Out-String).Trim() | ConvertFrom-Json)
    if ($check.ready -ne $true) { throw 'One-click prerequisite check did not report ready=true.' }
    if ($check.bootstrapRequired -ne $true) { throw 'A clean source release must require first-run bootstrap.' }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    $node = Get-Command node -ErrorAction Stop
    $pythonName = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
    $python = Get-Command $pythonName -ErrorAction Stop
    Save-EnvironmentValue -Name 'NPM_CONFIG_CACHE' -Value (Join-Path $runtimeRoot 'npm-cache')

    Push-Location $projectRoot
    try {
        & $npm.Source ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in the extracted release.' }
        & $python.Source -m pip install --disable-pip-version-check -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed in the extracted release.' }
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw 'Production build failed in the extracted release.' }
    } finally {
        Pop-Location
    }

    Save-EnvironmentValue -Name 'HOST' -Value '127.0.0.1'
    Save-EnvironmentValue -Name 'PORT' -Value ([string]$Port)
    Save-EnvironmentValue -Name 'XHS_MCP_ENABLED' -Value 'false'
    Save-EnvironmentValue -Name 'XHS_SERVER_DATA_DIR' -Value (Join-Path $runtimeRoot 'jobs')
    Save-EnvironmentValue -Name 'XHS_PROFILE_DATA_DIR' -Value (Join-Path $runtimeRoot 'profiles')
    Save-EnvironmentValue -Name 'XHS_BROWSER_DATA_DIR' -Value (Join-Path $runtimeRoot 'browser')
    Save-EnvironmentValue -Name 'XHS_COPILOT_WORKSPACE_ROOT' -Value $projectRoot
    Save-EnvironmentValue -Name 'CODEX_HOME' -Value (Join-Path $runtimeRoot 'codex-home')
    Save-EnvironmentValue -Name 'XHS_CODEX_SQLITE_HOME' -Value (Join-Path $runtimeRoot 'codex-sqlite')
    $temporaryEnvPath = Join-Path $projectRoot '.env'
    @(
        'HOST=127.0.0.1'
        "PORT=$Port"
        'XHS_MCP_ENABLED=false'
        "XHS_MCP_PORT=$([int]$Port + 1)"
    ) | Set-Content -LiteralPath $temporaryEnvPath -Encoding ascii

    if ($LaunchEntry) {
        $launcherPath = Join-Path $projectRoot $LaunchEntry
        if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw "Release launcher is missing: $LaunchEntry" }
        $server = Start-Process -FilePath $launcherPath -ArgumentList @('-NoBrowser', '-Port', [string]$Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    } else {
        $server = Start-Process -FilePath $node.Source -ArgumentList @('server/index.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    }
    $healthUrl = "http://127.0.0.1:$Port/api/health"
    $healthy = $false
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        if ($server.HasExited) { throw "Extracted release server exited with code $($server.ExitCode)." }
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            if ($health.ok -eq $true -and $health.service -eq 'xiaohongshu-relay-scraper') {
                $healthy = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) { throw "Extracted release did not become healthy: $healthUrl" }

    $codexProvider = $null
    if ($RequireCodexBuiltIn) {
        $providers = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ai/providers" -TimeoutSec 10
        foreach ($provider in $providers) {
            if ($provider.id -eq 'codex') { $codexProvider = $provider; break }
        }
        if (-not $codexProvider) { throw 'The built-in Codex provider is missing.' }
        if ($codexProvider.wireApi -ne 'responses' -or $codexProvider.bundled -ne $true) {
            throw 'The built-in Codex provider contract is invalid.'
        }
        $codexStatus = $null
        for ($attempt = 0; $attempt -lt 180; $attempt++) {
            try {
                $codexStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/codex-browser/status" -TimeoutSec 2
                if ($codexStatus.ready -eq $true -and $codexStatus.presentation -eq 'bundled' -and $codexStatus.backend.initialized -eq $true) {
                    break
                }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
        if ($codexStatus.ready -ne $true -or $codexStatus.presentation -ne 'bundled' -or $codexStatus.backend.initialized -ne $true) {
            throw 'The bundled Codex app-server or browser presentation is not ready.'
        }
        $threadListBody = @{ method = 'thread/list'; params = @{ limit = 3; useStateDbOnly = $true } } | ConvertTo-Json -Depth 4 -Compress
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/codex-browser/request" -ContentType 'application/json' -Body $threadListBody -TimeoutSec 30 | Out-Null
        $codexPage = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/codex/" -TimeoutSec 20 -UseBasicParsing
        if ($codexPage.StatusCode -ne 200 -or $codexPage.Content -notmatch '<title>Codex</title>') {
            throw 'The bundled Codex page did not open.'
        }
        if ($BrowserSmoke) {
            if (-not $ScreenshotPath) { $ScreenshotPath = Join-Path $temporaryRoot 'codex-windows-open-smoke.png' }
            $resolvedScreenshotPath = [IO.Path]::GetFullPath($ScreenshotPath)
            New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedScreenshotPath) -Force | Out-Null
            & $node.Source (Join-Path $projectRoot 'scripts\verify-release-browser.mjs') --url "http://127.0.0.1:$Port/codex/" --screenshot-path $resolvedScreenshotPath --require-codex-built-in
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $resolvedScreenshotPath -PathType Leaf)) {
                throw 'The bundled Codex browser smoke test failed.'
            }
        }
    }

    $evidence = [ordered]@{
        schemaVersion = 1
        archive = [IO.Path]::GetFileName($archive)
        platform = 'win32'
        architecture = $ExpectedArchitecture
        healthPath = '/api/health'
        service = $health.service
        ok = $health.ok
        cleanBootstrap = $true
        launchEntry = if ($LaunchEntry) { $LaunchEntry } else { 'node server/index.mjs' }
        codexBuiltIn = [bool]$RequireCodexBuiltIn
        codexProvider = if ($codexProvider) { $codexProvider.id } else { $null }
        codexBackendInitialized = if ($codexStatus) { [bool]$codexStatus.backend.initialized } else { $false }
        codexPresentation = if ($codexStatus) { $codexStatus.presentation } else { $null }
        runtime = if ($runtimeEvidence) { $runtimeEvidence } else { $null }
        codexStatusPath = if ($RequireCodexBuiltIn) { '/api/codex-browser/status' } else { $null }
        codexPage = if ($RequireCodexBuiltIn) { '/codex/' } else { $null }
        screenshot = if ($resolvedScreenshotPath) { [IO.Path]::GetFileName($resolvedScreenshotPath) } else { $null }
    }
    $evidenceJson = $evidence | ConvertTo-Json -Depth 6
    if ($EvidencePath) {
        $resolvedEvidencePath = [IO.Path]::GetFullPath($EvidencePath)
        New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedEvidencePath) -Force | Out-Null
        [IO.File]::WriteAllText($resolvedEvidencePath, "$evidenceJson`n", (New-Object Text.UTF8Encoding($false)))
    }
    $evidenceJson
} catch {
    if (Test-Path -LiteralPath $stdoutLog) {
        Write-Host '--- release smoke stdout ---'
        Get-Content -LiteralPath $stdoutLog -Tail 80
    }
    if (Test-Path -LiteralPath $stderrLog) {
        Write-Host '--- release smoke stderr ---'
        Get-Content -LiteralPath $stderrLog -Tail 80
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stdoutLog) {
        $launcherOutput = Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue
        if ($launcherOutput -match 'Application will keep running in the background \(PID (\d+)\)') {
            $applicationPid = [int]$Matches[1]
        }
    }
    if (-not $applicationPid) {
        try {
            $applicationPid = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -First 1 -ExpandProperty OwningProcess
        } catch { }
    }
    foreach ($processId in @($applicationPid, $(if ($server) { $server.Id }))) {
        if (-not $processId) { continue }
        try {
            Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID', [string]$processId, '/T', '/F') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        } catch { }
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($temporaryEnvPath -and (Test-Path -LiteralPath $temporaryEnvPath)) {
        Remove-Item -LiteralPath $temporaryEnvPath -Force -ErrorAction SilentlyContinue
    }
}
