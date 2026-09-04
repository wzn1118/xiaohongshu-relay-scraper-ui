# 主仓库 Python 文件清单

来源：当前 scripts、tests、vendor 下 Python 文件，排除 **pycache**、output、data。类/函数/test/import 为静态行计数。

- Python 文件：68
- 总行数：50317
- 测试路径：31
- tracked：68
- untracked：0

| 序号 | 文件                                                                    | test  | tracked |   字节 |   行 | import | class | 顶层 def | test def |
| ---: | ----------------------------------------------------------------------- | ----- | ------- | -----: | ---: | -----: | ----: | -------: | -------: |
|    1 | scripts/ai_application_workflow.py                                      | False | True    | 174995 | 3531 |     21 |     1 |       92 |        0 |
|    2 | scripts/ai_provider_runtime.py                                          | False | True    |  39114 |  869 |     18 |     3 |        4 |        0 |
|    3 | scripts/application_generation.py                                       | False | True    |  16225 |  375 |      8 |     0 |       10 |        0 |
|    4 | scripts/application_intelligence_agents.py                              | False | True    |  98552 | 2159 |     13 |     5 |       30 |        0 |
|    5 | scripts/artifact_io.py                                                  | False | True    |   1309 |   36 |      7 |     0 |        1 |        0 |
|    6 | scripts/audience_ai_pipeline.py                                         | False | True    | 139825 | 3076 |     13 |    10 |       46 |        0 |
|    7 | scripts/audience_ai_schemas.py                                          | False | True    |  15722 |  467 |      3 |     0 |        2 |        0 |
|    8 | scripts/audience_collection.py                                          | False | True    | 116587 | 2562 |     15 |     0 |       60 |        0 |
|    9 | scripts/audience_profile_supplement.py                                  | False | True    |  19170 |  431 |      8 |     1 |       11 |        0 |
|   10 | scripts/audience_resume.py                                              | False | True    |  18466 |  485 |      4 |     0 |       21 |        0 |
|   11 | scripts/body_completion_ledger.py                                       | False | True    |  25659 |  630 |      9 |     1 |       11 |        0 |
|   12 | scripts/check_relay_connection.py                                       | False | True    |   2470 |   70 |      9 |     0 |        3 |        0 |
|   13 | scripts/codex_config.py                                                 | False | True    |   4000 |  102 |      6 |     0 |        4 |        0 |
|   14 | scripts/codex_runtime_outreach.py                                       | False | True    |  66212 | 1293 |     11 |     2 |       26 |        0 |
|   15 | scripts/copilot_attachment_helper.py                                    | False | True    |   5008 |  154 |      6 |     0 |        6 |        0 |
|   16 | scripts/copilot_xlsx_helper.py                                          | False | True    |   3869 |  108 |      5 |     0 |        5 |        0 |
|   17 | scripts/cover_letter_rewriter.py                                        | False | True    | 106808 | 2173 |     10 |     0 |       43 |        0 |
|   18 | scripts/evidence_claim_validator.py                                     | False | True    |  24383 |  603 |      5 |     0 |       16 |        0 |
|   19 | scripts/expansion_collection.py                                         | False | True    |  70354 | 1375 |     10 |     5 |        5 |        0 |
|   20 | scripts/job_role_title.py                                               | False | True    |   8187 |  151 |      3 |     0 |        2 |        0 |
|   21 | scripts/migrate_application_outreach.py                                 | False | True    |   9189 |  205 |      8 |     0 |       11 |        0 |
|   22 | scripts/note_identity.py                                                | False | True    |   2849 |   89 |      3 |     0 |        5 |        0 |
|   23 | scripts/parallel_body_completion.py                                     | False | True    |  93715 | 2119 |     20 |     3 |       29 |        0 |
|   24 | scripts/profile_memory.py                                               | False | True    |  32442 |  825 |     12 |     0 |       32 |        0 |
|   25 | scripts/recheck_application_draft.py                                    | False | True    |  11055 |  294 |      9 |     0 |       10 |        0 |
|   26 | scripts/resolve_application_contacts.py                                 | False | True    |  53074 | 1238 |     21 |     1 |       41 |        0 |
|   27 | scripts/rewrite_cover_letter.py                                         | False | True    |   1633 |   50 |      6 |     0 |        2 |        0 |
|   28 | scripts/rewrite_cover_letter_batch.py                                   | False | True    |  44738 |  937 |     10 |     0 |       29 |        0 |
|   29 | scripts/run_application_intelligence.py                                 | False | True    |   2581 |   59 |      5 |     0 |        2 |        0 |
|   30 | scripts/run_audience_ai.py                                              | False | True    |   5613 |  152 |      9 |     0 |        6 |        0 |
|   31 | scripts/run_expansion_workspace.py                                      | False | True    |   4563 |  106 |      8 |     0 |        5 |        0 |
|   32 | scripts/run_project_workflow.py                                         | False | True    |  98149 | 2138 |     23 |     0 |       51 |        0 |
|   33 | scripts/workflow_state.py                                               | False | True    |  61372 | 1413 |     12 |     4 |       37 |        0 |
|   34 | tests/fixtures/checkpoint_passthrough_runner.py                         | True  | True    |   1940 |   59 |      5 |     0 |        2 |        0 |
|   35 | tests/fixtures/mock_xiaohongshu_runner.py                               | True  | True    |  19984 |  477 |     16 |     0 |       23 |        0 |
|   36 | tests/test_ai_application_workflow.py                                   | True  | True    |  90630 | 1818 |      7 |    10 |        0 |       50 |
|   37 | tests/test_ai_provider_runtime.py                                       | True  | True    |  37288 |  904 |     23 |     1 |        2 |       27 |
|   38 | tests/test_application_generation.py                                    | True  | True    |   7412 |  165 |      3 |     1 |        0 |        7 |
|   39 | tests/test_application_intelligence_agents.py                           | True  | True    |  68236 | 1410 |     25 |     4 |        0 |       48 |
|   40 | tests/test_artifact_io.py                                               | True  | True    |   1850 |   49 |      7 |     0 |        2 |        2 |
|   41 | tests/test_audience_ai_pipeline.py                                      | True  | True    |  48333 | 1186 |      8 |     4 |       32 |       30 |
|   42 | tests/test_audience_collection.py                                       | True  | True    |  42674 | 1137 |      6 |     1 |       41 |       41 |
|   43 | tests/test_audience_profile_supplement.py                               | True  | True    |   4489 |  131 |      5 |     0 |        9 |        6 |
|   44 | tests/test_audience_resume.py                                           | True  | True    |  12089 |  333 |      3 |     0 |       14 |       12 |
|   45 | tests/test_audience_workflow_state.py                                   | True  | True    |   3868 |  105 |      2 |     0 |        1 |        1 |
|   46 | tests/test_body_completion_ledger.py                                    | True  | True    |  53328 | 1513 |     15 |     2 |       42 |       40 |
|   47 | tests/test_codex_runtime_outreach.py                                    | True  | True    |   2257 |   60 |      7 |     1 |        0 |        1 |
|   48 | tests/test_codex_runtime_prompt.py                                      | True  | True    |  40342 |  731 |      3 |     1 |        1 |       35 |
|   49 | tests/test_collection_pacing.py                                         | True  | True    |   1290 |   32 |      5 |     1 |        0 |        3 |
|   50 | tests/test_cover_letter_rewriter.py                                     | True  | True    |  33802 |  668 |      6 |     3 |        4 |       22 |
|   51 | tests/test_discovery_growth.py                                          | True  | True    |   1941 |   59 |      3 |     0 |        2 |        2 |
|   52 | tests/test_evidence_claim_validator.py                                  | True  | True    |  20249 |  488 |      8 |     1 |        3 |       17 |
|   53 | tests/test_expansion_collection.py                                      | True  | True    |  31021 |  787 |      9 |     1 |       32 |       26 |
|   54 | tests/test_job_role_title.py                                            | True  | True    |   4154 |  108 |      7 |     1 |        0 |        7 |
|   55 | tests/test_migrate_application_outreach.py                              | True  | True    |   2085 |   43 |      6 |     1 |        0 |        2 |
|   56 | tests/test_profile_memory.py                                            | True  | True    |  12054 |  261 |      6 |     1 |        0 |        8 |
|   57 | tests/test_recheck_application_draft.py                                 | True  | True    |  17733 |  398 |      8 |     2 |        1 |       13 |
|   58 | tests/test_relay_runner_streaming.py                                    | True  | True    |   1999 |   63 |      7 |     0 |        5 |        5 |
|   59 | tests/test_resolve_application_contacts.py                              | True  | True    |  16360 |  481 |      9 |     0 |       18 |       18 |
|   60 | tests/test_rewrite_cover_letter_batch.py                                | True  | True    |  20844 |  447 |      9 |     1 |        3 |       19 |
|   61 | tests/test_scraper_detail_readiness.py                                  | True  | True    |  10324 |  330 |      5 |     5 |       13 |       11 |
|   62 | tests/test_scraper_resume.py                                            | True  | True    |  23066 |  592 |      7 |     5 |       29 |       28 |
|   63 | tests/test_workflow_contracts.py                                        | True  | True    |   2888 |   95 |      7 |     0 |        5 |        3 |
|   64 | tests/test_workflow_state.py                                            | True  | True    |  32445 |  898 |     16 |     0 |       29 |       27 |
|   65 | vendor/xiaohongshu-relay-scrape/scripts/build_structured_excel.py       | False | True    |  21625 |  613 |     10 |     0 |       26 |        0 |
|   66 | vendor/xiaohongshu-relay-scrape/scripts/collection_pacing.py            | False | True    |   1599 |   47 |      2 |     0 |        2 |        0 |
|   67 | vendor/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py | False | True    |  61601 | 1563 |     19 |     1 |       64 |        0 |
|   68 | vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py    | False | True    |  78040 | 1991 |     20 |     2 |       59 |        0 |

## 当前最大十个 Python 文件

- scripts/ai_application_workflow.py：3531 行，class=1，顶层 def=92，test=False。
- scripts/audience_ai_pipeline.py：3076 行，class=10，顶层 def=46，test=False。
- scripts/audience_collection.py：2562 行，class=0，顶层 def=60，test=False。
- scripts/cover_letter_rewriter.py：2173 行，class=0，顶层 def=43，test=False。
- scripts/application_intelligence_agents.py：2159 行，class=5，顶层 def=30，test=False。
- scripts/run_project_workflow.py：2138 行，class=0，顶层 def=51，test=False。
- scripts/parallel_body_completion.py：2119 行，class=3，顶层 def=29，test=False。
- vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py：1991 行，class=2，顶层 def=59，test=False。
- tests/test_ai_application_workflow.py：1818 行，class=10，顶层 def=0，test=True。
- vendor/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py：1563 行，class=1，顶层 def=64，test=False。

## 解释边界

- 顶层 def 不包含类方法和嵌套函数。
- 行数和定义数量是当前源码规模，不是运行覆盖或质量指标。
