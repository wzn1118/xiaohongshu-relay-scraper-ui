# 仓库清单与来源边界

盘点范围是 C:\Users\10847\Documents 及其 Codex 工作目录。以下信息来自本轮递归查找 .git、读取 branch/remote/log/status、读取 manifest/README，并于 2026-08-18 对公开账号 API 做了快照。

## 独立 Git 根目录

| 路径/项目                           | 分支与来源                                           | 当前状态                                       | 面试处理                       |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| xiaohongshu-relay-scraper-ui        | main；origin 为 wzn1118/xiaohongshu-relay-scraper-ui | HEAD 1fa74a0；约 515 tracked；81 条 dirty 状态 | 第一主项目                     |
| xiaohongshu-relay-scraper-ui-phase7 | codex/phase7-smtp-hardening；同源                    | 历史阶段 clone；HEAD 6ac271e                   | 作为 SMTP hardening 历史阶段   |
| tmp/portable-clone                  | master；同一 origin                                  | 54 tracked；clean；旧提交 1aef299              | 旧发布/烟测快照                |
| MKT大师                             | master；无 remote、无 commit                         | 约 860 untracked                               | 本地 KOLFORGE 快照             |
| today-you-applied-portable          | main；无 remote、无 commit                           | 约 394 untracked                               | 主项目产品化快照               |
| Playground                          | master；无 remote、无 commit                         | 约 85 untracked                                | 三个小原型合集                 |
| Playground 2 / Playground 3         | 无有效提交                                           | 空或近空                                       | 排除                           |
| 本电脑                              | master；无 remote、无 commit                         | 2 个未跟踪文件                                 | 迁移工具，排除                 |
| mdx-gpt-5-6-instruct 两份 checkout  | main；remote 指向 MDX-Tom                            | clean；31 tracked                              | 外部 prompt/security 来源      |
| source                              | main；remote 指向 zxr-roro                           | 438 tracked；有 1 deleted 和 pycache           | 外部 skill/prompt 来源         |
| wechat-cli-new                      | main；remote 指向 huohuoer/wechat-cli                | clean；51 tracked                              | 外部源码研究                   |
| wechat-decrypt-source               | main；remote 指向 328336690/wechat-decrypt           | clean；19 tracked                              | 外部源码研究，涉及敏感数据处理 |

## 公开仓库快照

2026-08-18 通过 GitHub public API 看到账号 wzn1118 有三个公开仓库：

1. xiaohongshu-relay-scraper-ui：当前主项目，JavaScript，updated 2026-08-17。
2. AsteriaAnalyst：企业数据分析和管理报告，Python，updated 2026-08-15。
3. hegel-salon：中文哲学阅读/推理工作台，JavaScript，updated 2026-08-02。

公开 API 只证明仓库可见性和元数据，不自动证明每个模块由候选人独立完成。个人贡献仍需用 commit、设计记录或面试口述补充。

## 归类规则

### 可以作为原创主线

- 当前主项目及其有提交的公开历史。
- AsteriaAnalyst 和 hegel-salon：公开账号仓库，可做项目卡片，但先确认贡献范围。

### 只能作为本地项目快照

- MKT大师、today-you-applied-portable、Playground。
- 口述时使用“我在本地做了一个可运行版本/原型”，不要虚构不存在的 remote、commit 或 release。

### 只能作为阶段版本或重复 checkout

- phase7、tmp/portable-clone、同一 prompt 仓库的第二份 clone。
- 用来解释演进和发布验证，不增加项目数量。

### 只能作为外部来源或源码阅读

- wechat-cli、wechat-decrypt、mdx-gpt-5-6-instruct、source。
- 只有补充个人 fork/commit/PR 证据后，才适合进入原创项目列表。

## 当前工作树边界

主仓库 HEAD 的 v3.0 主线与当前工作区实验是两层事实：

- v3.0 主线：已提交、可从 Git 复现的 Data Copilot/MCP、采集、AI 应用和发布能力。
- 工作区实验：未提交的 Codex Desktop/Browser/Device/Mirror、native relay、XHS context、runtime compatibility 等文件。

简历或面试回答中，实验代码应写成“正在实现的扩展”或“本地原型”，并给出文件路径；不要把它们混入已发布版本的功能列表。
