# today-you-applied-portable 完整事实

> 路径：`C:\Users\10847\Documents\today-you-applied-portable`
> 快照时间：2026-08-18
> 定位：主求职工作台的 Windows 便携发布/产品化快照；本地目录自身没有提交和远端。

## 1. 证据结论

### 1.1 Git 与文件状态（F2）

- Git 根目录存在，分支为 `main`。
- `HEAD` 尚未创建，提交数为 0，远端为空。
- `git status --short --untracked-files=all` 返回 394 个未跟踪项。
- 根目录有 21 个文件和 21 个目录；含 `.env`、`node_modules`、运行时、数据、构建、测试结果、输出和 vendor。
- 当前目录像“已解压的便携发布工作区/发布前快照”，不是有完整版本历史的独立仓库。

### 1.2 package.json（F1）

- 包名：`today-you-applied-portable`。
- 版本：`3.1.7`。
- `private: true`，ESM 模块。
- Runtime dependencies：5 个：`busboy`、`lucide-react`、`nodemailer`、`react`、`react-dom`。
- Dev dependencies：8 个：Playwright、Node/React 类型包、Vite React 插件、concurrently、TypeScript、Vite。
- npm scripts：27 个。
- 技术栈清单：React 19、TypeScript 5.7、Vite 6、Node ESM、Python 3.11+ 目标、Playwright、SMTP/Nodemailer、MCP/Data Copilot 相关 Node 模块。

### 1.3 Git 可见文件统计（F2）

| 顶层位置    | 文件数 | 说明                                                    |
| ----------- | -----: | ------------------------------------------------------- |
| `server`    |    140 | Node API、JobManager、Copilot、投递、Relay、SMTP 和测试 |
| `tests`     |     78 | Node/Python fixture、测试与 E2E 配置                    |
| `scripts`   |     62 | Python Runner、AI、迁移、启动、打包、校验脚本           |
| `docs`      |     46 | 架构、PRD、验收、方案、指南                             |
| `src`       |     30 | React/TS UI、Data Copilot、批量投递、样式               |
| 根目录      |     20 | 清单、启动脚本、配置、截图和 TS 配置                    |
| `vendor`    |      5 | 小红书上游脚本及 README/缓存                            |
| `marketing` |      5 | 营销/产品产物                                           |
| `schemas`   |      3 | user problem、workflow event、workflow snapshot schema  |
| `public`    |      1 | 静态资源                                                |
| 其他        |      4 | `.github`、`profiles`、`config`                         |

主要扩展名：160 个 MJS、67 个 Python、52 个 PNG、31 个 Markdown、19 个 TS、18 个 TSX、10 个 JSON、9 个 PS1、9 个 SVG、4 个 Shell、3 个 TXT、2 个 HTML、2 个 YAML。

## 2. 产品事实（F1/F3）

### 2.1 README 定义的用户闭环

README 将产品写成 Windows 10/11 x64 的独立便携应用，帮助学生从小红书发现实习/校招机会、读取正文和图片、匹配简历、生成投递材料、发送邮件或私信，并在收到面试通知后整理面经、准备面试。

用户路径由以下阶段组成：

1. 岗位/经验帖子发现。
2. 正文补全与图片 OCR。
3. 发布时间、时效、岗位职责、要求、地点和联系方式提炼。
4. 简历、个人背景与岗位要求映射。
5. 邮件、私信和 Cover Letter 生成/重写。
6. 用人方视角评分、质量门和人工修改。
7. SMTP 发送或复制私信。
8. 面经、公司评价和非岗位内容研究。
9. Data Copilot 基于已保存的岗位、帖子、评论和个人资料做筛选、比较、排序和追问。

README 还描述产品由真实用户反馈推动了 SMTP 引导、本地模型自动发现、Relay 启动、断点续跑、Data Copilot 和非岗位研究模块。这些是产品文档叙述（F3），不等同于当前回访或独立用户研究结果。

### 2.2 用户体验文档中的数据运行声明（F3）

`README.md` 的真实运行段落记录了一次 2026-08-02 的 20 条真实招聘帖子测试：

- 取得 20 条完整正文。
- 整理 20 张岗位卡。
- 每个岗位准备邮件、站内信或 Cover Letter 草稿。
- 17 条帖子有精确发布时间，3 条使用估算时间。
- 识别 6 个明确联系人和 9 条投递路径。
- 文档明确写出：在线模型写作、招聘方视角复核、真实发送、总耗时变化和面试结果未纳入该轮记录。

上述数字属于 F3 文档声明；没有在本次盘点中重跑该场景。

