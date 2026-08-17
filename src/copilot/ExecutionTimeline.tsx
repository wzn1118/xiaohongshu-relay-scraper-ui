import { AlertTriangle, Bot, Check, FileSearch, LoaderCircle, Terminal, Wrench } from 'lucide-react'

import type { WorkbenchActivity } from './workbench-types'
import type { TaskRunHeaderTab } from './TaskRunHeader'

export function ExecutionTimeline({
  activities,
  onOpenInspector,
}: {
  activities: WorkbenchActivity[]
  onOpenInspector: (tab: TaskRunHeaderTab) => void
}) {
  const events = activities
    .filter((activity) => activity.type !== 'message')
    .slice(0, 6)
    .reverse()

  if (!events.length) return null

  return (
    <section className="copilot-execution-timeline" aria-label="连续执行轨迹">
      <header>
        <span><Wrench size={14} aria-hidden="true" />执行轨迹</span>
        <button type="button" onClick={() => onOpenInspector('execution')}>查看全部</button>
      </header>
      <ol>
        {events.map((event) => (
          <li key={event.id} className={`is-${event.status}`}>
            <span className="copilot-execution-timeline-icon">{eventIcon(event)}</span>
            <button
              type="button"
              onClick={() => onOpenInspector(inspectorTabFor(event))}
              title={event.detail || event.title}
              aria-label={`查看执行轨迹步骤：${event.type}`}
            >
              <strong>{event.title}</strong>
              <small>{event.detail ? `执行详情：${event.detail}` : '状态已更新'}</small>
            </button>
            <time dateTime={event.occurredAt}>{timeLabel(event.occurredAt)}</time>
          </li>
        ))}
      </ol>
    </section>
  )
}

function eventIcon(event: WorkbenchActivity) {
  if (event.status === 'running') return <LoaderCircle className="copilot-spin" size={13} aria-hidden="true" />
  if (event.status === 'failed') return <AlertTriangle size={13} aria-hidden="true" />
  if (event.type === 'agent') return <Bot size={13} aria-hidden="true" />
  if (event.type === 'evidence') return <FileSearch size={13} aria-hidden="true" />
  if (event.toolName === 'exec.run' || event.toolName?.startsWith('terminal.')) return <Terminal size={13} aria-hidden="true" />
  return <Check size={13} aria-hidden="true" />
}

function inspectorTabFor(event: WorkbenchActivity): TaskRunHeaderTab {
  if (event.toolName === 'exec.run' || event.toolName?.startsWith('terminal.')) return 'terminal'
  if (event.toolName?.startsWith('workspace.write') || event.toolName?.startsWith('workspace.patch') || event.toolName?.startsWith('git.')) return 'changes'
  return 'execution'
}

function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
