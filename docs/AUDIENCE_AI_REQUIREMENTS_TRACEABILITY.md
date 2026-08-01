# 逐帖受众 AI 深度分析需求追踪矩阵

## 1. 文档用途

本文追踪 `docs/prompts/audience-ai-analysis-10-stage-prompt.md` 中“逐帖受众 AI 深度分析”的全部需求，并把每一项需求映射到用户可见行为、前端状态、API、服务端数据源、持久化、状态迁移、错误恢复、自动化测试和真实验收证据。

本矩阵记录的是 **2026-08-01 当前工作树**。工作树仍有未提交修改。Node/API/Artifact/Playwright和静态门禁已有当前证据；Python全量283/283、Audience AI/profile专项37/37、Provider runtime15/15均已在当前工作树通过。第四轮真实Provider为严格partial validated，不是completed或`REAL-PROVIDER-PASSED`。

## 2. 状态与证据口径

| 标记 | 严格含义 |
| --- | --- |
| `CURRENT-PASSED` | 在当前最终源码修订后实际执行并通过；必须附命令和计数。 |
| `CURRENT-FAILED` | 在当前最终源码修订后实际执行但失败；不得改写成 partial success。 |
| `UNEXECUTED` | 当前轮没有执行，或环境不足；不得写成通过。 |
| `HISTORY-ONLY` | 实现过程中较早修订曾通过，但后续源码已变化，最终收口后尚未复验。 |
| `REAL-RELAY-PASSED` | 使用真实登录 Relay、真实页面和原任务检查点通过。fake Relay 不属于此类。 |
| `REAL-PROVIDER-PASSED` | 真实模型产生的结果通过 Schema、证据、coverage、Artifact 和状态校验。只完成模型调用不算通过。 |
| `REAL-PROVIDER-PARTIAL-VALIDATED` | 真实模型形成通过严格Artifact/Schema/evidence/coverage状态契约的partial产物，但仍有实体或综合失败；不等同passed。 |
| `REAL-PROVIDER-FAILED` | 真实模型被调用，但产物或状态没有通过严格校验。 |
| `FAKE-FIXTURE-PASSED` | fake Provider、fake Relay 或浏览器 route fixture 通过；只证明确定性契约。 |
| `IMPLEMENTED-UNVERIFIED` | 源码入口存在，但缺少当前轮完整运行证据。 |

证据优先级：真实任务真实链路 > 当前源码后的端到端执行 > 当前源码后的集成/单元测试 > fake fixture > 源码静态存在 > 历史结果。低级证据不能替代高级证据。

### 2.1 当前源码自动化证据快照

| 门禁 | 当前记录 | 证据级别/限制 |
| --- | --- | --- |
| Node串行全量 | 263/263 | `CURRENT-PASSED` |
| Audience AI focused Node | 52/52 | `CURRENT-PASSED`；含startup recovery、CAS/quiesce、SQLite物化、Artifact verifier/materializer、latest竞态、元数据篡改和精确651个SSE事件 |
| Python全量 / Audience AI focused | 283/283 / 37/37 | `CURRENT-PASSED` |
| Python Provider runtime | 15/15 | `CURRENT-PASSED` |
| API / Artifact | 52/52 / 1/1 | `CURRENT-PASSED`；API fixture不替代真实HTTP smoke |
| Playwright | 7/7 | `CURRENT-PASSED` fake route fixture；五视口含1024x768 |
| lint / format / typecheck / frontend build / credentials / dependency audit / diff-check | 全部通过 | `CURRENT-PASSED` |

以下真实门禁没有因自动化通过而改变状态：真实Relay、真实监听端口HTTP smoke、真实Node进程重启/WAL/孤儿进程对账、stale输入更新、三帖、成功completed+latest和Linux均为`UNEXECUTED`。

## 3. 需求闭环矩阵

表中“测试证据”只是覆盖入口；是否实际通过以验收报告的命令表为准。

