# HTTP、SSE 与 MCP 路由事实

> 本文件的主表只列 `HEAD=1fa74a0` 已提交路由。当前工作树新增 Codex 路由集中放在末节。

## 通用 HTTP 行为

- **XHS-API-001 [HEAD]**：主应用路由由 `createApp()` 返回的 Node HTTP handler 实现，证据为 `server/app.mjs`。
- **XHS-API-002 [HEAD]**：每个请求生成或接受 request ID，并在响应中写 `X-Request-Id`；diagnostics 使用 request/job/post/run 等固定字段关联。
- **XHS-API-003 [HEAD]**：状态改变方法执行 origin/CSRF 边界校验；`OPTIONS` 有独立 preflight 处理。
- **XHS-API-004 [HEAD]**：认证开启时，除 auth/health 等 public route 外，`/api/*` 需要有效 session；MCP 独立数据面不使用浏览器 Cookie。
- **XHS-API-005 [HEAD]**：未知 `/api/*` 返回结构化 404；非 API 的 GET/HEAD 尝试从 Vite build 静态目录提供 SPA。
- **XHS-API-006 [HEAD]**：默认 JSON body 上限为 32 MiB；具体 MCP、multipart 和文件工具另有更小上限。
- **XHS-API-007 [HEAD]**：`GET /api/health` 是发布 smoke 与 Playwright server readiness 的健康入口，service 标识为 `xiaohongshu-relay-scraper`。

## Auth、健康、配置与预检

| 方法   | 路径                      | 已提交行为            |
| ------ | ------------------------- | --------------------- |
| GET    | `/api/auth/me`            | 当前 auth session     |
| POST   | `/api/auth/login`         | 邮箱/密码登录         |
| POST   | `/api/auth/logout`        | 清除 session          |
| GET    | `/api/health`             | 应用健康、能力状态    |
| GET    | `/api/diagnostics/bundle` | 结构化诊断 bundle     |
| GET    | `/api/relay/config`       | Relay 配置            |
| PUT    | `/api/relay/config`       | 更新 Relay 配置       |
| GET    | `/api/email/config`       | 脱敏 SMTP 配置        |
| PUT    | `/api/email/config`       | 更新 SMTP 配置        |
| DELETE | `/api/email/config`       | 清除 SMTP 配置        |
| POST   | `/api/email/test`         | 验证当前 SMTP 配置    |
| GET    | `/api/relay/status?port=` | 检查 Relay/CDP 状态   |
| POST   | `/api/relay/connect`      | 连接 Relay            |
| POST   | `/api/relay/recover`      | 恢复 Relay            |
| POST   | `/api/relay/setup`        | 准备 Relay runtime    |
| POST   | `/api/relay/login`        | 打开登录入口          |
| POST   | `/api/preflight`          | 无正式 Job 的就绪检查 |

- **XHS-API-008 [HEAD]**：preflight 与创建正式 Job 分离，提交历史 `547cb0b` 明确对应“separate readiness checks from formal jobs”。
- **XHS-API-009 [HEAD]**：Relay 配置、SMTP 配置各有独立 store；公开 GET 响应由 store/service 负责脱敏。
- **XHS-API-010 [HEAD]**：Relay supervisor 在服务启动后监控连接；手工 connect/recover/setup/login 路由提供用户恢复动作。

## AI 与候选人 Profile

| 方法   | 路径                                | 已提交行为                           |
| ------ | ----------------------------------- | ------------------------------------ |
| GET    | `/api/ai/providers`                 | provider catalog 与配置状态          |
| GET    | `/api/ai/local-models`              | 本地模型运行状态/目录                |
| POST   | `/api/ai/local-models/install`      | 安装选定本地模型                     |
| POST   | `/api/ai/models`                    | 从 provider `/models` 发现模型       |
| POST   | `/api/ai/sessions`                  | 建立临时模型 session                 |
| POST   | `/api/ai/sessions/:sessionId/probe` | 发真实 READY 探测                    |
| DELETE | `/api/ai/sessions/:sessionId`       | 删除内存 session                     |
| GET    | `/api/profiles`                     | 列出候选人 profiles                  |
| POST   | `/api/profiles/import`              | 传入背景文件并用当前 AI session 解析 |

