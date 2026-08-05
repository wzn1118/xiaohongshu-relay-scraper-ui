import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createApp } from './app.mjs';
import { hashDraftContent } from './lib/draft-store.mjs';
import { createMailSender } from './mail-sender.mjs';

const execFileAsync = promisify(execFile);
const MAILPIT_VERSION = 'v1.30.6';
const MAILPIT_ARCHIVE_SHA256 = '23a249f8f73409be67ecb48d43e3269810a9f35388db4eba0c0115c5eb1ff31a';
const MAILPIT_BINARY_SHA256 = '4284d4f2c070e088815d0d6e02fc7cc2a5409605d335921fea50fa44162320e4';
const MAILPIT_ARCHIVE = 'mailpit-windows-amd64.zip';
const MAILPIT_DOWNLOAD_URL = `https://github.com/axllent/mailpit/releases/download/${MAILPIT_VERSION}/${MAILPIT_ARCHIVE}`;
const JOB_ID = '20260731220000-abcdef12';
const NOTE_ID = 'note-mailpit-001';
const RECIPIENT = 'jobs@example.test';
const CANDIDATE_EMAIL = 'candidate@example.test';
const SENDER = 'sender@example.test';

function outreachDraft(overrides = {}) {
  return {
    greeting: '您好，我想申请内容运营实习岗位。',
    email_subject: '应聘内容运营实习｜示例用户',
    email_body: '您好，我希望申请内容运营实习。我曾负责社交媒体内容运营与市场调研，能够围绕目标受众梳理信息，并根据反馈调整内容重点和推进节奏。这段实践与岗位的内容策划和数据分析要求直接相关，期待与您进一步沟通团队当前的工作重点。',
    cover_letter: '尊敬的招聘负责人：您好。我具备内容运营、用户研究和数据分析经验，能够独立完成内容策划、效果复盘与跨团队协作，希望参与内容运营实习岗位的工作。',
    ...overrides,
  };
}

function applicationRecord({
  noteId = NOTE_ID,
  recipient = RECIPIENT,
  roleName = '内容运营实习',
  subject = null,
  body = null,
} = {}) {
  const outreach = outreachDraft({
    ...(subject ? { email_subject: subject } : {}),
    ...(body ? { email_body: body } : {}),
  });
  return {
    note_id: noteId,
    post_id: noteId,
    title: roleName,
    body: `Recruiting ${roleName}. Send the application to ${recipient}.`,
    created_at: '2026-07-31T08:00:00.000Z',
    candidate_profile: { name: '示例用户' },
    application_info: {
      contacts: [],
      application_routes: [{
        type: 'email',
        channel: 'email',
        value: recipient,
        evidence: `Send the application to ${recipient}`,
        actionable: true,
        verification_status: 'verified',
        confidence: 100,
      }],
      responsibilities: ['内容策划'],
      requirements: ['数据分析'],
    },
    job_card: { role_name: roleName, parse_basis: 'full_body' },
    outreach,
    cover_letter_evaluation: {
      score: 95,
      threshold: 90,
      passed: true,
      qualityCheckedVersion: 1,
      qualityCheckedHash: hashDraftContent(outreach),
    },
  };
}

function passingQualityReport() {
  return {
    score: 96,
    threshold: 90,
    passed: true,
    attempts: 1,
    strengths: ['岗位匹配信息具体', '沟通诉求清晰'],
    problems: [],
    rewrite_instructions: [],
    rubric: {
      relevance: 96,
      evidence: 95,
      specificity: 95,
      authenticity: 96,
      clarity: 97,
      concision: 95,
      tone: 97,
      call_to_action: 96,
      consistency: 97,
      attachment_consistency: 96,
    },
  };
}

