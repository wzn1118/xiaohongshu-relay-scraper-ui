# wechat-decrypt 外部源码事实档案

> 面试定位：**外部源码研究对象**。它展示了 Windows 进程内存 key discovery、SQLCipher/WAL 解密、实时消息监视、图片恢复和 stdio MCP；当前代码默认把无认证 Web 监听绑定到全部网络接口，这是必须主动指出的安全边界。

## 1. Git 身份与快照

| 字段          | 事实                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| 本地路径      | [外部源码] `C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-decrypt-source`                       |
| 远程          | [当前代码事实] `origin = https://github.com/328336690/wechat-decrypt.git`                                 |
| 分支          | [当前代码事实] `main`                                                                                     |
| HEAD          | [当前代码事实] `44427c45786feba4e5fc21625f7934528a83f624`                                                 |
| HEAD 时间     | [当前代码事实] `2026-06-05T09:14:00+08:00`                                                                |
| 作者/主题     | [当前代码事实] `328336690` / `docs: add shields badges`                                                   |
| checkout 状态 | [当前代码事实] tracked tree clean；存在 ignored `config.json` 与 `__pycache__`。                          |
| 隐私处理      | [当前代码事实] 本轮没有读取 ignored `config.json`，因此没有接触本机数据库路径、key 文件路径或 image key。 |
| 历史可见性    | [当前代码事实] shallow clone；本地可见 1 个提交；0 个 tag。                                               |
| License       | [当前代码事实] MIT。                                                                                      |

## 2. 仓库规模与文件角色

| 指标         | 本轮静态结果                                                              |
| ------------ | ------------------------------------------------------------------------- |
| tracked 文件 | [当前代码事实] 19                                                         |
| Python 文件  | [当前代码事实] 10 个，约 3,134 行。                                       |
| Markdown     | [当前代码事实] 4 个。                                                     |
| 函数/类      | [当前代码事实] 静态发现约 74 个函数、9 个类。                             |
| 测试         | [当前代码事实] 只有 `latency_test.py` 诊断脚本，未发现单元/集成测试套件。 |
| CI           | [当前代码事实] 1 个 GitHub Actions workflow，只执行 lint。                |

| 文件                        | 当前代码责任                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| `config.py`                 | [当前代码事实] 加载 `config.json`、解析相对路径。                  |
| `find_all_keys.py`          | [当前代码事实] Windows 进程内存扫描并验证数据库 key。              |
| `decrypt_db.py`             | [当前代码事实] 批量 SQLCipher 数据库解密。                         |
| `monitor.py`                | [当前代码事实] 约每 3 秒轮询的命令行消息监视。                     |
| `monitor_web.py`            | [当前代码事实] 30ms mtime 轮询、WAL patch、Web UI、SSE、图片服务。 |
| `mcp_server.py`             | [当前代码事实] FastMCP stdio 查询服务。                            |
| `decode_image.py`           | [当前代码事实] 旧 XOR、V1、V2 三种 `.dat` 图片恢复。               |
| `find_image_key.py`         | [当前代码事实] 单次图片 AES key 扫描。                             |
| `find_image_key_monitor.py` | [当前代码事实] 持续图片 key 监控。                                 |
| `latency_test.py`           | [当前代码事实] 延迟诊断，不是断言式回归测试。                      |

## 3. 依赖、配置与入口

### 3.1 requirements

| 依赖         | 当前约束    | 代码用途                                                                        |
| ------------ | ----------- | ------------------------------------------------------------------------------- |
| PyCryptodome | `>=3.20.0`  | [当前代码事实] AES/HMAC/KDF 解密。                                              |
| psutil       | `>=5.9.0`   | [当前代码事实] 进程发现/系统信息。                                              |
| mcp          | `>=1.0.0`   | [当前代码事实] FastMCP stdio。                                                  |
| FastAPI      | `>=0.100.0` | [当前代码事实] requirements 声明；当前 Web monitor 实际使用标准库 HTTP server。 |
| uvicorn      | `>=0.24.0`  | [当前代码事实] requirements 声明；当前主 Web monitor 未用其启动。               |
| aiohttp      | `>=3.9.0`   | [当前代码事实] requirements 声明。                                              |

