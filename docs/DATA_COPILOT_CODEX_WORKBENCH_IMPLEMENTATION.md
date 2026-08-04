# Data Copilot Codex 级工作台落地说明

**版本**：v2.0
**日期**：2026-08-03
**状态**：已接入主应用，等待发布环境配置模型凭据

## 1. 已落地能力

| 方案域 | 实现 | 主要位置 |
| --- | --- | --- |
| Codex 式工作区 | 会话栏、对话主区、上下文检查器；Ask / Analyze / Build 模式；仅在接近底部时自动滚动；Esc 分层退出 | `src/DataCopilotPanel.tsx` |
| Answer AST | 结构化 heading、paragraph、list、table、code、quote、callout、chart、citation、artifact、checklist、diff、tool summary、error | `server/copilot/answer-ast.mjs`, `src/copilot/answer-ast.ts`, `src/DataCopilotMessage.tsx` |
| Model Gateway | Responses API 与 Chat Completions 双协议；同步与流式输出；超时和上游错误归一化 | `server/copilot/model-gateway.mjs` |
| 任务编排 | 有向无环 TaskGraph、依赖校验、并发只读任务、状态事件、失败短路 | `server/copilot/orchestrator.mjs` |
| Context Manager | 消息和任务数据统一排序、预算裁剪、来源标识、token 估算 | `server/copilot/context-manager.mjs` |
| 数据沙箱 | 数据画像、只读 SQL、受限分析、图表规范、报告组装、语义检索 | `server/copilot/sandbox.mjs` |
| 证据校验 | Evidence Graph、claim/source 关联、无证据与冲突检查 | `server/copilot/evidence-graph.mjs`, `server/copilot/verifier.mjs` |
| Skills / Specialists | 技能注册与模式路由；researcher、analyst、builder、reviewer 专家配置 | `server/copilot/skills.mjs`, `server/copilot/specialists.mjs` |
| 可靠事件 | typed events、单调 seq、完整 JSONL 事件日志、游标重放、gap 检测、SSE 断线续传 | `server/copilot/event-log.mjs`, `server/data-copilot-service.mjs` |
| 运行合同 | conversation PATCH/DELETE、run/event/context/verify、工作台工具与 DAG、usage | `server/data-copilot-http.mjs` |
| 安全边界 | 工作台工具只读；SQL 拒绝写操作；既有 MCP scope、snapshot、approval 与幂等策略继续生效 | `server/copilot/sandbox.mjs`, `server/data-copilot-runtime.mjs` |

## 2. 运行协议

### 2.1 工作模式

- `ask`：直接问答，优先简洁回答和引用。
- `analyze`：要求分步分析、工具调用、证据和限制说明。
- `build`：要求生成可下载产物、校验结果和文件清单。

`workspaceMode` 从前端消息请求进入 runtime，并持久化到消息、run、execution 和 checkpoint；retry 与 approval resume 会恢复同一模式。

### 2.2 Answer AST

服务端输出协议使用 `schemaVersion: 1`。前端兼容结构化 JSON 和历史文本消息；代码块提供复制操作，表格、引用、产物、错误和工具结果使用独立语义组件渲染。

### 2.3 Typed events

每个事件包含 `seq`、`type`、`occurredAt`、`payload` 和可选 `idempotencyKey`。事件先写入完整 JSONL 日志，再进入 250 条内存热缓冲区。客户端使用 `Last-Event-ID` 或 `afterSeq` 恢复；游标早于可用范围时收到 `stream.gap`。

## 3. 新增 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/copilot/capabilities` | 协议、模型、编排、工具和模式能力 |
| `GET` | `/api/copilot/usage` | token、工具调用和延迟汇总 |
| `POST` | `/api/copilot/workbench/tools/:toolName` | 执行一个受限只读工具 |
| `POST` | `/api/copilot/workbench/runs` | 执行带依赖关系的工具 DAG |
| `GET` | `/api/copilot/runs/:runId/events` | 按运行过滤并分页重放事件 |
| `PATCH` | `/api/copilot/conversations/:id` | 更新会话标题 |
| `DELETE` | `/api/copilot/conversations/:id` | 删除会话和内存索引 |
| `GET` | `/api/copilot/conversations/:id/runs` | 列出运行 |
| `GET` | `/api/copilot/conversations/:id/events?format=json` | JSON 事件重放 |
| `GET` | `/api/copilot/conversations/:id/context` | 构建预算内 working set |
| `POST` | `/api/copilot/conversations/:id/verify` | 校验回答证据 |

## 4. 兼容与迁移

- 保留现有 `DataCopilotStore`、MCP、approval、attachment、artifact 和历史会话格式，不迁移或破坏用户数据。
- 持久层使用现有 JSON/JSONL 兼容仓库；本次修复了事件日志曾被 250 条内存窗口截断的问题。
- 未配置远端模型时，既有可预测 runtime 仍可工作；配置模型后由 Model Gateway 接管 Responses 或 Chat Completions 协议。

## 5. 验证命令

```powershell
npm run typecheck
npm run lint
npm run build
npm test
node --test server/copilot-protocol.test.mjs server/data-copilot-http.test.mjs server/data-copilot-service.test.mjs
```

协议测试覆盖 Answer AST、上下文预算、证据校验、任务图、只读数据工具、模型网关、事件游标和 gap；HTTP 测试覆盖工具执行、依赖 DAG、只读 SQL 拒绝和 usage 统计。
