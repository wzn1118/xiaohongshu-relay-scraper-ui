import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexHostCommandService } from './codex-host-command-service.mjs';

function workerResult(value) {
  return { accepted: true, messages: [{ response: { result: { type: 'ok', value } } }] };
}

test('workflow snapshot and diff stay linked to the selected workspace', async () => {
  const calls = [];
  const service = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    workerService: { handleMessage: async (_worker, message) => { calls.push(message.request); return workerResult(message.request.method === 'review-summary' ? { source: 'uncommitted', snapshotGeneration: 7, files: [{ path: 'src/app.js', additions: 2, deletions: 1, changeKind: 'modified' }] } : { diffs: { 'src/app.js': '+new line' } }); }, capabilities: () => ({}), status: () => ({}) },
  });
  const snapshot = await service.workflow({ action: 'snapshot', cwd: 'C:\\workspace', threadId: 'thread-a', turnId: 'turn-a' });
  assert.equal(snapshot.snapshotGeneration, 7);
  assert.deepEqual(snapshot.linkage, { threadId: 'thread-a', turnId: 'turn-a' });
  const diff = await service.workflow({ action: 'diff', cwd: 'C:\\workspace', files: snapshot.files, snapshotGeneration: 7 });
  assert.equal(diff.diffs['src/app.js'], '+new line');
  assert.deepEqual(calls.map((request) => request.method), ['review-summary', 'review-diff']);
  assert.equal(calls[1].params.snapshotGeneration, 7);
});

test('workflow mutations require explicit confirmation and map to safe worker actions', async () => {
  const calls = [];
  const service = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    workerService: { handleMessage: async (_worker, message) => { calls.push(message.request); return workerResult({ status: 'success' }); }, capabilities: () => ({}), status: () => ({}) },
  });
  await assert.rejects(service.workflow({ action: 'rollback', cwd: 'C:\\workspace', files: [{ path: 'a.txt' }] }), (error) => error.code === 'CODEX_WORKFLOW_CONFIRMATION_REQUIRED');
  const applied = await service.workflow({ action: 'apply', cwd: 'C:\\workspace', files: [{ path: 'a.txt' }], snapshotGeneration: 3, confirm: true, commandId: 'apply-1' });
  assert.equal(applied.action, 'apply');
  assert.equal(calls[0].method, 'apply-review-section-changes');
  assert.equal(calls[0].params.action, 'stage');
  assert.equal(calls[0].params.snapshotGeneration, 3);
});
