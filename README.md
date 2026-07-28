# 小红书实习岗位 AI 求职助手

[![CI](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml)

> **从岗位发现，到岗位分析、简历匹配和求职信生成，一次完成。**
>
> 面向实习求职者的本地优先 AI 求职工作台，聚焦 **小红书实习岗位采集、岗位信息结构化、简历智能导入、候选人匹配、个性化私信 / 邮件 / Cover Letter 生成**。

**别再在岗位卡片、正文、简历和邮件之间反复复制粘贴。** 这个项目把零散的岗位研究和重复的投递准备，变成一条可追踪、可复核、以证据为基础的工作流。

## 为什么值得用

| 你遇到的问题 | 这个工作台怎么解决 |
| --- | --- |
| 岗位信息散落在搜索卡片和正文里 | 采集公开搜索结果，逐篇补全正文并整理岗位要点 |
| 同一份简历要反复改成不同版本 | 智能导入 PDF、DOCX 等简历，识别候选人信息并回填表单 |
| 文案看起来像复制招聘要求 | 按岗位职责和简历事实生成第一人称、岗位定制的文案 |
| 写完后不知道是否真的匹配 | 独立用人单位 Agent 按 100 分制评审，低于阈值自动进入重写 |
| 担心工具替自己误投或泄露资料 | 服务默认本地运行，只准备和复制文案，不自动发送或提交申请 |

## 核心工作流

```text
发现岗位 → 补全正文 → 提炼职责与要求 → 简历证据匹配
       → 生成私信 / 邮件 / Cover Letter → 质量评分 → 人工确认
```

### 你可以得到什么

- **岗位研究结果**：具体日期、岗位职责、任职要求、投递方式和核心能力。
- **候选人信息**：姓名、学校、专业、年级、联系方式、每周可实习天数和实习时长，可由简历智能导入后人工核对。
- **个性化文案**：每条岗位独立生成第一人称私信、邮件和 Cover Letter，不直接复述招聘正文。
- **质量结果**：相关性、证据、表达、可信度和行动就绪度评分，以及重写记录。
- **可复核产物**：JSON、CSV、XLSX、Markdown 报告和 SHA-256 文件清单。

## 适合谁

- 正在寻找数据分析、产品、运营、市场、内容或其他实习岗位的求职者。
- 需要批量比较岗位匹配度，同时保持每封投递文案个性化的人。
- 希望简历、岗位分析和投递素材都在本机处理，并保留人工决策权的人。

## 产品能力

- 通过已登录浏览器和 OpenClaw Browser Relay 采集小红书公开岗位信息。
- `limit=0` 支持持续发现已出现的卡片，并逐篇补全正文；相对时间会按 `scraped_at` 标准化。
- 支持 PDF、DOCX、TXT、Markdown、JSON、CSV、RTF 背景资料，AI 只保留材料明确支持的事实。
- UI 支持 OpenAI、Codex CLI、DeepSeek、Qwen 和自定义 OpenAI 兼容中转站。
- 内置 8 个 Agent 阶段：正文覆盖、时间标准化、背景记忆、岗位信息、能力模型、文案写作、用人单位评审、质量门禁。
- 遇到安全验证时保留检查点；超时后继续处理已经采集的完整正文，不把未完成内容标成可投递。

## 产品边界与隐私

- 系统只生成、评审和复制文案，**不会自动发送私信、邮件或提交申请**。
- API Key 只保存在服务进程内存中，默认 8 小时过期，不写入任务历史、日志、导出文件或 Git。
- 上传文件、背景记忆、任务数据和个人证据默认写入本地 Git 忽略目录。
- 文案只能使用简历和背景记忆中明确存在的事实，不编造公司、经历、成果、联系方式或数字。
- 单次 AI 调用默认超时 600 秒；超时会触发质量门禁，不会把未审完的文案标记为可投递。

## 一键启动

依赖：Node.js 22+、Python 3.11+、Codex CLI 或一个受支持的 API Key，以及已配置的 OpenClaw Browser Relay。浏览器需要已登录目标网站并将 Relay 附着到目标标签页。

Windows：从 GitHub [下载 ZIP](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/archive/refs/heads/master.zip) 并解压，然后双击根目录的 `start-windows.cmd`。启动器会在首次运行时自动安装依赖、构建应用、创建 `.env`，启动成功后自动打开 `http://127.0.0.1:4317`。后续双击会直接复用已经运行的健康实例，不会重复启动服务。

Linux/macOS：

```bash
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
chmod +x start-linux-macos.sh
./start-linux-macos.sh
```

只检查环境而不启动：

```powershell
start-windows.cmd -CheckOnly -NoBrowser
```

```bash
./start-linux-macos.sh --check-only --no-browser
```

Windows 可选登录自启动（随时可撤销）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-startup.ps1
powershell -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Remove
```

## 手动安装

Windows：

```powershell
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

Linux/macOS：

```bash
git clone https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
cd xiaohongshu-relay-scraper-ui
sh scripts/bootstrap.sh
sh scripts/start.sh
```

默认访问 `http://127.0.0.1:4317`。首次启动后，在 UI 中配置 AI 并上传个人背景文件，再开始任务。

上游 `xiaohongshu-relay-scrape` 采集 Skill 可位于 `$CODEX_HOME/skills/xiaohongshu-relay-scrape/scripts/`；若安装在其他目录，在 `.env` 中填写：

```dotenv
XHS_UPSTREAM_RUNNER=/absolute/path/run_xiaohongshu_relay_scrape.py
XHS_UPSTREAM_SCRAPER=/absolute/path/scrape_xiaohongshu_search.py
```

运行环境检查：

```powershell
npm run preflight
```

输出中的 `ready: true` 表示应用构建、Python 和上游采集脚本均可用。`codexCli` 与 `openClawConfig` 会单独报告，使用 API 模型时 Codex CLI 可缺省。

## 本地配置

从 [`.env.example`](.env.example) 复制的 `.env` 由启动脚本读取：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `4317` | 服务端口 |
| `PYTHON_BIN` | 自动探测 | Python 可执行文件；Windows 默认 `python`，Linux/macOS 默认 `python3` |
| `XHS_UPSTREAM_RUNNER` | 自动发现 | 上游入口脚本 |
| `XHS_UPSTREAM_SCRAPER` | 自动发现 | 正文采集模块 |
| `XHS_SERVER_DATA_DIR` | `data/jobs` | 私有任务数据 |
| `XHS_PROFILE_DATA_DIR` | `data/profiles` | 私有背景记忆 |
| `OPENCLAW_CONFIG_PATH` | 用户目录自动发现 | 当前 Relay 配置 |
| `XHS_AI_TIMEOUT_SECONDS` | `600` | 单次 AI 调用超时秒数 |

## 产物

每次任务写入 `data/jobs/<JOB_ID>/artifacts/`：

- `application_intelligence.json`：完整岗位、投递方式、能力、文案和评分。
- `application_intelligence.csv` / `.xlsx`：筛选与人工复核表。
- `workflow-summary.json`：8 阶段状态与覆盖率。
- `parallel-body-summary.json`：正文补全和安全验证状态。
- `artifact-manifest.json`：文件大小与 SHA-256。

## 验证

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py" -v
npm run build
npm run preflight
```

Git 会排除 `.env`、API Key、上传文件、解析后的背景记忆、任务数据和本地个人证据。可提交的示例结构见 `profiles/candidate_profile.example.json`。
