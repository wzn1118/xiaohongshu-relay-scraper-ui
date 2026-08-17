import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { createExecutionDispatcher, executionLeaseKey } from './execution-dispatcher.mjs';
import { createRuntimeV3Repository } from './runtime-v3/index.mjs';
import { createToolExecutionBroker, ToolExecutionBrokerError, toolContext } from './tool-execution-broker.mjs';

function executionContext(overrides = {}) {
  return {
    taskId: 'root-task',
    runId: 'run-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    deadlineAt: '2026-08-16T10:00:00.000Z',
    idempotencyKey: 'root-request-1',
    environment: { workspaceId: 'workspace-1' },
    authority: { profile: 'owner_local_full' },
    modelPolicy: { provider: 'test' },
    contextSnapshotId: 'snapshot-1',
    ...overrides,
  };
}

async function withBroker(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-tool-broker-'));
  const repository = createRuntimeV3Repository({ rootDir: root });
  try {
    return await run({ root, repository });
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
}

// Shared-worker cases exercise ownership, cancellation, and duplicate work.
// They are not expiry/recovery tests, so use the production-sized lease by
// default. Individual recovery tests opt into a short TTL explicitly.
async function withSharedDispatchers(run, { leaseTtlMs = 30_000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-tool-broker-shared-'));
  const firstRepository = createRuntimeV3Repository({ rootDir: root });
  const secondRepository = createRuntimeV3Repository({ rootDir: root });
  const firstDispatcher = createExecutionDispatcher({
    repository: firstRepository,
    workerId: 'tool-broker-worker-a',
    leaseTtlMs,
  });
  const secondDispatcher = createExecutionDispatcher({
    repository: secondRepository,
    workerId: 'tool-broker-worker-b',
    leaseTtlMs,
  });
  try {
    return await run({ root, firstRepository, secondRepository, firstDispatcher, secondDispatcher });
  } finally {
    firstDispatcher.close();
    secondDispatcher.close();
    firstRepository.close();
    secondRepository.close();
    await rm(root, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('ToolExecutionBroker persists one idempotent receipt and ordered lifecycle events', async () => {
  await withBroker(async ({ repository }) => {
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute(name, input, context) {
        calls += 1;
        context.emit?.({ type: 'workspace.read.progress', path: input.path });
        return { type: 'workspace.file', path: input.path, content: 'hello' };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    const request = {
      toolName: 'workspace.read',
      input: { path: 'README.md' },
      toolExecutionId: 'tool-read-1',
      idempotencyKey: 'tool-key-1',
      executionContext: executionContext(),
    };
    const result = await broker.execute(request);
    assert.equal(result.content, 'hello');
    assert.equal(calls, 1);
    assert.equal(broker.get('tool-read-1').status, 'succeeded');
    assert.equal(broker.get('tool-read-1').effectClass, 'read');

    const duplicate = await broker.execute(request);
    assert.deepEqual(duplicate, result);
    assert.equal(calls, 1);
    const events = repository.listEvents({ streamId: 'execution:run-1:tool:tool-read-1' });
    assert.deepEqual(events.map((event) => event.type), [
      'tool.execution.started',
      'tool.execution.progress',
      'tool.execution.completed',
    ]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  });
});

test('ToolExecutionBroker rejects an idempotency key rebound to different input', async () => {
  await withBroker(async ({ repository }) => {
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'workspace.write'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: true }
          : null;
      },
      async execute(_name, input) {
        calls += 1;
        return { path: input.path, changed: true };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    const request = {
      toolName: 'workspace.write',
      input: { path: 'first.txt', content: 'first' },
      toolExecutionId: 'tool-write-idempotent',
      idempotencyKey: 'tool-write-key-1',
      executionContext: executionContext(),
    };
    await broker.execute(request);
    await assert.rejects(
      broker.execute({ ...request, input: { path: 'first.txt', content: 'second' } }),
      (error) => error instanceof ToolExecutionBrokerError
        && error.code === 'TOOL_EXECUTION_IDEMPOTENCY_CONFLICT'
        && error.status === 409,
    );
    assert.equal(calls, 1);
  });
});

test('ToolExecutionBroker distinguishes secret-valued inputs sharing an idempotency key', async () => {
  await withBroker(async ({ repository }) => {
    const registry = {
      get(name) {
        return name === 'workspace.write'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: true }
          : null;
      },
      async execute(_name, input) {
        return { path: input.path, changed: true };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    const request = {
      toolName: 'workspace.write',
      input: { path: 'secret.txt', content: 'first', env: { ACCESS_TOKEN: 'first-value' } },
      toolExecutionId: 'tool-write-secret-idempotent',
      idempotencyKey: 'tool-write-secret-key-1',
      executionContext: executionContext(),
    };
    await broker.execute(request);
    await assert.rejects(
      broker.execute({
        ...request,
        input: { path: 'secret.txt', content: 'first', env: { ACCESS_TOKEN: 'second-value' } },
      }),
      (error) => error instanceof ToolExecutionBrokerError
        && error.code === 'TOOL_EXECUTION_IDEMPOTENCY_CONFLICT'
        && error.status === 409,
    );
  });
});

test('ToolExecutionBroker preserves adapter failures as a durable receipt and redacts event secrets', async () => {
  await withBroker(async ({ repository }) => {
    const registry = {
      get(name) {
        return name === 'workspace.write'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: true }
          : null;
      },
      async execute() {
        const error = Object.assign(new Error('patch did not match; Authorization: Bearer must-not-persist; Authorization: Basic dXNlcjpwYXNz'), {
          code: 'WORKSPACE_PATCH_CONTEXT_MISSING',
          status: 409,
          recoverable: true,
          secret: 'must-not-persist',
        });
        throw error;
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    await assert.rejects(
      broker.execute({
        toolName: 'workspace.write',
        input: { path: 'a.txt', token: 'secret-token' },
        toolExecutionId: 'tool-write-1',
        executionContext: executionContext(),
      }),
      (error) => error instanceof ToolExecutionBrokerError
        && error.code === 'WORKSPACE_PATCH_CONTEXT_MISSING'
        && error.status === 409,
    );
    const receipt = broker.get('tool-write-1');
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.error.code, 'WORKSPACE_PATCH_CONTEXT_MISSING');
    const events = repository.listEvents({ streamId: 'execution:run-1:tool:tool-write-1' });
    assert.equal(events.at(-1).type, 'tool.execution.failed');
    assert.doesNotMatch(JSON.stringify({ receipt, events }), /must-not-persist|secret-token|dXNlcjpwYXNz/u);
  });
});

test('ToolExecutionBroker cancellation propagates a signal and preserves cancelled status', async () => {
  await withBroker(async ({ repository }) => {
    let observeAbort;
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      execute(_name, _input, context) {
        return new Promise((_resolve, reject) => {
          observeAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          context.signal.addEventListener('abort', observeAbort, { once: true });
        });
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    const submission = await broker.submit({
      toolName: 'exec.run',
      input: { command: 'node', args: ['long-running.js'] },
      toolExecutionId: 'tool-exec-1',
      executionContext: executionContext(),
    });
    assert.equal(submission.started, true);
    await broker.cancel('tool-exec-1', {
      reason: 'Authorization: Bearer cancel-token; Authorization: Basic dXNlcjpjYW5jZWw=',
    });
    const receipt = await submission.promise;
    assert.equal(receipt.status, 'cancelled');
    assert.equal(typeof observeAbort, 'function');
    assert.equal(broker.get('tool-exec-1').status, 'cancelled');
    const events = repository.listEvents({ streamId: 'execution:run-1:tool:tool-exec-1' });
    assert.doesNotMatch(JSON.stringify(events), /cancel-token|dXNlcjpjYW5jZWw=/u);
  });
});

test('ToolExecutionBroker resolves orphaned running cancellations without leaving a polling loop', async () => {
  await withBroker(async ({ repository }) => {
    const root = executionContext();
    const idempotentContext = toolContext(root, {
      executionId: 'tool-orphan-write-1',
      toolName: 'workspace.write',
      idempotencyKey: 'tool-orphan-write-1',
    });
    const nonIdempotentContext = toolContext(root, {
      executionId: 'tool-orphan-commit-1',
      toolName: 'git.commit',
      idempotencyKey: 'tool-orphan-commit-1',
    });
    repository.createExecution({
      executionId: 'tool-orphan-write-1',
      context: idempotentContext,
      kind: 'tool',
      status: 'running',
      metadata: { toolName: 'workspace.write', effectClass: 'idempotent_write' },
    });
    repository.createExecution({
      executionId: 'tool-orphan-commit-1',
      context: nonIdempotentContext,
      kind: 'tool',
      status: 'running',
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    const broker = createToolExecutionBroker({ repository });
    const cancelled = await broker.cancel('tool-orphan-write-1', { reason: 'restart_cancelled' });
    const reconciled = await broker.cancel('tool-orphan-commit-1', { reason: 'restart_cancelled' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(reconciled.status, 'reconcile_required');
    assert.equal(repository.listEvents({ streamId: 'execution:run-1:tool:tool-orphan-write-1' }).at(-1).type, 'tool.execution.cancelled');
    assert.equal(repository.listEvents({ streamId: 'execution:run-1:tool:tool-orphan-commit-1' }).at(-1).type, 'tool.execution.reconcile_required');
  });
});

test('ToolExecutionBroker never reruns an orphaned non-idempotent receipt', async () => {
  await withBroker(async ({ repository }) => {
    let calls = 0;
    const rootContext = executionContext();
    const childContext = toolContext(rootContext, {
      executionId: 'tool-commit-1',
      toolName: 'git.commit',
      idempotencyKey: 'tool-commit-1',
    });
    repository.createExecution({
      executionId: 'tool-commit-1',
      context: childContext,
      kind: 'tool',
      status: 'running',
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? { name, source: 'git', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() { calls += 1; return { commit: 'abc123' }; },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    await assert.rejects(
      broker.execute({
        toolName: 'git.commit',
        input: { message: 'first' },
        toolExecutionId: 'tool-commit-1',
        executionContext: rootContext,
      }),
      (error) => error instanceof ToolExecutionBrokerError
        && error.code === 'TOOL_EXECUTION_RECONCILE_REQUIRED'
        && error.status === 409,
    );
    assert.equal(calls, 0);
    assert.equal(broker.get('tool-commit-1').status, 'reconcile_required');
  });
});

test('ToolExecutionBroker executes tool calls through the registered dispatcher handler', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'tool-broker-handler-worker',
    });
    let registryCalls = 0;
    let handlerCalls = 0;
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute(_name, input) {
        registryCalls += 1;
        return { path: input.path, content: 'dispatched' };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository, dispatcher });
    const definition = dispatcher.handlers.get('tool.call');
    assert.ok(definition, 'the broker must register the durable tool.call handler');
    dispatcher.registerHandler('tool.call', async (request) => {
      handlerCalls += 1;
      return definition.handler(request);
    }, definition);

    const result = await broker.execute({
      toolName: 'workspace.read',
      input: { path: 'README.md' },
      toolExecutionId: 'tool-dispatch-handler-1',
      idempotencyKey: 'tool-dispatch-handler-key-1',
      executionContext: executionContext(),
    });

    assert.deepEqual(result, { path: 'README.md', content: 'dispatched' });
    assert.equal(handlerCalls, 1);
    assert.equal(registryCalls, 1);
    assert.equal(repository.getExecution('tool-dispatch-handler-1')?.status, 'succeeded');
    assert.deepEqual(
      repository.listEvents({ streamId: 'execution:run-1:tool:tool-dispatch-handler-1' }).map((event) => event.type),
      ['tool.execution.started', 'tool.execution.completed'],
    );
    dispatcher.close();
  });
});

test('ToolExecutionBroker uses dispatcher fencing so a second worker joins an active tool instead of rerunning it', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    let calls = 0;
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute(_name, input) {
        calls += 1;
        started.resolve();
        await release.promise;
        return { path: input.path, content: 'shared durable result' };
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      waitIntervalMs: 10,
    });
    const joiner = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      waitIntervalMs: 10,
    });
    const request = {
      toolName: 'workspace.read',
      input: { path: 'README.md' },
      toolExecutionId: 'tool-shared-claim-1',
      idempotencyKey: 'tool-shared-claim-key-1',
      executionContext: executionContext(),
    };

    const ownerSubmission = await owner.submit(request);
    assert.equal(ownerSubmission.started, true);
    await started.promise;

    const joinedResult = joiner.execute(request);
    await wait(30);
    assert.equal(calls, 1);

    release.resolve();
    const [ownerReceipt, result] = await Promise.all([ownerSubmission.promise, joinedResult]);
    assert.equal(ownerReceipt.status, 'succeeded');
    assert.deepEqual(result, { path: 'README.md', content: 'shared durable result' });
    assert.equal(calls, 1);
    assert.equal(joiner.get('tool-shared-claim-1').status, 'succeeded');
  });
});

test('ToolExecutionBroker propagates a remote durable cancellation to the lease owner', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    let calls = 0;
    let observedAbort = false;
    const started = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      execute(_name, _input, context) {
        calls += 1;
        started.resolve();
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            observedAbort = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          }, { once: true });
        });
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      heartbeatIntervalMs: 250,
      waitIntervalMs: 10,
    });
    const requester = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      waitIntervalMs: 10,
    });
    const request = {
      toolName: 'exec.run',
      input: { command: 'node', args: ['long-running.js'] },
      toolExecutionId: 'tool-shared-cancel-1',
      idempotencyKey: 'tool-shared-cancel-key-1',
      executionContext: executionContext(),
    };

    const ownerSubmission = await owner.submit(request);
    await started.promise;
    assert.ok(owner.active.get('tool-shared-cancel-1')?.dispatcherClaim, 'owner must retain the durable dispatcher claim');
    await wait(25);
    assert.equal(firstRepository.getExecution('tool-shared-cancel-1')?.status, 'running');
    const pendingReceipt = await requester.cancel('tool-shared-cancel-1', {
      reason: 'Authorization: Bearer remote-cancel-secret',
    });
    assert.equal(pendingReceipt.status, 'running');

    const ownerReceipt = await ownerSubmission.promise;
    const ownerRecord = firstRepository.getExecution('tool-shared-cancel-1');
    assert.equal(ownerReceipt.status, 'cancelled');
    assert.equal(ownerRecord?.status, 'cancelled');
    const receipt = await requester.wait('tool-shared-cancel-1', { timeoutMs: 3_000 });
    assert.equal(receipt.status, 'cancelled');
    assert.equal(calls, 1);
    assert.equal(observedAbort, true);
    const persisted = JSON.stringify({
      execution: secondRepository.getExecution('tool-shared-cancel-1'),
      events: secondRepository.listEvents({ streamId: 'run:run-1' }),
    });
    assert.doesNotMatch(persisted, /remote-cancel-secret/u);
    assert.match(persisted, /execution\.cancel_requested/u);
    assert.match(persisted, /execution\.cancelled/u);
  });
});

