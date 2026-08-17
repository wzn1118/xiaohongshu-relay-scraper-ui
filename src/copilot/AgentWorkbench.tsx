import { useState } from 'react'
import { Activity, ListTree, ShieldCheck } from 'lucide-react'

import { ActivityTimeline } from './ActivityTimeline'
import { EvidenceInspector } from './EvidenceInspector'
import { PlanView } from './PlanView'
import { RunBar } from './RunBar'
import type { WorkbenchPlanNode, WorkbenchProjection } from './workbench-types'

type WorkbenchTab = 'plan' | 'activity' | 'evidence'

export function AgentWorkbench({
  projection,
  sourceCount,
  onCancel,
  onRetry,
  retryDisabled,
  variant = 'compact',
  selectedNodeId,
  onSelectNode,
}: {
  projection: WorkbenchProjection
  sourceCount: number
  onCancel?: () => void
  onRetry?: () => void
  retryDisabled?: boolean
  variant?: 'compact' | 'inspector'
  selectedNodeId?: string
  onSelectNode?: (node: WorkbenchPlanNode) => void
}) {
  const [tab, setTab] = useState<WorkbenchTab>('plan')
  const [collapsed, setCollapsed] = useState(false)
  const tabs = [
    { id: 'plan' as const, label: '计划', count: projection.nodes.length, icon: ListTree },
    { id: 'activity' as const, label: '活动', count: projection.activities.length, icon: Activity },
    { id: 'evidence' as const, label: '证据', count: projection.evidence.sources.length, icon: ShieldCheck },
  ]
  return (
    <section className="copilot-agent-workbench" data-variant={variant} aria-label="智能体运行工作台">
      <style>{styles}</style>
      <RunBar
        projection={projection}
        sourceCount={sourceCount}
        onCancel={onCancel}
        onRetry={onRetry}
        retryDisabled={retryDisabled}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
      {!collapsed ? <div className="copilot-workbench-tabs" role="tablist" aria-label="运行视图">
        {tabs.map((item) => {
          const Icon = item.icon
          return (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
              <Icon size={13} aria-hidden="true" />{item.label}<span>{item.count}</span>
            </button>
          )
        })}
      </div> : null}
      {!collapsed ? <div className="copilot-workbench-view" role="tabpanel">
        {tab === 'plan' ? (
          <>
            {selectedNodeId
              ? <PlanNodeDetail node={projection.nodes.find((node) => node.id === selectedNodeId)} />
              : null}
            <PlanView nodes={projection.nodes} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
          </>
        ) : null}
        {tab === 'activity' ? <ActivityTimeline activities={projection.activities} /> : null}
        {tab === 'evidence' ? <EvidenceInspector evidence={projection.evidence} /> : null}
      </div> : null}
    </section>
  )
}

function PlanNodeDetail({ node }: { node?: WorkbenchPlanNode }) {
  if (!node) return null
  const detail = [
    node.kind,
    node.nodeType === 'subagent-task' && node.toolCount ? `${node.toolCount} 个工具` : '',
    node.nodeType === 'subagent-run' && node.childCount !== undefined
      ? `${node.completedChildren ?? 0}/${node.childCount} 个任务`
      : '',
    node.dependsOn?.length ? `依赖 ${node.dependsOn.join('、')}` : '',
    node.detail || '',
  ].filter(Boolean)
  return (
    <section className="copilot-plan-detail" data-testid="copilot-selected-plan-node" aria-label="已选执行节点">
      <span className={`copilot-plan-detail-state is-${node.status}`}>{node.status}</span>
      <strong>{node.title}</strong>
      {detail.length ? <small>{detail.join(' · ')}</small> : null}
    </section>
  )
}

