import { expect, test, type Page, type Request, type Route } from '@playwright/test'
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

const rewrittenCoverLetter = `${'我申请岗位 A1，并针对分析业务数据和熟悉 SQL 两项要求说明匹配经历。'.repeat(24)}感谢招聘团队审阅。`

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
        evidence_hash: 'a'.repeat(64),
        source_revision: 'route-revision-1',
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

type AttachmentUploadRequest = {
  contentType: string
  filename: string
  fileText: string
  noteId: string
  source: string
  selected: string
  draftId: string
  draftVersion: string
}

type ProfileAttachmentRequest = {
  noteId: string
  profileId: string
  sourceFile: string
  selected: boolean
  draftId: string
  draftVersion: number
}

type ArtifactAttachmentRequest = {
  noteId: string
  artifactId: string
  displayName: string
  selected: boolean
  draftId: string
  draftVersion: number
  contentHash: string
}

type CoverLetterAttachmentRequest = {
  noteId: string
  selected: boolean
  draftId: string
  draftVersion: number
  contentHash: string
}

type PreviewRequest = {
  noteId: string
  to: string
  attachmentIds: string[]
  draftId: string
  version: number
  evidenceHash?: string
  sourceRevision?: string
}

type SendRequest = PreviewRequest & {
  outreach: typeof baseDraft
  previewRevision: string
  attachmentBundleHash: string
  idempotencyKey: string
}

type QualityRequest = {
  noteId: string
  draftId: string
  version: number
  attachmentIds: string[]
  aiSessionId?: string
  applicationContext: {
    channel: 'email' | 'direct_message'
    contactStage: 'first_contact' | 'follow_up'
    tone: 'formal' | 'natural' | 'concise'
    resumeAttached: boolean
    coverLetterAttached: boolean
    recipientType: string
  }
}

type DraftRequest = {
  noteId: string
  outreach: typeof baseDraft
  draftId: string
  baseVersion: number
  applicationContext: QualityRequest['applicationContext']
}

type CoverLetterRewriteRequest = {
  noteId: string
  aiSessionId: string
  instructions: string
  outreach: typeof baseDraft
  applicationContext: QualityRequest['applicationContext']
  draftId: string
  baseVersion: number
}

type ApiState = {
  aiSessionRequests: number
  draftRequests: number
  draftPayloads: DraftRequest[]
  rewriteRequests: number
  rewritePayloads: CoverLetterRewriteRequest[]
  rewriteCoverLetter: string
  localModelReady: boolean
  saveDelayMs: number
  saveFails: boolean
  qualityFails: boolean
  qualityPayloads: QualityRequest[]
  createdJobs: number
  resumeRequests: number
  emailConfigured: boolean
  previewRequests: number
  sendRequests: number
  attachmentUploads: number
  attachmentUploadDelayMs: number
  attachmentUploadRequests: AttachmentUploadRequest[]
  profileAttachmentRequests: ProfileAttachmentRequest[]
  artifactAttachmentRequests: ArtifactAttachmentRequest[]
  coverLetterAttachmentRequests: CoverLetterAttachmentRequest[]
  jobArtifacts: Array<{ id: string; name: string; size: number; type: string }>
  previewPayloads: PreviewRequest[]
  sendPayloads: SendRequest[]
  attachmentSelectionUpdates: Array<{ attachmentId: string; selected: boolean }>
  attachmentDeletes: string[]
  resultDelivery: Record<string, unknown> | null
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function multipartField(body: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`name="${escaped}"\\r?\\n\\r?\\n([^\\r\\n]*)`).exec(body)?.[1] || ''
}

function readMultipartUpload(request: Request): AttachmentUploadRequest {
  const contentType = request.headers()['content-type'] || ''
  const body = request.postDataBuffer()?.toString('utf8') || ''
  return {
    contentType,
    filename: /name="file"; filename="([^"]+)"/.exec(body)?.[1] || '',
    fileText: /name="file"; filename="[^"]+"\r?\nContent-Type:[^\r\n]+\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(body)?.[1] || '',
    noteId: multipartField(body, 'noteId'),
    source: multipartField(body, 'source'),
    selected: multipartField(body, 'selected'),
    draftId: multipartField(body, 'draftId'),
    draftVersion: multipartField(body, 'draftVersion'),
  }
}

