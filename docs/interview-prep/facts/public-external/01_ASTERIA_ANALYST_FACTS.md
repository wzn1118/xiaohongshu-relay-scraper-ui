# AsteriaAnalyst 事实档案

> 面试定位：这是本轮独立审计的公开原创仓库之一。以下只陈述当前 checkout 能支持的事实，并把文档愿景、生成清单和实际运行结果分开。

证据标签：[当前代码事实]、[README 声明]、[历史快照]、[外部源码]、[未验证]；其中 [外部源码] 仅用于明确对比对象或第三方边界，本仓库仍保持原创项目定位。

## 1. Git 身份与快照

| 字段          | 事实                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| 本地路径      | [当前代码事实] `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.codex-tmp/interview-repo-audit/AsteriaAnalyst` |
| 远程          | [当前代码事实] `origin = https://github.com/wzn1118/AsteriaAnalyst.git`                                               |
| 分支          | [当前代码事实] `main`                                                                                                 |
| HEAD          | [当前代码事实] `b9b817053d6b40b6a4222efcd472cffe1345e5ea`                                                             |
| HEAD 时间     | [当前代码事实] `2026-07-28T23:22:43+08:00`                                                                            |
| 作者/主题     | [当前代码事实] `wzn1118` / `fix(ci): update resolved production dependencies`                                         |
| checkout 状态 | [当前代码事实] clean                                                                                                  |
| 历史可见性    | [当前代码事实] shallow clone；本地只可见 1 个提交；0 个本地 tag                                                       |
| 解释边界      | [未验证] 本地 1 个提交和 0 个 tag 不代表远程完整历史与 release 数量。                                                 |

## 2. 产品与架构主张

- [README 声明] Asteria Analyst 是“local-first enterprise analysis, statistics, and management-report workbench”，面向数据导入、统计分析、Agent 协作、审阅与正式报告发布。
- [README 声明] 当前推荐路径是源码启动；便携版仍处于开发过程，仓库中的历史 release 资产不等于当前主路径。
- [当前代码事实] 前端是 Next.js App Router，后端是 FastAPI；后端同时负责 API 和导出后的前端静态文件。
- [当前代码事实] 默认源码启动将后端绑定 `127.0.0.1:8000`、前端绑定 `127.0.0.1:3000`；便携启动默认端口是 `8787`。
- [当前代码事实] `start-asteria.ps1` 会检查 Python、Node、依赖、端口和健康状态；生产构建不可用时可进入开发启动路径；端口冲突时会选择相邻空闲端口。
- [README 声明] 目标流水线是：原始数据 → profile → 语义映射 → 业务上下文路由 → 指标规划 → 确定性计算 → 证据校验 → 报告绑定 → PDF 发布闸门。
- [当前代码事实] `AGENTS.md` 和服务模块明确把 AI 语义推断与确定性数值执行分开；运行产物保留 trace/schema/evidence 信息。
- [README 声明] 正式报告质量分低于 90 时不进入正式发布，只能作为调试输出。
- [未验证] 本轮没有用真实数据执行端到端流水线，因此没有把报告质量、耗时、统计正确率或 PDF 视觉质量作为已验证结果。

### 2.1 形式化处理链

| 阶段     | 组件/责任                     | 面试可讲事实                                                              |
| -------- | ----------------------------- | ------------------------------------------------------------------------- |
| 数据描述 | `DataProfileService`          | [当前代码事实] 先形成字段、类型、缺失、分布等 profile，再进入语义层。     |
| 字段语义 | `AIFieldSemanticMapper`       | [当前代码事实] AI 用于字段含义与角色映射。                                |
| 业务路由 | `AIBusinessContextRouter`     | [当前代码事实] 根据上下文选择业务分析方向。                               |
| 指标规划 | `AIMetricDerivationPlanner`   | [当前代码事实] 生成可审计的指标派生计划。                                 |
| 数值执行 | `DeterministicMetricExecutor` | [当前代码事实] 数值计算交给确定性代码，不直接接受语言模型生成的最终数字。 |
| 证据验证 | `EvidenceValidator`           | [当前代码事实] 校验指标与证据绑定。                                       |
| 报告绑定 | `ReportBindingLayer`          | [当前代码事实] 将分析结果绑定到报告结构。                                 |
| 发布闸门 | `FormalPDFReleaseGate`        | [当前代码事实] 正式 PDF 前有质量/完整性门槛。                             |

