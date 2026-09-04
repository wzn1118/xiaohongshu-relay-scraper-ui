# 今天你投了吗？公网发布版

这是面向公开发布和新机器部署的完整 Windows 版本。发布包包含当前工作树中的前端、Node.js 服务端、Python 工作流、MCP 接入层、生产运维脚本、已编译前端、Node 依赖，以及 Node.js、Python、cloudflared、Chromium 便携运行时。

## 先看这里

| 使用目标 | 入口 | 说明 |
| --- | --- | --- |
| 在本机直接体验 | 双击 `start-windows.cmd` | 自动选择可用端口并打开应用；首次使用需在页面完成浏览器、AI、简历和邮箱配置 |
| 作为公网源站运行 | 双击 `start-production-windows.cmd` | 使用 `production.env.local` 和 Cloudflare Tunnel；详细步骤见部署文档 |
| 开发和二次集成 | `npm run dev` | 需要开发环境；公开包内同时保留源码、测试和技术文档 |
| 一键启动应用与 MCP | 双击 `start-mcp.cmd` | 使用便携运行时启动 Web 与本机 MCP，不额外打开应用浏览器 |
| 接入 stdio MCP 客户端 | `mcp-stdio.cmd` | 修改 `config/mcp-client.example.json`，令牌文件必须放在发布包外 |
| 验证 MCP 协议 | `verify-mcp.cmd` | 使用官方 SDK 实测资源、工具和只读调用，不只检查端口 |
| 隔离验收解压包 | `scripts\verify-public-package-mcp.ps1` | 在独立 Web/MCP 端口上自动验证页面、健康、鉴权和管理 API，只清理自己启动的进程 |

## 包内不包含什么

这是公共发布包，不包含以下机器私有内容：

- 715 条历史任务数据、简历、草稿、附件和下载产物；
- `.env`、`production.env.local`、管理员账号、Session Secret；
- AI API Key、SMTP 密码或 OAuth Token；
- Cloudflare Tunnel Token、证书和本机 Tunnel 凭据；
- 浏览器 Profile、Cookie、登录状态和历史记录；
- 日志、SQLite 运行库、测试缓存和 Git 历史。

首次启动会在解压目录下新建运行数据。需要迁移真实任务时，请使用受控的私有备份/恢复流程，不要把私有数据补进公共 ZIP。

## 文档地图

1. [公共发布快速开始](docs/PUBLIC_RELEASE_QUICK_START.md)
2. [完整技术架构](docs/PUBLIC_RELEASE_TECHNICAL_GUIDE.md)
3. [公网部署与运维](docs/PUBLIC_RELEASE_API_AND_OPERATIONS.md)
4. [产品能力与优势](docs/PUBLIC_RELEASE_PRODUCT_ADVANTAGES.md)
5. [2026-08-10 版本更新说明](docs/PUBLIC_RELEASE_CHANGELOG_20260810.md)
6. [发布验证报告](docs/PUBLIC_RELEASE_VERIFICATION.md)
7. [Hegelsalon 公网部署说明](docs/HEGELSALON_PUBLIC_DEPLOYMENT.md)
8. [Hegelsalon 生产运行手册](docs/HEGELSALON_PRODUCTION_RUNBOOK.md)
9. [MCP 完整实现规范](docs/MCP_FULL_IMPLEMENTATION_SPEC.md)
10. [发布包 MCP 使用指南](docs/PUBLIC_RELEASE_MCP_GUIDE.md)

## 运行边界

“应用启动成功”和“所有外部能力已配置”是两件事：

- UI、API、本地状态、任务管理、草稿编辑、文件下载、MCP 服务、stdio 桥和 MCP 管理界面由发布包提供；
- 小红书采集需要用户在该机器的托管浏览器中完成登录；
- AI 生成需要连接本机模型或用户自己的 OpenAI 兼容接口；
- 邮件发送需要用户自己的 SMTP/OAuth 配置，并且始终经过预演、冻结、审核和最终发送操作；
- 公网 HTTPS 需要用户自己的域名和 Tunnel Token。

包内测试可以证明软件结构、启动、接口、权限和主要交互没有回归，但不能替代目标机器上的第三方账号登录和外部服务可用性验证。
