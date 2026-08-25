import type {
  DataCopilotApproval,
  DataCopilotAttachment,
  DataCopilotCitation,
  DataCopilotContextCatalog,
  DataCopilotContextRecord,
  DataCopilotRecordKind,
  DataCopilotTaskCatalog,
  DataCopilotMessageData,
  DataCopilotQualityArtifact,
  DataCopilotQualityEvaluation,
  DataCopilotQualityState,
  DataCopilotReasoningEffort,
  DataCopilotRunStatus,
  DataCopilotSession,
  DataCopilotSubagentError,
  DataCopilotSubagentRun,
  DataCopilotSubagentTask,
  DataCopilotSubagentTool,
  DataCopilotSubscriptionHandlers,
  DataCopilotToolCall,
  DataCopilotTransport,
} from './DataCopilotContext'

type JsonObject = Record<string, unknown>

export type DataCopilotTransportOptions = {
  jobId: string
  mode: 'application' | 'research'
  snapshotId: string
  aiSessionId?: string
  renewAiSession?: () => Promise<string | undefined>
  apiBaseUrl?: string
  allowedScopes?: string[]
}

const COPILOT_PATH = '/api/copilot/conversations'
const COPILOT_CONTEXT_PATH = '/api/copilot/context'
const COPILOT_CONTEXT_JOBS_PATH = '/api/copilot/context/jobs'

export function createDataCopilotTransport(
  options: DataCopilotTransportOptions,
): DataCopilotTransport {
  const baseUrl = String(options.apiBaseUrl ?? '').replace(/\/$/u, '')
  const route = (suffix = '') => `${baseUrl}${COPILOT_PATH}${suffix}`

  return {
    async listContextTasks(input) {
      const query = new URLSearchParams()
      if (input.query?.trim()) query.set('query', input.query.trim())
      if (input.offset !== undefined) query.set('offset', String(input.offset))
      if (input.limit !== undefined) query.set('limit', String(input.limit))
      return mapTaskCatalog(await requestJson(
        `${baseUrl}${COPILOT_CONTEXT_JOBS_PATH}?${query.toString()}`,
      ))
    },

    async listContextRecords(input) {
      const query = new URLSearchParams({
        jobId: input.jobId || options.jobId,
        mode: input.mode || options.mode,
      })
      if (input.kind) query.set('kind', input.kind)
      if (input.query?.trim()) query.set('query', input.query.trim())
      if (input.offset !== undefined) query.set('offset', String(input.offset))
      if (input.limit !== undefined) query.set('limit', String(input.limit))
      return mapContextCatalog(await requestJson(
        `${baseUrl}${COPILOT_CONTEXT_PATH}?${query.toString()}`,
      ))
    },

    async listSessions() {
      // History is global. Conversation creation and execution remain bound to
      // the current job through createSession and the persisted conversation.
      const query = new URLSearchParams({ limit: '500' })
      const payload = await requestJson(route(`?${query}`))
      return arrayFrom(payload, 'conversations').map(mapConversation)
    },

    async createSession(input) {
      const jobId = input.jobId || options.jobId
      const mode = input.mode || options.mode
      const snapshotId = input.snapshotId || options.snapshotId
      const selectedModel = {
        aiSessionId: input.modelId || options.aiSessionId || '',
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      }
      const payload = await requestJson(route(), {
        method: 'POST',
        body: JSON.stringify({
          jobId,
          mode,
          snapshotId,
          scope: {
            allowedScopes: options.allowedScopes ?? ['*'],
            contextSourceIds: input.contextSourceIds,
          },
          aiSessionId: input.modelId || options.aiSessionId || '',
          selectedModel,
          ...publicWorkspaceBinding(input),
          idempotencyKey: createIdempotencyKey('conversation'),
        }),
      })
      return mapConversation(objectFrom(payload, 'conversation'))
    },

    async loadMessages(sessionId) {
      const payload = await requestJson(route(`/${encodeURIComponent(sessionId)}/messages`))
      return arrayFrom(payload, 'messages').map((message) =>
        mapDataCopilotMessage(message, sessionId),
      )
    },

    async sendMessage(input) {
      const path = route(`/${encodeURIComponent(input.sessionId)}/messages`)
      const idempotencyKey = createIdempotencyKey('message')
      const buildBody = (modelId: string) => JSON.stringify({
        content: input.content,
        aiSessionId: modelId,
        workspaceMode: input.workspaceMode || 'ask',
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        attachmentIds: input.attachmentIds,
        contextSourceIds: input.contextSourceIds,
        ...publicWorkspaceBinding(input),
        idempotencyKey,
      })
      let payload: unknown
      try {
        payload = await requestJson(path, {
          method: 'POST',
          body: buildBody(input.modelId || options.aiSessionId || ''),
        })
      } catch (error) {
        const typed = error as Error & { code?: string }
        if (typed.code !== 'AI_SESSION_EXPIRED' || !options.renewAiSession) throw error
        const renewedId = await options.renewAiSession()
        if (!renewedId) throw error
        payload = await requestJson(path, {
          method: 'POST',
          body: buildBody(renewedId),
        })
      }
      return mapSendResult(payload, input.sessionId)
    },

    async uploadAttachments(sessionId, files) {
      const uploaded: DataCopilotAttachment[] = []
      for (const file of files) {
        const idempotencyKey = createIdempotencyKey('attachment')
        const form = new FormData()
        form.set('file', file, file.name)
        form.set('idempotencyKey', idempotencyKey)
        const payload = await requestJson(
          route(`/${encodeURIComponent(sessionId)}/attachments`),
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: form,
          },
        )
        uploaded.push(mapAttachment(objectFrom(payload, 'attachment'), sessionId))
      }
      return uploaded
    },

    async stopGeneration(sessionId) {
      await requestJson(route(`/${encodeURIComponent(sessionId)}/cancel`), {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: createIdempotencyKey('cancel') }),
      })
    },

    async retryMessage(sessionId, messageId, input = {}) {
      const payload = await requestJson(route(`/${encodeURIComponent(sessionId)}/retry`), {
        method: 'POST',
        body: JSON.stringify({
          messageId,
          aiSessionId: input.modelId || options.aiSessionId || '',
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          idempotencyKey: createIdempotencyKey('retry'),
        }),
      })
      return mapSendResult(payload, sessionId)
    },

    async updateSessionSettings(sessionId, input) {
      const selectedModel = {
        ...(input.modelId ? { aiSessionId: input.modelId } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      }
      const payload = await requestJson(route(`/${encodeURIComponent(sessionId)}`), {
        method: 'PATCH',
        body: JSON.stringify({ selectedModel }),
      })
      return mapConversation(objectFrom(payload, 'conversation'))
    },

    async confirmApproval(sessionId, approvalId, approved) {
      const payload = await requestJson(
        route(
          `/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/confirm`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            approved,
            action: approved ? 'approve' : 'reject',
            idempotencyKey: createIdempotencyKey(approved ? 'approve' : 'reject'),
          }),
        },
      )
      return mapSendResult(payload, sessionId)
    },

    async loadQuality(sessionId, jobId) {
      const encodedSessionId = encodeURIComponent(sessionId)
      const encodedJobId = encodeURIComponent(jobId)
      const [usageValue, traceValue, snapshotValue, conversationValue, evaluationValue] = await Promise.all([
        requestJson(`${baseUrl}/api/copilot/usage?conversationId=${encodedSessionId}`),
        requestJson(`${baseUrl}/api/copilot/traces?conversationId=${encodedSessionId}&limit=50`),
        requestJson(`${baseUrl}/api/copilot/snapshots?jobId=${encodedJobId}&limit=50`),
        requestJson(route(`/${encodedSessionId}`)),
        requestJson(`${baseUrl}/api/copilot/evaluations?limit=10`),
      ])
      const usage = asObject(usageValue)
      const traces = asObject(traceValue)
      const snapshots = asObject(snapshotValue)
      const conversation = asObject(conversationValue)
      const evaluations = asObject(evaluationValue)
      return {
        usage: {
          records: numberValue(usage.records, 0),
          inputTokens: numberValue(usage.inputTokens, 0),
          outputTokens: numberValue(usage.outputTokens, 0),
          toolCalls: numberValue(usage.toolCalls, 0),
          latencyMs: numberValue(usage.latencyMs, 0),
          estimatedCostUsd: numberValue(usage.estimatedCostUsd, 0),
        },
        traces: arrayFrom(traces, 'traces').map((item) => {
          const trace = asObject(item)
          return {
            id: stringValue(trace.traceId),
            operation: stringValue(trace.operation),
            status: stringValue(trace.status),
            durationMs: numberValue(trace.durationMs, 0),
            createdAt: stringValue(trace.createdAt),
          }
        }),
        snapshots: arrayFrom(snapshots, 'snapshots').map((item) => {
          const snapshot = asObject(item)
          return {
            id: stringValue(snapshot.snapshotId),
            revision: numberValue(snapshot.revision, 0),
            manifestHash: stringValue(snapshot.manifestHash),
            createdAt: stringValue(snapshot.createdAt),
          }
        }),
        artifacts: arrayFrom(conversation, 'artifacts').map((item) => mapQualityArtifact(item, baseUrl, sessionId)),
        evaluations: arrayFrom(evaluations, 'evaluations').map(mapQualityEvaluation),
      } satisfies DataCopilotQualityState
    },

    async runGoldenEvaluation() {
      return mapQualityEvaluation(await requestJson(`${baseUrl}/api/copilot/evaluations/golden`, { method: 'POST', body: '{}' }))
    },

    async createArtifact(sessionId, input) {
      const payload = asObject(await requestJson(route(`/${encodeURIComponent(sessionId)}/artifacts`), {
        method: 'POST', body: JSON.stringify(input),
      }))
      return mapQualityArtifact(payload.artifact, baseUrl, sessionId)
    },

    async upgradeSnapshot(sessionId) {
      const payload = await requestJson(route(`/${encodeURIComponent(sessionId)}/snapshot/upgrade`), {
        method: 'POST', body: JSON.stringify({ copyMessages: true }),
      })
      return mapConversation(objectFrom(payload, 'conversation'))
    },

    subscribe(sessionId, handlers) {
      return subscribeToConversation(route, sessionId, handlers)
    },
  }
}

