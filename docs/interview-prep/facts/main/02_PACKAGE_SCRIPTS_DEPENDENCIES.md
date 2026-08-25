# 主仓库 Package、命令与依赖事实

来源：当前工作树 package.json，审计时间 2026-08-18。package.json 当前处于已修改状态，因此本表可能包含尚未提交的命令或依赖。

## Package 元数据

- name：xiaohongshu-relay-scraper-ui
- version：3.0.0
- type：module
- private：true

## Scripts（54）

| Script                               | 命令                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| audit:dependencies                   | npm audit --audit-level=high                                                                                                                                                                         |
| backup:production                    | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/backup-hegelsalon.ps1                                                                                                        |
| build                                | tsc -b && vite build                                                                                                                                                                                 |
| build:frontend                       | vite build                                                                                                                                                                                           |
| check                                | npm run lint && npm run format:check && npm run typecheck && npm run test && npm run test:python && npm run test:api && npm run build:frontend && npm run test:artifacts && npm run test:credentials |
| codex:runtime:baseline               | node scripts/record-codex-runtime-baseline.mjs                                                                                                                                                       |
| configure:outlook                    | node scripts/configure-outlook-smtp.mjs                                                                                                                                                              |
| connector:health                     | node scripts/codex-local-connector.mjs --health                                                                                                                                                      |
| connector:rollback                   | node scripts/codex-local-connector.mjs --rollback                                                                                                                                                    |
| connector:update                     | node scripts/codex-local-connector.mjs --update                                                                                                                                                      |
| cover-letter:external-batch          | node scripts/run_external_cover_letter_batch.mjs                                                                                                                                                     |
| cover-letter:external-until-complete | node scripts/run_external_cover_letter_until_complete.mjs                                                                                                                                            |
| dev                                  | concurrently -k -n api,web -c yellow,cyan "node server/index.mjs" "vite"                                                                                                                             |
| dev:watch                            | concurrently -k -n api,web -c yellow,cyan "node --watch server/index.mjs" "vite"                                                                                                                     |
| format:check                         | node scripts/check-format.mjs                                                                                                                                                                        |
| lint                                 | node scripts/lint.mjs                                                                                                                                                                                |
| mcp:stdio                            | node scripts/mcp-stdio-bridge.mjs                                                                                                                                                                    |
| package:codex-connector              | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-codex-local-connector.ps1                                                                                            |
| package:github-release               | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-github-release.ps1                                                                                                   |
| package:production                   | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows-production.ps1                                                                                               |
| preflight                            | node scripts/preflight.mjs                                                                                                                                                                           |
| prepare:codex-desktop                | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/provision-codex-desktop-runtime.ps1                                                                                          |
| prepare:portable-runtime             | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-portable-runtime.ps1                                                                                                 |
| probe:codex:app-server               | node scripts/probe-codex-app-server.mjs                                                                                                                                                              |
| probe:codex:web-runtime              | node scripts/probe-codex-web-runtime.mjs                                                                                                                                                             |
| provision:auth                       | node scripts/provision-auth.mjs                                                                                                                                                                      |
| provision:hegelsalon:relay           | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/provision-hegelsalon-relay-tunnel.ps1 -Apply                                                                                 |
| register:production                  | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1                                                                                                         |
| relay:device                         | node scripts/codex-device-relay.mjs                                                                                                                                                                  |
| restore:production                   | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/restore-hegelsalon.ps1                                                                                                       |
| start                                | node server/index.mjs                                                                                                                                                                                |
| start:production                     | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/start-production-windows.ps1                                                                                                 |
| stop:production                      | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/stop-production-windows.ps1                                                                                                  |
| test                                 | node --test --test-concurrency=4 server/_.test.mjs server/lib/_.test.mjs tests/*.test.mjs                                                                                                            |
| test:agents                          | python tests/test_application_intelligence_agents.py -v                                                                                                                                              |
| test:api                             | node --test server/app.test.mjs server/app-security.test.mjs server/contracts.test.mjs server/data-lifecycle-http.test.mjs server/draft-http.test.mjs server/preflight-http.test.mjs                 |
| test:artifacts                       | node --test tests/mock-runner.test.mjs                                                                                                                                                               |
| test:copilot-contract                | node --test server/copilot-protocol.test.mjs server/data-copilot-http.test.mjs                                                                                                                       |
| test:copilot-eval                    | node scripts/run-copilot-evals.mjs                                                                                                                                                                   |
| test:copilot-migration               | node --test --test-name-pattern="schema v4 migrates" server/copilot-runtime-v2.test.mjs                                                                                                              |
| test:copilot-recovery                | node --test server/copilot-runtime-v2.test.mjs                                                                                                                                                       |
| test:credentials                     | node scripts/check-credentials.mjs                                                                                                                                                                   |
| test:e2e                             | playwright test                                                                                                                                                                                      |
| test:mailpit                         | node --test server/mailpit.integration.mjs                                                                                                                                                           |
| test:mcp                             | node --test server/mcp-*.test.mjs                                                                                                                                                                    |
| test:python                          | python -m pytest -q                                                                                                                                                                                  |
| typecheck                            | tsc -b --pretty false                                                                                                                                                                                |
| verify:artifacts                     | node scripts/verify-artifacts.mjs                                                                                                                                                                    |
| verify:codex-connector               | node scripts/verify-codex-local-connector.mjs                                                                                                                                                        |
| verify:codex-desktop                 | node scripts/verify-codex-desktop-runtime.mjs                                                                                                                                                        |
| verify:codex:transport-parity        | node scripts/verify-codex-transport-parity.mjs                                                                                                                                                       |
| verify:mcp                           | node scripts/verify-mcp-production.mjs                                                                                                                                                               |
| verify:mcp:showcase                  | node scripts/verify-mcp-public-showcase.mjs                                                                                                                                                          |
| watchdog:production                  | powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/production-watchdog.ps1                                                                                                      |

## Runtime dependencies（7）

| 包                        | 版本     |
| ------------------------- | -------- |
| @modelcontextprotocol/sdk | 1.30.0   |
| busboy                    | ^1.6.0   |
| lucide-react              | ^0.468.0 |
| nodemailer                | ^9.0.3   |
| react                     | ^19.0.0  |
| react-dom                 | ^19.0.0  |
| ws                        | ^8.21.3  |

## Dev dependencies（8）

| 包                   | 版本     |
| -------------------- | -------- |
| @playwright/test     | ^1.55.1  |
| @types/node          | ^22.10.2 |
| @types/react         | ^19.0.3  |
| @types/react-dom     | ^19.0.2  |
| @vitejs/plugin-react | ^4.3.4   |
| concurrently         | ^9.1.0   |
| typescript           | ~5.7.2   |
| vite                 | ^6.0.5   |

## 命令分组事实

- 开发/启动：dev、dev:watch、start、start:production、stop:production、watchdog:production。
- 构建/静态检查：build、build:frontend、lint、format:check、typecheck、audit:dependencies。
- 测试：test、test:api、test:python、test:e2e、test:mailpit、test:mcp、test:copilot-*、test:artifacts、test:credentials、test:agents。
- 发布：package:github-release、package:production、prepare:portable-runtime、register:production、backup:production、restore:production。
- Codex/connector：prepare:codex-desktop、probe:codex:_、relay:device、connector:_、package/verify connector、transport parity、runtime baseline。
- MCP：mcp:stdio、verify:mcp、verify:mcp:showcase。

## 验证边界

- 本表确认命令存在，不代表每条命令在当前机器执行成功。
- 本轮没有运行应用全量测试；历史验收数字另见测试事实文件。
