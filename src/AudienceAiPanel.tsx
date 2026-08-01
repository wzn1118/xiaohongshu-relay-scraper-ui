import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  LoaderCircle,
  MapPin,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from 'lucide-react'
import { api } from './api'
import type {
  AiSession,
  Artifact,
  AudienceAiAnchor,
  AudienceAiCoverage,
  AudienceAiEvidence,
  AudienceAiModule,
  AudienceAiOverview,
  AudienceAiPreview,
  AudienceAiProfileMode,
  AudienceAiResultItem,
  AudienceAiResultsModule,
  AudienceAiResultsResponse,
  AudienceAiRun,
  AudienceAiScope,
  AudienceAiStatus,
  AudiencePost,
} from './types'

type ResultTab = 'overview' | 'themes' | 'threads' | 'comments' | 'users' | 'profiles' | 'content-fit' | 'opportunities' | 'quality' | 'evidence'
type ResultSort = 'source' | 'confidence-desc' | 'confidence-asc' | 'name'

type EvidenceTarget = {
  kind: 'comments' | 'users'
  entityId: string
  anchor: AudienceAiAnchor
}

type Props = {
  jobId: string
  post: AudiencePost
  aiSession: AiSession | null
  onClose: () => void
  onConfigureAi: () => void
  onNavigateEvidence: (target: EvidenceTarget) => void
  onStatusChange?: (postId: string, status: AudienceAiStatus) => void
}

const activeStatuses = new Set<AudienceAiStatus>([
  'snapshotting',
  'waiting_profile_enrichment',
  'collecting_profile_headers',
  'collecting_profile_posts',
  'analyzing_comments',
  'analyzing_users',
  'synthesizing',
  'validating',
  'exporting',
  'cancelling',
])

const moduleOptions: Array<{ id: AudienceAiModule; label: string }> = [
  { id: 'comment_insights', label: '逐评论洞察' },
  { id: 'thread_insights', label: '评论线程' },
  { id: 'user_insights', label: '逐用户洞察' },
  { id: 'audience_segments', label: '受众分群' },
  { id: 'content_fit', label: '原帖与受众匹配' },
  { id: 'content_opportunities', label: '内容机会' },
  { id: 'profile_insights', label: '主页洞察' },
]

const defaultModules = moduleOptions.filter((item) => item.id !== 'profile_insights').map((item) => item.id)

const profileModeOptions: Array<{ id: AudienceAiProfileMode; label: string; description: string; collects: boolean }> = [
  { id: 'none', label: '不使用主页', description: '只分析该帖评论与可观察互动，不读取主页字段。', collects: false },
  { id: 'available_header', label: '使用已有主页头部', description: '读取当前任务已保存的公开字段，不启动补采。', collects: false },
  { id: 'collect_missing_header', label: '补齐缺失主页头部', description: '仅补当前帖相关评论用户，并沿用原 jobId 与检查点。', collects: true },
  { id: 'recent_public_posts', label: '限量采集近期公开帖子', description: '按明确人数和帖子预算补充近期公开内容。', collects: true },
]

const resultTabs: Array<{ id: ResultTab; label: string; module: AudienceAiResultsModule; analysisFields?: string[] }> = [
  { id: 'overview', label: '综合总览', module: 'analysis' },
  { id: 'themes', label: '主题与分群', module: 'analysis', analysisFields: ['themes', 'distributions', 'audienceSegments'] },
  { id: 'threads', label: '评论线程', module: 'threads' },
  { id: 'comments', label: '评论洞察', module: 'comments' },
  { id: 'users', label: '用户洞察', module: 'users' },
  { id: 'profiles', label: '主页洞察', module: 'users' },
  { id: 'content-fit', label: '内容匹配', module: 'analysis', analysisFields: ['contentFit', 'audienceFit', 'fitEvidence'] },
  { id: 'opportunities', label: '内容机会', module: 'analysis', analysisFields: ['contentOpportunities', 'opportunities', 'recommendations'] },
  { id: 'quality', label: '风险与质量', module: 'analysis', analysisFields: ['risks', 'dataQuality', 'limitations', 'coverage'] },
  { id: 'evidence', label: '证据', module: 'evidence' },
]

