# Git 历史与仓库来源事实

## 仓库快照

- **XHS-GIT-001 [HEAD]**：审计基线完整哈希为 `1fa74a0fb8cb19e043cad7c15bfcafc8c261ed2e`，提交时间为 `2026-08-17T20:27:35+08:00`。
- **XHS-GIT-002 [HEAD]**：基线提交标题为 `fix: make job recovery visible and repair quality gates`，父提交为 `c56bec7dc9adc4ee700515685689e630a7a6a49b`。
- **XHS-GIT-003 [HEAD]**：`v3.0.0` 是 annotated tag，标签说明为 `v3.0.0 verified one-click release`。
- **XHS-GIT-004 [HEAD]**：标签目标提交 `c56bec7` 的标题为 `release: add verified one-click package`，时间为 2026-08-17 15:38:20 +08:00。
- **XHS-GIT-005 [HEAD]**：`HEAD` 比 `v3.0.0` 多 1 个提交，因此审计描述为 `v3.0.0-1-g1fa74a0`；工作区脏时 `git describe` 追加 `-dirty`。
- **XHS-GIT-006 [HEAD]**：仓库共有 103 个可达提交，时间范围从 2026-07-28 到 2026-08-17。
- **XHS-GIT-007 [HEAD]**：根提交为 `c961b6b222e3a35f94be230ad0f5385f37dd3c2d`，标题为 `feat: add portable AI application workflow`，时间为 2026-07-28 20:54:48 +08:00。
- **XHS-GIT-008 [HEAD]**：提交月份分布为 2026-07 共 48 个、2026-08 共 55 个。
- **XHS-GIT-009 [HEAD]**：作者/邮箱组合计数为 `wzn1118 <wzn1118@users.noreply.github.com>` 95 个、`wzn1118 <102997933+wzn1118@users.noreply.github.com>` 7 个、`1LLLei <1365048839@qq.com>` 1 个。
- **XHS-GIT-010 [HEAD]**：按作者名合并后，`wzn1118` 对应 102/103 个提交，`1LLLei` 对应 1/103 个提交；该数字只表示 Git author，不自动等于所有代码贡献比例。
- **XHS-GIT-011 [HEAD]**：提交标题前缀的静态分布至少包括 `feat` 26、`fix` 24、`docs` 16、`test` 5、`perf` 2；另有带括号 scope 的 `feat(...)`、`fix(...)`、`test(...)` 等。
- **XHS-GIT-012 [HEAD]**：本地分支包括 `main`、`master`、`codex/candidate-cover-letter-profile`、`codex/hegelsalon-production-release`、`codex/phase7-smtp-hardening`。
- **XHS-GIT-013 [HEAD]**：`main` 与 `origin/main` 均指向 `1fa74a0`；`master` 与 `origin/master` 指向 `73658aa`。
- **XHS-GIT-014 [HEAD]**：`origin/HEAD` 在审计时仍指向 `origin/master`，这与当前发布工作流监听 `main` 是两个不同事实。
- **XHS-GIT-015 [HEAD]**：`codex/phase7-smtp-hardening` 被另一 worktree `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui-phase7` 占用，指向 `6ac271e`。
- **XHS-GIT-016 [S]**：`HEAD` 跟踪 515 个文件，总 blob 字节数约 15,264,687；这是 Git tree 静态体积，不包含 `.git`、依赖和未跟踪文件。
- **XHS-GIT-017 [S]**：`HEAD` 扩展名数量前列为 `.mjs` 226、`.py` 68、`.png` 57、`.md` 46、`.tsx` 24、`.ps1` 23、`.ts` 20、`.json` 13、`.svg` 10。
- **XHS-GIT-018 [S]**：`HEAD` 目录文件数为 `server/` 194、`scripts/` 88、`tests/` 81、`docs/` 60、`src/` 37。
- **XHS-GIT-019 [S]**：`HEAD` 中 `server/` blobs 约 3,867,909 字节，`tests/` 约 4,174,373 字节，`scripts/` 约 1,935,401 字节，`src/` 约 1,575,034 字节。
- **XHS-GIT-020 [HEAD]**：最大已提交源码 blobs 包括 `src/App.tsx` 385,252 字节、`src/styles.css` 307,462 字节、`server/app.mjs` 286,810 字节、`server/job-manager.mjs` 181,312 字节、`scripts/ai_application_workflow.py` 172,385 字节。

## 完整提交时间线

