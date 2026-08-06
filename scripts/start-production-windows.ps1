[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$Hostname = 'relay.hegelsalon.com',
    [string]$TunnelName = 'hegelsalon-relay',
    [ValidateRange(1, 65535)][int]$Port = 4327,
    [string]$TunnelTokenFile = '',
    [switch]$UseExistingTunnel,
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

$runtimeRoot = Join-Path $root '.runtime\production'
$startedServer = $false
$startedTunnel = $false
$serverProcess = $null
$tunnelProcess = $null

function Get-AbsoluteInputPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $root $Path))
}

function Import-ProductionEnv {
    param([string]$Path)
    $candidates = @()
    if ($Path) { $candidates += Get-AbsoluteInputPath $Path }
    $candidates += @(
        (Join-Path $root 'production.env.local'),
        (Join-Path $root '.env.production')
    )
    $existing = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($existing) { Import-HegelSalonDotEnv -Path @($existing) -Override }
    return $existing
}

function Get-ExecutablePath {
    param([Parameter(Mandatory = $true)][object]$Command)
    return Get-HegelSalonExecutablePath $Command
}

function Enable-BundledRuntime {
    $runtime = Join-Path $root 'runtime'
    $nodeDir = Join-Path $runtime 'node'
    $pythonDir = Join-Path $runtime 'python'
    if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe') -PathType Leaf) {
        $env:PATH = "$nodeDir;$env:PATH"
    }
    if (Test-Path -LiteralPath (Join-Path $pythonDir 'python.exe') -PathType Leaf) {
        $env:PATH = "$pythonDir;$env:PATH"
        $env:PYTHON_BIN = Join-Path $pythonDir 'python.exe'
    }
}

function Assert-ProductionInputs {
    param([Parameter(Mandatory = $true)][psobject]$Environment)
    $node = Get-HegelSalonNodeCommand
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf)) { throw 'package.json is missing.' }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf)) {
        if ($SkipBuild) { throw 'dist/index.html is missing. Remove -SkipBuild to build the release.' }
        $npm = Get-HegelSalonNpmCommand
        & (Get-ExecutablePath $npm) ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
        & (Get-ExecutablePath $npm) run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
        throw 'node_modules is missing. Include it in the release or run npm ci once on this machine.'
    }
    if (-not $env:XHS_AUTH_REQUIRED -or $env:XHS_AUTH_REQUIRED.ToLowerInvariant() -ne 'true') { throw 'Production authentication must remain enabled.' }
    if ($env:XHS_AUTH_ORIGIN -ne $Environment.PublicOrigin) { throw "XHS_AUTH_ORIGIN must equal $($Environment.PublicOrigin)." }
    return $node
}

function Assert-ProductionPythonDependencies {
    param([Parameter(Mandatory = $true)][object]$Python)
    $pythonPath = Get-ExecutablePath $Python
    $output = @(& $pythonPath -c "import sys; assert sys.version_info >= (3, 11); import docx, openpyxl, playwright, pypdf, websockets" 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Python production dependencies are incomplete. $($output -join ' ')"
    }
}

function Assert-ProductionCloudflared {
    param([Parameter(Mandatory = $true)][object]$Cloudflared)
    $cloudflaredPath = Get-ExecutablePath $Cloudflared
    $help = @(& $cloudflaredPath tunnel run --help 2>&1) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0 -or $help -notmatch '(?m)--token-file\b') {
        throw 'cloudflared does not support tunnel run --token-file. Use the bundled runtime or upgrade cloudflared.'
    }
}

function Get-AuthUserCount {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($value.users -is [array]) { return @($value.users).Count }
    return 0
}

