# 安全、隐私与外部边界

## 资产清单

- 浏览器登录态和 profile 目录
- Relay token、模型 API key、SMTP/OAuth 配置
- 岗位、帖子、评论、用户和候选人资料
- 应用文、收件人、附件和发送 receipt
- Data Copilot 对话、上下文快照、MCP grant 和工具执行记录
- 本地发布包、日志、JSONL 产物和 SQLite WAL

## 信任边界

1. React 浏览器与 Node 本地 API。
2. Node 与 Python worker。
3. Node/Python 与 Relay/CDP 浏览器。
4. Runtime 与模型提供方。
5. UI/API 与 SMTP/Mailpit。
6. 外部 MCP client 与独立 loopback listener。
7. 发布包与用户机器上的运行时。

每个边界都需要超时、错误分类、日志脱敏和恢复策略。外部返回成功时，本地仍需根据 receipt 或 checkpoint 提交状态。

## 凭证原则

- key 和 token 从环境或 session 读取。
- key 仅在环境或 session 中使用，不落入 job、日志、历史或 artifact。
- MCP token 只保存带 pepper 的 hash。
- 发布包排除 .env、Cookie、浏览器 profile、API key、SMTP 和个人数据。
- debug 日志只记录 provider 名、request id、耗时和错误类别。

## 浏览器登录态

- 使用隔离的 user-data-dir 和受管 profile。
- 通过 Relay/CDP 连接已有浏览器页签，避免在脚本内保存登录信息。
- 发现安全验证或登录失效时暂停 gate，保留 checkpoint，由用户在原浏览器完成处理。
- 结束时按运行策略关闭 worker；不主动清理用户的登录态资料。

## MCP 防护

- 独立 loopback listener。
- Origin 校验和 DNS rebinding 防护。
- Bearer grant 与 owner/snapshot/manifest 绑定。
- grant 有 TTL、scope、风险等级和调用上限。
- 高风险动作要求 approval。
- 输出大小、并发、速率和超时均有边界。
- receipt 保存 action hash，支持审计和去重。

## 批量投递防误发

发送流程必须经过：

1. recipient 和附件 preflight。
2. evidence 和正文检查。
3. dry-run 预览。
4. 用户显式批准。
5. frozen payload。
6. send receipt 和 audit。

重复请求使用幂等 key。外部状态未知时先 reconcile，不直接重复发送。

## 发布安全

GitHub release workflow 从已提交文件生成净化 ZIP，排除：

- .git 和开发缓存
- node_modules、dist 和运行时数据
- .env、用户 profile、Cookie、token、API key
- 私人履历、收件人、邮件和抓取样例

随后在临时目录安装依赖、构建、启动并检查健康端点，再生成 SHA-256。

## 面试题：怎样做威胁建模

回答顺序：

1. 明确资产和信任边界。
2. 区分读取、分析和副作用工具。
3. 对每类边界定义认证、授权、限流、超时、审计和恢复。
4. 用 deterministic fixture 验证拒绝越权、重复调用和敏感日志。
5. 对未知副作用设计人工 reconcile 路径。

## 仍需补证

- 真实生产环境的访问控制和部署拓扑。
- 是否有集中式 secrets manager。
- 外部 Relay 的实际租户边界。
- 完整安全回归、渗透或第三方审计报告。
