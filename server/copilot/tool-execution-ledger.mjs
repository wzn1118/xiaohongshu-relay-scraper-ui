import crypto from 'node:crypto';

import { canonicalJson } from './runtime-v3/index.mjs';

/**
 * Projects a durable tool receipt into the V3 step/effect/artifact/grant
 * ledgers. ToolExecutionBroker remains the lifecycle authority; this module
 * adds the immutable evidence required to inspect a completed task without
 * keeping raw tool inputs or outputs in a second storage location.
 */
export function synchronizeToolExecutionLedger({
  repository,
  durableReceipt,
  descriptor = {},
  project = {},
  workspace = {},
  authority = {},
} = {}) {
  if (!isLedgerRepository(repository)) return null;

  const executionId = text(durableReceipt?.executionId || durableReceipt?.toolExecutionId);
  if (!executionId) return null;
  const execution = repository.getExecution(executionId);
  if (!execution) return null;

  const toolName = text(durableReceipt?.toolName || descriptor?.name || execution.metadata?.toolName);
  const effectClass = normalizedEffectClass(durableReceipt?.effectClass || execution.metadata?.effectClass);
  const inputHash = stableDigest(
    durableReceipt?.inputHash || execution.metadata?.inputHash,
    canonicalJson({ toolName }),
  );
  const stableId = sha256(`${executionId}:${toolName}:${inputHash}`);
  const environment = publicEnvironment(execution.context?.environment, project, workspace);
  const policy = publicPolicy({ authority, execution, environment, toolName, effectClass });
  const policyHash = sha256(canonicalJson(policy));
  const ids = {
    inputArtifactId: `tool-input-${stableId.slice(0, 32)}`,
    outputArtifactId: `tool-output-${stableId.slice(0, 32)}`,
    stepId: `tool-step-${stableId.slice(0, 32)}`,
    effectId: `tool-effect-${stableId.slice(0, 32)}`,
    grantId: `tool-grant-${stableId.slice(0, 32)}`,
  };
  const inputRef = `runtime-v3://executions/${encodeURIComponent(executionId)}/inputs/${inputHash}`;
  const stepStatus = stepStatusFor(execution.status);
  const effectStatus = effectStatusFor(execution.status, effectClass);
  const descriptorVersion = descriptorIdentity(descriptor, toolName);

  const inputArtifact = repository.createExecutionArtifact({
    artifactId: ids.inputArtifactId,
    executionId,
    kind: 'tool.input.digest',
    mimeType: 'application/json',
    contentHash: inputHash,
    storageRef: inputRef,
    sizeBytes: 0,
    metadata: {
      redacted: true,
      role: 'tool_input',
      toolName,
    },
  });
  let step = upsertStep(repository, {
    stepId: ids.stepId,
    executionId,
    kind: 'tool.call',
    status: stepStatus,
    handlerKey: 'tool.call',
    effectClass,
    descriptorVersion,
    idempotencyKey: `ledger:tool-call:${stableId}`,
    inputRef: inputArtifact.storageRef,
    inputHash,
    metadata: {
      source: text(descriptor?.source || execution.metadata?.source),
      toolName,
      risk: text(descriptor?.risk),
    },
  });
  let effect = upsertEffect(repository, {
    effectId: ids.effectId,
    executionId,
    stepId: step.stepId,
    effectClass,
    requestHash: inputHash,
    probeKey: `tool:${toolName}`,
    status: effectStatus,
    reconciliationPolicy: reconciliationPolicyFor(effectClass),
    preStateRef: inputArtifact.storageRef,
    metadata: { toolName },
  });
  const grant = repository.createAuthorityGrant({
    grantId: ids.grantId,
    executionId,
    actorId: text(execution.context?.authority?.actorId || authority?.actorId) || 'local-owner',
    projectId: environment.projectId || 'unbound-project',
    workspaceId: environment.workspaceId || 'unbound-workspace',
    worktreeId: environment.worktreeId,
    policyHash,
    capabilities: policy,
    maxAgentDepth: 0,
    expiresAt: execution.context?.deadlineAt,
    metadata: { serverDerived: true },
  });

  let outputArtifact = null;
  if (terminalStatus(execution.status) && durableReceipt?.result !== undefined) {
    const output = canonicalJson(durableReceipt.result);
    const outputRef = `runtime-v3://executions/${encodeURIComponent(executionId)}/outputs/${sha256(output)}`;
    outputArtifact = repository.createExecutionArtifact({
      artifactId: ids.outputArtifactId,
      executionId,
      stepId: step.stepId,
      kind: 'tool.output.digest',
      mimeType: 'application/json',
      contentHash: sha256(output),
      storageRef: outputRef,
      sizeBytes: Buffer.byteLength(output),
      metadata: {
        redacted: true,
        role: 'tool_output',
        toolName,
      },
    });
    ({ step, effect } = linkOutputEvidence(repository, {
      step,
      effect,
      outputRef,
      receiptRef: `runtime-v3://executions/${encodeURIComponent(executionId)}/receipts/${stableId}`,
    }));
  }

  return Object.freeze({
    schemaVersion: 1,
    executionId,
    environment,
    step: publicStep(step),
    effect: publicEffect(effect),
    authority: {
      grantId: grant.grantId,
      profile: String(policy.profile || 'observe'),
      expiresAt: grant.expiresAt,
      maxAgentDepth: grant.maxAgentDepth,
    },
    artifacts: Object.freeze([
      publicArtifact(inputArtifact),
      ...(outputArtifact ? [publicArtifact(outputArtifact)] : []),
    ]),
  });
}

