import { Component, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import {
  Activity,
  Archive,
  ArrowUpDown,
  CalendarDays,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType2,
  Eye,
  Gauge,
  Images,
  BrainCircuit,
  BookOpenCheck,
  Code2,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  Mail,
  Maximize2,
  MessageSquare,
  MessagesSquare,
  Network,
  Copy,
  Cpu,
  Pause,
  Paperclip,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Sparkles,
  SquareTerminal,
  Table2,
  Target,
  Send,
  Trash2,
  Upload,
  UserRoundSearch,
  UsersRound,
  Wifi,
  WifiOff,
  WandSparkles,
  X,
} from 'lucide-react'
import { api } from './api'
import type { ApiError } from './api'
import { draftContentHash } from './draft-state.mjs'
import { AudienceAiPanel } from './AudienceAiPanel'
import { BodyImportPanel } from './BodyImportPanel'
import { BatchApplicationPanel } from './BatchApplicationPanel'
import type { BodyImportRecord } from './body-import'
import { DataCopilotPanel, type DataCopilotModelConnectionInput } from './DataCopilotPanel'
import { createDataCopilotTransport } from './data-copilot-transport'
import type { DataCopilotContextSource, DataCopilotModel } from './DataCopilotContext'
import { ExpansionWorkspace } from './ExpansionWorkspace'
import { JobJourneyPanel } from './JobJourneyPanel'
import { experienceSnapshotForJob, jobExperienceView } from './job-experience'
import { UnsavedDraftDialog } from './UnsavedDraftDialog'
import { useUnsavedDraftGuard } from './useUnsavedDraftGuard'
import type { DraftSaveRequest } from './useUnsavedDraftGuard'
import type {
  Artifact,
  AuthSession,
  ApplicationAttachment,
  ApplicationAttachmentList,
  ApplicationContext,
  ApplicationResult,
  ApplicationResultsResponse,
  ApplicationTone,
  AudienceComment,
  AudienceAiAnchor,
  AudienceAiStatus,
  AudiencePost,
  AudiencePublicProfile,
  AudienceResultsResponse,
  CoverageSummary,
  Health,
  Job,
  JobEvent,
  JobRequest,
  JobStatus,
  RelayStatus,
  RelayRecoveryResult,
  RelayConfig,
  AiProviderOption,
  AiSession,
  CandidateProfile,
  CandidateApplicationProfile,
  ApplicationRoute,
  EmailPreview,
  OutreachDraft,
  LocalModelStatus,
  SmtpAuthMode,
  SmtpConfig,
  SmtpProvider,
  AnalysisMode,
  ContentResearchPreset,
  DataDeletionPreview,
  DataDeletionSpec,
  ResumeScope,
  UserProblem,
  WorkflowConnectionState,
  WorkspaceView,
} from './types'

const FEATURED_JOB_ID = '20260804081657-caf8f451'

const CANDIDATE_PROFILE_STORAGE_KEY = 'xhs-candidate-application-profile'
const CUSTOM_MODEL_OPTION = '__custom_model__'
const COVER_LETTER_MIN_NON_WHITESPACE_CHARS = 800

type AiConnectionCheck = {
  status: 'checking' | 'verified' | 'error'
  message: string
}

type MissingCompletionStage = 'checking' | 'restoring_ai' | 'starting' | 'running' | 'refreshing' | 'complete' | 'needs_attention'

type MissingCompletionFlow = {
  stage: MissingCompletionStage
  sourceJobId: string
  jobId?: string
  incompleteBefore: number | null
  message: string
}

type WorkspaceResultView = {
  activeJobId: string | null
  results: ApplicationResultsResponse | null
  selectedNoteId: string | null
  resultOffset: number
  resultSort: 'newest' | 'oldest'
  resultTimeRange: ApplicationResultsResponse['filters']['timeRange']
}

type AudienceAnchorTarget = {
  kind: 'comments' | 'users'
  entityId: string
  postId: string
  offset: number
  anchor: AudienceAiAnchor
}

class AiSectionBoundary extends Component<{
  children: ReactNode
  fallback: ReactNode
  resetSignal: unknown
}, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AI analysis section render failed', error, info)
  }

  componentDidUpdate(previous: Readonly<{ resetSignal: unknown }>) {
    if (this.state.failed && previous.resetSignal !== this.props.resetSignal) {
      this.setState({ failed: false })
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function AiSectionUnavailable({ label }: { label: string }) {
  return (
    <section className="ai-section-unavailable" role="status">
      <CircleAlert size={17} />
      <span><strong>{label}暂不可用</strong><small>正文与原图不受影响；分析结果更新后此处会自动恢复。</small></span>
    </section>
  )
}

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
  analysisMode: 'job',
  keyword: '实习继任',
  contentPreset: 'auto',
  contentGoal: '',
  searchSort: 'latest',
  maxAgeDays: 14,
  browserProfile: 'openclaw',
  relayPort: 18800,
  limit: 0,
  maxScrolls: 60,
  stableRounds: 8,
  gotoTimeoutMs: 30000,
  noteDelaySeconds: 1.2,
  speedMode: 'random',
  randomDelayMinSeconds: 0.8,
  randomDelayMaxSeconds: 2.4,
  mode: 'fresh',
  completeMissingOnly: false,
  collectAudience: false,
  audienceOnly: false,
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
  expansion: {
    enabled: false,
    rounds: 0,
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
  },
}

const contentResearchOptions: Array<{
  id: ContentResearchPreset
  label: string
  description: string
  example: string
  icon: ReactNode
}> = [
  { id: 'auto', label: 'AI 自动识别', description: '根据采集样本决定最合适的分析结构', example: '适合探索性关键词', icon: <WandSparkles size={17} /> },
  { id: 'experience', label: '经验攻略', description: '提炼步骤、准备、成本、效果与踩坑', example: '经验分享、办事攻略', icon: <BookOpenCheck size={17} /> },
  { id: 'people', label: '人群与风格', description: '理解人群特征、外观风格、偏好与表达', example: '长发男、短发女', icon: <UserRoundSearch size={17} /> },
  { id: 'trend', label: '趋势观察', description: '识别新信号、变化方向、驱动与争议', example: '审美趋势、消费变化', icon: <Activity size={17} /> },
  { id: 'product', label: '产品口碑', description: '整理使用场景、认可点、痛点与购买判断', example: '护发产品、数码体验', icon: <Archive size={17} /> },
  { id: 'place', label: '地点清单', description: '提取地点、时间、路线、比较与到访信息', example: '城市展览、周末去处', icon: <Target size={17} /> },
  { id: 'custom', label: '自定义研究', description: '由你的研究目标定义专属 AI 栏目', example: '回答一个具体问题', icon: <Settings2 size={17} /> },
]

const defaultRelayConfig: RelayConfig = {
  port: 18800,
  profile: 'openclaw',
  autoConnect: true,
}

const smtpProviderOptions: Array<{ id: SmtpProvider; label: string; host: string; port: number; secure: boolean; requireTls: boolean; guidance: string }> = [
  { id: '163', label: '网易邮箱', host: 'smtp.163.com', port: 465, secure: true, requireTls: false, guidance: '支持 163、126 和 yeah 邮箱。请填写客户端授权密码，不是网页登录密码。' },
  { id: 'qq', label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true, requireTls: false, guidance: '先在邮箱设置中开启 SMTP 服务，并使用客户端授权码。' },
  { id: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, requireTls: false, guidance: '账号开启两步验证后，请使用应用专用密码。' },
  { id: 'outlook', label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true, guidance: '组织账号可能关闭 SMTP AUTH；如已加载 OAuth2 配置，可直接测试当前连接。' },
  { id: 'custom', label: '其他 SMTP', host: '', port: 465, secure: true, requireTls: false, guidance: '按邮箱服务商文档填写 SMTP 主机、端口和加密方式。' },
]

const smtpDomainPresets: Record<string, Pick<SmtpConfig, 'provider' | 'host' | 'port' | 'secure' | 'requireTls'>> = {
  '163.com': { provider: '163', host: 'smtp.163.com', port: 465, secure: true, requireTls: false },
  '126.com': { provider: '163', host: 'smtp.126.com', port: 465, secure: true, requireTls: false },
  'yeah.net': { provider: '163', host: 'smtp.yeah.net', port: 465, secure: true, requireTls: false },
  'qq.com': { provider: 'qq', host: 'smtp.qq.com', port: 465, secure: true, requireTls: false },
  'foxmail.com': { provider: 'qq', host: 'smtp.qq.com', port: 465, secure: true, requireTls: false },
  'gmail.com': { provider: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true, requireTls: false },
  'googlemail.com': { provider: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true, requireTls: false },
  'outlook.com': { provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
  'hotmail.com': { provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
  'live.com': { provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
  'msn.com': { provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
}

type SmtpGuideProvider = '163' | 'qq'

const smtpSetupGuides: Record<SmtpGuideProvider, {
  label: string
  accountLabel: string
  host: string
  officialUrl: string
  steps: Array<{ title: string; detail: string }>
  reminder: string
}> = {
  '163': {
    label: '163 / 126 / yeah',
    accountLabel: '网易邮箱',
    host: 'smtp.163.com',
    officialUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
    steps: [
      { title: '进入客户端授权设置', detail: '登录网页版邮箱，打开“设置 → POP3/SMTP/IMAP”。' },
      { title: '生成授权密码', detail: '点击“新增授权密码”，按页面提示完成身份验证。' },
      { title: '回到本页完成测试', detail: '复制授权密码，填入上方“客户端授权密码”，再点击“配置并测试”。' },
    ],
    reminder: '授权密码只显示一次，请及时保存；这里不要填写网易邮箱的网页登录密码。',
  },
  qq: {
    label: 'QQ / Foxmail',
    accountLabel: 'QQ 邮箱',
    host: 'smtp.qq.com',
    officialUrl: 'https://help.mail.qq.com/detail/106/985',
    steps: [
      { title: '打开账号安全设置', detail: '登录 QQ 邮箱，进入“设置 → 账号与安全 → 安全设置”。' },
      { title: '开启服务并生成授权码', detail: '开启 POP3/IMAP/SMTP 服务，按提示验证身份并生成 16 位授权码。' },
      { title: '回到本页完成测试', detail: '将完整邮箱和 16 位授权码填入上方，再点击“配置并测试”。' },
    ],
    reminder: '授权码不是 QQ 登录密码；QQ 密码变更后，已有授权码可能失效，需要重新生成。',
  },
}

function smtpPresetForEmail(email: string) {
  const domain = email.trim().toLowerCase().split('@')[1] || ''
  return smtpDomainPresets[domain] || null
}

const defaultSmtpConfig: SmtpConfig = {
  provider: '163',
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  requireTls: false,
  auth: 'login',
  authMode: 'login',
  user: '',
  from: '',
  hasPassword: false,
  oauth: {
    tenant: 'organizations',
    clientId: '',
    scope: 'https://outlook.office.com/SMTP.Send offline_access openid profile email',
    hasClientSecret: false,
    hasRefreshToken: false,
  },
  configured: false,
  verified: false,
  maskedFrom: '',
}

const statusText: Record<JobStatus, string> = {
  queued: '待开始',
  resuming: '正在续跑',
  running: '进行中',
  completed: '已完成',
  incomplete: '未完成 · 可续跑',
  blocked: '等待人工处理',
  failed: '执行失败',
  cancelled: '未完成 · 已取消',
  interrupted: '未完成 · 已中断',
}

const humanQualityLabels: Record<string, string> = {
  factual_grounding: '事实依据',
  specificity: '具体程度',
  relevance: '岗位相关',
  naturalness: '自然表达',
  brevity: '简洁程度',
  tone: '语气',
  repetition: '避免重复',
  attachment_consistency: '附件一致',
  call_to_action: '下一步',
  ai_cliche_score: '模板腔',
}

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
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function attachmentTypeIcon(attachment: ApplicationAttachment) {
  if (/^image\//i.test(attachment.mediaType)) return <FileImage size={17} />
  if (/\.(?:doc|docx)$/i.test(attachment.extension)) return <FileType2 size={17} />
  return <FileText size={17} />
}

function attachmentStatusLabel(attachment: ApplicationAttachment) {
  if (attachment.status === 'ready' && ['passed', 'valid', 'verified'].includes(attachment.validationStatus)) return '已校验'
  if (attachment.status === 'uploading') return '上传中'
  if (attachment.status === 'missing') return '文件缺失'
  if (attachment.status === 'invalid') return attachment.validationError || '校验失败'
  return attachment.validationStatus || attachment.status
}

type PreviewImage = {
  url: string
  originalUrl?: string
  original_url?: string
  alt?: string
  source?: string
}

type ImagePreviewState = {
  title: string
  images: PreviewImage[]
  index: number
}

function resultImages(result: ApplicationResult): PreviewImage[] {
  const candidates = [
    ...(result.media?.cover_url ? [{ url: result.media.cover_url, originalUrl: result.media.cover_original_url, alt: `${result.title || '内容'}封面`, source: 'cover' }] : []),
    ...(result.media?.images || []).map((image) => ({ ...image, originalUrl: image.original_url })),
  ]
  return candidates.filter((image, index) => image.url && candidates.findIndex((candidate) => candidate.url === image.url) === index)
}

function imageSourceLabel(source?: string) {
  return source === 'detail' ? '正文图片' : source === 'cover' ? '封面' : source === 'card' ? '搜索卡片' : '内容图片'
}

function imageAnalysisStatusLabel(source?: string) {
  if (source === 'vision_model') return 'AI 已看图'
  if (['image_ocr_model', 'image_ocr', 'ocr'].includes(source || '')) return '本地 OCR 已识别'
  if (source === 'image_alt_text') return '基于图片文字'
  return '等待图片理解'
}

const IMAGE_RETRY_DELAYS_MS = [450, 1200]

function imageSources(image: PreviewImage) {
  return [image.url, image.originalUrl, image.original_url].filter((url, index, sources): url is string => Boolean(url) && sources.indexOf(url) === index)
}

function retryImageUrl(url: string, attempt: number) {
  if (!attempt || !url.startsWith('/api/')) return url
  return `${url}${url.includes('?') ? '&' : '?'}render_retry=${attempt}`
}

function RetryingImage({ image, alt, loading, allowManualRetry = false, onExhausted }: {
  image: PreviewImage
  alt: string
  loading?: 'eager' | 'lazy'
  allowManualRetry?: boolean
  onExhausted?: () => void
}) {
  const sources = useMemo(() => imageSources(image), [image.originalUrl, image.original_url, image.url])
  const [sourceIndex, setSourceIndex] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const retryTimer = useRef<number | null>(null)
  const sourceKey = sources.join('|')

  const reset = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
    retryTimer.current = null
    setSourceIndex(0)
    setAttempt(0)
    setWaiting(false)
    setExhausted(false)
  }, [])

  useEffect(() => {
    reset()
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
    }
  }, [reset, sourceKey])

  const handleError = () => {
    if (waiting || exhausted) return
    if (attempt < IMAGE_RETRY_DELAYS_MS.length) {
      setWaiting(true)
      retryTimer.current = window.setTimeout(() => {
        setAttempt((current) => current + 1)
        setWaiting(false)
        retryTimer.current = null
      }, IMAGE_RETRY_DELAYS_MS[attempt])
      return
    }
    if (sourceIndex + 1 < sources.length) {
      setSourceIndex((current) => current + 1)
      setAttempt(0)
      return
    }
    setExhausted(true)
    onExhausted?.()
  }

  if (waiting) {
    return <span className="retrying-image-state is-loading" aria-label="图片正在重试"><LoaderCircle className="spin" size={18} /><small>重新加载中</small></span>
  }

  if (exhausted || !sources[sourceIndex]) {
    if (allowManualRetry) {
      return <button type="button" className="image-load-retry" onClick={reset}><RefreshCw size={18} />重新加载图片</button>
    }
    return <span className="retrying-image-state is-failed" aria-label="图片加载失败"><Images size={18} /><small>加载失败</small></span>
  }

  const src = retryImageUrl(sources[sourceIndex], attempt)
  return <img key={`${sourceIndex}-${attempt}-${src}`} src={src} alt={alt} loading={loading} referrerPolicy="no-referrer" onError={handleError} />
}

function ResultCardMedia({ result, onPreview, noun = '岗位' }: { result: ApplicationResult; onPreview: (images: PreviewImage[], index: number) => void; noun?: string }) {
  const images = useMemo(() => resultImages(result), [result])
  const [previewIndex, setPreviewIndex] = useState(0)
  const imageKey = images.map((image) => `${image.url}|${image.originalUrl || image.original_url || ''}`).join('||')
  const preview = images[previewIndex]

  useEffect(() => setPreviewIndex(0), [imageKey])

  if (preview) {
    return (
      <button className="result-card-media has-image" type="button" aria-label={`在当前页面查看${result.title || noun}的图片`} onClick={() => onPreview(images, previewIndex)}>
        <RetryingImage
          image={preview}
          alt={preview.alt || `${result.title || noun}图片`}
          loading="lazy"
          onExhausted={() => setPreviewIndex((current) => current + 1)}
        />
        <span className="result-card-media-open"><Maximize2 size={12} /></span>
        <span className="result-card-media-count"><Images size={11} />{images.length}</span>
      </button>
    )
  }

  return (
    <button className="result-card-media is-empty" type="button" aria-label={images.length ? `重新加载 ${images.length} 张${noun}图片` : `暂无${noun}图片`} disabled={!images.length} onClick={() => setPreviewIndex(0)}>
      <span className="result-card-media-empty">{images.length ? <RefreshCw size={18} /> : <Images size={19} />}<small>{images.length ? '重新加载图片' : `暂无${noun}图片`}</small></span>
    </button>
  )
}

function ImagePreview({ preview, onClose, onChange }: { preview: ImagePreviewState; onClose: () => void; onChange: (index: number) => void }) {
  const current = preview.images[preview.index]
  const multiple = preview.images.length > 1

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (multiple && event.key === 'ArrowLeft') onChange((preview.index - 1 + preview.images.length) % preview.images.length)
      if (multiple && event.key === 'ArrowRight') onChange((preview.index + 1) % preview.images.length)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [multiple, onChange, onClose, preview.images.length, preview.index])

  return (
    <div className="image-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={`${preview.title}图片预览`} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>{imageSourceLabel(current.source)}</span><strong>{preview.title}</strong></div>
          <div><small>{preview.index + 1} / {preview.images.length}</small><button type="button" onClick={onClose} title="关闭图片预览" aria-label="关闭图片预览"><X size={20} /></button></div>
        </header>
        <div className="image-preview-stage">
          {multiple && <button className="image-preview-nav previous" type="button" onClick={() => onChange((preview.index - 1 + preview.images.length) % preview.images.length)} title="上一张" aria-label="上一张图片"><ChevronLeft size={24} /></button>}
          <RetryingImage image={current} alt={current.alt || `${preview.title}图片 ${preview.index + 1}`} loading="eager" allowManualRetry />
          {multiple && <button className="image-preview-nav next" type="button" onClick={() => onChange((preview.index + 1) % preview.images.length)} title="下一张" aria-label="下一张图片"><ChevronRight size={24} /></button>}
        </div>
        {multiple && (
          <div className="image-preview-strip" aria-label="图片列表">
            {preview.images.map((image, index) => (
              <button key={`${image.url}-${index}`} className={index === preview.index ? 'active' : ''} type="button" onClick={() => onChange(index)} aria-label={`查看第 ${index + 1} 张图片`} aria-current={index === preview.index ? 'true' : undefined}>
                <RetryingImage image={image} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function EmailSendPreview({ preview, sending, onClose, onConfirm }: { preview: EmailPreview; sending: boolean; onClose: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose, sending])

  const qualityEvaluation = preview.quality?.evaluation

  return (
    <div className="email-preview-backdrop" role="presentation" onMouseDown={() => { if (!sending) onClose() }}>
      <section className="email-preview-dialog" role="dialog" aria-modal="true" aria-label="邮件发送预览" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="step-label">FINAL SEND PREVIEW</span><h3>确认本次邮件投递</h3></div>
          <button type="button" disabled={sending} onClick={onClose} title="关闭发送预览" aria-label="关闭发送预览"><X size={19} /></button>
        </header>
        <div className="email-preview-content">
          <dl className="email-preview-meta">
            <div><dt>收件人</dt><dd>{preview.recipient}</dd></div>
            <div><dt>发件人</dt><dd>{preview.from}</dd></div>
            <div><dt>Reply-To</dt><dd>{preview.replyTo || '-'}</dd></div>
            <div><dt>主题</dt><dd>{preview.subject}</dd></div>
          </dl>
          <section>
            <h4>完整邮件正文</h4>
            <pre>{preview.text}</pre>
          </section>
          <section>
            <h4>随信附件 <small>{preview.attachmentSummary.count} 个 · {formatBytes(preview.attachmentSummary.totalBytes)}</small></h4>
            {preview.attachmentSummary.attachments.length ? <ul className="email-preview-attachments">{preview.attachmentSummary.attachments.map((attachment) => <li key={attachment.attachmentId}><Paperclip size={14} /><span><strong>{attachment.filename}</strong><small>{attachment.mediaType} · {formatBytes(attachment.size)}</small></span></li>)}</ul> : <p className="email-preview-empty">本次邮件没有附件。</p>}
          </section>
          <section className="email-preview-quality">
            <h4>最近一次质量检查 <small>{preview.quality?.checkedAt ? formatTime(preview.quality.checkedAt) : '暂无时间'}</small></h4>
            <p className={qualityEvaluation?.passed ? 'passed' : 'blocking'}>
              {preview.quality && qualityEvaluation
                ? `${qualityEvaluation.passed ? '已通过' : '未通过'}${typeof qualityEvaluation.score === 'number' ? ` · ${qualityEvaluation.score} / 100` : ''} · 草稿 v${preview.quality.version}`
                : '当前草稿没有可用的质量检查结果'}
            </p>
            {!!qualityEvaluation?.problems?.length && <ul>{qualityEvaluation.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          </section>
          {preview.warnings.length > 0 && <section className="email-preview-warnings"><h4>发送检查</h4>{preview.warnings.map((warning) => <p key={warning.code} className={warning.blocking ? 'blocking' : ''}><CircleAlert size={14} />{warning.message}</p>)}</section>}
        </div>
        <footer>
          <span>草稿 v{preview.draftVersion} · 预计邮件大小 {formatBytes(preview.estimatedMessageSize)}</span>
          <div><button type="button" disabled={sending} onClick={onClose}>返回修改</button><button className="confirm-send" type="button" disabled={sending || preview.readiness !== 'ready'} onClick={onConfirm}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{sending ? '正在投递' : '确认发送'}</button></div>
        </footer>
      </section>
    </div>
  )
}

type DeliveryRouteView = {
  channel: 'email' | 'direct_message' | 'link' | 'other'
  label: string
  target: string
  evidence: string
  confidence?: number
  sourceField: string
  sourceImageIndex?: number
  sourceImageUrl?: string
  verificationStatus?: string
  evidenceHash?: string
  sourceRevision?: string
  actionable: boolean
}

function deliveryRoutes(result: ApplicationResult): DeliveryRouteView[] {
  const discovered = (result.contactDiscovery?.candidates || []).map((candidate) => ({
    channel: 'email' as const,
    label: '邮件投递',
    target: candidate.address,
    evidence: candidate.evidenceText,
    confidence: candidate.confidence,
    sourceField: candidate.sourceFields?.join('+') || candidate.source,
    verificationStatus: candidate.verificationStatus,
    evidenceHash: candidate.evidenceHash,
    sourceRevision: candidate.sourceRevision,
    actionable: candidate.actionable !== false && Boolean(candidate.evidenceHash && candidate.sourceRevision),
  }))
  const routes = [...(result.application_info?.contacts || []), ...(result.application_info?.application_routes || [])]
  const normalized = [...discovered, ...routes.flatMap((route) => normalizeDeliveryRoute(route))]
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
  const metadata = {
    sourceField: String(route.source_field || route.source_fields?.join('+') || 'body'),
    sourceImageIndex: route.source_image_index,
    sourceImageUrl: route.source_image_url,
    verificationStatus: route.verification_status,
    evidenceHash: route.evidence_hash,
    sourceRevision: route.source_revision,
    actionable: route.actionable !== false,
  }
  if (emails.length) {
    return emails.map((target) => ({
      channel: 'email',
      label: '邮件投递',
      target,
      evidence: evidence || value,
      confidence: route.confidence,
      ...metadata,
      actionable: metadata.actionable && Boolean(metadata.evidenceHash && metadata.sourceRevision),
    }))
  }
  const channel = route.channel
    || (/私信|站内|direct.?message|\bdm\b|message/.test(`${type} ${value}`) ? 'direct_message'
      : (/https?:\/\//i.test(value) ? 'link' : 'other'))
  const label = channel === 'direct_message' ? '站内私信' : channel === 'link' ? '申请链接' : '其他方式'
  const verifiedLink = channel === 'link' ? verifiedPublicHttpUrl(value) : ''
  return [{
    channel,
    label,
    target: verifiedLink || value || label,
    evidence: evidence || value,
    confidence: route.confidence,
    ...metadata,
    actionable: metadata.actionable && (channel !== 'link' || Boolean(verifiedLink)),
  }]
}

function verifiedPublicHttpUrl(value: string) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.includes(':') || isUnsafeIpv4(hostname)) return ''
    return url.href
  } catch {
    return ''
  }
}

function isUnsafeIpv4(hostname: string) {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return octets[0] === 0
    || octets[0] === 10
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 0)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 198 && [18, 19, 51].includes(octets[1]))
    || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
    || octets[0] >= 224
}

function routeVerificationLabel(route: DeliveryRouteView) {
  if (route.verificationStatus === 'cross_verified') return '正文与图片一致'
  if (route.verificationStatus === 'image_format_normalized') return '图中识别 · 已自动还原'
  if (route.verificationStatus === 'body_format_normalized') return '正文识别 · 已自动还原'
  if (route.verificationStatus === 'image_format_verified') return '图中识别 · 格式已复核'
  if (route.verificationStatus === 'needs_manual_review') return '图中识别 · 待人工核对'
  if (route.sourceField.includes('image')) return '来自岗位图片'
  return '来自岗位正文'
}

function splitDisplayedCoverLetter(value: unknown): { subject: string; body: string } {
  const body = String(value || '').trim()
  if (!body) return { subject: '', body: '' }
  const heading = body.match(/^\s*(?:主题|邮件主题|Subject)\s*[:：]\s*([^\r\n]+)\s*(?:\r?\n|$)/iu)
  if (heading) {
    return {
      subject: heading[1].trim(),
      body: body.slice(heading[0].length).trim(),
    }
  }
  const firstLineBreak = body.indexOf('\n')
  if (firstLineBreak > 0) {
    const firstLine = body.slice(0, firstLineBreak).trim()
    const remainder = body.slice(firstLineBreak + 1).trim()
    if (
      firstLine.length <= 120
      && !/^(?:尊敬|Dear|您好|Hi)\b/iu.test(firstLine)
      && (/尊敬|招聘负责人|Dear/iu.test(remainder.slice(0, 160)) || /申请|应聘|求职/u.test(firstLine) || firstLine.includes('｜'))
    ) {
      return { subject: firstLine, body: remainder }
    }
  }
  return { subject: '', body }
}

function outreachDraft(result: ApplicationResult): OutreachDraft {
  const outreach = result.outreach ?? {}
  const legacyCoverLetter = splitDisplayedCoverLetter(outreach.cover_letter)
  return {
    greeting: outreach.greeting || '',
    email_subject: result.emailSubjectPreview || outreach.email_subject || legacyCoverLetter.subject || '',
    email_body: outreach.email_body || '',
    cover_letter: legacyCoverLetter.body,
  }
}

function hasVerifiedDraftQuality(result: ApplicationResult): boolean {
  const draft = result.draftVersion
  if (!draft) return Boolean(result.cover_letter_evaluation?.passed)
  return draft.qualityStatus === 'passed'
    && draft.qualityCheckedVersion === draft.version
    && draft.qualityCheckedHash === draft.contentHash
}

function hasUncheckedDraftQuality(result: ApplicationResult): boolean {
  const draft = result.draftVersion
  if (!draft || draft.qualityStatus !== 'stale') return false
  const versionCount = Number(draft.versionCount ?? draft.version)
  return draft.qualityCheckedVersion == null
    && !draft.qualityCheckedHash
    && versionCount <= 1
}

function hasInvalidatedDraftQuality(result: ApplicationResult): boolean {
  return result.draftVersion?.qualityStatus === 'stale' && !hasUncheckedDraftQuality(result)
}

function resultFilterStats(results: ApplicationResultsResponse) {
  const items = Array.isArray(results.items) ? results.items : []
  return results.filters?.stats ?? {
    all: Number.isFinite(results.total) ? results.total : items.length,
    incomplete: 0,
    withImages: 0,
    unknown: 0,
  }
}

function resultCompletionStats(results: ApplicationResultsResponse) {
  const incomplete = Math.max(0, Number(resultFilterStats(results).incomplete || 0))
  const sourcePending = Math.max(0, Number(results.sourceCoverage?.pendingCount || 0))
  const publishedWithoutBody = Math.max(
    0,
    Number(results.sourceCoverage?.totalRecordCount || 0) - Number(results.sourceCoverage?.fullBodyCount || 0),
  )
  return {
    incomplete,
    sourcePending,
    total: sourcePending + Math.max(0, incomplete - publishedWithoutBody),
  }
}

function deliveryStatusLabel(action?: string) {
  const labels = {
    draft_saved: '草稿已保存',
    ready_to_apply: '等待邮件投递',
    ready_to_message: '私信文案已复制',
    applied: '已投递',
    messaged: '已私信',
    preview_ready: '发送预览已就绪',
    preparing: '正在准备发送',
    sending: '发送中',
    sent: '邮件已发送',
    failed: '邮件发送失败',
    unknown: '发送结果待确认',
    blocked: '发送已阻断',
  } as Record<string, string>
  const normalized = action?.startsWith('email_') ? action.slice('email_'.length) : action
  return labels[action || ''] || labels[normalized || ''] || '尚未处理'
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
  const bodyMetrics = root.bodyMetrics && typeof root.bodyMetrics === 'object'
    ? root.bodyMetrics as Record<string, unknown>
    : null
  const bodyMetric = (field: string) => {
    const metric = bodyMetrics?.[field]
    return typeof metric === 'number' && Number.isFinite(metric) ? metric : undefined
  }
  const qualityGate = root.quality_gate && typeof root.quality_gate === 'object'
    ? root.quality_gate as Record<string, unknown>
    : root
  const records = Array.isArray(root.records) ? root.records as Record<string, unknown>[] : []
  const generatedDrafts = records.filter((record) => {
    const outreach = record.outreach
    if (!outreach || typeof outreach !== 'object') return false
    const copy = outreach as Record<string, unknown>
    return ['greeting', 'email_subject', 'email_body', 'cover_letter'].every((field) => String(copy[field] || '').trim())
  }).length
  const generatedJobCards = records.filter((record) => (
    (record.job_card && typeof record.job_card === 'object')
    || (record.application_info && typeof record.application_info === 'object')
  )).length
  const normalizedTimes = records.filter((record) => {
    const time = record.publish_time
    return time && typeof time === 'object' && Boolean((time as Record<string, unknown>).value ?? (time as Record<string, unknown>).normalized)
  }).length
  const passedRecords = records.filter((record) => {
    const quality = record.quality
    return quality && typeof quality === 'object' && Object.values(quality as Record<string, unknown>).every(Boolean)
  }).length
  const summary: CoverageSummary = {
    discovered: bodyMetric('discovered') ?? pickNumber(index, ['discovered_count', 'discovered', 'discoveredNotes', 'searchCards']),
    bodyAttempted: bodyMetric('attempted') ?? pickNumber(index, ['record_count', 'bodyAttempted', 'attempted', 'detailAttempted']),
    bodySucceeded: bodyMetric('succeeded') ?? pickNumber(index, ['body_count', 'bodySucceeded', 'fullBodies', 'detailSucceeded']),
    bodyFailed: bodyMetric('failed'),
    bodyNotAttempted: bodyMetric('notAttempted'),
    bodyBlocked: bodyMetric('blocked'),
    bodyCancelled: bodyMetric('cancelled'),
    bodyCompletionRatePercent: bodyMetric('completionRatePercent'),
    timesNormalized: records.length ? normalizedTimes : pickNumber(index, ['timesNormalized', 'normalizedTimes']),
    applicationInfo: records.length ? generatedJobCards : pickNumber(index, ['jobCardsGenerated', 'applicationInfo', 'applicationInfoCount']),
    draftsGenerated: records.length ? generatedDrafts : pickNumber(index, ['applicationCopyGenerated', 'draftsGenerated', 'outreachDrafts']),
    generationCoveragePercent: records.length ? Math.round((generatedDrafts / records.length) * 10000) / 100 : pickNumber(index, ['generationCoveragePercent']),
    qualityPassed: records.length ? passedRecords : pickNumber(index, ['qualityPassed']),
    gatePassed: typeof qualityGate.passed === 'boolean' ? qualityGate.passed : undefined,
    issueCount: Array.isArray(qualityGate.issues) ? qualityGate.issues.length : undefined,
  }
  return Object.values(summary).some((item) => typeof item === 'number' || typeof item === 'boolean') ? summary : null
}

function GeneralResultsWorkspace({
  results,
  selectedResult,
  resultOffset,
  resultSort,
  resultTimeRange,
  resultsLoading,
  completingMissing,
  onSelect,
  onSort,
  onTimeRange,
  onReset,
  onComplete,
  onPage,
  onPreview,
  onCopy,
}: {
  results: ApplicationResultsResponse
  selectedResult: ApplicationResult | null
  resultOffset: number
  resultSort: 'newest' | 'oldest'
  resultTimeRange: ApplicationResultsResponse['filters']['timeRange']
  resultsLoading: boolean
  completingMissing: boolean
  onSelect: (result: ApplicationResult) => void
  onSort: (sort: 'newest' | 'oldest') => void
  onTimeRange: (range: ApplicationResultsResponse['filters']['timeRange']) => void
  onReset: () => void
  onComplete: () => void
  onPage: (offset: number) => void
  onPreview: (title: string, images: PreviewImage[], index?: number) => void
  onCopy: (value: string) => void
}) {
  const analysis = selectedResult?.content_analysis
  const analysisReady = analysis?.status === 'completed'
    && Number(analysis.grounded_evidence_count || 0) > 0
  const selectedImages = selectedResult ? resultImages(selectedResult) : []
  const resultItems = Array.isArray(results.items) ? results.items : []
  const resultStats = resultFilterStats(results)
  const completionStats = resultCompletionStats(results)
  return (
    <>
      {results.research ? <section className="content-research-context" aria-label="本次非岗位研究设定">
        <span className="content-research-context-icon"><BrainCircuit size={20} /></span>
        <span className="content-research-context-copy"><small>NON-JOB RESEARCH BRIEF</small><strong>{results.research.label}</strong><p>{results.research.goal || 'AI 将结合关键词、正文、图片和 OCR，动态决定本次研究栏目。'}</p></span>
        <span className="content-research-context-keyword"><small>搜索关键词</small><strong>{results.keyword || '未记录'}</strong></span>
      </section> : null}
      {results.insights ? <section className="content-evidence-insights" aria-label="跨样本证据洞察">
        <header>
          <div><small>CROSS-SAMPLE EVIDENCE</small><h3>跨样本证据洞察</h3><p>{results.insights.methodNote}</p></div>
          <div className="content-insight-metrics"><span><strong>{results.insights.groundedRecords}</strong>可回溯样本</span><span><strong>{results.insights.sourceReady}</strong>原文充足</span><span><strong>{results.insights.coverageRate}%</strong>证据覆盖</span><span><strong>{results.insights.sampleSize}</strong>采集样本</span></div>
        </header>
        {results.insights.topTopics.length > 0 && <div className="content-topic-frequency"><strong>高频主题</strong><div>{results.insights.topTopics.map((topic) => <span key={topic.label}>{topic.label}<b>{topic.count}</b></span>)}</div></div>}
        <div className="content-insight-modules">{results.insights.modules.map((module) => <section key={module.id}>
          <header><div><small>{module.recordCount} 篇有证据 · 覆盖 {module.coverageRate}%</small><h4>{module.title}</h4></div><p>{module.question}</p></header>
          {module.findings.length > 0 ? <ol>{module.findings.map((finding) => <li key={finding.label}><span><strong>{finding.label}</strong><b>{finding.count} 篇</b></span>{finding.evidence[0] && <blockquote>“{finding.evidence[0].quote}”<small>{finding.evidence[0].title}</small></blockquote>}</li>)}</ol> : <p className="content-insight-empty">当前没有通过原文校验的重复发现。</p>}
        </section>)}</div>
      </section> : null}
      <div className="results-control-bar general-results-controls">
        <div className="result-stats" aria-label="内容统计">
          <span><strong>{resultStats.all}</strong>正文已采</span>
          <span className={(resultSort !== 'newest' || resultTimeRange !== 'all') ? 'active-filter-stat' : ''}><strong>{results.total}</strong>筛选结果</span>
          <span className={completionStats.sourcePending ? 'warning' : ''}><strong>{completionStats.sourcePending}</strong>正文待续采</span>
          <span className={resultStats.incomplete ? 'warning' : ''}><strong>{resultStats.incomplete}</strong>待 AI 补全</span>
          <span><strong>{resultStats.withImages}</strong>含图片</span>
          <span><strong>{resultStats.unknown}</strong>日期待确认</span>
        </div>
        <div className="result-controls" aria-busy={resultsLoading}>
          <label><ArrowUpDown size={15} /><span>排序</span><select aria-label="内容时间排序" value={resultSort} disabled={resultsLoading} onChange={(event) => onSort(event.target.value as 'newest' | 'oldest')}><option value="newest">最新发布优先</option><option value="oldest">最早发布优先</option></select></label>
          <label><CalendarClock size={15} /><span>时间</span><select aria-label="内容时间筛选" value={resultTimeRange} disabled={resultsLoading} onChange={(event) => onTimeRange(event.target.value as ApplicationResultsResponse['filters']['timeRange'])}><option value="all">全部时间</option><option value="1">近 24 小时</option><option value="3">近 3 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="unknown">日期待确认</option></select></label>
          {(resultSort !== 'newest' || resultTimeRange !== 'all') && <button className="reset-result-filter" type="button" disabled={resultsLoading} onClick={onReset}><RotateCcw size={15} />重置筛选</button>}
          <button className="complete-missing-button" type="button" disabled={!completionStats.total || completingMissing || resultsLoading} onClick={onComplete}>{completingMissing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{completingMissing ? '正在核对任务' : completionStats.sourcePending ? '续采正文并解析' : '补全缺失分析'}</button>
        </div>
      </div>
      <div className="results-workspace general-content-workspace">
        <div className="result-index">
          <div className="result-index-head"><span>内容列表</span><small>{results.total ? resultOffset + 1 : 0}-{Math.min(resultOffset + resultItems.length, results.total)} / {results.total}</small></div>
          <div className="result-rows">
            {resultItems.map((item) => {
              const itemAnalysis = item.content_analysis
              const score = Number(itemAnalysis?.relevance_score || 0)
              const ready = itemAnalysis?.status === 'completed' && Number(itemAnalysis.grounded_evidence_count || 0) > 0
              return <div key={item.note_id} className={`result-row ${selectedResult?.note_id === item.note_id ? 'selected' : ''}`}>
                <ResultCardMedia noun="内容" result={item} onPreview={(images, index) => onPreview(item.title || '未命名内容', images, index)} />
                <button className="result-card-select" type="button" onClick={() => onSelect(item)} aria-label={`查看内容：${item.title || '未命名内容'}`}>
                  <span className="result-card-copy"><span className="result-card-heading"><strong>{item.title || '未命名内容'}</strong><i className={ready ? 'ready' : ''}>{ready ? `${score} 相关度` : '待分析'}</i></span><small>{item.publish_time?.value || '日期待核验'} · {itemAnalysis?.content_type || '类型待识别'}</small></span>
                </button>
              </div>
            })}
          </div>
          <div className="result-pagination">
            <button title="上一页" disabled={resultOffset === 0 || resultsLoading} onClick={() => onPage(Math.max(0, resultOffset - results.limit))}><ChevronLeft size={16} /></button>
            <button title="下一页" disabled={resultOffset + results.limit >= results.total || resultsLoading} onClick={() => onPage(resultOffset + results.limit)}><ChevronRight size={16} /></button>
          </div>
        </div>
        {selectedResult ? <article className="result-detail general-content-detail">
          <header><div><span>{selectedResult.publish_time?.value || '日期待核验'} · {analysisReady ? (analysis?.content_type || '内容类型待识别') : '内容类型待识别'}</span><h3>{selectedResult.title || '未命名内容'}</h3><small>采集时间 {formatTime(selectedResult.collected_at)} · 与“{results.keyword}”相关度 {analysisReady ? analysis?.relevance_score ?? '-' : '-'} / 100</small></div>{selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer" title="打开原链接"><ExternalLink size={17} /></a>}</header>
          {selectedImages.length > 0 && <section className="result-media" aria-label="采集图片与 AI 理解结果">
            <div className="result-media-heading"><span><Images size={16} /><strong>采集图片</strong><small>{selectedImages.length} 张</small></span><i>{imageAnalysisStatusLabel(selectedResult.media?.analysis?.source)}</i></div>
            <div className="result-media-grid">{selectedImages.map((image, index) => <button key={`${image.url}-${index}`} type="button" onClick={() => onPreview(selectedResult.title || '未命名内容', selectedImages, index)} title={image.alt || `查看第 ${index + 1} 张图片`}><RetryingImage image={image} alt={image.alt || `${selectedResult.title || '内容'}图片 ${index + 1}`} loading="lazy" /><small>{imageSourceLabel(image.source)}</small><span><Maximize2 size={13} /></span></button>)}</div>
            <AiSectionBoundary resetSignal={selectedResult.media?.analysis} fallback={<AiSectionUnavailable label="图片理解" />}>
              <div className="image-analysis"><strong>图片信息理解</strong><p>{selectedResult.media?.analysis?.summary || '已保存原图，等待视觉模型读取。'}</p>{selectedResult.media?.analysis?.visible_text?.trim() && <div className="image-analysis-transcript"><div><span><strong>图片识别正文</strong><small>按原有换行展示</small></span><button type="button" title="复制图片识别正文" onClick={() => onCopy(selectedResult.media?.analysis?.visible_text?.trim() || '')}><Copy size={14} /></button></div><pre>{selectedResult.media?.analysis?.visible_text?.trim()}</pre></div>}</div>
            </AiSectionBoundary>
          </section>}
          <AiSectionBoundary resetSignal={analysis} fallback={<AiSectionUnavailable label="AI 内容结构" />}>
            {!analysisReady && <section className="content-evidence-warning"><WandSparkles size={17} /><span><strong>当前结论未通过证据门禁</strong><small>{analysis?.status === 'insufficient_source' ? '正文和图片可读信息过少，需要继续采集后再分析。' : analysis?.status === 'ungrounded' ? '模型引用无法在原始图文中复核，已撤销相关度分数。' : '分析尚未完成，可从检查点继续补全。'}</small></span></section>}
            <section className="general-overview"><div><span>AI CONTENT BRIEF</span><h4>内容概览</h4></div><p>{analysisReady ? (analysis?.overview || '等待 AI 根据关键词、正文与图片生成概览。') : '等待 AI 根据可回溯的原文与图片证据重新生成。'}</p>{analysisReady && analysis?.relevance_reason && <small>{analysis.relevance_reason}</small>}</section>
            {analysisReady && (analysis?.topics?.length || analysis?.entities?.length) ? <div className="content-taxonomy">{analysis?.topics?.length ? <section><h4>主题</h4><div>{analysis.topics.map((topic) => <span key={topic}>{topic}</span>)}</div></section> : null}{analysis?.entities?.length ? <section><h4>实体与对象</h4><div>{analysis.entities.map((entity) => <span key={entity}>{entity}</span>)}</div></section> : null}</div> : null}
            <div className="content-module-grid">{analysisReady && analysis?.modules?.length ? analysis.modules.map((module) => <section className="content-module" key={module.id}><div><BookOpenCheck size={16} /><h4>{module.title}</h4></div><p>{module.summary}</p>{module.items.length > 0 && <ul>{module.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}{module.evidence.length > 0 && <details><summary>查看原文依据</summary>{module.evidence.map((item, index) => <blockquote key={`${item}-${index}`}>{item}</blockquote>)}</details>}</section>) : <section className="content-module pending"><LoaderCircle size={18} /><h4>等待动态栏目分析</h4><p>AI 会根据本次关键词决定栏目，而不是套用岗位模板。</p></section>}</div>
            {analysisReady && analysis?.image_insights?.length ? <section className="image-insight-list"><h4>图片线索</h4><ul>{analysis.image_insights.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section> : null}
          </AiSectionBoundary>
          <section className="body-section general-body" aria-label="采集正文"><div><h4>采集正文</h4><button type="button" title="复制采集正文" aria-label="复制采集正文" disabled={!selectedResult.body?.trim()} onClick={() => onCopy(selectedResult.body || '')}><Copy size={14} /></button></div>{selectedResult.body?.trim() ? <pre className="body-text-block">{selectedResult.body.trim()}</pre> : <p className="body-empty">正文尚未采集；已保留图片和卡片文字供 AI 分析。</p>}</section>
        </article> : <div className="result-empty"><FileText size={28} /><strong>选择一条内容查看 AI 分析</strong></div>}
      </div>
    </>
  )
}

type GeneralResultModule = WorkspaceView
type HistoryScope = 'all' | AnalysisMode

function audienceStatusLabel(status: AudienceResultsResponse['summary']['status']) {
  return status === 'complete' ? '全量完成' : status === 'partial' ? '部分完成' : status === 'failed' ? '采集失败' : '等待采集'
}

type AudiencePostCollectionState = 'uncollected' | 'partial' | 'complete'

function audiencePostCollectionState(post: AudiencePost): AudiencePostCollectionState {
  if (post.collectionStatus) return post.collectionStatus
  if (post.status === 'complete') return 'complete'
  if (post.status === 'partial' || post.status === 'failed' || Number(post.collected_comment_count || 0) > 0) return 'partial'
  return 'uncollected'
}

function audiencePostCollectionLabel(state: AudiencePostCollectionState) {
  return state === 'complete' ? '已完成' : state === 'partial' ? '部分完成' : '未完成'
}

function audienceMetric(value: number | null | undefined) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '-'
}

function audienceProfileStatusLabel(user: AudiencePublicProfile) {
  const missing = [
    typeof user.follower_count !== 'number' ? '粉丝' : '',
    typeof user.following_count !== 'number' ? '关注' : '',
    typeof user.liked_and_collected_count !== 'number' ? '互动' : '',
  ].filter(Boolean)
  if (missing.length > 0) return `${missing.join('、')}待续采`
  return user.enrichment_status === 'complete' ? '公开资料已采集' : '资料待续采'
}

function audienceStopReasonLabel(reason: string | null | undefined) {
  if (!reason) return ''
  const labels: Record<string, string> = {
    rate_limited: '平台限流，自动恢复重试已耗尽并保存检查点',
    security_verification: '等待完成页面安全验证',
    cancelled: '任务已取消，检查点仍然保留',
    interrupted: '任务被中断，检查点仍然保留',
  }
  return labels[reason] || reason
}

function AudienceAvatar({ user }: { user: AudiencePublicProfile }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [user.avatar_url])
  const initial = user.display_name?.trim().slice(0, 1) || '用'
  return <span className="audience-avatar">{user.avatar_url && !failed
    ? <img src={user.avatar_url} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <b>{initial}</b>}</span>
}

function audienceCommentUser(comment: AudienceComment): AudiencePublicProfile {
  const persistedComment = comment as AudienceComment & { user?: AudiencePublicProfile; user_id?: string }
  return persistedComment.user || {
    user_id: persistedComment.user_id || '',
    display_name: '未命名用户',
    profile_url: '',
    avatar_url: '',
    xhs_id: '',
    bio: '',
    location: '',
    following_count: null,
    follower_count: null,
    liked_and_collected_count: null,
    roles: [],
    comment_count: 0,
    post_ids: [],
    enrichment_status: 'pending',
    access_status: 'discovered',
    last_enriched_at: '',
  }
}

function audienceAiOverviewStatus(value: Awaited<ReturnType<typeof api.audienceAi>>): AudienceAiStatus {
  const candidate = value as typeof value & { overview?: typeof value }
  const overview = candidate.overview || candidate
  return overview.currentRun?.status || overview.activeVersion?.status || overview.status || 'not_started'
}

function audienceAiPostStatusLabel(status: AudienceAiStatus) {
  if (status === 'snapshotting') return '准备中'
  if (['waiting_profile_enrichment', 'collecting_profile_headers', 'collecting_profile_posts'].includes(status)) return '等待主页补采'
  if (['analyzing_comments', 'analyzing_users'].includes(status)) return '分析中'
  if (['synthesizing', 'validating', 'exporting', 'cancelling'].includes(status)) return '正在归并'
  const labels: Partial<Record<AudienceAiStatus, string>> = {
    not_started: '未分析',
    partial: '部分完成',
    completed: '已完成',
    stale: '需更新',
    blocked: '已阻断',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '可继续',
  }
  return labels[status] || status
}

function audienceEntityDomId(kind: 'comments' | 'users', entityId: string) {
  return `audience-${kind}-${encodeURIComponent(entityId)}`
}

function AudienceWorkspace({
  jobId,
  results,
  loading,
  task,
  aiSession,
  audienceAiEnabled,
  anchorTarget,
  actionMessage,
  kind,
  postId,
  query,
  pageSize,
  resuming,
  growing,
  growthScrolls,
  onKind,
  onPost,
  onQuery,
  onPageSize,
  onPage,
  onResume,
  onGrowthScrolls,
  onGrow,
  onConfigureAi,
  onNavigateEvidence,
}: {
  jobId: string
  results: AudienceResultsResponse | null
  loading: boolean
  task: Job | null
  aiSession: AiSession | null
  audienceAiEnabled: boolean
  anchorTarget: AudienceAnchorTarget | null
  actionMessage: string | null
  kind: 'comments' | 'users'
  postId: string
  query: string
  pageSize: number
  resuming: boolean
  growing: boolean
  growthScrolls: number
  onKind: (kind: 'comments' | 'users') => void
  onPost: (postId: string) => void
  onQuery: (query: string) => void
  onPageSize: (pageSize: number) => void
  onPage: (offset: number) => void
  onResume: () => void
  onGrowthScrolls: (maxScrolls: number) => void
  onGrow: () => void
  onConfigureAi: () => void
  onNavigateEvidence: (target: { kind: 'comments' | 'users'; entityId: string; anchor: AudienceAiAnchor }) => void
}) {
  const [aiPanelPostId, setAiPanelPostId] = useState('')
  const [aiStatuses, setAiStatuses] = useState<Record<string, AudienceAiStatus>>({})
  const aiButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const summary = results?.summary
  const posts = results?.posts || []
  const postIds = posts.map((post) => post.post_id).join('|')
  const aiPanelPost = posts.find((post) => post.post_id === aiPanelPostId) || null

  useEffect(() => {
    if (audienceAiEnabled) return
    setAiPanelPostId('')
    setAiStatuses({})
  }, [audienceAiEnabled])

  useEffect(() => {
    if (aiPanelPostId && !posts.some((post) => post.post_id === aiPanelPostId)) setAiPanelPostId('')
  }, [aiPanelPostId, postIds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!audienceAiEnabled || !jobId || !postIds) return
    let cancelled = false
    void (async () => {
      const entries: Array<readonly [string, AudienceAiStatus | null]> = []
      let cursor = 0
      let endpointUnavailable = false
      const worker = async () => {
        while (!cancelled && !endpointUnavailable) {
          const post = posts[cursor]
          cursor += 1
          if (!post) return
          try {
            entries.push([post.post_id, audienceAiOverviewStatus(await api.audienceAi(jobId, post.post_id))])
          } catch (error) {
            if (Number((error as Error & { status?: number }).status) === 404) endpointUnavailable = true
            else entries.push([post.post_id, null])
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, posts.length) }, worker))
      if (cancelled) return
      setAiStatuses((current) => {
        const next = { ...current }
        if (endpointUnavailable) for (const post of posts) next[post.post_id] = 'not_started'
        for (const [id, status] of entries) if (status) next[id] = status
        return next
      })
    })()
    return () => { cancelled = true }
  }, [audienceAiEnabled, jobId, postIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeAiPanel = () => {
    const closingPostId = aiPanelPostId
    setAiPanelPostId('')
    window.requestAnimationFrame(() => aiButtonRefs.current.get(closingPostId)?.focus())
  }
  const postsTotal = summary?.postsTotal ?? posts.length
  const postsAttempted = typeof summary?.postsAttempted === 'number'
    ? summary.postsAttempted
    : posts.filter((post) => audiencePostCollectionState(post) !== 'uncollected').length
  const postsWithComments = typeof summary?.postsWithComments === 'number'
    ? summary.postsWithComments
    : posts.filter((post) => Number(post.collected_comment_count || 0) > 0).length
  const incomplete = !summary || summary.status !== 'complete'
  const statusClass = summary?.status || 'pending'
  const selectedResults = results?.kind === kind ? results : null
  const changingKind = Boolean(results && !selectedResults)
  const items = selectedResults?.items || []
  const offset = selectedResults?.offset || 0
  const limit = selectedResults?.limit || 40
  const selectedTotal = selectedResults?.total ?? results?.totals[kind] ?? 0
  const postStateCounts = posts.reduce<Record<AudiencePostCollectionState, number>>((counts, post) => {
    counts[audiencePostCollectionState(post)] += 1
    return counts
  }, { uncollected: 0, partial: 0, complete: 0 })
  const audienceTask = task?.config?.audienceOnly || task?.config?.collectAudience ? task : null
  const taskActive = Boolean(audienceTask && ['queued', 'resuming', 'running'].includes(audienceTask.status))
  const taskGrowing = Boolean(taskActive && audienceTask?.config?.discoverMore)
  const taskMessage = taskActive ? (audienceTask?.progressLabel || actionMessage) : actionMessage
  const rateLimited = summary?.stopReason === 'rate_limited'
  return <div className="audience-workspace">
    <section className="audience-summary-band" aria-label="受众采集覆盖率">
      <div className={`audience-status ${statusClass}`}><Activity size={17} /><span><small>采集状态</small><strong>{audienceStatusLabel(statusClass)}</strong></span></div>
      <dl>
        <div><dt>已检查帖子</dt><dd>{audienceMetric(postsAttempted)}<small> 篇 / {audienceMetric(postsTotal)}</small></dd></div>
        <div><dt>有评论结果</dt><dd>{audienceMetric(postsWithComments)}<small> 篇</small></dd></div>
        <div><dt>评论与回复</dt><dd>{audienceMetric(summary?.commentsCollected)}<small> 条</small></dd></div>
        <div><dt>独立用户</dt><dd>{audienceMetric(summary?.usersDiscovered)}<small> 位</small></dd></div>
        <div><dt>主页已补全</dt><dd>{audienceMetric(summary?.profilesComplete)}<small> 位 / {audienceMetric(summary?.usersDiscovered)}</small></dd></div>
      </dl>
      {incomplete && <button type="button" className="audience-resume-button" disabled={resuming || growing} onClick={onResume}>{resuming ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{taskGrowing ? '正在扩充帖子池' : taskActive ? (audienceTask?.status === 'queued' ? '刷新排队状态' : '刷新采集状态') : results?.available ? '继续补采未完成帖子' : '开始采集评论与用户'}</button>}
      <div className="audience-growth-controls">
        <label><span>扩量轮次</span><select value={growthScrolls} disabled={resuming || growing || loading || taskActive} onChange={(event) => onGrowthScrolls(Number(event.target.value))}><option value={40}>40 轮</option><option value={60}>60 轮</option><option value={100}>100 轮</option></select></label>
        <button type="button" className="audience-grow-button" disabled={resuming || growing || loading || taskActive} onClick={onGrow}>{growing || taskGrowing ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{taskGrowing ? (audienceTask?.status === 'queued' ? '扩量任务已排队' : '正在发现更多帖子') : '继续发现更多帖子'}</button>
      </div>
    </section>
    {taskMessage && <div className={`audience-action-status ${taskActive ? 'active' : ''}`} role="status" aria-live="polite">{taskActive && <LoaderCircle className="spin" size={15} />}<span>{taskMessage}</span></div>}
    {incomplete && <div className={`audience-coverage-callout ${statusClass}`} role="status"><CircleAlert size={17} /><span><strong>{rateLimited ? '平台限流，自动恢复重试已耗尽' : '当前结果尚未证明全量完成'}</strong><small>{rateLimited ? `系统已自动冷却并多次探测恢复，当前已检查 ${audienceMetric(postsAttempted)} / ${audienceMetric(postsTotal)} 篇，检查点完整保留。平台恢复后点击继续补采，未完成帖子会优先处理。` : `${summary?.stopReason ? `停止原因：${audienceStopReasonLabel(summary.stopReason)}。` : '未完成和部分完成帖子仍待补采。'} 已保存的帖子、评论和用户结果会继续保留。`}</small></span></div>}
    <p className="audience-data-scope"><ShieldCheck size={14} />仅整理帖子和公开主页中可见的评论与用户字段，不推断联系方式或私密属性。</p>
    {posts.length > 0 && <section className="audience-post-coverage" aria-label="内容洞察帖子采集状态">
      <header>
        <div><span>内容洞察已有帖子</span><strong>{audienceMetric(posts.length)}</strong></div>
        <dl>
          <div className="uncollected"><dt>未完成</dt><dd>{audienceMetric(postStateCounts.uncollected)}</dd></div>
          <div className="partial"><dt>部分完成</dt><dd>{audienceMetric(postStateCounts.partial)}</dd></div>
          <div className="complete"><dt>已完成</dt><dd>{audienceMetric(postStateCounts.complete)}</dd></div>
        </dl>
      </header>
      <div className="audience-post-list">
        {posts.map((post) => {
          const state = audiencePostCollectionState(post)
          const aiStatus = aiStatuses[post.post_id] || 'not_started'
          const aiOpen = aiPanelPostId === post.post_id
          const aiDisabled = Number(post.collected_comment_count || 0) === 0
          const expectedCount = typeof post.expected_comment_count === 'number' ? post.expected_comment_count : null
          return <article key={post.post_id} className={`audience-post-entry ${postId === post.post_id ? 'active' : ''} ${aiOpen ? 'ai-open' : ''}`}>
            <button type="button" className="audience-post-select" aria-pressed={postId === post.post_id} onClick={() => onPost(postId === post.post_id ? '' : post.post_id)}>
              <span className={`audience-post-state ${state}`}>{audiencePostCollectionLabel(state)}</span>
              <span className="audience-post-copy"><strong>{post.title || '未命名原帖'}</strong><small>{audienceMetric(post.collected_comment_count || 0)} 条评论与回复{expectedCount === null ? '' : ` / 页面显示 ${audienceMetric(expectedCount)}`}</small></span>
              {post.note_url && <ExternalLink size={14} aria-hidden="true" />}
            </button>
            {audienceAiEnabled && <button
              type="button"
              className={`audience-post-ai ${aiStatus}`}
              aria-expanded={aiOpen}
              aria-controls={aiOpen ? 'audience-ai-panel' : undefined}
              aria-label={`${post.title || '该帖'}：结合原帖分析该帖评论与用户`}
              title={aiDisabled ? '该帖尚无已采集评论' : '结合原帖分析该帖评论与用户'}
              disabled={aiDisabled}
              ref={(node) => { if (node) aiButtonRefs.current.set(post.post_id, node); else aiButtonRefs.current.delete(post.post_id) }}
              onClick={() => {
                onPost(post.post_id)
                setAiPanelPostId((current) => current === post.post_id ? '' : post.post_id)
              }}
            >
              <Sparkles size={14} />
              <span>AI 分析</span>
              <i>{aiDisabled ? '无评论' : audienceAiPostStatusLabel(aiStatus)}</i>
            </button>}
          </article>
        })}
      </div>
    </section>}
    {audienceAiEnabled && aiPanelPost && <div id="audience-ai-panel"><AudienceAiPanel
      jobId={jobId}
      post={aiPanelPost}
      aiSession={aiSession}
      onClose={closeAiPanel}
      onConfigureAi={onConfigureAi}
      onNavigateEvidence={onNavigateEvidence}
      onStatusChange={(targetPostId, status) => setAiStatuses((current) => ({ ...current, [targetPostId]: status }))}
    /></div>}
    <div className="audience-toolbar">
      <div className="audience-view-switch" role="tablist" aria-label="受众数据视图">
        <button type="button" role="tab" aria-selected={kind === 'comments'} className={kind === 'comments' ? 'active' : ''} onClick={() => onKind('comments')}><MessagesSquare size={16} />评论流 <b>{audienceMetric(results?.totals.comments)} 条</b></button>
        <button type="button" role="tab" aria-selected={kind === 'users'} className={kind === 'users' ? 'active' : ''} onClick={() => onKind('users')}><UsersRound size={16} />用户卡 <b>{audienceMetric(results?.totals.users)} 位</b></button>
      </div>
      <label className="audience-post-filter"><span>原帖</span><select aria-label="按原帖筛选受众" value={postId} onChange={(event) => onPost(event.target.value)}><option value="">全部原帖</option>{posts.map((post) => <option key={post.post_id} value={post.post_id}>{audiencePostCollectionLabel(audiencePostCollectionState(post))} · {post.title} · {post.collected_comment_count || 0} 条</option>)}</select></label>
      <label className="audience-search"><Search size={15} /><input aria-label="搜索评论或用户" value={query} placeholder={kind === 'comments' ? '搜索评论、昵称或地区' : '搜索昵称、小红书号或简介'} onChange={(event) => onQuery(event.target.value)} /></label>
    </div>
    <div className="audience-results-meta"><span>{postId ? '当前原帖' : '全部原帖'} · {kind === 'comments' ? '评论与楼中楼回复' : '原帖主与评论者'}</span><strong>{audienceMetric(selectedTotal)} {kind === 'comments' ? '条评论' : '位用户'}</strong></div>
    {(loading || changingKind) && items.length === 0 ? <div className="result-empty audience-empty"><LoaderCircle className="spin" size={28} /><strong>正在读取受众数据</strong></div> : items.length === 0 ? <div className="result-empty audience-empty"><UserRoundSearch size={28} /><strong>{selectedResults?.available ? '当前筛选没有结果' : '尚未采集评论与用户信息'}</strong><small>{selectedResults?.available ? '调整原帖或搜索条件后重试。' : '点击上方按钮从已保存帖子检查点开始采集。'}</small></div> : kind === 'comments' ? <div className="audience-comment-list">{(items as AudienceComment[]).map((comment) => {
      const user = audienceCommentUser(comment)
      return <article id={audienceEntityDomId('comments', comment.comment_id)} tabIndex={-1} className={`audience-comment ${comment.level === 'reply' ? 'is-reply' : ''} ${anchorTarget?.kind === 'comments' && anchorTarget.entityId === comment.comment_id ? 'evidence-target' : ''}`} key={comment.comment_id}>
        <AudienceAvatar user={user} />
        <div><header><span><strong>{user.display_name || '未命名用户'}</strong>{comment.level === 'reply' && <i>回复</i>}{user.roles?.includes('author') && <i className="author">原帖主</i>}</span>{user.profile_url && <a href={user.profile_url} target="_blank" rel="noreferrer" title="打开公开主页"><ExternalLink size={14} /></a>}</header><p>{comment.text}</p><footer><span>{comment.post_title || '未命名原帖'}</span><small>{comment.publish_time || '时间未显示'}{(comment.ip_location || comment.location) ? ` · IP属地：${comment.ip_location || comment.location}` : ''}{comment.likes ? ` · ${comment.likes} 赞` : ''}</small></footer></div>
      </article>
    })}</div> : <div className="audience-user-grid">{(items as AudiencePublicProfile[]).map((user) => <article id={audienceEntityDomId('users', user.user_id)} tabIndex={-1} className={`audience-user-card ${user.roles?.includes('author') ? 'author' : 'commenter'} ${anchorTarget?.kind === 'users' && anchorTarget.entityId === user.user_id ? 'evidence-target' : ''}`} key={user.user_id}>
      <header><AudienceAvatar user={user} /><div><strong>{user.display_name || '未命名用户'}</strong><span>{user.roles?.includes('author') && <i className="author">原帖主</i>}{user.roles?.includes('commenter') && <i>评论者</i>}</span></div>{user.profile_url && <a href={user.profile_url} target="_blank" rel="noreferrer" title="打开公开主页"><ExternalLink size={15} /></a>}</header>
      <p>{user.bio || '公开主页未显示简介'}</p>
      <dl><div><dt>粉丝</dt><dd>{audienceMetric(user.follower_count)}</dd></div><div><dt>关注</dt><dd>{audienceMetric(user.following_count)}</dd></div><div><dt>互动</dt><dd>{audienceMetric(user.liked_and_collected_count)}</dd></div><div><dt>评论</dt><dd>{audienceMetric(user.comment_count)}</dd></div></dl>
      <footer><span>{user.xhs_id ? `小红书号 ${user.xhs_id}` : '小红书号未公开'}</span><small>IP属地：{user.ip_location || '待采集'} · {audienceProfileStatusLabel(user)}</small></footer>
    </article>)}</div>}
    {selectedResults && selectedResults.total > 0 && <div className="audience-pagination">
      <span>{offset + 1}-{Math.min(offset + items.length, selectedResults.total)} / {selectedResults.total}</span>
      <div className="audience-pagination-controls">
        <label className="audience-page-size"><span>每页</span><select aria-label="每页显示条数" value={pageSize} disabled={loading} onChange={(event) => onPageSize(Number(event.target.value))}>{[20, 40, 100, 200, 500].map((size) => <option key={size} value={size}>{size}</option>)}</select><span>条</span></label>
        <div className="audience-page-buttons"><button type="button" title="上一页" disabled={offset === 0 || loading} onClick={() => onPage(Math.max(0, offset - limit))}><ChevronLeft size={16} /></button><button type="button" title="下一页" disabled={offset + limit >= selectedResults.total || loading} onClick={() => onPage(offset + limit)}><ChevronRight size={16} /></button></div>
      </div>
    </div>}
  </div>
}

function StatusPill({ status, label }: { status: JobStatus; label?: string }) {
  return <span className={`status-pill status-${status}`}><i />{label || statusText[status]}</span>
}

function MissingCompletionFlowPanel({ flow, job, noun, onDismiss }: {
  flow: MissingCompletionFlow
  job: Job | null
  noun: string
  onDismiss: () => void
}) {
  const stageIndex: Record<MissingCompletionStage, number> = {
    checking: 0,
    restoring_ai: 1,
    starting: 2,
    running: 2,
    refreshing: 3,
    complete: 4,
    needs_attention: 3,
  }
  const steps = ['核对缺失项', '连接 AI', '补采并重建', '刷新结果']
  const currentIndex = stageIndex[flow.stage]
  const running = ['checking', 'restoring_ai', 'starting', 'running', 'refreshing'].includes(flow.stage)
  const progress = Math.max(0, Math.min(100, Number(job?.progress || (flow.stage === 'complete' ? 100 : 0))))
  return (
    <section className={`missing-completion-flow ${flow.stage}`} aria-live="polite" aria-label={`一键补全${noun}流程`}>
      <div className="missing-completion-summary">
        <span className="missing-completion-icon">{running ? <LoaderCircle className="spin" size={17} /> : flow.stage === 'complete' ? <Check size={17} /> : <CircleAlert size={17} />}</span>
        <span><strong>{flow.stage === 'complete' ? '智能补全已完成' : flow.stage === 'needs_attention' ? '智能补全需要处理' : `正在补全${noun}`}</strong><small>{flow.message}</small></span>
        {!running && <button type="button" onClick={onDismiss} title="关闭补全流程状态" aria-label="关闭补全流程状态"><X size={15} /></button>}
      </div>
      <ol className="missing-completion-steps">
        {steps.map((label, index) => {
          const done = flow.stage === 'complete' || index < currentIndex
          const current = running && index === currentIndex
          return <li key={label} className={done ? 'done' : current ? 'current' : ''}><span>{done ? <Check size={12} /> : index + 1}</span><small>{label}</small></li>
        })}
      </ol>
      {running && <div className="missing-completion-progress"><i style={{ width: `${progress}%` }} /><span>{job?.progressLabel || `正在处理${flow.incompleteBefore ?? ''}条缺失记录`}</span><strong>{progress}%</strong></div>}
    </section>
  )
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

function replaceJobInPlace(jobs: Job[], next: Job) {
  const index = jobs.findIndex((job) => job.id === next.id)
  if (index < 0) return [next, ...jobs]
  return jobs.map((job, itemIndex) => itemIndex === index ? mergeJobUpdate(job, next) : job)
}

function nonWhitespaceCharacterCount(value: string): number {
  return Array.from(value.replace(/\s/gu, '')).length
}

function mergeJobUpdate(current: Job, next: Job) {
  const currentRevision = Number(current.revision)
  const nextRevision = Number(next.revision)
  if (Number.isFinite(currentRevision) && Number.isFinite(nextRevision) && nextRevision < currentRevision) return current
  return {
    ...next,
    experienceSnapshot: next.experienceSnapshot ?? current.experienceSnapshot,
    workflowSnapshot: next.workflowSnapshot ?? current.workflowSnapshot,
  }
}

function newResumeIdempotencyKey(jobId: string, scope: ResumeScope) {
  const unique = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${jobId}:${scope}:${unique}`
}

function isAudienceOnlyJob(job: Job | null | undefined) {
  return Boolean(job?.config?.audienceOnly && job.config.resumeFromJobId)
}

function audienceSourceJobIdFor(job: Job | null | undefined, jobs: Job[] = []) {
  if (!job) return null
  let current = job
  const visited = new Set<string>()
  while (isAudienceOnlyJob(current) && !visited.has(current.id)) {
    visited.add(current.id)
    const parentId = current.config?.resumeFromJobId
    if (!parentId) break
    const parent = jobs.find((candidate) => candidate.id === parentId)
    if (!parent) return parentId
    current = parent
  }
  return current.id
}

function audienceSourceJobFor(jobs: Job[], job: Job | null | undefined) {
  const sourceJobId = audienceSourceJobIdFor(job, jobs)
  return sourceJobId ? jobs.find((candidate) => candidate.id === sourceJobId) || job || null : null
}

function audienceTaskForSource(jobs: Job[], sourceJobId: string | null) {
  if (!sourceJobId) return null
  const candidates = jobs.filter((job) => (
    isAudienceOnlyJob(job) && audienceSourceJobIdFor(job, jobs) === sourceJobId
  ))
  return candidates.find((job) => ['queued', 'resuming', 'running'].includes(job.status)) || candidates[0] || null
}

function audienceSnapshotRegressed(current: AudienceResultsResponse, next: AudienceResultsResponse) {
  if (!next.available) return true
  return next.total < current.total
    || next.posts.length < current.posts.length
    || next.totals.posts < current.totals.posts
    || next.totals.comments < current.totals.comments
    || next.totals.users < current.totals.users
    || next.summary.postsTotal < current.summary.postsTotal
    || next.summary.commentsCollected < current.summary.commentsCollected
    || next.summary.usersDiscovered < current.summary.usersDiscovered
}

type ApplicationView = 'jobs' | 'batch'

function workspaceModeFromLocation(): AnalysisMode {
  if (typeof window === 'undefined') return 'job'
  return window.location.pathname.replace(/\/+$/, '') === '/content' ? 'general' : 'job'
}

function applicationViewFromLocation(): ApplicationView {
  if (typeof window === 'undefined') return 'jobs'
  return window.location.pathname.replace(/\/+$/, '') === '/batch' ? 'batch' : 'jobs'
}

function workspacePath(mode: AnalysisMode, applicationView: ApplicationView = 'jobs') {
  if (mode === 'general') return '/content'
  return applicationView === 'batch' ? '/batch' : '/'
}

function generalResultModuleFromLocation(): GeneralResultModule {
  if (typeof window === 'undefined') return 'insights'
  const module = new URLSearchParams(window.location.search).get('module')
  return module === 'audience' || module === 'expansion' ? module : 'insights'
}

function audienceDataJobIdFromLocation() {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('job') || ''
}

function writeAudienceDataJobToLocation(jobId: string) {
  const url = new URL(window.location.href)
  if (jobId) url.searchParams.set('job', jobId)
  else url.searchParams.delete('job')
  window.history.replaceState(window.history.state || {}, '', `${url.pathname}${url.search}${url.hash}`)
}

async function findBestAudienceDataJob(jobs: Job[], preferredJobId = '', sourceJobId: string | null = null) {
  const generalJobs = jobs.filter((job) => jobAnalysisMode(job) === 'general')
  const linkedJobs = sourceJobId
    ? generalJobs.filter((job) => audienceSourceJobIdFor(job, generalJobs) === sourceJobId)
    : generalJobs
  const ordered = [
    ...generalJobs.filter((job) => job.id === preferredJobId),
    ...linkedJobs.filter((job) => job.id !== preferredJobId),
    ...generalJobs.filter((job) => job.id !== preferredJobId && !linkedJobs.some((linked) => linked.id === job.id)),
  ]
  const inspected = await Promise.all(ordered.map(async (job) => {
    try {
      return { job, payload: await api.audience(job.id, 'comments', 0, 1) }
    } catch {
      return null
    }
  }))
  return inspected.find((entry) => entry && entry.payload.totals.comments > 0)?.job
    || inspected.find((entry) => entry && entry.payload.available)?.job
    || null
}

const legacyJobIntentPattern = /(?:岗位|职位|招聘|招募|求职|应聘|内推|校招|社招|实习|面试|简历|job|jobs|hiring|hire|career|careers|recruit|recruitment|intern|internship|position|vacancy)/i

function jobAnalysisMode(job: Job): AnalysisMode {
  if (job.config?.analysisMode === 'general' || job.config?.analysisMode === 'job') {
    return job.config.analysisMode
  }
  return legacyJobIntentPattern.test(job.keyword || '') ? 'job' : 'general'
}

function isIncompleteApplicationResult(result: ApplicationResult) {
  if (!result.body.trim()) return true

  const runtimeStatus = result.outreach?.runtime_status || ''
  if ([
    'fallback_missing_job_body',
    'image_enriched_missing_job_body',
    'fallback_model_error',
    'quality_threshold_not_met',
    'fact_validation_failed',
    'fact_validation_needs_human_review',
  ].includes(runtimeStatus)) return true
  const verifiedImageEnrichment = result.media?.analysis?.status === 'analyzed'
    && result.media?.analysis?.source === 'vision_model'
    && result.job_card?.enrichment_status === 'image_enriched'
    && ['responsibilities', 'requirements', 'application_routes'].some((field) => {
      const values = result.application_info[field as keyof typeof result.application_info]
      return Array.isArray(values) && values.length > 0
    })
  if (verifiedImageEnrichment) return false
  const hasUnmergedVerifiedImageText = result.media?.analysis?.status === 'analyzed'
    && result.media?.analysis?.source === 'vision_model'
    && Boolean(result.media?.analysis?.visible_text?.trim())
  return hasUnmergedVerifiedImageText
    || result.job_card?.parse_basis === 'search_card'
}

function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [workspaceMode, setWorkspaceMode] = useState<AnalysisMode>(() => workspaceModeFromLocation())
  const [applicationView, setApplicationView] = useState<ApplicationView>(() => applicationViewFromLocation())
  const [generalResultModule, setGeneralResultModule] = useState<GeneralResultModule>(() => generalResultModuleFromLocation())
  const requestCache = useRef<Record<AnalysisMode, JobRequest>>({
    job: { ...defaultRequest, analysisMode: 'job', candidateProfile: loadCandidateProfile() },
    general: { ...defaultRequest, analysisMode: 'general', keyword: '', useCodexRuntime: true, collectAudience: true, candidateProfile: loadCandidateProfile() },
  })
  const [request, setRequest] = useState<JobRequest>(() => ({ ...requestCache.current[workspaceMode] }))
  const [health, setHealth] = useState<Health | null>(null)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [relayConfig, setRelayConfig] = useState<RelayConfig>(defaultRelayConfig)
  const [relayConfigSaving, setRelayConfigSaving] = useState(false)
  const [relayGuideOpen, setRelayGuideOpen] = useState(false)
  const [relayRecovering, setRelayRecovering] = useState(false)
  const [relayRecovery, setRelayRecovery] = useState<RelayRecoveryResult | null>(null)
  const [relayLoginOpening, setRelayLoginOpening] = useState(false)
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfig>(defaultSmtpConfig)
  const [smtpPassword, setSmtpPassword] = useState('')
  const [smtpOAuthClientSecret, setSmtpOAuthClientSecret] = useState('')
  const [smtpOAuthRefreshToken, setSmtpOAuthRefreshToken] = useState('')
  const [smtpManualMode, setSmtpManualMode] = useState(false)
  const [smtpGuideProvider, setSmtpGuideProvider] = useState<SmtpGuideProvider>('163')
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [activeJob, setActiveJob] = useState<Job | null>(null)
  const [jobConnectionState, setJobConnectionState] = useState<WorkflowConnectionState>('offline')
  const [jobLastEventAt, setJobLastEventAt] = useState<string | null>(null)
  const [dataCopilotOpen, setDataCopilotOpen] = useState(false)
  const [historyScope, setHistoryScope] = useState<HistoryScope>('all')
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(50)
  const activeJobIdCache = useRef<Record<AnalysisMode, string | null>>({ job: null, general: null })
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null)
  const [results, setResults] = useState<ApplicationResultsResponse | null>(null)
  const [selectedResult, setSelectedResult] = useState<ApplicationResult | null>(null)
  const [applicationAttachments, setApplicationAttachments] = useState<ApplicationAttachmentList | null>(null)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const [artifactAttachmentId, setArtifactAttachmentId] = useState('')
  const [profileAttachmentSource, setProfileAttachmentSource] = useState('')
  const [applicationToneOverrides, setApplicationToneOverrides] = useState<Record<string, ApplicationTone>>({})
  const [emailPreview, setEmailPreview] = useState<EmailPreview | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentSourceRef = useRef<ApplicationAttachment['source']>('uploaded')
  const replacementAttachmentRef = useRef<string | null>(null)
  const draftDirtyRef = useRef(false)
  const [coverLetterRewriteOpen, setCoverLetterRewriteOpen] = useState(false)
  const [coverLetterRewriteInstructions, setCoverLetterRewriteInstructions] = useState('')
  const [coverLetterUseLocalModel, setCoverLetterUseLocalModel] = useState(false)
  const [coverLetterRewriting, setCoverLetterRewriting] = useState(false)
  const [coverLetterRewriteError, setCoverLetterRewriteError] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [deliveryUpdating, setDeliveryUpdating] = useState(false)
  const [resultOffset, setResultOffset] = useState(0)
  const [resultsLoading, setResultsLoading] = useState(false)
  const [resultSort, setResultSort] = useState<'newest' | 'oldest'>('newest')
  const [resultTimeRange, setResultTimeRange] = useState<'all' | '1' | '3' | '7' | '30' | '90' | 'unknown'>('all')
  const [audienceResults, setAudienceResults] = useState<AudienceResultsResponse | null>(null)
  const [audienceTask, setAudienceTask] = useState<Job | null>(null)
  const [audienceDataJobId, setAudienceDataJobId] = useState('')
  const [audienceKind, setAudienceKind] = useState<'comments' | 'users'>('comments')
  const [audiencePostId, setAudiencePostId] = useState('')
  const [audienceQuery, setAudienceQuery] = useState('')
  const [audienceOffset, setAudienceOffset] = useState(0)
  const [audiencePageSize, setAudiencePageSize] = useState(40)
  const [audienceLoading, setAudienceLoading] = useState(false)
  const [audienceResuming, setAudienceResuming] = useState(false)
  const [audienceGrowing, setAudienceGrowing] = useState(false)
  const [audienceGrowthScrolls, setAudienceGrowthScrolls] = useState(60)
  const [audienceActionMessage, setAudienceActionMessage] = useState<string | null>(null)
  const [audienceAnchorTarget, setAudienceAnchorTarget] = useState<AudienceAnchorTarget | null>(null)
  const resultViewCache = useRef<Record<AnalysisMode, WorkspaceResultView>>({
    job: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
    general: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
  })
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [collectionEntryMode, setCollectionEntryMode] = useState<'search' | 'import'>('search')
  const [loading, setLoading] = useState(true)
  const [jobsRefreshing, setJobsRefreshing] = useState(false)
  const [relayConnecting, setRelayConnecting] = useState(false)
  const [relaySettingUp, setRelaySettingUp] = useState(false)
  const [securityRecovering, setSecurityRecovering] = useState(false)
  const [journeyActionBusy, setJourneyActionBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dataManaging, setDataManaging] = useState(false)
  const [completingMissing, setCompletingMissing] = useState(false)
  const [completionFlow, setCompletionFlow] = useState<MissingCompletionFlow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [clock, setClock] = useState(new Date())
  const [providers, setProviders] = useState<AiProviderOption[]>([])
  const [providerId, setProviderId] = useState<AiProviderOption['id']>('codex')
  const [apiKey, setApiKey] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [customModelMode, setCustomModelMode] = useState(false)
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiWireApi, setAiWireApi] = useState<'responses' | 'chat_completions'>('responses')
  const [aiSession, setAiSession] = useState<AiSession | null>(null)
  const [profiles, setProfiles] = useState<CandidateProfile[]>([])
  const [backgroundText, setBackgroundText] = useState('')
  const [backgroundFiles, setBackgroundFiles] = useState<File[]>([])
  const [configuringAi, setConfiguringAi] = useState(false)
  const [restoringAi, setRestoringAi] = useState(false)
  const [activatingLocalAi, setActivatingLocalAi] = useState(false)
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatus | null>(null)
  const [localModelChoice, setLocalModelChoice] = useState('qwen3.5:4b')
  const [localCustomModelId, setLocalCustomModelId] = useState('')
  const [startingLocalInstall, setStartingLocalInstall] = useState(false)
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [aiConnectionCheck, setAiConnectionCheck] = useState<AiConnectionCheck | null>(null)
  const [importingProfile, setImportingProfile] = useState(false)
  const [candidateImportStatus, setCandidateImportStatus] = useState<'recognized' | 'empty' | null>(null)
  const cleanupStream = useRef<null | (() => void)>(null)
  const streamGeneration = useRef(0)
  const resumeIdempotencyKeys = useRef(new Map<string, string>())
  const relayConnectionRef = useRef<Promise<RelayStatus> | null>(null)
  const rateLimitAlertRef = useRef<string | null>(null)
  const resultsRequestRef = useRef(0)
  const coverageJobIdRef = useRef<string | null>(null)
  const draftViewRevisionRef = useRef(0)
  const draftSaveResponseRef = useRef(0)
  const audienceRequestRef = useRef(0)
  const audienceForegroundRequestRef = useRef(0)
  const aiBootstrapStartedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void api.authMe()
      .then((session) => {
        if (!cancelled) setAuthSession(session)
      })
      .catch((error: ApiError) => {
        if (!cancelled) setAuthError(error.message)
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthSubmitting(true)
    setAuthError('')
    try {
      await api.authLogin(authEmail, authPassword)
      window.location.reload()
    } catch (error) {
      setAuthError((error as ApiError).message || '登录失败，请稍后重试。')
    } finally {
      setAuthSubmitting(false)
    }
  }

  useEffect(() => {
    const jobId = activeJob?.id
    const noteId = selectedResult?.note_id
    let cancelled = false
    setCoverLetterRewriteOpen(false)
    setCoverLetterRewriteInstructions('')
    setCoverLetterRewriteError('')
    setEmailPreview(null)
    setArtifactAttachmentId('')
    setApplicationAttachments(null)
    if (!jobId || !noteId) {
      setApplicationAttachments(null)
      return () => { cancelled = true }
    }
    setAttachmentsLoading(true)
    void api.applicationAttachments(jobId, noteId)
      .then((response) => { if (!cancelled) setApplicationAttachments(response) })
      .catch((error) => { if (!cancelled) setNotice((error as Error).message) })
      .finally(() => { if (!cancelled) setAttachmentsLoading(false) })
    return () => { cancelled = true }
  }, [activeJob?.id, selectedResult?.note_id])
  const audienceResultsRef = useRef<{ sourceJobId: string; value: AudienceResultsResponse } | null>(null)
  const generalModuleScrollRef = useRef<Record<GeneralResultModule, number>>({ insights: 0, audience: 0, expansion: 0 })
  const relayGuideAutoOpened = useRef(false)
  const logConsole = useRef<HTMLDivElement | null>(null)
  const logEnd = useRef<HTMLDivElement | null>(null)
  const handledLocalInstall = useRef<string | null>(null)
  const draftSaveHandlerRef = useRef<(request: DraftSaveRequest) => Promise<boolean>>(async () => false)
  const draftGuard = useUnsavedDraftGuard({
    content: selectedResult ? outreachDraft(selectedResult) : null,
    draftVersion: selectedResult?.draftVersion || null,
    save: (saveRequest) => draftSaveHandlerRef.current(saveRequest),
    discard: ({ content, draftVersion }) => {
      setSelectedResult((current) => current ? {
        ...current,
        outreach: { ...current.outreach, ...content },
        draftVersion,
      } : current)
      setResults((current) => current ? {
        ...current,
        items: current.items.map((item) => item.note_id === selectedResult?.note_id ? {
          ...item,
          outreach: { ...item.outreach, ...content },
          draftVersion,
        } : item),
      } : current)
    },
  })
  const draftDirty = draftGuard.dirty
  const draftSaving = draftGuard.saveStatus === 'saving'
  draftDirtyRef.current = draftDirty
  const detectedSmtpPreset = smtpPresetForEmail(smtpConfig.from)
  const detectedSmtpProvider = detectedSmtpPreset
    ? smtpProviderOptions.find((item) => item.id === detectedSmtpPreset.provider)
    : null
  const smtpHasLoginCredential = Boolean(smtpPassword || smtpConfig.hasPassword)
  const smtpHasRefreshToken = Boolean(smtpOAuthRefreshToken || smtpConfig.oauth.hasRefreshToken)
  const smtpManualAuthReady = smtpConfig.auth === 'none'
    || (smtpConfig.auth === 'login' && Boolean((smtpConfig.user || smtpConfig.from).trim()) && smtpHasLoginCredential)
    || (smtpConfig.auth === 'oauth2' && Boolean((smtpConfig.user || smtpConfig.from).trim()) && smtpConfig.oauth.clientId.trim() && smtpHasRefreshToken)
  const smtpCanSave = Boolean(smtpConfig.from.trim() && (
    smtpManualMode
      ? smtpConfig.host.trim() && smtpConfig.port > 0 && smtpManualAuthReady
      : detectedSmtpPreset && smtpHasLoginCredential
  ))
  const smtpSetupGuide = smtpSetupGuides[smtpGuideProvider]
  const smtpGuideHost = smtpConfig.provider === smtpGuideProvider && smtpConfig.host ? smtpConfig.host : smtpSetupGuide.host
  const audienceSourceJobId = audienceSourceJobIdFor(activeJob, jobs)
  const linkedAudienceTask = audienceTask && audienceSourceJobIdFor(audienceTask, jobs) === audienceSourceJobId ? audienceTask : null
  const trackedAudienceTask = linkedAudienceTask || (activeJob?.config?.collectAudience ? activeJob : null)
  const selectedAudienceDataJob = jobs.find((job) => (
    job.id === audienceDataJobId && audienceSourceJobIdFor(job, jobs) === audienceSourceJobId
  ))
  const audienceReadJobId = linkedAudienceTask?.id || selectedAudienceDataJob?.id || audienceSourceJobId

  const disconnectJobStream = useCallback(() => {
    streamGeneration.current += 1
    cleanupStream.current?.()
    cleanupStream.current = null
    setJobConnectionState('offline')
  }, [])

  const performSwitchWorkspace = useCallback((mode: AnalysisMode, updateHistory = true, targetApplicationView: ApplicationView = 'jobs') => {
    if (mode === workspaceMode) return
    draftViewRevisionRef.current += 1
    disconnectJobStream()
    resultsRequestRef.current += 1
    audienceRequestRef.current += 1
    audienceForegroundRequestRef.current += 1
    setAudienceLoading(false)
    requestCache.current[workspaceMode] = request
    if (activeJob && jobAnalysisMode(activeJob) === workspaceMode) {
      activeJobIdCache.current[workspaceMode] = activeJob.id
    }
    resultViewCache.current[workspaceMode] = {
      activeJobId: activeJob?.id || null,
      results: results?.analysisMode === workspaceMode ? results : null,
      selectedNoteId: selectedResult?.note_id || null,
      resultOffset,
      resultSort,
      resultTimeRange,
    }
    const nextRequest = requestCache.current[mode]
    requestCache.current[mode] = {
      ...nextRequest,
      analysisMode: mode,
      relayPort: request.relayPort,
      browserProfile: request.browserProfile,
      aiSessionId: request.aiSessionId,
    }
    const nextApplicationView: ApplicationView = mode === 'job' ? targetApplicationView : 'jobs'
    if (updateHistory && window.location.pathname !== workspacePath(mode, nextApplicationView)) {
      window.history.pushState({ workspaceMode: mode, applicationView: nextApplicationView }, '', workspacePath(mode, nextApplicationView))
    }
    setApplicationView(nextApplicationView)
    if (mode === 'general') setGeneralResultModule(updateHistory ? 'insights' : generalResultModuleFromLocation())
    setWorkspaceMode(mode)
    setRequest({ ...requestCache.current[mode] })
    const scopedJobs = jobs.filter((job) => jobAnalysisMode(job) === mode)
    const rememberedJobId = activeJobIdCache.current[mode]
    const nextCandidate = scopedJobs.find((job) => job.id === rememberedJobId)
      || scopedJobs.find((job) => !isAudienceOnlyJob(job))
      || scopedJobs[0]
      || null
    const nextJob = audienceSourceJobFor(scopedJobs, nextCandidate)
    const nextAudienceTask = mode === 'general'
      ? (isAudienceOnlyJob(nextCandidate) ? nextCandidate : audienceTaskForSource(scopedJobs, nextJob?.id || null))
      : null
    const nextView = resultViewCache.current[mode]
    const canRestoreView = Boolean(nextJob && nextView.activeJobId === nextJob.id && nextView.results?.analysisMode === mode)
    const nextResults = canRestoreView ? nextView.results : null
    setActiveJob(nextJob)
    setAudienceTask(nextAudienceTask)
    setArtifacts([])
    coverageJobIdRef.current = nextResults?.coverage ? nextJob?.id || null : null
    setCoverage(nextResults?.coverage || null)
    setResults(nextResults)
    setAudienceResults(null)
    setAudienceDataJobId('')
    setAudienceActionMessage(null)
    setAudienceOffset(0)
    setAudiencePostId('')
    setAudienceQuery('')
    setSelectedResult(nextResults?.items.find((item) => item.note_id === nextView.selectedNoteId) || nextResults?.items[0] || null)
    setLogs([])
    setResultOffset(canRestoreView ? nextView.resultOffset : 0)
    setResultSort(nextView.resultSort)
    setResultTimeRange(nextView.resultTimeRange)
    setResultsLoading(Boolean(nextJob) && !canRestoreView)
    setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeJob, disconnectJobStream, jobs, request, resultOffset, results, resultSort, resultTimeRange, selectedResult, workspaceMode])

  const switchWorkspace = useCallback((mode: AnalysisMode, updateHistory = true, targetApplicationView: ApplicationView = 'jobs') => (
    draftGuard.requestTransition('切换工作台', () => performSwitchWorkspace(mode, updateHistory, targetApplicationView))
  ), [draftGuard.requestTransition, performSwitchWorkspace])

  const performSwitchApplicationView = useCallback((view: ApplicationView, updateHistory = true) => {
    if (workspaceMode !== 'job' || view === applicationView) return
    const nextPath = workspacePath('job', view)
    if (updateHistory && window.location.pathname !== nextPath) {
      window.history.pushState({ workspaceMode: 'job', applicationView: view }, '', nextPath)
    }
    setApplicationView(view)
    setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [applicationView, workspaceMode])

  const switchApplicationView = useCallback((view: ApplicationView, updateHistory = true) => {
    performSwitchApplicationView(view, updateHistory)
  }, [performSwitchApplicationView])

  const performSwitchGeneralResultModule = useCallback((module: GeneralResultModule, preferredJobId = '') => {
    const currentScroll = window.scrollY
    generalModuleScrollRef.current[generalResultModule] = currentScroll
    setGeneralResultModule(module)
    const url = new URL(window.location.href)
    if (module === 'audience') {
      url.searchParams.set('module', 'audience')
      const requestedJobId = preferredJobId || audienceDataJobId || audienceDataJobIdFromLocation()
      if (requestedJobId) {
        setAudienceDataJobId(requestedJobId)
        url.searchParams.set('job', requestedJobId)
      }
      const sourceJobId = audienceSourceJobIdFor(activeJob, jobs)
      void findBestAudienceDataJob(jobs, requestedJobId, sourceJobId).then((job) => {
        if (!job) return
        setAudienceDataJobId(job.id)
        writeAudienceDataJobToLocation(job.id)
      })
    } else if (module === 'expansion') {
      url.searchParams.set('module', 'expansion')
      url.searchParams.delete('job')
    } else {
      url.searchParams.delete('module')
      url.searchParams.delete('job')
    }
    window.history.replaceState({ ...(window.history.state || {}), generalResultModule: module }, '', `${url.pathname}${url.search}${url.hash}`)
    window.requestAnimationFrame(() => window.scrollTo({ top: generalModuleScrollRef.current[module] || currentScroll }))
  }, [activeJob, audienceDataJobId, generalResultModule, jobs])

  const switchGeneralResultModule = useCallback((module: GeneralResultModule, preferredJobId = '') => (
    draftGuard.requestTransition('离开当前结果页面', () => performSwitchGeneralResultModule(module, preferredJobId))
  ), [draftGuard.requestTransition, performSwitchGeneralResultModule])

  useEffect(() => {
    requestCache.current[workspaceMode] = request
  }, [request, workspaceMode])

  useEffect(() => {
    if (activeJob && jobAnalysisMode(activeJob) === workspaceMode) {
      activeJobIdCache.current[workspaceMode] = activeJob.id
    }
  }, [activeJob?.id, workspaceMode])

  useEffect(() => {
    resultViewCache.current[workspaceMode] = {
      activeJobId: activeJob?.id || null,
      results: results?.analysisMode === workspaceMode ? results : null,
      selectedNoteId: selectedResult?.note_id || null,
      resultOffset,
      resultSort,
      resultTimeRange,
    }
  }, [activeJob?.id, resultOffset, results, resultSort, resultTimeRange, selectedResult?.note_id, workspaceMode])

  useEffect(() => {
    const handlePopState = () => {
      const targetUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
      const targetMode = workspaceModeFromLocation()
      const targetApplicationView = applicationViewFromLocation()
      const targetModule = generalResultModuleFromLocation()
      const applyTarget = () => {
        setGeneralResultModule(targetModule)
        if (targetModule === 'audience') {
          const preferredJobId = audienceDataJobIdFromLocation()
          void findBestAudienceDataJob(jobs, preferredJobId, audienceSourceJobIdFor(activeJob, jobs)).then((job) => {
            setAudienceDataJobId(job?.id || preferredJobId)
          })
        } else {
          setAudienceDataJobId('')
        }
        if (targetMode !== workspaceMode) {
          performSwitchWorkspace(targetMode, false, targetApplicationView)
        } else if (targetMode === 'job' && targetApplicationView !== applicationView) {
          performSwitchApplicationView(targetApplicationView, false)
        } else {
          performSwitchWorkspace(targetMode, false)
        }
      }
      if (targetMode === workspaceMode && targetMode === 'job' && targetApplicationView !== applicationView) {
        applyTarget()
        return
      }
      if (!draftDirtyRef.current) {
        applyTarget()
        return
      }
      const currentUrl = new URL(window.location.href)
      currentUrl.pathname = workspacePath(workspaceMode, workspaceMode === 'job' ? applicationView : 'jobs')
      if (workspaceMode !== 'general' || generalResultModule === 'insights') {
        currentUrl.searchParams.delete('module')
        currentUrl.searchParams.delete('job')
      } else if (generalResultModule === 'audience') {
        currentUrl.searchParams.set('module', 'audience')
        if (audienceDataJobId) currentUrl.searchParams.set('job', audienceDataJobId)
      } else {
        currentUrl.searchParams.set('module', 'expansion')
        currentUrl.searchParams.delete('job')
      }
      window.history.pushState({ workspaceMode, generalResultModule }, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`)
      void draftGuard.requestTransition('浏览器返回', () => {
        window.history.pushState({ workspaceMode: targetMode, applicationView: targetApplicationView, generalResultModule: targetModule }, '', targetUrl)
        applyTarget()
      })
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [activeJob, applicationView, audienceDataJobId, draftGuard.requestTransition, generalResultModule, jobs, performSwitchApplicationView, performSwitchWorkspace, workspaceMode])

  useEffect(() => {
    document.title = workspaceMode === 'general'
      ? '今天你投了吗？｜内容研究工作台'
      : applicationView === 'batch'
        ? '今天你投了吗？｜批量投递工作台'
        : '今天你投了吗？｜岗位与投递'
  }, [applicationView, workspaceMode])

  useEffect(() => {
    const provider = detectedSmtpPreset?.provider || smtpConfig.provider
    if (provider === '163' || provider === 'qq') setSmtpGuideProvider(provider)
  }, [detectedSmtpPreset?.provider, smtpConfig.provider])

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
      setNotice('Relay 配置已保存')
      await connectRelay(true, saved)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setRelayConfigSaving(false)
    }
  }

  const setupAndConnectRelay = async () => {
    setRelaySettingUp(true)
    setNotice(null)
    try {
      const saved = await api.updateRelayConfig(relayConfig)
      setRelayConfig(saved)
      updateRequest('relayPort', saved.port)
      const status = await api.setupRelay(saved.port, saved.profile)
      setRelay(status)
      setNotice(status.message || (status.ready ? 'Relay 已安装并连接' : 'Relay 已准备，等待连接'))
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setRelaySettingUp(false)
    }
  }

  const updateSmtpEmail = (value: string) => {
    const preset = smtpPresetForEmail(value)
    setSmtpConfig((current) => {
      const emailChanged = value.trim().toLowerCase() !== current.from.trim().toLowerCase()
      const userTracksFrom = !current.user || current.user.trim().toLowerCase() === current.from.trim().toLowerCase()
      return {
        ...current,
        ...(!smtpManualMode && preset ? preset : {}),
        ...(!smtpManualMode ? { auth: 'login' as const, authMode: 'login' as const } : {}),
        user: userTracksFrom ? value : current.user,
        from: value,
        hasPassword: emailChanged ? false : current.hasPassword,
        configured: false,
        verified: false,
      }
    })
  }

  const selectSmtpProvider = (provider: SmtpProvider) => {
    const preset = smtpProviderOptions.find((item) => item.id === provider) || smtpProviderOptions.at(-1)!
    setSmtpConfig((current) => ({
      ...current,
      provider,
      host: preset.host,
      port: preset.port,
      secure: preset.secure,
      requireTls: preset.requireTls,
      auth: 'login',
      authMode: 'login',
      hasPassword: false,
      configured: false,
      verified: false,
    }))
    setSmtpPassword('')
  }

  const updateSmtpConfig = <K extends keyof SmtpConfig>(key: K, value: SmtpConfig[K]) => {
    setSmtpConfig((current) => ({ ...current, [key]: value }))
  }

  const selectSmtpAuth = (auth: SmtpAuthMode) => {
    setSmtpConfig((current) => ({ ...current, auth, authMode: auth, configured: false, verified: false }))
  }

  const updateSmtpOAuth = <K extends 'tenant' | 'clientId' | 'scope'>(key: K, value: SmtpConfig['oauth'][K]) => {
    setSmtpConfig((current) => ({
      ...current,
      oauth: { ...current.oauth, [key]: value },
      configured: false,
      verified: false,
    }))
  }

  const saveSmtpConfig = async (testConnection = false) => {
    setSmtpSaving(true)
    setNotice(null)
    try {
      const saved = await api.updateSmtpConfig(smtpManualMode ? {
        provider: smtpConfig.provider,
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        requireTls: smtpConfig.requireTls,
        auth: smtpConfig.auth,
        user: smtpConfig.user || smtpConfig.from,
        from: smtpConfig.from,
        password: smtpPassword,
        ...(smtpConfig.auth === 'oauth2' ? {
          oauth: {
            tenant: smtpConfig.oauth.tenant,
            clientId: smtpConfig.oauth.clientId,
            clientSecret: smtpOAuthClientSecret,
            refreshToken: smtpOAuthRefreshToken,
            scope: smtpConfig.oauth.scope,
          },
        } : {}),
      } : {
        from: smtpConfig.from,
        password: smtpPassword,
        autoConfigure: true,
      })
      setSmtpConfig(saved)
      setSmtpPassword('')
      setSmtpOAuthClientSecret('')
      setSmtpOAuthRefreshToken('')
      setHealth((current) => current ? {
        ...current,
        emailDelivery: { configured: saved.configured, from: saved.maskedFrom, authMode: saved.authMode },
      } : current)
      if (testConnection) {
        const result = await api.testSmtp()
        setSmtpConfig((current) => ({ ...current, verified: true, lastVerifiedAt: result.lastVerifiedAt }))
        setNotice(`SMTP 连接成功 · 发件人 ${result.from}`)
      } else {
        setNotice('发件邮箱已保存并立即生效，无需重启服务。')
      }
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setSmtpSaving(false)
    }
  }

  const clearSmtpConfig = async () => {
    if (!window.confirm('清除当前设备保存的发件邮箱、密码和 OAuth2 凭据？')) return
    setSmtpSaving(true)
    setNotice(null)
    try {
      const cleared = await api.clearSmtpConfig()
      setSmtpConfig(cleared)
      setSmtpPassword('')
      setSmtpOAuthClientSecret('')
      setSmtpOAuthRefreshToken('')
      setHealth((current) => current ? {
        ...current,
        emailDelivery: { configured: false, from: '', authMode: cleared.authMode },
      } : current)
      setNotice('当前设备保存的发件邮箱配置已清除。')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setSmtpSaving(false)
    }
  }

  const openRelayLogin = async () => {
    setRelayLoginOpening(true)
    setNotice(null)
    try {
      const saved = await api.updateRelayConfig(relayConfig)
      setRelayConfig(saved)
      updateRequest('relayPort', saved.port)
      const result = await api.openRelayLogin(saved.profile)
      setNotice(result.message || '目标页已在独立浏览器中打开，请在该浏览器内完成登录。')
      window.setTimeout(() => void refreshRelay(), 1500)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setRelayLoginOpening(false)
    }
  }

  const repairRelay = async () => {
    setRelayRecovering(true)
    setRelayRecovery(null)
    setNotice(null)
    try {
      const saved = await api.updateRelayConfig(relayConfig)
      setRelayConfig(saved)
      updateRequest('relayPort', saved.port)
      const result = await api.recoverRelay(saved.port, saved.profile)
      setRelayRecovery(result)
      setRelay({
        ...result,
        tabs: result.after.targetCount,
        xiaohongshuTabs: result.after.xiaohongshuPages,
        pageCount: result.after.pageCount,
        iframeCount: result.after.iframeCount,
        workerCount: result.after.workerCount,
        targetPressure: result.after.pressure,
        pressureReasons: result.after.pressureReasons,
        recoveryRecommended: result.after.recoveryRecommended,
      })
      setNotice(result.ok
        ? `${result.hardRestarted ? 'Relay 浏览器已自动重建，' : 'Relay 已修复，'}并完成 Playwright 验证，共关闭 ${result.closedTargets} 个旧页面。`
        : result.message || 'Relay 已完成清理，但连接验证仍未通过。')
    } catch (error) {
      setNotice(`Relay 一键修复失败：${(error as Error).message}`)
      await connectRelay(false, relayConfig)
    } finally {
      setRelayRecovering(false)
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
    setJobsRefreshing(true)
    try {
      const response = await api.jobs()
      const next = Array.isArray(response) ? response : []
      const scoped = next.filter((job) => jobAnalysisMode(job) === workspaceMode)
      setJobs(next)
      setAudienceTask((current) => {
        if (workspaceMode !== 'general') return null
        const sourceJobId = audienceSourceJobIdFor(current, next) || activeJobIdCache.current.general
        return (current ? next.find((job) => job.id === current.id) : null)
          || audienceTaskForSource(scoped, sourceJobId)
      })
      setActiveJob((current) => {
        const rememberedJobId = activeJobIdCache.current[workspaceMode]
        const nextCandidate = current && jobAnalysisMode(current) === workspaceMode
          ? scoped.find((job) => job.id === current.id)
          : scoped.find((job) => job.id === rememberedJobId)
            || scoped.find((job) => !isAudienceOnlyJob(job))
            || scoped[0]
            || null
        const nextActive = audienceSourceJobFor(scoped, nextCandidate)
        activeJobIdCache.current[workspaceMode] = nextActive?.id || null
        return nextActive
      })
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setJobsRefreshing(false)
    }
  }, [workspaceMode])

  const manageLocalData = async () => {
    const choice = window.prompt([
      '本地数据管理',
      '1 删除当前任务',
      '2 删除当前背景记忆',
      '3 删除当前草稿',
      '4 删除当前任务的一个产物',
      '5 配置自动留存策略',
      '6 清除全部本地用户数据',
    ].join('\n'))?.trim()
    if (!choice) return
    setDataManaging(true)
    setNotice(null)
    try {
      if (choice === '5') {
        const current = await api.dataRetention()
        const rawDays = window.prompt('保留已结束任务的天数（1-3650）', String(current.days))
        if (rawDays === null) return
        const days = Number(rawDays)
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('保留天数必须是 1 到 3650 之间的整数。')
        const enabled = window.confirm('启用自动清理？\n\n确定：启用；取消：保持关闭。运行中、续跑中和已固定任务始终跳过。')
        let pinnedJobIds = current.pinnedJobIds
        if (activeJob) {
          const pinned = window.confirm(`是否固定当前任务 ${activeJob.id}，使其不参与自动清理？`)
          pinnedJobIds = pinned
            ? [...new Set([...pinnedJobIds, activeJob.id])]
            : pinnedJobIds.filter((id) => id !== activeJob.id)
        }
        const saved = await api.updateDataRetention({ enabled, days, pinnedJobIds })
        const preview = await api.cleanupExpiredData(true)
        setNotice(`留存策略已保存：${saved.enabled ? `自动清理 ${saved.days} 天前的已结束任务` : '自动清理已关闭'}；当前预演命中 ${preview.eligible?.length || 0} 个任务。`)
        return
      }

      let spec: DataDeletionSpec
      if (choice === '1') {
        if (!activeJob) throw new Error('请先在历史任务中选择一个任务。')
        spec = { entityType: 'job', jobId: activeJob.id }
      } else if (choice === '2') {
        if (!request.profileId) throw new Error('请先选择一个背景记忆。')
        spec = { entityType: 'profile', profileId: request.profileId }
      } else if (choice === '3') {
        if (!activeJob || !selectedResult) throw new Error('当前结果没有可删除的已保存草稿。')
        const versionedDraftId = (selectedResult as ApplicationResult & { draftVersion?: { draftId?: string } }).draftVersion?.draftId
        spec = { entityType: 'draft', jobId: activeJob.id, draftId: versionedDraftId || `legacy_${selectedResult.note_id}` }
      } else if (choice === '4') {
        if (!activeJob || !artifacts.length) throw new Error('当前任务没有可删除的产物。')
        const selected = window.prompt(artifacts.map((artifact, index) => `${index + 1} ${artifact.name}（${formatBytes(artifact.size)}）`).join('\n'))
        if (selected === null) return
        const artifact = artifacts[Number(selected) - 1]
        if (!artifact) throw new Error('请输入列表中的产物序号。')
        spec = { entityType: 'artifact', jobId: activeJob.id, artifactId: artifact.id }
      } else if (choice === '6') {
        spec = { entityType: 'all', force: true }
      } else {
        throw new Error('请输入 1 到 6。')
      }

      let preview: DataDeletionPreview = await api.previewDataDeletion(spec)
      if (spec.entityType === 'profile' && preview.requiresForce && !spec.force) {
        const impact = preview.references.map((reference) => reference.id || reference.type).join('、')
        if (!window.confirm(`该背景记忆仍被 ${preview.references.length} 个任务引用：${impact}\n\n继续将从这些任务中解除引用，再删除背景记忆。`)) return
        spec = { ...spec, force: true }
        preview = await api.previewDataDeletion(spec)
      }
      if (preview.status !== 'ready') {
        throw new Error(preview.blockedReasons.map((reason) => reason.message).join(' ') || '当前数据不满足删除条件。')
      }
      const references = preview.references.length ? `\n关联引用：${preview.references.length} 条` : ''
      if (!window.confirm(`即将物理删除 ${preview.entities.length} 个数据实体、${preview.fileCount} 个文件（${formatBytes(preview.totalBytes)}）。${references}\n\n删除后旧 ID 和下载地址将失效。`)) return
      let confirmationPhrase: string | undefined
      if (spec.entityType === 'all') {
        confirmationPhrase = window.prompt(`请输入 ${preview.confirmationPhrase} 确认清除全部本地用户数据。`) || ''
        if (confirmationPhrase !== preview.confirmationPhrase) throw new Error('确认短语不匹配，未执行清除。')
      }
      const result = await api.executeDataDeletion({
        ...spec,
        confirmationToken: preview.confirmationToken,
        ...(confirmationPhrase ? { confirmationPhrase } : {}),
      })

      if (spec.entityType === 'job' || spec.entityType === 'all') {
        disconnectJobStream()
        activeJobIdCache.current = { job: null, general: null }
        resultViewCache.current = {
          job: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
          general: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
        }
        setActiveJob(null)
        setAudienceTask(null)
        setArtifacts([])
        setResults(null)
        setSelectedResult(null)
        setAudienceResults(null)
        setLogs([])
      }
      if (spec.entityType === 'profile' || spec.entityType === 'all') {
        const savedProfiles = await api.profiles()
        setProfiles(savedProfiles)
        if (spec.entityType === 'all' || request.profileId === spec.profileId) updateRequest('profileId', null)
      }
      if (spec.entityType === 'artifact' && activeJob) setArtifacts(await api.artifacts(activeJob.id))
      if (spec.entityType === 'draft' && activeJob) await loadResults(activeJob.id, resultOffset)
      if (spec.entityType === 'all') {
        window.localStorage.removeItem(CANDIDATE_PROFILE_STORAGE_KEY)
        for (const mode of ['job', 'general'] as AnalysisMode[]) {
          requestCache.current[mode] = { ...requestCache.current[mode], profileId: null, candidateProfile: { ...defaultCandidateProfile } }
        }
        setRequest({ ...requestCache.current[workspaceMode] })
        resumeIdempotencyKeys.current.clear()
      }
      await loadJobs()
      setNotice(`本地数据已删除：${result.fileCount} 个文件，审计记录已写入。`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setDataManaging(false)
    }
  }

  const selectProvider = (id: AiProviderOption['id'], options = providers) => {
    setProviderId(id)
    setApiKey('')
    setAiConnectionCheck(null)
    const selected = options.find((item) => item.id === id)
    if (selected) {
      setAiModel(selected.model)
      setCustomModelMode(Boolean(selected.model && !selected.models.includes(selected.model)))
      setAiBaseUrl(selected.baseUrl)
      setAiWireApi(selected.wireApi)
    }
    setAiSession(null)
    updateRequest('aiSessionId', null)
  }

  const selectedModelValue = customModelMode ? CUSTOM_MODEL_OPTION : aiModel

  const invalidateAiSession = () => {
    setAiSession(null)
    updateRequest('aiSessionId', null)
  }

  const normalizedAiBaseUrl = (value: string) => value.trim().replace(/\/+$/, '')

  const rememberAiSession = (session: AiSession) => {
    const sessionProviderId = session.provider as AiProviderOption['id']
    setProviderId(sessionProviderId)
    setAiModel(session.model)
    setAiBaseUrl(session.baseUrl)
    setAiWireApi(session.wireApi)
    setAiSession(session)
    updateRequest('aiSessionId', session.id)
    setProviders((current) => current.map((item) => item.id === sessionProviderId
      ? {
          ...item,
          configured: true,
          hasApiKey: item.requiresKey ? true : item.hasApiKey,
          model: session.model,
          baseUrl: session.baseUrl,
          wireApi: session.wireApi,
          models: [...new Set([...item.models, session.model])],
        }
      : item))
  }

  const aiSessionMatchesSelection = (session: AiSession) => (
    session.provider === providerId
    && session.model === aiModel.trim()
    && normalizedAiBaseUrl(session.baseUrl) === normalizedAiBaseUrl(aiBaseUrl)
    && session.wireApi === aiWireApi
    && Date.parse(session.expiresAt) > Date.now() + 60_000
  )

  const createSelectedAiSession = async () => {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) throw new Error('当前 AI 提供方不存在，请重新选择。')
    const model = aiModel.trim()
    const baseUrl = aiBaseUrl.trim()
    if (!model) throw new Error('请先选择用于背景资料解析的模型。')
    if (!baseUrl) throw new Error('请先填写当前模型的 Base URL。')
    if (provider.requiresKey && !apiKey.trim() && !provider.hasApiKey) {
      throw new Error('请先填写当前模型服务的 API Key。')
    }
    const session = await api.createAiSession({
      provider: provider.id,
      apiKey,
      model,
      baseUrl,
      wireApi: aiWireApi,
    })
    rememberAiSession(session)
    setApiKey('')
    return session
  }

  const resolveProfileAiSession = async () => {
    if (aiSession && aiSessionMatchesSelection(aiSession)) return aiSession
    return createSelectedAiSession()
  }

  const selectAiModel = (value: string) => {
    invalidateAiSession()
    if (value === CUSTOM_MODEL_OPTION) {
      setCustomModelMode(true)
      setAiModel('')
      return
    }
    setCustomModelMode(false)
    setAiModel(value)
  }

  const updateAiBaseUrl = (value: string) => {
    invalidateAiSession()
    setAiBaseUrl(value)
    setAiConnectionCheck(null)
    const provider = providers.find((item) => item.id === providerId)
    if (provider?.relay) {
      setProviders((current) => current.map((item) => item.id === providerId ? { ...item, models: [] } : item))
      setAiModel('')
      setCustomModelMode(false)
    }
  }

  const applyDiscoveredModels = (result: { baseUrl: string; models: string[] }) => {
    invalidateAiSession()
    const currentProvider = providers.find((item) => item.id === providerId)
    const models = currentProvider?.relay
      ? result.models
      : [...new Set([...(currentProvider?.models || []), ...result.models])]
    setProviders((current) => current.map((item) => item.id === providerId ? { ...item, models } : item))
    setAiBaseUrl(result.baseUrl)
    if (!aiModel && models[0]) {
      setAiModel(models[0])
      setCustomModelMode(false)
    } else if (customModelMode && result.models.includes(aiModel)) {
      setCustomModelMode(false)
    }
    return aiModel || models[0] || ''
  }

  const restoreAiSession = async (preferredProvider?: AiProviderOption): Promise<AiSession> => {
    const provider = preferredProvider
      || providers.find((item) => item.id === providerId && (item.configured || item.local))
      || providers.find((item) => item.configured && (!item.requiresKey || item.hasApiKey))
    if (!provider) throw new Error('没有可自动恢复的 AI 配置，请先在上方连接模型。')
    if (provider.requiresKey && !provider.hasApiKey) throw new Error('当前 AI 配置缺少 API Key，请先重新连接模型。')
    const model = provider.id === providerId ? (aiModel || provider.model) : provider.model
    if (!model || !provider.baseUrl) throw new Error('当前 AI 配置缺少模型或 Base URL，请先重新连接模型。')
    const session = await api.createAiSession({
      provider: provider.id,
      apiKey: '',
      model,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
    })
    rememberAiSession(session)
    setCustomModelMode(Boolean(session.model && !provider.models.includes(session.model)))
    return session
  }

  const configureAi = async () => {
    setConfiguringAi(true)
    setNotice(null)
    try {
      const currentProvider = providers.find((item) => item.id === providerId)
      let resolvedBaseUrl = aiBaseUrl
      let resolvedModel = aiModel
      if (currentProvider?.relay) {
        setAiConnectionCheck({ status: 'checking', message: '正在验证地址、密钥和模型列表…' })
        const result = await api.discoverAiModels({ provider: providerId, apiKey, baseUrl: aiBaseUrl })
        resolvedBaseUrl = result.baseUrl
        resolvedModel = applyDiscoveredModels(result)
        setAiConnectionCheck({ status: 'verified', message: `连接可用 · ${result.models.length} 个模型 · ${result.baseUrl}` })
      }
      if (!resolvedModel) throw new Error('未找到可用模型，请先检测模型或填写模型 ID。')
      const session = await api.createAiSession({ provider: providerId, apiKey, model: resolvedModel, baseUrl: resolvedBaseUrl, wireApi: aiWireApi })
      rememberAiSession(session)
      setApiKey('')
      setNotice(currentProvider?.local
        ? `${currentProvider.label} 已连接，文本仅在本机处理。`
        : `${currentProvider?.label || providerId} 已验证并连接，密钥仅保存在当前设备。`)
    } catch (error) {
      if (providers.find((item) => item.id === providerId)?.relay) {
        setAiConnectionCheck({ status: 'error', message: (error as Error).message })
      }
      setNotice((error as Error).message)
    } finally {
      setConfiguringAi(false)
    }
  }

  const refreshAiModels = async () => {
    setRefreshingModels(true)
    setNotice(null)
    if (providers.find((item) => item.id === providerId)?.relay) {
      setAiConnectionCheck({ status: 'checking', message: '正在检测接口并读取模型…' })
    }
    try {
      const result = await api.discoverAiModels({ provider: providerId, apiKey, baseUrl: aiBaseUrl })
      applyDiscoveredModels(result)
      if (providers.find((item) => item.id === providerId)?.relay) {
        setAiConnectionCheck({ status: 'verified', message: `连接可用 · ${result.models.length} 个模型 · ${result.baseUrl}` })
      }
      setNotice(selectedProvider?.local
        ? `已从本机读取 ${result.models.length} 个可用模型。`
        : `已验证连接并读取 ${result.models.length} 个可用模型。`)
    } catch (error) {
      if (providers.find((item) => item.id === providerId)?.relay) {
        setAiConnectionCheck({ status: 'error', message: (error as Error).message })
      }
      setNotice((error as Error).message)
    } finally {
      setRefreshingModels(false)
    }
  }

  const activateLocalAi = async (preferredModel?: string) => {
    const localProvider = providers.find((item) => item.id === 'local_qwen')
    if (!localProvider) {
      setNotice('本地免费模型配置未加载。')
      return null
    }
    setActivatingLocalAi(true)
    setNotice(null)
    setProviderId(localProvider.id)
    setAiBaseUrl(localProvider.baseUrl)
    setAiWireApi(localProvider.wireApi)
    setCustomModelMode(false)
    setApiKey('')
    setAiSession(null)
    updateRequest('aiSessionId', null)
    try {
      const discovered = await api.discoverAiModels({
        provider: localProvider.id,
        apiKey: '',
        baseUrl: localProvider.baseUrl,
      })
      const localModels = [...new Set(discovered.models.map((model) => model.trim()).filter(Boolean))]
      if (!localModels.length) throw new Error('本地服务已运行，但尚未找到已安装模型。')
      const preferredMatch = preferredModel
        ? localModels.find((model) => model.toLowerCase() === preferredModel.toLowerCase())
        : undefined
      const defaultMatch = localModels.find((model) => model.toLowerCase() === localProvider.model.toLowerCase())
      const model = preferredMatch || defaultMatch || localModels[0]
      setProviders((current) => current.map((item) => item.id === localProvider.id
        ? { ...item, model, models: localModels }
        : item))
      setAiModel(model)
      const session = await api.createAiSession({
        provider: localProvider.id,
        apiKey: '',
        model,
        baseUrl: localProvider.baseUrl,
        wireApi: localProvider.wireApi,
      })
      rememberAiSession(session)
      setNotice(`本地免费模型 ${model} 已就绪，文本整理不产生 API 费用。`)
      return session
    } catch (error) {
      setNotice(`${(error as Error).message} 可使用上方入口一键安装。`)
      return null
    } finally {
      setActivatingLocalAi(false)
    }
  }

  const installLocalModel = async (requestedModelId = localModelChoice) => {
    const modelId = requestedModelId.trim()
    if (!modelId) return setNotice('请输入 Ollama 模型 ID。')
    const selected = localModelStatus?.catalog.find((item) => item.id.toLowerCase() === modelId.toLowerCase())
    if (selected?.installed) return activateLocalAi(selected.id)
    setStartingLocalInstall(true)
    setNotice(null)
    try {
      const install = await api.installLocalModel(modelId)
      if (install.status === 'completed') {
        const status = await api.localModels()
        setLocalModelStatus(status)
        setLocalModelChoice(install.modelId)
      } else {
        setLocalModelStatus((current) => current ? { ...current, install } : current)
      }
      setLocalCustomModelId('')
      setNotice(install.message)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setStartingLocalInstall(false)
    }
  }

  const importProfile = async () => {
    if (!backgroundFiles.length) return setNotice('请至少选择一个背景文件')
    setImportingProfile(true)
    setNotice(null)
    try {
      const profileAiSession = await resolveProfileAiSession()
      const files = await Promise.all(backgroundFiles.map(async (file) => ({ name: file.name, base64: await fileBase64(file) })))
      const profile = await api.importProfile({ aiSessionId: profileAiSession.id, backgroundText, files })
      const importedCandidateProfile = importedCandidateProfileValues(profile.candidate_application)
      const importedFieldCount = Object.keys(importedCandidateProfile).length
      const evidenceCount = profile.evidence_items?.length || 0
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)])
      setRequest((current) => ({
        ...current,
        profileId: profile.id,
        candidateProfile: { ...current.candidateProfile, ...importedCandidateProfile },
      }))
      setCandidateImportStatus(importedFieldCount ? 'recognized' : 'empty')
      setNotice(importedFieldCount
        ? `${profileAiSession.model} 已完成解析：回填 ${importedFieldCount} 个署名字段，生成 ${evidenceCount} 条可核验证据。请核对后再启动任务。`
        : `${profileAiSession.model} 已完成解析并生成 ${evidenceCount} 条证据，但未识别到署名字段，请手动填写。`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setImportingProfile(false)
    }
  }

  const loadResults = useCallback(async (
    jobId: string,
    offset = 0,
    options: { silent?: boolean; preserveDraft?: boolean } = {},
  ) => {
    const requestMode = workspaceMode
    const requestId = ++resultsRequestRef.current
    if (!options.silent) setResultsLoading(true)
    try {
      const payload = await api.results(jobId, offset, 20, {
        analysisMode: requestMode,
        sort: resultSort,
        timeRange: resultTimeRange,
      })
      if (requestId !== resultsRequestRef.current) return
      if (payload.analysisMode !== requestMode) throw new Error('结果所属工作台与当前页面不一致')
      setResults(payload)
      coverageJobIdRef.current = jobId
      setCoverage(payload.coverage || parseCoverage(payload) || null)
      setResultOffset(offset)
      if (!options.preserveDraft || !draftDirtyRef.current) {
        setSelectedResult((current) => payload.items.find((item) => item.note_id === current?.note_id) || payload.items[0] || null)
      }
    } catch {
      if (requestId !== resultsRequestRef.current) return
      if (!options.silent) {
        const cached = resultViewCache.current[requestMode]
        const cachedResults = cached.activeJobId === jobId && cached.results?.analysisMode === requestMode ? cached.results : null
        setResults(cachedResults)
        if (!options.preserveDraft || !draftDirtyRef.current) {
          setSelectedResult(cachedResults?.items.find((item) => item.note_id === cached.selectedNoteId) || cachedResults?.items[0] || null)
        }
        setNotice(cachedResults ? '最新结果读取失败，当前继续显示已缓存的采集内容。' : '结果暂时读取失败，请稍后刷新；已采集文件和任务检查点未受影响。')
      }
    } finally {
      if (!options.silent && requestId === resultsRequestRef.current) setResultsLoading(false)
    }
  }, [resultSort, resultTimeRange, workspaceMode])

  const loadAudienceResults = useCallback(async (
    jobId: string,
    offset = 0,
    options: { silent?: boolean; preserveExisting?: boolean; fallbackJobId?: string | null; sourceJobId?: string | null } = {},
  ) => {
    const requestId = ++audienceRequestRef.current
    const foregroundRequestId = options.silent ? null : ++audienceForegroundRequestRef.current
    if (foregroundRequestId !== null) setAudienceLoading(true)
    try {
      let payload = await api.audience(jobId, audienceKind, offset, audiencePageSize, {
        postId: audiencePostId,
        query: audienceQuery,
      })
      if (!payload.available && options.fallbackJobId && options.fallbackJobId !== jobId) {
        payload = await api.audience(options.fallbackJobId, audienceKind, offset, audiencePageSize, {
          postId: audiencePostId,
          query: audienceQuery,
        })
      }
      if (requestId !== audienceRequestRef.current) return
      const sourceJobId = options.sourceJobId || options.fallbackJobId || jobId
      const previous = audienceResultsRef.current
      const sameView = previous?.sourceJobId === sourceJobId
        && previous.value.kind === payload.kind
        && previous.value.filters.postId === payload.filters.postId
        && previous.value.filters.query === payload.filters.query
      const preservePrevious = Boolean(options.preserveExisting
        && previous?.value.available
        && sameView
        && audienceSnapshotRegressed(previous.value, payload))
      const nextResults = preservePrevious ? previous!.value : payload
      audienceResultsRef.current = { sourceJobId, value: nextResults }
      setAudienceResults(nextResults)
      if (!preservePrevious) setAudienceOffset(offset)
    } catch (error) {
      if (requestId !== audienceRequestRef.current || options.silent) return
      setNotice(`受众数据读取失败：${(error as Error).message}`)
    } finally {
      if (foregroundRequestId !== null && foregroundRequestId === audienceForegroundRequestRef.current) {
        setAudienceLoading(false)
      }
    }
  }, [audienceKind, audiencePageSize, audiencePostId, audienceQuery])

  useEffect(() => {
    let mounted = true
    const boot = async () => {
      const results = await Promise.allSettled([api.health(), api.jobs(), api.relayConfig(), api.smtpConfig()])
      if (!mounted) return
      const [healthResult, jobsResult, relayConfigResult, smtpConfigResult] = results
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value)
      if (jobsResult.status === 'fulfilled') {
        const nextJobs = Array.isArray(jobsResult.value) ? jobsResult.value : []
        const initialMode = workspaceModeFromLocation()
        setJobs(nextJobs)
        const scopedJobs = nextJobs.filter((job) => jobAnalysisMode(job) === initialMode)
        const initialCandidate = scopedJobs.find((job) => !isAudienceOnlyJob(job)) || scopedJobs[0] || null
        let initialJob = audienceSourceJobFor(scopedJobs, initialCandidate)
        if (initialMode === 'general' && generalResultModuleFromLocation() === 'audience') {
          const audienceDataJob = await findBestAudienceDataJob(nextJobs, audienceDataJobIdFromLocation())
          if (!mounted) return
          if (audienceDataJob) {
            initialJob = audienceSourceJobFor(scopedJobs, audienceDataJob) || initialJob
            setAudienceDataJobId(audienceDataJob.id)
            writeAudienceDataJobToLocation(audienceDataJob.id)
            setAudienceTask(isAudienceOnlyJob(audienceDataJob)
              ? audienceDataJob
              : audienceTaskForSource(scopedJobs, initialJob?.id || null))
          } else {
            setAudienceTask(audienceTaskForSource(scopedJobs, initialJob?.id || null))
          }
        } else if (initialMode === 'general') {
          setAudienceTask(audienceTaskForSource(scopedJobs, initialJob?.id || null))
        }
        activeJobIdCache.current[initialMode] = initialJob?.id || null
        setActiveJob(initialJob)
      }
      const configuredPort = relayConfigResult.status === 'fulfilled' ? relayConfigResult.value.port : defaultRequest.relayPort
      if (relayConfigResult.status === 'fulfilled') {
        setRelayConfig(relayConfigResult.value)
        setRequest((current) => ({ ...current, relayPort: relayConfigResult.value.port }))
      }
      if (smtpConfigResult.status === 'fulfilled') {
        const saved = smtpConfigResult.value
        setSmtpConfig(saved.host || saved.from || saved.user ? saved : defaultSmtpConfig)
      }
      try {
        setRelay(await api.relayStatus(configuredPort))
      } catch (error) {
        setRelay({ running: false, cdpReady: false, port: configuredPort, message: (error as Error).message })
      }
      setLoading(false)
    }
    void boot()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const clockTimer = window.setInterval(() => setClock(new Date()), 1000)
    return () => window.clearInterval(clockTimer)
  }, [])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadJobs()
    }
    const jobsTimer = window.setInterval(refresh, 5_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(jobsTimer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadJobs])

  useEffect(() => {
    const relayTimer = window.setInterval(() => void refreshRelay(), 15000)
    return () => window.clearInterval(relayTimer)
  }, [refreshRelay])

  useEffect(() => () => cleanupStream.current?.(), [])

  useEffect(() => {
    if (!relayGuideOpen) return
    void refreshRelay()
    const guideTimer = window.setInterval(() => void refreshRelay(), 3000)
    return () => window.clearInterval(guideTimer)
  }, [relayGuideOpen, refreshRelay])

  useEffect(() => {
    const tabs = Array.isArray(relay?.tabs) ? relay.tabs.length : Number(relay?.tabs || 0)
    const siteReady = Boolean(relay?.running && relay?.cdpReady && tabs > 0 && Number(relay?.xiaohongshuTabs || 0) > 0)
    if (!loading && relay && !siteReady && !relayGuideAutoOpened.current) {
      relayGuideAutoOpened.current = true
      setRelayGuideOpen(true)
    }
  }, [loading, relay])

  useEffect(() => {
    if (aiBootstrapStartedRef.current) return
    aiBootstrapStartedRef.current = true
    Promise.all([api.aiProviders(), api.profiles(), api.localModels().catch(() => null)]).then(([options, saved, localStatus]) => {
      const expandedOptions = localStatus ? options.map((item) => item.id === 'local_qwen'
        ? { ...item, models: [...new Set([...item.models, ...localStatus.installedModels.map((model) => model.name)])] }
        : item) : options
      setProviders(expandedOptions)
      setProfiles(saved)
      if (localStatus) {
        setLocalModelStatus(localStatus)
        const recommended = localStatus.catalog.find((item) => item.recommended)
        const installedRecommended = localStatus.catalog.find((item) => item.recommended && item.installed)
        setLocalModelChoice(installedRecommended?.id || recommended?.id || localStatus.catalog[0]?.id || 'qwen3.5:4b')
      }
      const codex = expandedOptions.find((item) => item.id === 'codex')
      const localProvider = expandedOptions.find((item) => item.id === 'local_qwen')
      const configuredExternalProvider = expandedOptions.find((item) => !item.local && item.configured && (!item.requiresKey || item.hasApiKey))
      const localRuntimeReady = Boolean(localStatus?.runtime.ready && localStatus.installedModels.length)
      const preferredProvider = configuredExternalProvider
        || (localProvider && localRuntimeReady ? localProvider : undefined)
        || localProvider
        || codex
        || options[0]
      if (preferredProvider) selectProvider(preferredProvider.id, expandedOptions)
      if (preferredProvider && (preferredProvider.configured || (preferredProvider.local && localRuntimeReady))) {
        void api.createAiSession({
          provider: preferredProvider.id,
          apiKey: '',
          model: preferredProvider.model || localStatus?.installedModels[0]?.name || '',
          baseUrl: preferredProvider.baseUrl,
          wireApi: preferredProvider.wireApi,
        }).then((session) => {
          rememberAiSession(session)
          setNotice(`已自动恢复 ${preferredProvider.label}，可直接执行智能补全。`)
        }).catch(() => undefined)
      }
      if (saved[0]) updateRequest('profileId', saved[0].id)
    }).catch((error) => setNotice((error as Error).message))
  }, [])

  useEffect(() => {
    if (!request.profileId) {
      setCandidateImportStatus(null)
      return
    }
    const profile = profiles.find((item) => item.id === request.profileId)
    if (!profile) return
    const importedCandidateProfile = importedCandidateProfileValues(profile.candidate_application)
    const importedFieldCount = Object.keys(importedCandidateProfile).length
    setCandidateImportStatus(importedFieldCount ? 'recognized' : 'empty')
    if (!importedFieldCount) return
    setRequest((current) => {
      if (current.profileId !== profile.id) return current
      const candidateProfile = { ...current.candidateProfile, ...importedCandidateProfile }
      const changed = candidateApplicationFields.some((key) => candidateProfile[key] !== current.candidateProfile[key])
      return changed ? { ...current, candidateProfile } : current
    })
  }, [profiles, request.profileId])

  useEffect(() => {
    const install = localModelStatus?.install
    if (!install || !['queued', 'running'].includes(install.status)) return
    let cancelled = false
    const refresh = () => {
      void api.localModels().then((status) => {
        if (!cancelled) {
          setLocalModelStatus(status)
          setProviders((current) => current.map((item) => item.id === 'local_qwen'
            ? { ...item, models: [...new Set([...item.models, ...status.installedModels.map((model) => model.name)])] }
            : item))
        }
      }).catch((error) => {
        if (!cancelled) setNotice((error as Error).message)
      })
    }
    const timer = window.setInterval(refresh, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [localModelStatus?.install?.id, localModelStatus?.install?.status])

  useEffect(() => {
    const install = localModelStatus?.install
    if (!install || !['completed', 'failed'].includes(install.status) || handledLocalInstall.current === install.id) return
    handledLocalInstall.current = install.id
    if (install.status === 'completed') {
      setLocalModelChoice(install.modelId)
      setNotice(install.message)
      void activateLocalAi(install.modelId)
    } else {
      setNotice(install.message)
    }
  }, [localModelStatus?.install?.id, localModelStatus?.install?.modelId, localModelStatus?.install?.status])

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
    draftDirtyRef.current = draftDirty
  }, [draftDirty])

  useEffect(() => {
    draftViewRevisionRef.current += 1
  }, [activeJob?.id, resultOffset, resultSort, resultTimeRange, selectedResult?.note_id, workspaceMode])

  useEffect(() => {
    if (!activeJob) {
      coverageJobIdRef.current = null
      setCoverage(null)
      setArtifacts([])
      setResults(null)
      setSelectedResult(null)
      setAudienceResults(null)
      return
    }
    if (coverageJobIdRef.current !== activeJob.id) {
      coverageJobIdRef.current = activeJob.id
      setCoverage(activeJob.coverage || parseCoverage(activeJob.workflowSummary) || null)
    }
    api.artifacts(activeJob.id).then(setArtifacts).catch(() => setArtifacts(activeJob.artifacts || []))
    void loadResults(activeJob.id, 0, { preserveDraft: true })
  }, [activeJob?.id, activeJob?.status, activeJob?.applicationCount, loadResults])

  useEffect(() => {
    setAudienceAnchorTarget(null)
  }, [activeJob?.id])

  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'queued')) return
    const timer = window.setInterval(() => {
      void loadResults(activeJob.id, resultOffset, { silent: true, preserveDraft: true })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [activeJob?.id, activeJob?.status, loadResults, resultOffset])

  useEffect(() => {
    if (!audienceReadJobId || workspaceMode !== 'general' || generalResultModule !== 'audience') return
    const timer = window.setTimeout(() => void loadAudienceResults(audienceReadJobId, 0, {
      preserveExisting: audienceReadJobId !== audienceSourceJobId,
      fallbackJobId: audienceSourceJobId,
      sourceJobId: audienceSourceJobId,
    }), audienceQuery ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [audienceKind, audiencePostId, audienceQuery, audienceReadJobId, audienceSourceJobId, generalResultModule, loadAudienceResults, trackedAudienceTask?.status, workspaceMode])

  useEffect(() => {
    if (!audienceAnchorTarget || !audienceReadJobId || workspaceMode !== 'general' || generalResultModule !== 'audience') return
    if (audienceAnchorTarget.kind !== audienceKind || audienceAnchorTarget.postId !== audiencePostId || audienceQuery) return
    const timer = window.setTimeout(() => void loadAudienceResults(audienceReadJobId, audienceAnchorTarget.offset, {
      preserveExisting: audienceReadJobId !== audienceSourceJobId,
      fallbackJobId: audienceSourceJobId,
      sourceJobId: audienceSourceJobId,
    }), 0)
    return () => window.clearTimeout(timer)
  }, [audienceAnchorTarget, audienceKind, audiencePostId, audienceQuery, audienceReadJobId, audienceSourceJobId, generalResultModule, loadAudienceResults, workspaceMode])

  useEffect(() => {
    if (!audienceAnchorTarget || audienceResults?.kind !== audienceAnchorTarget.kind || audienceResults.filters.postId !== audienceAnchorTarget.postId) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(audienceEntityDomId(audienceAnchorTarget.kind, audienceAnchorTarget.entityId))
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [audienceAnchorTarget, audienceResults])

  useEffect(() => {
    if (!audienceReadJobId || !trackedAudienceTask || workspaceMode !== 'general' || generalResultModule !== 'audience' || !['queued', 'resuming', 'running'].includes(trackedAudienceTask.status)) return
    const timer = window.setInterval(() => {
      void loadAudienceResults(audienceReadJobId, audienceOffset, {
        silent: true,
        preserveExisting: true,
        fallbackJobId: audienceSourceJobId,
        sourceJobId: audienceSourceJobId,
      })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [audienceOffset, audienceReadJobId, audienceSourceJobId, generalResultModule, loadAudienceResults, trackedAudienceTask?.id, trackedAudienceTask?.status, workspaceMode])

  useEffect(() => {
    if (!completionFlow?.jobId || !activeJob || activeJob.id !== completionFlow.jobId) return
    if (['queued', 'resuming', 'running'].includes(activeJob.status)) {
      if (completionFlow.stage !== 'running') {
        setCompletionFlow((current) => current ? {
          ...current,
          stage: 'running',
          message: '补全任务正在运行，已采集内容不会重复处理。',
        } : current)
      }
      return
    }
    if (completionFlow.stage !== 'running' && completionFlow.stage !== 'starting') return

    const mode = jobAnalysisMode(activeJob)
    const noun = mode === 'general' ? '内容分析' : '岗位信息'
    const sourceJobId = completionFlow.sourceJobId
    const incompleteBefore = completionFlow.incompleteBefore
    setCompletionFlow((current) => current ? {
      ...current,
      stage: 'refreshing',
      message: `任务已结束，正在重新读取${noun}并核对剩余缺失项。`,
    } : current)
    void api.results(activeJob.id, 0, 20, {
      analysisMode: mode,
      sort: resultSort,
      timeRange: resultTimeRange,
    }).then((payload) => {
      if (workspaceMode === mode && coverageJobIdRef.current === activeJob.id) {
        setResults(payload)
        coverageJobIdRef.current = activeJob.id
        setCoverage(payload.coverage || parseCoverage(payload) || null)
        setResultOffset(0)
        if (!draftDirtyRef.current) {
          setSelectedResult((current) => payload.items.find((item) => item.note_id === current?.note_id) || payload.items[0] || null)
        }
      }
      const remaining = resultCompletionStats(payload).total
      const completed = activeJob.status === 'completed' && remaining === 0
      const message = completed
        ? `补全完成，${noun}已重新载入，当前剩余 0 条未完整记录。`
        : activeJob.status === 'failed'
          ? `补全任务执行失败，仍有 ${remaining} 条未完整记录，请查看运行日志后重试。`
          : `本轮补全已停止，仍有 ${remaining} 条记录需要继续处理，检查点已保留。`
      setCompletionFlow({
        stage: completed ? 'complete' : 'needs_attention',
        sourceJobId,
        jobId: activeJob.id,
        incompleteBefore,
        message,
      })
      setNotice(message)
    }).catch((error) => {
      const message = `补全任务已结束，但结果刷新失败：${(error as Error).message}`
      setCompletionFlow({
        stage: 'needs_attention',
        sourceJobId,
        jobId: activeJob.id,
        incompleteBefore,
        message,
      })
      setNotice(message)
    })
  }, [activeJob, completionFlow, resultSort, resultTimeRange, workspaceMode])

  useEffect(() => {
    const rateLimitStatus = activeJob?.rateLimit?.status
    if (!activeJob?.rateLimit?.detected || !['waiting', 'scheduled', 'resuming', 'stopped'].includes(rateLimitStatus || '')) return
    const alertKey = `${activeJob.id}:${activeJob.rateLimit.detectedAt || 'detected'}:${rateLimitStatus}:${activeJob.rateLimit.retryAttempt || 0}`
    if (rateLimitAlertRef.current === alertKey) return
    rateLimitAlertRef.current = alertKey
    const autoAttempt = activeJob.rateLimit.autoResumeAttempt || 0
    const autoMax = activeJob.rateLimit.maxAutoResumeAttempts || 6
    setNotice(rateLimitStatus === 'waiting'
      ? `检测到平台限流：系统正在冷却并进行第 ${activeJob.rateLimit.retryAttempt || 1} / ${activeJob.rateLimit.maxRetries || 5} 次恢复探测，也可一键跳过等待。`
      : rateLimitStatus === 'scheduled'
        ? `限流检查点已保存，系统已排定第 ${autoAttempt + 1} / ${autoMax} 轮自动续跑。`
        : rateLimitStatus === 'resuming'
          ? '限流冷却已结束，正在从原任务检查点自动续跑。'
          : '自动恢复次数已用完，检查点已保存；可使用一键恢复重新探测并续跑。')
  }, [activeJob?.id, activeJob?.rateLimit?.detected, activeJob?.rateLimit?.detectedAt, activeJob?.rateLimit?.status, activeJob?.rateLimit?.retryAttempt, activeJob?.rateLimit?.maxRetries, activeJob?.rateLimit?.autoResumeAttempt, activeJob?.rateLimit?.maxAutoResumeAttempts])

  useEffect(() => {
    if (!trackedAudienceTask) return
    const summary = trackedAudienceTask.workflowSummary?.audience as Record<string, unknown> | undefined
    if (['waiting', 'scheduled', 'resuming'].includes(trackedAudienceTask.rateLimit?.status || '')) {
      const users = Number(summary?.usersDiscovered || 0)
      setAudienceActionMessage(`平台触发限流，已发现 ${users} 个公开用户并保存检查点；系统会自动冷却和续跑，也可一键跳过当前等待。`)
      return
    }
    if (trackedAudienceTask.rateLimit?.status === 'stopped') {
      const users = Number(summary?.usersDiscovered || 0)
      setAudienceActionMessage(`平台限流自动恢复重试已耗尽，已发现 ${users} 个公开用户，检查点完整保留；平台恢复后可继续补采。`)
      return
    }
    if (trackedAudienceTask.status === 'failed') {
      setAudienceActionMessage(`受众采集执行失败：${trackedAudienceTask.message || '请查看运行日志后重试。'}`)
      return
    }
    if (trackedAudienceTask.status === 'cancelled' || trackedAudienceTask.status === 'interrupted') {
      setAudienceActionMessage('受众采集已停止，已完成结果和检查点均已保留，可继续补采未完成帖子。')
      return
    }
    if (trackedAudienceTask.status === 'incomplete') {
      setAudienceActionMessage('本轮受众采集尚未达到全量覆盖，已完成结果和检查点均已保留，可继续补采未完成帖子。')
      return
    }
    if (trackedAudienceTask.status === 'completed') {
      setAudienceActionMessage(String(summary?.status || '') === 'complete'
        ? '评论、楼中楼回复与公开用户资料已完成全量采集。'
        : '本轮采集已结束，未覆盖部分已保留为待续跑状态。')
    }
  }, [trackedAudienceTask?.id, trackedAudienceTask?.status, trackedAudienceTask?.message, trackedAudienceTask?.rateLimit?.status, trackedAudienceTask?.workflowSummary?.audience])

  useEffect(() => {
    if (!activeJob || activeJob.coverage || activeJob.workflowSummary || coverage) return
    const summary = artifacts.find((artifact) => /(^|\/)application_intelligence\.json$/i.test(artifact.name))
      || artifacts.find((artifact) => /(?:workflow|coverage|agent).*(?:summary|report).*\.json$/i.test(artifact.name))
      || artifacts.find((artifact) => /summary\.json$/i.test(artifact.name))
    if (!summary) return
    const controller = new AbortController()
    fetch(api.artifactUrl(activeJob.id, summary), { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        if (coverageJobIdRef.current !== activeJob.id) return
        coverageJobIdRef.current = activeJob.id
        setCoverage(parseCoverage(value))
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') {
          coverageJobIdRef.current = null
          setCoverage(null)
        }
      })
    return () => controller.abort()
  }, [activeJob, artifacts, coverage])

  const applyEvent = useCallback((event: JobEvent) => {
    if (event.line) setLogs((current) => [...current.slice(-399), event.line!])
    const eventJob = event.job
    const eventSnapshot = event.experienceSnapshot
    const currentAttempt = eventJob?.attempts?.find((attempt) => attempt.attemptId === eventJob.currentAttemptId)
      || eventJob?.attempts?.at(-1)
    const legacyAudienceEvent = isAudienceOnlyJob(eventJob)
    const audienceEvent = legacyAudienceEvent || currentAttempt?.resumeScope === 'audience'
    if (eventJob) {
      if (audienceEvent) setAudienceTask(eventJob)
      setActiveJob((current) => {
        if (current?.id === eventJob.id) return mergeJobUpdate(current, eventJob)
        if (legacyAudienceEvent) return current
        return jobAnalysisMode(eventJob) === workspaceMode ? eventJob : current
      })
      setJobs((current) => replaceJobInPlace(current, eventJob))
    }
    if (eventSnapshot) {
      setActiveJob((current) => current?.id === eventSnapshot.jobId
        ? { ...current, experienceSnapshot: eventSnapshot, revision: Math.max(Number(current.revision || 0), Number(eventSnapshot.revision || 0)) }
        : current)
      setJobs((current) => current.map((job) => job.id === eventSnapshot.jobId
        ? { ...job, experienceSnapshot: eventSnapshot, revision: Math.max(Number(job.revision || 0), Number(eventSnapshot.revision || 0)) }
        : job))
    }
    if (event.artifacts && !legacyAudienceEvent) setArtifacts(event.artifacts)
    if (event.message && event.type === 'error') setNotice(event.message)
    if (
      event.type === 'done'
      || ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(event.job?.status || '')
    ) void loadJobs()
  }, [loadJobs, workspaceMode])

  const connectJob = useCallback((job: Job) => {
    const generation = streamGeneration.current + 1
    streamGeneration.current = generation
    cleanupStream.current?.()
    const expectedJobId = job.id
    const snapshot = experienceSnapshotForJob(job)
    setJobConnectionState('reconnecting')
    setJobLastEventAt(snapshot?.connection?.lastEventAt || job.progressUpdatedAt || null)
    cleanupStream.current = api.subscribe(job.id, (event) => {
      if (streamGeneration.current !== generation) return
      if (event.job && event.job.id !== expectedJobId) return
      if (event.experienceSnapshot && event.experienceSnapshot.jobId !== expectedJobId) return
      applyEvent(event)
    }, () => {
      if (streamGeneration.current !== generation) return
      window.setTimeout(() => void loadJobs(), 800)
    }, {
      afterSequence: snapshot?.throughSequence,
      onConnectionChange: (connection) => {
        if (streamGeneration.current !== generation) return
        setJobConnectionState(connection.state)
        if (connection.lastEventAt) setJobLastEventAt(connection.lastEventAt)
      },
    })
    return generation
  }, [applyEvent, loadJobs])

  const syncAuthoritativeJob = useCallback((job: Job) => {
    setJobs((current) => replaceJobInPlace(current, job))
    setActiveJob((current) => current?.id === job.id ? mergeJobUpdate(current, job) : current)
    if (isAudienceOnlyJob(job) || job.config?.audienceOnly || job.config?.collectAudience) setAudienceTask(job)
    if (['queued', 'resuming', 'running'].includes(job.status)) connectJob(job)
  }, [connectJob])

  const reconcileActionAfterTransportError = useCallback(async (
    job: Job,
    action: () => Promise<Job>,
  ): Promise<Job> => {
    // A lost response does not prove that the server rejected the action. Read
    // the persisted job first, then retry once with the same idempotency key.
    try {
      const current = await api.job(job.id)
      syncAuthoritativeJob(current)
      if (['queued', 'resuming', 'running'].includes(current.status)) return current
    } catch {
      // The retry below is still useful when the status endpoint is temporarily unavailable.
    }
    try {
      const retried = await action()
      syncAuthoritativeJob(retried)
      return retried
    } catch (retryError) {
      try {
        const current = await api.job(job.id)
        syncAuthoritativeJob(current)
        if (['queued', 'resuming', 'running'].includes(current.status)) return current
      } catch {
        // Preserve the original action error when both reconciliation reads fail.
      }
      throw retryError
    }
  }, [syncAuthoritativeJob])

  const activeExpansionRuntimeStatus = String(
    activeJob?.workflowSummary?.expansion && typeof activeJob.workflowSummary.expansion === 'object'
      ? (activeJob.workflowSummary.expansion as Record<string, unknown>).runtimeStatus || ''
      : '',
  )

  useEffect(() => {
    if (!activeJob) return
    const taskIsActive = ['queued', 'resuming', 'running'].includes(activeJob.status)
      || ['running', 'cancelling'].includes(activeExpansionRuntimeStatus)
    if (!taskIsActive) return
    const generation = connectJob(activeJob)
    return () => {
      if (streamGeneration.current === generation) disconnectJobStream()
    }
  }, [activeJob?.id, activeJob?.status, activeExpansionRuntimeStatus, connectJob, disconnectJobStream])

  const performRunJob = async (payload: JobRequest, sessionHint: AiSession | null = aiSession): Promise<Job | null> => {
    if (payload.mode === 'resume' || payload.resumeFromJobId) {
      setNotice('续跑必须通过原任务恢复入口执行。')
      return null
    }
    if (payload.analysisMode === 'general' && !payload.checkOnly && !sessionHint) {
      setNotice('内容模式需要先连接 AI 模型，正文、图片和动态栏目才会进入同一次分析。')
      document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return null
    }
    setSubmitting(true)
    setNotice(null)
    coverageJobIdRef.current = null
    setCoverage(null)
    setLogs([`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${payload.checkOnly ? '正在执行启动前检查...' : '正在创建任务...'}`])
    try {
      const latestPayload: JobRequest = {
        ...payload,
        searchSort: 'latest',
        maxAgeDays: payload.maxAgeDays,
        limit: 0,
        aiSessionId: sessionHint?.id || payload.aiSessionId || null,
      }
      if (payload.checkOnly) {
        const report = await api.preflight(latestPayload)
        const statusLabel = { passed: '通过', warning: '提醒', blocked: '阻断' } as const
        setLogs(report.checks.map((check) => (
          `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${statusLabel[check.status]}] ${check.message}${check.action ? `；处理：${check.action}` : ''}`
        )))
        const blockedCount = report.checks.filter((check) => check.status === 'blocked').length
        setNotice(report.ready ? '启动前检查已通过，可以创建正式任务。' : `启动前检查发现 ${blockedCount} 项阻断，尚未创建正式任务。`)
        return null
      }
      let effectivePayload = latestPayload
      let job: Job
      try {
        job = await api.createJob(effectivePayload)
      } catch (error) {
        const apiError = error as Error & { code?: string }
        if (apiError.code !== 'AI_SESSION_EXPIRED' || !sessionHint || !latestPayload.aiSessionId) throw error
        setLogs((current) => [...current, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] AI 会话已过期，正在自动重连...`])
        const session = await api.createAiSession({
          provider: sessionHint.provider,
          apiKey: '',
          model: sessionHint.model,
          baseUrl: sessionHint.baseUrl,
          wireApi: sessionHint.wireApi,
        })
        setAiSession(session)
        updateRequest('aiSessionId', session.id)
        effectivePayload = { ...latestPayload, aiSessionId: session.id }
        job = await api.createJob(effectivePayload)
        setLogs((current) => [...current, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] AI 已自动重连，任务创建成功。`])
      }
      setActiveJob(job)
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      connectJob(job)
      return job
    } catch (error) {
      setNotice((error as Error).message)
      return null
    } finally {
      setSubmitting(false)
    }
  }

  const runJob = (payload: JobRequest, sessionHint: AiSession | null = aiSession) => (
    draftGuard.requestTransition(payload.checkOnly ? '执行启动检查' : '启动新任务', () => performRunJob(payload, sessionHint))
  )

  const performBodyImport = async (records: BodyImportRecord[], sourceName: string) => {
    setSubmitting(true)
    setNotice(null)
    coverageJobIdRef.current = null
    setCoverage(null)
    setArtifacts([])
    setLogs([`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 正在创建 ${records.length} 条正文采集任务...`])
    try {
      const response = await api.createBodyImport({
        records,
        sourceName,
        analysisMode: workspaceMode,
        options: {
          browserProfile: request.browserProfile,
          relayPort: request.relayPort,
          gotoTimeoutMs: request.gotoTimeoutMs,
          noteDelaySeconds: request.noteDelaySeconds,
          speedMode: request.speedMode,
          randomDelayMinSeconds: request.randomDelayMinSeconds,
          randomDelayMaxSeconds: request.randomDelayMaxSeconds,
          securityVerificationTimeoutSeconds: request.securityVerificationTimeoutSeconds,
          maxAgeDays: request.maxAgeDays,
        },
      })
      const job = response.job
      setActiveJob(job)
      activeJobIdCache.current[workspaceMode] = job.id
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      connectJob(job)
      const ignored = response.summary.duplicateCount + response.summary.rejectedCount
      setNotice(`${job.status === 'queued' ? '任务已排队' : '正文采集已启动'}：${response.summary.acceptedCount} 条${ignored ? `，忽略 ${ignored} 条重复或无效记录` : ''}。`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const startBodyImport = (records: BodyImportRecord[], sourceName: string) => {
    draftGuard.requestTransition('启动批量正文采集', () => performBodyImport(records, sourceName))
  }

  const performResumeAudienceCollection = async (forceRateLimitRecovery = false, forcedJobId?: string) => {
    const resumeTargetJobId = forcedJobId || selectedAudienceDataJob?.id || linkedAudienceTask?.id || audienceSourceJobId
    const resumeTargetJob = jobs.find((job) => job.id === resumeTargetJobId)
      || (activeJob?.id === resumeTargetJobId ? activeJob : null)
    if (!resumeTargetJob || !resumeTargetJobId || jobAnalysisMode(resumeTargetJob) !== 'general') {
      const message = '请先选择一条非岗位内容采集任务。'
      setAudienceActionMessage(message)
      setNotice(message)
      return
    }
    const operationId = `${resumeTargetJobId}:audience`
    const idempotencyKey = resumeIdempotencyKeys.current.get(operationId)
      || newResumeIdempotencyKey(resumeTargetJobId, 'audience')
    resumeIdempotencyKeys.current.set(operationId, idempotencyKey)
    setAudienceResuming(true)
    setAudienceActionMessage(forceRateLimitRecovery ? '正在解除限流等待并从检查点续跑…' : '正在从检查点恢复原任务…')
    setNotice(null)
    try {
      const rateLimitRecovery = forceRateLimitRecovery || Boolean(
        resumeTargetJob.rateLimit?.detected && resumeTargetJob.rateLimit.status !== 'cleared',
      )
      const requestAudience = () => rateLimitRecovery
        ? api.recoverAudienceRateLimit(resumeTargetJobId, idempotencyKey)
        : api.resumeAudience(resumeTargetJobId, idempotencyKey)
      let response: Awaited<ReturnType<typeof api.resumeAudience>>
      try {
        response = await requestAudience()
      } catch (error) {
        const apiError = error as ApiError
        let current: Job | null = null
        try {
          current = await api.job(resumeTargetJobId)
          syncAuthoritativeJob(current)
        } catch {
          // The retry below uses the same key, so a late first response stays idempotent.
        }
        if (current && ['queued', 'resuming', 'running'].includes(current.status)) {
          response = {
            action: 'attached',
            sourceJobId: audienceSourceJobId || resumeTargetJobId,
            job: current,
            message: '任务已在运行，已重新连接当前进度。',
          }
        } else if (apiError.code === 'REQUEST_TIMEOUT' || apiError.status === 0 || !apiError.code) {
          response = await requestAudience()
        } else {
          throw error
        }
      }
      const resumedJob = response.job
      syncAuthoritativeJob(resumedJob)
      performSwitchGeneralResultModule('audience', resumeTargetJobId)
      setAudienceDataJobId(resumeTargetJobId)
      writeAudienceDataJobToLocation(resumeTargetJobId)
      await loadAudienceResults(resumeTargetJobId, 0, {
        preserveExisting: true,
        fallbackJobId: linkedAudienceTask?.id !== resumeTargetJobId ? linkedAudienceTask?.id : undefined,
        sourceJobId: audienceSourceJobId,
      })
      const message = response.action === 'signaled'
        ? '已跳过剩余冷却时间，正在立即探测页面；通过后会自动续采。'
        : response.action === 'already_complete'
        ? '当前受众结果已经完整，无需再次续采。'
        : response.action === 'attached'
          ? '原任务正在采集，已重新连接实时进度；已有内容保持显示。'
          : rateLimitRecovery
            ? '已取消限流倒计时并从原任务检查点续跑，已有内容保持显示。'
            : '已从原任务检查点继续，只补采未采集和部分采集的链接；已有内容保持显示。'
      setAudienceActionMessage(message)
      setNotice(message)
    } catch (error) {
      const apiError = error as Error & { code?: string }
      const message = apiError.code === 'JOB_BUSY'
        ? '当前任务仍在运行，受众采集暂未排入队列，请刷新后重试。'
        : `受众采集启动失败：${apiError.message}`
      setAudienceActionMessage(message)
      setNotice(message)
    } finally {
      setAudienceResuming(false)
      window.setTimeout(() => {
        if (resumeIdempotencyKeys.current.get(operationId) === idempotencyKey) {
          resumeIdempotencyKeys.current.delete(operationId)
        }
      }, 5_000)
    }
  }

  const resumeAudienceCollection = (forceRateLimitRecovery = false, forcedJobId?: string) => {
    if (draftGuard.dirty) setAudienceActionMessage('当前投递文案有未保存修改，请在弹窗中选择保存或放弃后继续。')
    return draftGuard.requestTransition(
      forceRateLimitRecovery ? '立即检查平台是否恢复' : '恢复其他任务',
      () => performResumeAudienceCollection(forceRateLimitRecovery, forcedJobId),
    )
  }

  const performGrowAudienceCollection = async () => {
    const growthTargetJobId = selectedAudienceDataJob?.id || linkedAudienceTask?.id || audienceSourceJobId
    const growthTargetJob = jobs.find((job) => job.id === growthTargetJobId)
      || (activeJob?.id === growthTargetJobId ? activeJob : null)
    if (!growthTargetJob || !growthTargetJobId || jobAnalysisMode(growthTargetJob) !== 'general') {
      const message = '请先选择一条非岗位内容采集任务。'
      setAudienceActionMessage(message)
      setNotice(message)
      return
    }
    setAudienceGrowing(true)
    setAudienceActionMessage(`正在按最新排序扩充帖子池（最多 ${audienceGrowthScrolls} 轮）…`)
    setNotice(null)
    try {
      const response = await api.growAudience(growthTargetJobId, audienceGrowthScrolls)
      const growthJob = response.job
      setAudienceTask(growthJob)
      setJobs((current) => replaceJobInPlace(current, growthJob))
      if (['queued', 'resuming', 'running'].includes(growthJob.status)) connectJob(growthJob)
      performSwitchGeneralResultModule('audience', growthTargetJobId)
      setAudienceDataJobId(growthTargetJobId)
      writeAudienceDataJobToLocation(growthTargetJobId)
      await loadAudienceResults(growthTargetJobId, 0, {
        preserveExisting: true,
        fallbackJobId: linkedAudienceTask?.id !== growthTargetJobId ? linkedAudienceTask?.id : undefined,
        sourceJobId: audienceSourceJobId,
      })
      const message = response.action === 'attached'
        ? '该任务已经在运行，已重新连接实时进度；现有帖子与评论继续保留。'
        : `扩量任务已启动：将按最新排序重新发现 ${audienceGrowthScrolls} 轮，新帖子去重追加后继续采集正文、评论与用户资料。`
      setAudienceActionMessage(message)
      setNotice(message)
    } catch (error) {
      const apiError = error as Error & { code?: string }
      const message = apiError.code === 'JOB_BUSY'
        ? '当前任务仍在运行，请等待或中断后再扩充帖子池。'
        : `扩充帖子池启动失败：${apiError.message}`
      setAudienceActionMessage(message)
      setNotice(message)
    } finally {
      setAudienceGrowing(false)
    }
  }

  const growAudienceCollection = () => (
    draftGuard.requestTransition('扩充帖子池', performGrowAudienceCollection)
  )

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (request.speedMode === 'random' && request.randomDelayMinSeconds > request.randomDelayMaxSeconds) {
      setNotice('随机节奏的最短间隔需要小于或等于最长间隔')
      return
    }
    const requiredFields: Array<[keyof CandidateApplicationProfile, string]> = request.analysisMode === 'job' ? [
      ['name', '姓名'],
      ['school', '学校'],
      ['major', '专业'],
      ['email', '邮箱'],
    ] : []
    const missing = requiredFields.filter(([key]) => !request.candidateProfile[key].trim()).map(([, label]) => label)
    if (missing.length) {
      setNotice(`请先填写候选人信息：${missing.join('、')}`)
      return
    }
    void runJob({ ...request, analysisMode: workspaceMode, checkOnly: false })
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

  const performResumeJob = async (job: Job, scope: ResumeScope = 'full', sessionHint: AiSession | null = aiSession) => {
    const needsAi = !['audience', 'artifacts', 'discovery'].includes(scope)
    let session = sessionHint
    if (needsAi && !session) {
      setRestoringAi(true)
      setNotice('AI 会话已失效，正在自动恢复已保存的模型配置…')
      try {
        session = await restoreAiSession()
      } catch (error) {
        setNotice((error as Error).message)
        document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth' })
        return null
      } finally {
        setRestoringAi(false)
      }
    }
    const operationId = `${job.id}:${scope}`
    const idempotencyKey = resumeIdempotencyKeys.current.get(operationId)
      || newResumeIdempotencyKey(job.id, scope)
    resumeIdempotencyKeys.current.set(operationId, idempotencyKey)
    setSubmitting(true)
    setNotice('正在恢复原任务…')
    try {
      const requestResume = () => api.resumeJob(job.id, {
        scope,
        idempotencyKey,
        ...(session ? { aiSessionId: session.id } : {}),
      })
      let resumedJob: Job
      try {
        resumedJob = await requestResume()
      } catch (error) {
        const apiError = error as Error & { code?: string; status?: number }
        if (apiError.code === 'JOB_ALREADY_RUNNING' || apiError.code === 'JOB_ATTEMPT_ACTIVE') {
          resumedJob = await api.job(job.id)
        } else if (apiError.code === 'AI_SESSION_EXPIRED' && needsAi) {
          setRestoringAi(true)
          try {
            session = await restoreAiSession()
          } finally {
            setRestoringAi(false)
          }
          resumedJob = await requestResume()
        } else if (apiError.code === 'REQUEST_TIMEOUT' || apiError.status === 0 || !apiError.code) {
          resumedJob = await reconcileActionAfterTransportError(job, requestResume)
        } else {
          throw error
        }
      }
      if (resumedJob.id !== job.id) {
        throw new Error('恢复响应返回了不同的任务 ID。')
      }
      setActiveJob((current) => current?.id === job.id ? resumedJob : current)
      setJobs((current) => replaceJobInPlace(current, resumedJob))
      if (scope === 'audience') setAudienceTask(resumedJob)
      if (['queued', 'resuming', 'running'].includes(resumedJob.status)) connectJob(resumedJob)
      return resumedJob
    } catch (error) {
      setNotice((error as Error).message)
      return null
    } finally {
      setSubmitting(false)
      window.setTimeout(() => {
        if (resumeIdempotencyKeys.current.get(operationId) === idempotencyKey) {
          resumeIdempotencyKeys.current.delete(operationId)
        }
      }, 5_000)
    }
  }

  const resumeJob = (job: Job, scope: ResumeScope = 'full', sessionHint: AiSession | null = aiSession) => (
    draftGuard.requestTransition(job.id === activeJob?.id ? '恢复当前任务' : '恢复其他任务', () => performResumeJob(job, scope, sessionHint))
  )

  const refreshSecurityAndContinue = async (job: Job) => {
    if (securityRecovering || submitting) return
    setSecurityRecovering(true)
    setNotice(null)
    try {
      const status = await api.relayStatus(relayConfig.port)
      setRelay(status)
      const tabCount = Array.isArray(status.tabs) ? status.tabs.length : Number(status.tabs || 0)
      const siteReady = Boolean(status.running && status.cdpReady && tabCount > 0 && Number(status.xiaohongshuTabs || 0) > 0)
      if (!siteReady) {
        setNotice('刷新后仍未检测到可用的小红书页面，请保留验证完成后的页面并确认 Relay 已连接。')
        return
      }

      const nextJobs = await api.jobs()
      setJobs(nextJobs)
      const refreshedJob = nextJobs.find((candidate) => candidate.id === job.id) || job
      setActiveJob(refreshedJob)
      if (['queued', 'resuming', 'running'].includes(refreshedJob.status)) {
        connectJob(refreshedJob)
        setNotice('验证状态已刷新，原任务会继续使用同一任务 ID。')
        window.setTimeout(() => void loadJobs(), 5_500)
        return
      }
      if (!refreshedJob.resumeAvailable) {
        setNotice('验证状态已刷新，但该任务尚无可用检查点；请等待任务写入检查点后再刷新。')
        return
      }

      const resumed = await performResumeJob(refreshedJob, 'full')
      if (resumed) setNotice('安全验证已完成，已从原任务检查点继续。')
    } catch (error) {
      setRelay({ running: false, cdpReady: false, port: relayConfig.port, message: (error as Error).message })
      setNotice((error as Error).message)
    } finally {
      setSecurityRecovering(false)
    }
  }

  const performJourneyProblemAction = async (job: Job, problem: UserProblem, actionId: 'open_login' | 'check_recovery' | 'resume') => {
    if (journeyActionBusy) return
    setJourneyActionBusy(true)
    setNotice(null)
    let operationId = ''
    let idempotencyKey = ''
    try {
      if (actionId === 'open_login') {
        const result = await api.openJobLogin(job.id)
        setNotice(result.message || '验证页面已打开；完成页面操作后可回到这里继续。')
        window.setTimeout(() => void refreshRelay(), 1500)
        return
      }

      operationId = `${job.id}:journey:${actionId}:${problem.affectedStage}`
      idempotencyKey = resumeIdempotencyKeys.current.get(operationId)
        || newResumeIdempotencyKey(job.id, 'full')
      resumeIdempotencyKeys.current.set(operationId, idempotencyKey)
      const response = actionId === 'check_recovery'
        ? await api.checkJobRecovery(job.id, { idempotencyKey })
        : await api.retryJobStage(job.id, {
            stage: problem.affectedStage || 'task',
            idempotencyKey,
            ...(aiSession ? { aiSessionId: aiSession.id } : {}),
          })
      const nextJob = response.job
      setActiveJob((current) => current?.id === nextJob.id ? mergeJobUpdate(current, nextJob) : current)
      setJobs((current) => replaceJobInPlace(current, nextJob))
      if (response.scope === 'audience') setAudienceTask(nextJob)
      if (['queued', 'resuming', 'running'].includes(nextJob.status)) connectJob(nextJob)
      const message = response.action === 'signaled'
        ? '已安排一次立即恢复检查；通过后会从已保存位置继续。'
        : response.action === 'attached'
          ? '任务仍在运行，已重新连接当前进度。'
          : actionId === 'check_recovery'
            ? '恢复检查已启动，只处理尚未完成的内容。'
            : '当前步骤已从已保存位置重新启动。'
      setNotice(message)
    } catch (error) {
      const apiError = error as ApiError
      setNotice(apiError.problem?.userMessage || apiError.message)
    } finally {
      setJourneyActionBusy(false)
      if (operationId && idempotencyKey) {
        window.setTimeout(() => {
          if (resumeIdempotencyKeys.current.get(operationId) === idempotencyKey) {
            resumeIdempotencyKeys.current.delete(operationId)
          }
        }, 5_000)
      }
    }
  }

  const performCompleteMissingResults = async () => {
    if (!activeJob || completingMissing || submitting) return
    const generalMode = workspaceMode === 'general' || results?.analysisMode === 'general' || jobAnalysisMode(activeJob) === 'general'
    const sourceJobId = activeJob.id
    const noun = generalMode ? '内容分析' : '岗位信息'
    const knownIncomplete = results ? resultCompletionStats(results).total : null
    if (knownIncomplete === 0) {
      setCompletionFlow({
        stage: 'complete',
        sourceJobId,
        jobId: sourceJobId,
        incompleteBefore: 0,
        message: `核对完成，当前没有未完整${noun}。`,
      })
      setNotice(`所有${noun}均已完整，无需重复运行。`)
      return
    }
    setCompletingMissing(true)
    setCompletionFlow({
      stage: 'checking',
      sourceJobId,
      incompleteBefore: knownIncomplete,
      message: `正在核对未完整${noun}和可复用检查点。`,
    })
    setNotice(`正在核对所有未完整${noun}…`)
    try {
      let session = aiSession && aiSessionMatchesSelection(aiSession) ? aiSession : null
      const completionProvider = providers.find((item) => item.id === providerId)
      const hasSelectedAiConfiguration = Boolean(
        completionProvider
        && (completionProvider.local || completionProvider.configured || apiKey.trim()),
      )
      if (!session && hasSelectedAiConfiguration && completionProvider) {
        setRestoringAi(true)
        setCompletionFlow((current) => current ? {
          ...current,
          stage: 'restoring_ai',
          message: '正在连接当前选择的模型，然后恢复正文采集。',
        } : current)
        try {
          session = apiKey.trim()
            ? await createSelectedAiSession()
            : await restoreAiSession(completionProvider)
        } finally {
          setRestoringAi(false)
        }
      }
      setCompletionFlow((current) => current ? {
        ...current,
        stage: 'starting',
        message: '正在从检查点恢复原任务，仅处理缺失记录。',
      } : current)

      const requestCompletion = () => api.completeMissing(sourceJobId, session?.id || null)
      let response
      try {
        response = await requestCompletion()
      } catch (error) {
        const apiError = error as Error & { code?: string }
        if (!['AI_SESSION_EXPIRED', 'AI_SESSION_UNAVAILABLE'].includes(apiError.code || '')) throw error
        if (!completionProvider || !hasSelectedAiConfiguration) throw error
        setRestoringAi(true)
        setCompletionFlow((current) => current ? {
          ...current,
          stage: 'restoring_ai',
          message: 'AI 会话已过期，正在自动重连后继续。',
        } : current)
        try {
          session = apiKey.trim()
            ? await createSelectedAiSession()
            : await restoreAiSession(completionProvider)
        } finally {
          setRestoringAi(false)
        }
        response = await requestCompletion()
      }

      setActiveJob(response.job)
      setJobs((current) => replaceJobInPlace(current, response.job))
      if (response.action === 'already_complete') {
        setCompletionFlow({
          stage: 'complete',
          sourceJobId: response.sourceJobId,
          jobId: response.job.id,
          incompleteBefore: 0,
          message: `核对完成，当前没有未完整${noun}。`,
        })
        setNotice(`所有${noun}均已完整，无需重复运行。`)
        await loadResults(response.job.id, 0)
        return
      }
      if (['queued', 'resuming', 'running'].includes(response.job.status)) connectJob(response.job)
      setCompletionFlow({
        stage: 'running',
        sourceJobId: response.sourceJobId,
        jobId: response.job.id,
        incompleteBefore: response.incompleteBefore ?? knownIncomplete,
        message: response.action === 'attached'
          ? '原任务正在运行，页面会持续显示实时进度。'
          : `已恢复原任务，仅处理 ${response.incompleteBefore ?? knownIncomplete ?? 0} 条缺失记录。`,
      })
      setNotice(response.action === 'attached' ? '原任务正在继续补全。' : '已从原任务检查点继续，完成后会自动刷新结果。')
    } catch (error) {
      const apiError = error as Error & { code?: string }
      const message = apiError.code === 'RESUME_CHECKPOINTS_MISSING'
        ? '当前任务缺少可复用的正文检查点，请先重新运行一次全量智能采集。'
        : apiError.code === 'COMPLETION_SOURCE_UNAVAILABLE'
          ? '当前任务尚未生成结构化结果，请等待首批结果出现后再补全。'
          : apiError.code === 'JOB_BUSY'
            ? '当前有另一项采集任务在运行；完成后再次点击，产品会自动接管补全。'
            : apiError.message
      setCompletionFlow((current) => ({
        stage: 'needs_attention',
        sourceJobId: current?.sourceJobId || sourceJobId,
        jobId: current?.jobId,
        incompleteBefore: current?.incompleteBefore ?? knownIncomplete,
        message,
      }))
      setNotice(message)
      if (apiError.code === 'AI_SESSION_EXPIRED') {
        document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } finally {
      setCompletingMissing(false)
      setRestoringAi(false)
    }
  }

  const completeMissingResults = () => (
    draftGuard.requestTransition('重新生成当前文案', performCompleteMissingResults)
  )

  const performSelectJob = (job: Job) => {
    draftViewRevisionRef.current += 1
    disconnectJobStream()
    const targetMode = jobAnalysisMode(job)
    const scopedJobs = jobs.filter((candidate) => jobAnalysisMode(candidate) === targetMode)
    const sourceJob = audienceSourceJobFor(scopedJobs, job)
    const nextAudienceTask = targetMode === 'general'
      ? (isAudienceOnlyJob(job) ? job : audienceTaskForSource(scopedJobs, sourceJob?.id || null))
      : null
    if (sourceJob?.id !== activeJob?.id) {
      setAudienceResults(null)
      setAudienceActionMessage(null)
      setAudienceOffset(0)
      setAudiencePostId('')
      setAudienceQuery('')
    }
    setActiveJob(sourceJob)
    setAudienceTask(nextAudienceTask)
    setLogs([])
    if (isAudienceOnlyJob(job)) performSwitchGeneralResultModule('audience', job.id)
    const liveJob = nextAudienceTask && ['running', 'resuming', 'queued'].includes(nextAudienceTask.status)
      ? nextAudienceTask
      : sourceJob
    if (liveJob && ['running', 'resuming', 'queued'].includes(liveJob.status)) connectJob(liveJob)
  }


  const selectJob = (job: Job) => (
    draftGuard.requestTransition('切换任务', () => performSelectJob(job))
  )

  const openHistoryJob = (job: Job) => {
    const targetMode = jobAnalysisMode(job)
    if (targetMode !== workspaceMode) {
      activeJobIdCache.current[targetMode] = job.id
      switchWorkspace(targetMode)
      return
    }
    void selectJob(job)
  }

  const openFeaturedJob = () => {
    if (!featuredJob) {
      setNotice('竞赛演示任务尚未迁移到当前数据目录。')
      return
    }
    openHistoryJob(featuredJob)
  }

  const tabCount = Array.isArray(relay?.tabs) ? relay.tabs.length : Number(relay?.tabs || 0)
  const xiaohongshuTabCount = Number(relay?.xiaohongshuTabs || 0)
  const relayConfigValid = Number.isInteger(relayConfig.port) && relayConfig.port >= 1024 && relayConfig.port <= 65535 && Boolean(relayConfig.profile.trim())
  const relayStatusMatchesConfig = relay?.port === relayConfig.port
  const relayServiceReady = Boolean(relayStatusMatchesConfig && relay?.running && relay?.cdpReady)
  const relayReady = relayServiceReady && tabCount > 0
  const relaySiteReady = relayReady && xiaohongshuTabCount > 0
  const relayPressureHigh = relay?.targetPressure === 'high' || Boolean(relay?.recoveryRecommended)
  const relayAutomaticRecovery = Boolean(relay?.supervisor?.inProgress)
  const relayRecoveryBusy = relayRecovering || relayAutomaticRecovery
  const relayGuideTitle = relaySiteReady
    ? 'Relay 已连通，目标页已打开'
    : relayServiceReady
      ? 'Relay 服务已启动，继续打开目标页'
      : '从这里完成 Relay 手动连接'
  const relayGuideDescription = relaySiteReady
    ? `端口 ${relayConfig.port} 正常，已发现 ${xiaohongshuTabCount} 个小红书标签页。`
    : relayServiceReady
      ? `端口 ${relayConfig.port} 已响应；下一步在托管浏览器中打开小红书并完成登录。`
      : `已有 Relay 可填写实际端口；首次使用可保留 ${defaultRelayConfig.port} / ${defaultRelayConfig.profile}。`
  const relayGuideSteps = [
    {
      label: '连接参数',
      detail: relayConfigValid ? `${relayConfig.port} · ${relayConfig.profile}` : '检查端口和 Profile',
      state: relayConfigValid ? 'done' : 'current',
    },
    {
      label: 'Relay 服务',
      detail: relayServiceReady ? 'CDP 端口响应正常' : '等待启动或接入',
      state: relayServiceReady ? 'done' : relayConfigValid ? 'current' : 'waiting',
    },
    {
      label: '浏览器标签页',
      detail: relayReady ? `已接入 ${tabCount} 个标签页` : '等待浏览器连接',
      state: relayReady ? 'done' : relayServiceReady ? 'current' : 'waiting',
    },
    {
      label: '目标页面',
      detail: relaySiteReady ? `已发现 ${xiaohongshuTabCount} 个小红书页面` : '打开页面并在浏览器内登录',
      state: relaySiteReady ? 'done' : relayReady ? 'current' : 'waiting',
    },
  ]
  const workspaceJobs = useMemo(
    () => jobs.filter((job) => jobAnalysisMode(job) === workspaceMode),
    [jobs, workspaceMode],
  )
  const historyModeCounts = useMemo(() => jobs.reduce(
    (counts, job) => ({ ...counts, [jobAnalysisMode(job)]: counts[jobAnalysisMode(job)] + 1 }),
    { job: 0, general: 0 } as Record<AnalysisMode, number>,
  ), [jobs])
  const historyJobs = useMemo(
    () => historyScope === 'all' ? jobs : jobs.filter((job) => jobAnalysisMode(job) === historyScope),
    [historyScope, jobs],
  )
  const featuredJob = useMemo(() => jobs.find((job) => job.id === FEATURED_JOB_ID) || null, [jobs])
  const featuredSummary = featuredJob?.workflowSummary || {}
  const featuredExperience = featuredJob
    ? jobExperienceView(featuredJob, jobAnalysisMode(featuredJob), 'live', null)
    : null
  const featuredCoverage = featuredJob?.id === activeJob?.id ? coverage : null
  const featuredDiscovered = Number(featuredCoverage?.discovered ?? featuredExperience?.counts.discovered ?? featuredSummary.cardsDiscovered ?? featuredJob?.discoveredCount ?? 0)
  const featuredBodies = Number(featuredCoverage?.bodySucceeded ?? featuredExperience?.counts.fullText ?? featuredSummary.bodiesCaptured ?? featuredJob?.bodyProcessedCount ?? 0)
  const featuredDrafts = Number(featuredCoverage?.draftsGenerated ?? featuredJob?.applicationCount ?? featuredSummary.applicationCopyGenerated ?? 0)
  const featuredPending = Number(featuredCoverage
    ? Math.max(0, Number(featuredCoverage.discovered ?? 0) - Math.max(Number(featuredCoverage.bodySucceeded ?? 0), Number(featuredCoverage.draftsGenerated ?? 0)))
    : featuredExperience?.counts.pending ?? Math.max(0, featuredDiscovered - featuredBodies))
  const featuredCollectionComplete = featuredDiscovered > 0 && featuredBodies >= featuredDiscovered && featuredPending === 0
  const featuredQualityNeedsReview = String(featuredSummary.status || '') === 'failed'
  const featuredAccessIssue = featuredExperience?.issues.find((issue) => ['RATE_LIMITED', 'SECURITY_VERIFICATION', 'LOGIN_REQUIRED'].includes(issue.code))
  const featuredStateLabel = featuredAccessIssue?.userTitle
    || (featuredCollectionComplete
      ? featuredQualityNeedsReview ? '采集完成 · 材料待检查' : '采集完成'
      : null)
    || (featuredJob ? statusText[featuredJob.status] : '待迁移')
  const effectiveHistoryPageSize = historyPageSize === 0 ? Math.max(historyJobs.length, 1) : historyPageSize
  const historyPageCount = Math.max(1, Math.ceil(historyJobs.length / effectiveHistoryPageSize))
  const currentHistoryPage = Math.min(historyPage, historyPageCount)
  const historyStart = (currentHistoryPage - 1) * effectiveHistoryPageSize
  const visibleHistoryJobs = historyJobs.slice(historyStart, historyStart + effectiveHistoryPageSize)
  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPageCount))
  }, [historyPageCount])
  useEffect(() => {
    setHistoryPage(1)
  }, [historyScope, historyPageSize])
  const runningCount = workspaceJobs.filter((job) => ['queued', 'resuming', 'running'].includes(job.status)).length
  const completedCount = workspaceJobs.filter((job) => job.status === 'completed').length
  const failedCount = workspaceJobs.filter((job) => job.status === 'failed').length
  const incompleteCount = workspaceJobs.filter((job) => ['incomplete', 'cancelled', 'interrupted', 'blocked'].includes(job.status)).length
  const currentArtifacts = artifacts.length ? artifacts : activeJob?.artifacts || []
  const discoveredCount = Number(
    experienceSnapshotForJob(activeJob)?.counts.discovered
      ?? activeJob?.bodyMetrics?.discovered
      ?? activeJob?.discoveredCount
      ?? 0,
  )
  const exportCount = useMemo(() => workspaceJobs.reduce((sum, job) => sum + (job.artifactCount ?? job.artifacts?.length ?? 0), 0), [workspaceJobs])
  const activeAllMode = activeJob?.config?.limit === 0
  const activeBodyImport = activeJob?.config?.bodyOnly === true
  const activeAnalysisMode = workspaceMode
  const batchSurfaceActive = activeAnalysisMode === 'job' && applicationView === 'batch'
  const audienceModuleActive = activeAnalysisMode === 'general' && generalResultModule === 'audience'
  const expansionModuleActive = activeAnalysisMode === 'general' && generalResultModule === 'expansion'
  const displayJobConnectionState: WorkflowConnectionState = jobConnectionState === 'live'
    && jobLastEventAt
    && clock.getTime() - new Date(jobLastEventAt).getTime() > 30_000
    ? 'stale'
    : jobConnectionState
  const readableJobView = activeJob
    ? jobExperienceView(activeJob, activeAnalysisMode, displayJobConnectionState, jobLastEventAt)
    : null
  const accessIssue = readableJobView?.issues.find((issue) => ['RATE_LIMITED', 'SECURITY_VERIFICATION', 'LOGIN_REQUIRED'].includes(issue.code))
  const readableIssue = accessIssue
    || readableJobView?.issues.find((issue) => issue.requiresUserAction || issue.severity === 'blocking')
  const readableStage = readableJobView?.stages.find((stage) => ['running', 'waiting_system', 'waiting_user', 'retrying'].includes(stage.state))
    || readableJobView?.stages.find((stage) => stage.state === 'partial')
    || null
  const readableSavedCount = readableJobView
    ? Math.max(readableJobView.counts.fullText, readableJobView.counts.resultReady)
    : 0
  const readableNextStep = accessIssue
    ? accessIssue.userMessage
    : readableIssue?.requiresUserAction
    ? `请先处理“${readableIssue.userTitle}”，完成后点击上方的继续按钮。`
    : activeJob && ['queued', 'resuming', 'running'].includes(activeJob.status)
      ? '系统会继续处理，并在每完成一项后保存进度；你可以先离开页面。'
      : activeJob?.status === 'completed'
        ? '这项任务已经完成，可以直接查看下方结果。'
        : activeJob && ['incomplete', 'interrupted', 'cancelled', 'blocked'].includes(activeJob.status)
          ? '已有结果会保留，点击上方的继续按钮即可从剩余内容接着处理。'
          : '当前没有需要你处理的事项。'
  const workflowSummary = activeJob?.workflowSummary || {}
  const expansionSummary = workflowSummary.expansion && typeof workflowSummary.expansion === 'object'
    ? workflowSummary.expansion as Record<string, unknown>
    : null
  const expansionRuntimeStatus = String(expansionSummary?.runtimeStatus || '')
  const expansionStatus = expansionRuntimeStatus || String(expansionSummary?.status || 'idle')
  const expansionStatusText = ({ idle: '未运行', running: `第 ${Number(expansionSummary?.roundIndex || 0)}/${Number((expansionSummary?.config as Record<string, unknown> | undefined)?.rounds || expansionSummary?.maxRounds || 0)} 轮`, cancelling: '正在停止', complete: '已完成', completed: '已完成', partial: '部分', failed: '失败', blocked: '已阻断', cancelled: '可继续', interrupted: '可继续' } as Record<string, string>)[expansionStatus] || expansionStatus
  const partialAnalysis = workflowSummary.analysisMode === 'security_timeout_partial'
  const securityVerification = (workflowSummary.securityVerification || {}) as Record<string, unknown>
  const securityStatus = activeJob?.securityRestriction?.status || String(securityVerification.status || '')
  const securityJobRunning = Boolean(activeJob && ['queued', 'resuming', 'running'].includes(activeJob.status))
  const securityReportedWaiting = securityStatus === 'waiting'
  const securityTimedOut = securityStatus === 'timed_out' || (
    partialAnalysis
    && (workflowSummary.collectionStopReason === 'security_verification_timeout' || securityVerification.status === 'timed_out')
  ) || (securityReportedWaiting && !securityJobRunning)
  const securityTimeoutSeconds = Number(activeJob?.securityRestriction?.timeoutSeconds || securityVerification.timeoutSeconds || activeJob?.config?.securityVerificationTimeoutSeconds || 600)
  const securityTimeoutLabel = securityTimeoutSeconds % 60 === 0 ? `${securityTimeoutSeconds / 60} 分钟` : `${securityTimeoutSeconds} 秒`
  const codexRuntime = results?.codexRuntime || (workflowSummary.codexRuntime as Record<string, unknown> | undefined)
  const selectedProvider = providers.find((item) => item.id === providerId)
  const selectedLocalModel = localModelStatus?.catalog.find((item) => item.id === localModelChoice)
  const installedLocalModelNames = localModelStatus?.installedModels.map((item) => item.name).filter(Boolean) || []
  const selectedCoverLetterLocalModel = installedLocalModelNames.find((model) => model.toLowerCase() === localModelChoice.toLowerCase())
    || installedLocalModelNames[0]
    || ''
  const coverLetterLocalReady = Boolean(localModelStatus?.runtime.ready && selectedCoverLetterLocalModel)
  const localModelGroups = (localModelStatus?.catalog || []).reduce<Array<{ family: string; models: LocalModelStatus['catalog'] }>>((groups, model) => {
    const group = groups.find((item) => item.family === model.family)
    if (group) group.models.push(model)
    else groups.push({ family: model.family, models: [model] })
    return groups
  }, [])
  const localInstallActive = Boolean(localModelStatus?.install && ['queued', 'running'].includes(localModelStatus.install.status))
  const activeProfile = profiles.find((item) => item.id === request.profileId)
  const profileResumeSources = (activeProfile?.sourceFiles || []).filter((name) => /\.(?:pdf|doc|docx|txt)$/i.test(name))
  const selectedProfileAttachmentSource = profileResumeSources.includes(profileAttachmentSource)
    ? profileAttachmentSource
    : profileResumeSources[0] || ''
  const profileAiRouteLabel = selectedProvider?.local
    ? `${selectedProvider.label} · ${aiModel || '待选择'} · 未配置外部模型时默认`
    : `${selectedProvider?.label || providerId} · ${aiModel || '待选择'} · 严格使用当前选择`
  const profileAiSessionReady = Boolean(aiSession && aiSessionMatchesSelection(aiSession))
  const candidateReady = [
    request.candidateProfile.name,
    request.candidateProfile.school,
    request.candidateProfile.major,
    request.candidateProfile.email,
  ].every((value) => value.trim())
  const backgroundReady = Boolean(request.profileId && activeProfile)
  const readinessChecks = [
    { label: 'AI 会话', ready: Boolean(aiSession), detail: aiSession ? `${selectedProvider?.label || providerId} · ${aiSession.model}` : '等待连接' },
    ...(request.analysisMode === 'job' ? [
      { label: '背景记忆', ready: backgroundReady, detail: activeProfile?.display_name || '请选择档案' },
      { label: '候选人资料', ready: candidateReady, detail: candidateReady ? '必填字段完整' : '姓名、学校、专业、邮箱' },
    ] : []),
    { label: '搜索关键词', ready: Boolean(request.keyword.trim()), detail: request.keyword.trim() || '请输入关键词' },
  ]
  const missingReadiness = readinessChecks.filter((item) => !item.ready).map((item) => item.label)
  const selectedDeliveryRoutes = selectedResult ? deliveryRoutes(selectedResult) : []
  const selectedEmailRoute = selectedDeliveryRoutes.find((route) => route.channel === 'email' && route.actionable)
  const selectedMessageRoute = selectedDeliveryRoutes.find((route) => route.channel === 'direct_message' && route.actionable)
  const selectedAttachments = (applicationAttachments?.attachments || []).filter((attachment) => attachment.selected && attachment.status === 'ready')
  const selectedAttachmentIds = selectedAttachments.map((attachment) => attachment.attachmentId)
  const selectedAttachmentBytes = selectedAttachments.reduce((total, attachment) => total + attachment.size, 0)
  const selectedApplicationContextKey = activeJob && selectedResult ? `${activeJob.id}:${selectedResult.note_id}` : ''
  const existingApplicationContext = selectedResult?.outreach?.applicationContext
  const selectedApplicationChannel: ApplicationContext['channel'] = selectedEmailRoute
    ? 'email'
    : selectedMessageRoute
      ? 'direct_message'
      : existingApplicationContext?.channel || 'email'
  const hasPreviousContact = Boolean(
    selectedResult?.delivery?.sendAudit?.some((entry) => entry.status === 'sent' || Boolean(entry.sentAt))
    || ['applied', 'messaged', 'email_sent', 'sent'].includes(selectedResult?.delivery?.action || ''),
  )
  const selectedApplicationTone = applicationToneOverrides[selectedApplicationContextKey]
    || existingApplicationContext?.tone
    || 'natural'
  const selectedApplicationContext: ApplicationContext = {
    channel: selectedApplicationChannel,
    contactStage: hasPreviousContact ? 'follow_up' : existingApplicationContext?.contactStage || 'first_contact',
    tone: selectedApplicationTone,
    resumeAttached: selectedAttachments.some((attachment) => (
      ['candidate_profile', 'generated_resume'].includes(attachment.source)
      || /(?:resume|curriculum[ _-]*vitae|\bcv\b|简历)/i.test(`${attachment.displayName} ${attachment.originalName}`)
    )),
    coverLetterAttached: selectedAttachments.some((attachment) => (
      attachment.source === 'generated_cover_letter'
      || /(?:cover[ _-]*letter|求职信|申请信)/i.test(`${attachment.displayName} ${attachment.originalName}`)
    )),
    recipientType: existingApplicationContext?.recipientType
      || (selectedApplicationChannel === 'direct_message' ? 'author' : 'recruiter'),
  }
  const selectedRecipientTypeLabel = ({
    recruiter: '招聘方',
    hiring_manager: '用人经理',
    author: '帖子作者',
  } as Record<string, string>)[selectedApplicationContext.recipientType] || selectedApplicationContext.recipientType
  const importableArtifacts = artifacts.filter((artifact) => /\.(pdf|docx?|txt|png|jpe?g)$/i.test(artifact.name))
  const selectedResultIncomplete = Boolean(selectedResult && isIncompleteApplicationResult(selectedResult))
  const draftOperationPending = draftSaving || coverLetterRewriting || emailSending || deliveryUpdating
  const selectedDraftQualityVerified = Boolean(selectedResult && !selectedResultIncomplete && hasVerifiedDraftQuality(selectedResult))
  const selectedDraftQualityStale = Boolean(selectedResult && !selectedResultIncomplete && selectedResult.draftVersion?.qualityStatus === 'stale')
  const selectedDraftQualityUnchecked = Boolean(selectedResult && !selectedResultIncomplete && hasUncheckedDraftQuality(selectedResult))
  const selectedDraftQualityModelFallback = Boolean(selectedResult && !selectedResultIncomplete && selectedResult.outreach?.runtime_status === 'fallback_model_error')
  const selectedSubjectNeedsReview = selectedResult?.emailSubjectGuard?.requiresReview === true
  const selectedDraftQualityRetryable = Boolean(selectedResult?.draftVersion && !draftDirty && !selectedDraftQualityVerified)
  const selectedCoverLetterCharacterCount = selectedResult
    ? nonWhitespaceCharacterCount(outreachDraft(selectedResult).cover_letter)
    : 0
  const draftSaveLabel = draftSaving
    ? '保存中'
    : draftGuard.saveStatus === 'error'
      ? '保存失败'
      : draftDirty
        ? '保存修改'
        : selectedDraftQualityRetryable
          ? selectedDraftQualityUnchecked || selectedDraftQualityModelFallback
            ? '运行质量检查'
            : '重新质量检查'
          : '已保存'
  const openImagePreview = useCallback((title: string, images: PreviewImage[], index = 0) => {
    if (!images.length) return
    setImagePreview({ title, images, index: Math.min(Math.max(index, 0), images.length - 1) })
  }, [])
  const changePreviewImage = useCallback((index: number) => {
    setImagePreview((current) => current ? { ...current, index } : current)
  }, [])
  const closeImagePreview = useCallback(() => setImagePreview(null), [])
  const replaceResult = (next: ApplicationResult) => {
    setSelectedResult(next)
    setResults((current) => current ? { ...current, items: current.items.map((item) => item.note_id === next.note_id ? next : item) } : current)
  }

  const invalidateAttachmentQuality = (result = selectedResult) => {
    if (!result?.draftVersion || result.draftVersion.qualityStatus === 'stale') return
    replaceResult({
      ...result,
      draftVersion: {
        ...result.draftVersion,
        qualityStatus: 'stale',
      },
    })
  }

  const changeApplicationTone = (tone: ApplicationTone) => {
    if (!selectedApplicationContextKey || tone === selectedApplicationTone) return
    setApplicationToneOverrides((current) => ({ ...current, [selectedApplicationContextKey]: tone }))
    setEmailPreview(null)
    invalidateAttachmentQuality()
  }

  const captureDraftView = () => ({
    revision: draftViewRevisionRef.current,
    jobId: activeJob?.id || '',
    noteId: selectedResult?.note_id || '',
  })

  const draftViewIsCurrent = (view: ReturnType<typeof captureDraftView>) => (
    draftViewRevisionRef.current === view.revision
  )

  const replaceResultInDraftView = (view: ReturnType<typeof captureDraftView>, next: ApplicationResult) => {
    if (!draftViewIsCurrent(view) || next.note_id !== view.noteId) return false
    setSelectedResult((current) => current?.note_id === view.noteId ? next : current)
    setResults((current) => current
      ? { ...current, items: current.items.map((item) => item.note_id === view.noteId ? next : item) }
      : current)
    return true
  }

  const performChooseResult = (next: ApplicationResult) => {
    if (draftOperationPending && selectedResult?.note_id !== next.note_id) {
      setNotice('当前投递文案操作尚未完成，请稍候。')
      return
    }
    if (selectedResult?.note_id !== next.note_id) draftViewRevisionRef.current += 1
    setSelectedResult(next)
  }

  const chooseResult = (next: ApplicationResult) => {
    if (selectedResult?.note_id === next.note_id) return
    void draftGuard.requestTransition('切换岗位', () => performChooseResult(next))
  }

  const updateDraft = (field: keyof OutreachDraft, value: string) => {
    if (!selectedResult) return
    setEmailPreview(null)
    replaceResult({
      ...selectedResult,
      ...(field === 'email_subject' ? { emailSubjectPreview: value } : {}),
      outreach: { ...selectedResult.outreach, [field]: value },
      draftVersion: selectedResult.draftVersion
        ? { ...selectedResult.draftVersion, qualityStatus: 'stale' }
        : selectedResult.draftVersion,
    })
  }

  const copyText = (value: string) => {
    if (!value) return
    void navigator.clipboard.writeText(value).then(() => setNotice('内容已复制到剪贴板'))
  }

  const rewriteCoverLetter = async () => {
    if (!activeJob || !selectedResult || coverLetterRewriting) return
    const submittedVersion = selectedResult.draftVersion
    if (!submittedVersion) {
      setCoverLetterRewriteError('当前文案还没有服务端版本，请先保存文案再重写。')
      return
    }
    const submittedResult = selectedResult
    const submittedDraft = outreachDraft(submittedResult)
    const submittedApplicationContext = { ...selectedApplicationContext }
    const jobId = activeJob.id
    const draftView = captureDraftView()
    setCoverLetterRewriting(true)
    setCoverLetterRewriteError('')
    setEmailPreview(null)
    try {
      let session: AiSession
      if (coverLetterUseLocalModel) {
        const localSession = await activateLocalAi(selectedCoverLetterLocalModel)
        if (!localSession) throw new Error('本地模型会话未就绪；当前 Cover Letter 已保留。')
        session = localSession
      } else {
        session = aiSession && aiSessionMatchesSelection(aiSession)
          ? aiSession
          : await restoreAiSession()
      }
      const requestRewrite = () => api.rewriteCoverLetter(jobId, {
        noteId: submittedResult.note_id,
        aiSessionId: session.id,
        instructions: coverLetterRewriteInstructions.trim(),
        outreach: submittedDraft,
        applicationContext: submittedApplicationContext,
        draftId: submittedVersion.draftId,
        baseVersion: submittedVersion.version,
      })
      let response
      try {
        response = await requestRewrite()
      } catch (error) {
        const requestError = error as ApiError
        if (requestError.code !== 'AI_SESSION_EXPIRED') throw error
        session = await restoreAiSession()
        response = await requestRewrite()
      }
      const rewritten = response.outreach?.cover_letter?.trim()
      if (!rewritten) throw new Error('高级模型没有返回 Cover Letter，请保留当前版本并重试。')
      const rewrittenCharacterCount = nonWhitespaceCharacterCount(rewritten)
      if (rewrittenCharacterCount < COVER_LETTER_MIN_NON_WHITESPACE_CHARS) {
        throw new Error(`高级模型返回的 Cover Letter 只有 ${rewrittenCharacterCount} 个非空白字符，未达到 ${COVER_LETTER_MIN_NON_WHITESPACE_CHARS} 字最低要求；已保留当前版本。`)
      }
      const responseHash = draftContentHash(response.outreach)
      if (response.draftVersion.contentHash !== responseHash) {
        throw new Error('服务端返回的重写版本哈希不一致，请保留当前版本并重试。')
      }
      const next: ApplicationResult = {
        ...submittedResult,
        outreach: {
          ...submittedResult.outreach,
          ...response.outreach,
          generation_mode: 'model_rewrite',
          runtime_status: 'generated_pending_quality',
          status: 'needs_review',
          applicationContext: submittedApplicationContext,
        },
        draftVersion: response.draftVersion,
        delivery: response.delivery,
        cover_letter_evaluation: response.cover_letter_evaluation || submittedResult.cover_letter_evaluation,
      }
      if (!replaceResultInDraftView(draftView, next)) return
      setCoverLetterRewriteOpen(false)
      setCoverLetterRewriteInstructions('')
      const localReview = response.generation.strategy === 'local_plan_write_review'
        ? `，本地模型完成 ${response.generation.modelCalls || 3} 次规划/写作/终审${response.generation.reviewScore == null ? '' : `，终审 ${response.generation.reviewScore} 分`}`
        : ''
      const signatureEvidence = response.generation.signatureEvidenceIds?.length
        ? `，采用 ${response.generation.signatureEvidenceIds.length} 项 Signature Evidence`
        : ''
      setNotice(`已由 ${response.generation.provider} / ${response.generation.model} 完成专属重写${localReview}${signatureEvidence}，共 ${rewrittenCharacterCount} 个非空白字符，禁句 ${response.generation.styleViolationCount || 0} 项；请运行质量检查后投递。`)
    } catch (error) {
      if (!draftViewIsCurrent(draftView)) return
      const message = (error as Error).message || 'Cover Letter 重写失败，请稍后重试。'
      setCoverLetterRewriteError(message)
      setNotice(message)
    } finally {
      setCoverLetterRewriting(false)
    }
  }

  const saveDraft = async (saveRequest: DraftSaveRequest): Promise<boolean> => {
    if (!activeJob || !selectedResult) return false
    const jobId = activeJob.id
    const submittedResult = selectedResult
    const submittedDraft = outreachDraft(submittedResult)
    const submittedHash = draftContentHash(submittedDraft)
    const submittedAttachmentIds = [...selectedAttachmentIds]
    const submittedApplicationContext = { ...selectedApplicationContext }
    if (saveRequest.contentHash !== submittedHash) return false
    const draftView = captureDraftView()
    let savedResult: ApplicationResult | null = null
    const responseIsCurrent = () => saveRequest.requestId === draftSaveResponseRef.current && draftViewIsCurrent(draftView)
    draftSaveResponseRef.current = saveRequest.requestId
    try {
      const response = await api.saveDraft(jobId, submittedResult.note_id, submittedDraft, submittedResult.draftVersion, submittedApplicationContext)
      if (!response.draftVersion) throw new Error('服务端未返回草稿版本，请刷新后重试。')
      if (response.draftVersion.contentHash !== submittedHash) throw new Error('服务端返回的草稿内容哈希不一致，请刷新后重试。')
      savedResult = {
        ...submittedResult,
        outreach: { ...submittedResult.outreach, ...response.outreach },
        draftVersion: response.draftVersion,
        delivery: response.delivery,
      }
      if (!responseIsCurrent()) return false
      replaceResultInDraftView(draftView, savedResult)
      const session = aiSession || await restoreAiSession()
      const checked = await api.checkDraft(jobId, submittedResult.note_id, response.draftVersion, session.id, submittedAttachmentIds, submittedApplicationContext)
      if (!checked.draftVersion) throw new Error('服务端未返回质量检查版本，请刷新后重试。')
      if (checked.draftVersion.contentHash !== submittedHash) throw new Error('质量检查返回了过期的草稿版本，请重新检查。')
      const checkedResult: ApplicationResult = {
        ...savedResult,
        draftVersion: checked.draftVersion,
        delivery: checked.delivery,
        cover_letter_evaluation: checked.cover_letter_evaluation || savedResult.cover_letter_evaluation,
      }
      if (responseIsCurrent() && replaceResultInDraftView(draftView, checkedResult)) {
        setNotice(hasVerifiedDraftQuality(checkedResult) ? '投递文案已保存并通过质量复检' : '投递文案已保存，质量复检未通过')
      }
      return true
    } catch (error) {
      const requestError = error as Error & { code?: string; currentVersion?: number | null }
      if (savedResult) {
        if (responseIsCurrent()) {
          setNotice(`投递文案已保存，但质量复检未完成：${requestError.message}`)
        }
        return true
      } else if (requestError.code === 'DRAFT_VERSION_CONFLICT') {
        try {
          if (!responseIsCurrent()) return false
          const latest = await api.results(jobId, resultOffset, results?.limit || 20, {
            analysisMode: 'job',
            sort: resultSort,
            timeRange: resultTimeRange,
          })
          if (!responseIsCurrent()) return false
          const remote = latest.items.find((item) => item.note_id === submittedResult.note_id)
          if (remote?.draftVersion) {
            const rebased: ApplicationResult = {
              ...remote,
              outreach: { ...remote.outreach, ...submittedDraft },
              draftVersion: { ...remote.draftVersion, qualityStatus: 'stale' },
            }
            setResults({ ...latest, items: latest.items.map((item) => item.note_id === rebased.note_id ? rebased : item) })
            setSelectedResult(rebased)
            setNotice('草稿已在其他窗口更新；已载入最新版本并保留本地修改，请再次保存。')
          } else {
            setNotice(`草稿版本冲突，服务端当前版本为 ${requestError.currentVersion ?? '未知'}；请刷新结果后重试。`)
          }
        } catch {
          if (draftViewIsCurrent(draftView)) {
            setNotice(`草稿版本冲突，服务端当前版本为 ${requestError.currentVersion ?? '未知'}；请刷新结果后重试。`)
          }
        }
      } else {
        if (responseIsCurrent()) setNotice(requestError.message)
      }
      return false
    }
  }

  draftSaveHandlerRef.current = saveDraft

  const refreshApplicationAttachments = async (jobId = activeJob?.id, noteId = selectedResult?.note_id) => {
    if (!jobId || !noteId) return null
    const response = await api.applicationAttachments(jobId, noteId)
    if (activeJob?.id === jobId && selectedResult?.note_id === noteId) setApplicationAttachments(response)
    return response
  }

  const chooseAttachmentFiles = (source: ApplicationAttachment['source'], replacementAttachmentId: string | null = null) => {
    attachmentSourceRef.current = source
    replacementAttachmentRef.current = replacementAttachmentId
    attachmentInputRef.current?.click()
  }

  const uploadAttachmentFiles = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const files = Array.from(input.files || [])
    input.value = ''
    if (!activeJob || !selectedResult || files.length === 0) return
    const jobId = activeJob.id
    const noteId = selectedResult.note_id
    const source = attachmentSourceRef.current
    const replacementId = replacementAttachmentRef.current
    setAttachmentUploading(true)
    setEmailPreview(null)
    try {
      let uploaded = 0
      let bundleChanged = false
      for (const file of replacementId ? files.slice(0, 1) : files) {
        const response = await api.uploadApplicationAttachment(jobId, noteId, file, selectedResult.draftVersion, source)
        uploaded += response.duplicate ? 0 : 1
        bundleChanged ||= !response.duplicate
        if (replacementId && response.attachment.attachmentId !== replacementId) {
          await api.deleteApplicationAttachment(jobId, replacementId)
          bundleChanged = true
        }
      }
      await refreshApplicationAttachments(jobId, noteId)
      if (bundleChanged) invalidateAttachmentQuality()
      setNotice(uploaded ? `已加入 ${uploaded} 个附件` : '相同附件已存在，已保留原文件')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      await refreshApplicationAttachments(jobId, noteId).catch(() => null)
      replacementAttachmentRef.current = null
      attachmentSourceRef.current = 'uploaded'
      setAttachmentUploading(false)
    }
  }

  const importCandidateProfileAttachment = async () => {
    if (!activeJob || !selectedResult || !activeProfile || !selectedProfileAttachmentSource) return
    const jobId = activeJob.id
    const noteId = selectedResult.note_id
    setAttachmentUploading(true)
    setEmailPreview(null)
    try {
      const response = await api.importProfileApplicationAttachment(jobId, {
        noteId,
        profileId: activeProfile.id,
        sourceFile: selectedProfileAttachmentSource,
        draftVersion: selectedResult.draftVersion,
      })
      await refreshApplicationAttachments(jobId, noteId)
      if (!response.duplicate) invalidateAttachmentQuality()
      setNotice(response.duplicate ? '候选人资料中的相同简历已存在' : `已从候选人资料加入：${response.attachment.displayName}`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setAttachmentUploading(false)
    }
  }

  const updateAttachmentSelection = async (attachment: ApplicationAttachment, selected: boolean) => {
    if (!activeJob || !selectedResult) return
    setEmailPreview(null)
    try {
      await api.updateApplicationAttachment(activeJob.id, attachment.attachmentId, { selected })
      await refreshApplicationAttachments(activeJob.id, selectedResult.note_id)
      invalidateAttachmentQuality()
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  const removeApplicationAttachment = async (attachment: ApplicationAttachment) => {
    if (!activeJob || !selectedResult) return
    setEmailPreview(null)
    try {
      await api.deleteApplicationAttachment(activeJob.id, attachment.attachmentId)
      await refreshApplicationAttachments(activeJob.id, selectedResult.note_id)
      invalidateAttachmentQuality()
      setNotice(`已移除附件：${attachment.displayName}`)
    } catch (error) {
      setNotice((error as Error).message)
    }
  }

  const importJobArtifact = async () => {
    if (!activeJob || !selectedResult || !artifactAttachmentId) return
    const artifact = importableArtifacts.find((item) => item.id === artifactAttachmentId)
    if (!artifact) return
    const jobId = activeJob.id
    const noteId = selectedResult.note_id
    setAttachmentUploading(true)
    setEmailPreview(null)
    try {
      const uploadResponse = await api.importJobArtifactApplicationAttachment(jobId, {
        noteId,
        artifactId: artifact.id,
        displayName: artifact.name,
        draftVersion: selectedResult.draftVersion,
      })
      await refreshApplicationAttachments(jobId, noteId)
      if (!uploadResponse.duplicate) invalidateAttachmentQuality()
      setNotice(`任务产物已加入附件：${artifact.name}`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setAttachmentUploading(false)
    }
  }

  const exportCoverLetterAttachment = async () => {
    if (!activeJob || !selectedResult) return
    const submittedResult = selectedResult
    const savedVersion = submittedResult.draftVersion
    const submittedDraft = outreachDraft(submittedResult)
    if (draftDirtyRef.current || !savedVersion || savedVersion.qualityStatus === 'stale' || draftContentHash(submittedDraft) !== savedVersion.contentHash) {
      setNotice('请先保存 Cover Letter，再基于已保存版本导出附件')
      return
    }
    const content = submittedDraft.cover_letter.trim()
    if (!content) return
    const jobId = activeJob.id
    const noteId = submittedResult.note_id
    setAttachmentUploading(true)
    setEmailPreview(null)
    try {
      const response = await api.exportCoverLetterApplicationAttachment(jobId, noteId, savedVersion)
      await refreshApplicationAttachments(jobId, noteId)
      if (!response.duplicate && activeJob?.id === jobId && selectedResult?.note_id === noteId) invalidateAttachmentQuality()
      setNotice('Cover Letter 已导出并加入附件')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setAttachmentUploading(false)
    }
  }

  const prepareMessage = async () => {
    if (!activeJob || !selectedResult || !selectedMessageRoute || !selectedDraftQualityVerified || draftDirty) return
    const jobId = activeJob.id
    const submittedResult = selectedResult
    const draftView = captureDraftView()
    setDeliveryUpdating(true)
    try {
      const response = await api.setDelivery(jobId, submittedResult.note_id, 'ready_to_message', submittedResult.draftVersion)
      if (!draftViewIsCurrent(draftView)) return
      copyText(outreachDraft(submittedResult).greeting)
      replaceResultInDraftView(draftView, {
        ...submittedResult,
        draftVersion: response.draftVersion ?? submittedResult.draftVersion,
        delivery: response.delivery,
      })
      setNotice('私信文案已复制，可打开原帖发送')
    } catch (error) {
      if (draftViewIsCurrent(draftView)) setNotice((error as Error).message)
    } finally {
      setDeliveryUpdating(false)
    }
  }

  const sendEmail = async () => {
    if (!activeJob || !selectedResult || !selectedEmailRoute || !selectedDraftQualityVerified || draftDirty) return
    const jobId = activeJob.id
    const submittedResult = selectedResult
    const submittedRoute = selectedEmailRoute
    const draftView = captureDraftView()
    setEmailSending(true)
    try {
      const preview = await api.previewEmail(jobId, submittedResult.note_id, submittedRoute.target, selectedAttachmentIds, submittedResult.draftVersion, {
        evidenceHash: submittedRoute.evidenceHash,
        sourceRevision: submittedRoute.sourceRevision,
      })
      if (!draftViewIsCurrent(draftView)) return
      setEmailPreview(preview)
    } catch (error) {
      if (draftViewIsCurrent(draftView)) setNotice((error as Error).message)
    } finally {
      setEmailSending(false)
    }
  }

  const confirmSendEmail = async () => {
    if (!activeJob || !selectedResult || !selectedEmailRoute || !emailPreview || emailPreview.readiness !== 'ready') return
    const jobId = activeJob.id
    const submittedResult = selectedResult
    const submittedRoute = selectedEmailRoute
    const submittedPreview = emailPreview
    const draftView = captureDraftView()
    setEmailSending(true)
    try {
      const response = await api.sendEmail(jobId, submittedResult.note_id, submittedRoute.target, outreachDraft(submittedResult), submittedPreview.attachmentSummary.attachments.map((item) => item.attachmentId), submittedPreview, submittedResult.draftVersion, {
        evidenceHash: submittedRoute.evidenceHash,
        sourceRevision: submittedRoute.sourceRevision,
      })
      if (replaceResultInDraftView(draftView, {
        ...submittedResult,
        outreach: { ...submittedResult.outreach, ...response.outreach },
        draftVersion: response.draftVersion ?? submittedResult.draftVersion,
        delivery: response.delivery,
      })) {
        setEmailPreview(null)
        setNotice(`邮件已发送至 ${submittedRoute.target}`)
      }
    } catch (error) {
      if (draftViewIsCurrent(draftView)) setNotice((error as Error).message)
    } finally {
      setEmailSending(false)
    }
  }

  const dataCopilotMode = workspaceMode === 'job' ? 'application' : 'research'
  const dataCopilotSnapshotId = `job-r${Math.max(0, Number(activeJob?.revision || 0))}`
  const dataCopilotTransport = useMemo(() => createDataCopilotTransport({
    jobId: activeJob?.id || 'unbound',
    mode: dataCopilotMode,
    snapshotId: dataCopilotSnapshotId,
    aiSessionId: aiSession?.id,
    allowedScopes: ['*'],
  }), [activeJob?.id, aiSession?.id, dataCopilotMode, dataCopilotSnapshotId])
  const dataCopilotModels = useMemo<DataCopilotModel[]>(() => aiSession ? [{
    id: aiSession.id,
    label: aiSession.model,
    provider: aiSession.provider,
    supportsTools: true,
    supportsAttachments: true,
  }] : [], [aiSession])
  const discoverDataCopilotModels = async (
    input: Pick<DataCopilotModelConnectionInput, 'provider' | 'apiKey' | 'baseUrl'>,
  ) => api.discoverAiModels(input)
  const connectDataCopilotModel = async (input: DataCopilotModelConnectionInput): Promise<DataCopilotModel> => {
    const session = await api.createAiSession(input)
    rememberAiSession(session)
    setNotice(`${session.model} 已连接，可在数据 Copilot 中直接使用。`)
    return {
      id: session.id,
      label: session.model,
      provider: session.provider,
      supportsTools: true,
      supportsAttachments: true,
    }
  }
  const dataCopilotSources = useMemo<DataCopilotContextSource[]>(() => {
    if (!activeJob) return []
    const taskKind = workspaceMode === 'job' ? '岗位任务' : '非岗位任务'
    return [
      {
        id: `job:${activeJob.id}`,
        kind: 'job',
        title: activeJob.keyword || '当前任务',
        subtitle: `${taskKind} · #${activeJob.id.slice(0, 8)}`,
        status: activeJob.status,
      },
      {
        id: 'dataset:content',
        kind: 'dataset',
        title: workspaceMode === 'job' ? '岗位与正文数据' : '内容与正文数据',
        subtitle: '当前任务快照',
        count: discoveredCount,
      },
      {
        id: 'dataset:audience',
        kind: 'dataset',
        title: '评论与用户数据',
        subtitle: '受众采集结果',
        count: (audienceResults?.totals.comments || 0) + (audienceResults?.totals.users || 0),
      },
      {
        id: 'dataset:artifacts',
        kind: 'artifact',
        title: '任务产物',
        subtitle: '可引用、预览与作为邮件附件',
        count: currentArtifacts.length,
      },
    ]
  }, [activeJob, audienceResults?.totals.comments, audienceResults?.totals.users, currentArtifacts.length, discoveredCount, workspaceMode])

  const contactOcr = results?.contactResolution
  const contactOcrAfter = contactOcr?.report?.after
  const contactOcrQueue = contactOcr?.report?.queue
  const contactOcrPending = contactOcrAfter?.imageOcrPending ?? contactOcr?.baseline?.imageOcrPending
  const contactOcrComplete = contactOcrAfter?.imageOcrComplete ?? contactOcr?.baseline?.imageOcrComplete
  const contactOcrSkippedBodyEmail = contactOcrAfter?.imageOcrSkippedBodyEmail ?? contactOcr?.baseline?.imageOcrSkippedBodyEmail
  const contactOcrProcessed = contactOcr?.processed ?? contactOcrQueue?.processed ?? 0
  const contactOcrTotal = contactOcr?.totalQueued ?? contactOcrQueue?.total ?? 0

  const coverageCards = activeAnalysisMode === 'general' ? [
    { label: '发现内容', value: coverage?.discovered, icon: Search },
    { label: '正文尝试', value: coverage?.bodyAttempted, icon: FileText },
    { label: '正文成功', value: coverage?.bodySucceeded, icon: Check },
    { label: '时间归一化', value: coverage?.timesNormalized, icon: CalendarClock },
    { label: '含图片', value: results?.filters.stats.withImages, icon: Images },
    { label: 'AI 分析', value: results ? resultFilterStats(results).all - resultFilterStats(results).incomplete : coverage?.draftsGenerated, icon: BrainCircuit },
    { label: '质量通过', value: coverage?.qualityPassed, icon: ShieldCheck },
  ] : [
    { label: '发现结果', value: coverage?.discovered, icon: Search },
    { label: '正文尝试', value: coverage?.bodyAttempted, icon: FileText },
    { label: '正文成功', value: coverage?.bodySucceeded, icon: Check },
    { label: '时间归一化', value: coverage?.timesNormalized, icon: CalendarClock },
    { label: '岗位卡', value: coverage?.applicationInfo, icon: UserRoundSearch },
    { label: '投递语', value: coverage?.draftsGenerated, icon: Mail },
    { label: '质量通过', value: coverage?.qualityPassed, icon: ShieldCheck },
  ]

  if (authLoading) {
    return <main className="auth-shell"><section className="auth-card"><LoaderCircle className="spin" size={24} /><span>正在检查登录状态…</span></section></main>
  }
  if (authSession?.required && !authSession.authenticated) {
    return <main className="auth-shell"><section className="auth-card">
      <div className="auth-brand"><ShieldCheck size={22} /><span><strong>Relay 招聘情报工作台</strong><small>竞赛演示入口</small></span></div>
      <h1>登录后查看历史数据</h1>
      <p className="auth-description">登录后可查看已保存的 AI 产品经理招聘任务、Relay 抓取结果、分析和导出文件。</p>
      <form onSubmit={submitAuth} className="auth-form">
        <label className="field"><span>账号邮箱</span><input type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required /></label>
        <label className="field"><span>密码</span><input type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required /></label>
        {authError && <div className="auth-error"><CircleAlert size={15} /><span>{authError}</span></div>}
        <button type="submit" className="primary-button auth-submit" disabled={authSubmitting}>{authSubmitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{authSubmitting ? '登录中…' : '登录工作台'}</button>
      </form>
    </section></main>
  }

  return (
    <div className={`app-shell ${batchSurfaceActive ? 'batch-interface batch-surface-active' : expansionModuleActive ? 'expansion-interface' : workspaceMode === 'general' ? 'content-interface' : 'job-interface'}`}>
      <aside className="side-rail">
        <div className="brand-mark" aria-label="今天你投了吗？">投</div>
        <nav aria-label="主导航">
          <button className={`nav-button ${workspaceMode === 'job' && applicationView === 'jobs' ? 'active' : ''}`} type="button" title="岗位投递工作台" aria-current={workspaceMode === 'job' && applicationView === 'jobs' ? 'page' : undefined} onClick={() => workspaceMode === 'job' ? switchApplicationView('jobs') : switchWorkspace('job', true, 'jobs')}><Target size={20} /><span>岗位台</span></button>
          <button className={`nav-button ${workspaceMode === 'job' && applicationView === 'batch' ? 'active' : ''}`} type="button" title="批量投递工作台" aria-current={workspaceMode === 'job' && applicationView === 'batch' ? 'page' : undefined} onClick={() => workspaceMode === 'job' ? switchApplicationView('batch') : switchWorkspace('job', true, 'batch')}><Layers3 size={20} /><span>批量投递</span></button>
          <button className={`nav-button ${workspaceMode === 'general' ? 'active' : ''}`} type="button" title="非岗位信息研究工作台" aria-current={workspaceMode === 'general' ? 'page' : undefined} onClick={() => switchWorkspace('general')}><BookOpenCheck size={20} /><span>研究台</span></button>
          {!batchSurfaceActive && <button className="nav-button" title="任务历史" onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}><Clock3 size={20} /><span>历史</span></button>}
          {!batchSurfaceActive && <button className="nav-button" title="导出文件" onClick={() => document.getElementById('artifacts')?.scrollIntoView({ behavior: 'smooth' })}><Table2 size={20} /><span>产物</span></button>}
        </nav>
        {workspaceMode === 'job' && !batchSurfaceActive && <button className="nav-button rail-settings" title="发件邮箱设置" onClick={() => document.getElementById('email-config')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={20} /><span>设置</span></button>}
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-leading">
            <div className="product-title">
              <span className="eyebrow">{workspaceMode === 'general' ? 'CONTENT INTELLIGENCE' : applicationView === 'batch' ? 'BATCH APPLICATION WORKBENCH' : 'APPLICATION INTELLIGENCE'}</span>
              <h1>{workspaceMode === 'general' ? '今天你投了吗？｜内容研究工作台' : applicationView === 'batch' ? '今天你投了吗？｜批量投递工作台' : '今天你投了吗？｜岗位与投递'}</h1>
              <span className="version">v3.0</span>
            </div>
            <nav className="workspace-switcher" aria-label="切换工作台">
              <button type="button" className={workspaceMode === 'job' && applicationView === 'jobs' ? 'active' : ''} aria-current={workspaceMode === 'job' && applicationView === 'jobs' ? 'page' : undefined} onClick={() => workspaceMode === 'job' ? switchApplicationView('jobs') : switchWorkspace('job', true, 'jobs')}><Target size={15} /><span>岗位投递</span></button>
              <button type="button" className={workspaceMode === 'job' && applicationView === 'batch' ? 'active' : ''} aria-current={workspaceMode === 'job' && applicationView === 'batch' ? 'page' : undefined} onClick={() => workspaceMode === 'job' ? switchApplicationView('batch') : switchWorkspace('job', true, 'batch')}><Layers3 size={15} /><span>批量投递</span></button>
              <button type="button" className={workspaceMode === 'general' ? 'active' : ''} aria-current={workspaceMode === 'general' ? 'page' : undefined} onClick={() => switchWorkspace('general')}><BookOpenCheck size={15} /><span>非岗位研究</span></button>
            </nav>
          </div>
          <div className="topbar-status">
            <button
              type="button"
              className="copilot-launch-button"
              disabled={!activeJob}
              title={!activeJob ? '请先选择任务' : !aiSession ? '打开历史会话（发送前需连接 AI 模型）' : '打开数据 Copilot'}
              onClick={() => setDataCopilotOpen(true)}
            >
              <MessagesSquare size={16} />
              <span>数据助手</span>
            </button>
            <div className={`relay-indicator ${relayReady ? 'ready' : relayConnecting ? 'connecting' : 'offline'}`}>
              {relayReady ? <Wifi size={17} /> : relayConnecting ? <LoaderCircle className="spin" size={17} /> : <WifiOff size={17} />}
              <span><strong>{relaySiteReady ? 'Relay 已连接' : relayReady ? 'Relay 已启动，待登录' : relayConnecting ? 'Relay 连接中' : 'Relay 待配置'}</strong><small>CDP {request.relayPort} · {tabCount} 个标签页</small></span>
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
          <section className={`product-hero ${activeAnalysisMode === 'general' ? 'content-ai-hero' : ''}`} aria-labelledby="product-hero-title">
            <div className="product-hero-copy">
              <span className="marketing-kicker">{activeAnalysisMode === 'general' ? 'FROM DISCOVERY TO STRUCTURE' : 'FROM DISCOVERY TO DELIVERY'}</span>
              <h2 id="product-hero-title">{activeAnalysisMode === 'general' ? '研究经验、人群、趋势、产品或地点，不再被岗位模板限制。' : '别再在碎片信息里找机会，把每次发现都变成更有把握的投递。🚀'}</h2>
              <p className="product-hero-lede">{activeAnalysisMode === 'general' ? '选择研究场景和目标后，全量保存正文与原图；AI 会结合关键词、OCR 与逐条证据，动态生成本次专属栏目和结构化结论。' : '今天你投了吗？把“发现岗位 🔎、读懂正文 🧠、匹配经历、写好求职信 ✍️、完成投递 📮”放在同一条求职流程里。'}</p>
              <div className="product-hero-actions">
                <button type="button" className="primary-button" onClick={() => document.getElementById('task-config')?.scrollIntoView({ behavior: 'smooth' })}><Play size={16} />{activeAnalysisMode === 'general' ? '创建非岗位研究' : '马上开始采集 🚀'}</button>
              </div>
              <div className="product-proof-list" aria-label="产品能力">
                {activeAnalysisMode === 'general' ? <>
                  <span><BrainCircuit size={14} />AI 动态生成内容栏目</span>
                  <span><Images size={14} />正文、图片与 OCR 联合理解</span>
                  <span><ShieldCheck size={14} />结论保留原文证据</span>
                </> : <>
                  <span><Check size={14} />🧩 多 Agent 分工推进</span>
                  <span><Check size={14} />🛡️ 保留正文与失败原因</span>
                  <span><Check size={14} />📦 JSON / CSV / XLSX / MD 导出</span>
                </>}
              </div>
            </div>
            {activeAnalysisMode === 'general' && (
              <aside className={`content-ai-runtime ${aiSession ? 'ready' : ''}`} aria-label="内容 AI 运行状态">
                <div className="content-ai-runtime-heading">
                  <span className="content-ai-runtime-icon"><BrainCircuit size={20} /></span>
                  <span><small>CONTENT AI RUNTIME</small><strong>{aiSession ? `${selectedProvider?.label || providerId} 已接入` : 'AI 等待连接'}</strong></span>
                  <b>{aiSession ? '已就绪' : '未连接'}</b>
                </div>
                <dl>
                  <div><dt>当前模型</dt><dd>{aiSession?.model || '尚未选择'}</dd></div>
                  <div><dt>分析输入</dt><dd>搜索关键词 · 正文 · 图片文字</dd></div>
                  <div><dt>生成结果</dt><dd>摘要 · 实体 · 洞察 · 动态栏目</dd></div>
                </dl>
                <button type="button" onClick={() => document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {aiSession ? <Settings2 size={15} /> : <KeyRound size={15} />}{aiSession ? '查看 AI 配置' : '连接 AI 模型'}
                </button>
              </aside>
            )}
          </section>

          <section className="overview-band" id="product-overview" aria-label="运行概览">
            <div className="overview-copy">
              <p>多 Agent 工作流</p>
              <strong>{runningCount ? `${runningCount} 个任务正在推进` : '工作台已待命'}</strong>
            </div>
            <div className="metric"><span>成功任务</span><strong>{completedCount}</strong><small>当前历史</small></div>
            <div className="metric"><span>未完成任务</span><strong className={incompleteCount ? 'warning-text' : ''}>{incompleteCount}</strong><small>中断或主动取消</small></div>
            <div className="metric"><span>失败任务</span><strong className={failedCount ? 'danger-text' : ''}>{failedCount}</strong><small>执行错误并保留原因</small></div>
            <div className="metric"><span>导出文件</span><strong>{exportCount}</strong><small>JSON / CSV / XLSX / MD</small></div>
            <div className="health-stamp">
              <Activity size={18} />
              <span><strong>{health?.ok ? '本地服务正常' : loading ? '正在检查服务' : '服务未响应'}</strong><small>{health?.runnerAvailable === false ? 'Runner 路径待配置' : 'Runner 已纳入受控执行'}</small></span>
            </div>
          </section>

          <section className="panel relay-config-panel" id="relay-config" aria-label="Relay 配置">
            <div className="panel-heading compact">
              <div><span className="step-label">RELAY CONFIGURATION</span><h2>Relay 配置</h2></div>
              <div className="relay-heading-actions">
                <span className={`runtime-badge ${relaySiteReady ? 'passed' : ''}`}>{relaySiteReady ? '目标页已打开' : relayServiceReady ? '服务已启动' : '待连接'}</span>
                <button type="button" className="relay-guide-toggle" aria-expanded={relayGuideOpen} aria-controls="relay-manual-guide" onClick={() => setRelayGuideOpen((open) => !open)}>
                  <BookOpenCheck size={15} />{relayGuideOpen ? '收起向导' : '手动连接向导'}<ChevronDown className={relayGuideOpen ? 'expanded' : ''} size={14} />
                </button>
              </div>
            </div>
            <div className="relay-config-body">
              <div className={`relay-guide-summary ${relayPressureHigh ? 'pressure' : relaySiteReady ? 'ready' : relayServiceReady ? 'active' : ''}`}>
                <span className="relay-guide-icon">{relayRecoveryBusy ? <LoaderCircle className="spin" size={18} /> : relayPressureHigh ? <ShieldAlert size={18} /> : relaySiteReady ? <Check size={18} /> : relayConnecting || relaySettingUp || relayLoginOpening ? <LoaderCircle className="spin" size={18} /> : <Wifi size={18} />}</span>
                <span><small>MANUAL CONNECTION</small><strong>{relayGuideTitle}</strong><p>{relayGuideDescription}</p></span>
                <b>{relaySiteReady ? '4 / 4' : relayReady ? '3 / 4' : relayServiceReady ? '2 / 4' : relayConfigValid ? '1 / 4' : '0 / 4'}</b>
              </div>
              <div className="form-row relay-config-fields">
                <label className="field"><span>Relay 端口</span><input type="number" min="1024" max="65535" value={relayConfig.port} onChange={(event) => updateRelayConfig('port', Number(event.target.value))} /></label>
                <label className="field"><span>浏览器 Profile</span><input value={relayConfig.profile} onChange={(event) => updateRelayConfig('profile', event.target.value)} placeholder="chrome" /></label>
                <Toggle checked={relayConfig.autoConnect} onChange={(value) => updateRelayConfig('autoConnect', value)} label="开机自动连接" description="启动脚本读取此配置并通过代码连接" />
              </div>
              <div className={`relay-recovery-strip ${relayPressureHigh ? 'warning' : relayRecovery?.ok ? 'success' : ''}`} aria-live="polite">
                <span className="relay-recovery-copy">
                  {relayPressureHigh ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
                  <span>
                    <strong>{relayAutomaticRecovery ? 'Relay 正在自动恢复' : relayPressureHigh ? '检测到 Relay 目标过载' : relayRecovery?.ok ? 'Relay 已修复并通过真实连接验证' : 'Relay 连接保护已启用'}</strong>
                    <small>{relayAutomaticRecovery
                      ? '后端已检测到连续断线或目标页缺失，正在重建浏览器并执行 Playwright 验证。'
                      : relayPressureHigh
                      ? '页面或后台目标过多会让 Playwright 初始化超时；可直接收敛旧页面并保留登录态。'
                      : '后端持续巡检并在连续异常后自动恢复；不会清除 Cookie 或浏览器 Profile。'}</small>
                  </span>
                </span>
                <dl aria-label="Relay 目标诊断">
                  <div><dt>全部目标</dt><dd>{tabCount}</dd></div>
                  <div><dt>页面</dt><dd>{Number(relay?.pageCount || 0)}</dd></div>
                  <div><dt>后台</dt><dd>{Number(relay?.workerCount || 0) + Number(relay?.iframeCount || 0)}</dd></div>
                </dl>
                <button type="button" className={relayPressureHigh ? 'primary-button' : 'secondary-button'} disabled={relayRecoveryBusy || relayConnecting || relaySettingUp || relayLoginOpening || !relayConfigValid} onClick={() => void repairRelay()}>
                  {relayRecoveryBusy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
                  {relayRecoveryBusy ? '正在重建并验证' : '一键修复 Relay'}
                </button>
              </div>
              {relayGuideOpen && <div className="relay-manual-guide" id="relay-manual-guide">
                <ol className="relay-guide-steps" aria-label="Relay 手动连接进度">
                  {relayGuideSteps.map((step, index) => <li className={step.state} key={step.label}>
                    <i>{step.state === 'done' ? <Check size={14} /> : index + 1}</i>
                    <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                  </li>)}
                </ol>
                <div className="relay-guide-actionbar">
                  <span className="relay-guide-diagnostic">
                    <Wifi size={17} />
                    <span><strong>{relaySiteReady ? '连接链路正常' : relayServiceReady ? 'Relay 已响应，等待目标页' : `端口 ${relayConfig.port} 暂未连通`}</strong><small>{relay?.checkedAt ? `最近检测 ${formatTime(relay.checkedAt)}` : '正在等待首次检测'}{relay?.message && !relayServiceReady ? ` · ${relay.message}` : ''}</small></span>
                  </span>
                  <div className="relay-guide-actions">
                    <button type="button" className="secondary-button" disabled={relayConnecting || relaySettingUp || relayRecovering || relayLoginOpening || !relayConfigValid} onClick={() => void connectRelay(true, relayConfig)}>{relayConnecting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}检测连接</button>
                    {!relayServiceReady && <button type="button" className="primary-button" disabled={relayConfigSaving || relayConnecting || relaySettingUp || relayLoginOpening || !relayConfigValid} onClick={() => void saveRelayConfig()}>{relayConfigSaving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并启动 Relay</button>}
                    {relayServiceReady && <button type="button" className="primary-button" disabled={relayConnecting || relaySettingUp || relayLoginOpening} onClick={() => void openRelayLogin()}>{relayLoginOpening ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}{relaySiteReady ? '再开一个目标页' : '打开小红书登录页'}</button>}
                    <button type="button" className="secondary-button" disabled={relayConfigSaving || relayConnecting || relaySettingUp || relayLoginOpening || !relayConfigValid} onClick={() => void setupAndConnectRelay()}>{relaySettingUp ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{relaySettingUp ? '正在准备环境' : '自动准备本机环境'}</button>
                  </div>
                </div>
                <p className="relay-login-note"><CircleAlert size={14} />Relay 只能确认目标页面已经打开；账号是否登录，请以托管浏览器中的页面为准。登录完成后本页会自动检测连接，无需刷新。</p>
              </div>}
              {!relayGuideOpen && <div className="relay-config-footer">
                <span className="field-help">端口和 Profile 会同时用于状态探测、连接按钮和新任务。</span>
                <div className="relay-config-actions">
                  <button type="button" className="secondary-button" disabled={relayConnecting || relaySettingUp || relayLoginOpening} onClick={() => void openRelayLogin()}>{relayLoginOpening ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}打开登录页</button>
                  <button type="button" className="secondary-button setup-action" disabled={relayConfigSaving || relayConnecting || relaySettingUp || relayLoginOpening} onClick={() => void saveRelayConfig()}>{relayConfigSaving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并连接</button>
                  <button type="button" className="primary-button relay-install-button" disabled={relayConfigSaving || relayConnecting || relaySettingUp || relayLoginOpening} onClick={() => void setupAndConnectRelay()}>{relaySettingUp ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{relaySettingUp ? '正在安装并接入' : '一键安装并接入'}</button>
                </div>
              </div>}
            </div>
          </section>

          {workspaceMode === 'job' && <section className="panel email-config-panel" id="email-config" aria-label="发件邮箱配置">
            <div className="panel-heading compact">
              <div><span className="step-label">DELIVERY EMAIL</span><h2>发件邮箱</h2></div>
              <span className={`runtime-badge ${smtpConfig.verified ? 'passed' : ''}`}>{smtpConfig.verified ? '连接已验证' : smtpConfig.configured ? '配置已保存' : '等待配置'}</span>
            </div>
            <div className="email-config-body">
              <div className="smtp-simple-layout">
                <div className="form-row smtp-primary-fields">
                  <label className="field"><span>发件邮箱</span><input type="email" autoComplete="email" value={smtpConfig.from} onChange={(event) => updateSmtpEmail(event.target.value)} placeholder="name@163.com" /></label>
                  {(!smtpManualMode || smtpConfig.auth === 'login') && <label className="field"><span>{detectedSmtpPreset?.provider === '163' || detectedSmtpPreset?.provider === 'qq' ? '客户端授权密码' : '密码 / 应用专用密码'}</span><input type="password" autoComplete="current-password" value={smtpPassword} onChange={(event) => setSmtpPassword(event.target.value)} placeholder={smtpConfig.hasPassword ? '已在本机加密保存，留空保持不变' : '保存后将在本机加密保留'} /></label>}
                </div>
                <div className={`smtp-auto-status ${detectedSmtpPreset ? 'detected' : ''}`}>
                  <Mail size={17} />
                  <span>
                    <strong>{detectedSmtpProvider ? `已识别：${detectedSmtpProvider.label}` : '输入邮箱后自动识别 SMTP'}</strong>
                    <small>{detectedSmtpPreset ? `${detectedSmtpPreset.host} · ${detectedSmtpPreset.port} · ${detectedSmtpPreset.secure ? 'SSL/TLS' : 'STARTTLS'}` : '支持网易、QQ、Gmail、Outlook 等常用邮箱'}</small>
                  </span>
                </div>
              </div>
              <button type="button" className="smtp-advanced-toggle" aria-expanded={smtpManualMode} onClick={() => setSmtpManualMode((current) => !current)}>
                <Settings2 size={15} /><span>{smtpManualMode ? '收起高级设置' : '企业邮箱 / 高级设置'}</span><ChevronDown className={smtpManualMode ? 'expanded' : ''} size={15} />
              </button>
              {smtpManualMode && <div className="smtp-advanced-fields">
                <label className="field"><span>邮箱服务商</span><select value={smtpConfig.provider} onChange={(event) => selectSmtpProvider(event.target.value as SmtpProvider)}>{smtpProviderOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label className="field"><span>认证方式</span><select value={smtpConfig.auth} onChange={(event) => selectSmtpAuth(event.target.value as SmtpAuthMode)}><option value="login">用户名 + 密码</option><option value="oauth2">Outlook OAuth2</option><option value="none">无需认证</option></select></label>
                <label className="field"><span>SMTP 主机</span><input value={smtpConfig.host} onChange={(event) => updateSmtpConfig('host', event.target.value)} placeholder="smtp.example.com" /></label>
                <label className="field"><span>端口</span><input type="number" min="1" max="65535" value={smtpConfig.port} onChange={(event) => updateSmtpConfig('port', Number(event.target.value))} /></label>
                {smtpConfig.auth !== 'none' && <label className="field"><span>SMTP 用户名</span><input autoComplete="username" value={smtpConfig.user} onChange={(event) => updateSmtpConfig('user', event.target.value)} placeholder="通常与发件邮箱相同" /></label>}
                <div className="smtp-security-options">
                  <Toggle checked={smtpConfig.secure} onChange={(value) => updateSmtpConfig('secure', value)} label="SSL/TLS" description="通常使用 465 端口" />
                  <Toggle checked={smtpConfig.requireTls} onChange={(value) => updateSmtpConfig('requireTls', value)} label="STARTTLS" description="通常使用 587 端口" />
                </div>
                {smtpConfig.auth === 'oauth2' && <div className="smtp-oauth-fields">
                  <label className="field"><span>Tenant</span><input value={smtpConfig.oauth.tenant} onChange={(event) => updateSmtpOAuth('tenant', event.target.value)} placeholder="organizations" /></label>
                  <label className="field"><span>Client ID</span><input value={smtpConfig.oauth.clientId} onChange={(event) => updateSmtpOAuth('clientId', event.target.value)} placeholder="Microsoft Entra 应用 ID" /></label>
                  <label className="field"><span>Client Secret（可选）</span><input type="password" autoComplete="off" value={smtpOAuthClientSecret} onChange={(event) => setSmtpOAuthClientSecret(event.target.value)} placeholder={smtpConfig.oauth.hasClientSecret ? '已保存，留空保持不变' : '公共客户端可留空'} /></label>
                  <label className="field"><span>Refresh Token</span><input type="password" autoComplete="off" value={smtpOAuthRefreshToken} onChange={(event) => setSmtpOAuthRefreshToken(event.target.value)} placeholder={smtpConfig.oauth.hasRefreshToken ? '已保存，留空保持不变' : '粘贴 OAuth2 Refresh Token'} /></label>
                  <label className="field smtp-oauth-scope"><span>Scope</span><input value={smtpConfig.oauth.scope} onChange={(event) => updateSmtpOAuth('scope', event.target.value)} /></label>
                </div>}
              </div>}
              <section className="smtp-setup-guide" aria-labelledby="smtp-setup-guide-title">
                <div className="smtp-guide-header">
                  <div className="smtp-guide-title"><BookOpenCheck size={18} /><span><small>授权码获取教程</small><strong id="smtp-setup-guide-title">3 步完成 163 / QQ 邮箱配置</strong></span></div>
                  <div className="smtp-guide-tabs" role="group" aria-label="选择邮箱教程">
                    {(Object.keys(smtpSetupGuides) as SmtpGuideProvider[]).map((provider) => <button key={provider} type="button" className={smtpGuideProvider === provider ? 'active' : ''} aria-pressed={smtpGuideProvider === provider} onClick={() => setSmtpGuideProvider(provider)}>{smtpSetupGuides[provider].label}</button>)}
                  </div>
                </div>
                <div className="smtp-guide-content">
                  <ol className="smtp-guide-steps">
                    {smtpSetupGuide.steps.map((step, index) => <li key={step.title}><span className="smtp-guide-index">{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}
                  </ol>
                  <div className="smtp-guide-connection" aria-label={`${smtpSetupGuide.accountLabel} SMTP 参数`}>
                    <dl>
                      <div><dt>SMTP 主机</dt><dd>{smtpGuideHost}</dd></div>
                      <div><dt>端口</dt><dd>465</dd></div>
                      <div><dt>加密</dt><dd>SSL/TLS</dd></div>
                    </dl>
                    <a href={smtpSetupGuide.officialUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开{smtpSetupGuide.accountLabel}官方教程</a>
                  </div>
                </div>
                <p className="smtp-guide-reminder"><ShieldCheck size={15} /><span>{smtpSetupGuide.reminder}</span></p>
              </section>
              <div className="smtp-config-footer">
                <div className="smtp-guidance"><ShieldCheck size={16} /><span><strong>邮箱配置在本机加密持久保存</strong><small>{smtpManualMode ? `${smtpProviderOptions.find((item) => item.id === smtpConfig.provider)?.guidance || ''} 服务重启后仍可使用，凭据不进入任务记录或 GitHub。` : `${detectedSmtpProvider?.guidance || '输入完整邮箱后即可自动配置；企业邮箱请使用高级设置。'} 服务重启后仍可使用。`}</small></span></div>
                <div className="smtp-config-actions">
                  <button type="button" className="secondary-button smtp-clear-action" disabled={smtpSaving || (!smtpConfig.from && !smtpConfig.configured && !smtpConfig.hasPassword && !smtpConfig.oauth.hasRefreshToken)} onClick={() => void clearSmtpConfig()}><RotateCcw size={16} />清除配置</button>
                  <button type="button" className="secondary-button" disabled={smtpSaving || !smtpCanSave} onClick={() => void saveSmtpConfig(false)}><Save size={16} />{smtpManualMode ? '保存配置' : '自动配置'}</button>
                  <button type="button" className="primary-button smtp-test-action" disabled={smtpSaving || !smtpCanSave} onClick={() => void saveSmtpConfig(true)}>{smtpSaving ? <LoaderCircle className="spin" size={16} /> : <Wifi size={16} />}{smtpManualMode ? '保存并测试' : '配置并测试'}</button>
                </div>
              </div>
            </div>
          </section>}

          <section id="ai-memory" className="panel ai-setup-panel" aria-label={request.analysisMode === 'general' ? 'AI 与内容分析' : 'AI 与背景记忆'}>
            <div className="panel-heading compact">
              <div><span className="step-label">{request.analysisMode === 'general' ? 'AI & CONTENT' : 'AI & MEMORY'}</span><h2>{request.analysisMode === 'general' ? '模型连接与内容分析' : '模型连接与个人背景记忆'}</h2></div>
              <span className={`runtime-badge ${aiSession && (request.analysisMode === 'general' || activeProfile) ? 'passed' : ''}`}>{aiSession && (request.analysisMode === 'general' || activeProfile) ? '执行条件已就绪' : '等待配置'}</span>
            </div>
            <div className={`ai-setup-grid ${request.analysisMode === 'general' ? 'general-mode' : ''}`}>
              <section>
                <div className="setup-title"><KeyRound size={17} /><span><strong>AI Runtime</strong><small>{aiSession ? `${selectedProvider?.label || providerId} · 会话内存` : '选择提供方并连接'}</small></span></div>
                <div className={`local-model-offer ${selectedProvider?.local ? 'active' : ''}`}>
                  <div className="local-model-copy">
                    <Cpu size={18} />
                    <span><strong>本地免费模型库</strong><small>{localModelStatus?.runtime.ready ? `${localModelStatus.catalog.length} 款可选 · 运行器${localModelStatus.runtime.version ? ` v${localModelStatus.runtime.version}` : ''} · 文本不离开电脑` : '覆盖中文、双语与推理模型，安装后不产生 API 费用'}</small></span>
                    <span className={`local-runtime-state ${localModelStatus?.runtime.ready ? 'ready' : ''}`}>{localModelStatus?.runtime.ready ? '运行器在线' : '等待运行器'}</span>
                  </div>
                  <div className="local-model-actions">
                    <label><span className="sr-only">本地模型版本</span><select value={localModelChoice} disabled={localInstallActive} onChange={(event) => setLocalModelChoice(event.target.value)}>{localModelGroups.map((group) => <optgroup key={group.family} label={`${group.family} · ${group.models.length} 款`}>{group.models.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.tier}{item.recommended ? ' · 推荐' : ''}{item.installed ? ' · 已安装' : ''} · 约 {formatBytes(item.downloadBytes)}</option>)}</optgroup>)}</select></label>
                    {localModelStatus?.runtime.ready
                      ? <button type="button" className="secondary-button" disabled={startingLocalInstall || activatingLocalAi || localInstallActive || !selectedLocalModel} onClick={() => void installLocalModel()}>{startingLocalInstall || activatingLocalAi || localInstallActive ? <LoaderCircle className="spin" size={15} /> : selectedLocalModel?.installed ? <Play size={15} fill="currentColor" /> : <Download size={15} />}{selectedLocalModel?.installed ? '启用模型' : `一键安装${selectedLocalModel?.downloadBytes ? ` · ${formatBytes(selectedLocalModel.downloadBytes)}` : ''}`}</button>
                      : <a className="secondary-button local-runtime-link" href="https://ollama.com/download" target="_blank" rel="noreferrer"><Download size={15} />安装本地运行器</a>}
                  </div>
                  {localModelStatus?.runtime.ready && <div className="local-model-expand"><label><span>扩展模型</span><input value={localCustomModelId} disabled={localInstallActive} onChange={(event) => setLocalCustomModelId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void installLocalModel(localCustomModelId) } }} placeholder="Ollama 模型 ID，如 qwen3-vl:4b" spellCheck={false} /></label><button type="button" className="secondary-button" disabled={startingLocalInstall || activatingLocalAi || localInstallActive || !localCustomModelId.trim()} onClick={() => void installLocalModel(localCustomModelId)}><Download size={15} />安装扩展</button></div>}
                  {selectedLocalModel && !localInstallActive && <div className="local-model-detail"><p className="local-model-description">{selectedLocalModel.description}{selectedLocalModel.installed ? ' · 已安装' : ''}</p><div className="local-model-meta"><span>{selectedLocalModel.family}</span><span>{selectedLocalModel.tier}</span>{selectedLocalModel.downloadBytes > 0 && <span>约 {formatBytes(selectedLocalModel.downloadBytes)}</span>}</div></div>}
                  {localModelStatus?.install && localInstallActive && <div className="local-install-progress" role="status" aria-live="polite"><div><span>{localModelStatus.install.message}</span><strong>{localModelStatus.install.progress}%</strong></div><progress max="100" value={localModelStatus.install.progress} /></div>}
                </div>
                {selectedProvider?.relay && <div className={`ai-relay-status ${aiConnectionCheck?.status || 'idle'}`}>
                  <div className="ai-relay-status-heading"><Shuffle size={17} /><span><strong>OpenAI 兼容中转</strong><small>自动校正接口路径并读取账号可用模型</small></span><b>{aiConnectionCheck?.status === 'checking' ? '检测中' : aiConnectionCheck?.status === 'verified' ? '连接可用' : aiConnectionCheck?.status === 'error' ? '需要修正' : '待检测'}</b></div>
                  <div className="ai-relay-progress" aria-label="中转配置进度"><span className={aiBaseUrl.trim() ? 'done' : ''}>01 地址</span><span className={apiKey || selectedProvider.hasApiKey ? 'done' : ''}>02 密钥</span><span className={aiConnectionCheck?.status === 'verified' ? 'done' : ''}>03 模型</span></div>
                </div>}
                {selectedProvider?.relay ? <>
                  <div className="form-row ai-relay-address-row">
                    <label className="field"><span>提供方</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as AiProviderOption['id'])}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                    <label className="field relay-base-url-field"><span>API Base URL</span><div className="relay-url-control"><input value={aiBaseUrl} onChange={(event) => updateAiBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" inputMode="url" spellCheck={false} /><button type="button" className="secondary-button relay-model-test" disabled={refreshingModels || !aiBaseUrl.trim() || (!apiKey && !selectedProvider.hasApiKey)} onClick={() => void refreshAiModels()}>{refreshingModels ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}检测模型</button></div><small className={`relay-check-message ${aiConnectionCheck?.status || 'idle'}`} aria-live="polite">{aiConnectionCheck?.message || '支持粘贴 API 根地址或完整的 /chat/completions 接口地址'}</small></label>
                  </div>
                  <div className="form-row ai-provider-row ai-relay-credentials-row">
                    <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => { invalidateAiSession(); setApiKey(event.target.value); setAiConnectionCheck(null) }} placeholder={selectedProvider.hasApiKey ? '已保存，留空即可复用' : '粘贴中转服务 API Key'} /></label>
                    <label className="field"><span>协议</span><select value={aiWireApi} onChange={(event) => { invalidateAiSession(); setAiWireApi(event.target.value as 'responses' | 'chat_completions') }}><option value="chat_completions">Chat Completions</option><option value="responses">Responses API</option></select></label>
                    <div className="field model-field"><span id="relay-ai-model-label">模型</span><div className="model-picker single"><select aria-labelledby="relay-ai-model-label" value={selectedModelValue} onChange={(event) => selectAiModel(event.target.value)}><option value="" disabled>检测后选择模型</option>{(selectedProvider.models || []).map((model) => <option key={model} value={model}>{model}</option>)}<option value={CUSTOM_MODEL_OPTION}>自定义模型 ID…</option></select></div><small>{selectedProvider.models.length || 0} 个可选模型</small></div>
                  </div>
                </> : <>
                  <div className="form-row ai-provider-row">
                    <label className="field"><span>提供方</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as AiProviderOption['id'])}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                    {selectedProvider?.requiresKey
                      ? <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => { invalidateAiSession(); setApiKey(event.target.value) }} placeholder={selectedProvider?.hasApiKey ? '已保存，留空即可复用' : '粘贴模型服务 API Key'} /></label>
                      : <div className="field local-access-field"><span>运行方式</span><strong><Cpu size={14} />本机免密 · 零 API 费用</strong></div>}
                    <div className="field model-field"><span id="ai-model-label">模型</span><div className="model-picker"><select aria-labelledby="ai-model-label" value={selectedModelValue} onChange={(event) => selectAiModel(event.target.value)}><option value="" disabled>选择模型</option>{(selectedProvider?.models || []).map((model) => <option key={model} value={model}>{model}</option>)}<option value={CUSTOM_MODEL_OPTION}>自定义模型 ID…</option></select><button type="button" className="model-refresh-button" title={selectedProvider?.local ? '读取本机已安装模型' : '读取当前账号可用模型'} aria-label={selectedProvider?.local ? '读取本机已安装模型' : '读取当前账号可用模型'} disabled={refreshingModels || !aiBaseUrl.trim() || (selectedProvider?.requiresKey && !apiKey && !selectedProvider?.hasApiKey)} onClick={() => void refreshAiModels()}>{refreshingModels ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div><small>{selectedProvider?.models.length || 0} 个可选模型</small></div>
                  </div>
                  <div className="form-row ai-provider-row">
                    <label className="field base-url-field"><span>Base URL</span><input value={aiBaseUrl} onChange={(event) => updateAiBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" /></label>
                    <label className="field"><span>协议</span><select value={aiWireApi} onChange={(event) => { invalidateAiSession(); setAiWireApi(event.target.value as 'responses' | 'chat_completions') }}><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option></select></label>
                  </div>
                </>}
                {customModelMode && <label className="field custom-model-field"><span>自定义模型 ID</span><input value={aiModel} onChange={(event) => { invalidateAiSession(); setAiModel(event.target.value) }} placeholder="例如 provider/model-name" /></label>}
                <small className="form-hint">{selectedProvider?.local ? request.analysisMode === 'general' ? '用于正文归纳、图片文字理解和动态栏目生成；速度取决于本机硬件。' : '适合职位信息提炼、简历事实整理和初稿生成；速度取决于本机硬件。' : selectedProvider?.relay ? '密钥仅保存在当前设备；连接时会再次验证地址和模型，不写入任务历史或 GitHub。' : providerId === 'codex' ? '内置 Codex Runtime，用户电脑无需安装 Codex CLI；填写模型服务 Base URL 后直接调用。' : '配置保存在本机，API Key 不进入任务历史或 GitHub。'}</small>
                <button type="button" className="secondary-button setup-action" disabled={configuringAi || (!selectedProvider?.relay && !aiModel.trim()) || (selectedProvider?.relay && customModelMode && !aiModel.trim()) || !aiBaseUrl.trim() || (selectedProvider?.requiresKey && !apiKey && !selectedProvider?.hasApiKey)} onClick={() => void configureAi()}>{configuringAi ? <LoaderCircle className="spin" size={16} /> : selectedProvider?.relay ? <Wifi size={16} /> : <BrainCircuit size={16} />}{selectedProvider?.relay ? (aiSession ? '重新验证并连接' : '验证并连接') : aiSession ? '重新连接' : '连接 AI'}</button>
              </section>
              {request.analysisMode === 'job' && <section>
                <div className="setup-title"><Upload size={17} /><span><strong>背景资料</strong><small>{activeProfile ? `${activeProfile.display_name || '个人档案'} · ${activeProfile.sourceFiles?.length || 0} 个来源` : 'PDF / DOCX / TXT / MD / JSON / CSV / RTF'}</small></span></div>
                <div className={`profile-ai-route ${selectedProvider?.local ? 'local' : 'external'}`}>
                  <BrainCircuit size={18} />
                  <span><strong>本次解析模型</strong><small>{profileAiRouteLabel}</small></span>
                  <b>{profileAiSessionReady ? '会话已匹配' : '解析时按此配置连接'}</b>
                </div>
                <label className="upload-zone"><input type="file" multiple accept=".pdf,.docx,.txt,.md,.json,.csv,.rtf" onChange={(event) => setBackgroundFiles(Array.from(event.target.files || []))} /><Upload size={18} /><span>{backgroundFiles.length ? `已选择 ${backgroundFiles.length} 个文件` : '选择多格式背景文件'}</span></label>
                <textarea className="background-text" value={backgroundText} onChange={(event) => setBackgroundText(event.target.value)} placeholder="可补充项目背景、工作偏好或可验证成果" />
                <div className="profile-actions">
                  <select value={request.profileId || ''} onChange={(event) => {
                    const profileId = event.target.value || null
                    void draftGuard.requestTransition('切换 Profile', () => updateRequest('profileId', profileId))
                  }}><option value="">选择背景记忆</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.id}</option>)}</select>
                  <button type="button" className="secondary-button" disabled={importingProfile || !backgroundFiles.length || !aiModel.trim() || !aiBaseUrl.trim()} onClick={() => void importProfile()}>{importingProfile ? <LoaderCircle className="spin" size={16} /> : <BrainCircuit size={16} />}用当前模型解析</button>
                </div>
                {activeProfile && <div className="memory-preview">
                  <div className="memory-preview-meta"><span>{activeProfile.analysis_runtime ? `${activeProfile.analysis_runtime.provider} / ${activeProfile.analysis_runtime.model}` : '旧版档案'}</span><b>{activeProfile.evidence_items?.length || 0} 条可核验证据</b></div>
                  {activeProfile.analysis_runtime?.base_url && <small className="memory-preview-endpoint">解析端点：{activeProfile.analysis_runtime.base_url}</small>}
                  <strong>{activeProfile.first_person_profile?.narrative || activeProfile.summary}</strong>
                  {!!activeProfile.first_person_profile?.core_strengths?.length && <ul>{activeProfile.first_person_profile.core_strengths.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>}
                  {!!activeProfile.writing_constraints?.missing_information?.length && <p>待补充：{activeProfile.writing_constraints.missing_information.join('、')}</p>}
                  <span>{(activeProfile.skills || []).slice(0, 8).join(' · ')}</span>
                </div>}
              </section>}
            </div>
            {request.analysisMode === 'job' && <section className="candidate-profile-section">
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
            </section>}
          </section>

          <div className="primary-grid">
            <section className="panel config-panel" id="task-config">
              <div className="panel-heading">
                <div><span className="step-label">01 / CONFIGURE</span><h2>{collectionEntryMode === 'import' ? '批量采集指定正文' : request.analysisMode === 'general' ? '新建非岗位信息研究任务' : '新建采集与投递分析任务'}</h2></div>
                <span className="local-badge">本地执行</span>
              </div>
              <div className="collection-entry-switch" role="tablist" aria-label="采集入口">
                <button type="button" role="tab" aria-selected={collectionEntryMode === 'search'} className={collectionEntryMode === 'search' ? 'selected' : ''} onClick={() => setCollectionEntryMode('search')}><Search size={15} />关键词发现</button>
                <button type="button" role="tab" aria-selected={collectionEntryMode === 'import'} className={collectionEntryMode === 'import' ? 'selected' : ''} onClick={() => setCollectionEntryMode('import')}><FileJson size={15} />批量正文</button>
              </div>
              {collectionEntryMode === 'import' && <BodyImportPanel submitting={submitting} relayReady={relayReady} maxAgeDays={request.maxAgeDays} onMaxAgeDays={(days) => updateRequest('maxAgeDays', days)} onStart={startBodyImport} />}
              <form onSubmit={submit} hidden={collectionEntryMode !== 'search'}>
                <div className={`workspace-mode-summary ${workspaceMode === 'general' ? 'content' : 'job'}`}>
                  <span className="workspace-mode-icon">{workspaceMode === 'general' ? <BookOpenCheck size={19} /> : <Target size={19} />}</span>
                  <span><small>{workspaceMode === 'general' ? 'NON-JOB RESEARCH INTERFACE' : 'JOB APPLICATION INTERFACE'}</small><strong>{workspaceMode === 'general' ? '非岗位信息采集与 AI 研究' : '岗位采集与投递'}</strong><p>{workspaceMode === 'general' ? '可选择经验、人群、趋势、产品、地点或自定义目标；AI 按内容证据动态生成结构，而不是套岗位模板。' : '采集岗位正文与图片，整理岗位卡、投递方式和通过质量门禁的可编辑投递文案。'}</p></span>
                </div>
                {workspaceMode === 'general' ? <section className="content-research-builder" aria-labelledby="content-research-type-label">
                  <div className="content-research-builder-heading"><span><BrainCircuit size={17} /><strong id="content-research-type-label">选择信息类型</strong></span><small>场景约束分析方向，AI 仍会根据每条正文和图片动态生成栏目</small></div>
                  <div className="content-preset-grid">
                    {contentResearchOptions.map((option) => <button key={option.id} type="button" className={`content-preset-option ${request.contentPreset === option.id ? 'selected' : ''}`} aria-pressed={request.contentPreset === option.id} onClick={() => updateRequest('contentPreset', option.id)}>
                      <span>{option.icon}<strong>{option.label}</strong></span><p>{option.description}</p><small>{option.example}</small>
                    </button>)}
                  </div>
                  <label className="field content-goal-field"><span>研究目标 <i>可选</i></span><textarea maxLength={500} value={request.contentGoal} onChange={(event) => updateRequest('contentGoal', event.target.value)} placeholder="例如：比较短发造型的脸型适配、打理成本和高频踩坑，并保留原文依据。" /><small className="field-help">越具体，AI 生成的栏目越贴近你的决策问题。未填写时会按所选场景自动规划。</small></label>
                </section> : null}
                <label className="field keyword-field">
                  <span>搜索关键词</span>
                  <div className="input-shell"><Search size={18} /><input value={request.keyword} onChange={(event) => updateRequest('keyword', event.target.value)} required placeholder="输入小红书搜索关键词" /></div>
                </label>

                <div className="field range-field">
                  <span>采集范围</span>
                  <div className="sort-policy full-coverage" role="status" aria-label="范围内发现多少采集多少">
                    <Target size={17} />
                    <span><strong>时间范围内，发现多少采集多少</strong><small>先按发布时间缩小正文队列，再为范围内每条内容采集正文</small></span>
                    <em>不限条数</em>
                  </div>
                  <small className="field-help">连续 {request.stableRounds} 轮没有新增时即可结束发现；最多执行 {request.maxScrolls} 轮。中断后从同一时间范围的检查点续跑。</small>
                </div>

                <div className="form-row connection">
                  <label className="field"><span>浏览器 Profile</span><select value={request.browserProfile} onChange={(event) => updateRequest('browserProfile', event.target.value)}><option value="openclaw">openclaw（独立）</option><option value="chrome">chrome（当前浏览器）</option></select></label>
                  <label className="field"><span>Relay 端口</span><input type="number" min="1024" max="65535" value={request.relayPort} onChange={(event) => updateRequest('relayPort', Number(event.target.value))} /></label>
                </div>

                <div className="field sort-policy-field">
                  <span>搜索排序</span>
                  <div className="sort-policy latest" role="status" aria-label="小红书搜索固定为最新发布">
                    <Clock3 size={17} />
                    <span><strong>固定采集“最新发布”</strong><small>新采集会自动点击并确认“最新”；续跑只复用已经按最新发现的{request.analysisMode === 'general' ? '内容' : '岗位'}</small></span>
                    <em>强制校验</em>
                  </div>
                  <small className="field-help">历史“综合推荐”任务续跑时会放弃旧卡片缓存，重新按“最新”发现{request.analysisMode === 'general' ? '内容' : '岗位'}；页面未确认“最新”时不会开始采集。</small>
                </div>

                <div className="field recency-field">
                  <span>采集时间范围</span>
                  <div className="segmented" role="group" aria-label="采集时间范围">
                    {[7, 14, 30, 0].map((days) => <button key={days} type="button" className={request.maxAgeDays === days ? 'selected' : ''} onClick={() => updateRequest('maxAgeDays', days)}>
                      <CalendarDays size={15} />{days === 0 ? '不限' : `${days} 天`}
                    </button>)}
                  </div>
                  <small className="field-help">默认近 14 天。已知早于范围的卡片不会发起正文请求；发布时间无法解析的卡片仍会保留。</small>
                </div>

                <div className="field mode-field pacing-mode-field">
                  <span>采集节奏</span>
                  <div className="segmented">
                    <button type="button" className={request.speedMode === 'steady' ? 'selected' : ''} onClick={() => updateRequest('speedMode', 'steady')}><Gauge size={15} />匀速</button>
                    <button type="button" className={request.speedMode === 'random' ? 'selected' : ''} onClick={() => updateRequest('speedMode', 'random')}><Shuffle size={15} />随机节奏</button>
                  </div>
                  <small className="field-help">随机节奏会在设定范围内变化滚动和正文间隔，降低突发请求与固定节奏风险。</small>
                </div>
                <div className="pacing-grid">
                  {request.speedMode === 'random' ? (
                    <>
                      <label className="field"><span>最短间隔 s</span><input type="number" min="0" max="60" step="0.1" value={request.randomDelayMinSeconds} onChange={(event) => updateRequest('randomDelayMinSeconds', Number(event.target.value))} /></label>
                      <label className="field"><span>最长间隔 s</span><input type="number" min="0" max="60" step="0.1" value={request.randomDelayMaxSeconds} onChange={(event) => updateRequest('randomDelayMaxSeconds', Number(event.target.value))} /></label>
                    </>
                  ) : (
                    <label className="field"><span>固定间隔 s</span><input type="number" min="0" max="60" step="0.1" value={request.noteDelaySeconds} onChange={(event) => updateRequest('noteDelaySeconds', Number(event.target.value))} /></label>
                  )}
                </div>

                <button className="advanced-trigger" type="button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
                  <Settings2 size={16} />高级参数<ChevronDown size={16} className={advanced ? 'rotated' : ''} />
                </button>
                {advanced && (
                  <div className="advanced-grid">
                    <label className="field"><span>最大滚动</span><input type="number" min="1" max="100" value={request.maxScrolls} onChange={(event) => updateRequest('maxScrolls', Number(event.target.value))} /></label>
                    <label className="field"><span>稳定轮次</span><input type="number" min="1" max="20" value={request.stableRounds} onChange={(event) => updateRequest('stableRounds', Number(event.target.value))} /></label>
                    <label className="field"><span>页面超时 ms</span><input type="number" min="1000" max="120000" step="1000" value={request.gotoTimeoutMs} onChange={(event) => updateRequest('gotoTimeoutMs', Number(event.target.value))} /></label>
                    <label className="field"><span>安全验证等待 s</span><input type="number" min="60" max="86400" step="60" value={request.securityVerificationTimeoutSeconds} onChange={(event) => updateRequest('securityVerificationTimeoutSeconds', Number(event.target.value))} /></label>
                    <label className="field"><span>Codex 单批数量</span><input type="number" min="1" max="20" value={request.codexBatchSize} onChange={(event) => updateRequest('codexBatchSize', Number(event.target.value))} /></label>
                    <Toggle checked={request.analysisMode === 'general' || request.useCodexRuntime} onChange={(value) => request.analysisMode === 'job' && updateRequest('useCodexRuntime', value)} label={request.analysisMode === 'general' ? 'AI 动态内容模块' : 'AI 文案与评分'} description={request.analysisMode === 'general' ? '根据关键词、正文和图片逐链接生成栏目' : '逐链接写作、评分并自动重写'} />
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
                  <button className="primary-button" type="submit" disabled={submitting || !request.keyword.trim() || !aiSession || (request.analysisMode === 'job' && (!backgroundReady || !candidateReady))}>{submitting ? <LoaderCircle className="spin" size={18} /> : <Play size={18} fill="currentColor" />}启动全流程</button>
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
                  <div className="mission-title"><span>{activeBodyImport ? '批次' : '关键词'}</span><strong>{activeJob.keyword}</strong><small>#{activeJob.id.slice(0, 8)}</small></div>
                  <div className="scope-stamp"><Target size={15} /><span><strong>{activeBodyImport ? '指定链接批量正文' : activeAllMode ? '范围内全量采集' : '历史限定任务'}</strong><small>{activeBodyImport ? `导入 ${activeJob.config?.importedBodyCount ?? activeJob.progressTotal ?? '-'} 条 · ${activeJob.config?.maxAgeDays ? `近 ${activeJob.config.maxAgeDays} 天` : '不限时间'} · 不重新搜索 · 断点续跑` : activeAllMode ? `最新优先 · ${activeJob.config?.maxAgeDays ? `近 ${activeJob.config.maxAgeDays} 天` : '不限时间'} · 最多 ${activeJob.config?.maxScrolls ?? '-'} 轮发现 · 单路采正文` : '历史任务按原检查点展示'}</small></span></div>
                  <JobJourneyPanel
                    job={activeJob}
                    mode={activeAnalysisMode}
                    connectionState={displayJobConnectionState}
                    lastEventAt={jobLastEventAt}
                    now={clock}
                    actionBusy={submitting || audienceResuming || relayLoginOpening || securityRecovering || journeyActionBusy}
                    isProblemActionDisabled={(_problem, actionId) => actionId === 'open_login'
                      ? relayLoginOpening || journeyActionBusy
                      : actionId === 'check_recovery'
                        ? submitting || audienceResuming || journeyActionBusy
                        : submitting || journeyActionBusy || !activeJob.resumeAvailable}
                    onProblemAction={(problem: UserProblem, actionId) => {
                      if (actionId === 'open_login') {
                        void performJourneyProblemAction(activeJob, problem, actionId)
                        return
                      }
                      if (actionId === 'refresh_security') {
                        void draftGuard.requestTransition('刷新验证并继续原任务', () => refreshSecurityAndContinue(activeJob))
                        return
                      }
                      if (actionId === 'check_recovery' || actionId === 'resume') {
                        void performJourneyProblemAction(activeJob, problem, actionId)
                      }
                    }}
                  />
                  <div className="mission-meta"><div><span>开始时间（北京时间）</span><strong>{formatTime(activeJob.startedAt || activeJob.createdAt)}</strong></div><div><span>运行时长</span><strong>{elapsed(activeJob)}</strong></div></div>
                  {['queued', 'resuming', 'running'].includes(activeJob.status) && <button className="cancel-button" onClick={cancel}><Pause size={16} />终止任务</button>}
                </>
              ) : (
                <div className="empty-state"><SquareTerminal size={32} /><strong>等待任务</strong><span>配置关键词与采集参数后启动</span></div>
              )}
            </section>

            <details className="panel log-panel technical-details-panel">
              <summary className="panel-heading dark-heading">
                <div><span className="step-label">STATUS EXPLAINED</span><h2>系统状态说明</h2><small>先看日常说明；原始记录只在需要排查时展开</small></div>
                <span className="technical-details-toggle"><Info size={15} />{logs.length ? `还有 ${logs.length} 条系统记录` : '暂无系统记录'}<ChevronDown size={17} /></span>
              </summary>
              {activeJob && (
                <div className={`readable-job-summary job-state-${activeJob.status}`}>
                  <div className="readable-job-banner">
                    <span className="readable-job-icon">{activeJob.status === 'completed' ? <Check size={18} /> : readableIssue ? <CircleAlert size={18} /> : activeJob.status === 'queued' ? <Clock3 size={18} /> : <Activity size={18} />}</span>
                    <div>
                      <span className="readable-job-eyebrow">现在发生了什么</span>
                      <strong>{readableJobView?.headline || statusText[activeJob.status]}</strong>
                      <p>{readableJobView?.detail || '系统正在整理已保存的任务信息。'}</p>
                    </div>
                  </div>
                  <div className="readable-job-grid">
                    <div><span>正在处理</span><strong>{readableStage?.label || (activeJob.status === 'completed' ? '所有步骤' : '准备下一步')}</strong><small>{readableStage?.detail || '暂无需要补充的步骤'}</small></div>
                    <div><span>已保存结果</span><strong>{readableSavedCount ? `${readableSavedCount} 条` : '暂未产生'}</strong><small>{readableSavedCount ? '刷新页面也会保留' : '完成第一项后会显示'}</small></div>
                    <div><span>最近保存</span><strong>{formatTime(activeJob.progressUpdatedAt || activeJob.updatedAt || activeJob.createdAt)}</strong><small>系统会持续保存进度</small></div>
                  </div>
                  <div className={`readable-next-step ${readableIssue?.requiresUserAction ? 'needs-action' : ''}`}>
                    <Info size={16} />
                    <span><strong>你下一步可以做什么</strong><small>{readableNextStep}</small></span>
                  </div>
                </div>
              )}
              <details className="raw-log-disclosure">
                <summary><Code2 size={15} /><span>需要排查时查看原始记录</span><small>{logs.length} 条</small><ChevronDown size={15} /></summary>
                {activeJob && (
                  <dl className="technical-job-meta">
                    <div><dt>任务编号</dt><dd>{activeJob.id}</dd></div>
                    <div><dt>本次运行编号</dt><dd>{activeJob.currentAttemptId || '-'}</dd></div>
                    <div><dt>保存版本</dt><dd>{activeJob.revision ?? '-'}</dd></div>
                    <div><dt>系统阶段名</dt><dd>{activeJob.progressPhase || '-'}</dd></div>
                    {activeJob.message && <div className="technical-job-error"><dt>系统原话</dt><dd>{activeJob.message}</dd></div>}
                  </dl>
                )}
                <div className="log-console" ref={logConsole}>
                  {logs.length ? logs.map((line, index) => <p key={`${index}-${line}`}><span>{String(index + 1).padStart(2, '0')}</span>{line}</p>) : <div className="log-placeholder"><SquareTerminal size={25} /><span>暂无原始记录</span></div>}
                  <div ref={logEnd} />
                </div>
              </details>
            </details>
          </div>

          <section className="panel coverage-panel" aria-label="结果覆盖">
            <div className="panel-heading compact">
                <div><span className="step-label">COVERAGE & QUALITY</span><h2>{activeAnalysisMode === 'general' ? '内容覆盖与事实边界' : '结果覆盖与事实边界'}</h2></div>
              <span className={`coverage-state ${coverage?.gatePassed === false ? 'failed' : coverage?.gatePassed ? 'passed' : ''}`}>{coverage?.gatePassed === true ? '质量门禁通过' : coverage?.gatePassed === false ? `质量门禁未通过 · ${coverage.issueCount ?? '-'} 项` : activeJob?.status === 'completed' ? '等待覆盖摘要' : '随任务更新'}</span>
            </div>
            <div className="coverage-content">
              <div className="coverage-grid">
                {coverageCards.map(({ label, value, icon: Icon }) => <div className="coverage-metric" key={label}><Icon size={17} /><span>{label}</span><strong>{value ?? '-'}</strong></div>)}
              </div>
              <p className={`coverage-note ${securityTimedOut ? 'warning' : ''}`}><ShieldCheck size={16} />{securityTimedOut ? `安全验证在 ${securityTimeoutLabel}内未解除，采集已按规则停止；当前结果来自已保存正文的整理与分析，未采集链接保留缺失状态。` : activeAnalysisMode === 'general' ? '所有已发现内容均会尝试采集正文和原图；AI 栏目必须给出原文依据，无法确认的信息保留待补全状态。' : '所有已发现卡片均会尝试打开正文；失败、访问受限或缺少联系方式的记录保留状态与原因，不补造内容。'}</p>
              {activeAnalysisMode === 'job' && contactOcr && <p className={`coverage-note ${contactOcr.status === 'failed' || contactOcr.status === 'partial' ? 'warning' : ''}`}><Images size={16} />{contactOcr.active || ['starting', 'running'].includes(contactOcr.status)
                ? `图片邮箱识别正在后台运行：本轮已处理 ${contactOcrProcessed} / ${contactOcrTotal || '待统计'}；与正文采集并行，不阻塞当前任务。`
                : contactOcr.status === 'completed'
                  ? `图片邮箱识别已处理 ${contactOcrComplete ?? 0} 条，正文已有邮箱直接跳过 ${contactOcrSkippedBodyEmail ?? 0} 条，仍有 ${contactOcrPending ?? 0} 条待处理；识别结果会带图片证据进入投递预检。`
                  : contactOcr.status === 'partial'
                    ? `图片邮箱识别部分完成：成功 ${contactOcr.succeeded ?? contactOcrQueue?.succeeded ?? 0} 条，失败 ${contactOcr.failed ?? contactOcrQueue?.failed ?? 0} 条，失败项可从检查点重试。`
                    : contactOcr.status === 'failed'
                      ? '图片邮箱识别队列启动失败，已保留原图和检查点，可在修复本地模型后继续。'
                      : '图片邮箱识别队列等待启动；正文没有邮箱时，评论采集状态仍会保留为待确认。'}</p>}
            </div>
          </section>

          <section className="panel results-panel" id="results" aria-label={batchSurfaceActive ? '批量投递界面' : expansionModuleActive ? '关系扩散工作台' : audienceModuleActive ? '受众及用户界面结果' : activeAnalysisMode === 'general' ? '逐链接内容分析结果' : '逐链接投递结果'}>
            <div className="panel-heading compact">
              <div><span className="step-label">{batchSurfaceActive ? 'BATCH APPLICATION DELIVERY' : expansionModuleActive ? 'RELATIONSHIP EXPANSION WORKSPACE' : audienceModuleActive ? 'AUDIENCE & USER INTELLIGENCE' : activeAnalysisMode === 'general' ? (results?.insights ? results?.presentation?.eyebrow : '') || 'KEYWORD CONTENT INTELLIGENCE' : 'PER-LINK APPLICATION INTELLIGENCE'}</span><h2>{batchSurfaceActive ? '批量投递工作台' : expansionModuleActive ? '关系扩散' : audienceModuleActive ? '受众及用户界面' : activeAnalysisMode === 'general' ? (results?.insights ? results?.presentation?.title : '') || `${activeJob?.keyword || request.keyword || '关键词'}内容洞察` : '逐链接岗位与投递文案'}</h2>{batchSurfaceActive ? <p className="result-heading-description">从已保存正文中选择岗位，预检收件人、文案和附件后再分批发送。</p> : expansionModuleActive ? <p className="result-heading-description">从当前任务已保存的帖子出发，多轮采集公开用户、帖子、评论与关系，并持续写回同一任务。</p> : audienceModuleActive ? <p className="result-heading-description">逐帖采集评论、楼中楼回复、原帖主和评论者公开资料，并用严格覆盖状态标记全量程度。</p> : activeAnalysisMode === 'general' && results?.insights && results?.presentation?.description ? <p className="result-heading-description">{results.presentation.description}</p> : null}</div>
              <div className="result-heading-meta">
                <span className={`runtime-badge ${batchSurfaceActive || expansionStatus === 'completed' || audienceResults?.summary.status === 'complete' || codexRuntime?.status === 'completed' ? 'passed' : ''}`}>{batchSurfaceActive ? '投递批次 · 发送前预检' : expansionModuleActive ? `多轮扩散 · ${expansionStatusText}` : audienceModuleActive ? `全量评论流 · ${audienceStatusLabel(audienceResults?.summary.status || 'pending')}` : `${activeAnalysisMode === 'general' ? 'AI 内容流' : 'AI 质量流'} · ${String(codexRuntime?.status || '等待结果')}`}</span>
                <span className="count-badge">{expansionModuleActive ? Number((expansionSummary?.counters as Record<string, unknown> | undefined)?.users || 0) : audienceModuleActive ? audienceResults?.total ?? 0 : results?.total ?? activeJob?.applicationCount ?? 0}</span>
              </div>
            </div>
            {activeAnalysisMode === 'general' && <nav className="general-result-tabs" role="tablist" aria-label="非岗位研究结果模块" onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
              const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click()
            }}>
              <button type="button" role="tab" className={generalResultModule === 'insights' ? 'active' : ''} aria-selected={generalResultModule === 'insights'} onClick={() => switchGeneralResultModule('insights')}><BookOpenCheck size={16} /><span>内容洞察</span><small>正文、图片与 AI 结构</small></button>
              <button type="button" role="tab" className={generalResultModule === 'audience' ? 'active' : ''} aria-selected={generalResultModule === 'audience'} onClick={() => switchGeneralResultModule('audience')}><UsersRound size={16} /><span>受众及用户界面</span><small>评论、回复与用户卡</small></button>
              <button type="button" role="tab" className={generalResultModule === 'expansion' ? 'active' : ''} aria-selected={generalResultModule === 'expansion'} onClick={() => switchGeneralResultModule('expansion')}><Network size={16} /><span>关系扩散</span><small><b>多轮</b> · 用户、帖子与评论关系</small><i className={`module-state ${expansionStatus}`}>{expansionStatusText}</i></button>
            </nav>}
            {activeAnalysisMode === 'general' && <ExpansionWorkspace job={activeJob} relayReady={relaySiteReady} visible={expansionModuleActive} onJobUpdated={(job) => {
              setActiveJob(job)
              setJobs((current) => current.map((item) => item.id === job.id ? job : item))
            }} onReturnInsights={() => switchGeneralResultModule('insights')} />}
            {!expansionModuleActive && (audienceModuleActive ? <AudienceWorkspace
              jobId={audienceSourceJobId || audienceReadJobId || ''}
              results={audienceResults}
              loading={audienceLoading}
              task={trackedAudienceTask}
              aiSession={aiSession}
              audienceAiEnabled={health?.audienceAi?.enabled === true}
              anchorTarget={audienceAnchorTarget}
              actionMessage={audienceActionMessage}
              kind={audienceKind}
              postId={audiencePostId}
              query={audienceQuery}
              pageSize={audiencePageSize}
              resuming={audienceResuming}
              growing={audienceGrowing}
              growthScrolls={audienceGrowthScrolls}
              onKind={(value) => { setAudienceAnchorTarget(null); setAudienceKind(value); setAudienceOffset(0) }}
              onPost={(value) => { setAudienceAnchorTarget(null); setAudiencePostId(value); setAudienceOffset(0) }}
              onQuery={(value) => { setAudienceAnchorTarget(null); setAudienceQuery(value); setAudienceOffset(0) }}
              onPageSize={(value) => { setAudienceAnchorTarget(null); setAudiencePageSize(value); setAudienceOffset(0) }}
              onPage={(offset) => { setAudienceAnchorTarget(null); if (audienceReadJobId) void loadAudienceResults(audienceReadJobId, offset, {
                preserveExisting: audienceReadJobId !== audienceSourceJobId,
                fallbackJobId: audienceSourceJobId,
                sourceJobId: audienceSourceJobId,
              }) }}
              onResume={() => void resumeAudienceCollection()}
              onGrowthScrolls={setAudienceGrowthScrolls}
              onGrow={() => void growAudienceCollection()}
              onConfigureAi={() => document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              onNavigateEvidence={(target) => {
                const targetPostId = target.anchor.postId || audiencePostId
                setAudienceKind(target.kind)
                setAudiencePostId(targetPostId)
                setAudienceQuery('')
                setAudienceAnchorTarget({
                  kind: target.kind,
                  entityId: target.entityId,
                  postId: targetPostId,
                  offset: Math.max(0, Number(target.anchor.offset || 0)),
                  anchor: target.anchor,
                })
              }}
            /> : <>{!batchSurfaceActive && completionFlow && <MissingCompletionFlowPanel
              flow={completionFlow}
              job={completionFlow.jobId === activeJob?.id ? activeJob : null}
              noun={activeAnalysisMode === 'general' ? '内容分析' : '岗位信息'}
              onDismiss={() => setCompletionFlow(null)}
            />}
            {batchSurfaceActive && <div className="batch-workspace-screen">
              <div className="batch-screen-toolbar">
                <div><span className="step-label">独立投递界面</span><h3>选择、预检、审批、发送</h3><p>岗位正文和已生成文案继续使用当前任务的已保存版本，不会重新采集或覆盖。</p></div>
                <div className="batch-screen-actions">
                  <label><span>岗位任务</span><select aria-label="批量投递使用的岗位任务" value={activeJob?.id || ''} onChange={(event) => {
                    const nextJob = workspaceJobs.find((job) => job.id === event.target.value)
                    if (nextJob) void selectJob(nextJob)
                  }}><option value="" disabled>选择岗位任务</option>{workspaceJobs.map((job) => <option key={job.id} value={job.id}>{job.keyword || '未命名任务'} · {statusText[job.status]}</option>)}</select></label>
                  <button type="button" onClick={() => switchApplicationView('jobs')}><Target size={15} />返回岗位投递</button>
                </div>
              </div>
              {activeJob ? <BatchApplicationPanel
                standalone
                jobId={activeJob.id}
                items={results?.items || []}
                aiSessionId={aiSession?.id}
                onOpenItem={(item) => {
                  performChooseResult(item)
                  performSwitchApplicationView('jobs')
                  window.requestAnimationFrame(() => document.querySelector('.result-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
                }}
              /> : <div className="result-empty"><Send size={28} /><strong>请先在岗位投递界面选择一个任务</strong></div>}
            </div>}
            {!batchSurfaceActive && (!results?.available ? (
              <div className="result-empty">{activeAnalysisMode === 'general' ? <BookOpenCheck size={28} /> : <UserRoundSearch size={28} />}<strong>{resultsLoading ? '正在读取分析结果' : ['resuming', 'running'].includes(activeJob?.status || '') ? activeAnalysisMode === 'general' ? '发现内容后将自动采集正文、图片并生成 AI 模块' : '发现岗位后将自动解析到这里' : '当前任务还没有结构化分析结果'}</strong></div>
            ) : activeAnalysisMode === 'general' ? (
              <GeneralResultsWorkspace
                results={results}
                selectedResult={selectedResult}
                resultOffset={resultOffset}
                resultSort={resultSort}
                resultTimeRange={resultTimeRange}
                resultsLoading={resultsLoading}
                completingMissing={completingMissing || restoringAi || submitting}
                onSelect={chooseResult}
                onSort={(value) => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultSort(value) }}
                onTimeRange={(value) => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultTimeRange(value) }}
                onReset={() => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultSort('newest'); setResultTimeRange('all') }}
                onComplete={() => void completeMissingResults()}
                onPage={(offset) => { draftViewRevisionRef.current += 1; if (activeJob) void loadResults(activeJob.id, offset) }}
                onPreview={openImagePreview}
                onCopy={copyText}
              />
            ) : (
              <>
              <div className="results-control-bar">
                <div className="result-stats" aria-label="岗位卡统计">
                  <span><strong>{resultFilterStats(results).all}</strong>正文已采岗位</span>
                  <span className={(resultSort !== 'newest' || resultTimeRange !== 'all') ? 'active-filter-stat' : ''}><strong>{results.total}</strong>筛选结果</span>
                  <span className={resultCompletionStats(results).sourcePending ? 'warning' : ''}><strong>{resultCompletionStats(results).sourcePending}</strong>正文待续采</span>
                  <span className={resultFilterStats(results).incomplete ? 'warning' : ''}><strong>{resultFilterStats(results).incomplete}</strong>信息未完整</span>
                  <span><strong>{resultFilterStats(results).withImages}</strong>含图片</span>
                  <span><strong>{resultFilterStats(results).unknown}</strong>日期待确认</span>
                </div>
                <div className="result-controls" aria-busy={resultsLoading}>
                  <label><ArrowUpDown size={15} /><span>排序</span><select aria-label="岗位卡时间排序" value={resultSort} disabled={resultsLoading} onChange={(event) => {
                    const value = event.target.value as typeof resultSort
                    void draftGuard.requestTransition('更改结果排序', () => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultSort(value) })
                  }}><option value="newest">最新发布优先</option><option value="oldest">最早发布优先</option></select></label>
                  <label><CalendarClock size={15} /><span>时间</span><select aria-label="岗位卡时间筛选" value={resultTimeRange} disabled={resultsLoading} onChange={(event) => {
                    const value = event.target.value as typeof resultTimeRange
                    void draftGuard.requestTransition('更改结果筛选', () => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultTimeRange(value) })
                  }}><option value="all">全部时间</option><option value="1">近 24 小时</option><option value="3">近 3 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="unknown">日期待确认</option></select></label>
                  {(resultSort !== 'newest' || resultTimeRange !== 'all') && <button className="reset-result-filter" type="button" disabled={resultsLoading} onClick={() => void draftGuard.requestTransition('重置结果筛选', () => { draftViewRevisionRef.current += 1; setResultOffset(0); setResultSort('newest'); setResultTimeRange('all') })} title="恢复最新发布优先并显示全部时间"><RotateCcw size={15} />重置筛选</button>}
                <button className="complete-missing-button" type="button" disabled={!resultCompletionStats(results).total || completingMissing || submitting || restoringAi || resultsLoading} onClick={() => void completeMissingResults()} title={aiSession ? '从原任务检查点续采正文，正文落盘后再运行 AI 解析' : '自动恢复已保存的 AI 配置，续采正文后再解析'}>{restoringAi || completingMissing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{restoringAi ? '正在恢复 AI' : completingMissing ? '正在核对任务' : ['running', 'resuming', 'queued'].includes(activeJob?.status || '') ? '查看补全进度' : resultCompletionStats(results).sourcePending ? '续采正文并解析' : '一键智能补全'}</button>
                </div>
              </div>
              <div className="results-workspace">
                <div className="result-index">
                  <div className="result-index-head"><span>岗位列表</span><small>{resultOffset + 1}-{Math.min(resultOffset + results.items.length, results.total)} / {results.total}</small></div>
                  <div className="result-rows">
                    {results.items.map((item) => {
                      const routeLabels = deliveryRoutes(item).map((route) => route.label)
                      const missingJobBody = isIncompleteApplicationResult(item)
                      const draftQualityStale = !missingJobBody && item.draftVersion?.qualityStatus === 'stale'
                      const draftQualityUnchecked = !missingJobBody && hasUncheckedDraftQuality(item)
                      const draftQualityInvalidated = !missingJobBody && hasInvalidatedDraftQuality(item)
                      const draftQualityVerified = !missingJobBody && hasVerifiedDraftQuality(item)
                      const draftState = item.delivery?.action === 'email_sent'
                        ? '已发送'
                        : missingJobBody
                          ? '信息未完整'
                          : draftQualityVerified
                            ? '≥ 90'
                            : item.outreach?.runtime_status === 'fallback_model_error'
                              ? 'AI 失败 · 有初稿'
                              : item.draftVersion?.qualityStatus === 'failed'
                                ? '质量未通过'
                                : draftQualityInvalidated
                                  ? '质量失效'
                                  : draftQualityUnchecked
                                    ? '待质量检查'
                                    : '待重写'
                      return (
                        <div key={item.note_id} className={`result-row ${selectedResult?.note_id === item.note_id ? 'selected' : ''}`}>
                          <ResultCardMedia result={item} onPreview={(images, index) => openImagePreview(item.title || '未命名岗位', images, index)} />
                          <button className="result-card-select" type="button" onClick={() => chooseResult(item)} aria-label={`查看岗位：${item.title || '未命名岗位'}`}>
                            <span className="result-card-copy">
                            <span className="result-card-heading">
                              <strong>{item.title || '未命名岗位'}</strong>
                              <i className={item.delivery?.action === 'email_sent' ? 'sent' : draftQualityVerified ? 'ready' : ''}>{draftState}</i>
                            </span>
                            <small>{item.publish_time?.value || '日期待核验'} · {missingJobBody || draftQualityStale ? '-' : item.cover_letter_evaluation?.score ?? '-'} 分 · {routeLabels.length ? [...new Set(routeLabels)].join(' / ') : '投递方式待确认'}</small>
                            <small className={`result-card-body-status ${item.body?.trim() ? 'ready' : 'pending'}`}>{item.body?.trim() ? `正文已保存 · ${item.body.trim().replace(/\s+/gu, ' ').slice(0, 140)}${item.body.trim().length > 140 ? '…' : ''}` : '正文待续采'}</small>
                            </span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="result-pagination">
                    <button title="上一页" disabled={draftOperationPending || resultOffset === 0 || resultsLoading} onClick={() => void draftGuard.requestTransition('切换结果页', () => { draftViewRevisionRef.current += 1; if (activeJob) void loadResults(activeJob.id, Math.max(0, resultOffset - 20)) })}><ChevronLeft size={16} /></button>
                    <button title="下一页" disabled={draftOperationPending || resultOffset + results.limit >= results.total || resultsLoading} onClick={() => void draftGuard.requestTransition('切换结果页', () => { draftViewRevisionRef.current += 1; if (activeJob) void loadResults(activeJob.id, resultOffset + 20) })}><ChevronRight size={16} /></button>
                  </div>
                </div>
                {selectedResult ? (
                  <article className="result-detail">
                    <header>
                      <div><span>{selectedResult.publish_time?.value || '日期待核验'} · {selectedResult.job_card?.parse_basis === 'search_card' || !selectedResult.body ? '卡片信息兜底' : '正文解析'}</span><h3>{selectedResult.title || '未命名岗位'}</h3><small>采集时间 {formatTime(selectedResult.collected_at)} · 原始时间 {selectedResult.publish_time?.raw || '-'}</small></div>
                      {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer" title="打开原链接"><ExternalLink size={17} /></a>}
                    </header>
                    {selectedResultIncomplete && (
                      <div className="completion-callout">
                        <span><WandSparkles size={18} /><span><strong>该岗位信息尚未完整</strong><small>将从已保存检查点继续采集缺失正文，并重新执行图片理解、岗位卡整理和投递文案生成。</small></span></span>
                        <button type="button" disabled={completingMissing || submitting || restoringAi} title={aiSession ? '自动核对缺失项，并从原任务检查点继续' : '自动恢复已保存的 AI 配置并补全缺失项'} onClick={() => void completeMissingResults()}>{restoringAi ? '正在恢复 AI…' : completingMissing ? '正在核对任务…' : ['running', 'resuming', 'queued'].includes(activeJob?.status || '') ? '查看补全进度' : '一键补全全部缺失岗位'}</button>
                      </div>
                    )}
                    {Boolean(selectedResult.media?.images?.length) && (
                      <section className="result-media" aria-label="岗位图片与理解结果">
                        <div className="result-media-heading"><span><Images size={16} /><strong>采集图片</strong><small>{selectedResult.media?.images.length} 张</small></span><i>{imageAnalysisStatusLabel(selectedResult.media?.analysis?.source)}</i></div>
                        <div className="result-media-grid">
                          {selectedResult.media?.images.map((image, index) => <button key={`${image.url}-${index}`} type="button" onClick={() => openImagePreview(selectedResult.title || '未命名岗位', selectedResult.media?.images || [], index)} title={image.alt || `查看第 ${index + 1} 张岗位图片`}><RetryingImage image={image} alt={image.alt || `${selectedResult.title || '岗位'}图片 ${index + 1}`} loading="lazy" /><small>{imageSourceLabel(image.source)}</small><span><Maximize2 size={13} /></span></button>)}
                        </div>
                        <div className="image-analysis">
                          <strong>图片信息理解</strong>
                          <p>{selectedResult.media?.analysis?.summary || '已保存原图，当前模型尚未返回可验证的图片岗位信息。'}</p>
                          {Boolean(selectedResult.media?.analysis?.job_signals?.length) && <ul>{selectedResult.media?.analysis?.job_signals?.map((signal, index) => <li key={`${signal}-${index}`}>{signal}</li>)}</ul>}
                          {Boolean(selectedResult.media?.analysis?.visible_text?.trim()) && (
                            <div className="image-analysis-transcript">
                              <div>
                                <span><strong>图片识别正文</strong><small>按图片原有换行展示</small></span>
                                <button type="button" title="复制图片识别正文" aria-label="复制图片识别正文" onClick={() => copyText(selectedResult.media?.analysis?.visible_text?.trim() || '')}><Copy size={14} /></button>
                              </div>
                              <pre>{selectedResult.media?.analysis?.visible_text?.trim()}</pre>
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                    <div className="result-facts">
                      <section><h4>岗位职责</h4>{selectedResult.application_info.responsibilities.length ? <ul>{selectedResult.application_info.responsibilities.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>正文未识别到明确职责</p>}</section>
                      <section><h4>岗位要求</h4>{selectedResult.application_info.requirements.length ? <ul>{selectedResult.application_info.requirements.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>正文未识别到明确要求</p>}</section>
                      <section className="capability-section"><h4>关键能力</h4>{selectedResult.job_capabilities?.length ? <ul>{selectedResult.job_capabilities.map((item) => <li key={item.id}><strong>{item.capability}</strong><span>{item.why_it_matters}</span></li>)}</ul> : <p>等待 AI 提炼岗位能力</p>}</section>
                      <section className="route-section"><h4>AI 提取并复核的投递方式</h4>{selectedDeliveryRoutes.length ? <ul>{selectedDeliveryRoutes.map((route, index) => <li key={`${route.channel}-${route.target}-${index}`} className={route.actionable ? '' : 'needs-review'}><strong>{route.channel === 'email' ? <Mail size={14} /> : route.channel === 'direct_message' ? <MessageSquare size={14} /> : <ExternalLink size={14} />}{route.label}</strong><span><span className="route-target-row">{route.channel === 'link' && route.actionable ? <a href={route.target} target="_blank" rel="noreferrer">{route.target}<ExternalLink size={12} /></a> : <b>{route.target}</b>}<i className={route.actionable ? 'verified' : 'review'}>{routeVerificationLabel(route)}</i>{route.sourceImageIndex ? <button type="button" onClick={() => openImagePreview(selectedResult.title || '未命名岗位', selectedResult.media?.images || [], route.sourceImageIndex! - 1)}>查看图 {route.sourceImageIndex}</button> : null}</span><small>{route.confidence !== undefined ? `AI 置信度 ${route.confidence}% · ` : ''}{route.evidence || routeVerificationLabel(route)}</small></span></li>)}</ul> : <p>{selectedResult.media?.analysis?.application_requested_in_image ? '原文提示投递方式见图，但图片中没有识别到足够清晰的邮箱或链接，请打开原图人工核对。' : '原文未提供明确投递方式，发送操作保持关闭。'}</p>}</section>
                      <section className="body-section full-body-section" aria-label="采集正文">
                        <div className="body-section-heading"><span><FileText size={14} /><h4>采集正文</h4><small>{selectedResult.body?.trim() ? `${selectedResult.body.trim().length} 字 · 已保存` : '尚未采集'}</small></span><button type="button" title="复制采集正文" aria-label="复制采集正文" disabled={!selectedResult.body?.trim()} onClick={() => copyText(selectedResult.body?.trim() || '')}><Copy size={14} /></button></div>
                        {selectedResult.body?.trim() ? <pre className="body-text-block">{selectedResult.body.trim()}</pre> : <p className="body-empty">正文尚未采集；卡片和图片结果仍已保留，可从“续采正文并解析”继续。</p>}
                      </section>
                    </div>
                    <div className="draft-stack">
                      <div className="draft-toolbar">
                        <div><span className="step-label">EDITABLE APPLICATION COPY</span><h4>投递文案编辑器</h4><p>每个岗位均生成可编辑初稿；90 分以上方可发送，发送时使用当前内容。</p></div>
                        <button className={draftDirty ? 'dirty' : ''} disabled={draftOperationPending || (!draftDirty && !selectedDraftQualityRetryable)} onClick={() => void draftGuard.saveNow()}>{draftSaving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{draftSaveLabel}</button>
                      </div>
                      <div className="draft-context-row" aria-label="投递上下文">
                        <label><span>文案语气</span><select aria-label="投递语气" value={selectedApplicationTone} disabled={draftOperationPending} onChange={(event) => changeApplicationTone(event.target.value as ApplicationTone)}><option value="formal">正式</option><option value="natural">自然</option><option value="concise">精简</option></select></label>
                        <p><strong>{selectedApplicationContext.channel === 'email' ? '邮件' : '私信'}</strong><span>{selectedApplicationContext.contactStage === 'follow_up' ? '跟进联系' : '首次联系'} · {selectedRecipientTypeLabel} · {selectedApplicationContext.resumeAttached ? '已附简历' : '未附简历'} · {selectedApplicationContext.coverLetterAttached ? '已附 Cover Letter' : '未附 Cover Letter'}</span></p>
                      </div>
                      <section className="draft-editor"><div><h4><MessageSquare size={15} />私信文案</h4><button title="复制私信文案" disabled={draftOperationPending} onClick={() => copyText(outreachDraft(selectedResult).greeting)}><Copy size={15} /></button></div><textarea aria-label="私信文案" value={outreachDraft(selectedResult).greeting} disabled={draftOperationPending} onChange={(event) => updateDraft('greeting', event.target.value)} rows={4} /><small>{outreachDraft(selectedResult).greeting.length} 字</small></section>
                      <section className="draft-editor email-editor">
                        <div><h4><Mail size={15} />邮件文案</h4><button title={selectedSubjectNeedsReview ? '请先补全准确岗位名并重新生成邮件主题' : '复制投递邮件'} disabled={draftOperationPending || selectedSubjectNeedsReview} onClick={() => copyText(`${outreachDraft(selectedResult).email_subject}\n\n${outreachDraft(selectedResult).email_body}`)}><Copy size={15} /></button></div>
                        <label><span>邮件主题</span><input aria-label="邮件主题" value={outreachDraft(selectedResult).email_subject} disabled={draftOperationPending} onChange={(event) => updateDraft('email_subject', event.target.value)} /></label>
                        {selectedSubjectNeedsReview && <p className="email-subject-review">原帖标题已排除；请补全准确岗位名并重新生成，当前主题不会进入投递。</p>}
                        <label><span>邮件正文（实际发送）</span><textarea aria-label="邮件正文" value={outreachDraft(selectedResult).email_body} disabled={draftOperationPending} onChange={(event) => updateDraft('email_body', event.target.value)} rows={7} /></label>
                        <small>{outreachDraft(selectedResult).email_body.length} 字</small>
                      </section>
                      <section className="draft-editor cover-letter-editor">
                        <div>
                          <h4><FileText size={15} />专属 Cover Letter</h4>
                          <span className="cover-letter-heading-actions">
                            <button type="button" className="cover-letter-rewrite-toggle" title="输入要求并选择高级或本地模型重写" aria-label="AI 重写求职信" aria-expanded={coverLetterRewriteOpen} disabled={draftOperationPending} onClick={() => { setCoverLetterRewriteOpen((current) => !current); setCoverLetterRewriteError('') }}><WandSparkles size={15} />AI 重写</button>
                            <button type="button" title="复制 Cover Letter" aria-label="复制求职信" disabled={draftOperationPending} onClick={() => copyText(outreachDraft(selectedResult).cover_letter)}><Copy size={15} /></button>
                          </span>
                        </div>
                        {coverLetterRewriteOpen && <form className="cover-letter-rewrite-panel" aria-label="Cover Letter AI 重写" onSubmit={(event) => { event.preventDefault(); void rewriteCoverLetter() }}>
                          <div className="cover-letter-model-row">
                            <div className="cover-letter-model-mode" role="group" aria-label="Cover Letter 重写模型">
                              <button type="button" className={coverLetterUseLocalModel ? '' : 'active'} disabled={coverLetterRewriting} aria-pressed={!coverLetterUseLocalModel} onClick={() => setCoverLetterUseLocalModel(false)}><BrainCircuit size={14} />当前模型</button>
                              <button type="button" className={coverLetterUseLocalModel ? 'active' : ''} disabled={coverLetterRewriting || !coverLetterLocalReady} aria-pressed={coverLetterUseLocalModel} onClick={() => setCoverLetterUseLocalModel(true)}><Cpu size={14} />本地模型</button>
                            </div>
                            {coverLetterUseLocalModel && <label className="cover-letter-local-model"><span className="sr-only">Cover Letter 本地模型</span><select aria-label="Cover Letter 本地模型" value={selectedCoverLetterLocalModel} disabled={coverLetterRewriting || !coverLetterLocalReady} onChange={(event) => setLocalModelChoice(event.target.value)}>{installedLocalModelNames.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}
                            <small>{coverLetterUseLocalModel
                              ? coverLetterLocalReady ? `local_qwen / ${selectedCoverLetterLocalModel} · 岗位规划 + 成稿 + 本地终审` : '本地运行器或模型未就绪'
                              : aiSession && aiSessionMatchesSelection(aiSession) ? `${aiSession.provider} / ${aiSession.model}` : '提交时恢复当前模型会话'}</small>
                          </div>
                          <label><span>本次重写要求（可选）</span><textarea aria-label="Cover Letter 重写要求" value={coverLetterRewriteInstructions} disabled={coverLetterRewriting} maxLength={2000} rows={3} placeholder="例如：重点突出内容运营与剪辑经验，语气自然，详细回应前两项岗位职责。" onChange={(event) => setCoverLetterRewriteInstructions(event.target.value)} /></label>
                          <div className="cover-letter-rewrite-submit">
                            <small>{coverLetterUseLocalModel ? `将真实调用本地 ${selectedCoverLetterLocalModel || '模型'}` : aiSession && aiSessionMatchesSelection(aiSession) ? `将真实调用 ${aiSession.provider} / ${aiSession.model}` : '提交时将恢复当前已配置的模型会话'} · 最少 {COVER_LETTER_MIN_NON_WHITESPACE_CHARS} 个非空白字符</small>
                            <button type="submit" disabled={coverLetterRewriting || !selectedResult.draftVersion || (coverLetterUseLocalModel && !coverLetterLocalReady)}>{coverLetterRewriting ? <LoaderCircle className="spin" size={15} /> : coverLetterUseLocalModel ? <Cpu size={15} /> : <WandSparkles size={15} />}{coverLetterRewriting ? coverLetterUseLocalModel ? '本地模型重写中' : '模型重写中' : '立即重写'}</button>
                          </div>
                          {coverLetterRewriteError && <p className="cover-letter-rewrite-error" role="alert"><CircleAlert size={14} />{coverLetterRewriteError}</p>}
                        </form>}
                        <textarea aria-label="Cover Letter" value={outreachDraft(selectedResult).cover_letter} disabled={draftOperationPending} onChange={(event) => updateDraft('cover_letter', event.target.value)} rows={18} />
                        <small className={selectedCoverLetterCharacterCount < COVER_LETTER_MIN_NON_WHITESPACE_CHARS ? 'length-warning' : ''}>{selectedCoverLetterCharacterCount} 个非空白字符 · {selectedCoverLetterCharacterCount < COVER_LETTER_MIN_NON_WHITESPACE_CHARS ? `未达到 ${COVER_LETTER_MIN_NON_WHITESPACE_CHARS} 字最低要求` : `已达到 ${COVER_LETTER_MIN_NON_WHITESPACE_CHARS} 字要求`} · 发送仍需通过 90 分门槛</small>
                      </section>
                    </div>
                    <section className="attachment-workspace" aria-label="投递附件">
                      <input ref={attachmentInputRef} className="attachment-file-input" type="file" multiple accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" onInput={(event) => void uploadAttachmentFiles(event)} />
                      <header>
                        <div><span className="step-label">APPLICATION ATTACHMENTS</span><h4><Paperclip size={15} />随信附件</h4><p>附件保存在当前任务与岗位下，发送前仍会重新校验文件内容和哈希。</p></div>
                        <strong>{selectedAttachments.length} / {applicationAttachments?.limits.maxFiles ?? 5} 个 · {formatBytes(selectedAttachmentBytes)}</strong>
                      </header>
                      <div className="attachment-source-actions">
                        <button type="button" disabled={attachmentUploading} onClick={() => chooseAttachmentFiles('uploaded')}><Upload size={15} />上传文件</button>
                        <div className="artifact-attachment-picker candidate-attachment-picker"><select aria-label="选择候选人资料附件" value={selectedProfileAttachmentSource} disabled={attachmentUploading || profileResumeSources.length === 0} onChange={(event) => setProfileAttachmentSource(event.target.value)}><option value="">{activeProfile ? '档案中没有可用简历' : '请先选择候选人档案'}</option>{profileResumeSources.map((source) => <option key={source} value={source}>{source.replace(/^\d{2}-/, '')}</option>)}</select><button type="button" disabled={attachmentUploading || !selectedProfileAttachmentSource} onClick={() => void importCandidateProfileAttachment()}><FileText size={15} />加入简历</button></div>
                        <button type="button" disabled={attachmentUploading || draftDirty || selectedDraftQualityStale || !selectedResult.draftVersion || !outreachDraft(selectedResult).cover_letter.trim()} title={draftDirty || selectedDraftQualityStale ? '请先保存并复检 Cover Letter，再导出已保存版本' : '将已保存的 Cover Letter 导出为附件'} onClick={() => void exportCoverLetterAttachment()}><Download size={15} />导出 Cover Letter</button>
                        {importableArtifacts.length > 0 && <div className="artifact-attachment-picker"><select aria-label="选择任务产物" value={artifactAttachmentId} onChange={(event) => setArtifactAttachmentId(event.target.value)}><option value="">选择任务产物</option>{importableArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}</select><button type="button" disabled={attachmentUploading || !artifactAttachmentId} onClick={() => void importJobArtifact()}><Paperclip size={15} />加入</button></div>}
                      </div>
                      {attachmentsLoading ? <div className="attachment-empty"><LoaderCircle className="spin" size={18} />正在读取附件</div> : applicationAttachments?.attachments.length ? <ul className="attachment-list">{applicationAttachments.attachments.map((attachment) => <li key={attachment.attachmentId} className={attachment.selected ? 'selected' : ''}>
                        <label title={attachment.selected ? '本次发送包含此附件' : '本次发送不包含此附件'}><input type="checkbox" checked={attachment.selected} disabled={attachmentUploading || attachment.status !== 'ready'} onChange={(event) => void updateAttachmentSelection(attachment, event.target.checked)} /><span /></label>
                        <span className="attachment-file-icon">{attachmentTypeIcon(attachment)}</span>
                        <span className="attachment-file-copy"><strong title={attachment.displayName}>{attachment.displayName}</strong><small>{formatBytes(attachment.size)} · {attachment.source === 'candidate_profile' ? '候选人资料' : attachment.source === 'job_artifact' ? '任务产物' : attachment.source === 'generated_cover_letter' ? 'Cover Letter' : attachment.source === 'generated_resume' ? '生成简历' : '本地上传'} · {attachmentStatusLabel(attachment)}</small></span>
                        <span className="attachment-row-actions">
                          <a href={activeJob ? api.applicationAttachmentUrl(activeJob.id, attachment.attachmentId) : '#'} target="_blank" rel="noreferrer" title="预览附件" aria-label={`预览 ${attachment.displayName}`}><Eye size={15} /></a>
                          <a href={activeJob ? api.applicationAttachmentUrl(activeJob.id, attachment.attachmentId) : '#'} download={attachment.displayName} title="下载附件" aria-label={`下载 ${attachment.displayName}`}><Download size={15} /></a>
                          <button type="button" disabled={attachmentUploading} onClick={() => chooseAttachmentFiles(attachment.source, attachment.attachmentId)} title="替换附件" aria-label={`替换 ${attachment.displayName}`}><RefreshCw size={15} /></button>
                          <button type="button" disabled={attachmentUploading} onClick={() => void removeApplicationAttachment(attachment)} title="删除附件" aria-label={`删除 ${attachment.displayName}`}><Trash2 size={15} /></button>
                        </span>
                      </li>)}</ul> : <div className="attachment-empty"><Paperclip size={20} /><span>尚未添加附件；附件集合变化后需要重新执行质量检查。</span></div>}
                      <footer><span>单个不超过 {formatBytes(applicationAttachments?.limits.maxFileBytes ?? 10 * 1024 * 1024)}，合计不超过 {formatBytes(applicationAttachments?.limits.maxTotalBytes ?? 20 * 1024 * 1024)}</span>{attachmentUploading && <strong><LoaderCircle className="spin" size={14} />正在校验并保存</strong>}</footer>
                    </section>
                    <div className="evaluation-panel">
                      <div><span>用人单位评分</span><strong>{selectedDraftQualityStale ? '-' : selectedResult.cover_letter_evaluation?.score ?? '-'}<small>/ 100</small></strong></div>
                      <div><span>重写轮次</span><strong>{selectedDraftQualityStale ? '-' : selectedResult.cover_letter_evaluation?.attempts ?? '-'}</strong></div>
                      <p>{selectedDraftQualityModelFallback
                        ? 'AI 生成曾失败，已保留可编辑初稿；请点击运行质量检查。'
                        : selectedDraftQualityUnchecked
                          ? '当前首版草稿尚未执行质量检查，请点击运行质量检查。'
                          : selectedDraftQualityStale
                            ? '草稿内容已变化，旧评分已经失效；请重新执行质量检查。'
                            : selectedResult.cover_letter_evaluation?.passed
                              ? '已通过 90 分投递门槛'
                              : (selectedResult.cover_letter_evaluation?.problems || []).join('；') || '等待评分'}</p>
                      {!selectedDraftQualityStale && selectedResult.cover_letter_evaluation?.human_quality && <div className="human-quality-grid" aria-label="真人化质量维度">
                        {Object.entries(selectedResult.cover_letter_evaluation.human_quality).map(([key, item]) => <span key={key} className={item.passed ? 'passed' : 'failed'} title={item.passed ? (item.evidence || []).join('；') : [...(item.problems || []), item.suggestedFix].filter(Boolean).join('；')}><small>{humanQualityLabels[key] || key}</small><strong>{item.score}</strong></span>)}
                      </div>}
                    </div>
                    <div className="delivery-console">
                      <div className="delivery-target">
                        <span className={selectedEmailRoute ? 'available' : ''}><Mail size={17} /></span>
                        <div><small>邮件收件人</small><strong>{selectedEmailRoute?.target || '岗位正文未提取到邮箱'}</strong><p>{health?.emailDelivery?.configured ? `${health.emailDelivery.authMode === 'oauth2' ? 'Outlook OAuth2' : 'SMTP'} 已就绪 · 发件人 ${health.emailDelivery.from}` : '发件邮箱尚未配置，可在当前页面保存并测试后立即启用'}</p></div>
                      </div>
                      <div className="delivery-actions">
                        <button className="send-email-action" disabled={draftDirty || !selectedDraftQualityVerified || selectedSubjectNeedsReview || !selectedEmailRoute || !health?.emailDelivery?.configured || !smtpConfig?.verified || draftOperationPending || attachmentUploading || attachmentsLoading} onClick={() => void sendEmail()} title={selectedSubjectNeedsReview ? '邮件主题正在等待准确岗位名复核' : !selectedEmailRoute ? '岗位正文中没有可验证邮箱' : !health?.emailDelivery?.configured ? '请先配置 SMTP' : !smtpConfig?.verified ? '请先测试 SMTP' : attachmentsLoading ? '正在读取当前岗位附件' : '预览收件人、完整正文与附件后发送'}>{emailSending ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />}{emailSending ? '生成预览' : '预览并发送'}</button>
                        <button onClick={() => document.getElementById('email-config')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={16} />发件邮箱</button>
                        <button disabled={draftDirty || !selectedDraftQualityVerified || !selectedMessageRoute || draftOperationPending} onClick={() => void prepareMessage()}><MessageSquare size={16} />复制私信</button>
                        {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开岗位</a>}
                      </div>
                    </div>
                    <footer><span>生成方式：<strong>{selectedResult.delivery?.generation?.provider && selectedResult.delivery?.generation?.model ? `${selectedResult.delivery.generation.provider} / ${selectedResult.delivery.generation.model}` : selectedResult.outreach?.generation_mode || '-'}</strong></span><span>当前状态：<strong>{deliveryStatusLabel(selectedResult.delivery?.email?.status || selectedResult.delivery?.action)}</strong></span>{selectedResult.delivery?.email?.sentAt && <span>发送时间：<strong>{formatTime(selectedResult.delivery.email.sentAt)}</strong></span>}</footer>
                  </article>
                ) : <div className="result-empty"><FileText size={28} /><strong>选择一个岗位查看详情</strong></div>}
              </div>
              </>
            ))}</>)}
          </section>

          <div className="secondary-grid">
            <section className="panel history-panel" id="history">
              <div className="panel-heading compact">
                <div><span className="step-label">RUN HISTORY</span><h2>全部历史任务 <small>{historyJobs.length}</small></h2></div>
                <div className="history-heading-actions">
                  <span>已保存 {jobs.length} 条任务</span>
                  <button className="icon-text-button" disabled={dataManaging} onClick={() => void draftGuard.requestTransition('删除当前任务或本地数据', manageLocalData)}>{dataManaging ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}本地数据</button>
                  <button className="icon-text-button" disabled={dataManaging || jobsRefreshing} onClick={() => void loadJobs()}>{jobsRefreshing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{jobsRefreshing ? '正在刷新状态…' : '刷新状态'}</button>
                </div>
              </div>
              <div className={`featured-job-banner ${featuredJob ? '' : 'missing'}`}>
                <div className="featured-job-copy">
                  <span className="featured-job-label"><Target size={14} />竞赛演示任务</span>
                  <strong>AI 产品经理招聘 · 最新 Relay 抓取</strong>
                  <small>{featuredJob ? `关键词：${featuredJob.keyword} · ${featuredStateLabel} · 任务 ${featuredJob.id}` : '迁移数据后将自动显示指定历史任务'}</small>
                </div>
                {featuredJob && <div className="featured-job-stats">
                  <span><b>{featuredDiscovered}</b><small>发现</small></span>
                  <span><b>{featuredBodies}</b><small>正文</small></span>
                  <span><b>{featuredDrafts}</b><small>投递文案</small></span>
                  <span><b>{featuredPending}</b><small>待补全</small></span>
                </div>}
                <div className="featured-job-action">
                  {featuredJob && <StatusPill status={featuredJob.status} label={featuredStateLabel} />}
                  <button type="button" className="secondary-button" onClick={openFeaturedJob} disabled={!featuredJob}><Target size={15} />打开演示任务</button>
                </div>
              </div>
              <div className="history-scope-control" aria-label="历史任务类型筛选">
                <button type="button" className={historyScope === 'all' ? 'active' : ''} aria-pressed={historyScope === 'all'} onClick={() => setHistoryScope('all')}>全部 <strong>{jobs.length}</strong></button>
                <button type="button" className={historyScope === 'job' ? 'active' : ''} aria-pressed={historyScope === 'job'} onClick={() => setHistoryScope('job')}>岗位投递 <strong>{historyModeCounts.job}</strong></button>
                <button type="button" className={historyScope === 'general' ? 'active' : ''} aria-pressed={historyScope === 'general'} onClick={() => setHistoryScope('general')}>内容采集 <strong>{historyModeCounts.general}</strong></button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>状态</th><th>关键词</th><th>创建时间（北京时间）</th><th>范围</th><th>产物</th><th>操作</th></tr></thead>
                  <tbody>
                    {visibleHistoryJobs.length ? visibleHistoryJobs.map((job) => {
                      const retryFailedJob = job.status === 'failed'
                      return <tr key={job.id} className={activeJob?.id === job.id ? 'selected-row' : ''} onClick={() => openHistoryJob(job)}>
                        <td><StatusPill status={job.status} /></td><td><strong>{job.keyword || '未命名任务'}</strong><small>{jobAnalysisMode(job) === 'general' ? '内容采集' : '岗位投递'} · #{job.id.slice(0, 8)}</small></td><td>{formatTime(job.createdAt)}</td><td>{job.config?.limit === 0 ? `全量 · ${job.config?.maxAgeDays ? `近 ${job.config.maxAgeDays} 天` : '不限时间'}` : `历史限定 ${job.config?.limit ?? '-'} 篇`} · {job.config?.searchSort === 'comprehensive' ? '综合' : '最新'}</td><td>{job.artifactCount ?? job.artifacts?.length ?? 0}</td><td>{job.resumeAvailable ? <button className="row-resume" title={retryFailedJob ? '从检查点重试' : '从检查点续跑'} onClick={(event) => { event.stopPropagation(); void resumeJob(job) }} disabled={submitting}><RotateCcw size={14} />{retryFailedJob ? '重试' : '续跑'}</button> : <button className="row-open" title="查看任务"><ChevronDown size={15} /></button>}</td>
                      </tr>
                    }) : <tr className="empty-row"><td colSpan={6}>{loading ? '正在读取任务记录...' : historyScope === 'all' ? '还没有历史任务' : historyScope === 'general' ? '还没有内容采集任务' : '还没有岗位投递任务'}</td></tr>}
                  </tbody>
                </table>
              </div>
              {historyJobs.length > 0 && <div className="history-pagination">
                <span>显示 {historyStart + 1}-{Math.min(historyStart + effectiveHistoryPageSize, historyJobs.length)} / {historyJobs.length}</span>
                <div className="history-page-controls">
                  <label>每页
                    <select value={historyPageSize} onChange={(event) => setHistoryPageSize(Number(event.target.value))} aria-label="每页显示任务数">
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={0}>全部</option>
                    </select>
                  </label>
                  <button type="button" title="上一页" aria-label="上一页" disabled={currentHistoryPage <= 1} onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}><ChevronLeft size={16} /></button>
                  <strong>{currentHistoryPage} / {historyPageCount}</strong>
                  <button type="button" title="下一页" aria-label="下一页" disabled={currentHistoryPage >= historyPageCount} onClick={() => setHistoryPage((current) => Math.min(historyPageCount, current + 1))}><ChevronRight size={16} /></button>
                </div>
              </div>}
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
      <DataCopilotPanel
        key={`${activeJob?.id || 'unbound'}:${dataCopilotMode}`}
        open={dataCopilotOpen && Boolean(activeJob)}
        transport={dataCopilotTransport}
        models={dataCopilotModels}
        defaultModelId={aiSession?.id}
        modelProviders={providers}
        defaultModelProviderId={providerId}
        onDiscoverModels={discoverDataCopilotModels}
        onConnectModel={connectDataCopilotModel}
        contextSources={dataCopilotSources}
        defaultContextSourceIds={dataCopilotSources.map((source) => source.id)}
        contextMeta={{
          taskId: activeJob?.id,
          taskLabel: activeJob?.keyword || '当前任务',
          mode: dataCopilotMode === 'application' ? '岗位任务' : '非岗位任务',
          snapshotId: dataCopilotSnapshotId,
          filters: [],
        }}
        title="数据 Copilot"
        onClose={() => setDataCopilotOpen(false)}
        onError={(error) => setNotice(error.message)}
      />
      {imagePreview && <ImagePreview preview={imagePreview} onClose={closeImagePreview} onChange={changePreviewImage} />}
      {emailPreview && <EmailSendPreview preview={emailPreview} sending={emailSending} onClose={() => setEmailPreview(null)} onConfirm={() => void confirmSendEmail()} />}
      {draftGuard.pendingTransition && <UnsavedDraftDialog
        reason={draftGuard.pendingTransition.reason}
        saveStatus={draftGuard.saveStatus}
        onSave={() => void draftGuard.saveAndContinue()}
        onDiscard={() => void draftGuard.discardAndContinue()}
        onCancel={() => void draftGuard.cancelTransition()}
      />}
    </div>
  )
}

export default App
