# 公共发布版验证报告

**发布日期：** 2026-08-10

**发布类型：** Windows 公网公共发布包（MCP 集成版）

**最终归档：** `E:\today-you-applied-public-release-v3.0.0-20260810-r4.zip`

## 1. 发布边界

本包面向新 Windows 电脑和公网源站部署，包含当前工作树源码、生产前端、Node 依赖、MCP 服务、便携 Node.js/Python/cloudflared/Chromium 和技术文档。

公共包不包含 715 条私有历史数据、简历、附件、浏览器 Profile/Cookie、管理员账号、Session Secret、API Key、SMTP 密码、MCP Token/pepper、Tunnel Token 或证书。

## 2. MCP 包含范围

| 类别 | 包内实现 |
| --- | --- |
| 传输 | Streamable HTTP MCP + stdio bridge |
| 协议 SDK | `@modelcontextprotocol/sdk` 1.30.0 |
| 本机启动 | `start-mcp.cmd`，使用包内便携运行时 |
| 客户端桥 | `mcp-stdio.cmd` + `config/mcp-client.example.json` |
| 协议验证 | `verify-mcp.cmd` + `scripts/verify-mcp-production.mjs` |
| 包隔离验收 | `scripts/verify-public-package-mcp.ps1` |
| 管理面 | Grant、Scope、快照绑定、会话、审批、工具运行和审计日志 |
| 安全边界 | MCP 源站仅绑定回环地址；Bearer Grant Token 不与 Web Cookie 混用 |

## 3. 本轮实际验证

以下证据来自匿名直连修复之前的历史 r4 打包轮次，不引用旧 r3 路径；该归档默认关闭匿名展示，其 401 结果不是当前公网 endpoint 的行为：

| 检查 | 结果 | 本轮证据 |
| --- | --- | --- |
| 生产构建 | 通过 | Vite 生产构建完成 1,604 个模块 |
| 一键启动回归 | 通过 | `tests/one-click-launcher.test.mjs` 5/5；包内 Node 22、Python 3.13 解析正确 |
| MCP 自动化测试 | 通过 | 7/7；覆盖 Grant、快照/Scope、撤销、审计、限流/并发、官方 SDK HTTP 和 Windows 中文空格路径 stdio |
| 源码凭据扫描 | 通过 | `npm run test:credentials` 未发现禁止凭据 |
| 包内 MCP 预检 | 通过 | `start-mcp.cmd -CheckOnly` 返回 `ready: true`，Web `45440`、MCP `45441/mcp` |
| 解压包隔离启动 | 通过 | 包内 Node 启动 Web/MCP；运行数据写入包外临时目录 |
| Web 与应用健康 | 通过 | 首页 HTTP 200，React 根节点存在，`/api/health` 返回应用服务身份 |
| MCP 服务与管理 API | 通过 | MCP `/health` 正常，协议为 `streamable-http`，Grant 管理 API 返回 200 |
| MCP 未授权边界 | 通过 | 历史 r4 包默认关闭匿名展示，无 Token 请求 `/mcp` 返回 HTTP 401 |
| 隔离进程清理 | 通过 | 验收脚本只停止自己启动的 PID，不触碰正式端口 |

## 4. 与完整回归基线的关系

本轮改动集中在 MCP 一键入口、客户端模板、发布约束、隔离验收和文档。上一个 r3 基线曾完成 Node、Python、API、Playwright 和视觉回归；这些属于旧基线，本报告不把它们重复写为 r4 本轮新运行结果。

## 5. 最终 ZIP 质量门

`scripts/package-windows-production.ps1` 在输出归档前强制检查：

1. 便携运行时、MCP 服务、入口、UI、配置模板、验证器和文档全部存在；
2. 禁止凭据、Git 历史、运行数据和浏览器状态不进入公共包；
3. 逐个 ZIP 条目读取，任一条目损坏就中止发布；
4. 打包完成后生成独立 `r4.zip.sha256`，用于下载后完整性校验。

## 6. 必须由目标机器配置的外部能力

- 小红书登录、页面验证和实时采集；
- AI API Key 或本机模型服务；
- SMTP/OAuth 邮箱授权和真实发信；
- Cloudflare 域名、Tunnel Token 和 DNS；
- 用户简历、附件和历史任务数据；
- 基于实际任务快照创建的 MCP Grant Token。

包内验证证明软件结构、启动、协议和鉴权边界正常；不用本地 HTTP 200 代替第三方账号、AI、SMTP 或 Tunnel 的实际可用性验证。
