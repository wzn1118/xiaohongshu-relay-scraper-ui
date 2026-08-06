# HegelSalon 公网部署

公网入口固定为 `https://relay.hegelsalon.com`，由独立的远程托管 Tunnel
`hegelsalon-relay` 转发到本机 `http://127.0.0.1:4327`。根域名和 `www`
继续由原有 HegelSalon Tunnel 提供，不与 Relay 连接器共用配置。

## 新电脑首次使用

1. 解压带运行时的便携发布包。包内已经包含 Node.js、Python、cloudflared、
   `node_modules` 和构建后的前端，不要求目标电脑预装开发环境。
2. 如需迁移 715 条原始数据，在本机先运行 `backup-hegelsalon.ps1`，再在
   新电脑运行 `restore-hegelsalon.ps1 -Archive <PRIVATE_DATA_ZIP>`。原始数据包
   只用于私下迁移，不上传 GitHub。
3. 双击 `start-production-windows.cmd`。首次运行会要求输入管理员邮箱和密码；
   密码只用于生成哈希，不写入命令行、日志或发布包。
4. 如果 `%USERPROFILE%\.cloudflared\hegelsalon-relay.token` 不存在，启动器会
   安全提示粘贴 Tunnel token，并把它保存到发布目录之外的用户目录。
5. 启动器依次验证本地 Origin、Tunnel `/ready` 和公网 `/api/health`。三项都
   成功后才打开系统默认浏览器。

## Cloudflare 管理机配置

已登录 Cloudflare 的管理机执行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-hegelsalon-relay-tunnel.ps1 -Apply
```

脚本创建或复用 `hegelsalon-relay`，将 `relay.hegelsalon.com` 指向
`127.0.0.1:4327`，并把连接器 token 写到仓库之外。token 值不会打印。

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

公网健康检查只证明域名、Tunnel 和 Node Origin 连通。登录后仍需逐项实测：

- 715 条任务和详情页可见，原任务状态和 checkpoint 保留；
- Relay 浏览器已登录，CDP 仅监听回环地址；
- 抓取、正文补全、OCR、分析、受众、任务续跑和产物下载；
- Data Copilot、SSE 重连、附件、邮件草稿和受控 SMTP 发送；
- 未登录 API 返回 401/403，错误 Origin 被拒绝，日志和公网响应不暴露密钥。

浏览器登录、SMTP 和第三方 AI 密钥具有机器相关性，换电脑后需要在目标机器
重新登录或注入；发布 ZIP 不复制个人 Cookie、Tunnel token 或明文密钥。
