# 公共发布版快速开始

## 1. 解压规则

1. 将 ZIP 完整解压到普通目录，例如 `E:\today-you-applied-public-release`。
2. 不要直接在 ZIP 预览窗口中运行脚本。
3. 路径可以包含中文和空格，但建议避免过深目录。
4. 不要删除 `runtime`、`node_modules` 或 `dist`，它们用于没有开发环境的新电脑。

## 2. 本地一键启动

双击：

```text
start-windows.cmd
```

启动器会依次完成运行时检查、数据目录准备、端口选择、服务启动和默认浏览器打开。若默认端口被占用，启动流程应选择可用端口，而不是要求用户手改代码。

首次进入应用后，按左侧导航的操作顺序完成：

1. **总览**：确认当前任务和系统状态；
2. **环境**：启动采集浏览器、打开小红书并完成登录，连接 AI 和邮箱；
3. **新建**：创建岗位搜索或非岗位研究任务；
4. **结果**：查看采集进度、正文、图片、评论、岗位事实和分析结果；
5. **投递**：编辑邮件标题、邮件正文和 Cover Letter，运行预演并审核发送；
6. **历史**：继续历史任务或切换默认展示任务；
7. **文件**：下载任务产物和附件。

右侧主屏一次只显示当前模块。切换模块时，未保存的投递正文会触发离开保护。

### 一键启动 MCP

需要让本机 MCP 客户端访问任务数据时，双击：

```text
start-mcp.cmd
```

随后在 Web MCP 管理界面为指定任务创建最小权限 Grant，把一次性 Token 保存在发布包外，并按 `config\mcp-client.example.json` 配置客户端。完整步骤和验证方法见 [公网发布包 MCP 使用指南](PUBLIC_RELEASE_MCP_GUIDE.md)。

## 3. 公网生产启动

复制模板到仓库外或解压目录下的私有文件：

```powershell
Copy-Item .env.production.example production.env.local
```

至少配置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4327
CLOUDFLARE_PUBLIC_URL=https://your-domain.example
CLOUDFLARE_TUNNEL_TOKEN_FILE=C:\secure\tunnel.token
XHS_AUTH_REQUIRED=true
XHS_AUTH_SECURE_COOKIE=true
XHS_AUTH_ORIGIN=https://your-domain.example
```

然后双击 `start-production-windows.cmd`。生产模式要求账号层开启，不允许把源站直接监听到公网网卡。Cloudflare 仅代理 Web 源站，采集浏览器 CDP 和 MCP 保持 `127.0.0.1`。

## 4. 首次配置检查

### 采集浏览器

- 点击“启动采集浏览器”；
- 在弹出的独立浏览器中打开目标站点并登录；
- 回到应用确认“浏览器服务”和“浏览器页面”均已连接；
- Cookie 只保存在该机器的数据目录，不进入公共包。

### AI

- 可选择本机模型，或填写自有 OpenAI 兼容接口；
- “连接成功”必须经过一次真实推理探针，而不是仅通过模型列表接口；
- API Key 不写入源码和公共 ZIP；
- 公网用户访问本地 AI 时，推理由源站机器发起，不把本地模型端口暴露到公网。

### 简历和背景资料

- 导入自己的简历；
- 检查解析出的教育、经历、项目、技能和联系方式；
- 生成文案时只允许使用已确认事实；
- 任务数据默认留在当前机器。

### 邮箱

- 在环境页选择邮箱提供商并填写授权方式；
- 先运行测试邮件；
- 批量投递必须依次经过预演、冻结、审核和手动开始发送；
- 编辑正文后，邮件标题会和正文版本一起保存，并使旧预演失效。

## 5. 常用命令

```powershell
# 构建
npm run build

# 综合检查
npm run check

# 生产启动/停止
npm run start:production
npm run stop:production

# 生产看门狗
npm run watchdog:production

# MCP 测试
npm run test:mcp

# 使用官方 SDK 验证已签发的 MCP Grant
$env:XHS_MCP_TOKEN_FILE = 'C:\secure\today-you-applied-mcp-grant.token'
.\verify-mcp.cmd

# 公共包构建
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows-production.ps1 `
  -PortableRuntimeRoot E:\path\to\runtime `
  -OutputPath E:\today-you-applied-public-release.zip
```

## 6. 常见故障

| 现象 | 检查项 | 处理 |
| --- | --- | --- |
| 页面没有打开 | 控制台中的实际 URL | 手动访问控制台显示的 `127.0.0.1` 地址 |
| 端口被占用 | 是否已有同项目服务 | 使用已有服务或让启动器选择新端口 |
| 浏览器空白 | 是否使用托管浏览器、目标标签页是否存在 | 从环境页重新启动采集浏览器并打开目标站点 |
| AI 显示连接失败 | 模型、Base URL、网络和真实探针错误 | 按错误信息修正；列表可见不等于推理可用 |
| 历史任务续跑失败 | 数据目录、任务状态和 workflow-state 是否来自同一包 | 使用正式备份恢复，不手工拆分任务目录 |
| 无法发送邮件 | SMTP/OAuth、收件人、主题、正文、附件与审核状态 | 先运行测试邮件，再重新执行预演和审核 |
| 公网 502/登录循环 | 本地健康、Tunnel、Origin、Secure Cookie | 对照运维文档逐层排查 |
| MCP 客户端连接失败 | MCP 端口、绝对路径、Grant Token 文件 | 运行 `verify-mcp.cmd`，按错误定位健康、鉴权或上下文绑定 |
