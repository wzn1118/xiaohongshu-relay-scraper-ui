export class EvidenceGraph {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.claims = new Map();
    this.sources = new Map();
    this.calculations = new Map();
    this.artifacts = new Map();
    this.edges = new Map();
  }

  addSource(source) {
    const id = identity(source, ['sourceId', 'id', 'uri']);
    if (!id) return null;
    this.sources.set(id, structuredClone({ ...source, sourceId: id, createdAt: source?.createdAt || this.now().toISOString() }));
    return id;
  }

  addCalculation(calculation) {
    const id = identity(calculation, ['calculationId', 'id']) || `calculation-${this.calculations.size + 1}`;
    const record = {
      ...structuredClone(calculation || {}),
      calculationId: id,
      operation: String(calculation?.operation || ''),
      inputs: Array.isArray(calculation?.inputs) ? structuredClone(calculation.inputs) : [],
      sourceRefs: stringList(calculation?.sourceRefs),
      createdAt: calculation?.createdAt || this.now().toISOString(),
    };
    this.calculations.set(id, record);
    for (const sourceId of record.sourceRefs) this.addEdge({ from: sourceId, to: id, relation: 'input_to' });
    return id;
  }

  addArtifact(artifact) {
    const id = identity(artifact, ['artifactId', 'id']);
    if (!id) return null;
    this.artifacts.set(id, structuredClone({ ...artifact, artifactId: id, createdAt: artifact?.createdAt || this.now().toISOString() }));
    return id;
  }

  addClaim(claim) {
    const id = identity(claim, ['claimId', 'id']) || `claim-${this.claims.size + 1}`;
    const record = {
      ...structuredClone(claim || {}),
      claimId: id,
      sourceRefs: stringList(claim?.sourceRefs),
      calculationRefs: stringList(claim?.calculationRefs),
      artifactRefs: stringList(claim?.artifactRefs),
      confidence: clamp(Number(claim?.confidence ?? 0.5), 0, 1),
      createdAt: claim?.createdAt || this.now().toISOString(),
    };
    this.claims.set(id, record);
    for (const sourceId of record.sourceRefs) this.addEdge({ from: sourceId, to: id, relation: 'supports' });
    for (const calculationId of record.calculationRefs) this.addEdge({ from: calculationId, to: id, relation: 'calculates' });
    for (const artifactId of record.artifactRefs) this.addEdge({ from: id, to: artifactId, relation: 'materialized_in' });
    return id;
  }

  addEdge(edge = {}) {
    const from = String(edge.from || '').trim();
    const to = String(edge.to || '').trim();
    const relation = String(edge.relation || 'related_to').trim();
    if (!from || !to) return null;
    const id = String(edge.edgeId || `${from}:${relation}:${to}`);
    this.edges.set(id, { edgeId: id, from, to, relation, metadata: structuredClone(edge.metadata || {}) });
    return id;
  }

  verifyCalculation(calculationId, { tolerance } = {}) {
    const calculation = this.calculations.get(String(calculationId));
    if (!calculation) return { passed: false, code: 'calculation_not_found', calculationId: String(calculationId) };
    const recomputed = recalculate(calculation);
    if (!recomputed.supported) return { passed: false, code: 'calculation_operation_unsupported', calculationId: calculation.calculationId, operation: calculation.operation };
    const expected = Number(calculation.result);
    const allowed = Number.isFinite(Number(tolerance)) ? Math.max(0, Number(tolerance)) : Math.max(0, Number(calculation.tolerance || 1e-9));
    const delta = Math.abs(expected - recomputed.value);
    return {
      passed: Number.isFinite(expected) && delta <= allowed,
      calculationId: calculation.calculationId,
      operation: calculation.operation,
      expected,
      actual: recomputed.value,
      delta,
      tolerance: allowed,
    };
  }

  analyze() {
    const claims = [...this.claims.values()];
    const supported = claims.filter((claim) => claim.sourceRefs.length || claim.calculationRefs.length || claim.artifactRefs.length);
    const groups = new Map();
    for (const claim of claims) {
      const key = String(claim.conflictKey || claim.metric || claim.subject || '').trim();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(claim);
    }
    const conflicts = [];
    for (const [key, values] of groups) {
      const distinct = new Set(values.map((claim) => normalizedClaimValue(claim)));
      if (distinct.size > 1) conflicts.push({ key, claimIds: values.map((claim) => claim.claimId), values: [...distinct] });
    }
    return {
      claimCount: claims.length,
      supportedClaimCount: supported.length,
      coverage: claims.length ? supported.length / claims.length : 1,
      conflicts,
    };
  }

  snapshot() {
    return {
      schemaVersion: 2,
      claims: cloneValues(this.claims),
      sources: cloneValues(this.sources),
      calculations: cloneValues(this.calculations),
      artifacts: cloneValues(this.artifacts),
      edges: cloneValues(this.edges),
      analysis: this.analyze(),
    };
  }
}

export function recalculate(calculation = {}) {
  const values = (Array.isArray(calculation.inputs) ? calculation.inputs : [])
    .map((input) => Number(input?.value ?? input))
    .filter(Number.isFinite);
  const operation = String(calculation.operation || '').toLowerCase();
  if (operation === 'count') return { supported: true, value: values.length };
  if (!values.length) return { supported: false, value: Number.NaN };
  if (operation === 'sum') return { supported: true, value: values.reduce((sum, value) => sum + value, 0) };
  if (operation === 'avg' || operation === 'average' || operation === 'mean') return { supported: true, value: values.reduce((sum, value) => sum + value, 0) / values.length };
  if (operation === 'min') return { supported: true, value: Math.min(...values) };
  if (operation === 'max') return { supported: true, value: Math.max(...values) };
  if (operation === 'difference' && values.length >= 2) return { supported: true, value: values[0] - values[1] };
  if ((operation === 'ratio' || operation === 'divide') && values.length >= 2 && values[1] !== 0) return { supported: true, value: values[0] / values[1] };
  if (operation === 'percentage' && values.length >= 2 && values[1] !== 0) return { supported: true, value: values[0] / values[1] * 100 };
  return { supported: false, value: Number.NaN };
}

function identity(value, keys) {
  for (const key of keys) {
    const result = String(value?.[key] || '').trim();
    if (result) return result;
  }
  return '';
}

function stringList(value) { return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : []; }
function cloneValues(map) { return [...map.values()].map((value) => structuredClone(value)); }
function clamp(value, minimum, maximum) { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum; }
function normalizedClaimValue(claim) { return JSON.stringify(claim.value ?? claim.text ?? '').toLocaleLowerCase(); }
