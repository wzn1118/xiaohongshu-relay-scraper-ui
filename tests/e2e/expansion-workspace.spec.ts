import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-08-01T08:00:00.000Z'
const task = {
  id: 'content-task-1', keyword: '亚比女', status: 'succeeded', createdAt: now, updatedAt: now, finishedAt: now,
  progress: 100, progressPhase: 'done', progressLabel: '内容采集完成', progressCurrent: 3, progressTotal: 3,
  applicationCount: 3, artifactCount: 0, artifacts: [], resumeAvailable: false,
  config: { analysisMode: 'general', limit: 0, maxScrolls: 60, searchSort: 'latest', maxAgeDays: 0 },
  workflowSummary: { analysisMode: 'general' },
}

const seeds = [
  { postId: 'post-1', title: '亚比穿搭分享', author: { display_name: '用户甲' }, url: 'https://example.test/post-1', available: true, unavailableReason: '', contentStatus: 'complete', commentStatus: 'partial', collectionReason: 'partial_timeout', collectedComments: 18, selected: true, expansionStatus: 'available' },
  { postId: 'post-2', title: '妆容与发色记录', author: { display_name: '用户乙' }, url: 'https://example.test/post-2', available: true, unavailableReason: '', contentStatus: 'complete', commentStatus: 'complete', collectionReason: 'complete_reachable', collectedComments: 42, selected: false, expansionStatus: 'available' },
  { postId: 'post-3', title: '线下活动返图', author: { display_name: '用户丙' }, url: 'https://example.test/post-3', available: true, unavailableReason: '', contentStatus: 'complete', commentStatus: 'uncollected', collectionReason: 'uncollected', collectedComments: 0, selected: true, expansionStatus: 'available' },
]

const config = { rounds: 2, includeReplies: true, maxReplyDepth: 2, maxUsersPerRound: 20, maxPostsPerUser: 3, maxCommentsPerPost: 100, maxTotalUsers: 250, maxTotalPosts: 500, maxTotalComments: 5000, timeBudgetMinutes: 30, maxFailureCount: 10, concurrency: 1, postSelectionStrategy: 'latest', schemaVersion: 1 }
type MockRuntime = 'idle' | 'running' | 'partial' | 'completed' | 'blocked' | 'failed'

function state(status: MockRuntime = 'idle') {
  const started = status !== 'idle'
  const running = status === 'running'
  const resumable = ['partial', 'blocked', 'failed'].includes(status)
  const summary = started ? {
    attemptId: 'expansion-1', runtimeStatus: status, status, seedPostIds: ['post-1', 'post-3'], config,
    completedRounds: running ? 0 : 1, roundIndex: running ? 1 : 2, maxRounds: 2,
    lastCheckpointAt: now, stopReason: status === 'partial' ? 'time_budget_reached' : status === 'blocked' ? 'security_verification' : status === 'failed' ? 'relay_disconnected' : '',
    counters: { users: 7, posts: 3, comments: 60 },
  } : {}
  return {
    available: true,
    status,
    runtimeStatus: status,
    businessStatus: status,
    stopReason: String(summary.stopReason || ''),
    resumable,
    hasResults: started,
    actionState: running ? 'running' : resumable ? 'resumable' : status === 'completed' ? 'completed' : 'ready',
    summary,
    seeds: seeds.map((seed) => ({ ...seed, selected: started ? ['post-1', 'post-3'].includes(seed.postId) : seed.selected, expansionStatus: running && seed.selected ? 'expanding' : started && seed.selected ? 'used' : seed.expansionStatus })),
    config: started ? config : null,
    metrics: started
      ? { rounds: running ? 0 : 1, currentRound: running ? 1 : 2, frontier: 7, users: 7, expandedUsers: 4, posts: 3, comments: 60, duplicates: 2, failures: status === 'failed' ? 1 : 0, remainingMinutes: status === 'partial' ? 0 : 24 }
      : { rounds: 0, currentRound: 0, frontier: 0, users: 0, expandedUsers: 0, posts: 0, comments: 0, duplicates: 0, failures: 0, remainingMinutes: null },
    rounds: started ? [{ roundIndex: 1, frontierUserCount: 7, expandedUserCount: 4, discoveredPostCount: 3, crawledPostCount: 3, discoveredCommentCount: 60, discoveredNewUserCount: 7, duplicateUserCount: 2, blockedUserCount: status === 'blocked' ? 1 : 0, failedUserCount: status === 'failed' ? 1 : 0, durationMs: 1200, stopReason: status === 'partial' ? 'time_budget_reached' : 'round_completed' }] : [],
    results: { kind: 'users', total: 1, offset: 0, limit: 50, items: started ? [{ userId: 'user-1', displayName: '扩散用户甲', profileStatus: 'complete_reachable', roundIndex: 1 }] : [], filters: { round: '', status: '', seed: '' } },
    artifacts: started ? [{ id: 'expansion-summary', name: 'expansion_summary.json', path: 'expansion_summary.json', size: 2048 }] : [],
  }
}

