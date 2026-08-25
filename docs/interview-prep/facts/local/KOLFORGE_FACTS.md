# KOLFORGE / MKT大师完整事实

> 路径：`C:\Users\10847\Documents\MKT大师`
> 快照时间：2026-08-18
> 定位：本地未版本化的 KOL 建联、内容证据、营销报告和会话取证综合工作区。

## 1. 证据结论

### 1.1 Git 与目录状态（F2）

- Git 根目录存在，分支名为 `master`。
- `HEAD` 尚未创建，提交数为 0。
- 没有远端。
- `git status --short --untracked-files=all` 返回 869 个状态项，全部为未跟踪文件。
- 因为没有提交历史，当前目录可证明“本机存在这些实现”，但提交时间线、增量演进、作者占比和公开发布状态均待补证（F5）。
- 根目录有 36 个文件、32 个目录；存在 `.env`，本次盘点只读取 `.env.example`。

### 1.2 Git 可见文件分布（F2）

| 顶层位置            | 文件数 | 说明                                              |
| ------------------- | -----: | ------------------------------------------------- |
| `tmp`               |    565 | 大量阶段产物、包和临时文件，是 Git 快照的主要部分 |
| `session-forensics` |    106 | 会话取证、能力编译、Agent/MCP/UI 生成子系统       |
| `server`            |    100 | Node API、采集器、存储、分析与测试                |
| `scripts`           |     31 | WUHU 营销分析、报告生成和校验脚本                 |
| 根目录              |     11 | 清单、README、Vite 配置及临时脚本等               |
| `src`               |     10 | React UI 与样式；核心 UI 高度集中在 `main.jsx`    |
| `public`            |      8 | 静态资源                                          |
| `docs`              |      8 | 设计、取证、能力编译和用户研究文档                |
| `mcp`               |      4 | WUHU 洞察与会话取证 MCP 服务器及示例配置          |
| 其他临时/数据位置   |     34 | API smoke、模型和采集实验文件                     |

按扩展名统计的主要 Git 可见文件：309 个 JSON、246 个 MJS、85 个 Markdown、56 个 NDJSON、24 个 PNG、22 个 HTML、21 个 Python、20 个 PYC、16 个 CSS、13 个 JS、9 个 PowerShell、8 个 Shell、8 个 CMD、4 个 ZIP、4 个 YAML、3 个 patch。

### 1.3 代码规模快照（F2）

- 按“`src/server/scripts/mcp/session-forensics`，排除测试、fixture、模板和缓存”的窄口径统计：149 个源码文件。
- 测试代码文件：53 个，其中 49 个 `*.test.mjs`、4 个 `*_test.py`。
- 测试分布：`server` 34 个，`session-forensics` 19 个。
- `src/main.jsx`：9,793 行。
- `server/index.mjs`：6,023 行。
- `server/content-analysis.mjs`：5,793 行。
- `server/config.mjs`：520 行。
- 大文件还包括 `collect_douyin_relay.mjs` 3,075 行、会话取证 UI 3,066 行、会话取证 UI server 3,023 行、`root-capability-packager.mjs` 2,569 行和 `video-analysis.mjs` 2,276 行。
- 行数只说明当前复杂度和模块集中度，不等价于净有效代码或个人独立产出。

## 2. 清单与运行命令（F1）

### 2.1 package.json

- 包名：`reachdesk-kol-workbench`。
- 版本：`0.1.0`。
- `private: true`。
- 模块格式：ESM（`type: module`）。
- npm 脚本：22 个。
- 运行依赖：6 个；`devDependencies` 为空。
- 依赖使用 `latest`，分别是 React、React DOM、Vite、React 插件、TypeScript、Lucide React。
- 依赖未锁定到语义版本范围，虽然存在 `package-lock.json`，仍应把“清单层复现风险”列入工程反思。

### 2.2 npm 脚本

