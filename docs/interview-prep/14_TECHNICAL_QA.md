# 技术面试问答

回答格式建议：先给结论，再给数据流/状态，再给失败路径，最后给取舍和证据路径。

## 架构与运行时

### Q1：为什么采用 Node + Python？

A：Node 更适合本地服务、SSE、任务生命周期、权限和外部动作边界；Python 的 Playwright、OCR、表格/PDF 和统计生态更成熟。两者不共享隐式内存，而是通过 JSON、事件、状态、checkpoint 和 artifact manifest 协作。代价是跨语言契约和错误映射更复杂，因此需要 fixture 与 contract test。

### Q2：为什么没有使用 Express？

A：项目初期追求少依赖、可打包和本地独立运行，原生 http 足够。随着 app.mjs 变大，路由拆分成为明确的下一步；我会先按认证、任务、投递、Copilot、MCP 拆 controller，再保留统一错误和审计中间层。

### Q3：组合根为什么重要？

A：server/index.mjs 集中初始化 store、provider、worker、MCP、Copilot 和 shutdown，便于确认依赖关系、替换 fake 实现和管理生命周期。代价是文件容易膨胀，需要进一步下沉到 bounded context factory。

### Q4：为什么 JSON 和 SQLite 并存？

A：任务与产物需要用户可见、可复制和易恢复，JSON/目录更适合；运行时执行、grant、lease、幂等和事件查询需要事务与唯一约束，SQLite WAL 更适合。关键是规定 ownership：文件是业务产物真相，SQLite 是 runtime 执行真相，两者通过 revision、snapshot 和 manifest hash 关联。

### Q5：任务目录如何设计？

A：按 job/attempt/revision 组织，分别保存 state、event journal、checkpoint、ledger、source 和 artifact manifest。目录名和 manifest 不承载秘密；恢复时校验文件摘要和状态版本。

## 可恢复性与并发

### Q6：如何避免重复抓取？

A：使用 request id、内容键、body ledger、revision CAS 和 artifact manifest。pending/partial/complete/failed 明确记录处理阶段；恢复时只重试未确认或校验失败的条目。

### Q7：并行 worker 如何协调？

A：使用 lease/process identity、受限并发和 revision。worker 领取任务后定期续租，失效后由恢复器接管；旧 worker 写入旧 revision 会被拒绝，避免覆盖新状态。

### Q8：进程在副作用之后退出怎么办？

A：把执行分为 prepare、invoke、confirm。幂等工具可依据 execution key 重查；SMTP 等未知副作用进入 reconcile_required，保留请求摘要和 receipt 查询信息，人工确认后再决定后续动作。

### Q9：为什么安全验证后暂停整个 gate？

A：继续并发请求会扩大封禁和重复压力，也会让 checkpoint 失去清晰边界。全局 gate 停止新请求，保留部分结果，让用户在原浏览器处理后再释放。重点是恢复设计，不是绕过验证。

### Q10：怎样定义阶段完成？

A：阶段必须同时满足业务状态、输入游标、产物 manifest、摘要/格式检查和事件提交。只看到一个文件存在不代表阶段提交完成。

## SSE 与实时通信

### Q11：SSE 断线如何处理？

A：事件先写 durable journal，带单调 sequence；客户端保存 Last-Event-ID，重连后回放缺口，再以最新 snapshot 对齐。对慢客户端设置 pending frame 上限，heartbeat 保持连接。

### Q12：如何防事件重复导致 UI 错误？

A：事件 id/sequence 幂等，前端按 sequence 去重；UI 把 snapshot 视为当前状态，把 event 作为增量展示。对重复事件只更新日志位置，不重复执行业务动作。

### Q13：为什么不用 WebSocket？

A：任务状态主要是服务端到浏览器的单向流，SSE 有浏览器重连和 Last-Event-ID 语义，接入简单。双向 Copilot/tool control 仍通过普通 HTTP/MCP 请求完成。若未来需要高频双向交互，再评估 WebSocket。

## AI 与证据

### Q14：如何减少模型幻觉？

A：结构化 schema 限制输出形状，evidence id 和 source span 限制事实范围，确定性 validator 检查数字/来源/格式，独立 reviewer 检查可执行性，低分结果限次重写并停在草稿层。

### Q15：为什么 reviewer 要独立？

A：同一个模型既生成又自评会共享错误假设。独立角色、不同提示和确定性规则可以增加错误发现概率；最终仍保留人工确认。

### Q16：来源本身不可靠怎么办？

A：证据绑定解决可追溯，不自动保证来源真实。系统应保留来源时间、链接、抓取上下文和冲突项；对关键动作增加人工核验和 freshness 检查。

### Q17：模型 provider 如何替换？

A：统一 provider runtime，适配 Ollama、Codex CLI 和 OpenAI-compatible Chat/Responses API，统一 timeout、retry、schema、错误分类和 vision fallback。上层只消费结构化结果和 provider metadata。

### Q18：上下文预算怎么做？

A：Context Manager 按约束、目标、用户指定来源、当前快照、工具 schema、最近对话和记忆排序，超限压缩低优先级部分，并记录缺失上下文。manifest hash 让运行可复盘。

## MCP 与安全

### Q19：MCP grant 如何防越权？

A：grant 绑定 owner、job/conversation、snapshot、manifest hash、scope、tool、risk 和 TTL；token 只存 peppered hash；调用校验 Origin、来源、租约、并发、速率、输出和审批。

### Q20：为什么高风险工具需要 approval？

A：读取和分析通常可自动化，发送邮件、修改文件或触发外部动作具有副作用。approval 绑定 action hash 和冻结 payload，避免用户批准的内容在执行前被替换。

### Q21：MCP 与普通 API 的边界？

A：普通 API 面向本地 UI，会话/CSRF 语义不同；MCP 面向外部 client，需 Bearer grant、session 和 DNS rebinding 防护。独立 listener 简化隔离和审计。

### Q22：MCP 事件与任务事件如何关联？

A：工具执行写入 runtime event 和 durable receipt，业务产物通过 snapshot/manifest 关联到 job。不要把外部客户端的事件直接当成业务状态提交。

## 测试与发布

### Q23：如何测试跨 Node/Python 协议？

A：固定输入目录和 JSON schema，使用 mock runner 产生成功、失败、取消、部分完成和脏输出，Node 只按公开契约消费；测试状态、事件、manifest、resume 和错误映射。

### Q24：如何测试未知 SMTP 副作用？

A：Mailpit 验证已知成功、重复发送、超时和 receipt；真实 SMTP 只在隔离环境中做少量 smoke。未知状态必须进入 reconcile_required，并提供可查证据。

### Q25：发布包为什么需要干净目录验证？

A：开发目录有依赖、缓存、环境和个人数据，直接压缩不足以证明可安装。干净目录验证能发现漏文件、端口、路径、权限和首次启动问题。

### Q26：当前最重要的技术债务？

A：大文件、双存储一致性、外部边界测试和未提交 runtime 扩展。优先补 route/controller 拆分、跨语言 contract、故障注入、性能基准和清晰 package boundary。
