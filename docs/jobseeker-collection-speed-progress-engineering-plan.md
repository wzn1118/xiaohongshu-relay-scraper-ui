# 求职采集提速与可理解进度系统：完整工程实施方案

版本：2026-08-03
范围：近 14 天关键词任务、岗位/非岗位模式、正文补全、AI 分析、岗位卡、求职材料、受众、扩量、导出与投递
目标用户：不需要理解采集器、Relay、SSE、worker、检查点或错误码的求职者

## 1. 结论先行

本次改造不应以“盲目增加浏览器并发”作为提速方案。当前链路健康采集时的速度并不差，主要损耗来自正文尚未渲染就被判空、普通失败触发页面重建、多个等待策略叠加、限流恢复由两层重复承担、缓存无法稳定命中，以及浏览器等待时把 AI、导出等本地任务一起锁住。

完整方案由四个支点组成：

1. **一个事实源**：以持久化 workflow ledger + 结构化事件作为进度、错误和恢复的唯一事实源。
2. **一条受控网络通道，多条本地资源通道**：浏览器采集保持单通道；缓存、解析、AI、导出、投递按资源独立并行。
3. **增量产出**：每获得一批合格正文就生成岗位分类、岗位卡和匹配结果，不等整批任务结束。
4. **求职者语言**：默认界面只回答“做到哪了、得到多少、还需多久、是否需要我操作、已经保存了什么”。

## 2. 成功标准

### 2.1 用户成功标准

任意时刻打开任务页，求职者在 10 秒内能回答：

- 当前是在找内容、读正文、确认岗位、匹配经历、准备材料，还是导出结果。
- 已找到多少相关内容、多少正文完整、多少确认为岗位、多少已经可准备投递。
- 当前是否还在工作、等待系统恢复、等待用户操作，或已完成可用部分。
- 已有成果是否保存，刷新页面或关闭页面后能否继续。
- 剩余数量、当前有效速度和可信的预计完成区间。

### 2.2 工程成功标准

- 合格正文不得因标题或作者先出现而被误判为已就绪。
- 正文 ledger、workflow snapshot、前端计数和导出物在同一 revision 下完全一致。
- 健康采集有效正文 p50 不低于 8 篇/分钟，目标 10–12 篇/分钟。
- 每新增一篇有效正文，健康请求放大不超过 1.15；包含瞬时失败不超过 1.30。
- 限流确认后 1 秒内停止普通请求，5 秒内持久化并释放采集进程。
- SSE 事件到前端 p95 小于 1 秒；断线恢复不丢阶段、警告和错误。
- 首批 10 篇合格正文完成后 30 秒内出现第一批可用岗位卡。

### 2.3 明确不做

- 不承诺绕过平台限制，也不通过无上限并发换取短期峰值。
- 不把搜索卡片标题当作真实正文。
- 不用一个总百分比掩盖各模块的不同完成度。
- 不因 AI、导出或邮件失败而把已经保存的正文和岗位卡标记为失败。

## 3. 当前链路审查结论

### 3.1 进度与错误问题

| 问题 | 当前表现 | 用户影响 | 代码证据 |
| --- | --- | --- | --- |
| 固定百分比兜底 | running/resuming 固定 48%，incomplete 固定 82% | 百分比不代表真实工作量，续跑会卡在旧值 | `src/App.tsx:392-402` |
| 单字段混用 | `progressCurrent/Total` 先后表示滚动、正文、AI 阶段、用户数 | 同一个数字在不同阶段改变含义 | `server/job-manager.mjs:2434` |
| 日志猜阶段 | 前端扫描最近 120 行并用正则判断 Agent | 日志文案变化、续跑或并发输出会使阶段跳错 | `src/App.tsx:3927-3937` |
| SSE 无回放 | 主任务 SSE 没有 sequence 和 Last-Event-ID | 断线期间的错误、重试和阶段切换可能丢失 | `server/app.mjs:3841-3869` |
| 错误直出 | stderr、内部英文 message、`detail_empty` 可进入前端 | 求职者不知道影响、是否保存、是否需操作 | `src/api.ts:3-25`、`server/app.mjs:3998` |
| 模块各自提示 | 主任务、受众、扩量、补全、AI 各自维护 notice | 后发消息覆盖先发消息，任务关系不清晰 | `src/App.tsx:1463-1590`、`3169-3215` |
| 可读性过小 | 关键说明大量为 8–10px | 普通用户和移动端难以阅读 | `src/styles.css:479-535` |

### 3.2 性能问题

| 问题 | 直接代价 | 代码证据 |
| --- | --- | --- |
| 正文等待条件过宽 | `h1` 或标题出现即继续，卡片回填标题又使提取提前返回，造成假空、重试和换页 | `vendor/.../scrape_xiaohongshu_search.py:808`、`:1381` |
| 普通失败也重建页面 | 正文为空、不可用等记录会导致页面回收，增加 CDP 和 DOM 初始化开销 | `scripts/parallel_body_completion.py:1258` |
| 每个 worker 都做 Relay 清理 | 多 worker 可能互相清理页面，直接加并发存在反效果 | `scripts/parallel_body_completion.py:953`、`vendor/.../scrape_xiaohongshu_search.py:365` |
| 多层等待叠加 | 每 6 条暂停、每 120 条固定休息、随机间隔和自适应间隔顺序执行 | `server/lib/contracts.mjs:332`、`scripts/parallel_body_completion.py:1268` |
| 双层限流恢复 | Python 最长等待约 59 分钟，退出后 JobManager 再调度续跑 | `scripts/parallel_body_completion.py:201-247`、`server/job-manager.mjs:584` |
| 过早宣布恢复 | JobManager 一条 `detail_ok` 就清除状态，采集器要求连续 3–5 次稳定成功 | `server/job-manager.mjs:2896` |
| 缓存启动全盘扫描 | 每次读取所有历史任务 JSON；原始 URL key 可能因参数不同不命中 | `scripts/parallel_body_completion.py:334`、`:499` |
| 全局运行锁 | 浏览器等待时，本地分析和导出也排队 | `server/job-manager.mjs:52`、`:1544` |