export function describeToolExecutionLedger({ repository, durableReceipt } = {}) {
  if (!isLedgerRepository(repository)) return null;
  const executionId = text(durableReceipt?.executionId || durableReceipt?.toolExecutionId);
  if (!executionId || !repository.getExecution(executionId)) return null;

  const artifacts = repository.listExecutionArtifacts({ executionId, limit: 20 })
    .filter((artifact) => artifact.kind === 'tool.input.digest' || artifact.kind === 'tool.output.digest')
    .map(publicArtifact);
  const steps = repository.listExecutionSteps({ executionId, limit: 20 })
    .filter((step) => step.kind === 'tool.call');
  const effects = repository.listExecutionEffects({ executionId, limit: 20 });
  const grants = repository.listAuthorityGrants({ executionId, limit: 20 });
  const environment = publicEnvironment(durableReceipt?.context?.environment);
  return Object.freeze({
    schemaVersion: 1,
    executionId,
    environment,
    ...(steps[0] ? { step: publicStep(steps[0]) } : {}),
    ...(effects[0] ? { effect: publicEffect(effects[0]) } : {}),
    ...(grants[0] ? {
      authority: {
        grantId: grants[0].grantId,
        profile: String(grants[0].capabilities?.profile || 'observe'),
        expiresAt: grants[0].expiresAt,
        maxAgentDepth: grants[0].maxAgentDepth,
      },
    } : {}),
    artifacts: Object.freeze(artifacts),
  });
}

function upsertStep(repository, input) {
  const existing = repository.getExecutionStep(input.stepId);
  if (!existing) return repository.createExecutionStep(input);
  if (existing.status === input.status) return existing;
  return transitionOrRead(() => repository.transitionExecutionStep(existing.stepId, {
    expectedStatuses: ['pending', 'claimed', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'reconcile_required', 'skipped'],
    patch: {
      status: input.status,
      ...(terminalStepStatus(input.status) ? { completedAt: new Date().toISOString() } : {}),
      ...(input.status === 'running' ? { startedAt: existing.startedAt || new Date().toISOString(), attempt: Math.max(1, existing.attempt) } : {}),
    },
  }).step, () => repository.getExecutionStep(existing.stepId));
}

function upsertEffect(repository, input) {
  const existing = repository.getExecutionEffect(input.effectId);
  if (!existing) return repository.createExecutionEffect(input);
  if (existing.status === input.status) return existing;
  return transitionOrRead(() => repository.transitionExecutionEffect(existing.effectId, {
    expectedStatuses: ['prepared', 'started', 'unknown', 'committed', 'rolled_back', 'reconciled'],
    patch: { status: input.status },
  }), () => repository.getExecutionEffect(existing.effectId));
}

function transitionOrRead(transition, read) {
  try {
    return transition();
  } catch (error) {
    if (error?.code !== 'RUNTIME_V3_STEP_STATE_CONFLICT' && error?.code !== 'RUNTIME_V3_EFFECT_STATE_CONFLICT') throw error;
    const current = read();
    if (!current) throw error;
    return current;
  }
}

