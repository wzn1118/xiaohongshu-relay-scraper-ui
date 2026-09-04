# 主仓库 AI Provider、Schema 与质量门事实

来源：当前 tracked 的 scripts/ai_provider_runtime.py、ai_application_workflow.py、cover_letter_rewriter.py、application_intelligence_agents.py 和 evidence_claim_validator.py。

## AIProvider 默认配置

| 项目              | 默认/范围                                       |
| ----------------- | ----------------------------------------------- |
| provider          | XHS_AI_PROVIDER；默认 codex                     |
| api key           | XHS_AI_API_KEY                                  |
| base URL          | XHS_AI_BASE_URL，去除末尾斜线                   |
| model             | XHS_AI_MODEL                                    |
| wire API          | codex 默认 responses；其他默认 chat_completions |
| 单请求 timeout    | 默认 600 秒；最小 30 秒                         |
| total timeout     | 未传时 0；传入后最小 30 秒                      |
| context tokens    | 配置时限制 4,096 到 131,072；未配置为 0         |
| max output tokens | 默认 4,096；限制 256 到 262,144                 |
| HTTP retries      | 默认 5；限制 0 到 8                             |
| 单张本地图片      | 最大 8 MiB                                      |
| 本地图片总量      | 最大 20 MiB                                     |

## Provider 分派

- provider=local_qwen 走本地 Ollama 风格接口。
- provider=codex 且没有同时配置 api_key、base_url、model 时走本机 Codex CLI。
- 其他 provider 走 OpenAI-compatible。
- wire_api=responses 使用 /responses。
- wire_api=chat_completions 使用 /chat/completions。
- local_qwen 是唯一默认不要求 API key 的 provider。
- 外部请求使用 Bearer Authorization；默认 User-Agent 是 Windows/PowerShell 风格字符串，可由 XHS_AI_USER_AGENT 覆盖。

## 本地模型与视觉

- 视觉模型名称启发式包含 qwen2.5vl、qwen3-vl、qwen-vl、vision、llava、minicpm-v。
- 代码会查询模型能力并缓存视觉模型选择。
- 候选视觉模型可从 Ollama /api/tags 发现。
- 视觉优先顺序：qwen2.5vl、qwen3-vl、qwen-vl、minicpm-v、llava、vision。
- 图像调用失败时可回退文本输入和 alt text。
- local structured generation 使用 temperature=0、num_predict=max_output_tokens，可选 num_ctx。
- 本地 structured JSON 最多进行 3 次解析/再生成尝试。

## Codex CLI 路径

- 二进制发现顺序：CODEX_CLI_BIN、codex.exe、codex、codex.cmd。
- 每次调用在临时目录写 schema.json 和输出文件。
- 命令使用 --output-schema。
- 运行时参数来自 current_codex_runtime_args。
- model 有值时追加 --model。
- 请求从 stdin 传入。
- Windows 创建新进程组并使用 taskkill /T /F 处理超时。
- POSIX 使用 start_new_session 与 process group signal。
- 第一次 timeout 后等待 5 秒 drain，再强制终止并再等待 5 秒。
- Codex CLI 没有结构化输出时抛 AIProviderError。

## 写作输出 Schema

writing schema 要求：

- greeting
- email_subject
- email_body
- cover_letter
- used_evidence_ids
- capability_matches
- recommended_resume
- resume_reason

additionalProperties=false。

## 评审 Schema 与满分构成

| 维度             | 最大分 |
| ---------------- | -----: |
| role_relevance   |     25 |
| evidence         |     25 |
| first_person     |     15 |
| concision        |     15 |
| credibility      |     10 |
| action_readiness |     10 |
| 合计             |    100 |

评审对象还必须返回 score、strengths、problems 和 rewrite_instructions；score 范围 0 到 100。

## enrich_payload 默认行为

- threshold 默认 90。
- max_attempts 默认 4。
- 每条 record 计算 source hash，已有结果可判断 missing/changed/current。
- target_note_ids 可定向刷新。
- only_incomplete 可限制只处理不完整记录。
- 没有正文但有图片时尝试视觉抽取职责、要求、渠道和能力。
- 没有正文的结果 status=needs_review，evaluation score=0。
- 图片抽取失败会记录 media.analysis status=unavailable 与 model_error。
- 每轮先生成 draft，再独立 evaluate。
- deterministic problems 存在时，最终 score 被限制在 89 以下。
- 达到 threshold 后停止重写并计入 passed。
- 模型异常但已有 draft 时，保留最后一个可编辑 draft，并将 score 限制到 89。
- 模型稿未达标时检查 deterministic grounded fallback。
- fallback score 最高 89，并根据问题数每增加一个问题减 6。
- runtime_status 使用 completed 或 quality_threshold_not_met。
- outreach status 使用 ready 或 needs_review。
- recommended_resume 必须存在于 profile snapshot 的 resumeArtifacts id 集合中，否则清空。

## Cover Letter 长度与重写契约

| 项目                    | 值                                         |
| ----------------------- | ------------------------------------------ |
| 最少非空白字符          | 800                                        |
| 目标范围                | 900 到 1,200                               |
| 最大非空白字符          | 1,600                                      |
| 个人经历正文占比目标    | 60% 到 75%                                 |
| signature evidence 目标 | 2 到 4                                     |
| 内部质量分最低值        | 92                                         |
| style violation 允许数  | 0                                          |
| minimum work evidence   | 最多要求 3 条，受现有 work evidence 数限制 |

验证还检查：

- 占位符。
- 内部 evidence token。
- 来源未支持的结果表述。
- 风格违规。
- 岗位名称。
- 第一人称“我”。
- allowed evidence id。
- required responsibility id。
- evidence coverage 原句。
- 数字、工具或行动 grounding marker。

## 两套分数门槛的事实

- ai_application_workflow 默认外部/综合通过线为 90。
- cover_letter_rewriter 的内部质量契约最低值为 92。
- human_quality_dimensions 中另有 score >= 80 且 problems 为空的局部判断。
- 这些是不同子流程的工程阈值，不应合并为“准确率 90%”。

## 事实边界

- Schema、重试和 validator 证明防线存在，不证明模型输出在真实数据上达到特定正确率。
- provider 兼容性受实际中转实现、模型能力和网络影响。
- 本轮没有调用任何模型，也没有重新跑 AI evaluation。
