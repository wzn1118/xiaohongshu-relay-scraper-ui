# GPT5.6 聚合源码树外部事实档案

> 面试定位：**外部源码聚合与安全研究资料审计对象**。它不是一个单体应用，而是 Codex instruction 部署脚本、逆向/安全 skills、CTF 路由技能、Burp MCP 扩展和第三方知识库的组合。可以讲供应链、路由、许可证和信任边界，不应表述为个人原创工程。

## 1. Git 身份与工作树状态

| 字段          | 事实                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| 本地路径      | [外部源码] `C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/source` |
| 远程          | [当前代码事实] `origin = https://github.com/zxr-roro/GPT5.6-5.5-.git`                             |
| fetch filter  | [当前代码事实] remote 显示 `[blob:none]`，这是 partial clone/blob filtering 线索。                |
| 分支          | [当前代码事实] `main`                                                                             |
| HEAD          | [当前代码事实] `b18ceb0322d86480df049147e451cfbea5070e20`                                         |
| HEAD 时间     | [当前代码事实] `2026-07-11T02:56:31+08:00`                                                        |
| 作者/主题     | [当前代码事实] `张钊炀-666` / `Keep only zzy-codex5.6 project`                                    |
| 历史          | [当前代码事实] 非 shallow；本地可见 3 个提交；0 个 tag。                                          |
| checkout 状态 | [当前代码事实] **dirty**。存在 1 个 tracked 删除和 1 个 untracked `__pycache__` 目录。            |

### 1.1 当前可见提交

| Commit                                     | 时间                                   | 作者       | 主题                                   |
| ------------------------------------------ | -------------------------------------- | ---------- | -------------------------------------- |
| `b18ceb0322d86480df049147e451cfbea5070e20` | [历史快照] `2026-07-11T02:56:31+08:00` | 张钊炀-666 | `Keep only zzy-codex5.6 project`       |
| `44cd3a494ecd71132a0917971560217ae3ac72ee` | [历史快照] `2026-07-11T02:45:19+08:00` | 张钊炀-666 | `Remove obsolete nested project files` |
| `bdcdeb8e06754b0f21943aadc7afb474a0c19402` | [历史快照] `2026-07-11T00:34:48+08:00` | 王鹤凝666  | `Initial public release`               |

### 1.2 Dirty tree 证据

- [当前代码事实] tracked 删除：`zzy-codex5.6/zzy-reverse-skill/skills/pentest-tools/src-hunter/references/payloader/waf-bypass.md`。
- [当前代码事实] `git diff --numstat` 显示该删除为 `0 additions / 6501 deletions`。
- [当前代码事实] untracked：`zzy-codex5.6/zzy-Codex-5.6/__pycache__/`。
- [当前代码事实] 本轮没有恢复、删除、暂存或修改这些既有状态，也不把它们归因于任何个人。
- [当前代码事实] 因 tracked 文件缺失，当前物理工作树不是 HEAD 的完整内容；基于文件系统的内容审计要带这个限制。

## 2. 仓库规模

| 指标             | 本轮静态结果                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Git tracked 文件 | [当前代码事实] 438。                                                                                                |
| Markdown         | [当前代码事实] 341。                                                                                                |
| YAML             | [当前代码事实] 42 个 `.yaml` + 1 个 `.yml`。                                                                        |
| PowerShell       | [当前代码事实] 12 个 `.ps1`。                                                                                       |
| Shell            | [当前代码事实] 12 个 `.sh`。                                                                                        |
| Python           | [当前代码事实] 4 个 `.py`。                                                                                         |
| Java             | [当前代码事实] 2 个 `.java`。                                                                                       |
| JSON             | [当前代码事实] 7 个。                                                                                               |
| Gradle           | [当前代码事实] 2 个。                                                                                               |
| SKILL entrypoint | [当前代码事实] 物理工作树中 63 个 `SKILL.md`。                                                                      |
| CTF specialist   | [当前代码事实] 40 个 `competition-*` skill 目录；加主 orchestrator 共 41 个 CTF entrypoint。                        |
| 其他 skill       | [当前代码事实] 22 个非 competition `SKILL.md` entrypoint。                                                          |
| 可执行/脚本代码  | [当前代码事实] 约 34 个 Python/Node/PowerShell/Bash/Java/Gradle 代码文件，约 7,546 行；主要内容仍是 Markdown/YAML。 |

