# 当前 Worktree、Codex Relay 原型与本地实验事实

> 审计快照：`2026-08-18T18:41:54+08:00`。基线为 `HEAD=1fa74a0fb8cb19e043cad7c15bfcafc8c261ed2e`。`[W]` 表示 tracked diff，`[U]` 表示 Git 未跟踪文件，`[A]` 表示已核验但被 Git ignore 的本地 `output/` artifact，`[D]` 表示未跟踪设计/分析文档中的陈述。

## 工作树总览

- **XHS-WTR-001 [W]**：快照时有 22 个 tracked 文件相对 HEAD 修改，`git diff --stat` 为 2,058 insertions、46 deletions。
- **XHS-WTR-002 [U]**：排除本轮生成的 `docs/interview-prep/**` 与 `docs/interview-prep.zip` 后，有 60 个未跟踪实验文件，共 707,288 bytes。
- **XHS-WTR-003 [U]**：60 个文件按顶层目录分布为 docs 7/105,669 bytes、public 4/77,373 bytes、scripts 13/119,158 bytes、server 35/401,503 bytes、tests 1/3,585 bytes。
- **XHS-WTR-004 [W/U]**：这些增量主要实现 Codex Desktop 官方 Renderer 托管、app-server adapter、浏览器 host、设备网关、Local Connector、语义 Relay、Native Mirror、XHS Context 与 Codex Product MCP。
- **XHS-WTR-005 [W/U]**：工作树存在可执行实现与测试，但尚未形成 commit；面试中应称为“当前实验分支/工作区实现”，不应并入 v3.0.0 已发布能力。
- **XHS-WTR-006 [S]**：本轮对这些增量做了源码、diff、artifact hash 和静态 test-call 盘点，没有宣称完整 test suite 在本轮通过。

## 22 个 tracked diff

| 文件                                    |   + |   - | 当前增量主题                                                                  |
| --------------------------------------- | --: | --: | ----------------------------------------------------------------------------- |
| `.env.example`                          |  16 |   0 | ICE/TURN、设备网关、Connector、runtime baseline/evidence/worktree 环境项      |
| `.env.production.example`               |  16 |   0 | 同上，含公网 origin 示例                                                      |
| `package-lock.json`                     |  23 |   1 | `ws` dependency lock                                                          |
| `package.json`                          |  14 |   1 | 12 个 Codex 命令与 `ws` dependency                                            |
| `server/app-security.test.mjs`          | 208 |   0 | Remote Mirror、device credential、Connector control-plane security tests      |
| `server/app.mjs`                        | 756 |   4 | Codex/XHS Context/Relay/Connect/Mirror/browser 路由及静态资源                 |
| `server/config.mjs`                     |  69 |   0 | Codex paths、ICE/TURN、gateway、Connector 配置与验证                          |
| `server/copilot-protocol.test.mjs`      |   3 |   2 | Chat Completions reasoning_effort contract                                    |
| `server/copilot/model-gateway.mjs`      |  18 |   8 | reasoning model capability 与参数映射                                         |
| `server/copilot/model-run-broker.mjs`   |   1 |   1 | 两种 wire 都转发 reasoningEffort                                              |
| `server/data-copilot-runtime.mjs`       |   4 |   2 | Chat Completions 写 `reasoning_effort`                                        |
| `server/data-copilot-runtime.test.mjs`  |   6 |   1 | stream 请求 reasoning 参数断言                                                |
| `server/data-copilot-service.mjs`       |  12 |   1 | 模型能力判断扩展到已知 reasoning chat models                                  |
| `server/data-copilot-service.test.mjs`  |  16 |   0 | compatible chat model 设置持久化                                              |
| `server/index.mjs`                      | 103 |   2 | 12+ Codex services 组合与启动/关闭                                            |
| `src/App.tsx`                           | 376 |  15 | Codex 工作台、设备选择/配对/分享、semantic/mirror、context sync、API 生成开关 |
| `src/DataCopilotContext.tsx`            |   6 |   2 | reasoning effort 选项兼容 chat models                                         |
| `src/api.ts`                            | 209 |   0 | Codex/Relay/Device/Mirror/Context types 与 API client                         |
| `src/styles.css`                        |  58 |   0 | 工作台、设备、配对、Mirror 状态样式                                           |
| `tests/e2e/data-copilot.spec.ts`        |  90 |   2 | Codex surface、reasoning effort、AI API 模式 E2E                              |
| `tests/e2e/unsaved-draft-guard.spec.ts` |  46 |   0 | 仅采集/不提交 AI session E2E                                                  |
| `vite.config.ts`                        |   8 |   4 | output ignore、API WS、device tunnel WS、`/codex` proxy                       |

