import type {
  AnalysisMode,
  Job,
  UserProblem,
  WorkflowConnectionState,
  WorkflowSnapshotV3,
  WorkflowStageState,
} from './types'

export type JourneyStageView = {
  id: string
  label: string
  detail: string
  state: WorkflowStageState
  done: number
  total: number | null
}

export type JobExperienceView = {
  headline: string
  detail: string
  stages: JourneyStageView[]
  counts: {
    discovered: number
    fullText: number
    resultReady: number
    pending: number
    retryable: number
    unavailable: number
  }
  speed: {
    activePerMinute: number | null
    cacheHits: number
    networkSuccess: number
    etaMinSeconds: number | null
    etaMaxSeconds: number | null
    confidence: string
  }
  coveragePercent: number | null
  coverageDeterminate: boolean
  issues: UserProblem[]
  checkpoint: {
    revision: number
    savedAt: string | null
    resumeAvailable: boolean
  }
  connection: {
    state: WorkflowConnectionState
    lastEventAt: string | null
  }
  throughSequence: number
}

export type SupportedProblemActionId = 'open_login' | 'check_recovery' | 'resume' | 'refresh_security'

const PROBLEM_ACTION_ALIASES: Record<string, SupportedProblemActionId> = {
  open_login: 'open_login',
  open_verification: 'open_login',
  check_recovery: 'check_recovery',
  probe_rate_limit: 'check_recovery',
  resume: 'resume',
  resume_job: 'resume',
  refresh_security: 'refresh_security',
}

export function normalizeProblemActionId(actionId: unknown): SupportedProblemActionId | null {
  if (typeof actionId !== 'string') return null
  return PROBLEM_ACTION_ALIASES[actionId.trim().toLowerCase()] ?? null
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'resuming', 'running'])

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegative(value: unknown) {
  return Math.max(0, finiteNumber(value))
}

function stageState(value: unknown): WorkflowStageState {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'not_started' || normalized === 'idle' || normalized === 'pending') return 'queued'
  if (normalized === 'blocked' || normalized === 'waiting') return 'waiting_system'
  if (normalized === 'succeeded' || normalized === 'complete') return 'completed'
  if (normalized === 'interrupted') return 'partial'
  if (['queued', 'running', 'waiting_system', 'waiting_user', 'retrying', 'partial', 'completed', 'failed', 'cancelled'].includes(normalized)) {
    return normalized as WorkflowStageState
  }
  return 'queued'
}

function normalizedStageId(value: unknown) {
  const stage = String(value || '').trim()
  if (stage === 'bodyCompletion' || stage === 'body_completion') return 'body'
  if (stage === 'analysis') return 'analysis'
  if (stage === 'artifacts') return 'artifact'
  return stage
}

function stageLabel(stage: string, mode: AnalysisMode, maxAgeDays: number) {
  const age = maxAgeDays > 0 ? `近 ${maxAgeDays} 天` : ''
  const jobLabels: Record<string, string> = {
    preflight: '准备采集环境',
    discovery: `查找${age}相关内容`,
    body: '获取完整岗位详情',
    classify: '区分招聘信息和经验分享',
    extract: '提取职责、要求和投递入口',
    match: '匹配你的经历',
    draft: '准备求职沟通材料',
    quality: '检查是否可用于投递',
    analysis: '整理岗位与求职材料',
    audience: '分析评论和相关人群',
    artifact: '整理页面结果和下载文件',
    delivery: '发送已确认的材料',
  }
  const generalLabels: Record<string, string> = {
    preflight: '准备采集环境',
    discovery: `查找${age}相关内容`,
    body: '获取完整正文',
    classify: '整理内容类型',
    extract: '提取主题与观点',
    match: '生成内容洞察',
    draft: '生成内容摘要',
    quality: '检查结果质量',
    analysis: '整理内容与洞察',
    audience: '分析评论和相关人群',
    artifact: '整理页面结果和下载文件',
    delivery: '完成后续操作',
  }
  return (mode === 'job' ? jobLabels : generalLabels)[stage] || '处理当前内容'
}