function publicWorkspaceBinding(value: {
  projectId?: string
  workspaceId?: string
  worktreeId?: string
}) {
  const projectId = String(value.projectId || '').trim()
  const workspaceId = String(value.workspaceId || '').trim()
  if (!projectId || !workspaceId) return {}
  const worktreeId = String(value.worktreeId || '').trim()
  return {
    projectId,
    workspaceId,
    ...(worktreeId ? { worktreeId } : {}),
  }
}

function mapQualityArtifact(value: unknown, baseUrl: string, sessionId: string): DataCopilotQualityArtifact {
  const artifact = asObject(value)
  const id = stringValue(artifact.artifactId) || stringValue(artifact.id)
  return {
    id,
    name: stringValue(artifact.displayName) || stringValue(artifact.name) || id,
    format: stringValue(artifact.format) || stringValue(artifact.extension),
    size: numberValue(artifact.size, 0),
    sha256: stringValue(artifact.sha256),
    status: stringValue(artifact.status) || 'ready',
    url: `${baseUrl}${COPILOT_PATH}/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}`,
  }
}

function mapQualityEvaluation(value: unknown): DataCopilotQualityEvaluation {
  const evaluation = asObject(value)
  const summary = asObject(evaluation.summary)
  return {
    id: stringValue(evaluation.evaluationId),
    status: stringValue(evaluation.status),
    createdAt: stringValue(evaluation.createdAt),
    durationMs: numberValue(evaluation.durationMs, 0),
    summary: {
      total: numberValue(summary.total, 0),
      passed: numberValue(summary.passed, 0),
      failed: numberValue(summary.failed, 0),
      passRate: numberValue(summary.passRate, 0),
    },
  }
}

function mapContextCatalog(value: unknown): DataCopilotContextCatalog {
  const catalog = asObject(value)
  const countsValue = asObject(catalog.counts)
  const counts = Object.keys(countsValue).length ? {
    posts: numberValue(countsValue.posts, 0),
    comments: numberValue(countsValue.comments, 0),
    users: numberValue(countsValue.users, 0),
    artifacts: numberValue(countsValue.artifacts, 0),
  } : undefined
  const kind = contextRecordKind(catalog.kind)
  return {
    schemaVersion: numberValue(catalog.schemaVersion, 1),
    jobId: stringValue(catalog.jobId),
    mode: stringValue(catalog.mode),
    kind,
    counts,
    total: catalog.total === undefined ? undefined : numberValue(catalog.total, 0),
    offset: catalog.offset === undefined ? undefined : numberValue(catalog.offset, 0),
    limit: catalog.limit === undefined ? undefined : numberValue(catalog.limit, 25),
    items: catalog.items === undefined
      ? undefined
      : arrayValue(catalog.items).map(mapContextRecord),
  }
}

function mapTaskCatalog(value: unknown): DataCopilotTaskCatalog {
  const catalog = asObject(value)
  return {
    schemaVersion: numberValue(catalog.schemaVersion, 1),
    total: numberValue(catalog.total, 0),
    offset: numberValue(catalog.offset, 0),
    limit: numberValue(catalog.limit, 25),
    items: arrayValue(catalog.items).map((item) => {
      const task = asObject(item)
      const counts = asObject(task.counts)
      const mode = stringValue(task.mode) === 'research' ? 'research' : 'application'
      return {
        id: stringValue(task.id),
        title: stringValue(task.title) || stringValue(task.id) || '未命名任务',
        mode,
        modeLabel: stringValue(task.modeLabel) || (mode === 'application' ? '岗位任务' : '非岗位任务'),
        status: stringValue(task.status) || 'unknown',
        createdAt: stringValue(task.createdAt),
        updatedAt: stringValue(task.updatedAt) || stringValue(task.createdAt),
        snapshotId: stringValue(task.snapshotId),
        revision: numberValue(task.revision, 0),
        progress: numberValue(task.progress, 0),
        counts: {
          posts: numberValue(counts.posts, 0),
          comments: numberValue(counts.comments, 0),
          users: numberValue(counts.users, 0),
          artifacts: numberValue(counts.artifacts, 0),
        },
      }
    }),
  }
}

