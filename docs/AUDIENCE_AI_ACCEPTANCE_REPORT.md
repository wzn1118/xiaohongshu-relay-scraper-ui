# 逐帖受众 AI 深度分析验收报告

> 报告快照：2026-08-01。本文严格区分当前通过、当前失败、未执行、历史结果、真实 Relay、真实 Provider 和 fake fixture。当前 Node/API/Artifact/前端静态与 E2E 门禁已有本轮证据；Python 全量 283/283、Audience AI/profile 专项 37/37、Provider runtime 15/15 均已在当前工作树通过。第四轮真实 Provider 续跑已形成严格 partial 产物，但尚未达到 completed/latest 或 `REAL-PROVIDER-PASSED`。

## 证据口径

| 状态 | 本报告中的含义 |
| --- | --- |
| `CURRENT-PASSED` | 最后一次源码修改后实际运行并通过。 |
| `CURRENT-FAILED` | 最后一次源码修改后实际运行并失败。 |
| `UNEXECUTED` | 当前轮没有执行或缺少环境。 |
| `HISTORY-ONLY` | 本功能开发中的较早源码修订曾通过；后续仍有修改，不能作为最终通过。 |
| `REAL-RELAY-PASSED` | 真实登录 Relay、真实页面、真实检查点通过。 |
| `REAL-PROVIDER-PASSED` | 真实模型输出通过 Schema、evidence、coverage、Artifact 和状态校验。 |
| `REAL-PROVIDER-PARTIAL-VALIDATED` | 真实模型运行形成严格校验通过的 partial 产物；部分实体或综合结论仍失败，不等同 `REAL-PROVIDER-PASSED`。 |
| `REAL-PROVIDER-FAILED` | 真实模型已调用，但上述任一严格门禁失败。 |
| `FAKE-FIXTURE-PASSED` | fake Provider、fake Relay 或 Playwright route fixture 通过。 |

## 1. 当前分支和提交

- 分支：`master`。
- 基线 HEAD：`174fda7bc7e870437e9432c87321167cbc687896`。
- 工作树：有未提交修改；功能尚未形成最终提交。
- 最终分支/提交：仍在 `master` 工作树，尚未创建功能提交。
- 保护规则：不得回滚或格式化本功能开始前已有的用户修改；最终提交必须只包含有意文件。

## 2. 修改文件列表

Audience AI 直接相关文件：

- 配置/依赖：`.env.example`、`requirements.txt`。
- Node：`server/app.mjs`、`server/config.mjs`、`server/job-manager.mjs`、`server/audience-ai-service.mjs`、`server/lib/audience-ai-contracts.mjs`、`server/lib/audience-ai-input.mjs`、`server/lib/audience-ai-profile-enrichment.mjs`、`server/lib/audience-ai-profile-runner.mjs`、`server/lib/audience-ai-store.mjs`。
- Python：`scripts/ai_provider_runtime.py`、`scripts/run_audience_ai.py`、`scripts/audience_ai_pipeline.py`、`scripts/audience_ai_schemas.py`、`scripts/audience_profile_supplement.py`。
- 前端：`src/App.tsx`、`src/AudienceAiPanel.tsx`、`src/api.ts`、`src/types.ts`、`src/styles.css`。
- 测试：`server/audience-ai.test.mjs`、`server/audience-ai-profile-runner.test.mjs`、`tests/test_audience_ai_pipeline.py`、`tests/test_audience_profile_supplement.py`、`tests/test_ai_provider_runtime.py`、`tests/e2e/audience-ai.spec.ts` 及五视口快照。
- 文档：`docs/prompts/audience-ai-analysis-10-stage-prompt.md`、`docs/AUDIENCE_AI_REQUIREMENTS_TRACEABILITY.md`、本文。

最终 `git diff --name-status` 尚未固定：工作树仍有未提交修改，本文不填造不存在的最终提交或最终差异快照。

## 3. 十阶段完成状态

