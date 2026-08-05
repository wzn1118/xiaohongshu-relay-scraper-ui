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

type JobJourneyPanelProps = {
  job: Job
  mode: AnalysisMode
  connectionState: WorkflowConnectionState
  lastEventAt: string | null
  now: Date
  actionBusy?: boolean
  onResume?: () => void
  resumeDisabled?: boolean
  onProblemAction?: (problem: UserProblem, actionId: SupportedProblemActionId) => void
  isProblemActionDisabled?: (problem: UserProblem, actionId: SupportedProblemActionId) => boolean
}

const stageStateCopy: Record<WorkflowStageState, string> = {
  queued: '等待中',
  running: '进行中',
  waiting_system: '系统等待',
  waiting_user: '需要你处理',
  retrying: '正在重试',
  partial: '部分完成',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已停止',
}

function StageIcon({ state }: { state: WorkflowStageState }) {
  if (state === 'completed') return <Check size={15} />
  if (state === 'running' || state === 'retrying') return <LoaderCircle className="spin" size={15} />
  if (state === 'waiting_system' || state === 'partial') return <Pause size={14} />
  if (state === 'waiting_user' || state === 'failed') return <CircleAlert size={15} />
  if (state === 'cancelled') return <Clock3 size={14} />
  return <CircleDashed size={14} />
}

