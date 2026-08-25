# 全项目 Manifest、入口与自动化总表

> 静态扫描日期：2026-08-18（Asia/Shanghai）。
> 口径：12 个逻辑项目；重复 checkout、同源阶段分支、空 Git 根和上层容器不重复计为产品。扫描排除 `node_modules`、`.git`、`dist`、`build`、cache、`output`、`tmp` 与大型运行产物。AsteriaAnalyst 和 hegel-salon 是本轮只读审计 clone；wechat、prompt、skill 对象是外部源码。未读取真实 `.env`、本地 token、key、cookie 或数据库内容。

## 1. 证据标签

| 标签 | 含义                                                         |
| ---- | ------------------------------------------------------------ |
| `W`  | 当前 XHS 工作树或本地未版本化快照；可能包含未提交开发内容。  |
| `H`  | 当前 Git `HEAD` 或 tracked checkout 中直接观察到。           |
| `E`  | 外部公开源码的本地 checkout，仅用于技术研究。                |
| `D`  | README、设计文档或 workflow 声明；不自动升级为本轮运行结果。 |

## 2. 12 个逻辑项目总览

|   # | 逻辑项目                    | 快照/来源              | 主 manifest                                          | 版本                               | 首要入口                                                                                                       | 自动化定义                                         |
| --: | --------------------------- | ---------------------- | ---------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
|   1 | XHS Relay 数据工作台        | `W/H` 当前主仓库       | `package.json`、`requirements.txt`                   | `3.0.0`                            | `server/index.mjs`、`src/main.tsx`、`scripts/run_project_workflow.py`                                          | `.github/workflows/ci.yml`、`release.yml`          |
|   2 | KOLFORGE / MKT大师          | `W` 本地未版本化快照   | `package.json`                                       | `0.1.0`                            | `server/index.mjs`、`src/main.jsx`                                                                             | 未发现根级 GitHub Actions                          |
|   3 | today-you-applied-portable  | `W` 本地便携快照       | `package.json`、`requirements.txt`                   | `3.1.7`                            | `server/index.mjs`、`src/main.tsx`、`scripts/run_project_workflow.py`                                          | `.github/workflows/ci.yml`、`portable-release.yml` |
|   4 | Feishu OpenAI Bot           | `W` Playground 子项目  | `requirements.txt`                                   | 未发现项目版本字段                 | `app.main:app`                                                                                                 | 未发现                                             |
|   5 | Secondary Brightness Widget | `W` Playground 子项目  | 未发现包 manifest                                    | 未发现                             | `RunSecondaryBrightnessWidget.bat` -> `LaunchSecondaryBrightnessWidget.vbs` -> `SecondaryBrightnessWidget.ps1` | 未发现                                             |
|   6 | Playground XHS Scraper      | `W` Playground 子项目  | 未发现包 manifest                                    | 未发现                             | `scrape_xiaohongshu_search.py`、`build_structured_excel.py`                                                    | 未发现                                             |
|   7 | AsteriaAnalyst              | `H` 审计 clone         | `frontend/package.json`、`backend/requirements*.txt` | 前端 `0.1.0`                       | `backend/app/main.py`、`frontend/src/app/*`、`start-asteria.ps1`                                               | `.github/workflows/ci.yml`                         |
|   8 | hegel-salon                 | `H` 审计 clone         | `package.json`、`android-app/package.json`           | 两者均 `0.1.0`                     | `src/server.mjs`、`launch-hegel-salon.ps1`                                                                     | Docker、Compose、Render；未发现 GitHub Actions     |
|   9 | wechat-cli                  | `E/H` shallow checkout | `pyproject.toml`、6 个 npm `package.json`            | Python/根 npm `0.2.4`              | `wechat-cli = wechat_cli.main:cli`                                                                             | 未发现 GitHub Actions                              |
|  10 | wechat-decrypt              | `E/H` shallow checkout | `requirements.txt`                                   | CHANGELOG 写 `1.0.0`，缺包版本字段 | 8 个直接执行的 Python 工具                                                                                     | `.github/workflows/ci.yml`（lint）                 |
|  11 | MDX prompt 分发仓           | `E/H` shallow checkout | 未发现包 manifest                                    | artifact 名称含 v5/v35             | `codex-instruct.py`、`sync-archives.py`                                                                        | `.github/workflows/sync-star-history.yml`          |
|  12 | GPT Skill 聚合源码树        | `E` 外部聚合 checkout  | `burp-mcp-full/build.gradle` 等子项目清单            | Burp MCP `1.0.0`                   | Skill 文档、脚本、Burp MCP bridge                                                                              | 子树含 workflow；不构成统一根构建                  |

