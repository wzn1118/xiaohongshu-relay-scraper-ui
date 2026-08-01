<div align="center">

# 小红书实习岗位 AI 求职助手 🚀

<p><strong>把岗位研究、简历匹配和求职信生成，串成一条可复核的投递工作流。🔎 → ✍️ → 📮</strong></p>

<p>
  <a href="https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml"><img src="https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI" /></a>
  <img src="https://img.shields.io/badge/AI%20求职-岗位到求职信-ef4444" alt="AI 求职" />
  <img src="https://img.shields.io/badge/本地优先-可复核工作流-0f766e" alt="本地优先" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-2563eb" alt="Node.js 22+" />
</p>

<p>小红书实习岗位采集 🔎 · 简历智能导入 🧠 · Cover Letter 生成 ✍️ · Agent 质量评审 🛡️</p>

</div>

> 新手请先阅读：[傻瓜式使用教程](docs/USER_GUIDE.md)。教程按页面实际按钮逐步说明启动、Relay、AI、背景资料、候选人资料、任务运行、异常恢复、结果交付和产物下载。

> 这是一个面向实习求职者的 **local-first AI job application workbench**：从公开岗位发现开始，自动整理岗位正文、提炼职责与能力要求、读取候选人简历事实，再生成岗位定制的私信、邮件和 Cover Letter。🚀

**一句话理解：** 不再在岗位卡片、正文、简历和邮件之间反复复制粘贴，而是把“找到岗位”推进到“准备好一份可人工确认的投递材料”。

<p align="center">
  <a href="#产品截图">产品截图</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#工作流">工作流</a> ·
  <a href="#求职信生成">求职信生成</a> ·
  <a href="#快速开始">快速开始</a>
</p>

## 产品截图 📸

GitHub 展示区放真实运行截图，产品界面本身保持专注：打开工作台就能直接开始配置任务。下面三张图分别展示完整运行态、桌面端深度处理和移动端快速查看。✨

<p align="center">
  <img src="./completed-run.png" alt="完整采集任务与交付物" width="100%" />
</p>
<p align="center"><strong>完整运行态：从岗位采集到任务历史与交付文件，一屏看清产品闭环 ✅</strong></p>

<table>
  <tr>
    <td width="65%" valign="top">
      <p><strong>01 · 桌面端工作台 💻</strong><br /><sub>岗位配置、Agent 进度、质量指标和实时日志</sub></p>
      <img src="./desktop-workflow.png" alt="桌面端岗位采集与 Agent 工作台" width="100%" />
    </td>
    <td width="35%" valign="top">
      <p><strong>02 · 移动端适配 📱</strong><br /><sub>窄屏下仍可完成配置、运行和结果查看</sub></p>
      <img src="./mobile-workflow.png" alt="移动端响应式求职工作台" width="100%" />
    </td>
  </tr>
</table>

<p align="center"><sub>真实产品截图 · 本地优先 · 可追踪 · 可复核 · 可导出</sub></p>

## 这是什么产品

| 传统投递准备 | 这个工作台 | 最终结果 |
| --- | --- | --- |
| 在搜索卡片、正文和收藏夹里来回找岗位信息 | 采集公开岗位并补全正文 | 结构化岗位资料 |
| 同一份简历反复复制、删改和改格式 | 智能导入简历并提取候选人事实 | 可确认的候选人档案 |
| 求职信只是在复述招聘要求 | 用岗位职责匹配简历证据 | 第一人称岗位定制文案 |
| 写完后凭感觉判断是否匹配 | 用独立 Agent 进行质量评审 | 有评分、有证据、有重写记录 |
| 担心工具替自己误投 | 只准备和复制文案，保留人工确认 | 人始终掌握发送权 |

它适合准备 **数据分析实习、产品实习、运营实习、市场实习、内容实习** 等岗位的求职者，也适合希望批量比较岗位、但不想牺牲文案个性化程度的人。

