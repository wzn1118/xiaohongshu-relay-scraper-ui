# 主仓库 HTTP 路由条件事实

来源：当前工作树 server/app.mjs 静态解析。精确路由表只收录 method 与 url.pathname 直接相等的条件；动态路由表保留 parts、正则和方法级分支源码条件。它不是运行时探测结果。

- 精确 method/path 条件：59
- 动态/分段/正则相关条件：90

## 精确 method/path

| 序号 | 方法   | 路径                               | 行号 |
| ---: | ------ | ---------------------------------- | ---: |
|    1 | GET    | /api/auth/me                       |  635 |
|    2 | POST   | /api/auth/login                    |  638 |
|    3 | POST   | /api/auth/logout                   |  645 |
|    4 | GET    | /api/diagnostics/bundle            |  659 |
|    5 | GET    | /api/health                        |  663 |
|    6 | GET    | /api/codex-desktop/status          |  691 |
|    7 | POST   | /api/codex-desktop/launch          |  697 |
|    8 | POST   | /api/xhs-context/mcp               |  707 |
|    9 | GET    | /api/xhs-context/status            |  715 |
|   10 | GET    | /api/xhs-context/bundles           |  726 |
|   11 | POST   | /api/xhs-context/bundles/from-job  |  729 |
|   12 | POST   | /api/codex-product/mcp             |  767 |
|   13 | GET    | /api/codex-product/status          |  775 |
|   14 | GET    | /api/codex-native-mirror/status    |  782 |
|   15 | POST   | /api/codex-native-mirror/sessions  |  785 |
|   16 | GET    | /api/codex-connect/manifest        |  834 |
|   17 | GET    | /api/codex-connect/installer       |  843 |
|   18 | POST   | /api/codex-connect/intents         |  857 |
|   19 | GET    | /api/codex-connect/devices         |  880 |
|   20 | GET    | /api/codex-relay/status            |  909 |
|   21 | GET    | /api/codex-relay/gateway/status    |  915 |
|   22 | GET    | /api/codex-relay/devices           |  919 |
|   23 | POST   | /api/codex-relay/pair              |  922 |
|   24 | POST   | /api/codex-relay/pairing-intents   |  925 |
|   25 | POST   | /api/codex-relay/device-claims     |  943 |
|   26 | POST   | /api/codex-relay/sessions          |  967 |
|   27 | POST   | /api/codex-relay/invites           |  973 |
|   28 | GET    | /api/codex-browser/status          | 1052 |
|   29 | GET    | /api/codex-browser/events          | 1071 |
|   30 | POST   | /api/codex-browser/messages        | 1083 |
|   31 | POST   | /api/codex-browser/worker-messages | 1093 |
|   32 | GET    | /api/relay/config                  | 1136 |
|   33 | PUT    | /api/relay/config                  | 1139 |
|   34 | GET    | /api/email/config                  | 1144 |
|   35 | PUT    | /api/email/config                  | 1147 |
|   36 | DELETE | /api/email/config                  | 1158 |
|   37 | POST   | /api/email/test                    | 1168 |
|   38 | GET    | /api/relay/status                  | 1184 |
|   39 | POST   | /api/relay/connect                 | 1192 |
|   40 | POST   | /api/relay/recover                 | 1201 |
|   41 | POST   | /api/relay/setup                   | 1212 |
|   42 | POST   | /api/relay/login                   | 1231 |
|   43 | GET    | /api/ai/providers                  | 1254 |
|   44 | GET    | /api/ai/local-models               | 1255 |
|   45 | POST   | /api/ai/local-models/install       | 1259 |
|   46 | POST   | /api/ai/models                     | 1264 |
|   47 | POST   | /api/ai/sessions                   | 1267 |
|   48 | GET    | /api/profiles                      | 1276 |
|   49 | POST   | /api/profiles/import               | 1277 |
|   50 | GET    | /api/data/ownership                | 1285 |
|   51 | POST   | /api/data/deletions/preview        | 1288 |
|   52 | POST   | /api/data/deletions/execute        | 1291 |
|   53 | GET    | /api/data/retention                | 1294 |
|   54 | PUT    | /api/data/retention                | 1297 |
|   55 | POST   | /api/data/retention/cleanup        | 1300 |
|   56 | GET    | /api/jobs                          | 1304 |
|   57 | POST   | /api/preflight                     | 1305 |
|   58 | POST   | /api/jobs                          | 1314 |
|   59 | POST   | /api/body-imports                  | 1349 |