## 3. 顶层逻辑组件

| 组件                               | 角色                                                                        | 证据边界                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `zzy-Codex-5.6`                    | [外部源码] `codex-instruct.py`、instruction examples、README、MIT license。 | 配置部署工具，不是模型本体。                                                             |
| `zzy-reverse-skill`                | [外部源码] skills 路由、参考资料、bootstrap、field journal、工具索引。      | 文档/编排为主，来源和质量需逐组件核查。                                                  |
| `CTF-Sandbox-Orchestrator`         | [外部源码] 主路由 + 40 个 competition specialists。                         | 各 specialist 的 YAML 默认 `allow_implicit_invocation: false`；主 orchestrator 为 true。 |
| `burp-mcp-full`                    | [外部源码] Java 21 Burp extension、NanoHTTPD bridge、Node MCP bridge。      | loopback 强控制面；没有应用级认证。                                                      |
| `src-hunter`                       | [外部源码] 大量方法论、行业、字典和工具参考。                               | 该子树有独立 MIT license；当前又缺 1 个 tracked 大文件。                                 |
| `game-hacking-techniques-SKILL.md` | [外部源码] 独立长篇技能文档。                                               | 高风险双用途领域，仅作为资料分类事实。                                                   |
| `DISCLAIMER免责声明.txt`           | [README 声明] 安全研究/授权范围声明。                                       | 声明不替代运行时隔离与审计。                                                             |

## 4. Skills 路由树

### 4.1 `zzy-reverse-skill/skills` 顶层目录（22 个）

[当前代码事实] 当前目录名如下：

1. `api-security`
2. `apk-reverse`
3. `attack-chain`
4. `binary-diff`
5. `browser-automation`
6. `diagram-generator`
7. `docs-generator`
8. `edr-bypass-re`
9. `field-journal`
10. `firmware-pentest`
11. `ida-reverse`
12. `js-reverse`
13. `llm-security`
14. `malware-analysis`
15. `mobile-reverse`
16. `patch-diff-exploit`
17. `pentest-tools`
18. `pwn-chain`
19. `radare2`
20. `reverse-engineering`
21. `scripts`
22. `supply-chain-security`

- [当前代码事实] 这些目录中有 entrypoint、references、scripts、templates 或嵌套第三方子树，目录存在不等于每项都有可执行实现。
- [README 声明] `routing.md`/`routing_zh.md` 按任务特征选择 specialist，任务后可生成文档/图、写入 field journal 并更新索引。
- [当前代码事实] Windows 和 Kali 分别有 PowerShell/Bash bootstrap 与 manifest；可检查工具是否存在并提供安装/发现路径。
- [未验证] 本轮没有执行 bootstrap，也没有联网确认第三方工具版本、下载地址和 hash。

### 4.2 CTF Orchestrator

- [当前代码事实] 1 个 `ctf-sandbox-orchestrator/SKILL.md` 作为主入口，40 个 `competition-*` 子技能形成场景路由。
- [当前代码事实] 子技能覆盖 Web runtime、身份、移动端、协议、取证、逆向、供应链、容器/云、队列/竞态等类别。
- [当前代码事实] 每个 competition skill 通常带 `SKILL.md`、`agents/openai.yaml`，部分带独立 `references/*.md`。
- [当前代码事实] 子技能 YAML 的 `policy.allow_implicit_invocation` 通常为 `false`；主 orchestrator 是 `true`，体现“先进入总路由，再显式分流”的控制意图。
- [当前代码事实] 这些文件是 prompt/工作流资产，不是 40 套独立运行服务或 40 组自动测试。

