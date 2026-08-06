@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-hegelsalon.ps1" -TunnelName "hegelsalon" -Hostname "relay.hegelsalon.com" -StartTunnel -EnsureDns
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo HegelSalon startup failed. Review the message above, then press any key to close.
  pause >nul
)

exit /b %EXIT_CODE%
