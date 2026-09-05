import { expect, test, type Page, type Route } from '@playwright/test'
import path from 'node:path'

const now = '2026-08-02T08:00:00.000Z'
const jobId = 'job-copilot'
const historicalJobId = 'job-history'
const sessionId = 'copilot-existing'
const aiSessionId = 'ai-session-e2e'

type MockState = {
  revision: number
  sessions: Record<string, unknown>[]
  messages: Record<string, unknown>[]
  listQueries: string[]
  createBodies: Record<string, unknown>[]
  sendBodies: Record<string, unknown>[]
  sessionSettingsBodies: Record<string, unknown>[]
  uploads: number
  approvals: number
  cancels: number
  retries: number
  messageLoads: number
  sessionListDelayMs: number
  sseBody?: string
  aiProviders: Record<string, unknown>[]
  modelDiscoveryBaseUrl?: string
  modelDiscoveryModels?: string[]
  modelDiscoveryBodies: Record<string, unknown>[]
  aiSessionBodies: Record<string, unknown>[]
  mcpRequests: { method: string; path: string; body: Record<string, unknown> }[]
  projectRequests: { method: string; path: string; body: Record<string, unknown>; contentType: string | null; idempotencyKey?: string | null }[]
  workspaceToolStatus: 'completed' | 'running' | 'cancelled'
  workspaceBranch: string
  workspaceToolExecutions: Record<string, { toolName: string; input: Record<string, unknown> }>
  codexLaunches: number
}

function job(revision: number) {
  return {
    id: jobId,
    keyword: 'Data Copilot 测试任务',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    revision,
    progress: 100,
    progressPhase: 'done',
    progressLabel: '任务完成',
    progressCurrent: 1,
    progressTotal: 1,
    applicationCount: 0,
    artifactCount: 0,
    artifacts: [],
    resumeAvailable: false,
    config: { analysisMode: 'job', limit: 0, maxScrolls: 60, searchSort: 'latest', maxAgeDays: 0 },
    coverage: { discovered: 1, bodyAttempted: 1, bodySucceeded: 1, applicationInfo: 0, draftsGenerated: 0, qualityPassed: 0 },
  }
}

function conversation(id = sessionId, status = 'waiting_approval', boundJobId = jobId, snapshotId = 'job-r7') {
  return {
    conversationId: id,
    jobId: boundJobId,
    mode: 'application',
    snapshotId,
    title: id === sessionId ? '既有分析会话' : '新会话',
    status,
    createdAt: now,
    updatedAt: now,
    messageCount: 3,
    selectedModel: { aiSessionId },
    scope: { allowedScopes: ['*'], contextSourceIds: ['dataset:content'] },
  }
}

function contextPost(id: string, title: string, boundJobId = jobId) {
  const sourceId = `xhs-context://jobs/${boundJobId}/posts/${id}?section=record`
  const imageUrl = `https://sns-webpic-qc.xhscdn.com/test/${id}.webp`
  return {
    sourceId,
    recordId: id,
    kind: 'post',
    title,
    subtitle: `${title} 的完整正文摘要`,
    status: 'succeeded',
    timestamp: now,
    imageUrl,
    url: `https://example.test/posts/${id}`,
    fields: [{ label: '记录 ID', value: id }, { label: '发布时间', value: now }],
    body: `${title} 的正文内容，用于验证记录详情与精确上下文选择。`,
    images: [imageUrl],
    analysis: { summary: `${title} 的既有分析` },
    sections: [
      { sourceId, label: '整条记录', description: '标题、正文、时间与来源链接' },
      { sourceId: `xhs-context://jobs/${boundJobId}/posts/${id}?section=body`, label: '正文', description: '完整正文内容' },
      { sourceId: `xhs-context://jobs/${boundJobId}/posts/${id}?section=images`, label: '图片', description: '原帖图片' },
      { sourceId: `xhs-context://jobs/${boundJobId}/posts/${id}?section=analysis`, label: 'AI 分析', description: '已有分析' },
    ],
  }
}