### 3.3 当前持久化样本揭示的问题

现有历史任务 `20260802092243-b5c73115` 的持久化文件中：

- `parallel-body-summary.json` 停在 237/320，时间为 10:58。
- 同一任务的 workflow/ledger 后续已到 251/320，待处理 69，时间为 13:11。
- 缓存启动扫描了 66 个历史任务，统计 330 个可用正文，但本次复用为 0。
- 日志中出现 120、240、480、900、900、900 秒的进程内等待。

这说明最终摘要、实时 ledger 和前端快照目前可能展示不同事实；长期等待与缓存失配比单纯页面加载更影响总时长。

## 4. 面向求职者的目标体验

### 4.1 首屏信息架构

任务标题示例：`AI 产品经理 · 近 14 天`。

首屏按以下顺序展示：

1. **当前结论**：正在获取完整正文 / 正在确认真实岗位 / 已完成可用部分 / 需要登录。
2. **成果数字**：相关内容、完整正文、确认岗位、可准备投递。
3. **当前工作**：`正文 251/320，本次新获取 179，历史复用 72，待处理 69`。
4. **速度与时间**：`当前有效速度 9.6 篇/分钟，预计 7–10 分钟`。
5. **求职旅程**：找内容 → 读正文 → 确认岗位 → 匹配经历 → 准备材料 → 整理结果。
6. **问题卡片**：仅在等待系统或需要用户操作时出现。
7. **高级诊断**：日志、Relay、CDP、worker、原始错误码和追踪号折叠显示。

### 4.2 计数口径

| 展示名称 | 严格定义 | 不得混入 |
| --- | --- | --- |
| 相关内容 | 发现阶段去重且在时间范围内的候选卡片 | 不得称为岗位 |
| 完整正文 | `detail_ok`、正文达到质量阈值、无访问限制标记、note ID 匹配 | 标题、摘要、卡片文本 |
| 确认岗位 | 完整正文经过岗位/非岗位分类并有来源证据 | 尚未分析的内容 |
| 可进行匹配 | 岗位职责和要求已提取，可与候选人经历比较 | 仅有岗位标题的记录 |
| 可准备投递 | 联系方式/入口、质量检查和必要材料状态满足规则 | 质量未通过的草稿 |
| 待处理 | 尚未开始或可自动重试的记录 | 已删除、永久不可用、取消记录 |

### 4.3 每条记录的可理解状态

- 等待读取
- 正在读取正文
- 正文已保存
- 正在确认是否为岗位
- 已确认为岗位
- 不是岗位，已归入经验/讨论
- 正在匹配你的经历
- 岗位卡已生成
- 投递材料待补充
- 可准备投递
- 暂时无法读取，稍后重试
- 内容不可查看，已跳过

### 4.4 页面文案原则

- 先说对用户的影响，再说系统动作。
- 任何问题都必须说明“已保存多少”。
- 需要用户操作时只给一个主操作按钮。
- 不把“立即检查是否恢复”写成“一键解除限流”。
- 默认界面不出现 SSE、Relay、CDP、worker、熔断、探测、`detail_empty`。
- 主要正文最小 14px，辅助说明最小 12px；仅技术详情可使用等宽小字。

## 5. 统一领域模型

### 5.1 任务族

一个用户任务使用稳定 `jobId`，每次启动或续跑产生新的 `attemptId`。正文补全、受众、扩量、导出和投递属于同一个任务族，但拥有独立模块状态。

```text
Job（用户任务，稳定）
  ├─ Attempt 1（首次运行）
  ├─ Attempt 2（正文续跑）
  ├─ Module: discovery
  ├─ Module: body
  ├─ Module: classify/extract/match/draft/quality
  ├─ Module: audience/expansion（可选）
  ├─ Module: artifact
  └─ Module: delivery
```

### 5.2 标准阶段

| 内部阶段 | 求职模式文案 | 非岗位模式文案 | 是否阻塞主结果 |
| --- | --- | --- | --- |
| preflight | 正在准备采集环境 | 正在准备采集环境 | 是 |
| discovery | 正在查找近 14 天相关内容 | 正在查找近 14 天相关内容 | 是 |
| body | 正在获取完整岗位详情 | 正在获取完整正文 | 是，但允许部分结果 |
| classify | 正在区分招聘信息和经验分享 | 正在整理内容类型 | 否，逐条完成 |
| extract | 正在提取职责、要求和投递入口 | 正在提取主题与观点 | 否，逐条完成 |
| match | 正在匹配你的经历 | 正在生成内容洞察 | 否 |
| draft | 正在准备求职沟通材料 | 正在生成内容摘要 | 否 |
| quality | 正在检查是否可用于投递 | 正在检查结果质量 | 否 |
| audience | 可选：正在分析评论和相关人群 | 正在分析评论和相关人群 | 否 |
| artifact | 正在整理页面结果和下载文件 | 正在整理页面结果和下载文件 | 否 |
| delivery | 正在发送已确认的材料 | 不适用 | 否 |

