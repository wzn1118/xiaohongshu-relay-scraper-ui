# Codex Native Mirror 超低延迟方案

## 目标

Native Mirror 的目标不是“能看到窗口”，而是让用户在产品内操作 Codex 时接近本机操作：

- 本机回环：输入事件 P50 小于 25 ms，P95 小于 60 ms。
- 公网直连：输入事件 P50 小于 60 ms，P95 小于 120 ms。
- 公网 TURN 中继：输入事件 P50 小于 120 ms，P95 小于 220 ms。
- 画面：优先保持 50-60 fps；交互页面端到端画面延迟目标小于 180 ms。
- 操作正确性：点击、按键、滚轮必须有确认；指针移动允许丢帧，但不能积压旧坐标。

## 当前链路

```text
Viewer pointer/keyboard
  -> WebRTC DataChannel
  -> Source Mirror page
  -> local HTTP /api/codex-native-mirror/sessions/:id/input
  -> Windows SendInput bridge
  -> Codex window
```

公网远程设备还会经过：

```text
Source Mirror page
  -> local Relay
  -> gateway WebSocket
  -> paired connector
  -> connector local Relay
  -> Windows SendInput bridge
```

## 已实施的第一阶段

### 1. 指针事件独立通道

`public/codex-native-mirror.js` 现在为控制事件和指针移动创建不同的 DataChannel：

- `control`：有序、可靠，用于点击、键盘、滚轮和确认消息。
- `pointer`：无序、`maxRetransmits: 0`，用于高频移动坐标。

这样点击或按键的确认不会阻塞后续移动坐标，旧坐标丢弃后不会形成输入延迟队列。

### 2. 源端移动事件旁路

源端将移动事件从离散输入队列中分离，只保留最新待发送坐标。移动请求在上一次请求完成后继续发送最新值，点击和按键仍保持串行确认。

### 3. Windows 注入移动事件免等待

`server/codex-native-input-service.mjs` 对移动事件写入长驻 PowerShell bridge 后直接返回，不再等待每一帧的回执。点击和键盘事件继续等待 bridge 确认，保持可验证性。

### 4. 采集和发送参数

Mirror 采集从 30 fps 上限提升到 60 fps，并设置：

- `track.contentHint = "motion"`
- `degradationPreference = "maintain-framerate"`
- `maxFramerate = 60`
- `maxBitrate = 8 Mbps`
- RTP sender `priority = "high"`

## 第二阶段：持久化输入通道

已增加长连接输入通道，同时保留 HTTP 回放作为公网单包丢失的可靠补偿：

```text
Source Mirror page
  -> authenticated WebSocket /v1/native-mirror/input
  -> native input service
```

协议建议：

```json
{
  "type": "pointer.move",
  "sessionId": "mirror-...",
  "sequence": 1024,
  "x": 0.42,
  "y": 0.61,
  "sentAt": 123456.78
}
```

- 移动事件使用最新值覆盖，服务端每个 session 只保留一个待处理移动事件。
- 点击、键盘、滚轮使用可靠队列，并返回 `acceptedAt` 与 `deliveredAt`。
- 每个 session 限制队列深度为 1 个移动事件加 32 个离散事件。
- WebSocket 断开时自动退回当前 HTTP 端点，不影响兼容性。

## 第三阶段：远程设备路径

远程设备已将 connector 到本机 Relay 的输入改为同一条持久化 WebSocket：

- `mirror.pointer`：立即走持久化 socket；同时进行不阻塞的 HTTP 回放，避免公网单包丢失使光标停在旧位置。
- `mirror.input`：点击、键盘、滚轮等待确认。
- `mirror.input-result`：只对离散事件返回。
- 远程 connector 端按 session 保存目标窗口句柄，避免每个事件重新查找窗口。
- 目标窗口失效时只发送一次错误状态，之后暂停移动事件，避免错误风暴。

## 第四阶段：ICE、TURN 和公网延迟

公网低延迟取决于候选路径，不应默认依赖 TCP 中继：

1. 优先启用 UDP host/srflx 直连。
2. 部署至少两个地域的 TURN UDP 节点。
3. 同时提供 TCP/TLS 443 作为企业网络 fallback。
4. 使用短时 HMAC 凭据，不把长期 TURN 密钥下发到浏览器。
5. 在 Mirror 状态栏展示 `direct`、`srflx` 或 `relay` 路径，并记录 RTT、丢包和帧率。
6. 当 RTT 或丢包超过阈值时动态降低分辨率，优先保持帧率和输入响应。

## 第五阶段：延迟遥测

为每次离散输入和每个移动采样增加单调时钟时间戳：

