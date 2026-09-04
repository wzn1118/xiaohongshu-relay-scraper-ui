# Hegel Salon：项目卡

## 定位

Hegel Salon 是一个中文优先的黑格尔阅读与推理工作台。它结合本地语料检索、引文约束、概念图、历史参照、附件解析、对话和评测，目标是帮助用户阅读和比较文本，而不是替代学术判断。

## 证据状态

- [当前已核验] 公开仓库浅层快照 commit 为 36f1cd36f9a04abe19f4bab2c21b2c427d3c9f35，日期 2026-05-26。
- [当前已核验] package 使用 Node/JavaScript、OpenAI SDK、Nodemailer 和 Capacitor Android。
- [当前已核验] 仓库包含大量本地语料文本、服务代码、评测脚本、图片和 Android shell。
- [当前已核验] 当前快照有 130 条 evaluation golden、114 个概念图项、172 个 corpus text、161 个 generated Chinese text、38 个 src/*.mjs 和 SQLite 18 张表。
- [仓库文档声称] README 描述多用户、CSRF/admin、Computer Use、评测优化和 Docker/Render/Cloudflare 部署路径。
- [待补证] 候选人具体贡献、语料授权边界、引用准确率和真实用户使用。
- [边界] depth=1 浅克隆只有一个可达提交；文件数量不证明语料权威、人工校对或个人贡献。

## 核心能力

- 本地语料检索与回答来源引用。
- 引文纪律：区分原文、解释和推断。
- 概念图与历史参照。
- PDF、表格、CSV/TSV、文本、JSON、Markdown 和图片附件。
- 浏览器 Computer Use，记录截图和动作日志。
- 登录、多用户、CSRF 和管理员边界。
- 评测、压力测试和优化脚本。
- Windows、Docker、Render、Cloudflare Tunnel 和可选 Android shell。

服务端没有 Express/Fastify，使用 Node 原生 http/https 和静态 HTML/CSS/JS；浏览器能力通过自写 CDP WebSocket 连接 Edge。少依赖有利于原型和本地交付，但 server.mjs 集中路由、鉴权、聊天编排和管理能力，形成明显单体维护风险。

## 本地运行

README 记录的原型端口是 127.0.0.1:3087，核心聊天 API 是 /api/chat。常见命令是 npm install 与 npm run start。

评测脚本包括：

- eval:understanding
- eval:formal-stress
- eval:historical-stress
- smoke:concept-graph
- validate:hegel-graph
- optimize:90

## 最适合讲的设计

### 引文纪律

回答需要区分：

1. 直接引文：必须能定位到语料。
2. 文本解释：标明解释者视角和上下文。
3. 历史比较：绑定二手资料或明确为推断。
4. 系统生成：保留检索结果和推理日志。

代码会从回复抽取引号和“德文原句”等标记，与本轮 hits/parallel/chinese evidence 做归一化 substring 校验。未通过的内容会修订或去引号。它提供工程可解释性，但不是版本学或学术校勘证明。

### 评测而不是印象

将理解、形式逻辑、历史关系和概念图分别做数据集/压力测试，避免用单一“好不好”评分覆盖不同失误类型。

understanding evaluator 当前读取 130 条 JSONL golden，smoke 使用前 12 条；它调用真实 chat API，再由独立 judge model 分维度评分。仓库 package 没有通用 test 脚本，也没有 .github workflow，本轮没有运行评测。

### 多附件上下文

不同附件进入统一 manifest，记录解析器、页码/行号、摘要和失败状态，再与对话上下文预算结合。

## 面试取舍

### 为什么本地语料优先

减少来源漂移，让引文和版本可复查，也适合离线或私有阅读；代价是语料管理、OCR、索引更新和版权边界更重。

### 为什么加入 Computer Use

有些资料只能在浏览器环境查看，Computer Use 提供人工可见的动作链。面试要强调截图/动作日志、权限和用户确认，而不是只强调自动化。

### 为什么有 Android shell

它扩展访问入口，但核心知识服务仍在 Node 后端。移动壳与服务解耦，便于复用 API；需要处理认证、断线和小屏交互。

## 风险与下一步

- 语料版本、授权和引用定位需要正式治理。
- “optimize:90”是脚本目标名，不等于已验证准确率 90%。
- 大量语料和多格式附件需要索引增量更新与性能基准。
- 学术回答需要展示冲突来源和不确定性。
- 多用户与 Computer Use 的权限隔离应有独立威胁模型。
- 质量/逻辑/史学多判官最多三轮，会增加延迟与成本；公网 fast mode 的降级策略需要在 UI 明示。
