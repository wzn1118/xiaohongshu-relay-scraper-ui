[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialPath,

    [Parameter(Mandatory = $true)]
    [string]$MetadataPath,

    [string]$ApiBase = 'https://relay.hegelsalon.com',

    [ValidateRange(1, 29)]
    [int]$RenewBeforeDays = 7,

    [ValidateRange(1, 30)]
    [int]$TtlDays = 30,

    [switch]$Force,

    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param([hashtable]$Value)
    $Value.tokenValueRecorded = $false
    $Value | ConvertTo-Json -Depth 6
}

$api = [Uri]$ApiBase
if ($api.Scheme -ne 'https' -or $api.UserInfo -or $api.Query -or $api.Fragment) {
    throw 'ApiBase must be a credential-free HTTPS origin.'
}
$origin = $api.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$resolvedCredentialPath = (Resolve-Path -LiteralPath $CredentialPath).Path
$resolvedMetadataPath = (Resolve-Path -LiteralPath $MetadataPath).Path
$metadata = Get-Content -LiteralPath $resolvedMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expiresAt = [DateTimeOffset]::Parse([string]$metadata.expiresAt).ToUniversalTime()
$now = [DateTimeOffset]::UtcNow
$rotationRequired = $Force -or $now -ge $expiresAt.AddDays(-$RenewBeforeDays)

if ($CheckOnly -or -not $rotationRequired) {
    Write-Result @{
        ok = $true
        checkedAt = $now.ToString('o')
        grantId = [string]$metadata.grantId
        expiresAt = $expiresAt.ToString('o')
        rotationRequired = [bool]$rotationRequired
        rotated = $false
    }
    exit 0
}

$credentials = @{}
foreach ($line in Get-Content -LiteralPath $resolvedCredentialPath) {
    if ($line -match '^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$') {
        $credentials[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
    }
}
$email = [string]$credentials.email
$password = [string]$credentials.password
if (-not $email -or -not $password) { throw 'Admin credential file is incomplete.' }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$headers = @{ Origin = $origin }
$loginBody = @{ email = $email; password = $password } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Method Post -Uri "$origin/api/auth/login" -WebSession $session `
    -Headers $headers -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
if ($login.authenticated -ne $true) { throw 'Admin login did not authenticate.' }

$rotateBody = @{
    name = [string]$metadata.grantName
    expiresInSeconds = $TtlDays * 24 * 60 * 60
} | ConvertTo-Json -Compress
$rotated = Invoke-RestMethod -Method Post `
    -Uri "$origin/api/mcp/grants/$($metadata.grantId)/rotate" `
    -WebSession $session -Headers $headers -ContentType 'application/json' `
    -Body $rotateBody -TimeoutSec 30
if (-not $rotated.token -or -not $rotated.grant.grantId) {
    throw 'Grant rotation response is incomplete.'
}

$tokenPath = [string]$metadata.tokenPath
if (-not $tokenPath) { throw 'Grant metadata does not define tokenPath.' }
[IO.File]::WriteAllText($tokenPath, [string]$rotated.token, [Text.UTF8Encoding]::new($false))

$updated = [ordered]@{
    serverName = [string]$metadata.serverName
    appUrl = [string]$metadata.appUrl
    endpoint = [string]$metadata.endpoint
    jobId = [string]$rotated.grant.jobId
    conversationId = [string]$rotated.grant.conversationId
    grantId = [string]$rotated.grant.grantId
    previousGrantId = [string]$rotated.previousGrantId
    grantName = [string]$rotated.grant.name
    createdAt = [string]$rotated.grant.createdAt
    expiresAt = [string]$rotated.grant.expiresAt
    maxRisk = [string]$rotated.grant.maxRisk
    resourceCount = @($rotated.grant.allowedResources).Count
    toolCount = @($rotated.grant.allowedTools).Count
    tokenPath = $tokenPath
    tokenStored = $true
    tokenValueRecorded = $false
    rotatedToMaintainAvailability = $true
}
[IO.File]::WriteAllText(
    $resolvedMetadataPath,
    (($updated | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)

Write-Result @{
    ok = $true
    checkedAt = ([DateTimeOffset]::UtcNow).ToString('o')
    grantId = $updated.grantId
    previousGrantId = $updated.previousGrantId
    expiresAt = $updated.expiresAt
    rotationRequired = $true
    rotated = $true
    resourceCount = $updated.resourceCount
    toolCount = $updated.toolCount
}