## 5. Codex instruction 部署组件

- [当前代码事实] `zzy-Codex-5.6/codex-instruct.py` 通过 `model_instructions_file` 修改用户 Codex 配置。
- [当前代码事实] 提供 `--file`、`--name`、`--dry-run`、`--codex-dir` 等参数；README 说明 Python 3.8+。
- [当前代码事实] 组件有 MIT license，版权人为 `li lingbo`。
- [外部源码] instruction 内容旨在显著改变 Agent 行为；本档案不复述其操作性 prompt。
- [当前代码事实] 修改的是用户配置，模型二进制保持原样，也不是网络代理；配置副作用仍需要备份、diff 与回滚验证。
- [当前代码事实] 当前工作树含 untracked bytecode cache，说明本地脚本曾被解释器加载或编译；由此尚不足以推断运行参数与结果。
- [未验证] 本轮没有执行该部署脚本，也没有改变当前 Codex 配置。

## 6. Burp MCP Full Control

### 6.1 Build manifest

| 字段                 | 当前代码事实                                                        |
| -------------------- | ------------------------------------------------------------------- |
| Gradle group/version | `com.burpmcp` / `1.0.0`                                             |
| Java                 | source/target compatibility 21                                      |
| Burp API             | `net.portswigger.burp.extensions:montoya-api:2025.5`，`compileOnly` |
| JSON                 | `gson:2.11.0`                                                       |
| HTTP                 | `nanohttpd:2.3.1`                                                   |
| Artifact             | fat JAR `burp-mcp-full.jar`                                         |
| Entrypoint           | `BurpMcpExtension.initialize(MontoyaApi)`                           |

### 6.2 HTTP 表面与工具

- [当前代码事实] extension 初始化后启动 `McpHttpServer`，绑定 `127.0.0.1:9876`。
- [当前代码事实] `GET /health` 返回状态、版本和工具列表；`GET /tools` 返回工具列表；其他业务调用通过 root POST body 中的 `tool`/`params` 分发。
- [当前代码事实] Java dispatch 顶层有 **63 个** tool case；额外 `case` 来自 encode/decode/payload 子枚举，不应重复计为顶层 tools。
- [当前代码事实] 63 个工具域包括：proxy history/detail/WebSocket/listener/rules、HTTP request、Repeater、Intruder、sitemap/target、intercept、编码转换、scanner/crawl、scope、Collaborator、历史搜索/标注/比较、配置、upstream/DNS/HTTP2、cookie/token/sequencer/cert、WebSocket send、payload transform、project、issue、handler/rule、extensions 和 log。
- [当前代码事实] 能力面包含 read-only 和有副作用操作；当前 dispatch 没有结构化 risk/readOnly/destructive 元数据。
- [当前代码事实] server 只监听 loopback，但没有 token/session 认证；同机其他进程可以尝试访问 `9876`。
- [当前代码事实] CORS headers 进一步支持浏览器调用；loopback 并不等同于进程身份验证。
- [当前代码事实] README 功能表只展示一小部分工具，与代码 63 个顶层 case 不等量。

### 6.3 工程边界

- [当前代码事实] build 脚本支持 Windows batch 与 Unix shell；Gradle 输出 fat jar。
- [当前代码事实] `mcp-bridge.js` 可作为 stdio MCP 客户端与本地 HTTP extension 连接。
- [当前代码事实] 当前仓库未发现 Burp extension 单元/集成测试、mock Montoya API 或 permission prompt。
- [未验证] 本轮没有安装 Burp、Java 21/Gradle 依赖，也没有构建 JAR 或动态调用 63 个 tools。

## 7. CI 与贡献自动化

