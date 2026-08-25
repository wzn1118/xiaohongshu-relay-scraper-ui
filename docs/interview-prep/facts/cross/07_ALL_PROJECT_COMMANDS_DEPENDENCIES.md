# 全项目命令与直接依赖总表

> 静态扫描日期：2026-08-18。命令来自 manifest、workflow、README 与启动脚本；“已定义”不表示本轮已执行。依赖只列直接声明，不展开 lockfile 的传递依赖。实际 `.env`、凭据和本地用户数据均未读取。

## 1. 命令面总览

| 项目                   |                        manifest scripts | 其他明确入口                               | 依赖清单状态                                  |
| ---------------------- | --------------------------------------: | ------------------------------------------ | --------------------------------------------- |
| XHS                    |                       54 个 npm scripts | CMD/PowerShell/Shell/Python/MCP            | npm lock + 8 个精确 Python requirements       |
| KOLFORGE               |                       22 个 npm scripts | Python 报告、平台 Relay、Session Forensics | npm lock；缺根级 Python manifest              |
| today portable         |                       27 个 npm scripts | 一键启动、portable runtime/release         | npm lock + 8 个精确 Python requirements       |
| Feishu Bot             |                                       0 | uvicorn、unittest                          | 4 个 Python 范围约束                          |
| Brightness Widget      |                                       0 | BAT/VBS/PowerShell                         | 依赖 Windows 内置运行时/API                   |
| Playground XHS Scraper |                                       0 | 2 个主 Python + Relay PowerShell           | 缺 Python manifest                            |
| Asteria                |                    8 个前端 npm scripts | uvicorn、双服务 launcher、portable builder | npm lock + 15 runtime + pytest dev            |
| hegel-salon            |                       根 10 + Android 3 | Docker/Compose/Render/PowerShell           | npm lock；5 个根 runtime deps                 |
| wechat-cli             | npm wrapper 1 + Python console script 1 | 11 个 Click 子命令、build.py               | pyproject 精确范围；6 个 npm manifests        |
| wechat-decrypt         |                                       0 | 8 个直接 Python 入口                       | 6 个 requirements 范围，另有 1 个 import 漂移 |
| MDX prompt             |                                       0 | 2 个普通 Python + 11 个 ZIP 内工具         | 缺依赖 manifest                               |
| GPT Skill 聚合树       |                        无统一根 scripts | Gradle/BAT/Shell/Python/Skill              | 子项目各自管理；Burp MCP 有 Gradle 依赖       |

## 2. XHS：54 个当前工作树 npm scripts

来源：`package.json`（`W`，与 `HEAD` 的 42 个 script 口径分开）。

