# Data Copilot 全量升级方案：Codex 级数据工作台

**版本**：v1.0
**日期**：2026-08-03
**状态**：方案评审稿，尚未宣称任何功能已经落地

## 0. 结论先行

当前 Data Copilot 的主要问题不是“模型不够大”或“再加几个快捷按钮”，而是产品内核仍然是一个**侧边弹层 + 启发式计划器 + 一次性完整回答**。要接近 Codex 的使用感，需要把它升级为一个可持续运行、可验证、可追溯的 **Data Agent Workbench**：

1. **输出层**：从正则拼文本改成结构化 Answer AST，支持 Markdown/GFM、代码、表格、图表、引用、文件预览和可复制的结果块。
2. **智能层**：从固定步骤和关键词选工具改成模型驱动的任务图、上下文管理、确定性数据执行、证据验证和修复循环。
3. **运行层**：从非流式 JSON 请求改成带游标的 typed event log，支持 token delta、工具进度、审批、断线重连、后台任务和恢复。
4. **工作区层**：从单一 drawer 改成会话/任务、答案画布、活动/来源/产物检查器三栏工作区。
5. **边界层**：保留现有快照隔离、数据工具白名单、附件溯源、审批和幂等副作用；分析能力放入隔离的 SQL/Python 沙箱，外部连接默认关闭。

目标不是复制完整 Codex CLI。Codex 的文件和 shell 权限模型不适合直接嵌入数据产品；应采用 Responses/Agents 的编排能力，建立适合本项目数据边界的运行时。

## 1. 调研范围与证据

本方案基于三类证据：

- **本地代码和运行结果**：`src/DataCopilotPanel.tsx`、`src/DataCopilotMessage.tsx`、`src/data-copilot-transport.ts`、`server/data-copilot-runtime.mjs`、`server/copilot-agent-kernel.mjs`、`server/data-tool-registry.mjs`、`server/data-policy-engine.mjs`、`server/data-copilot-store.mjs`、`server/data-copilot-service.mjs`、`src/App.tsx` 以及现有 E2E/单元测试。
- **官方能力调研**：详见 [DATA_COPILOT_OFFICIAL_RESEARCH.md](./DATA_COPILOT_OFFICIAL_RESEARCH.md)，覆盖 Responses、Agents SDK、Code Interpreter、MCP、Tool Search、Skills、Codex App Server、审批、Tracing 和 Agent Evals。
- **产品形态对标**：Codex、Claude Code、Hex、Observable 的公开官方文档/产品页面，重点对比可追踪运行、权限、记忆、可检查数据分析和产物工作流，而不是比较模型宣传语。

### 1.1 当前工作区状态

当前仓库存在用户已有的未提交修改和新增文件。本方案只新增本文件，不覆盖或回滚其他修改。当前结论来自当前 checkout 的代码和测试，不把 README、HTTP 200 或旧报告当作功能证明。

### 1.2 可复核的现状证据

