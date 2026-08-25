# 公开与外部仓库面试表述边界

> 目标：把“我做了什么”“代码证明了什么”“上游文档说了什么”“还有什么没验证”拆成可追问、可防守的答案。所有结论来自本轮静态审计。

证据标签：[当前代码事实]、[README 声明]、[历史快照]、[外部源码]、[未验证]；回答时保留标签语义，即使省略方括号也要保留限定词。

## 1. 五段式事实答法

面试回答每个技术点时按以下顺序组织：

1. **对象身份**：原创公开项目，还是外部源码研究对象。
2. **具体问题**：用户/工程问题是什么，避免先报代码量。
3. **当前代码事实**：入口、数据流、边界、测试、路由和提交证据。
4. **权衡与风险**：指出选择带来的代价，不把局限藏起来。
5. **验证边界**：本轮运行了什么、尚未运行什么、下一步如何验证。

示例骨架：

> 在 AsteriaAnalyst 这个公开项目中，我把语义理解、指标规划和确定性数值执行拆开。代码里对应 `AIFieldSemanticMapper`、`AIMetricDerivationPlanner`、`DeterministicMetricExecutor` 和 `EvidenceValidator`，报告发布前还有 PDF gate。这样做的好处是模型负责解释和规划，数字可以被回归测试与审计；代价是 schema、trace 和执行器注册更复杂。本轮确认了服务/API/CI 结构，没有用真实企业数据复现所有方法和报告质量分。

## 2. 可归为原创项目的事实

### 2.1 AsteriaAnalyst

可以讲：

- [当前代码事实] Next 16 + React 19 + FastAPI 的本地优先分析工作台。
- [当前代码事实] AI 语义层、确定性数值层、证据层和正式 PDF 发布层分离。
- [当前代码事实] 94 个主要 FastAPI GET/POST/DELETE 装饰器、6 个页面、25 个 Pydantic 模型。
- [当前代码事实] Dataset、统计/Lab、报告 job、Agent session、事件、附件、批注、publish、Codex pipeline 的完整工作表面。
- [当前代码事实] 70 个后端测试文件、约 551 个测试定义；CI 同时检查 pytest、Next build、lint、依赖 audit 与 Windows 便携产物真实启动。
- [当前代码事实] 默认 loopback、public/private storage 分离、运行能力环境开关。
- [当前代码事实] 当前缺口是无登录、上传缺少明确大小门槛、执行能力扩大信任面、仓库缺 LICENSE。

不要扩大为：

- [未验证] “4,028 个方法都可运行”——目录清单只有 273 runnable、1,023 catalog、2,732 planned 的历史快照。
- [未验证] “正式报告准确率达到某数值”——本轮未执行真实基准。
- [未验证] “已是多租户 SaaS”——当前是 loopback 单用户信任模型。
- [未验证] “所有 CI 当前在线通过”——本轮只审计 workflow 配置。

### 2.2 hegel-salon

可以讲：

- [当前代码事实] 中文优先的 Hegel 语料检索、对读、概念关系和对话工作台。
- [当前代码事实] 直接引文必须在当前检索证据中做规范化连续子串匹配，invalid quote 会失去直接引文标记。
- [当前代码事实] 37 条 registry routes 每条有 schema、risk、readOnly、destructive、concurrencySafe、auth/admin 元数据。
- [当前代码事实] 18 张 SQLite 表覆盖用户、会话、验证码、风格、聊天、记忆、安全事件、训练、Local Agent 与用量。
- [当前代码事实] scrypt password、hashed session/device token、CSRF、admin 2FA、AES-256-GCM API key、upload limits、user runtime dirs。
- [当前代码事实] Render/Docker/Compose、browser Computer Use 和 Local Agent 分流。
- [当前代码事实] 当前缺口是无 CI/统一 test script、一个 quote precision 脚本变量缺失、进程内限流、语料许可与上传安全的生产化。

不要扩大为：

- [未验证] “引文校验保证学术正确”——它只确认当前 evidence substring。
- [未验证] “模型 judge 分数就是哲学质量”——README 自身也把它定义为工程信号。
- [未验证] “所有中文文本都有同等来源等级”——generated Chinese 与原始 corpus 分目录，逐项 provenance 未审完。
- [未验证] “已有完整 CI/CD”——Render autoDeploy 与代码测试门是不同概念。

## 3. 外部源码只能归为审计/研究贡献

### 3.1 wechat-cli

准确说法：

> [外部源码] 我审计过 wechat-cli 的跨平台 key discovery、SQLCipher/WAL 解密和 Click 查询结构，重点发现明文 key/temp DB cache 生命周期、macOS 重签名、Linux ptrace 权限与 npm platform metadata 的边界。

证据锚点：

