# AI Provider、生成链路与质量门事实

> 提交基线：`HEAD=1fa74a0fb8cb19e043cad7c15bfcafc8c261ed2e`。本文件把已提交实现标为 `[HEAD]`，把当前 tracked 增量标为 `[W]`，不把模型目录等配置事实解释成外部服务当前可用性。

## Provider 目录

- **XHS-AI-001 [HEAD]**：服务端 Provider 目录定义于 `server/ai-session-store.mjs`，已提交目录含 `local_qwen`、`relay`、`openai`、`codex`、`deepseek`、`qwen`、`custom` 共 7 项。
- **XHS-AI-002 [HEAD]**：`local_qwen` 默认 OpenAI-compatible Base URL 为 `http://127.0.0.1:11434/v1`，默认模型为 `qwen3.5:4b`，wire API 为 `chat_completions`，标记为 bundled/local/free，且 `requiresKey=false`。
- **XHS-AI-003 [HEAD]**：`relay` 是自定义 OpenAI-compatible 中转入口，默认 Base URL 和模型为空，wire API 为 `chat_completions`，`requiresKey=true`。
- **XHS-AI-004 [HEAD]**：`openai` 默认 Base URL 为 `https://api.openai.com/v1`，默认模型为 `gpt-4.1-mini`，wire API 为 `chat_completions`；目录中列出 10 个模型 ID。证据：`server/ai-session-store.mjs`。
- **XHS-AI-005 [HEAD]**：`codex` 默认模型为 `gpt-5.5`，Base URL 为空，wire API 为 `responses`，目录中列出 6 个模型 ID。证据：`server/ai-session-store.mjs`。
- **XHS-AI-006 [HEAD]**：`deepseek` 默认 Base URL 为 `https://api.deepseek.com`，默认模型 `deepseek-chat`，目录含 4 个模型 ID，wire API 为 `chat_completions`。
- **XHS-AI-007 [HEAD]**：`qwen` 默认 Base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，默认模型 `qwen-plus`，目录含 7 个模型 ID，wire API 为 `chat_completions`。
- **XHS-AI-008 [HEAD]**：`custom` 的 Base URL 与模型默认留空，预置 7 个候选模型 ID，wire API 为 `chat_completions`。
- **XHS-AI-009 [HEAD]**：上述模型 ID 是仓库内置目录，不等同于 2026-08-18 对各上游账户进行过在线枚举或推理验证。证据边界：`server/ai-session-store.mjs` 的静态 `PROVIDERS`。

