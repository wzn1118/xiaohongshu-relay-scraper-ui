# 浏览器读取与无 Relay 启动

项目不再把 OpenClaw Browser Relay 作为新电脑的前置条件。Windows 用户从 GitHub 下载 ZIP 后，双击 `start-windows.cmd` 即可由项目自动完成以下流程：

1. 检查或准备 Node.js、Python、Chrome/Edge 和项目依赖。
2. 在 `127.0.0.1:18800` 启动项目自己的隔离浏览器 Profile。
3. 通过 Chrome DevTools Protocol 读取页签、打开登录页，并使用 Playwright 连接页面内容。
4. 复用 `data/browser/<profile>` 中的本机登录状态。
5. 启动项目页面和 API，整个过程不模拟点击、不抢占当前鼠标。

## 两种后端

- **原生 CDP（默认）**：自动发现 Chrome 或 Edge，使用独立的项目 Profile；新电脑没有 OpenClaw 时走此路径。
- **已有 OpenClaw Relay（兼容）**：如果 `18800` 已经有可用 Relay，项目直接复用，不重复启动浏览器。

项目通过 `/json/version`、`/json/list` 和 CDP WebSocket 读取浏览器，不需要安装浏览器扩展。第一次使用时，在项目打开的登录页完成一次小红书登录；Cookie 只写入本机的 `data/browser`，不会进入 Git，也不会随仓库传给其他电脑。

## 页面一键接入

打开项目页面的 Relay 配置区，点击 **一键安装并接入**：项目会保存当前端口和 Profile，Windows 下自动执行依赖检查、准备 Chrome/Edge 和项目浏览器，再连接 Relay。已有可用的 Relay 会直接复用；没有 OpenClaw 时使用项目自己的原生 CDP 浏览器。整个流程由后端代码执行，不会模拟点击或抢占鼠标。

## 配置

`.env` 支持以下可选项：

```dotenv
XHS_BROWSER_PATH=
XHS_BROWSER_DATA_DIR=./data/browser
OPENCLAW_CONFIG_PATH=
```

`XHS_BROWSER_PATH` 可指定 Chrome 或 Edge 的可执行文件；`XHS_BROWSER_DATA_DIR` 可指定独立浏览器数据目录；`OPENCLAW_CONFIG_PATH` 只用于发现并兼容已有 Relay，不是新电脑的必需配置。

## 诊断

```powershell
node scripts/start-managed-browser.mjs --port 18800 --profile openclaw --data-dir data/browser --check-only
```

输出中的 `backend: "native-cdp"` 表示项目自己的浏览器，`backend: "existing-cdp"` 表示复用了已经运行的 CDP/Relay。只要 `running: true` 且 `cdpReady: true`，页面读取链路就已就绪。
