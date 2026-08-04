import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-08-04T08:00:00.000Z'
const jobId = 'job-batch-workbench'
const bodyNoteId = 'note-body-email'
const commentNoteId = 'note-author-comment'
const partialNoteId = 'note-partial-comments'
const normalizedImageNoteId = 'note-remote-page'
const commentEvidenceHash = 'e'.repeat(64)
const normalizedImageEvidence = '简历投递：📮1️⃣3️⃣9️⃣6️⃣3️⃣3️⃣4️⃣5️⃣0️⃣6️⃣＠扣扣点com'

const job = {
  id: jobId,
  keyword: 'AI 产品岗位',
  status: 'completed',
  createdAt: now,
  startedAt: now,
  updatedAt: now,
  finishedAt: now,
  progress: 100,
  progressPhase: 'done',
  progressLabel: '任务完成',
  progressCurrent: 3,
  progressTotal: 3,
  applicationCount: 3,
  artifactCount: 0,
  artifacts: [],
  resumeAvailable: false,
  revision: 1,
  config: {
    analysisMode: 'job',
    limit: 0,
    maxScrolls: 30,
    searchSort: 'latest',
    maxAgeDays: 14,
  },
  coverage: {
    discovered: 3,
    bodyAttempted: 3,
    bodySucceeded: 3,
    applicationInfo: 3,
    draftsGenerated: 3,
    qualityPassed: 0,
  },
}

function application(noteId: string, title: string, roleName: string, email = '') {
  const contacts = email ? [{
    type: 'email',
    channel: 'email',
    value: email,
    evidence: `请发送到 ${email}`,
    source_field: 'body',
    verification_status: 'body_verified',
    confidence: 100,
    actionable: true,
  }] : []
  const attachmentRequirement = noteId === bodyNoteId ? {
    detected: true,
    template: '姓名-学校-岗位-简历.pdf',
    evidence: '附件文件名格式：姓名-学校-岗位-简历.pdf',
    fields: ['candidateName', 'school', 'jobTitle'],
  } : {
    detected: false,
    template: '',
    evidence: '',
    fields: [],
  }
  return {
    note_id: noteId,
    title,
    note_url: `https://example.test/${noteId}`,
    body: noteId === bodyNoteId
      ? `${title} 的完整岗位正文。附件文件名格式：姓名-学校-岗位-简历.pdf`
      : `${title} 的完整岗位正文`,
    access_status: 'ok',
    collected_at: now,
    publish_time: { raw: '2026-08-04', value: '2026-08-04', precision: 'day', is_estimated: false },
    job_card: {
      title,
      role_name: roleName,
      source_url: `https://example.test/${noteId}`,
      source_status: 'ok',
      parse_basis: 'full_body',
      source_excerpt: `${title} 的岗位事实`,
      responsibility_count: 1,
      requirement_count: 1,
      route_count: contacts.length,
      status: 'complete',
    },
    application_info: {
      contacts,
      application_routes: [],
      responsibilities: [{ text: '负责产品方案与数据分析', source_field: 'body', evidence: '负责产品方案与数据分析' }],
      requirements: [{ text: '请按岗位要求命名简历', source_field: 'body', evidence: '请按岗位要求命名简历' }],
    },
    outreach: {
      greeting: '您好，我对这个岗位很感兴趣。',
      email_subject: `${roleName}申请-张三`,
      email_body: `您好，这是针对${roleName}岗位准备的求职邮件。`,
      cover_letter: `这是针对${roleName}岗位准备的求职文案。`,
      generation_mode: 'model',
      runtime_status: 'generated',
      status: 'ready',
    },
    cover_letter_evaluation: {
      score: 96,
      passed: true,
      attempts: 1,
      threshold: 90,
      strengths: ['岗位事实完整'],
      problems: [],
      rubric: { grounded: 96 },
    },
    draftVersion: {
      draftId: `draft-${noteId}`,
      version: 1,
      contentHash: 'b'.repeat(64),
      qualityStatus: 'passed',
      qualityCheckedVersion: 1,
      qualityCheckedHash: 'b'.repeat(64),
      createdAt: now,
      updatedAt: now,
    },
    delivery: null,
    attachmentRequirement,
    quality: { body_complete: true },
  }
}

