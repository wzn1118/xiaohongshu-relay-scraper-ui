# 小红书实习岗位采集与投递工作台

[![CI](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/wzn1118/xiaohongshu-relay-scraper-ui/actions/workflows/ci.yml)

> 一个本地优先的岗位研究与求职文案工作台：从已登录浏览器会话中采集小红书公开岗位信息，补全正文，结合可验证的简历事实生成定制私信、邮件和 Cover Letter，并在质量检查通过后由用户手动确认下一步。

## 产品简介

找实习通常不是“搜到一条岗位”就结束：岗位信息分散在卡片和正文中，发布时间需要还原，投递方式需要整理，简历经历还要针对岗位重新组织。本项目把这些步骤串成一条可追踪的本地工作流：

1. **发现岗位**：通过本机已登录浏览器和 OpenClaw Browser Relay，采集公开搜索结果并逐篇补全正文。
2. **理解岗位**：提取职责、任职要求、投递方式、日期和核心能力，保留来源与覆盖状态。
3. **匹配候选人**：上传 PDF、DOCX 等简历，智能识别候选人信息并回填表单；用户可以在生成文案前人工核对和修改。
4. **生成可用文案**：基于岗位要求和简历中的事实，生成第一人称私信、邮件和 Cover Letter。
5. **质量门禁**：由独立评审 Agent 按阈值检查相关性、证据、表达和行动就绪度；未达标的文案会进入重写流程。
6. **人工确认**：系统只准备和复制文案，不自动发送消息或提交申请，最终动作由用户决定。

项目面向需要反复研究岗位、比较匹配度并快速准备个性化文案的求职者。它不替代招聘平台，也不把“启动成功”或“发现卡片”当成任务完成；只有正文、分析、文案、评分和产物检查都完成，任务才会进入可复核状态。

## 产品能力

- 采集所有已发现卡片，`limit=0` 不设 20 条上限，并逐篇补全正文。
- 按每条 `scraped_at` 将“今天、昨天、x 天前、x 小时前”换算为具体日期或时间。
- 上传 PDF、DOCX、TXT、Markdown、JSON、CSV、RTF；AI 只保留材料明确支持的事实，形成可复用背景记忆。
- 智能导入简历后，可识别姓名、学校、专业、年级、联系方式、每周可实习天数和预计实习时长，并回填候选人信息表供人工确认。
- UI 支持 OpenAI、Codex CLI、DeepSeek、Qwen 和自定义 OpenAI 兼容中转站。
- 每条岗位分别提炼职责、要求、投递方式与核心能力，生成第一人称私信、邮件和 Cover Letter。
- 独立“用人单位 Agent”按 100 分制评审；低于 90 分自动重写，达到阈值后才标记为可投递。
- “准备投递”和“准备私聊”会复制对应文案并保存本地处理状态。
- 遇到安全验证时最多等待 10 分钟；超时保留检查点，对已采集正文继续整理和分析。

API Key 只保存在服务进程内存中，默认 8 小时过期；不会写入任务历史、日志、导出文件或 Git。单次 AI 调用默认超时为 600 秒，可在 `.env` 中设置 `XHS_AI_TIMEOUT_SECONDS`；超时会让质量门禁失败，不会把未审完的文案标成可投递。

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
