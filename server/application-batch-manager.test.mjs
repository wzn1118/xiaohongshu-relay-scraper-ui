import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ApplicationBatchManager } from './application-batch-manager.mjs';

const T1 = '2026-08-03T01:00:00.000Z';
const T2 = '2026-08-03T02:00:00.000Z';

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'application-batches-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const clock = { value: options.now || T1 };
  const manager = new ApplicationBatchManager({
    rootDir,
    now: () => new Date(clock.value),
    idFactory: options.idFactory || (() => 'batch-generated'),
  });
  await manager.initialize();
  return { rootDir, manager, clock };
}

function readyItem(overrides = {}) {
  return {
    itemId: 'note-001',
    noteId: 'note-001',
    contactCandidateId: 'contact-001',
    status: 'ready',
    payload: {
      recipient: 'jobs@example.com',
      draftHash: 'draft-hash',
      attachmentBundleHash: 'attachment-hash',
      filename: 'candidate-product-manager.pdf',
    },
    ...overrides,
  };
}

async function createReady(manager, overrides = {}) {
  return manager.createBatch({
    batchId: overrides.batchId || 'batch-001',
    jobId: overrides.jobId || 'job-001',
    title: 'Product applications',
    settings: { smtpRevision: 3 },
    items: overrides.items || [readyItem()],
  });
}

test('creates atomic batch and item JSON under artifacts/application-batches and survives reopen', async (t) => {
  const { rootDir, manager } = await fixture(t);
  const created = await manager.createBatch({
    batchId: 'batch-001',
    jobId: 'job-001',
    title: 'Applications',
    items: [
      { itemId: 'note-001', noteId: 'note-001', status: 'resolving', payload: { role: 'PM' } },
      readyItem({ itemId: 'note-002', noteId: 'note-002' }),
    ],
  });

  assert.equal(created.status, 'draft');
  assert.equal(created.revision, 1);
  assert.equal(created.items.length, 2);
  assert.equal(created.counts.resolving, 1);
  assert.equal(created.counts.ready, 1);

  const directory = path.join(rootDir, 'artifacts', 'application-batches', 'batch-001');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'batch.json'), 'utf8')).batchId, 'batch-001');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'items', 'note-001.json'), 'utf8')).noteId, 'note-001');
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), []);

  const reopened = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const loaded = await reopened.getBatch('batch-001');
  assert.deepEqual(loaded, created);
  assert.deepEqual((await reopened.listBatches({ jobId: 'job-001' })).map((batch) => batch.batchId), ['batch-001']);
});

test('historical batches remain readable without newly added zero-count status keys', async (t) => {
  const { rootDir, manager } = await fixture(t);
  await createReady(manager, { batchId: 'batch-historical-statuses' });
  const batchPath = path.join(rootDir, 'artifacts', 'application-batches', 'batch-historical-statuses', 'batch.json');
  const historical = JSON.parse(await readFile(batchPath, 'utf8'));
  delete historical.counts.subject_pending;
  delete historical.counts.copy_quality_failed;
  await writeFile(batchPath, JSON.stringify(historical, null, 2), 'utf8');

  const reopened = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const loaded = await reopened.getBatch('batch-historical-statuses');

  assert.equal(loaded.batchId, 'batch-historical-statuses');
  assert.equal(loaded.items[0].status, 'ready');
});

test('item lifecycle is revision guarded and derives batch readiness', async (t) => {
  const { manager } = await fixture(t);
  let batch = await manager.createBatch({
    batchId: 'batch-lifecycle',
    jobId: 'job-001',
    items: [{ itemId: 'note-001', noteId: 'note-001' }],
  });

  const steps = ['subject_pending', 'copy_quality_failed', 'draft_pending', 'quality_pending', 'filename_pending', 'ready'];
  for (const status of steps) {
    batch = await manager.updateItem('batch-lifecycle', 'note-001', { status }, {
      expectedBatchRevision: batch.revision,
      expectedItemRevision: batch.items[0].revision,
    });
  }
  assert.equal(batch.status, 'ready');
  assert.equal(batch.items[0].status, 'ready');
  assert.equal(batch.revision, 7);

  await assert.rejects(
    manager.updateItem('batch-lifecycle', 'note-001', { payload: { changed: true } }, { expectedBatchRevision: 1 }),
    { code: 'APPLICATION_BATCH_REVISION_CONFLICT', status: 409 },
  );
  await assert.rejects(
    manager.updateItem('batch-lifecycle', 'note-001', { status: 'sent' }),
    { code: 'APPLICATION_BATCH_ITEM_TRANSITION_INVALID', status: 409 },
  );
});