| 阶段 | 实现状态 | 自动化状态 | 真实验收状态 | 结论 |
| --- | --- | --- | --- | --- |
| 1 基线/契约/骨架 | 已实现 flag、contracts、service、types | Node 串行全量 263/263，API 52/52 | 不适用 | 当前自动化通过。 |
| 2 输入快照/关联 | 已实现 authoritative input、tree/users、coverage/revision | Node/Python fixture 已建立 | 首轮真实目标帖成功冻结输入 | 真实三帖对账未完成。 |
| 3 SQLite/恢复 | 已实现专用 store、版本、events、cancel/resume | Audience AI focused Node 52/52；含启动扫描恢复、CAS、物化和生命周期 | 真实进程重启/WAL 实操未执行 | 自动化通过；真实门禁仍未关闭。 |
| 4 评论/线程 AI | 已实现 Map、Schema、repair、evidence、partial | Python 全量283/283、专项37/37、Provider runtime15/15 | 第四轮真实续跑：4条评论中1条分析、3条按`model_omitted_entity`跳过，3条线程结果 | `REAL-PROVIDER-PARTIAL-VALIDATED`。 |
| 5 用户/综合 | 已实现用户聚合、批次、synthesis | Python 全量283/283、专项37/37、Provider runtime15/15 | 第四轮2/2用户成功，1次批次到单用户恢复；综合阶段1条evidence失败 | `REAL-PROVIDER-PARTIAL-VALIDATED`。 |
| 6 主页/补采 | 四模式、定向 runner/checkpoint 已实现 | fake Relay/profile fixture 已建立 | 真实 Relay 未执行 | `UNEXECUTED`。 |
| 7 API/SSE/Artifact | 路由和产物链已实现 | API 52/52、Artifact 1/1、focused Node 52/52；SSE 精确 651 事件、verifier/materializer、latest 竞态均覆盖 | 第四轮partial Artifact的9文件、严格校验、SHA、SQLite物化和不激活latest契约均通过；真实HTTP smoke未执行 | 自动化和partial产物契约通过；成功真实latest仍未验收。 |
| 8 前端 | 每帖按钮、配置、结果、版本、下载已实现 | Playwright 7/7；五视口含 1024x768 | 真实运行截图未完成 | fixture E2E 通过；人工真实视觉待验收。 |
| 9 全量测试 | 已建立 Node/Python/scale/security/E2E | Node263/263、focused Node52/52、Python283/283、Python focused37/37、Provider runtime15/15、API52/52、Artifact1/1、Playwright7/7及静态门禁通过 | Linux未执行 | 当前本地自动化通过；Linux门禁仍未关闭。 |
| 10 真实验收 | 文档及多轮真实模型产物存在 | 不适用 | 第四轮续跑为严格`partial/resumable`，Artifact通过；真实Relay/HTTP/restart/stale/Linux/三帖/completed+latest未执行 | `Audience AI feature complete, real-environment acceptance pending`。 |

## 4. 每帖独立按钮实现

- `src/App.tsx` 在受众帖子项中按 post 渲染独立 AI 操作入口，feature flag 关闭时不显示。
- `src/AudienceAiPanel.tsx` 以当前 `jobId + postId` 打开独立面板，不把“全部原帖”解释为批量启动。
- 按钮状态读取服务端 overview/run 状态；面板使用独立 close/action buttons，避免嵌套 button。
- 证据：`tests/e2e/audience-ai.spec.ts` 的 flag-off、逐帖按钮和生命周期 fixture。
- 状态：`FAKE-FIXTURE-PASSED`；当前 `npx playwright test tests/e2e/audience-ai.spec.ts` 为 7/7。

## 5. 原任务原地执行证据

- API 路径始终带原 `jobId` 和目标 `postId`。
- `analysis_runs` 将 `runId` 作为任务内子版本；输出在原 job 根目录的 `artifacts/audience-ai/<postId>/<runId>`。
- 主页补采通过 `JobManager.runRelaySubtask()` 使用原任务内部 Relay 子任务，不调用通用 start/create job。
- 第四轮真实续跑继续使用原任务 `20260731093808-50dd4507`、原 `runId=audai-1785574268920-90278b07`，`checkpointReused=true`。
- 真实补采尚未执行，因此本项不能标记 `REAL-RELAY-PASSED`。

## 6. 未创建新 Job 的证据

- Node fixture 断言 internal Relay subtask 不产生顶层 Job；E2E 捕获并断言 Audience AI 流程没有 `POST /api/jobs`。
- 服务/API 源码没有从 audience AI start/resume 路由调用 `manager.start()`。
- 第四轮验收确认同一 runId 原地 resume，未新建采集 Job；`profileMode=none`，没有进入主页补采。
- 当前状态：AI续跑“不新建采集Job”已有真实证据；真实 Relay 补采前后任务总数、任务创建时间和目录集合对账仍为 `UNEXECUTED`。

## 7. 原帖完整输入证据

- 后端 input builder 从当前任务持久层读取 authoritative post、body、author、media/OCR/已有分析、全部目标帖评论/回复、稳定用户和允许的 profile scope。
- 前端不上传评论正文、主页副本或计数；分页、筛选和 tab 不进入 inputRevision。
- 首轮真实 run：body 可用且 `contextComplete=true`；输入 4 条评论（2 顶评、2 回复）、2 位用户。
- 真实三帖源 Artifact 对账：`UNEXECUTED`。

## 8. 评论线程分块设计