## 3. XHS Relay 数据工作台

**根路径**：`C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui`

### 3.1 Manifest

- `package.json`：`name=xiaohongshu-relay-scraper-ui`、`private=true`、`version=3.0.0`、`type=module`。
- `package-lock.json`：Node 依赖锁；当前工作树有修改，应与发布 tag 分开表述。
- `requirements.txt`：8 个精确 Python 版本。
- `tsconfig.json`、`tsconfig.app.json`、`tsconfig.node.json`：TypeScript 构建图。
- `vite.config.ts`：React 插件、Vite `5173`、API/WebSocket 代理。
- `playwright.config.ts`：E2E 的 API/Web 双服务配置。
- `config/codex-config.example.toml`：Codex CLI 示例配置。
- `deploy/cloudflared/config.template.yml`：公网 tunnel 模板。

### 3.2 入口

| 层              | 入口                                                                   | 事实                                             |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Node API        | `server/index.mjs`                                                     | `npm start` 与 `npm run dev` 的服务入口。        |
| React UI        | `src/main.tsx` -> `src/App.tsx`                                        | Vite 页面入口。                                  |
| Python 主工作流 | `scripts/run_project_workflow.py`                                      | 多阶段采集、正文、分析、受众和 artifact 工作流。 |
| MCP stdio       | `scripts/mcp-stdio-bridge.mjs`、`mcp-stdio.cmd`                        | stdio 到 HTTP MCP 的桥接入口。                   |
| MCP HTTP        | `server/mcp-http.mjs`、`server/mcp-runtime.mjs`                        | 独立 loopback MCP 服务。                         |
| Data Copilot    | `server/copilot-runtime-v2.mjs` 等                                     | Copilot session、event、artifact 与 MCP 编排。   |
| 一键启动        | `start-windows.cmd`、`start-linux-macos.sh`、`scripts/one-click.*`     | 检查 Node/Python、安装、启动与健康检测。         |
| 生产运行        | `start-production-windows.cmd`、`scripts/start-production-windows.ps1` | API、浏览器/Relay、MCP 与 tunnel 生产编排。      |
| Windows 打包    | `scripts/package-windows-production.ps1`、`package-github-release.ps1` | 生产目录和洁净发布 ZIP。                         |

### 3.3 自动化

- `ci.yml`：Ubuntu/Windows 双系统 verify、Chromium E2E、Mailpit 集成。
- `release.yml`：Windows 构建、洁净 ZIP、端口 `65431` 健康验证、artifact 与 tag release。
- workflow 存在只证明自动化定义；本轮未以 CI runner 重新执行。

详细清单：[主仓库 scripts/依赖事实](../main/02_PACKAGE_SCRIPTS_DEPENDENCIES.md)、[CI 与发布事实](../main/13_CI_RELEASE_EXACT_FACTS.md)。

## 4. KOLFORGE / MKT大师

**根路径**：`C:/Users/10847/Documents/MKT大师`

### 4.1 Manifest

- `package.json`：`name=reachdesk-kol-workbench`、`private=true`、`version=0.1.0`、`type=module`。
- `package-lock.json`：存在。
- `vite.config.js`：React/Vite 前端与 `/api` proxy。
- 未发现根级 `requirements.txt`、`pyproject.toml`、`Pipfile` 或 Poetry manifest；Python 分析脚本引用第三方库时依赖宿主环境。

### 4.2 入口

| 层                    | 入口                                                                | 事实                                        |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| UI                    | `src/main.jsx`                                                      | 高度集中的 React 工作台入口。               |
| API                   | `server/index.mjs`                                                  | `api`/`start` 脚本以 1 GiB Node heap 启动。 |
| 开发编排              | `scripts/dev-all.mjs`                                               | 同时管理 API 和 Vite。                      |
| 平台采集              | `server/scripts/collect_*`                                          | 小红书、抖音、B 站、视频媒体 Relay 入口。   |
| WUHU 报告             | `scripts/analyze-wuhu-*.py`、`generate-wuhu-mkt-master-report.mjs`  | 数据分析、附录、主报告和 verifier。         |
| MKT MCP               | `mcp/wuhu-mkt-insights-server.mjs`                                  | 营销洞察 MCP server。                       |
| Session Forensics CLI | `session-forensics/cli.mjs`                                         | 会话解析入口。                              |
| Session UI            | `session-forensics/ui-server.mjs`                                   | 本地取证工作台。                            |
| Session MCP           | `mcp/codex-session-forensics-server.mjs`                            | 会话取证 MCP。                              |
| Capability packaging  | `session-forensics/package-cli.mjs`、`build-portable-workbench.mjs` | 能力包和便携工作台生成。                    |

