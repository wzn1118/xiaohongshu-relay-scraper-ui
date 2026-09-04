# Codex Interactive Mirror and Session Share

## Interactive Native Mirror

Native Mirror now has two separate paths:

- WebRTC carries the selected Codex window to the viewer.
- A WebRTC `control` data channel carries normalized pointer, wheel, and keyboard events back to the selected-window source.
- The source registers the capture track label as the input target. On Windows, the server-side `codex-native-input-service` resolves the matching visible window and uses `SendInput` for mouse and keyboard injection.

The input adapter is deliberately capability-driven. Hosts without the Windows adapter remain view-only, while Windows hosts report `state: interactive` and `inputEnabled: true` from `/api/codex-native-mirror/status`.

The source role is the only role allowed to register a target or submit input events. The viewer controls the channel locally with the `Enable control` / `Release control` button. Closing the mirror clears the target and terminates the input bridge when no mirror remains.

## One-Click Session Share

`POST /api/codex-relay/invites` creates a semantic Relay session with a one-time, 60-second ticket. The response includes `shareUrl`, for example:

```text
/codex/?relaySessionId=...&relayTicket=...&relayBrowserInstanceId=...
```

Opening that URL makes `codex-browser-host.js` connect directly with the supplied ticket. The ticket is consumed on the first connection, so a copied link cannot be reused after it has been claimed. The existing device pairing flow remains available for long-lived outbound connector pairing; session sharing is the short-lived handoff path.

## Verification

- `server/codex-native-input-service.test.mjs` covers target normalization, event serialization, and unavailable-host behavior.
- `server/codex-native-mirror-service.test.mjs` covers source-only interactive authorization.
- `server/codex-relay-service.test.mjs` covers single-use share tickets.
- The browser viewer exposes `Interactive viewer`, defaults control on after initialization, and supports releasing/re-enabling control without reloading.
