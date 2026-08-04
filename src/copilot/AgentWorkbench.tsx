import { useState } from 'react'
import { Activity, ListTree, ShieldCheck } from 'lucide-react'

import { ActivityTimeline } from './ActivityTimeline'
import { EvidenceInspector } from './EvidenceInspector'
import { PlanView } from './PlanView'
import { RunBar } from './RunBar'
import type { WorkbenchProjection } from './workbench-types'

type WorkbenchTab = 'plan' | 'activity' | 'evidence'

export function AgentWorkbench({
  projection,
  sourceCount,
  onCancel,
}: {
  projection: WorkbenchProjection
  sourceCount: number
  onCancel?: () => void
}) {
  const [tab, setTab] = useState<WorkbenchTab>('plan')
  const [collapsed, setCollapsed] = useState(false)
  const tabs = [
    { id: 'plan' as const, label: '计划', count: projection.nodes.length, icon: ListTree },
    { id: 'activity' as const, label: '活动', count: projection.activities.length, icon: Activity },
    { id: 'evidence' as const, label: '证据', count: projection.evidence.sources.length, icon: ShieldCheck },
  ]
  return (
    <section className="copilot-agent-workbench" aria-label="智能体运行工作台">
      <style>{styles}</style>
      <RunBar
        projection={projection}
        sourceCount={sourceCount}
        onCancel={onCancel}
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
        {tab === 'plan' ? <PlanView nodes={projection.nodes} /> : null}
        {tab === 'activity' ? <ActivityTimeline activities={projection.activities} /> : null}
        {tab === 'evidence' ? <EvidenceInspector evidence={projection.evidence} /> : null}
      </div> : null}
    </section>
  )
}

