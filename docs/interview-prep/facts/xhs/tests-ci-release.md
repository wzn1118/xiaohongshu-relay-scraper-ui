# 测试、CI、发布与历史验收事实

> 口径：`[S]` 是 2026-08-18 对 `HEAD=1fa74a0` 的静态源文件盘点；`[HEAD]` 是已提交配置；`[R]` 是仓库历史报告中的旧运行结果。本轮文档审计没有重跑完整测试矩阵。

## 当前 HEAD 的静态测试资产

- **XHS-TST-001 [S]**：`HEAD` 含 96 个 `*.test.mjs`，其中 `server/` 90 个、`tests/` 6 个。
- **XHS-TST-002 [S]**：96 个 Node test 文件中词法匹配 `\btest\s*\(` 共 799 处；这是静态调用点数量，不是 Node test runner 实际展开/跳过/参数化后的用例总数。
- **XHS-TST-003 [S]**：`HEAD` 含 29 个 `tests/test_*.py`。
- **XHS-TST-004 [S]**：29 个 Python 文件中词法匹配任意缩进的 `def test_*(` 共 511 处；同样不等于 pytest collection 后的最终 case 数。
- **XHS-TST-005 [S]**：`HEAD` 含 8 个 Playwright `*.spec.ts`，静态 `test(` 调用点 72 处。
- **XHS-TST-006 [S]**：视觉基准 PNG 共 34 张：audience-ai 10、expansion-workspace 18、unsaved-draft-guard 6。
- **XHS-TST-007 [S]**：静态总量为 133 个测试源文件（96+29+8）和 1,382 个词法 test 定义/调用点（799+511+72）；34 张截图基准不计入测试源文件。
- **XHS-TST-008 [S]**：当前 worktree 另有 tracked 测试修改和 untracked Codex 测试；以上数字只取 `git ls-tree HEAD` 与 `git show HEAD:<path>`，没有混入工作区实验。

## 96 个 Node test 文件清单

- **XHS-TST-009 [HEAD]**：应用/API/Job 核心测试覆盖 app、security、contracts、job-manager、SSE、workflow、preflight、data lifecycle、diagnostics 与 native browser。
- **XHS-TST-010 [HEAD]**：岗位申请测试覆盖 attachment、batch、contact OCR/resolution、delivery candidates、result、cover letter、draft store/checker/HTTP 与邮件发送。
- **XHS-TST-011 [HEAD]**：受众/关系扩展测试覆盖 audience AI、artifact/profile runner、cursor artifact、results/workflow state、body import 与 expansion results。
- **XHS-TST-012 [HEAD]**：Copilot 测试覆盖 agent kernel、approval、artifact、capability resolver/runtime、context、dispatcher/worker、production、protocol、runtime v2/v3、workspace/Git/worktree、MCP client、turn ledger、terminal、broker 与 unified registry。
- **XHS-TST-013 [HEAD]**：MCP 独立测试覆盖 access、HTTP、management、stdio bridge、restore/revocation；Relay 测试覆盖 config/connect/setup/supervisor/targets/app concurrency。

