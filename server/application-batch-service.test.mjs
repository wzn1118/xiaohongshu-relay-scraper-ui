import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createApp, createPersistentSmtpSendGate, streamApplicationBatchEvents } from './app.mjs';
import { ApplicationBatchManager } from './application-batch-manager.mjs';
import { ApplicationBatchService } from './application-batch-service.mjs';

const JOB_ID = '20260804120000-abcdef12';
const FIXED_TIME = '2026-08-04T04:00:00.000Z';

async function temporaryOutputDir(t, prefix = 'application-batch-service-') {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return outputDir;
}

async function writeAudience(outputDir, { posts = [], comments = [] } = {}) {
  await Promise.all([
    writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify(posts), 'utf8'),
    writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify(comments), 'utf8'),
  ]);
}

function readyRecord(noteId) {
  return {
    note_id: noteId,
    post_id: noteId,
    title: `Role ${noteId}`,
    body: 'Apply by email.',
    job_card: { role_name: `Role ${noteId}` },
    application_info: {
      contacts: [{
        type: 'email',
        channel: 'email',
        value: `${noteId}@example.com`,
        evidence: `Send the application to ${noteId}@example.com`,
        source_field: 'body',
        verification_status: 'body_verified',
        confidence: 100,
        actionable: true,
      }],
      application_routes: [],
    },
    outreach: {
      email_subject: `Subject ${noteId}`,
      email_body: `Body ${noteId}`,
    },
    draftVersion: {
      draftId: `draft-${noteId}`,
      version: 1,
      qualityStatus: 'passed',
      contentHash: 'b'.repeat(64),
    },
  };
}

function readyAttachment(noteId) {
  return {
    attachmentId: `attachment-${noteId}`,
    originalName: 'resume.pdf',
    displayName: 'resume.pdf',
    selected: true,
    status: 'ready',
    validationStatus: 'passed',
    sha256: 'a'.repeat(64),
    size: 1_024,
    mediaType: 'application/pdf',
  };
}

async function readyServiceFixture(t, {
  noteIds,
  sendEmail = async () => {},
} = {}) {
  const outputDir = await temporaryOutputDir(t);
  const records = new Map(noteIds.map((noteId) => [noteId, readyRecord(noteId)]));
  const attachments = new Map(noteIds.map((noteId) => [noteId, readyAttachment(noteId)]));
  const manager = new ApplicationBatchManager({
    rootDir: outputDir,
    now: () => new Date(FIXED_TIME),
  });
  await manager.initialize();

  const service = new ApplicationBatchService({
    jobId: JOB_ID,
    outputDir,
    manager,
    candidateProfile: { name: 'Candidate' },
    loadRecord: async (noteId) => structuredClone(records.get(noteId)),
    listAttachments: async (noteId) => ({ attachments: [structuredClone(attachments.get(noteId))] }),
    renameAttachment: async () => assert.fail('A matching deterministic filename must not be renamed.'),
    checkQuality: async () => assert.fail('A passed draft must not be quality-checked again.'),
    previewEmail: async (value, allowedRecipients) => {
      assert.deepEqual(allowedRecipients, [value.to]);
      return {
        readiness: 'ready',
        warnings: [],
        recipient: value.to,
        from: 'sender@example.com',
        replyTo: 'candidate@example.com',
        subject: `Subject ${value.noteId}`,
        text: `Body ${value.noteId}`,
        draftId: value.draftId,
        draftVersion: value.version,
        quality: { contentHash: 'b'.repeat(64), qualityReportRef: null },
        attachmentBundleHash: `bundle-${value.noteId}`,
        attachmentSummary: {
          attachments: [{
            attachmentId: `attachment-${value.noteId}`,
            filename: 'resume.pdf',
            sha256: 'a'.repeat(64),
            size: 1_024,
            mediaType: 'application/pdf',
          }],
        },
        previewRevision: `preview-${value.noteId}`,
        smtpConfigurationRevision: 7,
        smtpConfigurationFingerprint: 'smtp-fingerprint',
        estimatedMessageSize: 2_048,
      };
    },
    sendEmail,
    now: () => new Date(FIXED_TIME),
    sleep: async () => {},
  });

  return { outputDir, records, manager, service };
}

