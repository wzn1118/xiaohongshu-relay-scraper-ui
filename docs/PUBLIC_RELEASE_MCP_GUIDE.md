# 公网发布包 MCP 使用指南

## 1. 包里已经包含什么

本发布包把 MCP 作为正式运行能力一起交付，不需要用户另装 Node.js 或 MCP SDK：

- `server/mcp-http-server.mjs`：Streamable HTTP 数据面；
- `server/mcp-public-showcase.mjs`：与生产数据完全隔离的匿名合成展示；
- `server/mcp-access-service.mjs`：Grant、Session、限流、审计和审批；
- `server/mcp-management-http.mjs`：Web 管理面的 MCP API；
- `src/McpAccessPanel.tsx`：可视化 Grant 管理界面；
- `scripts/mcp-stdio-bridge.mjs`：把本地 HTTP MCP 转换为标准 stdio；
- `@modelcontextprotocol/sdk` 及其完整依赖；
- `start-mcp.cmd`、`mcp-stdio.cmd`、`verify-mcp.cmd` 和客户端配置模板。
- `scripts/verify-mcp-public-showcase.mjs`：公网无令牌官方 SDK 验证器。

包内不携带 Grant Token、Token Pepper 或任何现有机器的 MCP 会话。这样公开 ZIP 可以分发，而访问权限必须由每台机器重新签发。

## 2. 一键启动应用与 MCP

完整解压 ZIP 后，双击：

```text
start-mcp.cmd
```

这个入口使用包内 Node.js 和 Python，启动 Web 应用与本机 MCP 服务，但不会额外打开应用浏览器窗口。默认地址为：

| 服务 | 地址 |
| --- | --- |
| Web 应用 | `http://127.0.0.1:4317`，占用时由启动器选择其他 Web 端口 |
| MCP 健康检查 | `http://127.0.0.1:4328/health` |
| MCP 数据面 | `http://127.0.0.1:4328/mcp` |

需要修改 MCP 端口时，可以从命令行运行：

```powershell
.\start-mcp.cmd -McpPort 45238
```

MCP 监听地址由服务端强制限制为 `127.0.0.1`、`localhost` 或 `::1`，不能误绑定到公网网卡。

## 3. 创建最小权限 Grant

1. 打开 Web 应用并进入“数据助手”的 MCP 管理区域；
2. 选择已经有持久化快照的任务会话；
3. 核对允许的资源、工具、Scope、风险上限和过期时间；
4. 创建 Grant；
5. 立即把只显示一次的 Token 写入解压目录之外的文件，例如 `C:\secure\today-you-applied-mcp-grant.token`；
6. 不再需要时，在管理界面撤销或轮换 Grant。

Grant 绑定任务、快照和上下文 Hash。历史状态变化后，应重新绑定或重新签发，而不是继续使用旧 Token。

## 4. 接入 stdio MCP 客户端

复制并修改：

```text
config\mcp-client.example.json
```

模板中的 `command` 要改为当前解压目录下 `mcp-stdio.cmd` 的绝对路径；`XHS_MCP_TOKEN_FILE` 要指向包外 Token 文件。客户端启动桥接时，会自动使用包内 `runtime\node\node.exe`。

可直接作为客户端配置的核心结构：

```json
{
  "mcpServers": {
    "today-you-applied": {
      "command": "C:\\today-you-applied-public-release\\mcp-stdio.cmd",
      "env": {
        "XHS_MCP_URL": "http://127.0.0.1:4328/mcp",
        "XHS_MCP_TOKEN_FILE": "C:\\secure\\today-you-applied-mcp-grant.token"
      }
    }
  }
}
```

不要把 Token 直接写进准备上传 GitHub 的配置文件。

## 5. 验证真实 MCP 协议

在 PowerShell 中设置 Token 文件并运行验证器：

```powershell
$env:XHS_MCP_TOKEN_FILE = 'C:\secure\today-you-applied-mcp-grant.token'
$env:XHS_MCP_URL = 'http://127.0.0.1:4328/mcp'
.\verify-mcp.cmd
```

验证器使用官方 SDK 建立 Streamable HTTP 会话，并实际执行：

1. `/health` 服务身份检查；
2. MCP 初始化与 Session 建立；
3. `resources/list`；
4. 首个授权资源的 `resources/read`；
5. `tools/list`；
6. 一个只读工具的 `tools/call`。

只访问 `/health` 或只看到端口监听，不等于 MCP 协议已通过。

## 6. 公网 MCP

公网部署使用独立域名和独立 Tunnel ingress，例如 `https://mcp.example.com/mcp`。推荐配置：

```dotenv
XHS_MCP_ENABLED=true
XHS_MCP_HOST=127.0.0.1
XHS_MCP_PORT=4328
XHS_MCP_PUBLIC_URL=https://mcp.example.com
XHS_MCP_REQUIRE_CLOUDFLARE_HEADERS=true
XHS_MCP_PUBLIC_SHOWCASE_ENABLED=true
CLOUDFLARE_MCP_PUBLIC_URL=https://mcp.example.com
```

源站 MCP 仍只监听回环地址。公网入口同时启用 HTTPS、Cloudflare 代理标识校验和匿名合成只读展示；访问真实任务数据时必须提供 Bearer Grant Token，Web 登录 Cookie 不能代替 MCP Token。错误、过期或格式不正确的认证头始终返回 401，不会降级为匿名模式。

## 7. 故障定位

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/health` 不通 | 应用未启动或 MCP 端口不一致 | 运行 `start-mcp.cmd`，核对 `XHS_MCP_PORT` |
| 私有 MCP 调用返回 401 | Grant Token 缺失、错误或过期 | 从 MCP 管理界面重新签发并配置 Token 文件；纯匿名展示不要发送认证头 |
| 客户端立即退出 | `command` 或 Token 文件路径错误 | 使用绝对路径并确认文件可读 |
| Grant 显示上下文过期 | 任务快照或上下文已变化 | 重新绑定或创建新 Grant |
| 公网返回 Cloudflare 标识错误 | 请求未经过预期 Tunnel | 核对独立 MCP 域名和 ingress |
| 恢复备份后旧 Token 失效 | 恢复流程按设计撤销旧 Grant | 在恢复后的实例重新签发 |

## 8. 发布包验收口径

解压后可在不占用正式端口的情况下，启动包内 Web 与 MCP 并自动检查页面、健康接口、MCP 状态、鉴权拒绝和授权管理接口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-public-package-mcp.ps1
```

脚本仅停止自己启动的进程，测试数据与日志写入系统临时目录。

发布脚本把 MCP 入口、匿名展示服务、管理 UI、客户端模板、验证器和本文档列为强制归档文件。默认本地包关闭匿名展示，因此隔离包仍检查无令牌 401；配置公网展示后还必须运行无令牌官方 SDK 验证，并确认错误认证 401、有效 Grant 私有调用和 stdio 桥协议均正常。
