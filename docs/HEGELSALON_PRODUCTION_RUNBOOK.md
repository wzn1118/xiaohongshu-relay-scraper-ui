# HegelSalon production runbook

This repository is published as an application release, not as a data dump. The
default public hostname for this deployment is `https://relay.hegelsalon.com`.
The existing `hegelsalon.com` and `www.hegelsalon.com` routes are preserved.

## First setup on the server

1. Use the portable release when the target machine has no Node.js, Python, or
   `cloudflared`. These three runtimes and `node_modules` are bundled.
2. On the Cloudflare administration machine, provision the dedicated remote
   tunnel, DNS record, and an external connector token file:

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

The production launcher always binds Node to `127.0.0.1:4327`; it never picks a
random port. It requires authentication and `XHS_AUTH_ORIGIN` to be the HTTPS
public origin. It starts the origin, optionally starts a token-based connector,
checks local `/api/health`, checks tunnel metrics when it owns the connector,
then checks `https://relay.hegelsalon.com/api/health`. Only after all checks pass
does it open the default browser.

```powershell
# This machine owns the dedicated connector token stored outside the release:
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-production-windows.ps1 `
  -EnvFile 'C:\ProgramData\HegelSalon\production.env.local' `
  -TunnelTokenFile "$env:USERPROFILE\.cloudflared\hegelsalon-relay.token"
```

Double-click `start-production-windows.cmd` after extracting the package. On the
first run it prompts for an administrator account and, when needed, the Tunnel
token. It stores only the password hash in the data directory and the Tunnel
token in the current user's external `.cloudflared` directory. Neither secret is
written to Git, the ZIP, or a log.

Stop only the processes recorded by this release:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-production-windows.ps1
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

## Functional acceptance boundary

The public health check proves the public route and the Node origin. It does not
log into a social account or prove external AI, SMTP, OCR, Relay, SSE, task
resume, or artifact delivery. Those functions require the server's configured
browser session and provider credentials and must be tested after login on the
target machine. CDP/Relay remains loopback-only and is never exposed through
the public hostname.