| 范围 | 当前实现 | 证据位置 | 结论 |
|---|---|---|---|
| 输出渲染 | `InlineSafeText`/`StructuredAssistantContent` 通过正则拆标题、列表和 URL，代码围栏会被剥掉 | `src/DataCopilotMessage.tsx:141-289` | 无真正 Markdown/GFM AST，答案像日志 |
| 消息呈现 | 普通文本、工具卡、邮件卡、引用卡各自渲染 | `src/DataCopilotMessage.tsx:677-1278` | 信息层级和视觉语言不统一 |
| 工作区 | 一个大型 drawer 组件混合会话、SSE、上传、审批、布局和发送状态 | `src/DataCopilotPanel.tsx:269-344` | 难以维护，无法扩展为路由化工作区 |
| 交互/无障碍 | 折叠和关闭都调用 `onClose`；外层 Escape 可能绕过内层 model dialog；resize handle 对辅助技术隐藏；会话行内嵌删除按钮 | `src/DataCopilotPanel.tsx:638-647`, `:1097-1107`, `:1221-1252`, `:1482-1523` | 关键操作语义不清，键盘/读屏/焦点行为不可靠 |
| 计划器 | `createAgentPlan` 固定 understand/inspect/produce/verify/respond 步骤 | `server/data-copilot-runtime.mjs:314-348` | 复杂任务没有动态拆解和依赖关系 |
| 模型调用 | 等待完整 JSON，未消费模型 token delta | `server/data-copilot-runtime.mjs:1022-1061` | 首 token 慢，无法展示真实进度 |
| 上下文 | 只保留最近约 60 条或 60,000 字符 | `server/data-copilot-runtime.mjs:1159-1181` | 没有 token 预算、相关性检索和正式压缩 |
| 验证 | 只检查是否有证据/产物/非空答案 | `server/copilot-agent-kernel.mjs:68-97` | 不验证数字、完整性、矛盾和引用蕴含 |
| 工具 | 记录、聚合、附件、岗位、投递、邮件、产物等边界工具已存在 | `server/data-tool-registry.mjs` | 数据域基础好，但缺 SQL/Python/图表/报告/语义检索 |
| 权限 | 工具白名单、快照和邮件审批/幂等已存在 | `server/data-policy-engine.mjs:68-133` | 是升级时应保留的安全基础；前端仍传 `allowedScopes: ['*']` |
| 会话 | store 追加时扫描并重写 JSONL，事件缓冲约 250 条 | `server/data-copilot-store.mjs:241-299`; `server/data-copilot-service.mjs:512-631` | 长历史、断线 gap 和崩溃恢复风险高 |
| CRUD | Context 声明了删除/重命名，但 transport/HTTP 没有完整 PATCH/DELETE | `src/data-copilot-transport.ts:63-176`; `server/data-copilot-http.mjs:63-163` | 会话管理不完整 |
| 上下文/上传 | 上下文分类选择会直接扩展为整类记录；没有 selected-only、clear/apply、摘要和 freshness；上传状态和发送禁用原因不充分 | `src/DataCopilotContextBrowser.tsx:115-162`, `:379-483`; `src/DataCopilotPanel.tsx:1666-1793` | 用户无法确认“模型到底会看到什么” |
| 测试 | `npm run typecheck` 通过；Data Copilot 定向套件 68 个子测试中 66 通过、1 跳过、1 整组超时，单独重跑通过 | 当前运行结果 | 不能称为全绿；需先修复并发/资源竞争和评测缺口 |

## 2. 对标研究与取舍

| 参考对象 | 借鉴 | 适配到 Data Copilot | 不直接复制 |
|---|---|---|---|
| Codex | 分层指令、可见子任务摘要、技能渐进披露、sandbox/approval、typed app-server 事件 | 建立项目级数据技能、活动摘要、三档权限和可重放事件日志 | 不嵌入完整 Codex CLI，不开放宿主机 shell/任意文件 |
| Claude Code | 默认只读、写入/命令需显式审批、项目记忆文件 | Read-only analysis / Workspace build / External action 三种模式；保存用户偏好和项目技能 | 不复制面向代码仓库的命令执行模型 |
| Hex | SQL/Python/无代码分析、图表和报告是可检查产物 | 提供受限 DuckDB/Python、计算血缘、图表块和报告导出 | 不让模型直接获得宿主机数据库凭证 |
| Observable | 数据连接、可探索图表和分析过程透明 | 图表数据、查询和来源可回看，支持 follow-up 重算 | 外部连接按工具/数据集显式 allowlist |
| OpenAI Responses/Agents | 流式事件、会话状态、后台运行、压缩、工具搜索、程序化工具调用、专家代理、Tracing/Evals | 作为 model gateway、orchestrator、sandbox 和评测的设计依据 | 不把原始隐藏推理展示给用户 |

**决策**：先用 HTTP/SSE 实现可重放事件；只有在事件量和延迟测量证明有必要时再增加 WebSocket。先实现单 manager + 少量 specialist，不用多智能体作为“变聪明”的营销开关。

## 3. 目标产品定义

### 3.1 用户心智模型