function historicalContextPost() {
  const post = contextPost('history-post-1', '亚比女历史帖子', historicalJobId)
  const expiredCover = 'https://sns-webpic-qc.xhscdn.com/test/expired-cover.webp'
  return { ...post, imageUrl: expiredCover, images: [expiredCover, ...post.images] }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function sse(events: Record<string, unknown>[]) {
  return [
    'event: ready\ndata: {"type":"ready"}\n\n',
    ...events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`),
  ].join('')
}

async function installApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/health') return json(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: false } })
    if (path === '/api/codex-desktop/launch' && method === 'POST') {
      state.codexLaunches += 1
      return json(route, {
        launched: true,
        mode: 'native',
        version: '26.803.81509',
        buildNumber: '6415',
        runtimeRoot: 'C:\\workspace\\output\\codex-desktop-runtime-55d9fb967596',
        executablePath: 'C:\\workspace\\output\\codex-desktop-runtime-55d9fb967596\\app\\ChatGPT.exe',
        pid: 3210,
        launchedAt: now,
        workspaceRoot: 'C:\\workspace',
      })
    }
    if (path === `/api/jobs/${jobId}/media` || path === `/api/jobs/${historicalJobId}/media`) {
      if (path === `/api/jobs/${historicalJobId}/media` && url.searchParams.get('url')?.includes('expired-cover')) {
        return route.fulfill({ status: 410, contentType: 'text/plain', body: 'expired' })
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMgABYwMDAAANgYCAj6p4nEAAAAASUVORK5CYII=', 'base64'),
      })
    }
    if (path === '/api/jobs' && method === 'GET') return json(route, [job(state.revision)])
    if (path === '/api/relay/config') return json(route, { port: 18800, profile: 'openclaw', autoConnect: false })
    if (path === '/api/relay/status') return json(route, { running: true, cdpReady: true, ready: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800, profile: 'openclaw' })
    if (path === '/api/email/config') return json(route, { configured: false, verified: false, authMode: 'none', oauth: {} })
    if (path === '/api/ai/providers') return json(route, state.aiProviders)
    if (path === '/api/ai/local-models') return json(route, { runtime: { ready: false }, catalog: [], installedModels: [], install: null, fetchedAt: now })
    if (path === '/api/ai/models' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.modelDiscoveryBodies.push(body)
      return json(route, {
        provider: body.provider,
        baseUrl: state.modelDiscoveryBaseUrl || body.baseUrl,
        models: state.modelDiscoveryModels || ['relay-model-a', 'relay-model-b'],
        fetchedAt: now,
      })
    }
    if (path === '/api/ai/sessions' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.aiSessionBodies.push(body)
      return json(route, {
        id: aiSessionId,
        provider: body.provider || 'codex',
        model: body.model || 'gpt-5.6-sol',
        baseUrl: body.baseUrl || 'http://127.0.0.1',
        wireApi: body.wireApi || 'responses',
        configured: true,
        expiresAt: '2099-08-02T08:00:00.000Z',
      })
    }
    if (path === '/api/profiles') return json(route, [])
    if (path === `/api/jobs/${jobId}/results`) return json(route, { available: true, analysisMode: 'job', keyword: 'Data Copilot 测试任务', research: null, presentation: null, insights: null, total: 0, offset: 0, limit: 20, items: [], filters: { sort: 'newest', timeRange: 'all', stats: { all: 0, dated: 0, unknown: 0, incomplete: 0, withImages: 0 } }, codexRuntime: { status: 'completed' }, qualityGate: { passed: true } })
    if (path === `/api/jobs/${jobId}/artifacts`) return json(route, [])
    if (path === `/api/jobs/${jobId}`) return json(route, job(state.revision))

    if (path.endsWith('/events')) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: state.sseBody || 'event: ready\ndata: {"type":"ready"}\n\n',
      })
    }
    if (path === '/api/copilot/context/jobs' && method === 'GET') {
      return json(route, {
        schemaVersion: 1,
        total: 2,
        offset: 0,
        limit: 25,
        items: [
          { id: jobId, title: 'Data Copilot 测试任务', mode: 'application', modeLabel: '岗位任务', status: 'completed', createdAt: now, updatedAt: now, snapshotId: `job-r${state.revision}`, revision: state.revision, progress: 100, counts: { posts: 2, comments: 1, users: 1, artifacts: 3 } },
          { id: historicalJobId, title: '亚比女历史采集', mode: 'application', modeLabel: '岗位任务', status: 'completed', createdAt: '2026-08-01T07:00:00.000Z', updatedAt: '2026-08-01T08:00:00.000Z', snapshotId: 'job-r12', revision: 12, progress: 100, counts: { posts: 1, comments: 24, users: 13, artifacts: 2 } },
        ],
      })
    }
    if (path === '/api/copilot/context' && method === 'GET') {
      const boundJobId = url.searchParams.get('jobId') || jobId
      const kind = url.searchParams.get('kind')
      if (!kind) return json(route, { schemaVersion: 1, jobId: boundJobId, mode: 'application', counts: boundJobId === historicalJobId ? { posts: 1, comments: 24, users: 13, artifacts: 2 } : { posts: 2, comments: 1, users: 1, artifacts: 3 } })
      const items = kind === 'posts'
        ? boundJobId === historicalJobId
          ? [historicalContextPost()]
          : [contextPost('post-1', '第一条采集帖子'), contextPost('post-2', '第二条采集帖子')]
        : kind === 'artifacts' && boundJobId === historicalJobId
          ? [{ sourceId: `xhs-context://jobs/${historicalJobId}/artifacts/audience-report.json?section=record`, recordId: 'audience-report.json', kind: 'artifact', title: '受众分析报告.json', subtitle: 'audience-report.json', status: '可用', timestamp: now, fields: [{ label: '相对路径', value: 'audience-report.json' }], sections: [{ sourceId: `xhs-context://jobs/${historicalJobId}/artifacts/audience-report.json?section=record`, label: '完整产物', description: '任务产物' }] }]
          : []
      return json(route, { schemaVersion: 1, jobId: boundJobId, mode: 'application', kind, total: items.length, offset: 0, limit: 25, items })
    }
    if (path === '/api/copilot/capabilities' && method === 'GET') {
      return json(route, {
        schemaVersion: 1,
        localRuntime: {
          workspaceRoot: 'C:\\workspace\\project',
          exec: true,
          filesystem: true,
          http: true,
        },
        outboundMcp: { initialized: true, toolCount: 2 },
      })
    }
    if (path === '/api/copilot/projects' && method === 'GET') {
      return json(route, {
        schemaVersion: 1,
        projects: [{
          id: 'project-fixture',
          name: 'Fixture project',
          rootPath: 'C:\\workspace\\fixture',
          description: 'E2E workspace fixture',
          status: 'active',
        }],
      })
    }
    if (path === '/api/copilot/projects' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.projectRequests.push({
        method,
        path,
        body,
        contentType: await request.headerValue('content-type'),
        idempotencyKey: await request.headerValue('idempotency-key'),
      })
      return json(route, {
        schemaVersion: 1,
        project: {
          id: 'project-created',
          name: String(body.name || ''),
          rootPath: String(body.rootPath || ''),
          description: typeof body.description === 'string' ? body.description : null,
          status: 'active',
        },
      }, 201)
    }
    const workspaceList = path.match(/^\/api\/copilot\/projects\/([^/]+)\/workspaces$/)
    if (workspaceList && method === 'GET') {
      const projectId = workspaceList[1]
      return json(route, {
        schemaVersion: 1,
        project: { id: projectId, name: projectId === 'project-created' ? 'E2E project' : 'Fixture project' },
        workspaces: projectId === 'project-fixture'
          ? [{ id: 'workspace-fixture', projectId, name: 'shared fixture', kind: 'shared', rootPath: 'C:\\workspace\\fixture', status: 'ready' }]
          : [],
      })
    }
    if (workspaceList && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.projectRequests.push({
        method,
        path,
        body,
        contentType: await request.headerValue('content-type'),
        idempotencyKey: await request.headerValue('idempotency-key'),
      })
      return json(route, {
        schemaVersion: 1,
        workspace: {
          id: 'workspace-created',
          projectId: workspaceList[1],
          name: String(body.name || ''),
          kind: body.kind === 'worktree' ? 'worktree' : 'shared',
          rootPath: 'C:\\workspace\\e2e-project',
          branch: typeof body.branch === 'string' ? body.branch : null,
          ref: typeof body.ref === 'string' ? body.ref : null,
          status: 'ready',
        },
      }, 201)
    }
    const workspaceTool = path.match(/^\/api\/copilot\/projects\/([^/]+)\/workspaces\/([^/]+)\/tools\/([^/]+)$/)
    if (workspaceTool && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      const toolName = workspaceTool[3]
      const toolExecutionId = toolName === 'exec.run'
        ? 'workspace-tool-e2e'
        : `workspace-tool-e2e-${toolName.replaceAll('.', '-')}`
      state.workspaceToolExecutions[toolExecutionId] = { toolName, input: body }
      state.projectRequests.push({
        method,
        path,
        body,
        contentType: await request.headerValue('content-type'),
        idempotencyKey: await request.headerValue('idempotency-key'),
      })
      if (state.workspaceToolStatus === 'completed') {
        if (toolName === 'git.branch.create' && body.checkout === true && typeof body.name === 'string') {
          state.workspaceBranch = body.name
        }
        if (toolName === 'git.branch.switch' && typeof body.name === 'string') {
          state.workspaceBranch = body.name
        }
      }
      return json(route, {
        schemaVersion: 1,
        project: { id: workspaceTool[1], name: 'E2E project' },
        workspace: {
          id: workspaceTool[2],
          name: 'E2E workspace',
          kind: workspaceTool[2] === 'workspace-created' ? 'worktree' : 'shared',
        },
        receipt: {
          type: 'capability.receipt',
          status: state.workspaceToolStatus,
          tool: { name: toolName, source: toolName.startsWith('git.') ? 'git' : 'workspace', risk: 'approval_required' },
          toolRunId: toolExecutionId,
          toolExecutionId,
          result: state.workspaceToolStatus === 'completed'
            ? projectWorkspaceToolResult(toolName, body, state.workspaceBranch)
            : undefined,
        },
      })
    }
    const workspaceToolCancellation = path.match(/^\/api\/copilot\/projects\/([^/]+)\/workspaces\/([^/]+)\/tool-executions\/([^/]+)\/cancel$/)
    if (workspaceToolCancellation && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.projectRequests.push({
        method,
        path,
        body,
        contentType: await request.headerValue('content-type'),
        idempotencyKey: await request.headerValue('idempotency-key'),
      })
      state.workspaceToolStatus = 'cancelled'
      return json(route, {
        schemaVersion: 1,
        project: { id: workspaceToolCancellation[1], name: 'E2E project' },
        workspace: { id: workspaceToolCancellation[2], projectId: workspaceToolCancellation[1], name: 'E2E workspace', kind: 'shared', rootPath: 'C:\\workspace\\fixture' },
        receipt: {
          type: 'capability.receipt',
          status: 'cancelled',
          tool: 'exec.run',
          toolRunId: 'workspace-tool-e2e',
          toolExecutionId: workspaceToolCancellation[3],
          error: { code: 'TOOL_EXECUTION_CANCELLED', message: String(body.reason || 'cancelled') },
        },
      })
    }
    const workspaceToolExecution = path.match(/^\/api\/copilot\/projects\/([^/]+)\/workspaces\/([^/]+)\/tool-executions\/([^/]+)$/)
    if (workspaceToolExecution && method === 'GET') {
      const toolExecutionId = workspaceToolExecution[3]
      const execution = state.workspaceToolExecutions[toolExecutionId] || {
        toolName: 'exec.run',
        input: { command: 'node' },
      }
      state.projectRequests.push({
        method,
        path,
        body: {},
        contentType: await request.headerValue('content-type'),
        idempotencyKey: await request.headerValue('idempotency-key'),
      })
      return json(route, {
        schemaVersion: 1,
        project: { id: workspaceToolExecution[1], name: 'E2E project' },
        workspace: { id: workspaceToolExecution[2], projectId: workspaceToolExecution[1], name: 'E2E workspace', kind: 'worktree', rootPath: 'C:\\workspace\\e2e-project' },
        receipt: {
          type: 'capability.receipt',
          status: state.workspaceToolStatus,
          tool: execution.toolName,
          toolRunId: toolExecutionId,
          toolExecutionId,
          result: state.workspaceToolStatus === 'completed'
            ? projectWorkspaceToolResult(execution.toolName, execution.input, state.workspaceBranch)
            : undefined,
          error: state.workspaceToolStatus === 'cancelled'
            ? { code: 'TOOL_EXECUTION_CANCELLED', message: 'user_cancelled' }
            : undefined,
        },
        events: projectWorkspaceToolEvents(state.workspaceToolStatus),
      })
    }
    const workspaceDetail = path.match(/^\/api\/copilot\/projects\/([^/]+)\/workspaces\/([^/]+)$/)
    if (workspaceDetail && method === 'GET') {
      return json(route, {
        schemaVersion: 1,
        project: { id: workspaceDetail[1], name: 'E2E project' },
        workspace: {
          id: workspaceDetail[2],
          projectId: workspaceDetail[1],
          name: 'E2E workspace',
          kind: workspaceDetail[2] === 'workspace-created' ? 'worktree' : 'shared',
          rootPath: 'C:\\workspace\\e2e-project',
          branch: workspaceDetail[2] === 'workspace-created' ? 'codex/e2e-worktree' : null,
          status: 'ready',
        },
        status: { branch: state.workspaceBranch, dirty: false, ahead: 0, behind: 0 },
      })
    }
    if (path === '/api/copilot/mcp/servers' && method === 'GET') {
      return json(route, {
        schemaVersion: 1,
        servers: [{
          id: 'analysis-tools',
          label: 'Analysis Tools',
          enabled: true,
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          envKeys: ['MCP_TOKEN'],
          readOnlyTools: ['search'],
          headerEnv: {},
          status: 'connected',
          lastError: null,
          toolCount: 2,
          connectedAt: now,
        }],
        tools: [
          { name: 'mcp.analysis-tools.search', serverId: 'analysis-tools' },
          { name: 'mcp.analysis-tools.transform', serverId: 'analysis-tools' },
        ],
      })
    }
    if (path.match(/^\/api\/copilot\/mcp\/servers\/[^/]+$/) && (method === 'PUT' || method === 'DELETE')) {
      const body = method === 'DELETE' ? {} : request.postDataJSON() as Record<string, unknown>
      state.mcpRequests.push({ method, path, body })
      return json(route, { schemaVersion: 1, ok: true })
    }
    if (path === '/api/copilot/mcp/refresh' && method === 'POST') {
      state.mcpRequests.push({ method, path, body: request.postDataJSON() as Record<string, unknown> })
      return json(route, { schemaVersion: 1, servers: [], tools: [] })
    }
    if (path.match(/^\/api\/copilot\/mcp\/servers\/[^/]+\/refresh$/) && method === 'POST') {
      state.mcpRequests.push({ method, path, body: request.postDataJSON() as Record<string, unknown> })
      return json(route, { schemaVersion: 1, servers: [], tools: [] })
    }
    if (path === '/api/copilot/conversations' && method === 'GET') {
      state.listQueries.push(url.search)
      if (state.sessionListDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.sessionListDelayMs))
      }
      return json(route, { conversations: state.sessions })
    }
    if (path === '/api/copilot/conversations' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.createBodies.push(body)
      const created = {
        ...conversation(
        'copilot-created',
        'idle',
        String(body.jobId || jobId),
        String(body.snapshotId || 'job-r7'),
        ),
        selectedModel: typeof body.selectedModel === 'object' && body.selectedModel !== null
          ? body.selectedModel as Record<string, unknown>
          : { aiSessionId },
      }
      state.sessions = [created]
      return json(route, { conversation: created }, 201)
    }
    const conversationSettings = path.match(/^\/api\/copilot\/conversations\/([^/]+)$/)
    if (conversationSettings && method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.sessionSettingsBodies.push(body)
      const existing = state.sessions.find((session) => String(session.conversationId) === conversationSettings[1])
      const selectedModel = typeof body.selectedModel === 'object' && body.selectedModel !== null
        ? body.selectedModel as Record<string, unknown>
        : {}
      const updated = {
        ...(existing ?? conversation(conversationSettings[1], 'idle')),
        selectedModel: {
          ...((existing?.selectedModel as Record<string, unknown> | undefined) ?? {}),
          ...selectedModel,
        },
      }
      state.sessions = state.sessions.map((session) =>
        String(session.conversationId) === conversationSettings[1] ? updated : session,
      )
      return json(route, { conversation: updated })
    }
    if (path.match(/^\/api\/copilot\/conversations\/[^/]+\/messages$/) && method === 'GET') {
      state.messageLoads += 1
      return json(route, { messages: state.messages })
    }
    if (path.match(/^\/api\/copilot\/conversations\/[^/]+\/attachments$/) && method === 'POST') {
      state.uploads += 1
      await new Promise((resolve) => setTimeout(resolve, 120))
      return json(route, { attachment: { attachmentId: 'attachment-1', displayName: 'brief.txt', size: 12, mediaType: 'text/plain', status: 'ready' } }, 201)
    }
    if (path.match(/^\/api\/copilot\/conversations\/[^/]+\/messages$/) && method === 'POST') {
      state.sendBodies.push(request.postDataJSON() as Record<string, unknown>)
      return json(route, { conversation: conversation(path.includes('copilot-created') ? 'copilot-created' : sessionId, 'cancelled'), messages: [] })
    }
    if (path.endsWith('/cancel') && method === 'POST') {
      state.cancels += 1
      return json(route, { conversation: conversation(sessionId, 'cancelled') })
    }
    if (path.endsWith('/retry') && method === 'POST') {
      state.retries += 1
      return json(route, { conversation: conversation(sessionId, 'running'), messages: [] })
    }
    if (path.includes('/approvals/') && path.endsWith('/confirm') && method === 'POST') {
      state.approvals += 1
      return json(route, { run: { conversation: conversation(sessionId, 'running') }, messages: [] })
    }

    return json(route, {})
  })
}

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    revision: 7,
    sessions: [conversation()],
    messages: [
      { messageId: 'message-user', conversationId: sessionId, role: 'user', content: { type: 'user.message', text: '分析当前任务' }, createdAt: now },
      { messageId: 'message-tool', conversationId: sessionId, role: 'tool', content: { type: 'table.result', toolRunId: 'tool-source', name: 'records.query', result: { rows: [], source: `xhs-data://jobs/${jobId}/content` } }, createdAt: now },
      { messageId: 'message-approval', conversationId: sessionId, role: 'assistant', content: { type: 'approval.required', approval: { approvalId: 'approval-1', status: 'pending', summary: '发送分析邮件', toolName: 'send_email' } }, createdAt: now },
      { messageId: 'message-failed', conversationId: sessionId, role: 'assistant', content: { type: 'run.failed', message: '执行失败', recoverable: true }, createdAt: now },
    ],
    listQueries: [],
    createBodies: [],
    sendBodies: [],
    sessionSettingsBodies: [],
    uploads: 0,
    approvals: 0,
    cancels: 0,
    retries: 0,
    messageLoads: 0,
    sessionListDelayMs: 0,
    aiProviders: [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'gpt-5.6-sol', models: ['gpt-5.6-sol'], requiresKey: false, wireApi: 'responses', configured: true, hasApiKey: true }],
    modelDiscoveryBodies: [],
    aiSessionBodies: [],
    mcpRequests: [],
    projectRequests: [],
    workspaceToolStatus: 'completed',
    workspaceBranch: 'main',
    workspaceToolExecutions: {},
    codexLaunches: 0,
    ...overrides,
  }
}

