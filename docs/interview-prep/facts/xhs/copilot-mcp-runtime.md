# Data Copilot、工具运行时与 MCP 事实

> 基线：`HEAD=1fa74a0fb8cb19e043cad7c15bfcafc8c261ed2e`。静态工具计数来自 2026-08-18 对已提交构造器的只读实例化；外接 MCP 工具数是运行时动态值。

## 组合根与运行模型

- **XHS-COP-001 [HEAD]**：`server/index.mjs` 组合 Data Copilot 的 store、policy、artifact service、tool registry、workspace adapter、Git adapter、outbound MCP client manager、unified registry、capability runtime、approval store、model gateway/broker 与 HTTP 层。
- **XHS-COP-002 [HEAD]**：旧 JSON/JSONL conversation store 位于 `server/data-copilot-store.mjs`；生产级 durable 状态另由 `server/copilot/production-store.mjs` 的 SQLite v4 承载，两层职责并存。
- **XHS-COP-003 [HEAD]**：`DataCopilotRuntime` 默认最大 24 step，允许配置到 48；默认最多 2 个 repair round，允许范围 0-5。
- **XHS-COP-004 [HEAD]**：runtime 默认上下文输入预算为 16,000 tokens，默认预留输出为 2,048 tokens；构造器对输入预算夹在 256-200,000。
- **XHS-COP-005 [HEAD]**：Copilot 会话消息为空时返回 `COPILOT_MESSAGE_EMPTY`；暂停、恢复、批准、取消和执行都围绕 durable run/checkpoint，而不是仅靠 HTTP 请求内状态。
- **XHS-COP-006 [HEAD]**：恢复运行会增加 attempt，复用原 conversation，并检查 checkpoint/previousRunId；不存在可恢复 checkpoint 时返回 `COPILOT_RUN_NOT_RESUMABLE`。
- **XHS-COP-007 [HEAD]**：`run-coordinator.mjs` 在进程启动时把中断中的 run/node attempt 标记为 paused，并写入 `process_recovered` checkpoint boundary，保留 resumable 标记。
- **XHS-COP-008 [HEAD]**：`execution-dispatcher.mjs` 默认 lease TTL 为 30,000 ms，默认最大重试 1 次；默认 worker supervisor 扫描上限 100。
- **XHS-COP-009 [HEAD]**：`execution-worker-supervisor.mjs` 默认 poll 250 ms、recovery 15,000 ms、并发 4、scan limit 100。
- **XHS-COP-010 [HEAD]**：Answer AST schema version 为 1，支持 14 种 block：heading、paragraph、list、table、code、quote、callout、chart、citation、artifact、checklist、diff、tool_summary、error。
- **XHS-COP-011 [HEAD]**：Answer AST 的 block ID 默认由 kind/content/index 的 SHA-256 前 16 位构造；sourceRefs 去重并限制 100 条，citations 限 200，artifacts 限 100。
- **XHS-COP-012 [HEAD]**：`answerAstFromText()` 可把 Markdown heading、fence code、quote、table、list/checklist 转为结构块，未知 kind 归一为 paragraph。

## 已提交工具目录：57 个内置定义