## 3. 规模与静态计数

| 指标           | 本轮静态结果                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| tracked 文件   | [当前代码事实] 345                                                                                           |
| Python 文件    | [当前代码事实] 222 个，合计约 211,284 行；包含业务代码、测试、目录数据与生成内容，不宜等同于手写核心代码量。 |
| 前端代码       | [当前代码事实] 35 个 TS/TSX/JS/CJS/MJS 文件，合计约 22,066 行。                                              |
| 后端测试文件   | [当前代码事实] 70 个 `test_*.py`。                                                                           |
| 测试函数/方法  | [当前代码事实] 静态发现约 551 个 `test_` 定义。                                                              |
| 前端测试       | [当前代码事实] 当前 tracked 文件中未发现常见前端测试文件命名。                                               |
| 服务文件       | [当前代码事实] `backend/app/services` 约 130 个 tracked 文件。                                               |
| Pydantic 模型  | [当前代码事实] 静态发现 25 个 `BaseModel` 类。                                                               |
| FastAPI 装饰器 | [当前代码事实] 静态发现 94 个 GET/POST/DELETE 路由装饰器；另有 HEAD、启动/关闭事件和页面别名。               |
| Next 页面      | [当前代码事实] 6 个：`/`、`/analysis`、`/lab`、`/lab/method-guide`、`/revision`、`/revision/workspace`。     |
| 文档           | [当前代码事实] `docs` 下约 28 个 Markdown 文件。                                                             |
| 根脚本         | [当前代码事实] `scripts` 下约 16 个 tracked 脚本。                                                           |

### 3.1 方法目录数字

- [历史快照] README 和生成文档给出 362 个注册统计方法，其中 81 个 runnable、281 个 catalog。
- [历史快照] Lab 方法卡生成清单给出 4,028 项，其中 273 runnable、1,023 catalog、2,732 planned。
- [当前代码事实] `scripts/export_method_catalog_docs.py` 生成统计方法与 Lab 方法清单；`statistical_catalog.py` 从注册数据动态汇总。
- [未验证] 这些数字描述当前目录/生成文档快照，不等于 4,028 项都能在真实数据上执行，也不等于 81/273 项已在本轮逐个通过测试。

## 4. 技术栈与依赖

### 4.1 前端

- [当前代码事实] `frontend/package.json`：包名 `frontend`、版本 `0.1.0`、`private: true`、Node `>=20.9.0`。
- [当前代码事实] 核心运行依赖：Next `16.2.12`、React/React DOM `19.2.4`、ECharts `6.1.0`、`echarts-for-react` `3.0.6`、Monaco React `4.7.0`、Framer Motion `12.38.0`、Lucide React `1.8.0`、PDF.js `5.7.284`、`clsx` `2.1.1`。
- [当前代码事实] 开发依赖：TypeScript 5、Tailwind CSS 4、ESLint 9、`eslint-config-next` `16.2.12`、`cross-env` `10.1.0`。
- [当前代码事实] overrides 固定 `dompurify 3.4.12`、`sharp 0.35.3` 和 Next 使用的 `postcss 8.5.24`。
- [当前代码事实] `package-lock.json` 为 lockfile v3，静态盘点约 468 个 package 条目。

### 4.2 后端

| 类别    | 固定依赖                                                                                   |
| ------- | ------------------------------------------------------------------------------------------ |
| Web     | [当前代码事实] `fastapi==0.135.3`、`uvicorn[standard]==0.44.0`、`python-multipart==0.0.26` |
| HTTP    | [当前代码事实] `httpx2==2.7.0`、`requests==2.33.1`                                         |
| 数据    | [当前代码事实] `pandas==3.0.2`、`openpyxl==3.1.5`、`duckdb==1.5.1`                         |
| 统计/ML | [当前代码事实] `statsmodels==0.14.6`、`scikit-learn==1.8.0`                                |
| 图形    | [当前代码事实] `seaborn==0.13.2`、`matplotlib==3.10.8`                                     |
| 文档    | [当前代码事实] `python-docx==1.1.2`、`pypdf==5.4.0`、`reportlab==4.4.1`                    |
| 测试    | [当前代码事实] `pytest==9.0.3`，开发 requirements 先引用生产 requirements。                |

