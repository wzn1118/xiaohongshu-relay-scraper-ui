# 数据模型、状态机与 Artifact 事实

## Job、Attempt 与持久化目录

- **XHS-DATA-001 [HEAD]**：Job 历史索引位于 `data/jobs/jobs.json`（由 `XHS_SERVER_DATA_DIR` 决定）；每个 Job 使用 `<jobId>/` 目录。
- **XHS-DATA-002 [HEAD]**：Job 目录包含 `artifacts/`、`run.log`、`workflow-state.json`；attempt 日志位于 `attempts/<attemptId>/run.log`。
- **XHS-DATA-003 [HEAD]**：事件 journal 位于 `data/jobs/job-events/<url-encoded-job-id>.jsonl`，服务启动会从磁盘尾部恢复。
- **XHS-DATA-004 [HEAD]**：Job 创建字段包括 id、schemaVersion、status、params、createdAt/updatedAt/startedAt/finishedAt、exitCode、outputDir、logPath、pid、progress、workflowSummary、attempts、statePath 与 artifactCount。
- **XHS-DATA-005 [HEAD]**：Job 的 `activeAttemptId`、`currentAttemptId`、`resumeCount`、`lastResumedAt` 与 `revision` 直接用于恢复可见性。
- **XHS-DATA-006 [HEAD]**：逻辑 Job 续跑不会创建新的逻辑 Job；`resume()` 在原 Job 上追加新的 attempt，并保留 `resumeScope`、`idempotencyKey` 与 `resumeFromJobId` 关系。
- **XHS-DATA-007 [HEAD]**：初始 attempt 状态为 `queued`；活动 attempt 状态集合为 `queued`、`resuming`、`running`。
- **XHS-DATA-008 [HEAD]**：终态 Job 集合为 `succeeded`、`incomplete`、`failed`、`cancelled`、`interrupted`、`blocked`；可恢复集合为除 `succeeded` 外的上述失败/中断/不完整状态。
- **XHS-DATA-009 [HEAD]**：恢复 scope 为 `full`、`discovery`、`body_completion`、`analysis`、`audience`、`artifacts`。
- **XHS-DATA-010 [HEAD]**：状态语义中保留历史兼容 `completed`，最终业务映射会将其规范化为 `succeeded`；UI experience snapshot 另有 `completed` 展示态。
- **XHS-DATA-011 [HEAD]**：Job busy 时可拒绝新任务，或在 `queueIfBusy` 下将任务排在活动 Job/Relay subtask 后。
- **XHS-DATA-012 [HEAD]**：启动前若 `recoveryBlockers` 非空，会拒绝新 Job/续跑，直到上一个孤儿进程清理成功。
- **XHS-DATA-013 [HEAD]**：服务重启发现活动 Job、活动 attempt、PID 或未确认 cleanup 时，会终止/清理进程，保留 checkpoint，并把 Job 改为 `interrupted`。
- **XHS-DATA-014 [HEAD]**：`interrupted` 的标准错误文本为“Server restarted before the task finished. Checkpoint preserved; resume is available.”，清理失败会追加 orphan cleanup 错误。
- **XHS-DATA-015 [HEAD]**：JobManager 的事件 journal 尾部读取上限 8 MiB，单个 Job 内存热事件上限 2,000 条。
- **XHS-DATA-016 [HEAD]**：body rate-limit 需要 3 次稳定成功才视作恢复；状态可为 waiting/stopped/scheduled/resuming/cleared。

## Workflow State v2