### 2.3 发布包数据声明与本地目录差异

README/`RELEASE_NOTES.md` 声明发布包包含：

- 715 条岗位原始记录及 API 产物。
- 197 篇研究帖子。
- 4,062 条评论。
- 1,495 位用户及关系扩散产物。

本地解压目录当前 `data` 下只看到：

- `data/browser/` 空目录。
- `data/jobs/portable-expansion-task/` 下 2 个小型 JSON 文件。

这不是直接矛盾：README 描述的是 release ZIP 的内容口径，本地目录是另一次工作区快照；但面试时必须说明“715/197/4062/1495 来自发布说明，当前解压目录未包含同等规模原始数据”（F3/F4/F5）。

## 3. 运行和发布入口（F1）

### 3.1 npm 脚本

| 脚本                                                                                               | 作用                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `dev`                                                                                              | concurrently 启动 Node API 和 Vite                                 |
| `dev:watch`                                                                                        | Node watch + Vite                                                  |
| `build`                                                                                            | `tsc -b && vite build`                                             |
| `build:frontend`                                                                                   | `vite build`                                                       |
| `start`                                                                                            | 启动 `server/index.mjs`                                            |
| `provision:auth`                                                                                   | 初始化认证                                                         |
| `configure:outlook`                                                                                | 配置 Outlook SMTP                                                  |
| `lint` / `format:check` / `typecheck`                                                              | 静态质量门                                                         |
| `test`                                                                                             | Node server/lib/tests 与 `tests/*.test.mjs`                        |
| `test:api`                                                                                         | API 合同、数据生命周期、草稿和 preflight 测试                      |
| `test:artifacts`                                                                                   | fixture runner/artifact 测试                                       |
| `test:credentials`                                                                                 | 凭据扫描                                                           |
| `test:mailpit`                                                                                     | Mailpit 集成                                                       |
| `test:e2e`                                                                                         | Playwright E2E                                                     |
| `test:python`                                                                                      | `python -m pytest -q`                                              |
| `test:agents`                                                                                      | Python application intelligence agent 测试                         |
| `audit:dependencies`                                                                               | 高严重度 npm audit                                                 |
| `check`                                                                                            | lint、格式、类型、Node/Python/API/build/artifact/credential 全链路 |
| `preflight` / `verify:artifacts`                                                                   | 运行环境与产物验证                                                 |
| `test:copilot-eval` / `test:copilot-contract` / `test:copilot-recovery` / `test:copilot-migration` | Data Copilot 评测、协议、恢复、迁移                                |
| `cover-letter:external-batch`                                                                      | 外部批量文案执行入口                                               |

### 3.2 Windows 与便携启动

- `一键启动.cmd` 只是调用 `start-windows.cmd`。
- `start-windows.cmd` 通过 PowerShell `scripts/one-click.ps1` 启动。
- `scripts/one-click.ps1` 负责运行时准备、AI 模型准备、浏览器/Relay、端口和应用启动。
- `start-linux-macos.sh` 提供非 Windows 启动路径。
- `scripts/start.ps1`、`scripts/start.sh` 是源码/本地运行入口。
- `scripts/build-portable-release.ps1` 构建 Windows release。
- `scripts/prepare-portable-job.mjs` 和对应测试处理便携数据准备。
- `scripts/portable-runtime.ps1`、`register-startup.ps1`、`provision-auth.mjs` 支持便携运行和首次设置。

### 3.3 发布说明（F3）

`RELEASE_NOTES.md` 的 3.1.7 条目写明：

- 修复新机器“补全缺失分析”的完整执行链。
- Runner 路径以解压目录为根。
- Windows 文件共享冲突读取/原子替换带重试。
- 批处理不再把单请求 AI 超时当作整任务超时。
- 已被判定为 source-insufficient/ungrounded 的记录按证据限制显示，而不是无限排队。
- 应用在系统默认浏览器打开，受控 Relay 浏览器使用可用 Chromium runtime。

后续条目还记录 3.1.6 的跨包端口复用隔离、3.1.5 的总预算/待处理保留、3.1.4 的绝对路径和历史 attempt 保留、3.1.3 的新机器 data 路径、3.1.2 的 Edge 优先 Relay 启动。

这些条目是 release note 事实，当前本地快照没有 Git 提交可供逐条比对（F3/F5）。

## 4. 架构与数据模型（F1/F3）

### 4.1 分层

`docs/ARCHITECTURE.md` 给出的边界为：

```text
React 工作台 -> Node API -> 本地 Store
                     |-> Python Runner/Agent -> Browser Relay -> 已登录浏览器
                     |-> AI Provider
                     |-> SMTP/Artifacts
```

