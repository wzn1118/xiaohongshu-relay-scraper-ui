# 面试准备资料包

本目录是当前工作区的面试资料主入口，面向后续 GPT 模拟面试、简历改写、项目深挖和系统设计追问。资料以当前仓库证据为中心，覆盖公开项目、本地项目、阶段快照、原型和外部源码副本。

需要“所有事实、越多越好”时，从[全项目事实百科索引](facts/README.md)进入；它把提交基线、当前工作区、机械清单、本地项目、公开/外部仓库和跨项目冲突登记分开组织。

语料体量和分块策略见[事实语料库统计与覆盖说明](facts/00_FACT_CORPUS_STATISTICS.md)；全部文件的路径、大小、行数和标题数见[文档清单](25_DOCUMENT_MANIFEST.md)。

## 使用顺序

1. 先读 00_GPT_HANDOFF_CONTEXT.md：把候选人的项目边界、事实等级和面试规则交给 GPT。
2. 再读 01_PORTFOLIO_OVERVIEW.md：确认面试主线、项目排序和每个项目的定位。
3. 主项目深挖按 02 到 07 阅读：项目卡片、架构、可靠性、AI/MCP、安全、测试与发布。
4. 副项目按 08 到 12 阅读：Asteria Analyst、Hegel Salon、KOLFORGE、便携版、Playground 和仓库来源。
5. 训练材料按 13 到 24 阅读：STAR 故事、技术题、产品题、系统设计、行为题、挑战题、证据账本、模拟提示词、口述稿、简历 bullet、术语和补证清单。
6. repos/ 下是一页式项目卡，适合单独发送给 GPT 或在面试前快速复习。

## 事实等级

| 标记         | 含义                                                            | 面试用法                                  |
| ------------ | --------------------------------------------------------------- | ----------------------------------------- |
| 当前已核验   | 本轮从当前文件、Git 状态或公开 API 直接确认                     | 可作为事实陈述，仍需说明个人贡献边界      |
| 仓库文档声称 | README、设计文档或验收报告中的数字/能力，本轮没有重新跑完整流程 | 用“文档记录”“当时验收记录”表述            |
| 历史快照     | 旧提交、旧发布包、阶段 clone 或 dated report                    | 说明时间和版本，避免当成当前状态          |
| 工作区实验   | 当前未提交或未跟踪的原型代码                                    | 说成“正在开发/实验分支”，不说成已发布能力 |
| 外部来源     | remote 指向他人仓库或缺少个人提交证据                           | 仅作为源码阅读、二次实验或技术参考        |
| 待补证       | 需要真实运行、提交记录、数据报告或个人贡献说明                  | 面试前优先补齐，避免给出精确数字          |

## 面试主线

推荐把经历组织为一条产品与工程演进线：

1. 小红书 Relay 数据工作台：主项目，讲本地优先、可恢复工作流、证据驱动 AI、Data Copilot/MCP 和发布工程。
2. KOLFORGE：副项目，讲跨平台营销数据、适配器、去重、受限并发、多模态证据和七代理报告。
3. Asteria Analyst：数据分析与正式报告工作台，讲确定性计算、证据校验和 PDF 发行门。
4. Hegel Salon：知识检索与历史哲学推理工作台，讲本地语料、引文纪律、评测和多用户隔离。
5. today-you-applied-portable：主项目的 Windows 便携交付章节，讲运行时打包、首次启动、升级和健康检查。
6. Playground 小项目：飞书机器人、显示器亮度控件、早期采集原型，用于回答快速交付和跨栈问题。

## 完整目录

### 总览与主项目

- [GPT 模拟面试交接上下文](00_GPT_HANDOFF_CONTEXT.md)
- [项目组合总览](01_PORTFOLIO_OVERVIEW.md)
- [主项目卡片](02_XHS_PROJECT_CARD.md)
- [主项目架构](03_XHS_ARCHITECTURE.md)
- [可靠性与状态机](04_XHS_RELIABILITY_STATE_MACHINE.md)
- [AI、Data Copilot 与 MCP](05_XHS_AI_MCP_EVIDENCE.md)
- [安全与隐私](06_XHS_SECURITY_PRIVACY.md)
- [测试、CI 与发布](07_XHS_TEST_RELEASE.md)

### 其他仓库

- [Asteria Analyst](08_ASTERIA_PROJECT_CARD.md)
- [Hegel Salon](09_HEGEL_SALON_PROJECT_CARD.md)
- [KOLFORGE / MKT 大师](10_KOLFORGE_PROJECT_CARD.md)
- [便携版与 Playground](11_PORTABLE_PLAYGROUND.md)
- [仓库清单与来源边界](12_REPO_INVENTORY_PROVENANCE.md)

### 训练材料

- [STAR 故事库](13_STAR_STORIES.md)
- [技术面试问答](14_TECHNICAL_QA.md)
- [产品面试问答](15_PRODUCT_QA.md)
- [系统设计训练](16_SYSTEM_DESIGN_DRILLS.md)
- [行为面试问答](17_BEHAVIORAL_QA.md)
- [压力追问](18_CHALLENGE_DRILLS.md)
- [事实与证据账本](19_CLAIM_EVIDENCE_LEDGER.md)
- [GPT 模拟面试提示词](20_MOCK_INTERVIEW_PROMPTS.md)
- [30/60/90 秒口述](21_PITCHES_30_60_90.md)
- [简历 Bullet 草案](22_RESUME_BULLETS.md)
- [术语表](23_GLOSSARY.md)
- [面试前补证清单](24_GAPS_VERIFICATION.md)

### 一页式项目卡

- [XHS Relay Workbench](repos/xhs-relay-workbench.md)
- [Asteria Analyst](repos/asteria-analyst.md)
- [Hegel Salon](repos/hegel-salon.md)
- [KOLFORGE](repos/kolforge.md)
- [便携版与 Playground](repos/portable-and-playground.md)
- [外部源码与重复仓库](repos/external-source-repos.md)

## 重要边界

- 当前主仓库工作树有大量未提交 Codex Desktop/Browser/Device/Mirror 原型。资料会明确区分 v3.0 主线与工作区扩展。
- MKT大师、today-you-applied-portable 和 Playground 没有可审计 Git 提交，应以“本地项目快照”表述。
- wechat-cli、wechat-decrypt、prompt/skill 仓库的 remote 指向外部项目。除非补充个人提交证据，否则只放在来源账本，不作为原创主项目。
- 任何历史测试数字都带日期和来源；本轮只做静态盘点，没有把旧报告数字写成当前运行结果。

## 快速入口

- [GPT 交接上下文](00_GPT_HANDOFF_CONTEXT.md)
- [项目组合总览](01_PORTFOLIO_OVERVIEW.md)
- [主项目卡片](02_XHS_PROJECT_CARD.md)
- [技术面试题](14_TECHNICAL_QA.md)
- [产品面试题](15_PRODUCT_QA.md)
- [证据账本](19_CLAIM_EVIDENCE_LEDGER.md)
- [补证清单](24_GAPS_VERIFICATION.md)