| 短哈希    | 日期       | Author  | 标题                                                                      |
| --------- | ---------- | ------- | ------------------------------------------------------------------------- |
| `c961b6b` | 2026-07-28 | wzn1118 | feat: add portable AI application workflow                                |
| `ba15c7b` | 2026-07-28 | wzn1118 | fix: preserve quality issue export contract                               |
| `1aef299` | 2026-07-28 | wzn1118 | fix: stabilize AI review workflow                                         |
| `d02bcfd` | 2026-07-28 | wzn1118 | feat: add portable one-click launchers                                    |
| `6a2e52b` | 2026-07-28 | wzn1118 | fix: reject cross-platform absolute artifact paths                        |
| `9c36738` | 2026-07-28 | wzn1118 | feat: add automatic relay connection                                      |
| `686684d` | 2026-07-28 | wzn1118 | docs: publish optional Windows startup helper                             |
| `f2446e0` | 2026-07-28 | wzn1118 | add candidate profile cover letter prompt                                 |
| `92c8fc0` | 2026-07-28 | wzn1118 | support resume candidate profile import                                   |
| `1e029a3` | 2026-07-29 | wzn1118 | docs: add GitHub product introduction                                     |
| `d91ee8e` | 2026-07-29 | wzn1118 | docs: improve README product marketing copy                               |
| `e5bf4ff` | 2026-07-29 | wzn1118 | docs: add real product screenshots                                        |
| `5520151` | 2026-07-29 | wzn1118 | docs: showcase real product screenshots                                   |
| `e795662` | 2026-07-29 | wzn1118 | docs: make README more visual and informative                             |
| `7a36ed7` | 2026-07-29 | wzn1118 | docs: refine README screenshot gallery                                    |
| `301b28a` | 2026-07-29 | wzn1118 | feat: configure relay startup and connection                              |
| `61276e3` | 2026-07-29 | wzn1118 | feat: add editable application delivery workflow                          |
| `e79a942` | 2026-07-29 | wzn1118 | feat: add Outlook OAuth2 SMTP setup                                       |
| `d9af3e2` | 2026-07-29 | wzn1118 | fix: prepare managed relay on new machines                                |
| `f74f88e` | 2026-07-29 | wzn1118 | feat: add per-user SMTP configuration                                     |
| `8fa9c93` | 2026-07-29 | wzn1118 | feat: run browser relay through native CDP                                |
| `89bf2c9` | 2026-07-29 | wzn1118 | fix: widen responsive workspace breakpoint                                |
| `55ffd0a` | 2026-07-29 | wzn1118 | feat: add one-click relay setup                                           |
| `088eb89` | 2026-07-29 | wzn1118 | feat: add randomized collection pacing                                    |
| `61cbb59` | 2026-07-29 | wzn1118 | docs: explain automatic SMTP setup                                        |
| `b82c202` | 2026-07-29 | wzn1118 | feat: add bundled AI relay runtime                                        |
| `ee862fd` | 2026-07-29 | wzn1118 | feat: add SMTP setup guides                                               |
| `49e7af9` | 2026-07-29 | wzn1118 | fix: label browser relay correctly                                        |
| `7acebf0` | 2026-07-29 | wzn1118 | feat: improve AI model selection and detail retries                       |
| `290166b` | 2026-07-29 | wzn1118 | feat: expand AI model catalog                                             |
| `f254e67` | 2026-07-29 | wzn1118 | feat: expand AI runtime configuration                                     |
| `eb6e176` | 2026-07-29 | wzn1118 | docs: add local Qwen setup command                                        |
| `4c769d2` | 2026-07-29 | wzn1118 | docs: refresh product screenshots                                         |
| `efead72` | 2026-07-29 | wzn1118 | feat: add one-click Qwen3.5 local model                                   |
| `3e294ad` | 2026-07-29 | wzn1118 | feat: add OpenAI-compatible relay setup                                   |
| `5f46c5b` | 2026-07-30 | wzn1118 | docs: add product requirements document                                   |
| `8582f26` | 2026-07-30 | wzn1118 | docs: add product requirements document                                   |
| `b7d4481` | 2026-07-30 | wzn1118 | docs: add PRD diagrams and screenshots                                    |
| `5a19dd8` | 2026-07-30 | wzn1118 | feat: complete resilient AI application workflow                          |
| `60a9f53` | 2026-07-30 | wzn1118 | Merge remote-tracking branch 'origin/master'                              |
| `f26524d` | 2026-07-30 | wzn1118 | docs: add beginner usage guide                                            |
| `409cb12` | 2026-07-30 | wzn1118 | docs: add complete user guide                                             |
| `a19eb11` | 2026-07-31 | wzn1118 | Improve collection, AI workflows, and task history                        |
| `6fc02cf` | 2026-07-31 | wzn1118 | feat: add full audience and commenter collection                          |
| `8d6df74` | 2026-07-31 | wzn1118 | feat: show complete task history                                          |
| `f1c90d5` | 2026-07-31 | wzn1118 | fix(workflow): persist resumable stage checkpoints                        |
| `d3a6d77` | 2026-07-31 | wzn1118 | refactor(jobs): resume logical jobs with run attempts                     |
| `21c29a3` | 2026-07-31 | wzn1118 | fix(ui): keep resume operations on the original job                       |
| `6b11d51` | 2026-08-01 | wzn1118 | fix(crawler): persist an idempotent body completion ledger                |
| `715c55d` | 2026-08-01 | wzn1118 | fix(evidence): validate generated claims against source spans             |
| `547cb0b` | 2026-08-01 | wzn1118 | refactor(preflight): separate readiness checks from formal jobs           |
| `56e58f6` | 2026-08-01 | wzn1118 | feat(data): add safe and auditable local data lifecycle controls          |
| `6ac271e` | 2026-08-01 | wzn1118 | fix(mail): bind smtp verification and sending to the active configuration |
| `fb143fb` | 2026-08-01 | wzn1118 | fix(ui): protect unsaved draft transitions without visual redesign        |
| `349d3c7` | 2026-08-01 | wzn1118 | feat(core): finalize recovery, delivery, and diagnostics                  |
| `05595d5` | 2026-08-01 | wzn1118 | test(core): add full regression and release verification                  |
| `04d4f45` | 2026-08-01 | wzn1118 | docs(release): record phase ten acceptance evidence                       |
| `4683900` | 2026-08-01 | wzn1118 | feat(expansion): add bounded breadth-first relationship crawl             |
| `174fda7` | 2026-08-01 | wzn1118 | feat(ui): add dedicated relationship expansion workspace                  |
| `b3cae21` | 2026-08-01 | wzn1118 | feat: add audience AI analysis and profile intelligence                   |
| `0493086` | 2026-08-01 | wzn1118 | fix(resume): continue recovery in the original job workspace              |
| `e0a44da` | 2026-08-01 | wzn1118 | fix(metrics): derive body metrics from persistent per-note state          |
| `85186dc` | 2026-08-01 | wzn1118 | test(ci): stabilize auto-recovery scheduling window                       |
| `5f5ece2` | 2026-08-01 | wzn1118 | fix(audience): persist cursor-level comment and profile recovery state    |
| `d6f0195` | 2026-08-01 | wzn1118 | fix: harden collection completion and persistence                         |
| `dea1e59` | 2026-08-02 | wzn1118 | fix(ci): restore Linux browser checks (#1)                                |
| `6e8474d` | 2026-08-02 | wzn1118 | feat(delivery): support persistent application email attachments          |
| `baad909` | 2026-08-02 | wzn1118 | refactor(copy): generate evidence-grounded human application emails       |
| `cefd588` | 2026-08-02 | wzn1118 | test(mail): verify attachment delivery and idempotent send bundles        |
| `995febd` | 2026-08-03 | wzn1118 | feat(workflows): add task-bound copilot and durable recovery              |
| `e540810` | 2026-08-03 | wzn1118 | fix(ci): restore quality retry action contract                            |
| `94b307d` | 2026-08-04 | wzn1118 | docs: refocus product story and add UI evidence                           |
| `726b23a` | 2026-08-04 | wzn1118 | feat: integrate job workflows, batch delivery, and Copilot workbench      |
| `642bf88` | 2026-08-04 | wzn1118 | fix: keep development API stable during collection                        |
| `ddae0a9` | 2026-08-04 | wzn1118 | fix: stabilize recovery idempotency and test cleanup                      |
| `b27375f` | 2026-08-04 | wzn1118 | test: refresh cross-platform visual baselines                             |
| `2319fc4` | 2026-08-04 | wzn1118 | fix: ground outreach subjects and refresh CI snapshots                    |
| `938780b` | 2026-08-04 | wzn1118 | fix: stabilize audience AI timezone snapshots                             |
| `997c8c0` | 2026-08-05 | wzn1118 | fix: validate UI against live API in CI                                   |
| `5cdd747` | 2026-08-05 | wzn1118 | feat: complete application outreach workflow                              |
| `d37e5ca` | 2026-08-05 | wzn1118 | perf: cache audience contact indexes                                      |
| `27b3adc` | 2026-08-05 | wzn1118 | fix: preserve local cover letter review evidence                          |
| `76eb2d7` | 2026-08-05 | wzn1118 | fix: improve local evidence mapping                                       |
| `1c3cfb5` | 2026-08-05 | wzn1118 | fix: repair application delivery CI and UI flows                          |
| `d4228c8` | 2026-08-05 | wzn1118 | fix: repair CI and UI regressions                                         |
| `08b90c5` | 2026-08-05 | wzn1118 | feat: upgrade cover letter generation workflow                            |
| `6d5ec3c` | 2026-08-05 | wzn1118 | fix: stabilize responsive visual tests                                    |
| `0bc357e` | 2026-08-05 | 1LLLei  | 新增gitignore                                                             |
| `73658aa` | 2026-08-06 | wzn1118 | perf: bound job history payloads                                          |
| `faee904` | 2026-08-07 | wzn1118 | feat: add HegelSalon production release workflow                          |
| `d2dc6d7` | 2026-08-07 | wzn1118 | fix: harden public release entrypoints                                    |
| `8f3a511` | 2026-08-07 | wzn1118 | fix: include first-run env templates in portable packages                 |
| `b1500c4` | 2026-08-07 | wzn1118 | fix: prefer bundled runtimes in one-click launcher                        |
| `d5e8d66` | 2026-08-07 | wzn1118 | fix: keep Windows one-click launcher in release packages                  |
| `e2c12f2` | 2026-08-17 | wzn1118 | feat: ship full Data Copilot platform upgrade                             |
| `02b4eb0` | 2026-08-17 | wzn1118 | fix: restore CI verification                                              |
| `8d469f4` | 2026-08-17 | wzn1118 | fix: make artifact discovery Windows-safe                                 |
| `d7c7d27` | 2026-08-17 | wzn1118 | test: refresh Linux browser fixtures                                      |
| `953e0d4` | 2026-08-17 | wzn1118 | test: refresh running workspace fixtures                                  |
| `5c441ea` | 2026-08-17 | wzn1118 | test: refresh partial workspace fixtures                                  |
| `d428263` | 2026-08-17 | wzn1118 | test: stabilize draft navigation race                                     |
| `c56bec7` | 2026-08-17 | wzn1118 | release: add verified one-click package                                   |
| `1fa74a0` | 2026-08-17 | wzn1118 | fix: make job recovery visible and repair quality gates                   |

## 可用于面试的演进主线

- **XHS-GIT-021 [HEAD]**：7 月 28 日从可移植 AI 求职工作流起步，同日补齐 Artifact 路径隔离、Relay 自动连接、候选人 Profile 与一键启动。
- **XHS-GIT-022 [HEAD]**：7 月 29 日集中加入应用交付、Outlook OAuth2 SMTP、原生 CDP Relay、采集节奏、模型目录与本地模型。
- **XHS-GIT-023 [HEAD]**：7 月 30 日加入 PRD 与弹性 AI 工作流，7 月 31 日转向完整受众采集、任务历史、阶段检查点与逻辑 Job/Attempt 重构。
- **XHS-GIT-024 [HEAD]**：8 月 1 日集中完成正文 ledger、声明证据校验、无副作用预检、数据生命周期、SMTP 绑定、诊断、关系扩展、受众 AI 与恢复指标。
- **XHS-GIT-025 [HEAD]**：8 月 2 日完成应用附件、自然化文案与邮件幂等测试；8 月 3 日加入任务绑定 Copilot 与持久恢复。
- **XHS-GIT-026 [HEAD]**：8 月 4-5 日把岗位流程、批量投递、Copilot、CI、视觉基线、邮件标题证据与 Cover Letter 生成串成完整工作台。
- **XHS-GIT-027 [HEAD]**：8 月 6-7 日处理历史载荷上限、生产发布入口、便携运行时和跨项目 HegelSalon 发布运维。
- **XHS-GIT-028 [HEAD]**：8 月 17 日完成 Data Copilot 平台升级、CI 恢复、Windows Artifact 发现修复、跨平台快照刷新与 v3.0.0 一键包。