- **XHS-COP-013 [S/HEAD]**：只读实例化 `DataToolRegistry` 得到 37 个 data 工具，`WorkspaceToolAdapter` 得到 6 个 workspace 工具，`GitToolAdapter` 得到 10 个 Git 工具；`SubagentRuntime` 静态定义 4 个 agent 工具，合计 57 个内置工具。
- **XHS-COP-014 [HEAD]**：data tool 默认 metadata 为 version `1.0.0`、risk `read`、idempotent true、parallelSafe true；单个定义可覆盖默认值。
- **XHS-COP-015 [HEAD]**：Data query 通用行上限常量 `MAX_TOOL_ROWS=200`；数据集结果会显式返回 truncated/total/source 等元数据。
- **XHS-COP-016 [HEAD]**：`tool.search` 搜完整能力目录并激活相关工具；`tool.describe` 返回精确 schema/scopes/risk/execution properties。
- **XHS-COP-017 [HEAD]**：`task.status` 返回逻辑任务状态、revision、attempt、stage/workflow summary；`task.workflow` 返回 discovery/body completion/analysis/audience/expansion/artifact 状态。
- **XHS-COP-018 [HEAD]**：`dataset.list` 和 `dataset.describe` 列数据集、字段、行数、source 和代表值；application mode 比其他 mode 多 `applications` 数据集。
- **XHS-COP-019 [HEAD]**：8 个 records 工具为 search/query/filter/sort/aggregate/group/join/get，统一执行于 snapshot 绑定的数据集。
- **XHS-COP-020 [HEAD]**：`content.inspect` 返回全文、规范化发布时间、图片元数据与既有 AI 分析；`content.image_understanding` 返回持久化 caption/OCR/vision analysis 与源图片 URL。
- **XHS-COP-021 [HEAD]**：`jobs.extract_links` 提取 canonical URL/ID；`jobs.compare` 按稳定字段比较指定岗位记录。
- **XHS-COP-022 [HEAD]**：`applications.get_delivery` 读 delivery/draft/quality/email 状态；`applications.extract_email_requirements` 分页提取收件人、主题格式和附件命名要求。
- **XHS-COP-023 [HEAD]**：email requirements 工具返回 requested/matched/scanned/returned/withRecipient/withSubjectRule/withAttachmentRule/missing/unmatched/complete/nextOffset 覆盖元数据，避免批量问题只返回首条。
- **XHS-COP-024 [HEAD]**：`applications.compose_email` risk 为 `write`，从单条 application record 构造结构化邮件草稿，并把结果放入 runtime state。
- **XHS-COP-025 [HEAD]**：受众工具包括 segment、coverage、research_brief、users.query、comments.query；research brief 明确区分 comment-record 与 unique-text 分母，并保留地理/Profile 缺失率和可定位证据样本。
- **XHS-COP-026 [HEAD]**：扩展工具为 `expansion.trace` 与 `expansion.summary`，支持 users/posts/comments/relations 四类关系记录。
- **XHS-COP-027 [HEAD]**：Artifact 工具为 create/preview/list；create 支持 CSV、XLSX、JSON、Markdown，risk 为 `write`。
- **XHS-COP-028 [HEAD]**：Attachment 工具为 parse/join_dataset/list；解析和 join 通过 conversation 绑定的 attachment/artifact service 工作。
- **XHS-COP-029 [HEAD]**：email.prepare 与 email.preview 的 risk 为 `write`，email.send 的 risk 为 `approval_required`。

| 目录                      | 数量 | 工具名                                                                               | 证据                            |
| ------------------------- | ---: | ------------------------------------------------------------------------------------ | ------------------------------- |
| Data catalog/discovery    |    2 | `tool.search`, `tool.describe`                                                       | `server/data-tool-registry.mjs` |
| Task/dataset/records      |   12 | `task.status`, `task.workflow`, `dataset.list`, `dataset.describe`, `records.*` 8 项 | 同上                            |
| Content/jobs/applications |    7 | `content.*` 2 项、`jobs.*` 2 项、`applications.*` 3 项                               | 同上                            |
| Audience/expansion        |    7 | audience 3 项、users/comments 2 项、expansion 2 项                                   | 同上                            |
| Artifact/attachment/email |    9 | artifact 3 项、attachment 3 项、email 3 项                                           | 同上                            |

```text
tool.search
tool.describe
task.status
task.workflow
dataset.list
dataset.describe
records.search
records.query
records.filter
records.sort
records.aggregate
records.group
records.join
records.get
content.inspect
content.image_understanding
jobs.extract_links
jobs.compare
applications.get_delivery
applications.extract_email_requirements
applications.compose_email
audience.segment
audience.coverage
audience.research_brief
users.query
comments.query
expansion.trace
expansion.summary
artifact.create
artifact.preview
artifact.list
attachment.parse
attachment.join_dataset
attachment.list
email.prepare
email.preview
email.send
```

## Workspace、Git、Capability Authority

