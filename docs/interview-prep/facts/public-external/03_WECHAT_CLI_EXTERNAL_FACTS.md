# wechat-cli 外部源码事实档案

> 面试定位：**外部源码研究对象**。可用于讲解跨平台密钥发现、SQLCipher 页级解密、只读查询 CLI 和本地状态安全评审；仓库及实现不应表述为个人原创交付。

证据标签：[当前代码事实]、[README 声明]、[历史快照]、[外部源码]、[未验证]；[历史快照] 只表示当前 shallow clone 可见的提交/文档时间点。

## 1. Git 身份、来源差异与快照

| 字段                       | 事实                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 本地路径                   | [外部源码] `C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-cli-new`                                                   |
| checkout remote            | [当前代码事实] `origin = https://github.com/huohuoer/wechat-cli.git`                                                           |
| manifest/README repository | [当前代码事实] npm manifest 指向 `https://github.com/freestylefly/wechat-cli`；文档也使用该项目身份。                          |
| 分支                       | [当前代码事实] `main`                                                                                                          |
| HEAD                       | [当前代码事实] `a3789232d4f79bf0b30634d9dadbce71e4acd601`                                                                      |
| HEAD 时间                  | [当前代码事实] `2026-04-06T09:52:02+08:00`                                                                                     |
| 作者/主题                  | [当前代码事实] `canghe` / `docs: add acknowledgement to wechat-decrypt`                                                        |
| checkout 状态              | [当前代码事实] tracked tree clean；存在 ignored `__pycache__`。                                                                |
| 历史可见性                 | [当前代码事实] shallow clone；本地只可见 1 个提交；0 个 tag。                                                                  |
| 所有权边界                 | [外部源码] remote 身份与包 manifest 指向的上游身份不同；面试中应说“审计了一个 fork/镜像快照”，不推断两者之间的法律或维护关系。 |

## 2. 规模与结构

| 指标         | 本轮静态结果                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| tracked 文件 | [当前代码事实] 51                                                               |
| Python 文件  | [当前代码事实] 31 个，约 3,015 行。                                             |
| Python 定义  | [当前代码事实] 约 100 个顶层函数/类定义。                                       |
| 测试         | [当前代码事实] 未发现 tracked 测试文件。                                        |
| CI           | [当前代码事实] 未发现 `.github/workflows`。                                     |
| License      | [当前代码事实] Apache-2.0。                                                     |
| 文档         | [当前代码事实] 英文 `README.md` 与中文 `README_CN.md`。                         |
| 平台资产     | [当前代码事实] macOS arm64 二进制、对应 C 源码，以及 5 个 npm 平台包 manifest。 |

### 2.1 Python 包模块

| 模块                  | 当前代码责任                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `wechat_cli/main.py`  | [当前代码事实] Click group、版本、全局配置、11 个子命令注册。                           |
| `commands/*`          | [当前代码事实] init、会话、历史、搜索、联系人、增量消息、成员、导出、统计、未读、收藏。 |
| `core/config.py`      | [当前代码事实] 跨平台数据目录探测与状态目录配置。                                       |
| `core/context.py`     | [当前代码事实] 组装 keys、DB cache、联系人和运行上下文。                                |
| `core/crypto.py`      | [当前代码事实] 数据页/WAL 解密。                                                        |
| `core/db_cache.py`    | [当前代码事实] 解密数据库持久缓存与 mtime 失效。                                        |
| `core/messages.py`    | [当前代码事实] 消息表选择、过滤、分页、解析、媒体定位和统计。                           |
| `core/contacts.py`    | [当前代码事实] 联系人、群成员、自身账户与显示名解析。                                   |
| `core/key_utils.py`   | [当前代码事实] key path 规范化和路径安全检查。                                          |
| `keys/scanner_*`      | [当前代码事实] Windows、Linux、macOS 进程内存扫描。                                     |
| `output/formatter.py` | [当前代码事实] JSON/text 输出抽象。                                                     |

## 3. Manifest、入口与发布包装

