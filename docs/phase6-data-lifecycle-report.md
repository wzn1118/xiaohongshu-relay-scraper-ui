# 第 6 阶段：本地数据生命周期与安全删除验收报告

日期：2026-08-01
范围：Profile、Job、Draft、Artifact 及 Job 所属 Checkpoint、Log、导出文件和 manifest。

## 实现摘要

- 新增统一的 `DataLifecycleService`。删除操作必须依次经过 dry-run、一次性确认令牌、计划指纹复核、串行执行和脱敏审计。
- Profile 有 Job 引用时默认阻断；用户明确使用 `force` 并重新确认影响范围后，仅解除引用并删除 Profile。
- Job 删除先登记删除意图，关闭相关 SSE，停止并等待子进程退出，等待分析任务、写队列和运行上下文释放，再删除磁盘数据和内存索引。
- 自动清理默认关闭；启用后仍跳过运行中、恢复中、排队中和用户固定保留的任务，并在删除锁内再次检查状态。
- 路径校验覆盖直接子目录约束、`realpath` 边界、路径穿越、符号链接逃逸和跨 Job Artifact。
- 前端仅在历史任务标题栏复用原有按钮样式增加“本地数据”入口，未修改 CSS、导航、卡片结构和已有操作路径。

## 数据所有权模型

| 所有者 | 从属实体 | 删除规则 |
|---|---|---|
| Profile | Job 引用 | 默认阻断；force 后解除引用并删除 Profile |
| Job | Draft | 随 Job 级联物理删除 |
| Job | Artifact / manifest | 随 Job 级联删除；单独删除 Artifact 时同步刷新 manifest 和计数 |
| Job | Checkpoint / workflow state / ledger | 随 Job 目录级联物理删除 |
| Job | Log / audit / attempt log | 随 Job 目录级联物理删除 |

Relay、AI Provider 和 SMTP 配置不属于本阶段 clear-all 所有权树，不会被该操作删除。

## 删除 API 契约

| 方法与路径 | 用途 | 关键字段 |
|---|---|---|
| `GET /api/data/ownership` | 查询所有权关系 | `schemaVersion`, `relations` |
| `POST /api/data/deletions/preview` | 删除 dry-run | `entityType`、实体 ID、`force` |
| `POST /api/data/deletions/execute` | 执行已确认计划 | preview 字段、`confirmationToken`；clear-all 还需 `confirmationPhrase` |
| `GET /api/data/retention` | 读取保留策略 | `enabled`, `days`, `pinnedJobIds` |
| `PUT /api/data/retention` | 显式设置保留策略 | `enabled`, `days` 1-3650, `pinnedJobIds` |
| `POST /api/data/retention/cleanup` | 执行或预览保留期清理 | `dryRun`，默认 `true` |

dry-run 返回将删除的实体、文件数、总字节数、引用关系、阻断原因、所有权模型、5 分钟一次性确认令牌和过期时间。执行前重新扫描；实体、文件或引用发生变化会导致计划指纹失效。clear-all 必须额外输入 `DELETE ALL LOCAL DATA`。

## 级联删除和状态同步

- Profile：删除 Profile 文件，并刷新 Profile 存储；force 模式同步解除 Job 配置中的引用。
- Job：删除 Job 根目录内的 checkpoint、workflow state、ledger、日志、attempt 日志、草稿、导出和 manifest，再移除 JobManager 索引、缓存、运行状态和历史记录。
- Draft：同步删除当前草稿、旧版备份、发送状态和相关审计记录。
- Artifact：仅允许删除目标 Job manifest 声明的直接子文件；同步使 manifest 条目失效并刷新内存计数。
- clear-all：删除全部 Job 和 Profile 用户数据；保留 Relay、AI Provider、SMTP 配置。
- 删除后旧 Job ID、Draft ID、Artifact URL 均由原 API 返回未找到，磁盘文件和内存索引同步消失。

## 保留期设计

- 默认策略：`enabled: false`，不会自动删除任何旧数据。
- 用户必须显式设置启用状态、天数和固定保留 Job ID。
- 服务启动时和每日定时检查；关闭状态只返回预览信息。
- 候选仅包含超过保留期且非运行、非恢复、非排队、非固定保留的 Job。
- 实际删除在 Job 删除意图锁内重新检查状态；状态在候选生成后变化时跳过，避免与恢复操作竞态。

## 安全与审计

- 所有删除目标先解析为受控根目录下的直接子路径，再检查 `realpath`；拒绝 `..`、绝对路径、符号链接逃逸和跨 Job 删除。
- Job 删除意图阻止并发 resume；运行中 Job 先停止并等待子进程、分析任务、写队列、文件句柄和运行上下文释放。
- 预览令牌单次使用、短时有效，并绑定规范化请求和实时扫描结果；重放、过期和计划变化全部 fail closed。
- 执行队列串行化破坏性操作，避免交叉删除和索引竞态。
- 审计仅保存随机审计 ID、实体 ID 的 SHA-256、操作类型、结果、计数和时间；不保存姓名、正文、邮箱、原始实体 ID或文件内容。
- 真实工作目录只执行 ownership、retention 读取和 cleanup dry-run；破坏性验收全部在隔离临时目录完成。

## A. 功能零回归矩阵