- [当前代码事实] 唯一 GitHub workflow 位于嵌套 `zzy-reverse-skill/.github/workflows/auto-merge-journal.yml`。
- [当前代码事实] 只在 `skills/field-journal/**` pull request opened/synchronize 时触发。
- [当前代码事实] 白名单要求改动仅是 field-journal 下 Markdown，并排除系统模板文件；单 PR 最多 5 个文件。
- [当前代码事实] workflow 扫描 instruction injection 特征、HTML/JS、可执行脚本特征、编码命令、疑似 secret、非示例公网 IP、文件大于 50KB、缺少 Markdown 一级标题、外部可执行文件 URL。
- [当前代码事实] 验证成功后用 `gh pr merge --auto --squash` 自动合并；失败时评论原因。
- [当前代码事实] 这是 field-journal 内容准入门，不构建 Burp JAR、不测试 63 skills、不校验 bootstrap 下载，也不扫描整个聚合树。
- [当前代码事实] workflow 通过正则做静态过滤；它能降低常见恶意文本风险，但不证明文档语义可信或没有混淆内容。

## 8. 许可证与来源边界

| 子组件                     | License/版权                       | 当前结论                       |
| -------------------------- | ---------------------------------- | ------------------------------ |
| `zzy-Codex-5.6`            | [当前代码事实] MIT / `li lingbo`   | 独立保留版权与许可。           |
| `zzy-reverse-skill`        | [当前代码事实] MIT / `zhaoxuya520` | 路由与主体 skills 的许可。     |
| `CTF-Sandbox-Orchestrator` | [当前代码事实] GPL-3.0             | copyleft 条件与 MIT 子树不同。 |
| `src-hunter`               | [当前代码事实] MIT / `MyuriKanao`  | 嵌套第三方子组件。             |

- [当前代码事实] 聚合仓库存在多作者、多许可证和嵌套来源，不宜用一个顶层“MIT”概括全部内容。
- [当前代码事实] GPL-3.0 组件与 MIT 组件并存时，分发衍生组合物需要逐边界分析，而不是只复制一个 LICENSE。
- [当前代码事实] 大量 Markdown 参考还可能引用第三方工具、文章与上游知识；文件存在不证明内容许可已逐项统一。
- [未验证] 本轮没有完成每一个引用 URL、图片、文档片段和嵌套来源的法律 provenance 审计。

## 9. 数据模型与配置模型

这个聚合树没有统一业务数据库；主要“数据模型”是声明式 skill/YAML/JSON 配置。

| 模型                 | 当前事实                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `SKILL.md`           | [当前代码事实] 入口元数据、触发条件、工作流、references/scripts 指针。                       |
| `agents/openai.yaml` | [当前代码事实] display name、short description、default prompt、implicit invocation policy。 |
| routing docs         | [当前代码事实] 将任务类型映射到 specialist。                                                 |
| bootstrap manifest   | [当前代码事实] 工具发现、安装类型、路径与验证信息。                                          |
| field journal        | [当前代码事实] 经验记录、索引、模板和贡献入口。                                              |
| Burp JSON request    | [当前代码事实] `{"tool": STRING, "params": OBJECT}`；返回 JSON。                             |
| Codex config         | [当前代码事实] `config.toml` 的 `model_instructions_file` 指向外部 instruction 文件。        |

## 10. 风险清单

