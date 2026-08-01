# 第 10 阶段最终验收报告

日期：2026-08-01

基线提交：`fb143fbad8500c7bc807fa30c2c1f34be9736c80`

验证环境：Windows 11、Node.js 22、Python 3.13、Chromium、真实本机 Relay、真实本机 Ollama、隔离 Mailpit SMTP

## 1. 十阶段结果

**结果：部分完成。**

已完成统一 `npm run check`、Node/Python/API/Artifact/凭据回归、三档 Playwright、依赖审计、Windows 真实 Mailpit 投递、结构化诊断、真实 Relay 探测和真实本地 AI 会话创建。没有在行为基线稳定后强行拆分 `App`、`JobManager`、Runner 或 Agent。

保留项是 Linux 远程 CI、生产 SMTP 控制地址实投，以及同一正式 Job 的完整采集与八阶段 Agent 性能对照。因此本阶段不能判定为发布就绪。

## 2. 功能零回归矩阵

“修改前”指第 10 阶段冻结基线；“修改后”指本报告对应提交。第 10 阶段没有新增可见 UI 文案或布局。

| 功能 | 修改前 | 修改后 | 回归证据 | 用户可见变化 | 退化 |
|---|---|---|---|---|---|
| FR-001 运行就绪状态 | 存在 | 保留 | `server/app.test.mjs`、`server/preflight-http.test.mjs` | 无 | 否 |
| FR-002 Relay 配置/检测/恢复 | 存在 | 保留并增加恢复并发约束 | `server/relay-connect.test.mjs`、`server/relay-supervisor.test.mjs`、`server/relay-app-concurrency.test.mjs` | 无 | 否 |
| FR-003 AI Provider/模型 | 存在 | 保留 | `server/ai-session-store.test.mjs`、真实本地会话 201 | 无 | 否 |
| FR-004 Profile 与事实来源 | 存在 | 保留 | `server/profile-store.test.mjs`、Python Agent 回归 | 无 | 否 |
| FR-005 任务参数 | 存在 | 保留 | `server/contracts.test.mjs`、`tests/test_audience_collection.py` | 无 | 否 |
| FR-006 仅预检不建 Job | 存在 | 保留 | `server/preflight-http.test.mjs` | 无 | 否 |
| FR-007 中断、停止、原地续跑 | 存在 | 保留并强化原 Job 身份 | `server/job-manager.test.mjs`、`server/app.test.mjs` | 无 | 否 |
| FR-008 SSE 实时状态 | 存在 | 保留 | `server/app.test.mjs`、`server/job-manager.test.mjs` | 无 | 否 |
| FR-009 结果与缺失原因 | 存在 | 保留 | `server/application-results.test.mjs`、`server/audience-results.test.mjs` | 无 | 否 |
| FR-010 能力与证据 | 存在 | 保留 | `tests/test_application_intelligence_agents.py` | 无 | 否 |
| FR-011 三类岗位专属文案 | 存在 | 保留 | Python Agent 回归、`server/draft-http.test.mjs` | 无 | 否 |
| FR-012 质量门禁与重写 | 存在 | 保留并绑定版本/哈希 | `server/draft-quality-checker.test.mjs`、`server/draft-http.test.mjs` | 无 | 否 |
| FR-013 编辑/保存/未保存 Guard | 存在 | 保留 | `tests/e2e/unsaved-draft-guard.spec.ts` 11/11 | 无 | 否 |
| FR-014 投递路线与证据 | 存在 | 保留 | Python Agent 回归、`server/draft-http.test.mjs` | 无 | 否 |
| FR-015 服务端邮件门禁 | 存在 | 保留并增加幂等/审计约束 | `server/draft-http.test.mjs`、Mailpit 实投 | 无 | 否 |
| FR-016 私信人工确认 | 存在 | 保留 | Playwright Guard 与 API 契约回归 | 无 | 否 |
| FR-017 历史与原 Job 续跑 | 存在 | 保留 | `server/job-manager.test.mjs`、`server/application-results.test.mjs` | 无 | 否 |
| FR-018 导出与任务隔离 | 存在 | 保留 | `tests/mock-runner.test.mjs`、Artifact 回归 | 无 | 否 |
| FR-019 敏感信息保护 | 存在 | 保留并增加凭据扫描/诊断白名单 | `tests/credential-scan.test.mjs`、`server/diagnostics.test.mjs` | 无 | 否 |
| FR-020 390px 响应式 | 存在 | 保留 | 390x844、768x1024、1440x900 Playwright | 无 | 否 |