function Ensure-AuthAccount {
    param([Parameter(Mandatory = $true)][string]$UsersPath)
    if ((Get-AuthUserCount $UsersPath) -gt 0) { return }
    $email = ([string]$env:XHS_AUTH_EMAIL).Trim()
    if (-not $email) { $email = (Read-Host 'Enter the production administrator email').Trim() }
    if (-not $email) { throw 'An administrator email is required.' }
    $password = [string]$env:XHS_AUTH_PASSWORD
    $temporary = $false
    if (-not $password) {
        $secure = Read-Host 'Enter the production administrator password (not written to the repository)' -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $temporary = $true
    }
    if ($password.Length -lt 8) { throw 'The administrator password must contain at least 8 characters.' }
    $oldEmail = [Environment]::GetEnvironmentVariable('XHS_AUTH_EMAIL', 'Process')
    $oldPassword = [Environment]::GetEnvironmentVariable('XHS_AUTH_PASSWORD', 'Process')
    try {
        $env:XHS_AUTH_EMAIL = $email
        $env:XHS_AUTH_PASSWORD = $password
        $node = Get-HegelSalonNodeCommand
        & (Get-ExecutablePath $node) (Join-Path $root 'scripts\provision-auth.mjs')
        if ($LASTEXITCODE -ne 0) { throw "Auth provisioning failed with exit code $LASTEXITCODE." }
    } finally {
        [Environment]::SetEnvironmentVariable('XHS_AUTH_EMAIL', $oldEmail, 'Process')
        [Environment]::SetEnvironmentVariable('XHS_AUTH_PASSWORD', $oldPassword, 'Process')
        if ($temporary) { $password = $null }
    }
}

function Start-Origin {
    param([Parameter(Mandatory = $true)][psobject]$Environment)
    if (Test-HegelSalonPortOpen -HostName '127.0.0.1' -Port $Environment.Port) {
        if (Invoke-HegelSalonHealth -Port $Environment.Port) { throw "Port $($Environment.Port) already belongs to another running application; stop it or choose the configured Tunnel origin port." }
        throw "Port $($Environment.Port) is occupied by another process. The production launcher will not select a random port."
    }
    New-Item -ItemType Directory -Path $Environment.RuntimeRoot -Force | Out-Null
    $stdout = Join-Path $Environment.RuntimeRoot 'server.out.log'
    $stderr = Join-Path $Environment.RuntimeRoot 'server.err.log'
    $node = Get-HegelSalonNodeCommand
    $process = $null
    try {
        $process = Start-Process -FilePath (Get-ExecutablePath $node) -ArgumentList @('server/index.mjs') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        Set-Content -LiteralPath (Get-HegelSalonPidFile $Environment.RuntimeRoot) -Value ([string]$process.Id) -Encoding ASCII
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            if ($process.HasExited) {
                $details = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 40) -join [Environment]::NewLine } else { '' }
                throw "Origin exited with code $($process.ExitCode). $details"
            }
            if (Invoke-HegelSalonHealth -Port $Environment.Port) { return $process }
            Start-Sleep -Milliseconds 500
        }
        throw "Origin did not become healthy within 60 seconds on port $($Environment.Port)."
    } catch {
        if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Wait-HttpHealth {
    param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 5
            if ($response.ok -eq $true -and $response.service -eq 'xiaohongshu-relay-scraper') { return $response }
        } catch { }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Health check failed: $Url"
}

function Start-OwnedTunnel {
    param(
        [Parameter(Mandatory = $true)][string]$TokenPath,
        [Parameter(Mandatory = $true)][object]$Cloudflared
    )
    if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) { throw "Tunnel token file is missing: $TokenPath" }
    $metrics = if ($env:CLOUDFLARE_METRICS) { [string]$env:CLOUDFLARE_METRICS } else { '127.0.0.1:20242' }
    $stdout = Join-Path $runtimeRoot 'cloudflared.out.log'
    $stderr = Join-Path $runtimeRoot 'cloudflared.err.log'
    $args = @('tunnel', '--no-autoupdate', '--metrics', $metrics, 'run', '--token-file', (Get-AbsoluteInputPath $TokenPath))
    $process = Start-Process -FilePath (Get-ExecutablePath $Cloudflared) -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'tunnel.pid') -Value ([string]$process.Id) -Encoding ASCII
    $readyUrl = "http://$metrics/ready"
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if ($process.HasExited) { throw "cloudflared exited with code $($process.ExitCode)." }
        try { $ready = Invoke-WebRequest -Uri $readyUrl -TimeoutSec 3 -UseBasicParsing; if ($ready.StatusCode -eq 200) { return $process } } catch { }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Cloudflare Tunnel metrics did not report ready at $readyUrl."
}

