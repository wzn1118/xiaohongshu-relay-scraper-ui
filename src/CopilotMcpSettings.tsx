import {
  CheckCircle2,
  FolderOpen,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

type McpTransport = 'stdio' | 'streamable_http'

type McpServer = {
  id: string
  label: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  envKeys?: string[]
  readOnlyTools?: string[]
  headerEnv?: Record<string, string> | string[]
  status: string
  lastError?: string | null
  toolCount: number
  connectedAt?: string | null
}

type McpTool = {
  name: string
  serverId?: string
}

type McpServerList = {
  servers: McpServer[]
  tools: McpTool[]
}

type CopilotCapabilities = {
  localRuntime?: {
    workspaceRoot?: string | null
    exec?: boolean
    filesystem?: boolean
    http?: boolean
  }
  outboundMcp?: {
    initialized?: boolean
    toolCount?: number
  }
}

type ServerDraft = {
  name: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string
  url: string
  env: string
  headerEnv: string
  readOnlyTools: string
}

const EMPTY_DRAFT: ServerDraft = {
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  headerEnv: '',
  readOnlyTools: '',
}

export type CopilotMcpSettingsProps = {
  open: boolean
  onClose: () => void
}

export function CopilotMcpSettings({ open, onClose }: CopilotMcpSettingsProps) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [tools, setTools] = useState<McpTool[]>([])
  const [capabilities, setCapabilities] = useState<CopilotCapabilities | null>(null)
  const [draft, setDraft] = useState<ServerDraft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy((current) => current ?? 'load')
    try {
      const [serverList, runtime] = await Promise.all([
        request<McpServerList>('/api/copilot/mcp/servers'),
        request<CopilotCapabilities>('/api/copilot/capabilities'),
      ])
      setServers(serverList.servers ?? [])
      setTools(serverList.tools ?? [])
      setCapabilities(runtime)
      setError(null)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'load' ? null : current)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [load, open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose, open])

  const connectedCount = useMemo(
    () => servers.filter((server) => server.status === 'connected').length,
    [servers],
  )
  const mcpToolCount = tools.length || capabilities?.outboundMcp?.toolCount || 0

  const beginCreate = () => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setError(null)
  }

  const beginEdit = (server: McpServer) => {
    setEditingId(server.id)
    setDraft({
      name: server.label || server.id,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      env: (server.envKeys ?? []).join('\n'),
      headerEnv: formatHeaderEnv(server.headerEnv),
      readOnlyTools: (server.readOnlyTools ?? []).join('\n'),
    })
    setError(null)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const name = draft.name.trim()
      if (!name) throw new Error('请填写 Server 名称。')
      if (draft.transport === 'stdio' && !draft.command.trim()) {
        throw new Error('stdio Server 需要 command。')
      }
      if (draft.transport === 'streamable_http') {
        try {
          new URL(draft.url.trim())
        } catch {
          throw new Error('请填写有效的 Streamable HTTP URL。')
        }
      }
      const envKeys = parseLines(draft.env)
      const headerEnv = parseHeaderEnv(draft.headerEnv)
      setBusy('save')
      const path = editingId
        ? `/api/copilot/mcp/servers/${encodeURIComponent(editingId)}`
        : '/api/copilot/mcp/servers'
      await request(path, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : { name }),
          label: name,
          enabled: draft.enabled,
          transport: draft.transport,
          command: draft.transport === 'stdio' ? draft.command.trim() : undefined,
          args: draft.transport === 'stdio' ? parseLines(draft.args) : undefined,
          env: draft.transport === 'stdio' ? envKeys : undefined,
          envKeys: draft.transport === 'stdio' ? envKeys : undefined,
          url: draft.transport === 'streamable_http' ? draft.url.trim() : undefined,
          headerEnv: draft.transport === 'streamable_http' ? headerEnv : undefined,
          readOnlyTools: parseLines(draft.readOnlyTools),
        }),
      })
      await load()
      setEditingId(null)
      setDraft(EMPTY_DRAFT)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'save' ? null : current)
    }
  }

  const refresh = async (id?: string) => {
    const operation = id ? `refresh:${id}` : 'refresh'
    setBusy(operation)
    try {
      await request(
        id
          ? `/api/copilot/mcp/servers/${encodeURIComponent(id)}/refresh`
          : '/api/copilot/mcp/refresh',
        { method: 'POST', body: '{}' },
      )
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === operation ? null : current)
    }
  }

  const remove = async (server: McpServer) => {
    if (!window.confirm(`删除 MCP Server “${server.label}”？`)) return
    const operation = `delete:${server.id}`
    setBusy(operation)
    try {
      await request(`/api/copilot/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: 'DELETE',
      })
      if (editingId === server.id) beginCreate()
      await load()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === operation ? null : current)
    }
  }

  if (!open) return null

  const local = capabilities?.localRuntime
  return (
    <div
      className="copilot-runtime-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <style>{runtimeStyles}</style>
      <section
        className="copilot-runtime-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copilot-runtime-title"
      >
        <header className="copilot-runtime-header">
          <div className="copilot-runtime-heading">
            <span><Server size={17} aria-hidden="true" /></span>
            <div>
              <strong id="copilot-runtime-title">工具与 MCP Server</strong>
              <small>{connectedCount}/{servers.length} connected · {mcpToolCount} MCP tools</small>
            </div>
          </div>
          <div className="copilot-runtime-header-actions">
            <button type="button" onClick={beginCreate} title="新增 MCP Server" aria-label="新增 MCP Server">
              <Plus size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} title="刷新全部 Server" aria-label="刷新全部 Server">
              {busy === 'refresh'
                ? <LoaderCircle className="copilot-runtime-spin" size={16} aria-hidden="true" />
                : <RefreshCw size={16} aria-hidden="true" />}
            </button>
            <button type="button" onClick={onClose} disabled={Boolean(busy)} title="关闭" aria-label="关闭">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="copilot-runtime-capabilities" aria-label="本地 Runtime 能力">
          <Capability icon={<FolderOpen size={15} aria-hidden="true" />} label="Workspace" active={local?.filesystem} />
          <Capability icon={<Terminal size={15} aria-hidden="true" />} label="Exec" active={local?.exec} />
          <Capability icon={<Globe2 size={15} aria-hidden="true" />} label="HTTP" active={local?.http} />
          <Capability icon={<Wrench size={15} aria-hidden="true" />} label={`${mcpToolCount} MCP tools`} active={mcpToolCount > 0} />
          {local?.workspaceRoot ? <code title={local.workspaceRoot}>{local.workspaceRoot}</code> : null}
        </div>

        {error ? <div className="copilot-runtime-error" role="alert"><XCircle size={15} aria-hidden="true" />{error}</div> : null}

        <div className="copilot-runtime-body">
          <div className="copilot-runtime-list" aria-label="MCP Server 列表">
            {servers.map((server) => (
              <div className="copilot-runtime-server" data-selected={editingId === server.id} key={server.id}>
                <span className="copilot-runtime-server-icon">
                  {server.transport === 'stdio' ? <Terminal size={15} aria-hidden="true" /> : <Globe2 size={15} aria-hidden="true" />}
                </span>
                <span className="copilot-runtime-server-copy">
                  <strong>{server.label}</strong>
                  <small>{server.transport} · {server.toolCount} tools</small>
                  {server.lastError ? <em title={server.lastError}>{server.lastError}</em> : null}
                </span>
                <span className="copilot-runtime-server-status" data-status={server.status}>
                  {server.status}
                </span>
                <span className="copilot-runtime-server-actions">
                  <button type="button" onClick={() => void refresh(server.id)} disabled={Boolean(busy) || !server.enabled} title="刷新连接" aria-label={`刷新 ${server.label}`}>
                    {busy === `refresh:${server.id}`
                      ? <LoaderCircle className="copilot-runtime-spin" size={14} aria-hidden="true" />
                      : <RefreshCw size={14} aria-hidden="true" />}
                  </button>
                  <button type="button" onClick={() => beginEdit(server)} disabled={Boolean(busy)} title="编辑" aria-label={`编辑 ${server.label}`}>
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button className="danger" type="button" onClick={() => void remove(server)} disabled={Boolean(busy)} title="删除" aria-label={`删除 ${server.label}`}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </span>
              </div>
            ))}
            {!servers.length && busy !== 'load' ? <div className="copilot-runtime-empty">暂无 MCP Server</div> : null}
            {busy === 'load' ? <div className="copilot-runtime-empty"><LoaderCircle className="copilot-runtime-spin" size={18} aria-hidden="true" /></div> : null}
          </div>

          <form className="copilot-runtime-editor" onSubmit={(event) => void save(event)}>
            <div className="copilot-runtime-editor-title">
              <strong>{editingId ? '编辑 MCP Server' : '新增 MCP Server'}</strong>
              {editingId ? <code>{editingId}</code> : null}
            </div>

            <label>
              <span>名称</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={120} disabled={Boolean(busy)} />
            </label>

            <fieldset>
              <legend>Transport</legend>
              <div className="copilot-runtime-segments">
                <button type="button" aria-pressed={draft.transport === 'stdio'} onClick={() => setDraft((current) => ({ ...current, transport: 'stdio' }))} disabled={Boolean(busy)}>
                  <Terminal size={14} aria-hidden="true" />stdio
                </button>
                <button type="button" aria-pressed={draft.transport === 'streamable_http'} onClick={() => setDraft((current) => ({ ...current, transport: 'streamable_http' }))} disabled={Boolean(busy)}>
                  <Globe2 size={14} aria-hidden="true" />Streamable HTTP
                </button>
              </div>
            </fieldset>

            {draft.transport === 'stdio' ? (
              <>
                <label>
                  <span>Command</span>
                  <input className="mono" value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} placeholder="npx" spellCheck={false} disabled={Boolean(busy)} />
                </label>
                <label>
                  <span>Args</span>
                  <textarea className="mono" value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} placeholder={'-y\n@modelcontextprotocol/server-example'} spellCheck={false} disabled={Boolean(busy)} />
                </label>
                <label>
                  <span>Env references</span>
                  <textarea className="mono short" value={draft.env} onChange={(event) => setDraft((current) => ({ ...current, env: event.target.value }))} placeholder={'MCP_TOKEN\nSERVICE_API_KEY'} spellCheck={false} disabled={Boolean(busy)} />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>URL</span>
                  <input className="mono" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://mcp.example.com/mcp" spellCheck={false} disabled={Boolean(busy)} />
                </label>
                <label>
                  <span>Header → env reference</span>
                  <textarea className="mono" value={draft.headerEnv} onChange={(event) => setDraft((current) => ({ ...current, headerEnv: event.target.value }))} placeholder={'Authorization=MCP_AUTH_HEADER\nX-API-Key=MCP_API_KEY'} spellCheck={false} disabled={Boolean(busy)} />
                </label>
              </>
            )}

            <label>
              <span>Read-only tool allowlist</span>
              <textarea className="mono short" value={draft.readOnlyTools} onChange={(event) => setDraft((current) => ({ ...current, readOnlyTools: event.target.value }))} placeholder={'search\nlist_records'} spellCheck={false} disabled={Boolean(busy)} />
            </label>

            <label className="copilot-runtime-toggle">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} disabled={Boolean(busy)} />
              <span>Enabled</span>
            </label>

            <div className="copilot-runtime-editor-actions">
              <button type="button" onClick={beginCreate} disabled={Boolean(busy)}>重置</button>
              <button className="primary" type="submit" disabled={Boolean(busy)}>
                {busy === 'save' ? <LoaderCircle className="copilot-runtime-spin" size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                保存配置
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  )
}

function Capability({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return <span data-active={Boolean(active)}>{icon}{label}</span>
}

function parseLines(value: string) {
  return [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))]
}

function parseHeaderEnv(value: string) {
  const result: Record<string, string> = {}
  for (const line of parseLines(value)) {
    const separator = line.indexOf('=')
    const header = line.slice(0, separator).trim()
    const envName = line.slice(separator + 1).trim()
    if (separator <= 0 || !header || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
      throw new Error(`Header 环境变量引用无效：${line}`)
    }
    result[header] = envName
  }
  return result
}

function formatHeaderEnv(value: McpServer['headerEnv']) {
  if (Array.isArray(value)) return value.map((header) => `${header}=`).join('\n')
  if (!value || typeof value !== 'object') return ''
  return Object.entries(value).map(([header, envName]) => `${header}=${envName}`).join('\n')
}

async function request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  const body = await response.json().catch(() => ({})) as {
    error?: { message?: string }
    message?: string
  }
  if (!response.ok) throw new Error(body.error?.message || body.message || `MCP request failed (${response.status})`)
  return body as T
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

const runtimeStyles = `
  .copilot-runtime-backdrop{position:fixed;z-index:86;inset:0;display:grid;place-items:center;padding:24px;background:rgba(22,28,25,.42)}
  .copilot-runtime-panel{width:min(1040px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));display:grid;grid-template-rows:auto auto auto minmax(0,1fr);overflow:hidden;border:1px solid #c7cfca;border-radius:8px;background:#f7f9f8;color:#202824;box-shadow:0 24px 70px rgba(12,20,16,.24);font-size:13px}
  .copilot-runtime-header{display:flex;align-items:center;justify-content:space-between;min-height:58px;padding:0 16px;border-bottom:1px solid #d8dedb;background:#fff}.copilot-runtime-heading{display:flex;align-items:center;gap:10px}.copilot-runtime-heading>span{display:grid;width:32px;height:32px;place-items:center;border-radius:6px;background:#e7f2ec;color:#176b49}.copilot-runtime-heading>div{display:flex;flex-direction:column;gap:1px}.copilot-runtime-heading small{color:#6a746f;font-size:11px}
  .copilot-runtime-header-actions,.copilot-runtime-server-actions{display:flex;gap:6px}.copilot-runtime-header-actions button,.copilot-runtime-server-actions button{display:grid;width:32px;height:32px;place-items:center;padding:0;border:1px solid #ccd4d0;border-radius:5px;background:#fff;color:#44504a;cursor:pointer}.copilot-runtime-header-actions button:hover,.copilot-runtime-server-actions button:hover{background:#edf2ef}.copilot-runtime-header-actions button:disabled,.copilot-runtime-server-actions button:disabled{opacity:.45;cursor:not-allowed}.copilot-runtime-server-actions button.danger{color:#a63c3c}
  .copilot-runtime-capabilities{display:flex;min-height:45px;align-items:center;gap:8px;padding:7px 16px;border-bottom:1px solid #d8dedb;background:#fff}.copilot-runtime-capabilities>span{display:inline-flex;height:28px;align-items:center;gap:5px;padding:0 8px;border:1px solid #d7ddda;border-radius:5px;background:#f4f6f5;color:#727c77;font-size:11px}.copilot-runtime-capabilities>span[data-active=true]{border-color:#b9d3c5;background:#e8f2ed;color:#176b49}.copilot-runtime-capabilities code{min-width:0;margin-left:auto;overflow:hidden;color:#69736e;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
  .copilot-runtime-error{display:flex;align-items:center;gap:7px;padding:8px 16px;border-bottom:1px solid #e3bdbd;background:#fff0f0;color:#922f2f}
  .copilot-runtime-body{display:grid;min-height:0;grid-template-columns:minmax(360px,.95fr) minmax(380px,1.05fr)}.copilot-runtime-list{min-height:0;overflow:auto;padding:12px;border-right:1px solid #d8dedb}.copilot-runtime-server{display:grid;grid-template-columns:32px minmax(0,1fr) auto auto;gap:9px;align-items:center;min-height:72px;margin-bottom:8px;padding:8px 9px;border:1px solid #d3dbd7;border-radius:6px;background:#fff}.copilot-runtime-server[data-selected=true]{border-color:#83ad98;box-shadow:inset 3px 0 #247354}.copilot-runtime-server-icon{display:grid;width:30px;height:30px;place-items:center;border-radius:5px;background:#edf2ef;color:#466056}.copilot-runtime-server-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.copilot-runtime-server-copy small,.copilot-runtime-server-copy em{overflow:hidden;color:#707a75;font-size:10px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.copilot-runtime-server-copy em{color:#9b3f3f}.copilot-runtime-server-status{padding:2px 6px;border-radius:4px;background:#e4e9e6;color:#59645e;font-size:10px}.copilot-runtime-server-status[data-status=connected]{background:#dff1e7;color:#146344}.copilot-runtime-server-status[data-status=error]{background:#f8dede;color:#922f2f}.copilot-runtime-empty{display:grid;min-height:160px;place-items:center;color:#78827d}
  .copilot-runtime-editor{min-height:0;overflow:auto;padding:14px 16px 18px;background:#fff}.copilot-runtime-editor-title{display:flex;min-height:30px;align-items:center;justify-content:space-between;margin-bottom:10px}.copilot-runtime-editor-title code{color:#6b756f;font-size:10px}.copilot-runtime-editor label{display:flex;min-width:0;flex-direction:column;gap:5px;margin-bottom:11px}.copilot-runtime-editor label>span,.copilot-runtime-editor legend{color:#59645e;font-size:11px;font-weight:650}.copilot-runtime-editor input,.copilot-runtime-editor textarea{width:100%;box-sizing:border-box;border:1px solid #c6cfca;border-radius:5px;background:#fff;color:#25302a}.copilot-runtime-editor input{height:35px;padding:0 9px}.copilot-runtime-editor textarea{min-height:82px;resize:vertical;padding:8px 9px;line-height:1.45}.copilot-runtime-editor textarea.short{min-height:64px}.copilot-runtime-editor .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.copilot-runtime-editor fieldset{min-width:0;margin:0 0 11px;padding:0;border:0}.copilot-runtime-editor legend{margin-bottom:5px}.copilot-runtime-segments{display:grid;grid-template-columns:1fr 1fr;overflow:hidden;border:1px solid #c6cfca;border-radius:5px}.copilot-runtime-segments button{display:flex;height:34px;align-items:center;justify-content:center;gap:6px;padding:0 8px;border:0;border-left:1px solid #c6cfca;background:#fff;color:#5e6963;cursor:pointer}.copilot-runtime-segments button:first-child{border-left:0}.copilot-runtime-segments button[aria-pressed=true]{background:#dfeee6;color:#155d41;font-weight:700}.copilot-runtime-editor .copilot-runtime-toggle{flex-direction:row;align-items:center;gap:7px}.copilot-runtime-toggle input{width:15px;height:15px;margin:0;accent-color:#176b49}.copilot-runtime-editor-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}.copilot-runtime-editor-actions button{display:inline-flex;height:34px;align-items:center;justify-content:center;gap:7px;padding:0 13px;border:1px solid #c6cfca;border-radius:5px;background:#fff;color:#4b5751;cursor:pointer}.copilot-runtime-editor-actions button.primary{border-color:#176b49;background:#176b49;color:#fff;font-weight:700}.copilot-runtime-editor-actions button:disabled{opacity:.45;cursor:not-allowed}
  .copilot-runtime-spin{animation:copilot-runtime-spin 1s linear infinite}@keyframes copilot-runtime-spin{to{transform:rotate(360deg)}}
  @media(max-width:820px){.copilot-runtime-backdrop{padding:0}.copilot-runtime-panel{width:100vw;height:100vh;border:0;border-radius:0}.copilot-runtime-body{grid-template-columns:minmax(0,1fr);overflow:auto}.copilot-runtime-list{max-height:42vh;border-right:0;border-bottom:1px solid #d8dedb;overflow:auto}.copilot-runtime-editor{overflow:visible}.copilot-runtime-capabilities{overflow:auto}.copilot-runtime-capabilities code{display:none}}
  @media(max-width:520px){.copilot-runtime-server{grid-template-columns:32px minmax(0,1fr) auto}.copilot-runtime-server-status{grid-column:2}.copilot-runtime-server-actions{grid-column:3;grid-row:1/3}.copilot-runtime-header{padding:0 10px}.copilot-runtime-capabilities{padding:7px 10px}}
`
