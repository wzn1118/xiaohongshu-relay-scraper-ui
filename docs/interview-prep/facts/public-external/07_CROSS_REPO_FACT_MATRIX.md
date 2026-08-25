# 公开与外部仓库横向事实矩阵

> 用途：面试前快速比较六个对象。表内每个数字都按当前本地 checkout 统计；shallow、partial clone、dirty tree、外部来源和未运行项均单独标记。

## 1. 身份与证据等级

| 对象                  | 证据身份                       | Remote                                                                    | HEAD      | 状态                                        |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| AsteriaAnalyst        | [当前代码事实] 公开原创仓库    | `wzn1118/AsteriaAnalyst`                                                  | `b9b8170` | clean；shallow；1 commit visible            |
| hegel-salon           | [当前代码事实] 公开原创仓库    | `wzn1118/hegel-salon`                                                     | `36f1cd3` | clean；shallow；1 commit visible            |
| wechat-cli-new        | [外部源码] fork/镜像快照       | checkout 为 `huohuoer/wechat-cli`，包元数据指向 `freestylefly/wechat-cli` | `a378923` | clean tracked；shallow                      |
| wechat-decrypt-source | [外部源码] 上游快照            | `328336690/wechat-decrypt`                                                | `44427c4` | clean tracked；shallow；ignored config 未读 |
| mdx-gpt-5-6-instruct  | [外部源码] prompt/评测分发快照 | `MDX-Tom/gpt-5.6-instruct`                                                | `5f469e4` | clean；shallow；有相同 duplicate checkout   |
| source                | [外部源码] 多来源聚合树        | `zxr-roro/GPT5.6-5.5-`                                                    | `b18ceb0` | dirty；partial clone；3 commits visible     |

## 2. 规模矩阵

| 对象             |                    Tracked | 主代码规模                                       | 测试静态信号                                   | API/命令/技能表面                                                             |
| ---------------- | -------------------------: | ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| AsteriaAnalyst   |         [当前代码事实] 345 | 222 Python / 211,284 行；35 前端代码 / 22,066 行 | 70 `test_*.py`；约 551 test defs               | 94 FastAPI GET/POST/DELETE decorators；6 页面；362 统计目录；4,028 Lab 卡快照 |
| hegel-salon      |         [当前代码事实] 543 | 40 MJS / 24,772 行；349 corpus TXT               | 12 eval/smoke/stress 候选；无 Node test script | 37 registry tools + 8 auth routes；18 SQLite tables                           |
| wechat-cli       |          [当前代码事实] 51 | 31 Python / 3,015 行                             | 0 test file；0 CI                              | 11 CLI commands                                                               |
| wechat-decrypt   |          [当前代码事实] 19 | 10 Python / 3,134 行                             | 1 latency diagnostic；CI lint only             | 5 Web routes；7 MCP tools；8 主要脚本入口                                     |
| MDX prompt repo  |          [当前代码事实] 31 | 4 Python / 897 行；13 ZIP                        | 当前 tree 无 tests/reports/examples            | 2 prompt ZIP；11 script ZIP；1 installer；1 archive checker                   |
| source aggregate | [当前代码事实] 438 tracked | 约 34 code files / 7,546 行；341 Markdown        | 无全树统一测试                                 | 63 `SKILL.md`；41 CTF entrypoint；Burp 63 tools                               |

### 2.1 数字解释

- [当前代码事实] Asteria 的 Python 行数包含目录、测试和生成/大文件，不宜直接当作手写核心代码量；面试材料应同时给服务/测试/API 结构。
- [当前代码事实] hegel 的 349 个 corpus TXT 是内容资产，和 40 个 MJS 工程代码需要分开。
- [当前代码事实] MDX 的脚本主要压在 ZIP 中；tracked 普通 `.py` 行数低估了可枚举的归档脚本体积，也弱化了普通源码 diff 能力。
- [当前代码事实] source 的 Git index 是 438 个文件，但当前物理树缺 1 个 tracked 6,501 行文档；两个口径不得混用。

## 3. 技术栈矩阵