根目录是 0 commit、0 remote 的本地快照；入口事实不等同于提交归属证明。详见 [KOLFORGE 完整事实](../local/KOLFORGE_FACTS.md)。

## 5. today-you-applied-portable

**根路径**：`C:/Users/10847/Documents/today-you-applied-portable`

### 5.1 Manifest

- `package.json`：`name=today-you-applied-portable`、`private=true`、`version=3.1.7`、`type=module`。
- `package-lock.json`、`requirements.txt`、TypeScript configs、`vite.config.ts`、`playwright.config.ts` 均存在。
- `config/codex-config.example.toml` 是便携运行的 Codex 示例。

### 5.2 入口

- Node API：`server/index.mjs`。
- React UI：`src/main.tsx` -> `src/App.tsx`。
- Python 工作流：`scripts/run_project_workflow.py`。
- 一键启动：`一键启动.cmd`、`start-windows.cmd`、`start-linux-macos.sh`、`scripts/one-click.*`。
- 便携 runtime：`scripts/portable-runtime.ps1`。
- 便携 release：`scripts/build-portable-release.ps1`。
- 当前 XHS 主仓库新增的 MCP/Codex Desktop/device/connector 入口不应自动回填到这个 `3.1.7` 快照。

### 5.3 自动化

- `ci.yml`：Node 22、Python 3.13，Windows/Ubuntu verify、Chromium、Mailpit。
- `portable-release.yml`：Windows、Node `22.14.0`、Python `3.13.3`，构建 ZIP/SHA-256 并在 tag 时发 release。

详见 [便携版完整事实](../local/PORTABLE_FACTS.md)。

## 6. Playground 三个子项目

父级 `C:/Users/10847/Documents/Playground` 是空历史 Git 根；三个子项目没有独立 `.git`。

### 6.1 Feishu OpenAI Bot

- `requirements.txt` 是唯一依赖 manifest；没有 Python package metadata 或 lockfile。
- ASGI 入口：`app.main:app`，README 命令为 `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`。
- 主要模块：`app/main.py`（webhook）、`app/feishu.py`、`app/openai_client.py`、`app/store.py`、`app/config.py`。
- 测试入口：`tests/test_main.py`，标准库 `unittest`。

### 6.2 Secondary Brightness Widget

- 未发现依赖 manifest；运行依赖 Windows PowerShell、WinForms、`user32.dll` 与 `dxva2.dll`。
- 启动链：`RunSecondaryBrightnessWidget.bat` -> `LaunchSecondaryBrightnessWidget.vbs` -> `SecondaryBrightnessWidget.ps1`。
- `SecondaryBrightnessWidget.ps1` 也支持 `-PrintStatus` 与 `-SetPercent` CLI 模式。
- `EnableAutostart.ps1`/`DisableAutostart.ps1` 管理 `HKCU/.../Run`。

### 6.3 Playground XHS Scraper

- 未发现依赖 manifest；Python imports 与 PowerShell/Relay 脚本共同定义宿主依赖。
- `scrape_xiaohongshu_search.py`：搜索卡片采集入口。
- `build_structured_excel.py`：JSON 到 XLSX 的结构化导出入口。
- `enable_openclaw_relay.ps1`：Relay 配置辅助入口。
- `package/xiaohongshu-relay-scrape-bundle/` 是分发副本，不另计逻辑项目。

详见 [Playground 完整事实](../local/PLAYGROUND_FACTS.md)。

## 7. AsteriaAnalyst

**审计路径**：`C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.codex-tmp/interview-repo-audit/AsteriaAnalyst`

### 7.1 Manifest

- `frontend/package.json`：`name=frontend`、`version=0.1.0`、`private=true`、Node `>=20.9.0`。
- `frontend/package-lock.json`、`next.config.ts`、PostCSS/TypeScript/ESLint configs 存在。
- `backend/requirements.txt`：15 个精确运行依赖。
- `backend/requirements-dev.txt`：递归安装运行依赖并增加 `pytest==9.0.3`。
- 未发现根级 Python package metadata；后端以源码目录 + requirements 交付。

### 7.2 入口