- **XHS-COP-030 [HEAD]**：workspace 只读工具为 `workspace.list`、`workspace.read`；需审批工具为 `workspace.write`、`workspace.patch`、`exec.run`、`http.request`。
- **XHS-COP-031 [HEAD]**：workspace 默认文件读取上限 8 MiB，默认工具输出上限 256 KiB；可配置文件上限最高 64 MiB，输出上限最高 8 MiB。
- **XHS-COP-032 [HEAD]**：workspace exec/http 默认 timeout 30,000 ms，硬上限 5 分钟；exec 单次 schema 允许的 maxOutputBytes 最高 8 MiB。
- **XHS-COP-033 [HEAD]**：`exec.run` 接受 executable 与 literal args，明确以 shell disabled 运行；cwd 必须位于已配置 workspace root。
- **XHS-COP-034 [HEAD]**：`workspace.write` 使用原子替换并支持 expected SHA-256 optimistic concurrency；`workspace.patch` 支持 exact edits 或单文件 unified diff，并标记 idempotent false。
- **XHS-COP-035 [HEAD]**：workspace filesystem containment 使用 resolved/real path 检查，不跟随越界符号链接；`forWorkspace()` 只能接收预先验证过的绝对 root。
- **XHS-COP-036 [HEAD]**：`http.request` 的敏感 headers（Authorization、Cookie、API Key 等）必须引用 server 环境变量，schema 支持 `{env,prefix}`，而不是把凭据直接嵌入模型参数。
- **XHS-COP-037 [HEAD]**：Git 只读工具有 status/diff/log/branch/worktree.status 5 项；需审批工具有 branch.create/branch.switch/stage/commit/restore 5 项。
- **XHS-COP-038 [HEAD]**：Git adapter 没有已提交的 push 工具；其定位是 scoped local repository 操作。
- **XHS-COP-039 [HEAD]**：Git 默认 timeout 30,000 ms、输出 256 KiB；两者最大分别为 5 分钟、8 MiB。
- **XHS-COP-040 [HEAD]**：Capability authority profiles 为 `observe`、`workspace_auto`、`owner_local_full`、`delegated`。
- **XHS-COP-041 [HEAD]**：risk=read 对所有未过期 authority 可执行；observe 对非 read 不授权。
- **XHS-COP-042 [HEAD]**：`workspace_auto` 只在 trustedLocal、agentDepth=0、source=workspace 且工具属于 workspace.write/workspace.patch/exec.run 时自动授权。
- **XHS-COP-043 [HEAD]**：`owner_local_full` 要求 trustedLocal；delegated 只接收 authority.grants 显式列出的工具名。
- **XHS-COP-044 [HEAD]**：Capability receipt schema 为 `capability.receipt.v1`，记录 receipt/run/tool/conversation/project/workspace/worktree、authority、时间、duration、redacted input/result 或 error。
- **XHS-COP-045 [HEAD]**：凭据类 key 由 `/api[-_]?key|authorization|cookie|credential|password|secret|token/i` 识别并替换为 `[redacted]`；字符串和数组也有长度/条数界限。

## Subagent Runtime

- **XHS-COP-046 [HEAD]**：4 个 agent 工具为 `agent.delegate`、`agent.status`、`agent.cancel`、`agent.resume`。
- **XHS-COP-047 [HEAD]**：delegate risk=read，但 idempotent=false、parallelSafe=false；cancel/resume risk=write，resume 也为非幂等。
- **XHS-COP-048 [HEAD]**：subagent role 限定 researcher/analyst/builder/verifier，mode 限定 ask/analyze/build。
- **XHS-COP-049 [HEAD]**：默认硬限额为 depth 1、agents 6、steps 6、tool calls 24、parallel tools 6、timeout 120,000 ms、单输出 20,000 chars、单工具输出 16,000 chars、聚合输出 96,000 chars、可用工具 24。
- **XHS-COP-050 [HEAD]**：delegate schema 可配置 agents 到 12、steps 到 12、tool calls 到 64、timeout 到 300,000 ms、output 到 32,000 chars。
- **XHS-COP-051 [HEAD]**：子任务以依赖 DAG 执行；默认只使用 read-only、idempotent、parallel-safe 工具；Owner unrestricted mode 可用完整非 agent 目录；子代理自身不递归 delegate。
- **XHS-COP-052 [HEAD]**：status 读取 durable plan、node attempts、checkpoints、status、receipt；cancel/resume 操作持久化 run，而不是仅清理内存 Promise。

## Unified Registry 与 Outbound MCP

- **XHS-COP-053 [HEAD]**：Unified registry 合并 data/workspace/git/mcp/agent 五个来源，工具定义增加 `source` 字段。
- **XHS-COP-054 [HEAD]**：任意两个来源注册同名工具会抛 `COPILOT_TOOL_NAME_CONFLICT` 与 HTTP 409，不采用后注册覆盖。
- **XHS-COP-055 [HEAD]**：统一 `tool.search` 与 `tool.describe` 会激活命中的工具名，active tool list 上限 100。
- **XHS-COP-056 [HEAD]**：`describeCapabilities()` 返回总工具数和五来源计数，同时返回 outboundMcp 与 subagents 状态；由于远端服务器可变，总数是动态值。
- **XHS-COP-057 [HEAD]**：Outbound `McpClientManager` 同时支持 stdio 和 Streamable HTTP client transport，配置默认位于 `copilot-mcp-servers.json`。
- **XHS-COP-058 [HEAD]**：outbound 默认工具调用 timeout 120,000 ms，运行时夹在 1,000 ms 到 15 分钟。
- **XHS-COP-059 [HEAD]**：配置最多加载 256 个 MCP server，每个 server 最多索引 512 个工具，diagnostics 最多保留 100 条，stderr drain 最多 64,000 bytes。
- **XHS-COP-060 [HEAD]**：内部工具名最大 54 字符，模型 wire 工具名最大 64 字符；远端结果最多 64 content items、总体 120,000 bytes、单 item 32,000 bytes、结构化字符串 4,000 bytes、归一化节点 512。
- **XHS-COP-061 [HEAD]**：静态 HTTP header 只放行 accept/accept-language/content-type/user-agent/x-client/name/version；凭据通过环境引用配置，且禁用 host/content-length/connection/upgrade 等 hop-by-hop 或边界 header。
- **XHS-COP-062 [HEAD]**：outbound client 生命周期与 inbound Grant server 分离；断线会移除该 server 的工具索引，refresh 可重新连接。

