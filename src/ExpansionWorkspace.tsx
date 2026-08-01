import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, ChevronLeft, ChevronRight, Download, ExternalLink, FileDown, Image as ImageIcon, LoaderCircle, Network, Play, RefreshCw, RotateCcw, Wifi, WifiOff } from 'lucide-react'
import { api } from './api'
import type { ExpansionConfig, ExpansionWorkspaceState, Job, RelayStatus } from './types'

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

const STATUS_LABELS: Record<string, string> = {
  idle: '未运行', running: '扩散中', cancelling: '正在停止', completed: '已完成', partial: '部分完成',
  failed: '运行失败', blocked: '已阻断', cancelled: '已取消', interrupted: '已中断',
}

const ARTIFACT_NAMES = ['expansion_summary.json', 'expansion_rounds.json', 'expansion_frontier.json', 'users.csv', 'posts.csv', 'comments.csv', 'relations.csv', 'graph.json']

type Props = {
  job: Job | null
  relay: RelayStatus | null
  visible: boolean
  onJobUpdated: (job: Job) => void
  onReturnInsights: () => void
}

function SeedCover({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false)
  return <span className="expansion-seed-cover" title={title} aria-hidden="true">
    {src && !failed
      ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <ImageIcon size={18} />}
  </span>
}

export function ExpansionWorkspace({ job, relay, visible, onJobUpdated, onReturnInsights }: Props) {
  const [state, setState] = useState<ExpansionWorkspaceState | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [config, setConfig] = useState<ExpansionConfig>(DEFAULT_CONFIG)
  const [kind, setKind] = useState<'users' | 'posts' | 'comments' | 'relations'>('users')
  const [offset, setOffset] = useState(0)
  const [roundFilter, setRoundFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [seedFilter, setSeedFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const actionRef = useRef(false)
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
      if (persisted.length) setSelected(persisted)
      else setSelected((current) => current.length ? current : next.seeds.filter((seed) => seed.available && seed.commentStatus !== 'complete').map((seed) => seed.postId))
      if (next.config) setConfig(next.config)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [job?.id, kind, offset, roundFilter, seedFilter, statusFilter])

  useEffect(() => {
    setState(null)
    setSelected([])
    setConfig(DEFAULT_CONFIG)
    setOffset(0)
    setError('')
    if (!job) return
    const saved = localStorage.getItem(draftKey)
    if (saved) {
      try {
        const draft = JSON.parse(saved) as { selected?: string[]; config?: ExpansionConfig }
        if (draft.selected) setSelected(draft.selected)
        if (draft.config) setConfig(draft.config)
      } catch { localStorage.removeItem(draftKey) }
    }
    void load(0)
  }, [job?.id, kind, roundFilter, seedFilter, statusFilter])

  useEffect(() => {
    if (!draftKey || state?.actionState !== 'ready') return
    localStorage.setItem(draftKey, JSON.stringify({ selected, config }))
  }, [config, draftKey, selected, state?.actionState])

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
    setAction(name); setError('')
    try {
      const response = await operation()
      setState(response.expansion)
      onJobUpdated(response.job)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { actionRef.current = false; setAction('') }
  }

  const immutable = state?.actionState !== 'ready'
  const running = state?.actionState === 'running'
  const canStart = Boolean(job && state?.available && selected.length && !immutable && relay?.ready)
  const status = state?.status || 'idle'
  const metrics = state?.metrics || { rounds: 0, currentRound: 0, frontier: 0, users: 0, expandedUsers: 0, posts: 0, comments: 0, duplicates: 0, failures: 0, remainingMinutes: null }
  const totalPages = Math.max(1, Math.ceil((state?.results.total || 0) / 50))
  const page = Math.floor(offset / 50) + 1
  const stopReason = state?.stopReason || String(state?.summary.stopReason || '')
  const attemptId = String(state?.summary.attemptId || '')
  const checkpointAt = String(state?.summary.lastCheckpointAt || state?.summary.updatedAt || '')
  const availableSeeds = state?.seeds.filter((seed) => seed.available).map((seed) => seed.postId) || []

  const statusClass = useMemo(() => ['completed'].includes(status) ? 'complete' : ['failed', 'blocked'].includes(status) ? 'failed' : ['partial', 'cancelled', 'interrupted'].includes(status) ? 'partial' : status, [status])

  return <section className="expansion-workspace" hidden={!visible} aria-label="关系扩散工作台">
    <header className="expansion-command-bar">
      <div className={`expansion-runtime ${statusClass}`}><Network size={20} /><span><small>RELATIONSHIP EXPANSION</small><strong>{STATUS_LABELS[status] || status}</strong><i>原任务 {job?.id || '-'}</i><em>{attemptId ? `Attempt ${attemptId}` : '尚未创建 Attempt'} · 第 {metrics.currentRound}/{Number(state?.summary.maxRounds || config.rounds)} 轮 · {checkpointAt ? `检查点 ${new Date(checkpointAt).toLocaleString('zh-CN')}` : '暂无检查点'}{stopReason ? ` · ${stopReason}` : ''}</em></span></div>
      <div className="expansion-actions">
        <span className={relay?.ready ? 'relay-ready' : 'relay-offline'}>{relay?.ready ? <Wifi size={14} /> : <WifiOff size={14} />}{relay?.ready ? 'Relay 已就绪' : 'Relay 未就绪'}</span>
        {!immutable && <button className="primary-button" disabled={!canStart || Boolean(action)} onClick={() => job && void runAction('start', () => api.startExpansion(job.id, selected, config))}>{action === 'start' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}开始扩散</button>}
        {state?.actionState === 'resumable' && <><button disabled={Boolean(action) || !relay?.ready} onClick={() => job && void runAction('resume', () => api.resumeExpansion(job.id))}><RefreshCw size={15} />继续扩散</button><button disabled={Boolean(action) || !relay?.ready} onClick={() => job && void runAction('retry', () => api.resumeExpansion(job.id, true))}><RotateCcw size={15} />重试未完成</button></>}
        {running && <button className="danger-action" disabled={Boolean(action)} onClick={() => job && window.confirm('停止当前扩散轮次并保留检查点？') && void runAction('cancel', () => api.cancelExpansion(job.id))}><Ban size={15} />停止</button>}
        <button disabled={!state?.artifacts.length} title={state?.artifacts.length ? '定位到当前检查点产物' : '当前检查点还没有产物'} onClick={() => document.getElementById('expansion-artifacts')?.scrollIntoView({ behavior: 'smooth' })}><FileDown size={15} />导出</button>
      </div>
    </header>
    {!job && <div className="expansion-notice"><span>请先选择一个已有内容采集任务。</span><button onClick={onReturnInsights}>返回内容洞察</button></div>}
    {error && <div className="expansion-notice error">{error}</div>}
    {!relay?.ready && <div className="expansion-notice">启动前需要已登录且可连接的 Relay；当前帖子、受众和扩散结果均保持可见。</div>}

    <div className="expansion-layout">
      <section className="expansion-seeds">
        <header><span><strong>种子帖子</strong><small>仅使用当前任务已持久化的内容</small></span><div className="expansion-seed-tools"><button disabled={immutable || !availableSeeds.length} onClick={() => setSelected(availableSeeds)}>全选可用</button><button disabled={immutable || !selected.length} onClick={() => setSelected([])}>清空</button><b>{selected.length} / {state?.seeds.length || 0}</b></div></header>
        <div className="expansion-seed-list">
          {state?.seeds.map((seed) => <label key={seed.postId} className={`${selected.includes(seed.postId) ? 'selected' : ''} ${!seed.available ? 'unavailable' : ''}`}>
            <input type="checkbox" checked={selected.includes(seed.postId)} disabled={immutable || !seed.available} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, seed.postId])] : current.filter((item) => item !== seed.postId))} />
            <SeedCover key={seed.coverUrl || 'empty'} src={seed.coverUrl} title={seed.title} />
            <span className="expansion-seed-copy"><strong>{seed.title}</strong><small>{String(seed.author?.display_name || '作者待确认')} · {seed.collectedComments} 条评论{seed.unavailableReason ? ` · ${seed.unavailableReason}` : ''}</small>{seed.url && <a href={seed.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>打开原帖 <ExternalLink size={11} /></a>}</span>
            <i className={`seed-state ${seed.commentStatus}`} title={seed.collectionReason}>{seed.expansionStatus === 'expanding' ? '扩散中' : seed.expansionStatus === 'used' ? '已用于扩散' : seed.commentStatus === 'complete' ? '已采集' : seed.commentStatus === 'partial' ? '部分采集' : '未采集'}</i>
          </label>)}
          {!state?.seeds.length && <p className="expansion-empty">内容洞察暂无可用种子。<button onClick={onReturnInsights}>返回内容洞察</button></p>}
        </div>
      </section>

      <section className="expansion-main">
        <details className="expansion-parameters">
          <summary>扩散参数 <small>{config.rounds} 轮 · 每轮 {config.maxUsersPerRound} 用户 · {config.timeBudgetMinutes} 分钟</small></summary>
          <div>{[
            ['rounds', '扩散轮数', 1, 10], ['maxReplyDepth', '回复深度', 0, 10], ['maxUsersPerRound', '每轮用户', 1, 1000], ['maxPostsPerUser', '每用户帖子', 1, 100],
            ['maxCommentsPerPost', '每帖评论', 1, 5000], ['maxTotalUsers', '总用户预算', 1, 100000], ['maxTotalPosts', '总帖子预算', 1, 100000],
            ['maxTotalComments', '总评论预算', 1, 1000000], ['timeBudgetMinutes', '时间预算（分钟）', 1, 1440], ['maxFailureCount', '失败预算', 1, 1000], ['concurrency', '并发数', 1, 1],
          ].map(([key, label, min, max]) => <label key={String(key)}><span>{label}</span><input type="number" min={Number(min)} max={Number(max)} disabled={immutable} value={Number(config[key as keyof ExpansionConfig])} onChange={(event) => setConfig((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}
            <label className="expansion-toggle"><span>采集楼中楼回复</span><input type="checkbox" disabled={immutable} checked={config.includeReplies} onChange={(event) => setConfig((current) => ({ ...current, includeReplies: event.target.checked }))} /></label>
            <label><span>帖子选择策略</span><select disabled={immutable} value={config.postSelectionStrategy} onChange={(event) => setConfig((current) => ({ ...current, postSelectionStrategy: event.target.value as ExpansionConfig['postSelectionStrategy'] }))}><option value="latest">最新帖子</option><option value="keyword_match">关键词匹配</option><option value="top_engagement">高互动</option><option value="all_reachable">全部可达</option></select></label>
          </div>
        </details>

        <dl className="expansion-metrics">
          {Object.entries({ '当前轮次': metrics.currentRound, '当前前沿': metrics.frontier, '发现用户': metrics.users, '已展开': metrics.expandedUsers, '帖子': metrics.posts, '评论': metrics.comments, '重复用户': metrics.duplicates, '失败': metrics.failures, '剩余分钟': metrics.remainingMinutes ?? '-' }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>

        <section className="expansion-rounds">
          <header><strong>轮次进度</strong><small>{stopReason || (running ? '正在按检查点推进' : '等待开始')}</small></header>
          <div>{state?.rounds.length ? state.rounds.map((round, index) => <article className={Number(round.roundIndex ?? index) === metrics.currentRound ? 'current' : ''} key={String(round.roundIndex ?? index)}><b>第 {Number(round.roundIndex ?? index)} 轮</b><span>前沿 {Number(round.frontierUserCount || 0)}</span><span>展开 {Number(round.expandedUserCount || 0)}</span><span>发现帖 {Number(round.discoveredPostCount || 0)}</span><span>采帖 {Number(round.crawledPostCount || 0)}</span><span>评论 {Number(round.discoveredCommentCount || 0)}</span><span>新用户 {Number(round.discoveredNewUserCount || 0)}</span><span>重复 {Number(round.duplicateUserCount || 0)}</span><span>阻断 {Number(round.blockedUserCount || 0)}</span><span>失败 {Number(round.failedUserCount || 0)}</span><span>{Math.round(Number(round.durationMs || 0))} ms</span><i title={String(round.stopReason || '')}>{String(round.stopReason || '完成')}</i></article>) : <p className="expansion-empty">开始后将在这里逐轮保留处理摘要。</p>}</div>
        </section>

        <section className="expansion-results">
          <nav aria-label="扩散结果类型">{(['users', 'posts', 'comments', 'relations'] as const).map((item) => <button key={item} className={kind === item ? 'active' : ''} onClick={() => { setKind(item); setOffset(0) }}>{({ users: '用户', posts: '帖子', comments: '评论', relations: '关系' })[item]}</button>)}</nav>
          <div className="expansion-result-filters">
            <label><span>轮次</span><select value={roundFilter} onChange={(event) => { setRoundFilter(event.target.value); setOffset(0) }}><option value="">全部</option>{Array.from(new Set(state?.rounds.map((round) => String(round.roundIndex ?? '')) || [])).filter(Boolean).map((round) => <option key={round} value={round}>第 {round} 轮</option>)}</select></label>
            <label><span>状态</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setOffset(0) }}><option value="">全部</option><option value="complete_reachable">可达完成</option><option value="partial_limit">达到上限</option><option value="partial_timeout">超时部分完成</option><option value="blocked_verification">验证阻断</option><option value="failed">失败</option><option value="queued">排队中</option></select></label>
            <label><span>来源种子</span><select value={seedFilter} onChange={(event) => { setSeedFilter(event.target.value); setOffset(0) }}><option value="">全部</option>{state?.seeds.filter((seed) => seed.available).map((seed) => <option key={seed.postId} value={seed.postId}>{seed.title}</option>)}</select></label>
          </div>
          <div className="expansion-table-wrap" aria-busy={loading}>
            {loading && !state ? <LoaderCircle className="spin" size={22} /> : state?.results.items.length ? <table><thead><tr><th>标识</th><th>名称 / 内容</th><th>状态</th><th>轮次</th></tr></thead><tbody>{state.results.items.map((item, index) => <tr key={String(item.userId || item.postId || item.commentId || item.id || index)}><td>{String(item.userId || item.postId || item.commentId || item.sourceId || '-')}</td><td>{String(item.displayName || item.title || item.content || item.type || '-')}</td><td>{String(item.profileStatus || item.commentStatus || item.state || item.status || item.type || '-')}</td><td>{String(item.roundIndex ?? item.round ?? '-')}</td></tr>)}</tbody></table> : <p className="expansion-empty">当前分类暂无扩散结果。</p>}
          </div>
          <footer><span>{state?.results.total || 0} 条 · 第 {page} / {totalPages} 页</span><div><button title="上一页" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - 50))}><ChevronLeft size={15} /></button><button title="下一页" disabled={offset + 50 >= (state?.results.total || 0) || loading} onClick={() => void load(offset + 50)}><ChevronRight size={15} /></button></div></footer>
        </section>

        <section className="expansion-artifacts" id="expansion-artifacts"><header><strong>扩散产物</strong><small>同一任务当前检查点，缺失文件保持禁用</small></header><div>{ARTIFACT_NAMES.map((name) => { const artifact = state?.artifacts.find((item) => item.name === name || item.path === name); return artifact ? <a key={name} href={api.artifactUrl(job?.id || '', artifact)} download><Download size={14} /><span>{name}</span><small>{Math.ceil(artifact.size / 1024)} KB</small></a> : <span className="missing" key={name} aria-disabled="true"><Download size={14} /><span>{name}</span><small>未生成</small></span> })}</div></section>
      </section>
    </div>
  </section>
}