## 3. 前端视觉对比

第 10 阶段修改前、修改后均运行 11 项 Playwright。确认弹窗在三档视口使用已有基准，不更新基准截图：

| 视口 | 基准 | 修改后实拍 | 变化像素 | 最大通道差 |
|---|---|---|---:|---:|
| 390x844 | `tests/e2e/unsaved-draft-guard.spec.ts-snapshots/mobile-390x844-win32.png` | `output/playwright/phase9-after/mobile-390x844.png` | 0 | 0 |
| 768x1024 | `tests/e2e/unsaved-draft-guard.spec.ts-snapshots/tablet-768x1024-win32.png` | `output/playwright/phase9-after/tablet-768x1024.png` | 0 | 0 |
| 1440x900 | `tests/e2e/unsaved-draft-guard.spec.ts-snapshots/desktop-1440x900-win32.png` | `output/playwright/phase9-after/desktop-1440x900.png` | 0 | 0 |

没有合法新增提示，也没有视觉基准更新。第 7 阶段留下的 13 个页面状态 x 3 视口截图仅作为旧证据，不冒充本轮重新执行结果。

## 4. 采集能力对比

| 维度 | 基线 | 修改后 | 证据 |
|---|---|---|---|
| 参数 | 全量/限定、排序、时间、节奏、高级参数 | 保留 | contracts + Python collection tests |
| 发现 | 搜索发现并持久化链接 | 保留 | audience collection fixtures |
| 正文 | 未采集/部分采集/已采集，缺失正文补采 | 保留 | artifact IO + collection tests |
| 字段 | 帖子、评论、用户、覆盖摘要 | 保留 | audience results tests |
| 去重 | URL/帖子/评论/用户去重 | 保留 | Python fixtures |
| 重试 | 有界重试和失败原因 | 保留 | Python fixtures、JobManager tests |
| 停止 | 人工停止、稳定停止原因 | 保留 | JobManager tests |
| 恢复 | 同一 Job 原地续跑，重复点击附着 | 强化 | app/application results/JobManager tests |
| Artifact | 旧数据可读，manifest 与 SHA-256 | 保留 | mock runner + artifact IO tests |
| 性能 | 第 10 阶段没有同口径正式采集基线 | 未判定 | 见第 8 节 |

2026-08-01 本轮真实运行实例探测：Relay `running=true`、`cdpReady=true`、`authenticated=true`，18800 端口有 2 个目标页面。该探测证明连接可用，不等同于本轮完成正式全量采集验收。

## 5. AI 分析能力对比

八阶段 Agent、输入结构、结构化输出、evidence、claim 约束、匹配、私信/邮件/Cover Letter、评分、重写和 Artifact 均由 207 项 Python 回归中的 Agent/Artifact fixtures 覆盖，基线与修改后均通过。草稿修改后质量状态变为 stale，只有对精确版本和内容哈希复核通过才能发送。

本轮真实本地 AI 探测：Ollama 0.32.5 在线，检测到 3 个已安装模型；`qwen3.5:4b` 会话创建返回 HTTP 201。该探测证明模型会话可建立，不等同于本轮重新执行完整八阶段正式 Job。

## 6. 接口兼容报告