- **XHS-API-011 [HEAD]**：Profile import 接受 1-8 个文件，单文件默认上限 12 MiB；格式由 ProfileStore 白名单控制。
- **XHS-API-012 [HEAD]**：AI session 的公共表示包含 id/provider/model/baseUrl/wireApi/expiresAt，不返回 apiKey。
- **XHS-API-013 [HEAD]**：probe 同时验证网络、endpoint、协议、模型文本，并返回 latency；默认最多 3 次 transport attempt。

## 本地数据生命周期

| 方法 | 路径                          | 已提交行为               |
| ---- | ----------------------------- | ------------------------ |
| GET  | `/api/data/ownership`         | 描述本地数据域与拥有关系 |
| POST | `/api/data/deletions/preview` | 删除预览，不执行删除     |
| POST | `/api/data/deletions/execute` | 执行已描述删除           |
| GET  | `/api/data/retention`         | 读取保留策略             |
| PUT  | `/api/data/retention`         | 更新保留策略             |
| POST | `/api/data/retention/cleanup` | dry-run 或执行过期清理   |

- **XHS-API-014 [HEAD]**：删除审计默认写入 `data/deletion-audit.jsonl`，保留策略默认写 `data/data-retention.json`。
- **XHS-API-015 [HEAD]**：应用启动与 24 小时 timer 均会调用 retention cleanup。

## Job 创建、控制、恢复与事件

| 方法 | 路径                                      | 已提交行为                       |
| ---- | ----------------------------------------- | -------------------------------- |
| GET  | `/api/jobs`                               | 紧凑 Job 历史                    |
| POST | `/api/jobs`                               | 创建逻辑 Job                     |
| POST | `/api/body-imports`                       | 从已有正文卡片创建 body-only Job |
| GET  | `/api/jobs/:jobId`                        | 完整 Job 快照                    |
| GET  | `/api/jobs/:jobId/experience-snapshot`    | WorkflowSnapshotV3               |
| GET  | `/api/jobs/:jobId/issues`                 | 用户问题列表与 sequence          |
| GET  | `/api/jobs/:jobId/technical-diagnostics`  | 任务技术诊断                     |
| POST | `/api/jobs/:jobId/actions/retry-stage`    | 按 stage 重试                    |
| POST | `/api/jobs/:jobId/actions/check-recovery` | 立即检查恢复条件                 |
| POST | `/api/jobs/:jobId/actions/open-login`     | 打开登录恢复页                   |
| POST | `/api/jobs/:jobId/resume`                 | 原逻辑 Job 新 attempt 续跑       |
| POST | `/api/jobs/:jobId/complete-missing`       | 补齐缺失内容                     |
| POST | `/api/jobs/:jobId/cancel`                 | 取消活动 Job                     |
| GET  | `/api/jobs/:jobId/events`                 | Job SSE，支持游标                |
| GET  | `/api/jobs/:jobId/logs`                   | bounded log 输出                 |
| GET  | `/api/jobs/:jobId/results`                | 分页/过滤结果                    |
| GET  | `/api/jobs/:jobId/media?url=`             | HTTPS 图片代理与任务内缓存       |
| GET  | `/api/jobs/:jobId/artifacts`              | Artifact inventory               |
| GET  | `/api/jobs/:jobId/artifacts/:artifactId`  | 隔离下载                         |

- **XHS-API-016 [HEAD]**：Job SSE 事件由 JobManager journal 产生，前端 API 使用 `EventSource` 并携带 credentials。
- **XHS-API-017 [HEAD]**：架构文档列出的客户端事件语义包括 `snapshot`、`status`、`log`、`artifacts`、`done`、`error`。
- **XHS-API-018 [HEAD]**：事件 journal 内存最多保留 2,000 条，磁盘恢复读取最多 8 MiB 尾部；分页默认上限在 manager 层控制。
- **XHS-API-019 [HEAD]**：media proxy 仅接受满足白名单校验的 HTTPS 图片 URL，单媒体最多 15 MiB，请求 timeout 15 秒，并缓存到当前 Job `.media-cache`。

