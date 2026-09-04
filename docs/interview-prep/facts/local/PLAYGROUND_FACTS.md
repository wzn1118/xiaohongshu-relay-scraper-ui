# Playground 三个原型完整事实

> 父路径：`C:\Users\10847\Documents\Playground`
> 快照时间：2026-08-18
> 子项目：`feishu-openai-bot`、`secondary-brightness-widget`、`xhs_scraper`。

## 1. 父目录证据（F2）

- 父目录是 Git 根目录，分支名 `master`。
- `HEAD` 尚未创建，提交数 0，远端为空。
- 85 个 Git 状态项全部未跟踪。
- 父目录没有根文件，只有 `.git` 和三个子目录。
- 三个子目录都没有嵌套 `.git`，因此没有独立提交、tag、远端和作者演进证据。
- Git 可见项：`xhs_scraper` 68 项（其中 2 个带特殊字符路径在 Git 引号编码下被分组为额外顶层值）、`feishu-openai-bot` 11 项、`secondary-brightness-widget` 6 项。

## 2. 总览

| 子项目                        | Git 可见项 | 实际文件数 |  实际大小 | 技术                                         | 定位                       |
| ----------------------------- | ---------: | ---------: | --------: | -------------------------------------------- | -------------------------- |
| `feishu-openai-bot`           |         11 |      2,075 | 31.10 MiB | FastAPI、httpx、Responses API、SQLite        | 消息机器人骨架             |
| `secondary-brightness-widget` |          6 |          6 |  0.02 MiB | PowerShell、WinForms、Win32、DDC/CI          | Windows 外接屏亮度工具     |
| `xhs_scraper`                 |         68 |         68 | 10.88 MiB | Python、Playwright/CDP、OpenPyXL、PowerShell | Relay 采集与结构化导出原型 |

`feishu-openai-bot` 的实际文件数大主要因为 `.venv` 有 2,056 个文件、约 31.01 MiB；业务代码本身很小。`xhs_scraper` 的体积主要来自运行输出和两份 PDF，而不是源码。

---

# A. feishu-openai-bot

## 3. 路径、文件与运行（F1/F2）

### 3.1 路径

`C:\Users\10847\Documents\Playground\feishu-openai-bot`

Git 可见文件：

- `.env.example`
- `.gitignore`
- `README.md`
- `requirements.txt`
- `app/__init__.py`
- `app/config.py`
- `app/feishu.py`
- `app/main.py`
- `app/openai_client.py`
- `app/store.py`
- `tests/test_main.py`

### 3.2 运行命令（F3）

README 给出的本地启动：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

端点：

- `GET /`：返回 name/status/webhook。
- `GET /healthz`：健康检查。
- `POST /webhooks/feishu/events`：飞书事件订阅入口。
- README 的本地地址是 `http://127.0.0.1:8000`，webhook 路径与源码一致。

### 3.3 Python 依赖（F1）

- `fastapi>=0.116,<1.0`
- `httpx>=0.28,<1.0`
- `pydantic-settings>=2.10,<3.0`
- `uvicorn[standard]>=0.35,<1.0`

依赖使用兼容范围而非精确锁定，目录没有 lockfile/requirements hash。

## 4. 配置事实（F1）

`Settings` 使用 Pydantic Settings，从 `.env` 读取 UTF-8，忽略额外项，并通过 `lru_cache(maxsize=1)` 缓存。

| 环境变量                    | 必需/默认                        | 作用                                 |
| --------------------------- | -------------------------------- | ------------------------------------ |
| `FEISHU_APP_ID`             | 必需                             | 飞书应用 ID                          |
| `FEISHU_APP_SECRET`         | 必需                             | 应用 Secret                          |
| `FEISHU_VERIFICATION_TOKEN` | 可选                             | 回调 token 验证                      |
| `FEISHU_ENCRYPT_KEY`        | 可选                             | 配置存在，但当前加密回调分支返回 501 |
| `FEISHU_BOT_NAME`           | 默认 `bro`                       | 群聊点名过滤                         |
| `OPENAI_API_KEY`            | 必需                             | Responses API 鉴权                   |
| `OPENAI_MODEL`              | 默认 `gpt-5-mini`                | 模型 ID                              |
| `OPENAI_BASE_URL`           | 默认 `https://api.openai.com/v1` | API base URL                         |
| `BOT_SYSTEM_PROMPT`         | 内置英文 prompt                  | Bot 行为与语言                       |
| `DATABASE_PATH`             | 默认 `./data/bot.db`             | SQLite                               |
| `REQUEST_TIMEOUT_SECONDS`   | 默认 60                          | Feishu/OpenAI HTTP 超时              |
| `LOG_LEVEL`                 | 默认 `INFO`                      | 日志级别                             |