- **XHS-WTR-007 [W]**：`package.json` 新增 12 个命令：prepare/verify desktop、probe web/app-server、transport parity、runtime baseline、device relay、Connector health/update/rollback/verify/package。
- **XHS-WTR-008 [W]**：新 dependency 为 `ws ^8.21.3`；代码中 `CodexDeviceGatewayService` 使用 `WebSocketServer`。
- **XHS-WTR-009 [W]**：Vite 把 `/api` proxy 改为 `ws:true`，增加 `/v1/device-tunnel` WebSocket proxy，并把 `^/codex(?:/|$)` 代理到 API 服务。
- **XHS-WTR-010 [W]**：Vite watch ignore 从只有 `.playwright-cli` 扩为同时忽略 `output/**`，避免完整 Desktop runtime 进入 HMR graph。
- **XHS-WTR-011 [W]**：`.env*` 与 config 当前统一 Connector version `1.2.2`，默认 installer 为 `output/codex-local-connector-1.2.2.zip`。
- **XHS-WTR-012 [W]**：TURN credential TTL 默认 600 秒，config 允许 60-3,600 秒；device heartbeat 默认 15 秒，允许 5-60 秒。
- **XHS-WTR-013 [W]**：JSON 形式 ICE server 与 TURN URL 数组各最多保留 8 项；Connector allowed origins 必须是无 username/password/path/query/hash 的 HTTP(S) origin，并去重。
- **XHS-WTR-014 [W]**：gateway 状态默认 `data/codex-relay/devices.json`，audit 默认 `data/codex-relay/audit.jsonl`，worktree root 默认 `data/codex-worktrees`。
- **XHS-WTR-015 [W]**：runtime baseline 默认 `output/codex-runtimes/known-good.json`，protocol evidence 默认 `output/codex-web-runtime-probe`，Desktop runtime 默认目录名含 source ASAR hash 前缀 `55d9fb967596`。

## Tracked 运行时与 UI 行为

- **XHS-WTR-016 [W]**：`server/index.mjs` 新组合 Desktop、Browser、RuntimeCompatibility、ProtocolEvidence、Relay、HostCommand、HostRPC、NativeMirror、NativeInput、DeviceGateway、Product、ICE、XhsContext 服务。
- **XHS-WTR-017 [W]**：启动阶段 inspect runtime compatibility、加载 protocol evidence、初始化 device gateway；关闭阶段接入相应 service cleanup。
- **XHS-WTR-018 [W]**：`server/app.mjs` 增加 `/codex/` 官方 Renderer 静态面、`/codex-native-mirror.*`、Codex browser/desktop/relay/connect/native mirror/device/XHS context/Product MCP 路由。
- **XHS-WTR-019 [W]**：新增 public API 白名单含 XHS Context MCP、Codex Product MCP、device claim、Connector installer/manifest；heartbeat/claim/mirror 另使用设备或 role credential 边界。
- **XHS-WTR-020 [W]**：App UI 在现有页面增加 Codex dialog，可选择本机或已配对设备、创建一次性配对、撤销设备、复制分享链接、在 semantic 与 mirror 模式间切换。
- **XHS-WTR-021 [W]**：UI Native Mirror 状态区分 source launch error/requested、等待 source/viewer、media/control channel 连接以及 interactive control ready。
- **XHS-WTR-022 [W]**：UI 可把 active Job 同步为本机 XHS Context bundle，并展示 bundles/records/indexMode。
- **XHS-WTR-023 [W]**：岗位采集请求增加 `useCodexRuntime` 开关；AI API 模式需要 aiSession，纯采集模式不向任务提交 AI session。
- **XHS-WTR-024 [W]**：API client 新类型至少包含 CodexDesktopComponentStatus、CodexDesktopStatus/Launch、CodexRelayStatus/Device、CodexPairingIntent、CodexNativeMirrorSession、CodexRelayShareInvite、XhsContextStatus/Bundle。
- **XHS-WTR-025 [W]**：reasoning capability 增量识别 `gpt-5*`、`o1/o3/o4*`、`codex*` Chat Completions 模型；Responses 仍使用 `reasoning.effort`，Chat 使用 `reasoning_effort`。
- **XHS-WTR-026 [W]**：tracked test diff 静态新增 8 个 `test(`、删除 1 个旧 test call；新增命名测试覆盖 remote Mirror credential、device pairing、Connector claim、Codex surface、reasoning、API generation 与 no-AI-session collection。

