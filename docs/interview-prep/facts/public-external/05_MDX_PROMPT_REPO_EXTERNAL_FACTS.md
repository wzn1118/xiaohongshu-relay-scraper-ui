# MDX gpt-5.6-instruct 外部源码事实档案

> 面试定位：**外部 prompt 分发与评测工程研究对象**。可讨论归档完整性、Codex 配置切换、评测证据可复现性、静态站点发布和供应链审计；prompt 内容与仓库成果不应作为个人原创。

证据标签：[当前代码事实]、[README 声明]、[历史快照]、[外部源码]、[未验证]；[历史快照] 用于旧哈希、旧结果与当前 artifact 的时间点差异。

## 1. Git 身份与快照

| 字段          | 事实                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 主审计路径    | [外部源码] `C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/mdx-gpt-5-6-instruct`                    |
| 远程          | [当前代码事实] `origin = https://github.com/MDX-Tom/gpt-5.6-instruct.git`                                                          |
| 分支          | [当前代码事实] `main`                                                                                                              |
| HEAD          | [当前代码事实] `5f469e43ef66f540cadb475039fd9ed469aef654`                                                                          |
| HEAD 时间     | [当前代码事实] `2026-07-15T09:56:55+08:00`                                                                                         |
| 作者/主题     | [当前代码事实] `Mi Tom` / `bump v24 -> v5 & v35 dual version`                                                                      |
| checkout 状态 | [当前代码事实] clean                                                                                                               |
| 历史可见性    | [当前代码事实] shallow clone；本地只可见 1 个提交；0 个 tag。                                                                      |
| 重复 checkout | [当前代码事实] `C:/Users/10847/Documents/Codex/2026-07-21/mdx-tom-gpt-5-6-instruct` 是同 remote、同 HEAD 的另一份 clean checkout。 |
| License       | [当前代码事实] MIT，版权行涉及 `li lingbo` 与 `yynxxxxx`。                                                                         |

## 2. 仓库规模与组成

| 指标         | 本轮静态结果                                             |
| ------------ | -------------------------------------------------------- |
| tracked 文件 | [当前代码事实] 31                                        |
| ZIP          | [当前代码事实] 13 个。                                   |
| Python       | [当前代码事实] 4 个，合计约 897 行。                     |
| Markdown     | [当前代码事实] 4 个。                                    |
| SVG          | [当前代码事实] 4 个。                                    |
| JPG          | [当前代码事实] 2 个。                                    |
| Workflow     | [当前代码事实] 1 个 GitHub Pages/Star History workflow。 |
| 测试目录     | [当前代码事实] 当前 checkout 没有 tracked `tests/`。     |
| 报告目录     | [当前代码事实] 当前 checkout 没有 tracked `reports/`。   |
| 示例目录     | [当前代码事实] 当前 checkout 没有 tracked `examples/`。  |

## 3. 主要入口与责任

| 文件                               | 当前代码责任                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `codex-instruct.py`                | [当前代码事实] 交互/参数化选择 v5、v35 或 custom prompt，备份并改写 Codex `config.toml`。 |
| `sync-archives.py`                 | [当前代码事实] 比较源码 prompt 与 ZIP 内条目，支持 `--check` 和同步。                     |
| `gpt-5.6-sol-unrestricted-v5.md`   | [外部源码] tracked v5 文本 artifact。                                                     |
| `gpt-5.6-sol-unrestricted-v5.zip`  | [外部源码] v5 分发归档。                                                                  |
| `gpt-5.6-sol-unrestricted-v35.zip` | [外部源码] v35 分发归档。                                                                 |
| `scripts/*.zip`                    | [外部源码] 评测、prompt bank、矩阵、修复与评分脚本的归档分发。                            |
| `.github/workflows/*`              | [当前代码事实] 定时生成 Star History/README 站点并部署 Pages。                            |

- [当前代码事实] 当前仓库没有 Python package manifest、requirements、lockfile 或 console entry point。
- [当前代码事实] Python 脚本更像直接执行的分发/配置工具，而非可安装库。
- [外部源码] 本文不复制或扩写 prompt artifact 的操作性内容，只审计包装、证据与配置副作用。

## 4. 归档清单

### 4.1 Prompt ZIP

| ZIP                                | 条目                                             |     解压大小 |    ZIP 大小 |
| ---------------------------------- | ------------------------------------------------ | -----------: | ----------: |
| `gpt-5.6-sol-unrestricted-v35.zip` | [当前代码事实] `gpt-5.6-sol-unrestricted-v35.md` | 10,198 bytes | 4,748 bytes |
| `gpt-5.6-sol-unrestricted-v5.zip`  | [当前代码事实] `gpt-5.6-sol-unrestricted-v5.md`  |  1,397 bytes |   979 bytes |

### 4.2 Script ZIP（11 个）