`.env.example` 使用占位 key；实际 `.env` 被 `.gitignore` 排除，本次未读取。

## 5. 事件处理流程（F1）

1. FastAPI lifespan 初始化日志、SQLite store、FeishuClient 和 OpenAIResponsesClient。
2. Webhook 读取 JSON；无效 JSON 返回 400。
3. 检查加密回调与可选 verification token。
4. `url_verification` 返回 challenge。
5. 非 `im.message.receive_v1` 事件返回 `{"code":0}`。
6. 消息事件提交给 FastAPI `BackgroundTasks`，HTTP 立即确认。
7. 从 header event ID 或 message ID 生成去重键。
8. SQLite `processed_events` 先 claim event，主键冲突代表重复事件，后续跳过。
9. 单聊直接响应；群聊只在 Bot 名称匹配 mentions 或 `<at>` 文本时响应。
10. 当前只读取 `message_type=text`；其他消息类型返回中文提示。
11. `/reset`、`reset`、`清空上下文`、`重置` 删除当前 chat 的上下文指针。
12. 从 SQLite 读取 `previous_response_id`，调用 Responses API。
13. 飞书发送成功后才保存新的 response ID；发送失败时不前移上下文。

这是一个清晰的“接入适配器 -> 幂等 -> AI -> 回发 -> 提交状态”顺序，可用于消息系统面试。

## 6. OpenAI 客户端（F1）

- 使用 `httpx.AsyncClient`，base URL 去除尾斜杠。
- `Authorization: Bearer <key>` 与 JSON content type 在 client 层设置。
- 调用 `POST /responses`。
- 请求包含 `model`、`instructions`、`input`；有历史指针时添加 `previous_response_id`。
- 输出解析先读顶层 `output_text`，再遍历 `output[type=message].content[type=output_text|text]`。
- 返回值封装为 slots dataclass：`response_id` 和 `text`。
- 响应缺少 id 或正文时抛出运行错误。
- 没有实现 streaming、tool call、structured output、usage 记录、重试和 backoff。

## 7. 飞书客户端（F1）

- base URL：`https://open.feishu.cn/open-apis`。
- 通过 `/auth/v3/tenant_access_token/internal` 获取 tenant access token。
- token 在内存缓存，过期时间使用 monotonic clock，并提前至少 60 秒刷新。
- 使用 `asyncio.Lock` 避免并发刷新风暴。
- 发送消息调用 `/im/v1/messages?receive_id_type=chat_id`。
- 长文本每 1,500 个 Python 字符切一段并顺序发送。
- 飞书响应 HTTP 成功后还检查业务层 `code`。
- 当前仅发送 `msg_type=text`，没有 card、image、file 或富文本。

## 8. SQLite Store（F1/F4）

### 8.1 Schema

`ConversationStore` 在启动时创建两张表：

- `conversations(chat_id PRIMARY KEY, previous_response_id, updated_at)`。
- `processed_events(event_id PRIMARY KEY, processed_at)`。

### 8.2 并发与幂等

- SQLite 连接启用 `check_same_thread=False`。
- 每个数据库动作由 `threading.Lock` 保护。
- `set_previous_response_id` 使用 SQLite `ON CONFLICT DO UPDATE`。
- `claim_event` 使用唯一主键和 `IntegrityError` 实现幂等。
- 每次写操作立即 commit。

### 8.3 既有数据库

- `data/bot.db` 存在，大小 20,480 bytes，时间为 2026-03-09 03:57:16（F4）。
- 本次没有读取 chat ID、response ID 或消息内容。

## 9. 测试事实（F1）

`tests/test_main.py` 使用标准库 `unittest` 和 fakes，定义 4 个测试：

1. 群聊点名 `bro` 时回复。
2. 群聊只点名其他人时忽略。
3. 飞书发送成功后保存 response ID。
4. 第一次发送失败时不保存 response ID，并尝试发送 fallback 错误消息。

测试没有覆盖 webhook token、URL verification、重复 event、reset、非文本、Responses API parsing、token refresh、SQLite 真连接或加密回调。本次盘点没有运行测试。

## 10. 工程风险与可讲反思（F1/F5）

