import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Eye,
  FileText,
  Gauge,
  Layers3,
  LoaderCircle,
  Mail,
  Paperclip,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  WandSparkles,
  XCircle,
} from 'lucide-react'

import { api, type ApiError } from './api'
import type {
  ApplicationBatch,
  ApplicationBatchItemStatus,
  ApplicationBatchPreflight,
  ApplicationBatchRequest,
  ApplicationContext,
  ApplicationContactCandidate,
  ApplicationContactDiscoverySummary,
  ApplicationDeliveryCandidatesQuery,
  ApplicationDeliverySelectionSnapshot,
  ApplicationResult,
  OutreachDraft,
  ProvenanceText,
} from './types'

type BatchApplicationPanelProps = {
  jobId: string
  items: ApplicationResult[]
  aiSessionId?: string | null
  standalone?: boolean
  onOpenItem: (item: ApplicationResult) => void
}

type BatchWorkbenchView = 'all' | 'ready' | 'needs_review' | 'sent'
type BatchRecipientFilter = 'all' | 'resolved' | 'needs_review' | 'missing'
type BatchCopyFilter = 'all' | 'ready' | 'missing_body' | 'missing_cover_letter' | 'quality_failed'
type BatchSubjectFilter = 'all' | 'ready' | 'needs_review' | 'required'
type BatchAttachmentFilter = 'all' | 'unchanged' | 'will_rename' | 'required' | 'blocked'

type BatchWorkbenchFilters = {
  view: BatchWorkbenchView
  recipient: BatchRecipientFilter
  copy: BatchCopyFilter
  subject: BatchSubjectFilter
  attachment: BatchAttachmentFilter
}

type BatchWorkbenchPreferences = {
  query: string
  filters: BatchWorkbenchFilters
  selectionLimit: number
  pageSize: number
}

type CandidateCorpusPage = {
  jobId: string
  filterSignature: string
  total: number
  sourceTotal: number
  offset: number
  nextCursor: string | null
  items: ApplicationResult[]
  selectionSnapshot: ApplicationDeliverySelectionSnapshot
  contactDiscovery: ApplicationContactDiscoverySummary | null
}

type BatchCopyEditor = {
  noteId: string
  emailSubject: string
  emailBody: string
  coverLetter: string
}

const DEFAULT_WORKBENCH_FILTERS: BatchWorkbenchFilters = {
  view: 'all',
  recipient: 'all',
  copy: 'all',
  subject: 'all',
  attachment: 'all',
}

const BATCH_VIEW_OPTIONS: Array<{ value: BatchWorkbenchView; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'ready', label: '可投递' },
  { value: 'needs_review', label: '待我处理' },
  { value: 'sent', label: '已发送' },
]

const RECIPIENT_FILTER_OPTIONS: Array<{ value: BatchRecipientFilter; label: string }> = [
  { value: 'all', label: '全部收件人' },
  { value: 'resolved', label: '邮箱已确认' },
  { value: 'needs_review', label: '邮箱待确认' },
  { value: 'missing', label: '缺少邮箱' },
]

const COPY_FILTER_OPTIONS: Array<{ value: BatchCopyFilter; label: string }> = [
  { value: 'all', label: '全部文案' },
  { value: 'ready', label: '文案已就绪' },
  { value: 'missing_body', label: '缺邮件正文' },
  { value: 'missing_cover_letter', label: '缺 Cover Letter' },
  { value: 'quality_failed', label: '质量未通过' },
]

const SUBJECT_FILTER_OPTIONS: Array<{ value: BatchSubjectFilter; label: string }> = [
  { value: 'all', label: '全部标题' },
  { value: 'ready', label: '标题已就绪' },
  { value: 'needs_review', label: '标题待复核' },
  { value: 'required', label: '有标题要求' },
]

const ATTACHMENT_FILTER_OPTIONS: Array<{ value: BatchAttachmentFilter; label: string }> = [
  { value: 'all', label: '全部附件' },
  { value: 'unchanged', label: '无需改名' },
  { value: 'will_rename', label: '将改名' },
  { value: 'required', label: '有命名要求' },
  { value: 'blocked', label: '命名阻塞' },
]

const MAX_BATCH_SIZE = 100
const DEFAULT_SELECTION_LIMIT = 50
const DEFAULT_CANDIDATE_PAGE_SIZE = 50
const CANDIDATE_PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const BATCH_SELECTION_PRESETS = [10, 20, 50, 100] as const
const DEFAULT_ATTACHMENT_TEMPLATE = '{candidateName}-{jobTitle}-简历'
const WORKBENCH_PREFERENCES_PREFIX = 'batch-application-workbench:v3:'
const BULK_POLISH_INSTRUCTIONS = '保持所有事实可核验，逐项回应岗位职责，删除模板腔、重复和空泛表述，用自然、专业、具体的中文重写专属 Cover Letter；不要虚构经历或结果。'

