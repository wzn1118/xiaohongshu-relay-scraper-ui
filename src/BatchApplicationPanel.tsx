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
  ApplicationDeliveryCandidatesQuery,
  ApplicationDeliverySelectionSnapshot,
  ApplicationResult,
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

const MAX_BATCH_SIZE = 10
const CANDIDATE_PAGE_SIZE = 20
const DEFAULT_ATTACHMENT_TEMPLATE = '{candidateName}-{jobTitle}-简历'
const WORKBENCH_PREFERENCES_PREFIX = 'batch-application-workbench:v2:'

export function BatchApplicationPanel({ jobId, items, aiSessionId, standalone = false, onOpenItem }: BatchApplicationPanelProps) {
  const [expanded, setExpanded] = useState(standalone)
  const [query, setQuery] = useState(() => loadWorkbenchPreferences(jobId).query)
  const [workbenchFilters, setWorkbenchFilters] = useState<BatchWorkbenchFilters>(() => loadWorkbenchPreferences(jobId).filters)
  const [selectionLimit, setSelectionLimit] = useState(() => loadWorkbenchPreferences(jobId).selectionLimit)
  const [preferencesJobId, setPreferencesJobId] = useState(jobId)
  const [expandedCoverLetters, setExpandedCoverLetters] = useState<Set<string>>(new Set())
  const [copiedDeliveryNoteId, setCopiedDeliveryNoteId] = useState('')
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
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const candidateFilterQuery = useMemo(
    () => buildDeliveryCandidateQuery(candidateQuery, workbenchFilters),
    [candidateQuery, workbenchFilters],
  )
  const candidateFilterSignature = useMemo(() => JSON.stringify(candidateFilterQuery), [candidateFilterQuery])
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
    setPreferencesJobId(jobId)
    setExpandedCoverLetters(new Set())
    setCopiedDeliveryNoteId('')
    setCandidateQuery('')
    setCandidateOffset(0)
    setCandidatePageRequest({ filterSignature: '', offset: 0, cursor: undefined })
    setCandidateCorpus(null)
    setCandidateError('')
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
    saveWorkbenchPreferences(jobId, { query, filters: workbenchFilters, selectionLimit })
  }, [jobId, preferencesJobId, query, selectionLimit, workbenchFilters])

  useEffect(() => {
    if (!items.length || selectionSeedJob.current === jobId) return
    const readyItems = items.filter(likelyReady)
    const defaults = readyItems.slice(0, MAX_BATCH_SIZE).map((item) => item.note_id)
    setSelected(new Set(defaults))
    if (readyItems.length > MAX_BATCH_SIZE) {
      setNotice({ tone: 'info', text: `发现 ${readyItems.length} 个可投递岗位，当前批次上限为 ${MAX_BATCH_SIZE}，已明确选择前 ${MAX_BATCH_SIZE} 个。` })
    }
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
          limit: CANDIDATE_PAGE_SIZE,
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
        }
        candidatePageCache.current.set(cacheKey, page)
        setCandidateOffset(payload.offset)
        setCandidateCorpus(page)
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
  }, [candidateFilterQuery, candidateFilterSignature, candidatePageRequest, expanded, jobId])

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
  const currentBatchReady = batch?.status === 'ready'
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

  async function createBatch() {
    if (!canCreate) return
    setBusy('create')
    setNotice(null)
    try {
      const result = await api.createApplicationBatch(jobId, buildRequest(selectedIds, approvals, preflight))
      setPreflight(result.preflight)
      setBatch(result.batch)
      setBatchJobId(jobId)
      setBatches((current) => replaceBatch(current, result.batch))
      setNotice({ tone: 'success', text: `批次已冻结，${result.batch.counts.ready || 0} 封邮件等待审批。` })
    } catch (error) {
      const apiError = error as ApiError
      if (['APPLICATION_BATCH_PREFLIGHT_STALE', 'APPLICATION_BATCH_PREFLIGHT_EXPIRED'].includes(apiError.code || '')) {
        setPreflight(null)
        setPreflightSelectionConfirmed(false)
        setNotice({ tone: 'error', text: '投递预演已过期或岗位数据发生变化，请重新运行投递预演后再冻结批次。' })
        return
      }
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

  function invalidateSelectionPreflight() {
    dryRunRequest.current += 1
    setPreflightSelectionConfirmed(false)
    setBusy((current) => current === 'dry-run' ? '' : current)
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
    const offset = Math.max(0, candidateOffset - CANDIDATE_PAGE_SIZE)
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
        <span><Paperclip size={14} /><strong>附件准备</strong><small>投递预演显示原文件名和计划发送名，不会修改源附件；冻结后锁定实际发送名。</small></span>
        <span><Gauge size={14} /><strong>投递预演</strong><small>先生成不发送的投递预演，逐条确认收件人、标题、Cover Letter 和附件名。</small></span>
        <span><ShieldCheck size={14} /><strong>批量投递</strong><small>审批后按间隔逐封发送；超时会进入人工核对，不会自动重复发送。</small></span>
      </div>}

      {expanded && <div className="batch-application-body">
        <div className="batch-toolbar">
          <label className="batch-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索岗位、邮箱、主题或附件名" title="同时搜索邮件正文和 Cover Letter" /><span className="batch-search-summary" aria-live="polite"><b>待投岗位 {candidateSourceTotal} 项</b><b>筛选结果 {candidateTotal} 项</b>{batch && <b>当前批次 {visibleBatchItems.length} 封</b>}</span></label>
          <div className="batch-selection-actions">
            <span className="batch-selection-summary">已选 <strong>{selected.size}</strong> / {MAX_BATCH_SIZE}<small>{candidateLoading ? '选择校验中' : `筛选外 ${selectedOutsideFilterIds.length} · 无效 ${selectedInvalidIds.length}${selectedMissingRevisionIds.length ? ` · 修订缺失 ${selectedMissingRevisionIds.length}，请重新加载` : ''}`}</small></span>
            <button type="button" onClick={selectCurrentPage} disabled={candidateLoading || rows.length === 0}><CheckCircle2 size={15} />选择当前页</button>
            <label className="batch-selection-limit"><span>首批数量</span><input aria-label="首批选择数量" type="number" min={1} max={MAX_BATCH_SIZE} step={1} value={selectionLimit} onChange={(event) => setSelectionLimit(clampSelectionLimit(event.target.value))} /></label>
            <button type="button" onClick={selectFirstReady} disabled={candidateLoading || candidateTotal === 0}><CheckCircle2 size={15} />选择前 {selectionLimit} 条可投递</button>
            <button type="button" onClick={keepOnlyReady} disabled={candidateLoading || selected.size === 0}>仅保留可投递</button>
            <button type="button" onClick={cleanupSelection} disabled={candidateLoading || selectedOutsideFilterIds.length + selectedInvalidIds.length === 0}>清理选择</button>
            <button type="button" onClick={clearSelection} disabled={selected.size === 0}><XCircle size={15} />清空</button>
          </div>
          <details className="batch-settings">
            <summary><SlidersHorizontal size={15} />批次设置</summary>
            <div>
              <label><span>默认附件格式</span><input value={attachmentTemplate} onChange={(event) => updateAttachmentTemplate(event.target.value)} /></label>
              <label><span>发送间隔（秒）</span><input type="number" min={0} max={60} step={1} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value) || 0)} /></label>
            </div>
          </details>
        </div>

        <div className="batch-filter-strip" aria-label="投递筛选">
          <span className="batch-filter-heading"><SlidersHorizontal size={14} />筛选</span>
          <div className="batch-filter-options" role="group" aria-label="投递状态筛选">
            {BATCH_VIEW_OPTIONS.map((option) => <button
              key={option.value}
              type="button"
              className={workbenchFilters.view === option.value ? 'active' : ''}
              aria-pressed={workbenchFilters.view === option.value}
              onClick={() => { setWorkbenchFilters((current) => ({ ...current, view: option.value })); setCandidateOffset(0) }}
            >{option.label}</button>)}
          </div>
          <div className="batch-filter-selects">
            <select aria-label="收件人筛选" value={workbenchFilters.recipient} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, recipient: event.target.value as BatchRecipientFilter })); setCandidateOffset(0) }}>{RECIPIENT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <select aria-label="文案筛选" value={workbenchFilters.copy} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, copy: event.target.value as BatchCopyFilter })); setCandidateOffset(0) }}>{COPY_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <select aria-label="标题筛选" value={workbenchFilters.subject} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, subject: event.target.value as BatchSubjectFilter })); setCandidateOffset(0) }}>{SUBJECT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <select aria-label="附件筛选" value={workbenchFilters.attachment} onChange={(event) => { setWorkbenchFilters((current) => ({ ...current, attachment: event.target.value as BatchAttachmentFilter })); setCandidateOffset(0) }}>{ATTACHMENT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </div>
          {(!isDefaultWorkbenchFilters(workbenchFilters) || normalizedQuery) && <button type="button" className="batch-clear-filters" onClick={() => { setWorkbenchFilters(DEFAULT_WORKBENCH_FILTERS); setQuery(''); setCandidateOffset(0) }}>清除筛选</button>}
        </div>

        {notice && <div className={`batch-notice ${notice.tone}`}>{notice.tone === 'error' ? <AlertTriangle size={16} /> : notice.tone === 'success' ? <CheckCircle2 size={16} /> : <Gauge size={16} />}<span>{notice.text}</span></div>}
        {candidateError && <div className="batch-notice error"><AlertTriangle size={16} /><span>{candidateError}</span></div>}

        <div className="batch-table-wrap">
          <table className="batch-application-table">
            <thead><tr><th aria-label="选择" /><th>岗位</th><th>收件邮箱</th><th>文案质量</th><th>投递正文</th><th>邮件标题与附件命名</th><th>状态 / 修复</th></tr></thead>
            <tbody>{rows.map((item) => {
              const checked = preflightById.get(item.note_id)
              const savedBatchItem = batchItemByNoteId.get(item.note_id)
              const savedRecipient = typeof savedBatchItem?.payload.recipient === 'string' ? savedBatchItem.payload.recipient : ''
              const savedSubject = applicationEmailSubject(item, checked, savedBatchItem)
              const savedFilenames = Array.isArray(savedBatchItem?.payload.finalFilenames) ? savedBatchItem.payload.finalFilenames.map(String) : []
              const emailBody = applicationEmailBody(item, checked, savedBatchItem)
              const coverLetter = applicationCoverLetter(item, checked, savedBatchItem)
              const coverLetterExpanded = expandedCoverLetters.has(item.note_id)
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
              const subjectGuard = item.emailSubjectGuard
              const subjectNeedsReview = subjectGuard?.requiresReview === true
                || ['rejected_noisy_title', 'rejected_bare_title', 'rejected_unverified_subject']
                  .includes(String(subjectGuard?.sourceStatus || ''))
              const qualityPassed = item.draftVersion?.qualityStatus === 'passed' && !copyQualityBlocked
              const aiMechanismPending = copyQuality?.ai_product_role === true && copyQuality.ai_product_mechanism_pass === false
              const candidates = liveResolution?.candidates || []
              const collectionIncomplete = liveResolution && liveResolution.collectionStatus !== 'complete'
              return <tr key={item.note_id} className={`${selected.has(item.note_id) ? 'selected' : ''} ${status ? `status-${status}` : ''}`}>
                <td data-label="选择"><label className="batch-checkbox"><input type="checkbox" checked={selected.has(item.note_id)} onChange={(event) => toggle(item.note_id, event.target.checked)} /><span><Check size={13} /></span></label></td>
                <td data-label="岗位"><strong>{item.job_card?.role_name || item.title || '未命名岗位'}</strong><small>{item.title}</small><small className={`batch-body-status ${item.body?.trim() ? 'ready' : 'pending'}`}>{item.body?.trim() ? `正文已保存 · ${item.body.trim().length} 字` : '正文待续采'}</small>{item.body?.trim() && <button type="button" className="batch-body-open" onClick={() => onOpenItem(item)}><FileText size={12} />查看正文</button>}</td>
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
                  <div className="batch-delivery-copy-heading"><small className="batch-field-label">邮件正文</small><button type="button" className="batch-copy-content" title="复制邮件正文与 Cover Letter" disabled={!emailBody && !coverLetter} onClick={() => void copyDeliveryContent(item.note_id, emailBody, coverLetter)}><Copy size={12} />{copiedDeliveryNoteId === item.note_id ? '已复制' : '复制正文'}</button></div>
                  {emailBody ? <div className={`batch-cover-letter-text batch-email-body-text ${coverLetterExpanded ? 'expanded' : ''}`} data-testid={`batch-email-body-${item.note_id}`}>{emailBody}</div> : <span className="batch-cover-letter-empty">邮件正文待生成</span>}
                  <small className="batch-field-label batch-cover-letter-label">Cover Letter</small>
                  {coverLetter ? <div className={`batch-cover-letter-text ${coverLetterExpanded ? 'expanded' : ''}`} data-testid={`batch-cover-letter-${item.note_id}`}>{coverLetter}</div> : <span className="batch-cover-letter-empty">Cover Letter 待生成</span>}
                  <span className="batch-cover-letter-meta">{emailBody.length} / {coverLetter.length} 字 · {contentVersion ? `v${contentVersion}` : '版本待生成'} · {contentHash ? `Hash ${contentHash.slice(0, 10)}...` : 'Hash 待生成'}</span>
                  {(emailBody || coverLetter) && <button type="button" className="batch-cover-letter-toggle" aria-expanded={coverLetterExpanded} onClick={() => toggleCoverLetter(item.note_id)}><FileText size={12} />{coverLetterExpanded ? '收起全文' : '展开全文'}</button>}
                </td>
                <td data-label="邮件标题与附件命名">
                  <small className="batch-field-label">实际发送标题</small>
                  <strong className={`batch-subject ${subjectNeedsReview ? 'needs-review' : ''}`}>{subjectNeedsReview ? subjectGuard?.suggestedSubject || '主题待重生成' : savedSubject || '主题待生成'}</strong>
                  {subjectNeedsReview && <small className="batch-blocker">原帖标题不是岗位名，主题待按准确岗位名重生成</small>}
                  {item.emailSubjectRequirement?.detected && <span className="batch-email-subject-rule" title={item.emailSubjectRequirement.evidence}><Mail size={12} /><span><small>正文邮件标题要求</small><b>{item.emailSubjectRequirement.template}</b><em>发送时自动按此规则校验</em></span></span>}
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
                  <span className={`item-status ${status || 'resolving'}`}>{status ? itemStatusLabel(status) : '待 Dry Run'}</span>
                  {copyQuality?.attachment_claim_without_context && <small className="batch-blocker">附件声明缺少上下文</small>}
                  {copyQualityBlocked && <small className="batch-blocker">文案质量门禁未通过，请重新生成</small>}
                  {subjectNeedsReview && <small className="batch-blocker">邮件主题需要岗位名复核</small>}
                  {checked?.blockers?.map((blocker) => <small className="batch-blocker" key={blocker.code}>{blocker.message}</small>)}
                  {checked?.canPrepare && checked.status !== 'ready' && <button type="button" className="batch-row-action" onClick={() => toggle(item.note_id, true)}>纳入自动准备</button>}
                  {checked && !checked.canPrepare && checked.status !== 'ready' && candidates.length === 0 && <button type="button" className="batch-row-action" onClick={() => onOpenItem(item)}>打开岗位</button>}
                  {candidates.length > 0 && <div className="contact-review-list">{candidates.map((candidate) => <button type="button" className={approvals[item.note_id] === candidate.evidenceHash ? 'confirmed' : ''} key={candidate.evidenceHash} onClick={() => void confirmContact(item.note_id, candidate)} title={candidate.evidenceText}><span>{candidate.address}</span><small>{contactSourceLabel(candidate.source, candidate.verificationStatus, candidate.normalizationApplied)} · {candidate.evidenceText}</small>{approvals[item.note_id] === candidate.evidenceHash ? <Check size={13} /> : <ShieldCheck size={13} />}</button>)}</div>}
                </td>
              </tr>
            })}{rows.length === 0 && <tr className="batch-search-empty-row"><td colSpan={7} data-label="搜索">当前筛选没有匹配岗位{batch ? `；当前发送批次匹配 ${visibleBatchItems.length} 封` : ''}。</td></tr>}</tbody>
          </table>
        </div>

        <div className="batch-candidate-pagination" aria-busy={candidateLoading}>
          <span>{candidateLoading ? <><LoaderCircle className="spin" size={14} />正在读取当前页</> : candidateTotal > 0 && rows.length > 0 ? `${candidateOffset + 1}-${Math.min(candidateOffset + rows.length, candidateTotal)} / ${candidateTotal}` : `0 / ${candidateTotal}`}</span>
          <div>
            <button type="button" title="上一页待投岗位" disabled={candidateLoading || candidateOffset === 0} onClick={showPreviousCandidatePage}><ChevronLeft size={16} /></button>
            <button type="button" title="下一页待投岗位" disabled={candidateLoading || !candidateCorpus?.nextCursor} onClick={showNextCandidatePage}><ChevronRight size={16} /></button>
          </div>
        </div>

        <div className="batch-primary-actions">
          <button type="button" aria-label="Dry Run" title={selectedMissingRevisionIds.length ? '已选岗位修订缺失，请重新加载候选清单' : '只生成投递预演，不发送邮件'} disabled={!selected.size || selectedMissingRevisionIds.length > 0 || Boolean(busy) || candidateLoading} onClick={() => void runDryRun()}>{busy === 'dry-run' ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />}投递预演 <small>不发送</small></button>
          <button type="button" className="primary" title={selectedMatchesPreflight && preflightSelectionConfirmed ? '冻结当前投递预演' : '请先运行投递预演，并保持就绪清单与命名规则不变'} disabled={!canCreate} onClick={() => void createBatch()}>{busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />}冻结批次预览</button>
          {preflight && <span><strong>{preflightReadyCount}</strong> 项就绪{preflightPreparableCount > 0 && <> · <strong>{preflightPreparableCount}</strong> 项可自动准备</>} · <strong>{preflightBlockedCount}</strong> 项阻塞</span>}
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

function loadWorkbenchPreferences(jobId: string): BatchWorkbenchPreferences {
  const fallback: BatchWorkbenchPreferences = {
    query: '',
    filters: { ...DEFAULT_WORKBENCH_FILTERS },
    selectionLimit: MAX_BATCH_SIZE,
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
      selectionLimit: clampSelectionLimit(parsed.selectionLimit ?? MAX_BATCH_SIZE),
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