## 核心能力

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>岗位发现</h3>
      <p>通过项目管理的已登录浏览器采集小红书公开岗位信息，保留岗位来源、采集时间和正文状态。</p>
    </td>
    <td width="50%" valign="top">
      <h3>正文补全</h3>
      <p>从搜索结果卡片进入岗位详情，补齐职责、要求、投递方式和核心能力；未完成正文不会被标记为可投递。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>简历智能导入</h3>
      <p>支持 PDF、DOCX、TXT、Markdown、JSON、CSV、RTF 等背景资料，识别信息后回填候选人表单，保留人工核对环节。</p>
    </td>
    <td width="50%" valign="top">
      <h3>候选人档案</h3>
      <p>集中管理姓名、学校、专业、年级、电话 / 微信、邮箱、每周可实习天数和预计实习时长等投递字段。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>岗位定制文案</h3>
      <p>针对每条岗位独立生成第一人称私信、邮件和 Cover Letter，不直接复制招聘原文，不把模板套在所有公司上。</p>
    </td>
    <td width="50%" valign="top">
      <h3>质量门禁</h3>
      <p>围绕相关性、证据、表达、可信度和行动就绪度评分；低于阈值时进入重写，并保留评审记录。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>任务可追踪</h3>
      <p>任务历史记录采集进度、Agent 阶段、正文覆盖率、质量结果和失败原因，方便复盘一次投递准备到底卡在哪里。</p>
    </td>
    <td width="50%" valign="top">
      <h3>结构化导出</h3>
      <p>输出 JSON、CSV、XLSX、Markdown 报告和 SHA-256 文件清单，既能快速阅读，也方便后续分析和归档。</p>
    </td>
  </tr>
</table>

## 工作流

```text
01 发现岗位
      ↓
02 补全正文与标准化时间
      ↓
03 提炼职责、要求与能力模型
      ↓
04 导入简历，建立候选人证据
      ↓
05 生成私信 / 邮件 / Cover Letter
      ↓
06 用人单位 Agent 评审与质量门禁
      ↓
07 人工确认并编辑文案
      ↓
08 邮件一键发送 / 私信复制投递 / 导出结果
```

### 8 个 Agent 阶段

| 阶段 | 负责什么 | 留下什么证据 |
| --- | --- | --- |
| 正文覆盖 | 检查岗位详情是否补齐 | 正文状态、来源和覆盖率 |
| 时间标准化 | 把相对时间转成可比较日期 | `scraped_at` 与标准日期 |
| 背景记忆 | 读取简历和背景资料 | 明确存在的候选人事实 |
| 岗位信息 | 提炼职责、要求和投递方式 | 结构化岗位字段 |
| 能力模型 | 建立岗位能力与关键词 | 能力标签和匹配依据 |
| 文案写作 | 生成岗位定制投递文案 | 私信、邮件、Cover Letter |
| 用人单位评审 | 模拟招聘方检查匹配度 | 评分、问题和改写建议 |
| 质量门禁 | 判断结果是否达到交付标准 | 通过 / 重写状态和记录 |

## 求职信生成

产品会把岗位、简历事实和候选人可实习信息组合成一封更接近真实投递场景的 Cover Letter。

### 主题格式

```text
应聘{公司}{岗位}｜{姓名}｜每周可实习{天数}天
```

### 正文结构

1. **开头**：说明学校、专业 / 年级和申请岗位。
2. **经历**：只使用简历中存在的实习、项目、工具和业务事实。
3. **匹配**：把岗位职责和候选人的数据分析、产品、运营或市场能力连接起来。
4. **可用性**：明确每周可实习天数、预计持续时间和入职安排。
5. **结尾**：说明已附简历，留下候选人填写并确认过的联系方式。

### 可填写字段

| 基础信息 | 投递信息 |
| --- | --- |
| 姓名、学校、专业、年级 | 每周可实习天数 |
| 电话 / 微信、邮箱 | 预计连续实习时长 |
| 简历、项目和实习经历 | 目标岗位和岗位偏好 |

候选人信息可以手动填写，也可以通过智能导入简历后确认。系统只把简历和背景资料中明确支持的事实带入文案，避免凭空增加成果、数字、公司经历或联系方式。

