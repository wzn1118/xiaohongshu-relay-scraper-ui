# Codex Device Relay Deployment

This runbook covers the production control plane added for Codex Local Relay v2. The browser uses the existing full Codex renderer, but its host bridge can now bind a Semantic Session to a selected paired Windows device.

## Components

| Component | Location | Responsibility |
|---|---|---|
| Web application | Public HTTPS origin | Login, device list, pairing intents, session tickets, leases, event polling |
| Device Gateway | Same Node server, `/v1/device-tunnel` | Authenticated outbound WebSocket presence and session envelopes |
| Connector control plane | Same Node server, `/api/codex-connect/*` | Signed launch intents, installer manifest, device health, repair and revoke |
| Windows Connector | User-owned Windows device | `codex-local://` protocol, origin allowlist, startup reconnect and Relay launch |
| Device Relay | User-owned Windows device | DPAPI device credential, outbound reconnect, local Relay session mapping |
| Local Codex Relay | User-owned Windows device, loopback only | Real `codex.exe app-server`, workspace, terminal and local MCP |
| coturn | Regional public endpoint | STUN and TURN fallback with short-lived REST credentials |

The Device Relay initiates every public connection. The local Codex Relay, MCP endpoint and app-server remain bound to loopback and must not be exposed by a router or tunnel.

## Public Server Configuration

Set these values in the external production environment file:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
XHS_AUTH_REQUIRED=true
XHS_AUTH_ORIGIN=https://app.example.com

XHS_CODEX_MIRROR_ICE_SERVERS_JSON=[{"urls":"stun:turn.example.com:3478"}]
XHS_CODEX_TURN_URLS_JSON=["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"]
XHS_CODEX_TURN_SHARED_SECRET=REPLACE_WITH_RANDOM_SECRET
XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS=600
XHS_CODEX_DEVICE_GATEWAY_STATE_PATH=./data/codex-relay/devices.json
XHS_CODEX_DEVICE_GATEWAY_AUDIT_PATH=./data/codex-relay/audit.jsonl
XHS_CODEX_DEVICE_GATEWAY_HEARTBEAT_SECONDS=15
XHS_CODEX_CONNECT_ALLOWED_ORIGINS=https://app.example.com
XHS_CODEX_CONNECTOR_VERSION=1.2.3
XHS_CODEX_CONNECTOR_INSTALLER_PATH=./output/codex-local-connector-1.2.3.zip
```

The reverse proxy must forward HTTP Upgrade requests for `/v1/device-tunnel`. Device traffic uses `wss://app.example.com/v1/device-tunnel`; ordinary API and browser traffic remains HTTPS.

## coturn

Use coturn's time-limited REST credential mode. The relevant settings are:

Generate a matched coturn configuration and product environment bundle after the public TURN hostname and IP are available:

```powershell
npm run configure:codex-turn -- --realm turn.example.com --public-ip 203.0.113.10 --output .runtime/codex-turn
```

Add `--cert /etc/letsencrypt/live/turn.example.com/fullchain.pem --pkey /etc/letsencrypt/live/turn.example.com/privkey.pem` to enable `turns:` on TCP 5349. Without both paths the generator deliberately emits UDP and TCP TURN on 3478 only. The generated `turnserver.conf` and `product-turn.env` contain the same random REST secret and must remain outside source control.

Verify the product-side configuration without printing the shared secret:

```powershell
npm run verify:codex:turn -- --env .runtime/codex-turn/product-turn.env
```

After coturn is running and its firewall rules are open, require Chromium to obtain a real relay candidate:

```powershell
npm run verify:codex:turn-relay -- --env .runtime/codex-turn/product-turn.env
```

This probe forces `iceTransportPolicy=relay`. Success means the browser completed a TURN allocation with the same short-lived credentials used by Mirror. Its report contains candidate types, transport protocols, TURN error codes and elapsed time only; it excludes candidate addresses and every credential field.

From Windows, the coturn host can be bootstrapped over OpenSSH after its public IP and login are available:

```powershell
npm run provision:codex-turn -- -TurnHost turn.example.com -TurnUser deploy -Realm turn.example.com -PublicIp 203.0.113.10 -IdentityFile C:\secure\turn_ed25519
```

Use `-PlanOnly` first to generate the local bundle and inspect the remote actions without connecting. The remote script requires non-interactive `sudo`, detects `apt`, `dnf`, or `yum`, installs coturn, installs the generated config with mode `600`, opens local firewall rules when `ufw` or `firewalld` exists, enables the systemd service, and removes the temporary uploaded config. Cloud-provider firewall rules still need UDP/TCP 3478 and UDP relay ports `49160-49200`.

The Windows production launcher automatically overlays `.runtime/codex-turn/product-turn.env` after the main production environment. For a file stored elsewhere, pass `-TurnEnvFile C:\secure\product-turn.env`; the launcher carries that absolute path into the watchdog and startup task. `-CheckOnly` rejects partial URL/secret pairs, malformed JSON, weak secrets, and invalid credential TTL values before the API is restarted.

```text
use-auth-secret
static-auth-secret=REPLACE_WITH_RANDOM_SECRET
realm=turn.example.com
fingerprint
no-multicast-peers
no-loopback-peers
stale-nonce
```

