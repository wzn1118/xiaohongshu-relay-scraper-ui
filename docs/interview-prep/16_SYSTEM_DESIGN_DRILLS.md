# 系统设计训练题

每题都要求候选人先画边界，再讲数据模型、失败、观测和安全。不要一上来列技术名词。

## 题 1：设计一个可恢复的浏览器采集服务

### 需求

用户输入搜索条件，复用已登录浏览器，采集卡片、正文、评论和用户，支持暂停、取消、重启后恢复。

### 期望回答骨架

1. API 接收 config，先 preflight。
2. Job/attempt/checkpoint/ledger/event/artifact 数据模型。
3. Node 负责生命周期，Python worker 负责阶段。
4. Relay/CDP 是外部边界，安全验证触发 gate。
5. SSE journal + Last-Event-ID。
6. idempotency、lease、revision CAS。
7. 指标：恢复成功率、重复请求、阶段耗时、挑战次数。
8. 隐私：profile、Cookie、token 不入日志和发布包。

## 题 2：设计证据驱动的 AI 应用文服务

### 需求

从岗位和候选人资料生成应用文，要求每个事实可回溯，低质量结果可修改。

### 期望回答骨架

- 来源标准化为 evidence id/span。
- JSON schema 定义输出。
- writer 与 reviewer 分离。
- deterministic validator 检查数字、来源和字段。
- 重写上限与人工草稿状态。
- 证据版本和用户编辑审计。
- 模型 provider 可替换。

## 题 3：设计 Data Copilot 长任务运行时

### 需求

支持 ask/analyze/build、工具调用、SSE 实时进度、取消、重启恢复和报告产物。

### 期望回答骨架

- context manifest 与 token budget。
- durable event log、execution、lease、receipt。
- SQLite WAL 事务和唯一键。
- 幂等工具与未知副作用分支。
- snapshot/manifest hash。
- 工具风险分级和 approval。
- SSE 回放、gap 检测、慢客户端策略。

## 题 4：设计安全的 MCP loopback 服务

### 需求

让外部 agent 查询本地任务并调用受控工具。

### 期望回答骨架

- 独立 listener 和 session。
- 一次性/短期 Bearer grant，服务端存 hash。
- owner/job/snapshot/manifest/scope/tool/risk 绑定。
- Origin/DNS rebinding/HTTPS/loopback 校验。
- 并发、速率、超时、输出限制。
- 高风险 approval、action hash、receipt。
- revoke、TTL 和审计。

## 题 5：设计批量邮件发送系统

### 需求

用户选择多个岗位草稿，预览后发送，要求防重复、防误发，支持超时恢复。

### 期望回答骨架

- recipient/attachment/evidence preflight。
- frozen payload 和 payload hash。
- dry-run 与 approval。
- idempotency key、outbox/receipt。
- SMTP 状态分类：已确认、失败、未知。
- unknown 进入 reconcile。
- Mailpit contract test 和真实发送小流量 smoke。

## 题 6：设计跨平台 KOL 发现系统

### 需求

连接三个平台，按多条 query route 找 creator，去重并分析内容。

### 期望回答骨架

- connector interface：search/profile/content/health。
- canonical identity 和 content identity。
- route/cursor/checkpoint。
- 受限并发、退避、平台级 gate。
- ASR/OCR/字幕/评论证据 schema。
- 七代理报告和 reviewer。
- 数据来源、freshness 和合规。

## 题 7：设计企业数据分析报告发行门

### 需求

用户上传 Excel/CSV，生成统计分析和正式 PDF，要求数字可重算。

### 期望回答骨架

- profile、field mapping、analysis plan。
- AI 只提议语义和计划；确定性 executor 计算。
- evidence validator 绑定数字和图表。
- report binding 与版本。
- PDF release gate。
- 缺失值、异常值、样本量和统计前提。

## 题 8：设计本地一键发布包

### 需求

Windows 用户双击即可启动 Node/Python/浏览器依赖，发布包不得带入私人凭证。

### 期望回答骨架

- runtime manifest 和版本矩阵。
- clean package、排除规则、SHA-256。
- 首次启动 preflight、端口冲突和 health。
- 临时目录安装与 smoke。
- 配置迁移、升级和 rollback。
- 日志脱敏和诊断 bundle。

## 题 9：设计 session forensics 编译器

### 需求

把 JSON/JSONL agent session 变成工具调用图、文件变更、触发逻辑和可复用流程。

### 期望回答骨架

- 输入 schema 版本和容错解析。
- 事件时间线与 parent/child call。
- tool/file/network/approval 分类。
- 敏感字段脱敏。
- 证据引用和 hash。
- 输出 Markdown、JSON 和可复用 prompt。

## 题 10：设计大文件拆分迁移

### 需求

app.mjs 和 App.tsx 已很大，需要拆模块，同时保持已有 API 和 UI 行为。

### 期望回答骨架

- 先画 bounded context 和 dependency graph。
- 选低耦合、高风险模块做 contract test。
- 抽 route/controller，不先改协议。
- 统一错误、日志和权限中间层。
- 小步提交、兼容层和 feature flag。
- 指标：变更影响范围、测试时间、循环依赖、缺陷率。
