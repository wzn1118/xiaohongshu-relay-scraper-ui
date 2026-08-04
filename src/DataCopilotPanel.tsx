import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  AlertCircle,
  ArrowDown,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Database,
  FileText,
  Gauge,
  KeyRound,
  Layers3,
  LoaderCircle,
  Link2,
  Mail,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  UploadCloud,
  Users,
  X,
} from 'lucide-react'
import type { AiModelDiscovery, AiProviderOption, ApplicationBatch } from './types'
import { api } from './api'
import {
  DataCopilotContextProvider,
  type DataCopilotAttachment,
  type DataCopilotCitation,
  type DataCopilotContextMeta,
  type DataCopilotContextSource,
  type DataCopilotMessageData,
  type DataCopilotModel,
  type DataCopilotRunStatus,
  type DataCopilotSession,
  type DataCopilotTaskRecord,
  type DataCopilotTransport,
} from './DataCopilotContext'
import { DataCopilotContextBrowser } from './DataCopilotContextBrowser'
import { DataCopilotMessage } from './DataCopilotMessage'
import { AgentWorkbench } from './copilot/AgentWorkbench'
import { DataCopilotQualityPanel } from './copilot/QualityPanel'
import { useCopilotEventProjection } from './copilot/useCopilotEventProjection'

type PendingFile = {
  id: string
  file: File
}

type MobilePane = 'sessions' | 'conversation' | 'context'
type WorkspaceMode = 'ask' | 'analyze' | 'build'

export type DataCopilotModelConnectionInput = {
  provider: AiProviderOption['id']
  apiKey: string
  baseUrl: string
  model: string
  wireApi: 'responses' | 'chat_completions'
}

type ModelConnectorDraft = DataCopilotModelConnectionInput & {
  models: string[]
}

export type DataCopilotPanelProps = {
  open: boolean
  transport: DataCopilotTransport
  models: DataCopilotModel[]
  initialSessions?: DataCopilotSession[]
  initialSessionId?: string
  initialMessages?: Record<string, DataCopilotMessageData[]>
  contextSources?: DataCopilotContextSource[]
  contextMeta?: DataCopilotContextMeta
  defaultContextSourceIds?: string[]
  defaultModelId?: string
  modelProviders?: AiProviderOption[]
  defaultModelProviderId?: AiProviderOption['id']
  title?: string
  side?: 'left' | 'right'
  minWidth?: number
  maxWidth?: number
  defaultWidth?: number
  maxFiles?: number
  maxFileBytes?: number
  acceptedFileTypes?: string
  onClose: () => void
  onSessionChange?: (sessionId: string) => void
  onOpenSource?: (source: DataCopilotContextSource) => void
  onRemoveSource?: (source: DataCopilotContextSource) => void
  onOpenAttachment?: (attachment: DataCopilotAttachment) => void
  onOpenCitation?: (citation: DataCopilotCitation) => void
  onDiscoverModels?: (
    input: Pick<DataCopilotModelConnectionInput, 'provider' | 'apiKey' | 'baseUrl'>,
  ) => Promise<AiModelDiscovery>
  onConnectModel?: (input: DataCopilotModelConnectionInput) => Promise<DataCopilotModel>
  onError?: (error: Error) => void
}

function modelDraftFromProvider(provider: AiProviderOption | undefined): ModelConnectorDraft {
  return {
    provider: provider?.id ?? 'relay',
    apiKey: '',
    baseUrl: provider?.baseUrl ?? '',
    model: provider?.model ?? provider?.models[0] ?? '',
    wireApi: provider?.wireApi ?? 'chat_completions',
    models: provider?.models ?? [],
  }
}

function createLocalId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

function mergeMessages(
  current: DataCopilotMessageData[],
  incoming: DataCopilotMessageData[],
) {
  if (incoming.length === 0) return current
  const merged = [...current]
  const indexById = new Map(merged.map((message, index) => [message.id, index]))
  for (const message of incoming) {
    const index = indexById.get(message.id)
    if (index === undefined) {
      let optimisticIndex = -1
      if (message.role === 'user') {
        for (let candidate = merged.length - 1; candidate >= 0; candidate -= 1) {
          const item = merged[candidate]
          if (item.id.startsWith('user-message-') && item.content === message.content) {
            optimisticIndex = candidate
            break
          }
        }
      }
      if (optimisticIndex >= 0) {
        merged[optimisticIndex] = message
        indexById.set(message.id, optimisticIndex)
        continue
      }
      indexById.set(message.id, merged.length)
      merged.push(message)
    } else {
      const previous = merged[index]
      merged[index] = {
        ...previous,
        ...message,
        toolCalls: message.toolCalls?.map((toolCall) => ({
          ...previous.toolCalls?.find((item) => item.id === toolCall.id),
          ...toolCall,
        })) ?? previous.toolCalls,
      }
    }
  }
  return merged
}

function mergeSession(current: DataCopilotSession[], incoming: DataCopilotSession) {
  const index = current.findIndex((session) => session.id === incoming.id)
  if (index === -1) return [incoming, ...current]
  const next = [...current]
  next[index] = incoming
  return next
}

function formatSessionTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return new Intl.DateTimeFormat('zh-CN',
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: '2-digit', day: '2-digit' },
  ).format(date)
}

