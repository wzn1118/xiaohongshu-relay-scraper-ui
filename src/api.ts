import type { AiModelDiscovery, AiProviderOption, AiSession, ApplicationMutationResponse, ApplicationResultsQuery, ApplicationResultsResponse, Artifact, AudienceResultsResponse, AudienceResumeResponse, CandidateProfile, DataDeletionPreview, DataDeletionResult, DataDeletionSpec, DataRetentionCleanup, DataRetentionPolicy, Health, Job, JobEvent, JobRequest, LocalModelInstall, LocalModelStatus, MissingCompletionResponse, OutreachDraft, PreflightReport, RelayConfig, RelayRecoveryResult, RelayStatus, ResumeJobOptions, SmtpConfig, SmtpConfigUpdate, SmtpTestResult } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message
    const error = new Error(body.message || errorMessage || `请求失败 (${response.status})`) as Error & { code?: string; status?: number }
    error.code = typeof body.error === 'object' ? body.error?.code : body.code
    error.status = response.status
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
  setDelivery: (jobId: string, noteId: string, action: 'ready_to_apply' | 'ready_to_message' | 'applied' | 'messaged' | 'reset') =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/delivery`, { method: 'POST', body: JSON.stringify({ noteId, action }) }),
  saveDraft: (jobId: string, noteId: string, outreach: OutreachDraft) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/draft`, { method: 'POST', body: JSON.stringify({ noteId, outreach }) }),
  sendEmail: (jobId: string, noteId: string, to: string, outreach: OutreachDraft) =>
    request<ApplicationMutationResponse>(`/api/jobs/${encodeURIComponent(jobId)}/send-email`, { method: 'POST', body: JSON.stringify({ noteId, to, outreach }) }),
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
