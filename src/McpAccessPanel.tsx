import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Clipboard,
  KeyRound,
  Link2,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

type McpGrant = {
  grantId: string
  name: string
  tokenPrefix: string
  conversationId: string
  jobId: string
  snapshotId: string
  mode: string
  scopes: string[]
  allowedTools: string[]
  allowedResources: string[]
  maxRisk: McpRisk
  status: string
  createdAt: string
  expiresAt: string
  lastUsedAt?: string
}

type McpRisk = 'read' | 'write' | 'approval_required'

type McpCapabilities = {
  conversationId: string
  jobId: string
  snapshotId: string
  manifestHash: string
  mode: string
  scopes: string[]
  resources: Array<{ name: string; uri: string; mimeType?: string; scope: string }>
  tools: Array<{ name: string; description?: string; scopes: string[]; risk: McpRisk }>
  riskLevels: McpRisk[]
}

type McpSession = {
  sessionId: string
  grantId: string
  transport: string
  status: string
  client?: { name?: string; version?: string }
  createdAt: string
  lastSeenAt: string
}

type McpToolRun = {
  callId: string
  grantId: string
  toolName: string
  status: string
  approvalId?: string
  startedAt: string
  completedAt?: string
  error?: { code?: string; message?: string }
}

type McpAuditEvent = {
  auditId: string
  action: string
  status: string
  occurredAt: string
  detail?: { toolName?: string; sessionId?: string }
}

type McpStatus = {
  ok: boolean
  schemaVersion: number
  grants: { active: number; total: number }
  sessions: { active: number; total: number }
}

type Tab = 'grants' | 'runs' | 'sessions' | 'audit'

