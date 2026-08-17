import type { AiModelDiscovery, AiProviderOption, AiSession, AiSessionProbe, ApplicationAttachment, ApplicationAttachmentList, ApplicationBatch, ApplicationBatchCreateResponse, ApplicationBatchPreflight, ApplicationBatchRequest, ApplicationBatchStreamEvent, ApplicationContext, ApplicationDeliveryCandidatesQuery, ApplicationDeliveryCandidatesResponse, ApplicationMutationResponse, ApplicationResultsQuery, ApplicationResultsResponse, Artifact, AudienceAiActionResponse, AudienceAiAnchor, AudienceAiOverview, AudienceAiPreview, AudienceAiResultsModule, AudienceAiResultsResponse, AudienceAiScope, AudienceAiStartRequest, AudienceGrowthResponse, AudienceResultsResponse, AudienceResumeResponse, AuthSession, BodyImportOptions, BodyImportResponse, CandidateProfile, CoverLetterRewriteRequest, CoverLetterRewriteResponse, DataDeletionPreview, DataDeletionResult, DataDeletionSpec, DataRetentionCleanup, DataRetentionPolicy, DraftVersionRef, EmailPreview, ExpansionActionResponse, ExpansionConfig, ExpansionWorkspaceState, Health, Job, JobEvent, JobRequest, LocalModelInstall, LocalModelStatus, MissingCompletionResponse, OutreachDraft, PreflightReport, RelayConfig, RelayRecoveryResult, RelayStatus, ResumeJobOptions, SmtpConfig, SmtpConfigUpdate, SmtpTestResult, UserProblem, WorkflowConnectionState, WorkflowSnapshotV3 } from './types'

export type ApiError = Error & {
  code?: string
  status?: number
  expectedVersion?: number | null
  currentVersion?: number | null
  problem?: UserProblem | null
  details?: unknown
  retryAt?: string | null
  action?: UserProblem['action']
  resumable?: boolean
}

export type JobSubscriptionOptions = {
  afterSequence?: number
  onConnectionChange?: (connection: { state: WorkflowConnectionState; lastEventAt: string | null }) => void
}

export type JobExperienceActionResponse = {
  action: 'started' | 'signaled' | 'attached'
  jobId: string
  stage: string
  scope: string
  job: Job
  snapshot: WorkflowSnapshotV3 | null
}

const AI_GENERATION_REQUEST_TIMEOUT_MS = 720_000