test('ToolExecutionBroker persists cancellation intent before publishing a cancellation event', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const started = deferred();
    const release = deferred();
    let ownerClaim = null;
    let completionFromObservedEvent = null;
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        return release.promise;
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      heartbeatIntervalMs: 2_000,
    });
    const requester = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      emit(event) {
        if (event.type === 'execution.cancel_requested' && ownerClaim) {
          completionFromObservedEvent = firstDispatcher.complete(ownerClaim, { exitCode: 0, stdout: 'late completion' });
        }
      },
    });
    const id = 'tool-cancel-event-ordering';
    const submission = await owner.submit({
      toolName: 'exec.run',
      input: { command: 'node', args: ['long-running.js'] },
      toolExecutionId: id,
      idempotencyKey: 'tool-cancel-event-ordering-key',
      executionContext: executionContext(),
    });
    await started.promise;
    ownerClaim = owner.active.get(id)?.dispatcherClaim;
    assert.ok(ownerClaim, 'the owner must hold a dispatcher claim before cancellation');

    const cancelled = await requester.cancel(id, { reason: 'operator requested cancellation' });
    assert.equal(completionFromObservedEvent?.status, 'cancelled');
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(secondRepository.getExecution(id)?.metadata?.dispatcher?.cancelRequestedAt);

    release.resolve({ exitCode: 0, stdout: 'late completion' });
    const ownerReceipt = await submission.promise;
    assert.equal(ownerReceipt.status, 'cancelled');
    assert.equal(firstRepository.getExecution(id)?.status, 'cancelled');
  });
});

