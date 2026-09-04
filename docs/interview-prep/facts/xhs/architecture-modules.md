# 架构、模块与运行边界事实

## 产品与进程边界

- **XHS-ARC-001 [HEAD]**：`README.md` 将产品定义为小红书 Relay 采集、数据管理、报告生成和 Data Copilot 工作台。
- **XHS-ARC-002 [HEAD]**：`docs/ARCHITECTURE.md` 的主数据流为 React 工作台 → Node API → Python Runner → Browser Relay/AI Provider/Artifact。
- **XHS-ARC-003 [HEAD]**：React 层负责配置、启动前检查、任务控制、结果复核、文案编辑与下载；它通过 API 操作，不直接启动 Python Runner。
- **XHS-ARC-004 [HEAD]**：Node API 是请求校验、Job 生命周期、Runner 进程、SSE、Artifact 访问和外部发送门禁的所有者。
- **XHS-ARC-005 [HEAD]**：Python 脚本负责采集、正文补全、结构化、候选人事实匹配、文案生成、评审与产物写入。
- **XHS-ARC-006 [HEAD]**：Relay/CDP、页面、模型服务、SMTP 被建模为可断开的外部依赖，异常应转换为用户可见状态。
- **XHS-ARC-007 [HEAD]**：默认 HTTP 服务仅监听 `127.0.0.1:4317`；Vite 开发服务器监听端口 `5173`，将 `/api` 代理到本地 API。
- **XHS-ARC-008 [HEAD]**：MCP 数据面使用单独 HTTP server，默认监听 `127.0.0.1:4328/mcp`，与 Cookie 鉴权的 Web 管理面分离。
- **XHS-ARC-009 [HEAD]**：`server/index.mjs` 是应用组合根；它创建 stores、services、Copilot runtime、MCP gateway、Relay supervisor 和两个 HTTP server。
- **XHS-ARC-010 [HEAD]**：组合根注册 `SIGINT` 与 `SIGTERM`，关闭 Web/MCP server、Relay supervisor、MCP clients、audience AI、JobManager、subagents、Copilot worker/broker/dispatcher/store，并刷新 diagnostics。
- **XHS-ARC-011 [HEAD]**：优雅关闭设置 15 秒强制退出计时器；Copilot execution worker 与 tool broker 各获得 8 秒关闭超时。
- **XHS-ARC-012 [HEAD]**：数据保留清理在服务启动后执行一次，此后每 24 小时执行；计时器调用 `unref()`。

## 组合根中的已提交服务

| 领域               | 已提交类型/工厂                              | 证据路径                                       |
| ------------------ | -------------------------------------------- | ---------------------------------------------- |
| HTTP               | `createApp`                                  | `server/app.mjs`                               |
| Job                | `JobManager`                                 | `server/job-manager.mjs`                       |
| AI 会话            | `AiSessionStore`                             | `server/ai-session-store.mjs`                  |
| 候选人资料         | `ProfileStore`                               | `server/profile-store.mjs`                     |
| Relay 配置         | `RelayConfigStore`                           | `server/relay-config-store.mjs`                |
| SMTP 配置          | `SmtpConfigStore`                            | `server/smtp-config-store.mjs`                 |
| 邮件发送           | `createMailSender`                           | `server/mail-sender.mjs`                       |
| 本地模型           | `LocalModelManager`                          | `server/local-model-manager.mjs`               |
| Relay 监控         | `createRelaySupervisor`                      | `server/lib/relay-supervisor.mjs`              |
| 数据生命周期       | `DataLifecycleService`                       | `server/data-lifecycle-service.mjs`            |
| 诊断               | `createDiagnostics`                          | `server/lib/diagnostics.mjs`                   |
| 受众 AI            | `AudienceAiService`                          | `server/audience-ai-service.mjs`               |
| Copilot JSON/JSONL | `DataCopilotStore`                           | `server/data-copilot-store.mjs`                |
| Copilot 审批       | `CopilotApprovalStore`                       | `server/copilot-approval-store.mjs`            |
| Copilot 文件       | `CopilotArtifactService`                     | `server/copilot-artifact-service.mjs`          |
| 数据策略           | `DataPolicyEngine`                           | `server/data-policy-engine.mjs`                |
| 数据工具           | `DataToolRegistry`                           | `server/data-tool-registry.mjs`                |
| MCP 适配           | `McpDataAdapter`                             | `server/mcp-data-adapter.mjs`                  |
| MCP 授权           | `McpAccessService`                           | `server/mcp-access-service.mjs`                |
| MCP HTTP           | `createMcpHttpGateway`                       | `server/mcp-http-server.mjs`                   |
| Copilot 运行时     | `DataCopilotRuntime`                         | `server/data-copilot-runtime.mjs`              |
| Copilot 服务       | `DataCopilotService`                         | `server/data-copilot-service.mjs`              |
| SQLite 生产状态    | `createCopilotProductionStore`               | `server/copilot/production-store.mjs`          |
| Workspace tools    | `WorkspaceToolAdapter`                       | `server/copilot/workspace-tool-adapter.mjs`    |
| Git tools          | `GitToolAdapter`                             | `server/copilot/git-tool-adapter.mjs`          |
| 外部 MCP client    | `createMcpClientManager`                     | `server/copilot/mcp-client-manager.mjs`        |
| 模型调用           | `createModelGateway`、`createModelRunBroker` | `server/copilot/model-*.mjs`                   |
| durable execution  | dispatcher/registry/worker/repository        | `server/copilot/runtime-v3/`                   |
| tool execution     | `createToolExecutionBroker`                  | `server/copilot/tool-execution-broker.mjs`     |
| subagent           | `createSubagentRuntime`                      | `server/copilot/subagent-runtime.mjs`          |
| unified catalog    | `createUnifiedToolRegistry`                  | `server/copilot/unified-tool-registry.mjs`     |
| project workspace  | `createProjectWorkspaceService`              | `server/copilot/project-workspace-service.mjs` |
| Web auth           | `createAuthStore`                            | `server/auth-store.mjs`                        |