用户输入自然语言后，系统明确展示：

`理解目标 -> 读取范围 -> 计划 -> 执行数据操作 -> 校验 -> 综合答案 -> 生成产物`

计划和工具活动默认收进右侧 Activity，不污染答案正文；用户可以展开每一步，查看输入、输出、耗时、来源和重试原因。

### 3.2 三种工作模式

| 模式 | 默认权限 | 适合任务 | 典型结果 |
|---|---|---|---|
| **Ask** | 只读当前任务快照 | 查数、解释、比较、追问 | 带引用的答案、表格、简短计算 |
| **Analyze** | 只读数据 + 隔离计算沙箱 | 聚合、连接、分群、质量检查、图表 | 计算过程、图表、可重算数据集 |
| **Build** | 工作区写入；外部动作仍需审批 | 报告、XLSX/CSV/Markdown/PDF 草稿、邮件准备 | 版本化产物、差异、导出/发送审批 |

模式是权限和输出契约，不是三个不同的聊天页面。用户可在一次会话中切换，但每次 run 固定 `mode + snapshot + model` 并显示在运行条上。

### 3.3 Codex 式三栏工作区

**左栏：Sessions / Tasks**

- 按任务和 job 分组，支持搜索、重命名、归档、删除、置顶、未读和 cursor 分页。
- 会话卡展示标题、绑定快照、最近状态、最后更新时间、未读数。

**中栏：Answer Canvas**

- 只显示最终答案和可交互结果块；流式生成时先显示骨架和当前段落。
- 每个块支持复制、下载、引用定位、重算、继续追问、展开来源。
- 用户上翻后停止强制滚底，显示“回到底部/有新内容”按钮。

**右栏：Inspector**

- `Activity`：计划、agent、工具、耗时、输入输出摘要、重试和错误。
- `Sources`：来源、快照版本、筛选条件、引用到答案块的锚点。
- `Artifacts`：文件预览、版本、生成步骤、下载和差异。
- `Context`：当前纳入模型的记录、附件、技能、token 使用量和剔除原因。

移动端采用三栏堆叠：答案优先，Activity/Sources/Artifacts 通过底部 sheet 打开。不得把桌面三栏缩小成不可读的横向滚动区域。

### 3.4 视觉和交互规范

- 引入真正的 Markdown/GFM parser 和统一 block renderer，禁止再用正则决定段落结构。
- 正文使用更大的阅读字号和行高；代码、表格、引用、警告、结果卡有稳定的视觉层级。
- 状态用“正在读取数据”“正在验证计算”“等待审批”等人类可读标签；原始 `idle/planning/executing` 只放在详情。
- 保留 Lucide 图标，但为附件、关闭、折叠、取消、重试、审批、下载等图标补齐 `aria-label`、键盘焦点和 tooltip。
- 删除嵌套 `role=button`，将会话行和删除按钮拆成独立可聚焦控件；补齐 modal focus trap、`aria-live` 和 resize handle 语义。
- 消息、工具卡、引用和产物不能互相嵌套成视觉卡片；答案画布是页面区域，卡片只用于重复结果或审批确认。

## 4. 输出契约：从字符串到 Answer AST

### 4.1 Block 类型

首版固定以下类型，未知类型降级成安全的 `paragraph`，避免 UI 因模型新字段崩溃：

`heading`、`paragraph`、`list`、`table`、`code`、`quote`、`callout`、`chart`、`citation`、`artifact`、`checklist`、`diff`、`tool_summary`、`error`。

每个 block 具有 `id`、`kind`、`content`、`claimIds`、`sourceRefs`、`createdAt` 和可选 `provenance`。数值结果必须同时带计算表达式、输入行数、过滤条件和单位。

### 4.2 示例

