# 一页项目卡：Hegel Salon

## 定位

中文优先的黑格尔阅读、检索、引用校验和多轮推理工作台。

## 栈

Node.js 22 ESM、原生 HTTP/HTTPS、OpenAI SDK、node:sqlite、Nodemailer、自写 CDP WebSocket、Docker/Render/Cloudflare、Capacitor Android。

## 主链

用户问题/附件 → runtime scope → 本地语料与概念图检索 → 平行引文/历史参照 → 模型回答 → 引文校验 → 质量/逻辑/史学 judge → 修订 → 来源与审计返回。

## 快照事实

- 130 条 golden
- 114 个概念图项
- 172 个 corpus text
- 38 个 src mjs
- SQLite 18 张表

文件数量不证明语料权威、引用准确或生产效果。

## 亮点

- 未在本轮 evidence 中出现的直接引语会修订或去引号。
- 多 judge 产生可观测问题和最多三轮修订。
- user/style 目录、SQLite WAL、scrypt/AES-GCM、CSRF/限流。
- 公网 Computer Use 转交本地 agent，避免服务器桌面执行。

## 边界

没有 GitHub Actions；本轮没有跑评测；90 是优化目标而非稳定结果；浅克隆不足以证明个人贡献。