| script                                 | 精确命令                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dev`                                  | `concurrently -k -n api,web -c yellow,cyan "node server/index.mjs" "vite"`                                                |
| `dev:watch`                            | `concurrently -k -n api,web -c yellow,cyan "node --watch server/index.mjs" "vite"`                                        |
| `build`                                | `tsc -b && vite build`                                                                                                    |
| `build:frontend`                       | `vite build`                                                                                                              |
| `start`                                | `node server/index.mjs`                                                                                                   |
| `mcp:stdio`                            | `node scripts/mcp-stdio-bridge.mjs`                                                                                       |
| `verify:mcp`                           | `node scripts/verify-mcp-production.mjs`                                                                                  |
| `verify:mcp:showcase`                  | `node scripts/verify-mcp-public-showcase.mjs`                                                                             |
| `start:production`                     | PowerShell `scripts/start-production-windows.ps1`                                                                         |
| `stop:production`                      | PowerShell `scripts/stop-production-windows.ps1`                                                                          |
| `watchdog:production`                  | PowerShell `scripts/production-watchdog.ps1`                                                                              |
| `prepare:portable-runtime`             | PowerShell `scripts/prepare-portable-runtime.ps1`                                                                         |
| `prepare:codex-desktop`                | PowerShell `scripts/provision-codex-desktop-runtime.ps1`                                                                  |
| `verify:codex-desktop`                 | `node scripts/verify-codex-desktop-runtime.mjs`                                                                           |
| `probe:codex:web-runtime`              | `node scripts/probe-codex-web-runtime.mjs`                                                                                |
| `probe:codex:app-server`               | `node scripts/probe-codex-app-server.mjs`                                                                                 |
| `verify:codex:transport-parity`        | `node scripts/verify-codex-transport-parity.mjs`                                                                          |
| `codex:runtime:baseline`               | `node scripts/record-codex-runtime-baseline.mjs`                                                                          |
| `relay:device`                         | `node scripts/codex-device-relay.mjs`                                                                                     |
| `connector:health`                     | `node scripts/codex-local-connector.mjs --health`                                                                         |
| `connector:update`                     | `node scripts/codex-local-connector.mjs --update`                                                                         |
| `connector:rollback`                   | `node scripts/codex-local-connector.mjs --rollback`                                                                       |
| `verify:codex-connector`               | `node scripts/verify-codex-local-connector.mjs`                                                                           |
| `package:codex-connector`              | PowerShell `scripts/package-codex-local-connector.ps1`                                                                    |
| `register:production`                  | PowerShell `scripts/register-startup.ps1`                                                                                 |
| `provision:hegelsalon:relay`           | PowerShell `scripts/provision-hegelsalon-relay-tunnel.ps1 -Apply`                                                         |
| `package:production`                   | PowerShell `scripts/package-windows-production.ps1`                                                                       |
| `package:github-release`               | PowerShell `scripts/package-github-release.ps1`                                                                           |
| `backup:production`                    | PowerShell `scripts/backup-hegelsalon.ps1`                                                                                |
| `restore:production`                   | PowerShell `scripts/restore-hegelsalon.ps1`                                                                               |
| `provision:auth`                       | `node scripts/provision-auth.mjs`                                                                                         |
| `configure:outlook`                    | `node scripts/configure-outlook-smtp.mjs`                                                                                 |
| `lint`                                 | `node scripts/lint.mjs`                                                                                                   |
| `format:check`                         | `node scripts/check-format.mjs`                                                                                           |
| `typecheck`                            | `tsc -b --pretty false`                                                                                                   |
| `test`                                 | `node --test --test-concurrency=4 server/*.test.mjs server/lib/*.test.mjs tests/*.test.mjs`                               |
| `test:api`                             | Node test：app、security、contracts、lifecycle、draft、preflight HTTP                                                     |
| `test:artifacts`                       | `node --test tests/mock-runner.test.mjs`                                                                                  |
| `test:credentials`                     | `node scripts/check-credentials.mjs`                                                                                      |
| `test:mailpit`                         | `node --test server/mailpit.integration.mjs`                                                                              |
| `test:e2e`                             | `playwright test`                                                                                                         |
| `test:python`                          | `python -m pytest -q`                                                                                                     |
| `test:agents`                          | `python tests/test_application_intelligence_agents.py -v`                                                                 |
| `audit:dependencies`                   | `npm audit --audit-level=high`                                                                                            |
| `check`                                | lint -> format -> typecheck -> Node test -> Python test -> API test -> frontend build -> artifact test -> credential scan |
| `preflight`                            | `node scripts/preflight.mjs`                                                                                              |
| `verify:artifacts`                     | `node scripts/verify-artifacts.mjs`                                                                                       |
| `test:copilot-eval`                    | `node scripts/run-copilot-evals.mjs`                                                                                      |
| `test:copilot-contract`                | Node tests：Copilot protocol + Data Copilot HTTP                                                                          |
| `test:copilot-recovery`                | Node test：`server/copilot-runtime-v2.test.mjs`                                                                           |
| `test:copilot-migration`               | 同一测试文件中匹配 `schema v4 migrates`                                                                                   |
| `test:mcp`                             | `node --test server/mcp-*.test.mjs`                                                                                       |
| `cover-letter:external-batch`          | `node scripts/run_external_cover_letter_batch.mjs`                                                                        |
| `cover-letter:external-until-complete` | `node scripts/run_external_cover_letter_until_complete.mjs`                                                               |

### 2.1 XHS Node 直接依赖

| 类型    | 包与约束                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime | `@modelcontextprotocol/sdk=1.30.0`、`busboy^1.6.0`、`lucide-react^0.468.0`、`nodemailer^9.0.3`、`react^19.0.0`、`react-dom^19.0.0`、`ws^8.21.3`                                          |
| dev     | `@playwright/test^1.55.1`、`@types/node^22.10.2`、`@types/react^19.0.3`、`@types/react-dom^19.0.2`、`@vitejs/plugin-react^4.3.4`、`concurrently^9.1.0`、`typescript~5.7.2`、`vite^6.0.5` |

### 2.2 XHS Python 直接依赖

`requirements.txt` 全部精确固定：

| 包            | 版本     |
| ------------- | -------- |
| `openpyxl`    | `3.1.5`  |
| `Pillow`      | `12.3.0` |
| `playwright`  | `1.57.0` |
| `pypdf`       | `5.9.0`  |
| `pytest`      | `8.4.1`  |
| `jsonschema`  | `4.26.0` |
| `python-docx` | `1.1.2`  |
| `websockets`  | `16.0`   |

### 2.3 XHS workflow 精确工具链

- verify matrix：`ubuntu-latest` + `windows-latest`，Node 22、Python 3.13、`npm ci`、pip requirements、`npm run check`、高危 npm audit。
- browser：Ubuntu、Chromium `--with-deps`、`npm run test:e2e`，失败 artifact 保留 7 天。
- mailpit：`axllent/mailpit:v1.30.6`，SMTP `1025`、Web `8025`。
- release：Windows、45 分钟、`npm ci --no-audit --no-fund`、pip、build、打包、`verify-github-release.ps1 -Port 65431`、artifact 30 天、tag 时 `gh release`。

## 3. KOLFORGE：22 个 npm scripts

来源：`C:/Users/10847/Documents/MKT大师/package.json`。

| script                     | 精确命令/入口                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `dev`                      | `vite`                                                                                |
| `api`                      | `node --max-old-space-size=1024 server/index.mjs`                                     |
| `collect:douyin-comments`  | `node server/scripts/collect-douyin-comments-cdp.mjs`                                 |
| `audit:douyin-checkpoints` | `node server/scripts/audit-douyin-api-checkpoints.mjs`                                |
| `merge:douyin-checkpoints` | `node server/scripts/merge-douyin-api-checkpoints.mjs`                                |
| `archive:douyin-comments`  | `node server/scripts/build-douyin-comment-archive.mjs`                                |
| `dev:all`                  | `node scripts/dev-all.mjs`                                                            |
| `build`                    | `vite build`                                                                          |
| `start`                    | `node --max-old-space-size=1024 server/index.mjs`                                     |
| `preview`                  | `vite preview`                                                                        |
| `test:server`              | `node --test server/*.test.mjs`                                                       |
| `mkt:report`               | 连续执行 repeat-user Python、identified appendix Python、master report Node generator |
| `mkt:verify`               | `python -X utf8 -u scripts/verify-wuhu-mkt-master-report.py`                          |
| `mkt:mcp`                  | `node mcp/wuhu-mkt-insights-server.mjs`                                               |
| `session:analyze`          | `node session-forensics/cli.mjs`                                                      |
| `session:verify`           | `node session-forensics/verify.mjs`                                                   |
| `session:package`          | `node session-forensics/package-cli.mjs`                                              |
| `session:package-verify`   | `node session-forensics/package-verify.mjs`                                           |
| `session:mcp`              | `node mcp/codex-session-forensics-server.mjs`                                         |
| `session:ui`               | `node session-forensics/ui-server.mjs`                                                |
| `session:portable`         | `node session-forensics/build-portable-workbench.mjs`                                 |
| `test:session-forensics`   | `node --test --test-reporter=spec session-forensics/*.test.mjs`                       |

### 3.1 KOLFORGE 直接依赖

- `dependencies` 共有 6 个，均写 `latest`：`@vitejs/plugin-react`、`vite`、`typescript`、`react`、`react-dom`、`lucide-react`。
- `devDependencies` 是空对象。
- `package-lock.json` 存在，但 manifest 的 `latest` 会让后续重新解依赖的语义随 registry 时间变化。
- 根级 Python manifest 未发现；静态 imports 显示报告/校验路径使用 `numpy`、`pandas`、`reportlab`、`playwright`，其余主要为标准库。证据：`scripts/analyze-wuhu-mkt-multidimensional.py`、`generate_ai_pm_interview_qa_pdf.py`、`verify-wuhu-*.py`。

## 4. today-you-applied-portable：27 个 npm scripts

| script                        | 精确命令/入口                                                    |
| ----------------------------- | ---------------------------------------------------------------- |
| `dev`                         | concurrently 启动 `server/index.mjs` 与 Vite                     |
| `dev:watch`                   | Node `--watch` + Vite                                            |
| `build`                       | `tsc -b && vite build`                                           |
| `build:frontend`              | `vite build`                                                     |
| `start`                       | `node server/index.mjs`                                          |
| `provision:auth`              | `node scripts/provision-auth.mjs`                                |
| `configure:outlook`           | `node scripts/configure-outlook-smtp.mjs`                        |
| `lint`                        | `node scripts/lint.mjs`                                          |
| `format:check`                | `node scripts/check-format.mjs`                                  |
| `typecheck`                   | `tsc -b --pretty false`                                          |
| `test`                        | Node server/lib/tests glob                                       |
| `test:api`                    | app/contracts/lifecycle/draft/preflight tests                    |
| `test:artifacts`              | mock runner artifact test                                        |
| `test:credentials`            | credential scanner                                               |
| `test:mailpit`                | Mailpit integration                                              |
| `test:e2e`                    | Playwright                                                       |
| `test:python`                 | `python -m pytest -q`                                            |
| `test:agents`                 | application intelligence agents test                             |
| `audit:dependencies`          | npm audit high                                                   |
| `check`                       | lint/format/type/Node/Python/API/build/artifact/credential chain |
| `preflight`                   | Node preflight                                                   |
| `verify:artifacts`            | artifact verifier                                                |
| `test:copilot-eval`           | Copilot eval runner                                              |
| `test:copilot-contract`       | protocol + HTTP tests                                            |
| `test:copilot-recovery`       | Copilot runtime v2 test                                          |
| `test:copilot-migration`      | 匹配 `schema v2 migrates`                                        |
| `cover-letter:external-batch` | 外部 batch runner                                                |

### 4.1 portable 直接依赖

| 类型    | 包与约束                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------- |
| runtime | `busboy^1.6.0`、`lucide-react^0.468.0`、`nodemailer^9.0.3`、`react^19.0.0`、`react-dom^19.0.0`          |
| dev     | 与 XHS 的 Playwright/Node/React types、React Vite plugin、concurrently、TypeScript 5.7、Vite 6 组合一致 |
| Python  | 与 XHS 相同的 8 个精确版本                                                                              |

### 4.2 portable release workflow

- trigger：手动或 `v*` tag。
- runner：Windows，90 分钟。
- Node：`22.14.0`；Python：`3.13.3`。
- 构建：`./scripts/build-portable-release.ps1 -Version <tag>`。
- 产物：`deliverables/today-you-applied-portable-windows-x64.zip` 与 `.sha256`。
- tag 发布：`gh release create`，release notes 来自 `RELEASE_NOTES.md`。

## 5. Playground 命令与依赖

### 5.1 Feishu OpenAI Bot

明确安装/运行命令：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

直接依赖：

| 包                | 约束           |
| ----------------- | -------------- |
| FastAPI           | `>=0.116,<1.0` |
| httpx             | `>=0.28,<1.0`  |
| pydantic-settings | `>=2.10,<3.0`  |
| uvicorn standard  | `>=0.35,<1.0`  |

测试文件使用标准库 `unittest`，没有额外测试 requirement。

### 5.2 Secondary Brightness Widget

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\SecondaryBrightnessWidget.ps1 -PrintStatus
powershell -NoProfile -ExecutionPolicy Bypass -File .\SecondaryBrightnessWidget.ps1 -SetPercent 70
powershell -NoProfile -ExecutionPolicy Bypass -File .\EnableAutostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\DisableAutostart.ps1
```

- GUI 推荐入口：`RunSecondaryBrightnessWidget.bat`。
- 依赖：Windows PowerShell、WinForms、System.Drawing、C# `Add-Type`、`user32.dll`、`dxva2.dll`、DDC/CI 显示器。
- 未发现第三方包清单。

### 5.3 Playground XHS Scraper

明确入口：

```powershell
python .\scrape_xiaohongshu_search.py
python .\build_structured_excel.py
powershell -ExecutionPolicy Bypass -File .\enable_openclaw_relay.ps1
```

- Python 源码显示 Playwright/CDP、OpenPyXL 等能力；目录没有 requirements/pyproject 锁定安装集。
- `package/xiaohongshu-relay-scrape-bundle/scripts/` 是相同工作流的便携副本。

## 6. AsteriaAnalyst 命令与依赖

### 6.1 8 个前端 scripts

| script                        | 精确命令                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `dev`                         | `cross-env NEXT_TELEMETRY_DISABLED=1 next dev --webpack --hostname 127.0.0.1` |
| `dev:turbo`                   | `cross-env NEXT_TELEMETRY_DISABLED=1 next dev --hostname 127.0.0.1`           |
| `build`                       | `cross-env NEXT_TELEMETRY_DISABLED=1 next build`                              |
| `build:export`                | 同时设置 `BUILD_MODE=export` 后 `next build`                                  |
| `start`                       | `next start --hostname 127.0.0.1`                                             |
| `lint`                        | `eslint`                                                                      |
| `render:method-guide-preview` | `node scripts/render-method-guide-preview.cjs`                                |
| `verify:method-guide`         | `node scripts/verify-method-guide.cjs`                                        |

双服务启动器命令事实：

- 后端：venv Python `-m uvicorn app.main:app --host 127.0.0.1 --port <BackendPort>`。
- 前端：Next dev webpack 或 Next production start，host 固定 loopback，port 来自 launcher。
- portable desktop：`python backend/run_desktop.py`，环境默认 host `127.0.0.1`、port `8787`。

### 6.2 Asteria 前端直接依赖

| 类型      | 包                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime   | `@monaco-editor/react^4.7.0`、`clsx^2.1.1`、`echarts^6.1.0`、`echarts-for-react^3.0.6`、`framer-motion^12.38.0`、`lucide-react^1.8.0`、`next=16.2.12`、`pdfjs-dist^5.7.284`、`react=19.2.4`、`react-dom=19.2.4` |
| dev       | Tailwind PostCSS 4、Node/React types、`cross-env^10.1.0`、ESLint 9、Next ESLint 16.2.12、Tailwind 4、TypeScript 5                                                                                               |
| overrides | `dompurify=3.4.12`、`sharp=0.35.3`、Next 的 `postcss=8.5.24`                                                                                                                                                    |

### 6.3 Asteria Python requirements

| 包               | 精确版本       |
| ---------------- | -------------- |
| FastAPI          | `0.135.3`      |
| httpx2           | `2.7.0`        |
| uvicorn standard | `0.44.0`       |
| pandas           | `3.0.2`        |
| openpyxl         | `3.1.5`        |
| duckdb           | `1.5.1`        |
| statsmodels      | `0.14.6`       |
| scikit-learn     | `1.8.0`        |
| python-multipart | `0.0.26`       |
| seaborn          | `0.13.2`       |
| matplotlib       | `3.10.8`       |
| python-docx      | `1.1.2`        |
| pypdf            | `5.4.0`        |
| reportlab        | `4.4.1`        |
| requests         | `2.33.1`       |
| dev addition     | `pytest=9.0.3` |

### 6.4 Asteria CI 命令

- backend：pip upgrade -> install `requirements-dev.txt` -> `python -m pytest`。
- frontend：`npm ci` -> lint -> method-guide verify -> build -> `npm audit --omit=dev --audit-level=high`。
- portable：创建 venv -> pip install -> `npm ci --prefix frontend` -> `scripts/build_portable.ps1` -> 解压 -> 启动 port `18787` -> health/page smoke。

## 7. hegel-salon 命令与依赖

### 7.1 根 scripts

| script                     | 命令                                      |
| -------------------------- | ----------------------------------------- |
| `dev` / `start`            | `node src/server.mjs`                     |
| `eval:understanding`       | `node src/runUnderstandingEvaluation.mjs` |
| `eval:understanding:smoke` | 同入口 `--limit=12`                       |
| `eval:understanding:full`  | 同入口完整模式                            |
| `eval:formal-stress`       | `node src/runFormalLogicStress.mjs`       |
| `eval:historical-stress`   | `node src/runHistoriographyStress.mjs`    |
| `smoke:concept-graph`      | `node src/runConceptGraphSmoke.mjs`       |
| `validate:hegel-graph`     | `node src/validateHegelConceptGraph.mjs`  |
| `optimize:90`              | `node src/runQualityOptimizer.mjs`        |

### 7.2 Android scripts

| script         | 命令                   |
| -------------- | ---------------------- |
| `sync`         | `npx cap sync android` |
| `copy`         | `npx cap copy android` |
| `open:android` | `npx cap open android` |

### 7.3 根直接依赖

- `@capacitor/android^8.3.1`
- `@capacitor/cli^8.3.1`
- `@capacitor/core^8.3.1`
- `nodemailer^8.0.7`
- `openai^6.5.0`
- override：`@xmldom/xmldom^0.8.13`

### 7.4 交付命令

- Docker：Node 22 bookworm slim，`npm ci --omit=dev`，`npm run start`。
- Compose：build 当前目录，映射 `3087:3087`，挂载 data/local-resources volume。
- Render：Docker runtime、health `/`、persistent disk。
- Windows：`launch-hegel-salon.ps1 -Mode launcher|local|public -Port 3087`；CMD 包装 public/browser 模式。

## 8. wechat-cli 外部源码命令与依赖

### 8.1 Python package

- Python `>=3.10`。
- `click>=8.1,<9`。
- `pycryptodome>=3.19,<4`。
- `zstandard>=0.22,<1`。
- console entry：`wechat-cli = wechat_cli.main:cli`。

### 8.2 CLI 命令面

| command          | 主要用途            |
| ---------------- | ------------------- |
| `init`           | 数据目录/密钥初始化 |
| `sessions`       | 最近会话            |
| `history CHAT`   | 会话历史            |
| `search KEYWORD` | 全局或会话搜索      |
| `contacts`       | 联系人              |
| `new-messages`   | 增量消息            |
| `members GROUP`  | 群成员              |
| `export CHAT`    | text/Markdown 导出  |
| `stats CHAT`     | 会话统计            |
| `unread`         | 未读信息            |
| `favorites`      | 收藏查询            |

### 8.3 npm wrapper

- `postinstall`：`node install.js`。
- npm bin：`bin/wechat-cli.js`。
- Node engine `>=14`。
- 根 optional dependency 仅 `@canghe_ai/wechat-cli-darwin-arm64=0.2.4`；其余平台 manifests 存在，但没有进入根 optional dependency 表。

## 9. wechat-decrypt 外部源码命令与依赖

### 9.1 requirements

| 包           | 约束        |
| ------------ | ----------- |
| PyCryptodome | `>=3.20.0`  |
| psutil       | `>=5.9.0`   |
| mcp          | `>=1.0.0`   |
| FastAPI      | `>=0.100.0` |
| uvicorn      | `>=0.24.0`  |
| aiohttp      | `>=3.9.0`   |

`mcp_server.py` 还 import `zstandard`，而 requirements 中未列该包；这是清单与源码的直接差异。

### 9.2 直接入口

```text
python find_all_keys.py
python decrypt_db.py
python monitor.py
python monitor_web.py
python mcp_server.py
python find_image_key.py
python find_image_key_monitor.py
python latency_test.py
```

CI：Windows Python 3.11、安装 requirements 与 Ruff、执行 `ruff check . --select=E,F,W --ignore=E501`；未定义断言式测试 job。

## 10. MDX prompt 分发仓命令与依赖

- `python codex-instruct.py`：交互选择 instruction artifact。
- `python codex-instruct.py --dry-run ...`：预览配置目标和差异。
- `python sync-archives.py --check`：归档一致性检查。
- `python sync-archives.py`：同步归档。
- 当前 checkout 缺 Python dependency manifest；普通脚本以标准库为主。
- workflow 安装 Python `Markdown==3.8.2`；Pages 构建还固定 pnpm `9.15.9`、Node 20，并从外部 Star History 仓执行 frozen install。
- workflow 临时 backend 使用 `127.0.0.1:8080/healthz`；这是 CI 内部服务，不是仓库产品端口。
- 11 个评测工具仅以 ZIP 存在：comparison、generalization bank、prompt bank、safety eval、repair、runner、matrix、visual regression、scorer 等；当前根清单未声明它们各自的 Python 依赖。

## 11. GPT Skill 聚合树命令与依赖

### 11.1 Burp MCP 子项目

`build.gradle`：

| 字段           | 值                                                   |
| -------------- | ---------------------------------------------------- |
| Java           | source/target 21                                     |
| group/version  | `com.burpmcp` / `1.0.0`                              |
| compileOnly    | `net.portswigger.burp.extensions:montoya-api:2025.5` |
| implementation | `gson:2.11.0`、`nanohttpd:2.3.1`                     |
| output         | fat JAR `burp-mcp-full.jar`                          |

- Gradle 路径：`gradle build`/wrapper 语义由 `build.gradle` 定义。
- `build.bat`/`build.sh`：也可下载三项 JAR、直接 `javac`、再打 fat JAR。
- Node bridge：`node mcp-bridge.js`，读取 host/port 配置并把 MCP 调用桥接到扩展 HTTP server。

### 11.2 Skill/工具脚本入口

- Kali：`quick-setup.sh`、`bootstrap-reverse.sh`、`refresh-tool-index.sh`、`ida-start.sh`。
- APK：`decode.ps1/.sh`、`frida-run.ps1/.sh`、`rebuild-sign-install.ps1/.sh`、`manifest-summary.ps1`。
- IDA：`open.ps1`、`start.ps1`。
- radare2：`recon.ps1/.sh`。
- Browser：`browser-automation/scripts/setup.ps1`。
- Diagram：`create_sample_diagrams.py`、`render_diagram.py`。
- 根目录没有统一 lockfile 或跨子项目的一键验证命令；面试中应按具体子项目说明依赖来源。

## 12. 依赖治理横向事实

| 事实                                      | 项目                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| Node + Python 双锁定                      | XHS、today portable、Asteria（分别位于前后端）           |
| Node runtime dependencies 全是具体 semver | XHS、portable、Asteria、Hegel                            |
| manifest 使用 `latest`                    | KOLFORGE                                                 |
| Python 精确 `==`                          | XHS、portable、Asteria                                   |
| Python 范围约束                           | Feishu、wechat-cli、wechat-decrypt                       |
| Python 第三方 imports 缺根清单            | KOLFORGE、Playground scraper、MDX ZIP 工具               |
| 源码 import 与 requirements 漂移          | wechat-decrypt 的 `zstandard`                            |
| 聚合根无统一依赖模型                      | GPT Skill 聚合树                                         |
| 外部 checkout 无常规测试 CI               | wechat-cli、Hegel（无 Actions）；MDX workflow 聚焦 Pages |

## 13. 证据入口

- [Manifest 与入口总表](./06_ALL_PROJECT_MANIFESTS_ENTRYPOINTS.md)
- [环境变量与端口总表](./08_ALL_PROJECT_ENV_PORTS.md)
- [跨项目技术矩阵](./03_CROSS_PROJECT_TECH_MATRIX.md)
- [事实冲突登记](./04_FACT_SOURCE_CONFLICTS.md)
