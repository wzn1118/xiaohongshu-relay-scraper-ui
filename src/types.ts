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
  status: 'waiting' | 'cleared' | 'stopped' | 'scheduled' | 'resuming'
  resumeScope?: 'audience' | 'body_completion'
  detectedAt?: string | null
  clearedAt?: string | null
  exhaustedAt?: string | null
  retryAttempt?: number
  maxRetries?: number
  retryAfterSeconds?: number
  autoRecoveryEnabled?: boolean
  autoResumeAttempt?: number
  maxAutoResumeAttempts?: number
  nextRetryAt?: string | null
  lastAutoResumeAt?: string | null
  lastManualResumeAt?: string | null
  lastAutoResumeError?: string | null
  manualProbeRequestedAt?: string | null
  manualProbeConsumedAt?: string | null
  recoveryAction?: 'automatic_backoff' | 'wait_then_resume' | 'manual_probe' | 'manual_resume' | 'automatic_resume' | null
}

export type WorkflowStage = 'preflight' | 'discovery' | 'body' | 'classify' | 'extract' | 'match'
  | 'draft' | 'quality' | 'audience' | 'artifact' | 'delivery'

export type WorkflowStageState = 'queued' | 'running' | 'waiting_system' | 'waiting_user' | 'retrying'
  | 'partial' | 'completed' | 'failed' | 'cancelled'

export type WorkflowProgress = {
  unit: 'card' | 'body' | 'job' | 'draft' | 'file' | 'email' | string
  done: number
  total: number | null
  succeeded: number
  reused: number
  retryable: number
  failed: number
  blocked: number
}

export type WorkflowPerformance = {
  activePerMinute: number | null
  wallPerMinute: number | null
  etaMinSeconds: number | null
  etaMaxSeconds: number | null
  confidence: 'low' | 'medium' | 'high' | string
}

export type UserProblem = {
  code: string
  category: 'access' | 'network' | 'content' | 'browser' | 'storage'
    | 'analysis' | 'artifact' | 'delivery' | 'input' | 'unknown'
  severity: 'info' | 'warning' | 'blocking'
  userTitle: string
  userMessage: string
  preservedResultCount: number
  automaticAction: string | null
  retryable: boolean
  retryAt: string | null
  requiresUserAction: boolean
  action: { id: string; label: string } | null
  affectedStage: string
  technicalRef: string
}

export type WorkflowEventV1 = {
  schemaVersion: 1
  eventId: string
  sequence: number
  jobId: string
  attemptId: string
  occurredAt: string
  type: 'task' | 'stage' | 'item' | 'checkpoint' | 'retry' | 'artifact' | 'warning' | 'error'
  stage: WorkflowStage | string
  state: WorkflowStageState
  progress: WorkflowProgress
  performance?: WorkflowPerformance
  message: { code: string; params?: Record<string, string | number | boolean> }
  problem?: UserProblem
  checkpoint?: { revision: number; savedAt: string; resumeAvailable: boolean }
  sourceRevision?: number
  outputRefs?: string[]
  technicalRef?: string
}

export type StageSnapshot = {
  stage: WorkflowStage | string
  state: WorkflowStageState
  headline?: string
  detail?: string
  progress: WorkflowProgress
  performance?: WorkflowPerformance
  problem?: UserProblem | null
  updatedAt?: string | null
}

export type WorkflowConnectionState = 'live' | 'reconnecting' | 'stale' | 'offline'

export type WorkflowSnapshotV3 = {
  schemaVersion: 3
  revision: number
  throughSequence: number
  jobId: string
  activeAttemptId: string | null
  journey: 'job' | 'general' | 'body_import'
  state: string
  activeStage: string | null
  headline: string
  detail: string
  stages: StageSnapshot[]
  counts: {
    discovered: number
    fullText: number
    confirmedJobs: number
    nonJobs: number
    matchReady: number
    draftReady: number
    applicationReady: number
    pending: number
    retryable: number
    unavailable: number
  }
  speed: {
    activePerMinute: number | null
    wallPerMinute: number | null
    cacheHits: number
    networkSuccess: number
    etaMinSeconds: number | null
    etaMaxSeconds: number | null
    confidence: string
  }
  issues: UserProblem[]
  connection: { state: WorkflowConnectionState; lastEventAt: string }
  checkpoint: { revision: number; savedAt: string; resumeAvailable: boolean }
}

export type Artifact = {
  id: string
  name: string
  path?: string
  size: number
  modifiedAt?: string
  type?: string
  url?: string
}

