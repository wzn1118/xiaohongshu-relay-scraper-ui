# 命令、脚本、依赖与启动事实

## Package 基线

- **XHS-CMD-001 [HEAD]**：`package.json` 的 `name` 为 `xiaohongshu-relay-scraper-ui`、`version` 为 `3.0.0`、`private=true`、模块类型为 ESM。
- **XHS-CMD-002 [HEAD]**：提交基线定义 42 个 npm scripts、6 个运行依赖和 8 个开发依赖。
- **XHS-CMD-003 [W]**：截至 2026-08-18 18:49 +08:00，当前工作树在 42 个命令基础上新增 13 个 Codex runtime/connector/TURN 命令，并新增 `ws` 运行依赖；这些属于未提交修改。
- **XHS-CMD-004 [HEAD]**：`npm run dev` 同时启动 `node server/index.mjs` 与 Vite，使用 `concurrently -k` 在任一进程结束时联动关闭。
- **XHS-CMD-005 [HEAD]**：`npm run build` 先执行 TypeScript project build，再执行 Vite production build。
- **XHS-CMD-006 [HEAD]**：`npm start` 直接运行 Node 组合根；生产 PowerShell 入口另有 `start:production`。

## 42 个已提交 npm scripts

| script                                 | `HEAD` 命令                                                | 事实用途                |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| `dev`                                  | `concurrently ... node server/index.mjs ... vite`          | API + Web 开发          |
| `dev:watch`                            | `node --watch server/index.mjs` + Vite                     | API watch 模式          |
| `build`                                | `tsc -b && vite build`                                     | 类型构建 + 前端打包     |
| `build:frontend`                       | `vite build`                                               | 仅前端打包              |
| `start`                                | `node server/index.mjs`                                    | 生产 Node 入口          |
| `mcp:stdio`                            | `node scripts/mcp-stdio-bridge.mjs`                        | MCP stdio 桥            |
| `verify:mcp`                           | `node scripts/verify-mcp-production.mjs`                   | MCP 生产验证            |
| `verify:mcp:showcase`                  | `node scripts/verify-mcp-public-showcase.mjs`              | 匿名 showcase 验证      |
| `start:production`                     | `scripts/start-production-windows.ps1`                     | Windows 生产启动        |
| `stop:production`                      | `scripts/stop-production-windows.ps1`                      | Windows 生产停止        |
| `watchdog:production`                  | `scripts/production-watchdog.ps1`                          | 生产 watchdog           |
| `prepare:portable-runtime`             | `scripts/prepare-portable-runtime.ps1`                     | 便携 runtime 准备       |
| `register:production`                  | `scripts/register-startup.ps1`                             | Windows 启动注册        |
| `provision:hegelsalon:relay`           | `scripts/provision-hegelsalon-relay-tunnel.ps1 -Apply`     | Relay tunnel 配置       |
| `package:production`                   | `scripts/package-windows-production.ps1`                   | Windows 完整生产包      |
| `package:github-release`               | `scripts/package-github-release.ps1`                       | Git archive 一键发布包  |
| `backup:production`                    | `scripts/backup-hegelsalon.ps1`                            | 生产备份                |
| `restore:production`                   | `scripts/restore-hegelsalon.ps1`                           | 生产恢复                |
| `provision:auth`                       | `node scripts/provision-auth.mjs`                          | auth 引导               |
| `configure:outlook`                    | `node scripts/configure-outlook-smtp.mjs`                  | Outlook SMTP/OAuth 配置 |
| `lint`                                 | `node scripts/lint.mjs`                                    | 自定义 lint             |
| `format:check`                         | `node scripts/check-format.mjs`                            | 格式检查                |
| `typecheck`                            | `tsc -b --pretty false`                                    | TypeScript 检查         |
| `test`                                 | `node --test --test-concurrency=4 ...`                     | Node 单元/集成测试      |
| `test:api`                             | 6 个 API/contract test 文件                                | API 子集                |
| `test:artifacts`                       | `tests/mock-runner.test.mjs`                               | Artifact 契约           |
| `test:credentials`                     | `scripts/check-credentials.mjs`                            | 凭据扫描                |
| `test:mailpit`                         | `server/mailpit.integration.mjs`                           | SMTP 隔离实投           |
| `test:e2e`                             | `playwright test`                                          | 浏览器 E2E/视觉         |
| `test:python`                          | `python -m pytest -q`                                      | Python 全量             |
| `test:agents`                          | 指定 intelligence agent test                               | Agent 专项              |
| `audit:dependencies`                   | `npm audit --audit-level=high`                             | 高危依赖审计            |
| `check`                                | lint→format→type→Node→Python→API→build→artifact→credential | 统一质量门              |
| `preflight`                            | `node scripts/preflight.mjs`                               | CLI 预检                |
| `verify:artifacts`                     | `node scripts/verify-artifacts.mjs`                        | 路径/清单/hash 验证     |
| `test:copilot-eval`                    | `node scripts/run-copilot-evals.mjs`                       | Copilot golden eval     |
| `test:copilot-contract`                | protocol + HTTP tests                                      | Copilot contract        |
| `test:copilot-recovery`                | runtime-v2 test                                            | 恢复专项                |
| `test:copilot-migration`               | schema v4 name pattern                                     | SQLite 迁移专项         |
| `test:mcp`                             | `server/mcp-*.test.mjs`                                    | MCP 专项                |
| `cover-letter:external-batch`          | external batch runner                                      | 外部批量改写            |
| `cover-letter:external-until-complete` | until-complete runner                                      | 外部持续批处理          |

