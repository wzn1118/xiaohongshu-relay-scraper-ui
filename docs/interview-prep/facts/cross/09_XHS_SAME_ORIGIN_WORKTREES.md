# XHS 同源仓库、工作树与快照事实

> 审计时间：2026-08-18。
> 对象：所有指向 `https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git` 或由当前仓库登记的本地工作树。
> 目的：区分产品数量、Git 根数量、linked worktree、detached 工作树和 shallow 旧快照。

## 1. 三种本地形态

| 路径                                                                       | Git 形态                     | 分支/状态                      | HEAD      | 本地可见提交 | tracked | 当前状态摘要                                       |
| -------------------------------------------------------------------------- | ---------------------------- | ------------------------------ | --------- | -----------: | ------: | -------------------------------------------------- |
| `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui`                    | 主仓库 + 主 linked worktree  | `main`，跟踪 `origin/main`     | `1fa74a0` |          103 |     515 | 原有 22 个 tracked 改动；事实库是新增未跟踪文档    |
| `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui-phase7`             | 同一主仓库的 linked worktree | `codex/phase7-smtp-hardening`  | `6ac271e` |           53 |     147 | `test-results/` 未跟踪；porcelain 折叠为一个目录项 |
| `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tmp\portable-clone` | 独立 shallow clone           | `master`，跟踪 `origin/master` | `1aef299` |            2 |      54 | clean                                              |

三行代表一个产品代码库的三个本地演化视图，不代表三个独立产品。

## 2. linked worktree 的直接证据

`phase7` 的 `.git` 内容指向：

```text
gitdir: C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.git/worktrees/xiaohongshu-relay-scraper-ui-phase7
```

`git rev-parse --git-common-dir` 返回主仓库的 `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.git`。因此它与 `main` 共享 object database 和 refs，而 `tmp/portable-clone` 有自己的 shallow Git 元数据。

## 3. 主仓库登记的四个 worktree

2026-08-18 执行 `git worktree list --porcelain` 得到：

| 路径                                                           | HEAD      | branch                                   | 当前文件系统状态                                         |
| -------------------------------------------------------------- | --------- | ---------------------------------------- | -------------------------------------------------------- |
| `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui`        | `1fa74a0` | `refs/heads/main`                        | 存在；当前活跃工作区                                     |
| `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui-phase7` | `6ac271e` | `refs/heads/codex/phase7-smtp-hardening` | 存在；阶段工作树                                         |
| `E:/CodexHome/tmp/expansion-baseline`                          | `4683900` | detached                                 | 存在；有 12 个 tracked 修改和 6 个未跟踪路径/目录条目    |
| `E:/UserData/Temp/xhs-ci-d9af-repro-2`                         | `d9af3e2` | detached                                 | 路径存在；`git status` 将 74 个 tracked 文件全部列为删除 |

最后两个路径不在 `C:\Users\10847\Documents` 的 15 个 Git 根扫描范围内，但属于当前仓库登记的工作树事实。

## 4. expansion-baseline 工作树

基线提交：

```text
4683900992a2a4d0dd7918e8ae4ee819dfef9806
2026-08-01T09:44:04+08:00
feat(expansion): add bounded breadth-first relationship crawl
```

它相对 `main` 落后 45 条提交。2026-08-18 的 tracked 修改为：

- `scripts/expansion_collection.py`
- `server/app.mjs`
- `server/app.test.mjs`
- `server/contracts.test.mjs`
- `server/job-manager.mjs`
- `server/job-manager.test.mjs`
- `server/lib/contracts.mjs`
- `src/App.tsx`
- `src/api.ts`
- `src/styles.css`
- `src/types.ts`
- `tests/test_expansion_collection.py`

未跟踪条目为：

- `scripts/run_expansion_workspace.py`
- `server/expansion-results.test.mjs`
- `server/lib/expansion-results.mjs`
- `src/ExpansionWorkspace.tsx`
- `tests/e2e/expansion-workspace.spec.ts`
- `tests/e2e/expansion-workspace.spec.ts-snapshots/`

这些文件证明存在一个独立 expansion workspace 实验快照。它们的工作区状态不是 `main` 当前文件的 ownership 或发布证明。

## 5. xhs-ci-d9af-repro-2 工作树

基线提交：

```text
d9af3e2ffa356339d2ef311b9388bea35c5f80e4
2026-07-29T13:21:42+08:00
fix: prepare managed relay on new machines
```