function projectWorkspaceToolResult(toolName: string, input: Record<string, unknown>, currentBranch = 'main') {
  if (toolName === 'exec.run') return { stdout: `executed ${String(input.command || '')}`, stderr: '' }
  if (toolName === 'git.branch') {
    return {
      type: 'git.branch.receipt',
      current: currentBranch,
      branches: [
        { name: 'main', current: currentBranch === 'main', revision: 'abc1234' },
        { name: 'codex/existing-branch', current: false, revision: 'abc1234' },
        ...(currentBranch !== 'main' && currentBranch !== 'codex/existing-branch'
          ? [{ name: currentBranch, current: true, revision: 'abc1234' }]
          : []),
      ],
    }
  }
  if (toolName === 'git.branch.create') {
    const name = String(input.name || '')
    return {
      type: 'git.branch.create.receipt',
      name,
      checkout: input.checkout === true,
      current: input.checkout === true ? name : 'main',
      branch: { name, current: input.checkout === true, revision: 'abc1234' },
    }
  }
  if (toolName === 'git.branch.switch') {
    const name = String(input.name || '')
    return {
      type: 'git.branch.switch.receipt',
      name,
      current: name,
      revision: 'abc1234',
      status: { branch: name, revision: 'abc1234' },
    }
  }
  return { content: 'fixture result' }
}

function projectWorkspaceToolEvents(status: MockState['workspaceToolStatus']) {
  const events = [
    { eventId: 'workspace-tool-e2e-queued', sequence: 1, type: 'tool.execution.queued', occurredAt: now },
    { eventId: 'workspace-tool-e2e-claimed', sequence: 2, type: 'tool.execution.claimed', occurredAt: now },
    { eventId: 'workspace-tool-e2e-started', sequence: 3, type: 'tool.execution.started', occurredAt: now },
  ]
  if (status === 'completed') {
    events.push({ eventId: 'workspace-tool-e2e-completed', sequence: 4, type: 'tool.execution.completed', occurredAt: now })
  } else if (status === 'cancelled') {
    events.push({ eventId: 'workspace-tool-e2e-cancel-requested', sequence: 4, type: 'tool.execution.cancel_requested', occurredAt: now })
    events.push({ eventId: 'workspace-tool-e2e-cancelled', sequence: 5, type: 'tool.execution.cancelled', occurredAt: now })
  }
  return events
}

test('opens the complete Codex surface directly inside the browser', async ({ page }) => {
  test.setTimeout(120_000)
  const state = baseState()
  await installApi(page, state)
  await page.route('**/api/codex-browser/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        backend: {
          initialized: true,
          modelProvider: { configured: true, id: 'xhs_product_api', model: 'gpt-5.6-sol', wireApi: 'responses' },
          dynamicMcp: { tools: 70, calls: 2, completed: 2, failed: 0 },
        },
        modelBridge: {
          configured: true,
          requests: 3,
          completed: 3,
          failed: 0,
          upstream: { configured: true, provider: 'relay', model: 'gpt-5.6-sol', wireApi: 'chat_completions' },
        },
      }),
    })
  })
  await page.route('**/api/codex-relay/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        adapter: { state: 'compatible' },
        device: { id: 'local', name: 'This Windows device', online: true },
        modes: { nativeMirror: { available: true } },
        ice: { turnConfigured: true },
      }),
    })
  })
  await page.route('**/api/xhs-context/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        service: 'xhs-context',
        rootDir: 'C:/fixture/context',
        transport: 'loopback-http',
        localOnly: true,
        indexMode: 'token-index',
        fts5Available: false,
        bundles: 4,
        bytes: 1024,
        records: 128,
        mcp: { endpoint: 'http://127.0.0.1/api/xhs-context/mcp', credentialFile: 'fixture', header: 'X-Xhs-Context-Token' },
      }),
    })
  })
  await page.route('**/api/codex-product/integration', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        workspace: { schemaVersion: 1, source: null, history: [], activeJobId: null, generatedAt: now },
        mcp: { embedded: ['xhs-context', 'codex-product'], localInstall: { command: 'fixture', bridgeScript: 'fixture', requiresLocalProduct: true, includes: Array.from({ length: 26 }, (_, index) => `tool-${index}`) } },
        launch: { workspaceRoot: 'C:/fixture', endpoint: '/api/codex-desktop/launch' },
        sourceDownload: { path: '/api/codex-product/source-archive', format: 'tar.gz', excludesSecrets: true },
      }),
    })
  })
  await page.route('**/codex/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><main data-testid="codex-runtime">Codex browser runtime</main></body></html>',
    })
  })
  await page.goto('/', { waitUntil: 'commit' })

  const launchButton = page.getByRole('button', { name: 'Codex' })
  await expect(launchButton).toBeVisible({ timeout: 60_000 })
  await expect(launchButton).toBeEnabled()
  await page.screenshot({ path: 'output/playwright/codex-entry-desktop.png', fullPage: true })
  await launchButton.click()
  const surface = page.getByRole('dialog', { name: 'Codex 浏览器工作台' })
  await expect(surface).toBeVisible()
  await expect(page.frameLocator('iframe[title="Codex"]').getByTestId('codex-runtime')).toBeVisible()
  await expect(surface.getByText('API gpt-5.6-sol · 70 MCP tools · 3/3 turns')).toBeVisible()
  await page.screenshot({ path: 'output/playwright/codex-surface-desktop.png', fullPage: true })
  await expect(page.getByRole('link', { name: '在新标签页打开 Codex' })).toHaveAttribute('href', '/codex/')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(surface).toBeVisible()
  const mobileRuntime = surface.getByText('API gpt-5.6-sol · 70 tools')
  const mobileContextActions = surface.locator('.codex-product-context-actions')
  const mobileDesktopFacts = surface.locator('.codex-product-context-facts > span:not(.codex-product-runtime-state)')
  await expect(mobileRuntime).toBeVisible()
  await expect(surface.locator('.codex-product-workspace-summary')).toBeHidden()
  await expect(mobileDesktopFacts).toHaveCount(5)
  expect(await mobileDesktopFacts.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).display === 'none'))).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect.poll(async () => {
    const runtimeBox = await mobileRuntime.boundingBox()
    const actionsBox = await mobileContextActions.boundingBox()
    return Boolean(runtimeBox && actionsBox && runtimeBox.x + runtimeBox.width <= actionsBox.x)
  }).toBe(true)
  await page.screenshot({ path: 'output/playwright/codex-entry-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '关闭 Codex' }).click()
  await expect(surface).toBeHidden()
})