| 脚本                       | 实际命令/目的                                        |
| -------------------------- | ---------------------------------------------------- |
| `dev`                      | 启动 Vite                                            |
| `api`                      | 以 1 GiB Node heap 启动 `server/index.mjs`           |
| `dev:all`                  | 运行 `scripts/dev-all.mjs`，协同启动开发服务         |
| `build`                    | `vite build`                                         |
| `start`                    | 以 1 GiB heap 启动 API                               |
| `preview`                  | Vite preview                                         |
| `test:server`              | `node --test server/*.test.mjs`                      |
| `collect:douyin-comments`  | CDP 抖音评论采集入口                                 |
| `audit:douyin-checkpoints` | 审计抖音 API 检查点                                  |
| `merge:douyin-checkpoints` | 合并抖音检查点                                       |
| `archive:douyin-comments`  | 生成评论归档                                         |
| `mkt:report`               | 连续执行两个 Python 分析脚本和一个 Node 主报告生成器 |
| `mkt:verify`               | Python 校验 WUHU 主报告                              |
| `mkt:mcp`                  | 启动 WUHU 营销洞察 MCP                               |
| `session:analyze`          | 会话取证 CLI                                         |
| `session:verify`           | 验证会话取证产物                                     |
| `session:package`          | 打包会话能力                                         |
| `session:package-verify`   | 校验能力包                                           |
| `session:mcp`              | 启动 Codex 会话取证 MCP                              |
| `session:ui`               | 启动会话取证工作台                                   |
| `session:portable`         | 构建便携会话工作台                                   |
| `test:session-forensics`   | 运行会话取证 spec 测试                               |

## 3. 产品与用户流程（F3）

README 将产品定义为面向品牌市场团队的六步 KOL 建联工作流：

1. 品牌/项目背景。
2. 渠道选择。
3. 真实候选采集。
4. 账号核验。
5. 个性化信息生成。
6. 执行报告。

当前 README 声明覆盖小红书、抖音和 B 站。前端候选、源记录、任务日志与报告指标来自本机 API 任务结果，而不是硬编码展示样本（F3；实现可在 `server/index.mjs`、`src/main.jsx` 和 store 模块中交叉确认到 F1）。

## 4. 前端事实（F1）

### 4.1 技术与入口

- `index.html` + `src/main.jsx` 是前端入口。
- React UI 由 Vite 构建，图标库为 Lucide React。
- Vite 开发服务器代理 `/api` 到 `KOLFORGE_API_TARGET`，未配置时使用 `http://127.0.0.1:${KOLFORGE_PORT}`。
- Vite 配置中的端口回退值为 `8787`。
- watch 明确忽略 `.git`、`node_modules`、`.kolforge-data*`、模型、运行时、工具、persona 数据和 `output`，用于减少采集产物引起的 HMR 风暴。

### 4.2 UI 模块

`src/main.jsx` 中直接存在以下界面/组件：

- `App` 主工作台。
- `DirectCaptureControlPanel` 与 `ContentCaptureModule`。
- `PostSearchWorkbench`、实时进度、媒体预览、评论和作者摘要。
- `CampaignCommandCenter` 与 `CommandPalette`。
- Brief、渠道、连接保活、候选发现、内容采集和内容分析步骤。
- Creator performance、persona、数据台账、内容目录、详情页和内容详情页。
- 多模态覆盖条、视频证据、视频视觉结果、受众洞察和 evidence trace。
- 文案草稿、证据锁定消息、外联队列和报告步骤。
- 抖音评论独立工作台位于 `src/douyin-comments/DouyinCommentWorkspace.jsx`。

### 4.3 前端规模风险

- `src/main.jsx` 单文件 9,793 行，承担状态、路由、数据获取和大量渲染职责。
- 这是“快速形成完整工作台”的证据，也构成拆分、可测试性、局部渲染性能和多人协作风险。
- 面试表达可强调下一步按领域拆分：采集、Creator、内容、视频、受众、外联、报告与共享状态。

## 5. Node API 与路由（F1）

### 5.1 服务边界

- `server/index.mjs` 是单进程 API 与静态资源服务入口。
- `server/config.mjs` 固定 host 为 `127.0.0.1`。
- 默认 API 端口为 `8787`；`.env.example` 当前把 `KOLFORGE_PORT` 设置为 `8798`。
- README 展示的健康检查地址仍是 `http://127.0.0.1:8787/api/health`。
- 因此有三个端口口径：配置默认 8787、示例环境 8798、运行日志中还存在 8796/8797/8798；启动时应以进程实际配置为准（F1/F4/F5）。