### 5.3 标准状态

`queued`、`running`、`waiting_system`、`waiting_user`、`retrying`、`partial`、`completed`、`failed`、`cancelled`。

状态解释必须基于模块：正文 `partial` 不应覆盖已完成的发现；导出 `failed` 不应覆盖已完成的岗位结果；受众 `partial` 不应让求职主流程显示失败。

## 6. 结构化事件与快照契约

### 6.1 唯一事实源

1. Python 与 Node 都写结构化 `WorkflowEventV1`。
2. 事件顺序写入持久化 event journal。
3. reducer 将事件投影为 `WorkflowSnapshotV3`。
4. workflow snapshot/ledger 是业务事实源；日志只用于诊断。
5. 前端只渲染 snapshot 和事件，不再通过日志正则推断阶段。

### 6.2 事件契约

```ts
type WorkflowEventV1 = {
  schemaVersion: 1
  eventId: string
  sequence: number
  jobId: string
  attemptId: string
  occurredAt: string
  type: 'task' | 'stage' | 'item' | 'checkpoint' | 'retry' | 'artifact' | 'warning' | 'error'
  stage: 'preflight' | 'discovery' | 'body' | 'classify' | 'extract' | 'match'
       | 'draft' | 'quality' | 'audience' | 'artifact' | 'delivery'
  state: 'queued' | 'running' | 'waiting_system' | 'waiting_user' | 'retrying'
       | 'partial' | 'completed' | 'failed' | 'cancelled'
  progress: {
    unit: 'card' | 'body' | 'job' | 'draft' | 'file' | 'email'
    done: number
    total: number | null
    succeeded: number
    reused: number
    retryable: number
    failed: number
    blocked: number
  }
  performance?: {
    activePerMinute: number | null
    wallPerMinute: number | null
    etaMinSeconds: number | null
    etaMaxSeconds: number | null
    confidence: 'low' | 'medium' | 'high'
  }
  message: { code: string; params?: Record<string, string | number | boolean> }
  problem?: UserProblem
  checkpoint?: { revision: number; savedAt: string; resumeAvailable: boolean }
  sourceRevision?: number
  outputRefs?: string[]
  technicalRef?: string
}
```

### 6.3 用户问题契约

```ts
type UserProblem = {
  code: string
  category: 'access' | 'network' | 'content' | 'browser' | 'storage'
          | 'analysis' | 'artifact' | 'delivery' | 'input' | 'unknown'
  severity: 'info' | 'warning' | 'blocking'
  userTitle: string
  userMessage: string
  preservedResultCount: number
  automaticAction: string | null
  retryable: boolean
  retryAt: string | null
  requiresUserAction: boolean
  action: { id: string; label: string } | null
  affectedStage: string
  technicalRef: string
}
```

### 6.4 快照契约

```ts
type WorkflowSnapshotV3 = {
  schemaVersion: 3
  revision: number
  throughSequence: number
  jobId: string
  activeAttemptId: string | null
  journey: 'job' | 'general' | 'body_import'
  state: string
  activeStage: string | null
  headline: string
  detail: string
  stages: StageSnapshot[]
  counts: {
    discovered: number
    fullText: number
    confirmedJobs: number
    nonJobs: number
    matchReady: number
    draftReady: number
    applicationReady: number
    pending: number
    retryable: number
    unavailable: number
  }
  speed: {
    activePerMinute: number | null
    wallPerMinute: number | null
    cacheHits: number
    networkSuccess: number
    etaMinSeconds: number | null
    etaMaxSeconds: number | null
    confidence: string
  }
  issues: UserProblem[]
  connection: { state: 'live' | 'reconnecting' | 'stale' | 'offline'; lastEventAt: string }
  checkpoint: { revision: number; savedAt: string; resumeAvailable: boolean }
}
```

### 6.5 契约单一来源

- 新增 `schemas/workflow-event-v1.schema.json` 和 `schemas/workflow-snapshot-v3.schema.json`。
- TypeScript 类型与 Python 校验器都由 schema 生成或由同一组契约 fixture 验证。
- CI 必须验证 JS reducer 与 Python reducer 对同一事件序列生成相同计数。
- 旧日志正则保留一个发布周期作为兼容 adapter，并记录 `legacyEventFallbackCount`。

## 7. 进度、速度和 ETA 计算

### 7.1 两种进度必须分开

- **成果覆盖率**：例如完整正文 251/320，跨 Attempt 保持真实累计。
- **本次续跑进度**：例如本次需补 69，已完成 12/69；新 Attempt 从 0 开始。

这解决“旧任务停在 82%，续跑仍从 82% 开始”的问题。

### 7.2 总进度规则

- 发现总量未稳定前不显示伪精确百分比，显示“正在扩大搜索范围”。
- 发现完成后锁定本次 denominator；新增扩量作为单独子任务，不让当前条倒退。
- 每个阶段保留自己的 `done/total/unit`，禁止复用一个 current/total。
- 如果产品仍需单一总百分比，按当前启用阶段归一化权重计算，并在同一 Attempt 内单调：preflight 3、discovery 12、body 45、classify/extract 20、match/draft/quality 15、artifact 5。
- audience、expansion、delivery 是独立分支，不计入求职主流程 100%。

### 7.3 有效速度