| ID | 用户需求与可见行为 | 前端/状态 | API、数据源与持久化 | 错误、恢复与版本语义 | 测试或代码证据 | 当前证据级别 | 最终报告字段 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CORE-01 | AI 与主页补采都在原 `jobId` 内；只新增 `jobId + postId + runId` 子运行，不改变任务身份、创建时间或历史任务数量。 | 每帖按钮只接收当前 `jobId/postId`；补采确认文案声明原任务内执行。 | `/api/jobs/:jobId/audience/posts/:postId/ai/**`；`AudienceAiService`；`JobManager.runRelaySubtask()`；`analysis_runs.job_id/post_id/run_id`。 | 任何 foreign job/post/run 返回稳定错误；继续沿用同一 runId；主 Job 状态不被子运行覆盖。 | `server/audience-ai.test.mjs` 的 same-job/idempotency 测试；`server/audience-ai-profile-runner.test.mjs` 断言不创建顶层任务；E2E 断言无 `POST /api/jobs`。 | 第四轮在job `20260731093808-50dd4507`内沿用原runId resume、`checkpointReused=true`且未新建采集Job；真实Relay仍`UNEXECUTED`。 | 4-6、11-15、32-33 |
| CORE-02 | 分析、补采、取消、失败、刷新和 SSE 重连期间，原帖、评论、用户卡、已有主页和上一版结果持续可见；筛选、分页与滚动不因分析被清空。 | `AudienceAiPanel` 挂载在受众工作台，不替换评论流/用户卡；active version 与 current run 分开显示；状态条非破坏性。 | GET overview/results 与独立 SSE；服务端返回 active version、run 和 versions。 | 新运行失败/阻断不清空 active version；断线先恢复快照；最后成功快照保留。 | `tests/e2e/audience-ai.spec.ts` 的旧结果、原数据、刷新、取消/续跑 fixture。 | Playwright 7/7 `CURRENT-PASSED`（fake fixture）；真实刷新/恢复 `UNEXECUTED`。 | 20、22、24、30、35-37 |
| CORE-03 | 默认只分析已持久化数据，不启动 Relay、不打开浏览器、不搜索新帖子、不自动补主页。 | 默认 `profileMode=none`；只有 collection mode 要求显式确认和预算。 | input builder 读取原任务 Artifact/checkpoint；profile enrichment planner 仅在两种显式补采模式调用 runner。 | 无网络模式的 profile 缺失计入 unknown/coverage，不隐式降级成采集。 | `server/audience-ai.test.mjs` profile planning；`tests/test_audience_profile_supplement.py::test_no_missing_headers_finishes_without_opening_relay`。 | `FAKE-FIXTURE-PASSED`；真实“未打开 Relay”进程级证明待补。 | 5-6、11-12、19、32-36 |
| CORE-04 | 内容洞察、受众、关系扩散、继续采集、安全验证、Relay、AI Session、Artifact、旧 Job 和 Windows/Linux 启动保持兼容；不得复用主任务 `analysis` scope。 | feature flag 默认关闭；关闭时不渲染按钮、不请求新 API。 | `XHS_AUDIENCE_AI_ENABLED=false`；独立 service/store/runner；旧任务懒初始化。 | 新功能关闭时行为不变；旧 Job 无 AI 状态返回 `not_started` 而非报错。 | `server/audience-ai.test.mjs` feature flag；`tests/e2e/audience-ai.spec.ts` flag-off；Node/Python 全量回归。 | Node263/263、Python283/283、Playwright7/7当前通过；Linux `UNEXECUTED`。 | 1-3、21、28-31、36-39 |
| CORE-05 | 不用固定文本、关键词统计或 mock 冒充 AI；模型失败不得 completed；不引用不存在实体、不编造属性、不隐瞒未覆盖数据。 | partial/failed/blocked/stale 与 completed 显示不同；coverage 和 limitations 常驻。 | Python Provider runtime + JSON Schema + evidence resolver + deterministic completion；Node 只在产物校验后激活版本。 | Schema/evidence/coverage 失败必须 partial/failed；上一版保持 active。 | `tests/test_audience_ai_pipeline.py` 中 invalid JSON/evidence/provider output/prompt injection；第四轮真实Ollama证明partial被严格保留。 | Node状态映射/Artifact激活回归当前通过；第四轮为`partial/resumable`且未active/latest，`REAL-PROVIDER-PARTIAL-VALIDATED`。 | 9-10、16-20、23、28-29、32-39 |
| UI-01 | 每篇原帖有独立“AI 分析”按钮和 tooltip；不是隐式批量分析；不出现嵌套 button；原帖选择行为和键盘可达性不变。 | `App.tsx` 原帖项独立操作按钮；`AudienceAiPanel.tsx`；服务端状态驱动标签。 | overview API 为每个 post 单独读取。 | 无评论禁用并说明；旧任务显示未分析。 | `tests/e2e/audience-ai.spec.ts` 每帖按钮、flag-off、键盘路径。 | Playwright 7/7，`CURRENT-PASSED` fake fixture。 | 4、24-25、30、35 |
| UI-02 | 配置面板位于原帖列表和评论/用户工具栏之间，不替换数据区；显示帖子、覆盖、版本、Provider/model 和估算。 | `AudienceAiPanel` 的 input/range、coverage/budget、runtime、result 区；无营销页和嵌套卡片。 | preview + overview；authoritative counts 由后端返回。 | API 暂不可用时 panel 显示提示，原数据不清空。 | `src/AudienceAiPanel.tsx`；五视口快照。 | Playwright 7/7和五视口fixture当前通过；真实任务视觉仍未执行。 | 19、24-25、30、35 |
| UI-03 | 原帖内容固定不可关；顶评/回复/用户默认开；主页默认关；支持模块、Session、语言、证据严格度、incremental only。 | scope form、module checkbox、语言/strictness/增量字段；固定范围提示。 | strict start/preview request contract；后端不接受评论正文或前端计数。 | 未知字段、非法 module/limit/mode 被拒绝。 | `server/lib/audience-ai-contracts.mjs`；`server/audience-ai.test.mjs` contract test。 | `FAKE-FIXTURE-PASSED`。 | 7、11、15-17、21、24 |
| UI-04 | 主页严格区分 `none`、`available_header`、`collect_missing_header`、`recent_public_posts`；后两者显式预算，头部与帖子覆盖分开。 | radio/segmented choices；用户/每用户帖子/总帖子预算；网络确认。 | profile planner/runner/supplement；snapshot profileContext；coverage `profiles*` 与 `profilePosts*`。 | access restricted、security blocked、partial、cancel、resume 单独表达。 | profile runner Node 测试 + `tests/test_audience_profile_supplement.py`。 | fake fixture 通过；四种真实场景均未完整执行，真实 Relay `UNEXECUTED`。 | 11-12、19、24、27、32-37 |
| UI-05 | 提供开始、取消、继续、重新分析、上一版、覆盖预览和下载；双击幂等；取消保留 chunk 和上一版；继续复用 runId。 | action buttons 根据 `canStart/canCancel/canResume` 与 status 显示。 | start/cancel/resume/preview/results/artifact API。 | idempotency 冲突、不可继续、并发运行返回稳定错误；取消写 checkpoint/cancel marker。 | audience AI Node tests；pipeline CLI cancel/resume tests；E2E start/cancel/resume。 | focused Node52/52和Playwright7/7覆盖CAS/idempotency/UI；第四轮真实resume沿用原runId且复用checkpoint，真实取消和进程重启恢复仍未执行。 | 13-15、20-24、29-30、36-37 |
| UI-06 | 结果含综合、评论、用户、主页、内容匹配、机会、风险质量和证据；支持聚类、逐对象、筛选、排序、分页、版本和下载。 | result tabs、query/sort/pagination、version selector、artifact links。 | paginated results API；artifact enumeration/download。 | partial 数据仍可读；旧版本可选；空模块有明确空态。 | `AudienceAiPanel.tsx`；E2E fixture 对 overview/comment/user/version/download。 | Playwright7/7覆盖结果/版本/下载fixture；真实大结果浏览 `UNEXECUTED`。 | 9-10、18-24、30、34-35 |
| UI-07 | 评论/用户证据可跨页定位，展开线程、高亮、聚焦，并显示实际使用字段；不得只搜当前页。 | evidence click callback 切换评论流/用户卡并设置 anchor/highlight。 | comment/user anchor 语义由现有受众实体定位实现；evidence API 返回稳定 entity IDs。 | 目标不存在或被过滤时给提示，不谎报为全局不存在。 | E2E evidence route fixture；Python evidence refs。 | Playwright7/7含证据定位fixture；真实跨页证据跳转 `UNEXECUTED`。 | 18、21、24-25、30、35-37 |
| UI-08 | 覆盖无选帖、post 不存在、正文缺失、无评论、无稳定 userId、主页缺失/部分、Session 缺失/过期、Provider/上下文问题、Relay/安全等待、partial/failed/stale/旧任务。 | blockers/warnings/notice/status banner；AI 配置引导；无评论禁用；正文缺失阻断。 | preview blockers + stable error codes + health feature capability。 | 阻断不把主任务标失败；有旧结果时在其上方显示；Session 不自动创建。 | contract tests、E2E empty/blocker fixture；真实 provider partial Artifact。 | 多数fixture；第四轮真实partial和模型遗漏实体已记录；全空态视觉未完整真实执行。 | 13、16、20-22、24-26、30、36-37 |
| UI-09 | 逐评论/逐用户可看详情与证据；本期不以单对象重算替代整帖正确性，也不顺手实现不完整批量入口。 | 详情由结果列表展开；没有每卡多个常驻文字按钮。 | 无独立单对象重算/批量创建 API。 | 如未来新增，必须保留 lineage/旧结果并生成新版本。 | 当前 UI/API 静态审计。 | `IMPLEMENTED-UNVERIFIED`；属于负向边界。 | 4、21、24、37 |
| ANALYSIS-01 | 原帖主题、事实、观点、表达、结构、主张、预期受众、问题、方案、讨论点及媒体/OCR/已有分析进入上下文；不能只用标题。 | coverage 显示 body/media 可用性和 contextComplete。 | input builder 从 authoritative post payload 关联 body/media/OCR/analysis；synthesis `postContext`。 | 缺正文阻断或显式 context_incomplete，置信度下降，不反推正文。 | input builder Node test；Python normalization/synthesis tests。 | fixture通过；第四轮沿用真实目标帖snapshot。 | 7、17-19、23、32-34 |
| ANALYSIS-02 | 每条顶评和回复有结构化结果或 skip reason，包含 prompt 要求的 ID、情绪、立场、意图、需求、问题、异议、痛点、目标、角色、行动性、置信度、证据和质量标记。 | 评论洞察 tab/详情。 | `COMMENT_INSIGHT` Draft 2020-12 schema；comment JSONL + entity rows。 | 单实体失败可 skipped/partial，不丢其他 chunk。 | `scripts/audience_ai_schemas.py`；pipeline schema/foreign evidence tests。 | 第四轮4/4评论均有结果语义：1 analyzed、3 skipped=`model_omitted_entity`，严格状态partial。 | 9、17-19、23、28-29、32-34 |
| ANALYSIS-03 | 每个根评论及回复作为线程；输出主题、演化、观点、分歧、共识、问题、高价值回复、作者参与、深度、情绪变化和证据。 | 线程结果与评论详情关联。 | normalized comment tree；thread Map/checkpoints；thread JSONL。 | 父/回复不被错误拆开；超长线程携带 root + prior validated summary 后合并。 | pipeline root/missing parent/split thread/scale tests。 | `FAKE-FIXTURE-PASSED`；第四轮真实产出3条thread rows。 | 8-9、17-19、23、27-29、32-34 |
| ANALYSIS-04 | 每位当前帖评论用户聚合其全部顶评/回复/时序/回复对象/行为和允许的主页字段；有结果或 skip reason，不把一次评论当人格。 | 用户洞察/主页洞察详情。 | stable user aggregation + `USER_INSIGHT` schema + user JSONL。 | 无稳定 ID 使用任务内 synthetic identity；异常用户可独立 fallback，不永久拖垮批次。 | normalization、多评论用户、invalid user batch fallback tests。 | 第四轮usersAnalyzed=2/2；一次user batch失败后batch-to-single恢复成功。 | 10、17-19、23、28-29、32-34 |
| ANALYSIS-05 | 分群仅基于可观察内容/行为；每群有 id、定义、人数、评论数、占比、需求、问题、证据、置信度和局限；支持主/次归属。 | 综合总览和分群结果。 | `SYNTHESIS_SCHEMA.audienceSegments`；确定性去重/coverage。 | 人数/占比不一致阻止可信完成。 | synthesis validation and scale tests。 | 第四轮仍有1条synthesis evidence失败，因此只保留partial而未completed。 | 17-19、23、28-29、32-34 |
| ANALYSIS-06 | 主页只用实际公开字段；显示 available/missing/used fields、采集时间、access status、mode、用户/帖子覆盖和置信度。 | 主页 tab 与 profile coverage。 | profileContext schema；profile supplement writes selected public fields only。 | 缺字段为 unknown；不把简介缺失/低粉丝数解释为兴趣/价值。 | profile mode tests + sensitive prompt/schema tests。 | fake fixture；真实四模式未完成。 | 10-12、17-19、23、26、32-37 |
| ANALYSIS-07 | 输出原帖主张与关注点一致度、预期/实际差异、理解/误解/未回答/驱动/异议/缺失/可信度和改进建议；每条有 post + audience 双证据。 | 内容匹配 tab。 | `SYNTHESIS_SCHEMA.contentFit` + evidence resolver。 | 单边或无效证据不得进入可信结果。 | synthesis validator requires post/audience claims。 | fixture通过；第四轮1条synthesis evidence被拒绝，未冒充可信completed结果。 | 17-19、23、28-29、32-34 |
| ANALYSIS-08 | 生成后续选题、FAQ、评论回复、澄清、证据、案例、分群角度、问题和风险提醒；不生成骚扰/操纵建议。 | 内容机会/风险 tab。 | `contentOpportunities` enum + grounded refs。 | 无证据建议过滤；敏感/操纵内容受 system prompt 和 deterministic validator 限制。 | schema and prompt-injection/sensitive fixtures。 | fixture通过；第四轮真实综合仍有1条evidence失败。 | 17-19、23、26、28-29、32-34 |
| ANALYSIS-09 | coverage 独立记录 expected/collected/top/replies/analyzed/skipped/reasons/users/profiles/profile posts/body/media/checkpoints/snapshot/status/limitations；完成由确定性代码决定。 | coverage preview + result coverage。 | input snapshot counts、pipeline deterministic coverage、coverage.json、run metadata/store。 | 不把部分覆盖称全量；failed/partial 不激活 completed version。 | pipeline coverage tests；manifest tests。 | 第四轮coverage=partial、run status=partial/resumable，未active且未写latest。 | 19、23、27-29、32-34 |
| INPUT-01 | 前端只交 ID、scope、modules、idempotency 和预算；后端构建目标帖全量输入，不受当前分页/搜索/tab 影响。 | 表单不持有/上传完整评论或主页。 | `buildAudienceAiInput` 复用 audience read-through/checkpoint merge。 | 服务端重新验证 ownership/counts；空输入稳定阻断。 | input builder/service tests；E2E 请求捕获。 | fixture 通过；真实目标帖快照已生成。 | 5-7、15、19、21、32-34 |
| INPUT-02 | 原帖按 note/post ID、lineage、URL、唯一兼容映射关联，不做标题模糊匹配；快照含完整 provenance/hash。 | 显示关联后的原帖标题/body 状态。 | audience AI input builder + application payload reader。 | 多义匹配阻断 `POST_NOT_OWNED/POST_NOT_FOUND` 类错误。 | authoritative post body/foreign post tests。 | fixture 覆盖；多义真实数据未执行。 | 7、18-19、21、28-29、36 |
| INPUT-03 | 标准化评论 ID、post/parent/root/reply target/level/text/likes/time/location/url/user/collected/hash；处理重复、缺父、楼中楼、空文本、删除用户、冲突、坏时间、旧 checkpoint。 | 质量 flags/skip reasons 可查看。 | deterministic normalization + snapshot JSON。 | 坏记录局部 skipped，不让整帖失败。 | pipeline normalization root/missing parent/backend shape tests。 | fake fixture 通过；真实复杂坏数据覆盖未完整确认。 | 7-9、17-19、28-29、36-37 |
| INPUT-04 | 稳定 userId 聚合；display name/avatar 更新保留 provenance；无 ID 使用任务内 synthetic identity、不跨任务合并。 | 用户卡仍按 stable ID；分析标记 synthetic/quality。 | normalized users + current post user selection。 | 名称变化不重复计数；foreign post user 排除。 | profile supplement current-post filtering；normalization tests。 | fake fixture；真实 rename/synthetic identity 未执行。 | 7、10、18-19、28-29、36 |
| INPUT-05 | `inputRevision` 覆盖 post/media/comments/tree/users/selected profiles/posts/mode/replies/modules/prompt/schema/model config；密钥不入 hash；同输入可复用，新输入旧版 stale 不删。 | 显示 revision/stale/版本。 | immutable snapshot + SHA/hash manifest + `analysis_versions`。 | stale 后 active 旧版保持；refreeze 更新 revision/semantic identity；新版本校验后切换。 | snapshot revision/store tests；stale integration gate。 | focused Node 52/52已覆盖每历史版本按自身配置重算stale、一次性stale event、refreeze语义键和latest竞态；真实输入更新/增量复用未执行。 | 7、15、19-20、23、28-29、36-37 |
| PIPE-01 | 4,000+ 评论和 1,500+ 用户不单请求；采用可恢复 Map-Reduce。 | preview 显示 chunks/calls/token 估算和进度。 | Python post context -> thread Map -> comment normalize -> user batches -> synthesis -> validation -> artifacts。 | 每 chunk checkpoint；局部失败 partial；取消后恢复未完成 chunk。 | scale split tests；resume checkpoint tests。 | fake scale fixture 通过；真实 4,000+/1,500+ Provider 规模未执行。 | 8、12、17、27-29、36-37 |
| PIPE-02 | 动态预算含 system/schema/post/thread/output reserve/safety，输入比例可配置；超限拆线程/压缩已验证摘要，不静默丢尾部。 | preview 显示估算而非精确。 | model context tokens、token ratio、bounded chunk/user/synthesis builders。 | 超预算停止并 partial/failed；不越过 user budget。 | context/scale/synthesis high-cardinality tests；AI provider num_ctx test。 | fixture通过；第四轮真实run为7 calls、estimated 16,646 tokens，模型遗漏3个comment实体和1条synthesis evidence失败均被显式记录。 | 8、16-17、27-29、32-37 |
| PIPE-03 | Map prompt 固定系统指令、post context、thread、schema/enums/evidence/unknown/injection 规则；评论只作为不可信数据。 | 无直接用户可见 prompt；结果 quality/limitations 显示。 | prompt builder + Provider generate_json。 | 注入文本不得改变指令；原始失败响应只保留脱敏诊断。 | prompt injection fixture test。 | `FAKE-FIXTURE-PASSED`；真实 adversarial Provider 未执行。 | 17-18、26、28-29 |
| PIPE-04 | 用户先聚合再按 token 批量（建议 20-30，动态）；不默认每用户一次调用；单异常用户可独立重试。 | preview calls 反映批次。 | user batch builder/checkpoints/fallback。 | batch schema 失败时 per-user fallback；validated entity 可复用。 | invalid user batch fallback + scale tests。 | 第四轮真实发生1次user batch-to-single恢复并完成2/2用户；真实1,500用户规模未执行。 | 10、17、27-29、36-37 |
| PIPE-05 | synthesis 优先使用已验证结构化结果，生成主题/分布/需求/分群/匹配/机会/风险/质量/证据，不重新发明证据。 | overview tabs。 | bounded synthesis request + schema/evidence cross-check。 | 高基数 evidence/theme 压缩；无效 claim 过滤。 | synthesis budget and grounding tests。 | 第四轮真实synthesis仍有1条evidence失败，run因此保持partial。 | 17-19、27-29、32-34 |
| PIPE-06 | 每阶段版本化 JSON Schema；解析成功不等于合格；失败保存脱敏诊断、修复一次、再失败 chunk failed，其他继续。 | partial/failed 及 limitations。 | Draft 2020-12 schemas、schema_errors/assert_schema、repair path。 | chunk retry/repair上限；最终 partial/failed。 | invalid JSON/schema, repair, invalid diagnostics tests。 | 第四轮对3个模型遗漏comment给出`model_omitted_entity`，对1条synthesis evidence失败保留partial状态。 | 9-10、17、23、28-29、32-34 |
| PIPE-07 | 确定性 evidence resolver 校验实体存在、归属当前帖、excerpt/hash、profile scope、snapshot/job，不把模型文本当源证据。 | 每个证据可跳转；无效结论不显示为可信。 | evidence catalog/resolver + evidence JSONL/store。 | invalid/foreign/cross-post/hash mismatch 阻止 claim/完成。 | foreign evidence, invalid excerpt, synthesis evidence tests。 | 第四轮6条accepted evidence通过严格校验，另1条synthesis evidence被拒绝并阻止completed。 | 18、23、28-29、32-34 |
| PIPE-08 | 复用现有 AI Session/Provider；请求体不接收 key/Auth/baseUrl/命令；secret 只在子进程环境；记录公开 runtime/usage/cost/duration。 | Session 未配置/过期引导现有设置；provider/model 可见。 | `AiSessionStore.resolve()`、`AIProvider`、sanitized child env/metadata。 | secret 不写 SQLite/snapshot/log/SSE/artifact/error；Provider 429/timeout/error 可恢复。 | contract secret rejection、credential scan、provider tests、artifact diagnostic secret test。 | Provider runtime15/15和credential scan通过；第四轮`local_qwen/qwen3:4b`调用7次，cost=null，strict secret scan通过。 | 16-17、23、26-29、32-39 |
| STATE-01 | AI 使用独立状态机：not_started、snapshotting、profile wait/collect、comment/user analysis、synthesis、validation/export、partial/completed/blocked/interrupted/failed/cancelled/stale。 | 服务端 status 映射按钮/进度，不用点击临时状态伪造。 | `analysis_runs.status` + run events。 | 非法迁移拒绝；cancelling 不被迟到 runner event 倒退。 | store/service transition tests。 | focused Node52/52覆盖transition/CAS；第四轮真实run正确保持`partial/resumable`且exitCode=3，没有伪装为completed。 | 13、15、20、22、28-29、36-37 |
| STATE-02 | 每任务 `audience-ai-state.sqlite3` 使用 WAL、FK、事务、busy timeout、version/migration/crash recovery/active pointer；主 JSON 只留摘要。 | 页面从 store 快照恢复。 | 7 表：analysis_runs、input_snapshots、analysis_chunks、entity_insights、evidence_refs、run_events、analysis_versions。 | 幂等 migration；旧任务懒初始化；DB busy/崩溃可恢复。 | store schema/isolation/interrupted tests。 | 自动化物化通过；第四轮真实隔离库为chunks=6、insights=9、evidence=6且未active/latest。真实WAL crash/restart仍`UNEXECUTED`。 | 13-14、18、20、28-29、36-37 |
| STATE-03 | 稳定语义幂等键覆盖 job/post/revision/scope/module/model/prompt/schema；running/completed/cancelled 返回同 runId，不重复费用/Artifact。 | 双击开始只显示同一 run。 | unique idempotency_key/semantic_key + config hash。 | 同 key 不同配置/revision conflict；refreeze 后语义键同步。 | service idempotency test；E2E request count。 | focused Node52/52覆盖inputRevision幂等/CAS；第四轮真实resume沿用原runId且`checkpointReused=true`，完整费用重复对账仍未执行。 | 15、20、27-30、36-37 |
| STATE-04 | 同帖最多一个 active；不同帖有限并发默认 2；纯 AI 不占 Relay；补采遵守全局 Relay 锁；取消不影响主任务数据。 | waiting Relay/status；仅当前 panel 取消。 | service scheduler `maxConcurrent`；JobManager relay subtask。 | busy -> waiting，不创建新任务；取消 targeted process。 | profile runner serialization test；service concurrent tests。 | fake Relay fixture；真实 Relay wait/cancel `UNEXECUTED`。 | 5-6、12-15、27-29、32-37 |
| STATE-05 | Node 重启把无进程 running 置 interrupted/resumable；保留 completed chunks/旧版/SSE sequence；继续同 runId，不污染主 Job。 | 刷新后显示上一版和可继续进度。 | store startup recovery、checkpoint files、run events。 | 只跑未完成 chunk；SSE 快照+cursor 恢复。 | interrupted store test + CLI resume fixture；真实 kill/restart场景要求。 | 第四轮真实resume沿用原runId并复用checkpoint；生产startup recovery由focused Node52/52覆盖，真实kill/restart/WAL/孤儿进程对账仍`UNEXECUTED`。 | 12-15、20、22、29-33、36-37 |
| STATE-06 | 新运行前 active 仍是上一版；失败不切换；Schema/evidence/coverage/Artifact 校验后原子切换；旧版可浏览下载和比较。 | “正在更新，继续展示上一版” banner + version selector。 | analysis_versions active pointer + latest.json。 | validation failure保留旧 pointer；latest只能在Node完整校验后写。 | store activation + E2E old-version fixture + artifact tests。 | Node SHA/JSONL/materialization/latest竞态自动化通过；第四轮partial身份一致、未active且未写latest；真实成功切换未执行。 | 20、23-24、29-30、34-37 |
| API-01 | 提供 overview、preview、start、cancel、resume、run detail、paged results、SSE、评论/用户定位语义。 | `src/api.ts` 类型化方法；panel 消费。 | `server/app.mjs` audience post AI routes。 | 404/ownership/feature flag 均稳定响应；不路由到 create job。 | HTTP route tests + E2E route fixture。 | API 52/52 `CURRENT-PASSED`；真实监听端口 HTTP smoke `UNEXECUTED`。 | 21、24、29-30、36 |
| API-02 | 启动请求拒绝未知/secret/非法 mode/module/limit/foreign ID；服务端验证 job/post/session/state/input/idempotency。 | 表单仅发 contract 字段。 | `server/lib/audience-ai-contracts.mjs`。 | field-level validation details，不回显 secret。 | contract tests。 | `FAKE-FIXTURE-PASSED`。 | 15-16、21、26、28-29 |
| API-03 | 稳定错误码覆盖 job/post/input/body/session/running/revision/scope/limits/Relay/security/provider/schema/evidence/resume/cancel/internal；响应含 context/resumable/retry/requestId。 | notice/blocker按 errorCode 显示。 | app error mapper/service errors。 | 无 key、prompt、无关个人数据。 | HTTP stable error tests；provider/security fixtures。 | API 52/52和focused Node 52/52当前通过；真实HTTP响应人工抽检未执行。 | 13、16、21-22、26、28-29、36-37 |
| API-04 | SSE 含 snapshot/status/progress/profile/chunk/partial/completed/stale/blocked/failed/cancelled；进度含 run/post/stage/counts/usage/time；重连先 snapshot 再增量。 | EventSource 合并，不把结果重置为 0。 | persisted `run_events.sequence` + subscription。 | 握手期间无事件丢失、cursor分页、重连不重启 run。 | service SSE/HTTP tests + E2E reconnect fixture。 | 精确651个sequence事件验证订阅先于snapshot、高水位、500+分页、buffer去重和权威context；真实断线未执行。 | 22、24、29-30、36-37 |
| ART-01 | 每版本生成 manifest、analysis JSON/MD、comment/thread/user/evidence JSONL、coverage、run metadata 和 post latest pointer。 | 下载链接按 active/selected version 显示。 | `artifacts/audience-ai/<post>/<run>/` + existing artifact enumeration。 | partial/failed manifest 可解析；只有完整校验结果能切 latest。 | pipeline artifact tests + Node validator tests。 | Artifact1/1、focused Node52/52通过；第四轮partial产物9文件严格验证通过且未active/latest。 | 23、29、32-34、36-38 |
| ART-02 | manifest 含身份、revision、prompt/model/mode/modules/coverage/files/sizes/SHA/time/completion；analysis完整机器结果，MD可读范围/覆盖/证据/局限，JSONL逐行可解析。 | 下载时保留明确文件名。 | Python writer + Node validation/materialization。 | size/SHA/JSON/JSONL/identity/path traversal任一失败不得激活。 | artifact tests/credential scan；第四轮strict validator和manifest SHA。 | Node verifier/materializer与SQLite物化当前通过；第四轮manifest SHA=`0848f0d9e3b7f559fec597b2463276dada5d44bfcd8bcd47d59ccfd4efadcb9a`，结构通过但状态partial。 | 17-19、23、29、32-34、36-37 |
| ART-03 | Artifact 不含 key/Auth/session/Relay secret、未选用户、隐藏推理或不必要主页副本；旧任务无产物可读；删除任务联动；下载走安全路径。 | 无 audience artifact时正常空态。 | scrub/allowlist + existing `resolveDownload/assertPathInside` + lifecycle cleanup。 | 路径穿越拒绝；删除后状态/文件不可访问；Windows句柄关闭。 | credential/path/deletion tests。 | credential/path/lifecycle自动化当前通过；真实Windows open-handle删除仍`UNEXECUTED`。 | 23、26、28-31、36-37 |
| FE-01 | 明确 TS 类型，不扩散 `any`；Audience AI 独立组件/职责，现有评论/用户行为不变。 | `AudienceAiPanel.tsx` + types/api；App只负责挂载和证据回调。 | typed contracts。 | 类型错误由 typecheck阻止。 | `npm run typecheck`；frontend source audit。 | typecheck、lint、format和build均`CURRENT-PASSED`。 | 2、24-25、28-31 |
| FE-02 | 沿用现有字体/色/边框/圆角/间距/lucide/focus/语言；无新UI框架、大Hero、渐变、卡套卡、遮挡或按钮堆叠。 | scoped `.audience-ai-*` styles。 | 无后端影响。 | loading局部，不锁整页。 | screenshot review + lint/build。 | lint/build/Playwright7/7和五视口fixture通过；真实任务人工像素复核未执行。 | 24-25、30、35-37 |
| FE-03 | 390x844、768x1024、1024x768/900、1440x900和宽桌面无重叠/横溢；移动单列、长模型换行、tabs稳定。 | media queries/grid/minmax/overflow。 | 无后端影响。 | 小屏仍可取消、恢复和下载。 | `tests/e2e/audience-ai.spec.ts` 五视口 + win32 snapshots。 | Playwright 7/7、五视口含1024x768当前通过；真实任务和人工宽桌面验收未执行。 | 25、30、35、36 |
| FE-04 | 按钮有名称，图标有tooltip/aria-label，状态aria-live，键盘可操作，focus保留，颜色非唯一信号，证据后聚焦，reduced-motion关闭动画。 | semantic button/fieldset/label/status；reduced-motion CSS。 | 无后端影响。 | 错误提示可读且不抢焦点。 | E2E keyboard/accessibility assertions + source audit。 | Playwright键盘/accessibility fixture当前通过；屏幕阅读器实测 `UNEXECUTED`。 | 25、30、35-37 |
| SEC-01 | 只处理当前任务已有或显式补采的公开数据；最小化、目的限定、来源/证据、unknown、删除、日志脱敏、secret隔离、injection防护。 | collection confirmation和coverage/limitations。 | input allowlist、target user queue、scrub、evidence lineage、delete lifecycle。 | 未选择数据不入 snapshot/result；删除联动。 | secret/prompt injection/targeting tests。 | fake fixture；真实删除/Relay范围核验未执行。 | 12、18-19、23、26、28-29、36-37 |
| SEC-02 | 不推断未公开年龄、性别/取向、民族、宗教、政治、健康、收入、家庭、地址、联系方式等；公开自述仅在相关且有证据时引用；不按头像/昵称/地区推断，不贴价值标签或生成骚扰/操纵建议。 | 结果只展示 observable/expressed fields和limitations。 | system prompt、schema字段白名单、evidence validator。 | 敏感结论过滤/降级，不进入可信Artifact。 | sensitive fixture要求；schema没有protected-attribute字段。 | credential/相关自动化当前通过；真实人工敏感属性抽检未执行。 | 10、17-18、23、26、28-29、36-37 |
| PERF-01 | 配置模型并发、Provider限流、429退避、timeout、chunk/repair重试、token/cost预算、cancel checkpoint、内存与分页；默认并发2。 | preview显示预算；结果分页；运行可取消。 | config/env + provider runtime + bounded builders + service scheduler。 | Retry-After/预算耗尽/timeout保留partial和checkpoint。 | provider retry/timeout/scale/budget tests。 | fixture；真实429/成本上限/峰值内存未执行。 | 15-16、21、27-29、36-37 |
| PERF-02 | 记录snapshot/chunk/user/synthesis/validation耗时、token/cost/retry/429/峰值内存/DB/Artifact/SSE；无精确usage标 estimated。 | preview/run metadata显示estimated。 | run-metadata/store progress/manifest。 | 缺usage不得伪造精确费用。 | metadata assertions；第四轮真实run记录duration与estimated token。 | 第四轮7 calls、11,903/4,743/16,646 estimated tokens、186,773ms pipeline/187,420ms elapsed、cost=null；峰值内存/DB大小/真实SSE延迟未实测。 | 23、27、32-37 |
| MIG-01 | migration幂等、旧任务懒初始化、不要求删旧数据；失败不破坏主任务；有恢复路径；保护脏工作树且不格式化无关文件。 | 老任务打开保持原UI，flag关闭无变化。 | SQLite `PRAGMA user_version` + per-job initialization。 | newer schema拒绝；migration失败不改主Job。 | store migration/old job/feature flag + git diff audit。 | startup recovery/migration fixture及diff-check当前通过；跨版本真实回滚仍未执行。 | 1-3、14、28-31、36-38 |

