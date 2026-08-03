import type {
  DataCopilotApproval,
  DataCopilotAttachment,
  DataCopilotCitation,
  DataCopilotContextCatalog,
  DataCopilotContextRecord,
  DataCopilotRecordKind,
  DataCopilotTaskCatalog,
  DataCopilotMessageData,
  DataCopilotRunStatus,
  DataCopilotSession,
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
          selectedModel: { aiSessionId: input.modelId || options.aiSessionId || '' },
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
      const payload = await requestJson(
        route(`/${encodeURIComponent(input.sessionId)}/messages`),
        {
          method: 'POST',
          body: JSON.stringify({
            content: input.content,
            aiSessionId: input.modelId || options.aiSessionId || '',
            attachmentIds: input.attachmentIds,
            contextSourceIds: input.contextSourceIds,
            idempotencyKey: createIdempotencyKey('message'),
          }),
        },
      )
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

    async retryMessage(sessionId, messageId) {
      const payload = await requestJson(route(`/${encodeURIComponent(sessionId)}/retry`), {
        method: 'POST',
        body: JSON.stringify({
          messageId,
          aiSessionId: options.aiSessionId || '',
          idempotencyKey: createIdempotencyKey('retry'),
        }),
      })
      return mapSendResult(payload, sessionId)
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

    subscribe(sessionId, handlers) {
      return subscribeToConversation(route, sessionId, handlers)
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
): {
  message?: DataCopilotMessageData
  session?: DataCopilotSession
  status?: DataCopilotRunStatus
} {
  const event = asObject(value)
  const type = stringValue(event.type) || stringValue(event.event)
  const createdAt = stringValue(event.createdAt) || new Date().toISOString()
  const runId = stringValue(event.runId) || 'current'

  if (event.message) {
    return {
      message: mapDataCopilotMessage(event.message, sessionId),
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
    type === 'email.sent'
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

function subscribeToConversation(
  route: (suffix?: string) => string,
  sessionId: string,
  handlers: DataCopilotSubscriptionHandlers,
) {
  const eventSource = new EventSource(
    route(`/${encodeURIComponent(sessionId)}/events`),
    { withCredentials: true },
  )
  let closed = false
  const receive = (raw: MessageEvent<string>) => {
    try {
      const mapped = mapDataCopilotEvent(JSON.parse(raw.data), sessionId)
      if (mapped.message) handlers.onMessage(mapped.message)
      if (mapped.session) handlers.onSession?.(mapped.session)
      if (mapped.status) handlers.onStatus?.(mapped.status)
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
  eventSource.onmessage = receive
  for (const eventName of [
    'ready',
    'user.message', 'assistant.message', 'assistant.plan', 'tool.started',
    'tool.progress', 'tool.result', 'table.result', 'source.list', 'artifact.ready',
    'email.draft', 'email.sent', 'approval.required', 'approval.confirmed', 'approval.rejected',
    'verification.failed', 'verification.passed',
    'run.paused', 'run.failed', 'run.completed',
  ]) {
    eventSource.addEventListener(eventName, receive as EventListener)
  }
  eventSource.onerror = () => {
    if (!closed && eventSource.readyState === EventSource.CLOSED) {
      handlers.onError?.(new Error('Data Copilot 实时连接已断开。'))
    }
  }
  return () => {
    closed = true
    eventSource.close()
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
  const runState = asObject(conversation.runState)
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
      stringValue(asObject(conversation.selectedModel).aiSessionId) ||
      stringValue(conversation.modelId),
    contextSourceIds: lastContextSourceIds.length
      ? lastContextSourceIds
      : arrayValue(asObject(conversation.scope).contextSourceIds).map(String),
    jobId,
    mode: stringValue(conversation.mode),
    snapshotId: stringValue(conversation.snapshotId),
    filters: filterLabels(conversation.filters),
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
  return stringValue(content.text) || stringValue(content.message)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function eventStatus(type: string, event: JsonObject): DataCopilotRunStatus | undefined {
  if (type === 'approval.required') return 'waiting_approval'
  if (type === 'run.completed') return 'completed'
  if (type === 'run.failed') return 'failed'
  if (type === 'run.paused') return 'resumable'
  if (type === 'assistant.plan') return 'planning'
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
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
