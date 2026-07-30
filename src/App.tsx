import { Component, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import {
  Activity,
  Archive,
  ArrowUpDown,
  BellRing,
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
  FileJson,
  FileSpreadsheet,
  FileText,
  Gauge,
  Images,
  BrainCircuit,
  BookOpenCheck,
  KeyRound,
  LoaderCircle,
  Mail,
  Maximize2,
  MessageSquare,
  Copy,
  Cpu,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  SquareTerminal,
  Table2,
  Target,
  Send,
  Upload,
  UserRoundSearch,
  Wifi,
  WifiOff,
  WandSparkles,
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
  RelayRecoveryResult,
  RelayConfig,
  AiProviderOption,
  AiSession,
  CandidateProfile,
  CandidateApplicationProfile,
  ApplicationRoute,
  OutreachDraft,
  LocalModelStatus,
  SmtpAuthMode,
  SmtpConfig,
  SmtpProvider,
  AnalysisMode,
  ContentResearchPreset,
} from './types'

const CANDIDATE_PROFILE_STORAGE_KEY = 'xhs-candidate-application-profile'
const CUSTOM_MODEL_OPTION = '__custom_model__'

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
  maxAgeDays: 0,
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
  running: '进行中',
  completed: '已完成',
  incomplete: '未完成 · 可续跑',
  failed: '执行失败',
  cancelled: '未完成 · 已取消',
  interrupted: '未完成 · 已中断',
}

const progressByStatus: Record<JobStatus, number> = {
  queued: 4,
  running: 48,
  completed: 100,
  incomplete: 82,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
}

