# Asteria Analyst：项目卡

## 定位

Asteria Analyst 是一个本地优先的企业数据分析、统计实验与管理报告工作台。它把数据导入、字段语义、分析计划、确定性计算、证据校验和正式报告发行串成一条可审计链路。

## 证据状态

- [当前已核验] 公开仓库元数据与浅层源码快照；快照 commit 为 b9b817053d6b40b6a4222efcd472cffe1345e5ea，日期 2026-07-28。
- [当前已核验] 前端使用 Next.js 16、React 19、TypeScript；后端使用 FastAPI/Pydantic。
- [当前已核验] 本轮对 statistical_catalog.py 做 AST 盘点：18 个 family、362 个注册方法、81 个 status=live 方法。
- [当前已核验] 当前快照有 70 个 test_*.py、约 120 个服务层 Python 文件、9 个 ai_mandatory 文件和 107 个 FastAPI 装饰器声明（其中 2 个是生命周期事件）。
- [仓库文档声称] README 列出 4,028 张方法卡和 273 张 runnable 卡，本轮未重新运行生成器。
- [待补证] 候选人在每个模块的个人贡献、真实企业用户、数据规模、性能和报告采用结果。
- [边界] 这是 depth=1 的浅克隆，只能确认当前快照；架构文档把产品定位为本地单用户 workbench，账号、租户、权限和审计留存需要另加平台层。

## 正式分析链路

1. 原始数据进入 DataProfileService。
2. AIFieldSemanticMapper 推断字段语义并提供可编辑映射。
3. AIBusinessContextRouter 根据业务问题选择上下文。
4. AIMetricDerivationPlanner 生成指标与统计计划。
5. DeterministicMetricExecutor 执行可重复的数值计算。
6. EvidenceValidator 验证结论、表格和原始字段的对应关系。
7. ReportBindingLayer 将结果绑定到报告段落和图表。
8. FormalPDFReleaseGate 检查正式 PDF 的必要条件。

最终目标是让 management_report.pdf 中的每个重要结论可追溯到计算结果和来源字段，而不是把模型生成文本当成分析本身。

代码还会写出 AI 语义映射、业务路由、指标计划和语义指标结果等 trace；ai_usage_gate 校验 schema、trace_id 和 metric derivation CSV。门禁失败时生成 debug MD/HTML/PDF，并从下载列表移除残留的 management report。

## 技术栈

| 层   | 技术                                      |
| ---- | ----------------------------------------- |
| 前端 | Next.js 16、React 19、TypeScript          |
| API  | FastAPI、Pydantic                         |
| 数据 | Pandas、DuckDB、Statsmodels、scikit-learn |
| 文档 | OpenPyXL、python-docx、pypdf、ReportLab   |
| 工程 | pytest、npm、GitHub Actions               |

## 页面/用户流程

- 首页与分析工作台
- Analysis Lab
- 方法指南
- 修订工作区
- 版本与正式发行

源码启动文档记录：Node 20+、Python 3.11，通过 open-asteria-ui.ps1 启动；前端默认 127.0.0.1:3000/analysis，后端健康端点 127.0.0.1:8000/health。

## 面试亮点

### 确定性计算与生成式解释分离

模型负责字段语义、业务上下文和解释候选；关键数值由确定性执行器产生。这样可以测试、重算和追溯。

### 正式报告发行门

报告不是“导出按钮”，而是检查缺失字段、指标失败、证据未绑定、引用漂移、版式和版本后才发行。

### 方法注册表

统计方法以 registry/card 方式管理能力、适用前提、输入、输出和 runnable 状态，支持方法指南和运行时路由。

### Windows 便携交付

CI 定义 backend、frontend、portable-smoke 和 release 四个 job。Windows job 会实际生成 ZIP、解压、检查 runtime 文件、启动固定端口并验证 health 和五条前端路由。这里是 CI 契约事实，本轮没有执行该 workflow。

## 可用 STAR 故事

情境：AI 数据分析容易在字段语义、数值和报告措辞之间产生漂移。

任务：建立一条既能使用 AI，又能对关键指标和正式报告负责的链路。

行动：将字段语义、分析计划、确定性执行、证据校验和 PDF 发行门拆开；每一步生成可检查对象。

结果：形成从原始数据到正式报告的可追溯流程。量化结果需引用仓库 dated report 或真实验收记录。

## 风险与下一步

- 362/81/18 已由当前快照代码盘点；4,028/273 仍属于 README 记录。
- 需要明确 runnable 方法的输入覆盖、数值容差和基准数据集。
- 需要补大文件/高维数据性能基准。
- 需要明确用户权限、敏感数据留存和报告审计策略。
- 前后端、统计执行和文档渲染的版本兼容应进入 release contract。
