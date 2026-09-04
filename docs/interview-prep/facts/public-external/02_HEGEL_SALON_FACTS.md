# hegel-salon 事实档案

> 面试定位：这是本轮独立审计的公开原创仓库之一。可以围绕“哲学语料、可核验引文、推理质量、用户隔离与本地 Agent”讲系统设计，同时明确它是原型工作台，不是学术权威本身。

证据标签：[当前代码事实]、[README 声明]、[历史快照]、[外部源码]、[未验证]；其中 [外部源码] 用于第三方语料/依赖边界，[历史快照] 用于 Git 与生成清单时间点。

## 1. Git 身份与快照

| 字段          | 事实                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 本地路径      | [当前代码事实] `C:/Users/10847/Documents/xiaohongshu-relay-scraper-ui/.codex-tmp/interview-repo-audit/hegel-salon` |
| 远程          | [当前代码事实] `origin = https://github.com/wzn1118/hegel-salon.git`                                               |
| 分支          | [当前代码事实] `main`                                                                                              |
| HEAD          | [当前代码事实] `36f1cd36f9a04abe19f4bab2c21b2c427d3c9f35`                                                          |
| HEAD 时间     | [当前代码事实] `2026-05-26T04:36:02+08:00`                                                                         |
| 作者/主题     | [当前代码事实] `Hegel Salon Release` / `Add bilingual GitHub README`                                               |
| checkout 状态 | [当前代码事实] clean                                                                                               |
| 历史可见性    | [当前代码事实] shallow clone；本地只可见 1 个提交；0 个本地 tag                                                    |
| 解释边界      | [未验证] 本地历史、tag 和 release 不是远程完整统计。                                                               |

## 2. 产品边界与核心流程

- [README 声明] hegel-salon 是中文优先的 Hegel 阅读、检索、对话和推理工作台，组合本地语料、引文纪律、概念关系、历史解释、附件、浏览器 Computer Use、多用户和管理能力。
- [README 声明] 项目是研究原型，不是 Hegel 文本、翻译或学术解释的最终权威；质量分是工程信号，不是哲学真理证明。
- [当前代码事实] 主入口是 `src/server.mjs`，使用 Node 原生 HTTP/HTTPS server；默认端口 `3087`。
- [当前代码事实] 对话请求经过 prompt 组装、本地语料检索、直接引文校验、历史材料、质量 judge、形式逻辑 judge、史学 judge 和 revision loop。
- [当前代码事实] `validateReplyQuotes` 从双引号、中文引号和带语言标签的行中抽取候选引文，规范化大小写、空白和引号，再要求候选是当前证据文本的连续子串。
- [当前代码事实] 未在证据中精确出现的直接引文会被记录为 invalid；`stripInvalidDirectQuotes` 去掉其引号标记，降低把未核对文本包装成直接引用的概率。
- [未验证] 子串校验证明的是“回复片段存在于本轮检索证据”，不证明版本权威性、翻译忠实度、上下文充分性或论证正确性。

### 2.1 请求路径

```text
浏览器 UI
  -> POST /api/chat
  -> 用户/风格/会话上下文
  -> 本地 corpus 与概念图检索
  -> 模型生成
  -> direct-quote validator
  -> quality / strict-logic / historiography judges
  -> 必要时 revision loop
  -> 保存会话、记忆、用量与审计数据
```

## 3. 仓库规模