const contentResults = {
  available: true, analysisMode: 'general', keyword: '亚比女', research: null, presentation: null, insights: null,
  total: 1, offset: 0, limit: 20,
  items: [{
    note_id: 'post-1', title: '已保存内容仍可见', note_url: 'https://example.test/post-1', body: '扩散运行时保留的正文。', access_status: 'complete', collected_at: now,
    publish_time: { raw: '2026-08-01', value: '2026-08-01', precision: 'day', is_estimated: false },
    application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
    outreach: { greeting: '', email_subject: '', email_body: '', cover_letter: '', generation_mode: '', runtime_status: '', status: '' },
    content_analysis: { status: 'completed', overview: '已完成内容分析', content_type: '穿搭记录', relevance_score: 92, relevance_reason: '原文证据完整', topics: ['亚比穿搭'], entities: [], image_insights: [], modules: [], grounded_evidence_count: 1 },
    quality: { body_complete: true },
  }],
  filters: { sort: 'newest', timeRange: 'all', stats: { all: 1, dated: 1, unknown: 0, incomplete: 0, withImages: 0 } },
  codexRuntime: { status: 'completed' }, qualityGate: { passed: true },
}

const audienceResults = {
  available: true, kind: 'comments',
  summary: { schemaVersion: 1, status: 'complete', postsTotal: 3, postsComplete: 1, postsPending: 1, postsPartial: 1, postsFailed: 0, postsAttempted: 2, postsWithComments: 2, commentsCollected: 60, topLevelComments: 50, repliesCollected: 10, usersDiscovered: 7, profilesComplete: 4, postCoveragePercent: 33, postAttemptPercent: 67, profileCoveragePercent: 57, stopReason: '', generatedAt: now },
  posts: seeds.map((seed) => ({ post_id: seed.postId, title: seed.title, note_url: seed.url, author: seed.author, expected_comment_count: null, collected_comment_count: seed.collectedComments, status: seed.commentStatus, collectionStatus: seed.commentStatus })),
  total: 1, offset: 0, limit: 40, totals: { posts: 3, comments: 60, users: 7 }, filters: { postId: '', query: '' },
  items: [{ comment_id: 'comment-1', post_id: 'post-1', post_title: '亚比穿搭分享', parent_comment_id: '', level: 'comment', text: '公开评论仍可见', likes: 3, publish_time: now, location: '', source_url: 'https://example.test/post-1', user: { user_id: 'user-1', display_name: '公开用户', profile_url: '', avatar_url: '', xhs_id: '', bio: '', location: '', following_count: null, follower_count: null, liked_and_collected_count: null, roles: ['commenter'], comment_count: 1, post_ids: ['post-1'], enrichment_status: 'complete', access_status: 'complete', last_enriched_at: now }, collected_at: now }],
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openExpansion(page: Page, options: { initialRuntime?: MockRuntime; failStart?: boolean } = {}) {
  let runtime: MockRuntime = options.initialRuntime || 'idle'
  let newTaskRequests = 0
  let expansionStarts = 0
  let expansionCancels = 0
  const expansionAttempts: Array<{ seedPostIds: string[]; config: typeof config }> = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const expansion = state(runtime)
    const currentTask = runtime === 'idle' ? task : { ...task, workflowSummary: { ...task.workflowSummary, expansion: expansion.summary } }
    if (path === '/api/health') return json(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: false } })
    if (path === '/api/jobs' && method === 'GET') return json(route, [currentTask])
    if (path === '/api/jobs' && method === 'POST') { newTaskRequests += 1; return json(route, currentTask, 202) }
    if (path === '/api/relay/config') return json(route, { port: 18800, profile: 'openclaw', autoConnect: true })
    if (path === '/api/relay/status') return json(route, { running: true, cdpReady: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800 })
    if (path === '/api/email/config') return json(route, { provider: 'custom', host: '', port: 465, secure: true, requireTls: false, auth: 'login', user: '', from: '', configured: false, verified: false, oauth: {} })
    if (path === '/api/ai/providers') return json(route, [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test', models: ['test'], requiresKey: false, configured: true }])
    if (path === '/api/ai/local-models') return json(route, { runtime: { ready: false }, catalog: [], installedModels: [], install: null })
    if (path === '/api/ai/sessions' && method === 'POST') return json(route, { id: 'session-1', provider: 'codex', model: 'test', baseUrl: 'http://127.0.0.1', configured: true, expiresAt: now })
    if (path === '/api/profiles') return json(route, [])
    if (path.endsWith('/results')) return json(route, contentResults)
    if (path.endsWith('/audience')) return json(route, audienceResults)
    if (path.endsWith('/artifacts')) return json(route, [])
    if (path.endsWith('/expansion/start') && method === 'POST') {
      expansionStarts += 1
      if (options.failStart) return json(route, { error: 'Relay 启动失败，旧数据已保留' }, 503)
      await new Promise((resolve) => setTimeout(resolve, 80))
      runtime = 'running'
      const running = state(runtime)
      return json(route, { job: { ...task, workflowSummary: { ...task.workflowSummary, expansion: running.summary } }, attemptId: 'expansion-1', expansion: running }, 202)
    }
    if (path.endsWith('/expansion/attempts') && method === 'POST') {
      expansionAttempts.push(request.postDataJSON() as { seedPostIds: string[]; config: typeof config })
      runtime = 'running'
      const running = state(runtime)
      return json(route, { job: { ...task, workflowSummary: { ...task.workflowSummary, expansion: running.summary } }, attemptId: 'expansion-2', expansion: running }, 202)
    }
    if (path.endsWith('/expansion/resume') && method === 'POST') {
      runtime = 'running'
      const running = state(runtime)
      return json(route, { job: { ...task, workflowSummary: { ...task.workflowSummary, expansion: running.summary } }, attemptId: 'expansion-1', expansion: running }, 202)
    }
    if (path.endsWith('/expansion/cancel') && method === 'POST') {
      expansionCancels += 1
      runtime = 'partial'
      const partial = state(runtime)
      return json(route, { job: { ...task, workflowSummary: { ...task.workflowSummary, expansion: partial.summary } }, attemptId: 'expansion-1', expansion: partial }, 202)
    }
    if (path.endsWith('/expansion')) return json(route, expansion)
    return json(route, {})
  })
  await page.goto('/content?module=expansion', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '关系扩散' })).toBeVisible()
  return {
    counts: () => ({ newTaskRequests, expansionStarts, expansionCancels }),
    attempts: () => expansionAttempts,
    setRuntime: (next: MockRuntime) => { runtime = next },
  }
}