- event 在 AI/发送前就写入 `processed_events`；若后台任务中途失败，飞书重投相同 event 会被跳过。更稳的模型应区分 claimed/processing/succeeded/failed，并对失败设置可重试状态。
- BackgroundTasks 随单进程生命周期运行，进程重启时没有 durable queue。
- verification token 是可选项；生产 webhook 应有明确的签名、token 与 encrypted callback 策略。
- 机器人回调加密尚未实现；README 已明确写为 starter 边界。
- 没有 per-chat 锁；同一 chat 的并发消息可能读到同一个 previous response ID，导致会话分叉。
- SQLite 表没有清理/TTL，`processed_events` 会持续增长。
- 公网回调、限流、管理员白名单、审计日志和成本限制都在 README 的后续升级项中。

---

# B. secondary-brightness-widget

## 11. 路径与文件（F1/F2）

路径：`C:\Users\10847\Documents\Playground\secondary-brightness-widget`

全部 6 个文件：

- `SecondaryBrightnessWidget.ps1`：主程序。
- `RunSecondaryBrightnessWidget.bat`：从相对路径启动 VBS。
- `LaunchSecondaryBrightnessWidget.vbs`：隐藏 PowerShell 窗口。
- `EnableAutostart.ps1`：写当前用户 Run registry。
- `DisableAutostart.ps1`：删除 registry 项。
- `README.md`：英文使用说明。

总计约 710 行源码/文档；无外部包清单、无测试文件。

## 12. 平台与 API（F1）

- Windows PowerShell 5 风格脚本。
- UI 使用 `System.Windows.Forms` 和 `System.Drawing`。
- 通过运行时 `Add-Type` 编译 C# P/Invoke 定义。
- `user32.dll`：枚举显示器、读取 monitor info、枚举 display device、窗口前置/恢复、鼠标操作。
- `dxva2.dll`：physical monitor 枚举、读/写亮度、销毁 handle。
- 核心协议是 DDC/CI，因此目标外接显示器必须暴露 brightness control。

## 13. 目标选择和资源生命周期（F1）

- 枚举所有 display monitor。
- 读取 `MONITORINFOEX` 判断 primary flag。
- 过滤主显示器，选择第一个支持 `GetMonitorBrightness` 的非主显示器。
- 打开该 logical monitor 对应的 physical monitor handles。
- 亮度百分比与显示器 native min/max 双向换算。
- 所有 handle 在刷新、命令行完成和窗口关闭时调用 `DestroyPhysicalMonitor`。
- 对同一逻辑显示器的多个 physical handles，设置亮度时逐个调用，至少一个成功才算更新。

## 14. UI 与交互（F1）

- 固定 420x210 窗口，标题 `Secondary Brightness`。
- TrackBar 0-100，tick 10，small change 1，large change 5。
- 展示设备名称、设备 ID、百分比和状态。
- `Refresh` 重新枚举显示器。
- `Always on top` 切换窗体 TopMost。
- 1 秒 timer 轮询硬件亮度，外部变化会同步到滑块。
- 滑块 ValueChanged 时实时写 native brightness。
- 无可控外接屏时禁用滑块并显示错误状态。

## 15. 单实例与命令行（F1）

- Mutex 名：`Local\SecondaryBrightnessWidget`。
- 启动时先搜索同标题 PowerShell 窗口；存在时恢复、前置并退出新实例。
- Mutex race 后还会重试前置已有窗口。
- `-PrintStatus` 输出 JSON：device、name、brightnessPercent、nativeMin/nativeCurrent/nativeMax。
- `-SetPercent 0..100` 写亮度后重新读取并输出 JSON。

## 16. 开机启动（F1）

- Registry：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
- value name：`SecondaryBrightnessWidget`。
- `DisableAutostart.ps1` 检查后删除该属性。
- 当前 `EnableAutostart.ps1` 和 VBS 中都硬编码了 `C:\Users\10847\Documents\Playground\secondary-brightness-widget`；BAT 自身使用 `%~dp0`，但最终 VBS 仍使用绝对路径。
- 路径硬编码使目录移动或其他用户运行时启动失效，是最明确的可移植性缺口。

## 17. 风险与补证（F5）

- 只选第一个支持亮度的非主显示器，没有多显示器选择器。
- DDC/CI 可用性依赖显示器固件、线缆、Dock 和 OSD 配置。
- slider 连续 ValueChanged 会产生高频硬件调用，没有 debounce。
- 1 秒轮询和 UI 事件都在 UI 线程；硬件调用阻塞时界面可能卡顿。
- 使用窗口标题查找现有进程，理论上可能匹配同名 PowerShell 窗口；Mutex 是更可靠的主约束。
- 没有 Pester/unit/hardware smoke 测试或发布包。
- 面试时可作为“从系统 API 到可用桌面工具”的小型案例，不宜与大型 AI 产品同级陈述。

---

# C. xhs_scraper

## 18. 路径、源码和产物（F1/F2/F4）

