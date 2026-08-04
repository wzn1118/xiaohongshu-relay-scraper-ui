import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquareText,
  Search,
  UserRound,
} from 'lucide-react'
import type {
  DataCopilotContextCatalog,
  DataCopilotContextMeta,
  DataCopilotContextRecord,
  DataCopilotContextSource,
  DataCopilotRecordKind,
  DataCopilotTaskCatalog,
  DataCopilotTaskRecord,
  DataCopilotTransport,
} from './DataCopilotContext'

type Props = {
  sources: DataCopilotContextSource[]
  selectedIds: string[]
  contextMeta?: DataCopilotContextMeta
  usedTools?: string[]
  className?: string
  disabled?: boolean
  activeTask: DataCopilotTaskRecord | null
  loadTasks?: DataCopilotTransport['listContextTasks']
  loadRecords?: DataCopilotTransport['listContextRecords']
  onSelectTask: (task: DataCopilotTaskRecord) => void
  onLeaveTask: () => void
  onToggle: (sourceId: string) => void
}

const PAGE_SIZE = 25

const categories: Array<{
  kind: DataCopilotRecordKind
  aggregateId: string
  title: string
  description: string
  icon: typeof FileText
}> = [
  { kind: 'posts', aggregateId: 'dataset:content', title: '原帖与正文', description: '逐条浏览采集内容、图片与 AI 分析', icon: FileText },
  { kind: 'comments', aggregateId: 'dataset:audience', title: '评论记录', description: '评论正文、回复线程与所属原帖', icon: MessageSquareText },
  { kind: 'users', aggregateId: 'dataset:audience', title: '用户记录', description: '评论用户、公开主页与关联活动', icon: UserRound },
  { kind: 'artifacts', aggregateId: 'dataset:artifacts', title: '任务产物', description: '报告、表格、正文和可发送附件', icon: FolderOpen },
]