function mapContextRecord(value: unknown): DataCopilotContextRecord {
  const record = asObject(value)
  const kind = stringValue(record.kind)
  return {
    sourceId: stringValue(record.sourceId),
    recordId: stringValue(record.recordId),
    kind: kind === 'comment' || kind === 'user' || kind === 'artifact' ? kind : 'post',
    title: stringValue(record.title) || '未命名记录',
    subtitle: stringValue(record.subtitle) || undefined,
    status: stringValue(record.status) || undefined,
    timestamp: stringValue(record.timestamp) || undefined,
    imageUrl: stringValue(record.imageUrl) || undefined,
    url: stringValue(record.url) || undefined,
    fields: arrayValue(record.fields).map((item) => {
      const field = asObject(item)
      return { label: stringValue(field.label), value: stringValue(field.value) }
    }).filter((field) => field.label && field.value),
    body: stringValue(record.body) || undefined,
    images: arrayValue(record.images).map(String).filter(Boolean),
    analysis: record.analysis,
    sections: arrayValue(record.sections).map((item) => {
      const section = asObject(item)
      return {
        sourceId: stringValue(section.sourceId),
        label: stringValue(section.label),
        description: stringValue(section.description) || undefined,
      }
    }).filter((section) => section.sourceId && section.label),
  }
}

function contextRecordKind(value: unknown): DataCopilotRecordKind | undefined {
  const kind = stringValue(value)
  return kind === 'posts' || kind === 'comments' || kind === 'users' || kind === 'artifacts'
    ? kind
    : undefined
}

export function mapDataCopilotMessage(
  value: unknown,
  fallbackSessionId = '',
): DataCopilotMessageData {
  const record = asObject(value)
  const content = asObject(record.content)
  const type = stringValue(content.type) || 'assistant.message'
  const sessionId =
    stringValue(record.conversationId) || stringValue(record.sessionId) || fallbackSessionId
  const approval = type === 'approval.required'
    ? mapApproval(content.approval)
    : undefined
  const toolRunId = stringValue(content.toolRunId)
  const messageId = approval
    ? `approval:${approval.id}`
    : toolRunId
      ? `tool:${toolRunId}`
      : stringValue(record.messageId) || stringValue(record.id) || createLocalId('message')
  const role = roleValue(record.role)
  const error = type === 'run.failed'
  const kind = error
    ? 'error'
    : type === 'assistant.plan'
      ? 'analysis'
      : role === 'tool'
        ? 'tool_result'
        : type === 'run.paused' || type === 'run.completed'
          ? 'status'
          : 'text'
  const toolCalls = role === 'tool'
    ? [mapToolCall({
        id: toolRunId || messageId,
        name: content.name,
        status: error ? 'failed' : 'complete',
        result: content.result,
      })]
    : undefined

  return {
    id: messageId,
    sessionId,
    role,
    kind,
    content: messageText(type, content),
    createdAt: stringValue(record.createdAt) || new Date().toISOString(),
    status: error ? 'failed' : 'complete',
    attachments: arrayValue(record.attachments).map((attachment) => mapAttachment(attachment, sessionId)),
    toolCalls,
    citations: mapCitations(content),
    approval,
    retryable: error && content.recoverable !== false,
  }
}

export function mapDataCopilotEvent(
  value: unknown,
  sessionId: string,
  previousSubagentRun?: DataCopilotSubagentRun,
): {
  message?: DataCopilotMessageData
  session?: DataCopilotSession
  status?: DataCopilotRunStatus
  subagentRun?: DataCopilotSubagentRun
} {
  const event = asObject(value)
  const type = stringValue(event.type) || stringValue(event.event)
  const createdAt = stringValue(event.createdAt) || new Date().toISOString()
  const runId = stringValue(event.runId) || 'current'

  if (isSubagentEvent(type)) {
    return {
      subagentRun: reduceDataCopilotSubagentRun(previousSubagentRun, event, sessionId),
      status: eventStatus(type, event),
    }
  }

  if (isObjectValue(event.message)) {
    const message = mapDataCopilotMessage(event.message, sessionId)
    if (type === 'assistant.message' && runId !== 'current') {
      message.id = `stream:${runId}`
    }
    return {
      message,
      status: eventStatus(type, event),
    }
  }
  if (event.conversation || event.session) {
    return {
      session: mapConversation(event.conversation || event.session),
      status: eventStatus(type, event),
    }
  }
  if (type === 'tool.started' || type === 'tool.progress' || type === 'tool.result') {
    const toolRunId = stringValue(event.toolRunId) || createLocalId('tool')
    const failed = Boolean(event.error)
    const status: DataCopilotToolCall['status'] = failed
      ? 'failed'
      : type === 'tool.result'
        ? 'complete'
        : 'running'
    return {
      message: {
        id: `tool:${toolRunId}`,
        sessionId,
        role: 'tool',
        kind: type === 'tool.result' ? 'tool_result' : 'tool_call',
        content: type === 'tool.progress' ? stringValue(event.message) : '',
        createdAt,
        status: status === 'running' ? 'streaming' : failed ? 'failed' : 'complete',
        toolCalls: [mapToolCall({
          id: toolRunId,
          name: event.name,
          status,
          arguments: event.input,
          result: event.result,
          error: asObject(event.error).message,
        })],
      },
      status: 'executing',
    }
  }
  if (type === 'approval.required') {
    const approval = mapApproval(event.approval)
    return {
      message: {
        id: `approval:${approval.id}`,
        sessionId,
        role: 'assistant',
        kind: 'text',
        content: '此操作需要你的确认。请核对收件人、主题、正文和附件后再决定。',
        createdAt,
        status: 'complete',
        approval,
      },
      status: 'waiting_approval',
    }
  }
  if (type === 'approval.confirmed' || type === 'approval.rejected') {
    const approval = mapApproval(event.approval)
    return {
      message: {
        id: `approval:${approval.id}`,
        sessionId,
        role: 'assistant',
        kind: 'text',
        content: type === 'approval.confirmed' ? '操作已确认，继续执行。' : '操作已取消。',
        createdAt,
        status: 'complete',
        approval,
      },
      status: type === 'approval.confirmed' ? 'executing' : 'paused',
    }
  }
  if (type === 'assistant.plan') {
    return {
      message: {
        id: `plan:${runId}`,
        sessionId,
        role: 'assistant',
        kind: 'analysis',
        content:
          stringValue(event.text) ||
          stringValue(event.message) ||
          jsonText(event.plan || event.steps),
        createdAt,
        status: 'complete',
      },
      status: 'planning',
    }
  }
  if (isAssistantDelta(type) || isReasoningDelta(type)) {
    const reasoning = isReasoningDelta(type)
    return {
      message: {
        id: reasoning ? `reasoning:${runId}` : `stream:${runId}`,
        sessionId,
        role: 'assistant',
        kind: reasoning ? 'analysis' : 'text',
        content:
          stringValue(event.text) ||
          stringValue(event.delta) ||
          stringValue(event.summary) ||
          (typeof event.message === 'string' ? event.message : ''),
        createdAt,
        status: 'streaming',
      },
      status: reasoning ? 'planning' : 'executing',
    }
  }
  if (type === 'verification.failed' || type === 'verification.passed') {
    const passed = type === 'verification.passed'
    const verification = asObject(event.verification)
    const issues = arrayValue(verification.issues)
      .map((item) => stringValue(asObject(item).message))
      .filter(Boolean)
    return {
      message: {
        id: `verification:${runId}`,
        sessionId,
        role: 'assistant',
        kind: 'analysis',
        content: passed
          ? '结果核验通过。'
          : `结果核验未通过，正在自动补充：${issues.join('；') || '缺少完成证据'}`,
        createdAt,
        status: 'complete',
      },
      status: 'executing',
    }
  }
  if (
    type === 'table.result' ||
    type === 'source.list' ||
    type === 'artifact.ready' ||
    type === 'email.draft' ||
    type === 'email.sent' ||
    type === 'application.email_draft' ||
    type === 'application.batch_preflight' ||
    type === 'application.batch'
  ) {
    return {
      message: mapDataCopilotMessage({
        messageId: `${type}:${stringValue(event.toolRunId) || runId}`,
        conversationId: sessionId,
        role: 'tool',
        content: { type, ...event },
        createdAt,
      }, sessionId),
      status: 'executing',
    }
  }
  if (type === 'run.failed' || type === 'run.paused') {
    const error = asObject(event.error)
    const paused = type === 'run.paused'
    return {
      message: {
        id: `run:${runId}:${type}`,
        sessionId,
        role: 'assistant',
        kind: paused ? 'status' : 'error',
        content: stringValue(error.message) || (paused ? '执行已中断，可从断点继续。' : '执行失败。'),
        createdAt,
        status: paused ? 'cancelled' : 'failed',
        retryable: event.resumable !== false,
      },
      status: paused ? 'resumable' : 'failed',
    }
  }
  return { status: eventStatus(type, event) }
}