test('API delivery sends a quality-checked UTF-8 message with immutable PDF/DOCX attachments through Mailpit', async (t) => {
  const mailpit = await acquireMailpit();
  let api = null;
  t.after(async () => {
    if (api) await api.close();
    await mailpit.close();
  });
  api = await createApiServer(mailpit.smtpHost, mailpit.smtpPort);

  const purge = await fetch(`${mailpit.apiBase}/api/v1/messages`, { method: 'DELETE' });
  assert.equal(purge.ok, true, `Mailpit purge failed with ${purge.status}`);

  const initialResponse = await requestJson(api.origin, `/api/jobs/${JOB_ID}/results?limit=20`);
  assert.equal(initialResponse.status, 200, JSON.stringify(initialResponse.body));
  const initial = initialResponse.body.items[0];
  const edited = {
    ...initial.outreach,
    cover_letter: `${initial.outreach.cover_letter} 我也能根据数据复盘持续优化内容。`,
  };
  const saved = await postJson(api.origin, 'draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: edited,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');

  const pdfBytes = Buffer.from('%PDF-1.7\nMailpit API resume fixture\n%%EOF\n', 'utf8');
  const docxBytes = Buffer.concat([
    Buffer.from('504b0304', 'hex'),
    Buffer.from('[Content_Types].xml\nword/document.xml\nMailpit API portfolio fixture', 'utf8'),
  ]);
  const expected = [
    { filename: '中文简历.pdf', mediaType: 'application/pdf', bytes: pdfBytes },
    { filename: '项目说明.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docxBytes },
  ].map((item) => ({ ...item, sha256: sha256(item.bytes) }));

  const uploads = [];
  for (const attachment of expected) {
    const form = new FormData();
    form.append('noteId', NOTE_ID);
    form.append('source', 'uploaded');
    form.append('draftId', saved.body.draftVersion.draftId);
    form.append('draftVersion', String(saved.body.draftVersion.version));
    form.append('selected', 'true');
    form.append('file', new Blob([attachment.bytes], { type: attachment.mediaType }), attachment.filename);
    const uploaded = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-attachments`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.attachment.displayName, attachment.filename);
    assert.equal(uploaded.body.attachment.sha256, attachment.sha256);
    uploads.push(uploaded.body.attachment);
  }

  const listed = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-attachments?noteId=${NOTE_ID}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.attachments.map((item) => item.displayName), expected.map((item) => item.filename));
  const attachmentIds = uploads.map((item) => item.attachmentId);

  const checked = await postJson(api.origin, 'draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    attachmentIds,
    aiSessionId: 'mailpit-quality-session',
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.draftVersion.qualityStatus, 'passed');
  assert.equal(checked.body.draftVersion.qualityCheckedHash, saved.body.draftVersion.contentHash);
  assert.equal(checked.body.cover_letter_evaluation.passed, true);
  assert.equal(Object.keys(checked.body.cover_letter_evaluation.rubric).length, 10);

  const recipientCandidate = initial.contactDiscovery?.candidates?.find((candidate) => (
    String(candidate?.address || '').toLowerCase() === RECIPIENT
  ));
  assert.ok(recipientCandidate?.evidenceHash);
  assert.ok(recipientCandidate?.sourceRevision);
  const recipientEvidence = {
    evidenceHash: recipientCandidate.evidenceHash,
    sourceRevision: recipientCandidate.sourceRevision,
  };

  const preview = await postJson(api.origin, 'send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    ...recipientEvidence,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
    attachmentIds,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.recipient, RECIPIENT);
  assert.equal(preview.body.from, SENDER);
  assert.equal(preview.body.replyTo, CANDIDATE_EMAIL);
  assert.equal(preview.body.subject, edited.email_subject);
  assert.equal(preview.body.text, edited.email_body);
  assert.match(preview.body.htmlPreview, /内容运营实习/u);
  assert.equal(preview.body.quality.evaluation.passed, true);
  assert.equal(preview.body.quality.qualityStatus, 'passed');
  assert.equal(preview.body.smtp.configured, true);
  assert.equal(preview.body.smtp.verificationStatus, 'verified');
  assert.equal(preview.body.readiness, 'ready');
  assert.equal(preview.body.attachmentSummary.count, expected.length);
  assert.deepEqual(preview.body.attachmentSummary.attachments.map((item) => item.filename), expected.map((item) => item.filename));
  assert.match(preview.body.previewRevision, /^[a-f0-9]{64}$/u);
  assert.match(preview.body.attachmentBundleHash, /^[a-f0-9]{64}$/u);

  const sent = await postJson(api.origin, 'send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    ...recipientEvidence,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
    attachmentIds,
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'mailpit-api-end-to-end-v1',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.duplicate, false);
  assert.equal(sent.body.delivery.action, 'email_sent');
  assert.equal(sent.body.delivery.sendAudit[0].attachmentCount, expected.length);
  assert.equal(sent.body.attachmentBundleHash, preview.body.attachmentBundleHash);

  const list = await waitForMessage(mailpit.apiBase, RECIPIENT);
  assert.equal(list.messages_count, 1);
  const mailpitMessageId = list.messages[0].ID;
  const messageResponse = await fetch(`${mailpit.apiBase}/api/v1/message/${encodeURIComponent(mailpitMessageId)}`);
  assert.equal(messageResponse.ok, true);
  const message = await messageResponse.json();
  assert.equal(message.Subject, edited.email_subject);
  assert.equal(message.Text.trim(), edited.email_body);
  assert.equal(message.From.Address, SENDER);
  assert.equal(message.To[0].Address, RECIPIENT);
  assert.equal(message.ReplyTo[0].Address, CANDIDATE_EMAIL);
  assert.deepEqual(message.Attachments.map((item) => [item.FileName, item.ContentType]), expected.map((item) => [item.filename, item.mediaType]));

  const delivered = [];
  for (const [index, attachment] of message.Attachments.entries()) {
    const wanted = expected[index];
    assert.equal(attachment.Size, wanted.bytes.length);
    assert.equal(attachment.Checksums.SHA256, wanted.sha256);
    const download = await fetch(`${mailpit.apiBase}/api/v1/message/${encodeURIComponent(mailpitMessageId)}/part/${encodeURIComponent(attachment.PartID)}`);
    assert.equal(download.ok, true);
    const bytes = Buffer.from(await download.arrayBuffer());
    const downloadSha256 = sha256(bytes);
    assert.equal(downloadSha256, wanted.sha256);
    delivered.push({ filename: attachment.FileName, sha256: downloadSha256, size: bytes.length });
  }

  const rawResponse = await fetch(`${mailpit.apiBase}/api/v1/message/${encodeURIComponent(mailpitMessageId)}/raw`);
  assert.equal(rawResponse.ok, true);
  const raw = await rawResponse.text();
  assert.match(raw, /MIME-Version: 1\.0/iu);
  assert.match(raw, /Content-Type: multipart\/mixed/iu);
  assert.match(raw, /Content-Disposition: attachment/iu);
  assert.match(raw, /filename\*0\*=utf-8''%E4%B8%AD%E6%96%87%E7%AE%80%E5%8E%86\.pdf/iu);
  assert.match(raw, /filename\*0\*=utf-8''%E9%A1%B9%E7%9B%AE%E8%AF%B4%E6%98%8E\.docx/iu);
  assert.match(raw, /Content-Transfer-Encoding: base64/iu);

  const bundleDir = path.join(api.outputDir, 'application-attachments', 'send-bundles', sent.body.sendId);
  const bundleManifest = JSON.parse(await readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const bundleOutcome = JSON.parse(await readFile(path.join(bundleDir, 'outcome.json'), 'utf8'));
  assert.equal(bundleManifest.status, 'prepared');
  assert.equal(bundleManifest.attachmentBundleHash, preview.body.attachmentBundleHash);
  assert.equal(bundleManifest.previewRevision, preview.body.previewRevision);
  assert.deepEqual(bundleManifest.attachments.map((item) => item.sha256), expected.map((item) => item.sha256));
  assert.equal(bundleOutcome.status, 'sent');
  assert.equal(bundleOutcome.messageId, sent.body.delivery.email.messageId);

  const info = await mailpitInfo(mailpit.apiBase);
  console.log(JSON.stringify({
    mailpitVersion: info.Version,
    mailpitMessageId,
    smtpMessageId: sent.body.delivery.email.messageId,
    previewRevision: preview.body.previewRevision,
    attachmentBundleHash: preview.body.attachmentBundleHash,
    attachments: delivered,
  }));
});

test('batch API sends one independently frozen message per selected role through Mailpit', async (t) => {
  const cases = [
    {
      noteId: 'batch-role-product',
      recipient: 'product@example.test',
      roleName: 'Product Manager',
      subject: 'Application for Product Manager',
      body: '您好，我是 Test Candidate，申请 Product Manager 岗位。我有产品规划、用户研究和跨团队交付经验，能够围绕业务目标拆解需求并跟进结果。希望有机会进一步沟通岗位重点，感谢您的时间。',
    },
    {
      noteId: 'batch-role-growth',
      recipient: 'growth@example.test',
      roleName: 'Growth Marketing Manager',
      subject: 'Application for Growth Marketing Manager',
      body: '您好，我是 Test Candidate，申请 Growth Strategist 岗位。我有增长实验、渠道分析和数据复盘经验，能够根据转化结果持续调整策略并推动落地。希望有机会进一步沟通团队目标，感谢您的时间。',
    },
    {
      noteId: 'batch-role-analyst',
      recipient: 'analyst@example.test',
      roleName: 'Data Analyst',
      subject: 'Application for Data Analyst',
      body: '您好，我是 Test Candidate，申请 Data Analyst 岗位。我有指标体系、数据清洗和业务分析经验，能够把分析结论转化为清晰建议并跟进验证。希望有机会进一步沟通分析场景，感谢您的时间。',
    },
  ];
  const records = cases.map((item) => applicationRecord(item));
  const mailpit = await acquireMailpit();
  let api = null;
  t.after(async () => {
    if (api) await api.close();
    await mailpit.close();
  });
  api = await createApiServer(mailpit.smtpHost, mailpit.smtpPort, {
    records,
    candidateProfile: { name: 'Test Candidate', email: CANDIDATE_EMAIL },
  });

  const purge = await fetch(`${mailpit.apiBase}/api/v1/messages`, { method: 'DELETE' });
  assert.equal(purge.ok, true, `Mailpit purge failed with ${purge.status}`);

  const resultsResponse = await requestJson(api.origin, `/api/jobs/${JOB_ID}/results?limit=20`);
  assert.equal(resultsResponse.status, 200, JSON.stringify(resultsResponse.body));
  const results = new Map(resultsResponse.body.items.map((item) => [item.note_id, item]));
  const resumeBytes = Buffer.from('%PDF-1.7\nBatch resume fixture\n%%EOF\n', 'utf8');
  const resumeSha256 = sha256(resumeBytes);
  const qualityInputs = [];
  for (const item of cases) {
    const record = results.get(item.noteId);
    assert.ok(record?.draftVersion, `Missing draft version for ${item.noteId}`);
    const form = new FormData();
    form.append('noteId', item.noteId);
    form.append('source', 'uploaded');
    form.append('draftId', record.draftVersion.draftId);
    form.append('draftVersion', String(record.draftVersion.version));
    form.append('selected', 'true');
    form.append('file', new Blob([resumeBytes], { type: 'application/pdf' }), 'resume.pdf');
    const uploaded = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-attachments`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.attachment.sha256, resumeSha256);

    qualityInputs.push({
      noteId: item.noteId,
      draftId: record.draftVersion.draftId,
      version: record.draftVersion.version,
      contentHash: record.draftVersion.contentHash,
      attachmentId: uploaded.body.attachment.attachmentId,
    });
    const checked = await postJson(api.origin, 'draft/quality', {
      noteId: item.noteId,
      draftId: record.draftVersion.draftId,
      version: record.draftVersion.version,
      contentHash: record.draftVersion.contentHash,
      attachmentIds: [uploaded.body.attachment.attachmentId],
      aiSessionId: 'mailpit-quality-session',
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.draftVersion.qualityStatus, 'passed');
  }

  // The quality report includes the peer-draft corpus. Recheck after every
  // selected draft exists so the final report is bound to the complete set.
  for (const input of qualityInputs) {
    const checked = await postJson(api.origin, 'draft/quality', {
      noteId: input.noteId,
      draftId: input.draftId,
      version: input.version,
      contentHash: input.contentHash,
      attachmentIds: [input.attachmentId],
      aiSessionId: 'mailpit-quality-session',
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.draftVersion.qualityStatus, 'passed');
  }

  const createRequest = {
    noteIds: cases.map((item) => item.noteId),
    defaultAttachmentTemplate: '{jobTitle}-{candidateName}-resume',
    minIntervalMs: 0,
    aiSessionId: 'mailpit-quality-session',
    idempotencyKey: 'mailpit-batch-three-roles-v1',
  };
  const candidates = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-delivery-candidates?limit=20`);
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const selectionSnapshot = candidates.body.selectionSnapshot;
  assert.deepEqual(
    [...selectionSnapshot.noteIds].sort(),
    cases.map((item) => item.noteId).sort(),
  );
  const preflightRequest = {
    ...createRequest,
    selectionSnapshotId: selectionSnapshot.selectionSnapshotId,
    selectionSnapshotHash: selectionSnapshot.selectionSnapshotHash,
    selectionRevisions: selectionSnapshot.revisions,
  };
  const dryRun = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-batches/dry-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(preflightRequest),
  });
  assert.equal(dryRun.status, 200, JSON.stringify(dryRun.body));
  assert.deepEqual(dryRun.body.readyNoteIds, cases.map((item) => item.noteId));
  const created = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...preflightRequest,
      preflightId: dryRun.body.preflightId,
      manifestHash: dryRun.body.manifestHash,
      confirmedNoteIds: dryRun.body.readyNoteIds,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.preflight.readyNoteIds, cases.map((item) => item.noteId));
  assert.equal(created.body.batch.status, 'ready');
  assert.equal(created.body.batch.items.length, cases.length);

  const batchId = created.body.batch.batchId;
  const approved = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-batches/${batchId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: created.body.batch.revision, actor: 'mailpit-test' }),
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'approved');
  assert.match(approved.body.approval.snapshotHash, /^[a-f0-9]{64}$/u);

  const started = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-batches/${batchId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: approved.body.revision, actor: 'mailpit-test' }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const finished = await waitForBatch(api.origin, batchId, 'completed');
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.items.map((item) => item.status), cases.map(() => 'sent'));

  const list = await waitForMessageCount(mailpit.apiBase, cases.length);
  assert.equal(list.messages_count, cases.length);
  const delivered = [];
  for (const item of cases) {
    const summary = list.messages.find((message) => message.To?.some((target) => target.Address === item.recipient));
    assert.ok(summary, `Mailpit message missing for ${item.recipient}`);
    const response = await fetch(`${mailpit.apiBase}/api/v1/message/${encodeURIComponent(summary.ID)}`);
    assert.equal(response.ok, true);
    const message = await response.json();
    const expectedFilename = `${item.roleName}-Test Candidate-resume.pdf`;
    assert.equal(message.To[0].Address, item.recipient);
    assert.equal(message.Subject, item.subject);
    assert.equal(message.Text.trim(), item.body);
    assert.equal(message.Attachments.length, 1);
    assert.equal(message.Attachments[0].FileName, expectedFilename);
    assert.equal(message.Attachments[0].Checksums.SHA256, resumeSha256);
    const attachment = await fetch(`${mailpit.apiBase}/api/v1/message/${encodeURIComponent(summary.ID)}/part/${encodeURIComponent(message.Attachments[0].PartID)}`);
    assert.equal(attachment.ok, true);
    assert.equal(sha256(Buffer.from(await attachment.arrayBuffer())), resumeSha256);
    delivered.push({ recipient: item.recipient, subject: message.Subject, filename: expectedFilename });
  }

  const replay = await requestJson(api.origin, `/api/jobs/${JOB_ID}/application-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...preflightRequest,
      preflightId: dryRun.body.preflightId,
      manifestHash: dryRun.body.manifestHash,
      confirmedNoteIds: dryRun.body.readyNoteIds,
    }),
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.batch.batchId, batchId);
  await delay(250);
  assert.equal((await mailpitMessages(mailpit.apiBase)).messages_count, cases.length);

  const batchDirectory = path.join(api.outputDir, 'artifacts', 'application-batches', batchId);
  const persistedBatch = JSON.parse(await readFile(path.join(batchDirectory, 'batch.json'), 'utf8'));
  assert.equal(persistedBatch.status, 'completed');
  assert.ok(persistedBatch.approval?.snapshotHash);
  const persistedItems = await Promise.all(cases.map(async (item) => (
    JSON.parse(await readFile(path.join(batchDirectory, 'items', `${item.noteId}.json`), 'utf8'))
  )));
  assert.deepEqual(persistedItems.map((item) => item.status), cases.map(() => 'sent'));
  assert.deepEqual(persistedItems.map((item) => item.payload.recipient), cases.map((item) => item.recipient));
  assert.ok(persistedItems.every((item) => item.payload.contact.evidenceHash));
  const events = (await readFile(path.join(batchDirectory, 'events.jsonl'), 'utf8'))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'item_updated' && event.toStatus === 'sent').length, cases.length);
  const audits = (await readFile(path.join(api.outputDir, 'delivery-send-audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(audits.length, cases.length);
  assert.ok(audits.every((audit) => audit.event === 'email_sent' && audit.sendId && audit.previewRevision));
  for (const audit of audits) {
    const outcome = JSON.parse(await readFile(path.join(api.outputDir, 'application-attachments', 'send-bundles', audit.sendId, 'outcome.json'), 'utf8'));
    assert.equal(outcome.status, 'sent');
  }

  console.log(JSON.stringify({ batchId, messageCount: list.messages_count, delivered }));
});

async function createApiServer(smtpHost, smtpPort, {
  records = [applicationRecord()],
  candidateProfile = { name: '示例用户', email: CANDIDATE_EMAIL },
} = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-mailpit-api-'));
  const staticDir = path.join(fixture, 'dist');
  const outputDir = path.join(fixture, 'artifacts');
  await Promise.all([mkdir(staticDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Mailpit API fixture</title>', 'utf8');
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    keyword: '内容运营实习',
    analysis_mode: 'job',
    records,
    codex_runtime: { status: 'completed', generated: records.length },
    quality_gate: { passed: true },
  }, null, 2), 'utf8');

  const job = { id: JOB_ID, keyword: '内容运营实习', status: 'completed', createdAt: '2026-07-31T08:00:00.000Z' };
  const internal = {
    ...job,
    outputDir,
    logPath: path.join(fixture, 'run.log'),
    params: {
      keyword: job.keyword,
      candidateProfile,
      aiSessionId: 'mailpit-quality-session',
    },
  };
  const manager = {
    active: null,
    list: () => [job],
    get: (id) => id === JOB_ID ? job : null,
    getInternal: (id) => id === JOB_ID ? internal : null,
  };
  const smtpRuntime = {
    host: smtpHost,
    port: smtpPort,
    secure: false,
    requireTls: false,
    auth: 'none',
    from: SENDER,
  };
  const mailSender = createMailSender(smtpRuntime);
  const verifiedAt = new Date().toISOString();
  const smtpPublic = {
    provider: 'custom',
    ...smtpRuntime,
    hasPassword: false,
    revision: 1,
    configHash: 'mailpit-live-config-v1',
    credentialRevision: 1,
    verified: true,
    verificationStatus: 'verified',
    lastVerifiedAt: verifiedAt,
  };
  const verificationState = {
    configured: true,
    verificationStatus: 'verified',
    verifiedAt,
    configHash: smtpPublic.configHash,
    credentialRevision: smtpPublic.credentialRevision,
  };
  const smtpConfig = {
    getPublic: () => ({ ...smtpPublic }),
    getForMailer: () => ({ ...smtpRuntime }),
    getVerificationState: () => ({ ...verificationState }),
    getVerificationSnapshot: () => ({
      revision: smtpPublic.revision,
      configHash: smtpPublic.configHash,
      credentialRevision: smtpPublic.credentialRevision,
    }),
    assertReadyForSend: () => ({ ...verificationState }),
    markVerified: async () => ({ ...verificationState }),
    markVerificationFailed: async () => ({ ...verificationState }),
  };
  const relaySupervisor = {
    snapshot: () => ({ phase: 'idle', inProgress: false }),
    probe: async () => ({ ok: true, ready: true }),
    connect: async () => ({ ok: true, ready: true }),
    recover: async () => ({ ok: true, ready: true }),
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 256 * 1024,
      staticDir,
      projectRoot: path.resolve('.'),
      runnerAvailable: true,
      deliveryAttachmentMaxFiles: 5,
      deliveryAttachmentMaxFileBytes: 2 * 1024 * 1024,
      deliveryAttachmentMaxTotalBytes: 5 * 1024 * 1024,
    },
    relayConfig: { get: () => ({ port: 18792, profile: 'chrome', autoConnect: false }) },
    relaySupervisor,
    aiSessions: {
      resolve: (sessionId) => {
        assert.equal(sessionId, 'mailpit-quality-session');
        return { provider: 'fixture', model: 'mailpit-quality-v1', wireApi: 'responses' };
      },
    },
    smtpConfig,
    mailSender,
    draftQualityChecker: async () => passingQualityReport(),
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    outputDir,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(fixture, { recursive: true, force: true });
    },
  };
}

