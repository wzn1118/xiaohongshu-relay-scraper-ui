import type { DataCopilotRunStatus } from '../DataCopilotContext'

export type WorkbenchNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type WorkbenchPlanNode = {
  id: string
  title: string
  kind: string
  status: WorkbenchNodeStatus
  nodeType: 'tool' | 'subagent-run' | 'subagent-task'
  depth?: number
  parentId?: string
  detail?: string
  dependsOn?: string[]
  toolCount?: number
  completedChildren?: number
  childCount?: number
  startedAt?: string
  finishedAt?: string
}

export type WorkbenchActivity = {
  id: string
  type: 'message' | 'agent' | 'tool' | 'evidence' | 'error'
  title: string
  detail: string
  status: WorkbenchNodeStatus | 'info'
  occurredAt: string
  toolName?: string
}

export type WorkbenchClaim = {
  id: string
  text: string
  sourceRefs: string[]
  citationLabels: string[]
  verified: boolean
}

export type WorkbenchEvidence = {
  claims: WorkbenchClaim[]
  sources: Array<{ id: string; label: string; excerpt?: string }>
  artifacts: Array<{ id: string; name: string; status: string }>
  coverage: number
}

export type WorkbenchProjection = {
  status: DataCopilotRunStatus
  nodes: WorkbenchPlanNode[]
  activities: WorkbenchActivity[]
  evidence: WorkbenchEvidence
  progress: number
  completedNodes: number
  totalNodes: number
  elapsedMs: number
  toolCount: number
  subagentRunCount: number
}