## 动态/分段/正则条件

| 序号 | 行号 | 条件源码                                                                                                                                           |
| ---: | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 |  650 | const deviceCredentialRoute = req.method === 'POST' && /^\/api\/codex-relay\/devices\/[^/]+\/heartbeat$/u.test(url.pathname);                      |
|    2 |  651 | const codexConnectClaimRoute = req.method === 'POST' && /^\/api\/codex-connect\/intents\/[^/]+\/claim$/u.test(url.pathname);                       |
|    3 |  743 | if (req.method === 'GET' && contextParts.length === 4) return json(res, 200, xhsContextService.overview(bundleId));                                |
|    4 |  744 | if (req.method === 'POST' && contextParts[4] === 'search' && contextParts.length === 5) {                                                          |
|    5 |  748 | if (req.method === 'POST' && contextParts[4] === 'verify' && contextParts.length === 5) return json(res, 200, xhsContextService.verify(bundleId)); |
|    6 |  749 | if (req.method === 'GET' && contextParts[4] === 'records' && contextParts[5] && contextParts.length === 6) {                                       |
|    7 |  752 | if (req.method === 'GET' && contextParts[4] === 'artifacts' && contextParts.length === 5) {                                                        |
|    8 |  755 | if (req.method === 'POST' && contextParts[4] === 'aggregate' && contextParts.length === 5) {                                                       |
|    9 |  758 | if (req.method === 'POST' && contextParts[4] === 'cite' && contextParts.length === 5) {                                                            |
|   10 |  795 | if (req.method === 'GET' && mirrorParts.length === 4) {                                                                                            |
|   11 |  798 | if (req.method === 'DELETE' && mirrorParts.length === 4) {                                                                                         |
|   12 |  801 | if (req.method === 'POST' && mirrorParts[4] === 'input-target' && mirrorParts.length === 5) {                                                      |
|   13 |  808 | if (req.method === 'POST' && mirrorParts[4] === 'input' && mirrorParts.length === 5) {                                                             |
|   14 |  816 | if (req.method === 'GET') {                                                                                                                        |
|   15 |  822 | if (req.method === 'POST') {                                                                                                                       |
|   16 |  872 | if (req.method === 'GET' && connectParts.length === 4) {                                                                                           |
|   17 |  876 | if (req.method === 'POST' && connectParts[4] === 'claim' && connectParts.length === 5) {                                                           |
|   18 |  887 | if (req.method === 'GET' && connectParts[4] === 'health' && connectParts.length === 5) {                                                           |
|   19 |  890 | if (req.method === 'POST' && connectParts[4] === 'reconnect' && connectParts.length === 5) {                                                       |
|   20 |  893 | if (req.method === 'POST' && connectParts[4] === 'repair' && connectParts.length === 5) {                                                          |
|   21 |  896 | if (req.method === 'POST' && connectParts[4] === 'rollback' && connectParts.length === 5) {                                                        |
|   22 |  899 | if (req.method === 'POST' && connectParts[4] === 'revoke' && connectParts.length === 5) {                                                          |
|   23 |  953 | if (req.method === 'POST' && deviceParts[4] === 'heartbeat' && deviceParts.length === 5) {                                                         |
|   24 |  962 | if (req.method === 'DELETE' && deviceParts.length === 4) {                                                                                         |
|   25 |  988 | if (req.method === 'POST' && relayParts[4] === 'connect' && relayParts.length === 5) {                                                             |
|   26 |  991 | if (req.method === 'GET' && relayParts.length === 4) {                                                                                             |
|   27 |  996 | if (req.method === 'DELETE' && relayParts.length === 4) {                                                                                          |
|   28 | 1001 | if (req.method === 'POST' && relayParts[4] === 'lease' && relayParts[5] === 'renew' && relayParts.length === 6) {                                  |
|   29 | 1008 | if (req.method === 'POST' && relayParts[4] === 'lease' && relayParts[5] === 'release' && relayParts.length === 6) {                                |
|   30 | 1015 | if (req.method === 'GET' && relayParts[4] === 'events' && relayParts.length === 5) {                                                               |
|   31 | 1022 | if (req.method === 'POST' && relayParts[4] === 'stream-ticket' && relayParts.length === 5) {                                                       |
|   32 | 1031 | if (req.method === 'POST' && relayParts[4] === 'messages' && relayParts.length === 5) {                                                            |
|   33 | 1041 | if (req.method === 'POST' && relayParts[4] === 'worker-messages' && relayParts.length === 5) {                                                     |
|   34 | 1270 | if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'ai' && parts[2] === 'sessions' && parts[3] && parts[4] === 'probe') {             |
|   35 | 1273 | if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'ai' && parts[2] === 'sessions' && parts[3]) {                                   |
|   36 | 1385 | if (req.method === 'GET' && parts.length === 3) return json(res, 200, manager.get(id));                                                            |
|   37 | 1386 | if (req.method === 'GET' && parts[3] === 'experience-snapshot' && parts.length === 4) {                                                            |
|   38 | 1390 | if (req.method === 'GET' && parts[3] === 'issues' && parts.length === 4) {                                                                         |
|   39 | 1399 | if (req.method === 'GET' && parts[3] === 'technical-diagnostics' && parts.length === 4) {                                                          |
|   40 | 1402 | if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'retry-stage' && parts.length === 5) {                                         |
|   41 | 1441 | if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'check-recovery' && parts.length === 5) {                                      |
|   42 | 1508 | if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'open-login' && parts.length === 5) {                                          |
|   43 | 1547 | if (req.method === 'POST' && parts[3] === 'resume' && parts.length === 4) {                                                                        |
|   44 | 1559 | if (req.method === 'POST' && parts[3] === 'complete-missing' && parts.length === 4) {                                                              |
|   45 | 1634 | if (req.method === 'POST' && parts[3] === 'cancel' && parts.length === 4) {                                                                        |
|   46 | 1638 | if (req.method === 'GET' && parts[3] === 'events' && parts.length === 4) return streamEvents(req, res, manager, id, url.searchParams);             |
|   47 | 1639 | if (req.method === 'GET' && parts[3] === 'logs' && parts.length === 4) {                                                                           |
|   48 | 1649 | if (req.method === 'GET' && parts[3] === 'results' && parts.length === 4) {                                                                        |
|   49 | 1699 | if (req.method === 'GET' && parts[3] === 'application-delivery-candidates' && parts.length === 4) {                                                |
|   50 | 1754 | if (req.method === 'GET') {                                                                                                                        |
|   51 | 1775 | if (req.method === 'POST') {                                                                                                                       |
|   52 | 1795 | if (req.method === 'GET' && parts[3] === 'media' && parts.length === 4) {                                                                          |
|   53 | 1805 | if (req.method === 'GET' && parts.length === 7) {                                                                                                  |
|   54 | 1808 | if (req.method === 'POST' && parts[7] === 'preview' && parts.length === 8) {                                                                       |
|   55 | 1812 | if (req.method === 'POST' && parts[7] === 'runs' && parts.length === 8) {                                                                          |
|   56 | 1816 | if (req.method === 'GET' && parts[7] === 'events' && parts.length === 8) {                                                                         |
|   57 | 1819 | if (req.method === 'GET' && parts[7] === 'results' && parts.length === 8) {                                                                        |
|   58 | 1824 | if (req.method === 'GET' && parts.length === 9) {                                                                                                  |
|   59 | 1827 | if (req.method === 'GET' && parts[9] === 'results' && parts.length === 10) {                                                                       |
|   60 | 1831 | if (req.method === 'POST' && ['cancel', 'resume'].includes(parts[9]) && parts.length === 10) {                                                     |
|   61 | 1856 | if (req.method === 'GET' && parts[3] === 'audience' && parts.length === 4) {                                                                       |
|   62 | 1859 | if (req.method === 'GET' && parts[3] === 'expansion' && parts.length === 4) {                                                                      |
|   63 | 1866 | if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'start' && parts.length === 5) {                                             |
|   64 | 1876 | if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'attempts' && parts.length === 5) {                                          |
|   65 | 1886 | if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'resume' && parts.length === 5) {                                            |
|   66 | 1891 | if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'cancel' && parts.length === 5) {                                            |
|   67 | 1995 | if (req.method === 'POST' && parts[3] === 'audience' && parts[4] === 'grow' && parts.length === 5) {                                               |
|   68 | 2057 | if (parts[3] === 'application-attachments' && parts.length === 4 && req.method === 'GET') {                                                        |
|   69 | 2064 | if (parts[3] === 'application-attachments' && parts.length === 4 && req.method === 'POST') {                                                       |
|   70 | 2080 | if (parts[3] === 'application-attachments' && parts[4] === 'from-artifact' && parts.length === 5 && req.method === 'POST') {                       |
|   71 | 2118 | if (parts[3] === 'application-attachments' && parts[4] === 'from-cover-letter' && parts.length === 5 && req.method === 'POST') {                   |
|   72 | 2160 | if (parts[3] === 'application-attachments' && parts[4] === 'from-profile' && parts.length === 5 && req.method === 'POST') {                        |
|   73 | 2190 | if (parts[3] === 'application-attachments' && parts[4] && parts[5] === 'content' && parts.length === 6 && req.method === 'GET') {                  |
|   74 | 2200 | if (parts[3] === 'application-attachments' && parts[4] && parts.length === 5 && req.method === 'PATCH') {                                          |
|   75 | 2213 | if (parts[3] === 'application-attachments' && parts[4] && parts.length === 5 && req.method === 'DELETE') {                                         |
|   76 | 2220 | if (req.method === 'POST' && parts[3] === 'delivery' && parts.length === 4) {                                                                      |
|   77 | 2224 | if (req.method === 'POST' && parts[3] === 'draft' && parts.length === 4) {                                                                         |
|   78 | 2228 | if (req.method === 'POST' && parts[3] === 'application-generation' && parts[4] === 'writeback' && parts.length === 5) {                            |
|   79 | 2232 | if (req.method === 'POST' && parts[3] === 'draft' && parts[4] === 'rewrite' && parts.length === 5) {                                               |
|   80 | 2245 | if (req.method === 'POST' && parts[3] === 'draft' && parts[4] === 'quality' && parts.length === 5) {                                               |
|   81 | 2261 | if (req.method === 'POST' && parts[4] === 'dry-run' && parts.length === 5) {                                                                       |
|   82 | 2264 | if (req.method === 'GET' && parts.length === 4) {                                                                                                  |
|   83 | 2267 | if (req.method === 'POST' && parts.length === 4) {                                                                                                 |
|   84 | 2272 | if (req.method === 'GET' && batchId && parts.length === 5) {                                                                                       |
|   85 | 2275 | if (req.method === 'GET' && batchId && parts[5] === 'events' && parts.length === 6) {                                                              |
|   86 | 2292 | if (req.method === 'POST' && batchId && parts.length === 6) {                                                                                      |
|   87 | 2302 | if (req.method === 'POST' && parts[3] === 'send-email' && parts[4] === 'preview' && parts.length === 5) {                                          |
|   88 | 2317 | if (req.method === 'POST' && parts[3] === 'send-email' && parts.length === 4) {                                                                    |
|   89 | 2336 | if (req.method === 'GET' && parts[3] === 'artifacts' && parts.length === 4) {                                                                      |
|   90 | 2339 | if (req.method === 'GET' && parts[3] === 'artifacts' && parts[4] && parts.length === 5) {                                                          |

## 路由规模解释

- 精确条件数量不是唯一 endpoint 数量：parts 分段路由可对应多个参数化 endpoint。
- 同一路径可能因方法不同形成多个操作。
- 当前 app.mjs 已修改，Codex/XHS context/native mirror/device relay 路由属于工作区扩展时要按 Git 状态说明。
