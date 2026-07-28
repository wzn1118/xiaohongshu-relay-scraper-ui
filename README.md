# 实习岗位采集与投递工作台

基于本机已登录浏览器会话，采集小红书公开搜索结果及完整正文，并把每条内容整理成可执行的岗位记录。产品内置 8 个 Agent 阶段：正文覆盖、时间标准化、个人背景记忆、职责与要求提炼、能力建模、专属文案写作、用人单位评分重写、产物质量门禁。

## 产品能力

- 采集所有已发现卡片，`limit=0` 不设 20 条上限，并逐篇补全正文。
- 按每条 `scraped_at` 将“今天、昨天、x 天前、x 小时前”换算为具体日期或时间。
- 上传 PDF、DOCX、TXT、Markdown、JSON、CSV、RTF；AI 只保留材料明确支持的事实，形成可复用背景记忆。
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
