@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
if not defined XHS_MCP_URL set "XHS_MCP_URL=http://127.0.0.1:4328/mcp"

if not defined XHS_MCP_TOKEN if not defined XHS_MCP_TOKEN_FILE (
  >&2 echo Set XHS_MCP_TOKEN_FILE to the one-time Grant token file before starting this bridge.
  exit /b 2
)

"%NODE_EXE%" "%~dp0scripts\mcp-stdio-bridge.mjs" %*
exit /b %ERRORLEVEL%