### 5.2 当前路由清单

`server/index.mjs` 中可确认的 HTTP 路由包括：

- 健康与配置：`GET /api/health`、`GET /api/runtime-config`。
- 连接器：`GET /api/connectors`、`POST /api/connectors/recheck`、`POST /api/connectors/recover`。
- 帖子搜索：`GET /api/post-search/send-config`、`GET|HEAD /api/post-search/media/stream`、`POST /api/post-search`、`POST /api/post-search/:id/continue`。
- 帖子衍生动作：`POST /api/post-search/comments`、`POST /api/post-search/media`、`POST /api/post-search/profile-analysis`、`POST /api/post-search/follow`、`POST /api/post-search/:id/send`。
- Campaign：`GET|POST /api/campaigns`、`GET|PUT|DELETE /api/campaigns/:id`。
- 外联草稿：`GET|POST /api/campaigns/:id/outreach-drafts` 与单草稿更新/删除。
- 内容历史：`GET /api/content-history`、`GET /api/content-history/detail`、`GET /api/content-history/export`。
- Jobs：`GET /api/jobs`、`POST /api/collect`、`POST /api/enrich`、`POST /api/content-collect`、`POST /api/content-analysis`。
- 受众：`GET /api/audience-insights`、`POST /api/audience-insights/import`。
- Job 恢复与数据：`POST /api/jobs/:id/resume`、personas、content、content samples、content analysis、artifacts、candidates 和单 job 查询。

### 5.3 任务状态（F3/F4）

README 定义状态：`queued -> running -> succeeded / partial_success / waiting_for_connection / failed`。

本地 `.kolforge-data/jobs.json` 聚合结果（仅统计，不暴露任务正文）：

- 文件大小 15,977,301 bytes。
- 根对象包含 `jobs` 和 `campaigns`。
- 48 个 Job、4 个 Campaign。
- Job 类型：14 个 `content`、12 个 `content_analysis`、10 个 `discover`、10 个 `enrich`、2 个 `verify`。
- Job 状态：38 个 `succeeded`、5 个 `partial_success`、3 个 `waiting_for_connection`、2 个 `completed_empty`。
- Job 创建时间从 `2026-07-21T09:01:28.504Z` 到 `2026-07-26T07:02:54.195Z`。
- Campaign 创建最早为 `2026-07-21T11:17:39.103Z`，最后更新时间为 `2026-07-26T09:47:06.389Z`。
- `completed_empty` 出现在运行数据中但未列入 README 状态图，属于状态合同漂移线索（F4/F5）。

## 6. 渠道与连接器（F1/F3）

### 6.1 三平台

- 小红书：Browser Relay 脚本 `collect_xiaohongshu_relay.py`；支持合作方 HTTP 配置。
- 抖音：固定专用 Relay 端口 18801；既有 Python 与 Node 采集器、评论控制器、检查点审计/合并/归档脚本；还预留官方开放平台和合作方 HTTP。
- B 站：Browser Relay 脚本 `collect_bilibili_relay.py`；默认搜索模板是 UP 主搜索。
- 通用 Browser Relay 默认端口 18800。

### 6.2 候选规模配置

- `KOLFORGE_MAX_DISCOVERY_PER_CHANNEL`：默认 15,000，代码限制 30-20,000。
- `KOLFORGE_DISCOVERY_QUERY_VARIANTS`：默认与上限均为 16。
- `KOLFORGE_DISCOVERY_ROUTE_OVERFETCH_RATIO`：默认 1.35，代码限制 1-3。
- `KOLFORGE_BROWSER_RELAY_COLLECTION_TIMEOUT_MS`：默认 1,800,000 ms，代码限制 120,000-4,200,000 ms。
- 候选列表分页在 README 中声明每页 1,000 条（F3）。
- 完成语义要求页面耗尽；时间预算、滚动失败或短时无新增保留为可续跑，而不是直接写成完整覆盖（F3）。

