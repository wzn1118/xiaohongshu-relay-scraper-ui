import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FileDown,
  FilterX,
  Gauge,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Network,
  Play,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Target,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { api } from './api'
import type { ExpansionConfig, ExpansionWorkspaceState, Job } from './types'
import './ExpansionWorkspace.css'

const DEFAULT_CONFIG: ExpansionConfig = {
  rounds: 2,
  includeReplies: true,
  maxReplyDepth: 2,
  maxUsersPerRound: 20,
  maxPostsPerUser: 3,
  maxCommentsPerPost: 100,
  maxTotalUsers: 250,
  maxTotalPosts: 500,
  maxTotalComments: 5000,
  timeBudgetMinutes: 30,
  maxFailureCount: 10,
  concurrency: 1,
  postSelectionStrategy: 'latest',
  schemaVersion: 1,
}

const HIGH_OUTPUT_CONFIG: ExpansionConfig = {
  ...DEFAULT_CONFIG,
  rounds: 3,
  maxUsersPerRound: 50,
  maxPostsPerUser: 5,
  maxCommentsPerPost: 200,
  maxTotalUsers: 1000,
  maxTotalPosts: 3000,
  maxTotalComments: 30000,
  timeBudgetMinutes: 60,
  maxFailureCount: 20,
}

const CONFIG_KEYS: Array<keyof ExpansionConfig> = [
  'rounds',
  'includeReplies',
  'maxReplyDepth',
  'maxUsersPerRound',
  'maxPostsPerUser',
  'maxCommentsPerPost',
  'maxTotalUsers',
  'maxTotalPosts',
  'maxTotalComments',
  'timeBudgetMinutes',
  'maxFailureCount',
  'concurrency',
  'postSelectionStrategy',
  'schemaVersion',
]

const STATUS_LABELS: Record<string, string> = {
  idle: '待配置',
  running: '扩散中',
  cancelling: '正在停止',
  completed: '已完成',
  partial: '部分完成',
  failed: '运行失败',
  blocked: '需要处理',
  cancelled: '已停止',
  interrupted: '已中断',
}

const ACTION_LABELS: Record<string, string> = {
  start: '正在启动',
  'new-attempt': '正在创建',
  resume: '正在继续',
  retry: '正在重试',
  cancel: '正在停止',
}

const RESULT_KIND_LABELS = { users: '用户', posts: '帖子', comments: '评论', relations: '关系' } as const
const RESULT_STATUS_LABELS: Record<string, string> = {
  complete_reachable: '可达完成',
  partial_limit: '达到上限',
  partial_timeout: '超时部分完成',
  blocked_verification: '验证阻断',
  failed: '失败',
  queued: '排队中',
}
const ARTIFACT_NAMES = ['expansion_summary.json', 'expansion_rounds.json', 'expansion_frontier.json', 'users.csv', 'posts.csv', 'comments.csv', 'relations.csv', 'graph.json']

type ResultKind = keyof typeof RESULT_KIND_LABELS
type RiskLevel = 'controlled' | 'elevated' | 'high'

type Props = {
  job: Job | null
  relayReady: boolean
  visible: boolean
  onJobUpdated: (job: Job) => void
  onReturnInsights: () => void
}

function configMatches(left: ExpansionConfig, right: ExpansionConfig) {
  return CONFIG_KEYS.every((key) => left[key] === right[key])
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value)))
}

