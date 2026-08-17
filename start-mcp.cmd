@echo off
setlocal
cd /d "%~dp0"

echo Starting the application and its local MCP service...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\one-click.ps1" -NoBrowser -EnableMcp %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo MCP startup failed. Review the message above, then press any key to close.
  pause >nul
)

exit /b %EXIT_CODE%
