# 主仓库 Git refs、分支、标签与作者事实

来源：2026-08-18 的 git branch -a -vv、git tag、git remote 和 git shortlog --all。

## Remote

- origin fetch：https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
- origin push：https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git
- origin/HEAD 指向 origin/master。
- 当前本地分支 main 跟踪 origin/main。

## 本地分支

| 分支                                 | HEAD    | upstream/状态           |
| ------------------------------------ | ------- | ----------------------- |
| main                                 | 1fa74a0 | origin/main；当前分支   |
| master                               | 73658aa | origin/master           |
| codex/candidate-cover-letter-profile | 7acebf0 | origin 同名分支         |
| codex/hegelsalon-production-release  | e2c12f2 | origin 同名分支         |
| codex/phase7-smtp-hardening          | 6ac271e | 由 phase7 worktree 占用 |

## Remote refs

| Ref                                         | HEAD    |
| ------------------------------------------- | ------- |
| origin/codex/add-linux-playwright-baselines | 1278d4d |
| origin/codex/candidate-cover-letter-profile | 7acebf0 |
| origin/codex/hegelsalon-production-release  | e2c12f2 |
| origin/main                                 | 1fa74a0 |
| origin/master                               | 73658aa |

## Tag

- v3.0.0：annotated text 为“v3.0.0 verified one-click release”。
- v3.0.0 指向 commit c56bec7。
- 当前 HEAD 1fa74a0 位于该 tag 之后。

## git shortlog --all 作者身份

| Git 作者身份                                                                | 可达提交记录数 |
| --------------------------------------------------------------------------- | -------------: |
| wzn1118 <wzn1118@users.noreply.github.com>                                  |             95 |
| wzn1118 <102997933+wzn1118@users.noreply.github.com>                        |             14 |
| 1LLLei <1365048839@qq.com>                                                  |              1 |
| github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> |              1 |

## 解释边界

- shortlog --all 统计所有 refs，可重复覆盖同一历史与不同分支，所以和 main HEAD 的 103 条时间线口径不同。
- 两个 wzn1118 邮箱身份属于 Git metadata 中的不同 author identity；是否为同一自然人需由候选人确认。
- author 字段说明 commit metadata，不等于每行代码的唯一作者或全部设计贡献。
- origin 默认仍为 master，而活跃 main 已前进到 1fa74a0；面试时可把分支治理列为工程风险。