test('ToolExecutionBroker default mode keeps a durable cancellation ahead of a late adapter success', async () => {
  await withBroker(async ({ repository }) => {
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        return release.promise;
      },
    };
    const broker = createToolExecutionBroker({ registry, repository });
    const id = 'tool-default-cancel-late-success';
    const submission = await broker.submit({
      toolName: 'exec.run',
      input: { command: 'node', args: ['late-success.js'] },
      toolExecutionId: id,
      idempotencyKey: 'tool-default-cancel-late-success-key',
      executionContext: executionContext(),
    });
    await started.promise;
    const pending = await broker.cancel(id, { reason: 'operator requested cancellation' });
    assert.equal(pending.status, 'running');
    assert.ok(repository.getExecution(id)?.metadata?.dispatcher?.cancelRequestedAt);

    release.resolve({ exitCode: 0, stdout: 'late success' });
    const receipt = await submission.promise;
    assert.equal(receipt.status, 'cancelled');
    assert.equal(repository.getExecution(id)?.status, 'cancelled');
    const events = repository.listEvents({ streamId: `execution:run-1:tool:${id}` });
    assert.equal(events.some((event) => event.type === 'tool.execution.completed' && event.payload.status === 'succeeded'), false);
    assert.ok(events.some((event) => event.type === 'tool.execution.cancelled'));
  });
});

