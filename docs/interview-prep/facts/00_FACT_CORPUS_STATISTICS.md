# 事实语料库统计与覆盖说明

> 统计时点：2026-08-18，统一 Prettier 格式化之后。
> 统计源集：本文件创建前的 56 份 `facts/**/*.md`；因此下表不把本文件自计入。创建后，事实层共有 57 份 Markdown。
> 统计用途：判断 GPT 分块加载策略和覆盖范围，不用于推导代码质量、生产规模或个人贡献。

## 1. 语料规模

| 指标                   | 56 份源事实文件 |
| ---------------------- | --------------: |
| UTF-8 bytes            |       3,175,220 |
| 文本行                 |          13,218 |
| Markdown 标题          |             749 |
| 表格格式行             |           6,488 |
| Markdown 相对/外部链接 |             155 |
| 代码围栏标记           |             104 |

“表格格式行”是匹配首尾竖线的 Markdown 行数，包含表头和分隔线，不等于事实条目数。“代码围栏标记”包含开始与结束标记。

## 2. 分区统计

| 分区                     | 文件数 |         Bytes |       行数 | 主要内容                                                                       |
| ------------------------ | -----: | ------------: | ---------: | ------------------------------------------------------------------------------ |
| `facts/` 根              |      1 |        10,410 |        112 | 全事实索引                                                                     |
| `facts/cross/`           |      9 |       160,240 |      2,436 | Git 根、公开元数据、技术矩阵、冲突、加载地图、manifest/命令/env、同源 worktree |
| `facts/local/`           |      5 |       100,417 |      1,868 | KOLFORGE、便携版、Playground、空目录与本地证据规则                             |
| `facts/main/`            |     22 |     2,559,914 |      5,246 | 当前主仓库的机械清单与精确配置                                                 |
| `facts/public-external/` |      9 |       164,948 |      1,849 | Asteria、Hegel、微信工具、Prompt/Skill 聚合及归属边界                          |
| `facts/xhs/`             |     10 |       179,291 |      1,707 | XHS 提交基线与工作区的 596 个唯一编号事实                                      |
| **合计**                 | **56** | **3,175,220** | **13,218** | 不含本统计页                                                                   |

## 3. 最大的机械事实文件

| 文件                                                                                       |     Bytes |  行数 | 体量原因                                             |
| ------------------------------------------------------------------------------------------ | --------: | ----: | ---------------------------------------------------- |
| [05_ENV_CONFIG_INVENTORY.md](./main/05_ENV_CONFIG_INVENTORY.md)                            | 1,712,863 |   414 | 每个环境变量及其全部源码位置；长来源单元格占主要字节 |
| [09_PUBLIC_SYMBOL_INVENTORY.md](./main/09_PUBLIC_SYMBOL_INVENTORY.md)                      |   383,100 | 1,668 | 1,638 个 JS/TS export 与 Python 顶层 class/function  |
| [03_TRACKED_FILE_MANIFEST.md](./main/03_TRACKED_FILE_MANIFEST.md)                          |    72,633 |   605 | 515 个 tracked 路径及大小/状态                       |
| [16_FRONTEND_API_PATHS.md](./main/16_FRONTEND_API_PATHS.md)                                |    70,608 |    81 | 前端 API 字面量及全部引用位置                        |
| [20_LOCKED_DEPENDENCIES.md](./main/20_LOCKED_DEPENDENCIES.md)                              |    52,605 |   280 | Python 固定依赖与 245 个 lockfile package entry      |
| [10_TEST_ASSET_MANIFEST.md](./main/10_TEST_ASSET_MANIFEST.md)                              |    40,481 |   288 | 260 个测试相关文件/fixture/artifact 静态条目         |
| [07_API_PATH_LITERAL_INVENTORY.md](./main/07_API_PATH_LITERAL_INVENTORY.md)                |    37,106 |   107 | 生产服务端路径字面量及位置                           |
| [07_ALL_PROJECT_COMMANDS_DEPENDENCIES.md](./cross/07_ALL_PROJECT_COMMANDS_DEPENDENCIES.md) |    34,512 |   466 | 12 个逻辑项目的命令与直接依赖                        |
| [PORTABLE_FACTS.md](./local/PORTABLE_FACTS.md)                                             |    33,913 |   625 | 便携项目代码、API、命令、CI、产物和漂移事实          |
| [18_SERVER_FILE_MANIFEST.md](./main/18_SERVER_FILE_MANIFEST.md)                            |    33,194 |   260 | 229 个 server JS/MJS 文件的机械清单                  |