## MCP 数据协议与资源

- **XHS-COP-063 [HEAD]**：轻量 `McpDataAdapter` 声明协议版本 `2024-11-05`，serverInfo 为 `xiaohongshu-data-copilot/1.0.0`。
- **XHS-COP-064 [HEAD]**：支持 JSON-RPC methods：initialize、ping、resources/list、resources/read、tools/list、tools/call、notifications/initialized；无 id notification 不返回响应。
- **XHS-COP-065 [HEAD]**：task resources 为 applications/content/audience/expansion；conversation resources 为 attachments/artifacts。
- **XHS-COP-066 [HEAD]**：application mode 暴露全部 6 个资源；其他 mode 排除 applications，保留 5 个。
- **XHS-COP-067 [HEAD]**：resource URI 由 policy 生成，响应 MIME 为 `application/json`；attachments/artifacts 由 artifact service，其他资源由 snapshot-bound registry 读取。
- **XHS-COP-068 [HEAD]**：applications/content resource 通过 `records.query limit=200`；audience 并行读取 comments/users/audience.posts，各 limit 200；expansion 对四类记录分别 `trace limit=500`。
- **XHS-COP-069 [HEAD]**：tool annotations 由 risk/idempotency 映射 readOnlyHint、destructiveHint、idempotentHint，内部 `_meta` 保留 scopes/risk/version/idempotent/parallelSafe。
- **XHS-COP-070 [HEAD]**：approval_required 工具在普通 MCP data adapter 的 direct call 未携带 approved context 时返回 `COPILOT_APPROVAL_REQUIRED` 409。
- **XHS-COP-071 [HEAD]**：MCP tool call 的默认 idempotency key 基于 conversationId/requestId/name/input 的 SHA-256 前 48 位。

## MCP Grant、鉴权与限额

- **XHS-COP-072 [HEAD]**：MCP Grant 默认 TTL 24 小时，最短 60 秒，最大 30 天；每 owner 最多 20 个 active Grant，创建速率最多每分钟 5 个。
- **XHS-COP-073 [HEAD]**：risk 等级按 read=0、write=1、approval_required=2 排序；Grant 的 maxRisk 过滤工具目录与执行权限。
- **XHS-COP-074 [HEAD]**：resource scope 映射为 applications:read、content:read、audience:read、expansion:read、attachment:read、artifact:read。
- **XHS-COP-075 [HEAD]**：Grant token 格式为 `xhs_mcp_<uuid>.<32 random bytes base64url>`；公开 tokenPrefix 只含 UUID 前 8 位，完整 token 只在创建响应返回一次。
- **XHS-COP-076 [HEAD]**：token 以至少 32-byte pepper 做 HMAC-SHA256 hash；pepper 文件默认 `data/auth/mcp-token-pepper`，首次创建请求 exclusive write 与 mode `0600`。
- **XHS-COP-077 [HEAD]**：Grant 服务只持久化 token hash/prefix；`publicGrant()` 移除 tokenHash 和 owner。
- **XHS-COP-078 [HEAD]**：Grant 固定绑定 owner、conversationId、jobId、snapshotId、manifestHash、mode、scopes、allowedTools、allowedResources、maxRisk；调用时任一 snapshot 边界漂移都会使鉴权失败。
- **XHS-COP-079 [HEAD]**：rotate/rebind 会先创建替代 Grant，再 revoke 旧 Grant，并分别记录 rotatedFrom/reboundFrom metadata 与审计事件。
- **XHS-COP-080 [HEAD]**：创建请求拒绝 owner/jobId/snapshotId/revision/manifestHash/tokenHash/tokenPrefix 等 server-bound 字段由客户端注入。
- **XHS-COP-081 [HEAD]**：每 Grant 默认每分钟 120 次工具调用、并发 4；工具 timeout 默认 120,000 ms；单输出默认 2 MiB。配置范围分别为 1-10,000、1-32、1 秒-15 分钟、1 KiB-16 MiB。
- **XHS-COP-082 [HEAD]**：超大可摘要结果返回 `MCP_OUTPUT_TRUNCATED`、originalBytes、maximumBytes、summary；其他工具超限返回 `MCP_OUTPUT_LIMIT_EXCEEDED` 413。
- **XHS-COP-083 [HEAD]**：重复工具执行由 `(grant_id,idempotency_key)` 与 request/action hash 约束；completed/approval_required 返回原结果，running 返回 `MCP_TOOL_RUN_ACTIVE`。
- **XHS-COP-084 [HEAD]**：approval action digest 包含 grantId、snapshotId、manifestHash、tool name/version/input；消费批准时重新比较 approval binding 与 action hash。
- **XHS-COP-085 [HEAD]**：Grant 审计覆盖创建、撤销、旋转、重绑、session 打开/关闭、tool completed/failed、approval required/consumed/rejected/execution failed。

