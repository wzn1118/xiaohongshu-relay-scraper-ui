# 全项目事实百科索引

> 快照日期：2026-08-18（Asia/Shanghai）
> 用途：给 GPT 模拟面试、简历校准、系统设计追问和项目复盘提供可回查事实。
> 原则：先加载事实，再生成叙事；事实存在不等于个人独立完成，也不等于本轮运行验证通过。

语料规模、分区字节、行数和最大机械文件见[事实语料库统计与覆盖说明](./00_FACT_CORPUS_STATISTICS.md)。

## 1. 四种阅读入口

| 目标                 | 首选入口                                                                                        | 适合的问题                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 了解全部项目边界     | [全部 Git 根目录](./cross/01_ALL_GIT_ROOTS.md)                                                  | 一共有多少仓库、哪些是快照、哪些有 remote、哪些属于外部源码 |
| 深挖当前主仓库       | [XHS 提交基线事实库](./xhs/README.md) + [当前工作区清单](./main/04_WORKTREE_COMPLETE_STATUS.md) | 架构、API、状态机、AI、MCP、测试、发布、未提交实验          |
| 深挖本地未版本化项目 | [本地项目索引](./local/README.md)                                                               | KOLFORGE、便携版、飞书 Bot、亮度控件、早期 Relay 原型       |
| 深挖公开及外部源码   | [公开与外部仓库索引](./public-external/README.md)                                               | Asteria、Hegel、微信工具、Prompt/Skill 聚合仓库及归属边界   |

## 2. 事实分区

### 2.1 当前主仓库：提交基线

[XHS 穷尽式事实索引](./xhs/README.md)以提交 `1fa74a0` 为基线，重点回答“已经进入 Git 主线的内容是什么”。该分区包含完整提交历史、架构模块、API、脚本依赖、数据模型、AI Provider、Data Copilot/MCP、测试发布和工作区实验边界。

### 2.2 当前主仓库：机械清单

`main/` 是针对文件系统、Git、源码文字和配置的机械展开，适合精确检索：

| 文件                                                                              | 事实范围                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [01_GIT_COMPLETE_TIMELINE.md](./main/01_GIT_COMPLETE_TIMELINE.md)                 | 当前可见 103 条提交的日期、作者、哈希与主题           |
| [02_PACKAGE_SCRIPTS_DEPENDENCIES.md](./main/02_PACKAGE_SCRIPTS_DEPENDENCIES.md)   | 当前工作区 `package.json` 的脚本与直接依赖            |
| [03_TRACKED_FILE_MANIFEST.md](./main/03_TRACKED_FILE_MANIFEST.md)                 | 515 个 tracked 路径及当前大小/状态                    |
| [04_WORKTREE_COMPLETE_STATUS.md](./main/04_WORKTREE_COMPLETE_STATUS.md)           | 生成时点的 tracked 改动与未跟踪路径                   |
| [05_ENV_CONFIG_INVENTORY.md](./main/05_ENV_CONFIG_INVENTORY.md)                   | 显式环境变量名、示例位置及敏感值处理规则              |
| [06_RUNTIME_DEFAULTS_LIMITS.md](./main/06_RUNTIME_DEFAULTS_LIMITS.md)             | 端口、超时、并发、保留期和运行限制                    |
| [07_API_PATH_LITERAL_INVENTORY.md](./main/07_API_PATH_LITERAL_INVENTORY.md)       | 生产服务端出现的路由/路径字面量                       |
| [08_HTTP_ROUTE_CONDITIONS.md](./main/08_HTTP_ROUTE_CONDITIONS.md)                 | 当前 `server/app.mjs` 的精确与动态路由条件            |
| [09_PUBLIC_SYMBOL_INVENTORY.md](./main/09_PUBLIC_SYMBOL_INVENTORY.md)             | JS/TS 导出和 Python 顶层类/函数索引                   |
| [10_TEST_ASSET_MANIFEST.md](./main/10_TEST_ASSET_MANIFEST.md)                     | 测试相关文件、声明与资源；属于静态盘点                |
| [11_EXISTING_DOC_SOURCE_INDEX.md](./main/11_EXISTING_DOC_SOURCE_INDEX.md)         | 既有文档来源、标题、行数和 tracked 状态               |
| [12_SCRIPT_MANIFEST.md](./main/12_SCRIPT_MANIFEST.md)                             | `scripts/` 与相关工具脚本清单                         |
| [13_CI_RELEASE_EXACT_FACTS.md](./main/13_CI_RELEASE_EXACT_FACTS.md)               | GitHub Actions 的触发器、步骤、运行时与产物规则       |
| [14_COMMIT_CHANGE_STATS.md](./main/14_COMMIT_CHANGE_STATS.md)                     | 每条提交的文件数、增删行和顶层目录分布                |
| [15_GIT_REFS_AUTHORS.md](./main/15_GIT_REFS_AUTHORS.md)                           | 分支、远端引用、标签与作者 identity                   |
| [16_FRONTEND_API_PATHS.md](./main/16_FRONTEND_API_PATHS.md)                       | 前端源码中的 API 路径字面量                           |
| [17_FRONTEND_FILE_MANIFEST.md](./main/17_FRONTEND_FILE_MANIFEST.md)               | `src/` 文件、行数、导入导出与测试标记                 |
| [18_SERVER_FILE_MANIFEST.md](./main/18_SERVER_FILE_MANIFEST.md)                   | `server/` 文件、行数、导入导出与状态                  |
| [19_PYTHON_FILE_MANIFEST.md](./main/19_PYTHON_FILE_MANIFEST.md)                   | Python 脚本、测试与 vendor 文件清单                   |
| [20_LOCKED_DEPENDENCIES.md](./main/20_LOCKED_DEPENDENCIES.md)                     | Python 固定依赖与 `package-lock.json` 包版本          |
| [21_WORKFLOW_STATE_AND_LEDGER.md](./main/21_WORKFLOW_STATE_AND_LEDGER.md)         | Job/Stage/Resume/Lock/Ledger 的精确状态与守恒规则     |
| [22_AI_PROVIDER_AND_QUALITY_FACTS.md](./main/22_AI_PROVIDER_AND_QUALITY_FACTS.md) | AI Provider、超时、token、重试、Schema 与质量评分规则 |

