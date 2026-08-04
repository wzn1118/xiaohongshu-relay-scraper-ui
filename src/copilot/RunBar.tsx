import { ChevronDown, ChevronUp, Clock3, Database, Square, Workflow } from 'lucide-react'

import type { WorkbenchProjection } from './workbench-types'

export function RunBar({
  projection,
  sourceCount,
  onCancel,
  collapsed,
  onToggleCollapse,
}: {
  projection: WorkbenchProjection
  sourceCount: number
  onCancel?: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const active = ['planning', 'executing', 'waiting_input', 'waiting_approval', 'stopping'].includes(projection.status)
  return (
    <div className="copilot-runbar" aria-label="运行概览">
      <div className="copilot-runbar-status">
        <span className={`copilot-run-dot is-${projection.status}`} aria-hidden="true" />
        <strong>{statusLabel(projection.status)}</strong>
        <span>{projection.progress}%</span>
      </div>
      <div className="copilot-run-progress" aria-label={`执行进度 ${projection.progress}%`}>
        <span style={{ width: `${projection.progress}%` }} />
      </div>
      <div className="copilot-run-metrics">
        <span title="执行节点"><Workflow size={13} aria-hidden="true" />{projection.completedNodes}/{projection.nodes.length}</span>
        <span title="已连接数据源"><Database size={13} aria-hidden="true" />{sourceCount}</span>
        <span title="会话用时"><Clock3 size={13} aria-hidden="true" />{formatDuration(projection.elapsedMs)}</span>
      </div>
      <div className="copilot-run-actions">
        {active && onCancel ? (
          <button className="copilot-run-action" type="button" title="停止运行" aria-label="停止运行" onClick={onCancel}>
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        ) : null}
        <button
          className="copilot-run-collapse"
          type="button"
          title={collapsed ? '展开运行详情' : '收起运行详情'}
          aria-label={collapsed ? '展开运行详情' : '收起运行详情'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed
            ? <ChevronDown size={14} aria-hidden="true" />
            : <ChevronUp size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: '就绪', planning: '规划中', executing: '执行中', waiting_input: '等待输入',
    waiting_approval: '等待确认', stopping: '停止中', paused: '已暂停', completed: '已完成',
    partial: '部分完成', failed: '失败', cancelled: '已取消', resumable: '可恢复',
  }
  return labels[status] || status
}

function formatDuration(value: number) {
  if (!value) return '0s'
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`
  return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s`
}