### 4.3 可复述命令

```text
# Windows 源码入口
.\start-asteria.ps1
.\start-asteria.bat

# 前端
npm run dev
npm run dev:turbo
npm run build
npm run build:export
npm run start
npm run lint
npm run render:method-guide-preview
npm run verify:method-guide

# 后端 CI 口径
python -m pip install -r backend/requirements-dev.txt
python -m pytest

# 便携构建
.\scripts\build_portable.ps1
```

- [当前代码事实] 前端 dev/start 显式绑定 `127.0.0.1` 并关闭 Next telemetry。
- [当前代码事实] `build:export` 通过 `BUILD_MODE=export` 生成供 FastAPI/便携包托管的静态前端。
- [未验证] 本轮只审计命令与配置，没有安装依赖或执行整套测试、build、portable smoke。

## 5. API 事实目录

下表按功能域压缩列出当前 `backend/app/main.py` 中的 API。路径是代码事实；业务效果仍需运行验证。

### 5.1 系统、生态和插件

| Method | Path                                 | 用途                                          |
| ------ | ------------------------------------ | --------------------------------------------- |
| GET    | `/health`                            | [当前代码事实] 健康检查。                     |
| GET    | `/api/manifest`                      | [当前代码事实] 返回应用/API/上传能力清单。    |
| GET    | `/api/ecosystem/market`              | [当前代码事实] 生态市场信息。                 |
| GET    | `/api/skills/mounted`                | [当前代码事实] 已挂载技能。                   |
| GET    | `/api/lab/skills`                    | [当前代码事实] Lab 技能列表。                 |
| POST   | `/api/lab/skills/install`            | [当前代码事实] 安装技能；受运行开关约束。     |
| POST   | `/api/lab/skills/import-local`       | [当前代码事实] 导入本地技能；受运行开关约束。 |
| POST   | `/api/lab/skills/{skill_id}/mount`   | [当前代码事实] 挂载技能。                     |
| POST   | `/api/lab/skills/{skill_id}/unmount` | [当前代码事实] 卸载技能。                     |
| DELETE | `/api/lab/skills/{skill_id}`         | [当前代码事实] 删除技能记录。                 |

### 5.2 Lab、统计和分析

| Method | Path                                            |
| ------ | ----------------------------------------------- |
| GET    | `/api/lab/feature-trials/catalog`               |
| POST   | `/api/lab/feature-trials/run`                   |
| GET    | `/api/lab/report-agent-teams`                   |
| POST   | `/api/lab/report-agent-teams/import-local`      |
| POST   | `/api/lab/report-agent-teams/{team_id}/mount`   |
| POST   | `/api/lab/report-agent-teams/{team_id}/unmount` |
| DELETE | `/api/lab/report-agent-teams/{team_id}`         |
| POST   | `/api/lab/report-agent-teams/run`               |
| GET    | `/api/statistics/catalog`                       |
| POST   | `/api/statistics/run`                           |
| GET    | `/api/analysis/auto/methods`                    |
| POST   | `/api/analysis/auto`                            |
| GET    | `/api/lab/methods`                              |
| POST   | `/api/lab/method-cards`                         |
| GET    | `/api/lab/pdca/status`                          |
| POST   | `/api/lab/pdca/run`                             |
| POST   | `/api/lab/run`                                  |

以上 17 条均为 [当前代码事实]。`catalog`、`methods` 与 `cards` 是目录/说明接口；`run` 类接口才触发执行，二者不应混为“都可运行”。

### 5.3 数据集与上下文资产

| Method | Path                                     |
| ------ | ---------------------------------------- |
| GET    | `/api/datasets`                          |
| GET    | `/api/datasets/{dataset_id}`             |
| GET    | `/api/datasets/{dataset_id}/workflow`    |
| POST   | `/api/datasets/upload`                   |
| POST   | `/api/datasets/{dataset_id}/sheet`       |
| GET    | `/api/historical-reports`                |
| GET    | `/api/historical-reports/{template_id}`  |
| POST   | `/api/historical-reports/upload`         |
| GET    | `/api/business-backgrounds`              |
| GET    | `/api/business-backgrounds/{context_id}` |
| POST   | `/api/business-backgrounds/upload`       |