```json
{
  "answerId": "ans_123",
  "blocks": [
    {
      "id": "b1",
      "kind": "paragraph",
      "content": "本月有效投递率为 42.8%。",
      "claimIds": ["claim_1"],
      "sourceRefs": ["src_job_20260803"]
    },
    {
      "id": "b2",
      "kind": "table",
      "content": {
        "columns": ["渠道", "有效投递", "总数", "占比"],
        "rows": [["直投", 214, 500, 0.428]]
      },
      "provenance": {
        "queryId": "q_7",
        "formula": "valid / total",
        "rowCount": 500
      },
      "sourceRefs": ["src_job_20260803"]
    }
  ]
}
```

### 4.3 渲染和流式规则

- 服务端输出结构化事件，前端按 block/id 增量合并；不把半截 Markdown 当作最终 HTML。
- 支持 GFM 表格、嵌套列表、代码高亮、复制、引用锚点、图片/图表、下载和错误恢复。
- 引用必须能从答案 block 跳到来源预览；来源显示快照版本和筛选条件。
- 结果块可以“查看计算”“用新筛选重算”“生成产物”，但每次重算产生新 run，不静默修改旧答案。

## 5. Agent 内核升级

### 5.1 Model Gateway

新增 `server/copilot/model-gateway.mjs`，统一处理：

- Responses 原生 `stream: true`、typed delta、工具调用和 structured output。
- 每个 run 持久化 `provider/model/modelVersion/responseId/previousResponseId`；重连依靠事件 cursor，不重复提交副作用。
- Chat Completions 作为兼容 fallback，能力矩阵明确标注是否支持 reasoning、structured output、background 和 tool search。
- 记录 token usage、首 token、总耗时、停止原因和 provider request id。
- 深度报告用 background run；WebSocket 仅在 SSE 的测量指标不达标时加入。
- 只展示短的 reasoning summary、计划和证据，不展示原始隐藏推理。

### 5.2 模型驱动任务图

把固定 `createAgentPlan` 替换成 schema 校验后的任务合同：

```json
{
  "goal": "比较两个 job 的受众覆盖率并解释差异",
  "mode": "Analyze",
  "snapshot": "snap_20260803_r12",
  "constraints": ["只读", "所有数字必须有来源"],
  "acceptanceCriteria": ["覆盖率按同一分母计算", "差异给出证据"],
  "steps": [
    {"id":"s1","kind":"inspect","tool":"dataset.describe"},
    {"id":"s2","kind":"query","tool":"records.aggregate","dependsOn":["s1"]},
    {"id":"s3","kind":"verify","dependsOn":["s2"]},
    {"id":"s4","kind":"synthesize","dependsOn":["s3"]}
  ],
  "requiredEvidence": ["dataset_schema", "query_result", "verification"]
}
```

调度器负责依赖、并行、超时、取消、预算和幂等；模型负责语义判断，确定性代码负责过滤、连接、排序、去重、聚合和格式转换。固定启发式内核只保留为 provider 不可用时的降级路径。

### 5.3 Context Manager

新增 `server/copilot/context-manager.mjs`：

- 将 UI transcript 与模型 context 分离，维护 `workingSet`、快照清单、用户偏好、技能和证据索引。
- 预先统计消息、工具 schema 和 MCP schema 的 token 消耗；只加载当前任务需要的工具。
- 采用相关性排序和分层摘要，不再按字符数硬截最近 60 条。
- 对长任务使用服务端 compaction 状态；保留可恢复的 opaque item，不自行改写未知压缩内容。
- 在 Inspector 显示已包含、被压缩、被排除的来源和 token 水位。

### 5.4 数据工具和沙箱

保留现有数据域工具和 policy engine，新增：

- `dataset.profile`：缺失率、唯一率、类型、异常值、时间范围。
- `sql.query`：只读 DuckDB，输入只能引用已授权快照/附件。
- `python.analyze`：隔离 Python/pandas，返回表格、统计和可复算脚本。
- `chart.create`：从已验证数据生成 Vega-Lite/PNG/SVG 产物。
- `report.compose`：把答案 AST 和来源清单导出 Markdown/XLSX/PDF；每个文件有 manifest。
- `semantic.search`：仅在当前 job/附件范围内检索，结果带 source id 和版本。

