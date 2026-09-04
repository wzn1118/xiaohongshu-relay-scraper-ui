# 小红书 Relay 数据工作台

本项目提供小红书 Relay 采集、数据管理、报告生成和 Data Copilot 工作台。GitHub Release 同时生成普通版与内置 Codex 版的 Windows、macOS 独立解压包，并在发布前真实启动和打开页面。

## 下载后直接运行

### Windows 10/11

1. 从仓库的 **Releases** 下载 `xiaohongshu-relay-scraper-ui-one-click-windows.zip`。
2. 完整解压 ZIP。
3. 双击 `start-windows.cmd`。

内置 Codex 版下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-windows.zip`，完整解压后双击 `Start-Codex-App.cmd`。该启动器会启用包内 Codex 页面，并由项目依赖自动安装匹配 Windows 架构的 Codex app-server。

第一次运行会自动检查并安装 Node.js、Python 和 Chrome，随后安装依赖、构建并启动应用。详细步骤、哈希校验和故障排查见 [一键启动指南](ONE_CLICK_START.md)。

### macOS / Linux

从 GitHub Releases 下载独立的 `xiaohongshu-relay-scraper-ui-one-click-macos.zip` 和同名 `.sha256` 文件。该 ZIP 不包含 Windows 便携运行时、运行数据、浏览器 Profile 或密钥；发布前，同一个 ZIP 会分别在 Apple Silicon 与 Intel Mac 运行器上从 `Start-App.command` 完成冷启动和页面打开验收。

预先安装 Node.js 22+、npm、Python 3.11+ 和 Chrome 或 Edge。完整解压后，在 Finder 中双击 `Start-App.command`；首次运行会安装依赖、构建、启动服务并打开浏览器。

内置 Codex 版下载 `xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos.zip`，在 Finder 中双击 `Start-Codex-App.command`。同一个 ZIP 会在 Apple Silicon 与 Intel Mac 上分别安装匹配架构的 Codex app-server，并完成 `/codex/` 页面打开验收。

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
sh scripts/package-github-release-macos-codex.sh
sh scripts/verify-github-release-macos.sh --archive-path deliverables/xiaohongshu-relay-scraper-ui-one-click-codex-built-in-macos.zip --launch-entry Start-Codex-App.command --require-codex-built-in --browser-smoke
```

每次推送 `main` 后，`Release` 工作流会创建四个净化 ZIP。内置 Codex 版会在临时 `CODEX_HOME` 中初始化包内 app-server，调用 `thread/list`，再用 Chromium 打开 `/codex/`。`v*` 标签只有在 Windows、Apple Silicon 和 Intel Mac 全部通过后，才会上传四个 ZIP 及各自的 SHA-256 校验文件。

## 首次使用

- 小红书采集需要在受管浏览器中完成一次登录。
- Data Copilot 的模型接口按使用环境配置，不随发布包分发凭据。
- `.env`、用户数据、浏览器资料、Cookie、日志和本地运行时不会进入 GitHub 发布包。

## 常用入口

- [一键启动完整说明](ONE_CLICK_START.md)
- [环境变量示例](.env.example)
- [GitHub Actions CI](.github/workflows/ci.yml)
- [GitHub Release 验证](.github/workflows/release.yml)
