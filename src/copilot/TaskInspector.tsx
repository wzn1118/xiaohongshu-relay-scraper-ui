import { useMemo, useState, type ReactNode } from 'react'
import { Activity, Check, Clipboard, FileCode2, FolderGit2, ListTree, RotateCcw, Search, Terminal } from 'lucide-react'

import type {
  DataCopilotMessageData,
  DataCopilotToolCall,
  DataCopilotWorkspaceBinding,
} from '../DataCopilotContext'
import { AgentWorkbench } from './AgentWorkbench'
import type { WorkbenchProjection } from './workbench-types'

export type TaskInspectorTab = 'execution' | 'changes' | 'terminal' | 'context'

type ToolReceipt = DataCopilotToolCall & {
  messageId: string
  createdAt: string
}

type InspectorProps = {
  projection: WorkbenchProjection
  sourceCount: number
  messages: DataCopilotMessageData[]
  workspaceBinding?: DataCopilotWorkspaceBinding | null
  onCancel?: () => void
  onRetry?: () => void
  retryDisabled?: boolean
  onAction?: (prompt: string) => void
  context: ReactNode
  activeTab?: TaskInspectorTab
  onTabChange?: (tab: TaskInspectorTab) => void
}

export function TaskInspector({
  projection,
  sourceCount,
  messages,
  workspaceBinding,
  onCancel,
  onRetry,
  retryDisabled,
  onAction,
  context,
  activeTab,
  onTabChange,
}: InspectorProps) {
  const [uncontrolledTab, setUncontrolledTab] = useState<TaskInspectorTab>('execution')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const tab = activeTab ?? uncontrolledTab
  const selectTab = (next: TaskInspectorTab) => {
    if (activeTab === undefined) setUncontrolledTab(next)
    onTabChange?.(next)
  }
  const receipts = useMemo(() => collectReceipts(messages), [messages])
  const changes = useMemo(() => receipts.filter(isChangeReceipt), [receipts])
  const terminal = useMemo(() => receipts.filter(isTerminalReceipt), [receipts])
  const tabs = [
    { id: 'execution' as const, label: '执行', icon: Activity, count: projection.nodes.length },
    { id: 'changes' as const, label: '变更', icon: FileCode2, count: changes.length },
    { id: 'terminal' as const, label: '终端', icon: Terminal, count: terminal.length },
    { id: 'context' as const, label: '上下文', icon: ListTree, count: sourceCount },
  ]
  const workspaceLabel = workspaceBinding
    ? workspaceBinding.worktreeId
      ? `工作树 ${workspaceBinding.worktreeId}`
      : `工作区 ${workspaceBinding.workspaceId}`
    : '未绑定工作区'

  return (
    <aside className="data-copilot-context-pane copilot-task-inspector" aria-label="任务检查器">
      <style>{styles}</style>
      <header className="copilot-task-inspector-header">
        <div className="copilot-task-inspector-title">
          <span className="copilot-task-inspector-mark"><FolderGit2 size={15} aria-hidden="true" /></span>
          <span>
            <strong>任务检查器</strong>
            <small title={workspaceLabel}>{workspaceLabel}</small>
          </span>
        </div>
        <span className={`copilot-task-inspector-status is-${projection.status}`}>
          {statusLabel(projection.status)}
        </span>
      </header>

      <nav className="copilot-task-inspector-tabs" role="tablist" aria-label="任务检查器视图">
        {tabs.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              id={`copilot-inspector-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`copilot-inspector-panel-${item.id}`}
              onClick={() => selectTab(item.id)}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{item.label}</span>
              <em>{item.count}</em>
            </button>
          )
        })}
      </nav>

      <div
        id={`copilot-inspector-panel-${tab}`}
        className="copilot-task-inspector-content"
        role="tabpanel"
        aria-labelledby={`copilot-inspector-tab-${tab}`}
      >
        {tab === 'execution' ? (
          <AgentWorkbench
            variant="inspector"
            projection={projection}
            sourceCount={sourceCount}
            onCancel={onCancel}
            onRetry={onRetry}
            retryDisabled={retryDisabled}
            selectedNodeId={selectedNodeId}
            onSelectNode={(node) => setSelectedNodeId(node.id)}
          />
        ) : null}
        {tab === 'changes' ? <ChangeReceipts receipts={changes} onAction={onAction} /> : null}
        {tab === 'terminal' ? <TerminalReceipts receipts={terminal} onAction={onAction} /> : null}
        {tab === 'context' ? <div className="copilot-task-inspector-context">{context}</div> : null}
      </div>
    </aside>
  )
}

function ChangeReceipts({
  receipts,
  onAction,
}: {
  receipts: ToolReceipt[]
  onAction?: (prompt: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  if (receipts.length === 0) {
    return <EmptyState icon={FileCode2} text="暂无文件变更" />
  }
  const selected = receipts.find((receipt) => receipt.id === selectedId) ?? receipts[0]
  const path = receiptPath(selected) || '未命名文件'
  const diff = receiptDiff(selected)
  const summary = diffSummary(receipts)

  return (
    <div className="copilot-task-review" data-testid="copilot-inspector-changes">
      <header className="copilot-task-review-header">
        <div>
          <strong>变更审查</strong>
          <small>{summary.files} 个文件 · <span className="is-add">+{summary.additions}</span> · <span className="is-remove">-{summary.deletions}</span></small>
        </div>
        <span>{receipts.length} 条回执</span>
      </header>
      <div className="copilot-task-review-list" role="list" aria-label="文件变更">
        {receipts.map((receipt) => {
          const receiptPathLabel = receiptPath(receipt) || '未命名文件'
          const receiptStats = diffLineStats(receiptDiff(receipt))
          return (
            <button
              key={receipt.id}
              type="button"
              role="listitem"
              className="copilot-task-review-item"
              aria-pressed={selected.id === receipt.id}
              onClick={() => setSelectedId(receipt.id)}
            >
              <span className={`copilot-task-receipt-status is-${receipt.status}`} />
              <span className="copilot-task-receipt-copy">
                <strong title={receiptPathLabel}>{receiptPathLabel}</strong>
                <small>{receipt.name}</small>
              </span>
              <span className="copilot-task-diff-stats"><em>+{receiptStats.additions}</em><i>-{receiptStats.deletions}</i></span>
            </button>
          )
        })}
      </div>
      <section className="copilot-task-review-detail" aria-label={`审查 ${path}`}>
        <header>
          <span>
            <FileCode2 size={14} aria-hidden="true" />
            <strong title={path}>{path}</strong>
          </span>
          <div>
            {diff ? <ClipboardButton text={diff} copied={copied} onCopied={setCopied} /> : null}
            {onAction ? (
              <button
                type="button"
                className="copilot-task-prompt-action"
                onClick={() => onAction(changeReviewPrompt(path, diff))}
              >
                交给 Agent 审查
              </button>
            ) : null}
          </div>
        </header>
        {diff ? <DiffPreview diff={diff} /> : <p>已记录此工具调用，但没有可展示的补丁内容。</p>}
      </section>
    </div>
  )
}

function TerminalReceipts({
  receipts,
  onAction,
}: {
  receipts: ToolReceipt[]
  onAction?: (prompt: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)
  if (receipts.length === 0) {
    return <EmptyState icon={Terminal} text="暂无终端输出" />
  }
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visibleReceipts = receipts.filter((receipt) => {
    if (!normalizedFilter) return true
    return [terminalCommand(receipt), terminalCwd(receipt), terminalOutput(receipt)]
      .join('\n')
      .toLocaleLowerCase()
      .includes(normalizedFilter)
  })
  const selected = visibleReceipts.find((receipt) => receipt.id === selectedId) ?? visibleReceipts[0]

  return (
    <div className="copilot-task-terminal" data-testid="copilot-inspector-terminal">
      <header className="copilot-task-terminal-header">
        <div><strong>命令记录</strong><small>{receipts.length} 次运行</small></div>
        <label className="copilot-task-terminal-search">
          <Search size={12} aria-hidden="true" />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选输出" aria-label="筛选命令输出" />
        </label>
      </header>
      {visibleReceipts.length ? (
        <div className="copilot-task-terminal-list" role="list" aria-label="命令列表">
          {visibleReceipts.map((receipt) => {
            const command = terminalCommand(receipt) || receipt.name
            return (
              <button
                key={receipt.id}
                type="button"
                role="listitem"
                className="copilot-task-terminal-item"
                aria-pressed={selected?.id === receipt.id}
                onClick={() => setSelectedId(receipt.id)}
              >
                <span className={`copilot-task-receipt-status is-${receipt.status}`} />
                <span className="copilot-task-receipt-copy">
                  <strong title={command}>{command}</strong>
                  <small>{terminalCwd(receipt) || receipt.name}</small>
                </span>
                <Terminal size={13} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      ) : <EmptyState icon={Search} text="没有匹配的命令记录" />}
      {selected ? <TerminalDetail receipt={selected} copied={copied} onCopied={setCopied} onAction={onAction} /> : null}
    </div>
  )
}

function TerminalDetail({
  receipt,
  copied,
  onCopied,
  onAction,
}: {
  receipt: ToolReceipt
  copied: boolean
  onCopied: (copied: boolean) => void
  onAction?: (prompt: string) => void
}) {
  const command = terminalCommand(receipt) || receipt.name
  const cwd = terminalCwd(receipt)
  const output = terminalOutput(receipt)
  return (
    <section className="copilot-task-terminal-detail" aria-label={`命令输出 ${command}`}>
      <header>
        <div>
          <strong title={command}>{command}</strong>
          <small>{cwd || receipt.name}</small>
        </div>
        <div>
          {output ? <ClipboardButton text={output} copied={copied} onCopied={onCopied} label="复制输出" /> : null}
          {onAction ? (
            <button type="button" className="copilot-task-icon-action" title="交给 Agent 重跑" aria-label="交给 Agent 重跑" onClick={() => onAction(rerunPrompt(command, cwd))}>
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      {output ? <pre className="copilot-terminal-output">{output}</pre> : <p>命令尚未产生可展示的输出。</p>}
    </section>
  )
}

function ClipboardButton({
  text,
  copied,
  onCopied,
  label = '复制补丁',
}: {
  text: string
  copied: boolean
  onCopied: (copied: boolean) => void
  label?: string
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      onCopied(true)
      window.setTimeout(() => onCopied(false), 1200)
    } catch {
      // Clipboard permissions are browser-owned; the view remains usable without it.
    }
  }
  return (
    <button type="button" className="copilot-task-icon-action" title={label} aria-label={label} onClick={() => void copy()}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
    </button>
  )
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="copilot-task-diff-preview">
      {diff.split('\n').map((line, index) => (
        <span key={`${index}-${line}`} className={diffLineClass(line)}>{line || ' '}{'\n'}</span>
      ))}
    </pre>
  )
}

function EmptyState({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return (
    <div className="copilot-task-inspector-empty">
      <Icon size={18} aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

function collectReceipts(messages: DataCopilotMessageData[]): ToolReceipt[] {
  return messages.flatMap((message) => (message.toolCalls ?? []).map((toolCall) => ({
    ...toolCall,
    messageId: message.id,
    createdAt: message.createdAt,
  })))
}

function isChangeReceipt(receipt: ToolReceipt) {
  return /^(workspace\.(write|patch)|git\.(stage|commit|restore|merge|rebase)|file\.)/.test(receipt.name)
}

function isTerminalReceipt(receipt: ToolReceipt) {
  return receipt.name === 'exec.run' || receipt.name.startsWith('terminal.')
}

function receiptPath(receipt: ToolReceipt) {
  return firstText(receipt.arguments, ['path', 'filePath', 'relativePath', 'file'])
    || firstText(receipt.result, ['path', 'filePath', 'relativePath', 'file'])
}

function receiptDiff(receipt: ToolReceipt) {
  return firstText(receipt.result, ['diff', 'patch', 'unifiedDiff', 'content'])
    || firstText(receipt.arguments, ['patch', 'diff', 'content'])
}

function terminalCommand(receipt: ToolReceipt) {
  return firstText(receipt.arguments, ['command', 'cmd'])
}

function terminalCwd(receipt: ToolReceipt) {
  return firstText(receipt.arguments, ['cwd', 'workingDirectory'])
}

function terminalOutput(receipt: ToolReceipt) {
  const stdout = firstText(receipt.result, ['stdout', 'output', 'content'])
  const stderr = firstText(receipt.result, ['stderr'])
  return [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '')
}

function diffSummary(receipts: ToolReceipt[]) {
  const paths = new Set<string>()
  const totals = receipts.reduce((summary, receipt) => {
    const path = receiptPath(receipt)
    if (path) paths.add(path)
    const stats = diffLineStats(receiptDiff(receipt))
    return {
      additions: summary.additions + stats.additions,
      deletions: summary.deletions + stats.deletions,
    }
  }, { additions: 0, deletions: 0 })
  return { files: paths.size || receipts.length, ...totals }
}

function diffLineStats(diff: string) {
  return diff.split('\n').reduce((stats, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return stats
    if (line.startsWith('+')) stats.additions += 1
    if (line.startsWith('-')) stats.deletions += 1
    return stats
  }, { additions: 0, deletions: 0 })
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-diff-file'
  if (line.startsWith('+')) return 'is-diff-add'
  if (line.startsWith('-')) return 'is-diff-remove'
  if (line.startsWith('@@')) return 'is-diff-hunk'
  return 'is-diff-context'
}

function changeReviewPrompt(path: string, diff: string) {
  const patch = diff ? `\n\n已记录补丁：\n${diff}` : ''
  return `审查当前工作区中 ${path} 的变更。先读取文件的当前内容，核对变更是否正确；发现问题则直接修复，并运行必要测试后报告结果。${patch}`
}

function rerunPrompt(command: string, cwd: string) {
  const location = cwd ? `\n工作目录：${cwd}` : ''
  return `请在当前绑定工作区重新运行该命令，并根据输出修复问题或确认结果：\n${command}${location}`
}

function firstText(value: unknown, keys: string[]) {
  if (!isRecord(value)) return ''
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate)
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function statusLabel(status: WorkbenchProjection['status']) {
  const labels: Record<WorkbenchProjection['status'], string> = {
    idle: '就绪',
    planning: '规划中',
    executing: '执行中',
    waiting_input: '等待输入',
    waiting_approval: '等待确认',
    stopping: '停止中',
    paused: '已暂停',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    resumable: '可恢复',
  }
  return labels[status]
}

const styles = `
  .copilot-task-inspector{display:grid;min-width:0;min-height:0;grid-template-rows:auto auto minmax(0,1fr);border-left:1px solid #e1e1e4;background:#fbfbfc;color:#28282b}
  .copilot-task-inspector-header{display:flex;min-height:56px;align-items:center;justify-content:space-between;gap:10px;padding:0 14px;border-bottom:1px solid #e7e7e9;background:#fff}
  .copilot-task-inspector-title{display:flex;min-width:0;align-items:center;gap:9px}.copilot-task-inspector-mark{display:grid;width:27px;height:27px;flex:none;place-items:center;border:1px solid #dcdce0;border-radius:5px;background:#f6f6f7;color:#4c638e}.copilot-task-inspector-title>span:last-child{display:grid;min-width:0;gap:3px}.copilot-task-inspector-title strong,.copilot-task-inspector-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-task-inspector-title strong{font-size:12px;font-weight:670}.copilot-task-inspector-title small{color:#76767d;font-size:10px}
  .copilot-task-inspector-status{flex:none;padding:3px 6px;border:1px solid #e1e1e4;border-radius:4px;background:#f6f6f7;color:#72727a;font-size:10px;font-variant-numeric:tabular-nums}.copilot-task-inspector-status.is-executing,.copilot-task-inspector-status.is-planning{border-color:#cfdbfd;background:#f0f4ff;color:#4269bd}.copilot-task-inspector-status.is-completed{border-color:#cfe5da;background:#f2fbf6;color:#2d8356}.copilot-task-inspector-status.is-failed{border-color:#f0cbcb;background:#fff5f5;color:#b94949}
  .copilot-task-inspector-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));min-height:38px;border-bottom:1px solid #e3e3e6;background:#fafafa}.copilot-task-inspector-tabs button{display:flex;min-width:0;align-items:center;justify-content:center;gap:4px;padding:0 4px;border:0;border-bottom:2px solid transparent;background:transparent;color:#73737a;font:600 10px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.copilot-task-inspector-tabs button:hover{background:#f2f2f4;color:#34343a}.copilot-task-inspector-tabs button[aria-selected="true"]{border-bottom-color:#386ad8;background:#fff;color:#293d70}.copilot-task-inspector-tabs button em{display:grid;min-width:15px;place-items:center;border-radius:4px;background:#ececf0;color:#74747b;font-size:9px;font-style:normal;line-height:16px}.copilot-task-inspector-tabs button[aria-selected="true"] em{background:#e8efff;color:#4269bf}.copilot-task-inspector-tabs button:focus-visible{outline:2px solid #6086e4;outline-offset:-2px}
  .copilot-task-inspector-content{min-height:0;overflow:auto;scrollbar-color:#c6c6cc transparent;scrollbar-width:thin}.copilot-task-inspector-context{height:100%;min-height:0}.copilot-task-inspector-context>aside{height:100%;border:0!important;border-radius:0!important;box-shadow:none!important}
  .copilot-task-receipt-list{display:grid}.copilot-task-receipt{border-bottom:1px solid #e7e7e9;background:#fff}.copilot-task-receipt summary{display:grid;min-height:52px;grid-template-columns:10px minmax(0,1fr) 14px;align-items:center;gap:8px;padding:0 13px;list-style:none;cursor:pointer}.copilot-task-receipt summary::-webkit-details-marker{display:none}.copilot-task-receipt summary>svg{color:#82828a}.copilot-task-receipt-copy{display:grid;min-width:0;gap:3px}.copilot-task-receipt-copy strong,.copilot-task-receipt-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-task-receipt-copy strong{color:#303034;font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace}.copilot-task-receipt-copy small{color:#818189;font-size:9px}.copilot-task-receipt-status{width:7px;height:7px;border-radius:50%;background:#b9b9c0}.copilot-task-receipt-status.is-running,.copilot-task-receipt-status.is-pending{background:#4b76df;box-shadow:0 0 0 3px #e6edff}.copilot-task-receipt-status.is-complete{background:#319466}.copilot-task-receipt-status.is-failed{background:#cc4e4e}.copilot-task-receipt-status.is-cancelled{background:#a47d3b}.copilot-task-receipt pre{max-height:300px;overflow:auto;margin:0;padding:12px 13px;border-top:1px solid #ececf0;background:#191a1e;color:#e4e7ef;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.copilot-task-receipt p{margin:0;padding:11px 13px;border-top:1px solid #ececf0;color:#777780;font-size:10px;line-height:1.5}.copilot-terminal-output{color:#dfe9ff!important}
  .copilot-task-review,.copilot-task-terminal{display:grid;min-height:0;background:#fff}.copilot-task-review-header,.copilot-task-terminal-header{display:flex;min-height:52px;align-items:center;justify-content:space-between;gap:10px;padding:0 13px;border-bottom:1px solid #e8e8eb;background:#fff}.copilot-task-review-header>div,.copilot-task-terminal-header>div{display:grid;gap:3px}.copilot-task-review-header strong,.copilot-task-terminal-header strong{font-size:11px;font-weight:680}.copilot-task-review-header small,.copilot-task-terminal-header small{color:#85858c;font-size:9px}.copilot-task-review-header>span{color:#898990;font-size:9px;white-space:nowrap}.copilot-task-review-header .is-add,.copilot-task-diff-stats em{color:#2c8b60;font-style:normal}.copilot-task-review-header .is-remove,.copilot-task-diff-stats i{color:#bd5454;font-style:normal}.copilot-task-review-list,.copilot-task-terminal-list{display:grid;border-bottom:1px solid #e8e8eb}.copilot-task-review-item,.copilot-task-terminal-item{display:grid;width:100%;min-height:46px;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:8px;padding:0 13px;border:0;border-bottom:1px solid #f0f0f2;background:#fff;color:inherit;text-align:left;cursor:pointer}.copilot-task-review-item:hover,.copilot-task-terminal-item:hover{background:#fafafa}.copilot-task-review-item[aria-pressed="true"],.copilot-task-terminal-item[aria-pressed="true"]{background:#f2f6ff;box-shadow:inset 2px 0 #4b76df}.copilot-task-review-item:focus-visible,.copilot-task-terminal-item:focus-visible,.copilot-task-icon-action:focus-visible,.copilot-task-prompt-action:focus-visible,.copilot-task-terminal-search:focus-within{outline:2px solid #6d95ed;outline-offset:-2px}.copilot-task-diff-stats{display:flex;gap:4px;font:600 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.copilot-task-review-detail,.copilot-task-terminal-detail{display:grid;min-height:0}.copilot-task-review-detail>header,.copilot-task-terminal-detail>header{display:flex;min-height:44px;align-items:center;justify-content:space-between;gap:8px;padding:0 13px;border-bottom:1px solid #ececf0;background:#fafafa}.copilot-task-review-detail>header>span,.copilot-task-terminal-detail>header>div:first-child{display:flex;min-width:0;align-items:center;gap:7px}.copilot-task-review-detail>header strong,.copilot-task-terminal-detail strong{overflow:hidden;color:#303034;font:600 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.copilot-task-terminal-detail>header>div:first-child{display:grid;gap:3px}.copilot-task-terminal-detail small{overflow:hidden;color:#83838b;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.copilot-task-review-detail>header>div:last-child,.copilot-task-terminal-detail>header>div:last-child{display:flex;align-items:center;gap:4px}.copilot-task-icon-action{display:grid;width:26px;height:26px;place-items:center;padding:0;border:1px solid #dfe0e5;border-radius:4px;background:#fff;color:#5b6475;cursor:pointer}.copilot-task-icon-action:hover{border-color:#b9caee;background:#edf3ff;color:#365faf}.copilot-task-prompt-action{height:26px;padding:0 7px;border:1px solid #b9caee;border-radius:4px;background:#edf3ff;color:#365faf;font:600 9px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.copilot-task-prompt-action:hover{border-color:#7595dc;background:#e3ecff}.copilot-task-diff-preview{max-height:360px;overflow:auto;margin:0;padding:10px 13px;background:#181a1f;color:#d9dce5;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;scrollbar-color:#5f6470 #181a1f;scrollbar-width:thin}.copilot-task-diff-preview span{display:block;min-width:max-content;padding:0 4px}.copilot-task-diff-preview .is-diff-add{background:rgba(54,161,106,.18);color:#b9edcc}.copilot-task-diff-preview .is-diff-remove{background:rgba(205,76,76,.18);color:#ffd0d0}.copilot-task-diff-preview .is-diff-file{color:#aec8ff}.copilot-task-diff-preview .is-diff-hunk{color:#cbb7ff}.copilot-task-review-detail>p,.copilot-task-terminal-detail>p{margin:0;padding:12px 13px;color:#777780;font-size:10px;line-height:1.5}.copilot-task-terminal-search{display:flex;min-width:0;width:112px;height:27px;align-items:center;gap:5px;padding:0 7px;border:1px solid #e1e1e5;border-radius:4px;background:#fff;color:#84848b}.copilot-task-terminal-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:#34343a;font-size:10px}.copilot-task-terminal-search input::placeholder{color:#9999a0}.copilot-task-terminal-detail .copilot-terminal-output{max-height:340px;margin:0;padding:11px 13px;background:#181a1f;color:#dfe9ff;font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere}
  .copilot-task-inspector-empty{display:grid;min-height:150px;place-content:center;justify-items:center;gap:9px;color:#888890;font-size:11px}.copilot-task-inspector-empty svg{color:#9da4b4}
  @media(max-width:680px){.copilot-task-inspector{width:100%;border-left:0}.copilot-task-inspector-header{min-height:54px}.copilot-task-inspector-tabs button span{display:none}.copilot-task-inspector-tabs button{gap:5px}.copilot-task-inspector-tabs button em{min-width:14px}.copilot-task-inspector-content{flex:1}}
`