## 受众、帖子 AI 与关系扩展

| 方法 | 路径                                                                 | 已提交行为                              |
| ---- | -------------------------------------------------------------------- | --------------------------------------- |
| GET  | `/api/jobs/:jobId/audience`                                          | 受众 posts/comments/users 分页结果      |
| POST | `/api/jobs/:jobId/audience/resume`                                   | 恢复受众采集                            |
| POST | `/api/jobs/:jobId/audience/recover-rate-limit`                       | 跳过剩余 cooldown 并探测                |
| POST | `/api/jobs/:jobId/audience/grow`                                     | 增长受众覆盖                            |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/ai`                         | 帖子 AI 当前状态                        |
| POST | `/api/jobs/:jobId/audience/posts/:postId/ai/preview`                 | AI 输入预览                             |
| POST | `/api/jobs/:jobId/audience/posts/:postId/ai/runs`                    | 新建 AI run                             |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/ai/events`                  | 帖子 AI SSE                             |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/ai/results`                 | 最新结果                                |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId`             | run 状态                                |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/results`     | 指定 run 结果                           |
| POST | `/api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/cancel`      | 取消 run                                |
| POST | `/api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/resume`      | 恢复 run                                |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/comments/:commentId/anchor` | 评论证据 anchor                         |
| GET  | `/api/jobs/:jobId/audience/posts/:postId/users/:userId/anchor`       | 用户证据 anchor                         |
| GET  | `/api/jobs/:jobId/expansion`                                         | 扩展快照，支持 kind/offset/limit/filter |
| POST | `/api/jobs/:jobId/expansion/start`                                   | 启动扩展                                |
| POST | `/api/jobs/:jobId/expansion/attempts`                                | 创建扩展 attempt                        |
| POST | `/api/jobs/:jobId/expansion/resume`                                  | 恢复扩展                                |
| POST | `/api/jobs/:jobId/expansion/cancel`                                  | 取消扩展                                |

- **XHS-API-020 [HEAD]**：Audience AI 是可选 service；未启用、Job/Post/Run/Result/Anchor 不存在时映射为 404 类错误。
- **XHS-API-021 [HEAD]**：anchor 路由把评论/用户实体定位到可复核来源；Data Copilot 也通过 context source ID 绑定记录。

## 应用草稿、附件、投递与批次