- 流程：post context -> thread Map -> comment normalization -> user batch -> bounded synthesis -> deterministic validation -> Artifact。
- 分块基于 model context、system/schema/post/output reserve和安全余量；超长线程携带 root comment 与已验证摘要再拆分。
- 高基数 synthesis 只保留被结构化结果引用的 evidence，并做确定性预算裁剪。
- 规模 fixture 覆盖 4,000+ comments/1,500+ users；真实大规模 Provider 运行未执行。

## 9. 逐评论结果 Schema

- `scripts/audience_ai_schemas.py::COMMENT_INSIGHT` 使用 Draft 2020-12 且 `additionalProperties=false`。
- 字段覆盖 comment/post/parent/root/user/level、themes、sentiment、stance、intent、needs/questions/objections/pain points/outcomes、role/actionability/confidence/evidence/quality，以及 `status/skipReason`。
- 第四轮真实续跑覆盖4条评论：`commentsAnalyzed=1`、`commentsSkipped=3`，3条跳过原因均为`model_omitted_entity`；3条线程记录已形成。
- 状态：评论/线程partial产物通过严格校验，为 `REAL-PROVIDER-PARTIAL-VALIDATED`，不是 completed。

## 10. 逐用户结果 Schema

- `USER_INSIGHT` 包含 stable user/post/display name、interaction role、themes/needs/concerns/questions、stance/depth、observable interests/content needs、profile coverage/context/source scope、confidence/evidence/quality及skip reason。
- 用户先确定性聚合，再按 token 预算批次分析；批次不合格可回退到独立用户校验，不默认一人一次调用。
- 第四轮真实续跑目标2人且`usersAnalyzed=2`；一次用户批次失败后按batch-to-single恢复，两个用户结果均通过。
- 综合阶段仍有1条synthesis evidence失败，整run为严格`partial/resumable`；状态是 `REAL-PROVIDER-PARTIAL-VALIDATED`，不是 `REAL-PROVIDER-PASSED`。

## 11. 主页四种模式

| 模式 | 网络语义 | 当前证据 |
| --- | --- | --- |
| `none` | 不读取主页字段、不启动Relay | fixture通过；第四轮真实Provider使用此模式并未新建采集Job，但仍缺进程/请求级“Relay未启动”证明。 |
| `available_header` | 只读已有公开头部，缺失为unknown，不启动Relay | fixture；真实未执行。 |
| `collect_missing_header` | 只补当前帖相关用户的缺失头部，同job | fake Relay；真实未执行。 |
| `recent_public_posts` | 显式用户/每用户帖子/总帖子预算，同job checkpoint | fake Relay；真实未执行。 |

## 12. 补采检查点和恢复

- 定向用户队列只来自当前 post 评论者；collector checkpoint 与 audience AI model checkpoint 分离。
- Relay busy/security verification/partial/cancel/resume 有独立事件和状态，补采后重新冻结 snapshot/revision。
- fake runner测试覆盖参数、预算、checkpoint和不创建顶层Job。
- `REAL-RELAY-PASSED`：`UNEXECUTED`；真实安全验证、取消、恢复、partial降级均未验收。

## 13. 状态机

- 独立状态包括：`not_started`、`snapshotting`、`waiting_profile_enrichment`、`collecting_profile_headers`、`collecting_profile_posts`、`analyzing_comments`、`analyzing_users`、`synthesizing`、`validating`、`exporting`、`partial`、`completed`、`blocked`、`interrupted`、`failed`、`cancelled`、`stale`，并包含内部 `cancelling`。
- 主 Job status 不承载 Audience AI 运行状态。
- 并发 resume/start 原子状态转换、迟到 runner event 不回退 cancelling、启动扫描恢复和生命周期关闭已由当前 focused Node 52/52 覆盖；生产初始化会扫描已有 Audience AI 数据库并把无进程的运行态恢复为 interrupted/resumable。
- 首轮真实 run 暴露过失败 `analysis.json` 被 Node 非零退出分支误映射为 partial 的问题。当前状态映射/CAS 回归已通过；第四轮虽exitCode=3，但因保留了严格校验通过的部分实体结果而确定性落为`partial/resumable`，不是把失败伪装为completed。
- 真实 Node 进程 kill/restart 及孤儿子进程对账仍为 `UNEXECUTED`；自动化 startup recovery 不能替代该真实门禁。

## 14. SQLite Schema

- 每任务数据库：`audience-ai-state.sqlite3`。
- 表：`analysis_runs`、`input_snapshots`、`analysis_chunks`、`entity_insights`、`evidence_refs`、`run_events`、`analysis_versions`。
- 配置：WAL、foreign keys、busy timeout、transaction、`PRAGMA user_version`、active-version unique index。
- 当前 focused Node 52/52 已验证 Artifact materializer 把 chunks/insights/evidence 实际写入 SQLite，并覆盖任务删除、retention、clear、shutdown 时的 quiesce/句柄关闭协作。
- 第四轮真实 run 的隔离 SQLite 物化计数为chunks=6、insights=9（comments=4、threads=3、users=2）、evidence=6；partial版本未active且未写`latest.json`，符合版本契约。
- Windows 真实 open-handle 删除及真实 WAL crash/restart 仍为 `UNEXECUTED`。