const jobAgentStages = [
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

const generalAgentStages = [
  { name: '全量正文 Agent', description: '滚动到结果稳定，逐篇打开并保存正文与原图', matcher: /全量正文|body|正文|scrape/i },
  { name: '时间归一化 Agent', description: '统一相对时间、发布日期与采集时间', matcher: /时间归一化|time.?normal/i },
  { name: '关键词蓝图 Agent', description: '根据关键词和真实样本生成本次专属分析栏目', matcher: /keyword.?blueprint|关键词蓝图/i },
  { name: '图片与正文 Agent', description: '读取原文并用视觉模型转录、理解采集图片', matcher: /image.?and.?content|图片与正文|ocr/i },
  { name: '动态栏目 Agent', description: '按 AI 生成的页面蓝图逐条组织内容模块', matcher: /dynamic.?module|动态栏目/i },
  { name: 'AI 内容分析 Agent', description: '围绕关键词提炼事实、观点、实体与图片线索', matcher: /content.?analysis|内容分析/i },
  { name: '内容质量 Agent', description: '检查证据、关键词相关性和图片理解完整度', matcher: /content.?quality|内容质量/i },
  { name: '质量门禁 Agent', description: '检查采集覆盖、分析覆盖和缺失原因', matcher: /质量门禁|quality.?gate|verify/i },
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
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

type PreviewImage = {
  url: string
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
    ...(result.media?.cover_url ? [{ url: result.media.cover_url, alt: `${result.title || '内容'}封面`, source: 'cover' }] : []),
    ...(result.media?.images || []),
  ]
  return candidates.filter((image, index) => image.url && candidates.findIndex((candidate) => candidate.url === image.url) === index)
}

function imageSourceLabel(source?: string) {
  return source === 'detail' ? '正文图片' : source === 'cover' ? '封面' : source === 'card' ? '搜索卡片' : '内容图片'
}

function ResultCardMedia({ result, onPreview, noun = '岗位' }: { result: ApplicationResult; onPreview: (images: PreviewImage[], index: number) => void; noun?: string }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([])
  const images = useMemo(() => resultImages(result), [result])
  const preview = images.find((image) => !failedUrls.includes(image.url))
  const previewIndex = preview ? images.findIndex((image) => image.url === preview.url) : -1

  if (preview) {
    return (
      <button className="result-card-media has-image" type="button" aria-label={`在当前页面查看${result.title || noun}的图片`} onClick={() => onPreview(images, previewIndex)}>
        <img
          src={preview.url}
          alt={preview.alt || `${result.title || noun}图片`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrls((current) => current.includes(preview.url) ? current : [...current, preview.url])}
        />
        <span className="result-card-media-open"><Maximize2 size={12} /></span>
        <span className="result-card-media-count"><Images size={11} />{images.length}</span>
      </button>
    )
  }

  return (
    <span className="result-card-media is-empty" aria-label={images.length ? `${images.length} 张${noun}图片暂不可用` : `暂无${noun}图片`}>
      <span className="result-card-media-empty"><Images size={19} /><small>{images.length ? '图片暂不可用' : `暂无${noun}图片`}</small></span>
    </span>
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
          <img src={current.url} alt={current.alt || `${preview.title}图片 ${preview.index + 1}`} referrerPolicy="no-referrer" />
          {multiple && <button className="image-preview-nav next" type="button" onClick={() => onChange((preview.index + 1) % preview.images.length)} title="下一张" aria-label="下一张图片"><ChevronRight size={24} /></button>}
        </div>
        {multiple && (
          <div className="image-preview-strip" aria-label="图片列表">
            {preview.images.map((image, index) => (
              <button key={`${image.url}-${index}`} className={index === preview.index ? 'active' : ''} type="button" onClick={() => onChange(index)} aria-label={`查看第 ${index + 1} 张图片`} aria-current={index === preview.index ? 'true' : undefined}>
                <img src={image.url} alt="" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        )}
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
  actionable: boolean
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
  const metadata = {
    sourceField: String(route.source_field || route.source_fields?.join('+') || 'body'),
    sourceImageIndex: route.source_image_index,
    sourceImageUrl: route.source_image_url,
    verificationStatus: route.verification_status,
    actionable: route.actionable !== false,
  }
  if (emails.length) {
    return emails.map((target) => ({ channel: 'email', label: '邮件投递', target, evidence: evidence || value, confidence: route.confidence, ...metadata }))
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
  if (route.verificationStatus === 'image_format_verified') return '图中识别 · 格式已复核'
  if (route.verificationStatus === 'needs_manual_review') return '图中识别 · 待人工核对'
  if (route.sourceField.includes('image')) return '来自岗位图片'
  return '来自岗位正文'
}

function outreachDraft(result: ApplicationResult): OutreachDraft {
  const outreach = result.outreach ?? {}
  return {
    greeting: outreach.greeting || '',
    email_subject: outreach.email_subject || '',
    email_body: outreach.email_body || '',
    cover_letter: outreach.cover_letter || '',
  }
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

function progressUpdateAge(value: string | null | undefined, now: Date) {
  if (!value) return '等待首条进度'
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000))
  if (seconds < 3) return '刚刚更新'
  if (seconds < 60) return `${seconds} 秒前更新`
  return `${Math.floor(seconds / 60)} 分钟前更新`
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
    discovered: pickNumber(index, ['discovered_count', 'discovered', 'discoveredNotes', 'searchCards']),
    bodyAttempted: pickNumber(index, ['record_count', 'bodyAttempted', 'attempted', 'detailAttempted']),
    bodySucceeded: pickNumber(index, ['body_count', 'bodySucceeded', 'fullBodies', 'detailSucceeded']),
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
  const selectedImages = selectedResult ? resultImages(selectedResult) : []
  const resultItems = Array.isArray(results.items) ? results.items : []
  const resultStats = resultFilterStats(results)
  return (
    <>
      {results.research ? <section className="content-research-context" aria-label="本次非岗位研究设定">
        <span className="content-research-context-icon"><BrainCircuit size={20} /></span>
        <span className="content-research-context-copy"><small>NON-JOB RESEARCH BRIEF</small><strong>{results.research.label}</strong><p>{results.research.goal || 'AI 将结合关键词、正文、图片和 OCR，动态决定本次研究栏目。'}</p></span>
        <span className="content-research-context-keyword"><small>搜索关键词</small><strong>{results.keyword || '未记录'}</strong></span>
      </section> : null}
      <div className="results-control-bar general-results-controls">
        <div className="result-stats" aria-label="内容统计">
          <span><strong>{resultStats.all}</strong>全部内容</span>
          <span className={(resultSort !== 'newest' || resultTimeRange !== 'all') ? 'active-filter-stat' : ''}><strong>{results.total}</strong>筛选结果</span>
          <span className={resultStats.incomplete ? 'warning' : ''}><strong>{resultStats.incomplete}</strong>待 AI 补全</span>
          <span><strong>{resultStats.withImages}</strong>含图片</span>
          <span><strong>{resultStats.unknown}</strong>日期待确认</span>
        </div>
        <div className="result-controls" aria-busy={resultsLoading}>
          <label><ArrowUpDown size={15} /><span>排序</span><select aria-label="内容时间排序" value={resultSort} disabled={resultsLoading} onChange={(event) => onSort(event.target.value as 'newest' | 'oldest')}><option value="newest">最新发布优先</option><option value="oldest">最早发布优先</option></select></label>
          <label><CalendarClock size={15} /><span>时间</span><select aria-label="内容时间筛选" value={resultTimeRange} disabled={resultsLoading} onChange={(event) => onTimeRange(event.target.value as ApplicationResultsResponse['filters']['timeRange'])}><option value="all">全部时间</option><option value="1">近 24 小时</option><option value="3">近 3 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="unknown">日期待确认</option></select></label>
          {(resultSort !== 'newest' || resultTimeRange !== 'all') && <button className="reset-result-filter" type="button" disabled={resultsLoading} onClick={onReset}><RotateCcw size={15} />重置筛选</button>}
          <button className="complete-missing-button" type="button" disabled={!resultStats.incomplete || completingMissing || resultsLoading} onClick={onComplete}>{completingMissing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{completingMissing ? '正在核对任务' : '补全缺失分析'}</button>
        </div>
      </div>
      <div className="results-workspace general-content-workspace">
        <div className="result-index">
          <div className="result-index-head"><span>内容列表</span><small>{results.total ? resultOffset + 1 : 0}-{Math.min(resultOffset + resultItems.length, results.total)} / {results.total}</small></div>
          <div className="result-rows">
            {resultItems.map((item) => {
              const itemAnalysis = item.content_analysis
              const score = Number(itemAnalysis?.relevance_score || 0)
              const ready = Boolean(itemAnalysis?.overview && itemAnalysis.modules?.length)
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
          <header><div><span>{selectedResult.publish_time?.value || '日期待核验'} · {analysis?.content_type || '内容类型待识别'}</span><h3>{selectedResult.title || '未命名内容'}</h3><small>采集时间 {formatTime(selectedResult.collected_at)} · 与“{results.keyword}”相关度 {analysis?.relevance_score ?? '-'} / 100</small></div>{selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer" title="打开原链接"><ExternalLink size={17} /></a>}</header>
          {selectedImages.length > 0 && <section className="result-media" aria-label="采集图片与 AI 理解结果">
            <div className="result-media-heading"><span><Images size={16} /><strong>采集图片</strong><small>{selectedImages.length} 张</small></span><i>{selectedResult.media?.analysis?.source === 'vision_model' ? 'AI 已看图' : '等待视觉模型理解'}</i></div>
            <div className="result-media-grid">{selectedImages.map((image, index) => <button key={`${image.url}-${index}`} type="button" onClick={() => onPreview(selectedResult.title || '未命名内容', selectedImages, index)} title={image.alt || `查看第 ${index + 1} 张图片`}><img src={image.url} alt={image.alt || `${selectedResult.title || '内容'}图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /><small>{imageSourceLabel(image.source)}</small><span><Maximize2 size={13} /></span></button>)}</div>
            <AiSectionBoundary resetSignal={selectedResult.media?.analysis} fallback={<AiSectionUnavailable label="图片理解" />}>
              <div className="image-analysis"><strong>图片信息理解</strong><p>{selectedResult.media?.analysis?.summary || '已保存原图，等待视觉模型读取。'}</p>{selectedResult.media?.analysis?.visible_text?.trim() && <div className="image-analysis-transcript"><div><span><strong>图片识别正文</strong><small>按原有换行展示</small></span><button type="button" title="复制图片识别正文" onClick={() => onCopy(selectedResult.media?.analysis?.visible_text?.trim() || '')}><Copy size={14} /></button></div><pre>{selectedResult.media?.analysis?.visible_text?.trim()}</pre></div>}</div>
            </AiSectionBoundary>
          </section>}
          <AiSectionBoundary resetSignal={analysis} fallback={<AiSectionUnavailable label="AI 内容结构" />}>
            <section className="general-overview"><div><span>AI CONTENT BRIEF</span><h4>内容概览</h4></div><p>{analysis?.overview || '等待 AI 根据关键词、正文与图片生成概览。'}</p>{analysis?.relevance_reason && <small>{analysis.relevance_reason}</small>}</section>
            {(analysis?.topics?.length || analysis?.entities?.length) ? <div className="content-taxonomy">{analysis?.topics?.length ? <section><h4>主题</h4><div>{analysis.topics.map((topic) => <span key={topic}>{topic}</span>)}</div></section> : null}{analysis?.entities?.length ? <section><h4>实体与对象</h4><div>{analysis.entities.map((entity) => <span key={entity}>{entity}</span>)}</div></section> : null}</div> : null}
            <div className="content-module-grid">{analysis?.modules?.length ? analysis.modules.map((module) => <section className="content-module" key={module.id}><div><BookOpenCheck size={16} /><h4>{module.title}</h4></div><p>{module.summary}</p>{module.items.length > 0 && <ul>{module.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}{module.evidence.length > 0 && <details><summary>查看原文依据</summary>{module.evidence.map((item, index) => <blockquote key={`${item}-${index}`}>{item}</blockquote>)}</details>}</section>) : <section className="content-module pending"><LoaderCircle size={18} /><h4>等待动态栏目分析</h4><p>AI 会根据本次关键词决定栏目，而不是套用岗位模板。</p></section>}</div>
            {analysis?.image_insights?.length ? <section className="image-insight-list"><h4>图片线索</h4><ul>{analysis.image_insights.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section> : null}
          </AiSectionBoundary>
          <section className="body-section general-body"><div><h4>采集正文</h4><button type="button" title="复制采集正文" onClick={() => onCopy(selectedResult.body || '')}><Copy size={14} /></button></div><p>{selectedResult.body || '正文尚未采集；已保留图片和卡片文字供 AI 分析。'}</p></section>
        </article> : <div className="result-empty"><FileText size={28} /><strong>选择一条内容查看 AI 分析</strong></div>}
      </div>
    </>
  )
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}><i />{statusText[status]}</span>
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

function latestCompletionJob(jobs: Job[], current: Job) {
  let latest = jobs.find((job) => job.id === current.id) || current
  const visited = new Set<string>()
  while (!visited.has(latest.id)) {
    visited.add(latest.id)
    const child = jobs.find((job) => (
      job.config?.completeMissingOnly
      && job.config?.resumeFromJobId === latest.id
    ))
    if (!child) break
    latest = child
  }
  return latest
}

function workspaceModeFromLocation(): AnalysisMode {
  if (typeof window === 'undefined') return 'job'
  return window.location.pathname.replace(/\/+$/, '') === '/content' ? 'general' : 'job'
}

function workspacePath(mode: AnalysisMode) {
  return mode === 'general' ? '/content' : '/'
}

const legacyJobIntentPattern = /(?:岗位|职位|招聘|招募|求职|应聘|内推|校招|社招|实习|面试|简历|job|jobs|hiring|hire|career|careers|recruit|recruitment|intern|internship|position|vacancy)/i

function jobAnalysisMode(job: Job): AnalysisMode {
  if (job.config?.analysisMode === 'general' || job.config?.analysisMode === 'job') {
    return job.config.analysisMode
  }
  return legacyJobIntentPattern.test(job.keyword || '') ? 'job' : 'general'
}

function isIncompleteApplicationResult(result: ApplicationResult) {
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
    || !result.body.trim()
    || result.job_card?.parse_basis === 'search_card'
    || result.outreach?.runtime_status === 'fallback_missing_job_body'
}

function App() {
  const [workspaceMode, setWorkspaceMode] = useState<AnalysisMode>(() => workspaceModeFromLocation())
  const requestCache = useRef<Record<AnalysisMode, JobRequest>>({
    job: { ...defaultRequest, analysisMode: 'job', candidateProfile: loadCandidateProfile() },
    general: { ...defaultRequest, analysisMode: 'general', keyword: '', useCodexRuntime: true, candidateProfile: loadCandidateProfile() },
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
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(50)
  const activeJobIdCache = useRef<Record<AnalysisMode, string | null>>({ job: null, general: null })
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null)
  const [results, setResults] = useState<ApplicationResultsResponse | null>(null)
  const [selectedResult, setSelectedResult] = useState<ApplicationResult | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const draftDirtyRef = useRef(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [resultOffset, setResultOffset] = useState(0)
  const [resultsLoading, setResultsLoading] = useState(false)
  const [resultSort, setResultSort] = useState<'newest' | 'oldest'>('newest')
  const [resultTimeRange, setResultTimeRange] = useState<'all' | '1' | '3' | '7' | '30' | '90' | 'unknown'>('all')
  const resultViewCache = useRef<Record<AnalysisMode, WorkspaceResultView>>({
    job: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
    general: { activeJobId: null, results: null, selectedNoteId: null, resultOffset: 0, resultSort: 'newest', resultTimeRange: 'all' },
  })
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [loading, setLoading] = useState(true)
  const [relayConnecting, setRelayConnecting] = useState(false)
  const [relaySettingUp, setRelaySettingUp] = useState(false)
  const [securityRecovering, setSecurityRecovering] = useState(false)
  const [submitting, setSubmitting] = useState(false)
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
  const relayConnectionRef = useRef<Promise<RelayStatus> | null>(null)
  const rateLimitAlertRef = useRef<string | null>(null)
  const resultsRequestRef = useRef(0)
  const relayGuideAutoOpened = useRef(false)
  const logConsole = useRef<HTMLDivElement | null>(null)
  const logEnd = useRef<HTMLDivElement | null>(null)
  const handledLocalInstall = useRef<string | null>(null)
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

  const switchWorkspace = useCallback((mode: AnalysisMode, updateHistory = true) => {
    if (mode === workspaceMode) return
    resultsRequestRef.current += 1
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
    if (updateHistory && window.location.pathname !== workspacePath(mode)) {
      window.history.pushState({ workspaceMode: mode }, '', workspacePath(mode))
    }
    setWorkspaceMode(mode)
    setRequest({ ...requestCache.current[mode] })
    const scopedJobs = jobs.filter((job) => jobAnalysisMode(job) === mode)
    const rememberedJobId = activeJobIdCache.current[mode]
    const nextJob = scopedJobs.find((job) => job.id === rememberedJobId) || scopedJobs[0] || null
    const nextView = resultViewCache.current[mode]
    const canRestoreView = Boolean(nextJob && nextView.activeJobId === nextJob.id && nextView.results?.analysisMode === mode)
    const nextResults = canRestoreView ? nextView.results : null
    setActiveJob(nextJob)
    setArtifacts([])
    setCoverage(null)
    setResults(nextResults)
    setSelectedResult(nextResults?.items.find((item) => item.note_id === nextView.selectedNoteId) || nextResults?.items[0] || null)
    setLogs([])
    setResultOffset(canRestoreView ? nextView.resultOffset : 0)
    setResultSort(nextView.resultSort)
    setResultTimeRange(nextView.resultTimeRange)
    setResultsLoading(Boolean(nextJob) && !canRestoreView)
    setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeJob, jobs, request, resultOffset, results, resultSort, resultTimeRange, selectedResult, workspaceMode])

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
    const handlePopState = () => switchWorkspace(workspaceModeFromLocation(), false)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [switchWorkspace])

  useEffect(() => {
    document.title = workspaceMode === 'general' ? '继任非岗位内容研究工作台' : '继任采集与投递工作台'
  }, [workspaceMode])

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
        ? `Relay 已修复并完成 Playwright 验证，共关闭 ${result.closedTargets} 个旧页面。`
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
    try {
      const response = await api.jobs()
      const next = Array.isArray(response) ? response : []
      const scoped = next.filter((job) => jobAnalysisMode(job) === workspaceMode)
      setJobs(next)
      setActiveJob((current) => {
        const rememberedJobId = activeJobIdCache.current[workspaceMode]
        const nextActive = current && jobAnalysisMode(current) === workspaceMode
          ? latestCompletionJob(scoped, current)
          : scoped.find((job) => job.id === rememberedJobId) || scoped[0] || null
        activeJobIdCache.current[workspaceMode] = nextActive?.id || null
        return nextActive
      })
    } catch (error) {
      setNotice((error as Error).message)
    }
  }, [workspaceMode])

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

  const selectAiModel = (value: string) => {
    if (value === CUSTOM_MODEL_OPTION) {
      setCustomModelMode(true)
      setAiModel('')
      return
    }
    setCustomModelMode(false)
    setAiModel(value)
  }

  const updateAiBaseUrl = (value: string) => {
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
    setProviderId(provider.id)
    setAiModel(session.model)
    setAiBaseUrl(session.baseUrl)
    setAiWireApi(session.wireApi)
    setCustomModelMode(Boolean(session.model && !provider.models.includes(session.model)))
    setAiSession(session)
    updateRequest('aiSessionId', session.id)
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
      setAiSession(session)
      setAiBaseUrl(session.baseUrl)
      updateRequest('aiSessionId', session.id)
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
    if (!localProvider) return setNotice('本地免费模型配置未加载。')
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
      setAiSession(session)
      updateRequest('aiSessionId', session.id)
      setNotice(`本地免费模型 ${model} 已就绪，文本整理不产生 API 费用。`)
    } catch (error) {
      setNotice(`${(error as Error).message} 可使用上方入口一键安装。`)
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
      setResultOffset(offset)
      if (!options.preserveDraft || !draftDirtyRef.current) {
        setSelectedResult((current) => payload.items.find((item) => item.note_id === current?.note_id) || payload.items[0] || null)
        setDraftDirty(false)
      }
    } catch {
      if (requestId !== resultsRequestRef.current) return
      if (!options.silent) {
        const cached = resultViewCache.current[requestMode]
        const cachedResults = cached.activeJobId === jobId && cached.results?.analysisMode === requestMode ? cached.results : null
        setResults(cachedResults)
        setSelectedResult(cachedResults?.items.find((item) => item.note_id === cached.selectedNoteId) || cachedResults?.items[0] || null)
        setNotice(cachedResults ? '最新结果读取失败，当前继续显示已缓存的采集内容。' : '结果暂时读取失败，请稍后刷新；已采集文件和任务检查点未受影响。')
      }
    } finally {
      if (!options.silent && requestId === resultsRequestRef.current) setResultsLoading(false)
    }
  }, [resultSort, resultTimeRange, workspaceMode])

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
        const initialJob = nextJobs.find((job) => jobAnalysisMode(job) === initialMode) || null
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
      const configuredProvider = expandedOptions.find((item) => item.configured && (!item.requiresKey || item.hasApiKey))
      const preferredProvider = configuredProvider || localProvider || codex || options[0]
      if (preferredProvider) selectProvider(preferredProvider.id, expandedOptions)
      const localRuntimeReady = Boolean(localStatus?.runtime.ready && localStatus.installedModels.length)
      if (preferredProvider && (preferredProvider.configured || (preferredProvider.local && localRuntimeReady))) {
        void api.createAiSession({
          provider: preferredProvider.id,
          apiKey: '',
          model: preferredProvider.model || localStatus?.installedModels[0]?.name || '',
          baseUrl: preferredProvider.baseUrl,
          wireApi: preferredProvider.wireApi,
        }).then((session) => {
          setAiSession(session)
          updateRequest('aiSessionId', session.id)
          setNotice(`已自动恢复 ${preferredProvider.label}，可直接执行智能补全。`)
        }).catch(() => undefined)
      }
      if (saved[0]) updateRequest('profileId', saved[0].id)
    }).catch((error) => setNotice((error as Error).message))
  }, [])

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
    setCoverage(activeJob?.coverage || parseCoverage(activeJob?.workflowSummary) || null)
    if (!activeJob) {
      setArtifacts([])
      setResults(null)
      setSelectedResult(null)
      return
    }
    api.artifacts(activeJob.id).then(setArtifacts).catch(() => setArtifacts(activeJob.artifacts || []))
    void loadResults(activeJob.id, 0)
  }, [activeJob?.id, activeJob?.status, activeJob?.applicationCount, loadResults])

  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'queued')) return
    const timer = window.setInterval(() => {
      void loadResults(activeJob.id, resultOffset, { silent: true, preserveDraft: true })
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [activeJob?.id, activeJob?.status, loadResults, resultOffset])

  useEffect(() => {
    if (!completionFlow?.jobId || !activeJob || activeJob.id !== completionFlow.jobId) return
    if (activeJob.status === 'queued' || activeJob.status === 'running') {
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
      if (workspaceMode === mode) {
        setResults(payload)
        setResultOffset(0)
        setSelectedResult((current) => payload.items.find((item) => item.note_id === current?.note_id) || payload.items[0] || null)
        setDraftDirty(false)
      }
      const remaining = payload.filters.stats.incomplete
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
    if (!activeJob?.rateLimit?.detected) return
    const alertKey = `${activeJob.id}:${activeJob.rateLimit.detectedAt || 'detected'}`
    if (rateLimitAlertRef.current === alertKey) return
    rateLimitAlertRef.current = alertKey
    setNotice('检测到平台限流：系统已停止新增访问并保留检查点。请先手动打开小红书确认访问恢复，再从检查点续跑。')
  }, [activeJob?.id, activeJob?.rateLimit?.detected, activeJob?.rateLimit?.detectedAt])

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
      if (jobAnalysisMode(event.job) === workspaceMode) setActiveJob(event.job)
      setJobs((current) => [event.job!, ...current.filter((item) => item.id !== event.job!.id)])
    }
    if (event.artifacts) setArtifacts(event.artifacts)
    if (event.message && event.type === 'error') setNotice(event.message)
    if (
      event.type === 'done'
      || ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(event.job?.status || '')
    ) void loadJobs()
  }, [loadJobs, workspaceMode])

  const connectJob = useCallback((job: Job) => {
    cleanupStream.current?.()
    cleanupStream.current = api.subscribe(job.id, applyEvent, () => {
      window.setTimeout(() => void loadJobs(), 800)
    })
  }, [applyEvent, loadJobs])

  useEffect(() => {
    if (!activeJob || !['queued', 'running'].includes(activeJob.status)) return
    connectJob(activeJob)
    return () => {
      cleanupStream.current?.()
      cleanupStream.current = null
    }
  }, [activeJob?.id, activeJob?.status, connectJob])

  const runJob = async (payload: JobRequest, sessionHint: AiSession | null = aiSession): Promise<Job | null> => {
    if (payload.analysisMode === 'general' && !payload.checkOnly && !sessionHint) {
      setNotice('内容模式需要先连接 AI 模型，正文、图片和动态栏目才会进入同一次分析。')
      document.getElementById('ai-memory')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return null
    }
    setSubmitting(true)
    setNotice(null)
    setCoverage(null)
    setLogs([`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 正在创建任务...`])
    try {
      const latestPayload: JobRequest = {
        ...payload,
        searchSort: 'latest',
        maxAgeDays: 0,
        limit: 0,
        aiSessionId: sessionHint?.id || payload.aiSessionId || null,
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

  const resumeJob = async (job: Job, completeMissingOnly = false, sessionHint: AiSession | null = aiSession) => {
    if (!job.resumeAvailable) return null
    let session = sessionHint
    if (!session) {
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
    const source = job.config
    if (!source) {
      setNotice('该任务缺少原始配置，无法构造续跑请求。')
      return null
    }
    const analysisMode = jobAnalysisMode(job)
    const profileId = source.profileId || request.profileId
    if (analysisMode === 'job' && !profileId) {
      setNotice('请先选择背景记忆，再从检查点续跑。')
      return null
    }
    const payload: JobRequest = {
      ...defaultRequest,
      ...source,
      searchSort: 'latest',
      maxAgeDays: 0,
      limit: 0,
      relayPort: relayConfig.port,
      mode: 'resume',
      resumeFromJobId: job.id,
      completeMissingOnly,
      checkOnly: false,
      aiSessionId: session.id,
      analysisMode,
      profileId: analysisMode === 'job' ? profileId : null,
      candidateProfile: {
        ...defaultCandidateProfile,
        ...(source.candidateProfile || request.candidateProfile),
      },
    }
    return runJob(payload, session)
  }

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
      const existingResume = nextJobs.find((candidate) => (
        ['queued', 'running'].includes(candidate.status)
        && candidate.config?.resumeFromJobId === job.id
      ))
      if (existingResume) {
        setActiveJob(existingResume)
        connectJob(existingResume)
        setNotice('验证状态已刷新，已切换到正在执行的续跑任务。')
        return
      }

      const refreshedJob = nextJobs.find((candidate) => candidate.id === job.id) || job
      setActiveJob(refreshedJob)
      if (['queued', 'running'].includes(refreshedJob.status)) {
        connectJob(refreshedJob)
        setNotice('验证状态已刷新。运行中的任务会在下一次检测时自动继续，无需再次点击。')
        window.setTimeout(() => void loadJobs(), 5_500)
        return
      }
      if (!refreshedJob.resumeAvailable) {
        setNotice('验证状态已刷新，但该任务尚无可用检查点；请等待任务写入检查点后再刷新。')
        return
      }

      const resumed = await resumeJob(refreshedJob)
      if (resumed) setNotice('安全验证已完成，已从保存的检查点自动续跑。')
    } catch (error) {
      setRelay({ running: false, cdpReady: false, port: relayConfig.port, message: (error as Error).message })
      setNotice((error as Error).message)
    } finally {
      setSecurityRecovering(false)
    }
  }

  const completeMissingResults = async () => {
    if (!activeJob || completingMissing || submitting) return
    const generalMode = workspaceMode === 'general' || results?.analysisMode === 'general' || jobAnalysisMode(activeJob) === 'general'
    if (!generalMode && draftDirty) {
      setNotice('当前岗位有未保存的文案修改，请先保存后再补全。')
      return
    }
    const sourceJobId = activeJob.id
    const noun = generalMode ? '内容分析' : '岗位信息'
    const knownIncomplete = results?.filters.stats.incomplete ?? null
    setCompletingMissing(true)
    setCompletionFlow({
      stage: 'checking',
      sourceJobId,
      incompleteBefore: knownIncomplete,
      message: `正在核对未完整${noun}和可复用检查点。`,
    })
    setNotice(`正在核对所有未完整${noun}…`)
    try {
      let session = aiSession
      if (!session) {
        setRestoringAi(true)
        setCompletionFlow((current) => current ? {
          ...current,
          stage: 'restoring_ai',
          message: '正在恢复本机已保存的 AI 配置。',
        } : current)
        try {
          session = await restoreAiSession()
        } finally {
          setRestoringAi(false)
        }
      }
      setCompletionFlow((current) => current ? {
        ...current,
        stage: 'starting',
        message: '正在接管已有任务或创建仅处理缺失记录的补全任务。',
      } : current)

      let response
      try {
        response = await api.completeMissing(sourceJobId, session?.id || null)
      } catch (error) {
        const apiError = error as Error & { code?: string; status?: number }
        if (apiError.status === 404) {
          const refreshedJob = await api.job(sourceJobId)
          if (['queued', 'running'].includes(refreshedJob.status)) {
            response = {
              action: 'attached' as const,
              sourceJobId,
              incompleteBefore: knownIncomplete,
              job: refreshedJob,
              message: 'The source task is still running.',
            }
          } else {
            const resumedJob = await resumeJob(refreshedJob, true, session)
            if (!resumedJob) {
              const fallbackError = new Error('当前版本未找到可复用的正文检查点。') as Error & { code?: string }
              fallbackError.code = 'RESUME_CHECKPOINTS_MISSING'
              throw fallbackError
            }
            response = {
              action: 'started' as const,
              sourceJobId,
              incompleteBefore: knownIncomplete,
              job: resumedJob,
              message: 'Started completion through the compatible task endpoint.',
            }
          }
        } else {
          if (apiError.code !== 'AI_SESSION_EXPIRED' || !session) throw error
          setRestoringAi(true)
          setCompletionFlow((current) => current ? {
            ...current,
            stage: 'restoring_ai',
            message: 'AI 会话已过期，正在自动重连后继续。',
          } : current)
          try {
            session = await restoreAiSession()
          } finally {
            setRestoringAi(false)
          }
          response = await api.completeMissing(sourceJobId, session.id)
        }
      }

      if (response.action === 'already_complete') {
        await loadResults(response.job.id, 0)
        setCompletionFlow({
          stage: 'complete',
          sourceJobId,
          jobId: response.job.id,
          incompleteBefore: 0,
          message: `核对完成，当前没有未完整${noun}。`,
        })
        setNotice(`所有${noun}均已完整，无需重复运行。`)
        return
      }

      setActiveJob(response.job)
      setJobs((current) => [response.job, ...current.filter((item) => item.id !== response.job.id)])
      connectJob(response.job)
      setCompletionFlow({
        stage: 'running',
        sourceJobId: response.sourceJobId,
        jobId: response.job.id,
        incompleteBefore: response.incompleteBefore ?? knownIncomplete,
        message: response.action === 'attached'
          ? '已接管正在运行的任务，页面会持续显示实时进度。'
          : `已创建补全任务，仅处理 ${response.incompleteBefore ?? knownIncomplete ?? 0} 条缺失记录。`,
      })
      setNotice(response.action === 'attached' ? '已接管正在运行的补全流程。' : '补全任务已启动，完成后会自动刷新结果。')
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

  const selectJob = (job: Job) => {
    setActiveJob(job)
    setLogs([])
    if (job.status === 'running' || job.status === 'queued') connectJob(job)
  }

  const tabCount = Array.isArray(relay?.tabs) ? relay.tabs.length : Number(relay?.tabs || 0)
  const xiaohongshuTabCount = Number(relay?.xiaohongshuTabs || 0)
  const relayConfigValid = Number.isInteger(relayConfig.port) && relayConfig.port >= 1024 && relayConfig.port <= 65535 && Boolean(relayConfig.profile.trim())
  const relayStatusMatchesConfig = relay?.port === relayConfig.port
  const relayServiceReady = Boolean(relayStatusMatchesConfig && relay?.running && relay?.cdpReady)
  const relayReady = relayServiceReady && tabCount > 0
  const relaySiteReady = relayReady && xiaohongshuTabCount > 0
  const relayPressureHigh = relay?.targetPressure === 'high' || Boolean(relay?.recoveryRecommended)
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
  const effectiveHistoryPageSize = historyPageSize === 0 ? Math.max(workspaceJobs.length, 1) : historyPageSize
  const historyPageCount = Math.max(1, Math.ceil(workspaceJobs.length / effectiveHistoryPageSize))
  const currentHistoryPage = Math.min(historyPage, historyPageCount)
  const historyStart = (currentHistoryPage - 1) * effectiveHistoryPageSize
  const visibleWorkspaceJobs = workspaceJobs.slice(historyStart, historyStart + effectiveHistoryPageSize)
  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPageCount))
  }, [historyPageCount])
  useEffect(() => {
    setHistoryPage(1)
  }, [workspaceMode, historyPageSize])
  const progress = activeJob?.progress ?? (activeJob ? progressByStatus[activeJob.status] : 0)
  const progressCurrent = Number(activeJob?.progressCurrent || 0)
  const progressTotal = Number(activeJob?.progressTotal || 0)
  const discoveredCount = Number(activeJob?.discoveredCount || 0)
  const scrapedCount = Number(activeJob?.scrapedCount || 0)
  const bodyProcessedCount = Math.min(
    discoveredCount || Number.MAX_SAFE_INTEGER,
    Math.max(scrapedCount, Number(activeJob?.bodyProcessedCount || 0)),
  )
  const remainingCount = Math.max(0, discoveredCount - bodyProcessedCount)
  const progressLabel = activeJob?.progressLabel || (({
    queued: '任务已排队，等待启动',
    running: '正在等待下一条实时进度',
    completed: '任务已完成',
    incomplete: `未完成：当前检查点已分析，可继续补全剩余${workspaceMode === 'general' ? '内容' : '岗位'}`,
    interrupted: '未完成：任务已中断，检查点已保留',
    failed: '执行失败：请查看失败原因',
    cancelled: '未完成：任务已取消',
  } as Record<string, string>)[activeJob?.status || ''] ?? '尚未开始')
  const progressAge = progressUpdateAge(activeJob?.progressUpdatedAt, clock)
  const runningCount = workspaceJobs.filter((job) => job.status === 'running' || job.status === 'queued').length
  const completedCount = workspaceJobs.filter((job) => job.status === 'completed').length
  const failedCount = workspaceJobs.filter((job) => job.status === 'failed').length
  const incompleteCount = workspaceJobs.filter((job) => ['incomplete', 'cancelled', 'interrupted'].includes(job.status)).length
  const activeOutcome = activeJob?.status === 'failed'
    ? 'failed'
    : activeJob?.status === 'incomplete' || activeJob?.status === 'cancelled' || activeJob?.status === 'interrupted'
      ? 'incomplete'
      : activeJob?.status || 'idle'
  const currentArtifacts = artifacts.length ? artifacts : activeJob?.artifacts || []
  const exportCount = useMemo(() => workspaceJobs.reduce((sum, job) => sum + (job.artifactCount ?? job.artifacts?.length ?? 0), 0), [workspaceJobs])
  const activeAllMode = activeJob?.config?.limit === 0
  const runningLog = logs.slice(-120).join('\n')
  const terminalAnalysisReady = Boolean(activeJob && ['completed', 'incomplete'].includes(activeJob.status) && coverage)
  const activeAnalysisMode = workspaceMode
  const activeAgentStages = activeAnalysisMode === 'general' ? generalAgentStages : jobAgentStages
  const activeAgentIndex = terminalAnalysisReady
    ? activeAgentStages.length
    : activeJob?.status === 'running'
      ? activeAgentStages.reduce((last, stage, index) => stage.matcher.test(runningLog) ? index : last, 0)
      : -1
  const workflowSummary = activeJob?.workflowSummary || {}
  const partialAnalysis = workflowSummary.analysisMode === 'security_timeout_partial'
  const securityVerification = (workflowSummary.securityVerification || {}) as Record<string, unknown>
  const securityStatus = activeJob?.securityRestriction?.status || String(securityVerification.status || '')
  const securityJobRunning = Boolean(activeJob && ['queued', 'running'].includes(activeJob.status))
  const securityReportedWaiting = securityStatus === 'waiting'
  const securityWaiting = securityReportedWaiting && securityJobRunning
  const securityTimedOut = securityStatus === 'timed_out' || (
    partialAnalysis
    && (workflowSummary.collectionStopReason === 'security_verification_timeout' || securityVerification.status === 'timed_out')
  ) || (securityReportedWaiting && !securityJobRunning)
  const securityNeedsAttention = securityWaiting || securityTimedOut
  const securityTimeoutSeconds = Number(activeJob?.securityRestriction?.timeoutSeconds || securityVerification.timeoutSeconds || activeJob?.config?.securityVerificationTimeoutSeconds || 600)
  const securityTimeoutLabel = securityTimeoutSeconds % 60 === 0 ? `${securityTimeoutSeconds / 60} 分钟` : `${securityTimeoutSeconds} 秒`
  const workflowRateLimit = (workflowSummary.rateLimit || {}) as Record<string, unknown>
  const rateLimitDetected = Boolean(activeJob?.rateLimit?.detected)
    || activeJob?.progressPhase === 'rate_limited'
    || workflowSummary.analysisMode === 'rate_limited_partial'
    || workflowRateLimit.status === 'stopped'
  const rateLimitDetectedAt = activeJob?.rateLimit?.detectedAt || String(workflowRateLimit.detectedAt || '')
  const rateLimitReadyToResume = Boolean(activeJob?.resumeAvailable && !securityNeedsAttention)
  const codexRuntime = results?.codexRuntime || (workflowSummary.codexRuntime as Record<string, unknown> | undefined)
  const selectedProvider = providers.find((item) => item.id === providerId)
  const selectedLocalModel = localModelStatus?.catalog.find((item) => item.id === localModelChoice)
  const localModelGroups = (localModelStatus?.catalog || []).reduce<Array<{ family: string; models: LocalModelStatus['catalog'] }>>((groups, model) => {
    const group = groups.find((item) => item.family === model.family)
    if (group) group.models.push(model)
    else groups.push({ family: model.family, models: [model] })
    return groups
  }, [])
  const localInstallActive = Boolean(localModelStatus?.install && ['queued', 'running'].includes(localModelStatus.install.status))
  const activeProfile = profiles.find((item) => item.id === request.profileId)
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
  const selectedResultIncomplete = Boolean(selectedResult && isIncompleteApplicationResult(selectedResult))
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

  const chooseResult = (next: ApplicationResult) => {
    if (results?.analysisMode !== 'general' && draftDirty && selectedResult?.note_id !== next.note_id) {
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
    copyText(outreachDraft(selectedResult).greeting)
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

  return (
    <div className={`app-shell ${workspaceMode === 'general' ? 'content-interface' : 'job-interface'}`}>
      <aside className="side-rail">
        <div className="brand-mark" aria-label="继任工作台">继</div>
        <nav aria-label="主导航">
          <button className={`nav-button ${workspaceMode === 'job' ? 'active' : ''}`} type="button" title="岗位投递工作台" aria-current={workspaceMode === 'job' ? 'page' : undefined} onClick={() => switchWorkspace('job')}><Target size={20} /><span>岗位台</span></button>
          <button className={`nav-button ${workspaceMode === 'general' ? 'active' : ''}`} type="button" title="非岗位信息研究工作台" aria-current={workspaceMode === 'general' ? 'page' : undefined} onClick={() => switchWorkspace('general')}><BookOpenCheck size={20} /><span>研究台</span></button>
          <button className="nav-button" title="任务历史" onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}><Clock3 size={20} /><span>历史</span></button>
          <button className="nav-button" title="导出文件" onClick={() => document.getElementById('artifacts')?.scrollIntoView({ behavior: 'smooth' })}><Table2 size={20} /><span>产物</span></button>
        </nav>
        {workspaceMode === 'job' && <button className="nav-button rail-settings" title="发件邮箱设置" onClick={() => document.getElementById('email-config')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={20} /><span>设置</span></button>}
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-leading">
            <div className="product-title">
              <span className="eyebrow">{workspaceMode === 'general' ? 'CONTENT INTELLIGENCE' : 'APPLICATION INTELLIGENCE'}</span>
              <h1>{workspaceMode === 'general' ? '继任非岗位内容研究工作台' : '继任采集与投递工作台'}</h1>
              <span className="version">v3.0</span>
            </div>
            <nav className="workspace-switcher" aria-label="切换工作台">
              <button type="button" className={workspaceMode === 'job' ? 'active' : ''} aria-current={workspaceMode === 'job' ? 'page' : undefined} onClick={() => switchWorkspace('job')}><Target size={15} /><span>岗位投递</span></button>
              <button type="button" className={workspaceMode === 'general' ? 'active' : ''} aria-current={workspaceMode === 'general' ? 'page' : undefined} onClick={() => switchWorkspace('general')}><BookOpenCheck size={15} /><span>非岗位研究</span></button>
            </nav>
          </div>
          <div className="topbar-status">
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
              <p className="product-hero-lede">{activeAnalysisMode === 'general' ? '选择研究场景和目标后，全量保存正文与原图；AI 会结合关键词、OCR 与逐条证据，动态生成本次专属栏目和结构化结论。' : '继任采集台把“发现岗位 🔎、读懂正文 🧠、匹配经历、写好求职信 ✍️、完成投递 📮”串成一条本地可复核的求职工作流。'}</p>
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
                <span className="relay-guide-icon">{relayRecovering ? <LoaderCircle className="spin" size={18} /> : relayPressureHigh ? <ShieldAlert size={18} /> : relaySiteReady ? <Check size={18} /> : relayConnecting || relaySettingUp || relayLoginOpening ? <LoaderCircle className="spin" size={18} /> : <Wifi size={18} />}</span>
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
                    <strong>{relayPressureHigh ? '检测到 Relay 目标过载' : relayRecovery?.ok ? 'Relay 已修复并通过真实连接验证' : 'Relay 连接保护已启用'}</strong>
                    <small>{relayPressureHigh
                      ? '页面或后台目标过多会让 Playwright 初始化超时；可直接收敛旧页面并保留登录态。'
                      : '新任务会自动减压，并使用 60 秒连接窗口；不会清除 Cookie 或浏览器 Profile。'}</small>
                  </span>
                </span>
                <dl aria-label="Relay 目标诊断">
                  <div><dt>全部目标</dt><dd>{tabCount}</dd></div>
                  <div><dt>页面</dt><dd>{Number(relay?.pageCount || 0)}</dd></div>
                  <div><dt>后台</dt><dd>{Number(relay?.workerCount || 0) + Number(relay?.iframeCount || 0)}</dd></div>
                </dl>
                <button type="button" className={relayPressureHigh ? 'primary-button' : 'secondary-button'} disabled={relayRecovering || relayConnecting || relaySettingUp || relayLoginOpening || !relayConfigValid} onClick={() => void repairRelay()}>
                  {relayRecovering ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
                  {relayRecovering ? '正在修复并验证' : '一键修复 Relay'}
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
                  {(!smtpManualMode || smtpConfig.auth === 'login') && <label className="field"><span>{detectedSmtpPreset?.provider === '163' || detectedSmtpPreset?.provider === 'qq' ? '客户端授权密码' : '密码 / 应用专用密码'}</span><input type="password" autoComplete="current-password" value={smtpPassword} onChange={(event) => setSmtpPassword(event.target.value)} placeholder={smtpConfig.hasPassword ? '已保存，留空保持不变' : '仅保存在当前设备'} /></label>}
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
                <div className="smtp-guidance"><ShieldCheck size={16} /><span><strong>{smtpManualMode ? '高级参数仅保存在当前设备' : '邮箱凭据仅保存在当前设备'}</strong><small>{smtpManualMode ? smtpProviderOptions.find((item) => item.id === smtpConfig.provider)?.guidance : detectedSmtpProvider?.guidance || '输入完整邮箱后即可自动配置；企业邮箱请使用高级设置。'}</small></span></div>
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
                    <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setAiConnectionCheck(null) }} placeholder={selectedProvider.hasApiKey ? '已保存，留空即可复用' : '粘贴中转服务 API Key'} /></label>
                    <label className="field"><span>协议</span><select value={aiWireApi} onChange={(event) => setAiWireApi(event.target.value as 'responses' | 'chat_completions')}><option value="chat_completions">Chat Completions</option><option value="responses">Responses API</option></select></label>
                    <div className="field model-field"><span id="relay-ai-model-label">模型</span><div className="model-picker single"><select aria-labelledby="relay-ai-model-label" value={selectedModelValue} onChange={(event) => selectAiModel(event.target.value)}><option value="" disabled>检测后选择模型</option>{(selectedProvider.models || []).map((model) => <option key={model} value={model}>{model}</option>)}<option value={CUSTOM_MODEL_OPTION}>自定义模型 ID…</option></select></div><small>{selectedProvider.models.length || 0} 个可选模型</small></div>
                  </div>
                </> : <>
                  <div className="form-row ai-provider-row">
                    <label className="field"><span>提供方</span><select value={providerId} onChange={(event) => selectProvider(event.target.value as AiProviderOption['id'])}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                    {selectedProvider?.requiresKey
                      ? <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedProvider?.hasApiKey ? '已保存，留空即可复用' : '粘贴模型服务 API Key'} /></label>
                      : <div className="field local-access-field"><span>运行方式</span><strong><Cpu size={14} />本机免密 · 零 API 费用</strong></div>}
                    <div className="field model-field"><span id="ai-model-label">模型</span><div className="model-picker"><select aria-labelledby="ai-model-label" value={selectedModelValue} onChange={(event) => selectAiModel(event.target.value)}><option value="" disabled>选择模型</option>{(selectedProvider?.models || []).map((model) => <option key={model} value={model}>{model}</option>)}<option value={CUSTOM_MODEL_OPTION}>自定义模型 ID…</option></select><button type="button" className="model-refresh-button" title={selectedProvider?.local ? '读取本机已安装模型' : '读取当前账号可用模型'} aria-label={selectedProvider?.local ? '读取本机已安装模型' : '读取当前账号可用模型'} disabled={refreshingModels || !aiBaseUrl.trim() || (selectedProvider?.requiresKey && !apiKey && !selectedProvider?.hasApiKey)} onClick={() => void refreshAiModels()}>{refreshingModels ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div><small>{selectedProvider?.models.length || 0} 个可选模型</small></div>
                  </div>
                  <div className="form-row ai-provider-row">
                    <label className="field base-url-field"><span>Base URL</span><input value={aiBaseUrl} onChange={(event) => updateAiBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" /></label>
                    <label className="field"><span>协议</span><select value={aiWireApi} onChange={(event) => setAiWireApi(event.target.value as 'responses' | 'chat_completions')}><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option></select></label>
                  </div>
                </>}
                {customModelMode && <label className="field custom-model-field"><span>自定义模型 ID</span><input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="例如 provider/model-name" /></label>}
                <small className="form-hint">{selectedProvider?.local ? request.analysisMode === 'general' ? '用于正文归纳、图片文字理解和动态栏目生成；速度取决于本机硬件。' : '适合职位信息提炼、简历事实整理和初稿生成；速度取决于本机硬件。' : selectedProvider?.relay ? '密钥仅保存在当前设备；连接时会再次验证地址和模型，不写入任务历史或 GitHub。' : providerId === 'codex' ? '内置 Codex Runtime，用户电脑无需安装 Codex CLI；填写模型服务 Base URL 后直接调用。' : '配置保存在本机，API Key 不进入任务历史或 GitHub。'}</small>
                <button type="button" className="secondary-button setup-action" disabled={configuringAi || (!selectedProvider?.relay && !aiModel.trim()) || (selectedProvider?.relay && customModelMode && !aiModel.trim()) || !aiBaseUrl.trim() || (selectedProvider?.requiresKey && !apiKey && !selectedProvider?.hasApiKey)} onClick={() => void configureAi()}>{configuringAi ? <LoaderCircle className="spin" size={16} /> : selectedProvider?.relay ? <Wifi size={16} /> : <BrainCircuit size={16} />}{selectedProvider?.relay ? (aiSession ? '重新验证并连接' : '验证并连接') : aiSession ? '重新连接' : '连接 AI'}</button>
              </section>
              {request.analysisMode === 'job' && <section>
                <div className="setup-title"><Upload size={17} /><span><strong>背景资料</strong><small>{activeProfile ? `${activeProfile.display_name || '个人档案'} · ${activeProfile.sourceFiles?.length || 0} 个来源` : 'PDF / DOCX / TXT / MD / JSON / CSV / RTF'}</small></span></div>
                <label className="upload-zone"><input type="file" multiple accept=".pdf,.docx,.txt,.md,.json,.csv,.rtf" onChange={(event) => setBackgroundFiles(Array.from(event.target.files || []))} /><Upload size={18} /><span>{backgroundFiles.length ? `已选择 ${backgroundFiles.length} 个文件` : '选择多格式背景文件'}</span></label>
                <textarea className="background-text" value={backgroundText} onChange={(event) => setBackgroundText(event.target.value)} placeholder="可补充项目背景、工作偏好或可验证成果" />
                <div className="profile-actions">
                  <select value={request.profileId || ''} onChange={(event) => updateRequest('profileId', event.target.value || null)}><option value="">选择背景记忆</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.id}</option>)}</select>
                  <button type="button" className="secondary-button" disabled={!aiSession || importingProfile || !backgroundFiles.length} onClick={() => void importProfile()}>{importingProfile ? <LoaderCircle className="spin" size={16} /> : <BrainCircuit size={16} />}解析并写入记忆</button>
                </div>
                {activeProfile && <div className="memory-preview"><strong>{activeProfile.summary}</strong><span>{(activeProfile.skills || []).slice(0, 6).join(' · ')}</span></div>}
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
                <div><span className="step-label">01 / CONFIGURE</span><h2>{request.analysisMode === 'general' ? '新建非岗位信息研究任务' : '新建采集与投递分析任务'}</h2></div>
                <span className="local-badge">本地执行</span>
              </div>
              <form onSubmit={submit}>
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
                  <div className="sort-policy full-coverage" role="status" aria-label="发现多少采集多少">
                    <Target size={17} />
                    <span><strong>全量发现，发现多少采集多少</strong><small>搜索页发现的每一条内容都会进入候选区和正文队列</small></span>
                    <em>不截断</em>
                  </div>
                  <small className="field-help">持续滚动至最多 {request.maxScrolls} 轮或连续 {request.stableRounds} 轮没有新结果；中断后从未裁剪的发现清单续跑。</small>
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
                  <div className="sort-policy full-coverage" role="status" aria-label="不限时间全量保留">
                    <CalendarDays size={17} />
                    <span><strong>不限时间，全量保留</strong><small>发布时间只用于结果区排序和筛选，不会删除候选内容</small></span>
                    <em>无损采集</em>
                  </div>
                  <small className="field-help">采集完成后仍可在结果区选择近 7 天、近 30 天等范围；切换筛选不会改变正文总数。</small>
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
                    <label className="field"><span>安全验证等待 s</span><input type="number" min="60" max="3600" step="60" value={request.securityVerificationTimeoutSeconds} onChange={(event) => updateRequest('securityVerificationTimeoutSeconds', Number(event.target.value))} /></label>
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
                  <div className="mission-title"><span>关键词</span><strong>{activeJob.keyword}</strong><small>#{activeJob.id.slice(0, 8)}</small></div>
                  <div className="scope-stamp"><Target size={15} /><span><strong>{activeAllMode ? '全量模式' : '历史限定任务'}</strong><small>{activeAllMode ? `最新优先 · 不限时间 · 发现多少采集多少 · 连续 ${activeJob.config?.stableRounds ?? '-'} 轮稳定后停止` : '历史任务按原检查点展示'}</small></span></div>
                  <div className={`progress-block outcome-${activeOutcome}`} aria-live="polite">
                    <div className="progress-heading">
                      <span className={activeJob.status === 'running' ? 'live-progress-title active' : 'live-progress-title'}><i />实时进度<small>{progressAge}</small></span>
                      <strong>{Math.round(progress)}%</strong>
                    </div>
                    <div className="progress-track"><i style={{ width: `${Math.min(100, progress)}%` }} /></div>
                    <div className="live-progress-status">
                      <Activity size={16} />
                      <span><b>{progressLabel}</b><small>{activeJob.status === 'running' ? 'SSE 实时推送中' : activeOutcome === 'failed' ? '错误终止 · 查看失败原因' : activeOutcome === 'incomplete' ? '流程未走完 · 可从检查点继续' : '任务状态快照'}</small></span>
                      {progressTotal > 0 && <em>{Math.min(progressCurrent, progressTotal)} / {progressTotal}</em>}
                    </div>
                    <div className="live-progress-counts">
                      <span><small>已发现</small><b>{discoveredCount || '-'}</b></span>
                      <span><small>已检查正文</small><b>{bodyProcessedCount || '-'}</b></span>
                      <span><small>成功保存</small><b>{scrapedCount || '-'}</b></span>
                      <span><small>待处理正文</small><b>{discoveredCount ? remainingCount : '-'}</b></span>
                    </div>
                  </div>
                  {securityNeedsAttention && (
                    <div className={`security-recovery-panel ${securityWaiting ? 'waiting' : 'timed-out'}`} role="status">
                      <div className="security-recovery-heading">
                        <ShieldAlert size={20} />
                        <span>
                          <strong>{securityWaiting ? '等待人工完成安全验证' : '安全限制未解除，任务未完成'}</strong>
                          <small>{securityWaiting ? '所有新增访问已暂停；在受管浏览器完成验证后，本任务会自动继续。' : `已等待 ${securityTimeoutLabel}并停止新增访问；现有岗位卡和检查点均已保留。`}</small>
                        </span>
                        <em>{securityWaiting ? '等待中' : '待恢复'}</em>
                      </div>
                      <ol className="security-recovery-steps">
                        <li className="done"><span><Check size={13} /></span><div><strong>访问熔断</strong><small>暂停所有采集 worker，避免继续触发限制</small></div></li>
                        <li className="current"><span>2</span><div><strong>完成页面验证</strong><small>在受管浏览器中完成登录或安全验证</small></div></li>
                        <li className={relaySiteReady ? 'done' : ''}><span>{relaySiteReady ? <Check size={13} /> : 3}</span><div><strong>检测 Relay</strong><small>{relaySiteReady ? 'Relay 与小红书页面已连通' : '确认 Relay 和小红书页面均可访问'}</small></div></li>
                        <li className={securityTimedOut && activeJob.resumeAvailable && relaySiteReady ? 'current' : ''}><span>4</span><div><strong>{securityWaiting ? '自动恢复' : '检查点续跑'}</strong><small>{securityWaiting ? '验证解除后从当前任务继续' : '跳过已完成正文，仅采集剩余岗位'}</small></div></li>
                      </ol>
                      <div className="security-recovery-actions">
                        <button type="button" onClick={() => void openRelayLogin()} disabled={relayLoginOpening}><ExternalLink size={15} />{relayLoginOpening ? '正在打开' : '打开验证页'}</button>
                        <button type="button" className="primary-button" onClick={() => void refreshSecurityAndContinue(activeJob)} disabled={securityRecovering || submitting || (!securityJobRunning && !activeJob.resumeAvailable)} title={securityJobRunning ? '完成页面验证后刷新状态，当前任务会自动继续' : '完成页面验证后刷新 Relay，并自动从检查点续跑'}><RefreshCw className={securityRecovering ? 'spin' : ''} size={15} />{securityRecovering ? '正在刷新并恢复' : securityJobRunning ? '我已完成验证，刷新状态' : '我已完成验证，刷新并继续'}</button>
                      </div>
                      <p><ShieldCheck size={14} />不自动绕过验证，不在受限状态下反复请求；恢复时沿用已保存检查点。</p>
                    </div>
                  )}
                  {rateLimitDetected && (
                    <div className="rate-limit-recovery-panel" role="alert" aria-live="assertive">
                      <div className="security-recovery-heading">
                        <BellRing size={20} />
                        <span>
                          <strong>检测到平台限流，需要人工确认</strong>
                          <small>新增访问已停止，已完成岗位和检查点均已保留。请勿立即反复重试。</small>
                        </span>
                        <em>人工处理</em>
                      </div>
                      <ol className="security-recovery-steps rate-limit-recovery-steps">
                        <li className="done"><span><Check size={13} /></span><div><strong>系统停止访问</strong><small>采集 worker 已退出，不再继续请求新页面</small></div></li>
                        <li className="current"><span>2</span><div><strong>手动确认恢复</strong><small>打开小红书，确认搜索和笔记页面可以正常访问</small></div></li>
                        <li className={rateLimitReadyToResume ? 'current' : ''}><span>3</span><div><strong>检查点续跑</strong><small>{rateLimitReadyToResume ? '确认恢复后点击下方按钮，跳过已完成岗位' : '正在整理并保存当前检查点，请稍候'}</small></div></li>
                      </ol>
                      <div className="security-recovery-actions">
                        <button type="button" onClick={() => void openRelayLogin()} disabled={relayLoginOpening}><ExternalLink size={15} />{relayLoginOpening ? '正在打开' : '打开小红书检查页'}</button>
                        <button type="button" className="primary-button" onClick={() => void resumeJob(activeJob)} disabled={submitting || !rateLimitReadyToResume} title={rateLimitReadyToResume ? '仅在确认页面访问恢复后续跑' : '检查点尚未准备完成'}><Play size={15} fill="currentColor" />{rateLimitReadyToResume ? '我已确认恢复，续跑' : '等待检查点完成'}</button>
                      </div>
                      <p><Clock3 size={14} />{rateLimitDetectedAt ? `限流触发时间：${formatTime(rateLimitDetectedAt)}。` : ''}恢复前先等待一段时间，并以小红书页面可正常访问为准。</p>
                    </div>
                  )}
                  {activeOutcome === 'failed' && !rateLimitDetected && <div className="task-outcome-callout failed"><CircleAlert size={18} /><span><strong>执行失败</strong><small>{activeJob.message || (activeJob.resumeAvailable ? '任务因错误终止，检查点仍可用于重试。' : '任务因错误终止，请查看运行日志定位原因。')}</small></span></div>}
                  {activeOutcome === 'incomplete' && !rateLimitDetected && <div className="task-outcome-callout incomplete"><Pause size={18} /><span><strong>任务未完成</strong><small>{activeJob.status === 'incomplete' ? activeAnalysisMode === 'general' ? '当前内容分析已生成，仍有正文、图片理解或 AI 模块待补全。' : '当前岗位卡与投递文案已生成，仍有岗位正文待补全。' : activeJob.status === 'interrupted' ? '运行被中断，已完成内容和检查点仍然保留。' : '任务被主动取消，已完成内容仍然保留。'}{activeJob.resumeAvailable ? ' 可从检查点续跑。' : ''}</small></span></div>}
                  <ol className="pipeline agent-pipeline">
                    {activeAgentStages.map((stage, index) => {
                      const gateFailed = index === activeAgentStages.length - 1 && terminalAnalysisReady && coverage?.gatePassed === false
                      const done = (terminalAnalysisReady || index < activeAgentIndex) && !gateFailed
                      const current = activeJob.status === 'running' && activeAgentIndex === index
                      return <li key={stage.name} className={gateFailed ? 'failed-stage' : done ? 'done' : current ? 'current' : ''}><span>{done ? <Check size={14} /> : gateFailed ? <CircleAlert size={14} /> : index + 1}</span><div><strong>{stage.name}</strong><small>{stage.description}</small></div>{current && <em>执行中</em>}{gateFailed && <em>{coverage?.issueCount ?? '-'} 项待复核</em>}</li>
                    })}
                  </ol>
                  <div className="mission-meta"><div><span>开始时间（北京时间）</span><strong>{formatTime(activeJob.startedAt || activeJob.createdAt)}</strong></div><div><span>运行时长</span><strong>{elapsed(activeJob)}</strong></div></div>
                  {(activeJob.status === 'running' || activeJob.status === 'queued') && <button className="cancel-button" onClick={cancel}><Pause size={16} />终止任务</button>}
                  {activeJob.resumeAvailable && !rateLimitDetected && (
                    <div className="resume-strip">
                      <span><RotateCcw size={18} /><span><strong>{activeJob.status === 'failed' ? '失败检查点已保留' : '未完成检查点已保留'}</strong><small>已采集 {activeJob.scrapedCount ?? 0} / {activeJob.discoveredCount ?? 0} 篇，{activeJob.status === 'failed' ? '重试' : '续跑'}会跳过已完成正文。</small></span></span>
                      <button type="button" onClick={() => void resumeJob(activeJob)} disabled={submitting}><Play size={16} fill="currentColor" />{activeJob.status === 'failed' ? '从检查点重试' : '从检查点续跑'}</button>
                    </div>
                  )}
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
                <div><span className="step-label">COVERAGE & QUALITY</span><h2>{activeAnalysisMode === 'general' ? '内容覆盖与事实边界' : '结果覆盖与事实边界'}</h2></div>
              <span className={`coverage-state ${coverage?.gatePassed === false ? 'failed' : coverage?.gatePassed ? 'passed' : ''}`}>{coverage?.gatePassed === true ? '质量门禁通过' : coverage?.gatePassed === false ? `质量门禁未通过 · ${coverage.issueCount ?? '-'} 项` : activeJob?.status === 'completed' ? '等待覆盖摘要' : '随任务更新'}</span>
            </div>
            <div className="coverage-content">
              <div className="coverage-grid">
                {coverageCards.map(({ label, value, icon: Icon }) => <div className="coverage-metric" key={label}><Icon size={17} /><span>{label}</span><strong>{value ?? '-'}</strong></div>)}
              </div>
              <p className={`coverage-note ${securityTimedOut ? 'warning' : ''}`}><ShieldCheck size={16} />{securityTimedOut ? `安全验证在 ${securityTimeoutLabel}内未解除，采集已按规则停止；当前结果来自已保存正文的整理与分析，未采集链接保留缺失状态。` : activeAnalysisMode === 'general' ? '所有已发现内容均会尝试采集正文和原图；AI 栏目必须给出原文依据，无法确认的信息保留待补全状态。' : '所有已发现卡片均会尝试打开正文；失败、访问受限或缺少联系方式的记录保留状态与原因，不补造内容。'}</p>
            </div>
          </section>

          <section className="panel results-panel" id="results" aria-label={activeAnalysisMode === 'general' ? '逐链接内容分析结果' : '逐链接投递结果'}>
            <div className="panel-heading compact">
              <div><span className="step-label">{activeAnalysisMode === 'general' ? results?.presentation?.eyebrow || 'KEYWORD CONTENT INTELLIGENCE' : 'PER-LINK APPLICATION INTELLIGENCE'}</span><h2>{activeAnalysisMode === 'general' ? results?.presentation?.title || `${activeJob?.keyword || request.keyword || '关键词'}内容洞察` : '逐链接岗位与投递文案'}</h2>{activeAnalysisMode === 'general' && results?.presentation?.description ? <p className="result-heading-description">{results.presentation.description}</p> : null}</div>
              <div className="result-heading-meta">
                <span className={`runtime-badge ${codexRuntime?.status === 'completed' ? 'passed' : ''}`}>{activeAnalysisMode === 'general' ? 'AI 内容流' : 'AI 质量流'} · {String(codexRuntime?.status || '等待结果')}</span>
                <span className="count-badge">{results?.total ?? activeJob?.applicationCount ?? 0}</span>
              </div>
            </div>
            {completionFlow && <MissingCompletionFlowPanel
              flow={completionFlow}
              job={completionFlow.jobId === activeJob?.id ? activeJob : null}
              noun={activeAnalysisMode === 'general' ? '内容分析' : '岗位信息'}
              onDismiss={() => setCompletionFlow(null)}
            />}
            {!results?.available ? (
              <div className="result-empty">{activeAnalysisMode === 'general' ? <BookOpenCheck size={28} /> : <UserRoundSearch size={28} />}<strong>{resultsLoading ? '正在读取分析结果' : activeJob?.status === 'running' ? activeAnalysisMode === 'general' ? '发现内容后将自动采集正文、图片并生成 AI 模块' : '发现岗位后将自动解析到这里' : '当前任务还没有结构化分析结果'}</strong></div>
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
                onSort={(value) => { setResultOffset(0); setResultSort(value) }}
                onTimeRange={(value) => { setResultOffset(0); setResultTimeRange(value) }}
                onReset={() => { setResultOffset(0); setResultSort('newest'); setResultTimeRange('all') }}
                onComplete={() => void completeMissingResults()}
                onPage={(offset) => activeJob && void loadResults(activeJob.id, offset)}
                onPreview={openImagePreview}
                onCopy={copyText}
              />
            ) : (
              <>
              <div className="results-control-bar">
                <div className="result-stats" aria-label="岗位卡统计">
                  <span><strong>{resultFilterStats(results).all}</strong>全部岗位</span>
                  <span className={(resultSort !== 'newest' || resultTimeRange !== 'all') ? 'active-filter-stat' : ''}><strong>{results.total}</strong>筛选结果</span>
                  <span className={resultFilterStats(results).incomplete ? 'warning' : ''}><strong>{resultFilterStats(results).incomplete}</strong>信息未完整</span>
                  <span><strong>{resultFilterStats(results).withImages}</strong>含图片</span>
                  <span><strong>{resultFilterStats(results).unknown}</strong>日期待确认</span>
                </div>
                <div className="result-controls" aria-busy={resultsLoading}>
                  <label><ArrowUpDown size={15} /><span>排序</span><select aria-label="岗位卡时间排序" value={resultSort} disabled={resultsLoading} onChange={(event) => { setResultOffset(0); setResultSort(event.target.value as typeof resultSort) }}><option value="newest">最新发布优先</option><option value="oldest">最早发布优先</option></select></label>
                  <label><CalendarClock size={15} /><span>时间</span><select aria-label="岗位卡时间筛选" value={resultTimeRange} disabled={resultsLoading} onChange={(event) => { setResultOffset(0); setResultTimeRange(event.target.value as typeof resultTimeRange) }}><option value="all">全部时间</option><option value="1">近 24 小时</option><option value="3">近 3 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="unknown">日期待确认</option></select></label>
                  {(resultSort !== 'newest' || resultTimeRange !== 'all') && <button className="reset-result-filter" type="button" disabled={resultsLoading} onClick={() => { setResultOffset(0); setResultSort('newest'); setResultTimeRange('all') }} title="恢复最新发布优先并显示全部时间"><RotateCcw size={15} />重置筛选</button>}
                  <button className="complete-missing-button" type="button" disabled={!resultFilterStats(results).incomplete || completingMissing || submitting || restoringAi || resultsLoading} onClick={() => void completeMissingResults()} title={aiSession ? '自动核对缺失项，并创建或接管补全任务' : '自动恢复已保存的 AI 配置并补全缺失项'}>{restoringAi || completingMissing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{restoringAi ? '正在恢复 AI' : completingMissing ? '正在核对任务' : activeJob?.status === 'running' || activeJob?.status === 'queued' ? '查看补全进度' : '一键智能补全'}</button>
                </div>
              </div>
              <div className="results-workspace">
                <div className="result-index">
                  <div className="result-index-head"><span>岗位列表</span><small>{resultOffset + 1}-{Math.min(resultOffset + results.items.length, results.total)} / {results.total}</small></div>
                  <div className="result-rows">
                    {results.items.map((item) => {
                      const routeLabels = deliveryRoutes(item).map((route) => route.label)
                      const draftState = item.delivery?.action === 'email_sent'
                        ? '已发送'
                        : item.cover_letter_evaluation?.passed
                          ? '≥ 90'
                          : item.outreach?.runtime_status === 'fallback_missing_job_body'
                            ? '信息未完整'
                            : item.outreach?.runtime_status === 'fallback_model_error'
                              ? 'AI 失败 · 有初稿'
                              : '待重写'
                      return (
                        <div key={item.note_id} className={`result-row ${selectedResult?.note_id === item.note_id ? 'selected' : ''}`}>
                          <ResultCardMedia result={item} onPreview={(images, index) => openImagePreview(item.title || '未命名岗位', images, index)} />
                          <button className="result-card-select" type="button" onClick={() => chooseResult(item)} aria-label={`查看岗位：${item.title || '未命名岗位'}`}>
                            <span className="result-card-copy">
                            <span className="result-card-heading">
                              <strong>{item.title || '未命名岗位'}</strong>
                              <i className={item.delivery?.action === 'email_sent' ? 'sent' : item.cover_letter_evaluation?.passed ? 'ready' : ''}>{draftState}</i>
                            </span>
                            <small>{item.publish_time?.value || '日期待核验'} · {item.cover_letter_evaluation?.score ?? '-'} 分 · {routeLabels.length ? [...new Set(routeLabels)].join(' / ') : '投递方式待确认'}</small>
                            </span>
                          </button>
                        </div>
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
                      <div><span>{selectedResult.publish_time?.value || '日期待核验'} · {selectedResult.job_card?.parse_basis === 'search_card' || !selectedResult.body ? '卡片信息兜底' : '正文解析'}</span><h3>{selectedResult.title || '未命名岗位'}</h3><small>采集时间 {formatTime(selectedResult.collected_at)} · 原始时间 {selectedResult.publish_time?.raw || '-'}</small></div>
                      {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer" title="打开原链接"><ExternalLink size={17} /></a>}
                    </header>
                    {selectedResultIncomplete && (
                      <div className="completion-callout">
                        <span><WandSparkles size={18} /><span><strong>该岗位信息尚未完整</strong><small>将从已保存检查点继续采集缺失正文，并重新执行图片理解、岗位卡整理和投递文案生成。</small></span></span>
                        <button type="button" disabled={completingMissing || submitting || restoringAi} title={aiSession ? '自动核对缺失项，并创建或接管补全任务' : '自动恢复已保存的 AI 配置并补全缺失项'} onClick={() => void completeMissingResults()}>{restoringAi ? '正在恢复 AI…' : completingMissing ? '正在核对任务…' : activeJob?.status === 'running' || activeJob?.status === 'queued' ? '查看补全进度' : '一键补全全部缺失岗位'}</button>
                      </div>
                    )}
                    {Boolean(selectedResult.media?.images?.length) && (
                      <section className="result-media" aria-label="岗位图片与理解结果">
                        <div className="result-media-heading"><span><Images size={16} /><strong>采集图片</strong><small>{selectedResult.media?.images.length} 张</small></span><i>{selectedResult.media?.analysis?.source === 'vision_model' ? 'AI 已看图' : selectedResult.media?.analysis?.source === 'image_alt_text' ? '基于图片文字' : '等待图片理解'}</i></div>
                        <div className="result-media-grid">
                          {selectedResult.media?.images.map((image, index) => <button key={`${image.url}-${index}`} type="button" onClick={() => openImagePreview(selectedResult.title || '未命名岗位', selectedResult.media?.images || [], index)} title={image.alt || `查看第 ${index + 1} 张岗位图片`}><img src={image.url} alt={image.alt || `${selectedResult.title || '岗位'}图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /><small>{imageSourceLabel(image.source)}</small><span><Maximize2 size={13} /></span></button>)}
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
                      <section className="body-section"><h4>采集正文</h4><p>{selectedResult.body || '正文尚未采集'}</p></section>
                    </div>
                    <div className="draft-stack">
                      <div className="draft-toolbar">
                        <div><span className="step-label">EDITABLE APPLICATION COPY</span><h4>投递文案编辑器</h4><p>每个岗位均生成可编辑初稿；90 分以上方可发送，发送时使用当前内容。</p></div>
                        <button className={draftDirty ? 'dirty' : ''} disabled={draftSaving || !draftDirty} onClick={() => void saveDraft()}>{draftSaving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{draftDirty ? '保存修改' : '已保存'}</button>
                      </div>
                      <section className="draft-editor"><div><h4><MessageSquare size={15} />私信文案</h4><button title="复制私信文案" onClick={() => copyText(outreachDraft(selectedResult).greeting)}><Copy size={15} /></button></div><textarea aria-label="私信文案" value={outreachDraft(selectedResult).greeting} onChange={(event) => updateDraft('greeting', event.target.value)} rows={4} /><small>{outreachDraft(selectedResult).greeting.length} 字</small></section>
                      <section className="draft-editor email-editor"><div><h4><Mail size={15} />邮件文案</h4><button title="复制投递邮件" onClick={() => copyText(`${outreachDraft(selectedResult).email_subject}\n\n${outreachDraft(selectedResult).email_body}`)}><Copy size={15} /></button></div><label><span>邮件主题</span><input aria-label="邮件主题" value={outreachDraft(selectedResult).email_subject} onChange={(event) => updateDraft('email_subject', event.target.value)} /></label><label><span>邮件正文（实际发送）</span><textarea aria-label="邮件正文" value={outreachDraft(selectedResult).email_body} onChange={(event) => updateDraft('email_body', event.target.value)} rows={7} /></label><small>{outreachDraft(selectedResult).email_body.length} 字</small></section>
                      <section className="draft-editor"><div><h4><FileText size={15} />专属 Cover Letter</h4><button title="复制 Cover Letter" onClick={() => copyText(outreachDraft(selectedResult).cover_letter)}><Copy size={15} /></button></div><textarea aria-label="Cover Letter" value={outreachDraft(selectedResult).cover_letter} onChange={(event) => updateDraft('cover_letter', event.target.value)} rows={10} /><small>{outreachDraft(selectedResult).cover_letter.length} 字 · 初稿可编辑，发送仍需通过 90 分门槛</small></section>
                    </div>
                    <div className="evaluation-panel">
                      <div><span>用人单位评分</span><strong>{selectedResult.cover_letter_evaluation?.score ?? '-'}<small>/ 100</small></strong></div>
                      <div><span>重写轮次</span><strong>{selectedResult.cover_letter_evaluation?.attempts ?? '-'}</strong></div>
                      <p>{selectedResult.cover_letter_evaluation?.passed ? '已通过 90 分投递门槛' : (selectedResult.cover_letter_evaluation?.problems || []).join('；') || '等待评分'}</p>
                    </div>
                    <div className="delivery-console">
                      <div className="delivery-target">
                        <span className={selectedEmailRoute ? 'available' : ''}><Mail size={17} /></span>
                        <div><small>邮件收件人</small><strong>{selectedEmailRoute?.target || '岗位正文未提取到邮箱'}</strong><p>{health?.emailDelivery?.configured ? `${health.emailDelivery.authMode === 'oauth2' ? 'Outlook OAuth2' : 'SMTP'} 已就绪 · 发件人 ${health.emailDelivery.from}` : '发件邮箱尚未配置，可在当前页面保存并测试后立即启用'}</p></div>
                      </div>
                      <div className="delivery-actions">
                        <button className="send-email-action" disabled={!selectedResult.cover_letter_evaluation?.passed || !selectedEmailRoute || !health?.emailDelivery?.configured || emailSending} onClick={() => void sendEmail()} title={!selectedEmailRoute ? '岗位正文中没有可验证邮箱' : !health?.emailDelivery?.configured ? '请先配置 SMTP' : '立即发送当前邮件正文'}>{emailSending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{emailSending ? '发送中' : '发送邮件'}</button>
                        <button onClick={() => document.getElementById('email-config')?.scrollIntoView({ behavior: 'smooth' })}><Settings2 size={16} />发件邮箱</button>
                        <button disabled={!selectedResult.cover_letter_evaluation?.passed || !selectedMessageRoute} onClick={() => void prepareMessage()}><MessageSquare size={16} />复制私信</button>
                        {selectedResult.note_url && <a href={selectedResult.note_url} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开岗位</a>}
                      </div>
                    </div>
                    <footer><span>生成方式：<strong>{selectedResult.outreach?.generation_mode || '-'}</strong></span><span>当前状态：<strong>{deliveryStatusLabel(selectedResult.delivery?.action)}</strong></span>{selectedResult.delivery?.email?.sentAt && <span>发送时间：<strong>{formatTime(selectedResult.delivery.email.sentAt)}</strong></span>}</footer>
                  </article>
                ) : <div className="result-empty"><FileText size={28} /><strong>选择一个岗位查看详情</strong></div>}
              </div>
              </>
            )}
          </section>

          <div className="secondary-grid">
            <section className="panel history-panel" id="history">
              <div className="panel-heading compact">
                <div><span className="step-label">RUN HISTORY</span><h2>任务记录 <small>{workspaceJobs.length}</small></h2></div>
                <div className="history-heading-actions">
                  <span>当前模式 {workspaceJobs.length} 条 · 全部 {jobs.length} 条</span>
                  <button className="icon-text-button" onClick={loadJobs}><RefreshCw size={15} />刷新</button>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>状态</th><th>关键词</th><th>创建时间（北京时间）</th><th>范围</th><th>产物</th><th>操作</th></tr></thead>
                  <tbody>
                    {visibleWorkspaceJobs.length ? visibleWorkspaceJobs.map((job) => {
                      const retryFailedJob = job.status === 'failed'
                      return <tr key={job.id} className={activeJob?.id === job.id ? 'selected-row' : ''} onClick={() => selectJob(job)}>
                        <td><StatusPill status={job.status} /></td><td><strong>{job.keyword}</strong><small>{workspaceMode === 'general' ? '内容采集' : '岗位投递'} · #{job.id.slice(0, 8)}</small></td><td>{formatTime(job.createdAt)}</td><td>{job.config?.limit === 0 ? '全量 · 不限时间' : `历史限定 ${job.config?.limit ?? '-'} 篇`} · {job.config?.searchSort === 'comprehensive' ? '综合' : '最新'}</td><td>{job.artifactCount ?? job.artifacts?.length ?? 0}</td><td>{job.resumeAvailable ? <button className="row-resume" title={retryFailedJob ? '从检查点重试' : '从检查点续跑'} onClick={(event) => { event.stopPropagation(); void resumeJob(job) }} disabled={submitting}><RotateCcw size={14} />{retryFailedJob ? '重试' : '续跑'}</button> : <button className="row-open" title="查看任务"><ChevronDown size={15} /></button>}</td>
                      </tr>
                    }) : <tr className="empty-row"><td colSpan={6}>{loading ? '正在读取任务记录...' : workspaceMode === 'general' ? '还没有内容采集任务' : '还没有岗位投递任务'}</td></tr>}
                  </tbody>
                </table>
              </div>
              {workspaceJobs.length > 0 && <div className="history-pagination">
                <span>显示 {historyStart + 1}-{Math.min(historyStart + effectiveHistoryPageSize, workspaceJobs.length)} / {workspaceJobs.length}</span>
                <div className="history-page-controls">
                  <label>每页
                    <select value={historyPageSize} onChange={(event) => setHistoryPageSize(Number(event.target.value))} aria-label="每页显示任务数">
                      <option value={20}>20</option>
                      <option value={50}>50</option>
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
      {imagePreview && <ImagePreview preview={imagePreview} onClose={closeImagePreview} onChange={changePreviewImage} />}
    </div>
  )
}

export default App