test('subject and copy quality blockers are valid persisted initial states', async (t) => {
  const { manager } = await fixture(t);
  const batch = await manager.createBatch({
    batchId: 'batch-copy-blockers',
    jobId: 'job-001',
    items: [
      { itemId: 'subject-note', noteId: 'subject-note', status: 'subject_pending' },
      { itemId: 'copy-note', noteId: 'copy-note', status: 'copy_quality_failed' },
    ],
  });

  assert.equal(batch.counts.subject_pending, 1);
  assert.equal(batch.counts.copy_quality_failed, 1);
  assert.equal(batch.status, 'draft');
});

test('approval binds an explicit revision and immutable payload, then pause and resume retain it', async (t) => {
  const { manager } = await fixture(t);
  let batch = await createReady(manager, { batchId: 'batch-approved' });

  await assert.rejects(
    manager.approveBatch('batch-approved', { expectedRevision: batch.revision + 1 }),
    { code: 'APPLICATION_BATCH_REVISION_CONFLICT', status: 409 },
  );

  batch = await manager.approveBatch('batch-approved', {
    expectedRevision: batch.revision,
    actor: 'candidate',
    reason: 'preview reviewed',
  });
  assert.equal(batch.status, 'approved');
  assert.equal(batch.approval.revision, 1);
  assert.equal(batch.approval.batchRevision, batch.revision);
  assert.match(batch.approval.snapshotHash, /^[a-f0-9]{64}$/);

  await assert.rejects(
    manager.updateItem('batch-approved', 'note-001', { payload: { recipient: 'changed@example.com' } }),
    { code: 'APPLICATION_BATCH_IMMUTABLE', status: 409 },
  );

  batch = await manager.resumeBatch('batch-approved', { expectedRevision: batch.revision });
  assert.equal(batch.status, 'running');
  batch = await manager.pauseBatch('batch-approved', { expectedRevision: batch.revision });
  assert.equal(batch.status, 'paused');
  batch = await manager.resumeBatch('batch-approved', { expectedRevision: batch.revision });
  assert.equal(batch.status, 'running');
  assert.equal(batch.approval.revision, 1);
});

test('sending revalidates approval under the batch lock after an on-disk payload edit', async (t) => {
  const { rootDir, manager } = await fixture(t);
  let batch = await createReady(manager, { batchId: 'batch-tampered' });
  batch = await manager.approveBatch('batch-tampered', { expectedRevision: batch.revision });
  batch = await manager.resumeBatch('batch-tampered', { expectedRevision: batch.revision });

  const itemPath = path.join(rootDir, 'artifacts', 'application-batches', 'batch-tampered', 'items', 'note-001.json');
  const tampered = JSON.parse(await readFile(itemPath, 'utf8'));
  tampered.payload.recipient = 'redirected@example.net';
  await writeFile(itemPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  await assert.rejects(
    manager.updateItem('batch-tampered', 'note-001', { status: 'sending' }, {
      expectedBatchRevision: batch.revision,
      expectedItemRevision: batch.items[0].revision,
    }),
    { code: 'APPLICATION_BATCH_APPROVAL_STALE', status: 409 },
  );
  const unchanged = await manager.getBatch('batch-tampered');
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.items[0].status, 'ready');
  assert.equal(unchanged.revision, batch.revision);
});

test('cancel keeps sent items, skips unsent items, and makes in-flight delivery unknown', async (t) => {
  const { manager } = await fixture(t);
  let batch = await createReady(manager, {
    batchId: 'batch-cancel',
    items: [
      readyItem({ itemId: 'note-ready', noteId: 'note-ready' }),
      readyItem({ itemId: 'note-flight', noteId: 'note-flight' }),
      readyItem({ itemId: 'note-sent', noteId: 'note-sent' }),
    ],
  });
  batch = await manager.approveBatch('batch-cancel', { expectedRevision: batch.revision });
  batch = await manager.resumeBatch('batch-cancel', { expectedRevision: batch.revision });
  batch = await manager.updateItem('batch-cancel', 'note-flight', { status: 'sending' }, {
    expectedBatchRevision: batch.revision,
    expectedItemRevision: batch.items.find((item) => item.itemId === 'note-flight').revision,
  });
  batch = await manager.updateItem('batch-cancel', 'note-sent', { status: 'sending' });
  batch = await manager.updateItem('batch-cancel', 'note-sent', { status: 'sent' });
  batch = await manager.cancelBatch('batch-cancel', { expectedRevision: batch.revision, reason: 'user stop' });

  assert.equal(batch.status, 'cancelled');
  assert.equal(batch.items.find((item) => item.itemId === 'note-ready').status, 'skipped');
  assert.equal(batch.items.find((item) => item.itemId === 'note-flight').status, 'unknown_manual_review');
  assert.equal(batch.items.find((item) => item.itemId === 'note-sent').status, 'sent');
  assert.equal(batch.counts.unknown_manual_review, 1);
});