- React：配置、启动检查、任务控制、结果复核、文案编辑和下载；不直接启动 Runner、页面或 SMTP。
- Node API：请求校验、Job 生命周期、Runner 管理、SSE、产物访问和发送门禁。
- Python Runner/Agent：发现、正文补全、时间标准化、岗位结构化、事实匹配、文案、评分和质量检查。
- 本地数据：Profile、Job、事件、Checkpoint、Draft、Artifact。
- 外部依赖：Relay/CDP、岗位来源、AI Provider、SMTP。

### 4.2 数据对象

| 对象                  | 入口                     | 主要责任                       | 交付物                                     |
| --------------------- | ------------------------ | ------------------------------ | ------------------------------------------ |
| `RunConfig`           | UI、Relay、AI、SMTP      | Node 规范化和 preflight        | Job 配置快照、检查项、失败原因             |
| `SourceRecord`        | 搜索卡片、正文、来源链接 | coverage/time/application-info | note ID、正文状态、岗位事实、覆盖报告      |
| `CandidateProfile`    | 简历和背景资料           | profile-memory                 | source file、evidence id、解析状态         |
| `JobEvent/Checkpoint` | Runner 日志和外部连接    | JobManager 持久化、SSE         | 时间线、快照、续跑入口                     |
| `Draft`               | 岗位事实 + 候选人事实    | writer/review/quality gate     | 私信、邮件、Cover Letter、评分、问题和版本 |
| `Artifact`            | 结果、报告、导出文件     | manifest + SHA-256             | JSON、CSV、XLSX、Markdown、manifest        |

### 4.3 八阶段 Agent

1. `coverage-agent`：发现可访问卡片并补全正文。
2. `time-agent`：按采集时刻标准化相对日期。
3. `profile-memory-agent`：从多格式文件提取背景事实。
4. `application-info-agent`：提炼职责、要求和投递方式。
5. `capability-agent`：生成优先级能力模型。
6. `ai-writer-agent`：根据岗位和证据生成第一人称文案。
7. `employer-review-agent`：独立评分，低于阈值回传重写。
8. `quality-gate-agent`：检查正文覆盖、质量阈值和产物清单。

`docs/ARCHITECTURE.md` 记录默认最低评分门槛为 90 分；`docs/PRODUCT_SPEC.md` 还写明低于阈值最多重写 6 次、默认 4 次。两者属于产品合同/设计口径（F3），实际每次任务结果需看 Job artifact。

### 4.4 Job 状态

设计文档定义：`queued`、`running`、`failed`、`interrupted`、`completed`、`cancelled`。

- 迁移由服务端 JobManager 负责，写入时间、原因、触发来源和进程身份。
- `resumeAvailable` 为真时才允许从失败/中断检查点恢复。
- 前端消费 `snapshot`、`status`、`log`、`artifacts`、`done`、`error` 事件。
- 取消结果不自动标记完成。
- 检测到安全验证时，文档描述全局访问门关闭、worker 暂停、10 分钟熔断、保存检查点和人工恢复入口；流程不进行自动验证处理（F3）。

## 5. 前端模块（F1）

`src` 30 个 Git 可见文件，主要包括：

- `App.tsx`：6,005 行，主工作台。
- `api.ts`：API 访问与类型边界。
- `types.ts`：领域类型。
- `JobJourneyPanel.tsx`：任务进度。
- `BatchApplicationPanel.tsx`：批量投递工作台。
- `AudienceAiPanel.tsx`：受众 AI。
- `DataCopilotContext.tsx`、`DataCopilotContextBrowser.tsx`、`DataCopilotMessage.tsx`、`DataCopilotPanel.tsx`、`data-copilot-transport.ts`：Data Copilot 上下文、消息和传输。
- `ExpansionWorkspace.tsx`：扩展/关系工作区。
- `BodyImportPanel.tsx`、`body-import.ts`：正文导入。
- `UnsavedDraftDialog.tsx`、`useUnsavedDraftGuard.ts`、`draft-state.*`：草稿保护和状态。
- `styles.css`：248,820 bytes，集中式样式。

前端单文件集中度高，适合作为“从产品闭环快速迭代到可用工作台”案例，同时也构成拆分和回归测试压力。

## 6. API 路由事实（F1）

`server/app.mjs` 约 6,279 行，路由按 `parts = pathname.split('/')` 解析。主要路径如下：

### 6.1 应用和基础服务

- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/diagnostics/bundle`
- `GET /api/health`
- `GET|PUT /api/relay/config`
- `GET|PUT|DELETE /api/email/config`
- `POST /api/email/test`
- `GET /api/relay/status`
- `POST /api/relay/connect`
- `POST /api/relay/recover`
- `POST /api/relay/setup`
- `POST /api/relay/login`

### 6.2 AI、Profile、数据生命周期

- `GET /api/ai/providers`
- `GET /api/ai/local-models`
- `POST /api/ai/local-models/install`
- `POST /api/ai/models`
- `POST /api/ai/sessions`
- `GET /api/profiles`
- `POST /api/profiles/import`
- `GET /api/data/ownership`
- `POST /api/data/deletions/preview`
- `POST /api/data/deletions/execute`
- `GET|PUT /api/data/retention`
- `POST /api/data/retention/cleanup`

### 6.3 Job 与扩展

- `GET|POST /api/jobs`
- `POST /api/preflight`
- `POST /api/body-imports`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/experience-snapshot`
- `GET /api/jobs/:id/issues`
- `GET /api/jobs/:id/technical-diagnostics`
- `POST /api/jobs/:id/actions/retry-stage`
- `POST /api/jobs/:id/actions/check-recovery`
- `POST /api/jobs/:id/actions/open-login`
- `POST /api/jobs/:id/resume`
- `POST /api/jobs/:id/complete-missing`
- `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/events`
- `GET /api/jobs/:id/logs`
- `GET /api/jobs/:id/results`
- `GET /api/jobs/:id/application-delivery-candidates`
- `GET|POST /api/jobs/:id/contact-resolution`
- `GET /api/jobs/:id/media`

### 6.4 受众、扩展、附件和投递

- `GET /api/jobs/:id/audience`
- `POST /api/jobs/:id/audience/resume`
- `POST /api/jobs/:id/audience/recover-rate-limit`
- `POST /api/jobs/:id/audience/grow`
- `GET|POST /api/jobs/:id/expansion`
- `POST /api/jobs/:id/expansion/start`
- `POST /api/jobs/:id/expansion/attempts`
- `POST /api/jobs/:id/expansion/resume`
- `POST /api/jobs/:id/expansion/cancel`
- `GET /api/jobs/:id/audience/posts/:postId/ai`
- `POST /api/jobs/:id/audience/posts/:postId/ai/preview`
- `POST /api/jobs/:id/audience/posts/:postId/ai/runs`
- `GET /api/jobs/:id/audience/posts/:postId/ai/events`
- `GET /api/jobs/:id/audience/posts/:postId/ai/results`
- `GET|POST|PATCH|DELETE /api/jobs/:id/application-attachments`
- `POST /api/jobs/:id/application-attachments/from-artifact`
- `POST /api/jobs/:id/application-attachments/from-cover-letter`
- `POST /api/jobs/:id/application-attachments/from-profile`
- `GET /api/jobs/:id/application-attachments/:attachmentId/content`
- `POST /api/jobs/:id/delivery`
- `POST /api/jobs/:id/draft`
- `POST /api/jobs/:id/application-generation/writeback`
- `POST /api/jobs/:id/draft/rewrite`
- `POST /api/jobs/:id/draft/quality`
- `POST /api/jobs/:id/send-email/preview`
- `POST /api/jobs/:id/send-email`
- `GET /api/jobs/:id/artifacts`
- `GET /api/jobs/:id/artifacts/:artifactId`
- `POST /api/jobs/:id/application-batches/dry-run`
- `GET|POST /api/jobs/:id/application-batches`
- `GET /api/jobs/:id/application-batches/:batchId`
- `GET /api/jobs/:id/application-batches/:batchId/events`
- `POST /api/jobs/:id/application-batches/:batchId/approve|start|resume|pause|cancel`

该路由集合说明便携版已经从“抓取页面”发展成 Job、AI、数据治理、受众分析、批量投递和审计边界明确的工作台（F1）。

## 7. 环境变量与默认值（F1/F2）

### 7.1 `.env.example` 统计

