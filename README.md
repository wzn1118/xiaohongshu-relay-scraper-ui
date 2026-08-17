# 小红书 Relay 数据工作台

本项目提供小红书 Relay 采集、数据管理、报告生成和 Data Copilot 工作台。仓库已提供 Windows 一键启动器和自动验证的 GitHub Release 发布链路。

## 下载后直接运行

### Windows 10/11

1. 从仓库的 **Releases** 下载 `xiaohongshu-relay-scraper-ui-one-click-windows.zip`。
2. 完整解压 ZIP。
3. 双击 `start-windows.cmd`。

第一次运行会自动检查并安装 Node.js、Python 和 Chrome，随后安装依赖、构建并启动应用。详细步骤、哈希校验和故障排查见 [一键启动指南](ONE_CLICK_START.md)。

### macOS / Linux

预先安装 Node.js 22+、npm 和 Python 3.11+，然后执行：

```bash
chmod +x start-linux-macos.sh scripts/*.sh
./start-linux-macos.sh
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

每次推送 `main` 后，`Release` 工作流会从 Git 已提交文件创建净化 ZIP，在全新目录重新安装、构建、启动并检查 `/api/health`。`v*` 标签会自动发布 GitHub Release 和 SHA-256 校验文件。

## 首次使用

- 小红书采集需要在受管浏览器中完成一次登录。
- Data Copilot 的模型接口按使用环境配置，不随发布包分发凭据。
- `.env`、用户数据、浏览器资料、Cookie、日志和本地运行时不会进入 GitHub 发布包。

## 常用入口

- [一键启动完整说明](ONE_CLICK_START.md)
- [环境变量示例](.env.example)
- [GitHub Actions CI](.github/workflows/ci.yml)
- [GitHub Release 验证](.github/workflows/release.yml)