export type BodyMetrics = {
  schemaVersion: number
  statisticsSource: 'bodyCompletionLedger' | 'legacyInferred' | string
  legacyInferred: boolean
  discovered: number
  attempted: number
  succeeded: number
  failed: number
  notAttempted: number
  blocked: number
  cancelled: number
  pending: number
  completionRatePercent: number
  statusCounts?: Record<string, number>
  conservation: {
    left: number
    right: number
    valid: boolean
    terminal: boolean
    formula: string
  }
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
  bodyMetrics?: BodyMetrics
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
  experienceSnapshot?: WorkflowSnapshotV3 | null
  workflowSnapshot?: WorkflowSnapshotV3 | null
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
  bodyFailed?: number
  bodyNotAttempted?: number
  bodyBlocked?: number
  bodyCancelled?: number
  bodyCompletionRatePercent?: number
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
  audienceAi?: {
    enabled: boolean
    runnerAvailable?: boolean
  }
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
  schemaVersion?: number
  candidate_application?: Partial<CandidateApplicationProfile>
  candidate_application_evidence?: Array<{
    field: keyof CandidateApplicationProfile | string
    value: string
    source: string
    evidence: string
    confidence: number
  }>
  first_person_profile?: {
    headline: string
    narrative: string
    core_strengths: string[]
    application_value: string
  }
  evidence_items?: Array<{
    id: string
    category: string
    label: string
    organization: string
    period: string
    detail: string
    first_person_claim: string
    skills: string[]
    outcomes: string[]
    source: string
    evidence: string
    confidence: number
  }>
  writing_constraints?: {
    allowed_claims: string[]
    missing_information: string[]
  }
  analysis_runtime?: {
    provider: string
    model: string
    base_url?: string
    wire_api: 'responses' | 'chat_completions' | string
    selection_policy: 'local_default' | 'selected_external' | string
    fallback_used: boolean
    prompt_version: string
    generated_at: string
  }
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
  discoverMore?: boolean
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
  bodyOnly?: boolean
  importSourceName?: string
  importedBodyCount?: number
}

export type BodyImportOptions = Pick<JobRequest,
  'browserProfile' | 'relayPort' | 'gotoTimeoutMs' | 'noteDelaySeconds' | 'speedMode'
  | 'randomDelayMinSeconds' | 'randomDelayMaxSeconds' | 'securityVerificationTimeoutSeconds' | 'maxAgeDays'
>

export type BodyImportSummary = {
  receivedCount: number
  acceptedCount: number
  duplicateCount: number
  rejectedCount: number
  rejected: Array<{ index: number; reason: string; message: string }>
}

export type BodyImportResponse = {
  summary: BodyImportSummary
  job: Job
  message: string
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
  action: 'started' | 'queued' | 'attached' | 'already_complete' | 'signaled'
  sourceJobId: string
  checkpointJobId?: string
  readThroughJobIds?: string[]
  job: Job
  message: string
}

export type AudienceGrowthResponse = {
  action: 'started' | 'attached'
  sourceJobId: string
  checkpointJobId?: string
  stateOwnerJobId?: string
  readThroughJobIds?: string[]
  maxScrolls?: number
  job: Job
  message: string
}

export type AudienceAiProfileMode = 'none' | 'available_header' | 'collect_missing_header' | 'recent_public_posts'

export type AudienceAiModule =
  | 'comment_insights'
  | 'thread_insights'
  | 'user_insights'
  | 'audience_segments'
  | 'content_fit'
  | 'content_opportunities'
  | 'profile_insights'

export type AudienceAiStatus =
  | 'not_started'
  | 'snapshotting'
  | 'waiting_profile_enrichment'
  | 'collecting_profile_headers'
  | 'collecting_profile_posts'
  | 'analyzing_comments'
  | 'analyzing_users'
  | 'synthesizing'
  | 'validating'
  | 'exporting'
  | 'cancelling'
  | 'partial'
  | 'completed'
  | 'blocked'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type AudienceAiScope = {
  aiSessionId?: string | null
  includeTopLevelComments: boolean
  includeReplies: boolean
  includeUsers: boolean
  profileMode: AudienceAiProfileMode
  profileUserLimit: number
  profilePostLimitPerUser: number
  profilePostTotalLimit: number
  modules: AudienceAiModule[]
  outputLanguage: string
  evidenceStrictness: 'strict' | 'balanced'
  incrementalOnly: boolean
  maxEstimatedTokens?: number
  maxEstimatedCost?: number
}