const applications = [
  application(bodyNoteId, '智能产品经理招聘', '产品经理', 'jobs@example.test'),
  application(commentNoteId, '增长团队招聘', '增长策略实习生'),
  application(partialNoteId, '商业分析团队招聘', '数据分析实习生'),
]
const remoteApplication = application(normalizedImageNoteId, '远端分页岗位', '商业化产品经理', '1396334506@qq.com')
remoteApplication.application_info.contacts[0] = {
  ...remoteApplication.application_info.contacts[0],
  value: '1396334506@qq.com',
  evidence: normalizedImageEvidence,
  source_field: 'image_ocr',
  source_fields: ['image'],
  source_image_index: 1,
  source_image_url: 'https://example.test/image-email.webp',
  verification_status: 'image_format_normalized',
  normalization_applied: true,
  confidence: 93,
}
Object.assign(remoteApplication, {
  media: {
    cover_url: '',
    images: [{ url: 'https://example.test/image-email.webp', original_url: 'https://example.test/image-email-original.webp', alt: normalizedImageEvidence, source: 'detail' }],
    analysis: { status: 'analyzed', source: 'vision_model', summary: '岗位图片包含 emoji 混排邮箱。', visible_text: normalizedImageEvidence, application_requested_in_image: true },
  },
})

const results = {
  available: true,
  analysisMode: 'job',
  keyword: job.keyword,
  research: null,
  presentation: null,
  insights: null,
  total: applications.length,
  offset: 0,
  limit: 20,
  items: applications,
  filters: {
    sort: 'newest',
    timeRange: 'all',
    stats: { all: 3, dated: 3, unknown: 0, incomplete: 0, withImages: 0 },
  },
  codexRuntime: { status: 'completed' },
  qualityGate: { passed: true },
  sourceCoverage: null,
}

const bodyContact = contact({
  address: 'jobs@example.test',
  source: 'body',
  noteId: bodyNoteId,
  evidenceHash: 'b'.repeat(64),
  evidenceText: '正文：请发送到 jobs@example.test',
  confidence: 1,
})

const normalizedImageContact = contact({
  address: '1396334506@qq.com',
  source: 'image',
  noteId: normalizedImageNoteId,
  evidenceHash: '9'.repeat(64),
  evidenceText: normalizedImageEvidence,
  confidence: 93,
  verificationStatus: 'image_format_normalized',
  normalizationApplied: true,
  sourceFields: ['image', 'image_ocr'],
})

const commentContact = contact({
  address: 'author@example.test',
  source: 'author_comment',
  noteId: commentNoteId,
  commentId: 'comment-author-1',
  authorId: 'author-1',
  evidenceHash: commentEvidenceHash,
  evidenceText: '帖主回复：简历请投递 author@example.test',
  confidence: 0.92,
  requiresReview: true,
})

const analystContact = contact({
  address: 'analyst@example.test',
  source: 'body',
  noteId: partialNoteId,
  evidenceHash: 'f'.repeat(64),
  evidenceText: '正文：请发送到 analyst@example.test',
  confidence: 1,
})

const productSentContact = contact({
  address: 'product@example.test',
  source: 'body',
  noteId: bodyNoteId,
  evidenceHash: '1'.repeat(64),
  evidenceText: '正文：请发送到 product@example.test',
  confidence: 1,
})

const growthSentContact = contact({
  address: 'growth@example.test',
  source: 'body',
  noteId: commentNoteId,
  evidenceHash: '2'.repeat(64),
  evidenceText: '正文：请发送到 growth@example.test',
  confidence: 1,
})

function contact(overrides: Record<string, unknown>) {
  return {
    address: '',
    source: 'body',
    noteId: '',
    postId: String(overrides.noteId || ''),
    commentId: '',
    authorId: '',
    evidenceText: '',
    evidenceHash: '',
    confidence: 1,
    collectionStatus: 'complete',
    verificationStatus: 'verified',
    actionable: true,
    requiresReview: false,
    ownershipStatus: 'post_author',
    ...overrides,
  }
}

function resolution(noteId: string, options: {
  status: 'ready' | 'manual_review' | 'pending'
  reason: string
  candidate?: typeof bodyContact
  collectionStatus?: 'partial' | 'complete'
}) {
  const candidates = options.candidate ? [options.candidate] : []
  return {
    schemaVersion: 1,
    noteId,
    postId: noteId,
    status: options.status,
    reason: options.reason,
    source: options.candidate?.source || 'comments',
    collectionStatus: options.collectionStatus || 'complete',
    commentFallbackUsed: noteId !== bodyNoteId,
    requiresReview: options.status === 'manual_review',
    selectedCandidate: options.status === 'ready' ? options.candidate || null : null,
    candidates,
    issues: [],
  }
}

function attachment(noteId: string, roleName: string) {
  return {
    attachmentId: `attachment-${noteId}`,
    originalName: '个人简历.pdf',
    currentDisplayName: '个人简历.pdf',
    finalDisplayName: `${roleName}-张三-北京大学-简历.pdf`,
    sha256: 'a'.repeat(64),
    size: 48_000,
    mediaType: 'application/pdf',
  }
}

