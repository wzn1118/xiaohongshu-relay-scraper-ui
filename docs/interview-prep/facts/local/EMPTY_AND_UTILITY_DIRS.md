# 空 Git 根目录、个人主页与迁移工具事实

> 快照时间：2026-08-18
> 范围：`Playground 2`、`Playground 3`、`本电脑`。
> 目的：说明哪些目录应排除项目经历，以及唯一工具脚本可保留的工程事实。

## 1. Playground 2（F2）

### 路径

`C:\Users\10847\Documents\Playground 2`

### 当前状态

- 目录存在。
- 只有 `.git` 目录，没有工作树文件和业务子目录。
- Git 分支名：`master`。
- `HEAD` 尚未创建，提交数 0。
- 远端为空。
- `git status --short --untracked-files=all` 返回 0 项。
- `.git/config` 只有标准 local repository core 配置：非 bare、filemode false、logallrefupdates true、symlinks false、ignorecase true。
- Git 元数据初始化时间为 2026-04-04 21:05:39 左右。

### 结论

这是空 Git 根目录，不是代码库或项目经历。面试项目总数不包含它。

## 2. Playground 3（F2）

### 路径

`C:\Users\10847\Documents\Playground 3`

### 当前状态

- 目录存在。
- 只有 `.git` 目录，没有工作树文件和业务子目录。
- Git 分支名：`master`。
- `HEAD` 尚未创建，提交数 0。
- 远端为空。
- `git status --short --untracked-files=all` 返回 0 项。
- `.git/config` 同样只有标准 local repository core 配置。
- Git 元数据初始化时间为 2026-04-05 18:25:29 左右。
- `.git/FETCH_HEAD` 存在、大小 0 bytes、时间为 2026-08-18 00:02:59；空 FETCH_HEAD 不构成远端或拉取内容证据。

### 结论

这是另一个空 Git 根目录，不是代码库或项目经历。面试项目总数不包含它。

## 3. 本电脑目录总览（F2）

### 路径

`C:\Users\10847\Documents\本电脑`

### Git 状态

- Git 根目录存在，分支 `master`。
- `HEAD` 尚未创建，提交数 0，远端为空。
- Git status 有 2 个未跟踪项：`README.md` 和 `migration/move-directory-to-junction.ps1`。
- 根目录没有 package manifest、构建配置、测试、CI、release 或运行数据。

### 目录判断

这不是一个产品仓库，而是“个人主页 README + 单文件 Windows 迁移工具”的临时 Git 根目录。项目面试总览中应排除为独立产品，但迁移脚本可以作为工程工具事实保留。

## 4. README 事实（F3）

`README.md` 是英文个人 GitHub profile 风格页面，标题为个人姓名，副标题是“AI Product Manager building useful products from user insight to working software”。

### 4.1 公开项目链接

README 链接三个公开项目：

- `AsteriaAnalyst`
- `xiaohongshu-relay-scraper-ui`（页面文案称 Hiring Intelligence Workbench）
- `hegel-salon`

这与本轮公开仓库盘点的三个仓库名称一致，但 README 所在目录自身没有远端和提交。

### 4.2 工作方式声明

README 将工作方式概括为：

- 从用户问题、访谈、调研和反馈开始。
- 设计输入、状态、异常、复核点、数据结构与输出的完整流程。
- AI 负责理解/规划，确定性引擎负责数字、规则、证据和发布门。
- PRD、信息架构、交互、前后端、评测、文档和部署在同一交付闭环中。

这些是自述定位（F3），可以作为自我介绍素材，但不属于独立代码证据。

### 4.3 Selected evidence 声明

README 列出以下履历数字：

- 数据监测工具每小时 50K+ 记录，累计 120K+ 社媒与竞品 signals。
- 访谈 520 名 foundation leaders，相关项目产生 RMB 4.1M 捐赠并新增 210 名成员。
- 25 场公开直播，平均 6,500 viewers，完成率提升 30%，观看时长提升 120%。
- 企业写作产品需求研究提炼 20+ 高频场景。
- Creator/user research 推动 completion rate 提升 77%，修复 5 个功能缺陷和 3 个 UI 问题。

本目录没有这些数字的原始报告、数据或外部证明，因此全部属于个人主页声明（F3/F5）。面试前应在工作经历、报告或原始数据中逐条建立证据，不从该 README 单独引用为已核验事实。

### 4.4 个人信息处理

README 还包含邮箱和所在地。本事实库不复制联系方式；模拟面试只需知道这是个人 profile 页面，不是项目源代码。

## 5. move-directory-to-junction.ps1（F1）

### 5.1 文件

- 路径：`C:\Users\10847\Documents\本电脑\migration\move-directory-to-junction.ps1`
- 大小：7,230 bytes。
- 行数：184。
- 函数：2 个。
- 必填字符串参数：`Source`、`Destination`、`LogDirectory`。
- 可选 switch：`MirrorExistingDestination`。