## 15. 幂等和并发

- 幂等/语义键覆盖 job、post、inputRevision、scope、modules、model config、prompt/schema；SQLite unique约束防重复。
- 同帖最多一个 active run；不同帖并发由 `XHS_AUDIENCE_AI_MAX_CONCURRENT` 控制，默认2。
- 纯AI不占Relay锁；仅profile collection进入原JobManager Relay队列。
- 双击/并发请求、refreeze 后 semantic key、resume compare-and-set、config conflict 已纳入当前 focused Node 52/52；幂等键包含 inputRevision，refreeze 后同步更新 semantic identity。
- 当前自动化状态：`CURRENT-PASSED`；真实并发点击与重复费用对账仍为 `UNEXECUTED`。

## 16. Provider 和 Session

- API只接受 `aiSessionId`；服务端通过现有 `AiSessionStore.resolve()` 获取Provider配置并仅通过子进程环境传递secret。
- Python复用 `AIProvider`；local Ollama可按模型context设置 `num_ctx`。
- 请求体拒绝key/Auth/secret/baseUrl/命令；Artifact/SQLite/SSE/error只能记录provider/model/wire API/usage/cost/duration等公开字段。
- 第四轮真实续跑：provider=`local_qwen`，验收runner实际override为model=`qwen3:4b`，共调用7次；输入快照仍记录原模型`qwen3.5:4b`，该差异明确属于验收期间runner override，不伪写成同一模型配置。

## 17. Prompt 和 Schema 版本

- Prompt：`audience-ai-v1`。
- Schema：`audience-ai/1`。
- JSON Schema：Draft 2020-12；comment/thread/user/synthesis分别校验，`additionalProperties=false`。
- invalid JSON、schema-invalid、repair once、repair failed、chunk partial路径有fixture。
- 第四轮真实续跑生成3条线程、4条评论记录和2/2用户结果；3条评论被模型遗漏后以`model_omitted_entity`显式跳过，一次用户批次错误由batch-to-single恢复。最终仅保留1条synthesis evidence失败，状态严格为partial，未伪装为completed。

## 18. 证据校验

- evidence resolver核对 entity ID、当前post归属、snapshot、source excerpt/hash、profile scope和source类型。
- foreign comment/user、跨帖、hash/excerpt mismatch和模型自生证据不得进入可信结论。
- 第四轮partial Artifact有6条已接受evidence通过resolver、Artifact和SQLite校验；另1条synthesis evidence未通过确定性门禁，因此不进入可信completed结果。
- 真实成功run的post+audience双证据抽样和UI跨页跳转：`UNEXECUTED`。

## 19. coverage

第四轮真实续跑 `audai-1785574268920-90278b07` 的确定性 coverage：

| 字段 | 值 |
| --- | --- |
| source/comments included | 4 / 4 |
| top-level / replies | 2 / 2 |
| comments analyzed/skipped | 1 / 3 |
| unique/users selected/analyzed | 2 / 2 / 2 |
| profiles available/used | 1 / 0 |
| original body/media analysis | true / false |
| coverage status | partial |
| overall analysis status | partial / resumable |

此 Artifact 是严格校验后的partial证据：4条评论全部有分析或明确skip reason，2位用户全部分析成功，coverage=`partial`。由于3条评论被模型遗漏且1条synthesis evidence失败，它不能标为completed、active或成功latest。

## 20. stale 和版本切换

- `inputRevision` 与 snapshot immutable记录；新输入使旧run stale但不删除。
- `analysis_versions` 保留每post历史和唯一active pointer；UI在新run期间继续展示上一版。
- 新run只有在Node完成身份、JSON/JSONL、file set、size、SHA、Schema/evidence/coverage校验后才可activate并写 `latest.json`。
- 当前 focused Node 52/52 已覆盖 stale 按各历史版本自身配置重算、一次性 stale event、refreeze 幂等、失败不切 active、Node完整校验后才物化并切 latest，以及 latest 发布竞态修复。
- 第四轮partial run的Artifact identity、SQLite state、未active且未写latest均通过契约校验；真实输入更新、增量chunk复用及成功completed/active/latest切换仍为 `UNEXECUTED`。

## 21. API

实现的post-scoped API：

- `GET /api/jobs/:jobId/audience/posts/:postId/ai`
- `POST .../ai/preview`
- `POST .../ai/runs`
- `GET .../ai/events`
- `GET .../ai/results`
- `GET .../ai/runs/:runId`
- `GET .../ai/runs/:runId/results`
- `POST .../ai/runs/:runId/cancel`
- `POST .../ai/runs/:runId/resume`

