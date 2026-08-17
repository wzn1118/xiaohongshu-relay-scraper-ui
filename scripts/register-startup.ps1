[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$TaskName = 'HegelSalon Relay Watchdog',
    [string]$EnvFile = '',
    [string]$Hostname = 'relay.hegelsalon.com',
    [string]$McpHostname = 'mcp.hegelsalon.com',
    [string]$TunnelName = 'hegelsalon-relay',
    [ValidateRange(1, 65535)][int]$Port = 4327,
    [string]$TunnelTokenFile = '',
    [switch]$UseExistingTunnel,
    [switch]$SkipBrowserRelayCheck,
    [ValidateRange(1, 60)][int]$IntervalMinutes = 5,
    [switch]$SkipInitialRun,
    [switch]$RegisterDisabled
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$legacyStartupFile = Join-Path $startupDir 'Relay Auto Start.vbs'
$watchdogScript = Join-Path $PSScriptRoot 'production-watchdog.ps1'

if ($TaskName -match '[\\/]') { throw 'TaskName must not contain a slash.' }
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "Watchdog script is missing: $watchdogScript" }

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $legacyStartupFile -Force -ErrorAction SilentlyContinue
    Write-Host "Removed startup registration: $TaskName"
    exit 0
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

$argumentParts = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-TaskArgument $watchdogScript),
    '-Hostname', (Quote-TaskArgument $Hostname),
    '-McpHostname', (Quote-TaskArgument $McpHostname),
    '-TunnelName', (Quote-TaskArgument $TunnelName),
    '-Port', [string]$Port
)
if ($EnvFile) {
    $resolvedEnv = if ([IO.Path]::IsPathRooted($EnvFile)) { [IO.Path]::GetFullPath($EnvFile) } else { [IO.Path]::GetFullPath((Join-Path $root $EnvFile)) }
    $argumentParts += @('-EnvFile', (Quote-TaskArgument $resolvedEnv))
}
if ($TunnelTokenFile) {
    $resolvedToken = if ([IO.Path]::IsPathRooted($TunnelTokenFile)) { [IO.Path]::GetFullPath($TunnelTokenFile) } else { [IO.Path]::GetFullPath((Join-Path $root $TunnelTokenFile)) }
    $argumentParts += @('-TunnelTokenFile', (Quote-TaskArgument $resolvedToken))
}
if ($UseExistingTunnel) { $argumentParts += '-UseExistingTunnel' }
if ($SkipBrowserRelayCheck) { $argumentParts += '-SkipBrowserRelayCheck' }

$powershell = Join-Path $PSHOME 'powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ($argumentParts -join ' ') -WorkingDirectory $root
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    Remove-Item -LiteralPath $legacyStartupFile -Force -ErrorAction SilentlyContinue
    if ($RegisterDisabled) {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
    } elseif (-not $SkipInitialRun) {
        Start-ScheduledTask -TaskName $TaskName
    }
    [ordered]@{
        registered = $true
        mode = 'scheduled-task'
        taskName = $TaskName
        user = $user
        intervalMinutes = $IntervalMinutes
        disabled = [bool]$RegisterDisabled
        initialRunStarted = [bool](-not $RegisterDisabled -and -not $SkipInitialRun)
    } | ConvertTo-Json -Depth 4
} catch {
    if ($RegisterDisabled) { throw }
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
    $escapedScript = $watchdogScript.Replace('"', '""')
    $loopArguments = ($argumentParts + @('-Loop', '-IntervalSeconds', [string]($IntervalMinutes * 60))) -join ' '
    $escapedArguments = $loopArguments.Replace('"', '""')
    $content = @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run """$powershell"" $escapedArguments", 0, False
"@
    Set-Content -LiteralPath $legacyStartupFile -Value $content -Encoding ASCII
    [ordered]@{
        registered = $true
        mode = 'startup-loop-fallback'
        path = $legacyStartupFile
        intervalMinutes = $IntervalMinutes
        scheduledTaskError = $_.Exception.Message
    } | ConvertTo-Json -Depth 4
}
