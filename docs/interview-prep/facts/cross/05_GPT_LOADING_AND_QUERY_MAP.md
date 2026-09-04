# GPT 分块加载与提问地图

> 目标：在事实总量很大时，按问题加载最小充分证据，减少上下文噪声和数字串线。

## 1. 固定前置上下文

每次新的模拟面试会话先提供：

1. [事实百科总索引](../README.md)
2. [事实冲突、漂移与解释登记表](./04_FACT_SOURCE_CONFLICTS.md)
3. [GPT 模拟面试交接上下文](../../00_GPT_HANDOFF_CONTEXT.md)

然后告诉 GPT：

```text
回答必须区分 HEAD、当前工作区、静态扫描、历史产物、文档声明、公开 API 和外部源码。
每个精确数字都要保留项目、日期、版本与分母。
项目代码事实与候选人个人贡献分开陈述。
缺少本轮运行记录时，使用“代码定义”“CI 配置”“历史报告记录”或“文档声明”。
遇到不同数字先查冲突登记表，不要自行合并。
```

## 2. 按问题选择材料

| 问题类型                  | 加载文件                                                                                                                                                                | GPT 应输出                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| “介绍一下你的项目组合”    | [跨项目技术矩阵](./03_CROSS_PROJECT_TECH_MATRIX.md)、[全部 Git 根](./01_ALL_GIT_ROOTS.md)、[项目组合总览](../../01_PORTFOLIO_OVERVIEW.md)                               | 主项目/副项目/原型/外部研究四层结构                              |
| “详细介绍 XHS 主项目”     | [XHS 索引](../xhs/README.md)、[架构](../xhs/architecture-modules.md)、[状态与数据](../xhs/data-model-state-artifacts.md)                                                | 目标、用户、链路、模块、状态机、取舍、边界                       |
| “API 有哪些”              | [XHS API](../xhs/api-endpoints.md)、[路由条件清单](../main/08_HTTP_ROUTE_CONDITIONS.md)、[前端调用路径](../main/16_FRONTEND_API_PATHS.md)                               | 按领域分组，不把字面量数当作稳定 endpoint 总数                   |
| “可靠性如何设计”          | [工作流状态与 ledger](../main/21_WORKFLOW_STATE_AND_LEDGER.md)、[可靠性状态机](../../04_XHS_RELIABILITY_STATE_MACHINE.md)                                               | 终态、可恢复状态、scope、锁、幂等、守恒、故障恢复                |
| “AI 如何保证质量”         | [AI Provider 与质量事实](../main/22_AI_PROVIDER_AND_QUALITY_FACTS.md)、[XHS AI 深挖](../xhs/ai-providers-quality.md)、[AI/MCP 面试稿](../../05_XHS_AI_MCP_EVIDENCE.md)  | Provider dispatch、schema、重试、证据绑定、评分门、fallback 边界 |
| “Data Copilot/MCP 怎么做” | [XHS Copilot/MCP](../xhs/copilot-mcp-runtime.md)、[API](../xhs/api-endpoints.md)                                                                                        | runtime、tool broker、grant、scope、approval、session、audit     |
| “测试与发布”              | [XHS 测试发布](../xhs/tests-ci-release.md)、[CI 精确事实](../main/13_CI_RELEASE_EXACT_FACTS.md)、[测试资产清单](../main/10_TEST_ASSET_MANIFEST.md)                      | 静态资产、CI 契约、历史报告、本轮状态四层分开                    |
| “当前还在开发什么”        | [XHS 工作区实验](../xhs/worktree-experiments.md)、[工作区状态](../main/04_WORKTREE_COMPLETE_STATUS.md)                                                                  | `W/U` 模块、成熟度、风险与下一步，不混入 v3.0 主线               |
| “谈一个营销数据项目”      | [KOLFORGE 事实](../local/KOLFORGE_FACTS.md)、[KOLFORGE 项目卡](../../10_KOLFORGE_PROJECT_CARD.md)                                                                       | 多平台适配、数据证据、并发/恢复、报告与产物治理                  |
| “谈便携版和 Windows 交付” | [便携版事实](../local/PORTABLE_FACTS.md)、[便携版项目卡](../../11_PORTABLE_PLAYGROUND.md)                                                                               | runtime 打包、启动、健康检查、CI/release、证据差异               |
| “谈快速原型”              | [Playground 事实](../local/PLAYGROUND_FACTS.md)                                                                                                                         | 飞书 Bot、DDC/CI 控件、Relay scraper 各选一个完整故事            |
| “谈数据分析/报告系统”     | [Asteria 事实](../public-external/01_ASTERIA_ANALYST_FACTS.md)、[Asteria 项目卡](../../08_ASTERIA_PROJECT_CARD.md)                                                      | AI 语义层与确定性计算分离、trace、release gate、便携交付         |
| “谈 RAG/知识系统”         | [Hegel 事实](../public-external/02_HEGEL_SALON_FACTS.md)、[Hegel 项目卡](../../09_HEGEL_SALON_PROJECT_CARD.md)                                                          | 概念感知检索、引文校验、多 judge、用户隔离、成本取舍             |
| “谈源码阅读”              | [公开外部索引](../public-external/README.md)及对应仓库事实文件                                                                                                          | 先声明 `EXT`，再讲架构比较、发现和边界                           |
| “给我精确文件/符号证据”   | [tracked manifest](../main/03_TRACKED_FILE_MANIFEST.md)、[public symbols](../main/09_PUBLIC_SYMBOL_INVENTORY.md)、[server manifest](../main/18_SERVER_FILE_MANIFEST.md) | 文件路径、symbol、模块关系；避免整份机械清单复述                 |
| “讲 Git 演进”             | [完整时间线](../main/01_GIT_COMPLETE_TIMELINE.md)、[提交统计](../main/14_COMMIT_CHANGE_STATS.md)、[refs/authors](../main/15_GIT_REFS_AUTHORS.md)                        | 按阶段归纳，并区分提交作者 identity 与个人 ownership             |

