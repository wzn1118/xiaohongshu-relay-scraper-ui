# 事实与证据账本

面试前先看这一页。每条主张都有安全说法和证据等级，避免把设计目标、历史报告和当前运行混在一起。

| 主张                                                           | 等级                 | 证据位置                                                | 安全说法                                     |
| -------------------------------------------------------------- | -------------------- | ------------------------------------------------------- | -------------------------------------------- |
| 主仓库是 React/Node/Python 本地工作台                          | 当前已核验           | README.md、package.json、docs/ARCHITECTURE.md           | “当前仓库实现了……”                           |
| 主仓库 v3.0.0                                                  | 当前已核验           | package.json、tag v3.0.0、commit c56bec7                | “v3.0 主线包含……”                            |
| HEAD 是 1fa74a0                                                | 当前已核验           | git log                                                 | “当前审计时 HEAD 为……”                       |
| 工作树有约 81 条状态项                                         | 当前已核验           | git status                                              | “当前工作区存在未提交扩展……”                 |
| Data Copilot/MCP runtime 已在主线                              | 当前已核验           | e2c12f2、server/copilot、server/mcp                     | “主线有 Data Copilot/MCP 模块……”             |
| Codex browser/device/mirror 扩展已发布                         | 工作区实验           | 未跟踪/未提交文件                                       | “当前工作区正在开发……”                       |
| Node + Python 通过 JSON/event/checkpoint 协作                  | 当前已核验           | ARCHITECTURE.md、JobManager、workflow_state.py          | “跨运行时边界采用……”                         |
| 任务支持 queued/running/interrupted/resumable/completed 等状态 | 当前已核验           | ARCHITECTURE.md、JobManager                             | “状态模型包含……”                             |
| AI 使用 evidence、schema、validator 和独立 review              | 当前已核验           | ai_application_workflow.py、evidence_claim_validator.py | “代码路径设计为……”                           |
| AI 默认质量门约 90                                             | 当前已核验的设计参数 | 代码/设计文档                                           | “默认门槛约 90，不等于准确率 90%。”          |
| SSE 使用 journal、sequence 和 Last-Event-ID                    | 当前已核验           | app.mjs、event-log、transport                           | “实现了回放设计……”                           |
| MCP grant 绑定 snapshot/manifest/scope                         | 当前已核验           | mcp-access-service、production-store                    | “授权模型包含……”                             |
| 发布包排除 key/Cookie/profile                                  | 当前已核验           | release scripts/docs                                    | “发布脚本的排除规则包括……”                   |
| CI 使用 Node 22/Python 3.13                                    | 当前已核验           | .github/workflows/ci.yml                                | “CI 配置使用……”                              |
| 历史测试 221 Node、207 Python 等                               | 历史报告             | docs/PHASE10_FINAL_ACCEPTANCE.md                        | “2026-08-01 报告曾记录……”                    |
| 历史 MCP 7/7、one-click 5/5                                    | 历史报告             | docs/PUBLIC_RELEASE_VERIFICATION.md                     | “2026-08-10 报告曾记录……”                    |
| 715 岗位、4,062 评论、1,495 用户                               | 包内快照声明         | today-you-applied-portable/README                       | “便携包 README 描述的样例快照……”             |
| KOLFORGE 每平台 15,000 候选                                    | README 声称          | MKT大师/README.md                                       | “设计容量目标/README 声称……”                 |
| Asteria 362 方法、81 live                                      | 代码/README；浅克隆  | Asteria statistical_catalog.py、README                  | “当前快照中注册表包含……”                     |
| Asteria 4,028 卡、273 runnable 卡                              | README 声称          | Asteria README                                          | “README 记录……”                              |
| Asteria 是多租户 SaaS                                          | 反向事实             | docs/architecture.zh-CN.md                              | “当前定位是单机单用户，平台层隔离仍待补齐。” |
| Hegel 有 130 golden、114 概念                                  | 当前快照文件/JSON    | hegel eval and concept data                             | “当前快照包含……”                             |
| Hegel 已达到 90 分稳定质量                                     | 未验证声明           | PRODUCT.md                                              | “文档以 90 为优化目标；本轮无评测证明。”     |
| wechat-cli/wechat-decrypt 是原创项目                           | 外部来源             | remote URLs                                             | “外部源码阅读/二次实验……”                    |
| MKT大师有完整 Git provenance                                   | 缺失                 | 无 remote/commit                                        | “本地未版本化项目快照……”                     |
| 当前全量测试已通过                                             | 未运行               | 本轮只读                                                | “本轮没有运行全量测试。”                     |

## 数字使用规则

1. 每个数字带来源和日期。
2. 目标、上限、容量参数不称为实测吞吐。
3. 文件计数不称为代码质量或个人产出。
4. dated report 不与当前工作区自动等价。
5. 没有个人 commit 时，使用“参与/实现某模块”前先补贡献证据。

## 面试前的最小证据包

- 当前 HEAD、tag、branch、status 截图或命令输出。
- 个人负责模块的文件列表和 commit。
- 一次成功任务的脱敏 artifact manifest。
- 一次中断/恢复的 event journal 片段。
- 一次 AI validator 失败和重写的 fixture。
- 一次 Mailpit dry-run/receipt。
- 一次发布包净化和 health check 日志。