## 4. 十阶段追踪

| 阶段 | 交付范围 | 主要源码 | 专项证据 | 当前判定 |
| --- | --- | --- | --- | --- |
| 1. 基线、契约、骨架 | flag、类型、状态/错误/API contract、旧 Job 兼容、不得新建 Job | `.env.example`、contracts、service、types/api | Node contract/flag tests | Node263/263、API52/52、typecheck/lint/build当前通过。 |
| 2. 输入快照与关联 | authoritative post、read-through comments、tree/users/profiles、coverage/revision、immutable snapshot | `server/lib/audience-ai-input.mjs` | Node input tests + Python normalization | `FAKE-FIXTURE-PASSED`；真实目标帖快照已生成。 |
| 3. SQLite、子运行、恢复 | 7表、migration、events、idempotency、locks、cancel/resume/interrupted | store/service | store/service tests | focused Node 52/52覆盖startup recovery、CAS、quiesce和SQLite物化；真实进程重启/WAL仍是发布门禁。 |
| 4. 评论与线程 AI | dynamic chunks、Map、comment/thread schema、provider、repair、evidence、partial | pipeline/schemas/provider runtime | Python pipeline tests | Python当前通过；第四轮真实run为1/4评论analyzed、3条`model_omitted_entity`、3条thread rows，严格partial。 |
| 5. 用户与综合 | user aggregation/batches/schema、segments/distributions/fit/opportunities/risks | pipeline/schemas | Python user/synthesis tests | 第四轮2/2用户通过且发生1次batch-to-single恢复；1条synthesis evidence失败，保持partial。 |
| 6. 主页模式与补采 | 四模式、target queue、Relay lock/security/checkpoint/refreeze/degrade | profile planner/runner/supplement | Node/Python profile tests | fake通过；真实 Relay四模式未执行。 |
| 7. API、SSE、Artifact | routes/contracts/errors/events/progress/files/manifest/latest/download/delete | app/service/store/pipeline | HTTP/service/artifact tests | API52/52、Artifact1/1、SSE651事件及verifier/materializer/latest竞态自动化通过；真实HTTP smoke和成功latest未执行。 |
| 8. 前端工作台 | 每帖按钮、scope、coverage、progress/results/evidence/version/download、responsive/a11y | App/Panel/api/types/styles | Playwright + snapshots | Playwright7/7、五视口含1024x768当前通过；真实任务截图/屏幕阅读器未执行。 |
| 9. 全量测试、性能、安全 | Node/Python/API/SQLite/fake providers/E2E/visual/scale/credential/CI | tests/scripts/package | 全量命令表 | Node263/263、focused52/52、Python283/283、Python focused37/37、Provider runtime15/15、API52/52、Artifact1/1、Playwright7/7和静态门禁通过；Linux未执行。 |
| 10. 真实任务、文档、收尾 | 4 profile模式、cancel/resume、restart、stale/incremental、evidence、download | 本文+验收报告+真实产物 | real job/provider/Relay/screenshots | 第四轮`audai-1785574268920-90278b07`=`REAL-PROVIDER-PARTIAL-VALIDATED`；真实Relay/HTTP/restart/stale/Linux/三帖/completed+latest=`UNEXECUTED`。 |

