import type { AiModelDiscovery, AiProviderOption, AiSession, ApplicationMutationResponse, ApplicationResultsQuery, ApplicationResultsResponse, Artifact, AudienceAiActionResponse, AudienceAiAnchor, AudienceAiOverview, AudienceAiPreview, AudienceAiResultsModule, AudienceAiResultsResponse, AudienceAiScope, AudienceAiStartRequest, AudienceGrowthResponse, AudienceResultsResponse, AudienceResumeResponse, CandidateProfile, DataDeletionPreview, DataDeletionResult, DataDeletionSpec, DataRetentionCleanup, DataRetentionPolicy, DraftVersionRef, ExpansionActionResponse, ExpansionConfig, ExpansionWorkspaceState, Health, Job, JobEvent, JobRequest, LocalModelInstall, LocalModelStatus, MissingCompletionResponse, OutreachDraft, PreflightReport, RelayConfig, RelayRecoveryResult, RelayStatus, ResumeJobOptions, SmtpConfig, SmtpConfigUpdate, SmtpTestResult } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message
    const error = new Error(body.message || errorMessage || `请求失败 (${response.status})`) as Error & {
      code?: string
      status?: number
      expectedVersion?: number | null
      currentVersion?: number | null
    }
    error.code = typeof body.error === 'object' ? body.error?.code : body.code
    error.status = response.status
    error.expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null
    error.currentVersion = typeof body.currentVersion === 'number' ? body.currentVersion : null
    throw error
  }
  return response.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/api/health'),
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
  preflight: (payload: JobRequest) =>
    request<PreflightReport>('/api/preflight', { method: 'POST', body: JSON.stringify(payload) }),
  createJob: (payload: JobRequest) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(payload) }),
  resumeJob: (id: string, options: ResumeJobOptions) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  completeMissing: (id: string, aiSessionId: string | null) =>
    request<MissingCompletionResponse>(`/api/jobs/${encodeURIComponent(id)}/complete-missing`, {
      method: 'POST',
      body: JSON.stringify(aiSessionId ? { aiSessionId } : {}),
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
  audience: (id: string, kind: 'comments' | 'users' = 'comments', offset = 0, limit = 40, options: { postId?: string; query?: string } = {}) => {
    const params = new URLSearchParams({ kind, offset: String(offset), limit: String(limit) })
    if (options.postId) params.set('postId', options.postId)
    if (options.query?.trim()) params.set('query', options.query.trim())
    return request<AudienceResultsResponse>(`/api/jobs/${encodeURIComponent(id)}/audience?${params}`)
  },
  resumeAudience: (id: string) => request<AudienceResumeResponse>(`/api/jobs/${encodeURIComponent(id)}/audience/resume`, { method: 'POST' }),
  recoverAudienceRateLimit: (id: string) => request<AudienceResumeResponse>(`/api/jobs/${encodeURIComponent(id)}/audience/recover-rate-limit`, { method: 'POST' }),
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
  resumeExpansion: (id: string, retryIncomplete = false) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/resume`, {
    method: 'POST',
    body: JSON.stringify({ retryIncomplete }),
  }),
  cancelExpansion: (id: string) => request<ExpansionActionResponse>(`/api/jobs/${encodeURIComponent(id)}/expansion/cancel`, { method: 'POST', body: '{}' }),
  setDelivery: (jobId: string, noteId: string, action: 'ready_to_apply' | 'ready_to_message' | 'applied' | 'messaged' | 'reset', draftVersion?: DraftVersionRef) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/delivery`, { method: 'POST', body: JSON.stringify({ noteId, action, ...(draftVersion ? { draftId: draftVersion.draftId, version: draftVersion.version } : {}) }) }),
  saveDraft: (jobId: string, noteId: string, outreach: OutreachDraft, draftVersion?: DraftVersionRef) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft`, { method: 'POST', body: JSON.stringify({ noteId, outreach, ...(draftVersion ? { draftId: draftVersion.draftId, baseVersion: draftVersion.version } : {}) }) }),
  checkDraft: (jobId: string, noteId: string, draftVersion: DraftVersionRef, aiSessionId?: string) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft/quality`, { method: 'POST', body: JSON.stringify({ noteId, draftId: draftVersion.draftId, version: draftVersion.version, ...(aiSessionId ? { aiSessionId } : {}) }) }),
  sendEmail: (jobId: string, noteId: string, to: string, outreach: OutreachDraft, draftVersion?: DraftVersionRef) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/send-email`, { method: 'POST', body: JSON.stringify({ noteId, to, outreach, ...(draftVersion ? { draftId: draftVersion.draftId, version: draftVersion.version } : {}) }) }),
  artifactUrl: (jobId: string, artifact: Artifact) =>
    artifact.url || `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}`,
  subscribe: (id: string, onEvent: (event: JobEvent) => void, onDisconnect: () => void) => {
    const stream = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`)
    const handle = (event: MessageEvent) => {
      try {
        onEvent(JSON.parse(event.data) as JobEvent)
      } catch {
        onEvent({ type: 'log', line: event.data })
      }
    }
    stream.onmessage = handle
    for (const name of ['snapshot', 'status', 'log', 'artifacts', 'done', 'error']) {
      stream.addEventListener(name, handle as EventListener)
    }
    stream.onerror = () => {
      // Native EventSource reconnects automatically. Keep it open and use the
      // callback only to refresh the latest persisted snapshot while offline.
      onDisconnect()
    }
    return () => stream.close()
  },
}

function audienceAiPath(jobId: string, postId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}/audience/posts/${encodeURIComponent(postId)}/ai`
}