export function reduceDataCopilotSubagentRun(
  current: DataCopilotSubagentRun | undefined,
  value: unknown,
  sessionId: string,
): DataCopilotSubagentRun | undefined {
  const event = asObject(value)
  const type = stringValue(event.type) || stringValue(event.event)
  if (!isSubagentEvent(type)) return current

  const runId = stringValue(event.runId) || current?.runId
  if (!runId) return current
  const occurredAt = stringValue(event.createdAt) || new Date().toISOString()
  const base: DataCopilotSubagentRun = current?.runId === runId
    ? current
    : {
        runId,
        parentRunId: stringValue(event.parentRunId) || undefined,
        conversationId: stringValue(event.conversationId) || sessionId,
        objective: stringValue(event.objective) || '子 Agent 协作任务',
        status: 'planned',
        tasks: [],
        updatedAt: occurredAt,
      }
  let tasks = [...base.tasks]

  const upsertTask = (
    taskId: string,
    update: (task: DataCopilotSubagentTask) => DataCopilotSubagentTask,
  ) => {
    const index = tasks.findIndex((task) => task.taskId === taskId)
    const existing = index >= 0
      ? tasks[index]
      : createSubagentTask(event, taskId)
    const next = update(existing)
    if (index >= 0) tasks[index] = next
    else tasks.push(next)
  }

  if (type === 'subagent.run.planned') {
    const plannedTasks = arrayValue(event.tasks)
      .map((task) => mapSubagentTask(task))
      .filter((task): task is DataCopilotSubagentTask => Boolean(task))
    tasks = plannedTasks.length ? mergeSubagentTasks(tasks, plannedTasks) : tasks
    const revision = Number(event.planRevision)
    return {
      ...base,
      parentRunId: stringValue(event.parentRunId) || base.parentRunId,
      conversationId: stringValue(event.conversationId) || base.conversationId,
      objective: stringValue(event.objective) || base.objective,
      planRevision: Number.isFinite(revision) ? revision : base.planRevision,
      status: 'planned',
      tasks,
      plannedAt: base.plannedAt || occurredAt,
      updatedAt: occurredAt,
    }
  }

  if (type === 'subagent.run.started') {
    const revision = Number(event.planRevision)
    return {
      ...base,
      parentRunId: stringValue(event.parentRunId) || base.parentRunId,
      conversationId: stringValue(event.conversationId) || base.conversationId,
      objective: stringValue(event.objective) || base.objective,
      planRevision: Number.isFinite(revision) ? revision : base.planRevision,
      status: 'running',
      startedAt: base.startedAt || occurredAt,
      updatedAt: occurredAt,
    }
  }

  const taskId = stringValue(event.taskId)
  if (type === 'subagent.task.started' && taskId) {
    upsertTask(taskId, (task) => ({
      ...task,
      role: stringValue(event.role) || task.role,
      title: stringValue(event.title) || task.title,
      dependsOn: event.dependsOn === undefined ? task.dependsOn : stringList(event.dependsOn),
      status: 'running',
      startedAt: task.startedAt || occurredAt,
    }))
  }
  if (type === 'subagent.output.delta' && taskId) {
    const delta = stringValue(event.delta)
    upsertTask(taskId, (task) => ({
      ...task,
      role: stringValue(event.role) || task.role,
      status: task.status === 'planned' ? 'running' : task.status,
      output: `${task.output}${delta}`,
      startedAt: task.startedAt || occurredAt,
    }))
  }
  if (type === 'subagent.reasoning.delta' && taskId) {
    upsertTask(taskId, (task) => ({
      ...task,
      role: stringValue(event.role) || task.role,
      status: task.status === 'planned' ? 'running' : task.status,
      startedAt: task.startedAt || occurredAt,
    }))
  }
  if (
    (type === 'subagent.tool.started' ||
      type === 'subagent.tool.completed' ||
      type === 'subagent.tool.failed') &&
    taskId
  ) {
    const toolCallId = stringValue(event.toolCallId) || stringValue(event.toolRunId)
    if (toolCallId) {
      upsertTask(taskId, (task) => ({
        ...task,
        role: stringValue(event.role) || task.role,
        status: task.status === 'planned' ? 'running' : task.status,
        tools: upsertSubagentTool(task.tools, {
          toolCallId,
          toolName: stringValue(event.toolName) || stringValue(event.name) || 'tool',
          status: type === 'subagent.tool.started'
            ? 'running'
            : type === 'subagent.tool.completed'
              ? 'completed'
              : 'failed',
          error: mapSubagentError(event.error),
          startedAt: type === 'subagent.tool.started' ? occurredAt : undefined,
          finishedAt: type === 'subagent.tool.started' ? undefined : occurredAt,
        }),
        startedAt: task.startedAt || occurredAt,
      }))
    }
  }
  if (type === 'subagent.task.completed' && taskId) {
    upsertTask(taskId, (task) => ({
      ...task,
      role: stringValue(event.role) || task.role,
      status: 'completed',
      summary: stringValue(event.summary) || task.summary,
      finishedAt: occurredAt,
    }))
  }
  if (type === 'subagent.task.failed' && taskId) {
    upsertTask(taskId, (task) => ({
      ...task,
      role: stringValue(event.role) || task.role,
      status: 'failed',
      error: mapSubagentError(event.error) || { message: '子 Agent 任务失败' },
      finishedAt: occurredAt,
    }))
  }

  if (
    type.startsWith('subagent.task.') || type.startsWith('subagent.output.') ||
    type.startsWith('subagent.tool.') || type === 'subagent.reasoning.delta'
  ) {
    return {
      ...base,
      parentRunId: stringValue(event.parentRunId) || base.parentRunId,
      status: base.status === 'planned' ? 'running' : base.status,
      tasks,
      startedAt: base.startedAt || occurredAt,
      updatedAt: occurredAt,
    }
  }

  if (type === 'subagent.run.receipt' || type === 'subagent.run.cancel.requested') {
    return {
      ...base,
      parentRunId: stringValue(event.parentRunId) || base.parentRunId,
      conversationId: stringValue(event.conversationId) || base.conversationId,
      updatedAt: occurredAt,
    }
  }

  const runStatus = type === 'subagent.run.completed'
    ? 'completed'
    : type === 'subagent.run.paused'
      ? 'paused'
      : type === 'subagent.run.cancelled'
        ? 'cancelled'
      : 'failed'
  const revision = Number(event.planRevision)
  if (runStatus === 'cancelled') {
    tasks = tasks.map((task) => task.status === 'running'
      ? { ...task, status: 'cancelled', finishedAt: occurredAt }
      : task)
  }
  return {
    ...base,
    parentRunId: stringValue(event.parentRunId) || base.parentRunId,
    conversationId: stringValue(event.conversationId) || base.conversationId,
    planRevision: Number.isFinite(revision) ? revision : base.planRevision,
    status: runStatus,
    tasks,
    error: mapSubagentError(event.error) || base.error,
    finishedAt: runStatus === 'paused' ? base.finishedAt : occurredAt,
    updatedAt: occurredAt,
  }
}