沙箱必须有每 run 的临时目录、CPU/内存/文件大小/执行时长/网络配额、TTL 和清理任务；默认不提供宿主机 shell、任意 HTTP 或任意文件系统。程序化工具调用用于大量确定性记录变换，模型只接收摘要和抽样结果。

### 5.5 Evidence Graph 和 Verifier

新增 `server/copilot/evidence-graph.mjs` 与 `server/copilot/verifier.mjs`：

- 每个事实绑定 `claim -> sourceRefs -> query/calculation -> result`。
- 检查数值和公式、过滤条件、分母一致性、结果完整性、来源新鲜度、矛盾来源、引用是否真正支持结论。
- 校验产物 schema、文件存在性、行列数量和 manifest；失败时进入有限 repair loop，而不是直接生成一段看似完整的文字。
- 最终答案带 `confidence` 和未验证项；没有证据的内容必须明确标为推断或待确认。

### 5.6 Specialist agents

第一期只提供 manager 下的四类受限 specialist：`DataAnalyst`、`ContentAnalyst`、`Researcher`、`CriticVerifier`。独立分支才并行，最多 2-3 个；每个 specialist 只获得必要数据和任务合同，向 manager 返回结构化摘要，不把原始中间输出灌进主时间线。

## 6. 事件协议和可靠运行

### 6.1 Typed events

事件类型固定为：

`run.created`、`plan.created`、`plan.updated`、`message.delta`、`message.completed`、`agent.started`、`agent.completed`、`tool.call`、`tool.progress`、`tool.result`、`citation.added`、`artifact.ready`、`approval.required`、`approval.resolved`、`verification.started`、`verification.completed`、`usage.updated`、`run.completed`、`run.failed`、`run.cancelled`、`event.gap`。

事件统一字段：

```json
{
  "eventId": "evt_00042",
  "conversationId": "conv_1",
  "runId": "run_9",
  "seq": 42,
  "type": "tool.progress",
  "occurredAt": "2026-08-03T10:00:00.000Z",
  "payload": {"toolCallId":"tc_2","phase":"aggregate","percent":62},
  "idempotencyKey": "run_9:tc_2:progress:62"
}
```

SSE 使用 `Last-Event-ID`/`afterSeq` 重放；游标超出保留窗口时返回 `event.gap` 和最新 snapshot，客户端必须 reset，而不是静默继续。所有副作用工具都以 `idempotencyKey` 去重。

### 6.2 运行状态

用户可见状态：`准备中`、`读取数据`、`分析中`、`验证中`、`生成产物`、`等待审批`、`已完成`、`已取消`、`需要修复`、`失败`。内部状态保留 `queued/running/waiting_approval/resuming/completed/failed/cancelled`，并在 crash 后由 lease/heartbeat 重新接管。

### 6.3 持久化

先用 SQLite WAL 替换 JSONL，再为多实例部署保留 Postgres 迁移路径。核心表：

`conversations`、`messages`、`runs`、`run_steps`、`tool_calls`、`events`、`approvals`、`snapshots`、`sources`、`evidence`、`artifacts`、`attachments`、`outbox`。

事件和消息用 `(conversation_id, seq)` 索引，列表和消息均 cursor 分页；事件写入、outbox 和 run 状态在同一事务内完成。保留策略、压缩和归档必须显式可见。

## 7. 前后端边界与 API

### 7.1 前端拆分

不要继续扩张 `DataCopilotPanel.tsx`。建议目录：

```text
src/copilot/
  workspace/ChatWorkspace.tsx
  sessions/SessionRail.tsx
  timeline/AnswerCanvas.tsx
  timeline/BlockRenderer.tsx
  timeline/ActivityTimeline.tsx
  composer/Composer.tsx
  inspector/Inspector.tsx
  inspector/SourcePanel.tsx
  inspector/ArtifactPanel.tsx
  inspector/ContextPanel.tsx
  approval/ApprovalSheet.tsx
  rendering/markdown.ts
  rendering/answer-schema.ts
  state/copilot-store.ts
  transport/copilot-events.ts
```