| ZIP 中的主脚本                    |                    解压大小 |
| --------------------------------- | --------------------------: |
| `collect_prompt_comparison.py`    |  [当前代码事实] 4,997 bytes |
| `generate_generalization_bank.py` |  [当前代码事实] 7,023 bytes |
| `generate_prompt_bank.py`         | [当前代码事实] 40,601 bytes |
| `generate_safety_eval.py`         |  [当前代码事实] 7,953 bytes |
| `repair_prompt_bank_run.py`       |  [当前代码事实] 5,784 bytes |
| `run_prompt_bank.py`              | [当前代码事实] 17,486 bytes |
| `run_safety_eval.py`              | [当前代码事实] 10,453 bytes |
| `run_named_comparison.py`         |  [当前代码事实] 5,710 bytes |
| `run_matrix.py`                   | [当前代码事实] 28,086 bytes |
| `run_visual_regression.py`        |  [当前代码事实] 6,059 bytes |
| `score_safety.py`                 |  [当前代码事实] 5,506 bytes |

- [当前代码事实] 这 11 个脚本以 ZIP 为 tracked 分发物；其源脚本目录没有作为普通 tracked tree 出现。
- [当前代码事实] ZIP 可枚举不等于脚本已在当前 commit 运行，且缺少 dependencies lock 与结果 provenance。

## 5. 完整性与哈希审计

### 5.1 README 公布值

| Artifact | README SHA-256                                |
| -------- | --------------------------------------------- |
| v5 ZIP   | [README 声明] `02c...` 开头的完整 64-hex 值。 |
| v35 ZIP  | [README 声明] `08a...` 开头的完整 64-hex 值。 |

为避免把过期值继续作为下载指令传播，本档案保留其前缀并用当前实测全值做校验基准。

### 5.2 当前文件实测值

| Artifact    | 当前 SHA-256                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| v5 ZIP      | [当前代码事实] `E55293314A3F789D7D19CDA22D60E2D5BE306B850A9C17A015A836943B691AFB` |
| v35 ZIP     | [当前代码事实] `72CA29F14615E22CB8C23D5D67FF9F26C68C89CC951873758930EB0EC668C3CF` |
| v5 Markdown | [当前代码事实] `AB347DD41CEDF5E55B59797E1F2B33EC26BE159401A49704B62A9A84B6C7431A` |

- [当前代码事实] 当前两个 ZIP hash 都与 README 公布值不一致。
- [当前代码事实] 这可能来自 artifact 更新后文档未同步、归档重压缩或 README 仍指向历史资产；仅靠当前 shallow checkout 尚不足以区分原因。
- [当前代码事实] 在完整性敏感场景中，应以明确 commit/tag 下重新计算的 hash 为准，并同时更新 release asset 与文档。

## 6. `sync-archives.py` 的可复现性

- [当前代码事实] 脚本预期比较归档和源文件，包括 `gpt-5.6-sol-unrestricted-v35.md` 与 `examples/gpt-5.6-sol-unrestricted.md`。
- [当前代码事实] 当前 tracked tree 缺少这两个源路径；README 说明部分明文源受 ignore/分发策略影响。
- [当前代码事实] 本轮执行 `python sync-archives.py --check` 返回非零，并报告上述源文件缺失。
- [当前代码事实] 因此一份 clean clone 在当前状态下未能直接通过 archive consistency check。
- [未验证] 未从 release、历史 commit 或其他私有工作区补齐源文件；缺失内容不会在本档案中推断。

## 7. `codex-instruct.py` 配置模型

### 7.1 支持模式

- [当前代码事实] 支持选择 v5、v35 和 custom 路径。
- [当前代码事实] 支持 `--dry-run`、指定 Codex home/目录和 reset 路径。
- [当前代码事实] 会定位 Codex config，并把选定 prompt 放到管理路径。
- [当前代码事实] 设置 `config.toml` 顶层 `model_instructions_file`，使 Codex 读取新的 instruction file。

### 7.2 备份与 reset

- [当前代码事实] 首次修改会保存 baseline backup；每次修改前还会产生带时间戳 snapshot。
- [当前代码事实] reset 会选择备份、要求交互确认，再恢复 config 并删除工具管理的 prompt 文件。
- [当前代码事实] 这不是“只读查看 prompt”的脚本，而是会改写用户级 Codex 配置的部署工具。
- [当前代码事实] `--dry-run` 是审计和演练边界，应优先用于确认目标路径与差异。
- [未验证] 本轮没有让脚本修改本机 Codex 配置，也没有对 TOML 保留注释/顺序做 round-trip 测试。

## 8. README 的评测主张与证据缺口

- [README 声明] 仓库描述了 `tests/` 中约 360 个 cases，以及 prompt bank、安全评测、矩阵、视觉回归、报告和示例。
- [README 声明] README 给出多组模型/版本成功率、拒绝词或回归指标。
- [当前代码事实] 当前 31 个 tracked 文件中没有 `tests/`、`reports/`、`examples/`，也没有原始运行日志、请求响应、环境 lock、成本/时间记录。
- [当前代码事实] 一部分 generator/runner/scorer 仅存在 ZIP 中，这可以证明工具 artifact 存在，尚不足以证明 README 数字来自当前 HEAD 的可重放运行。
- [未验证] README 中的 360 cases 和各类分数在当前 checkout 尚未独立复算。
- [当前代码事实] 面试时应说“审计了外部评测仓库的证据链，并识别出结果与可复现资产脱节”，而不是引用分数作为自己的实验结果。

