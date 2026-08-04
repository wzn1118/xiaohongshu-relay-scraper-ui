import { AlertTriangle, FileSearch, MessageSquareText, Wrench } from 'lucide-react'

import type { WorkbenchActivity } from './workbench-types'

export function ActivityTimeline({ activities }: { activities: WorkbenchActivity[] }) {
  if (!activities.length) return <div className="copilot-workbench-empty">运行事件会按时间记录在这里。</div>
  return (
    <div className="copilot-activity-list" aria-label="活动时间线">
      {activities.slice(0, 30).map((activity) => (
        <div className={`copilot-activity-item is-${activity.status}`} key={activity.id}>
          <span className="copilot-activity-icon">{activityIcon(activity.type)}</span>
          <span className="copilot-activity-copy">
            <strong>{activity.title}</strong>
            <small>{activity.detail || '状态已更新'}</small>
          </span>
          <time>{timeLabel(activity.occurredAt)}</time>
        </div>
      ))}
    </div>
  )
}

function activityIcon(type: WorkbenchActivity['type']) {
  if (type === 'tool') return <Wrench size={13} aria-hidden="true" />
  if (type === 'evidence') return <FileSearch size={13} aria-hidden="true" />
  if (type === 'error') return <AlertTriangle size={13} aria-hidden="true" />
  return <MessageSquareText size={13} aria-hidden="true" />
}

function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
