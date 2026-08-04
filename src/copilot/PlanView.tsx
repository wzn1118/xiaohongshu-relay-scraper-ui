import { Check, Circle, LoaderCircle, OctagonAlert, X } from 'lucide-react'

import type { WorkbenchPlanNode } from './workbench-types'

export function PlanView({ nodes }: { nodes: WorkbenchPlanNode[] }) {
  if (!nodes.length) return <div className="copilot-workbench-empty">发送任务后，执行节点将在这里实时展开。</div>
  return (
    <div className="copilot-plan-list" aria-label="执行计划">
      {nodes.map((node, index) => (
        <div className={`copilot-plan-node is-${node.status}`} key={node.id}>
          <span className="copilot-plan-index">{String(index + 1).padStart(2, '0')}</span>
          <span className="copilot-plan-state" aria-label={node.status}>{statusIcon(node.status)}</span>
          <span className="copilot-plan-copy">
            <strong>{node.title}</strong>
            <small>{node.kind}</small>
          </span>
        </div>
      ))}
    </div>
  )
}

function statusIcon(status: WorkbenchPlanNode['status']) {
  if (status === 'completed') return <Check size={13} aria-hidden="true" />
  if (status === 'running') return <LoaderCircle className="copilot-spin" size={13} aria-hidden="true" />
  if (status === 'failed') return <OctagonAlert size={13} aria-hidden="true" />
  if (status === 'cancelled') return <X size={13} aria-hidden="true" />
  return <Circle size={11} aria-hidden="true" />
}