- [当前代码事实] `mcp_server.py` 导入 `zstandard`，但当前 `requirements.txt` 没有声明该包。
- [当前代码事实] README 的最短安装示例只安装 PyCryptodome；完整 MCP 运行还依赖 `mcp`、`zstandard` 等。
- [当前代码事实] 这是依赖清单漂移：clean 环境按 requirements 安装后，MCP import 仍可能因缺少 `zstandard` 失败。
- [未验证] 本轮没有创建全新 venv 验证 resolver 和启动行为。

### 3.2 配置 schema

```json
{
  "db_dir": "WINDOWS_WECHAT_DB_STORAGE",
  "keys_file": "all_keys.json",
  "decrypted_dir": "decrypted",
  "wechat_process": "Weixin.exe"
}
```

- [当前代码事实] 上面是 `config.example.json` 的字段结构，示例中的真实用户路径已替换为占位符。
- [当前代码事实] 图片流程还会使用 `decoded_image_dir` 和 `image_aes_key` 等可选配置。
- [当前代码事实] 相对的 keys/decrypted/decoded path 以仓库脚本目录为基准。
- [当前代码事实] key、解密数据库、图片目录和本地 config 都在 `.gitignore` 保护范围内。

### 3.3 可复述入口

```text
python find_all_keys.py
python decrypt_db.py
python monitor.py
python monitor_web.py
python mcp_server.py
python find_image_key.py
python find_image_key_monitor.py
python latency_test.py
```

- [外部源码] 这些命令是上游工具入口，仅作为架构研究事实；不应在面试中说成个人设计或发布。

## 4. 密钥发现与数据库解密

### 4.1 README 设计声明

- [README 声明] WeChat 4.0 使用 SQLCipher 4、AES-256-CBC + HMAC-SHA512、PBKDF2-HMAC-SHA512 256,000 iterations、4096-byte page、80-byte reserve。
- [README 声明] WCDB 在进程内存保存已派生 raw key；脚本扫描固定表示并用数据库 salt/HMAC 验证。
- [README 声明] 一次运行可识别/解密约 26 个数据库，包括 session、message、contact、media、favorite、sns 等。

### 4.2 当前代码证据

- [当前代码事实] `decrypt_db.py` 常量为 page 4096、key 32、salt 16、reserve 80，第一页恢复 `SQLite format 3\0` header。
- [当前代码事实] 数据区使用 AES CBC；每页 IV 位于 reserve 区前 16 bytes。
- [当前代码事实] `derive_mac_key` 和第一页 HMAC 校验用于识别正确 key；它不是只按十六进制模式接受候选。
- [当前代码事实] WAL 解密验证 WAL/frame salt，跳过旧周期或异常 frame，再按 page number patch 到目标 SQLite 文件。
- [当前代码事实] `find_all_keys.py` 面向 Windows 进程内存，需要访问 `Weixin.exe`；README 要求管理员权限。
- [未验证] PBKDF2 256,000 iterations 是 README 对 WeChat/WCDB 的说明；当前解密脚本接收内存中已派生 enc key，本轮没有独立复现完整 KDF。
- [未验证] “约 26 个数据库”与性能数字依赖真实账号/版本；本轮没有数据样本。

## 5. 实时监视数据流

```text
session.db + session.db-wal
  -> 30ms mtime 轮询
  -> 解密 DB + 校验并 patch WAL frame
  -> 对比上一轮消息状态
  -> 联系人/消息类型/图片解析
  -> messages_log
  -> GET /api/history + GET /stream (SSE)
  -> browser UI
```