| 方法   | 路径                                                                    | 已提交行为                       |
| ------ | ----------------------------------------------------------------------- | -------------------------------- |
| GET    | `/api/jobs/:jobId/application-delivery-candidates`                      | 分页候选投递记录                 |
| GET    | `/api/jobs/:jobId/contact-resolution`                                   | 联系方式消歧状态                 |
| POST   | `/api/jobs/:jobId/contact-resolution`                                   | 运行/更新联系人解析              |
| POST   | `/api/jobs/:jobId/delivery`                                             | 写 delivery action               |
| POST   | `/api/jobs/:jobId/draft`                                                | 保存 immutable 新版本            |
| POST   | `/api/jobs/:jobId/draft/rewrite`                                        | AI 改写                          |
| POST   | `/api/jobs/:jobId/draft/quality`                                        | 对精确版本/hash 复核             |
| POST   | `/api/jobs/:jobId/application-generation/writeback`                     | 回写生成结果                     |
| GET    | `/api/jobs/:jobId/application-attachments`                              | 列附件                           |
| POST   | `/api/jobs/:jobId/application-attachments`                              | 上传附件                         |
| POST   | `/api/jobs/:jobId/application-attachments/from-artifact`                | 从 Job Artifact 建附件           |
| POST   | `/api/jobs/:jobId/application-attachments/from-cover-letter`            | 从 Cover Letter 建附件           |
| POST   | `/api/jobs/:jobId/application-attachments/from-profile`                 | 从 Profile source 建附件         |
| GET    | `/api/jobs/:jobId/application-attachments/:id/content`                  | 附件下载                         |
| PATCH  | `/api/jobs/:jobId/application-attachments/:id`                          | 更新附件元数据                   |
| DELETE | `/api/jobs/:jobId/application-attachments/:id`                          | 删除附件                         |
| POST   | `/api/jobs/:jobId/send-email/preview`                                   | 精确 envelope/附件 bundle 预览   |
| POST   | `/api/jobs/:jobId/send-email`                                           | 经过版本、hash、SMTP、幂等门发送 |
| POST   | `/api/jobs/:jobId/application-batches/dry-run`                          | 批次预检                         |
| GET    | `/api/jobs/:jobId/application-batches`                                  | 列批次                           |
| POST   | `/api/jobs/:jobId/application-batches`                                  | 创建批次                         |
| GET    | `/api/jobs/:jobId/application-batches/:batchId`                         | 批次状态                         |
| GET    | `/api/jobs/:jobId/application-batches/:batchId/events`                  | 批次 SSE                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/approve`                 | 批次批准                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/start`                   | 启动批次                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/resume`                  | 恢复批次                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/pause`                   | 暂停批次                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/cancel`                  | 取消批次                         |
| POST   | `/api/jobs/:jobId/application-batches/:batchId/items/:itemId/reconcile` | 人工核对未知结果                 |

- **XHS-API-022 [HEAD]**：单批最大 100 条，默认最小发送间隔 1,000 ms，上限 60,000 ms，preflight plan TTL 30 分钟。
- **XHS-API-023 [HEAD]**：批次状态与 item 状态由服务端状态机校验；`sending` 可转 `sent`、`failed_retryable` 或 `unknown_manual_review`。
- **XHS-API-024 [HEAD]**：邮件 preview 生成 preview revision 与 attachment bundle hash，send 需要提交相同绑定与 idempotency key。
- **XHS-API-025 [HEAD]**：草稿发送前要求 exact version、content hash 与 quality report 一致；编辑会产生新 immutable version 并把质量置为 stale。

## Data Copilot HTTP

证据：`server/data-copilot-http.mjs`。

| 方法             | 路径                                                                                    | 已提交行为                                   |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| GET              | `/api/copilot/capabilities`                                                             | protocol/runtime/tool 能力                   |
| GET              | `/api/copilot/tools?query=&limit=`                                                      | 统一工具目录搜索                             |
| GET              | `/api/copilot/v1/executions`                                                            | durable executions 列表                      |
| GET              | `/api/copilot/v1/executions/:id`                                                        | execution                                    |
| GET              | `/api/copilot/v1/executions/:id/steps`                                                  | steps                                        |
| GET              | `/api/copilot/v1/executions/:id/artifacts`                                              | execution artifacts                          |
| GET              | `/api/copilot/v1/executions/:id/events`                                                 | execution events                             |
| POST             | `/api/copilot/v1/executions/:id/cancel`                                                 | durable cancellation                         |
| GET/POST         | `/api/copilot/projects`                                                                 | project 列表/创建                            |
| GET/PATCH        | `/api/copilot/projects/:projectId`                                                      | project 读取/更新                            |
| GET/POST         | `/api/copilot/projects/:projectId/workspaces`                                           | workspace 列表/创建                          |
| GET/DELETE       | `/api/copilot/projects/:projectId/workspaces/:workspaceId`                              | workspace 读取/删除                          |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/lease/acquire`                | 获取 lease                                   |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/lease/release`                | 释放 lease                                   |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/tools/:toolName`              | workspace-bound tool                         |
| GET              | `/api/copilot/projects/:projectId/workspaces/:workspaceId/tool-executions/:id`          | tool execution                               |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/tool-executions/:id/cancel`   | cancel tool                                  |
| GET/POST         | `/api/copilot/projects/:projectId/workspaces/:workspaceId/terminals`                    | terminals list/create                        |
| GET              | `/api/copilot/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId`        | terminal state                               |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/input`  | terminal input                               |
| POST             | `/api/copilot/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/cancel` | terminal cancel                              |
| GET/POST         | `/api/copilot/mcp/servers`                                                              | outbound MCP config list/create              |
| POST             | `/api/copilot/mcp/refresh`                                                              | refresh all MCP servers                      |
| PUT/DELETE       | `/api/copilot/mcp/servers/:serverId`                                                    | update/delete MCP server                     |
| POST             | `/api/copilot/mcp/servers/:serverId/refresh`                                            | refresh one server                           |
| GET              | `/api/copilot/usage`                                                                    | token/tool/latency usage                     |
| GET              | `/api/copilot/traces`                                                                   | traces                                       |
| GET              | `/api/copilot/snapshots`                                                                | snapshots                                    |
| GET              | `/api/copilot/snapshots/diff`                                                           | snapshot diff                                |
| GET              | `/api/copilot/snapshots/:jobId/:snapshotId`                                             | snapshot detail                              |
| GET              | `/api/copilot/evaluations`                                                              | evaluation history                           |
| POST             | `/api/copilot/evaluations/golden`                                                       | golden evaluation                            |
| POST             | `/api/copilot/workbench/tools/:toolName`                                                | 执行一个工具                                 |
| POST             | `/api/copilot/workbench/runs`                                                           | 执行 DAG run                                 |
| GET              | `/api/copilot/runs/:runId/events`                                                       | run event filter/replay                      |
| GET              | `/api/copilot/context`                                                                  | context catalog                              |
| GET              | `/api/copilot/context/jobs`                                                             | Job context sources                          |
| GET/POST         | `/api/copilot/conversations`                                                            | 会话列表/创建                                |
| GET/PATCH/DELETE | `/api/copilot/conversations/:id`                                                        | 会话读/改/删                                 |
| GET/POST         | `/api/copilot/conversations/:id/messages`                                               | 消息列表/发送                                |
| POST             | `/api/copilot/conversations/:id/subagent-runs`                                          | delegate subagent                            |
| GET              | `/api/copilot/conversations/:id/runs`                                                   | 会话 runs                                    |
| GET              | `/api/copilot/conversations/:id/events`                                                 | SSE 或 JSON replay                           |
| GET              | `/api/copilot/conversations/:id/context`                                                | working context                              |
| GET/POST         | `/api/copilot/conversations/:id/context-pins`                                           | pins 列表/创建                               |
| DELETE           | `/api/copilot/conversations/:id/context-pins/:pinId`                                    | 删除 pin                                     |
| GET              | `/api/copilot/conversations/:id/runs/:runId`                                            | run state                                    |
| POST             | `/api/copilot/conversations/:id/runs/:runId/{pause,resume,cancel,steer}`                | run 控制                                     |
| POST             | `/api/copilot/conversations/:id/verify`                                                 | 回答证据验证                                 |
| POST             | `/api/copilot/conversations/:id/mcp`                                                    | 旧 JSON-RPC adapter，已标 Deprecation/Sunset |
| POST             | `/api/copilot/conversations/:id/cancel`                                                 | cancel 当前执行                              |
| POST             | `/api/copilot/conversations/:id/retry`                                                  | retry                                        |
| POST             | `/api/copilot/conversations/:id/attachments`                                            | multipart 上传                               |
| GET/HEAD         | `/api/copilot/conversations/:id/attachments/:attachmentId`                              | 文件读取                                     |
| POST             | `/api/copilot/conversations/:id/artifacts`                                              | 创建 Artifact                                |
| GET/HEAD         | `/api/copilot/conversations/:id/artifacts/:artifactId`                                  | Artifact 读取                                |
| POST             | `/api/copilot/conversations/:id/snapshot/upgrade`                                       | 升级绑定快照                                 |
| POST             | `/api/copilot/conversations/:id/approvals/:approvalId/confirm`                          | 确认审批                                     |