- 它相对 `main` 落后 84 条提交。
- Git index 记录 74 个 tracked 文件。
- 2026-08-18 的 `git status --short` 把这 74 个文件全部列为删除，说明工作树内容已被清空或移走，但 worktree metadata 仍被主仓库登记。
- 这是临时 CI 复现残留状态，不是一个可运行项目快照。

## 6. phase7 到 main 的演进

`git merge-base 6ac271e 1fa74a0` 返回 `6ac271e`，说明 phase7 HEAD 是当前 main 的祖先。对称差异为：

```text
phase7_only=0
main_only=50
```

从 `6ac271e` 到 `1fa74a0` 的 tree diff：

| 指标          |    数值 |
| ------------- | ------: |
| 变更文件      |     448 |
| 新增行        | 166,367 |
| 删除行        |   3,940 |
| main 新增提交 |      50 |

按变更文件数的主要顶层分布包括 `server/` 22.0%、`scripts/` 16.2%、`server/copilot/` 10.0%、`tests/` 6.9%、`docs/` 6.6% 和 `src/` 5.1%。这是 `git diff --dirstat=files,0` 的文件分布，不是代码行占比。

phase7 最新 13 条非 merge 演进主题依次覆盖 SMTP 配置绑定、本地数据生命周期、preflight 分层、证据 claim 校验、正文 ledger、原 Job 恢复、run attempt、stage checkpoint、任务历史、受众评论采集、AI 工作流和用户文档。此处只概括提交主题，不把主题行当作本轮功能验收。

## 7. portable-clone 到 main 的演进

`tmp/portable-clone` 是 shallow clone：

```text
visible_commits=2
HEAD=1aef299978b7f0cc35637878a66a09f28f55da55
parent=ba15c7be5f5335cbdaa2de49f7544cd82e2b1fe6
```

当前主仓库的完整 object database 显示 `1aef299` 是 `main` 的祖先。对称差异为 `portable_only=0`、`main_only=100`。两棵树比较得到：

| 指标                  |                   数值 |
| --------------------- | ---------------------: |
| portable tracked 文件 |                     54 |
| main tracked 文件     |                    515 |
| tree diff 变更文件    |                    503 |
| 新增行                |                204,856 |
| 删除行                |                  1,455 |
| main 侧新增提交       | 100（其中非 merge 99） |

旧快照的 54 个 tracked 文件覆盖最小 React/Vite UI、Node 服务、Python 工作流、基础测试、启动脚本和文档。它适合解释早期便携/最小发布面，不适合代替当前 v3.0 代码结构。

## 8. 分支与远端引用

当前主仓库可见本地分支：

| 分支                                   | HEAD      | upstream/说明                         |
| -------------------------------------- | --------- | ------------------------------------- |
| `main`                                 | `1fa74a0` | `origin/main`                         |
| `master`                               | `73658aa` | `origin/master`                       |
| `codex/phase7-smtp-hardening`          | `6ac271e` | 在 phase7 linked worktree 中 checkout |
| `codex/candidate-cover-letter-profile` | `7acebf0` | 对应同名 origin 分支                  |
| `codex/hegelsalon-production-release`  | `e2c12f2` | 对应同名 origin 分支                  |

这里的 “HegelSalon production release” 是 XHS 仓库中的分支/部署主题，不等同于独立 `hegel-salon` 仓库的完整提交历史。

## 9. 面试使用边界

1. 主产品数量按一个计算；worktree、branch、shallow clone 按工程演化证据计算。
2. `phase7` 可用于讲状态恢复、证据、SMTP 和数据生命周期的阶段性设计；后续 main 又增加 50 条提交。
3. `expansion-baseline` 的未提交文件只能表述为实验快照。
4. `xhs-ci-d9af-repro-2` 当前是元数据残留/清空工作树状态，不列为项目成果。
5. portable clone 的 2 条可见提交来自 shallow 边界，不表示上游当时只有两条历史提交。

## 10. 复核命令

```powershell
git worktree list --porcelain
git branch -vv
git merge-base 6ac271e 1fa74a0
git rev-list --left-right --count 6ac271e...1fa74a0
git diff --shortstat 6ac271e..1fa74a0
git rev-list --left-right --count 1aef299...1fa74a0
git diff --shortstat 1aef299..1fa74a0
git -C E:\CodexHome\tmp\expansion-baseline status --short
git -C E:\UserData\Temp\xhs-ci-d9af-repro-2 status --short
```
