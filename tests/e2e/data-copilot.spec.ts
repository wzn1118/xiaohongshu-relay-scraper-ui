import { expect, test, type Page, type Route } from '@playwright/test'

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
  uploads: number
  approvals: number
  cancels: number
  retries: number
  messageLoads: number
  sessionListDelayMs: number
  aiProviders: Record<string, unknown>[]
  modelDiscoveryBaseUrl?: string
  modelDiscoveryBodies: Record<string, unknown>[]
  aiSessionBodies: Record<string, unknown>[]
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

async function installApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/health') return json(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: false } })
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
        models: ['relay-model-a', 'relay-model-b'],
        fetchedAt: now,
      })
    }
    if (path === '/api/ai/sessions' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.aiSessionBodies.push(body)
      return json(route, {
        id: aiSessionId,
        provider: body.provider || 'codex',
        model: body.model || 'test-model',
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
        body: 'event: ready\ndata: {"type":"ready"}\n\n',
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
      const created = conversation(
        'copilot-created',
        'idle',
        String(body.jobId || jobId),
        String(body.snapshotId || 'job-r7'),
      )
      state.sessions = [created]
      return json(route, { conversation: created }, 201)
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
    uploads: 0,
    approvals: 0,
    cancels: 0,
    retries: 0,
    messageLoads: 0,
    sessionListDelayMs: 0,
    aiProviders: [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test-model', models: ['test-model'], requiresKey: false, wireApi: 'responses', configured: true, hasApiKey: true }],
    modelDiscoveryBodies: [],
    aiSessionBodies: [],
    ...overrides,
  }
}

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
  await dialog.getByRole('button', { name: /^正文完整正文内容$/ }).click()

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
  await dialog.getByRole('button', { name: '停止生成' }).first().click()
  await expect.poll(() => state.cancels).toBe(1)
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect.poll(() => state.retries).toBe(1)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: '显示会话列表' }).click()
  await expect(dialog.locator('.data-copilot-session-rail')).toBeVisible()
  await dialog.getByRole('button', { name: '显示数据上下文' }).click()
  await expect(dialog.locator('.data-copilot-context-pane')).toBeVisible()
  await dialog.getByRole('button', { name: '显示对话' }).click()
  await expect(dialog.locator('.data-copilot-conversation')).toBeVisible()
  await dialog.getByRole('button', { name: '折叠 Data Copilot' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '打开数据 Copilot' }).click()
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
  await expect(dialog.getByText('招聘邮箱')).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'talent@example.com' }).first()).toBeVisible()
  await expect(dialog.getByText('secret-token')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '写投递邮件' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '按要求拟标题' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '发送邮件' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成投递草稿' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成并预览邮件' })).toBeVisible()

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

  await dialog.getByRole('button', { name: '按要求拟标题' }).click()
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
  expect(state.aiSessionBodies.at(-1)).toEqual({
    provider: 'relay',
    apiKey: 'relay-secret',
    baseUrl: 'https://relay.example.test/v1',
    model: 'relay-model-a',
    wireApi: 'chat_completions',
  })
  await expect(copilot.getByText('relay-secret')).toHaveCount(0)
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
