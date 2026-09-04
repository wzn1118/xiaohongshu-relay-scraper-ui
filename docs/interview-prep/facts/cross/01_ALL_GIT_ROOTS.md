# 全部本地 Git 根目录事实

审计时间：2026-08-18。主扫描范围为 `C:\Users\10847\Documents`，排除了 `node_modules`、缓存以及本轮用于只读审计的 `.codex-tmp/interview-repo-audit`。主扫描识别 15 个 Git 工作目录/根；临时审计 clone 另列于文末。主仓库状态计数排除了本轮新增的 `docs/interview-prep/`，其余工作区状态保留。

- Git 根总数：15
- 有提交的 Git 根：8
- 有 origin remote 的 Git 根：8
- 无提交的 Git 根：7

## 完整表

| 序号 | 类型                 | 根目录                                                                                             | 分支                        | upstream      | origin                                                      | HEAD     | commits | tracked | tracked 状态 | untracked | 最近日期   | 作者       | 主题                                                                      |
| ---: | -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- | ------------- | ----------------------------------------------------------- | -------- | ------: | ------: | -----------: | --------: | ---------- | ---------- | ------------------------------------------------------------------------- |
|    1 | 父目录误初始化       | C:\Users\10847\Documents                                                                           | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |     86343 | [无]       | [无]       | [无]                                                                      |
|    2 | 外部 remote clone    | C:\Users\10847\Documents\Codex\2026-07-20\https-github-com-zxr-roro-gpt5\work\mdx-gpt-5-6-instruct | main                        | origin/main   | https://github.com/MDX-Tom/gpt-5.6-instruct.git             | 5f469e4  |       1 |      31 |            0 |         0 | 2026-07-15 | Mi Tom     | bump v24 -> v5 & v35 dual version                                         |
|    3 | 外部 remote clone    | C:\Users\10847\Documents\Codex\2026-07-20\https-github-com-zxr-roro-gpt5\work\source               | main                        | origin/main   | https://github.com/zxr-roro/GPT5.6-5.5-.git                 | b18ceb0  |       3 |     438 |            1 |         1 | 2026-07-11 | 张钊炀-666 | Keep only zzy-codex5.6 project                                            |
|    4 | 外部 remote clone    | C:\Users\10847\Documents\Codex\2026-07-21\c\work\wechat-cli-new                                    | main                        | origin/main   | https://github.com/huohuoer/wechat-cli.git                  | a378923  |       1 |      51 |            0 |         0 | 2026-04-06 | canghe     | docs: add acknowledgement to wechat-decrypt                               |
|    5 | 外部 remote clone    | C:\Users\10847\Documents\Codex\2026-07-21\c\work\wechat-decrypt-source                             | main                        | origin/main   | https://github.com/328336690/wechat-decrypt.git             | 44427c4  |       1 |      19 |            0 |         0 | 2026-06-05 | 328336690  | docs: add shields badges                                                  |
|    6 | 其他                 | C:\Users\10847\Documents\Codex\2026-07-21\mdx-tom-gpt-5-6-instruct                                 | main                        | origin/main   | https://github.com/MDX-Tom/gpt-5.6-instruct.git             | 5f469e4  |       1 |      31 |            0 |         0 | 2026-07-15 | Mi Tom     | bump v24 -> v5 & v35 dual version                                         |
|    7 | 本地未版本化快照     | C:\Users\10847\Documents\MKT大师                                                                   | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |       887 | [无]       | [无]       | [无]                                                                      |
|    8 | 本地未版本化快照     | C:\Users\10847\Documents\Playground                                                                | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |        85 | [无]       | [无]       | [无]                                                                      |
|    9 | 空 Git 根            | C:\Users\10847\Documents\Playground 2                                                              | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |         0 | [无]       | [无]       | [无]                                                                      |
|   10 | 空 Git 根            | C:\Users\10847\Documents\Playground 3                                                              | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |         0 | [无]       | [无]       | [无]                                                                      |
|   11 | 本地未版本化快照     | C:\Users\10847\Documents\today-you-applied-portable                                                | main                        | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |       394 | [无]       | [无]       | [无]                                                                      |
|   12 | 主公开仓库           | C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui                                              | main                        | origin/main   | https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git | 1fa74a0  |     103 |     515 |           22 |        60 | 2026-08-17 | wzn1118    | fix: make job recovery visible and repair quality gates                   |
|   13 | 同源旧快照           | C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\tmp\portable-clone                           | master                      | origin/master | https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git | 1aef299  |       2 |      54 |            0 |         0 | 2026-07-28 | wzn1118    | fix: stabilize AI review workflow                                         |
|   14 | 同源 linked worktree | C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui-phase7                                       | codex/phase7-smtp-hardening | [无]          | https://github.com/wzn1118/xiaohongshu-relay-scraper-ui.git | 6ac271e  |      53 |     147 |            0 |         7 | 2026-08-01 | wzn1118    | fix(mail): bind smtp verification and sending to the active configuration |
|   15 | 本地未版本化快照     | C:\Users\10847\Documents\本电脑                                                                    | master                      | [无]          | [无]                                                        | [无提交] |       0 |       0 |            0 |         2 | [无]       | [无]       | [无]                                                                      |

## 重复与同源关系

- 两份 mdx-gpt-5-6-instruct 指向同一 remote、同一 HEAD 5f469e4，是重复 checkout。
- 当前主仓库与 phase7 共享同一个 Git common directory，是主线和 linked worktree；tmp/portable-clone 是同 remote 的独立 shallow 旧快照。
- 主仓库还登记了两个位于 `E:` 的 detached worktree；详见 [XHS 同源仓库、工作树与快照事实](./09_XHS_SAME_ORIGIN_WORKTREES.md)。
- Documents 根没有 commit/tracked，却包住大量下级文件，应视为误初始化父目录。
- MKT大师、Playground、today-you-applied-portable、本电脑有 Git 元数据但无 commit/remote，属于本地未版本化快照。

## 贡献边界

- remote 指向其他账号的 clone 只证明本机存在源码副本，不证明候选人贡献。
- commit count 是当前 clone 可达历史；depth=1 clone 的 count 只会显示 1，不代表上游只有一个提交。
- untracked 数字是本机工作树事实，可能随用户和工具运行变化。

## 本轮临时公开仓库审计 clone

以下两个 shallow clone 位于主仓库的 `.codex-tmp/interview-repo-audit/`。它们服务于本轮公开仓库静态核验，未计入上方 15 个主扫描对象；若把这两个临时 checkout 一并计入，本轮事实库覆盖 17 个 Documents 范围内的 Git 工作目录/根路径。

| 路径                                                                                                   | origin                                          | 分支   | HEAD      | shallow | 可见提交 | tracked | status |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------ | --------- | ------- | -------: | ------: | -----: |
| `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\.codex-tmp\interview-repo-audit\AsteriaAnalyst` | `https://github.com/wzn1118/AsteriaAnalyst.git` | `main` | `b9b8170` | true    |        1 |     345 |      0 |
| `C:\Users\10847\Documents\xiaohongshu-relay-scraper-ui\.codex-tmp\interview-repo-audit\hegel-salon`    | `https://github.com/wzn1118/hegel-salon.git`    | `main` | `36f1cd3` | true    |        1 |     543 |      0 |

这两份代码的详细事实与贡献边界见[公开及外部仓库事实库](../public-external/README.md)。