export function McpAccessPanel({
  open,
  conversationId,
  onClose,
}: {
  open: boolean
  conversationId?: string | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('grants')
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [grants, setGrants] = useState<McpGrant[]>([])
  const [sessions, setSessions] = useState<McpSession[]>([])
  const [runs, setRuns] = useState<McpToolRun[]>([])
  const [events, setEvents] = useState<McpAuditEvent[]>([])
  const [capabilities, setCapabilities] = useState<McpCapabilities | null>(null)
  const [ttlHours, setTtlHours] = useState(24)
  const [grantName, setGrantName] = useState('Local MCP access')
  const [maxRisk, setMaxRisk] = useState<McpRisk>('approval_required')
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [selectedResources, setSelectedResources] = useState<string[]>([])
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [toolQuery, setToolQuery] = useState('')
  const [createdToken, setCreatedToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!open) return
    setBusy((value) => value || 'refresh')
    try {
      const [nextStatus, nextGrants, nextSessions, nextRuns, nextEvents] = await Promise.all([
        request<McpStatus>('/api/mcp/status'),
        request<{ grants: McpGrant[] }>('/api/mcp/grants?limit=200'),
        request<{ sessions: McpSession[] }>('/api/mcp/sessions?limit=200'),
        request<{ toolRuns: McpToolRun[] }>('/api/mcp/tool-runs?limit=200'),
        request<{ events: McpAuditEvent[] }>('/api/mcp/audit?limit=200'),
      ])
      setStatus(nextStatus)
      setGrants(nextGrants.grants)
      setSessions(nextSessions.sessions)
      setRuns(nextRuns.toolRuns)
      setEvents(nextEvents.events)
      setError('')
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((value) => value === 'refresh' ? '' : value)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load, open])

  useEffect(() => {
    if (!open || !conversationId) {
      setCapabilities(null)
      return
    }
    let cancelled = false
    void request<McpCapabilities>(`/api/mcp/capabilities?conversationId=${encodeURIComponent(conversationId)}`)
      .then((value) => {
        if (cancelled) return
        setCapabilities(value)
        setSelectedScopes(value.scopes)
        setSelectedResources(value.resources.map((item) => item.name))
        setSelectedTools(value.tools.map((item) => item.name))
        setError('')
      })
      .catch((value) => { if (!cancelled) setError(toError(value).message) })
    return () => { cancelled = true }
  }, [conversationId, open])

  const createGrant = async () => {
    if (!conversationId) return
    setBusy('create')
    try {
      const result = await request<{ grant: McpGrant; token: string }>('/api/mcp/grants', {
        method: 'POST',
        body: JSON.stringify({
          name: grantName,
          conversationId,
          allowedScopes: selectedScopes,
          allowedResources: selectedResources,
          allowedTools: selectedTools,
          maxRisk,
          ttlSeconds: ttlHours * 60 * 60,
        }),
      })
      setCreatedToken(result.token)
      setCopied(false)
      setGrants((current) => [result.grant, ...current.filter((item) => item.grantId !== result.grant.grantId)])
      setError('')
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy('')
    }
  }

  const replaceGrant = async (grant: McpGrant, action: 'rotate' | 'rebind') => {
    if (action === 'rebind' && !conversationId) return
    const message = action === 'rotate'
      ? '轮换会立即撤销旧令牌，并签发一个只显示一次的新令牌。'
      : `重新绑定会撤销旧令牌，并绑定到当前会话 ${conversationId}。`
    if (!window.confirm(message)) return
    setBusy(`${action}:${grant.grantId}`)
    try {
      const result = await request<{ grant: McpGrant; token: string }>(
        `/api/mcp/grants/${encodeURIComponent(grant.grantId)}/${action}`,
        { method: 'POST', body: JSON.stringify(action === 'rebind' ? { conversationId } : {}) },
      )
      setCreatedToken(result.token)
      setCopied(false)
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy('')
    }
  }

  const changeRisk = (risk: McpRisk) => {
    setMaxRisk(risk)
    if (!capabilities) return
    setSelectedTools((current) => current.filter((name) => {
      const tool = capabilities.tools.find((item) => item.name === name)
      return tool && riskRank(tool.risk) <= riskRank(risk)
    }))
  }

  const toggleScope = (scope: string) => {
    const next = toggleValue(selectedScopes, scope)
    setSelectedScopes(next)
    if (!capabilities) return
    setSelectedResources((current) => current.filter((name) => {
      const resource = capabilities.resources.find((item) => item.name === name)
      return resource && next.includes(resource.scope)
    }))
    setSelectedTools((current) => current.filter((name) => {
      const tool = capabilities.tools.find((item) => item.name === name)
      return tool && tool.scopes.every((required) => next.includes(required))
    }))
  }

  const revokeGrant = async (grantId: string) => {
    if (!window.confirm('撤销后，使用此 Grant 的客户端会立即失去访问权限。')) return
    setBusy(grantId)
    try {
      await request(`/api/mcp/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' })
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy('')
    }
  }

  const decide = async (run: McpToolRun, action: 'approve' | 'reject') => {
    if (!run.approvalId) return
    setBusy(run.callId)
    try {
      await request(`/api/mcp/approvals/${encodeURIComponent(run.approvalId)}/decision`, {
        method: 'POST', body: JSON.stringify({ action }),
      })
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy('')
    }
  }

  const copyToken = async () => {
    await navigator.clipboard.writeText(createdToken)
    setCopied(true)
  }

  if (!open) return null
  const pending = runs.filter((run) => run.status === 'approval_required')
  const visibleTools = capabilities?.tools.filter((tool) => (
    `${tool.name} ${tool.description || ''}`.toLocaleLowerCase().includes(toolQuery.toLocaleLowerCase())
  )) || []
  const canCreate = Boolean(
    conversationId && capabilities && grantName.trim()
    && selectedScopes.length && selectedResources.length && selectedTools.length && !busy,
  )

  return (
    <div className="mcp-access-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="mcp-access-panel" role="dialog" aria-modal="true" aria-labelledby="mcp-access-title">
        <style>{mcpStyles}</style>
        <header className="mcp-access-header">
          <div className="mcp-access-heading">
            <span className="mcp-access-heading-icon"><ShieldCheck size={18} aria-hidden="true" /></span>
            <span>
              <strong id="mcp-access-title">MCP 访问控制</strong>
              <small>{status ? `v${status.schemaVersion} · ${status.grants.active} 个有效 Grant · ${status.sessions.active} 个活动会话` : '读取中'}</small>
            </span>
          </div>
          <div className="mcp-access-header-actions">
            <button type="button" className="mcp-icon-button" onClick={() => void load()} title="刷新" aria-label="刷新" disabled={Boolean(busy)}>
              <RefreshCw size={16} className={busy === 'refresh' ? 'mcp-spin' : ''} aria-hidden="true" />
            </button>
            <button type="button" className="mcp-icon-button" onClick={onClose} title="关闭" aria-label="关闭">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav className="mcp-tabs" aria-label="MCP 管理视图">
          {([
            ['grants', 'Grant', grants.length],
            ['runs', '工具运行', pending.length || runs.length],
            ['sessions', '会话', sessions.length],
            ['audit', '审计', events.length],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </nav>

        {error ? <div className="mcp-error" role="alert"><XCircle size={15} aria-hidden="true" />{error}</div> : null}

        <div className="mcp-access-body">
          {tab === 'grants' ? (
            <>
              <div className="mcp-create-bar">
                <div>
                  <label htmlFor="mcp-grant-name">Grant 名称</label>
                  <input id="mcp-grant-name" value={grantName} maxLength={100} onChange={(event) => setGrantName(event.target.value)} />
                  <small>{capabilities ? `${capabilities.jobId} · ${capabilities.snapshotId}` : conversationId || '未选择会话'}</small>
                </div>
                <label>
                  <span>有效期</span>
                  <select value={ttlHours} onChange={(event) => setTtlHours(Number(event.target.value))}>
                    <option value={1}>1 小时</option>
                    <option value={24}>24 小时</option>
                    <option value={168}>7 天</option>
                    <option value={720}>30 天</option>
                  </select>
                </label>
                <button type="button" className="mcp-primary-button" onClick={() => void createGrant()} disabled={!canCreate}>
                  {busy === 'create' ? <LoaderCircle size={15} className="mcp-spin" aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
                  创建 Grant
                </button>
              </div>

              {capabilities ? (
                <div className="mcp-capability-editor">
                  <fieldset>
                    <legend>最大风险</legend>
                    <div className="mcp-segments">
                      {(['read', 'write', 'approval_required'] as const).map((risk) => (
                        <button key={risk} type="button" aria-pressed={maxRisk === risk} onClick={() => changeRisk(risk)}>
                          {risk === 'approval_required' ? '需审批' : risk === 'write' ? '写入' : '只读'}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Scopes</legend>
                    <div className="mcp-check-list">
                      {capabilities.scopes.map((scope) => (
                        <label key={scope}><input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} /><span>{scope}</span></label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>资源</legend>
                    <div className="mcp-check-list">
                      {capabilities.resources.map((resource) => (
                        <label key={resource.name}>
                          <input type="checkbox" checked={selectedResources.includes(resource.name)} disabled={!selectedScopes.includes(resource.scope)} onChange={() => setSelectedResources(toggleValue(selectedResources, resource.name))} />
                          <span>{resource.name}<small>{resource.scope}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="mcp-tools-fieldset">
                    <legend>工具 allowlist</legend>
                    <input className="mcp-tool-search" value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} placeholder="搜索工具" aria-label="搜索工具" />
                    <div className="mcp-check-list tools">
                      {visibleTools.map((tool) => {
                        const unavailable = riskRank(tool.risk) > riskRank(maxRisk) || tool.scopes.some((scope) => !selectedScopes.includes(scope))
                        return (
                          <label key={tool.name}>
                            <input type="checkbox" checked={selectedTools.includes(tool.name)} disabled={unavailable} onChange={() => setSelectedTools(toggleValue(selectedTools, tool.name))} />
                            <span>{tool.name}<small>{tool.risk} · {tool.scopes.join(', ')}</small></span>
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                </div>
              ) : null}

              {createdToken ? (
                <div className="mcp-token-once">
                  <div><strong>新 Grant 令牌</strong><small>关闭后不再显示</small></div>
                  <code>{createdToken}</code>
                  <button type="button" className="mcp-icon-button" onClick={() => void copyToken()} title="复制令牌" aria-label="复制令牌">
                    {copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
                  </button>
                  <button type="button" className="mcp-icon-button" onClick={() => setCreatedToken('')} title="清除" aria-label="清除">
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}

              <div className="mcp-table" role="table" aria-label="MCP Grant">
                <div className="mcp-table-head" role="row"><span>状态 / 绑定</span><span>权限</span><span>时间</span><span /></div>
                {grants.map((grant) => (
                  <div className="mcp-table-row" role="row" key={grant.grantId}>
                    <span><b data-status={grant.status}>{grant.status}</b><strong>{grant.name}</strong><code>{grant.tokenPrefix}</code><small>{grant.jobId} · {grant.snapshotId}</small></span>
                    <span><strong>{grant.allowedTools.length} tools · {grant.allowedResources.length} resources</strong><small>{grant.maxRisk} · {grant.scopes.join(' · ')}</small></span>
                    <span><strong>{formatTime(grant.expiresAt)}</strong><small>{grant.lastUsedAt ? `最近 ${formatTime(grant.lastUsedAt)}` : '尚未使用'}</small></span>
                    <span className="mcp-grant-actions">
                      <button type="button" className="mcp-icon-button" onClick={() => void replaceGrant(grant, 'rotate')} disabled={grant.status !== 'active' || Boolean(busy)} title="轮换令牌" aria-label="轮换令牌"><RotateCw size={15} aria-hidden="true" /></button>
                      <button type="button" className="mcp-icon-button" onClick={() => void replaceGrant(grant, 'rebind')} disabled={grant.status !== 'active' || !conversationId || Boolean(busy)} title="重新绑定到当前会话" aria-label="重新绑定到当前会话"><Link2 size={15} aria-hidden="true" /></button>
                      <button type="button" className="mcp-icon-button danger" onClick={() => void revokeGrant(grant.grantId)} disabled={grant.status !== 'active' || Boolean(busy)} title="撤销" aria-label="撤销"><Trash2 size={15} aria-hidden="true" /></button>
                    </span>
                  </div>
                ))}
                {!grants.length ? <div className="mcp-empty">暂无 Grant</div> : null}
              </div>
            </>
          ) : null}

          {tab === 'runs' ? (
            <div className="mcp-table" role="table" aria-label="MCP 工具运行">
              <div className="mcp-table-head runs" role="row"><span>工具 / 调用</span><span>状态</span><span>开始时间</span><span /></div>
              {runs.map((run) => (
                <div className="mcp-table-row runs" role="row" key={run.callId}>
                  <span><strong>{run.toolName}</strong><code>{shortId(run.callId)}</code></span>
                  <span><b data-status={run.status}>{run.status}</b><small>{run.error?.message || run.error?.code || ''}</small></span>
                  <span><strong>{formatTime(run.startedAt)}</strong><small>{run.completedAt ? formatTime(run.completedAt) : ''}</small></span>
                  <span className="mcp-run-actions">
                    {run.status === 'approval_required' ? <>
                      <button type="button" className="mcp-icon-button success" title="批准" aria-label="批准" disabled={Boolean(busy)} onClick={() => void decide(run, 'approve')}><Check size={15} aria-hidden="true" /></button>
                      <button type="button" className="mcp-icon-button danger" title="拒绝" aria-label="拒绝" disabled={Boolean(busy)} onClick={() => void decide(run, 'reject')}><X size={15} aria-hidden="true" /></button>
                    </> : null}
                  </span>
                </div>
              ))}
              {!runs.length ? <div className="mcp-empty">暂无工具运行</div> : null}
            </div>
          ) : null}

          {tab === 'sessions' ? (
            <div className="mcp-table" role="table" aria-label="MCP 会话">
              <div className="mcp-table-head sessions" role="row"><span>客户端</span><span>传输 / 状态</span><span>最近活动</span></div>
              {sessions.map((session) => (
                <div className="mcp-table-row sessions" role="row" key={session.sessionId}>
                  <span><strong>{session.client?.name || 'unknown client'}</strong><code>{shortId(session.sessionId)}</code></span>
                  <span><b data-status={session.status}>{session.status}</b><small>{session.transport}</small></span>
                  <span><strong>{formatTime(session.lastSeenAt)}</strong><small>创建 {formatTime(session.createdAt)}</small></span>
                </div>
              ))}
              {!sessions.length ? <div className="mcp-empty">暂无会话</div> : null}
            </div>
          ) : null}

          {tab === 'audit' ? (
            <div className="mcp-audit-list">
              {events.map((event) => (
                <div key={event.auditId}><b data-status={event.status}>{event.status}</b><strong>{event.action}</strong><span>{event.detail?.toolName || event.detail?.sessionId || ''}</span><time>{formatTime(event.occurredAt)}</time></div>
              ))}
              {!events.length ? <div className="mcp-empty">暂无审计事件</div> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

async function request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message || `MCP request failed (${response.status})`)
  return body as T
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort()
}

function riskRank(value: McpRisk) {
  return value === 'approval_required' ? 2 : value === 'write' ? 1 : 0
}

const mcpStyles = `
  .mcp-access-backdrop{position:fixed;z-index:80;inset:0;display:grid;place-items:center;padding:24px;background:rgba(22,28,25,.42)}
  .mcp-access-panel{width:min(1040px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));display:grid;grid-template-rows:auto auto auto minmax(0,1fr);overflow:hidden;border:1px solid #c7cfca;border-radius:8px;background:#f7f9f8;color:#202824;box-shadow:0 24px 70px rgba(12,20,16,.24);font-size:13px}
  .mcp-access-header{display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:0 16px;border-bottom:1px solid #d8dedb;background:#fff}
  .mcp-access-heading,.mcp-access-heading>span:last-child{display:flex;align-items:center;gap:10px}.mcp-access-heading>span:last-child{align-items:flex-start;flex-direction:column;gap:1px}.mcp-access-heading small{color:#6a746f;font-size:11px}
  .mcp-access-heading-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:#e7f2ec;color:#176b49}
  .mcp-access-header-actions,.mcp-run-actions{display:flex;gap:6px;justify-content:flex-end}.mcp-icon-button{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid #ccd4d0;border-radius:5px;background:#fff;color:#44504a;cursor:pointer}.mcp-icon-button:hover{background:#edf2ef}.mcp-icon-button:disabled{opacity:.45;cursor:not-allowed}.mcp-icon-button.danger{color:#a63c3c}.mcp-icon-button.success{color:#176b49}
  .mcp-tabs{display:flex;gap:3px;padding:8px 16px;border-bottom:1px solid #d8dedb;background:#fff}.mcp-tabs button{display:flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:5px;background:transparent;color:#59635e;cursor:pointer}.mcp-tabs button[aria-pressed=true]{border-color:#b8c9bf;background:#e9f2ed;color:#185f43;font-weight:700}.mcp-tabs span{min-width:18px;padding:1px 5px;border-radius:8px;background:#dfe6e2;font-size:10px;text-align:center}
  .mcp-error{display:flex;align-items:center;gap:7px;padding:8px 16px;border-bottom:1px solid #e3bdbd;background:#fff0f0;color:#922f2f}
  .mcp-access-body{min-height:0;overflow:auto;padding:14px 16px 20px}.mcp-create-bar{display:grid;grid-template-columns:minmax(220px,1fr) 150px auto;gap:12px;align-items:end;margin-bottom:12px;padding:12px;border:1px solid #d4dcd8;border-radius:6px;background:#fff}.mcp-create-bar>div,.mcp-create-bar label{display:flex;min-width:0;flex-direction:column;gap:4px}.mcp-create-bar small{overflow:hidden;color:#65706a;text-overflow:ellipsis;white-space:nowrap}.mcp-create-bar label,.mcp-create-bar label span{font-size:11px;color:#59645e}.mcp-create-bar input,.mcp-create-bar select{height:34px;border:1px solid #c6cfca;border-radius:5px;background:#fff;padding:0 9px}
  .mcp-primary-button{display:flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 14px;border:1px solid #176b49;border-radius:5px;background:#176b49;color:#fff;font-weight:700;cursor:pointer}.mcp-primary-button:disabled{opacity:.45;cursor:not-allowed}
  .mcp-capability-editor{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(190px,1fr) minmax(180px,.9fr) minmax(270px,1.4fr);gap:12px;margin-bottom:12px;padding:12px;border:1px solid #d4dcd8;border-radius:6px;background:#fff}.mcp-capability-editor fieldset{min-width:0;margin:0;padding:0;border:0}.mcp-capability-editor legend{margin-bottom:7px;color:#59645e;font-size:11px;font-weight:700}.mcp-segments{display:grid;grid-template-columns:repeat(3,1fr);overflow:hidden;border:1px solid #c6cfca;border-radius:5px}.mcp-segments button{min-width:0;height:32px;padding:0 6px;border:0;border-left:1px solid #c6cfca;background:#fff;color:#56615b;cursor:pointer}.mcp-segments button:first-child{border-left:0}.mcp-segments button[aria-pressed=true]{background:#dfeee6;color:#155d41;font-weight:700}.mcp-check-list{display:flex;max-height:110px;flex-direction:column;gap:5px;overflow:auto}.mcp-check-list label{display:flex;align-items:flex-start;gap:6px;min-width:0;color:#36423c}.mcp-check-list input{margin:2px 0 0;accent-color:#176b49}.mcp-check-list span{display:flex;min-width:0;flex-direction:column;overflow-wrap:anywhere}.mcp-check-list small{color:#78827d;font-size:9px}.mcp-tool-search{width:100%;height:30px;margin-bottom:6px;padding:0 8px;border:1px solid #c6cfca;border-radius:5px}.mcp-check-list.tools{max-height:140px}
  .mcp-token-once{display:grid;grid-template-columns:140px minmax(0,1fr) 32px 32px;gap:8px;align-items:center;margin-bottom:12px;padding:10px 12px;border:1px solid #d3c180;border-radius:6px;background:#fff9df}.mcp-token-once>div{display:flex;flex-direction:column}.mcp-token-once small{color:#786a39;font-size:10px}.mcp-token-once code{overflow:auto;padding:7px;border-radius:4px;background:#f1e8c6;color:#4f431c;white-space:nowrap}
  .mcp-table{overflow:hidden;border:1px solid #d3dbd7;border-radius:6px;background:#fff}.mcp-table-head,.mcp-table-row{display:grid;grid-template-columns:minmax(230px,1.2fr) minmax(220px,1fr) minmax(150px,.7fr) 110px;gap:12px;align-items:center;padding:9px 12px}.mcp-table-head{background:#edf1ef;color:#65706a;font-size:11px;font-weight:700}.mcp-table-row{min-height:72px;border-top:1px solid #e4e9e6}.mcp-table-row>span{display:flex;min-width:0;flex-direction:column;gap:3px}.mcp-table-row>span:last-child{align-items:flex-end}.mcp-table-row .mcp-grant-actions{flex-direction:row;gap:5px}.mcp-table-row code,.mcp-table-row small{overflow:hidden;color:#69746e;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.mcp-table-row code{color:#3e4d46}.mcp-table-head.runs,.mcp-table-row.runs{grid-template-columns:minmax(230px,1fr) minmax(180px,.8fr) minmax(150px,.6fr) 76px}.mcp-table-head.sessions,.mcp-table-row.sessions{grid-template-columns:minmax(240px,1fr) minmax(180px,.7fr) minmax(180px,.7fr)}
  [data-status]{display:inline-flex;width:max-content;padding:2px 6px;border-radius:4px;background:#e4e9e6;color:#58635d;font-size:10px}[data-status=active],[data-status=completed]{background:#dff1e7;color:#146344}[data-status=approval_required],[data-status=pending]{background:#fff0bd;color:#795900}[data-status=failed],[data-status=rejected],[data-status=revoked]{background:#f8dede;color:#922f2f}
  .mcp-audit-list{overflow:hidden;border:1px solid #d3dbd7;border-radius:6px;background:#fff}.mcp-audit-list>div{display:grid;grid-template-columns:80px minmax(200px,1fr) minmax(150px,1fr) 140px;gap:10px;align-items:center;min-height:44px;padding:6px 12px;border-top:1px solid #e4e9e6}.mcp-audit-list>div:first-child{border-top:0}.mcp-audit-list span,.mcp-audit-list time{overflow:hidden;color:#65706a;font-size:11px;text-overflow:ellipsis;white-space:nowrap}
  .mcp-empty{display:grid;min-height:120px;place-items:center;color:#78827d}.mcp-spin{animation:mcp-access-spin 1s linear infinite}@keyframes mcp-access-spin{to{transform:rotate(360deg)}}
  @media(max-width:900px){.mcp-capability-editor{grid-template-columns:1fr 1fr}.mcp-tools-fieldset{grid-column:1/-1}}
  @media(max-width:720px){.mcp-access-backdrop{padding:0}.mcp-access-panel{width:100vw;height:100vh;border:0;border-radius:0}.mcp-create-bar{grid-template-columns:1fr 120px}.mcp-primary-button{grid-column:1/-1}.mcp-capability-editor{grid-template-columns:1fr}.mcp-tools-fieldset{grid-column:auto}.mcp-token-once{grid-template-columns:1fr 32px 32px}.mcp-token-once>div{grid-column:1/-1}.mcp-table{overflow:auto}.mcp-table-head,.mcp-table-row{min-width:820px}.mcp-tabs{overflow:auto}.mcp-audit-list>div{grid-template-columns:70px minmax(160px,1fr) 120px}.mcp-audit-list time{display:none}}
`