function mapSubagentTask(value: unknown): DataCopilotSubagentTask | undefined {
  const task = asObject(value)
  const taskId = stringValue(task.taskId)
  if (!taskId) return undefined
  return createSubagentTask(task, taskId)
}

function createSubagentTask(value: unknown, taskId: string): DataCopilotSubagentTask {
  const task = asObject(value)
  return {
    taskId,
    role: stringValue(task.role) || 'subagent',
    title: stringValue(task.title) || taskId,
    dependsOn: stringList(task.dependsOn),
    status: 'planned',
    output: '',
    tools: [],
  }
}

function mergeSubagentTasks(
  current: DataCopilotSubagentTask[],
  incoming: DataCopilotSubagentTask[],
) {
  const next = [...current]
  for (const task of incoming) {
    const index = next.findIndex((item) => item.taskId === task.taskId)
    if (index === -1) next.push(task)
    else next[index] = { ...task, ...next[index], role: task.role, title: task.title, dependsOn: task.dependsOn }
  }
  return next
}

function upsertSubagentTool(
  current: DataCopilotSubagentTool[],
  incoming: DataCopilotSubagentTool,
) {
  const index = current.findIndex((tool) => tool.toolCallId === incoming.toolCallId)
  if (index === -1) return [...current, incoming]
  const next = [...current]
  next[index] = {
    ...next[index],
    ...incoming,
    startedAt: next[index].startedAt || incoming.startedAt,
  }
  return next
}

function mapSubagentError(value: unknown): DataCopilotSubagentError | undefined {
  if (typeof value === 'string' && value.trim()) return { message: value.trim() }
  const error = asObject(value)
  const message = stringValue(error.message)
  if (!message) return undefined
  return { code: stringValue(error.code) || undefined, message }
}

function stringList(value: unknown) {
  return arrayValue(value).map((item) => stringValue(item)).filter(Boolean)
}

const EVENT_REPLAY_PAGE_SIZE = 200
const EVENT_REPLAY_MAX_PAGES = 1000
const STREAM_EVENT_TYPES = new Set([
  'assistant.delta',
  'assistant.reasoning.delta',
  'message.delta',
  'reasoning.delta',
])

type PendingStreamEvent = {
  event: JsonObject
  explicitText?: string
  deltas: string[]
}