async function freezeAndApprove(service, noteIds) {
  const created = await service.createBatch({
    noteIds,
    defaultAttachmentTemplate: 'resume',
    minIntervalMs: 0,
  });
  const approved = await service.approveBatch(created.batch.batchId, {
    expectedRevision: created.batch.revision,
    actor: 'test-user',
  });
  return { created, approved };
}

test('dry run keeps partial comment collection pending instead of reporting no email', async (t) => {
  const outputDir = await temporaryOutputDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'partial-note', status: 'partial', collected_comment_count: 1 }],
    comments: [{ comment_id: 'comment-1', post_id: 'partial-note', text: 'Is this role still open?' }],
  });
  const manager = new ApplicationBatchManager({ rootDir: outputDir });
  await manager.initialize();
  const service = new ApplicationBatchService({
    jobId: JOB_ID,
    outputDir,
    manager,
    loadRecord: async () => ({
      note_id: 'partial-note',
      post_id: 'partial-note',
      title: 'Partial comments role',
      application_info: { contacts: [], application_routes: [] },
    }),
    listAttachments: async () => assert.fail('A blocked contact must stop before attachments.'),
    renameAttachment: async () => assert.fail('A blocked contact must not rename attachments.'),
    checkQuality: async () => assert.fail('A blocked contact must not run quality checks.'),
    previewEmail: async () => assert.fail('A blocked contact must not generate a preview.'),
    sendEmail: async () => assert.fail('Dry run must not send email.'),
  });

  const result = await service.dryRun({ noteIds: ['partial-note'] });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.counts, { blocked_ambiguous: 1 });
  assert.deepEqual(result.readyNoteIds, []);
  assert.equal(result.items[0].status, 'blocked_ambiguous');
  assert.equal(result.items[0].blockers[0].code, 'APPLICATION_COMMENTS_INCOMPLETE');
  assert.notEqual(result.items[0].blockers[0].code, 'APPLICATION_EMAIL_NOT_FOUND');
  assert.equal(result.items[0].contactResolution.status, 'pending');
  assert.equal(result.items[0].contactResolution.collectionStatus, 'partial');
  assert.equal(result.items[0].contactResolution.reason, 'comment_collection_incomplete');
});

test('batch creation replays the same idempotency key and rejects changed content', async (t) => {
  const { service } = await readyServiceFixture(t, { noteIds: ['note-idempotent'] });
  const request = {
    noteIds: ['note-idempotent'],
    defaultAttachmentTemplate: 'resume',
    minIntervalMs: 0,
    idempotencyKey: 'batch-idempotency-1',
  };

  const first = await service.createBatch(request);
  const replay = await service.createBatch(request);

  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.preflight, null);
  assert.equal(replay.batch.batchId, first.batch.batchId);
  assert.equal(replay.batch.revision, first.batch.revision);

  await assert.rejects(
    service.createBatch({ ...request, title: 'different content' }),
    { code: 'APPLICATION_BATCH_IDEMPOTENCY_CONFLICT', status: 409 },
  );
});

test('dry run exposes normalized contact evidence for the batch workbench', async (t) => {
  const noteId = 'note-normalized-contact';
  const evidence = '简历投递：📮 1️⃣3️⃣9️⃣6️⃣33450 6️⃣@扣扣点com';
  const { records, service } = await readyServiceFixture(t, { noteIds: [noteId] });
  records.set(noteId, {
    ...readyRecord(noteId),
    body: evidence,
    application_info: { contacts: [], application_routes: [] },
  });

  const result = await service.dryRun({ noteIds: [noteId], defaultAttachmentTemplate: 'resume' });

  assert.equal(result.items[0].status, 'ready');
  assert.equal(result.items[0].contact.address, '1396334506@qq.com');
  assert.equal(result.items[0].contact.evidenceText, evidence);
  assert.equal(result.items[0].contact.normalizationApplied, true);
  assert.deepEqual(result.items[0].contact.sourceFields, ['body']);
});