export function AudienceAiPanel({
  jobId,
  post,
  aiSession,
  onClose,
  onConfigureAi,
  onNavigateEvidence,
  onStatusChange,
}: Props) {
  const [scope, setScope] = useState<AudienceAiScope>(() => defaultScope(aiSession?.id))
  const [overview, setOverview] = useState<AudienceAiOverview | null>(null)
  const [preview, setPreview] = useState<AudienceAiPreview | null>(null)
  const [result, setResult] = useState<AudienceAiResultsResponse | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [resultTab, setResultTab] = useState<ResultTab>('overview')
  const [selectedRunId, setSelectedRunId] = useState('')
  const [resultOffset, setResultOffset] = useState(0)
  const [resultQuery, setResultQuery] = useState('')
  const [resultSort, setResultSort] = useState<ResultSort>('source')
  const [loading, setLoading] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [resultLoading, setResultLoading] = useState(false)
  const [action, setAction] = useState<'start' | 'cancel' | 'resume' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [collectionConfirmed, setCollectionConfirmed] = useState(false)
  const requestSequence = useRef(0)

  const loadOverview = useCallback(async (quiet = false) => {
    const sequence = ++requestSequence.current
    if (!quiet) setLoading(true)
    try {
      const next = normalizeOverview(await api.audienceAi(jobId, post.post_id))
      if (sequence !== requestSequence.current) return
      setOverview(next)
      const status = next.currentRun?.status || next.activeVersion?.status || next.status || 'not_started'
      onStatusChange?.(post.post_id, status)
      setSelectedRunId((current) => {
        if (current && next.versions.some((version) => version.runId === current)) return current
        return next.activeVersion?.runId || next.currentRun?.runId || next.versions[0]?.runId || ''
      })
    } catch (error) {
      if (sequence !== requestSequence.current) return
      const apiError = error as Error & { status?: number }
      if (apiError.status === 404) {
        setOverview(emptyOverview(jobId, post.post_id))
      } else {
        setNotice(`AI 状态读取失败：${apiError.message}`)
      }
    } finally {
      if (!quiet && sequence === requestSequence.current) setLoading(false)
    }
  }, [jobId, onStatusChange, post.post_id])

  const loadPreview = useCallback(async (quiet = false) => {
    if (!quiet) setPreviewing(true)
    try {
      const next = await api.previewAudienceAi(jobId, post.post_id, {
        ...scope,
        aiSessionId: aiSession?.id || null,
      })
      setPreview(normalizePreview(next, jobId, post.post_id))
    } catch (error) {
      if (!quiet) setNotice(`输入覆盖预览失败：${(error as Error).message}`)
    } finally {
      if (!quiet) setPreviewing(false)
    }
  }, [aiSession?.id, jobId, post.post_id, scope])

  const loadResults = useCallback(async (runId: string, tab = resultTab, offset = resultOffset) => {
    if (!runId) {
      setResult(null)
      return
    }
    setResultLoading(true)
    try {
      const module = resultTabs.find((item) => item.id === tab)?.module || 'analysis'
      const next = await api.audienceAiResults(jobId, post.post_id, runId, module, offset, 50)
      setResult(normalizeResults(next, module, runId, offset))
      setResultOffset(offset)
    } catch (error) {
      setNotice(`分析结果读取失败：${(error as Error).message}`)
    } finally {
      setResultLoading(false)
    }
  }, [jobId, post.post_id, resultOffset, resultTab])

  useEffect(() => {
    setScope(defaultScope(aiSession?.id))
    setOverview(null)
    setPreview(null)
    setResult(null)
    setArtifacts([])
    setSelectedRunId('')
    setResultTab('overview')
    setResultOffset(0)
    setResultQuery('')
    setResultSort('source')
    setNotice(null)
    setCollectionConfirmed(false)
    void loadOverview()
  }, [jobId, post.post_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setScope((current) => ({ ...current, aiSessionId: aiSession?.id || null }))
  }, [aiSession?.id])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPreview(true), 250)
    return () => window.clearTimeout(timer)
  }, [loadPreview])

  useEffect(() => {
    if (!selectedRunId) {
      setResult(null)
      setArtifacts([])
      return
    }
    void loadResults(selectedRunId, resultTab, 0)
  }, [resultTab, selectedRunId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedRunId) return
    let cancelled = false
    void api.artifacts(jobId).then((items) => {
      if (cancelled) return
      setArtifacts(items.filter((artifact) => `${artifact.path || ''}/${artifact.name}`.includes(selectedRunId)))
    }).catch(() => {
      if (!cancelled) setArtifacts([])
    })
    return () => { cancelled = true }
  }, [jobId, selectedRunId, overview?.currentRun?.updatedAt, overview?.activeVersion?.updatedAt])

  const currentRun = overview?.currentRun || null
  const status = currentRun?.status || overview?.activeVersion?.status || overview?.status || 'not_started'
  const isActive = activeStatuses.has(status)

  useEffect(() => {
    if (!isActive) return
    const refresh = () => void loadOverview(true)
    const timer = window.setInterval(refresh, 3_000)
    const stream = new EventSource(api.audienceAiEventsUrl(jobId, post.post_id))
    stream.onmessage = refresh
    for (const name of [
      'audience_ai_snapshot',
      'audience_ai_status',
      'audience_ai_progress',
      'audience_ai_completed',
      'audience_ai_partial',
      'audience_ai_failed',
      'audience_ai_cancelled',
    ]) {
      stream.addEventListener(name, refresh)
    }
    return () => {
      window.clearInterval(timer)
      stream.close()
    }
  }, [isActive, jobId, loadOverview, post.post_id])

  const coverage = preview?.coverage || currentRun?.coverage || overview?.coverage || overview?.activeVersion?.coverage || {}
  const collectionMode = profileModeOptions.find((item) => item.id === scope.profileMode)?.collects || false
  const blockerItems = preview?.blockers || []
  const blockers = blockerItems.filter((item) => typeof item === 'string' || item.blocking !== false).map(messageOf)
  const warnings = [
    ...blockerItems.filter((item) => typeof item !== 'string' && item.blocking === false),
    ...(preview?.warnings || []),
  ].map(messageOf)
  const hasComments = Number(coverage.collectedComments ?? coverage.sourceCommentsForPost ?? post.collected_comment_count ?? 0) > 0
  const hasBody = coverage.originalBodyAvailable !== false
  const sessionExpired = Boolean(aiSession && Date.parse(aiSession.expiresAt) <= Date.now())
  const canStart = !isActive && Boolean(preview) && preview?.canStart !== false && hasComments && hasBody && Boolean(aiSession) && !sessionExpired && blockers.length === 0 && (!collectionMode || collectionConfirmed)
  const visibleItems = useMemo(() => {
    const source = resultTab === 'profiles'
      ? (result?.items || []).filter((item) => String(item.profileCoverage || 'none') !== 'none')
      : result?.items || []
    return filterResultItems(source, resultQuery, resultSort)
  }, [result?.items, resultQuery, resultSort, resultTab])
  const selectedRun = overview?.versions.find((version) => version.runId === selectedRunId) || null
  const displayedRun = selectedRun || overview?.activeVersion || null
  const progress = currentRun?.progress || {}
  const progressPercent = Number(progress.totalUnits || 0) > 0
    ? Math.min(100, Math.round((Number(progress.completedUnits || 0) / Number(progress.totalUnits)) * 100))
    : stageProgress(status)

  const updateScope = <K extends keyof AudienceAiScope>(key: K, value: AudienceAiScope[K]) => {
    setScope((current) => ({ ...current, [key]: value }))
  }

  const updateRecentBudget = (key: 'profileUserLimit' | 'profilePostLimitPerUser' | 'profilePostTotalLimit', value: number) => {
    setScope((current) => {
      const next = { ...current, [key]: value }
      const capacity = Math.min(2_000, next.profileUserLimit * next.profilePostLimitPerUser)
      next.profilePostTotalLimit = Math.max(1, Math.min(next.profilePostTotalLimit, capacity))
      return next
    })
  }

  const setProfileMode = (profileMode: AudienceAiProfileMode) => {
    setCollectionConfirmed(false)
    setScope((current) => {
      const modules = profileMode === 'none'
        ? current.modules.filter((item) => item !== 'profile_insights')
        : current.modules
      if (profileMode === 'recent_public_posts') {
        return { ...current, profileMode, modules, profileUserLimit: 30, profilePostLimitPerUser: 3, profilePostTotalLimit: 90 }
      }
      return { ...current, profileMode, modules, profileUserLimit: profileMode === 'collect_missing_header' ? 100 : 0, profilePostLimitPerUser: 0, profilePostTotalLimit: 0 }
    })
  }

  const toggleModule = (module: AudienceAiModule) => {
    setScope((current) => ({
      ...current,
      modules: current.modules.includes(module)
        ? current.modules.filter((item) => item !== module)
        : [...current.modules, module],
    }))
  }

  const start = async () => {
    if (!aiSession || !canStart) return
    setAction('start')
    setNotice(null)
    try {
      const response = await api.startAudienceAi(jobId, post.post_id, {
        ...scope,
        aiSessionId: aiSession.id,
        idempotencyKey: makeIdempotencyKey(jobId, post.post_id),
      })
      setNotice(response.message || '分析已在原任务内启动。原始评论、用户和上一版结果会继续显示。')
      await loadOverview(true)
    } catch (error) {
      setNotice(`分析启动失败：${(error as Error).message}`)
    } finally {
      setAction(null)
    }
  }

  const cancel = async () => {
    if (!currentRun) return
    setAction('cancel')
    setNotice(null)
    try {
      const response = await api.cancelAudienceAi(jobId, post.post_id, currentRun.runId)
      setNotice(response.message || '已请求取消。完成的分块和上一版结果仍会保留。')
      await loadOverview(true)
    } catch (error) {
      setNotice(`取消失败：${(error as Error).message}`)
    } finally {
      setAction(null)
    }
  }

  const resume = async (run: AudienceAiRun) => {
    setAction('resume')
    setNotice(null)
    try {
      const response = await api.resumeAudienceAi(jobId, post.post_id, run.runId)
      setNotice(response.message || `已沿用分析运行 ${run.runId} 继续未完成分块。`)
      await loadOverview(true)
    } catch (error) {
      setNotice(`继续分析失败：${(error as Error).message}`)
    } finally {
      setAction(null)
    }
  }

  const locateEvidence = async (item: AudienceAiResultItem) => {
    const evidence = item as AudienceAiEvidence
    const entityType = String(evidence.entityType || '')
    const entityId = String(evidence.entityId || item.commentId || item.userId || '')
    if (!entityId || !['comment', 'user'].includes(entityType)) {
      setNotice('该证据属于原帖或主页字段，可在当前结果中核对，未关联评论/用户定位。')
      return
    }
    try {
      const anchor = entityType === 'comment'
        ? await api.audienceCommentAnchor(jobId, post.post_id, entityId)
        : await api.audienceUserAnchor(jobId, post.post_id, entityId)
      onNavigateEvidence({ kind: entityType === 'comment' ? 'comments' : 'users', entityId, anchor })
    } catch (error) {
      setNotice(`证据定位失败：${(error as Error).message}`)
    }
  }

  const terminalRun = currentRun && !isActive ? currentRun : overview?.versions.find((run) => run.resumable && ['interrupted', 'cancelled', 'partial', 'failed'].includes(run.status))
  const artifactLinks = artifacts.length > 0 ? artifacts : result?.artifacts || []

  return <section className="audience-ai-panel" aria-labelledby="audience-ai-title">
    <header className="audience-ai-heading">
      <div className="audience-ai-title-icon"><BrainCircuit size={19} /></div>
      <div>
        <span>POST AUDIENCE AI</span>
        <h3 id="audience-ai-title">逐帖受众 AI 深度分析</h3>
        <p><strong>{post.title || '未命名原帖'}</strong><small>{post.author?.display_name || '作者未记录'} · 绑定任务 {jobId}</small></p>
      </div>
      <span className={`audience-ai-status ${status}`}>{statusIcon(status)}{statusLabel(status)}</span>
      <button type="button" className="audience-ai-close" title="关闭分析面板" aria-label="关闭分析面板" onClick={onClose}><X size={16} /></button>
    </header>

    {notice && <div className="audience-ai-notice" role="status"><CircleAlert size={15} /><span>{notice}</span><button type="button" title="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}

    {isActive && <div className="audience-ai-live" role="status" aria-live="polite">
      <div><LoaderCircle className="spin" size={17} /><span><strong>{statusLabel(status)}</strong><small>{progress.message || currentRun?.errorMessage || '已完成内容会持续保存，可继续查看原始评论、用户卡和上一版结果。'}</small></span><b>{progressPercent}%</b></div>
      <progress max="100" value={progressPercent} />
      <dl><div><dt>处理单元</dt><dd>{Number(progress.completedUnits || 0)} / {Number(progress.totalUnits || 0) || '-'}</dd></div><div><dt>评论</dt><dd>{Number(progress.commentsAnalyzed || 0)}</dd></div><div><dt>用户</dt><dd>{Number(progress.usersAnalyzed || 0)}</dd></div><div><dt>Token</dt><dd>{formatNumber(sumTokenUsage(progress.tokenUsage))}</dd></div></dl>
    </div>}

    {currentRun && overview?.activeVersion && currentRun.runId !== overview.activeVersion.runId && <div className="audience-ai-version-banner"><RefreshCw size={14} /><span>新版本正在更新；下方继续展示已验证的上一版 {shortRunId(overview.activeVersion.runId)}。</span></div>}

    <div className="audience-ai-body">
      <section className="audience-ai-config" aria-label="分析范围配置">
        <div className="audience-ai-section-title"><div><span>01</span><strong>输入与范围</strong></div><button type="button" onClick={() => void loadPreview()} disabled={previewing}>{previewing ? <LoaderCircle className="spin" size={14} /> : <Gauge size={14} />}查看输入覆盖</button></div>

        <div className="audience-ai-fixed-scope"><ShieldCheck size={15} /><span><strong>原帖完整内容</strong><small>固定纳入，不能关闭；评论与用户始终读取该帖全部持久化数据。</small></span><Check size={15} /></div>

        <div className="audience-ai-switches">
          <label><input type="checkbox" checked={scope.includeTopLevelComments} onChange={(event) => updateScope('includeTopLevelComments', event.target.checked)} /><span><strong>顶层评论</strong><small>{formatNumber(coverage.topLevelComments)} 条</small></span></label>
          <label><input type="checkbox" checked={scope.includeReplies} onChange={(event) => updateScope('includeReplies', event.target.checked)} /><span><strong>评论回复</strong><small>{formatNumber(coverage.replies)} 条</small></span></label>
          <label><input type="checkbox" checked={scope.includeUsers} onChange={(event) => updateScope('includeUsers', event.target.checked)} /><span><strong>评论用户</strong><small>{formatNumber(coverage.uniqueUsers)} 位</small></span></label>
          <label><input type="checkbox" checked={scope.incrementalOnly} onChange={(event) => updateScope('incrementalOnly', event.target.checked)} /><span><strong>只分析新增</strong><small>复用未变化分块</small></span></label>
        </div>

        <fieldset className="audience-ai-profile-modes">
          <legend>用户主页范围</legend>
          {profileModeOptions.map((item) => <label key={item.id} className={scope.profileMode === item.id ? 'active' : ''}>
            <input type="radio" name={`profile-mode-${post.post_id}`} checked={scope.profileMode === item.id} onChange={() => setProfileMode(item.id)} />
            <span><strong>{item.label}</strong><small>{item.description}</small></span>
          </label>)}
        </fieldset>

        {scope.profileMode === 'collect_missing_header' && <label className="audience-ai-budget"><span>最多补齐用户</span><input type="number" min="1" max="2000" value={scope.profileUserLimit} onChange={(event) => updateScope('profileUserLimit', clampInteger(event.target.value, 1, 2000))} /></label>}
        {scope.profileMode === 'recent_public_posts' && <div className="audience-ai-budgets">
          <label><span>用户上限</span><input type="number" min="1" max="2000" value={scope.profileUserLimit} onChange={(event) => updateRecentBudget('profileUserLimit', clampInteger(event.target.value, 1, 2000))} /></label>
          <label><span>每用户帖子</span><input type="number" min="1" max="20" value={scope.profilePostLimitPerUser} onChange={(event) => updateRecentBudget('profilePostLimitPerUser', clampInteger(event.target.value, 1, 20))} /></label>
          <label><span>总帖子上限</span><input type="number" min="1" max={Math.min(2000, scope.profileUserLimit * scope.profilePostLimitPerUser)} value={scope.profilePostTotalLimit} onChange={(event) => updateRecentBudget('profilePostTotalLimit', clampInteger(event.target.value, 1, Math.min(2000, scope.profileUserLimit * scope.profilePostLimitPerUser)))} /></label>
        </div>}
        {collectionMode && <label className="audience-ai-confirm"><input type="checkbox" checked={collectionConfirmed} onChange={(event) => setCollectionConfirmed(event.target.checked)} /><span>确认在原任务内按上述预算补采当前帖相关用户；不创建新任务。</span></label>}

        <fieldset className="audience-ai-modules">
          <legend>分析模块</legend>
          {moduleOptions.map((item) => <label key={item.id} className={(item.id === 'profile_insights' && scope.profileMode === 'none') ? 'disabled' : ''}><input type="checkbox" checked={scope.modules.includes(item.id)} disabled={item.id === 'profile_insights' && scope.profileMode === 'none'} onChange={() => toggleModule(item.id)} /><span>{item.label}</span></label>)}
        </fieldset>

        <div className="audience-ai-inline-fields">
          <label><span>输出语言</span><select value={scope.outputLanguage} onChange={(event) => updateScope('outputLanguage', event.target.value)}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
          <label><span>证据严格度</span><select value={scope.evidenceStrictness} onChange={(event) => updateScope('evidenceStrictness', event.target.value as AudienceAiScope['evidenceStrictness'])}><option value="strict">严格</option><option value="balanced">平衡</option></select></label>
        </div>
      </section>

      <aside className="audience-ai-preview" aria-label="输入覆盖与执行预算">
        <div className="audience-ai-section-title"><div><span>02</span><strong>覆盖与预算</strong></div>{loading && <LoaderCircle className="spin" size={14} />}</div>
        <dl className="audience-ai-coverage-grid">
          <CoverageMetric label="原帖正文" value={coverage.originalBodyAvailable === false ? '缺失' : coverage.originalBodyAvailable ? '可用' : '待核对'} warning={coverage.originalBodyAvailable === false} />
          <CoverageMetric label="媒体分析" value={coverage.mediaAnalysisAvailable ? '可用' : '未提供'} />
          <CoverageMetric label="顶层评论" value={formatNumber(coverage.topLevelComments)} />
          <CoverageMetric label="回复" value={formatNumber(coverage.replies)} />
          <CoverageMetric label="独立用户" value={formatNumber(coverage.uniqueUsers)} />
          <CoverageMetric label="已有主页" value={formatNumber(coverage.profilesAvailable)} />
          <CoverageMetric label="完整主页" value={formatNumber(coverage.profilesComplete)} />
          <CoverageMetric label="部分主页" value={formatNumber(coverage.profilesPartial)} />
          <CoverageMetric label="缺失主页" value={formatNumber(coverage.profilesMissing)} />
          <CoverageMetric label="数据版本" value={shortRevision(preview?.inputRevision || displayedRun?.inputRevision)} mono />
          <CoverageMetric label="上一版状态" value={overview?.activeVersion ? statusLabel(overview.activeVersion.status) : '尚无版本'} />
          <CoverageMetric label="上一版时间" value={overview?.activeVersion ? formatDate(overview.activeVersion.completedAt || overview.activeVersion.updatedAt) : '尚无版本'} />
        </dl>
        <dl className="audience-ai-estimates">
          <div><dt>预计分块 / 调用</dt><dd>{formatNumber(preview?.estimatedChunks)} / {formatNumber(preview?.estimatedCalls)}</dd></div>
          <div><dt>预计 Token</dt><dd>{formatNumber(preview?.estimatedTokens)} <small>估算</small></dd></div>
          <div><dt>预计成本</dt><dd>{preview?.estimatedCost == null ? '待 Provider 报价' : `${formatMoney(preview.estimatedCost)} 估算`}</dd></div>
          <div><dt>预计网络请求</dt><dd>{formatNumber(preview?.estimatedNetworkRequests ?? estimateNetworkRequests(scope))} <small>估算</small></dd></div>
        </dl>
        <div className={`audience-ai-runtime-config ${aiSession && !sessionExpired ? 'ready' : ''}`}>
          <BrainCircuit size={16} /><span><strong>{aiSession && !sessionExpired ? `${aiSession.provider} · ${aiSession.model}` : sessionExpired ? 'AI Session 已过期' : '尚未连接 AI'}</strong><small>{aiSession && !sessionExpired ? `会话有效至 ${formatDate(aiSession.expiresAt)}` : '配置后可启动；当前帖子与受众数据不会受影响。'}</small></span>
          <button type="button" onClick={onConfigureAi}><Settings2 size={14} />配置</button>
        </div>
        {blockers.length > 0 && <ul className="audience-ai-blockers">{blockers.map((message) => <li key={message}><CircleAlert size={13} />{message}</li>)}</ul>}
        {warnings.length > 0 && <ul className="audience-ai-warnings">{warnings.map((message) => <li key={message}><CircleAlert size={13} />{message}</li>)}</ul>}
        {!hasComments && <p className="audience-ai-block"><CircleAlert size={14} />该帖尚无已持久化评论，不能启动空分析。</p>}
        {!hasBody && <p className="audience-ai-block"><CircleAlert size={14} />原帖正文缺失，请先沿用原任务补齐正文。</p>}
        <div className="audience-ai-actions">
          {isActive ? <button type="button" className="danger" disabled={action !== null || status === 'cancelling'} onClick={() => void cancel()}>{action === 'cancel' ? <LoaderCircle className="spin" size={15} /> : <Pause size={15} />}取消</button>
            : terminalRun?.resumable ? <button type="button" className="primary" disabled={action !== null} onClick={() => void resume(terminalRun)}>{action === 'resume' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}继续原运行</button>
              : <button type="button" className="primary" disabled={!canStart || action !== null || scope.modules.length === 0} onClick={() => void start()}>{action === 'start' ? <LoaderCircle className="spin" size={15} /> : overview?.activeVersion ? <RefreshCw size={15} /> : <Sparkles size={15} />}{overview?.activeVersion ? '重新分析' : '开始分析'}</button>}
          <button type="button" disabled={previewing} onClick={() => void loadPreview()}>{previewing ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}刷新预览</button>
          <button type="button" disabled={!overview?.activeVersion} onClick={() => {
            if (!overview?.activeVersion) return
            setSelectedRunId(overview.activeVersion.runId)
            window.requestAnimationFrame(() => document.getElementById('audience-ai-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
          }}><FileText size={15} />查看上一版</button>
          <button type="button" disabled={artifactLinks.length === 0} title={artifactLinks.length ? `下载当前版本的 ${artifactLinks.length} 个结果文件` : '当前版本尚未生成可下载结果'} onClick={() => document.getElementById('audience-ai-downloads')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}><Download size={15} />下载结果</button>
        </div>
      </aside>
    </div>

    {(overview?.versions.length || selectedRunId) ? <section className="audience-ai-results" id="audience-ai-results" aria-label="分析结果">
      <header>
        <div><span>03</span><strong>分析结果</strong>{displayedRun?.stale && <i>输入已更新 · 旧版仍可查看</i>}</div>
        <label><span>版本</span><select value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}>{overview?.versions.map((version) => <option key={version.runId} value={version.runId}>{formatDate(version.completedAt || version.updatedAt)} · {statusLabel(version.stale ? 'stale' : version.status)} · {shortRunId(version.runId)}</option>)}</select></label>
        {artifactLinks.length > 0 && <div className="audience-ai-downloads" id="audience-ai-downloads">{artifactLinks.map((artifact) => <a key={artifact.id} href={api.artifactUrl(jobId, artifact)} download title={`下载 ${artifact.name}`}><Download size={14} /><span>{artifact.name}</span></a>)}</div>}
      </header>
      <nav role="tablist" aria-label="受众 AI 结果视图">{resultTabs.map((tab) => <button type="button" role="tab" aria-selected={resultTab === tab.id} className={resultTab === tab.id ? 'active' : ''} key={tab.id} onClick={() => { setResultTab(tab.id); setResultOffset(0); setResultQuery('') }}>{tab.label}</button>)}</nav>
      <div className="audience-ai-result-tools">
        <span>{displayedRun ? `${displayedRun.model?.provider || 'AI'} · ${displayedRun.model?.model || '模型未记录'} · ${displayedRun.promptVersion || 'Prompt v1'}` : '等待结果'}</span>
        {!resultTabs.find((tab) => tab.id === resultTab)?.analysisFields && resultTab !== 'overview' && <><label><Search size={14} /><input value={resultQuery} onChange={(event) => setResultQuery(event.target.value)} placeholder="筛选当前结果" /></label><label className="audience-ai-result-sort"><span>排序</span><select value={resultSort} onChange={(event) => setResultSort(event.target.value as ResultSort)}><option value="source">来源顺序</option><option value="confidence-desc">置信度从高到低</option><option value="confidence-asc">置信度从低到高</option><option value="name">名称</option></select></label></>}
      </div>
      {resultLoading ? <div className="audience-ai-result-empty"><LoaderCircle className="spin" size={22} /><span>正在读取已持久化结果</span></div>
        : !result ? <div className="audience-ai-result-empty"><FileText size={22} /><span>该版本尚无可展示结果</span></div>
          : resultTab === 'overview' ? <OverviewResult analysis={result.analysis || firstRecord(result.items)} coverage={result.coverage || displayedRun?.coverage} />
            : resultTabs.find((tab) => tab.id === resultTab)?.analysisFields ? <AnalysisSliceResult analysis={result.analysis || firstRecord(result.items)} fields={resultTabs.find((tab) => tab.id === resultTab)?.analysisFields || []} coverage={result.coverage || displayedRun?.coverage} />
            : visibleItems.length === 0 ? <div className="audience-ai-result-empty"><Search size={22} /><span>{resultQuery ? '当前筛选没有结果' : '该模块尚无结果'}</span></div>
              : <div className={`audience-ai-result-list ${resultTab}`}>{visibleItems.map((item, index) => <ResultItem
                key={resultKey(item, index)}
                item={item}
                tab={resultTab}
                onLocate={() => void locateEvidence(item)}
                onViewEvidence={(reference) => {
                  setResultTab('evidence')
                  setResultOffset(0)
                  setResultQuery(reference)
                }}
              />)}</div>}
      {result && result.total > result.limit && <footer className="audience-ai-result-pagination"><span>{result.offset + 1}-{Math.min(result.offset + result.limit, result.total)} / {result.total}</span><div><button type="button" title="上一页" disabled={result.offset === 0 || resultLoading} onClick={() => void loadResults(selectedRunId, resultTab, Math.max(0, result.offset - result.limit))}><ChevronLeft size={15} /></button><button type="button" title="下一页" disabled={result.offset + result.limit >= result.total || resultLoading} onClick={() => void loadResults(selectedRunId, resultTab, result.offset + result.limit)}><ChevronRight size={15} /></button></div></footer>}
    </section> : <div className="audience-ai-first-run"><BrainCircuit size={21} /><span><strong>尚无逐帖分析版本</strong><small>先核对输入覆盖，再从当前任务的已保存数据启动分析。</small></span></div>}
  </section>
}

function CoverageMetric({ label, value, warning = false, mono = false }: { label: string; value: string; warning?: boolean; mono?: boolean }) {
  return <div className={warning ? 'warning' : ''}><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{value}</dd></div>
}

function OverviewResult({ analysis, coverage }: { analysis?: Record<string, unknown>; coverage?: AudienceAiCoverage }) {
  if (!analysis || Object.keys(analysis).length === 0) return <div className="audience-ai-result-empty"><FileText size={22} /><span>综合结果仍在生成或该版本未导出总览</span></div>
  const preferred = ['summary', 'overallConclusion', 'themes', 'audienceSegments', 'contentFit', 'contentOpportunities', 'risks', 'dataQuality', 'limitations']
  const entries = Object.entries(analysis).sort(([left], [right]) => rankField(left, preferred) - rankField(right, preferred))
  return <div className="audience-ai-overview-result">{entries.map(([key, value]) => <section key={key}><h4>{fieldLabel(key)}</h4><StructuredValue value={value} /></section>)}{coverage && <section><h4>数据覆盖</h4><StructuredValue value={coverage} /></section>}</div>
}

function AnalysisSliceResult({ analysis, fields, coverage }: { analysis?: Record<string, unknown>; fields: string[]; coverage?: AudienceAiCoverage }) {
  const entries = fields.flatMap((field) => {
    if (field === 'coverage' && coverage) return [[field, coverage] as const]
    return analysis && Object.prototype.hasOwnProperty.call(analysis, field) ? [[field, analysis[field]] as const] : []
  })
  if (entries.length === 0) return <div className="audience-ai-result-empty"><FileText size={22} /><span>该版本尚未生成此模块，其他已完成结果仍可查看</span></div>
  return <div className="audience-ai-overview-result focused">{entries.map(([key, value]) => <section key={key}><h4>{fieldLabel(key)}</h4><StructuredValue value={value} /></section>)}</div>
}

function ResultItem({
  item,
  tab,
  onLocate,
  onViewEvidence,
}: {
  item: AudienceAiResultItem
  tab: ResultTab
  onLocate: () => void
  onViewEvidence: (reference: string) => void
}) {
  const evidence = item as AudienceAiEvidence
  const id = String(item.commentId || item.rootThreadId || item.userId || item.segmentId || evidence.evidenceId || evidence.id || evidence.entityId || '')
  const title = String(item.displayName || item.name || item.theme || item.label || item.sentiment || item.stance || `${tab === 'comments' ? '评论' : ['users', 'profiles'].includes(tab) ? '用户' : tab === 'evidence' ? '证据' : '主题'} ${id ? shortRunId(id) : ''}`)
  const secondary = [item.stance, item.intent, item.interactionRole, item.confidence != null ? `置信度 ${formatConfidence(item.confidence)}` : null].filter(Boolean).join(' · ')
  const hidden = new Set(['displayName', 'name', 'theme', 'label', 'stance', 'intent', 'interactionRole', 'confidence', 'evidenceRefs'])
  const bodyEntries = Object.entries(item).filter(([key]) => !hidden.has(key) && !['commentId', 'userId', 'rootThreadId', 'segmentId', 'entityId', 'evidenceId', 'id'].includes(key))
  const canLocate = tab === 'evidence' && ['comment', 'user'].includes(String(evidence.entityType || ''))
  return <article>
    <header><span>{['users', 'profiles'].includes(tab) ? <UsersRound size={15} /> : tab === 'evidence' ? <MapPin size={15} /> : <FileText size={15} />}</span><div><strong>{title}</strong>{secondary && <small>{secondary}</small>}</div>{canLocate && <button type="button" title="定位到原始数据" onClick={onLocate}><ExternalLink size={14} />定位</button>}</header>
    {evidence.excerpt && <blockquote>{evidence.excerpt}</blockquote>}
    {bodyEntries.length > 0 && <details><summary><span>查看分析详情</span><ChevronRight size={14} /></summary><dl>{bodyEntries.slice(0, 12).map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd><StructuredValue value={value} compact /></dd></div>)}</dl></details>}
    {Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && <footer><ShieldCheck size={13} /><span>{item.evidenceRefs.length} 条已关联证据</span><select aria-label={`查看 ${title} 的证据`} title="查看证据" defaultValue="" onChange={(event) => {
      const reference = event.currentTarget.value
      event.currentTarget.value = ''
      if (reference) onViewEvidence(reference)
    }}><option value="" disabled>查看证据</option>{item.evidenceRefs.map((reference) => <option value={reference} key={reference}>{reference}</option>)}</select></footer>}
  </article>
}