The `static-auth-secret` value must match `XHS_CODEX_TURN_SHARED_SECRET`. The application generates a session-scoped username containing its expiry timestamp and signs it with HMAC-SHA1. The shared secret is never returned to a browser or a device.

Expose UDP/TCP 3478 and TLS 5349 according to the chosen coturn network layout. Restrict relay port ranges at the firewall and configure coturn's `min-port` and `max-port` consistently.

## Package The Connector

```powershell
npm run package:codex-connector
```

The command creates `output/codex-local-connector-1.2.3.zip` and a matching SHA-256 file. The public manifest reports the same checksum from `GET /api/codex-connect/manifest`, and `GET /api/codex-connect/installer` serves the verified archive. The connector validates the checksum before staging the package, retains the former `current.json` target as `previous.json`, and supports an explicit rollback without deleting either version.

Installed connectors check the manifest during `--background` startup. Operators can trigger the same verified flow with `npm run connector:update` or send `POST /api/codex-connect/devices/:deviceId/repair` to an online device. `npm run connector:rollback` and `POST /api/codex-connect/devices/:deviceId/rollback` swap the validated `current.json` and `previous.json` targets and update the protocol and startup registrations.

On the Windows device, extract the archive and run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex-local-connector.ps1 -AllowedOrigin "https://app.example.com"
```

The installer copies the versioned connector under `%LOCALAPPDATA%\XhsCodexConnector`, registers `codex-local://` for the current Windows user, persists the allowed origin, and adds a sign-in startup entry for automatic reconnect. The bundled `runtime\node.exe` means the target user does not install Node.js or npm.

## Connect A Device

1. Open the Codex workspace in the signed-in browser.
2. Select `连接本机` in the lower-right connector control.
3. The browser creates a five-minute signed intent and opens `codex-local://connect`.
4. The Connector checks its origin allowlist, verifies the server-bound claim, stores the returned token with Windows DPAPI, and opens the outbound WebSocket.
5. When the device reports online, the browser reloads the renderer with the new `deviceId` and opens its Semantic Session automatically.

The browser exposes the same lifecycle through these endpoints:

```text
POST /api/codex-connect/intents
GET  /api/codex-connect/intents/:id
POST /api/codex-connect/intents/:id/claim
GET  /api/codex-connect/devices
GET  /api/codex-connect/devices/:id/health
POST /api/codex-connect/devices/:id/reconnect
POST /api/codex-connect/devices/:id/repair
POST /api/codex-connect/devices/:id/revoke
GET  /api/codex-connect/installer
GET  /api/codex-connect/manifest
```

The command-line pairing path remains available for recovery:

The first-run command has this shape:

```powershell
npm run relay:device -- --claim-url "https://app.example.com/api/codex-relay/device-claims" --gateway "wss://app.example.com/v1/device-tunnel" --pairing-intent "PAIRING_ID" --code "PAIRING_CODE"
```

Subsequent starts only need:

```powershell
npm run relay:device
```

Register that command with the user's startup policy or a per-user scheduled task after controlled-beta validation.

## Security Properties

- Pairing codes expire after five minutes and are consumed once.
- The raw device token is returned once. The public server persists only its SHA-256 hash.
- Windows stores the device token encrypted with current-user DPAPI.
- A revoked device connection is closed immediately and its token stops authenticating.
- Browser session tickets expire after 60 seconds and are consumed once.
- Control leases expire after 30 seconds, renew every 10 seconds and use a per-device single-writer epoch.
- Device Gateway messages are limited to 8 MiB so the initial Codex state snapshot can traverse the tunnel. Large artifacts continue to use signed HTTP downloads.
- Prompt bodies, terminal streams and Codex account material are not written to the device registry or audit journal.

## Verification

```powershell
node --test server/codex-device-gateway-service.test.mjs server/codex-ice-service.test.mjs server/codex-relay-service.test.mjs
npm run connector:health
npm run verify:codex-connector -- --origin http://127.0.0.1:4317
npm run typecheck
npm run build
```

After startup, verify:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/codex-relay/gateway/status
Invoke-RestMethod http://127.0.0.1:4317/api/codex-relay/status
```

`ice.crossNetworkReady=true` confirms that the product is issuing TURN credentials. An active Mirror session also reports `connectionPath` as `direct`, `relay`, or `unknown`; `relay` proves that the selected WebRTC path is actually using TURN. Candidate IP addresses are intentionally not retained in product state.

## Controlled-Beta Boundary

The implemented remote default is the Semantic Session. It carries structured renderer requests, app-server events, approvals, terminal chunks and artifacts through the outbound device tunnel.

Connector 1.2.2 also enables interactive remote Native Mirror. The owner starts Mirror in the product, the paired connector opens the authenticated Source page on the selected Windows device, and that device asks the user to select the Codex window once. Video then travels peer-to-peer over WebRTC, while target registration and input commands return through the authenticated outbound device tunnel and execute through the device-local Windows SendInput bridge. Mirror launch and input execution results are reported back to the product, and after an update or rollback the old tunnel process hands off to the activated runtime automatically. The browser capture permission remains explicit; cross-network deployments should configure TURN for reliable media connectivity.
