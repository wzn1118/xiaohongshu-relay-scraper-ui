# 主仓库 Node 服务文件清单

来源：当前 server/ 下 mjs/js 文件。测试标记依据路径/文件名，import/export/test 是静态近似。

- 文件数：229
- 总行数：105364
- 测试文件：109
- tracked：194
- untracked：35

| 序号 | 文件                                                      | test  | tracked |   字节 | 行数 | import | export | test/it 近似数 |
| ---: | --------------------------------------------------------- | ----- | ------- | -----: | ---: | -----: | -----: | -------------: |
|    1 | server/ai-session-store.mjs                               | False | True    |  18592 |  470 |      5 |      2 |              1 |
|    2 | server/ai-session-store.test.mjs                          | True  | True    |  11979 |  331 |      6 |      0 |             17 |
|    3 | server/app.mjs                                            | False | True    | 334074 | 7368 |     39 |      9 |             49 |
|    4 | server/app.test.mjs                                       | True  | True    |  54436 | 1185 |      8 |      0 |              6 |
|    5 | server/application-attachments.test.mjs                   | True  | True    |  20398 |  437 |      9 |      0 |             13 |
|    6 | server/application-batch-manager.mjs                      | False | True    |  42450 |  988 |      4 |      5 |              8 |
|    7 | server/application-batch-manager.test.mjs                 | True  | True    |  17622 |  373 |      6 |      0 |             13 |
|    8 | server/application-batch-service.mjs                      | False | True    |  59568 | 1452 |      5 |      4 |              8 |
|    9 | server/application-batch-service.test.mjs                 | True  | True    |  48689 | 1170 |     11 |      0 |             33 |
|   10 | server/application-contact-ocr-service.mjs                | False | True    |   9311 |  234 |      5 |      1 |              2 |
|   11 | server/application-contact-ocr-service.test.mjs           | True  | True    |   6074 |  141 |      8 |      0 |              3 |
|   12 | server/application-contact-resolution-service.mjs         | False | True    |   5406 |  157 |      2 |      1 |              0 |
|   13 | server/application-contact-resolution-service.test.mjs    | True  | True    |   3218 |   76 |      6 |      0 |              2 |
|   14 | server/application-contact-resolver.test.mjs              | True  | True    |  19232 |  487 |      6 |      0 |             21 |
|   15 | server/application-delivery-candidates.mjs                | False | True    |  22083 |  499 |      2 |      8 |              2 |
|   16 | server/application-delivery-candidates.test.mjs           | True  | True    |  15136 |  364 |      3 |      0 |             14 |
|   17 | server/application-results.test.mjs                       | True  | True    |  38119 |  812 |      7 |      0 |             11 |
|   18 | server/app-security.test.mjs                              | True  | True    |  24157 |  571 |      5 |      0 |             12 |
|   19 | server/audience-ai.test.mjs                               | True  | True    |  35513 |  768 |     15 |      0 |             13 |
|   20 | server/audience-ai-artifacts.test.mjs                     | True  | True    |   8342 |  205 |      7 |      0 |              4 |
|   21 | server/audience-ai-profile-runner.test.mjs                | True  | True    |   5284 |  132 |      9 |      0 |              2 |
|   22 | server/audience-ai-service.mjs                            | False | True    |  56870 | 1314 |      9 |      2 |              1 |
|   23 | server/audience-cursor-artifact.test.mjs                  | True  | True    |   3516 |   81 |      6 |      0 |              1 |
|   24 | server/audience-results.test.mjs                          | True  | True    |  19103 |  360 |      6 |      0 |              8 |
|   25 | server/audience-workflow-state.test.mjs                   | True  | True    |   3347 |   81 |      6 |      0 |              2 |
|   26 | server/auth-store.mjs                                     | False | True    |   8626 |  221 |      4 |      1 |              1 |
|   27 | server/auth-store.test.mjs                                | True  | True    |   2962 |   57 |      6 |      0 |              3 |
|   28 | server/body-import.test.mjs                               | True  | True    |   5361 |  120 |      9 |      0 |              5 |
|   29 | server/codex-app-server-transport.mjs                     | False | False   |   8904 |  253 |      5 |      3 |              3 |
|   30 | server/codex-app-server-transport.test.mjs                | True  | False   |   4092 |  101 |      5 |      0 |              3 |
|   31 | server/codex-browser-host.test.mjs                        | True  | False   |   1358 |   23 |      4 |      0 |              1 |
|   32 | server/codex-browser-service.mjs                          | False | False   |   5462 |  155 |      4 |      1 |              3 |
|   33 | server/codex-browser-service.test.mjs                     | True  | False   |   7661 |  210 |      5 |      0 |              4 |
|   34 | server/codex-canonical-adapter.mjs                        | False | False   |   7699 |  199 |      0 |      3 |              1 |
|   35 | server/codex-canonical-adapter.test.mjs                   | True  | False   |   4068 |   84 |      3 |      0 |              5 |
|   36 | server/codex-connect-service.mjs                          | False | False   |  13091 |  362 |      1 |      3 |              2 |
|   37 | server/codex-connect-service.test.mjs                     | True  | False   |   5247 |  130 |      7 |      0 |              2 |
|   38 | server/codex-desktop-service.mjs                          | False | False   |   5929 |  194 |      3 |      3 |              0 |
|   39 | server/codex-desktop-service.test.mjs                     | True  | False   |   3712 |  102 |      7 |      0 |              2 |
|   40 | server/codex-device-gateway-service.mjs                   | False | False   |  33407 |  877 |      4 |      3 |             12 |
|   41 | server/codex-device-gateway-service.test.mjs              | True  | False   |   9773 |  215 |      8 |      0 |              4 |
|   42 | server/codex-git-worker-service.mjs                       | False | False   |  55479 | 1283 |      4 |      3 |              7 |
|   43 | server/codex-git-worker-service.test.mjs                  | True  | False   |  18901 |  429 |      8 |      0 |              7 |
|   44 | server/codex-host-command-service.mjs                     | False | False   |  14964 |  410 |      4 |      3 |              1 |
|   45 | server/codex-host-command-service.test.mjs                | True  | False   |   4557 |  112 |      3 |      0 |              4 |
|   46 | server/codex-host-rpc-service.mjs                         | False | False   |  11773 |  325 |      1 |      3 |              0 |
|   47 | server/codex-host-rpc-service.test.mjs                    | True  | False   |   7576 |  181 |      6 |      0 |              2 |
|   48 | server/codex-ice-service.mjs                              | False | False   |   4800 |  117 |      1 |      3 |              0 |
|   49 | server/codex-ice-service.test.mjs                         | True  | False   |   1827 |   34 |      4 |      0 |              2 |
|   50 | server/codex-native-input-service.mjs                     | False | False   |  15408 |  307 |      1 |      3 |              1 |
|   51 | server/codex-native-input-service.test.mjs                | True  | False   |   1771 |   37 |      3 |      0 |              3 |
|   52 | server/codex-native-mirror-service.mjs                    | False | False   |  16286 |  413 |      1 |      3 |              1 |
|   53 | server/codex-native-mirror-service.test.mjs               | True  | False   |   8240 |  179 |      3 |      0 |              6 |
|   54 | server/codex-product-service.mjs                          | False | False   |  20899 |  365 |      6 |      6 |              1 |
|   55 | server/codex-product-service.test.mjs                     | True  | False   |   9374 |  150 |      7 |      0 |              3 |
|   56 | server/codex-protocol-evidence.mjs                        | False | False   |   4203 |  119 |      3 |      2 |              0 |
|   57 | server/codex-protocol-evidence.test.mjs                   | True  | False   |   3133 |   77 |      6 |      0 |              3 |
|   58 | server/codex-relay-service.mjs                            | False | False   |  27397 |  740 |      1 |      3 |              2 |
|   59 | server/codex-relay-service.test.mjs                       | True  | False   |  13763 |  314 |      3 |      0 |              7 |
|   60 | server/codex-runtime-compatibility.mjs                    | False | False   |  12349 |  313 |      3 |      3 |              0 |
|   61 | server/codex-runtime-compatibility.test.mjs               | True  | False   |   5662 |  103 |      6 |      0 |              3 |
|   62 | server/config.mjs                                         | False | True    |  18554 |  347 |      3 |      2 |              1 |
|   63 | server/contracts.test.mjs                                 | True  | True    |  19830 |  408 |      5 |      0 |             25 |
|   64 | server/copilot/answer-ast.mjs                             | False | True    |   6622 |  147 |      1 |      6 |              9 |
|   65 | server/copilot/capability-runtime.mjs                     | False | True    |  11046 |  318 |      1 |      3 |              1 |
|   66 | server/copilot/capability-runtime.test.mjs                | True  | True    |   5126 |  113 |      3 |      0 |              4 |
|   67 | server/copilot/compaction-service.mjs                     | False | True    |   2546 |   58 |      2 |      2 |              0 |
|   68 | server/copilot/context-manager.mjs                        | False | True    |   8859 |  204 |      2 |      3 |              1 |
|   69 | server/copilot/conversation-repository.mjs                | False | True    |    896 |   12 |      0 |      2 |              0 |
|   70 | server/copilot/evaluation-suite.mjs                       | False | True    |   7262 |   89 |      2 |      2 |              0 |
|   71 | server/copilot/event-log.mjs                              | False | True    |   2599 |   63 |      1 |      4 |              0 |
|   72 | server/copilot/evidence-graph.mjs                         | False | True    |   6968 |  151 |      0 |      2 |              0 |
|   73 | server/copilot/execution-dispatcher.mjs                   | False | True    |  43686 | 1134 |      3 |      4 |              0 |
|   74 | server/copilot/execution-handler-registry.mjs             | False | True    |   7803 |  229 |      0 |      4 |              0 |
|   75 | server/copilot/execution-worker-supervisor.mjs            | False | True    |  12242 |  345 |      0 |      3 |              0 |
|   76 | server/copilot/git-tool-adapter.mjs                       | False | True    |  28645 |  810 |      3 |      3 |              6 |
|   77 | server/copilot/git-tool-adapter.test.mjs                  | True  | True    |   7428 |  171 |      8 |      0 |              5 |
|   78 | server/copilot/git-worktree-manager.mjs                   | False | True    |  10079 |  265 |      5 |      3 |              2 |
|   79 | server/copilot/git-worktree-manager.test.mjs              | True  | True    |   2637 |   56 |      8 |      0 |              2 |
|   80 | server/copilot/mcp-client-manager.mjs                     | False | True    |  29557 |  744 |      6 |      7 |              4 |
|   81 | server/copilot/mcp-client-manager.test.mjs                | True  | True    |  10926 |  277 |      7 |      0 |              8 |
|   82 | server/copilot/model-gateway.mjs                          | False | True    |  16568 |  317 |      0 |      3 |              1 |
|   83 | server/copilot/model-run-broker.mjs                       | False | True    |  24002 |  596 |      2 |      3 |              1 |
|   84 | server/copilot/model-turn-ledger.mjs                      | False | True    |  19739 |  539 |      2 |      2 |              1 |
|   85 | server/copilot/model-turn-ledger.test.mjs                 | True  | True    |   5780 |  154 |      8 |      0 |              2 |
|   86 | server/copilot/orchestrator.mjs                           | False | True    |  11048 |  213 |      0 |      4 |              1 |
|   87 | server/copilot/production-store.mjs                       | False | True    |  49736 | 1165 |      4 |      2 |              0 |
|   88 | server/copilot/project-workspace-http.test.mjs            | True  | True    |  27028 |  601 |     21 |      0 |              6 |
|   89 | server/copilot/project-workspace-runtime-binding.test.mjs | True  | True    |  11472 |  293 |     16 |      0 |              3 |
|   90 | server/copilot/project-workspace-service.mjs              | False | True    |  21044 |  578 |      4 |      3 |              2 |
|   91 | server/copilot/project-workspace-service.test.mjs         | True  | True    |   5885 |  113 |      6 |      0 |              4 |
|   92 | server/copilot/run-coordinator.mjs                        | False | True    |  15390 |  354 |      2 |      2 |              0 |
|   93 | server/copilot/runtime-v3/execution-context.mjs           | False | True    |   4612 |  116 |      1 |      7 |              0 |
|   94 | server/copilot/runtime-v3/index.mjs                       | False | True    |    864 |   34 |      0 |      6 |              0 |
|   95 | server/copilot/runtime-v3/repository.mjs                  | False | True    |  64222 | 1573 |      6 |      2 |              0 |
|   96 | server/copilot/runtime-v3/runtime-event.mjs               | False | True    |   2207 |   63 |      1 |      2 |              0 |
|   97 | server/copilot/sandbox.mjs                                | False | True    |  12121 |  231 |      1 |      8 |              4 |
|   98 | server/copilot/skills.mjs                                 | False | True    |   1697 |   28 |      0 |      2 |              0 |
|   99 | server/copilot/specialists.mjs                            | False | True    |   1110 |   19 |      0 |      2 |              0 |
|  100 | server/copilot/subagent-runtime.mjs                       | False | True    |  47252 | 1144 |      6 |      2 |              1 |
|  101 | server/copilot/terminal-session-manager.mjs               | False | True    |  34985 |  863 |      5 |      3 |              3 |
|  102 | server/copilot/terminal-session-manager.test.mjs          | True  | True    |   7934 |  195 |      7 |      0 |              7 |
|  103 | server/copilot/token-counter.mjs                          | False | True    |   1982 |   43 |      0 |      3 |              0 |
|  104 | server/copilot/tool-execution-broker.mjs                  | False | True    |  60465 | 1500 |      2 |      5 |              1 |
|  105 | server/copilot/tool-execution-broker.test.mjs             | True  | True    |  64763 | 1794 |      8 |      0 |             31 |
|  106 | server/copilot/tool-execution-ledger.mjs                  | False | True    |  13428 |  372 |      2 |      2 |              1 |
|  107 | server/copilot/unified-tool-registry.mjs                  | False | True    |   6924 |  187 |      1 |      2 |              0 |
|  108 | server/copilot/unified-tool-registry.test.mjs             | True  | True    |   7185 |  162 |      3 |      0 |              4 |
|  109 | server/copilot/usage-tracker.mjs                          | False | True    |   1594 |   34 |      0 |      2 |              0 |
|  110 | server/copilot/verifier.mjs                               | False | True    |   5654 |  113 |      2 |      2 |              0 |
|  111 | server/copilot/workspace-tool-adapter.mjs                 | False | True    |  46677 | 1149 |      4 |      2 |             16 |
|  112 | server/copilot/workspace-tool-adapter.test.mjs            | True  | True    |  12724 |  339 |      8 |      0 |              8 |
|  113 | server/copilot-agent-kernel.mjs                           | False | True    |   7499 |  175 |      1 |      8 |              3 |
|  114 | server/copilot-agent-kernel.test.mjs                      | True  | True    |   2583 |   61 |      3 |      0 |              3 |
|  115 | server/copilot-approval-store.mjs                         | False | True    |  18307 |  434 |      4 |      3 |              2 |
|  116 | server/copilot-approval-store.test.mjs                    | True  | True    |   8638 |  201 |      7 |      0 |              6 |
|  117 | server/copilot-artifact-service.mjs                       | False | True    |  55511 | 1890 |      7 |      6 |             10 |
|  118 | server/copilot-artifact-service.test.mjs                  | True  | True    |  15602 |  440 |      9 |      0 |              8 |
|  119 | server/copilot-capability-resolver.mjs                    | False | True    |   6294 |  127 |      0 |      2 |              2 |
|  120 | server/copilot-capability-resolver.test.mjs               | True  | True    |   4291 |   92 |      3 |      0 |              5 |
|  121 | server/copilot-context-source.mjs                         | False | True    |   8430 |  193 |      0 |      5 |              1 |
|  122 | server/copilot-context-source.test.mjs                    | True  | True    |   3104 |   68 |      3 |      0 |              4 |
|  123 | server/copilot-execution-dispatcher.test.mjs              | True  | True    |  20904 |  473 |      7 |      0 |             11 |
|  124 | server/copilot-execution-worker-supervisor.test.mjs       | True  | True    |  11979 |  372 |      6 |      0 |              5 |
|  125 | server/copilot-production.test.mjs                        | True  | True    |   7062 |  123 |     12 |      0 |              4 |
|  126 | server/copilot-protocol.test.mjs                          | True  | True    |  12263 |  227 |     13 |      0 |             13 |
|  127 | server/copilot-runtime-v2.test.mjs                        | True  | True    |   8332 |  165 |      9 |      0 |              4 |
|  128 | server/copilot-runtime-v3-contracts.test.mjs              | True  | True    |  16292 |  407 |      8 |      0 |              7 |
|  129 | server/cover-letter-rewriter.test.mjs                     | True  | True    |   6325 |  190 |      6 |      0 |              4 |
|  130 | server/data-copilot-execution-api.test.mjs                | True  | True    |  11762 |  333 |      9 |      0 |              2 |
|  131 | server/data-copilot-http.mjs                              | False | True    |  30667 |  816 |      2 |      2 |              0 |
|  132 | server/data-copilot-http.test.mjs                         | True  | True    |  35483 |  781 |     15 |      0 |             15 |
|  133 | server/data-copilot-runtime.mjs                           | False | True    | 119358 | 2602 |      5 |      3 |              1 |
|  134 | server/data-copilot-runtime.test.mjs                      | True  | True    |  59469 | 1397 |     11 |      0 |             27 |
|  135 | server/data-copilot-service.mjs                           | False | True    | 147644 | 3467 |     20 |      4 |              3 |
|  136 | server/data-copilot-service.test.mjs                      | True  | True    |  22596 |  535 |     10 |      0 |             13 |
|  137 | server/data-copilot-store.mjs                             | False | True    |  33261 |  838 |      3 |     15 |              4 |
|  138 | server/data-copilot-store.test.mjs                        | True  | True    |  10930 |  270 |      6 |      0 |              8 |
|  139 | server/data-lifecycle-http.test.mjs                       | True  | True    |   7003 |  191 |      4 |      0 |              3 |
|  140 | server/data-lifecycle-runtime.test.mjs                    | True  | True    |   4498 |  131 |      9 |      0 |              3 |
|  141 | server/data-lifecycle-service.mjs                         | False | True    |  30226 |  780 |      4 |      2 |             10 |
|  142 | server/data-lifecycle-service.test.mjs                    | True  | True    |  21922 |  447 |      9 |      0 |             26 |
|  143 | server/data-policy-engine.mjs                             | False | True    |   7710 |  189 |      0 |      3 |              0 |
|  144 | server/data-policy-engine.test.mjs                        | True  | True    |   1058 |   37 |      3 |      0 |              1 |
|  145 | server/data-tool-registry.mjs                             | False | True    |  71480 | 1990 |      8 |      2 |              3 |
|  146 | server/data-tool-registry.test.mjs                        | True  | True    |  18676 |  503 |      6 |      0 |              9 |
|  147 | server/diagnostics.test.mjs                               | True  | True    |   2127 |   54 |      6 |      0 |              3 |
|  148 | server/draft-http.test.mjs                                | True  | True    | 125285 | 2916 |     13 |      0 |             58 |
|  149 | server/draft-quality-checker.test.mjs                     | True  | True    |   4790 |  165 |      6 |      0 |              5 |
|  150 | server/draft-store.test.mjs                               | True  | True    |  12513 |  352 |      3 |      0 |             17 |
|  151 | server/expansion-results.test.mjs                         | True  | True    |   7496 |  125 |      6 |      0 |              3 |
|  152 | server/index.mjs                                          | False | True    |  19724 |  433 |     54 |      0 |              0 |
|  153 | server/job-experience.test.mjs                            | True  | True    |  17038 |  400 |      8 |      0 |             11 |
|  154 | server/job-experience-http.test.mjs                       | True  | True    |   9111 |  244 |      5 |      0 |              3 |
|  155 | server/job-manager.mjs                                    | False | True    | 185586 | 4482 |     11 |      5 |             11 |
|  156 | server/job-manager.test.mjs                               | True  | True    | 124051 | 3016 |     12 |      0 |             51 |
|  157 | server/job-sse.test.mjs                                   | True  | True    |   9152 |  263 |      4 |      0 |              6 |
|  158 | server/lib/application-attachment-rule.mjs                | False | True    |  18851 |  496 |      1 |      5 |              8 |
|  159 | server/lib/application-attachment-rule.test.mjs           | True  | True    |  11199 |  265 |      3 |      0 |             14 |
|  160 | server/lib/application-attachments.mjs                    | False | True    |  42889 | 1041 |      6 |     19 |              7 |
|  161 | server/lib/application-contact-resolver.mjs               | False | True    |  32370 |  969 |      3 |      4 |              6 |
|  162 | server/lib/application-email-draft.mjs                    | False | True    |  37203 |  759 |      1 |     12 |             37 |
|  163 | server/lib/application-email-draft.test.mjs               | True  | True    |  21946 |  462 |      3 |      0 |             26 |
|  164 | server/lib/application-records.mjs                        | False | True    |   1901 |   42 |      0 |      2 |              0 |
|  165 | server/lib/application-source-disposition.mjs             | False | True    |   4730 |  122 |      1 |      3 |              6 |
|  166 | server/lib/application-source-disposition.test.mjs        | True  | True    |   3926 |   91 |      3 |      0 |              7 |
|  167 | server/lib/artifacts.mjs                                  | False | True    |   3068 |   80 |      2 |      5 |              2 |
|  168 | server/lib/audience-ai-artifacts.mjs                      | False | True    |  14216 |  347 |      4 |      3 |              1 |
|  169 | server/lib/audience-ai-contracts.mjs                      | False | True    |   8606 |  218 |      0 |      7 |              3 |
|  170 | server/lib/audience-ai-input.mjs                          | False | True    |  20827 |  484 |      4 |      4 |              0 |
|  171 | server/lib/audience-ai-profile-enrichment.mjs             | False | True    |   4287 |   96 |      0 |      4 |              1 |
|  172 | server/lib/audience-ai-profile-runner.mjs                 | False | True    |  11170 |  296 |      5 |      1 |              0 |
|  173 | server/lib/audience-ai-store.mjs                          | False | True    |  24942 |  659 |      3 |      2 |              0 |
|  174 | server/lib/audience-results.mjs                           | False | True    |  19199 |  479 |      3 |      2 |              5 |
|  175 | server/lib/body-import.mjs                                | False | True    |  11019 |  275 |      1 |      1 |              2 |
|  176 | server/lib/contracts.mjs                                  | False | True    |  22192 |  480 |      0 |      7 |              9 |
|  177 | server/lib/cover-letter-rewriter.mjs                      | False | True    |   7205 |  189 |      2 |      2 |              0 |
|  178 | server/lib/diagnostics.mjs                                | False | True    |   4732 |  131 |      3 |      2 |              2 |
|  179 | server/lib/draft-quality-checker.mjs                      | False | True    |   6409 |  177 |      2 |      2 |              0 |
|  180 | server/lib/draft-store.mjs                                | False | True    |  18694 |  506 |      1 |     13 |              1 |
|  181 | server/lib/expansion-results.mjs                          | False | True    |   8747 |  171 |      4 |      3 |              0 |
|  182 | server/lib/job-experience.mjs                             | False | True    |  36003 |  774 |      0 |      8 |             13 |
|  183 | server/lib/native-browser.mjs                             | False | True    |  10736 |  287 |      5 |      5 |              1 |
|  184 | server/lib/proxy-aware-fetch.mjs                          | False | True    |   7802 |  206 |      3 |      2 |              0 |
|  185 | server/lib/proxy-aware-fetch.test.mjs                     | True  | True    |   1445 |   29 |      3 |      0 |              3 |
|  186 | server/lib/relay.mjs                                      | False | True    |   2963 |   82 |      3 |      2 |              0 |
|  187 | server/lib/relay-connect.mjs                              | False | True    |   8392 |  237 |      4 |      3 |              1 |
|  188 | server/lib/relay-recovery.mjs                             | False | True    |   8859 |  250 |      4 |      3 |              0 |
|  189 | server/lib/relay-setup.mjs                                | False | True    |   2847 |   94 |      2 |      1 |              0 |
|  190 | server/lib/relay-supervisor.mjs                           | False | True    |  11913 |  347 |      3 |      2 |              0 |
|  191 | server/lib/relay-targets.mjs                              | False | True    |   2944 |   74 |      0 |      3 |              6 |
|  192 | server/lib/workflow-state.mjs                             | False | True    |  30418 |  810 |      3 |     10 |              0 |
|  193 | server/local-model-manager.mjs                            | False | True    |  12958 |  388 |      1 |      2 |              6 |
|  194 | server/local-model-manager.test.mjs                       | True  | True    |   4507 |   95 |      3 |      0 |              4 |
|  195 | server/mailpit.integration.mjs                            | True  | True    |  38044 |  876 |     14 |      0 |              2 |
|  196 | server/mail-sender.mjs                                    | False | True    |  10490 |  282 |      1 |      3 |              7 |
|  197 | server/mail-sender.test.mjs                               | True  | True    |   7107 |  174 |      3 |      0 |              9 |
|  198 | server/mcp-access-service.mjs                             | False | True    |  35629 |  828 |      3 |      1 |              0 |
|  199 | server/mcp-access-service.test.mjs                        | True  | True    |  14438 |  275 |      7 |      0 |              5 |
|  200 | server/mcp-data-adapter.mjs                               | False | True    |   9471 |  245 |      1 |      1 |              0 |
|  201 | server/mcp-http-server.mjs                                | False | True    |  17804 |  476 |      6 |      1 |              0 |
|  202 | server/mcp-http-server.test.mjs                           | True  | True    |  12411 |  299 |      6 |      0 |              3 |
|  203 | server/mcp-management-http.mjs                            | False | True    |   5626 |  155 |      0 |      1 |              0 |
|  204 | server/mcp-management-http.test.mjs                       | True  | True    |   4674 |  107 |      4 |      0 |              1 |
|  205 | server/mcp-public-showcase.mjs                            | False | True    |  10636 |  279 |      0 |      1 |              0 |
|  206 | server/mcp-stdio-bridge.test.mjs                          | True  | True    |   4420 |   99 |     10 |      0 |              1 |
|  207 | server/model-run-broker.test.mjs                          | True  | True    |   9334 |  206 |      4 |      0 |              5 |
|  208 | server/model-run-broker-runtime-integration.test.mjs      | True  | True    |   7386 |  167 |     12 |      0 |              2 |
|  209 | server/native-browser.test.mjs                            | True  | True    |   1890 |   50 |      3 |      0 |              2 |
|  210 | server/preflight-http.test.mjs                            | True  | True    |   5659 |  134 |      7 |      0 |              1 |
|  211 | server/preflight-service.mjs                              | False | True    |  16456 |  366 |      7 |      2 |              1 |
|  212 | server/preflight-service.test.mjs                         | True  | True    |   7434 |  193 |      3 |      0 |             10 |
|  213 | server/profile-store.mjs                                  | False | True    |   7434 |  172 |      4 |      2 |              3 |
|  214 | server/profile-store.test.mjs                             | True  | True    |   4570 |  120 |      6 |      0 |              3 |
|  215 | server/relay-app-concurrency.test.mjs                     | True  | True    |   2516 |   76 |      4 |      0 |              1 |
|  216 | server/relay-config-store.mjs                             | False | True    |   2512 |   80 |      2 |      3 |              1 |
|  217 | server/relay-config-store.test.mjs                        | True  | True    |   2340 |   48 |      6 |      0 |              3 |
|  218 | server/relay-connect.test.mjs                             | True  | True    |   5075 |  171 |      4 |      0 |              6 |
|  219 | server/relay-setup.test.mjs                               | True  | True    |   1654 |   54 |      4 |      0 |              2 |
|  220 | server/relay-supervisor.test.mjs                          | True  | True    |   5337 |  167 |      3 |      0 |              5 |
|  221 | server/relay-targets.test.mjs                             | True  | True    |   2403 |   54 |      3 |      0 |              4 |
|  222 | server/smtp-config-store.mjs                              | False | True    |  29017 |  737 |      3 |      6 |              6 |
|  223 | server/smtp-config-store.test.mjs                         | True  | True    |  15538 |  350 |      6 |      0 |             17 |
|  224 | server/smtp-persistence-http.test.mjs                     | True  | True    |   9457 |  234 |      9 |      0 |              2 |
|  225 | server/subagent-runtime-lifecycle.test.mjs                | True  | True    |   7448 |  193 |      7 |      0 |              1 |
|  226 | server/subagent-runtime-security.test.mjs                 | True  | True    |  26358 |  750 |      7 |      0 |             10 |
|  227 | server/workflow-state.test.mjs                            | True  | True    |  12707 |  348 |      8 |      0 |              5 |
|  228 | server/xhs-context-service.mjs                            | False | False   |  24259 |  428 |      6 |      3 |              0 |
|  229 | server/xhs-context-service.test.mjs                       | True  | False   |   4376 |   78 |      6 |      0 |              2 |

## 当前最大十个 Node 文件

- server/app.mjs：7368 行，test=False，tracked=True。
- server/job-manager.mjs：4482 行，test=False，tracked=True。
- server/data-copilot-service.mjs：3467 行，test=False，tracked=True。
- server/job-manager.test.mjs：3016 行，test=True，tracked=True。
- server/draft-http.test.mjs：2916 行，test=True，tracked=True。
- server/data-copilot-runtime.mjs：2602 行，test=False，tracked=True。
- server/data-tool-registry.mjs：1990 行，test=False，tracked=True。
- server/copilot-artifact-service.mjs：1890 行，test=False，tracked=True。
- server/copilot/tool-execution-broker.test.mjs：1794 行，test=True，tracked=True。
- server/copilot/runtime-v3/repository.mjs：1573 行，test=False，tracked=True。

## 解释边界

- server/app.mjs 与 server/job-manager.mjs 的行数支持“大型组合/路由与任务模块”的架构债务判断。
- untracked Node 文件主要来自当前 Codex/browser/device/native mirror 扩展，不属于已提交 v3.0 的稳定事实。