### 6.3 内容规模冲突

- README 的“单次采集容量”段落写“每位达人最多 120 条当前可见内容”（F3）。
- `.env.example` 与 `server/config.mjs` 当前默认 `KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR=10000`，上限也为 10,000（F1）。
- 因此“120”是旧文档口径或另一路默认值；面试材料应以“当前代码上限 10,000，实际停止受公开页面耗尽与运行预算约束”表述，并把 README 差异列为文档债务（F5）。

### 6.4 并发与有界执行

- Creator 内容采集并发默认 2，代码限制 1-4。
- 持久化 worker 在示例配置中为 4。
- 浏览器页面操作保持全局串行；本地工具和单 Creator 产物工作可以重叠。
- 视频分析并发和 Creator pipeline 并发默认各为 2，限制 1-4。
- 远程内容分析 Creator 并发默认 2、最大 8；请求并发默认 6、最大 16。

## 7. 内容分析与多模态证据（F1/F3）

### 7.1 Provider

- 内容分析 provider 支持 `ollama` 和 `openai_responses`。
- 远端默认 base URL 为 `https://api.openai.com/v1`，模型和 Key 必须显式提供。
- 本地 Ollama 默认 base URL 为 `http://127.0.0.1:11434`，模型必须显式提供。
- orchestration 支持 `codex_multi_agent` 和 `evidence_matrix`；默认 `codex_multi_agent`。
- 超时默认 30 秒、代码上限 120 秒；上下文限制为 4,096-8,192。
- 每次多模态请求默认最多 8 张图、单图 4 MiB、总计 16 MiB；代码上限分别为 16 张、8 MiB、32 MiB。

### 7.2 视频流水线

- 默认开启视频分析；未设置视频数时代表处理已捕获的全部公开视频，安全上限来自每 Creator 内容上限。
- 每视频默认采样 4 帧，代码限制 2-8。
- 支持 FFmpeg/FFprobe、RapidOCR、本地 Whisper、可选 FunASR、可选 Ollama vision。
- 浏览器录屏 fallback 默认关闭，因为每个视频固定等待会显著降低全量吞吐。
- 本地媒体缓存默认开启，默认上限 192 MiB，代码限制 16-512 MiB。
- runtime URL 在测试中有“落盘前清除”的覆盖项；视频视觉输出有字段白名单、URL 清理、请求/响应体大小和超时测试（F1/F4）。

### 7.3 外部适配器

README 和配置提供四类边界：

- `video-batch-download`：接收 URL 清单和输出目录。
- `bilicli`：B 站 metadata、评论和弹幕适配。
- `video-copy-analyzer`：对本地媒体做时间戳 ASR 增强。
- `302_video_summary`：可选字幕、摘要、要点和 mind map provider。

输出先归一化，再进入七角色内容矩阵。README 明确表示浏览器 Cookie 和 Relay session 不传给适配器子进程；302 Key 只进入其专用桥接进程，其他下载/OCR/本地摘要子进程不继承该凭据（F3，代码中存在专用 child env 配置，可提升到 F1）。

### 7.4 七角色分析

README 列出的角色维度包括内容策略、商业匹配、受众、安全/审核、视觉、音频和外联；外部摘要被标记为不可信派生内容，并与源 URL、转写/OCR、覆盖率一同送入角色分析（F3）。

## 8. 外联与数据保护（F1）

- 抖音消息模式支持 `local_outbox`、`partner_http`、`browser_relay`。
- 默认消息超时 30 秒，代码限制 1-120 秒。
- `src/main.jsx` 中存在敏感字段正则，匹配 token、cookie、authorization、password、secret、API key 和 session；数据台账展示时用于隐藏敏感字段。
- Browser profile 使用非秘密别名，默认 `attached-browser`。
- Relay 状态目录注释要求只存非秘密健康快照，排除 Cookie、Token、URL 和凭据落盘。
- 实际 `.env` 存在，本次盘点没有读取；凭据管理效果仍需运行级验证（F5）。