- 当前示例文件有 49 个有效赋值行。
- 主要端口：`HOST=127.0.0.1`、`PORT=4317`。
- Python：`PYTHON_BIN` 可留空，Windows 使用 `python`，Linux/macOS 使用 `python3`。
- 数据：`XHS_SERVER_DATA_DIR=./data/jobs`、`XHS_PROFILE_DATA_DIR=./data/profiles`。
- Relay/浏览器：`XHS_BROWSER_PATH`、`XHS_BROWSER_DATA_DIR=./data/browser`、`OPENCLAW_CONFIG_PATH`、`XHS_RELAY_CONFIG_PATH`、`CODEX_CLI_BIN`。
- AI：`XHS_LOCAL_AI_AUTO_SETUP=true`、本地端点 `http://127.0.0.1:11434`、文本模型 `qwen3.5:4b`、视觉模型 `qwen2.5vl:3b`。
- AI 超时：`XHS_AI_TIMEOUT_SECONDS=600`、`XHS_AI_MAX_OUTPUT_TOKENS=4096`。
- OCR：默认本地 OpenAI-compatible endpoint `http://127.0.0.1:11434/v1`，专用 OCR endpoint 默认关闭，并发 2，prefetch 12，图片 batch 4，context 4096，最大输出 256。
- 受众：`XHS_AUDIENCE_AI_ENABLED=true`、Runner `./scripts/run_audience_ai.py`、最大并发 2。
- SMTP：默认 Host 空、Port 587、TLS true，支持 login/oauth2/auto/none；OAuth scope 是 Outlook SMTP Send 组合 scope。
- 附件：最多 5 个文件，单文件 10 MiB，总计 20 MiB。

### 7.2 `server/config.mjs` 代码约束

- API 默认监听 `127.0.0.1:4317`。
- `XHS_AUDIENCE_AI_ENABLED` 默认 false，示例文件显式开启。
- OCR 默认 enabled 和 auto-enabled，超时默认 180 秒，checkpoint 每 5 条，最多 2 次，worker 并发 2，prefetch 12，图片 batch 4。
- `XHS_LOCAL_MODEL_ENDPOINT` 允许本机 HTTP 或非本机 HTTPS，拒绝 URL 内账号/密码；路径会归一化。
- 生产环境默认开启应用认证和 secure cookie；session TTL 默认 8 小时，范围 5 分钟到 7 天。
- Relay monitor 默认 15 秒、连续失败阈值 2、恢复冷却 60 秒、连接超时 25 秒、Playwright 超时 60 秒。
- 最大请求体默认 32 MiB，上限 64 MiB；附件约束由配置单独限制。

### 7.3 文件发现与配置来源

`.env.example` 指出 upstream runner 按 `XHS_UPSTREAM_RUNNER`、项目 `vendor`、`CODEX_HOME` 顺序发现。`server/config.mjs` 还保留 `XHS_RUNNER_PATH`、`XHS_AUDIENCE_AI_RUNNER_PATH`、`OPENCLAW_CONFIG_PATH` 等绝对路径 override。

## 8. Python 工作流（F1）

### 8.1 主要 Runner

| 文件                                         |  行数 | 职责                |
| -------------------------------------------- | ----: | ------------------- |
| `scripts/run_project_workflow.py`            | 2,207 | 主八阶段工作流入口  |
| `scripts/ai_application_workflow.py`         | 3,426 | 求职申请 AI 工作流  |
| `scripts/application_intelligence_agents.py` | 2,159 | 岗位/候选人智能分析 |
| `scripts/audience_ai_pipeline.py`            | 3,077 | 逐帖受众 AI         |
| `scripts/audience_collection.py`             | 2,562 | 评论/用户采集       |
| `scripts/cover_letter_rewriter.py`           | 2,168 | Cover Letter 重写   |
| `scripts/parallel_body_completion.py`        | 2,119 | 并行正文补全        |
| `scripts/expansion_collection.py`            | 1,375 | 关系/扩展采集       |
| `scripts/resolve_application_contacts.py`    | 1,238 | 联系方式解析/OCR    |
| `scripts/workflow_state.py`                  | 1,437 | 工作流状态与快照    |

其他脚本覆盖 AI provider、profile memory、正文 ledger、evidence claim validator、application generation、outreach、job title 归一化、状态迁移和批量执行。

### 8.2 Python 依赖

`requirements.txt` 固定：`openpyxl==3.1.5`、`Pillow==12.3.0`、`playwright==1.57.0`、`pypdf==5.9.0`、`pytest==8.4.1`、`jsonschema==4.26.0`、`python-docx==1.1.2`、`websockets==16.0`。

## 9. 测试资产与当前运行产物（F1/F4）

### 9.1 测试文件统计

- 103 个测试代码文件，约 42,517 行。
- 67 个 Node `*.test.mjs`。
- 28 个 Python `test_*.py`。
- 8 个 Playwright `tests/e2e/*.spec.ts`。
- 测试代码分布：62 个 `server`、40 个 `tests`、1 个 `scripts`。

### 9.2 测试主题