async function acquireMailpit() {
  const externalUrl = String(process.env.MAILPIT_HTTP_URL || '').replace(/\/$/u, '');
  const externalSmtpPort = Number(process.env.MAILPIT_SMTP_PORT || 0);
  if (externalUrl || externalSmtpPort) {
    if (!externalUrl || !externalSmtpPort) {
      throw new Error('MAILPIT_HTTP_URL and MAILPIT_SMTP_PORT must be supplied together.');
    }
    await waitForExternalMailpit(externalUrl);
    return {
      apiBase: externalUrl,
      smtpHost: String(process.env.MAILPIT_SMTP_HOST || '127.0.0.1'),
      smtpPort: externalSmtpPort,
      close: async () => {},
    };
  }

  const defaultApi = 'http://127.0.0.1:8025';
  if (await mailpitInfo(defaultApi).catch(() => null)) {
    return { apiBase: defaultApi, smtpHost: '127.0.0.1', smtpPort: 1025, close: async () => {} };
  }
  if (process.platform !== 'win32') {
    throw new Error('Mailpit is unavailable. Set MAILPIT_HTTP_URL and MAILPIT_SMTP_PORT on non-Windows hosts.');
  }

  const binary = await ensureWindowsMailpit();
  const httpPort = await freePort();
  const smtpPort = await freePort();
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-mailpit-run-'));
  const child = spawn(binary, [
    '--listen', `127.0.0.1:${httpPort}`,
    '--smtp', `127.0.0.1:${smtpPort}`,
    '--database', path.join(runDir, 'mailpit.db'),
    '--disable-version-check',
    '--quiet',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  const apiBase = `http://127.0.0.1:${httpPort}`;
  try {
    await waitForReady(apiBase, child);
  } catch (error) {
    child.kill();
    await rm(runDir, { recursive: true, force: true });
    error.message = `${error.message}\n${output}`;
    throw error;
  }
  return {
    apiBase,
    smtpHost: '127.0.0.1',
    smtpPort,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await waitForChildExit(child, 3_000);
      }
      if (child.exitCode === null) {
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
        await waitForChildExit(child, 5_000);
      }
      await removeDirectoryWithRetry(runDir);
    },
  };
}

