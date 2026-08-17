import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  Check,
  ChevronRight,
  Database,
  FileText,
  MessageSquareText,
  Paperclip,
  Search,
  UserRound,
  X,
} from 'lucide-react'

export type DataCopilotRole = 'user' | 'assistant' | 'system' | 'tool'

export type DataCopilotMessageKind =
  | 'text'
  | 'analysis'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'error'

export type DataCopilotRunStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'waiting_input'
  | 'waiting_approval'
  | 'stopping'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'resumable'

export type DataCopilotMessageStatus =
  | 'pending'
  | 'streaming'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type DataCopilotAttachmentStatus =
  | 'pending'
  | 'uploading'
  | 'ready'
  | 'failed'

export type DataCopilotToolStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type DataCopilotContextKind =
  | 'job'
  | 'post'
  | 'comment'
  | 'user'
  | 'artifact'
  | 'dataset'
  | 'attachment'

export type DataCopilotAttachment = {
  id: string
  name: string
  size: number
  mediaType: string
  status: DataCopilotAttachmentStatus
  uploadProgress?: number
  url?: string
  error?: string
  sourceId?: string
}

export type DataCopilotToolCall = {
  id: string
  name: string
  status: DataCopilotToolStatus
  arguments?: unknown
  result?: unknown
  startedAt?: string
  finishedAt?: string
  error?: string
}

export type DataCopilotSubagentRunStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'failed'

export type DataCopilotSubagentTaskStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DataCopilotSubagentToolStatus =
  | 'running'
  | 'completed'
  | 'failed'

export type DataCopilotSubagentError = {
  code?: string
  message: string
}

export type DataCopilotSubagentTool = {
  toolCallId: string
  toolName: string
  status: DataCopilotSubagentToolStatus
  error?: DataCopilotSubagentError
  startedAt?: string
  finishedAt?: string
}

export type DataCopilotSubagentTask = {
  taskId: string
  role: string
  title: string
  dependsOn: string[]
  status: DataCopilotSubagentTaskStatus
  output: string
  summary?: string
  error?: DataCopilotSubagentError
  tools: DataCopilotSubagentTool[]
  startedAt?: string
  finishedAt?: string
}

export type DataCopilotSubagentRun = {
  runId: string
  parentRunId?: string
  conversationId: string
  objective: string
  planRevision?: number
  status: DataCopilotSubagentRunStatus
  tasks: DataCopilotSubagentTask[]
  error?: DataCopilotSubagentError
  plannedAt?: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

export type DataCopilotCitation = {
  id: string
  label: string
  sourceId?: string
  url?: string
  excerpt?: string
}

export type DataCopilotApproval = {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'consumed'
  summary: string
  toolName?: string
  riskLevel?: string
  arguments?: unknown
  createdAt?: string
  expiresAt?: string | null
}

export type DataCopilotMessageData = {
  id: string
  sessionId: string
  role: DataCopilotRole
  kind: DataCopilotMessageKind
  content: string
  createdAt: string
  status?: DataCopilotMessageStatus
  attachments?: DataCopilotAttachment[]
  toolCalls?: DataCopilotToolCall[]
  citations?: DataCopilotCitation[]
  approval?: DataCopilotApproval
  retryable?: boolean
}

export type DataCopilotSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview?: string
  status?: DataCopilotRunStatus
  modelId?: string
  reasoningEffort?: DataCopilotReasoningEffort
  contextSourceIds?: string[]
  jobId?: string
  mode?: string
  snapshotId?: string
  filters?: string[]
  workspaceBinding?: DataCopilotWorkspaceBinding
}

export type DataCopilotWorkspaceBinding = {
  projectId: string
  workspaceId: string
  worktreeId?: string
}

export type DataCopilotModel = {
  id: string
  label: string
  provider?: string
  contextWindow?: number
  supportsTools?: boolean
  supportsAttachments?: boolean
  wireApi?: 'responses' | 'chat_completions'
  supportsReasoningEffort?: boolean
  reasoningEfforts?: readonly DataCopilotReasoningEffort[]
  disabled?: boolean
}

