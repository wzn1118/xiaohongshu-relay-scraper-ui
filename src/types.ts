export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type Artifact = {
  id: string
  name: string
  size: number
  modifiedAt?: string
  type?: string
  url?: string
}

export type Job = {
  id: string
  keyword: string
  status: JobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number | null
  progress?: number
  message?: string
  outputDir?: string
  artifacts?: Artifact[]
  artifactCount?: number
  config?: Partial<JobRequest>
  coverage?: CoverageSummary
  workflowSummary?: Record<string, unknown> | null
  discoveredCount?: number
  scrapedCount?: number
}

export type CoverageSummary = {
  discovered?: number
  bodyAttempted?: number
  bodySucceeded?: number
  timesNormalized?: number
  applicationInfo?: number
  draftsGenerated?: number
  qualityPassed?: number
  gatePassed?: boolean
  issueCount?: number
}

export type RelayStatus = {
  running?: boolean
  cdpReady?: boolean
  tabs?: number | unknown[]
  port?: number
  profile?: string
  authenticated?: boolean
  ready?: boolean
  attempted?: boolean
  helperTimedOut?: boolean
  helperExitCode?: number | null
  xiaohongshuTabs?: number
  setupRequired?: boolean
  setupStep?: 'install' | 'start' | 'login' | 'ready'
  message?: string
}

export type RelayConfig = {
  port: number
  profile: string
  autoConnect: boolean
}

export type SmtpProvider = '163' | 'qq' | 'gmail' | 'outlook' | 'custom'

export type SmtpAuthMode = 'login' | 'oauth2' | 'none'

export type SmtpOAuthConfig = {
  tenant: string
  clientId: string
  scope: string
  hasClientSecret: boolean
  hasRefreshToken: boolean
}

export type SmtpConfig = {
  provider: SmtpProvider
  host: string
  port: number
  secure: boolean
  requireTls: boolean
  auth: SmtpAuthMode
  authMode?: SmtpAuthMode
  user: string
  from: string
  hasPassword: boolean
  oauth: SmtpOAuthConfig
  configured: boolean
  verified: boolean
  maskedFrom: string
  lastVerifiedAt?: string
}

export type SmtpConfigUpdate = Partial<Pick<SmtpConfig, 'provider' | 'host' | 'port' | 'secure' | 'requireTls' | 'auth' | 'user'>> & {
  from: string
  password?: string
  clearPassword?: boolean
  autoConfigure?: boolean
  oauth?: Partial<Pick<SmtpOAuthConfig, 'tenant' | 'clientId' | 'scope'>> & {
    clientSecret?: string
    refreshToken?: string
    clearClientSecret?: boolean
    clearRefreshToken?: boolean
  }
}

export type SmtpTestResult = {
  ok: boolean
  configured: boolean
  from: string
  authMode: SmtpAuthMode
  lastVerifiedAt: string
}

export type Health = {
  ok: boolean
  service?: string
  version?: string
  runnerAvailable?: boolean
  timestamp?: string
  emailDelivery?: {
    configured: boolean
    from: string
    authMode?: 'auto' | 'login' | 'oauth2' | 'none'
  }
}

export type AiProviderOption = {
  id: 'openai' | 'codex' | 'deepseek' | 'qwen' | 'custom'
  label: string
  baseUrl: string
  model: string
  models: string[]
  requiresKey: boolean
  wireApi: 'responses' | 'chat_completions'
  bundled?: boolean
  configured?: boolean
  hasApiKey?: boolean
}

export type AiSession = {
  id: string
  provider: string
  model: string
  baseUrl: string
  wireApi: 'responses' | 'chat_completions'
  configured: boolean
  expiresAt: string
}

export type AiModelDiscovery = {
  provider: string
  baseUrl: string
  models: string[]
  fetchedAt: string
}

export type CandidateProfile = {
  id: string
  display_name: string
  summary: string
  skills: string[]
  sourceFiles: string[]
  updatedAt: string
  candidate_application?: Partial<CandidateApplicationProfile>
}

export type CandidateApplicationProfile = {
  name: string
  school: string
  major: string
  degreeYear: string
  phoneWeChat: string
  email: string
  availabilityDays: string
  internshipDuration: string
}

export type CollectionSpeedMode = 'steady' | 'random'

export type JobRequest = {
  keyword: string
  browserProfile: string
  relayPort: number
  limit: number
  maxScrolls: number
  stableRounds: number
  gotoTimeoutMs: number
  noteDelaySeconds: number
  speedMode: CollectionSpeedMode
  randomDelayMinSeconds: number
  randomDelayMaxSeconds: number
  mode: 'fresh' | 'resume'
  resumeFromJobId?: string | null
  skipPostprocess: boolean
  noAutoAttach: boolean
  checkOnly: boolean
  securityVerificationTimeoutSeconds: number
  useCodexRuntime: boolean
  codexBatchSize: number
  codexTimeoutSeconds: number
  aiSessionId?: string | null
  profileId?: string | null
  candidateProfile: CandidateApplicationProfile
  coverLetterThreshold: number
  coverLetterMaxAttempts: number
}

export type ProvenanceText = {
  text: string
  source_field: string
  evidence: string
}

export type ApplicationRoute = {
  type: string
  value: string
  evidence: string
  channel?: 'email' | 'direct_message' | 'link' | 'other'
  confidence?: number
}

export type OutreachDraft = {
  greeting: string
  email_subject: string
  email_body: string
  cover_letter: string
}

export type DeliveryState = {
  action: string
  updatedAt: string
  email?: {
    status: 'sent' | 'failed'
    to: string
    sentAt?: string
    failedAt?: string
    messageId?: string
  }
}

export type ApplicationResult = {
  note_id: string
  title: string
  note_url: string
  body: string
  access_status: string
  collected_at: string
  publish_time: {
    raw: string
    value: string
    precision: string
    is_estimated: boolean
  }
  application_info: {
    contacts: ApplicationRoute[]
    application_routes: ApplicationRoute[]
    responsibilities: ProvenanceText[]
    requirements: ProvenanceText[]
  }
  outreach: {
    greeting: string
    email_subject: string
    email_body: string
    cover_letter: string
    recommended_resume?: string
    resume_reason?: string
    generation_mode: string
    runtime_status: string
    status: string
  }
  job_capabilities?: Array<{ id: string; capability: string; why_it_matters: string; priority: number }>
  cover_letter_evaluation?: {
    score: number
    passed: boolean
    attempts: number
    threshold: number
    strengths: string[]
    problems: string[]
    rubric: Record<string, number>
  }
  delivery?: DeliveryState | null
  quality: Record<string, boolean>
}

export type ApplicationMutationResponse = {
  noteId: string
  outreach?: OutreachDraft
  delivery: DeliveryState | null
}

export type ApplicationResultsResponse = {
  available: boolean
  total: number
  offset: number
  limit: number
  items: ApplicationResult[]
  codexRuntime: Record<string, unknown> | null
  qualityGate: Record<string, unknown> | null
}

export type JobEvent = {
  type: 'snapshot' | 'status' | 'log' | 'artifacts' | 'done' | 'error'
  job?: Job
  line?: string
  level?: 'info' | 'warn' | 'error' | 'success'
  artifacts?: Artifact[]
  message?: string
}