- **XHS-ARC-013 [HEAD]**：组合根按 auth、AI/Profile/Relay/SMTP、Job、Audience、Copilot、MCP、DataLifecycle、Relay supervisor 的顺序初始化。
- **XHS-ARC-014 [HEAD]**：外部 MCP client 初始化失败会记录 degraded diagnostics 并继续启动，体现可选外部能力的降级设计。
- **XHS-ARC-015 [HEAD]**：启动时 tool broker 调用 `reconcileQueuedOrphans()`，若发现孤儿队列执行则记录数量。
- **XHS-ARC-016 [HEAD]**：execution worker 配置为 250 ms 轮询、15 秒恢复扫描、最大并发 4、扫描上限 100。
- **XHS-ARC-017 [HEAD]**：开发环境回环监听默认 Copilot approval mode 为 `never`；生产或非回环 host 默认 `required`；显式选项还包括 `workspace_auto`。
- **XHS-ARC-018 [HEAD]**：`workspace_auto` 模式仅将 `workspace.write`、`workspace.patch`、`exec.run` 列为自动执行工具，具体工具仍受 runtime 策略和调用上下文约束。

## 前端模块

- **XHS-ARC-019 [HEAD]**：入口 `src/main.tsx` 使用 React 19 `createRoot` 与 `StrictMode`，挂载 `App` 并加载 `styles.css`。
- **XHS-ARC-020 [HEAD]**：`src/App.tsx` 是主壳层，在 `HEAD` 中约 385 KB；其职责包含主配置、结果区、受众区、邮件预览、媒体预览和任务状态展示。
- **XHS-ARC-021 [HEAD]**：`src/api.ts` 封装 auth、AI、Profile、数据生命周期、Relay、Job、Audience、Expansion、Draft、Attachment、Email、Batch、Artifact 和 SSE 客户端。
- **XHS-ARC-022 [HEAD]**：`DataCopilotPanel.tsx`、`DataCopilotMessage.tsx`、`DataCopilotContext.tsx`、`DataCopilotContextBrowser.tsx` 构成 Copilot 对话、结构化结果与上下文浏览器。
- **XHS-ARC-023 [HEAD]**：`CopilotProjectWorkspacePanel.tsx` 提供项目工作区 UI；`CopilotMcpSettings.tsx` 与 `McpAccessPanel.tsx` 分别管理 outbound MCP 和本地 MCP access。
- **XHS-ARC-024 [HEAD]**：`BatchApplicationPanel.tsx` 对应批量申请流程；`BodyImportPanel.tsx` 对应正文导入；`ExpansionWorkspace.tsx` 对应关系扩展。
- **XHS-ARC-025 [HEAD]**：`JobJourneyPanel.tsx` 消费任务旅程状态；`UnsavedDraftDialog.tsx` 与 `useUnsavedDraftGuard.ts` 保护未保存草稿导航。
- **XHS-ARC-026 [HEAD]**：`src/copilot/` 中已提交 ActivityTimeline、AgentWorkbench、EvidenceInspector、ExecutionTimeline、PlanView、QualityPanel、RunBar、TaskInspector、TaskRunHeader 等工作台组件。
- **XHS-ARC-027 [HEAD]**：前端 Answer AST 在 `src/copilot/answer-ast.ts`，服务端对应实现位于 `server/copilot/answer-ast.mjs`。
- **XHS-ARC-028 [HEAD]**：Vite dev server 监听 `::` 和 5173；默认 API proxy 为 `http://127.0.0.1:4317`，可由 `VITE_API_PROXY` 或 `VITE_API_PORT` 覆盖。

