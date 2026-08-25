# AI、Data Copilot 与 MCP

## AI 生成链路

1. 从岗位、帖子、评论、用户和历史产物提取结构化来源。
2. 建立 evidence id、source span、来源链接和时间。
3. ApplicationInfoAgent 生成岗位理解和约束。
4. FitEvidenceAgent 生成候选人匹配证据。
5. Writer 以 JSON schema 输出应用文或 outreach 草稿。
6. Employer Review Agent 独立检查事实、匹配和可执行性。
7. 确定性 validator 检查来源 id、数字、工具、行动描述和最小覆盖。
8. 低于门槛时带反馈重写，限制最大轮数。
9. 达标结果仍然进入人工编辑和确认，不直接触发外部动作。

## 为什么模型评分不是唯一门禁

模型可以给出看似合理的自评分，但它替代不了来源存在性、数字一致性、schema 合法性和动作授权。系统把“模型判断”和“确定性检查”分离，错误时保留反馈和证据，便于复盘。

## 质量规则

- 输出只能引用允许的 evidence id。
- 声明中的数字、工具名、项目名需在来源 span 中找到。
- 缺证据时生成待核实项，而不是补写细节。
- 确定性违规会压低分数并阻止自动推进。
- 重写最多约 4 轮，超过后转为人工处理。
- 默认质量门约 90；这个数来自设计/代码参数，面试时不要说成业务准确率。

## Data Copilot

### 三类执行

- ask：回答问题、解释数据和来源。
- analyze：运行分析、聚合、比较和证据校验。
- build：生成报告、草稿、计划或其他产物。

### 运行循环

1. 选择 job/post/comment/user/artifact 快照。
2. Context Manager 根据目标、约束、来源、工具和记忆分配 token budget。
3. Runtime 调用模型和工具，保存 checkpoint。
4. 每个工具调用写 event、receipt、引用和状态。
5. 产物通过 manifest 绑定输入快照和上下文摘要。

## Context Manager

上下文不是把全部历史塞给模型，而是按相关性和优先级裁剪：

- 约束和任务目标优先。
- 当前来源和用户指定资料优先。
- 最近对话保留一部分。
- 工具 schema 和必要记忆进入剩余预算。
- 超限时压缩并记录缺失上下文。

默认预算约 24,000 tokens，保留约 2,048 tokens 的安全余量。它是运行参数，不代表每个模型的实际上下文上限。

## MCP 授权模型

grant 绑定：

- owner
- conversation/job
- snapshot
- context manifest hash
- scope
- tool
- risk level
- issued/expiry

token 只保存 peppered hash，调用前验证来源、Origin、权限、TTL、并发、速率和输出大小。高风险工具需要显式 approval，成功后产生 action hash 和 receipt。

## 为什么 MCP 不直接复用普通 API

普通 API 主要服务本地 UI，会话和 CSRF 语义更自然；MCP 面向外部客户端，需要独立的 Bearer grant、session、Origin/DNS rebinding 防护和 scope。分开 listener 可以缩小误授权面，也方便审计。

## 可讲的故障

### SSE 断线

事件已经写入 durable journal，客户端带 Last-Event-ID 重连，服务端回放缺口并提供 snapshot 对齐。

### 工具执行后进程崩溃

如果是纯幂等工具，可根据 execution key 恢复；如果外部副作用状态未知，标记 reconcile_required，要求核对后再继续。

### 上下文过长

Context Manager 降级裁剪，写入缺失上下文事件，并把关键来源放入固定区，避免模型在无提示下自行补齐。