## 5. 必须测试矩阵映射

| 需求矩阵 | 已有自动化入口 | 不可替代的真实门禁 |
| --- | --- | --- |
| 契约 | `server/audience-ai.test.mjs`、`server/lib/audience-ai-contracts.mjs` | 真实HTTP smoke、secret响应人工抽检。 |
| 快照 | audience AI input tests、pipeline normalization tests | 真实大/中/部分三帖的source counts与原Artifact逐项对账。 |
| AI分析 | `tests/test_audience_ai_pipeline.py`、`tests/test_ai_provider_runtime.py` | 真实Provider结果必须评论/用户/synthesis均通过严格校验。 |
| 用户和主页 | profile runner/supplement tests | 四种profileMode，尤其真实Relay的定向补采、安全验证、取消恢复。 |
| 状态与恢复 | store/service/CLI cancel-resume tests | 真实并发双击、Node kill/restart、WAL、stale、失败保留active pointer。 |
| UI E2E | `tests/e2e/audience-ai.spec.ts` | 当前源码五视口运行已通过；仍需人工真实截图检查、屏幕阅读器和真实证据跨页跳转。 |
| Artifact | pipeline artifact tests、generic verifier/credential scan | 真实成功产物的size/SHA/JSONL/coverage/revision/latest/old version/delete/path检查。 |

