import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import {
  createExecutionContext,
  createRuntimeEvent,
  createRuntimeV3Repository,
} from './copilot/runtime-v3/index.mjs';

function executionContext(overrides = {}) {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    deadlineAt: '2026-08-16T10:00:00+08:00',
    idempotencyKey: 'task-1:attempt-1',
    environment: { workspaceId: 'workspace-1', roots: ['C:/workspace'] },
    authority: { profile: 'owner_local_full', tools: ['*'] },
    modelPolicy: { model: 'gpt-test', providers: ['responses'] },
    contextSnapshotId: 'context-1',
    ...overrides,
  };
}

test('ExecutionContext is normalized, JSON-only and deeply immutable', () => {
  const source = executionContext({ taskId: ' task-1 ', environment: { z: 2, a: { enabled: true } } });
  const context = createExecutionContext(source);

  assert.equal(context.schemaVersion, 3);
  assert.equal(context.taskId, 'task-1');
  assert.equal(context.deadlineAt, '2026-08-16T02:00:00.000Z');
  assert.deepEqual(Object.keys(context.environment), ['a', 'z']);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.environment.a), true);
  assert.throws(() => { context.environment.a.enabled = false; }, TypeError);
  source.environment.z = 99;
  assert.equal(context.environment.z, 2);

  assert.throws(
    () => createExecutionContext(executionContext({ environment: { invalid: Number.NaN } })),
    (error) => error.code === 'RUNTIME_V3_JSON_VALUE_INVALID',
  );
  assert.throws(
    () => createExecutionContext({ ...executionContext(), schemaVersion: 2 }),
    (error) => error.code === 'RUNTIME_V3_EXECUTION_CONTEXT_VERSION_UNSUPPORTED',
  );
});

test('RuntimeEvent requires the V3 envelope and positive monotonic-compatible sequence', () => {
  const event = createRuntimeEvent({
    eventId: 'event-1',
    streamId: 'run:run-1',
    sequence: 1,
    type: 'run.started',
    occurredAt: '2026-08-16T02:00:00.000Z',
    taskId: 'task-1',
    runId: 'run-1',
    payload: { plan: { revision: 1 } },
  });

  assert.equal(event.schemaVersion, 3);
  assert.equal(Object.isFrozen(event.payload.plan), true);
  assert.throws(
    () => createRuntimeEvent({ ...event, sequence: 0 }),
    (error) => error.code === 'RUNTIME_V3_EVENT_SEQUENCE_INVALID',
  );
  assert.throws(
    () => createRuntimeEvent({ ...event, schemaVersion: 4 }),
    (error) => error.code === 'RUNTIME_V3_EVENT_VERSION_UNSUPPORTED',
  );
});