- [当前代码事实] 11 个 CLI commands、Python 0.2.4、三平台 scanner。
- [当前代码事实] dynamic message table 白名单、参数 SQL、path traversal guard、XML 大小/DTD gate。
- [当前代码事实] `cleanup()` 不删除跨进程复用的 temp 明文 DB。
- [当前代码事实] checkout remote 与 npm manifest repository 不同。

### 3.2 wechat-decrypt

准确说法：

> [外部源码] 我对比了另一种 WeChat 本地数据管线：它把 30ms WAL 监视、SSE Web、图片恢复和 stdio MCP 串起来；静态审计发现 Web 默认绑定全部接口且无认证，代码有 7 个 MCP tools 而文档写 5 个，requirements 还漏了 `zstandard`。

证据锚点：

- [当前代码事实] `ThreadedServer(('0.0.0.0', 5678), Handler)`。
- [当前代码事实] `/api/history`、`/stream`、`/img/{filename}` 无登录层。
- [当前代码事实] 7 个 `@mcp.tool()`，README/CHANGELOG 只列 5 个。
- [当前代码事实] CI 只有 Windows ruff lint。

### 3.3 MDX prompt repo

准确说法：

> [外部源码] 我把它当作 prompt 软件供应链样本：核对 ZIP 内条目、SHA-256、installer 备份/reset、archive check 与评测证据目录。结果是当前 ZIP hash 与 README 不符，clean clone 缺源文件导致 check 失败，README 引用的 tests/reports/examples 也不在 tree 中。

证据锚点：

- [当前代码事实] 13 个 ZIP、2 个 prompt archive、11 个 runner/generator/scorer archive。
- [当前代码事实] v5/v35 ZIP 当前 SHA-256 已在仓库事实档案记录。
- [当前代码事实] `codex-instruct.py` 会改用户 `config.toml`，但有 dry-run、backup、snapshot、reset。
- [当前代码事实] 唯一 workflow 做 Pages/Star History，不测试核心 installer/评测。

### 3.4 source aggregate

准确说法：

> [外部源码] 我审计了一个多来源 Agent skill 聚合树：63 个 `SKILL.md`、40 个 competition specialists、Burp Java MCP 和多个许可证。重点不是声称“掌握全部工具”，而是建立 entrypoint、listener、下载器、dirty tree、CI 和 license 的 trust inventory。

证据锚点：

- [当前代码事实] 438 tracked、341 Markdown、63 entrypoints、Burp 63 个顶层 dispatch case。
- [当前代码事实] Burp MCP 绑定 `127.0.0.1:9876`，无应用级 token。
- [当前代码事实] 唯一 workflow 只过滤并 auto-merge field-journal PR。
- [当前代码事实] 当前 tracked 删除 6,501 行，另有 untracked bytecode cache。
- [当前代码事实] MIT、GPL-3.0 与多个作者/嵌套组件并存。

## 4. 所有权与贡献级别词表

| 证据等级           | 建议动词                                       | 使用条件                                         |
| ------------------ | ---------------------------------------------- | ------------------------------------------------ |
| 直接原创、代码可证 | “设计、实现、拆分、接入、测试、发布”           | 只用于原创仓库中自己真正负责且能解释的部分。     |
| 参与但边界未定     | “参与、负责其中、协作完成”                     | 需要 commit/PR/任务证据，主动说清个人范围。      |
| 静态审计           | “审计、盘点、比对、识别、验证配置”             | 有文件、commit、命令与差异证据；不代表动态结果。 |
| 外部源码学习       | “研究、复盘、比较、借鉴”                       | 明确上游 remote 和 License，不归为个人 feature。 |
| README 信息        | “文档声明、作者描述、生成快照显示”             | 没有当前运行证据时保留限定词。                   |
| 未验证             | “当前尚未复现、仍需动态验证、当前快照缺少证据” | 性能、质量、兼容、线上结果、完整历史等。         |

## 5. 追问时的证据优先顺序

1. Git：remote、branch、HEAD、时间、dirty、shallow/partial clone。
2. Entrypoint：实际启动文件、console script、server main、workflow trigger。
3. Manifest：版本、runtime、依赖、lock、build script、package metadata。
4. Surface：CLI command、HTTP route、MCP tool、SKILL entrypoint。
5. Data：schema/table/model、目录、缓存、生命周期、隔离。
6. Security：bind address、auth、secret、upload、execution gate、cleanup。
7. Quality：真实 tests、CI job、smoke、assertion、fixture、artifact gate。
8. Claims：README 与当前代码一致、漂移、缺证据的地方。

## 6. 高频面试题库

### 架构

1. Asteria 为什么让 AI 生成计划，却让确定性执行器生成数值？
2. Asteria 的 report-agent session 为什么同时需要 events、files、diff、attachments、annotations 和 publish？
3. hegel 的 tool registry 为什么比散落的 `if pathname` 更适合 Agent 系统？
4. hegel 的直接引文校验为何选择 exact substring，而不是再让模型判断？
5. 两个 WeChat 工具的 cache 策略和明文生命周期有什么区别？
6. MDX installer 的 baseline backup、timestamp snapshot 与 reset 分别防什么失败？
7. 63 个 skills 的聚合树如何做 lazy loading 和 trust ranking？