function stageDetail(state: WorkflowStageState, done: number, total: number | null) {
  if (total !== null && total > 0) return `已完成 ${Math.min(done, total)} / ${total}`
  if (done > 0) return `已完成 ${done} 项`
  const labels: Record<WorkflowStageState, string> = {
    queued: '等待前一步完成',
    running: '正在处理，完成一项就会保存一项',
    waiting_system: '系统正在等待合适的恢复时机',
    waiting_user: '需要你完成页面操作后继续',
    retrying: '正在重试当前步骤',
    partial: '已保存部分结果，可从剩余内容继续',
    completed: '已完成并保存',
    failed: '当前步骤没有完成',
    cancelled: '已停止，完成内容仍保留',
  }
  return labels[state]
}

function snapshotCandidate(value: unknown): WorkflowSnapshotV3 | null {
  const snapshot = objectValue(value)
  if (!snapshot || !Array.isArray(snapshot.stages) || !objectValue(snapshot.counts) || !objectValue(snapshot.speed)) return null
  return snapshot as unknown as WorkflowSnapshotV3
}

export function experienceSnapshotForJob(job: Job | null | undefined): WorkflowSnapshotV3 | null {
  if (!job) return null
  const summary = objectValue(job.workflowSummary)
  return snapshotCandidate(job.experienceSnapshot)
    || snapshotCandidate(job.workflowSnapshot)
    || snapshotCandidate(summary?.experienceSnapshot)
    || snapshotCandidate(summary?.experience)
}

function stagesFromSnapshot(snapshot: WorkflowSnapshotV3, mode: AnalysisMode, maxAgeDays: number) {
  return snapshot.stages.map((source) => {
    const raw = objectValue(source) || {}
    const id = normalizedStageId(raw.stage ?? raw.id ?? raw.name)
    const progress = objectValue(raw.progress) || {}
    const done = nonNegative(progress.done ?? progress.completed)
    const totalValue = nullableNumber(progress.total)
    const total = totalValue === null ? null : Math.max(0, totalValue)
    const state = stageState(raw.state ?? raw.status)
    return {
      id,
      label: String(raw.headline || stageLabel(id, mode, maxAgeDays)),
      detail: String(raw.detail || stageDetail(state, done, total)),
      state,
      done,
      total,
    }
  }).filter((stage) => stage.id)
}

function legacyStage(job: Job, id: string, mode: AnalysisMode, maxAgeDays: number): JourneyStageView {
  const sourceName = id === 'body' ? 'bodyCompletion' : id === 'artifact' ? 'artifacts' : id
  const source = objectValue(job.stages?.[sourceName]) || {}
  const state = stageState(source.status)
  const done = nonNegative(
    source.completedCount ?? source.succeededCount ?? source.discoveredCount
      ?? (id === 'artifact' ? (Array.isArray(source.generatedFiles) ? source.generatedFiles.length : 0) : 0),
  )
  const totalValue = nullableNumber(source.totalCount)
  const total = totalValue === null || totalValue <= 0 ? null : totalValue
  return {
    id,
    label: stageLabel(id, mode, maxAgeDays),
    detail: stageDetail(state, done, total),
    state,
    done,
    total,
  }
}

function activeStageFromPhase(phase: string) {
  if (/discover|sort|filter|start|queue/.test(phase)) return 'discovery'
  if (/scrap|body|rate|security|cache/.test(phase)) return 'body'
  if (/analy|class|extract|match|draft|quality/.test(phase)) return 'analysis'
  if (/export|artifact/.test(phase)) return 'artifact'
  return ''
}

