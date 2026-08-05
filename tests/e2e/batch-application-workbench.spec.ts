import { expect, test, type Page, type Route } from '@playwright/test'
import { withResolvedApplicationSubject } from '../../server/application-delivery-candidates.mjs'

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

const paginatedApplications = Array.from({ length: 25 }, (_, index) => application(
  `note-page-${String(index + 1).padStart(2, '0')}`,
  `分页岗位 ${index + 1}`,
  `岗位 ${index + 1}`,
  `page-${index + 1}@example.test`,
))
paginatedApplications[24].attachmentRequirement = {
  detected: true,
  template: '跨页命名-姓名-岗位.pdf',
  evidence: '附件请按跨页命名-姓名-岗位.pdf提交',
  fields: ['candidateName', 'jobTitle'],
}

const attachmentSubjectNoteId = 'note-attachment-subject-fallback'
const attachmentSubject = '北京大学-张三-2026年8月15日'
const rawAttachmentSubjectApplication = application(
  attachmentSubjectNoteId,
  '用户研究实习生招聘',
  '用户研究实习生',
  'research@example.test',
)
Object.assign(rawAttachmentSubjectApplication, {
  body: '简历命名：学校-姓名-到岗时间.pdf\n投递邮箱 research@example.test',
  outreach: {
    ...rawAttachmentSubjectApplication.outreach,
    email_subject: '',
  },
  candidate_profile: {
    name: '张三',
    school: '北京大学',
    arrivalDate: '2026年8月15日',
  },
  attachmentRequirement: {
    detected: true,
    template: '学校-姓名-到岗时间.pdf',
    evidence: '简历命名：学校-姓名-到岗时间.pdf',
    fields: ['school', 'candidateName', 'arrivalDate'],
  },
})
const attachmentSubjectApplication = withResolvedApplicationSubject(rawAttachmentSubjectApplication) as ReturnType<typeof application> & {
  emailSubjectPreview: string
  emailSubjectGuard: Record<string, unknown>
  emailSubjectRequirement: Record<string, unknown>
}

const results = {
  available: true,
  analysisMode: 'job',
  keyword: job.keyword,
  research: null,
  presentation: null,
  insights: null,
  total: applications.length,
  offset: 0,
  limit: 50,
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
  const plannedDisplayName = `${roleName}-张三-北京大学-简历.pdf`
  return {
    attachmentId: `attachment-${noteId}`,
    originalName: '个人简历.pdf',
    currentDisplayName: '个人简历.pdf',
    finalDisplayName: plannedDisplayName,
    plannedDisplayName,
    namingStatus: 'planned',
    requirementSource: noteId === bodyNoteId ? 'post' : 'batch_default',
    willRename: true,
    sha256: 'a'.repeat(64),
    size: 48_000,
    mediaType: 'application/pdf',
  }
}

