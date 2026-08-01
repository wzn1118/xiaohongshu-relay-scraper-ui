export type JobStatus = 'queued' | 'resuming' | 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted' | 'blocked'

export type ResumeScope = 'full' | 'discovery' | 'body_completion' | 'analysis' | 'audience' | 'artifacts'

export type JobAttempt = {
  attemptId: string
  sequence: number
  kind: 'initial' | 'resume' | 'recovery_after_restart' | string
  status: string
  entryStatus: string
  exitStatus: string | null
  resumeScope: ResumeScope
  requestedBy?: string
  idempotencyKey?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  pid?: number | null
  exitCode?: number | null
  stopReason?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  logPath?: string
  checkpointRevisionAtStart?: number
  checkpointRevisionAtEnd?: number | null
  processedCountAtStart?: number
  processedCount: number
}

export type ResumeJobOptions = {
  scope: ResumeScope
  aiSessionId?: string | null
  idempotencyKey: string
}

export type SecurityRestriction = {
  detected: boolean
  status: 'waiting' | 'cleared' | 'timed_out'
  detectedAt?: string | null
  clearedAt?: string | null
  timedOutAt?: string | null
  timeoutSeconds?: number
  recoveryAction?: 'manual_verification' | 'manual_verification_then_resume' | null
}

export type RateLimitState = {
  detected: boolean
  status: 'waiting' | 'cleared' | 'stopped'
  detectedAt?: string | null
  clearedAt?: string | null
  exhaustedAt?: string | null
  retryAttempt?: number
  maxRetries?: number
  retryAfterSeconds?: number
  recoveryAction?: 'automatic_backoff' | 'wait_then_resume' | null
}

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
  schemaVersion?: number
  keyword: string
  status: JobStatus
  createdAt: string
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number | null
  pid?: number | null
  progress?: number
  message?: string
  outputDir?: string
  artifacts?: Artifact[]
  artifactCount?: number
  applicationCount?: number
  config?: Partial<JobRequest>
  coverage?: CoverageSummary
  workflowSummary?: Record<string, unknown> | null
  discoveredCount?: number
  scrapedCount?: number
  bodyProcessedCount?: number
  incompleteCount?: number
  progressPhase?: string | null
  progressLabel?: string | null
  progressCurrent?: number
  progressTotal?: number
  progressUpdatedAt?: string | null
  securityRestriction?: SecurityRestriction | null
  rateLimit?: RateLimitState | null
  resumeAvailable?: boolean
  currentAttemptId?: string | null
  activeAttemptId?: string | null
  attemptId?: string
  resumeCount?: number
  lastResumedAt?: string | null
  revision?: number
  stages?: Record<string, unknown>
  attempts?: JobAttempt[]
  legacyResumeLineage?: Record<string, unknown> | null
}

export type MissingCompletionResponse = {
  action: 'started' | 'attached' | 'already_complete'
  sourceJobId: string
  incompleteBefore: number | null
  job: Job
  message: string
}

export type CoverageSummary = {
  discovered?: number
  bodyAttempted?: number
  bodySucceeded?: number
  timesNormalized?: number
  applicationInfo?: number
  draftsGenerated?: number
  generationCoveragePercent?: number
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
  pageCount?: number
  iframeCount?: number
  workerCount?: number
  targetPressure?: 'normal' | 'high'
  pressureReasons?: string[]
  recoveryRecommended?: boolean
  setupRequired?: boolean
  setupStep?: 'install' | 'start' | 'login' | 'ready'
  checkedAt?: string
  message?: string
  supervisor?: RelaySupervisorStatus
}

export type RelaySupervisorStatus = {
  phase: 'idle' | 'connecting' | 'verifying' | 'restarting' | string
  inProgress: boolean
  automaticEnabled: boolean
  consecutiveProbeFailures: number
  consecutiveDegradedChecks: number
  lastProbeAt?: string | null
  lastRecoveryAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
  reason?: string | null
  nextAutomaticAttemptAt?: string | null
}

export type RelayTargetSummary = {
  targetCount: number
  pageCount: number
  xiaohongshuPages: number
  unrelatedPages: number
  iframeCount: number
  workerCount: number
  securityPages: number
  pressure: 'normal' | 'high'
  pressureReasons: string[]
  recoveryRecommended: boolean
}