- Server：JobManager、SSE、workflow state、preflight、Relay connect/setup/supervisor/targets、AI session/model、SMTP/mail sender、draft quality、cover letter、application attachments/delivery/batch、Data Copilot runtime/service/store/http、audience AI/results/artifacts、data lifecycle、auth/profile、diagnostics。
- Python：AI application workflow、provider runtime、application generation/intelligence、audience pipeline/collection/profile/resume/state、body completion ledger、Codex runtime/outreach/prompt、cover letter、evidence validator、expansion、resume、relay runner、contact resolution。
- E2E：app runtime smoke、audience AI、batch application、Data Copilot、expansion workspace、job journey progress、profile AI live、unsaved draft guard。

### 9.3 既有测试状态文件

`test-results/playwright/.last-run.json` 内容为：

```json
{ "status": "passed", "failedTests": [] }
```

同目录存在 7 个文件（含 desktop/mobile/tablet 进度截图和 Data Copilot 产物）。这是现存一次 Playwright 状态证据；本次没有重新执行 `npm test` 或 `npm run test:e2e`。

### 9.4 Mock Runner 与产物门

`tests/README.md` 和 `tests/fixtures/mock_xiaohongshu_runner.py` 组成确定性 fixture：

- `success`：退出 0，写 JSON/CSV/XLSX/SHA-256 manifest。
- `failure`：退出 1，写 failed manifest。
- `long`：取消后退出 130，保留部分 checkpoint。
- 支持 `--mock-records`、延迟、长任务时长、取消文件和失败退出码。
- `scripts/verify-artifacts.mjs` 验证路径在 allowlist 内、拒绝符号链接、manifest 中每个 artifact 的大小/SHA-256、JSON note ID 去重、CSV 计数和 XLSX ZIP 结构。

这部分是较强的工程面试证据：把“进程可启动”提升为“状态、产物和校验可复现”。

## 10. 文件系统运行产物（F2/F4）

| 目录              | 文件数 | 大小（MiB） | 事实解释                                        |
| ----------------- | -----: | ----------: | ----------------------------------------------- |
| `.portable-cache` |      3 |      135.48 | Chromium、Node 22.14.0、Python 3.13.3 缓存      |
| `.runtime`        |      0 |           0 | 目录存在但当前为空                              |
| `data`            |      2 |       <0.01 | browser 空目录与 portable-expansion-task 2 文件 |
| `dist`            |      4 |        0.98 | 已有构建产物                                    |
| `docs`            |     46 |        1.50 | 设计/验收/指南                                  |
| `marketing`       |      5 |        0.96 | 营销/产品资料                                   |
| `node_modules`    |  9,252 |      115.57 | 本地安装依赖，不纳入 Git 可见 394 项            |
| `output`          |      5 |        0.61 | Playwright batch application 运行结果           |
| `profiles`        |      1 |       <0.01 | 示例 profile                                    |
| `server`          |    140 |        2.63 | API 与测试                                      |
| `scripts`         |     95 |        3.00 | 运行/发布/校验                                  |
| `tests`           |    136 |        6.02 | 测试源码、fixture 与 E2E 资源                   |
| `test-results`    |      7 |        0.34 | Playwright 状态、截图与失败保留结构             |
| `vendor`          |      9 |        0.35 | 上游 Relay 采集脚本及 Python 缓存               |

`.gitignore` 明确排除 `node_modules`、`dist`、`.runtime`、`.portable-cache`、`data`、`output`、`test-results`、`profiles/*.json`、`.env`、Python cache 和测试缓存；只保留 `profiles/candidate_profile.example.json`。

## 11. CI 与发布工作流（F1/F3）

### 11.1 CI

`.github/workflows/ci.yml`：

- `verify` job 使用 Ubuntu/Windows matrix、Node 22、Python 3.13、`npm ci`、requirements、`npm run check`、`npm run audit:dependencies`。
- `browser` job 在 Ubuntu 安装 Chromium 并运行 Playwright，失败时上传 `test-results/playwright`，保留 7 天。
- `mailpit` job 使用 `axllent/mailpit:v1.30.6`，端口 1025/8025，执行 `npm run test:mailpit`。

### 11.2 Windows Release

`.github/workflows/portable-release.yml`：

- tag `v*` 或手动触发。
- Windows latest，90 分钟上限。
- Node `22.14.0`、Python `3.13.3`。
- 执行 `scripts/build-portable-release.ps1`。
- 上传 ZIP 和 `.sha256`。
- tag 构建时通过 `gh release create` 发布并使用 `RELEASE_NOTES.md`。

### 11.3 发布包边界