- **XHS-API-026 [HEAD]**：旧 conversation MCP 路由设置 `Deprecation: true`、Sunset `2026-12-01` 和 successor link `/mcp`。
- **XHS-API-027 [HEAD]**：Copilot SSE heartbeat 为 15 秒，待发送 frame 队列最多 1,000 条；慢客户端会被主动结束。
- **XHS-API-028 [HEAD]**：附件/Artifact GET 同时支持 HEAD，便于客户端验证 metadata 与 range/下载契约。

## MCP 管理面与独立数据面

| 方法            | 路径                                      | 已提交行为               |
| --------------- | ----------------------------------------- | ------------------------ |
| GET             | `/api/mcp/status`                         | 管理面状态               |
| GET             | `/api/mcp/capabilities`                   | 绑定 conversation 的能力 |
| GET/POST        | `/api/mcp/grants`                         | 列出/创建 Grant          |
| GET/DELETE      | `/api/mcp/grants/:grantId`                | 读取/撤销 Grant          |
| POST            | `/api/mcp/grants/:grantId/revoke`         | 显式撤销                 |
| POST            | `/api/mcp/grants/:grantId/rotate`         | 新 Token + 撤销旧 Grant  |
| POST            | `/api/mcp/grants/:grantId/rebind`         | 绑定新 snapshot/scope    |
| GET             | `/api/mcp/grants/:grantId/audit`          | Grant 审计               |
| GET             | `/api/mcp/sessions`                       | owner 可见 sessions      |
| GET             | `/api/mcp/tool-runs`                      | owner 可见 tool runs     |
| GET             | `/api/mcp/audit`                          | owner 审计               |
| POST            | `/api/mcp/approvals/:approvalId/decision` | 精确 action 审批决定     |
| GET             | `http://127.0.0.1:4328/health`            | MCP 数据面健康           |
| GET/POST/DELETE | `http://127.0.0.1:4328/mcp`               | Streamable HTTP MCP      |

