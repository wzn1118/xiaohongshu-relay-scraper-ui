# 公网 API、部署与运维说明

## 1. 部署拓扑

推荐拓扑是 Windows 源站 + Cloudflare Tunnel：

```text
Internet -> HTTPS domain -> Cloudflare Tunnel -> 127.0.0.1:4327
                                             -> React static assets
                                             -> Node REST/SSE API

Local only: 127.0.0.1:4328 MCP
Local only: 127.0.0.1:18800 Browser CDP
Local only: local model endpoint
```

源站不直接监听 `0.0.0.0`。公网域名只承载应用 Web 和 API，不转发 MCP、CDP 或本机模型端口。

## 2. 配置文件

公共包提供：

- `.env.example`：本地功能模板；
- `.env.production.example`：生产变量模板；
- `deploy/cloudflared/config.template.yml`：Tunnel 配置模板。

实际配置使用 `production.env.local` 或外部 Secret 文件，并保持在 Git 与公共 ZIP 之外。

### 必填生产项

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4327
CLOUDFLARE_PUBLIC_URL=https://your-domain.example
CLOUDFLARE_TUNNEL_TOKEN_FILE=C:\secure\tunnel.token
XHS_AUTH_REQUIRED=true
XHS_AUTH_SECURE_COOKIE=true
XHS_AUTH_ORIGIN=https://your-domain.example
```

### 推荐资源限制

```dotenv
XHS_MAX_BODY_BYTES=33554432
XHS_ATTACHMENT_MAX_FILES=5
XHS_ATTACHMENT_MAX_FILE_BYTES=10485760
XHS_ATTACHMENT_MAX_TOTAL_BYTES=20971520
XHS_MCP_MAX_CONCURRENT_TOOLS_PER_GRANT=4
XHS_MCP_MAX_CALLS_PER_MINUTE=120
XHS_MCP_SESSION_IDLE_SECONDS=1800
```

## 3. 主要 API 分组

以下为稳定能力分组，不替代源码契约测试：

| 分组 | 代表路由 | 用途 |
| --- | --- | --- |
| 健康与认证 | `GET /api/health`, `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/logout` | 存活、登录态和会话 |
| 采集浏览器 | `/api/relay/config`, `/api/relay/status`, `/api/relay/connect`, `/api/relay/recover`, `/api/relay/login` | 托管浏览器配置、启动和恢复 |
| AI | `/api/ai/providers`, `/api/ai/models`, `/api/ai/sessions`, Session Probe | Provider、模型发现、短期会话和真实推理检查 |
| 用户资料 | `GET /api/profiles`, `POST /api/profiles/import` | 简历和背景事实导入 |
| 任务 | `GET/POST /api/jobs`, Job Detail、Resume、Cancel、Events | 创建、查看、恢复和取消任务 |
| 数据治理 | `/api/data/ownership`, `/api/data/retention`, `/api/data/deletions/*` | 数据归属、保留与删除 |
| 邮箱 | `/api/email/config`, `/api/email/test` | SMTP/OAuth 设置和测试 |
| 投递 | Batch Preview、Freeze、Approve、Send、Draft Version | 草稿、标题、附件和发送门禁 |
| Data Copilot | `/api/copilot/*` | 会话、上下文、引用、审批和工具运行 |
| MCP 管理 | `/api/mcp/*` | Grant、Token、运行、审批、会话和审计 |
| 文件 | Artifact 和 Download 路由 | 受限根目录下的产物下载 |

认证开启后，除登录和健康检查外的受保护路由要求有效会话，并执行 Origin/CSRF 检查。

## 4. 生产生命周期

### 启动

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/start-production-windows.ps1 `
  -EnvFile .\production.env.local `
  -NoBrowser `
  -NonInteractive
```

启动器检查运行时、环境变量、源站端口、认证、静态产物、MCP 回环监听和 Tunnel。`-UseExistingTunnel` 可复用已运行 Tunnel。

### 停止

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/stop-production-windows.ps1
```

只停止由本项目状态文件记录的进程，避免按端口误杀其他服务。

### 看门狗

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/production-watchdog.ps1
```

看门狗读取生产状态、验证进程命令行和健康接口，在可恢复故障时重启源站或 Tunnel。浏览器登录需要交互时，日志会明确记录而不是循环清空 Profile。

### 开机启动

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1
```

计划任务应在持有浏览器 Profile 的 Windows 用户会话中运行。托管浏览器需要桌面交互，不建议改为无用户会话的系统服务。

## 5. 备份与恢复

### 备份

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/backup-hegelsalon.ps1 -Quiesce
```

`-Quiesce` 先停止写入，再复制 JSON、SQLite 主库和 Sidecar，生成带哈希的清单。备份可能包含简历、浏览器登录态、邮箱和 AI 配置，应视为敏感文件。

### 恢复预演

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/restore-hegelsalon.ps1 `
  -Archive E:\backup\hegelsalon-backup.zip `
  -DryRun
```

预演通过后再正式恢复。恢复会撤销活动 MCP Grant，客户端需要重新签发 Token。

## 6. 分层故障定位

### 公网不可访问

1. `Invoke-WebRequest http://127.0.0.1:4327/api/health`；
2. 检查源站 PID 与命令行是否属于本项目；
3. 检查 cloudflared 进程和 Metrics；
4. 检查 Tunnel Token、域名路由和 `CLOUDFLARE_PUBLIC_URL`；
5. 检查外部 `https://your-domain/api/health`；
6. 最后检查登录页和受保护页面，不以 200 健康响应替代登录验证。

### 登录失败

1. `XHS_AUTH_REQUIRED=true`；
2. `XHS_AUTH_ORIGIN` 与地址栏 Origin 完全一致；
3. 公网使用 HTTPS 且 `XHS_AUTH_SECURE_COOKIE=true`；
4. 管理员用户已通过 Provision 脚本创建；
5. 浏览器未缓存旧域名 Cookie；
6. 服务端时间正确。

### 采集失败

1. 托管浏览器进程存在；
2. CDP 只监听回环地址；
3. 至少有一个目标站点页面；
4. 页面已登录且没有停在验证页；
5. Relay 状态中的 `running`、`cdpReady` 和目标标签页计数符合预期；
6. 失败后优先恢复原任务，不创建重复任务。

### AI 失败

1. 模型发现成功；
2. Session 创建成功；
3. 真实推理 Probe 成功；
4. 确认返回的实际模型；
5. 传输超时可有限重试，401/403/404 等确定性错误直接修配置；
6. 不在日志或截图中输出 Key。

### 投递失败

1. 收件邮箱来源和格式；
2. 邮件标题是否满足岗位明确模板；
3. 最新草稿版本是否与预演版本一致；
4. 附件是否存在且命名符合要求；
5. Quality Gate 是否通过；
6. Batch 是否已冻结和审核；
7. SMTP/OAuth 测试是否成功；
8. 只有完成以上检查后才允许真实发送。

## 7. 发布检查清单

- [ ] `npm run check` 通过；
- [ ] `npm run test:mcp` 通过；
- [ ] `npm audit --audit-level=high` 无高危项；
- [ ] 公共包使用当前工作树而不是仅 Git HEAD；
- [ ] `dist`、`node_modules` 和五项便携运行时齐全；
- [ ] 公共包不含 `data`、`.env`、Cookie、Token、SQLite 和日志；
- [ ] 在隔离目录和隔离端口启动；
- [ ] 健康、页面、认证边界、主要 API 和静态资源通过；
- [ ] ZIP 逐条目读取成功；
- [ ] 最终记录文件数、字节数和 SHA-256。