function Resolve-TunnelTokenPath {
    param([string]$RequestedPath)
    $candidate = if ($RequestedPath) {
        Get-AbsoluteInputPath $RequestedPath
    } elseif ($env:CLOUDFLARE_TUNNEL_TOKEN_FILE) {
        Get-AbsoluteInputPath $env:CLOUDFLARE_TUNNEL_TOKEN_FILE
    } else {
        Join-Path $env:USERPROFILE '.cloudflared\hegelsalon-relay.token'
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    if ($UseExistingTunnel) { return '' }

    $secure = Read-Host 'Paste the Cloudflare Tunnel token for relay.hegelsalon.com (stored outside this release)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'A Cloudflare Tunnel token is required for the first public start.' }
    $parent = Split-Path -Parent $candidate
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($candidate, $token.Trim(), [Text.UTF8Encoding]::new($false))
    $token = $null
    Write-Host "Tunnel token saved outside the release: $candidate"
    return [IO.Path]::GetFullPath($candidate)
}

function Stop-StartedProcesses {
    if ($startedTunnel -and $tunnelProcess -and -not $tunnelProcess.HasExited) { & taskkill.exe /PID $tunnelProcess.Id /T /F *> $null }
    if ($startedServer -and $serverProcess -and -not $serverProcess.HasExited) { & taskkill.exe /PID $serverProcess.Id /T /F *> $null }
}

try {
    $loadedEnv = Import-ProductionEnv -Path $EnvFile
    Enable-BundledRuntime
    $safeHost = Test-HegelSalonHostname $Hostname
    $env:CLOUDFLARE_PUBLIC_URL = "https://$safeHost"
    $environment = Initialize-HegelSalonEnvironment -Hostname $safeHost -Port $Port
    $environment.RuntimeRoot = $runtimeRoot
    Ensure-HegelSalonDirectories $environment
    $node = Assert-ProductionInputs -Environment $environment
    $python = Get-HegelSalonPythonCommand
    Assert-ProductionPythonDependencies -Python $python
    $cloudflared = Get-HegelSalonCloudflaredCommand
    Assert-ProductionCloudflared -Cloudflared $cloudflared
    if ($CheckOnly) {
        $defaultToken = Join-Path $env:USERPROFILE '.cloudflared\hegelsalon-relay.token'
        $configuredToken = if ($TunnelTokenFile) { Get-AbsoluteInputPath $TunnelTokenFile } elseif ($env:CLOUDFLARE_TUNNEL_TOKEN_FILE) { Get-AbsoluteInputPath $env:CLOUDFLARE_TUNNEL_TOKEN_FILE } else { $defaultToken }
        [ordered]@{ ready = $true; origin = $environment.Origin; publicOrigin = $environment.PublicOrigin; hostname = $environment.Hostname; port = $environment.Port; node = (Get-ExecutablePath $node); python = (Get-ExecutablePath $python); cloudflared = (Get-ExecutablePath $cloudflared); tunnelTokenReady = (Test-Path -LiteralPath $configuredToken -PathType Leaf); envFile = $loadedEnv } | ConvertTo-Json -Depth 4
        exit 0
    }
    $tokenPath = Resolve-TunnelTokenPath -RequestedPath $TunnelTokenFile
    Ensure-AuthAccount -UsersPath $environment.AuthUsersPath
    $serverProcess = Start-Origin -Environment $environment
    $startedServer = $true
    if ($tokenPath) {
        $tunnelProcess = Start-OwnedTunnel -TokenPath $tokenPath -Cloudflared $cloudflared
        $startedTunnel = $true
    } elseif (-not $UseExistingTunnel) {
        throw 'Provide -TunnelTokenFile (stored outside the release) or use -UseExistingTunnel for an already running named tunnel.'
    }
    $null = Wait-HttpHealth -Url "$($environment.PublicOrigin)/api/health" -TimeoutSeconds 90
    $state = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); root = $root; hostname = $safeHost; publicUrl = $environment.PublicOrigin; origin = $environment.Origin; port = $environment.Port; serverPid = $serverProcess.Id; serverExecutable = (Get-ExecutablePath $node); tunnelPid = if ($tunnelProcess) { $tunnelProcess.Id } else { $null }; tunnelExecutable = if ($tunnelProcess) { Get-ExecutablePath $cloudflared } else { $null }; tunnelName = $TunnelName; tunnelMode = if ($tunnelProcess) { 'owned-token' } else { 'existing-managed-tunnel' }; metrics = if ($env:CLOUDFLARE_METRICS) { $env:CLOUDFLARE_METRICS } else { '127.0.0.1:20242' } }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtimeRoot 'production-state.json') -Encoding UTF8
    if (-not $NoBrowser) { Start-Process $environment.PublicOrigin }
    Write-Host "Production relay is ready: $($environment.PublicOrigin)"
    Write-Host "Local origin: $($environment.Origin)"
    Write-Host "State: $(Join-Path $runtimeRoot 'production-state.json')"
} catch {
    Stop-StartedProcesses
    throw
}