### 5.2 目的

脚本把 C 盘目录复制到 E 盘，验证一致性后将原路径替换为 Windows junction，从而释放 C 盘空间，同时让依赖原路径的程序继续访问目标内容。

### 5.3 路径防护

- 统一使用 `[System.IO.Path]::GetFullPath()` 并去除尾反斜杠。
- 通过 ordinal-ignore-case 前缀判断路径是否位于批准 root 内。
- Source 只允许位于 `C:\Users\10847` 下，另加一个精确批准源 `C:\symbols`。
- Destination 必须位于 `E:\` 下。
- 明确排除活动 Codex runtime `C:\Users\10847\.cache\codex-runtimes`。
- Source 必须存在且是目录。
- Source 已是 reparse point 时：若正好指向目标则返回 `AlreadyMigrated`；其他目标触发终止。
- Source 内存在 nested reparse point 时停止，交给人工处理。
- Destination 已存在时默认停止；只有 `MirrorExistingDestination` 才允许 mirror。
- Backup 路径再次验证仍在允许 root 内。

这些防护体现了对递归移动、路径逃逸、junction 链和活动运行时的显式控制。

### 5.4 复制与验证

- 创建 destination parent 和 log directory。
- 日志名包含 timestamp 与安全化目录名。
- 提前抓取一个 sample file 的相对路径，用于 junction 建立后的可达性检查。
- 统计 Source 文件数和总 bytes。
- `robocopy` 参数：`/COPY:DATS /DCOPY:DAT /XJ /R:2 /W:1 /MT:8 /J /NFL /NDL /NP`。
- 普通模式用 `/E`；`MirrorExistingDestination` 用 `/MIR`。
- Robocopy exit code 大于 7 视为失败。
- 第一次复制后再运行 `robocopy /L /MIR`，exit code 必须为 0，证明目标与源没有差异。
- 再比较 Source/Destination 文件数和总 bytes。

### 5.5 原路径切换和回滚

1. 使用 `[System.IO.Directory]::Move` 把 Source 同盘原子重命名为时间戳 backup，而不是逐文件 Move-Item。
2. 在原 Source 路径创建 junction，指向 E 盘 Destination。
3. 验证 LinkType、target 和 sample file 经 junction 可访问。
4. junction 创建/验证失败时，删除新 Source junction/path，再把 backup 原位恢复。
5. 成功后递归删除 backup。
6. 写 JSON result，并追加到 `migration-results.ndjson`。

输出包含 Timestamp、Status、Source、Destination、Files、FreedBytes 和 CopyLog。

### 5.6 优点

- 先复制、后双重比对、再切换路径。
- 路径 allowlist 和活动 runtime exclusion。
- 排除 junction 递归（`/XJ` + nested reparse check）。
- 同卷重命名 backup 提供回滚窗口。
- junction target 和 sample reachability 二次验证。
- 结构化 JSON/NDJSON 审计结果。
- 有界 retry，失败时保留源或恢复源。

### 5.7 风险与边界

- `MirrorExistingDestination` 使用 `/MIR`，可能删除目标中 Source 不存在的内容；调用方必须明确目标目录归属。
- 文件数和总 bytes 相同不等于逐文件 hash 相同；robocopy mirror dry-run提供元数据级补充，但不是内容哈希验证。
- 删除 backup 失败时 junction 已经激活，脚本会报出“迁移生效但 backup 尚存”的中间状态，需要后续清理。
- 日志目录由调用方传入，虽会创建，但没有单独限制到固定 root。
- 精确批准 `C:\symbols` 与用户 profile 规则是当前机器专用配置，跨机器需要参数化。
- 文件正在写入时，复制与最终 rename 之间存在变化窗口；脚本没有冻结写入方或做 VSS snapshot。
- 没有 Pester 测试、dry-run switch 或 checksum 模式。

## 6. 面试归类

| 目录/文件                        | 是否列为项目 | 推荐归类                                      |
| -------------------------------- | ------------ | --------------------------------------------- |
| `Playground 2`                   | 否           | 空目录                                        |
| `Playground 3`                   | 否           | 空目录                                        |
| `本电脑/README.md`               | 否           | 个人 profile 内容来源                         |
| `move-directory-to-junction.ps1` | 不单列产品   | Windows 运维/磁盘迁移工具，可作为工程细节补充 |

## 7. 适合的面试表达

这段工具事实适合回答“你如何处理有破坏性的本地文件操作”或“如何设计可回滚迁移”：

- 先限定 source/destination root。
- 识别 reparse point 与活动 runtime。
- 复制后用 mirror dry-run、数量和字节数验收。
- 同盘 rename 保留回滚副本。
- 建 junction 后验证 target 与样本可达性。
- 成功后清理 backup 并写结构化审计日志。

应同时主动提出改进：加入 dry-run、逐文件 hash/抽样 hash、写入方冻结、Pester fixture 和跨机器路径参数化。
