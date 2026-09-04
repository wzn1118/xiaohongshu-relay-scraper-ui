import { Bot, Check, Circle, LoaderCircle, OctagonAlert, X } from 'lucide-react'

import type { WorkbenchPlanNode } from './workbench-types'

export function PlanView({
  nodes,
  selectedNodeId,
  onSelectNode,
}: {
  nodes: WorkbenchPlanNode[]
  selectedNodeId?: string
  onSelectNode?: (node: WorkbenchPlanNode) => void
}) {
  if (!nodes.length) return <div className="copilot-workbench-empty">发送任务后，执行节点将在这里实时展开。</div>
  return (
    <div className="copilot-plan-list" aria-label="执行计划">
      {nodes.map((node, index) => (
        <button
          type="button"
          className={`copilot-plan-node is-${node.status} is-${node.nodeType}`}
          key={node.id}
          style={{ paddingLeft: node.depth ? 37 : 16 }}
          data-testid={node.nodeType === 'subagent-task' ? 'subagent-task-node' : undefined}
          aria-current={selectedNodeId === node.id ? 'true' : undefined}
          onClick={() => onSelectNode?.(node)}
        >
          <span className="copilot-plan-index">{String(index + 1).padStart(2, '0')}</span>
          <span className="copilot-plan-state" aria-label={node.status}>{nodeIcon(node.nodeType, node.status)}</span>
          <span className="copilot-plan-copy">
            <strong>{node.title}</strong>
            <small>{nodeMeta(node)}</small>
          </span>
        </button>
      ))}
    </div>
  )
}

function nodeIcon(nodeType: WorkbenchPlanNode['nodeType'], status: WorkbenchPlanNode['status']) {
  if (nodeType === 'subagent-run') return <Bot size={13} aria-hidden="true" />
  return <span aria-hidden="true">{statusIcon(status)}</span>
}

function nodeMeta(node: WorkbenchPlanNode) {
  const parts = [node.kind]
  if (node.nodeType === 'subagent-run' && node.childCount !== undefined) {
    parts.push(`${node.completedChildren ?? 0}/${node.childCount} 个任务`)
  }
  if (node.nodeType === 'subagent-task') {
    if (node.toolCount) parts.push(`${node.toolCount} 个工具`)
    if (node.dependsOn?.length) parts.push(`等待 ${node.dependsOn.join('、')}`)
  }
  if (node.detail) parts.push(node.detail)
  return parts.join(' · ')
}

function statusIcon(status: WorkbenchPlanNode['status']) {
  if (status === 'completed') return <Check size={13} aria-hidden="true" />
  if (status === 'running') return <LoaderCircle className="copilot-spin" size={13} aria-hidden="true" />
  if (status === 'failed') return <OctagonAlert size={13} aria-hidden="true" />
  if (status === 'cancelled') return <X size={13} aria-hidden="true" />
  return <Circle size={11} aria-hidden="true" />
}
