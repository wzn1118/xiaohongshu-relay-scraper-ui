# 主仓库当前工作树事实

快照时间：2026-08-18。本文件排除了本轮新增的 docs/interview-prep/，用于保留任务开始前后仍存在的业务源码/实验状态。

- 状态路径总数（排除本资料包）：82
- 状态 ??：60
- 状态 M：22

## 未跟踪文件按顶层目录

| 顶层目录 | 数量 |
| -------- | ---: |
| server   |   35 |
| scripts  |   13 |
| docs     |    8 |
| public   |    4 |

## 完整状态清单

| 序号 | 状态 | 路径                                               | 当前字节 | diff 新增行 | diff 删除行 |
| ---: | ---- | -------------------------------------------------- | -------: | ----------: | ----------: |
|    1 | M    | .env.example                                       |     4545 |          16 |           0 |
|    2 | M    | .env.production.example                            |     3725 |          16 |           0 |
|    3 | M    | package-lock.json                                  |   120136 |          23 |           1 |
|    4 | M    | package.json                                       |     5442 |          14 |           1 |
|    5 | M    | server/app-security.test.mjs                       |    21738 |         154 |           0 |
|    6 | M    | server/app.mjs                                     |   332701 |         729 |           4 |
|    7 | M    | server/config.mjs                                  |    18554 |          69 |           0 |
|    8 | M    | server/copilot-protocol.test.mjs                   |    12263 |           3 |           2 |
|    9 | M    | server/copilot/model-gateway.mjs                   |    16568 |          18 |           8 |
|   10 | M    | server/copilot/model-run-broker.mjs                |    24002 |           1 |           1 |
|   11 | M    | server/data-copilot-runtime.mjs                    |   119358 |           4 |           2 |
|   12 | M    | server/data-copilot-runtime.test.mjs               |    59469 |           6 |           1 |
|   13 | M    | server/data-copilot-service.mjs                    |   147644 |          12 |           1 |
|   14 | M    | server/data-copilot-service.test.mjs               |    22596 |          16 |           0 |
|   15 | M    | server/index.mjs                                   |    19682 |         102 |           2 |
|   16 | M    | src/App.tsx                                        |   410118 |         370 |          15 |
|   17 | M    | src/DataCopilotContext.tsx                         |    22220 |           6 |           2 |
|   18 | M    | src/api.ts                                         |    35257 |         205 |           0 |
|   19 | M    | src/styles.css                                     |   316600 |          58 |           0 |
|   20 | M    | tests/e2e/data-copilot.spec.ts                     |    81901 |          90 |           2 |
|   21 | M    | tests/e2e/unsaved-draft-guard.spec.ts              |    53215 |          46 |           0 |
|   22 | M    | vite.config.ts                                     |      794 |           8 |           4 |
|   23 | ??   | docs/CODEX_DEVICE_RELAY_DEPLOYMENT.md              |     8068 |             |             |
|   24 | ??   | docs/CODEX_INTERACTIVE_MIRROR_AND_SESSION_SHARE.md |     2082 |             |             |
|   25 | ??   | docs/CODEX_LOCAL_RELAY_OPTIMIZED_ARCHITECTURE.md   |    21573 |             |             |
|   26 | ??   | docs/CODEX_PRODUCT_MCP.md                          |     2626 |             |             |
|   27 | ??   | docs/codex-web-runtime-design.md                   |    44909 |             |             |
|   28 | ??   | docs/current-runtime-analysis.md                   |    13011 |             |             |
|   29 | ??   | docs/electron-surface.md                           |    13148 |             |             |
|   30 | ??   | docs/interview-prep.zip                            |    92030 |             |             |
|   31 | ??   | public/codex-browser-host.js                       |    56053 |             |             |
|   32 | ??   | public/codex-native-mirror.css                     |     3267 |             |             |
|   33 | ??   | public/codex-native-mirror.html                    |     1724 |             |             |
|   34 | ??   | public/codex-native-mirror.js                      |    15683 |             |             |
|   35 | ??   | scripts/codex-device-relay.mjs                     |    21557 |             |             |
|   36 | ??   | scripts/codex-local-connector.mjs                  |    18981 |             |             |
|   37 | ??   | scripts/diff-codex-app-server-schema.mjs           |     9079 |             |             |
|   38 | ??   | scripts/install-codex-local-connector.ps1          |     8566 |             |             |
|   39 | ??   | scripts/package-codex-local-connector.ps1          |     5218 |             |             |
|   40 | ??   | scripts/probe-codex-app-server.mjs                 |     7113 |             |             |
|   41 | ??   | scripts/probe-codex-web-runtime.mjs                |    15858 |             |             |
|   42 | ??   | scripts/provision-codex-desktop-runtime.ps1        |     5243 |             |             |
|   43 | ??   | scripts/record-codex-runtime-baseline.mjs          |      910 |             |             |
|   44 | ??   | scripts/rollback-codex-local-connector.ps1         |     4264 |             |             |
|   45 | ??   | scripts/verify-codex-desktop-runtime.mjs           |      652 |             |             |
|   46 | ??   | scripts/verify-codex-local-connector.mjs           |     4977 |             |             |
|   47 | ??   | scripts/verify-codex-transport-parity.mjs          |    10276 |             |             |
|   48 | ??   | server/codex-app-server-transport.mjs              |     8904 |             |             |
|   49 | ??   | server/codex-app-server-transport.test.mjs         |     4092 |             |             |
|   50 | ??   | server/codex-browser-host.test.mjs                 |     1358 |             |             |
|   51 | ??   | server/codex-browser-service.mjs                   |     5462 |             |             |
|   52 | ??   | server/codex-browser-service.test.mjs              |     7661 |             |             |
|   53 | ??   | server/codex-canonical-adapter.mjs                 |     7699 |             |             |
|   54 | ??   | server/codex-canonical-adapter.test.mjs            |     4068 |             |             |
|   55 | ??   | server/codex-connect-service.mjs                   |    13091 |             |             |
|   56 | ??   | server/codex-connect-service.test.mjs              |     5247 |             |             |
|   57 | ??   | server/codex-desktop-service.mjs                   |     5929 |             |             |
|   58 | ??   | server/codex-desktop-service.test.mjs              |     3712 |             |             |
|   59 | ??   | server/codex-device-gateway-service.mjs            |    29628 |             |             |
|   60 | ??   | server/codex-device-gateway-service.test.mjs       |     7889 |             |             |
|   61 | ??   | server/codex-git-worker-service.mjs                |    55479 |             |             |
|   62 | ??   | server/codex-git-worker-service.test.mjs           |    18901 |             |             |
|   63 | ??   | server/codex-host-command-service.mjs              |    14964 |             |             |
|   64 | ??   | server/codex-host-command-service.test.mjs         |     4557 |             |             |
|   65 | ??   | server/codex-host-rpc-service.mjs                  |    11773 |             |             |
|   66 | ??   | server/codex-host-rpc-service.test.mjs             |     7576 |             |             |
|   67 | ??   | server/codex-ice-service.mjs                       |     4800 |             |             |
|   68 | ??   | server/codex-ice-service.test.mjs                  |     1827 |             |             |
|   69 | ??   | server/codex-native-input-service.mjs              |    15408 |             |             |
|   70 | ??   | server/codex-native-input-service.test.mjs         |     1771 |             |             |
|   71 | ??   | server/codex-native-mirror-service.mjs             |    13580 |             |             |
|   72 | ??   | server/codex-native-mirror-service.test.mjs        |     6609 |             |             |
|   73 | ??   | server/codex-product-service.mjs                   |    20899 |             |             |
|   74 | ??   | server/codex-product-service.test.mjs              |     9374 |             |             |
|   75 | ??   | server/codex-protocol-evidence.mjs                 |     4203 |             |             |
|   76 | ??   | server/codex-protocol-evidence.test.mjs            |     3133 |             |             |
|   77 | ??   | server/codex-relay-service.mjs                     |    27397 |             |             |
|   78 | ??   | server/codex-relay-service.test.mjs                |    13763 |             |             |
|   79 | ??   | server/codex-runtime-compatibility.mjs             |    12349 |             |             |
|   80 | ??   | server/codex-runtime-compatibility.test.mjs        |     5662 |             |             |
|   81 | ??   | server/xhs-context-service.mjs                     |    24259 |             |             |
|   82 | ??   | server/xhs-context-service.test.mjs                |     4376 |             |             |

## 边界解释

- M 表示相对 index/HEAD 已修改；?? 表示未跟踪。
- 当前 package.json、server/index.mjs、server/app.mjs、Copilot 文件、src/App.tsx、E2E 和配置示例均有已修改项。
- 未跟踪文件主要包含 Codex browser/device/native relay、transport、connector、runtime compatibility、public assets、测试与设计文档。
- 这些状态证明工作区存在实现或实验，不等于已经提交、发布或通过 CI。