test('renders the legacy data assistant across desktop and mobile panes', async ({ page }) => {
  const state = baseState()
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-layout', 'codex')
  await expect(dialog.locator('.data-copilot-session-rail')).toBeVisible()
  await expect(dialog.locator('.data-copilot-conversation')).toBeVisible()
  await expect(dialog.locator('.data-copilot-context-pane')).toBeVisible()
  await expect(dialog.locator('.data-copilot-composer')).toBeVisible()
  await expect(dialog.locator('.data-copilot-tool-summary')).toBeVisible()
  await expect(dialog.getByRole('tab', { name: /执行/ })).toBeVisible()
  await dialog.screenshot({ path: 'output/playwright/data-copilot-codex-desktop.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileNav = dialog.locator('.data-copilot-mobile-nav')
  await expect(mobileNav).toBeVisible()
  await mobileNav.locator('button').nth(2).click()
  await expect(dialog.locator('.data-copilot-context-pane')).toBeVisible()
  await expect(dialog.locator('.data-copilot-conversation')).toBeHidden()
  await mobileNav.locator('button').nth(1).click()
  await expect(dialog.locator('.data-copilot-conversation')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await dialog.screenshot({ path: 'output/playwright/data-copilot-codex-mobile.png' })
})

test('prefills an evidence-first deep audience strategy brief from the composer shortcut', async ({ page }) => {
  const state = baseState({
    sessions: [{ ...conversation(sessionId, 'idle'), mode: 'content' }],
    messages: [],
  })
  await installApi(page, state)
  await page.route('**/api/copilot/context/jobs', async (route) => {
    await json(route, {
      schemaVersion: 1,
      total: 1,
      offset: 0,
      limit: 25,
      items: [{
        id: jobId,
        title: 'Data Copilot 内容测试任务',
        mode: 'content',
        modeLabel: '内容任务',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        snapshotId: 'job-r7',
        revision: 7,
        progress: 100,
        counts: { posts: 2, comments: 24, users: 13, artifacts: 3 },
      }],
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  const shortcut = dialog.getByRole('button', { name: '深度受众策略' })
  await expect(shortcut).toBeVisible()
  await shortcut.click()

  const composer = dialog.getByRole('textbox', { name: '发送给 Data Copilot' })
  await expect(composer).toHaveValue(/audience\.research_brief/u)
  await expect(composer).toHaveValue(/唯一文本数/u)
  await expect(composer).toHaveValue(/需求优先级矩阵/u)
  await expect(composer).toHaveValue(/争议与品牌风险图/u)
  await expect(composer).toHaveValue(/成功阈值/u)
})

test('projects workspace edits and command output into task inspector tabs', async ({ page }) => {
  const state = baseState({
    sessions: [conversation(sessionId, 'completed')],
    messages: [],
    sseBody: sse([
      {
        type: 'tool.result',
        conversationId: sessionId,
        runId: 'run-inspector',
        toolRunId: 'tool-workspace-patch',
        name: 'workspace.patch',
        input: { path: 'src/insights.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
        result: { path: 'src/insights.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
        createdAt: now,
      },
      {
        type: 'tool.result',
        conversationId: sessionId,
        runId: 'run-inspector',
        toolRunId: 'tool-exec-run',
        name: 'exec.run',
        input: { command: 'npm run test:unit', cwd: 'C:\\workspace\\fixture' },
        result: { stdout: 'PASS src/insights.test.ts', stderr: '' },
        createdAt: now,
      },
      {
        type: 'assistant.message',
        conversationId: sessionId,
        runId: 'run-inspector',
        message: {
          messageId: 'assistant-inspector-complete',
          conversationId: sessionId,
          role: 'assistant',
          content: { type: 'assistant.message', text: '文件变更和测试均已完成。' },
          createdAt: now,
        },
        createdAt: now,
      },
    ]),
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: /变更/ }).click()
  const changes = dialog.getByTestId('copilot-inspector-changes')
  await expect(changes).toContainText('src/insights.ts')
  await expect(changes).toContainText('@@ -1 +1 @@')
  await changes.getByRole('button', { name: '交给 Agent 审查' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(String(state.sendBodies[0].content)).toContain('审查当前工作区中 src/insights.ts')

  await dialog.getByRole('tab', { name: /终端/ }).click()
  const terminal = dialog.getByTestId('copilot-inspector-terminal')
  await expect(terminal).toContainText('npm run test:unit')
  await expect(terminal).toContainText('PASS src/insights.test.ts')
  await dialog.screenshot({ path: 'output/playwright/data-copilot-task-inspector.png' })
})

test('lists historical conversations across jobs without current-job filtering', async ({ page }) => {
  const archived = {
    ...conversation('copilot-archived', 'completed'),
    jobId: 'job-archived',
    mode: 'research',
    title: 'Archived research conversation',
    updatedAt: '2026-08-01T08:00:00.000Z',
  }
  const state = baseState({
    sessions: [conversation(sessionId, 'completed'), archived],
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog.getByText('Archived research conversation', { exact: true })).toBeVisible()
  await expect.poll(() => state.listQueries.length).toBeGreaterThan(0)

  const query = new URLSearchParams(state.listQueries.at(-1))
  expect(query.get('jobId')).toBeNull()
  expect(query.get('mode')).toBeNull()
  expect(query.get('limit')).toBe('500')
})

test('opens the local runtime and MCP control surface with editable safe references', async ({ page }) => {
  const state = baseState({ sessions: [conversation(sessionId, 'idle')], messages: [] })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const copilot = page.getByRole('dialog', { name: '数据 Copilot' })
  await copilot.getByRole('button', { name: '打开工具与连接' }).click()
  await copilot.getByRole('button', { name: '打开本地工具与 MCP Server 设置' }).click()
  const runtime = page.getByRole('dialog', { name: '工具与 MCP Server' })

  await expect(runtime).toBeVisible()
  await expect(runtime.getByText('Workspace', { exact: true })).toBeVisible()
  await expect(runtime.getByText('Exec', { exact: true })).toBeVisible()
  await expect(runtime.getByText('HTTP', { exact: true })).toBeVisible()
  await expect(runtime.getByText('2 MCP tools', { exact: true })).toBeVisible()
  await expect(runtime.getByText('Analysis Tools', { exact: true })).toBeVisible()

  await runtime.getByRole('button', { name: '编辑 Analysis Tools' }).click()
  await expect(runtime.getByLabel('Command')).toHaveValue('node')
  await expect(runtime.getByLabel('Env references')).toHaveValue('MCP_TOKEN')
  await expect(runtime.getByLabel('Read-only tool allowlist')).toHaveValue('search')
  await expect(runtime.getByRole('button', { name: '保存配置' })).toBeVisible()
  await runtime.getByLabel('Command').fill('node --inspect')
  await runtime.getByRole('button', { name: '保存配置' }).click()
  await expect.poll(() => state.mcpRequests.filter((request) => request.method === 'PUT').length).toBe(1)
  const updateRequest = state.mcpRequests.find((request) => request.method === 'PUT')
  expect(updateRequest?.path).toBe('/api/copilot/mcp/servers/analysis-tools')
  expect(updateRequest?.body).toMatchObject({
    id: 'analysis-tools',
    label: 'Analysis Tools',
    enabled: true,
    transport: 'stdio',
    command: 'node --inspect',
    args: ['server.mjs'],
    env: ['MCP_TOKEN'],
    envKeys: ['MCP_TOKEN'],
    readOnlyTools: ['search'],
  })
  await expect(runtime.getByLabel('Command')).toHaveValue('')

  await runtime.getByRole('button', { name: '刷新全部 Server' }).click()
  await expect.poll(() => state.mcpRequests.filter((request) => request.path === '/api/copilot/mcp/refresh').length).toBe(1)

  const visualOutput = process.env.COPILOT_VISUAL_OUTPUT
  if (visualOutput) {
    await page.screenshot({ path: path.join(visualOutput, 'data-copilot-runtime-desktop.png') })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(runtime).toBeInViewport()
  const box = await runtime.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  expect(box?.height).toBeLessThanOrEqual(844)
  if (visualOutput) {
    await page.screenshot({ path: path.join(visualOutput, 'data-copilot-runtime-mobile.png') })
  }
})

test('creates a project workspace and runs a capability-gated local command', async ({ page }) => {
  const state = baseState({ sessions: [conversation(sessionId, 'idle')], messages: [] })
  await installApi(page, state)
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.getByRole('button', { name: '数据助手' }).click()

  const copilot = page.getByRole('dialog', { name: '数据 Copilot' })
  await copilot.getByRole('button', { name: '进入任务Data Copilot 测试任务' }).click()
  await copilot.getByRole('button', { name: '打开工具与连接' }).click()
  await copilot.getByRole('button', { name: '打开项目与工作区' }).click()
  const workspace = page.getByRole('dialog', { name: '项目与工作区' })

  await expect(workspace).toBeVisible()
  await expect(workspace.getByText('Fixture project', { exact: true })).toBeVisible()
  await workspace.getByLabel('项目名称').fill('E2E project')
  await workspace.getByLabel('项目根目录').fill('C:\\workspace\\e2e-project')
  await workspace.getByLabel('项目备注').fill('created by e2e')
  await expect(workspace.getByLabel('项目名称')).toHaveValue('E2E project')
  await expect(workspace.getByLabel('项目根目录')).toHaveValue('C:\\workspace\\e2e-project')
  await expect(workspace.getByLabel('项目备注')).toHaveValue('created by e2e')
  await workspace.getByRole('button', { name: '新建项目' }).click()

  await expect.poll(() => state.projectRequests.filter((request) => request.path === '/api/copilot/projects').length).toBe(1)
  const projectRequest = state.projectRequests.find((request) => request.path === '/api/copilot/projects')
  expect(projectRequest?.body).toEqual({
    name: 'E2E project',
    rootPath: 'C:\\workspace\\e2e-project',
    description: 'created by e2e',
  })
  expect(projectRequest?.contentType).toContain('application/json')

  await workspace.getByLabel('工作区名称').fill('E2E workspace')
  await workspace.getByRole('button', { name: 'Worktree' }).click()
  await workspace.getByLabel('Worktree Ref').fill('HEAD')
  await workspace.getByLabel('Worktree Branch').fill('codex/e2e-worktree')
  await workspace.getByRole('button', { name: '创建工作区' }).click()
  await expect.poll(() => state.projectRequests.filter((request) => request.path.endsWith('/workspaces')).length).toBe(1)
  const createWorkspaceRequest = state.projectRequests.find((request) => request.path.endsWith('/workspaces'))
  expect(createWorkspaceRequest?.body).toEqual({
    name: 'E2E workspace',
    kind: 'worktree',
    ref: 'HEAD',
    branch: 'codex/e2e-worktree',
  })
  expect(createWorkspaceRequest?.contentType).toContain('application/json')

  await workspace.getByRole('button', { name: '刷新 Git 分支' }).click()
  await expect(workspace.getByLabel('切换 Git 分支')).toHaveValue('main')
  await expect(workspace.getByText('当前分支 main', { exact: true })).toBeVisible()

  await workspace.getByLabel('新建 Git 分支').fill('codex/e2e-branch')
  await workspace.getByRole('button', { name: '创建并切换分支' }).click()
  await expect(workspace.getByText('当前分支 codex/e2e-branch', { exact: true })).toBeVisible()
  const createBranchRequest = state.projectRequests.find((request) => request.path.endsWith('/tools/git.branch.create'))
  expect(createBranchRequest?.body).toEqual({ name: 'codex/e2e-branch', checkout: true })
  expect(createBranchRequest?.contentType).toContain('application/json')

  await workspace.getByLabel('切换 Git 分支').selectOption('main')
  await workspace.getByRole('button', { name: '切换分支', exact: true }).click()
  await expect(workspace.getByText('当前分支 main', { exact: true })).toBeVisible()
  const switchBranchRequest = state.projectRequests.find((request) => request.path.endsWith('/tools/git.branch.switch'))
  expect(switchBranchRequest?.body).toEqual({ name: 'main' })
  expect(switchBranchRequest?.contentType).toContain('application/json')

  for (const name of ['读取', '写入', '补丁', '命令']) {
    await expect(workspace.getByRole('tab', { name })).toBeEnabled()
  }
  await workspace.getByRole('tab', { name: '命令' }).click()
  await workspace.getByLabel('工作区命令', { exact: true }).fill('node')
  await workspace.getByLabel('工作区命令参数').fill('--version')
  await workspace.getByLabel('工作目录').fill('packages/app')
  await workspace.getByLabel('命令超时毫秒').fill('1250')
  await workspace.getByRole('button', { name: '运行命令' }).click()

  await expect(workspace.getByLabel('命令标准输出')).toHaveText('executed node')
  await workspace.getByRole('button', { name: 'Refresh execution receipt' }).click()
  await expect(workspace.getByRole('list', { name: '执行轨迹' })).toContainText('已完成')
  const toolRequest = state.projectRequests.find((request) => request.path.endsWith('/tools/exec.run'))
  expect(toolRequest?.body).toEqual({
    command: 'node',
    args: ['--version'],
    cwd: 'packages/app',
    timeoutMs: 1250,
  })
  expect(toolRequest?.contentType).toContain('application/json')
  expect(toolRequest?.idempotencyKey).toMatch(/^workspace-tool:/u)

  await expect.poll(() => state.projectRequests.filter((request) => request.path.endsWith('/tool-executions/workspace-tool-e2e')).length).toBeGreaterThanOrEqual(1)

  await workspace.locator('.copilot-project-workspace-actions button').last().click()
  await expect(workspace).toBeHidden()
  await copilot.getByRole('button', { name: '新建会话', exact: true }).last().click()
  await expect.poll(() => state.createBodies.length).toBe(1)
  expect(state.createBodies[0]).toMatchObject({
    projectId: 'project-created',
    workspaceId: 'workspace-created',
    worktreeId: 'workspace-created',
  })
  expect(state.createBodies[0]).not.toHaveProperty('authority')
  expect(state.createBodies[0]).not.toHaveProperty('workspaceBinding')

  const composer = copilot.getByRole('textbox', { name: '发送给 Data Copilot' })
  const reasoningEffort = copilot.getByLabel('推理强度')
  await expect(reasoningEffort.locator('option')).toHaveText(['关闭', '低', '中', '高', '极高', '最大'])
  await reasoningEffort.selectOption('max')
  await expect(reasoningEffort).toHaveValue('max')
  await expect.poll(() => state.sessionSettingsBodies.length).toBe(1)
  expect(state.sessionSettingsBodies[0]).toEqual({
    selectedModel: { aiSessionId, reasoningEffort: 'max' },
  })
  await composer.fill('在选定工作区创建并验证一个文件')
  await copilot.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(state.sendBodies[0]).toMatchObject({
    projectId: 'project-created',
    workspaceId: 'workspace-created',
    worktreeId: 'workspace-created',
    reasoningEffort: 'max',
  })
  expect(state.sendBodies[0]).not.toHaveProperty('authority')
  expect(state.sendBodies[0]).not.toHaveProperty('workspaceBinding')

  await copilot.locator('.data-copilot-session-item').filter({ hasText: '既有分析会话' }).click()
  await copilot.locator('.data-copilot-session-item').filter({ hasText: '新会话' }).click()
  await expect(reasoningEffort).toHaveValue('max')
  await composer.fill('继续在同一 worktree 中验证')
  await copilot.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(2)
  expect(state.sendBodies[1]).toMatchObject({
    projectId: 'project-created',
    workspaceId: 'workspace-created',
    worktreeId: 'workspace-created',
    reasoningEffort: 'max',
  })
  expect(state.sendBodies[1]).not.toHaveProperty('authority')
  expect(state.sendBodies[1]).not.toHaveProperty('workspaceBinding')
})

test('cancels a running project workspace execution from the receipt', async ({ page }) => {
  const state = baseState({
    sessions: [conversation(sessionId, 'idle')],
    messages: [],
    workspaceToolStatus: 'running',
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /\u6570\u636e\u52a9\u624b/u }).click()

  const copilot = page.getByRole('dialog', { name: /\u6570\u636e Copilot/u })
  await copilot.getByRole('button', { name: /\u6253\u5f00\u5de5\u5177\u4e0e\u8fde\u63a5/u }).click()
  await copilot.getByRole('button', { name: /\u6253\u5f00\u9879\u76ee\u4e0e\u5de5\u4f5c\u533a/u }).click()
  const workspace = page.getByRole('dialog', { name: /\u9879\u76ee\u4e0e\u5de5\u4f5c\u533a/u })
  await expect(workspace).toBeVisible()
  await expect(workspace.getByText('Fixture project', { exact: true })).toBeVisible()
  await workspace.getByRole('tab', { name: /\u547d\u4ee4/u }).click()
  const commandFields = workspace.locator('.copilot-project-workspace-command-fields')
  await commandFields.locator('input').nth(0).fill('node')
  await commandFields.locator('textarea').fill('--version')
  await workspace.getByRole('button', { name: /\u8fd0\u884c\u547d\u4ee4/u }).click()

  await expect(workspace.getByRole('button', { name: 'Cancel execution' })).toBeVisible()
  await expect.poll(() => state.projectRequests.filter((request) => request.path.endsWith('/tools/exec.run')).length).toBe(1)
  await workspace.getByRole('button', { name: 'Cancel execution' }).click()
  await expect.poll(() => state.projectRequests.filter((request) => request.path.endsWith('/tool-executions/workspace-tool-e2e/cancel')).length).toBe(1)
  const cancellation = state.projectRequests.find((request) => request.path.endsWith('/tool-executions/workspace-tool-e2e/cancel'))
  expect(cancellation?.body).toEqual({ reason: 'user_cancelled' })
  await expect(workspace.getByRole('button', { name: 'Cancel execution' })).toBeHidden()
  await expect(workspace.locator('.copilot-project-workspace-receipt[data-status="cancelled"]')).toBeVisible()
  await expect(workspace.getByRole('list', { name: '执行轨迹' })).toContainText('已取消')

  await workspace.getByRole('button', { name: 'Refresh execution receipt' }).click()
  await expect.poll(() => state.projectRequests.filter((request) => request.path.endsWith('/tool-executions/workspace-tool-e2e')).length).toBeGreaterThanOrEqual(1)
  await expect(workspace.locator('.copilot-project-workspace-receipt[data-status="cancelled"]')).toBeVisible()
})

test('projects subagent SSE events into a compact task tree without adding chat messages', async ({ page }, testInfo) => {
  const state = baseState({
    sessions: [conversation(sessionId, 'executing')],
    messages: [],
    sseBody: sse([
      {
        type: 'subagent.run.planned',
        runId: 'subagent-run-e2e',
        parentRunId: 'main-run-e2e',
        conversationId: sessionId,
        objective: '并行研究并汇总投递策略',
        planRevision: 1,
        createdAt: '2026-08-02T08:00:01.000Z',
        tasks: [
          { taskId: 'research', role: 'researcher', title: '分析渠道与数据质量', dependsOn: [] },
          { taskId: 'synthesis', role: 'writer', title: '汇总投递建议', dependsOn: ['research'] },
        ],
      },
      { type: 'subagent.run.started', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', conversationId: sessionId, createdAt: '2026-08-02T08:00:02.000Z' },
      { type: 'subagent.task.started', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'research', role: 'researcher', title: '分析渠道与数据质量', dependsOn: [], createdAt: '2026-08-02T08:00:03.000Z' },
      { type: 'subagent.reasoning.delta', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', conversationId: sessionId, taskId: 'research', role: 'researcher', round: 1, delta: '内部推理不会进入聊天消息。', createdAt: '2026-08-02T08:00:03.500Z' },
      { type: 'subagent.output.delta', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'research', role: 'researcher', delta: '完成数据剖析并输出三个要点。', createdAt: '2026-08-02T08:00:04.000Z' },
      { type: 'subagent.tool.call.delta', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', conversationId: sessionId, taskId: 'research', role: 'researcher', round: 1, toolName: 'dataset.profile', toolCallId: 'profile-call', argumentDeltaChars: 24, createdAt: '2026-08-02T08:00:04.500Z' },
      { type: 'subagent.tool.started', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'profile-call', createdAt: '2026-08-02T08:00:05.000Z' },
      { type: 'subagent.tool.completed', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'profile-call', createdAt: '2026-08-02T08:00:06.000Z' },
      { type: 'subagent.task.completed', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'research', role: 'researcher', summary: '完成数据剖析并输出三个要点。', createdAt: '2026-08-02T08:00:07.000Z' },
      { type: 'subagent.task.started', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'synthesis', role: 'writer', title: '汇总投递建议', dependsOn: ['research'], createdAt: '2026-08-02T08:00:08.000Z' },
      { type: 'subagent.task.failed', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', taskId: 'synthesis', role: 'writer', error: { code: 'INVALID_OUTPUT', message: '汇总校验失败' }, createdAt: '2026-08-02T08:00:09.000Z' },
      { type: 'subagent.run.failed', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', conversationId: sessionId, status: 'failed', error: { code: 'SUBAGENT_FAILED', message: '子任务未全部完成' }, createdAt: '2026-08-02T08:00:10.000Z' },
      { type: 'subagent.run.receipt', runId: 'subagent-run-e2e', parentRunId: 'main-run-e2e', conversationId: sessionId, receipt: { status: 'failed' }, createdAt: '2026-08-02T08:00:11.000Z' },
    ]),
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  const workbench = dialog.getByLabel('智能体运行工作台')
  const taskRunHeader = dialog.getByLabel('任务运行概览')
  await expect(taskRunHeader).toBeVisible()
  await expect(taskRunHeader).toContainText('执行中')
  await expect(taskRunHeader).toContainText('1 个 Agent')
  await expect(dialog.getByLabel('连续执行轨迹')).toBeVisible()
  await taskRunHeader.getByRole('button', { name: '打开执行计划' }).click()
  await expect(workbench.locator('.copilot-runbar-status strong')).toHaveText('执行中')
  await expect(workbench.getByText('并行研究并汇总投递策略', { exact: true })).toBeVisible()
  await expect(workbench.getByTestId('subagent-task-node')).toHaveCount(2)
  await expect(workbench.getByText('分析渠道与数据质量', { exact: true })).toBeVisible()
  await expect(workbench.getByText('汇总投递建议', { exact: true })).toBeVisible()
  await expect(workbench.getByText(/1 个工具/)).toBeVisible()
  await expect(workbench.getByText(/等待 research/)).toBeVisible()
  await expect(workbench.getByText(/完成数据剖析并输出三个要点/)).toBeVisible()
  await expect(workbench.getByText(/汇总校验失败/)).toBeVisible()
  await expect(dialog.locator('.data-copilot-message-row')).toHaveCount(0)

  await workbench.getByTestId('subagent-task-node').filter({ hasText: '分析渠道与数据质量' }).click()
  await expect(workbench.getByTestId('copilot-selected-plan-node')).toContainText('分析渠道与数据质量')
  await expect(workbench.getByTestId('copilot-selected-plan-node')).toContainText('1 个工具')

  await workbench.getByRole('tab', { name: /活动/ }).click()
  await expect(workbench.getByText('子 Agent 运行', { exact: true })).toHaveCount(1)
  await expect(workbench.getByText('数据剖析', { exact: true })).toHaveCount(1)
  await expect(workbench.locator('.copilot-activity-copy strong').filter({ hasText: 'researcher' })).toHaveCount(1)

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileNav = dialog.locator('.data-copilot-mobile-nav')
  await expect(mobileNav).toBeVisible()
  await mobileNav.locator('button').nth(2).click()
  await expect(workbench).toBeVisible()
  await workbench.getByRole('tab', { name: /计划/ }).click()
  await expect(workbench).toBeInViewport()
  const box = await workbench.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await workbench.screenshot({ path: testInfo.outputPath('subagent-task-tree-mobile.png') })
})

test('browses crawled records and sends an exact record section as context', async ({ page }) => {
  const state = baseState({ sessions: [conversation(sessionId, 'idle')], messages: [] })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog.getByText('历史采集记录', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '进入任务Data Copilot 测试任务' }).click()
  await expect(dialog.getByText('采集记录', { exact: true })).toBeVisible()
  await expect(dialog.getByText('2', { exact: true }).first()).toBeVisible()
  await dialog.getByText('原帖与正文', { exact: true }).click()
  await expect(dialog.getByText('共 2 条', { exact: true })).toBeVisible()
  await expect(dialog.getByText('第一条采集帖子', { exact: true })).toBeVisible()
  const thumbnail = dialog.getByRole('img', { name: '第一条采集帖子 缩略图' })
  await expect(thumbnail).toHaveAttribute('src', new RegExp(`/api/jobs/${jobId}/media\\?url=`))
  await expect.poll(() => thumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

  await dialog.getByRole('button', { name: '选择第一条采集帖子' }).click()
  await dialog.getByText('第一条采集帖子', { exact: true }).click()
  await expect(dialog.getByText('选择数据上下文', { exact: true })).toBeVisible()
  const detailImage = dialog.getByRole('img', { name: '第一条采集帖子 图片 1' })
  await expect(detailImage).toHaveAttribute('src', new RegExp(`/api/jobs/${jobId}/media\\?url=`))
  await expect.poll(() => detailImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(dialog.getByText('第一条采集帖子 的正文内容，用于验证记录详情与精确上下文选择。', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: /^正文\s*完整正文内容$/ }).click()

  await dialog.getByRole('textbox', { name: '发送给 Data Copilot' }).fill('只分析这条帖子的正文')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(state.sendBodies[0].contextSourceIds).toEqual([
    `xhs-context://jobs/${jobId}/posts/post-1?section=body`,
  ])
})

test('restores a conversation and supports approval, stop, retry, and mobile panes', async ({ page }) => {
  const state = baseState()
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '新建会话', exact: true }).last()).toBeVisible()
  await expect(dialog.getByRole('button', { name: '选择数据上下文，已选 1 项' })).toBeVisible()
  for (const mode of ['提问', '分析', '构建']) {
    await expect(dialog.getByRole('button', { name: mode, exact: true })).toBeVisible()
  }
  await dialog.getByRole('button', { name: '收起运行详情' }).click()
  await expect(dialog.getByRole('button', { name: '展开运行详情' })).toBeVisible()
  await dialog.getByRole('button', { name: '展开运行详情' }).click()
  await expect(dialog.getByText('既有分析会话', { exact: true }).first()).toBeVisible()
  await dialog.getByText('既有分析会话', { exact: true }).first().click()
  await expect(dialog.getByText('分析当前任务', { exact: true })).toBeVisible()
  await expect(dialog.getByText('1 项已启用')).toBeVisible()
  await dialog.getByRole('button', { name: /数据源 · content/ }).click()
  await expect(dialog.getByText(`xhs-data://jobs/${jobId}/content`, { exact: true })).toBeVisible()

  const retry = dialog.getByRole('button', { name: '重试' })
  await expect(retry).toBeDisabled()
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await expect.poll(() => state.approvals).toBe(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog.getByRole('button', { name: '停止运行' })).toBeVisible()
  await dialog.getByRole('button', { name: '停止运行' }).click()
  await expect.poll(() => state.cancels).toBe(1)
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect.poll(() => state.retries).toBe(1)

  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: '显示会话列表' }).click()
  await expect(dialog.locator('.data-copilot-session-rail')).toBeVisible()
  await dialog.getByRole('button', { name: '显示数据上下文' }).click()
  await expect(dialog.locator('.data-copilot-context-pane')).toBeVisible()
  await dialog.getByRole('button', { name: '显示对话' }).click()
  await expect(dialog.locator('.data-copilot-conversation')).toBeVisible()
  await dialog.getByRole('button', { name: '折叠 Data Copilot' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '数据助手', exact: true }).click()
  await expect(dialog).toBeVisible()
})

test('binds job, snapshot, model and attachment once while preserving draft across revision refresh', async ({ page }) => {
  const state = baseState({ sessions: [], messages: [] })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await dialog.getByRole('button', { name: '进入任务Data Copilot 测试任务' }).click()
  const input = dialog.locator('input[type="file"]')
  await input.setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('test brief') })
  const composer = dialog.getByRole('textbox', { name: '发送给 Data Copilot' })
  await composer.fill('分析附件')
  await dialog.getByRole('button', { name: '发送消息' }).evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })

  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(state.uploads).toBe(1)
  expect(state.createBodies).toHaveLength(1)
  expect(state.createBodies[0]).toMatchObject({
    jobId,
    mode: 'application',
    snapshotId: 'job-r7',
    aiSessionId,
    selectedModel: { aiSessionId },
  })
  expect(state.sendBodies[0]).toMatchObject({
    content: '分析附件',
    aiSessionId,
    attachmentIds: ['attachment-1'],
  })

  await composer.fill('revision 更新后仍保留')
  state.revision = 8
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(composer).toHaveValue('revision 更新后仍保留')

  await dialog.getByRole('button', { name: '关闭 Data Copilot' }).click()
  state.messages = [{ messageId: 'message-new', conversationId: 'copilot-created', role: 'assistant', content: { type: 'assistant.message', text: '关闭期间的新消息' }, createdAt: now }]
  const loadsBefore = state.messageLoads
  await page.getByRole('button', { name: '数据助手' }).click()
  await expect.poll(() => state.messageLoads).toBeGreaterThan(loadsBefore)
  await expect(page.getByRole('dialog', { name: '数据 Copilot' }).getByText('关闭期间的新消息')).toBeVisible()
})

test('selects a historical crawl, exposes its artifacts, and binds a new conversation to that job', async ({ page }) => {
  const state = baseState({ sessions: [], messages: [] })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog.getByText('历史采集记录', { exact: true })).toBeVisible()
  await expect(dialog.getByText('亚比女历史采集', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/原帖 1 · 评论 24 · 用户 13 · 产物 2/)).toBeVisible()
  await dialog.getByRole('button', { name: '进入任务亚比女历史采集' }).click()

  await expect(dialog.getByText('当前任务', { exact: true })).toBeVisible()
  await expect(dialog.getByText('亚比女历史采集', { exact: true }).first()).toBeVisible()
  await dialog.getByText('原帖与正文', { exact: true }).click()
  const historicalThumbnail = dialog.getByRole('img', { name: '亚比女历史帖子 缩略图' })
  await expect(historicalThumbnail).toHaveAttribute('src', new RegExp(`/api/jobs/${historicalJobId}/media\\?url=`))
  await expect.poll(async () => decodeURIComponent(await historicalThumbnail.getAttribute('src') || '')).toContain('/history-post-1.webp')
  await expect.poll(() => historicalThumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await dialog.getByRole('button', { name: '返回上一级' }).click()
  await dialog.getByText('任务产物', { exact: true }).click()
  await expect(dialog.getByText('受众分析报告.json', { exact: true })).toBeVisible()

  await dialog.getByRole('textbox', { name: '发送给 Data Copilot' }).fill('结合这个历史任务的全部产物继续分析')
  await dialog.getByRole('button', { name: '发送消息' }).click()
  await expect.poll(() => state.createBodies.length).toBe(1)
  expect(state.createBodies[0]).toMatchObject({
    jobId: historicalJobId,
    mode: 'application',
    snapshotId: 'job-r12',
  })
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(state.sendBodies[0].contextSourceIds).toEqual([
    `job:${historicalJobId}`,
    'dataset:content',
    'dataset:audience',
    'dataset:artifacts',
  ])
})

test('keeps a selected historical task bound when the global conversation list returns late', async ({ page }) => {
  const staleConversation = {
    ...conversation(sessionId, 'idle'),
    scope: {
      allowedScopes: ['*'],
      contextSourceIds: [
        `xhs-context://jobs/${jobId}/posts/post-1?section=body`,
      ],
    },
  }
  const state = baseState({
    sessions: [staleConversation],
    messages: [],
    sessionListDelayMs: 350,
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await dialog.getByRole('button', { name: '进入任务亚比女历史采集' }).click()
  await expect(dialog.getByText('亚比女历史采集', { exact: true }).first()).toBeVisible()
  await expect.poll(() => state.listQueries.length).toBeGreaterThan(0)
  await page.waitForTimeout(450)

  await dialog.getByRole('textbox', { name: '发送给 Data Copilot' }).fill('分析这条历史任务')
  await dialog.getByRole('button', { name: '发送消息' }).click()

  await expect.poll(() => state.createBodies.length).toBe(1)
  expect(state.createBodies[0]).toMatchObject({
    jobId: historicalJobId,
    snapshotId: 'job-r12',
  })
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(state.sendBodies[0].contextSourceIds).toEqual([
    `job:${historicalJobId}`,
    'dataset:content',
    'dataset:audience',
    'dataset:artifacts',
  ])
})

test('turns table results into interactive batch email extraction controls', async ({ page }, testInfo) => {
  const rows = [
    { noteId: 'note-001', title: 'AI 产品实习生', delivery: { email: 'ai@example.com' } },
    { noteId: 'note-002', title: '数据分析实习生', delivery: null },
    { noteId: 'note-003', title: '商业分析实习生', delivery: { email: 'business@example.com' } },
    ...Array.from({ length: 7 }, (_, index) => ({
      noteId: `note-${String(index + 4).padStart(3, '0')}`,
      title: `运营岗位 ${index + 1}`,
      delivery: null,
    })),
  ]
  const state = baseState({
    sessions: [conversation(sessionId, 'completed')],
    messages: [
      {
        messageId: 'message-interactive-table',
        conversationId: sessionId,
        role: 'tool',
        content: {
          type: 'table.result',
          toolRunId: 'tool-interactive-table',
          name: 'applications.get_delivery',
          result: { type: 'table.result', total: rows.length, rows },
        },
        createdAt: now,
      },
    ],
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  const table = dialog.getByTestId('interactive-result-table')
  await expect(table).toBeVisible()
  await expect(table.getByText('共 10 条')).toBeVisible()
  await expect(table.getByRole('link', { name: 'ai@example.com' })).toBeVisible()
  await expect(table.getByText('第 1 / 2 页')).toBeVisible()

  const search = table.getByRole('textbox', { name: '搜索表格结果' })
  await search.fill('商业分析')
  await expect(table.getByText('筛选到 1 条')).toBeVisible()
  await expect(table.getByText('商业分析实习生', { exact: true })).toBeVisible()
  await search.fill('')

  await table.getByRole('checkbox', { name: '选择 AI 产品实习生' }).check()
  await expect(table.getByText('已选择 1 条', { exact: false })).toBeVisible()
  await table.screenshot({ path: testInfo.outputPath('interactive-result-table.png') })
  await table.getByRole('button', { name: '提取邮箱' }).click()

  await expect.poll(() => state.sendBodies.length).toBe(1)
  const prompt = String(state.sendBodies[0].content)
  expect(prompt).toContain('applications.extract_email_requirements')
  expect(prompt).toContain('note-001')
  expect(prompt).toContain('分页直到完整覆盖')
  expect(prompt).toContain('不要只返回第一条')
})

test('renders job delivery results as structured controls and exposes application email actions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  const sourceUrl = 'https://www.xiaohongshu.com/explore/note-001?xsec_token=secret-token&xsec_source=pc_feed'
  const postBody = '这是招聘原帖的完整正文，岗位负责 AI 产品需求分析、用户研究与方案落地。候选人需要每周到岗四天，能够连续实习三个月，并在邮件中说明相关项目经历。'.repeat(3)
  const state = baseState({
    sessions: [conversation(sessionId, 'completed')],
    messages: [
      {
        messageId: 'message-delivery-summary',
        conversationId: sessionId,
        role: 'assistant',
        content: {
          type: 'assistant.message',
          text: `可投递岗位\ntalent@example.com | 正文写“已经招到啦” | ${sourceUrl} |\n\n可直接复制的邮箱清单：\n\`\`\`text\ntalent@example.com\nhr@example.com\n\`\`\``,
        },
        createdAt: now,
      },
      {
        messageId: 'message-attachment-list',
        conversationId: sessionId,
        role: 'tool',
        content: {
          type: 'tool.result',
          toolRunId: 'tool-attachment-list',
          name: 'attachment.list',
          result: { count: 0 },
        },
        createdAt: now,
      },
      {
        messageId: 'message-application-email',
        conversationId: sessionId,
        role: 'tool',
        content: {
          type: 'tool.result',
          toolRunId: 'tool-application-email',
          name: 'applications.compose_email',
          result: {
            type: 'application.email_draft',
            noteId: 'note-001',
            jobTitle: 'AI 产品经理实习生',
            company: '示例科技',
            to: 'talent@example.com',
            subject: '王梓楠-示例大学-AI 产品经理实习生',
            text: '尊敬的招聘负责人：\n您好，我希望应聘 AI 产品经理实习生岗位，期待进一步沟通。',
            subjectRule: {
              status: 'compliant',
              evidence: '邮件标题：姓名-学校-应聘岗位',
              missingFields: [],
            },
            sourceUrl,
            post: {
              title: 'AI 产品经理实习生招聘原帖',
              body: postBody,
              images: ['https://img.example.test/job-cover.png'],
              requirements: ['每周到岗四天', '连续实习三个月'],
              sourceUrl,
            },
            attachmentIds: [],
            sendReady: true,
          },
        },
        createdAt: now,
      },
    ],
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const dialog = page.getByRole('dialog', { name: '数据 Copilot' })
  await expect(dialog.getByText('岗位投递邮件', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('批量投递状态')).toBeVisible()
  await expect(dialog.getByRole('region', { name: '执行步骤' }).getByRole('button', { name: /已完成 1 个步骤/ })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'talent@example.com' }).first()).toBeVisible()
  await expect(dialog.getByText('secret-token')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '写投递邮件' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '批量核对格式' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '发送邮件' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成投递草稿' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '预览邮件' })).toBeVisible()

  await expect(dialog.getByText('岗位投递邮件', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /撰写岗位投递邮件/ })).toHaveCount(0)
  await expect(dialog.getByText('符合招聘标题要求')).toBeVisible()
  await expect(dialog.getByText('AI 产品经理实习生 · 示例科技')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '复制邮件主题' })).toBeVisible()
  const postImage = dialog.getByRole('img', { name: 'AI 产品经理实习生招聘原帖原帖图片' })
  await expect(postImage).toBeVisible()
  await expect.poll(() => postImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(dialog.getByText('每周到岗四天', { exact: true })).toBeVisible()
  const subjectEditor = dialog.getByRole('textbox', { name: '邮件主题' })
  const bodyEditor = dialog.getByRole('textbox', { name: '邮件正文' })
  await expect(subjectEditor).toHaveValue('王梓楠-示例大学-AI 产品经理实习生')
  await expect(bodyEditor).toHaveValue(/我希望应聘 AI 产品经理实习生岗位/)
  const screenshotPath = testInfo.outputPath('application-email-result.png')
  await dialog.getByTestId('application-email-result').screenshot({ path: screenshotPath })
  await testInfo.attach('application-email-result', { path: screenshotPath, contentType: 'image/png' })
  await dialog.getByRole('button', { name: '查看完整正文' }).click()
  await expect(dialog.getByRole('button', { name: '收起正文' })).toBeVisible()

  await subjectEditor.fill('王梓楠-示例大学-AI 产品经理实习生-可立即到岗')
  await bodyEditor.fill('尊敬的招聘负责人：\n您好，我希望应聘 AI 产品经理实习生岗位。这是我在卡片中确认后的正文。')
  await expect(dialog.getByRole('button', { name: '撤销修改' })).toBeVisible()

  await dialog.getByRole('button', { name: '润色邮件' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(1)
  expect(String(state.sendBodies[0].content)).toContain('applicationNoteId: note-001')
  expect(String(state.sendBodies[0].content)).toContain('applications.compose_email')
  expect(String(state.sendBodies[0].content)).toContain('可立即到岗')
  expect(String(state.sendBodies[0].content)).toContain('这是我在卡片中确认后的正文')

  await dialog.getByRole('button', { name: '预览并发送' }).click()
  await expect.poll(() => state.sendBodies.length).toBe(2)
  expect(String(state.sendBodies[1].content)).toContain('email.preview')
  expect(String(state.sendBodies[1].content)).toContain('email.send')
  expect(String(state.sendBodies[1].content)).toContain('必须展示审批确认')
  expect(String(state.sendBodies[1].content)).toContain('可立即到岗')
  expect(String(state.sendBodies[1].content)).toContain('这是我在卡片中确认后的正文')

  await dialog.getByRole('button', { name: '批量核对格式' }).click()
  await expect(dialog.getByRole('textbox', { name: '发送给 Data Copilot' })).toHaveValue(/邮件标题或主题格式要求/)
})

test('connects and selects an AI model from inside Data Copilot', async ({ page }) => {
  const state = baseState({
    aiProviders: [{
      id: 'relay',
      label: 'API 中转站（OpenAI 兼容）',
      baseUrl: '',
      model: '',
      models: [],
      requiresKey: true,
      wireApi: 'chat_completions',
      configured: false,
      hasApiKey: false,
      relay: true,
    }],
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const copilot = page.getByRole('dialog', { name: '数据 Copilot' })
  await copilot.getByRole('button', { name: '连接 AI 模型' }).click()
  const connector = copilot.getByRole('dialog', { name: '连接 AI 模型' })
  await expect(connector).toBeVisible()
  await expect(connector.getByLabel('AI 提供方')).toHaveValue('relay')

  await connector.getByLabel('API Base URL').fill('https://relay.example.test/v1')
  await connector.getByLabel('API Key').fill('relay-secret')
  await connector.getByRole('button', { name: '检测模型' }).click()
  await expect(connector.getByRole('status')).toContainText('已读取 2 个模型')
  await expect(connector.getByLabel('模型 ID')).toHaveValue('relay-model-a')
  expect(state.modelDiscoveryBodies).toEqual([{
    provider: 'relay',
    apiKey: 'relay-secret',
    baseUrl: 'https://relay.example.test/v1',
  }])

  await connector.getByRole('button', { name: '连接并使用' }).click()
  await expect(connector).toBeHidden()
  await expect(copilot.getByTitle('选择模型')).toHaveValue(aiSessionId)
  await expect(copilot.getByTitle('选择模型').locator('option:checked')).toHaveText('relay-model-a · relay')
  await expect(copilot.getByLabel('推理强度')).toBeDisabled()
  expect(state.aiSessionBodies.at(-1)).toEqual({
    provider: 'relay',
    apiKey: 'relay-secret',
    baseUrl: 'https://relay.example.test/v1',
    model: 'relay-model-a',
    wireApi: 'chat_completions',
  })
  await expect(copilot.getByText('relay-secret')).toHaveCount(0)
})

test('enables and persists reasoning effort for a compatible Chat Completions model', async ({ page }) => {
  const state = baseState({
    sessions: [conversation(sessionId, 'idle')],
    aiProviders: [{
      id: 'relay',
      label: 'API 中转站（OpenAI 兼容）',
      baseUrl: '',
      model: '',
      models: [],
      requiresKey: true,
      wireApi: 'chat_completions',
      configured: false,
      hasApiKey: false,
      relay: true,
    }],
    modelDiscoveryModels: ['gpt-5.1-codex'],
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const copilot = page.getByRole('dialog', { name: '数据 Copilot' })
  await copilot.getByRole('button', { name: '连接 AI 模型' }).click()
  const connector = copilot.getByRole('dialog', { name: '连接 AI 模型' })
  await connector.getByLabel('API Base URL').fill('https://relay.example.test/v1')
  await connector.getByLabel('API Key').fill('relay-secret')
  await connector.getByRole('button', { name: '检测模型' }).click()
  await expect(connector.getByLabel('模型 ID')).toHaveValue('gpt-5.1-codex')
  await connector.getByRole('button', { name: '连接并使用' }).click()
  await expect(connector).toBeHidden()

  const reasoningEffort = copilot.getByLabel('推理强度')
  await expect(reasoningEffort).toBeEnabled()
  await reasoningEffort.selectOption('high')
  await expect(reasoningEffort).toHaveValue('high')
  await expect.poll(() => state.sessionSettingsBodies.at(-1)).toEqual({
    selectedModel: { aiSessionId, reasoningEffort: 'high' },
  })
})

test('keeps the saved credential URL when discovery normalizes the endpoint', async ({ page }) => {
  const configuredBaseUrl = 'https://relay.example.test'
  const state = baseState({
    aiProviders: [{
      id: 'relay',
      label: 'API 中转站（OpenAI 兼容）',
      baseUrl: configuredBaseUrl,
      model: 'relay-model-a',
      models: ['relay-model-a'],
      requiresKey: true,
      wireApi: 'chat_completions',
      configured: true,
      hasApiKey: true,
      relay: true,
    }],
    modelDiscoveryBaseUrl: `${configuredBaseUrl}/v1`,
  })
  await installApi(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: '数据助手' }).click()

  const copilot = page.getByRole('dialog', { name: '数据 Copilot' })
  await copilot.getByTitle('连接或更换 AI 模型').click()
  const connector = copilot.getByRole('dialog', { name: '连接 AI 模型' })
  await expect(connector.getByLabel('API Key')).toHaveValue('')
  await connector.getByRole('button', { name: '检测模型' }).click()
  await expect(connector.getByRole('status')).toContainText('已读取 2 个模型')
  await expect(connector.getByLabel('API Base URL')).toHaveValue(configuredBaseUrl)

  await connector.getByRole('button', { name: '连接并使用' }).click()
  await expect(connector).toBeHidden()
  expect(state.aiSessionBodies.at(-1)).toMatchObject({
    provider: 'relay',
    apiKey: '',
    baseUrl: configuredBaseUrl,
    model: 'relay-model-a',
  })
})