- `viewerSentAt`
- `sourceReceivedAt`
- `relayAcceptedAt`
- `bridgeDeliveredAt`
- `viewerAckAt`

服务端只记录耗时和路径，不记录按键内容。指标按 `local/direct/relay`、设备、浏览器和事件类型聚合：

- `mirror_input_latency_ms`
- `mirror_pointer_drop_ratio`
- `mirror_video_fps`
- `mirror_video_freeze_ms`
- `mirror_transport_rtt_ms`
- `mirror_control_reconnect_total`

## 第六阶段：可靠性和安全边界

- 继续使用 source/viewer 独立 token；指针通道不能改变授权模型。
- source 离开、窗口关闭或 session 过期时立即释放鼠标按键和键盘按键。
- 浏览器切后台时发送所有按键释放事件。
- 对移动事件进行 120-180 次/秒限流，对离散事件使用独立限流桶。
- 远程设备只接收签名 session envelope，不接受浏览器直接调用 Windows 输入接口。
- 每个 Mirror session 设置空闲 TTL 和最大生命周期。

## 验收清单

```powershell
npm run lint
npm run typecheck
node --test server/codex-native-input-service.test.mjs server/codex-native-mirror-service.test.mjs server/codex-device-gateway-service.test.mjs
$env:XHS_MIRROR_VERIFY_API='http://127.0.0.1:4327'
$env:XHS_MIRROR_VERIFY_WEB='https://relay.hegelsalon.com'
node scripts/verify-codex-native-mirror-e2e.mjs
Remove-Item Env:XHS_MIRROR_VERIFY_API
Remove-Item Env:XHS_MIRROR_VERIFY_WEB
```

## Implementation Status (2026-08-19)

The low-latency input phase is now implemented and deployed:

- `server/codex-native-mirror-input-channel.mjs` provides the authenticated persistent WebSocket at `/v1/native-mirror/input`.
- Pointer motion uses a best-effort coalescing lane and never waits for a Windows bridge acknowledgement.
- Click, wheel, and keyboard events use an ordered queue and return `mirror.input-result` acknowledgements with `requestId`.
- `public/codex-native-mirror.js` opens the source-side WebSocket, uses sequence de-duplication across fast and reliable pointer lanes, and falls back to HTTP when the socket is unavailable.
- The connector uses the same persistent local input socket for remote device sessions; its pointer path also has a non-blocking HTTP replay backstop.
- The isolated source browser now auto-selects the `Codex` window title rather than the unrelated `ChatGPT` title.
- Each remote Mirror session uses a unique browser profile, so a prior source window cannot capture or control a newly created session.
- Connector `1.2.13` prefers the HTTPS control plane for background updates, reports the active package version consistently, and terminates the session-owned Source browser process tree when a Mirror closes.
- The browser connector panel synchronizes with the Relay lifecycle and now shows `已连接远程设备` after the semantic Relay and Host RPC are connected.
- The no-auth presentation owner `local` is normalized to the internal `local-owner` identity for both loopback and public requests, so public remote Mirror sessions can address the same paired devices.
- Production health was restored on `https://relay.hegelsalon.com` with local API `http://127.0.0.1:4327` after extending startup recovery for the persisted task history.

Verified on the deployed instance:

- Local Mirror E2E: `peerConnected=true`, `controlConnected=true`, `pixelDelta={x:0,y:0}`.
- Public remote Mirror E2E: paired device `dev-bdfd644c-c639-4c36-849b-2993d63ccc48`, session `mirror-0ee6cec1-49d5-4969-a8df-82e2511480ae`, `peerConnected=true`, `controlConnected=true`, and `pixelDelta={x:0,y:0}`.
- Five seconds after that session closed, its dedicated Source browser process count was `0` and its per-session browser profile no longer existed.
- Targeted Mirror, input, device-gateway, app-security, lint, typecheck, and production build checks passed.

The deployed instance currently reports `connectivityMode=direct-only` and `turnConfigured=false`. Public direct operation is verified, but reliable operation behind restricted or symmetric NAT requires an external coturn host with a public IP and UDP relay ports. The repository includes generation, SSH provisioning, credential verification, and forced-relay browser probe scripts; no TURN hostname, public host, or SSH identity is configured on this machine, so relay mode is not claimed as deployed.

当前已验证：本机 Native Mirror `peerConnected=true`、`controlConnected=true`，真实输入坐标 `pixelDelta={x:0,y:0}`。第二阶段完成后，需要补充固定 1000 次移动、100 次点击和 100 次按键的 P50/P95 基准测试，再决定是否扩大公网灰度。