| 指标                  | 本轮静态结果                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| tracked 文件          | [当前代码事实] 543                                                                                            |
| 文本语料              | [当前代码事实] 350 个 `.txt`；其中 `data/corpus/texts` 172 个、`data/corpus/chinese/generated-texts` 161 个。 |
| JavaScript 模块       | [当前代码事实] 40 个 `.mjs`，合计约 24,772 行。                                                               |
| 源码文件              | [当前代码事实] `src` 下约 38 个 tracked 文件。                                                                |
| 图片                  | [当前代码事实] 30 个 PNG。                                                                                    |
| Android               | [当前代码事实] 约 72 个 tracked Android 工程文件，含 5 个 Java 文件及 Gradle 配置。                           |
| PDF                   | [当前代码事实] 4 个 PDF。                                                                                     |
| 概念账本              | [当前代码事实] 10 个 concept、5 个 term profile、1 个 work-edition precedence 配置。                          |
| 评测样本              | [当前代码事实] evaluation JSONL 静态计数 130 行。                                                             |
| 测试/评测候选         | [当前代码事实] 约 12 个以 test/eval/smoke/stress 命名的文件；其中许多是评估脚本而非单元测试。                 |
| 常规 Node test script | [当前代码事实] `package.json` 中没有 `test` script。                                                          |
| CI                    | [当前代码事实] 仓库没有 `.github/workflows`。                                                                 |

## 4. Manifest、依赖和脚本

- [当前代码事实] 包名 `hegel-salon`、版本 `0.1.0`、`private: true`、ES module。
- [当前代码事实] 运行依赖：`openai ^6.5.0`、`nodemailer ^8.0.7`、`@capacitor/core ^8.3.1`。
- [当前代码事实] Android/构建依赖：`@capacitor/android ^8.3.1`、`@capacitor/cli ^8.3.1`。
- [当前代码事实] override 固定 `@xmldom/xmldom ^0.8.13`。
- [当前代码事实] lockfile v3，静态盘点约 95 个 package 条目。
- [当前代码事实] Docker 基础镜像为 Node 22 bookworm slim。

| Script                     | 命令                                      | 事实用途                                |
| -------------------------- | ----------------------------------------- | --------------------------------------- |
| `dev`                      | `node src/server.mjs`                     | [当前代码事实] 启动主服务。             |
| `start`                    | `node src/server.mjs`                     | [当前代码事实] 与 dev 同入口。          |
| `eval:understanding`       | `node src/runUnderstandingEvaluation.mjs` | [当前代码事实] 理解能力评估。           |
| `eval:understanding:smoke` | `... --limit=12`                          | [当前代码事实] 12 条 smoke 子集。       |
| `eval:understanding:full`  | 同 full 入口                              | [当前代码事实] 全量理解评估。           |
| `eval:formal-stress`       | `node src/runFormalLogicStress.mjs`       | [当前代码事实] 形式逻辑压力测试。       |
| `eval:historical-stress`   | `node src/runHistoriographyStress.mjs`    | [当前代码事实] 史学维度压力测试。       |
| `smoke:concept-graph`      | `node src/runConceptGraphSmoke.mjs`       | [当前代码事实] 概念图 smoke。           |
| `validate:hegel-graph`     | `node src/validateHegelConceptGraph.mjs`  | [当前代码事实] 图结构校验。             |
| `optimize:90`              | `node src/runQualityOptimizer.mjs`        | [当前代码事实] 面向目标分的迭代优化器。 |

- [当前代码事实] `scripts/run_quote_precision_tests.mjs` 生成 20 个主题 × 10 个模板的候选集，默认取 100，单请求超时 120 秒，最多 3 次 HTTP 尝试。
- [当前代码事实] 该脚本引用 `reportDir`，但在当前文件内没有定义；这是会阻塞运行的静态缺陷。
- [未验证] 本轮没有执行评估与训练命令，也没有将 README 中的质量分或覆盖率当作当前结果。

## 5. API 注册表

[当前代码事实] `src/toolRegistry.mjs` 将 37 条业务工具路由声明为结构化注册表，每条包含输入/输出 schema、风险级别、只读、破坏性、并发安全、认证和管理员要求。另有 8 条认证路由由 server 直接分发，合计 45 条 API 路由条件。

### 5.1 普通工具路由（25 条）

