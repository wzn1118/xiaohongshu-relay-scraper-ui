# 小红书 Relay 数据工作台：项目卡

## 项目定位

这是一个本地优先的内容与岗位数据工作台，目标是把“浏览器中发现信息”推进到“结构化证据、AI 辅助判断、人工确认和可审计交付”。它不是单次爬虫脚本，而是带任务生命周期、断点恢复、结果编辑、报告和 Data Copilot 的工作流产品。

## 30 秒回答

我负责/参与的是一个 React + Node + Python 的本地工作台。React 提供配置、任务旅程、结果编辑和 Copilot；Node 维护 API、任务、SSE、权限和外部动作闸门；Python 执行浏览器采集、正文补全、OCR 和分析。核心设计是将采集拆成可恢复的 job/attempt/checkpoint/ledger，遇到进程重启或安全验证时保留状态并继续。AI 输出必须绑定 evidence，经过 schema、确定性 validator 和独立审阅器，达标后才进入草稿或投递链路。

## 基本事实

| 项目              | 当前证据                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| Git HEAD          | 1fa74a0，提交信息为 make job recovery visible and repair quality gates |
| 发布标签          | v3.0.0 指向 c56bec7                                                    |
| 分支              | main，origin 指向公开仓库                                              |
| package version   | 3.0.0                                                                  |
| 默认开发地址      | 127.0.0.1:4317                                                         |
| 生产/API 相关端口 | 4327；MCP 4328；Relay/CDP 常见端口 18800                               |
| 主要入口          | src/main.tsx、src/App.tsx、server/index.mjs、server/app.mjs            |
| 当前状态          | 约 81 条工作树状态项；包含未提交 Codex runtime/relay 实验              |

## 用户流程

1. 配置浏览器 Profile、Relay、模型提供方和可选 SMTP。
2. 运行 preflight，提前检查环境、登录态、模型和输出目录。
3. 创建任务和 attempt，建立状态、事件日志、checkpoint 和产物目录。
4. 通过 Relay/CDP 复用浏览器，完成搜索卡片、正文、评论和用户采集。
5. 写入结构化记录、正文账本、关系扩展和质量事件。
6. 用 AI 生成岗位理解、匹配证据、应用文、雇主视角审阅和报告。
7. 将低质量结果留在可编辑草稿；达到门槛后进入人工确认。
8. 批量申请采用 dry-run、freeze、approve、send、receipt 和 audit。
9. Data Copilot 从快照和 manifest 出发，进行 ask/analyze/build。

## 个人贡献说法模板

以下句式必须根据真实经历选择：

- 如果主导设计：我主导了任务恢复和证据质量门的设计，并在 Node/Python 边界上定义了 checkpoint、ledger 和事件协议。
- 如果主要负责实现：我负责 JobManager、Python 状态持久化、SSE 回放和 AI validator 的实现与测试。
- 如果是协作完成：我参与了采集、Copilot 和发布链路，重点负责可恢复性、审计和质量门部分。
- 如果只能证明本地原型：我在本地实现了 Codex browser/device relay 扩展，当前仍属于工作区实验，尚未归入 v3.0 发布承诺。

## 最值得讲的结果

### 工程结果

- 任务从一次性脚本变为可恢复工作流。
- 外部 Relay、模型、SMTP 都被包装成可探测、可暂停、可审计边界。
- AI 结果从自由文本变成 evidence-aware 的结构化产物。
- MCP 工具执行有 grant、scope、审批、幂等 receipt 和历史记录。
- 发布包从 Git 提交构建并在净化环境中重新安装和健康检查。

### 产品结果

- 用户可看到任务处于 queued、running、interrupted、resumable、completed 等状态。
- 用户在安全验证或人工审批点接管后，可以继续原任务。
- 用户可在发送前预览收件人、附件、证据和动作摘要。
- 用户可以把采集结果、分析结论和生成文案放在同一工作区内复核。

## 面试雷区

- “完成了多少岗位/用户/评论”必须给日期和日志来源；README 样例数据不当作个人绩效。
- “支持 MCP”要能解释 grant、snapshot、manifest hash、risk 和 approval，而不是只说接了 SDK。
- “AI 很准”要改成 schema、evidence、validator、独立 review 和人工门禁。
- “用了浏览器自动化”要说明复用登录态、隔离 profile、CDP/Relay、暂停 gate 和恢复。
- 不把未提交 Codex 文件、外部仓库或历史 clone 混入 v3.0 主线。

## 相关证据

- README.md
- package.json
- docs/ARCHITECTURE.md
- docs/AI_PRODUCT_MANAGER_EXPERIENCE.md
- docs/PUBLIC_RELEASE_TECHNICAL_GUIDE.md
- server/index.mjs
- server/job-manager.mjs
- scripts/workflow_state.py
- scripts/body_completion_ledger.py