### 3.1 Python

- [当前代码事实] `pyproject.toml` 项目名 `wechat-cli`、版本 `0.2.4`、Python `>=3.10`。
- [当前代码事实] 依赖：`click>=8.1,<9`、`pycryptodome>=3.19,<4`、`zstandard>=0.22,<1`。
- [当前代码事实] console entry point：`wechat-cli = wechat_cli.main:cli`。
- [当前代码事实] `entry.py` 是 PyInstaller/独立二进制入口。
- [当前代码事实] Python package data 包含 `wechat_cli/bin/*`。

### 3.2 npm wrapper

- [当前代码事实] npm 包名 `@canghe_ai/wechat-cli`、版本 `0.2.4`、Node `>=14`、license Apache-2.0。
- [当前代码事实] `bin/wechat-cli.js` 暴露 `wechat-cli` 命令；`postinstall` 运行 `install.js`。
- [当前代码事实] `install.js` 认识 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win32-x64` 五个平台，并尝试给非 Windows 二进制设置 `0755`。
- [当前代码事实] 根 npm manifest 的 `optionalDependencies` 只声明 `@canghe_ai/wechat-cli-darwin-arm64`，虽然五个平台 package manifest 都在仓库中。
- [README 声明] npm 安装当前主要支持 macOS arm64，其余平台建议使用 pip；这与 optional dependency 的当前状态基本一致。
- [未验证] 本轮没有从 PyPI/npm 下载已发布包，也没有比较发布 tarball 与 Git checkout。

## 4. CLI 命令面

[当前代码事实] `wechat_cli/main.py` 注册 11 个 Click 子命令：

| Command          | 主要参数/输出                       | 代码事实用途                             |
| ---------------- | ----------------------------------- | ---------------------------------------- |
| `init`           | `--db-dir`、`--force`               | 初始化状态目录、探测数据目录、提取密钥。 |
| `sessions`       | `--limit`、`--format`               | 最近会话列表。                           |
| `history CHAT`   | limit/offset/time/type/media/format | 按会话读消息历史。                       |
| `search KEYWORD` | chat/time/limit/offset/type/format  | 指定会话或全局搜索。                     |
| `contacts`       | query/detail/limit/format           | 联系人搜索和详情。                       |
| `new-messages`   | format                              | 基于上次状态读取增量消息。               |
| `members GROUP`  | format                              | 群成员列表。                             |
| `export CHAT`    | format/output/time/limit            | 导出文本或 Markdown。                    |
| `stats CHAT`     | time/format                         | 会话统计。                               |
| `unread`         | limit/format                        | 未读信息。                               |
| `favorites`      | limit/type/query/format             | 收藏内容解析与过滤。                     |

- [当前代码事实] JSON 是主要机器输出格式；部分命令提供 text/Markdown 视图。
- [当前代码事实] 全局 `--config` 也可由 `WECHAT_CLI_CONFIG` 提供。
- [当前代码事实] `search` 对查询结果实施最大 500 条的分页限制；`history` 和 `export` 的显式语义允许不设最大结果数。
- [未验证] 命令帮助、真实数据库 schema 兼容性和各平台输出编码没有在本轮动态执行。

## 5. 数据路径与处理链

```text
自动探测 WeChat db_storage
  -> 扫描 WeChat/Weixin 进程内存
  -> 用数据库第一页验证候选 key
  -> 保存 ~/.wechat-cli/all_keys.json
  -> 按需解密 DB 与 WAL 到 OS temp/wechat_cli_cache
  -> 查询联系人/会话/消息/收藏
  -> JSON、text 或 Markdown 输出
