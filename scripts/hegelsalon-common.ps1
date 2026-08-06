[CmdletBinding()]
param()

Set-StrictMode -Version Latest

$script:HegelSalonRoot = Split-Path -Parent $PSScriptRoot

function Get-HegelSalonRoot {
    return $script:HegelSalonRoot
}

function Import-HegelSalonDotEnv {
    [CmdletBinding()]
    param(
        [string[]]$Path = @(
            (Join-Path $script:HegelSalonRoot '.env'),
            (Join-Path $script:HegelSalonRoot '.env.production')
        ),
        [switch]$Override
    )

    foreach ($file in $Path) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        foreach ($line in Get-Content -LiteralPath $file -Encoding UTF8) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
            if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
            $name = $Matches[1]
            $value = $Matches[2].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            if ($Override -or [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}

function ConvertTo-HegelSalonAbsolutePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path $script:HegelSalonRoot $Path))
}

function Test-HegelSalonHostname {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Hostname
    )

    $value = $Hostname.Trim().TrimEnd('.')
    if ($value -notmatch '^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$') {
        throw "Hostname must be a public DNS name, for example relay.hegelsalon.com: $Hostname"
    }
    return $value.ToLowerInvariant()
}

function Initialize-HegelSalonEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Hostname,
        [ValidateRange(1, 65535)][int]$Port = 4327
    )

    $publicHost = Test-HegelSalonHostname $Hostname
    $env:NODE_ENV = 'production'
    $env:HOST = '127.0.0.1'
    $env:PORT = [string]$Port
    $env:XHS_AUTH_REQUIRED = 'true'
    $env:XHS_AUTH_SECURE_COOKIE = 'true'
    $env:XHS_AUTH_ORIGIN = "https://$publicHost"

    $defaults = [ordered]@{
        XHS_SERVER_DATA_DIR = (Join-Path $script:HegelSalonRoot 'data\jobs')
        XHS_PROFILE_DATA_DIR = (Join-Path $script:HegelSalonRoot 'data\profiles')
        XHS_BROWSER_DATA_DIR = (Join-Path $script:HegelSalonRoot 'data\browser')
        XHS_RELAY_CONFIG_PATH = (Join-Path $script:HegelSalonRoot 'data\relay-config.json')
        XHS_AI_CONFIG_PATH = (Join-Path $script:HegelSalonRoot 'data\ai-config.json')
        XHS_SMTP_CONFIG_PATH = (Join-Path $script:HegelSalonRoot 'data\smtp-config.json')
        XHS_DATA_RETENTION_PATH = (Join-Path $script:HegelSalonRoot 'data\data-retention.json')
        XHS_DELETION_AUDIT_PATH = (Join-Path $script:HegelSalonRoot 'data\deletion-audit.jsonl')
        XHS_DIAGNOSTICS_PATH = (Join-Path $script:HegelSalonRoot 'data\diagnostics.jsonl')
        XHS_AUTH_USERS_PATH = (Join-Path $script:HegelSalonRoot 'data\auth\users.json')
        XHS_AUTH_SESSION_SECRET_PATH = (Join-Path $script:HegelSalonRoot 'data\auth\session-secret')
    }
    foreach ($entry in $defaults.GetEnumerator()) {
        $current = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        $value = if ([string]::IsNullOrWhiteSpace($current)) { [string]$entry.Value } else { $current }
        [Environment]::SetEnvironmentVariable($entry.Key, (ConvertTo-HegelSalonAbsolutePath $value), 'Process')
    }

    return [pscustomobject]@{
        Hostname = $publicHost
        Port = $Port
        Origin = "http://127.0.0.1:$Port"
        PublicOrigin = "https://$publicHost"
        RuntimeRoot = (Join-Path $script:HegelSalonRoot '.runtime\hegelsalon')
        AuthUsersPath = [Environment]::GetEnvironmentVariable('XHS_AUTH_USERS_PATH', 'Process')
    }
}