- 使用最近 20–50 个合格正文的滑动窗口。
- `activePerMinute` 排除缓存、限流等待、人工验证等待和任务排队。
- `wallPerMinute` 包含全部真实耗时，用于内部运营，不作为等待期间的完成承诺。
- 前端明确显示“有效采集速度”，缓存另显示“历史复用 N 条”。

### 7.4 ETA

- 仅在 total 稳定、非等待状态、至少 10 个网络成功样本后显示。
- 以最近窗口的 p25/p75 速度计算区间，而不是单点时间。
- 置信度：样本 <10 为 low，10–29 为 medium，>=30 且失败率稳定为 high。
- 限流或验证期间隐藏 ETA，改为显示下一次恢复检查时间。
- 文案例：`预计 7–10 分钟；平台状态变化会影响时间`。

## 8. 求职者错误字典

每个错误必须回答：发生了什么、保留了什么、系统接下来做什么、用户是否需要操作。

| code | 用户标题 | 用户说明模板 | 系统动作 | 主操作 |
| --- | --- | --- | --- | --- |
| RATE_LIMITED | 平台暂时限制访问 | 已保存 {saved}/{total} 篇，将在 {retryAt} 做一次恢复检查 | 停止普通请求并释放进程 | 立即检查是否恢复 |
| SECURITY_VERIFICATION | 需要完成页面验证 | 已保存 {saved} 篇；完成验证后从剩余内容继续 | 暂停采集并保留检查点 | 打开验证页面 |
| LOGIN_REQUIRED | 登录状态已失效 | 已有结果不会丢失，重新登录后继续 | 暂停受影响阶段 | 打开登录页 |
| NETWORK_TIMEOUT | 页面响应较慢 | 当前这条已排到稍后重试，不影响其他内容 | 一次延迟重试 | 无 |
| RELAY_DISCONNECTED | 采集浏览器连接中断 | 已保存 {saved} 篇，正在重新连接 | 自动重连一次 | 重新连接浏览器 |
| NOTE_UNAVAILABLE | 这条内容当前不可查看 | 可能已删除或限制访问，已跳过，不影响其他结果 | 标记终态并继续 | 无 |
| BODY_EMPTY | 正文暂时没有加载出来 | 当前条稍后再试，其他内容继续处理 | 更长等待后重试一次 | 无 |
| NOTE_ID_MISMATCH | 打开的内容与目标不一致 | 未保存错误正文，系统将换用备用入口重试一次 | 校验 ID 后 fallback | 无 |
| PROCESS_INTERRUPTED | 任务运行被中断 | 已完成结果和进度均已保存 | 标记可续跑 | 继续任务 |
| WORKFLOW_REVISION_CONFLICT | 保存进度时发生冲突 | 为保护已有结果，受影响步骤已暂停 | 停止写入并重新读取最新版本 | 重新加载状态 |
| WORKFLOW_STATE_INVALID | 进度文件需要修复 | 已有原始结果仍保留，系统不会覆盖它们 | 隔离损坏快照 | 查看修复选项 |
| DISK_WRITE_FAILED | 无法保存新的进度 | 已保存到上一个检查点，本轮已暂停 | 停止新增工作 | 检查磁盘空间 |
| AI_PROVIDER_BUSY | 智能整理暂时繁忙 | 正文和岗位信息已保存，稍后只补智能整理 | 进入 AI 重试队列 | 稍后重试整理 |
| ANALYSIS_FAILED | 部分岗位尚未整理完成 | 完整正文仍可查看，仅重试失败条目 | 按 source hash 增量重算 | 继续整理 |
| QUALITY_GATE_FAILED | 这份材料还不能标记为可投递 | 已生成草稿，但缺少来源或关键信息 | 保留草稿与原因 | 补充信息 |
| EXPORT_FAILED | 下载文件生成失败 | 页面结果已保存，可单独重新生成文件 | 重试 artifact 阶段 | 重新生成文件 |
| SMTP_NOT_VERIFIED | 发件邮箱尚未验证 | 求职材料已保存，尚未发送 | 不进入发送队列 | 验证邮箱 |
| SMTP_RECIPIENT_REJECTED | 收件地址未被接受 | 材料和发送记录已保存，请检查地址 | 保留幂等状态 | 修改收件地址 |
| EMAIL_SEND_STATUS_UNKNOWN | 发送结果暂时无法确认 | 不会自动重复发送，避免重复投递 | 等待审计或人工确认 | 查看发送记录 |
| UNKNOWN_ERROR | 当前步骤遇到未识别问题 | 已保存 {saved} 条，错误编号 {technicalRef} | 暂停受影响模块 | 重试当前步骤 |

非阻塞问题进入“需要关注”列表，不用全局 alert 覆盖整个页面。只有 `requiresUserAction=true` 的阻塞问题使用 `role="alert"`；普通进度使用 `aria-live="polite"`。

## 9. 采集提速设计

### 9.1 正文就绪判定

新判定顺序：

1. 导航完成到 commit。
2. 检查明确的限流、验证、登录、已删除状态。
3. 等待正文选择器出现且规范化正文达到最低长度。
4. 校验页面 note ID 与目标 note ID 一致。
5. 只有正文通过校验才返回 `BODY_OK`。
6. 标题和作者仅作为元数据，不得代表正文就绪。

每条详情返回：`statusCode`、`retryClass`、`bodyLength`、`noteIdMatched`、`navigationCount`、`gotoMs`、`renderWaitMs`、`extractMs`、`totalMs`。