- **XHS-CMD-007 [HEAD]**：`check` 不含 Playwright、Mailpit、MCP 专项、Copilot eval 或 npm audit；CI 将其中部分作为独立 job/step 执行。
- **XHS-CMD-008 [HEAD]**：Node test concurrency 在 `npm test` 固定为 4；Playwright 配置则固定 `workers: 1`、`fullyParallel: false`。
- **XHS-CMD-009 [HEAD]**：Copilot migration script 通过 test-name-pattern 只执行 `schema v4 migrates` 相关用例。

## JavaScript/TypeScript 依赖

| 类型    | 包                          | `HEAD` 版本 | 用途证据                         |
| ------- | --------------------------- | ----------- | -------------------------------- |
| runtime | `@modelcontextprotocol/sdk` | `1.30.0`    | MCP Server/Streamable HTTP/types |
| runtime | `busboy`                    | `^1.6.0`    | multipart attachment upload      |
| runtime | `lucide-react`              | `^0.468.0`  | React 图标                       |
| runtime | `nodemailer`                | `^9.0.3`    | SMTP/OAuth 邮件                  |
| runtime | `react`                     | `^19.0.0`   | UI                               |
| runtime | `react-dom`                 | `^19.0.0`   | DOM renderer                     |
| dev     | `@playwright/test`          | `^1.55.1`   | E2E/视觉                         |
| dev     | `@types/node`               | `^22.10.2`  | Node 类型                        |
| dev     | `@types/react`              | `^19.0.3`   | React 类型                       |
| dev     | `@types/react-dom`          | `^19.0.2`   | React DOM 类型                   |
| dev     | `@vitejs/plugin-react`      | `^4.3.4`    | Vite React plugin                |
| dev     | `concurrently`              | `^9.1.0`    | 双进程开发                       |
| dev     | `typescript`                | `~5.7.2`    | 编译/类型检查                    |
| dev     | `vite`                      | `^6.0.5`    | 前端开发/构建                    |

- **XHS-CMD-010 [HEAD]**：MCP SDK 是精确锁定 `1.30.0`，其他大多数 npm 依赖使用 caret；TypeScript 使用 tilde。
- **XHS-CMD-011 [HEAD]**：Node 22 同时出现在 README 环境要求和 CI/setup-node 配置中。
- **XHS-CMD-012 [HEAD]**：代码使用 Node 内建 `node:sqlite` 的 `DatabaseSync`，因此 SQLite 生产 store 不引入第三方数据库包。

## Python 依赖

| 包            | 锁定版本 | 已提交使用方向           |
| ------------- | -------: | ------------------------ |
| `openpyxl`    |    3.1.5 | XLSX 读写                |
| `Pillow`      |   12.3.0 | 图像检测/转换            |
| `playwright`  |   1.57.0 | Python 浏览器/Relay 相关 |
| `pypdf`       |    5.9.0 | PDF 解析                 |
| `pytest`      |    8.4.1 | Python tests             |
| `jsonschema`  |   4.26.0 | 结构化输出/schema 验证   |
| `python-docx` |    1.1.2 | DOCX 解析                |
| `websockets`  |     16.0 | Relay/CDP/WebSocket      |

- **XHS-CMD-013 [HEAD]**：`requirements.txt` 对 8 个 Python 包全部使用 `==` 精确版本。
- **XHS-CMD-014 [HEAD]**：README 支持 Python 3.11+；CI 使用 Python 3.13。
- **XHS-CMD-015 [HEAD]**：mock runner 仅用 Python 标准库，测试其进程与 Artifact 契约时不访问平台页面。

## 一键启动与跨平台入口

- **XHS-CMD-016 [HEAD]**：Windows 用户入口为 `start-windows.cmd`，底层使用 `scripts/one-click.ps1`。
- **XHS-CMD-017 [HEAD]**：macOS/Linux 用户入口为 `start-linux-macos.sh`，底层配套 `scripts/one-click.sh`、`bootstrap.sh` 与 `start.sh`。
- **XHS-CMD-018 [HEAD]**：通用 bootstrap 分别提供 PowerShell 与 shell 版本，负责依赖、构建和验证。
- **XHS-CMD-019 [HEAD]**：`scripts/ensure-windows-prerequisites.ps1` 是 Windows 首次运行前置检查/安装脚本，并被 GitHub 一键发布包要求包含。
- **XHS-CMD-020 [HEAD]**：独立 MCP 入口包括 `start-mcp.cmd`、`mcp-stdio.cmd`、`verify-mcp.cmd` 和 `scripts/mcp-stdio-bridge.mjs`。
- **XHS-CMD-021 [HEAD]**：竞赛入口包括 `start-competition-windows.cmd`、`scripts/start-competition-windows.ps1`、`scripts/package-competition-submission.ps1` 与索引构建脚本。
- **XHS-CMD-022 [HEAD]**：生产运维入口包括 start/stop/watchdog、backup/restore、register-startup、tunnel provision 和 production browser verify。

