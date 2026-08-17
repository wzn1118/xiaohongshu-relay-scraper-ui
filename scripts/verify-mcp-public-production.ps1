[CmdletBinding()]
param(
    [string]$JobId = '',
    [string]$McpUrl = 'https://mcp.hegelsalon.com/mcp'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
. (Join-Path $PSScriptRoot 'hegelsalon-common.ps1')

$endpoint = [Uri]$McpUrl
if ($endpoint.Scheme -ne 'https' -or $endpoint.AbsolutePath -ne '/mcp' -or $endpoint.Query -or $endpoint.Fragment) {
    throw 'McpUrl must be an exact HTTPS /mcp endpoint without query or fragment.'
}

$runtimeRoot = Join-Path $root '.runtime\production'
$statePath = Join-Path $runtimeRoot 'production-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'Production state is missing. Start production before public MCP verification.'
}
$productionState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$productionPid = [int]$productionState.serverPid
if (-not (Get-Process -Id $productionPid -ErrorAction SilentlyContinue)) {
    throw "Tracked production server process $productionPid is not running."
}

if (-not $JobId) {
    $candidate = Get-ChildItem -LiteralPath (Join-Path $root 'data\jobs') -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'workflow-state.json') -PathType Leaf } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $candidate) { throw 'At least one persisted job is required for MCP verification.' }
    $JobId = $candidate.Name
}
$sourceJob = Join-Path $root "data\jobs\$JobId"
if (-not (Test-Path -LiteralPath (Join-Path $sourceJob 'workflow-state.json') -PathType Leaf)) {
    throw "Persisted job was not found: $JobId"
}