export function DataCopilotContextBrowser({
  sources,
  selectedIds,
  contextMeta,
  usedTools = [],
  className,
  disabled = false,
  activeTask,
  loadTasks,
  loadRecords,
  onSelectTask,
  onLeaveTask,
  onToggle,
}: Props) {
  const [taskQuery, setTaskQuery] = useState('')
  const [taskOffset, setTaskOffset] = useState(0)
  const [taskCatalog, setTaskCatalog] = useState<DataCopilotTaskCatalog | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [activeKind, setActiveKind] = useState<DataCopilotRecordKind | null>(null)
  const [activeRecord, setActiveRecord] = useState<DataCopilotContextRecord | null>(null)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [summary, setSummary] = useState<DataCopilotContextCatalog | null>(null)
  const [catalog, setCatalog] = useState<DataCopilotContextCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const taskRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)
  const catalogRequestRef = useRef(0)
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  useEffect(() => {
    if (activeTask || !loadTasks) return
    const requestId = ++taskRequestRef.current
    setLoadingTasks(true)
    setError('')
    const timer = window.setTimeout(() => {
      void loadTasks({ query: taskQuery, offset: taskOffset, limit: PAGE_SIZE })
        .then((value) => {
          if (requestId !== taskRequestRef.current) return
          setTaskCatalog(value)
          setLoadingTasks(false)
        })
        .catch((reason: unknown) => {
          if (requestId !== taskRequestRef.current) return
          setError(errorText(reason))
          setLoadingTasks(false)
        })
    }, taskQuery ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [activeTask, loadTasks, taskOffset, taskQuery])

  useEffect(() => {
    setActiveKind(null)
    setActiveRecord(null)
    setSummary(null)
    setCatalog(null)
    setQuery('')
    setOffset(0)
    setError('')
  }, [activeTask?.id])

  useEffect(() => {
    if (!loadRecords || !activeTask) return
    const requestId = ++summaryRequestRef.current
    setError('')
    void loadRecords({ jobId: activeTask.id, mode: activeTask.mode }).then((value) => {
      if (requestId === summaryRequestRef.current) setSummary(value)
    }).catch((reason: unknown) => {
      if (requestId === summaryRequestRef.current) setError(errorText(reason))
    })
  }, [activeTask, loadRecords])

  useEffect(() => {
    if (!activeKind || !loadRecords || !activeTask) return
    const requestId = ++catalogRequestRef.current
    setLoading(true)
    setError('')
    const timer = window.setTimeout(() => {
      void loadRecords({
        jobId: activeTask.id,
        mode: activeTask.mode,
        kind: activeKind,
        query,
        offset,
        limit: PAGE_SIZE,
      })
        .then((value) => {
          if (requestId !== catalogRequestRef.current) return
          setCatalog(value)
          setLoading(false)
        })
        .catch((reason: unknown) => {
          if (requestId !== catalogRequestRef.current) return
          setError(errorText(reason))
          setLoading(false)
        })
    }, query ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [activeKind, activeTask, loadRecords, offset, query])

  const openCategory = (kind: DataCopilotRecordKind) => {
    setActiveKind(kind)
    setActiveRecord(null)
    setCatalog(null)
    setQuery('')
    setOffset(0)
  }

  const leaveCategory = () => {
    setActiveKind(null)
    setActiveRecord(null)
    setCatalog(null)
    setQuery('')
    setOffset(0)
  }

  const title = activeRecord?.title
    || categories.find((item) => item.kind === activeKind)?.title
    || activeTask?.title
    || '历史采集记录'
  const total = catalog?.total ?? 0
  const items = catalog?.items ?? []
  const goBack = () => {
    if (activeRecord) setActiveRecord(null)
    else if (activeKind) leaveCategory()
    else onLeaveTask()
  }

  return (
    <aside className={className} style={styles.root} aria-label="数据上下文">
      <header style={styles.header}>
        <div style={styles.headerTitleRow}>
          {activeTask ? (
            <button
              type="button"
              onClick={goBack}
              style={styles.backButton}
              title="返回"
              aria-label="返回上一级"
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          ) : null}
          <div style={styles.headerCopy}>
            <strong style={styles.heading}>{title}</strong>
            <span style={styles.meta}>
              {activeTask
                ? `${selectedIds.length} 项已启用 · ${activeTask.modeLabel}`
                : `${taskCatalog?.total ?? 0} 个历史任务 · 选择后关联对话`}
            </span>
          </div>
        </div>
      </header>

      {!activeTask ? (
        <TaskList
          catalog={taskCatalog}
          query={taskQuery}
          offset={taskOffset}
          loading={loadingTasks}
          error={error}
          onQuery={(value) => { setTaskQuery(value); setTaskOffset(0) }}
          onOffset={setTaskOffset}
          onSelect={onSelectTask}
        />
      ) : activeRecord ? (
        <RecordDetail
          jobId={activeTask.id}
          record={activeRecord}
          selectedSet={selectedSet}
          disabled={disabled}
          onToggle={onToggle}
        />
      ) : activeKind ? (
        <RecordList
          jobId={activeTask.id}
          kind={activeKind}
          items={items}
          query={query}
          offset={offset}
          total={total}
          loading={loading}
          error={error}
          selectedSet={selectedSet}
          disabled={disabled}
          onQuery={(value) => { setQuery(value); setOffset(0) }}
          onOffset={setOffset}
          onOpen={setActiveRecord}
          onToggle={onToggle}
        />
      ) : (
        <Overview
          sources={sources}
          summary={summary}
          contextMeta={contextMeta}
          usedTools={usedTools}
          error={error}
          selectedSet={selectedSet}
          disabled={disabled}
          onOpen={openCategory}
          onToggle={onToggle}
        />
      )}
    </aside>
  )
}

function TaskList({
  catalog,
  query,
  offset,
  loading,
  error,
  onQuery,
  onOffset,
  onSelect,
}: {
  catalog: DataCopilotTaskCatalog | null
  query: string
  offset: number
  loading: boolean
  error: string
  onQuery: (value: string) => void
  onOffset: (value: number) => void
  onSelect: (task: DataCopilotTaskRecord) => void
}) {
  const total = catalog?.total ?? 0
  const items = catalog?.items ?? []
  return (
    <div style={styles.listLayout}>
      <label style={styles.search}>
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索任务名称、状态或 Job ID"
          aria-label="搜索历史采集记录"
          style={styles.searchInput}
        />
      </label>
      <div style={styles.listMeta}>
        <span>共 {total.toLocaleString('zh-CN')} 个任务</span>
        <span>{total ? `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)}` : '0'}</span>
      </div>
      <div style={styles.recordList}>
        {loading ? <div style={styles.loading}><LoaderCircle size={18} aria-hidden="true" />正在读取历史记录</div> : null}
        {!loading && error ? <div style={styles.error}>{error}</div> : null}
        {!loading && !error && items.length === 0 ? <div style={styles.empty}>没有匹配的历史采集任务</div> : null}
        {!loading && !error ? items.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect(task)}
            aria-label={`进入任务${task.title}`}
            style={styles.taskButton}
          >
            <span style={{
              ...styles.taskButtonIcon,
              ...(task.mode === 'application' ? styles.taskButtonIconApplication : styles.taskButtonIconResearch),
            }}><FolderOpen size={17} aria-hidden="true" /></span>
            <span style={styles.taskButtonCopy}>
              <span style={styles.taskButtonTopline}>
                <strong style={styles.taskButtonTitle}>{task.title}</strong>
                <span style={styles.taskStatus}>{statusLabel(task.status)}</span>
              </span>
              <span style={styles.taskIdentity}><strong>{task.modeLabel}</strong><span>{task.id}</span></span>
              <span style={styles.taskCounts} aria-label="任务数据量">
                原帖 {task.counts.posts.toLocaleString('zh-CN')} · 评论 {task.counts.comments.toLocaleString('zh-CN')} · 用户 {task.counts.users.toLocaleString('zh-CN')} · 产物 {task.counts.artifacts.toLocaleString('zh-CN')}
              </span>
              <span style={styles.taskDate}>更新于 {formatDateTime(task.updatedAt)}</span>
            </span>
            <ChevronRight size={15} aria-hidden="true" style={styles.chevron} />
          </button>
        )) : null}
      </div>
      <div style={styles.pagination}>
        <button type="button" disabled={offset === 0 || loading} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))} style={styles.pageButton}><ChevronLeft size={14} aria-hidden="true" />上一页</button>
        <button type="button" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => onOffset(offset + PAGE_SIZE)} style={styles.pageButton}>下一页<ChevronRight size={14} aria-hidden="true" /></button>
      </div>
    </div>
  )
}