### 数据与一致性

1. WAL patch 为什么要校验 frame salt？
2. mtime cache 在时钟粒度、复制覆盖和并发写下会出现什么边界？
3. SQLite WAL + FULL synchronous 适合 hegel 的原因与瓶颈是什么？
4. Asteria 如何从 dataset profile 走到 evidence-bound report？
5. 归档 SHA-256 与 README 不一致时，怎样区分文档漂移、压缩差异和供应链问题？

### 安全

1. loopback service、`0.0.0.0` service 和 stdio MCP 的攻击面分别是什么？
2. Asteria 无登录为什么在本地模式可接受，而改绑公网地址后风险会跃迁？
3. hegel API key 的 AES-GCM key hierarchy 和本地 key file 有什么失效场景？
4. Burp MCP 即便只绑定 loopback，为什么仍需要 caller authentication 和操作级 policy？
5. 上传大小、类型、MIME、恶意扫描、解析器隔离分别覆盖什么威胁？
6. 外部 instruction 文件为什么应按 executable configuration 做审计？

### 测试与发布

1. Asteria 为什么让 release job 消费 portable-smoke 已验证的同一 artifact？
2. eval/stress script 与 unit test 的证据强度有什么不同？
3. lint-only CI 能证明什么，缺少什么？
4. README 中有 benchmark，但 tests/reports 不在仓库时，怎样设计最小可复现包？
5. content auto-merge workflow 的 regex gate 有哪些误报/漏报边界？

## 7. STAR 素材骨架

### 7.1 Asteria：确定性报告链

- **Situation**：[README 声明] AI 分析工作台需要把自然语言语义与正式管理报告连接起来。
- **Task**：[当前代码事实] 避免模型直接产出不可审计数字，并形成正式发布门。
- **Action**：[当前代码事实] 拆成 profile、semantic map、business route、metric plan、deterministic executor、evidence validator、report binding、PDF gate。
- **Result**：[当前代码事实] 代码与 API 形成可追踪工作流；CI 能构建并 smoke 最终 portable artifact。
- **Boundary**：[未验证] 本轮未用统一 benchmark 给出业务准确率与 PDF 人工评分。

### 7.2 hegel：引文与安全层

- **Situation**：[README 声明] 哲学问答对伪造直接引文特别敏感，又需要用户风格/记忆与多用户部署。
- **Task**：[当前代码事实] 让引文有当前证据，用户数据与配置可隔离。
- **Action**：[当前代码事实] exact substring quote validator；18-table SQLite；scrypt、CSRF、2FA、AES-GCM、user runtime scope；Local Agent。
- **Result**：[当前代码事实] 对话 response 同时返回 validation/judges，API registry 可按角色和风险暴露能力。
- **Boundary**：[当前代码事实] 无 CI；[未验证] 学术质量、语料权威与动态越权测试尚未完成。

### 7.3 外部源码审计：文档漂移

- **Situation**：[外部源码] 多个公开工具用 README 说明能力与安全边界。
- **Task**：识别文档与实际代码的偏差，避免面试和集成决策建立在声明上。
- **Action**：[当前代码事实] 比对 decorators/imports/requirements/hash/Git status/listener bind/CI scope。
- **Result**：[当前代码事实] 找到 7 vs 5 MCP、缺 `zstandard`、`0.0.0.0` 无认证、MDX hash 不符和 source 6,501 行删除等具体证据。
- **Boundary**：[未验证] 本轮以静态审计为主，运行兼容与线上 release 仍要另做验证。

## 8. 说法自检清单

- 是否先说明原创项目还是外部源码？
- 是否给出具体模块、route、table、command、workflow，而不是只给形容词？
- 是否把 README 声明标成声明？
- 是否把 shallow/partial clone 与远程完整历史分开？
- 是否把 test 文件数与本轮真实执行结果分开？
- 是否把 listener bind、auth、secret lifecycle、upload limit 和 cleanup 讲清？
- 是否把“目录存在”与“功能可运行”分开？
- 是否主动说 dirty tree、hash mismatch、missing source、dependency drift？
- 是否保留后续验证路径，而不是补写没有证据的成功结果？

## 9. 当前默认面试主张

> 我有两个可以按原创公开项目深入讲的主线：AsteriaAnalyst 的本地数据分析到正式报告流水线，以及 hegel-salon 的语料检索、引文证据与多用户安全工作台。除此之外，我对多个外部仓库做过证据化源码审计，能从 Git provenance、entrypoint、manifest、API/CLI/MCP 表面、数据生命周期、CI 和许可证识别文档漂移与部署风险。外部仓库只作为审计与学习经验，不归为个人实现。