test('ToolExecutionBroker default settlement resolves a concurrent durable cancellation inside one transaction', async () => {
  await withSharedDispatchers(async ({ firstRepository, secondRepository }) => {
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        return release.promise;
      },
    };
    const broker = createToolExecutionBroker({ registry, repository: firstRepository });
    const id = 'tool-default-transactional-cancel';
    const submission = await broker.submit({
      toolName: 'exec.run',
      input: { command: 'node', args: ['transactional-cancel.js'] },
      toolExecutionId: id,
      idempotencyKey: 'tool-default-transactional-cancel-key',
      executionContext: executionContext(),
    });
    await started.promise;

    const updateExecutionIfStatus = firstRepository.updateExecutionIfStatus.bind(firstRepository);
    let injectedCancellation = false;
    firstRepository.updateExecutionIfStatus = (executionId, patch, options) => {
      if (!injectedCancellation && executionId === id && typeof patch === 'function') {
        injectedCancellation = true;
        const current = secondRepository.getExecution(id);
        const marked = secondRepository.updateExecutionIfStatus(id, {
          metadata: {
            ...(current.metadata || {}),
            dispatcher: {
              ...(current.metadata?.dispatcher || {}),
              cancelRequestedAt: '2026-08-16T02:00:00.000Z',
              cancelReason: 'concurrent remote cancellation',
            },
          },
        }, { expectedStatuses: ['running'] });
        assert.ok(marked);
      }
      return updateExecutionIfStatus(executionId, patch, options);
    };
    try {
      release.resolve({ exitCode: 0, stdout: 'late success' });
      const receipt = await submission.promise;
      assert.equal(injectedCancellation, true);
      assert.equal(receipt.status, 'cancelled');
      const durable = secondRepository.getExecution(id);
      assert.equal(durable.status, 'cancelled');
      assert.equal(durable.error.code, 'TOOL_EXECUTION_CANCELLED');
    } finally {
      firstRepository.updateExecutionIfStatus = updateExecutionIfStatus;
    }
  });
});

test('ToolExecutionBroker default mode does not start an adapter after a concurrent cancellation', async () => {
  await withSharedDispatchers(async ({ firstRepository, secondRepository }) => {
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        calls += 1;
        return { exitCode: 0, stdout: 'must not execute' };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository: firstRepository });
    const id = 'tool-default-start-cancel-race';
    const updateExecutionIfStatus = firstRepository.updateExecutionIfStatus.bind(firstRepository);
    let injectedCancellation = false;
    firstRepository.updateExecutionIfStatus = (executionId, patch, options) => {
      if (!injectedCancellation && executionId === id && typeof patch === 'function') {
        injectedCancellation = true;
        const current = secondRepository.getExecution(id);
        const marked = secondRepository.updateExecutionIfStatus(id, {
          metadata: {
            ...(current.metadata || {}),
            dispatcher: {
              ...(current.metadata?.dispatcher || {}),
              cancelRequestedAt: '2026-08-16T02:00:00.000Z',
              cancelReason: 'cancelled before adapter start',
            },
          },
        }, { expectedStatuses: ['queued'] });
        assert.ok(marked);
      }
      return updateExecutionIfStatus(executionId, patch, options);
    };
    try {
      const submission = await broker.submit({
        toolName: 'exec.run',
        input: { command: 'node', args: ['must-not-run.js'] },
        toolExecutionId: id,
        idempotencyKey: 'tool-default-start-cancel-race-key',
        executionContext: executionContext(),
      });
      const receipt = await submission.promise;
      assert.equal(injectedCancellation, true);
      assert.equal(calls, 0);
      assert.equal(receipt.status, 'cancelled');
      assert.equal(secondRepository.getExecution(id)?.status, 'cancelled');
    } finally {
      firstRepository.updateExecutionIfStatus = updateExecutionIfStatus;
    }
  });
});

test('ToolExecutionBroker lets a remote cancellation win over an error before the owner heartbeat', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const started = deferred();
    const failAdapter = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        return failAdapter.promise;
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      // Keep this larger than the deliberate error race below. The owner must
      // rely on the Dispatcher's fenced cancellation check, not its heartbeat.
      heartbeatIntervalMs: 2_000,
      waitIntervalMs: 10,
    });
    const requester = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      waitIntervalMs: 10,
    });
    const submission = await owner.submit({
      toolName: 'exec.run',
      input: { command: 'node', args: ['fails-after-remote-cancel.js'] },
      toolExecutionId: 'tool-remote-cancel-error-race',
      idempotencyKey: 'tool-remote-cancel-error-race-key',
      executionContext: executionContext(),
    });
    await started.promise;
    const pending = await requester.cancel('tool-remote-cancel-error-race', {
      reason: 'remote operator cancelled this command',
    });
    assert.equal(pending.status, 'running');

    failAdapter.reject(Object.assign(new Error('adapter failed after cancellation'), {
      code: 'ADAPTER_LATE_FAILURE',
      status: 500,
    }));
    const receipt = await submission.promise;
    const durable = firstRepository.getExecution('tool-remote-cancel-error-race');
    assert.equal(receipt.status, 'cancelled');
    assert.equal(durable?.status, 'cancelled');
    assert.equal(durable?.error?.code, 'RUNTIME_V3_EXECUTION_CANCELLED');
    const events = firstRepository.listEvents({ streamId: 'execution:run-1:tool:tool-remote-cancel-error-race' });
    assert.equal(events.at(-1)?.type, 'tool.execution.cancelled');
  });
});

test('ToolExecutionBroker terminalizes a queued cancellation before a competing worker can claim it', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const root = executionContext({ idempotencyKey: 'queued-cancel-root' });
    const id = 'tool-queued-cancel-race';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'exec.run',
      idempotencyKey: 'queued-cancel-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'exec.run', effectClass: 'non_idempotent' },
    });
    const requester = createToolExecutionBroker({
      repository: secondRepository,
      dispatcher: secondDispatcher,
      waitIntervalMs: 10,
    });
    const claim = secondDispatcher.claim.bind(secondDispatcher);
    let ownerClaim = null;
    secondDispatcher.claim = (executionId, options) => {
      ownerClaim = firstDispatcher.claim(executionId, options);
      return null;
    };
    try {
      const receipt = await requester.cancel(id, { reason: 'race cancellation' });
      assert.equal(receipt.status, 'cancelled');
    } finally {
      secondDispatcher.claim = claim;
    }

    assert.equal(ownerClaim, null, 'a durable cancellation marker must block a later claim');
    const cancelled = firstRepository.getExecution(id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.metadata.dispatcher.cancelReason, 'race cancellation');
    assert.equal(secondRepository.getExecution(id).status, 'cancelled');
    assert.equal(firstRepository.getLease(executionLeaseKey(id))?.active ?? false, false);
  });
});

