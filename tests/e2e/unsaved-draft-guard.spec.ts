import { expect, test, type Page, type Route } from '@playwright/test'
import { draftContentHash } from '../../src/draft-state.mjs'

const candidateProfile = {
  name: '测试候选人',
  school: '测试大学',
  major: '数据分析',
  degreeYear: '研二',
  phoneWeChat: 'test-contact',
  email: 'candidate@example.test',
  availabilityDays: '5',
  internshipDuration: '6个月',
}

const baseDraft = {
  greeting: '你好，我对这个岗位很感兴趣。',
  email_subject: '测试岗位申请',
  email_body: '您好，这是测试邮件正文。',
  cover_letter: '这是一封基于岗位事实生成的测试 Cover Letter。',
}

function job(id: string, keyword: string, status: 'completed' | 'failed' = 'completed') {
  const now = '2026-08-01T08:00:00.000Z'
  return {
    id,
    keyword,
    status,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    progress: 100,
    progressPhase: 'done',
    progressLabel: status === 'completed' ? '任务完成' : '任务失败',
    progressCurrent: 2,
    progressTotal: 2,
    applicationCount: 2,
    artifactCount: 0,
    artifacts: [],
    resumeAvailable: id === 'job-b',
    config: {
      analysisMode: 'job',
      limit: 0,
      maxScrolls: 60,
      searchSort: 'latest',
      maxAgeDays: 0,
    },
    coverage: {
      discovered: 2,
      bodyAttempted: 2,
      bodySucceeded: 1,
      applicationInfo: 2,
      draftsGenerated: 2,
      qualityPassed: 2,
    },
  }
}

function application(noteId: string, title: string, draft = baseDraft) {
  const now = '2026-08-01T08:00:00.000Z'
  return {
    note_id: noteId,
    title,
    note_url: `https://example.test/${noteId}`,
    body: `${title} 的完整岗位正文`,
    access_status: 'ok',
    collected_at: now,
    publish_time: { raw: '2026-08-01', value: '2026-08-01', precision: 'day', is_estimated: false },
    job_card: {
      title,
      source_url: `https://example.test/${noteId}`,
      source_status: 'ok',
      parse_basis: 'full_body',
      source_excerpt: `${title} 的岗位事实`,
      responsibility_count: 1,
      requirement_count: 1,
      route_count: 1,
      status: 'complete',
    },
    application_info: {
      contacts: [],
      application_routes: [{
        type: 'email',
        value: 'recruiter@example.test',
        evidence: '正文测试邮箱',
        channel: 'email',
        confidence: 1,
        actionable: true,
      }],
      responsibilities: [{ text: '分析业务数据', source_field: 'body', evidence: '分析业务数据' }],
      requirements: [{ text: '熟悉 SQL', source_field: 'body', evidence: '熟悉 SQL' }],
    },
    outreach: {
      ...draft,
      generation_mode: 'model',
      runtime_status: 'generated',
      status: 'ready',
    },
    cover_letter_evaluation: {
      score: 95,
      passed: true,
      attempts: 1,
      threshold: 90,
      strengths: ['内容完整'],
      problems: [],
      rubric: { grounded: 95 },
    },
    draftVersion: {
      draftId: `draft-${noteId}`,
      version: 1,
      contentHash: draftContentHash(draft),
      qualityStatus: 'passed',
      qualityCheckedVersion: 1,
      qualityCheckedHash: draftContentHash(draft),
      createdAt: now,
      updatedAt: now,
    },
    delivery: null,
    quality: { body_complete: true },
  }
}

function results(jobId: string) {
  const suffix = jobId === 'job-a' ? 'A' : 'B'
  return {
    available: true,
    analysisMode: 'job',
    keyword: jobId === 'job-a' ? '任务甲' : '任务乙',
    research: null,
    presentation: null,
    insights: null,
    total: 2,
    offset: 0,
    limit: 20,
    items: [
      application(`${jobId}-note-1`, `岗位 ${suffix}1`),
      application(`${jobId}-note-2`, `岗位 ${suffix}2`),
    ],
    filters: {
      sort: 'newest',
      timeRange: 'all',
      stats: { all: 2, dated: 2, unknown: 0, incomplete: 1, withImages: 0 },
    },
    codexRuntime: { status: 'completed' },
    qualityGate: { passed: true },
  }
}