## Node 服务端模块

- **XHS-ARC-029 [S]**：`HEAD` 的 `server/` 共 194 个文件，其中 `server/copilot/` 49 个、`server/lib/` 35 个。
- **XHS-ARC-030 [HEAD]**：`server/app.mjs` 负责路由、SSE、SPA 静态文件、应用邮件 preview/send 和对各 service 的编排。
- **XHS-ARC-031 [HEAD]**：`server/job-manager.mjs` 负责逻辑 Job、attempt、队列、子进程、恢复、事件 journal、workflow state 与 Artifact 发现。
- **XHS-ARC-032 [HEAD]**：应用附件、批次、联系人 OCR/消歧、delivery candidates 拆分为独立 service/manager 文件，并各有测试。
- **XHS-ARC-033 [HEAD]**：Relay 被拆为 `relay-connect`、`relay-recovery`、`relay-setup`、`relay-supervisor`、`relay-targets` 和 native browser 模块。
- **XHS-ARC-034 [HEAD]**：Data Copilot 采用两层持久化：conversation JSON/JSONL 兼容层与 `node:sqlite` 生产状态层。
- **XHS-ARC-035 [HEAD]**：Copilot runtime-v3 暴露 execution context、repository、runtime event 和聚合 index，dispatcher/worker/broker 位于相邻模块。
- **XHS-ARC-036 [HEAD]**：MCP 分成 Web Cookie 管理面 `mcp-management-http.mjs`、独立数据面 `mcp-http-server.mjs`、stdio bridge 与 Data adapter。

## Python 模块与业务阶段

- **XHS-ARC-037 [S]**：`HEAD` 跟踪 68 个 Python 文件；`scripts/` 总计 88 个文件，含采集、分析、迁移、验证和运行入口。
- **XHS-ARC-038 [HEAD]**：主 Runner 入口为 `scripts/run_project_workflow.py`，可由 `XHS_RUNNER_PATH` 覆盖。
- **XHS-ARC-039 [HEAD]**：受众 AI Runner 为 `scripts/run_audience_ai.py`，默认开关 `XHS_AUDIENCE_AI_ENABLED=false`。
- **XHS-ARC-040 [HEAD]**：候选人资料解析入口为 `scripts/profile_memory.py`；联系人 OCR 入口为 `scripts/resolve_application_contacts.py`。
- **XHS-ARC-041 [HEAD]**：`scripts/workflow_state.py` 与 Node `server/lib/workflow-state.mjs` 共享 schema version 2、五个 stage 名称和恢复 scope 语义。
- **XHS-ARC-042 [HEAD]**：`scripts/artifact_io.py` 使用临时文件、flush、`fsync` 和 `os.replace` 写 JSON，Windows 权限占用时做指数退避，保留上一个完整检查点。
- **XHS-ARC-043 [HEAD]**：`application_intelligence_agents.py` 负责时间标准化、岗位信息、候选人证据匹配、outreach 文案和管线结果写出。
- **XHS-ARC-044 [HEAD]**：`ai_application_workflow.py` 叠加 AI 生成、独立评审、证据验证、Cover Letter 重写和质量 gate。
- **XHS-ARC-045 [HEAD]**：`audience_collection.py`、`audience_resume.py`、`audience_ai_pipeline.py` 分别处理受众采集、恢复和受众研究分析。
- **XHS-ARC-046 [HEAD]**：`expansion_collection.py` 与 `run_expansion_workspace.py` 支撑关系扩展的持久化执行。
- **XHS-ARC-047 [HEAD]**：产品架构文档列出八阶段：coverage、time、profile-memory、application-info、capability、ai-writer、employer-review、quality-gate。
- **XHS-ARC-048 [HEAD]**：具体 `application_intelligence_agents.py` 的运行报告列出 coverage、time、application-info、fit-evidence、outreach-writer、quality-gate 六个 agent；AI workflow 再补 writer/reviewer 迭代。