test('restart recovery converts sending to unknown exactly once and never retries it', async (t) => {
  const { rootDir, manager } = await fixture(t);
  let batch = await createReady(manager, { batchId: 'batch-restart' });
  batch = await manager.approveBatch('batch-restart', { expectedRevision: batch.revision });
  batch = await manager.resumeBatch('batch-restart', { expectedRevision: batch.revision });
  await manager.updateItem('batch-restart', 'note-001', { status: 'sending' }, {
    expectedBatchRevision: batch.revision,
    expectedItemRevision: batch.items[0].revision,
  });

  const restarted = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const recovered = await restarted.getBatch('batch-restart');
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.items[0].status, 'unknown_manual_review');
  assert.equal(recovered.items[0].error.code, 'DELIVERY_STATE_UNKNOWN_AFTER_RESTART');
  assert.equal(recovered.recoveryCount, 1);
  const recoveredRevision = recovered.revision;

  await assert.rejects(
    restarted.resumeBatch('batch-restart', { expectedRevision: recovered.revision }),
    { code: 'APPLICATION_BATCH_NO_SENDABLE_ITEMS', status: 409 },
  );

  const restartedAgain = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const stable = await restartedAgain.getBatch('batch-restart');
  assert.equal(stable.items[0].status, 'unknown_manual_review');
  assert.equal(stable.recoveryCount, 1);
  assert.equal(stable.revision, recoveredRevision);
  assert.equal((await restartedAgain.listEvents('batch-restart')).filter((event) => event.type === 'batch_recovered').length, 1);
});

test('initialize removes an uncommitted directory and still recovers committed batches', async (t) => {
  const { rootDir, manager } = await fixture(t);
  const created = await createReady(manager, { batchId: 'batch-committed' });
  const orphan = path.join(rootDir, 'artifacts', 'application-batches', 'batch-uncommitted');
  await mkdir(path.join(orphan, 'items'), { recursive: true });
  await writeFile(path.join(orphan, 'items', 'partial.json'), '{}\n', 'utf8');

  const restarted = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const batches = await restarted.listBatches();
  assert.deepEqual(batches.map((batch) => batch.batchId), ['batch-committed']);
  assert.deepEqual(batches[0], created);
  await assert.rejects(readdir(orphan), { code: 'ENOENT' });
});

test('restart treats a newer terminal item file as truth and completes a stale running batch', async (t) => {
  const { rootDir, manager } = await fixture(t);
  let batch = await createReady(manager, { batchId: 'batch-item-ahead' });
  batch = await manager.approveBatch('batch-item-ahead', { expectedRevision: batch.revision });
  batch = await manager.resumeBatch('batch-item-ahead', { expectedRevision: batch.revision });
  batch = await manager.updateItem('batch-item-ahead', 'note-001', { status: 'sending' }, {
    expectedBatchRevision: batch.revision,
    expectedItemRevision: batch.items[0].revision,
  });

  const itemPath = path.join(rootDir, 'artifacts', 'application-batches', 'batch-item-ahead', 'items', 'note-001.json');
  const item = JSON.parse(await readFile(itemPath, 'utf8'));
  item.status = 'sent';
  item.revision += 1;
  item.updatedAt = T2;
  await writeFile(itemPath, `${JSON.stringify(item, null, 2)}\n`, 'utf8');

  const restarted = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const recovered = await restarted.getBatch('batch-item-ahead');
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.items[0].status, 'sent');
  assert.equal(recovered.counts.sending, 0);
  assert.equal(recovered.counts.sent, 1);
  assert.equal(recovered.revision, batch.revision + 1);
  assert.equal(recovered.recoveryCount, 1);

  const recoveryEvents = (await restarted.listEvents('batch-item-ahead')).filter((event) => event.type === 'batch_recovered');
  assert.equal(recoveryEvents.length, 1);
  assert.equal(recoveryEvents[0].reason, 'batch_state_reconciled_after_restart');
  assert.equal(recoveryEvents[0].fromStatus, 'running');
  assert.equal(recoveryEvents[0].toStatus, 'completed');
  assert.deepEqual(recoveryEvents[0].recoveredItemIds, []);

  const restartedAgain = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const stable = await restartedAgain.getBatch('batch-item-ahead');
  assert.equal(stable.revision, recovered.revision);
  assert.equal(stable.recoveryCount, 1);
});