function Overview({
  sources,
  summary,
  contextMeta,
  usedTools,
  error,
  selectedSet,
  disabled,
  onOpen,
  onToggle,
}: {
  sources: DataCopilotContextSource[]
  summary: DataCopilotContextCatalog | null
  contextMeta?: DataCopilotContextMeta
  usedTools: string[]
  error: string
  selectedSet: Set<string>
  disabled: boolean
  onOpen: (kind: DataCopilotRecordKind) => void
  onToggle: (sourceId: string) => void
}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  return (
    <div style={styles.scrollBody}>
      <section style={styles.taskSummary} aria-label="当前任务上下文">
        <div style={styles.summaryRow}><span>当前任务</span><strong title={contextMeta?.taskId}>{contextMeta?.taskLabel || contextMeta?.taskId || '未绑定'}</strong></div>
        <div style={styles.summaryRow}><span>任务类型</span><strong>{contextMeta?.mode || '未指定'}</strong></div>
        <div style={styles.summaryRow}><span>数据快照</span><strong>{contextMeta?.snapshotId || '未指定'}</strong></div>
        <div style={styles.summaryBlock}><span>筛选条件</span><div>{contextMeta?.filters?.length ? contextMeta.filters.join(' · ') : '未设置额外筛选'}</div></div>
        <div style={styles.summaryBlock}><span>本会话已用工具</span><div>{usedTools.length ? usedTools.join(' · ') : '尚未调用工具'}</div></div>
      </section>

      <div style={styles.sectionHeading}>
        <strong>采集记录</strong>
        <span>选择一类进入逐条浏览</span>
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      <div style={styles.categoryList}>
        {categories.map((category) => {
          const Icon = category.icon
          const aggregate = sourceById.get(category.aggregateId)
          const selected = selectedSet.has(category.aggregateId)
          const count = summary?.counts?.[category.kind] ?? aggregate?.count ?? 0
          return (
            <div key={category.kind} style={{ ...styles.category, ...(selected ? styles.selected : undefined) }}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onToggle(category.aggregateId)}
                style={{ ...styles.check, ...(selected ? styles.checkSelected : undefined) }}
                title={selected ? '移除整类数据' : '选择整类数据'}
                aria-pressed={selected}
                aria-label={`${selected ? '移除' : '选择'}${category.title}全部记录`}
              >{selected ? <Check size={13} aria-hidden="true" /> : null}</button>
              <button type="button" onClick={() => onOpen(category.kind)} style={styles.categoryMain}>
                <span style={styles.categoryIcon}><Icon size={16} aria-hidden="true" /></span>
                <span style={styles.categoryCopy}>
                  <span style={styles.categoryTitle}>{category.title}</span>
                  <span style={styles.categoryDescription}>{category.description}</span>
                </span>
                <span style={styles.categoryCount}>{count.toLocaleString('zh-CN')}</span>
                <ChevronRight size={15} aria-hidden="true" style={styles.chevron} />
              </button>
            </div>
          )
        })}
      </div>
      <p style={styles.hint}>勾选整类会让助手读取全部记录；进入列表可只选择本轮真正需要的帖子、评论、用户或产物。</p>
    </div>
  )
}

