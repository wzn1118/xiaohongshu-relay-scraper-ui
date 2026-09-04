# 项目组合总览

## 一句话定位

这是一组围绕“本地优先的数据采集、证据整理、AI 辅助决策和可审计交付”的产品工程项目。主项目是小红书 Relay 数据工作台，其他项目分别展开营销分析、企业统计报告、哲学知识工作台、Windows 便携交付和小型自动化原型。

## 推荐排序

| 优先级 | 项目                       | 证据状态                                | 面试定位                     |
| ------ | -------------------------- | --------------------------------------- | ---------------------------- |
| 1      | 小红书 Relay 数据工作台    | 公开 Git 仓库；当前工作树有 81 条状态项 | 主项目，深挖系统设计和可靠性 |
| 2      | KOLFORGE / MKT大师         | 本地未提交快照                          | 跨平台营销数据和多模态分析   |
| 3      | Asteria Analyst            | 公开 GitHub 仓库，已做浅层源码核验      | 数据分析、统计实验、正式报告 |
| 4      | Hegel Salon                | 公开 GitHub 仓库，已做浅层源码核验      | 知识检索、引文纪律、评测     |
| 5      | today-you-applied-portable | 本地未提交快照，与主项目同源            | Windows 产品化、运行时打包   |
| 6      | Playground 小项目          | 本地无提交                              | 快速交付、跨栈能力           |
| 7      | 外部源码副本               | remote 指向他人仓库                     | 源码阅读和二次实验，谨慎提及 |

## 主项目的业务叙事

用户不是单纯要“抓一页数据”，而是要从发现到行动形成闭环：

1. 复用用户已登录的受管浏览器，发现岗位或内容。
2. 通过卡片、正文、评论、用户和关系扩展补足上下文。
3. 将来源记录标准化，保留 evidence id、span、时间和来源链接。
4. 使用 AI 生成岗位理解、匹配证据、应用文和雇主视角审阅。
5. 以 schema、来源校验、确定性规则和人工确认作为质量门。
6. 通过 dry-run、freeze、approve、send 和 receipt 交付外部动作。
7. 用 Data Copilot/MCP 对任务、产物和分析结果进行可追溯的问答与构建。

## 统一工程主题

### 1. 可恢复性

任务、attempt、revision、checkpoint、JSONL event journal 和 ledger 组合成一个可恢复工作流。进程退出后读取最后一致状态，避免从头重复处理。

### 2. 证据驱动 AI

模型输出是结构化对象，声明必须指向允许的来源记录或 span。独立审阅器和确定性 validator 负责事实与格式门禁。

### 3. 人机协作

遇到安全验证、登录、审批或未知副作用时暂停并保留上下文，由人处理关键边界，再从 checkpoint 继续。

### 4. 本地优先交付

任务和产物使用用户可见文件，运行时执行和 MCP 使用 SQLite WAL；同时提供 Windows 一键包、Linux/macOS 启动脚本和 GitHub release 验证。

### 5. 事实边界

代码体量大并不等于个人独立完成全部模块。面试中应主动说清主线 commit、当前工作区实验、外部依赖和个人贡献。

## 60 秒版本

我做的是一个本地优先的 Relay 数据工作台。前端用 React/Vite，Node 负责 API、任务生命周期、SSE 和权限边界，Python 负责 Playwright、OCR 和数据处理。系统把一次采集拆成有 checkpoint、事件日志和 ledger 的可恢复任务，崩溃或安全验证后可以从中断位置继续。AI 部分不是直接让模型自由写文本，而是用结构化 schema、evidence span、独立审阅器和确定性质量门控制事实性。Data Copilot 和 MCP 进一步提供带快照、权限、审批、幂等 receipt 的工具执行。我的面试重点是如何把浏览器、模型和外部邮件等不稳定边界包装成可审计、可恢复的本地产品。

## 需要主动承认的风险

- server/app.mjs、server/job-manager.mjs 和 src/App.tsx 仍然偏大，模块拆分有架构债务。
- JSON 文件和 SQLite 并存，跨存储一致性需要 ownership、revision 和 manifest hash。
- Relay、模型和 SMTP 使完全 hermetic 的测试较难，需要 fixture、Mailpit 和 contract test。
- 主仓库当前工作树很脏，Codex runtime 扩展还没有形成清晰的独立发布边界。
- KOLFORGE 和便携版没有可审计 Git 历史，面试时要按本地项目快照定位。