| 对象             | Runtime                                    | Framework/核心库                                                            | 状态/存储                                                             |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Asteria          | Python 3.11+/CI 3.13；Node >=20.9/CI 22    | FastAPI、Next 16、React 19、Pandas、DuckDB、Statsmodels、sklearn、ReportLab | 本地目录/JSON/运行文件；`ASTERIA_DATA_DIR`；public artifacts 单独挂载 |
| hegel            | Node 22 Docker                             | 原生 HTTP/HTTPS、OpenAI SDK、Nodemailer、Capacitor 8                        | Node SQLite DatabaseSync；WAL；用户目录；atomic JSON/text             |
| wechat-cli       | Python >=3.10；npm wrapper Node >=14       | Click、PyCryptodome、Zstandard                                              | `~/.wechat-cli`；OS temp 解密 DB cache；SQLite 只读查询               |
| wechat-decrypt   | Python 3.10+ claim；CI 3.11                | PyCryptodome、FastMCP、标准库 HTTP/SSE                                      | project config/key/decrypted dirs；monitor cache；MCP temp DB         |
| MDX prompt repo  | Python script；Pages Node/Python toolchain | stdlib config/archive handling；Pages/Star History                          | Codex `config.toml` + prompt files + backups；ZIP artifacts           |
| source aggregate | Python/Node/PowerShell/Bash/Java 21/Gradle | Agent skill markdown/YAML；Montoya API；NanoHTTPD；Gson                     | skill files、journal、manifests、Codex config；Burp in-process state  |

## 4. 入口、构建与发布

| 对象           | 主入口                                                | 构建/校验                                                             | 发布/部署                                                          |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Asteria        | `.\start-asteria.ps1`、FastAPI、Next                  | pytest；lint；Next build；method-guide verify；Windows portable smoke | `v*` tag 从已验证 ZIP 创建 GitHub release；artifact 14 days        |
| hegel          | `node src/server.mjs`                                 | 多个 eval/smoke/stress scripts；没有 CI/test script                   | Docker、Compose、Render autoDeploy；1 GB disk                      |
| wechat-cli     | `wechat-cli=wechat_cli.main:cli`；`entry.py`          | 当前 tree 无 tests/CI                                                 | pip/PyInstaller/npm platform wrapper；发布包未核对                 |
| wechat-decrypt | 8 个直接 Python scripts                               | GitHub Actions Windows ruff lint                                      | 没有 release workflow；Web monitor 本地启动                        |
| MDX            | `codex-instruct.py`、`sync-archives.py`               | archive check；当前 clean clone check 失败                            | Pages/Star History workflow；ZIP 直接分发                          |
| source         | instruction script、SKILL entrypoints、Burp extension | field-journal PR regex gate；Burp Gradle fat JAR                      | 无全树 release pipeline；nested workflow 可 auto-squash journal PR |

## 5. 安全边界矩阵

| 对象           | 正向边界                                                                                           | 主要缺口/风险                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Asteria        | [当前代码事实] loopback、CORS local、private/public storage 分离、runtime gates、敏感设置掩码      | 无登录层；上传整文件读内存且未见大小门槛；高权限执行开关；缺 LICENSE                  |
| hegel          | auth、scrypt、hash token、CSRF、admin 2FA、AES-GCM key、上传限制、Defender、用户隔离、安全 headers | 内存限流不跨实例；无 CI；语料许可逐项未核；原型上传/管理员面仍需动态审计              |
| wechat-cli     | 路径 traversal guard、动态表名白名单、参数 SQL、XML 长度/DTD gate                                  | key 明文持久化；temp 明文 DB 不清理；Linux ptrace；macOS 重签；无 tests/CI            |
| wechat-decrypt | ignored secrets；WAL salt 校验；image path traversal guard；MCP stdio temp cleanup                 | Web `0.0.0.0:5678` 无认证；聊天/图片网络暴露；requirements 漏 `zstandard`；CI 仅 lint |
| MDX            | installer 有 dry-run/backup/reset；ZIP 可 hash                                                     | README hash 与当前 ZIP 不符；源缺失；测试报告缺失；外部 prompt 持续改变 Agent 配置    |
| source         | Burp 监听 loopback；field-journal 白名单和内容扫描；子技能隐式调用默认关闭                         | 聚合供应链；Burp 63 tools 无认证/风险元数据；许可证混合；dirty tree；全树无测试       |

## 6. 数据/领域模型

| 对象           | 主要模型                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asteria        | [当前代码事实] Dataset、workflow、statistics method、Lab card、smart-report job、report、agent session、event、attachment、annotation、Codex run/job/pipeline、learning ledger。                      |
| hegel          | [当前代码事实] Corpus hit、parallel text、concept/term profile、style profile、user/session/code、chat session/message、memory、security events、training run、local agent device/task、daily usage。 |
| wechat-cli     | [当前代码事实] config/key map、DB cache entry、contact/name map、message table context、history/search entry、incremental cursor。                                                                    |
| wechat-decrypt | [当前代码事实] config/key map、SQLCipher page/WAL frame、message log、SSE client queue、decoded image、MCP DB cache。                                                                                 |
| MDX            | [当前代码事实] versioned prompt artifact、ZIP manifest、Codex config binding、baseline/timestamp backup、evaluation runner archive。                                                                  |
| source         | [当前代码事实] SKILL entrypoint、agent YAML policy、routing matrix、bootstrap manifest、field journal、Burp `{tool, params}` request。                                                                |

