# Data Copilot upgrade research notes

This note records the official OpenAI product and API capabilities that should
shape the Data Copilot upgrade. It is an input to the implementation plan, not
a claim that the existing application already supports these capabilities.

## Official capability evidence

### Responses runtime

- [Responses API migration](https://developers.openai.com/api/docs/guides/migrate-to-responses): Responses is the current agentic primitive for new projects. It
  provides the contract needed for reasoning, tools, multi-turn state, and
  structured output while Chat Completions remains supported.
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state): `previous_response_id` can chain turns; the state should be
  persisted independently of the rendered transcript.
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses): typed events include response creation, text deltas,
  completion, and errors. The UI should consume typed events rather than a
  single opaque answer string.
- [Background mode](https://developers.openai.com/api/docs/guides/background): long-running work can run asynchronously and be polled; background
  streams can resume from a cursor. Persist response IDs and cursors so a
  reconnect or refresh does not duplicate work.
- [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode): a persistent connection is useful for high-volume,
  tool-heavy sessions. Keep HTTP/SSE as the first deployment path and add
  WebSocket when measured latency or event volume warrants it.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): server compaction returns an opaque state item that must be passed
  through unchanged. Replace character-count truncation with token budgeting
  plus explicit compaction/recovery state.
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning): raw reasoning tokens are not exposed; optional reasoning summaries
  are available. Render short progress/reason summaries, never raw hidden
  reasoning.