| Provider     | 默认 Base URL                                       | 默认模型        | Wire API           | Key | 已提交证据                    |
| ------------ | --------------------------------------------------- | --------------- | ------------------ | --- | ----------------------------- |
| `local_qwen` | `http://127.0.0.1:11434/v1`                         | `qwen3.5:4b`    | `chat_completions` | 否  | `server/ai-session-store.mjs` |
| `relay`      | 空                                                  | 空              | `chat_completions` | 是  | 同上                          |
| `openai`     | `https://api.openai.com/v1`                         | `gpt-4.1-mini`  | `chat_completions` | 是  | 同上                          |
| `codex`      | 空                                                  | `gpt-5.5`       | `responses`        | 是  | 同上                          |
| `deepseek`   | `https://api.deepseek.com`                          | `deepseek-chat` | `chat_completions` | 是  | 同上                          |
| `qwen`       | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`     | `chat_completions` | 是  | 同上                          |
| `custom`     | 空                                                  | 空              | `chat_completions` | 是  | 同上                          |

## AI Session、配置与在线探测

- **XHS-AI-010 [HEAD]**：`AiSessionStore` 默认 session TTL 为 8 小时，内存中分别用 `sessions` 与 `configurations` 两个 `Map` 保存会话和 Provider 配置。
- **XHS-AI-011 [HEAD]**：默认模型发现超时为 10,000 ms；推理探测超时为 120,000 ms；传输尝试 3 次；基础重试延迟 750 ms。构造器把尝试次数夹在 1-5，把延迟夹在 0-5,000 ms。
- **XHS-AI-012 [HEAD]**：创建 session 前验证 Provider、API Key、模型、Base URL 与 wire API；需 Key 的 Provider在 Key 为空时抛出 `AI_VALIDATION`。
- **XHS-AI-013 [HEAD]**：Base URL 只接收 HTTPS；`127.0.0.1`、`localhost`、`::1` 可用 HTTP；URL 中的 username/password 被拒绝，query/hash 被清除，末尾 `/models`、`/responses`、`/chat/completions` 被规范掉。
- **XHS-AI-014 [HEAD]**：wire API 只规范为 `responses` 或 `chat_completions`。证据：`normalizeWireApi()` in `server/ai-session-store.mjs`。
- **XHS-AI-015 [HEAD]**：切换已保存 Provider 的 Base URL 时，若请求没有重新给 API Key，store 会要求再次输入 Key，避免旧凭据静默绑定新地址。
- **XHS-AI-016 [HEAD]**：`publicSession()` 返回 id/provider/model/baseUrl/wireApi/configured/expiresAt，不含 `apiKey`。
- **XHS-AI-017 [HEAD]**：Provider 配置文件 schema 为 `{version:1, providers:{...}}`；写入临时文件时请求 `0600` mode，随后尝试 `chmod(0600)` 并原子 rename。Windows 上代码明确接受文件 mode API 差异。
- **XHS-AI-018 [HEAD]**：配置持久化内容包含 API Key、模型、Base URL、wire API、updatedAt；因此准确边界是“Key 不进入公开 session 响应”，而不是“进程从不持久化 Key”。证据：`saveConfiguration()`。
- **XHS-AI-019 [HEAD]**：模型发现向 `<base>/models` 发 GET，携带可选 Bearer Key；当 Base URL 不以 `/v1` 结尾时会在 direct 与 `/v1` 两个候选间切换，relay/custom 优先 `/v1`。
- **XHS-AI-020 [HEAD]**：模型发现可读取顶层数组、`data`、`models`、`result.data` 或 `result.models`；模型 ID 去重、按英文 numeric locale 排序，并限制为无空白/尖括号/引号的 1-160 字符。
- **XHS-AI-021 [HEAD]**：真实推理探测分别调用 `/responses` 或 `/chat/completions`，提示模型只回复 `READY`；Responses 使用 `max_output_tokens=256`，Chat Completions 使用 `temperature=0`、`stream=false`、`max_tokens=256`。
- **XHS-AI-022 [HEAD]**：探测成功响应返回 `ok`、sessionId、provider、model、wireApi、latencyMs、最长 200 字符 responseText 与 testedAt；探测只证明该请求在当时成功，不代表后续批任务的稳定性。
- **XHS-AI-023 [HEAD]**：探测错误代码为 `AI_PROBE_FAILED`，模型发现错误代码为 `AI_MODEL_DISCOVERY_FAILED`，过期/缺失 session 为 `AI_SESSION_EXPIRED`。

## Python Provider Runtime

- **XHS-AI-024 [HEAD]**：Python 统一运行时位于 `scripts/ai_provider_runtime.py`，默认 Provider 来自 `XHS_AI_PROVIDER`，缺省为 `codex`。
- **XHS-AI-025 [HEAD]**：`codex` 默认 wire API 为 `responses`，其他 Provider 默认 `chat_completions`；也可由 `XHS_AI_WIRE_API` 覆盖。
- **XHS-AI-026 [HEAD]**：单请求默认超时 600 秒且下限 30 秒；可另设 total timeout，运行时用单调时钟计算剩余预算。
- **XHS-AI-027 [HEAD]**：模型上下文配置夹在 4,096-131,072 tokens；空值或解析失败记为 0。最大输出 tokens 默认 4,096，可配置范围 256-262,144。
- **XHS-AI-028 [HEAD]**：HTTP 最大重试次数默认 5，可配置范围 0-8。证据：`XHS_AI_HTTP_MAX_RETRIES` 读取逻辑。
- **XHS-AI-029 [HEAD]**：本地单图字节上限为 8 MiB，总图像字节上限为 20 MiB；一次调用最多装入 4 张本地图/下载图。
- **XHS-AI-030 [HEAD]**：远程图片只接收 HTTP/HTTPS，排除 `localhost` 以及解析后为 private、loopback、link-local、reserved 的 IP；下载单次 timeout 上限 30 秒，并验证响应 Content-Type 与字节限额。
- **XHS-AI-031 [HEAD]**：WEBP/AVIF 可借助 Pillow 转为 RGB JPEG；Pillow 路径不可用或转换出错时该图片跳过。`requirements.txt` 固定 `Pillow==12.3.0`。
- **XHS-AI-032 [HEAD]**：本地模型存在视觉模型时优先图像路径；图像处理失败会记录 `last_image_error` 并退回正文/图片 alt text 路径，而不是把图像失败伪装为图像理解成功。
- **XHS-AI-033 [HEAD]**：OpenAI-compatible 调用按 wire API 发往 `<base>/responses` 或 `<base>/chat/completions`，可在图像请求失败后重试纯文本请求。
- **XHS-AI-034 [HEAD]**：未配置完整远端 codex 三元组（Key/Base URL/Model）时，runtime 调本地 Codex CLI；可执行文件按显式环境值、`codex.exe`、`codex`、`codex.cmd` 顺序解析。
- **XHS-AI-035 [HEAD]**：Codex CLI 调用创建临时输出 schema 与结果文件，传入 `--output-schema` 及 `scripts/codex_config.py` 生成的当前 runtime 参数。
- **XHS-AI-036 [HEAD]**：Windows 超时清理使用 `taskkill.exe /PID <pid> /T /F`，超时 10 秒，并在需要时再调用 `process.kill()`；POSIX 使用进程组 signal。证据：`_terminate_process_tree()`。

## 六 Agent 应用智能流水线

- **XHS-AI-037 [HEAD]**：`scripts/application_intelligence_agents.py` 的输出 `schema_version` 为 `1.4`。
- **XHS-AI-038 [HEAD]**：流水线报告列出 6 个 Agent：`coverage-agent`、`time-agent`、`application-info-agent`、`fit-evidence-agent`、`outreach-writer-agent`、`quality-gate-agent`。
- **XHS-AI-039 [HEAD]**：`time-agent` 将发布时间统一到 `Asia/Shanghai`；`application-info-agent` 提取职责、要求、联系途径及 provenance；`fit-evidence-agent` 匹配简历/GitHub 证据。
- **XHS-AI-040 [HEAD]**：`outreach-writer-agent` 通过 Codex Runtime 生成逐条 greeting/email/cover letter；其状态来自 runtime report；quality-gate-agent 状态由总门禁 `passed` 决定。
- **XHS-AI-041 [HEAD]**：publication contract 模式为 `card_body_atomic`，报告 candidate_count、published_count、pending_body_count，并标记 `ai_runs_after_body_collection=true`。
- **XHS-AI-042 [HEAD]**：报告同时计算 generation coverage、总覆盖率与正文覆盖率，并保留 checks/issues，不仅输出成稿。
- **XHS-AI-043 [HEAD]**：表格输入的公式防护会对以公式触发字符开头的单元格添加前导单引号，避免导出结果在表格软件中被当作公式执行。证据：`scripts/application_intelligence_agents.py`。

## Cover Letter 验收与评分

- **XHS-AI-044 [HEAD]**：Cover Letter 非空白字符下限 800，目标区间 900-1,200，上限 1,600；常量位于 `scripts/ai_application_workflow.py`。
- **XHS-AI-045 [HEAD]**：重写 prompt 版本为 `cover-letter-rewrite-v4-signature-evidence`。
- **XHS-AI-046 [HEAD]**：默认质量阈值为 90，单条默认最多 4 次生成/重写尝试；`enrich_file()` 与 `enrich_payload()` 都传递 threshold/maxAttempts。
- **XHS-AI-047 [HEAD]**：评分 schema 为 0-100，并要求 rubric 六项之和对应总分：岗位相关性 25、证据 25、第一人称 15、简洁 15、可信度 10、行动就绪度 10。
- **XHS-AI-048 [HEAD]**：模型给出的 score 会被 `min(model_score, rubric_sum)` 约束，避免总分高于各维度之和。
- **XHS-AI-049 [HEAD]**：评价提示把 90 分定义为“真实、岗位专属、可直接发送”，并要求低于 90 时给出具体可执行的重写要求。
- **XHS-AI-050 [HEAD]**：prompt 明确要求职责先映射到 `candidate_evidence.id`，`used_evidence_ids` 只能引用给定 ID，`recommended_resume` 只能引用真实 `resumeArtifacts` ID。
- **XHS-AI-051 [HEAD]**：只有 `application_context.resumeAttached=true` 时，生成正文才可表述已附简历；候选 Profile 的 resumeArtifacts 仅提供 id/文件名/摘要 hash/页数。
- **XHS-AI-052 [HEAD]**：确定性长度、证据、叙述和 human-quality 检查失败时，最终模型分数上限被压到 89，因此仅凭模型自评分也过不了 90 分门槛。
- **XHS-AI-053 [HEAD]**：fallback 最高分同样为 89，并按问题数量每多一项再减 6 分；fallback 只在分数高于当前草稿时替换当前结果。
- **XHS-AI-054 [HEAD]**：ready 的直接条件是 final evaluation score 大于等于 threshold；否则 runtime_status 写为 `quality_threshold_not_met`。
- **XHS-AI-055 [HEAD]**：人类质量维度至少包含 factual_grounding、specificity、role alignment、attachment consistency 与 AI cliche；维度通过规则使用 `score >= 80` 且 problems 为空。
- **XHS-AI-056 [HEAD]**：内容质量记录含 cover_letter_chars、length pass、证据数、AI 产品岗位机制检查、无上下文附件声明检查以及 batch_ready。

## 证据绑定与质量 Gate

- **XHS-AI-057 [HEAD]**：确定性声明验证器名称为 `deterministic-evidence-span-v1`，实现位于 `scripts/evidence_claim_validator.py`。
- **XHS-AI-058 [HEAD]**：证据源包括记录 title/body/source-card/verified-media、候选 Profile、education 及其他 candidate sections；每个源带 evidenceId、sourceVersion、sourceHash。
- **XHS-AI-059 [HEAD]**：验证器对源集合计算稳定 hash；Claim ID 使用 field/type/outputStart/text 生成的 SHA-256 前 16 位。
- **XHS-AI-060 [HEAD]**：有效绑定要求 evidenceId 指向当前源，sourceVersion/sourceHash 与当前源一致，evidenceStart/evidenceEnd 有效，且选中的 span 与 claim text 精确相等。
- **XHS-AI-061 [HEAD]**：Claim validation 汇总 total/valid/failed/review，并持久化 sourceBindings；源集合变更后，旧 validation 因 sourceSetHash 不一致而过期。
- **XHS-AI-062 [HEAD]**：最终 `quality_gate` 同时检查所有 Cover Letter 达到阈值、所有 generated claims 证据有效、记录覆盖与其他 workflow checks；评分通过不等于声明验证自动通过。
- **XHS-AI-063 [HEAD]**：质量失败记录会明确区分 `all_cover_letters_score_at_least_threshold` 与 `all_generated_claims_evidence_valid`，便于面试中解释“模型评价”和“确定性事实门”两层设计。
- **XHS-AI-064 [HEAD]**：草稿编辑后质量状态变 stale；发送路径还会复核精确 version 和 content hash。跨文档证据：`server/draft-store.mjs`、`server/lib/draft-quality.mjs`、`data-model-state-artifacts.md`。

## Model Gateway 与当前增量

- **XHS-AI-065 [HEAD]**：`server/copilot/model-gateway.mjs` 把 Provider 归一为 Responses 或 Chat Completions，支持统一模型请求、stream、工具、usage 解析和 Provider error 分类。
- **XHS-AI-066 [HEAD]**：Responses 能力面包括 background、stateful responses、conversation state、reasoning summary、reasoning effort；非 Responses Provider 的能力受声明约束。
- **XHS-AI-067 [HEAD]**：Responses background 模式支持按 response ID 查询和取消；缺少对应 capability 时返回 `MODEL_CAPABILITY_UNSUPPORTED`。
- **XHS-AI-068 [HEAD]**：流式请求存在协议降级路径，但只在尚未产出事件且服务返回 400/415/422 等兼容性响应时回退，避免流已经开始后重放请求。证据：`server/copilot/model-gateway.mjs`。
- **XHS-AI-069 [HEAD]**：`model-run-broker.mjs` 把 AI session、消息、工具定义、reasoning、Responses state 和中止信号映射到 gateway，向 runtime 返回统一事件流。
- **XHS-AI-070 [W]**：当前 tracked diff 让 Chat Completions 上的已知 reasoning model 也可声明 `reasoningEffort`，并把值发为 `reasoning_effort`；模型判定正则覆盖 `gpt-5*`、`o1/o3/o4*`、`codex*`。证据：`git diff -- server/copilot/model-gateway.mjs`。
- **XHS-AI-071 [W]**：`server/copilot/model-run-broker.mjs` 当前 diff 从“仅 Responses 传 reasoningEffort”改为两种 wire 都传；`server/data-copilot-runtime.mjs` 对 Chat Completions 写 `reasoning_effort`，对 Responses 写 `reasoning.effort`。
- **XHS-AI-072 [W]**：以上 reasoning 增量尚未进入 `HEAD=1fa74a0`，面试中应表述为“工作区正在补齐 Chat Completions reasoning 参数兼容”。

## 可直接复核的命令

```powershell
git show HEAD:server/ai-session-store.mjs
git show HEAD:scripts/ai_provider_runtime.py
git show HEAD:scripts/ai_application_workflow.py
git show HEAD:scripts/application_intelligence_agents.py
git show HEAD:scripts/evidence_claim_validator.py
git show HEAD:server/copilot/model-gateway.mjs
git diff -- server/copilot/model-gateway.mjs server/copilot/model-run-broker.mjs server/data-copilot-runtime.mjs
```