comment/user evidence定位复用受众工作台实体锚点语义。当前 `npm run test:api` 为52/52；真实监听端口上的 HTTP smoke 仍为 `UNEXECUTED`。

## 22. SSE

- 事件：snapshot/status/progress/profile progress/chunk completed/partial/completed/stale/blocked/failed/cancelled。
- 事件持久化到 `run_events` 并带sequence；前端EventSource按post订阅，overview快照与增量合并。
- 当前 Node 回归以精确651个序列事件验证“先订阅再取快照/高水位”、超过500条时分页回放、live buffer去重及服务端权威 job/post/run context；focused Node 52/52 通过。
- fake E2E覆盖重连语义；真实监听端口断线重连仍为 `UNEXECUTED`。

## 23. Artifact

- 每版本要求9个文件：manifest、analysis JSON/MD、comment/thread/user/evidence JSONL、coverage、run metadata；成功版本另有post级`latest.json`。
- 首轮真实失败目录包含全部9个版本文件；manifest列8个payload文件，每个size/SHA与磁盘一致，JSON/JSONL可解析。
- 该manifest的 `status=failed`、`completionStatus=failed`，因此不得成为成功latest。
- 当前 Node verifier/materializer 覆盖完整file set、size、SHA-256、JSON/JSONL、identity、Schema/evidence/coverage、路径边界、SQLite物化和latest发布顺序；`npm run test:artifacts` 1/1、focused Node 52/52通过。
- 第四轮partial Artifact的9个版本文件通过strict validator、size/SHA-256、JSON/JSONL、identity、coverage、count、evidence和secret scan；manifest SHA-256为`0848f0d9e3b7f559fec597b2463276dada5d44bfcd8bcd47d59ccfd4efadcb9a`。SQLite物化为6 chunks/9 insights/6 evidence，partial未active且未写latest。真实成功版本下载和真实任务删除联动仍为 `UNEXECUTED`。

## 24. 前端交互

- 配置：固定post content、评论/回复/用户、四种profile mode、modules、语言、strictness、incremental-only和预算。
- 运行：preview/start/cancel/resume/reanalyze、进度、blocker/warning、旧版banner。
- 结果：overview/comment/user/profile/fit/opportunity/risk/evidence、筛选、排序、分页、版本、下载。
- 原评论流和用户卡不被panel替换；证据callback切换原tab并定位实体。
- 真实运行交互录屏/截图：`UNEXECUTED`。

## 25. 响应式和可访问性

- 已有win32 fixture快照：390x844、768x1024、1024x768、1024x900、1440x900。
- CSS使用单列移动布局、可滚动tabs、换行和overflow约束；按钮/图标具备accessible name/tooltip/aria-label，状态使用aria-live。
- Playwright有横向溢出与键盘路径断言。
- 当前 Playwright 7/7，五个视口均纳入fixture；1024x768已有独立基准图。
- 屏幕阅读器人工抽检：`UNEXECUTED`。

## 26. 隐私和敏感推断限制

- 只处理当前任务已有或显式定向补采的公开数据；profile selection按当前post user IDs和budget allowlist。
- Schema只允许observable/expressed fields；prompt要求unknown、来源、证据和禁止敏感推断/心理定性。
- secret scrub覆盖日志、event、snapshot、Artifact和provider diagnostics；credential scan存在。
- 当前 `npm run test:credentials` 通过；第四轮真实隔离 Artifact 的strict secret scan通过。真实输出人工敏感属性抽检仍为 `UNEXECUTED`。

## 27. 性能、token 和成本

- service AI并发默认2；pipeline按context动态分线程/用户批次并限制synthesis；repair/checkpoint/cancel/预算有确定性路径。
- 第四轮真实续跑：7次模型调用，input 11,903、output 4,743、合计估算16,646 tokens；usage为estimated；pipeline duration 186,773 ms，端到端elapsed 187,420 ms；`cost=null`，不得写成0或精确费用。
- 第四轮从原runId续跑并复用checkpoint；一次用户batch失败后回退单用户调用，最终2/2用户成功。仍有3条`model_omitted_entity`评论跳过和1条synthesis evidence失败，成功completed复跑仍待真实证据。
- 4,000+/1,500+ fixture存在；真实峰值内存、SQLite大小、Artifact大小、SSE延迟、429/Retry-After和成本上限：`UNEXECUTED`。

## 28. 单元测试

