[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TurnHost,
    [Parameter(Mandatory = $true)][string]$TurnUser,
    [Parameter(Mandatory = $true)][string]$Realm,
    [Parameter(Mandatory = $true)][string]$PublicIp,
    [string]$IdentityFile = '',
    [string]$OutputDir = '.runtime\codex-turn',
    [ValidateRange(1, 65535)][int]$ListenPort = 3478,
    [ValidateRange(1, 65535)][int]$RelayMinPort = 49160,
    [ValidateRange(1, 65535)][int]$RelayMaxPort = 49200,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Assert-SafeRemoteValue {
    param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Name)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9_.:@\[\]-]+$') {
        throw "$Name contains unsupported characters."
    }
}

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $root $Path))
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = @(& $FilePath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $details = ($output | Select-Object -Last 20 | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        throw "$FilePath failed with exit code $LASTEXITCODE. $details"
    }
    return $output
}

Assert-SafeRemoteValue -Value $TurnHost -Name 'TurnHost'
Assert-SafeRemoteValue -Value $TurnUser -Name 'TurnUser'
if ($RelayMinPort -gt $RelayMaxPort) { throw 'RelayMinPort must not exceed RelayMaxPort.' }

$outputPath = Resolve-AbsolutePath $OutputDir
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$generatorArgs = @(
    (Join-Path $PSScriptRoot 'generate-codex-turn-config.mjs'),
    '--realm', $Realm,
    '--public-ip', $PublicIp,
    '--listen-port', [string]$ListenPort,
    '--relay-min-port', [string]$RelayMinPort,
    '--relay-max-port', [string]$RelayMaxPort,
    '--output', $outputPath
)
Invoke-CheckedCommand -FilePath $node -Arguments $generatorArgs | Out-Null

$ssh = if (Get-Command ssh.exe -ErrorAction SilentlyContinue) { (Get-Command ssh.exe).Source } else { '' }
$scp = if (Get-Command scp.exe -ErrorAction SilentlyContinue) { (Get-Command scp.exe).Source } else { '' }
$remoteRoot = "/tmp/codex-turn-$([Guid]::NewGuid().ToString('N'))"
$remoteConfig = "$remoteRoot/turnserver.conf"
$remoteTarget = "$TurnUser@$TurnHost"
$configPath = Join-Path $outputPath 'turnserver.conf'
$commonSshArguments = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')
if ($IdentityFile) {
    $commonSshArguments += @('-i', (Resolve-AbsolutePath $IdentityFile))
}
$remoteInstallCommand = @"
set -eu
if command -v apt-get >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y coturn
elif command -v dnf >/dev/null 2>&1; then
  sudo -n dnf install -y coturn
elif command -v yum >/dev/null 2>&1; then
  sudo -n yum install -y coturn
else
  echo 'No supported apt, dnf, or yum package manager found.' >&2
  exit 1
fi
sudo -n install -d -m 700 /etc/coturn
sudo -n install -m 600 '$remoteConfig' /etc/coturn/turnserver.conf
sudo -n ln -sfn /etc/coturn/turnserver.conf /etc/turnserver.conf
if command -v ufw >/dev/null 2>&1; then
  sudo -n ufw allow 3478/tcp
  sudo -n ufw allow 3478/udp
  sudo -n ufw allow '$($RelayMinPort):$($RelayMaxPort)'/udp
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo -n firewall-cmd --permanent --add-port=3478/tcp
  sudo -n firewall-cmd --permanent --add-port=3478/udp
  sudo -n firewall-cmd --permanent --add-port='$($RelayMinPort)-$($RelayMaxPort)'/udp
  sudo -n firewall-cmd --reload
fi
if systemctl list-unit-files coturn.service >/dev/null 2>&1; then
  sudo -n systemctl enable --now coturn.service
elif systemctl list-unit-files turnserver.service >/dev/null 2>&1; then
  sudo -n systemctl enable --now turnserver.service
else
  echo 'coturn was installed but no coturn.service or turnserver.service unit was found.' >&2
  exit 1
fi
sudo -n systemctl is-active coturn.service >/dev/null 2>&1 || sudo -n systemctl is-active turnserver.service
rm -f '$remoteConfig'
rmdir '$remoteRoot' 2>/dev/null || true
"@.Trim()
$cleanupCommand = "rm -f '$remoteConfig'; rmdir '$remoteRoot' 2>/dev/null || true"

if ($PlanOnly) {
    [ordered]@{
        planOnly = $true
        turnHost = $TurnHost
        turnUser = $TurnUser
        realm = $Realm
        publicIp = $PublicIp
        configPath = $configPath
        remoteTarget = $remoteTarget
        remoteConfig = $remoteConfig
        relayPorts = "$RelayMinPort-$RelayMaxPort/udp"
        nextVerification = "npm run verify:codex:turn-relay -- --env $(Join-Path $outputPath 'product-turn.env')"
    } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not $ssh -or -not $scp) { throw 'OpenSSH ssh.exe and scp.exe are required. Use -PlanOnly to generate the bundle without connecting.' }
$remoteCreated = $false
try {
    Invoke-CheckedCommand -FilePath $ssh -Arguments ($commonSshArguments + @($remoteTarget, "mkdir -m 700 -p '$remoteRoot'")) | Out-Null
    $remoteCreated = $true
    $scpArguments = @('-q')
    if ($IdentityFile) { $scpArguments += @('-i', (Resolve-AbsolutePath $IdentityFile)) }
    $scpArguments += @($configPath, "$remoteTarget`:$remoteConfig")
    Invoke-CheckedCommand -FilePath $scp -Arguments $scpArguments | Out-Null
    Invoke-CheckedCommand -FilePath $ssh -Arguments ($commonSshArguments + @($remoteTarget, $remoteInstallCommand)) | Out-Null
    [ordered]@{
        provisioned = $true
        turnHost = $TurnHost
        turnUser = $TurnUser
        realm = $Realm
        publicIp = $PublicIp
        configPath = $configPath
        relayPorts = "$RelayMinPort-$RelayMaxPort/udp"
        nextVerification = "npm run verify:codex:turn-relay -- --env $(Join-Path $outputPath 'product-turn.env')"
        note = 'Cloud provider firewall rules for UDP/TCP 3478 and the relay range must also be open.'
    } | ConvertTo-Json -Depth 5
} finally {
    if ($remoteCreated) {
        & $ssh @commonSshArguments $remoteTarget $cleanupCommand *> $null
    }
}
