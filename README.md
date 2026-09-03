# 小红书 Relay 数据工作台

本项目提供小红书 Relay 采集、数据管理、报告生成和 Data Copilot 工作台。GitHub Release 同时生成普通版与内置 Codex 版的 Windows、macOS 独立解压包，并在发布前真实启动和打开页面。

## 下载后直接运行

### Windows 10/11

1. 从仓库的 **Releases** 下载 `xiaohongshu-relay-scraper-ui-one-click-windows.zip`。
2. 完整解压 ZIP。
3. 双击 `start-windows.cmd`。

内置 Codex 版下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-windows-x64.zip`，完整解压后双击 `Start-Codex-App.cmd`。该包自带经过 PE x64 头与 SHA-256 校验的 Codex app-server，不会借用 Linux 或 macOS runtime。

第一次运行会自动检查并安装 Node.js、Python 和 Chrome，随后安装依赖、构建并启动应用。详细步骤、哈希校验和故障排查见 [一键启动指南](ONE_CLICK_START.md)。

### macOS / Linux

从 GitHub Releases 下载独立的 `xiaohongshu-relay-scraper-ui-one-click-macos.zip` 和同名 `.sha256` 文件。该 ZIP 不包含 Windows 便携运行时、运行数据、浏览器 Profile 或密钥；发布前，同一个 ZIP 会分别在 Apple Silicon 与 Intel Mac 运行器上从 `Start-App.command` 完成冷启动和页面打开验收。

预先安装 Node.js 22+、npm、Python 3.11+ 和 Chrome 或 Edge。完整解压后，在 Finder 中双击 `Start-App.command`；首次运行会安装依赖、构建、启动服务并打开浏览器。

内置 Codex 版必须按处理器下载：Apple Silicon 使用 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-arm64.zip`，Intel 使用 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-x64.zip`。两份 ZIP 都从 `Start-Codex-App.command` 启动，并分别携带经过 Mach-O 架构与 SHA-256 校验的 Codex app-server。

也可以从终端启动：

```bash
chmod +x Start-App.command
./Start-App.command
```

## 本地开发

```bash
npm ci
python -m pip install -r requirements.txt
npm run dev
```

生产构建与启动：

```bash
npm run build
npm start
```

默认地址：<http://127.0.0.1:4317>

## 验证

```bash
npm run check
```

Windows 一键启动契约：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/one-click.ps1 -CheckOnly -NoBrowser -SkipBrowserRelayCheck
```

生成 GitHub 一键发布包：

```powershell
npm run package:github-release
npm run package:github-release:codex
```

在 macOS 上本地生成并验收 macOS ZIP：

```bash
sh scripts/package-github-release-macos.sh
sh scripts/verify-github-release-macos.sh --archive-path deliverables/xiaohongshu-relay-scraper-ui-one-click-macos.zip
sh scripts/package-github-release-macos-codex.sh --architecture arm64
sh scripts/verify-github-release-macos.sh --archive-path deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos-arm64.zip --launch-entry Start-Codex-App.command --require-codex-built-in --expected-architecture arm64 --browser-smoke
```

每次推送 `main` 后，`Release` 工作流会分别在 Windows x64、macOS arm64 与 macOS x64 runner 上构建对应的内置 Codex 包。验收会在临时 `CODEX_HOME` 中初始化包内 app-server，调用 `thread/list`，再用 Chromium 打开 `/codex/`。`v*` 标签只有三种目标都通过后才会上传；JSON 证据只记录相对接口、架构、哈希和结果，不记录临时绝对路径或用户状态。

## 首次使用

- 小红书采集需要在受管浏览器中完成一次登录。
- Data Copilot 的模型接口按使用环境配置，不随发布包分发凭据。
- `.env`、用户数据、浏览器资料、Cookie、日志和本机 runtime 不会进入 GitHub 发布包；内置版只额外携带 manifest 声明的目标平台 Codex executable。

## 常用入口

- [一键启动完整说明](ONE_CLICK_START.md)
- [环境变量示例](.env.example)
- [GitHub Actions CI](.github/workflows/ci.yml)
- [GitHub Release 验证](.github/workflows/release.yml)
