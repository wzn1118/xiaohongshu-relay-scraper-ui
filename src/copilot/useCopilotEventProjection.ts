import { useMemo } from 'react'

import type {
  DataCopilotMessageData,
  DataCopilotRunStatus,
  DataCopilotSubagentRun,
  DataCopilotToolStatus,
} from '../DataCopilotContext'
import type {
  WorkbenchActivity,
  WorkbenchClaim,
  WorkbenchNodeStatus,
  WorkbenchPlanNode,
  WorkbenchProjection,
} from './workbench-types'

export function useCopilotEventProjection(
  messages: DataCopilotMessageData[],
  status: DataCopilotRunStatus,
  subagentRuns: DataCopilotSubagentRun[] = [],
): WorkbenchProjection {
  return useMemo(() => {
    const toolNodes: WorkbenchPlanNode[] = messages.flatMap((message) =>
      (message.toolCalls ?? []).map((tool) => ({
        id: tool.id,
        title: humanizeToolName(tool.name),
        kind: tool.name,
        status: nodeStatus(tool.status),
        nodeType: 'tool',
        detail: tool.error ? compactText(tool.error, 110) : toolDetail(tool.result),
        startedAt: tool.startedAt,
        finishedAt: tool.finishedAt,
      })),
    )
    const subagentNodes: WorkbenchPlanNode[] = subagentRuns.flatMap((run) => {
      const completedChildren = run.tasks.filter((task) => task.status === 'completed').length
      const runNode: WorkbenchPlanNode = {
        id: `subagent-run:${run.runId}`,
        title: run.objective || '子 Agent 协作任务',
        kind: '子 Agent 协作',
        status: subagentNodeStatus(run.status),
        nodeType: 'subagent-run',
        detail: run.error?.message,
        completedChildren,
        childCount: run.tasks.length,
        startedAt: run.startedAt || run.plannedAt,
        finishedAt: run.finishedAt,
      }
      const taskNodes: WorkbenchPlanNode[] = run.tasks.map((task) => ({
        id: `subagent-task:${run.runId}:${task.taskId}`,
        parentId: runNode.id,
        title: task.title,
        kind: task.role || 'subagent',
        status: subagentNodeStatus(task.status),
        nodeType: 'subagent-task',
        depth: 1,
        detail: subagentTaskDetail(task),
        dependsOn: task.dependsOn,
        toolCount: task.tools.length,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
      }))
      return [runNode, ...taskNodes]
    })
    const nodes = [...subagentNodes, ...toolNodes]

    const messageActivities: WorkbenchActivity[] = messages.flatMap((message) => {
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
        toolName: tool.name,
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
    })
    const subagentActivities: WorkbenchActivity[] = subagentRuns.flatMap((run) => {
      const runActivity: WorkbenchActivity = {
        id: `subagent-run:${run.runId}`,
        type: run.status === 'failed' ? 'error' : 'agent',
        title: '子 Agent 运行',
        detail: compactText(run.error?.message || run.objective, 96),
        status: subagentNodeStatus(run.status),
        occurredAt: run.updatedAt,
      }
      const taskActivities = run.tasks.flatMap((task): WorkbenchActivity[] => {
        const taskActivity: WorkbenchActivity = {
          id: `subagent-task:${run.runId}:${task.taskId}`,
          type: task.status === 'failed' ? 'error' : 'agent',
          title: `${task.role || 'subagent'} · ${task.title}`,
          detail: subagentTaskDetail(task) || '等待输出',
          status: subagentNodeStatus(task.status),
          occurredAt: task.finishedAt || task.startedAt || run.plannedAt || run.updatedAt,
        }
        const toolActivities = task.tools.map((tool): WorkbenchActivity => ({
          id: `subagent-tool:${run.runId}:${task.taskId}:${tool.toolCallId}`,
          type: 'tool',
          title: humanizeToolName(tool.toolName),
          detail: tool.error?.message
            ? compactText(tool.error.message, 96)
            : `${task.role || 'subagent'} · ${task.title}`,
          status: subagentNodeStatus(tool.status),
          occurredAt: tool.finishedAt || tool.startedAt || task.startedAt || run.updatedAt,
          toolName: tool.toolName,
        }))
        return [taskActivity, ...toolActivities]
      })
      return [runActivity, ...taskActivities]
    })
    const activities = [...messageActivities, ...subagentActivities]
      .sort((left, right) => timestampValue(right.occurredAt) - timestampValue(left.occurredAt))

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
    const taskNodes = subagentNodes.filter((node) => node.nodeType === 'subagent-task')
    const actionableNodes = [...toolNodes, ...taskNodes]
    const completedNodes = actionableNodes.filter((node) => node.status === 'completed').length
    const totalNodes = actionableNodes.length
    const progress = totalNodes
      ? Math.round(completedNodes / totalNodes * 100)
      : status === 'completed' ? 100 : status === 'idle' ? 0 : 12
    const timestamps = [
      ...messages.map((message) => message.createdAt),
      ...subagentRuns.flatMap((run) => [
        run.plannedAt,
        run.startedAt,
        run.finishedAt,
        run.updatedAt,
        ...run.tasks.flatMap((task) => [
          task.startedAt,
          task.finishedAt,
          ...task.tools.flatMap((tool) => [tool.startedAt, tool.finishedAt]),
        ]),
      ]),
    ].filter((value): value is string => Boolean(value)).map(timestampValue).filter(Number.isFinite)
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
      totalNodes,
      elapsedMs,
      toolCount: toolNodes.length + subagentRuns.reduce(
        (count, run) => count + run.tasks.reduce((taskCount, task) => taskCount + task.tools.length, 0),
        0,
      ),
      subagentRunCount: subagentRuns.length,
    }
  }, [messages, status, subagentRuns])
}