export function subscribeToConversation(
  route: (suffix?: string) => string,
  sessionId: string,
  handlers: DataCopilotSubscriptionHandlers,
) {
  let closed = false
  let eventSource: EventSource | undefined
  let lastProjectedEventId = 0
  let processing = Promise.resolve()
  let scheduledFrame: number | ReturnType<typeof setTimeout> | undefined
  let scheduledWithAnimationFrame = false
  const pendingMessages = new Map<string, DataCopilotMessageData>()
  const pendingSubagentRuns = new Map<string, DataCopilotSubagentRun>()
  const pendingStreamEvents = new Map<string, PendingStreamEvent>()
  const projectEvent = createConversationEventProjector(sessionId)

  const reportError = (error: unknown) => {
    if (closed) return
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  const flushBatchedCallbacks = () => {
    if (pendingMessages.size > 0) {
      const messages = [...pendingMessages.values()]
      pendingMessages.clear()
      handlers.onMessages?.(messages)
    }
    if (pendingSubagentRuns.size > 0) {
      const runs = [...pendingSubagentRuns.values()]
      pendingSubagentRuns.clear()
      handlers.onSubagentRuns?.(runs)
    }
  }

  const scheduleBatchedCallbacks = () => {
    if (closed || scheduledFrame !== undefined) return
    const flush = () => {
      scheduledFrame = undefined
      scheduledWithAnimationFrame = false
      try {
        flushStreamEvents()
        flushBatchedCallbacks()
      } catch (error) {
        reportError(error)
      }
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      scheduledWithAnimationFrame = true
      scheduledFrame = globalThis.requestAnimationFrame(flush)
      return
    }
    scheduledFrame = setTimeout(flush, 16)
  }

  const deliver = (mapped: ReturnType<typeof projectEvent>) => {
    if (mapped.message) {
      if (handlers.onMessages) {
        pendingMessages.set(mapped.message.id, mapped.message)
      } else {
        handlers.onMessage?.(mapped.message)
      }
    }
    if (mapped.session) handlers.onSession?.(mapped.session)
    if (mapped.status) handlers.onStatus?.(mapped.status)
    if (mapped.subagentRun) {
      if (handlers.onSubagentRuns) {
        pendingSubagentRuns.set(mapped.subagentRun.runId, mapped.subagentRun)
      } else {
        handlers.onSubagentRun?.(mapped.subagentRun)
      }
    }
  }

  const projectMappedEvent = (event: JsonObject) => {
    deliver(projectEvent(event))
  }

  const flushStreamEvents = () => {
    if (pendingStreamEvents.size === 0) return
    const events = [...pendingStreamEvents.values()]
    pendingStreamEvents.clear()
    for (const pending of events) {
      const text = pending.explicitText === undefined
        ? pending.deltas.join('')
        : `${pending.explicitText}${pending.deltas.join('')}`
      projectMappedEvent({
        ...pending.event,
        ...(pending.explicitText === undefined ? { delta: text } : { text }),
      })
    }
  }

  const queueStreamEvent = (event: JsonObject) => {
    const type = stringValue(event.type) || stringValue(event.event)
    const runId = stringValue(event.runId) || 'current'
    const key = `${type}:${runId}`
    const current = pendingStreamEvents.get(key) ?? { event, deltas: [] }
    const explicitText = stringValue(event.text)
    const delta =
      stringValue(event.delta) ||
      stringValue(event.summary) ||
      (typeof event.message === 'string' ? event.message : '')
    current.event = event
    if (explicitText) {
      current.explicitText = explicitText
      current.deltas = []
    }
    if (delta) current.deltas.push(delta)
    pendingStreamEvents.set(key, current)
    scheduleBatchedCallbacks()
  }

  const project = (event: JsonObject, eventId = eventSequence(event)) => {
    if (eventId > 0) {
      if (eventId <= lastProjectedEventId) return
      if (eventId !== lastProjectedEventId + 1) {
        throw new Error(
          `Data Copilot event replay is incomplete: expected ${lastProjectedEventId + 1}, received ${eventId}.`,
        )
      }
      lastProjectedEventId = eventId
    }
    const type = stringValue(event.type) || stringValue(event.event)
    if (STREAM_EVENT_TYPES.has(type)) {
      queueStreamEvent(event)
      return
    }
    flushStreamEvents()
    projectMappedEvent(event)
    flushBatchedCallbacks()
  }

  const replayThrough = async (requestedLastEventId?: number) => {
    let replayLastEventId = requestedLastEventId
    for (let pageIndex = 0; pageIndex < EVENT_REPLAY_MAX_PAGES && !closed; pageIndex += 1) {
      if (replayLastEventId !== undefined && lastProjectedEventId >= replayLastEventId) return
      const query = new URLSearchParams({
        format: 'json',
        afterSeq: String(lastProjectedEventId),
        limit: String(EVENT_REPLAY_PAGE_SIZE),
      })
      const payload = asObject(await requestJson(
        route(`/${encodeURIComponent(sessionId)}/events?${query.toString()}`),
      ))
      if (closed) return
      if (replayLastEventId === undefined) {
        replayLastEventId = eventSequence({ eventId: payload.lastSeq })
      }
      const target = replayLastEventId
      if (!target || lastProjectedEventId >= target) return
      const events = arrayValue(payload.events)
        .map((event) => asObject(event))
        .sort((left, right) => eventSequence(left) - eventSequence(right))
      let advanced = false
      for (const event of events) {
        const eventId = eventSequence(event)
        if (eventId <= lastProjectedEventId) continue
        if (eventId > target) break
        project(event, eventId)
        advanced = true
      }
      flushStreamEvents()
      flushBatchedCallbacks()
      if (lastProjectedEventId >= target) return
      if (!advanced) {
        throw new Error(
          `Data Copilot event replay stopped at ${lastProjectedEventId} before ${target}.`,
        )
      }
    }
    if (!closed && replayLastEventId !== undefined && lastProjectedEventId < replayLastEventId) {
      throw new Error(
        `Data Copilot event replay exceeded ${EVENT_REPLAY_MAX_PAGES} pages.`,
      )
    }
  }

  const processEvent = async (event: JsonObject) => {
    if (closed) return
    const type = stringValue(event.type) || stringValue(event.event)
    if (type === 'stream.gap') {
      const payload = asObject(event.payload)
      const gapLastEventId = eventSequence({ eventId: payload.to })
      if (gapLastEventId > lastProjectedEventId) await replayThrough(gapLastEventId)
      return
    }
    const eventId = eventSequence(event)
    if (eventId > 0 && eventId <= lastProjectedEventId) return
    if (eventId > lastProjectedEventId + 1) await replayThrough(eventId - 1)
    project(event, eventId)
  }

  const receive = (raw: MessageEvent<string>) => {
    processing = processing
      .then(() => processEvent(asObject(JSON.parse(raw.data))))
      .catch(reportError)
  }

  const openStream = () => {
    if (closed) return
    const query = new URLSearchParams({ afterEventId: String(lastProjectedEventId) })
    eventSource = new EventSource(
      route(`/${encodeURIComponent(sessionId)}/events?${query.toString()}`),
      { withCredentials: true },
    )
    eventSource.onmessage = receive
    for (const eventName of [
      'ready', 'stream.gap',
      'user.message', 'assistant.message', 'assistant.plan', 'assistant.delta',
      'assistant.reasoning.delta', 'message.delta', 'reasoning.delta', 'tool.started',
      'tool.progress', 'tool.result', 'table.result', 'source.list', 'artifact.ready',
      'email.draft', 'email.sent', 'application.email_draft', 'application.batch_preflight', 'application.batch',
      'approval.required', 'approval.confirmed', 'approval.rejected',
      'verification.failed', 'verification.passed',
      'run.paused', 'run.failed', 'run.completed',
      'subagent.run.planned', 'subagent.run.started',
      'subagent.task.started', 'subagent.output.delta', 'subagent.reasoning.delta',
      'subagent.tool.call.delta', 'subagent.tool.started', 'subagent.tool.completed', 'subagent.tool.failed',
      'subagent.task.completed', 'subagent.task.failed',
      'subagent.run.completed', 'subagent.run.paused', 'subagent.run.cancelled', 'subagent.run.failed',
      'subagent.run.cancel.requested', 'subagent.run.receipt',
    ]) {
      eventSource.addEventListener(eventName, receive as EventListener)
    }
    eventSource.onerror = () => {
      if (!closed && eventSource?.readyState === EventSource.CLOSED) {
        reportError(new Error('Data Copilot 实时连接已断开。'))
      }
    }
  }

  void replayThrough().then(openStream).catch(reportError)
  return () => {
    closed = true
    if (scheduledFrame !== undefined) {
      if (scheduledWithAnimationFrame && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(scheduledFrame as number)
      } else {
        clearTimeout(scheduledFrame as ReturnType<typeof setTimeout>)
      }
      scheduledFrame = undefined
    }
    pendingStreamEvents.clear()
    pendingMessages.clear()
    pendingSubagentRuns.clear()
    eventSource?.close()
  }
}

function eventSequence(value: unknown) {
  const event = asObject(value)
  const sequence = Number(event.eventId ?? event.seq ?? 0)
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0
}

function createConversationEventProjector(sessionId: string) {
  const streams = new Map<string, string>()
  const subagentRuns = new Map<string, DataCopilotSubagentRun>()
  return (value: unknown) => {
    const event = asObject(value)
    const type = stringValue(event.type) || stringValue(event.event)
    const runId = stringValue(event.runId) || 'current'
    if (isSubagentEvent(type)) {
      const mapped = mapDataCopilotEvent(event, sessionId, subagentRuns.get(runId))
      if (mapped.subagentRun) subagentRuns.set(mapped.subagentRun.runId, mapped.subagentRun)
      return mapped
    }
    if (isAssistantDelta(type) || isReasoningDelta(type)) {
      const streamKind = isReasoningDelta(type) ? 'reasoning' : 'answer'
      const key = `${streamKind}:${runId}`
      const explicitText = stringValue(event.text)
      const delta =
        stringValue(event.delta) ||
        stringValue(event.summary) ||
        (typeof event.message === 'string' ? event.message : '')
      const text = explicitText || `${streams.get(key) ?? ''}${delta}`
      streams.set(key, text)
      return mapDataCopilotEvent({ ...event, text }, sessionId)
    }
    if (type === 'assistant.message') streams.delete(`answer:${runId}`)
    if (type === 'run.failed' || type === 'run.paused' || type === 'run.completed') {
      streams.delete(`answer:${runId}`)
      streams.delete(`reasoning:${runId}`)
    }
    return mapDataCopilotEvent(event, sessionId)
  }
}

async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const body = asObject(payload)
    const detail = asObject(body.error)
    const error = new Error(
      stringValue(detail.message) || stringValue(body.message) || `请求失败 (${response.status})`,
    ) as Error & { code?: string; status?: number }
    error.code = stringValue(detail.code) || stringValue(body.code)
    error.status = response.status
    throw error
  }
  return payload
}

