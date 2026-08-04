import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { CopilotArtifactService } from './copilot-artifact-service.mjs';
import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { runGoldenEvaluation } from './copilot/evaluation-suite.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { DataPolicyEngine } from './data-policy-engine.mjs';

test('production store uses WAL and keeps immutable snapshot manifests with structural diff', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-production-store-'));
  const store = createCopilotProductionStore({ rootDir });
  t.after(async () => { store.close(); await rm(rootDir, { recursive: true, force: true }); });

  assert.equal(store.describe().journalMode, 'wal');
  const first = store.upsertSnapshot({ jobId: 'job-1', snapshotId: 'job-r1', revision: 1, manifest: { counts: { posts: 2 }, status: 'running' } });
  const duplicate = store.upsertSnapshot({ jobId: 'job-1', snapshotId: 'job-r1', revision: 1, manifest: { counts: { posts: 99 } } });
  store.upsertSnapshot({ jobId: 'job-1', snapshotId: 'job-r2', revision: 2, manifest: { counts: { posts: 5 }, status: 'done' } });

  assert.equal(first.manifest.counts.posts, 2);
  assert.equal(duplicate.manifest.counts.posts, 2);
  const diff = store.diffSnapshots({ jobId: 'job-1', fromSnapshotId: 'job-r1', toSnapshotId: 'job-r2' });
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.changes.map((change) => change.path), ['counts.posts', 'status']);

  store.recordUsage({ conversationId: 'conversation-1', inputTokens: 10, outputTokens: 4, toolCalls: 2, latencyMs: 20, estimatedCostUsd: 0.01 });
  assert.deepEqual(store.summarizeUsage({ conversationId: 'conversation-1' }), {
    records: 1, inputTokens: 10, outputTokens: 4, toolCalls: 2, latencyMs: 20, estimatedCostUsd: 0.01,
  });
  store.recordTrace({ conversationId: 'conversation-1', operation: 'test.trace', status: 'completed', payload: { ok: true } });
  assert.equal(store.listTraces({ conversationId: 'conversation-1' })[0].payload.ok, true);
  assert.equal(store.acquireLease({ leaseKey: 'eval', ownerId: 'worker-a' }).acquired, true);
  assert.equal(store.acquireLease({ leaseKey: 'eval', ownerId: 'worker-b' }).acquired, false);
});

test('service persists snapshots, migrates explicitly, creates verified artifacts, and stores golden evaluation', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-production-service-'));
  const outputDir = path.join(rootDir, 'job-output');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'records.json'), '[{"id":1}]\n', 'utf8');
  const job = { id: 'job-production-1', revision: 1, keyword: 'Product analysis', status: 'running', progress: 40, discoveredCount: 2, outputDir };
  const manager = { getInternal: (id) => id === job.id ? job : null, get: (id) => id === job.id ? job : null, list: () => [job] };
  const store = new DataCopilotStore({ rootDir });
  const approvals = new CopilotApprovalStore({ rootDir });
  const artifacts = new CopilotArtifactService({ rootDir });
  const productionStore = createCopilotProductionStore({ rootDir });
  const runtime = { emit: () => {}, registry: { list: () => [] } };
  const service = new DataCopilotService({
    rootDir, store, approvals, artifacts, productionStore, runtime,
    policy: new DataPolicyEngine({ manager }), manager,
  });
  t.after(async () => { productionStore.close(); await rm(rootDir, { recursive: true, force: true }); });
  await service.initialize();

  const created = await service.createConversation({ jobId: job.id, mode: 'research', idempotencyKey: 'create-production-conversation' });
  assert.equal(created.snapshot.snapshotId, 'job-r1');
  assert.equal(created.snapshot.manifest.artifacts[0].relativePath, 'records.json');

  job.revision = 2;
  job.status = 'completed';
  job.progress = 100;
  job.discoveredCount = 5;
  const upgraded = await service.upgradeConversationSnapshot(created.conversation.conversationId, { copyMessages: false });
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.conversation.snapshotId, 'job-r2');
  assert.equal(upgraded.diff.changes.some((change) => change.path === 'counts.posts'), true);

  const artifact = await service.createArtifact(upgraded.conversation.conversationId, {
    format: 'markdown', name: 'analysis.md', content: '# Analysis\n\nVerified output.\n',
  });
  assert.equal(artifact.verification.passed, true);
  const resolved = await service.resolveArtifact(upgraded.conversation.conversationId, artifact.artifact.artifactId);
  assert.match(await readFile(resolved.absolutePath, 'utf8'), /Verified output/);

  const evaluation = await service.runGoldenEvaluation();
  assert.deepEqual(evaluation.summary, { total: 30, passed: 30, failed: 0, passRate: 1 });
  assert.equal(service.listEvaluations({}).evaluations[0].evaluationId, evaluation.evaluationId);
  assert.equal(service.getUsage({ conversationId: upgraded.conversation.conversationId }).toolCalls, 1);
});

test('golden task catalog remains exactly 30 executable checks', async () => {
  const result = await runGoldenEvaluation();
  assert.equal(result.summary.total, 30);
  assert.equal(result.summary.passed, 30);
  assert.equal(result.status, 'passed');
});