const styles = `
  .copilot-agent-workbench{min-width:0;border-bottom:1px solid #d6d1c7;background:#f5f2ea;color:#26342d}
  .copilot-runbar{display:grid;min-height:40px;grid-template-columns:auto minmax(80px,1fr) auto auto;align-items:center;gap:12px;padding:0 16px;background:#ece8de}
  .copilot-runbar-status,.copilot-run-metrics,.copilot-run-metrics span{display:flex;align-items:center}
  .copilot-runbar-status{gap:7px;font-size:11px}.copilot-runbar-status strong{font-size:11px}.copilot-runbar-status>span:last-child{color:#69736d;font-variant-numeric:tabular-nums}
  .copilot-run-dot{width:7px;height:7px;border-radius:50%;background:#a5aca8}.copilot-run-dot.is-executing,.copilot-run-dot.is-planning{background:#167d63;box-shadow:0 0 0 3px #d3e9df}.copilot-run-dot.is-failed{background:#c24f42}.copilot-run-dot.is-waiting_approval{background:#c07a28}.copilot-run-dot.is-completed{background:#24795b}
  .copilot-run-progress{height:4px;overflow:hidden;background:#d2cec4}.copilot-run-progress span{display:block;height:100%;background:#237b5d;transition:width .22s ease}
  .copilot-run-metrics{gap:12px;color:#65706a;font-size:10px}.copilot-run-metrics span{gap:4px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .copilot-run-actions{display:flex;align-items:center;gap:5px}.copilot-run-action,.copilot-run-collapse{display:grid;width:27px;height:27px;place-items:center;padding:0;border:1px solid #c9c3b8;border-radius:5px;background:#fbf9f4;cursor:pointer}.copilot-run-action{color:#aa4539}.copilot-run-collapse{color:#59675f}
  .copilot-workbench-tabs{display:flex;height:32px;align-items:end;gap:2px;padding:0 14px;border-top:1px solid #ddd8cd;background:#faf8f3}
  .copilot-workbench-tabs button{display:flex;height:31px;align-items:center;gap:5px;padding:0 9px;border:0;border-bottom:2px solid transparent;background:transparent;color:#6c7670;font:inherit;font-size:10px;font-weight:650;cursor:pointer}
  .copilot-workbench-tabs button[aria-selected="true"]{border-bottom-color:#237b5d;color:#1e684f}.copilot-workbench-tabs button span{min-width:17px;padding:1px 4px;border-radius:3px;background:#e6e2d8;color:#6f7772;font-size:9px;text-align:center}
  .copilot-workbench-view{max-height:142px;min-height:40px;overflow:auto;background:#fffdf8}
  .copilot-workbench-empty{display:flex;min-height:56px;align-items:center;padding:12px 18px;color:#858d88;font-size:10px}
  .copilot-plan-list{display:grid}.copilot-plan-node{display:grid;min-height:42px;grid-template-columns:26px 20px minmax(0,1fr);align-items:center;padding:0 16px;border-bottom:1px solid #ece8df}.copilot-plan-index{color:#9aa19d;font:600 9px ui-monospace,SFMono-Regular,Consolas,monospace}.copilot-plan-state{display:grid;width:18px;height:18px;place-items:center;color:#86908a}.copilot-plan-node.is-completed .copilot-plan-state{color:#217457}.copilot-plan-node.is-running .copilot-plan-state{color:#177c9b}.copilot-plan-node.is-failed .copilot-plan-state{color:#bf4e42}.copilot-plan-copy{display:grid;min-width:0;gap:2px}.copilot-plan-copy strong,.copilot-plan-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-plan-copy strong{font-size:10px}.copilot-plan-copy small{color:#7d8681;font-size:9px}
  .copilot-activity-list{display:grid}.copilot-activity-item{display:grid;min-height:43px;grid-template-columns:24px minmax(0,1fr) 42px;align-items:center;padding:0 16px;border-bottom:1px solid #ece8df}.copilot-activity-icon{display:grid;width:19px;height:19px;place-items:center;color:#557067}.copilot-activity-item.is-failed .copilot-activity-icon{color:#bd4c40}.copilot-activity-copy{display:grid;min-width:0;gap:2px}.copilot-activity-copy strong,.copilot-activity-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-activity-copy strong{font-size:10px}.copilot-activity-copy small,.copilot-activity-item time{color:#7d8681;font-size:9px}.copilot-activity-item time{text-align:right}
  .copilot-evidence-layout{display:grid;grid-template-columns:92px minmax(0,1fr);min-height:70px}.copilot-evidence-score{display:grid;align-content:center;justify-items:center;border-right:1px solid #e4dfd5;background:#f2f7f8}.copilot-evidence-score span{color:#16728b;font-size:21px;font-weight:740;font-variant-numeric:tabular-nums}.copilot-evidence-score small{color:#687a80;font-size:9px}.copilot-evidence-list{display:grid}.copilot-evidence-item{display:grid;min-height:42px;grid-template-columns:24px minmax(0,1fr);align-items:center;padding:0 14px;border-bottom:1px solid #ece8df}.copilot-evidence-item>span:first-child{display:grid;width:19px;height:19px;place-items:center}.copilot-evidence-item .is-verified{color:#247657}.copilot-evidence-item .is-unverified{color:#bd5748}.copilot-evidence-item .is-source{color:#14728d}.copilot-evidence-item .is-artifact{color:#916522}.copilot-evidence-item>span:last-child{display:grid;min-width:0;gap:2px}.copilot-evidence-item strong,.copilot-evidence-item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copilot-evidence-item strong{font-size:10px}.copilot-evidence-item small{color:#79837d;font-size:9px}
  .copilot-spin{animation:data-copilot-spin 1s linear infinite}
  @media(max-width:680px){.copilot-runbar{grid-template-columns:auto minmax(50px,1fr) auto;padding:0 10px;gap:8px}.copilot-run-metrics{display:none}.copilot-workbench-view{max-height:118px}.copilot-evidence-layout{grid-template-columns:74px minmax(0,1fr)}}
`