function mapSendResult(value: unknown, sessionId: string) {
  const payload = asObject(value)
  const conversation =
    payload.conversation ||
    payload.session ||
    asObject(payload.run).conversation
  return {
    session: conversation ? mapConversation(conversation) : undefined,
    messages: arrayValue(payload.messages).map((message) =>
      mapDataCopilotMessage(message, sessionId),
    ),
  }
}

function mapConversation(value: unknown): DataCopilotSession {
  const conversation = asObject(value)
  const selectedModel = asObject(conversation.selectedModel)
  const runState = asObject(conversation.runState)
  const checkpoint = asObject(runState.checkpoint)
  const workspaceBinding = asObject(checkpoint.workspaceBinding)
  const lastContextSourceIds = arrayValue(conversation.contextSourceIds).map(String)
  const id = stringValue(conversation.conversationId) || stringValue(conversation.id)
  const jobId = stringValue(conversation.jobId)
  const modeLabel = stringValue(conversation.mode) === 'application' ? '岗位' : '非岗位'
  const messageCount = numberValue(
    conversation.messageCount,
    numberValue(asObject(conversation.lastSequences).messages, 0),
  )
  return {
    id,
    title: stringValue(conversation.title) || '新会话',
    createdAt: stringValue(conversation.createdAt) || new Date().toISOString(),
    updatedAt: stringValue(conversation.updatedAt) || new Date().toISOString(),
    messageCount,
    preview: stringValue(conversation.preview) || `${modeLabel} · #${jobId.slice(0, 8)}`,
    status: runStatusValue(conversation.status || runState.status),
    modelId:
      stringValue(selectedModel.aiSessionId) ||
      stringValue(conversation.modelId),
    reasoningEffort: reasoningEffortValue(selectedModel.reasoningEffort),
    contextSourceIds: lastContextSourceIds.length
      ? lastContextSourceIds
      : arrayValue(asObject(conversation.scope).contextSourceIds).map(String),
    jobId,
    mode: stringValue(conversation.mode),
    snapshotId: stringValue(conversation.snapshotId),
    filters: filterLabels(conversation.filters),
    workspaceBinding: stringValue(workspaceBinding.projectId) && stringValue(workspaceBinding.workspaceId)
      ? {
          projectId: stringValue(workspaceBinding.projectId),
          workspaceId: stringValue(workspaceBinding.workspaceId),
          worktreeId: stringValue(workspaceBinding.worktreeId) || undefined,
        }
      : undefined,
  }
}

function mapAttachment(value: unknown, sessionId = ''): DataCopilotAttachment {
  const attachment = asObject(value)
  const id = stringValue(attachment.attachmentId) || stringValue(attachment.id)
  return {
    id,
    name:
      stringValue(attachment.displayName) ||
      stringValue(attachment.originalName) ||
      stringValue(attachment.name) ||
      '附件',
    size: numberValue(attachment.size, 0),
    mediaType: stringValue(attachment.mediaType) || 'application/octet-stream',
    status: attachment.status === 'failed' ? 'failed' : 'ready',
    url: stringValue(attachment.url) || (sessionId && id
      ? `${COPILOT_PATH}/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`
      : undefined),
    error: stringValue(attachment.error) || undefined,
    sourceId: stringValue(attachment.sourceId) || undefined,
  }
}

function mapApproval(value: unknown): DataCopilotApproval {
  const approval = asObject(value)
  return {
    id: stringValue(approval.approvalId) || stringValue(approval.id),
    status: approvalStatus(approval.status),
    summary: stringValue(approval.summary) || '需要确认后才能继续执行。',
    toolName: stringValue(approval.toolName) || undefined,
    riskLevel: stringValue(approval.riskLevel) || undefined,
    arguments: approval.arguments,
    createdAt: stringValue(approval.createdAt) || undefined,
    expiresAt: stringValue(approval.expiresAt) || null,
  }
}

function mapToolCall(value: unknown): DataCopilotToolCall {
  const tool = asObject(value)
  const status = stringValue(tool.status)
  return {
    id: stringValue(tool.id) || createLocalId('tool'),
    name: stringValue(tool.name) || 'tool',
    status:
      status === 'running' || status === 'pending' || status === 'failed' || status === 'cancelled'
        ? status
        : 'complete',
    arguments: tool.arguments,
    result: tool.result,
    error: stringValue(tool.error) || undefined,
  }
}

function mapCitations(content: JsonObject): DataCopilotCitation[] | undefined {
  const result = asObject(content.result)
  const sources = [
    ...arrayValue(content.sources),
    ...sourceValue(content.source),
    ...arrayValue(result.sources),
    ...sourceValue(result.source),
  ]
  if (!sources.length) return undefined
  const citations = sources.map((value, index) => {
    if (typeof value === 'string') {
      return {
        id: value,
        label: sourceLabel(value, index),
        sourceId: value,
        excerpt: value,
      }
    }
    const source = asObject(value)
    const sourceId = stringValue(source.sourceId) || stringValue(source.uri) || stringValue(source.id)
    const url = stringValue(source.url)
    return {
      id: stringValue(source.id) || sourceId || `source-${index + 1}`,
      label: stringValue(source.label) || stringValue(source.title) || sourceLabel(sourceId, index),
      sourceId: sourceId || undefined,
      url: /^https?:\/\//iu.test(url) ? url : undefined,
      excerpt: stringValue(source.excerpt) || sourceId || undefined,
    }
  })
  return citations.filter((citation, index) => (
    citations.findIndex((candidate) => candidate.id === citation.id) === index
  ))
}

function sourceValue(value: unknown): unknown[] {
  return value === undefined || value === null || value === '' ? [] : [value]
}

