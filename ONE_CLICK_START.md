# 一键下载与运行

这个仓库提供经过 CI 实测的 Windows 一键启动包。发布包不包含本机数据、登录态、密钥、`.env`、运行日志或依赖缓存。

## Windows 10/11

1. 打开 GitHub 仓库的 **Releases** 页面。
2. 下载 `xiaohongshu-relay-scraper-ui-one-click-windows.zip` 和同名 `.sha256` 文件。
3. 将 ZIP **完整解压** 到一个可写目录，不要直接在压缩包内运行。
4. 双击根目录的 `start-windows.cmd`。
5. 第一次启动会自动检查并通过 Windows `winget` 安装 Node.js 22、Python 3.13 和 Chrome，然后安装项目依赖、构建前端并启动服务。根据网络速度，这通常需要数分钟。
6. 浏览器会打开本地应用。小红书采集需要在受管浏览器中完成一次登录；模型接口、邮件等外部服务按需在应用中配置。

启动成功后，应用默认地址为 <http://127.0.0.1:4317>。如果端口已占用，启动器会选择附近可用端口并在终端中显示实际地址。

### 启动前检查

在项目目录打开 PowerShell：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/one-click.ps1 -CheckOnly -NoBrowser -SkipBrowserRelayCheck
```

检查结果中的 `ready` 应为 `true`。首次下载时 `bootstrapRequired: true` 是正常状态，双击启动器后会自动完成安装和构建。

### 校验下载文件

```powershell
Get-FileHash .\xiaohongshu-relay-scraper-ui-one-click-windows.zip -Algorithm SHA256
Get-Content .\xiaohongshu-relay-scraper-ui-one-click-windows.zip.sha256
```

两处哈希值必须一致。

## macOS / Linux

系统需要 Node.js 22+、npm 和 Python 3.11+。解压后在项目根目录执行：

```bash
chmod +x start-linux-macos.sh scripts/*.sh
./start-linux-macos.sh
```

首次启动会执行确定性依赖安装和生产构建。系统运行时需要由操作系统包管理器预先安装。

## 故障排查

- Windows 缺少 `winget`：从 Microsoft Store 安装或更新“应用安装程序”，再重新运行 `start-windows.cmd`。
- 安装中断：重新运行 `start-windows.cmd`，`npm ci` 和 Python 安装可以安全重试。
- 服务启动失败：查看 `.runtime/server-<端口>.err.log` 和 `.runtime/server-<端口>.out.log`。
- 端口冲突：在 `.env` 中设置 `PORT=4317` 为其他空闲端口。
- 只启动服务、不打开浏览器：

  ```powershell
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/one-click.ps1 -NoBrowser
  ```

## 发布包如何验证

每次推送 `main`，GitHub Actions 都会：

1. 从 Git 已提交文件生成净化 ZIP；
2. 拒绝 `.env`、数据、登录态、运行时、依赖缓存和日志进入发布包；
3. 在全新临时目录解压；
4. 重新执行 Node/Python 依赖安装和生产构建；
5. 启动实际服务并验证 `/api/health`；
6. 生成 SHA-256 校验文件并上传 Actions artifact；
7. 对 `v*` 标签创建可直接下载的 GitHub Release。
