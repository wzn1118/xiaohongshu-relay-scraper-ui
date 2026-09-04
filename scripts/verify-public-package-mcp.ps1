[CmdletBinding()]
param(
  [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$WebPort = 45440,
  [int]$McpPort = 45441,
  [string]$SmokeRoot = ''
)

$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
$node = Join-Path $package 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw "Bundled Node.js runtime is missing: $node"
}

if (-not $SmokeRoot) {
  $SmokeRoot = Join-Path $env:TEMP ("today-you-applied-mcp-smoke-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Path $SmokeRoot -Force | Out-Null

$dataRoot = Join-Path $SmokeRoot 'data'
$env:NODE_ENV = 'test'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$WebPort
$env:XHS_MCP_ENABLED = 'true'
$env:XHS_MCP_HOST = '127.0.0.1'
$env:XHS_MCP_PORT = [string]$McpPort
$env:XHS_MCP_PUBLIC_SHOWCASE_ENABLED = 'false'
$env:XHS_AUTH_REQUIRED = 'false'
$env:XHS_SERVER_DATA_DIR = Join-Path $dataRoot 'jobs'
$env:XHS_AUTH_DATA_DIR = Join-Path $dataRoot 'auth'
$env:XHS_PROFILE_DATA_DIR = Join-Path $dataRoot 'profiles'
$env:XHS_BROWSER_DATA_DIR = Join-Path $dataRoot 'browser'
$env:XHS_RELAY_CONFIG_PATH = Join-Path $dataRoot 'relay-config.json'
$env:XHS_AI_CONFIG_PATH = Join-Path $dataRoot 'ai-config.json'
$env:XHS_SMTP_CONFIG_PATH = Join-Path $dataRoot 'smtp-config.json'
$env:XHS_DATA_RETENTION_PATH = Join-Path $dataRoot 'data-retention.json'
$env:XHS_DELETION_AUDIT_PATH = Join-Path $dataRoot 'deletion-audit.jsonl'
$env:XHS_DIAGNOSTICS_PATH = Join-Path $dataRoot 'diagnostics.jsonl'
$env:XHS_MCP_TOKEN_PEPPER_PATH = Join-Path $dataRoot 'auth\mcp-token-pepper'

$stdout = Join-Path $SmokeRoot 'server.stdout.log'
$stderr = Join-Path $SmokeRoot 'server.stderr.log'
$process = $null

function Get-HttpStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [string]$Method = 'Get',
    [string]$Body = '',
    [string]$ContentType = 'application/json'
  )

  try {
    $request = @{
      UseBasicParsing = $true
      Uri = $Uri
      Method = $Method
      TimeoutSec = 10
    }
    if ($Body) {
      $request.Body = $Body
      $request.ContentType = $ContentType
    }
    $response = Invoke-WebRequest @request
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode
    }
    throw
  }
}

try {
  $process = Start-Process `
    -FilePath $node `
    -ArgumentList 'server/index.mjs' `
    -WorkingDirectory $package `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  $appHealth = $null
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) {
      throw "Server exited early with code $($process.ExitCode). See $stderr"
    }
    try {
      $appHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/health" -TimeoutSec 2
      if ($appHealth.ok) { break }
    } catch {
      $appHealth = $null
    }
  }
  if (-not $appHealth -or -not $appHealth.ok) {
    throw "Application health endpoint did not become ready. See $stderr"
  }

  $web = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/" -TimeoutSec 10
  $mcpStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/mcp/status" -TimeoutSec 10
  $mcpHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$McpPort/health" -TimeoutSec 10
  $unauthorized = Get-HttpStatus `
    -Uri "http://127.0.0.1:$McpPort/mcp" `
    -Method 'Post' `
    -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  $grantsStatus = Get-HttpStatus -Uri "http://127.0.0.1:$WebPort/api/mcp/grants"

  $checks = [ordered]@{
    webStatus = [int]$web.StatusCode
    webHasRoot = [bool]($web.Content -match '<div id="root"')
    appHealthOk = [bool]$appHealth.ok
    appService = [string]$appHealth.service
    mcpStatusOk = [bool]$mcpStatus.ok
    mcpStatusService = [string]$mcpStatus.service
    mcpStatusProtocol = [string]$mcpStatus.protocol
    mcpEndpoint = "http://127.0.0.1:$McpPort/mcp"
    mcpHealthOk = [bool]$mcpHealth.ok
    mcpHealthService = [string]$mcpHealth.service
    mcpUnauthorizedStatus = $unauthorized
    grantsApiStatus = $grantsStatus
    processAliveDuringCheck = [bool](-not $process.HasExited)
  }
  $passed = (
    $checks.webStatus -eq 200 -and
    $checks.webHasRoot -and
    $checks.appHealthOk -and
    $checks.mcpStatusOk -and
    $checks.mcpStatusService -eq 'xiaohongshu-relay-scraper-mcp' -and
    $checks.mcpStatusProtocol -eq 'streamable-http' -and
    $checks.mcpHealthOk -and
    $checks.mcpUnauthorizedStatus -eq 401 -and
    $checks.grantsApiStatus -eq 200 -and
    $checks.processAliveDuringCheck
  )

  [ordered]@{
    passed = $passed
    package = $package
    smokeData = $SmokeRoot
    pid = $process.Id
    checks = $checks
    stdout = $stdout
    stderr = $stderr
  } | ConvertTo-Json -Depth 5

  if (-not $passed) { exit 1 }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
  }
}
