# 跨项目技术与交付矩阵

> 快照日期：2026-08-18。
> 本表用于横向检索，不替代各项目的证据明细。版本号与数量优先采用同目录事实文件中的当前快照；个人 ownership 仍需候选人确认。

## 1. 产品与架构横向表

| 项目/对象                  | 产品或研究对象                                           | UI                                                | 服务与编排                                                | 数据/AI/集成                                                            | 存储与产物                                                             | 交付/验证证据                                                                      |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| XHS Relay 数据工作台       | 小红书采集、正文补全、分析、受众研究、投递、Data Copilot | React 19、TypeScript、Vite                        | Node ESM HTTP API、JobManager、SSE；Python 阶段工作流     | Browser Relay/CDP、AI Provider、SMTP、MCP、Codex 工作区实验             | JSON/JSONL、artifact 目录、SQLite Copilot                              | GitHub Actions、Playwright、Mailpit、Windows ZIP、tag release                      |
| KOLFORGE / MKT 大师        | 小红书/抖音/B 站 KOL 研究、视频证据、报告和会话取证      | React/Vite                                        | Node ESM API；Python/Node 采集与分析脚本                  | Browser Relay、平台适配器、OCR/ASR、报告 Agent、MCP                     | 本地任务、campaign、output、证据与报告；当前 output 体量较大           | 本地测试资产和历史结果存在；目录本身 0 commit、0 remote                            |
| today-you-applied-portable | 求职研究与投递工作台的 Windows 便携快照                  | React 19、TypeScript、Vite 6                      | Node API、Python 多阶段工作流                             | 浏览器 Relay、AI、邮件与研究链路                                        | 本地 JSON/JSONL、任务与便携运行目录                                    | 启动器、CI/release 定义、Playwright 状态产物；目录本身 0 commit、0 remote          |
| AsteriaAnalyst             | 本地企业数据分析、统计实验、管理报告与修订               | Next.js 16、React 19、TypeScript、ECharts、Monaco | FastAPI、Pydantic、服务层编排                             | AI 语义映射/路由/指标规划；Pandas/DuckDB/Statsmodels/sklearn 确定性计算 | trace JSON、CSV、报告 session、PDF/HTML/MD                             | 70 个 pytest 文件；CI 含后端、前端、Windows portable smoke、release                |
| hegel-salon                | 中文黑格尔阅读、语料检索、引文纪律与多轮质量审阅         | 原生 HTML/CSS/JS                                  | Node 22 ESM、原生 HTTP/HTTPS，聊天编排集中于 `server.mjs` | OpenAI、概念图、自定义检索、引文校验、多 judge、CDP 浏览器代理          | `node:sqlite`、用户/style runtime scope、语料、日志与 optimizer memory | Docker/Compose、Render、Windows launcher、Android Capacitor；仓库无 GitHub Actions |
| 飞书 OpenAI Bot            | 飞书消息接入与连续对话                                   | 飞书客户端                                        | FastAPI webhook/service                                   | OpenAI Responses API、`previous_response_id`                            | SQLite 去重与会话指针                                                  | Playground 本地原型，无独立 Git 历史                                               |
| 外接显示器亮度控件         | Windows 显示器亮度调节                                   | PowerShell WinForms                               | 单实例桌面脚本                                            | DDC/CI、Win32 P/Invoke                                                  | 本地设置与启动项                                                       | Playground 本地原型，无独立 Git 历史                                               |
| Playground XHS Scraper     | 早期小红书 Relay 采集与导出                              | CLI/脚本为主                                      | Python、Playwright/CDP                                    | 卡片缓存、断点恢复、正文抽取                                            | JSON、CSV、XLSX、manifest/lineage                                      | 存在多阶段产物；不同 latest 文件需要按 manifest 分别解释                           |
| wechat-cli                 | 外部微信本地数据研究 CLI                                 | CLI                                               | Python 包与命令行                                         | 跨平台密钥发现、数据库解密/导出                                         | SQLite/SQLCipher 相关本地文件与导出                                    | 外部 shallow checkout，当前工作树干净                                              |
| wechat-decrypt             | 外部微信数据解密与实时查看工具                           | Web/CLI                                           | Python 服务、SSE、MCP                                     | 实时监视与数据库处理                                                    | 解密输出、服务状态                                                     | 外部 shallow checkout；监听/认证边界需在部署时说明                                 |
| MDX prompt 仓库            | Prompt 分发、评测与 Codex 配置切换                       | 文档/脚本                                         | Python/配置脚本                                           | Prompt、Pages、评测归档                                                 | Markdown、配置、归档                                                   | 两份重复 shallow checkout；复现完整性以外部事实文件为准                            |
| GPT Skill 聚合源码树       | Skill、插件、MCP 与安全研究素材聚合                      | 文档/目录树                                       | 多种脚本与配置                                            | Skills、Burp MCP、CTF/逆向研究目录                                      | 聚合文件树                                                             | 外部 remote，当前 checkout 有删除/缓存状态；不列为原创主项目                       |