function Ensure-HegelSalonDirectories {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][psobject]$Environment
    )

    $paths = @(
        $Environment.RuntimeRoot,
        (Split-Path -Parent $env:XHS_SERVER_DATA_DIR),
        $env:XHS_SERVER_DATA_DIR,
        $env:XHS_PROFILE_DATA_DIR,
        $env:XHS_BROWSER_DATA_DIR,
        (Split-Path -Parent $env:XHS_RELAY_CONFIG_PATH),
        (Split-Path -Parent $env:XHS_AI_CONFIG_PATH),
        (Split-Path -Parent $env:XHS_SMTP_CONFIG_PATH),
        (Split-Path -Parent $env:XHS_DATA_RETENTION_PATH),
        (Split-Path -Parent $env:XHS_DELETION_AUDIT_PATH),
        (Split-Path -Parent $env:XHS_DIAGNOSTICS_PATH),
        (Split-Path -Parent $env:XHS_AUTH_USERS_PATH),
        (Split-Path -Parent $env:XHS_AUTH_SESSION_SECRET_PATH)
    )
    foreach ($path in $paths | Where-Object { $_ } | Select-Object -Unique) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-HegelSalonNodeCommand {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $command) { throw 'Node.js 22 or newer is required.' }
    $major = 0
    try { $major = [int]((& $command.Source --version).TrimStart('v').Split('.')[0]) } catch { $major = 0 }
    if ($major -lt 22) { throw "Node.js 22 or newer is required; detected major version $major." }
    return $command
}

function Get-HegelSalonNpmCommand {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $command) { throw 'npm is required.' }
    return $command
}

function Get-HegelSalonPythonCommand {
    $bundled = Join-Path $script:HegelSalonRoot 'runtime\python\python.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
        return Get-Item -LiteralPath $bundled
    }
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $command) { throw 'Python 3.11 or newer is required.' }
    $version = @(& $command.Source --version 2>&1) -join ' '
    $match = [regex]::Match($version, '(\d+)\.(\d+)')
    if (-not $match.Success -or [int]$match.Groups[1].Value -lt 3 -or ([int]$match.Groups[1].Value -eq 3 -and [int]$match.Groups[2].Value -lt 11)) {
        throw "Python 3.11 or newer is required; detected $version."
    }
    return $command
}

function Get-HegelSalonCloudflaredCommand {
    $bundled = Join-Path $script:HegelSalonRoot 'runtime\cloudflared\cloudflared.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
        return Get-Item -LiteralPath $bundled
    }
    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command cloudflared -ErrorAction SilentlyContinue }
    if (-not $command) {
        $candidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
            (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
            (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe')
        )
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                return Get-Item -LiteralPath $candidate
            }
        }
        throw 'cloudflared.exe is required. Install it and authenticate with cloudflared tunnel login.'
    }
    return $command
}

function Get-HegelSalonExecutablePath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Command)
    if ($Command -is [string]) { return [IO.Path]::GetFullPath([string]$Command) }
    foreach ($propertyName in @('Source', 'Path', 'FullName')) {
        $property = $Command.PSObject.Properties[$propertyName]
        if ($property -and $property.Value) { return [string]$property.Value }
    }
    throw 'Unable to resolve an executable path.'
}

function Resolve-HegelSalonTunnel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TunnelName,
        [Parameter(Mandatory = $true)][object]$Cloudflared
    )

    $cloudflaredPath = Get-HegelSalonExecutablePath $Cloudflared
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = @(& $cloudflaredPath tunnel list --output json 2>&1); $exitCode = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousErrorAction }
    if ($exitCode -ne 0 -or -not $output) {
        throw "Unable to list Cloudflare tunnels. Authenticate cloudflared before continuing."
    }
    $lines = @($output | ForEach-Object { [string]$_ })
    $first = -1
    $last = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index].TrimStart().StartsWith('[')) { $first = $index; break }
    }
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        if ($lines[$index].TrimEnd().EndsWith(']')) { $last = $index; break }
    }
    if ($first -lt 0 -or $last -lt $first) { throw 'Cloudflare tunnel list returned invalid JSON.' }
    $jsonText = ($lines[$first..$last]) -join [Environment]::NewLine
    try { $tunnels = $jsonText | ConvertFrom-Json } catch { throw 'Cloudflare tunnel list returned invalid JSON.' }
    $items = if ($tunnels -is [array]) { $tunnels } else { @($tunnels) }
    $match = $items | Where-Object { [string]$_.name -eq $TunnelName } | Select-Object -First 1
    if (-not $match -or -not $match.id) { throw "Cloudflare tunnel '$TunnelName' was not found in the authenticated account." }
    return [pscustomobject]@{ Name = [string]$match.name; Id = [string]$match.id }
}

function Get-HegelSalonTunnelCredentialsPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TunnelId
    )

    $base = Join-Path $env:USERPROFILE '.cloudflared'
    $path = Join-Path $base "$TunnelId.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Cloudflare tunnel credentials file is missing: $path. Re-authenticate or install the tunnel credentials on this machine."
    }
    return [IO.Path]::GetFullPath($path)
}

function Write-HegelSalonCloudflaredConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$TunnelId,
        [Parameter(Mandatory = $true)][string]$CredentialsPath,
        [Parameter(Mandatory = $true)][string]$Hostname,
        [ValidateRange(1, 65535)][int]$Port = 4327
    )

    $safeHost = Test-HegelSalonHostname $Hostname
    $directory = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $escapedCredentials = $CredentialsPath.Replace('\\', '/')
    $content = @"
tunnel: $TunnelId
credentials-file: '$escapedCredentials'
no-autoupdate: true
ingress:
  - hostname: $safeHost
    service: http://127.0.0.1:$Port
    originRequest:
      httpHostHeader: 127.0.0.1
  - service: http_status:404
"@
    Set-Content -LiteralPath $ConfigPath -Value $content.TrimStart() -Encoding UTF8
    return [IO.Path]::GetFullPath($ConfigPath)
}

function Test-HegelSalonPortOpen {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(500, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

function Get-HegelSalonAvailablePort {
    [CmdletBinding()]
    param(
        [ValidateRange(1, 65535)][int]$Preferred = 4327
    )
    for ($candidate = $Preferred; $candidate -lt [Math]::Min(65535, $Preferred + 50); $candidate++) {
        if (-not (Test-HegelSalonPortOpen -HostName '127.0.0.1' -Port $candidate)) { return $candidate }
    }
    throw "No free loopback port was found near $Preferred."
}

function Invoke-HegelSalonHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port
    )
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
        return ($response.ok -eq $true -and $response.service -eq 'xiaohongshu-relay-scraper')
    } catch { return $false }
}

function Get-HegelSalonPidFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    return Join-Path $RuntimeRoot 'server.pid'
}

function Get-HegelSalonTrackedServerProcess {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $pidFile = Get-HegelSalonPidFile $RuntimeRoot
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $pid = 0
    if (-not [int]::TryParse($raw, [ref]$pid) -or $pid -le 0) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; return $null }
    try {
        $process = Get-Process -Id $pid -ErrorAction Stop
        if ($process.HasExited) { throw 'exited' }
        return $process
    } catch {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Stop-HegelSalonTrackedServer {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $process = Get-HegelSalonTrackedServerProcess $RuntimeRoot
    if ($process) {
        & taskkill.exe /PID $process.Id /T /F *> $null
    }
    Remove-Item -LiteralPath (Get-HegelSalonPidFile $RuntimeRoot) -Force -ErrorAction SilentlyContinue
}

function Get-HegelSalonRuntimePaths {
    [CmdletBinding()]
    param()
    $root = $script:HegelSalonRoot
    $dataRoot = Split-Path -Parent $env:XHS_SERVER_DATA_DIR
    $artifactPath = if ($env:XHS_ARTIFACTS_DIR) { $env:XHS_ARTIFACTS_DIR } else { Join-Path $root 'artifacts' }
    $outputPath = if ($env:XHS_OUTPUT_DIR) { $env:XHS_OUTPUT_DIR } else { Join-Path $root 'output' }
    $legacyProfilePath = if ($env:XHS_LEGACY_PROFILE_DIR) { $env:XHS_LEGACY_PROFILE_DIR } else { Join-Path $root 'profiles' }
    return [ordered]@{
        jobs = $env:XHS_SERVER_DATA_DIR
        profiles = $env:XHS_PROFILE_DATA_DIR
        browser = $env:XHS_BROWSER_DATA_DIR
        copilot = (Join-Path $dataRoot 'copilot')
        artifacts = (ConvertTo-HegelSalonAbsolutePath $artifactPath)
        output = (ConvertTo-HegelSalonAbsolutePath $outputPath)
        legacyProfiles = (ConvertTo-HegelSalonAbsolutePath $legacyProfilePath)
        auth = (Split-Path -Parent $env:XHS_AUTH_USERS_PATH)
        relayConfig = $env:XHS_RELAY_CONFIG_PATH
        aiConfig = $env:XHS_AI_CONFIG_PATH
        smtpConfig = $env:XHS_SMTP_CONFIG_PATH
        retention = $env:XHS_DATA_RETENTION_PATH
        deletionAudit = $env:XHS_DELETION_AUDIT_PATH
        diagnostics = $env:XHS_DIAGNOSTICS_PATH
    }
}
