# HegelSalon production runbook

This repository is published as an application release, not as a data dump. The
public application hostname is `https://relay.hegelsalon.com`; the public
Streamable HTTP MCP endpoint is `https://mcp.hegelsalon.com/mcp`. The existing
`hegelsalon.com` and `www.hegelsalon.com` routes are preserved.

## First setup on the server

1. Use the portable release when the target machine has no Node.js, Python, or
   `cloudflared`, Chrome, or Edge. Node.js, Python, `cloudflared`, Chromium, and
   `node_modules` are bundled. The production launcher rejects an incomplete
   package that does not contain `runtime\browser\chrome.exe`.
2. On the Cloudflare administration machine, provision the dedicated remote
   tunnel, the application and MCP DNS records, the best-effort zone HTTPS
   redirect, and an external connector token file:

   ```powershell
   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1
   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1 -Apply
   ```

3. Copy `.env.production.example` to an external file such as
   `C:\ProgramData\HegelSalon\production.env.local`. Set the data paths and
   keep `XHS_AUTH_PASSWORD` out of the file.
4. Transfer the generated `hegelsalon-relay.token` separately to the target
   user's `%USERPROFILE%\.cloudflared` directory. The token is never part of a
   Git repository or release ZIP. If the file is absent, the double-click
   launcher asks for it once and stores it in that external user directory.

## Start and acceptance

The production launcher always binds Node to `127.0.0.1:4327` for Web/API and
`127.0.0.1:4328` for MCP; it never picks random ports. It requires authentication
and `XHS_AUTH_ORIGIN` to be the HTTPS application origin. It starts the origin,
optionally starts a token-based connector, checks both local listeners, checks
tunnel metrics when it owns the connector, then checks the application and MCP
public HTTPS health endpoints. Only after all checks pass does it open the
default browser.

The same successful start also registers `HegelSalon Relay Watchdog` for the
current Windows user. It runs at sign-in and every five minutes, checks the
loopback origin, public HTTPS route, CDP port, and target page, and restarts
only processes recorded as belonging to this release. The watchdog is
non-interactive: missing account or Tunnel setup is reported in
`.runtime\production\watchdog.log` instead of leaving a hidden password prompt.

```powershell
# This machine owns the dedicated connector token stored outside the release:
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-production-windows.ps1 `
  -EnvFile 'C:\ProgramData\HegelSalon\production.env.local' `
  -TunnelTokenFile "$env:USERPROFILE\.cloudflared\hegelsalon-relay.token"
```

Double-click `start-production-windows.cmd` after extracting the package. On the
first run it provisions `wang17326946305@163.com` and prompts securely for its
password and, when needed, the Tunnel token. It stores only the password hash in
the data directory and the Tunnel token in the current user's external
`.cloudflared` directory. Neither secret is written to Git, the ZIP, or a log.

The private transfer ZIP keeps the 715 cards, 715 notes, job artifacts, and
workflow state unredacted. Machine-specific authentication state and AI/SMTP
provider configuration are deliberately excluded and must be configured on the
destination computer.

Stop only the processes recorded by this release:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-production-windows.ps1
```

Remove the sign-in/periodic watchdog registration separately when retiring a
server:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-startup.ps1 -Remove
```

For a browser smoke check, provide credentials only through the current
process environment. The optional job and artifact variables add exact
assertions for a populated private data set; when omitted, the check still
validates the login gate and accepts an empty job list.

```powershell
$env:HEGELSALON_VERIFY_URL = 'https://relay.hegelsalon.com'
$env:HEGELSALON_VERIFY_EMAIL = 'admin@example.invalid'
$env:HEGELSALON_VERIFY_PASSWORD = (Read-Host 'Password' -AsSecureString | % { [System.Net.NetworkCredential]::new('', $_).Password })
node .\scripts\verify-production-browser.mjs
Remove-Item Env:HEGELSALON_VERIFY_URL,Env:HEGELSALON_VERIFY_EMAIL,Env:HEGELSALON_VERIFY_PASSWORD
```

## MCP client setup and acceptance

MCP is served by the same Node process on a separate loopback-only listener at
`http://127.0.0.1:4328/mcp`. Cloudflare publishes that listener only through the
dedicated `https://mcp.hegelsalon.com/mcp` hostname. Create a snapshot-bound
Grant in the Data Copilot MCP Access panel, place the one-time token in a
protected file outside the release, and run the official-SDK smoke check:

```powershell
$env:XHS_MCP_URL = 'http://127.0.0.1:4328/mcp'
$env:XHS_MCP_TOKEN_FILE = 'C:\ProgramData\HegelSalon\mcp-grant.token'
npm run verify:mcp
Remove-Item Env:XHS_MCP_URL,Env:XHS_MCP_TOKEN_FILE
```

For a remote client, set only the URL to the public HTTPS endpoint. Do not put
the Grant in a URL, query string, application config committed to Git, or a
Cloudflare setting:

```powershell
$env:XHS_MCP_URL = 'https://mcp.hegelsalon.com/mcp'
$env:XHS_MCP_TOKEN_FILE = 'C:\ProgramData\HegelSalon\mcp-grant.token'
npm run verify:mcp
Remove-Item Env:XHS_MCP_URL,Env:XHS_MCP_TOKEN_FILE
```

The verifier checks `/health`, initializes a standard Streamable HTTP session,
lists the Grant-filtered resources and tools, reads the first allowed resource,
and calls one allowed read-only tool. It prints counts and protocol evidence
only; it does not print the token or the resource URI. Set
`XHS_MCP_VERIFY_SKIP_RESOURCE_READ=true` only when an operations check must
avoid reading business data.

The release includes a production-only public verifier that creates an isolated
conversation and Grant, connects through Cloudflare using the official SDK,
reads a resource, calls `task.status`, revokes the Grant, proves the old token is
rejected, restores production, and writes a secret-free report:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-mcp-public-production.ps1
Get-Content .\.runtime\production\public-mcp-verification.json
```

Verify the isolated anonymous showcase without creating or reading a Grant:

```powershell
$env:XHS_MCP_URL = 'https://mcp.hegelsalon.com/mcp'
npm run verify:mcp:showcase
Remove-Item Env:XHS_MCP_URL
```

Expected edge behavior is: HTTPS `/health` returns 200; a browser GET to `/mcp`
returns 200 with mode `anonymous-read-only-showcase`; an unauthenticated official
SDK client sees only the fixed `showcase://` resources and read-only `showcase.*`
tools; any malformed, expired, or invalid Authorization header returns 401 and is
never downgraded to anonymous access. HTTP or a forged public Host without the
required Cloudflare HTTPS forwarding headers returns 403. The Cloudflare account
token may not have permission to enable the zone-wide `Always Use HTTPS` setting;
origin-side HTTPS forwarding enforcement remains mandatory and is independently
verified.

For stdio clients, use `npm run mcp:stdio` with the same `XHS_MCP_URL` and
`XHS_MCP_TOKEN_FILE`. Revoke or rotate the Grant after transferring a token to
the wrong client. Restore and private-package workflows revoke active Grants by
default, so replacement tokens must be issued after data movement.

## Release and data handling

Create a clean code release with dependencies included by default:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-windows-production.ps1
```

The public package excludes `.git`, `.env` files, `data`, browser profiles, runtime
logs, artifacts, Cloudflare credentials, and API keys. It contains the generated
`dist` tree, `node_modules`, and the supplied portable runtime tree. Raw task data
is delivered as a separate private archive and must not be uploaded to GitHub.

Runtime data is private and is handled separately:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-hegelsalon.ps1 -Quiesce
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-hegelsalon.ps1 `
  -Archive 'C:\backups\hegelsalon-backup-YYYYMMDD-HHMMSS.zip' -DryRun
```

The backup manifest hashes every copied file and retains SQLite `-wal` and
`-shm` sidecars. Treat a backup as sensitive because it can contain browser
sessions, authentication material, SMTP settings, or model credentials.

A private portable package that includes the 715-data bundle is a complete
extract-and-start release, not a backup archive. Keep its `data` directory in
place and start it with `start-production-windows.cmd`. The first start must run
inside the Windows user session that will keep the managed browser profile;
afterward the scheduled watchdog maintains the origin, Tunnel, and Relay while
that user is signed in. Only a ZIP generated by `backup-hegelsalon.ps1` is
accepted by `restore-hegelsalon.ps1`.

## Functional acceptance boundary

The application and MCP public health checks prove the two Tunnel routes and the
Node origins. The official MCP verifier additionally proves authenticated
protocol discovery, read, tool invocation, revocation, and production restore.
These checks do not
log into a social account or prove external AI, SMTP, OCR, Relay, SSE, task
resume, or artifact delivery. Those functions require the server's configured
browser session and provider credentials and must be tested after login on the
target machine. CDP/Relay remains loopback-only and is never exposed through
the public hostname.