test('ToolExecutionBroker cancellation preserves a concurrent dispatcher claim and its fencing token', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const id = 'tool-cancel-preserves-claim';
    const root = executionContext({ idempotencyKey: 'tool-cancel-preserves-claim-root' });
    const context = toolContext(root, {
      executionId: id,
      toolName: 'exec.run',
      idempotencyKey: 'tool-cancel-preserves-claim-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'exec.run', effectClass: 'non_idempotent' },
    });
    const requester = createToolExecutionBroker({
      repository: secondRepository,
      dispatcher: secondDispatcher,
    });
    const updateExecutionIfStatus = secondRepository.updateExecutionIfStatus.bind(secondRepository);
    let ownerClaim = null;
    secondRepository.updateExecutionIfStatus = (executionId, patch, options) => {
      if (!ownerClaim && executionId === id && typeof patch === 'function') {
        ownerClaim = firstDispatcher.claim(id);
        assert.ok(ownerClaim);
      }
      return updateExecutionIfStatus(executionId, patch, options);
    };
    try {
      const pending = await requester.cancel(id, { reason: 'cancel while another worker claims the tool' });
      assert.equal(pending.status, 'running');
      const durable = firstRepository.getExecution(id);
      assert.equal(durable?.status, 'running');
      assert.equal(durable?.metadata?.dispatcher?.workerId, 'tool-broker-worker-a');
      assert.equal(durable?.metadata?.dispatcher?.fencingToken, ownerClaim.fencingToken);
      assert.ok(durable?.metadata?.dispatcher?.cancelRequestedAt);

      const cancelled = firstDispatcher.cancel(ownerClaim, { reason: 'owner observed the cancellation request' });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(secondRepository.getExecution(id)?.status, 'cancelled');
    } finally {
      secondRepository.updateExecutionIfStatus = updateExecutionIfStatus;
    }
  }, { leaseTtlMs: 30_000 });
});

test('ToolExecutionBroker lets a durable cancellation win over an adapter that returns success late', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'late-success-worker',
      // This case verifies cancellation precedence, not expiry recovery. Use
      // the production-sized TTL so synchronous SQLite control-plane work on
      // Windows cannot expire the owner lease before the late result arrives.
      leaseTtlMs: 30_000,
    });
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        await release.promise;
        return { exitCode: 0, stdout: 'late success' };
      },
    };
    const broker = createToolExecutionBroker({
      registry,
      repository,
      dispatcher,
      heartbeatIntervalMs: 250,
    });
    try {
      const submission = await broker.submit({
        toolName: 'exec.run',
        input: { command: 'node', args: ['late-success.js'] },
        toolExecutionId: 'tool-late-success-cancel',
        idempotencyKey: 'tool-late-success-cancel-key',
        executionContext: executionContext(),
      });
      await started.promise;
      const pending = await broker.cancel('tool-late-success-cancel', { reason: 'operator_cancelled' });
      assert.equal(pending.status, 'running');

      release.resolve();
      const receipt = await submission.promise;
      assert.equal(receipt.status, 'cancelled');
      assert.equal(repository.getExecution('tool-late-success-cancel').status, 'cancelled');
      assert.equal(repository.getExecution('tool-late-success-cancel').error.reason, 'cancel_requested');
      const events = repository.listEvents({ streamId: 'execution:run-1:tool:tool-late-success-cancel' });
      assert.ok(events.some((event) => event.type === 'tool.execution.cancelled'));
      assert.equal(events.some((event) => event.type === 'tool.execution.completed' && event.payload.status === 'succeeded'), false);
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker fences reconciliation so only one worker invokes a reconcile adapter', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const root = executionContext({ idempotencyKey: 'reconcile-root' });
    const id = 'tool-reconcile-single-owner';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'git.commit',
      idempotencyKey: 'reconcile-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    firstRepository.updateExecution(id, {
      status: 'reconcile_required',
      error: { code: 'TOOL_EXECUTION_RECONCILE_REQUIRED', message: 'probe required', status: 409 },
    });

    let calls = 0;
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? {
              name,
              source: 'git',
              risk: 'approval_required',
              idempotent: false,
              async reconcile() {
                calls += 1;
                started.resolve();
                await release.promise;
                return { commit: 'already-created' };
              },
            }
          : null;
      },
      async execute() {
        throw new Error('reconcile must not use execute()');
      },
    };
    const owner = createToolExecutionBroker({ registry, repository: firstRepository, dispatcher: firstDispatcher });
    const contender = createToolExecutionBroker({ registry, repository: secondRepository, dispatcher: secondDispatcher });

    const ownerReconcile = owner.reconcile(id);
    await started.promise;
    const joined = await contender.reconcile(id);
    assert.equal(joined.status, 'running');
    assert.equal(calls, 1);

    release.resolve();
    const receipt = await ownerReconcile;
    assert.equal(receipt.status, 'succeeded');
    assert.equal(calls, 1);
    const events = firstRepository.listEvents({ streamId: `execution:run-1:tool:${id}` });
    assert.equal(events.filter((event) => event.type === 'tool.execution.reconciling').length, 1);
    assert.equal(events.filter((event) => event.type === 'tool.execution.reconciled').length, 1);
  });
});

test('ToolExecutionBroker aborts an active reconciliation after a remote cancellation request', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const root = executionContext({ idempotencyKey: 'reconcile-cancel-root' });
    const id = 'tool-reconcile-remote-cancel';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'git.commit',
      idempotencyKey: 'reconcile-cancel-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    firstRepository.updateExecution(id, {
      status: 'reconcile_required',
      error: { code: 'TOOL_EXECUTION_RECONCILE_REQUIRED', message: 'probe required', status: 409 },
    });

    const started = deferred();
    let receivedSignal = null;
    let committedEffects = 0;
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? {
              name,
              source: 'git',
              risk: 'approval_required',
              idempotent: false,
              reconcile({ signal }) {
                receivedSignal = signal;
                started.resolve();
                return new Promise((resolve, reject) => {
                  signal.addEventListener('abort', () => {
                    reject(Object.assign(new Error('reconciliation cancelled'), {
                      name: 'AbortError',
                      code: 'ABORT_ERR',
                    }));
                  }, { once: true });
                  // The side effect must only happen if cancellation never
                  // reached this reconciliation adapter.
                  void resolve;
                });
              },
            }
          : null;
      },
      async execute() {
        committedEffects += 1;
        return { unexpected: true };
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      heartbeatIntervalMs: 10,
      waitIntervalMs: 10,
    });
    const requester = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      waitIntervalMs: 10,
    });

    const reconciliation = owner.reconcile(id);
    await started.promise;
    assert.ok(receivedSignal, 'the reconciliation adapter must receive an AbortSignal');
    const pending = await requester.cancel(id, { reason: 'operator cancelled reconciliation' });
    assert.equal(pending.status, 'running');
    const receipt = await reconciliation;
    assert.equal(receipt.status, 'cancelled');
    assert.equal(firstRepository.getExecution(id)?.status, 'cancelled');
    assert.equal(receivedSignal.aborted, true);
    assert.equal(committedEffects, 0);
    const events = firstRepository.listEvents({ streamId: `execution:run-1:tool:${id}` });
    assert.equal(events.at(-1)?.type, 'tool.execution.cancelled');
  });
});