test('a frozen approved batch sends each ready item once and in selection order', async (t) => {
  const noteIds = ['note-1', 'note-2', 'note-3'];
  const sends = [];
  const { records, service } = await readyServiceFixture(t, {
    noteIds,
    sendEmail: async (request, allowedRecipients) => {
      sends.push({ request: structuredClone(request), allowedRecipients: [...allowedRecipients] });
    },
  });
  const { created, approved } = await freezeAndApprove(service, noteIds);

  assert.deepEqual(created.preflight.readyNoteIds, noteIds);
  assert.deepEqual(created.batch.items.map((item) => item.noteId), noteIds);
  assert.equal(approved.status, 'approved');
  assert.match(approved.approval.snapshotHash, /^[a-f0-9]{64}$/u);

  for (const noteId of noteIds) {
    records.set(noteId, { ...readyRecord(noteId), outreach: { email_subject: 'Changed', email_body: 'Changed' } });
  }

  await service.startBatch(created.batch.batchId, { expectedRevision: approved.revision });
  await service.waitForIdle(created.batch.batchId);
  const finished = await service.getBatch(created.batch.batchId);

  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.items.map((item) => item.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(sends.map((send) => send.request.noteId), noteIds);
  assert.deepEqual(sends.map((send) => send.allowedRecipients), noteIds.map((noteId) => [`${noteId}@example.com`]));
  assert.equal(new Set(sends.map((send) => send.request.idempotencyKey)).size, noteIds.length);
  assert.deepEqual(finished.items.map((item) => item.payload.subject), noteIds.map((noteId) => `Subject ${noteId}`));
  assert.deepEqual(finished.items.map((item) => item.payload.finalFilenames), noteIds.map(() => ['resume.pdf']));

  const events = await service.listEvents(created.batch.batchId);
  assert.deepEqual(
    events.filter((event) => event.type === 'item_updated').map((event) => [event.itemId, event.toStatus]),
    noteIds.flatMap((noteId) => [[noteId, 'sending'], [noteId, 'sent']]),
  );
});

test('a retryable known-not-sent failure pauses before the next item', async (t) => {
  const noteIds = ['note-retry', 'note-waiting'];
  const sends = [];
  const { service } = await readyServiceFixture(t, {
    noteIds,
    sendEmail: async (request) => {
      sends.push(request.noteId);
      throw Object.assign(new Error('SMTP rate limited'), {
        code: 'SMTP_RATE_LIMITED',
        safeToRetry: true,
        deliveryStatus: 'not_sent',
      });
    },
  });
  const { created, approved } = await freezeAndApprove(service, noteIds);

  await service.startBatch(created.batch.batchId, { expectedRevision: approved.revision });
  await service.waitForIdle(created.batch.batchId);
  const paused = await service.getBatch(created.batch.batchId);

  assert.equal(paused.status, 'paused');
  assert.deepEqual(sends, ['note-retry']);
  assert.equal(paused.items[0].status, 'failed_retryable');
  assert.equal(paused.items[0].error.code, 'SMTP_RATE_LIMITED');
  assert.equal(paused.items[0].error.attempt, 1);
  assert.equal(paused.items[0].error.backoffMs, 1_000);
  assert.equal(paused.items[0].error.retryAt, '2026-08-04T04:00:01.000Z');
  assert.equal(paused.items[1].status, 'ready');
  assert.equal((await service.listEvents(created.batch.batchId)).at(-1).type, 'batch_paused');
});

test('an SMTP timeout with explicit unknown delivery pauses and is never retried automatically', async (t) => {
  const noteIds = ['note-unknown', 'note-next'];
  const sends = [];
  const { service } = await readyServiceFixture(t, {
    noteIds,
    sendEmail: async (request) => {
      sends.push(request.noteId);
      if (request.noteId === 'note-unknown') {
        throw Object.assign(new Error('SMTP response timed out'), {
          code: 'SMTP_CONNECTION_TIMEOUT',
          safeToRetry: false,
          deliveryStatus: 'unknown',
        });
      }
    },
  });
  const { created, approved } = await freezeAndApprove(service, noteIds);

  await service.startBatch(created.batch.batchId, { expectedRevision: approved.revision });
  await service.waitForIdle(created.batch.batchId);
  let paused = await service.getBatch(created.batch.batchId);

  assert.equal(paused.status, 'paused');
  assert.deepEqual(sends, ['note-unknown']);
  assert.equal(paused.items[0].status, 'unknown_manual_review');
  assert.equal(paused.items[0].error.code, 'SMTP_CONNECTION_TIMEOUT');
  assert.equal(paused.items[1].status, 'ready');

  await service.startBatch(created.batch.batchId, { expectedRevision: paused.revision });
  await service.waitForIdle(created.batch.batchId);
  paused = await service.getBatch(created.batch.batchId);

  assert.equal(paused.status, 'paused');
  assert.deepEqual(sends, ['note-unknown', 'note-next']);
  assert.deepEqual(paused.items.map((item) => item.status), ['unknown_manual_review', 'sent']);
});

test('manual reconciliation records an unknown send exactly once', async (t) => {
  const { service } = await readyServiceFixture(t, {
    noteIds: ['note-reconcile'],
    sendEmail: async () => {
      throw Object.assign(new Error('SMTP response timed out'), { code: 'MAIL_SEND_TIMEOUT', deliveryStatus: 'unknown' });
    },
  });
  const { created, approved } = await freezeAndApprove(service, ['note-reconcile']);
  await service.startBatch(created.batch.batchId, { expectedRevision: approved.revision });
  await service.waitForIdle(created.batch.batchId);
  const paused = await service.getBatch(created.batch.batchId);
  const item = paused.items[0];
  const reconciled = await service.reconcileItem(created.batch.batchId, item.itemId, {
    expectedRevision: paused.revision,
    expectedItemRevision: item.revision,
    outcome: 'sent',
    actor: 'reviewer',
    reason: '发件箱记录确认服务器已接收。',
  });
  assert.equal(reconciled.items[0].status, 'sent');
  assert.equal(reconciled.items[0].error.code, 'APPLICATION_DELIVERY_CONFIRMED_SENT');
  await assert.rejects(
    service.reconcileItem(created.batch.batchId, item.itemId, {
      expectedRevision: reconciled.revision,
      expectedItemRevision: reconciled.items[0].revision,
      outcome: 'sent',
      actor: 'reviewer',
      reason: '重复核对',
    }),
    { code: 'APPLICATION_BATCH_RECONCILIATION_STATE_INVALID', status: 409 },
  );
});

test('persistent SMTP gate serializes intervals across a service restart', async (t) => {
  const outputDir = await temporaryOutputDir(t, 'smtp-send-gate-');
  const filePath = path.join(outputDir, 'smtp-send-gate.json');
  let current = new Date(FIXED_TIME);
  const waits = [];
  const options = {
    filePath,
    withLock: async (operation) => operation(),
    now: () => current,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      current = new Date(current.getTime() + milliseconds);
    },
  };
  await createPersistentSmtpSendGate(options).acquire(1_000);
  const restarted = createPersistentSmtpSendGate(options);
  await restarted.acquire(1_000);
  assert.deepEqual(waits, [1_000]);
  const state = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(state.nextAllowedAt, '2026-08-04T04:00:02.000Z');
});