function sourceLabel(value: string, index: number) {
  const text = String(value || '').trim()
  if (!text) return `数据源 ${index + 1}`
  try {
    const uri = new URL(text)
    const resource = uri.pathname.split('/').filter(Boolean).at(-1)
    return resource ? `数据源 · ${decodeURIComponent(resource)}` : `数据源 ${index + 1}`
  } catch {
    return text.length > 48 ? `${text.slice(0, 45)}...` : text
  }
}

function messageText(type: string, content: JsonObject) {
  if (type === 'user.message' || type === 'assistant.message' || type === 'assistant.plan') {
    return stringValue(content.text) || stringValue(content.message) || jsonText(content.plan || content.steps)
  }
  if (type === 'approval.required') return '此操作需要你的确认。'
  if (type === 'email.draft' || type === 'email.sent') {
    const preview = asObject(content.preview || content.result)
    const recipients = arrayValue(preview.to).map(String).join('、') || stringValue(preview.to)
    const cc = arrayValue(preview.cc).map(String).join('、')
    const bcc = arrayValue(preview.bcc).map(String).join('、')
    const attachments = arrayValue(preview.attachments).map((value) => {
      const attachment = asObject(value)
      const name = stringValue(attachment.displayName) || stringValue(attachment.artifactId) || '附件'
      const size = Number(attachment.size)
      const hash = stringValue(attachment.sha256)
      return `${name}${Number.isFinite(size) ? ` (${formatBytes(size)})` : ''}${hash ? ` · SHA-256 ${hash.slice(0, 12)}…` : ''}`
    })
    return [
      recipients ? `收件人：${recipients}` : '',
      cc ? `抄送：${cc}` : '',
      bcc ? `密送：${bcc}` : '',
      stringValue(preview.replyTo) ? `Reply-To：${stringValue(preview.replyTo)}` : '',
      stringValue(preview.subject) ? `主题：${stringValue(preview.subject)}` : '',
      stringValue(preview.text) || stringValue(preview.body),
      attachments.length ? `附件：\n${attachments.map((item) => `- ${item}`).join('\n')}` : '附件：无',
      stringValue(preview.deliveryMethod) ? `投递：${stringValue(preview.deliveryMethod)} · ${stringValue(preview.deliverySource) || 'configured_smtp'}` : '',
      stringValue(preview.jobRecordSource) ? `岗位数据源：${stringValue(preview.jobRecordSource)}` : '',
      preview.qualityScore !== null && preview.qualityScore !== undefined && Number.isFinite(Number(preview.qualityScore))
        ? `质量分：${Number(preview.qualityScore)}`
        : '',
    ].filter(Boolean).join('\n')
  }
  if (type === 'run.failed') return stringValue(content.message) || '执行失败。'
  if (type === 'artifact.ready') return stringValue(content.message) || '文件已生成，可在产物中查看。'
  if (type === 'table.result') return stringValue(content.message) || '表格结果已返回。'
  if (type === 'source.list') return stringValue(content.message) || '已列出本次使用的数据来源。'
  if (type === 'application.email_draft') return stringValue(content.message) || 'Application email prepared.'
  if (type === 'application.batch_preflight' || type === 'application.batch') {
    return stringValue(content.message) || 'Batch delivery preparation is ready for review.'
  }
  return stringValue(content.text) || stringValue(content.message)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function eventStatus(type: string, event: JsonObject): DataCopilotRunStatus | undefined {
  if (type === 'approval.required') return 'waiting_approval'
  if (type === 'subagent.run.planned') return 'planning'
  if (isSubagentEvent(type)) return 'executing'
  if (type === 'run.completed') return 'completed'
  if (type === 'run.failed') return 'failed'
  if (type === 'run.paused') return 'resumable'
  if (type === 'assistant.plan') return 'planning'
  if (isReasoningDelta(type)) return 'planning'
  if (isAssistantDelta(type)) return 'executing'
  if (type === 'tool.started' || type === 'tool.progress' || type === 'tool.result') return 'executing'
  if (type === 'assistant.message') return 'completed'
  const status = stringValue(event.status)
  return status ? runStatusValue(status) : undefined
}

function runStatusValue(value: unknown): DataCopilotRunStatus {
  const status = stringValue(value)
  if (status === 'cancelling') return 'stopping'
  if (status === 'succeeded') return 'completed'
  if (status === 'queued') return 'planning'
  if (status === 'running') return 'executing'
  if (status === 'interrupted') return 'resumable'
  if (
    status === 'idle' || status === 'planning' || status === 'executing' ||
    status === 'waiting_input' || status === 'waiting_approval' || status === 'stopping' ||
    status === 'paused' || status === 'completed' || status === 'partial' ||
    status === 'failed' || status === 'cancelled' || status === 'resumable'
  ) return status
  return 'idle'
}

function filterLabels(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).slice(0, 20)
  const filters = asObject(value)
  return Object.entries(filters)
    .filter(([, item]) => item !== undefined && item !== null && item !== '')
    .slice(0, 20)
    .map(([key, item]) => `${key}: ${typeof item === 'string' ? item : jsonText(item)}`)
}

function approvalStatus(value: unknown): DataCopilotApproval['status'] {
  const status = stringValue(value)
  if (
    status === 'approved' || status === 'rejected' || status === 'cancelled' ||
    status === 'expired' || status === 'consumed'
  ) return status
  return 'pending'
}

function roleValue(value: unknown): DataCopilotMessageData['role'] {
  return value === 'user' || value === 'tool' || value === 'system' ? value : 'assistant'
}

function objectFrom(value: unknown, key: string): JsonObject {
  const object = asObject(value)
  return asObject(object[key] || object)
}

function arrayFrom(value: unknown, key: string) {
  if (Array.isArray(value)) return value
  return arrayValue(asObject(value)[key])
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function isObjectValue(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isAssistantDelta(type: string) {
  return type === 'assistant.delta' || type === 'message.delta'
}

function isReasoningDelta(type: string) {
  return type === 'assistant.reasoning.delta' || type === 'reasoning.delta'
}

function isSubagentEvent(type: string) {
  return type === 'subagent.run.planned' ||
    type === 'subagent.run.started' ||
    type === 'subagent.task.started' ||
    type === 'subagent.output.delta' ||
    type === 'subagent.reasoning.delta' ||
    type === 'subagent.tool.call.delta' ||
    type === 'subagent.tool.started' ||
    type === 'subagent.tool.completed' ||
    type === 'subagent.tool.failed' ||
    type === 'subagent.task.completed' ||
    type === 'subagent.task.failed' ||
    type === 'subagent.run.completed' ||
    type === 'subagent.run.paused' ||
    type === 'subagent.run.cancelled' ||
    type === 'subagent.run.failed' ||
    type === 'subagent.run.cancel.requested' ||
    type === 'subagent.run.receipt'
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function reasoningEffortValue(value: unknown): DataCopilotReasoningEffort | undefined {
  const effort = stringValue(value)
  return effort === 'none'
    || effort === 'low'
    || effort === 'medium'
    || effort === 'high'
    || effort === 'xhigh'
    || effort === 'max'
    ? effort
    : undefined
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function jsonText(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function createIdempotencyKey(prefix: string) {
  return `${prefix}:${createLocalId('request')}`
}

function createLocalId(prefix: string) {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${value}`
}