| Name                         | Method / Path                                     | Risk   | 关键元数据                                           |
| ---------------------------- | ------------------------------------------------- | ------ | ---------------------------------------------------- |
| `tools.catalog`              | `GET /api/tools`                                  | low    | read-only；返回调用者可见工具。                      |
| `chat.ask`                   | `POST /api/chat`                                  | medium | JSON 或 multipart；返回回复及三个 judge/validation。 |
| `chat.sessions.list`         | `GET /api/chat/sessions`                          | low    | read-only。                                          |
| `chat.sessions.create`       | `POST /api/chat/sessions`                         | medium | 创建会话。                                           |
| `sources.read`               | `GET /api/sources`                                | low    | read-only。                                          |
| `history.read`               | `GET /api/history`                                | low    | read-only。                                          |
| `styles.list`                | `GET /api/styles`                                 | low    | read-only。                                          |
| `styles.create`              | `POST /api/styles`                                | medium | 新建风格。                                           |
| `styles.update`              | `POST /api/styles/{styleProfileId}`               | medium | 更新风格。                                           |
| `config.read`                | `GET /api/config`                                 | low    | read-only；返回项目与有效配置。                      |
| `config.save`                | `POST /api/config`                                | high   | 保存 provider/model/baseURL/API key。                |
| `training.status`            | `GET /api/training/status`                        | low    | read-only。                                          |
| `training.prompt.save`       | `POST /api/training/prompt`                       | medium | 保存 judge prompt。                                  |
| `training.start`             | `POST /api/training/start`                        | high   | 非并发安全；启动外部进程。                           |
| `computer.state`             | `GET /api/computer/state`                         | medium | read-only。                                          |
| `computer.reset`             | `POST /api/computer/reset`                        | high   | destructive、非并发安全。                            |
| `computer.task`              | `POST /api/computer/task`                         | high   | 非并发安全。                                         |
| `local_agent.devices.list`   | `GET /api/local-agent/devices`                    | low    | read-only。                                          |
| `local_agent.devices.create` | `POST /api/local-agent/devices`                   | high   | 返回一次性设备 token 与运行命令。                    |
| `local_agent.devices.revoke` | `POST /api/local-agent/devices/{deviceId}/revoke` | high   | destructive。                                        |
| `local_agent.tasks.list`     | `GET /api/local-agent/tasks`                      | medium | read-only。                                          |
| `local_agent.tasks.create`   | `POST /api/local-agent/tasks`                     | high   | 创建本地设备任务。                                   |
| `local_agent.tasks.next`     | `GET /api/local-agent/tasks/next`                 | high   | Bearer device token；会 claim task，故标记非只读。   |
| `local_agent.tasks.status`   | `GET /api/local-agent/tasks/{taskId}`             | medium | read-only。                                          |
| `local_agent.tasks.finish`   | `POST /api/local-agent/tasks/{taskId}/result`     | high   | 非并发安全；提交完成/失败结果。                      |

### 5.2 管理员工具路由（12 条）

| Name                         | Method / Path                                    | Risk     | 关键元数据                        |
| ---------------------------- | ------------------------------------------------ | -------- | --------------------------------- |
| `admin.overview`             | `GET /api/admin/overview`                        | medium   | 管理员、read-only。               |
| `admin.analytics`            | `GET /api/admin/analytics`                       | medium   | 管理员、read-only。               |
| `admin.users.list`           | `GET /api/admin/users`                           | medium   | 管理员、read-only。               |
| `admin.database.health`      | `GET /api/admin/database/health`                 | medium   | integrity、counts、pragmas。      |
| `admin.database.backup`      | `POST /api/admin/database/backup`                | high     | 非并发安全。                      |
| `admin.mail.config.read`     | `GET /api/admin/mail-config`                     | medium   | 管理员、read-only。               |
| `admin.mail.config.save`     | `POST /api/admin/mail-config`                    | high     | 非并发安全。                      |
| `admin.mail.test`            | `POST /api/admin/mail-test`                      | high     | 非并发安全；发送测试邮件。        |
| `admin.user.data.read`       | `GET /api/admin/users/{userId}/data`             | high     | read-only，但能读取用户业务数据。 |
| `admin.user.disable`         | `POST /api/admin/users/{userId}/set-disabled`    | critical | destructive、非并发安全。         |
| `admin.user.revoke_sessions` | `POST /api/admin/users/{userId}/revoke-sessions` | high     | destructive、非并发安全。         |
| `admin.user.clear_data`      | `POST /api/admin/users/{userId}/clear-data`      | critical | destructive、非并发安全。         |