test('attachment rename failure rolls every changed display name back', async (t) => {
  const outputDir = await temporaryOutputDir(t, 'application-batch-rename-');
  const manager = new ApplicationBatchManager({ rootDir: outputDir });
  await manager.initialize();
  const record = readyRecord('note-rename');
  record.job_card.role_name = 'Product Manager';
  record.application_info.contacts[0].evidence = 'Apply to note-rename@example.com';
  const attachments = [
    { ...readyAttachment('note-rename'), attachmentId: 'attachment-a', originalName: 'resume.pdf', displayName: 'resume.pdf' },
  ];
  const names = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment.displayName]));
  let renameCalls = 0;
  const service = new ApplicationBatchService({
    jobId: JOB_ID,
    outputDir,
    manager,
    candidateProfile: { name: 'Candidate' },
    loadRecord: async () => structuredClone(record),
    listAttachments: async () => ({ attachments: attachments.map((attachment) => ({ ...attachment, displayName: names.get(attachment.attachmentId) })) }),
    renameAttachment: async (attachmentId, displayName) => {
      renameCalls += 1;
      names.set(attachmentId, displayName);
      if (renameCalls === 1) throw Object.assign(new Error('rename failed'), { code: 'ATTACHMENT_WRITE_FAILED' });
    },
    checkQuality: async () => assert.fail('quality should not run after rename failure'),
    previewEmail: async () => assert.fail('preview should not run after rename failure'),
    sendEmail: async () => assert.fail('send should not run after rename failure'),
  });

  await assert.rejects(
    service.createBatch({ noteIds: ['note-rename'], defaultAttachmentTemplate: '{jobTitle}-{candidateName}-resume' }),
    { code: 'ATTACHMENT_WRITE_FAILED' },
  );
  assert.deepEqual([...names.values()], ['resume.pdf']);
  assert.equal(renameCalls, 2);
});

