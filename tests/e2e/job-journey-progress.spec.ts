import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-08-03T08:00:00.000Z'
const retryAt = '2026-08-03T08:12:00.000Z'
const jobId = 'job-journey-1'
const rawError = 'BODY_RATE_LIMIT: upstream returned 429 for note detail request'

const job = {
  id: jobId,
  keyword: 'ai产品经理',
  status: 'incomplete',
  createdAt: '2026-08-03T07:00:00.000Z',
  startedAt: '2026-08-03T07:00:10.000Z',
  updatedAt: '2026-08-03T07:58:00.000Z',
  finishedAt: '2026-08-03T07:58:00.000Z',
  progress: 78,
  progressPhase: 'body_rate_limited',
  message: rawError,
  applicationCount: 87,
  artifactCount: 0,
  artifacts: [],
  resumeAvailable: true,
  currentAttemptId: 'attempt-3',
  revision: 12,
  config: {
    analysisMode: 'job',
    limit: 0,
    maxScrolls: 60,
    searchSort: 'latest',
    maxAgeDays: 14,
  },
  bodyMetrics: {
    schemaVersion: 1,
    statisticsSource: 'bodyCompletionLedger',
    legacyInferred: false,
    discovered: 320,
    attempted: 251,
    succeeded: 251,
    failed: 0,
    notAttempted: 69,
    blocked: 0,
    cancelled: 0,
    pending: 0,
    completionRatePercent: 78.4,
    conservation: {
      left: 320,
      right: 320,
      valid: true,
      terminal: false,
      formula: 'discovered = succeeded + failed + notAttempted + blocked + cancelled + pending',
    },
  },
  experienceSnapshot: {
    schemaVersion: 3,
    revision: 12,
    throughSequence: 99,
    jobId,
    activeAttemptId: 'attempt-3',
    journey: 'job',
    state: 'partial',
    activeStage: 'body',
    headline: '正在获取完整岗位详情',
    detail: '已保存 251 篇完整正文，剩余内容会从检查点继续。',
    stages: [
      {
        stage: 'preflight',
        state: 'completed',
        headline: '准备采集环境',
        detail: '登录状态、关键词和时间范围已检查',
        progress: { unit: 'file', done: 1, total: 1, succeeded: 1, reused: 0, retryable: 0, failed: 0, blocked: 0 },
      },
      {
        stage: 'discovery',
        state: 'completed',
        headline: '查找近 14 天相关内容',
        detail: '已发现 320 条相关内容',
        progress: { unit: 'card', done: 320, total: 320, succeeded: 320, reused: 0, retryable: 0, failed: 0, blocked: 0 },
      },
      {
        stage: 'body',
        state: 'waiting_system',
        headline: '获取完整岗位详情',
        detail: '已完成 251 / 320，正在等待平台恢复',
        progress: { unit: 'body', done: 251, total: 320, succeeded: 168, reused: 83, retryable: 69, failed: 0, blocked: 0 },
      },
      {
        stage: 'classify',
        state: 'queued',
        headline: '区分招聘信息和经验分享',
        detail: '等待剩余正文完成',
        progress: { unit: 'job', done: 120, total: 251, succeeded: 120, reused: 0, retryable: 0, failed: 0, blocked: 0 },
      },
      {
        stage: 'artifact',
        state: 'queued',
        headline: '整理页面结果和下载文件',
        detail: '会持续写入同一任务',
        progress: { unit: 'file', done: 0, total: 1, succeeded: 0, reused: 0, retryable: 0, failed: 0, blocked: 0 },
      },
    ],
    counts: {
      discovered: 320,
      fullText: 251,
      confirmedJobs: 120,
      nonJobs: 131,
      matchReady: 102,
      draftReady: 90,
      applicationReady: 87,
      pending: 69,
      retryable: 69,
      unavailable: 0,
    },
    speed: {
      activePerMinute: 9.6,
      wallPerMinute: 4.2,
      cacheHits: 83,
      networkSuccess: 168,
      etaMinSeconds: 420,
      etaMaxSeconds: 600,
      confidence: 'high',
    },
    issues: [
      {
        code: 'RATE_LIMITED',
        category: 'access',
        severity: 'warning',
        userTitle: '平台暂时限制访问',
        userMessage: '已保存 251/320 篇，系统已暂停新的访问，现有结果不会丢失。',
        preservedResultCount: 251,
        automaticAction: '等待后自动进行一次恢复检查',
        retryable: true,
        retryAt,
        requiresUserAction: false,
        action: { id: 'probe_rate_limit', label: '旧版恢复操作' },
        affectedStage: 'body',
        technicalRef: 'rate-limit:attempt-3',
      },
    ],
    connection: { state: 'offline', lastEventAt: '2026-08-03T07:58:00.000Z' },
    checkpoint: { revision: 12, savedAt: '2026-08-03T07:58:00.000Z', resumeAvailable: true },
  },
}

const unknownJob = {
  ...job,
  status: 'failed',
  message: 'UNKNOWN_ERROR: upstream returned an unclassified error',
  experienceSnapshot: {
    ...job.experienceSnapshot,
    state: 'failed',
    headline: '当前步骤遇到未识别问题',
    detail: '系统内部返回 unknown error',
    issues: [
      {
        code: 'UNKNOWN_ERROR',
        category: 'system',
        severity: 'blocking',
        userTitle: '当前步骤遇到未识别问题',
        userMessage: 'unknown error',
        preservedResultCount: 251,
        retryable: true,
        requiresUserAction: true,
        action: { id: 'resume', label: '继续任务' },
        affectedStage: 'body',
        technicalRef: 'test:unknown',
      },
    ],
  },
}