function preview(noteId: string, recipient: string, roleName: string, subject = `${roleName}申请-张三`) {
  return {
    readiness: 'ready',
    warnings: [],
    recipient,
    from: 'candidate@example.test',
    replyTo: 'candidate@example.test',
    subject,
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

function payload(
  noteId: string,
  title: string,
  roleName: string,
  candidate: typeof bodyContact,
  subject = `${roleName}申请-张三`,
  subjectRule: Record<string, unknown> = { source: 'generated', template: '{jobTitle}申请-{candidateName}' },
) {
  const finalAttachment = attachment(noteId, roleName)
  const coverLetter = `这是针对${roleName}岗位准备的求职文案。预演定稿关键词。`
  return {
    title,
    roleName,
    recipient: candidate.address,
    contact: candidate,
    subject,
    body: `您好，这是针对${roleName}岗位准备的求职邮件。`,
    coverLetter,
    coverLetterHash: '4'.repeat(64),
    coverLetterVersion: 1,
    recipientEvidenceHash: candidate.evidenceHash,
    recipientSourceRevision: 1,
    subjectRule,
    attachmentRules: [{ source: noteId === bodyNoteId ? 'post' : 'batch_default', template: finalAttachment.finalDisplayName }],
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
    plannedFinalFilenames: [finalAttachment.finalDisplayName],
    previewRevision: `preview-${noteId}`,
    smtpConfigurationRevision: 4,
    smtpConfigurationFingerprint: 'smtp-fingerprint-e2e',
    sendRequest: { noteId, to: candidate.address },
  }
}

function preflight(noteIds: string[], approvedComment: boolean) {
  const items = noteIds.map((noteId) => {
    const record = [...applications, ...paginatedApplications, remoteApplication, attachmentSubjectApplication].find((item) => item.note_id === noteId)!
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
    const recordContact = record.application_info.contacts.find((candidate) => candidate.type === 'email' && candidate.value)
    if (recordContact) {
      const resolvedSubject = record.emailSubjectPreview?.trim() || record.outreach.email_subject?.trim() || `${roleName}申请-张三`
      const resolvedSubjectRule = record.emailSubjectRequirement?.detected
        ? { ...record.emailSubjectRequirement }
        : { source: 'generated', template: '{jobTitle}申请-{candidateName}' }
      const candidate = contact({
        address: recordContact.value,
        source: 'body',
        noteId,
        evidenceHash: `page-${noteId}`,
        evidenceText: recordContact.evidence,
        confidence: 1,
      })
      return {
        noteId,
        title: record.title,
        roleName,
        status: 'ready',
        canPrepare: true,
        blockers: [],
        contact: candidate,
        contactResolution: resolution(noteId, { status: 'ready', reason: 'structured_contact', candidate }),
        attachments: [attachment(noteId, roleName)],
        preview: preview(noteId, candidate.address, roleName, resolvedSubject),
        payload: payload(noteId, record.title, roleName, candidate, resolvedSubject, resolvedSubjectRule),
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
    schemaVersion: 2,
    dryRun: true,
    batchId: 'dry-run-e2e',
    planId: 'plan-e2e-001',
    preflightId: 'plan-e2e-001',
    manifestHash: '8'.repeat(64),
    deliveryManifest: { schemaVersion: 2, itemCount: items.length },
    generatedAt: now,
    maxBatchSize: 100,
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
    settings: { concurrency: 1, minIntervalMs: 1_000, maxBatchSize: 100, stagedLimit: 100 },
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
      const frozenPayload = payload(item.note_id, item.title, item.job_card.role_name, candidate)
      return {
        schemaVersion: 1,
        batchId: 'batch-e2e-001',
        itemId: item.note_id,
        noteId: item.note_id,
        contactCandidateId: candidate.evidenceHash,
        status: 'ready',
        payload: {
          ...frozenPayload,
          subject: item.note_id === bodyNoteId ? '冻结快照中的实际发送标题' : frozenPayload.subject,
        },
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
    settings: { concurrency: 1, minIntervalMs: 1_000, maxBatchSize: 100, stagedLimit: 100 },
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
  preflights: Array<ReturnType<typeof preflight>>
  creates: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  controls: Array<{ action: 'start' | 'pause' | 'resume' | 'cancel'; body: Record<string, unknown> }>
  resultQueries: string[]
  candidateRequests: string[]
  rewrites: Array<Record<string, unknown>>
}

type WorkbenchFixtureOptions = {
  staleCandidateCursorOnce?: boolean
  rewriteFailureNoteIds?: string[]
}

function deliveryManifestSummary(record: ReturnType<typeof application>, activeBatch: ReturnType<typeof frozenBatch> | ReturnType<typeof controlledBatch> | ReturnType<typeof sentThreeEmailBatch> | null) {
  const batchItem = activeBatch?.items.find((item) => item.noteId === record.note_id)
  const contacts = [...(record.application_info.contacts || []), ...(record.application_info.application_routes || [])]
  const emailMatch = JSON.stringify(contacts).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  const recipientStatus = emailMatch ? 'resolved' : 'missing'
  const copyStatus = !record.outreach.email_body ? 'missing_email_body'
    : !record.outreach.cover_letter ? 'missing_cover_letter'
      : record.draftVersion.qualityStatus === 'failed' ? 'quality_failed' : 'passed'
  const subjectRuleStatus = !record.outreach.email_subject ? 'needs_input'
    : record.emailSubjectRequirement?.detected ? 'job_requirement_satisfied' : 'batch_default'
  const attachmentStatus = record.attachmentRequirement?.detected ? 'planned_rename' : 'unchanged'
  const deliveryStatus = batchItem?.status === 'sent' ? 'sent'
    : batchItem?.status === 'skipped' ? 'skipped'
      : batchItem?.status === 'unknown_manual_review' ? 'unknown'
        : batchItem?.status === 'failed_retryable' ? 'failed'
          : batchItem && activeBatch?.status === 'running' ? 'sending'
            : batchItem && ['ready', 'approved', 'paused'].includes(activeBatch?.status || '') ? 'frozen'
              : recipientStatus === 'resolved' && copyStatus === 'passed' && subjectRuleStatus !== 'needs_input' ? 'ready_to_preview' : 'unprepared'
  const blockers = [
    ...(recipientStatus === 'missing' ? [{ code: 'NO_RECIPIENT', field: 'recipient', message: '未找到可用收件邮箱' }] : []),
    ...(copyStatus === 'missing_email_body' ? [{ code: 'EMAIL_BODY_REQUIRED', field: 'content.emailBody', message: '缺少邮件正文' }] : []),
    ...(copyStatus === 'missing_cover_letter' ? [{ code: 'COVER_LETTER_REQUIRED', field: 'content.coverLetter', message: '缺少 Cover Letter' }] : []),
  ]
  const readiness = ['sent', 'skipped'].includes(deliveryStatus) ? 'completed' : blockers.length ? 'needs_input' : 'ready_to_preview'
  return {
    schemaVersion: 2,
    noteId: record.note_id,
    sourceRevision: `revision-${record.note_id}`,
    deliveryStatus,
    recipientStatus,
    recipientSource: emailMatch ? 'body' : 'none',
    copyStatus,
    subjectRuleStatus,
    attachmentStatus,
    readiness,
    hasEmailBody: Boolean(record.outreach.email_body),
    hasCoverLetter: Boolean(record.outreach.cover_letter),
    recipient: emailMatch ? { address: emailMatch[0].toLowerCase(), normalizedAddress: emailMatch[0].toLowerCase(), source: 'body', evidenceHash: '', verificationStatus: 'verified' } : null,
    latestBatch: batchItem && activeBatch ? { batchId: activeBatch.batchId, batchStatus: activeBatch.status, itemId: batchItem.itemId, itemStatus: batchItem.status, updatedAt: activeBatch.updatedAt } : null,
    blockers,
    warnings: attachmentStatus === 'planned_rename' ? [{ code: 'WILL_RENAME', field: 'attachments', message: '冻结时将生成发送文件名' }] : [],
  }
}

function deliveryCandidatesResponse(
  requestUrl: string,
  sourceRecords: ReturnType<typeof application>[],
  activeBatch: ReturnType<typeof frozenBatch> | ReturnType<typeof controlledBatch> | ReturnType<typeof sentThreeEmailBatch> | null,
) {
  const params = new URL(requestUrl).searchParams
  const q = (params.get('q') || '').toLocaleLowerCase()
  const sources = q && (q.includes('1396334506@qq.com') || q.includes('📮'))
    ? [...sourceRecords, remoteApplication].filter((item, index, all) => all.findIndex((candidate) => candidate.note_id === item.note_id) === index)
    : sourceRecords
  const classified = sources.map((record) => ({ ...record, deliveryManifestSummary: deliveryManifestSummary(record, activeBatch) }))
  const searched = q ? classified.filter((record) => JSON.stringify(record).toLocaleLowerCase().includes(q)) : classified
  const facetFields = ['deliveryStatus', 'recipientStatus', 'recipientSource', 'copyStatus', 'subjectRuleStatus', 'attachmentStatus', 'readiness'] as const
  const values = (key: string) => (params.get(key) || '').split(',').filter(Boolean)
  const filtered = searched.filter((record) => facetFields.every((field) => {
    const expected = values(field)
    return expected.length === 0 || expected.includes(record.deliveryManifestSummary[field])
  })).filter((record) => {
    const raw = params.get('hasCoverLetter')
    return raw === null || record.deliveryManifestSummary.hasCoverLetter === (raw === 'true')
  })
  const facetCounts = Object.fromEntries(facetFields.map((field) => [field, searched.reduce<Record<string, number>>((counts, record) => {
    const value = String(record.deliveryManifestSummary[field])
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})]))
  const offset = Number(params.get('cursor') || 0)
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') || 50)))
  const pageItems = filtered.slice(offset, offset + limit)
  const revisions = filtered.map((record) => ({
    noteId: record.note_id,
    revision: record.deliveryManifestSummary.sourceRevision,
  }))
  const snapshotHash = activeBatch
    ? `snapshot-${filtered.map((record) => record.note_id).join('-') || 'empty'}-batch-${activeBatch.revision}-${activeBatch.status}`
    : `snapshot-${filtered.map((record) => record.note_id).join('-') || 'empty'}`
  return {
    schemaVersion: 2,
    available: true,
    jobId,
    total: filtered.length,
    offset,
    limit,
    cursor: params.get('cursor'),
    nextCursor: offset + pageItems.length < filtered.length ? String(offset + pageItems.length) : null,
    items: pageItems,
    filters: Object.fromEntries(params.entries()),
    facetCounts,
    blockerCounts: {},
    selectionSnapshot: {
      schemaVersion: 1,
      selectionSnapshotId: `selection-${snapshotHash}`,
      selectionSnapshotHash: snapshotHash,
      queryHash: `query-${snapshotHash}`,
      candidateCount: filtered.length,
      noteIds: filtered.map((record) => record.note_id),
      selectableNoteIds: filtered.filter((record) => !['completed'].includes(record.deliveryManifestSummary.readiness)
        && !['sent', 'skipped', 'sending', 'frozen'].includes(record.deliveryManifestSummary.deliveryStatus)).map((record) => record.note_id),
      readyNoteIds: filtered.filter((record) => record.deliveryManifestSummary.readiness === 'ready_to_preview'
        && !['sent', 'skipped', 'sending', 'frozen'].includes(record.deliveryManifestSummary.deliveryStatus)).map((record) => record.note_id),
      revisions,
    },
  }
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

async function openWorkbench(
  page: Page,
  initialBatch: ReturnType<typeof frozenBatch> | ReturnType<typeof controlledBatch> | ReturnType<typeof sentThreeEmailBatch> | null = null,
  sourceRecords = applications,
  options: WorkbenchFixtureOptions = {},
): Promise<ApiCapture> {
  const capture: ApiCapture = { dryRuns: [], preflights: [], creates: [], approvals: [], controls: [], resultQueries: [], candidateRequests: [], rewrites: [] }
  const activeSourceRecords = sourceRecords.map((record) => ({
    ...record,
    outreach: { ...record.outreach },
    draftVersion: { ...record.draftVersion },
  }))
  let currentBatch: ReturnType<typeof frozenBatch> | ReturnType<typeof controlledBatch> | ReturnType<typeof sentThreeEmailBatch> = initialBatch || frozenBatch('ready')
  let hasCurrentBatch = Boolean(initialBatch)
  let staleCandidateCursorRemaining = options.staleCandidateCursorOnce === true

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
    if (path === `/api/jobs/${jobId}/application-delivery-candidates`) {
      capture.candidateRequests.push(request.url())
      const requestUrl = new URL(request.url())
      const q = requestUrl.searchParams.get('q')?.toLocaleLowerCase() || ''
      capture.resultQueries.push(q)
      if (staleCandidateCursorRemaining && requestUrl.searchParams.has('cursor')) {
        staleCandidateCursorRemaining = false
        return fulfillJson(route, {
          code: 'APPLICATION_CANDIDATE_CURSOR_STALE',
          message: '候选分页游标已失效。',
        }, 409)
      }
      try {
        return fulfillJson(route, deliveryCandidatesResponse(request.url(), activeSourceRecords, hasCurrentBatch ? currentBatch : null))
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        console.error('application delivery candidates fixture failed', error)
        return fulfillJson(route, { message }, 500)
      }
    }
    if (path === `/api/jobs/${jobId}/results`) {
      const params = new URL(request.url()).searchParams
      const query = params.get('query')?.toLocaleLowerCase() || ''
      const offset = Number(params.get('offset') || 0)
      const limit = Number(params.get('limit') || 50)
      capture.resultQueries.push(query)
      if (query === '1396334506@qq.com' || query.includes('📮')) {
        return fulfillJson(route, { ...results, total: 1, items: [remoteApplication] })
      }
      if (query) {
        const matching = activeSourceRecords.filter((item) => JSON.stringify(item).toLocaleLowerCase().includes(query))
        return fulfillJson(route, { ...results, total: matching.length, offset, limit, items: matching.slice(offset, offset + limit) })
      }
      return fulfillJson(route, { ...results, total: activeSourceRecords.length, offset, limit, items: activeSourceRecords.slice(offset, offset + limit) })
    }
    if (path === `/api/jobs/${jobId}/artifacts`) return fulfillJson(route, [])
    if (path === `/api/jobs/${jobId}/draft/rewrite` && method === 'POST') {
      const requestBody = request.postDataJSON() as Record<string, unknown>
      capture.rewrites.push(requestBody)
      const noteId = String(requestBody.noteId || '')
      if (options.rewriteFailureNoteIds?.includes(noteId)) {
        return fulfillJson(route, { code: 'AI_REWRITE_FAILED', message: 'fixture rewrite failed' }, 502)
      }
      const target = activeSourceRecords.find((record) => record.note_id === noteId)
      if (!target) return fulfillJson(route, { code: 'APPLICATION_NOT_FOUND', message: 'fixture application not found' }, 404)
      const requestOutreach = requestBody.outreach && typeof requestBody.outreach === 'object'
        ? requestBody.outreach as Record<string, unknown>
        : {}
      const version = Number(requestBody.baseVersion || target.draftVersion.version) + 1
      const outreach = {
        ...target.outreach,
        ...requestOutreach,
        email_subject: `${target.job_card.role_name}申请-批量润色`,
        cover_letter: `这是批量润色后的${target.job_card.role_name}专属 Cover Letter，包含岗位职责与候选人证据。`,
      }
      const draftVersion = {
        ...target.draftVersion,
        version,
        contentHash: `${noteId}-${version}`,
        qualityStatus: 'pending',
        qualityCheckedVersion: null,
        qualityCheckedHash: null,
        updatedAt: now,
      }
      Object.assign(target, { outreach, draftVersion, emailSubjectPreview: outreach.email_subject })
      return fulfillJson(route, {
        noteId,
        outreach,
        draftVersion,
        delivery: null,
        cover_letter_evaluation: target.cover_letter_evaluation,
        generation: {
          provider: 'codex',
          model: 'test-model',
          wireApi: 'responses',
          strategy: 'direct_model_rewrite',
          generatedAt: now,
        },
      })
    }
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
      const response = preflight(requestBody.noteIds as string[], approvedComment)
      capture.preflights.push(response)
      return fulfillJson(route, response)
    }
    if (path === batchCollection && method === 'GET') return fulfillJson(route, { batches: hasCurrentBatch ? [currentBatch] : [] })
    if (path === batchCollection && method === 'POST') {
      const requestBody = request.postDataJSON() as Record<string, unknown>
      capture.creates.push(requestBody)
      currentBatch = frozenBatch('ready')
      hasCurrentBatch = true
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
  const freezeButton = panel.getByRole('button', { name: '冻结批次预览' })
  await expect(freezeButton).toBeEnabled()

  await expect(panel.locator('thead th').filter({ hasText: '投递正文' })).toHaveCount(1)
  await expect(panel.locator('thead th').filter({ hasText: '岗位事实' })).toHaveCount(1)
  await expect(bodyRow.getByText('岗位职责', { exact: true })).toBeVisible()
  await expect(bodyRow.getByTestId(`batch-responsibilities-${bodyNoteId}`)).toContainText('负责产品方案与数据分析')
  await expect(bodyRow.getByText('岗位要求', { exact: true })).toBeVisible()
  await expect(bodyRow.getByTestId(`batch-requirements-${bodyNoteId}`)).toContainText('请按岗位要求命名简历')
  await expect(bodyRow.getByTestId(`batch-original-body-${bodyNoteId}`)).toContainText('完整岗位正文')
  await expect(bodyRow.getByTestId(`batch-email-body-${bodyNoteId}`)).toContainText('这是针对产品经理岗位准备的求职邮件')
  await expect(bodyRow.getByTestId(`batch-cover-letter-${bodyNoteId}`)).toContainText('这是针对产品经理岗位准备的求职文案')
  await expect(bodyRow.getByTestId(`batch-cover-letter-${bodyNoteId}`)).toContainText('预演定稿关键词')
  await expect(bodyRow).toContainText('v1')
  await expect(bodyRow).toContainText('Hash')
  await bodyRow.getByRole('button', { name: '复制正文' }).click()
  await expect(bodyRow.getByRole('button', { name: '已复制' })).toBeVisible()
  const search = panel.getByPlaceholder('搜索岗位、邮箱、主题或附件名')
  await search.fill('产品经理')
  await expect(bodyRow).toBeVisible()
  await expect(bodyRow.getByTestId(`batch-cover-letter-${bodyNoteId}`)).toContainText('预演定稿关键词')
  await expect(freezeButton).toBeDisabled()
  await search.fill('')
  await expect(commentRow.getByRole('button', { name: /author@example\.test/ })).toBeVisible()
  await expect(freezeButton).toBeDisabled()
  const coverLetterToggle = bodyRow.getByRole('button', { name: '展开全文' })
  await expect(coverLetterToggle).toHaveAttribute('aria-expanded', 'false')
  await coverLetterToggle.click()
  await expect(bodyRow.getByRole('button', { name: '收起全文' })).toHaveAttribute('aria-expanded', 'true')
  await bodyRow.getByRole('button', { name: '收起全文' }).click()
  await expect(bodyRow.getByText('正文', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('实际发送标题', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('投递预演 · 计划发送名', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('个人简历.pdf', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('产品经理-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()
  await expect(commentRow.getByText('帖主评论邮箱需人工核验后方可投递')).toBeVisible()
  await expect(commentRow.getByRole('button', { name: /author@example\.test/ })).toBeVisible()
  await expect(partialRow.getByText('评论采集未完成', { exact: true })).toBeVisible()
  await expect(partialRow.getByText('评论采集未完成，暂不判断无邮箱')).toBeVisible()
  await expect(partialRow.getByText('无可用邮箱')).toHaveCount(0)

  await panel.getByRole('combobox', { name: '附件筛选' }).selectOption('will_rename')
  await expect(bodyRow).toBeVisible()
  await expect(commentRow).toHaveCount(0)
  await expect(partialRow).toHaveCount(0)
  await panel.getByRole('combobox', { name: '附件筛选' }).selectOption('all')
  await panel.getByRole('button', { name: '待我处理', exact: true }).click()
  await expect(commentRow).toBeVisible()
  await expect(partialRow).toBeVisible()
  await expect(bodyRow).toHaveCount(0)
  await panel.getByRole('button', { name: '全部', exact: true }).click()

  await commentRow.getByRole('button', { name: /author@example\.test/ }).click()
  await expect(commentRow.getByText('帖主评论', { exact: true })).toBeVisible()
  await expect(commentRow.getByText('增长策略实习生-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()
  await expect(freezeButton).toBeEnabled()

  expect(capture.dryRuns).toHaveLength(2)
  expect(capture.dryRuns[0]).toMatchObject({
    noteIds: [bodyNoteId, commentNoteId, partialNoteId],
    selectionRevisions: [
      { noteId: bodyNoteId, revision: `revision-${bodyNoteId}` },
      { noteId: commentNoteId, revision: `revision-${commentNoteId}` },
      { noteId: partialNoteId, revision: `revision-${partialNoteId}` },
    ],
  })
  expect(capture.dryRuns[1]).toMatchObject({
    noteIds: [bodyNoteId, commentNoteId, partialNoteId],
    contactApprovals: [{ noteId: commentNoteId, evidenceHash: commentEvidenceHash, confirmed: true }],
  })

  await bodyRow.getByRole('checkbox').uncheck({ force: true })
  await expect(freezeButton).toBeDisabled()
  await bodyRow.getByRole('checkbox').check({ force: true })
  await expect(freezeButton).toBeDisabled()
  await panel.getByRole('button', { name: '仅保留可投递' }).click()
  await expect(freezeButton).toBeEnabled()
  const candidateRequestsBeforeFreeze = capture.candidateRequests.length
  await freezeButton.click()
  const frozen = panel.getByRole('region', { name: '冻结批次预览' })
  const frozenItems = frozen.locator('.frozen-item-list')
  await expect(frozen).toBeVisible()
  await expect(frozenItems.getByText('jobs@example.test', { exact: true })).toBeVisible()
  await expect(frozenItems.getByText('author@example.test', { exact: true })).toBeVisible()
  await expect(frozenItems.getByText('产品经理-张三-北京大学-简历.pdf', { exact: true })).toBeVisible()
  await expect(bodyRow.getByText('冻结快照中的实际发送标题', { exact: true })).toBeVisible()

  const emailPreview = frozen.getByTestId('batch-email-preview')
  const emailCards = emailPreview.locator('.batch-email-preview-card')
  await expect(emailPreview).toBeVisible()
  await expect(emailCards).toHaveCount(2)
  await expect(emailCards.nth(0)).toContainText('jobs@example.test')
  await expect(emailCards.nth(0).locator('.batch-email-preview-body')).toHaveText(/.+/u)
  await expect(emailCards.nth(0).getByText('Cover Letter 正文', { exact: false })).toBeVisible()
  await expect(emailCards.nth(1)).toContainText('author@example.test')
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforeFreeze + 1)
  await expect(panel.locator('.batch-candidate-pagination')).toHaveAttribute('aria-busy', 'false')

  const candidateRequestsBeforeApproval = capture.candidateRequests.length
  await frozen.getByRole('button', { name: '审批' }).click()
  await expect(panel.getByText('已审批', { exact: true })).toHaveText('已审批')
  await expect(frozen.getByRole('button', { name: '开始' })).toBeEnabled()
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforeApproval + 1)
  await expect(panel.locator('.batch-candidate-pagination')).toHaveAttribute('aria-busy', 'false')
  await expect(panel.locator('.batch-selection-summary')).toContainText('筛选外 0 · 无效 2')
  expect(capture.creates).toHaveLength(1)
  expect(capture.creates[0]).toMatchObject({
    noteIds: [bodyNoteId, commentNoteId],
    confirmedNoteIds: [bodyNoteId, commentNoteId],
    preflightId: 'plan-e2e-001',
    manifestHash: '8'.repeat(64),
    selectionSnapshotId: 'selection-snapshot-note-body-email-note-author-comment-note-partial-comments',
    selectionSnapshotHash: 'snapshot-note-body-email-note-author-comment-note-partial-comments',
    selectionRevisions: [
      { noteId: bodyNoteId, revision: `revision-${bodyNoteId}` },
      { noteId: commentNoteId, revision: `revision-${commentNoteId}` },
    ],
  })
  expect(String(capture.creates[0].idempotencyKey)).toContain('8'.repeat(64))
  expect(capture.approvals).toEqual([{ expectedRevision: 1 }])

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if ((page.viewportSize()?.width || 0) >= 1_200) {
    expect(await panel.locator('.batch-table-wrap').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
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
    await expect(panel.locator('.batch-status-badge')).toBeVisible()
    if (viewport.name === 'mobile') {
      const mobileRowLayout = await panel.locator('tbody tr').first().evaluate((row) => {
        const cells = [...row.querySelectorAll(':scope > td')]
        const boxes = cells.map((cell) => {
          const box = cell.getBoundingClientRect()
          const childBottom = Math.max(box.top, ...[...cell.children].map((child) => child.getBoundingClientRect().bottom))
          return { top: box.top, bottom: box.bottom, childBottom }
        })
        return {
          childrenContained: boxes.every((box) => box.childBottom <= box.bottom + 1),
          cellsSeparated: boxes.every((box, index) => index === boxes.length - 1 || box.bottom <= boxes[index + 1].top + 1),
        }
      })
      expect(mobileRowLayout).toEqual({ childrenContained: true, cellsSeparated: true })
    }
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.style.scrollBehavior = 'auto'
      window.scrollTo(0, 0)
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.screenshot({ path: `output/playwright/batch-application/workbench-${viewport.name}.png` })
  })
}

test('structured filters include matching roles beyond the first candidate page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, null, paginatedApplications)
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  await expect(panel.locator('tbody tr')).toHaveCount(25)
  await expect.poll(() => capture.candidateRequests.length).toBe(1)
  expect(new URL(capture.candidateRequests[0]).searchParams.get('limit')).toBe('50')
  const namingFilter = panel.getByRole('combobox', { name: '附件筛选' })
  await namingFilter.selectOption('will_rename')
  await expect.poll(() => capture.candidateRequests.length).toBe(2)
  await expect(panel.locator('.batch-search-summary')).toContainText('待投岗位 25 项')
  await expect(panel.locator('.batch-search-summary')).toContainText('筛选结果 1 项')
  await expect(panel.getByText('岗位 25', { exact: true })).toBeVisible()
  await expect(panel.getByText('跨页命名-姓名-岗位.pdf', { exact: true })).toBeVisible()
  const search = panel.getByPlaceholder('搜索岗位、邮箱、主题或附件名')
  await search.fill('不存在的岗位')
  await expect(namingFilter).toHaveValue('will_rename')
  await expect(panel.locator('.batch-search-empty-row')).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
  await search.fill('')
  await expect(namingFilter).toHaveValue('will_rename')
  await expect(panel.getByText('岗位 25', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
})

test('page size 100 can select and Dry Run twenty-five applications in one batch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, null, paginatedApplications)
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  await expect(panel.locator('tbody tr')).toHaveCount(25)
  await panel.getByRole('combobox', { name: '每页显示数量' }).selectOption('100')
  await expect.poll(() => capture.candidateRequests.length).toBe(2)
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.get('limit')).toBe('100')
  await expect(panel.locator('tbody tr')).toHaveCount(25)

  await panel.getByRole('button', { name: '清空' }).click()
  await panel.getByRole('button', { name: '选择当前页' }).click()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 25 / 100')
  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect.poll(() => capture.dryRuns.length).toBe(1)
  const noteIds = capture.dryRuns[0].noteIds as string[]
  expect(noteIds).toHaveLength(25)
  expect(new Set(noteIds)).toEqual(new Set(paginatedApplications.map((item) => item.note_id)))
  await expect(panel.getByText('投递预演完成：25 项全部就绪；本次不会发送邮件。', { exact: true })).toBeVisible()
})

test('missing email subject falls back to the rendered attachment naming rule in the table and Dry Run', async ({ page }) => {
  expect(rawAttachmentSubjectApplication.outreach.email_subject).toBe('')
  expect(attachmentSubjectApplication).toMatchObject({
    outreach: { email_subject: attachmentSubject },
    emailSubjectPreview: attachmentSubject,
    emailSubjectRequirement: {
      detected: true,
      source: 'attachment_requirement',
      template: '学校-姓名-到岗时间',
      attachmentTemplate: '学校-姓名-到岗时间.pdf',
    },
  })

  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, null, [attachmentSubjectApplication])
  const panel = page.getByRole('region', { name: '批量投递工作台' })
  const row = panel.locator('tbody tr').filter({ has: page.getByText('用户研究实习生', { exact: true }) })

  await expect(row.getByText('实际发送标题', { exact: true })).toBeVisible()
  await expect(row.locator('.batch-subject')).toHaveText(attachmentSubject)
  await expect(row.locator('.batch-subject')).not.toContainText('.pdf')
  await expect(row.getByText('无独立邮件主题，已采用附件命名要求', { exact: true })).toBeVisible()
  await expect(row.getByText('附件命名要求兜底', { exact: true })).toBeVisible()
  await expect(row.getByText('来源附件模板：学校-姓名-到岗时间.pdf；发送时去掉文件扩展名并校验', { exact: true })).toBeVisible()
  await expect(row.getByText('学校-姓名-到岗时间.pdf', { exact: true })).toBeVisible()

  await row.getByRole('checkbox').check({ force: true })
  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect.poll(() => capture.preflights.length).toBe(1)
  expect(capture.preflights[0].items[0]).toMatchObject({
    noteId: attachmentSubjectNoteId,
    preview: { subject: attachmentSubject },
    payload: {
      subject: attachmentSubject,
      subjectRule: {
        detected: true,
        source: 'attachment_requirement',
        template: '学校-姓名-到岗时间',
        attachmentTemplate: '学校-姓名-到岗时间.pdf',
      },
    },
  })
  await expect(row.locator('.batch-subject')).toHaveText(attachmentSubject)
})

test('bulk one-click polish calls the versioned rewrite contract and reports partial failure', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const selectedApplications = paginatedApplications.slice(0, 3)
  const failedNoteId = selectedApplications[1].note_id
  const capture = await openWorkbench(page, null, selectedApplications, { rewriteFailureNoteIds: [failedNoteId] })
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  await panel.getByRole('button', { name: '清空' }).click()
  for (const record of selectedApplications) {
    const row = panel.locator('tbody tr').filter({ has: page.getByText(record.title, { exact: true }) })
    await row.getByRole('checkbox').check({ force: true })
  }
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 3 / 100')

  await panel.getByRole('button', { name: 'Dry Run' }).click()
  const freezeButton = panel.getByRole('button', { name: '冻结批次预览' })
  await expect(freezeButton).toBeEnabled()

  const polishButton = panel.getByRole('button', { name: '批量一键润色', exact: true })
  await expect(polishButton).toBeEnabled()
  const candidateRequestsBeforePolish = capture.candidateRequests.length
  await polishButton.click()

  const progress = panel.locator('.batch-polish-progress')
  await expect(progress).toHaveAttribute('role', 'status')
  await expect(progress).toContainText('已处理 3/3')
  await expect(progress).toContainText('成功 2 · 失败 1')
  await expect(panel.getByText(/批量润色完成：成功 2 条，失败 1 条.*fixture rewrite failed.*旧投递预演已失效。/u)).toBeVisible()
  await expect(freezeButton).toBeDisabled()
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforePolish + 1)

  expect(capture.rewrites).toHaveLength(3)
  expect(new Set(capture.rewrites.map((request) => request.noteId))).toEqual(new Set(selectedApplications.map((item) => item.note_id)))
  for (const request of capture.rewrites) {
    const noteId = String(request.noteId)
    expect(request).toMatchObject({
      noteId,
      aiSessionId: 'session-e2e',
      draftId: `draft-${noteId}`,
      baseVersion: 1,
      applicationContext: {
        channel: 'email',
        contactStage: 'first_contact',
        tone: 'natural',
        resumeAttached: false,
        coverLetterAttached: false,
      },
    })
    expect(String(request.instructions)).toContain('保持所有事实可核验')
    expect(request.outreach).toMatchObject({
      email_subject: expect.any(String),
      email_body: expect.any(String),
      cover_letter: expect.any(String),
    })
  }

  const successfulRow = panel.locator('tbody tr').filter({ has: page.getByText(selectedApplications[0].title, { exact: true }) })
  const failedRow = panel.locator('tbody tr').filter({ has: page.getByText(selectedApplications[1].title, { exact: true }) })
  await expect(successfulRow.getByTestId(`batch-cover-letter-${selectedApplications[0].note_id}`)).toContainText('批量润色后的岗位 1专属 Cover Letter')
  await expect(successfulRow.locator('.batch-subject')).toHaveText('岗位 1申请-批量润色')
  await expect(failedRow.getByTestId(`batch-cover-letter-${selectedApplications[1].note_id}`)).toContainText('这是针对岗位 2岗位准备的求职文案')
})

test('candidate pagination loads one server page and keeps cross-page selection stable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, null, paginatedApplications)
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  const pageSize = panel.getByRole('combobox', { name: '每页显示数量' })
  await expect(pageSize).toHaveValue('50')
  await expect(pageSize.locator('option')).toHaveText(['20 条', '50 条', '100 条'])
  await expect(panel.locator('tbody tr')).toHaveCount(25)
  await expect.poll(() => capture.candidateRequests.length).toBe(1)
  const firstRequest = new URL(capture.candidateRequests[0])
  expect(firstRequest.searchParams.get('limit')).toBe('50')
  expect(firstRequest.searchParams.has('cursor')).toBe(false)

  await panel.getByRole('button', { name: '清空' }).click()
  await pageSize.selectOption('20')
  await expect(panel.locator('tbody tr')).toHaveCount(20)
  await expect.poll(() => capture.candidateRequests.length).toBe(2)
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.get('limit')).toBe('20')
  await panel.getByTitle('下一页待投岗位').click()
  await expect(panel.getByText('岗位 21', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
  const page21Row = panel.locator('tbody tr').filter({ has: page.getByText('分页岗位 21', { exact: true }) })
  await page21Row.locator('label.batch-checkbox').click()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 1 / 100')

  await panel.getByTitle('上一页待投岗位').click()
  await expect(panel.getByText('岗位 1', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
  const page1Row = panel.locator('tbody tr').filter({ has: page.getByText('分页岗位 1', { exact: true }) })
  await page1Row.locator('label.batch-checkbox').click()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 2 / 100')

  await panel.getByTitle('下一页待投岗位').click()
  await expect(page21Row.getByRole('checkbox')).toBeChecked()
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
  await panel.getByRole('combobox', { name: '附件筛选' }).selectOption('will_rename')
  await expect(panel.getByText('岗位 25', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(4)
  await expect(panel.locator('.batch-selection-summary')).toContainText('筛选外 2 · 无效 0')
  await panel.getByRole('combobox', { name: '附件筛选' }).selectOption('all')
  await expect(panel.getByText('岗位 1', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(4)
  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect.poll(() => capture.dryRuns.length).toBe(1)
  expect(capture.dryRuns[0]).toMatchObject({
    noteIds: ['note-page-01', 'note-page-21'],
    selectionRevisions: [
      { noteId: 'note-page-01', revision: 'revision-note-page-01' },
      { noteId: 'note-page-21', revision: 'revision-note-page-21' },
    ],
  })
})

test('stale candidate cursor refreshes page one and allows the next page to load again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, null, paginatedApplications, { staleCandidateCursorOnce: true })
  const panel = page.getByRole('region', { name: '批量投递工作台' })
  const search = panel.getByPlaceholder('搜索岗位、邮箱、主题或附件名')

  const pageSize = panel.getByRole('combobox', { name: '每页显示数量' })
  await expect(panel.locator('tbody tr')).toHaveCount(25)
  await pageSize.selectOption('20')
  await expect(panel.locator('tbody tr')).toHaveCount(20)
  await search.fill('分页岗位')
  await expect(panel.locator('.batch-search-summary')).toContainText('筛选结果 25 项')
  await expect.poll(() => capture.candidateRequests.length).toBe(3)
  await panel.getByRole('button', { name: '清空' }).click()
  const page1Row = panel.locator('tbody tr').filter({ has: page.getByText('分页岗位 1', { exact: true }) })
  await page1Row.locator('label.batch-checkbox').click()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 1 / 100')

  const requestsBeforeStaleCursor = capture.candidateRequests.length
  await panel.getByTitle('下一页待投岗位').click()
  await expect.poll(() => capture.candidateRequests.length).toBe(requestsBeforeStaleCursor + 2)
  await expect(panel.getByText('候选岗位已更新，正在刷新第一页。', { exact: true })).toBeVisible()
  await expect(search).toHaveValue('分页岗位')
  await expect(panel.getByText('岗位 1', { exact: true })).toBeVisible()
  await expect(page1Row.getByRole('checkbox')).toBeChecked()
  expect(new URL(capture.candidateRequests.at(-2)!).searchParams.get('cursor')).toBe('20')
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.has('cursor')).toBe(false)

  await panel.getByTitle('下一页待投岗位').click()
  await expect(panel.getByText('岗位 21', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(requestsBeforeStaleCursor + 3)
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.get('cursor')).toBe('20')
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 1 / 100')
})

test('changing the attachment naming rule invalidates the current preflight', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page)
  const panel = page.getByRole('region', { name: '批量投递工作台' })
  const freezeButton = panel.getByRole('button', { name: '冻结批次预览' })

  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect(freezeButton).toBeEnabled()
  await panel.locator('.batch-settings summary').click()
  await panel.locator('.batch-settings input').first().fill('{candidateName}-{jobTitle}-定制简历')
  await expect(panel.getByText('附件命名规则已变化，请重新运行投递预演。', { exact: true })).toBeVisible()
  await expect(freezeButton).toBeDisabled()
  await panel.getByRole('button', { name: 'Dry Run' }).click()
  await expect(freezeButton).toBeEnabled()
  expect(capture.dryRuns).toHaveLength(2)
  expect(capture.dryRuns[1]).toMatchObject({ defaultAttachmentTemplate: '{candidateName}-{jobTitle}-定制简历' })
})

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
  await expect(panel.locator('.batch-search-summary')).toContainText('待投岗位 3 项')
  await expect(panel.locator('.batch-search-summary')).toContainText('筛选结果 1 项')
  await expect(panel.locator('.batch-email')).toHaveText('jobs@example.test')
  await expect(panel.locator('.batch-search-empty-row')).toHaveCount(0)

  await search.fill('1396334506@qq.com')
  await expect(panel.locator('.batch-search-summary')).toContainText('待投岗位 3 项')
  await expect(panel.locator('.batch-search-summary')).toContainText('筛选结果 1 项')
  await expect(panel.locator('.batch-email')).toHaveText('1396334506@qq.com')
  await expect(panel.getByText('商业化产品经理', { exact: true })).toBeVisible()
  await expect(panel.getByText('图片 OCR · 已自动还原', { exact: true })).toBeVisible()
  await expect(panel.locator('.batch-contact-evidence').filter({ hasText: normalizedImageEvidence })).toBeVisible()
  await expect(panel.getByRole('button', { name: '查看图片证据' })).toBeVisible()
  await panel.locator('tbody input[type="checkbox"]').check()
  await expect(panel.locator('.batch-selection-actions')).toContainText('已选 1 / 100')
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
  const controls = panel.locator('.batch-control-actions')
  const status = panel.locator('.batch-status-badge')
  const sentFilter = panel.getByRole('button', { name: '已发送', exact: true })

  const candidateRequestsBeforeSentFilter = capture.candidateRequests.length
  await sentFilter.click()
  await expect(panel.locator('.batch-search-empty-row')).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforeSentFilter + 1)

  let candidateRequestCount = capture.candidateRequests.length
  await controls.getByRole('button', { name: '开始' }).click()
  await expect(status).toHaveClass(/running/u)
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestCount + 1)
  candidateRequestCount += 1
  await expect(panel.locator('.batch-selection-summary')).toContainText('筛选外 2 · 无效 0 · 修订缺失 2，请重新加载')
  await expect(panel.getByRole('button', { name: 'Dry Run' })).toBeDisabled()

  await controls.getByRole('button', { name: '暂停' }).click()
  await expect(status).toHaveClass(/paused/u)
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestCount + 1)
  candidateRequestCount += 1
  await controls.getByRole('button', { name: '恢复' }).click()
  await expect(status).toHaveClass(/running/u)
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestCount + 1)
  candidateRequestCount += 1
  await controls.getByRole('button', { name: '取消' }).click()
  await expect(status).toHaveClass(/cancelled/u)
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestCount + 1)

  expect(capture.controls).toEqual([
    { action: 'start', body: { expectedRevision: 2 } },
    { action: 'pause', body: { expectedRevision: 3 } },
    { action: 'resume', body: { expectedRevision: 4 } },
    { action: 'cancel', body: { expectedRevision: 5 } },
  ])
})

test('batch revision drops a page cursor and reloads candidate eligibility from page one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1_000 })
  const capture = await openWorkbench(page, frozenBatch('approved'), paginatedApplications)
  const panel = page.getByRole('region', { name: '批量投递工作台' })

  await expect(panel.locator('tbody tr')).toHaveCount(25)
  await expect(panel.locator('.batch-candidate-pagination')).toHaveAttribute('aria-busy', 'false')
  await panel.getByRole('combobox', { name: '每页显示数量' }).selectOption('20')
  await expect(panel.locator('tbody tr')).toHaveCount(20)
  const candidateRequestsBeforeNextPage = capture.candidateRequests.length
  await panel.getByTitle('下一页待投岗位').click()
  await expect(panel.getByText('岗位 21', { exact: true })).toBeVisible()
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforeNextPage + 1)
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.get('cursor')).toBe('20')

  const candidateRequestsBeforeStart = capture.candidateRequests.length
  await panel.locator('.batch-control-actions').getByRole('button', { name: '开始' }).click()
  await expect(panel.locator('.batch-status-badge')).toHaveClass(/running/u)
  await expect.poll(() => capture.candidateRequests.length).toBe(candidateRequestsBeforeStart + 1)
  await expect(panel.getByText('岗位 1', { exact: true })).toBeVisible()
  expect(new URL(capture.candidateRequests.at(-1)!).searchParams.has('cursor')).toBe(false)
})