## 6. 真实验收场景状态

| 场景 | 要求 | 当前状态 | 必须补齐的证据 |
| --- | --- | --- | --- |
| 1. `profileMode=none` | 不开Relay、job/task count不变、评论/用户/综合、证据可定位 | 第四轮真实run `audai-1785574268920-90278b07`：原runId resume、checkpoint复用、未新建采集Job；4 comments=1 analyzed+3 skipped，3 threads，2/2 users，6 evidence；9文件/SHA/SQLite物化通过，状态严格partial | 仍需completed真实run、进程/请求级未开Relay证明、证据跳转和成功active/latest Artifact。 |
| 2. `available_header` | 不开Relay、available/used、unknown、字段证据 | `UNEXECUTED` | 真实任务run及字段级证据。 |
| 3. `collect_missing_header` | 仅当前帖用户、同job、Relay等待、refreeze、partial | `UNEXECUTED` | `REAL-RELAY-PASSED`、checkpoint、安全验证/恢复和task count前后。 |
| 4. `recent_public_posts` | 小显式预算、不超限、头部/帖子覆盖分开、无关用户排除 | `UNEXECUTED` | 真实Relay请求预算、target user IDs、checkpoint与coverage。 |
| 5. 取消和恢复 | 完成若干chunk后取消、保留、同runId、只跑未完成、token不重计 | `UNEXECUTED`（仅fixture） | 真实provider event/checkpoint/token对账。 |
| 6. 服务重启 | Node中断、interrupted/resumable、刷新读旧版/进度、同runId、不新Job | `UNEXECUTED` | PID/时间、重启前后SQLite/events/job count、续跑结果。 |
| 7. 输入更新 | 新评论使旧版stale/可见、preview新增、增量复用、校验后切换 | `UNEXECUTED` | 同帖两个revision、chunk hash复用、active/latest切换时间。 |

