import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Archive,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  FileText,
  Gauge,
  BrainCircuit,
  KeyRound,
  ListFilter,
  LoaderCircle,
  Mail,
  MessageSquare,
  Copy,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Target,
  Send,
  Upload,
  UserRoundSearch,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { api } from './api'
import type {
  Artifact,
  ApplicationResult,
  ApplicationResultsResponse,
  CoverageSummary,
  Health,
  Job,
  JobEvent,
  JobRequest,
  JobStatus,
  RelayStatus,
  RelayConfig,
  AiProviderOption,
  AiSession,
  CandidateProfile,
  CandidateApplicationProfile,
  ApplicationRoute,
  OutreachDraft,
} from './types'

const CANDIDATE_PROFILE_STORAGE_KEY = 'xhs-candidate-application-profile'

const defaultCandidateProfile: CandidateApplicationProfile = {
  name: '',
  school: '',
  major: '',
  degreeYear: '研二',
  phoneWeChat: '',
  email: '',
  availabilityDays: '5',
  internshipDuration: '6个月',
}

function loadCandidateProfile(): CandidateApplicationProfile {
  if (typeof window === 'undefined') return defaultCandidateProfile
  try {
    const saved = JSON.parse(window.localStorage.getItem(CANDIDATE_PROFILE_STORAGE_KEY) || '{}')
    return { ...defaultCandidateProfile, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch {
    return defaultCandidateProfile
  }
}

const candidateApplicationFields: Array<keyof CandidateApplicationProfile> = [
  'name', 'school', 'major', 'degreeYear', 'phoneWeChat', 'email', 'availabilityDays', 'internshipDuration',
]

function importedCandidateProfileValues(imported?: Partial<CandidateApplicationProfile>): Partial<CandidateApplicationProfile> {
  const values: Partial<CandidateApplicationProfile> = {}
  for (const key of candidateApplicationFields) {
    const value = imported?.[key]
    if (typeof value === 'string' && value.trim()) values[key] = value.trim()
  }
  return values
}

const defaultRequest: JobRequest = {
  keyword: '实习继任',
  browserProfile: 'openclaw',
  relayPort: 18792,
  limit: 0,
  maxScrolls: 60,
  stableRounds: 8,
  gotoTimeoutMs: 30000,
  noteDelaySeconds: 0.3,
  mode: 'resume',
  skipPostprocess: false,
  noAutoAttach: true,
  checkOnly: false,
  securityVerificationTimeoutSeconds: 600,
  useCodexRuntime: true,
  codexBatchSize: 8,
  codexTimeoutSeconds: 300,
  aiSessionId: null,
  profileId: null,
  candidateProfile: defaultCandidateProfile,
  coverLetterThreshold: 90,
  coverLetterMaxAttempts: 4,
}

const defaultRelayConfig: RelayConfig = {
  port: 18792,
  profile: 'chrome',
  autoConnect: true,
}

const statusText: Record<JobStatus, string> = {
  queued: '等待中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const progressByStatus: Record<JobStatus, number> = {
  queued: 4,
  running: 48,
  completed: 100,
  failed: 100,
  cancelled: 100,
  interrupted: 100,
}

const agentStages = [
  {
    name: '全量正文 Agent',
    description: '滚动到结果稳定，逐篇打开并记录正文抓取状态',
    matcher: /全量正文|body|正文|scrape/i,
  },
  {
    name: '时间归一化 Agent',
    description: '以每篇采集时间换算“昨天 / x天前”等相对时间',
    matcher: /时间归一化|time.?normal/i,
  },
  {
    name: '背景记忆 Agent',
    description: '读取已整理的个人事实记忆，仅保留可验证经历',
    matcher: /background.?memory|背景记忆|profile/i,
  },
  {
    name: '投递信息 Agent',
    description: '分别提取岗位职责、要求、联系邮箱和投递入口',
    matcher: /投递信息|application.?info|contact/i,
  },
  {
    name: '岗位能力 Agent',
    description: '从正文提炼用人方真正需要的能力与优先级',
    matcher: /job.?capabilit|岗位能力|capability/i,
  },
  {
    name: 'AI 写作 Agent',
    description: '依据岗位能力与经历事实生成第一人称专属文案',
    matcher: /沟通文案|outreach|招呼|邮件/i,
  },
  {
    name: '用人单位评分 Agent',
    description: '低于 90 分自动带评语重写，达标后才可投递',
    matcher: /employer|score|rewrite|评分|重写/i,
  },
  {
    name: '质量门禁 Agent',
    description: '检查正文、时间、来源、事实边界与缺失原因',
    matcher: /质量门禁|quality.?gate|verify/i,
  },
]

function formatTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

type DeliveryRouteView = {
  channel: 'email' | 'direct_message' | 'link' | 'other'
  label: string
  target: string
  evidence: string
  confidence?: number
}

function deliveryRoutes(result: ApplicationResult): DeliveryRouteView[] {
  const routes = [...(result.application_info?.contacts || []), ...(result.application_info?.application_routes || [])]
  const normalized = routes.flatMap((route) => normalizeDeliveryRoute(route))
  const seen = new Set<string>()
  return normalized.filter((route) => {
    const key = `${route.channel}:${route.target.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeDeliveryRoute(route: ApplicationRoute): DeliveryRouteView[] {
  const type = String(route.type || '').toLowerCase()
  const value = String(route.value || '').trim()
  const evidence = String(route.evidence || '').trim()
  const emails = `${value}\n${evidence}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  if (emails.length) {
    return emails.map((target) => ({ channel: 'email', label: '邮件投递', target, evidence: evidence || value, confidence: route.confidence }))
  }
  const channel = route.channel
    || (/私信|站内|direct.?message|\bdm\b|message/.test(`${type} ${value}`) ? 'direct_message'
      : (/https?:\/\//i.test(value) ? 'link' : 'other'))
  const label = channel === 'direct_message' ? '站内私信' : channel === 'link' ? '申请链接' : '其他方式'
  return [{ channel, label, target: value || label, evidence: evidence || value, confidence: route.confidence }]
}

function outreachDraft(result: ApplicationResult): OutreachDraft {
  return {
    greeting: result.outreach.greeting || '',
    email_subject: result.outreach.email_subject || '',
    email_body: result.outreach.email_body || '',
    cover_letter: result.outreach.cover_letter || '',
  }
}

function deliveryStatusLabel(action?: string) {
  return ({
    draft_saved: '草稿已保存',
    ready_to_apply: '等待邮件投递',
    ready_to_message: '私信文案已复制',
    applied: '已投递',
    messaged: '已私信',
    email_sent: '邮件已发送',
    email_failed: '邮件发送失败',
  } as Record<string, string>)[action || ''] || '尚未处理'
}

function elapsed(job?: Job) {
  if (!job?.startedAt) return '-'
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function artifactIcon(name: string) {
  if (name.endsWith('.xlsx') || name.endsWith('.csv')) return FileSpreadsheet
  if (name.endsWith('.json')) return FileJson
  if (name.endsWith('.md') || name.endsWith('.txt')) return FileText
  return Archive
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

function numberIndex(value: unknown, target = new Map<string, number>()): Map<string, number> {
  if (!value || typeof value !== 'object') return target
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'number' && Number.isFinite(item)) target.set(normalizeKey(key), item)
    else if (item && typeof item === 'object') numberIndex(item, target)
  }
  return target
}

function pickNumber(index: Map<string, number>, aliases: string[]) {
  for (const alias of aliases) {
    const value = index.get(normalizeKey(alias))
    if (value !== undefined) return value
  }
  return undefined
}

function parseCoverage(value: unknown): CoverageSummary | null {
  const index = numberIndex(value)
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const qualityGate = root.quality_gate && typeof root.quality_gate === 'object'
    ? root.quality_gate as Record<string, unknown>
    : root
  const records = Array.isArray(root.records) ? root.records as Record<string, unknown>[] : []
  const readyDrafts = records.filter((record) => {
    const outreach = record.outreach
    return outreach && typeof outreach === 'object' && (outreach as Record<string, unknown>).status === 'ready'
  }).length
  const processedApplicationInfo = records.filter((record) => record.application_info && typeof record.application_info === 'object').length
  const normalizedTimes = records.filter((record) => {
    const time = record.publish_time
    return time && typeof time === 'object' && Boolean((time as Record<string, unknown>).value ?? (time as Record<string, unknown>).normalized)
  }).length
  const passedRecords = records.filter((record) => {
    const quality = record.quality
    return quality && typeof quality === 'object' && Object.values(quality as Record<string, unknown>).every(Boolean)
  }).length
  const summary: CoverageSummary = {
    discovered: pickNumber(index, ['discovered_count', 'discovered', 'discoveredNotes', 'searchCards']),
    bodyAttempted: pickNumber(index, ['record_count', 'bodyAttempted', 'attempted', 'detailAttempted']),
    bodySucceeded: pickNumber(index, ['body_count', 'bodySucceeded', 'fullBodies', 'detailSucceeded']),
    timesNormalized: records.length ? normalizedTimes : pickNumber(index, ['timesNormalized', 'normalizedTimes']),
    applicationInfo: records.length ? processedApplicationInfo : pickNumber(index, ['applicationInfo', 'applicationInfoCount']),
    draftsGenerated: records.length ? readyDrafts : pickNumber(index, ['draftsGenerated', 'outreachDrafts']),
    qualityPassed: records.length ? passedRecords : pickNumber(index, ['qualityPassed']),
    gatePassed: typeof qualityGate.passed === 'boolean' ? qualityGate.passed : undefined,
    issueCount: Array.isArray(qualityGate.issues) ? qualityGate.issues.length : undefined,
  }
  return Object.values(summary).some((item) => typeof item === 'number' || typeof item === 'boolean') ? summary : null
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}><i />{statusText[status]}</span>
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description: string
}) {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  )
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
    reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '')
    reader.readAsDataURL(file)
  })
}

