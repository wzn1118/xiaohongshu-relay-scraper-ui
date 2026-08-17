[CmdletBinding()]
param(
    [string]$OutputRoot = '',
    [string]$NodeRoot = '',
    [string]$PythonRoot = '',
    [string]$CloudflaredPath = '',
    [string]$BrowserRoot = '',
    [switch]$Force,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $root $Path))
}

function Resolve-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "Required runtime command was not found: $Name" }
    foreach ($property in @('Source', 'Path', 'FullName')) {
        $value = $command.PSObject.Properties[$property]
        if ($value -and $value.Value) { return [IO.Path]::GetFullPath([string]$value.Value) }
    }
    throw "Unable to resolve runtime command path: $Name"
}

function Copy-Tree {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Runtime source directory was not found: $Source" }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $args = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy.exe @args | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Runtime copy failed with robocopy exit code ${LASTEXITCODE}: $Source" }
}

function Assert-SafeOutputRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $repo = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
    if ($resolved -eq $repo -or $resolved.Length -lt 4) { throw "Refusing to use an unsafe runtime output root: $resolved" }
    return $resolved
}

if (-not $OutputRoot) { $OutputRoot = Join-Path $root 'runtime' }
$output = Assert-SafeOutputRoot (Resolve-FullPath $OutputRoot)
if (Test-Path -LiteralPath $output) {
    if (-not $Force) { throw "Runtime output already exists. Use -Force to replace it: $output" }
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $output -Force | Out-Null

$nodeSource = if ($NodeRoot) { Resolve-FullPath $NodeRoot } else { Split-Path -Parent (Resolve-CommandPath 'node.exe') }
if (-not (Test-Path -LiteralPath (Join-Path $nodeSource 'node.exe') -PathType Leaf)) { throw "NodeRoot must contain node.exe: $nodeSource" }
if (-not (Test-Path -LiteralPath (Join-Path $nodeSource 'npm.cmd') -PathType Leaf)) { throw "NodeRoot must contain npm.cmd: $nodeSource" }
Copy-Tree -Source $nodeSource -Destination (Join-Path $output 'node')

$pythonExecutable = if ($PythonRoot -and (Test-Path -LiteralPath $PythonRoot -PathType Leaf)) { Resolve-FullPath $PythonRoot } else { $null }
$pythonSource = if ($PythonRoot -and -not $pythonExecutable) { Resolve-FullPath $PythonRoot } elseif ($pythonExecutable) { Split-Path -Parent $pythonExecutable } else { Split-Path -Parent (Resolve-CommandPath 'python.exe') }
$scriptParent = Split-Path -Parent $pythonSource
if (Test-Path -LiteralPath (Join-Path $scriptParent 'pyvenv.cfg') -PathType Leaf) { $pythonSource = $scriptParent }

# A venv created by uv points outside the project. Copy the base interpreter and
# overlay the venv packages so runtime/python remains relocatable on Windows.
$venvConfigPath = Join-Path $pythonSource 'pyvenv.cfg'
$pythonDestination = Join-Path $output 'python'
if (Test-Path -LiteralPath $venvConfigPath -PathType Leaf) {
    if (-not (Test-Path -LiteralPath (Join-Path $pythonSource 'Scripts\python.exe') -PathType Leaf)) { throw "Python venv is missing Scripts/python.exe: $pythonSource" }
    $homeLine = Get-Content -LiteralPath $venvConfigPath -Encoding UTF8 | Where-Object { $_ -match '^home\s*=\s*(.+)$' } | Select-Object -First 1
    if (-not $homeLine) { throw "Python venv is missing its home interpreter path: $venvConfigPath" }
    $baseSource = Resolve-FullPath (($homeLine -replace '^home\s*=\s*', '').Trim())
    if (-not (Test-Path -LiteralPath (Join-Path $baseSource 'python.exe') -PathType Leaf)) { throw "Python venv base interpreter was not found: $baseSource" }
    Copy-Tree -Source $baseSource -Destination $pythonDestination
    $sitePackages = Join-Path $pythonSource 'Lib\site-packages'
    if (-not (Test-Path -LiteralPath $sitePackages -PathType Container)) { throw "Python venv site-packages was not found: $sitePackages" }
    Copy-Tree -Source $sitePackages -Destination (Join-Path $pythonDestination 'Lib\site-packages')
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $pythonSource 'python.exe') -PathType Leaf)) { throw "PythonRoot must contain python.exe: $pythonSource" }
    Copy-Tree -Source $pythonSource -Destination $pythonDestination
}