- **XHS-DATA-017 [HEAD]**：Node 与 Python workflow state schema 均为 version 2；Node 锁 timeout 10,000 ms、retry 50 ms、stale 30,000 ms；Python 对应 10 s、0.05 s、30 s。
- **XHS-DATA-018 [HEAD]**：五个 stage 名称为 `discovery`、`bodyCompletion`、`analysis`、`audience`、`artifacts`。
- **XHS-DATA-019 [HEAD]**：stage 状态集合为 `not_started`、`running`、`partial`、`blocked`、`completed`、`failed`、`cancelled`。
- **XHS-DATA-020 [HEAD]**：body record 状态为 discovered、queued、attempted、succeeded、failed、not_attempted、blocked、cancelled。
- **XHS-DATA-021 [HEAD]**：analysis record 状态为 not_started、running、partial、completed、failed、blocked。
- **XHS-DATA-022 [HEAD]**：audience entry 状态为 not_started、running、complete_reachable、partial_limit、partial_timeout、partial_verification、partial_cancelled、blocked、failed。
- **XHS-DATA-023 [HEAD]**：`discovery` stage 持久化 cursor、scrollCount、stableRoundCount、discoveredIds、discoveredCount、stopReason、lastCheckpointAt。
- **XHS-DATA-024 [HEAD]**：`bodyCompletion` stage 持久化 ledgerSchemaVersion、statisticsSource、records 以及 total/completed/remaining/attempted/failed/notAttempted/blocked/cancelled/pending counts。
- **XHS-DATA-025 [HEAD]**：body ledger 有 `conservationValid` 字段，校验 ledger 统计与总数守恒。
- **XHS-DATA-026 [HEAD]**：`analysis` stage 持久化每条 record 与 total/completed/remaining counts。
- **XHS-DATA-027 [HEAD]**：`audience` stage 持久化 posts、replyThreads、users 三类 ledger 及 posts/users total/completed、stopReason。
- **XHS-DATA-028 [HEAD]**：`artifacts` stage 持久化 sourceRevision、manifestRevision、generatedFiles、failedFiles。
- **XHS-DATA-029 [HEAD]**：每次状态提交通过 expected revision 检查，revision 不匹配抛出 `WORKFLOW_REVISION_CONFLICT`；写入采用原子 rename 与锁文件。
- **XHS-DATA-030 [HEAD]**：Python `WorkflowStateSession.commit()` 将 revision 加一，并将活动 attempt 的 checkpointRevisionAtEnd 绑定到新 revision。
- **XHS-DATA-031 [HEAD]**：`workflowStatePath(outputDir)` 实际返回 Job 目录下与 `artifacts` 同级的 `workflow-state.json`。

## Workflow Snapshot/Event

- **XHS-DATA-032 [HEAD]**：`adaptLegacyJobSnapshot()` 输出 `schemaVersion: 3` 的 WorkflowSnapshot，包含 revision、throughSequence、jobId、activeAttemptId、journey、state、activeStage、headline、detail、stages、counts、speed、issues、connection、checkpoint。
- **XHS-DATA-033 [HEAD]**：Snapshot counts 至少含 discovered、fullText、confirmedJobs、nonJobs、matchReady、draftReady、applicationReady、pending、retryable、unavailable。
- **XHS-DATA-034 [HEAD]**：Snapshot speed 含 activePerMinute、wallPerMinute、cacheHits、networkSuccess、etaMinSeconds、etaMaxSeconds、confidence。
- **XHS-DATA-035 [HEAD]**：WorkflowEvent schema version 为 1，事件含 eventId、sequence、jobId、attemptId、occurredAt、type、stage、state、progress、checkpoint、sourceRevision、technicalRef。
- **XHS-DATA-036 [HEAD]**：`reduceWorkflowSnapshot()` 拒绝错误 schema、非正 sequence、跨 Job 事件和旧序列事件；有效事件按 sequence 单调推进。
- **XHS-DATA-037 [HEAD]**：用户问题映射覆盖 rate limit、安全验证、登录失效、网络 timeout、Relay 断开、正文不可用、ID mismatch、Runner failed、进程中断、revision conflict、磁盘写入、AI busy、analysis failed、quality gate、导出、SMTP 与未知错误。

## Job Artifact 目录与格式

- **XHS-DATA-038 [HEAD]**：主采集结果常见 JSON 为 `xiaohongshu_cards_latest.json`、`xiaohongshu_cards_discovered.json`、`xiaohongshu_cards_out_of_scope.json`、`xiaohongshu_notes_latest.json`、`xiaohongshu_notes_latest_dedup.json`。
- **XHS-DATA-039 [HEAD]**：采集结果还可输出同名 CSV、XLSX，以及 `xiaohongshu_notes_structured.xlsx`。
- **XHS-DATA-040 [HEAD]**：正文恢复结果包括 `body-completion-ledger.json`、`parallel-body-summary.json`、`parallel_body_failures.json` 和 `body-events.jsonl`。
- **XHS-DATA-041 [HEAD]**：分析结果包括 `application_intelligence.json`、`.csv`、`.xlsx`、`application_intelligence_report.md`、`application_intelligence_summary.json`。
- **XHS-DATA-042 [HEAD]**：受众结果包括 `audience-posts.json`、`audience-users.json`、`audience-comments.json`、`audience-summary.json` 及 posts/users/comments/audience CSV/XLSX。
- **XHS-DATA-043 [HEAD]**：关系扩展结果包括 `expansion_frontier.json`、`expansion_rounds.json`、`expansion_summary.json`，以及 `expansion-request.json`。
- **XHS-DATA-044 [HEAD]**：Job Artifact 清单为 `artifact-manifest.json`；JobManager 会从 `workflow-summary.json` 回写 manifest status/updatedAt。
- **XHS-DATA-045 [HEAD]**：`server/lib/artifacts.mjs` 将 Artifact ID 约束为 `[A-Za-z0-9_-]{1,1024}`，拒绝绝对路径、`..` 越界和 root 外真实路径。
- **XHS-DATA-046 [HEAD]**：`verify-artifacts.mjs`/mock runner 的 Artifact 验证覆盖 allowed-root、非符号链接、manifest size/hash、note ID 一致性、CSV 记录数、XLSX ZIP 结构。
- **XHS-DATA-047 [HEAD]**：Artifact download 通过 Job 内部 outputDir 解析，不向公开响应泄露绝对存储路径。