现有 `DataCopilotPanel` 先作为兼容入口，内部逐步委托给 `ChatWorkspace`；`App.tsx` 只负责路由、job/mode 上下文和 provider 注入，不持有消息细节。

### 7.2 后端拆分

```text
server/copilot/
  model-gateway.mjs
  orchestrator.mjs
  context-manager.mjs
  event-log.mjs
  conversation-repository.mjs
  sandbox.mjs
  evidence-graph.mjs
  verifier.mjs
  skills.mjs
  specialists.mjs
  usage-tracker.mjs
```

旧 runtime、store、service 和 registry 保留兼容适配器，逐个迁移，不做一次性重写。

### 7.3 API 最小合同

| API | 用途 | 必须保证 |
|---|---|---|
| `POST /api/copilot/conversations` | 创建会话 | 返回绑定的 job/mode/snapshot |
| `GET /api/copilot/conversations?cursor=` | 会话列表 | cursor、搜索、归档、未读 |
| `PATCH /api/copilot/conversations/:id` | 重命名/置顶/归档 | 审计并幂等 |
| `DELETE /api/copilot/conversations/:id` | 删除 | 明确软删/硬删语义 |
| `GET /api/copilot/conversations/:id/messages?cursor=` | 消息分页 | 不一次加载全历史 |
| `POST /api/copilot/conversations/:id/runs` | 启动 run | 固定 model/mode/snapshot，返回 runId |
| `GET /api/copilot/runs/:id/events?afterSeq=` | 事件重放 | gap/reset 语义 |
| `GET /api/copilot/runs/:id/events/stream` | SSE | Last-Event-ID、心跳、结束事件 |
| `POST /api/copilot/runs/:id/cancel` | 取消 | 可重复调用 |
| `POST /api/copilot/approvals/:id/resolve` | 审批/恢复 | 同一 run 状态恢复，不新建隐藏 run |
| `GET /api/copilot/artifacts/:id` | 预览/下载 | manifest、来源和版本 |

所有 run 请求带 `clientRequestId`；响应包含 `runId`、`snapshotId`、`model`、`allowedTools` 和 `eventCursor`，避免模型切换后重试到旧 transport 配置。

## 8. 分阶段实施路线

按 2 名前端/后端兼任工程师估算 8-10 周；单个高级工程师约 10-12 周。每期都必须有可运行增量，不能等到最后才验证“智能”。

### P0：基线、协议和稳定性（3-5 个工作日）

- 修复整组运行超时的 Data Copilot 测试，建立 deterministic fixture。
- 建立 30 条 Golden Task 初版：查数、比较、聚合、join、附件、图表、报告、追问、切换上下文、恢复、失败修复、审批幂等。
- 定义 Answer AST、typed event、snapshot manifest、claim/evidence schema。
- 补 desktop/mobile/a11y/性能基线截图和指标。
- 先修行为正确性：折叠与关闭拆成两个状态；Escape 按 modal stack 关闭；恢复焦点；resize 支持键盘；会话行不再嵌套交互控件。
- 引入 near-bottom 检测和“跳到最新”，避免读历史时被新消息强制滚底；空结果范围显示为 `0 条` 而不是 `1-0`。
- 上下文选择改为“选择 -> 预览摘要 -> Apply”，提供 selected-only、clear-all、记录数、快照 freshness 和整类读取的明确确认。
- 发送按钮显示缺少 model/task/context 或正在运行的具体原因；附件显示类型、进度、失败重试和可访问名称。

**出口**：协议 schema 有 contract tests；定向套件稳定通过；每个 Golden Task 有输入、预期证据和评分器。

### P1：输出和工作区（1-2 周）

- 引入 GFM/代码高亮/表格/引用/图表/产物 block renderer。
- 把 plan/tool 活动移到 Inspector，统一状态文案和卡片样式。
- 拆 `ChatWorkspace` 三栏布局，支持移动端 sheet、键盘、焦点和 aria。
- 实现会话搜索、分页、重命名、归档、删除、未读、last-read 和停止自动滚底。
- 补完整 PATCH/DELETE API，并修复 retry 的 model 绑定。