async function waitForExternalMailpit(apiBase) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await mailpitInfo(apiBase);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error(`Mailpit did not become ready at ${apiBase}.`);
}

async function ensureWindowsMailpit() {
  const cacheDir = path.join(os.tmpdir(), 'xiaohongshu-mailpit', MAILPIT_VERSION);
  const archivePath = path.join(cacheDir, MAILPIT_ARCHIVE);
  const binaryPath = path.join(cacheDir, 'mailpit.exe');
  await mkdir(cacheDir, { recursive: true });
  let archiveValid = await sha256File(archivePath).then((value) => value === MAILPIT_ARCHIVE_SHA256).catch(() => false);
  if (!archiveValid) {
    await rm(archivePath, { force: true });
    const temporaryPath = `${archivePath}.${process.pid}.tmp`;
    let lastError;
    for (const url of [MAILPIT_DOWNLOAD_URL, `https://ghproxy.net/${MAILPIT_DOWNLOAD_URL}`]) {
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(180_000),
          headers: { 'user-agent': 'xiaohongshu-relay-scraper-ui-mailpit-test' },
        });
        if (!response.ok) throw new Error(`Mailpit download failed with HTTP ${response.status}.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== MAILPIT_ARCHIVE_SHA256) throw new Error('Downloaded Mailpit archive failed SHA-256 verification.');
        await writeFile(temporaryPath, bytes);
        await rename(temporaryPath, archivePath);
        archiveValid = true;
        break;
      } catch (error) {
        lastError = error;
        await rm(temporaryPath, { force: true });
      }
    }
    if (!archiveValid) throw lastError || new Error('Mailpit download failed.');
  }

  const binaryValid = await sha256File(binaryPath).then((value) => value === MAILPIT_BINARY_SHA256).catch(() => false);
  if (!binaryValid) {
    await rm(binaryPath, { force: true });
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:MAILPIT_ARCHIVE_PATH -DestinationPath $env:MAILPIT_CACHE_DIR -Force',
    ], {
      env: { ...process.env, MAILPIT_ARCHIVE_PATH: archivePath, MAILPIT_CACHE_DIR: cacheDir },
      windowsHide: true,
    });
  }
  assert.equal(await sha256File(binaryPath), MAILPIT_BINARY_SHA256, 'Extracted Mailpit binary failed SHA-256 verification.');
  return binaryPath;
}

async function waitForReady(apiBase, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Mailpit exited with code ${child.exitCode} before becoming ready.`);
    const info = await mailpitInfo(apiBase).catch(() => null);
    if (info) return info;
    await delay(100);
  }
  throw new Error(`Mailpit did not become ready at ${apiBase}.`);
}

