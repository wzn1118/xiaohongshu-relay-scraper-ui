[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

& (Join-Path $PSScriptRoot 'ensure-windows-prerequisites.ps1') -InstallRuntime -InstallTools
if ($LASTEXITCODE -ne 0) { throw 'Windows prerequisites are not ready.' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
$python = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { 'python' }
if (-not (Get-Command $python -ErrorAction SilentlyContinue)) { throw 'Python 3.11+ is required.' }

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22+ is required.' }
$pythonVersion = [Version](& $python -c 'import sys; print(sys.version_info.major,sys.version_info.minor,sep=chr(46))')
if ($pythonVersion -lt [Version]'3.11') { throw 'Python 3.11+ is required.' }

npm ci
& $python -m pip install -r requirements.txt
npm run build
if (-not $SkipTests) {
    npm test
    & $python -m unittest discover -s tests -p 'test_*.py' -v
}

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}

Write-Host 'Bootstrap completed. Configure .env if the upstream skill is outside CODEX_HOME.'
Write-Host 'Start with: start-windows.cmd'
