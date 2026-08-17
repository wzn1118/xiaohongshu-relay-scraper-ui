[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$PreferredWebPort = 4317,
    [ValidateRange(1024, 65535)]
    [int]$PreferredMcpPort = 4328,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Test-PortAvailable {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        try { $listener.Stop() } catch { }
    }
}

function Find-AvailablePort {
    param([int]$Start, [int[]]$Excluded = @())
    for ($candidate = $Start; $candidate -le [Math]::Min(65535, $Start + 200); $candidate += 1) {
        if ($Excluded -contains $candidate) { continue }
        if (Test-PortAvailable -Port $candidate) { return $candidate }
    }
    throw "No available local port was found between $Start and $([Math]::Min(65535, $Start + 200))."
}

$webPort = Find-AvailablePort -Start $PreferredWebPort
$mcpPort = Find-AvailablePort -Start $PreferredMcpPort -Excluded @($webPort)

Write-Host "Competition package web port: $webPort"
Write-Host "Competition package MCP port: $mcpPort"
Write-Host 'The first run downloads and installs Node.js, Python, Chrome, and project dependencies.'

$oneClickParameters = @{
    EnableMcp = $true
    Port = $webPort
    McpPort = $mcpPort
    NoBrowser = [bool]$NoBrowser
}

$portRecord = [ordered]@{
    web = "http://127.0.0.1:$webPort"
    mcp = "http://127.0.0.1:$mcpPort/mcp"
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$json = $portRecord | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $root 'LAST-STARTED-PORTS.json'), "$json`n", [Text.UTF8Encoding]::new($false))

Write-Host "Application: http://127.0.0.1:$webPort"
Write-Host "MCP endpoint: http://127.0.0.1:$mcpPort/mcp"

# one-click.ps1 exits the PowerShell host after the background server is ready,
# so persist the selected ports before handing over control.
& (Join-Path $PSScriptRoot 'one-click.ps1') @oneClickParameters
