# 主仓库运行默认值、限制与端口事实

来源：当前工作树 server/config.mjs、vite.config.ts、.env.example 和 .env.production.example。配置文件当前有未提交修改；以下是 2026-08-18 工作区事实，不等同于 v3.0 tag 的原始值。

## 服务与端口

| 项目                    |                    默认值 | 来源/说明                              |
| ----------------------- | ------------------------: | -------------------------------------- |
| Node API host           |                 127.0.0.1 | HOST；空值回退 loopback                |
| Node API 开发端口       |                      4317 | PORT 默认值、.env.example              |
| Vite 开发端口           |                      5173 | vite.config.ts                         |
| Vite API proxy          |     http://127.0.0.1:4317 | 可由 VITE_API_PROXY/VITE_API_PORT 覆盖 |
| 生产示例端口            |                      4327 | .env.production.example                |
| MCP host                |                 127.0.0.1 | 只接受 127.0.0.1、localhost、::1       |
| MCP 端口                |                      4328 | XHS_MCP_PORT                           |
| 本地模型端点            |    http://127.0.0.1:11434 | 只接受 HTTPS 或 loopback HTTP          |
| OCR 示例端点            | http://127.0.0.1:11434/v1 | .env.example                           |
| OCR dedicated 示例端点  |    http://127.0.0.1:11435 | .env.example                           |
| SMTP 默认端口           |                       587 | STARTTLS 场景                          |
| Cloudflare metrics 示例 |           127.0.0.1:20242 | 生产示例                               |
| Relay/CDP 常见端口      |                     18800 | Relay/浏览器相关代码与文档             |

## MCP 默认限制

| 配置                                            |    默认值 | 允许范围/说明    |
| ----------------------------------------------- | --------: | ---------------- |
| XHS_MCP_ENABLED                                 |      true | 默认启用         |
| XHS_MCP_PUBLIC_SHOWCASE_MAX_BODY_BYTES          |    65,536 | 1,024 到 262,144 |
| XHS_MCP_PUBLIC_SHOWCASE_MAX_CALLS_PER_MINUTE    |        60 | 1 到 1,000       |
| XHS_MCP_PUBLIC_SHOWCASE_MAX_CONCURRENT_REQUESTS |         4 | 1 到 32          |
| XHS_MCP_MAX_BODY_BYTES                          | 1,048,576 | 1 KiB 到 8 MiB   |
| XHS_MCP_MAX_OUTPUT_BYTES                        | 2,097,152 | 1 KiB 到 16 MiB  |
| XHS_MCP_TOOL_TIMEOUT_MS                         |   120,000 | 1 秒到 15 分钟   |
| XHS_MCP_MAX_CONCURRENT_TOOLS_PER_GRANT          |         4 | 1 到 32          |
| XHS_MCP_MAX_CALLS_PER_MINUTE                    |       120 | 1 到 10,000      |
| XHS_MCP_SESSION_IDLE_SECONDS                    |     1,800 | 30 秒到 24 小时  |
| XHS_MCP_MAX_SESSIONS                            |        20 | 1 到 200         |
| XHS_MCP_MAX_SESSIONS_PER_GRANT                  |         4 | 1 到 32          |

## Data Copilot 默认限制

| 配置                         |                                               默认值 | 范围/行为                       |
| ---------------------------- | ---------------------------------------------------: | ------------------------------- |
| XHS_COPILOT_APPROVAL_MODE    | 开发 loopback 为 never；生产/非 loopback 为 required | required、workspace_auto、never |
| XHS_COPILOT_EXEC_TIMEOUT_MS  |                                               30,000 | 50ms 到 5 分钟                  |
| XHS_COPILOT_HTTP_TIMEOUT_MS  |                                               30,000 | 50ms 到 5 分钟                  |
| XHS_COPILOT_MAX_OUTPUT_BYTES |                                              262,144 | 1 KiB 到 8 MiB                  |

## Codex Relay/Device 默认限制

| 配置                     | 默认值 | 范围/说明                   |
| ------------------------ | -----: | --------------------------- |
| TURN credential TTL      | 600 秒 | 60 到 3,600 秒              |
| Device gateway heartbeat |  15 秒 | 5 到 60 秒                  |
| Connector version        |  1.1.0 | installer 默认同版本 ZIP    |
| ICE server JSON          | 空数组 | readJsonArray 最多保留 8 项 |
| TURN URL JSON            | 空数组 | readJsonArray 最多保留 8 项 |

## OCR 与 Audience AI

| 配置                       | 默认值 | 范围/说明         |
| -------------------------- | -----: | ----------------- |
| Contact OCR enabled        |   true | 总开关            |
| Contact OCR auto enabled   |   true | 自动触发          |
| OCR timeout                | 180 秒 | 30 到 600         |
| OCR checkpoint every       |      5 | 1 到 50           |
| OCR max attempts           |      2 | 1 到 3            |
| OCR concurrency            |      2 | 1 到 8            |
| OCR prefetch concurrency   |     12 | 1 到 32           |
| OCR image batch            |      4 | 1 到 4            |
| OCR context tokens         |  4,096 | 2,048 到 8,192    |
| OCR output tokens          |    256 | 128 到 2,048      |
| OCR keep alive             |    60m | 字符串配置        |
| Audience AI enabled        |  false | 生产示例改为 true |
| Audience AI max concurrent |      2 | 1 到 8            |

## Auth、请求与附件

| 配置          |              默认值 | 范围/行为                        |
| ------------- | ------------------: | -------------------------------- |
| Auth required |  production 时 true | 生产示例显式 false，属于部署选择 |
| Secure cookie |  production 时 true | 可覆盖                           |
| Session TTL   | 28,800 秒（8 小时） | 300 秒到 7 天                    |
| 最大请求体    |              32 MiB | 1 KiB 到 64 MiB                  |
| 最大附件数    |                   5 | 1 到 20                          |
| 单附件最大    |              10 MiB | 1 KiB 到 64 MiB                  |
| 附件总量最大  |              20 MiB | 1 KiB 到 128 MiB                 |

## Relay supervision

| 配置               | 默认值 | 范围          |
| ------------------ | -----: | ------------- |
| Monitor interval   |  15 秒 | 2 秒到 300 秒 |
| Auto connect       |   true | 布尔值        |
| Failure threshold  |      2 | 1 到 10       |
| Recovery cooldown  |  60 秒 | 5 秒到 900 秒 |
| Connect timeout    |  25 秒 | 1 秒到 120 秒 |
| Playwright timeout |  60 秒 | 1 秒到 180 秒 |

## URL 校验事实

- MCP public URL 必须是无凭证、无路径、无 query/fragment 的 HTTPS origin，并且主机不得是 loopback。
- XHS_CODEX_CONNECT_ALLOWED_ORIGINS 只接受逗号分隔的 HTTP(S) origin，不得带 path/query/fragment。
- 本地模型端点只接受 HTTPS，或 127.0.0.1/localhost/::1 上的 HTTP。
- Auth origin 在启用认证时必须配置；非 loopback 环境要求 HTTPS。
- SMTP auth 只接受 auto、login、oauth2、none。

## 事实边界

- 这些值是配置默认值和输入范围，不是性能、吞吐或安全认证结果。
- 生产示例中的 public host 是示例部署配置，不证明该域名当前在线。
