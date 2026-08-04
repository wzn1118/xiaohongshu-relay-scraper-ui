import { CheckCircle2, FileOutput, Link2, ShieldAlert } from 'lucide-react'

import type { WorkbenchEvidence } from './workbench-types'

export function EvidenceInspector({ evidence }: { evidence: WorkbenchEvidence }) {
  const coverage = Math.round(evidence.coverage * 100)
  if (!evidence.claims.length && !evidence.sources.length && !evidence.artifacts.length) {
    return <div className="copilot-workbench-empty">引用、产物与可验证结论会汇总在这里。</div>
  }
  return (
    <div className="copilot-evidence-layout">
      <div className="copilot-evidence-score">
        <span>{coverage}%</span>
        <small>结论覆盖</small>
      </div>
      <div className="copilot-evidence-list" aria-label="证据声明">
        {evidence.claims.map((claim) => (
          <div className="copilot-evidence-item" key={claim.id}>
            <span className={claim.verified ? 'is-verified' : 'is-unverified'}>
              {claim.verified ? <CheckCircle2 size={13} aria-hidden="true" /> : <ShieldAlert size={13} aria-hidden="true" />}
            </span>
            <span><strong>{claim.text}</strong><small>{claim.sourceRefs.length} 个来源</small></span>
          </div>
        ))}
        {evidence.sources.map((source) => (
          <div className="copilot-evidence-item" key={`source:${source.id}`}>
            <span className="is-source"><Link2 size={13} aria-hidden="true" /></span>
            <span><strong>{source.label}</strong><small>{source.excerpt || source.id}</small></span>
          </div>
        ))}
        {evidence.artifacts.map((artifact) => (
          <div className="copilot-evidence-item" key={`artifact:${artifact.id}`}>
            <span className="is-artifact"><FileOutput size={13} aria-hidden="true" /></span>
            <span><strong>{artifact.name}</strong><small>{artifact.status}</small></span>
          </div>
        ))}
      </div>
    </div>
  )
}