const styles = `
  .copilot-agent-workbench{min-width:0;border-bottom:1px solid #e3e3e6;background:#fff;color:#262628;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .copilot-runbar{display:grid;min-height:46px;grid-template-columns:auto minmax(88px,1fr) auto auto;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #e9e9eb;background:#fafafa}
  .copilot-runbar-status,.copilot-run-metrics,.copilot-run-metrics span{display:flex;align-items:center}
  .copilot-runbar-status{gap:7px;font-size:11px;line-height:1;white-space:nowrap}.copilot-runbar-status strong{color:#242426;font-size:11px;font-weight:650}.copilot-runbar-status>span:last-child{color:#77777d;font-variant-numeric:tabular-nums}
  .copilot-run-dot{width:7px;height:7px;border-radius:50%;background:#b8b8be}.copilot-run-dot.is-executing,.copilot-run-dot.is-planning{background:#3b6eea;box-shadow:0 0 0 3px #e4ebff}.copilot-run-dot.is-failed{background:#d04d4d}.copilot-run-dot.is-waiting_approval,.copilot-run-dot.is-waiting_input{background:#c88127}.copilot-run-dot.is-completed{background:#2d9563}.copilot-run-dot.is-stopping{background:#6d6d74}
  .copilot-run-progress{height:3px;overflow:hidden;border-radius:99px;background:#e5e5e8}.copilot-run-progress span{display:block;height:100%;border-radius:inherit;background:#4a72da;transition:width .22s ease}
  .copilot-run-metrics{gap:10px;color:#737379;font-size:10px}.copilot-run-metrics span{gap:4px;white-space:nowrap;font-variant-numeric:tabular-nums}.copilot-run-metrics svg{color:#8c8c92}
  .copilot-run-actions{display:flex;align-items:center;gap:4px}.copilot-run-action,.copilot-run-retry,.copilot-run-collapse{display:grid;width:28px;height:28px;place-items:center;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}.copilot-run-action{color:#c64444}.copilot-run-action:hover{border-color:#f0cdcd;background:#fff3f3}.copilot-run-retry{color:#446dc9}.copilot-run-retry:hover:not(:disabled){border-color:#cbd9fa;background:#f1f5ff}.copilot-run-retry:disabled{cursor:not-allowed;opacity:.42}.copilot-run-collapse{color:#626269}.copilot-run-collapse:hover{border-color:#e0e0e3;background:#f0f0f2}.copilot-run-action:focus-visible,.copilot-run-retry:focus-visible,.copilot-run-collapse:focus-visible,.copilot-workbench-tabs button:focus-visible{outline:2px solid #6d95ed;outline-offset:-2px}
  .copilot-workbench-tabs{display:flex;height:35px;align-items:end;gap:0;padding:0 12px;border-bottom:1px solid #e7e7ea;background:#fff}
  .copilot-workbench-tabs button{display:flex;height:35px;align-items:center;gap:5px;padding:0 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:#78787e;font:600 10px/1 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:0;cursor:pointer;transition:color .15s ease,background-color .15s ease}.copilot-workbench-tabs button:hover{color:#36363a;background:#f7f7f8}.copilot-workbench-tabs button[aria-selected="true"]{border-bottom-color:#4c78df;color:#303c65}.copilot-workbench-tabs button span{min-width:17px;padding:2px 4px;border-radius:4px;background:#f0f0f2;color:#77777d;font-size:9px;font-weight:600;line-height:1;text-align:center}.copilot-workbench-tabs button[aria-selected="true"] span{background:#e8eeff;color:#4767bf}
  .copilot-workbench-view{max-height:176px;min-height:42px;overflow:auto;background:#fff;scrollbar-color:#c8c8cd transparent;scrollbar-width:thin}
  .copilot-agent-workbench[data-variant="inspector"]{display:grid;height:100%;grid-template-rows:auto auto minmax(0,1fr);border-bottom:0}.copilot-agent-workbench[data-variant="inspector"] .copilot-workbench-view{max-height:none;min-height:0}.copilot-agent-workbench[data-variant="inspector"] .copilot-runbar{min-height:50px}
  .copilot-workbench-empty{display:flex;min-height:62px;align-items:center;padding:14px 16px;color:#898990;font-size:11px}
  .copilot-plan-list{display:grid}.copilot-plan-node{position:relative;display:grid;width:100%;min-height:44px;grid-template-columns:31px 22px minmax(0,1fr);align-items:center;padding:0 16px;border:0;border-bottom:1px solid #efeff1;background:#fff;text-align:left;transition:background-color .15s ease;cursor:pointer}.copilot-plan-node:hover{background:#fafafa}.copilot-plan-node[aria-current="true"]{background:#eef3ff;box-shadow:inset 2px 0 #4c78df}.copilot-plan-node:focus-visible{outline:2px solid #6d95ed;outline-offset:-2px}.copilot-plan-node.is-subagent-run{background:#f8faff}.copilot-plan-node.is-subagent-run:hover{background:#f3f6ff}.copilot-plan-node.is-subagent-task{background:#fff}.copilot-plan-node.is-subagent-task:before{position:absolute;top:0;bottom:0;left:30px;border-left:1px solid #d9dce5;content:""}.copilot-plan-index{position:relative;z-index:1;color:#9999a1;font:600 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.copilot-plan-state{position:relative;z-index:1;display:grid;width:18px;height:18px;place-items:center;color:#a2a2a9}.copilot-plan-node.is-subagent-run .copilot-plan-state{color:#586fba}.copilot-plan-node.is-completed .copilot-plan-state{color:#319467}.copilot-plan-node.is-running .copilot-plan-state{color:#4277e7}.copilot-plan-node.is-failed .copilot-plan-state{color:#ca4b4b}.copilot-plan-node.is-cancelled .copilot-plan-state{color:#9a7538}.copilot-plan-copy{display:grid;min-width:0;gap:3px}.copilot-plan-copy strong,.copilot-plan-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-plan-copy strong{color:#2c2c2f;font-size:11px;font-weight:590}.copilot-plan-copy small{color:#85858c;font-size:9px}.copilot-plan-detail{display:grid;gap:4px;padding:11px 15px;border-bottom:1px solid #dbe4fb;background:#f6f8ff}.copilot-plan-detail strong{overflow:hidden;color:#28324d;font-size:11px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.copilot-plan-detail small{color:#66718c;font-size:9px;line-height:1.4}.copilot-plan-detail-state{justify-self:start;padding:2px 5px;border:1px solid #d8dce7;border-radius:3px;background:#fff;color:#747982;font:600 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.copilot-plan-detail-state.is-running{border-color:#cedbfd;background:#eef3ff;color:#3c66c8}.copilot-plan-detail-state.is-completed{border-color:#cde7dc;background:#f1fbf6;color:#27835a}.copilot-plan-detail-state.is-failed{border-color:#f0cccc;background:#fff5f5;color:#b94a4a}
  .copilot-activity-list{display:grid}.copilot-activity-item{display:grid;min-height:45px;grid-template-columns:27px minmax(0,1fr) 44px;align-items:center;padding:0 16px;border-bottom:1px solid #efeff1;background:#fff;transition:background-color .15s ease}.copilot-activity-item:hover{background:#fafafa}.copilot-activity-icon{display:grid;width:20px;height:20px;place-items:center;color:#71809e}.copilot-activity-item.is-failed .copilot-activity-icon{color:#ca4b4b}.copilot-activity-item.is-running .copilot-activity-icon{color:#4277e7}.copilot-activity-copy{display:grid;min-width:0;gap:3px}.copilot-activity-copy strong,.copilot-activity-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-activity-copy strong{color:#303033;font-size:11px;font-weight:590}.copilot-activity-copy small,.copilot-activity-item time{color:#898990;font-size:9px}.copilot-activity-item time{text-align:right;font-variant-numeric:tabular-nums}
  .copilot-evidence-layout{display:grid;grid-template-columns:96px minmax(0,1fr);min-height:74px}.copilot-evidence-score{display:grid;align-content:center;justify-items:center;border-right:1px solid #e9e9eb;background:#fafafa}.copilot-evidence-score span{color:#496fcf;font-size:21px;font-weight:700;font-variant-numeric:tabular-nums}.copilot-evidence-score small{color:#85858c;font-size:9px}.copilot-evidence-list{display:grid}.copilot-evidence-item{display:grid;min-height:44px;grid-template-columns:25px minmax(0,1fr);align-items:center;padding:0 14px;border-bottom:1px solid #efeff1;background:#fff}.copilot-evidence-item>span:first-child{display:grid;width:19px;height:19px;place-items:center}.copilot-evidence-item .is-verified{color:#319467}.copilot-evidence-item .is-unverified{color:#c65a4d}.copilot-evidence-item .is-source{color:#4771d7}.copilot-evidence-item .is-artifact{color:#8a6d36}.copilot-evidence-item>span:last-child{display:grid;min-width:0;gap:3px}.copilot-evidence-item strong,.copilot-evidence-item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-evidence-item strong{color:#303033;font-size:11px;font-weight:590}.copilot-evidence-item small{color:#898990;font-size:9px}
  .copilot-spin{animation:data-copilot-spin 1s linear infinite}
  @media(max-width:680px){.copilot-runbar{grid-template-columns:auto minmax(50px,1fr) auto;padding:0 10px;gap:8px}.copilot-run-metrics{display:none}.copilot-workbench-view{max-height:148px}.copilot-evidence-layout{grid-template-columns:76px minmax(0,1fr)}.copilot-plan-node,.copilot-activity-item{padding-right:10px;padding-left:10px}.copilot-plan-node{grid-template-columns:27px 22px minmax(0,1fr)}.copilot-plan-node.is-subagent-task:before{left:24px}}
`