这些大文件适合作为检索索引，在追问具体配置、符号或路径时按需加载。固定塞进每轮模拟面试会挤占上下文，并提高不同分母串线的概率。

## 4. 覆盖对象

- 12 个逻辑项目：XHS、KOLFORGE、today portable、飞书 Bot、亮度控件、Playground scraper、Asteria、Hegel、wechat-cli、wechat-decrypt、MDX Prompt、GPT Skill 聚合树。
- `C:\Users\10847\Documents` 主扫描中的 15 个 Git 工作目录/根路径。
- `.codex-tmp/interview-repo-audit` 中 2 个公开仓库 shallow audit clone。
- 当前 XHS Git common directory 登记的 2 个额外 detached worktree。
- 当前主仓库 103 条可见提交、515 个 tracked 路径、22 个当前 tracked 修改，以及两个时间点的未跟踪工作区实验快照。
- XHS 提交基线 42 个 npm scripts与当前工作区 54 个 scripts。
- 当前工作区前后端路由、公开符号、环境变量名、运行默认值、状态机、ledger、CI、release 和测试资产。
- 本地未版本化项目的 manifest、入口、端口、命令、依赖、历史产物和 Git 归属缺口。
- 公开/外部源码的 remote、shallow 状态、入口、API/MCP、测试/CI、复现断点、许可和部署边界。

## 5. 数字口径提示

| 数字          | 准确含义                                                                  |
| ------------- | ------------------------------------------------------------------------- |
| 596           | `facts/xhs/` 中唯一编号事实，不是全部语料的句子数                         |
| 103           | 当前主仓库完整 clone 对 `HEAD` 可达的提交数                               |
| 515           | 当前主仓库 tracked 路径数，不是手写源码文件数                             |
| 1,638         | 静态抽取的公开 symbol 条目数，包含不同语言与文件类型                      |
| 42 / 54       | XHS `HEAD` / 当前工作区 `package.json` 的 script 数                       |
| 264 / 268     | 两个静态扫描时点/抽取范围的显式环境变量名称数；后一扫描包含新增 TURN 配置 |
| 260           | 测试相关文件与资产的静态清单分母，不是 test case 通过数                   |
| 362 / 81 / 18 | Asteria 注册方法 / `live` 方法 / family 的代码静态计数                    |
| 4,028 / 273   | Asteria README 的 method cards / runnable cards 声明，本轮没有重跑生成器  |
| 130           | Hegel understanding golden 条目数，不是当前 pass 数                       |

更多冲突解释见[事实冲突、漂移与解释登记表](./cross/04_FACT_SOURCE_CONFLICTS.md)。

## 6. GPT 加载建议

1. 固定加载[事实百科总索引](./README.md)、[冲突登记表](./cross/04_FACT_SOURCE_CONFLICTS.md)和[加载地图](./cross/05_GPT_LOADING_AND_QUERY_MAP.md)。
2. 每轮只追加一个项目事实文件和一个主题机械清单。
3. 符号、环境变量、lockfile、tracked manifest 只在定位精确证据时加载。
4. 让 GPT 为每个精确数字输出项目、日期、版本、分母与证据标签。
5. 项目代码能力、运行结果和候选人个人贡献始终分成三列核验。