## 7. CI/测试成熟度对比

| 等级                 | 对象           | 依据                                                                                                                |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 较强静态证据         | Asteria        | [当前代码事实] backend pytest + frontend lint/build/audit + Windows final artifact smoke + tag release dependency。 |
| 有专门评估、缺统一门 | hegel          | [当前代码事实] 多维 eval/stress/smoke，但无 CI 和统一 test script，且有一处静态脚本缺陷。                           |
| 只有 lint            | wechat-decrypt | [当前代码事实] Windows ruff；没有业务 fixture/assertions。                                                          |
| 展示自动化           | MDX            | [当前代码事实] Pages/Star History workflow；不测试 installer/archives/evaluation。                                  |
| 局部内容准入         | source         | [当前代码事实] 只审 field-journal PR；不构建/测试聚合树。                                                           |
| 当前无自动门         | wechat-cli     | [当前代码事实] 没有 tests 与 workflow。                                                                             |

- [未验证] 本轮没有在线查询 workflow runs；“CI 配置存在”与“当前 HEAD 在线通过”是两类事实。

## 8. README 声明漂移对比

| 对象           | 文档声明                                       | 当前代码对照                                                                  |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Asteria        | [README 声明] 362 统计方法、4,028 Lab cards    | [历史快照] 生成目录与脚本支持目录数字；可运行比例需单独看。                   |
| hegel          | [README 声明] 引文纪律、质量 judge、多用户安全 | [当前代码事实] 对应模块存在；quote 子串校验不等于学术权威，分数本轮未复现。   |
| wechat-cli     | [README 声明] local/read-only/cross-platform   | [当前代码事实] 数据查询本地只读；init 有内存读取与重签副作用，平台矩阵未跑。  |
| wechat-decrypt | [README 声明] 5 MCP tools、约 100ms、26 DB     | [当前代码事实] 代码实际 7 tools；性能与数据库数量未复测。                     |
| MDX            | [README 声明] 约 360 cases、hash、完整评测资产 | [当前代码事实] tests/reports/examples 缺失，hash 不一致，archive check 失败。 |
| source         | [README 声明] 大型自动路由、多平台、自进化     | [当前代码事实] 63 entrypoints 和局部 workflow 存在；没有全树运行证据。        |

## 9. 面试所有权表述矩阵

| 可用说法                      | 对象                                    | 说明                                                                                |
| ----------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| “我设计/实现的公开项目中……”   | Asteria、hegel                          | 仍应只落到有代码证据的模块，并准备回答 commit/架构/测试。                           |
| “我审计和比较过外部实现……”    | wechat-cli、wechat-decrypt、MDX、source | 准确体现研究贡献；不要把 upstream code count、feature、star 或 release 当个人业绩。 |
| “我发现了代码与文档漂移……”    | wechat-decrypt、MDX、wechat-cli、source | 可具体说 7 vs 5 tools、hash mismatch、remote identity divergence、dirty deletion。  |
| “我做过供应链/安全边界分析……” | 全部                                    | 必须同时讲证据路径、未运行项与后续验证方法。                                        |

## 10. 高价值追问索引

1. Asteria：AI 规划与确定性计算为何分层？正式 PDF 发布门怎样阻断低质量产物？
2. Asteria：loopback 单用户应用如何演进到多租户服务？上传、鉴权、沙箱、配额怎样补齐？
3. hegel：子串引文校验解决什么、没有解决什么？
4. hegel：为什么 tool registry 同时携带 risk/readOnly/destructive/concurrency metadata？
5. wechat-cli：mtime cache 的性能收益与明文持久化风险如何权衡？
6. wechat-decrypt：SSE/Web 和 stdio MCP 的攻击面为何差异巨大？
7. MDX：如何设计 commit-bound、可重建、可重放的 prompt evaluation release？
8. source：如何对 63 个 skills、下载器、listener、许可证和 dirty tree 做分层 trust ranking？

## 11. 本轮未验证总表

- [未验证] 六个远程仓库的最新在线状态、完整 GitHub issue/PR/release/tag/star/fork 统计。
- [未验证] shallow clone 的完整作者、提交频率、分支策略与历史代码演进。
- [未验证] Asteria 全量测试、build、portable release、真实报告基准与所有方法执行矩阵。
- [未验证] hegel 在线部署、语料逐项 provenance、全部 evaluation 分数、上传/越权动态安全。
- [未验证] 两个 WeChat 工具的真实版本兼容、数据正确率、权限路径和发布包一致性。
- [未验证] MDX README 效果数字、缺失测试/报告和历史 release hash。
- [未验证] source 全部 third-party 内容、bootstrap 下载、Burp 63 tools 运行结果和完整许可证 SBOM。