| 层               | 入口                                                                           | 事实                                                         |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| ASGI API         | `backend/app/main.py` 中 `app = FastAPI(...)`                                  | 启动器使用 `uvicorn app.main:app`。                          |
| Desktop/portable | `backend/run_desktop.py`                                                       | 默认 `127.0.0.1:8787`，直接启动 ASGI app。                   |
| Next UI          | `frontend/src/app/layout.tsx`、`page.tsx`                                      | App Router 根。                                              |
| 业务页面         | `analysis/page.tsx`、`lab/page.tsx`、`lab/method-guide/page.tsx`、`revision/*` | 分析、实验室、方法指南和报告修订入口。                       |
| 双服务启动器     | `start-asteria.ps1`                                                            | 默认后端 `8000`、前端 `3000`，负责 venv/npm/build/健康检查。 |
| Windows 包装     | `start-asteria.cmd`、`launch-asteria-client.*`、`Asteria-launcher.ps1`         | 用户启动和客户端包装。                                       |
| 便携构建         | `scripts/build_portable.ps1`                                                   | CI smoke 的被测 artifact 入口。                              |

### 7.3 CI

- backend job：Python 3.13、安装 dev requirements、`python -m pytest`。
- frontend job：Node 22、`npm ci`、lint、method-guide verifier、build、生产依赖 audit。
- portable-smoke：Windows 构建、解压、端口 `18787`、健康与 5 个页面路径 smoke。
- release：tag 下载已 smoke 的 ZIP，再创建 GitHub release。

详见 [Asteria 完整事实](../public-external/01_ASTERIA_ANALYST_FACTS.md)。

## 8. hegel-salon

**审计路径**：`C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.codex-tmp/interview-repo-audit/hegel-salon`

### 8.1 Manifest

- 根 `package.json`：`name=hegel-salon`、`version=0.1.0`、`private=true`、ESM。
- `package-lock.json`：存在。
- `android-app/package.json`：`name=hegel-salon-android`、`version=0.1.0`、`license=UNLICENSED`。
- `android-app/capacitor.config.json` 与构建 CMD 提供 Android shell。
- `Dockerfile`：Node 22 bookworm slim、`npm ci --omit=dev`、`EXPOSE 3087`。
- `docker-compose.yml`：`3087:3087`、data/local-resources volumes。
- `render.yaml`：Docker runtime、starter plan、1 GiB persistent disk、health `/`。

### 8.2 入口

- `src/server.mjs`：原生 HTTP/HTTPS server，默认 `PORT=3087`，静态资源与 API 同进程。
- `npm run dev` 与 `npm start` 都执行 `node src/server.mjs`。
- `launch-hegel-salon.ps1`：launcher/local/public 三模式。
- `start-hegel-salon.cmd`：以 public + browser 模式调用 launcher。
- `launch-hegel-salon.cmd`：处理 ZIP 预览误启动，再转 PowerShell launcher。
- `src/runUnderstandingEvaluation.mjs`、`runFormalLogicStress.mjs`、`runHistoriographyStress.mjs`、`runQualityOptimizer.mjs`：评测/优化入口。
- `android-app/build-android-apk.cmd` 与 Capacitor scripts：Android 包装入口。
- 本 checkout 未发现 `.github/workflows`；Docker/Render/launcher 是交付定义，不是 CI 运行记录。

详见 [Hegel Salon 完整事实](../public-external/02_HEGEL_SALON_FACTS.md)。

## 9. wechat-cli

**外部路径**：`C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-cli-new`

### 9.1 Manifest

- `pyproject.toml`：`name=wechat-cli`、`version=0.2.4`、Python `>=3.10`。
- Python console script：`wechat-cli = wechat_cli.main:cli`。
- `npm/wechat-cli/package.json`：`@canghe_ai/wechat-cli@0.2.4`、Node `>=14`、Apache-2.0；bin 为 `bin/wechat-cli.js`，postinstall 为 `install.js`。
- 5 个平台包 manifest：darwin arm64/x64、linux arm64/x64、win32 x64。
- 平台包版本并不全相同：darwin-arm64 为 `0.2.4`，其余四个为 `0.2.0`。
- 根 npm wrapper 当前只把 darwin-arm64 `0.2.4` 列为 optional dependency。

### 9.2 入口

- `wechat_cli/main.py`：Click 根命令，注册 `init`、`sessions`、`history`、`search`、`contacts`、`new-messages`、`members`、`export`、`stats`、`unread`、`favorites`。
- `entry.py`：PyInstaller/独立二进制入口。
- `npm/wechat-cli/bin/wechat-cli.js`：按平台解析二进制并转发退出码/信号。
- `npm/scripts/build.py`：平台 npm 包构建脚本。
- checkout 未发现 GitHub Actions 与 tracked 测试套件。