function legacyStages(job: Job, mode: AnalysisMode, maxAgeDays: number) {
  const stages = ['preflight', 'discovery', 'body', 'analysis', 'artifact'].map((id) => (
    id === 'preflight'
      ? {
          id,
          label: stageLabel(id, mode, maxAgeDays),
          detail: job.status === 'queued' ? '正在检查任务配置' : '启动条件已检查',
          state: (job.status === 'queued' ? 'running' : 'completed') as WorkflowStageState,
          done: job.status === 'queued' ? 0 : 1,
          total: 1,
        }
      : legacyStage(job, id, mode, maxAgeDays)
  ))
  const phaseStage = activeStageFromPhase(String(job.progressPhase || '').toLowerCase())
  const hasAuthoritativeActiveStage = stages.some((stage) => ['running', 'waiting_system', 'waiting_user', 'retrying'].includes(stage.state))
  if (ACTIVE_JOB_STATUSES.has(job.status) && phaseStage && !hasAuthoritativeActiveStage) {
    const target = stages.find((stage) => stage.id === phaseStage)
    if (target && target.state !== 'completed') {
      target.state = /security/.test(String(job.progressPhase)) ? 'waiting_user'
        : /rate/.test(String(job.progressPhase)) ? 'waiting_system'
          : 'running'
      target.detail = stageDetail(target.state, target.done, target.total)
    }
  }
  if (job.status === 'completed') {
    for (const stage of stages) {
      if (stage.state === 'queued') {
        stage.state = 'completed'
        stage.detail = stageDetail('completed', stage.done, stage.total)
      }
    }
  }
  return stages
}

function userProblem(params: Partial<UserProblem> & Pick<UserProblem, 'code' | 'userTitle' | 'userMessage'>): UserProblem {
  return {
    category: 'unknown',
    severity: 'warning',
    preservedResultCount: 0,
    automaticAction: null,
    retryable: false,
    retryAt: null,
    requiresUserAction: false,
    action: null,
    affectedStage: 'body',
    technicalRef: params.code,
    ...params,
  }
}

function legacyIssues(job: Job, saved: number, total: number): UserProblem[] {
  const savedText = total > 0 ? `${saved}/${total}` : String(saved)
  const bodyComplete = total > 0 && saved >= total
  if (!bodyComplete && job.securityRestriction?.detected && job.securityRestriction.status !== 'cleared') {
    return [userProblem({
      code: 'SECURITY_VERIFICATION',
      category: 'access',
      severity: 'blocking',
      userTitle: '需要完成页面验证',
      userMessage: `已保存 ${savedText} 篇；完成验证后会从剩余内容继续。`,
      preservedResultCount: saved,
      automaticAction: '完成验证后从检查点继续',
      retryable: true,
      requiresUserAction: true,
      action: { id: 'open_login', label: '打开验证页面' },
      technicalRef: `security:${job.securityRestriction.status}`,
    })]
  }
  if (!bodyComplete && job.rateLimit?.detected && job.rateLimit.status !== 'cleared') {
    const retryAt = job.rateLimit.nextRetryAt || null
    return [userProblem({
      code: 'RATE_LIMITED',
      category: 'access',
      severity: 'warning',
      userTitle: '平台暂时限制访问',
      userMessage: retryAt
        ? `已保存 ${savedText} 篇，系统会在安排的时间检查是否恢复。`
        : `已保存 ${savedText} 篇，系统已暂停新的访问，现有结果不会丢失。`,
      preservedResultCount: saved,
      automaticAction: retryAt ? '等待后自动进行一次恢复检查' : '保留检查点并停止重复请求',
      retryable: true,
      retryAt,
      action: { id: 'check_recovery', label: '立即检查是否恢复' },
      technicalRef: `rate-limit:${job.rateLimit.status}`,
    })]
  }
  if (job.status === 'failed') {
    return [userProblem({
      code: 'UNKNOWN_ERROR',
      severity: 'blocking',
      userTitle: '当前步骤没有完成',
      userMessage: `已保存 ${savedText} 篇，完成内容和进度仍然保留。`,
      preservedResultCount: saved,
      retryable: Boolean(job.resumeAvailable),
      requiresUserAction: Boolean(job.resumeAvailable),
      action: job.resumeAvailable ? { id: 'resume', label: '重试当前步骤' } : null,
      technicalRef: `job:${job.id}`,
    })]
  }
  if (['incomplete', 'interrupted', 'cancelled', 'blocked'].includes(job.status)) {
    return [userProblem({
      code: job.status === 'incomplete' ? 'PARTIAL_RESULT' : 'PROCESS_INTERRUPTED',
      severity: 'warning',
      userTitle: job.status === 'incomplete' ? '还有内容待完成' : '任务已停止',
      userMessage: `已保存 ${savedText} 篇；继续时会跳过已完成内容。`,
      preservedResultCount: saved,
      retryable: Boolean(job.resumeAvailable),
      action: job.resumeAvailable ? { id: 'resume', label: '继续任务' } : null,
      technicalRef: `job:${job.id}:${job.status}`,
    })]
  }
  return []
}