function App() {
  const [request, setRequest] = useState<JobRequest>(() => ({ ...defaultRequest, candidateProfile: loadCandidateProfile() }))
  const [health, setHealth] = useState<Health | null>(null)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [relayConfig, setRelayConfig] = useState<RelayConfig>(defaultRelayConfig)
  const [relayConfigSaving, setRelayConfigSaving] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [activeJob, setActiveJob] = useState<Job | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null)
  const [results, setResults] = useState<ApplicationResultsResponse | null>(null)
  const [selectedResult, setSelectedResult] = useState<ApplicationResult | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [resultOffset, setResultOffset] = useState(0)
  const [resultsLoading, setResultsLoading] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [loading, setLoading] = useState(true)
  const [relayConnecting, setRelayConnecting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [clock, setClock] = useState(new Date())
  const [providers, setProviders] = useState<AiProviderOption[]>([])
  const [providerId, setProviderId] = useState<AiProviderOption['id']>('codex')
  const [apiKey, setApiKey] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiSession, setAiSession] = useState<AiSession | null>(null)
  const [profiles, setProfiles] = useState<CandidateProfile[]>([])
  const [backgroundText, setBackgroundText] = useState('')
  const [backgroundFiles, setBackgroundFiles] = useState<File[]>([])
  const [configuringAi, setConfiguringAi] = useState(false)
  const [importingProfile, setImportingProfile] = useState(false)
  const [candidateImportStatus, setCandidateImportStatus] = useState<'recognized' | 'empty' | null>(null)
  const cleanupStream = useRef<null | (() => void)>(null)
  const relayConnectionRef = useRef<Promise<RelayStatus> | null>(null)
  const logConsole = useRef<HTMLDivElement | null>(null)
  const logEnd = useRef<HTMLDivElement | null>(null)

  const updateRequest = <K extends keyof JobRequest>(key: K, value: JobRequest[K]) => {
    setRequest((current) => ({ ...current, [key]: value }))
  }

  const updateCandidateProfile = <K extends keyof CandidateApplicationProfile>(key: K, value: CandidateApplicationProfile[K]) => {
    setRequest((current) => ({
      ...current,
      candidateProfile: { ...current.candidateProfile, [key]: value },
    }))
  }

  const connectRelay = useCallback(async (notify = false, overrides?: Partial<RelayConfig>) => {
    if (relayConnectionRef.current) return relayConnectionRef.current
    const port = overrides?.port ?? request.relayPort
    const profile = overrides?.profile ?? relayConfig.profile
    setRelayConnecting(true)
    const connection = api.connectRelay(port, profile)
      .then((status) => {
        setRelay(status)
        if (notify) setNotice(status.message || (status.ready ? 'Relay 已连接' : 'Relay 尚未连接'))
        return status
      })
      .catch((error) => {
        const status: RelayStatus = { running: false, cdpReady: false, port, profile, message: (error as Error).message }
        setRelay(status)
        if (notify) setNotice(status.message || 'Relay 尚未连接')
        return status
      })
      .finally(() => {
        relayConnectionRef.current = null
        setRelayConnecting(false)
      })
    relayConnectionRef.current = connection
    return connection
  }, [relayConfig.profile, request.relayPort])

  const updateRelayConfig = <K extends keyof RelayConfig>(key: K, value: RelayConfig[K]) => {
    setRelayConfig((current) => ({ ...current, [key]: value }))
    if (key === 'port') updateRequest('relayPort', value as JobRequest['relayPort'])
  }

  const saveRelayConfig = async () => {
    setRelayConfigSaving(true)
    setNotice(null)
    try {
      const saved = await api.updateRelayConfig(relayConfig)
      setRelayConfig(saved)
      updateRequest('relayPort', saved.port)
      setNotice('中转站配置已保存')
      await connectRelay(true, saved)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setRelayConfigSaving(false)
    }
  }

  const refreshRelay = useCallback(async () => {
    try {
      const status = await api.relayStatus(request.relayPort)
      setRelay(status)
    } catch (error) {
      setRelay({ running: false, cdpReady: false, port: request.relayPort, message: (error as Error).message })
    }
  }, [request.relayPort])

  const loadJobs = useCallback(async () => {
    try {
      const next = await api.jobs()
      setJobs(Array.isArray(next) ? next : [])
      setActiveJob((current) => current ? next.find((job) => job.id === current.id) || current : next[0] || null)
    } catch (error) {
      setNotice((error as Error).message)
    }
  }, [])

  const selectProvider = (id: AiProviderOption['id'], options = providers) => {
    setProviderId(id)
    const selected = options.find((item) => item.id === id)
    if (selected) {
      setAiModel(selected.model)
      setAiBaseUrl(selected.baseUrl)
    }
    setAiSession(null)
    updateRequest('aiSessionId', null)
  }

  const configureAi = async () => {
    setConfiguringAi(true)
    setNotice(null)
    try {
      const session = await api.createAiSession({ provider: providerId, apiKey, model: aiModel, baseUrl: aiBaseUrl })
      setAiSession(session)
      updateRequest('aiSessionId', session.id)
      setApiKey('')
      setNotice(`${providers.find((item) => item.id === providerId)?.label || providerId} 已连接，密钥仅保存在当前服务进程内`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setConfiguringAi(false)
    }
  }

  const importProfile = async () => {
    if (!aiSession) return setNotice('请先连接 AI')
    if (!backgroundFiles.length) return setNotice('请至少选择一个背景文件')
    setImportingProfile(true)
    setNotice(null)
    try {
      const files = await Promise.all(backgroundFiles.map(async (file) => ({ name: file.name, base64: await fileBase64(file) })))
      const profile = await api.importProfile({ aiSessionId: aiSession.id, backgroundText, files })
      const importedCandidateProfile = importedCandidateProfileValues(profile.candidate_application)
      const importedFieldCount = Object.keys(importedCandidateProfile).length
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)])
      setRequest((current) => ({
        ...current,
        profileId: profile.id,
        candidateProfile: { ...current.candidateProfile, ...importedCandidateProfile },
      }))
      setCandidateImportStatus(importedFieldCount ? 'recognized' : 'empty')
      setNotice(importedFieldCount
        ? '简历已识别并回填候选人信息，请核对字段后再启动任务。'
        : '背景记忆已更新，但未识别到候选人署名字段，请手动填写。')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setImportingProfile(false)
    }
  }

  const loadResults = useCallback(async (jobId: string, offset = 0) => {
    setResultsLoading(true)
    try {
      const payload = await api.results(jobId, offset, 20)
      setResults(payload)
      setResultOffset(offset)
      setSelectedResult((current) => payload.items.find((item) => item.note_id === current?.note_id) || payload.items[0] || null)
      setDraftDirty(false)
    } catch {
      setResults(null)
      setSelectedResult(null)
    } finally {
      setResultsLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    const boot = async () => {
      const results = await Promise.allSettled([api.health(), api.jobs(), api.relayConfig()])
      if (!mounted) return
      const [healthResult, jobsResult, relayConfigResult] = results
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value)
      if (jobsResult.status === 'fulfilled') {
        setJobs(Array.isArray(jobsResult.value) ? jobsResult.value : [])
        setActiveJob(Array.isArray(jobsResult.value) ? jobsResult.value[0] || null : null)
      }
      const configuredPort = relayConfigResult.status === 'fulfilled' ? relayConfigResult.value.port : request.relayPort
      if (relayConfigResult.status === 'fulfilled') {
        setRelayConfig(relayConfigResult.value)
        setRequest((current) => ({ ...current, relayPort: relayConfigResult.value.port }))
      }
      try {
        setRelay(await api.relayStatus(configuredPort))
      } catch (error) {
        setRelay({ running: false, cdpReady: false, port: configuredPort, message: (error as Error).message })
      }
      setLoading(false)
    }
    void boot()
    const clockTimer = window.setInterval(() => setClock(new Date()), 1000)
    const relayTimer = window.setInterval(() => void refreshRelay(), 15000)
    return () => {
      mounted = false
      window.clearInterval(clockTimer)
      window.clearInterval(relayTimer)
      cleanupStream.current?.()
    }
  }, [connectRelay, refreshRelay, request.relayPort])

  useEffect(() => {
    Promise.all([api.aiProviders(), api.profiles()]).then(([options, saved]) => {
      setProviders(options)
      setProfiles(saved)
      const codex = options.find((item) => item.id === 'codex') || options[0]
      if (codex) selectProvider(codex.id, options)
      if (saved[0]) updateRequest('profileId', saved[0].id)
    }).catch((error) => setNotice((error as Error).message))
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(CANDIDATE_PROFILE_STORAGE_KEY, JSON.stringify(request.candidateProfile))
    } catch {
      // Local storage can be disabled; the current form state remains usable.
    }
  }, [request.candidateProfile])

  useEffect(() => {
    if (!logs.length || !logConsole.current) return
    logConsole.current.scrollTo({ top: logConsole.current.scrollHeight, behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    setCoverage(activeJob?.coverage || parseCoverage(activeJob?.workflowSummary) || null)
    if (!activeJob) {
      setArtifacts([])
      setResults(null)
      setSelectedResult(null)
      return
    }
    api.artifacts(activeJob.id).then(setArtifacts).catch(() => setArtifacts(activeJob.artifacts || []))
    void loadResults(activeJob.id, 0)
  }, [activeJob?.id, activeJob?.status, loadResults])

  useEffect(() => {
    if (!activeJob || activeJob.coverage || activeJob.workflowSummary || coverage) return
    const summary = artifacts.find((artifact) => /(^|\/)application_intelligence\.json$/i.test(artifact.name))
      || artifacts.find((artifact) => /(?:workflow|coverage|agent).*(?:summary|report).*\.json$/i.test(artifact.name))
      || artifacts.find((artifact) => /summary\.json$/i.test(artifact.name))
    if (!summary) return
    const controller = new AbortController()
    fetch(api.artifactUrl(activeJob.id, summary), { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => setCoverage(parseCoverage(value)))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setCoverage(null)
      })
    return () => controller.abort()
  }, [activeJob, artifacts, coverage])

  const applyEvent = useCallback((event: JobEvent) => {
    if (event.line) setLogs((current) => [...current.slice(-399), event.line!])
    if (event.job) {
      setActiveJob(event.job)
      setJobs((current) => [event.job!, ...current.filter((item) => item.id !== event.job!.id)])
    }
    if (event.artifacts) setArtifacts(event.artifacts)
    if (event.message && event.type === 'error') setNotice(event.message)
    if (event.type === 'done' || event.job?.status === 'completed' || event.job?.status === 'failed') void loadJobs()
  }, [loadJobs])

  const connectJob = useCallback((job: Job) => {
    cleanupStream.current?.()
    cleanupStream.current = api.subscribe(job.id, applyEvent, () => {
      window.setTimeout(() => void loadJobs(), 800)
    })
  }, [applyEvent, loadJobs])

  const runJob = async (payload: JobRequest) => {
    setSubmitting(true)
    setNotice(null)
    setCoverage(null)
    setLogs([`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 正在创建任务...`])
    try {
      const job = await api.createJob(payload)
      setActiveJob(job)
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      connectJob(job)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const requiredFields: Array<[keyof CandidateApplicationProfile, string]> = [
      ['name', '姓名'],
      ['school', '学校'],
      ['major', '专业'],
      ['email', '邮箱'],
    ]
    const missing = requiredFields.filter(([key]) => !request.candidateProfile[key].trim()).map(([, label]) => label)
    if (missing.length) {
      setNotice(`请先填写候选人信息：${missing.join('、')}`)
      return
    }
    void runJob({ ...request, checkOnly: false })
  }

  const cancel = async () => {
    if (!activeJob) return
    try {
      const job = await api.cancelJob(activeJob.id)
      setActiveJob(job)
      setJobs((current) => current.map((item) => item.id === job.id ? job : item))
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  const selectJob = (job: Job) => {
    setActiveJob(job)
    setLogs([])
    if (job.status === 'running' || job.status === 'queued') connectJob(job)
  }

  const relayReady = Boolean(relay?.running && relay?.cdpReady && (Array.isArray(relay?.tabs) ? relay.tabs.length : Number(relay?.tabs || 0)) > 0)
  const progress = activeJob?.progress ?? (activeJob ? progressByStatus[activeJob.status] : 0)
  const runningCount = jobs.filter((job) => job.status === 'running' || job.status === 'queued').length
  const completedCount = jobs.filter((job) => job.status === 'completed').length
  const failedCount = jobs.filter((job) => job.status === 'failed').length
  const tabCount = Array.isArray(relay?.tabs) ? relay.tabs.length : Number(relay?.tabs || 0)
  const currentArtifacts = artifacts.length ? artifacts : activeJob?.artifacts || []
  const exportCount = useMemo(() => jobs.reduce((sum, job) => sum + (job.artifactCount ?? job.artifacts?.length ?? 0), 0), [jobs])
  const allMode = request.limit === 0
  const activeAllMode = activeJob?.config?.limit === 0
  const runningLog = logs.slice(-120).join('\n')
  const activeAgentIndex = activeJob?.status === 'completed' && coverage
    ? agentStages.length
    : activeJob?.status === 'running'
      ? agentStages.reduce((last, stage, index) => stage.matcher.test(runningLog) ? index : last, 0)
      : -1
  const workflowSummary = activeJob?.workflowSummary || {}
  const partialAnalysis = workflowSummary.analysisMode === 'security_timeout_partial'
  const securityVerification = (workflowSummary.securityVerification || {}) as Record<string, unknown>
  const securityTimeoutSeconds = Number(securityVerification.timeoutSeconds || activeJob?.config?.securityVerificationTimeoutSeconds || 600)
  const securityTimeoutLabel = securityTimeoutSeconds % 60 === 0 ? `${securityTimeoutSeconds / 60} 分钟` : `${securityTimeoutSeconds} 秒`
  const codexRuntime = results?.codexRuntime || (workflowSummary.codexRuntime as Record<string, unknown> | undefined)
  const selectedProvider = providers.find((item) => item.id === providerId)
  const activeProfile = profiles.find((item) => item.id === request.profileId)
  const candidateReady = [
    request.candidateProfile.name,
    request.candidateProfile.school,
    request.candidateProfile.major,
    request.candidateProfile.email,
  ].every((value) => value.trim())
  const backgroundReady = Boolean(request.profileId && activeProfile)
  const readinessChecks = [
    { label: 'AI 会话', ready: Boolean(aiSession), detail: aiSession ? (selectedProvider?.label || providerId) : '等待连接' },
    { label: '背景记忆', ready: backgroundReady, detail: activeProfile?.display_name || '请选择档案' },
    { label: '候选人资料', ready: candidateReady, detail: candidateReady ? '必填字段完整' : '姓名、学校、专业、邮箱' },
    { label: '搜索关键词', ready: Boolean(request.keyword.trim()), detail: request.keyword.trim() || '请输入关键词' },
  ]
  const missingReadiness = readinessChecks.filter((item) => !item.ready).map((item) => item.label)
  const selectedDeliveryRoutes = selectedResult ? deliveryRoutes(selectedResult) : []
  const selectedEmailRoute = selectedDeliveryRoutes.find((route) => route.channel === 'email')
  const selectedMessageRoute = selectedDeliveryRoutes.find((route) => route.channel === 'direct_message')

  const replaceResult = (next: ApplicationResult) => {
    setSelectedResult(next)
    setResults((current) => current ? { ...current, items: current.items.map((item) => item.note_id === next.note_id ? next : item) } : current)
  }

  const chooseResult = (next: ApplicationResult) => {
    if (draftDirty && selectedResult?.note_id !== next.note_id) {
      setNotice('当前岗位有未保存的文案修改，请先保存后再切换。')
      return
    }
    setSelectedResult(next)
    setDraftDirty(false)
  }

  const updateDraft = (field: keyof OutreachDraft, value: string) => {
    if (!selectedResult) return
    replaceResult({ ...selectedResult, outreach: { ...selectedResult.outreach, [field]: value } })
    setDraftDirty(true)
  }

  const copyText = (value: string) => {
    if (!value) return
    void navigator.clipboard.writeText(value).then(() => setNotice('内容已复制到剪贴板'))
  }

  const saveDraft = async () => {
    if (!activeJob || !selectedResult) return
    setDraftSaving(true)
    try {
      const response = await api.saveDraft(activeJob.id, selectedResult.note_id, outreachDraft(selectedResult))
      replaceResult({ ...selectedResult, outreach: { ...selectedResult.outreach, ...response.outreach }, delivery: response.delivery })
      setDraftDirty(false)
      setNotice('投递文案已保存到当前任务')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setDraftSaving(false)
    }
  }

  const prepareMessage = async () => {
    if (!activeJob || !selectedResult) return
    copyText(selectedResult.outreach.greeting)
    try {
      const response = await api.setDelivery(activeJob.id, selectedResult.note_id, 'ready_to_message')
      replaceResult({ ...selectedResult, delivery: response.delivery })
      setNotice('私信文案已复制，可打开原帖发送')
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  const sendEmail = async () => {
    if (!activeJob || !selectedResult || !selectedEmailRoute) return
    setEmailSending(true)
    try {
      const response = await api.sendEmail(activeJob.id, selectedResult.note_id, selectedEmailRoute.target, outreachDraft(selectedResult))
      replaceResult({ ...selectedResult, outreach: { ...selectedResult.outreach, ...response.outreach }, delivery: response.delivery })
      setDraftDirty(false)
      setNotice(`邮件已发送至 ${selectedEmailRoute.target}`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setEmailSending(false)
    }
  }

  const coverageCards = [
    { label: '发现结果', value: coverage?.discovered, icon: Search },
    { label: '正文尝试', value: coverage?.bodyAttempted, icon: FileText },
    { label: '正文成功', value: coverage?.bodySucceeded, icon: Check },
    { label: '时间归一化', value: coverage?.timesNormalized, icon: CalendarClock },
    { label: '投递信息分析', value: coverage?.applicationInfo, icon: UserRoundSearch },
    { label: '定制文案', value: coverage?.draftsGenerated, icon: Mail },
    { label: '质量通过', value: coverage?.qualityPassed, icon: ShieldCheck },
  ]

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-mark" aria-label="继任采集台">继</div>
        <nav aria-label="主导航">
          <button className="nav-button active" title="任务控制台"><Gauge size={20} /><span>控制台</span></button>
          <button className="nav-button" title="任务历史" onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}><Clock3 size={20} /><span>历史</span></button>
          <button className="nav-button" title="导出文件" onClick={() => document.getElementById('artifacts')?.scrollIntoView({ behavior: 'smooth' })}><Table2 size={20} /><span>产物</span></button>
        </nav>
        <button className="nav-button rail-settings" title="工作台设置" onClick={() => document.getElementById('relay-config')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={20} /><span>设置</span></button>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="product-title">
            <span className="eyebrow">LOCAL RELAY OPERATIONS</span>
            <h1>继任采集与投递工作台</h1>
            <span className="version">v3.0</span>
          </div>
          <div className="topbar-status">
            <div className={`relay-indicator ${relayReady ? 'ready' : relayConnecting ? 'connecting' : 'offline'}`}>
              {relayReady ? <Wifi size={17} /> : relayConnecting ? <LoaderCircle className="spin" size={17} /> : <WifiOff size={17} />}
              <span><strong>{relayReady ? 'Relay 已连接' : relayConnecting ? 'Relay 连接中' : 'Relay 待连接'}</strong><small>CDP {request.relayPort} · {tabCount} 个标签页</small></span>
            </div>
            <button className="icon-button" onClick={() => void connectRelay(true)} disabled={relayConnecting} title="通过代码启动 Relay"><RefreshCw className={relayConnecting ? 'spin' : ''} size={17} /></button>
            <time title="北京时间（Asia/Shanghai）">{formatTime(clock.toISOString())}</time>
          </div>
        </header>

        {notice && (
          <div className="notice" role="alert">
            <CircleAlert size={17} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} title="关闭"><X size={16} /></button>
          </div>
        )}

        <main>
          <section className="overview-band" aria-label="运行概览">
            <div className="overview-copy">
              <p>多 Agent 工作流</p>
              <strong>{runningCount ? `${runningCount} 个任务正在推进` : '工作台已待命'}</strong>
            </div>
            <div className="metric"><span>成功任务</span><strong>{completedCount}</strong><small>当前历史</small></div>
            <div className="metric"><span>导出文件</span><strong>{exportCount}</strong><small>JSON / CSV / XLSX / MD</small></div>
            <div className="metric"><span>失败任务</span><strong className={failedCount ? 'danger-text' : ''}>{failedCount}</strong><small>保留失败原因</small></div>
            <div className="health-stamp">
              <Activity size={18} />
              <span><strong>{health?.ok ? '本地服务正常' : loading ? '正在检查服务' : '服务未响应'}</strong><small>{health?.runnerAvailable === false ? 'Runner 路径待配置' : 'Runner 已纳入受控执行'}</small></span>
            </div>
          </section>

          <section className="panel relay-config-panel" id="relay-config" aria-label="中转站配置">
            <div className="panel-heading compact">
              <div><span className="step-label">RELAY CONFIGURATION</span><h2>中转站配置</h2></div>
              <span className={`runtime-badge ${relayReady ? 'passed' : ''}`}>{relayReady ? '已连接' : '待连接'}</span>
            </div>
            <div className="relay-config-body">
              <div className="form-row relay-config-fields">
                <label className="field"><span>中转端口</span><input type="number" min="1024" max="65535" value={relayConfig.port} onChange={(event) => updateRelayConfig('port', Number(event.target.value))} /></label>
                <label className="field"><span>浏览器 Profile</span><input value={relayConfig.profile} onChange={(event) => updateRelayConfig('profile', event.target.value)} placeholder="chrome" /></label>
                <Toggle checked={relayConfig.autoConnect} onChange={(value) => updateRelayConfig('autoConnect', value)} label="开机自动连接" description="启动脚本读取此配置并通过代码连接" />
              </div>
              <div className="relay-config-footer">
                <span className="field-help">端口和 Profile 会同时用于状态探测、连接按钮和新任务。</span>
                <button type="button" className="secondary-button setup-action" disabled={relayConfigSaving || relayConnecting} onClick={() => void saveRelayConfig()}>{relayConfigSaving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并连接</button>
              </div>
            </div>
          </section>

          <section className="panel ai-setup-panel" aria-label="AI 与背景记忆">
            <div className="panel-heading compact">
              <div><span className="step-label">AI & MEMORY</span><h2>模型连接与个人背景记忆</h2></div>
              <span className={`runtime-badge ${aiSession && activeProfile ? 'passed' : ''}`}>{aiSession && activeProfile ? '执行条件已就绪' : '等待配置'}</span>
            </div>
            <div className="ai-setup-grid">
              <section>
                <div className="setup-title"><KeyRound size={17} /><span><strong>AI Runtime</strong><small>{aiSession ? `${selectedProvider?.label || providerId} · 会话内存` : '选择提供方并连接'}</small></span></div>
                <div className="form-row ai-provider-row">
                  <label className="field"><span>提供方</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as AiProviderOption['id'])}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                  {providerId !== 'codex' && <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="仅保存在服务进程内" /></label>}
                  {providerId !== 'codex' && <label className="field"><span>模型</span><input value={aiModel} onChange={(event) => setAiModel(event.target.value)} /></label>}
                </div>
                {providerId !== 'codex' && <label className="field base-url-field"><span>Base URL</span><input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} /></label>}
                <button type="button" className="secondary-button setup-action" disabled={configuringAi || (selectedProvider?.requiresKey && !apiKey)} onClick={() => void configureAi()}>{configuringAi ? <LoaderCircle className="spin" size={16} /> : <BrainCircuit size={16} />}{aiSession ? '重新连接' : '连接 AI'}</button>
              </section>
              <section>
                <div className="setup-title"><Upload size={17} /><span><strong>背景资料</strong><small>{activeProfile ? `${activeProfile.display_name || '个人档案'} · ${activeProfile.sourceFiles?.length || 0} 个来源` : 'PDF / DOCX / TXT / MD / JSON / CSV / RTF'}</small></span></div>
                <label className="upload-zone"><input type="file" multiple accept=".pdf,.docx,.txt,.md,.json,.csv,.rtf" onChange={(event) => setBackgroundFiles(Array.from(event.target.files || []))} /><Upload size={18} /><span>{backgroundFiles.length ? `已选择 ${backgroundFiles.length} 个文件` : '选择多格式背景文件'}</span></label>
                <textarea className="background-text" value={backgroundText} onChange={(event) => setBackgroundText(event.target.value)} placeholder="可补充项目背景、工作偏好或可验证成果" />
                <div className="profile-actions">
                  <select value={request.profileId || ''} onChange={(event) => updateRequest('profileId', event.target.value || null)}><option value="">选择背景记忆</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.id}</option>)}</select>
                  <button type="button" className="secondary-button" disabled={!aiSession || importingProfile || !backgroundFiles.length} onClick={() => void importProfile()}>{importingProfile ? <LoaderCircle className="spin" size={16} /> : <BrainCircuit size={16} />}解析并写入记忆</button>
                </div>
                {activeProfile && <div className="memory-preview"><strong>{activeProfile.summary}</strong><span>{(activeProfile.skills || []).slice(0, 6).join(' · ')}</span></div>}
              </section>
            </div>
            <section className="candidate-profile-section">
              <div className="setup-title"><UserRoundSearch size={17} /><span><strong>求职信署名信息</strong><small>用于生成主题、称呼、可实习时间和联系方式</small></span></div>
              <div className="candidate-profile-grid">
                <label className="field"><span>姓名</span><input value={request.candidateProfile.name} onChange={(event) => updateCandidateProfile('name', event.target.value)} autoComplete="name" placeholder="填写姓名" /></label>
                <label className="field"><span>学校</span><input value={request.candidateProfile.school} onChange={(event) => updateCandidateProfile('school', event.target.value)} autoComplete="organization" placeholder="填写学校" /></label>
                <label className="field"><span>专业</span><input value={request.candidateProfile.major} onChange={(event) => updateCandidateProfile('major', event.target.value)} placeholder="填写专业" /></label>
                <label className="field"><span>年级/学历</span><input value={request.candidateProfile.degreeYear} onChange={(event) => updateCandidateProfile('degreeYear', event.target.value)} placeholder="例如：研二" /></label>
                <label className="field"><span>电话/微信</span><input value={request.candidateProfile.phoneWeChat} onChange={(event) => updateCandidateProfile('phoneWeChat', event.target.value)} autoComplete="tel" placeholder="填写电话或微信" /></label>
                <label className="field"><span>邮箱</span><input type="email" value={request.candidateProfile.email} onChange={(event) => updateCandidateProfile('email', event.target.value)} autoComplete="email" placeholder="填写邮箱" /></label>
                <label className="field"><span>每周可实习天数</span><input inputMode="numeric" value={request.candidateProfile.availabilityDays} onChange={(event) => updateCandidateProfile('availabilityDays', event.target.value)} placeholder="5" /></label>
                <label className="field"><span>预计实习时长</span><input value={request.candidateProfile.internshipDuration} onChange={(event) => updateCandidateProfile('internshipDuration', event.target.value)} placeholder="例如：6个月" /></label>
              </div>
              {candidateImportStatus === 'recognized' && <div className="candidate-profile-import-note recognized"><Check size={15} /><span>已从简历识别候选人信息，请核对后再启动任务；字段仍可手动修改。</span></div>}
              {candidateImportStatus === 'empty' && <div className="candidate-profile-import-note"><CircleAlert size={15} /><span>简历已写入背景记忆，但未识别到完整署名信息，请手动补充。</span></div>}
            </section>
          </section>

          <div className="primary-grid">
            <section className="panel config-panel">
              <div className="panel-heading">
                <div><span className="step-label">01 / CONFIGURE</span><h2>新建采集与投递分析任务</h2></div>
                <span className="local-badge">本地执行</span>
              </div>
              <form onSubmit={submit}>
                <label className="field keyword-field">
                  <span>搜索关键词</span>
                  <div className="input-shell"><Search size={18} /><input value={request.keyword} onChange={(event) => updateRequest('keyword', event.target.value)} required placeholder="输入小红书搜索关键词" /></div>
                </label>

                <div className="field range-field">
                  <span>采集范围</span>
                  <div className="segmented range-segmented">
                    <button type="button" className={allMode ? 'selected' : ''} onClick={() => updateRequest('limit', 0)}><Target size={15} />全量发现</button>
                    <button type="button" className={!allMode ? 'selected' : ''} onClick={() => updateRequest('limit', request.limit || 100)}><ListFilter size={15} />限定数量</button>
                  </div>
                  <small className="field-help">全量模式会持续滚动，连续 {request.stableRounds} 轮没有新结果后停止；每个已发现结果都会尝试抓取正文。</small>
                </div>

                <div className="form-row three">
                  <label className="field"><span>浏览器 Profile</span><select value={request.browserProfile} onChange={(event) => updateRequest('browserProfile', event.target.value)}><option value="openclaw">openclaw（独立）</option><option value="chrome">chrome（当前浏览器）</option></select></label>
                  <label className="field"><span>采集上限</span><input type="number" min="1" max="1000" disabled={allMode} value={allMode ? '' : request.limit} placeholder="全量" onChange={(event) => updateRequest('limit', Number(event.target.value) || 1)} /></label>
                  <label className="field"><span>Relay 端口</span><input type="number" min="1024" max="65535" value={request.relayPort} onChange={(event) => updateRequest('relayPort', Number(event.target.value))} /></label>
                </div>

                <div className="field mode-field">
                  <span>执行模式</span>
                  <div className="segmented">
                    <button type="button" className={request.mode === 'resume' ? 'selected' : ''} onClick={() => updateRequest('mode', 'resume')}><RotateCcw size={15} />断点续采</button>
                    <button type="button" className={request.mode === 'fresh' ? 'selected' : ''} onClick={() => updateRequest('mode', 'fresh')}><Play size={15} />全新任务</button>
                  </div>
                </div>

                <button className="advanced-trigger" type="button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
                  <Settings2 size={16} />高级参数<ChevronDown size={16} className={advanced ? 'rotated' : ''} />
                </button>
                {advanced && (
                  <div className="advanced-grid">
                    <label className="field"><span>最大滚动</span><input type="number" min="1" max="100" value={request.maxScrolls} onChange={(event) => updateRequest('maxScrolls', Number(event.target.value))} /></label>
                    <label className="field"><span>稳定轮次</span><input type="number" min="1" max="20" value={request.stableRounds} onChange={(event) => updateRequest('stableRounds', Number(event.target.value))} /></label>
                    <label className="field"><span>页面超时 ms</span><input type="number" min="1000" max="120000" step="1000" value={request.gotoTimeoutMs} onChange={(event) => updateRequest('gotoTimeoutMs', Number(event.target.value))} /></label>
                    <label className="field"><span>笔记间隔 s</span><input type="number" min="0" max="10" step="0.1" value={request.noteDelaySeconds} onChange={(event) => updateRequest('noteDelaySeconds', Number(event.target.value))} /></label>
                    <label className="field"><span>安全验证等待 s</span><input type="number" min="60" max="3600" step="60" value={request.securityVerificationTimeoutSeconds} onChange={(event) => updateRequest('securityVerificationTimeoutSeconds', Number(event.target.value))} /></label>
                    <label className="field"><span>Codex 单批数量</span><input type="number" min="1" max="20" value={request.codexBatchSize} onChange={(event) => updateRequest('codexBatchSize', Number(event.target.value))} /></label>
                    <Toggle checked={request.useCodexRuntime} onChange={(value) => updateRequest('useCodexRuntime', value)} label="AI 文案与评分" description="逐链接写作、评分并自动重写" />
                    <Toggle checked={request.noAutoAttach} onChange={(value) => updateRequest('noAutoAttach', value)} label="禁用自动附加" description="保持现有浏览器会话" />
                    <Toggle checked={request.skipPostprocess} onChange={(value) => updateRequest('skipPostprocess', value)} label="跳过结构化导出" description="仅保留原始抓取结果" />
                  </div>
                )}

                <div className="readiness-strip" aria-live="polite">
                  <div className="readiness-header">
                    <span className="readiness-title"><ShieldCheck size={15} />启动前检查</span>
                    <span className={`readiness-relay ${relayReady ? 'ready' : ''}`}><Wifi size={13} />{relayReady ? `Relay 已连接 · ${tabCount} 个标签页` : 'Relay 等待连接'}</span>
                    <strong className={missingReadiness.length ? 'pending' : 'ready'}>{missingReadiness.length ? `还差 ${missingReadiness.length} 项` : '可以启动'}</strong>
                  </div>
                  <div className="readiness-items">
                    {readinessChecks.map((item) => (
                      <span className={`readiness-item ${item.ready ? 'ready' : ''}`} key={item.label}>
                        <span className="readiness-icon">{item.ready ? <Check size={12} /> : <CircleAlert size={12} />}</span>
                        <b>{item.label}</b>
                        <small>{item.detail}</small>
                      </span>
                    ))}
                  </div>
                  {missingReadiness.length > 0 && <p>完成{missingReadiness.join('、')}后，启动按钮会自动解锁。</p>}
                </div>

                <div className="form-actions">
                  <button className="primary-button" type="submit" disabled={submitting || !request.keyword.trim() || !aiSession || !backgroundReady || !candidateReady}>{submitting ? <LoaderCircle className="spin" size={18} /> : <Play size={18} fill="currentColor" />}启动全流程</button>
                  <button className="secondary-button" type="button" disabled={submitting} onClick={() => void runJob({ ...request, checkOnly: true })}><Activity size={18} />仅检查链路</button>
                </div>
              </form>
            </section>

            <section className="panel mission-panel">
              <div className="panel-heading">
                <div><span className="step-label">02 / AGENT TEAM</span><h2>当前任务</h2></div>
                {activeJob ? <StatusPill status={activeJob.status} /> : <span className="muted-badge">尚未创建</span>}
              </div>
              {activeJob ? (
                <>
                  <div className="mission-title"><span>关键词</span><strong>{activeJob.keyword}</strong><small>#{activeJob.id.slice(0, 8)}</small></div>
                  <div className="scope-stamp"><Target size={15} /><span><strong>{activeAllMode ? '全量模式' : `最多 ${activeJob.config?.limit ?? '-'} 篇`}</strong><small>{activeAllMode ? `连续 ${activeJob.config?.stableRounds ?? '-'} 轮稳定后停止` : '达到数量上限后停止'}</small></span></div>
                  <div className="progress-block"><div><span>总体进度</span><strong>{Math.round(progress)}%</strong></div><div className="progress-track"><i style={{ width: `${Math.min(100, progress)}%` }} /></div></div>
                  <ol className="pipeline agent-pipeline">
                    {agentStages.map((stage, index) => {
                      const gateFailed = index === agentStages.length - 1 && activeJob.status === 'completed' && coverage?.gatePassed === false
                      const done = (Boolean(activeJob.status === 'completed' && coverage) || index < activeAgentIndex) && !gateFailed
                      const current = activeJob.status === 'running' && activeAgentIndex === index
                      return <li key={stage.name} className={gateFailed ? 'failed-stage' : done ? 'done' : current ? 'current' : ''}><span>{done ? <Check size={14} /> : gateFailed ? <CircleAlert size={14} /> : index + 1}</span><div><strong>{stage.name}</strong><small>{stage.description}</small></div>{current && <em>执行中</em>}{gateFailed && <em>{coverage?.issueCount ?? '-'} 项待复核</em>}</li>
                    })}
                  </ol>
                  <div className="mission-meta"><div><span>开始时间（北京时间）</span><strong>{formatTime(activeJob.startedAt || activeJob.createdAt)}</strong></div><div><span>运行时长</span><strong>{elapsed(activeJob)}</strong></div></div>
                  {(activeJob.status === 'running' || activeJob.status === 'queued') && <button className="cancel-button" onClick={cancel}><Pause size={16} />终止任务</button>}
                </>
              ) : (
                <div className="empty-state"><SquareTerminal size={32} /><strong>等待任务</strong><span>配置关键词与采集参数后启动</span></div>
              )}
            </section>

            <section className="panel log-panel">
              <div className="panel-heading dark-heading">
                <div><span className="step-label">LIVE OUTPUT</span><h2>运行日志</h2></div>
                <span className="live-dot"><i />LIVE</span>
              </div>
              <div className="log-console" ref={logConsole} aria-live="polite">
                {logs.length ? logs.map((line, index) => <p key={`${index}-${line}`}><span>{String(index + 1).padStart(2, '0')}</span>{line}</p>) : <div className="log-placeholder"><SquareTerminal size={25} /><span>任务日志将在这里实时流入</span></div>}
                <div ref={logEnd} />
              </div>
            </section>
          </div>

          <section className="panel coverage-panel" aria-label="结果覆盖">
            <div className="panel-heading compact">
              <div><span className="step-label">COVERAGE & QUALITY</span><h2>结果覆盖与事实边界</h2></div>
              <span className={`coverage-state ${coverage?.gatePassed === false ? 'failed' : coverage?.gatePassed ? 'passed' : ''}`}>{coverage?.gatePassed === true ? '质量门禁通过' : coverage?.gatePassed === false ? `质量门禁未通过 · ${coverage.issueCount ?? '-'} 项` : activeJob?.status === 'completed' ? '等待覆盖摘要' : '随任务更新'}</span>
            </div>
            <div className="coverage-content">
              <div className="coverage-grid">
                {coverageCards.map(({ label, value, icon: Icon }) => <div className="coverage-metric" key={label}><Icon size={17} /><span>{label}</span><strong>{value ?? '-'}</strong></div>)}
              </div>
              <p className={`coverage-note ${partialAnalysis ? 'warning' : ''}`}><ShieldCheck size={16} />{partialAnalysis ? `安全验证在 ${securityTimeoutLabel}内未解除，采集已按规则停止；当前结果来自已保存正文的整理与分析，未采集链接保留缺失状态。` : '所有已发现卡片均会尝试打开正文；失败、访问受限或缺少联系方式的记录保留状态与原因，不补造内容。'}</p>
            </div>
          </section>

          <section className="panel results-panel" id="results" aria-label="逐链接投递结果">
            <div className="panel-heading compact">
              <div><span className="step-label">PER-LINK APPLICATION INTELLIGENCE</span><h2>逐链接岗位与投递文案</h2></div>
              <div className="result-heading-meta">
                <span className={`runtime-badge ${codexRuntime?.status === 'completed' ? 'passed' : ''}`}>AI 质量流 · {String(codexRuntime?.status || '等待结果')}</span>
                <span className="count-badge">{results?.total ?? 0}</span>
              </div>
            </div>
            {!results?.available ? (
              <div className="result-empty"><UserRoundSearch size={28} /><strong>{resultsLoading ? '正在读取分析结果' : '当前任务还没有结构化分析结果'}</strong></div>
            ) : (
              <div className="results-workspace">
                <div className="result-index">
                  <div className="result-index-head"><span>岗位列表</span><small>{resultOffset + 1}-{Math.min(resultOffset + results.items.length, results.total)} / {results.total}</small></div>
                  <div className="result-rows">
                    {results.items.map((item) => {
                      const routeLabels = deliveryRoutes(item).map((route) => route.label)
                      return (
                        <button key={item.note_id} className={selectedResult?.note_id === item.note_id ? 'selected' : ''} onClick={() => chooseResult(item)}>
                          <span><strong>{item.title || '未命名岗位'}</strong><small>{item.publish_time.value || '日期待核验'} · {item.cover_letter_evaluation?.score ?? '-'} 分 · {routeLabels.length ? [...new Set(routeLabels)].join(' / ') : '投递方式待确认'}</small></span>
                          <i className={item.delivery?.action === 'email_sent' ? 'sent' : item.cover_letter_evaluation?.passed ? 'ready' : ''}>{item.delivery?.action === 'email_sent' ? '已发送' : item.cover_letter_evaluation?.passed ? '≥ 90' : '待重写'}</i>
                        </button>
                      )
                    })}
                  </div>
                  <div className="result-pagination">
                    <button title={draftDirty ? '请先保存当前文案' : '上一页'} disabled={draftDirty || resultOffset === 0 || resultsLoading} onClick={() => activeJob && void loadResults(activeJob.id, Math.max(0, resultOffset - 20))}><ChevronLeft size={16} /></button>
                    <button title={draftDirty ? '请先保存当前文案' : '下一页'} disabled={draftDirty || resultOffset + results.limit >= results.total || resultsLoading} onClick={() => activeJob && void loadResults(activeJob.id, resultOffset + 20)}><ChevronRight size={16} /></button>
                  </div>
                </div>
                {selectedResult ? (
                  <article className="result-detail">
                    <header>
                      <div><span>{selectedResult.publish_time.value || '日期待核验'}</span><h3>{selectedResult.title || '未命名岗位'}</h3><small>采集时间 {formatTime(selectedResult.collected_at)} · 原始时间 {selectedResult.publish_time.raw || '-'}</small></div>
                      {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer" title="打开原链接"><ExternalLink size={17} /></a>}
                    </header>
                    <div className="result-facts">
                      <section><h4>岗位职责</h4>{selectedResult.application_info.responsibilities.length ? <ul>{selectedResult.application_info.responsibilities.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>正文未识别到明确职责</p>}</section>
                      <section><h4>岗位要求</h4>{selectedResult.application_info.requirements.length ? <ul>{selectedResult.application_info.requirements.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>正文未识别到明确要求</p>}</section>
                      <section className="capability-section"><h4>关键能力</h4>{selectedResult.job_capabilities?.length ? <ul>{selectedResult.job_capabilities.map((item) => <li key={item.id}><strong>{item.capability}</strong><span>{item.why_it_matters}</span></li>)}</ul> : <p>等待 AI 提炼岗位能力</p>}</section>
                      <section className="route-section"><h4>AI 提取的投递方式</h4>{selectedDeliveryRoutes.length ? <ul>{selectedDeliveryRoutes.map((route, index) => <li key={`${route.channel}-${route.target}-${index}`}><strong>{route.channel === 'email' ? <Mail size={14} /> : route.channel === 'direct_message' ? <MessageSquare size={14} /> : <ExternalLink size={14} />}{route.label}</strong><span><b>{route.target}</b><small>{route.confidence !== undefined ? `AI 置信度 ${route.confidence}% · ` : ''}{route.evidence || '来自岗位正文'}</small></span></li>)}</ul> : <p>原文未提供明确投递方式，发送操作保持关闭。</p>}</section>
                      <section className="body-section"><h4>采集正文</h4><p>{selectedResult.body || '正文尚未采集'}</p></section>
                    </div>
                    <div className="draft-stack">
                      <div className="draft-toolbar">
                        <div><span className="step-label">EDITABLE APPLICATION COPY</span><h4>投递文案编辑器</h4><p>AI 达标版本可直接修改；发送邮件时使用当前编辑内容。</p></div>
                        <button className={draftDirty ? 'dirty' : ''} disabled={draftSaving || !draftDirty} onClick={() => void saveDraft()}>{draftSaving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{draftDirty ? '保存修改' : '已保存'}</button>
                      </div>
                      <section className="draft-editor"><div><h4><MessageSquare size={15} />私信文案</h4><button title="复制私信文案" onClick={() => copyText(selectedResult.outreach.greeting)}><Copy size={15} /></button></div><textarea aria-label="私信文案" value={selectedResult.outreach.greeting} onChange={(event) => updateDraft('greeting', event.target.value)} rows={4} /><small>{selectedResult.outreach.greeting.length} 字</small></section>
                      <section className="draft-editor email-editor"><div><h4><Mail size={15} />邮件文案</h4><button title="复制投递邮件" onClick={() => copyText(`${selectedResult.outreach.email_subject}\n\n${selectedResult.outreach.email_body}`)}><Copy size={15} /></button></div><label><span>邮件主题</span><input aria-label="邮件主题" value={selectedResult.outreach.email_subject} onChange={(event) => updateDraft('email_subject', event.target.value)} /></label><label><span>邮件正文（实际发送）</span><textarea aria-label="邮件正文" value={selectedResult.outreach.email_body} onChange={(event) => updateDraft('email_body', event.target.value)} rows={7} /></label><small>{selectedResult.outreach.email_body.length} 字</small></section>
                      <section className="draft-editor"><div><h4><FileText size={15} />专属 Cover Letter</h4><button title="复制 Cover Letter" onClick={() => copyText(selectedResult.outreach.cover_letter)}><Copy size={15} /></button></div><textarea aria-label="Cover Letter" value={selectedResult.outreach.cover_letter} onChange={(event) => updateDraft('cover_letter', event.target.value)} rows={10} /><small>{selectedResult.outreach.cover_letter.length} 字 · 当前评分基于 AI 达标版本</small></section>
                    </div>
                    <div className="evaluation-panel">
                      <div><span>用人单位评分</span><strong>{selectedResult.cover_letter_evaluation?.score ?? '-'}<small>/ 100</small></strong></div>
                      <div><span>重写轮次</span><strong>{selectedResult.cover_letter_evaluation?.attempts ?? '-'}</strong></div>
                      <p>{selectedResult.cover_letter_evaluation?.passed ? '已通过 90 分投递门槛' : (selectedResult.cover_letter_evaluation?.problems || []).join('；') || '等待评分'}</p>
                    </div>
                    <div className="delivery-console">
                      <div className="delivery-target">
                        <span className={selectedEmailRoute ? 'available' : ''}><Mail size={17} /></span>
                        <div><small>邮件收件人</small><strong>{selectedEmailRoute?.target || '岗位正文未提取到邮箱'}</strong><p>{health?.emailDelivery?.configured ? `SMTP 已就绪 · 发件人 ${health.emailDelivery.from}` : 'SMTP 尚未配置，填写 .env 后重启服务即可启用'}</p></div>
                      </div>
                      <div className="delivery-actions">
                        <button className="send-email-action" disabled={!selectedResult.cover_letter_evaluation?.passed || !selectedEmailRoute || !health?.emailDelivery?.configured || emailSending} onClick={() => void sendEmail()} title={!selectedEmailRoute ? '岗位正文中没有可验证邮箱' : !health?.emailDelivery?.configured ? '请先配置 SMTP' : '立即发送当前邮件正文'}>{emailSending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{emailSending ? '发送中' : '发送邮件'}</button>
                        <button disabled={!selectedResult.cover_letter_evaluation?.passed || !selectedMessageRoute} onClick={() => void prepareMessage()}><MessageSquare size={16} />复制私信</button>
                        {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开岗位</a>}
                      </div>
                    </div>
                    <footer><span>生成方式：<strong>{selectedResult.outreach.generation_mode || '-'}</strong></span><span>当前状态：<strong>{deliveryStatusLabel(selectedResult.delivery?.action)}</strong></span>{selectedResult.delivery?.email?.sentAt && <span>发送时间：<strong>{formatTime(selectedResult.delivery.email.sentAt)}</strong></span>}</footer>
                  </article>
                ) : <div className="result-empty"><FileText size={28} /><strong>选择一个岗位查看详情</strong></div>}
              </div>
            )}
          </section>

          <div className="secondary-grid">
            <section className="panel history-panel" id="history">
              <div className="panel-heading compact">
                <div><span className="step-label">RUN HISTORY</span><h2>任务记录</h2></div>
                <button className="icon-text-button" onClick={loadJobs}><RefreshCw size={15} />刷新</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>状态</th><th>关键词</th><th>创建时间（北京时间）</th><th>范围</th><th>产物</th><th><ListFilter size={15} /></th></tr></thead>
                  <tbody>
                    {jobs.length ? jobs.slice(0, 10).map((job) => (
                      <tr key={job.id} className={activeJob?.id === job.id ? 'selected-row' : ''} onClick={() => selectJob(job)}>
                        <td><StatusPill status={job.status} /></td><td><strong>{job.keyword}</strong><small>#{job.id.slice(0, 8)}</small></td><td>{formatTime(job.createdAt)}</td><td>{job.config?.limit === 0 ? '全量' : `最多 ${job.config?.limit ?? '-'} 篇`}</td><td>{job.artifactCount ?? job.artifacts?.length ?? 0}</td><td><button className="row-open" title="查看任务"><ChevronDown size={15} /></button></td>
                      </tr>
                    )) : <tr className="empty-row"><td colSpan={6}>{loading ? '正在读取任务记录...' : '还没有任务记录'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel artifacts-panel" id="artifacts">
              <div className="panel-heading compact">
                <div><span className="step-label">DELIVERABLES</span><h2>交付产物</h2></div>
                <span className="count-badge">{currentArtifacts.length}</span>
              </div>
              <div className="artifact-list">
                {currentArtifacts.length ? currentArtifacts.map((artifact) => {
                  const Icon = artifactIcon(artifact.name)
                  return <a key={artifact.id} href={activeJob ? api.artifactUrl(activeJob.id, artifact) : '#'} className="artifact-item" download><span className="file-icon"><Icon size={19} /></span><span><strong title={artifact.name}>{artifact.name}</strong><small>{formatBytes(artifact.size)}</small></span><Download size={17} /></a>
                }) : <div className="artifact-empty"><Archive size={26} /><span>任务完成后可在此下载原始、结构化和 Agent 分析文件</span></div>}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
