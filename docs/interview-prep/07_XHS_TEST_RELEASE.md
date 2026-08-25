# 测试、CI 与发布面试卡

## 测试分层

### Node 单元与契约

使用 Node 内置 test runner，覆盖 app、JobManager、Copilot protocol/runtime、MCP access、SMTP、凭据扫描、产物和恢复。

### Python

使用 pytest，覆盖 workflow state、ledger、采集 fixture、AI provider、证据校验、报告和路径处理。

### API/集成

使用本地 fake runner、Mailpit、临时目录和 loopback HTTP，验证任务生命周期、邮件发送、artifact manifest、健康检查和凭据边界。

### 浏览器 E2E

使用 Playwright，覆盖配置、任务旅程、草稿导航保护、Data Copilot、部分工作区和发布后的健康检查。

### 发布包

package-github-release.ps1 从 Git 提交生成包；verify-github-release.ps1 在临时目录中解压、安装、构建、启动、健康检查和清理。

## CI 事实

.github/workflows/ci.yml 提供 Ubuntu/Windows 矩阵，使用 Node 22、Python 3.13，执行依赖安装、类型检查、构建、Node/Python/API 检查、Playwright、Mailpit 和 npm audit。失败时上传测试/浏览器产物。

.github/workflows/release.yml 负责 Windows package、净化归档、干净目录验证和 release artifact。

## 常用命令

| 目标     | 命令                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 开发     | npm run dev                                                                                                                        |
| 构建     | npm run build                                                                                                                      |
| 生产启动 | npm start                                                                                                                          |
| 全量检查 | npm run check                                                                                                                      |
| API/单元 | npm run test 或 npm run test:api                                                                                                   |
| Python   | npm run test:python                                                                                                                |
| E2E      | npm run test:e2e                                                                                                                   |
| 发布包   | npm run package:github-release                                                                                                     |
| 一键预检 | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/one-click.ps1 -CheckOnly -NoBrowser -SkipBrowserRelayCheck |

## 历史报告数字

以下数字只作为仓库 dated report 的历史记录，当前回合没有重新执行：

- PHASE10_FINAL_ACCEPTANCE.md 曾记录 221 Node、207 Python、48 API subset、11 Playwright、1 Mailpit。
- 同一报告曾记录 npm audit 150 packages 0 vulnerabilities。
- PUBLIC_RELEASE_VERIFICATION.md 曾记录 MCP 7/7、one-click 5/5 和 Vite 1,604 modules。

面试口述建议：“在 2026-08-01 的验收报告中曾记录……；本轮静态盘点没有重新运行全量矩阵。”

## 测试策略追问

### 如何测试恢复？

用 deterministic mock runner 注入成功、失败、长时间运行和取消场景；检查 state、checkpoint、event sequence、artifact manifest、SHA-256 和 resume 后的重复量。

### 如何测试 AI？

固定输入和 provider fixture，分别测试 schema 合法、缺证据、数字漂移、低分重写、超出重试上限和人工接管。

### 如何测试外部发送？

使用 Mailpit，不连接真实 SMTP；验证 dry-run、freeze、approve、send、receipt、重复请求和未知副作用分支。

### 如何测试 MCP？

验证 grant scope、TTL、owner/snapshot/manifest 绑定、Origin、速率、并发、输出限制、审批和 receipt。

## 当前测试风险

- 外部 Relay、真实模型和 SMTP 难以完全稳定复现。
- 当前工作树有大量未提交文件，本轮没有跑 npm run check。
- 历史验收数字与当前工作区变更不自动等价。
- 大文件和跨语言协议需要更多 contract test 和故障注入。