| 功能组 | 修改前 | 修改后 | 回归证据 | 用户可见变化 |
|---|---|---|---|---|
| Relay 检查、连接、恢复、真实浏览器链路 | 存在 | 保留 | relay/native/preflight Node tests | 无 |
| AI Provider、模型发现、选择和调用 | 存在 | 保留 | AI session/provider tests | 无 |
| Profile 创建、编辑、导入、读取 | 存在 | 保留 | profile/contract/legacy tests | 新增受控删除能力 |
| 关键词、搜索、发现、正文补全 | 存在 | 保留 | contracts/application/Python crawler fixtures | 无 |
| 实时状态、SSE、停止、恢复、检查点 | 存在 | 保留 | JobManager/workflow/SSE tests | 删除期间新增兼容 closing 状态 |
| 原 Job 原地续跑、Attempt、受众补采 | 存在 | 保留 | resume/audience tests | 无 |
| 八阶段 Agent、岗位结构化、候选人事实 | 存在 | 保留 | application/analysis fixtures | 无 |
| 匹配、私信、邮件、Cover Letter | 存在 | 保留 | draft/application tests | 无 |
| 评分、重写、编辑、草稿保存 | 存在 | 保留 | draft store/quality tests | 新增草稿删除能力 |
| SMTP 测试与发送 | 存在 | 保留 | mail/smtp/delivery tests | 无 |
| 历史任务、Artifact 浏览和下载 | 存在 | 保留 | app/artifact tests | 标题栏新增本地数据入口 |
| JSON/CSV/XLSX/Markdown/manifest | 存在 | 保留 | artifact schema/runner tests | 无 |
| Windows/Linux 启动与诊断 | 存在 | 保留 | launcher/check-mode tests | 无 |

前 5 阶段提交仍位于当前历史：`d3a6d77`、`21c29a3`、`6b11d51`、`715c55d`、`547cb0b`。

## B. 前端视觉对比

- 基线：`test-results/phase6-baseline/visual/`；最终：`test-results/phase6-final/visual/`。
- 1440x900 同位置比较：130 / 1,296,000 像素变化，即 `0.0100%`；平均通道绝对差 `0.0068`，差异来自动态时间文字。
- 完整桌面页面保持 `1440x8155`；完整平板和手机页面高度分别变化 2 px，来源为历史标题栏必要入口。
- 390x844、768x1024、1440x900 均验证入口可见、可点击且无横向溢出。
- CSS 产物保持 107.56 kB（gzip 19.71 kB），本阶段没有修改 CSS。

## C. 采集能力对比

任务参数、搜索入口、关键词、发现、唯一 ID、正文补全、并发、重试、安全验证、中断、原地恢复、原始字段和 Artifact 结构均未修改。Node 的 contracts、application、audience、JobManager 测试及 207 项 Python fixtures 全部通过；生产路径继续使用既有 Relay 和 Runner。

## D. AI 分析能力对比

八阶段顺序、输入输出、岗位字段、候选人事实、evidence、匹配结果、三类文案、评分、重写、Provider 和 Artifact 均未修改。完整 Node 回归覆盖固定响应和草稿质量门禁，没有阶段或字段删除。

## E. 接口兼容报告

- 没有删除、重命名或改变任何既有 API、请求字段、响应字段、Artifact 路径或 SSE 事件名称。
- 新增 6 个 `/api/data/*` 端点；旧 Job、Profile、Draft、Artifact 继续由原适配器读取。
- Job 删除时的内部 `closing` 状态映射为既有 `status` SSE 格式后再关闭连接，旧客户端仍可解析。
- 旧 Profile/Job 兼容专项测试及旧 Draft/Artifact 迁移读取测试随完整套件通过。

## F. 性能对比

| 指标 | 修改前基线 | 最终 | 说明 |
|---|---:|---:|---|
| CSS | 107.56 kB / gzip 19.71 kB | 107.56 kB / gzip 19.71 kB | 无变化 |
| JS | 402.78 kB / gzip 121.54 kB | 408.16 kB / gzip 123.44 kB | +5.38 kB / +1.90 kB，用于生命周期客户端和确认流程 |
| Vite build | 2.61 s | 4.21 s | 单次非隔离 wall time，受系统负载影响，不作为页面退化结论 |
| 固定视口横向溢出 | 0 | 0 | 三档视口均通过 |

正式采集耗时、Relay 检查、单条正文补全、Agent 阶段、Artifact 生成、内存、空闲 CPU 和 SSE 延迟没有在同一隔离环境取得成对数据，因此不作无证据的性能结论。

## 修改文件

- `server/data-lifecycle-service.mjs`
- `server/data-lifecycle-service.test.mjs`
- `server/data-lifecycle-http.test.mjs`
- `server/data-lifecycle-runtime.test.mjs`
- `server/job-manager.mjs`
- `server/app.mjs`
- `server/config.mjs`
- `server/index.mjs`
- `src/api.ts`
- `src/types.ts`
- `src/App.tsx`
- `docs/phase6-data-lifecycle-report.md`

## 测试与物理验证

- `npm test`：205 / 205 passed。
- `npm run test:python`：207 / 207 passed。
- `npm run build`：TypeScript 与 Vite production build passed。
- 定向生命周期、JobManager、HTTP 测试：59 / 59 passed。
- 最新 API smoke：health、ownership、默认关闭的 retention cleanup dry-run passed。
- 隔离临时目录验证未引用/引用/force Profile、完成/失败/运行中 Job、Draft、Artifact 和 clear-all 的磁盘与索引同步清理。
- 专项测试验证 traversal、symlink escape、cross-Job、过期/重放/计划变化令牌全部拒绝。
- 真实用户数据没有执行破坏性验收。

## 剩余风险与结论

- 本轮未重新执行真实 Relay 采集、真实 SMTP 发送及全指标隔离性能基准。
- 物理删除证据来自隔离临时目录；真实工作目录只执行非破坏性 API smoke。
- 阶段代码、专项测试和兼容层已完成；按发布结论限制，当前结论为：**P0 feature-complete, acceptance pending**。

建议提交信息：`feat(data): add safe and auditable local data lifecycle controls`。精确提交哈希以最终阶段提交为准。