- [Token counting](https://developers.openai.com/api/docs/guides/token-counting): tool schemas and MCP definitions consume input tokens. Add a
  preflight context meter and load only relevant tools.

### Tools and data work

- [Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter): Python executes in a fully sandboxed container with
  uploaded/generated files. Use it for bounded statistics, joins, and chart
  generation; do not expose the host shell by default.
- [Shell](https://developers.openai.com/api/docs/guides/tools-shell): a container can be reused across iterative requests. Give each run an
  ephemeral workspace, quota, snapshot, and TTL.
- [Programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling): a model can coordinate tools with
  JavaScript loops, conditions, and parallel calls. Use it for deterministic
  filter/join/rank/deduplicate/aggregate jobs; retain direct model calls for
  semantic judgment, citations, approvals, and final artifacts.
- [MCP, connectors, and remote tools](https://developers.openai.com/api/docs/guides/tools-connectors-mcp): remote MCP servers and connectors are
  first-class tools. Treat them as opt-in, allowlisted capabilities with
  per-tool scopes, outbound data previews, and approval before sharing data;
  the docs explicitly warn that a malicious server can exfiltrate context.
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): deferred tool namespaces let the model load only the tools
  relevant to the current task, reducing prompt and schema pollution.
- [Agent Skills](https://developers.openai.com/api/docs/guides/tools-skills): versioned skill bundles can be uploaded/reused. Adopt progressive
  disclosure: expose name/description first, load the full `SKILL.md` only
  when a route selects it.

### Agents and quality

- [Multi-agent Responses](https://developers.openai.com/api/docs/guides/responses-multi-agent): a root agent can run independent specialist
  subagents in parallel and synthesize summaries. Parallelism increases token
  and latency cost, so use it only for independent work; do not share mutable
  state between specialists.
- [Agents orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration): use handoffs when a specialist owns the next
  conversation turn; use agents-as-tools when a manager must retain final
  answer control. Data Copilot should use a manager plus bounded specialist
  tools for most analysis jobs.
- [Agents SDK streaming](https://openai.github.io/openai-agents-js/guides/streaming/): full streams contain model, tool, handoff, approval,
  reasoning-summary, and agent-update events. Model the frontend event protocol
  around stable item types rather than parsing prose status lines.
- [Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/): sessions fetch/persist history around a run and support
  resumable runs and compaction. Persist session, turn, item, and artifact
  records separately from UI layout state.
- [Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/): approvals pause a run and return typed
  interruptions; resume with the same run state. Make approval/resume a
  first-class event, not an ad hoc text prompt.
- [Agents SDK handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/): specialist contexts can be narrowed with input filters. Pass
  only the relevant dataset and task contract to each specialist.
- [Agents tracing](https://openai.github.io/openai-agents-js/guides/tracing/): traces cover generations, tools, handoffs, guardrails, and custom
  events. Store trace/run IDs and connect them to regression evaluation.
- [Agent evals](https://developers.openai.com/api/docs/guides/agent-evals): trace grading, datasets, and eval runs identify workflow-level
  failures and make prompt/tool/router changes comparable over time.

### Codex UX and controls to borrow

- [AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md): layered project instructions provide scoped, persistent
  behavior instead of one giant hard-coded prompt.
- [Subagents](https://developers.openai.com/codex/agent-configuration/subagents): activity is visible while the main thread receives summaries;
  this avoids flooding the conversation with raw intermediate output.
- [Build skills](https://developers.openai.com/codex/build-skills): progressive disclosure and a required `SKILL.md` make skills reusable without
  loading every instruction into every turn.
- [Sandboxing](https://developers.openai.com/codex/sandboxing) and [approvals/security](https://developers.openai.com/codex/agent-approvals-security): separate
  read-only, workspace-write, and broader external-action permissions; show
  the exact action/scope/data in an approval card.
- [Codex App Server](https://developers.openai.com/codex/app-server): append-only typed JSONL events and durable thread state are a useful model
  for replayable run logs, even if Data Copilot keeps its own transport.

## Recommended architecture mapping

1. **Model gateway**: Responses-native calls, model capability registry,
   `previous_response_id`, background jobs, reasoning summaries, usage, and
   token counts. Remove hard-coded full-response JSON assumptions.
2. **Durable event log**: persist typed events such as `run.created`,
   `plan.updated`, `agent.started/completed`, `tool.started/progress/result`,
   `approval.required/resolved`, `artifact.ready`, `citation.added`,
   `usage.updated`, `run.completed/failed`. SSE/WebSocket becomes a replay
   projection over this log with a cursor.
3. **Context manager**: count tokens including tool schemas, maintain a
   relevance-based working set, invoke compaction, and recover from a missing
   previous response. Keep UI transcript and model context separate.
4. **Model-driven orchestrator**: replace keyword-only planning with a task
   contract containing goal, input scope, acceptance criteria, allowed tools,
   and evidence requirements. Use deferred tool loading and explicit retry /
   repair loops.
5. **Analysis sandbox**: per-run Python/DuckDB workspace for calculations,
   joins, validation, and chart/data artifact generation. Enforce quotas,
   isolation, TTL, and deterministic provenance.
6. **Versioned skills**: domain packs such as `audience-analysis`,
   `job-comparison`, `content-quality`, and `artifact-reporting`; each has
   `SKILL.md`, examples, scripts, and golden tests. Load only the selected
   pack.
7. **Specialists**: manager plus bounded Data Analyst, Content Analyst,
   Researcher, and Critic/Verifier helpers. Parallelize only independent
   branches; return short structured summaries to the manager.
8. **Evidence and verifier**: represent each claim as source rows +
   calculation + confidence. Verify numeric correctness, citation coverage,
   stale/contradictory sources, and artifact existence before final output.
9. **Permission policy**: `Read-only analysis`, `Workspace build`, and
   `External action` modes. Require typed approval for writes, connectors,
   exports, or outbound messages; make every side effect idempotent.

## UX acceptance bar

- Three-pane workbench: sessions/tasks, answer canvas, and collapsible
  activity/sources/artifacts inspector. Keep plan and tool activity out of the
  answer body unless the user expands it.
- Rich renderer: real Markdown parser, semantic headings, tables, code blocks,
  inline citation markers, chart/image/artifact blocks, copy/download actions,
  and mobile stacking. Replace raw status codes with human-readable labels.
- Run bar: current goal, elapsed time, progress, cancel/retry, reconnect, and
  approval state. Activity rail shows agent/tool summaries and source links.
- Composer modes (`Ask`, `Analyze`, `Build`) with context/attachment chips;
  retain existing data-specific shortcuts as suggested prompts, not the only
  entry points.

## Delivery sequence and evaluation

- **P0**: typed streaming/event persistence; resilient reconnect/replay;
  Markdown/table/code/citation renderer; humanized statuses; domain prompt and
  acceptance contract; plan/activity separation.
- **P1**: token/context manager and compaction; evidence graph/verifier;
  sandboxed Python/DuckDB and chart artifacts; background jobs and resume.
- **P2**: versioned skills/tool search; specialist agents; MCP allowlist and
  approvals; WebSocket for measured high-volume sessions; deeper research
  connectors.

Create 20-40 golden tasks covering lookup, comparison, aggregation, joins,
attachments, charts/reports, follow-ups, context switches, resumed runs,
failure repair, and approval/idempotency. Score numeric accuracy, citation
coverage, artifact validity, task completion, first-token latency, replay
without duplicate side effects, and desktop/mobile layout. Use traces plus
deterministic graders; do not infer quality from HTTP 200 or a non-empty answer.

## Architectural guardrails

- Do not embed the full Codex CLI/runtime as the default Data Copilot backend:
  its shell/file assumptions are broader than a data product needs. Reuse the
  Responses/Agents primitives and keep analysis inside a controlled sandbox.
- Never expose raw chain-of-thought. Show concise reasoning summaries,
  evidence, calculations, and tool activity instead.
- Treat connectors/MCP and external actions as opt-in, scoped, reviewed, and
  auditable. Keep read-only analysis the default.