function RecordList({
  jobId,
  items,
  query,
  offset,
  total,
  loading,
  error,
  selectedSet,
  disabled,
  onQuery,
  onOffset,
  onOpen,
  onToggle,
}: {
  jobId: string
  kind: DataCopilotRecordKind
  items: DataCopilotContextRecord[]
  query: string
  offset: number
  total: number
  loading: boolean
  error: string
  selectedSet: Set<string>
  disabled: boolean
  onQuery: (value: string) => void
  onOffset: (value: number) => void
  onOpen: (record: DataCopilotContextRecord) => void
  onToggle: (sourceId: string) => void
}) {
  return (
    <div style={styles.listLayout}>
      <label style={styles.search}>
        <Search size={15} aria-hidden="true" />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索当前记录" aria-label="搜索采集记录" style={styles.searchInput} />
      </label>
      <div style={styles.listMeta}><span>共 {total.toLocaleString('zh-CN')} 条</span><span>{offset + 1}-{Math.min(offset + PAGE_SIZE, total || items.length)}</span></div>
      <div style={styles.recordList}>
        {loading ? <div style={styles.loading}><LoaderCircle size={18} aria-hidden="true" />正在读取记录</div> : null}
        {!loading && error ? <div style={styles.error}>{error}</div> : null}
        {!loading && !error && items.length === 0 ? <div style={styles.empty}>当前分类没有匹配记录</div> : null}
        {!loading && !error ? items.map((record) => {
          const selected = selectedSet.has(record.sourceId)
          return (
            <div key={record.sourceId} style={{ ...styles.record, ...(selected ? styles.selected : undefined) }}>
              <button type="button" disabled={disabled} onClick={() => onToggle(record.sourceId)} style={{ ...styles.check, ...(selected ? styles.checkSelected : undefined) }} aria-pressed={selected} aria-label={`${selected ? '移除' : '选择'}${record.title}`}>
                {selected ? <Check size={13} aria-hidden="true" /> : null}
              </button>
              <button type="button" onClick={() => onOpen(record)} style={styles.recordMain}>
                <RecordThumbnail jobId={jobId} record={record} />
                <span style={styles.recordCopy}>
                  <strong style={styles.recordTitle}>{record.title}</strong>
                  {record.subtitle ? <span style={styles.recordSubtitle}>{record.subtitle}</span> : null}
                  <span style={styles.recordMeta}>{[record.status, formatDate(record.timestamp)].filter(Boolean).join(' · ') || record.recordId}</span>
                </span>
                <ChevronRight size={15} aria-hidden="true" style={styles.chevron} />
              </button>
            </div>
          )
        }) : null}
      </div>
      <div style={styles.pagination}>
        <button type="button" disabled={offset === 0 || loading} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))} style={styles.pageButton}><ChevronLeft size={14} aria-hidden="true" />上一页</button>
        <button type="button" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => onOffset(offset + PAGE_SIZE)} style={styles.pageButton}>下一页<ChevronRight size={14} aria-hidden="true" /></button>
      </div>
    </div>
  )
}

