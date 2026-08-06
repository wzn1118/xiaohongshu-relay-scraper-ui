[CmdletBinding()]
param(
    [string]$TunnelName = 'hegelsalon-relay',
    [string]$Hostname = 'relay.hegelsalon.com',
    [string]$Origin = 'http://127.0.0.1:4327',
    [string]$TokenOutputPath = (Join-Path $env:USERPROFILE '.cloudflared\hegelsalon-relay.token'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

function Read-CloudflareCertificate {
    $path = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Cloudflare certificate is missing: $path" }
    $lines = Get-Content -LiteralPath $path -Encoding ASCII
    $payload = ($lines | Where-Object { $_ -notmatch 'BEGIN|END' }) -join ''
    try { return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))) | ConvertFrom-Json } catch { throw 'Cloudflare certificate could not be decoded.' }
}

function Invoke-CloudflareApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Token,
        [object]$Body
    )
    $headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
    $params = @{ Method = $Method; Uri = $Uri; Headers = $headers; TimeoutSec = 30 }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
    $response = Invoke-RestMethod @params
    if ($response.success -ne $true) { throw "Cloudflare API request failed: $Uri" }
    return $response
}

function Get-ExistingTunnel {
    param([string]$AccountId, [string]$Token, [string]$Name)
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/cfd_tunnel?is_deleted=false"
    $response = Invoke-CloudflareApi -Method GET -Uri $uri -Token $Token
    return @($response.result | Where-Object { [string]$_.name -eq $Name } | Select-Object -First 1)
}

function Write-TunnelToken {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Token)
    $absolute = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location) $Path)) }
    $repoPrefix = ([IO.Path]::GetFullPath($root)).TrimEnd('\') + '\'
    if ($absolute.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Tunnel token output must remain outside the repository.' }
    $parent = Split-Path -Parent $absolute
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($absolute, $Token, [Text.UTF8Encoding]::new($false))
    return $absolute
}

$safeHost = Test-HegelSalonHostname $Hostname
try { $parsedOrigin = [Uri]$Origin } catch { throw "Origin must be a valid URI: $Origin" }
if ($parsedOrigin.Scheme -ne 'http' -or $parsedOrigin.Host -notin @('127.0.0.1', 'localhost', '::1') -or $parsedOrigin.AbsolutePath -ne '/') {
    throw 'Origin must be an HTTP loopback URL such as http://127.0.0.1:4327.'
}

$certificate = Read-CloudflareCertificate
$accountId = [string]$certificate.accountID
$zoneId = [string]$certificate.zoneID
$apiToken = [string]$certificate.apiToken
if (-not $accountId -or -not $zoneId -or -not $apiToken) { throw 'Cloudflare certificate does not contain the required account, zone, and API fields.' }

$tunnel = Get-ExistingTunnel -AccountId $accountId -Token $apiToken -Name $TunnelName
if (-not $Apply) {
    Write-Host "Tunnel name: $TunnelName"
    Write-Host "Public host: $safeHost"
    Write-Host "Origin: $Origin"
    Write-Host "Existing tunnel: $([bool]$tunnel)"
    Write-Host "Token path: $TokenOutputPath"
    Write-Host 'Dry run only. Re-run with -Apply to create or update the dedicated remote tunnel and DNS record.'
    exit 0
}

if (-not $tunnel) {
    $createUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel"
    $created = Invoke-CloudflareApi -Method POST -Uri $createUri -Token $apiToken -Body @{ name = $TunnelName; config_src = 'cloudflare' }
    $tunnel = @($created.result)
}
$tunnelId = [string]$tunnel.id
if (-not $tunnelId) { throw "Cloudflare did not return an id for tunnel '$TunnelName'." }

$configUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$tunnelId/configurations"
$config = @{ config = @{ ingress = @(
    @{ hostname = $safeHost; service = $Origin },
    @{ service = 'http_status:404' }
) } }
$null = Invoke-CloudflareApi -Method PUT -Uri $configUri -Token $apiToken -Body $config

$dnsQueryUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=CNAME&name=$safeHost"
$dns = Invoke-CloudflareApi -Method GET -Uri $dnsQueryUri -Token $apiToken
$record = @($dns.result) | Select-Object -First 1
$recordBody = @{ type = 'CNAME'; name = $safeHost; content = "$tunnelId.cfargotunnel.com"; proxied = $true; ttl = 1 }
if ($record) {
    $dnsUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$($record.id)"
    $null = Invoke-CloudflareApi -Method PUT -Uri $dnsUri -Token $apiToken -Body $recordBody
} else {
    $dnsUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records"
    $null = Invoke-CloudflareApi -Method POST -Uri $dnsUri -Token $apiToken -Body $recordBody
}

$tokenUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$tunnelId/token"
$tokenResponse = Invoke-CloudflareApi -Method GET -Uri $tokenUri -Token $apiToken
$tokenValue = [string]$tokenResponse.result
if (-not $tokenValue) { throw 'Cloudflare did not return a tunnel token.' }
$tokenPath = Write-TunnelToken -Path $TokenOutputPath -Token $tokenValue

Write-Host "Dedicated remote tunnel is ready: $TunnelName ($tunnelId)"
Write-Host "Public host: $safeHost"
Write-Host "Origin: $Origin"
Write-Host "Tunnel token file: $tokenPath"
Write-Host 'The token value was not printed. Set CLOUDFLARE_TUNNEL_TOKEN_FILE to this path before the production launcher starts.'