**出口**：答案不再显示裸代码围栏或内部状态码；1440/1024/390 宽度无重叠；视觉快照和 a11y 核心路径通过。

### P2：流式 Agent 内核（2 周）

- 接入 Responses-native model gateway 和 structured output；保留 Chat Completions fallback。
- 事件日志、SSE cursor、gap/reset、幂等、cancel、approval/resume、usage 和 background run。
- Context Manager：token 预检、相关性 working set、摘要/compaction、来源版本。
- 把固定 planner 改为任务合同 + 确定性调度器；增加可见的 plan/activity。

**出口**：TTFT、重连、取消、审批恢复和 provider fallback 有集成测试；断线重连不重复工具副作用。

### P3：数据智能和可验证产物（2-3 周）

- DuckDB/Python 隔离沙箱、profiling、SQL、统计、join、图表和 Markdown/XLSX/PDF 导出。
- Evidence Graph + Verifier：数字、公式、完整性、矛盾、引用蕴含、产物 manifest。
- snapshot manifest/diff/升级流程：旧会话固定旧版本，用户确认后才换新版本。
- 首批技能包：`audience-analysis`、`job-comparison`、`content-quality`、`artifact-reporting`。

**出口**：Golden Task 的数字正确率、引用覆盖率和产物有效率达到验收线；任何无证据数字都被标注。

### P4：生产化和可扩展性（1-2 周）

- SQLite WAL + outbox + worker lease；必要时迁移 Postgres。
- manager + 2-3 个 specialist、Tracing、成本预算和 trace-based eval。
- MCP/connector allowlist、出站数据预览、工具级权限；仅在 SSE 指标不足时加入 WebSocket。
- 长历史虚拟化、附件分片、缓存、归档和保留策略。

**出口**：多实例/重启/旧游标/大附件/高并发场景有演练记录；安全、成本和隐私审计通过。

## 9. 验收指标和测试矩阵

### 9.1 产品指标

| 指标 | 首版目标 |
|---|---:|
| 固定数据集数字/公式正确率 | >= 99% |
| 有证据结论的引用覆盖率 | >= 95% |
| Golden Task 完成率 | >= 85% |
| 产物 schema/可打开率 | >= 99% |
| 本地 provider 首 token p95 | < 2 秒 |
| 远端 provider 首 token p95 | < 2.5 秒 |
| 断线重连重复副作用 | 0 |
| 活跃会话恢复成功率 | >= 99% |
| 1440/1024/390 布局溢出 | 0 个阻断问题 |
| 核心流程键盘/a11y | 100% 可操作、无严重 axe 问题 |

### 9.2 测试层

- **Unit**：AST 合并、Markdown 不变性、计划 schema、token budget、evidence/verifier、权限和幂等。
- **Contract**：HTTP、SSE、cursor/gap/reset、provider fallback、artifact manifest。
- **Integration**：真实或录制 provider 的 delta -> tool -> approval -> resume -> answer 链路。
- **E2E**：会话 CRUD、切 job/snapshot、上翻历史、上传附件、重连、取消、审批和下载。
- **Visual/a11y**：桌面、窄桌面、移动端；键盘、焦点、读屏、深色/高对比主题（若支持）。
- **Quality eval**：Golden Task + trace grader，分别记录工具选择、证据、数值、引用、修复次数、成本和延迟。
- **Adversarial**：过期快照、矛盾来源、空数据、超大附件、工具超时、provider 断连、重复审批、恶意 MCP 出站请求。

## 10. 权限、隐私和可靠性护栏