## Candidate Profile 与来源文件

- **XHS-DATA-048 [HEAD]**：Profile ID 是 16 位小写十六进制；目录为 `data/profiles/<profileId>/`，主快照为 `profile_memory.json`，来源文件位于 `sources/`。
- **XHS-DATA-049 [HEAD]**：Profile 允许 `.pdf`、`.docx`、`.txt`、`.md`、`.json`、`.csv`、`.rtf`，单文件默认最大 12 MiB。
- **XHS-DATA-050 [HEAD]**：Profile import 最多 8 个文件，文件名被序号化为 `01-...`，非法字符归一为 `_`，并通过 Python `profile_memory.py` 生成 memory。
- **XHS-DATA-051 [HEAD]**：读取 source file 要求 basename、扩展名白名单、普通文件、非 symlink、非空且不超过上限；路径不接受目录穿越。
- **XHS-DATA-052 [HEAD]**：运行 Job 时 Profile 快照复制为 `candidate-profile.runtime.json`，从而让 Job 与后续 Profile 变化隔离。

## Draft v2 与质量绑定

- **XHS-DATA-053 [HEAD]**：草稿 store schema version 为 2，内容字段固定为 `greeting`、`email_subject`、`email_body`、`cover_letter`。
- **XHS-DATA-054 [HEAD]**：草稿 quality 状态为 `stale`、`passed`、`failed`；`draftId` 由 note identity 的 SHA-256 稳定生成，前缀为 `draft_`。
- **XHS-DATA-055 [HEAD]**：content hash 使用 `draft-content:v1` 前缀与规范化字段 JSON 的 SHA-256。
- **XHS-DATA-056 [HEAD]**：版本从 1 连续递增；currentVersion 必须指向最新 immutable version。
- **XHS-DATA-057 [HEAD]**：passed/failed 质量结果必须同时绑定 version、contentHash、qualityReportRef；stale 版本不得保留旧质量绑定。
- **XHS-DATA-058 [HEAD]**：发送解析 `resolveDraftForSend()` 会重新计算 content hash，并要求 qualityStatus=passed、qualityCheckedVersion/Hash 与当前版本完全一致。
- **XHS-DATA-059 [HEAD]**：旧 outreach/cover_letter_evaluation 可在读取时迁移为 v2；旧内容变化会追加 stale version。

## 应用批次状态

- **XHS-DATA-060 [HEAD]**：`APPLICATION_BATCH_SCHEMA_VERSION=1`；批次状态为 draft、ready、approved、running、paused、completed、cancelled。
- **XHS-DATA-061 [HEAD]**：批次 item 状态为 resolving、blocked_no_email、blocked_ambiguous、subject_pending、draft_pending、copy_quality_failed、quality_pending、filename_pending、ready、sending、sent、failed_retryable、unknown_manual_review、skipped。
- **XHS-DATA-062 [HEAD]**：批次状态转换为 draft→ready→approved→running→paused/completed/cancelled；终态 completed/cancelled 不再转换。
- **XHS-DATA-063 [HEAD]**：item `sending` 只允许到 sent、failed_retryable 或 unknown_manual_review；unknown_manual_review 可由人工 reconcile。
- **XHS-DATA-064 [HEAD]**：batch/item ID 使用安全字符与 Windows 保留名检查；metadata/settings/payload 各自最大 256 KiB。
- **XHS-DATA-065 [HEAD]**：批次持久化为 `<batchRoot>/<batchId>/batch.json`、`items/<itemId>.json`、`events.jsonl`，写入使用 `.store.lock`。
- **XHS-DATA-066 [HEAD]**：批次 service 默认/最大 batch size 均为 100；最小发送间隔范围为 0-60,000 ms。
- **XHS-DATA-067 [HEAD]**：批次 idempotency key 重复且 request hash 一致时返回 replay；相同 key 不同内容抛 conflict。

## Data Copilot JSON/JSONL store