export const DATA_COPILOT_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type DataCopilotReasoningEffort = (typeof DATA_COPILOT_REASONING_EFFORTS)[number]

export const DATA_COPILOT_DEFAULT_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly DataCopilotReasoningEffort[]

export function dataCopilotReasoningEffortsForModel(
  model: string,
  wireApi?: DataCopilotModel['wireApi'],
): readonly DataCopilotReasoningEffort[] {
  if (wireApi !== 'responses') return []
  return /^gpt-5\.6(?:-|$)/iu.test(model.trim())
    ? DATA_COPILOT_REASONING_EFFORTS
    : DATA_COPILOT_DEFAULT_REASONING_EFFORTS
}

export type DataCopilotContextSource = {
  id: string
  kind: DataCopilotContextKind
  title: string
  subtitle?: string
  count?: number
  status?: string
  removable?: boolean
}

export type DataCopilotRecordKind = 'posts' | 'comments' | 'users' | 'artifacts'

export type DataCopilotTaskRecord = {
  id: string
  title: string
  mode: 'application' | 'research'
  modeLabel: string
  status: string
  createdAt: string
  updatedAt: string
  snapshotId: string
  revision: number
  progress: number
  counts: Record<DataCopilotRecordKind, number>
}

export type DataCopilotTaskCatalog = {
  schemaVersion: number
  total: number
  offset: number
  limit: number
  items: DataCopilotTaskRecord[]
}

export type DataCopilotContextSection = {
  sourceId: string
  label: string
  description?: string
}

export type DataCopilotContextRecord = {
  sourceId: string
  recordId: string
  kind: 'post' | 'comment' | 'user' | 'artifact'
  title: string
  subtitle?: string
  status?: string
  timestamp?: string
  imageUrl?: string
  url?: string
  fields: Array<{ label: string; value: string }>
  body?: string
  images?: string[]
  analysis?: unknown
  sections: DataCopilotContextSection[]
}

export type DataCopilotContextCatalog = {
  schemaVersion: number
  jobId: string
  mode: string
  kind?: DataCopilotRecordKind
  counts?: Record<DataCopilotRecordKind, number>
  total?: number
  offset?: number
  limit?: number
  items?: DataCopilotContextRecord[]
}

export type DataCopilotContextMeta = {
  taskId?: string
  taskLabel?: string
  mode?: string
  snapshotId?: string
  filters?: string[]
}

export type DataCopilotSendRequest = {
  sessionId: string
  content: string
  modelId: string
  workspaceMode?: 'ask' | 'analyze' | 'build'
  reasoningEffort?: DataCopilotReasoningEffort
  attachmentIds: string[]
  contextSourceIds: string[]
  projectId?: string
  workspaceId?: string
  worktreeId?: string
}

export type DataCopilotQualityArtifact = {
  id: string
  name: string
  format: string
  size: number
  sha256: string
  status: string
  url: string
}

export type DataCopilotQualityEvaluation = {
  id: string
  status: string
  createdAt: string
  durationMs: number
  summary: { total: number; passed: number; failed: number; passRate: number }
}

export type DataCopilotQualityState = {
  usage: {
    records: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    latencyMs: number
    estimatedCostUsd: number
  }
  traces: Array<{
    id: string
    operation: string
    status: string
    durationMs: number
    createdAt: string
  }>
  snapshots: Array<{
    id: string
    revision: number
    manifestHash: string
    createdAt: string
  }>
  artifacts: DataCopilotQualityArtifact[]
  evaluations: DataCopilotQualityEvaluation[]
}

export type DataCopilotSendResult = {
  session?: DataCopilotSession
  messages?: DataCopilotMessageData[]
}