test('ToolExecutionBroker aborts a reconciliation adapter when its worker loses the fencing lease', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    firstDispatcher,
    secondRepository,
    secondDispatcher,
  }) => {
    const root = executionContext({ idempotencyKey: 'reconcile-fence-loss-root' });
    const id = 'tool-reconcile-fence-loss';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'git.commit',
      idempotencyKey: 'reconcile-fence-loss-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    firstRepository.updateExecution(id, {
      status: 'reconcile_required',
      error: { code: 'TOOL_EXECUTION_RECONCILE_REQUIRED', message: 'probe required', status: 409 },
    });

    const firstStarted = deferred();
    const firstAborted = deferred();
    let firstFinished = false;
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? {
              name,
              source: 'git',
              risk: 'approval_required',
              idempotent: false,
              reconcile({ signal }) {
                calls += 1;
                if (calls === 1) {
                  firstStarted.resolve();
                  return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                      firstFinished = true;
                      firstAborted.resolve(signal.reason);
                      reject(Object.assign(new Error('fencing lease lost'), {
                        name: 'AbortError',
                        code: 'ABORT_ERR',
                      }));
                    }, { once: true });
                    void resolve;
                  });
                }
                assert.equal(firstFinished, true, 'the fenced-off adapter must stop before a successor runs');
                return { reconciledBy: 'worker-b' };
              },
            }
          : null;
      },
      async execute() {
        throw new Error('reconcile must not use execute()');
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      heartbeatIntervalMs: 10,
      waitIntervalMs: 10,
    });
    const successor = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      heartbeatIntervalMs: 10,
      waitIntervalMs: 10,
    });

    const first = owner.reconcile(id);
    await firstStarted.promise;
    firstDispatcher.close();
    await firstAborted.promise;
    await first;

    await wait(1_100);
    const recovered = await secondDispatcher.recoverExpired();
    assert.equal(recovered[0]?.status, 'reconcile_required');
    const receipt = await successor.reconcile(id);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(calls, 2);
  }, { leaseTtlMs: 1_000 });
});