test('RuntimeV3Repository migrates idempotently and persists immutable executions and ordered events', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-runtime-v3-'));
  const filePath = path.join(rootDir, 'copilot-state.sqlite');
  let nowMs = Date.parse('2026-08-16T02:00:00.000Z');
  const now = () => new Date(nowMs);
  let repository = createRuntimeV3Repository({ filePath, now });
  t.after(async () => {
    repository?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.deepEqual(
    { schemaVersion: repository.describe().schemaVersion, migrationVersion: repository.describe().migrationVersion },
    { schemaVersion: 3, migrationVersion: 2 },
  );
  const first = repository.createExecution({
    executionId: 'execution-1',
    context: executionContext(),
    metadata: { requestedBy: 'test' },
  });
  const retried = repository.createExecution({
    executionId: 'execution-retry-id',
    context: executionContext(),
    metadata: { ignoredOnIdempotentRetry: true },
  });
  assert.equal(first.executionId, 'execution-1');
  assert.equal(retried.executionId, first.executionId);
  assert.equal(Object.isFrozen(first.context.environment), true);
  assert.throws(
    () => repository.createExecution({
      executionId: 'execution-collision',
      context: executionContext({ runId: 'run-different' }),
    }),
    (error) => error.code === 'RUNTIME_V3_EXECUTION_IDEMPOTENCY_COLLISION' && error.status === 409,
  );

  const completed = repository.updateExecution(first.executionId, {
    status: 'completed',
    result: { ok: true },
    completedAt: '2026-08-16T02:01:00Z',
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { ok: true });

  const eventOne = repository.appendEvent({
    eventId: 'event-1',
    streamId: 'run:run-1',
    type: 'run.started',
    taskId: 'task-1',
    runId: 'run-1',
    payload: { status: 'running' },
  }, { expectedSequence: 0 });
  nowMs += 1_000;
  const eventTwo = repository.appendEvent({
    eventId: 'event-2',
    streamId: 'run:run-1',
    type: 'run.completed',
    taskId: 'task-1',
    runId: 'run-1',
    payload: { status: 'completed' },
  }, { expectedSequence: 1 });
  assert.deepEqual([eventOne.sequence, eventTwo.sequence], [1, 2]);
  assert.equal(repository.latestSequence('run:run-1'), 2);
  assert.deepEqual(repository.listEvents({ streamId: 'run:run-1', afterSequence: 1 }).map((event) => event.eventId), ['event-2']);
  nowMs += 1_000;
  const eventOneRetry = repository.appendEvent({
    eventId: 'event-1',
    streamId: 'run:run-1',
    type: 'run.started',
    taskId: 'task-1',
    runId: 'run-1',
    payload: { status: 'running' },
  });
  assert.deepEqual(eventOneRetry, eventOne);
  assert.equal(repository.latestSequence('run:run-1'), 2);
  assert.throws(
    () => repository.appendEvent({
      eventId: 'event-1',
      streamId: 'run:run-1',
      type: 'run.started',
      taskId: 'task-1',
      runId: 'run-1',
      payload: { status: 'different' },
    }),
    (error) => error.code === 'RUNTIME_V3_EVENT_ID_COLLISION' && error.status === 409,
  );
  assert.throws(
    () => repository.appendEvent({
      streamId: 'run:run-1', type: 'run.failed', taskId: 'task-1', runId: 'run-1', payload: {},
    }, { expectedSequence: 0 }),
    (error) => error.code === 'RUNTIME_V3_EVENT_SEQUENCE_CONFLICT' && error.status === 409,
  );

  repository.close();
  repository = createRuntimeV3Repository({ filePath, now });
  assert.equal(repository.getExecution('execution-1').status, 'completed');
  assert.equal(repository.latestSequence('run:run-1'), 2);
  assert.equal(
    repository.database.prepare('SELECT COUNT(*) AS count FROM runtime_v3_schema_migrations').get().count,
    2,
  );
});

test('RuntimeV3Repository stores step, effect, artifact and authority ledgers as immutable references', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-runtime-v3-ledger-'));
  const filePath = path.join(rootDir, 'copilot-state.sqlite');
  const repository = createRuntimeV3Repository({ filePath });
  t.after(async () => {
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const secretInput = 'Authorization: Bearer ledger-secret';
  const inputHash = crypto.createHash('sha256').update(secretInput).digest('hex');
  repository.createExecution({ executionId: 'execution-ledger', context: executionContext() });
  const inputArtifact = repository.createExecutionArtifact({
    artifactId: 'artifact-input',
    executionId: 'execution-ledger',
    kind: 'tool-input',
    mimeType: 'application/json',
    contentHash: inputHash,
    storageRef: 'artifact://execution-ledger/input',
    sizeBytes: secretInput.length,
  });
  const step = repository.createExecutionStep({
    stepId: 'step-tool',
    executionId: 'execution-ledger',
    ordinal: 1,
    kind: 'tool.call',
    handlerKey: 'tool.call',
    effectClass: 'idempotent_write',
    descriptorVersion: 'workspace.write@1',
    idempotencyKey: 'tool-call-1',
    inputRef: inputArtifact.storageRef,
    inputHash,
    maxAttempts: 2,
  });
  const effect = repository.createExecutionEffect({
    effectId: 'effect-tool',
    executionId: 'execution-ledger',
    stepId: step.stepId,
    effectClass: 'idempotent_write',
    requestHash: inputHash,
    probeKey: 'workspace:file.txt',
    reconciliationPolicy: 'probe_then_retry',
    preStateRef: 'artifact://execution-ledger/pre-state',
  });
  const grant = repository.createAuthorityGrant({
    grantId: 'grant-owner',
    executionId: 'execution-ledger',
    actorId: 'owner-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    policyHash: 'sha256:policy-1',
    capabilities: { tools: ['workspace.read', 'workspace.write', 'exec.run'], network: [] },
    maxAgentDepth: 1,
    expiresAt: '2026-08-17T12:00:00Z',
  });

  const transitionedStep = repository.transitionExecutionStep(step.stepId, {
    expectedStatuses: ['pending'],
    patch: {
      status: 'running',
      attempt: 1,
      startedAt: '2026-08-17T02:00:00Z',
    },
    event: { type: 'step.started', payload: { handlerKey: 'tool.call' }, expectedSequence: 0 },
  });
  const transitionedEffect = repository.transitionExecutionEffect(effect.effectId, {
    expectedStatuses: ['prepared'],
    patch: { status: 'started', metadata: { probeRequired: true } },
  });
  const revoked = repository.revokeAuthorityGrant(grant.grantId, { reason: 'task-completed' });

  assert.equal(transitionedStep.step.status, 'running');
  assert.equal(transitionedStep.event.sequence, 1);
  assert.equal(transitionedEffect.status, 'started');
  assert.equal(revoked.status, 'revoked');
  assert.equal(repository.listExecutionSteps({ executionId: 'execution-ledger' }).length, 1);
  assert.equal(repository.listExecutionEffects({ executionId: 'execution-ledger' }).length, 1);
  assert.equal(repository.listExecutionArtifacts({ executionId: 'execution-ledger' }).length, 1);
  assert.equal(repository.listAuthorityGrants({ executionId: 'execution-ledger' }).length, 1);
  assert.equal(Object.isFrozen(transitionedStep.step.metadata), true);
  assert.equal(Object.isFrozen(grant.capabilities), true);

  const stepRetry = repository.createExecutionStep({
    stepId: 'step-retry-id',
    executionId: 'execution-ledger',
    ordinal: 1,
    kind: 'tool.call',
    handlerKey: 'tool.call',
    effectClass: 'idempotent_write',
    descriptorVersion: 'workspace.write@1',
    idempotencyKey: 'tool-call-1',
    inputRef: inputArtifact.storageRef,
    inputHash,
  });
  assert.equal(stepRetry.stepId, step.stepId);
  assert.throws(
    () => repository.createExecutionStep({
      executionId: 'execution-ledger',
      kind: 'tool.call',
      idempotencyKey: 'tool-call-1',
      inputHash: 'different-hash',
    }),
    (error) => error.code === 'RUNTIME_V3_STEP_IDEMPOTENCY_COLLISION' && error.status === 409,
  );

  const ledgerRows = [
    ...repository.database.prepare('SELECT * FROM execution_steps').all(),
    ...repository.database.prepare('SELECT * FROM execution_effects').all(),
    ...repository.database.prepare('SELECT * FROM execution_artifacts').all(),
    ...repository.database.prepare('SELECT * FROM execution_authority_grants').all(),
  ];
  assert.equal(JSON.stringify(ledgerRows).includes(secretInput), false);
});

test('RuntimeV3Repository commits execution state and event atomically under a fencing lease', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-runtime-v3-transition-'));
  const filePath = path.join(rootDir, 'copilot-state.sqlite');
  let nowMs = Date.parse('2026-08-17T02:00:00.000Z');
  const repository = createRuntimeV3Repository({ filePath, now: () => new Date(nowMs) });
  t.after(async () => {
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  repository.createExecution({ executionId: 'execution-transition', context: executionContext() });
  const lease = repository.acquireLease({
    leaseKey: 'execution:execution-transition', ownerId: 'worker-1', ttlMs: 1_000,
  });
  const started = repository.transitionExecution('execution-transition', {
    expectedStatuses: ['queued'],
    lease,
    patch: { status: 'running', metadata: { workerId: 'worker-1' } },
    event: { type: 'execution.started', payload: { phase: 'running' }, expectedSequence: 0 },
  });
  assert.equal(started.execution.status, 'running');
  assert.equal(started.event.sequence, 1);
  assert.equal(repository.latestSequence('execution:execution-transition'), 1);

  assert.throws(
    () => repository.transitionExecution('execution-transition', {
      expectedStatuses: ['running'],
      lease,
      patch: { status: 'succeeded', result: { ok: true } },
      event: { type: 'execution.completed', payload: { ok: true }, expectedSequence: 0 },
    }),
    (error) => error.code === 'RUNTIME_V3_EVENT_SEQUENCE_CONFLICT' && error.status === 409,
  );
  assert.equal(repository.getExecution('execution-transition').status, 'running');
  assert.equal(repository.latestSequence('execution:execution-transition'), 1);

  nowMs += 1_001;
  assert.throws(
    () => repository.transitionExecution('execution-transition', {
      expectedStatuses: ['running'],
      lease,
      patch: { status: 'failed' },
      event: { type: 'execution.failed', payload: {}, expectedSequence: 1 },
    }),
    (error) => error.code === 'RUNTIME_V3_EXECUTION_LEASE_STALE' && error.status === 409,
  );
  assert.equal(repository.getExecution('execution-transition').status, 'running');
});

test('RuntimeV3Repository lease fencing rejects stale owners across expiry and release', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-runtime-v3-lease-'));
  const filePath = path.join(rootDir, 'copilot-state.sqlite');
  let nowMs = Date.parse('2026-08-16T02:00:00.000Z');
  const now = () => new Date(nowMs);
  const firstRepository = createRuntimeV3Repository({ filePath, now });
  const secondRepository = createRuntimeV3Repository({ filePath, now });
  t.after(async () => {
    secondRepository.close();
    firstRepository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const ownerA = firstRepository.acquireLease({ leaseKey: 'run:run-1', ownerId: 'worker-a', ttlMs: 1_000 });
  assert.equal(ownerA.acquired, true);
  assert.equal(ownerA.fencingToken, 1);
  const contended = secondRepository.acquireLease({ leaseKey: 'run:run-1', ownerId: 'worker-b', ttlMs: 1_000 });
  assert.equal(contended.acquired, false);
  assert.equal(contended.state, 'contended');
  assert.equal(contended.fencingToken, 1);

  const renewed = firstRepository.renewLease({
    leaseKey: 'run:run-1', ownerId: 'worker-a', fencingToken: 1, ttlMs: 2_000,
  });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.fencingToken, 1);

  nowMs += 2_001;
  const ownerB = secondRepository.acquireLease({ leaseKey: 'run:run-1', ownerId: 'worker-b', ttlMs: 1_000 });
  assert.equal(ownerB.acquired, true);
  assert.equal(ownerB.fencingToken, 2);
  assert.equal(firstRepository.renewLease({
    leaseKey: 'run:run-1', ownerId: 'worker-a', fencingToken: 1, ttlMs: 1_000,
  }).state, 'stale');
  assert.equal(firstRepository.releaseLease({
    leaseKey: 'run:run-1', ownerId: 'worker-a', fencingToken: 1,
  }).released, false);

  const released = secondRepository.releaseLease({
    leaseKey: 'run:run-1', ownerId: 'worker-b', fencingToken: 2,
  });
  assert.equal(released.released, true);
  assert.equal(released.lease.active, false);
  const ownerANext = firstRepository.acquireLease({ leaseKey: 'run:run-1', ownerId: 'worker-a', ttlMs: 1_000 });
  assert.equal(ownerANext.fencingToken, 3);
});

test('RuntimeV3Repository can share an existing production-style SQLite handle without owning it', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-runtime-v3-injected-'));
  const productionStore = createCopilotProductionStore({ rootDir });
  const repository = createRuntimeV3Repository({ store: productionStore });
  t.after(async () => {
    productionStore.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.equal(repository.describe().ownsDatabase, false);
  assert.equal(repository.describe().filePath, productionStore.filePath);
  repository.close();
  assert.equal(productionStore.database.prepare('SELECT 1 AS ok').get().ok, 1);
  assert.equal(productionStore.describe().schemaVersion, 4);
});
