import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { DataCopilotStore, resolveCopilotConversationDirectory } from './data-copilot-store.mjs';

const REFERENCE = Object.freeze({
  jobId: 'job-approval-001',
  snapshotId: 'snapshot-001',
  mode: 'execution',
  scope: { type: 'selected_posts', postIds: ['post-1'] },
  conversationId: 'conversation-approval-001',
});

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-approval-store-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function initialize(rootDir, reference = REFERENCE) {
  const conversations = new DataCopilotStore({ rootDir });
  await conversations.createConversation({
    ...reference,
    idempotencyKey: `create-${reference.jobId}-${reference.snapshotId}-${reference.mode}`.slice(0, 160),
  });
}

function request(overrides = {}) {
  return {
    approvalId: 'approval-001',
    idempotencyKey: 'approval-create-001',
    runId: 'run-001',
    toolRunId: 'tool-run-001',
    toolName: 'export_audience_report',
    riskLevel: 'high',
    summary: 'Export the selected audience report.',
    arguments: { postIds: ['post-1'], format: 'xlsx' },
    ...overrides,
  };
}

test('approval state machine is revisioned, idempotent, and single-consumption', async (t) => {
  const rootDir = await fixture(t);
  await initialize(rootDir);
  const store = new CopilotApprovalStore({ rootDir });
  const pending = await store.createApproval(REFERENCE, request());
  assert.equal(pending.status, 'pending');
  assert.equal(pending.revision, 1);

  await assert.rejects(
    store.consume(REFERENCE, pending.approvalId, { idempotencyKey: 'consume-before-approval-001' }),
    (error) => error.code === 'COPILOT_APPROVAL_TRANSITION_INVALID',
  );
  const approved = await store.approve(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-decision-approve-001',
    expectedRevision: pending.revision,
    actor: 'user-001',
    reason: 'Reviewed in the conversation.',
  });
  const retried = await store.approve(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-decision-approve-001',
    expectedRevision: pending.revision,
    actor: 'user-001',
    reason: 'Reviewed in the conversation.',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(retried.revision, approved.revision);
  assert.equal(retried.transitions.length, 1);
  await assert.rejects(
    store.approve(REFERENCE, pending.approvalId, {
      idempotencyKey: 'approval-decision-approve-001', actor: 'different-user', reason: 'Different operation.',
    }),
    (error) => error.code === 'COPILOT_APPROVAL_IDEMPOTENCY_CONFLICT',
  );

  const consumed = await store.consume(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-consume-001', expectedRevision: approved.revision, actor: 'tool-runtime',
  });
  assert.equal(consumed.status, 'consumed');
  assert.ok(consumed.consumedAt);
  await assert.rejects(
    store.reject(REFERENCE, pending.approvalId, { idempotencyKey: 'approval-reject-after-consume-001' }),
    (error) => error.code === 'COPILOT_APPROVAL_TRANSITION_INVALID',
  );
});

test('approval creation is idempotent across generated IDs and concurrent retries', async (t) => {
  const rootDir = await fixture(t);
  await initialize(rootDir);
  let sequence = 0;
  const store = new CopilotApprovalStore({ rootDir, idFactory: () => `generated-approval-${++sequence}` });
  const value = request({ approvalId: undefined, idempotencyKey: 'approval-generated-retry-001' });
  const [first, retry] = await Promise.all([
    store.createApproval(REFERENCE, value),
    store.createApproval(REFERENCE, value),
  ]);
  assert.equal(first.approvalId, retry.approvalId);
  assert.equal((await store.listApprovals(REFERENCE)).length, 1);
  await assert.rejects(
    store.createApproval(REFERENCE, { ...value, summary: 'A different approval request.' }),
    (error) => error.code === 'COPILOT_APPROVAL_CONFLICT',
  );
});

test('an expired approval is atomically persisted before approve returns an expiry error', async (t) => {
  const rootDir = await fixture(t);
  let now = new Date('2026-08-02T00:00:00.000Z');
  await initialize(rootDir);
  const store = new CopilotApprovalStore({ rootDir, now: () => now });
  const pending = await store.createApproval(REFERENCE, request({
    expiresAt: '2026-08-02T00:01:00.000Z',
  }));
  now = new Date('2026-08-02T00:02:00.000Z');
  await assert.rejects(
    store.approve(REFERENCE, pending.approvalId, { idempotencyKey: 'approval-late-approve-001' }),
    (error) => error.code === 'COPILOT_APPROVAL_EXPIRED' && error.approval.status === 'expired',
  );
  const persisted = await store.getApproval(REFERENCE, pending.approvalId);
  assert.equal(persisted.status, 'expired');
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.transitions[0].action, 'expire');
});

test('approval records remain isolated by snapshot, mode, and scope', async (t) => {
  const rootDir = await fixture(t);
  const references = [
    REFERENCE,
    { ...REFERENCE, conversationId: 'conversation-approval-002', snapshotId: 'snapshot-002' },
    { ...REFERENCE, conversationId: 'conversation-approval-003', mode: 'review' },
    { ...REFERENCE, conversationId: 'conversation-approval-004', scope: { type: 'selected_posts', postIds: ['post-2'] } },
  ];
  const store = new CopilotApprovalStore({ rootDir });
  for (const [index, reference] of references.entries()) {
    await initialize(rootDir, reference);
    await store.createApproval(reference, request({
      idempotencyKey: `approval-create-isolated-${index}`,
      summary: `Approval ${index}`,
    }));
  }
  for (const [index, reference] of references.entries()) {
    const approvals = await store.listApprovals(reference);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].summary, `Approval ${index}`);
  }
});

test('approval transitions reject stale revisions and persist without path leakage', async (t) => {
  const rootDir = await fixture(t);
  await initialize(rootDir);
  const store = new CopilotApprovalStore({ rootDir });
  const pending = await store.createApproval(REFERENCE, request());
  const rejected = await store.reject(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-reject-001', expectedRevision: pending.revision, actor: 'user-001', reason: 'Not approved.',
  });
  await assert.rejects(
    store.cancel(REFERENCE, pending.approvalId, {
      idempotencyKey: 'approval-cancel-stale-001', expectedRevision: pending.revision,
    }),
    (error) => error.code === 'COPILOT_APPROVAL_REVISION_CONFLICT'
      && error.expectedRevision === pending.revision
      && error.actualRevision === rejected.revision,
  );
  const filePath = path.join(resolveCopilotConversationDirectory(rootDir, REFERENCE), 'approvals', `${pending.approvalId}.json`);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes(rootDir), false);
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('approval consumption is compare-and-set against the exact request hash', async (t) => {
  const rootDir = await fixture(t);
  await initialize(rootDir);
  const store = new CopilotApprovalStore({ rootDir });
  const pending = await store.createApproval(REFERENCE, request());
  const approved = await store.approve(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-hash-approve-001',
    expectedRevision: pending.revision,
    expectedRequestHash: pending.requestHash,
    actor: 'user-001',
  });
  await assert.rejects(
    store.consume(REFERENCE, pending.approvalId, {
      idempotencyKey: 'approval-hash-consume-stale-001',
      expectedRevision: approved.revision,
      expectedRequestHash: '0'.repeat(64),
      actor: 'runtime',
    }),
    (error) => error.code === 'COPILOT_APPROVAL_REQUEST_MISMATCH',
  );
  const consumed = await store.consume(REFERENCE, pending.approvalId, {
    idempotencyKey: 'approval-hash-consume-001',
    expectedRevision: approved.revision,
    expectedRequestHash: pending.requestHash,
    actor: 'runtime',
  });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.transitions.at(-1).expectedRequestHash, pending.requestHash);
});
