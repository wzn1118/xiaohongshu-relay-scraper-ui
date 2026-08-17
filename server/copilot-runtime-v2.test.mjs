import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { createRunCoordinator } from './copilot/run-coordinator.mjs';

test('schema v4 migrates a v3 MCP database in place and binds existing Grants to snapshot hashes', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-migration-v2-'));
  const filePath = path.join(rootDir, 'copilot', 'copilot-state.sqlite');
  await mkdir(path.dirname(filePath), { recursive: true });
  const legacy = new DatabaseSync(filePath);
  const manifest = JSON.stringify({ count: 3 });
  const manifestHash = crypto.createHash('sha256').update(manifest).digest('hex');
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 'legacy-production-state', '2026-01-01T00:00:00.000Z');
    INSERT INTO schema_migrations VALUES (2, 'durable-agent-runtime', '2026-01-01T00:00:00.000Z');
    INSERT INTO schema_migrations VALUES (3, 'mcp-access-plane', '2026-01-01T00:00:00.000Z');
    CREATE TABLE snapshots (
      job_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, revision INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (job_id, snapshot_id)
    );
    CREATE TABLE mcp_grants (
      grant_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
      conversation_id TEXT NOT NULL, job_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      mode TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]',
      allowed_tools_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT '',
      last_used_at TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  legacy.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('job-1', 'job-r1', 1, manifest, manifestHash, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.prepare('INSERT INTO mcp_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('grant-1', 'hash-1', 'owner-1', 'conversation-1', 'job-1', 'job-r1', 'application', '[]', '[]', 'active', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '', '', '{}');
  legacy.close();

  let store = createCopilotProductionStore({ filePath });
  t.after(async () => { store?.close(); await rm(rootDir, { recursive: true, force: true }); });
  assert.equal(store.describe().schemaVersion, 4);
    assert.equal(store.getSnapshot('job-1', 'job-r1').manifest.count, 3);
    assert.equal(store.getMcpGrant('grant-1').manifestHash, manifestHash);
    assert.deepEqual(store.getMcpGrant('grant-1').allowedResources, []);
    const toolRunColumns = store.database.prepare('PRAGMA table_info(mcp_tool_runs)').all()
      .map((column) => column.name);
    assert.equal(toolRunColumns.includes('action_hash'), true);
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