async function waitForMessage(apiBase, recipient) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const list = await mailpitMessages(apiBase).catch(() => null);
    if (list?.messages_count > 0 && list.messages.some((item) => item.To?.some((target) => target.Address === recipient))) return list;
    await delay(100);
  }
  throw new Error(`Mailpit did not receive a message for ${recipient}.`);
}

async function waitForMessageCount(apiBase, count) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const list = await mailpitMessages(apiBase).catch(() => null);
    if (list?.messages_count === count) return list;
    await delay(100);
  }
  throw new Error(`Mailpit did not reach exactly ${count} messages.`);
}

async function mailpitMessages(apiBase) {
  const response = await fetch(`${apiBase}/api/v1/messages`);
  if (!response.ok) throw new Error(`Mailpit message list failed with HTTP ${response.status}.`);
  return response.json();
}

async function waitForBatch(origin, batchId, status) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await requestJson(origin, `/api/jobs/${JOB_ID}/application-batches/${batchId}`);
    if (response.status === 200 && response.body.status === status) return response.body;
    if (response.status === 200 && ['paused', 'cancelled'].includes(response.body.status)) {
      assert.fail(`Batch stopped in ${response.body.status}: ${JSON.stringify(response.body.items)}`);
    }
    await delay(100);
  }
  throw new Error(`Application batch ${batchId} did not reach ${status}.`);
}

async function mailpitInfo(apiBase) {
  const response = await fetch(`${apiBase}/api/v1/info`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Mailpit health check failed with HTTP ${response.status}.`);
  const info = await response.json();
  if (!String(info.Version || '').startsWith('v')) throw new Error('The configured HTTP endpoint is not Mailpit.');
  return info;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return;
  await Promise.race([once(child, 'exit'), delay(timeoutMilliseconds)]);
}

async function removeDirectoryWithRetry(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || attempt === 9) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function postJson(origin, route, body) {
  return requestJson(origin, `/api/jobs/${JOB_ID}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function requestJson(origin, route, init) {
  const response = await fetch(`${origin}${route}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    assert.fail(`Expected JSON from ${route}, received HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

async function sha256File(filePath) {
  await access(filePath);
  return sha256(await readFile(filePath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