function preview(noteId: string, recipient: string, roleName: string) {
  return {
    readiness: 'ready',
    warnings: [],
    recipient,
    from: 'candidate@example.test',
    replyTo: 'candidate@example.test',
    subject: `${roleName}申请-张三`,
    text: `您好，这是针对${roleName}岗位准备的求职邮件。`,
    draftId: `draft-${noteId}`,
    draftVersion: 1,
    attachmentSummary: { attachments: [] },
    attachmentBundleHash: `bundle-${noteId}`,
    previewRevision: `preview-${noteId}`,
    smtpConfigurationRevision: 4,
    smtpConfigurationFingerprint: 'smtp-fingerprint-e2e',
    estimatedMessageSize: 52_000,
  }
}

function payload(noteId: string, title: string, roleName: string, candidate: typeof bodyContact) {
  const finalAttachment = attachment(noteId, roleName)
  return {
    title,
    roleName,
    recipient: candidate.address,
    contact: candidate,
    subject: `${roleName}申请-张三`,
    body: `您好，这是针对${roleName}岗位准备的求职邮件。`,
    bodyHash: 'c'.repeat(64),
    draftId: `draft-${noteId}`,
    draftVersion: 1,
    contentHash: 'b'.repeat(64),
    qualityReportRef: null,
    attachmentBundleHash: `bundle-${noteId}`,
    attachments: [{
      attachmentId: finalAttachment.attachmentId,
      filename: finalAttachment.finalDisplayName,
      mediaType: finalAttachment.mediaType,
      size: finalAttachment.size,
      sha256: finalAttachment.sha256,
    }],
    finalFilenames: [finalAttachment.finalDisplayName],
    previewRevision: `preview-${noteId}`,
    smtpConfigurationRevision: 4,
    smtpConfigurationFingerprint: 'smtp-fingerprint-e2e',
    sendRequest: { noteId, to: candidate.address },
  }
}

function preflight(noteIds: string[], approvedComment: boolean) {
  const items = noteIds.map((noteId) => {
    const record = [...applications, remoteApplication].find((item) => item.note_id === noteId)!
    const roleName = record.job_card.role_name
    if (noteId === normalizedImageNoteId) {
      return {
        noteId,
        title: record.title,
        roleName,
        status: 'ready',
        canPrepare: true,
        blockers: [],
        contact: normalizedImageContact,
        contactResolution: resolution(noteId, { status: 'ready', reason: 'normalized_image_contact', candidate: normalizedImageContact }),
        attachments: [attachment(noteId, roleName)],
        preview: preview(noteId, normalizedImageContact.address, roleName),
        payload: payload(noteId, record.title, roleName, normalizedImageContact),
      }
    }
    if (noteId === bodyNoteId) {
      return {
        noteId,
        title: record.title,
        roleName,
        status: 'ready',
        canPrepare: true,
        blockers: [],
        contact: bodyContact,
        contactResolution: resolution(noteId, { status: 'ready', reason: 'structured_contact', candidate: bodyContact }),
        attachments: [attachment(noteId, roleName)],
        preview: preview(noteId, bodyContact.address, roleName),
        payload: payload(noteId, record.title, roleName, bodyContact),
      }
    }
    if (noteId === commentNoteId && approvedComment) {
      return {
        noteId,
        title: record.title,
        roleName,
        status: 'ready',
        canPrepare: true,
        blockers: [],
        contact: { ...commentContact, requiresReview: false },
        contactResolution: resolution(noteId, { status: 'ready', reason: 'confirmed_author_comment', candidate: commentContact }),
        attachments: [attachment(noteId, roleName)],
        preview: preview(noteId, commentContact.address, roleName),
        payload: payload(noteId, record.title, roleName, commentContact),
      }
    }
    if (noteId === commentNoteId) {
      return {
        noteId,
        title: record.title,
        roleName,
        status: 'blocked_ambiguous',
        canPrepare: false,
        blockers: [{ code: 'APPLICATION_EMAIL_REVIEW_REQUIRED', message: '帖主评论邮箱需人工核验后方可投递' }],
        contact: null,
        contactResolution: resolution(noteId, { status: 'manual_review', reason: 'author_comment_requires_review', candidate: commentContact }),
        attachments: [],
        preview: null,
      }
    }
    return {
      noteId,
      title: record.title,
      roleName,
      status: 'blocked_ambiguous',
      canPrepare: false,
      blockers: [{ code: 'APPLICATION_COMMENTS_INCOMPLETE', message: '评论采集未完成，暂不判断无邮箱' }],
      contact: null,
      contactResolution: resolution(noteId, { status: 'pending', reason: 'comment_collection_incomplete', collectionStatus: 'partial' }),
      attachments: [],
      preview: null,
    }
  })
  const readyNoteIds = items.filter((item) => item.status === 'ready').map((item) => item.noteId)
  return {
    schemaVersion: 1,
    dryRun: true,
    batchId: 'dry-run-e2e',
    generatedAt: now,
    maxBatchSize: 10,
    items,
    counts: {
      ready: readyNoteIds.length,
      blocked_ambiguous: items.length - readyNoteIds.length,
    },
    readyNoteIds,
    preparableNoteIds: [],
  }
}

