# 主仓库工作流状态、Ledger 与恢复事实

来源：当前工作树 server/job-manager.mjs、scripts/workflow_state.py、scripts/body_completion_ledger.py 与 docs/ARCHITECTURE.md。

## Node JobManager 常量

| 常量                             | 值                                                              |
| -------------------------------- | --------------------------------------------------------------- |
| TERMINAL                         | succeeded、incomplete、failed、cancelled、interrupted、blocked  |
| ACTIVE_ATTEMPT_STATUSES          | queued、resuming、running                                       |
| RESUMABLE_JOB_STATUSES           | incomplete、interrupted、failed、cancelled、blocked             |
| RESUME_SCOPES                    | full、discovery、body_completion、analysis、audience、artifacts |
| RATE_LIMIT_RECOVERY_STATUSES     | waiting、stopped、scheduled、resuming                           |
| RATE_LIMIT_TERMINAL_STATUSES     | stopped、scheduled                                              |
| BODY_RATE_LIMIT_STABLE_SUCCESSES | 3                                                               |
| EVENT_JOURNAL_TAIL_BYTES         | 8 MiB                                                           |
| MAX_IN_MEMORY_JOB_EVENTS         | 2,000                                                           |

## Python WorkflowState

- schema version：2。
- stage names：discovery、bodyCompletion、analysis、audience、artifacts。
- state lock timeout：10 秒。
- lock retry：0.05 秒。
- stale lock：30 秒。
- 写入策略：同目录临时文件、flush、fsync、os.replace；随后尝试 fsync 父目录。
- Windows lock owner 检查使用 OpenProcess、GetExitCodeProcess 和 CloseHandle。
- revision 每次有效 mutation 增加 1。
- mutation 校验 expected revision，冲突代码为 WORKFLOW_REVISION_CONFLICT。
- lock timeout 错误代码为 WORKFLOW_STATE_LOCK_TIMEOUT。

## Resume scope 到 stage

| Scope           | 重新执行/覆盖的 stage                                    |
| --------------- | -------------------------------------------------------- |
| full            | discovery、bodyCompletion、analysis、audience、artifacts |
| discovery       | discovery                                                |
| body_completion | bodyCompletion、analysis、artifacts                      |
| analysis        | analysis、artifacts                                      |
| audience        | audience、artifacts                                      |
| artifacts       | artifacts                                                |

## Stage 状态

| 集合                 | 状态                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| terminal stage       | completed、failed、cancelled                                                                                                       |
| all stage            | not_started、running、partial、blocked、completed、failed、cancelled                                                               |
| body record          | discovered、queued、attempted、succeeded、failed、not_attempted、blocked、cancelled                                                |
| analysis record      | not_started、running、partial、completed、failed、blocked                                                                          |
| audience entry/reply | not_started、running、complete_reachable、partial_limit、partial_timeout、partial_verification、partial_cancelled、blocked、failed |

## BodyCompletionLedger

- ledger schema version：1。
- 文件名：body-completion-ledger.json。
- promotion fixture：body-ledger-fixed-fixture-v1。
- body statuses 与 WorkflowState body record 集合一致。
- terminal statuses：succeeded、failed、not_attempted、blocked、cancelled。
- 可重试 blocked reason：rate_limited、security_verification、security_verification_timeout。

### 每条记录的默认字段

| 字段                | 默认       |
| ------------------- | ---------- |
| noteId              | 来源 ID    |
| discoveredAt        | 当前 UTC   |
| bodyStatus/status   | discovered |
| attemptCount        | 0          |
| firstAttemptAt      | null       |
| lastAttemptAt       | null       |
| completedAt         | null       |
| failureCode         | 空字符串   |
| failureMessage      | 空字符串   |
| recoverable         | true       |
| stopReason          | 空字符串   |
| updatedAt           | 当前 UTC   |
| requestIds          | 空数组     |
| completedRequestIds | 空数组     |

### 归一化事实

- 输入 status=completed 会归一化为 succeeded。
- 未知 status 会归一化为 not_attempted。
- requestIds 与 completedRequestIds 保持第一次出现顺序去重。
- recoverable 默认在 status 不等于 succeeded 时为 true。

### 守恒式

discovered = succeeded + failed + not_attempted + blocked + cancelled + pending

其中 pending = discovered-status + queued + attempted。

summary 同时计算 discovered、attempted、succeeded、failed、notAttempted、blocked、cancelled、pending、completionRatePercent 和 conservation.valid/terminal。

## Attempt 事实

- 初始 attempt 默认状态 queued。
- resume attempt 默认状态 resuming。
- attempt id 格式包含 job id、四位 sequence 和随机 hex。
- 每个 attempt 有单独 attempts/[attempt-id]/run.log。
- attempt 记录 checkpointRevisionAtStart/End、progress unit、target、coverage baseline、pid、开始/结束时间与 stop reason。
- resume 支持 idempotency key；相同 scope/key 的已有 attempt 可直接返回。
- 已有 active attempt 时返回 JOB_ALREADY_RUNNING 或 JOB_ATTEMPT_ACTIVE。
- completed scope 重复恢复可返回 JOB_ALREADY_COMPLETED，forceCompleted 是特殊路径。

## 重启与取消

- 服务启动会识别 queued、resuming、running 或 state.activeAttemptId 的 in-flight job。
- orphan cleanup 失败会保留 cleanupError，并可产生 ORPHAN_CLEANUP_FAILED。
- 服务重启中断使用 server_restart/server_shutdown 原因。
- queued 且未启动的任务可以直接转 cancelled。
- running 任务取消会终止 child tree，再提交最终 state。
- expansion 有独立 running、cancelling、interrupted、completed/partial/failed 等 runtime/business 状态。

## 文档与代码词汇差异

- docs/ARCHITECTURE.md 用 completed 描述 Job 成功终态。
- 当前 JobManager TERMINAL 集合使用 succeeded，并额外包含 incomplete 与 blocked。
- Python stage 仍使用 completed。
- 面试时要区分“Job 级 succeeded/incomplete”与“stage/analysis 级 completed”，这也是契约文档需要继续统一的事实。

## 事实边界

- 状态和字段存在证明实现契约，不证明每条迁移都经过本轮动态测试。
- 具体可恢复性仍受 checkpoint、产物完整性、外部 Relay 和进程清理结果影响。