## 9. WUHU 营销分析线（F1/F4）

### 9.1 脚本资产

`scripts` 下 31 个 Git 可见文件，包含：

- 受众、深度洞察、多维分析和重复评论者背景分析。
- 主报告、完整评论报告、玩家语境报告、卡牌商业案例等生成器。
- 对应 Python/Node 校验与渲染验证脚本。
- `mkt:report` 和 `mkt:verify` 提供组合执行入口。
- `mcp/wuhu-mkt-insights-server.mjs` 提供营销洞察 MCP。

### 9.2 既有产物

`output` 下存在 WUHU 相关目录：

- `wuhu-cardtoy-business-case-20260817`
- `wuhu-commenter-content-deep-report-20260815`
- `wuhu-full-comment-mkt-report-20260817`
- `wuhu-full-data-insight-20260813`
- `wuhu-grounded-player-context-20260813`
- `wuhu-mkt-audience-analysis-20260814`
- `wuhu-mkt-deep-analysis-20260814`
- `wuhu-mkt-master-strategy-20260814`
- `wuhu-mkt-multidimensional-audience-20260814`

这些目录证明报告流水线运行过，但每个报告的原始输入、口径和验收结果需要在对应产物内单独追溯（F4/F5）。

## 10. 会话取证与能力编译线（F1）

### 10.1 子系统规模

- `session-forensics` 有 106 个 Git 可见文件。
- 其中有 19 个 Node test 文件。
- 提供 CLI、验证器、打包器、UI server、便携工作台构建器和 MCP server。

### 10.2 核心模块

- ChatGPT export store、增量同步和 Codex session sync store。
- Source identity resolver、多源/多会话 reducer。
- Trace IR v1、Capability IR v1、Work Capability IR v2 及 schema/migration。
- Agent UI、MCP、Skill、Work Capability 编译器和 compiler facade。
- 内容寻址证据、项目发现、项目证据、project understanding、project knowledge v4。
- 质量 metric eligibility engine、evaluation gates、scope policy 和 adapter registry。
- Root capability packager 与生成的 Agent/MCP/UI/runtime 模板。
- ChatGPT browser companion 模板和 Codex link runtime。

### 10.3 文档资产

- `CODEX_SESSION_FORENSICS_SOLUTION.md`：全量取证方案、触发逻辑、MCP/UI 和验收。
- `CAPABILITY_COMPILER_V5.md`：两级 IR、兼容桥接、双写、迁移和演进计划。
- `CONVERSATION_DISTILLER_COMPETITIVE_CODE_AUDIT_2026-08-17.md`：竞品对比、架构债务、目标架构与评测门禁。
- `USER_EXPERIENCE_RESEARCH_2026-08-17.md`：931 条会话选择、结果可理解性、包发现和移动端信息密度问题（文档研究结论，F3）。
- `thread-019ffb5e-forensics.md`：单会话工具调用、时间线、补丁、代码与能力包规格。

## 11. 运行数据与磁盘事实（F4）

### 11.1 目录大小

| 目录                              | 文件数 | 大小（MiB） | 最近时间         |
| --------------------------------- | -----: | ----------: | ---------------- |
| `.kolforge-data`                  |    899 |      126.69 | 2026-07-26 17:47 |
| `.kolforge-data-content-at-scale` |      6 |       <0.01 | 2026-07-27 02:08 |
| `.kolforge-data-coverage-matrix`  |      2 |       <0.01 | 2026-07-23 09:59 |
| `.kolforge-models`                |      1 |      141.10 | 2026-07-22 13:12 |
| `dist`                            |     11 |        0.87 | 2026-08-17 19:32 |
| `tmp`                             |    591 |      291.41 | 2026-08-17 20:33 |
| `output`                          |  4,962 |   13,879.72 | 2026-08-18 17:58 |

`output` 约 13.55 GiB，是明显的磁盘、备份、打包和隐私治理风险。目录中包含 clean-install、installer、conversation package、session forensics、Playwright、运行日志、营销报告、浏览器 profile、采集 probe、截图和 ZIP。

### 11.2 `.kolforge-data`

根目录中可见：