路径：`C:\Users\10847\Documents\Playground\xhs_scraper`

核心源码：

- `scrape_xiaohongshu_search.py`：567 行、18,074 bytes。
- `build_structured_excel.py`：384 行、11,681 bytes。
- `enable_openclaw_relay.ps1`：Windows Relay 附着辅助。
- `REUSABLE_WORKFLOW.md`：约束、故障处理和复用说明。

运行/交付：

- `output`：42 个文件、9.82 MiB，时间范围 2026-03-09 至 2026-03-17。
- `package`：21 个文件、0.99 MiB。
- 12 个 XLSX、2 个 PDF。
- `package/xiaohongshu-relay-scrape-bundle.zip`：18,522 bytes；ZIP 内只包含 7 个 launcher/source 文件，不包含运行数据。
- 解压后的 bundle 目录后来产生了 22 条卡片/详情结果，属于 ZIP 之外的运行产物。

## 19. 采集器数据模型（F1）

`NoteRecord` dataclass 含 14 个字段：

- `note_id`
- `title`
- `author`
- `author_profile`
- `note_url`
- `publish_time`
- `like_count`
- `collect_count`
- `comment_count`
- `body`
- `body_html`
- `tags`
- `source_card_text`
- `scraped_at`

卡片缓存有 5 个字段：note ID、详情 URL、标题、作者、card text。

## 20. Relay 与认证（F1）

- 默认 Relay 端口 18792。
- 先读取 `OPENCLAW_GATEWAY_TOKEN`；缺省时从用户目录 `.openclaw/gateway.cmd` 提取。
- 使用 HMAC-SHA256，以 `openclaw-extension-relay-v1:<port>` 为消息派生 relay token。
- token 放在 `x-openclaw-relay-token` header，通过 Playwright `connect_over_cdp` 连接 `127.0.0.1`。
- 优先复用已附着 context 和小红书 search/explore 页面；没有目标页时复用其他已附着页面。
- 不主动启动新的日常浏览器 profile；流程依赖用户已经登录并附着的 Edge 标签页。

## 21. 采集流程（F1）

1. 导航搜索页，失败时改用 `location.href`。
2. 尝试关闭常见 popup。
3. 从 `section.note-item` 获取 `a.cover[href*="/search_result/"]`。
4. 以详情 URL 去重，保留隐藏 explore URL 仅用于提取 note ID。
5. 多轮滚动，按 `max_scrolls` 与 `stable_rounds` 停止。
6. 卡片写入 `xiaohongshu_cards_latest.json`。
7. 复用同一页面逐个打开详情并读取 DOM。
8. 写时间戳 JSON/CSV，并持续更新 latest checkpoint。
9. `--resume` 读取已有详情，`--use-card-cache` 直接复用卡片缓存。

脚本有 3 次通用重试、导航 fallback、`Execution context was destroyed` 处理和单页复用，体现了对真实浏览器会话不稳定性的工程适配。

## 22. CLI 参数（F1）

- `--search-url`：默认内置一条 URL encoded 搜索页。
- `--max-scrolls`：默认 40。
- `--stable-rounds`：默认 4。
- `--limit`：默认 0，表示脚本不设置数量上限。
- `--goto-timeout-ms`：默认 45,000。
- `--note-delay-seconds`：默认 0.8。
- `--resume`：加载 latest 详情结果。
- `--use-card-cache`：跳过搜索滚动，直接处理缓存卡片。
- 另有 output 目录参数（源码 `parse_args` 后续定义）。

`REUSABLE_WORKFLOW.md` 推荐首次用 15 scroll、4 stable rounds、15 秒详情导航、0.2 秒间隔；续跑用 card cache、12 秒导航、0.1 秒间隔。推荐值与代码默认值不同，属于文档针对既有场景的调优值。

## 23. Excel 结构化（F1）

`build_structured_excel.py`：

- 输入 `output/xiaohongshu_notes_latest_dedup.json`。
- 输出 `xiaohongshu_notes_structured.xlsx` 和时间戳副本。
- Workbook 包含说明 sheet、`Structured` 和 `Raw`。
- 对 header、链接、换行、列宽和 freeze/filter 做格式处理。
- 从 title/body/card text/tags 中规则提取城市、公司/平台、岗位、到岗时间和邮箱。
- 支持相对时间估算：分钟前、小时前、天前、昨天、MM-DD。
- 城市和公司使用显式关键词字典，岗位和到岗时间使用正则。
- Structured 字段包括笔记 ID、标题、作者、发布时间、估算时间、城市、公司、岗位、到岗时间、邮箱、互动量、标签、链接、作者主页、卡片摘要、正文摘要和完整正文。