### 9.2 页面复用

- 普通空正文、已删除、登录失效、一次超时不立即重建页面。
- 仅在 page/context/browser closed、DOM 明确损坏或达到固定使用次数时回收。
- 一个采集会话只有一个浏览器所有者，Relay 清理仅在会话建立前执行一次。
- worker 不再各自执行全局目标清理。
- 首选 URL 失败且属于传输问题或 note ID 不匹配时，最多使用一次备用 URL。
- 确认限流、验证、登录状态后禁止 fallback，避免放大请求。

### 9.3 单一自适应节流器

删除“批次暂停 + 固定大休息 + 随机间隔 + 自适应间隔”的累加模型，改为一个 governor：

- 输入：最近 20–50 次成功率、p95 页面耗时、连续空正文、限流信号。
- 输出：下一次最小间隔和当前速度档位。
- 健康时缓慢提速；失败增加时快速降速；恢复时渐进升速。
- 页面加载耗时计入间隔，避免页面已经花了 6 秒仍额外固定等待。
- 每次决策记录 reason，便于性能回放。

### 9.4 失败队列

记录分为：

1. fresh：从未请求，优先级最高。
2. transient：网络/空正文，可重试一次，延后处理。
3. access-blocked：限流/验证/登录，停止当前网络通道。
4. terminal：已删除、明确不可用、ID 不匹配重试耗尽，不再请求。

同一轮先完成 fresh，再处理 transient；不得让一个坏记录阻塞整个队列。

### 9.5 限流恢复单一所有者

- Python 首次确认限流后立即原子 checkpoint，发出 `RATE_LIMITED` 事件并在 5 秒内退出。
- JobManager 是唯一长期恢复调度器；Python 不再在进程内等待数十分钟。
- 到点只申请一个 `probe lease`，全局只允许一个恢复请求。
- 连续 3–5 次间隔成功后，状态才从 `waiting_system` 变为 `running`。
- 恢复先低速，观察窗口稳定后再回到正常速度。
- 页面按钮只触发一次恢复检查，不改变调度器安全边界。

### 9.6 索引化正文缓存

新增 `data/body-cache.sqlite`：

```sql
CREATE TABLE bodies (
  canonical_note_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  access_status TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  body_length INTEGER NOT NULL
);
CREATE TABLE note_aliases (
  alias TEXT PRIMARY KEY,
  canonical_note_id TEXT NOT NULL
);
CREATE INDEX bodies_fetched_at_idx ON bodies(fetched_at);
```

- key 优先使用规范化 note ID；URL 去掉临时查询参数后只作为 alias。
- 仅缓存通过正文质量校验的 `BODY_OK`。
- 历史 JSON 做一次迁移，不再每次扫描全部任务。
- 命中时记录 `cacheHit=true` 和来源任务，但不产生网络请求。
- 缓存失效按 TTL、extractor version 和正文 hash 管理。
- 启动目标：10,000 条索引查询小于 2 秒。

## 10. 资源调度与增量流水线

### 10.1 资源通道

| 资源通道 | 默认并发 | 承载任务 | 说明 |
| --- | ---: | --- | --- |
| browser_lane | 1 | discovery、body、audience、expansion | 共享平台访问预算，主求职正文优先 |
| ai_lane | 1 或提供方配额 | classify、extract、match、draft、quality | 与浏览器解耦，支持队列背压 |
| artifact_lane | 2 | JSON/CSV/XLSX/报告/图片处理 | 本地任务，可与采集并行 |
| delivery_lane | 1 | 邮件预览、发送、审计 | 严格幂等，独立于采集完成状态 |

平台冷却时释放 `browser_lane` 运行租约，但保留定时恢复计划；AI 与 artifact 可继续消费已经完成的正文。

### 10.2 增量分析

- 每新增 10 篇合格正文或每 15 秒形成一个微批次。
- 先做低成本岗位/非岗位分类与结构化提取，再做匹配和文案。
- 使用 `noteId + sourceHash + analyzerVersion` 作为幂等 key。
- 每条分析记录只有一个结果存储写入者；worker 返回结果，不直接竞争写完整 JSON。
- 中间结果写 SQLite 或分片，最终导出时按 revision 投影 JSON/CSV/XLSX。
- 正文续跑新增 20 条时，只重算这 20 条及依赖它们的汇总，不重算已有 251 条。

### 10.3 背压

- AI 队列超过高水位时，正文仍可继续落盘，但不无限加载到内存。
- artifact 队列只消费已提交 revision。
- 浏览器阶段不等待求职信生成完成。
- 用户优先级：主任务正文 > 用户主动续跑 > 恢复 canary > 受众 > 扩量。

## 11. 与所有现有模块的关系