async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const controller = timeoutMs && !init?.signal ? new AbortController() : null
  let timedOut = false
  const timeout = controller ? setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs) : null
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (cause) {
    if (timedOut) {
      const error = new Error('请求响应超时，正在核对任务状态。') as ApiError
      error.code = 'REQUEST_TIMEOUT'
      error.status = 0
      error.details = { path, timeoutMs }
      throw error
    }
    throw cause
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const nestedError = body.error && typeof body.error === 'object' ? body.error : null
    const errorMessage = typeof body.error === 'string' ? body.error : nestedError?.message
    const error = new Error(body.message || errorMessage || `请求失败 (${response.status})`) as ApiError
    error.code = body.code || nestedError?.code
    error.status = response.status
    error.expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null
    error.currentVersion = typeof body.currentVersion === 'number' ? body.currentVersion : null
    error.problem = body.problem && typeof body.problem === 'object' ? body.problem as UserProblem : null
    error.details = body.details ?? nestedError?.details
    error.retryAt = typeof body.retryAt === 'string' ? body.retryAt : error.problem?.retryAt || null
    error.action = body.action && typeof body.action === 'object' ? body.action : error.problem?.action || null
    error.resumable = Boolean(body.resumable ?? error.problem?.retryable)
    throw error
  }
  return response.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/api/health'),
  authMe: () => request<AuthSession>('/api/auth/me'),
  authLogin: (email: string, password: string) => request<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }),
  authLogout: () => request<{ authenticated: false }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  aiProviders: () => request<AiProviderOption[]>('/api/ai/providers'),
  localModels: () => request<LocalModelStatus>('/api/ai/local-models'),
  installLocalModel: (modelId: string) => request<LocalModelInstall>('/api/ai/local-models/install', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  }),
  discoverAiModels: (payload: { provider: string; apiKey: string; baseUrl: string }) =>
    request<AiModelDiscovery>('/api/ai/models', { method: 'POST', body: JSON.stringify(payload) }),
  createAiSession: (payload: { provider: string; apiKey: string; model: string; baseUrl: string; wireApi: 'responses' | 'chat_completions' }) =>
    request<AiSession>('/api/ai/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  probeAiSession: (sessionId: string) => request<AiSessionProbe>(`/api/ai/sessions/${encodeURIComponent(sessionId)}/probe`, {
    method: 'POST',
    body: '{}',
  }, 120_000),
  profiles: () => request<CandidateProfile[]>('/api/profiles'),
  importProfile: (payload: { aiSessionId: string; backgroundText: string; files: Array<{ name: string; base64: string }> }) =>
    request<CandidateProfile>('/api/profiles/import', { method: 'POST', body: JSON.stringify(payload) }),
  previewDataDeletion: (payload: DataDeletionSpec) => request<DataDeletionPreview>('/api/data/deletions/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  executeDataDeletion: (payload: DataDeletionSpec & { confirmationToken: string; confirmationPhrase?: string }) =>
    request<DataDeletionResult>('/api/data/deletions/execute', { method: 'POST', body: JSON.stringify(payload) }),
  dataRetention: () => request<DataRetentionPolicy>('/api/data/retention'),
  updateDataRetention: (payload: Partial<Pick<DataRetentionPolicy, 'enabled' | 'days' | 'pinnedJobIds'>>) =>
    request<DataRetentionPolicy>('/api/data/retention', { method: 'PUT', body: JSON.stringify(payload) }),
  cleanupExpiredData: (dryRun = true) => request<DataRetentionCleanup>('/api/data/retention/cleanup', {
    method: 'POST',
    body: JSON.stringify({ dryRun }),
  }),
  relayConfig: () => request<RelayConfig>('/api/relay/config'),
  updateRelayConfig: (payload: RelayConfig) => request<RelayConfig>('/api/relay/config', { method: 'PUT', body: JSON.stringify(payload) }),
  smtpConfig: () => request<SmtpConfig>('/api/email/config'),
  updateSmtpConfig: (payload: SmtpConfigUpdate) => request<SmtpConfig>('/api/email/config', { method: 'PUT', body: JSON.stringify(payload) }),
  clearSmtpConfig: () => request<SmtpConfig>('/api/email/config', { method: 'DELETE' }),
  testSmtp: () => request<SmtpTestResult>('/api/email/test', { method: 'POST' }),
  relayStatus: (port: number) => request<RelayStatus>(`/api/relay/status?port=${port}`),
  connectRelay: (port: number, profile: string) => request<RelayStatus & { ready?: boolean; attempted?: boolean }>(`/api/relay/connect`, {
    method: 'POST',
    body: JSON.stringify({ port, profile }),
  }),
  setupRelay: (port: number, profile: string) => request<RelayStatus & { ready?: boolean; attempted?: boolean; setup?: { ok: boolean; message?: string } }>(`/api/relay/setup`, {
    method: 'POST',
    body: JSON.stringify({ port, profile }),
  }),
  recoverRelay: (port: number, profile: string) => request<RelayRecoveryResult>('/api/relay/recover', {
    method: 'POST',
    body: JSON.stringify({ port, profile }),
  }),
  openRelayLogin: (profile: string) => request<{ opened: boolean; message?: string; profile?: string; url?: string }>('/api/relay/login', {
    method: 'POST',
    body: JSON.stringify({ profile, url: 'https://www.xiaohongshu.com' }),
  }),
  jobs: () => request<Job[]>('/api/jobs'),
  job: (id: string) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  jobExperienceSnapshot: (id: string) =>
    request<WorkflowSnapshotV3>(`/api/jobs/${encodeURIComponent(id)}/experience-snapshot`),
  jobIssues: (id: string) =>
    request<{ jobId: string; throughSequence: number; issues: UserProblem[] }>(`/api/jobs/${encodeURIComponent(id)}/issues`),
  jobTechnicalDiagnostics: (id: string) =>
    request<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(id)}/technical-diagnostics`),
  retryJobStage: (id: string, payload: { stage: string; aiSessionId?: string | null; idempotencyKey?: string }) =>
    request<JobExperienceActionResponse>(`/api/jobs/${encodeURIComponent(id)}/actions/retry-stage`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  checkJobRecovery: (id: string, payload: { idempotencyKey?: string } = {}) =>
    request<JobExperienceActionResponse>(`/api/jobs/${encodeURIComponent(id)}/actions/check-recovery`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  openJobLogin: (id: string) =>
    request<{ action: 'opened'; jobId: string; opened: boolean; profile: string; url: string; message: string }>(`/api/jobs/${encodeURIComponent(id)}/actions/open-login`, {
      method: 'POST',
      body: '{}',
    }),
  preflight: (payload: JobRequest) =>
    request<PreflightReport>('/api/preflight', { method: 'POST', body: JSON.stringify(payload) }),
  createJob: (payload: JobRequest) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(payload) }),
  createBodyImport: (payload: { records: Record<string, unknown>[]; sourceName: string; analysisMode: 'job' | 'general'; options: BodyImportOptions }) =>
    request<BodyImportResponse>('/api/body-imports', { method: 'POST', body: JSON.stringify(payload) }),
  resumeJob: (id: string, options: ResumeJobOptions) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  completeMissing: (id: string, aiSessionId: string | null) =>
    request<MissingCompletionResponse>(`/api/jobs/${encodeURIComponent(id)}/complete-missing`, {
      method: 'POST',
      body: JSON.stringify({ aiSessionId }),
    }),
  cancelJob: (id: string) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  artifacts: (id: string) => request<Artifact[]>(`/api/jobs/${encodeURIComponent(id)}/artifacts`),
  results: (id: string, offset = 0, limit = 50, options: ApplicationResultsQuery = {}) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (options.analysisMode) params.set('analysisMode', options.analysisMode)
    if (options.query?.trim()) params.set('query', options.query.trim())
    if (options.sort) params.set('sort', options.sort)
    if (options.timeRange) params.set('timeRange', options.timeRange)
    return request<ApplicationResultsResponse>(`/api/jobs/${encodeURIComponent(id)}/results?${params}`)
  },
  applicationDeliveryCandidates: (id: string, options: ApplicationDeliveryCandidatesQuery = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null || value === '') continue
      params.set(key, String(value))
    }
    return request<ApplicationDeliveryCandidatesResponse>(`/api/jobs/${encodeURIComponent(id)}/application-delivery-candidates?${params}`)
  },
  audience: (id: string, kind: 'comments' | 'users' = 'comments', offset = 0, limit = 40, options: { postId?: string; query?: string } = {}) => {
    const params = new URLSearchParams({ kind, offset: String(offset), limit: String(limit) })
    if (options.postId) params.set('postId', options.postId)
    if (options.query?.trim()) params.set('query', options.query.trim())
    return request<AudienceResultsResponse>(`/api/jobs/${encodeURIComponent(id)}/audience?${params}`)
  },
  resumeAudience: (id: string, idempotencyKey?: string) => request<AudienceResumeResponse>(`/api/jobs/${encodeURIComponent(id)}/audience/resume`, {
    method: 'POST',
    body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
  }),
  recoverAudienceRateLimit: (id: string, idempotencyKey?: string) => request<AudienceResumeResponse>(`/api/jobs/${encodeURIComponent(id)}/audience/recover-rate-limit`, {
    method: 'POST',
    body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
  }),
  growAudience: (id: string, maxScrolls: number) => request<AudienceGrowthResponse>(`/api/jobs/${encodeURIComponent(id)}/audience/grow`, {
    method: 'POST',
    body: JSON.stringify({ maxScrolls }),
  }),
  audienceAi: (jobId: string, postId: string) => request<AudienceAiOverview>(audienceAiPath(jobId, postId)),
  previewAudienceAi: (jobId: string, postId: string, scope: AudienceAiScope) => request<AudienceAiPreview>(`${audienceAiPath(jobId, postId)}/preview`, {
    method: 'POST',
    body: JSON.stringify(scope),
  }),
  startAudienceAi: (jobId: string, postId: string, scope: AudienceAiStartRequest) => request<AudienceAiActionResponse>(`${audienceAiPath(jobId, postId)}/runs`, {
    method: 'POST',
    body: JSON.stringify(scope),
  }),
  cancelAudienceAi: (jobId: string, postId: string, runId: string) => request<AudienceAiActionResponse>(`${audienceAiPath(jobId, postId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  resumeAudienceAi: (jobId: string, postId: string, runId: string) => request<AudienceAiActionResponse>(`${audienceAiPath(jobId, postId)}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  audienceAiRun: (jobId: string, postId: string, runId: string) => request<AudienceAiActionResponse>(`${audienceAiPath(jobId, postId)}/runs/${encodeURIComponent(runId)}`),
  audienceAiResults: (jobId: string, postId: string, runId: string, module: AudienceAiResultsModule = 'analysis', offset = 0, limit = 100) => request<AudienceAiResultsResponse>(`${audienceAiPath(jobId, postId)}/runs/${encodeURIComponent(runId)}/results?${new URLSearchParams({ module, offset: String(offset), limit: String(limit) })}`),
  audienceAiEventsUrl: (jobId: string, postId: string) => `${audienceAiPath(jobId, postId)}/events`,
  audienceCommentAnchor: (jobId: string, postId: string, commentId: string) => request<AudienceAiAnchor>(`/api/jobs/${encodeURIComponent(jobId)}/audience/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/anchor`),
  audienceUserAnchor: (jobId: string, postId: string, userId: string) => request<AudienceAiAnchor>(`/api/jobs/${encodeURIComponent(jobId)}/audience/posts/${encodeURIComponent(postId)}/users/${encodeURIComponent(userId)}/anchor`),
  expansion: (id: string, kind: 'users' | 'posts' | 'comments' | 'relations' = 'users', offset = 0, limit = 50, filters: { round?: string; status?: string; seed?: string } = {}) =>
    request<ExpansionWorkspaceState>(`/api/jobs/${encodeURIComponent(id)}/expansion?${new URLSearchParams({ kind, offset: String(offset), limit: String(limit), ...(filters.round ? { round: filters.round } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.seed ? { seed: filters.seed } : {}) })}`),
  startExpansion: (id: string, seedPostIds: string[], config: ExpansionConfig) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/start`, {
    method: 'POST',
    body: JSON.stringify({ seedPostIds, config }),
  }),
  createExpansionAttempt: (id: string, seedPostIds: string[], config: ExpansionConfig) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/attempts`, {
    method: 'POST',
    body: JSON.stringify({ seedPostIds, config }),
  }),
  resumeExpansion: (id: string, retryIncomplete = false) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/resume`, {
    method: 'POST',
    body: JSON.stringify({ retryIncomplete }),
  }),
  cancelExpansion: (id: string) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/cancel`, { method: 'POST', body: '{}' }),
  setDelivery: (jobId: string, noteId: string, action: 'ready_to_apply' | 'ready_to_message' | 'applied' | 'messaged' | 'reset', draftVersion?: DraftVersionRef) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/delivery`, { method: 'POST', body: JSON.stringify({ noteId, action, ...(draftVersion ? { draftId: draftVersion.draftId, version: draftVersion.version } : {}) }) }),
  saveDraft: (jobId: string, noteId: string, outreach: OutreachDraft, draftVersion?: DraftVersionRef, applicationContext?: ApplicationContext) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft`, { method: 'POST', body: JSON.stringify({ noteId, outreach, ...(applicationContext ? { applicationContext } : {}), ...(draftVersion ? { draftId: draftVersion.draftId, baseVersion: draftVersion.version } : {}) }) }),
  rewriteCoverLetter: (jobId: string, payload: CoverLetterRewriteRequest) =>
    request<CoverLetterRewriteResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft/rewrite`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, AI_GENERATION_REQUEST_TIMEOUT_MS),
  checkDraft: (jobId: string, noteId: string, draftVersion: DraftVersionRef, aiSessionId?: string, attachmentIds: string[] = [], applicationContext?: ApplicationContext) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft/quality`, { method: 'POST', body: JSON.stringify({ noteId, draftId: draftVersion.draftId, version: draftVersion.version, attachmentIds, ...(applicationContext ? { applicationContext } : {}), ...(aiSessionId ? { aiSessionId } : {}) }) }),
  applicationAttachments: (jobId: string, noteId: string) =>
    request<ApplicationAttachmentList>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments?noteId=${encodeURIComponent(noteId)}`),
  uploadApplicationAttachment: (jobId: string, noteId: string, file: File, draftVersion?: DraftVersionRef, source: ApplicationAttachment['source'] = 'uploaded') => {
    const body = new FormData()
    body.append('noteId', noteId)
    body.append('source', source)
    body.append('selected', 'true')
    if (draftVersion) {
      body.append('draftId', draftVersion.draftId)
      body.append('draftVersion', String(draftVersion.version))
    }
    body.append('file', file, file.name)
    return request<{ attachment: ApplicationAttachment; duplicate: boolean; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments`, { method: 'POST', body })
  },
  importProfileApplicationAttachment: (jobId: string, payload: { noteId: string; profileId: string; sourceFile: string; draftVersion?: DraftVersionRef }) =>
    request<{ attachment: ApplicationAttachment; duplicate: boolean; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments/from-profile`, {
      method: 'POST',
      body: JSON.stringify({
        noteId: payload.noteId,
        profileId: payload.profileId,
        sourceFile: payload.sourceFile,
        selected: true,
        ...(payload.draftVersion ? { draftId: payload.draftVersion.draftId, draftVersion: payload.draftVersion.version } : {}),
      }),
    }),
  importJobArtifactApplicationAttachment: (jobId: string, payload: { noteId: string; artifactId: string; displayName?: string; draftVersion?: DraftVersionRef }) =>
    request<{ attachment: ApplicationAttachment; duplicate: boolean; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments/from-artifact`, {
      method: 'POST',
      body: JSON.stringify({
        noteId: payload.noteId,
        artifactId: payload.artifactId,
        selected: true,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...(payload.draftVersion ? {
          draftId: payload.draftVersion.draftId,
          draftVersion: payload.draftVersion.version,
          contentHash: payload.draftVersion.contentHash,
        } : {}),
      }),
    }),
  exportCoverLetterApplicationAttachment: (jobId: string, noteId: string, draftVersion: DraftVersionRef) =>
    request<{ attachment: ApplicationAttachment; duplicate: boolean; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments/from-cover-letter`, {
      method: 'POST',
      body: JSON.stringify({
        noteId,
        draftId: draftVersion.draftId,
        draftVersion: draftVersion.version,
        contentHash: draftVersion.contentHash,
        selected: true,
      }),
    }),
  updateApplicationAttachment: (jobId: string, attachmentId: string, payload: { selected?: boolean; displayName?: string }) =>
    request<{ attachment: ApplicationAttachment; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments/${encodeURIComponent(attachmentId)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteApplicationAttachment: (jobId: string, attachmentId: string) =>
    request<{ attachmentId: string; deleted: boolean; revision: number }>(`/api/jobs/${encodeURIComponent(jobId)}/application-attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }),
  applicationAttachmentUrl: (jobId: string, attachmentId: string) =>
    `/api/jobs/${encodeURIComponent(jobId)}/application-attachments/${encodeURIComponent(attachmentId)}/content`,
  previewEmail: (jobId: string, noteId: string, to: string, attachmentIds: string[], draftVersion?: DraftVersionRef, recipientEvidence?: { evidenceHash?: string; sourceRevision?: string }) =>
    request<EmailPreview>(`/api/jobs/${encodeURIComponent(jobId)}/send-email/preview`, { method: 'POST', body: JSON.stringify({ noteId, to, attachmentIds, ...recipientEvidence, ...(draftVersion ? { draftId: draftVersion.draftId, version: draftVersion.version } : {}) }) }),
  sendEmail: (jobId: string, noteId: string, to: string, outreach: OutreachDraft, attachmentIds: string[], preview: EmailPreview, draftVersion?: DraftVersionRef, recipientEvidence?: { evidenceHash?: string; sourceRevision?: string }) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/send-email`, { method: 'POST', body: JSON.stringify({ noteId, to, outreach, attachmentIds, ...recipientEvidence, previewRevision: preview.previewRevision, attachmentBundleHash: preview.attachmentBundleHash, idempotencyKey: preview.previewRevision, ...(draftVersion ? { draftId: draftVersion.draftId, version: draftVersion.version } : {}) }) }),
  dryRunApplicationBatch: (jobId: string, payload: ApplicationBatchRequest) =>
    request<ApplicationBatchPreflight>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/dry-run`, { method: 'POST', body: JSON.stringify(payload) }),
  createApplicationBatch: (jobId: string, payload: ApplicationBatchRequest) =>
    request<ApplicationBatchCreateResponse>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches`, { method: 'POST', body: JSON.stringify(payload) }),
  applicationBatches: (jobId: string) =>
    request<{ batches: ApplicationBatch[] }>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches`),
  applicationBatch: (jobId: string, batchId: string) =>
    request<ApplicationBatch>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/${encodeURIComponent(batchId)}`),
  approveApplicationBatch: (jobId: string, batchId: string, expectedRevision: number) =>
    request<ApplicationBatch>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/${encodeURIComponent(batchId)}/approve`, { method: 'POST', body: JSON.stringify({ expectedRevision }) }),
  controlApplicationBatch: (jobId: string, batchId: string, action: 'start' | 'pause' | 'resume' | 'cancel', expectedRevision?: number) =>
    request<ApplicationBatch>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/${encodeURIComponent(batchId)}/${action}`, { method: 'POST', body: JSON.stringify({ ...(expectedRevision ? { expectedRevision } : {}) }) }),
  reconcileApplicationBatchItem: (jobId: string, batchId: string, itemId: string, expectedRevision: number, expectedItemRevision: number, outcome: 'sent' | 'not_sent') =>
    request<ApplicationBatch>(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision,
        expectedItemRevision,
        outcome,
        actor: 'user',
        reason: outcome === 'sent' ? '已核对发件箱或服务商记录，确认服务器已接收。' : '已核对发件箱或服务商记录，确认未发送。',
      }),
    }),
  subscribeApplicationBatch: (jobId: string, batchId: string, onEvent: (event: ApplicationBatchStreamEvent) => void, onDisconnect: () => void, afterSequence = 0) => {
    const params = afterSequence > 0 ? `?after=${Math.floor(afterSequence)}` : ''
    const stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/application-batches/${encodeURIComponent(batchId)}/events${params}`, { withCredentials: true })
    const receive = (event: Event) => {
      if (!(event instanceof MessageEvent)) return
      try {
        onEvent(JSON.parse(event.data) as ApplicationBatchStreamEvent)
      } catch {
        onDisconnect()
      }
    }
    stream.addEventListener('snapshot', receive)
    stream.addEventListener('batch', receive)
    stream.addEventListener('error', receive)
    stream.onerror = onDisconnect
    return () => stream.close()
  },
  artifactUrl: (jobId: string, artifact: Artifact) =>
    artifact.url || `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}`,
  subscribe: (id: string, onEvent: (event: JobEvent) => void, onDisconnect: () => void, options: JobSubscriptionOptions = {}) => {
    const params = new URLSearchParams()
    const initialSequence = Number(options.afterSequence)
    if (Number.isFinite(initialSequence) && initialSequence > 0) params.set('after', String(Math.floor(initialSequence)))
    const query = params.size ? `?${params}` : ''
    const stream = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events${query}`, { withCredentials: true })
    let highestSequence = Number.isFinite(initialSequence) ? Math.max(0, Math.floor(initialSequence)) : 0
    let highestRevision = -1
    let closed = false
    let lastEventAt: string | null = null
    const publishConnection = (state: WorkflowConnectionState, eventAt = lastEventAt) => {
      if (closed) return
      lastEventAt = eventAt
      options.onConnectionChange?.({ state, lastEventAt })
    }
    const handle = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as JobEvent
        const eventSequence = Number(parsed.sequence ?? parsed.workflowEvent?.sequence ?? event.lastEventId)
        const hasSequence = Number.isFinite(eventSequence) && eventSequence > 0
        if (hasSequence && eventSequence <= highestSequence) return
        const eventRevision = Number(
          parsed.revision
            ?? parsed.job?.revision
            ?? parsed.experienceSnapshot?.revision
            ?? parsed.workflowEvent?.sourceRevision,
        )
        const hasRevision = Number.isFinite(eventRevision) && eventRevision >= 0
        const carriesSnapshot = Boolean(parsed.job || parsed.experienceSnapshot)
        if (carriesSnapshot && hasRevision && eventRevision < highestRevision) return
        if (hasSequence) highestSequence = eventSequence
        if (hasRevision) highestRevision = Math.max(highestRevision, eventRevision)
        const receivedAt = new Date().toISOString()
        publishConnection('live', receivedAt)
        onEvent(parsed)
      } catch {
        publishConnection('live', new Date().toISOString())
        onEvent({ type: 'log', line: event.data })
      }
    }
    stream.onopen = () => publishConnection('live', new Date().toISOString())
    stream.onmessage = handle
    for (const name of ['snapshot', 'status', 'log', 'artifacts', 'done', 'error', 'workflow', 'problem', 'heartbeat']) {
      stream.addEventListener(name, handle as EventListener)
    }
    stream.onerror = () => {
      // Native EventSource reconnects automatically. Keep it open and use the
      // callback only to refresh the latest persisted snapshot while offline.
      publishConnection('reconnecting')
      onDisconnect()
    }
    publishConnection('reconnecting')
    return () => {
      options.onConnectionChange?.({ state: 'offline', lastEventAt })
      closed = true
      stream.close()
    }
  },
}

function audienceAiPath(jobId: string, postId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}/audience/posts/${encodeURIComponent(postId)}/ai`
}