```text
server/ai-session-store.test.mjs
server/app-security.test.mjs
server/app.test.mjs
server/application-attachments.test.mjs
server/application-batch-manager.test.mjs
server/application-batch-service.test.mjs
server/application-contact-ocr-service.test.mjs
server/application-contact-resolution-service.test.mjs
server/application-contact-resolver.test.mjs
server/application-delivery-candidates.test.mjs
server/application-results.test.mjs
server/audience-ai-artifacts.test.mjs
server/audience-ai-profile-runner.test.mjs
server/audience-ai.test.mjs
server/audience-cursor-artifact.test.mjs
server/audience-results.test.mjs
server/audience-workflow-state.test.mjs
server/auth-store.test.mjs
server/body-import.test.mjs
server/contracts.test.mjs
server/copilot-agent-kernel.test.mjs
server/copilot-approval-store.test.mjs
server/copilot-artifact-service.test.mjs
server/copilot-capability-resolver.test.mjs
server/copilot-context-source.test.mjs
server/copilot-execution-dispatcher.test.mjs
server/copilot-execution-worker-supervisor.test.mjs
server/copilot-production.test.mjs
server/copilot-protocol.test.mjs
server/copilot-runtime-v2.test.mjs
server/copilot-runtime-v3-contracts.test.mjs
server/copilot/capability-runtime.test.mjs
server/copilot/git-tool-adapter.test.mjs
server/copilot/git-worktree-manager.test.mjs
server/copilot/mcp-client-manager.test.mjs
server/copilot/model-turn-ledger.test.mjs
server/copilot/project-workspace-http.test.mjs
server/copilot/project-workspace-runtime-binding.test.mjs
server/copilot/project-workspace-service.test.mjs
server/copilot/terminal-session-manager.test.mjs
server/copilot/tool-execution-broker.test.mjs
server/copilot/unified-tool-registry.test.mjs
server/copilot/workspace-tool-adapter.test.mjs
server/cover-letter-rewriter.test.mjs
server/data-copilot-execution-api.test.mjs
server/data-copilot-http.test.mjs
server/data-copilot-runtime.test.mjs
server/data-copilot-service.test.mjs
server/data-copilot-store.test.mjs
server/data-lifecycle-http.test.mjs
server/data-lifecycle-runtime.test.mjs
server/data-lifecycle-service.test.mjs
server/data-policy-engine.test.mjs
server/data-tool-registry.test.mjs
server/diagnostics.test.mjs
server/draft-http.test.mjs
server/draft-quality-checker.test.mjs
server/draft-store.test.mjs
server/expansion-results.test.mjs
server/job-experience-http.test.mjs
server/job-experience.test.mjs
server/job-manager.test.mjs
server/job-sse.test.mjs
server/lib/application-attachment-rule.test.mjs
server/lib/application-email-draft.test.mjs
server/lib/application-source-disposition.test.mjs
server/lib/proxy-aware-fetch.test.mjs
server/local-model-manager.test.mjs
server/mail-sender.test.mjs
server/mcp-access-service.test.mjs
server/mcp-http-server.test.mjs
server/mcp-management-http.test.mjs
server/mcp-stdio-bridge.test.mjs
server/model-run-broker-runtime-integration.test.mjs
server/model-run-broker.test.mjs
server/native-browser.test.mjs
server/preflight-http.test.mjs
server/preflight-service.test.mjs
server/profile-store.test.mjs
server/relay-app-concurrency.test.mjs
server/relay-config-store.test.mjs
server/relay-connect.test.mjs
server/relay-setup.test.mjs
server/relay-supervisor.test.mjs
server/relay-targets.test.mjs
server/smtp-config-store.test.mjs
server/smtp-persistence-http.test.mjs
server/subagent-runtime-lifecycle.test.mjs
server/subagent-runtime-security.test.mjs
server/workflow-state.test.mjs
tests/credential-scan.test.mjs
tests/data-copilot-transport.test.mjs
tests/draft-state.test.mjs
tests/mcp-restore-revocation.test.mjs
tests/mock-runner.test.mjs
tests/one-click-launcher.test.mjs
```

## Python 与 Playwright 清单

- **XHS-TST-014 [HEAD]**：Python 测试覆盖 Provider/runtime、应用生成/智能 Agent、Artifact、Audience、Workflow state、正文 ledger、Codex outreach/prompt、节奏、重写器、证据验证、关系扩展、岗位标题、Profile、Relay streaming、contact resolution 与 scraper resume/readiness。

```text
tests/test_ai_application_workflow.py
tests/test_ai_provider_runtime.py
tests/test_application_generation.py
tests/test_application_intelligence_agents.py
tests/test_artifact_io.py
tests/test_audience_ai_pipeline.py
tests/test_audience_collection.py
tests/test_audience_profile_supplement.py
tests/test_audience_resume.py
tests/test_audience_workflow_state.py
tests/test_body_completion_ledger.py
tests/test_codex_runtime_outreach.py
tests/test_codex_runtime_prompt.py
tests/test_collection_pacing.py
tests/test_cover_letter_rewriter.py
tests/test_discovery_growth.py
tests/test_evidence_claim_validator.py
tests/test_expansion_collection.py
tests/test_job_role_title.py
tests/test_migrate_application_outreach.py
tests/test_profile_memory.py
tests/test_recheck_application_draft.py
tests/test_relay_runner_streaming.py
tests/test_resolve_application_contacts.py
tests/test_rewrite_cover_letter_batch.py
tests/test_scraper_detail_readiness.py
tests/test_scraper_resume.py
tests/test_workflow_contracts.py
tests/test_workflow_state.py
```

- **XHS-TST-015 [HEAD]**：8 个浏览器 suite 分别验证 runtime smoke、audience AI、batch application workbench、Data Copilot、expansion workspace、job journey progress、live profile AI、unsaved draft guard。