## 17 个未跟踪实现模块

- **XHS-WTR-027 [U]**：`codex-app-server-transport.mjs` 管理 Codex app-server transport，并导出 context MCP 单/复数规范化 helper。
- **XHS-WTR-028 [U]**：`codex-browser-service.mjs` 提供浏览器到 app-server 的消息/事件面，内存事件上限 10,000。
- **XHS-WTR-029 [U]**：`codex-canonical-adapter.mjs` 以 schemaVersion 1 暴露 canonical/capability methods，比较 protocol evidence expected/actual version。
- **XHS-WTR-030 [U]**：`codex-connect-service.mjs` 实现 `codex-local:` launch protocol、5 分钟 pairing TTL、HMAC 签名 launch URL、一次性 claim、replace/revoke/reconnect/repair/rollback 与 signed manifest；当前 version 1.2.2。
- **XHS-WTR-031 [U]**：`codex-desktop-service.mjs` 发现/启动 Desktop，status schemaVersion 1。
- **XHS-WTR-032 [U]**：`codex-device-gateway-service.mjs` 实现 outbound WebSocket tunnel、配对/设备凭据、heartbeat/presence、remote semantic/mirror 命令、持久状态与 audit。
- **XHS-WTR-033 [U]**：device pairing TTL 为 5 分钟，离线判断 45 秒；capabilities 最多 32，消息最大 8 MiB，session events 每 session 最多 1,000。
- **XHS-WTR-034 [U]**：device token 只在 claim 响应返回一次，状态文件存 token hash；credential 比较使用 timing-safe equality。
- **XHS-WTR-035 [U]**：`codex-git-worker-service.mjs` 定义 browser worker 到 Git/worktree 的控制、读取与 mutation 方法；消息 2 MiB、输出 4 MiB、review files 200、search matches 250。
- **XHS-WTR-036 [U]**：`codex-host-command-service.mjs` 记录最多 500 个 observed messages，结果 cache 默认 1,000 条、TTL 2 分钟，并公开 recipe definitions。
- **XHS-WTR-037 [U]**：`codex-host-rpc-service.mjs` 实现独立 RPC protocol/version 与 schemaVersion 1 status。
- **XHS-WTR-038 [U]**：`codex-ice-service.mjs` 组合静态 ICE 和 TURN REST credentials，status schemaVersion 1。
- **XHS-WTR-039 [U]**：`codex-native-input-service.mjs` 限制 target label 300 字符、输入事件速率 180/s，并把控制事件交给选定窗口输入面。
- **XHS-WTR-040 [U]**：`codex-native-mirror-service.mjs` session 最长 2 小时，每 role 最多 256 个 signals，SDP 最大 512 KiB，ICE candidate 最大 16 KiB。
- **XHS-WTR-041 [U]**：`codex-product-service.mjs` 提供 product status/job/profile/artifact/audience/context/start/resume/cancel 的 MCP 工具与 resource/template；result 最大 4 MiB，list limit 最大 200。
- **XHS-WTR-042 [U]**：Product MCP protocol 为 `2025-06-18`、server `codex-product/1.0.0`，静态工具 15 个、固定资源 2 个、resource templates 3 个。
- **XHS-WTR-043 [U]**：`codex-protocol-evidence.mjs` 从 probe root 选择 protocol evidence，schemaVersion 1，并能提取 envelope methods。
- **XHS-WTR-044 [U]**：`codex-relay-service.mjs` session ticket 60 秒、stream ticket 30 秒、control lease 30 秒、session idle 30 分钟、stream idle 60 秒、event batch 最大 100。
- **XHS-WTR-045 [U]**：Relay semantic capability set 是 thread.read/thread.write/turn.start/approval.respond/artifact.read，状态声明 transport 为 loopback-http+websocket、contract `codex-relay.v1`。
- **XHS-WTR-046 [U]**：`codex-runtime-compatibility.mjs` schemaVersion 1，通过 runtime layout、app-server/preload、两个精确 JS patch anchors、aggregate fingerprint 与 known-good baseline 做 fail-closed 检查。
- **XHS-WTR-047 [U]**：compatibility 要求 app-initial 与 app-main patch candidate 各恰好 1 个；anchor 数变化返回 runtime patch error，baseline mismatch 使 ready=false。
- **XHS-WTR-048 [U]**：`xhs-context-service.mjs` 把 Job 产物构造成 immutable bundle，支持 overview/search/open/read/aggregate/cite/verify，文本读取上限 4 MiB。
- **XHS-WTR-049 [U]**：XHS Context MCP protocol 为 `2025-06-18`、server `xhs-context/1.0.0`，提供 list_bundles/overview/search/open_record/read_artifact/aggregate/cite/verify 8 个工具，不声明静态 resources/templates。