test('ToolExecutionBroker shutdown leaves an uncooperative operation reconcilable before closing storage', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'shutdown-worker',
      leaseTtlMs: 1_000,
    });
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? { name, source: 'workspace', risk: 'approval_required', idempotent: false }
          : null;
      },
      async execute() {
        started.resolve();
        await release.promise;
        return { exitCode: 0 };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository, dispatcher, heartbeatIntervalMs: 250 });
    try {
      const submission = await broker.submit({
        toolName: 'exec.run',
        input: { command: 'node', args: ['does-not-stop.js'] },
        toolExecutionId: 'tool-close-reconcile',
        idempotencyKey: 'tool-close-reconcile-key',
        executionContext: executionContext(),
      });
      await started.promise;
      await broker.close({ timeoutMs: 25 });

      const durable = repository.getExecution('tool-close-reconcile');
      assert.equal(durable.status, 'reconcile_required');
      assert.equal(durable.error.code, 'TOOL_EXECUTION_RECONCILE_REQUIRED');

      release.resolve();
      const receipt = await submission.promise;
      assert.equal(receipt.status, 'reconcile_required');
      assert.equal(repository.getExecution('tool-close-reconcile').status, 'reconcile_required');
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker shutdown does not wait forever for an adapter cancel hook', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'shutdown-cancel-hook-worker',
      leaseTtlMs: 1_000,
    });
    const started = deferred();
    const release = deferred();
    const never = new Promise(() => {});
    const registry = {
      get(name) {
        return name === 'exec.run'
          ? {
              name,
              source: 'workspace',
              risk: 'approval_required',
              idempotent: false,
              cancel: () => never,
            }
          : null;
      },
      async execute() {
        started.resolve();
        await release.promise;
        return { exitCode: 0 };
      },
    };
    const broker = createToolExecutionBroker({ registry, repository, dispatcher, heartbeatIntervalMs: 10 });
    try {
      const submission = await broker.submit({
        toolName: 'exec.run',
        input: { command: 'node', args: ['hangs-in-cancel.js'] },
        toolExecutionId: 'tool-close-cancel-hook',
        idempotencyKey: 'tool-close-cancel-hook-key',
        executionContext: executionContext(),
      });
      await started.promise;

      const closed = await Promise.race([
        broker.close({ timeoutMs: 100 }).then(() => true),
        wait(350).then(() => false),
      ]);
      assert.equal(closed, true);
      assert.equal(repository.getExecution('tool-close-cancel-hook').status, 'reconcile_required');

      release.resolve();
      const receipt = await submission.promise;
      assert.equal(receipt.status, 'reconcile_required');
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker publishes an active operation before a synchronous start observer can close it', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'synchronous-start-close-worker',
      leaseTtlMs: 30_000,
    });
    let calls = 0;
    let broker;
    let closing = null;
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute() {
        calls += 1;
        return { content: 'must not execute after shutdown begins' };
      },
    };
    broker = createToolExecutionBroker({
      registry,
      repository,
      dispatcher,
      emit(event) {
        if (event.type === 'tool.execution.started' && !closing) {
          closing = broker.close({ timeoutMs: 100 });
        }
      },
    });
    try {
      const submission = await broker.submit({
        toolName: 'workspace.read',
        input: { path: 'README.md' },
        toolExecutionId: 'tool-sync-start-close',
        idempotencyKey: 'tool-sync-start-close-key',
        executionContext: executionContext(),
      });
      const receipt = await submission.promise;
      await closing;
      assert.equal(calls, 0);
      assert.equal(receipt.status, 'cancelled');
      assert.equal(repository.getExecution('tool-sync-start-close')?.status, 'cancelled');
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker does not start a submission that resumes after shutdown during recovery', async () => {
  await withBroker(async ({ repository }) => {
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'recovery-close-worker',
      leaseTtlMs: 1_000,
    });
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    dispatcher.recoverExpired = async () => {
      recoveryStarted.resolve();
      await releaseRecovery.promise;
      return [];
    };
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute() {
        calls += 1;
        return { content: 'must not execute after recovery-time shutdown' };
      },
    };
    const root = executionContext({ idempotencyKey: 'recovery-close-root' });
    const id = 'tool-recovery-close';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'workspace.read',
      idempotencyKey: 'recovery-close-key',
    });
    const queued = dispatcher.enqueue({
      executionId: id,
      context,
      kind: 'tool',
      metadata: { toolName: 'workspace.read', source: 'workspace', effectClass: 'read' },
      handlerKey: 'tool.call',
      effectClass: 'read',
      maxRetries: 0,
    });
    const priorClaim = dispatcher.claim(queued.executionId);
    assert.ok(priorClaim);

    const broker = createToolExecutionBroker({ registry, repository, dispatcher });
    try {
      const submissionPromise = broker.submit({
        toolName: 'workspace.read',
        input: { path: 'README.md' },
        toolExecutionId: id,
        idempotencyKey: 'recovery-close-key',
        executionContext: root,
      });
      await recoveryStarted.promise;
      const closing = broker.close({ timeoutMs: 100 });
      releaseRecovery.resolve();
      const submission = await submissionPromise;
      await closing;

      assert.equal(submission.started, false);
      assert.equal(calls, 0);
      assert.equal(broker.get(id)?.status, 'running');
    } finally {
      dispatcher.cancel(priorClaim, { reason: 'test_cleanup' });
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker stops a submit claimed during a synchronous shutdown observer', async () => {
  await withBroker(async ({ repository }) => {
    let broker;
    let closing = null;
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'claim-close-worker',
      leaseTtlMs: 1_000,
      emit(event) {
        if (event.type === 'execution.claimed' && !closing) {
          closing = broker.close({ timeoutMs: 100 });
        }
      },
    });
    let calls = 0;
    const registry = {
      get(name) {
        return name === 'workspace.read'
          ? { name, source: 'workspace', risk: 'read', idempotent: true }
          : null;
      },
      async execute() {
        calls += 1;
        return { content: 'must not execute after claim-time shutdown' };
      },
    };
    broker = createToolExecutionBroker({ registry, repository, dispatcher });
    try {
      const submission = await broker.submit({
        toolName: 'workspace.read',
        input: { path: 'README.md' },
        toolExecutionId: 'tool-claim-close',
        idempotencyKey: 'claim-close-key',
        executionContext: executionContext({ idempotencyKey: 'claim-close-root' }),
      });
      await closing;

      assert.equal(submission.started, false);
      assert.equal(submission.receipt.status, 'cancelled');
      assert.equal(calls, 0);
      assert.equal(repository.getExecution('tool-claim-close')?.status, 'cancelled');
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker releases a reconciliation claim when a synchronous shutdown observer closes the broker', async () => {
  await withBroker(async ({ repository }) => {
    let broker;
    let closing = null;
    let reconciliationCalls = 0;
    const dispatcher = createExecutionDispatcher({
      repository,
      workerId: 'reconcile-claim-close-worker',
      leaseTtlMs: 1_000,
      emit(event) {
        if (event.type === 'execution.claimed' && !closing) {
          closing = broker.close({ timeoutMs: 100 });
        }
      },
    });
    const id = 'tool-reconcile-claim-close';
    const root = executionContext({ idempotencyKey: 'reconcile-claim-close-root' });
    const context = toolContext(root, {
      executionId: id,
      toolName: 'git.commit',
      idempotencyKey: 'reconcile-claim-close-key',
    });
    dispatcher.enqueue({
      executionId: id,
      context,
      kind: 'tool',
      metadata: { toolName: 'git.commit', source: 'git', effectClass: 'non_idempotent' },
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
    });
    repository.updateExecution(id, { status: 'reconcile_required' });
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? {
              name,
              source: 'git',
              risk: 'approval_required',
              idempotent: false,
              async reconcile() {
                reconciliationCalls += 1;
                return { unexpected: true };
              },
            }
          : null;
      },
      async execute() {
        throw new Error('reconcile must not invoke execute');
      },
    };
    broker = createToolExecutionBroker({ registry, repository, dispatcher });
    try {
      const receipt = await broker.reconcile(id);
      await closing;

      assert.equal(receipt.status, 'cancelled');
      assert.equal(reconciliationCalls, 0);
      assert.equal(repository.getExecution(id)?.status, 'cancelled');
      assert.equal(repository.getLease(executionLeaseKey(id))?.active ?? false, false);
    } finally {
      dispatcher.close();
    }
  });
});

test('ToolExecutionBroker ignores a late reconciliation failure after shutdown closes owned storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-tool-broker-late-reconcile-'));
  const started = deferred();
  const release = deferred();
  const registry = {
    get(name) {
      return name === 'git.commit'
        ? {
            name,
            source: 'git',
            risk: 'approval_required',
            idempotent: false,
            async reconcile() {
              started.resolve();
              return release.promise;
            },
          }
        : null;
    },
    async execute() {
      throw new Error('reconcile must not invoke execute');
    },
  };
  const broker = createToolExecutionBroker({ registry, rootDir: root });
  const id = 'tool-late-reconcile-close';
  const context = toolContext(executionContext({ idempotencyKey: 'late-reconcile-root' }), {
    executionId: id,
    toolName: 'git.commit',
    idempotencyKey: 'late-reconcile-key',
  });
  broker.repository.createExecution({
    executionId: id,
    context,
    kind: 'tool',
    status: 'reconcile_required',
    metadata: { toolName: 'git.commit', source: 'git', effectClass: 'non_idempotent' },
  });
  const keepAlive = setInterval(() => {}, 10);
  try {
    const reconciliation = broker.reconcile(id);
    await started.promise;
    await broker.close({ timeoutMs: 100 });
    release.reject(new Error('late reconciliation failure'));
    const receipt = await reconciliation;

    assert.equal(receipt.status, 'reconcile_required');
    assert.equal(receipt.toolExecutionId, id);
  } finally {
    clearInterval(keepAlive);
    await broker.close({ timeoutMs: 100 });
    await rm(root, { recursive: true, force: true });
  }
});

