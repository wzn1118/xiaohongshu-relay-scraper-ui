import { useState } from 'react'
import {
  Activity,
  Check,
  CircleAlert,
  CircleDashed,
  Clock3,
  LoaderCircle,
  Pause,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { jobExperienceView, normalizeProblemActionId } from './job-experience'
import type { SupportedProblemActionId } from './job-experience'
import type { AnalysisMode, Job, UserProblem, WorkflowConnectionState, WorkflowStageState } from './types'
import './JobJourneyPanel.css'

type JobJourneyPanelProps = {
  job: Job
  mode: AnalysisMode
  connectionState: WorkflowConnectionState
  lastEventAt: string | null
  now: Date
  actionBusy?: boolean
  onResume?: () => Promise<Job | null | void> | Job | null | void
  resumeDisabled?: boolean
  onProblemAction?: (problem: UserProblem, actionId: SupportedProblemActionId) => void
  isProblemActionDisabled?: (problem: UserProblem, actionId: SupportedProblemActionId) => boolean
}

type JourneyDisplayState = 'queued' | 'running' | 'retrying' | 'stale' | 'blocked' | 'partial' | 'failed' | 'completed'

const stageStateCopy: Record<WorkflowStageState, string> = {
  queued: '尚未开始',
  running: '正在处理',
  waiting_system: '等待恢复',
  waiting_user: '等待操作',
  retrying: '正在重试',
  partial: '部分完成',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
}

const displayStateCopy: Record<JourneyDisplayState, { label: string; detail: string }> = {
  queued: { label: '等待开始', detail: '任务已进入队列，开始后会逐项保存进度。' },
  running: { label: '正在运行', detail: '无需操作，系统会继续处理并保存每项结果。' },
  retrying: { label: '正在重试', detail: '系统正在重试当前步骤，不会重复处理已完成内容。' },
  stale: { label: '连接待恢复', detail: '保持页面打开；连接恢复后会同步最新保存状态。' },
  blocked: { label: '需要处理', detail: '先完成下方唯一建议操作，任务即可继续。' },
  partial: { label: '部分完成', detail: '已完成内容仍然保留，可按下方建议继续。' },
  failed: { label: '运行失败', detail: '已保存的结果仍可查看，请按下方建议处理。' },
  completed: { label: '已完成', detail: '当前范围已经处理完，可以查看下方结果。' },
}

function StageIcon({ state }: { state: WorkflowStageState }) {
  if (state === 'completed') return <Check aria-hidden="true" size={15} />
  if (state === 'running' || state === 'retrying') return <LoaderCircle aria-hidden="true" className="spin" size={15} />
  if (state === 'waiting_system' || state === 'partial') return <Pause aria-hidden="true" size={14} />
  if (state === 'waiting_user' || state === 'failed') return <CircleAlert aria-hidden="true" size={15} />
  if (state === 'cancelled') return <Clock3 aria-hidden="true" size={14} />
  return <CircleDashed aria-hidden="true" size={14} />
}

function DisplayStateIcon({ state }: { state: JourneyDisplayState }) {
  if (state === 'completed') return <Check aria-hidden="true" size={19} />
  if (state === 'retrying') return <RefreshCw aria-hidden="true" className="spin" size={19} />
  if (state === 'stale') return <WifiOff aria-hidden="true" size={19} />
  if (state === 'blocked' || state === 'failed') return <CircleAlert aria-hidden="true" size={19} />
  if (state === 'partial') return <Pause aria-hidden="true" size={18} />
  if (state === 'queued') return <Clock3 aria-hidden="true" size={18} />
  return <Activity aria-hidden="true" size={19} />
}

function relativeTime(value: string | null, now: Date) {
  if (!value) return '刚刚'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return '刚刚'
  const seconds = Math.max(0, Math.round((now.getTime() - timestamp) / 1000))
  if (seconds < 60) return `${seconds || 1} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function dateTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function connectionCopy(state: WorkflowConnectionState, active: boolean, lastEventAt: string | null, now: Date) {
  const lastUpdate = lastEventAt ? `最后更新 ${relativeTime(lastEventAt, now)}` : '等待首次进度更新'
  if (!active) return { text: '状态已保存', detail: lastUpdate, icon: Check, tone: 'saved' }
  if (state === 'live') return { text: '进度实时同步', detail: lastUpdate, icon: Wifi, tone: 'live' }
  if (state === 'reconnecting') return { text: '正在重新连接进度', detail: `${lastUpdate}，已保存结果不会丢失`, icon: RefreshCw, tone: 'reconnecting' }
  if (state === 'stale') return { text: '进度更新稍慢', detail: `${lastUpdate}，正在获取最新保存状态`, icon: RefreshCw, tone: 'stale' }
  return { text: '暂时离线', detail: `${lastUpdate}，恢复连接后会继续同步`, icon: WifiOff, tone: 'offline' }
}

function etaCopy(minSeconds: number | null, maxSeconds: number | null) {
  if (minSeconds === null || maxSeconds === null || minSeconds < 0 || maxSeconds < 0) return null
  const minMinutes = Math.max(1, Math.ceil(Math.min(minSeconds, maxSeconds) / 60))
  const maxMinutes = Math.max(minMinutes, Math.ceil(Math.max(minSeconds, maxSeconds) / 60))
  return minMinutes === maxMinutes ? `预计还需约 ${minMinutes} 分钟` : `预计还需 ${minMinutes}-${maxMinutes} 分钟`
}

function containsUnknownCopy(value: unknown) {
  return /未识别|未知|unknown/i.test(String(value || ''))
}

function normalizedStageId(value: unknown) {
  const stage = String(value || '').trim()
  if (stage === 'bodyCompletion' || stage === 'body_completion') return 'body'
  if (stage === 'artifacts') return 'artifact'
  return stage
}

function issuePriority(problem: UserProblem) {
  if (problem.severity === 'blocking' && problem.requiresUserAction) return 0
  if (problem.severity === 'blocking') return 1
  if (problem.requiresUserAction) return 2
  if (problem.severity === 'warning') return 3
  return 4
}

function displayStateFor(
  job: Job,
  connectionState: WorkflowConnectionState,
  issues: UserProblem[],
  stages: ReturnType<typeof jobExperienceView>['stages'],
): JourneyDisplayState {
  const active = ['queued', 'resuming', 'running'].includes(job.status)
  if (job.status === 'completed') return 'completed'
  if (job.status === 'failed') return 'failed'
  if (job.status === 'blocked' || stages.some((stage) => stage.state === 'waiting_user') || issues.some((issue) => issue.severity === 'blocking' && issue.requiresUserAction)) return 'blocked'
  if (job.status === 'resuming' || stages.some((stage) => stage.state === 'retrying')) return 'retrying'
  if (active && connectionState !== 'live') return 'stale'
  if (['incomplete', 'interrupted', 'cancelled'].includes(job.status) || stages.some((stage) => stage.state === 'partial')) return 'partial'
  if (job.status === 'queued') return 'queued'
  return 'running'
}

function safeProblemCopy(problem: UserProblem, savedResultCount: number, resumeAvailable: boolean) {
  const unknownProblem = problem.code === 'UNKNOWN_ERROR'
    || containsUnknownCopy(problem.userTitle)
    || containsUnknownCopy(problem.userMessage)
  if (!unknownProblem) return { title: problem.userTitle, message: problem.userMessage }
  return {
    title: '当前步骤需要重新检查',
    message: resumeAvailable
      ? `系统暂时没有返回可读的原因；已保存 ${Math.max(problem.preservedResultCount || 0, savedResultCount)} 条结果，可从检查点继续。`
      : `系统暂时没有返回可读的原因；已保存 ${Math.max(problem.preservedResultCount || 0, savedResultCount)} 条结果。当前没有可用检查点，请查看技术详情后重新创建任务。`,
  }
}

export function JobJourneyPanel({
  job,
  mode,
  connectionState,
  lastEventAt,
  now,
  actionBusy = false,
  onResume,
  resumeDisabled = false,
  onProblemAction,
  isProblemActionDisabled,
}: JobJourneyPanelProps) {
  const [resumeFeedback, setResumeFeedback] = useState<{ tone: 'progress' | 'success' | 'error'; text: string } | null>(null)
  const view = jobExperienceView(job, mode, connectionState, lastEventAt)
  const active = ['queued', 'resuming', 'running'].includes(job.status)
  const connection = connectionCopy(view.connection.state, active, view.connection.lastEventAt, now)
  const ConnectionIcon = connection.icon
  const visibleIssues = view.issues
    .filter((issue) => issue.severity !== 'info' || issue.requiresUserAction)
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => issuePriority(left.issue) - issuePriority(right.issue) || left.index - right.index)
    .map(({ issue }) => issue)
  const primaryIssue = visibleIssues[0] || null
  const resultLabel = mode === 'job' ? '可查看岗位' : '已整理结果'
  const savedResultCount = Math.max(view.counts.fullText, view.counts.resultReady)
  const resumeAvailable = Boolean(view.checkpoint.resumeAvailable && job.resumeAvailable !== false)
  const currentWorkNeedsReview = containsUnknownCopy(view.headline) || containsUnknownCopy(view.detail)
  const currentHeadline = currentWorkNeedsReview ? '当前步骤需要重新检查' : view.headline
  const currentDetail = currentWorkNeedsReview
    ? resumeAvailable
      ? `系统暂时没有返回可读的原因；已保存 ${savedResultCount} 条结果，可从检查点继续。`
      : `系统暂时没有返回可读的原因；已保存 ${savedResultCount} 条结果。当前没有可用检查点，请查看技术详情后重新创建任务。`
    : view.detail
  const canResume = !active
    && resumeAvailable
    && ['incomplete', 'interrupted', 'cancelled', 'blocked', 'failed'].includes(job.status)
    && Boolean(onResume)
  const remainingStages = view.stages.filter((stage) => !['completed', 'cancelled'].includes(stage.state))
  const remainingStageSummary = remainingStages.length > 0
    ? `${view.counts.discovered > 0 && view.counts.fullText >= view.counts.discovered ? '正文采集已完成；' : ''}待恢复：${remainingStages.slice(0, 3).map((stage) => stage.label).join('、')}${remainingStages.length > 3 ? `等 ${remainingStages.length} 项` : ''}`
    : ''
  const currentStage = view.stages.find((stage) => ['running', 'retrying', 'waiting_user', 'waiting_system'].includes(stage.state))
    || view.stages.find((stage) => stage.id === normalizedStageId(primaryIssue?.affectedStage))
    || view.stages.find((stage) => stage.state === 'failed')
    || view.stages.find((stage) => stage.state === 'partial')
    || [...view.stages].reverse().find((stage) => stage.state === 'completed')
    || view.stages[0]
  const displayState = displayStateFor(job, view.connection.state, visibleIssues, view.stages)
  const displayCopy = displayStateCopy[displayState]
  const displayLabel = displayState === 'partial' && job.status === 'cancelled'
    ? '已停止'
    : displayState === 'partial' && job.status === 'interrupted'
      ? '已中断'
      : displayCopy.label
  const primaryProblemCopy = primaryIssue ? safeProblemCopy(primaryIssue, savedResultCount, resumeAvailable) : null
  const actionableProblem = displayState === 'retrying'
    ? null
    : visibleIssues.find((problem) => {
    const actionId = normalizeProblemActionId(problem.action?.id)
    return Boolean(actionId && actionId !== 'resume' && onProblemAction)
      }) || null
  const actionableProblemId = actionableProblem ? normalizeProblemActionId(actionableProblem.action?.id) : null
  const recommendationTitle = displayState === 'retrying'
    ? '系统正在恢复当前步骤'
    : primaryProblemCopy?.title || (displayState === 'completed'
    ? '查看已整理结果'
    : displayState === 'failed' && !canResume
      ? '查看技术详情并重新创建任务'
      : displayCopy.label)
  const recommendationDetail = displayState === 'retrying'
    ? primaryProblemCopy ? `无需操作。${primaryProblemCopy.message}` : displayCopy.detail
    : primaryProblemCopy?.message || (canResume && remainingStageSummary
      ? remainingStageSummary
      : displayCopy.detail)
  const recommendationLabel = actionableProblemId === 'check_recovery'
    ? '立即检查是否恢复'
    : actionableProblem?.action?.label
  const actionDisabled = actionableProblem && actionableProblemId
    ? actionBusy || Boolean(isProblemActionDisabled?.(actionableProblem, actionableProblemId))
    : actionBusy || resumeDisabled
  const remainingCopy = view.counts.pending > 0
    ? `${view.counts.pending} 条待处理`
    : active && !view.coverageDeterminate
      ? '范围仍在扩展'
      : '当前范围已处理完'
  const eta = active && view.counts.pending > 0
    ? etaCopy(view.speed.etaMinSeconds, view.speed.etaMaxSeconds)
    : null
  const checkpointCopy = view.checkpoint.savedAt
    ? `进度已保存 · ${relativeTime(view.checkpoint.savedAt, now)}`
    : active
      ? '正在建立首个检查点'
      : '本任务没有可用检查点'
  const recommendationKind = displayState === 'retrying'
    ? 'retrying'
    : primaryIssue?.severity === 'blocking'
    ? 'blocking'
    : primaryIssue
      ? 'warning'
      : displayState

  const qualityChecks = job.workflowSummary?.checks as Record<string, unknown> | undefined
  const qualityRepair = qualityChecks?.all_outreach_drafts_ready === false
    || qualityChecks?.all_cover_letters_score_at_least_threshold === false
    || qualityChecks?.all_generated_claims_evidence_valid === false
  const resumeLabel = qualityRepair ? '重新生成未达标草稿' : '一键恢复未完成步骤'
  const handleResume = async () => {
    if (!onResume || actionBusy || resumeDisabled) return
    setResumeFeedback({
      tone: 'progress',
      text: qualityRepair ? '正在提交草稿重写与质量复核…' : '正在提交恢复请求…',
    })
    try {
      const resumed = await onResume()
      if (!resumed) {
        setResumeFeedback({ tone: 'error', text: '恢复未能启动。请查看页面顶部的错误信息后重试。' })
        return
      }
      const running = ['queued', 'resuming', 'running'].includes(resumed.status)
      setResumeFeedback({
        tone: running ? 'success' : 'progress',
        text: running
          ? qualityRepair ? '已开始重写未达标草稿，完成后会自动复核。' : '恢复已启动，正在从保存的进度继续。'
          : '恢复请求已处理，正在同步任务状态。',
      })
    } catch (error) {
      setResumeFeedback({ tone: 'error', text: (error as Error).message || '恢复请求失败，请重试。' })
    }
  }

  const runRecommendedAction = () => {
    if (actionableProblem && actionableProblemId && onProblemAction) {
      onProblemAction(actionableProblem, actionableProblemId)
      return
    }
    void handleResume()
  }

  return (
    <div className={`job-journey-panel journey-console journey-state-${displayState}`} data-state={displayState} aria-busy={actionBusy}>
      <section className="journey-current-work journey-command-band" aria-labelledby="journey-current-heading">
        <div className="journey-current-heading">
          <span className="journey-current-icon"><DisplayStateIcon state={displayState} /></span>
          <div className="journey-live-summary" role="status" aria-live="polite" aria-atomic="true">
            <div className="journey-status-meta">
              <span className="journey-state-badge">{displayLabel}</span>
              <span className="journey-current-stage">当前阶段 · {currentStage?.label || '准备任务'}</span>
            </div>
            <h3 id="journey-current-heading">{currentHeadline}</h3>
            <p>{currentDetail}</p>
          </div>
        </div>

        <div className="journey-signal-stack" aria-label="连接与检查点状态">
          <div className={`journey-connection ${connection.tone}`} role="status" aria-live="polite" aria-atomic="true">
            <ConnectionIcon className={view.connection.state === 'reconnecting' || view.connection.state === 'stale' ? 'spin' : ''} aria-hidden="true" size={16} />
            <span><strong>{connection.text}</strong><small>{connection.detail}</small></span>
          </div>
          <p className={`journey-checkpoint ${resumeAvailable ? 'resumable' : ''}`}>
            <Check aria-hidden="true" size={14} />
            <span><strong>{checkpointCopy}</strong><small>{resumeAvailable ? '可从剩余内容继续' : active ? '完成一项即保存一项' : '可查看已保留结果'}</small></span>
          </p>
        </div>
      </section>

      <section className="journey-coverage" aria-labelledby="journey-coverage-heading">
        <div className="journey-section-heading">
          <div>
            <span className="journey-eyebrow">正文完成情况</span>
            <h3 id="journey-coverage-heading">
              {view.counts.discovered > 0
                ? `已获取 ${view.counts.fullText} / ${view.counts.discovered} 篇完整正文`
                : '正在扩大搜索范围'}
            </h3>
          </div>
          <span className="journey-remaining"><small>剩余范围</small><strong>{remainingCopy}</strong></span>
          {view.coverageDeterminate && view.coveragePercent !== null && <strong className="journey-percent">{view.coveragePercent}%</strong>}
        </div>
        <div
          className={`journey-progress-track ${view.coverageDeterminate ? '' : 'indeterminate'}`}
          role="progressbar"
          aria-label="完整正文采集进度"
          aria-valuemin={view.coverageDeterminate ? 0 : undefined}
          aria-valuemax={view.coverageDeterminate ? 100 : undefined}
          aria-valuenow={view.coverageDeterminate && view.coveragePercent !== null ? Math.round(view.coveragePercent) : undefined}
          aria-valuetext={view.coverageDeterminate && view.coveragePercent !== null
            ? `已获取 ${view.counts.fullText} 篇，共发现 ${view.counts.discovered} 篇，剩余 ${view.counts.pending} 篇`
            : '正在发现更多内容，当前不显示固定百分比'}
        >
          <i style={view.coverageDeterminate && view.coveragePercent !== null ? { width: `${view.coveragePercent}%` } : undefined} />
        </div>
        {!view.coverageDeterminate && <p className="journey-progress-explanation">发现范围还在增长，待数量稳定后再显示百分比，避免给出误导性进度。</p>}
      </section>

      <section className="journey-results" aria-label="已完成量、剩余范围与处理速度">
        <div className="journey-counts">
          <div><span>已发现</span><strong>{view.counts.discovered}</strong><small>条相关内容</small></div>
          <div><span>完整正文</span><strong>{view.counts.fullText}</strong><small>已完成并保存</small></div>
          <div><span>{resultLabel}</span><strong>{view.counts.resultReady}</strong><small>{mode === 'job' ? '已有求职信息' : '已有结构化内容'}</small></div>
          <div><span>待处理</span><strong>{view.counts.pending}</strong><small>{view.counts.retryable > 0 ? `${view.counts.retryable} 条可继续` : '随任务继续更新'}</small></div>
        </div>
        <div className="journey-performance">
          <span><Activity aria-hidden="true" size={15} /><strong>{view.speed.activePerMinute !== null ? `${view.speed.activePerMinute.toFixed(1)} 篇/分钟` : '速度统计准备中'}</strong><small>{view.speed.activePerMinute !== null ? '按实际处理时间计算' : '积累足够样本后显示'}</small></span>
          {eta && <span><Clock3 aria-hidden="true" size={15} /><strong>{eta}</strong><small>按最近稳定速度估算</small></span>}
          {view.speed.cacheHits > 0 && <span><Check aria-hidden="true" size={15} /><strong>{view.speed.cacheHits} 篇直接复用</strong><small>无需重复访问页面</small></span>}
        </div>
      </section>

      <section
        className={`journey-recommendation ${recommendationKind}`}
        aria-labelledby="journey-recommendation-heading"
        role={displayState !== 'retrying' && primaryIssue?.severity === 'blocking' ? 'alert' : 'status'}
        aria-live={displayState !== 'retrying' && primaryIssue?.severity === 'blocking' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <span className="journey-recommendation-icon">
          {primaryIssue ? <CircleAlert aria-hidden="true" size={19} /> : displayState === 'completed' ? <Check aria-hidden="true" size={19} /> : <Activity aria-hidden="true" size={19} />}
        </span>
        <div>
          <span className="journey-eyebrow">{displayState === 'retrying' ? '系统正在处理' : primaryIssue?.severity === 'blocking' ? '阻断原因' : primaryIssue ? '需要关注' : '建议下一步'}</span>
          <strong className="journey-recommendation-title" id="journey-recommendation-heading">{recommendationTitle}</strong>
          <p>{recommendationDetail}</p>
          {canResume && remainingStageSummary && <small className="journey-recovery-note">{remainingStageSummary}</small>}
          {resumeFeedback && <p className={`journey-recovery-feedback ${resumeFeedback.tone}`} role={resumeFeedback.tone === 'error' ? 'alert' : 'status'}>
            {resumeFeedback.tone === 'error' ? <CircleAlert size={14} /> : <RefreshCw className={resumeFeedback.tone === 'progress' ? 'spin' : ''} size={14} />}
            {resumeFeedback.text}
          </p>}
          {primaryIssue?.automaticAction && <small>系统处理：{primaryIssue.automaticAction}</small>}
          {primaryIssue?.retryAt && <small>下次自动检查：{dateTime(primaryIssue.retryAt)}（北京时间）</small>}
        </div>
        {(actionableProblemId || canResume) && (
          <button
            type="button"
            className="journey-primary-action"
            onClick={runRecommendedAction}
            disabled={actionDisabled}
            aria-describedby="journey-recommendation-heading"
          >
            <RefreshCw aria-hidden="true" className={actionBusy ? 'spin' : ''} size={16} />
            {actionBusy
              ? '正在处理'
              : actionableProblemId
                ? recommendationLabel
                : resumeLabel}
          </button>
        )}
      </section>

      <section className="journey-path" aria-labelledby="journey-path-heading">
        <div className="journey-section-heading compact">
          <div>
            <span className="journey-eyebrow">完整阶段</span>
            <h3 id="journey-path-heading">{currentStage ? `当前在：${currentStage.label}` : '任务阶段记录'}</h3>
          </div>
          <small>{view.stages.filter((stage) => stage.state === 'completed').length} / {view.stages.length} 个阶段已完成</small>
        </div>
        <ol className="task-journey-list">
          {view.stages.map((stage) => {
            const current = stage.id === currentStage?.id && !['completed', 'cancelled'].includes(stage.state)
            return (
              <li key={stage.id} className={stage.state} aria-current={current ? 'step' : undefined}>
                <span className="task-journey-marker"><StageIcon state={stage.state} /></span>
                <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
                <em>{stageStateCopy[stage.state]}</em>
              </li>
            )
          })}
        </ol>
      </section>

      {visibleIssues.length > 1 && (
        <section className="journey-problems" aria-label="其他需要关注的问题">
          <span className="journey-eyebrow">其他需要关注</span>
          {visibleIssues.slice(1).map((problem) => {
            const copy = safeProblemCopy(problem, savedResultCount, resumeAvailable)
            return (
              <div className={`journey-problem ${problem.severity}`} key={`${problem.code}-${problem.affectedStage}`}>
                <CircleAlert aria-hidden="true" size={18} />
                <div>
                  <strong>{copy.title}</strong>
                  <p>{copy.message}</p>
                  {problem.automaticAction && <small>系统处理：{problem.automaticAction}</small>}
                  {problem.retryAt && <small>下次自动检查：{dateTime(problem.retryAt)}（北京时间）</small>}
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