## 你可以得到什么

### 岗位研究包

- 岗位标题、公司、发布时间 / 采集时间和来源。
- 岗位职责、任职要求、投递方式和核心能力。
- 正文补全状态、安全验证状态和未完成原因。

### 投递准备包

- 候选人信息和简历证据。
- 岗位匹配分析和能力模型。
- 个性化私信、邮件和 Cover Letter。
- 相关性、证据、表达、可信度和行动就绪度评分。
- AI 从岗位正文提取的邮件 / 私信渠道、可编辑草稿和本地投递状态。

### 可复核产物

```text
data/jobs/<JOB_ID>/artifacts/
├── application_intelligence.json
├── application_intelligence.csv
├── application_intelligence.xlsx
├── workflow-summary.json
├── parallel-body-summary.json
└── artifact-manifest.json
```

## 产品边界与隐私

- 系统不会自动投递；只有用户点击“发送邮件”后，才会通过本机配置的 SMTP 把当前编辑稿发送到该岗位正文中提取出的邮箱。私信仍由用户复制文案并打开原帖发送。
- 每位用户在工作台中填写自己的发件邮箱和客户端授权码；系统按邮箱域名自动配置 SMTP，凭据仅写入本机 Git 忽略文件，不内置任何项目维护者账号。
- 上传文件、背景记忆、任务数据和个人证据默认写入本地 Git 忽略目录。
- API Key 只保存在服务进程内存中，默认 8 小时过期，不写入任务历史、日志、导出文件或 Git。
- 文案只能使用简历和背景记忆中明确存在的事实，不能把不确定信息写成确定经历。
- 遇到安全验证时会暂停全部新增访问并等待人工处理；解除后自动恢复，超时则熔断并保留检查点。首页提供打开验证页、检测 Relay、从检查点续跑的完整恢复入口，不把受限或不完整结果标成可投递。

## 快速开始

第一次使用建议直接阅读[傻瓜式教程](docs/BEGINNER_GUIDE.md)，它按照“启动、登录、连接 AI、导入简历、采集、查看和下载”的实际点击顺序编写。

### 依赖

- Windows 首次启动时，项目会自动准备 Node.js 22+、Python 3.11+、项目依赖和 Chrome/Edge；AI 使用项目内置运行时，不要求用户全局安装 Codex CLI
- 一个可访问的模型服务 Base URL、模型名和 API Key；在页面的 AI Runtime 区域配置后会保存到本机 `data/ai-config.json`

### Windows 一键启动

从 GitHub [下载 ZIP](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/archive/refs/heads/master.zip) 并解压，然后双击根目录的 `start-windows.cmd`。

首次运行会先检查并准备 Windows 运行时、Chrome/Edge 和项目自己的原生 CDP 浏览器，再安装项目依赖、使用仓库内置采集和 AI 运行时构建应用、创建 `.env`，成功后打开：

```text
http://127.0.0.1:4317
```

后续再次启动会复用已经运行的健康实例，不会重复启动服务。

如果新电脑没有安装 OpenClaw Relay，也不需要先手动寻找或配置一个外部 Relay。Windows 启动器会自动发现 Chrome/Edge，并通过原生 CDP 启动独立的项目浏览器 Profile，默认使用本机端口 `18800`；如果没有 Chrome，会通过 `winget` 安装。已有可用 Relay 时项目会直接复用。整个过程使用后台进程和 API，不接管当前鼠标。

启动器检测到没有目标页签时，会先通过代码打开托管浏览器中的小红书登录页；也可以在 Relay 配置区再次点击“打开登录页”。登录完成后，该电脑的浏览器 Profile 会保存登录状态；Cookie 只保存在本机，不会随 GitHub 仓库同步到另一台电脑。

#### 空机首次配置顺序

目标电脑默认没有开发环境时，Windows 启动器按以下顺序执行：

