[CmdletBinding()]
param(
    [string]$TunnelName = 'hegelsalon',
    [string]$Hostname = 'relay.hegelsalon.com',
    [string]$Origin = 'http://127.0.0.1:4327',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

function Read-CloudflaredCertificate {
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
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 30 -Compress) }
    $response = Invoke-RestMethod @params
    if ($response.success -ne $true) { throw "Cloudflare API request failed: $Uri" }
    return $response
}

function Get-TunnelId {
    $cloudflared = Get-HegelSalonCloudflaredCommand
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath (Get-HegelSalonExecutablePath $cloudflared) -ArgumentList @('tunnel', 'list', '--output', 'json') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        if ($process.ExitCode -ne 0) { throw 'Unable to list Cloudflare tunnels. Authenticate cloudflared first.' }
        $json = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
        if (-not $json) { throw 'Unable to list Cloudflare tunnels. Authenticate cloudflared first.' }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $items = @($json | ConvertFrom-Json)
    $match = $items | Where-Object { [string]$_.name -eq $TunnelName } | Select-Object -First 1
    if (-not $match -or -not $match.id) { throw "Cloudflare tunnel '$TunnelName' was not found." }
    return [string]$match.id
}

function Get-HostnameIngress {
    param([object[]]$Ingress, [string]$HostName)
    return @($Ingress | Where-Object { [string]$_.hostname -eq $HostName })
}

$safeHost = Test-HegelSalonHostname $Hostname
$parsedOrigin = $null
try { $parsedOrigin = [Uri]$Origin } catch { throw "Origin must be a valid URI: $Origin" }
if ($parsedOrigin.Scheme -ne 'http' -or $parsedOrigin.Host -notin @('127.0.0.1', 'localhost', '::1') -or $parsedOrigin.AbsolutePath -ne '/') {
    throw 'Origin must be an HTTP loopback URL such as http://127.0.0.1:4327.'
}
$tunnelId = Get-TunnelId
$certificate = Read-CloudflaredCertificate
$accountId = [string]$certificate.accountID
$zoneId = [string]$certificate.zoneID
$apiToken = [string]$certificate.apiToken
if (-not $accountId -or -not $zoneId -or -not $apiToken) { throw 'Cloudflare certificate does not contain the required account, zone, and API fields.' }

$configUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/cfd_tunnel/$tunnelId/configurations"
$configResponse = Invoke-CloudflareApi -Method GET -Uri $configUri -Token $apiToken
$currentConfig = $configResponse.result.config
$currentIngress = @($currentConfig.ingress)
$withoutRelay = @($currentIngress | Where-Object {
    $routeHost = if ($_.PSObject.Properties.Name -contains 'hostname') { [string]$_.hostname } else { '' }
    $routeService = if ($_.PSObject.Properties.Name -contains 'service') { [string]$_.service } else { '' }
    $routeHost -ne $safeHost -and $routeService -ne "http://127.0.0.1:4327"
})
$catchAll = @($withoutRelay | Where-Object {
    -not ($_.PSObject.Properties.Name -contains 'hostname') -or -not [string]$_.hostname
} | Select-Object -Last 1)
$routes = @($withoutRelay | Where-Object {
    ($_.PSObject.Properties.Name -contains 'hostname') -and [string]$_.hostname
})
$newRoute = [pscustomobject]@{ hostname = $safeHost; service = $Origin }
$nextIngress = @($routes + $newRoute + $catchAll)

Write-Host "Tunnel: $TunnelName ($tunnelId)"
Write-Host "Public host: $safeHost"
Write-Host "Origin: $Origin"
Write-Host "Existing ingress preserved: $(@($routes | ForEach-Object { $_.hostname }) -join ', ')"
$plannedNames = @($nextIngress | ForEach-Object {
    if (($_.PSObject.Properties.Name -contains 'hostname') -and [string]$_.hostname) { $_.hostname } else { '<catch-all>' }
})
Write-Host "Planned ingress: $($plannedNames -join ', ')"
if (-not $Apply) { Write-Host 'Dry run only. Re-run with -Apply to update the tunnel and DNS.'; exit 0 }

$nextConfig = [ordered]@{ ingress = $nextIngress }
if ($null -ne $currentConfig.'warp-routing') { $nextConfig.'warp-routing' = $currentConfig.'warp-routing' }
$null = Invoke-CloudflareApi -Method PUT -Uri $configUri -Token $apiToken -Body @{ config = $nextConfig }

$dnsQueryUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=CNAME&name=$safeHost"
$dns = Invoke-CloudflareApi -Method GET -Uri $dnsQueryUri -Token $apiToken
$target = "$tunnelId.cfargotunnel.com"
$record = @($dns.result) | Select-Object -First 1
$recordBody = [ordered]@{ type = 'CNAME'; name = $safeHost; content = $target; proxied = $true; ttl = 1 }
if ($record) {
    $dnsUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$($record.id)"
    $null = Invoke-CloudflareApi -Method PUT -Uri $dnsUri -Token $apiToken -Body $recordBody
} else {
    $dnsUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records"
    $null = Invoke-CloudflareApi -Method POST -Uri $dnsUri -Token $apiToken -Body $recordBody
}
Write-Host "Applied relay route and proxied DNS record for $safeHost. Existing ingress routes were retained."
