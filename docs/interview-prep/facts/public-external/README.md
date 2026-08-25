# 公开与外部仓库事实索引

本目录用于面试准备，记录本轮对公开仓库、外部源码副本和聚合源码树的静态审计结果。目标是把“面试时可以说什么”与“当前 checkout 真正能证明什么”分开。文档只描述证据，不把外部仓库的代码、发布物或 README 叙述归为个人原创。

## 覆盖范围

| 文档                                                                                   | 逻辑对象                                   | 本地审计路径                                                                                         | 远程来源                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [01_ASTERIA_ANALYST_FACTS.md](./01_ASTERIA_ANALYST_FACTS.md)                           | AsteriaAnalyst                             | `.codex-tmp/interview-repo-audit/AsteriaAnalyst`                                                     | `https://github.com/wzn1118/AsteriaAnalyst.git`   |
| [02_HEGEL_SALON_FACTS.md](./02_HEGEL_SALON_FACTS.md)                                   | hegel-salon                                | `.codex-tmp/interview-repo-audit/hegel-salon`                                                        | `https://github.com/wzn1118/hegel-salon.git`      |
| [03_WECHAT_CLI_EXTERNAL_FACTS.md](./03_WECHAT_CLI_EXTERNAL_FACTS.md)                   | wechat-cli                                 | `C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-cli-new`                                    | `https://github.com/huohuoer/wechat-cli.git`      |
| [04_WECHAT_DECRYPT_EXTERNAL_FACTS.md](./04_WECHAT_DECRYPT_EXTERNAL_FACTS.md)           | wechat-decrypt                             | `C:/Users/10847/Documents/Codex/2026-07-21/c/work/wechat-decrypt-source`                             | `https://github.com/328336690/wechat-decrypt.git` |
| [05_MDX_PROMPT_REPO_EXTERNAL_FACTS.md](./05_MDX_PROMPT_REPO_EXTERNAL_FACTS.md)         | gpt-5.6-instruct / MDX prompt distribution | `C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/mdx-gpt-5-6-instruct` | `https://github.com/MDX-Tom/gpt-5.6-instruct.git` |
| [06_GPT_SKILL_AGGREGATE_EXTERNAL_FACTS.md](./06_GPT_SKILL_AGGREGATE_EXTERNAL_FACTS.md) | GPT5.6 aggregate / zzy-Codex-5.6 source    | `C:/Users/10847/Documents/Codex/2026-07-20/https-github-com-zxr-roro-gpt5/work/source`               | `https://github.com/zxr-roro/GPT5.6-5.5-.git`     |
| [07_CROSS_REPO_FACT_MATRIX.md](./07_CROSS_REPO_FACT_MATRIX.md)                         | 横向比较、证据等级与面试复习表             | 以上六个对象                                                                                         | 以上六个远程来源                                  |
| [08_INTERVIEW_CLAIM_BOUNDARIES.md](./08_INTERVIEW_CLAIM_BOUNDARIES.md)                 | 事实表述边界、追问清单、风险复盘           | 以上审计结果                                                                                         | 以上远程来源                                      |

## 证据标签

- **[当前代码事实]**：在本轮 checkout 的文件、Git 元数据或静态计数中直接观察到。
- **[README 声明]**：README、AGENTS、CHANGELOG 或设计文档中的作者声明；仅凭声明不足以视为运行结果。
- **[历史快照]**：提交历史、旧文档、生成清单或 shallow clone 能看到的时间点信息。
- **[外部源码]**：来自不属于本项目的公开仓库；可用于理解设计，但不应包装成个人交付。
- **[未验证]**：当前环境没有运行、联网、完整历史或缺少源码，结论需要在面试中主动标记。

## 审计口径

1. Git 计数是当前 checkout 的 tracked 文件快照；生成目录、ignored 文件和 submodule 不在计数内，除非特别说明。
2. shallow clone 的 commit 数只表示本地可见历史，不代表远程完整历史；文档会同时给出 `git rev-parse`、branch、remote、dirty 状态和 HEAD 提交。
3. “测试数量”优先按文件名和静态函数名统计；没有实际跑测试时，统一写成静态发现或 CI 配置事实。
4. README 中的性能、规模、兼容性、质量分数、发布哈希等都保留原文语境，并单独指出当前 checkout 是否能复现。
5. 对安全相关仓库只描述边界、数据流和防护证据，不复制外部 prompt、payload 或敏感数据内容。

## 快速面试主线

- AsteriaAnalyst：可以讲“本地优先的数据分析到正式管理报告流水线”，重点是 AI 负责语义路由、确定性执行器负责数值、证据闸门负责发布质量；同时主动说明 loopback、无内置登录和文件读取边界。
- hegel-salon：可以讲“中文优先的 Hegel 阅读与推理工作台”，重点是语料检索、引文精确校验、概念图、历史文献和多用户安全层；同时说明原型性质、无 CI 和第三方语料授权边界。
- wechat-cli / wechat-decrypt：定位为外部源码研究对象，比较两种本地数据管线：CLI 侧是跨平台密钥发现、SQLCipher 页解密和只读导出；decrypt 侧增加实时监视、Web/SSE 和 MCP，但默认 `0.0.0.0:5678` 无认证是明显部署风险。
- mdx-gpt-5-6-instruct：定位为外部 prompt 分发与评测工程，关注归档、脚本、Codex 配置切换、Pages 工作流和可复现性；当前 checkout 存在 README/归档哈希与源码缺失导致的复现断点。
- source：定位为外部技能聚合与安全研究工具树，重点是插件路由、Burp MCP、CTF/逆向技能边界、许可证混合和供应链审查；当前快照含未提交删除，不宜当作干净发布源。

## 当前轮次限制

- 所有仓库均按当前本地快照静态盘点；没有把完整远程历史、私有配置、ignored 密钥、外网 API 可用性或真实用户数据当作已知事实。
- 本目录只新增 Markdown，不修改项目源代码、测试、配置或已有面试文档。