- [当前代码事实] 数据集扩展名：`.xlsx`、`.csv`、`.tsv`、`.dta`。
- [当前代码事实] 历史报告扩展名：`.txt`、`.md`、`.html`、`.pdf`、`.docx`。
- [当前代码事实] 业务背景在历史报告类型之外还接受 `.xlsx`、`.csv`、`.tsv`。
- [当前代码事实] manifest 声明可执行语言为 `python`、`sql`、`r`。
- [当前代码事实] 已检查的上传路径使用 `await upload_file.read()` 后一次性落盘，未观察到显式请求体/文件大小上限。
- [当前代码事实] 一次性读入和缺少明确大小门槛会放大内存占用与本地磁盘风险；loopback 假设是重要前提。

### 5.4 智能报告与 Agent 会话

| Method | Path                                                                  |
| ------ | --------------------------------------------------------------------- |
| POST   | `/api/datasets/{dataset_id}/smart-report`                             |
| POST   | `/api/datasets/{dataset_id}/smart-report-jobs`                        |
| GET    | `/api/report-jobs/{job_id}`                                           |
| GET    | `/api/reports`                                                        |
| GET    | `/api/reports/{report_id}`                                            |
| POST   | `/api/reports/{report_id}/agent-sessions`                             |
| GET    | `/api/reports/{report_id}/agent-sessions/{session_id}`                |
| POST   | `/api/report-agent-sessions/{session_id}/messages`                    |
| GET    | `/api/report-agent-sessions/{session_id}/events`                      |
| GET    | `/api/report-agent-sessions/{session_id}/events/stream`               |
| POST   | `/api/report-agent-sessions/{session_id}/cancel`                      |
| GET    | `/api/report-agent-sessions/{session_id}/files`                       |
| GET    | `/api/report-agent-sessions/{session_id}/diff`                        |
| GET    | `/api/report-agent-sessions/{session_id}/attachments`                 |
| POST   | `/api/report-agent-sessions/{session_id}/attachments`                 |
| DELETE | `/api/report-agent-sessions/{session_id}/attachments/{attachment_id}` |
| GET    | `/api/report-agent-sessions/{session_id}/annotations`                 |
| POST   | `/api/report-agent-sessions/{session_id}/annotations`                 |
| DELETE | `/api/report-agent-sessions/{session_id}/annotations/{annotation_id}` |
| POST   | `/api/report-agent-sessions/{session_id}/publish`                     |

以上均为 [当前代码事实]。会话事件同时有普通 GET 和 SSE stream；文件、diff、附件、批注、发布形成较完整的人工审阅表面。

### 5.5 Runtime、Codex 和学习账本

| Method | Path                                                       |
| ------ | ---------------------------------------------------------- |
| GET    | `/api/runtime-settings`                                    |
| GET    | `/api/runtime/codex-health`                                |
| GET    | `/api/runtime/processes`                                   |
| POST   | `/api/runtime/processes/{kind}/{process_id}/cancel`        |
| POST   | `/api/runtime/processes/{kind}/{process_id}/resume`        |
| POST   | `/api/reports/{report_id}/r-intelligence-flow`             |
| POST   | `/api/codex-runs`                                          |
| POST   | `/api/codex-run-jobs`                                      |
| GET    | `/api/codex-run-jobs/{job_id}`                             |
| GET    | `/api/codex-runs/{run_id}`                                 |
| GET    | `/api/codex-runs/{run_id}/log`                             |
| POST   | `/api/codex-runs/{run_id}/cancel`                          |
| POST   | `/api/codex-run-jobs/{job_id}/cancel`                      |
| GET    | `/api/runtime-learning-ledger`                             |
| GET    | `/api/runtime-learning-ledger/{entry_id}`                  |
| POST   | `/api/codex-pipeline-jobs`                                 |
| GET    | `/api/codex-pipeline-jobs/{job_id}`                        |
| POST   | `/api/codex-pipeline-jobs/{job_id}/cancel`                 |
| POST   | `/api/codex-pipeline-jobs/{job_id}/retry-stage`            |
| POST   | `/api/codex-pipeline-jobs/{job_id}/register-report-output` |