## Streamable HTTP Gateway

- **XHS-COP-086 [HEAD]**：独立 MCP 服务默认监听 `127.0.0.1:4328`，数据端点 `/mcp`，健康端点 `/health`；`XHS_MCP_ENABLED` 默认 true。
- **XHS-COP-087 [HEAD]**：gateway 使用官方 `@modelcontextprotocol/sdk` 的 `Server` 与 `StreamableHTTPServerTransport`，支持 GET/POST/DELETE。
- **XHS-COP-088 [HEAD]**：建立有状态 session 的首个 POST 必须为 initialize；后续请求必须携带 `Mcp-Session-Id` 且与同一 Grant 绑定。
- **XHS-COP-089 [HEAD]**：默认最多 20 个全局 MCP sessions、每 Grant 4 个、idle 1,800 秒；idle sweep 间隔取 5-60 秒边界内的 idle/2。
- **XHS-COP-090 [HEAD]**：配置有 public origin 时可启用 stateless public showcase；无 Authorization 的 showcase 不创建 session，只接受 POST MCP 请求，GET 返回描述。
- **XHS-COP-091 [HEAD]**：public showcase 默认 body 上限 64 KiB、每分钟 60 次、并发 4；它与 Grant-bound 私有会话是不同执行面。
- **XHS-COP-092 [HEAD]**：transport 开启 DNS rebinding protection，allowedHosts 来自配置，allowedOrigins 为空数组；公网部署还可要求 Cloudflare headers。
- **XHS-COP-093 [HEAD]**：服务进程启动时会关闭数据库中上次进程遗留的 active MCP sessions，以免把断开的 transport 误报为活跃。

## 面试边界

- **XHS-COP-094 [HEAD]**：已提交设计的核心不是“聊天框调用任意函数”，而是 snapshot-bound data policy、统一工具 metadata、run-scoped authority、durable receipt、approval binding 与 idempotency 的组合。
- **XHS-COP-095 [HEAD]**：Data tools 的 write 与 approval_required 是两个风险等级；例如草稿/Artifact 准备是 write，而真实 email.send 是 approval_required。
- **XHS-COP-096 [HEAD]**：本地 Owner 的自动执行依赖 server-derived trustedLocal；client JSON 自报 owner/trustedLocal 不构成授权。证据：`server/copilot/capability-runtime.mjs` 注释与 `authorizationFor()`。
- **XHS-COP-097 [HEAD]**：静态 57 工具是内置下限，不应表述为生产运行时恒定总数；outbound MCP 连接会动态增加工具。
- **XHS-COP-098 [W]**：当前 worktree 的 Codex browser/device relay、XHS Context MCP 和 Codex Product MCP 属于未提交增量，详见 `worktree-experiments.md`；它们不计入以上 `HEAD` 的 57 个内置工具。

## 复核命令

```powershell
git show HEAD:server/data-copilot-runtime.mjs
git show HEAD:server/data-tool-registry.mjs
git show HEAD:server/copilot/unified-tool-registry.mjs
git show HEAD:server/copilot/capability-runtime.mjs
git show HEAD:server/copilot/subagent-runtime.mjs
git show HEAD:server/mcp-data-adapter.mjs
git show HEAD:server/mcp-access-service.mjs
git show HEAD:server/mcp-http-server.mjs
node --input-type=module -e "import {DataToolRegistry} from './server/data-tool-registry.mjs'; console.log(new DataToolRegistry().list().map(x=>x.name))"
```
