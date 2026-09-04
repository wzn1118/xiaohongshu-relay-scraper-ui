# 比赛提交版技术说明与使用指南

## 1. 交付目标

本提交版用于在 100 MB 上传限制内交付完整工程、715 条默认任务数据、可编辑投递正文、MCP 服务和 Windows 一键启动能力。它不是把大型运行时硬塞进压缩包，而是采用“紧凑数据快照 + 已构建前端 + 在线首装”的方式降低体积。

解压后双击 `start-competition-windows.cmd`。启动器会选择未占用的 Web/MCP 端口，调用项目的一键准备流程，并在默认浏览器打开工作台。第一次运行需要联网；后续运行复用本机已安装的依赖与项目依赖。

## 2. 包内包含什么

- 当前工作树的 Web 前端、Node.js 服务端、Python 工作流、MCP 服务端和运维脚本。
- 已构建的 `dist/`，用于快速启动和静态资源校验。
- 任务 `20260804081657-caf8f451` 的 715 条卡片与 715 条正文。
- 该任务的应用分析、联系人解析、邮件正文、邮件标题、质量检查和投递状态。
- 历史任务 `20260731005634-5c619106` 的持久化工作流状态，用于验证“补全缺失分析/历史续跑”路径。
- 候选人资料与投递附件原文件，保证投递预览与附件选择链路可用。
- MCP 管理面板、Grant 权限模型、Streamable HTTP 端点、stdio 入口和验证脚本。
- 数据清单、排除清单、文件清单、SHA-256 校验文件和本技术指南。

## 3. 为什么可以小于 100 MB

完整离线包中的 Chromium、Node.js、Python 与依赖目录占用超过 1 GB，不能满足比赛平台的 100 MB 限制。本版执行以下体积优化：

1. 不内置浏览器、Node.js、Python 和 `node_modules`，首启时通过 Windows 包管理器与 `npm/pip` 安装。
2. 不复制采集过程中的时间戳快照、重复 CSV/XLSX、媒体缓存、运行日志和诊断日志。
3. 保留每类数据的规范最新文件，以及应用真正读取的持久化状态文件。
4. 对 JSON、源码和文档使用 ZIP Optimal 压缩。
5. 保留原始 715 条卡片与正文内容，不通过删记录换体积。

这是一种上传包体积优化，不是运行时磁盘占用优化。首次安装后，依赖仍会占用本机磁盘空间。

## 4. 一键启动过程

`start-competition-windows.cmd` 的执行顺序如下：

1. 从 4317 开始寻找空闲 Web 端口，从 4328 开始寻找空闲 MCP 端口。
2. 检查 Node.js 22+、Python 3.11+ 和 Chromium 浏览器。
3. 缺少运行环境时，通过 `winget` 安装 Node.js LTS、Python 3.13 和 Google Chrome。
4. 首次运行 `npm ci` 与 `pip install -r requirements.txt`。
5. 构建前端并创建本地 `.env`。
6. 启动隔离的采集浏览器配置目录，不占用用户日常浏览器配置。
7. 启动 Web/API 服务和本地 MCP 服务。
8. 打开工作台，并把本次端口写入 `LAST-STARTED-PORTS.json`。

新电脑最低条件：Windows 10/11、可联网、系统具有 App Installer/`winget`。第一次安装所需时间取决于网络；安装完成后的再次启动更快。

## 5. 默认 715 条任务

比赛包中的 `data/jobs/jobs.json` 只保留两个需要演示的任务，并把 `20260804081657-caf8f451` 放在第一位。因此工作台首次进入时默认展示 715 条任务，而不是最近创建的测试任务。

核心文件：

- `data/jobs/20260804081657-caf8f451/artifacts/xiaohongshu_cards_latest.json`
- `data/jobs/20260804081657-caf8f451/artifacts/xiaohongshu_notes_latest.json`
- `data/jobs/20260804081657-caf8f451/artifacts/application_intelligence.json`
- `data/jobs/20260804081657-caf8f451/artifacts/delivery-state.json`
- `data/jobs/20260804081657-caf8f451/workflow-state.json`

任务管理器在启动时会检测旧电脑的绝对路径，并把 `outputDir`、`logPath` 和 `statePath` 重定位到当前解压目录。移动文件夹或换盘符不需要手工改路径。

## 6. 可编辑正文与邮件标题

批量投递工作台从 `application_intelligence.json` 读取基础分析，从 `delivery-state.json` 读取经过编辑的标题、正文、修订版本、质量检查和投递状态。

编辑流程：

1. 在左侧选择“投递”。
2. 选择任务 `ai产品 实习 继任`。
3. 展开目标岗位并点击“编辑正文”。
4. 同时修改“邮件标题”和“邮件正文”。
5. 保存后重新打开该条目，确认标题与正文均来自持久化版本。
6. 运行投递预演，冻结发送内容；只有最终发送步骤才会实际发送。

包内保留原始投递状态，因此已有编辑不会因换电脑而丢失。SMTP 和 AI 密钥属于机器凭据，不会进入压缩包；需要在新电脑的设置页重新配置。

## 7. MCP 架构

MCP 由 Web 管理面和独立回环端口组成：

- 管理 API：Web 服务下的 `/api/mcp/*`。
- MCP 健康检查：`http://127.0.0.1:<mcpPort>/health`。
- Streamable HTTP：`http://127.0.0.1:<mcpPort>/mcp`。
- stdio 入口：`mcp-stdio.cmd`。
- 独立启动入口：`start-mcp.cmd`。