function countRecord(ready: number) {
  return {
    resolving: 0,
    blocked_no_email: 0,
    blocked_ambiguous: 0,
    draft_pending: 0,
    quality_pending: 0,
    filename_pending: 0,
    ready,
    sending: 0,
    sent: 0,
    failed_retryable: 0,
    unknown_manual_review: 0,
    skipped: 0,
  }
}

function frozenBatch(status: 'ready' | 'approved') {
  const selected = applications.filter((item) => [bodyNoteId, commentNoteId].includes(item.note_id))
  return {
    schemaVersion: 1,
    batchId: 'batch-e2e-001',
    jobId,
    title: 'AI 产品岗位批量投递',
    metadata: {},
    settings: { concurrency: 1, minIntervalMs: 1_000, maxBatchSize: 10, stagedLimit: 10 },
    status,
    revision: status === 'approved' ? 2 : 1,
    approvalRevision: status === 'approved' ? 1 : 0,
    approval: status === 'approved' ? {
      revision: 1,
      batchRevision: 1,
      snapshotHash: 'd'.repeat(64),
      approvedAt: now,
      actor: 'e2e-user',
      reason: 'approved',
    } : null,
    itemIds: selected.map((item) => item.note_id),
    counts: countRecord(2),
    items: selected.map((item) => {
      const candidate = item.note_id === bodyNoteId ? bodyContact : commentContact
      return {
        schemaVersion: 1,
        batchId: 'batch-e2e-001',
        itemId: item.note_id,
        noteId: item.note_id,
        contactCandidateId: candidate.evidenceHash,
        status: 'ready',
        payload: payload(item.note_id, item.title, item.job_card.role_name, candidate),
        error: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        recoveredAt: null,
      }
    }),
    createdAt: now,
    updatedAt: now,
    lastEventSequence: status === 'approved' ? 2 : 1,
    recoveryCount: 0,
  }
}

function sentThreeEmailBatch() {
  const records = [
    {
      noteId: bodyNoteId,
      roleName: 'Product Manager',
      recipient: productSentContact.address,
      candidate: productSentContact,
      body: '您好，我是 Test Candidate，申请 Product Manager 岗位。我有产品规划、用户研究和跨团队交付经验，能够围绕业务目标拆解需求并跟进结果。希望有机会进一步沟通岗位重点，感谢您的时间。',
    },
    {
      noteId: commentNoteId,
      roleName: 'Growth Strategist',
      recipient: growthSentContact.address,
      candidate: growthSentContact,
      body: '您好，我是 Test Candidate，申请 Growth Strategist 岗位。我有增长实验、渠道分析和数据复盘经验，能够根据转化结果持续调整策略并推动落地。希望有机会进一步沟通团队目标，感谢您的时间。',
    },
    {
      noteId: partialNoteId,
      roleName: 'Data Analyst',
      recipient: analystContact.address,
      candidate: analystContact,
      body: '您好，我是 Test Candidate，申请 Data Analyst 岗位。我有指标体系、数据清洗和业务分析经验，能够把分析结论转化为清晰建议并跟进验证。希望有机会进一步沟通分析场景，感谢您的时间。',
    },
  ]
  const items = records.map((record) => {
    const source = applications.find((item) => item.note_id === record.noteId)!
    const candidate = record.candidate
    const basePayload = payload(record.noteId, source.title, record.roleName, candidate)
    const filename = `${record.roleName}-Test Candidate-resume.pdf`
    return {
      schemaVersion: 1,
      batchId: 'batch-e2e-sent-three',
      itemId: record.noteId,
      noteId: record.noteId,
      contactCandidateId: candidate.evidenceHash,
      status: 'sent' as const,
      payload: {
        ...basePayload,
        roleName: record.roleName,
        recipient: record.recipient,
        subject: `Application for ${record.roleName}`,
        body: record.body,
        finalFilenames: [filename],
        attachments: basePayload.attachments.map((item) => ({ ...item, filename })),
      },
      error: null,
      revision: 3,
      createdAt: now,
      updatedAt: now,
      recoveredAt: null,
    }
  })
  return {
    schemaVersion: 1,
    batchId: 'batch-e2e-sent-three',
    jobId,
    title: 'Three role application delivery',
    metadata: {},
    settings: { concurrency: 1, minIntervalMs: 1_000, maxBatchSize: 10, stagedLimit: 10 },
    status: 'completed' as const,
    revision: 11,
    approvalRevision: 1,
    approval: {
      revision: 1,
      batchRevision: 2,
      snapshotHash: 'd'.repeat(64),
      approvedAt: now,
      actor: 'e2e-user',
      reason: 'approved',
    },
    itemIds: records.map((record) => record.noteId),
    counts: { ...countRecord(0), sent: 3 },
    items,
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 11,
    recoveryCount: 0,
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installQuietEventSource(page: Page) {
  await page.addInitScript(() => {
    class QuietEventSource {
      onerror: null | (() => void) = null
      addEventListener() {}
      close() {}
    }
    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: QuietEventSource,
    })
  })
}