- 任务目录、Browser session 健康快照。
- bilicli、video-batch-download、video-copy-analyzer、OCR、Whisper 和 summary 的 live/smoke 产物。
- `jobs.json`、多个 API/server 日志和验证桥接脚本。

这说明适配器做过多轮本地联调，但具体成功口径要以每个目录内 manifest 或日志为准。

## 12. 测试事实（F1/F4）

### 12.1 测试资产

- 53 个测试代码文件：34 个 server、19 个 session-forensics。
- Server 测试覆盖 audience、browser relay preflight、collection timing、connectors、content collection/analysis/store、history、video、enrichment、normalizer、outreach、post search、relay recovery/session/targets、store 和 tool adapters。
- Session forensics 测试覆盖 ChatGPT export/incremental sync、Codex link、compiler facade、capability builder、IR、多会话、多源、packaging、portable UI、scope policy、semantic/source index 和 workspace index。

### 12.2 既有日志

`output/current-server-test.log` 尾部记录一次 135 项 Node 测试：

- pass 127
- fail 8
- skipped 0
- duration 10,954.7141 ms

日志中最后一组覆盖视频浏览器帧、runtime URL 清理、schema 严格校验、Ollama 输出、图片上限、超时和响应体上限。由于该日志有 8 项失败，它只能证明一次部分通过的历史运行，不应描述为当前全绿（F4/F5）。

## 13. 文档与配置冲突清单（F5）

1. API 端口：README 8787；`.env.example` 8798；配置代码默认 8787；运行日志还出现 8796/8797。
2. 每 Creator 内容上限：README 120；当前配置与示例均为 10,000。
3. 状态集合：README 未列 `completed_empty`；本地任务数据有 2 个该状态。
4. package 依赖全部使用 `latest`；可复现依赖主要依靠 lockfile。
5. README 的 `npm install` 与可重复安装策略不一致；正式 CI/发布尚未在该 Git 根目录中找到。
6. `.env`、运行日志、模型、工具、数据和 13.55 GiB 输出都位于工作区，打包清单需要严格 allowlist。
7. 869 个文件全部未跟踪，没有 Git 基线，任何“何时完成”和“谁改了什么”都需要额外证据。
8. 前后端两个超大入口文件和 5,793 行内容分析模块形成模块化债务。

## 14. 面试可用事实与边界

### 可以直接基于代码陈述

- 设计了三平台 connector boundary，并把浏览器串行访问与本地并发处理分开。
- 用 Job 状态、检查点、route exhaustion 和 resumable coverage 表达长任务真实完成度。
- 建立多模态证据适配层，统一下载、ASR、OCR、视觉和摘要产物，再交给角色化分析。
- 对外部摘要标记低信任等级，并将源 URL、OCR/ASR 与 coverage 一同作为引用证据。
- 为会话取证建立两级 IR、编译器、打包、MCP、UI 和验证门禁。
- 为大量运行产物配置 Vite watch ignore，处理 HMR storm 这一具体工程问题。

### 需要保留限定语

- “支持 15,000/20,000 候选”应说成配置目标和代码上限，避免表述成已经稳定完成的单次生产吞吐。
- “处理全部公开视频”只指已捕获可见内容，并受页面耗尽、连接、时间和 10,000 安全上限约束。
- 127/135 的历史测试日志存在失败，不足以用作全绿证明。
- WUHU 报告目录和 48 个 Job 是运行产物，不代表所有链路来自同一版本。
- 项目没有提交和远端，个人贡献范围要用设计文档、会话证据或演示补充。

## 15. 面试前补证优先级

1. 为核心代码建立干净 Git 基线，排除 `tmp/output/data/model/runtime/tool`。
2. 固化 Node/npm/Python 版本和依赖；将 `latest` 改成明确范围并验证 lockfile。
3. 修复或解释历史日志中的 8 个失败，并生成带 commit/hash 的新测试报告。
4. 统一 8787/8798、120/10,000 和状态枚举文档。
5. 对一次完整真实任务保留配置、Job ID、输入规模、阶段耗时、coverage、artifact manifest 和失败恢复证据。
6. 为 13.55 GiB 输出制定保留期、脱敏、归档和可重建策略。
7. 把 `main.jsx`、`server/index.mjs` 和 `content-analysis.mjs` 按领域拆分，并记录前后指标。