README/发布说明声称包内包含 Node、Python、Python 依赖、生产 Node 依赖和 Edge 运行方式；不打入登录态、API Key、邮箱授权码和个人简历。首次启动可能通过 `winget` 安装 Ollama 与下载文本/图像模型。由于当前本地目录没有提交和发布产物 ZIP，具体包内容仍应以 `deliverables` manifest 复核（F3/F5）。

## 12. 隐私、安全和可靠性事实（F1/F3）

- HTTP 默认 loopback。
- API Key 存在内存会话，不进入 Job、日志、历史或 artifact。
- SMTP 只使用用户配置，生产环境认证和 secure cookie 默认开启。
- 邮件收件地址由岗位正文解析，发送接口不接受脱离正文的任意地址（产品规格声明；代码路由可定位）。
- Relay Token 从本机 OpenClaw 配置读取，派生本地鉴权，不返回页面。
- 文件上传、背景记忆、Job 和 Profile 路径均隔离，artifact 下载校验 allowlist 和路径穿越。
- `tests/README.md` 对符号链接、路径逃逸、SHA-256 篡改、JSON/CSV/XLSX 数量一致有明确门禁。
- 仍需补证：真实 SMTP 发送、首次机器自动安装、真实 Relay 登录、发布 ZIP 的脱敏检查和当前 full `npm run check` 结果。

## 13. 面试可用亮点

### 13.1 产品化

- 把需要 Node/Python/浏览器/Relay/AI/SMTP 的多依赖工作台包装成 Windows 一键启动和便携 release。
- 在新机器路径、端口复用、缺失分析、文件共享冲突和模型准备上留下专门的 release note 迭代。

### 13.2 长任务可靠性

- JobManager 拥有状态迁移，Python Runner 通过 checkpoint、SSE、cancel/resume、complete-missing 与 artifact manifest 形成闭环。
- 断点恢复以已有结果、失败阶段、失败原因和 evidence limit 为输入，不把“部分结果”伪装成成功。

### 13.3 AI 产品工程

- AI Writer 与 Employer Review 分离，确定性 quality gate 限制证据越界、元叙述、正文复述和长度异常。
- Data Copilot 具有 runtime、context、tool registry、artifact、approval、migration 和 production test 模块。
- OCR/AI/SMTP 都有显式 timeout、concurrency、size cap 和可恢复状态。

### 13.4 可复现交付

- fixture runner 可覆盖 success/failure/cancel。
- manifest 验证路径、文件大小、SHA-256、JSON/CSV/XLSX 对齐。
- CI 同时覆盖 Windows/Ubuntu、Node/Python、Playwright 和 Mailpit。

## 14. 面试回答边界与待补证

1. 不要说“当前项目有 715 条数据”：正确说法是“发布说明记录便携包包含 715 条岗位；当前本地解压目录只看到 2 个工作流 JSON”。
2. 不要说“当前全量测试通过”：正确说法是“本地已有一次 Playwright `passed` 状态文件；本次没有重跑完整 check”。
3. 不要把 3.1.7 发布说明写成已由当前 Git 提交验证；目录无 commit。
4. 不要把 `vendor/xiaohongshu-relay-scrape` 说成从零原创；应描述为被产品整合的上游/本地 vendor 代码，归属要补证。
5. 不要把 2026-08-02 20 帖测试中的 17/3、6、9 写成当前性能指标；保留“文档记录的一次历史真实数据验收”。
6. 面试前应从 release ZIP、build manifest、当前 commit、full test log、SMTP Mailpit/真实发送和 clean machine 重新建立一套证据链。

## 15. 环境变量完整索引（F1/F2）

### 15.1 `.env.example` 的 49 个公开配置项

```text
HOST
PORT
PYTHON_BIN
CODEX_HOME
XHS_UPSTREAM_RUNNER
XHS_UPSTREAM_SCRAPER
XHS_SERVER_DATA_DIR
XHS_PROFILE_DATA_DIR
XHS_BROWSER_PATH
XHS_BROWSER_DATA_DIR
OPENCLAW_CONFIG_PATH
XHS_RELAY_CONFIG_PATH
CODEX_CLI_BIN
XHS_AI_TIMEOUT_SECONDS
XHS_AI_MAX_OUTPUT_TOKENS
XHS_LOCAL_AI_AUTO_SETUP
XHS_LOCAL_AI_ENDPOINT
XHS_LOCAL_AI_MODEL
XHS_AI_VISION_MODEL
XHS_APPLICATION_CONTACT_OCR_BASE_URLS
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENABLED
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENDPOINT
XHS_APPLICATION_CONTACT_OCR_MODEL
XHS_APPLICATION_CONTACT_OCR_MODEL_PARALLEL
XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS
XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS
XHS_APPLICATION_CONTACT_OCR_KEEP_ALIVE
XHS_APPLICATION_CONTACT_OCR_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_PREFETCH_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_IMAGE_BATCH_SIZE
XHS_AUDIENCE_AI_ENABLED
XHS_AUDIENCE_AI_RUNNER_PATH
XHS_AUDIENCE_AI_MAX_CONCURRENT
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_REQUIRE_TLS
SMTP_AUTH
SMTP_USER
SMTP_PASS
SMTP_FROM
SMTP_OAUTH_TENANT
SMTP_OAUTH_CLIENT_ID
SMTP_OAUTH_CLIENT_SECRET
SMTP_OAUTH_REFRESH_TOKEN
SMTP_OAUTH_SCOPE
XHS_ATTACHMENT_MAX_FILES
XHS_ATTACHMENT_MAX_FILE_BYTES
XHS_ATTACHMENT_MAX_TOTAL_BYTES
```

