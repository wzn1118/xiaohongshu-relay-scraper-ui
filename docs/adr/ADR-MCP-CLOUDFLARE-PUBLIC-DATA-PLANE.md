# ADR: Cloudflare 公网 MCP 数据面

- 状态：Accepted，匿名入口行为由 `ADR-MCP-ANONYMOUS-SHOWCASE.md` 修订
- 日期：2026-08-10
- 替代：`ADR-MCP-LOCAL-DUAL-LISTENER.md` 中“公网不可到达 MCP”的限制
- 适用范围：`xiaohongshu-relay-scraper-ui` 单机生产部署

## 背景

项目已经用同一 Node 主进程承载 Web/API 和标准 MCP，但通过两个回环监听器隔离协议与鉴权：Web/API 使用 `127.0.0.1:4327`，MCP 使用 `127.0.0.1:4328`。MCP 数据面使用一次展示、可撤销、绑定 owner、conversation、job、snapshot、manifest、scope、resource、tool、risk 和过期时间的 Bearer Grant，不接受浏览器 Cookie。

用户需要让远程 AI 客户端通过公网 HTTPS 使用 MCP，同时保留双监听器、唯一状态拥有者和 Grant 边界。

## 决策

1. MCP 源站仍只绑定 `127.0.0.1:4328`，不直接监听公网网卡。
2. 复用专用远程托管 Tunnel `hegelsalon-relay`，但为 MCP 使用独立 hostname：`mcp.hegelsalon.com`。Web/API 继续使用 `relay.hegelsalon.com`。
3. Cloudflare ingress 精确映射：
   - `relay.hegelsalon.com -> http://127.0.0.1:4327`
   - `mcp.hegelsalon.com -> http://127.0.0.1:4328`
   - 其他 hostname -> `http_status:404`
4. MCP 源站接受两类请求：
   - 本机请求：精确 loopback Host；
   - 公网 Tunnel 请求：精确 `mcp.hegelsalon.com` Host、`X-Forwarded-Proto: https`、存在 `CF-Ray` 与 `CF-Connecting-IP`，且不带浏览器 `Origin`。
5. 公网请求不带 `Authorization` 时进入完全隔离的合成只读展示；携带有效 `Authorization: Bearer <Grant>` 时进入私有数据面；只要认证头存在但错误、过期或格式不正确就返回 401，绝不降级为匿名展示。token 不进入 URL、query string、Cookie、日志、发布 ZIP 或 Tunnel 配置。
6. 管理面继续位于 Web/API：用户登录后在 Data Copilot 创建、轮换、撤销或重新绑定 Grant。公网 MCP hostname 不提供管理 API、静态前端或浏览器登录。
7. 生产 launcher、watchdog 和 state 同时检查本地 MCP 与公网 MCP 健康；Tunnel token 继续存放于发布目录之外。
8. 恢复备份、迁移含数据便携包或执行显式撤销时，active Grant 和 session 必须失效；恢复后的客户端必须领取新 token。

## 安全边界

- `4327/mcp` 不存在；Web hostname 不能访问 MCP 协议路由。
- `4328` 不提供 `/api/*`、登录 Cookie 或静态资源。
- 仅伪造 Host 不足以进入公网分支；缺少 HTTPS 转发和 Cloudflare 标识头时源站拒绝。
- 浏览器 Origin、query token、错误 hostname、明文 HTTP 转发和撤销或错误 Bearer 均被拒绝；无认证头只能访问静态合成资源和确定性只读工具。
- Cloudflare 终止 TLS；源站根据可信 Tunnel 连接携带的边界头校验公网请求。该单机设计不支持任意反向代理直连。

## 运维结果

- 公网 MCP endpoint：`https://mcp.hegelsalon.com/mcp`
- 健康端点：`https://mcp.hegelsalon.com/health`
- 本机 MCP endpoint：`http://127.0.0.1:4328/mcp`
- 标准客户端使用 Streamable HTTP；匿名客户端只能使用展示资源和工具，私有任务数据必须使用独立 Grant。
- Cloudflare zone 级 `Always Use HTTPS` 是纵深配置；即使当前 API token 无 zone-setting 权限，MCP 源站仍拒绝 `X-Forwarded-Proto` 非 HTTPS 的请求。

## 验收要求

1. 不带认证头的官方 SDK 经公网完成 initialize、resources/list、resources/read 和 tools/call，并且只能发现 `showcase://` 与 `showcase.*`。
2. 浏览器 GET `/mcp` 返回 200 和 `anonymous-read-only-showcase`；错误认证头返回 401；公网 HTTP 请求和缺少 Cloudflare 头的伪造公网 Host 返回 403。
3. 撤销 Grant 后，同一公网 token 不能再次 initialize。
4. 验收报告不得包含完整 token、Cookie、资源 URI 或业务正文。
5. 公网验证结束后必须恢复正式生产进程，并确认 active Grant 与 active session 均为 0。

## 不采用的方案

### 把标准 MCP 挂到 `relay.hegelsalon.com/mcp`

这会混合 Cookie 管理面与 Bearer 数据面，并扩大应用 listener 的路由与中间件表面，因此保留独立 hostname 和 listener。

### 让 MCP 直接监听 `0.0.0.0`

这会绕过 Tunnel 的 TLS 和 hostname 边界，因此源站保持 loopback-only。

### 使用长期共享 API key

长期 key 不绑定任务快照、工具和风险范围。当前实现只使用短期、可撤销、可轮换的 snapshot-bound Grant。
