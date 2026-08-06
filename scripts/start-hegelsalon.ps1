[CmdletBinding()]
param(
    [string]$TunnelName = 'hegelsalon',
    [string]$Hostname = 'relay.hegelsalon.com',
    [ValidateRange(0, 65535)][int]$Port = 0,
    [switch]$StartTunnel,
    [switch]$EnsureDns,
    [switch]$NoBrowser,
    [switch]$NoTunnel,
    [switch]$SkipInstall,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

function ConvertTo-PlainText {
    param([Security.SecureString]$SecureValue)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-HegelSalonAuthUserCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    try {
        $payload = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($payload -is [array]) { return @($payload).Count }
        if ($payload.users -is [array]) { return @($payload.users).Count }
        if ($payload.email) { return 1 }
    } catch { throw "Auth users file is not valid JSON: $Path" }
    return 0
}

function Ensure-HegelSalonAuthAccount {
    param([string]$UsersPath)
    if ((Get-HegelSalonAuthUserCount $UsersPath) -gt 0) { return }

    $email = [string]$env:XHS_AUTH_EMAIL
    if ([string]::IsNullOrWhiteSpace($email)) { $email = Read-Host '首次公网启动请输入管理员邮箱' }
    if ([string]::IsNullOrWhiteSpace($email)) { throw 'An administrator email is required for production authentication.' }

    $password = [string]$env:XHS_AUTH_PASSWORD
    $temporaryPassword = $false
    if ([string]::IsNullOrEmpty($password)) {
        $secure = Read-Host '首次公网启动请输入管理员密码（不会写入文件）' -AsSecureString
        $password = ConvertTo-PlainText $secure
        $temporaryPassword = $true
    }
    if ($password.Length -lt 8) { throw 'The administrator password must contain at least 8 characters.' }

    $node = Get-HegelSalonNodeCommand
    $previousEmail = [Environment]::GetEnvironmentVariable('XHS_AUTH_EMAIL', 'Process')
    $previousPassword = [Environment]::GetEnvironmentVariable('XHS_AUTH_PASSWORD', 'Process')
    try {
        $env:XHS_AUTH_EMAIL = $email.Trim()
        $env:XHS_AUTH_PASSWORD = $password
        $provisionScript = Join-Path $root 'scripts\provision-auth.mjs'
        & $node.Source $provisionScript
        if ($LASTEXITCODE -ne 0) { throw "Auth provisioning failed with exit code $LASTEXITCODE." }
    } finally {
        [Environment]::SetEnvironmentVariable('XHS_AUTH_EMAIL', $previousEmail, 'Process')
        [Environment]::SetEnvironmentVariable('XHS_AUTH_PASSWORD', $previousPassword, 'Process')
        if ($temporaryPassword) { $password = $null }
    }
}

function Ensure-HegelSalonBuild {
    param([switch]$Skip)
    $node = Get-HegelSalonNodeCommand
    $npm = Get-HegelSalonNpmCommand
    $hasModules = Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container
    $hasBuild = Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf
    if ($hasModules -and $hasBuild) { return }
    if ($Skip) { throw 'node_modules/dist are missing. Run scripts\deploy-hegelsalon.ps1 or omit -SkipInstall.' }
    Write-Host 'Installing locked Node dependencies and building the frontend...'
    & $npm.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
}

function Ensure-HegelSalonPython {
    param([switch]$Skip)
    $pythonName = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
    $python = Get-Command $pythonName -ErrorAction SilentlyContinue
    if (-not $python) { throw 'Python 3.11 or newer is required.' }
    $versionText = (& $python.Source -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")').Trim()
    $version = [Version]'0.0'
    try { $version = [Version]$versionText } catch { }
    if ($version -lt [Version]'3.11') { throw "Python 3.11 or newer is required; detected $versionText." }
    & $python.Source -c 'import docx, openpyxl, playwright, pypdf, websockets' 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    if ($Skip) { throw 'Required Python packages are missing. Run scripts\deploy-hegelsalon.ps1 without -SkipInstall.' }
    Write-Host 'Installing locked Python dependencies...'
    & $python.Source -m pip install -r (Join-Path $root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed with exit code $LASTEXITCODE." }
}

function Start-HegelSalonOrigin {
    param([psobject]$Environment)
    $runtime = $Environment.RuntimeRoot
    $tracked = Get-HegelSalonTrackedServerProcess $runtime
    if ($tracked -and (Invoke-HegelSalonHealth -Port $Environment.Port)) {
        Write-Host "Origin is already healthy on loopback port $($Environment.Port) (PID $($tracked.Id))."
        return $tracked
    }
    if ($tracked) { Stop-HegelSalonTrackedServer $runtime }

    $node = Get-HegelSalonNodeCommand
    $stdout = Join-Path $runtime "server-$($Environment.Port).out.log"
    $stderr = Join-Path $runtime "server-$($Environment.Port).err.log"
    $process = Start-Process -FilePath $node.Source -ArgumentList @('server/index.mjs') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Set-Content -LiteralPath (Get-HegelSalonPidFile $runtime) -Value ([string]$process.Id) -Encoding ASCII
    try {
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            if ($process.HasExited) { throw "Origin process exited with code $($process.ExitCode)." }
            if (Invoke-HegelSalonHealth -Port $Environment.Port) {
                Write-Host "Origin is healthy: http://127.0.0.1:$($Environment.Port) (PID $($process.Id))."
                return $process
            }
            Start-Sleep -Milliseconds 500
        }
        throw "Origin did not become healthy within 60 seconds on port $($Environment.Port)."
    } catch {
        if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F *> $null }
        Remove-Item -LiteralPath (Get-HegelSalonPidFile $runtime) -Force -ErrorAction SilentlyContinue
        $details = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 30) -join [Environment]::NewLine } else { '' }
        if ($details) { throw "$($_.Exception.Message)`n$details" }
        throw
    }
}