### 5.3 认证路由（8 条）

| Method | Path                           | 事实用途                              |
| ------ | ------------------------------ | ------------------------------------- |
| GET    | `/api/auth/session`            | [当前代码事实] 读取会话与 CSRF 状态。 |
| POST   | `/api/auth/register/send-code` | [当前代码事实] 发送注册验证码。       |
| POST   | `/api/auth/register/complete`  | [当前代码事实] 完成注册。             |
| POST   | `/api/auth/password/send-code` | [当前代码事实] 发送密码重置码。       |
| POST   | `/api/auth/password/reset`     | [当前代码事实] 重置密码。             |
| POST   | `/api/auth/login`              | [当前代码事实] 登录。                 |
| POST   | `/api/auth/admin/verify-2fa`   | [当前代码事实] 管理员第二步验证。     |
| POST   | `/api/auth/logout`             | [当前代码事实] 注销当前会话。         |

## 6. SQLite 数据模型

[当前代码事实] 使用 Node `node:sqlite` 的 `DatabaseSync`。初始化设置：WAL、`synchronous=FULL`、`busy_timeout=10000`、`wal_autocheckpoint=1000`、`temp_store=MEMORY`、foreign keys on。

| 表                      | 事实责任                                         |
| ----------------------- | ------------------------------------------------ |
| `users`                 | [当前代码事实] 用户身份、角色、密码相关状态。    |
| `sessions`              | [当前代码事实] 登录会话与过期时间。              |
| `email_codes`           | [当前代码事实] 注册、重置、2FA 等邮件验证码。    |
| `user_api_configs`      | [当前代码事实] 用户模型/API 配置；敏感字段加密。 |
| `style_profiles`        | [当前代码事实] 用户风格配置。                    |
| `user_memory_turns`     | [当前代码事实] 对话记忆 turn。                   |
| `user_chat_logs`        | [当前代码事实] 用户聊天日志。                    |
| `chat_sessions`         | [当前代码事实] 会话元数据。                      |
| `user_chat_messages`    | [当前代码事实] 会话消息与 ordinal。              |
| `style_memory_profiles` | [当前代码事实] 每种风格的记忆 profile。          |
| `user_memory_profiles`  | [当前代码事实] 用户长期/汇总记忆。               |
| `login_events`          | [当前代码事实] 登录事件。                        |
| `security_audit_events` | [当前代码事实] 安全审计事件。                    |
| `security_alerts`       | [当前代码事实] 安全告警。                        |
| `training_runs`         | [当前代码事实] 优化/训练运行记录。               |
| `local_agent_devices`   | [当前代码事实] 用户绑定的本地 Agent 设备。       |
| `local_agent_tasks`     | [当前代码事实] 设备任务、状态和结果。            |
| `user_usage_daily`      | [当前代码事实] 按日用量。                        |

- [当前代码事实] 数据库定义至少 18 张表及会话、验证码、聊天、审计、训练、设备、任务等索引。
- [当前代码事实] 管理接口可以执行 integrity check、读取 PRAGMA、统计记录并创建备份。
- [当前代码事实] JSON/文本文件写入工具采用临时文件、`fsync`、rename；读失败时可回退备份，损坏 JSON 会改名为 `.corrupt-*` 以保留证据。

## 7. 认证、密钥与 Web 安全

### 7.1 凭据与会话