function StructuredValue({ value, compact = false }: { value: unknown; compact?: boolean }) {
  if (value == null || value === '') return <span className="audience-ai-unknown">unknown</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value === 'number') return <span>{Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toFixed(2)}</span>
  if (typeof value === 'string') return <p>{value}</p>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="audience-ai-unknown">无</span>
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return <ul className="audience-ai-value-list">{value.slice(0, compact ? 6 : 20).map((item, index) => <li key={`${index}-${String(item)}`}>{String(item)}</li>)}</ul>
    return <div className="audience-ai-structured-list">{value.slice(0, compact ? 4 : 20).map((item, index) => <StructuredValue key={index} value={item} compact />)}</div>
  }
  if (typeof value === 'object') return <dl className="audience-ai-structured-object">{Object.entries(value as Record<string, unknown>).slice(0, compact ? 8 : 30).map(([key, nested]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd><StructuredValue value={nested} compact /></dd></div>)}</dl>
  return <span>{String(value)}</span>
}

function defaultScope(aiSessionId?: string | null): AudienceAiScope {
  return {
    aiSessionId: aiSessionId || null,
    includeTopLevelComments: true,
    includeReplies: true,
    includeUsers: true,
    profileMode: 'none',
    profileUserLimit: 0,
    profilePostLimitPerUser: 0,
    profilePostTotalLimit: 0,
    modules: defaultModules,
    outputLanguage: 'zh-CN',
    evidenceStrictness: 'strict',
    incrementalOnly: false,
    maxEstimatedTokens: 0,
    maxEstimatedCost: 0,
  }
}