function linkOutputEvidence(repository, { step, effect, outputRef, receiptRef }) {
  const linkedStep = step.resultRef === outputRef
    ? step
    : transitionOrRead(() => repository.transitionExecutionStep(step.stepId, {
      expectedStatuses: [step.status],
      patch: {
        status: step.status,
        resultRef: outputRef,
        ...(terminalStepStatus(step.status) ? { completedAt: step.completedAt || new Date().toISOString() } : {}),
      },
    }).step, () => repository.getExecutionStep(step.stepId));
  const linkedEffect = effect.postStateRef === outputRef && effect.receiptRef === receiptRef
    ? effect
    : transitionOrRead(() => repository.transitionExecutionEffect(effect.effectId, {
      expectedStatuses: [effect.status],
      patch: {
        status: effect.status,
        postStateRef: outputRef,
        receiptRef,
      },
    }), () => repository.getExecutionEffect(effect.effectId));
  return { step: linkedStep, effect: linkedEffect };
}

function publicEnvironment(source = {}, project = {}, workspace = {}) {
  const environment = object(source);
  const selectedProjectId = text(environment.projectId || project?.id);
  const selectedWorkspaceId = text(environment.workspaceId || workspace?.id);
  const selectedWorktreeId = text(environment.worktreeId || (workspace?.kind === 'worktree' ? workspace.id : ''));
  return Object.freeze({
    kind: text(environment.kind) || 'project_workspace',
    ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
    ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
    ...(selectedWorktreeId ? { worktreeId: selectedWorktreeId } : {}),
  });
}

function publicPolicy({ authority, execution, environment, toolName, effectClass }) {
  const source = object(authority);
  const inherited = object(execution.context?.authority);
  return {
    source: 'server_derived',
    profile: text(inherited.profile || source.profile) || 'observe',
    trustedLocal: inherited.trustedLocal === true || source.trustedLocal === true,
    environment,
    tool: toolName,
    effectClass,
  };
}

function publicStep(value) {
  return Object.freeze({
    stepId: value.stepId,
    status: value.status,
    kind: value.kind,
    effectClass: value.effectClass,
    handlerKey: value.handlerKey,
  });
}

function publicEffect(value) {
  return Object.freeze({
    effectId: value.effectId,
    status: value.status,
    effectClass: value.effectClass,
    reconciliationPolicy: value.reconciliationPolicy,
  });
}

function publicArtifact(value) {
  return Object.freeze({
    artifactId: value.artifactId,
    kind: value.kind,
    mimeType: value.mimeType,
    contentHash: value.contentHash,
    sizeBytes: value.sizeBytes,
  });
}

function stepStatusFor(status) {
  return ({
    queued: 'pending',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    reconcile_required: 'reconcile_required',
  })[text(status)] || 'pending';
}

function effectStatusFor(status, effectClass) {
  const normalized = text(status);
  if (normalized === 'queued') return 'prepared';
  if (normalized === 'running') return 'started';
  if (normalized === 'succeeded') return 'committed';
  if (normalized === 'reconcile_required') return 'unknown';
  return effectClass === 'read' ? 'rolled_back' : 'unknown';
}

function reconciliationPolicyFor(effectClass) {
  if (effectClass === 'read') return 'not_required';
  if (effectClass === 'idempotent_write') return 'probe_then_retry';
  return 'manual';
}

function descriptorIdentity(descriptor, toolName) {
  const version = text(descriptor?.version || descriptor?.schemaVersion);
  return `${toolName || 'tool'}@${version || '1'}`;
}

function normalizedEffectClass(value) {
  const effectClass = text(value);
  return ['read', 'idempotent_write', 'non_idempotent'].includes(effectClass) ? effectClass : 'non_idempotent';
}

function terminalStatus(value) {
  return ['succeeded', 'failed', 'cancelled', 'reconcile_required'].includes(text(value));
}

function terminalStepStatus(value) {
  return ['succeeded', 'failed', 'cancelled', 'reconcile_required', 'skipped'].includes(text(value));
}

function isLedgerRepository(value) {
  return Boolean(
    value
    && typeof value.getExecution === 'function'
    && typeof value.createExecutionArtifact === 'function'
    && typeof value.createExecutionStep === 'function'
    && typeof value.createExecutionEffect === 'function'
    && typeof value.createAuthorityGrant === 'function'
    && typeof value.listExecutionArtifacts === 'function'
    && typeof value.listExecutionSteps === 'function'
    && typeof value.listExecutionEffects === 'function'
    && typeof value.listAuthorityGrants === 'function',
  );
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableDigest(value, fallback) {
  const candidate = text(value);
  return /^[a-f0-9]{64}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : sha256(candidate || fallback);
}