MCP 采用 Grant 权限模型。新电脑首次启动后，在 MCP 管理面板创建有明确作用域、工具清单与有效期的 Grant，再把令牌配置到 MCP 客户端。令牌只显示一次，不应写入 Git、文档或截图。

为了防止旧电脑权限被带到新电脑，本提交包不复制 `data/copilot/copilot-state.sqlite`、MCP token pepper 或活动 Grant。MCP 服务代码与工具完整保留，但授权状态在目标机器重新创建。

## 8. 数据与凭据边界

本包按用户要求保留未脱敏的业务数据和候选人附件，因此只能提交到预期的比赛私有上传入口或受控存储，不适合公开 GitHub Release。

明确排除：

- `.env`、`production.env.local` 和真实环境变量。
- AI API Key、SMTP 密码/OAuth 凭据。
- 用户账号数据库、会话密钥和 MCP token pepper。
- Cloudflare Tunnel token、证书和私钥。
- 浏览器 Profile、Cookie 和登录会话。
- 本机 Copilot/MCP SQLite 状态与历史 Grant。
- 运行日志、诊断日志、截图缓存和媒体缓存。

这些内容不是功能代码。目标机器配置后，AI、邮件、公网隧道和采集登录链路可以正常工作，同时避免把旧机器的访问权限打入提交包。

## 9. 功能模块

### 9.1 采集与续跑

- 关键词检索、正文补全、断点续跑、速率限制恢复。
- 项目管理的 Chromium/CDP 浏览器。
- 任务状态、阶段进度、持久化工作流状态。

### 9.2 应用分析

- 岗位事实抽取、联系人识别、OCR 结果合并。
- 简历匹配、邮件正文和 Cover Letter 生成。
- 邮件标题规则、质量门和失败原因映射。

### 9.3 批量投递

- 715 条岗位筛选、批量选择、编辑与持久化。
- 投递预演、冻结批次、审批、实际发送与审计。
- 附件命名、收件人校验、SMTP 配置和状态回写。

### 9.4 数据助手与 MCP

- 文件和任务数据查询。
- MCP 工具注册、权限控制、并发与速率限制。
- 本地 AI 或外部 API 的可配置接入。

### 9.5 文件与审计

- JSON、CSV、XLSX 等规范成果文件下载。
- 任务级状态、质量报告、投递状态和技术清单。

## 10. 项目优势

1. **真实规模**：默认任务保留 715 条卡片、715 条正文及其应用分析，不是空壳演示。
2. **端到端闭环**：覆盖采集、补全、分析、编辑、质量门、批量投递、审计和文件导出。
3. **可恢复**：任务状态与投递状态落盘，换电脑后通过路径迁移继续读取。
4. **人机协作**：生成内容可以逐条编辑、冻结和审批，避免 AI 结果直接越过人工确认。
5. **多模型接入**：支持本地 AI 与外部 API，通过配置选择模型，不把密钥绑定在代码里。
6. **MCP 原生能力**：数据和动作以受控工具暴露给 MCP 客户端，并有细粒度 Grant。
7. **新电脑友好**：入口只有一个 CMD，自动处理端口冲突、依赖安装、构建和浏览器打开。
8. **交付可核验**：包内提供数据清单、排除清单、文件清单、完整 ZIP 读取验证和 SHA-256。
9. **体积受控**：在保留核心原始数据的前提下移除可重建运行时与重复历史快照。
10. **部署可扩展**：同一代码可运行于本机、云服务器或 Cloudflare Tunnel 后方。

## 11. 验收命令

解压后的快速检查：

```powershell
Get-FileHash .\PORTABLE_DATASET.json -Algorithm SHA256
Get-Content .\PORTABLE_DATASET.json
Get-Content .\LAST-STARTED-PORTS.json
```

启动后检查：

```powershell
$ports = Get-Content .\LAST-STARTED-PORTS.json -Raw | ConvertFrom-Json
Invoke-RestMethod "$($ports.web)/api/health"
Invoke-RestMethod "$($ports.web)/api/jobs"
Invoke-RestMethod ($ports.mcp -replace '/mcp$', '/health')
```

MCP 端点对无 Grant 的 `initialize` 请求应返回 401，这是权限系统正常工作的证据，不是服务故障。

## 12. 公网部署说明

提交包默认只监听 `127.0.0.1`，适合本地比赛演示。部署到云服务器时使用 `start-production-windows.cmd` 或对应服务管理器，并设置：

- `NODE_ENV=production`
- `HOST=127.0.0.1`（由反向代理转发）
- `XHS_AUTH_REQUIRED=true`
- `XHS_AUTH_SECURE_COOKIE=true`
- `XHS_AUTH_ORIGIN=https://<your-domain>`
- 独立的 Web 与 MCP 域名/端口

公网部署必须在服务器上注入账号、会话、AI、SMTP 和 Tunnel 配置。这些配置不属于比赛 ZIP，也不应出现在 Git 历史中。

## 13. 已知边界

- 小于 100 MB 版本依赖首次联网安装；需要完全离线时应使用大体积便携运行时版本。
- 原始业务数据包含个人信息，上传范围必须受控。
- 浏览器登录态不能跨电脑安全迁移，新电脑需要在项目管理浏览器内登录一次。
- 外部 AI、SMTP 和公网域名是否可用取决于目标机器配置与相应服务状态。
- SHA-256 用于证明文件传输完整性，不用于缩小文件体积。