function connectionCopy(state: WorkflowConnectionState, active: boolean) {
  if (!active) return { text: '状态已保存', detail: '可随时回到这项任务查看结果', icon: Wifi }
  if (state === 'live') return { text: '进度实时更新', detail: '新结果会自动出现在这里', icon: Wifi }
  if (state === 'reconnecting') return { text: '正在重新连接进度', detail: '已完成结果不会丢失', icon: RefreshCw }
  if (state === 'stale') return { text: '进度更新稍慢', detail: '正在获取最新保存状态', icon: RefreshCw }
  return { text: '暂时离线', detail: '恢复连接后会从已保存位置继续显示', icon: WifiOff }
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

function etaCopy(minSeconds: number | null, maxSeconds: number | null) {
  if (minSeconds === null || maxSeconds === null || minSeconds < 0 || maxSeconds < 0) return null
  const minMinutes = Math.max(1, Math.ceil(Math.min(minSeconds, maxSeconds) / 60))
  const maxMinutes = Math.max(minMinutes, Math.ceil(Math.max(minSeconds, maxSeconds) / 60))
  return minMinutes === maxMinutes ? `预计还需约 ${minMinutes} 分钟` : `预计还需 ${minMinutes}-${maxMinutes} 分钟`
}

function containsUnknownCopy(value: unknown) {
  return /未识别|未知|unknown/i.test(String(value || ''))
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
  const view = jobExperienceView(job, mode, connectionState, lastEventAt)
  const active = ['queued', 'resuming', 'running'].includes(job.status)
  const connection = connectionCopy(view.connection.state, active)
  const ConnectionIcon = connection.icon
  const eta = etaCopy(view.speed.etaMinSeconds, view.speed.etaMaxSeconds)
  const visibleIssues = view.issues.filter((issue) => issue.severity !== 'info' || issue.requiresUserAction)
  const resultLabel = mode === 'job' ? '可查看岗位' : '已整理结果'
  const savedResultCount = Math.max(view.counts.fullText, view.counts.resultReady)
  const currentWorkNeedsReview = containsUnknownCopy(view.headline) || containsUnknownCopy(view.detail)
  const currentHeadline = currentWorkNeedsReview ? '当前步骤需要重新检查' : view.headline
  const currentDetail = currentWorkNeedsReview
    ? `系统暂时没有返回可读的原因；已保存 ${savedResultCount} 条结果，稍后可从检查点继续。`
    : view.detail
  const canResume = !active
    && Boolean(job.resumeAvailable)
    && ['incomplete', 'interrupted', 'cancelled', 'blocked', 'failed'].includes(job.status)
    && Boolean(onResume)
  const remainingStageLabels = view.stages
    .filter((stage) => !['completed', 'cancelled'].includes(stage.state))
    .map((stage) => stage.label)
  const remainingStageSummary = remainingStageLabels.length > 0
    ? `${view.counts.discovered > 0 && view.counts.fullText >= view.counts.discovered ? '正文采集已完成；' : ''}待恢复：${remainingStageLabels.slice(0, 3).join('、')}${remainingStageLabels.length > 3 ? `等 ${remainingStageLabels.length} 项` : ''}`
    : ''

  return (
    <div className="job-journey-panel">
      <section className="journey-current-work" aria-labelledby="journey-current-heading" aria-live="polite">
        <div className="journey-current-heading">
          <span className="journey-current-icon"><Activity size={18} /></span>
          <div>
            <span className="journey-eyebrow">当前工作</span>
            <h3 id="journey-current-heading">{currentHeadline}</h3>
            <p>{currentDetail}</p>
            {canResume && remainingStageSummary && <p className="journey-recovery-note">{remainingStageSummary}</p>}
            {canResume && <button
              type="button"
              className="journey-recovery-action"
              onClick={onResume}
              disabled={actionBusy || resumeDisabled}
              title="从已保存检查点继续处理未完成步骤"
            >
              <RefreshCw className={actionBusy || resumeDisabled ? 'spin' : ''} size={15} />
              {actionBusy || resumeDisabled ? '正在准备恢复' : '一键恢复未完成步骤'}
            </button>}
          </div>
        </div>
        <div className={`journey-connection ${view.connection.state}`} role="status">
          <ConnectionIcon className={view.connection.state === 'reconnecting' || view.connection.state === 'stale' ? 'spin' : ''} size={16} />
          <span><strong>{connection.text}</strong><small>{connection.detail}</small></span>
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
          {view.coverageDeterminate && view.coveragePercent !== null && <strong>{view.coveragePercent}%</strong>}
        </div>
        <div
          className={`journey-progress-track ${view.coverageDeterminate ? '' : 'indeterminate'}`}
          role="progressbar"
          aria-label="完整正文采集进度"
          aria-valuemin={view.coverageDeterminate ? 0 : undefined}
          aria-valuemax={view.coverageDeterminate ? 100 : undefined}
          aria-valuenow={view.coverageDeterminate && view.coveragePercent !== null ? Math.round(view.coveragePercent) : undefined}
          aria-valuetext={view.coverageDeterminate && view.coveragePercent !== null
            ? `已获取 ${view.counts.fullText} 篇，共发现 ${view.counts.discovered} 篇`
            : '正在发现更多内容，当前不显示固定百分比'}
        >
          <i style={view.coverageDeterminate && view.coveragePercent !== null ? { width: `${view.coveragePercent}%` } : undefined} />
        </div>
        {!view.coverageDeterminate && <p className="journey-progress-explanation">发现范围还在增长，待数量稳定后再显示百分比，避免给出误导性进度。</p>}
      </section>

      <section className="journey-path" aria-labelledby="journey-path-heading">
        <div className="journey-section-heading compact">
          <div><span className="journey-eyebrow">任务旅程</span><h3 id="journey-path-heading">每一步都可保存并接着运行</h3></div>
        </div>
        <ol className="task-journey-list">
          {view.stages.map((stage) => (
            <li key={stage.id} className={stage.state} aria-current={stage.state === 'running' || stage.state === 'retrying' ? 'step' : undefined}>
              <span className="task-journey-marker"><StageIcon state={stage.state} /></span>
              <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
              <em>{stageStateCopy[stage.state]}</em>
            </li>
          ))}
        </ol>
      </section>

      <section className="journey-results" aria-label="已保存结果与速度">
        <div className="journey-counts">
          <div><span>已发现</span><strong>{view.counts.discovered || '-'}</strong><small>条相关内容</small></div>
          <div><span>完整正文</span><strong>{view.counts.fullText || '-'}</strong><small>已保存可查看</small></div>
          <div><span>{resultLabel}</span><strong>{view.counts.resultReady || '-'}</strong><small>{mode === 'job' ? '已有求职信息' : '已有结构化内容'}</small></div>
          <div><span>待处理</span><strong>{view.counts.pending || '-'}</strong><small>{view.counts.retryable > 0 ? `${view.counts.retryable} 条可继续` : '随任务继续更新'}</small></div>
        </div>
        <div className="journey-performance">
          <span><Activity size={15} /><strong>{view.speed.activePerMinute !== null ? `${view.speed.activePerMinute.toFixed(1)} 篇/分钟` : '速度统计准备中'}</strong><small>{view.speed.activePerMinute !== null ? '按实际处理时间计算' : '积累足够样本后显示'}</small></span>
          {eta && <span><Clock3 size={15} /><strong>{eta}</strong><small>按最近稳定速度估算</small></span>}
          {view.speed.cacheHits > 0 && <span><Check size={15} /><strong>{view.speed.cacheHits} 篇直接复用</strong><small>无需重复访问页面</small></span>}
        </div>
      </section>

      {visibleIssues.length > 0 && (
        <section className="journey-problems" aria-label="需要关注的问题">
          {visibleIssues.map((problem) => {
            const blocking = problem.severity === 'blocking' && problem.requiresUserAction
            const actionId = normalizeProblemActionId(problem.action?.id)
            const disabled = actionBusy || Boolean(actionId && isProblemActionDisabled?.(problem, actionId))
            const actionLabel = actionId === 'check_recovery' ? '立即检查是否恢复' : problem.action?.label
            const unknownProblem = problem.code === 'UNKNOWN_ERROR'
              || containsUnknownCopy(problem.userTitle)
              || containsUnknownCopy(problem.userMessage)
            const problemTitle = unknownProblem ? '当前步骤需要重新检查' : problem.userTitle
            const problemMessage = unknownProblem
              ? `系统暂时没有返回可读的原因；已保存 ${Math.max(problem.preservedResultCount || 0, savedResultCount)} 条结果，稍后可从检查点继续。`
              : problem.userMessage
            return (
              <div className={`journey-problem ${problem.severity}`} key={`${problem.code}-${problem.affectedStage}`} role={blocking ? 'alert' : 'status'}>
                <CircleAlert size={19} />
                <div>
                  <strong>{problemTitle}</strong>
                  <p>{problemMessage}</p>
                  {problem.automaticAction && <small>系统处理：{problem.automaticAction}</small>}
                  {problem.retryAt && <small>下次自动检查：{dateTime(problem.retryAt)}（北京时间）</small>}
                </div>
                {problem.action && actionId && onProblemAction && !(canResume && actionId === 'resume') && (
                  <button type="button" onClick={() => onProblemAction(problem, actionId)} disabled={disabled}>
                    {actionId === 'open_login' ? <Wifi size={15} /> : <RefreshCw className={actionBusy ? 'spin' : ''} size={15} />}
                    {actionBusy ? '正在处理' : actionLabel}
                  </button>
                )}
              </div>
            )
          })}
        </section>
      )}

      <p className="journey-checkpoint"><Check size={14} />进度已保存 · {relativeTime(view.checkpoint.savedAt, now)}{view.checkpoint.resumeAvailable ? ' · 可从剩余内容继续' : ''}</p>
    </div>
  )
}