function RecordDetail({ jobId, record, selectedSet, disabled, onToggle }: {
  jobId: string
  record: DataCopilotContextRecord
  selectedSet: Set<string>
  disabled: boolean
  onToggle: (sourceId: string) => void
}) {
  return (
    <div style={styles.detail}>
      {record.images?.length ? (
        <div style={styles.imageStrip}>{record.images.map((url, index) => <ContextImage key={`${url}-${index}`} jobId={jobId} src={url} alt={`${record.title} 图片 ${index + 1}`} style={styles.detailImage} />)}</div>
      ) : record.imageUrl ? <ContextImage jobId={jobId} src={record.imageUrl} alt={record.title} style={styles.heroImage} /> : null}
      <div style={styles.detailTitleRow}>
        <div><strong style={styles.detailTitle}>{record.title}</strong>{record.subtitle ? <p style={styles.detailSubtitle}>{record.subtitle}</p> : null}</div>
        {record.url ? <a href={record.url} target="_blank" rel="noreferrer" style={styles.sourceLink} title="打开来源"><ExternalLink size={14} aria-hidden="true" /></a> : null}
      </div>
      {record.fields.length ? <dl style={styles.fields}>{record.fields.map((field) => <div key={`${field.label}-${field.value}`} style={styles.field}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : null}
      <div style={styles.sectionHeading}><strong>选择数据上下文</strong><span>可按本轮问题精确选择</span></div>
      <div style={styles.sectionList}>{record.sections.map((section) => {
        const selected = selectedSet.has(section.sourceId)
        return <button key={section.sourceId} type="button" disabled={disabled} onClick={() => onToggle(section.sourceId)} aria-pressed={selected} style={{ ...styles.sectionButton, ...(selected ? styles.selected : undefined) }}><span style={{ ...styles.check, ...(selected ? styles.checkSelected : undefined) }}>{selected ? <Check size={13} aria-hidden="true" /> : null}</span><span><strong>{section.label}</strong><small>{section.description}</small></span></button>
      })}</div>
      {record.body ? <section style={styles.contentSection}><strong>正文</strong><p>{record.body}</p></section> : null}
      {record.analysis ? <details style={styles.analysis}><summary>已有 AI 分析</summary><pre>{formatAnalysis(record.analysis)}</pre></details> : null}
    </div>
  )
}

function RecordThumbnail({ jobId, record }: { jobId: string; record: DataCopilotContextRecord }) {
  const sources = [...new Set([record.imageUrl, ...(record.images || [])].filter((value): value is string => Boolean(value)))]
  if (sources.length) return <ContextImage jobId={jobId} src={sources} alt={`${record.title} 缩略图`} style={styles.thumbnail} compact />
  const Icon = record.kind === 'comment' ? MessageSquareText : record.kind === 'user' ? UserRound : record.kind === 'artifact' ? FolderOpen : FileText
  return <span style={styles.thumbnailFallback}><Icon size={17} aria-hidden="true" /></span>
}

function ContextImage({ jobId, src, alt, style, compact = false }: {
  jobId: string
  src: string | string[]
  alt: string
  style: CSSProperties
  compact?: boolean
}) {
  const sources = Array.isArray(src) ? src : [src]
  const sourceKey = sources.join('\n')
  const [sourceIndex, setSourceIndex] = useState(0)

  useEffect(() => setSourceIndex(0), [jobId, sourceKey])

  if (!sources[sourceIndex]) {
    return (
      <span role="img" aria-label={`${alt}加载失败`} style={compact ? styles.thumbnailFallback : styles.imageFallback}>
        <ImageIcon size={compact ? 17 : 22} aria-hidden="true" />
        {compact ? null : <small>图片暂不可用</small>}
      </span>
    )
  }

  return (
    <img
      src={contextImageUrl(sources[sourceIndex], jobId)}
      alt={alt}
      style={style}
      loading="lazy"
      onError={() => setSourceIndex((current) => current + 1)}
    />
  )
}

function contextImageUrl(url: string, jobId: string) {
  if (!/^https?:\/\//iu.test(url)) return url
  return `/api/jobs/${encodeURIComponent(jobId)}/media?url=${encodeURIComponent(url)}`
}

function formatDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function formatDateTime(value?: string) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    completed: '已完成',
    complete: '已完成',
    running: '采集中',
    queued: '等待中',
    pending: '等待中',
    failed: '失败',
    stopped: '已停止',
    cancelled: '已取消',
    incomplete: '未完成',
  }
  return labels[value] || value || '未知'
}

function formatAnalysis(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value || '数据记录读取失败')
}