type ApiState = {
  draftRequests: number
  saveDelayMs: number
  saveFails: boolean
  qualityFails: boolean
  createdJobs: number
  resumeRequests: number
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockApi(page: Page, overrides: Partial<ApiState> = {}) {
  const state: ApiState = {
    draftRequests: 0,
    saveDelayMs: 0,
    saveFails: false,
    qualityFails: false,
    createdJobs: 0,
    resumeRequests: 0,
    ...overrides,
  }
  const jobs = [job('job-a', '任务甲'), job('job-b', '任务乙', 'failed')]
  const savedDrafts = new Map<string, { contentHash: string; version: number }>()

  await page.addInitScript((profile) => {
    localStorage.setItem('xhs-candidate-application-profile', JSON.stringify(profile))
  }, candidateProfile)

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/health') return fulfillJson(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: false, from: '', authMode: 'none' } })
    if (path === '/api/jobs' && method === 'GET') return fulfillJson(route, jobs)
    if (path === '/api/jobs' && method === 'POST') {
      state.createdJobs += 1
      return fulfillJson(route, job('job-new', '新任务'))
    }
    if (path === '/api/relay/config') return fulfillJson(route, { port: 18800, profile: 'openclaw', autoConnect: true })
    if (path === '/api/relay/status') return fulfillJson(route, { running: true, cdpReady: true, ready: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800, profile: 'openclaw' })
    if (path === '/api/email/config') return fulfillJson(route, { provider: 'custom', host: '', port: 465, secure: true, requireTls: false, auth: 'login', authMode: 'login', user: '', from: '', hasPassword: false, oauth: { tenant: '', clientId: '', scope: '', hasClientSecret: false, hasRefreshToken: false }, configured: false, verified: false, maskedFrom: '' })
    if (path === '/api/ai/providers') return fulfillJson(route, [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test-model', models: ['test-model'], requiresKey: false, wireApi: 'responses', configured: true, hasApiKey: true }])
    if (path === '/api/ai/local-models') return fulfillJson(route, { runtime: { ready: false, endpoint: '', message: 'not used' }, catalog: [], installedModels: [], install: null, fetchedAt: '2026-08-01T08:00:00.000Z' })
    if (path === '/api/ai/sessions' && method === 'POST') return fulfillJson(route, { id: 'session-1', provider: 'codex', model: 'test-model', baseUrl: 'http://127.0.0.1', wireApi: 'responses', configured: true, expiresAt: '2026-08-02T08:00:00.000Z' })
    if (path === '/api/profiles') return fulfillJson(route, [
      { id: 'profile-a', display_name: '档案甲', summary: '测试档案甲', skills: ['SQL'], sourceFiles: ['resume.pdf'], updatedAt: '2026-08-01T08:00:00.000Z', candidate_application: candidateProfile },
      { id: 'profile-b', display_name: '档案乙', summary: '测试档案乙', skills: ['Python'], sourceFiles: ['resume-b.pdf'], updatedAt: '2026-08-01T08:00:00.000Z', candidate_application: candidateProfile },
    ])

    const resultMatch = path.match(/^\/api\/jobs\/([^/]+)\/results$/)
    if (resultMatch) return fulfillJson(route, results(resultMatch[1]))
    if (/^\/api\/jobs\/[^/]+\/artifacts$/.test(path)) return fulfillJson(route, [])
    if (/^\/api\/jobs\/[^/]+\/resume$/.test(path) && method === 'POST') {
      state.resumeRequests += 1
      return fulfillJson(route, { ...jobs[1], status: 'resuming' })
    }
    if (/^\/api\/jobs\/[^/]+\/complete-missing$/.test(path) && method === 'POST') {
      return fulfillJson(route, { action: 'started', sourceJobId: 'job-a', incompleteBefore: 1, job: { ...jobs[0], status: 'resuming' }, message: 'started' })
    }
    if (/^\/api\/jobs\/[^/]+\/draft\/quality$/.test(path) && method === 'POST') {
      if (state.qualityFails) return fulfillJson(route, { error: 'mock quality check failed' }, 500)
      const payload = request.postDataJSON() as { noteId: string; draftId: string; version: number }
      const current = application(payload.noteId, '质量检查结果')
      const saved = savedDrafts.get(payload.noteId)
      const contentHash = saved?.contentHash || current.draftVersion.contentHash
      const version = {
        ...current.draftVersion,
        draftId: payload.draftId,
        version: payload.version,
        contentHash,
        qualityStatus: 'passed',
        qualityCheckedVersion: payload.version,
        qualityCheckedHash: contentHash,
      }
      return fulfillJson(route, { noteId: payload.noteId, draftVersion: version, cover_letter_evaluation: current.cover_letter_evaluation, delivery: null })
    }
    if (/^\/api\/jobs\/[^/]+\/draft$/.test(path) && method === 'POST') {
      state.draftRequests += 1
      if (state.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, state.saveDelayMs))
      if (state.saveFails) return fulfillJson(route, { error: 'mock save failed' }, 500)
      const payload = request.postDataJSON() as { noteId: string; outreach: typeof baseDraft; draftId: string; baseVersion: number }
      const nextVersion = payload.baseVersion + 1
      const contentHash = draftContentHash(payload.outreach)
      savedDrafts.set(payload.noteId, { contentHash, version: nextVersion })
      return fulfillJson(route, {
        noteId: payload.noteId,
        outreach: payload.outreach,
        draftVersion: {
          draftId: payload.draftId,
          version: nextVersion,
          contentHash,
          qualityStatus: 'stale',
          qualityCheckedVersion: null,
          qualityCheckedHash: null,
          createdAt: '2026-08-01T08:00:00.000Z',
          updatedAt: '2026-08-01T08:01:00.000Z',
        },
        delivery: null,
      })
    }

    return fulfillJson(route, {})
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: '查看岗位：岗位 A1' })).toBeVisible()
  await expect(page.getByLabel('私信文案')).toHaveValue(baseDraft.greeting)
  return state
}

