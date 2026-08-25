# 可恢复任务与状态机

## 核心判断

采集任务不是“启动一个 Python 进程然后等结果”，而是一个有生命周期、尝试次数、版本、事件账本和可恢复点的 durable workflow。

## 状态模型

常见 job 状态：

- queued：已创建，等待 worker。
- running：当前 attempt 正在执行。
- interrupted：进程退出、外部边界中断或用户暂停。
- resumable：存在可信 checkpoint，可从中断点继续。
- failed：已知错误且当前 attempt 结束。
- completed：产物和质量门完成。
- cancelled：用户主动取消。

状态迁移由服务端拥有。UI 只能消费 snapshot、status、log、artifact、done 和 error 事件，不直接写枚举。

## 一次运行的持久化对象

| 对象              | 作用                               |
| ----------------- | ---------------------------------- |
| job               | 用户可见的业务任务                 |
| attempt           | 一次具体执行，支持重试和恢复       |
| revision          | 状态版本，防止旧 worker 覆盖新状态 |
| checkpoint        | 阶段边界、游标和最后确认输入       |
| event journal     | 带单调序号的状态/日志历史          |
| body ledger       | 请求级去重与正文完成守恒           |
| artifact manifest | 产物、来源、摘要和版本关系         |
| receipt           | 外部副作用的幂等结果               |

## 恢复流程

1. 启动时扫描未结束 job 和最近 attempt。
2. 读取 event journal、checkpoint、ledger 和 manifest。
3. 检查 process identity、revision 和输出完整性。
4. 将中断任务标成可恢复或明确失败。
5. 用户选择 resume 后创建新的 attempt，保留原历史。
6. Python 从 checkpoint 和 ledger 跳过已经确认的工作。
7. 新事件带新的 attempt/revision，旧 worker 写入会被 compare-and-swap 拒绝。

## 幂等策略

### 抓取

- 以来源 URL、note id、request id 或内容键去重。
- body ledger 记录 pending、partial、complete、failed 等阶段。
- 原子写入避免半个 JSON 覆盖完整状态。
- revision 校验防止并行 worker 互相覆盖。

### 外部发送

- 发送前生成 idempotency key 和 frozen payload。
- receipt 记录发送结果、时间、目标和动作摘要。
- 已知 receipt 的重复请求直接返回原结果。
- 发生未知副作用时进入 reconcile_required，由人确认真实外部状态。

## 安全验证 gate

安全验证、限流或登录失效出现时：

1. worker 报告结构化挑战事件。
2. 全局 gate 暂停新的并行请求。
3. 保留登录态、checkpoint、部分产物和当前游标。
4. 用户在原受管浏览器中处理登录/验证。
5. health check 通过后释放 gate。
6. 从 ledger 和 checkpoint 继续。

这是一种人机协作恢复设计，重点是保留上下文和避免重复工作。

## SSE 断线恢复

- 事件先进入持久化 JSONL journal。
- 每个事件带单调 sequence。
- 浏览器重连时发送 Last-Event-ID。
- 服务端从 journal 回放缺失事件，并检测 gap。
- 慢客户端达到 pending frame 上限时断开，防止内存无限增长。
- heartbeat 保持连接活跃，状态 snapshot 可作为重新对齐点。

## 可量化设计参数

这些是代码/设计中的运行参数，不是吞吐承诺：

- job journal tail 约 8 MiB
- 单任务内存事件约 2,000
- Copilot event buffer 约 5,000
- SSE slow-client pending frame 约 1,000
- heartbeat 约 15 秒
- durable worker 最大并发约 4
- 恢复扫描约每 15 秒
- 安全验证等待上限约 600 秒

## 高频追问

### 进程在写完文件但还没写状态时崩溃怎么办？

恢复器同时检查 checkpoint、manifest 和文件摘要。文件存在不代表阶段提交成功；只有状态版本、manifest 和产物互相匹配才推进，否则保留为 partial 并安排重建或人工确认。

### 两个 worker 同时恢复怎么办？

用 lease/process identity 和 revision compare-and-swap 限制 owner。失效租约需要重新获取，旧 worker 的写入带旧 revision，会被拒绝并记录冲突事件。

### 为什么不直接从头重跑？

因为正文补全、评论和外部调用可能昂贵、受限流影响且存在重复副作用。checkpoint/ledger 让恢复成本和外部压力可控。
