# 主仓库完整 tracked 文件清单

来源：git ls-files 与当前工作树文件大小，审计时间 2026-08-18。文件大小反映当前工作树版本；已修改文件的大小可能不同于 HEAD。

- tracked 路径数：515
- 当前存在的 tracked 文件：515
- 当前缺失的 tracked 路径：0
- 当前被修改/删除/暂存的 tracked 路径：22

## 顶层目录统计

| 顶层目录/文件                 | 路径数 | 当前字节数 |
| ----------------------------- | -----: | ---------: |
| server                        |    194 |    3964459 |
| scripts                       |     88 |    1955631 |
| tests                         |     81 |    4193050 |
| docs                          |     60 |    1690558 |
| src                           |     37 |    1626249 |
| public                        |      7 |     104314 |
| marketing                     |      5 |    1004055 |
| vendor                        |      5 |     163214 |
| config                        |      3 |       1374 |
| schemas                       |      3 |       9086 |
| .github                       |      2 |       4072 |
| deploy                        |      2 |       1008 |
| .env.example                  |      1 |       4545 |
| .env.production.example       |      1 |       3725 |
| .gitignore                    |      1 |        506 |
| completed-run.png             |      1 |     414508 |
| desktop-workflow.png          |      1 |     140212 |
| index.html                    |      1 |        535 |
| MCP_PACKAGE_INFO.json         |      1 |        822 |
| mcp-stdio.cmd                 |      1 |        447 |
| mobile-workflow.png           |      1 |      40567 |
| ONE_CLICK_START.md            |      1 |       2990 |
| package-lock.json             |      1 |     120136 |
| package.json                  |      1 |       5442 |
| playwright.config.ts          |      1 |       1966 |
| profiles                      |      1 |        602 |
| PUBLIC_RELEASE_README.md      |      1 |       3503 |
| pytest.ini                    |      1 |         83 |
| README.md                     |      1 |       2002 |
| requirements.txt              |      1 |        132 |
| start-competition-windows.cmd |      1 |        500 |
| start-linux-macos.sh          |      1 |        119 |
| start-mcp.cmd                 |      1 |        442 |
| start-production-windows.cmd  |      1 |        380 |
| start-windows.cmd             |      1 |        357 |
| tsconfig.app.json             |      1 |        638 |
| tsconfig.json                 |      1 |        119 |
| tsconfig.node.json            |      1 |        413 |
| verify-mcp.cmd                |      1 |        452 |
| vite.config.ts                |      1 |        794 |

## 扩展名统计

| 扩展名     | 路径数 | 当前字节数 |
| ---------- | -----: | ---------: |
| .mjs       |    226 |    4331300 |
| .py        |     68 |    2207728 |
| .png       |     57 |    5846636 |
| .md        |     46 |     642831 |
| .tsx       |     24 |    1096646 |
| .ps1       |     23 |     222537 |
| .ts        |     20 |     496481 |
| .json      |     13 |     141368 |
| .svg       |     10 |      56931 |
| .cmd       |      6 |       2578 |
| .txt       |      5 |      31540 |
| .sh        |      4 |       7366 |
| .yml       |      3 |       4594 |
| .example   |      2 |       8270 |
| .html      |      2 |      48581 |
| .css       |      1 |     316600 |
| .gitignore |      1 |        506 |
| .ini       |      1 |         83 |
| .mts       |      1 |        580 |
| .template  |      1 |        486 |
| .toml      |      1 |        365 |

## 完整路径表

