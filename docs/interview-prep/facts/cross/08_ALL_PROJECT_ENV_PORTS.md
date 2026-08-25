# 全项目环境变量与端口总表

> 静态扫描日期：2026-08-18（Asia/Shanghai）。
> 数据源：示例配置、`process.env`、`os.getenv`/`os.environ.get`、PowerShell `$env:`、Pydantic Settings、workflow `env`、启动器参数和服务监听代码。真实 `.env`、ignored config、secret、token、cookie、key 与数据库内容均未读取。名称出现代表代码或示例认识该变量，不代表生产部署需要同时设置全部变量。

## 1. 端口总表

| 项目/服务                     | 默认或示例地址                    | 类型                    | 证据路径                                              |
| ----------------------------- | --------------------------------- | ----------------------- | ----------------------------------------------------- |
| XHS Node API                  | `127.0.0.1:4317`                  | 当前工作树默认          | `server/config.mjs`、`.env.example`                   |
| XHS 生产示例                  | `127.0.0.1:4327`                  | 示例覆盖                | `.env.production.example`                             |
| XHS Vite                      | `[::]:5173`                       | 开发 UI                 | `vite.config.ts`                                      |
| XHS MCP HTTP                  | `127.0.0.1:4328`                  | loopback 默认           | `server/config.mjs`、`.env.example`                   |
| XHS Playwright API/UI         | `4318` / `5190`                   | 测试默认                | `playwright.config.ts`                                |
| XHS Browser Relay/CDP         | `18800`                           | 上游/Relay 常见默认     | vendor runner、Relay 配置与文档                       |
| XHS local model               | `127.0.0.1:11434`                 | 模型 endpoint 默认      | `server/config.mjs`                                   |
| XHS OCR OpenAI-compatible     | `127.0.0.1:11434/v1`              | 示例                    | `.env.example`                                        |
| XHS dedicated OCR             | `127.0.0.1:11435`                 | 示例                    | `.env.example`                                        |
| XHS SMTP                      | `587`                             | SMTP 默认               | `server/config.mjs`、`.env.example`                   |
| XHS Cloudflare metrics        | `127.0.0.1:20242`                 | 生产示例                | `.env.production.example`                             |
| XHS CI Mailpit                | SMTP `1025` / Web `8025`          | CI service              | `.github/workflows/ci.yml`                            |
| XHS clean release verify      | `65431`                           | 临时验证端口            | `.github/workflows/release.yml`                       |
| KOLFORGE API                  | code `8787`；example `8798`       | 默认/示例双口径         | `server/config.mjs`、`vite.config.js`、`.env.example` |
| KOLFORGE Browser/XHS Relay    | `18800`                           | Relay                   | `server/config.mjs`、`.env.example`                   |
| KOLFORGE Douyin Relay/message | `18801`                           | 固定/示例               | `server/config.mjs`、`.env.example`                   |
| KOLFORGE local model/vision   | `127.0.0.1:11434`                 | 默认/注释示例           | `server/config.mjs`、`.env.example`                   |
| KOLFORGE Session Forensics UI | `8794`                            | 默认                    | `session-forensics/ui-server.mjs`                     |
| today portable API            | `127.0.0.1:4317`                  | 默认                    | `server/config.mjs`、`.env.example`                   |
| today portable Vite           | `[::]:5173`                       | 开发 UI                 | `vite.config.ts`                                      |
| today portable Playwright     | API `4318` / UI `5190`            | 测试默认                | `playwright.config.ts`                                |
| today portable Mailpit        | `1025` / `8025`                   | CI                      | `.github/workflows/ci.yml`                            |
| Feishu Bot                    | `0.0.0.0:8000`                    | README 启动命令         | `README.md`                                           |
| Brightness Widget             | 未发现网络监听                    | 桌面工具                | `SecondaryBrightnessWidget.ps1`                       |
| Playground XHS Scraper        | Relay `18800`                     | script 默认/配置        | `scrape_xiaohongshu_search.py`                        |
| Asteria 双服务 launcher       | backend `8000` / frontend `3000`  | launcher 默认           | `start-asteria.ps1`                                   |
| Asteria desktop/portable      | `127.0.0.1:8787`                  | desktop 默认            | `backend/run_desktop.py`                              |
| Asteria CI portable smoke     | `18787`                           | 临时测试                | `.github/workflows/ci.yml`                            |
| hegel-salon                   | `3087`                            | server/container 默认   | `src/server.mjs`、Docker/Compose/Render               |
| hegel SMTP                    | `587` fallback                    | mail config             | `src/server.mjs`、`src/mailDelivery.mjs`              |
| wechat-cli                    | 未发现产品网络监听                | CLI                     | `wechat_cli/*`                                        |
| wechat-decrypt Web/SSE        | `0.0.0.0:5678`                    | Web monitor 固定        | `monitor_web.py`                                      |
| wechat-decrypt MCP            | stdio，无 TCP port                | MCP                     | `mcp_server.py`                                       |
| MDX workflow backend          | `127.0.0.1:8080`                  | Pages workflow 临时服务 | `.github/workflows/sync-star-history.yml`             |
| Burp MCP Java service         | 配置化，bridge 读 `BURP_MCP_PORT` | 外部子项目              | `burp-mcp-full/mcp-bridge.js`、Java server            |

## 2. 端口解释规则

1. KOLFORGE 的 `8787` 是代码回退，`8798` 是 `.env.example`；两者都是真实静态事实，实际进程取环境值优先。
2. Asteria 有“双服务开发 launcher”与“单端口 desktop/portable”两种运行形态，`8000/3000` 和 `8787` 不冲突。
3. XHS 的 `4317`、`4327`、`4318` 分别是开发默认、生产示例和 Playwright 测试默认。
4. Mailpit、release verify、Asteria smoke 和 MDX `8080` 是 CI 临时端口，不是产品公网入口。
5. `0.0.0.0` 表示监听所有接口；Feishu webhook 通常还需要反向代理/tunnel，wechat-decrypt 当前 Web 路径缺登录层。

## 3. XHS 环境变量

### 3.1 核心配置族与证据