```

### 5.1 状态目录

- [当前代码事实] 默认状态目录是 `~/.wechat-cli`。
- [当前代码事实] 默认文件/目录包括 `config.json`、`all_keys.json`、`decrypted`、`decoded_images`；增量消息还维护 `last_check` 类型状态。
- [当前代码事实] Windows 从 `%APPDATA%/Tencent/xwechat/config/*.ini` 解析候选数据根目录。
- [当前代码事实] Linux 检查 `~/Documents/xwechat_files`、sudo 用户 home 和旧路径 `~/.local/share/weixin/data/db_storage`。
- [当前代码事实] macOS 检查 `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`。
- [当前代码事实] 多候选且是交互终端时让用户选择；非交互环境直接取候选列表第一项。
- [当前代码事实] 配置中的相对路径以配置文件所在目录为基准转为绝对路径。

### 5.2 DB cache

- [当前代码事实] 解密缓存固定在系统临时目录 `wechat_cli_cache`。
- [当前代码事实] 缓存文件名由相对 DB path 的 MD5 前 12 位生成；`_mtimes.json` 保存 DB/WAL mtime 与缓存路径。
- [当前代码事实] DB 或 WAL mtime 变化时重新解密；未变化时跨进程复用明文缓存。
- [当前代码事实] `cleanup()` 只保存 cache metadata，没有删除已解密 DB。
- [当前代码事实] 当前实现未观察到对 `~/.wechat-cli` key 文件或 temp 明文 DB 的显式 chmod/ACL 加固。
- [当前代码事实] 明文缓存跨会话持久存在，便利了查询，但把 OS 临时目录权限和终端账户隔离变成安全前提。

## 6. 解密与 key discovery

- [当前代码事实] SQLCipher 页面大小 4096 bytes，reserve 80 bytes；数据区使用 AES-256-CBC。
- [当前代码事实] `full_decrypt` 逐页输出 SQLite 数据库；`decrypt_wal` 处理对应 WAL 数据。
- [当前代码事实] 候选 key 通过加密数据库第一页和 HMAC/页面结构进行交叉验证，而不是只靠内存模式命中。
- [当前代码事实] Windows scanner 使用 Win32 process/memory API 枚举 `Weixin.exe` 可读区域。
- [当前代码事实] Linux scanner 读取 `/proc/<pid>/mem`，需要 root 或 `CAP_SYS_PTRACE` 等权限，并检查目标进程身份。
- [当前代码事实] macOS scanner 查找 bundled helper；为获得调试权限，代码可保留原 entitlements 后重新签名 WeChat，并加入 `get-task-allow`。
- [当前代码事实] 仓库仅 tracked `find_all_keys_macos.arm64`；scanner 还预期 x86 名称，当前 checkout 没有对应 x86 二进制，但保留 C 源码。
- [当前代码事实] README 的“只读”主要指查询不会修改聊天数据库；`init` 的进程内存读取和 macOS 重新签名仍有操作系统/应用副作用。

## 7. 查询模型与防护点

- [当前代码事实] 消息表名只接受正则 `Msg_[0-9a-f]{32}`，降低动态表名注入风险。
- [当前代码事实] 时间、关键词、类型、limit/offset 等查询值使用参数化 SQL；表名在白名单后再插入 SQL。
- [当前代码事实] key metadata 中的相对路径先做 traversal 检查，再与数据目录拼接。
- [当前代码事实] XML 解析前限制约 20,000 字符，并拒绝 `DOCTYPE`/`ENTITY`，降低 XML 外部实体与超长内容风险。
- [当前代码事实] 消息解析覆盖文本、app 消息、通话等类型，并使用 Zstandard 解压部分内容。
- [当前代码事实] 媒体解析按年月和文件名线索查找；模糊匹配在目标月份可能返回第一个候选，存在错误关联风险。
- [当前代码事实] 联系人层把 username、remark、昵称、群成员和 self account 合并为显示名映射。

## 8. README 兼容性声明与验证边界

- [README 声明] macOS `>=26.3.1`、WeChat for Mac `<=4.1.8.100` 是当前兼容范围描述。
- [README 声明] Windows、Linux 也有扫描和查询支持。
- [当前代码事实] 三个平台 scanner 与路径探测模块存在；这证明实现分支存在，不证明所有 OS/WeChat 版本已通过。
- [未验证] 本轮没有对应版本矩阵、签名环境、数据库样本和进程权限，因此兼容性仍属于 README 声明。

## 9. 安全边界与风险清单

| 风险          | 静态证据                                                                              | 面试表述                                                     |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 明文 key      | [当前代码事实] `all_keys.json` 在用户状态目录中长期存在。                             | 权限依赖当前 OS 用户；应采用最小权限、加密存储或短生命周期。 |
| 明文 DB cache | [当前代码事实] temp cache 跨会话复用，cleanup 不删除。                                | 便捷性与本地取证暴露面之间的权衡。                           |
| macOS 重签名  | [当前代码事实] scanner 可修改应用签名并增加调试 entitlement。                         | “只读数据查询”不等于“对应用安装零改动”。                     |
| Linux 高权限  | [当前代码事实] `/proc/pid/mem` 需要 ptrace 能力/root。                                | 需要明确最小授权和执行上下文。                               |
| 非交互候选    | [当前代码事实] 多数据目录时自动取第一项。                                             | 自动化方便，但可能选择错误账户。                             |
| 媒体误配      | [当前代码事实] 模糊路径可退化到月份首个候选。                                         | 输出路径要标注置信度或继续做哈希/元数据校验。                |
| 平台包装      | [当前代码事实] installer 支持表有五个平台，根 optional dependency 只有 darwin-arm64。 | 发布元数据与代码能力存在落差。                               |
| 供应链        | [当前代码事实] 无 CI、无测试文件。                                                    | 当前仓库缺少自动质量门；应独立验证发布物。                   |

## 10. 文档声明与代码验证对照

| 主题     | 声明                                   | 当前证据结论                                                                                   |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 本地处理 | [README 声明] 本地查询、数据不上传     | [当前代码事实] 代码没有网络客户端依赖和远程 API 路径；[未验证] 未做运行时流量监控。            |
| 只读     | [README 声明] 只读访问 WeChat 数据     | [当前代码事实] 查询 DB 的业务路径只读；init/macos resign 有系统副作用。                        |
| 跨平台   | [README 声明] macOS/Windows/Linux      | [当前代码事实] 三套 scanner 与路径探测存在；[未验证] 没有当前版本矩阵测试。                    |
| LLM 友好 | [README 声明] CLI 面向模型调用         | [当前代码事实] 默认 JSON、确定性命令和参数化输出支持机器消费。                                 |
| npm 分发 | [README 声明] npm 当前聚焦 macOS arm64 | [当前代码事实] optional dependency 也只有 darwin-arm64；其他平台 manifest 尚未形成根包依赖链。 |

## 11. 面试追问与准确答法

### Q1：为什么按需解密并缓存，而不是每次全量解密？

[外部源码] 代码用 DB/WAL mtime 作为失效条件，减少重复解密开销；代价是明文 cache 的生命周期更长，必须把本地账户权限和清理策略纳入威胁模型。

### Q2：动态消息表怎样避免 SQL 注入？

[当前代码事实] 值参数继续使用 placeholder；唯一需要动态插入的表名必须满足固定的 `Msg_` + 32 位 hex 结构，先验证后使用。

### Q3：为什么 key 扫描后还要用 DB 第一页验证？

[外部源码] 进程内存中会有大量 32-byte 候选。用 SQLCipher 页结构/HMAC 交叉验证，可以把模式命中变成与具体数据库绑定的 key 证据。

### Q4：对这个仓库最重要的审计发现是什么？

[当前代码事实] “本地、只读”描述需要细分：查询层确实以读取为主，但 key、明文 cache、ptrace 权限和 macOS 重签名形成新的敏感面；同时当前 snapshot 没有测试/CI。

## 12. 一句话边界

> [外部源码] wechat-cli 是一个结构清晰的跨平台本地查询工具样本，展示了密钥发现、SQLCipher/WAL 解密、参数化查询和 JSON CLI 设计；[当前代码事实] 它也长期保存明文 key/DB cache，并在 macOS/Linux 依赖高权限操作；[未验证] 当前快照不构成全平台兼容性与发布质量证明。