## 未跟踪测试资产

- **XHS-WTR-050 [U/S]**：未跟踪测试文件共 19 个，静态 `test(` 调用点 68 个；18 个位于 `server/`，另 1 个为 `tests/codex-device-relay.test.mjs`。
- **XHS-WTR-051 [U]**：17 个实现模块各有同名测试，另有 `codex-browser-host.test.mjs` 验证 public browser host；device relay CLI 在 `tests/` 有 4 个静态 test call。

| 测试文件                                       | 静态 `test(` |
| ---------------------------------------------- | -----------: |
| `server/codex-app-server-transport.test.mjs`   |            3 |
| `server/codex-browser-host.test.mjs`           |            1 |
| `server/codex-browser-service.test.mjs`        |            4 |
| `server/codex-canonical-adapter.test.mjs`      |            5 |
| `server/codex-connect-service.test.mjs`        |            2 |
| `server/codex-desktop-service.test.mjs`        |            2 |
| `server/codex-device-gateway-service.test.mjs` |            4 |
| `server/codex-git-worker-service.test.mjs`     |            7 |
| `server/codex-host-command-service.test.mjs`   |            4 |
| `server/codex-host-rpc-service.test.mjs`       |            2 |
| `server/codex-ice-service.test.mjs`            |            2 |
| `server/codex-native-input-service.test.mjs`   |            3 |
| `server/codex-native-mirror-service.test.mjs`  |            7 |
| `server/codex-product-service.test.mjs`        |            3 |
| `server/codex-protocol-evidence.test.mjs`      |            3 |
| `server/codex-relay-service.test.mjs`          |            7 |
| `server/codex-runtime-compatibility.test.mjs`  |            3 |
| `server/xhs-context-service.test.mjs`          |            2 |
| `tests/codex-device-relay.test.mjs`            |            4 |

## 未跟踪 docs/public/scripts

- **XHS-WTR-052 [U]**：7 份 docs 分别覆盖 device relay 部署、interactive mirror/session share、Local Relay 优化架构、Product MCP、web runtime 长期设计、当前 runtime 分析和 Electron surface。
- **XHS-WTR-053 [U]**：public 资产是 `codex-browser-host.js` 与 Native Mirror HTML/CSS/JS；browser host 是 56,053 bytes，为该组最大文件。
- **XHS-WTR-054 [U]**：13 个 scripts 包含 device relay、Local Connector、schema diff、Connector install/package/rollback、app-server/web probes、Desktop provision、baseline record、Desktop/Connector/transport parity verify。
- **XHS-WTR-055 [D]**：未跟踪文档把当前方案描述为直接托管 Desktop 26.803.81509/build 6415 官方 Renderer，通过 browser host 模拟 preload，并经 app-server transport 工作；这属于设计/探测报告陈述。
- **XHS-WTR-056 [D]**：长期设计明确要求 capability/fingerprint gate，而不是仅按 version equality 分支；当前只持有一个真实 Desktop/app-server 版本样本，跨版本矩阵仍是后续工作。

## 60 文件快照清单

> SHA-256 只列前 12 位，便于发现文件在审计后继续变化。