1. 通过系统包管理器准备 Node.js 22+ 和 Python 3.11+。
2. 通过 npm 准备项目使用的命令行工具。
3. 执行 `npm ci`、Python 依赖安装和前端构建。
4. 创建本地 `.env` 并启动页面与 API。
5. 自动启动原生 CDP 浏览器（已有 Relay 时直接复用）；在页面中完成一次目标网站登录。
6. 在页面 AI Runtime 中填写模型服务 Base URL、协议、模型和 API Key，点击连接后运行采集任务。

自动准备 Node.js、Python 和 Chrome 需要 Windows App Installer 提供的 `winget`。系统包管理器本身缺失时，先安装 App Installer；采集运行时随项目 ZIP 分发，模型服务配置保存在每台电脑自己的 `data/ai-config.json`。

### 采集节奏

任务配置区支持“匀速”和“随机节奏”两种模式。随机模式会在最短与最长间隔之间变化滚动和正文请求节奏，默认范围为 `0.8 - 2.4` 秒；匀速模式使用固定间隔。该设置用于降低突发请求与固定节奏风险，实际账号状态仍由平台侧规则决定。

### Linux / macOS

```bash
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
chmod +x start-linux-macos.sh
./start-linux-macos.sh
```

### 只检查环境

```powershell
start-windows.cmd -CheckOnly -NoBrowser
```

```bash
./start-linux-macos.sh --check-only --no-browser
```

输出中的 `ready: true` 表示运行时、项目安装状态和浏览器基础环境满足启动条件；其中 `relayServiceReady: true` 表示浏览器 CDP 已就绪。`npm run preflight` 会继续检查上游采集脚本、模型工具和兼容 Relay 配置。采集任务还需要在本机完成一次浏览器登录，并配置上游脚本和模型服务。详见 [浏览器读取与无 Relay 启动](docs/managed-browser.md)。

<details>
<summary><strong>手动安装、配置和验证</strong></summary>

#### Windows 手动安装