| 范围 | 当前记录 | 分类 | 收口说明 |
| --- | --- | --- | --- |
| Node串行全量 | 263/263 | `CURRENT-PASSED` | 当前工作树串行执行通过。 |
| Audience AI focused Node | 52/52 | `CURRENT-PASSED` | `node --test server/audience-ai*.test.mjs server/data-lifecycle-service.test.mjs`；含startup recovery、CAS、quiesce、Artifact materializer、SQLite物化、latest竞态、元数据篡改及SSE 651事件。 |
| Python全量 | 283/283 | `CURRENT-PASSED` | 当前工作树全量通过。 |
| Python Audience AI/profile专项 | 37/37 | `CURRENT-PASSED` | `tests/test_audience_ai_pipeline.py + tests/test_audience_profile_supplement.py`通过。 |
| Python Provider runtime | 15/15 | `CURRENT-PASSED` | `tests/test_ai_provider_runtime.py`通过。 |

Node和Python计数均为当前源码证据；真实环境门禁仍按本报告的`UNEXECUTED`与partial状态单独判定。

## 29. 集成测试

已建立：HTTP routes/contracts、same-job Relay subtask、profile checkpoint/security block、SQLite isolation/interrupted/idempotency、pipeline CLI cancel/resume、Artifact和credential fixtures。

最终必须记录：

```text
npm run test
npm run test:python
npm run test:api
npm run test:artifacts
npm run test:credentials
npm run lint
npm run format:check
npm run typecheck
npm run build:frontend
npm run audit:dependencies
git diff --check
```

当前记录：

| 命令 | 结果 | 状态/限制 |
| --- | --- | --- |
| `npm run test`（串行） | 263/263 | `CURRENT-PASSED` |
| `node --test server/audience-ai*.test.mjs server/data-lifecycle-service.test.mjs` | 52/52 | `CURRENT-PASSED` |
| `npm run test:python` | 283/283 | `CURRENT-PASSED` |
| `pytest -q tests/test_audience_ai_pipeline.py tests/test_audience_profile_supplement.py` | 37/37 | `CURRENT-PASSED` |
| `pytest -q tests/test_ai_provider_runtime.py` | 15/15 | `CURRENT-PASSED` |
| `npm run test:api` | 52/52 | `CURRENT-PASSED`；不等同真实HTTP smoke |
| `npm run test:artifacts` | 1/1 | `CURRENT-PASSED` |
| `npm run test:credentials` | passed | `CURRENT-PASSED` |
| `npm run lint` | passed | `CURRENT-PASSED` |
| `npm run format:check` | passed | `CURRENT-PASSED` |
| `npm run typecheck` | passed | `CURRENT-PASSED` |
| `npm run build:frontend` | passed | `CURRENT-PASSED` |
| `npm run audit:dependencies` | passed | `CURRENT-PASSED` |
| `git diff --check` | passed | `CURRENT-PASSED`；仅工作树行尾提示不构成错误 |

## 30. Playwright 和视觉回归

- Spec：`tests/e2e/audience-ai.spec.ts`。
- 覆盖：flag off、每帖按钮、same-job start/cancel/resume/refresh、旧结果/原数据保持、证据、版本、下载、五视口overflow。
- 当前五张win32基准文件已存在，包含Prompt明确要求的1024x768；它们是 route fixture 证据，不是 `REAL-PROVIDER-PASSED` 或 `REAL-RELAY-PASSED`。
- 当前 `npx playwright test tests/e2e/audience-ai.spec.ts`：7/7，`CURRENT-PASSED`。
- 五张fixture图片自动化像素/overflow断言通过；真实任务截图和屏幕阅读器人工检查仍为 `UNEXECUTED`。

## 31. Windows 和 Linux 结果

| 环境 | 状态 | 证据 |
| --- | --- | --- |
| Windows 本地 | Node263/263、focused52/52、Python283/283、Python focused37/37、Provider runtime15/15、API52/52、Artifact1/1、lint/format/typecheck/build/credentials/audit/diff-check通过 | `CURRENT-PASSED` |
| Windows Playwright | 7/7，五视口含1024x768 | `CURRENT-PASSED`（fake route fixture） |
| Linux 本地/CI | 未执行 | `UNEXECUTED` |

Linux未执行时不得写“跨平台通过”。

## 32. 真实任务 jobId

- 真实任务：`20260731093808-50dd4507`。
- 只读已知基线：197篇post、4,092条comments、1,503位users；这些计数必须在最终验收时从当前持久层重新读取并注明时间。
- 真实三帖场景与profile complete/partial/pending基线：`UNEXECUTED`。

## 33. 真实分析 postId 和 runId

首轮真实模型验收（失败证据）：

- postId：`6a6b911c000000003301a90a`，标题“亚比小松菜奈”。
- runId：`audai-1785566867203-94e7cf96`。
- profileMode：`none`。
- Provider/model：`local_qwen / qwen3.5:4b`。
- prompt/schema：`audience-ai-v1 / audience-ai/1`。
- 结论：`REAL-PROVIDER-FAILED`，不是已完成结果。