- [当前代码事实] 密码最低 8 个字符；随机 16-byte salt；`scryptSync` 派生 64-byte hash。
- [当前代码事实] session token 随机 32 bytes、base64url；数据库只保存 SHA-256 token hash；比较使用 timing-safe 方法。
- [当前代码事实] session TTL 30 天；邮箱验证码、密码重置码和管理员二次验证码 TTL 10 分钟。
- [当前代码事实] session cookie 是 HttpOnly、SameSite Strict、Priority High；HTTPS 或强制开关下添加 Secure。
- [当前代码事实] CSRF cookie 刻意保持可由前端读取，用于 double-submit；修改型 API 需要 header/cookie 对应。
- [当前代码事实] 管理员二次验证默认启用，除非环境配置显式改变。

### 7.2 API key 加密

- [当前代码事实] 用户 API key 在 SQLite 中使用 AES-256-GCM 加密，每条记录使用随机 12-byte IV 并保存 auth tag。
- [当前代码事实] master key 优先来自 `HEGEL_API_CONFIG_MASTER_KEY`；本地开发没有配置时会生成本地 key file。
- [当前代码事实] 数据层包含从旧 plaintext 字段迁移到加密字段的路径。
- [当前代码事实] Local Agent token 同样只保存 hash，不以明文长期保存。

### 7.3 HTTP 边界

- [当前代码事实] CORS 使用 allowlist，并允许 `Content-Type`、`Authorization`、`X-CSRF-Token`。
- [当前代码事实] 安全 headers 包括 CSP、frame deny、`nosniff`、no-store；HTTPS 下增加 HSTS。
- [当前代码事实] 有 suspicious user-agent 拦截和进程内 rate limit。
- [当前代码事实] rate limit 保存在单进程内存；多实例之间不共享，重启后不保留。
- [当前代码事实] 支持直接 HTTPS key/cert，也支持 reverse proxy/canonical host 配置。

## 8. 上传、附件与用户隔离

- [当前代码事实] JSON body 默认上限 8 MB。
- [当前代码事实] multipart body 默认上限 48 MB。
- [当前代码事实] 单请求最多 6 个文件；单文件默认上限 40 MB；文件总量默认上限 48 MB。
- [当前代码事实] 接受扩展名：CSV、GIF、JPEG/JPG、JSON、Markdown、PDF、PNG、TSV、TXT、WebP、XLS、XLSX；另有 MIME allowlist。
- [当前代码事实] Windows 下会 best-effort 调用 Defender 扫描附件。
- [当前代码事实] 提取后默认删除上传原文件，除非 retention 环境配置要求保留。
- [README 声明] 公网部署仍需根据环境建立独立恶意文件扫描和保留策略，不宜把 best-effort 扫描当作完整网关。
- [当前代码事实] 每个用户的运行数据分布在 `data/users/<user-id>` 下，并隔离 uploads、logs、computer/browser 状态。
- [当前代码事实] 配置公开 base URL 时，host 侧 Computer Use 会转交 Local Agent，而不是在服务器桌面直接执行。
- [当前代码事实] browser worker 限定在浏览器/Edge 场景；它不是通用桌面控制边界。

## 9. 部署形态

### 9.1 Render

- [当前代码事实] `render.yaml` 使用 Docker、starter plan、自动部署、根路径 health check。
- [当前代码事实] 持久磁盘 1 GB，挂载 `/app/data`。
- [当前代码事实] 端口 3087；启用 auth、隐藏开发验证码、信任 proxy、强制 secure cookie。
- [当前代码事实] API config master key 由 Render 生成；public base URL、origin、管理员账户和 SMTP secrets 要在平台注入。

### 9.2 Docker Compose

- [当前代码事实] 暴露 `3087:3087`，挂载 `hegel-data` 和 `hegel-local-resources` 两个 volume。
- [当前代码事实] compose 默认 auth/hide-codes/trust-proxy 开启，但 `HEGEL_FORCE_SECURE_COOKIES=0`，并使用占位 master key。
- [当前代码事实] compose 文件更接近本地/模板配置；若用于真实共享环境，必须替换 master key 并结合 TLS 调整 cookie。

## 10. 语料、概念图与授权边界

