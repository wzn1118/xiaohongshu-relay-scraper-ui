import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';

import {
  DataCopilotStore,
  resolveCopilotConversationDirectory,
} from './data-copilot-store.mjs';

const REFERENCE = Object.freeze({
  jobId: 'job-20260802',
  snapshotId: 'snapshot-001',
  mode: 'analysis',
  scope: { type: 'audience', postIds: ['post-1'] },
  conversationId: 'conversation-001',
});

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-store-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function create(store, reference = REFERENCE, idempotencyKey = 'create-conversation-001') {
  return store.createConversation({ ...reference, title: 'Audience analysis', idempotencyKey });
}

test('conversation storage isolates job, snapshot, mode, and scope dimensions', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  const references = [
    REFERENCE,
    { ...REFERENCE, conversationId: 'conversation-002', jobId: 'job-20260803' },
    { ...REFERENCE, conversationId: 'conversation-003', snapshotId: 'snapshot-002' },
    { ...REFERENCE, conversationId: 'conversation-004', mode: 'execution' },
    { ...REFERENCE, conversationId: 'conversation-005', scope: { type: 'audience', postIds: ['post-2'] } },
  ];
  for (const [index, reference] of references.entries()) {
    await create(store, reference, `create-isolated-${index}`);
    await store.appendMessage(reference, {
      idempotencyKey: `message-isolated-${index}`,
      role: 'user',
      content: `message ${index}`,
    });
  }

  const directories = references.map((reference) => resolveCopilotConversationDirectory(rootDir, reference));
  assert.equal(new Set(directories).size, references.length);
  for (const [index, reference] of references.entries()) {
    assert.deepEqual((await store.listMessages(reference)).map((item) => item.content), [`message ${index}`]);
  }
});

test('generated conversation identity is stable for idempotent create retries', async (t) => {
  const rootDir = await fixture(t);
  let generated = 0;
  const store = new DataCopilotStore({ rootDir, idFactory: () => `generated-${++generated}` });
  const input = {
    jobId: REFERENCE.jobId,
    snapshotId: REFERENCE.snapshotId,
    mode: REFERENCE.mode,
    scope: REFERENCE.scope,
    title: 'Stable identity',
    idempotencyKey: 'stable-create-request-001',
  };
  const [first, second] = await Promise.all([
    store.createConversation(input),
    store.createConversation(input),
  ]);
  assert.equal(first.conversationId, second.conversationId);
  assert.match(first.conversationId, /^copilot-[a-f0-9]{32}$/u);
});

test('message and tool-run JSONL appends are atomic and idempotent under concurrent retry', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  await create(store);
  const message = {
    idempotencyKey: 'message-concurrent-001',
    role: 'user',
    content: 'Compare the collected comments.',
    attachments: [{ attachmentId: 'attachment-001', name: 'comments.json', mediaType: 'application/json', size: 42 }],
  };
  const [first, retry] = await Promise.all([
    store.appendMessage(REFERENCE, message),
    store.appendMessage(REFERENCE, message),
  ]);
  assert.equal(first.messageId, retry.messageId);
  assert.equal((await store.listMessages(REFERENCE)).length, 1);

  await assert.rejects(
    store.appendMessage(REFERENCE, { ...message, content: 'Different content.' }),
    (error) => error.code === 'COPILOT_IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    store.appendMessage(REFERENCE, {
      idempotencyKey: 'message-path-forbidden-001',
      role: 'user',
      content: 'Read this path.',
      attachments: [{ attachmentId: 'attachment-001', absolutePath: 'C:\\private\\file.txt' }],
    }),
    (error) => error.code === 'COPILOT_ATTACHMENT_PATH_FORBIDDEN',
  );

  const toolRun = {
    idempotencyKey: 'tool-run-concurrent-001',
    toolRunId: 'tool-run-001',
    runId: 'run-001',
    toolName: 'query_comments',
    status: 'succeeded',
    input: { postId: 'post-1' },
    output: { count: 12 },
  };
  await Promise.all([
    store.appendToolRun(REFERENCE, toolRun),
    store.appendToolRun(REFERENCE, toolRun),
  ]);
  assert.equal((await store.listToolRuns(REFERENCE)).length, 1);

  const directory = resolveCopilotConversationDirectory(rootDir, REFERENCE);
  const lines = (await readFile(path.join(directory, 'messages.jsonl'), 'utf8')).trim().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('run state persists cancellation checkpoints and resumes in a fresh store instance', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  await create(store);
  await store.appendRun(REFERENCE, {
    idempotencyKey: 'run-started-001', runId: 'run-001', status: 'running', attempt: 1,
  });
  await store.requestCancellation(REFERENCE, {
    idempotencyKey: 'run-cancel-request-001', runId: 'run-001', attempt: 1,
  });
  await store.appendRun(REFERENCE, {
    idempotencyKey: 'run-cancelled-001',
    runId: 'run-001',
    status: 'cancelled',
    attempt: 1,
    recoverable: true,
    checkpoint: { cursor: 'comment-page-3', completedToolRunIds: ['tool-run-001'] },
    stopReason: 'user_cancelled',
  });

  const cancelled = await store.getConversation(REFERENCE);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.runState.resumable, true);
  assert.equal(cancelled.runState.resumeFromRunId, 'run-001');
  assert.equal(cancelled.runState.checkpoint.cursor, 'comment-page-3');
  assert.ok(cancelled.runState.cancelRequestedAt);
  assert.ok(cancelled.runState.cancelledAt);

  const restored = new DataCopilotStore({ rootDir });
  await restored.beginResume(REFERENCE, {
    idempotencyKey: 'run-resumed-002',
    runId: 'run-002',
    resumeFromRunId: 'run-001',
    attempt: 2,
    checkpoint: cancelled.runState.checkpoint,
  });
  const resumed = await restored.getConversation(REFERENCE);
  assert.equal(resumed.status, 'executing');
  assert.equal(resumed.runState.currentRunId, 'run-002');
  assert.equal(resumed.runState.resumeFromRunId, 'run-001');
  assert.equal(resumed.runState.attempt, 2);
  assert.equal((await restored.listRuns(REFERENCE)).length, 4);
});

