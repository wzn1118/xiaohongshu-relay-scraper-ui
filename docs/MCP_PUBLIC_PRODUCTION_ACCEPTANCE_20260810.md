# MCP 公网生产验收记录

> 项目：`xiaohongshu-relay-scraper-ui`
> 验收日期：`2026-08-10`
> 应用版本：`3.0.0`
> MCP SDK：`@modelcontextprotocol/sdk@1.30.0`

## 1. 验收范围

本记录覆盖当前工作树的标准 MCP 协议、Grant 控制面、独立公网数据面、Cloudflare Tunnel、Web/API 回归、UI 用户流程、Windows 便携运行时、发布包排除规则以及备份恢复后的 Grant 撤销边界。HTTP 端口可达不单独作为完成证据。

## 2. 公网生产状态

| 项目 | 验收值 |
|---|---|
| 应用入口 | `https://relay.hegelsalon.com` |
| MCP endpoint | `https://mcp.hegelsalon.com/mcp` |
| MCP health | `https://mcp.hegelsalon.com/health` |
| Web/API origin | `127.0.0.1:4327` |
| MCP origin | `127.0.0.1:4328` |
| Tunnel | `hegelsalon-relay`，ID `0228b9ee-1e2e-4138-909f-05256c51e5eb` |
| 公网匿名 MCP | 浏览器 GET HTTP 200；官方 SDK 可用 3 个合成资源和 3 个只读工具 |
| 公网错误认证 | HTTP 401；错误、过期或格式不正确的认证头不降级到匿名展示 |
| 公网明文 HTTP | HTTP 403，由源站 HTTPS 转发边界拒绝 |

当前生产进程于 `2026-08-10T10:31:28.0396089Z` 启动，Node PID 为 `64048`，复用的 Tunnel PID 为 `33604`。公网无令牌验证实际完成 Streamable HTTP 初始化、3 个 `showcase://` 资源发现与读取、3 个 `showcase.*` 只读工具发现和实际调用；`artifact.create` 被拒绝，错误 Bearer 返回 401。匿名模式无持久化 session，且只读取内置合成数据。

同一生产 endpoint 另以 5 分钟 `read` 临时 Grant 运行官方 SDK：发现 6 个许可资源和 31 个许可只读工具，资源读取及 `task.status` 调用成功；撤销后旧 Bearer 再次使用返回 401。清理后 active Grant 恢复到验证前既有基线 `1`，active session 为 `0`。此前 `.runtime/production/public-mcp-verification.json` 是匿名展示上线前的历史全量 Grant 报告，不作为本次部署结果。

## 3. 当前工作树回归