export function BatchApplicationPanel({ jobId, items, aiSessionId, standalone = false, onOpenItem }: BatchApplicationPanelProps) {
  const [expanded, setExpanded] = useState(standalone)
  const [layoutMode, setLayoutMode] = useState<'quick' | 'detail'>('quick')
  const [query, setQuery] = useState(() => loadWorkbenchPreferences(jobId).query)
  const [workbenchFilters, setWorkbenchFilters] = useState<BatchWorkbenchFilters>(() => loadWorkbenchPreferences(jobId).filters)
  const [selectionLimit, setSelectionLimit] = useState(() => loadWorkbenchPreferences(jobId).selectionLimit)
  const [selectionLimitMode, setSelectionLimitMode] = useState<'preset' | 'custom'>(() =>
    isBatchSelectionPreset(loadWorkbenchPreferences(jobId).selectionLimit) ? 'preset' : 'custom',
  )
  const [candidatePageSize, setCandidatePageSize] = useState(() => loadWorkbenchPreferences(jobId).pageSize)
  const [preferencesJobId, setPreferencesJobId] = useState(jobId)
  const [expandedCoverLetters, setExpandedCoverLetters] = useState<Set<string>>(new Set())
  const [copiedDeliveryNoteId, setCopiedDeliveryNoteId] = useState('')
  const [copyEditor, setCopyEditor] = useState<BatchCopyEditor | null>(null)
  const [copySavingNoteId, setCopySavingNoteId] = useState('')
  const [candidateQuery, setCandidateQuery] = useState('')
  const [candidateOffset, setCandidateOffset] = useState(0)
  const [candidatePageRequest, setCandidatePageRequest] = useState<{
    filterSignature: string
    offset: number
    cursor?: string
  }>({ filterSignature: '', offset: 0, cursor: undefined })
  const [candidateCorpus, setCandidateCorpus] = useState<CandidateCorpusPage | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateError, setCandidateError] = useState('')
  const [contactDiscoverySummary, setContactDiscoverySummary] = useState<ApplicationContactDiscoverySummary | null>(null)
  const [commentCollectionBusy, setCommentCollectionBusy] = useState(false)
  const [knownCandidateTotal, setKnownCandidateTotal] = useState(items.length)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scopeNoteIds, setScopeNoteIds] = useState<string[]>([])
  const [approvals, setApprovals] = useState<Record<string, string>>({})
  const [preflight, setPreflight] = useState<ApplicationBatchPreflight | null>(null)
  const [preflightSelectionConfirmed, setPreflightSelectionConfirmed] = useState(false)
  const [batches, setBatches] = useState<ApplicationBatch[]>([])
  const [batch, setBatch] = useState<ApplicationBatch | null>(null)
  const [batchJobId, setBatchJobId] = useState(jobId)
  const [attachmentTemplate, setAttachmentTemplate] = useState(DEFAULT_ATTACHMENT_TEMPLATE)
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(1)
  const [busy, setBusy] = useState('')
  const [bulkPolishProgress, setBulkPolishProgress] = useState({ completed: 0, total: 0, succeeded: 0, failed: 0 })
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [streamState, setStreamState] = useState<'idle' | 'live' | 'reconnecting'>('idle')
  const refreshTimer = useRef<number | null>(null)
  const selectionSeedJob = useRef<string | null>(null)
  const candidateRequest = useRef(0)
  const candidatePageCursors = useRef<Map<string, Map<number, string | undefined>>>(new Map())
  const candidatePageCache = useRef<Map<string, CandidateCorpusPage>>(new Map())
  const candidateItemCache = useRef<Map<string, ApplicationResult>>(new Map())
  const candidateSelectionRevisions = useRef<Map<string, string>>(new Map())
  const candidateSnapshotState = useRef<Map<string, string>>(new Map())
  const dryRunRequest = useRef(0)
  const bulkPolishRequest = useRef(0)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const candidateFilterQuery = useMemo(
    () => buildDeliveryCandidateQuery(candidateQuery, workbenchFilters),
    [candidateQuery, workbenchFilters],
  )
  const candidateFilterSignature = useMemo(
    () => JSON.stringify({ query: candidateFilterQuery, pageSize: candidatePageSize }),
    [candidateFilterQuery, candidatePageSize],
  )
  const candidateFilterSignatureRef = useRef(candidateFilterSignature)
  candidateFilterSignatureRef.current = candidateFilterSignature
  const itemsRevision = useMemo(() => JSON.stringify(items), [items])
  const candidateItemsRevisionState = useRef({ revision: itemsRevision, hydrated: items.length > 0 })
  const batchCandidateRevision = batchJobId === jobId && batch
    ? `${batch.batchId}:${batch.revision}:${batch.status}:${batch.lastEventSequence}`
    : ''
  const candidateBatchRevisionState = useRef(batchCandidateRevision)

  const itemById = useMemo(() => new Map(items.map((item) => [item.note_id, item])), [items])
  const preflightById = useMemo(
    () => new Map((preflight?.items || []).map((item) => [item.noteId, item])),
    [preflight],
  )

  useEffect(() => {
    const preferences = loadWorkbenchPreferences(jobId)
    dryRunRequest.current += 1
    bulkPolishRequest.current += 1
    selectionSeedJob.current = null
    setSelected(new Set())
    setScopeNoteIds([])
    setApprovals({})
    setPreflight(null)
    setPreflightSelectionConfirmed(false)
    setBatch(null)
    setBatchJobId(jobId)
    setBatches([])
    setNotice(null)
    setExpanded(standalone)
    setQuery(preferences.query)
    setWorkbenchFilters(preferences.filters)
    setSelectionLimit(preferences.selectionLimit)
    setSelectionLimitMode(isBatchSelectionPreset(preferences.selectionLimit) ? 'preset' : 'custom')
    setCandidatePageSize(preferences.pageSize)
    setPreferencesJobId(jobId)
    setExpandedCoverLetters(new Set())
    setCopiedDeliveryNoteId('')
    setCopyEditor(null)
    setCopySavingNoteId('')
    setCandidateQuery('')
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature: '', offset: 0, cursor: undefined })
    setCandidateCorpus(null)
    setCandidateError('')
    setContactDiscoverySummary(null)
    setCommentCollectionBusy(false)
    setBusy('')
    setBulkPolishProgress({ completed: 0, total: 0, succeeded: 0, failed: 0 })
    setKnownCandidateTotal(items.length)
    candidatePageCursors.current = new Map()
    candidatePageCache.current = new Map()
    candidateItemCache.current = new Map()
    candidateSelectionRevisions.current = new Map()
    candidateSnapshotState.current = new Map()
    candidateItemsRevisionState.current = { revision: itemsRevision, hydrated: items.length > 0 }
    candidateBatchRevisionState.current = ''
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
    if (preferencesJobId !== jobId) return
    saveWorkbenchPreferences(jobId, { query, filters: workbenchFilters, selectionLimit, pageSize: candidatePageSize })
  }, [candidatePageSize, jobId, preferencesJobId, query, selectionLimit, workbenchFilters])

  useEffect(() => {
    if (!items.length || selectionSeedJob.current === jobId) return
    const readyItems = items.filter(likelyReady)
    const defaults = readyItems.slice(0, selectionLimit).map((item) => item.note_id)
    setSelected(new Set(defaults))
    if (readyItems.length > selectionLimit) {
      setNotice({ tone: 'info', text: `发现 ${readyItems.length} 个可投递岗位，已按批量数量选择前 ${selectionLimit} 个。` })
    }
    selectionSeedJob.current = jobId
  }, [items, jobId, selectionLimit])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCandidateOffset(0)
      setCandidateQuery(normalizedQuery)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [normalizedQuery])

  useEffect(() => {
    dryRunRequest.current += 1
    setPreflightSelectionConfirmed(false)
    setBusy((current) => current === 'dry-run' ? '' : current)
  }, [normalizedQuery, workbenchFilters])

  useEffect(() => {
    candidateRequest.current += 1
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature: candidateFilterSignature, offset: 0, cursor: undefined })
    if (!candidatePageCursors.current.has(candidateFilterSignature)) {
      candidatePageCursors.current.set(candidateFilterSignature, new Map([[0, undefined]]))
    }
  }, [candidateFilterSignature])

  useEffect(() => {
    if (!expanded || candidatePageRequest.filterSignature !== candidateFilterSignature) return
    const cacheKey = candidatePageCacheKey(
      candidateFilterSignature,
      candidatePageRequest.offset,
      candidatePageRequest.cursor,
    )
    const cachedPage = candidatePageCache.current.get(cacheKey)
    if (cachedPage) {
      setCandidateLoading(false)
      setCandidateError('')
      setCandidateOffset(cachedPage.offset)
      setCandidateCorpus(cachedPage)
      setContactDiscoverySummary(cachedPage.contactDiscovery)
      return
    }
    let startedRequestId = 0
    const timer = window.setTimeout(() => {
      const requestId = ++candidateRequest.current
      startedRequestId = requestId
      setCandidateLoading(true)
      setCandidateError('')
      void (async () => {
        const payload = await api.applicationDeliveryCandidates(jobId, {
          ...candidateFilterQuery,
          ...(candidatePageRequest.cursor ? { cursor: candidatePageRequest.cursor } : {}),
          limit: candidatePageSize,
        })
        if (requestId !== candidateRequest.current) return
        if (candidatePageRequest.offset > 0 && payload.total > 0 && payload.items.length === 0) {
          setCandidatePageRequest({ filterSignature: candidateFilterSignature, offset: 0, cursor: undefined })
          return
        }
        const sourceTotal = sumFacetCounts(payload.facetCounts.deliveryStatus) || payload.total
        for (const item of payload.items) candidateItemCache.current.set(item.note_id, item)
        for (const item of payload.selectionSnapshot.revisions) {
          candidateSelectionRevisions.current.set(item.noteId, item.revision)
        }
        const cursorState = candidatePageCursors.current.get(candidateFilterSignature)
          || new Map<number, string | undefined>([[0, undefined]])
        cursorState.set(payload.offset, candidatePageRequest.cursor)
        if (payload.nextCursor) cursorState.set(payload.offset + payload.items.length, payload.nextCursor)
        candidatePageCursors.current.set(candidateFilterSignature, cursorState)
        const previousSnapshotHash = candidateSnapshotState.current.get(candidateFilterSignature)
        if (
          previousSnapshotHash
          && previousSnapshotHash !== payload.selectionSnapshot.selectionSnapshotHash
        ) {
          dryRunRequest.current += 1
          setPreflight(null)
          setPreflightSelectionConfirmed(false)
          setNotice({ tone: 'info', text: '候选岗位数据已更新，旧的投递预演已失效，请重新运行。' })
        }
        candidateSnapshotState.current.set(
          candidateFilterSignature,
          payload.selectionSnapshot.selectionSnapshotHash,
        )
        const page: CandidateCorpusPage = {
          jobId,
          filterSignature: candidateFilterSignature,
          total: payload.total,
          sourceTotal,
          offset: payload.offset,
          nextCursor: payload.nextCursor,
          items: payload.items,
          selectionSnapshot: payload.selectionSnapshot,
          contactDiscovery: payload.contactDiscovery?.summary || null,
        }
        candidatePageCache.current.set(cacheKey, page)
        setCandidateOffset(payload.offset)
        setCandidateCorpus(page)
        setContactDiscoverySummary(page.contactDiscovery)
        if (
          commentCollectionBusy
          && page.contactDiscovery
          && page.contactDiscovery.commentsPending === 0
          && page.contactDiscovery.commentsPartial === 0
        ) {
          setCommentCollectionBusy(false)
          setNotice({ tone: 'success', text: '当前岗位的评论邮箱采集已完成，候选岗位邮箱已刷新。' })
        }
        if (!candidateQuery) setKnownCandidateTotal((current) => Math.max(current, sourceTotal, payload.total))
      })().catch((error: ApiError) => {
        if (requestId !== candidateRequest.current) return
        if (error.code === 'APPLICATION_CANDIDATE_CURSOR_STALE' && candidatePageRequest.cursor) {
          candidatePageCache.current.clear()
          candidateItemCache.current.clear()
          candidateSelectionRevisions.current.clear()
          candidatePageCursors.current = new Map([
            [candidateFilterSignature, new Map([[0, undefined]])],
          ])
          setCandidateError('')
          setCandidateOffset(0)
          setNotice({ tone: 'info', text: '候选岗位已更新，正在刷新第一页。' })
          setCandidatePageRequest({
            filterSignature: candidateFilterSignature,
            offset: 0,
            cursor: undefined,
          })
          return
        }
        setCandidateError(error.message || '投递候选清单读取失败，当前继续显示已加载岗位。')
      }).finally(() => {
        if (requestId === candidateRequest.current) setCandidateLoading(false)
      })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      if (startedRequestId && candidateRequest.current === startedRequestId) candidateRequest.current += 1
    }
  }, [candidateFilterQuery, candidateFilterSignature, candidatePageRequest, candidatePageSize, commentCollectionBusy, expanded, jobId])

  useEffect(() => {
    if (!commentCollectionBusy || !expanded) return
    let ticks = 0
    const timer = window.setInterval(() => {
      ticks += 1
      refreshCandidateCorpus()
      if (ticks >= 100) {
        setCommentCollectionBusy(false)
        setNotice({ tone: 'info', text: '评论采集仍在后台运行，岗位投递清单已停止自动刷新，可稍后手动刷新。' })
      }
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [commentCollectionBusy, expanded])

  useEffect(() => {
    const previous = candidateItemsRevisionState.current
    if (previous.revision === itemsRevision) return
    candidateItemsRevisionState.current = { revision: itemsRevision, hydrated: previous.hydrated || items.length > 0 }
    if (!previous.hydrated && items.length > 0) return
    candidateRequest.current += 1
    dryRunRequest.current += 1
    candidatePageCache.current.clear()
    candidateItemCache.current.clear()
    candidateSelectionRevisions.current.clear()
    candidatePageCursors.current = new Map([[candidateFilterSignature, new Map([[0, undefined]])]])
    setPreflightSelectionConfirmed(false)
    setBusy((current) => current === 'dry-run' ? '' : current)
    setCandidateLoading(true)
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature: candidateFilterSignature, offset: 0, cursor: undefined })
  }, [candidateFilterSignature, items.length, itemsRevision])

  useEffect(() => {
    if (candidateBatchRevisionState.current === batchCandidateRevision) return
    candidateBatchRevisionState.current = batchCandidateRevision
    candidateRequest.current += 1
    dryRunRequest.current += 1
    candidatePageCache.current.clear()
    candidateItemCache.current.clear()
    candidateSelectionRevisions.current.clear()
    candidatePageCursors.current = new Map([[candidateFilterSignature, new Map([[0, undefined]])]])
    setPreflightSelectionConfirmed(false)
    setBusy((current) => current === 'dry-run' ? '' : current)
    setCandidateLoading(true)
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature: candidateFilterSignature, offset: 0, cursor: undefined })
  }, [batchCandidateRevision, candidateFilterSignature])

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
  const hasCurrentCandidateCorpus = candidateQuery === normalizedQuery
    && candidateCorpus?.jobId === jobId
    && candidateCorpus.filterSignature === candidateFilterSignature
    && candidateCorpus.offset === candidateOffset
  const candidateItems = hasCurrentCandidateCorpus
    ? candidateCorpus.items
    : items
  const matchingCandidateItems = useMemo(() => {
    if (hasCurrentCandidateCorpus) return candidateItems
    return candidateItems.filter((item) => {
      const checked = preflightById.get(item.note_id)
      const savedBatchItem = batchItemByNoteId.get(item.note_id)
      if (!matchesWorkbenchFilters(item, workbenchFilters, checked, savedBatchItem)) return false
      if (!normalizedQuery) return true
      const contactText = [
        firstApplicationContact(item)?.address,
        checked?.contact?.address,
        ...(checked?.contactResolution?.candidates || []).map((candidate) => candidate.address),
        ...(item.contactDiscovery?.candidates || []).map((candidate) => candidate.address),
      ].join(' ')
      const savedBatchText = batchItemSearchText(savedBatchItem)
      const checkedText = preflightItemSearchText(checked)
      return `${applicationResultSearchText(item)} ${contactText} ${checkedText} ${savedBatchText}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [batchItemByNoteId, candidateItems, hasCurrentCandidateCorpus, normalizedQuery, preflightById, workbenchFilters])
  const rows = matchingCandidateItems
  const candidateSourceTotal = Math.max(
    knownCandidateTotal,
    items.length,
    hasCurrentCandidateCorpus && !candidateQuery ? candidateCorpus.sourceTotal : 0,
  )
  const candidateTotal = hasCurrentCandidateCorpus ? candidateCorpus.total : matchingCandidateItems.length
  const selectionSnapshot = hasCurrentCandidateCorpus ? candidateCorpus.selectionSnapshot : null
  const commentEmailCount = contactDiscoverySummary?.commentEmailRecords ?? 0
  const commentsPending = contactDiscoverySummary?.commentsPending ?? 0
  const commentsPartial = contactDiscoverySummary?.commentsPartial ?? 0
  const shouldShowCommentCollection = Boolean(contactDiscoverySummary)
    && (commentsPending > 0 || commentsPartial > 0 || commentEmailCount > 0)
  const visibleBatchItems = useMemo(() => {
    if (!batch) return []
    return batch.items.filter((item) => {
      if (!matchesSavedBatchFilters(item, workbenchFilters)) return false
      return !normalizedQuery || batchItemSearchText(item).includes(normalizedQuery)
    })
  }, [batch, normalizedQuery, workbenchFilters])
  const visibleBatchEmails = visibleBatchItems.filter((item) => typeof item.payload.body === 'string' && item.payload.body.trim())
  const totalBatchEmails = batch?.items.filter((item) => typeof item.payload.body === 'string' && item.payload.body.trim()).length || 0

  const candidateOrder = new Map(
    (selectionSnapshot?.noteIds || [...new Set([...candidateItems, ...items].map((item) => item.note_id))])
      .map((noteId, index) => [noteId, index] as const),
  )
  const selectedIds = [...selected].sort((left, right) => {
    const leftOrder = candidateOrder.get(left)
    const rightOrder = candidateOrder.get(right)
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
    if (leftOrder !== undefined) return -1
    if (rightOrder !== undefined) return 1
    return left.localeCompare(right)
  })
  const candidateById = new Map(
    [...candidateItemCache.current.values(), ...items, ...candidateItems]
      .map((item) => [item.note_id, item] as const),
  )
  const matchingNoteIds = new Set(
    selectionSnapshot?.noteIds || matchingCandidateItems.map((item) => item.note_id),
  )
  const readyNoteIds = new Set(selectionSnapshot?.readyNoteIds || [])
  const selectableNoteIds = new Set(selectionSnapshot?.selectableNoteIds || [])
  const selectedOutsideFilterIds = hasCurrentCandidateCorpus
    ? selectedIds.filter((noteId) => !matchingNoteIds.has(noteId))
    : []
  const selectedOutsideFilterIdSet = new Set(selectedOutsideFilterIds)
  const selectedInvalidIds = selectedIds.filter((noteId) => {
    if (selectedOutsideFilterIdSet.has(noteId)) return false
    if (selectionSnapshot) return !selectableNoteIds.has(noteId)
    const item = candidateById.get(noteId)
    if (!item) return false
    return !isCandidateSelectable(item, preflightById.get(noteId), batchItemByNoteId.get(noteId))
  })
  const selectedMissingRevisionIds = selectedIds.filter(
    (noteId) => !candidateSelectionRevisions.current.has(noteId),
  )
  const preflightReadyCount = preflight?.readyNoteIds.length || 0
  const preflightPreparableCount = preflight?.items.filter((item) => item.status !== 'ready' && item.canPrepare).length || 0
  const preflightBlockedCount = preflight ? Math.max(0, preflight.items.length - preflightReadyCount - preflightPreparableCount) : 0
  const preflightReference = preflight?.preflightId || preflight?.planId || ''
  const selectedMatchesPreflight = Boolean(preflightReference && preflight?.manifestHash)
    && selectedIds.length === preflight?.readyNoteIds.length
    && sameStringSet(selectedIds, preflight?.readyNoteIds || [])
  const canCreate = selected.size > 0
    && selected.size <= MAX_BATCH_SIZE
    && selectedMatchesPreflight
    && preflightSelectionConfirmed
    && !busy
  const batchTerminal = batch ? ['completed', 'cancelled'].includes(batch.status) : true
  const batchAwaitingSend = Boolean(batch && ['ready', 'approved'].includes(batch.status))
  const canStartNewBatch = (!batch || batchTerminal) && canCreate
  const sendCount = batchAwaitingSend && batch
    ? Math.max(batch.counts.ready || 0, batch.items.filter((item) => ['ready', 'failed_retryable'].includes(item.status)).length)
    : selected.size
  const canSend = (batchAwaitingSend || canStartNewBatch) && !busy
  const sendNextStep = batch?.status === 'running'
    ? '正在发送'
    : batch?.status === 'paused'
      ? '发送已暂停'
      : batchAwaitingSend
        ? `${sendCount} 封邮件待发送`
        : selectedMatchesPreflight && preflightSelectionConfirmed
          ? `${sendCount} 封邮件已就绪`
          : !selected.size
            ? batch?.status === 'completed'
              ? '发送已完成'
              : batch?.status === 'cancelled'
                ? '批次已取消'
                : '未选择岗位'
            : `${selected.size} 个岗位待预览`

  const buildRequest = (noteIds: string[], nextApprovals = approvals, frozenPreflight?: ApplicationBatchPreflight | null): ApplicationBatchRequest => {
    const selectionRevisions = noteIds.flatMap((noteId) => {
      const revision = candidateSelectionRevisions.current.get(noteId)
      return revision === undefined ? [] : [{ noteId, revision }]
    })
    return {
      noteIds,
      contactApprovals: noteIds.flatMap((noteId) => nextApprovals[noteId]
        ? [{ noteId, evidenceHash: nextApprovals[noteId], confirmed: true as const }]
        : []),
      defaultAttachmentTemplate: attachmentTemplate.trim() || DEFAULT_ATTACHMENT_TEMPLATE,
      minIntervalMs: Math.max(0, Math.min(60, minIntervalSeconds)) * 1_000,
      ...(aiSessionId ? { aiSessionId } : {}),
      ...(frozenPreflight?.preflightId || frozenPreflight?.planId ? { preflightId: frozenPreflight.preflightId || frozenPreflight.planId } : {}),
      ...(frozenPreflight?.manifestHash ? { manifestHash: frozenPreflight.manifestHash } : {}),
      ...(frozenPreflight ? { confirmedNoteIds: [...frozenPreflight.readyNoteIds] } : {}),
      ...(selectionSnapshot ? {
        selectionSnapshotId: selectionSnapshot.selectionSnapshotId,
        selectionSnapshotHash: selectionSnapshot.selectionSnapshotHash,
        selectionRevisions,
      } : {}),
      idempotencyKey: createRequestIdempotencyKey(
        noteIds,
        nextApprovals,
        attachmentTemplate,
        minIntervalSeconds,
        aiSessionId,
        frozenPreflight?.preflightId || frozenPreflight?.planId,
        frozenPreflight?.manifestHash,
        selectionSnapshot?.selectionSnapshotId,
        selectionSnapshot?.selectionSnapshotHash,
      ),
    }
  }

  async function runDryRun(noteIds = selectedIds, nextApprovals = approvals) {
    if (!noteIds.length) {
      setNotice({ tone: 'error', text: '请先选择至少一个岗位。' })
      return
    }
    if (noteIds.length > MAX_BATCH_SIZE) {
      setNotice({ tone: 'error', text: `当前选择 ${noteIds.length} 个岗位，超过每批 ${MAX_BATCH_SIZE} 个的上限；请先清理选择。` })
      return
    }
    if (!selectionSnapshot || candidateLoading) {
      setNotice({ tone: 'info', text: '候选清单正在更新，请等待选择快照就绪后再运行投递预演。' })
      return
    }
    const missingRevisionIds = noteIds.filter((noteId) => !candidateSelectionRevisions.current.has(noteId))
    if (missingRevisionIds.length) {
      setNotice({ tone: 'info', text: `有 ${missingRevisionIds.length} 个已选岗位缺少最新修订，请重新加载候选清单后再运行投递预演。` })
      return
    }
    const requestId = ++dryRunRequest.current
    setPreflightSelectionConfirmed(false)
    setBusy('dry-run')
    setNotice(null)
    try {
      const result = await api.dryRunApplicationBatch(jobId, buildRequest(noteIds, nextApprovals))
      if (requestId !== dryRunRequest.current) return
      setPreflight(result)
      setScopeNoteIds(noteIds)
      const retained = result.readyNoteIds.filter((noteId) => noteIds.includes(noteId))
      setSelected(new Set(retained))
      setPreflightSelectionConfirmed(true)
      const blocked = result.items.length - result.readyNoteIds.length
      setNotice({
        tone: blocked ? 'info' : 'success',
        text: blocked ? `投递预演完成：${result.readyNoteIds.length} 项就绪，${blocked} 项待处理；本次不会发送邮件。` : `投递预演完成：${result.readyNoteIds.length} 项全部就绪；本次不会发送邮件。`,
      })
    } catch (error) {
      if (requestId === dryRunRequest.current) setNotice({ tone: 'error', text: (error as ApiError).message })
    } finally {
      if (requestId === dryRunRequest.current) setBusy('')
    }
  }

  async function confirmContact(noteId: string, candidate: ApplicationContactCandidate) {
    if (!scopeNoteIds.includes(noteId) && scopeNoteIds.length >= MAX_BATCH_SIZE) {
      setNotice({ tone: 'error', text: `当前投递预演已包含 ${scopeNoteIds.length} 个岗位，无法再加入 ${noteId}；请先移除一项后重试。` })
      return
    }
    const next = { ...approvals, [noteId]: candidate.evidenceHash }
    setApprovals(next)
    const nextScope = scopeNoteIds.includes(noteId) ? scopeNoteIds : [...scopeNoteIds, noteId]
    await runDryRun(nextScope.length ? nextScope : [noteId], next)
  }

  function storeBatch(next: ApplicationBatch) {
    setBatch(next)
    setBatchJobId(jobId)
    setBatches((current) => replaceBatch(current, next))
  }

  async function sendPreviewedBatch() {
    const resumableBatch = batch && ['ready', 'approved'].includes(batch.status) ? batch : null
    if (!resumableBatch && !canStartNewBatch) return

    setBusy('send')
    setNotice(null)
    let activeBatch = resumableBatch
    try {
      if (!activeBatch) {
        const result = await api.createApplicationBatch(jobId, buildRequest(selectedIds, approvals, preflight))
        setPreflight(result.preflight)
        activeBatch = result.batch
        storeBatch(activeBatch)
      }

      if (activeBatch.status === 'ready') {
        activeBatch = await api.approveApplicationBatch(jobId, activeBatch.batchId, activeBatch.revision)
        storeBatch(activeBatch)
      }

      if (activeBatch.status === 'approved') {
        activeBatch = await api.controlApplicationBatch(jobId, activeBatch.batchId, 'start', activeBatch.revision)
        storeBatch(activeBatch)
        setNotice({ tone: 'success', text: `已启动 ${sendCount || activeBatch.items.length} 封邮件的真实投递，请在批次明细中查看逐封结果。` })
        return
      }

      const statusText = activeBatch.status === 'running'
        ? '批次已经在发送中。'
        : activeBatch.status === 'paused'
          ? '批次当前已暂停，请在批次明细中点击继续发送。'
          : activeBatch.status === 'completed'
            ? '该批次已经发送完成，没有重复投递。'
            : '该批次已取消，没有启动投递。'
      setNotice({ tone: activeBatch.status === 'completed' ? 'success' : 'info', text: statusText })
    } catch (error) {
      const apiError = error as ApiError
      if (!activeBatch && ['APPLICATION_BATCH_PREFLIGHT_STALE', 'APPLICATION_BATCH_PREFLIGHT_EXPIRED'].includes(apiError.code || '')) {
        setPreflight(null)
        setPreflightSelectionConfirmed(false)
        setNotice({ tone: 'error', text: '邮件预览已过期或岗位数据发生变化，请重新预览后再发送。' })
        return
      }
      if (!activeBatch && isPreflightDetails(apiError.details)) setPreflight(apiError.details)
      if (activeBatch) {
        try {
          storeBatch(await api.applicationBatch(jobId, activeBatch.batchId))
        } catch {
          storeBatch(activeBatch)
        }
      }
      setNotice({
        tone: 'error',
        text: `${apiError.message}${activeBatch ? '；已完成的冻结或审批状态已保留，可再次点击发送继续。' : ''}`,
      })
    } finally {
      setBusy('')
    }
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

  function openCopyEditor(item: ApplicationResult, emailSubject: string, emailBody: string, coverLetter: string) {
    setCopyEditor({ noteId: item.note_id, emailSubject, emailBody, coverLetter })
    setExpandedCoverLetters((current) => new Set(current).add(item.note_id))
    setNotice({ tone: 'info', text: '正在编辑当前草稿；保存后旧的投递预演会失效，冻结批次中的历史快照不会被改写。' })
  }

  async function saveCopyEditor(item: ApplicationResult) {
    if (!copyEditor || copyEditor.noteId !== item.note_id || copySavingNoteId) return
    const outreach: OutreachDraft = {
      ...applicationOutreachDraft(item),
      email_subject: copyEditor.emailSubject.trim(),
      email_body: copyEditor.emailBody.trim(),
      cover_letter: copyEditor.coverLetter.trim(),
    }
    if (!outreach.email_body) {
      setNotice({ tone: 'error', text: '邮件正文不能为空，请补充后再保存。' })
      return
    }
    if (!outreach.cover_letter) {
      setNotice({ tone: 'error', text: 'Cover Letter 不能为空，请补充后再保存。' })
      return
    }
    setCopySavingNoteId(item.note_id)
    setNotice(null)
    try {
      const applicationContext = item.outreach.applicationContext || defaultApplicationContext(item)
      const response = await api.saveDraft(jobId, item.note_id, outreach, item.draftVersion, applicationContext)
      if (!response.draftVersion) throw new Error('服务端未返回草稿版本，请刷新后重试。')
      // The server is the source of truth for job-specific subject rules. It may
      // replace the submitted subject with the generated compliant subject.
      const savedOutreach: OutreachDraft = {
        ...outreach,
        ...response.outreach,
      }
      const subjectWasNormalized = savedOutreach.email_subject !== outreach.email_subject
      const nextItem: ApplicationResult = {
        ...item,
        emailSubjectPreview: savedOutreach.email_subject,
        outreach: { ...item.outreach, ...savedOutreach, applicationContext },
        draftVersion: response.draftVersion,
        delivery: response.delivery,
        cover_letter_evaluation: response.cover_letter_evaluation || item.cover_letter_evaluation,
      }
      candidateItemCache.current.set(item.note_id, nextItem)
      setCandidateCorpus((current) => current && current.jobId === jobId
        ? { ...current, items: current.items.map((candidate) => candidate.note_id === item.note_id ? nextItem : candidate) }
        : current)
      dryRunRequest.current += 1
      setPreflight(null)
      setPreflightSelectionConfirmed(false)
      setCopyEditor(null)
      setNotice({ tone: 'success', text: subjectWasNormalized
        ? `正文已保存为 v${response.draftVersion.version}；邮件标题已按岗位要求更新，请重新运行投递预演后再发送。`
        : `正文已保存为 v${response.draftVersion.version}；请重新运行投递预演后再发送。` })
      refreshCandidateCorpus()
    } catch (error) {
      const apiError = error as ApiError
      setNotice({
        tone: 'error',
        text: apiError.code === 'DRAFT_VERSION_CONFLICT'
          ? '该正文已在其他窗口更新。当前修改仍保留在编辑框中，请刷新候选清单后再保存。'
          : apiError.message || '正文保存失败，请稍后重试。',
      })
    } finally {
      setCopySavingNoteId('')
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

  function invalidateSelectionPreflight() {
    dryRunRequest.current += 1
    setPreflightSelectionConfirmed(false)
    setBusy((current) => current === 'dry-run' ? '' : current)
  }

  function refreshCandidateCorpus() {
    const filterSignature = candidateFilterSignatureRef.current
    candidateRequest.current += 1
    candidatePageCache.current.clear()
    candidateItemCache.current.clear()
    candidateSelectionRevisions.current.clear()
    candidateSnapshotState.current.delete(filterSignature)
    candidatePageCursors.current = new Map([
      [filterSignature, new Map([[0, undefined]])],
    ])
    setCandidateLoading(true)
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature, offset: 0, cursor: undefined })
  }

  async function startCommentCollection() {
    if (commentCollectionBusy || candidateLoading) return
    setCommentCollectionBusy(true)
    setNotice({ tone: 'info', text: '正在为当前岗位投递清单采集评论邮箱；正文和图片邮箱不重复扫描。' })
    try {
      const idempotencyKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `application-contact:${jobId}:${crypto.randomUUID()}`
        : `application-contact:${jobId}:${Date.now()}`
      const response = await api.resumeAudience(jobId, idempotencyKey)
      if (response.action === 'already_complete') {
        setCommentCollectionBusy(false)
        setNotice({ tone: 'success', text: '当前岗位的评论数据已经完整，邮箱解析结果已刷新。' })
        refreshCandidateCorpus()
        return
      }
      setNotice({ tone: 'info', text: '评论邮箱采集已启动，岗位投递清单会自动更新。' })
      refreshCandidateCorpus()
    } catch (error) {
      setCommentCollectionBusy(false)
      setNotice({ tone: 'error', text: (error as ApiError).message || '评论邮箱采集启动失败，请稍后重试。' })
    }
  }

  async function bulkPolishSelected() {
    if (!selectedIds.length || busy) return
    if (!aiSessionId) {
      setNotice({ tone: 'error', text: 'AI 会话未就绪，请先启用高级模型后再批量润色。' })
      return
    }

    const failures: string[] = []
    const targets = selectedIds.flatMap((noteId) => {
      const item = candidateById.get(noteId)
      if (!item) {
        failures.push(`${noteId}：候选数据尚未加载`)
        return []
      }
      return [{ noteId, item }]
    })
    if (!targets.length) {
      setBulkPolishProgress({ completed: failures.length, total: selectedIds.length, succeeded: 0, failed: failures.length })
      setNotice({ tone: 'error', text: `没有可润色的已选岗位；${failures[0] || '请刷新候选清单后重试。'}` })
      return
    }

    const requestId = ++bulkPolishRequest.current
    let succeeded = 0
    let failed = failures.length
    let nextTarget = 0
    dryRunRequest.current += 1
    setPreflight(null)
    setPreflightSelectionConfirmed(false)
    setBusy('bulk-polish')
    setNotice({ tone: 'info', text: `正在批量润色 ${selectedIds.length} 条 Cover Letter，完成后需重新运行投递预演。` })
    setBulkPolishProgress({ completed: failed, total: selectedIds.length, succeeded, failed })

    const updateProgress = () => {
      if (bulkPolishRequest.current !== requestId) return
      setBulkPolishProgress({
        completed: succeeded + failed,
        total: selectedIds.length,
        succeeded,
        failed,
      })
    }
    const worker = async () => {
      while (bulkPolishRequest.current === requestId && nextTarget < targets.length) {
        const target = targets[nextTarget]
        nextTarget += 1
        const { item, noteId } = target
        const applicationContext = item.outreach.applicationContext || defaultApplicationContext(item)
        const outreach = applicationOutreachDraft(item)
        try {
          let draftVersion = item.draftVersion
          if (!draftVersion) {
            const saved = await api.saveDraft(jobId, noteId, outreach, undefined, applicationContext)
            if (!saved.draftVersion) throw new Error('服务端未返回文案版本')
            draftVersion = saved.draftVersion
          }
          if (bulkPolishRequest.current !== requestId) return
          const response = await api.rewriteCoverLetter(jobId, {
            noteId,
            aiSessionId,
            instructions: BULK_POLISH_INSTRUCTIONS,
            outreach,
            applicationContext,
            draftId: draftVersion.draftId,
            baseVersion: draftVersion.version,
          })
          if (bulkPolishRequest.current !== requestId) return
          if (!response.outreach.cover_letter?.trim()) throw new Error('高级模型未返回 Cover Letter')
          const nextItem: ApplicationResult = {
            ...item,
            emailSubjectPreview: response.outreach.email_subject?.trim() || item.emailSubjectPreview,
            outreach: {
              ...item.outreach,
              ...response.outreach,
              generation_mode: 'model_rewrite',
              runtime_status: 'generated_pending_quality',
              status: 'needs_review',
              applicationContext,
            },
            draftVersion: response.draftVersion,
            delivery: response.delivery,
            cover_letter_evaluation: response.cover_letter_evaluation || item.cover_letter_evaluation,
          }
          candidateItemCache.current.set(noteId, nextItem)
          setCandidateCorpus((current) => current && current.jobId === jobId
            ? { ...current, items: current.items.map((candidate) => candidate.note_id === noteId ? nextItem : candidate) }
            : current)
          succeeded += 1
        } catch (error) {
          failed += 1
          const message = (error as ApiError).message || (error as Error).message || '润色失败'
          failures.push(`${item.job_card?.role_name || item.title || noteId}：${message}`)
        }
        updateProgress()
      }
    }

    try {
      const workerCount = Math.min(2, targets.length)
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      if (bulkPolishRequest.current !== requestId) return
      const failureSummary = failures.slice(0, 2).join('；')
      setNotice({
        tone: failed ? 'info' : 'success',
        text: failed
          ? `批量润色完成：成功 ${succeeded} 条，失败 ${failed} 条${failureSummary ? `；${failureSummary}` : ''}。旧投递预演已失效。`
          : `批量润色完成：成功 ${succeeded} 条。已生成新草稿版本，请重新质量检查并运行投递预演。`,
      })
    } finally {
      if (bulkPolishRequest.current === requestId) {
        refreshCandidateCorpus()
        setBusy('')
      }
    }
  }

  function requestCandidatePage(offset: number, cursor?: string) {
    if (offset > 0 && !cursor) return
    setCandidatePageRequest({
      filterSignature: candidateFilterSignature,
      offset,
      cursor,
    })
  }

  function showPreviousCandidatePage() {
    const offset = Math.max(0, candidateOffset - candidatePageSize)
    requestCandidatePage(offset, candidatePageCursors.current.get(candidateFilterSignature)?.get(offset))
  }

  function showNextCandidatePage() {
    if (!candidateCorpus?.nextCursor) return
    requestCandidatePage(candidateOffset + rows.length, candidateCorpus.nextCursor)
  }

  function selectCurrentPage() {
    invalidateSelectionPreflight()
    const nextIds = rows.map((item) => item.note_id)
    const accepted = nextIds.slice(0, MAX_BATCH_SIZE)
    setSelected(new Set(accepted))
    setNotice({
      tone: nextIds.length > MAX_BATCH_SIZE ? 'info' : 'success',
      text: nextIds.length > MAX_BATCH_SIZE
        ? `当前页有 ${nextIds.length} 个岗位，批次上限为 ${MAX_BATCH_SIZE}，已明确选择前 ${MAX_BATCH_SIZE} 个，另有 ${nextIds.length - MAX_BATCH_SIZE} 个未选择。`
        : `已选择当前页 ${accepted.length} 个岗位。`,
    })
  }

  function selectFirstReady() {
    invalidateSelectionPreflight()
    const ready = selectionSnapshot?.readyNoteIds || []
    const next = ready.slice(0, selectionLimit)
    setSelected(new Set(next))
    setNotice({
      tone: 'info',
      text: ready.length < selectionLimit
        ? `当前筛选只有 ${ready.length} 个可投递岗位，已全部选择。`
        : `已选择当前筛选前 ${selectionLimit} 个可投递岗位。`,
    })
  }

  function keepOnlyReady() {
    invalidateSelectionPreflight()
    const retained = selectedIds.filter((noteId) => {
      if (readyNoteIds.has(noteId)) return true
      const item = candidateById.get(noteId)
      return Boolean(item && isCandidateReady(item, preflightById.get(noteId), batchItemByNoteId.get(noteId)))
    })
    const removed = selected.size - retained.length
    setSelected(new Set(retained))
    if (preflightReference && preflight?.manifestHash && sameStringSet(retained, preflight.readyNoteIds)) {
      setPreflightSelectionConfirmed(true)
    }
    setNotice({ tone: 'info', text: `已保留 ${retained.length} 个可投递岗位，移除 ${removed} 个非就绪岗位。` })
  }

  function cleanupSelection() {
    invalidateSelectionPreflight()
    const outside = new Set(selectedOutsideFilterIds)
    const invalid = new Set(selectedInvalidIds)
    const removed = new Set([...outside, ...invalid])
    setSelected(new Set(selectedIds.filter((noteId) => !removed.has(noteId))))
    setNotice({
      tone: 'info',
      text: `选择已清理：筛选外 ${outside.size} 个，无效 ${invalid.size} 个，共移除 ${removed.size} 个。`,
    })
  }

  function clearSelection() {
    invalidateSelectionPreflight()
    const removed = selected.size
    setSelected(new Set())
    setNotice({ tone: 'info', text: `已清空 ${removed} 个已选岗位。` })
  }

  function toggle(noteId: string, checked: boolean) {
    invalidateSelectionPreflight()
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

  function toggleCoverLetter(noteId: string) {
    setExpandedCoverLetters((current) => {
      const next = new Set(current)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }

  async function copyDeliveryContent(noteId: string, emailBody: string, coverLetter: string) {
    const sections = [
      emailBody ? `邮件正文\n${emailBody}` : '',
      coverLetter ? `Cover Letter\n${coverLetter}` : '',
    ].filter(Boolean)
    if (!sections.length) return
    const content = sections.join('\n\n')
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(content)
      else copyTextFallback(content)
      setCopiedDeliveryNoteId(noteId)
      window.setTimeout(() => setCopiedDeliveryNoteId((current) => current === noteId ? '' : current), 1_600)
    } catch {
      copyTextFallback(content)
      setCopiedDeliveryNoteId(noteId)
    }
  }

  function updateAttachmentTemplate(value: string) {
    dryRunRequest.current += 1
    setBusy((current) => current === 'dry-run' ? '' : current)
    setAttachmentTemplate(value)
    if (!preflight) return
    setPreflight(null)
    setPreflightSelectionConfirmed(false)
    setNotice({ tone: 'info', text: '附件命名规则已变化，请重新运行投递预演。' })
  }

  return (
    <section id="batch-application-panel" className={`batch-application-panel ${standalone ? 'standalone' : ''} ${layoutMode === 'quick' ? 'quick-view' : 'detail-view'}`} aria-label="批量投递工作台">
      <header className="batch-application-header">
        <div className="batch-application-heading">
          <span className="batch-application-icon"><Send size={18} /></span>
          <div><h3>极速投递</h3><small>{candidateTotal} 个岗位 · 已选 {selected.size}</small></div>
        </div>
        <div className="batch-application-header-actions">
          <div className="batch-layout-switch" role="group" aria-label="投递视图">
            <button type="button" aria-label="极速视图" aria-pressed={layoutMode === 'quick'} onClick={() => setLayoutMode('quick')}><Gauge size={14} /><span>极速</span></button>
            <button type="button" aria-label="详细视图" aria-pressed={layoutMode === 'detail'} onClick={() => setLayoutMode('detail')}><Layers3 size={14} /><span>详细</span></button>
          </div>
          {batch && <span className={`batch-status-badge ${batch.status}`}>{batchStatusLabel(batch.status)}</span>}
          {batch && !batchTerminal && <span className={`batch-stream-state ${streamState}`}><i />{streamState === 'live' ? '实时' : '连接中'}</span>}
          {!standalone && <button type="button" className="icon-button" title={expanded ? '收起批量投递工作台' : '展开批量投递工作台'} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
        </div>
      </header>

      {expanded && <div className="batch-application-body">
        <div className="batch-toolbar">
          <label className="batch-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索岗位、邮箱、主题或附件名" title="同时搜索邮件正文和 Cover Letter" /><span className="batch-search-summary" aria-live="polite"><b>待投岗位 {candidateSourceTotal} 项</b><b>筛选结果 {candidateTotal} 项</b>{batch && <b>当前批次 {visibleBatchItems.length} 封</b>}</span></label>
          <div className="batch-selection-actions">
            <span className="batch-selection-summary">已选 <strong>{selected.size}</strong> / {MAX_BATCH_SIZE}<small>{candidateLoading ? '选择校验中' : `筛选外 ${selectedOutsideFilterIds.length} · 无效 ${selectedInvalidIds.length}${selectedMissingRevisionIds.length ? ` · 修订缺失 ${selectedMissingRevisionIds.length}，请重新加载` : ''}`}</small></span>
            <button type="button" aria-label="选择当前页" onClick={selectCurrentPage} disabled={candidateLoading || rows.length === 0}><CheckCircle2 size={15} /><span>本页全选</span></button>
            <label className={`batch-selection-limit ${selectionLimitMode === 'custom' ? 'custom' : ''}`}><span>批量数量</span><select aria-label="批量数量预设" value={selectionLimitMode === 'custom' ? 'custom' : selectionLimit} onChange={(event) => { if (event.target.value === 'custom') { setSelectionLimitMode('custom') } else { setSelectionLimitMode('preset'); setSelectionLimit(clampSelectionLimit(event.target.value)) } }}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option><option value="custom">自定义</option></select>{selectionLimitMode === 'custom' && <input aria-label="自定义批量数量" type="number" min={1} max={MAX_BATCH_SIZE} step={1} value={selectionLimit} onChange={(event) => setSelectionLimit(clampSelectionLimit(event.target.value))} />}</label>
            <button type="button" className="batch-select-ready" aria-label={`选择前 ${selectionLimit} 条可投递`} onClick={selectFirstReady} disabled={candidateLoading || candidateTotal === 0}><CheckCircle2 size={15} /><span>选前 {selectionLimit} 个</span></button>
            <button type="button" className="batch-clear-selection" aria-label="清空" onClick={clearSelection} disabled={selected.size === 0}><XCircle size={15} /><span>清空</span></button>
            <details className="batch-settings batch-more-tools">
              <summary><SlidersHorizontal size={15} />更多</summary>
              <div className="batch-more-tools-menu">
                <div className="batch-more-actions">
                  <button type="button" className="batch-bulk-polish" title={aiSessionId ? '按岗位要求逐条重写已选 Cover Letter；完成后需要重新质量检查' : '请先启用高级模型'} disabled={!selected.size || !aiSessionId || Boolean(busy) || candidateLoading} onClick={() => void bulkPolishSelected()}>{busy === 'bulk-polish' ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}批量一键润色</button>
                  <button type="button" onClick={keepOnlyReady} disabled={candidateLoading || selected.size === 0}>仅保留可投递</button>
                  <button type="button" onClick={cleanupSelection} disabled={candidateLoading || selectedOutsideFilterIds.length + selectedInvalidIds.length === 0}>清理选择</button>
                </div>
                <div className="batch-settings-fields">
                  <label><span>默认附件格式</span><input value={attachmentTemplate} onChange={(event) => updateAttachmentTemplate(event.target.value)} /></label>
                  <label><span>发送间隔（秒）</span><input type="number" min={0} max={60} step={1} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value) || 0)} /></label>
                </div>
                {bulkPolishProgress.total > 0 && <span className={`batch-polish-progress ${bulkPolishProgress.failed ? 'partial' : ''}`} role="status" aria-live="polite">已处理 {bulkPolishProgress.completed}/{bulkPolishProgress.total}<small>成功 {bulkPolishProgress.succeeded} · 失败 {bulkPolishProgress.failed}</small></span>}
              </div>
            </details>
          </div>
        </div>

        <section className="batch-send-dock" aria-label="批量投递操作">
          <div className="batch-send-dock-summary" aria-live="polite">
            <strong>{sendNextStep}</strong>
            <small>{preflight ? `${preflightReadyCount} 就绪${preflightPreparableCount > 0 ? ` · ${preflightPreparableCount} 可准备` : ''}${preflightBlockedCount > 0 ? ` · ${preflightBlockedCount} 阻塞` : ''}` : `${candidateTotal} 个岗位`}</small>
          </div>
          <div className="batch-send-actions">
            <button type="button" aria-label="预览邮件" title={selectedMissingRevisionIds.length ? '已选岗位修订缺失，请重新加载候选清单' : !batchTerminal ? '当前批次结束后才能预览下一批邮件' : '生成待发送邮件预览，不会发送'} disabled={!selected.size || selectedMissingRevisionIds.length > 0 || Boolean(busy) || candidateLoading || !batchTerminal} onClick={() => void runDryRun()}>{busy === 'dry-run' ? <LoaderCircle className="spin" size={17} /> : <Eye size={17} />}<span>预览</span><small>{selected.size || ''}</small></button>
            <button type="button" className="actual-send" aria-label="发送邮件" disabled={!canSend} title={batchAwaitingSend ? `继续真实发送 ${sendCount} 封邮件` : canStartNewBatch ? `锁定当前预览并真实发送 ${sendCount} 封邮件` : '请先预览邮件，并保持就绪清单与命名规则不变'} onClick={() => void sendPreviewedBatch()}>{busy === 'send' ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}<span>{busy === 'send' ? '启动中' : batch?.status === 'running' ? '发送中' : '发送'}</span><small>{sendCount || ''}</small></button>
          </div>
        </section>

        {shouldShowCommentCollection && <div className="batch-contact-discovery-bar" role="status" aria-live="polite">
          <div className="batch-contact-discovery-summary">
            <Mail size={16} />
            <strong>岗位邮箱发现</strong>
            <span>评论邮箱 {commentEmailCount} 条</span>
            {commentsPending > 0 && <span className="batch-contact-pending">待采集 {commentsPending} 条</span>}
            {commentsPartial > 0 && <span className="batch-contact-pending">采集未完成 {commentsPartial} 条</span>}
          </div>
          <button
            type="button"
            className="batch-contact-discovery-action"
            disabled={commentCollectionBusy || candidateLoading || (commentsPending === 0 && commentsPartial === 0)}
            onClick={() => void startCommentCollection()}
          >
            {commentCollectionBusy ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
            {commentCollectionBusy ? '评论采集中' : '采集评论邮箱'}
          </button>
        </div>}

        <div className="batch-filter-strip" aria-label="投递筛选">
          <div className="batch-filter-options" role="group" aria-label="投递状态筛选">
            {BATCH_VIEW_OPTIONS.map((option) => <button
              key={option.value}
              type="button"
              className={workbenchFilters.view === option.value ? 'active' : ''}
              aria-pressed={workbenchFilters.view === option.value}
              onClick={() => { setWorkbenchFilters((current) => ({ ...current, view: option.value })); setCandidateOffset(0) }}
            >{option.label}</button>)}
          </div>
          <details className="batch-filter-details">
            <summary><SlidersHorizontal size={14} />精确筛选</summary>
            <div className="batch-filter-selects">
              <select aria-label="收件人筛选" value={workbenchFilters.recipient} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, recipient: event.target.value as BatchRecipientFilter })); setCandidateOffset(0) }}>{RECIPIENT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <select aria-label="文案筛选" value={workbenchFilters.copy} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, copy: event.target.value as BatchCopyFilter })); setCandidateOffset(0) }}>{COPY_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <select aria-label="标题筛选" value={workbenchFilters.subject} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, subject: event.target.value as BatchSubjectFilter })); setCandidateOffset(0) }}>{SUBJECT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <select aria-label="附件筛选" value={workbenchFilters.attachment} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, attachment: event.target.value as BatchAttachmentFilter })); setCandidateOffset(0) }}>{ATTACHMENT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </div>
          </details>
          {(!isDefaultWorkbenchFilters(workbenchFilters) || normalizedQuery) && <button type="button" className="batch-clear-filters" onClick={() => { setWorkbenchFilters(DEFAULT_WORKBENCH_FILTERS); setQuery(''); setCandidateOffset(0) }}>清除筛选</button>}
        </div>

        {notice && <div className={`batch-notice ${notice.tone}`}>{notice.tone === 'error' ? <AlertTriangle size={16} /> : notice.tone === 'success' ? <CheckCircle2 size={16} /> : <Gauge size={16} />}<span>{notice.text}</span></div>}
        {candidateError && <div className="batch-notice error"><AlertTriangle size={16} /><span>{candidateError}</span></div>}

        <div className="batch-table-wrap">
          <table className="batch-application-table">
            <thead><tr><th aria-label="选择" /><th>岗位</th><th>收件邮箱</th><th>文案质量</th><th>投递正文</th><th>岗位事实</th><th>邮件标题与附件命名</th><th>状态 / 修复</th></tr></thead>
            <tbody>{rows.map((item) => {
              const checked = preflightById.get(item.note_id)
              const savedBatchItem = batchItemByNoteId.get(item.note_id)
              const savedRecipient = typeof savedBatchItem?.payload.recipient === 'string' ? savedBatchItem.payload.recipient : ''
              const savedSubject = applicationEmailSubject(item, checked, savedBatchItem)
              const savedFilenames = Array.isArray(savedBatchItem?.payload.finalFilenames) ? savedBatchItem.payload.finalFilenames.map(String) : []
              const emailBody = applicationEmailBody(item, checked, savedBatchItem)
              const coverLetter = applicationCoverLetter(item, checked, savedBatchItem)
              const roleName = item.job_card?.role_name || item.title || '未命名岗位'
              const responsibilities = applicationFactPoints(item, 'responsibilities')
              const requirements = applicationFactPoints(item, 'requirements')
              const originalBody = item.body?.trim() || ''
              const coverLetterExpanded = expandedCoverLetters.has(item.note_id)
              const copyEditorOpen = copyEditor?.noteId === item.note_id
              const contentVersion = checked?.preview?.draftVersion || savedBatchItem?.payload.coverLetterVersion || item.draftVersion?.version
              const contentHash = checked?.manifestHash || checked?.coverLetterHash || savedBatchItem?.payload.coverLetterHash || item.draftVersion?.contentHash || ''
              const resultContact = firstApplicationContact(item)
              const liveResolution = checked?.contactResolution || item.contactDiscovery
              const liveCandidate = liveResolution?.candidates?.[0]
              const resolvedContact = checked?.contact || resultContact || (liveCandidate ? candidateContactDisplay(liveCandidate) : null)
              const email = resolvedContact?.address || savedRecipient
              const contactEvidence = resolvedContact ? applicationContactEvidence(item, resolvedContact) : null
              const contactWasNormalized = Boolean(
                resolvedContact?.normalizationApplied
                || resolvedContact?.verificationStatus?.toLowerCase().includes('normalized'),
              )
              const status = checked?.status || savedBatchItem?.status
              const copyQuality = item.outreach?.content_quality
              const copyQualityBlocked = copyQuality?.batch_ready === false
                || item.deliveryManifestSummary?.copyStatus === 'quality_failed'
              const subjectGuard = item.emailSubjectGuard
              const subjectNeedsReview = subjectGuard?.requiresReview === true
                || ['rejected_noisy_title', 'rejected_bare_title', 'rejected_unverified_subject']
                  .includes(String(subjectGuard?.sourceStatus || ''))
              const qualityPassed = item.draftVersion?.qualityStatus === 'passed' && !copyQualityBlocked
              const aiMechanismPending = copyQuality?.ai_product_role === true && copyQuality.ai_product_mechanism_pass === false
              const candidates = liveResolution?.candidates || []
              const collectionIncomplete = liveResolution && liveResolution.collectionStatus !== 'complete'
              const candidateReady = isCandidateReady(item, checked, savedBatchItem)
              return <tr key={item.note_id} className={`${selected.has(item.note_id) ? 'selected' : ''} ${status ? `status-${status}` : ''}`}>
                <td data-label="选择"><label className="batch-checkbox"><input type="checkbox" checked={selected.has(item.note_id)} onChange={(event) => toggle(item.note_id, event.target.checked)} /><span><Check size={13} /></span></label></td>
                <td data-label="岗位"><strong>{roleName}</strong><small>{item.title}</small><small className={`batch-body-status ${item.body?.trim() ? 'ready' : 'pending'}`}>{item.body?.trim() ? `正文已保存 · ${item.body.trim().length} 字` : '正文待续采'}</small>{item.body?.trim() && <button type="button" className="batch-body-open" onClick={() => onOpenItem(item)}><FileText size={12} />查看正文</button>}</td>
                <td data-label="收件邮箱">
                  {email ? <><strong className="batch-email"><Mail size={13} />{email}</strong><span className={`contact-source ${resolvedContact?.source || (savedRecipient ? 'batch' : 'body')}`}>{resolvedContact ? contactSourceLabel(resolvedContact.source, resolvedContact.verificationStatus, resolvedContact.normalizationApplied) : '发送批次'}</span></> : <span className="batch-muted">待解析</span>}
                  {contactEvidence && (contactWasNormalized || resolvedContact?.source === 'image') && <small className="batch-contact-evidence" title={contactEvidence.evidenceText}>{contactWasNormalized ? '原始写法' : 'OCR 证据'}：{contactEvidence.evidenceText}</small>}
                  {resolvedContact?.source === 'image' && <button type="button" className="batch-contact-evidence-action" onClick={() => onOpenItem(item)} title={contactEvidence?.sourceImageIndex ? `查看第 ${contactEvidence.sourceImageIndex} 张图片中的邮箱证据` : '查看岗位图片中的邮箱证据'}><Eye size={12} />查看图片证据</button>}
                  {collectionIncomplete && <small className="batch-warning">评论采集未完成</small>}
                </td>
                <td data-label="文案质量">
                  <span className={`quality-pill ${qualityPassed ? 'passed' : 'pending'}`}>{copyQualityBlocked ? '文案需重生成' : qualityPassed ? '门禁通过' : '待复检'}</span>
                  <small>{item.cover_letter_evaluation?.score ?? '-'} 分 · v{item.draftVersion?.version ?? '-'}</small>
                  {copyQuality && <small className="batch-copy-quality-detail">
                    {typeof copyQuality.cover_letter_chars === 'number' ? `${copyQuality.cover_letter_chars} 字` : '正文待生成'}
                    {' · '}{copyQuality.role_evidence_count ?? 0} 条岗位证据
                    {copyQuality.ai_product_role ? ` · AI机制${aiMechanismPending ? '待补' : '通过'}` : ''}
                  </small>}
                </td>
                <td data-label="投递正文" className="batch-cover-letter-cell batch-delivery-copy-cell">
                  <div className="batch-delivery-copy-heading">
                    <small className="batch-field-label">邮件正文与 Cover Letter</small>
                    {!copyEditorOpen && <span className="batch-delivery-copy-tools">
                      <button
                        type="button"
                        className="batch-copy-content"
                        aria-label={copiedDeliveryNoteId === item.note_id ? '已复制' : '复制正文'}
                        title="复制邮件正文与 Cover Letter"
                        disabled={!emailBody && !coverLetter}
                        onClick={() => void copyDeliveryContent(item.note_id, emailBody, coverLetter)}
                      >
                        <Copy size={12} />
                        {copiedDeliveryNoteId === item.note_id ? '已复制' : '复制'}
                      </button>
                      <button type="button" className="batch-edit-content" title="编辑邮件标题、邮件正文和 Cover Letter" onClick={() => openCopyEditor(item, savedSubject, emailBody, coverLetter)}><Pencil size={12} />编辑正文</button>
                    </span>}
                  </div>
                  {copyEditorOpen && copyEditor ? <div className="batch-copy-editor" data-testid={`batch-copy-editor-${item.note_id}`}>
                    <label><span>邮件标题</span><input aria-label={`邮件标题 ${item.note_id}`} value={copyEditor.emailSubject} onChange={(event) => setCopyEditor((current) => current?.noteId === item.note_id ? { ...current, emailSubject: event.target.value } : current)} /></label>
                    <label><span>邮件正文</span><textarea aria-label={`邮件正文 ${item.note_id}`} rows={7} value={copyEditor.emailBody} onChange={(event) => setCopyEditor((current) => current?.noteId === item.note_id ? { ...current, emailBody: event.target.value } : current)} /></label>
                    <label><span>Cover Letter</span><textarea aria-label={`Cover Letter ${item.note_id}`} rows={9} value={copyEditor.coverLetter} onChange={(event) => setCopyEditor((current) => current?.noteId === item.note_id ? { ...current, coverLetter: event.target.value } : current)} /></label>
                    <small>保存会生成新草稿版本；旧投递预演自动失效，已冻结的历史批次保持不变。</small>
                    <div className="batch-copy-editor-actions">
                      <button type="button" disabled={copySavingNoteId === item.note_id} onClick={() => setCopyEditor(null)}>取消</button>
                      <button type="button" className="primary" disabled={copySavingNoteId === item.note_id} onClick={() => void saveCopyEditor(item)}>{copySavingNoteId === item.note_id ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存正文</button>
                    </div>
                  </div> : <>
                    {emailBody ? <div className={`batch-cover-letter-text batch-email-body-text ${coverLetterExpanded ? 'expanded' : ''}`} data-testid={`batch-email-body-${item.note_id}`}>{emailBody}</div> : <span className="batch-cover-letter-empty">邮件正文待生成</span>}
                    <small className="batch-field-label batch-cover-letter-label">Cover Letter</small>
                    {coverLetter ? <div className={`batch-cover-letter-text ${coverLetterExpanded ? 'expanded' : ''}`} data-testid={`batch-cover-letter-${item.note_id}`}>{coverLetter}</div> : <span className="batch-cover-letter-empty">Cover Letter 待生成</span>}
                    <span className="batch-cover-letter-meta">{emailBody.length} / {coverLetter.length} 字 · {contentVersion ? `v${contentVersion}` : '版本待生成'} · {contentHash ? `Hash ${contentHash.slice(0, 10)}...` : 'Hash 待生成'}</span>
                    {(emailBody || coverLetter) && <button type="button" className="batch-cover-letter-toggle" aria-expanded={coverLetterExpanded} onClick={() => toggleCoverLetter(item.note_id)}><FileText size={12} />{coverLetterExpanded ? '收起全文' : '展开全文'}</button>}
                  </>}
                </td>
                <td data-label="岗位事实" className="batch-job-facts-cell">
                  <div className="batch-job-fact-block">
                    <small className="batch-field-label">岗位职责</small>
                    {responsibilities.length > 0
                      ? <ul data-testid={`batch-responsibilities-${item.note_id}`}>{responsibilities.slice(0, 3).map((point) => <li key={point}>{point}</li>)}</ul>
                      : <span className="batch-muted">未提取</span>}
                    {responsibilities.length > 3 && <details><summary>展开其余 {responsibilities.length - 3} 条</summary><ul>{responsibilities.slice(3).map((point) => <li key={point}>{point}</li>)}</ul></details>}
                  </div>
                  <div className="batch-job-fact-block">
                    <small className="batch-field-label">岗位要求</small>
                    {requirements.length > 0
                      ? <ul data-testid={`batch-requirements-${item.note_id}`}>{requirements.slice(0, 3).map((point) => <li key={point}>{point}</li>)}</ul>
                      : <span className="batch-muted">未提取</span>}
                    {requirements.length > 3 && <details><summary>展开其余 {requirements.length - 3} 条</summary><ul>{requirements.slice(3).map((point) => <li key={point}>{point}</li>)}</ul></details>}
                  </div>
                  <details className="batch-original-body" data-testid={`batch-original-body-${item.note_id}`}>
                    <summary><span>原始正文</span><small>{originalBody ? `${originalBody.length} 字` : '未采集'}</small></summary>
                    {originalBody ? <div>{originalBody}</div> : <span className="batch-muted">原始正文未采集</span>}
                  </details>
                </td>
                <td data-label="邮件标题与附件命名">
                  <small className="batch-field-label">实际发送标题</small>
                  <strong className={`batch-subject ${subjectNeedsReview ? 'needs-review' : ''}`}>{subjectNeedsReview ? subjectGuard?.suggestedSubject || '主题待重生成' : savedSubject || '主题待生成'}</strong>
                  {savedSubject && !subjectNeedsReview && <small className="batch-subject-source">{applicationEmailSubjectSourceLabel(item)}</small>}
                  {subjectNeedsReview && <small className="batch-blocker">原帖标题不是岗位名，主题待按准确岗位名重生成</small>}
                  {item.emailSubjectRequirement?.detected && <span className="batch-email-subject-rule" title={item.emailSubjectRequirement.evidence}><Mail size={12} /><span><small>{applicationEmailSubjectRuleLabel(item)}</small><b>{item.emailSubjectRequirement.template}</b><em>{applicationEmailSubjectRuleHint(item)}</em></span></span>}
                  {checked?.attachments?.length ? checked.attachments.map((attachment) => {
                    const plannedName = applicationAttachmentPlannedName(attachment)
                    const willRename = attachment.willRename ?? attachment.renameRequired ?? plannedName !== attachment.currentDisplayName
                    return <span className={`batch-filename ${willRename ? 'will-rename' : 'unchanged'}`} key={attachment.attachmentId}><Paperclip size={12} /><span><small className="batch-filename-state">{preflight?.dryRun ? willRename ? '投递预演 · 计划发送名' : '投递预演 · 名称无需修改' : '冻结批次 · 实际发送名'}</small>{willRename && <s>{attachment.currentDisplayName || attachment.originalName}</s>}<b>{plannedName}</b><small>{[attachment.size ? formatBytes(attachment.size) : '', attachment.sha256 ? `SHA-256 ${attachment.sha256.slice(0, 10)}...` : '待校验'].filter(Boolean).join(' · ')}</small></span></span>
                  }) : savedFilenames.length ? <span className="batch-filename applied"><Paperclip size={12} /><span><small className="batch-filename-state">冻结批次 · 实际发送名</small>{savedFilenames.map((filename) => <b key={filename}>{filename}</b>)}</span></span> : <>
                    {item.attachmentRequirement?.detected ? <span className="batch-article-attachment-rule" title={item.attachmentRequirement.evidence}><Paperclip size={12} /><span><small>文章附件格式</small><b>{item.attachmentRequirement.template}</b><em>选择简历后按此格式生成发送名</em></span></span> : <span className="batch-default-attachment-rule"><Paperclip size={12} /><span><small>默认附件格式</small><b>{attachmentTemplate}</b></span></span>}
                    <small className="batch-muted">附件待预检</small>
                  </>}
                </td>
                <td data-label="状态 / 修复">
                  <span className={`batch-quick-readiness ${candidateReady ? 'ready' : 'review'}`}>{candidateReady ? '可投递' : '需处理'}</span>
                  <span className={`item-status ${status || 'resolving'}`}>{status ? itemStatusLabel(status) : '待预览'}</span>
                  {copyQuality?.attachment_claim_without_context && <small className="batch-blocker">附件声明缺少上下文</small>}
                  {copyQualityBlocked && <small className="batch-blocker">文案质量门禁未通过，请重新生成</small>}
                  {subjectNeedsReview && <small className="batch-blocker">邮件主题需要岗位名复核</small>}
                  {checked?.blockers?.map((blocker) => <small className="batch-blocker" key={blocker.code}>{blocker.message}</small>)}
                  {checked?.canPrepare && checked.status !== 'ready' && <button type="button" className="batch-row-action" onClick={() => toggle(item.note_id, true)}>纳入自动准备</button>}
                  {checked && !checked.canPrepare && checked.status !== 'ready' && candidates.length === 0 && <button type="button" className="batch-row-action" onClick={() => onOpenItem(item)}>打开岗位</button>}
                  {candidates.length > 0 && <div className="contact-review-list">{candidates.map((candidate) => <button type="button" className={approvals[item.note_id] === candidate.evidenceHash ? 'confirmed' : ''} key={candidate.evidenceHash} onClick={() => void confirmContact(item.note_id, candidate)} title={candidate.evidenceText}><span>{candidate.address}</span><small>{contactSourceLabel(candidate.source, candidate.verificationStatus, candidate.normalizationApplied)} · {candidate.evidenceText}</small>{approvals[item.note_id] === candidate.evidenceHash ? <Check size={13} /> : <ShieldCheck size={13} />}</button>)}</div>}
                  <button type="button" className="batch-row-detail" aria-label={`查看 ${roleName} 投递详情`} onClick={() => setLayoutMode('detail')}><Eye size={13} /><span>详情</span></button>
                </td>
              </tr>
            })}{rows.length === 0 && <tr className="batch-search-empty-row"><td colSpan={8} data-label="搜索">当前筛选没有匹配岗位{batch ? `；当前发送批次匹配 ${visibleBatchItems.length} 封` : ''}。</td></tr>}</tbody>
          </table>
        </div>

        <div className="batch-candidate-pagination" aria-busy={candidateLoading}>
          <span>{candidateLoading ? <><LoaderCircle className="spin" size={14} />正在读取当前页</> : candidateTotal > 0 && rows.length > 0 ? `${candidateOffset + 1}-${Math.min(candidateOffset + rows.length, candidateTotal)} / ${candidateTotal}` : `0 / ${candidateTotal}`}</span>
          <div className="batch-candidate-pagination-controls">
            <label className="batch-page-size"><span>每页</span><select aria-label="每页显示数量" value={candidatePageSize} onChange={(event) => setCandidatePageSize(clampCandidatePageSize(event.target.value))}>{CANDIDATE_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></label>
            <button type="button" title="上一页待投岗位" disabled={candidateLoading || candidateOffset === 0} onClick={showPreviousCandidatePage}><ChevronLeft size={16} /></button>
            <button type="button" title="下一页待投岗位" disabled={candidateLoading || !candidateCorpus?.nextCursor} onClick={showNextCandidatePage}><ChevronRight size={16} /></button>
          </div>
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
                  const coverLetter = payloadCoverLetter(payload)
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
                    {coverLetter ? <details className="batch-email-preview-cover-letter">
                      <summary><FileText size={13} />Cover Letter 正文 <span>{coverLetter.length} 字</span></summary>
                      <div>{coverLetter}</div>
                    </details> : <div className="batch-email-preview-cover-letter-missing">历史快照未保存</div>}
                    {filenames.length > 0 && <div className="batch-email-preview-attachments" aria-label="发送附件">
                      {filenames.map((filename) => <span className="batch-email-preview-attachment" key={filename}><Paperclip size={12} />{filename}</span>)}
                    </div>}
                  </article>
                })}
                {visibleBatchEmails.length === 0 && <div className="batch-filter-empty">没有匹配的邮件正文。</div>}
              </div>
            </section>
            <div className="batch-control-actions">
              <span>发送中控制</span>
              <button type="button" disabled={batch.status !== 'running' || Boolean(busy)} onClick={() => void controlBatch('pause')}>{busy === 'pause' ? <LoaderCircle className="spin" size={16} /> : <Pause size={16} />}暂停发送</button>
              <button type="button" disabled={batch.status !== 'paused' || Boolean(busy) || !(batch.counts.ready || batch.counts.failed_retryable)} onClick={() => void controlBatch('resume')}>{busy === 'resume' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}继续发送</button>
              <button type="button" className="danger" disabled={batchTerminal || Boolean(busy)} onClick={() => void controlBatch('cancel')}>{busy === 'cancel' ? <LoaderCircle className="spin" size={16} /> : <XCircle size={16} />}取消未发送邮件</button>
            </div>
          </>}
        </section>}
      </div>}
    </section>
  )
}

function splitBatchCoverLetter(value: unknown): { subject: string; body: string } {
  const body = String(value || '').trim()
  if (!body) return { subject: '', body: '' }
  const heading = body.match(/^\s*(?:主题|邮件主题|Subject)\s*[:：]\s*([^\r\n]+)\s*(?:\r?\n|$)/iu)
  if (heading) return { subject: heading[1].trim(), body: body.slice(heading[0].length).trim() }
  const firstLineBreak = body.indexOf('\n')
  if (firstLineBreak > 0) {
    const firstLine = body.slice(0, firstLineBreak).trim()
    const remainder = body.slice(firstLineBreak + 1).trim()
    if (
      firstLine.length <= 120
      && !/^(?:尊敬|Dear|您好|Hi)\b/iu.test(firstLine)
      && (/尊敬|招聘负责人|Dear/iu.test(remainder.slice(0, 160)) || /申请|应聘|求职/u.test(firstLine) || firstLine.includes('｜'))
    ) return { subject: firstLine, body: remainder }
  }
  return { subject: '', body }
}

function payloadCoverLetter(payload: ApplicationBatch['items'][number]['payload']) {
  const record = payload as Record<string, unknown>
  for (const key of ['coverLetter', 'cover_letter']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return splitBatchCoverLetter(value).body
  }
  return ''
}

function applicationCoverLetter(
  item: ApplicationResult,
  checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  const checkedValue = checked?.coverLetter?.trim() || (checked?.payload ? payloadCoverLetter(checked.payload) : '')
  return splitBatchCoverLetter(checkedValue).body
    || (savedBatchItem ? payloadCoverLetter(savedBatchItem.payload) : '')
    || splitBatchCoverLetter(item.outreach?.cover_letter).body
}

function applicationOutreachDraft(item: ApplicationResult): OutreachDraft {
  return {
    greeting: item.outreach?.greeting || '',
    email_subject: item.emailSubjectPreview?.trim()
      || item.outreach?.email_subject?.trim()
      || splitBatchCoverLetter(item.outreach?.cover_letter).subject
      || '',
    email_body: item.outreach?.email_body || '',
    cover_letter: splitBatchCoverLetter(item.outreach?.cover_letter).body,
  }
}

function defaultApplicationContext(item: ApplicationResult): ApplicationContext {
  return {
    channel: 'email',
    contactStage: ['applied', 'messaged', 'email_sent', 'sent'].includes(item.delivery?.action || '') ? 'follow_up' : 'first_contact',
    tone: 'natural',
    resumeAttached: false,
    coverLetterAttached: false,
    recipientType: 'recruiter',
  }
}

function applicationEmailSubject(
  item: ApplicationResult,
  checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  return checked?.preview?.subject?.trim()
    || item.emailSubjectPreview?.trim()
    || (typeof savedBatchItem?.payload.subject === 'string' ? savedBatchItem.payload.subject.trim() : '')
    || item.outreach?.email_subject?.trim()
    || splitBatchCoverLetter(item.outreach?.cover_letter).subject
    || ''
}

function applicationEmailSubjectSourceLabel(item: ApplicationResult) {
  switch (item.emailSubjectRequirement?.source) {
    case 'attachment_requirement':
      return '无独立邮件主题，已采用附件命名要求'
    case 'shared_subject_attachment_requirement':
      return '已采用邮件主题与附件共用要求'
    case 'email_subject_requirement':
      return '已采用正文中的邮件标题要求'
    default:
      return item.emailSubjectRequirement?.detected ? '已采用岗位中的邮件标题要求' : '发送标题已就绪'
  }
}

function applicationEmailSubjectRuleLabel(item: ApplicationResult) {
  if (item.emailSubjectRequirement?.source === 'attachment_requirement') return '附件命名要求兜底'
  if (item.emailSubjectRequirement?.source === 'shared_subject_attachment_requirement') return '邮件主题与附件共用要求'
  return '正文邮件标题要求'
}

function applicationEmailSubjectRuleHint(item: ApplicationResult) {
  if (item.emailSubjectRequirement?.source === 'attachment_requirement') {
    return item.emailSubjectRequirement.attachmentTemplate
      ? `来源附件模板：${item.emailSubjectRequirement.attachmentTemplate}；发送时去掉文件扩展名并校验`
      : '发送时按附件命名要求生成主题并校验'
  }
  return '发送时自动按此规则校验'
}

function applicationEmailBody(
  item: ApplicationResult,
  checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  return checked?.preview?.text?.trim()
    || checked?.payload?.body?.trim()
    || savedBatchItem?.payload.body?.trim()
    || item.outreach?.email_body?.trim()
    || ''
}

function applicationFactPoints(
  item: ApplicationResult,
  field: 'responsibilities' | 'requirements',
): string[] {
  const values = item.application_info?.[field]
  if (!Array.isArray(values)) return []
  return values
    .map((value: ProvenanceText | string) => typeof value === 'string' ? value : value?.text)
    .map((value) => String(value || '').trim())
    .filter(Boolean)
}

function applicationAttachmentPlannedName(attachment: ApplicationBatchPreflight['items'][number]['attachments'][number]) {
  return attachment.plannedDisplayName?.trim()
    || attachment.appliedDisplayName?.trim()
    || attachment.finalDisplayName?.trim()
    || attachment.currentDisplayName?.trim()
    || attachment.originalName
}

function matchesWorkbenchFilters(
  item: ApplicationResult,
  filters: BatchWorkbenchFilters,
  checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  const summary = item.deliveryManifestSummary
  if (summary) {
    const viewMatches = filters.view === 'all'
      || filters.view === 'ready' && summary.readiness === 'ready_to_preview'
      || filters.view === 'needs_review' && summary.readiness === 'needs_input'
      || filters.view === 'sent' && summary.deliveryStatus === 'sent'
    const recipientMatches = filters.recipient === 'all'
      || filters.recipient === 'resolved' && ['resolved', 'manual_confirmed'].includes(summary.recipientStatus)
      || filters.recipient === 'needs_review' && ['multiple_candidates', 'needs_review'].includes(summary.recipientStatus)
      || filters.recipient === 'missing' && summary.recipientStatus === 'missing'
    const copyMatches = filters.copy === 'all'
      || filters.copy === 'ready' && summary.copyStatus === 'passed'
      || filters.copy === 'missing_body' && summary.copyStatus === 'missing_email_body'
      || filters.copy === 'missing_cover_letter' && summary.copyStatus === 'missing_cover_letter'
      || filters.copy === 'quality_failed' && summary.copyStatus === 'quality_failed'
    const subjectMatches = filters.subject === 'all'
      || filters.subject === 'ready' && ['batch_default', 'job_requirement_satisfied'].includes(summary.subjectRuleStatus)
      || filters.subject === 'needs_review' && summary.subjectRuleStatus === 'needs_input'
      || filters.subject === 'required' && summary.subjectRuleStatus === 'job_requirement_satisfied'
    const attachmentMatches = filters.attachment === 'all'
      || filters.attachment === 'unchanged' && summary.attachmentStatus === 'unchanged'
      || ['will_rename', 'required'].includes(filters.attachment) && summary.attachmentStatus === 'planned_rename'
      || filters.attachment === 'blocked' && summary.attachmentStatus === 'blocked'
    return viewMatches && recipientMatches && copyMatches && subjectMatches && attachmentMatches
  }

  const status = checked?.status || savedBatchItem?.status
  const hasEmail = Boolean(checked?.contact?.address || savedBatchItem?.payload.recipient || firstApplicationContact(item)?.address || item.contactDiscovery?.candidates?.[0]?.address)
  const viewMatches = filters.view === 'all'
    || filters.view === 'ready' && (status ? status === 'ready' : likelyReady(item))
    || filters.view === 'needs_review' && (
      status === 'blocked_ambiguous'
      || status === 'unknown_manual_review'
      || checked?.contactResolution?.requiresReview === true
      || item.contactDiscovery?.requiresReview === true
      || item.emailSubjectGuard?.requiresReview === true
    )
    || filters.view === 'sent' && (status === 'sent' || item.delivery?.action === 'email_sent')
  const recipientMatches = filters.recipient === 'all'
    || filters.recipient === 'resolved' && hasEmail && checked?.contactResolution?.requiresReview !== true && item.contactDiscovery?.requiresReview !== true
    || filters.recipient === 'needs_review' && (status === 'blocked_ambiguous' || checked?.contactResolution?.requiresReview === true || item.contactDiscovery?.requiresReview === true)
    || filters.recipient === 'missing' && (status === 'blocked_no_email' || !hasEmail)
  const coverLetter = applicationCoverLetter(item, checked, savedBatchItem)
  const emailBody = applicationEmailBody(item, checked, savedBatchItem)
  const copyMatches = filters.copy === 'all'
    || filters.copy === 'ready' && Boolean(emailBody && coverLetter) && item.outreach?.content_quality?.batch_ready !== false
    || filters.copy === 'missing_body' && !emailBody
    || filters.copy === 'missing_cover_letter' && Boolean(emailBody) && !coverLetter
    || filters.copy === 'quality_failed' && (status === 'copy_quality_failed' || item.outreach?.content_quality?.batch_ready === false)
  const subjectNeedsReview = status === 'subject_pending' || item.emailSubjectGuard?.requiresReview === true || !item.outreach?.email_subject?.trim()
  const subjectMatches = filters.subject === 'all'
    || filters.subject === 'ready' && !subjectNeedsReview
    || filters.subject === 'needs_review' && subjectNeedsReview
    || filters.subject === 'required' && item.emailSubjectRequirement?.detected === true
  const willRename = status === 'filename_pending'
      || checked?.attachments?.some((attachment) => attachment.willRename ?? attachment.renameRequired ?? applicationAttachmentPlannedName(attachment) !== attachment.currentDisplayName) === true
      || item.attachmentRequirement?.detected === true
  const attachmentMatches = filters.attachment === 'all'
    || filters.attachment === 'unchanged' && !willRename
    || filters.attachment === 'will_rename' && willRename
    || filters.attachment === 'required' && item.attachmentRequirement?.detected === true
    || filters.attachment === 'blocked' && status === 'filename_pending' && checked?.canPrepare === false
  return viewMatches && recipientMatches && copyMatches && subjectMatches && attachmentMatches
}

function matchesSavedBatchFilters(item: ApplicationBatch['items'][number], filters: BatchWorkbenchFilters) {
  const viewMatches = filters.view === 'all'
    || filters.view === 'ready' && item.status === 'ready'
    || filters.view === 'needs_review' && ['blocked_ambiguous', 'unknown_manual_review', 'blocked_no_email', 'subject_pending', 'draft_pending', 'quality_pending', 'filename_pending', 'copy_quality_failed'].includes(item.status)
    || filters.view === 'sent' && item.status === 'sent'
  const hasRecipient = Boolean(String(item.payload.recipient || '').trim())
  const recipientMatches = filters.recipient === 'all'
    || filters.recipient === 'resolved' && hasRecipient && item.status !== 'blocked_ambiguous'
    || filters.recipient === 'needs_review' && item.status === 'blocked_ambiguous'
    || filters.recipient === 'missing' && (!hasRecipient || item.status === 'blocked_no_email')
  const hasBody = Boolean(String(item.payload.body || '').trim())
  const hasCoverLetter = Boolean(payloadCoverLetter(item.payload))
  const copyMatches = filters.copy === 'all'
    || filters.copy === 'ready' && hasBody && hasCoverLetter && item.status !== 'copy_quality_failed'
    || filters.copy === 'missing_body' && !hasBody
    || filters.copy === 'missing_cover_letter' && hasBody && !hasCoverLetter
    || filters.copy === 'quality_failed' && item.status === 'copy_quality_failed'
  const hasSubject = Boolean(String(item.payload.subject || '').trim())
  const subjectMatches = filters.subject === 'all'
    || filters.subject === 'ready' && hasSubject && item.status !== 'subject_pending'
    || filters.subject === 'needs_review' && (!hasSubject || item.status === 'subject_pending')
    || filters.subject === 'required' && item.status === 'subject_pending'
  const planned = Array.isArray(item.payload.plannedFinalFilenames) ? item.payload.plannedFinalFilenames : []
  const willRename = item.status === 'filename_pending' || planned.length > 0
  const attachmentMatches = filters.attachment === 'all'
    || filters.attachment === 'unchanged' && !willRename
    || ['will_rename', 'required'].includes(filters.attachment) && willRename
    || filters.attachment === 'blocked' && item.status === 'filename_pending'
  return viewMatches && recipientMatches && copyMatches && subjectMatches && attachmentMatches
}

function likelyReady(item: ApplicationResult) {
  return item.draftVersion?.qualityStatus === 'passed'
    && item.outreach?.content_quality?.batch_ready !== false
    && Boolean(item.outreach?.email_subject?.trim())
    && Boolean(item.outreach?.email_body?.trim())
    && Boolean(firstApplicationContact(item)?.address)
    && item.delivery?.action !== 'email_sent'
}

function buildDeliveryCandidateQuery(query: string, filters: BatchWorkbenchFilters): ApplicationDeliveryCandidatesQuery {
  const result: ApplicationDeliveryCandidatesQuery = {
    ...(query ? { q: query } : {}),
    sort: 'newest',
  }
  if (filters.view === 'ready') result.readiness = 'ready_to_preview'
  if (filters.view === 'needs_review') result.readiness = 'needs_input'
  if (filters.view === 'sent') result.deliveryStatus = 'sent'
  if (filters.recipient === 'resolved') result.recipientStatus = 'resolved,manual_confirmed'
  if (filters.recipient === 'needs_review') result.recipientStatus = 'multiple_candidates,needs_review'
  if (filters.recipient === 'missing') result.recipientStatus = 'missing'
  if (filters.copy === 'ready') result.copyStatus = 'passed'
  if (filters.copy === 'missing_body') result.copyStatus = 'missing_email_body'
  if (filters.copy === 'missing_cover_letter') result.copyStatus = 'missing_cover_letter'
  if (filters.copy === 'quality_failed') result.copyStatus = 'quality_failed'
  if (filters.subject === 'ready') result.subjectRuleStatus = 'batch_default,job_requirement_satisfied'
  if (filters.subject === 'needs_review') result.subjectRuleStatus = 'needs_input'
  if (filters.subject === 'required') result.subjectRuleStatus = 'job_requirement_satisfied'
  if (filters.attachment === 'unchanged') result.attachmentStatus = 'unchanged'
  if (filters.attachment === 'will_rename' || filters.attachment === 'required') result.attachmentStatus = 'planned_rename'
  if (filters.attachment === 'blocked') result.attachmentStatus = 'blocked'
  return result
}

function isDefaultWorkbenchFilters(filters: BatchWorkbenchFilters) {
  return Object.entries(DEFAULT_WORKBENCH_FILTERS).every(([key, value]) => filters[key as keyof BatchWorkbenchFilters] === value)
}

function isCandidateReady(
  item: ApplicationResult,
  checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  if (checked) return checked.status === 'ready'
  if (item.deliveryManifestSummary) {
    return item.deliveryManifestSummary.readiness === 'ready_to_preview'
      && !['sent', 'skipped', 'sending', 'frozen'].includes(item.deliveryManifestSummary.deliveryStatus)
  }
  if (savedBatchItem) return savedBatchItem.status === 'ready'
  return likelyReady(item)
}

function isCandidateSelectable(
  item: ApplicationResult,
  _checked: ApplicationBatchPreflight['items'][number] | undefined,
  savedBatchItem: ApplicationBatch['items'][number] | undefined,
) {
  const summary = item.deliveryManifestSummary
  if (summary) return summary.readiness !== 'completed' && !['sent', 'skipped', 'sending', 'frozen'].includes(summary.deliveryStatus)
  return !savedBatchItem || !['sent', 'skipped', 'sending'].includes(savedBatchItem.status)
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function clampSelectionLimit(value: string | number) {
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(Number(value) || 1)))
}

function isBatchSelectionPreset(value: number) {
  return BATCH_SELECTION_PRESETS.some((preset) => preset === value)
}

function clampCandidatePageSize(value: string | number) {
  const parsed = Math.floor(Number(value))
  return CANDIDATE_PAGE_SIZE_OPTIONS.some((option) => option === parsed)
    ? parsed
    : DEFAULT_CANDIDATE_PAGE_SIZE
}

function loadWorkbenchPreferences(jobId: string): BatchWorkbenchPreferences {
  const fallback: BatchWorkbenchPreferences = {
    query: '',
    filters: { ...DEFAULT_WORKBENCH_FILTERS },
    selectionLimit: DEFAULT_SELECTION_LIMIT,
    pageSize: DEFAULT_CANDIDATE_PAGE_SIZE,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${WORKBENCH_PREFERENCES_PREFIX}${jobId}`) || '{}') as Partial<BatchWorkbenchPreferences>
    const raw = parsed.filters || DEFAULT_WORKBENCH_FILTERS
    const allowed = <T extends string>(value: unknown, options: Array<{ value: T }>, defaultValue: T) => (
      options.some((option) => option.value === value) ? value as T : defaultValue
    )
    return {
      query: typeof parsed.query === 'string' ? parsed.query.slice(0, 200) : '',
      filters: {
        view: allowed(raw.view, BATCH_VIEW_OPTIONS, 'all'),
        recipient: allowed(raw.recipient, RECIPIENT_FILTER_OPTIONS, 'all'),
        copy: allowed(raw.copy, COPY_FILTER_OPTIONS, 'all'),
        subject: allowed(raw.subject, SUBJECT_FILTER_OPTIONS, 'all'),
        attachment: allowed(raw.attachment, ATTACHMENT_FILTER_OPTIONS, 'all'),
      },
      selectionLimit: clampSelectionLimit(parsed.selectionLimit ?? DEFAULT_SELECTION_LIMIT),
      pageSize: clampCandidatePageSize(parsed.pageSize ?? DEFAULT_CANDIDATE_PAGE_SIZE),
    }
  } catch {
    return fallback
  }
}

