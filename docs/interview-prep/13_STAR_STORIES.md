# STAR 故事库

每个故事都分为事实层和口述层。口述时把“我”替换成真实个人职责；如果只是参与或本地原型，主动降低语气。

## 故事 1：把一次性采集改成可恢复工作流

### S 情境

早期采集链路在浏览器断开、进程退出或遇到安全验证后需要重新开始，重复请求多，用户也看不出任务究竟停在哪一步。

### T 任务

让用户能看到阶段状态，在中断后恢复原任务，同时避免已经完成的正文和评论被再次处理。

### A 行动

我把运行拆成 job、attempt、revision、checkpoint、event journal 和 body ledger。Node 负责生命周期和 SSE，Python 在阶段边界写状态与游标。恢复时读取 journal、manifest 和 ledger，并用 revision compare-and-swap 防止旧 worker 覆盖新状态。安全验证触发全局 gate，等待人工处理后继续。

### R 结果

主线形成了可恢复和可审计的任务模型。仓库当前 HEAD 的提交信息也明确包含 job recovery 和 quality gates。实际恢复率、重复率和平均恢复时间仍需用运行日志补证。

### 追问

- 哪个状态是服务端唯一真相？
- checkpoint 写入和产物写入的顺序如何定义？
- 两个恢复 worker 同时启动如何处理？

## 故事 2：限制 AI 幻觉进入应用文

### S 情境

应用文和岗位分析如果只依赖模型自由生成，容易把简历没有的工具、数字或经历写进去。

### T 任务

让每个关键声明都能回到来源，并让低质量结果停在草稿层。

### A 行动

我将来源标准化为 evidence id 和 source span，要求 writer 输出结构化 JSON。独立 Employer Review Agent 负责事实、匹配度和可执行性检查，evidence_claim_validator 做确定性验证，发现缺证、数字漂移或非法来源就返回反馈并限制重写轮数。质量门通过后仍保留人工编辑和发送审批。

### R 结果

AI 生成变成“结构化候选 + 证据门 + 人工确认”的流程，而不是直接发信。质量阈值和重写上限来自设计参数；准确率或转化率要补真实评测。

### 追问

- 为什么要独立 reviewer？
- 如果来源本身错误怎么办？
- 低分结果如何让用户理解而不是只看到一个数字？

## 故事 3：SSE 断线后继续展示任务

### S 情境

任务运行时间较长，浏览器刷新或网络抖动会让实时进度丢失。

### T 任务

在不无限占用内存的情况下，让客户端重新连接后补齐缺失事件。

### A 行动

事件先写 JSONL journal，每条事件带单调序号。客户端保存 Last-Event-ID，重连时服务端从 journal 回放并检测 gap；超过 pending frame 上限的慢客户端被断开，并依靠 snapshot 重新对齐。heartbeat 保持长连接活跃。

### R 结果

任务状态和实时流解耦，刷新后能从持久化事件重建 UI。当前参数包括约 15 秒 heartbeat、约 1,000 个慢客户端 pending frame 上限。

### 追问

- journal 损坏怎么办？
- 事件重复回放是否会让 UI 重复计数？
- 为什么不直接只返回最新 snapshot？

## 故事 4：批量发送前增加安全闸门

### S 情境

批量应用文发送同时包含收件人、附件、正文和外部 SMTP 副作用，一次误配置可能造成不可逆影响。

### T 任务

让用户先看清动作，再显式批准，并避免重复发送。

### A 行动

流程拆为 preflight、dry-run、freeze、approve、send、receipt 和 audit。冻结后 payload 和 evidence hash 不再随 UI 编辑变化；发送用 idempotency key，重复请求返回既有 receipt；外部状态未知时转 reconcile_required。

### R 结果

批量动作具有明确的人工确认点和审计链。真实发送成功率、退信率和重复发送率需用 Mailpit/生产报告补证。

### 追问

- freeze 的边界是什么？
- SMTP 返回超时但邮件已发出怎么处理？
- 用户批准后修改附件会发生什么？

## 故事 5：把模型上下文变成可解释的 manifest

### S 情境

Data Copilot 同时面对岗位、评论、用户、历史对话、工具 schema 和产物，直接把全部数据塞给模型既昂贵又难复盘。

### T 任务

在固定 token 预算内保留最相关证据，并让每次执行可重放。

### A 行动

我把执行分成 ask/analyze/build，Context Manager 按约束、目标、来源、工具和记忆排序，生成带 hash 的 context manifest。运行时记录输入快照、缺失上下文、工具调用和产物 manifest，超限时先压缩低优先级历史。

### R 结果

模型看到的上下文边界可解释，后续可以比较两次运行为什么结果不同。默认预算约 24,000 tokens，实际质量和成本仍需基准。

### 追问

- 相关性排序如何避免丢掉关键负面证据？
- manifest hash 与 job snapshot 不一致怎么办？
- 什么内容永远放在固定区？

## 故事 6：发布一个可验证的 Windows 便携包

### S 情境

本地项目依赖 Node、Python、浏览器和多个配置，直接把开发目录压缩给用户容易泄露隐私，也难保证能启动。

### T 任务

生成干净、可安装、可健康检查的 Windows 一键包。

### A 行动

release workflow 从 Git 已提交文件打包，排除 .git、依赖缓存、运行时数据、.env、Cookie、key 和个人资料。verify 脚本在临时目录解压，安装依赖、构建、启动并请求 health endpoint，最后清理并输出 SHA-256。

### R 结果

发布从“压缩目录”变为有 preflight、净化、安装和健康检查的流程。历史报告中有 one-click 和 MCP 的 dated 数字，但本轮没有重跑。

### 追问

- 为什么要从 Git committed files 打包？
- 运行时下载失败如何诊断？
- 如何保证首次启动不覆盖用户已有 profile？

## 故事 7：跨平台 KOL 数据归一化

### S 情境

抖音、小红书和 Bilibili 的账号、内容、互动字段不同，同一 creator 可能出现在多个搜索路线。

### T 任务

用统一 schema 支持去重、证据分析和后续建联。

### A 行动

我将 connector 输出拆成 platform identity、canonical profile、content item 和 evidence。以平台 id、规范 URL、handle 和内容键组合去重，保留来源 route 和时间。采集使用 checkpoint、受限并发、超时和重试，内容再进入 ASR/OCR/评论分析。

### R 结果

业务从平台字段拼接变成可扩展 adapter。当前 KOLFORGE 没有 Git provenance，真实规模和质量数字需要补证。

### 追问

- 跨平台同名账号如何避免误合并？
- 删除内容如何反映到历史证据？
- 平台限流时如何保证公平调度？

## 故事 8：承认并治理架构债务

### S 情境

为了快速交付，原生 HTTP 路由、任务逻辑和前端状态逐步集中到大文件。

### T 任务

保持当前可运行能力，同时给出可执行的拆分路径。

### A 行动

我先按 bounded context 画出认证、任务、投递、Copilot、MCP 边界，补充契约测试和事件 schema，再逐步把 route/controller、service 和 repository 拆出。拆分时保持 endpoint、状态和 artifact manifest 兼容。

### R 结果

风险从“文件太大”转化为可排序的重构队列：先拆高变更/高风险边界，再做跨语言契约和性能基准。当前 app.mjs、job-manager.mjs、App.tsx 仍是主要债务。

### 追问

- 先拆哪个模块，为什么？
- 如何避免拆分引入双写和循环依赖？
- 哪个指标能证明重构有效？
