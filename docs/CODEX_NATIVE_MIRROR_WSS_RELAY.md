# Codex Native Mirror WSS Relay

Native Mirror now uses two transport layers:

1. WebRTC is attempted first for the lowest latency path.
2. The authenticated same-origin WebSocket endpoint `/v1/native-mirror/relay` is opened in parallel and becomes active when WebRTC fails, times out, or the URL contains `forceRelay=1`.

The relay is session-scoped. The Source role is the browser running on the machine that owns the Codex window; the Viewer role is the browser showing and controlling that window. Each role authenticates with its short-lived session token. The server pairs one Source and one Viewer, drops old connections for the same role, rejects reversed media direction, caps JSON and binary payloads, and never logs frame contents.

## Media and input

- Source media is encoded as VP8 with WebCodecs when available.
- Source browsers without WebCodecs fall back to bounded JPEG frames generated from the selected window video element.
- Viewer decodes VP8 with WebCodecs or draws JPEG frames to `#mirror-relay-canvas`.
- Viewer mouse, wheel, keyboard, and input acknowledgements use the same WSS channel. The existing loopback input channel remains the execution path for local Windows SendInput.
- The toolbar reports `Path wss-relay`, RTT, input P50/P95, and FPS while the fallback is active.

## Verification

The relay channel tests cover authenticated pairing, control forwarding, binary frame forwarding, activation persistence, and direction rejection:

```powershell
node --test server/codex-native-mirror-relay-channel.test.mjs
```

The browser verifier can force the fallback and requires a non-empty relay canvas, a real selected Codex window handle, coordinate accuracy, and acknowledged input samples:

```powershell
$env:XHS_MIRROR_VERIFY_FORCE_RELAY = '1'
$env:XHS_MIRROR_VERIFY_INPUT_P95_MAX_MS = '1600'
$env:XHS_MIRROR_VERIFY_SCREENSHOT = 'output/playwright/codex-native-mirror-wss-relay.png'
node scripts/verify-codex-native-mirror-e2e.mjs
```

The command must be run while the public HTTP tunnel and the paired Connector are online. A Connector reconnecting through Cloudflare will make the test fail before a window target is created; that is an environment failure and should be retried after `/api/codex-relay/devices` reports `online: true` and `transport: outbound-websocket` for the selected device.

## Deployment boundary

This fallback uses HTTPS/WSS and therefore works through the existing Cloudflare HTTP tunnel without requiring a public UDP TURN server. TURN remains an optional WebRTC optimization. When TURN is unavailable, the product still has a browser-usable relay path; the API reports `webrtc-direct-with-wss-relay-fallback` and keeps `turnConfigured` truthful.