### 2.3 本地项目

- [KOLFORGE / MKT 大师](./local/KOLFORGE_FACTS.md)
- [today-you-applied-portable](./local/PORTABLE_FACTS.md)
- [Playground 三个原型](./local/PLAYGROUND_FACTS.md)
- [空目录、个人主页与迁移工具](./local/EMPTY_AND_UTILITY_DIRS.md)

### 2.4 公开及外部源码

- [AsteriaAnalyst](./public-external/01_ASTERIA_ANALYST_FACTS.md)
- [hegel-salon](./public-external/02_HEGEL_SALON_FACTS.md)
- [wechat-cli](./public-external/03_WECHAT_CLI_EXTERNAL_FACTS.md)
- [wechat-decrypt](./public-external/04_WECHAT_DECRYPT_EXTERNAL_FACTS.md)
- [MDX Prompt 分发仓库](./public-external/05_MDX_PROMPT_REPO_EXTERNAL_FACTS.md)
- [GPT Skill 聚合源码树](./public-external/06_GPT_SKILL_AGGREGATE_EXTERNAL_FACTS.md)
- [公开/外部仓库横向事实矩阵](./public-external/07_CROSS_REPO_FACT_MATRIX.md)
- [公开/外部仓库面试表述边界](./public-external/08_INTERVIEW_CLAIM_BOUNDARIES.md)
- [公开与外部仓库总索引](./public-external/README.md)

### 2.5 跨项目事实

- [全部 Git 根目录](./cross/01_ALL_GIT_ROOTS.md)
- [公开 GitHub 元数据快照](./cross/02_PUBLIC_GITHUB_METADATA.md)
- [跨项目技术与交付矩阵](./cross/03_CROSS_PROJECT_TECH_MATRIX.md)
- [事实冲突、漂移与解释登记表](./cross/04_FACT_SOURCE_CONFLICTS.md)
- [GPT 分块加载与提问地图](./cross/05_GPT_LOADING_AND_QUERY_MAP.md)
- [全项目 Manifest、入口与自动化](./cross/06_ALL_PROJECT_MANIFESTS_ENTRYPOINTS.md)
- [全项目命令与直接依赖](./cross/07_ALL_PROJECT_COMMANDS_DEPENDENCIES.md)
- [全项目环境变量、端口与外部服务](./cross/08_ALL_PROJECT_ENV_PORTS.md)
- [XHS 同源仓库、linked worktree 与旧快照](./cross/09_XHS_SAME_ORIGIN_WORKTREES.md)

## 3. 统一证据标签

| 标签   | 含义                                                          | 适用表述                         |
| ------ | ------------------------------------------------------------- | -------------------------------- |
| `HEAD` | Git object 中的提交基线，可用 `git show <commit>:<path>` 复核 | “提交基线实现/定义/包含……”       |
| `W`    | tracked 文件相对 `HEAD` 的未提交修改                          | “当前工作区正在扩展……”           |
| `U`    | 未跟踪文件或目录                                              | “本地原型/实验/待纳入版本控制……” |
| `S`    | 本轮静态扫描、计数或文件系统快照                              | “2026-08-18 扫描发现……”          |
| `R`    | 仓库中已有的历史报告、日志或运行产物                          | “某日期的既有产物记录……”         |
| `D`    | README、设计文档、发布说明中的声明                            | “文档记录/目标口径是……”          |
| `LIVE` | 本轮从公开 API 获取的易变元数据                               | “查询时点显示……”                 |
| `EXT`  | remote 指向他人的仓库或个人贡献缺少提交证据                   | “外部源码研究/技术阅读……”        |

同一个数字可能同时出现不同标签。例如，测试文件数量属于 `S`，历史测试报告属于 `R`，CI 中定义的测试命令属于 `HEAD`，而“本轮测试通过”需要本轮真实执行记录。

## 4. 推荐给 GPT 的最小上下文

1. 始终先加载本文件和[事实冲突登记表](./cross/04_FACT_SOURCE_CONFLICTS.md)。
2. 再加载与问题直接相关的一个项目事实文件。
3. 涉及个人贡献时，额外加载[全部 Git 根目录](./cross/01_ALL_GIT_ROOTS.md)和项目的 Git/归属章节。
4. 涉及精确端点、状态或配置时，再加载 `main/` 中对应机械清单。
5. 生成回答时保留事实标签、日期和版本；对缺少运行证明的结果使用“代码定义”“文档记录”“历史产物”这类准确措辞。

## 5. 快照限制

- 当前主仓库原本就有 tracked 修改与未跟踪实验；本事实库本身也作为未跟踪文档写入工作区，因此不同时点的 `git status` 条目数会增长。
- 本地未版本化项目缺少可审计提交史，文件存在、运行产物和个人贡献是三类不同证据。
- 多个外部 checkout 是 shallow clone；本地可见提交数不是远端完整历史长度。
- 本轮事实扩展以静态审计为主，没有启动项目服务，也没有重跑采集、AI、SMTP、构建、测试或发布链。
- 环境变量盘点只记录变量名、默认值和示例位置；实际 secret 值不进入事实库。
