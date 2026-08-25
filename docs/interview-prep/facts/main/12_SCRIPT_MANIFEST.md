# 主仓库 scripts 完整清单

来源：当前工作树 scripts/ 目录；package script 引用通过字符串匹配 package.json 得到。

- scripts 文件：97
- tracked：84
- untracked：13
- 总行数：45121

## 扩展名统计

| 扩展名 | 文件 |  行数 |    字节 |
| ------ | ---: | ----: | ------: |
| .mjs   |   34 |  9528 |  411012 |
| .py    |   33 | 30275 | 1377888 |
| .ps1   |   27 |  5084 |  245828 |
| .sh    |    3 |   234 |    7247 |

## 完整表

| 序号 | 文件                                                 | tracked |   字节 | 行数 | package scripts 引用                                   |
| ---: | ---------------------------------------------------- | ------- | -----: | ---: | ------------------------------------------------------ |
|    1 | scripts/ai_application_workflow.py                   | True    | 174995 | 3531 | [无直接引用]                                           |
|    2 | scripts/ai_provider_runtime.py                       | True    |  39114 |  869 | [无直接引用]                                           |
|    3 | scripts/application_generation.py                    | True    |  16225 |  375 | [无直接引用]                                           |
|    4 | scripts/application_intelligence_agents.py           | True    |  98552 | 2159 | [无直接引用]                                           |
|    5 | scripts/artifact_io.py                               | True    |   1309 |   36 | [无直接引用]                                           |
|    6 | scripts/audience_ai_pipeline.py                      | True    | 139825 | 3076 | [无直接引用]                                           |
|    7 | scripts/audience_ai_schemas.py                       | True    |  15722 |  467 | [无直接引用]                                           |
|    8 | scripts/audience_collection.py                       | True    | 116587 | 2562 | [无直接引用]                                           |
|    9 | scripts/audience_profile_supplement.py               | True    |  19170 |  431 | [无直接引用]                                           |
|   10 | scripts/audience_resume.py                           | True    |  18466 |  485 | [无直接引用]                                           |
|   11 | scripts/backup-hegelsalon.ps1                        | True    |   6139 |  128 | backup:production                                      |
|   12 | scripts/body_completion_ledger.py                    | True    |  25659 |  630 | [无直接引用]                                           |
|   13 | scripts/bootstrap.ps1                                | True    |   1557 |   37 | [无直接引用]                                           |
|   14 | scripts/bootstrap.sh                                 | True    |    753 |   26 | [无直接引用]                                           |
|   15 | scripts/build-competition-index.mjs                  | True    |   1239 |   31 | [无直接引用]                                           |
|   16 | scripts/check_relay_connection.py                    | True    |   2470 |   70 | [无直接引用]                                           |
|   17 | scripts/check-credentials.mjs                        | True    |   1842 |   56 | test:credentials                                       |
|   18 | scripts/check-format.mjs                             | True    |   1091 |   32 | format:check                                           |
|   19 | scripts/codex_config.py                              | True    |   4000 |  102 | [无直接引用]                                           |
|   20 | scripts/codex_runtime_outreach.py                    | True    |  66212 | 1293 | [无直接引用]                                           |
|   21 | scripts/codex-device-relay.mjs                       | False   |  26615 |  695 | relay:device                                           |
|   22 | scripts/codex-local-connector.mjs                    | False   |  18981 |  444 | connector:health, connector:update, connector:rollback |
|   23 | scripts/configure-outlook-smtp.mjs                   | True    |   6761 |  171 | configure:outlook                                      |
|   24 | scripts/copilot_attachment_helper.py                 | True    |   5008 |  154 | [无直接引用]                                           |
|   25 | scripts/copilot_xlsx_helper.py                       | True    |   3869 |  108 | [无直接引用]                                           |
|   26 | scripts/cover_letter_rewriter.py                     | True    | 106808 | 2173 | [无直接引用]                                           |
|   27 | scripts/create-xhs-assets.ps1                        | True    |   7779 |  131 | [无直接引用]                                           |
|   28 | scripts/diff-codex-app-server-schema.mjs             | False   |   9079 |  226 | [无直接引用]                                           |
|   29 | scripts/ensure-codex-config.ps1                      | True    |   1161 |   34 | [无直接引用]                                           |
|   30 | scripts/ensure-windows-prerequisites.ps1             | True    |   9391 |  231 | [无直接引用]                                           |
|   31 | scripts/evidence_claim_validator.py                  | True    |  24383 |  603 | [无直接引用]                                           |
|   32 | scripts/expansion_collection.py                      | True    |  70354 | 1375 | [无直接引用]                                           |
|   33 | scripts/generate-tailored-application-mail-data.mjs  | True    |  27028 |  550 | [无直接引用]                                           |
|   34 | scripts/hegelsalon-common.ps1                        | True    |  22614 |  518 | [无直接引用]                                           |
|   35 | scripts/install-codex-local-connector.ps1            | False   |   8566 |  201 | [无直接引用]                                           |
|   36 | scripts/job_role_title.py                            | True    |   8187 |  151 | [无直接引用]                                           |
|   37 | scripts/lint.mjs                                     | True    |   1043 |   26 | lint                                                   |
|   38 | scripts/maintain-codex-mcp-grant.ps1                 | True    |   4303 |  122 | [无直接引用]                                           |
|   39 | scripts/mcp-stdio-bridge.mjs                         | True    |   3065 |   68 | mcp:stdio                                              |
|   40 | scripts/migrate_application_outreach.py              | True    |   9189 |  205 | [无直接引用]                                           |
|   41 | scripts/note_identity.py                             | True    |   2849 |   89 | [无直接引用]                                           |
|   42 | scripts/one-click.ps1                                | True    |  19645 |  451 | [无直接引用]                                           |
|   43 | scripts/one-click.sh                                 | True    |   6320 |  196 | [无直接引用]                                           |
|   44 | scripts/package-codex-local-connector.ps1            | False   |   5218 |   98 | package:codex-connector                                |
|   45 | scripts/package-competition-submission.ps1           | True    |  22698 |  439 | [无直接引用]                                           |
|   46 | scripts/package-github-release.ps1                   | True    |   4106 |  103 | package:github-release                                 |
|   47 | scripts/package-windows-production.ps1               | True    |  27210 |  449 | package:production                                     |
|   48 | scripts/parallel_body_completion.py                  | True    |  93715 | 2119 | [无直接引用]                                           |
|   49 | scripts/preflight.mjs                                | True    |   2689 |   57 | preflight                                              |
|   50 | scripts/prepare-portable-runtime.ps1                 | True    |   8984 |  153 | prepare:portable-runtime                               |
|   51 | scripts/probe-codex-app-server.mjs                   | False   |   7113 |  239 | probe:codex:app-server                                 |
|   52 | scripts/probe-codex-web-runtime.mjs                  | False   |  15858 |  379 | probe:codex:web-runtime                                |
|   53 | scripts/production-watchdog.ps1                      | True    |  12736 |  279 | watchdog:production                                    |
|   54 | scripts/profile_memory.py                            | True    |  32442 |  825 | [无直接引用]                                           |
|   55 | scripts/provision-auth.mjs                           | True    |    842 |   22 | provision:auth                                         |
|   56 | scripts/provision-codex-desktop-runtime.ps1          | False   |   5243 |  126 | prepare:codex-desktop                                  |
|   57 | scripts/provision-hegelsalon-relay-tunnel.ps1        | True    |   8447 |  164 | provision:hegelsalon:relay                             |
|   58 | scripts/recheck_application_draft.py                 | True    |  11055 |  294 | [无直接引用]                                           |
|   59 | scripts/record-all-features-workflow.mjs             | True    |  73323 | 1468 | [无直接引用]                                           |
|   60 | scripts/record-codex-runtime-baseline.mjs            | False   |    910 |   19 | codex:runtime:baseline                                 |
|   61 | scripts/record-complete-workflow.mjs                 | True    |  54280 | 1211 | [无直接引用]                                           |
|   62 | scripts/record-core-workflow.mjs                     | True    |  15729 |  389 | [无直接引用]                                           |
|   63 | scripts/register-startup.ps1                         | True    |   4837 |  112 | register:production                                    |
|   64 | scripts/replay-application-email-subjects.mjs        | True    |  11093 |  268 | [无直接引用]                                           |
|   65 | scripts/repo-files.mjs                               | True    |    478 |   16 | [无直接引用]                                           |
|   66 | scripts/resolve_application_contacts.py              | True    |  53074 | 1238 | [无直接引用]                                           |
|   67 | scripts/restore-hegelsalon.ps1                       | True    |   9602 |  161 | restore:production                                     |
|   68 | scripts/revoke-mcp-grants-after-restore.mjs          | True    |   3372 |   84 | [无直接引用]                                           |
|   69 | scripts/rewrite_cover_letter.py                      | True    |   1633 |   50 | [无直接引用]                                           |
|   70 | scripts/rewrite_cover_letter_batch.py                | True    |  44738 |  937 | [无直接引用]                                           |
|   71 | scripts/rollback-codex-local-connector.ps1           | False   |   4264 |  109 | [无直接引用]                                           |
|   72 | scripts/run_application_intelligence.py              | True    |   2581 |   59 | [无直接引用]                                           |
|   73 | scripts/run_audience_ai.py                           | True    |   5613 |  152 | [无直接引用]                                           |
|   74 | scripts/run_expansion_workspace.py                   | True    |   4563 |  106 | [无直接引用]                                           |
|   75 | scripts/run_external_cover_letter_batch.mjs          | True    |  45279 | 1028 | cover-letter:external-batch                            |
|   76 | scripts/run_external_cover_letter_until_complete.mjs | True    |   5727 |  173 | cover-letter:external-until-complete                   |
|   77 | scripts/run_local_cover_letter_batch.mjs             | True    |  10854 |  259 | [无直接引用]                                           |
|   78 | scripts/run_project_workflow.py                      | True    |  98149 | 2138 | [无直接引用]                                           |
|   79 | scripts/run-copilot-evals.mjs                        | True    |    583 |   11 | test:copilot-eval                                      |
|   80 | scripts/send-application-email-queue.mjs             | True    |  11294 |  284 | [无直接引用]                                           |
|   81 | scripts/start.ps1                                    | True    |    558 |   19 | [无直接引用]                                           |
|   82 | scripts/start.sh                                     | True    |    174 |   12 | [无直接引用]                                           |
|   83 | scripts/start-competition-windows.ps1                | True    |   2100 |   63 | [无直接引用]                                           |
|   84 | scripts/start-managed-browser.mjs                    | True    |   2219 |   55 | [无直接引用]                                           |
|   85 | scripts/start-production-windows.ps1                 | True    |  24221 |  421 | start:production                                       |
|   86 | scripts/stop-production-windows.ps1                  | True    |   3588 |   62 | stop:production                                        |
|   87 | scripts/verify-artifacts.mjs                         | True    |  13874 |  357 | verify:artifacts                                       |
|   88 | scripts/verify-codex-desktop-runtime.mjs             | False   |    652 |   14 | verify:codex-desktop                                   |
|   89 | scripts/verify-codex-local-connector.mjs             | False   |   4977 |  137 | verify:codex-connector                                 |
|   90 | scripts/verify-codex-transport-parity.mjs            | False   |  10276 |  293 | verify:codex:transport-parity                          |
|   91 | scripts/verify-github-release.ps1                    | True    |   5223 |  111 | [无直接引用]                                           |
|   92 | scripts/verify-mcp-production.mjs                    | True    |   4238 |  104 | verify:mcp                                             |
|   93 | scripts/verify-mcp-public-production.ps1             | True    |  10561 |  207 | [无直接引用]                                           |
|   94 | scripts/verify-mcp-public-showcase.mjs               | True    |   6339 |  154 | verify:mcp:showcase                                    |
|   95 | scripts/verify-production-browser.mjs                | True    |  12269 |  208 | [无直接引用]                                           |
|   96 | scripts/verify-public-package-mcp.ps1                | True    |   5077 |  155 | [无直接引用]                                           |
|   97 | scripts/workflow_state.py                            | True    |  61372 | 1413 | [无直接引用]                                           |

## 解释边界

- “无直接引用”不表示不可达；脚本可能由其他脚本、CI、文档或人工命令调用。
- 行数是当前工作树快照，不等于复杂度或个人贡献。
- untracked 脚本主要属于当前 Codex connector/device/runtime 扩展，需与 v3.0 主线分开。
