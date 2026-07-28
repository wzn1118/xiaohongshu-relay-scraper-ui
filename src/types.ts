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
  message?: string
}

export type Health = {
  ok: boolean
  service?: string
  version?: string
  runnerAvailable?: boolean
  timestamp?: string
}

export type AiProviderOption = {
  id: 'openai' | 'codex' | 'deepseek' | 'qwen' | 'custom'
  label: string
  baseUrl: string
  model: string
  requiresKey: boolean
}

export type AiSession = {
  id: string
  provider: string
  model: string
  baseUrl: string
  configured: boolean
  expiresAt: string
}

export type CandidateProfile = {
  id: string
  display_name: string
  summary: string
  skills: string[]
  sourceFiles: string[]
  updatedAt: string
}

export type JobRequest = {
  keyword: string
  browserProfile: string
  relayPort: number
  limit: number
  maxScrolls: number
  stableRounds: number
  gotoTimeoutMs: number
  noteDelaySeconds: number
  mode: 'fresh' | 'resume'
  skipPostprocess: boolean
  noAutoAttach: boolean
  checkOnly: boolean
  securityVerificationTimeoutSeconds: number
  useCodexRuntime: boolean
  codexBatchSize: number
  codexTimeoutSeconds: number
  aiSessionId?: string | null
  profileId?: string | null
  coverLetterThreshold: number
  coverLetterMaxAttempts: number
}

export type ProvenanceText = {
  text: string
  source_field: string
  evidence: string
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
    contacts: Array<{ type: string; value: string; evidence: string }>
    application_routes: Array<{ type: string; value: string; evidence: string }>
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
  delivery?: { action: string; updatedAt: string } | null
  quality: Record<string, boolean>
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
