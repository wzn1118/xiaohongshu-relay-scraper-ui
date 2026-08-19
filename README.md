# 小红书 Relay 数据工作台

本项目提供小红书 Relay 采集、数据管理、报告生成和 Data Copilot 工作台。GitHub Release 会生成彼此独立的 Windows 与 macOS 解压运行包，并在发布前自动验证安装、构建和健康接口。

## 下载后直接运行

### Windows 10/11

1. 从仓库的 **Releases** 下载 `xiaohongshu-relay-scraper-ui-one-click-windows.zip`。
2. 完整解压 ZIP。
3. 双击 `start-windows.cmd`。

第一次运行会自动检查并安装 Node.js、Python 和 Chrome，随后安装依赖、构建并启动应用。详细步骤、哈希校验和故障排查见 [一键启动指南](ONE_CLICK_START.md)。

### macOS / Linux

从 GitHub Releases 下载独立的 `xiaohongshu-relay-scraper-ui-one-click-macos.zip` 和同名 `.sha256` 文件。该 ZIP 不包含 Windows 便携运行时、运行数据、浏览器 Profile 或密钥；Apple Silicon 与 Intel Mac 会在首次启动时按本机架构安装依赖。

预先安装 Node.js 22+、npm、Python 3.11+ 和 Chrome 或 Edge。完整解压后，在 Finder 中双击 `Start-App.command`；首次运行会安装依赖、构建、启动服务并打开浏览器。

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
```

在 macOS 上本地生成并验收 macOS ZIP：

```bash
sh scripts/package-github-release-macos.sh
sh scripts/verify-github-release-macos.sh --archive-path deliverables/xiaohongshu-relay-scraper-ui-one-click-macos.zip
```

每次推送 `main` 后，`Release` 工作流会从 Git 已提交文件创建 Windows 和 macOS 两个净化 ZIP。macOS 验收会在全新目录从 `Start-App.command` 完成首次安装、构建和启动，再用 Chromium 打开实际页面并检查渲染与脚本错误。`v*` 标签会把两个 ZIP 及各自的 SHA-256 校验文件一起上传到 GitHub Release。

## 首次使用

- 小红书采集需要在受管浏览器中完成一次登录。
- Data Copilot 的模型接口按使用环境配置，不随发布包分发凭据。
- `.env`、用户数据、浏览器资料、Cookie、日志和本地运行时不会进入 GitHub 发布包。

## 常用入口

- [一键启动完整说明](ONE_CLICK_START.md)
- [环境变量示例](.env.example)
- [GitHub Actions CI](.github/workflows/ci.yml)
- [GitHub Release 验证](.github/workflows/release.yml)