for (const viewport of [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
]) {
  test(`关系扩散独立工作台在 ${viewport.name} 原地续跑、刷新恢复且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.clock.setFixedTime(new Date(now))
    const harness = await openExpansion(page)
    const resultTabs = page.getByRole('tablist', { name: '非岗位研究结果模块' })
    await expect(resultTabs.getByRole('tab')).toHaveCount(3)
    await expect(page.getByRole('tab', { name: /关系扩散/ })).toContainText('多轮')
    await expect(page.locator('.expansion-seed-list > label')).toHaveCount(3)
    await expect(page.locator('.expansion-seed-list > label')).toContainText(['部分采集', '已采集', '未采集'])
    if (viewport.width > 640 && viewport.width <= 900) {
      const productTitle = page.locator('.product-title h1')
      const titleLayout = await productTitle.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        whiteSpace: getComputedStyle(element).whiteSpace,
      }))
      expect(titleLayout.whiteSpace).toBe('nowrap')
      expect(titleLayout.height).toBeLessThan(40)
    }
    await page.addStyleTag({ content: '.topbar, .side-rail { visibility: hidden !important; }' })
    await page.evaluate(async () => { await document.fonts.ready })
    const resultsPanel = page.locator('#results')
    await expect(resultsPanel).toBeVisible()
    expect(await resultsPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    await page.locator('.expansion-parameters').evaluate((element) => { (element as HTMLDetailsElement).open = true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.locator('.expansion-parameters').evaluate((element) => { (element as HTMLDetailsElement).open = false })
    await page.getByRole('button', { name: '开始扩散' }).dblclick()
    await expect(page.locator('.expansion-runtime')).toContainText('扩散中')
    await expect(page.locator('.expansion-runtime')).toContainText(task.id)
    expect(harness.counts()).toEqual({ newTaskRequests: 0, expansionStarts: 1, expansionCancels: 0 })
    expect(await resultsPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    await page.getByRole('tab', { name: /内容洞察/ }).click()
    await expect(page.getByRole('heading', { name: '已保存内容仍可见' })).toBeVisible()
    await page.getByRole('tab', { name: /受众及用户界面/ }).click()
    await expect(page.getByText('公开评论仍可见', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: /关系扩散/ }).click()
    await expect(page.locator('.expansion-metrics')).toContainText('60')

    await page.reload()
    await expect(page.locator('.expansion-runtime')).toContainText('扩散中')
    await expect(page.locator('.expansion-runtime')).toContainText(task.id)
    await expect(page.locator('.expansion-metrics')).toContainText('60')
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: '停止' }).click()
    await expect(page.locator('.expansion-runtime')).toContainText('部分完成')
    await expect(page.getByRole('button', { name: '继续扩散' })).toBeVisible()
    await expect(page.getByRole('link', { name: /expansion_summary\.json/ })).toBeVisible()
    expect(harness.counts()).toEqual({ newTaskRequests: 0, expansionStarts: 1, expansionCancels: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await resultsPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  })
}

test('关系扩散显示完成、阻断和失败状态，API 失败保留已有种子', async ({ page }) => {
  const harness = await openExpansion(page, { failStart: true })
  await page.getByRole('button', { name: '开始扩散' }).click()
  await expect(page.getByText('Relay 启动失败，旧数据已保留')).toBeVisible()
  await expect(page.locator('.expansion-seed-list > label')).toHaveCount(3)
  expect(harness.counts()).toEqual({ newTaskRequests: 0, expansionStarts: 1, expansionCancels: 0 })

  for (const [runtime, label] of [['completed', '已完成'], ['blocked', '需要处理'], ['failed', '运行失败']] as const) {
    harness.setRuntime(runtime)
    await page.reload()
    await expect(page.locator('.expansion-runtime')).toContainText(label)
  }
})

test('终态扩散可重新点选帖子并按所选帖子创建新 Attempt', async ({ page }) => {
  const harness = await openExpansion(page, { initialRuntime: 'partial' })
  const checkboxes = page.locator('.expansion-seed-list input[type="checkbox"]')
  await expect(checkboxes).toHaveCount(3)
  await expect(checkboxes.nth(0)).toBeEnabled()
  await expect(checkboxes.nth(1)).toBeEnabled()
  await checkboxes.nth(0).uncheck()
  await checkboxes.nth(1).check()

  await page.getByRole('button', { name: /Attempt/ }).click()
  await expect(page.locator('.expansion-runtime')).toContainText('扩散中')
  expect(harness.attempts()).toHaveLength(1)
  expect(new Set(harness.attempts()[0].seedPostIds)).toEqual(new Set(['post-2', 'post-3']))
  expect(harness.attempts()[0].config.rounds).toBe(2)
})