async function mockApi(page: Page, overrides: Partial<ApiState> = {}) {
  const state: ApiState = {
    aiSessionRequests: 0,
    draftRequests: 0,
    draftPayloads: [],
    rewriteRequests: 0,
    rewritePayloads: [],
    rewriteCoverLetter: rewrittenCoverLetter,
    localModelReady: false,
    saveDelayMs: 0,
    saveFails: false,
    qualityFails: false,
    qualityPayloads: [],
    createdJobs: 0,
    resumeRequests: 0,
    emailConfigured: false,
    previewRequests: 0,
    sendRequests: 0,
    attachmentUploads: 0,
    attachmentUploadDelayMs: 0,
    attachmentUploadRequests: [],
    profileAttachmentRequests: [],
    artifactAttachmentRequests: [],
    coverLetterAttachmentRequests: [],
    jobArtifacts: [],
    previewPayloads: [],
    sendPayloads: [],
    attachmentSelectionUpdates: [],
    attachmentDeletes: [],
    resultDelivery: null,
    ...overrides,
  }
  const jobs = [job('job-a', '任务甲'), job('job-b', '任务乙', 'failed')]
  const savedDrafts = new Map<string, { contentHash: string; version: number }>()
  const attachments = new Map<string, Array<Record<string, unknown>>>()

  await page.addInitScript((profile) => {
    localStorage.setItem('xhs-candidate-application-profile', JSON.stringify(profile))
  }, candidateProfile)

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/health') return fulfillJson(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: state.emailConfigured, from: state.emailConfigured ? 'sender@example.test' : '', authMode: state.emailConfigured ? 'login' : 'none' } })
    if (path === '/api/jobs' && method === 'GET') return fulfillJson(route, jobs)
    if (path === '/api/jobs' && method === 'POST') {
      state.createdJobs += 1
      return fulfillJson(route, job('job-new', '新任务'))
    }
    if (path === '/api/relay/config') return fulfillJson(route, { port: 18800, profile: 'openclaw', autoConnect: true })
    if (path === '/api/relay/status') return fulfillJson(route, { running: true, cdpReady: true, ready: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800, profile: 'openclaw' })
    if (path === '/api/email/config') return fulfillJson(route, { provider: 'custom', host: state.emailConfigured ? 'smtp.example.test' : '', port: 465, secure: true, requireTls: false, auth: 'login', authMode: 'login', user: state.emailConfigured ? 'sender@example.test' : '', from: state.emailConfigured ? 'sender@example.test' : '', hasPassword: state.emailConfigured, oauth: { tenant: '', clientId: '', scope: '', hasClientSecret: false, hasRefreshToken: false }, configured: state.emailConfigured, verified: state.emailConfigured, maskedFrom: state.emailConfigured ? 's***@example.test' : '' })
    if (path === '/api/ai/providers') return fulfillJson(route, [
      { id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test-model', models: ['test-model'], requiresKey: false, wireApi: 'responses', configured: true, hasApiKey: true },
      ...(state.localModelReady ? [{ id: 'local_qwen', label: '本地免费模型库', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:4b', models: ['qwen3.5:4b'], requiresKey: false, wireApi: 'chat_completions', configured: true, hasApiKey: false, local: true, free: true }] : []),
    ])
    if (path === '/api/ai/local-models') return fulfillJson(route, state.localModelReady
      ? { runtime: { ready: true, endpoint: 'http://127.0.0.1:11434', version: '0.11.0', message: 'ready' }, catalog: [{ id: 'qwen3.5:4b', label: 'Qwen3.5 4B', description: 'fixture', downloadBytes: 1, family: 'Qwen3.5', tier: '均衡', recommended: true, custom: false, installed: true }], installedModels: [{ name: 'qwen3.5:4b', size: 1 }], install: null, fetchedAt: '2026-08-01T08:00:00.000Z' }
      : { runtime: { ready: false, endpoint: '', message: 'not used' }, catalog: [], installedModels: [], install: null, fetchedAt: '2026-08-01T08:00:00.000Z' })
    if (path === '/api/ai/models' && method === 'POST') {
      const payload = request.postDataJSON() as { provider: string; baseUrl: string }
      return fulfillJson(route, { provider: payload.provider, baseUrl: payload.baseUrl, models: ['qwen3.5:4b'], fetchedAt: '2026-08-01T08:00:00.000Z' })
    }
    if (path === '/api/ai/sessions' && method === 'POST') {
      state.aiSessionRequests += 1
      const payload = request.postDataJSON() as { provider: string; model: string; baseUrl: string; wireApi: 'responses' | 'chat_completions' }
      const local = payload.provider === 'local_qwen'
      return fulfillJson(route, { id: local ? 'session-local' : 'session-1', provider: payload.provider, model: payload.model, baseUrl: payload.baseUrl, wireApi: payload.wireApi, configured: true, expiresAt: '2026-08-02T08:00:00.000Z' })
    }
    if (path === '/api/profiles') return fulfillJson(route, [
      { id: 'profile-a', display_name: '档案甲', summary: '测试档案甲', skills: ['SQL'], sourceFiles: ['resume.pdf'], updatedAt: '2026-08-01T08:00:00.000Z', candidate_application: candidateProfile },
      { id: 'profile-b', display_name: '档案乙', summary: '测试档案乙', skills: ['Python'], sourceFiles: ['resume-b.pdf'], updatedAt: '2026-08-01T08:00:00.000Z', candidate_application: candidateProfile },
    ])

    const resultMatch = path.match(/^\/api\/jobs\/([^/]+)\/results$/)
    if (resultMatch) {
      const payload = results(resultMatch[1])
      return fulfillJson(route, state.resultDelivery
        ? { ...payload, items: payload.items.map((item, index) => index === 0 ? { ...item, delivery: state.resultDelivery } : item) }
        : payload)
    }
    const attachmentCollectionMatch = path.match(/^\/api\/jobs\/([^/]+)\/application-attachments$/)
    if (attachmentCollectionMatch && method === 'GET') {
      const noteId = url.searchParams.get('noteId') || ''
      const items = attachments.get(noteId) || []
      const selected = items.filter((item) => item.selected)
      return fulfillJson(route, {
        schemaVersion: 1,
        revision: items.length,
        noteId,
        attachments: items,
        selectedSummary: { count: selected.length, totalBytes: selected.reduce((sum, item) => sum + Number(item.size || 0), 0) },
        limits: { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 },
      })
    }
    if (attachmentCollectionMatch && method === 'POST') {
      const captured = readMultipartUpload(request)
      state.attachmentUploadRequests.push(captured)
      if (!captured.contentType.startsWith('multipart/form-data; boundary=')
        || !captured.filename
        || !captured.noteId
        || !captured.source) {
        return fulfillJson(route, { error: 'invalid multipart fixture request' }, 400)
      }
      if (state.attachmentUploadDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.attachmentUploadDelayMs))
      }
      const noteId = captured.noteId
      const now = '2026-08-01T08:02:00.000Z'
      state.attachmentUploads += 1
      const sequence = state.attachmentUploads
      const displayName = captured.filename
      const attachment = {
        attachmentId: `attachment-pdf-${sequence}`, jobId: attachmentCollectionMatch[1], noteId,
        originalName: displayName, displayName, extension: '.pdf', mediaType: 'application/pdf',
        size: 31 + sequence, sha256: String(sequence).repeat(64), source: captured.source, createdAt: now, updatedAt: now,
        status: 'ready', validationStatus: 'passed', validationError: '', selected: true,
        generatedFrom: '', draftId: captured.draftId, draftVersion: Number(captured.draftVersion),
      }
      const items = [...(attachments.get(noteId) || []), attachment]
      attachments.set(noteId, items)
      return fulfillJson(route, { attachment, duplicate: false, revision: items.length }, 201)
    }
    const profileAttachmentMatch = path.match(/^\/api\/jobs\/([^/]+)\/application-attachments\/from-profile$/)
    if (profileAttachmentMatch && method === 'POST') {
      const payload = request.postDataJSON() as ProfileAttachmentRequest
      state.profileAttachmentRequests.push(payload)
      if (!payload.noteId || !payload.profileId || !payload.sourceFile || payload.selected !== true) {
        return fulfillJson(route, { error: 'invalid profile attachment fixture request' }, 400)
      }
      const now = '2026-08-01T08:02:00.000Z'
      const sequence = state.profileAttachmentRequests.length
      const displayName = payload.sourceFile.split(/[\\/]/).pop() || payload.sourceFile
      const attachment = {
        attachmentId: `attachment-profile-${sequence}`, jobId: profileAttachmentMatch[1], noteId: payload.noteId,
        originalName: displayName, displayName, extension: '.pdf', mediaType: 'application/pdf',
        size: 4_096, sha256: 'a'.repeat(64), source: 'candidate_profile', createdAt: now, updatedAt: now,
        status: 'ready', validationStatus: 'passed', validationError: '', selected: true,
        generatedFrom: payload.sourceFile, draftId: payload.draftId, draftVersion: payload.draftVersion,
      }
      const items = [...(attachments.get(payload.noteId) || []), attachment]
      attachments.set(payload.noteId, items)
      return fulfillJson(route, { attachment, duplicate: false, revision: items.length }, 201)
    }
    const artifactAttachmentMatch = path.match(/^\/api\/jobs\/([^/]+)\/application-attachments\/from-artifact$/)
    if (artifactAttachmentMatch && method === 'POST') {
      const payload = request.postDataJSON() as ArtifactAttachmentRequest
      state.artifactAttachmentRequests.push(payload)
      const artifact = state.jobArtifacts.find((item) => item.id === payload.artifactId)
      if (!artifact || !payload.noteId || payload.selected !== true) {
        return fulfillJson(route, { error: 'invalid artifact attachment fixture request' }, 400)
      }
      const now = '2026-08-01T08:02:00.000Z'
      const attachment = {
        attachmentId: `attachment-artifact-${state.artifactAttachmentRequests.length}`, jobId: artifactAttachmentMatch[1], noteId: payload.noteId,
        originalName: artifact.name, displayName: payload.displayName || artifact.name, extension: '.pdf', mediaType: 'application/pdf',
        size: artifact.size, sha256: 'c'.repeat(64), source: 'job_artifact', createdAt: now, updatedAt: now,
        status: 'ready', validationStatus: 'passed', validationError: '', selected: true,
        generatedFrom: `artifact:${payload.artifactId}`, draftId: payload.draftId, draftVersion: payload.draftVersion,
      }
      const items = [...(attachments.get(payload.noteId) || []), attachment]
      attachments.set(payload.noteId, items)
      return fulfillJson(route, { attachment, duplicate: false, revision: items.length }, 201)
    }
    const coverLetterAttachmentMatch = path.match(/^\/api\/jobs\/([^/]+)\/application-attachments\/from-cover-letter$/)
    if (coverLetterAttachmentMatch && method === 'POST') {
      const payload = request.postDataJSON() as CoverLetterAttachmentRequest
      state.coverLetterAttachmentRequests.push(payload)
      const saved = savedDrafts.get(payload.noteId)
      if (!payload.noteId || !payload.draftId || payload.selected !== true || !saved || saved.version !== payload.draftVersion || saved.contentHash !== payload.contentHash) {
        return fulfillJson(route, { error: 'stale cover letter fixture request' }, 409)
      }
      const now = '2026-08-01T08:02:00.000Z'
      const displayName = '岗位 A1-Cover-Letter.txt'
      const attachment = {
        attachmentId: `attachment-cover-letter-${state.coverLetterAttachmentRequests.length}`, jobId: coverLetterAttachmentMatch[1], noteId: payload.noteId,
        originalName: displayName, displayName, extension: '.txt', mediaType: 'text/plain',
        size: saved.contentHash.length, sha256: 'd'.repeat(64), source: 'generated_cover_letter', createdAt: now, updatedAt: now,
        status: 'ready', validationStatus: 'passed', validationError: '', selected: true,
        generatedFrom: `draft:${payload.draftId}:v${payload.draftVersion}`, draftId: payload.draftId, draftVersion: payload.draftVersion,
      }
      const items = [...(attachments.get(payload.noteId) || []), attachment]
      attachments.set(payload.noteId, items)
      return fulfillJson(route, { attachment, duplicate: false, revision: items.length }, 201)
    }
    const attachmentItemMatch = path.match(/^\/api\/jobs\/([^/]+)\/application-attachments\/([^/]+)$/)
    if (attachmentItemMatch && method === 'PATCH') {
      const noteId = `${attachmentItemMatch[1]}-note-1`
      const payload = request.postDataJSON() as { selected?: boolean }
      const item = (attachments.get(noteId) || []).find((candidate) => candidate.attachmentId === attachmentItemMatch[2])
      if (item && typeof payload.selected === 'boolean') {
        item.selected = payload.selected
        state.attachmentSelectionUpdates.push({ attachmentId: attachmentItemMatch[2], selected: payload.selected })
      }
      return fulfillJson(route, { attachment: item, revision: 2 })
    }
    if (attachmentItemMatch && method === 'DELETE') {
      const noteId = `${attachmentItemMatch[1]}-note-1`
      state.attachmentDeletes.push(attachmentItemMatch[2])
      attachments.set(noteId, (attachments.get(noteId) || []).filter((candidate) => candidate.attachmentId !== attachmentItemMatch[2]))
      return fulfillJson(route, { attachmentId: attachmentItemMatch[2], deleted: true, revision: 2 })
    }
    if (/^\/api\/jobs\/[^/]+\/application-attachments\/[^/]+\/content$/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.7\nfixture\n') })
    }
    if (/^\/api\/jobs\/[^/]+\/send-email\/preview$/.test(path) && method === 'POST') {
      state.previewRequests += 1
      const payload = request.postDataJSON() as PreviewRequest
      state.previewPayloads.push(payload)
      const selected = (attachments.get(payload.noteId) || []).filter((item) => payload.attachmentIds.includes(String(item.attachmentId)))
      return fulfillJson(route, {
        recipient: payload.to, from: 'sender@example.test', replyTo: 'candidate@example.test',
        subject: baseDraft.email_subject, text: baseDraft.email_body, htmlPreview: `<p>${baseDraft.email_body}</p>`,
        draftId: payload.draftId, draftVersion: payload.version,
        quality: {
          ...application(payload.noteId, '岗位 A1').draftVersion,
          checkedAt: '2026-08-01T08:01:30.000Z',
          evaluation: { score: 95, passed: true, attempts: 1, threshold: 90, strengths: [], problems: [], rubric: {} },
        },
        attachmentSummary: { count: selected.length, totalBytes: selected.reduce((sum, item) => sum + Number(item.size || 0), 0), attachments: selected.map((item) => ({ attachmentId: item.attachmentId, filename: item.displayName, mediaType: item.mediaType, size: item.size, sha256: item.sha256 })) },
        attachmentBundleHash: 'b'.repeat(64), previewRevision: 'preview-revision-1', warnings: [], readiness: 'ready', estimatedMessageSize: 2048,
      })
    }
    if (/^\/api\/jobs\/[^/]+\/send-email$/.test(path) && method === 'POST') {
      state.sendRequests += 1
      const payload = request.postDataJSON() as SendRequest
      state.sendPayloads.push(payload)
      if (payload.previewRevision !== 'preview-revision-1'
        || payload.idempotencyKey !== payload.previewRevision
        || payload.attachmentBundleHash !== 'b'.repeat(64)) {
        return fulfillJson(route, { error: 'preview contract missing' }, 409)
      }
      return fulfillJson(route, {
        noteId: payload.noteId, outreach: payload.outreach,
        draftVersion: application(payload.noteId, '岗位 A1').draftVersion,
        delivery: { action: 'email_sent', email: { sentAt: '2026-08-01T08:03:00.000Z' }, sendAudit: [] },
      })
    }
    if (/^\/api\/jobs\/[^/]+\/artifacts$/.test(path)) return fulfillJson(route, state.jobArtifacts)
    if (/^\/api\/jobs\/[^/]+\/resume$/.test(path) && method === 'POST') {
      state.resumeRequests += 1
      return fulfillJson(route, { ...jobs[1], status: 'resuming' })
    }
    if (/^\/api\/jobs\/[^/]+\/complete-missing$/.test(path) && method === 'POST') {
      return fulfillJson(route, { action: 'started', sourceJobId: 'job-a', incompleteBefore: 1, job: { ...jobs[0], status: 'resuming' }, message: 'started' })
    }
    if (/^\/api\/jobs\/[^/]+\/draft\/rewrite$/.test(path) && method === 'POST') {
      state.rewriteRequests += 1
      const payload = request.postDataJSON() as CoverLetterRewriteRequest
      state.rewritePayloads.push(payload)
      const outreach = { ...payload.outreach, cover_letter: state.rewriteCoverLetter }
      const contentHash = draftContentHash(outreach)
      savedDrafts.set(payload.noteId, { contentHash, version: payload.baseVersion + 1 })
      return fulfillJson(route, {
        noteId: payload.noteId,
        outreach,
        draftVersion: {
          draftId: payload.draftId,
          version: payload.baseVersion + 1,
          contentHash,
          qualityStatus: 'stale',
          qualityCheckedVersion: null,
          qualityCheckedHash: null,
          createdAt: '2026-08-01T08:00:00.000Z',
          updatedAt: '2026-08-01T08:01:30.000Z',
        },
        delivery: null,
        generation: {
          provider: payload.aiSessionId === 'session-local' ? 'local_qwen' : 'codex',
          model: payload.aiSessionId === 'session-local' ? 'qwen3.5:4b' : 'test-model',
          wireApi: payload.aiSessionId === 'session-local' ? 'chat_completions' : 'responses',
          strategy: payload.aiSessionId === 'session-local' ? 'local_plan_write_review' : 'direct_model_rewrite',
          modelCalls: payload.aiSessionId === 'session-local' ? 3 : 1,
          reviewScore: payload.aiSessionId === 'session-local' ? 94 : null,
          requestId: 'rewrite-request-1',
          generatedAt: '2026-08-01T08:01:30.000Z',
        },
      })
    }
    if (/^\/api\/jobs\/[^/]+\/draft\/quality$/.test(path) && method === 'POST') {
      if (state.qualityFails) return fulfillJson(route, { error: 'mock quality check failed' }, 500)
      const payload = request.postDataJSON() as QualityRequest
      state.qualityPayloads.push(payload)
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
      const payload = request.postDataJSON() as DraftRequest
      state.draftPayloads.push(payload)
      const contentHash = draftContentHash(payload.outreach)
      const nextVersion = JSON.stringify(payload.outreach) === JSON.stringify(baseDraft)
        ? payload.baseVersion
        : payload.baseVersion + 1
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

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: '查看岗位：岗位 A1' })).toBeVisible()
  await expect(page.getByLabel('私信文案')).toHaveValue(baseDraft.greeting)
  return state
}