const emptyResults = {
  available: true,
  analysisMode: 'job',
  keyword: 'ai产品经理',
  research: null,
  presentation: null,
  insights: null,
  total: 0,
  offset: 0,
  limit: 20,
  items: [],
  filters: {
    sort: 'newest',
    timeRange: 'all',
    stats: { all: 0, dated: 0, unknown: 0, incomplete: 0, withImages: 0 },
  },
  codexRuntime: { status: 'partial' },
  qualityGate: { passed: false },
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openJourney(page: Page, journeyJob = job) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/health') return json(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: false } })
    if (path === '/api/jobs' && method === 'GET') return json(route, [journeyJob])
    if (path === '/api/relay/config') return json(route, { port: 18800, profile: 'openclaw', autoConnect: true })
    if (path === '/api/relay/status') return json(route, { running: true, cdpReady: true, ready: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800 })
    if (path === '/api/email/config') return json(route, { provider: 'custom', host: '', port: 465, secure: true, requireTls: false, auth: 'login', user: '', from: '', configured: false, verified: false, oauth: {} })
    if (path === '/api/ai/providers') return json(route, [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test', models: ['test'], requiresKey: false, configured: true, hasApiKey: true, wireApi: 'responses' }])
    if (path === '/api/ai/local-models') return json(route, { runtime: { ready: false }, catalog: [], installedModels: [], install: null })
    if (path === '/api/ai/sessions' && method === 'POST') return json(route, { id: 'session-journey', provider: 'codex', model: 'test', baseUrl: 'http://127.0.0.1', wireApi: 'responses', configured: true, expiresAt: '2026-08-03T09:00:00.000Z' })
    if (path === '/api/profiles') return json(route, [])
    if (path === `/api/jobs/${jobId}/results`) return json(route, emptyResults)
    if (path === `/api/jobs/${jobId}/artifacts`) return json(route, [])
    if (path === `/api/jobs/${jobId}/actions/check-recovery` && method === 'POST') {
      return json(route, {
        action: 'started',
        jobId,
        stage: 'body',
        scope: 'body_completion',
        job: { ...journeyJob, status: 'resuming' },
        snapshot: journeyJob.experienceSnapshot,
      }, 202)
    }
    if (path === `/api/jobs/${jobId}`) return json(route, journeyJob)
    return json(route, {})
  })
  await page.clock.setFixedTime(new Date(now))
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.locator('.job-journey-panel')).toBeVisible({ timeout: 45_000 })
}

test('旧版未识别错误会转换成可理解的复查提示', async ({ page }) => {
  await openJourney(page, unknownJob)

  const journey = page.locator('.job-journey-panel')
  await expect(journey.getByRole('heading', { name: '当前步骤需要重新检查' })).toBeVisible()
  await expect(journey.getByText(/系统暂时没有返回可读的原因/).first()).toBeVisible()
  await expect(journey.getByText('已保存 251 条结果').first()).toBeVisible()
  await expect(page.getByText('当前步骤遇到未识别问题', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/unknown error/i)).toHaveCount(0)
})

for (const viewport of [
  { name: 'mobile-360', width: 360, height: 800 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 900 },
]) {
  test(`求职者进度在 ${viewport.name} 显示真实正文、限流恢复与折叠技术详情`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openJourney(page)

    const journey = page.locator('.job-journey-panel')
    await expect(journey.getByRole('heading', { name: '正在获取完整岗位详情' })).toBeVisible()
    await expect(journey.getByRole('heading', { name: '已获取 251 / 320 篇完整正文' })).toBeVisible()
    await expect(journey.getByRole('progressbar', { name: '完整正文采集进度' })).toHaveAttribute('aria-valuenow', '78')
    await expect(journey.getByText('9.6 篇/分钟')).toBeVisible()
    await expect(journey.getByText('83 篇直接复用')).toBeVisible()
    await expect(journey.getByText('可查看岗位').locator('..').getByText('87')).toBeVisible()
    await expect(journey.getByText('平台暂时限制访问')).toBeVisible()
    await expect(journey.getByRole('button', { name: '立即检查是否恢复' })).toBeVisible()
    await expect(journey.getByText('状态已保存')).toBeVisible()
    await expect(journey.getByText(/预计还需/)).toHaveCount(0)
    await expect(page.getByText('一键解除限流并继续')).toHaveCount(0)
    await expect(page.getByText(/SSE/)).toHaveCount(0)

    if (viewport.name === 'desktop-1440') {
      const recoveryRequest = page.waitForRequest((request) => (
        request.method() === 'POST'
        && new URL(request.url()).pathname === `/api/jobs/${jobId}/actions/check-recovery`
      ))
      await journey.getByRole('button', { name: '立即检查是否恢复' }).click()
      const request = await recoveryRequest
      expect(request.postDataJSON()).toMatchObject({ idempotencyKey: expect.any(String) })
      await expect(page.getByText('恢复检查已启动，只处理尚未完成的内容。')).toBeVisible()
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const screenshotMask = await page.addStyleTag({ content: '.topbar, .side-rail { visibility: hidden !important; }' })
    await journey.screenshot({ path: `test-results/job-journey-progress-${viewport.name}.png` })
    await screenshotMask.evaluate((node) => node.remove())

    const rawMessage = page.getByText(rawError, { exact: true })
    await expect(rawMessage).not.toBeVisible()
    await page.getByText('技术详情', { exact: true }).click()
    await expect(rawMessage).toBeVisible()
  })
}
