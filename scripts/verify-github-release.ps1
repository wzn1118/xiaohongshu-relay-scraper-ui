[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [ValidateRange(1024, 65535)]
    [int]$Port = 65431
)

$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "xhs-github-release-$([Guid]::NewGuid().ToString('N'))"
$extractRoot = Join-Path $temporaryRoot 'extract'
$runtimeRoot = Join-Path $temporaryRoot 'runtime'
$stdoutLog = Join-Path $temporaryRoot 'server.out.log'
$stderrLog = Join-Path $temporaryRoot 'server.err.log'
$server = $null
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

    $server = Start-Process -FilePath $node.Source -ArgumentList @('server/index.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
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

    [ordered]@{
        archive = $archive
        projectRoot = $projectRoot
        healthUrl = $healthUrl
        service = $health.service
        ok = $health.ok
        cleanBootstrap = $true
    } | ConvertTo-Json
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
    if ($server -and -not $server.HasExited) {
        & taskkill.exe /PID $server.Id /T /F *> $null
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