- [当前代码事实] Codex runtime API、local skill installer、unsandboxed runtime 分别受环境变量开关控制。
- [当前代码事实] 默认配置中 unsandboxed runtime 未开启；其余开关的默认/启动行为应结合 `.env` 和启动脚本看，仅看单个路由证据不足。
- [当前代码事实] runtime settings 返回值对敏感字段做掩码处理。

## 6. 数据模型与持久化

- [当前代码事实] 静态发现 25 个 Pydantic `BaseModel` 类，覆盖安装、导入、执行、会话消息、附件、批注、Codex job/pipeline 等请求体。
- [当前代码事实] `PathService` 支持 `ASTERIA_DATA_DIR` 覆盖；源码模式默认 `workspace/storage`，冻结/便携模式默认 `%APPDATA%/AsteriaAnalyst`。
- [当前代码事实] 主要持久化位置包括 `datasets`、`runs`、`public_artifacts/reports`、`historical_reports`、`business_backgrounds`、`settings.json` 与 Codex runtime 目录。
- [当前代码事实] FastAPI 只把 `PUBLIC_ARTIFACTS_DIR` 挂载为 `/storage`；数据集与内部运行数据未整体静态公开。
- [当前代码事实] 报告会话模型暴露 events、files、diff、attachments、annotations 和 publish 操作，说明状态机不仅有“生成完成”一个状态。
- [未验证] 当前静态审计未建立数据库 schema 迁移表；该仓库主要通过目录和 JSON/文件资产组织本地状态，具体并发一致性要通过服务级测试确认。

## 7. 安全与信任边界

### 7.1 已观察到的边界

- [当前代码事实] 默认监听 loopback；前端、后端与可移植 smoke 都使用 `127.0.0.1`。
- [当前代码事实] 代码没有应用级用户登录/鉴权层，设计假定本机单一受信用户。
- [当前代码事实] CORS 允许本地 origin 和本地正则 origin，`allow_credentials=true`；跨域策略与 loopback 部署共同构成边界。
- [当前代码事实] 启用 GZip，最小压缩大小为 2048 bytes。
- [当前代码事实] 只有 public artifacts 被静态挂载；内部 dataset/runtime 目录未直接映射为静态 Web 目录。
- [当前代码事实] `.env.example` 提供 `OPENAI_API_KEY`、base URL、model、reasoning、CORS、Codex gates、超时与登录授权模式等设置。
- [当前代码事实] API key 通过环境或本地配置进入进程；runtime settings 的返回进行掩码。

### 7.2 风险与面试主动说明

- [当前代码事实] 无登录层意味着把服务改绑公网地址会改变整个安全模型；当前实现适合 loopback，不应直接按多租户 Web 服务描述。
- [当前代码事实] 数据/背景/报告上传会整文件读入内存，未见显式大小上限；异常大文件可造成资源压力。
- [当前代码事实] 技能安装、本地导入、Codex 执行和 unsandboxed 模式都扩大代码执行面，因此环境开关与默认关闭策略需要保留。
- [当前代码事实] 仓库中未发现 `LICENSE` 文件。
- [README 声明] 安全文档也说明在发布 LICENSE 前没有对外授予明确许可证权利。
- [未验证] 没有做依赖漏洞联网扫描、动态渗透、恶意文件上传或并发压力测试。

## 8. CI、发布与部署

- [当前代码事实] 唯一 workflow 是 `.github/workflows/ci.yml`；触发条件为 pull request、`main` push、`v*` tag。
- [当前代码事实] backend job：Ubuntu、Python 3.13、安装 `requirements-dev.txt`、执行 `python -m pytest`。
- [当前代码事实] frontend job：Ubuntu、Node 22、`npm ci`、lint、方法指南验证、build、`npm audit --omit=dev --audit-level=high`。
- [当前代码事实] portable-smoke job：Windows latest，等待前后端 job；创建 Python venv、安装固定依赖、`npm ci`、运行 `scripts/build_portable.ps1`。
- [当前代码事实] smoke 检查 ZIP 必含启动脚本、双语用户指南、后端 desktop 入口和嵌入 Python；在 `18787` 启动后检查 `/health` 与五个页面路由。
- [当前代码事实] 验证后的 ZIP 作为 GitHub artifact 保存 14 天。
- [当前代码事实] `v*` tag 的 release job 只下载已经通过 smoke 的 artifact，再用 `gh release create` 发布并自动生成 notes。
- [未验证] 本地 shallow checkout 没有 tags，因此本轮没有确认远程已有多少 release，也没有确认最近 workflow 的在线结论。