第三次真实 Ollama 隔离验收（失败证据）：

- postId：`6a6b911c000000003301a90a`；runId：`audai-1785570820366-b7bb8503`；aiSession：`2085f20e-4e67-4f8b-a743-84af5de22c00`。
- profileMode：`none`；Provider/model：`local_qwen / qwen3.5:4b`；prompt/schema：`audience-ai-v1 / audience-ai/1`。
- 状态：`failed`，`resumable=true`，pipeline exitCode=3；pipeline 214,843 ms，端到端216,343 ms；6次调用，估算input/output/total tokens=12,473/6,503/18,976。
- coverage：4/4评论进入输入，0 analyzed/4 skipped；2/2用户分析成功；3条线程记录；coverage=`partial`。
- checkpoint：只生成1个全新checkpoint，`checkpointReuse=false`，没有复用旧run checkpoint。
- 通过项：严格Artifact verifier、9文件/manifest 8 entries、size/SHA-256、JSON/JSONL、SQLite物化和latest身份一致性。
- 失败项：`thread_map`没有逐一覆盖4条评论和3个root thread；`synthesis`存在带`> `前缀的未知引用、主题缺受众证据、segment primary计数重叠、contentFit缺post+audience双证据。
- 结论：`REAL-PROVIDER-FAILED`；别名规范化已改善用户结果，但评论/线程/综合门禁仍未通过。

第四轮真实 Ollama 原 runId 续跑（partial validated）：

- jobId：`20260731093808-50dd4507`；postId：`6a6b911c000000003301a90a`；runId：`audai-1785574268920-90278b07`。
- 续跑语义：沿用原runId resume，`checkpointReused=true`，未新建采集Job；profileMode=`none`。
- Provider/model：`local_qwen / qwen3:4b`；输入snapshot原模型为`qwen3.5:4b`，前者是验收期间runner override，二者均如实记录。
- 状态：`partial`、`resumable=true`、exitCode=3；pipeline duration=186,773 ms，elapsed=187,420 ms。
- 调用/用量：7 calls；estimated input/output/total tokens=11,903/4,743/16,646；`cost=null`。
- coverage：4 comments=1 analyzed+3 skipped（`model_omitted_entity`）；3 thread rows；2/2 users analyzed；6 accepted evidence。
- 恢复/失败：1次user batch-to-single恢复；1条synthesis evidence失败。
- Artifact：9个版本文件通过strict validator、SHA、JSON/JSONL、identity、coverage/count/evidence和secret scan；manifest SHA-256=`0848f0d9e3b7f559fec597b2463276dada5d44bfcd8bcd47d59ccfd4efadcb9a`。
- SQLite：6 chunks、9 insights、6 evidence；partial未active且未写latest，符合契约。
- 结论：`REAL-PROVIDER-PARTIAL-VALIDATED`；不得写成`REAL-PROVIDER-PASSED`、completed或release-ready。

## 34. Artifact 绝对路径

首轮真实失败 Artifact：

`C:\Users\10847\AppData\Local\Temp\xhs-audience-ai-acceptance-20260801-144709\jobs\20260731093808-50dd4507\artifacts\audience-ai\6a6b911c000000003301a90a\audai-1785566867203-94e7cf96`

该目录已验证存在，保留作为失败诊断；不能当成成功版本。

第三次真实失败 Artifact：

`E:\UserData\Temp\xhs-audience-ai-acceptance-third-20260801-155339\jobs\20260731093808-50dd4507\artifacts\audience-ai\6a6b911c000000003301a90a\audai-1785570820366-b7bb8503`

第三次完整验收记录：

`E:\UserData\Temp\xhs-audience-ai-acceptance-third-20260801-155339\acceptance-validation.json`

以上路径已验证存在。第三次目录的结构、SHA和物化检查通过，但业务状态为failed，不能当成成功版本或成功latest。

第四轮partial Artifact：

`E:\UserData\Temp\xhs-audience-ai-acceptance-fourth-20260801-165016\jobs\20260731093808-50dd4507\artifacts\audience-ai\6a6b911c000000003301a90a\audai-1785574268920-90278b07`

第四轮完整验收记录：

`E:\UserData\Temp\xhs-audience-ai-acceptance-fourth-20260801-165016\acceptance-validation.json`

- validation SHA-256：`1D16ED708754E3F78AE8A2313F47847C65E611B8D2B0C7630F4B310EE411BCBF`。
- 以上第四轮路径和校验记录对应严格partial产物；它没有active，也没有写latest。

## 35. 截图绝对路径

当前 fixture 截图：

