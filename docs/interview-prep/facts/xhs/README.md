# 小红书 Relay 数据工作台：穷尽式事实索引

> 审计日期：2026-08-18
> 仓库根目录：`C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui`
> 基线分支：`main`
> 基线提交：`1fa74a0fb8cb19e043cad7c15bfcafc8c261ed2e`
> 版本标签：`v3.0.0` 指向 `c56bec7dc9adc4ee700515685689e630a7a6a49b`

## 使用原则

- **XHS-IDX-001 [HEAD]**：本目录的“已提交事实”均以 `git show HEAD:<path>` 或 `git ls-tree HEAD` 对提交 `1fa74a0` 的读取为准，而不是以当前脏工作区内容替代。
- **XHS-IDX-002 [W]**：`W` 表示文件已被 Git 跟踪、但相对 `HEAD` 存在未提交修改；它只能用于描述当前工作树进展。
- **XHS-IDX-003 [U]**：`U` 表示未跟踪文件；它只能称为实验、原型、设计稿或待提交实现。
- **XHS-IDX-004 [R]**：`R` 表示仓库内历史验收报告记录的结果；数字必须同时保留报告日期、基线和历史限定。
- **XHS-IDX-005 [S]**：`S` 表示 2026-08-18 本轮只读静态盘点结果；例如文件数、测试定义数和字节数，不代表运行性能。
- **XHS-IDX-019 [A]**：`A` 表示本机 `output/` 下已核验、但被 Git ignore 的实验 artifact；需保留 bytes/hash/生成时间，且不把它算入提交或未跟踪文件。
- **XHS-IDX-020 [D]**：`D` 表示设计或分析文档中的陈述；引用时需要明确这是文档结论，或再用源代码/运行 artifact 独立复核。
- **XHS-IDX-006 [HEAD]**：源码路径均相对仓库根目录；面试时可用 `git show 1fa74a0:<path>` 复核提交基线。
- **XHS-IDX-007 [HEAD]**：主仓库产品名来自 `README.md`，为“小红书 Relay 数据工作台”；`package.json` 包名为 `xiaohongshu-relay-scraper-ui`，版本为 `3.0.0`。
- **XHS-IDX-008 [HEAD]**：仓库远端为 `https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git`，`main` 在审计时跟踪 `origin/main`。
- **XHS-IDX-009 [HEAD]**：默认应用地址为 `http://127.0.0.1:4317`；独立 MCP 监听默认为 `127.0.0.1:4328`。
- **XHS-IDX-010 [HEAD]**：应用由 React/Vite 前端、Node.js 本地 API、Python 工作流、浏览器 Relay、AI Provider、SMTP 与本地持久层组成。

## 文档地图

| 文件                                                                   | 内容                                                                         | 主要证据                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| [git-history.md](./git-history.md)                                     | 仓库身份、分支、标签、贡献者、103 条完整提交时间线                           | Git object database                              |
| [architecture-modules.md](./architecture-modules.md)                   | 分层架构、组合根、前后端/Python 模块、默认配置                               | `server/index.mjs`、`docs/ARCHITECTURE.md`       |
| [api-endpoints.md](./api-endpoints.md)                                 | Web API、任务 API、Data Copilot、MCP 管理面和数据面路由                      | `server/app.mjs`、`server/data-copilot-http.mjs` |
| [scripts-commands-dependencies.md](./scripts-commands-dependencies.md) | 42 个已提交 npm 命令、依赖、入口与脚本职责                                   | `package.json`、`requirements.txt`               |
| [data-model-state-artifacts.md](./data-model-state-artifacts.md)       | Job、Attempt、Stage、草稿、批投、Copilot、SQLite、Artifact                   | stores、state、artifact modules                  |
| [ai-providers-quality.md](./ai-providers-quality.md)                   | Provider、协议、模型发现、结构化生成、证据与 90 分门禁                       | AI store、Python runtime、quality modules        |
| [copilot-mcp-runtime.md](./copilot-mcp-runtime.md)                     | Data Copilot runtime、工具目录、MCP Grant、Scope、审批、会话                 | Copilot/MCP modules                              |
| [tests-ci-release.md](./tests-ci-release.md)                           | 静态测试盘点、CI、Playwright、Mailpit、Release、历史验收                     | tests、workflows、reports                        |
| [worktree-experiments.md](./worktree-experiments.md)                   | 22 个 tracked 修改、最新 62 个实验文件；保留 18:41 与 18:49 两个活动开发快照 | `git diff`、未跟踪源码、`output/` hash           |

## 面试表述边界

- **XHS-IDX-011 [HEAD]**：可直接说“v3.0 已提交并有一键发布链路”；不可把 `v3.0.0` 标签后一个修复提交说成标签本身内容。
- **XHS-IDX-012 [HEAD]**：可直接说“主分支含 Data Copilot、MCP、任务恢复、应用文案与批投状态机”；这些模块均存在于 `HEAD`。
- **XHS-IDX-013 [W/U]**：Codex Desktop、浏览器镜像、设备网关、WebRTC/ICE、连接器与 XHS Context 属于当前工作区实验，尚未进入 `HEAD`。
- **XHS-IDX-014 [R]**：历史测试通过数只能说“2026-08-01 验收报告记录为……”，不可说成 2026-08-18 本轮已重跑。
- **XHS-IDX-015 [S]**：静态测试调用点数量大于历史运行用例数，二者口径不同；前者包含参数化/辅助调用的文本计数。
- **XHS-IDX-016 [HEAD]**：`docs/ARCHITECTURE.md` 描述八阶段业务概念，但 `application_intelligence_agents.py` 的运行报告列出六个具名 Agent；面试时应区分“产品阶段模型”和“具体脚本报告中的 Agent 列表”。
- **XHS-IDX-017 [HEAD]**：API Key 在 `AiSessionStore` 的会话对象中使用，并且公共 session 响应不返回 key；配置持久化实现会将 provider 配置写到被 Git 忽略的本地文件，因此更准确的表述是“不会进入 Job/日志/Artifact，存储在本地受限配置与内存会话中”。
- **XHS-IDX-018 [HEAD]**：采集需要用户在受管浏览器完成登录，代码与文档将 Relay、页面登录、AI、SMTP 都视为可断开的外部依赖。

## 快速复核命令

```powershell
git rev-parse HEAD
git status --short
git ls-tree -r --name-only HEAD
git show HEAD:package.json
git show HEAD:server/index.mjs
git show HEAD:server/app.mjs
git show HEAD:server/data-copilot-http.mjs
git show HEAD:.github/workflows/ci.yml
git show HEAD:.github/workflows/release.yml
```
