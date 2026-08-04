import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  FileText,
  Gauge,
  Layers3,
  LoaderCircle,
  Mail,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react'

import { api, type ApiError } from './api'
import type {
  ApplicationBatch,
  ApplicationBatchItemStatus,
  ApplicationBatchPreflight,
  ApplicationBatchRequest,
  ApplicationContactCandidate,
  ApplicationResult,
} from './types'

type BatchApplicationPanelProps = {
  jobId: string
  items: ApplicationResult[]
  aiSessionId?: string | null
  standalone?: boolean
  onOpenItem: (item: ApplicationResult) => void
}

const MAX_BATCH_SIZE = 10
const CANDIDATE_PAGE_SIZE = 20
const DEFAULT_ATTACHMENT_TEMPLATE = '{candidateName}-{jobTitle}-简历'

export function BatchApplicationPanel({ jobId, items, aiSessionId, standalone = false, onOpenItem }: BatchApplicationPanelProps) {
  const [expanded, setExpanded] = useState(standalone)
  const [query, setQuery] = useState('')
  const [candidateQuery, setCandidateQuery] = useState('')
  const [candidateOffset, setCandidateOffset] = useState(0)
  const [candidatePage, setCandidatePage] = useState<{
    jobId: string
    query: string
    offset: number
    total: number
    items: ApplicationResult[]
  } | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateError, setCandidateError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scopeNoteIds, setScopeNoteIds] = useState<string[]>([])
  const [approvals, setApprovals] = useState<Record<string, string>>({})
  const [preflight, setPreflight] = useState<ApplicationBatchPreflight | null>(null)
  const [batches, setBatches] = useState<ApplicationBatch[]>([])
  const [batch, setBatch] = useState<ApplicationBatch | null>(null)
  const [batchJobId, setBatchJobId] = useState(jobId)
  const [attachmentTemplate, setAttachmentTemplate] = useState(DEFAULT_ATTACHMENT_TEMPLATE)
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(1)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [streamState, setStreamState] = useState<'idle' | 'live' | 'reconnecting'>('idle')
  const refreshTimer = useRef<number | null>(null)
  const selectionSeedJob = useRef<string | null>(null)
  const candidateRequest = useRef(0)
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const itemById = useMemo(() => new Map(items.map((item) => [item.note_id, item])), [items])
  const preflightById = useMemo(
    () => new Map((preflight?.items || []).map((item) => [item.noteId, item])),
    [preflight],
  )

  useEffect(() => {
    selectionSeedJob.current = null
    setSelected(new Set())
    setScopeNoteIds([])
    setApprovals({})
    setPreflight(null)
    setBatch(null)
    setBatchJobId(jobId)
    setBatches([])
    setNotice(null)
    setExpanded(standalone)
    setQuery('')
    setCandidateQuery('')
    setCandidateOffset(0)
    setCandidatePage(null)
    setCandidateError('')
    let cancelled = false
    void api.applicationBatches(jobId).then(({ batches: saved }) => {
      if (cancelled) return
      const ordered = [...saved].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      setBatches(ordered)
      setBatch(ordered[0] || null)
      setBatchJobId(jobId)
    }).catch((error: ApiError) => {
      if (!cancelled) setNotice({ tone: 'error', text: error.message })
    })
    return () => { cancelled = true }
  }, [jobId, standalone])

  useEffect(() => {
    if (!items.length || selectionSeedJob.current === jobId) return
    const defaults = items.filter(likelyReady).slice(0, MAX_BATCH_SIZE).map((item) => item.note_id)
    setSelected(new Set(defaults))
    selectionSeedJob.current = jobId
  }, [items, jobId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCandidateOffset(0)
      setCandidateQuery(normalizedQuery)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [normalizedQuery])

  useEffect(() => {
    if (!expanded) return
    const requestId = ++candidateRequest.current
    setCandidateLoading(true)
    setCandidateError('')
    void api.results(jobId, candidateOffset, CANDIDATE_PAGE_SIZE, {
      analysisMode: 'job',
      query: candidateQuery,
      sort: 'newest',
      timeRange: 'all',
    }).then((payload) => {
      if (requestId !== candidateRequest.current) return
      setCandidatePage({
        jobId,
        query: candidateQuery,
        offset: payload.offset,
        total: payload.total,
        items: payload.items,
      })
    }).catch((error: ApiError) => {
      if (requestId !== candidateRequest.current) return
      setCandidateError(error.message || '全量岗位读取失败，当前继续显示原岗位页。')
    }).finally(() => {
      if (requestId === candidateRequest.current) setCandidateLoading(false)
    })
  }, [candidateOffset, candidateQuery, expanded, jobId])

  useEffect(() => {
    if (!batch?.batchId || batchJobId !== jobId) {
      setStreamState('idle')
      return
    }
    let closed = false
    setStreamState('reconnecting')
    const refresh = () => {
      if (closed || refreshTimer.current !== null) return
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null
        void api.applicationBatch(jobId, batch.batchId).then((next) => {
          if (closed) return
          setBatch(next)
          setBatches((current) => replaceBatch(current, next))
          setStreamState('live')
        }).catch((error: ApiError) => {
          if (!closed) setNotice({ tone: 'error', text: error.message })
        })
      }, 120)
    }
    const close = api.subscribeApplicationBatch(jobId, batch.batchId, (event) => {
      if (closed) return
      if (event.type === 'snapshot' && event.batch) {
        setBatch(event.batch)
        setBatches((current) => replaceBatch(current, event.batch!))
        setStreamState('live')
      } else if (event.type === 'batch') {
        refresh()
      } else if (event.type === 'error') {
        setStreamState('reconnecting')
        if (event.error?.message) setNotice({ tone: 'error', text: event.error.message })
      }
    }, () => {
      if (!closed) setStreamState('reconnecting')
    })
    return () => {
      closed = true
      close()
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [jobId, batchJobId, batch?.batchId])

  const batchItemByNoteId = useMemo(
    () => new Map((batch?.items || []).map((item) => [item.noteId, item])),
    [batch?.items],
  )
  const hasCurrentCandidatePage = candidatePage?.jobId === jobId
    && candidatePage.query === candidateQuery
    && candidatePage.offset === candidateOffset
    && candidateQuery === normalizedQuery
  const candidateItems = hasCurrentCandidatePage ? candidatePage.items : items
  const candidateTotal = hasCurrentCandidatePage ? candidatePage.total : items.length
  const rows = useMemo(() => {
    return candidateItems.filter((item) => {
      if (!normalizedQuery) return true
      const checked = preflightById.get(item.note_id)
      const contactText = [
        firstApplicationContact(item)?.address,
        checked?.contact?.address,
        ...(checked?.contactResolution?.candidates || []).map((candidate) => candidate.address),
      ].join(' ')
      const savedBatchText = batchItemSearchText(batchItemByNoteId.get(item.note_id))
      return `${applicationResultSearchText(item)} ${contactText} ${savedBatchText}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [batchItemByNoteId, candidateItems, normalizedQuery, preflightById])
  const visibleBatchItems = useMemo(() => {
    if (!batch) return []
    if (!normalizedQuery) return batch.items
    return batch.items.filter((item) => batchItemSearchText(item).includes(normalizedQuery))
  }, [batch, normalizedQuery])
  const visibleBatchEmails = visibleBatchItems.filter((item) => typeof item.payload.body === 'string' && item.payload.body.trim())
  const totalBatchEmails = batch?.items.filter((item) => typeof item.payload.body === 'string' && item.payload.body.trim()).length || 0

  const selectedIds = [...selected]
  const selectedReadyCount = selectedIds.filter((noteId) => preflightById.get(noteId)?.status === 'ready').length
  const currentBatchReady = batch?.status === 'ready'
  const canCreate = selected.size > 0 && selected.size <= MAX_BATCH_SIZE && !busy
  const batchTerminal = batch ? ['completed', 'cancelled'].includes(batch.status) : true

  const buildRequest = (noteIds: string[], nextApprovals = approvals): ApplicationBatchRequest => ({
    noteIds,
    contactApprovals: noteIds.flatMap((noteId) => nextApprovals[noteId]
      ? [{ noteId, evidenceHash: nextApprovals[noteId], confirmed: true as const }]
      : []),
    defaultAttachmentTemplate: attachmentTemplate.trim() || DEFAULT_ATTACHMENT_TEMPLATE,
    minIntervalMs: Math.max(0, Math.min(60, minIntervalSeconds)) * 1_000,
    ...(aiSessionId ? { aiSessionId } : {}),
    idempotencyKey: createRequestIdempotencyKey(noteIds, nextApprovals, attachmentTemplate, minIntervalSeconds, aiSessionId),
  })

  async function runDryRun(noteIds = selectedIds, nextApprovals = approvals) {
    if (!noteIds.length) {
      setNotice({ tone: 'error', text: '请先选择至少一个岗位。' })
      return
    }
    setBusy('dry-run')
    setNotice(null)
    try {
      const result = await api.dryRunApplicationBatch(jobId, buildRequest(noteIds, nextApprovals))
      setPreflight(result)
      setScopeNoteIds(noteIds)
      setSelected(new Set(result.readyNoteIds))
      const blocked = result.items.length - result.readyNoteIds.length
      setNotice({
        tone: blocked ? 'info' : 'success',
        text: blocked ? `Dry Run 完成：${result.readyNoteIds.length} 项就绪，${blocked} 项待处理。` : `Dry Run 完成：${result.readyNoteIds.length} 项全部就绪。`,
      })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as ApiError).message })
    } finally {
      setBusy('')
    }
  }

  async function confirmContact(noteId: string, candidate: ApplicationContactCandidate) {
    const next = { ...approvals, [noteId]: candidate.evidenceHash }
    setApprovals(next)
    const nextScope = scopeNoteIds.includes(noteId) ? scopeNoteIds : [...scopeNoteIds, noteId].slice(0, MAX_BATCH_SIZE)
    await runDryRun(nextScope.length ? nextScope : [noteId], next)
  }

  async function createBatch() {
    if (!canCreate) return
    setBusy('create')
    setNotice(null)
    try {
      const result = await api.createApplicationBatch(jobId, buildRequest(selectedIds))
      setPreflight(result.preflight)
      setBatch(result.batch)
      setBatchJobId(jobId)
      setBatches((current) => replaceBatch(current, result.batch))
      setNotice({ tone: 'success', text: `批次已冻结，${result.batch.counts.ready || 0} 封邮件等待审批。` })
    } catch (error) {
      const apiError = error as ApiError
      if (isPreflightDetails(apiError.details)) setPreflight(apiError.details)
      setNotice({ tone: 'error', text: apiError.message })
    } finally {
      setBusy('')
    }
  }

  async function approveBatch() {
    if (!batch || batch.status !== 'ready') return
    await runBatchAction('approve', async () => api.approveApplicationBatch(jobId, batch.batchId, batch.revision), '批次审批已绑定当前收件人、正文、附件和 SMTP 配置。')
  }

  async function controlBatch(action: 'start' | 'pause' | 'resume' | 'cancel') {
    if (!batch) return
    const success = {
      start: '批次已进入串行发送队列。',
      pause: '批次已暂停，正在发送中的单项仍按真实结果落账。',
      resume: '批次已恢复。',
      cancel: '批次已取消，尚未发送的项目已停止。',
    }[action]
    await runBatchAction(action, () => api.controlApplicationBatch(jobId, batch.batchId, action, batch.revision), success)
  }

  async function runBatchAction(action: string, operation: () => Promise<ApplicationBatch>, success: string) {
    setBusy(action)
    setNotice(null)
    try {
      const next = await operation()
      setBatch(next)
      setBatches((current) => replaceBatch(current, next))
      setNotice({ tone: 'success', text: success })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as ApiError).message })
      if (batch) {
        void api.applicationBatch(jobId, batch.batchId).then((next) => {
          setBatch(next)
          setBatches((current) => replaceBatch(current, next))
        }).catch(() => {})
      }
    } finally {
      setBusy('')
    }
  }

  async function reconcileItem(item: ApplicationBatch['items'][number], outcome: 'sent' | 'not_sent') {
    if (!batch || item.status !== 'unknown_manual_review') return
    const action = `reconcile-${item.itemId}`
    setBusy(action)
    setNotice(null)
    try {
      const next = await api.reconcileApplicationBatchItem(jobId, batch.batchId, item.itemId, batch.revision, item.revision, outcome)
      setBatch(next)
      setBatches((current) => replaceBatch(current, next))
      setNotice({ tone: 'success', text: outcome === 'sent' ? '已记录为服务器接收，批次不会重复发送。' : '已记录为未发送，可从暂停批次恢复重试。' })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as ApiError).message })
    } finally {
      setBusy('')
    }
  }

  function toggle(noteId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) {
        if (next.size >= MAX_BATCH_SIZE) {
          setNotice({ tone: 'error', text: `本阶段每批最多 ${MAX_BATCH_SIZE} 个岗位。` })
          return current
        }
        next.add(noteId)
      } else {
        next.delete(noteId)
      }
      return next
    })
  }

  return (
    <section id="batch-application-panel" className={`batch-application-panel ${standalone ? 'standalone' : ''}`} aria-label="批量投递工作台">
      <header className="batch-application-header">
        <div className="batch-application-heading">
          <span className="batch-application-icon"><Layers3 size={19} /></span>
          <div><span className="step-label">BATCH APPLICATION DELIVERY</span><h3>批量投递工作台</h3></div>
        </div>
        <div className="batch-application-header-actions">
          {batch && <span className={`batch-status-badge ${batch.status}`}>{batchStatusLabel(batch.status)}</span>}
          {batch && !batchTerminal && <span className={`batch-stream-state ${streamState}`}><i />{streamState === 'live' ? '实时' : '连接中'}</span>}
          {!standalone && <button type="button" className="icon-button" title={expanded ? '收起批量投递工作台' : '展开批量投递工作台'} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
        </div>
      </header>

      {expanded && <div className="batch-application-guide">
        <span><Paperclip size={14} /><strong>附件准备</strong><small>预检会显示原文件名、最终投递名、大小和校验；冻结批次时才应用命名规则。</small></span>
        <span><Gauge size={14} /><strong>批量准备</strong><small>先 Dry Run，逐条处理收件人、正文质量和阻塞项，再生成冻结预览。</small></span>
        <span><ShieldCheck size={14} /><strong>批量投递</strong><small>审批后按间隔逐封发送；超时会进入人工核对，不会自动重复发送。</small></span>
      </div>}

      {expanded && <div className="batch-application-body">
        <div className="batch-toolbar">
          <label className="batch-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索岗位、邮箱、主题或附件名" /><span className="batch-search-summary" aria-live="polite"><b>待投岗位 {candidateTotal} 项</b><b>当前页 {rows.length} 项</b>{batch && <b>当前批次 {visibleBatchItems.length} 封</b>}</span></label>
          <div className="batch-selection-actions">
            <span>已选 <strong>{selected.size}</strong> / {MAX_BATCH_SIZE}</span>
            <button type="button" onClick={() => setSelected(new Set((preflight?.readyNoteIds || rows.filter(likelyReady).map((item) => item.note_id)).slice(0, MAX_BATCH_SIZE)))}><CheckCircle2 size={15} />只选就绪</button>
            <button type="button" onClick={() => setSelected(new Set())}><XCircle size={15} />清空</button>
          </div>
          <details className="batch-settings">
            <summary><SlidersHorizontal size={15} />批次设置</summary>
            <div>
              <label><span>默认附件格式</span><input value={attachmentTemplate} onChange={(event) => setAttachmentTemplate(event.target.value)} /></label>
              <label><span>发送间隔（秒）</span><input type="number" min={0} max={60} step={1} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value) || 0)} /></label>
            </div>
          </details>
        </div>

        {notice && <div className={`batch-notice ${notice.tone}`}>{notice.tone === 'error' ? <AlertTriangle size={16} /> : notice.tone === 'success' ? <CheckCircle2 size={16} /> : <Gauge size={16} />}<span>{notice.text}</span></div>}
        {candidateError && <div className="batch-notice error"><AlertTriangle size={16} /><span>{candidateError}</span></div>}

        <div className="batch-table-wrap">
          <table className="batch-application-table">
            <thead><tr><th aria-label="选择" /><th>岗位</th><th>收件邮箱</th><th>文案质量</th><th>主题与附件</th><th>状态 / 修复</th></tr></thead>
            <tbody>{rows.map((item) => {
              const checked = preflightById.get(item.note_id)
              const savedBatchItem = batchItemByNoteId.get(item.note_id)
              const savedRecipient = typeof savedBatchItem?.payload.recipient === 'string' ? savedBatchItem.payload.recipient : ''
              const savedSubject = typeof savedBatchItem?.payload.subject === 'string' ? savedBatchItem.payload.subject : ''
              const savedFilenames = Array.isArray(savedBatchItem?.payload.finalFilenames) ? savedBatchItem.payload.finalFilenames.map(String) : []
              const resultContact = firstApplicationContact(item)
              const resolvedContact = checked?.contact || resultContact
              const email = resolvedContact?.address || savedRecipient
              const contactEvidence = resolvedContact ? applicationContactEvidence(item, resolvedContact) : null
              const contactWasNormalized = Boolean(
                resolvedContact?.normalizationApplied
                || resolvedContact?.verificationStatus?.toLowerCase().includes('normalized'),
              )
              const status = checked?.status || savedBatchItem?.status
              const qualityPassed = item.draftVersion?.qualityStatus === 'passed'
              const candidates = checked?.contactResolution?.candidates || []
              const collectionIncomplete = checked?.contactResolution && checked.contactResolution.collectionStatus !== 'complete'
              return <tr key={item.note_id} className={`${selected.has(item.note_id) ? 'selected' : ''} ${status ? `status-${status}` : ''}`}>
                <td data-label="选择"><label className="batch-checkbox"><input type="checkbox" checked={selected.has(item.note_id)} onChange={(event) => toggle(item.note_id, event.target.checked)} /><span><Check size={13} /></span></label></td>
                <td data-label="岗位"><strong>{item.job_card?.role_name || item.title || '未命名岗位'}</strong><small>{item.title}</small><small className={`batch-body-status ${item.body?.trim() ? 'ready' : 'pending'}`}>{item.body?.trim() ? `正文已保存 · ${item.body.trim().length} 字` : '正文待续采'}</small>{item.body?.trim() && <button type="button" className="batch-body-open" onClick={() => onOpenItem(item)}><FileText size={12} />查看正文</button>}</td>
                <td data-label="收件邮箱">
                  {email ? <><strong className="batch-email"><Mail size={13} />{email}</strong><span className={`contact-source ${resolvedContact?.source || (savedRecipient ? 'batch' : 'body')}`}>{resolvedContact ? contactSourceLabel(resolvedContact.source, resolvedContact.verificationStatus, resolvedContact.normalizationApplied) : '发送批次'}</span></> : <span className="batch-muted">待解析</span>}
                  {contactEvidence && (contactWasNormalized || resolvedContact?.source === 'image') && <small className="batch-contact-evidence" title={contactEvidence.evidenceText}>{contactWasNormalized ? '原始写法' : 'OCR 证据'}：{contactEvidence.evidenceText}</small>}
                  {resolvedContact?.source === 'image' && <button type="button" className="batch-contact-evidence-action" onClick={() => onOpenItem(item)} title={contactEvidence?.sourceImageIndex ? `查看第 ${contactEvidence.sourceImageIndex} 张图片中的邮箱证据` : '查看岗位图片中的邮箱证据'}><Eye size={12} />查看图片证据</button>}
                  {collectionIncomplete && <small className="batch-warning">评论采集未完成</small>}
                </td>
                <td data-label="文案质量"><span className={`quality-pill ${qualityPassed ? 'passed' : 'pending'}`}>{qualityPassed ? '门禁通过' : '待复检'}</span><small>{item.cover_letter_evaluation?.score ?? '-'} 分 · v{item.draftVersion?.version ?? '-'}</small></td>
                <td data-label="主题与附件">
                  <strong className="batch-subject">{checked?.preview?.subject || savedSubject || item.outreach?.email_subject || '主题待生成'}</strong>
                  {checked?.attachments?.length ? checked.attachments.map((attachment) => <span className="batch-filename" key={attachment.attachmentId}><Paperclip size={12} /><span><s>{attachment.originalName}</s><b>{attachment.finalDisplayName}</b><small>{[attachment.size ? formatBytes(attachment.size) : '', attachment.sha256 ? `SHA-256 ${attachment.sha256.slice(0, 10)}...` : '待校验'].filter(Boolean).join(' · ')}</small></span></span>) : savedFilenames.length ? <span className="batch-filename"><Paperclip size={12} /><span>{savedFilenames.map((filename) => <b key={filename}>{filename}</b>)}</span></span> : <>
                    {item.attachmentRequirement?.detected ? <span className="batch-article-attachment-rule" title={item.attachmentRequirement.evidence}><Paperclip size={12} /><span><small>文章附件格式</small><b>{item.attachmentRequirement.template}</b><em>选择简历后按此格式生成发送名</em></span></span> : <span className="batch-default-attachment-rule"><Paperclip size={12} /><span><small>默认附件格式</small><b>{attachmentTemplate}</b></span></span>}
                    <small className="batch-muted">附件待预检</small>
                  </>}
                </td>
                <td data-label="状态 / 修复">
                  <span className={`item-status ${status || 'resolving'}`}>{status ? itemStatusLabel(status) : '待 Dry Run'}</span>
                  {checked?.blockers?.map((blocker) => <small className="batch-blocker" key={blocker.code}>{blocker.message}</small>)}
                  {checked?.canPrepare && checked.status !== 'ready' && <button type="button" className="batch-row-action" onClick={() => toggle(item.note_id, true)}>纳入自动准备</button>}
                  {checked && !checked.canPrepare && checked.status !== 'ready' && candidates.length === 0 && <button type="button" className="batch-row-action" onClick={() => onOpenItem(item)}>打开岗位</button>}
                  {candidates.length > 0 && <div className="contact-review-list">{candidates.map((candidate) => <button type="button" className={approvals[item.note_id] === candidate.evidenceHash ? 'confirmed' : ''} key={candidate.evidenceHash} onClick={() => void confirmContact(item.note_id, candidate)} title={candidate.evidenceText}><span>{candidate.address}</span><small>{contactSourceLabel(candidate.source, candidate.verificationStatus, candidate.normalizationApplied)} · {candidate.evidenceText}</small>{approvals[item.note_id] === candidate.evidenceHash ? <Check size={13} /> : <ShieldCheck size={13} />}</button>)}</div>}
                </td>
              </tr>
            })}{rows.length === 0 && <tr className="batch-search-empty-row"><td colSpan={6} data-label="搜索">待投岗位没有匹配项{batch ? `；当前发送批次匹配 ${visibleBatchItems.length} 封` : ''}。</td></tr>}</tbody>
          </table>
        </div>

        <div className="batch-candidate-pagination" aria-busy={candidateLoading}>
          <span>{candidateLoading ? <><LoaderCircle className="spin" size={14} />正在读取全部岗位</> : candidateTotal > 0 ? `${candidateOffset + 1}-${Math.min(candidateOffset + rows.length, candidateTotal)} / ${candidateTotal}` : '0 / 0'}</span>
          <div>
            <button type="button" title="上一页待投岗位" disabled={candidateLoading || candidateOffset === 0} onClick={() => setCandidateOffset(Math.max(0, candidateOffset - CANDIDATE_PAGE_SIZE))}><ChevronLeft size={16} /></button>
            <button type="button" title="下一页待投岗位" disabled={candidateLoading || candidateOffset + CANDIDATE_PAGE_SIZE >= candidateTotal} onClick={() => setCandidateOffset(candidateOffset + CANDIDATE_PAGE_SIZE)}><ChevronRight size={16} /></button>
          </div>
        </div>

        <div className="batch-primary-actions">
          <button type="button" disabled={!selected.size || Boolean(busy)} onClick={() => void runDryRun()}>{busy === 'dry-run' ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />}Dry Run</button>
          <button type="button" className="primary" disabled={!canCreate} onClick={() => void createBatch()}>{busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />}冻结批次预览</button>
          {preflight && <span><strong>{selectedReadyCount}</strong> 项就绪 · <strong>{preflight.items.length - preflight.readyNoteIds.length}</strong> 项阻塞</span>}
        </div>

        {(batch || batches.length > 0) && <section className="batch-frozen-preview" aria-label="冻结批次预览">
          <header>
            <div><span className="step-label">FROZEN PREVIEW</span><h4>发送批次</h4></div>
            <select aria-label="选择发送批次" value={batch?.batchId || ''} onChange={(event) => {
              const next = batches.find((candidate) => candidate.batchId === event.target.value)
              if (next) setBatch(next)
            }}>{batches.map((candidate) => <option key={candidate.batchId} value={candidate.batchId}>{candidate.title} · {batchStatusLabel(candidate.status)}</option>)}</select>
          </header>
          {batch && <>
            <div className="batch-metrics">
              <span><strong>{batch.counts.ready || 0}</strong>待发送</span>
              <span><strong>{batch.counts.sending || 0}</strong>发送中</span>
              <span><strong>{batch.counts.sent || 0}</strong>SMTP 已接收</span>
              <span className={(batch.counts.unknown_manual_review || 0) > 0 ? 'warning' : ''}><strong>{batch.counts.unknown_manual_review || 0}</strong>待人工核对</span>
            </div>
            <div className="frozen-item-list">{visibleBatchItems.map((batchItem) => {
              const payload = batchItem.payload
              return <div key={batchItem.itemId} className={`frozen-item ${batchItem.status}`}>
                <span className={`item-status ${batchItem.status}`}>{itemStatusLabel(batchItem.status)}</span>
                <div><strong>{String(payload.roleName || payload.title || itemById.get(batchItem.noteId)?.title || batchItem.noteId)}</strong><small>{String(payload.recipient || '未纳入发送')}</small></div>
                <div><strong>{String(payload.subject || batchItem.error?.message || '已跳过')}</strong><small>{Array.isArray(payload.finalFilenames) ? payload.finalFilenames.join(' · ') : ''}</small></div>
                {batchItem.status === 'unknown_manual_review' && <div className="frozen-item-reconcile"><small>SMTP 超时只代表状态未知，请先核对发件箱或服务商记录。</small><span><button type="button" disabled={Boolean(busy)} onClick={() => void reconcileItem(batchItem, 'sent')}>确认已发送</button><button type="button" disabled={Boolean(busy)} onClick={() => void reconcileItem(batchItem, 'not_sent')}>确认未发送</button></span></div>}
              </div>
            })}{visibleBatchItems.length === 0 && <div className="batch-filter-empty" data-testid="batch-search-empty">当前发送批次没有匹配的邮件。</div>}</div>
            <section className="batch-email-preview" aria-label="邮件内容预览" data-testid="batch-email-preview">
              <header className="batch-email-preview-header">
                <div><span className="step-label">EMAIL CONTENT</span><h4>邮件内容</h4></div>
                <span>{normalizedQuery ? `${visibleBatchEmails.length} / ${totalBatchEmails}` : totalBatchEmails} 封</span>
              </header>
              <div className="batch-email-preview-list">
                {visibleBatchItems.map((batchItem) => {
                  const payload = batchItem.payload
                  const body = typeof payload.body === 'string' ? payload.body.trim() : ''
                  if (!body) return null
                  const roleName = String(payload.roleName || payload.title || itemById.get(batchItem.noteId)?.title || batchItem.noteId)
                  const recipient = String(payload.recipient || '未纳入发件包')
                  const subject = String(payload.subject || '主题待生成')
                  const filenames = Array.isArray(payload.finalFilenames) ? payload.finalFilenames : []
                  return <article key={`${batchItem.itemId}-email`} className={`batch-email-preview-card ${batchItem.status}`}>
                    <div className="batch-email-preview-card-heading">
                      <div><strong>{roleName}</strong><small>{recipient}</small></div>
                      <span className={`item-status ${batchItem.status}`}>{itemStatusLabel(batchItem.status)}</span>
                    </div>
                    <dl className="batch-email-preview-fields">
                      <div><dt>收件人</dt><dd>{recipient}</dd></div>
                      <div><dt>主题</dt><dd>{subject}</dd></div>
                    </dl>
                    <div className="batch-email-preview-body">{body}</div>
                    {filenames.length > 0 && <div className="batch-email-preview-attachments" aria-label="发送附件">
                      {filenames.map((filename) => <span className="batch-email-preview-attachment" key={filename}><Paperclip size={12} />{filename}</span>)}
                    </div>}
                  </article>
                })}
                {visibleBatchEmails.length === 0 && <div className="batch-filter-empty">没有匹配的邮件正文。</div>}
              </div>
            </section>
            <div className="batch-control-actions">
              <button type="button" disabled={!currentBatchReady || Boolean(busy)} onClick={() => void approveBatch()}>{busy === 'approve' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}审批</button>
              <button type="button" className="primary" disabled={batch.status !== 'approved' || Boolean(busy)} onClick={() => void controlBatch('start')}>{busy === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}开始</button>
              <button type="button" disabled={batch.status !== 'running' || Boolean(busy)} onClick={() => void controlBatch('pause')}>{busy === 'pause' ? <LoaderCircle className="spin" size={16} /> : <Pause size={16} />}暂停</button>
              <button type="button" disabled={batch.status !== 'paused' || Boolean(busy) || !(batch.counts.ready || batch.counts.failed_retryable)} onClick={() => void controlBatch('resume')}>{busy === 'resume' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}恢复</button>
              <button type="button" className="danger" disabled={batchTerminal || Boolean(busy)} onClick={() => void controlBatch('cancel')}>{busy === 'cancel' ? <LoaderCircle className="spin" size={16} /> : <XCircle size={16} />}取消</button>
            </div>
          </>}
        </section>}
      </div>}
    </section>
  )
}

function likelyReady(item: ApplicationResult) {
  return item.draftVersion?.qualityStatus === 'passed'
    && Boolean(item.outreach?.email_subject?.trim())
    && Boolean(item.outreach?.email_body?.trim())
    && Boolean(firstApplicationContact(item)?.address)
    && item.delivery?.action !== 'email_sent'
}

function batchItemSearchText(item: ApplicationBatch['items'][number] | undefined) {
  if (!item) return ''
  const payload = item.payload
  const filenames = Array.isArray(payload.finalFilenames) ? payload.finalFilenames : []
  return [
    item.itemId,
    item.noteId,
    item.status,
    payload.title,
    payload.roleName,
    payload.recipient,
    payload.subject,
    payload.body,
    ...filenames,
  ].map((value) => String(value || '')).join(' ').toLocaleLowerCase()
}

function applicationResultSearchText(item: ApplicationResult) {
  const routes = [
    ...(item.application_info?.contacts || []),
    ...(item.application_info?.application_routes || []),
  ]
  return [
    item.note_id,
    item.title,
    item.body,
    item.job_card?.role_name,
    item.job_card?.title,
    item.outreach?.email_subject,
    item.outreach?.email_body,
    ...routes.flatMap((route) => [route.value, route.evidence]),
  ].map((value) => String(value || '')).join(' ')
}

type ApplicationContactDisplay = Pick<ApplicationContactCandidate, 'address' | 'source' | 'evidenceText' | 'verificationStatus' | 'normalizationApplied' | 'sourceFields'> & {
  sourceImageIndex?: number
}

function firstApplicationContact(item: ApplicationResult): ApplicationContactDisplay | null {
  const routes = [...(item.application_info?.contacts || []), ...(item.application_info?.application_routes || [])]
  for (const route of routes) {
    if (route.actionable === false) continue
    const value = String(route.value || '')
    const evidenceText = String(route.evidence || '').trim()
    const match = `${value}\n${evidenceText}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
    if (!match) continue
    const sourceFields = [
      ...(route.source_fields || []),
      route.source_field || '',
      route.source_image_index ? 'image' : '',
    ].map((field) => String(field).toLowerCase()).filter(Boolean)
    const verificationStatus = String(route.verification_status || '')
    return {
      address: match[0].toLowerCase(),
      source: sourceFields.some((field) => field.includes('image')) ? 'image' : 'body',
      evidenceText: evidenceText || value,
      verificationStatus,
      normalizationApplied: route.normalization_applied === true || verificationStatus.toLowerCase().includes('normalized'),
      sourceFields,
      sourceImageIndex: route.source_image_index,
    }
  }
  return null
}

function applicationContactEvidence(item: ApplicationResult, contact: ApplicationContactDisplay): ApplicationContactDisplay {
  const routes = [...(item.application_info?.contacts || []), ...(item.application_info?.application_routes || [])]
  const matchingRoute = routes.find((route) => `${route.value || ''}\n${route.evidence || ''}`.toLowerCase().includes(contact.address.toLowerCase()))
  if (!matchingRoute) return contact
  const sourceFields = [
    ...(matchingRoute.source_fields || []),
    matchingRoute.source_field || '',
    matchingRoute.source_image_index ? 'image' : '',
  ].map((field) => String(field).toLowerCase()).filter(Boolean)
  return {
    ...contact,
    evidenceText: contact.evidenceText || String(matchingRoute.evidence || matchingRoute.value || ''),
    sourceFields: contact.sourceFields?.length ? contact.sourceFields : sourceFields,
    sourceImageIndex: matchingRoute.source_image_index,
  }
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function replaceBatch(current: ApplicationBatch[], next: ApplicationBatch) {
  return [next, ...current.filter((item) => item.batchId !== next.batchId)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function isPreflightDetails(value: unknown): value is ApplicationBatchPreflight {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as ApplicationBatchPreflight).items))
}

function contactSourceLabel(source: ApplicationContactCandidate['source'], verificationStatus = '', normalizationApplied = false) {
  const base = ({ body: '正文', image: '图片 OCR', author_comment: '帖主评论', other_comment: '待核验评论' })[source] || '来源待核验'
  return normalizationApplied || verificationStatus.toLowerCase().includes('normalized') ? `${base} · 已自动还原` : base
}

function batchStatusLabel(status: ApplicationBatch['status']) {
  return ({ draft: '草稿', ready: '待审批', approved: '已审批', running: '发送中', paused: '已暂停', completed: '已完成', cancelled: '已取消' })[status]
}

function itemStatusLabel(status: ApplicationBatchItemStatus) {
  return ({
    resolving: '解析中',
    blocked_no_email: '无可用邮箱',
    blocked_ambiguous: '邮箱待核验',
    draft_pending: '文案待处理',
    quality_pending: '质量待处理',
    filename_pending: '附件名待处理',
    ready: '就绪',
    sending: '发送中',
    sent: 'SMTP 已接收',
    failed_retryable: '可重试失败',
    unknown_manual_review: '发送状态待核对',
    skipped: '已跳过',
  })[status]
}

function createRequestIdempotencyKey(noteIds: string[], approvals: Record<string, string>, template: string, minIntervalSeconds: number, aiSessionId?: string | null) {
  const safe = [
    'batch',
    ...[...noteIds].sort(),
    ...Object.entries(approvals).sort(([left], [right]) => left.localeCompare(right)).flat(),
    template.trim(),
    String(minIntervalSeconds),
    aiSessionId || '',
  ].join(':').replace(/[^\p{L}\p{N}_.:-]+/gu, '_')
  return safe.slice(0, 160).padEnd(8, '_')
}