- 保留接口：Job 创建、预检、SSE、Artifact、结果、Profile、Relay、AI、SMTP、停止、恢复、草稿和发送接口。
- 新增接口：`GET /api/diagnostics/bundle`；所有 HTTP 响应增加 `X-Request-Id`。
- 兼容接口：旧 audience resume 入口映射到规范化 `POST /api/jobs/:jobId/resume`，旧草稿和旧质量字段通过迁移适配读取。
- SSE：既有 snapshot/status/log/artifacts/done/error 语义未删减；诊断记录旁路消费非日志事件，不改变客户端载荷。
- Artifact：schema 和下载隔离保持；manifest SHA-256 回归通过。
- 旧数据：旧 Job、旧 audience 链和旧草稿 fixture 均可读取；迁移不覆盖原 Artifact。

## 7. 测试报告与 PRD 对照

### 7.1 本轮结果

| 类别 | 总数 | 通过 | 失败 | 跳过 | 环境 |
|---|---:|---:|---:|---:|---|
| Node 全量 | 221 | 221 | 0 | 0 | Windows |
| Python 全量 | 207 | 207 | 0 | 0 | Windows |
| API 契约子集（与 Node 重叠） | 48 | 48 | 0 | 0 | Windows |
| Playwright | 11 | 11 | 0 | 0 | Windows Chromium |
| Mailpit SMTP 实投 | 1 | 1 | 0 | 0 | Windows Mailpit 1.30.6 |
| Artifact 专项（与 Node 重叠） | 1 | 1 | 0 | 0 | Windows |
| 依赖审计 | 150 个包 | 0 漏洞 | 0 | 0 | npm audit |
| 凭据扫描 | 受管源文件全量 | 通过 | 0 | 0 | Windows |

统一命令 `npm run check` 首轮用时 34.272 秒，最终提交态复跑用时 42.2 秒，依次执行 lint、format check、TypeScript、Node、Python、API、前端构建、Artifact 和凭据检查。Linux CI 与 Windows CI 已写入 `.github/workflows/ci.yml`；本轮没有远程 CI 执行证据，Linux 标为待验收。

### 7.2 FR-001 至 FR-020

FR-001～FR-020 的代码与测试证据见第 2 节逐行矩阵。全部为自动化通过或真实探测通过；FR-015 的生产 SMTP 实投、FR-005～FR-012 的正式全链 Job 仍需发布验收。

### 7.3 AC-01 至 AC-12

| AC | 结果 | 代码证据 | 测试证据 |
|---|---|---|---|
| AC-01 Relay 缺失阻断 | 通过 | `server/preflight-service.mjs` | preflight HTTP tests；真实 Relay 探测 |
| AC-02 AI 缺失阻断 | 通过 | `server/preflight-service.mjs` | preflight tests；真实本地 AI 会话 |
| AC-03 新建任务与实时状态 | 通过 | `server/app.mjs`、`server/job-manager.mjs` | app + JobManager tests |
| AC-04 全量采集与正文尝试 | fixture 通过 | `scripts/audience_collection.py` | Python collection tests |
| AC-05 正文失败与覆盖摘要 | 通过 | artifact IO、audience results | Python + audience result tests |
| AC-06 结构化分析 | fixture 通过 | Agent scripts | application intelligence tests |
| AC-07 事实边界 | fixture 通过 | evidence/claim validators | Agent + draft quality tests |
| AC-08 质量门禁 | 通过 | draft store/checker | draft HTTP/store/checker tests |
| AC-09 邮件发送 | 隔离环境通过 | send-email + SMTP config | draft HTTP + Mailpit；生产实投待验收 |
| AC-10 续跑与重试 | 通过 | JobManager + resume APIs | JobManager/app/application results tests |
| AC-11 导出 | 通过 | artifact writer/download | artifact IO + mock runner tests |
| AC-12 响应式 | 通过 | `src/App.tsx` | 三视口 Playwright，0 变化像素 |

## 8. 性能对比