function normalizeOverview(value: AudienceAiOverview): AudienceAiOverview {
  const candidate = value as AudienceAiOverview & { overview?: AudienceAiOverview; run?: AudienceAiRun }
  const source = candidate.overview || candidate
  const versions = Array.isArray(source.versions) ? source.versions : []
  return {
    ...source,
    status: normalizeAudienceAiStatus(source.status),
    currentRun: normalizeRun(source.currentRun || candidate.run || null),
    activeVersion: normalizeRun(source.activeVersion || null),
    versions: versions.map((run) => normalizeRun(run) as AudienceAiRun),
  }
}

function normalizePreview(value: AudienceAiPreview, jobId: string, postId: string): AudienceAiPreview {
  const candidate = value as AudienceAiPreview & { estimates?: Record<string, unknown>; counts?: AudienceAiCoverage }
  const estimate = (candidate.estimate || candidate.estimates || {}) as Record<string, unknown>
  return {
    ...candidate,
    jobId: candidate.jobId || jobId,
    postId: candidate.postId || postId,
    coverage: normalizeCoverage(candidate.coverage || candidate.counts || {}),
    estimatedChunks: candidate.estimatedChunks ?? numberOrUndefined(estimate.estimatedChunks) ?? numberOrUndefined(estimate.chunks) ?? numberOrUndefined(estimate.estimatedUnits),
    estimatedCalls: candidate.estimatedCalls ?? numberOrUndefined(estimate.estimatedCalls) ?? numberOrUndefined(estimate.calls) ?? numberOrUndefined(estimate.estimatedUnits),
    estimatedTokens: candidate.estimatedTokens ?? numberOrUndefined(estimate.tokens) ?? numberOrUndefined(estimate.estimatedTotalTokens),
    estimatedCost: candidate.estimatedCost ?? nullableNumber(estimate.cost ?? estimate.estimatedCost),
    estimatedNetworkRequests: candidate.estimatedNetworkRequests ?? numberOrUndefined(estimate.networkRequests),
    estimated: candidate.estimated ?? Boolean(estimate.costEstimated),
  }
}

