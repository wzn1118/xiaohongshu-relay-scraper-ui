import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { createRunCoordinator } from './copilot/run-coordinator.mjs';

test('schema v2 migrates in place and preserves existing production records', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-migration-v2-'));
  let store = createCopilotProductionStore({ rootDir });
  t.after(async () => { store?.close(); await rm(rootDir, { recursive: true, force: true }); });
  store.upsertSnapshot({ jobId: 'job-1', snapshotId: 'job-r1', revision: 1, manifest: { count: 3 } });
  const filePath = store.filePath;
  store.close();

  store = createCopilotProductionStore({ filePath });
  assert.equal(store.describe().schemaVersion, 2);
  assert.equal(store.getSnapshot('job-1', 'job-r1').manifest.count, 3);
});

test('run coordinator persists plan, checkpoints, attempts, pause and resume', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-run-v2-'));
  const store = createCopilotProductionStore({ rootDir });
  t.after(async () => { store.close(); await rm(rootDir, { recursive: true, force: true }); });
  const coordinator = createRunCoordinator({ store });
  let started;
  const taskStarted = new Promise((resolve) => { started = resolve; });
  const { runId, completion } = coordinator.start({
    runId: 'run-1',
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    goal: 'profile the data',
    tasks: [{ id: 'profile', kind: 'dataset.profile', input: { rows: [{ score: 1 }] } }],
    executeTask: async () => {
      started();
      return new Promise((resolve) => setTimeout(() => resolve({ rowCount: 1 }), 5_000));
    },
  });
  await taskStarted;
  assert.equal(coordinator.pause(runId), true);
  const paused = await completion;
  assert.equal(paused.run.status, 'paused');
  assert.equal(paused.nodes[0].attemptCount, 1);

  const resumed = await coordinator.resume(runId, { executeTask: async () => ({ rowCount: 1 }) });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.nodes[0].status, 'completed');
  assert.equal(resumed.nodes[0].attemptCount, 2);
  assert.deepEqual(resumed.nodes[0].output, { rowCount: 1 });
  assert.equal(resumed.attempts, undefined);
  const state = coordinator.getState(runId);
  assert.equal(state.planRevisions.length, 1);
  assert.deepEqual(state.attempts.map((attempt) => attempt.status), ['failed', 'completed']);
  assert.equal(state.turn.status, 'completed');
});

test('run coordinator steers an active run after its paused execution settles', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-steer-v2-'));
  const store = createCopilotProductionStore({ rootDir });
  t.after(async () => { store.close(); await rm(rootDir, { recursive: true, force: true }); });
  const coordinator = createRunCoordinator({ store });
  let started;
  const taskStarted = new Promise((resolve) => { started = resolve; });
  const { runId, completion } = coordinator.start({
    runId: 'run-steer-1',
    turnId: 'turn-steer-1',
    conversationId: 'conversation-steer-1',
    goal: 'analyze the initial direction',
    tasks: [{ id: 'initial', kind: 'analysis' }],
    executeTask: async () => {
      started();
      return new Promise((resolve) => setTimeout(() => resolve({ stale: true }), 5_000));
    },
  });
  await taskStarted;

  const steered = await coordinator.steer(runId, {
    reason: 'focus_on_verified_result',
    tasks: [{ id: 'revised', kind: 'verify', title: 'Verify revised result' }],
    executeTask: async () => ({ verified: true }),
  });
  const paused = await completion;

  assert.equal(paused.run.status, 'paused');
  assert.equal(steered.run.status, 'completed');
  assert.equal(steered.run.planRevision, 2);
  assert.equal(steered.nodes.find((node) => node.nodeId === 'revised')?.status, 'completed');
  assert.equal(coordinator.getState(runId).planRevisions.length, 2);
});

test('run coordinator recovers process-interrupted runs into a resumable checkpoint', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-process-recovery-v2-'));
  let store = createCopilotProductionStore({ rootDir });
  t.after(async () => { store?.close(); await rm(rootDir, { recursive: true, force: true }); });
  store.upsertTurn({ turnId: 'turn-recover-1', conversationId: 'conversation-recover-1', status: 'running' });
  store.upsertRun({
    runId: 'run-recover-1',
    turnId: 'turn-recover-1',
    conversationId: 'conversation-recover-1',
    status: 'running',
    planRevision: 1,
    checkpoint: { boundary: 'task.started', nodeId: 'profile' },
  });
  store.upsertRunNode({
    runId: 'run-recover-1', nodeId: 'profile', status: 'running', attemptCount: 1,
    kind: 'dataset.profile', input: { rows: [{ score: 1 }] },
  });
  store.recordNodeAttempt({
    runId: 'run-recover-1', nodeId: 'profile', attempt: 1, status: 'running',
    input: { rows: [{ score: 1 }] },
  });
  const filePath = store.filePath;
  store.close();

  store = createCopilotProductionStore({ filePath });
  const coordinator = createRunCoordinator({ store });
  const recovered = coordinator.getState('run-recover-1');

  assert.deepEqual(coordinator.recoveredRunIds, ['run-recover-1']);
  assert.equal(recovered.run.status, 'paused');
  assert.equal(recovered.run.checkpoint.resumable, true);
  assert.equal(recovered.run.checkpoint.boundary, 'process_recovered');
  assert.equal(recovered.nodes[0].status, 'pending');
  assert.equal(recovered.attempts[0].status, 'failed');
  assert.equal(recovered.attempts[0].error.code, 'RUN_INTERRUPTED');
  assert.equal(recovered.turn.status, 'paused');

  const resumed = await coordinator.resume('run-recover-1', { executeTask: async () => ({ rowCount: 1 }) });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.nodes[0].attemptCount, 2);
});