| 优先级 | 事实                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 高     | [当前代码事实] 这是外部多来源、高权限安全工具聚合树；直接加载全部 skills 会扩大 prompt、脚本和工具供应链面。       |
| 高     | [当前代码事实] Burp MCP 暴露 63 个强能力工具，仅靠 loopback 隔离，没有调用者认证与逐操作 policy metadata。         |
| 高     | [当前代码事实] 当前 worktree 缺失 6,501 行 tracked reference，不宜作为干净 release 输入。                          |
| 中高   | [当前代码事实] instruction installer 修改用户级 Agent 行为配置，需要把外部 prompt 当作持续性代码执行等价配置审计。 |
| 中     | [当前代码事实] 63 个 SKILL entrypoint 主要是文档/YAML，缺少统一 schema validator、自动测试和全树 CI。              |
| 中     | [当前代码事实] 唯一 workflow 只审 field-journal，并带自动合并权限；它不覆盖其他内容。                              |
| 中     | [当前代码事实] MIT、GPL-3.0 和多个作者/第三方子树混合，发布要做组件级 NOTICE/license 清单。                        |
| 中     | [当前代码事实] partial clone `blob:none` 与 dirty tree让“本地现状”和“完整提交对象”需要分开解释。                   |
| 低至中 | [README 声明] 多平台 bootstrap 可自动安装工具；[未验证] 下载 hash、版本 pin、包签名和当前可用性未逐项检查。        |

## 11. 文档声明与代码验证对照

| 主题              | 声明                                   | 当前证据结论                                                                                     |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| skills 规模       | [README 声明] 大型逆向/CTF 路由包      | [当前代码事实] 63 个物理 `SKILL.md`，其中 41 个 CTF；规模成立，但不等于 63 个可执行程序。        |
| Burp Full Control | [README 声明] 覆盖 Burp 核心能力       | [当前代码事实] 63 个顶层 tool case；[未验证] 未动态调用。                                        |
| 多平台            | [README 声明] Windows/Kali/macOS 路径  | [当前代码事实] PowerShell/Bash/文档分支存在；[未验证] 未构建平台矩阵。                           |
| 自动进化          | [README 声明] task 后回写 journal/索引 | [当前代码事实] journal、模板和 auto-merge workflow 存在；[未验证] 没有证明所有运行都会正确沉淀。 |
| 安全过滤          | [README 声明] journal 自动审查         | [当前代码事实] 正则门与白名单存在；其范围只覆盖 journal PR。                                     |
| 当前完整性        | 无明确声明                             | [当前代码事实] worktree 有 tracked 删除，当前文件树不完整。                                      |

## 12. 面试追问与准确答法

### Q1：这个仓库到底是应用还是知识库？

[当前代码事实] 它是聚合包：大多数内容是 Markdown/YAML skills 与 references，少量可执行组件包括 Codex config 脚本、bootstrap、Burp Java extension 和 Node bridge。面试时应逐组件说，不用单一“应用”概括。

### Q2：为什么统计 `SKILL.md` 而不是目录数？

[当前代码事实] `SKILL.md` 是真实 entrypoint 信号；目录可能只是 references/scripts/templates。即便有 entrypoint，也只证明可被 Agent 路由，不证明业务代码、测试和运行环境齐全。

### Q3：Burp MCP 的 loopback 是否足够？

[当前代码事实] 它阻止远程网卡直接访问，但同机任意进程仍可调用；工具集又包含修改状态与发请求能力。更强设计需要随机 token、权限分级、scope、用户确认和审计日志。

### Q4：为什么 dirty tree 会影响面试结论？

[当前代码事实] 当前缺失一个 6,501 行 tracked 文件，任何“当前共有多少文档、是否完整、是否能重建”的判断都必须注明工作树状态；Git index 的 438 与物理文件数不是同一概念。

### Q5：对外部聚合库怎样做供应链审计？

[当前代码事实] 先按 remote/commit 固定 snapshot，再枚举 entrypoint、脚本、下载器、网络 listener、持久配置、许可证和 CI 覆盖；最后把 README claims 与可运行证据分开，并拒绝将来源不明内容自动加载到长期 Agent 配置。

## 13. 一句话边界

> [外部源码] 该 source tree 是 Codex 配置、63 个 skill entrypoint、40 个 competition specialist、Burp MCP 和第三方安全资料的聚合；[当前代码事实] 它存在 63-tool loopback 控制面、许可证混合、极窄 CI 覆盖和 6,501 行 tracked 删除；[未验证] 不宜把文档规模等同于工具全部可用或生产级质量。
