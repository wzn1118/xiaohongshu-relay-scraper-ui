# 面试前补证清单

## P0：必须先确认

| 任务                                  | 目的                         | 建议证据                            |
| ------------------------------------- | ---------------------------- | ----------------------------------- |
| 写出个人贡献矩阵                      | 区分设计/实现/测试/发布/协作 | 文件、commit、PR、任务记录          |
| 记录当前 Git status、HEAD、tag        | 区分 v3.0 与工作区实验       | git status、git log、git show       |
| 运行一次主项目最小健康检查            | 证明当前入口可用             | npm run build、health response      |
| 运行一次 mock runner 恢复             | 证明恢复回答有实物           | event journal、checkpoint、artifact |
| 运行一次 AI validator fixture         | 证明 evidence 门不是口号     | 输入、失败原因、重写结果            |
| 生成一份脱敏 release package manifest | 证明发布排除规则             | 文件清单、SHA-256、扫描输出         |

## P1：建议补齐

| 任务                                          | 目的                       |
| --------------------------------------------- | -------------------------- |
| 记录 JobManager 的状态转移和错误码            | 回答状态机追问             |
| 记录 SSE 断线/回放日志                        | 回答 Last-Event-ID         |
| 用 Mailpit 做 dry-run/approve/send/重复请求   | 回答副作用和 receipt       |
| 用临时 SQLite 检查 grant TTL、scope 和 revoke | 回答 MCP 安全              |
| 给 KOLFORGE 建最小 Git 仓库或导出变更清单     | 建立本地项目 provenance    |
| 给便携版记录首次启动耗时和失败原因            | 区分设计目标与实际效果     |
| 给 Asteria 跑方法 registry 盘点命令           | 固化 362/81 的来源         |
| 给 Hegel 跑 understanding smoke               | 区分 golden 数量和评测结果 |

## P2：有时间再做

- 大任务内存和事件日志增长基准。
- Python/Node 契约版本迁移测试。
- Relay 断开、模型超时、SQLite 锁和 SMTP unknown 的故障注入。
- 真实脱敏数据的 evidence coverage 评测。
- KOLFORGE 多平台误合并/重复率评测。
- Asteria 缺失值、统计前提和 PDF 版式回归。
- Hegel 引文断行、OCR、翻译变体的 false positive/negative。

## 每次回答前的检查

1. 这条是当前代码、历史报告、README 目标还是个人推论？
2. 能指出文件、commit、命令、日志或日期吗？
3. 是否把快照数量说成生产指标？
4. 是否把外部 remote 代码说成原创？
5. 是否说明了失败路径和下一步？