function saveWorkbenchPreferences(jobId: string, preferences: BatchWorkbenchPreferences) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${WORKBENCH_PREFERENCES_PREFIX}${jobId}`, JSON.stringify(preferences))
  } catch {
    // A blocked storage backend should not prevent batch delivery.
  }
}

function sumFacetCounts(values: Record<string, number> | undefined) {
  return Object.values(values || {}).reduce((total, value) => total + (Number(value) || 0), 0)
}

function copyTextFallback(value: string) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
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
    payloadCoverLetter(payload),
    ...(Array.isArray(payload.plannedFinalFilenames) ? payload.plannedFinalFilenames : []),
    ...filenames,
  ].map((value) => String(value || '')).join(' ').toLocaleLowerCase()
}

function preflightItemSearchText(item: ApplicationBatchPreflight['items'][number] | undefined) {
  if (!item) return ''
  return [
    item.title,
    item.roleName,
    item.contact?.address,
    item.preview?.subject,
    item.preview?.text,
    item.coverLetter,
    item.payload ? payloadCoverLetter(item.payload) : '',
    ...(item.attachments || []).flatMap((attachment) => [
      attachment.originalName,
      attachment.currentDisplayName,
      applicationAttachmentPlannedName(attachment),
    ]),
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
    item.outreach?.cover_letter,
    item.emailSubjectRequirement?.template,
    item.attachmentRequirement?.template,
    ...routes.flatMap((route) => [route.value, route.evidence]),
  ].map((value) => String(value || '')).join(' ')
}

type ApplicationContactDisplay = Pick<ApplicationContactCandidate, 'address' | 'source' | 'evidenceText' | 'verificationStatus' | 'normalizationApplied' | 'sourceFields'> & {
  sourceImageIndex?: number
}

function candidateContactDisplay(candidate: ApplicationContactCandidate): ApplicationContactDisplay {
  return {
    address: candidate.address,
    source: candidate.source,
    evidenceText: candidate.evidenceText,
    verificationStatus: candidate.verificationStatus,
    normalizationApplied: candidate.normalizationApplied,
    sourceFields: candidate.sourceFields,
  }
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

function candidatePageCacheKey(filterSignature: string, offset: number, cursor?: string) {
  return JSON.stringify([filterSignature, offset, cursor || null])
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
    subject_pending: '标题待处理',
    draft_pending: '文案待处理',
    quality_pending: '质量待处理',
    filename_pending: '计划名待应用',
    copy_quality_failed: '文案门禁未通过',
    ready: '就绪',
    sending: '发送中',
    sent: 'SMTP 已接收',
    failed_retryable: '可重试失败',
    unknown_manual_review: '发送状态待核对',
    skipped: '已跳过',
  })[status]
}

function createRequestIdempotencyKey(
  noteIds: string[],
  approvals: Record<string, string>,
  template: string,
  minIntervalSeconds: number,
  aiSessionId?: string | null,
  preflightId?: string,
  manifestHash?: string,
  selectionSnapshotId?: string,
  selectionSnapshotHash?: string,
) {
  const identity = JSON.stringify({
    noteIds,
    approvals: Object.entries(approvals).sort(([left], [right]) => left.localeCompare(right)),
    template: template.normalize('NFC').trim(),
    minIntervalMs: Math.max(0, Math.min(60, minIntervalSeconds)) * 1_000,
    aiSessionId: aiSessionId || '',
    preflightId: preflightId || '',
    manifestHash: manifestHash || '',
    selectionSnapshotId: selectionSnapshotId || '',
    selectionSnapshotHash: selectionSnapshotHash || '',
  })
  const safe = `batch:${preflightId || 'pending'}:${manifestHash || 'pending'}:${compactIdentityHash(identity)}`
    .replace(/[^\p{L}\p{N}_.:-]+/gu, '_')
  return safe.slice(0, 160).padEnd(8, '_')
}

function compactIdentityHash(value: string) {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + index), 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