export type AudienceAiCoverage = {
  expectedComments?: number | null
  sourceCommentsForPost?: number
  collectedComments?: number
  topLevelComments?: number
  replies?: number
  commentsAnalyzed?: number
  commentsSkipped?: number
  skipReasons?: Record<string, number>
  uniqueUsers?: number
  usersAnalyzed?: number
  profilesAvailable?: number
  profilesComplete?: number
  profilesPartial?: number
  profilesMissing?: number
  profilesUsed?: number
  profilePostsAvailable?: number
  profilePostsUsed?: number
  originalBodyAvailable?: boolean
  mediaAnalysisAvailable?: boolean
  sourceCheckpointIds?: string[]
  snapshotAt?: string
  coverageStatus?: string
  limitations?: string[]
}

export type AudienceAiProgress = {
  runId?: string
  postId?: string
  stage?: AudienceAiStatus | string
  completedUnits?: number
  totalUnits?: number
  commentsAnalyzed?: number
  usersAnalyzed?: number
  profilesUsed?: number
  tokenUsage?: Record<string, number>
  estimatedUsage?: boolean
  updatedAt?: string
  message?: string
}

export type AudienceAiRun = {
  runId: string
  jobId: string
  postId: string
  status: AudienceAiStatus
  profileMode: AudienceAiProfileMode
  modules: AudienceAiModule[]
  outputLanguage: string
  model?: { provider?: string | null; model?: string | null; wireApi?: string | null }
  promptVersion?: string
  schemaVersion?: number | string
  inputRevision?: string
  coverage?: AudienceAiCoverage
  progress?: AudienceAiProgress
  tokenUsage?: Record<string, number>
  cost?: number | null
  estimatedUsage?: boolean
  resumable?: boolean
  stale?: boolean
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: string
  startedAt?: string | null
  updatedAt: string
  completedAt?: string | null
  cancelledAt?: string | null
}

export type AudienceAiOverview = {
  available?: boolean
  featureEnabled?: boolean
  jobId?: string
  postId?: string
  status?: AudienceAiStatus
  currentRun: AudienceAiRun | null
  activeVersion: AudienceAiRun | null
  versions: AudienceAiRun[]
  coverage?: AudienceAiCoverage
  actions?: {
    canStart?: boolean
    canCancel?: boolean
    canResume?: boolean
    canReanalyze?: boolean
  }
  availableActions?: {
    canStart?: boolean
    canCancel?: boolean
    canResume?: boolean
    canViewResult?: boolean
  }
  latestResult?: {
    runId: string
    status: AudienceAiStatus
    inputRevision?: string
    resultsUrl?: string
    manifestArtifact?: string
  } | null
  message?: string
}

export type AudienceAiPreview = {
  jobId: string
  postId: string
  inputRevision?: string
  scope?: AudienceAiScope
  coverage: AudienceAiCoverage
  estimatedChunks?: number
  estimatedCalls?: number
  estimatedTokens?: number
  estimatedCost?: number | null
  estimatedNetworkRequests?: number
  estimated?: boolean
  canStart?: boolean
  estimate?: {
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
    estimatedTotalTokens?: number
    estimatedUnits?: number
    estimatedCost?: number | null
    costEstimated?: boolean
  }
  blockers?: Array<string | { code?: string; message: string; blocking?: boolean }>
  warnings?: Array<string | { code?: string; message: string; blocking?: boolean }>
}

export type AudienceAiStartRequest = AudienceAiScope & { idempotencyKey: string; aiSessionId: string }

export type AudienceAiActionResponse = {
  action?: 'started' | 'attached' | 'reused' | 'resumed' | 'cancelled'
  run: AudienceAiRun
  reused?: boolean
  changed?: boolean
  state?: AudienceAiOverview
  activeVersion?: AudienceAiRun | null
  message?: string
}

export type AudienceAiEvidence = {
  evidenceId?: string
  id?: string
  entityType: 'comment' | 'user' | 'post' | 'profile' | string
  entityId: string
  postId?: string
  field?: string
  excerpt?: string
  label?: string
  validated?: boolean
}

export type AudienceAiResultItem = Record<string, unknown> & {
  commentId?: string
  rootThreadId?: string
  userId?: string
  segmentId?: string
  evidenceRefs?: string[]
}

export type AudienceAiResultsModule = 'analysis' | 'comments' | 'threads' | 'users' | 'evidence' | 'coverage'