function normalizeResults(value: AudienceAiResultsResponse, module: AudienceAiResultsModule, runId: string, offset: number): AudienceAiResultsResponse {
  const candidate = value as AudienceAiResultsResponse & { results?: AudienceAiResultItem[] | Record<string, unknown> }
  const data = candidate.data
  const results = Array.isArray(candidate.items)
    ? candidate.items
    : Array.isArray(data)
      ? data
      : Array.isArray(candidate.results)
        ? candidate.results
        : []
  const structured = data && !Array.isArray(data) ? data : (!Array.isArray(candidate.results) ? candidate.results : undefined)
  const analysis = candidate.analysis || (module === 'analysis' ? structured : undefined)
  const coverage = candidate.coverage || (module === 'coverage' && structured ? structured as AudienceAiCoverage : undefined)
  return {
    ...candidate,
    runId: candidate.runId || runId,
    module: candidate.module || module,
    total: Number(candidate.total ?? results.length),
    offset: Number(candidate.offset ?? offset),
    limit: Number(candidate.limit ?? 50),
    items: results,
    analysis,
    coverage: coverage ? normalizeCoverage(coverage) : undefined,
  }
}

function normalizeRun(run: AudienceAiRun | null): AudienceAiRun | null {
  if (!run) return null
  return {
    ...run,
    status: normalizeAudienceAiStatus(run.status) || 'not_started',
    coverage: run.coverage ? normalizeCoverage(run.coverage) : undefined,
  }
}