async function dirtyGreeting(page: Page, suffix = ' 本地修改') {
  await page.getByLabel('私信文案').fill(`${baseDraft.greeting}${suffix}`)
  await expect(page.getByRole('button', { name: '保存修改' })).toBeEnabled()
}

async function expectGuard(page: Page, reason: string) {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(reason)
  return dialog
}

test('统一 Guard 覆盖岗位、任务、恢复、新任务、重新生成、Profile 和三类文案', async ({ page }) => {
  test.setTimeout(60_000)
  await mockApi(page)
  await dirtyGreeting(page)

  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await expectGuard(page, '切换岗位')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.getByRole('row', { name: /任务乙/ }).click()
  await expectGuard(page, '切换任务')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.getByRole('button', { name: '重试' }).click()
  await expectGuard(page, '恢复其他任务')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.getByRole('button', { name: '启动全流程' }).click()
  await expectGuard(page, '启动新任务')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.getByRole('button', { name: '一键智能补全' }).click()
  await expectGuard(page, '重新生成当前文案')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.locator('.profile-actions select').selectOption('profile-b')
  await expectGuard(page, '切换 Profile')
  await page.getByRole('button', { name: '取消操作' }).click()

  await page.getByLabel('邮件主题').fill(`${baseDraft.email_subject} 修改`)
  await page.getByLabel('邮件正文').fill(`${baseDraft.email_body} 修改`)
  await page.getByLabel('Cover Letter').fill(`${baseDraft.cover_letter} 修改`)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await expectGuard(page, '切换岗位')
})