type ApiCapture = {
  dryRuns: Array<Record<string, unknown>>
  creates: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  controls: Array<{ action: 'start' | 'pause' | 'resume' | 'cancel'; body: Record<string, unknown> }>
  resultQueries: string[]
}

function controlledBatch(status: 'running' | 'paused' | 'cancelled', revision: number) {
  const base = frozenBatch('approved')
  const cancelled = status === 'cancelled'
  return {
    ...base,
    status,
    revision,
    counts: { ...countRecord(cancelled ? 0 : 2), skipped: cancelled ? 2 : 0 },
    items: base.items.map((item) => ({
      ...item,
      status: cancelled ? 'skipped' : 'ready',
      revision: cancelled ? item.revision + 1 : item.revision,
    })),
    lastEventSequence: revision,
  }
}

async function openWorkbench(page: Page, initialBatch: ReturnType<typeof sentThreeEmailBatch> | null = null): Promise<ApiCapture> {
  const capture: ApiCapture = { dryRuns: [], creates: [], approvals: [], controls: [], resultQueries: [] }
  let currentBatch: ReturnType<typeof frozenBatch> | ReturnType<typeof controlledBatch> | ReturnType<typeof sentThreeEmailBatch> = initialBatch || frozenBatch('ready')

  await installQuietEventSource(page)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()

    if (path === '/api/health') return fulfillJson(route, { ok: true, runnerAvailable: true, emailDelivery: { configured: true, from: 'candidate@example.test', authMode: 'login' } })
    if (path === '/api/jobs' && method === 'GET') return fulfillJson(route, [job])
    if (path === '/api/relay/config') return fulfillJson(route, { port: 18800, profile: 'openclaw', autoConnect: true })
    if (path === '/api/relay/status') return fulfillJson(route, { running: true, cdpReady: true, ready: true, authenticated: true, tabs: 1, xiaohongshuTabs: 1, port: 18800 })
    if (path === '/api/email/config') return fulfillJson(route, { provider: 'custom', host: 'smtp.example.test', port: 465, secure: true, requireTls: false, auth: 'login', authMode: 'login', user: 'candidate@example.test', from: 'candidate@example.test', hasPassword: true, configured: true, verified: true, oauth: {} })
    if (path === '/api/ai/providers') return fulfillJson(route, [{ id: 'codex', label: 'Codex', baseUrl: 'http://127.0.0.1', model: 'test-model', models: ['test-model'], requiresKey: false, configured: true, hasApiKey: true, wireApi: 'responses' }])
    if (path === '/api/ai/local-models') return fulfillJson(route, { runtime: { ready: false }, catalog: [], installedModels: [], install: null })
    if (path === '/api/ai/sessions' && method === 'POST') return fulfillJson(route, { id: 'session-e2e', provider: 'codex', model: 'test-model', baseUrl: 'http://127.0.0.1', wireApi: 'responses', configured: true, expiresAt: '2026-08-05T08:00:00.000Z' })
    if (path === '/api/profiles') return fulfillJson(route, [])
    if (path === `/api/jobs/${jobId}/results`) {
      const query = new URL(request.url()).searchParams.get('query')?.toLocaleLowerCase() || ''
      capture.resultQueries.push(query)
      if (query === '1396334506@qq.com' || query.includes('📮')) {
        return fulfillJson(route, { ...results, total: 1, items: [remoteApplication] })
      }
      if (query) {
        const matching = applications.filter((item) => JSON.stringify(item).toLocaleLowerCase().includes(query))
        return fulfillJson(route, { ...results, total: matching.length, items: matching })
      }
      return fulfillJson(route, results)
    }
    if (path === `/api/jobs/${jobId}/artifacts`) return fulfillJson(route, [])
    if (path === `/api/jobs/${jobId}/application-attachments` && method === 'GET') return fulfillJson(route, {
      schemaVersion: 1,
      revision: 1,
      noteId: new URL(request.url()).searchParams.get('noteId') || '',
      attachments: [],
      selectedSummary: { count: 0, totalBytes: 0 },
      limits: { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 },
    })
    if (path === `/api/jobs/${jobId}`) return fulfillJson(route, job)

    const batchCollection = `/api/jobs/${jobId}/application-batches`
    if (path === `${batchCollection}/dry-run` && method === 'POST') {
      const requestBody = request.postDataJSON() as Record<string, unknown>
      capture.dryRuns.push(requestBody)
      const approvals = Array.isArray(requestBody.contactApprovals) ? requestBody.contactApprovals : []
      const approvedComment = approvals.some((approval) => (
        approval && typeof approval === 'object'
        && (approval as Record<string, unknown>).noteId === commentNoteId
        && (approval as Record<string, unknown>).evidenceHash === commentEvidenceHash
        && (approval as Record<string, unknown>).confirmed === true
      ))
      return fulfillJson(route, preflight(requestBody.noteIds as string[], approvedComment))
    }
    if (path === batchCollection && method === 'GET') return fulfillJson(route, { batches: initialBatch ? [currentBatch] : [] })
    if (path === batchCollection && method === 'POST') {
      const requestBody = request.postDataJSON() as Record<string, unknown>
      capture.creates.push(requestBody)
      currentBatch = frozenBatch('ready')
      return fulfillJson(route, {
        schemaVersion: 1,
        batch: currentBatch,
        preflight: preflight(requestBody.noteIds as string[], true),
      }, 201)
    }
    if (path === `${batchCollection}/batch-e2e-001/approve` && method === 'POST') {
      capture.approvals.push(request.postDataJSON() as Record<string, unknown>)
      currentBatch = frozenBatch('approved')
      return fulfillJson(route, currentBatch)
    }
    const controlMatch = path.match(/\/batch-e2e-001\/(start|pause|resume|cancel)$/u)
    if (controlMatch && method === 'POST') {
      const action = controlMatch[1] as 'start' | 'pause' | 'resume' | 'cancel'
      capture.controls.push({ action, body: request.postDataJSON() as Record<string, unknown> })
      const nextStatus = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running'
      currentBatch = controlledBatch(nextStatus, currentBatch.revision + 1)
      return fulfillJson(route, currentBatch, 202)
    }
    if (path === `${batchCollection}/batch-e2e-001` && method === 'GET') return fulfillJson(route, currentBatch)

    return fulfillJson(route, {})
  })

  await page.clock.setFixedTime(new Date(now))
  await page.goto('/batch', { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/\/batch$/u)
  await expect(page).toHaveTitle('今天你投了吗？｜批量投递工作台')
  await expect(page.getByRole('region', { name: '批量投递工作台' })).toBeVisible()
  await page.addStyleTag({ content: '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }' })
  return capture
}