| 路径                                                 |  Bytes | SHA-256/12     |
| ---------------------------------------------------- | -----: | -------------- |
| `docs/CODEX_DEVICE_RELAY_DEPLOYMENT.md`              |  8,320 | `89575e0e05ff` |
| `docs/CODEX_INTERACTIVE_MIRROR_AND_SESSION_SHARE.md` |  2,082 | `cc9b551978ff` |
| `docs/CODEX_LOCAL_RELAY_OPTIMIZED_ARCHITECTURE.md`   | 21,573 | `c47bce58c5d2` |
| `docs/CODEX_PRODUCT_MCP.md`                          |  2,626 | `9b0d7075807f` |
| `docs/codex-web-runtime-design.md`                   | 44,909 | `d1f05df9907a` |
| `docs/current-runtime-analysis.md`                   | 13,011 | `a6a917aa3be9` |
| `docs/electron-surface.md`                           | 13,148 | `c6db419b78fd` |
| `public/codex-browser-host.js`                       | 56,053 | `81bcd84f022e` |
| `public/codex-native-mirror.css`                     |  3,267 | `4dfbacc70eda` |
| `public/codex-native-mirror.html`                    |  1,724 | `440f0192b2d3` |
| `public/codex-native-mirror.js`                      | 16,329 | `beee219e29b1` |
| `scripts/codex-device-relay.mjs`                     | 28,021 | `80d5fc8d6836` |
| `scripts/codex-local-connector.mjs`                  | 18,981 | `fd591626513f` |
| `scripts/diff-codex-app-server-schema.mjs`           |  9,079 | `a3cf26151422` |
| `scripts/install-codex-local-connector.ps1`          |  8,566 | `aa7f9175c096` |
| `scripts/package-codex-local-connector.ps1`          |  5,218 | `36029c1e565c` |
| `scripts/probe-codex-app-server.mjs`                 |  7,113 | `66698d0fa99a` |
| `scripts/probe-codex-web-runtime.mjs`                | 15,858 | `d58f37efbca2` |
| `scripts/provision-codex-desktop-runtime.ps1`        |  5,243 | `bba5f0715aa4` |
| `scripts/record-codex-runtime-baseline.mjs`          |    910 | `503b9e9940b7` |
| `scripts/rollback-codex-local-connector.ps1`         |  4,264 | `22db7f69b581` |
| `scripts/verify-codex-desktop-runtime.mjs`           |    652 | `9a548b1067b5` |
| `scripts/verify-codex-local-connector.mjs`           |  4,977 | `15579e10b022` |
| `scripts/verify-codex-transport-parity.mjs`          | 10,276 | `d59bf493dff0` |
| `server/codex-app-server-transport.mjs`              |  8,904 | `a768faf47abe` |
| `server/codex-app-server-transport.test.mjs`         |  4,092 | `55e1b3d64950` |
| `server/codex-browser-host.test.mjs`                 |  1,358 | `0d7df3c6dc43` |
| `server/codex-browser-service.mjs`                   |  5,462 | `6f423729cf39` |
| `server/codex-browser-service.test.mjs`              |  7,661 | `bab7a85e4c89` |
| `server/codex-canonical-adapter.mjs`                 |  7,699 | `6b1999f7ca9d` |
| `server/codex-canonical-adapter.test.mjs`            |  4,068 | `6ad201d2b2b1` |
| `server/codex-connect-service.mjs`                   | 13,091 | `e23c34e58f6c` |
| `server/codex-connect-service.test.mjs`              |  5,247 | `57f08f794cc0` |
| `server/codex-desktop-service.mjs`                   |  5,929 | `d319b88ef04a` |
| `server/codex-desktop-service.test.mjs`              |  3,712 | `0743d9843ea8` |
| `server/codex-device-gateway-service.mjs`            | 35,110 | `92baa3bb3567` |
| `server/codex-device-gateway-service.test.mjs`       | 10,087 | `79f6fef9744a` |
| `server/codex-git-worker-service.mjs`                | 55,479 | `6051e80c30bc` |
| `server/codex-git-worker-service.test.mjs`           | 18,901 | `161dda76108f` |
| `server/codex-host-command-service.mjs`              | 14,964 | `720f3288baa6` |
| `server/codex-host-command-service.test.mjs`         |  4,557 | `1b38c5acd4aa` |
| `server/codex-host-rpc-service.mjs`                  | 11,773 | `4936cca12f01` |
| `server/codex-host-rpc-service.test.mjs`             |  7,576 | `683cf9000cdb` |
| `server/codex-ice-service.mjs`                       |  4,800 | `039bd0e82f77` |
| `server/codex-ice-service.test.mjs`                  |  1,827 | `455911e440f0` |
| `server/codex-native-input-service.mjs`              | 15,408 | `d52874bc5aae` |
| `server/codex-native-input-service.test.mjs`         |  1,771 | `85b0be0c5669` |
| `server/codex-native-mirror-service.mjs`             | 17,213 | `9e0de13de144` |
| `server/codex-native-mirror-service.test.mjs`        |  9,399 | `59cee8ceb238` |
| `server/codex-product-service.mjs`                   | 20,899 | `ff04cb288912` |
| `server/codex-product-service.test.mjs`              |  9,374 | `28e0ad06ef64` |
| `server/codex-protocol-evidence.mjs`                 |  4,203 | `81af4e42099b` |
| `server/codex-protocol-evidence.test.mjs`            |  3,133 | `d393a739f978` |
| `server/codex-relay-service.mjs`                     | 27,397 | `26ed5382af02` |
| `server/codex-relay-service.test.mjs`                | 13,763 | `b86587356ae7` |
| `server/codex-runtime-compatibility.mjs`             | 12,349 | `8ca3834a7b37` |
| `server/codex-runtime-compatibility.test.mjs`        |  5,662 | `b995f34e7d38` |
| `server/xhs-context-service.mjs`                     | 24,259 | `37ec2f68d2fe` |
| `server/xhs-context-service.test.mjs`                |  4,376 | `5570314d85b5` |
| `tests/codex-device-relay.test.mjs`                  |  3,585 | `61cfa0fef756` |