export type AudienceAiResultsResponse = {
  run?: AudienceAiRun
  runId?: string
  module: AudienceAiResultsModule
  total: number
  offset: number
  limit: number
  items: AudienceAiResultItem[]
  data?: AudienceAiResultItem[] | Record<string, unknown>
  analysis?: Record<string, unknown>
  coverage?: AudienceAiCoverage
  artifacts?: Artifact[]
}

export type AudienceAiAnchor = {
  jobId?: string
  postId: string
  entityType?: 'comment' | 'user'
  entityId?: string
  commentId?: string
  userId?: string
  parentCommentId?: string | null
  rootThreadId?: string | null
  offset?: number
  index?: number
  pageSize?: number
  page?: number
  limit?: number
}

export type WorkspaceView = 'insights' | 'audience' | 'expansion'

export type ExpansionRuntimeStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'blocked' | 'cancelled' | 'interrupted'

export type ExpansionActionState = 'ready' | 'running' | 'resumable' | 'completed'

export type ExpansionConfig = {
  enabled?: boolean
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
  concurrency: 1
  postSelectionStrategy: 'latest' | 'keyword_match' | 'top_engagement' | 'all_reachable'
  schemaVersion: 1
}

export type ExpansionSeedPost = {
  postId: string
  title: string
  author: Record<string, unknown>
  url: string
  coverUrl: string
  coverOriginalUrl?: string
  available: boolean
  unavailableReason: string
  contentStatus: 'complete' | 'partial'
  commentStatus: 'uncollected' | 'partial' | 'complete'
  collectionReason: string
  collectedComments: number
  selected: boolean
  expansionStatus: 'available' | 'expanding' | 'used'
}

export type ExpansionRoundSummary = Record<string, unknown> & { roundIndex?: number }

export type ExpansionArtifact = Artifact

export type ExpansionWorkspaceState = {
  available: boolean
  status: ExpansionRuntimeStatus
  runtimeStatus: ExpansionRuntimeStatus
  businessStatus: string
  stopReason: string
  resumable: boolean
  hasResults: boolean
  actionState: ExpansionActionState
  summary: Record<string, unknown>
  seeds: ExpansionSeedPost[]
  config: ExpansionConfig | null
  metrics: { rounds: number; currentRound: number; frontier: number; users: number; expandedUsers: number; posts: number; comments: number; duplicates: number; failures: number; remainingMinutes: number | null }
  rounds: ExpansionRoundSummary[]
  results: { kind: 'users' | 'posts' | 'comments' | 'relations'; total: number; offset: number; limit: number; items: Array<Record<string, unknown>>; filters: { round: string; status: string; seed: string } }
  artifacts: ExpansionArtifact[]
}

export type ExpansionActionResponse = {
  changed?: boolean
  attemptId?: string
  job: Job
  expansion: ExpansionWorkspaceState
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
  normalization_applied?: boolean
  evidence_hash?: string
  source_revision?: string
  actionable?: boolean
}

export type AuthSession = {
  authenticated: boolean
  required: boolean
  user: { email: string; roles: string[] } | null
}

export type OutreachDraft = {
  greeting: string
  email_subject: string
  email_body: string
  cover_letter: string
}

export type CoverLetterRewriteRequest = {
  noteId: string
  aiSessionId: string
  instructions: string
  outreach: OutreachDraft
  applicationContext: ApplicationContext
  draftId: string
  baseVersion: number
}

export type CoverLetterRewriteResponse = ApplicationMutationResponse & {
  outreach: OutreachDraft
  draftVersion: DraftVersionRef
  generation: {
    provider: string
    model: string
    wireApi: 'responses' | 'chat_completions' | string
    strategy?: 'local_plan_write_review' | 'direct_model_rewrite' | string
    modelCalls?: number
    reviewScore?: number | null
    styleViolationCount?: number
    signatureEvidenceIds?: string[]
    requestId?: string
    generatedAt: string
  }
}

export type ApplicationTone = 'formal' | 'natural' | 'concise'

export type ApplicationContext = {
  channel: 'email' | 'direct_message'
  contactStage: 'first_contact' | 'follow_up'
  tone: ApplicationTone
  resumeAttached: boolean
  coverLetterAttached: boolean
  recipientType: string
}

export type DraftQualityStatus = 'pending' | 'passed' | 'failed' | 'stale'

export type DraftVersionRef = {
  draftId: string
  version: number
  versionCount?: number
  contentHash: string
  qualityStatus: DraftQualityStatus
  qualityCheckedVersion: number | null
  qualityCheckedHash: string | null
  qualityReportRef?: string | null
  createdAt: string
  updatedAt: string
}