- **XHS-DATA-068 [HEAD]**：`DATA_COPILOT_SCHEMA_VERSION=1`；每个 conversation 目录为 `data/copilot/<conversationId>/`。
- **XHS-DATA-069 [HEAD]**：conversation 文件为 `conversation.json`，日志文件为 `messages.jsonl`、`runs.jsonl`、`tool-runs.jsonl`。
- **XHS-DATA-070 [HEAD]**：conversation identity 绑定 `jobId`、`snapshotId`、`mode`、`scope`、`scopeHash`、`conversationId`；不同设置复用同一 id 会 conflict。
- **XHS-DATA-071 [HEAD]**：conversation 状态包含 idle、planning、executing、waiting_input、waiting_approval、stopping、paused、completed、partial、failed、cancelled、resumable，以及 legacy queued/running/cancelling/interrupted。
- **XHS-DATA-072 [HEAD]**：run 状态与 conversation 状态大体同构；tool run 状态另含 queued、approved、succeeded、skipped、outcome_unknown。
- **XHS-DATA-073 [HEAD]**：每条 JSONL 记录有 schemaVersion、sequence、idempotencyKey、payloadHash、createdAt；append 使用锁和原子整文件写入。
- **XHS-DATA-074 [HEAD]**：同一 idempotency key + 相同 payload hash 返回已有记录；不同 payload hash 抛 `COPILOT_IDEMPOTENCY_CONFLICT`。
- **XHS-DATA-075 [HEAD]**：Copilot JSON/JSONL 锁 timeout 为 10 秒，retry 25 ms，stale lock 5 分钟；Windows 原子 rename 最多 8 次、最大退避 250 ms。

## SQLite 生产状态 v4

- **XHS-DATA-076 [HEAD]**：`CopilotProductionStore` 使用 Node `node:sqlite`、WAL journal、foreign_keys、busy_timeout 5,000 ms，数据库默认为 `data/copilot/copilot-state.sqlite`。
- **XHS-DATA-077 [HEAD]**：生产 schema version 为 4，并插入四个 migration：legacy-production-state、durable-agent-runtime、mcp-access-plane、mcp-grant-snapshot-boundaries。
- **XHS-DATA-078 [HEAD]**：SQLite 表包括 snapshots、traces、usage_records、evaluation_runs、outbox、worker_leases、schema_migrations、turns、runs_v2、plan_revisions、run_nodes、node_attempts、context_compactions、context_pins、evidence_claims、mcp_grants、mcp_sessions、mcp_tool_runs、mcp_audit。
- **XHS-DATA-079 [HEAD]**：`runs_v2` 保存 response_id、previous_response_id、response_cursor、background、checkpoint/error JSON 与时间；`run_nodes`/`node_attempts` 保存 DAG 节点、依赖、尝试与输出。
- **XHS-DATA-080 [HEAD]**：usage_records 保存 provider/model、input/output tokens、tool_calls、latency 与 estimated_cost_usd。
- **XHS-DATA-081 [HEAD]**：context_compactions 保存 summary、source refs、token 数；context_pins 对 conversation/item type/item id 做唯一约束。
- **XHS-DATA-082 [HEAD]**：mcp_grants 保存 token hash/prefix、owner、conversation/job/snapshot、manifest hash、mode、scopes、allowed tools/resources、max risk、状态和期限。
- **XHS-DATA-083 [HEAD]**：mcp_tool_runs 对 `(grant_id,idempotency_key)` 做唯一约束，并保存 request_hash/action_hash、approval_id、状态与结果/错误。
- **XHS-DATA-084 [HEAD]**：mcp_audit 保存 grant/session/owner、action、status、detail JSON 与 occurred_at，并有时间索引。

## Copilot Attachment/Artifact manifest

- **XHS-DATA-085 [HEAD]**：Copilot file manifest schema version 为 1，文件清单名为 `index.json`，每条记录含 size、sha256、relative path、media type 与 revision。
- **XHS-DATA-086 [HEAD]**：附件默认最多 40 个、单个 20 MiB、总计 100 MiB；Artifact 单个最大 50 MiB、最大 100,000 行、256 列。
- **XHS-DATA-087 [HEAD]**：允许附件扩展名为 CSV、JSON、TXT、MD、XLSX、DOCX、PDF、PNG、JPG/JPEG、GIF、WEBP，并校验 MIME 与文件 magic signature。
- **XHS-DATA-088 [HEAD]**：Artifact 输出类型为 JSON、CSV、Markdown、XLSX；XLSX/DOCX/PDF 解析通过 Python helper，helper stdout 上限 2 MiB。
- **XHS-DATA-089 [HEAD]**：文件路径要求相对 conversation directory，禁止 POSIX/Windows 绝对路径、符号链接逃逸与 `..` 逃逸。