这是确定性信息提取原型；字典/正则的召回率和误报率未见评测集。

## 24. Relay 附着辅助（F1）

`enable_openclaw_relay.ps1`：

- 默认按窗口标题关键词寻找 Edge。
- 通过 UI Automation 定位 `EdgeExtensionsHubButton` 和 `OpenClaw Browser Relay` 菜单项。
- 必要时用 Win32 鼠标事件点击元素中心。
- 通过 Relay `/json/list` 和 HMAC header 检查目标 host 页面。
- 若已经有目标 page 直接成功退出。
- 文档承认自动点击扩展存在不稳定场景，建议用户手动点击作为可靠恢复动作（F3）。

## 25. 既有运行数据聚合（F4）

为保护内容与作者信息，本次只统计记录数和字段：

| 产物                                                 | 记录数 | 解释                |
| ---------------------------------------------------- | -----: | ------------------- |
| `output/xiaohongshu_cards_latest.json`               |    220 | 候选卡片缓存        |
| `output/xiaohongshu_notes_20260309_192148.json`      |    184 | 一次详情运行        |
| `output/xiaohongshu_notes_20260309_192153.json`      |    184 | 相近时间运行        |
| `output/xiaohongshu_notes_20260309_200103.json`      |     65 | 后续运行            |
| `output/xiaohongshu_notes_latest.json`               |     65 | 当前 latest raw     |
| `output/xiaohongshu_notes_latest_dedup.json`         |    182 | 当前 latest dedup   |
| `output/skill-test/...dedup.json`                    |     29 | Skill 验证          |
| `output/oneclick-test/xiaohongshu_cards_latest.json` |     22 | 一键运行 card cache |
| `output/oneclick-test/...notes...json`               |      1 | 一键 smoke 详情结果 |
| 解压 bundle 的 `output/...latest.json`               |     22 | 解压目录后续运行    |

`latest raw=65` 而 `latest dedup=182`，说明两个“latest”可能来自不同阶段/运行；没有 manifest 把它们绑定为同一次执行。面试使用时应选带时间戳文件，避免混合口径（F5）。

## 26. 可复用工作流文档声明（F3）

`REUSABLE_WORKFLOW.md` 记录：

- headless/公开直连容易遇到安全限制或登录拦截，优先复用用户当前 Edge 登录态。
- `/search_result/` 卡片详情链接比隐藏 `/explore/` 链接更适合正文读取。
- 断点恢复要同时缓存“已抓详情”和“已扫描卡片”。
- Relay ready 应同时检查 running、CDP ready 和 tabs 非空。
- Relay 断开后先诊断 attachment，再从 checkpoint 继续，而不是重扫。
- `Execution context was destroyed`、`Target.createTarget`、`ERR_ABORTED` 和 timeout 是已记录的故障类型。

这些结论来自一次项目实践记录，适合说明为什么后来主项目演进出 preflight、JobManager、checkpoint、SSE 和 artifact gate。

## 27. 风险与下一步（F5）

- 默认搜索 URL 和端口写在源码常量，复用性依赖 CLI override。
- 从 gateway.cmd 提取 token 是平台/安装结构耦合，应通过稳定配置接口替代。
- 采集 DOM selector 依赖站点结构，缺少 selector fixture 和回归测试。
- 采集器没有正式 test 文件；output 只是运行证据。
- JSON/CSV checkpoint 写入不是明确的 atomic replace，进程中断可能留下不完整文件。
- raw/dedup/structured 的 lineage 缺少统一 manifest；现有 latest 文件已经出现计数不一致。
- 输出包含正文、作者、主页、联系方式和 2 个 PDF，进入版本库前需要隐私审查和 allowlist。
- 结构化 extractor 是关键词/正则，不应把空值或规则命中当成经过语义验证的岗位事实。
- 这个原型最适合讲“从一次性脚本到可靠工作流的第一阶段”，随后连接到主项目的服务化、状态机、测试和发布演进。

## 28. 三个原型的面试定位

### 飞书 Bot

讲 webhook、幂等、会话状态、异步 HTTP 客户端和失败提交顺序。主动指出 durable queue、同会话并发、回调加密和状态机仍待加强。

### 亮度控件

讲 P/Invoke、硬件 handle 生命周期、百分比映射、单实例和系统启动。主动指出绝对路径、单显示器选择和硬件测试不足。

### Relay 采集器

讲登录态复用、CDP、DOM 选择、卡片/详情双 checkpoint、断点恢复和结构化导出。主动指出 manifest、atomic write、selector 测试与隐私治理缺口。
