# 简历 Bullet 草案

使用前按个人贡献和证据等级筛选。带“待补证”的 bullet 先不要放进正式简历。

## 主项目：保守版

- 设计并实现本地优先的 Relay 数据工作台，采用 React/Vite、Node.js ESM、Python/Playwright 和 SSE，覆盖采集、证据整理、AI 草稿、质量门和人工交付。
- 将跨 Node/Python 的一次性采集改造成带 job/attempt/checkpoint/JSONL journal/ledger 的可恢复工作流，支持取消、恢复和幂等去重。
- 建立 evidence-aware AI 生成链路，以 JSON schema、source span、确定性 validator 和独立审阅器限制无来源声明，并将低质量结果停留在草稿层。
- 为 Data Copilot/MCP 设计 snapshot、context manifest、grant、scope、approval、execution receipt 和未知副作用 reconcile 路径。
- 构建批量申请的 preflight、dry-run、freeze、approve、send 和 audit 流程，降低误发和重复发送风险。
- 建立 Windows 一键发布链路，从 Git 提交生成净化包，在临时目录执行依赖安装、构建和 health check。

## 主项目：量化版占位

只有补充真实日志后才使用：

- 将恢复成功率从 [旧值] 提升到 [新值]，重复请求率降至 [值]，基于 [日期/日志路径]。
- 在 [数据集/环境] 上将 AI evidence coverage 提升至 [值]，validator failure 降至 [值]。
- 将便携包首次启动成功率提升至 [值]，基于 [CI run/release id]。

## Asteria

- 构建本地企业数据分析与管理报告工作台，将 AI 字段语义/业务路由/指标规划与确定性统计执行、trace 和 PDF release gate 分离。
- 维护统计方法 registry 与可执行状态分层；当前快照代码解析为 18 个 family、362 个注册方法和 81 个 live 方法。
- 实现 AI mandatory artifacts 校验，门禁失败时保留 debug 产物并移除正式 management report。

以上三条需要确认个人贡献；浅克隆快照不足以单独证明完整作者历史。

## Hegel Salon

- 构建中文哲学阅读与推理工作台，将本地语料、概念图、历史参照、引用校验和多轮质量审阅组合成可复核的问答链路。
- 实现回复引文与检索 evidence 的逐字校验，未通过时修订或去引号，并返回 validation/judge/source anchors。
- 建立按 user/style 隔离的运行目录、SQLite WAL、凭证加密、CSRF/限流和本地 Computer Use 边界。

这些 bullet 需补个人贡献和真实评测结果；不要把 golden 数量或 judge 分数当业务效果。

## KOLFORGE

- 设计多平台 KOL connector 体系，统一账号/内容/evidence schema，支持跨 query route 去重、checkpoint、受限并发和失败恢复。
- 将视频、字幕、OCR、ASR 与评论证据汇入多代理营销分析和个性化建联报告。
- 通过 session-forensics 将 agent session JSON/JSONL 编译为工具调用、文件变更和可复用流程。

项目没有 Git provenance，简历中使用“本地实现/原型”并补运行截图或 demo 记录。

## 便携版与小工具

- 将主项目依赖封装为 Windows 便携运行包，提供首次启动、runtime 检查、健康端点和发布包净化。
- 使用 FastAPI、飞书 Events、OpenAI Responses API 和 SQLite 完成轻量消息机器人原型。
- 使用 PowerShell/WPF 与 DDC/CI 完成第二显示器亮度控制工具，支持单实例和启动项。

## 不应直接使用的表述

- “独立完成了工作区所有代码。”
- “生产环境稳定达到 90 分/90%。”
- “拥有 15,000 个真实候选或 4,062 条真实增长数据。”
- “独立开发了外部 wechat/prompt 仓库。”
- “本轮全量测试通过。”