## 2. 语言与框架覆盖

| 技术面                         | 有直接代码证据的项目                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| React/Vite                     | XHS、KOLFORGE、today-you-applied-portable                                     |
| Next.js                        | AsteriaAnalyst                                                                |
| TypeScript                     | XHS、today-you-applied-portable、Asteria 前端                                 |
| Node.js ESM                    | XHS、KOLFORGE、hegel-salon                                                    |
| Python/FastAPI                 | XHS 工作流、Asteria 后端、飞书 Bot、微信工具                                  |
| SQLite                         | XHS Data Copilot、hegel-salon、飞书 Bot、微信数据工具                         |
| Browser Relay/CDP/Playwright   | XHS、KOLFORGE、today portable、hegel browser agent、Playground scraper        |
| LLM structured output / schema | XHS、Asteria、KOLFORGE；Hegel 另有 judge 与规则审阅链                         |
| SSE                            | XHS Job/Revision、Asteria Revision、wechat-decrypt                            |
| MCP                            | XHS Data Copilot、wechat-decrypt、聚合源码树；工作区还含 Codex transport 原型 |
| Windows 便携交付               | XHS、today portable、Asteria                                                  |
| PowerShell/Win32               | Windows 启动器、打包脚本、外接显示器亮度控件                                  |

## 3. 当前可确认的默认端口

| 对象                    | 端口/地址                | 证据语境                                                   |
| ----------------------- | ------------------------ | ---------------------------------------------------------- |
| XHS 主应用              | `127.0.0.1:4317`         | 提交基线默认应用地址                                       |
| XHS 独立 MCP            | `127.0.0.1:4328`         | 提交基线 loopback 监听默认值                               |
| XHS CI Mailpit SMTP/Web | `1025` / `8025`          | CI service 配置                                            |
| KOLFORGE API            | `8787` 或示例环境 `8798` | 代码默认、README、示例环境和旧日志存在多口径，详见冲突登记 |
| KOLFORGE Browser Relay  | `18800`                  | 通用 Relay 默认值                                          |
| KOLFORGE 抖音 Relay     | `18801`                  | 平台专用 Relay 默认值                                      |
| hegel-salon             | `3087`                   | README/服务默认入口                                        |
| wechat-decrypt          | `0.0.0.0:5678`           | 外部源码当前默认；暴露面大于 loopback                      |

端口表只回答源码/配置默认值。实际启动地址还会受环境变量、占用回退、启动器和部署平台影响。

## 4. 测试与交付证据分层

| 项目                       | 静态测试资产                                                               | 自动化/交付定义                                           | 本轮执行状态                                     |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| XHS                        | Node test、Python test、Playwright、fixture 与脚本资产                     | Linux/Windows CI、Mailpit、portable ZIP、tag release      | 本轮只做静态盘点                                 |
| KOLFORGE                   | 53 个测试文件及历史测试状态/日志                                           | 本地脚本与报告链                                          | 本轮只读；历史日志记录部分通过，不升级为当前结果 |
| today portable             | 103 个测试代码文件和既有 Playwright 状态文件                               | 便携构建、CI/release 定义                                 | 本轮只读；既有状态文件属于历史产物               |
| Asteria                    | 70 个 `test_*.py` 文件，前端 lint/build/method-guide 校验                  | 四类 CI job、Windows portable smoke、tag release          | 本轮只读浅克隆，没有重跑                         |
| hegel-salon                | 130 条 understanding golden、stress/graph/optimizer 脚本；Android 模板测试 | Docker/Render/Windows/Android 交付文件；无 GitHub Actions | 本轮只读浅克隆，没有重跑                         |
| 外部微信/Prompt/Skill 仓库 | 以各自事实文件的静态资产为准                                               | remote/README/脚本仅证明定义存在                          | 本轮没有安装依赖或执行链路                       |

## 5. 数据与数字的使用规则

1. 代码文件数、路由数、方法数、测试文件数属于静态规模事实，不直接代表质量、覆盖率或生产性能。
2. 本地 `output`、日志、SQLite、截图和报告只证明某次运行留下产物；需要日期、版本和 lineage 才能组合为同一次验收。
3. README 中的用户量、记录量、质量分和方法卡数量保留为文档口径，除非本轮代码计数或产物另行验证。
4. GitHub stars、forks、issues、更新时间属于易变公开元数据，应同时携带查询日期。
5. shallow clone 的本地提交数只代表当前可见历史。

## 6. 详细证据入口

- [事实百科总索引](../README.md)
- [XHS 提交基线事实库](../xhs/README.md)
- [本地项目事实库](../local/README.md)
- [公开及外部仓库事实库](../public-external/README.md)
- [全部 Git 根目录](./01_ALL_GIT_ROOTS.md)
- [事实冲突登记表](./04_FACT_SOURCE_CONFLICTS.md)