- `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tests\e2e\audience-ai.spec.ts-snapshots\mobile-390x844-audience-ai-panel-win32.png`
- `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tests\e2e\audience-ai.spec.ts-snapshots\tablet-768x1024-audience-ai-panel-win32.png`
- `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tests\e2e\audience-ai.spec.ts-snapshots\desktop-1024x768-audience-ai-panel-win32.png`
- `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tests\e2e\audience-ai.spec.ts-snapshots\desktop-1024x900-audience-ai-panel-win32.png`
- `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tests\e2e\audience-ai.spec.ts-snapshots\desktop-1440x900-audience-ai-panel-win32.png`

这些是fake route fixture，不是当前真实任务运行截图。五视口Playwright为7/7；真实任务截图仍为 `UNEXECUTED`。

## 36. 当前未验证项

1. 后续真实Ollama completed run及完整comment/thread/user/synthesis严格结果；第四轮仅为partial validated。
2. `available_header`真实无网络运行。
3. `collect_missing_header`与`recent_public_posts`真实Relay运行、预算、定向用户和checkpoint。
4. 真实Relay busy、安全验证、partial、cancel/resume。
5. 完成chunk后的真实取消/恢复与token不重复计费。
6. Node进程真实重启、interrupted/resumable、WAL和同runId恢复。
7. 输入新增评论后的stale、preview delta、chunk复用、active/latest切换。
8. 真实成功Artifact激活/latest切换、真实旧版本下载及真实任务删除联动；Node verifier/materializer自动化及第四轮partial不激活契约已通过。
9. Windows真实open-handle删除及WAL crash恢复；SQLite物化自动化和第四轮真实隔离物化已通过。
10. 真实监听端口SSE断线重连；握手与精确651事件分页自动化已通过。
11. 宽桌面人工视觉、真实任务截图、键盘人工确认和屏幕阅读器抽检；1024x768 fixture自动化已通过。
12. Linux CI。
13. 真实三帖规模/覆盖基线及真实证据跳转/下载。
14. 真实HTTP smoke，以及峰值内存、SQLite大小、SSE延迟和真实429/timeout成本门禁。

## 37. 剩余风险

| 风险 | 影响 | 关闭方法 |
| --- | --- | --- |
| 小模型结构化输出截断/遗漏实体 | 真实run只能failed/partial | 显式context、预算裁剪、repair；第四轮partial已捕获`model_omitted_entity`，仍需completed真实复跑。 |
| Node失败状态映射/迟到event | 真实边界仍可能出现未覆盖状态组合 | CAS与Artifact status专项回归已通过；保留真实cancel/restart门禁。 |
| Artifact损坏或latest发布竞态 | 损坏产物可能被激活 | Node verifier/materializer、SHA/JSONL、SQLite物化和latest时序回归已通过；仍需成功真实版本验收。 |
| refreeze/stale/idempotency竞争 | 重复费用或错误复用 | revision+semantic key原子更新和并发回归已通过；仍需真实输入更新场景。 |
| SSE snapshot/subscription竞态 | 重连漏事件 | 当前精确651事件回归已通过；仍需真实监听端口断线。 |
| store/process生命周期 | Windows句柄阻止删除或硬崩溃遗留孤儿进程 | quiesce/delete/shutdown自动化已通过；真实open-handle删除和OS级崩溃/孤儿进程对账未执行。 |
| 真实Relay行为未测 | 定向范围、锁、安全验证可能偏离fixture | 低预算真实场景并记录事件/checkpoint/task count。 |
| Linux未测 | 路径、信号、SQLite或截图差异 | Linux CI全量。 |

## 38. 提交哈希

- 当前基线 HEAD：`174fda7bc7e870437e9432c87321167cbc687896`。
- Audience AI 功能提交：尚未创建。
- 最终提交哈希：不存在；当前仍为未提交工作树。
- 本报告的测试计数绑定当前工作树，不冒充绑定到尚未创建的提交。

## 39. 最终发布结论

当前报告快照中Node/Python/API/Artifact/Playwright与静态门禁已通过；第四轮真实Provider续跑形成严格partial产物，9文件、SHA、结构、证据、SQLite物化和“不active/不写latest”契约均通过，但它不是completed或`REAL-PROVIDER-PASSED`。真实Relay、HTTP smoke、进程重启、stale、Linux、三帖和成功completed+latest仍为`UNEXECUTED`。按规则2，当前结论是：

`Audience AI feature complete, real-environment acceptance pending`

更新规则：

- 代码门禁全部通过，但真实Provider或真实Relay仍未完成：保持 `Audience AI feature complete, real-environment acceptance pending`。
- 只有真实链路、恢复、证据、视觉、Windows/Linux和全量回归全部通过：改为 `Audience AI feature completed and release-ready`。
- 任何测试未实际执行都保留“未执行”，不得写成通过。