- **XHS-API-029 [HEAD]**：MCP 管理面 query `limit` 默认 100，约束到 1-500。
- **XHS-API-030 [HEAD]**：数据面只允许 GET/POST/DELETE；创建有状态 session 的首个 POST 需要 initialize request。
- **XHS-API-031 [HEAD]**：已有 session 通过 `Mcp-Session-Id` 定位并再次验证它属于当前 Grant。
- **XHS-API-032 [HEAD]**：开启匿名 public showcase 且未带 Authorization 时，showcase 使用 stateless POST，不接受 session ID。

## 当前工作树新增路由（W/U）

- **XHS-API-033 [W/U]**：当前修改为 `/codex` 与 `/codex/*` 增加官方 webview 静态入口，并增加 native mirror HTML/JS/CSS 静态资源。
- **XHS-API-034 [W/U]**：新增 `/api/codex-desktop/status|launch`，对应本地 Desktop runtime 探测与启动。
- **XHS-API-035 [W/U]**：新增 `/api/xhs-context/mcp|status|bundles|bundles/from-job` 及 bundle overview/search/verify/record/artifact/aggregate/cite 动态路由。
- **XHS-API-036 [W/U]**：新增 `/api/codex-product/mcp|status` 产品级 MCP/status 入口。
- **XHS-API-037 [W/U]**：新增 `/api/codex-native-mirror/status|sessions/...`，覆盖 session、input-target、input 和 signaling 动作。
- **XHS-API-038 [W/U]**：新增 `/api/codex-connect/manifest|installer|intents|devices/...`，覆盖 intent claim、设备 health/reconnect/repair/rollback/revoke。
- **XHS-API-039 [W/U]**：新增 `/api/codex-relay/status|gateway/status|devices|pair|pairing-intents|device-claims|sessions|invites`。
- **XHS-API-040 [W/U]**：relay 动态 session 路由覆盖 connect、read/delete、lease renew/release、events、stream-ticket、messages、worker-messages。
- **XHS-API-041 [W/U]**：新增 `/api/codex-browser/status|events|messages|worker-messages` 作为浏览器 host transport。
- **XHS-API-042 [W/U]**：这些路由来自 `server/app.mjs` 的未提交约 729 行新增与一组未跟踪 service，面试中应称为“当前工作树实验”。