| 模块 | 输入 | 输出 | 失败影响 | 恢复/失效规则 |
| --- | --- | --- | --- | --- |
| 参数与预检 | 关键词、14 天、模式、浏览器状态 | 可执行配置、preflight 状态 | 阻塞新采集，不影响历史结果 | 修复依赖后原 Attempt 继续 |
| Discovery | 关键词、时间范围 | 去重候选卡片、范围检查点 | 可显示已发现部分 | 续跑复用 cursor；discover-more 独立分支 |
| Body import | 用户导入链接 | 标准候选记录 | 跳过搜索，不影响其他任务 | 直接进入缓存与正文队列 |
| Body completion | 候选 ID、缓存 | 合格正文、逐条 ledger | 单条失败不阻塞整批 | 只请求未成功记录 |
| 岗位/非岗位分类 | 合格正文 | 分类、证据片段 | 未分析项保持“待确认” | source hash 变化才重算 |
| 结构化岗位信息 | 岗位正文 | 职责、要求、公司、地点、入口 | 对应岗位卡部分可用 | 字段级质量原因 |
| 媒体/图片 | 卡片/正文媒体 URL | 封面、OCR 或附件 | 不阻塞正文和岗位卡 | 异步低优先级 |
| 候选人 Profile | 用户事实、版本 | 匹配输入 | 不影响采集 | Profile 变化只失效 match/draft |
| Match | 岗位结构 + Profile | 匹配度、证据、差距 | 岗位卡仍可查看 | 按 profileVersion 增量重算 |
| Draft | Match + 用户选择 | 沟通文案/求职信版本 | 不影响岗位数据 | 草稿版本化，独立重试 |
| Quality gate | 来源、草稿、规则 | 可投递/待补充 | 只影响“可投递”标签 | 必须保存具体失败原因 |
| 结果页/岗位卡 | 各增量记录 | 可筛选列表 | 显示模块级部分状态 | 按 revision 单调合并 |
| Audience | 通用内容与评论目标 | 帖子/评论/用户 ledger | 不阻塞主结果 | 每帖 pending/partial/complete |
| Expansion | 种子结果、轮次配置 | 新候选与轮次摘要 | 不覆盖原结果 | 新 attempt/subtask，独立取消 |
| Artifact | 指定 sourceRevision | JSON/CSV/XLSX/报告 | 页面结果仍可用 | 单独重建，manifest 绑定 revision |
| Data Copilot | jobId、filter、revision | 只读洞察或显式操作 | 不改变任务状态 | 写操作需显式确认和审计 |
| Attachment | 草稿、用户文件 | 附件 bundle hash | 不影响草稿 | 内容寻址与版本绑定 |
| Email preview | 草稿版本、附件 hash、收件人 | previewRevision | 不发送 | 任一输入变化即失效 |
| Email send | 已确认 preview | 幂等发送审计 | 不改变采集/分析完成 | 不确定状态禁止自动重发 |
| Retention/cleanup | 引用关系、保留策略 | 删除计划 | 不得删除活动检查点/共享缓存 | reference count + owner lease |

## 12. 前端实施设计

### 12.1 新组件

- `TaskJourneyPanel`：显示求职旅程和每阶段状态。
- `OutcomeMetrics`：相关内容、完整正文、确认岗位、可准备投递。
- `CurrentWorkPanel`：当前阶段、done/total、有效速度、ETA、检查点时间。
- `TaskIssueCallout`：统一问题卡片和唯一主操作。
- `ModuleStatusList`：AI、受众、扩量、导出、投递的独立结果状态。
- `ConnectionHealth`：仅在断线/过期时显示“正在重新连接”。
- `TechnicalDetailsDrawer`：日志、错误码、attemptId、revision、Relay/CDP 详情。

### 12.2 事件处理

- 连接时先 GET 最新 snapshot，再使用 `after=throughSequence` 订阅。
- 每个 SSE 事件带 `id: sequence`；前端忽略小于等于当前 sequence 的事件。
- `EventSource.onerror` 后显示 reconnecting；30 秒无事件且任务仍运行显示 stale。
- 重连后先拉快照再播放缺失事件，防止状态回退。
- 全局 `notice` 改为按 job/module 分区的问题与操作队列。

### 12.3 响应式与无障碍

- 验证 360、768、1024、1440 宽度，无文字重叠和横向溢出。
- 进度条使用 `role="progressbar"`、`aria-valuenow/min/max`；不确定进度不伪造数值。
- 正常变化使用 polite；只在需要用户立即操作时使用 alert。
- 图标按钮具备 tooltip 和可访问名称。
- 倒计时每分钟或关键节点更新，避免读屏连续打断。

## 13. 后端与 Runner 实施设计

### 13.1 JobManager

- 引入 `ResourceScheduler`，替换单一全局 active 锁。
- 引入 `WorkflowEventStore`、`WorkflowReducer`、`UserProblemMapper`。
- 主任务 SSE 复用现有受众 AI 的 sequence、Last-Event-ID、replay 机制。
- 续跑时重置 attempt progress，不重置累计成果覆盖率。
- 限流仅由 JobManager 长期调度；一条成功不得清除限流。
- `jobs.json` 写入增加 owner lease 或迁移 SQLite，避免多服务实例最后写覆盖。

### 13.2 Python runner

- 输出单行 `WORKFLOW_EVENT {json}`，禁止用自由文本承载业务状态。
- body checkpoint 从“每次写完整 records/cards/failures”改为增量事件 + 周期快照。
- 保留最终 summary 作为某次 Attempt 报告，不再作为实时事实源。
- discovery、body、analysis、audience、artifact 的现有 checkpoint 继续保留并接入统一 revision。

### 13.3 工作流 schema

- 当前 JS/Python 各维护一套阶段与状态，迁移为共享 JSON Schema。
- 新阶段先通过 schema 扩展，旧 reader 对未知阶段忽略但保留。
- 每个 snapshot 更新必须携带 expected revision；冲突时停止写入并重放事件。
- overall terminal 状态必须与 activeStage、各 stage 状态满足一致性校验。

## 14. API 变更

### 14.1 新增/调整接口