function fileSizeLabel(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function isActiveStatus(status: DataCopilotRunStatus) {
  return status === 'planning' || status === 'executing' || status === 'waiting_approval' || status === 'stopping'
}

function recordContextKind(sourceId: string) {
  const match = /^xhs-context:\/\/jobs\/[^/]+\/(posts|comments|users|artifacts)\//u.exec(sourceId)
  return match?.[1] || ''
}

function recordContextIdentity(sourceId: string) {
  const match = /^(xhs-context:\/\/jobs\/[^/]+\/(?:posts|comments|users|artifacts)\/[^?]+)\?section=([^&]+)/u.exec(sourceId)
  if (!match) return null
  return { record: match[1], section: decodeURIComponent(match[2] || 'record') }
}

function aggregateOwnsRecord(aggregateId: string, sourceId: string) {
  const kind = recordContextKind(sourceId)
  if (aggregateId === 'dataset:content') return kind === 'posts'
  if (aggregateId === 'dataset:audience') return kind === 'comments' || kind === 'users'
  if (aggregateId === 'dataset:artifacts') return kind === 'artifacts'
  return false
}

function defaultTaskContextSourceIds(jobId: string) {
  return [`job:${jobId}`, 'dataset:content', 'dataset:audience', 'dataset:artifacts']
}

function sessionMatchesTask(session: DataCopilotSession, task: DataCopilotTaskRecord) {
  return session.jobId === task.id && session.snapshotId === task.snapshotId
}

function contextSourceJobId(sourceId: string) {
  if (sourceId.startsWith('job:')) return sourceId.slice(4)
  const match = /^xhs-context:\/\/jobs\/([^/]+)\//u.exec(sourceId)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function contextSourceIdsForTask(sourceIds: string[], jobId: string) {
  return sourceIds.filter((sourceId) => {
    const boundJobId = contextSourceJobId(sourceId)
    return !boundJobId || boundJobId === jobId
  })
}

function taskFromSession(session: DataCopilotSession): DataCopilotTaskRecord | null {
  if (!session.jobId) return null
  const mode = session.mode === 'research' ? 'research' : 'application'
  const revision = Number.parseInt(session.snapshotId?.replace(/^job-r/u, '') || '0', 10) || 0
  return {
    id: session.jobId,
    title: session.title || session.jobId,
    mode,
    modeLabel: mode === 'application' ? '岗位任务' : '非岗位任务',
    status: session.status || 'unknown',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    snapshotId: session.snapshotId || `job-r${revision}`,
    revision,
    progress: 0,
    counts: { posts: 0, comments: 0, users: 0, artifacts: 0 },
  }
}

export function DataCopilotPanel({
  open,
  transport,
  models,
  initialSessions = [],
  initialSessionId,
  initialMessages = {},
  contextSources = [],
  contextMeta,
  defaultContextSourceIds = [],
  defaultModelId,
  modelProviders = [],
  defaultModelProviderId,
  title = 'Data Copilot',
  side = 'right',
  minWidth = 720,
  maxWidth = 1440,
  defaultWidth = 1120,
  maxFiles = 8,
  maxFileBytes = 25 * 1024 * 1024,
  acceptedFileTypes,
  onClose,
  onSessionChange,
  onOpenAttachment,
  onOpenCitation,
  onDiscoverModels,
  onConnectModel,
  onError,
}: DataCopilotPanelProps) {
  const fallbackModelId = defaultModelId ?? models.find((model) => !model.disabled)?.id ?? ''
  const [panelWidth, setPanelWidth] = useState(defaultWidth)
  const [fullscreen, setFullscreen] = useState(false)
  const [mobilePane, setMobilePane] = useState<MobilePane>('conversation')
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false)
  const [contextCollapsed, setContextCollapsed] = useState(false)
  const [qualityOpen, setQualityOpen] = useState(false)
  const [modelConnectorOpen, setModelConnectorOpen] = useState(false)
  const [modelConnectorBusy, setModelConnectorBusy] = useState<'discover' | 'connect' | null>(null)
  const [modelConnectorStatus, setModelConnectorStatus] = useState<{
    tone: 'neutral' | 'success' | 'error'
    message: string
  } | null>(null)
  const [modelDraft, setModelDraft] = useState<ModelConnectorDraft>(() => modelDraftFromProvider(
    modelProviders.find((provider) => provider.id === defaultModelProviderId) ?? modelProviders[0],
  ))
  const [sessions, setSessions] = useState<DataCopilotSession[]>(initialSessions)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? initialSessions[0]?.id ?? null,
  )
  const [selectedContextTask, setSelectedContextTask] = useState<DataCopilotTaskRecord | null>(null)
  const [messagesBySession, setMessagesBySession] =
    useState<Record<string, DataCopilotMessageData[]>>(initialMessages)
  const [selectedContextSourceIds, setSelectedContextSourceIds] =
    useState<string[]>(defaultContextSourceIds)
  const [modelId, setModelId] = useState(fallbackModelId)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('ask')
  const [composerValue, setComposerValue] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [sessionQuery, setSessionQuery] = useState('')
  const [runStatus, setRunStatus] = useState<DataCopilotRunStatus>('idle')
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const loadedSessionIdsRef = useRef(new Set(Object.keys(initialMessages)))
  const boundSessionIdRef = useRef<string | null>(null)
  const listRequestRef = useRef(0)
  const messageRequestRef = useRef(0)
  const operationEpochRef = useRef(0)
  const resizeRef = useRef<{ x: number; width: number } | null>(null)
  const sendInFlightRef = useRef(false)
  const selectedContextTaskRef = useRef<DataCopilotTaskRecord | null>(selectedContextTask)
  const onErrorRef = useRef(onError)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageAreaRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const openModelConnector = useCallback(() => {
    const preferredProvider = modelProviders.find((provider) => provider.id === defaultModelProviderId)
      ?? modelProviders.find((provider) => provider.configured)
      ?? modelProviders[0]
    setModelDraft(modelDraftFromProvider(preferredProvider))
    setModelConnectorStatus(null)
    setModelConnectorOpen(true)
  }, [defaultModelProviderId, modelProviders])

  const selectModelProvider = useCallback((providerId: AiProviderOption['id']) => {
    setModelDraft(modelDraftFromProvider(modelProviders.find((provider) => provider.id === providerId)))
    setModelConnectorStatus(null)
  }, [modelProviders])

  const discoverModels = useCallback(async () => {
    if (!onDiscoverModels) return
    setModelConnectorBusy('discover')
    setModelConnectorStatus({ tone: 'neutral', message: '正在验证连接并读取模型列表…' })
    try {
      const result = await onDiscoverModels({
        provider: modelDraft.provider,
        apiKey: modelDraft.apiKey,
        baseUrl: modelDraft.baseUrl,
      })
      setModelDraft((current) => ({
        ...current,
        // A saved credential is scoped to its configured URL. Discovery may
        // return a normalized /v1 URL, but changing to it here would make the
        // following session request look like a different credential scope.
        baseUrl: current.apiKey.trim() ? result.baseUrl : current.baseUrl,
        models: result.models,
        model: result.models.includes(current.model) ? current.model : (result.models[0] ?? current.model),
      }))
      setModelConnectorStatus({ tone: 'success', message: `连接可用，已读取 ${result.models.length} 个模型。` })
    } catch (error) {
      setModelConnectorStatus({ tone: 'error', message: toError(error).message })
    } finally {
      setModelConnectorBusy(null)
    }
  }, [modelDraft.apiKey, modelDraft.baseUrl, modelDraft.provider, onDiscoverModels])

  const connectModel = useCallback(async () => {
    if (!onConnectModel) return
    const provider = modelProviders.find((item) => item.id === modelDraft.provider)
    if (!modelDraft.baseUrl.trim()) {
      setModelConnectorStatus({ tone: 'error', message: '请填写 API Base URL。' })
      return
    }
    if (provider?.requiresKey && !provider.hasApiKey && !modelDraft.apiKey.trim()) {
      setModelConnectorStatus({ tone: 'error', message: '请填写 API Key。' })
      return
    }
    if (!modelDraft.model.trim()) {
      setModelConnectorStatus({ tone: 'error', message: '请选择或填写模型 ID。' })
      return
    }
    setModelConnectorBusy('connect')
    setModelConnectorStatus({ tone: 'neutral', message: '正在创建安全模型会话…' })
    try {
      const connectedModel = await onConnectModel({
        provider: modelDraft.provider,
        apiKey: modelDraft.apiKey,
        baseUrl: modelDraft.baseUrl,
        model: modelDraft.model.trim(),
        wireApi: modelDraft.wireApi,
      })
      setModelId(connectedModel.id)
      setModelDraft((current) => ({ ...current, apiKey: '' }))
      setModelConnectorStatus({ tone: 'success', message: `${connectedModel.label} 已连接。` })
      setModelConnectorOpen(false)
      setLocalError(null)
    } catch (error) {
      setModelConnectorStatus({ tone: 'error', message: toError(error).message })
    } finally {
      setModelConnectorBusy(null)
    }
  }, [modelDraft, modelProviders, onConnectModel])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const reportError = useCallback((value: unknown) => {
    const error = toError(value)
    setLocalError(error.message)
    onErrorRef.current?.(error)
    return error
  }, [])

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )
  const activeMessages = selectedSessionId
    ? (messagesBySession[selectedSessionId] ?? [])
    : []
  const effectiveStatus = isActiveStatus(runStatus)
    ? runStatus
    : (selectedSession?.status ?? runStatus)
  const running = isActiveStatus(effectiveStatus)
  const workbenchProjection = useCopilotEventProjection(activeMessages, effectiveStatus)
  const selectedModel = models.find((model) => model.id === modelId)
  const modelDraftProvider = modelProviders.find((provider) => provider.id === modelDraft.provider)
  const selectedContextMeta = useMemo(() => ({
    ...contextMeta,
    taskId: selectedContextTask?.id || selectedSession?.jobId || contextMeta?.taskId,
    taskLabel: selectedContextTask?.title || contextMeta?.taskLabel,
    mode: selectedContextTask?.modeLabel || (selectedSession?.mode
      ? selectedSession.mode === 'application' ? '岗位任务' : '非岗位任务'
      : contextMeta?.mode),
    snapshotId: selectedContextTask?.snapshotId || selectedSession?.snapshotId || contextMeta?.snapshotId,
    filters: selectedSession?.filters?.length ? selectedSession.filters : contextMeta?.filters,
  }), [contextMeta, selectedContextTask, selectedSession])
  const usedTools = useMemo(
    () => [...new Set(activeMessages.flatMap((message) =>
      (message.toolCalls ?? []).map((toolCall) => toolCall.name),
    ))],
    [activeMessages],
  )
  const normalizedSessionQuery = sessionQuery.trim().toLocaleLowerCase()
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) => {
        if (!normalizedSessionQuery) return true
        return `${session.title} ${session.preview ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedSessionQuery)
      }),
    [normalizedSessionQuery, sessions],
  )

  const selectContextTask = useCallback((task: DataCopilotTaskRecord) => {
    selectedContextTaskRef.current = task
    setSelectedContextTask(task)
    const matchingSession = sessions.find((session) => (
      sessionMatchesTask(session, task)
    )) ?? null
    setSelectedSessionId(matchingSession?.id ?? null)
    setSelectedContextSourceIds(
      matchingSession?.contextSourceIds?.length
        ? matchingSession.contextSourceIds
        : defaultTaskContextSourceIds(task.id),
    )
    setRunStatus(matchingSession?.status ?? 'idle')
    setLocalError(null)
    if (globalThis.innerWidth > 680 && (panelWidth < 1080 || globalThis.innerWidth <= 1100)) {
      setContextCollapsed(true)
    }
  }, [panelWidth, sessions])

  const selectSession = useCallback((session: DataCopilotSession) => {
    const task = taskFromSession(session)
    selectedContextTaskRef.current = task
    setSelectedSessionId(session.id)
    setSelectedContextTask(task)
    setMobilePane('conversation')
  }, [])

  const acceptSnapshotUpgrade = useCallback((session: DataCopilotSession) => {
    setSessions((current) => mergeSession(current, session))
    setSelectedSessionId(session.id)
    const task = taskFromSession(session)
    selectedContextTaskRef.current = task
    setSelectedContextTask(task)
    setSelectedContextSourceIds(session.contextSourceIds?.length
      ? session.contextSourceIds
      : defaultTaskContextSourceIds(session.jobId || ''))
    setRunStatus(session.status || 'idle')
    setLocalError(null)
  }, [])

  const leaveContextTask = useCallback(() => {
    selectedContextTaskRef.current = null
    setSelectedContextTask(null)
  }, [])

  const updateSessionStatus = useCallback((sessionId: string, status: DataCopilotRunStatus) => {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? { ...session, status } : session)),
    )
  }, [])

  useEffect(() => {
    const selectedModelAvailable = models.some(
      (model) => model.id === modelId && !model.disabled,
    )
    if (!selectedModelAvailable && fallbackModelId) setModelId(fallbackModelId)
  }, [fallbackModelId, modelId, models])

  useEffect(() => {
    if (open) return
    loadedSessionIdsRef.current.clear()
    boundSessionIdRef.current = null
  }, [open])

  useEffect(() => {
    if (!selectedSession || boundSessionIdRef.current === selectedSession.id) return
    boundSessionIdRef.current = selectedSession.id
    setSelectedContextSourceIds(
      selectedSession.contextSourceIds ?? defaultContextSourceIds,
    )
    if (
      selectedSession.modelId &&
      models.some((model) => model.id === selectedSession.modelId && !model.disabled)
    ) {
      setModelId(selectedSession.modelId)
    }
  }, [defaultContextSourceIds, models, selectedSession])

  useEffect(() => {
    if (!open) return
    const requestId = ++listRequestRef.current
    setLoadingSessions(true)
    setLocalError(null)
    void transport
      .listSessions()
      .then((loadedSessions) => {
        if (requestId !== listRequestRef.current) return
        setSessions(loadedSessions)
        setSelectedSessionId((current) => {
          const activeTask = selectedContextTaskRef.current
          const currentSession = current
            ? loadedSessions.find((session) => session.id === current)
            : null
          if (activeTask) {
            if (currentSession && sessionMatchesTask(currentSession, activeTask)) return current
            return loadedSessions.find((session) => sessionMatchesTask(session, activeTask))?.id ?? null
          }
          if (currentSession) return current
          if (
            initialSessionId &&
            loadedSessions.some((session) => session.id === initialSessionId)
          ) {
            return initialSessionId
          }
          return loadedSessions[0]?.id ?? null
        })
      })
      .catch((error: unknown) => {
        if (requestId === listRequestRef.current) reportError(error)
      })
      .finally(() => {
        if (requestId === listRequestRef.current) setLoadingSessions(false)
      })
    return () => {
      listRequestRef.current += 1
    }
  }, [initialSessionId, open, reportError, transport])

  useEffect(() => {
    if (!open || !selectedSessionId || loadedSessionIdsRef.current.has(selectedSessionId)) return
    const requestId = ++messageRequestRef.current
    setLoadingMessages(true)
    void transport
      .loadMessages(selectedSessionId)
      .then((messages) => {
        if (requestId !== messageRequestRef.current) return
        loadedSessionIdsRef.current.add(selectedSessionId)
        setMessagesBySession((current) => ({ ...current, [selectedSessionId]: messages }))
      })
      .catch((error: unknown) => {
        if (requestId === messageRequestRef.current) reportError(error)
      })
      .finally(() => {
        if (requestId === messageRequestRef.current) setLoadingMessages(false)
      })
    return () => {
      messageRequestRef.current += 1
    }
  }, [open, reportError, selectedSessionId, transport])

  useEffect(() => {
    if (!open || !selectedSessionId || !transport.subscribe) return
    return transport.subscribe(selectedSessionId, {
      onMessage: (message) => {
        setMessagesBySession((current) => ({
          ...current,
          [selectedSessionId]: mergeMessages(current[selectedSessionId] ?? [], [message]),
        }))
      },
      onSession: (session) => setSessions((current) => mergeSession(current, session)),
      onStatus: (status) => {
        setRunStatus(status)
        updateSessionStatus(selectedSessionId, status)
      },
      onError: reportError,
    })
  }, [open, reportError, selectedSessionId, transport, updateSessionStatus])

  useEffect(() => {
    if (!selectedSessionId) return
    onSessionChange?.(selectedSessionId)
    setRunStatus(selectedSession?.status ?? 'idle')
  }, [onSessionChange, selectedSession?.status, selectedSessionId])

  useEffect(() => {
    if (!open) return
    const area = messageAreaRef.current
    if (!area || area.scrollHeight - area.scrollTop - area.clientHeight < 96) {
      messageEndRef.current?.scrollIntoView({ block: 'end' })
      setShowScrollToLatest(false)
    }
  }, [activeMessages.length, open, selectedSessionId])

  useEffect(() => {
    if (!open) return
    const timeoutId = window.setTimeout(() => composerRef.current?.focus(), 80)
    return () => window.clearTimeout(timeoutId)
  }, [open, selectedSessionId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (fullscreen) setFullscreen(false)
      else if (globalThis.innerWidth <= 680 && mobilePane !== 'conversation') setMobilePane('conversation')
      else if (!contextCollapsed) setContextCollapsed(true)
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [contextCollapsed, fullscreen, mobilePane, onClose, open])

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const origin = resizeRef.current
      if (!origin) return
      const delta = side === 'right' ? origin.x - event.clientX : event.clientX - origin.x
      const viewportLimit = Math.max(320, window.innerWidth)
      const nextWidth = Math.min(maxWidth, viewportLimit, Math.max(minWidth, origin.width + delta))
      setPanelWidth(nextWidth)
    }
    const onPointerUp = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [maxWidth, minWidth, side])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (fullscreen) return
    event.preventDefault()
    resizeRef.current = { x: event.clientX, width: panelWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const createSession = async () => {
    if (!modelId || creatingSession) return null
    if (!selectedContextTask) {
      reportError(new Error('请先从右侧历史采集记录中选择一个任务。'))
      setMobilePane('context')
      return null
    }
    setCreatingSession(true)
    setLocalError(null)
    try {
      const contextSourceIds = contextSourceIdsForTask(
        selectedContextSourceIds,
        selectedContextTask.id,
      )
      const session = await transport.createSession({
        modelId,
        contextSourceIds,
        jobId: selectedContextTask.id,
        mode: selectedContextTask.mode,
        snapshotId: selectedContextTask.snapshotId,
      })
      loadedSessionIdsRef.current.add(session.id)
      setSessions((current) => mergeSession(current, session))
      setMessagesBySession((current) => ({ ...current, [session.id]: [] }))
      setSelectedSessionId(session.id)
      setMobilePane('conversation')
      return session
    } catch (error) {
      reportError(error)
      return null
    } finally {
      setCreatingSession(false)
    }
  }

  const addFiles = (files: File[]) => {
    if (files.length === 0) return
    if (selectedModel?.supportsAttachments === false) {
      reportError(new Error(`${selectedModel.label} 不支持附件`))
      return
    }
    setLocalError(null)
    const fingerprints = new Set(
      pendingFiles.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`),
    )
    const accepted: PendingFile[] = []
    let validationError: Error | null = null
    for (const file of files) {
      if (pendingFiles.length + accepted.length >= maxFiles) {
        validationError = new Error(`单次最多上传 ${maxFiles} 个附件`)
        break
      }
      if (file.size > maxFileBytes) {
        validationError ??= new Error(`${file.name} 超过 ${fileSizeLabel(maxFileBytes)} 限制`)
        continue
      }
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
      if (fingerprints.has(fingerprint)) continue
      fingerprints.add(fingerprint)
      accepted.push({ id: createLocalId('pending-file'), file })
    }
    if (accepted.length > 0) setPendingFiles((current) => [...current, ...accepted])
    if (validationError) reportError(validationError)
  }

  const appendMessages = (sessionId: string, messages: DataCopilotMessageData[]) => {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: mergeMessages(current[sessionId] ?? [], messages),
    }))
  }

  const sendMessage = async (contentOverride?: string) => {
    const directAction = typeof contentOverride === 'string'
    const content = (directAction ? contentOverride : composerValue).trim()
    if (
      (!content && pendingFiles.length === 0) ||
      running ||
      !modelId ||
      sendInFlightRef.current
    ) return
    sendInFlightRef.current = true
    setSubmitting(true)
    const messageContent = content || '请分析这些附件。'
    setLocalError(null)

    let session = selectedSession
    if (
      session &&
      selectedContextTask &&
      !sessionMatchesTask(session, selectedContextTask)
    ) {
      session = null
    }
    if (!session) {
      session = await createSession()
      if (!session) {
        sendInFlightRef.current = false
        setSubmitting(false)
        return
      }
    }

    const filesToUpload = directAction ? [] : pendingFiles
    let attachments: DataCopilotAttachment[] = []
    if (filesToUpload.length > 0) {
      if (!transport.uploadAttachments) {
        reportError(new Error('当前 Data Copilot transport 尚未接入附件上传接口'))
        sendInFlightRef.current = false
        setSubmitting(false)
        return
      }
      try {
        attachments = await transport.uploadAttachments(
          session.id,
          filesToUpload.map(({ file }) => file),
        )
      } catch (error) {
        reportError(error)
        sendInFlightRef.current = false
        setSubmitting(false)
        return
      }
    }

    const now = new Date().toISOString()
    const optimisticMessage: DataCopilotMessageData = {
      id: createLocalId('user-message'),
      sessionId: session.id,
      role: 'user',
      kind: 'text',
      content: messageContent,
      createdAt: now,
      status: 'complete',
      attachments,
    }
    appendMessages(session.id, [optimisticMessage])
    if (!directAction) {
      setComposerValue('')
      setPendingFiles([])
    }
    const operationEpoch = ++operationEpochRef.current
    setRunStatus('planning')
    updateSessionStatus(session.id, 'planning')

    try {
      const contextSourceIds = contextSourceIdsForTask(
        selectedContextSourceIds,
        session.jobId || selectedContextTask?.id || '',
      )
      const result = await transport.sendMessage({
        sessionId: session.id,
        content: messageContent,
        modelId,
        workspaceMode,
        attachmentIds: attachments.map((attachment) => attachment.id),
        contextSourceIds,
      })
      if (operationEpoch !== operationEpochRef.current) return
      if (result.messages?.length) appendMessages(session.id, result.messages)
      if (result.session) setSessions((current) => mergeSession(current, result.session!))
      const acceptedStatus = result.session?.status ?? 'planning'
      setRunStatus(acceptedStatus)
      updateSessionStatus(session.id, acceptedStatus)
    } catch (error) {
      if (operationEpoch !== operationEpochRef.current) return
      const normalized = reportError(error)
      appendMessages(session.id, [
        {
          id: createLocalId('error-message'),
          sessionId: session.id,
          role: 'assistant',
          kind: 'error',
          content: normalized.message,
          createdAt: new Date().toISOString(),
          status: 'failed',
          retryable: true,
        },
      ])
      setRunStatus('failed')
      updateSessionStatus(session.id, 'failed')
    } finally {
      sendInFlightRef.current = false
      setSubmitting(false)
    }
  }

  const stopGeneration = async () => {
    if (!selectedSessionId || !transport.stopGeneration || !running) return
    const operationEpoch = ++operationEpochRef.current
    setRunStatus('stopping')
    updateSessionStatus(selectedSessionId, 'stopping')
    try {
      await transport.stopGeneration(selectedSessionId)
      if (operationEpoch !== operationEpochRef.current) return
      setRunStatus('cancelled')
      updateSessionStatus(selectedSessionId, 'cancelled')
    } catch (error) {
      if (operationEpoch !== operationEpochRef.current) return
      reportError(error)
      setRunStatus('failed')
      updateSessionStatus(selectedSessionId, 'failed')
    }
  }

  const retryMessage = async (message: DataCopilotMessageData) => {
    if (!selectedSessionId || !transport.retryMessage || running) return
    const operationEpoch = ++operationEpochRef.current
    setLocalError(null)
    setRunStatus('executing')
    updateSessionStatus(selectedSessionId, 'executing')
    try {
      const result = await transport.retryMessage(selectedSessionId, message.id)
      if (operationEpoch !== operationEpochRef.current) return
      if (result.messages?.length) appendMessages(selectedSessionId, result.messages)
      if (result.session) setSessions((current) => mergeSession(current, result.session!))
      const acceptedStatus = result.session?.status ?? 'executing'
      setRunStatus(acceptedStatus)
      updateSessionStatus(selectedSessionId, acceptedStatus)
    } catch (error) {
      if (operationEpoch !== operationEpochRef.current) return
      reportError(error)
      setRunStatus('failed')
      updateSessionStatus(selectedSessionId, 'failed')
    }
  }

  const confirmApproval = async (message: DataCopilotMessageData, approved: boolean) => {
    const approval = message.approval
    if (!selectedSessionId || !approval || !transport.confirmApproval) return
    if (running && effectiveStatus !== 'waiting_approval') return
    const operationEpoch = ++operationEpochRef.current
    setLocalError(null)
    const nextStatus: DataCopilotRunStatus = approved ? 'executing' : 'paused'
    setRunStatus(nextStatus)
    updateSessionStatus(selectedSessionId, nextStatus)
    setMessagesBySession((current) => ({
      ...current,
      [selectedSessionId]: (current[selectedSessionId] ?? []).map((item) =>
        item.id === message.id && item.approval
          ? {
              ...item,
              approval: {
                ...item.approval,
                status: approved ? 'approved' : 'rejected',
              },
            }
          : item,
      ),
    }))
    try {
      const result = await transport.confirmApproval(selectedSessionId, approval.id, approved)
      if (operationEpoch !== operationEpochRef.current) return
      if (result.messages?.length) appendMessages(selectedSessionId, result.messages)
      if (result.session) setSessions((current) => mergeSession(current, result.session!))
      const acceptedStatus = approved ? (result.session?.status ?? nextStatus) : 'paused'
      setRunStatus(acceptedStatus)
      updateSessionStatus(selectedSessionId, acceptedStatus)
    } catch (error) {
      if (operationEpoch !== operationEpochRef.current) return
      reportError(error)
      setMessagesBySession((current) => ({
        ...current,
        [selectedSessionId]: (current[selectedSessionId] ?? []).map((item) =>
          item.id === message.id && item.approval
            ? { ...item, approval: { ...item.approval, status: 'pending' } }
            : item,
        ),
      }))
      setRunStatus('waiting_approval')
      updateSessionStatus(selectedSessionId, 'waiting_approval')
    }
  }

  const deleteSession = async (session: DataCopilotSession) => {
    if (!transport.deleteSession || running) return
    try {
      await transport.deleteSession(session.id)
      setSessions((current) => current.filter((item) => item.id !== session.id))
      setMessagesBySession((current) => {
        const next = { ...current }
        delete next[session.id]
        return next
      })
      loadedSessionIdsRef.current.delete(session.id)
      if (selectedSessionId === session.id) {
        const replacement = sessions.find((item) => item.id !== session.id)
        setSelectedSessionId(replacement?.id ?? null)
      }
    } catch (error) {
      reportError(error)
    }
  }

  const toggleContextSource = (sourceId: string) => {
    if (running || submitting) return
    setSelectedContextSourceIds((current) => {
      if (current.includes(sourceId)) return current.filter((id) => id !== sourceId)
      const isAggregate = sourceId.startsWith('dataset:') || sourceId.startsWith('job:')
      let next = isAggregate
        ? current.filter((id) => sourceId.startsWith('job:') ? !id.startsWith('xhs-context://') : !aggregateOwnsRecord(sourceId, id))
        : current.filter((id) => !id.startsWith('job:') && !aggregateOwnsRecord(id, sourceId))
      if (!isAggregate) {
        const selectedRecord = recordContextIdentity(sourceId)
        if (selectedRecord) {
          next = next.filter((id) => {
            const existingRecord = recordContextIdentity(id)
            if (!existingRecord || existingRecord.record !== selectedRecord.record) return true
            return selectedRecord.section !== 'record' && existingRecord.section !== 'record'
          })
        }
      }
      if (next.length >= 100) {
        reportError(new Error('每轮最多选择 100 项数据上下文，请先移除不需要的记录。'))
        return current
      }
      return [...next, sourceId]
    })
  }

  const insertShortcut = (prompt: string) => {
    if (running || submitting) return
    setComposerValue((current) => current.trim() ? `${prompt}\n${current}` : prompt)
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }

  const openContextPane = () => {
    if (globalThis.innerWidth <= 680) setMobilePane('context')
    else setContextCollapsed(false)
  }

  const scrollToLatest = () => {
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    setShowScrollToLatest(false)
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDraggingFiles(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const openAttachment = (attachment: DataCopilotAttachment) => {
    if (onOpenAttachment) onOpenAttachment(attachment)
    else if (attachment.url) window.open(attachment.url, '_blank', 'noopener,noreferrer')
  }

  if (!open) return null

  const railWidth = panelWidth < 1100 ? 220 : 244
  const contextWidth = panelWidth < 1180 ? 320 : 360
  const compactWorkspace = !fullscreen && panelWidth < 1080
  const panelPosition: CSSProperties = fullscreen
    ? { inset: 0, width: '100vw' }
    : { top: 0, bottom: 0, [side]: 0, width: panelWidth, maxWidth: '100vw' }
  const runtimeContext = {
    sessionId: selectedSessionId,
    modelId,
    selectedContextSourceIds,
    runStatus: effectiveStatus,
  }

  return (
    <DataCopilotContextProvider value={runtimeContext}>
      <section
        className="data-copilot-panel"
        data-mobile-pane={mobilePane}
        data-compact={compactWorkspace}
        data-sessions-collapsed={sessionsCollapsed}
        data-context-collapsed={contextCollapsed}
        style={{ ...panelStyles.panel, ...panelPosition }}
        aria-label={title}
        aria-modal="true"
        role="dialog"
      >
        <style>{`
          @keyframes data-copilot-spin{to{transform:rotate(360deg)}}
          .data-copilot-mobile-nav{display:none!important}
          .data-copilot-context-scrim{display:none}
          .data-copilot-session-rail{grid-column:1}
          .data-copilot-conversation{grid-column:2}
          .data-copilot-panel[data-sessions-collapsed="true"] .data-copilot-session-rail{display:none!important}
          .data-copilot-panel[data-sessions-collapsed="true"] .data-copilot-conversation{grid-column:1 / 3}
          .data-copilot-panel[data-context-collapsed="true"] .data-copilot-context-pane{display:none!important}
          .data-copilot-panel[data-compact="true"] .data-copilot-workspace{grid-template-columns:var(--copilot-rail-track) minmax(0,1fr)!important;position:relative}
          .data-copilot-panel[data-compact="true"] .data-copilot-context-pane{position:absolute!important;z-index:6;top:0;right:0;bottom:0;width:min(420px,calc(100% - 56px));box-shadow:-12px 0 30px rgba(28,38,33,.13)}
          .data-copilot-panel[data-compact="true"]:not([data-context-collapsed="true"]) .data-copilot-context-scrim{display:block;position:absolute;z-index:5;inset:0;border:0;background:rgba(32,37,34,.16);cursor:pointer}
          @media(max-width:1100px){
            .data-copilot-workspace{grid-template-columns:var(--copilot-rail-track) minmax(0,1fr)!important;position:relative}
            .data-copilot-context-pane{position:absolute!important;z-index:6;top:0;right:0;bottom:0;width:min(420px,calc(100% - 56px));box-shadow:-12px 0 30px rgba(28,38,33,.13)}
            .data-copilot-panel:not([data-context-collapsed="true"]) .data-copilot-context-scrim{display:block;position:absolute;z-index:5;inset:0;border:0;background:rgba(32,37,34,.16);cursor:pointer}
          }
          @media(max-width:680px){
            .data-copilot-panel{width:100vw!important;max-width:100vw!important}
            .data-copilot-resize-handle{display:none!important}
            .data-copilot-brand-text{display:none!important}
            .data-copilot-mobile-nav{display:grid!important}
            .data-copilot-desktop-pane-button{display:none!important}
            .data-copilot-model-select{width:100px!important}
            .data-copilot-fullscreen-button{display:none!important}
            .data-copilot-workspace{grid-template-columns:minmax(0,1fr)!important}
            .data-copilot-context-scrim{display:none!important}
            .data-copilot-session-rail,
            .data-copilot-conversation,
            .data-copilot-context-pane{display:none!important;grid-column:1!important;position:static!important;width:auto;box-shadow:none}
            .data-copilot-panel[data-mobile-pane="sessions"] .data-copilot-session-rail{display:flex!important}
            .data-copilot-panel[data-mobile-pane="conversation"] .data-copilot-conversation{display:grid!important}
            .data-copilot-panel[data-mobile-pane="context"] .data-copilot-context-pane{display:flex!important}
            .data-copilot-model-dialog-body{grid-template-columns:minmax(0,1fr)!important}
            .data-copilot-model-dialog-body > *{grid-column:1!important}
            .data-copilot-conversation-header-status{display:none!important}
          }
          @media(max-width:380px){
            .data-copilot-model-select{width:86px!important}
          }
        `}</style>
        {!fullscreen ? (
          <div
            className="data-copilot-resize-handle"
            onPointerDown={startResize}
            title="拖拽调整宽度"
            aria-hidden="true"
            style={{
              ...panelStyles.resizeHandle,
              ...(side === 'right' ? panelStyles.resizeHandleLeft : panelStyles.resizeHandleRight),
            }}
          />
        ) : null}

        <header style={panelStyles.header}>
          <div style={panelStyles.brand}>
            <span style={panelStyles.brandIcon}>
              <Bot size={17} aria-hidden="true" />
            </span>
            <div className="data-copilot-brand-text" style={panelStyles.brandText}>
              <strong style={panelStyles.title}>{title}</strong>
              <span style={panelStyles.subtitle}>
                {selectedSession?.title ?? (selectedContextTask ? `${selectedContextTask.title} · 新会话` : '请选择历史采集任务')} · {effectiveStatus}
              </span>
            </div>
          </div>

          <div style={panelStyles.headerActions}>
            <button
              type="button"
              onClick={() => setQualityOpen(true)}
              disabled={!selectedSession || !transport.loadQuality}
              title="运行与质量"
              aria-label="打开运行与质量"
              style={panelStyles.headerButton}
            >
              <Gauge size={17} aria-hidden="true" />
            </button>
            <div className="data-copilot-mobile-nav" style={panelStyles.mobileNav}>
              {([
                ['sessions', '显示会话列表', <MessageSquareText key="sessions" size={15} aria-hidden="true" />],
                ['conversation', '显示对话', <Bot key="conversation" size={15} aria-hidden="true" />],
                ['context', '显示数据上下文', <Database key="context" size={15} aria-hidden="true" />],
              ] as const).map(([pane, label, icon]) => (
                <button
                  key={pane}
                  type="button"
                  aria-label={label}
                  aria-pressed={mobilePane === pane}
                  onClick={() => setMobilePane(pane)}
                  style={{
                    ...panelStyles.mobileNavButton,
                    ...(mobilePane === pane ? panelStyles.mobileNavButtonActive : undefined),
                  }}
                >
                  {icon}
                </button>
              ))}
            </div>
            <button
              className="data-copilot-desktop-pane-button"
              type="button"
              onClick={() => setSessionsCollapsed((value) => !value)}
              title={sessionsCollapsed ? '展开会话列表' : '收起会话列表'}
              aria-label={sessionsCollapsed ? '展开会话列表' : '收起会话列表'}
              aria-pressed={!sessionsCollapsed}
              style={panelStyles.headerButton}
            >
              {sessionsCollapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
            </button>
            <button
              className="data-copilot-desktop-pane-button"
              type="button"
              onClick={() => setContextCollapsed((value) => !value)}
              title={contextCollapsed ? '展开数据上下文' : '收起数据上下文'}
              aria-label={contextCollapsed ? '展开数据上下文' : '收起数据上下文'}
              aria-pressed={!contextCollapsed}
              style={panelStyles.headerButton}
            >
              {contextCollapsed ? <PanelRightOpen size={17} aria-hidden="true" /> : <PanelRightClose size={17} aria-hidden="true" />}
            </button>
            {models.length ? (
              <div style={panelStyles.modelControl}>
                <label style={panelStyles.modelSelectLabel}>
                  <span style={panelStyles.visuallyHidden}>模型</span>
                  <select
                    className="data-copilot-model-select"
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={running || submitting}
                    title="选择模型"
                    style={panelStyles.modelSelect}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id} disabled={model.disabled}>
                        {model.label}{model.provider ? ` · ${model.provider}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {onConnectModel ? (
                  <button
                    type="button"
                    onClick={openModelConnector}
                    title="连接或更换 AI 模型"
                    aria-label="连接或更换 AI 模型"
                    style={panelStyles.modelSettingsButton}
                  >
                    <PlugZap size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={openModelConnector}
                disabled={!onConnectModel || modelProviders.length === 0}
                style={panelStyles.connectModelButton}
              >
                <PlugZap size={15} aria-hidden="true" />
                连接 AI 模型
              </button>
            )}
            {running && transport.stopGeneration ? (
              <button
                type="button"
                onClick={() => void stopGeneration()}
                disabled={effectiveStatus === 'stopping'}
                title="停止生成"
                aria-label="停止生成"
                style={panelStyles.headerButton}
              >
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              title="折叠"
              aria-label="折叠 Data Copilot"
              style={panelStyles.headerButton}
            >
              <PanelRightClose size={17} aria-hidden="true" />
            </button>
            <button
              className="data-copilot-fullscreen-button"
              type="button"
              onClick={() => setFullscreen((value) => !value)}
              title={fullscreen ? '退出全屏' : '全屏'}
              aria-label={fullscreen ? '退出全屏' : '全屏'}
              style={panelStyles.headerButton}
            >
              {fullscreen ? (
                <Minimize2 size={16} aria-hidden="true" />
              ) : (
                <Maximize2 size={16} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭 Data Copilot"
              style={panelStyles.headerButton}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        {modelConnectorOpen ? (
          <div
            role="presentation"
            style={panelStyles.modelDialogScrim}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !modelConnectorBusy) setModelConnectorOpen(false)
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="data-copilot-model-dialog-title"
              style={panelStyles.modelDialog}
            >
              <header style={panelStyles.modelDialogHeader}>
                <div style={panelStyles.modelDialogHeading}>
                  <span style={panelStyles.modelDialogIcon}><PlugZap size={18} aria-hidden="true" /></span>
                  <span>
                    <strong id="data-copilot-model-dialog-title" style={panelStyles.modelDialogTitle}>连接 AI 模型</strong>
                    <small style={panelStyles.modelDialogSubtitle}>配置仅用于本机模型会话，不会写入对话消息。</small>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setModelConnectorOpen(false)}
                  disabled={Boolean(modelConnectorBusy)}
                  title="关闭模型连接"
                  aria-label="关闭模型连接"
                  style={panelStyles.headerButton}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </header>

              <div className="data-copilot-model-dialog-body" style={panelStyles.modelDialogBody}>
                <label style={panelStyles.modelField}>
                  <span style={panelStyles.modelFieldLabel}>提供方</span>
                  <select
                    aria-label="AI 提供方"
                    value={modelDraft.provider}
                    onChange={(event) => selectModelProvider(event.target.value as AiProviderOption['id'])}
                    disabled={Boolean(modelConnectorBusy)}
                    style={panelStyles.modelFieldControl}
                  >
                    {modelProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.label}</option>
                    ))}
                  </select>
                </label>

                <label style={{ ...panelStyles.modelField, ...panelStyles.modelFieldWide }}>
                  <span style={panelStyles.modelFieldLabel}><Link2 size={13} aria-hidden="true" />API Base URL</span>
                  <input
                    aria-label="API Base URL"
                    value={modelDraft.baseUrl}
                    onChange={(event) => {
                      setModelDraft((current) => ({ ...current, baseUrl: event.target.value, models: [] }))
                      setModelConnectorStatus(null)
                    }}
                    disabled={Boolean(modelConnectorBusy)}
                    placeholder="https://gateway.example/v1"
                    spellCheck={false}
                    style={panelStyles.modelFieldControl}
                  />
                </label>

                <label style={{ ...panelStyles.modelField, ...panelStyles.modelFieldWide }}>
                  <span style={panelStyles.modelFieldLabel}><KeyRound size={13} aria-hidden="true" />API Key</span>
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="off"
                    value={modelDraft.apiKey}
                    onChange={(event) => {
                      setModelDraft((current) => ({ ...current, apiKey: event.target.value }))
                      setModelConnectorStatus(null)
                    }}
                    disabled={Boolean(modelConnectorBusy) || modelDraftProvider?.requiresKey === false}
                    placeholder={modelDraftProvider?.requiresKey === false
                      ? '当前提供方无需 API Key'
                      : modelDraftProvider?.hasApiKey
                        ? '已保存，留空即可复用'
                        : '输入模型服务 API Key'}
                    style={panelStyles.modelFieldControl}
                  />
                </label>

                <label style={panelStyles.modelField}>
                  <span style={panelStyles.modelFieldLabel}>协议</span>
                  <select
                    aria-label="AI 接口协议"
                    value={modelDraft.wireApi}
                    onChange={(event) => setModelDraft((current) => ({
                      ...current,
                      wireApi: event.target.value as 'responses' | 'chat_completions',
                    }))}
                    disabled={Boolean(modelConnectorBusy)}
                    style={panelStyles.modelFieldControl}
                  >
                    <option value="chat_completions">Chat Completions</option>
                    <option value="responses">Responses API</option>
                  </select>
                </label>

                <label style={{ ...panelStyles.modelField, ...panelStyles.modelFieldWide }}>
                  <span style={panelStyles.modelFieldLabel}>模型 ID</span>
                  <input
                    aria-label="模型 ID"
                    list="data-copilot-model-options"
                    value={modelDraft.model}
                    onChange={(event) => setModelDraft((current) => ({ ...current, model: event.target.value }))}
                    disabled={Boolean(modelConnectorBusy)}
                    placeholder="检测后选择，或直接填写模型 ID"
                    spellCheck={false}
                    style={panelStyles.modelFieldControl}
                  />
                  <datalist id="data-copilot-model-options">
                    {modelDraft.models.map((model) => <option key={model} value={model} />)}
                  </datalist>
                </label>

                {modelConnectorStatus ? (
                  <div
                    role={modelConnectorStatus.tone === 'error' ? 'alert' : 'status'}
                    style={{
                      ...panelStyles.modelStatus,
                      ...(modelConnectorStatus.tone === 'success' ? panelStyles.modelStatusSuccess : undefined),
                      ...(modelConnectorStatus.tone === 'error' ? panelStyles.modelStatusError : undefined),
                    }}
                  >
                    {modelConnectorStatus.tone === 'success'
                      ? <CheckCircle2 size={15} aria-hidden="true" />
                      : modelConnectorStatus.tone === 'error'
                        ? <AlertCircle size={15} aria-hidden="true" />
                        : <LoaderCircle size={15} aria-hidden="true" style={panelStyles.spinningIcon} />}
                    <span>{modelConnectorStatus.message}</span>
                  </div>
                ) : (
                  <p style={panelStyles.modelHint}>更换 Base URL 后需要重新输入 Key。检测模型会验证地址、凭据和兼容协议。</p>
                )}
              </div>

              <footer style={panelStyles.modelDialogFooter}>
                <button
                  type="button"
                  onClick={() => void discoverModels()}
                  disabled={Boolean(modelConnectorBusy)
                    || !onDiscoverModels
                    || !modelDraft.baseUrl.trim()
                    || Boolean(modelDraftProvider?.requiresKey && !modelDraftProvider.hasApiKey && !modelDraft.apiKey.trim())}
                  style={panelStyles.secondaryActionButton}
                >
                  {modelConnectorBusy === 'discover'
                    ? <LoaderCircle size={15} aria-hidden="true" style={panelStyles.spinningIcon} />
                    : <RefreshCw size={15} aria-hidden="true" />}
                  检测模型
                </button>
                <button
                  type="button"
                  onClick={() => void connectModel()}
                  disabled={Boolean(modelConnectorBusy) || !onConnectModel}
                  style={panelStyles.primaryActionButton}
                >
                  {modelConnectorBusy === 'connect'
                    ? <LoaderCircle size={15} aria-hidden="true" style={panelStyles.spinningIcon} />
                    : <PlugZap size={15} aria-hidden="true" />}
                  连接并使用
                </button>
              </footer>
            </section>
          </div>
        ) : null}

        <DataCopilotQualityPanel
          open={qualityOpen}
          session={selectedSession}
          messages={activeMessages}
          transport={transport}
          onClose={() => setQualityOpen(false)}
          onUpgrade={acceptSnapshotUpgrade}
        />

        <div
          className="data-copilot-workspace"
          style={{
            ...panelStyles.workspace,
            '--copilot-rail-track': sessionsCollapsed ? '0px' : `${railWidth}px`,
            '--copilot-context-track': contextCollapsed ? '0px' : `${contextWidth}px`,
            gridTemplateColumns: 'var(--copilot-rail-track) minmax(380px, 1fr) var(--copilot-context-track)',
          } as CSSProperties}
        >
          <aside
            className="data-copilot-session-rail"
            style={panelStyles.sessionRail}
            aria-label="Data Copilot 会话"
          >
            <div style={panelStyles.sessionRailHeader}>
              <strong style={panelStyles.sectionHeading}>会话</strong>
              <button
                type="button"
                onClick={() => void createSession()}
                disabled={creatingSession || running || submitting || !modelId || !selectedContextTask}
                title="新建会话"
                aria-label="新建会话"
                style={panelStyles.smallIconButton}
              >
                {creatingSession ? (
                  <LoaderCircle size={15} style={panelStyles.spinningIcon} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
              </button>
            </div>
            <label style={panelStyles.sessionSearch}>
              <Search size={14} aria-hidden="true" />
              <input
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话"
                aria-label="搜索会话"
                style={panelStyles.sessionSearchInput}
              />
            </label>
            <div style={panelStyles.sessionList}>
              {loadingSessions ? (
                <div style={panelStyles.centerState}>
                  <LoaderCircle size={16} style={panelStyles.spinningIcon} aria-hidden="true" />
                  正在读取
                </div>
              ) : filteredSessions.length === 0 ? (
                <div style={panelStyles.centerState}>暂无会话</div>
              ) : (
                filteredSessions.map((session) => {
                  const selected = session.id === selectedSessionId
                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      key={session.id}
                      onClick={() => selectSession(session)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectSession(session)
                        }
                      }}
                      aria-current={selected ? 'true' : undefined}
                      style={{
                        ...panelStyles.sessionItem,
                        ...(selected ? panelStyles.sessionItemSelected : undefined),
                      }}
                    >
                      <span style={panelStyles.sessionIcon}>
                        <MessageSquareText size={14} aria-hidden="true" />
                      </span>
                      <span style={panelStyles.sessionBody}>
                        <span style={panelStyles.sessionTitle}>{session.title}</span>
                        <span style={panelStyles.sessionPreview}>
                          {session.preview || `${session.messageCount} 条消息`}
                        </span>
                      </span>
                      <span style={panelStyles.sessionTail}>
                        <span>{formatSessionTime(session.updatedAt)}</span>
                        {transport.deleteSession ? (
                          <button
                            type="button"
                            aria-label={`删除${session.title}`}
                            title="删除会话"
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteSession(session)
                            }}
                            style={panelStyles.deleteSessionButton}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </aside>

          <main className="data-copilot-conversation" style={panelStyles.conversation}>
            <div style={panelStyles.conversationHeader}>
              <div style={panelStyles.conversationMeta}>
                <strong style={panelStyles.conversationTitle}>
                  {selectedSession?.title ?? (selectedContextTask ? `${selectedContextTask.title} · 新会话` : '请选择历史采集任务')}
                </strong>
                <span>
                  {selectedContextSourceIds.length} 个数据源 · {activeMessages.length} 条消息
                </span>
              </div>
              <div style={panelStyles.conversationHeaderActions}>
                <button
                  type="button"
                  onClick={() => void createSession()}
                  disabled={creatingSession || running || submitting || !modelId || !selectedContextTask}
                  title="新建会话"
                  aria-label="新建会话"
                  style={panelStyles.conversationIconButton}
                >
                  {creatingSession
                    ? <LoaderCircle size={14} style={panelStyles.spinningIcon} aria-hidden="true" />
                    : <Plus size={15} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (globalThis.innerWidth <= 680) {
                      setMobilePane('context')
                    } else {
                      setContextCollapsed((value) => !value)
                    }
                  }}
                  aria-label={contextCollapsed ? '展开数据上下文' : '收起数据上下文'}
                  style={panelStyles.contextToggleButton}
                >
                  <Database size={14} aria-hidden="true" />
                  数据 {selectedContextSourceIds.length}
                </button>
                <div className="data-copilot-conversation-header-status" style={panelStyles.statusIndicator}>
                  <span
                    style={{
                      ...panelStyles.statusDot,
                      ...(running ? panelStyles.statusDotRunning : undefined),
                      ...(effectiveStatus === 'failed' ? panelStyles.statusDotFailed : undefined),
                    }}
                  />
                  {effectiveStatus}
                </div>
              </div>
            </div>

            <AgentWorkbench
              projection={workbenchProjection}
              sourceCount={selectedContextSourceIds.length}
              onCancel={running && transport.stopGeneration
                ? () => { void stopGeneration() }
                : undefined}
            />

            {(selectedContextTask?.mode ?? selectedSession?.mode) === 'application' && (selectedContextTask?.id || selectedSession?.jobId) ? (
              <ApplicationWorkflowSummary
                jobId={selectedContextTask?.id || selectedSession?.jobId || ''}
                onPrepare={() => insertShortcut('为当前任务执行批量投递准备：逐岗位核对收件人、邮件主题、正文质量和附件最终文件名；先做 Dry Run 和附件说明，不发送邮件。')}
              />
            ) : null}

            <div style={panelStyles.messageStage}>
              <div
                ref={messageAreaRef}
                style={panelStyles.messageArea}
                aria-live="polite"
                onScroll={(event) => {
                  const area = event.currentTarget
                  setShowScrollToLatest(area.scrollHeight - area.scrollTop - area.clientHeight > 140)
                }}
              >
                {loadingMessages ? (
                <div style={panelStyles.emptyConversation}>
                  <LoaderCircle size={19} style={panelStyles.spinningIcon} aria-hidden="true" />
                  正在读取消息
                </div>
              ) : activeMessages.length === 0 ? (
                <div style={panelStyles.emptyConversation}>
                  <span style={panelStyles.emptyIcon}>
                    <Sparkles size={20} aria-hidden="true" />
                  </span>
                  <strong style={panelStyles.emptyTitle}>{selectedContextTask ? selectedContextTask.title : '先选择历史采集任务'}</strong>
                  <span>{selectedContextTask ? `${selectedContextSourceIds.length} 个数据源已连接` : '从数据上下文中打开一条历史记录'}</span>
                  {selectedContextTask ? (
                    <div style={panelStyles.starterGrid} aria-label="常用操作">
                      {(selectedContextTask.mode === 'application' ? [
                        { label: '筛选可投递岗位', prompt: '结合当前任务全部岗位原帖、招聘要求和已有资料，筛选仍可投递的岗位并按匹配度排序。', icon: <Search size={15} aria-hidden="true" /> },
                        { label: '生成投递邮件', prompt: '基于当前选中岗位的原帖、招聘要求和候选人资料，撰写自然、具体的投递邮件。', icon: <Mail size={15} aria-hidden="true" /> },
                        { label: '核对标题要求', prompt: '逐条检查当前任务所有岗位原帖中的招聘邮箱、邮件标题格式和附件命名要求，完整列出每个岗位，并报告已扫描、已命中和缺失数量。', icon: <FileText size={15} aria-hidden="true" /> },
                        { label: '汇总岗位要求', prompt: '汇总并对比当前任务中全部岗位的职责、要求、地点、邮箱和截止信息。', icon: <BriefcaseBusiness size={15} aria-hidden="true" /> },
                      ] : [
                        { label: '总结核心洞察', prompt: '结合原帖、评论和用户资料，总结当前任务最重要的内容洞察，并给出证据引用。', icon: <Sparkles size={15} aria-hidden="true" /> },
                        { label: '对比原帖观点', prompt: '对比当前任务中各原帖的观点、证据和分歧，整理为结构化结论。', icon: <FileText size={15} aria-hidden="true" /> },
                        { label: '分析评论人群', prompt: '结合评论内容和评论用户资料，分析主要人群、需求、情绪和高频问题。', icon: <Users size={15} aria-hidden="true" /> },
                        { label: '整理可引用证据', prompt: '从当前任务的原帖和评论中整理可引用的关键证据，并标明来源。', icon: <MessageSquareText size={15} aria-hidden="true" /> },
                      ]).map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          onClick={() => insertShortcut(action.prompt)}
                          style={panelStyles.starterButton}
                        >
                          {action.icon}
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                ) : (
                  activeMessages.map((message) => (
                  <DataCopilotMessage
                    key={message.id}
                    message={message}
                    onRetry={transport.retryMessage ? retryMessage : undefined}
                    onOpenAttachment={openAttachment}
                    onOpenCitation={onOpenCitation}
                    onApproval={transport.confirmApproval ? confirmApproval : undefined}
                    onAction={(prompt) => void sendMessage(prompt)}
                    jobId={selectedSession?.jobId || selectedContextTask?.id}
                    busy={running}
                    approvalBusy={running && effectiveStatus !== 'waiting_approval'}
                  />
                  ))
                )}
                <div ref={messageEndRef} />
              </div>
              {showScrollToLatest ? (
                <button
                  type="button"
                  onClick={scrollToLatest}
                  title="回到最新消息"
                  aria-label="回到最新消息"
                  style={panelStyles.scrollToLatestButton}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div
              style={{
                ...panelStyles.composerZone,
                ...(draggingFiles ? panelStyles.composerZoneDragging : undefined),
              }}
              onDragEnter={(event) => {
                event.preventDefault()
                setDraggingFiles(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDraggingFiles(false)
                }
              }}
              onDrop={handleDrop}
            >
              {draggingFiles ? (
                <div style={panelStyles.dropOverlay}>
                  <UploadCloud size={21} aria-hidden="true" />
                  松开以上传附件
                </div>
              ) : null}
              {localError ? (
                <div style={panelStyles.errorBanner} role="alert">
                  <AlertCircle size={14} aria-hidden="true" />
                  <span>{localError}</span>
                  <button
                    type="button"
                    onClick={() => setLocalError(null)}
                    aria-label="关闭错误提示"
                    style={panelStyles.dismissError}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {pendingFiles.length ? (
                <div style={panelStyles.pendingFiles} aria-label="待上传附件">
                  {pendingFiles.map(({ id, file }) => (
                    <div key={id} style={panelStyles.pendingFile}>
                      <Paperclip size={13} aria-hidden="true" />
                      <span style={panelStyles.pendingFileName}>{file.name}</span>
                      <span style={panelStyles.pendingFileSize}>{fileSizeLabel(file.size)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingFiles((current) => current.filter((item) => item.id !== id))
                        }
                        title="移除附件"
                        aria-label={`移除${file.name}`}
                        style={panelStyles.removePendingFile}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={panelStyles.composer}>
                <div style={panelStyles.shortcutBar} aria-label="快捷指令">
                  {((selectedContextTask?.mode ?? selectedSession?.mode) === 'application' ? [
                    {
                      label: '写投递邮件',
                      prompt: '为当前选中的岗位撰写投递邮件，结合岗位要求和候选人资料，并使用原帖中的招聘邮箱。',
                      icon: <BriefcaseBusiness size={12} aria-hidden="true" />,
                    },
                    {
                      label: '批量核对格式',
                      prompt: '逐条提取当前任务全部岗位的招聘邮箱、邮件标题或主题格式要求和附件命名要求；一个岗位一行，并报告总数、已扫描数、命中数和缺失数，不要只返回第一条。',
                      icon: <Mail size={12} aria-hidden="true" />,
                    },
                    {
                      label: '发送邮件',
                      prompt: '预览并发送当前岗位的投递邮件。先核对招聘邮箱、邮件标题、正文和附件，等待我确认后再发送。',
                      icon: <Send size={12} aria-hidden="true" />,
                    },
                  ] : [
                    {
                      label: '总结洞察',
                      prompt: '结合当前任务的原帖、评论和用户资料，总结核心洞察并标明证据来源。',
                      icon: <Sparkles size={12} aria-hidden="true" />,
                    },
                    {
                      label: '对比观点',
                      prompt: '对比当前任务各原帖的观点、证据和分歧，输出结构化结论。',
                      icon: <FileText size={12} aria-hidden="true" />,
                    },
                    {
                      label: '分析人群',
                      prompt: '结合评论内容与用户资料，分析主要人群、需求、情绪和高频问题。',
                      icon: <Users size={12} aria-hidden="true" />,
                    },
                  ]).map((shortcut) => (
                    <button
                      key={shortcut.label}
                      type="button"
                      onClick={() => insertShortcut(shortcut.prompt)}
                      disabled={running || submitting}
                      style={panelStyles.shortcutButton}
                    >
                      {shortcut.icon}
                      {shortcut.label}
                    </button>
                  ))}
                </div>
                <textarea
                  ref={composerRef}
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="询问任务、帖子、评论、用户或附件中的数据"
                  aria-label="发送给 Data Copilot"
                  rows={3}
                  disabled={effectiveStatus === 'stopping'}
                  style={panelStyles.textarea}
                />
                <div style={panelStyles.composerToolbar}>
                  <div style={panelStyles.composerTools}>
                    <div style={panelStyles.modeControl} role="group" aria-label="工作模式">
                      {([
                        { id: 'ask', label: '提问' },
                        { id: 'analyze', label: '分析' },
                        { id: 'build', label: '构建' },
                      ] as const).map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setWorkspaceMode(mode.id)}
                          aria-pressed={workspaceMode === mode.id}
                          disabled={running || submitting}
                          title={`${mode.label}模式`}
                          style={{
                            ...panelStyles.modeButton,
                            ...(workspaceMode === mode.id ? panelStyles.modeButtonActive : undefined),
                          }}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={acceptedFileTypes}
                      onChange={(event) => {
                        addFiles(Array.from(event.target.files ?? []))
                        event.currentTarget.value = ''
                      }}
                      style={panelStyles.hiddenInput}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={
                        running ||
                        submitting ||
                        selectedModel?.supportsAttachments === false ||
                        pendingFiles.length >= maxFiles
                      }
                      title="上传附件"
                      aria-label="上传附件"
                      style={panelStyles.composerIconButton}
                    >
                      <Paperclip size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={openContextPane}
                      disabled={running || submitting}
                      title="选择数据上下文"
                      aria-label={`选择数据上下文，已选 ${selectedContextSourceIds.length} 项`}
                      style={panelStyles.contextCountButton}
                    >
                      {selectedContextSourceIds.length > 0 ? (
                        <CheckCircle2 size={13} aria-hidden="true" />
                      ) : null}
                      {selectedContextSourceIds.length} 个上下文
                    </button>
                  </div>
                  {running ? (
                    <button
                      type="button"
                      onClick={() => void stopGeneration()}
                      disabled={!transport.stopGeneration || effectiveStatus === 'stopping'}
                      title="停止生成"
                      style={panelStyles.stopButton}
                    >
                      <Square size={12} fill="currentColor" aria-hidden="true" />
                      停止
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={
                        (!composerValue.trim() && pendingFiles.length === 0) ||
                        !modelId ||
                        creatingSession ||
                        submitting ||
                        (!selectedSession && !selectedContextTask)
                      }
                      title="发送"
                      aria-label="发送消息"
                      style={panelStyles.sendButton}
                    >
                      <Send size={14} aria-hidden="true" />
                      发送
                    </button>
                  )}
                </div>
              </div>
            </div>
          </main>

          <button
            type="button"
            className="data-copilot-context-scrim"
            aria-label="收起数据上下文"
            onClick={() => setContextCollapsed(true)}
          />

          <DataCopilotContextBrowser
            className="data-copilot-context-pane"
            sources={contextSources}
            selectedIds={selectedContextSourceIds}
            contextMeta={selectedContextMeta}
            usedTools={usedTools}
            disabled={running || submitting}
            activeTask={selectedContextTask}
            loadTasks={transport.listContextTasks}
            loadRecords={transport.listContextRecords}
            onSelectTask={selectContextTask}
            onLeaveTask={leaveContextTask}
            onToggle={toggleContextSource}
          />
        </div>
      </section>
    </DataCopilotContextProvider>
  )
}

function ApplicationWorkflowSummary({
  jobId,
  onPrepare,
}: {
  jobId: string
  onPrepare: () => void
}) {
  const [batch, setBatch] = useState<ApplicationBatch | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await api.applicationBatches(jobId)
        if (!cancelled) {
          const latest = [...result.batches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
          setBatch(latest)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobId])

  const counts = (batch?.counts ?? {}) as Record<string, number>
  const prepared = Number(counts.ready || 0) + Number(counts.sending || 0) + Number(counts.sent || 0)
  const total = batch?.items.length || 0
  const attachmentCount = batch?.items.reduce((sum, item) => sum + (Array.isArray(item.payload.attachments) ? item.payload.attachments.length : 0), 0) || 0
  const statusLabel = batch ? ({
    draft: '草稿', ready: '待审批', approved: '已审批', running: '发送中', paused: '已暂停', completed: '已完成', cancelled: '已取消',
  } as Record<string, string>)[batch.status] || batch.status : '尚未创建批次'
  const stage = !batch ? 0 : ['draft', 'ready'].includes(batch.status) ? 1 : batch.status === 'approved' ? 2 : 3

  return (
    <section style={panelStyles.applicationWorkflow} aria-label="批量投递状态">
      <div style={panelStyles.applicationWorkflowHeader}>
        <span style={panelStyles.applicationWorkflowTitle}><Layers3 size={14} aria-hidden="true" /><strong>批量投递准备</strong></span>
        <span style={panelStyles.applicationWorkflowStatus}>{loading ? '读取中' : statusLabel}</span>
      </div>
      <div style={panelStyles.applicationWorkflowSteps}>
        {[
          { label: '附件准备', detail: attachmentCount ? `${attachmentCount} 个附件` : '待检查' },
          { label: '批量预览', detail: total ? `${prepared}/${total} 可发送` : '待生成' },
          { label: '审批发送', detail: batch?.status === 'running' ? '发送中' : batch?.status === 'completed' ? '已完成' : '需确认' },
        ].map((item, index) => (
          <div key={item.label} style={{ ...panelStyles.applicationWorkflowStep, ...(index < stage ? panelStyles.applicationWorkflowStepDone : undefined) }}>
            <span style={panelStyles.applicationWorkflowStepIndex}>{index < stage ? '✓' : String(index + 1)}</span>
            <span><strong>{item.label}</strong><small>{item.detail}</small></span>
          </div>
        ))}
      </div>
      <div style={panelStyles.applicationWorkflowFooter}>
        <span>附件说明会在预览中列出原名、最终投递名、大小和 SHA-256。</span>
        <span style={panelStyles.applicationWorkflowActions}>
          <button type="button" onClick={onPrepare} disabled={loading}>准备批量投递</button>
          <button type="button" onClick={() => document.getElementById('batch-application-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>打开工作台</button>
        </span>
      </div>
    </section>
  )
}

const panelStyles: Record<string, CSSProperties> = {
  panel: {
    position: 'fixed',
    zIndex: 1200,
    display: 'grid',
    minWidth: 0,
    height: '100vh',
    gridTemplateRows: '60px minmax(0, 1fr)',
    overflow: 'hidden',
    background: '#f4f0e7',
    color: '#1d2823',
    borderLeft: '1px solid #1c2822',
    boxShadow: '-24px 0 72px rgba(22, 31, 26, 0.22)',
    fontFamily: '"Aptos Display", "Segoe UI Variable", "Microsoft YaHei UI", sans-serif',
    fontSize: 13,
    letterSpacing: 0,
  },
  resizeHandle: {
    position: 'absolute',
    zIndex: 3,
    top: 0,
    bottom: 0,
    width: 7,
    cursor: 'col-resize',
  },
  resizeHandleLeft: { left: -3 },
  resizeHandleRight: { right: -3 },
  header: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    padding: '0 14px 0 18px',
    borderBottom: '1px solid #2e4037',
    background: '#1b2621',
    color: '#f4f0e7',
  },
  brand: { display: 'flex', minWidth: 0, alignItems: 'center', gap: 9 },
  brandIcon: {
    display: 'grid',
    width: 36,
    height: 36,
    flex: '0 0 auto',
    placeItems: 'center',
    border: '1px solid #76c8a9',
    borderRadius: 8,
    background: '#253a30',
    color: '#9ee2c5',
  },
  brandText: { display: 'grid', minWidth: 0, gap: 2 },
  title: { overflow: 'hidden', color: '#f5f1e8', fontSize: 14, fontWeight: 700, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  subtitle: { overflow: 'hidden', color: '#a6b4aa', fontSize: 10, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headerActions: { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: 5 },
  mobileNav: {
    gridAutoFlow: 'column',
    gap: 2,
    padding: 2,
    border: '1px solid #3b5045',
    borderRadius: 7,
    background: '#22312a',
  },
  mobileNavButton: {
    display: 'grid',
    width: 27,
    height: 27,
    placeItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: 5,
    background: 'transparent',
    color: '#a5b4aa',
    cursor: 'pointer',
  },
  mobileNavButtonActive: {
    background: '#b6e4ce',
    color: '#163b2c',
  },
  modelControl: { display: 'inline-flex', height: 34, alignItems: 'stretch' },
  modelSelectLabel: { display: 'inline-flex' },
  modelSelect: {
    width: 190,
    height: 34,
    padding: '0 25px 0 8px',
    border: '1px solid #4a5d51',
    borderRadius: '7px 0 0 7px',
    outline: 0,
    background: '#24342c',
    color: '#f1eee5',
    font: 'inherit',
    fontSize: 12,
    letterSpacing: 0,
  },
  modelSettingsButton: {
    display: 'grid',
    width: 34,
    height: 34,
    placeItems: 'center',
    padding: 0,
    border: '1px solid #4a5d51',
    borderLeft: 0,
    borderRadius: '0 7px 7px 0',
    background: '#2b4035',
    color: '#d9e5da',
    cursor: 'pointer',
  },
  connectModelButton: {
    display: 'inline-flex',
    height: 34,
    alignItems: 'center',
    gap: 7,
    padding: '0 12px',
    border: '1px solid #6fc39f',
    borderRadius: 7,
    background: '#244235',
    color: '#bfe9d1',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 650,
    cursor: 'pointer',
  },
  modelDialogScrim: {
    position: 'absolute',
    zIndex: 30,
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    padding: 24,
    background: 'rgba(28, 34, 30, 0.34)',
  },
  modelDialog: {
    display: 'grid',
    width: 'min(620px, 100%)',
    maxHeight: 'calc(100vh - 48px)',
    gridTemplateRows: 'auto minmax(0, 1fr) auto',
    overflow: 'hidden',
    border: '1px solid #c8c2b4',
    borderRadius: 10,
    background: '#fbf8f0',
    boxShadow: '0 18px 55px rgba(23, 31, 27, 0.24)',
  },
  modelDialogHeader: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '15px 16px',
    borderBottom: '1px solid #e0e5e1',
    background: '#f0ece3',
  },
  modelDialogHeading: { display: 'flex', minWidth: 0, alignItems: 'center', gap: 10 },
  modelDialogIcon: {
    display: 'grid',
    width: 36,
    height: 36,
    flex: '0 0 auto',
    placeItems: 'center',
    border: '1px solid #b6d3ca',
    borderRadius: 6,
    background: '#e9f4f0',
    color: '#0b725c',
  },
  modelDialogTitle: { display: 'block', color: '#252e29', fontSize: 15, fontWeight: 700 },
  modelDialogSubtitle: { display: 'block', marginTop: 3, color: '#6d7771', fontSize: 11, fontWeight: 400 },
  modelDialogBody: {
    display: 'grid',
    minHeight: 0,
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: '13px 12px',
    padding: 16,
    overflowY: 'auto',
  },
  modelField: { display: 'grid', minWidth: 0, alignContent: 'start', gap: 6 },
  modelFieldWide: { gridColumn: '1 / -1' },
  modelFieldLabel: { display: 'flex', alignItems: 'center', gap: 5, color: '#4c5952', fontSize: 11, fontWeight: 650 },
  modelFieldControl: {
    width: '100%',
    height: 38,
    minWidth: 0,
    padding: '0 10px',
    border: '1px solid #cdd5d0',
    borderRadius: 5,
    outline: 0,
    background: '#fff',
    color: '#29332d',
    font: 'inherit',
    fontSize: 12,
    letterSpacing: 0,
  },
  modelStatus: {
    display: 'flex',
    minHeight: 36,
    gridColumn: '1 / -1',
    alignItems: 'center',
    gap: 7,
    padding: '8px 10px',
    border: '1px solid #d6ddd8',
    borderRadius: 5,
    background: '#f7f9f7',
    color: '#536059',
    fontSize: 11,
  },
  modelStatusSuccess: { borderColor: '#b4d7cb', background: '#edf7f3', color: '#126b57' },
  modelStatusError: { borderColor: '#ebbbb3', background: '#fff3f1', color: '#a03e32' },
  modelHint: { gridColumn: '1 / -1', margin: 0, color: '#77817b', fontSize: 10, lineHeight: 1.5 },
  modelDialogFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid #e0e5e1',
    background: '#f8faf8',
  },
  secondaryActionButton: {
    display: 'inline-flex',
    height: 36,
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    border: '1px solid #cad3cd',
    borderRadius: 5,
    background: '#fff',
    color: '#46534c',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 650,
    cursor: 'pointer',
  },
  primaryActionButton: {
    display: 'inline-flex',
    height: 36,
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    border: '1px solid #096f59',
    borderRadius: 5,
    background: '#0b7a62',
    color: '#fff',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 680,
    cursor: 'pointer',
  },
  headerButton: {
    display: 'grid',
    width: 34,
    height: 34,
    placeItems: 'center',
    padding: 0,
    border: '1px solid transparent',
    borderRadius: 5,
    background: 'transparent',
    color: '#58625c',
    cursor: 'pointer',
  },
  workspace: { display: 'grid', minWidth: 0, minHeight: 0, overflow: 'hidden', background: '#dedbd2' },
  sessionRail: {
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
    flexDirection: 'column',
    borderRight: '1px solid #d2cec2',
    background: '#e9e4d9',
  },
  sessionRailHeader: {
    display: 'flex',
    minHeight: 66,
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px 0 16px',
    borderBottom: '1px solid #d2cec2',
  },
  sectionHeading: { fontSize: 14, fontWeight: 680 },
  smallIconButton: {
    display: 'grid',
    width: 32,
    height: 32,
    placeItems: 'center',
    padding: 0,
    border: '1px solid #c8c2b4',
    borderRadius: 7,
    background: '#f7f3eb',
    color: '#36443c',
    cursor: 'pointer',
  },
  sessionSearch: {
    display: 'flex',
    height: 38,
    alignItems: 'center',
    gap: 6,
    margin: '10px 10px 8px',
    padding: '0 10px',
    border: '1px solid #cbc5b9',
    borderRadius: 8,
    background: '#f8f5ee',
    color: '#707970',
  },
  sessionSearchInput: {
    width: '100%',
    minWidth: 0,
    border: 0,
    outline: 0,
    background: 'transparent',
    color: '#303833',
    font: 'inherit',
    fontSize: 12,
    letterSpacing: 0,
  },
  sessionList: { minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' },
  sessionItem: {
    display: 'grid',
    width: '100%',
    minWidth: 0,
    gridTemplateColumns: '22px minmax(0, 1fr) 40px',
    gap: 8,
    alignItems: 'start',
    minHeight: 58,
    padding: '10px 8px',
    border: '1px solid transparent',
    borderRadius: 8,
    background: 'transparent',
    color: '#27332d',
    textAlign: 'left',
    cursor: 'pointer',
  },
  sessionItemSelected: { border: '1px solid #85bca4', background: '#d9eee3', boxShadow: 'inset 3px 0 #287b5d' },
  sessionIcon: { display: 'inline-flex', marginTop: 1, color: '#60706a' },
  sessionBody: { display: 'grid', minWidth: 0, gap: 4 },
  sessionTitle: { overflow: 'hidden', fontSize: 12, fontWeight: 650, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sessionPreview: { overflow: 'hidden', color: '#68726c', fontSize: 11, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sessionTail: { display: 'grid', justifyItems: 'end', gap: 6, color: '#7b847f', fontSize: 10 },
  deleteSessionButton: { display: 'grid', width: 20, height: 20, placeItems: 'center', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: '#7b847f', cursor: 'pointer' },
  centerState: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 22, color: '#7a827e', fontSize: 11 },
  conversation: {
    display: 'grid',
    width: '100%',
    maxWidth: 'none',
    minWidth: 0,
    minHeight: 0,
    margin: 0,
    padding: 0,
    gridTemplateRows: '66px auto auto minmax(0, 1fr) auto',
    background: '#faf8f2',
  },
  conversationHeader: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '0 18px',
    borderBottom: '1px solid #d6d1c7',
  },
  conversationMeta: { display: 'grid', minWidth: 0, gap: 4, color: '#68716c', fontSize: 11 },
  conversationTitle: { overflow: 'hidden', color: '#1d2c25', fontSize: 15, fontWeight: 720, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  conversationHeaderActions: { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: 10 },
  conversationIconButton: { display: 'grid', width: 32, height: 32, placeItems: 'center', padding: 0, border: '1px solid #c9c3b7', borderRadius: 7, background: '#f8f4ec', color: '#3d4c43', cursor: 'pointer' },
  contextToggleButton: { display: 'inline-flex', height: 32, alignItems: 'center', gap: 6, padding: '0 10px', border: '1px solid #c9c3b7', borderRadius: 7, background: '#f8f4ec', color: '#3d4c43', fontSize: 11, fontWeight: 650, cursor: 'pointer' },
  statusIndicator: { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: 6, color: '#68716c', fontSize: 11 },
  statusDot: { width: 7, height: 7, borderRadius: '50%', background: '#aab1ad' },
  statusDotRunning: { background: '#19846b' },
  statusDotFailed: { background: '#bc493a' },
  applicationWorkflow: { display: 'grid', gap: 8, margin: '0 16px 8px', padding: '10px 12px', border: '1px solid #d8e4dd', borderRadius: 6, background: '#f8fbf8' },
  applicationWorkflowHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  applicationWorkflowTitle: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#245e4d', fontSize: 11 },
  applicationWorkflowStatus: { color: '#6f7d75', fontSize: 10, fontWeight: 650 },
  applicationWorkflowSteps: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 },
  applicationWorkflowStep: { display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: 6, alignItems: 'center', minWidth: 0, padding: '6px 7px', borderRadius: 4, background: '#eef2ee', color: '#727e76' },
  applicationWorkflowStepDone: { background: '#e0f1e7', color: '#286b54' },
  applicationWorkflowStepIndex: { display: 'grid', width: 18, height: 18, placeItems: 'center', borderRadius: 9, background: '#d5ded8', fontSize: 10, fontWeight: 700 },
  'applicationWorkflowStep strong': { display: 'block', overflow: 'hidden', fontSize: 10, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  'applicationWorkflowStep small': { display: 'block', overflow: 'hidden', color: '#7b8780', fontSize: 9, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  applicationWorkflowFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, color: '#718078', fontSize: 9, lineHeight: 1.4 },
  applicationWorkflowActions: { display: 'inline-flex', flexShrink: 0, gap: 5 },
  'applicationWorkflowActions button': { padding: '4px 7px', border: '1px solid #cbd9d1', borderRadius: 4, background: '#fff', color: '#2c6753', fontSize: 10, cursor: 'pointer' },
  messageStage: { position: 'relative', minHeight: 0, overflow: 'hidden' },
  messageArea: { height: '100%', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', background: '#faf8f2' },
  scrollToLatestButton: { position: 'absolute', right: 18, bottom: 14, display: 'grid', width: 34, height: 34, placeItems: 'center', padding: 0, border: '1px solid #bdb6a9', borderRadius: '50%', background: '#fffdf8', color: '#287b5d', boxShadow: '0 5px 14px rgba(48, 43, 34, 0.16)', cursor: 'pointer' },
  emptyConversation: { display: 'flex', width: '100%', maxWidth: 620, height: '100%', minHeight: 260, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, margin: '0 auto', padding: '32px 24px', color: '#68736d', fontSize: 12, textAlign: 'center' },
  emptyIcon: { display: 'grid', width: 48, height: 48, placeItems: 'center', border: '1px solid #9bcdb3', borderRadius: 12, background: '#e2f1e7', color: '#287b5d' },
  emptyTitle: { color: '#26302a', fontSize: 15, fontWeight: 680 },
  starterGrid: { display: 'grid', width: '100%', maxWidth: 520, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 10 },
  starterButton: { display: 'flex', minWidth: 0, minHeight: 46, alignItems: 'center', gap: 9, padding: '9px 12px', border: '1px solid #d1cbc0', borderRadius: 9, background: '#fffdf8', color: '#2f4036', fontSize: 12, fontWeight: 620, textAlign: 'left', cursor: 'pointer' },
  composerZone: { position: 'relative', padding: '12px 18px 16px', borderTop: '1px solid #d8d2c7', background: '#eeeae1' },
  composerZoneDragging: { background: '#dff0e5' },
  dropOverlay: { position: 'absolute', zIndex: 2, inset: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, border: '1px dashed #287b5d', borderRadius: 9, background: 'rgba(232, 246, 237, 0.97)', color: '#1d6c4f', fontSize: 11, fontWeight: 650 },
  errorBanner: { display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr) 22px', gap: 6, alignItems: 'center', marginBottom: 6, padding: '6px 7px', border: '1px solid #edc2bb', borderRadius: 5, background: '#fff5f3', color: '#9e3c30', fontSize: 10 },
  dismissError: { display: 'grid', width: 21, height: 21, placeItems: 'center', padding: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  pendingFiles: { display: 'flex', maxHeight: 72, flexWrap: 'wrap', gap: 5, overflowY: 'auto', marginBottom: 6 },
  pendingFile: { display: 'grid', minWidth: 0, maxWidth: 260, height: 29, gridTemplateColumns: '14px minmax(0, 1fr) auto 19px', gap: 5, alignItems: 'center', padding: '0 5px 0 7px', border: '1px solid #d6dcd8', borderRadius: 5, background: '#fff', color: '#525d57' },
  pendingFileName: { overflow: 'hidden', fontSize: 10, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pendingFileSize: { color: '#87908a', fontSize: 9 },
  removePendingFile: { display: 'grid', width: 19, height: 19, placeItems: 'center', padding: 0, border: 0, borderRadius: 3, background: 'transparent', color: '#727c76', cursor: 'pointer' },
  composer: { overflow: 'hidden', maxWidth: 900, margin: '0 auto', border: '1px solid #bdb6a9', borderRadius: 11, background: '#fffdf8', boxShadow: '0 8px 24px rgba(48, 43, 34, 0.12)' },
  shortcutBar: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 9px 0', overflowX: 'auto' },
  shortcutButton: { display: 'inline-flex', flex: '0 0 auto', height: 29, alignItems: 'center', gap: 5, padding: '0 9px', border: '1px solid #d5cec1', borderRadius: 6, background: '#f5f1e8', color: '#526057', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' },
  textarea: { display: 'block', width: '100%', minHeight: 76, maxHeight: 200, resize: 'vertical', padding: '12px 13px 5px', border: 0, outline: 0, background: 'transparent', color: '#252d28', font: 'inherit', fontSize: 13, lineHeight: 1.55, letterSpacing: 0 },
  composerToolbar: { display: 'flex', minHeight: 38, alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 6px 5px 7px' },
  composerTools: { display: 'flex', minWidth: 0, alignItems: 'center', gap: 6 },
  modeControl: { display: 'inline-flex', flex: '0 0 auto', height: 30, alignItems: 'center', padding: 2, border: '1px solid #d4cec2', borderRadius: 7, background: '#eeeadf' },
  modeButton: { height: 24, padding: '0 7px', border: 0, borderRadius: 3, background: 'transparent', color: '#67736d', fontSize: 10, fontWeight: 600, letterSpacing: 0, cursor: 'pointer' },
  modeButtonActive: { background: '#fffdf8', color: '#1f7657', boxShadow: '0 2px 5px rgba(45, 56, 46, 0.16)' },
  hiddenInput: { display: 'none' },
  composerIconButton: { display: 'grid', width: 32, height: 32, placeItems: 'center', padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: '#526159', cursor: 'pointer' },
  contextCountButton: { display: 'flex', height: 30, alignItems: 'center', gap: 5, padding: '0 7px', border: 0, borderRadius: 4, background: 'transparent', color: '#69756f', fontSize: 11, cursor: 'pointer' },
  sendButton: { display: 'inline-flex', height: 36, alignItems: 'center', gap: 6, padding: '0 15px', border: '1px solid #1e694f', borderRadius: 8, background: '#287b5d', color: '#fffdf8', fontSize: 12, fontWeight: 680, cursor: 'pointer' },
  stopButton: { display: 'inline-flex', height: 34, alignItems: 'center', gap: 6, padding: '0 13px', border: '1px solid #d0d6d2', borderRadius: 5, background: '#fff', color: '#4c5751', fontSize: 12, fontWeight: 650, cursor: 'pointer' },
  visuallyHidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  spinningIcon: { animation: 'data-copilot-spin 1s linear infinite' },
}