export type DeliveryRuntimeStatus = 'preview_ready' | 'preparing' | 'sending' | 'sent' | 'failed' | 'unknown' | 'blocked'

export type DeliveryState = {
  action: 'draft_saved' | 'ready_to_apply' | 'ready_to_message' | 'applied' | 'messaged' | `email_${DeliveryRuntimeStatus}` | DeliveryRuntimeStatus | (string & {})
  updatedAt: string
  generation?: {
    runId?: string
    promptVersion?: string
    provider?: string
    model?: string
    strategy?: string
    modelCalls?: number
    reviewScore?: number | null
    styleViolationCount?: number
    signatureEvidenceIds?: string[]
    profileSnapshotId?: string
    inputHash?: string
    usedEvidenceIds?: string[]
    status?: string
    generatedAt?: string
  }
  email?: {
    status: DeliveryRuntimeStatus
    to?: string
    sentAt?: string
    failedAt?: string
    messageId?: string
    errorCode?: string
  }
  sendAudit?: Array<{
    draftId: string
    version: number
    draftVersion?: number
    contentHash: string
    recipient: string
    recipientHash?: string
    status?: DeliveryRuntimeStatus
    sentAt?: string
    timestamp?: string
    qualityReportRef: string | null
    idempotencyKey?: string
    requestIdempotencyKey?: string
    messageId?: string
    sendId?: string
    errorCode?: string
    attachmentBundleHash?: string
    attachmentCount?: number
    attachmentBytes?: number
    attachments?: Array<{
      attachmentId: string
      filename: string
      mediaType: string
      size: number
      sha256: string
    }>
    previewRevision?: string
    configHash?: string
    credentialRevision?: number
    smtpConfigurationRevision?: number
    smtpConfigurationFingerprint?: string
  }>
}

export type ApplicationAttachment = {
  attachmentId: string
  jobId: string
  noteId: string
  originalName: string
  displayName: string
  extension: string
  mediaType: string
  size: number
  sha256: string
  source: 'uploaded' | 'candidate_profile' | 'job_artifact' | 'generated_cover_letter' | 'generated_resume'
  createdAt: string
  updatedAt: string
  status: 'uploading' | 'ready' | 'invalid' | 'missing' | 'deleted'
  validationStatus: string
  validationError: string
  selected: boolean
  generatedFrom: string
  draftId: string
  draftVersion: number
}

export type ApplicationAttachmentList = {
  schemaVersion: number
  revision: number
  noteId: string
  attachments: ApplicationAttachment[]
  selectedSummary: { count: number; totalBytes: number }
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
}

export type EmailPreview = {
  recipient: string
  from: string
  replyTo: string
  subject: string
  text: string
  htmlPreview: string
  draftId: string
  draftVersion: number
  quality: (DraftVersionRef & {
    checkedAt?: string
    evaluation: ApplicationResult['cover_letter_evaluation'] | null
  }) | null
  attachmentSummary: {
    count: number
    totalBytes: number
    attachments: Array<{ attachmentId: string; filename: string; mediaType: string; size: number; sha256: string }>
  }
  attachmentBundleHash: string
  previewRevision: string
  smtpConfigurationRevision: number
  smtpConfigurationFingerprint: string
  warnings: Array<{ code: string; message: string; blocking: boolean }>
  readiness: 'ready' | 'blocked'
  estimatedMessageSize: number
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

export type ApplicationCopyQuality = {
  cover_letter_chars?: number
  cover_letter_length_pass?: boolean
  role_evidence_count?: number
  ai_product_role?: boolean
  ai_product_mechanism_pass?: boolean
  attachment_claim_without_context?: boolean
  batch_ready?: boolean
}

export type ApplicationDeliveryManifestSummary = {
  schemaVersion: number
  noteId: string
  sourceRevision: string
  deliveryStatus: string
  recipientStatus: string
  recipientSource: string
  copyStatus: string
  subjectRuleStatus: string
  attachmentStatus: string
  readiness: string
  hasEmailBody: boolean
  hasCoverLetter: boolean
  recipient: {
    address: string
    normalizedAddress: string
    source: string
    evidenceHash: string
    verificationStatus: string
  } | null
  latestBatch: {
    batchId: string
    batchStatus: string
    itemId?: string
    itemStatus?: string
    updatedAt: string
  } | null
  blockers: Array<{ code: string; field: string; message: string }>
  warnings: Array<{ code: string; field: string; message: string }>
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
    content_quality?: ApplicationCopyQuality
    requirement_matches?: string[]
    used_evidence_ids?: string[]
    applicationContext?: ApplicationContext
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
    human_quality?: Record<string, {
      score: number
      passed: boolean
      problems: string[]
      evidence: string[]
      suggestedFix: string
    }>
  }
  draftVersion?: DraftVersionRef
  delivery?: DeliveryState | null
  attachmentRequirement?: {
    detected: boolean
    template: string
    evidence: string
    fields: string[]
  }
  emailSubjectRequirement?: {
    detected: boolean
    template: string
    evidence: string
    fields: string[]
    literal?: boolean
  }
  emailSubjectPreview?: string
  emailSubjectGuard?: {
    status: 'clean' | 'explicit_rule' | 'reconstructed_from_noisy_title' | 'rejected_noisy_title' | 'rejected_bare_title' | 'rejected_unverified_subject' | 'role_title_missing' | string
    requestedNoisyTitle?: boolean
    requestedBareTitle?: boolean
    requestedSourceTitle?: boolean
    requestedUnverifiedSubject?: boolean
    safeDefaultSubject?: boolean
    explicitRule?: boolean
    rawTitle?: string
    resolvedJobTitle?: string
    requiresReview?: boolean
    suggestedSubject?: string
    rejectedSubject?: string
    sourceStatus?: string
  }
  contactDiscovery?: ApplicationContactDiscovery | null
  deliveryManifestSummary?: ApplicationDeliveryManifestSummary
  quality: Record<string, boolean>
}