## 9. 测试事实与质量证据

- [当前代码事实] 70 个后端测试文件与约 551 个测试定义说明测试面较广。
- [当前代码事实] CI 强制 backend pytest、frontend lint/build、方法指南一致性、生产依赖 high-severity audit 和 Windows portable smoke。
- [当前代码事实] portable smoke 既验证产物结构，也验证真实启动和页面响应，不只是检查 ZIP 存在。
- [当前代码事实] 当前 tracked 文件中未发现常见前端 unit/e2e 测试文件，前端质量门主要是 lint、构建、目录验证和页面 smoke。
- [未验证] 本轮没有执行测试，因此不得把“配置了 CI”表述为“当前 HEAD 在本机全部通过”。

## 10. 文档声明与代码验证对照

| 主题       | 声明                                        | 当前证据结论                                                                      |
| ---------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| 本地优先   | [README 声明] 本地工作台                    | [当前代码事实] 默认绑定 loopback，状态写本地目录；与声明一致。                    |
| 数值可信   | [README 声明] AI 规划、确定性计算、证据闸门 | [当前代码事实] 对应服务和发布层存在；[未验证] 未用基准数据测正确率。              |
| 方法规模   | [README 声明] 362 统计方法、4,028 Lab 卡    | [历史快照] 生成文档与汇总脚本支持目录数字；[未验证] 不代表逐项可运行。            |
| 便携版     | [README 声明] 当前仍开发                    | [当前代码事实] CI 已能构建并 smoke；这说明工程链存在，不等于公开版稳定性。        |
| 正式质量门 | [README 声明] 分数低于 90 不发布            | [当前代码事实] 发布链组件存在；[未验证] 本轮未触发阈值场景。                      |
| 安全边界   | [README 声明] local-first                   | [当前代码事实] loopback/CORS/gates 支持；无登录和无上传大小限制要求保持本机边界。 |

## 11. 面试追问与准确答法

### Q1：为什么数值计算不直接交给大模型？

[当前代码事实] 项目把语义理解/方法规划和指标计算拆开。模型输出意图和可审计计划，确定性执行器在明确数据上计算，EvidenceValidator 再检查结果与证据绑定。这样能定位错误来源，也更适合回归测试和正式报告审计。

### Q2：为什么既有 catalog 又有 runnable？

[当前代码事实] catalog 是方法知识与适用性目录，runnable 才表示已接入执行器。把 planned/catalog/runnable 分层，避免用“有方法说明”冒充“已实现执行”。

### Q3：现在最大的部署风险是什么？

[当前代码事实] 安全模型依赖 loopback 和单用户信任。无登录层、可上传大文件、可开启技能安装/Codex/unsandboxed 执行，意味着任何公网化都需要重新设计鉴权、配额、隔离、审计与文件限制。

### Q4：CI 最有价值的设计是什么？

[当前代码事实] release 依赖 Windows portable-smoke；发布物来自同一个已经启动并通过健康与页面探测的 artifact，而不是 release job 再独立重建。这降低“测试的不是最终 ZIP”的偏差。

### Q5：哪里仍缺证据？

[未验证] 本轮没有完整远程历史、在线 CI 结果、性能基准、恶意输入测试、全部方法的执行矩阵和真实报告人工评分；应把这些列为后续验证项，而不是补成结论。

## 12. 一句话边界

> [当前代码事实] AsteriaAnalyst 已形成 Next.js + FastAPI 的本地分析工作台、较完整 API/Agent/报告状态面和可验证便携发布链；[README 声明] 它追求可审计的企业报告；[未验证] 当前快照还不足以证明全部目录方法、性能与正式报告质量指标在所有数据上成立。