- [当前代码事实] 仓库同时包含德文/英文等本地文本和 generated Chinese texts；中文生成文本与原始文本是不同目录。
- [当前代码事实] 概念账本记录 concept、term profile 和作品版本优先级，为检索/提示提供结构化线索。
- [README 声明] 系统强调“引用纪律”和多语言对读，而不是用生成结果替代原典。
- [当前代码事实] 主项目使用 Apache-2.0 LICENSE，并附 NOTICE。
- [当前代码事实] NOTICE 明确第三方语料、文本、翻译或材料仍保留各自上游条款；主代码许可证不自动覆盖全部语料再分发权利。
- [未验证] 本轮没有逐个核查 349 个文本文件的来源、版本、版权状态、OCR/翻译质量与完整性。

## 11. 质量门、缺口与风险

| 主题   | 已有证据                                                                                  | 仍需说明                                                                          |
| ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 引文   | [当前代码事实] 直接引文与检索证据做规范化子串匹配。                                       | [未验证] 尚不足以证明版本、译文和上下文权威。                                     |
| 评估   | [当前代码事实] understanding、formal、historiography、concept graph、optimizer 脚本存在。 | [未验证] 本轮没有复现分数；部分是模型 judge。                                     |
| 测试   | [当前代码事实] 有 smoke/stress/eval 和 Android 模板测试。                                 | [当前代码事实] 无常规 Node test script、无 CI；quote precision 脚本有未定义变量。 |
| 多用户 | [当前代码事实] auth、CSRF、用户目录、DB 表、管理员审计链存在。                            | [未验证] 未做水平越权、并发隔离和 session fixation 动态测试。                     |
| 上传   | [当前代码事实] 大小、数量、扩展名、MIME 和 Defender best-effort。                         | [未验证] 未做恶意文档解析、压缩炸弹和绕过测试。                                   |
| 限流   | [当前代码事实] 进程内限制存在。                                                           | [当前代码事实] 多实例不共享，生产扩容需外部限流。                                 |
| 部署   | [当前代码事实] Docker、Compose、Render 都有配置。                                         | [当前代码事实] 没有 CI/CD workflow；autoDeploy 不等于代码测试门。                 |

## 12. 面试追问与准确答法

### Q1：引文校验解决了什么问题？

[当前代码事实] 它防止模型把当前检索证据里不存在的长片段标成直接引文，并把验证结果结构化返回。它没有替代校勘学：来源版本、翻译、上下文和解释仍要由用户核查。

### Q2：为什么 API 需要 registry？

[当前代码事实] registry 不只做 URL dispatch，还把 schema、risk、readOnly、destructive、concurrencySafe、requiresAuth、requiresAdmin 变成机器可读元数据。`GET /api/tools` 可按调用者角色过滤工具，让 UI、Agent 和审计层共用同一能力清单。

### Q3：Local Agent 为什么单独设计？

[当前代码事实] 公网服务不应直接操作服务器宿主桌面。设备注册、token hash、task claim/result 和用户归属把执行移回用户设备，同时保留任务状态与撤销能力。

### Q4：SQLite 为什么选择 WAL + FULL？

[当前代码事实] WAL 改善读写并发，FULL synchronous 偏向持久性，10 秒 busy timeout 减少短时争用失败；代价是单机数据库和写入吞吐边界仍需接受。

### Q5：当前最明确的工程债是什么？

[当前代码事实] 没有 CI 和统一 test script；关键评测多是可选运行脚本，且 quote precision 脚本有静态缺陷。其次是进程内限流、第三方语料合规清单和上传安全还需要生产化。

## 13. 一句话边界

> [当前代码事实] hegel-salon 已实现本地语料检索、直接引文证据匹配、结构化工具注册、多用户 SQLite 安全层、附件限制和 Local Agent 边界；[README 声明] 它追求中文优先的 Hegel 推理工作台；[未验证] 当前快照不足以把模型评分、生成中文语料或原型部署包装成学术权威与生产级完整证明。