export type ApplicationMutationResponse = {
  noteId: string
  outreach?: OutreachDraft
  draftVersion?: DraftVersionRef
  cover_letter_evaluation?: ApplicationResult['cover_letter_evaluation']
  delivery: DeliveryState | null
  duplicate?: boolean
  sendId?: string
  attachmentBundleHash?: string
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
  coverage?: CoverageSummary | null
  contactResolution: {
    action: 'started' | 'attached' | 'already_complete' | 'manual_retry_required' | 'status' | 'error'
    status: 'idle' | 'starting' | 'running' | 'completed' | 'partial' | 'failed' | 'interrupted'
    active: boolean
    totalQueued?: number
    processed?: number
    succeeded?: number
    failed?: number
    emailsFound?: number
    baseline?: {
      withImages: number
      imageOcrComplete: number
      imageOcrPending: number
      imageOcrSkippedBodyEmail?: number
    }
    report?: {
      after?: {
        withImages: number
        imageOcrComplete: number
        imageOcrPending: number
        imageOcrSkippedBodyEmail?: number
      }
      queue?: {
        total: number
        processed: number
        succeeded: number
        failed: number
        emailsFound: number
      }
    } | null
    error?: string
  } | null
  contactDiscovery?: {
    generatedAt?: string
    sourceSignature?: string
    summary?: ApplicationContactDiscoverySummary
    error?: string
  } | null
  sourceCoverage: {
    status: 'complete' | 'partial'
    reason: string
    targetCount: number
    readyCount: number
    pendingCount: number
    totalRecordCount: number
    fullBodyCount: number
    statisticsSource?: string
  } | null
}

export type ApplicationResultsQuery = {
  analysisMode?: AnalysisMode
  query?: string
  sort?: 'newest' | 'oldest'
  timeRange?: 'all' | '1' | '3' | '7' | '30' | '90' | 'unknown'
}

export type ApplicationDeliveryCandidatesQuery = {
  q?: string
  deliveryStatus?: string
  recipientStatus?: string
  recipientSource?: string
  copyStatus?: string
  subjectRuleStatus?: string
  attachmentStatus?: string
  readiness?: string
  hasCoverLetter?: boolean
  batchId?: string
  sort?: 'newest' | 'oldest' | 'readiness' | 'title'
  cursor?: string
  limit?: number
}

export type ApplicationDeliverySelectionSnapshot = {
  schemaVersion: number
  selectionSnapshotId: string
  selectionSnapshotHash: string
  queryHash: string
    candidateCount: number
    noteIds: string[]
    selectableNoteIds: string[]
    readyNoteIds: string[]
  revisions: Array<{ noteId: string; revision: string }>
}