test('retrying an older run event never rewinds the projected conversation state', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  await create(store);
  const running = {
    idempotencyKey: 'run-no-rewind-running-001', runId: 'run-no-rewind-001', status: 'running', attempt: 1,
  };
  await store.appendRun(REFERENCE, running);
  await store.appendRun(REFERENCE, {
    idempotencyKey: 'run-no-rewind-complete-001', runId: 'run-no-rewind-001', status: 'completed', attempt: 1,
  });

  await store.appendRun(REFERENCE, running);
  const conversation = await store.getConversation(REFERENCE);
  assert.equal(conversation.status, 'completed');
  assert.equal(conversation.runState.status, 'completed');
  assert.equal(conversation.lastSequences.runs, 2);
  assert.equal((await store.listRuns(REFERENCE)).length, 2);
});

test('cancellation atomically refuses to overwrite a terminal run state', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  await create(store);
  await store.appendRun(REFERENCE, {
    idempotencyKey: 'run-terminal-cancel-running-001',
    runId: 'run-terminal-cancel-001',
    status: 'running',
    attempt: 1,
  });
  await store.appendRun(REFERENCE, {
    idempotencyKey: 'run-terminal-cancel-completed-001',
    runId: 'run-terminal-cancel-001',
    status: 'completed',
    attempt: 1,
  });

  const cancellation = await store.requestCancellation(REFERENCE, {
    idempotencyKey: 'run-terminal-cancel-request-001',
    runId: 'run-terminal-cancel-001',
    attempt: 1,
  });

  assert.equal(cancellation, null);
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');
  assert.deepEqual(
    (await store.listRuns(REFERENCE)).map((record) => record.status),
    ['running', 'completed'],
  );
});

test('an old lock owned by a live process is not reclaimed by age alone', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  await create(store);
  const directory = resolveCopilotConversationDirectory(rootDir, REFERENCE);
  const lockPath = path.join(directory, '.store.lock');
  const old = new Date(Date.now() - (10 * 60_000));
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: 'live-owner-token-001',
    createdAt: old.toISOString(),
  })}\n`, 'utf8');
  await utimes(lockPath, old, old);

  let settled = false;
  const append = store.appendMessage(REFERENCE, {
    idempotencyKey: 'message-live-lock-001', role: 'user', content: 'Wait for the active owner.',
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'live-owner-token-001');
  await rm(lockPath, { force: true });
  await append;
});

test('conversation updates reject stale revisions and persisted identity mismatches', async (t) => {
  const rootDir = await fixture(t);
  const store = new DataCopilotStore({ rootDir });
  const created = await create(store);
  const updated = await store.updateConversation(REFERENCE, { title: 'Updated title' }, { expectedRevision: created.revision });
  assert.equal(updated.revision, created.revision + 1);
  await assert.rejects(
    store.updateConversation(REFERENCE, { title: 'Stale title' }, { expectedRevision: created.revision }),
    (error) => error.code === 'COPILOT_REVISION_CONFLICT'
      && error.expectedRevision === created.revision
      && error.actualRevision === updated.revision,
  );
  await assert.rejects(
    store.getConversation({ ...REFERENCE, scope: { type: 'audience', postIds: ['different'] } }),
    (error) => error.code === 'COPILOT_SCOPE_MISMATCH',
  );
  await assert.rejects(
    create(store, { ...REFERENCE, jobId: 'job:invalid-on-windows' }, 'create-invalid-path-id-001'),
    (error) => error.code === 'COPILOT_ID_INVALID',
  );
});