## 16. 环境变量完整索引（F1/F2）

### 16.1 `.env.example` 统计

- 有效赋值行 25 个，25 个名称均唯一。
- 注释配置行 81 个，去重后 75 个名称。
- 有效和注释项合并后共 95 个唯一名称。
- 同一变量在不同 provider 示例中重复出现，例如内容分析 provider、消息 connector、渠道 connector 和 summary bridge。

### 16.2 默认启用/赋值的 25 个变量

```text
KOLFORGE_PORT
KOLFORGE_DATA_DIR
KOLFORGE_MAX_DISCOVERY_PER_CHANNEL
KOLFORGE_DISCOVERY_QUERY_VARIANTS
KOLFORGE_DISCOVERY_ROUTE_OVERFETCH_RATIO
KOLFORGE_BROWSER_RELAY_COLLECTION_TIMEOUT_MS
KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR
KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR
KOLFORGE_CONTENT_COLLECTION_CONCURRENCY
KOLFORGE_CONTENT_PERSISTENCE_WORKERS
BROWSER_RELAY_PORT
XIAOHONGSHU_RELAY_PORT
DOUYIN_RELAY_PORT
DOUYIN_MESSAGE_CONNECTOR
DOUYIN_MESSAGE_RELAY_PORT
DOUYIN_MESSAGE_TIMEOUT_MS
KOLFORGE_BROWSER_PROFILE_ALIAS
XIAOHONGSHU_CONNECTOR
XIAOHONGSHU_RELAY_SCRIPT
DOUYIN_CONNECTOR
DOUYIN_RELAY_SCRIPT
DOUYIN_SEARCH_URL_TEMPLATE
BILIBILI_CONNECTOR
BILIBILI_RELAY_SCRIPT
BILIBILI_SEARCH_URL_TEMPLATE
```

### 16.3 注释提供的 75 个唯一变量