$cloudflaredSource = if ($CloudflaredPath) { Resolve-FullPath $CloudflaredPath } else { Resolve-CommandPath 'cloudflared.exe' }
if (-not (Test-Path -LiteralPath $cloudflaredSource -PathType Leaf)) { throw "cloudflared executable was not found: $cloudflaredSource" }
New-Item -ItemType Directory -Path (Join-Path $output 'cloudflared') -Force | Out-Null
Copy-Item -LiteralPath $cloudflaredSource -Destination (Join-Path $output 'cloudflared\cloudflared.exe') -Force

if (-not $BrowserRoot) {
    $browserCandidates = @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application'),
        (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application')
    )
    $BrowserRoot = $null
    foreach ($candidate in $browserCandidates) {
        if (-not $candidate) { continue }
        $hasChrome = Test-Path -LiteralPath (Join-Path $candidate 'chrome.exe') -PathType Leaf
        $hasEdge = Test-Path -LiteralPath (Join-Path $candidate 'msedge.exe') -PathType Leaf
        if ($hasChrome -or $hasEdge) {
            $BrowserRoot = $candidate
            break
        }
    }
} else {
    $BrowserRoot = Resolve-FullPath $BrowserRoot
    if (Test-Path -LiteralPath $BrowserRoot -PathType Leaf) { $BrowserRoot = Split-Path -Parent $BrowserRoot }
}
if (-not $BrowserRoot -or -not (Test-Path -LiteralPath $BrowserRoot -PathType Container)) { throw 'A complete Chrome or Edge Application directory is required for the portable browser runtime.' }
$browserDestination = Join-Path $output 'browser'
Copy-Tree -Source $BrowserRoot -Destination $browserDestination
if (-not (Test-Path -LiteralPath (Join-Path $browserDestination 'chrome.exe') -PathType Leaf)) {
    $edge = Join-Path $browserDestination 'msedge.exe'
    if (Test-Path -LiteralPath $edge -PathType Leaf) { Copy-Item -LiteralPath $edge -Destination (Join-Path $browserDestination 'chrome.exe') -Force }
}

$required = @('node\node.exe', 'node\npm.cmd', 'python\python.exe', 'cloudflared\cloudflared.exe', 'browser\chrome.exe')
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $output $relative) -PathType Leaf)) { throw "Prepared portable runtime is incomplete: $relative" }
}

if (-not $SkipSmokeTest) {
    $node = Join-Path $output 'node\node.exe'
    $python = Join-Path $output 'python\python.exe'
    $cloudflared = Join-Path $output 'cloudflared\cloudflared.exe'
    $nodeVersion = (& $node --version 2>&1) -join ' '
    if ($LASTEXITCODE -ne 0) { throw "Bundled Node smoke test failed: $nodeVersion" }
    $pythonOutput = @(& $python -c "import sys; assert sys.version_info >= (3, 11); import docx, openpyxl, playwright, pypdf, websockets; print(sys.executable)" 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Bundled Python dependency smoke test failed: $($pythonOutput -join ' ')" }
    $cloudflaredVersion = (& $cloudflared --version 2>&1) -join ' '
    if ($LASTEXITCODE -ne 0) { throw "Bundled cloudflared smoke test failed: $cloudflaredVersion" }
}

$manifest = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    nodeSource = $nodeSource
    pythonSource = $pythonSource
    cloudflaredSource = $cloudflaredSource
    browserSource = $BrowserRoot
    files = @(Get-ChildItem -LiteralPath $output -File -Recurse -Force | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($output.Length).TrimStart('\', '/') -replace '\\', '/'; bytes = [int64]$_.Length }
    })
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'RUNTIME_MANIFEST.json') -Encoding UTF8
Add-Content -LiteralPath (Join-Path $output 'RUNTIME_MANIFEST.json') -Value ''
Write-Host "Portable runtime prepared: $output"
Write-Host "Runtime manifest: $(Join-Path $output 'RUNTIME_MANIFEST.json')"