test('取消、放弃和保存并继续分别保留、回滚和持久化草稿', async ({ page }) => {
  const state = await mockApi(page)
  const changed = `${baseDraft.greeting} 需要保留`
  await page.getByLabel('私信文案').fill(changed)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await expectGuard(page, '切换岗位')

  await page.getByRole('button', { name: '取消操作' }).click()
  await expect(page.getByLabel('私信文案')).toHaveValue(changed)
  await expect(page.getByRole('heading', { name: '岗位 A1' })).toBeVisible()

  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  await expect(page.getByLabel('私信文案')).toHaveValue(baseDraft.greeting)

  await page.getByRole('button', { name: '查看岗位：岗位 A1' }).click()
  await dirtyGreeting(page, ' 保存后切换')
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await page.getByRole('button', { name: '保存并继续' }).click()
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  expect(state.draftRequests).toBe(1)
})

test('保存失败不离开、不丢文本', async ({ page }) => {
  const state = await mockApi(page, { saveFails: true })
  const changed = `${baseDraft.greeting} 保存失败仍保留`
  await page.getByLabel('私信文案').fill(changed)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await page.getByRole('button', { name: '保存并继续' }).click()

  await expect(page.locator('.draft-guard-error')).toContainText('保存失败')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByLabel('私信文案')).toHaveValue(changed)
  await expect(page.getByRole('heading', { name: '岗位 A1' })).toBeVisible()
  expect(state.draftRequests).toBe(1)
})

test('快速连续点击保存并继续只保存和跳转一次，保存中切任务不抢占目标', async ({ page }) => {
  const state = await mockApi(page, { saveDelayMs: 1_500 })
  await dirtyGreeting(page, ' 快速保存')
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  const saveAndContinue = page.getByRole('button', { name: '保存并继续' })
  await saveAndContinue.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.getByRole('row', { name: /任务乙/ }).click({ force: true })
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  expect(state.draftRequests).toBe(1)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('旧响应门禁拒绝过期响应', async ({ page }) => {
  await mockApi(page)
  const accepted = await page.evaluate(async () => {
    const { createLatestRequestGate } = await import('/src/draft-state.mjs')
    const gate = createLatestRequestGate()
    const oldRequest = gate.begin()
    const newRequest = gate.begin()
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { old: gate.isLatest(oldRequest), current: gate.isLatest(newRequest) }
  })
  expect(accepted).toEqual({ old: false, current: true })
})

test('保存成功但质量复核未完成时明确标记质量失效', async ({ page }) => {
  const state = await mockApi(page, { qualityFails: true })
  await dirtyGreeting(page, ' 等待质量复核')
  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByRole('button', { name: '质量已失效' })).toBeVisible()
  await expect(page.getByText('投递文案已保存，但质量复检未完成')).toBeVisible()
  expect(state.draftRequests).toBe(1)
})

test('beforeunload 仅在哈希变化时拦截刷新和关闭', async ({ page }) => {
  await mockApi(page)
  const clean = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(clean).toBe(false)

  await dirtyGreeting(page, ' 刷新保护')
  const dirty = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(dirty).toBe(true)

  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await page.getByRole('button', { name: '取消操作' }).click()
  await expect(page.getByLabel('私信文案')).toContainText('刷新保护')
})

test('无修改时岗位和任务切换不弹窗', async ({ page }) => {
  await mockApi(page)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  await page.getByRole('row', { name: /任务乙/ }).click()
  await expect(page.getByRole('button', { name: '查看岗位：岗位 B1' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

for (const viewport of [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
]) {
  test(`确认弹窗视觉快照 ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await mockApi(page)
    await dirtyGreeting(page, ` ${viewport.name}`)
    await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
    const dialog = await expectGuard(page, '切换岗位')
    await page.screenshot({ path: `output/playwright/phase9-after/${viewport.name}.png` })
    await expect(dialog).toHaveScreenshot(`${viewport.name}.png`, { maxDiffPixels: 20 })
  })
}
