# 一页项目卡：XHS Relay Workbench

## 定位

本地优先的浏览器数据采集、证据整理、AI 应用和 Data Copilot 工作台。

## 栈

React 19、TypeScript、Vite 6、Node ESM、Python、Playwright、SSE、SQLite WAL、MCP SDK、SMTP/Mailpit。

## 架构

React UI → Node API/JobManager/SSE → Python workflow → Relay/CDP/AI；JSON/JSONL 保存任务与产物，SQLite 保存 Copilot/MCP runtime。

## 核心对象

job、attempt、revision、checkpoint、ledger、event journal、snapshot、manifest、evidence、grant、approval、receipt。

## 三个亮点

1. 跨 Node/Python 的可恢复任务与幂等去重。
2. evidence + schema + reviewer + deterministic validator 的 AI 质量门。
3. snapshot/manifest/grant/approval/receipt 约束下的 Copilot/MCP。

## 三个风险

1. app.mjs、job-manager.mjs、App.tsx 偏大。
2. JSON + SQLite 双存储一致性。
3. 当前工作树有未提交 Codex runtime/relay 扩展。

## 证据

HEAD 1fa74a0；v3.0.0；README.md；docs/ARCHITECTURE.md；server/index.mjs；server/job-manager.mjs；scripts/workflow_state.py。

## 追问

- 为什么 Node + Python？
- 恢复时怎样避免旧 worker 覆盖？
- SMTP 超时但已发送怎么办？
- MCP grant 泄露的影响范围？