```text
GET  /api/jobs/:id/experience-snapshot
GET  /api/jobs/:id/events?after=:sequence
GET  /api/jobs/:id/issues
POST /api/jobs/:id/actions/retry-stage
POST /api/jobs/:id/actions/check-recovery
POST /api/jobs/:id/actions/open-login
GET  /api/jobs/:id/technical-diagnostics
```

### 14.2 错误响应

API 错误响应统一为：

```json
{
  "code": "RATE_LIMITED",
  "message": "internal diagnostic message",
  "problem": {
    "userTitle": "平台暂时限制访问",
    "userMessage": "已保存 251/320 篇，将在 22:30 做一次恢复检查",
    "retryable": true,
    "retryAt": "2026-08-03T14:30:00Z",
    "requiresUserAction": false,
    "action": null,
    "technicalRef": "evt_..."
  }
}
```

前端 `request()` 必须保留 `code/problem/details/retryAt/action/resumable`，不能只抛 `Error.message`。

## 15. 数据一致性与幂等

- 规范化 ID：所有卡片、正文、分析、草稿引用同一 canonical note ID。
- 正文幂等：`noteId + bodyHash + extractorVersion`。
- 分析幂等：`noteId + sourceHash + analyzerVersion + profileVersion`。
- Artifact 幂等：`sourceRevision + artifactType + templateVersion`。
- Email 幂等：已存在 previewRevision/idempotencyKey 继续使用，未知发送状态禁止重发。
- 任何导出必须写入 source revision、正文覆盖率、生成时间和部分结果说明。
- 清理任务不得删除 active job、可续跑 checkpoint、被 artifact/draft 引用的 revision 或共享正文缓存。

## 16. 可观测性

### 16.1 关键指标

- `body_active_success_per_minute`
- `body_wall_success_per_minute`
- `body_request_amplification`
- `body_cache_hit_rate`
- `body_false_empty_rate`
- `page_recycle_rate`
- `fallback_navigation_rate`
- `rate_limit_events`
- `rate_limit_time_to_quiesce_ms`
- `recovery_probe_inflight`
- `workflow_revision_conflicts`
- `sse_delivery_latency_ms`
- `sse_replay_count`
- `first_job_card_latency_seconds`
- `analysis_queue_depth`
- `artifact_revision_mismatch`
- `unknown_user_problem_count`

### 16.2 每次运行报告

每个 Attempt 生成性能摘要：缓存命中、本次网络成功、各失败类型、页面 p50/p95、请求放大、页面回收次数、限流等待、AI 队列耗时、首批岗位卡耗时、最终 revision。

## 17. 测试矩阵

### 17.1 单元测试

- 正文晚于标题渲染时不得提前返回空正文。
- 有效正文包含普通“访问频繁”字样时不得仅凭全文误判限流，应基于明确页面状态。
- note ID 规范化、URL alias、缓存 TTL、extractor version。
- 各 failure code 到 UserProblem 的中文映射完整。
- overall/attempt/coverage progress 计算和单调规则。
- ETA 在样本不足、等待状态、total 未稳定时返回 null。
- JS/Python reducer 对同一 fixture 输出一致。

### 17.2 集成测试

- SSE 乱序、重复、断线、Last-Event-ID 回放。
- 进程强杀后续跑，不重复请求已成功正文。
- 限流后普通请求 1 秒内归零，5 秒内 checkpoint。
- 严格单飞恢复探测，连续成功阈值前不宣布恢复。
- AI 服务中断时正文和岗位卡继续可用。
- Artifact 失败后可只重试导出。
- Profile 变化只使 match/draft 失效。
- 受众/扩量失败不改变主求职结果状态。
- 多服务实例争抢 dataDir 时只有 owner 可写。

### 17.3 端到端测试

- 关键词 + 14 天 + 岗位模式。
- 同关键词 + 非岗位模式。
- 导入链接直接补正文。
- 20、50、320、900 条固定样本。
- 登录失效、人工验证、限流、网络超时、内容删除。
- 页面刷新、关闭重开、服务重启、机器睡眠恢复。
- 从岗位卡生成草稿、附件、邮件预览与幂等发送。

### 17.4 前端验证

- Playwright 覆盖 360/768/1440，检查文字重叠、进度条稳定和按钮可用。
- 读屏检查：正常进度不连续打断，阻塞问题只播报一次。
- 5 名不懂技术的求职者可在 10 秒内回答五个核心问题。
- 默认首屏不得出现内部错误码或工程术语。

## 18. 分阶段实施

### Phase 0：基线与契约冻结（1–2 天）

- 固定 20/50/320 样本与当前基线报告。
- 确认现有正文率、有效速度、请求放大、限流次数、页面回收率。
- 定义事件、快照、问题码 schema 和契约 fixtures。
- 增加 feature flags，不改变生产默认路径。

### Phase 1：进度与错误事实源（3–4 天）

- Python 输出结构化事件。
- JobManager event store/reducer/snapshot。
- 主任务 SSE sequence + replay。
- 兼容旧任务 snapshot adapter。
- 修复续跑继承 82% 和单条成功即宣布恢复。

### Phase 2：求职者前端（3–5 天）

- 新任务旅程、成果计数、当前工作、速度/ETA、问题卡片。
- 模块级状态和高级诊断抽屉。
- 去除日志猜阶段与 raw error 主展示。
- 统一主任务、正文补全、受众、扩量、导出提示。
- 响应式与无障碍测试。

### Phase 3：采集器提速（4–6 天）

