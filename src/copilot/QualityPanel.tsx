import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Activity,
  CheckCircle2,
  Database,
  Download,
  FileDown,
  GitCompareArrows,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'

import type {
  DataCopilotMessageData,
  DataCopilotQualityState,
  DataCopilotSession,
  DataCopilotTransport,
} from '../DataCopilotContext'

type Props = {
  open: boolean
  session: DataCopilotSession | null
  messages: DataCopilotMessageData[]
  transport: DataCopilotTransport
  onClose: () => void
  onUpgrade: (session: DataCopilotSession) => void
}

const emptyQuality: DataCopilotQualityState = {
  usage: { records: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, latencyMs: 0, estimatedCostUsd: 0 },
  traces: [], snapshots: [], artifacts: [], evaluations: [],
}

export function DataCopilotQualityPanel({ open, session, messages, transport, onClose, onUpgrade }: Props) {
  const [quality, setQuality] = useState<DataCopilotQualityState>(emptyQuality)
  const [busy, setBusy] = useState<'load' | 'evaluate' | 'export' | 'upgrade' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!session?.jobId || !transport.loadQuality) return
    setBusy('load')
    setError('')
    try {
      setQuality(await transport.loadQuality(session.id, session.jobId))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }, [session, transport])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  const latestSnapshot = quality.snapshots[0]
  const snapshotCurrent = !latestSnapshot || latestSnapshot.id === session?.snapshotId
  const latestEvaluation = quality.evaluations[0]
  const passPercent = Math.round((latestEvaluation?.summary.passRate || 0) * 100)
  const verifiedArtifacts = quality.artifacts.filter((artifact) => artifact.status === 'ready' && artifact.sha256)
  const recentTraces = useMemo(() => quality.traces.slice(0, 8), [quality.traces])

  const runEvaluation = async () => {
    if (!transport.runGoldenEvaluation) return
    setBusy('evaluate')
    setError('')
    try {
      await transport.runGoldenEvaluation()
      await load()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const exportManifest = async () => {
    if (!session || !transport.createArtifact) return
    setBusy('export')
    setError('')
    const body = [
      `# ${session.title}`,
      '',
      `- Conversation: ${session.id}`,
      `- Task: ${session.jobId || 'unbound'}`,
      `- Snapshot: ${session.snapshotId || 'unknown'}`,
      `- Model: ${session.modelId || 'unknown'}`,
      `- Messages: ${messages.length}`,
      `- Tool calls: ${quality.usage.toolCalls}`,
      `- Verified artifacts: ${verifiedArtifacts.length}`,
      '',
      '## Conversation',
      '',
      ...messages.map((message) => `### ${message.role}\n\n${message.content}\n`),
    ].join('\n')
    try {
      await transport.createArtifact(session.id, {
        format: 'markdown', name: `data-copilot-${session.id.slice(0, 12)}.md`, content: body,
      })
      await load()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  const upgradeSnapshot = async () => {
    if (!session || !transport.upgradeSnapshot) return
    setBusy('upgrade')
    setError('')
    try {
      const upgraded = await transport.upgradeSnapshot(session.id)
      onUpgrade(upgraded)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }

  if (!open || !session) return null

  return (
    <div style={styles.scrim} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <style>{`
        @media(max-width:620px){
          .data-copilot-quality-dialog{max-height:calc(100vh - 16px)!important}
          .data-copilot-quality-metrics{grid-template-columns:repeat(2,minmax(0,1fr))!important}
          .data-copilot-quality-snapshot{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)!important}
          .data-copilot-quality-snapshot button{grid-column:1 / -1}
        }
      `}</style>
      <section className="data-copilot-quality-dialog" style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="copilot-quality-title">
        <header style={styles.header}>
          <div style={styles.titleGroup}>
            <span style={styles.titleIcon}><Activity size={18} aria-hidden="true" /></span>
            <div>
              <strong id="copilot-quality-title" style={styles.title}>运行与质量</strong>
              <div style={styles.subtitle}>{session.snapshotId} · {session.modelId || '默认模型'}</div>
            </div>
          </div>
          <div style={styles.headerActions}>
            <button type="button" style={styles.iconButton} onClick={() => void load()} disabled={Boolean(busy)} title="刷新" aria-label="刷新运行与质量数据">
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            <button type="button" style={styles.iconButton} onClick={onClose} disabled={Boolean(busy)} title="关闭" aria-label="关闭运行与质量">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div style={styles.body}>
          {error ? <div style={styles.error} role="alert">{error}</div> : null}
          <section className="data-copilot-quality-metrics" style={styles.metricBand} aria-label="质量指标">
            <Metric label="Golden Tasks" value={latestEvaluation ? `${latestEvaluation.summary.passed}/${latestEvaluation.summary.total}` : '未运行'} note={latestEvaluation ? `${passPercent}% 通过` : '等待基线'} />
            <Metric label="工具调用" value={String(quality.usage.toolCalls)} note={`${quality.usage.records} 条用量记录`} />
            <Metric label="累计耗时" value={formatDuration(quality.usage.latencyMs)} note={`${recentTraces.length} 条近期 trace`} />
            <Metric label="已验证产物" value={String(verifiedArtifacts.length)} note={`${quality.artifacts.length} 个产物`} />
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeading}>
              <span><Database size={15} aria-hidden="true" />数据快照</span>
              <StatusBadge passed={snapshotCurrent} label={snapshotCurrent ? '当前版本' : '发现新版本'} />
            </div>
            <div className="data-copilot-quality-snapshot" style={styles.snapshotRow}>
              <div><span style={styles.label}>当前</span><strong>{session.snapshotId || 'unknown'}</strong></div>
              <GitCompareArrows size={16} aria-hidden="true" />
              <div><span style={styles.label}>最新</span><strong>{latestSnapshot?.id || session.snapshotId || 'unknown'}</strong></div>
              {!snapshotCurrent && transport.upgradeSnapshot ? (
                <button type="button" style={styles.primaryButton} onClick={() => void upgradeSnapshot()} disabled={Boolean(busy)}>
                  {busy === 'upgrade' ? <LoaderCircle size={14} style={styles.spin} aria-hidden="true" /> : <GitCompareArrows size={14} aria-hidden="true" />}
                  迁移到新快照
                </button>
              ) : null}
            </div>
            {latestSnapshot?.manifestHash ? <code style={styles.hash}>sha256:{latestSnapshot.manifestHash}</code> : null}
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeading}>
              <span><ShieldCheck size={15} aria-hidden="true" />评测与导出</span>
            </div>
            <div style={styles.actionRow}>
              <button type="button" style={styles.secondaryButton} onClick={() => void runEvaluation()} disabled={Boolean(busy) || !transport.runGoldenEvaluation}>
                {busy === 'evaluate' ? <LoaderCircle size={14} style={styles.spin} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                运行 30 项评测
              </button>
              <button type="button" style={styles.secondaryButton} onClick={() => void exportManifest()} disabled={Boolean(busy) || !transport.createArtifact}>
                {busy === 'export' ? <LoaderCircle size={14} style={styles.spin} aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
                导出会话报告
              </button>
            </div>
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeading}>
              <span><FileDown size={15} aria-hidden="true" />产物</span>
              <small>{quality.artifacts.length}</small>
            </div>
            <div style={styles.list}>
              {quality.artifacts.length ? quality.artifacts.map((artifact) => (
                <div key={artifact.id} style={styles.listRow}>
                  <CheckCircle2 size={15} color={artifact.sha256 ? '#08735c' : '#7a827d'} aria-hidden="true" />
                  <div style={styles.listCopy}>
                    <strong>{artifact.name}</strong>
                    <span>{artifact.format.toUpperCase()} · {formatBytes(artifact.size)} · {artifact.sha256 ? artifact.sha256.slice(0, 12) : '未校验'}</span>
                  </div>
                  <a href={artifact.url} style={styles.downloadButton} title="下载" aria-label={`下载 ${artifact.name}`}>
                    <Download size={15} aria-hidden="true" />
                  </a>
                </div>
              )) : <div style={styles.empty}>暂无会话产物</div>}
            </div>
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeading}><span><Activity size={15} aria-hidden="true" />近期 Trace</span></div>
            <div style={styles.list}>
              {recentTraces.length ? recentTraces.map((trace) => (
                <div key={trace.id} style={styles.traceRow}>
                  <StatusBadge passed={trace.status === 'completed' || trace.status === 'passed'} label={trace.status} />
                  <code>{trace.operation}</code>
                  <span>{formatDuration(trace.durationMs)}</span>
                </div>
              )) : <div style={styles.empty}>暂无运行追踪</div>}
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div style={styles.metric}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
}

function StatusBadge({ passed, label }: { passed: boolean; label: string }) {
  return <span style={{ ...styles.badge, ...(passed ? styles.badgePassed : styles.badgeAttention) }}>{label}</span>
}

function errorText(value: unknown) { return value instanceof Error ? value.message : String(value) }
function formatDuration(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms` }
function formatBytes(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B` }

const styles: Record<string, CSSProperties> = {
  scrim: { position: 'fixed', zIndex: 20, inset: 0, display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(29, 36, 32, .28)' },
  dialog: { display: 'grid', width: 'min(760px, 100%)', maxHeight: 'min(820px, calc(100vh - 32px))', gridTemplateRows: '58px minmax(0, 1fr)', overflow: 'hidden', border: '1px solid #cfd6d1', borderRadius: 7, background: '#fff', boxShadow: '0 20px 60px rgba(24, 34, 28, .22)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px 0 16px', borderBottom: '1px solid #e1e5e2' },
  titleGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  titleIcon: { display: 'grid', width: 30, height: 30, placeItems: 'center', borderRadius: 6, background: '#e9f4ef', color: '#08735c' },
  title: { display: 'block', color: '#202722', fontSize: 14 },
  subtitle: { marginTop: 2, color: '#737c76', fontSize: 10 },
  headerActions: { display: 'flex', gap: 4 },
  iconButton: { display: 'grid', width: 30, height: 30, placeItems: 'center', padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: '#5f6963', cursor: 'pointer' },
  body: { minHeight: 0, overflowY: 'auto' },
  error: { padding: '9px 16px', borderBottom: '1px solid #efd7d3', background: '#fff3f1', color: '#9a3528', fontSize: 12 },
  metricBand: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', borderBottom: '1px solid #e2e6e3', background: '#f7f9f7' },
  metric: { display: 'grid', minWidth: 0, gap: 3, padding: '14px 16px', borderRight: '1px solid #e2e6e3' },
  section: { padding: '15px 16px', borderBottom: '1px solid #e5e8e6' },
  sectionHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, color: '#2b342f', fontSize: 12, fontWeight: 650 },
  snapshotRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr) auto', alignItems: 'center', gap: 12, color: '#66706a' },
  label: { display: 'block', marginBottom: 3, color: '#7b837e', fontSize: 9 },
  hash: { display: 'block', overflow: 'hidden', marginTop: 10, padding: '7px 8px', borderRadius: 4, background: '#f3f5f3', color: '#59635d', fontSize: 10, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actionRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  primaryButton: { display: 'inline-flex', minHeight: 32, alignItems: 'center', justifyContent: 'center', gap: 7, padding: '0 11px', border: '1px solid #08735c', borderRadius: 5, background: '#08735c', color: '#fff', font: 'inherit', fontSize: 11, cursor: 'pointer' },
  secondaryButton: { display: 'inline-flex', minHeight: 32, alignItems: 'center', gap: 7, padding: '0 11px', border: '1px solid #ccd3ce', borderRadius: 5, background: '#fff', color: '#344039', font: 'inherit', fontSize: 11, cursor: 'pointer' },
  list: { borderTop: '1px solid #e5e8e6' },
  listRow: { display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) 30px', alignItems: 'center', gap: 8, minHeight: 46, borderBottom: '1px solid #edf0ee' },
  listCopy: { display: 'grid', minWidth: 0, gap: 3 },
  downloadButton: { display: 'grid', width: 28, height: 28, placeItems: 'center', borderRadius: 4, color: '#54615a' },
  traceRow: { display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr) 64px', alignItems: 'center', gap: 8, minHeight: 36, borderBottom: '1px solid #edf0ee', color: '#67706b', fontSize: 10 },
  badge: { display: 'inline-flex', width: 'fit-content', alignItems: 'center', minHeight: 20, padding: '0 7px', borderRadius: 10, fontSize: 9, fontWeight: 650 },
  badgePassed: { background: '#e7f5ef', color: '#08735c' },
  badgeAttention: { background: '#fff2d9', color: '#8a5b00' },
  empty: { padding: '18px 0', color: '#7b837e', fontSize: 11 },
  spin: { animation: 'data-copilot-spin 1s linear infinite' },
}