export type DataCopilotSubscriptionHandlers = {
  /**
   * Legacy per-message callback. New high-throughput surfaces should prefer
   * onMessages so streamed deltas can be committed once per animation frame.
   */
  onMessage?: (message: DataCopilotMessageData) => void
  onMessages?: (messages: DataCopilotMessageData[]) => void
  onSession?: (session: DataCopilotSession) => void
  onStatus?: (status: DataCopilotRunStatus) => void
  onSubagentRun?: (run: DataCopilotSubagentRun) => void
  onSubagentRuns?: (runs: DataCopilotSubagentRun[]) => void
  onError?: (error: Error) => void
}

export type DataCopilotTransport = {
  listSessions: () => Promise<DataCopilotSession[]>
  listContextTasks?: (input: {
    query?: string
    offset?: number
    limit?: number
  }) => Promise<DataCopilotTaskCatalog>
  listContextRecords?: (input: {
    jobId?: string
    mode?: 'application' | 'research'
    kind?: DataCopilotRecordKind
    query?: string
    offset?: number
    limit?: number
  }) => Promise<DataCopilotContextCatalog>
  createSession: (input: {
    modelId: string
    reasoningEffort?: DataCopilotReasoningEffort
    contextSourceIds: string[]
    jobId?: string
    mode?: 'application' | 'research'
    snapshotId?: string
    projectId?: string
    workspaceId?: string
    worktreeId?: string
  }) => Promise<DataCopilotSession>
  loadMessages: (sessionId: string) => Promise<DataCopilotMessageData[]>
  sendMessage: (request: DataCopilotSendRequest) => Promise<DataCopilotSendResult>
  uploadAttachments?: (
    sessionId: string,
    files: File[],
  ) => Promise<DataCopilotAttachment[]>
  stopGeneration?: (sessionId: string) => Promise<void>
  retryMessage?: (
    sessionId: string,
    messageId: string,
    input?: {
      modelId?: string
      reasoningEffort?: DataCopilotReasoningEffort
    },
  ) => Promise<DataCopilotSendResult>
  updateSessionSettings?: (
    sessionId: string,
    input: {
      modelId?: string
      reasoningEffort?: DataCopilotReasoningEffort
    },
  ) => Promise<DataCopilotSession>
  confirmApproval?: (
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ) => Promise<DataCopilotSendResult>
  deleteSession?: (sessionId: string) => Promise<void>
  renameSession?: (
    sessionId: string,
    title: string,
  ) => Promise<DataCopilotSession>
  subscribe?: (
    sessionId: string,
    handlers: DataCopilotSubscriptionHandlers,
  ) => () => void
  loadQuality?: (
    sessionId: string,
    jobId: string,
  ) => Promise<DataCopilotQualityState>
  runGoldenEvaluation?: () => Promise<DataCopilotQualityEvaluation>
  createArtifact?: (
    sessionId: string,
    input: { format: 'json' | 'csv' | 'markdown' | 'xlsx'; name: string; content?: unknown; data?: unknown },
  ) => Promise<DataCopilotQualityArtifact>
  upgradeSnapshot?: (sessionId: string) => Promise<DataCopilotSession>
}

export type DataCopilotRuntimeContext = {
  sessionId: string | null
  modelId: string
  selectedContextSourceIds: string[]
  runStatus: DataCopilotRunStatus
}

const RuntimeContext = createContext<DataCopilotRuntimeContext | null>(null)

export function DataCopilotContextProvider({
  value,
  children,
}: {
  value: DataCopilotRuntimeContext
  children: ReactNode
}) {
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
}

export function useDataCopilotContext() {
  const value = useContext(RuntimeContext)
  if (!value) {
    throw new Error('useDataCopilotContext must be used inside DataCopilotContextProvider')
  }
  return value
}

export type DataCopilotContextPaneProps = {
  sources: DataCopilotContextSource[]
  selectedIds: string[]
  contextMeta?: DataCopilotContextMeta
  usedTools?: string[]
  className?: string
  disabled?: boolean
  onToggle: (sourceId: string) => void
  onOpen?: (source: DataCopilotContextSource) => void
  onRemove?: (source: DataCopilotContextSource) => void
}

