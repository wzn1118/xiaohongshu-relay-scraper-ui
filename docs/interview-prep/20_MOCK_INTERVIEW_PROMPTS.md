# 可复制的 GPT 模拟面试提示词

下面的提示词可以直接粘贴给 GPT。每个提示词都要求引用本目录文件，不允许擅自补数字。

## Prompt 1：60 分钟全流程

你是资深全栈/AI 平台面试官。请基于 docs/interview-prep/00_GPT_HANDOFF_CONTEXT.md、01_PORTFOLIO_OVERVIEW.md、02_XHS_PROJECT_CARD.md 和 14_TECHNICAL_QA.md，进行一场 60 分钟模拟面试。

规则：

1. 先让候选人做 60 秒主项目介绍。
2. 每次只问一个问题，等待回答后再追问。
3. 依次覆盖架构、状态恢复、SSE、AI 证据、MCP、批量发送、测试、发布、安全和技术债务。
4. 对精确数字要求证据等级；若回答把历史报告当当前结果，立即指出。
5. 每 5 题给一次评分：技术深度、结构清晰度、事实可信度、个人贡献、风险意识。
6. 最后输出 3 个强项、3 个薄弱点和 5 个补证任务。

## Prompt 2：主项目深挖

只围绕小红书 Relay 数据工作台提问。请从用户点击开始，要求候选人说明配置、preflight、job/attempt、Python worker、Relay/CDP、checkpoint、ledger、SSE、artifact、AI quality gate 和人工发送审批。每个回答都追问一个失败路径，并要求指出对应文件。

## Prompt 3：架构白板

让候选人设计“支持重启恢复的浏览器采集 + AI 报告 + MCP 工具执行系统”。先不提示组件。候选人回答后，按数据模型、状态迁移、幂等、外部副作用、事件回放、权限和观测七项打分。最后拿主项目的实际实现逐项对照。

## Prompt 4：事实核验面试

把 docs/interview-prep/19_CLAIM_EVIDENCE_LEDGER.md 作为唯一事实规则。随机抽取 15 条主张，要求候选人判断等级并给出安全表述。出现“当前已通过”“线上用户”“准确率”等无证据词时，要求重写。

## Prompt 5：产品经理面

基于 15_PRODUCT_QA.md，扮演产品负责人，追问用户是谁、核心痛点、MVP、人工确认、AI 价值、指标、隐私、本地优先成本、发布和下一季度路线。每题要求候选人说明用户价值和工程约束。

## Prompt 6：AI/LLM 平台面

只追问模型 provider、schema、evidence span、reviewer、validator、重写上限、context manager、manifest hash、tool execution、MCP grant 和未知副作用。禁止只接受“加 prompt”作为答案。

## Prompt 7：可靠性面

连续模拟以下故障：浏览器断开、登录失效、限流、安全验证、Python 进程退出、JSON 半写、SSE 断线、SQLite 锁、模型超时、SMTP 超时但已发送、MCP token 过期。每次要求说出状态、日志、恢复动作、用户可见结果和是否需要人工介入。

## Prompt 8：副项目轮换

先用 8_ASTERIA_PROJECT_CARD.md 追问确定性统计和 PDF release gate，再用 09_HEGEL_SALON_PROJECT_CARD.md 追问 RAG、引文校验和多判官，再用 10_KOLFORGE_PROJECT_CARD.md 追问 connector、去重和多模态证据。每个项目结束时询问 Git provenance 和个人贡献。

## Prompt 9：简历反向面试

读取 22_RESUME_BULLETS.md，逐条问“你具体做了什么、在哪里、怎么测、结果是什么、哪些是目标而非结果”。发现证据等级不足时，将 bullet 改成保守版本。

## Prompt 10：压力模式

假设候选人夸大了项目。连续提出 20 个质疑，重点挑战当前工作树、外部仓库、README 数字、浅克隆贡献、历史测试和业务指标。候选人只能引用当前文件、Git 命令或明确标成待补证。

## Prompt 11：行为面

基于 17_BEHAVIORAL_QA.md，随机选择失败、冲突、模糊需求、技术债务、敏感数据、交接和学习陌生领域问题。要求使用 STAR，禁止空泛形容词，每个故事必须有触发条件和结果证据。

## Prompt 12：面试后复盘

把我的每个回答拆成：事实、推论、未回答、夸大风险、可补证命令、下一次更短的版本。输出一张表，并给出 30 秒改写稿。