export type ApplicationDeliveryCandidatesResponse = {
  schemaVersion: number
  available: boolean
  jobId: string
  total: number
  offset: number
  limit: number
  cursor: string | null
  nextCursor: string | null
  items: ApplicationResult[]
  filters: Record<string, unknown>
  facetCounts: Record<string, Record<string, number>>
  blockerCounts: Record<string, number>
  selectionSnapshot: ApplicationDeliverySelectionSnapshot
}

export type ApplicationContactSource = 'body' | 'image' | 'author_comment' | 'other_comment'

export type ApplicationContactCandidate = {
  address: string
  source: ApplicationContactSource
  noteId: string
  postId: string
  commentId: string
  authorId: string
  evidenceText: string
  evidenceHash: string
  sourceRevision: string
  confidence: number
  collectionStatus: 'pending' | 'partial' | 'complete'
  verificationStatus: string
  normalizationApplied?: boolean
  sourceFields?: string[]
  actionable?: boolean
  requiresReview?: boolean
  ownershipStatus?: string
}

export type ApplicationContactDiscovery = {
  noteId: string
  postId: string
  title: string
  imageCount: number
  imageOcrStatus: string
  imageOcrAttempts: number
  status: 'ready' | 'manual_review' | 'pending' | 'no_email'
  reason: string
  collectionStatus: 'pending' | 'partial' | 'complete'
  requiresReview: boolean
  candidates: ApplicationContactCandidate[]
}

export type ApplicationContactDiscoverySummary = {
  totalRecords: number
  withImages: number
  imageOcrComplete: number
  imageOcrPending: number
  imageOcrFailed: number
  imageOcrSkippedBodyEmail: number
  bodyEmailRecords: number
  imageEmailRecords: number
  commentEmailRecords: number
  ready: number
  manualReview: number
  commentsPending: number
  commentsPartial: number
  noEmailConfirmed: number
}

export type ApplicationContactResolution = {
  schemaVersion: 1
  noteId: string
  postId: string
  status: 'ready' | 'manual_review' | 'pending' | 'no_email'
  reason: string
  source: string
  collectionStatus: 'pending' | 'partial' | 'complete'
  commentFallbackUsed: boolean
  requiresReview: boolean
  selectedCandidate: ApplicationContactCandidate | null
  candidates: ApplicationContactCandidate[]
  issues: Array<{ code: string; artifact?: string; reason?: string }>
}

export type ApplicationBatchItemStatus = 'resolving' | 'blocked_no_email' | 'blocked_ambiguous'
  | 'subject_pending' | 'draft_pending' | 'quality_pending' | 'filename_pending' | 'ready' | 'sending'
  | 'sent' | 'failed_retryable' | 'unknown_manual_review' | 'skipped' | 'copy_quality_failed'

export type ApplicationBatchAttachmentPreview = {
  attachmentId: string
  originalName: string
  currentDisplayName: string
  finalDisplayName: string
  plannedDisplayName?: string
  appliedDisplayName?: string
  namingStatus?: 'planned' | 'applied' | 'unchanged' | 'blocked' | string
  requirementSource?: 'post' | 'batch_default' | 'profile' | string
  willRename?: boolean
  renameRequired?: boolean
  ruleSource?: 'post_requirement' | 'batch_default' | string
  rule?: Record<string, unknown> | null
  sha256: string
  size?: number
  mediaType?: string
}

export type ApplicationBatchPreflightItem = {
  noteId: string
  title: string
  roleName: string
  status: ApplicationBatchItemStatus
  canPrepare: boolean
  blockers: Array<{ code: string; message: string }>
  contact: ApplicationContactCandidate | null
  contactResolution: ApplicationContactResolution | null
  attachments: ApplicationBatchAttachmentPreview[]
  preview: Pick<EmailPreview, 'recipient' | 'from' | 'replyTo' | 'subject' | 'text' | 'draftId' | 'draftVersion' | 'attachmentSummary' | 'attachmentBundleHash' | 'previewRevision' | 'smtpConfigurationRevision' | 'smtpConfigurationFingerprint' | 'warnings' | 'readiness' | 'estimatedMessageSize'> | null
  coverLetter?: string
  coverLetterHash?: string
  manifestHash?: string
  namingSummary?: { status?: string; plannedCount?: number; appliedCount?: number; source?: string }
  payload?: ApplicationBatchPayload | null
}