function normalizeAudienceAiStatus(status?: AudienceAiStatus | string): AudienceAiStatus | undefined {
  if (!status) return undefined
  if (status === 'idle') return 'not_started'
  return status as AudienceAiStatus
}

function normalizeCoverage(value: AudienceAiCoverage): AudienceAiCoverage {
  const source = value as AudienceAiCoverage & {
    commentsIncluded?: number
    topLevelCommentsIncluded?: number
    repliesIncluded?: number
    uniqueUsersIncluded?: number
    profilesSelected?: number
    collectionStatus?: string
  }
  return {
    ...source,
    collectedComments: source.collectedComments ?? source.commentsIncluded,
    topLevelComments: source.topLevelComments ?? source.topLevelCommentsIncluded,
    replies: source.replies ?? source.repliesIncluded,
    uniqueUsers: source.uniqueUsers ?? source.uniqueUsersIncluded,
    profilesUsed: source.profilesUsed ?? source.profilesSelected,
    coverageStatus: source.coverageStatus ?? source.collectionStatus,
  }
}

function emptyOverview(jobId: string, postId: string): AudienceAiOverview {
  return { available: false, jobId, postId, status: 'not_started', currentRun: null, activeVersion: null, versions: [] }
}

function firstRecord(items: AudienceAiResultItem[]): Record<string, unknown> | undefined {
  return items[0] as Record<string, unknown> | undefined
}