- [当前代码事实] `monitor_web.py` 用后台线程做监视，标准库 `ThreadingMixIn + HTTPServer` 提供 UI/API。
- [当前代码事实] `MonitorDBCache` 把解密副本写入 `decrypted_dir/_monitor_cache`，并以 DB/WAL mtime 复用。
- [当前代码事实] 后台 warmup `message_resource.db`，为图片定位/解码准备索引。
- [当前代码事实] SSE 为每个客户端维护 queue；空闲约 15 秒发送 heartbeat；断开时移除 queue。
- [当前代码事实] CLI `monitor.py` 是更低频的约 3 秒轮询路径。
- [README 声明] Web 路径总体延迟约 100ms，包含 30ms 轮询和约 70ms 解密/patch。
- [未验证] 本轮没有测量延迟；该数字受 DB 大小、磁盘、WAL 活跃度和硬件影响。

## 6. Web 路由与暴露面

| Method | Path              | 当前行为                                                            |
| ------ | ----------------- | ------------------------------------------------------------------- |
| GET    | `/`               | [当前代码事实] 内联 Web UI。                                        |
| GET    | `/index.html`     | [当前代码事实] 与根页面相同。                                       |
| GET    | `/api/history`    | [当前代码事实] 返回内存中的全部已记录消息 JSON，按 timestamp 排序。 |
| GET    | `/stream`         | [当前代码事实] SSE 实时消息流。                                     |
| GET    | `/img/{filename}` | [当前代码事实] 返回 decoded image，扩展名映射 MIME，cache 1 天。    |

- [当前代码事实] 图片 route 拒绝 `/`、反斜杠与 `..`，并要求目标是 `DECODED_IMAGE_DIR` 中的普通文件。
- [当前代码事实] server 绑定 `('0.0.0.0', 5678)`，不是 `127.0.0.1`。
- [当前代码事实] 路由没有登录、token、CSRF 或 origin 检查。
- [README 声明] 文档只引导用户打开 `http://localhost:5678`，容易让读者误以为监听仅限本机。
- [当前代码事实] 实际上同网卡可达主机都可能访问历史消息、实时流和解码图片，具体取决于 Windows Firewall/网络路由。
- [当前代码事实] 这是当前仓库最直接的部署风险：启动 Web monitor 会把本地聊天内容暴露到所有监听接口的无认证 HTTP 服务。

## 7. MCP 工具与文档漂移

- [当前代码事实] MCP 使用 `FastMCP` 的 stdio transport，不在网络端口监听。
- [当前代码事实] 解密 DB 使用 `tempfile.mkstemp`，DB/WAL mtime 变化时删除旧临时文件并重建；`atexit` 清理当前 cache 中的临时 DB。
- [当前代码事实] 当前 `mcp_server.py` 注册 **7 个**工具：

| Tool                                    | 当前代码用途                              |
| --------------------------------------- | ----------------------------------------- |
| `get_recent_sessions(limit=20)`         | [当前代码事实] 最近会话、摘要和未读信息。 |
| `get_chat_history(chat_name, limit=50)` | [当前代码事实] 按联系人/群名解析历史。    |
| `search_messages(keyword, limit=20)`    | [当前代码事实] 跨消息库搜索。             |
| `get_contacts(query="", limit=50)`      | [当前代码事实] 联系人搜索/列表。          |
| `get_new_messages()`                    | [当前代码事实] 自上次调用以来的增量消息。 |
| `decode_image(chat_name, local_id)`     | [当前代码事实] 定位消息图片并解码。       |
| `get_chat_images(chat_name, limit=20)`  | [当前代码事实] 返回会话近期图片信息。     |

- [README 声明] README 和 CHANGELOG 仍写 5 个 MCP tools，只列前五项。
- [当前代码事实] 当前代码比文档多 `decode_image`、`get_chat_images` 两项；这是明确的文档漂移。
- [当前代码事实] stdio 本身缩小网络暴露面，但 MCP host 能读取聊天内容和解码图片，因此 host 的授权、日志和 prompt 数据边界仍然重要。

## 8. 图片格式