## 默认配置与上限

| 配置                      | `HEAD` 默认值 | 允许范围/说明 | 证据                                       |
| ------------------------- | ------------: | ------------- | ------------------------------------------ |
| `PORT`                    |          4317 | 1-65535       | `server/config.mjs`                        |
| `XHS_MCP_PORT`            |          4328 | 1-65535       | `server/config.mjs`                        |
| MCP body                  |         1 MiB | 1 KiB-8 MiB   | `mcpMaxBodyBytes`                          |
| MCP output                |         2 MiB | 1 KiB-16 MiB  | `mcpMaxOutputBytes`                        |
| MCP tool timeout          |         120 s | 1 s-15 min    | `mcpToolTimeoutMs`                         |
| 并发 tool/grant           |             4 | 1-32          | `mcpMaxConcurrentToolsPerGrant`            |
| MCP calls/min             |           120 | 1-10,000      | `mcpMaxCallsPerMinute`                     |
| session idle              |       1,800 s | 30 s-24 h     | `mcpSessionIdleSeconds`                    |
| 全局 MCP session          |            20 | 1-200         | `mcpMaxSessions`                           |
| session/grant             |             4 | 1-32          | `mcpMaxSessionsPerGrant`                   |
| Audience AI 并发          |             2 | 1-8           | `audienceAiMaxConcurrent`                  |
| OCR timeout               |         180 s | 30-600 s      | `applicationContactOcrTimeoutSeconds`      |
| OCR checkpoint            |             5 | 1-50 条       | `applicationContactOcrCheckpointEvery`     |
| OCR attempts              |             2 | 1-3           | `applicationContactOcrMaxAttempts`         |
| OCR concurrency           |             2 | 1-8           | `applicationContactOcrConcurrency`         |
| OCR prefetch              |            12 | 1-32          | `applicationContactOcrPrefetchConcurrency` |
| OCR image batch           |             4 | 固定最大 4    | `applicationContactOcrImageBatchSize`      |
| Copilot exec/http timeout |       各 30 s | 50 ms-5 min   | config                                     |
| Copilot tool output       |       256 KiB | 1 KiB-8 MiB   | config                                     |
| Web JSON body             |        32 MiB | 1 KiB-64 MiB  | `maxBodyBytes`                             |
| 应用附件文件数            |             5 | 1-20          | config                                     |
| 单应用附件                |        10 MiB | 1 KiB-64 MiB  | config                                     |
| 应用附件合计              |        20 MiB | 1 KiB-128 MiB | config                                     |
| Relay monitor             |          15 s | 2-300 s       | config                                     |
| Relay failure threshold   |             2 | 1-10          | config                                     |
| Relay recovery cooldown   |          60 s | 5-900 s       | config                                     |
| Relay connect timeout     |          25 s | 1-120 s       | config                                     |
| Relay Playwright timeout  |          60 s | 1-180 s       | config                                     |

- **XHS-ARC-049 [HEAD]**：本地模型默认 endpoint 为 `http://127.0.0.1:11434`；非回环 endpoint 需要 HTTPS，URL 中拒绝账号密码。
- **XHS-ARC-050 [HEAD]**：认证在 production 默认开启，开发默认关闭；session TTL 默认 8 小时，允许 5 分钟至 7 天。
- **XHS-ARC-051 [HEAD]**：生产认证 origin 在非回环地址上要求 HTTPS；MCP host 校验只接受 loopback。
- **XHS-ARC-052 [HEAD]**：Profile、Job、浏览器、Relay 配置、AI 配置、SMTP 配置、诊断、删除审计均在本地数据目录体系内，`data/` 被 `.gitignore` 排除。