详见 [wechat-cli 外部事实](../public-external/03_WECHAT_CLI_EXTERNAL_FACTS.md)。

## 10. wechat-decrypt

**外部路径**：`C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-decrypt-source`

- 唯一依赖 manifest 是 `requirements.txt`；没有 `pyproject.toml`/`setup.py`/console script。
- `config.example.json` 是运行配置 schema，不是环境变量清单。
- 直接执行入口：`find_all_keys.py`、`decrypt_db.py`、`monitor.py`、`monitor_web.py`、`mcp_server.py`、`find_image_key.py`、`find_image_key_monitor.py`、`latency_test.py`。
- `monitor_web.py` 提供标准库 HTTP/SSE Web 入口；`mcp_server.py` 提供 FastMCP stdio 入口。
- `ci.yml` 仅做 Windows Python 3.11 + Ruff lint。
- `config.json` 是 ignored 本机文件；本轮未读取。

详见 [wechat-decrypt 外部事实](../public-external/04_WECHAT_DECRYPT_EXTERNAL_FACTS.md)。

## 11. MDX prompt 分发仓

**外部路径**：`C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/mdx-gpt-5-6-instruct`

- 未发现 package、requirements、pyproject 或 lockfile。
- `codex-instruct.py`：选择 artifact、备份并更新 Codex `config.toml` 的直接执行脚本。
- `sync-archives.py`：源码与 ZIP 条目一致性检查/同步入口。
- `scripts/*.zip`：11 个 generator/runner/scorer 的归档分发物；普通源码树未展开这些脚本。
- 唯一 workflow `sync-star-history.yml`：Node 20、pnpm `9.15.9`、Python Markdown `3.8.2`，构建双语 README/Star History site 并部署 Pages。
- workflow 的外部 checkout 和临时 backend 是展示链，不是 prompt installer/评测代码的常规回归测试。

详见 [MDX 外部事实](../public-external/05_MDX_PROMPT_REPO_EXTERNAL_FACTS.md)。

## 12. GPT Skill 聚合源码树

**外部路径**：`C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/source`

- 根级未发现统一 package/pyproject/requirements；它是多个来源和能力目录的聚合树。
- `zzy-codex5.6/zzy-Codex-5.6/codex-instruct.py`：Codex instruction 配置脚本副本。
- `zzy-codex5.6/zzy-reverse-skill/skills/*/SKILL.md`：技能入口。
- `CTF-Sandbox-Orchestrator/*/agents/openai.yaml`：多个 Agent 配置入口。
- `burp-mcp-full/build.gradle`：Java 21、group `com.burpmcp`、version `1.0.0`、fat JAR `burp-mcp-full.jar`。
- `burp-mcp-full/mcp-bridge.js`：Node bridge；`BurpMcpExtension.java` 与 `McpHttpServer.java` 是 Java 扩展入口。
- `build.bat`/`build.sh` 与 Gradle 是并存构建路径。
- `kali/scripts/*`、`skills/*/scripts/*` 是工具发现、APK、IDA、radare2、浏览器与图表辅助入口。
- 子树存在 workflow 不代表聚合根有统一 CI；每个来源仍需单独看 license、依赖与状态。

## 13. 重复与排除规则

- 两份 MDX checkout 指向同一 remote、同一 HEAD，本文只列一个逻辑对象。
- XHS `tmp/portable-clone` 与 phase7 checkout 是同源历史/分支快照，不新增产品条目。
- `Playground 2`、`Playground 3` 只有空 Git 根，项目表不纳入。
- `Documents` 顶层 Git 根是容器误初始化，不是应用 manifest 根。
- KOLFORGE、Playground、portable 的 0 commit 本地目录可证明实现文件存在；时间线和 ownership 需要另外的提交、PR 或发布证据。

## 14. 面试检索提示

- 问“入口在哪里”：优先查本文件各项目的“入口”表。
- 问“怎样启动/测试/打包”：查 [全项目命令与依赖](./07_ALL_PROJECT_COMMANDS_DEPENDENCIES.md)。
- 问“端口和环境配置”：查 [全项目环境变量与端口](./08_ALL_PROJECT_ENV_PORTS.md)。
- 问“这些是不是个人原创”：外部源码保持 `E` 标签，本地快照与提交归属分开回答。