test('events are appended with monotonic sequences and are not rewritten', async (t) => {
  const { rootDir, manager } = await fixture(t);
  let batch = await manager.createBatch({
    batchId: 'batch-events',
    jobId: 'job-001',
    items: [{ itemId: 'note-001', noteId: 'note-001' }],
  });
  const eventPath = path.join(rootDir, 'artifacts', 'application-batches', 'batch-events', 'events.jsonl');
  const firstBytes = await readFile(eventPath, 'utf8');
  batch = await manager.updateItem('batch-events', 'note-001', { status: 'draft_pending' }, {
    expectedBatchRevision: batch.revision,
    expectedItemRevision: batch.items[0].revision,
  });
  const secondBytes = await readFile(eventPath, 'utf8');
  assert.equal(secondBytes.startsWith(firstBytes), true);
  const events = await manager.listEvents('batch-events');
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.type), ['batch_created', 'item_updated']);
  assert.deepEqual((await manager.listEvents('batch-events', { afterSequence: 1 })).map((event) => event.sequence), [2]);
});

test('restart repairs a committed state whose final audit append was interrupted', async (t) => {
  const { rootDir, manager } = await fixture(t);
  const created = await createReady(manager, { batchId: 'batch-event-repair' });
  const eventPath = path.join(rootDir, 'artifacts', 'application-batches', 'batch-event-repair', 'events.jsonl');
  await unlink(eventPath);

  const restarted = new ApplicationBatchManager({ rootDir, now: () => new Date(T2) });
  const stable = await restarted.getBatch('batch-event-repair');
  assert.equal(stable.revision, created.revision);
  assert.equal(stable.lastEventSequence, created.lastEventSequence);

  const events = await restarted.listEvents('batch-event-repair');
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, created.lastEventSequence);
  assert.equal(events[0].type, 'batch_recovered');
  assert.equal(events[0].reason, 'event_log_repaired_after_restart');
  assert.equal(events[0].missingAfterSequence, 0);
});

test('rejects path traversal and Windows device names for every path-bound identifier', async (t) => {
  const { rootDir, manager } = await fixture(t);
  const invalidIds = ['../escape', '..\\escape', '/absolute', 'C:escape', 'NUL', 'COM1', 'a/b'];
  for (const batchId of invalidIds) {
    await assert.rejects(
      manager.createBatch({ batchId, jobId: 'job-001', items: [readyItem()] }),
      { code: 'APPLICATION_BATCH_ID_INVALID' },
    );
    await assert.rejects(manager.getBatch(batchId), { code: 'APPLICATION_BATCH_ID_INVALID' });
  }
  await assert.rejects(
    manager.createBatch({ batchId: 'safe-batch', jobId: '../job', items: [readyItem()] }),
    { code: 'APPLICATION_BATCH_ID_INVALID' },
  );
  await assert.rejects(
    manager.createBatch({ batchId: 'safe-batch', jobId: 'job-001', items: [{ itemId: '../item', noteId: 'note-001' }] }),
    { code: 'APPLICATION_BATCH_ID_INVALID' },
  );
  await assert.rejects(
    manager.createBatch({ batchId: 'safe-batch', jobId: 'job-001', items: [{ itemId: 'item-001', noteId: '..\\note' }] }),
    { code: 'APPLICATION_BATCH_ID_INVALID' },
  );
  await assert.rejects(manager.updateItem('safe-batch', '../item', {}), { code: 'APPLICATION_BATCH_ID_INVALID' });
  await assert.rejects(readFile(path.join(rootDir, 'artifacts', 'escape', 'batch.json'), 'utf8'), { code: 'ENOENT' });
});