| 配置族                 | 名称                                                                                                                                                                                                                                                                       | 主要证据                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 应用监听               | `HOST`、`PORT`、`NODE_ENV`、`VITE_API_PORT`、`VITE_API_PROXY`                                                                                                                                                                                                              | `server/config.mjs`、`vite.config.ts`                     |
| Python/路径            | `PYTHON_BIN`、`PYTHON`、`CODEX_HOME`、`CODEX_CLI_BIN`、`XHS_RUNNER_PATH`、`XHS_UPSTREAM_RUNNER`、`XHS_UPSTREAM_SCRAPER`                                                                                                                                                    | config、preflight、scripts                                |
| 数据目录               | `XHS_SERVER_DATA_DIR`、`XHS_PROFILE_DATA_DIR`、`XHS_BROWSER_DATA_DIR`、`XHS_STATIC_DIR`、`XHS_ARTIFACTS_DIR`                                                                                                                                                               | `server/config.mjs`、启动器                               |
| Relay                  | `OPENCLAW_CONFIG_PATH`、`OPENCLAW_GATEWAY_TOKEN`、`XHS_RELAY_CONFIG_PATH`、`XHS_RELAY_AUTOCONNECT`、`XHS_RELAY_*_MS`、`XHS_OPENCLAW_BIN`                                                                                                                                   | config、Relay scripts、vendor                             |
| AI provider            | `XHS_AI_PROVIDER`、`XHS_AI_BASE_URL`、`XHS_AI_API_KEY`、`XHS_AI_MODEL`、`XHS_AI_VISION_MODEL`、`XHS_AI_WIRE_API`、`XHS_AI_TIMEOUT_SECONDS`、`XHS_AI_MAX_OUTPUT_TOKENS`、`XHS_AI_MODEL_CONTEXT_TOKENS`、`XHS_AI_HTTP_MAX_RETRIES`、`XHS_AI_KEEP_ALIVE`、`XHS_AI_USER_AGENT` | `scripts/ai_provider_runtime.py`                          |
| OCR                    | `XHS_APPLICATION_CONTACT_OCR_*`、`OLLAMA_*`                                                                                                                                                                                                                                | `server/config.mjs`、`.env.example`、one-click            |
| Audience AI            | `XHS_AUDIENCE_AI_ENABLED`、`XHS_AUDIENCE_AI_RUNNER_PATH`、`XHS_AUDIENCE_AI_MAX_CONCURRENT`                                                                                                                                                                                 | config/example                                            |
| SMTP                   | `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_REQUIRE_TLS`、`SMTP_AUTH`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`、`SMTP_OAUTH_*`、`SMTP_PROVIDER`                                                                                                                           | config/example/mail scripts                               |
| Auth                   | `XHS_AUTH_REQUIRED`、`XHS_AUTH_ORIGIN`、`XHS_AUTH_SECURE_COOKIE`、`XHS_AUTH_COOKIE_NAME`、`XHS_AUTH_SESSION_TTL_SECONDS`、`XHS_AUTH_*_PATH`、`XHS_AUTH_EMAIL`、`XHS_AUTH_PASSWORD`、`XHS_AUTH_REPLACE`                                                                     | config/provision/production scripts                       |
| MCP                    | `XHS_MCP_*`                                                                                                                                                                                                                                                                | `server/config.mjs`、bridge/verifier、example files       |
| Copilot                | `XHS_COPILOT_APPROVAL_MODE`、`XHS_COPILOT_EXEC_TIMEOUT_MS`、`XHS_COPILOT_HTTP_TIMEOUT_MS`、`XHS_COPILOT_MAX_OUTPUT_BYTES`、`XHS_COPILOT_MCP_CONFIG_PATH`、`XHS_COPILOT_WORKSPACE_ROOT`                                                                                     | `server/config.mjs`                                       |
| Codex device/connector | `XHS_CODEX_*`                                                                                                                                                                                                                                                              | config、device relay、connector、probe、packaging scripts |
| Cover letter batch     | `COVER_LETTER_*`、`JOB_ID`                                                                                                                                                                                                                                                 | external/local/until-complete runners                     |
| 测试/录制              | `PLAYWRIGHT_*`、`MAILPIT_*`、`MOCK_RUNNER_*`、`DEMO_*`、`COPILOT_*`、`PROFILE_AI_E2E_*`                                                                                                                                                                                    | test/config/record scripts                                |
| 部署/tunnel            | `CLOUDFLARE_*`、proxy variables、`HEGELSALON_VERIFY_*`                                                                                                                                                                                                                     | production/verify scripts、workflow                       |

### 3.2 本轮静态抽取的 268 个显式名称

抽取范围排除了 `.codex-tmp` 审计 clone、deliverables、browser profile、生成目录与大型产物。大小写不同的系统 proxy/Path 名称按源码原样保留。

```text
AI_API_KEY
all_proxy
ALL_PROXY
APP_MODULE_URL
APP_URL
APPDATA
APPLICATION_JOB_ID
APPLICATION_OUTPUT_ID
APPLICATION_RESUME_PATH
ATTACHMENT_MODULE_URL
CLOUDFLARE_MCP_PUBLIC_URL
CLOUDFLARE_METRICS
CLOUDFLARE_PUBLIC_URL
CLOUDFLARE_TUNNEL_NAME
CLOUDFLARE_TUNNEL_TOKEN_FILE
CODEX_CLI_BIN
CODEX_HOME
COPILOT_DELTA_COUNT
COPILOT_EXPECTED_RUN_CALLS
COPILOT_INITIAL_VISIBLE
COPILOT_REPLAY_EVENTS
COPILOT_SSE_EVENTS
COPILOT_SUBAGENT_EVENTS
COPILOT_VISUAL_OUTPUT
COVER_LETTER_AI_SESSION_ID
COVER_LETTER_API_BASE
COVER_LETTER_API_REQUEST_SIZE
COVER_LETTER_AUTH_CREDENTIAL_PATH
COVER_LETTER_AUTH_EMAIL
COVER_LETTER_AUTH_PASSWORD
COVER_LETTER_AUTO_RESUME_INTERVAL_MS
COVER_LETTER_AUTO_RESUME_MAX_CYCLES
COVER_LETTER_BATCH_LIMIT
COVER_LETTER_BATCH_SIZE
COVER_LETTER_CONCURRENCY
COVER_LETTER_JOB_ID
COVER_LETTER_LIMIT
COVER_LETTER_LOCAL_BASE_URL
COVER_LETTER_MAX_ATTEMPTS
COVER_LETTER_MAX_NO_PROGRESS_CYCLES
COVER_LETTER_MODEL
COVER_LETTER_PARTIAL_RETRY_INTERVAL_MS
COVER_LETTER_PROGRESS
COVER_LETTER_PROMPT_PATH
COVER_LETTER_PYTHON
COVER_LETTER_QUALITY_CONCURRENCY
COVER_LETTER_QUALITY_MAX_ATTEMPTS
COVER_LETTER_REJECTED_OUTPUT
COVER_LETTER_REQUEST_TIMEOUT_SECONDS
COVER_LETTER_RESUME
DEMO_AUDIENCE_JOB_ID
DEMO_COPILOT_SESSION_ID
DEMO_EXPANSION_JOB_ID
DEMO_GENERAL_JOB_ID
DEMO_JOB_ID
DRAFT_ID
DRAFT_VERSION
FILE_CONTENT
FILE_NAME
GITHUB_OUTPUT
GO_FILE
HEGELSALON_VERIFY_ARTIFACT_COUNT
HEGELSALON_VERIFY_ARTIFACT_JOB_ID
HEGELSALON_VERIFY_EMAIL
HEGELSALON_VERIFY_HISTORY_JOB_ID
HEGELSALON_VERIFY_JOB_IDS
HEGELSALON_VERIFY_PASSWORD
HEGELSALON_VERIFY_SCREENSHOT
HEGELSALON_VERIFY_URL
HOME
HOST
HTTP_PROXY
http_proxy
HTTPS_PROXY
https_proxy
JOB_ID
LOCALAPPDATA
MAILPIT_ARCHIVE_PATH
MAILPIT_CACHE_DIR
MAILPIT_HTTP_URL
MAILPIT_SMTP_HOST
MAILPIT_SMTP_PORT
MOCK_RUNNER_DELAY_SECONDS
MOCK_RUNNER_LONG_SECONDS
MOCK_RUNNER_RECORDS
MOCK_RUNNER_SCENARIO
NO_PROXY
NODE_ENV
NOTE_ID
OLLAMA_CONTEXT_LENGTH
OLLAMA_HOST
OLLAMA_MAX_LOADED_MODELS
OLLAMA_NUM_PARALLEL
OPENCLAW_CONFIG_PATH
OPENCLAW_GATEWAY_TOKEN
OS
OUTPUT_DIR
PATH
Path
PLAYWRIGHT_API_PORT
PLAYWRIGHT_SERVER_DATA_ROOT
PLAYWRIGHT_WEB_PORT
PORT
PROFILE_AI_E2E_BASE_URL
PROFILE_AI_E2E_SCREENSHOT
ProgramFiles
PYTHON
PYTHON_BIN
READY_FILE
RECIPIENT
RESULT_DIR
RUNNER_TEMP
SEND_LOG
SMTP_AUTH
SMTP_FROM
SMTP_HOST
SMTP_OAUTH_CLIENT_ID
SMTP_OAUTH_CLIENT_SECRET
SMTP_OAUTH_REFRESH_TOKEN
SMTP_OAUTH_SCOPE
SMTP_OAUTH_TENANT
SMTP_PASS
SMTP_PORT
SMTP_PROVIDER
SMTP_REQUIRE_TLS
SMTP_SECURE
SMTP_USER
SystemRoot
TEMP
USERPROFILE
VITE_API_PORT
VITE_API_PROXY
WORKFLOW_STATE_TEST_PATH
WORKFLOW_STATE_TEST_WRITER
XHS_AI_API_KEY
XHS_AI_BASE_URL
XHS_AI_CONFIG_PATH
XHS_AI_HTTP_MAX_RETRIES
XHS_AI_KEEP_ALIVE
XHS_AI_MAX_OUTPUT_TOKENS
XHS_AI_MODEL
XHS_AI_MODEL_CONTEXT_TOKENS
XHS_AI_PROVIDER
XHS_AI_TIMEOUT_SECONDS
XHS_AI_USER_AGENT
XHS_AI_VISION_MODEL
XHS_AI_WIRE_API
XHS_APPLICATION_CONTACT_OCR_AUTO_ENABLED
XHS_APPLICATION_CONTACT_OCR_BASE_URLS
XHS_APPLICATION_CONTACT_OCR_CHECKPOINT_EVERY
XHS_APPLICATION_CONTACT_OCR_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENABLED
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENDPOINT
XHS_APPLICATION_CONTACT_OCR_ENABLED
XHS_APPLICATION_CONTACT_OCR_IMAGE_BATCH_SIZE
XHS_APPLICATION_CONTACT_OCR_KEEP_ALIVE
XHS_APPLICATION_CONTACT_OCR_MAX_ATTEMPTS
XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS
XHS_APPLICATION_CONTACT_OCR_MODEL
XHS_APPLICATION_CONTACT_OCR_MODEL_PARALLEL
XHS_APPLICATION_CONTACT_OCR_PREFETCH_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_TIMEOUT_SECONDS
XHS_ARTIFACTS_DIR
XHS_ATTACHMENT_MAX_FILE_BYTES
XHS_ATTACHMENT_MAX_FILES
XHS_ATTACHMENT_MAX_TOTAL_BYTES
XHS_AUDIENCE_AI_ENABLED
XHS_AUDIENCE_AI_MAX_CONCURRENT
XHS_AUDIENCE_AI_RUNNER_PATH
XHS_AUTH_COOKIE_NAME
XHS_AUTH_DATA_DIR
XHS_AUTH_EMAIL
XHS_AUTH_ORIGIN
XHS_AUTH_PASSWORD
XHS_AUTH_REPLACE
XHS_AUTH_REQUIRED
XHS_AUTH_SECURE_COOKIE
XHS_AUTH_SESSION_SECRET_PATH
XHS_AUTH_SESSION_TTL_SECONDS
XHS_AUTH_USERS_PATH
XHS_BROWSER_DATA_DIR
XHS_BROWSER_PATH
XHS_CODEX_CONNECT_ALLOWED_ORIGINS
XHS_CODEX_CONNECTOR_INSTALLER_PATH
XHS_CODEX_CONNECTOR_VERSION
XHS_CODEX_DESKTOP_RUNTIME_DIR
XHS_CODEX_DESKTOP_USER_DATA_DIR
XHS_CODEX_DEVICE_GATEWAY_AUDIT_PATH
XHS_CODEX_DEVICE_GATEWAY_HEARTBEAT_SECONDS
XHS_CODEX_DEVICE_GATEWAY_STATE_PATH
XHS_CODEX_EXECUTABLE
XHS_CODEX_LOCAL_RELAY_URL
XHS_CODEX_MIRROR_ICE_SERVERS_JSON
XHS_CODEX_PROBE_DIR
XHS_CODEX_PROTOCOL_EVIDENCE_ROOT
XHS_CODEX_PROTOCOL_VERSION
XHS_CODEX_RUNTIME_BASELINE_PATH
XHS_CODEX_SOURCE_APP_DIR
XHS_CODEX_SQLITE_HOME
XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS
XHS_CODEX_TURN_SHARED_SECRET
XHS_CODEX_TURN_URLS_JSON
XHS_CODEX_UNPACKED_DIR
XHS_CODEX_WORKTREE_ROOT
XHS_COMMON_PATH
XHS_COPILOT_APPROVAL_MODE
XHS_COPILOT_EXEC_TIMEOUT_MS
XHS_COPILOT_HTTP_TIMEOUT_MS
XHS_COPILOT_MAX_OUTPUT_BYTES
XHS_COPILOT_MCP_CONFIG_PATH
XHS_COPILOT_WORKSPACE_ROOT
XHS_COVER_LETTER_TRACE
XHS_DATA_RETENTION_PATH
XHS_DELETION_AUDIT_PATH
XHS_DIAGNOSTICS_PATH
XHS_LEGACY_PROFILE_DIR
XHS_LOCAL_MODEL_ENDPOINT
XHS_MANAGED_BROWSER_SCRIPT
XHS_MAX_BODY_BYTES
XHS_MCP_ENABLED
XHS_MCP_HOST
XHS_MCP_MAX_BODY_BYTES
XHS_MCP_MAX_CALLS_PER_MINUTE
XHS_MCP_MAX_CONCURRENT_TOOLS_PER_GRANT
XHS_MCP_MAX_OUTPUT_BYTES
XHS_MCP_MAX_SESSIONS
XHS_MCP_MAX_SESSIONS_PER_GRANT
XHS_MCP_PORT
XHS_MCP_PUBLIC_SHOWCASE_ENABLED
XHS_MCP_PUBLIC_SHOWCASE_MAX_BODY_BYTES
XHS_MCP_PUBLIC_SHOWCASE_MAX_CALLS_PER_MINUTE
XHS_MCP_PUBLIC_SHOWCASE_MAX_CONCURRENT_REQUESTS
XHS_MCP_PUBLIC_URL
XHS_MCP_REQUIRE_CLOUDFLARE_HEADERS
XHS_MCP_SESSION_IDLE_SECONDS
XHS_MCP_TOKEN
XHS_MCP_TOKEN_FILE
XHS_MCP_TOKEN_PEPPER_PATH
XHS_MCP_TOOL_TIMEOUT_MS
XHS_MCP_URL
XHS_MCP_VERIFY_SKIP_RESOURCE_READ
XHS_MCP_VERIFY_SKIP_TOOL_CALL
XHS_NODE_BIN
XHS_OPENCLAW_BIN
XHS_OUTPUT_DIR
XHS_OUTREACH_RUNTIME
XHS_PROFILE_DATA_DIR
XHS_PROFILE_PATH
XHS_RATE_LIMIT_AUTO_RECOVERY
XHS_RATE_LIMIT_AUTO_RECOVERY_ATTEMPTS
XHS_RATE_LIMIT_AUTO_RECOVERY_BUSY_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_INITIAL_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_MAX_MS
XHS_RELAY_AUTOCONNECT
XHS_RELAY_CONFIG_PATH
XHS_RELAY_CONNECT_TIMEOUT_MS
XHS_RELAY_FAILURE_THRESHOLD
XHS_RELAY_MONITOR_INTERVAL_MS
XHS_RELAY_PLAYWRIGHT_TIMEOUT_MS
XHS_RELAY_RECOVERY_COOLDOWN_MS
XHS_RUNNER_PATH
XHS_RUNTIME_TEST_PATH
XHS_SERVER_DATA_DIR
XHS_SMTP_CONFIG_PATH
XHS_STATIC_DIR
XHS_UPSTREAM_RUNNER
XHS_UPSTREAM_SCRAPER
```

主要证据路径：`.env.example`、`.env.production.example`、`server/config.mjs`、`vite.config.ts`、`playwright.config.ts`、`scripts/*`、`server/*.test.mjs`、`tests/*`、`vendor/xiaohongshu-relay-scrape/scripts/*`、`.github/workflows/*`。

## 4. KOLFORGE 环境变量

### 4.1 `.env.example` 的 25 个有效赋值

```text
KOLFORGE_PORT
KOLFORGE_DATA_DIR
KOLFORGE_MAX_DISCOVERY_PER_CHANNEL
KOLFORGE_DISCOVERY_QUERY_VARIANTS
KOLFORGE_DISCOVERY_ROUTE_OVERFETCH_RATIO
KOLFORGE_BROWSER_RELAY_COLLECTION_TIMEOUT_MS
KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR
KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR
KOLFORGE_CONTENT_COLLECTION_CONCURRENCY
KOLFORGE_CONTENT_PERSISTENCE_WORKERS
BROWSER_RELAY_PORT
XIAOHONGSHU_RELAY_PORT
DOUYIN_RELAY_PORT
DOUYIN_MESSAGE_CONNECTOR
DOUYIN_MESSAGE_RELAY_PORT
DOUYIN_MESSAGE_TIMEOUT_MS
KOLFORGE_BROWSER_PROFILE_ALIAS
XIAOHONGSHU_CONNECTOR
XIAOHONGSHU_RELAY_SCRIPT
DOUYIN_CONNECTOR
DOUYIN_RELAY_SCRIPT
DOUYIN_SEARCH_URL_TEMPLATE
BILIBILI_CONNECTOR
BILIBILI_RELAY_SCRIPT
BILIBILI_SEARCH_URL_TEMPLATE
```

### 4.2 `.env.example` 注释提供的 75 个配置名

注释项是可选 provider/connector 示例，不代表默认启用。

```text
BILIBILI_CONNECTOR
BILIBILI_PARTNER_TOKEN
BILIBILI_PARTNER_URL
DOUYIN_CLIENT_KEY
DOUYIN_CLIENT_SECRET
DOUYIN_CONNECTOR
DOUYIN_DEVICE_ID
DOUYIN_MESSAGE_API_TOKEN
DOUYIN_MESSAGE_API_URL
DOUYIN_MESSAGE_CONNECTOR
DOUYIN_MESSAGE_TIMEOUT_MS
DOUYIN_PARTNER_TOKEN
DOUYIN_PARTNER_URL
DOUYIN_PUBLISH_TIME
DOUYIN_SORT_TYPE
KOLFORGE_302_VIDEO_SUMMARY_API_KEY
KOLFORGE_302_VIDEO_SUMMARY_API_URL
KOLFORGE_302_VIDEO_SUMMARY_ENABLED
KOLFORGE_302_VIDEO_SUMMARY_LANGUAGE
KOLFORGE_302_VIDEO_SUMMARY_MAX_TOKENS
KOLFORGE_302_VIDEO_SUMMARY_MODEL
KOLFORGE_302_VIDEO_SUMMARY_REQUEST_TIMEOUT_MS
KOLFORGE_302_VIDEO_SUMMARY_TIMEOUT_MS
KOLFORGE_BILICLI_ARGS
KOLFORGE_BILICLI_COMMAND
KOLFORGE_BILICLI_CWD
KOLFORGE_BILICLI_TIMEOUT_MS
KOLFORGE_BROWSER_SESSION_STATE_DIR
KOLFORGE_CONTENT_ANALYSIS_API_KEY
KOLFORGE_CONTENT_ANALYSIS_BASE_URL
KOLFORGE_CONTENT_ANALYSIS_CONTEXT_LENGTH
KOLFORGE_CONTENT_ANALYSIS_MODEL
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGE_BYTES
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGES
KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_TOTAL_BYTES
KOLFORGE_CONTENT_ANALYSIS_OLLAMA_BASE_URL
KOLFORGE_CONTENT_ANALYSIS_OLLAMA_MODEL
KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION
KOLFORGE_CONTENT_ANALYSIS_PROVIDER
KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY
KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY
KOLFORGE_CONTENT_ANALYSIS_TIMEOUT_MS
KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY
KOLFORGE_VIDEO_ANALYSIS_ENABLED
KOLFORGE_VIDEO_ANALYSIS_FRAMES_PER_VIDEO
KOLFORGE_VIDEO_ANALYSIS_SAMPLES_PER_CREATOR
KOLFORGE_VIDEO_ANALYSIS_TIMEOUT_MS
KOLFORGE_VIDEO_BATCH_DOWNLOAD_ARGS
KOLFORGE_VIDEO_BATCH_DOWNLOAD_COMMAND
KOLFORGE_VIDEO_BATCH_DOWNLOAD_CWD
KOLFORGE_VIDEO_BATCH_DOWNLOAD_TIMEOUT_MS
KOLFORGE_VIDEO_BROWSER_RECORDING_FALLBACK
KOLFORGE_VIDEO_COPY_ANALYZER_ARGS
KOLFORGE_VIDEO_COPY_ANALYZER_COMMAND
KOLFORGE_VIDEO_COPY_ANALYZER_CWD
KOLFORGE_VIDEO_COPY_ANALYZER_TIMEOUT_MS
KOLFORGE_VIDEO_CREATOR_CONCURRENCY
KOLFORGE_VIDEO_FFMPEG_PATH
KOLFORGE_VIDEO_FFPROBE_PATH
KOLFORGE_VIDEO_PYTHON
KOLFORGE_VIDEO_PYTHON_ARGS
KOLFORGE_VIDEO_SUMMARY_ARGS
KOLFORGE_VIDEO_SUMMARY_COMMAND
KOLFORGE_VIDEO_SUMMARY_CWD
KOLFORGE_VIDEO_SUMMARY_TIMEOUT_MS
KOLFORGE_VIDEO_VISION_BASE_URL
KOLFORGE_VIDEO_VISION_CONTEXT_LENGTH
KOLFORGE_VIDEO_VISION_MAX_FRAMES
KOLFORGE_VIDEO_VISION_MODEL
KOLFORGE_VIDEO_VISION_TIMEOUT_MS
KOLFORGE_VIDEO_WHISPER_LANGUAGE
KOLFORGE_VIDEO_WHISPER_MODEL_PATH
XIAOHONGSHU_CONNECTOR
XIAOHONGSHU_PARTNER_TOKEN
XIAOHONGSHU_PARTNER_URL
```

### 4.3 config/source 额外名称

`server/config.mjs` 还引用以下未在示例有效赋值区完整覆盖的变量：

```text
DOUYIN_MESSAGE_NODE_PATH
DOUYIN_POST_SEARCH_URL_TEMPLATE
KOLFORGE_COLLECTION_RANDOM_INTERVAL_MAX_MS
KOLFORGE_COLLECTION_RANDOM_INTERVAL_MIN_MS
KOLFORGE_PYTHON
KOLFORGE_RELAY_NODE_PATH
KOLFORGE_RELAY_PLAYWRIGHT_MODULE_PATH
KOLFORGE_RELAY_PREFLIGHT_CACHE_MS
KOLFORGE_VIDEO_FUNASR_DEVICE
KOLFORGE_VIDEO_FUNASR_MODEL_DIR
KOLFORGE_VIDEO_FUNASR_SCRIPT
KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE
KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE_MAX_BYTES
KOLFORGE_VIDEO_NODE_PATH
KOLFORGE_VIDEO_PLAYWRIGHT_MODULE_PATH
KOLFORGE_VIDEO_TRANSCRIPT_PROVIDER
OPENAI_API_KEY
OPENAI_BASE_URL
USERPROFILE
```

Session Forensics/能力包子系统另有：

```text
CAPABILITY_MCP_ALLOW_COMMAND
CAPABILITY_MCP_ALLOW_DELETE
CAPABILITY_MCP_ALLOW_GIT_WRITE
CAPABILITY_MCP_ALLOW_NETWORK
CAPABILITY_MCP_ALLOW_WRITE
CAPABILITY_MCP_SKILL_ROOTS
CAPABILITY_MCP_WORKSPACE_ROOT
CODEX_HOME
CODEX_SESSION_FORENSICS_DEBUG
CODEX_SESSION_FORENSICS_HOST
CODEX_SESSION_FORENSICS_PORT
CODEX_SESSION_ROOT
CODEX_SESSION_ROOTS
CONVERSATION_AGENT_ALLOW_INSECURE_HTTP
CONVERSATION_AGENT_COMMAND_EXECUTION
CONVERSATION_AGENT_COMMAND_TIMEOUT_MS
CONVERSATION_AGENT_HOST
CONVERSATION_AGENT_MAX_STEPS
CONVERSATION_AGENT_NO_BROWSER
CONVERSATION_AGENT_OPENAI_API_KEY
CONVERSATION_AGENT_OPENAI_BASE_URL
CONVERSATION_AGENT_OPENAI_MODEL
CONVERSATION_AGENT_OPENAI_ORGANIZATION
CONVERSATION_AGENT_OPENAI_PROJECT
CONVERSATION_AGENT_OPENAI_TIMEOUT_MS
CONVERSATION_AGENT_PORT
CONVERSATION_AGENT_STATE_ROOT
CONVERSATION_AGENT_WORKSPACE_ROOT
CONVERSATION_AGENT_WORKSPACE_WRITE
CONVERSATION_BUILDER_HOST
CONVERSATION_BUILDER_NO_BROWSER
CONVERSATION_BUILDER_PORT
CONVERSATION_BUILDER_STATE_ROOT
ROOT_AGENT_SMOKE_PROVIDER_PORT
WORKBENCH_NO_BROWSER
WORKBENCH_PORT
WUHU_MKT_ROOT
```

证据路径：`.env.example`、`server/config.mjs`、`vite.config.js`、`server/scripts/*`、`session-forensics/*`、`mcp/*`。本地根存在真实 `.env`，本轮未打开。

## 5. today-you-applied-portable 环境变量

### 5.1 `.env.example` 的 49 个公开配置项

```text
HOST
PORT
PYTHON_BIN
CODEX_HOME
XHS_UPSTREAM_RUNNER
XHS_UPSTREAM_SCRAPER
XHS_SERVER_DATA_DIR
XHS_PROFILE_DATA_DIR
XHS_BROWSER_PATH
XHS_BROWSER_DATA_DIR
OPENCLAW_CONFIG_PATH
XHS_RELAY_CONFIG_PATH
CODEX_CLI_BIN
XHS_AI_TIMEOUT_SECONDS
XHS_AI_MAX_OUTPUT_TOKENS
XHS_LOCAL_AI_AUTO_SETUP
XHS_LOCAL_AI_ENDPOINT
XHS_LOCAL_AI_MODEL
XHS_AI_VISION_MODEL
XHS_APPLICATION_CONTACT_OCR_BASE_URLS
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENABLED
XHS_APPLICATION_CONTACT_OCR_DEDICATED_ENDPOINT
XHS_APPLICATION_CONTACT_OCR_MODEL
XHS_APPLICATION_CONTACT_OCR_MODEL_PARALLEL
XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS
XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS
XHS_APPLICATION_CONTACT_OCR_KEEP_ALIVE
XHS_APPLICATION_CONTACT_OCR_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_PREFETCH_CONCURRENCY
XHS_APPLICATION_CONTACT_OCR_IMAGE_BATCH_SIZE
XHS_AUDIENCE_AI_ENABLED
XHS_AUDIENCE_AI_RUNNER_PATH
XHS_AUDIENCE_AI_MAX_CONCURRENT
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_REQUIRE_TLS
SMTP_AUTH
SMTP_USER
SMTP_PASS
SMTP_FROM
SMTP_OAUTH_TENANT
SMTP_OAUTH_CLIENT_ID
SMTP_OAUTH_CLIENT_SECRET
SMTP_OAUTH_REFRESH_TOKEN
SMTP_OAUTH_SCOPE
XHS_ATTACHMENT_MAX_FILES
XHS_ATTACHMENT_MAX_FILE_BYTES
XHS_ATTACHMENT_MAX_TOTAL_BYTES
```

### 5.2 server 与 server tests 额外 61 项

```text
APP_MODULE_URL
ATTACHMENT_MODULE_URL
DRAFT_ID
DRAFT_VERSION
FILE_CONTENT
FILE_NAME
GO_FILE
HOME
MAILPIT_HTTP_URL
MAILPIT_SMTP_HOST
MAILPIT_SMTP_PORT
NODE_ENV
NOTE_ID
OUTPUT_DIR
PYTHON
READY_FILE
RECIPIENT
RESULT_DIR
SEND_LOG
SMTP_PROVIDER
USERPROFILE
WORKFLOW_STATE_TEST_PATH
WORKFLOW_STATE_TEST_WRITER
XHS_AI_BASE_URL
XHS_AI_CONFIG_PATH
XHS_AI_MODEL
XHS_AI_PROVIDER
XHS_AI_WIRE_API
XHS_APPLICATION_CONTACT_OCR_AUTO_ENABLED
XHS_APPLICATION_CONTACT_OCR_CHECKPOINT_EVERY
XHS_APPLICATION_CONTACT_OCR_ENABLED
XHS_APPLICATION_CONTACT_OCR_MAX_ATTEMPTS
XHS_APPLICATION_CONTACT_OCR_TIMEOUT_SECONDS
XHS_AUTH_COOKIE_NAME
XHS_AUTH_DATA_DIR
XHS_AUTH_EMAIL
XHS_AUTH_ORIGIN
XHS_AUTH_PASSWORD
XHS_AUTH_REQUIRED
XHS_AUTH_SECURE_COOKIE
XHS_AUTH_SESSION_SECRET_PATH
XHS_AUTH_SESSION_TTL_SECONDS
XHS_AUTH_USERS_PATH
XHS_DATA_RETENTION_PATH
XHS_DELETION_AUDIT_PATH
XHS_DIAGNOSTICS_PATH
XHS_LOCAL_MODEL_ENDPOINT
XHS_MAX_BODY_BYTES
XHS_RATE_LIMIT_AUTO_RECOVERY
XHS_RATE_LIMIT_AUTO_RECOVERY_ATTEMPTS
XHS_RATE_LIMIT_AUTO_RECOVERY_BUSY_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_INITIAL_MS
XHS_RATE_LIMIT_AUTO_RECOVERY_MAX_MS
XHS_RELAY_CONNECT_TIMEOUT_MS
XHS_RELAY_FAILURE_THRESHOLD
XHS_RELAY_MONITOR_INTERVAL_MS
XHS_RELAY_PLAYWRIGHT_TIMEOUT_MS
XHS_RELAY_RECOVERY_COOLDOWN_MS
XHS_RUNNER_PATH
XHS_SMTP_CONFIG_PATH
XHS_STATIC_DIR
```

### 5.3 scripts、E2E 与 portable runtime 额外名称

```text
AI_API_KEY
APPDATA
CODEX_CLI_BIN
COVER_LETTER_AI_SESSION_ID
COVER_LETTER_API_BASE
COVER_LETTER_BATCH_LIMIT
COVER_LETTER_BATCH_SIZE
COVER_LETTER_CONCURRENCY
COVER_LETTER_JOB_ID
COVER_LETTER_LOCAL_BASE_URL
COVER_LETTER_MAX_ATTEMPTS
COVER_LETTER_MODEL
COVER_LETTER_PROGRESS
COVER_LETTER_PYTHON
COVER_LETTER_REJECTED_OUTPUT
COVER_LETTER_RESUME
LOCALAPPDATA
MAILPIT_ARCHIVE_PATH
MOCK_RUNNER_DELAY_SECONDS
MOCK_RUNNER_LONG_SECONDS
MOCK_RUNNER_RECORDS
MOCK_RUNNER_SCENARIO
OLLAMA_CONTEXT_LENGTH
OLLAMA_HOST
OLLAMA_MAX_LOADED_MODELS
OLLAMA_NUM_PARALLEL
OPENCLAW_GATEWAY_TOKEN
Path
PLAYWRIGHT_API_PORT
PLAYWRIGHT_SERVER_DATA_ROOT
PLAYWRIGHT_WEB_PORT
PROFILE_AI_E2E_BASE_URL
PROFILE_AI_E2E_SCREENSHOT
ProgramFiles
XHS_AI_API_KEY
XHS_AI_HTTP_MAX_RETRIES
XHS_AI_KEEP_ALIVE
XHS_AI_MODEL_CONTEXT_TOKENS
XHS_COVER_LETTER_TRACE
XHS_LOCAL_AI_INSTALLER_URL
XHS_MANAGED_BROWSER_SCRIPT
XHS_NODE_BIN
XHS_OPENCLAW_BIN
XHS_OUTREACH_RUNTIME
XHS_PORTABLE_BROWSER
XHS_PORTABLE_MODE
XHS_PORTABLE_NODE
XHS_PORTABLE_PYTHON
XHS_PROFILE_PATH
```

三组去重后再加系统路径变量，本轮扫描命中 163 个显式引用。主要证据：`.env.example`、`server/config.mjs`、`scripts/*`、`playwright.config.ts`、`tests/*`、`vendor/*`。

## 6. AsteriaAnalyst 环境变量

本轮排除 `.next`、venv 与生成目录后命中 84 个显式名称。

### 6.1 示例配置

`.env.example` 的 13 项：

```text
ASTERIA_ALLOW_UNSANDBOXED_CODEX_RUNTIME
ASTERIA_CODEX_RUNTIME_ENABLED
ASTERIA_CODEX_SEARCH_ENABLED
ASTERIA_CODEX_TIMEOUT_SEC
ASTERIA_CODEX_USE_LOGIN_AUTH
ASTERIA_CORS_ALLOW_ORIGINS
ASTERIA_ENABLE_CODEX_RUNTIME_API
ASTERIA_ENABLE_LOCAL_SKILL_INSTALLER
NEXT_PUBLIC_API_BASE_URL
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_REASONING_EFFORT
```

### 6.2 全部静态名称

```text
ALLOW_REAL_PDF_FALLBACK
APPDATA
ASTERIA_ALLOW_UNSANDBOXED_CODEX_RUNTIME
ASTERIA_ANALYSIS_LAB_AGENT_REVIEW_ASYNC_ENABLED
ASTERIA_ANALYSIS_LAB_AGENT_REVIEW_WAIT_SEC
ASTERIA_ANALYSIS_LAB_ASYNC_CODEX_TASK_ENABLED
ASTERIA_ANALYSIS_LAB_PDCA_ENABLED
ASTERIA_ANALYSIS_LAB_PDCA_INTERVAL_SEC
ASTERIA_ANALYSIS_LAB_PDCA_LARGE_SAMPLE_THRESHOLD
ASTERIA_ANALYSIS_LAB_PDCA_MAX_DATASETS
ASTERIA_ANALYSIS_LAB_PDCA_MAX_JSON_READ_BYTES
ASTERIA_ANALYSIS_LAB_PDCA_MAX_REPORTS
ASTERIA_ANALYSIS_LAB_PDCA_SCAN_BUDGET_SEC
ASTERIA_ANALYSIS_LAB_SYNC_CODEX_ENABLED
ASTERIA_ANALYSIS_LAB_SYNC_CODEX_TIMEOUT_SEC
ASTERIA_AUTO_ANALYSIS_LEARNED_METHODS_PATH
ASTERIA_AUTO_ANALYSIS_SPEC_PATH
ASTERIA_CODEX_CLI_PATH
ASTERIA_CODEX_RUNTIME_ENABLED
ASTERIA_CODEX_SEARCH_ENABLED
ASTERIA_CODEX_TIMEOUT_SEC
ASTERIA_CODEX_USE_LOGIN_AUTH
ASTERIA_CODEX_WORKSPACE_ROOT
ASTERIA_CORS_ALLOW_ORIGIN_REGEX
ASTERIA_CORS_ALLOW_ORIGINS
ASTERIA_DATA_DIR
ASTERIA_DISABLE_TOOL_ASSETS
ASTERIA_ECOMMERCE_LONG_CLI_PIPELINE_ENABLED
ASTERIA_EDGE_EXECUTABLE
ASTERIA_ENABLE_CODEX_RUNTIME_API
ASTERIA_ENABLE_INTERACTIVE_TOOL_ASSETS
ASTERIA_ENABLE_LOCAL_SKILL_INSTALLER
ASTERIA_GENERIC_LONG_CLI_PIPELINE_ENABLED
ASTERIA_GENERIC_LONG_CLI_STAGE_AUTO_RETRIES
ASTERIA_HISTORICAL_STYLE_HTML_RENDER_MODE
ASTERIA_HOST
ASTERIA_INTERNET_OPS_CLAIM_AUDIT_CLI_ENABLED
ASTERIA_INTERNET_OPS_HTML_CLI_ENABLED
ASTERIA_INTERNET_OPS_LONG_CLI_PIPELINE_ENABLED
ASTERIA_INTERNET_OPS_METRIC_CHART_PLAN_CLI_ENABLED
ASTERIA_INTERNET_OPS_REVIEW_CLI_ENABLED
ASTERIA_INTERNET_OPS_SECTION_CLI_ENABLED
ASTERIA_JUDGE_EFFORT
ASTERIA_LAB_EXTERNAL_SKILLS_DIR
ASTERIA_LAB_REPORT_AGENT_TEAMS_DIR
ASTERIA_LAUNCH_PATH
ASTERIA_MAX_ACTIVE_REPORT_TASKS
ASTERIA_MULTI_TABLE_GENERIC_LONG_CLI_PIPELINE_ENABLED
ASTERIA_OPEN_BROWSER
ASTERIA_PORT
ASTERIA_PROCUREMENT_LONG_CLI_PIPELINE_ENABLED
ASTERIA_PROJECT_ROOT
ASTERIA_REPORT_AGENT_NATIVE_CODEX_ENABLED
ASTERIA_REQUIREMENT_INTENT_TIMEOUT_SEC
ASTERIA_RSCRIPT_PATH
ASTERIA_RUNTIME_PYTHON
ASTERIA_SIMILARITY_CASE_LIMIT
ASTERIA_SIMILARITY_CASE_OFFSET
ASTERIA_SIMILARITY_GEN_BATCH
ASTERIA_SIMILARITY_GEN_EFFORT
ASTERIA_SIMILARITY_INCLUDE_UPLOADED
ASTERIA_SIMILARITY_JUDGE_BATCH
ASTERIA_SIMILARITY_JUDGE_EFFORT
ASTERIA_SIMILARITY_RESUME
ASTERIA_SIMILARITY_RUN_LABEL
ASTERIA_SIMILARITY_TARGET
BCG_HISTORICAL_PDF_PATH
BUILD_MODE
CODEX_HOME
CODEX_NEXT_DIST_DIR
CODEX_SKILLS_ROOT
EDGE_EXECUTABLE
GENERATE_FULL_TABLE_VERSION
HISTORICAL_STYLE_PDF_PATH
LOCALAPPDATA
NEXT_PUBLIC_API_BASE_URL
NEXT_PUBLIC_API_SAME_ORIGIN
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_REASONING_EFFORT
PYTEST_CURRENT_TEST
PYTHON
RUNNER_TEMP
```

证据按文件分布：

- `backend/app/main.py`：CORS 与 local skill installer。
- `backend/app/services/analysis_lab_pdca_service.py`：PDCA interval、预算与上限。
- `auto_analysis_service.py`：async/sync Codex review 和 timeout。
- `codex_runtime_*`：runtime 权限、pipeline feature flags、Edge/Python 路径。
- `path_service.py`：data path 与 Windows app-data roots。
- `report_service.py`/`report_task_service.py`：报告 pipeline 开关和 active task limit。
- `settings_service.py`：OpenAI/Codex/R 路径。
- `backend/run_desktop.py`：host/port/browser/path。
- `frontend/next.config.ts`、`frontend/src/lib/api.ts`：build mode、dist、API base/same-origin。
- `scripts/build_portable.ps1`、similarity/eval/regression scripts：portable 与实验参数。

## 7. hegel-salon 环境变量

本轮排除 `node_modules`、data、tmp 后命中 76 个显式名称。

```text
CLOUDFLARED_PATH
CODEX_HOME
HEGEL_AB_CONCURRENCY
HEGEL_AB_LOG_SAMPLE
HEGEL_AB_MODEL
HEGEL_AB_RETRY_FROM
HEGEL_AB_SOURCE
HEGEL_ADMIN_2FA_DISABLED
HEGEL_ADMIN_ACCOUNT
HEGEL_ADMIN_ACCOUNTS
HEGEL_ADMIN_ALLOWED_IPS
HEGEL_ADMIN_EMAIL
HEGEL_ADMIN_EMAILS
HEGEL_ADMIN_PASSWORD
HEGEL_ADMIN_REMOTE_ALLOWED
HEGEL_ALLOWED_ORIGINS
HEGEL_API_CONFIG_MASTER_KEY
HEGEL_API_URL
HEGEL_BOOTSTRAP_ADMIN_FORCE_SYNC
HEGEL_DEFENDER_SCAN_PATH
HEGEL_EDGE_PATH
HEGEL_ENABLE_AUTH
HEGEL_ENABLE_GENERATED_CHINESE
HEGEL_EVAL_CONCURRENCY
HEGEL_EVAL_LOG_SAMPLE
HEGEL_EVAL_MODEL
HEGEL_EVAL_RETRY_FROM
HEGEL_EVAL_SOURCE
HEGEL_FORCE_SECURE_COOKIES
HEGEL_FORMAL_STRESS_CONCURRENCY
HEGEL_FORMAL_STRESS_FAIL_FAST
HEGEL_FORMAL_STRESS_ITERATIONS
HEGEL_FORMAL_STRESS_LOG_SAMPLE
HEGEL_HIDE_DEV_CODES
HEGEL_HIST_STRESS_CONCURRENCY
HEGEL_HIST_STRESS_FAIL_FAST
HEGEL_HIST_STRESS_ITERATIONS
HEGEL_HIST_STRESS_LOG_SAMPLE
HEGEL_MAIL_FROM
HEGEL_MAIL_MODE
HEGEL_OPTIMIZER_CHAT_RETRIES
HEGEL_OPTIMIZER_CONCURRENCY
HEGEL_OPTIMIZER_ITERATIONS
HEGEL_OPTIMIZER_PROMPTS
HEGEL_OPTIMIZER_SALON_TIMEOUT_MS
HEGEL_OPTIMIZER_TARGET
HEGEL_OPTIMIZER_TIMEOUT_MS
HEGEL_PERSIST_USER_CONTENT
HEGEL_PUBLIC_BASE_URL
HEGEL_PUBLIC_CHAT_FAST_MODE
HEGEL_RETAIN_UPLOADS
HEGEL_SALON_API_URL
HEGEL_SALON_HTTP_RETRIES
HEGEL_SALON_TEST_LIMIT
HEGEL_SALON_TIMEOUT_MS
HEGEL_SESSION_TOKEN
HEGEL_SMTP_HOST
HEGEL_SMTP_PASS
HEGEL_SMTP_PORT
HEGEL_SMTP_SECURE
HEGEL_SMTP_USER
HEGEL_STYLE_PROFILE_ID
HEGEL_TLS_CERT_PATH
HEGEL_TLS_KEY_PATH
HEGEL_TRANSLATE_MAX_CHARS
HEGEL_TRANSLATE_MODEL
HEGEL_TRUST_PROXY
HEGEL_UNDERSTANDING_LIMIT
HEGEL_UPLOAD_SCAN_MODE
HEGEL_USER_ID
HEGEL_V4_AUTH
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_PROVIDER
PORT
```

### 7.1 证据分组

| 族                                        | 文件                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| auth/admin/cookie/origin                  | `src/auth.mjs`、`src/server.mjs`                                      |
| TLS/public/proxy/upload/content retention | `src/server.mjs`                                                      |
| AI provider                               | `src/codexConfig.mjs`、optimizer/eval scripts                         |
| SMTP                                      | `src/mailDelivery.mjs`、`render.yaml`                                 |
| evaluation/stress/optimizer               | `src/run*Evaluation.mjs`、`run*Stress.mjs`、`runQualityOptimizer.mjs` |
| corpus translation                        | `src/buildChineseGeneratedCorpus.mjs`、`src/hegelChinese.mjs`         |
| browser/Defender                          | `src/browserComputer.mjs`、`src/server.mjs`                           |
| Cloudflare                                | `deploy/cloudflared/*.ps1`、launcher controller                       |
| API config encryption                     | `src/userDatabase.mjs`                                                |

`render.yaml` 明确列出 `PORT`、auth/cookie/proxy/public origin、admin account/email/password、API config master key 和 SMTP 变量；其中若干值由平台同步或生成，本文只保留变量名。

## 8. Playground 环境变量

### 8.1 Feishu OpenAI Bot

Pydantic `Settings` 对应 12 个主要变量：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_VERIFICATION_TOKEN
FEISHU_ENCRYPT_KEY
FEISHU_BOT_NAME
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_BASE_URL
BOT_SYSTEM_PROMPT
DATABASE_PATH
REQUEST_TIMEOUT_SECONDS
LOG_LEVEL
```

- 证据：`app/config.py`、`.env.example`。
- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`OPENAI_API_KEY` 没有代码默认值；其余多项有默认或 optional 语义。
- `.env.example` 只包含占位内容，本轮未读取 `.env`。

### 8.2 Secondary Brightness Widget

- 未发现应用环境变量读取。
- 配置入口是 PowerShell 参数 `-PrintStatus`、`-SetPercent` 和固定的 current-user Run registry path。
- 证据：`SecondaryBrightnessWidget.ps1`、`EnableAutostart.ps1`、`DisableAutostart.ps1`。

### 8.3 Playground XHS Scraper

明确环境读取：

```text
OPENCLAW_GATEWAY_TOKEN
USERPROFILE
```

- `OPENCLAW_GATEWAY_TOKEN`：Relay 鉴权相关，证据 `scrape_xiaohongshu_search.py`、`enable_openclaw_relay.ps1` 及 bundle 副本。
- `USERPROFILE`：Windows 配置路径解析，证据 `enable_openclaw_relay.ps1`。
- Relay port/keyword/source/type 主要是脚本常量或 CLI 参数，不应改写成环境变量。

## 9. 外部微信源码环境变量

### 9.1 wechat-cli

```text
WECHAT_CLI_CONFIG
WECHAT_CLI_BINARY
APPDATA
HOME
SUDO_USER
```

- `WECHAT_CLI_CONFIG`：Click 全局 `--config` 的 env alias，证据 `wechat_cli/main.py`。
- `WECHAT_CLI_BINARY`：npm wrapper 的二进制覆盖路径，证据 `npm/wechat-cli/bin/wechat-cli.js`。
- `APPDATA`、`HOME`、`SUDO_USER`：跨平台状态/用户目录探测，证据 `wechat_cli/core/config.py` 与 macOS helper C source。
- CLI 自身未发现产品 TCP listener；它以 stdin/stdout 和本地文件工作。

### 9.2 wechat-decrypt

- 10 个 tracked Python 文件中未发现 `os.getenv`、`os.environ` 或等价环境读取。
- 运行配置来自 `config.json`，schema 示例位于 `config.example.json`；真实 ignored config 本轮未读取。
- Web port `5678` 是 `monitor_web.py` 的代码常量，非 `PORT` 环境覆盖。
- MCP 使用 stdio，未分配网络端口。

## 10. MDX prompt 仓环境变量

普通脚本明确读取：

```text
CODEX_HOME
FORCE_COLOR
```

- `CODEX_HOME` 决定 Codex 配置根；`FORCE_COLOR` 控制终端颜色。证据：`codex-instruct.py`。

Pages workflow 声明/使用：

```text
STAR_HISTORY_REPOSITORY
STAR_HISTORY_SOURCE_REF
STAR_HISTORY_SOURCE_DIR
STAR_HISTORY_SITE_DIR
STAR_HISTORY_PAGES_URL
STAR_HISTORY_BACKEND_URL
STAR_HISTORY_TOKEN_TEST_REPO
GITHUB_API_TOKEN
ENVPATH
GITHUB_OUTPUT
RUNNER_TEMP
```

证据：`.github/workflows/sync-star-history.yml`、`.github/scripts/render_star_history.py`、`build_pages_readme.py`。`GITHUB_API_TOKEN` 由 Actions secret 注入，本文未读取其值。

## 11. GPT Skill 聚合树环境变量

聚合根没有统一配置合同；以下是可直接定位到执行源码的名称：

```text
APPDATA
BURP_MCP_HOST
BURP_MCP_PORT
CLAUDE_MCP_CONFIG
CODEX_CONFIG_PATH
CODEX_HOME
IDADIR
LOCALAPPDATA
OS
PATH
PLANTUML_JAR
PLAYWRIGHT_BROWSERS_PATH
ProgramFiles
TEMP
USERPROFILE
```

| 名称/族                                            | 证据与事实                                             |
| -------------------------------------------------- | ------------------------------------------------------ |
| `BURP_MCP_HOST` / `BURP_MCP_PORT`                  | `burp-mcp-full/mcp-bridge.js`；默认 `127.0.0.1:9876`。 |
| `CODEX_HOME` / Windows profile roots               | `zzy-Codex-5.6/codex-instruct.py`。                    |
| `PLAYWRIGHT_BROWSERS_PATH`                         | `skills/browser-automation/scripts/setup.ps1`。        |
| `PLANTUML_JAR`                                     | `skills/diagram-generator/scripts/render_diagram.py`。 |
| `IDADIR` / `APPDATA` / `TEMP`                      | IDA PowerShell scripts。                               |
| `CLAUDE_MCP_CONFIG` / `CODEX_CONFIG_PATH` / `PATH` | `skills/scripts/lib/ToolDiscovery.ps1`。               |
| Windows ambient roots                              | APK/browser/bootstrap PowerShell scripts。             |

Kali/APK shell scripts还有参数化 shell 名称（如 `TARGET`、`PACKAGE`、`DEVICE_SERIAL`、`KEYSTORE`、`MCP_PORT`）；它们混合 CLI 参数、局部变量和可继承环境，本文不把局部 shell 变量计入应用环境合同。

## 12. 配置与敏感性分级

| 类别         | 示例                                                           | 文档使用规则                             |
| ------------ | -------------------------------------------------------------- | ---------------------------------------- |
| 普通运行配置 | host、port、timeout、concurrency、path                         | 可讲默认值，同时说明来源和覆盖顺序。     |
| 凭据名称     | API key、SMTP pass、OAuth secret、gateway token、session token | 只记录变量名与用途。                     |
| 身份初始化   | admin/user email/password、auth replace                        | 属于 provisioning 输入，与履历数字分开。 |
| 测试夹具     | `MOCK_*`、`DEMO_*`、`COPILOT_*`、`PLAYWRIGHT_*`                | 与生产配置分栏。                         |
| CI 平台变量  | `RUNNER_TEMP`、`GITHUB_OUTPUT`                                 | GitHub Actions 运行时提供。              |
| 系统 ambient | `HOME`、`USERPROFILE`、`APPDATA`、`PATH`                       | 路径探测依赖，不是业务 secret。          |

## 13. 面试可复述结论

1. 主 XHS 的配置面最宽：应用、Relay、AI/OCR、SMTP、auth、MCP、Copilot、Codex device/connector 和测试/发布都有独立参数族。
2. today portable 与主 XHS 共享大部分基础配置，但缺当前工作树新增的 MCP/Codex connector 全量合同。
3. KOLFORGE 的 `.env.example` 很丰富，但 config-only 变量与 `8787/8798` 双端口口径说明文档同步仍是治理点。
4. Asteria 把分析实验开关、Codex runtime、报告 pipeline、portable 和前端 API base 分层；Hegel 把 auth、SMTP、eval/optimizer、TLS 和公网部署分层。
5. 外部微信两仓形态不同：wechat-cli 是无产品端口的 CLI；wechat-decrypt 另有固定 `0.0.0.0:5678` Web/SSE 服务。
6. 环境变量数量是配置复杂度事实，不是质量或功能规模 KPI。

## 14. 关联证据

- [Manifest 与入口](./06_ALL_PROJECT_MANIFESTS_ENTRYPOINTS.md)
- [命令与直接依赖](./07_ALL_PROJECT_COMMANDS_DEPENDENCIES.md)
- [跨项目技术矩阵](./03_CROSS_PROJECT_TECH_MATRIX.md)
- [事实冲突登记](./04_FACT_SOURCE_CONFLICTS.md)
- [主仓库运行默认值](../main/06_RUNTIME_DEFAULTS_LIMITS.md)
- [KOLFORGE 完整事实](../local/KOLFORGE_FACTS.md)
- [portable 完整事实](../local/PORTABLE_FACTS.md)
