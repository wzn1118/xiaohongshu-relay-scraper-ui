# HegelSalon 公网部署

公网应用入口固定为 `https://relay.hegelsalon.com`，公网 MCP endpoint 固定为
`https://mcp.hegelsalon.com/mcp`。远程托管 Tunnel `hegelsalon-relay` 分别转发到
本机 `http://127.0.0.1:4327` 和 `http://127.0.0.1:4328`。两个 Node listener
仍只绑定回环地址；根域名和 `www` 继续由原有 HegelSalon Tunnel 提供。

## 新电脑首次使用

1. 解压带运行时的便携发布包。包内已经包含 Node.js、Python、cloudflared、
   `node_modules` 和构建后的前端，不要求目标电脑预装开发环境。
2. 带 715 条原始数据的私有便携包是可直接启动的完整发布包：解压后保留包内
   `data\...` 目录，并直接双击 `start-production-windows.cmd`。它不是备份归档，
   不要传给 `restore-hegelsalon.ps1`；完整备份归档才使用该恢复脚本。原始数据包
   只用于私下迁移，不上传 GitHub。
3. 双击 `start-production-windows.cmd`。首次运行会要求输入管理员邮箱和密码；
   密码只用于生成哈希，不写入命令行、日志或发布包。
4. 如果 `%USERPROFILE%\.cloudflared\hegelsalon-relay.token` 不存在，启动器会
   安全提示粘贴 Tunnel token，并把它保存到发布目录之外的用户目录。
5. 启动器依次验证本地 Web/API、本地 MCP、Tunnel `/ready`、公网应用健康端点
   和公网 MCP 健康端点。全部成功后才打开系统默认浏览器。

## Cloudflare 管理机配置

已登录 Cloudflare 的管理机执行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1 -Apply
```

脚本创建或复用 `hegelsalon-relay`，将 `relay.hegelsalon.com` 指向
`127.0.0.1:4327`，将 `mcp.hegelsalon.com` 指向 `127.0.0.1:4328`，并把连接器
token 写到仓库之外。token 值不会打印。zone API token 有权限时脚本同时启用
`Always Use HTTPS`；权限不足只产生警告，MCP 源站仍会拒绝非 HTTPS 转发。

## 公网 MCP 验收与客户端配置

同一个 endpoint 提供两种严格隔离的能力：不带认证头时只有内置的合成展示数据
和只读确定性工具；带有效 Bearer Grant 时才进入绑定任务快照的私有数据面。匿名
展示不会读取生产任务、会话、附件、用户资料或产物，也不会创建持久化 MCP session。

```powershell
$env:XHS_MCP_URL = 'https://mcp.hegelsalon.com/mcp'
npm run verify:mcp:showcase
Remove-Item Env:XHS_MCP_URL

# 私有数据面：先在登录后的 Data Copilot MCP Access 面板创建 Grant
$env:XHS_MCP_URL = 'https://mcp.hegelsalon.com/mcp'
$env:XHS_MCP_TOKEN_FILE = 'C:\ProgramData\HegelSalon\mcp-grant.token'
npm run verify:mcp
Remove-Item Env:XHS_MCP_URL,Env:XHS_MCP_TOKEN_FILE

# 发布机全链路：创建隔离 Grant -> 公网 SDK 调用 -> 撤销 -> 旧 token 拒绝 -> 恢复生产
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-mcp-public-production.ps1
Get-Content .\.runtime\production\public-mcp-verification.json
```

Grant token 只展示一次，应写入仓库之外的受保护文件，不能写进 URL、query string、
Cookie、日志、Cloudflare 配置或发布 ZIP。

边界验收结果必须满足：

- `https://mcp.hegelsalon.com/health` 返回 200；
- 浏览器直接访问 `https://mcp.hegelsalon.com/mcp` 返回 200 和 `anonymous-read-only-showcase`；
- 不带 Bearer 的官方 SDK 只能发现 `showcase://` 资源和 `showcase.*` 只读工具；
- 只要提供了错误、过期或格式不正确的认证头，请求仍返回 401，不降级到匿名展示；
- `http://mcp.hegelsalon.com/health` 或缺少 Cloudflare HTTPS 转发头的伪造 Host 返回 403；
- 有效 Grant 的官方 SDK 完成私有资源发现、资源读取、工具发现、至少一次只读工具调用和 session close；
- 撤销 Grant 后旧 token 被拒绝；active Grant 恢复验证前既有基线，active session 恢复为 0。

## 启动前检查

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-production-windows.ps1 `
  -CheckOnly -NoBrowser
```

输出必须显示包内 Node、Python 和 cloudflared 的绝对路径。正式启动固定使用
4327；端口被其他进程占用时会终止并报告，不会随机换端口或误用未知服务。

## 数据备份与恢复

```powershell
# 源电脑创建私有原始数据归档
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-hegelsalon.ps1 -Quiesce

# 新电脑先校验，再恢复
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-hegelsalon.ps1 `
  -Archive 'E:\backups\hegelsalon-backup-YYYYMMDD-HHMMSS.zip' -DryRun
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-hegelsalon.ps1 `
  -Archive 'E:\backups\hegelsalon-backup-YYYYMMDD-HHMMSS.zip' -Force
```

备份逐文件记录 SHA-256，并保留 SQLite 的 `-wal`、`-shm`。归档可能包含原始
任务、浏览器状态、认证材料和服务配置，必须放在受控存储中。

## 验收边界

应用公网健康检查只证明域名、Tunnel 和 Node Origin 连通；MCP 官方 SDK 验证会
额外证明协议、Grant、资源读取、工具调用和撤销。登录后其他产品能力仍需逐项实测：

- 715 条任务和详情页可见，原任务状态和 checkpoint 保留；
- Relay 浏览器已登录，CDP 仅监听回环地址；
- 抓取、正文补全、OCR、分析、受众、任务续跑和产物下载；
- Data Copilot、SSE 重连、附件、邮件草稿和受控 SMTP 发送；
- 未登录 API 返回 401/403，错误 Origin 被拒绝，日志和公网响应不暴露密钥。

浏览器登录、SMTP 和第三方 AI 密钥具有机器相关性，换电脑后需要在目标机器
重新登录或注入；发布 ZIP 不复制个人 Cookie、Tunnel token 或明文密钥。