## 业务脚本分组

- **XHS-CMD-023 [HEAD]**：主流程入口是 `run_project_workflow.py`；应用分析入口是 `run_application_intelligence.py`；受众 AI 入口是 `run_audience_ai.py`；扩展入口是 `run_expansion_workspace.py`。
- **XHS-CMD-024 [HEAD]**：正文恢复相关脚本包括 `body_completion_ledger.py`、`parallel_body_completion.py` 和 `recheck_application_draft.py`。
- **XHS-CMD-025 [HEAD]**：应用生成相关脚本包括 `application_generation.py`、`application_intelligence_agents.py`、`ai_application_workflow.py`、`cover_letter_rewriter.py`。
- **XHS-CMD-026 [HEAD]**：批量 Cover Letter 有 local、external batch、external until-complete 三个 Node 运行器，并有多个 prompt 模板。
- **XHS-CMD-027 [HEAD]**：受众域包括 `audience_collection.py`、`audience_resume.py`、`audience_profile_supplement.py`、`audience_ai_pipeline.py`、`audience_ai_schemas.py`。
- **XHS-CMD-028 [HEAD]**：候选人/事实域包括 `profile_memory.py`、`evidence_claim_validator.py`、`job_role_title.py`、`note_identity.py`。
- **XHS-CMD-029 [HEAD]**：数据和迁移域包括 `artifact_io.py`、`workflow_state.py`、`migrate_application_outreach.py` 与附件/XLSX helper。
- **XHS-CMD-030 [HEAD]**：邮件运维包括 Outlook 配置、mail queue send、subject replay、tailored mail data 生成和 Mailpit integration。

## 发布脚本事实

- **XHS-CMD-031 [HEAD]**：`package-github-release.ps1` 先将 source ref 解析为 commit，再使用 `git archive` 打 ZIP，因此默认只包含提交对象。
- **XHS-CMD-032 [HEAD]**：该脚本要求 README、一键指南、Windows/Linux 入口、bootstrap、prerequisite、package manifests、requirements、env 示例、server entry 与 frontend entry 存在。
- **XHS-CMD-033 [HEAD]**：发布包检查排除 `.git`、`node_modules`、`dist`、`data`、runtime、test results、私有 `.env`、数据库、日志和证书/密钥扩展名。
- **XHS-CMD-034 [HEAD]**：脚本逐个打开 ZIP entry 读取，以检测 archive 损坏，随后生成独立 SHA-256 文件。
- **XHS-CMD-035 [HEAD]**：`verify-github-release.ps1` 解压到随机临时目录，执行 CheckOnly、干净 `npm ci`、pip install、build，再以隔离数据目录启动并轮询 `/api/health`。
- **XHS-CMD-036 [HEAD]**：发布 smoke 默认使用端口 65431，最多轮询 180 次、每次间隔 500 ms；健康响应需 `ok=true` 且 service 为 `xiaohongshu-relay-scraper`。
- **XHS-CMD-037 [HEAD]**：验证脚本仅结束自己启动的 server PID tree，并在 finally 中恢复环境变量和删除其随机临时目录。

## 当前工作树新增命令（尚未提交）

| script                          | 当前命令                     | 状态 |
| ------------------------------- | ---------------------------- | ---- |
| `prepare:codex-desktop`         | provision runtime PowerShell | W/U  |
| `verify:codex-desktop`          | verify runtime Node script   | W/U  |
| `probe:codex:web-runtime`       | web runtime probe            | W/U  |
| `probe:codex:app-server`        | app-server probe             | W/U  |
| `verify:codex:transport-parity` | transport parity             | W/U  |
| `codex:runtime:baseline`        | record known-good runtime    | W/U  |
| `relay:device`                  | device relay                 | W/U  |
| `connector:health`              | connector health             | W/U  |
| `connector:update`              | connector update             | W/U  |
| `connector:rollback`            | connector rollback           | W/U  |
| `verify:codex-connector`        | connector verification       | W/U  |
| `package:codex-connector`       | connector ZIP packaging      | W/U  |
| `configure:codex-turn`          | coturn/product env generator | W/U  |

- **XHS-CMD-038 [W]**：当前 `package.json` 新增 `ws ^8.21.3`，用于未提交设备/浏览器中继实现。
- **XHS-CMD-039 [W]**：`package-lock.json` 同步发生 23 行新增、1 行删除；实际发布依赖仍应以提交后的 lockfile 为准。
- **XHS-CMD-040 [W/U]**：`configure:codex-turn` 调用 `scripts/generate-codex-turn-config.mjs`，生成 coturn config、产品环境片段和部署 README；脚本及其 4-test fixture 当前均未跟踪。