```text
tests/e2e/app-runtime-smoke.spec.ts
tests/e2e/audience-ai.spec.ts
tests/e2e/batch-application-workbench.spec.ts
tests/e2e/data-copilot.spec.ts
tests/e2e/expansion-workspace.spec.ts
tests/e2e/job-journey-progress.spec.ts
tests/e2e/profile-ai-live.spec.ts
tests/e2e/unsaved-draft-guard.spec.ts
```

## npm 验证入口

- **XHS-TST-016 [HEAD]**：`npm test` 以 Node test runner、`--test-concurrency=4` 执行 `server/*.test.mjs`、`server/lib/*.test.mjs`、`tests/*.test.mjs`。
- **XHS-TST-017 [HEAD]**：`test:python` 是 `python -m pytest -q`；`test:agents` 单跑 `tests/test_application_intelligence_agents.py -v`。
- **XHS-TST-018 [HEAD]**：`test:api` 选择 app/app-security/contracts/data-lifecycle-http/draft-http/preflight-http 6 个文件，因此它与 Node 全量存在重叠。
- **XHS-TST-019 [HEAD]**：`test:artifacts` 单跑 `tests/mock-runner.test.mjs`；`test:credentials` 执行 `scripts/check-credentials.mjs`。
- **XHS-TST-020 [HEAD]**：`test:mailpit` 单跑 `server/mailpit.integration.mjs`；该文件不是 `.test.mjs`，所以不在 96 文件静态计数中。
- **XHS-TST-021 [HEAD]**：`test:e2e` 为 `playwright test`；`audit:dependencies` 为 `npm audit --audit-level=high`。
- **XHS-TST-022 [HEAD]**：Copilot 专项入口包括 eval、contract、recovery、migration；MCP 专项 `test:mcp` 运行 `server/mcp-*.test.mjs`。
- **XHS-TST-023 [HEAD]**：统一 `npm run check` 顺序是 lint -> format check -> typecheck -> Node -> Python -> API -> frontend build -> Artifact -> credential scan。
- **XHS-TST-024 [HEAD]**：`npm run check` 没有包含 Playwright、Mailpit、dependency audit 或 MCP production verifier；这些有独立命令/CI job。
- **XHS-TST-025 [HEAD]**：format check 扫 repo-files helper 返回的文本扩展，忽略 `package-lock.json`，检查 NUL、文件末尾换行和行尾空白；它不是 Prettier AST 格式化。

## Mock runner 与 Artifact 验收

- **XHS-TST-026 [HEAD]**：`tests/fixtures/mock_xiaohongshu_runner.py` 是标准库 fixture，不访问小红书，也不读取 token。
- **XHS-TST-027 [HEAD]**：mock success exit 0，流式输出进度并生成 JSON、CSV、XLSX 与 SHA-256 manifest。
- **XHS-TST-028 [HEAD]**：mock failure 默认 exit 1，仅发布 failed manifest；long 在取消后 exit 130，保留 partial card checkpoint。
- **XHS-TST-029 [HEAD]**：mock 接受真实 runner 的 keyword/search-url/output-dir/limit/relay-port/browser-profile/resume/fresh 参数，未知真实参数被忽略，以便复用 spawn adapter。
- **XHS-TST-030 [HEAD]**：fixture 控制参数包括 records、delay seconds、long seconds、cancel file、failure exit code，并有对应环境变量。
- **XHS-TST-031 [HEAD]**：Artifact verifier 检查 lexical/resolved path 都在 allowed root、对象为普通路径且非 symlink、manifest size/hash、latest/dedup note ID、CSV count、XLSX ZIP 必需条目。
- **XHS-TST-032 [HEAD]**：mock self-test覆盖 success、failure、cancellation、allowed-root rejection 与 checksum tamper rejection，且只清理其私有 OS temp 目录。

## Playwright 配置