```powershell
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

#### Linux / macOS 手动安装

```bash
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
sh scripts/bootstrap.sh
sh scripts/start.sh
```

#### 本地配置

从 [`.env.example`](.env.example) 复制 `.env`。常用变量如下：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `4317` | 服务端口 |
| `PYTHON_BIN` | 自动探测 | Python 可执行文件 |
| `XHS_AI_CONFIG_PATH` | `data/ai-config.json` | 内置 AI 服务配置和本机密钥 |
| `XHS_UPSTREAM_RUNNER` | 自动发现 | 上游入口脚本 |
| `XHS_UPSTREAM_SCRAPER` | 自动发现 | 正文采集模块 |
| `XHS_SERVER_DATA_DIR` | `data/jobs` | 私有任务数据 |
| `XHS_PROFILE_DATA_DIR` | `data/profiles` | 私有背景记忆 |
| `OPENCLAW_CONFIG_PATH` | 用户目录自动发现 | 仅用于发现并兼容已有 OpenClaw Relay，不是新电脑的必需配置 |
| `XHS_RELAY_CONFIG_PATH` | `data/relay-config.json` | CDP 端口、浏览器 Profile 和开机连接开关；新配置默认 `18800` / `openclaw` |
| `XHS_SMTP_CONFIG_PATH` | `data/smtp-config.json` | 每位用户自己的 SMTP 本地配置；密码不会通过配置查询 API 返回 |
| `XHS_AI_TIMEOUT_SECONDS` | `600` | 单次 AI 调用超时秒数 |
| `SMTP_HOST` / `SMTP_PORT` | 留空 / `587` | 可选邮件服务器；Microsoft 365 使用 `smtp.office365.com:587` |
| `SMTP_SECURE` / `SMTP_REQUIRE_TLS` | `false` / `true` | 587 端口通过 STARTTLS 加密连接 |
| `SMTP_AUTH` | `auto` | `oauth2`、`login` 或无认证本地中继 `none` |
| `SMTP_USER` / `SMTP_PASS` | 留空 | SMTP 登录账号；Outlook OAuth2 不使用 `SMTP_PASS` |
| `SMTP_FROM` | 留空 | 邮件发件地址或 `名称 <邮箱>` |
| `SMTP_OAUTH_TENANT` | `organizations` | Microsoft 365 工作/学校账号；也可填写组织租户 ID |
| `SMTP_OAUTH_CLIENT_ID` | 留空 | Microsoft Entra 应用 Client ID |
| `SMTP_OAUTH_CLIENT_SECRET` | 留空 | 机密客户端可选；公共客户端留空 |
| `SMTP_OAUTH_REFRESH_TOKEN` | 留空 | 获得 `SMTP.Send` 和 `offline_access` 授权后的 Refresh Token |
| `SMTP_OAUTH_SCOPE` | Outlook SMTP scope | SMTP 发送、离线续期和账号识别权限 |

工作台默认只要求填写发件邮箱和密码 / 客户端授权码，并自动识别网易 163/126/yeah、QQ/foxmail、Gmail、Outlook/Hotmail/Live 的 SMTP 参数。企业邮箱或自定义域名可展开“高级设置”手动填写主机、端口和 TLS 参数。网易、QQ 等服务商通常要求使用客户端授权码，而不是网页登录密码。

邮件发送只在三个条件同时成立时启用：AI 文案通过不低于 90 分的质量门禁、岗位正文提取到有效邮箱、本机 SMTP 配置完整。草稿和发送结果写入任务目录的 `delivery-state.json`，不会改写原始 AI 分析文件。

Microsoft 365 Outlook 配置示例（仅写入本机 `.env`，不要提交 Client ID、Refresh Token 或邮箱）：

```dotenv
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_AUTH=oauth2
SMTP_USER=your-account@outlook.com
SMTP_FROM=your-account@outlook.com
SMTP_OAUTH_TENANT=organizations
SMTP_OAUTH_CLIENT_ID=your-entra-application-client-id
SMTP_OAUTH_REFRESH_TOKEN=your-refresh-token
```

推荐用项目内置向导获取授权，不需要在终端输入 Microsoft 密码：

```powershell
npm run configure:outlook -- --client-id YOUR_ENTRA_APP_CLIENT_ID
```

向导会打开 Microsoft 设备登录页；授权完成后仅把邮箱、Client ID 和 Refresh Token 写入 Git 忽略的本机 `.env`，随后验证 SMTP 登录。Entra 应用需要允许目标账号类型和公共客户端流，并配置委托权限 `SMTP.Send`。

个人 Outlook.com 账号则把 `SMTP_HOST` 改为 `smtp-mail.outlook.com`，并把 `SMTP_OAUTH_TENANT` 改为 `consumers`。

#### AI 服务配置

**本地免费模型**

页面内置“本地免费模型库”提供方，通过本机模型服务整理职位文本、背景资料和求职文案，不需要 API Key，也不产生按次调用费用。默认推荐 `qwen3.5:4b`，内置 14 个可一键安装的推荐规格，并允许用户直接填写任意 Ollama 模型 ID 扩展模型库。运行器中已安装的新模型会自动出现在列表中，无需修改代码。

1. 首次使用时，页面自动检测本地运行器；尚未安装时可直接打开官方安装入口。
2. 选择适合电脑配置的模型，点击“一键安装”。页面会持续显示下载与校验进度。
3. 推荐目录外的模型可在“扩展模型”输入 Ollama 模型 ID；安装完成后产品会自动启用。

模型权重不会提交到 Git 仓库。产品会在用户首次选择时通过本机 Ollama 服务自动下载，避免命令行操作和 GitHub 单文件限制。模型来源可在 Ollama 的 [Qwen3.5](https://ollama.com/library/qwen3.5)、[Qwen3](https://ollama.com/library/qwen3)、[Gemma 3](https://ollama.com/library/gemma3)、[Llama 3.2](https://ollama.com/library/llama3.2) 与 [DeepSeek-R1](https://ollama.com/library/deepseek-r1) 模型页核验；实际下载体积与推理速度取决于量化版本、CPU、GPU 和内存。

**OpenAI 兼容中转服务**

在 AI Runtime 的提供方中选择“API 中转站（OpenAI 兼容）”，填写服务商提供的 API Base URL 和 API Key，然后点击“检测模型”。产品会读取账号实际可用的模型列表，并自动处理以下常见地址格式：

- API 根地址，例如 `https://gateway.example/v1`
- 未包含版本路径的地址，例如 `https://gateway.example`，会继续尝试 `/v1`
- 完整接口地址，例如 `https://gateway.example/v1/chat/completions`，会自动整理为 API 根地址

