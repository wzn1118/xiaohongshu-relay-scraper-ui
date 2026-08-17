import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createExecutionDispatcher,
  createExecutionHandlerRegistry,
  createExecutionWorkerSupervisor,
  createRuntimeV3Repository,
} from './copilot/runtime-v3/index.mjs';

async function fixture(t, prefix = 'execution-worker-') {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(rootDir, 'runtime-v3.sqlite');
  let nowMs = Date.parse('2026-08-17T00:00:00.000Z');
  const now = () => new Date(nowMs);
  const repository = createRuntimeV3Repository({ filePath, now });
  const deferredCleanup = [];

  t.after(async () => {
    for (const cleanup of [...deferredCleanup].reverse()) {
      await cleanup();
    }
    await repository.close();
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
  });

  return {
    filePath,
    now,
    repository,
    deferCleanup(cleanup) {
      deferredCleanup.push(cleanup);
    },
    advance(ms) {
      nowMs += ms;
    },
  };
}

function executionContext(id) {
  return {
    taskId: `task-${id}`,
    runId: `run-${id}`,
    attemptId: `attempt-${id}`,
    traceId: `trace-${id}`,
    idempotencyKey: `key-${id}`,
    deadlineAt: '2026-08-17T01:00:00.000Z',
    environment: { workspaceId: `workspace-${id}` },
    authority: { profile: 'owner_local_full' },
    modelPolicy: { model: 'test-model' },
    contextSnapshotId: `snapshot-${id}`,
  };
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() <= deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

function createDispatcher(repository, workerId, options = {}) {
  return createExecutionDispatcher({
    repository,
    workerId,
    leaseTtlMs: 1_000,
    heartbeatMs: 20,
    ...options,
  });
}

test('handler registry records versioned durable and inline contracts', async (t) => {
  const { repository, deferCleanup } = await fixture(t);
  const dispatcher = createDispatcher(repository, 'registry-worker');
  const registry = createExecutionHandlerRegistry({ dispatcher });

  deferCleanup(async () => {
    await registry.close();
    await dispatcher.close();
  });

  registry.register('job.echo', async () => ({ ok: true }), {
    version: '3',
    executionKinds: ['job'],
    effectClass: 'read',
  });
  registry.register('tool.call', async () => ({ ok: true }), {
    version: '1',
    dispatchMode: 'inline',
    executionKinds: ['tool'],
    effectClass: 'non_idempotent',
    maxRetries: 0,
  });

  const durable = registry.get('job.echo');
  const inline = registry.get('tool.call');
  assert.equal(durable.dispatchMode, 'durable');
  assert.equal(inline.dispatchMode, 'inline');
  assert.equal(registry.canDispatch({
    kind: 'job',
    metadata: { dispatcher: { handlerKey: 'job.echo', handlerVersion: '3' } },
  }), true);
  assert.equal(registry.canDispatch({
    kind: 'tool',
    metadata: { dispatcher: { handlerKey: 'tool.call', handlerVersion: '1' } },
  }), false);
  assert.equal(registry.canDispatch({
    kind: 'job',
    metadata: { dispatcher: { handlerKey: 'job.echo', handlerVersion: '2' } },
  }), false);

  const metadata = registry.metadataFor('job.echo', { requestId: 'request-1' });
  assert.deepEqual(metadata, {
    requestId: 'request-1',
    dispatcher: {
      handlerKey: 'job.echo',
      handlerVersion: '3',
      dispatchMode: 'durable',
    },
  });

  assert.throws(
    () => registry.register('job.echo', async () => null),
    (error) => error?.code === 'EXECUTION_HANDLER_CONFLICT',
  );
});

test('worker dispatches durable work and leaves inline work for its request owner', async (t) => {
  const { repository, deferCleanup } = await fixture(t);
  const dispatcher = createDispatcher(repository, 'worker-a');
  const registry = createExecutionHandlerRegistry({ dispatcher });
  const calls = [];
  registry.register('job.echo', async ({ execution }) => {
    calls.push(execution.executionId);
    return { echoed: execution.executionId };
  }, {
    executionKinds: ['job'],
    effectClass: 'read',
  });
  registry.register('tool.call', async () => ({ unreachable: true }), {
    dispatchMode: 'inline',
    executionKinds: ['tool'],
    effectClass: 'non_idempotent',
    maxRetries: 0,
  });
  const worker = createExecutionWorkerSupervisor({
    dispatcher,
    handlerRegistry: registry,
    workerId: 'worker-a',
    pollIntervalMs: 10,
    recoveryIntervalMs: 60_000,
  });

  deferCleanup(async () => {
    await worker.close();
    await registry.close();
    await dispatcher.close();
  });

  await dispatcher.enqueue({
    executionId: 'durable-job',
    kind: 'job',
    context: executionContext('durable-job'),
    metadata: registry.metadataFor('job.echo', { input: 'hello' }),
    handlerKey: 'job.echo',
    effectClass: 'read',
  });
  await dispatcher.enqueue({
    executionId: 'inline-tool',
    kind: 'tool',
    context: executionContext('inline-tool'),
    metadata: registry.metadataFor('tool.call', { toolName: 'workspace.write' }),
    handlerKey: 'tool.call',
    effectClass: 'non_idempotent',
  });

  worker.start();
  await waitFor(async () => (await repository.getExecution('durable-job'))?.status === 'succeeded');

  assert.deepEqual(calls, ['durable-job']);
  assert.equal((await repository.getExecution('inline-tool'))?.status, 'queued');
  const description = worker.describe();
  assert.equal(description.inlineBacklog, 1);
  assert.equal(description.durableBacklog, 0);
});

test('two supervisors share a repository without double executing durable work', async (t) => {
  const { filePath, now, repository, deferCleanup } = await fixture(t, 'execution-workers-shared-');
  const repositoryB = createRuntimeV3Repository({ filePath, now });
  const dispatcherA = createDispatcher(repository, 'worker-a');
  const dispatcherB = createDispatcher(repositoryB, 'worker-b');
  const registryA = createExecutionHandlerRegistry({ dispatcher: dispatcherA });
  const registryB = createExecutionHandlerRegistry({ dispatcher: dispatcherB });
  const calls = new Map();
  const handler = async ({ execution }) => {
    calls.set(execution.executionId, (calls.get(execution.executionId) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { executionId: execution.executionId };
  };
  registryA.register('job.once', handler, { executionKinds: ['job'], effectClass: 'read' });
  registryB.register('job.once', handler, { executionKinds: ['job'], effectClass: 'read' });
  const workerA = createExecutionWorkerSupervisor({
    dispatcher: dispatcherA,
    handlerRegistry: registryA,
    workerId: 'worker-a',
    pollIntervalMs: 5,
    recoveryIntervalMs: 60_000,
    maxConcurrency: 2,
  });
  const workerB = createExecutionWorkerSupervisor({
    dispatcher: dispatcherB,
    handlerRegistry: registryB,
    workerId: 'worker-b',
    pollIntervalMs: 5,
    recoveryIntervalMs: 60_000,
    maxConcurrency: 2,
  });

  deferCleanup(async () => {
    await workerA.close();
    await workerB.close();
    await registryA.close();
    await registryB.close();
    await dispatcherA.close();
    await dispatcherB.close();
    await repositoryB.close();
  });

  const ids = Array.from({ length: 8 }, (_, index) => `job-${index + 1}`);
  for (const executionId of ids) {
    await dispatcherA.enqueue({
      executionId,
      kind: 'job',
      context: executionContext(executionId),
      metadata: registryA.metadataFor('job.once', { sequence: executionId }),
      handlerKey: 'job.once',
      effectClass: 'read',
    });
  }

  workerA.start();
  workerB.start();
  await waitFor(async () => {
    const executions = await Promise.all(ids.map((id) => repository.getExecution(id)));
    return executions.every((execution) => execution?.status === 'succeeded');
  }, { timeoutMs: 4_000 });

  assert.equal(calls.size, ids.length);
  for (const executionId of ids) {
    assert.equal(calls.get(executionId), 1, `${executionId} executed exactly once`);
  }
});

test('successor worker recovers an expired idempotent execution and completes it', async (t) => {
  const { filePath, now, repository, advance, deferCleanup } = await fixture(t, 'execution-worker-recovery-');
  const repositoryB = createRuntimeV3Repository({ filePath, now });
  const dispatcherA = createDispatcher(repository, 'worker-a');
  const dispatcherB = createDispatcher(repositoryB, 'worker-b');
  const registryA = createExecutionHandlerRegistry({ dispatcher: dispatcherA });
  const registryB = createExecutionHandlerRegistry({ dispatcher: dispatcherB });
  let recovered = 0;
  registryA.register('job.recover', async () => ({ owner: 'worker-a' }), {
    executionKinds: ['job'],
    effectClass: 'read',
  });
  registryB.register('job.recover', async () => {
    recovered += 1;
    return { owner: 'worker-b' };
  }, {
    executionKinds: ['job'],
    effectClass: 'read',
  });
  const workerB = createExecutionWorkerSupervisor({
    dispatcher: dispatcherB,
    handlerRegistry: registryB,
    workerId: 'worker-b',
    pollIntervalMs: 10,
    recoveryIntervalMs: 60_000,
  });

  deferCleanup(async () => {
    await workerB.close();
    await registryA.close();
    await registryB.close();
    await dispatcherA.close();
    await dispatcherB.close();
    await repositoryB.close();
  });

  await dispatcherA.enqueue({
    executionId: 'recoverable-job',
    kind: 'job',
    context: executionContext('recoverable-job'),
    metadata: registryA.metadataFor('job.recover', { revision: 1 }),
    handlerKey: 'job.recover',
    effectClass: 'read',
  });
  const claim = await dispatcherA.claim('recoverable-job');
  assert.ok(claim);

  advance(1_001);
  workerB.start();
  await workerB.runOnce({ recover: true });
  await waitFor(async () => (await repositoryB.getExecution('recoverable-job'))?.status === 'succeeded');

  assert.equal(recovered, 1);
  assert.deepEqual((await repositoryB.getExecution('recoverable-job'))?.result, { owner: 'worker-b' });
});

test('worker close aborts an active durable handler before releasing its dispatcher', async (t) => {
  const { repository, deferCleanup } = await fixture(t);
  const dispatcher = createDispatcher(repository, 'worker-a');
  const registry = createExecutionHandlerRegistry({ dispatcher });
  let releaseStarted;
  const started = new Promise((resolve) => {
    releaseStarted = resolve;
  });
  let aborted = false;
  registry.register('job.block', async ({ signal }) => {
    releaseStarted();
    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    });
    aborted = true;
    throw signal.reason || new Error('cancelled');
  }, {
    executionKinds: ['job'],
    effectClass: 'read',
  });
  const worker = createExecutionWorkerSupervisor({
    dispatcher,
    handlerRegistry: registry,
    workerId: 'worker-a',
    pollIntervalMs: 10,
    recoveryIntervalMs: 60_000,
  });

  deferCleanup(async () => {
    await worker.close();
    await registry.close();
    await dispatcher.close();
  });

  await dispatcher.enqueue({
    executionId: 'blocking-job',
    kind: 'job',
    context: executionContext('blocking-job'),
    metadata: registry.metadataFor('job.block', { operation: 'wait' }),
    handlerKey: 'job.block',
    effectClass: 'read',
  });
  worker.start();
  await worker.runOnce({ recover: false });
  await started;
  await worker.close({ timeoutMs: 1_000 });

  assert.equal(aborted, true);
  assert.equal(worker.describe().state, 'closed');
  assert.equal((await repository.getExecution('blocking-job'))?.status, 'cancelled');
});