function latestCheckpointAt(job: Job) {
  const candidates = [job.progressUpdatedAt, job.updatedAt]
  for (const value of Object.values(job.stages || {})) {
    const stage = objectValue(value)
    if (typeof stage?.lastCheckpointAt === 'string') candidates.push(stage.lastCheckpointAt)
  }
  return candidates.filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null
}

export function jobExperienceView(
  job: Job,
  mode: AnalysisMode,
  connectionState: WorkflowConnectionState,
  lastEventAt: string | null,
): JobExperienceView {
  const snapshot = experienceSnapshotForJob(job)
  const maxAgeDays = Math.max(0, finiteNumber(job.config?.maxAgeDays))
  const stages = snapshot
    ? stagesFromSnapshot(snapshot, mode, maxAgeDays)
    : legacyStages(job, mode, maxAgeDays)
  const body = job.bodyMetrics
  const snapshotCounts = snapshot?.counts
  // A persisted body ledger is newer than any resumable experience snapshot.
  const discovered = nonNegative(body?.discovered ?? snapshotCounts?.discovered ?? job.discoveredCount)
  const fullText = nonNegative(body?.succeeded ?? snapshotCounts?.fullText ?? job.scrapedCount)
  const resultReady = nonNegative(
    mode === 'job'
      ? snapshotCounts?.applicationReady ?? snapshotCounts?.confirmedJobs ?? job.applicationCount
      : snapshotCounts?.applicationReady ?? job.applicationCount,
  )
  const pending = nonNegative(
    body
      ? body.failed + body.notAttempted + body.blocked + body.cancelled + body.pending
      : snapshotCounts?.pending ?? Math.max(0, discovered - fullText),
  )
  const bodyComplete = discovered > 0 && fullText >= discovered && pending === 0
  const retryable = bodyComplete ? 0 : nonNegative(snapshotCounts?.retryable)
  const unavailable = nonNegative(snapshotCounts?.unavailable ?? body?.failed)
  const discovery = stages.find((stage) => stage.id === 'discovery')
  const stableTotal = snapshot?.journey === 'body_import'
    || job.config?.bodyOnly === true
    || ['completed', 'partial', 'failed', 'cancelled'].includes(discovery?.state || '')
    || !ACTIVE_JOB_STATUSES.has(job.status)
  const coveragePercent = discovered > 0 ? Math.min(100, Math.round((fullText / discovered) * 1000) / 10) : null
  const rawSnapshotIssues = Array.isArray(snapshot?.issues) ? snapshot.issues : []
  const snapshotIssues = bodyComplete
    ? rawSnapshotIssues.filter((issue) => !(
        issue.affectedStage === 'body'
        && ['RATE_LIMITED', 'SECURITY_VERIFICATION'].includes(issue.code)
      ))
    : rawSnapshotIssues
  const waitingForAccess = !bodyComplete && (
    Boolean(job.rateLimit?.detected && job.rateLimit.status !== 'cleared')
    || Boolean(job.securityRestriction?.detected && job.securityRestriction.status !== 'cleared')
    || snapshotIssues.some((issue) => ['RATE_LIMITED', 'SECURITY_VERIFICATION', 'LOGIN_REQUIRED'].includes(issue.code))
  )
  const normalizedStages = stages.map((stage) => {
    if (stage.id !== 'body' || discovered <= 0) return stage
    const done = Math.min(fullText, discovered)
    const total = discovered
    const state = waitingForAccess && done < total
      ? 'waiting_system' as WorkflowStageState
      : done >= total
        ? 'completed' as WorkflowStageState
        : stage.state
    return {
      ...stage,
      state,
      done,
      total,
      detail: stageDetail(state, done, total),
    }
  })
  const snapshotSpeed = snapshot?.speed
  const activeStage = normalizedStages.find((stage) => ['running', 'waiting_system', 'waiting_user', 'retrying'].includes(stage.state))
    || normalizedStages.find((stage) => stage.state === 'partial')
  const staleBodyAccessHeadline = bodyComplete && rawSnapshotIssues.some((issue) => (
    issue.affectedStage === 'body'
    && ['RATE_LIMITED', 'SECURITY_VERIFICATION'].includes(issue.code)
    && issue.userTitle === snapshot?.headline?.trim()
  ))
  const qualityNeedsReview = String(job.workflowSummary?.status || '') === 'failed'
    || normalizedStages.some((stage) => stage.id === 'quality' && ['partial', 'failed'].includes(stage.state))
  const headline = staleBodyAccessHeadline
    ? qualityNeedsReview ? '正文采集已完成，求职材料仍需检查' : '正文采集已完成'
    : snapshot?.headline?.trim()
    || (activeStage ? `正在${activeStage.label}`
      : job.status === 'completed' ? '任务结果已准备好'
        : job.status === 'failed' ? '当前步骤没有完成'
          : ['incomplete', 'interrupted', 'cancelled', 'blocked'].includes(job.status) ? '本轮结果已保存'
            : '任务正在准备中')
  const detail = discovered > 0
    ? `已找到 ${discovered} 条，完整正文 ${fullText} 条，待处理 ${pending} 条`
    : snapshot?.detail?.trim()
      || activeStage?.detail
      || '有新结果时会在这里更新。'
  const checkpoint = snapshot?.checkpoint
  return {
    headline,
    detail,
    stages: normalizedStages,
    counts: { discovered, fullText, resultReady, pending, retryable, unavailable },
    speed: {
      activePerMinute: nullableNumber(snapshotSpeed?.activePerMinute),
      cacheHits: nonNegative(snapshotSpeed?.cacheHits),
      networkSuccess: nonNegative(snapshotSpeed?.networkSuccess),
      etaMinSeconds: waitingForAccess ? null : nullableNumber(snapshotSpeed?.etaMinSeconds),
      etaMaxSeconds: waitingForAccess ? null : nullableNumber(snapshotSpeed?.etaMaxSeconds),
      confidence: String(snapshotSpeed?.confidence || 'low'),
    },
    coveragePercent,
    coverageDeterminate: Boolean(stableTotal && coveragePercent !== null),
    issues: snapshotIssues.length ? snapshotIssues : legacyIssues(job, fullText, discovered),
    checkpoint: {
      revision: Math.max(0, finiteNumber(checkpoint?.revision ?? job.revision)),
      savedAt: checkpoint?.savedAt || latestCheckpointAt(job),
      resumeAvailable: Boolean(checkpoint?.resumeAvailable ?? job.resumeAvailable),
    },
    connection: {
      state: connectionState,
      lastEventAt: lastEventAt || snapshot?.connection?.lastEventAt || job.progressUpdatedAt || null,
    },
    throughSequence: Math.max(0, finiteNumber(snapshot?.throughSequence)),
  }
}