第四轮真实隔离续跑的精确证据：

- identity：jobId=`20260731093808-50dd4507`，postId=`6a6b911c000000003301a90a`，runId=`audai-1785574268920-90278b07`；沿用原runId resume，`checkpointReused=true`，未新建采集Job，profileMode=`none`。
- Provider/model：`local_qwen / qwen3:4b`；snapshot原模型为`qwen3.5:4b`，实际模型差异明确记录为验收期间runner override。
- 状态/用量：`partial`、`resumable=true`、exitCode=3；7 calls；input/output/total=11,903/4,743/16,646 estimated tokens；pipeline/elapsed=186,773/187,420 ms；cost=null。
- coverage：4 comments=1 analyzed+3 skipped（`model_omitted_entity`）；3 thread rows；2/2 users analyzed；6 accepted evidence。
- 恢复/失败：1次user batch-to-single恢复；1条synthesis evidence失败。
- Artifact：9文件通过strict validator、SHA、JSON/JSONL、identity、coverage/count/evidence和secret scan；manifest SHA-256=`0848f0d9e3b7f559fec597b2463276dada5d44bfcd8bcd47d59ccfd4efadcb9a`。
- SQLite：6 chunks、9 insights、6 evidence；partial未active且未写latest，符合契约。
- Artifact路径：`E:\UserData\Temp\xhs-audience-ai-acceptance-fourth-20260801-165016\jobs\20260731093808-50dd4507\artifacts\audience-ai\6a6b911c000000003301a90a\audai-1785574268920-90278b07`。
- 验证记录：`E:\UserData\Temp\xhs-audience-ai-acceptance-fourth-20260801-165016\acceptance-validation.json`；SHA-256=`1D16ED708754E3F78AE8A2313F47847C65E611B8D2B0C7630F4B310EE411BCBF`。
- 严格分类：`REAL-PROVIDER-PARTIAL-VALIDATED`；不得写`REAL-PROVIDER-PASSED`、completed、release-ready。