const kindLabels: Record<DataCopilotContextKind, string> = {
  job: '任务',
  post: '原帖',
  comment: '评论',
  user: '用户',
  artifact: '产物',
  dataset: '数据集',
  attachment: '附件',
}

function SourceIcon({ kind }: { kind: DataCopilotContextKind }) {
  const props = { size: 15, strokeWidth: 1.8, 'aria-hidden': true as const }
  if (kind === 'user') return <UserRound {...props} />
  if (kind === 'comment') return <MessageSquareText {...props} />
  if (kind === 'attachment') return <Paperclip {...props} />
  if (kind === 'post' || kind === 'artifact') return <FileText {...props} />
  return <Database {...props} />
}

export function DataCopilotContextPane({
  sources,
  selectedIds,
  contextMeta,
  usedTools = [],
  className,
  disabled = false,
  onToggle,
  onOpen,
  onRemove,
}: DataCopilotContextPaneProps) {
  const [query, setQuery] = useState('')
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredSources = useMemo(
    () =>
      sources.filter((source) => {
        if (!normalizedQuery) return true
        return `${source.title} ${source.subtitle ?? ''} ${kindLabels[source.kind]}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      }),
    [normalizedQuery, sources],
  )

  return (
    <aside className={className} style={contextStyles.root} aria-label="数据上下文">
      <header style={contextStyles.header}>
        <div>
          <strong style={contextStyles.heading}>数据上下文</strong>
          <div style={contextStyles.meta}>{selectedIds.length} 项已启用</div>
        </div>
      </header>

      <section style={contextStyles.summary} aria-label="当前任务上下文">
        <div style={contextStyles.summaryRow}>
          <span>当前任务</span>
          <strong title={contextMeta?.taskId}>{contextMeta?.taskLabel || contextMeta?.taskId || '未绑定'}</strong>
        </div>
        <div style={contextStyles.summaryRow}>
          <span>任务类型</span>
          <strong>{contextMeta?.mode || '未指定'}</strong>
        </div>
        <div style={contextStyles.summaryRow}>
          <span>数据快照</span>
          <strong title={contextMeta?.snapshotId}>{contextMeta?.snapshotId || '未指定'}</strong>
        </div>
        <div style={contextStyles.summaryBlock}>
          <span>筛选条件</span>
          <div>{contextMeta?.filters?.length ? contextMeta.filters.join(' · ') : '未设置额外筛选'}</div>
        </div>
        <div style={contextStyles.summaryBlock}>
          <span>本会话已用工具</span>
          <div>{usedTools.length ? usedTools.join(' · ') : '尚未调用工具'}</div>
        </div>
      </section>

      <label style={contextStyles.search}>
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选数据"
          aria-label="筛选数据上下文"
          style={contextStyles.searchInput}
        />
      </label>

      <div style={contextStyles.list}>
        {filteredSources.length === 0 ? (
          <div style={contextStyles.empty}>没有匹配的数据</div>
        ) : (
          filteredSources.map((source) => {
            const selected = selectedSet.has(source.id)
            return (
              <div
                key={source.id}
                style={{
                  ...contextStyles.item,
                  ...(selected ? contextStyles.itemSelected : undefined),
                }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(source.id)}
                  aria-pressed={selected}
                  aria-label={`${selected ? '移除' : '添加'}${source.title}`}
                  title={selected ? '从本轮上下文移除' : '加入本轮上下文'}
                  style={{
                    ...contextStyles.checkButton,
                    ...(selected ? contextStyles.checkButtonSelected : undefined),
                  }}
                >
                  {selected ? <Check size={13} aria-hidden="true" /> : null}
                </button>

                <div style={contextStyles.sourceBody}>
                  <div style={contextStyles.sourceTitleRow}>
                    <span style={contextStyles.sourceIcon}>
                      <SourceIcon kind={source.kind} />
                    </span>
                    <span style={contextStyles.sourceTitle}>{source.title}</span>
                  </div>
                  <div style={contextStyles.sourceMeta}>
                    <span>{kindLabels[source.kind]}</span>
                    {typeof source.count === 'number' ? <span>{source.count} 条</span> : null}
                    {source.status ? <span>{source.status}</span> : null}
                  </div>
                  {source.subtitle ? (
                    <div style={contextStyles.sourceSubtitle}>{source.subtitle}</div>
                  ) : null}
                </div>

                <div style={contextStyles.actions}>
                  {onOpen ? (
                    <button
                      type="button"
                      onClick={() => onOpen(source)}
                      title="打开数据"
                      aria-label={`打开${source.title}`}
                      style={contextStyles.iconButton}
                    >
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                  {source.removable && onRemove ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRemove(source)}
                      title="移除数据源"
                      aria-label={`移除${source.title}`}
                      style={contextStyles.iconButton}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}

const contextStyles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    minWidth: 0,
    height: '100%',
    flexDirection: 'column',
    background: '#f8f9f7',
    borderLeft: '1px solid #dfe3df',
    color: '#202522',
  },
  header: {
    display: 'flex',
    minHeight: 61,
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 14px',
    borderBottom: '1px solid #e3e6e3',
  },
  heading: { display: 'block', fontSize: 13, lineHeight: 1.3, fontWeight: 650 },
  meta: { marginTop: 3, color: '#707873', fontSize: 11 },
  summary: {
    display: 'grid',
    gap: 7,
    margin: '10px 12px 0',
    padding: '10px',
    border: '1px solid #e0e4e1',
    borderRadius: 5,
    background: '#fff',
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: '64px minmax(0, 1fr)',
    gap: 7,
    alignItems: 'baseline',
    color: '#737b76',
    fontSize: 10,
  },
  summaryBlock: {
    display: 'grid',
    gap: 3,
    color: '#737b76',
    fontSize: 10,
  },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    height: 34,
    margin: '10px 12px',
    padding: '0 9px',
    border: '1px solid #d8ddd9',
    borderRadius: 5,
    background: '#fff',
    color: '#727b76',
  },
  searchInput: {
    width: '100%',
    minWidth: 0,
    border: 0,
    outline: 0,
    background: 'transparent',
    color: '#202522',
    font: 'inherit',
    fontSize: 12,
    letterSpacing: 0,
  },
  list: { minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' },
  empty: { padding: '24px 10px', textAlign: 'center', color: '#7c847f', fontSize: 12 },
  item: {
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr) auto',
    gap: 7,
    alignItems: 'start',
    padding: '9px 7px',
    border: '1px solid transparent',
    borderRadius: 5,
  },
  itemSelected: { border: '1px solid #b8d8cc', background: '#eef7f3' },
  checkButton: {
    display: 'grid',
    width: 19,
    height: 19,
    placeItems: 'center',
    marginTop: 1,
    padding: 0,
    border: '1px solid #bcc4bf',
    borderRadius: 4,
    background: '#fff',
    color: '#fff',
    cursor: 'pointer',
  },
  checkButtonSelected: { border: '1px solid #0b7a62', background: '#0b7a62' },
  sourceBody: { minWidth: 0 },
  sourceTitleRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  sourceIcon: { display: 'inline-flex', flex: '0 0 auto', color: '#4e5a54' },
  sourceTitle: {
    overflow: 'hidden',
    color: '#27302b',
    fontSize: 12,
    fontWeight: 600,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sourceMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 5,
    color: '#727b76',
    fontSize: 10,
  },
  sourceSubtitle: {
    display: '-webkit-box',
    overflow: 'hidden',
    marginTop: 4,
    color: '#646d68',
    fontSize: 11,
    lineHeight: 1.45,
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  actions: { display: 'flex', flexDirection: 'column', gap: 2 },
  iconButton: {
    display: 'grid',
    width: 24,
    height: 24,
    placeItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: 'transparent',
    color: '#66706a',
    cursor: 'pointer',
  },
}