export type ApplicationBatchPreflight = {
  schemaVersion?: number
  dryRun?: boolean
  batchId: string
  planId?: string
  preflightId?: string
  manifestHash?: string
  deliveryManifest?: Record<string, unknown>
  generatedAt?: string
  expiresAt?: string
  maxBatchSize?: number
  items: ApplicationBatchPreflightItem[]
  counts: Partial<Record<ApplicationBatchItemStatus, number>>
  readyNoteIds: string[]
  preparableNoteIds: string[]
}

export type ApplicationBatchPayload = {
  title: string
  roleName: string
  recipient: string
  contact: ApplicationContactCandidate
  subject: string
  body: string
  coverLetter?: string
  coverLetterHash?: string
  coverLetterVersion?: number
  recipientHash?: string
  recipientEvidenceHash?: string
  recipientSourceRevision?: string | number
  recipientEvidence?: {
    evidenceHash: string
    source: string
    sourceRevision: string
    collectionStatus: string
    verificationStatus: string
  }
  sourceRevision?: string
  subjectRule?: Record<string, unknown> | null
  attachmentRules?: Array<Record<string, unknown>>
  manifestHash?: string
  planId?: string
  deliveryPlanId?: string
  plannedFilenames?: string[]
  plannedFinalFilenames?: string[]
  namingSummary?: { status?: string; source?: string; rule?: string }
  bodyHash: string
  draftId: string
  draftVersion: number
  contentHash: string
  qualityReportRef: string | null
  attachmentBundleHash: string
  attachments: Array<{ attachmentId: string; filename: string; mediaType: string; size: number; sha256: string }>
  finalFilenames: string[]
  previewRevision: string
  smtpConfigurationRevision: number
  smtpConfigurationFingerprint: string
  sendRequest: Record<string, unknown>
}

export type ApplicationBatchItem = {
  schemaVersion: number
  batchId: string
  itemId: string
  noteId: string
  contactCandidateId: string | null
  status: ApplicationBatchItemStatus
  payload: ApplicationBatchPayload | (Partial<ApplicationBatchPayload> & Record<string, unknown>)
  error: { code: string; message: string; attempt?: number; retryAt?: string } | null
  revision: number
  createdAt: string
  updatedAt: string
  recoveredAt: string | null
}

export type ApplicationBatchStatus = 'draft' | 'ready' | 'approved' | 'running' | 'paused' | 'completed' | 'cancelled'

export type ApplicationBatch = {
  schemaVersion: number
  batchId: string
  jobId: string
  title: string
  metadata: Record<string, unknown>
  settings: { concurrency?: number; minIntervalMs?: number; maxBatchSize?: number; stagedLimit?: number }
  status: ApplicationBatchStatus
  revision: number
  approvalRevision: number
  approval: { revision: number; batchRevision: number; snapshotHash: string; approvedAt: string; actor: string; reason: string } | null
  itemIds: string[]
  counts: Record<ApplicationBatchItemStatus, number>
  items: ApplicationBatchItem[]
  createdAt: string
  updatedAt: string
  lastEventSequence: number
  recoveryCount: number
}

export type ApplicationBatchRequest = {
  noteIds: string[]
  confirmedNoteIds?: string[]
  contactApprovals?: Array<{ noteId: string; evidenceHash: string; confirmed: true }>
  defaultAttachmentTemplate?: string
  minIntervalMs?: number
  aiSessionId?: string
  title?: string
  preflightId?: string
  manifestHash?: string
  selectionSnapshotId?: string
  selectionSnapshotHash?: string
  selectionRevisions?: Array<{ noteId: string; revision: string }>
  idempotencyKey?: string
}

export type ApplicationBatchCreateResponse = {
  schemaVersion: number
  batch: ApplicationBatch
  preflight: ApplicationBatchPreflight | null
  idempotentReplay?: boolean
}

export type ApplicationBatchStreamEvent = {
  type: 'snapshot' | 'batch' | 'error'
  sequence?: number
  throughSequence?: number
  batch?: ApplicationBatch
  batchId?: string
  event?: { sequence: number; type: string; batchRevision: number; at: string; [key: string]: unknown }
  error?: { code: string; message: string }
}

export type JobEvent = {
  type: 'snapshot' | 'status' | 'log' | 'artifacts' | 'done' | 'error' | 'workflow' | 'problem' | 'heartbeat'
  sequence?: number
  revision?: number
  eventId?: string
  occurredAt?: string
  job?: Job
  line?: string
  level?: 'info' | 'warn' | 'error' | 'success'
  artifacts?: Artifact[]
  message?: string
  workflowEvent?: WorkflowEventV1
  experienceSnapshot?: WorkflowSnapshotV3
  problem?: UserProblem
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
