import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createExecutionDispatcher,
  executionLeaseKey,
} from './copilot/execution-dispatcher.mjs';
import { createRuntimeV3Repository } from './copilot/runtime-v3/index.mjs';

function executionContext(overrides = {}) {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    deadlineAt: '2026-08-16T10:00:00.000Z',
    idempotencyKey: 'task-1:attempt-1',
    environment: { workspaceId: 'workspace-1' },
    authority: { profile: 'owner_local_full' },
    modelPolicy: { model: 'gpt-test' },
    contextSnapshotId: 'context-1',
    ...overrides,
  };
}

async function fixture(t, prefix = 'copilot-execution-dispatcher-', { registerCleanup = true } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(rootDir, 'copilot-state.sqlite');
  let nowMs = Date.parse('2026-08-16T02:00:00.000Z');
  const now = () => new Date(nowMs);
  const repository = createRuntimeV3Repository({ filePath, now });
  const cleanup = async () => {
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  };
  if (registerCleanup) t.after(cleanup);
  return {
    filePath,
    now,
    repository,
    cleanup,
    advance(ms) { nowMs += ms; },
  };
}

test('dispatcher persists queue, claim, execution, completion, event ordering, and lease release', async (t) => {
  const { repository, now } = await fixture(t);
  const dispatcher = createExecutionDispatcher({ repository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(() => dispatcher.close());

  dispatcher.registerHandler('profile', async ({ context, heartbeat, emit }) => {
    const beat = heartbeat();
    assert.equal(beat.renewed, true);
    emit({ phase: 'reading' });
    return { taskId: context.taskId, rows: 3 };
  }, { effectClass: 'read' });
  const queued = dispatcher.enqueue({
    executionId: 'execution-1',
    kind: 'profile',
    context: executionContext(),
    metadata: { requestedBy: 'test' },
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.metadata.effectClass, 'read');

  const claim = dispatcher.claimNext();
  assert.equal(claim.executionId, 'execution-1');
  assert.equal(claim.status, 'running');
  assert.equal(claim.workerId, 'worker-a');
  assert.equal(claim.lease.active, true);

  const completed = await dispatcher.execute(claim);
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, { rows: 3, taskId: 'task-1' });
  assert.equal(repository.getLease(executionLeaseKey('execution-1')).active, false);
  assert.deepEqual(
    repository.listEvents({ streamId: 'run:run-1' }).map((event) => event.type),
    ['execution.queued', 'execution.claimed', 'execution.started', 'execution.heartbeat', 'execution.progress', 'execution.completed'],
  );
});

test('only one dispatcher can claim the same queued execution', async (t) => {
  const { filePath, now, repository, cleanup } = await fixture(t, 'copilot-execution-dispatcher-race-', { registerCleanup: false });
  const firstRepository = createRuntimeV3Repository({ filePath, now });
  const secondRepository = createRuntimeV3Repository({ filePath, now });
  const first = createExecutionDispatcher({ repository: firstRepository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  const second = createExecutionDispatcher({ repository: secondRepository, workerId: 'worker-b', now, leaseTtlMs: 1_000 });
  t.after(async () => {
    first.close();
    second.close();
    firstRepository.close();
    secondRepository.close();
    await cleanup();
  });

  first.registerHandler('build', async () => ({ ok: true }), { effectClass: 'idempotent_write' });
  first.enqueue({ executionId: 'execution-race', kind: 'build', context: executionContext() });
  const firstClaim = first.claimNext();
  assert.equal(firstClaim.executionId, 'execution-race');
  assert.equal(second.claimNext(), null);
  const completed = first.complete(firstClaim, { ok: true });
  assert.equal(completed.status, 'succeeded');
  assert.equal(second.claimNext(), null);
});

test('dispatcher claim terminalizes a cancellation written in the claim transaction window', async (t) => {
  const { filePath, now, cleanup } = await fixture(t, 'copilot-execution-dispatcher-claim-cancel-window-', { registerCleanup: false });
  const ownerRepository = createRuntimeV3Repository({ filePath, now });
  const cancellerRepository = createRuntimeV3Repository({ filePath, now });
  const owner = createExecutionDispatcher({ repository: ownerRepository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(async () => {
    owner.close();
    ownerRepository.close();
    cancellerRepository.close();
    await cleanup();
  });

  owner.enqueue({
    executionId: 'execution-claim-cancel-window',
    kind: 'build',
    context: executionContext({ taskId: 'task-claim-cancel-window', idempotencyKey: 'claim-cancel-window-key' }),
    effectClass: 'idempotent_write',
  });
  const updateExecutionWithLease = ownerRepository.updateExecutionWithLease.bind(ownerRepository);
  let injectedCancellation = false;
  ownerRepository.updateExecutionWithLease = (executionId, patch, options) => {
    if (!injectedCancellation && executionId === 'execution-claim-cancel-window' && typeof patch === 'function') {
      injectedCancellation = true;
      const current = cancellerRepository.getExecution(executionId);
      const marked = cancellerRepository.updateExecutionIfStatus(executionId, {
        metadata: {
          ...(current.metadata || {}),
          dispatcher: {
            ...(current.metadata?.dispatcher || {}),
            cancelRequestedAt: '2026-08-16T02:00:00.000Z',
            cancelReason: 'cancelled during claim',
          },
        },
      }, { expectedStatuses: ['queued'] });
      assert.ok(marked);
    }
    return updateExecutionWithLease(executionId, patch, options);
  };
  try {
    assert.equal(owner.claim('execution-claim-cancel-window'), null);
  } finally {
    ownerRepository.updateExecutionWithLease = updateExecutionWithLease;
  }

  assert.equal(injectedCancellation, true);
  const cancelled = cancellerRepository.getExecution('execution-claim-cancel-window');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.metadata.dispatcher.cancelReason, 'cancelled during claim');
  assert.equal(cancellerRepository.getLease(executionLeaseKey('execution-claim-cancel-window'))?.active ?? false, false);
});

test('a stale worker cannot publish completion after its lease is transferred during the mutation', async (t) => {
  const { filePath, now, advance, cleanup } = await fixture(t, 'copilot-execution-dispatcher-fence-window-', { registerCleanup: false });
  const ownerRepository = createRuntimeV3Repository({ filePath, now });
  const successorRepository = createRuntimeV3Repository({ filePath, now });
  const owner = createExecutionDispatcher({ repository: ownerRepository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(async () => {
    owner.close();
    ownerRepository.close();
    successorRepository.close();
    await cleanup();
  });

  owner.enqueue({
    executionId: 'execution-fence-window',
    kind: 'build',
    context: executionContext({ taskId: 'task-fence-window', idempotencyKey: 'fence-window-key' }),
    effectClass: 'idempotent_write',
  });
  const claim = owner.claim('execution-fence-window');
  const leaseKey = executionLeaseKey('execution-fence-window');
  const updateWithLease = ownerRepository.updateExecutionWithLease.bind(ownerRepository);
  let transferred = false;
  ownerRepository.updateExecutionWithLease = (...args) => {
    if (!transferred) {
      transferred = true;
      advance(1_001);
      const successorLease = successorRepository.acquireLease({
        leaseKey,
        ownerId: 'worker-b',
        ttlMs: 1_000,
      });
      assert.equal(successorLease.acquired, true);
      assert.equal(successorLease.fencingToken, claim.fencingToken + 1);
    }
    return updateWithLease(...args);
  };
  try {
    assert.throws(
      () => owner.complete(claim, { stale: true }),
      (error) => error.code === 'RUNTIME_V3_EXECUTION_LEASE_STALE',
    );
  } finally {
    ownerRepository.updateExecutionWithLease = updateWithLease;
  }

  const record = successorRepository.getExecution('execution-fence-window');
  assert.equal(record.status, 'running');
  assert.equal(record.result, null);
  assert.equal(successorRepository.getLease(leaseKey).ownerId, 'worker-b');
});

test('a stale claim cannot complete a successor after the same worker id restarts', async (t) => {
  const { filePath, now, advance, cleanup } = await fixture(t, 'copilot-execution-dispatcher-same-worker-fence-', { registerCleanup: false });
  const firstRepository = createRuntimeV3Repository({ filePath, now });
  const secondRepository = createRuntimeV3Repository({ filePath, now });
  const first = createExecutionDispatcher({ repository: firstRepository, workerId: 'restarted-worker', now, leaseTtlMs: 1_000 });
  const successor = createExecutionDispatcher({ repository: secondRepository, workerId: 'restarted-worker', now, leaseTtlMs: 1_000 });
  t.after(async () => {
    first.close();
    successor.close();
    firstRepository.close();
    secondRepository.close();
    await cleanup();
  });

  first.enqueue({
    executionId: 'execution-same-worker-fence',
    kind: 'build',
    context: executionContext({ taskId: 'task-same-worker-fence', idempotencyKey: 'same-worker-fence-key' }),
    effectClass: 'idempotent_write',
  });
  const staleClaim = first.claim('execution-same-worker-fence');
  assert.ok(staleClaim);

  advance(1_001);
  const recovered = await successor.recoverExpired();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'queued');
  const successorClaim = successor.claim('execution-same-worker-fence');
  assert.ok(successorClaim);
  assert.ok(successorClaim.fencingToken > staleClaim.fencingToken);

  assert.throws(
    () => first.complete(staleClaim, { stale: true }),
    (error) => error.code === 'RUNTIME_V3_EXECUTION_LEASE_STALE',
  );
  const running = secondRepository.getExecution('execution-same-worker-fence');
  assert.equal(running.status, 'running');
  assert.equal(running.result, null);

  const completed = successor.complete(successorClaim, { fresh: true });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, { fresh: true });
});

test('handler failure persists a durable receipt and releases its lease', async (t) => {
  const { repository, now } = await fixture(t, 'copilot-execution-dispatcher-fail-');
  const dispatcher = createExecutionDispatcher({ repository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(() => dispatcher.close());

  dispatcher.registerHandler('compile', async () => {
    throw Object.assign(new Error('compile failed'), { code: 'COMPILE_FAILED', status: 422 });
  }, { effectClass: 'idempotent_write' });
  dispatcher.enqueue({ executionId: 'execution-fail', kind: 'compile', context: executionContext() });
  const result = await dispatcher.execute(dispatcher.claimNext());
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'COMPILE_FAILED');
  assert.equal(result.error.reason, 'handler_failed');
  assert.equal(repository.getLease(executionLeaseKey('execution-fail')).active, false);
  assert.deepEqual(
    repository.listEvents({ streamId: 'run:run-1' }).map((event) => event.type),
    ['execution.queued', 'execution.claimed', 'execution.started', 'execution.failed'],
  );
});

test('dispatcher cancellation publishes one terminal receipt and releases its fencing lease', async (t) => {
  const { repository, now } = await fixture(t, 'copilot-execution-dispatcher-cancel-');
  const dispatcher = createExecutionDispatcher({ repository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(() => dispatcher.close());

  dispatcher.enqueue({
    executionId: 'execution-cancel',
    kind: 'compile',
    context: executionContext({ taskId: 'task-cancel', idempotencyKey: 'cancel-key' }),
    effectClass: 'non_idempotent',
  });
  const claim = dispatcher.claim('execution-cancel');
  const cancelled = dispatcher.cancel(claim, { reason: 'operator requested cancellation' });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'RUNTIME_V3_EXECUTION_CANCELLED');
  assert.equal(repository.getLease(executionLeaseKey('execution-cancel')).active, false);
  assert.equal(dispatcher.claimNext(), null);
  assert.deepEqual(
    repository.listEvents({ streamId: 'run:run-1' }).map((event) => event.type),
    ['execution.queued', 'execution.claimed', 'execution.cancelled'],
  );
});

test('dispatcher reconciliation lets a durable cancellation request win over a late reconcile failure', async (t) => {
  const { repository, now } = await fixture(t, 'copilot-execution-dispatcher-reconcile-cancel-');
  const dispatcher = createExecutionDispatcher({ repository, workerId: 'worker-a', now, leaseTtlMs: 1_000 });
  t.after(() => dispatcher.close());

  dispatcher.enqueue({
    executionId: 'execution-reconcile-cancel',
    kind: 'compile',
    context: executionContext({ taskId: 'task-reconcile-cancel', idempotencyKey: 'reconcile-cancel-key' }),
    effectClass: 'non_idempotent',
  });
  const claim = dispatcher.claim('execution-reconcile-cancel');
  assert.ok(claim);
  const current = repository.getExecution('execution-reconcile-cancel');
  repository.updateExecution('execution-reconcile-cancel', {
    metadata: {
      ...current.metadata,
      dispatcher: {
        ...current.metadata.dispatcher,
        cancelRequestedAt: '2026-08-16T00:00:00.000Z',
        cancelReason: 'operator cancelled during reconciliation',
      },
    },
  });

  const reconciled = dispatcher.reconcile(claim, {
    reason: 'reconcile_adapter_failed',
    error: Object.assign(new Error('late reconcile failure'), { code: 'RECONCILE_FAILED', status: 500 }),
  });
  assert.equal(reconciled.status, 'cancelled');
  assert.equal(reconciled.error.code, 'RUNTIME_V3_EXECUTION_CANCELLED');
  assert.equal(repository.getLease(executionLeaseKey('execution-reconcile-cancel')).active, false);
  assert.equal(repository.listEvents({ streamId: 'run:run-1' }).at(-1)?.type, 'execution.cancelled');
});

test('expired idempotent execution requeues while a non-idempotent orphan requires reconciliation', async (t) => {
  const { filePath, now, advance, repository, cleanup } = await fixture(t, 'copilot-execution-dispatcher-recovery-', { registerCleanup: false });
  const ownerRepository = createRuntimeV3Repository({ filePath, now });
  const recoveryRepository = createRuntimeV3Repository({ filePath, now });
  const owner = createExecutionDispatcher({ repository: ownerRepository, workerId: 'owner', now, leaseTtlMs: 1_000 });
  let executions = 0;
  const recovery = createExecutionDispatcher({ repository: recoveryRepository, workerId: 'recovery', now, leaseTtlMs: 1_000 });
  recovery.registerHandler('safe', async () => { executions += 1; return { recovered: true }; }, { effectClass: 'idempotent_write' });
  recovery.registerHandler('unsafe', async () => { executions += 100; return { shouldNotRun: true }; }, { effectClass: 'non_idempotent' });
  t.after(async () => {
    owner.close();
    recovery.close();
    ownerRepository.close();
    recoveryRepository.close();
    await cleanup();
  });

  owner.enqueue({
    executionId: 'execution-safe',
    kind: 'safe',
    context: executionContext({ taskId: 'task-safe', idempotencyKey: 'safe-key' }),
    effectClass: 'idempotent_write',
  });
  owner.enqueue({
    executionId: 'execution-unsafe',
    kind: 'unsafe',
    context: executionContext({ taskId: 'task-unsafe', idempotencyKey: 'unsafe-key' }),
    effectClass: 'non_idempotent',
  });
  assert.equal(owner.claim('execution-safe').status, 'running');
  assert.equal(owner.claim('execution-unsafe').status, 'running');
  advance(1_001);

  const recovered = await recovery.recoverExpired();
  assert.deepEqual(recovered.map((execution) => [execution.executionId, execution.status]), [
    ['execution-safe', 'queued'],
    ['execution-unsafe', 'reconcile_required'],
  ]);
  assert.equal(recovery.claimNext()?.executionId, 'execution-safe');
  const replayed = await recovery.execute('execution-safe');
  assert.equal(replayed.status, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(recovery.claimNext(), null);
  assert.equal(recovery.get('execution-unsafe').status, 'reconcile_required');
  await assert.rejects(
    recovery.execute('execution-unsafe'),
    (error) => error.code === 'RUNTIME_V3_EXECUTION_RECONCILE_REQUIRED',
  );
  assert.equal(executions, 1);
  const reconciled = await recovery.execute('execution-unsafe', { includeReconcileRequired: true });
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(executions, 101);
});

test('expired recovery terminalizes a cancellation written while retry policy resolves', async (t) => {
  const { filePath, now, advance, cleanup } = await fixture(t, 'copilot-execution-dispatcher-recovery-cancel-window-', { registerCleanup: false });
  const ownerRepository = createRuntimeV3Repository({ filePath, now });
  const recoveryRepository = createRuntimeV3Repository({ filePath, now });
  const owner = createExecutionDispatcher({ repository: ownerRepository, workerId: 'owner', now, leaseTtlMs: 1_000 });
  const recovery = createExecutionDispatcher({ repository: recoveryRepository, workerId: 'recovery', now, leaseTtlMs: 1_000 });
  recovery.registerHandler('safe', async () => ({ replayed: true }), { effectClass: 'idempotent_write' });
  t.after(async () => {
    owner.close();
    recovery.close();
    ownerRepository.close();
    recoveryRepository.close();
    await cleanup();
  });

  owner.enqueue({
    executionId: 'execution-recovery-cancel-window',
    kind: 'safe',
    context: executionContext({ taskId: 'task-recovery-cancel-window', idempotencyKey: 'recovery-cancel-window-key' }),
    effectClass: 'idempotent_write',
  });
  assert.ok(owner.claim('execution-recovery-cancel-window'));
  advance(1_001);

  const updateExecutionWithLease = recoveryRepository.updateExecutionWithLease.bind(recoveryRepository);
  let injectedCancellation = false;
  recoveryRepository.updateExecutionWithLease = (executionId, patch, options) => {
    if (!injectedCancellation && executionId === 'execution-recovery-cancel-window' && typeof patch === 'function') {
      injectedCancellation = true;
      const current = ownerRepository.getExecution(executionId);
      const marked = ownerRepository.updateExecutionIfStatus(executionId, {
        metadata: {
          ...(current.metadata || {}),
          dispatcher: {
            ...(current.metadata?.dispatcher || {}),
            cancelRequestedAt: '2026-08-16T02:00:01.001Z',
            cancelReason: 'cancelled while recovery evaluated retry policy',
          },
        },
      }, { expectedStatuses: ['running'] });
      assert.ok(marked);
    }
    return updateExecutionWithLease(executionId, patch, options);
  };
  let recovered;
  try {
    recovered = await recovery.recoverExpired();
  } finally {
    recoveryRepository.updateExecutionWithLease = updateExecutionWithLease;
  }

  assert.equal(injectedCancellation, true);
  assert.deepEqual(recovered.map((execution) => [execution.executionId, execution.status]), [
    ['execution-recovery-cancel-window', 'cancelled'],
  ]);
  const cancelled = recoveryRepository.getExecution('execution-recovery-cancel-window');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.metadata.dispatcher.cancelReason, 'cancelled while recovery evaluated retry policy');
  assert.equal(recovery.claimNext(), null);
});

test('recovery policy can conservatively override idempotent metadata', async (t) => {
  const { repository, now, advance } = await fixture(t, 'copilot-execution-dispatcher-policy-');
  const owner = createExecutionDispatcher({ repository, workerId: 'owner', now, leaseTtlMs: 1_000 });
  const recovery = createExecutionDispatcher({
    repository,
    workerId: 'recovery',
    now,
    leaseTtlMs: 1_000,
    idempotencyPolicy: () => false,
    retryPolicy: () => true,
  });
  t.after(() => { owner.close(); recovery.close(); });

  owner.enqueue({
    executionId: 'execution-policy',
    kind: 'safe',
    context: executionContext({ taskId: 'task-policy', idempotencyKey: 'policy-key' }),
    effectClass: 'idempotent_write',
  });
  owner.claim('execution-policy');
  advance(1_001);
  const [recovered] = await recovery.recoverExpired();
  assert.equal(recovered.status, 'reconcile_required');
  assert.equal(recovered.error.code, 'RUNTIME_V3_EXECUTION_RECONCILE_REQUIRED');
});