async function exerciseWorkbench(page: Page) {
  const capture = await openWorkbench(page)
  const panel = page.getByRole('region', { name: '批量投递工作台' })
  await expect(panel.locator('.batch-application-body')).toBeVisible()
  const bodyRow = panel.locator('tbody tr').filter({ hasText: '产品经理' })
  const commentRow = panel.locator('tbody tr').filter({ hasText: '增长策略实习生' })
  const partialRow = panel.locator('tbody tr').filter({ hasText: '数据分析实习生' })

  await expect(bodyRow.getByRole('checkbox')).toBeChecked()
  await commentRow.getByRole('checkbox').check({ force: true })
  await partialRow.getByRole('checkbox').check({ force: true })
  await panel.getByRole('button', { name: 'Dry Run' }).click()

  await expect(bodyRow.getByText('正文', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('个人简历.pdf', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('产品经理-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()
  await expect(commentRow.getByText('帖主评论邮箱需人工核验后方可投递')).toBeVisible()
  await expect(commentRow.getByRole('button', { name: /author@example\.test/ })).toBeVisible()
  await expect(partialRow.getByText('评论采集未完成', { exact: true })).toBeVisible()
  await expect(partialRow.getByText('评论采集未完成，暂不判断无邮箱')).toBeVisible()
  await expect(partialRow.getByText('无可用邮箱')).toHaveCount(0)

  await commentRow.getByRole('button', { name: /author@example\.test/ }).click()
  await expect(commentRow.getByText('帖主评论', { exact: true })).toBeVisible()
  await expect(commentRow.getByText('增长策略实习生-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()

  expect(capture.dryRuns).toHaveLength(2)
  expect(capture.dryRuns[0]).toMatchObject({ noteIds: [bodyNoteId, commentNoteId, partialNoteId] })
  expect(capture.dryRuns[1]).toMatchObject({
    noteIds: [bodyNoteId, commentNoteId, partialNoteId],
    contactApprovals: [{ noteId: commentNoteId, evidenceHash: commentEvidenceHash, confirmed: true }],
  })

  await panel.getByRole('button', { name: '冻结批次预览' }).click()
  const frozen = panel.getByRole('region', { name: '冻结批次预览' })
  const frozenItems = frozen.locator('.frozen-item-list')
  await expect(frozen).toBeVisible()
  await expect(frozenItems.getByText('jobs@example.test', { exact: true })).toBeVisible()
  await expect(frozenItems.getByText('author@example.test', { exact: true })).toBeVisible()
  await expect(frozenItems.getByText('产品经理-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()

  const emailPreview = frozen.getByTestId('batch-email-preview')
  const emailCards = emailPreview.locator('.batch-email-preview-card')
  await expect(emailPreview).toBeVisible()
  await expect(emailCards).toHaveCount(2)
  await expect(emailCards.nth(0)).toContainText('jobs@example.test')
  await expect(emailCards.nth(0).locator('.batch-email-preview-body')).toHaveText(/.+/u)
  await expect(emailCards.nth(1)).toContainText('author@example.test')

  await frozen.getByRole('button', { name: '审批' }).click()
  await expect(panel.getByText('已审批', { exact: true })).toHaveText('已审批')
  await expect(frozen.getByRole('button', { name: '开始' })).toBeEnabled()
  expect(capture.creates).toHaveLength(1)
  expect(capture.creates[0]).toMatchObject({ noteIds: [bodyNoteId, commentNoteId] })
  expect(capture.approvals).toEqual([{ expectedRevision: 1 }])

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  return { panel, capture }
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1_000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`批量投递工作台在 ${viewport.name} 完成证据确认、冻结与审批`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const { panel } = await exerciseWorkbench(page)
    await expect(panel).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.style.scrollBehavior = 'auto'
      window.scrollTo(0, 0)
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.screenshot({ path: `output/playwright/batch-application/workbench-${viewport.name}.png` })
  })
}

test('standalone batch workbench searches source email before Dry Run', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page)
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  await expect(page).toHaveURL(/\/batch$/u)
  await expect(panel.getByTitle('展开批量投递工作台')).toHaveCount(0)
  await expect(panel.locator('.batch-application-body')).toBeVisible()
  await expect(page.locator('.results-workspace .result-row')).toHaveCount(0)
  await expect(page.getByText('选择、预检、审批、发送', { exact: true })).toBeVisible()

  const search = panel.getByPlaceholder('搜索岗位、邮箱、主题或附件名')
  await expect(panel.getByText('文章附件格式', { exact: true })).toBeVisible()
  await expect(panel.getByText('姓名-学校-岗位-简历.pdf', { exact: true })).toBeVisible()
  await expect(panel.getByText('选择简历后按此格式生成发送名', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '清空' }).click()
  await expect(panel.locator('.batch-email')).toHaveCount(1)
  await search.fill('@')
  await expect(panel.locator('.batch-search-summary')).toContainText('待投岗位 1 项')
  await expect(panel.locator('.batch-email')).toHaveText('jobs@example.test')
  await expect(panel.locator('.batch-search-empty-row')).toHaveCount(0)

  await search.fill('1396334506@qq.com')
  await expect(panel.locator('.batch-search-summary')).toContainText('待投岗位 1 项')
  await expect(panel.locator('.batch-email')).toHaveText('1396334506@qq.com')
  await expect(panel.getByText('商业化产品经理', { exact: true })).toBeVisible()
  await expect(panel.getByText('图片 OCR · 已自动还原', { exact: true })).toBeVisible()
  await expect(panel.locator('.batch-contact-evidence').filter({ hasText: normalizedImageEvidence })).toBeVisible()
  await expect(panel.getByRole('button', { name: '查看图片证据' })).toBeVisible()
  await panel.locator('tbody input[type="checkbox"]').check()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 1 / 10')
  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect(panel.getByText('图片 OCR · 已自动还原', { exact: true })).toBeVisible()
  await expect(panel.locator('.batch-contact-evidence').filter({ hasText: normalizedImageEvidence })).toBeVisible()
  expect(capture.resultQueries).toContain('1396334506@qq.com')
  expect(capture.dryRuns).toHaveLength(1)

  await panel.getByRole('button', { name: '查看图片证据' }).click()
  await expect(page).toHaveURL(/\/$/u)
  const routeSection = page.locator('.result-detail .route-section')
  await expect(routeSection).toContainText('1396334506@qq.com')
  await expect(routeSection).toContainText('图中识别 · 已自动还原')
  await expect(routeSection).toContainText(normalizedImageEvidence)
  await expect(routeSection.getByRole('button', { name: '查看图 1' })).toBeVisible()
})

test('job body and batch delivery use separate interfaces', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  await openWorkbench(page)
  const batchPanel = page.getByRole('region', { name: '批量投递工作台' })
  const bodyRow = batchPanel.locator('tbody tr').filter({ hasText: '产品经理' })

  await expect(bodyRow.getByText(/正文已保存 · \d+ 字/u)).toBeVisible()
  await bodyRow.getByRole('button', { name: '查看正文' }).click()

  await expect(page).toHaveURL(/\/$/u)
  await expect(page).toHaveTitle('今天你投了吗？｜岗位与投递')
  await expect(page.getByRole('alertdialog', { name: '当前文案尚未保存' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '批量投递工作台' })).toHaveCount(0)
  const fullBody = page.locator('.result-detail .full-body-section .body-text-block')
  await expect(fullBody).toHaveText('智能产品经理招聘 的完整岗位正文。附件文件名格式：姓名-学校-岗位-简历.pdf')
  await expect(page.locator('.result-detail .full-body-section')).toContainText('采集正文')
  await expect(page.locator('.result-detail .full-body-section')).toContainText('已保存')
  expect(await fullBody.evaluate((element) => getComputedStyle(element).maxHeight)).toBe('none')
  await fullBody.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/batch-application/job-body-desktop.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(fullBody).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await fullBody.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/batch-application/job-body-mobile.png' })

  await page.getByRole('navigation', { name: '切换工作台' }).getByRole('button', { name: '批量投递' }).click()
  await expect(page).toHaveURL(/\/batch$/u)
  await expect(page).toHaveTitle('今天你投了吗？｜批量投递工作台')
  await expect(page.locator('.results-workspace')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '批量投递工作台' })).toBeVisible()
})

test('product workbench shows three sent emails with their exact content and filenames', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  await openWorkbench(page, sentThreeEmailBatch())
  const panel = page.getByRole('region', { name: '批量投递工作台' })
  const emailPreview = panel.getByTestId('batch-email-preview')
  const emailCards = emailPreview.locator('.batch-email-preview-card')
  const expected = [
    { role: 'Product Manager', recipient: 'product@example.test' },
    { role: 'Growth Strategist', recipient: 'growth@example.test' },
    { role: 'Data Analyst', recipient: 'analyst@example.test' },
  ]

  await expect(panel.locator('.batch-status-badge')).toHaveClass(/completed/u)
  await expect(emailCards).toHaveCount(3)
  for (const [index, item] of expected.entries()) {
    const card = emailCards.nth(index)
    await expect(card).toContainText(item.recipient)
    await expect(card).toContainText(`Application for ${item.role}`)
    await expect(card.locator('.batch-email-preview-body')).toContainText(item.role)
    await expect(card.getByText(`${item.role}-Test Candidate-resume.pdf`, { exact: true })).toBeVisible()
  }

  const search = panel.getByPlaceholder('搜索岗位、邮箱、主题或附件名')
  await search.fill('@')
  await expect(panel.locator('.batch-search-summary')).toContainText('当前批次 3 封')
  await expect(panel.locator('.frozen-item-list .frozen-item')).toHaveCount(3)
  await expect(emailCards).toHaveCount(3)

  await search.fill('growth@example.test')
  await expect(panel.locator('.batch-search-summary')).toContainText('当前批次 1 封')
  await expect(panel.locator('.frozen-item-list .frozen-item')).toHaveCount(1)
  await expect(emailCards).toHaveCount(1)
  await expect(emailCards.first()).toContainText('Growth Strategist')

  await search.fill('missing@example.test')
  await expect(panel.getByTestId('batch-search-empty')).toBeVisible()
  await expect(emailCards).toHaveCount(0)

  await search.fill('')
  await expect(emailCards).toHaveCount(3)
  await panel.screenshot({ path: 'output/playwright/batch-application/sent-three-emails-product.png' })
})

test('batch workbench controls start, pause, resume, and cancel with current revisions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const { panel, capture } = await exerciseWorkbench(page)
  const controls = panel.locator('.batch-control-actions').locator('button')
  const status = panel.locator('.batch-status-badge')

  await controls.nth(1).click()
  await expect(status).toHaveClass(/running/u)
  await controls.nth(2).click()
  await expect(status).toHaveClass(/paused/u)
  await controls.nth(3).click()
  await expect(status).toHaveClass(/running/u)
  await controls.nth(4).click()
  await expect(status).toHaveClass(/cancelled/u)

  expect(capture.controls).toEqual([
    { action: 'start', body: { expectedRevision: 2 } },
    { action: 'pause', body: { expectedRevision: 3 } },
    { action: 'resume', body: { expectedRevision: 4 } },
    { action: 'cancel', body: { expectedRevision: 5 } },
  ])
})
