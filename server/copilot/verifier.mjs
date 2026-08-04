import { normalizeAnswerAst } from './answer-ast.mjs';
import { EvidenceGraph, recalculate } from './evidence-graph.mjs';

export function verifyAnswer({
  objective = '',
  answer,
  evidence = [],
  evidenceGraph = null,
  claims = [],
  calculations = [],
  artifacts = [],
  requireEvidence = false,
  strict = false,
  now = () => new Date(),
} = {}) {
  const ast = normalizeAnswerAst(answer);
  const graph = normalizeGraph({ evidence, evidenceGraph, claims, calculations, artifacts });
  const sourceIds = new Set(graph.sources.map((item) => String(item?.sourceId || item?.id || item?.uri || item).trim()).filter(Boolean));
  const artifactIds = new Set(graph.artifacts.map((item) => String(item?.artifactId || item?.id || '').trim()).filter(Boolean));
  const claimRecords = new Map(graph.claims.map((item) => [String(item?.claimId || item?.id || ''), item]));
  const issues = [];
  if (ast.blocks.length === 0) issues.push({ code: 'empty_answer', message: 'Answer AST has no blocks.' });
  const answerClaimIds = new Set(ast.blocks.flatMap((block) => block.claimIds || []).map(String).filter(Boolean));
  for (const block of ast.blocks) {
    for (const sourceRef of block.sourceRefs || []) {
      if (sourceIds.size > 0 && !sourceIds.has(sourceRef)) issues.push({ code: 'unknown_source', blockId: block.id, sourceRef });
    }
  }
  if (requireEvidence && sourceIds.size === 0 && answerClaimIds.size === 0) issues.push({ code: 'missing_evidence', message: 'Evidence is required for this answer.' });
  if (strict) {
    for (const claimId of answerClaimIds) {
      const claim = claimRecords.get(claimId);
      if (!claim) {
        issues.push({ code: 'claim_not_registered', claimId });
        continue;
      }
      const hasLineage = stringList(claim.sourceRefs).length || stringList(claim.calculationRefs).length || stringList(claim.artifactRefs).length;
      if (!hasLineage) issues.push({ code: 'claim_without_evidence', claimId });
    }
  }
  for (const artifact of ast.artifacts || []) {
    const id = String(artifact?.artifactId || artifact?.id || '').trim();
    if (id && artifactIds.size > 0 && !artifactIds.has(id)) issues.push({ code: 'unknown_artifact', artifactId: id });
  }
  const calculationResults = graph.calculations.map((calculation) => verifyCalculation(calculation));
  for (const result of calculationResults) {
    if (!result.passed && (strict || result.code !== 'calculation_operation_unsupported')) issues.push(result);
  }
  const checkedAt = now().toISOString();
  for (const source of graph.sources) {
    if (source?.expiresAt && Date.parse(source.expiresAt) < Date.parse(checkedAt)) issues.push({ code: 'stale_source', sourceId: source.sourceId || source.id, expiresAt: source.expiresAt });
  }
  const analysis = graph.analysis || analyzeClaims(graph.claims);
  for (const conflict of analysis.conflicts || []) issues.push({ code: 'evidence_conflict', ...conflict });
  const supportedClaims = [...answerClaimIds].filter((claimId) => {
    const claim = claimRecords.get(claimId);
    return claim && (stringList(claim.sourceRefs).length || stringList(claim.calculationRefs).length || stringList(claim.artifactRefs).length);
  }).length;
  const coverage = answerClaimIds.size ? supportedClaims / answerClaimIds.size : requireEvidence && sourceIds.size === 0 ? 0 : 1;
  if (strict && coverage < 1) issues.push({ code: 'claim_coverage_incomplete', coverage, supportedClaims, totalClaims: answerClaimIds.size });
  return {
    schemaVersion: 2,
    passed: issues.length === 0,
    issues,
    metrics: { claimCoverage: coverage, supportedClaims, totalClaims: answerClaimIds.size, calculationsChecked: calculationResults.length },
    calculationResults,
    ast,
    checkedAt,
    objective: String(objective || '').slice(0, 2000),
  };
}

export function createVerifier(options = {}) { return { verify: (value) => verifyAnswer({ ...options, ...value }) }; }

function normalizeGraph({ evidence, evidenceGraph, claims, calculations, artifacts }) {
  if (evidenceGraph instanceof EvidenceGraph) return evidenceGraph.snapshot();
  if (evidenceGraph && typeof evidenceGraph === 'object') {
    return {
      sources: array(evidenceGraph.sources),
      claims: array(evidenceGraph.claims),
      calculations: array(evidenceGraph.calculations),
      artifacts: array(evidenceGraph.artifacts),
      analysis: evidenceGraph.analysis || null,
    };
  }
  return { sources: array(evidence), claims: array(claims), calculations: array(calculations), artifacts: array(artifacts), analysis: null };
}

function verifyCalculation(calculation) {
  const recomputed = recalculate(calculation);
  if (!recomputed.supported) return { passed: false, code: 'calculation_operation_unsupported', calculationId: calculation.calculationId || calculation.id, operation: calculation.operation };
  const expected = Number(calculation.result);
  const tolerance = Math.max(0, Number(calculation.tolerance || 1e-9));
  const delta = Math.abs(expected - recomputed.value);
  return {
    passed: Number.isFinite(expected) && delta <= tolerance,
    code: Number.isFinite(expected) && delta <= tolerance ? 'calculation_verified' : 'calculation_mismatch',
    calculationId: calculation.calculationId || calculation.id,
    expected,
    actual: recomputed.value,
    delta,
    tolerance,
  };
}

function analyzeClaims(claims) {
  const graph = new EvidenceGraph();
  for (const claim of claims) graph.addClaim(claim);
  return graph.analyze();
}

function array(value) { return Array.isArray(value) ? value : []; }
function stringList(value) { return Array.isArray(value) ? value.map(String).filter(Boolean) : []; }