| 指标 | 修改前 | 修改后 | 变化 | 结论 |
|---|---:|---:|---:|---|
| Node 全量框架耗时 | 6806.55 ms（216 项） | 6651.25～7888.47 ms（221 项，两次） | -2.3%～+15.9%，且增加 5 项 | 有单次波动，未形成稳定退化结论 |
| Python 207 项 | 5.68 s | 5.01～6.85 s（两次） | -11.8%～+20.6% | 有单次波动，未形成稳定退化结论 |
| 前端构建 | 2.72 s | 2.54～2.70 s（两次） | -6.6%～-0.7% | 无退化 |
| Playwright 11 项墙钟 | 86.907 s | 76.331～85.1 s（两次） | -12.2%～-2.1% | 无退化 |
| CSS | 109.01 kB / gzip 19.98 kB | 相同 | 0 | 无退化 |
| JS | 416.46 kB / gzip 126.53 kB | 相同 | 0 | 无退化 |
| 页面交互响应 | 无独立基线 | Guard 竞态 11/11 | 不可比 | 功能通过，性能待正式基准 |
| 正式 Job 启动 | 无同口径基线 | 未测 | 不可比 | 待发布验收 |
| Relay 检查 | 无同口径基线 | 实时探测成功 | 不可比 | 待记录耗时基线 |
| 单条正文补全/任务总耗时 | 无同口径基线 | 未执行正式 Job | 不可比 | 待发布验收 |
| Agent 各阶段 | 无同口径基线 | fixture 通过 | 不可比 | 待正式 Job |
| Artifact 生成 | 无独立基线 | 专项通过 | 不可比 | 待记录耗时基线 |
| 内存/空闲 CPU/SSE 延迟 | 无同口径基线 | 未测 | 不可比 | 待发布验收 |

构建、Bundle 和 Playwright 没有退化；Node/Python 单次复跑出现双向波动，尚不足以归因给代码，也不据此宣称性能通过。不可比较指标不作“影响可接受”的推断，全部保留为验收缺口。

## 9. 剩余风险

- 发布阻断：生产 SMTP 控制地址未在本轮实投；Linux 远程 CI 未实际运行；正式全量采集 + 八阶段 Agent 未在本轮按同一 Job 完成性能验收。
- P0 必修：发布前执行上述三项并保存 Job ID、邮件 Message-ID、CI run URL 与性能 JSON。
- P1：把正式 Job 的启动、Relay、正文、Agent、Artifact、内存、CPU、SSE 延迟固化为可重复 benchmark。
- 可接受风险：诊断保留最近 500 个白名单事件；不记录自由文本日志、帖子正文、邮件正文、凭据或任意对象。

发布手工验收顺序：先在控制地址验证 SMTP，再运行一个小规模正式 Job，检查发现/正文/评论/用户/八阶段/三类文案/Artifact，随后停止并原地续跑同一 Job，最后删除测试 Job 并验证 Artifact 不再可访问。每一步记录 requestId、jobId、stageId、errorCode、耗时、重试和停止原因。

## 10. 数据迁移与回滚

- 迁移：旧草稿在读取时迁移为不可变版本；原 Artifact 保留。旧 audience 续跑链按 root Job 聚合，重复点击附着到原任务。
- 诊断：默认写入本地 JSONL，只接受固定字段；诊断 bundle 可导出，删除该文件不影响业务数据。
- 回滚：先停止活动 Job并备份 `data/`，按逆序执行 `git revert 05595d52b60ebac190c6fb93feeb41e1edb286c6`、`git revert 349d3c73cf01df4a280a8aab9f1808ecd3cefe86`，再执行旧版本 `npm run check`。不删除已有 Job、Artifact 或 checkpoint。

## 11. 最终提交哈希列表

- `349d3c73cf01df4a280a8aab9f1808ecd3cefe86` `feat(core): finalize recovery, delivery, and diagnostics`
- `05595d52b60ebac190c6fb93feeb41e1edb286c6` `test(core): add full regression and release verification`
- 本报告提交哈希由提交后 `git log -1` 记录，避免在文件中自引用哈希。

## 最终发布结论

**P0 feature-complete, acceptance pending**
