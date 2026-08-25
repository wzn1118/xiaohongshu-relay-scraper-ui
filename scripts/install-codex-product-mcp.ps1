[CmdletBinding()]
param(
  [string]$ProductRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ProductOrigin = 'http://127.0.0.1:4317',
  [string]$CodexExecutable = 'codex',
  [switch]$SkipContext,
  [string]$McpGatewayTokenFile = '',
  [string]$McpGatewayUrl = 'http://127.0.0.1:4328/mcp'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath($ProductRoot)
$origin = ([Uri]$ProductOrigin).GetLeftPart([UriPartial]::Authority).TrimEnd('/')
$node = (Get-Command node -ErrorAction Stop).Source
$codex = (Get-Command $CodexExecutable -ErrorAction Stop).Source
$bridge = Join-Path $root 'scripts\codex-product-mcp-bridge.mjs'
$tokenFile = Join-Path $root 'data\xhs-context\local-token'

if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) { throw "Product MCP bridge is missing: $bridge" }
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw "Product MCP token file is missing: $tokenFile" }

function Invoke-CodexMcp([string]$Name, [string]$Url) {
  & $codex mcp remove $Name 2>$null | Out-Null
  & $codex mcp add $Name `
    --env "XHS_PRODUCT_MCP_URL=$Url" `
    --env "XHS_PRODUCT_MCP_TOKEN_FILE=$tokenFile" `
    --env "XHS_PRODUCT_MCP_NAME=$Name" `
    -- $node $bridge
  if ($LASTEXITCODE -ne 0) { throw "Codex MCP registration failed for $Name (exit $LASTEXITCODE)." }
}

Invoke-CodexMcp 'xhs-product' "$origin/api/codex-product/mcp"
if (-not $SkipContext) { Invoke-CodexMcp 'xhs-context' "$origin/api/xhs-context/mcp" }

$installed = @('xhs-product')
if (-not $SkipContext) { $installed += 'xhs-context' }

if ($McpGatewayTokenFile) {
  $gatewayToken = [IO.Path]::GetFullPath($McpGatewayTokenFile)
  if (-not (Test-Path -LiteralPath $gatewayToken -PathType Leaf)) { throw "MCP gateway token file is missing: $gatewayToken" }
  & $codex mcp remove 'xhs-workbench' 2>$null | Out-Null
  $stdioBridge = Join-Path $root 'scripts\mcp-stdio-bridge.mjs'
  & $codex mcp add 'xhs-workbench' `
    --env "XHS_MCP_URL=$McpGatewayUrl" `
    --env "XHS_MCP_TOKEN_FILE=$gatewayToken" `
    -- $node $stdioBridge
  if ($LASTEXITCODE -ne 0) { throw "Codex MCP registration failed for xhs-workbench (exit $LASTEXITCODE)." }
  $installed += 'xhs-workbench'
}

[ordered]@{
  installed = $installed
  productOrigin = $origin
  productRoot = $root
  tokenMode = 'file-backed'
  restartCodexRequired = $true
  message = 'Restart Codex so the new MCP servers and the product workspace context are loaded.'
} | ConvertTo-Json -Depth 5