$verificationId = [guid]::NewGuid().ToString('N')
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "xhs-mcp-public-verify-$verificationId"
$temporaryJobs = Join-Path $temporaryRoot 'data\jobs'
$tokenFile = Join-Path $temporaryRoot 'grant.token'
$reportPath = Join-Path $runtimeRoot 'public-mcp-verification.json'
$environmentNames = @(
    'NODE_ENV', 'HOST', 'PORT', 'XHS_AUTH_REQUIRED', 'XHS_AUTH_SECURE_COOKIE', 'XHS_AUTH_ORIGIN',
    'XHS_MCP_ENABLED', 'XHS_MCP_HOST', 'XHS_MCP_PORT', 'XHS_MCP_PUBLIC_URL',
    'XHS_MCP_REQUIRE_CLOUDFLARE_HEADERS', 'XHS_MCP_PUBLIC_SHOWCASE_ENABLED',
    'XHS_SERVER_DATA_DIR', 'XHS_PROFILE_DATA_DIR',
    'XHS_BROWSER_DATA_DIR', 'XHS_RELAY_CONFIG_PATH', 'XHS_AI_CONFIG_PATH', 'XHS_SMTP_CONFIG_PATH',
    'XHS_DATA_RETENTION_PATH', 'XHS_DELETION_AUDIT_PATH', 'XHS_DIAGNOSTICS_PATH',
    'XHS_AUTH_USERS_PATH', 'XHS_AUTH_SESSION_SECRET_PATH', 'XHS_MCP_TOKEN_PEPPER_PATH',
    'XHS_AUDIENCE_AI_ENABLED', 'XHS_MCP_URL', 'XHS_MCP_TOKEN_FILE'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$isolatedProcess = $null
$grantId = ''
$verification = $null
$revocationRejected = $false
$restored = $false
try {
    New-Item -ItemType Directory -Path $temporaryJobs -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'data\jobs\jobs.json') `
        -Destination (Join-Path $temporaryJobs 'jobs.json') -Force
    Copy-Item -LiteralPath $sourceJob -Destination (Join-Path $temporaryJobs $JobId) -Recurse -Force

    & taskkill.exe /PID $productionPid /T /F *> $null
    Remove-Item -LiteralPath (Get-HegelSalonPidFile $runtimeRoot) -Force -ErrorAction SilentlyContinue

    $env:NODE_ENV = 'production'
    $env:HOST = '127.0.0.1'
    $env:PORT = '4327'
    $env:XHS_AUTH_REQUIRED = 'false'
    $env:XHS_AUTH_SECURE_COOKIE = 'false'
    [Environment]::SetEnvironmentVariable('XHS_AUTH_ORIGIN', $null, 'Process')
    $env:XHS_MCP_ENABLED = 'true'
    $env:XHS_MCP_HOST = '127.0.0.1'
    $env:XHS_MCP_PORT = '4328'
    $env:XHS_MCP_PUBLIC_URL = "$($endpoint.Scheme)://$($endpoint.Host)"
    $env:XHS_MCP_REQUIRE_CLOUDFLARE_HEADERS = 'true'
    $env:XHS_MCP_PUBLIC_SHOWCASE_ENABLED = 'true'
    $env:XHS_SERVER_DATA_DIR = $temporaryJobs
    $env:XHS_PROFILE_DATA_DIR = Join-Path $temporaryRoot 'data\profiles'
    $env:XHS_BROWSER_DATA_DIR = Join-Path $temporaryRoot 'data\browser'
    $env:XHS_RELAY_CONFIG_PATH = Join-Path $temporaryRoot 'data\relay-config.json'
    $env:XHS_AI_CONFIG_PATH = Join-Path $temporaryRoot 'data\ai-config.json'
    $env:XHS_SMTP_CONFIG_PATH = Join-Path $temporaryRoot 'data\smtp-config.json'
    $env:XHS_DATA_RETENTION_PATH = Join-Path $temporaryRoot 'data\data-retention.json'
    $env:XHS_DELETION_AUDIT_PATH = Join-Path $temporaryRoot 'data\deletion-audit.jsonl'
    $env:XHS_DIAGNOSTICS_PATH = Join-Path $temporaryRoot 'data\diagnostics.jsonl'
    $env:XHS_AUTH_USERS_PATH = Join-Path $temporaryRoot 'data\auth\users.json'
    $env:XHS_AUTH_SESSION_SECRET_PATH = Join-Path $temporaryRoot 'data\auth\session-secret'
    $env:XHS_MCP_TOKEN_PEPPER_PATH = Join-Path $temporaryRoot 'data\auth\mcp-token-pepper'
    $env:XHS_AUDIENCE_AI_ENABLED = 'false'

    $node = Get-HegelSalonNodeCommand
    $nodePath = Get-HegelSalonExecutablePath $node
    $isolatedProcess = Start-Process -FilePath $nodePath -ArgumentList @('server/index.mjs') `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $temporaryRoot 'server.out.log') `
        -RedirectStandardError (Join-Path $temporaryRoot 'server.err.log') -PassThru

    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($isolatedProcess.HasExited) {
            $details = if (Test-Path -LiteralPath (Join-Path $temporaryRoot 'server.err.log')) {
                (Get-Content -LiteralPath (Join-Path $temporaryRoot 'server.err.log') -Tail 30) -join [Environment]::NewLine
            } else { '' }
            throw "Isolated verifier server exited with code $($isolatedProcess.ExitCode). $details"
        }
        try {
            $health = Invoke-RestMethod -Uri "$($endpoint.Scheme)://$($endpoint.Host)/health" -TimeoutSec 5
            if ($health.ok -eq $true -and $health.service -eq 'xiaohongshu-relay-scraper-mcp') {
                $ready = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'The isolated public MCP endpoint did not become ready.' }

    $conversationBody = [ordered]@{
        jobId = $JobId
        mode = 'application'
        title = 'Public MCP production verification'
        idempotencyKey = "public-mcp-verify-$verificationId"
    } | ConvertTo-Json
    $conversation = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4327/api/copilot/conversations' `
        -ContentType 'application/json' -Body $conversationBody
    $conversationId = [string]$conversation.conversation.conversationId

    $grantBody = [ordered]@{
        conversationId = $conversationId
        name = 'Public SDK verification'
        expiresInSeconds = 600
        maxRisk = 'approval_required'
    } | ConvertTo-Json
    $grant = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4327/api/mcp/grants' `
        -ContentType 'application/json' -Body $grantBody
    $grantId = [string]$grant.grant.grantId
    [IO.File]::WriteAllText($tokenFile, [string]$grant.token, [Text.UTF8Encoding]::new($false))

    $env:XHS_MCP_URL = $endpoint.AbsoluteUri
    $env:XHS_MCP_TOKEN_FILE = $tokenFile
    $verifyStdout = Join-Path $temporaryRoot 'verify.out.log'
    $verifyStderr = Join-Path $temporaryRoot 'verify.err.log'
    $verifyProcess = Start-Process -FilePath $nodePath `
        -ArgumentList @((Join-Path $root 'scripts\verify-mcp-production.mjs')) `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $verifyStdout -RedirectStandardError $verifyStderr -Wait -PassThru
    if ($verifyProcess.ExitCode -ne 0) {
        $details = if (Test-Path -LiteralPath $verifyStderr) {
            (Get-Content -LiteralPath $verifyStderr -Tail 30) -join [Environment]::NewLine
        } else { '' }
        throw "Official SDK public verifier failed with exit code $($verifyProcess.ExitCode). $details"
    }
    $verification = Get-Content -LiteralPath $verifyStdout -Raw -Encoding UTF8 | ConvertFrom-Json

    $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4327/api/mcp/grants/$grantId/revoke" `
        -ContentType 'application/json' -Body '{}'
    $revokedStdout = Join-Path $temporaryRoot 'revoked.out.log'
    $revokedStderr = Join-Path $temporaryRoot 'revoked.err.log'
    $revokedProcess = Start-Process -FilePath $nodePath `
        -ArgumentList @((Join-Path $root 'scripts\verify-mcp-production.mjs')) `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $revokedStdout -RedirectStandardError $revokedStderr -Wait -PassThru
    $revocationRejected = $revokedProcess.ExitCode -ne 0
    if (-not $revocationRejected) { throw 'The revoked MCP grant remained usable.' }
} finally {
    Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
    if ($isolatedProcess -and (Get-Process -Id $isolatedProcess.Id -ErrorAction SilentlyContinue)) {
        & taskkill.exe /PID $isolatedProcess.Id /T /F *> $null
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Remove-Item -LiteralPath (Get-HegelSalonPidFile $runtimeRoot) -Force -ErrorAction SilentlyContinue
    & (Join-Path $PSScriptRoot 'start-production-windows.ps1') -NoBrowser -NonInteractive -SkipStartupRegistration -SkipBuild
    $restored = $true
}

$productionHealth = Invoke-RestMethod -Uri "$($endpoint.Scheme)://$($endpoint.Host)/health" -TimeoutSec 15
$report = [ordered]@{
    ok = [bool]($verification.ok -and $revocationRejected -and $restored -and $productionHealth.ok)
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    endpoint = $endpoint.AbsoluteUri
    officialSdkClient = [bool]$verification.officialSdkClient
    protocol = [string]$verification.transport
    resourceCount = [int]$verification.resourceCount
    toolCount = [int]$verification.toolCount
    resourceRead = $verification.resourceRead
    toolCall = $verification.toolCall
    revocationRejected = $revocationRejected
    productionRestored = $restored
    productionActiveGrants = [int]$productionHealth.grants.active
    productionActiveSessions = [int]$productionHealth.sessions.active
    grantId = $grantId
    jobId = $JobId
    temporaryEvidenceRoot = $temporaryRoot
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 6