- **XHS-TST-033 [HEAD]**：`playwright.config.ts` testDir 为 `tests/e2e`，outputDir 为 `test-results/playwright`，单 test timeout 60 秒，expect timeout 10 秒。
- **XHS-TST-034 [HEAD]**：fullyParallel=false、workers=1、retries=0、line reporter；设备为 Desktop Chrome。
- **XHS-TST-035 [HEAD]**：默认 API port 4318、Web port 5190；可分别由 `PLAYWRIGHT_API_PORT`、`PLAYWRIGHT_WEB_PORT` 覆盖。
- **XHS-TST-036 [HEAD]**：未配置 `PLAYWRIGHT_SERVER_DATA_ROOT` 时创建唯一 OS temp root，并在进程 exit 尝试递归清理；API 的 jobs/profiles 各写到该 root 子目录。
- **XHS-TST-037 [HEAD]**：测试 API 以 `node server/index.mjs` 启动，绑定 127.0.0.1，MCP 被设为 false；Vite 严格端口启动。
- **XHS-TST-038 [HEAD]**：两个 webServer 都 `reuseExistingServer=false`、启动 timeout 120 秒，避免误用开发者已有服务。
- **XHS-TST-039 [HEAD]**：navigation timeout 45 秒；trace 仅失败时保留，截图仅失败时保存；视觉截图关闭 animations、隐藏 caret。
- **XHS-TST-040 [HEAD]**：34 张视觉基准带平台/视口后缀；10=5 视口 x 2 OS，18=3 状态 x 3 视口 x 2 OS，6=3 视口 x 2 OS。

## GitHub Actions CI

- **XHS-TST-041 [HEAD]**：`.github/workflows/ci.yml` 名为 CI，在每次 push 与 pull_request 触发。
- **XHS-TST-042 [HEAD]**：verify job 矩阵为 ubuntu-latest 与 windows-latest，Node 22、Python 3.13，并启用 npm/pip cache。
- **XHS-TST-043 [HEAD]**：verify job 顺序为 checkout、setup Node/Python、`npm ci`、安装 requirements、`npm run check`、`npm run audit:dependencies`。
- **XHS-TST-044 [HEAD]**：browser job 只跑 ubuntu-latest，安装 Chromium 及系统依赖，再执行 `npm run test:e2e`。
- **XHS-TST-045 [HEAD]**：browser 失败时上传 `test-results/playwright`，artifact 名带 run_id/run_attempt，缺文件忽略，保留 7 天。
- **XHS-TST-046 [HEAD]**：mailpit job 只跑 ubuntu-latest，service image 固定 `axllent/mailpit:v1.30.6`，映射 SMTP 1025 与 HTTP 8025。
- **XHS-TST-047 [HEAD]**：Mailpit 测试通过 `MAILPIT_SMTP_PORT=1025` 和 `MAILPIT_HTTP_URL=http://127.0.0.1:8025` 连接隔离服务。
- **XHS-TST-048 [HEAD]**：CI 没有 path filter、手工 workflow_dispatch、并发取消或覆盖率上传配置；release 是另一 workflow。

## Release workflow 与打包器

- **XHS-TST-049 [HEAD]**：`.github/workflows/release.yml` 在 main push、`v*` tag push、workflow_dispatch 触发，权限为 `contents:write`。
- **XHS-TST-050 [HEAD]**：release concurrency group 为 `release-${github.ref}`，`cancel-in-progress=false`。
- **XHS-TST-051 [HEAD]**：唯一 job `one-click-windows` 跑 windows-latest，timeout 45 分钟，checkout fetch-depth 0，Node 22、Python 3.13。
- **XHS-TST-052 [HEAD]**：release 安装使用 `npm ci --no-audit --no-fund` 与 pip requirements，然后执行 `npm run build`。
- **XHS-TST-053 [HEAD]**：`package-github-release.ps1` 默认 SourceRef=HEAD，通过 `git archive --format=zip --prefix=<ArchiveRoot>/` 从 Git object 创建源码包，因此 dirty/untracked 文件不会静默进入该 archive。
- **XHS-TST-054 [HEAD]**：打包器要求 README、ONE_CLICK_START、Windows/Linux/macOS start scripts、bootstrap、prerequisite installer、package/lock/requirements/env example、server entry、React entry 存在。
- **XHS-TST-055 [HEAD]**：打包器拒绝 `.git`、node_modules、dist、data、runtime、`.runtime`、test-results、playwright-report 目录；拒绝非 example `.env` 与 sqlite/db/log/pem/pfx/key 扩展。
- **XHS-TST-056 [HEAD]**：打包器逐条打开并读取 ZIP entry 以验证可读性，随后生成独立小写 SHA-256 文件，并输出 archive/checksum/hash/sourceRef/commit/entryCount JSON。
- **XHS-TST-057 [HEAD]**：Release workflow 用 `verify-github-release.ps1` 在端口 65431 解压验证安装和 health。
- **XHS-TST-058 [HEAD]**：验证包与 checksum 作为 Actions artifact 上传，缺文件报错，保留 30 天。
- **XHS-TST-059 [HEAD]**：tag 事件先查询既有 release；存在则 `gh release upload --clobber`，否则 `gh release create --verify-tag --generate-notes --title <tag>`。
- **XHS-TST-060 [HEAD]**：annotated tag `v3.0.0` 指向 `c56bec7dc9adc4ee700515685689e630a7a6a49b`，tagger 时间 2026-08-17 15:49:31 +0800，message 为 `v3.0.0 verified one-click release`。
- **XHS-TST-061 [HEAD]**：当前 HEAD `1fa74a0` 是 tag 后的修复提交，标题 `fix: make job recovery visible and repair quality gates`；该修复不属于 tag commit 内部代码。