function formatCheckpoint(value: string) {
  if (!value) return '尚无检查点'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function recoveryCopy(stopReason: string, relayReady: boolean) {
  if (!relayReady || stopReason === 'relay_disconnected') return {
    title: 'Relay 连接已中断',
    detail: '重新连接并保留已登录的小红书标签页后，可从检查点继续。',
  }
  if (stopReason === 'security_verification') return {
    title: '等待完成安全验证',
    detail: '在小红书页面完成验证后继续；已保存的轮次不会重跑。',
  }
  if (stopReason === 'time_budget_reached') return {
    title: '本轮时间预算已用完',
    detail: '继续扩散会从当前检查点推进；重试仅用于补齐未完成对象。',
  }
  if (stopReason) return {
    title: '任务可从检查点恢复',
    detail: '优先继续扩散；仅在结果存在缺口时重试未完成对象。',
  }
  return {
    title: '检查点已保存',
    detail: '继续扩散会保留已完成轮次并接着处理当前前沿。',
  }
}

function resultIdentity(item: Record<string, unknown>, index: number) {
  return String(item.userId || item.postId || item.commentId || item.id || item.sourceId || index)
}

function resultTitle(item: Record<string, unknown>) {
  return String(item.displayName || item.title || item.content || item.type || '-')
}

function resultStatus(item: Record<string, unknown>) {
  const value = String(item.profileStatus || item.commentStatus || item.state || item.status || item.type || '-')
  return RESULT_STATUS_LABELS[value] || value
}

function SeedCover({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false)
  return <span className="expansion-seed-cover" title={title} aria-hidden="true">
    {src && !failed
      ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <ImageIcon size={18} />}
  </span>
}

export function ExpansionWorkspace({ job, relayReady, visible, onJobUpdated, onReturnInsights }: Props) {
  const [state, setState] = useState<ExpansionWorkspaceState | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [config, setConfig] = useState<ExpansionConfig>(DEFAULT_CONFIG)
  const [kind, setKind] = useState<ResultKind>('users')
  const [offset, setOffset] = useState(0)
  const [roundFilter, setRoundFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [seedFilter, setSeedFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const actionRef = useRef(false)
  const hydratedJobRef = useRef('')
  const activeJobRef = useRef('')
  const draftKey = job ? `expansion-draft:${job.id}` : ''

  const load = useCallback(async (nextOffset = offset, quiet = false) => {
    if (!job) return
    if (!quiet) setLoading(true)
    try {
      const next = await api.expansion(job.id, kind, nextOffset, 50, { round: roundFilter, status: statusFilter, seed: seedFilter })
      setState(next)
      setOffset(next.results.offset)
      setError('')
      const persisted = Array.isArray(next.summary.seedPostIds) ? next.summary.seedPostIds.map(String) : []
      if (hydratedJobRef.current !== job.id) {
        let draft: { selected?: string[]; config?: ExpansionConfig } = {}
        if (next.actionState === 'ready') {
          try {
            draft = JSON.parse(localStorage.getItem(draftKey) || '{}') as typeof draft
          } catch {
            localStorage.removeItem(draftKey)
          }
        }
        const available = new Set(next.seeds.filter((seed) => seed.available).map((seed) => seed.postId))
        const defaultSelection = next.seeds
          .filter((seed) => seed.available && seed.commentStatus !== 'complete')
          .map((seed) => seed.postId)
        const restored = next.actionState === 'ready'
          ? (Array.isArray(draft.selected) ? draft.selected : (persisted.length ? persisted : defaultSelection))
          : persisted
        setSelected(restored.filter((postId) => available.has(postId)))
        setConfig(draft.config || next.config || DEFAULT_CONFIG)
        hydratedJobRef.current = job.id
      } else if (next.actionState === 'running') {
        setSelected(persisted)
        if (next.config) setConfig(next.config)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [draftKey, job?.id, kind, offset, roundFilter, seedFilter, statusFilter])

  useEffect(() => {
    const nextJobId = job?.id || ''
    if (activeJobRef.current !== nextJobId) {
      activeJobRef.current = nextJobId
      hydratedJobRef.current = ''
      setState(null)
      setSelected([])
      setConfig(DEFAULT_CONFIG)
      setError('')
    }
    setOffset(0)
    if (!job) return
    void load(0)
  }, [job?.id, kind, roundFilter, seedFilter, statusFilter])

  useEffect(() => {
    if (!draftKey || !state || state.actionState === 'running' || hydratedJobRef.current !== job?.id) return
    localStorage.setItem(draftKey, JSON.stringify({ selected, config }))
  }, [config, draftKey, job?.id, selected, state])

  useEffect(() => {
    if (!job || !['running', 'cancelling'].includes(state?.status || '')) return
    const timer = window.setInterval(() => void load(offset, true), 2000)
    return () => window.clearInterval(timer)
  }, [job?.id, load, offset, state?.status])

  useEffect(() => {
    const expansion = job?.workflowSummary?.expansion as Record<string, unknown> | undefined
    if (expansion?.updatedAt || expansion?.lastCheckpointAt) void load(offset, true)
  }, [job?.workflowSummary?.expansion])

  const runAction = async (name: string, operation: () => Promise<{ job: Job; expansion: ExpansionWorkspaceState }>) => {
    if (actionRef.current) return
    actionRef.current = true
    setAction(name)
    setError('')
    try {
      const response = await operation()
      setState(response.expansion)
      localStorage.removeItem(draftKey)
      onJobUpdated(response.job)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionRef.current = false
      setAction('')
    }
  }

  const running = state?.actionState === 'running'
  const controlsLocked = !state || running || Boolean(action)
  const status = state?.status || 'idle'
  const metrics = state?.metrics || { rounds: 0, currentRound: 0, frontier: 0, users: 0, expandedUsers: 0, posts: 0, comments: 0, duplicates: 0, failures: 0, remainingMinutes: null }
  const totalPages = Math.max(1, Math.ceil((state?.results.total || 0) / 50))
  const currentPage = Math.floor(offset / 50) + 1
  const stopReason = state?.stopReason || String(state?.summary.stopReason || '')
  const attemptId = String(state?.summary.attemptId || '')
  const checkpointAt = String(state?.summary.lastCheckpointAt || state?.summary.updatedAt || '')
  const maxRounds = Math.max(1, Number(state?.summary.maxRounds || config.rounds))
  const completedRounds = Math.min(maxRounds, Math.max(0, Number(state?.summary.completedRounds ?? metrics.rounds)))
  const progressPercent = status === 'completed' ? 100 : Math.round((completedRounds / maxRounds) * 100)
  const visualProgressPercent = running ? Math.max(6, progressPercent) : progressPercent
  const availableSeeds = state?.seeds.filter((seed) => seed.available).map((seed) => seed.postId) || []
  const incompleteSeeds = state?.seeds.filter((seed) => seed.available && seed.commentStatus !== 'complete').map((seed) => seed.postId) || []
  const activeFilterCount = [roundFilter, statusFilter, seedFilter].filter(Boolean).length
  const preset = configMatches(config, DEFAULT_CONFIG) ? 'balanced' : configMatches(config, HIGH_OUTPUT_CONFIG) ? 'high-output' : 'custom'

  const estimate = useMemo(() => {
    const users = Math.min(config.maxTotalUsers, selected.length * config.maxUsersPerRound * config.rounds)
    const posts = Math.min(config.maxTotalPosts, users * config.maxPostsPerUser)
    const comments = Math.min(config.maxTotalComments, posts * config.maxCommentsPerPost)
    return { users, posts, comments }
  }, [config, selected.length])

  const risk = useMemo<{ level: RiskLevel; label: string; detail: string }>(() => {
    let score = 0
    if (estimate.users > 500) score += 1
    if (estimate.posts > 1000) score += 1
    if (estimate.comments > 10000) score += 2
    if (config.timeBudgetMinutes > 45) score += 1
    if (score >= 3) return { level: 'high', label: '高负载', detail: '耗时更长，触发限流或验证的概率更高' }
    if (score >= 1) return { level: 'elevated', label: '中等负载', detail: '建议保持 Relay 前台可用并关注首轮进度' }
    return { level: 'controlled', label: '负载可控', detail: '适合首次运行或小规模验证' }
  }, [config.timeBudgetMinutes, estimate])

  const startDisabledReason = !job
    ? '请先选择一个内容采集任务'
    : !state
      ? '正在读取扩散状态'
      : !state.available
        ? '当前任务没有可用于扩散的数据'
        : !selected.length
          ? '至少选择 1 篇可用帖子'
          : !relayReady
            ? '连接并登录 Relay 后可启动'
            : action
              ? ACTION_LABELS[action] || '正在处理'
              : ''
  const canStart = !startDisabledReason && !running
  const resumeDisabledReason = !relayReady ? '连接并登录 Relay 后可继续' : action ? ACTION_LABELS[action] || '正在处理' : ''
  const statusClass = ['completed'].includes(status) ? 'complete' : ['failed', 'blocked'].includes(status) ? 'failed' : ['partial', 'cancelled', 'interrupted'].includes(status) ? 'partial' : status
  const recovery = recoveryCopy(stopReason, relayReady)
  const results = state?.results
  const launchStepLabel = running ? '正在运行' : state?.actionState === 'resumable' ? '恢复扩散' : state?.actionState === 'completed' ? '新建扩散' : '启动扩散'
  const launchStateLabel = running ? '运行中' : !canStart ? '尚未就绪' : state?.actionState === 'resumable' ? '可以恢复' : state?.actionState === 'completed' ? '可以新建' : '可以启动'

  const scrollToStep = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const updateNumericConfig = (key: keyof ExpansionConfig, value: number) => setConfig((current) => ({ ...current, [key]: value }))
  const clearFilters = () => {
    setRoundFilter('')
    setStatusFilter('')
    setSeedFilter('')
    setOffset(0)
  }

  return <section className="expansion-workspace" hidden={!visible} aria-label="关系扩散工作台">
    <header className="expansion-command-bar">
      <div className={`expansion-runtime ${statusClass}`}>
        <span className="expansion-runtime-icon"><Network size={20} /></span>
        <span className="expansion-runtime-copy">
          <small>RELATIONSHIP EXPANSION</small>
          <strong>{STATUS_LABELS[status] || status}</strong>
          <i>任务 {job?.id || '-'}</i>
          <em>{attemptId ? `Attempt ${attemptId}` : '尚未创建 Attempt'} · {formatCheckpoint(checkpointAt)}{stopReason ? ` · ${recovery.title}` : ''}</em>
        </span>
      </div>
      <div className="expansion-actions">
        <span className={relayReady ? 'relay-ready' : 'relay-offline'}>{relayReady ? <Wifi size={14} /> : <WifiOff size={14} />}{relayReady ? 'Relay 已就绪' : 'Relay 未就绪'}</span>
        <button disabled={!state?.artifacts.length} title={state?.artifacts.length ? '定位到扩散产物' : '当前还没有可导出的扩散产物'} onClick={() => document.getElementById('expansion-artifacts')?.scrollIntoView({ behavior: 'smooth' })}><FileDown size={15} />导出</button>
      </div>
    </header>

    {!job && <div className="expansion-notice"><span>请先选择一个已有内容采集任务。</span><button onClick={onReturnInsights}>返回内容洞察</button></div>}
    {error && <div className="expansion-notice error" role="alert"><span><strong>操作未完成</strong>{error}</span><button onClick={() => void load(0)}>刷新状态</button></div>}

    <nav className="expansion-stepper" aria-label="扩散设置步骤">
      <button type="button" data-state={selected.length ? 'complete' : 'attention'} onClick={() => scrollToStep('expansion-step-seeds')}>
        <span>{selected.length ? <Check size={14} /> : '1'}</span><strong>选择种子</strong><small>{selected.length ? `已选 ${selected.length} 篇` : '需要选择'}</small>
      </button>
      <button type="button" data-state={state ? 'complete' : 'pending'} onClick={() => scrollToStep('expansion-step-plan')}>
        <span>{state ? <Check size={14} /> : '2'}</span><strong>确认预算</strong><small>{preset === 'balanced' ? '均衡' : preset === 'high-output' ? '高产' : '自定义'}</small>
      </button>
      <button type="button" data-state={running ? 'active' : status === 'completed' ? 'complete' : startDisabledReason ? 'pending' : 'ready'} onClick={() => scrollToStep('expansion-step-launch')}>
        <span>{status === 'completed' ? <Check size={14} /> : '3'}</span><strong>{launchStepLabel}</strong><small>{running ? `第 ${metrics.currentRound}/${maxRounds} 轮` : relayReady ? 'Relay 就绪' : '等待 Relay'}</small>
      </button>
    </nav>

    <div className="expansion-flow">
      <section className="expansion-stage expansion-seeds" id="expansion-step-seeds">
        <header className="expansion-stage-header">
          <div className="expansion-stage-title"><span>01</span><div><strong>选择种子帖子</strong><small>默认选择评论未完整采集的可用帖子</small></div></div>
          <div className="expansion-seed-tools">
            <button type="button" disabled={controlsLocked || !incompleteSeeds.length} onClick={() => setSelected(incompleteSeeds)}>选择待补采</button>
            <button type="button" disabled={controlsLocked || !availableSeeds.length} onClick={() => setSelected(availableSeeds)}>全选可用</button>
            <button type="button" disabled={controlsLocked || !selected.length} onClick={() => setSelected([])}>清空</button>
            <b>{selected.length} / {availableSeeds.length}</b>
          </div>
        </header>
        <div className="expansion-seed-list" aria-busy={loading && !state}>
          {state?.seeds.map((seed) => <label key={seed.postId} className={`${selected.includes(seed.postId) ? 'selected' : ''} ${!seed.available ? 'unavailable' : ''}`}>
            <input type="checkbox" checked={selected.includes(seed.postId)} disabled={controlsLocked || !seed.available} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, seed.postId])] : current.filter((item) => item !== seed.postId))} />
            <SeedCover key={seed.coverUrl || 'empty'} src={seed.coverUrl} title={seed.title} />
            <span className="expansion-seed-copy">
              <strong>{seed.title}</strong>
              <small>{String(seed.author?.display_name || '作者待确认')} · {seed.collectedComments} 条评论</small>
              {seed.unavailableReason && <small className="seed-unavailable-reason">{seed.unavailableReason}</small>}
              {seed.url && <a href={seed.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>打开原帖 <ExternalLink size={11} /></a>}
            </span>
            <i className={`seed-state ${seed.commentStatus}`} title={seed.collectionReason}>{seed.expansionStatus === 'expanding' ? '扩散中' : seed.expansionStatus === 'used' ? '已用于扩散' : seed.commentStatus === 'complete' ? '已采集' : seed.commentStatus === 'partial' ? '部分采集' : '未采集'}</i>
          </label>)}
          {loading && !state && <p className="expansion-empty"><LoaderCircle className="spin" size={18} />正在读取种子帖子</p>}
          {!loading && !state?.seeds.length && <p className="expansion-empty">内容洞察暂无可用种子。<button onClick={onReturnInsights}>返回内容洞察</button></p>}
        </div>
        <footer className={selected.length ? 'complete' : 'attention'}>{selected.length ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}<span>{selected.length ? `已选择 ${selected.length} 篇，预计从这些帖子的公开互动关系开始扩散。` : '至少选择 1 篇可用帖子后才能启动。'}</span></footer>
      </section>

      <section className="expansion-stage expansion-plan" id="expansion-step-plan">
        <header className="expansion-stage-header">
          <div className="expansion-stage-title"><span>02</span><div><strong>确认范围与预算</strong><small>先选运行预设，再按需要调整常用参数</small></div></div>
          <span className={`expansion-risk-badge ${risk.level}`}><Gauge size={14} />{risk.label}</span>
        </header>

        <div className="expansion-preset-switch" role="radiogroup" aria-label="扩散性能预设">
          <button type="button" role="radio" aria-checked={preset === 'balanced'} className={preset === 'balanced' ? 'active' : ''} disabled={controlsLocked} onClick={() => setConfig(DEFAULT_CONFIG)}>
            <span><ShieldCheck size={17} /><strong>均衡</strong><b>推荐</b></span>
            <small>2 轮 · 每轮 20 用户 · 30 分钟</small>
            <em>最多 250 用户 / 500 帖子 / 5,000 评论</em>
          </button>
          <button type="button" role="radio" aria-checked={preset === 'high-output'} className={preset === 'high-output' ? 'active' : ''} disabled={controlsLocked} onClick={() => setConfig(HIGH_OUTPUT_CONFIG)}>
            <span><Layers3 size={17} /><strong>高产</strong></span>
            <small>3 轮 · 每轮 50 用户 · 60 分钟</small>
            <em>最多 1,000 用户 / 3,000 帖子 / 30,000 评论</em>
          </button>
          {preset === 'custom' && <div className="expansion-custom-preset"><Settings2 size={16} /><span><strong>自定义配置</strong><small>当前参数不匹配预设</small></span></div>}
        </div>

        <div className="expansion-plan-layout">
          <div className="expansion-common-parameters">
            <label><span>扩散轮数</span><input type="number" min="1" max="10" disabled={controlsLocked} value={config.rounds} onChange={(event) => updateNumericConfig('rounds', Number(event.target.value))} /></label>
            <label><span>每轮用户</span><input type="number" min="1" max="1000" disabled={controlsLocked} value={config.maxUsersPerRound} onChange={(event) => updateNumericConfig('maxUsersPerRound', Number(event.target.value))} /></label>
            <label><span>每用户帖子</span><input type="number" min="1" max="100" disabled={controlsLocked} value={config.maxPostsPerUser} onChange={(event) => updateNumericConfig('maxPostsPerUser', Number(event.target.value))} /></label>
            <label><span>每帖评论</span><input type="number" min="1" max="5000" disabled={controlsLocked} value={config.maxCommentsPerPost} onChange={(event) => updateNumericConfig('maxCommentsPerPost', Number(event.target.value))} /></label>
            <label><span>时间预算</span><span className="expansion-input-suffix"><input type="number" min="1" max="1440" disabled={controlsLocked} value={config.timeBudgetMinutes} onChange={(event) => updateNumericConfig('timeBudgetMinutes', Number(event.target.value))} /><i>分钟</i></span></label>
            <label><span>帖子优先级</span><select disabled={controlsLocked} value={config.postSelectionStrategy} onChange={(event) => setConfig((current) => ({ ...current, postSelectionStrategy: event.target.value as ExpansionConfig['postSelectionStrategy'] }))}><option value="latest">最新帖子</option><option value="keyword_match">关键词匹配</option><option value="top_engagement">高互动</option><option value="all_reachable">全部可达</option></select></label>
            <label className="expansion-switch"><input type="checkbox" disabled={controlsLocked} checked={config.includeReplies} onChange={(event) => setConfig((current) => ({ ...current, includeReplies: event.target.checked }))} /><span><b>采集楼中楼回复</b><small>关闭后只保留一级评论</small></span></label>
          </div>

          <aside className={`expansion-estimate ${risk.level}`} aria-label="预计规模与预算风险">
            <header><span><Target size={16} /><strong>预计覆盖上限</strong></span><b>{risk.label}</b></header>
            <dl>
              <div><dt>种子</dt><dd>{formatCount(selected.length)}</dd></div>
              <div><dt>用户</dt><dd>≤ {formatCount(estimate.users)}</dd></div>
              <div><dt>帖子</dt><dd>≤ {formatCount(estimate.posts)}</dd></div>
              <div><dt>评论</dt><dd>≤ {formatCount(estimate.comments)}</dd></div>
            </dl>
            <p>{risk.detail}</p>
          </aside>
        </div>

        <details className="expansion-parameters">
          <summary><span><Settings2 size={15} />低频参数</span><small>回复深度、总量上限与失败预算</small><ChevronDown size={15} /></summary>
          <div className="expansion-parameter-grid">
            <label><span>回复深度</span><input type="number" min="0" max="10" disabled={controlsLocked || !config.includeReplies} value={config.maxReplyDepth} onChange={(event) => updateNumericConfig('maxReplyDepth', Number(event.target.value))} /></label>
            <label><span>总用户上限</span><input type="number" min="1" max="100000" disabled={controlsLocked} value={config.maxTotalUsers} onChange={(event) => updateNumericConfig('maxTotalUsers', Number(event.target.value))} /></label>
            <label><span>总帖子上限</span><input type="number" min="1" max="100000" disabled={controlsLocked} value={config.maxTotalPosts} onChange={(event) => updateNumericConfig('maxTotalPosts', Number(event.target.value))} /></label>
            <label><span>总评论上限</span><input type="number" min="1" max="1000000" disabled={controlsLocked} value={config.maxTotalComments} onChange={(event) => updateNumericConfig('maxTotalComments', Number(event.target.value))} /></label>
            <label><span>失败预算</span><input type="number" min="1" max="1000" disabled={controlsLocked} value={config.maxFailureCount} onChange={(event) => updateNumericConfig('maxFailureCount', Number(event.target.value))} /></label>
            <label><span>并发数</span><span className="expansion-locked-input"><input type="number" value={config.concurrency} disabled /><i>安全固定</i></span></label>
          </div>
        </details>
      </section>

      <section className="expansion-stage expansion-launch" id="expansion-step-launch">
        <header className="expansion-stage-header">
          <div className="expansion-stage-title"><span>03</span><div><strong>{running ? '运行与检查点' : launchStepLabel}</strong><small>每个动作都复用原任务并保留已有结果</small></div></div>
          <span className={`expansion-launch-state ${running ? 'running' : canStart ? 'ready' : 'blocked'}`}>{running ? <LoaderCircle className="spin" size={14} /> : canStart ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{launchStateLabel}</span>
        </header>

        <div className="expansion-readiness">
          <div className={selected.length ? 'ready' : 'blocked'}>{selected.length ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span><strong>种子帖子</strong><small>{selected.length ? `已选择 ${selected.length} 篇` : '至少选择 1 篇'}</small></span></div>
          <div className={relayReady ? 'ready' : 'blocked'}>{relayReady ? <Wifi size={16} /> : <WifiOff size={16} />}<span><strong>Relay 连接</strong><small>{relayReady ? '已登录且可连接' : '等待连接与登录'}</small></span></div>
          <div className={risk.level === 'high' ? 'warning' : 'ready'}>{risk.level === 'high' ? <AlertTriangle size={16} /> : <Gauge size={16} />}<span><strong>预算风险</strong><small>{risk.label} · {config.timeBudgetMinutes} 分钟</small></span></div>
        </div>

        {running && <div className="expansion-live-progress">
          <div><span><strong>第 {metrics.currentRound} / {maxRounds} 轮</strong><small>{metrics.remainingMinutes === null ? '正在计算剩余时间' : `预算剩余约 ${metrics.remainingMinutes} 分钟`}</small></span><b>{progressPercent}%</b></div>
          <span className="expansion-progress-track" role="progressbar" aria-label="扩散轮次进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><i style={{ width: `${visualProgressPercent}%` }} /></span>
        </div>}

        {state?.actionState === 'resumable' && <div className="expansion-recovery">
          <span className="expansion-recovery-icon"><RefreshCw size={18} /></span>
          <span><strong>{recovery.title}</strong><small>{recovery.detail}</small>{stopReason && <code>{stopReason}</code>}</span>
        </div>}

        <div className="expansion-launch-actions">
          {state?.actionState === 'ready' && <button className="primary-button" disabled={!canStart} title={startDisabledReason || '开始新的扩散任务'} onClick={() => job && void runAction('start', () => api.startExpansion(job.id, selected, config))}>{action === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}<span><strong>{action === 'start' ? '正在启动' : '开始扩散'}</strong><small>{startDisabledReason || `${selected.length} 篇种子 · ${config.rounds} 轮 · ${config.timeBudgetMinutes} 分钟`}</small></span></button>}
          {state?.actionState === 'resumable' && <>
            <button className="primary-button" disabled={Boolean(resumeDisabledReason)} title={resumeDisabledReason || '从最近检查点继续'} onClick={() => job && void runAction('resume', () => api.resumeExpansion(job.id))}>{action === 'resume' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}<span><strong>{action === 'resume' ? '正在继续' : '继续扩散'}</strong><small>{resumeDisabledReason || '从最近检查点接着运行'}</small></span></button>
            <button disabled={Boolean(resumeDisabledReason)} title={resumeDisabledReason || '重新处理未完成对象'} onClick={() => job && void runAction('retry', () => api.resumeExpansion(job.id, true))}>{action === 'retry' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}<span><strong>{action === 'retry' ? '正在重试' : '重试未完成'}</strong><small>{resumeDisabledReason || '保留已完成对象，仅补齐缺口'}</small></span></button>
            <button disabled={!canStart} title={startDisabledReason || '按当前种子和参数创建独立 Attempt'} onClick={() => job && void runAction('new-attempt', () => api.createExpansionAttempt(job.id, selected, config))}>{action === 'new-attempt' ? <LoaderCircle className="spin" size={16} /> : <PlusCircle size={16} />}<span><strong>{action === 'new-attempt' ? '正在创建' : '按所选帖子新建 Attempt'}</strong><small>{startDisabledReason || '不覆盖当前检查点'}</small></span></button>
          </>}
          {state?.actionState === 'completed' && <button className="primary-button" disabled={!canStart} title={startDisabledReason || '按当前种子和参数创建独立 Attempt'} onClick={() => job && void runAction('new-attempt', () => api.createExpansionAttempt(job.id, selected, config))}>{action === 'new-attempt' ? <LoaderCircle className="spin" size={16} /> : <PlusCircle size={16} />}<span><strong>{action === 'new-attempt' ? '正在创建' : '按所选帖子新建 Attempt'}</strong><small>{startDisabledReason || '保留当前结果，开始新一轮'}</small></span></button>}
          {running && <button className="danger-action" disabled={Boolean(action)} onClick={() => job && window.confirm('停止当前扩散轮次并保留检查点？') && void runAction('cancel', () => api.cancelExpansion(job.id))}>{action === 'cancel' ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}<span><strong>{action === 'cancel' ? '正在停止' : '停止'}</strong><small>保留当前检查点和已有结果</small></span></button>}
        </div>
        {!running && startDisabledReason && <p className="expansion-disabled-reason"><CircleAlert size={14} />{startDisabledReason}</p>}
      </section>
    </div>

    <section className="expansion-observe" aria-label="扩散运行进度">
      <header><div><strong>运行进度</strong><small>{stopReason ? recovery.title : running ? '正在按检查点推进' : status === 'completed' ? '所有计划轮次已完成' : '启动后显示实时计数'}</small></div><span>{completedRounds} / {maxRounds} 轮</span></header>
      <dl className="expansion-metrics">
        {[
          ['当前前沿', metrics.frontier, <Network size={14} />],
          ['发现用户', metrics.users, <UsersRound size={14} />],
          ['已展开', metrics.expandedUsers, <CheckCircle2 size={14} />],
          ['发现帖子', metrics.posts, <Layers3 size={14} />],
          ['发现评论', metrics.comments, <MessageSquareText size={14} />],
          ['重复用户', metrics.duplicates, <RefreshCw size={14} />],
          ['失败', metrics.failures, <AlertTriangle size={14} />],
          ['剩余分钟', metrics.remainingMinutes ?? '-', <Clock3 size={14} />],
        ].map(([label, value, icon]) => <div key={String(label)}><dt>{icon}{label}</dt><dd>{value}</dd></div>)}
      </dl>

      <section className="expansion-rounds">
        <header><strong>轮次记录</strong><small>{state?.rounds.length ? `${state.rounds.length} 条检查点摘要` : '暂无轮次记录'}</small></header>
        <div>{state?.rounds.length ? state.rounds.map((round, index) => <article className={Number(round.roundIndex ?? index) === metrics.currentRound ? 'current' : ''} key={String(round.roundIndex ?? index)}>
          <b>第 {Number(round.roundIndex ?? index)} 轮</b>
          {[
            ['前沿', round.frontierUserCount], ['展开', round.expandedUserCount], ['发现帖', round.discoveredPostCount], ['采帖', round.crawledPostCount], ['评论', round.discoveredCommentCount],
            ['新用户', round.discoveredNewUserCount], ['重复', round.duplicateUserCount], ['阻断', round.blockedUserCount], ['失败', round.failedUserCount],
          ].map(([label, value]) => <span key={String(label)}><small>{String(label)}</small>{Number(value || 0)}</span>)}
          <span><small>耗时</small>{Math.round(Number(round.durationMs || 0))} ms</span>
          <i title={String(round.stopReason || '')}>{String(round.stopReason || '完成')}</i>
        </article>) : <p className="expansion-empty">开始后将在这里逐轮保留处理摘要。</p>}</div>
      </section>
    </section>

    <section className="expansion-results">
      <header className="expansion-section-heading"><div><strong>扩散结果</strong><small>按类型和来源检查当前 Attempt 的发现结果</small></div><b>{formatCount(results?.total || 0)} 条</b></header>
      <nav aria-label="扩散结果类型">{(Object.keys(RESULT_KIND_LABELS) as ResultKind[]).map((item) => <button key={item} className={kind === item ? 'active' : ''} onClick={() => { setKind(item); setOffset(0) }}>{RESULT_KIND_LABELS[item]}</button>)}</nav>
      <div className="expansion-result-filters">
        <span className="expansion-filter-label"><FilterX size={14} />筛选{activeFilterCount ? ` · ${activeFilterCount} 项生效` : ''}</span>
        <label><span>轮次</span><select value={roundFilter} onChange={(event) => { setRoundFilter(event.target.value); setOffset(0) }}><option value="">全部轮次</option>{Array.from(new Set(state?.rounds.map((round) => String(round.roundIndex ?? '')) || [])).filter(Boolean).map((round) => <option key={round} value={round}>第 {round} 轮</option>)}</select></label>
        <label><span>状态</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setOffset(0) }}><option value="">全部状态</option>{Object.entries(RESULT_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>来源种子</span><select value={seedFilter} onChange={(event) => { setSeedFilter(event.target.value); setOffset(0) }}><option value="">全部种子</option>{state?.seeds.filter((seed) => seed.available).map((seed) => <option key={seed.postId} value={seed.postId}>{seed.title}</option>)}</select></label>
        <button type="button" className="expansion-clear-filters" disabled={!activeFilterCount} title="清除全部结果筛选" onClick={clearFilters}><FilterX size={14} />清除</button>
      </div>
      <div className="expansion-table-wrap" aria-busy={loading}>
        {loading && state ? <div className="expansion-table-loading"><LoaderCircle className="spin" size={18} />正在更新结果</div> : results?.items.length ? <table><thead><tr><th>标识</th><th>名称 / 内容</th><th>状态</th><th>轮次</th></tr></thead><tbody>{results.items.map((item, index) => <tr key={resultIdentity(item, index)}><td title={resultIdentity(item, index)}>{resultIdentity(item, index)}</td><td title={resultTitle(item)}>{resultTitle(item)}</td><td><span className="expansion-result-status">{resultStatus(item)}</span></td><td>{String(item.roundIndex ?? item.round ?? '-')}</td></tr>)}</tbody></table> : <p className="expansion-empty">{activeFilterCount ? '当前筛选条件下没有结果。' : '当前分类暂无扩散结果。'}</p>}
      </div>
      <footer><span>{formatCount(results?.total || 0)} 条 · 第 {currentPage} / {totalPages} 页</span><div><button title="上一页" aria-label="上一页" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - 50))}><ChevronLeft size={15} /></button><button title="下一页" aria-label="下一页" disabled={offset + 50 >= (results?.total || 0) || loading} onClick={() => void load(offset + 50)}><ChevronRight size={15} /></button></div></footer>
    </section>

    <section className="expansion-artifacts" id="expansion-artifacts">
      <header><div><strong>扩散产物</strong><small>同一任务当前检查点，缺失文件保持禁用</small></div><span><Download size={14} />{state?.artifacts.length || 0} / {ARTIFACT_NAMES.length}</span></header>
      <div>{ARTIFACT_NAMES.map((name) => {
        const artifact = state?.artifacts.find((item) => item.name === name || item.path === name)
        return artifact
          ? <a key={name} href={api.artifactUrl(job?.id || '', artifact)} download><Download size={14} /><span>{name}</span><small>{Math.ceil(artifact.size / 1024)} KB</small></a>
          : <span className="missing" key={name} aria-disabled="true"><Download size={14} /><span>{name}</span><small>未生成</small></span>
      })}</div>
    </section>
  </section>
}