async function dirtyGreeting(page: Page, suffix = ' 本地修改') {
  await page.getByLabel('私信文案').fill(`${baseDraft.greeting}${suffix}`)
  await expect(page.getByRole('button', { name: '保存修改' })).toBeEnabled()
}

test('脏稿在常用切换前默认保存并继续，正常流程不弹窗', async ({ page }) => {
  const state = await mockApi(page)
  await dirtyGreeting(page, ' 自动保存')
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(state.draftRequests).toBe(1)
  expect(state.draftPayloads[0].outreach.greeting).toContain('自动保存')
})

test('Cover Letter 自定义要求和高级模型会话进入重写 API 并回写新版本', async ({ page }) => {
  const state = await mockApi(page)
  await expect.poll(() => state.aiSessionRequests).toBe(1)
  await page.getByRole('button', { name: 'AI 重写求职信' }).click()
  await page.getByLabel('Cover Letter 重写要求').fill('突出 SQL 项目，并逐项回应岗位职责，语气自然。')
  await page.getByRole('button', { name: '立即重写' }).click()

  await expect(page.getByRole('textbox', { name: 'Cover Letter', exact: true })).toHaveValue(rewrittenCoverLetter)
  await expect(page.getByText(/已由 codex \/ test-model 完成专属重写/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重新质量检查' })).toBeVisible()
  expect(state.rewriteRequests).toBe(1)
  expect(state.rewritePayloads).toEqual([{
    noteId: 'job-a-note-1',
    aiSessionId: 'session-1',
    instructions: '突出 SQL 项目，并逐项回应岗位职责，语气自然。',
    outreach: baseDraft,
    applicationContext: {
      channel: 'email',
      contactStage: 'first_contact',
      tone: 'natural',
      resumeAttached: false,
      coverLetterAttached: false,
      recipientType: 'recruiter',
    },
    draftId: 'draft-job-a-note-1',
    baseVersion: 1,
  }])
})

test('Cover Letter 本地模式创建本地会话并将真实模型送入重写 API', async ({ page }) => {
  const state = await mockApi(page, { localModelReady: true })
  await expect.poll(() => state.aiSessionRequests).toBe(1)
  await page.getByRole('button', { name: 'AI 重写求职信' }).click()
  await page.getByRole('button', { name: '本地模型', exact: true }).click()
  await expect(page.getByLabel('Cover Letter 本地模型')).toHaveValue('qwen3.5:4b')
  await page.getByLabel('Cover Letter 重写要求').fill('优先突出用户反馈与数据复盘。')
  await page.getByRole('button', { name: '立即重写' }).click()

  await expect(page.getByRole('textbox', { name: 'Cover Letter', exact: true })).toHaveValue(rewrittenCoverLetter)
  await expect(page.getByText(/local_qwen \/ qwen3.5:4b 完成专属重写/)).toBeVisible()
  await expect(page.getByText(/本地模型完成 3 次规划\/写作\/终审，终审 94 分/)).toBeVisible()
  expect(state.aiSessionRequests).toBe(2)
  expect(state.rewritePayloads[0].aiSessionId).toBe('session-local')
  expect(state.rewritePayloads[0].instructions).toBe('优先突出用户反馈与数据复盘。')
})

test('Cover Letter 重写拒绝不足 800 个非空白字符的异常响应并保留当前稿', async ({ page }) => {
  const state = await mockApi(page, { rewriteCoverLetter: '过短的异常模型响应。' })
  await page.getByRole('button', { name: 'AI 重写求职信' }).click()
  await page.getByRole('button', { name: '立即重写' }).click()

  await expect(page.getByRole('textbox', { name: 'Cover Letter', exact: true })).toHaveValue(baseDraft.cover_letter)
  const rewriteForm = page.getByRole('form', { name: 'Cover Letter AI 重写' })
  await expect(rewriteForm.getByRole('alert')).toContainText('未达到 800 字最低要求')
  await expect(rewriteForm).toBeVisible()
  expect(state.rewriteRequests).toBe(1)
})

test('连续切换时自动保存只执行一次并继续第一次操作', async ({ page }) => {
  const state = await mockApi(page, { saveDelayMs: 1_500 })
  const changed = `${baseDraft.greeting} 快速自动保存`
  await page.getByLabel('私信文案').fill(changed)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
  await page.getByRole('row', { name: /任务乙/ }).click({ force: true })
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  expect(state.draftRequests).toBe(1)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('保存失败不离开、不丢文本', async ({ page }) => {
  const state = await mockApi(page, { saveFails: true })
  const changed = `${baseDraft.greeting} 保存失败仍保留`
  await page.getByLabel('私信文案').fill(changed)
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()

  await expect(page.locator('.draft-guard-error')).toContainText('保存失败')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByLabel('私信文案')).toHaveValue(changed)
  await expect(page.getByRole('heading', { name: '岗位 A1' })).toBeVisible()
  expect(state.draftRequests).toBe(1)
  state.saveFails = false
  await page.getByRole('button', { name: '保存并继续' }).click()
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  expect(state.draftRequests).toBe(2)
})

test('保存完成前再次切换不会抢占正在处理的目标', async ({ page }) => {
  const state = await mockApi(page, { saveDelayMs: 1_500 })
  await dirtyGreeting(page, ' 保存中切换')
  await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
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
  await expect(page.getByRole('button', { name: '重新质量检查' })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
  const saved = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(saved).toBe(false)
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

test('从当前候选人档案选择简历并管理发送选择', async ({ page }) => {
  const state = await mockApi(page)
  const workspace = page.getByRole('region', { name: '投递附件' })
  const profileSource = page.getByLabel('选择候选人资料附件')

  await expect(profileSource).toHaveValue('resume.pdf')
  await page.getByRole('button', { name: '加入简历' }).click()

  const row = workspace.locator('.attachment-list li').filter({ hasText: 'resume.pdf' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('候选人资料')
  await expect(page.getByText('1 / 5 个')).toBeVisible()
  await expect(page.getByRole('link', { name: '预览 resume.pdf' })).toHaveAttribute('href', /application-attachments\/attachment-profile-1\/content$/)
  await expect(page.getByRole('link', { name: '下载 resume.pdf' })).toHaveAttribute('download', 'resume.pdf')
  expect(state.profileAttachmentRequests).toEqual([{
    noteId: 'job-a-note-1',
    profileId: 'profile-a',
    sourceFile: 'resume.pdf',
    selected: true,
    draftId: 'draft-job-a-note-1',
    draftVersion: 1,
  }])

  const selected = row.locator('input[type="checkbox"]')
  await expect(selected).toBeChecked()
  await selected.click()
  await expect(selected).not.toBeChecked()
  await expect(page.getByText('0 / 5 个')).toBeVisible()
  await selected.click()
  await expect(selected).toBeChecked()
  await expect(page.getByText('1 / 5 个')).toBeVisible()
  expect(state.attachmentSelectionUpdates).toEqual([
    { attachmentId: 'attachment-profile-1', selected: false },
    { attachmentId: 'attachment-profile-1', selected: true },
  ])

  await page.getByRole('button', { name: '删除 resume.pdf' }).click()
  await expect(page.getByText('尚未添加附件；附件集合变化后需要重新执行质量检查。')).toBeVisible()
  expect(state.attachmentDeletes).toEqual(['attachment-profile-1'])
})

test('任务产物通过专用引用加入附件并保留来源与草稿版本', async ({ page }) => {
  const state = await mockApi(page, {
    jobArtifacts: [{ id: 'artifact-report-1', name: '岗位分析报告.pdf', size: 12_345, type: 'application/pdf' }],
  })

  await page.getByLabel('选择任务产物').selectOption('artifact-report-1')
  await page.getByRole('button', { name: '加入', exact: true }).click()
  await expect(page.getByText('任务产物已加入附件：岗位分析报告.pdf')).toBeVisible()
  const row = page.getByRole('region', { name: '投递附件' }).locator('.attachment-list li').filter({ hasText: '岗位分析报告.pdf' })
  await expect(row).toContainText('任务产物')

  expect(state.artifactAttachmentRequests).toEqual([{
    noteId: 'job-a-note-1',
    artifactId: 'artifact-report-1',
    displayName: '岗位分析报告.pdf',
    selected: true,
    draftId: 'draft-job-a-note-1',
    draftVersion: 1,
    contentHash: draftContentHash(baseDraft),
  }])
  expect(state.attachmentUploadRequests).toHaveLength(0)
  expect(state.attachmentUploads).toBe(0)
  await expect(page.getByRole('button', { name: '导出 Cover Letter' })).toBeDisabled()
})

test('上传替换附件后必须核对完整预览和质量结果再发送，移动端无横向溢出', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await mockApi(page, { emailConfigured: true, attachmentUploadDelayMs: 700 })

  await page.locator('.attachment-file-input').setInputFiles({
    name: '中文简历.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nfixture resume\n%%EOF\n', 'utf8'),
  })

  await expect(page.getByText('正在校验并保存')).toBeVisible()
  await expect(page.getByLabel('邮件正文')).toHaveValue(baseDraft.email_body)
  await expect(page.getByRole('heading', { name: '岗位 A1' })).toBeVisible()
  await expect(page.getByText('中文简历.pdf')).toBeVisible()
  await expect(page.getByText('1 / 5 个')).toBeVisible()
  await expect(page.getByLabel('邮件正文')).toHaveValue(baseDraft.email_body)
  await expect(page.getByRole('heading', { name: '岗位 A1' })).toBeVisible()
  await expect(page.getByRole('link', { name: '预览 中文简历.pdf' })).toHaveAttribute('href', /application-attachments\/attachment-pdf-1\/content$/)
  await expect(page.getByRole('link', { name: '下载 中文简历.pdf' })).toHaveAttribute('download', '中文简历.pdf')
  expect(state.attachmentUploadRequests[0]).toEqual({
    contentType: expect.stringMatching(/^multipart\/form-data; boundary=/),
    filename: '中文简历.pdf',
    fileText: '%PDF-1.7\nfixture resume\n%%EOF\n',
    noteId: 'job-a-note-1',
    source: 'uploaded',
    selected: 'true',
    draftId: 'draft-job-a-note-1',
    draftVersion: '1',
  })

  await page.getByRole('button', { name: '替换 中文简历.pdf' }).click()
  await page.locator('.attachment-file-input').setInputFiles({
    name: '新版中文简历.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nreplacement resume\n%%EOF\n', 'utf8'),
  })
  await expect(page.getByText('正在校验并保存')).toBeVisible()
  await expect(page.getByLabel('邮件正文')).toHaveValue(baseDraft.email_body)
  await expect(page.getByText('新版中文简历.pdf')).toBeVisible()
  await expect(page.getByText('中文简历.pdf', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '预览 新版中文简历.pdf' })).toHaveAttribute('href', /application-attachments\/attachment-pdf-2\/content$/)
  await expect(page.getByLabel('邮件正文')).toHaveValue(baseDraft.email_body)
  expect(state.attachmentUploadRequests[1]).toMatchObject({
    filename: '新版中文简历.pdf',
    noteId: 'job-a-note-1',
    source: 'uploaded',
    selected: 'true',
    draftId: 'draft-job-a-note-1',
    draftVersion: '1',
  })
  expect(state.attachmentDeletes).toContain('attachment-pdf-1')

  const qualityButton = page.getByRole('button', { name: /质量检查/ })
  await expect(qualityButton).toBeVisible()
  await expect(page.getByRole('button', { name: '预览并发送' })).toBeDisabled()
  await qualityButton.click()
  await expect(page.getByRole('button', { name: '已保存' })).toBeVisible()
  expect(state.qualityPayloads).toEqual([{
    noteId: 'job-a-note-1',
    draftId: 'draft-job-a-note-1',
    version: 1,
    attachmentIds: ['attachment-pdf-2'],
    aiSessionId: 'session-1',
    applicationContext: {
      channel: 'email',
      contactStage: 'first_contact',
      tone: 'natural',
      resumeAttached: true,
      coverLetterAttached: false,
      recipientType: 'recruiter',
    },
  }])

  await page.getByRole('button', { name: '预览并发送' }).click()
  const preview = page.getByRole('dialog', { name: '邮件发送预览' })
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('recruiter@example.test')
  await expect(preview).toContainText('sender@example.test')
  await expect(preview).toContainText(baseDraft.email_subject)
  await expect(preview).toContainText(baseDraft.email_body)
  await expect(preview).toContainText('新版中文简历.pdf')
  await expect(preview).toContainText('最近一次质量检查')
  await expect(preview).toContainText('已通过 · 95 / 100 · 草稿 v1')
  expect(state.sendRequests).toBe(0)
  expect(state.previewPayloads).toEqual([{
    noteId: 'job-a-note-1',
    to: 'recruiter@example.test',
    attachmentIds: ['attachment-pdf-2'],
    evidenceHash: 'a'.repeat(64),
    sourceRevision: 'route-revision-1',
    draftId: 'draft-job-a-note-1',
    version: 1,
  }])

  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.email-preview-dialog')
    const content = document.querySelector<HTMLElement>('.email-preview-content')
    return {
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      dialog: Boolean(dialog && dialog.scrollWidth <= dialog.clientWidth + 1),
      content: Boolean(content && content.scrollWidth <= content.clientWidth + 1),
    }
  })
  expect(overflow).toEqual({ document: true, dialog: true, content: true })

  await page.getByRole('button', { name: '确认发送' }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByText('邮件已发送至 recruiter@example.test')).toBeVisible()
  expect(state.sendPayloads).toEqual([{
    noteId: 'job-a-note-1',
    to: 'recruiter@example.test',
    outreach: baseDraft,
    attachmentIds: ['attachment-pdf-2'],
    evidenceHash: 'a'.repeat(64),
    sourceRevision: 'route-revision-1',
    previewRevision: 'preview-revision-1',
    attachmentBundleHash: 'b'.repeat(64),
    idempotencyKey: 'preview-revision-1',
    draftId: 'draft-job-a-note-1',
    version: 1,
  }])
  await page.getByRole('button', { name: '删除 新版中文简历.pdf' }).click()
  await expect(page.getByText('尚未添加附件；附件集合变化后需要重新执行质量检查。')).toBeVisible()
  await expect(page.getByLabel('邮件正文')).toHaveValue(baseDraft.email_body)
  expect(state.previewRequests).toBe(1)
  expect(state.sendRequests).toBe(1)
  expect(state.attachmentUploads).toBe(2)
})

test('投递语气和既有路线组成明确上下文并随保存复检请求提交', async ({ page }) => {
  const state = await mockApi(page)
  const context = page.getByLabel('投递上下文')
  const tone = page.getByLabel('投递语气')

  await expect(tone).toHaveValue('natural')
  await expect(context).toContainText('邮件')
  await expect(context).toContainText('首次联系 · 招聘方 · 未附简历 · 未附 Cover Letter')

  await tone.selectOption('formal')
  const qualityButton = page.locator('.draft-toolbar button')
  await expect(qualityButton).toHaveText('重新质量检查')
  await expect(qualityButton).toBeEnabled()
  await qualityButton.click()
  await expect(page.getByRole('button', { name: '已保存' })).toBeVisible()

  const expectedContext = {
    channel: 'email',
    contactStage: 'first_contact',
    tone: 'formal',
    resumeAttached: false,
    coverLetterAttached: false,
    recipientType: 'recruiter',
  }
  expect(state.draftPayloads).toHaveLength(1)
  expect(state.draftPayloads[0].applicationContext).toEqual(expectedContext)
  expect(state.qualityPayloads).toHaveLength(1)
  expect(state.qualityPayloads[0].applicationContext).toEqual(expectedContext)
})

test('Cover Letter 脏稿禁止导出，保存后按对应版本和内容生成附件', async ({ page }) => {
  const state = await mockApi(page)
  const changed = `${baseDraft.cover_letter} 这是保存后的定稿。`
  const exportButton = page.getByRole('button', { name: '导出 Cover Letter' })

  await page.getByLabel('Cover Letter').fill(changed)
  await expect(exportButton).toBeDisabled()
  await page.waitForTimeout(100)
  expect(state.attachmentUploads).toBe(0)
  expect(state.coverLetterAttachmentRequests).toHaveLength(0)

  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByRole('button', { name: '已保存' })).toBeVisible()
  await expect(exportButton).toBeEnabled()
  await exportButton.click()
  await expect(page.getByText('Cover Letter 已导出并加入附件')).toBeVisible()

  expect(state.coverLetterAttachmentRequests).toEqual([{
    noteId: 'job-a-note-1',
    selected: true,
    draftId: 'draft-job-a-note-1',
    draftVersion: 2,
    contentHash: draftContentHash({ ...baseDraft, cover_letter: changed }),
  }])
  expect(state.attachmentUploadRequests).toHaveLength(0)
  expect(state.attachmentUploads).toBe(0)
  await expect(exportButton).toBeDisabled()
})

test('服务端 unknown 投递状态按原值语义展示', async ({ page }) => {
  await mockApi(page, {
    resultDelivery: {
      action: 'email_unknown',
      updatedAt: '2026-08-01T08:03:00.000Z',
      email: { status: 'unknown', to: 'recruiter@example.test' },
    },
  })
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible()
})

for (const viewport of [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
]) {
  test(`脏稿自动保存在不同视口不弹确认框 ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await mockApi(page)
    await dirtyGreeting(page, ` ${viewport.name}`)
    await page.getByRole('button', { name: '查看岗位：岗位 A2' }).click()
    await expect(page.getByRole('heading', { name: '岗位 A2' })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  })
}
