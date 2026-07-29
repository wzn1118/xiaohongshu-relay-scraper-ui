import type { AiProviderOption, AiSession, ApplicationMutationResponse, ApplicationResultsResponse, Artifact, CandidateProfile, Health, Job, JobEvent, JobRequest, OutreachDraft, RelayConfig, RelayStatus, SmtpConfig, SmtpConfigUpdate, SmtpTestResult } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message
    throw new Error(body.message || errorMessage || `请求失败 (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/api/health'),
  aiProviders: () => request<AiProviderOption[]>('/api/ai/providers'),
  createAiSession: (payload: { provider: string; apiKey: string; model: string; baseUrl: string; wireApi: 'responses' | 'chat_completions' }) =>
    request<AiSession>('/api/ai/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  profiles: () => request<CandidateProfile[]>('/api/profiles'),
  importProfile: (payload: { aiSessionId: string; backgroundText: string; files: Array<{ name: string; base64: string }> }) =>
    request<CandidateProfile>('/api/profiles/import', { method: 'POST', body: JSON.stringify(payload) }),
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
  openRelayLogin: (profile: string) => request<{ opened: boolean; message?: string; profile?: string; url?: string }>('/api/relay/login', {
    method: 'POST',
    body: JSON.stringify({ profile, url: 'https://www.xiaohongshu.com' }),
  }),
  jobs: () => request<Job[]>('/api/jobs'),
  job: (id: string) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  createJob: (payload: JobRequest) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(payload) }),
  cancelJob: (id: string) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  artifacts: (id: string) => request<Artifact[]>(`/api/jobs/${encodeURIComponent(id)}/artifacts`),
  results: (id: string, offset = 0, limit = 50, query = '') => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (query.trim()) params.set('query', query.trim())
    return request<ApplicationResultsResponse>(`/api/jobs/${encodeURIComponent(id)}/results?${params}`)
  },
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
      stream.close()
      onDisconnect()
    }
    return () => stream.close()
  },
}
