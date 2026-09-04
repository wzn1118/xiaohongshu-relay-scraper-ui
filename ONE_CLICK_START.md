# 一键下载与运行

这个仓库提供经过 CI 实测的普通版与内置 Codex 版 Windows、macOS 独立解压运行包。发布包不包含本机数据、登录态、密钥、`.env`、运行日志或依赖缓存。

## 内置 Codex 版

- Windows x64：下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-windows-x64.zip`，完整解压后双击 `Start-Codex-App.cmd`。
- Apple Silicon：下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-arm64.zip`；Intel Mac：下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-x64.zip`。完整解压后双击 `Start-Codex-App.command`。
- 每份包都自带目标平台的 Codex app-server。`runtime/codex/codex-runtime-manifest.json` 声明平台、架构、相对入口和 SHA-256；启动验收会拒绝 PE、ELF、Mach-O 或架构不匹配的伪装 runtime。
- 发布验收会确认 app-server 初始化、`thread/list` 调用、`/codex/` 页面渲染和交互控件。

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

### macOS 独立 ZIP

1. 在 GitHub Releases 下载 `xiaohongshu-relay-scraper-ui-one-click-macos.zip` 和同名 `.sha256` 文件。
2. 在终端校验下载文件：

   ```bash
   shasum -a 256 xiaohongshu-relay-scraper-ui-one-click-macos.zip
   cat xiaohongshu-relay-scraper-ui-one-click-macos.zip.sha256
   ```

   两处哈希值必须一致。

3. 将 ZIP **完整解压**到可写目录，不要直接在压缩包预览中运行。
4. 系统需要预先安装 Node.js 22+、npm、Python 3.11+ 和 Chrome 或 Edge。Apple Silicon 与 Intel Mac 均使用同一个 ZIP；发布流程会在两种架构上分别实测该 ZIP，首次运行按当前架构安装 Node/Python 依赖。
5. 在 Finder 中双击解压后根目录的 `Start-App.command`。终端窗口需要在使用期间保持打开，程序启动后会自动打开浏览器。
6. 也可以在项目根目录从终端执行：

```bash
chmod +x Start-App.command
./Start-App.command
```

首次启动会执行确定性依赖安装和生产构建。该发布物是独立的 macOS 解压运行 ZIP，不是 `.dmg` 或拖拽安装的 `.app`。

### Linux

Linux 使用同一套源码启动入口，但当前 GitHub Release 只发布经 macOS runner 验收的 macOS ZIP。Linux 用户需要预先安装 Node.js 22+、npm 和 Python 3.11+，然后在项目根目录执行：

```bash
chmod +x start-linux-macos.sh scripts/*.sh
./start-linux-macos.sh
```

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
2. 拒绝 `.env`、数据、登录态、本机 runtime、依赖缓存和日志进入发布包；内置版只允许 manifest 列出的 Codex executable；
3. 在全新临时目录解压；
4. 在 Apple Silicon macOS 上，从解压包内可双击的 `Start-App.command` 执行首次依赖安装、生产构建和启动；
5. 在 Intel runner 独立构建 macOS x64 包，在 Apple Silicon runner 独立构建 macOS arm64 包，禁止跨架构复用一份 runtime ZIP；
6. 在 Windows、两种 Mac 架构上验证原生二进制头与 manifest 哈希，再从平台启动入口完成冷启动；
7. 验证 `/api/health`、Codex status、`thread/list` 与 `/codex/` 页面，并用 Chromium 检查交互和脚本错误；
8. 生成不含绝对路径、密钥或用户状态的 JSON 证据、截图与 SHA-256 文件；
9. 对 `v*` 标签仅发布已在目标架构 runner 上通过上述验收的 ZIP。