```text
BILIBILI_CONNECTOR
BILIBILI_PARTNER_TOKEN
BILIBILI_PARTNER_URL
DOUYIN_CLIENT_KEY
DOUYIN_CLIENT_SECRET
DOUYIN_CONNECTOR
DOUYIN_DEVICE_ID
DOUYIN_MESSAGE_API_TOKEN
DOUYIN_MESSAGE_API_URL
DOUYIN_MESSAGE_CONNECTOR
DOUYIN_MESSAGE_TIMEOUT_MS
DOUYIN_PARTNER_TOKEN
DOUYIN_PARTNER_URL
DOUYIN_PUBLISH_TIME
DOUYIN_SORT_TYPE
KOLFORGE_302_VIDEO_SUMMARY_API_KEY
KOLFORGE_302_VIDEO_SUMMARY_API_URL
KOLFORGE_302_VIDEO_SUMMARY_ENABLED
KOLFORGE_302_VIDEO_SUMMARY_LANGUAGE
KOLFORGE_302_VIDEO_SUMMARY_MAX_TOKENS
KOLFORGE_302_VIDEO_SUMMARY_MODEL
KOLFORGE_302_VIDEO_SUMMARY_REQUEST_TIMEOUT_MS
KOLFORGE_302_VIDEO_SUMMARY_TIMEOUT_MS
KOLFORGE_BILICLI_ARGS
KOLFORGE_BILICLI_COMMAND
KOLFORGE_BILICLI_CWD
KOLFORGE_BILICLI_TIMEOUT_MS
KOLFORGE_BROWSER_SESSION_STATE_DIR
KOLFORGE_CONTENT_ANALYSIS_API_KEY
KOLFORGE_CONTENT_ANALYSIS_BASE_URL
KOLFORGE_CONTENT_ANALYSIS_CONTEXT_LENGTH
KOLFORGE_CONTENT_ANALYSIS_MODEL
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGE_BYTES
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGES
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_TOTAL_BYTES
KOLFORGE_CONTENT_ANALYSIS_OLLAMA_BASE_URL
KOLFORGE_CONTENT_ANALYSIS_OLLAMA_MODEL
KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION
KOLFORGE_CONTENT_ANALYSIS_PROVIDER
KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY
KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY
KOLFORGE_CONTENT_ANALYSIS_TIMEOUT_MS
KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY
KOLFORGE_VIDEO_ANALYSIS_ENABLED
KOLFORGE_VIDEO_ANALYSIS_FRAMES_PER_VIDEO
KOLFORGE_VIDEO_ANALYSIS_SAMPLES_PER_CREATOR
KOLFORGE_VIDEO_ANALYSIS_TIMEOUT_MS
KOLFORGE_VIDEO_BATCH_DOWNLOAD_ARGS
KOLFORGE_VIDEO_BATCH_DOWNLOAD_COMMAND
KOLFORGE_VIDEO_BATCH_DOWNLOAD_CWD
KOLFORGE_VIDEO_BATCH_DOWNLOAD_TIMEOUT_MS
KOLFORGE_VIDEO_BROWSER_RECORDING_FALLBACK
KOLFORGE_VIDEO_COPY_ANALYZER_ARGS
KOLFORGE_VIDEO_COPY_ANALYZER_COMMAND
KOLFORGE_VIDEO_COPY_ANALYZER_CWD
KOLFORGE_VIDEO_COPY_ANALYZER_TIMEOUT_MS
KOLFORGE_VIDEO_CREATOR_CONCURRENCY
KOLFORGE_VIDEO_FFMPEG_PATH
KOLFORGE_VIDEO_FFPROBE_PATH
KOLFORGE_VIDEO_PYTHON
KOLFORGE_VIDEO_PYTHON_ARGS
KOLFORGE_VIDEO_SUMMARY_ARGS
KOLFORGE_VIDEO_SUMMARY_COMMAND
KOLFORGE_VIDEO_SUMMARY_CWD
KOLFORGE_VIDEO_SUMMARY_TIMEOUT_MS
KOLFORGE_VIDEO_VISION_BASE_URL
KOLFORGE_VIDEO_VISION_CONTEXT_LENGTH
KOLFORGE_VIDEO_VISION_MAX_FRAMES
KOLFORGE_VIDEO_VISION_MODEL
KOLFORGE_VIDEO_VISION_TIMEOUT_MS
KOLFORGE_VIDEO_WHISPER_LANGUAGE
KOLFORGE_VIDEO_WHISPER_MODEL_PATH
XIAOHONGSHU_CONNECTOR
XIAOHONGSHU_PARTNER_TOKEN
XIAOHONGSHU_PARTNER_URL
```

### 16.4 `server/config.mjs` 引用但示例文件未明确列出的开关

```text
DOUYIN_MESSAGE_NODE_PATH
DOUYIN_POST_SEARCH_URL_TEMPLATE
KOLFORGE_COLLECTION_RANDOM_INTERVAL_MAX_MS
KOLFORGE_COLLECTION_RANDOM_INTERVAL_MIN_MS
KOLFORGE_PYTHON
KOLFORGE_RELAY_NODE_PATH
KOLFORGE_RELAY_PLAYWRIGHT_MODULE_PATH
KOLFORGE_RELAY_PREFLIGHT_CACHE_MS
KOLFORGE_VIDEO_FUNASR_DEVICE
KOLFORGE_VIDEO_FUNASR_MODEL_DIR
KOLFORGE_VIDEO_FUNASR_SCRIPT
KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE
KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE_MAX_BYTES
KOLFORGE_VIDEO_NODE_PATH
KOLFORGE_VIDEO_PLAYWRIGHT_MODULE_PATH
KOLFORGE_VIDEO_TRANSCRIPT_PROVIDER
OPENAI_API_KEY
OPENAI_BASE_URL
USERPROFILE
```

这些 code-only 变量构成隐藏运行合同。正式发布前应同步到环境变量参考文档，特别是随机间隔、Relay preflight cache、FunASR、local media cache 和 Node/Playwright 路径。