function Start-HegelSalonTunnel {
    param(
        [Parameter(Mandatory = $true)][psobject]$Environment,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$PublicHost,
        [switch]$ConfigureDns
    )
    $cloudflared = Get-HegelSalonCloudflaredCommand
    $tunnel = Resolve-HegelSalonTunnel -TunnelName $Name -Cloudflared $cloudflared
    $credentials = Get-HegelSalonTunnelCredentialsPath -TunnelId $tunnel.Id
    $configPath = Join-Path $Environment.RuntimeRoot 'cloudflared-config.yml'
    Write-HegelSalonCloudflaredConfig -ConfigPath $configPath -TunnelId $tunnel.Id -CredentialsPath $credentials -Hostname $PublicHost -Port $Environment.Port | Out-Null
    $cloudflaredPath = Get-HegelSalonExecutablePath $cloudflared
    & $cloudflaredPath tunnel ingress validate --config $configPath 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare ingress validation failed for $PublicHost." }

    if ($ConfigureDns) {
        Write-Host "Ensuring DNS route for $PublicHost on tunnel $Name..."
        & $cloudflaredPath tunnel route dns $Name $PublicHost 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cloudflare DNS route setup failed for $PublicHost." }
    }

    $pidFile = Join-Path $Environment.RuntimeRoot 'tunnel.pid'
    $tunnelProcess = $null
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        $pid = 0
        if ([int]::TryParse($raw, [ref]$pid)) { $tunnelProcess = Get-Process -Id $pid -ErrorAction SilentlyContinue }
    }
    if (-not $tunnelProcess) {
        $stdout = Join-Path $Environment.RuntimeRoot 'tunnel.out.log'
        $stderr = Join-Path $Environment.RuntimeRoot 'tunnel.err.log'
        $tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList @('tunnel', '--config', $configPath, 'run', $Name) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        Set-Content -LiteralPath $pidFile -Value ([string]$tunnelProcess.Id) -Encoding ASCII
        Start-Sleep -Seconds 2
        if ($tunnelProcess.HasExited) {
            $details = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 30) -join [Environment]::NewLine } else { '' }
            throw "cloudflared exited with code $($tunnelProcess.ExitCode). $details"
        }
    }
    Write-Host "Cloudflare tunnel '$Name' is running for https://$PublicHost (PID $($tunnelProcess.Id))."
    return $tunnelProcess
}

Import-HegelSalonDotEnv
$requestedPort = if ($Port -gt 0) { $Port } elseif ($env:PORT -match '^\d+$') { [int]$env:PORT } else { 4317 }
$requestedHost = Test-HegelSalonHostname $Hostname

if ($CheckOnly) {
    $environment = Initialize-HegelSalonEnvironment -Hostname $requestedHost -Port $requestedPort
    $node = Get-HegelSalonNodeCommand
    $cloudflared = if (-not $NoTunnel) { Get-HegelSalonCloudflaredCommand } else { $null }
    [ordered]@{
        ready = $true
        origin = $environment.Origin
        publicOrigin = $environment.PublicOrigin
        tunnel = $TunnelName
        node = $node.Source
        cloudflared = if ($cloudflared) { Get-HegelSalonExecutablePath $cloudflared } else { '' }
        authRequired = $env:XHS_AUTH_REQUIRED
    } | ConvertTo-Json
    exit 0
}

$environment = Initialize-HegelSalonEnvironment -Hostname $requestedHost -Port $requestedPort
Ensure-HegelSalonDirectories $environment
Ensure-HegelSalonBuild -Skip:$SkipInstall
Ensure-HegelSalonPython -Skip:$SkipInstall
Ensure-HegelSalonAuthAccount -UsersPath $environment.AuthUsersPath

if (Test-HegelSalonPortOpen -HostName '127.0.0.1' -Port $environment.Port -and -not (Invoke-HegelSalonHealth -Port $environment.Port)) {
    $selected = Get-HegelSalonAvailablePort -Preferred $environment.Port
    Write-Warning "Loopback port $($environment.Port) is occupied by another process; using $selected for this run."
    $environment = Initialize-HegelSalonEnvironment -Hostname $requestedHost -Port $selected
    Ensure-HegelSalonDirectories $environment
}

$originProcess = Start-HegelSalonOrigin -Environment $environment
$tunnelProcess = $null
if ($StartTunnel -and -not $NoTunnel) {
    $tunnelProcess = Start-HegelSalonTunnel -Environment $environment -Name $TunnelName -PublicHost $requestedHost -ConfigureDns:$EnsureDns
}

$browserUrl = if ($tunnelProcess) { $environment.PublicOrigin } else { $environment.Origin }
if (-not $NoBrowser) { Start-Process $browserUrl }
Write-Host "HegelSalon is ready: $browserUrl"
Write-Host "Origin logs: $(Join-Path $environment.RuntimeRoot \"server-$($environment.Port).out.log\")"
Write-Host "Runtime state: $($environment.RuntimeRoot)"
