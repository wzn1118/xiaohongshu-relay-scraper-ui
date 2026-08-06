[CmdletBinding()]
param(
    [string]$TunnelName = 'hegelsalon',
    [string]$Hostname = 'relay.hegelsalon.com',
    [ValidateRange(1, 65535)][int]$Port = 4317,
    [switch]$EnsureDns,
    [switch]$SkipInstall,
    [switch]$Start,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

Import-HegelSalonDotEnv
$environment = Initialize-HegelSalonEnvironment -Hostname $Hostname -Port $Port
Ensure-HegelSalonDirectories $environment
$node = Get-HegelSalonNodeCommand
$npm = Get-HegelSalonNpmCommand

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf)) {
    if ($SkipInstall) { throw 'node_modules/dist are missing. Remove -SkipInstall to prepare the release.' }
    Write-Host 'Installing locked Node dependencies and building the release...'
    & $npm.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
}

$pythonName = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
$python = Get-Command $pythonName -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.11 or newer is required.' }
$pythonVersion = [Version]((& $python.Source -c 'import sys; print(sys.version_info.major,sys.version_info.minor,sep=chr(46))').Trim())
if ($pythonVersion -lt [Version]'3.11') { throw "Python 3.11 or newer is required; detected $pythonVersion." }
& $python.Source -c 'import docx, openpyxl, playwright, pypdf, websockets' 2>$null
if ($LASTEXITCODE -ne 0) {
    if ($SkipInstall) { throw 'Required Python packages are missing. Remove -SkipInstall to prepare the release.' }
    Write-Host 'Installing locked Python dependencies...'
    & $python.Source -m pip install -r (Join-Path $root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed with exit code $LASTEXITCODE." }
}

$cloudflared = Get-HegelSalonCloudflaredCommand
$tunnel = Resolve-HegelSalonTunnel -TunnelName $TunnelName -Cloudflared $cloudflared
$credentials = Get-HegelSalonTunnelCredentialsPath -TunnelId $tunnel.Id
$configPath = Join-Path $environment.RuntimeRoot 'cloudflared-config.yml'
Write-HegelSalonCloudflaredConfig -ConfigPath $configPath -TunnelId $tunnel.Id -CredentialsPath $credentials -Hostname $environment.Hostname -Port $environment.Port | Out-Null
$cloudflaredPath = Get-HegelSalonExecutablePath $cloudflared
& $cloudflaredPath tunnel ingress validate --config $configPath 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cloudflare ingress validation failed for $($environment.Hostname)." }

if ($EnsureDns) {
    Write-Host "Ensuring DNS route for $($environment.Hostname) on tunnel $TunnelName..."
    & $cloudflaredPath tunnel route dns $TunnelName $environment.Hostname 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare DNS route setup failed for $($environment.Hostname)." }
}

Write-Host "Deployment prepared for https://$($environment.Hostname)."
Write-Host "Cloudflare config: $configPath"
Write-Host 'No credentials or password values were written to the repository.'

if ($Start) {
    $startScript = Join-Path $PSScriptRoot 'start-hegelsalon.ps1'
    $arguments = @('-TunnelName', $TunnelName, '-Hostname', $environment.Hostname, '-Port', [string]$environment.Port, '-StartTunnel')
    if ($EnsureDns) { $arguments += '-EnsureDns' }
    if ($NoBrowser) { $arguments += '-NoBrowser' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript @arguments
    exit $LASTEXITCODE
}