## 7. 最终 30 条验收门禁

| # | 门禁 | 当前状态 | 关闭条件 |
| --- | --- | --- | --- |
| 1 | 每帖独立 AI 按钮 | Playwright7/7当前通过 | 真实任务人工交互。 |
| 2 | 原帖完整内容固定纳入 | fixture+第四轮真实snapshot续跑 | 成功真实run的input/hash/artifact。 |
| 3 | 全部持久化评论/回复可分析 | fixture | 真实三帖与源计数对账。 |
| 4 | 每评论有结果或skip reason | 第四轮4条均有语义：1 analyzed、3 `model_omitted_entity` | completed真实run全量coverage。 |
| 5 | 每用户有结果或skip reason | 第四轮2/2 users analyzed | completed真实run全量coverage。 |
| 6 | 主页显式可选 | fixture | 四模式真实验收。 |
| 7 | 默认不启动Relay | fixture | 真实none/available进程或事件证据。 |
| 8 | 补采同jobId | fake Relay | 真实Relay。 |
| 9 | 不创建新顶层Job | fixture | 真实前后task count。 |
| 10 | 不重新关键词搜索 | fixture/架构 | 真实请求/事件审计。 |
| 11 | 评论流/用户卡始终可见 | UI fixture | 真实运行截图。 |
| 12 | 上一版运行中可见 | UI fixture | 真实两版本运行截图。 |
| 13 | 4,000+分块 | scale fixture | 可接受fixture；发布前记录chunk数/内存/耗时。 |
| 14 | 用户批次 | scale fixture | 可接受fixture；发布前记录batch数。 |
| 15 | 重要结论有证据 | 第四轮6条accepted evidence通过，1条synthesis evidence被拒绝 | 真实成功run抽样+自动交叉校验。 |
| 16 | Schema/证据确定性校验 | Node verifier/materializer自动化通过；第四轮partial被准确保留且未active/latest | 成功真实run的双证据抽样。 |
| 17 | 缺失标unknown | fixture | 四模式真实抽检。 |
| 18 | 不推断敏感属性 | fixture | 真实/人工输出抽检。 |
| 19 | 同输入幂等 | focused Node52/52覆盖；第四轮沿用原runId且checkpoint复用 | 真实并发点击和完整费用对账。 |
| 20 | 新输入stale不删除 | focused Node52/52覆盖按历史配置重算和一次性stale event | 真实输入更新场景。 |
| 21 | 取消/重启可恢复 | startup recovery/CAS fixture通过；第四轮真实resume同runId | 真实取消和进程重启场景5/6。 |
| 22 | chunk不重跑 | 第四轮`checkpointReused=true` | 真实resume逐chunk调用/token完整对账。 |
| 23 | 新版本失败不覆盖旧版 | verifier/materializer/latest竞态通过；第四轮partial未active且未写latest | 真实两版本失败/partial场景和成功切换。 |
| 24 | API/SSE/Artifact兼容旧任务 | API52/52、Artifact1/1、SSE651事件及focused Node通过 | 真实旧job HTTP smoke。 |
| 25 | AI密钥不进持久层/日志/产物 | credential scan及第四轮strict secret scan通过 | 真实成功产物定向扫描。 |
| 26 | 五视口无重叠 | Playwright7/7、五张snapshot含1024x768 | 真实任务和人工宽桌面检查。 |
| 27 | 键盘/屏幕阅读器基本可用 | Playwright键盘路径当前通过 | 屏幕阅读器人工抽检。 |
| 28 | Node/Python/build/E2E通过 | Node263/263、focused52/52、Python283/283、Python focused37/37、Provider runtime15/15、API52/52、Artifact1/1、Playwright7/7和静态门禁通过 | 当前本地门禁已关闭；Linux另见29。 |
| 29 | Windows/Linux CI通过 | Windows本地Node/Python/静态/E2E当前通过；Linux `UNEXECUTED` | 两平台CURRENT-PASSED或远端CI证据。 |
| 30 | 真实任务/Provider/Artifact验证 | 第四轮`audai-1785574268920-90278b07`为`REAL-PROVIDER-PARTIAL-VALIDATED`；Artifact/SHA/SQLite/未latest契约通过 | 成功completed+latest真实provider及required real Relay场景。 |

## 8. 结论判定规则

1. 存在新建顶层任务、旧数据消失、无效证据、敏感推断、恢复失败或既有回归时：`Audience AI feature incomplete, release blocked`。
2. 代码门禁全部通过，但真实 Provider 或真实 Relay 尚未完成时：`Audience AI feature complete, real-environment acceptance pending`。
3. 真实链路、恢复、证据、视觉、Windows/Linux和全量回归全部通过时，才可写：`Audience AI feature completed and release-ready`。

当前代码门禁通过，第四轮真实Provider为严格partial validated，但不是`REAL-PROVIDER-PASSED`；真实Relay/HTTP smoke/进程重启/stale/Linux/三帖/成功completed+latest仍为`UNEXECUTED`。因此按规则2，当前结论是`Audience AI feature complete, real-environment acceptance pending`，不支持release-ready。最终状态以同一源码修订后的验收报告为唯一准据。
