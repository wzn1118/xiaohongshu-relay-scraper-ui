@echo off
setlocal
cd /d "%~dp0"

title Today You Applied - Competition Edition
echo Starting the complete competition edition: Web, managed browser, AI tools, and MCP...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-competition-windows.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. Keep this window open and review the error above.
  pause
)

exit /b %EXIT_CODE%