### 15.2 Server 与 server tests 额外引用的 61 个变量

以下名称出现在 `server/*.mjs`（含测试），但不在 `.env.example` 的 49 项中。它们混合了运行时开关、认证/治理配置、Mailpit 集成参数和测试 fixture 注入值：

```text
APP_MODULE_URL
ATTACHMENT_MODULE_URL
DRAFT_ID
DRAFT_VERSION
FILE_CONTENT
FILE_NAME
GO_FILE
HOME
MAILPIT_HTTP_URL
MAILPIT_SMTP_HOST
MAILPIT_SMTP_PORT
NODE_ENV
NOTE_ID
OUTPUT_DIR
PYTHON
READY_FILE
RECIPIENT
RESULT_DIR
SEND_LOG
SMTP_PROVIDER
USERPROFILE
WORKFLOW_STATE_TEST_PATH
WORKFLOW_STATE_TEST_WRITER
XHS_AI_BASE_URL
XHS_AI_CONFIG_PATH
XHS_AI_MODEL
XHS_AI_PROVIDER
XHS_AI_WIRE_API
XHS_APPLICATION_CONTACT_OCR_AUTO_ENABLED
XHS_APPLICATION_CONTACT_OCR_CHECKPOINT_EVERY
XHS_APPLICATION_CONTACT_OCR_ENABLED
XHS_APPLICATION_CONTACT_OCR_MAX_ATTEMPTS
XHS_APPLICATION_CONTACT_OCR_TIMEOUT_SECONDS
XHS_AUTH_COOKIE_NAME
XHS_AUTH_DATA_DIR
XHS_AUTH_EMAIL
XHS_AUTH_ORIGIN
XHS_AUTH_PASSWORD
XHS_AUTH_REQUIRED
XHS_AUTH_SECURE_COOKIE
XHS_AUTH_SESSION_SECRET_PATH
XHS_AUTH_SESSION_TTL_SECONDS
XHS_AUTH_USERS_PATH
XHS_DATA_RETENTION_PATH
XHS_DELETION_AUDIT_PATH
XHS_DIAGNOSTICS_PATH
XHS_LOCAL_MODEL_ENDPOINT
XHS_MAX_BODY_BYTES
XHS_RATE_LIMIT_AUTO_RECOVERY
XHS_RATE_LIMIT_AUTO_RECOVERY_ATTEMPTS
XHS_RATE_LIMIT_AUTO_RECOVERY_BUSY_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_INITIAL_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_MAX_MS
XHS_RELAY_CONNECT_TIMEOUT_MS
XHS_RELAY_FAILURE_THRESHOLD
XHS_RELAY_MONITOR_INTERVAL_MS
XHS_RELAY_PLAYWRIGHT_TIMEOUT_MS
XHS_RELAY_RECOVERY_COOLDOWN_MS
XHS_RUNNER_PATH
XHS_SMTP_CONFIG_PATH
XHS_STATIC_DIR
```

### 15.3 配置合同差距

- `server/config.mjs` 的 auth、retention、deletion audit、diagnostics、Relay monitor 与 OCR 细分参数没有全部出现在示例文件。
- AI 命名同时存在 `XHS_LOCAL_AI_ENDPOINT`（launcher/example）和 `XHS_LOCAL_MODEL_ENDPOINT`（server config），需由启动脚本映射或统一。
- Server tests 使用大量短生命周期 fixture 变量；发布环境文档应将它们与生产配置分栏。
- `XHS_RATE_LIMIT_AUTO_RECOVERY_*` 说明还存在速率限制自动恢复参数族，应在运行手册中记录默认值、最大尝试和等待预算。