| 门禁 | 结果 |
|---|---|
| `npm test` | 646/646 通过，0 失败 |
| `npm run test:python` | 前序验收 543 通过、2 跳过；本次服务端修复后未重跑 |
| `npm run test:e2e` | 前序验收 64 通过、1 按配置跳过；本次服务端修复后未重跑 |
| MCP 专项 | 9/9 通过 |
| `npm run build:frontend` | 通过；1604 modules；主 bundle 851.93 kB |
| `npm run lint` | 通过；182 个 Node 文件及 Python 源码语法检查 |
| `npm run format:check` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run test:credentials` | 通过 |
| `npm audit --audit-level=high` | 前序验收 0 vulnerabilities；本次未重跑 |

E2E 包含桌面、平板和移动端。受众 AI 与关系扩散视图均验证无横向溢出；历史 `succeeded` 任务状态显示为“已完成”；批量投递文案编辑、服务端主题回写、启动、暂停、续跑和取消均已覆盖。

## 4. 此前发布物

此前发布物：`deliverables/hegelsalon-mcp-public-production-20260810.zip`。
完整性文件：`deliverables/hegelsalon-mcp-public-production-20260810.zip.sha256`。

该 ZIP 生成于本次匿名展示修复之前，本次没有重新打包；当前公网运行时和工作树是新的验收对象。再次对外分发 Windows 包前必须重建 ZIP，并确认包含 `server/mcp-public-showcase.mjs` 与 `scripts/verify-mcp-public-showcase.mjs`。

该此前归档在当时由 `scripts/package-windows-production.ps1` 从当时工作树生成，包含构建后的前端、完整 Node 依赖、Node.js、Python、Chromium、cloudflared 和启动/验证/备份/恢复脚本。归档明确排除 `.git`、`.runtime`、`data`、浏览器 profile、Cookie、真实任务输出、生产 `.env`、Grant token、pepper、Tunnel token/certificate 和机器凭据。

上述 SHA-256、条目数、解压后双监听器 smoke、官方 SDK 调用、撤销拒绝及备份恢复结果仅对应此前归档；第 8 节单独记录当前公网运行时的匿名直连修复结果。

## 5. 此前发布物执行记录

发布归档生成后执行以下验收：完整读取 ZIP；检查必需文件和禁止路径；解压到独立临时目录；使用包内 Node 在隔离端口启动 Web/API 与 MCP；由包内官方 SDK 客户端读取资源并调用只读工具；撤销 Grant 后确认旧 token 被拒绝；创建含 active Grant 的备份并恢复到独立数据根，确认恢复边界再次撤销该 Grant。正式生产进程与独立验收实例分别核对。

Cloudflare API token 当前不含 zone-setting 写权限，所以账户级 `Always Use HTTPS` 未由脚本修改。该限制不影响当前 HTTPS MCP；明文 HTTP 已由源站的 `X-Forwarded-Proto=https` 强制校验独立拒绝并实测为 403。

## 6. 此前发布物验收数值

| 验收项 | 最终结果 |
|---|---|
| 发布 ZIP 大小 | `841706007` bytes |
| ZIP 条目数 | `36511` |
| ZIP 解压后总字节 | `1919441670` bytes |
| ZIP SHA-256 | `074b06f21980dc94996fa2d5ffc42574647eb7f021fda9cae277c2cac037c2a7` |
| 独立解压目录 | `E:\UserData\Temp\hegelsalon-mcp-public-acceptance-20260810-074b06f2` |
| 隔离验收端口 | Web `44317`；MCP `44318`；验收后均已释放 |
| 包内官方 SDK | Streamable HTTP；6 个资源；36 个工具 |
| 资源/工具实调 | `applications` 读取成功；`task.status` 成功且 `isError=false` |
| 备份恢复 | 归档校验、恢复完成；恢复前 token 被拒绝 |
| 恢复后复验 | 替代 Grant 通过同一 SDK 全量验证，随后撤销 |
| 最终隔离状态 | active Grant `0`；active session `0` |
| 当前正式生产边界（另行复核） | 应用/MCP health `200`；匿名 MCP `200`；错误 Bearer `401`；明文 HTTP `403` |

便携发布物的机器可读验收报告位于 `.runtime/production/portable-package-verification.json`。正式公网 SDK 验收报告位于 `.runtime/production/public-mcp-verification.json`。两份报告均不包含 token、Cookie、pepper 或 Tunnel 凭据。

## 7. 此前在线可用性复核

`2026-08-10T06:34:00.7291494Z` 在**不重启生产服务**的条件下，使用生产控制面创建临时 Grant，并通过 `https://mcp.hegelsalon.com/mcp` 运行官方 SDK。实测完成 Streamable HTTP 初始化、6 个资源发现、资源读取、36 个工具发现和 `task.status` 调用；撤销 Grant 后旧 token 被立即拒绝，最终 active Grant 与 active session 均为 `0`。机器可读报告位于 `.runtime/production/live-availability-verification.json`，不记录任何 token、Cookie 或密码。

Windows 计划任务 `HegelSalon Relay Watchdog` 每 5 分钟执行一次。此前记录中的 `2026-08-10T14:36:42+08:00` 当次执行结果为 `0`，无漏跑；当次状态确认本地 Web/MCP、公网 Web/MCP、Tunnel 与 Relay 均健康，MCP 连续失败数为 `0`，且没有自动重启或 Relay 修复。

## 8. 匿名直连修复复核

`2026-08-10T10:31:28.0396089Z` 部署 PID `64048` 后，当前公网结果如下：

| 验收项 | 当前结果 |
|---|---|
| 浏览器 GET `/mcp` | HTTP 200；`anonymous-read-only-showcase` |
| 无令牌官方 SDK | 3 个合成资源；3 个只读工具；资源读取与工具调用成功 |
| 私有或写能力隔离 | `xhs-data://`、`artifact.create`、`email.send` 均未进入匿名能力面 |
| 错误认证 | 错误 Bearer HTTP 401；不回退匿名模式 |
| 有效临时 Grant | 6 个资源；31 个许可只读工具；`task.status` 成功 |
| 撤销复核 | 旧 Bearer HTTP 401；active Grant 恢复既有基线 1；active session 0 |
| 网络边界 | 公网明文 HTTP 403；伪造公网 Host 且缺 Cloudflare 头 403；匿名 SSE GET 405 |