const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', minWidth: 0, height: '100%', flexDirection: 'column', background: '#e7e1d6', borderLeft: '1px solid #cbc4b7', color: '#1f2c25' },
  header: { display: 'flex', minHeight: 70, alignItems: 'center', padding: '0 17px', borderBottom: '1px solid #d0c8bb', background: '#f3eee4' },
  headerTitleRow: { display: 'flex', minWidth: 0, alignItems: 'center', gap: 8 },
  headerCopy: { display: 'grid', minWidth: 0, gap: 3 },
  heading: { overflow: 'hidden', fontSize: 14, lineHeight: 1.3, fontWeight: 720, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { color: '#6b746d', fontSize: 10 },
  backButton: { display: 'grid', width: 32, height: 32, placeItems: 'center', padding: 0, border: '1px solid #c7c0b3', borderRadius: 7, background: '#fffaf2', color: '#35453b', cursor: 'pointer' },
  scrollBody: { minHeight: 0, overflowY: 'auto', padding: '16px 15px 26px' },
  taskSummary: { display: 'grid', gap: 9, padding: '13px', border: '1px solid #d3cbbf', borderRadius: 9, background: '#fffaf2', boxShadow: '0 4px 14px rgba(53, 47, 37, .05)' },
  summaryRow: { display: 'grid', gridTemplateColumns: '72px minmax(0,1fr)', gap: 8, alignItems: 'baseline', color: '#68716c', fontSize: 11 },
  summaryBlock: { display: 'grid', gap: 4, color: '#68716c', fontSize: 11 },
  sectionHeading: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, margin: '18px 2px 9px', color: '#303a34', fontSize: 12 },
  categoryList: { display: 'grid', gap: 9 },
  category: { display: 'grid', gridTemplateColumns: '32px minmax(0,1fr)', alignItems: 'center', border: '1px solid #d3cbbf', borderRadius: 9, background: '#fffaf2', boxShadow: '0 2px 7px rgba(54, 48, 39, .04)' },
  selected: { border: '1px solid #8dbda5', background: '#e0f0e4', boxShadow: 'inset 3px 0 #287b5d' },
  categoryMain: { display: 'grid', minWidth: 0, gridTemplateColumns: '34px minmax(0,1fr) auto 18px', gap: 9, alignItems: 'center', padding: '11px 9px 11px 0', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  categoryIcon: { display: 'grid', width: 34, height: 34, placeItems: 'center', borderRadius: 8, background: '#ece8dc', color: '#3f5146' },
  categoryCopy: { display: 'grid', minWidth: 0, gap: 3 },
  categoryTitle: { overflow: 'hidden', fontSize: 12, fontWeight: 680, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  categoryDescription: { display: '-webkit-box', overflow: 'hidden', color: '#68726c', fontSize: 10, lineHeight: 1.4, WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
  categoryCount: { minWidth: 30, padding: '3px 6px', borderRadius: 6, background: '#e8eee4', color: '#3c694f', fontSize: 11, fontWeight: 720, textAlign: 'center' },
  chevron: { color: '#7a837e', flex: '0 0 auto' },
  check: { display: 'grid', width: 21, height: 21, placeItems: 'center', justifySelf: 'center', padding: 0, border: '1px solid #b9b2a5', borderRadius: 6, background: '#fffaf2', color: '#fff', cursor: 'pointer', flex: '0 0 auto' },
  checkSelected: { border: '1px solid #287b5d', background: '#287b5d' },
  hint: { margin: '12px 3px 0', color: '#68736d', fontSize: 10, lineHeight: 1.55 },
  error: { margin: '8px 0', padding: 10, border: '1px solid #efc8c0', borderRadius: 5, background: '#fff5f2', color: '#a13d2d', fontSize: 11, lineHeight: 1.5 },
  listLayout: { display: 'grid', minHeight: 0, flex: 1, gridTemplateRows: 'auto auto minmax(0,1fr) auto', padding: '14px 12px' },
  search: { display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 11px', border: '1px solid #c9c1b5', borderRadius: 8, background: '#fffaf2', color: '#68736d' },
  searchInput: { width: '100%', minWidth: 0, border: 0, outline: 0, background: 'transparent', color: '#202522', font: 'inherit', fontSize: 12, letterSpacing: 0 },
  listMeta: { display: 'flex', justifyContent: 'space-between', padding: '9px 3px 7px', color: '#68736d', fontSize: 10 },
  recordList: { minHeight: 0, overflowY: 'auto' },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: 30, color: '#68716c', fontSize: 11 },
  empty: { padding: 30, color: '#7c847f', fontSize: 11, textAlign: 'center' },
  taskButton: { display: 'grid', width: '100%', minWidth: 0, gridTemplateColumns: '40px minmax(0,1fr) 18px', gap: 10, alignItems: 'center', marginBottom: 9, padding: '13px 11px', border: '1px solid #d0c8bb', borderRadius: 9, background: '#fffaf2', color: 'inherit', textAlign: 'left', cursor: 'pointer', boxShadow: '0 2px 7px rgba(54, 48, 39, .04)' },
  taskButtonIcon: { display: 'grid', width: 40, height: 40, placeItems: 'center', borderRadius: 9 },
  taskButtonIconApplication: { background: '#d8ede0', color: '#287b5d' },
  taskButtonIconResearch: { background: '#e4e9ef', color: '#46627b' },
  taskButtonCopy: { display: 'grid', minWidth: 0, gap: 5 },
  taskButtonTopline: { display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  taskButtonTitle: { overflow: 'hidden', fontSize: 12, lineHeight: 1.35, fontWeight: 680, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  taskStatus: { flex: '0 0 auto', padding: '3px 6px', borderRadius: 6, background: '#ece9df', color: '#52605a', fontSize: 9, fontWeight: 650 },
  taskIdentity: { display: 'flex', minWidth: 0, alignItems: 'center', gap: 6, overflow: 'hidden', color: '#68736d', fontSize: 10, whiteSpace: 'nowrap' },
  taskCounts: { display: 'flex', minWidth: 0, flexWrap: 'wrap', gap: '4px 9px', color: '#52605a', fontSize: 10 },
  taskDate: { color: '#7d8781', fontSize: 9 },
  record: { display: 'grid', gridTemplateColumns: '31px minmax(0,1fr)', alignItems: 'center', marginBottom: 8, border: '1px solid #d2cabe', borderRadius: 9, background: '#fffaf2' },
  recordMain: { display: 'grid', minWidth: 0, gridTemplateColumns: '44px minmax(0,1fr) 18px', gap: 9, alignItems: 'center', minHeight: 60, padding: '8px 9px 8px 0', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  thumbnail: { width: 44, height: 44, objectFit: 'cover', borderRadius: 7, background: '#e9e5db' },
  thumbnailFallback: { display: 'grid', width: 44, height: 44, placeItems: 'center', borderRadius: 7, background: '#e9e5db', color: '#52635a' },
  recordCopy: { display: 'grid', minWidth: 0, gap: 2 },
  recordTitle: { overflow: 'hidden', fontSize: 12, fontWeight: 650, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  recordSubtitle: { display: '-webkit-box', overflow: 'hidden', color: '#5e6963', fontSize: 10, lineHeight: 1.4, WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
  recordMeta: { overflow: 'hidden', color: '#7a847e', fontSize: 9, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pagination: { display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 8 },
  pageButton: { display: 'flex', minHeight: 32, alignItems: 'center', gap: 4, padding: '0 10px', border: '1px solid #c9c1b5', borderRadius: 7, background: '#fffaf2', color: '#46534c', fontSize: 10, cursor: 'pointer' },
  detail: { minHeight: 0, overflowY: 'auto', padding: '16px 15px 28px' },
  imageStrip: { display: 'grid', gridAutoColumns: '80%', gridAutoFlow: 'column', gap: 6, overflowX: 'auto', marginBottom: 10, scrollSnapType: 'x mandatory' },
  detailImage: { width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 5, background: '#eef1ef', scrollSnapAlign: 'start' },
  heroImage: { width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 5, background: '#eef1ef' },
  imageFallback: { display: 'grid', width: '100%', aspectRatio: '4 / 3', placeItems: 'center', alignContent: 'center', gap: 5, borderRadius: 5, background: '#eef1ef', color: '#6b756f', fontSize: 9, scrollSnapAlign: 'start' },
  detailTitleRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginTop: 10 },
  detailTitle: { fontSize: 14, lineHeight: 1.45 },
  detailSubtitle: { margin: '5px 0 0', color: '#626d67', fontSize: 11, lineHeight: 1.5 },
  sourceLink: { display: 'grid', width: 28, height: 28, flex: '0 0 auto', placeItems: 'center', border: '1px solid #d7dcd9', borderRadius: 5, background: '#fff', color: '#48554e' },
  fields: { display: 'grid', gap: 5, margin: '10px 0 0', padding: 9, border: '1px solid #e0e4e1', borderRadius: 5, background: '#fff' },
  field: { display: 'grid', gridTemplateColumns: '70px minmax(0,1fr)', gap: 8, fontSize: 10, lineHeight: 1.45, overflowWrap: 'anywhere' },
  sectionList: { display: 'grid', gap: 5 },
  sectionButton: { display: 'grid', gridTemplateColumns: '24px minmax(0,1fr)', gap: 7, alignItems: 'center', padding: 8, border: '1px solid #dde2de', borderRadius: 5, background: '#fff', color: '#28302c', textAlign: 'left', cursor: 'pointer' },
  contentSection: { marginTop: 16, paddingTop: 14, borderTop: '1px solid #dfe4e0', fontSize: 11, lineHeight: 1.7, whiteSpace: 'pre-wrap' },
  analysis: { marginTop: 12, padding: 11, border: '1px solid #dce2de', borderRadius: 6, background: '#fff', fontSize: 11, overflow: 'hidden' },
}