检测成功后选择模型并点击“验证并连接”。鉴权失败、接口路径错误、额度或限流、上游服务异常会显示不同提示。中转配置仅保存在当前设备的 `data/ai-config.json`，查询接口不会返回 API Key，任务历史、日志和 GitHub 也不会包含密钥。

项目内置 AI Runtime，不依赖用户电脑上的 Codex CLI。页面支持 `Responses API` 和 `Chat Completions` 两种协议；选择 Codex 时默认使用 Responses API，直接填写模型服务提供的 Base URL、模型和 API Key 即可。配置保存于本机 `data/ai-config.json`，API Key 不通过配置查询接口返回，也不会写入任务历史、日志或 GitHub。

例如模型服务文档给出 `wire_api = "responses"` 时，在页面选择 `内置 Codex Runtime`、填写模型 `gpt-5.5`、对应 Base URL，协议选择 `Responses API`，再粘贴 API Key。原有 `$CODEX_HOME/config.toml` 和外部 CLI 仍可作为兼容回退，但不是新电脑启动条件。

项目优先使用仓库内置的 `vendor/xiaohongshu-relay-scrape/scripts/` 采集运行时，因此 GitHub 下载包不需要额外安装 Skill。若要切换到本机其他版本，仍可在 `.env` 中填写：

```dotenv
XHS_UPSTREAM_RUNNER=/absolute/path/run_xiaohongshu_relay_scrape.py
XHS_UPSTREAM_SCRAPER=/absolute/path/scrape_xiaohongshu_search.py
```

#### 验证命令

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py" -v
npm run build
npm run preflight
```

#### Windows 登录自启动

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-startup.ps1
powershell -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Remove
```

</details>

## 项目结构

```text
src/                  React + TypeScript 前端工作台
server/               Node.js API、任务编排和 Relay 连接
scripts/              启动、引导、预检和后台工作流脚本
profiles/             不含个人信息的候选人示例结构
docs/                 架构、产品规格和公开截图
tests/                Python 测试
```

## 许可证与公开数据

本项目用于本地研究和求职准备。采集和处理公开岗位信息时，请遵守目标网站规则、适用法律和个人数据最小化原则；不要上传不应公开的简历、联系方式或其他敏感资料到公共仓库。

## 2026-08-01 更新说明

- **原任务原地续跑**：继续采集、补采和安全验证统一复用原任务、原检查点与既有数据，不再为续跑创建新的采集任务；未采集、部分采集、已采集状态可追踪，续跑期间旧结果保持可见。
- **关系扩散独立工作台**：新增独立于内容洞察和受众界面的关系扩散入口，以已有帖子、评论和用户为种子执行有边界的广度优先扩散，支持断点、去重、层级限制和原任务内恢复。
- **逐帖受众 AI 深度分析**：每篇原帖均可独立发起评论、评论线程、评论用户及可选用户主页分析，并结合原帖正文生成有证据定位的洞察；支持取消、同一运行继续、历史版本、覆盖率、部分结果和产物下载。
- **后台资料与 AI 运行增强**：扩展本地背景资料记忆、模型运行时、结构化输出和分析代理，补充配置校验、超时与输出上限，并保持密钥只存放在本机配置中。
- **恢复、证据和数据治理**：完善阶段检查点、正文补全账本、证据跨度校验、SMTP 配置绑定、本地数据保留与删除审计、诊断信息和进程恢复，降低重复采集、错任务写入和无证据结论的风险。
- **质量保障**：增加 Node、Python、API、SQLite、Artifact 和 Playwright 覆盖，并为逐帖受众 AI 提供需求追踪矩阵与真实环境验收记录；功能默认通过 `XHS_AUDIENCE_AI_ENABLED=false` 保持关闭，可按环境逐步启用。