test('ToolExecutionBroker heartbeats a long reconciliation so a second worker cannot replay it', async () => {
  await withSharedDispatchers(async ({
    firstRepository,
    secondRepository,
    firstDispatcher,
    secondDispatcher,
  }) => {
    const root = executionContext({ idempotencyKey: 'reconcile-heartbeat-root' });
    const id = 'tool-reconcile-heartbeat';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'git.commit',
      idempotencyKey: 'reconcile-heartbeat-key',
    });
    firstDispatcher.enqueue({
      executionId: id,
      kind: 'tool',
      context,
      handlerKey: 'tool.call',
      effectClass: 'non_idempotent',
      maxRetries: 0,
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    firstRepository.updateExecution(id, {
      status: 'reconcile_required',
      error: { code: 'TOOL_EXECUTION_RECONCILE_REQUIRED', message: 'probe required', status: 409 },
    });

    let calls = 0;
    const started = deferred();
    const release = deferred();
    const registry = {
      get(name) {
        return name === 'git.commit'
          ? {
              name,
              source: 'git',
              risk: 'approval_required',
              idempotent: false,
              async reconcile() {
                calls += 1;
                started.resolve();
                await release.promise;
                return { commit: 'already-created' };
              },
            }
          : null;
      },
      async execute() {
        throw new Error('reconcile must not use execute()');
      },
    };
    const owner = createToolExecutionBroker({
      registry,
      repository: firstRepository,
      dispatcher: firstDispatcher,
      heartbeatIntervalMs: 10,
    });
    const contender = createToolExecutionBroker({
      registry,
      repository: secondRepository,
      dispatcher: secondDispatcher,
      heartbeatIntervalMs: 10,
    });

    const ownerReconcile = owner.reconcile(id);
    await started.promise;
    const initialLease = firstRepository.getLease(executionLeaseKey(id));
    const initialRenewedAt = Date.parse(initialLease.renewedAt);
    await wait(650);
    const renewedLease = firstRepository.getLease(executionLeaseKey(id));
    assert.equal(renewedLease.active, true);
    assert.ok(Date.parse(renewedLease.renewedAt) > initialRenewedAt, 'the owner must renew before the original lease expires');
    assert.deepEqual(await secondDispatcher.recoverExpired(), []);
    const joined = await contender.reconcile(id);
    assert.equal(joined.status, 'running');
    assert.equal(calls, 1);

    release.resolve();
    const receipt = await ownerReconcile;
    assert.equal(receipt.status, 'succeeded');
    assert.equal(calls, 1);
  }, { leaseTtlMs: 500 });
});

test('ToolExecutionBroker converts queued legacy default-broker tool rows without persisted input into reconciliation receipts', async () => {
  await withBroker(async ({ repository }) => {
    const root = executionContext({ idempotencyKey: 'queued-orphan-root' });
    const id = 'tool-queued-orphan';
    const context = toolContext(root, {
      executionId: id,
      toolName: 'workspace.write',
      idempotencyKey: 'queued-orphan-key',
    });
    repository.createExecution({
      executionId: id,
      context,
      kind: 'tool',
      status: 'queued',
      metadata: {
        toolName: 'workspace.write',
        effectClass: 'idempotent_write',
      },
    });
    const broker = createToolExecutionBroker({ repository });
    const reconciled = await broker.reconcileQueuedOrphans();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].status, 'reconcile_required');
    const durable = repository.getExecution(id);
    assert.equal(durable.status, 'reconcile_required');
    assert.equal(durable.error.code, 'TOOL_EXECUTION_PAYLOAD_UNAVAILABLE');
    assert.equal(repository.listEvents({ streamId: `execution:run-1:tool:${id}` }).at(-1).type, 'tool.execution.reconcile_required');
  });
});

test('ToolExecutionBroker refuses new reconciliation work once shutdown begins', async () => {
  await withBroker(async ({ repository }) => {
    const root = executionContext({ idempotencyKey: 'shutdown-reconcile-root' });
    const reconcileId = 'tool-shutdown-reconcile';
    const orphanId = 'tool-shutdown-orphan';
    const reconcileContext = toolContext(root, {
      executionId: reconcileId,
      toolName: 'git.commit',
      idempotencyKey: 'shutdown-reconcile-key',
    });
    const orphanContext = toolContext(root, {
      executionId: orphanId,
      toolName: 'workspace.write',
      idempotencyKey: 'shutdown-orphan-key',
    });
    repository.createExecution({
      executionId: reconcileId,
      context: reconcileContext,
      kind: 'tool',
      status: 'reconcile_required',
      metadata: { toolName: 'git.commit', effectClass: 'non_idempotent' },
    });
    repository.createExecution({
      executionId: orphanId,
      context: orphanContext,
      kind: 'tool',
      status: 'queued',
      metadata: {
        toolName: 'workspace.write',
        effectClass: 'idempotent_write',
        dispatcher: { handlerKey: 'tool.call' },
      },
    });

    let reconcileCalls = 0;
    const broker = createToolExecutionBroker({
      repository,
      registry: {
        get(name) {
          return name === 'git.commit'
            ? {
                name,
                source: 'git',
                risk: 'approval_required',
                idempotent: false,
                async reconcile() {
                  reconcileCalls += 1;
                  return { unexpected: true };
                },
              }
            : null;
        },
        async execute() {
          throw new Error('reconcile must not use execute()');
        },
      },
    });

    const closing = broker.close({ timeoutMs: 100 });
    const isClosed = (error) => error instanceof ToolExecutionBrokerError
      && error.code === 'TOOL_EXECUTION_BROKER_CLOSED'
      && error.status === 409;
    await assert.rejects(broker.reconcile(reconcileId), isClosed);
    await assert.rejects(broker.reconcileQueuedOrphans(), isClosed);
    await closing;

    assert.equal(reconcileCalls, 0);
    assert.equal(repository.getExecution(reconcileId)?.status, 'reconcile_required');
    assert.equal(repository.getExecution(orphanId)?.status, 'queued');
  });
});