## 已核验本地 output artifacts

- **XHS-WTR-057 [A]**：`output/codex-runtimes/known-good.json` 存在，1,834 bytes，SHA-256 `c0f540fda708fbce8751600d01771bd424528be5956d199d22a598a8b9eda6fb`。
- **XHS-WTR-058 [A]**：known-good 记录时间为 2026-08-17T22:24:14.519Z，Desktop 26.803.81509、build 6415、buildFlavor prod、packageIdentity `OpenAI.Codex`。
- **XHS-WTR-059 [A]**：known-good aggregate renderer fingerprint 为 `def7765343a5ad221a15dfd211a982498ea992f06b242aecd85846331d899d5b`，记录 6 个输入文件。
- **XHS-WTR-060 [A]**：fingerprint 输入含 293,412,656-byte `codex.exe`、4,391-byte preload、5,743-byte package、13,178,513-byte app-initial、2,758-byte app-main、14,239-byte index。
- **XHS-WTR-061 [A]**：`runtime-report.json` 存在，16,125 bytes，SHA-256 `9b651fafa3988198bc0fedf3d52196fe0dee547bb1acffde71c3cc7f8ac02b77`，生成于 2026-08-17T22:09:44.848Z。
- **XHS-WTR-062 [A]**：runtime report 记录 app-server protocol `0.147.0-alpha.6.6`，133 client requests、11 server requests、70 server notifications、1 client notification。
- **XHS-WTR-063 [A]**：`live-probe.json` 存在，2,179 bytes，SHA-256 `37e167b4a0e399e56eff570a62f3268c41b113ca9138643fe89caada67c51501`。
- **XHS-WTR-064 [A]**：live probe 于 2026-08-17T22:40:32.608Z 通过 loopback WebSocket 初始化，5 个 probe 全 pass，总 elapsed 8,017 ms。
- **XHS-WTR-065 [A]**：五项 probe 是 thread/list 5 ms/3 rows、model/list 3 ms/5 rows、skills/list 1,327 ms/1 row、mcpServerStatus/list 5,793 ms/4 rows、plugin/list 63 ms/4 marketplaces。
- **XHS-WTR-066 [A]**：`schema-self-diff.json` 存在，507 bytes，SHA-256 `84a782aafa7ab21034cc8b29cd29b239cbf578d17e2e86d714e7e701f62cd670`；361 vs 361 schema files，0 changes/breaking/nonBreaking/review。
- **XHS-WTR-067 [A]**：`output/codex-local-connector-1.2.2.zip` 存在，35,045,799 bytes，SHA-256 `2048e9b24c526f7fa076a2b32185ff4375351644f63170250d57fd2cd0b78b08`。
- **XHS-WTR-068 [A]**：output artifacts 被仓库 ignore，不属于 `git status` 的 60 个未跟踪实验文件，也不会由 HEAD-based `git archive` 自动发布。