| 格式   | README/代码信息                                      | key 来源                       |
| ------ | ---------------------------------------------------- | ------------------------------ |
| 旧 XOR | [当前代码事实] 单字节 XOR，通过已知图片 magic 推导。 | 文件内容推导。                 |
| V1     | [当前代码事实] 固定 signature，AES-ECB + XOR。       | 固定 key 路径。                |
| V2     | [当前代码事实] AES-128-ECB + raw + XOR 分段。        | 从进程内存提取 image AES key。 |

- [README 声明] V2 用于 2025-08 以后的格式；文件头包括 6-byte signature、AES size、XOR size 和 padding 信息。
- [当前代码事实] 图片 key finder 会在图片打开时扫描进程内存，并可把 key 写入本地 `config.json`。
- [未验证] 本轮没有使用图片样本验证三种解码器，也没有确认版本日期边界。

## 9. CI、发布与验证事实

- [当前代码事实] `.github/workflows/ci.yml` 在 `main` push/PR 上运行。
- [当前代码事实] runner 是 `windows-latest`，Python 3.11；安装 requirements、ruff，再执行 `ruff check . --select=E,F,W --ignore=E501`。
- [当前代码事实] CI 没有 unit test、integration test、fixture DB、MCP smoke 或 Web security test。
- [历史快照] CHANGELOG 标为 `1.0.0`、日期 `2026-06-05`，描述 26 DB、约 100ms、5 MCP tools 和多格式图片。
- [当前代码事实] 本地 Git 没有可见 tag，且 checkout shallow；仅凭本地信息尚不足以确认 1.0.0 release 是否对应 tag/asset。
- [当前代码事实] 本轮对 10 个 tracked Python 文件做过语法编译，编译成功；这只证明解释器能解析当前源文件，不证明依赖、运行权限、业务结果或跨版本兼容。

## 10. 风险与工程债

| 优先级 | 事实                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 高     | [当前代码事实] Web monitor `0.0.0.0:5678`、无认证，暴露 history、SSE 和 decoded image。  |
| 高     | [当前代码事实] 工具处理 key、明文数据库、聊天和图片；本地目录 ACL 与清理策略是核心边界。 |
| 中     | [当前代码事实] requirements 缺 `zstandard`，而 MCP 启动直接 import。                     |
| 中     | [当前代码事实] README/CHANGELOG 写 5 tools，代码实际 7 tools。                           |
| 中     | [当前代码事实] CI 只有 lint；缺少数据库 fixture、解密向量和路由测试。                    |
| 中     | [当前代码事实] 管理员级进程内存读取扩大误用和系统风险。                                  |
| 低至中 | [README 声明] 延迟、数据库数量和版本兼容性都缺当前 checkout 的可复现 benchmark。         |

## 11. 面试追问与准确答法

### Q1：为什么 WAL 不宜只看文件大小？

[外部源码] README 说明 WeChat WAL 可能预分配为固定大小，所以写入时 size 不变。代码改用 mtime 感知变化，并校验 WAL header/frame salt 来跳过旧周期 frame。

### Q2：Web monitor 与 MCP 哪个边界更强？

[当前代码事实] MCP 使用 stdio，只暴露给启动它的 host；Web monitor 直接绑定全部接口且无认证。两者都能访问敏感内容，但网络攻击面完全不同。

### Q3：文档和代码不一致怎样发现？

[当前代码事实] 直接按 `@mcp.tool()` 统计得到 7 个注册工具，再与 README/CHANGELOG 的 5 项表逐项比对；另外按 imports 与 requirements 比对发现 `zstandard` 漏项。

### Q4：最先修哪个问题？

[当前代码事实] 先把默认 bind 改为 loopback，并在显式共享模式加入鉴权、访问日志、TLS/反向代理约束和最小数据范围；然后补 requirements 与可复现解密/MCP/Web 测试。

## 12. 一句话边界

> [外部源码] wechat-decrypt 把 Windows key discovery、SQLCipher/WAL 解密、实时 SSE 和 MCP 串成了完整样本；[当前代码事实] 当前 Web server 的 `0.0.0.0:5678` 无认证、MCP 依赖漏项和工具数量文档漂移是明确缺口；[未验证] 性能、26 个数据库与版本兼容性仍是上游声明。