function nodeStatus(status: DataCopilotToolStatus): WorkbenchNodeStatus {
  if (status === 'complete') return 'completed'
  if (status === 'running') return 'running'
  return status
}

function subagentNodeStatus(status: string): WorkbenchNodeStatus {
  if (status === 'completed') return 'completed'
  if (status === 'running') return 'running'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

function subagentTaskDetail(task: DataCopilotSubagentRun['tasks'][number]) {
  if (task.error?.message) return compactText(task.error.message, 110)
  if (task.summary) return compactText(task.summary, 110)
  if (task.output.trim()) return compactText(task.output, 110)
  const runningTool = task.tools.find((tool) => tool.status === 'running')
  if (runningTool) return `${humanizeToolName(runningTool.toolName)} 执行中`
  return ''
}

function humanizeToolName(value: string) {
  const names: Record<string, string> = {
    'dataset.profile': '数据剖析',
    'sql.query': '查询数据',
    'chart.create': '生成图表',
    'report.compose': '编排报告',
    'workspace.list': '浏览工作区',
    'workspace.read': '读取文件',
    'workspace.write': '写入文件',
    'workspace.patch': '应用补丁',
    'exec.run': '运行命令',
    'http.request': '发送 HTTP 请求',
    'git.status': '检查 Git 状态',
    'git.diff': '查看 Git 变更',
    'git.log': '读取 Git 历史',
    'git.branch': '切换 Git 分支',
    'git.stage': '暂存变更',
    'git.commit': '创建提交',
    'git.restore': '还原变更',
  }
  if (value.startsWith('mcp.')) return `MCP · ${value.slice(4).replaceAll('.', ' / ')}`
  if (value.startsWith('terminal.')) return `终端 · ${value.slice(9).replaceAll('.', ' ')}`
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
  const command = typeof record.command === 'string' ? record.command : ''
  const path = typeof record.path === 'string' ? record.path : typeof record.filePath === 'string' ? record.filePath : ''
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  if (command) return compactText(command, 96)
  if (path) return compactText(path, 96)
  if (stdout) return compactText(stdout, 96)
  if (stderr) return compactText(stderr, 96)
  if (typeof record.kind === 'string') return `${record.kind} 已生成`
  if (typeof record.rowCount === 'number') return `${record.rowCount} 行数据`
  if (Array.isArray(record.rows)) return `${record.rows.length} 行结果`
  return '输出已校验'
}

function compactText(value: string, limit: number) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function timestampValue(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}
