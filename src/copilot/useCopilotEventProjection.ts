import { useMemo } from 'react'

import type {
  DataCopilotMessageData,
  DataCopilotRunStatus,
  DataCopilotToolStatus,
} from '../DataCopilotContext'
import type {
  WorkbenchActivity,
  WorkbenchClaim,
  WorkbenchNodeStatus,
  WorkbenchProjection,
} from './workbench-types'

export function useCopilotEventProjection(
  messages: DataCopilotMessageData[],
  status: DataCopilotRunStatus,
): WorkbenchProjection {
  return useMemo(() => {
    const nodes = messages.flatMap((message) => (message.toolCalls ?? []).map((tool) => ({
      id: tool.id,
      title: humanizeToolName(tool.name),
      kind: tool.name,
      status: nodeStatus(tool.status),
      startedAt: tool.startedAt,
      finishedAt: tool.finishedAt,
    })))
    const activities: WorkbenchActivity[] = messages.flatMap((message) => {
      const messageActivity: WorkbenchActivity = {
        id: `message:${message.id}`,
        type: message.kind === 'error' ? 'error' : 'message',
        title: message.role === 'user' ? '收到任务' : message.kind === 'error' ? '执行异常' : '生成答复',
        detail: compactText(message.content, 96),
        status: message.kind === 'error' || message.status === 'failed'
          ? 'failed'
          : message.status === 'streaming' || message.status === 'pending'
            ? 'running'
            : 'info',
        occurredAt: message.createdAt,
      }
      const toolActivities = (message.toolCalls ?? []).map((tool): WorkbenchActivity => ({
        id: `tool:${tool.id}`,
        type: 'tool',
        title: humanizeToolName(tool.name),
        detail: tool.error ? compactText(tool.error, 96) : toolDetail(tool.result),
        status: nodeStatus(tool.status),
        occurredAt: tool.finishedAt || tool.startedAt || message.createdAt,
      }))
      const evidenceActivities = (message.citations ?? []).map((citation): WorkbenchActivity => ({
        id: `evidence:${message.id}:${citation.id}`,
        type: 'evidence',
        title: citation.label || '证据引用',
        detail: compactText(citation.excerpt || citation.sourceId || '', 96),
        status: 'completed',
        occurredAt: message.createdAt,
      }))
      return [messageActivity, ...toolActivities, ...evidenceActivities]
    }).sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))

    const sourceMap = new Map<string, { id: string; label: string; excerpt?: string }>()
    const claims: WorkbenchClaim[] = []
    for (const message of messages.filter((item) => item.role === 'assistant' && item.content.trim())) {
      const citations = message.citations ?? []
      for (const citation of citations) {
        const id = citation.sourceId || citation.id
        if (!sourceMap.has(id)) sourceMap.set(id, { id, label: citation.label || id, excerpt: citation.excerpt })
      }
      claims.push({
        id: `claim:${message.id}`,
        text: compactText(message.content, 180),
        sourceRefs: citations.map((citation) => citation.sourceId || citation.id),
        citationLabels: citations.map((citation) => citation.label).filter(Boolean),
        verified: citations.length > 0,
      })
    }
    const artifacts = messages.flatMap((message) => message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      status: attachment.status,
    }))
    const completedNodes = nodes.filter((node) => node.status === 'completed').length
    const progress = nodes.length
      ? Math.round(completedNodes / nodes.length * 100)
      : status === 'completed' ? 100 : status === 'idle' ? 0 : 12
    const timestamps = messages.map((message) => Date.parse(message.createdAt)).filter(Number.isFinite)
    const elapsedMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0
    return {
      status,
      nodes,
      activities,
      evidence: {
        claims,
        sources: [...sourceMap.values()],
        artifacts: uniqueById(artifacts),
        coverage: claims.length ? claims.filter((claim) => claim.verified).length / claims.length : 1,
      },
      progress,
      completedNodes,
      elapsedMs,
      toolCount: nodes.length,
    }
  }, [messages, status])
}

function nodeStatus(status: DataCopilotToolStatus): WorkbenchNodeStatus {
  if (status === 'complete') return 'completed'
  if (status === 'running') return 'running'
  return status
}

function humanizeToolName(value: string) {
  const names: Record<string, string> = {
    'dataset.profile': '数据剖析',
    'sql.query': '查询数据',
    'chart.create': '生成图表',
    'report.compose': '编排报告',
  }
  names['attachment.parse'] = 'Attachment parsing'
  names['attachment.list'] = 'Read attachments'
  names['applications.extract_email_requirements'] = 'Extract email requirements'
  names['application.email_draft'] = 'Prepare application email'
  names['application.batch_preflight'] = 'Prepare batch delivery'
  names['application.batch'] = 'Batch delivery status'
  return names[value] || value.split(/[._-]/u).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ')
}

function toolDetail(value: unknown) {
  if (!value || typeof value !== 'object') return value === undefined ? '等待输出' : compactText(String(value), 96)
  const record = value as Record<string, unknown>
  if (typeof record.kind === 'string') return `${record.kind} 已生成`
  if (typeof record.rowCount === 'number') return `${record.rowCount} 行数据`
  if (Array.isArray(record.rows)) return `${record.rows.length} 行结果`
  return '输出已校验'
}

function compactText(value: string, limit: number) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}