1. 默认 `Read-only analysis`，禁止前端发送 wildcard scope；服务端再次按用户、job、snapshot、tool 校验。
2. Workspace build 只能写入受控 artifact workspace；External action（邮件、connector、导出、分享）必须展示目标、数据范围、影响和过期时间后审批。
3. MCP/connector 逐工具 allowlist，显示出站字段预览和数据分类；不把完整上下文默认发送给远端服务器。
4. 沙箱禁止宿主机任意 shell、任意 HTTP、任意文件路径；设置 CPU、内存、磁盘、网络和 TTL 上限。
5. 日志只保留必要输入摘要、来源、结果 hash、trace id 和审计事件；密钥、token、原始敏感内容不得进入日志。
6. snapshot manifest 固定数据版本；数据更新显示 diff 和 stale 原因，不能静默混用新旧来源。
7. 原始隐藏推理不进入 UI、日志或导出；只保留计划、工具摘要、计算、来源和短 reasoning summary。

## 11. 关键风险和决策

| 风险/争议 | 决策 |
|---|---|
| 直接嵌入 Codex CLI 是否最快 | 否。权限和文件模型过宽；采用 Responses/Agents + 受控数据沙箱 |
| 是否一开始就上多智能体 | 否。先把单 manager 的计划、工具和验证做对；specialist 只服务独立分支 |
| 是否先做 Python 还是 UI | P1 先解决输出/工作区，否则结果无法检查；P3 再上沙箱和图表 |
| SQLite 是否够用 | 单实例先 SQLite WAL + outbox；达到多实例/写入指标再迁移 Postgres |
| Responses 状态还是本地状态 | 两者分工：本地事件日志是产品事实源，`responseId/previousResponseId` 是 provider 恢复指针 |
| 如何控制模型漂移 | 固定 Golden Task、trace、版本化 prompt/skill、能力矩阵和上线前回归 |
| 如何控制成本 | token budget、工具延迟预算、并行上限、specialist 上限、长任务 background 和按 run 成本可见 |

## 12. Definition of Done

- [ ] 用户可在一个持久会话中连续追问，切换 job/snapshot 后上下文边界清楚。
- [ ] 答案由结构化 block 渲染，代码、表格、图表、引用、产物均可检查和复制。
- [ ] 运行过程显示计划、工具进度、来源、验证、审批和可恢复状态，断线不丢事件。
- [ ] 复杂分析能使用隔离 SQL/Python，结果带计算血缘和可重算入口。
- [ ] 最终数字、引用、产物和权限都通过 verifier/政策检查；未验证项显式标注。
- [ ] 会话 CRUD、分页、未读、归档、删除、重命名和 retry 行为完整。
- [ ] Golden Task、契约、E2E、视觉、a11y、性能和对抗测试都有可追踪结果。
- [ ] 无 wildcard 权限、无宿主机任意 shell、无原始隐藏推理泄露，外部动作均可审计。

## 13. 资料链接

### OpenAI / Codex 官方资料

- [Responses API migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Background mode](https://developers.openai.com/api/docs/guides/background)
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Token counting](https://developers.openai.com/api/docs/guides/token-counting)
- [Code Interpreter
- ](https://developers.openai.com/api/docs/guides/tools-code-interpreter)
- [Programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [MCP and connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Agent orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Agent evals](https://developers.openai.com/api/docs/guides/agent-evals)
- [Codex AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)
- [Codex subagents](https://developers.openai.com/codex/agent-configuration/subagents)
- [Codex skills](https://developers.openai.com/codex/build-skills)
- [Codex sandboxing](https://developers.openai.com/codex/sandboxing)
- [Codex approvals and security](https://developers.openai.com/codex/agent-approvals-security)
- [Codex App Server](https://developers.openai.com/codex/app-server)

### 对标产品资料

- [Claude Code getting started](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Claude Code security](https://docs.anthropic.com/fr/docs/claude-code/security)
- [Claude Code memory](https://docs.anthropic.com/zh-CN/docs/claude-code/memory)
- [Hex documentation](https://learn.hex.tech/docs)
- [Observable](https://observablehq.com/)

---

**使用方式**：先按 P0/P1 建立可见质量基线，再按 P2/P3 提升 Agent 智能和数据执行能力，最后用 P4 的 trace/eval、可靠性和权限演练决定是否扩大能力范围。每个阶段都以可复核指标和 artifact 为出口，不以“模型回答更长”作为升级完成标准。