- 修复正文就绪和 note ID 校验。
- 修复页面回收与 fallback 条件。
- 单一 governor 替代多层等待。
- 失败分类队列。
- Indexed body cache 与历史一次性迁移。

### Phase 4：恢复与资源调度（4–6 天）

- Python 限流快速退出。
- JobManager 单一恢复调度器和 canary lease。
- browser/AI/artifact/delivery 资源通道。
- 冷却期间释放浏览器运行槽，本地任务继续。

### Phase 5：增量岗位卡与全模块接入（4–6 天）

- 正文微批次、单写者结果存储。
- analysis 拆成 classify/extract/match/draft/quality。
- Profile、受众、扩量、artifact、Data Copilot、附件和邮件接入统一事件。
- 导出绑定 sourceRevision 和覆盖率。

### Phase 6：900 条硬化与发布（3–5 天）

- 固定样本 20 → 50 → 320 → 900 灰度。
- 故障注入、重启恢复、移动端、读屏和性能回归。
- 观察 24–48 小时，清理旧日志状态推断仅在指标稳定后进行。

## 19. 优先级与两周可交付范围

若只有一名工程师，两周内应完成可独立上线的 P0/P1：

1. 正文就绪、页面回收和 fallback 修复。
2. 结构化事件、统一问题码、SSE sequence/replay。
3. 求职者主进度面板、真实计数、连接状态、限流/登录/验证文案。
4. Python 限流快速退出 + JobManager 单一恢复调度。
5. 20/50/320 固定样本验收。

完整的 SQLite 缓存、资源通道、增量岗位卡和所有下游模块接入建议安排在随后 2–3 周。两人并行可在约 3–4 周完成全部 Phase；一人完整实施约 4–6 周。

## 20. 灰度、开关与回滚

建议开关：

- `structuredWorkflowEvents`
- `jobseekerProgressUI`
- `sequencedJobSse`
- `strictBodyReadyCheck`
- `indexedBodyCache`
- `singleRecoveryScheduler`
- `resourceLanes`
- `incrementalAnalysis`

灰度门槛：

- 20 条：正确性与文案。
- 50 条：页面复用、缓存与请求放大。
- 320 条：长任务、续跑、限流、SSE 重连。
- 900 条：容量、长时间稳定性、增量分析和导出一致性。

触发回滚：有效正文率下降、请求放大 >1.30、限流事件增加、revision 不一致、p95 延迟恶化 >20%、未知问题码非零持续增长。回滚仅关闭对应特性，不回退严格正文校验、检查点保护和幂等约束。

## 21. 最终验收清单

### 正确性

- [ ] 标题先出现、正文后出现的页面能够得到真实正文。
- [ ] 限流、验证、登录、删除、空正文互不误判。
- [ ] note ID 匹配率 100%。
- [ ] ledger 守恒且与前端、snapshot、导出同 revision 一致。

### 性能

- [ ] 健康有效速度 p50 >=8，目标 10–12 篇/分钟。
- [ ] 请求放大健康 <=1.15，含瞬时失败 <=1.30。
- [ ] 页面 p50 <=6 秒，p95 <=12 秒。
- [ ] 10,000 条缓存启动查询 <=2 秒。
- [ ] 首批岗位卡 <=首批 10 篇正文后 30 秒。

### 恢复

- [ ] 限流后 1 秒内停止普通请求、5 秒内释放进程。
- [ ] 恢复探测全局并发始终为 1。
- [ ] 重启后不重复访问已成功正文。
- [ ] 用户关闭页面不影响后台保存与续跑。

### 前端

- [ ] 首屏能回答当前步骤、成果、剩余量、时间、用户动作、保存状态。
- [ ] 所有生产错误码都有中文用户问题映射。
- [ ] 默认界面没有内部错误码和工程术语。
- [ ] 进度不因续跑、扩量或 SSE 乱序倒退。
- [ ] 360/768/1440 无重叠，字号和读屏符合要求。

### 模块隔离

- [ ] AI 失败不影响正文结果。
- [ ] 受众/扩量失败不影响主求职流程完成状态。
- [ ] Artifact 失败可独立重试。
- [ ] 邮件失败不改变岗位和材料状态，未知发送状态不自动重发。

## 22. 推荐第一批开发任务

1. 在 `vendor/.../scrape_xiaohongshu_search.py` 修复正文就绪判定和 note ID 校验。
2. 在 `scripts/parallel_body_completion.py` 收紧页面回收、fallback 和失败队列。
3. 新增 workflow event/snapshot JSON Schema 与跨语言 fixtures。
4. 在 `server/job-manager.mjs` 增加结构化事件 reducer，修复续跑百分比与限流恢复判定。
5. 在 `server/app.mjs` 为主任务 SSE 增加 sequence、Last-Event-ID 和 replay。
6. 在 `src/api.ts` 保留结构化问题信息并实现连接健康。
7. 在 `src/types.ts` 增加 snapshot/event/problem 类型。
8. 在 `src/App.tsx` 用任务旅程组件替换日志猜阶段和固定百分比。
9. 为所有错误码建立中文文案 fixture 和前端快照测试。
10. 按 20 → 50 → 320 固定样本跑第一轮验收，通过门槛后再进入缓存与资源通道改造。

这套顺序先修“结果是否真实”和“用户是否看得懂”，同时移除最大等待损耗；随后再用索引缓存和增量流水线扩大长期吞吐，避免以并发换来更高失败率。