## 面试边界与复核

### 活动开发漂移：18:49 快照

- **XHS-WTR-073 [W]**：到 `2026-08-18T18:49:47+08:00`，tracked 文件仍为 22 个，diff 增长到 2,074 insertions、46 deletions；相对 18:41 快照新增 16 行。
- **XHS-WTR-074 [W]**：16 行增量分布为 `package.json` +1、`src/App.tsx` +7、`src/api.ts` +8；新增 npm command 是 `configure:codex-turn = node scripts/generate-codex-turn-config.mjs`。
- **XHS-WTR-075 [U]**：18:49 未跟踪实验增长到 62 文件、726,260 bytes；分布变为 docs 7/106,612、public 4/79,144、scripts 14/126,425、server 35/407,455、tests 2/6,624。
- **XHS-WTR-076 [U]**：新增 `scripts/generate-codex-turn-config.mjs` 为 7,267 bytes，SHA-256 `c5f7d9431fb43ba9f7301455289da9257cb50e958e52cd4752ce32b113cbedfc`。
- **XHS-WTR-077 [U]**：TURN generator 默认 3478/5349、relay UDP 49160-49200、credential TTL 600 秒、输出 `.runtime/codex-turn`；输出 coturn config、product env、README，并把 secret 从返回 JSON 中替换为占位说明。
- **XHS-WTR-078 [U]**：新增 `tests/generate-codex-turn-config.test.mjs` 为 3,039 bytes，SHA-256 `732b797e55c18bd8fcbd8a6be06fc53e395a14f4ef5d15221d7f427f601369dc`，静态 4 个 test call，覆盖 config/env 一致、TLS 双证书、文件 bundle 与非法网络/port range。
- **XHS-WTR-079 [U/S]**：18:49 未跟踪 test 文件总数变为 20，静态 test call 74；18:41 的 19/68 与 60 文件 hash 表继续作为早一时点快照保留。
- **XHS-WTR-080 [S]**：两次盘点间除新增 10,306-byte TURN script/test 外，既有 docs/public/server 实验也增加 8,666 bytes，说明工作树在本事实审计期间有并行开发写入。

- **XHS-WTR-069 [W/U/A]**：存在代码、静态测试和本地 probe artifact，可说明已经进入工程化实验；仍需分别陈述“已提交主线”“未提交实现”“本机 probe 成果”。
- **XHS-WTR-070 [D]**：设计文档称核心 Threads/Models/Skills/MCP/Plugins 已有直接证据，同时把 native/worker-adjacent 与第二版本兼容矩阵列为缺口；不要把这一边界扩大为 Desktop 全功能等价。
- **XHS-WTR-071 [U]**：未跟踪 Connector、device token、share ticket、role token 等代码处理的是本机实验凭据；本事实库只记录结构、TTL、hash 与边界，不复制任何实际 secret。
- **XHS-WTR-072 [S]**：文件 hash 是快照校验值；工作区仍在活动开发时，后续 `git diff --stat`、未跟踪文件数和 hash 可能变化，应在模拟面试前重新刷新。

```powershell
git status --short --untracked-files=all
git diff --stat
git diff --numstat
git diff -- package.json server/config.mjs server/index.mjs server/app.mjs src/App.tsx src/api.ts vite.config.ts
Get-FileHash -Algorithm SHA256 output/codex-runtimes/known-good.json
Get-FileHash -Algorithm SHA256 output/codex-web-runtime-probe/0.147.0-alpha.6.6/runtime-report.json
Get-FileHash -Algorithm SHA256 output/codex-web-runtime-probe/0.147.0-alpha.6.6/live-probe.json
Get-FileHash -Algorithm SHA256 output/codex-local-connector-1.2.2.zip
```