test('HTTP dry-run route exposes the partial-comment blocker', async (t) => {
  const outputDir = await temporaryOutputDir(t, 'application-batch-http-');
  await Promise.all([
    writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
      records: [{
        note_id: 'partial-http',
        post_id: 'partial-http',
        title: 'HTTP partial role',
        application_info: { contacts: [], application_routes: [] },
      }],
    }), 'utf8'),
    writeAudience(outputDir, {
      posts: [{ post_id: 'partial-http', status: 'partial', collected_comment_count: 1 }],
      comments: [{ comment_id: 'http-comment', post_id: 'partial-http', text: 'Still recruiting?' }],
    }),
  ]);
  const internal = {
    id: JOB_ID,
    outputDir,
    params: { candidateProfile: { name: 'Candidate' } },
  };
  const manager = {
    active: null,
    list: () => [],
    get: (jobId) => jobId === JOB_ID ? internal : null,
    getInternal: (jobId) => jobId === JOB_ID ? internal : null,
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64 * 1_024,
      runnerAvailable: true,
      projectRoot: process.cwd(),
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/jobs/${JOB_ID}/application-batches/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['partial-http'] }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items[0].status, 'blocked_ambiguous');
    assert.equal(body.items[0].blockers[0].code, 'APPLICATION_COMMENTS_INCOMPLETE');
    assert.equal(body.items[0].contactResolution.collectionStatus, 'partial');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing batch SSE returns 404 without terminating the HTTP server', async (t) => {
  const outputDir = await temporaryOutputDir(t, 'application-batch-sse-http-');
  const internal = {
    id: JOB_ID,
    outputDir,
    params: { candidateProfile: { name: 'Candidate' } },
  };
  const manager = {
    active: null,
    list: () => [],
    get: (jobId) => jobId === JOB_ID ? internal : null,
    getInternal: (jobId) => jobId === JOB_ID ? internal : null,
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64 * 1_024,
      runnerAvailable: true,
      projectRoot: process.cwd(),
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const missing = await fetch(`${origin}/api/jobs/${JOB_ID}/application-batches/missing-batch/events`);
    const missingBody = await missing.json();

    assert.equal(missing.status, 404);
    assert.equal(missingBody.error.code, 'APPLICATION_BATCH_NOT_FOUND');

    const followUp = await fetch(`${origin}/api/health`);
    const followUpBody = await followUp.json();
    assert.equal(followUp.status, 200);
    assert.equal(followUpBody.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE helper replays batch events after the supplied cursor', async () => {
  const req = new EventEmitter();
  req.url = '/events?after=1';
  req.headers = {};
  const chunks = [];
  const res = {
    writableEnded: false,
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
      if (String(chunk).includes('id: 3')) queueMicrotask(() => req.emit('close'));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  const service = {
    getBatch: async () => ({ batchId: 'batch-sse', lastEventSequence: 3, status: 'paused' }),
    listEvents: async (_batchId, { afterSequence }) => {
      assert.equal(afterSequence, 1);
      return [
        { sequence: 2, type: 'item_updated' },
        { sequence: 3, type: 'batch_paused' },
      ];
    },
  };

  await streamApplicationBatchEvents(req, res, service, 'batch-sse');

  const output = chunks.join('');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.match(output, /event: snapshot/u);
  assert.match(output, /id: 2\nevent: batch/u);
  assert.match(output, /id: 3\nevent: batch/u);
  assert.equal(res.writableEnded, true);
});