function filterResultItems(items: AudienceAiResultItem[], query: string, sort: ResultSort) {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  const filtered = normalized ? items.filter((item) => JSON.stringify(item).toLocaleLowerCase('zh-CN').includes(normalized)) : [...items]
  if (sort === 'source') return filtered
  return filtered.sort((left, right) => {
    if (sort === 'name') return resultItemName(left).localeCompare(resultItemName(right), 'zh-CN')
    const delta = Number(left.confidence ?? -1) - Number(right.confidence ?? -1)
    return sort === 'confidence-desc' ? -delta : delta
  })
}

function resultItemName(item: AudienceAiResultItem) {
  return String(item.displayName || item.name || item.theme || item.label || item.commentId || item.userId || '')
}

function resultKey(item: AudienceAiResultItem, index: number) {
  return String(item.commentId || item.rootThreadId || item.userId || item.segmentId || item.evidenceId || item.id || item.entityId || index)
}

function makeIdempotencyKey(jobId: string, postId: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `audience-ai:${jobId}:${postId}:${random}`
}

function statusIcon(status: AudienceAiStatus) {
  if (activeStatuses.has(status)) return <LoaderCircle className="spin" size={13} />
  if (status === 'completed') return <Check size={13} />
  if (status === 'not_started') return <BrainCircuit size={13} />
  return <CircleAlert size={13} />
}

