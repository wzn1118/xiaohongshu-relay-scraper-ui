# ADR: MCP 采用本机双监听器与会话快照 Grant

- 状态：Superseded in part（双监听器继续有效；“公网不可到达 MCP”由 `ADR-MCP-CLOUDFLARE-PUBLIC-DATA-PLANE.md` 替代）
- 日期：2026-08-09
- 决策范围：`xiaohongshu-relay-scraper-ui` R1 MCP 接入

## 背景

现有应用监听 `127.0.0.1:4327`，并通过 Cloudflare Tunnel 暴露 Web UI 和应用 API。应用已有 Data Copilot、工具注册表、审批状态机、任务快照、生产 SQLite、Cookie 登录和 Origin/CSRF 防护。MCP 需要复用这些能力，但其本地客户端使用 Bearer 凭证和 MCP session；若直接复用公网应用监听器，会把新的机器调用入口意外纳入现有 Tunnel 边界。

## 决策

1. 同一 Node 进程创建两个监听器：Web/API 保持 `127.0.0.1:4327`，标准 MCP Streamable HTTP 固定为 `127.0.0.1:4328/mcp`。
2. `4328` 强制 loopback、拒绝浏览器 Origin、校验 Host，并且不写入 Cloudflare ingress。
3. MCP wire protocol 使用锁定版本的 `@modelcontextprotocol/sdk@1.30.0`；领域资源和工具继续由现有适配器、注册表和策略引擎提供。
4. Web 管理面继续使用应用 Cookie、Origin 和用户身份；MCP 数据面只接受一次性展示的 Bearer Grant token。数据库仅持久化带 pepper 的 token 摘要。
5. 每个 Grant 固定绑定 `owner + conversationId + jobId + snapshotId + manifestHash + mode + scopes + resources + tools + maxRisk + expiresAt`。每次认证重新加载并校验快照，revision 或内容哈希改变后旧 Grant 失败，不自动漂移到最新数据。
6. 写入或外发工具复用 Copilot 审批状态机。审批绑定完整 `actionHash`，摘要覆盖 Grant、快照、manifest、工具名、工具版本和规范化参数；执行前重新计算并比对。
7. session、调用频率、并发、请求体、运行超时和输出大小均由服务端限制。默认工具/资源输出上限为 2 MiB，普通工具超限失败，资源返回有界摘要；已批准副作用完成后的大结果返回有界执行摘要，避免把已发生的动作误报成未执行。
8. stdio 仅作为本地 Streamable HTTP 的协议桥，不直接初始化业务服务或读取数据目录。生产环境优先从 `XHS_MCP_TOKEN_FILE` 读取 Grant。
9. 还原备份和制作含数据的便携包时，默认撤销数据库中的 active Grant 并关闭 session；pepper 不进入发布包。需要重新签发并单独分发 token。

## 结果

- 应用与 MCP 共享一个领域运行时、一个 `JobManager` 和一个生产存储，避免状态分叉。
- 现有公网入口不获得 MCP 能力；本机客户端可使用标准 SDK 和标准 session 生命周期。
- Grant 无法越过创建时的数据、scope、资源、工具和风险边界，且审批决定只适用于完全相同的动作。
- 运维需要同时监测两个本机健康端点；进程退出会终止所有传输 session，客户端随后重新 initialize。
- R1 不支持公网 MCP、多节点 session 共享、OAuth 受保护资源元数据、历史快照永久保留和 prompts/subscriptions。这些能力需要新的安全与存储 ADR。

## 被否决的方案

### 在 `4327` 增加 `/mcp`

该端口已进入公网 Tunnel，路径级遗漏就可能公开机器接口；Cookie 与 Bearer 的鉴权模型也会混在同一入口。因此不采用。

### stdio 直接读取业务数据

这会形成第二套初始化、策略和存储路径，无法保证审批、快照和审计一致。因此 stdio 只代理标准 HTTP 服务。

### 长期 API key 或自动跟随最新 revision

长期 key 扩大泄露窗口；自动跟随 revision 会在没有新授权的情况下改变可见数据。R1 使用有过期时间、可撤销、可轮换并绑定快照的 Grant。

## 验证要求

- 官方 SDK 必须完成 initialize、resources/list、resources/read、tools/list、tools/call 和 session close。
- 必须覆盖 token 一次展示、撤销、轮换、owner 隔离、stale snapshot、actionHash 篡改、幂等冲突、并发/频率/大小限制和恢复撤销。
- `scripts/verify-mcp-production.mjs` 必须在运行服务上完成健康检查和标准 SDK 资源/工具发现，输出中不得出现 token 或业务资源 URI。
- 生产启动、watchdog、停止、打包、备份和恢复必须保持双监听器及凭证边界。
