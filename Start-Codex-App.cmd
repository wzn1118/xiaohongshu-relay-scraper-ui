@echo off
setlocal
cd /d "%~dp0"

set "XHS_CODEX_BUILT_IN_EDITION=1"
call "%~dp0start-windows.cmd" -CodexBuiltIn %*
exit /b %ERRORLEVEL%
