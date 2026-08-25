# 面试术语表

| 术语                   | 本项目含义                              | 追问关键词                   |
| ---------------------- | --------------------------------------- | ---------------------------- |
| Relay                  | 受管浏览器与 Node/Python 之间的连接边界 | token、CDP、health、profile  |
| CDP                    | Chromium DevTools Protocol              | target、page、隔离 profile   |
| job                    | 用户可见业务任务                        | lifecycle、artifact、resume  |
| attempt                | 一次具体执行尝试                        | retry、process identity      |
| revision               | 状态版本                                | compare-and-swap、冲突       |
| checkpoint             | 可恢复阶段的游标/边界                   | atomic、resume               |
| ledger                 | 请求或正文完成账本                      | dedupe、conservation         |
| event journal          | 带序号的持久化事件历史                  | replay、gap、Last-Event-ID   |
| snapshot               | 某一时刻的数据视图                      | scope、hash、reproducibility |
| manifest               | 输入/输出/上下文的目录                  | artifact、hash、version      |
| evidence id            | 来源记录的稳定标识                      | source span、freshness       |
| source span            | 来源中的可定位片段                      | quote、数字、追溯            |
| quality gate           | 推进到下一阶段的条件集合                | deterministic、manual        |
| reviewer               | 独立审阅 AI 产物的角色                  | bias、feedback               |
| context manager        | 在预算内选择上下文                      | relevance、compression       |
| durable execution      | 可恢复、可重试、可审计的执行            | lease、receipt               |
| lease                  | worker 临时拥有执行权                   | expiry、takeover             |
| receipt                | 外部动作的确认记录                      | idempotency、reconcile       |
| reconcile_required     | 外部副作用状态未知                      | SMTP、人工核对               |
| grant                  | MCP 受限授权                            | owner、scope、TTL            |
| approval               | 高风险动作的显式批准                    | action hash、freeze          |
| MCP                    | 面向 agent/client 的工具协议            | listener、session、tool      |
| SQLite WAL             | runtime 的事务和并发日志模式            | lock、unique、recovery       |
| dry-run                | 只生成动作预览，不执行副作用            | recipient、attachment        |
| freeze                 | 冻结待执行 payload                      | hash、approval               |
| portable package       | 含 runtime/launcher 的交付包            | clean install、health        |
| connector              | 平台适配器                              | search/profile/content       |
| canonical identity     | 跨路线/平台的规范账号键                 | dedupe、merge                |
| deterministic executor | 不依赖模型随机性的计算器                | reproducibility              |
| release gate           | 正式报告/发布包的验收门                 | artifact、health             |
| golden dataset         | 用于评测的固定样本                      | judge、regression            |
| local agent            | 本地执行浏览器/桌面能力的受控客户端     | public deployment            |

## 不要混淆

- checkpoint 是恢复边界，receipt 是外部副作用结果。
- snapshot 是输入视图，manifest 是输入/输出目录。
- quality gate 是工程门槛，准确率是业务指标。
- catalog 是可展示方法目录，live/runnable 是可执行状态。
- 本地快照是文件状态，Git provenance 是可审计历史。