## 3. 面试轮次建议

### 第一轮：项目概览

加载总索引、跨项目矩阵和项目组合总览。让 GPT 先追问候选人实际 ownership，再生成 60 秒介绍。

### 第二轮：主项目深挖

加载 XHS 索引以及架构、状态、AI、Copilot/MCP、测试五个主题文件。要求每个回答包含：事实、设计动机、替代方案、失败模式、验证证据、遗留问题。

### 第三轮：代码与系统设计

按题目追加 API、symbol、runtime defaults、env、dependency 和 file manifest。机械清单只用于定位，最终回答应回到模块契约与权衡。

### 第四轮：副项目对照

从 KOLFORGE、Asteria、Hegel、便携版或 Playground 中选一个，要求 GPT 找出它与主项目在数据源、状态管理、证据门和交付形态上的差异。

### 第五轮：压力追问

加载[挑战追问](../../18_CHALLENGE_DRILLS.md)、[证据账本](../../19_CLAIM_EVIDENCE_LEDGER.md)和冲突登记表。重点检查数字来源、当前/历史混淆、个人归属和未验证假设。

## 4. 可直接复用的模拟面试指令

```text
你是资深工程与产品面试官。只依据我提供的事实文件提问。
先从项目目标开始，逐步追问架构、核心链路、状态机、数据契约、AI 质量、测试发布、故障恢复、安全边界和技术债。
每次只问一题；收到回答后指出：
1. 哪些陈述有事实支撑；
2. 哪些把代码存在误写成运行效果；
3. 哪些把仓库能力误写成个人贡献；
4. 哪些数字缺少日期、版本或分母；
5. 一个更严谨、更像本人经历的改写。
优先追问冲突登记表中的项目，不替候选人补造指标。
```

## 5. 大文件使用策略

- [公共符号清单](../main/09_PUBLIC_SYMBOL_INVENTORY.md)体量最大，只有在追问具体模块、类或函数时加载。
- 三个 file manifest 适合定位证据路径，不适合放进每次会话的固定 system context。
- API、env、lockfile 和 script 清单容易产生大量数字；应先给 GPT 一个明确问题，再加载单个文件。
- 项目卡和 STAR 文件是叙事层；事实文件是证据层。需要纠错时，以带版本/路径的事实层为准。
- 同一会话同时讨论多个项目时，为每条数字加项目前缀，例如 `XHS: 103 commits`、`Asteria: 362 registered methods`。

## 6. 回答出稿前检查

1. 回答的是当前问题，而不是复述整个项目组合。
2. 精确数字带项目、日期、版本和分母。
3. `HEAD` 与 `W/U` 没有混写。
4. 历史产物没有改写成本轮运行结果。
5. README 声明没有改写成代码计数。
6. 外部仓库没有改写成个人原创。
7. “我负责/我设计/我独立完成”只来自候选人确认过的经历。
8. 结果指标、用户量、准确率、性能和生产规模都有直接证据或明确标成待补。