export type RelayRecoveryResult = RelayStatus & {
  ok: boolean
  repaired: boolean
  closedTargets: number
  createdFreshTarget: boolean
  sessionPreserved: boolean
  playwrightVerified: boolean
  connectionTimeoutMs: number
  before: RelayTargetSummary
  after: RelayTargetSummary
  warnings: string[]
  hardRestarted?: boolean
  recoveryAttempts?: number
  joinedRecovery?: boolean
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
  id: 'local_qwen' | 'relay' | 'openai' | 'codex' | 'deepseek' | 'qwen' | 'custom'
  label: string
  baseUrl: string
  model: string
  models: string[]
  requiresKey: boolean
  wireApi: 'responses' | 'chat_completions'
  bundled?: boolean
  local?: boolean
  free?: boolean
  relay?: boolean
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

export type LocalModelCatalogItem = {
  id: string
  label: string
  description: string
  downloadBytes: number
  family: string
    tier: string
    recommended: boolean
    custom: boolean
    installed: boolean
}

export type LocalModelInstall = {
  id: string
  modelId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  completedBytes?: number
  totalBytes?: number
  message: string
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
}

export type LocalModelStatus = {
  runtime: {
    ready: boolean
    endpoint: string
    version?: string
    message: string
  }
  catalog: LocalModelCatalogItem[]
  installedModels: Array<{ name: string; size: number; modifiedAt?: string }>
  install: LocalModelInstall | null
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
export type SearchSortMode = 'latest' | 'comprehensive'
export type AnalysisMode = 'job' | 'general'
export type ContentResearchPreset = 'auto' | 'experience' | 'people' | 'trend' | 'product' | 'place' | 'custom'

export type ContentResearchContext = {
  preset: ContentResearchPreset
  label: string
  goal: string
}

export type ExpansionPostSelectionStrategy = 'latest' | 'keyword_match' | 'top_engagement' | 'all_reachable'

export type ExpansionRequest = {
  enabled: boolean
  rounds: number
  includeReplies: boolean
  maxReplyDepth: number
  maxUsersPerRound: number
  maxPostsPerUser: number
  maxCommentsPerPost: number
  maxTotalUsers: number
  maxTotalPosts: number
  maxTotalComments: number
  timeBudgetMinutes: number
  maxFailureCount: number
  concurrency: number
  postSelectionStrategy: ExpansionPostSelectionStrategy
  schemaVersion: 1
}

export type JobRequest = {
  analysisMode: AnalysisMode
  keyword: string
  contentPreset: ContentResearchPreset
  contentGoal: string
  searchSort: SearchSortMode
  maxAgeDays: number
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
  completeMissingOnly: boolean
  collectAudience: boolean
  audienceOnly: boolean
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
  expansion: ExpansionRequest
}

export type PreflightCheckStatus = 'passed' | 'warning' | 'blocked'

export type PreflightCheck = {
  code: string
  status: PreflightCheckStatus
  blocking: boolean
  message: string
  action: string
  details: Record<string, string | number | boolean | null>
  durationMs: number
}

export type PreflightReport = {
  schemaVersion: 1
  kind: 'preflight'
  status: 'ready' | 'blocked'
  ready: boolean
  checkedAt: string
  durationMs: number
  checks: PreflightCheck[]
}

export type AudienceStatus = 'complete' | 'partial' | 'pending' | 'failed'

export type AudiencePublicProfile = {
  user_id: string
  display_name: string
  profile_url: string
  avatar_url: string
  avatar_original_url?: string
  xhs_id: string
  bio: string
  ip_location?: string
  location: string
  following_count: number | null
  follower_count: number | null
  liked_and_collected_count: number | null
  roles: Array<'author' | 'commenter' | string>
  comment_count: number
  post_ids: string[]
  enrichment_status: 'complete' | 'partial' | 'pending' | string
  access_status: string
  missing_profile_fields?: string[]
  last_enriched_at: string
}

export type AudienceComment = {
  comment_id: string
  post_id: string
  post_title?: string
  parent_comment_id: string
  level: 'comment' | 'reply' | string
  text: string
  likes: number
  publish_time: string
  ip_location?: string
  location: string
  source_url: string
  user: AudiencePublicProfile
  collected_at: string
}

export type AudiencePost = {
  post_id: string
  title: string
  note_url: string
  author: AudiencePublicProfile
  expected_comment_count: number | null
  collected_comment_count?: number
  top_level_count?: number
  reply_count?: number
  unique_user_count?: number
  status?: AudienceStatus
  collectionStatus?: 'uncollected' | 'partial' | 'complete'
  completion_basis?: string
  failure_reason?: string
  last_collected_at?: string
}

export type AudienceSummary = {
  schemaVersion: number
  status: AudienceStatus
  postsTotal: number
  postsComplete: number
  postsPending: number
  postsPartial: number
  postsFailed: number
  postsAttempted: number
  postsWithComments: number
  commentsCollected: number
  topLevelComments: number
  repliesCollected: number
  usersDiscovered: number
  profilesComplete: number
  postCoveragePercent: number
  postAttemptPercent: number
  profileCoveragePercent: number
  stopReason: string
  generatedAt: string
}

type AudienceResultsBase = {
  available: boolean
  summary: AudienceSummary
  posts: AudiencePost[]
  total: number
  offset: number
  limit: number
  totals: { posts: number; comments: number; users: number }
  filters: { postId: string; query: string }
}

export type AudienceResultsResponse =
  | (AudienceResultsBase & { kind: 'comments'; items: AudienceComment[] })
  | (AudienceResultsBase & { kind: 'users'; items: AudiencePublicProfile[] })

export type AudienceResumeResponse = {
  action: 'started' | 'queued' | 'attached' | 'already_complete'
  sourceJobId: string
  checkpointJobId?: string
  readThroughJobIds?: string[]
  job: Job
  message: string
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
  source_field?: string
  source_fields?: string[]
  source_image_index?: number
  source_image_url?: string
  verification_status?: 'body_verified' | 'body_extracted' | 'image_format_verified' | 'cross_verified' | 'needs_manual_review' | string
  actionable?: boolean
}

export type OutreachDraft = {
  greeting: string
  email_subject: string
  email_body: string
  cover_letter: string
}

export type DraftQualityStatus = 'pending' | 'passed' | 'failed' | 'stale'

export type DraftVersionRef = {
  draftId: string
  version: number
  contentHash: string
  qualityStatus: DraftQualityStatus
  qualityCheckedVersion: number | null
  qualityCheckedHash: string | null
  qualityReportRef?: string | null
  createdAt: string
  updatedAt: string
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
  sendAudit?: Array<{
    draftId: string
    version: number
    contentHash: string
    recipient: string
    sentAt: string
    qualityReportRef: string | null
    idempotencyKey?: string
    messageId?: string
  }>
}

export type ApplicationMedia = {
  cover_url?: string
  cover_original_url?: string
  images: Array<{
    url: string
    original_url?: string
    alt?: string
    source: 'detail' | 'card' | 'cover' | string
  }>
  analysis?: {
    status: 'analyzed' | 'alt_text_only' | 'alt_text_available' | 'pending_ai' | 'no_images' | 'unavailable'
    summary?: string
    visible_text?: string
    visual_summary?: string
    visual_signals?: string[]
    analysis_version?: number
    job_signals?: string[]
    source?: 'vision_model' | 'image_alt_text' | 'model_error' | 'none' | string
    reason?: string
    application_route_count?: number
    application_requested_in_image?: boolean
  }
}

export type ContentModuleDefinition = {
  id: string
  title: string
  question: string
}

export type ContentPresentation = {
  eyebrow: string
  title: string
  description: string
  modules: ContentModuleDefinition[]
}

export type ContentAnalysisModule = {
  id: string
  title: string
  summary: string
  items: string[]
  evidence: string[]
}

export type ContentAnalysis = {
  status: 'completed' | 'fallback' | 'failed' | string
  overview: string
  content_type: string
  relevance_score: number
  relevance_reason: string
  topics: string[]
  entities: string[]
  image_insights: string[]
  modules: ContentAnalysisModule[]
  source_character_count?: number
  grounded_evidence_count?: number
}

export type ContentInsightEvidence = {
  noteId: string
  title: string
  quote: string
}

export type ContentInsightFinding = {
  label: string
  count: number
  evidence: ContentInsightEvidence[]
}

export type ContentInsights = {
  sampleSize: number
  sourceReady: number
  groundedRecords: number
  coverageRate: number
  methodNote: string
  topTopics: Array<ContentInsightFinding & { share: number }>
  modules: Array<{
    id: string
    title: string
    question: string
    recordCount: number
    coverageRate: number
    findings: ContentInsightFinding[]
  }>
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
  job_card?: {
    title: string
    source_url: string
    source_status: string
    parse_basis: 'full_body' | 'search_card'
    source_excerpt: string
    responsibility_count: number
    requirement_count: number
    route_count: number
    status: string
    role_name?: string
    enrichment_status?: string
    image_context_used?: boolean
  }
  media?: ApplicationMedia
  content_analysis?: ContentAnalysis
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
  draftVersion?: DraftVersionRef
  delivery?: DeliveryState | null
  quality: Record<string, boolean>
}

export type ApplicationMutationResponse = {
  noteId: string
  outreach?: OutreachDraft
  draftVersion?: DraftVersionRef
  cover_letter_evaluation?: ApplicationResult['cover_letter_evaluation']
  delivery: DeliveryState | null
}

export type ApplicationResultsResponse = {
  available: boolean
  analysisMode: AnalysisMode
  keyword: string
  research: ContentResearchContext | null
  presentation: ContentPresentation | null
  insights: ContentInsights | null
  total: number
  offset: number
  limit: number
  items: ApplicationResult[]
  filters: {
    sort: 'newest' | 'oldest'
    timeRange: 'all' | '1' | '3' | '7' | '30' | '90' | 'unknown'
    stats: {
      all: number
      dated: number
      unknown: number
      incomplete: number
      withImages: number
    }
  }
  codexRuntime: Record<string, unknown> | null
  qualityGate: Record<string, unknown> | null
}

export type ApplicationResultsQuery = {
  analysisMode?: AnalysisMode
  query?: string
  sort?: 'newest' | 'oldest'
  timeRange?: 'all' | '1' | '3' | '7' | '30' | '90' | 'unknown'
}

export type JobEvent = {
  type: 'snapshot' | 'status' | 'log' | 'artifacts' | 'done' | 'error'
  job?: Job
  line?: string
  level?: 'info' | 'warn' | 'error' | 'success'
  artifacts?: Artifact[]
  message?: string
}

export type DataDeletionSpec =
  | { entityType: 'profile'; profileId: string; force?: boolean }
  | { entityType: 'job'; jobId: string; force?: boolean }
  | { entityType: 'draft'; jobId: string; draftId: string; force?: boolean }
  | { entityType: 'artifact'; jobId: string; artifactId: string; force?: boolean }
  | { entityType: 'all'; force?: boolean }

export type DataDeletionPreview = {
  schemaVersion: number
  operation: string
  entityType: DataDeletionSpec['entityType']
  status: 'ready' | 'blocked'
  entities: Array<{ type: string; id?: string; name?: string; jobId?: string; reason?: string }>
  fileCount: number
  totalBytes: number
  references: Array<{ type: string; id?: string; relation?: string; status?: string }>
  blockedReasons: Array<{ code: string; message: string }>
  requiresForce: boolean
  confirmationToken: string
  confirmationExpiresAt: string
  confirmationPhrase?: string
}

export type DataDeletionResult = {
  schemaVersion: number
  deleted: true
  operation: string
  entities: DataDeletionPreview['entities']
  fileCount: number
  totalBytes: number
  audit: { recorded: boolean }
}

export type DataRetentionPolicy = {
  schemaVersion: number
  enabled: boolean
  days: number
  pinnedJobIds: string[]
  updatedAt: string | null
}

export type DataRetentionCleanup = {
  schemaVersion: number
  enabled: boolean
  dryRun: boolean
  eligible?: DataDeletionPreview[]
  deleted?: DataDeletionResult[]
  skipped: Array<{ type: 'job'; id: string; reason: 'pinned' | 'active' }>
  message?: string
}