| 序号 | 路径                                                                                 | 扩展名     | 当前字节 | 工作树状态 |
| ---: | ------------------------------------------------------------------------------------ | ---------- | -------: | ---------- |
|    1 | .env.example                                                                         | .example   |     4545 | M          |
|    2 | .env.production.example                                                              | .example   |     3725 | M          |
|    3 | .github/workflows/ci.yml                                                             | .yml       |     1676 | clean      |
|    4 | .github/workflows/release.yml                                                        | .yml       |     2396 | clean      |
|    5 | .gitignore                                                                           | .gitignore |      506 | clean      |
|    6 | MCP_PACKAGE_INFO.json                                                                | .json      |      822 | clean      |
|    7 | ONE_CLICK_START.md                                                                   | .md        |     2990 | clean      |
|    8 | PUBLIC_RELEASE_README.md                                                             | .md        |     3503 | clean      |
|    9 | README.md                                                                            | .md        |     2002 | clean      |
|   10 | completed-run.png                                                                    | .png       |   414508 | clean      |
|   11 | config/codex-config.example.toml                                                     | .toml      |      365 | clean      |
|   12 | config/copilot-mcp-servers.example.json                                              | .json      |      725 | clean      |
|   13 | config/mcp-client.example.json                                                       | .json      |      284 | clean      |
|   14 | deploy/cloudflared/config.template.yml                                               | .yml       |      522 | clean      |
|   15 | deploy/cloudflared/config.yml.template                                               | .template  |      486 | clean      |
|   16 | desktop-workflow.png                                                                 | .png       |   140212 | clean      |
|   17 | docs/AI_PRODUCT_MANAGER_EXPERIENCE.md                                                | .md        |    19634 | clean      |
|   18 | docs/APPLICATION_OUTREACH_FULL_UPGRADE_PLAN.md                                       | .md        |     8600 | clean      |
|   19 | docs/APPLICATION_OUTREACH_MIGRATION_RUNBOOK.md                                       | .md        |     1050 | clean      |
|   20 | docs/ARCHITECTURE.md                                                                 | .md        |     7086 | clean      |
|   21 | docs/AUDIENCE_AI_ACCEPTANCE_REPORT.md                                                | .md        |    34205 | clean      |
|   22 | docs/AUDIENCE_AI_REQUIREMENTS_TRACEABILITY.md                                        | .md        |    48085 | clean      |
|   23 | docs/BATCH_APPLICATION_WORKBENCH_V2_UPGRADE_PLAN.md                                  | .md        |    15880 | clean      |
|   24 | docs/BEGINNER_GUIDE.md                                                               | .md        |    11842 | clean      |
|   25 | docs/COMPETITION_SUBMISSION_TECHNICAL_GUIDE.md                                       | .md        |     9986 | clean      |
|   26 | docs/COVER_LETTER_V2_FULL_IMPLEMENTATION.md                                          | .md        |    15665 | clean      |
|   27 | docs/DATA_COPILOT_CAPABILITY_SUPPLEMENT_PLAN.md                                      | .md        |    46545 | clean      |
|   28 | docs/DATA_COPILOT_CODEX_WORKBENCH_IMPLEMENTATION.md                                  | .md        |     4837 | clean      |
|   29 | docs/DATA_COPILOT_OFFICIAL_RESEARCH.md                                               | .md        |    11663 | clean      |
|   30 | docs/DATA_COPILOT_UPGRADE_PLAN.md                                                    | .md        |    30466 | clean      |
|   31 | docs/HEGELSALON_PRODUCTION_RUNBOOK.md                                                | .md        |     9941 | clean      |
|   32 | docs/HEGELSALON_PUBLIC_DEPLOYMENT.md                                                 | .md        |     6060 | clean      |
|   33 | docs/LOCAL_MODEL_PUBLIC_DEPLOYMENT.md                                                | .md        |    10047 | clean      |
|   34 | docs/MCP_FULL_IMPLEMENTATION_SPEC.md                                                 | .md        |    73031 | clean      |
|   35 | docs/MCP_PUBLIC_PRODUCTION_ACCEPTANCE_20260810.md                                    | .md        |     7667 | clean      |
|   36 | docs/PHASE10_FINAL_ACCEPTANCE.md                                                     | .md        |    13161 | clean      |
|   37 | docs/PRD.html                                                                        | .html      |    48046 | clean      |
|   38 | docs/PRD.md                                                                          | .md        |    15567 | clean      |
|   39 | docs/PRODUCT_SPEC.md                                                                 | .md        |     2934 | clean      |
|   40 | docs/PUBLIC_DEPLOYMENT_IMPLEMENTATION_PLAN.md                                        | .md        |    19598 | clean      |
|   41 | docs/PUBLIC_RELEASE_API_AND_OPERATIONS.md                                            | .md        |     6996 | clean      |
|   42 | docs/PUBLIC_RELEASE_CHANGELOG_20260810.md                                            | .md        |     4536 | clean      |
|   43 | docs/PUBLIC_RELEASE_MCP_GUIDE.md                                                     | .md        |     5843 | clean      |
|   44 | docs/PUBLIC_RELEASE_PRODUCT_ADVANTAGES.md                                            | .md        |     5294 | clean      |
|   45 | docs/PUBLIC_RELEASE_QUICK_START.md                                                   | .md        |     5224 | clean      |
|   46 | docs/PUBLIC_RELEASE_TECHNICAL_GUIDE.md                                               | .md        |     7270 | clean      |
|   47 | docs/PUBLIC_RELEASE_VERIFICATION.md                                                  | .md        |     3846 | clean      |
|   48 | docs/USER_GUIDE.md                                                                   | .md        |    31485 | clean      |
|   49 | docs/adr/ADR-MCP-ANONYMOUS-SHOWCASE.md                                               | .md        |     1834 | clean      |
|   50 | docs/adr/ADR-MCP-CLOUDFLARE-PUBLIC-DATA-PLANE.md                                     | .md        |     4552 | clean      |
|   51 | docs/adr/ADR-MCP-LOCAL-DUAL-LISTENER.md                                              | .md        |     4369 | clean      |
|   52 | docs/jobseeker-collection-speed-progress-engineering-plan.md                         | .md        |    39857 | clean      |
|   53 | docs/managed-browser.md                                                              | .md        |     2375 | clean      |
|   54 | docs/phase6-data-lifecycle-report.md                                                 | .md        |    10357 | clean      |
|   55 | docs/prd-assets/agent-orchestration.svg                                              | .svg       |     6903 | clean      |
|   56 | docs/prd-assets/current-data-copilot.png                                             | .png       |    80907 | clean      |
|   57 | docs/prd-assets/current-job-search.png                                               | .png       |    90225 | clean      |
|   58 | docs/prd-assets/current-local-model.png                                              | .png       |    73948 | clean      |
|   59 | docs/prd-assets/current-non-job-research.png                                         | .png       |    73058 | clean      |
|   60 | docs/prd-assets/current-relay-setup.png                                              | .png       |    37380 | clean      |
|   61 | docs/prd-assets/current-smtp-setup.png                                               | .png       |    49634 | clean      |
|   62 | docs/prd-assets/current-task-resume.png                                              | .png       |    20186 | clean      |
|   63 | docs/prd-assets/data-flow.svg                                                        | .svg       |     9676 | clean      |
|   64 | docs/prd-assets/information-architecture.svg                                         | .svg       |     4679 | clean      |
|   65 | docs/prd-assets/module-dependency.svg                                                | .svg       |     7128 | clean      |
|   66 | docs/prd-assets/prd-mobile.png                                                       | .png       |    61277 | clean      |
|   67 | docs/prd-assets/prd-result-editor.png                                                | .png       |   195269 | clean      |
|   68 | docs/prd-assets/prd-workbench.png                                                    | .png       |   102478 | clean      |
|   69 | docs/prd-assets/product-architecture.svg                                             | .svg       |    10774 | clean      |
|   70 | docs/prd-assets/product-origin-ui.png                                                | .png       |   176791 | clean      |
|   71 | docs/prd-assets/quality-delivery-gate.svg                                            | .svg       |     5269 | clean      |
|   72 | docs/prd-assets/task-state-machine.svg                                               | .svg       |     5627 | clean      |
|   73 | docs/prd-assets/user-journey-flow.svg                                                | .svg       |     5326 | clean      |
|   74 | docs/prompts/audience-ai-analysis-10-stage-prompt.md                                 | .md        |    59273 | clean      |
|   75 | docs/prompts/background-profile-ai-spec.md                                           | .md        |     5708 | clean      |
|   76 | docs/prompts/background-profile-analysis-prompt.md                                   | .md        |     3608 | clean      |
|   77 | index.html                                                                           | .html      |      535 | clean      |
|   78 | marketing/xiaohongshu-assets/01-cover.png                                            | .png       |   217590 | clean      |
|   79 | marketing/xiaohongshu-assets/02-config.png                                           | .png       |   223709 | clean      |
|   80 | marketing/xiaohongshu-assets/03-result.png                                           | .png       |   411951 | clean      |
|   81 | marketing/xiaohongshu-assets/04-mobile.png                                           | .png       |   146705 | clean      |
|   82 | marketing/xiaohongshu-post.md                                                        | .md        |     4100 | clean      |
|   83 | mcp-stdio.cmd                                                                        | .cmd       |      447 | clean      |
|   84 | mobile-workflow.png                                                                  | .png       |    40567 | clean      |
|   85 | package-lock.json                                                                    | .json      |   120136 | M          |
|   86 | package.json                                                                         | .json      |     5442 | M          |
|   87 | playwright.config.ts                                                                 | .ts        |     1966 | clean      |
|   88 | profiles/candidate_profile.example.json                                              | .json      |      602 | clean      |
|   89 | public/brand/project-avatar-1024.png                                                 | .png       |    48421 | clean      |
|   90 | public/brand/project-avatar-256.png                                                  | .png       |    15326 | clean      |
|   91 | public/brand/project-avatar-32.png                                                   | .png       |     1440 | clean      |
|   92 | public/brand/project-avatar-512.png                                                  | .png       |    34559 | clean      |
|   93 | public/brand/project-avatar-64.png                                                   | .png       |     3019 | clean      |
|   94 | public/brand/project-avatar.svg                                                      | .svg       |     1161 | clean      |
|   95 | public/favicon.svg                                                                   | .svg       |      388 | clean      |
|   96 | pytest.ini                                                                           | .ini       |       83 | clean      |
|   97 | requirements.txt                                                                     | .txt       |      132 | clean      |
|   98 | schemas/user-problem-v1.schema.json                                                  | .json      |     1684 | clean      |
|   99 | schemas/workflow-event-v1.schema.json                                                | .json      |     3393 | clean      |
|  100 | schemas/workflow-snapshot-v3.schema.json                                             | .json      |     4009 | clean      |
|  101 | scripts/ai_application_workflow.py                                                   | .py        |   174995 | clean      |
|  102 | scripts/ai_provider_runtime.py                                                       | .py        |    39114 | clean      |
|  103 | scripts/application_generation.py                                                    | .py        |    16225 | clean      |
|  104 | scripts/application_intelligence_agents.py                                           | .py        |    98552 | clean      |
|  105 | scripts/artifact_io.py                                                               | .py        |     1309 | clean      |
|  106 | scripts/audience_ai_pipeline.py                                                      | .py        |   139825 | clean      |
|  107 | scripts/audience_ai_schemas.py                                                       | .py        |    15722 | clean      |
|  108 | scripts/audience_collection.py                                                       | .py        |   116587 | clean      |
|  109 | scripts/audience_profile_supplement.py                                               | .py        |    19170 | clean      |
|  110 | scripts/audience_resume.py                                                           | .py        |    18466 | clean      |
|  111 | scripts/backup-hegelsalon.ps1                                                        | .ps1       |     6139 | clean      |
|  112 | scripts/body_completion_ledger.py                                                    | .py        |    25659 | clean      |
|  113 | scripts/bootstrap.ps1                                                                | .ps1       |     1557 | clean      |
|  114 | scripts/bootstrap.sh                                                                 | .sh        |      753 | clean      |
|  115 | scripts/build-competition-index.mjs                                                  | .mjs       |     1239 | clean      |
|  116 | scripts/check-credentials.mjs                                                        | .mjs       |     1842 | clean      |
|  117 | scripts/check-format.mjs                                                             | .mjs       |     1091 | clean      |
|  118 | scripts/check_relay_connection.py                                                    | .py        |     2470 | clean      |
|  119 | scripts/codex_config.py                                                              | .py        |     4000 | clean      |
|  120 | scripts/codex_runtime_outreach.py                                                    | .py        |    66212 | clean      |
|  121 | scripts/configure-outlook-smtp.mjs                                                   | .mjs       |     6761 | clean      |
|  122 | scripts/copilot_attachment_helper.py                                                 | .py        |     5008 | clean      |
|  123 | scripts/copilot_xlsx_helper.py                                                       | .py        |     3869 | clean      |
|  124 | scripts/cover_letter_rewriter.py                                                     | .py        |   106808 | clean      |
|  125 | scripts/create-xhs-assets.ps1                                                        | .ps1       |     7779 | clean      |
|  126 | scripts/ensure-codex-config.ps1                                                      | .ps1       |     1161 | clean      |
|  127 | scripts/ensure-windows-prerequisites.ps1                                             | .ps1       |     9391 | clean      |
|  128 | scripts/evidence_claim_validator.py                                                  | .py        |    24383 | clean      |
|  129 | scripts/expansion_collection.py                                                      | .py        |    70354 | clean      |
|  130 | scripts/generate-tailored-application-mail-data.mjs                                  | .mjs       |    27028 | clean      |
|  131 | scripts/hegelsalon-common.ps1                                                        | .ps1       |    22614 | clean      |
|  132 | scripts/job_role_title.py                                                            | .py        |     8187 | clean      |
|  133 | scripts/lint.mjs                                                                     | .mjs       |     1043 | clean      |
|  134 | scripts/maintain-codex-mcp-grant.ps1                                                 | .ps1       |     4303 | clean      |
|  135 | scripts/mcp-stdio-bridge.mjs                                                         | .mjs       |     3065 | clean      |
|  136 | scripts/migrate_application_outreach.py                                              | .py        |     9189 | clean      |
|  137 | scripts/note_identity.py                                                             | .py        |     2849 | clean      |
|  138 | scripts/one-click.ps1                                                                | .ps1       |    19645 | clean      |
|  139 | scripts/one-click.sh                                                                 | .sh        |     6320 | clean      |
|  140 | scripts/package-competition-submission.ps1                                           | .ps1       |    22698 | clean      |
|  141 | scripts/package-github-release.ps1                                                   | .ps1       |     4106 | clean      |
|  142 | scripts/package-windows-production.ps1                                               | .ps1       |    27210 | clean      |
|  143 | scripts/parallel_body_completion.py                                                  | .py        |    93715 | clean      |
|  144 | scripts/preflight.mjs                                                                | .mjs       |     2689 | clean      |
|  145 | scripts/prepare-portable-runtime.ps1                                                 | .ps1       |     8984 | clean      |
|  146 | scripts/production-watchdog.ps1                                                      | .ps1       |    12736 | clean      |
|  147 | scripts/profile_memory.py                                                            | .py        |    32442 | clean      |
|  148 | scripts/prompts/cover_letter_agent_v4_full_zh.txt                                    | .txt       |    17680 | clean      |
|  149 | scripts/prompts/cover_letter_agent_v4_zh.txt                                         | .txt       |    10413 | clean      |
|  150 | scripts/prompts/cover_letter_batch_ascii_en.txt                                      | .txt       |     2238 | clean      |
|  151 | scripts/prompts/cover_letter_batch_compact_zh.txt                                    | .txt       |     1077 | clean      |
|  152 | scripts/provision-auth.mjs                                                           | .mjs       |      842 | clean      |
|  153 | scripts/provision-hegelsalon-relay-tunnel.ps1                                        | .ps1       |     8447 | clean      |
|  154 | scripts/recheck_application_draft.py                                                 | .py        |    11055 | clean      |
|  155 | scripts/record-all-features-workflow.mjs                                             | .mjs       |    73323 | clean      |
|  156 | scripts/record-complete-workflow.mjs                                                 | .mjs       |    54280 | clean      |
|  157 | scripts/record-core-workflow.mjs                                                     | .mjs       |    15729 | clean      |
|  158 | scripts/register-startup.ps1                                                         | .ps1       |     4837 | clean      |
|  159 | scripts/replay-application-email-subjects.mjs                                        | .mjs       |    11093 | clean      |
|  160 | scripts/repo-files.mjs                                                               | .mjs       |      478 | clean      |
|  161 | scripts/resolve_application_contacts.py                                              | .py        |    53074 | clean      |
|  162 | scripts/restore-hegelsalon.ps1                                                       | .ps1       |     9602 | clean      |
|  163 | scripts/revoke-mcp-grants-after-restore.mjs                                          | .mjs       |     3372 | clean      |
|  164 | scripts/rewrite_cover_letter.py                                                      | .py        |     1633 | clean      |
|  165 | scripts/rewrite_cover_letter_batch.py                                                | .py        |    44738 | clean      |
|  166 | scripts/run-copilot-evals.mjs                                                        | .mjs       |      583 | clean      |
|  167 | scripts/run_application_intelligence.py                                              | .py        |     2581 | clean      |
|  168 | scripts/run_audience_ai.py                                                           | .py        |     5613 | clean      |
|  169 | scripts/run_expansion_workspace.py                                                   | .py        |     4563 | clean      |
|  170 | scripts/run_external_cover_letter_batch.mjs                                          | .mjs       |    45279 | clean      |
|  171 | scripts/run_external_cover_letter_until_complete.mjs                                 | .mjs       |     5727 | clean      |
|  172 | scripts/run_local_cover_letter_batch.mjs                                             | .mjs       |    10854 | clean      |
|  173 | scripts/run_project_workflow.py                                                      | .py        |    98149 | clean      |
|  174 | scripts/send-application-email-queue.mjs                                             | .mjs       |    11294 | clean      |
|  175 | scripts/start-competition-windows.ps1                                                | .ps1       |     2100 | clean      |
|  176 | scripts/start-managed-browser.mjs                                                    | .mjs       |     2219 | clean      |
|  177 | scripts/start-production-windows.ps1                                                 | .ps1       |    24221 | clean      |
|  178 | scripts/start.ps1                                                                    | .ps1       |      558 | clean      |
|  179 | scripts/start.sh                                                                     | .sh        |      174 | clean      |
|  180 | scripts/stop-production-windows.ps1                                                  | .ps1       |     3588 | clean      |
|  181 | scripts/verify-artifacts.mjs                                                         | .mjs       |    13874 | clean      |
|  182 | scripts/verify-github-release.ps1                                                    | .ps1       |     5223 | clean      |
|  183 | scripts/verify-mcp-production.mjs                                                    | .mjs       |     4238 | clean      |
|  184 | scripts/verify-mcp-public-production.ps1                                             | .ps1       |    10561 | clean      |
|  185 | scripts/verify-mcp-public-showcase.mjs                                               | .mjs       |     6339 | clean      |
|  186 | scripts/verify-production-browser.mjs                                                | .mjs       |    12269 | clean      |
|  187 | scripts/verify-public-package-mcp.ps1                                                | .ps1       |     5077 | clean      |
|  188 | scripts/workflow_state.py                                                            | .py        |    61372 | clean      |
|  189 | server/ai-session-store.mjs                                                          | .mjs       |    18592 | clean      |
|  190 | server/ai-session-store.test.mjs                                                     | .mjs       |    11979 | clean      |
|  191 | server/app-security.test.mjs                                                         | .mjs       |    21738 | M          |
|  192 | server/app.mjs                                                                       | .mjs       |   332701 | M          |
|  193 | server/app.test.mjs                                                                  | .mjs       |    54436 | clean      |
|  194 | server/application-attachments.test.mjs                                              | .mjs       |    20398 | clean      |
|  195 | server/application-batch-manager.mjs                                                 | .mjs       |    42450 | clean      |
|  196 | server/application-batch-manager.test.mjs                                            | .mjs       |    17622 | clean      |
|  197 | server/application-batch-service.mjs                                                 | .mjs       |    59568 | clean      |
|  198 | server/application-batch-service.test.mjs                                            | .mjs       |    48689 | clean      |
|  199 | server/application-contact-ocr-service.mjs                                           | .mjs       |     9311 | clean      |
|  200 | server/application-contact-ocr-service.test.mjs                                      | .mjs       |     6074 | clean      |
|  201 | server/application-contact-resolution-service.mjs                                    | .mjs       |     5406 | clean      |
|  202 | server/application-contact-resolution-service.test.mjs                               | .mjs       |     3218 | clean      |
|  203 | server/application-contact-resolver.test.mjs                                         | .mjs       |    19232 | clean      |
|  204 | server/application-delivery-candidates.mjs                                           | .mjs       |    22083 | clean      |
|  205 | server/application-delivery-candidates.test.mjs                                      | .mjs       |    15136 | clean      |
|  206 | server/application-results.test.mjs                                                  | .mjs       |    38119 | clean      |
|  207 | server/audience-ai-artifacts.test.mjs                                                | .mjs       |     8342 | clean      |
|  208 | server/audience-ai-profile-runner.test.mjs                                           | .mjs       |     5284 | clean      |
|  209 | server/audience-ai-service.mjs                                                       | .mjs       |    56870 | clean      |
|  210 | server/audience-ai.test.mjs                                                          | .mjs       |    35513 | clean      |
|  211 | server/audience-cursor-artifact.test.mjs                                             | .mjs       |     3516 | clean      |
|  212 | server/audience-results.test.mjs                                                     | .mjs       |    19103 | clean      |
|  213 | server/audience-workflow-state.test.mjs                                              | .mjs       |     3347 | clean      |
|  214 | server/auth-store.mjs                                                                | .mjs       |     8626 | clean      |
|  215 | server/auth-store.test.mjs                                                           | .mjs       |     2962 | clean      |
|  216 | server/body-import.test.mjs                                                          | .mjs       |     5361 | clean      |
|  217 | server/config.mjs                                                                    | .mjs       |    18554 | M          |
|  218 | server/contracts.test.mjs                                                            | .mjs       |    19830 | clean      |
|  219 | server/copilot-agent-kernel.mjs                                                      | .mjs       |     7499 | clean      |
|  220 | server/copilot-agent-kernel.test.mjs                                                 | .mjs       |     2583 | clean      |
|  221 | server/copilot-approval-store.mjs                                                    | .mjs       |    18307 | clean      |
|  222 | server/copilot-approval-store.test.mjs                                               | .mjs       |     8638 | clean      |
|  223 | server/copilot-artifact-service.mjs                                                  | .mjs       |    55511 | clean      |
|  224 | server/copilot-artifact-service.test.mjs                                             | .mjs       |    15602 | clean      |
|  225 | server/copilot-capability-resolver.mjs                                               | .mjs       |     6294 | clean      |
|  226 | server/copilot-capability-resolver.test.mjs                                          | .mjs       |     4291 | clean      |
|  227 | server/copilot-context-source.mjs                                                    | .mjs       |     8430 | clean      |
|  228 | server/copilot-context-source.test.mjs                                               | .mjs       |     3104 | clean      |
|  229 | server/copilot-execution-dispatcher.test.mjs                                         | .mjs       |    20904 | clean      |
|  230 | server/copilot-execution-worker-supervisor.test.mjs                                  | .mjs       |    11979 | clean      |
|  231 | server/copilot-production.test.mjs                                                   | .mjs       |     7062 | clean      |
|  232 | server/copilot-protocol.test.mjs                                                     | .mjs       |    12263 | M          |
|  233 | server/copilot-runtime-v2.test.mjs                                                   | .mjs       |     8332 | clean      |
|  234 | server/copilot-runtime-v3-contracts.test.mjs                                         | .mjs       |    16292 | clean      |
|  235 | server/copilot/answer-ast.mjs                                                        | .mjs       |     6622 | clean      |
|  236 | server/copilot/capability-runtime.mjs                                                | .mjs       |    11046 | clean      |
|  237 | server/copilot/capability-runtime.test.mjs                                           | .mjs       |     5126 | clean      |
|  238 | server/copilot/compaction-service.mjs                                                | .mjs       |     2546 | clean      |
|  239 | server/copilot/context-manager.mjs                                                   | .mjs       |     8859 | clean      |
|  240 | server/copilot/conversation-repository.mjs                                           | .mjs       |      896 | clean      |
|  241 | server/copilot/evaluation-suite.mjs                                                  | .mjs       |     7262 | clean      |
|  242 | server/copilot/event-log.mjs                                                         | .mjs       |     2599 | clean      |
|  243 | server/copilot/evidence-graph.mjs                                                    | .mjs       |     6968 | clean      |
|  244 | server/copilot/execution-dispatcher.mjs                                              | .mjs       |    43686 | clean      |
|  245 | server/copilot/execution-handler-registry.mjs                                        | .mjs       |     7803 | clean      |
|  246 | server/copilot/execution-worker-supervisor.mjs                                       | .mjs       |    12242 | clean      |
|  247 | server/copilot/git-tool-adapter.mjs                                                  | .mjs       |    28645 | clean      |
|  248 | server/copilot/git-tool-adapter.test.mjs                                             | .mjs       |     7428 | clean      |
|  249 | server/copilot/git-worktree-manager.mjs                                              | .mjs       |    10079 | clean      |
|  250 | server/copilot/git-worktree-manager.test.mjs                                         | .mjs       |     2637 | clean      |
|  251 | server/copilot/mcp-client-manager.mjs                                                | .mjs       |    29557 | clean      |
|  252 | server/copilot/mcp-client-manager.test.mjs                                           | .mjs       |    10926 | clean      |
|  253 | server/copilot/model-gateway.mjs                                                     | .mjs       |    16568 | M          |
|  254 | server/copilot/model-run-broker.mjs                                                  | .mjs       |    24002 | M          |
|  255 | server/copilot/model-turn-ledger.mjs                                                 | .mjs       |    19739 | clean      |
|  256 | server/copilot/model-turn-ledger.test.mjs                                            | .mjs       |     5780 | clean      |
|  257 | server/copilot/orchestrator.mjs                                                      | .mjs       |    11048 | clean      |
|  258 | server/copilot/production-store.mjs                                                  | .mjs       |    49736 | clean      |
|  259 | server/copilot/project-workspace-http.test.mjs                                       | .mjs       |    27028 | clean      |
|  260 | server/copilot/project-workspace-runtime-binding.test.mjs                            | .mjs       |    11472 | clean      |
|  261 | server/copilot/project-workspace-service.mjs                                         | .mjs       |    21044 | clean      |
|  262 | server/copilot/project-workspace-service.test.mjs                                    | .mjs       |     5885 | clean      |
|  263 | server/copilot/run-coordinator.mjs                                                   | .mjs       |    15390 | clean      |
|  264 | server/copilot/runtime-v3/execution-context.mjs                                      | .mjs       |     4612 | clean      |
|  265 | server/copilot/runtime-v3/index.mjs                                                  | .mjs       |      864 | clean      |
|  266 | server/copilot/runtime-v3/repository.mjs                                             | .mjs       |    64222 | clean      |
|  267 | server/copilot/runtime-v3/runtime-event.mjs                                          | .mjs       |     2207 | clean      |
|  268 | server/copilot/sandbox.mjs                                                           | .mjs       |    12121 | clean      |
|  269 | server/copilot/skills.mjs                                                            | .mjs       |     1697 | clean      |
|  270 | server/copilot/specialists.mjs                                                       | .mjs       |     1110 | clean      |
|  271 | server/copilot/subagent-runtime.mjs                                                  | .mjs       |    47252 | clean      |
|  272 | server/copilot/terminal-session-manager.mjs                                          | .mjs       |    34985 | clean      |
|  273 | server/copilot/terminal-session-manager.test.mjs                                     | .mjs       |     7934 | clean      |
|  274 | server/copilot/token-counter.mjs                                                     | .mjs       |     1982 | clean      |
|  275 | server/copilot/tool-execution-broker.mjs                                             | .mjs       |    60465 | clean      |
|  276 | server/copilot/tool-execution-broker.test.mjs                                        | .mjs       |    64763 | clean      |
|  277 | server/copilot/tool-execution-ledger.mjs                                             | .mjs       |    13428 | clean      |
|  278 | server/copilot/unified-tool-registry.mjs                                             | .mjs       |     6924 | clean      |
|  279 | server/copilot/unified-tool-registry.test.mjs                                        | .mjs       |     7185 | clean      |
|  280 | server/copilot/usage-tracker.mjs                                                     | .mjs       |     1594 | clean      |
|  281 | server/copilot/verifier.mjs                                                          | .mjs       |     5654 | clean      |
|  282 | server/copilot/workspace-tool-adapter.mjs                                            | .mjs       |    46677 | clean      |
|  283 | server/copilot/workspace-tool-adapter.test.mjs                                       | .mjs       |    12724 | clean      |
|  284 | server/cover-letter-rewriter.test.mjs                                                | .mjs       |     6325 | clean      |
|  285 | server/data-copilot-execution-api.test.mjs                                           | .mjs       |    11762 | clean      |
|  286 | server/data-copilot-http.mjs                                                         | .mjs       |    30667 | clean      |
|  287 | server/data-copilot-http.test.mjs                                                    | .mjs       |    35483 | clean      |
|  288 | server/data-copilot-runtime.mjs                                                      | .mjs       |   119358 | M          |
|  289 | server/data-copilot-runtime.test.mjs                                                 | .mjs       |    59469 | M          |
|  290 | server/data-copilot-service.mjs                                                      | .mjs       |   147644 | M          |
|  291 | server/data-copilot-service.test.mjs                                                 | .mjs       |    22596 | M          |
|  292 | server/data-copilot-store.mjs                                                        | .mjs       |    33261 | clean      |
|  293 | server/data-copilot-store.test.mjs                                                   | .mjs       |    10930 | clean      |
|  294 | server/data-lifecycle-http.test.mjs                                                  | .mjs       |     7003 | clean      |
|  295 | server/data-lifecycle-runtime.test.mjs                                               | .mjs       |     4498 | clean      |
|  296 | server/data-lifecycle-service.mjs                                                    | .mjs       |    30226 | clean      |
|  297 | server/data-lifecycle-service.test.mjs                                               | .mjs       |    21922 | clean      |
|  298 | server/data-policy-engine.mjs                                                        | .mjs       |     7710 | clean      |
|  299 | server/data-policy-engine.test.mjs                                                   | .mjs       |     1058 | clean      |
|  300 | server/data-tool-registry.mjs                                                        | .mjs       |    71480 | clean      |
|  301 | server/data-tool-registry.test.mjs                                                   | .mjs       |    18676 | clean      |
|  302 | server/diagnostics.test.mjs                                                          | .mjs       |     2127 | clean      |
|  303 | server/draft-http.test.mjs                                                           | .mjs       |   125285 | clean      |
|  304 | server/draft-quality-checker.test.mjs                                                | .mjs       |     4790 | clean      |
|  305 | server/draft-store.test.mjs                                                          | .mjs       |    12513 | clean      |
|  306 | server/expansion-results.test.mjs                                                    | .mjs       |     7496 | clean      |
|  307 | server/index.mjs                                                                     | .mjs       |    19682 | M          |
|  308 | server/job-experience-http.test.mjs                                                  | .mjs       |     9111 | clean      |
|  309 | server/job-experience.test.mjs                                                       | .mjs       |    17038 | clean      |
|  310 | server/job-manager.mjs                                                               | .mjs       |   185586 | clean      |
|  311 | server/job-manager.test.mjs                                                          | .mjs       |   124051 | clean      |
|  312 | server/job-sse.test.mjs                                                              | .mjs       |     9152 | clean      |
|  313 | server/lib/application-attachment-rule.mjs                                           | .mjs       |    18851 | clean      |
|  314 | server/lib/application-attachment-rule.test.mjs                                      | .mjs       |    11199 | clean      |
|  315 | server/lib/application-attachments.mjs                                               | .mjs       |    42889 | clean      |
|  316 | server/lib/application-contact-resolver.mjs                                          | .mjs       |    32370 | clean      |
|  317 | server/lib/application-email-draft.mjs                                               | .mjs       |    37203 | clean      |
|  318 | server/lib/application-email-draft.test.mjs                                          | .mjs       |    21946 | clean      |
|  319 | server/lib/application-records.mjs                                                   | .mjs       |     1901 | clean      |
|  320 | server/lib/application-source-disposition.mjs                                        | .mjs       |     4730 | clean      |
|  321 | server/lib/application-source-disposition.test.mjs                                   | .mjs       |     3926 | clean      |
|  322 | server/lib/artifacts.mjs                                                             | .mjs       |     3068 | clean      |
|  323 | server/lib/audience-ai-artifacts.mjs                                                 | .mjs       |    14216 | clean      |
|  324 | server/lib/audience-ai-contracts.mjs                                                 | .mjs       |     8606 | clean      |
|  325 | server/lib/audience-ai-input.mjs                                                     | .mjs       |    20827 | clean      |
|  326 | server/lib/audience-ai-profile-enrichment.mjs                                        | .mjs       |     4287 | clean      |
|  327 | server/lib/audience-ai-profile-runner.mjs                                            | .mjs       |    11170 | clean      |
|  328 | server/lib/audience-ai-store.mjs                                                     | .mjs       |    24942 | clean      |
|  329 | server/lib/audience-results.mjs                                                      | .mjs       |    19199 | clean      |
|  330 | server/lib/body-import.mjs                                                           | .mjs       |    11019 | clean      |
|  331 | server/lib/contracts.mjs                                                             | .mjs       |    22192 | clean      |
|  332 | server/lib/cover-letter-rewriter.mjs                                                 | .mjs       |     7205 | clean      |
|  333 | server/lib/diagnostics.mjs                                                           | .mjs       |     4732 | clean      |
|  334 | server/lib/draft-quality-checker.mjs                                                 | .mjs       |     6409 | clean      |
|  335 | server/lib/draft-store.mjs                                                           | .mjs       |    18694 | clean      |
|  336 | server/lib/expansion-results.mjs                                                     | .mjs       |     8747 | clean      |
|  337 | server/lib/job-experience.mjs                                                        | .mjs       |    36003 | clean      |
|  338 | server/lib/native-browser.mjs                                                        | .mjs       |    10736 | clean      |
|  339 | server/lib/proxy-aware-fetch.mjs                                                     | .mjs       |     7802 | clean      |
|  340 | server/lib/proxy-aware-fetch.test.mjs                                                | .mjs       |     1445 | clean      |
|  341 | server/lib/relay-connect.mjs                                                         | .mjs       |     8392 | clean      |
|  342 | server/lib/relay-recovery.mjs                                                        | .mjs       |     8859 | clean      |
|  343 | server/lib/relay-setup.mjs                                                           | .mjs       |     2847 | clean      |
|  344 | server/lib/relay-supervisor.mjs                                                      | .mjs       |    11913 | clean      |
|  345 | server/lib/relay-targets.mjs                                                         | .mjs       |     2944 | clean      |
|  346 | server/lib/relay.mjs                                                                 | .mjs       |     2963 | clean      |
|  347 | server/lib/workflow-state.mjs                                                        | .mjs       |    30418 | clean      |
|  348 | server/local-model-manager.mjs                                                       | .mjs       |    12958 | clean      |
|  349 | server/local-model-manager.test.mjs                                                  | .mjs       |     4507 | clean      |
|  350 | server/mail-sender.mjs                                                               | .mjs       |    10490 | clean      |
|  351 | server/mail-sender.test.mjs                                                          | .mjs       |     7107 | clean      |
|  352 | server/mailpit.integration.mjs                                                       | .mjs       |    38044 | clean      |
|  353 | server/mcp-access-service.mjs                                                        | .mjs       |    35629 | clean      |
|  354 | server/mcp-access-service.test.mjs                                                   | .mjs       |    14438 | clean      |
|  355 | server/mcp-data-adapter.mjs                                                          | .mjs       |     9471 | clean      |
|  356 | server/mcp-http-server.mjs                                                           | .mjs       |    17804 | clean      |
|  357 | server/mcp-http-server.test.mjs                                                      | .mjs       |    12411 | clean      |
|  358 | server/mcp-management-http.mjs                                                       | .mjs       |     5626 | clean      |
|  359 | server/mcp-management-http.test.mjs                                                  | .mjs       |     4674 | clean      |
|  360 | server/mcp-public-showcase.mjs                                                       | .mjs       |    10636 | clean      |
|  361 | server/mcp-stdio-bridge.test.mjs                                                     | .mjs       |     4420 | clean      |
|  362 | server/model-run-broker-runtime-integration.test.mjs                                 | .mjs       |     7386 | clean      |
|  363 | server/model-run-broker.test.mjs                                                     | .mjs       |     9334 | clean      |
|  364 | server/native-browser.test.mjs                                                       | .mjs       |     1890 | clean      |
|  365 | server/preflight-http.test.mjs                                                       | .mjs       |     5659 | clean      |
|  366 | server/preflight-service.mjs                                                         | .mjs       |    16456 | clean      |
|  367 | server/preflight-service.test.mjs                                                    | .mjs       |     7434 | clean      |
|  368 | server/profile-store.mjs                                                             | .mjs       |     7434 | clean      |
|  369 | server/profile-store.test.mjs                                                        | .mjs       |     4570 | clean      |
|  370 | server/relay-app-concurrency.test.mjs                                                | .mjs       |     2516 | clean      |
|  371 | server/relay-config-store.mjs                                                        | .mjs       |     2512 | clean      |
|  372 | server/relay-config-store.test.mjs                                                   | .mjs       |     2340 | clean      |
|  373 | server/relay-connect.test.mjs                                                        | .mjs       |     5075 | clean      |
|  374 | server/relay-setup.test.mjs                                                          | .mjs       |     1654 | clean      |
|  375 | server/relay-supervisor.test.mjs                                                     | .mjs       |     5337 | clean      |
|  376 | server/relay-targets.test.mjs                                                        | .mjs       |     2403 | clean      |
|  377 | server/smtp-config-store.mjs                                                         | .mjs       |    29017 | clean      |
|  378 | server/smtp-config-store.test.mjs                                                    | .mjs       |    15538 | clean      |
|  379 | server/smtp-persistence-http.test.mjs                                                | .mjs       |     9457 | clean      |
|  380 | server/subagent-runtime-lifecycle.test.mjs                                           | .mjs       |     7448 | clean      |
|  381 | server/subagent-runtime-security.test.mjs                                            | .mjs       |    26358 | clean      |
|  382 | server/workflow-state.test.mjs                                                       | .mjs       |    12707 | clean      |
|  383 | src/App.tsx                                                                          | .tsx       |   410118 | M          |
|  384 | src/AudienceAiPanel.tsx                                                              | .tsx       |    50948 | clean      |
|  385 | src/BatchApplicationPanel.tsx                                                        | .tsx       |   118981 | clean      |
|  386 | src/BodyImportPanel.tsx                                                              | .tsx       |     5099 | clean      |
|  387 | src/CopilotMcpSettings.tsx                                                           | .tsx       |    24331 | clean      |
|  388 | src/CopilotProjectWorkspacePanel.tsx                                                 | .tsx       |    62296 | clean      |
|  389 | src/DataCopilotContext.tsx                                                           | .tsx       |    22220 | M          |
|  390 | src/DataCopilotContextBrowser.tsx                                                    | .tsx       |    33218 | clean      |
|  391 | src/DataCopilotMessage.tsx                                                           | .tsx       |   101095 | clean      |
|  392 | src/DataCopilotPanel.tsx                                                             | .tsx       |   128350 | clean      |
|  393 | src/ExpansionWorkspace.tsx                                                           | .tsx       |    20607 | clean      |
|  394 | src/JobJourneyPanel.tsx                                                              | .tsx       |    15749 | clean      |
|  395 | src/McpAccessPanel.tsx                                                               | .tsx       |    29587 | clean      |
|  396 | src/UnsavedDraftDialog.tsx                                                           | .tsx       |     2072 | clean      |
|  397 | src/api.ts                                                                           | .ts        |    35257 | M          |
|  398 | src/body-import.ts                                                                   | .ts        |     3449 | clean      |
|  399 | src/copilot/ActivityTimeline.tsx                                                     | .tsx       |     1585 | clean      |
|  400 | src/copilot/AgentWorkbench.tsx                                                       | .tsx       |    12762 | clean      |
|  401 | src/copilot/EvidenceInspector.tsx                                                    | .tsx       |     1918 | clean      |
|  402 | src/copilot/ExecutionTimeline.tsx                                                    | .tsx       |     2709 | clean      |
|  403 | src/copilot/PlanView.tsx                                                             | .tsx       |     2589 | clean      |
|  404 | src/copilot/QualityPanel.tsx                                                         | .tsx       |    15196 | clean      |
|  405 | src/copilot/RunBar.tsx                                                               | .tsx       |     3494 | clean      |
|  406 | src/copilot/TaskInspector.tsx                                                        | .tsx       |    26277 | clean      |
|  407 | src/copilot/TaskRunHeader.tsx                                                        | .tsx       |     5218 | clean      |
|  408 | src/copilot/answer-ast.ts                                                            | .ts        |     3559 | clean      |
|  409 | src/copilot/project-workspace-api.ts                                                 | .ts        |    12749 | clean      |
|  410 | src/copilot/useCopilotEventProjection.ts                                             | .ts        |    12038 | clean      |
|  411 | src/copilot/workbench-types.ts                                                       | .ts        |     1384 | clean      |
|  412 | src/data-copilot-transport.ts                                                        | .ts        |    59497 | clean      |
|  413 | src/draft-state.d.mts                                                                | .mts       |      580 | clean      |
|  414 | src/draft-state.mjs                                                                  | .mjs       |     4128 | clean      |
|  415 | src/job-experience.ts                                                                | .ts        |    19636 | clean      |
|  416 | src/main.tsx                                                                         | .tsx       |      227 | clean      |
|  417 | src/styles.css                                                                       | .css       |   316600 | M          |
|  418 | src/types.ts                                                                         | .ts        |    55046 | clean      |
|  419 | src/useUnsavedDraftGuard.ts                                                          | .ts        |     5680 | clean      |
|  420 | start-competition-windows.cmd                                                        | .cmd       |      500 | clean      |
|  421 | start-linux-macos.sh                                                                 | .sh        |      119 | clean      |
|  422 | start-mcp.cmd                                                                        | .cmd       |      442 | clean      |
|  423 | start-production-windows.cmd                                                         | .cmd       |      380 | clean      |
|  424 | start-windows.cmd                                                                    | .cmd       |      357 | clean      |
|  425 | tests/README.md                                                                      | .md        |     3910 | clean      |
|  426 | tests/credential-scan.test.mjs                                                       | .mjs       |      770 | clean      |
|  427 | tests/data-copilot-transport.test.mjs                                                | .mjs       |    23120 | clean      |
|  428 | tests/draft-state.test.mjs                                                           | .mjs       |     1654 | clean      |
|  429 | tests/e2e/app-runtime-smoke.spec.ts                                                  | .ts        |     2181 | clean      |
|  430 | tests/e2e/audience-ai.spec.ts                                                        | .ts        |    25196 | clean      |
|  431 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1024x768-audience-ai-panel-linux.png | .png       |   155557 | clean      |
|  432 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1024x768-audience-ai-panel-win32.png | .png       |   136379 | clean      |
|  433 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1024x900-audience-ai-panel-linux.png | .png       |   155495 | clean      |
|  434 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1024x900-audience-ai-panel-win32.png | .png       |   136318 | clean      |
|  435 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1440x900-audience-ai-panel-linux.png | .png       |   157506 | clean      |
|  436 | tests/e2e/audience-ai.spec.ts-snapshots/desktop-1440x900-audience-ai-panel-win32.png | .png       |   136736 | clean      |
|  437 | tests/e2e/audience-ai.spec.ts-snapshots/mobile-390x844-audience-ai-panel-linux.png   | .png       |   151573 | clean      |
|  438 | tests/e2e/audience-ai.spec.ts-snapshots/mobile-390x844-audience-ai-panel-win32.png   | .png       |   132819 | clean      |
|  439 | tests/e2e/audience-ai.spec.ts-snapshots/tablet-768x1024-audience-ai-panel-linux.png  | .png       |   154298 | clean      |
|  440 | tests/e2e/audience-ai.spec.ts-snapshots/tablet-768x1024-audience-ai-panel-win32.png  | .png       |   134220 | clean      |
|  441 | tests/e2e/batch-application-workbench.spec.ts                                        | .ts        |    88718 | clean      |
|  442 | tests/e2e/data-copilot.spec.ts                                                       | .ts        |    81901 | M          |
|  443 | tests/e2e/expansion-workspace.spec.ts                                                | .ts        |    17294 | clean      |
|  444 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-idle-linux.png      | .png       |    88565 | clean      |
|  445 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-idle-win32.png      | .png       |    78574 | clean      |
|  446 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-partial-linux.png   | .png       |   117604 | clean      |
|  447 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-partial-win32.png   | .png       |   103502 | clean      |
|  448 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-running-linux.png   | .png       |    96150 | clean      |
|  449 | tests/e2e/expansion-workspace.spec.ts-snapshots/desktop-1440x900-running-win32.png   | .png       |    85793 | clean      |
|  450 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-idle-linux.png        | .png       |    92287 | clean      |
|  451 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-idle-win32.png        | .png       |    78464 | clean      |
|  452 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-partial-linux.png     | .png       |   102839 | clean      |
|  453 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-partial-win32.png     | .png       |    87674 | clean      |
|  454 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-running-linux.png     | .png       |    96026 | clean      |
|  455 | tests/e2e/expansion-workspace.spec.ts-snapshots/mobile-390x844-running-win32.png     | .png       |    82561 | clean      |
|  456 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-idle-linux.png       | .png       |    89085 | clean      |
|  457 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-idle-win32.png       | .png       |    78620 | clean      |
|  458 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-partial-linux.png    | .png       |   100633 | clean      |
|  459 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-partial-win32.png    | .png       |    88363 | clean      |
|  460 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-running-linux.png    | .png       |    94162 | clean      |
|  461 | tests/e2e/expansion-workspace.spec.ts-snapshots/tablet-768x1024-running-win32.png    | .png       |    83819 | clean      |
|  462 | tests/e2e/job-journey-progress.spec.ts                                               | .ts        |    15000 | clean      |
|  463 | tests/e2e/profile-ai-live.spec.ts                                                    | .ts        |     1921 | clean      |
|  464 | tests/e2e/unsaved-draft-guard.spec.ts                                                | .ts        |    53215 | M          |
|  465 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/desktop-1440x900-linux.png           | .png       |    16660 | clean      |
|  466 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/desktop-1440x900-win32.png           | .png       |    13871 | clean      |
|  467 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/mobile-390x844-linux.png             | .png       |    16814 | clean      |
|  468 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/mobile-390x844-win32.png             | .png       |    14056 | clean      |
|  469 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/tablet-768x1024-linux.png            | .png       |    16615 | clean      |
|  470 | tests/e2e/unsaved-draft-guard.spec.ts-snapshots/tablet-768x1024-win32.png            | .png       |    13838 | clean      |
|  471 | tests/fixtures/checkpoint_passthrough_runner.py                                      | .py        |     1940 | clean      |
|  472 | tests/fixtures/mock_xiaohongshu_runner.py                                            | .py        |    19984 | clean      |
|  473 | tests/fixtures/workflow/body-events.json                                             | .json      |     3101 | clean      |
|  474 | tests/mcp-restore-revocation.test.mjs                                                | .mjs       |     2782 | clean      |
|  475 | tests/mock-runner.test.mjs                                                           | .mjs       |     6364 | clean      |
|  476 | tests/one-click-launcher.test.mjs                                                    | .mjs       |    11472 | clean      |
|  477 | tests/test_ai_application_workflow.py                                                | .py        |    90630 | clean      |
|  478 | tests/test_ai_provider_runtime.py                                                    | .py        |    37288 | clean      |
|  479 | tests/test_application_generation.py                                                 | .py        |     7412 | clean      |
|  480 | tests/test_application_intelligence_agents.py                                        | .py        |    68236 | clean      |
|  481 | tests/test_artifact_io.py                                                            | .py        |     1850 | clean      |
|  482 | tests/test_audience_ai_pipeline.py                                                   | .py        |    48333 | clean      |
|  483 | tests/test_audience_collection.py                                                    | .py        |    42674 | clean      |
|  484 | tests/test_audience_profile_supplement.py                                            | .py        |     4489 | clean      |
|  485 | tests/test_audience_resume.py                                                        | .py        |    12089 | clean      |
|  486 | tests/test_audience_workflow_state.py                                                | .py        |     3868 | clean      |
|  487 | tests/test_body_completion_ledger.py                                                 | .py        |    53328 | clean      |
|  488 | tests/test_codex_runtime_outreach.py                                                 | .py        |     2257 | clean      |
|  489 | tests/test_codex_runtime_prompt.py                                                   | .py        |    40342 | clean      |
|  490 | tests/test_collection_pacing.py                                                      | .py        |     1290 | clean      |
|  491 | tests/test_cover_letter_rewriter.py                                                  | .py        |    33802 | clean      |
|  492 | tests/test_discovery_growth.py                                                       | .py        |     1941 | clean      |
|  493 | tests/test_evidence_claim_validator.py                                               | .py        |    20249 | clean      |
|  494 | tests/test_expansion_collection.py                                                   | .py        |    31021 | clean      |
|  495 | tests/test_job_role_title.py                                                         | .py        |     4154 | clean      |
|  496 | tests/test_migrate_application_outreach.py                                           | .py        |     2085 | clean      |
|  497 | tests/test_profile_memory.py                                                         | .py        |    12054 | clean      |
|  498 | tests/test_recheck_application_draft.py                                              | .py        |    17733 | clean      |
|  499 | tests/test_relay_runner_streaming.py                                                 | .py        |     1999 | clean      |
|  500 | tests/test_resolve_application_contacts.py                                           | .py        |    16360 | clean      |
|  501 | tests/test_rewrite_cover_letter_batch.py                                             | .py        |    20844 | clean      |
|  502 | tests/test_scraper_detail_readiness.py                                               | .py        |    10324 | clean      |
|  503 | tests/test_scraper_resume.py                                                         | .py        |    23066 | clean      |
|  504 | tests/test_workflow_contracts.py                                                     | .py        |     2888 | clean      |
|  505 | tests/test_workflow_state.py                                                         | .py        |    32445 | clean      |
|  506 | tsconfig.app.json                                                                    | .json      |      638 | clean      |
|  507 | tsconfig.json                                                                        | .json      |      119 | clean      |
|  508 | tsconfig.node.json                                                                   | .json      |      413 | clean      |
|  509 | vendor/xiaohongshu-relay-scrape/README.md                                            | .md        |      349 | clean      |
|  510 | vendor/xiaohongshu-relay-scrape/scripts/build_structured_excel.py                    | .py        |    21625 | clean      |
|  511 | vendor/xiaohongshu-relay-scrape/scripts/collection_pacing.py                         | .py        |     1599 | clean      |
|  512 | vendor/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py              | .py        |    61601 | clean      |
|  513 | vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py                 | .py        |    78040 | clean      |
|  514 | verify-mcp.cmd                                                                       | .cmd       |      452 | clean      |
|  515 | vite.config.ts                                                                       | .ts        |      794 | M          |

## 解释边界

- 路径数量与字节数是规模快照，不代表功能质量或个人贡献。
- clean 只表示相对 Git index/HEAD 无状态项，不表示文件经过本轮测试。