## 历史验收报告：只作旧证据

- **XHS-TST-062 [R]**：`docs/PHASE10_FINAL_ACCEPTANCE.md` 的环境日期为 2026-08-01，结论为 `P0 feature-complete, acceptance pending`，不是本轮重跑结果。
- **XHS-TST-063 [R]**：该历史报告记录 Node 221/221、Python 207/207、API 子集 48/48、Playwright 11/11、Mailpit 1/1、Artifact 1/1。
- **XHS-TST-064 [R]**：报告记录 dependency audit 覆盖 150 packages、0 vulnerability，且凭据扫描通过；这些数值对应当时依赖/代码快照。
- **XHS-TST-065 [R]**：报告记录 `npm run check` 首轮 34.272 秒、最终提交态 42.2 秒。
- **XHS-TST-066 [R]**：历史视觉验收使用 390x844、768x1024、1440x900 三档视口，11 项 Playwright，报告为 0 变化像素。
- **XHS-TST-067 [R]**：历史性能表记录 Node 216 项基线 6806.55 ms，对比 221 项 6651.25-7888.47 ms；Python 207 项基线 5.68 s，对比 5.01-6.85 s；Playwright 11 项 86.907 s 对比 76.331-85.1 s。
- **XHS-TST-068 [R]**：该报告明确保留 Linux remote CI、生产 SMTP 控制地址实投、同一正式 Job 全采集与 Agent 性能验收三类缺口。
- **XHS-TST-069 [R]**：`docs/PUBLIC_RELEASE_VERIFICATION.md` 日期为 2026-08-10，描述历史 r4 公共包，不是 2026-08-18 当前 worktree 包。
- **XHS-TST-070 [R]**：r4 报告记录 Vite 1,604 modules、一键启动 5/5、MCP 自动化 7/7、包内 Web/MCP 隔离启动与 credential scan；报告又明确这些来自匿名展示修复前的旧打包轮次。
- **XHS-TST-071 [R]**：r4 报告声明公共包排除 715 条私有历史数据、简历、附件、浏览器 Profile/Cookie、管理员、Session Secret、API Key、SMTP 密码、MCP token/pepper、Tunnel token/证书。
- **XHS-TST-072 [R]**：历史报告数字与当前静态定义数不可直接比较：pytest 参数化、测试重构、tag 后提交以及静态词法计数口径不同。

## 当前审计边界

- **XHS-TST-073 [S]**：本轮执行了 Git object 静态计数、workflow/package/playwright 配置读取和 Markdown 验证；没有把 2026-08-01/10 报告转述成当日运行。
- **XHS-TST-074 [W]**：工作区已有测试源码增量；其文件/行数和 untracked Codex tests 详见 `worktree-experiments.md`，未计入 HEAD 96/29/8。
- **XHS-TST-075 [HEAD]**：对面试最稳妥的表述是“仓库有跨 Node/Python/browser/SMTP/package 的自动化矩阵，CI 当前定义 Linux+Windows verify、Linux Chromium 和 Mailpit；历史报告留有外部集成/正式任务验收缺口”。

## 复核命令

```powershell
git ls-tree -r --name-only HEAD
git show HEAD:package.json
git show HEAD:playwright.config.ts
git show HEAD:.github/workflows/ci.yml
git show HEAD:.github/workflows/release.yml
git show HEAD:scripts/package-github-release.ps1
git show HEAD:docs/PHASE10_FINAL_ACCEPTANCE.md
git show HEAD:docs/PUBLIC_RELEASE_VERIFICATION.md
git show --no-patch --format=fuller v3.0.0
```