function statusLabel(status: AudienceAiStatus) {
  const labels: Record<AudienceAiStatus, string> = {
    not_started: '未分析', snapshotting: '冻结输入快照', waiting_profile_enrichment: '等待主页补采', collecting_profile_headers: '补采主页头部', collecting_profile_posts: '采集近期公开帖子', analyzing_comments: '分析评论与线程', analyzing_users: '分析用户', synthesizing: '综合归纳', validating: '校验证据', exporting: '生成产物', cancelling: '正在取消', partial: '部分完成', completed: '已完成', blocked: '等待处理', interrupted: '可继续', failed: '失败', cancelled: '已取消', stale: '输入已更新',
  }
  return labels[status] || status
}

function stageProgress(status: AudienceAiStatus) {
  const stages: Partial<Record<AudienceAiStatus, number>> = { snapshotting: 5, waiting_profile_enrichment: 10, collecting_profile_headers: 18, collecting_profile_posts: 24, analyzing_comments: 42, analyzing_users: 67, synthesizing: 82, validating: 91, exporting: 96, completed: 100 }
  return stages[status] || 0
}

function fieldLabel(field: string) {
  const labels: Record<string, string> = {
    summary: '总体结论', overallConclusion: '总体结论', themes: '主要主题', audienceSegments: '受众分群', contentFit: '原帖与受众匹配', contentOpportunities: '内容机会', risks: '风险提醒', dataQuality: '数据质量', limitations: '覆盖局限', commentId: '评论 ID', rootThreadId: '线程 ID', userId: '用户 ID', level: '层级', sentiment: '情绪', stance: '相对原帖立场', intent: '表达意图', needs: '明确需求', questions: '问题', objections: '异议', painPoints: '痛点', desiredOutcomes: '期望结果', engagementRole: '互动角色', actionability: '可行动性', qualityFlags: '质量标记', mainThemes: '主要主题', expressedNeeds: '表达需求', expressedConcerns: '表达顾虑', stanceToPost: '对原帖立场', engagementDepth: '互动深度', observableInterests: '可观察兴趣', possibleContentNeeds: '潜在内容需求', profileCoverage: '主页覆盖', sourceScope: '来源范围', entityType: '证据类型', entityId: '实体 ID', field: '来源字段', excerpt: '原文摘录', validated: '已校验', authorParticipated: '作者参与', interactionDepth: '互动深度', sentimentShift: '情绪变化', mainViewpoints: '主要观点', disagreements: '分歧', consensus: '共识', unresolvedQuestions: '未解决问题', highValueReplyIds: '高价值回复', evolution: '讨论演化', commentIds: '评论范围', confidence: '置信度', evidenceRefs: '证据引用', coverageStatus: '覆盖状态', skipReasons: '跳过原因', originalBodyAvailable: '原帖正文', mediaAnalysisAvailable: '媒体分析', commentsAnalyzed: '已分析评论', usersAnalyzed: '已分析用户', profilesUsed: '使用主页', profilePostsUsed: '使用主页帖子', snapshotAt: '快照时间',
  }
  return labels[field] || field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
}

function rankField(field: string, preferred: string[]) {
  const index = preferred.indexOf(field)
  return index === -1 ? preferred.length + 1 : index
}

function clampInteger(value: string, min: number, max: number) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return min
  return Math.max(min, Math.min(max, parsed))
}

function numberOrUndefined(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nullableNumber(value: unknown) {
  return value === null ? null : numberOrUndefined(value)
}

function estimateNetworkRequests(scope: AudienceAiScope) {
  if (scope.profileMode === 'collect_missing_header') return scope.profileUserLimit
  if (scope.profileMode === 'recent_public_posts') return scope.profileUserLimit + scope.profilePostTotalLimit
  return 0
}

function formatNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN') : '-'
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
}

function formatDate(value?: string | null) {
  if (!value) return '时间未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatConfidence(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${Math.round(parsed * 100)}%` : 'unknown'
}

function shortRunId(value?: string | null) {
  if (!value) return '-'
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value
}

function shortRevision(value?: string | null) {
  if (!value) return '-'
  return value.length > 12 ? value.slice(0, 12) : value
}

function sumTokenUsage(usage?: Record<string, number>) {
  if (!usage) return 0
  return Number(usage.total || usage.totalTokens || Object.values(usage).reduce((sum, value) => sum + Number(value || 0), 0))
}

function messageOf(value: string | { code?: string; message: string }) {
  return typeof value === 'string' ? value : value.message
}
