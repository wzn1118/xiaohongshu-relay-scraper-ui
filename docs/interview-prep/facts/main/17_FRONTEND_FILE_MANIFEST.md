# 主仓库前端源码文件清单

来源：当前 src/ 下 ts、tsx、css 文件。import/export/test 为行级静态计数。

- 文件数：35
- 总行数：30698
- tracked：35
- untracked：0

| 序号 | 文件                                     | tracked |   字节 | 行数 | import 行 | export 行 | test/it 近似数 |
| ---: | ---------------------------------------- | ------- | -----: | ---: | --------: | --------: | -------------: |
|    1 | src/api.ts                               | True    |  35365 |  636 |         1 |        14 |              0 |
|    2 | src/App.tsx                              | True    | 410175 | 6583 |        20 |         1 |             16 |
|    3 | src/AudienceAiPanel.tsx                  | True    |  50948 |  832 |         4 |         1 |              0 |
|    4 | src/BatchApplicationPanel.tsx            | True    | 118981 | 2112 |         4 |         1 |              3 |
|    5 | src/body-import.ts                       | True    |   3449 |  102 |         0 |         3 |              1 |
|    6 | src/BodyImportPanel.tsx                  | True    |   5099 |  102 |         4 |         1 |              0 |
|    7 | src/copilot/ActivityTimeline.tsx         | True    |   1585 |   34 |         2 |         1 |              0 |
|    8 | src/copilot/AgentWorkbench.tsx           | True    |  12762 |  115 |         7 |         1 |              0 |
|    9 | src/copilot/answer-ast.ts                | True    |   3559 |   78 |         0 |         4 |              9 |
|   10 | src/copilot/EvidenceInspector.tsx        | True    |   1918 |   40 |         2 |         1 |              0 |
|   11 | src/copilot/ExecutionTimeline.tsx        | True    |   2709 |   65 |         3 |         1 |              0 |
|   12 | src/copilot/PlanView.tsx                 | True    |   2589 |   63 |         2 |         1 |              0 |
|   13 | src/copilot/project-workspace-api.ts     | True    |  12749 |  419 |         0 |        13 |              0 |
|   14 | src/copilot/QualityPanel.tsx             | True    |  15196 |  286 |         3 |         1 |              0 |
|   15 | src/copilot/RunBar.tsx                   | True    |   3494 |   87 |         2 |         1 |              0 |
|   16 | src/copilot/TaskInspector.tsx            | True    |  26277 |  471 |         5 |         2 |              1 |
|   17 | src/copilot/TaskRunHeader.tsx            | True    |   5218 |  137 |         3 |         2 |              0 |
|   18 | src/copilot/useCopilotEventProjection.ts | True    |  12038 |  284 |         3 |         1 |              0 |
|   19 | src/copilot/workbench-types.ts           | True    |   1384 |   58 |         1 |         6 |              0 |
|   20 | src/CopilotMcpSettings.tsx               | True    |  24331 |  458 |         2 |         2 |              1 |
|   21 | src/CopilotProjectWorkspacePanel.tsx     | True    |  62296 |  970 |         4 |         2 |              0 |
|   22 | src/DataCopilotContext.tsx               | True    |  22220 |  830 |         2 |        46 |              2 |
|   23 | src/DataCopilotContextBrowser.tsx        | True    |  33218 |  675 |         3 |         1 |              1 |
|   24 | src/DataCopilotMessage.tsx               | True    | 101095 | 3022 |         4 |         2 |              8 |
|   25 | src/DataCopilotPanel.tsx                 | True    | 128350 | 2895 |        15 |         3 |              0 |
|   26 | src/data-copilot-transport.ts            | True    |  59497 | 1598 |         1 |         6 |              1 |
|   27 | src/ExpansionWorkspace.tsx               | True    |  20607 |  249 |         4 |         1 |              0 |
|   28 | src/job-experience.ts                    | True    |  19636 |  472 |         1 |         6 |              7 |
|   29 | src/JobJourneyPanel.tsx                  | True    |  15749 |  291 |         5 |         1 |              1 |
|   30 | src/main.tsx                             | True    |    227 |   10 |         4 |         0 |              0 |
|   31 | src/McpAccessPanel.tsx                   | True    |  29587 |  526 |         2 |         1 |              0 |
|   32 | src/styles.css                           | True    | 316600 | 4005 |         0 |         0 |              0 |
|   33 | src/types.ts                             | True    |  55046 | 1997 |         0 |       142 |              0 |
|   34 | src/UnsavedDraftDialog.tsx               | True    |   2072 |   35 |         2 |         1 |              0 |
|   35 | src/useUnsavedDraftGuard.ts              | True    |   5680 |  161 |         3 |         3 |              0 |

## 大文件事实

- src/App.tsx：6583 行，410175 字节。
- src/styles.css：4005 行，316600 字节。
- src/DataCopilotMessage.tsx：3022 行，101095 字节。
- src/DataCopilotPanel.tsx：2895 行，128350 字节。
- src/BatchApplicationPanel.tsx：2112 行，118981 字节。
- src/types.ts：1997 行，55046 字节。
- src/data-copilot-transport.ts：1598 行，59497 字节。
- src/CopilotProjectWorkspacePanel.tsx：970 行，62296 字节。
- src/AudienceAiPanel.tsx：832 行，50948 字节。
- src/DataCopilotContext.tsx：830 行，22220 字节。

## 解释边界

- 行数和 import/export 数量是静态规模，不代表组件职责清晰或测试覆盖。
- App.tsx 与 styles.css 的体量是当前前端拆分债务的重要证据。