## 9. GitHub Pages / Star History workflow

- [当前代码事实] 唯一 workflow 由 schedule（每 12 小时）、push 和手动触发。
- [当前代码事实] workflow checkout 外部 Star History 项目，用 pnpm `9.15.9`、Node 20、Python Markdown `3.8.2` 等固定工具生成 SVG/README/site 内容。
- [当前代码事实] 使用 token 获取/生成星标历史，校验 SVG，然后构建双语 README 页面和 manifest。
- [当前代码事实] 检测到内容变化时部署 GitHub Pages。
- [当前代码事实] 该 workflow 是站点/展示自动化，不测试 `codex-instruct.py`、`sync-archives.py`、ZIP 内 runner 或 prompt 评测结果。
- [当前代码事实] 仓库因此有自动部署，但没有覆盖核心配置脚本和评测 artifact 的常规代码 CI。

## 10. 安全、配置与供应链边界

| 风险              | 当前证据                                                  | 准确表述                                                         |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 行为配置          | [当前代码事实] installer 改写 `model_instructions_file`。 | 在用户级 Agent 配置上有持续副作用，必须预览 diff、备份和可恢复。 |
| Prompt provenance | [外部源码] prompt artifact 来自外部仓库。                 | 内容应按不受信输入处理，并与当前组织/任务规则隔离。              |
| Hash 漂移         | [当前代码事实] README hash 与当前 ZIP 不同。              | 下载/发布完整性文档过期，需 commit/tag 绑定。                    |
| Source 缺失       | [当前代码事实] v35/source example 缺失，`--check` 失败。  | clean clone 缺少重建/验证全部归档所需的源文件。                  |
| 评测缺口          | [当前代码事实] tests/reports/examples 未 tracked。        | 结果数字缺少本快照内的原始证据。                                 |
| Archive-only code | [当前代码事实] 11 个评测脚本只以 ZIP 分发。               | 可检查性、diff 审阅和依赖管理弱于普通源码树。                    |
| Workflow scope    | [当前代码事实] CI 只做 Pages/Star History。               | 展示自动化不应替代 installer/评测回归。                          |

## 11. 文档声明与代码验证对照

| 主题       | 声明                                            | 当前证据结论                                                            |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| 双版本     | [README 声明] v5 + v35                          | [当前代码事实] 两个 ZIP 都存在，v5 明文存在；v35 明文缺失。             |
| 归档同步   | [README 声明] `sync-archives.py --check` 可校验 | [当前代码事实] clean checkout 因源文件缺失返回非零。                    |
| 下载完整性 | [README 声明] 提供 SHA-256                      | [当前代码事实] 当前 ZIP hash 与 README 不同。                           |
| 评测规模   | [README 声明] 约 360 cases                      | [当前代码事实] 当前 tree 无 tests/reports/examples；[未验证] 尚未复算。 |
| Codex 安装 | [README 声明] 一键切换 instruction              | [当前代码事实] 脚本确实备份并改写 config；[未验证] 未做本机安装。       |
| 自动化     | [README 声明] 展示/星标页面自动更新             | [当前代码事实] workflow 存在；它不覆盖核心代码测试。                    |

## 12. 面试追问与准确答法

### Q1：你从这个外部仓库学到的核心工程问题是什么？

[外部源码] Prompt 工程也需要普通软件供应链纪律：版本化源码、可重建归档、commit-bound hash、环境 lock、原始评测结果和 installer 回滚。缺任一环节，指标与发布物都难以独立审计。

### Q2：为什么 README hash 不一致很重要？

[当前代码事实] hash 的目的就是把用户下载内容绑定到作者发布内容；文档值与当前文件不同会让校验失去意义。原因可能无害，但在补齐历史证据前只能报告“不一致”。

### Q3：installer 哪些地方设计得相对稳健？

[当前代码事实] 有 dry-run、baseline backup、时间戳 snapshot 和 reset，说明作者考虑过可观察、可恢复。仍应补 automated tests、原子写入验证和并发保护。

### Q4：能否引用 README 的评测数字？

[未验证] 当前 snapshot 缺 tests/reports/examples 和原始日志，因此只能说“README 宣称”，不得把数字作为本轮复现实验或个人业绩。

## 13. 一句话边界

> [外部源码] 该仓库展示了 prompt 归档、Codex 配置切换与评测脚本分发；[当前代码事实] 当前 checkout 存在 ZIP hash 漂移、源文件缺失、archive check 失败和评测证据目录缺失；[未验证] README 的规模与效果指标尚未形成可独立重放的当前证据链。
