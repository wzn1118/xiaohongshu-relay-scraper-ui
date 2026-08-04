import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createApp, writeDeliveryState } from './app.mjs';
import { artifactId } from './lib/artifacts.mjs';
import { hashDraftContent } from './lib/draft-store.mjs';

const JOB_ID = '20260731220000-abcdef12';
const NOTE_ID = 'note-http-001';
const RECIPIENT = 'jobs@example.com';
const QUALITY_REPORT_REF = 'application_intelligence.json#/records/0/cover_letter_evaluation';
const VERIFIED_AT = '2026-07-31T12:00:00.000Z';

function originalOutreach(overrides = {}) {
  return {
    greeting: '您好，我想申请内容运营实习岗位。',
    email_subject: '应聘内容运营实习｜示例用户',
    email_body: '您好，我希望申请内容运营实习。我曾负责社交媒体内容运营与市场调研，能够围绕目标受众梳理信息，并根据反馈调整内容重点和推进节奏。这段实践与岗位的内容策划和数据分析要求直接相关，期待进一步了解团队当前最需要推进的任务。',
    cover_letter: '尊敬的招聘负责人：您好。我具备内容运营、用户研究和数据分析经验，能够独立完成内容策划、效果复盘与跨团队协作，希望参与内容运营实习岗位的工作。',
    ...overrides,
  };
}

function applicationRecord(outreach = originalOutreach()) {
  const contentHash = hashDraftContent(outreach);
  return {
    note_id: NOTE_ID,
    title: '内容运营实习',
    body: `招聘内容运营实习，请联系 ${RECIPIENT}`,
    created_at: '2026-07-31T08:00:00.000Z',
    candidate_profile: { name: '示例用户' },
    application_info: {
      contacts: [],
      application_routes: [{
        type: 'email',
        channel: 'email',
        value: RECIPIENT,
        evidence: `请发送至 ${RECIPIENT}`,
        actionable: true,
        verification_status: 'verified',
        confidence: 100,
      }],
      responsibilities: ['内容策划'],
      requirements: ['数据分析'],
    },
    job_card: { role_name: '内容运营实习', parse_basis: 'full_body' },
    outreach,
    cover_letter_evaluation: {
      score: 95,
      threshold: 90,
      passed: true,
      qualityCheckedVersion: 1,
      qualityCheckedHash: contentHash,
      qualityReportRef: QUALITY_REPORT_REF,
    },
  };
}

function qualityReport(overrides = {}) {
  return {
    score: 96,
    threshold: 90,
    passed: true,
    attempts: 1,
    strengths: ['岗位匹配信息具体'],
    problems: [],
    rewrite_instructions: [],
    rubric: { relevance: 96, evidence: 95, clarity: 97 },
    ...overrides,
  };
}

async function startFixture(t, options = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-draft-http-'));
  const staticDir = path.join(fixture, 'dist');
  const outputDir = path.join(fixture, 'artifacts');
  await Promise.all([
    mkdir(staticDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Draft HTTP</title>', 'utf8');

  const record = options.record || applicationRecord();
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    keyword: '内容运营实习',
    analysis_mode: 'job',
    records: [record],
    codex_runtime: { status: 'completed', generated: 1 },
    quality_gate: { passed: true },
  }, null, 2), 'utf8');

  if (options.legacyStateText !== undefined) {
    await writeFile(path.join(outputDir, 'delivery-state.json'), options.legacyStateText, 'utf8');
  }

  const job = {
    id: JOB_ID,
    keyword: '内容运营实习',
    status: 'completed',
    createdAt: '2026-07-31T08:00:00.000Z',
  };
  const internal = {
    ...job,
    outputDir,
    logPath: path.join(fixture, 'run.log'),
    params: {
      keyword: job.keyword,
      candidateProfile: { email: 'candidate@example.com' },
      profileId: options.profileId || '',
      aiSessionId: options.aiSessionId || 'fixture-ai-session',
    },
  };
  const manager = {
    active: null,
    list: () => [job],
    get: (id) => id === JOB_ID ? job : null,
    getInternal: (id) => id === JOB_ID ? internal : null,
  };
  const sentMessages = [];
  const smtpPublic = {
    provider: 'custom',
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    requireTls: false,
    auth: 'login',
    user: 'sender@example.com',
    from: 'sender@example.com',
    hasPassword: true,
    revision: 7,
    configHash: 'fixture-smtp-config-hash',
    credentialRevision: 2,
    ...(options.smtpVerified === false ? {} : { lastVerifiedAt: VERIFIED_AT }),
  };
  const defaultMailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    send: async (message) => {
      sentMessages.push(structuredClone(message));
      return { messageId: `mail-${sentMessages.length}`, accepted: [message.to], rejected: [] };
    },
  };
  const mailSender = options.mailSender || defaultMailSender;
  const resolvedAiSessions = [];
  const aiSessions = options.aiSessions || {
    resolve: (sessionId) => {
      resolvedAiSessions.push(sessionId);
      return { provider: 'fixture', model: 'fixture-quality-model', wireApi: 'responses' };
    },
  };
  const relaySupervisor = {
    snapshot: () => ({ phase: 'idle', inProgress: false }),
    probe: async () => ({ ok: true, ready: true }),
    connect: async () => ({ ok: true, ready: true }),
    recover: async () => ({ ok: true, ready: true }),
  };
  const defaultSmtpConfig = {
    getPublic: () => ({ ...smtpPublic }),
    getForMailer: () => ({ ...smtpPublic, pass: 'stored-secret' }),
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64 * 1024,
      staticDir,
      runnerAvailable: true,
    },
    relayConfig: { get: () => ({ port: 18792, profile: 'chrome', autoConnect: false }) },
    relaySupervisor,
    aiSessions,
    ...(options.profileStore ? { profileStore: options.profileStore } : {}),
    mailSender,
    draftQualityChecker: options.draftQualityChecker || (async () => qualityReport()),
    ...(options.deliveryStateWriter ? { deliveryStateWriter: options.deliveryStateWriter } : {}),
    ...(options.sendAuditAppender ? { sendAuditAppender: options.sendAuditAppender } : {}),
    ...(options.sendAuditReader ? { sendAuditReader: options.sendAuditReader } : {}),
    smtpConfig: options.smtpConfig || defaultSmtpConfig,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(fixture, { recursive: true, force: true });
  });

  return {
    fixture,
    outputDir,
    origin,
    record,
    sentMessages,
    resolvedAiSessions,
    getResults: () => requestJson(origin, `/api/jobs/${JOB_ID}/results?limit=20`),
    request: (route, init) => requestJson(origin, route, init),
    post: (route, body) => requestJson(origin, `/api/jobs/${JOB_ID}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

async function requestJson(origin, route, init) {
  const response = await fetch(`${origin}${route}`, init);
  return { status: response.status, body: await response.json() };
}

async function readDeliveryState(outputDir) {
  return JSON.parse(await readFile(path.join(outputDir, 'delivery-state.json'), 'utf8'));
}

async function fixtureDirForState(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-delivery-state-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return outputDir;
}

async function resolveQualityReportRef(outputDir, reference) {
  const separator = String(reference || '').indexOf('#');
  assert.ok(separator > 0, 'qualityReportRef must contain an artifact path and JSON pointer');
  const relativePath = reference.slice(0, separator);
  const pointer = reference.slice(separator + 1);
  const root = path.resolve(outputDir);
  const absolutePath = path.resolve(root, relativePath);
  assert.ok(absolutePath.startsWith(`${root}${path.sep}`), 'qualityReportRef must stay inside the job artifacts');
  const document = JSON.parse(await readFile(absolutePath, 'utf8'));
  assert.match(pointer, /^\//u);
  const value = pointer.slice(1).split('/').reduce((current, token) => {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    return current?.[key];
  }, document);
  return { absolutePath, pointer, value };
}

async function persistFixtureDeliveryState(outputDir, state) {
  const persisted = {
    ...state,
    _schemaVersion: 2,
    _revision: Math.max(0, Number(state?._revision || 0)) + 1,
  };
  await writeFile(path.join(outputDir, 'delivery-state.json'), JSON.stringify(persisted, null, 2), 'utf8');
  state._schemaVersion = persisted._schemaVersion;
  state._revision = persisted._revision;
}

async function readSendAuditJournal(outputDir) {
  const content = await readFile(path.join(outputDir, 'delivery-send-audit.jsonl'), 'utf8');
  return content.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('legacy artifact exposes all three copy types as a migrated checked v1', async (t) => {
  const fixture = await startFixture(t);
  const response = await fixture.getResults();
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);

  const result = response.body.items[0];
  assert.deepEqual(result.outreach, fixture.record.outreach);
  assert.equal(result.draftVersion.version, 1);
  assert.match(result.draftVersion.draftId, /^draft_[a-f0-9]{64}$/);
  assert.equal(result.draftVersion.contentHash, hashDraftContent(fixture.record.outreach));
  assert.equal(result.draftVersion.qualityStatus, 'passed');
  assert.equal(result.draftVersion.qualityCheckedVersion, 1);
  assert.equal(result.draftVersion.qualityCheckedHash, result.draftVersion.contentHash);
  assert.equal(result.draftVersion.qualityReportRef, QUALITY_REPORT_REF);
  assert.ok(result.outreach.greeting);
  assert.ok(result.outreach.email_subject && result.outreach.email_body);
  assert.ok(result.outreach.cover_letter);
});

test('checkpoint-only migration binds the quality report reference to the artifact actually read', async (t) => {
  const record = applicationRecord();
  delete record.cover_letter_evaluation.qualityReportRef;
  const fixture = await startFixture(t, { record });
  const finalPath = path.join(fixture.outputDir, 'application_intelligence.json');
  const checkpointPath = path.join(fixture.outputDir, 'application_intelligence.checkpoint.json');
  await rm(finalPath);
  await writeFile(checkpointPath, JSON.stringify({
    keyword: 'checkpoint-only-fixture',
    analysis_mode: 'job',
    records: [record],
    codex_runtime: { status: 'running', generated: 1 },
    quality_gate: { passed: true },
  }, null, 2), 'utf8');

  const response = await fixture.getResults();
  assert.equal(response.status, 200);
  const result = response.body.items[0];
  const expectedRef = 'application_intelligence.checkpoint.json#/records/0/cover_letter_evaluation';
  assert.equal(result.draftVersion.qualityStatus, 'passed');
  assert.equal(result.draftVersion.qualityReportRef, expectedRef);

  const located = await resolveQualityReportRef(fixture.outputDir, result.draftVersion.qualityReportRef);
  assert.equal(located.absolutePath, checkpointPath);
  assert.equal(located.pointer, '/records/0/cover_letter_evaluation');
  assert.deepEqual(located.value, record.cover_letter_evaluation);
  assert.equal(result.draftVersion.qualityCheckedHash, hashDraftContent(record.outreach));
});

test('one-character save creates immutable stale v2 and retains checked v1', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const edited = {
    ...initial.outreach,
    cover_letter: `${initial.outreach.cover_letter}。`,
  };

  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: edited,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.outreach, edited);
  assert.equal(saved.body.draftVersion.version, 2);
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');
  assert.equal(saved.body.draftVersion.qualityCheckedVersion, null);
  assert.equal(saved.body.draftVersion.qualityCheckedHash, null);
  assert.notEqual(saved.body.draftVersion.contentHash, initial.draftVersion.contentHash);

  const state = await readDeliveryState(fixture.outputDir);
  const store = state[NOTE_ID].draftStore;
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.currentVersion, 2);
  assert.equal(store.versions.length, 2);
  assert.deepEqual(store.versions[0].content, fixture.record.outreach);
  assert.equal(store.versions[0].contentHash, initial.draftVersion.contentHash);
  assert.equal(store.versions[0].qualityStatus, 'passed');
  assert.deepEqual(store.versions[1].content, edited);
  assert.equal(store.versions[1].qualityStatus, 'stale');
});

test('concurrent saves from one baseVersion produce one v2 and one 409 conflict', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const request = (suffix) => fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: 1,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting}${suffix}` },
  });

  const attempts = await Promise.all([request('A'), request('B')]);
  const success = attempts.find((item) => item.status === 200);
  const conflict = attempts.find((item) => item.status === 409);
  assert.ok(success);
  assert.ok(conflict);
  assert.equal(conflict.body.error.code, 'DRAFT_VERSION_CONFLICT');
  assert.equal(conflict.body.expectedVersion, 1);
  assert.equal(conflict.body.currentVersion, 2);

  const state = await readDeliveryState(fixture.outputDir);
  const store = state[NOTE_ID].draftStore;
  assert.equal(store.currentVersion, 2);
  assert.equal(store.versions.length, 2);
  assert.equal(store.versions[1].contentHash, success.body.draftVersion.contentHash);
  assert.deepEqual(store.versions[0].content, initial.outreach);
});

test('a stale versionless legacy save cannot overwrite a newer versioned draft', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const newer = {
    ...initial.outreach,
    greeting: `${initial.outreach.greeting} new-client-v2`,
  };
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: newer,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.draftVersion.version, 2);

  const staleLegacyBody = {
    ...initial.outreach,
    cover_letter: `${initial.outreach.cover_letter} stale-legacy-edit`,
  };
  const conflict = await fixture.post('draft', {
    noteId: NOTE_ID,
    outreach: staleLegacyBody,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'DRAFT_VERSION_CONFLICT');
  assert.equal(conflict.body.currentVersion, 2);

  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].draftStore.currentVersion, 2);
  assert.equal(state[NOTE_ID].draftStore.versions.length, 2);
  assert.deepEqual(state[NOTE_ID].draftStore.versions[1].content, newer);
  const latest = (await fixture.getResults()).body.items[0];
  assert.equal(latest.draftVersion.version, 2);
  assert.deepEqual(latest.outreach, newer);
});

test('direct body injection and an unchecked saved version are both blocked', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];

  const injected = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting}。` },
  });
  assert.equal(injected.status, 400);
  assert.equal(injected.body.error.code, 'DRAFT_REQUEST_CONTENT_MISMATCH');
  assert.equal(fixture.sentMessages.length, 0);

  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: 1,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting}。` },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');

  const unchecked = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
  });
  assert.equal(unchecked.status, 400);
  assert.equal(unchecked.body.error.code, 'DRAFT_QUALITY_STALE');
  assert.equal(fixture.sentMessages.length, 0);
});

test('verified SMTP accepts the checked v1 through the legacy send format and records exact audit data', async (t) => {
  const fixture = await startFixture(t);
  const before = Date.now();
  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    outreach: fixture.record.outreach,
  });
  const after = Date.now();

  assert.equal(sent.status, 200);
  assert.equal(sent.body.draftVersion.version, 1);
  assert.equal(sent.body.draftVersion.qualityStatus, 'passed');
  assert.equal(sent.body.delivery.action, 'email_sent');
  assert.equal(fixture.sentMessages.length, 1);
  assert.deepEqual(fixture.sentMessages[0], {
    to: RECIPIENT,
    subject: fixture.record.outreach.email_subject,
    text: fixture.record.outreach.email_body,
    replyTo: 'candidate@example.com',
  });

  const expectedHash = hashDraftContent(fixture.record.outreach);
  assert.equal(sent.body.delivery.sendAudit.length, 1);
  const audit = sent.body.delivery.sendAudit[0];
  assert.equal(audit.draftId, sent.body.draftVersion.draftId);
  assert.equal(audit.version, 1);
  assert.equal(audit.draftVersion, 1);
  assert.equal(audit.contentHash, expectedHash);
  assert.equal(audit.recipient, 'j***@example.com');
  assert.match(audit.recipientHash, /^[a-f0-9]{64}$/u);
  assert.equal(audit.status, 'sent');
  assert.equal(audit.errorCode, '');
  assert.equal(audit.configHash, 'fixture-smtp-config-hash');
  assert.equal(audit.credentialRevision, 2);
  assert.equal(audit.qualityReportRef, QUALITY_REPORT_REF);
  assert.equal(audit.messageId, 'mail-1');
  assert.equal(audit.attachmentCount, 0);
  assert.deepEqual(audit.attachments, []);
  assert.equal(audit.timestamp, audit.sentAt);
  assert.equal(Object.hasOwn(audit, 'text'), false);
  assert.equal(Object.hasOwn(audit, 'body'), false);
  assert.equal(Object.hasOwn(audit, 'password'), false);
  assert.ok(Date.parse(audit.sentAt) >= before);
  assert.ok(Date.parse(audit.sentAt) <= after);

  const persisted = await readDeliveryState(fixture.outputDir);
  assert.deepEqual(persisted[NOTE_ID].sendAudit, [audit]);
});

test('generic multipart uploads ignore forged generated provenance and draft bindings', async (t) => {
  const fixture = await startFixture(t);
  const form = new FormData();
  form.append('noteId', NOTE_ID);
  form.append('source', 'generated_cover_letter');
  form.append('generatedFrom', 'draft:forged-draft:v999');
  form.append('draftId', 'forged-draft');
  form.append('draftVersion', '999');
  form.append('version', '999');
  form.append('file', new Blob([
    Buffer.from('%PDF-1.7\nuntrusted provenance fields\n%%EOF\n', 'utf8'),
  ], { type: 'application/pdf' }), 'resume.pdf');

  const response = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.attachment.source, 'uploaded');
  assert.equal(response.body.attachment.generatedFrom, '');
  assert.equal(response.body.attachment.draftId, '');
  assert.equal(response.body.attachment.draftVersion, 0);

  const listed = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments?noteId=${NOTE_ID}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.attachments[0].source, 'uploaded');
  assert.equal(listed.body.attachments[0].generatedFrom, '');
  assert.equal(listed.body.attachments[0].draftId, '');
  assert.equal(listed.body.attachments[0].draftVersion, 0);
});

test('dedicated artifact and Cover Letter imports retain trusted provenance and reject stale drafts', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const relativeArtifact = 'portfolio.txt';
  const artifactBytes = Buffer.from('Verified portfolio artifact for this Job.', 'utf8');
  const sourceArtifactId = artifactId(relativeArtifact);
  await writeFile(path.join(fixture.outputDir, relativeArtifact), artifactBytes);

  const importedArtifact = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/from-artifact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      artifactId: sourceArtifactId,
      noteId: NOTE_ID,
      displayName: 'portfolio-evidence.txt',
      draftId: initial.draftVersion.draftId,
      draftVersion: initial.draftVersion.version,
    }),
  });
  assert.equal(importedArtifact.status, 201, JSON.stringify(importedArtifact.body));
  assert.equal(importedArtifact.body.attachment.source, 'job_artifact');
  assert.equal(importedArtifact.body.attachment.generatedFrom, `artifact:${sourceArtifactId}`);
  assert.deepEqual(await readFile(
    path.join(
      fixture.outputDir,
      'application-attachments',
      NOTE_ID,
      `${importedArtifact.body.attachment.attachmentId}.txt`,
    ),
  ), artifactBytes);

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    contentHash: initial.draftVersion.contentHash,
    attachmentIds: [importedArtifact.body.attachment.attachmentId],
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));

  const importedCoverLetter = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/from-cover-letter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      draftVersion: initial.draftVersion.version,
    }),
  });
  assert.equal(importedCoverLetter.status, 201, JSON.stringify(importedCoverLetter.body));
  assert.equal(importedCoverLetter.body.attachment.source, 'generated_cover_letter');
  assert.equal(
    importedCoverLetter.body.attachment.generatedFrom,
    `draft:${initial.draftVersion.draftId}:v${initial.draftVersion.version}`,
  );
  assert.equal(importedCoverLetter.body.attachment.draftId, initial.draftVersion.draftId);
  assert.equal(importedCoverLetter.body.attachment.draftVersion, initial.draftVersion.version);
  assert.equal(
    await readFile(
      path.join(
        fixture.outputDir,
        'application-attachments',
        NOTE_ID,
        `${importedCoverLetter.body.attachment.attachmentId}.txt`,
      ),
      'utf8',
    ),
    initial.outreach.cover_letter,
  );

  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: {
      ...initial.outreach,
      cover_letter: `${initial.outreach.cover_letter} Updated application evidence.`,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const stale = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/from-cover-letter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      draftVersion: initial.draftVersion.version,
    }),
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'DRAFT_VERSION_CONFLICT');
});

test('attachment APIs preview and deliver immutable PDF and DOCX bundles with UTF-8 names', async (t) => {
  const delivered = [];
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    send: async (message) => {
      delivered.push({
        ...structuredClone(message),
        attachments: await Promise.all((message.attachments || []).map(async (item) => ({
          filename: item.filename,
          contentType: item.contentType,
          bytes: await readFile(item.path),
        }))),
      });
      return { messageId: `attachment-mail-${delivered.length}`, accepted: [message.to], rejected: [] };
    },
  };
  const fixture = await startFixture(t, { mailSender });
  const initial = (await fixture.getResults()).body.items[0];
  const pdfBytes = Buffer.from('%PDF-1.7\nfixture resume\n%%EOF\n', 'utf8');
  const docxBytes = Buffer.concat([
    Buffer.from('504b0304', 'hex'),
    Buffer.from('[Content_Types].xml\nword/document.xml\nportfolio', 'utf8'),
  ]);

  const upload = async (name, type, bytes) => {
    const form = new FormData();
    form.append('noteId', NOTE_ID);
    form.append('source', 'uploaded');
    form.append('draftId', initial.draftVersion.draftId);
    form.append('draftVersion', String(initial.draftVersion.version));
    form.append('file', new Blob([bytes], { type }), name);
    return fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, { method: 'POST', body: form });
  };

  const pdf = await upload('中文简历.pdf', 'application/pdf', pdfBytes);
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  const duplicate = await upload('简历副本.pdf', 'application/pdf', pdfBytes);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const docx = await upload('项目说明.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBytes);
  assert.equal(docx.status, 201);

  const listed = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments?noteId=${NOTE_ID}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.attachments.length, 2);
  assert.deepEqual(listed.body.attachments.map((item) => item.displayName), ['中文简历.pdf', '项目说明.docx']);

  const attachmentIds = listed.body.attachments.map((item) => item.attachmentId);
  const missingAttachment = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: ['00000000-0000-4000-8000-000000000000'],
  });
  assert.equal(missingAttachment.status, 404, JSON.stringify(missingAttachment.body));
  assert.equal(missingAttachment.body.error.code, 'ATTACHMENT_NOT_FOUND');

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    contentHash: initial.draftVersion.contentHash,
    attachmentIds,
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));

  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.from, 'sender@example.com');
  assert.equal(preview.body.attachmentSummary.count, 2);
  assert.equal(preview.body.attachmentSummary.totalBytes, pdfBytes.length + docxBytes.length);
  assert.equal(preview.body.smtpConfigurationRevision, 7);
  assert.match(preview.body.smtpConfigurationFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(preview.body.quality.evaluation.passed, true);
  assert.equal(preview.body.readiness, 'ready');

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds,
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'attachment-send-v1',
  });
  assert.equal(sent.status, 200);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].attachments.map((item) => [item.filename, item.contentType]), [
    ['中文简历.pdf', 'application/pdf'],
    ['项目说明.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ]);
  assert.deepEqual(delivered[0].attachments[0].bytes, pdfBytes);
  assert.deepEqual(delivered[0].attachments[1].bytes, docxBytes);
  assert.equal(sent.body.delivery.sendAudit[0].attachmentCount, 2);
  assert.equal(sent.body.delivery.sendAudit[0].attachments.some((item) => Object.hasOwn(item, 'path')), false);

  const bundleDir = path.join(fixture.outputDir, 'application-attachments', 'send-bundles', sent.body.sendId);
  const bundleManifest = JSON.parse(await readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
  assert.equal(bundleManifest.attachmentBundleHash, preview.body.attachmentBundleHash);
  assert.equal(bundleManifest.smtpConfigurationRevision, 7);
  assert.equal(bundleManifest.smtpConfigurationFingerprint, preview.body.smtpConfigurationFingerprint);
  assert.equal(sent.body.delivery.sendAudit[0].smtpConfigurationRevision, 7);
  assert.equal(sent.body.delivery.sendAudit[0].smtpConfigurationFingerprint, preview.body.smtpConfigurationFingerprint);
  const bundledPdf = await readFile(path.join(bundleDir, 'attachments', `${attachmentIds[0]}.pdf`));
  assert.equal(createHash('sha256').update(bundledPdf).digest('hex'), pdf.body.attachment.sha256);

  const noteBytes = Buffer.from('Portfolio summary with a different attachment identity.', 'utf8');
  const noteAttachment = await upload('补充说明.txt', 'text/plain', noteBytes);
  assert.equal(noteAttachment.status, 201);
  const changedQuality = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    contentHash: initial.draftVersion.contentHash,
    attachmentIds: [noteAttachment.body.attachment.attachmentId],
  });
  assert.equal(changedQuality.status, 200, JSON.stringify(changedQuality.body));
  const changedPreview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [noteAttachment.body.attachment.attachmentId],
  });
  assert.equal(changedPreview.status, 200);
  assert.notEqual(changedPreview.body.attachmentBundleHash, preview.body.attachmentBundleHash);
  const changedSend = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [noteAttachment.body.attachment.attachmentId],
    attachmentBundleHash: changedPreview.body.attachmentBundleHash,
    previewRevision: changedPreview.body.previewRevision,
    idempotencyKey: 'attachment-send-v2',
  });
  assert.equal(changedSend.status, 200);
  assert.equal(delivered.length, 2);
  assert.notEqual(changedSend.body.sendIdempotencyKey, sent.body.sendIdempotencyKey);
  assert.notEqual(changedSend.body.sendId, sent.body.sendId);
  assert.deepEqual(delivered[1].attachments[0].bytes, noteBytes);

  await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentIds[0]}`, { method: 'DELETE' });
  assert.deepEqual(await readFile(path.join(bundleDir, 'attachments', `${attachmentIds[0]}.pdf`)), pdfBytes);
});

test('modern send requests require an idempotency key and a current preview even with no attachments', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
  };

  const missingKey = await fixture.post('send-email', request);
  assert.equal(missingKey.status, 409);
  assert.equal(missingKey.body.error.code, 'EMAIL_IDEMPOTENCY_REQUIRED');

  const missingPreview = await fixture.post('send-email', { ...request, idempotencyKey: 'modern-empty-v1' });
  assert.equal(missingPreview.status, 409);
  assert.equal(missingPreview.body.error.code, 'EMAIL_PREVIEW_REQUIRED');
  assert.equal(fixture.sentMessages.length, 0);
});

test('changing the SMTP configuration after preview makes a modern send stale', async (t) => {
  let smtpRevision = 7;
  let smtpHash = 'smtp-config-v7';
  const smtpConfig = {
    getPublic: () => ({
      from: 'sender@example.com',
      revision: smtpRevision,
      configHash: smtpHash,
      credentialRevision: 2,
      lastVerifiedAt: VERIFIED_AT,
    }),
    getForMailer: () => ({}),
  };
  const fixture = await startFixture(t, { smtpConfig });
  const initial = (await fixture.getResults()).body.items[0];
  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 200);

  smtpRevision = 8;
  smtpHash = 'smtp-config-v8';
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'smtp-stale-v1',
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'EMAIL_PREVIEW_STALE');
  assert.equal(fixture.sentMessages.length, 0);
});

test('changing SMTP during live verification is caught before modern delivery', async (t) => {
  let smtpRevision = 7;
  let smtpHash = 'smtp-config-v7';
  let sendCalls = 0;
  const smtpConfig = {
    getPublic: () => ({
      from: 'sender@example.com',
      revision: smtpRevision,
      configHash: smtpHash,
      credentialRevision: 2,
      lastVerifiedAt: VERIFIED_AT,
    }),
    getForMailer: () => ({}),
  };
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => {
      smtpRevision = 8;
      smtpHash = 'smtp-config-v8';
    },
    send: async () => {
      sendCalls += 1;
      return { messageId: 'must-not-send', accepted: [RECIPIENT], rejected: [] };
    },
  };
  const fixture = await startFixture(t, { smtpConfig, mailSender });
  const initial = (await fixture.getResults()).body.items[0];
  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 200);

  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'smtp-race-v1',
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'EMAIL_PREVIEW_STALE');
  assert.equal(sendCalls, 0);
});

test('preview reports exact quality evidence and blocks readiness for unverified SMTP', async (t) => {
  const fixture = await startFixture(t, { smtpVerified: false });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.readiness, 'blocked');
  assert.equal(response.body.smtp.verificationStatus, 'unverified');
  assert.equal(response.body.warnings.some((warning) => warning.code === 'SMTP_NOT_VERIFIED' && warning.blocking), true);
  assert.equal(response.body.quality.evaluation.score, 95);
  assert.equal(response.body.quality.evaluation.passed, true);
  assert.equal(response.body.quality.qualityReportRef, QUALITY_REPORT_REF);
});

test('preview and send persist ready, in-flight, sent, and blocked delivery states', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.readiness, 'ready');

  const previewState = await readDeliveryState(fixture.outputDir);
  assert.equal(previewState[NOTE_ID].deliveryStatus, 'preview_ready');
  assert.deepEqual(
    previewState[NOTE_ID].deliveryTransitions.map((transition) => transition.status),
    ['preview_ready'],
  );

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds: [],
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'delivery-state-transitions-v1',
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.delivery.deliveryStatus, 'sent');
  assert.deepEqual(
    sent.body.delivery.deliveryTransitions.map((transition) => transition.status),
    ['preview_ready', 'preparing', 'sending', 'sent'],
  );
  const sentState = await readDeliveryState(fixture.outputDir);
  assert.equal(sentState[NOTE_ID].deliveryStatus, 'sent');
  assert.deepEqual(
    sentState[NOTE_ID].deliveryTransitions.map((transition) => transition.status),
    ['preview_ready', 'preparing', 'sending', 'sent'],
  );

  const blockedFixture = await startFixture(t, { smtpVerified: false });
  const blockedInitial = (await blockedFixture.getResults()).body.items[0];
  const blockedPreview = await blockedFixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: blockedInitial.draftVersion.draftId,
    version: blockedInitial.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(blockedPreview.status, 200, JSON.stringify(blockedPreview.body));
  assert.equal(blockedPreview.body.readiness, 'blocked');
  const blockedState = await readDeliveryState(blockedFixture.outputDir);
  assert.equal(blockedState[NOTE_ID].deliveryStatus, 'blocked');
  assert.deepEqual(
    blockedState[NOTE_ID].deliveryTransitions.map((transition) => transition.status),
    ['blocked'],
  );
});

test('candidate profile attachments are imported only from the profile bound to the Job', async (t) => {
  const profileId = '0123456789abcdef';
  const calls = [];
  const pdf = Buffer.from('%PDF-1.7\nprofile resume\n%%EOF\n', 'utf8');
  const profileStore = {
    readSourceFile: async (id, sourceFile) => {
      calls.push([id, sourceFile]);
      return {
        originalName: '中文简历.pdf',
        clientMediaType: 'application/pdf',
        buffer: pdf,
      };
    },
  };
  const fixture = await startFixture(t, { profileId, profileStore });
  const initial = (await fixture.getResults()).body.items[0];
  const imported = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/from-profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId,
      sourceFile: '01-中文简历.pdf',
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      draftVersion: initial.draftVersion.version,
    }),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(calls, [[profileId, '01-中文简历.pdf']]);
  assert.equal(imported.body.attachment.source, 'candidate_profile');
  assert.equal(imported.body.attachment.generatedFrom, `candidate_profile:${profileId}`);
  assert.deepEqual(await readFile(
    path.join(fixture.outputDir, 'application-attachments', NOTE_ID, `${imported.body.attachment.attachmentId}.pdf`),
  ), pdf);
  const afterImport = (await fixture.getResults()).body.items[0];
  assert.equal(afterImport.draftVersion.version, initial.draftVersion.version);
  assert.equal(afterImport.draftVersion.qualityStatus, 'stale');

  const mismatch = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/from-profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: 'fedcba9876543210',
      sourceFile: '01-中文简历.pdf',
      noteId: NOTE_ID,
    }),
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'PROFILE_SOURCE_JOB_MISMATCH');
  assert.equal(calls.length, 1);
});

test('attachment selection changes stale current quality without creating a draft version', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const pdf = Buffer.from('%PDF-1.7\nquality binding resume\n%%EOF\n', 'utf8');
  const uploadForm = () => {
    const form = new FormData();
    form.append('noteId', NOTE_ID);
    form.append('source', 'uploaded');
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');
    return form;
  };
  const currentResult = async () => (await fixture.getResults()).body.items[0];
  const recheck = async (attachmentIds) => {
    const current = await currentResult();
    const checked = await fixture.post('draft/quality', {
      noteId: NOTE_ID,
      draftId: current.draftVersion.draftId,
      version: current.draftVersion.version,
      contentHash: current.draftVersion.contentHash,
      attachmentIds,
    });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    return checked.body;
  };

  const created = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, {
    method: 'POST',
    body: uploadForm(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const attachmentId = created.body.attachment.attachmentId;
  assert.equal(created.body.attachmentBundleChanged, true);
  assert.equal((await currentResult()).draftVersion.qualityStatus, 'stale');
  assert.equal((await currentResult()).draftVersion.version, initial.draftVersion.version);

  await recheck([attachmentId]);
  assert.equal((await currentResult()).draftVersion.qualityStatus, 'passed');
  const duplicate = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, {
    method: 'POST',
    body: uploadForm(),
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.attachmentBundleChanged, false);
  assert.equal((await currentResult()).draftVersion.qualityStatus, 'passed');

  const deselected = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: false }),
  });
  assert.equal(deselected.status, 200, JSON.stringify(deselected.body));
  assert.equal(deselected.body.attachmentBundleChanged, true);
  assert.equal((await currentResult()).draftVersion.qualityStatus, 'stale');
  await recheck([]);

  const reselected = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: true }),
  });
  assert.equal(reselected.status, 200, JSON.stringify(reselected.body));
  assert.equal((await currentResult()).draftVersion.qualityStatus, 'stale');
  await recheck([attachmentId]);

  const deleted = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const afterDelete = await currentResult();
  assert.equal(afterDelete.draftVersion.qualityStatus, 'stale');
  assert.equal(afterDelete.draftVersion.version, initial.draftVersion.version);
});

test('normal resume attachment wording is accepted when the selected bundle matches it', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: {
      ...initial.outreach,
      email_body: `${initial.outreach.email_body}\n随信附上我的简历，期待进一步沟通。`,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const form = new FormData();
  form.append('noteId', NOTE_ID);
  form.append('source', 'uploaded');
  form.append('file', new Blob([Buffer.from('%PDF-1.7\nresume\n%%EOF\n')], { type: 'application/pdf' }), 'resume.pdf');
  const uploaded = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const attachmentIds = [uploaded.body.attachment.attachmentId];
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    attachmentIds,
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    attachmentIds,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.warnings.some((warning) => warning.blocking), false);
});

test('configured but unverified SMTP is rejected before mail delivery', async (t) => {
  const fixture = await startFixture(t, { smtpVerified: false });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'DRAFT_SMTP_NOT_VERIFIED');
  assert.equal(fixture.sentMessages.length, 0);
});

test('an expired verification is rejected before transport verification or delivery', async (t) => {
  let verifyCalls = 0;
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => { verifyCalls += 1; },
    send: async () => { throw new Error('send must remain blocked'); },
  };
  const smtpConfig = {
    getPublic: () => ({ lastVerifiedAt: VERIFIED_AT, verified: false }),
    getForMailer: () => ({}),
    assertReadyForSend: () => {
      const error = new Error('SMTP verification expired.');
      error.code = 'SMTP_VERIFICATION_EXPIRED';
      throw error;
    },
  };
  const fixture = await startFixture(t, { mailSender, smtpConfig });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'SMTP_VERIFICATION_EXPIRED');
  assert.equal(verifyCalls, 0);
});

test('live transport verification failure blocks delivery and writes a masked failure audit', async (t) => {
  let sendCalls = 0;
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => {
      const error = new Error('fixture TLS verification failed');
      error.code = 'SMTP_TLS_FAILED';
      throw error;
    },
    send: async () => { sendCalls += 1; },
  };
  const fixture = await startFixture(t, { mailSender });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'SMTP_TLS_FAILED');
  assert.equal(sendCalls, 0);
  const state = await readDeliveryState(fixture.outputDir);
  const audit = state[NOTE_ID].sendAudit.at(-1);
  assert.equal(audit.recipient, 'j***@example.com');
  assert.equal(audit.status, 'failed');
  assert.equal(audit.errorCode, 'SMTP_TLS_FAILED');
  assert.equal(audit.draftVersion, initial.draftVersion.version);
  assert.equal(Object.hasOwn(audit, 'body'), false);
});

test('a stale SMTP verification timestamp cannot bypass the current configuration fingerprint', async (t) => {
  const smtpConfig = {
    getPublic: () => ({
      provider: 'custom',
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: 'login',
      from: 'sender@example.com',
      hasPassword: true,
      lastVerifiedAt: VERIFIED_AT,
      verified: false,
    }),
    getForMailer: () => ({}),
    isVerified: () => false,
  };
  const fixture = await startFixture(t, { smtpConfig });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'DRAFT_SMTP_NOT_VERIFIED');
  assert.equal(fixture.sentMessages.length, 0);
});

test('SMTP verification reports a version conflict when the tested configuration changed', async (t) => {
  let receivedFingerprint = null;
  const smtpConfig = {
    getPublic: () => ({ lastVerifiedAt: '', verified: false }),
    getForMailer: () => ({}),
    getVerificationSnapshot: () => ({ revision: 4, fingerprint: 'fingerprint-before-test' }),
    markVerified: async (fingerprint) => {
      receivedFingerprint = fingerprint;
      const error = new Error('SMTP configuration changed while verification was in progress.');
      error.code = 'SMTP_CONFIG_CONFLICT';
      error.currentRevision = 5;
      throw error;
    },
  };
  const fixture = await startFixture(t, { smtpConfig });
  const response = await fixture.request('/api/email/test', { method: 'POST' });

  assert.deepEqual(receivedFingerprint, { revision: 4, fingerprint: 'fingerprint-before-test' });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'SMTP_CONFIG_CONFLICT');
  assert.equal(response.body.currentRevision, 5);
});

test('the first versioned write preserves an exact backup of legacy delivery-state', async (t) => {
  const legacyState = {
    [NOTE_ID]: {
      action: 'draft_saved',
      updatedAt: '2026-07-31T09:00:00.000Z',
      draft: originalOutreach(),
    },
  };
  const legacyStateText = JSON.stringify(legacyState, null, 2);
  const fixture = await startFixture(t, { legacyStateText });
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting}。` },
  });
  assert.equal(response.status, 200);

  const backup = await readFile(path.join(fixture.outputDir, 'delivery-state.v1.backup.json'), 'utf8');
  assert.equal(backup, legacyStateText);
  const persisted = await readDeliveryState(fixture.outputDir);
  assert.equal(persisted._schemaVersion, 2);
  assert.equal(persisted._revision, 1);
  assert.equal(persisted[NOTE_ID].draftStore.schemaVersion, 2);
});

test('a malformed delivery-state fails closed and cannot be replaced by a new send or draft', async (t) => {
  const legacyStateText = '{"broken":';
  const fixture = await startFixture(t, { legacyStateText });
  const initialResponse = await fixture.getResults();
  assert.equal(initialResponse.status, 500);
  assert.equal(initialResponse.body.error.code, 'DELIVERY_STATE_INVALID');

  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: 'untrusted',
    baseVersion: 1,
    outreach: originalOutreach(),
  });
  assert.equal(saved.status, 500);
  assert.equal(saved.body.error.code, 'DELIVERY_STATE_INVALID');
  assert.equal(await readFile(path.join(fixture.outputDir, 'delivery-state.json'), 'utf8'), legacyStateText);
});

test('a malformed delivery audit journal fails closed before SMTP delivery', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  await writeFile(path.join(fixture.outputDir, 'delivery-send-audit.jsonl'), '{"truncated":\n', 'utf8');

  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'DELIVERY_AUDIT_INVALID');
  assert.equal(fixture.sentMessages.length, 0);
});

test('delivery-state writes reject a stale revision instead of overwriting newer state', async (t) => {
  const outputDir = await fixtureDirForState(t);
  const first = { [NOTE_ID]: { action: 'draft_saved' } };
  await writeDeliveryState(outputDir, first);
  const stale = structuredClone(first);
  const current = structuredClone(first);
  current[NOTE_ID].action = 'email_sent';
  await writeDeliveryState(outputDir, current);

  stale[NOTE_ID].action = 'email_failed';
  await assert.rejects(writeDeliveryState(outputDir, stale), (error) => {
    assert.equal(error.code, 'DELIVERY_STATE_REVISION_CONFLICT');
    assert.equal(error.expectedRevision, 1);
    assert.equal(error.currentRevision, 2);
    return true;
  });
  assert.equal((await readDeliveryState(outputDir))[NOTE_ID].action, 'email_sent');
});

test('legacy recipient evidence without a channel remains send-compatible', async (t) => {
  const record = applicationRecord();
  record.application_info.application_routes = [{
    type: 'contact',
    value: RECIPIENT,
    evidence: `legacy contact: ${RECIPIENT}`,
    actionable: true,
    verification_status: 'verified',
  }];
  const fixture = await startFixture(t, { record });
  const response = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    outreach: record.outreach,
  });

  assert.equal(response.status, 200);
  assert.equal(fixture.sentMessages.length, 1);
  assert.equal(fixture.sentMessages[0].to, RECIPIENT);
});

test('quality recheck binds the exact saved version and hash to a resolvable report before send', async (t) => {
  const checkerCalls = [];
  const resolvedSessions = [];
  const aiRuntime = { provider: 'fixture', model: 'quality-v1', wireApi: 'responses' };
  const fixture = await startFixture(t, {
    aiSessionId: 'quality-session-001',
    aiSessions: {
      resolve: (sessionId) => {
        resolvedSessions.push(sessionId);
        return aiRuntime;
      },
    },
    draftQualityChecker: async (payload, ai) => {
      checkerCalls.push({ payload: structuredClone(payload), ai });
      return qualityReport();
    },
  });
  const initial = (await fixture.getResults()).body.items[0];
  const edited = {
    ...initial.outreach,
    cover_letter: `${initial.outreach.cover_letter} 我也能根据数据复盘持续优化内容。`,
  };
  const applicationContext = {
    channel: 'email',
    contactStage: 'follow_up',
    tone: 'concise',
    resumeAttached: true,
    coverLetterAttached: false,
    recipientType: 'hiring manager',
  };
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: edited,
    applicationContext,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');

  const peerNoteId = 'note-http-peer';
  const peerEmailBody = 'A separately saved application email for cross-message similarity checking.';
  const stateWithPeer = await readDeliveryState(fixture.outputDir);
  stateWithPeer[peerNoteId] = {
    action: 'draft_saved',
    draft: { email_body: peerEmailBody },
  };
  await writeDeliveryState(fixture.outputDir, stateWithPeer);

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    aiSessionId: 'quality-session-001',
    applicationContext,
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.draftVersion.version, saved.body.draftVersion.version);
  assert.equal(checked.body.draftVersion.contentHash, saved.body.draftVersion.contentHash);
  assert.equal(checked.body.draftVersion.qualityStatus, 'passed');
  assert.equal(checked.body.draftVersion.qualityCheckedVersion, saved.body.draftVersion.version);
  assert.equal(checked.body.draftVersion.qualityCheckedHash, saved.body.draftVersion.contentHash);
  assert.equal(checked.body.cover_letter_evaluation.passed, true);
  assert.deepEqual(resolvedSessions, ['quality-session-001']);
  assert.equal(checkerCalls.length, 1);
  assert.deepEqual(checkerCalls[0].payload.draft, edited);
  assert.deepEqual(checkerCalls[0].payload.applicationContext, applicationContext);
  assert.deepEqual(checkerCalls[0].payload.record.applicationContext, applicationContext);
  assert.equal(checkerCalls[0].payload.threshold, 90);
  assert.equal(checkerCalls[0].payload.attachmentContext.count, 0);
  assert.equal(checkerCalls[0].payload.attachmentContext.attachments.length, 0);
  assert.deepEqual(checkerCalls[0].payload.attachmentContext.peerDrafts, [{
    noteId: peerNoteId,
    emailBody: peerEmailBody,
  }]);
  assert.match(checkerCalls[0].payload.attachmentContext.attachmentBundleHash, /^[a-f0-9]{64}$/u);
  assert.equal(checkerCalls[0].ai, aiRuntime);

  const located = await resolveQualityReportRef(fixture.outputDir, checked.body.draftVersion.qualityReportRef);
  assert.equal(located.absolutePath, path.join(fixture.outputDir, 'delivery-state.json'));
  assert.equal(located.value.draftId, saved.body.draftVersion.draftId);
  assert.equal(located.value.version, saved.body.draftVersion.version);
  assert.equal(located.value.contentHash, saved.body.draftVersion.contentHash);
  assert.deepEqual(located.value.applicationContext, applicationContext);
  assert.match(located.value.applicationContextHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(located.value.attachmentContext.peerDrafts, [{
    noteId: peerNoteId,
    emailBody: peerEmailBody,
  }]);
  assert.equal(located.value.evaluation.passed, true);

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
    contentHash: checked.body.draftVersion.contentHash,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivery.action, 'email_sent');
  assert.equal(fixture.sentMessages.length, 1);
});

test('draft save normalizes and persists application context for subsequent reads', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: initial.outreach,
    applicationContext: {
      channel: 'unsupported',
      contactStage: 'follow_up',
      tone: 'formal',
      resumeAttached: true,
      coverLetterAttached: 'yes',
      recipientType: '  recruiter lead  ',
    },
  });

  const expected = {
    channel: 'email',
    contactStage: 'follow_up',
    tone: 'formal',
    resumeAttached: true,
    coverLetterAttached: false,
    recipientType: 'recruiter lead',
  };
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.outreach.applicationContext, expected);
  assert.equal(saved.body.draftVersion.version, initial.draftVersion.version);
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');

  const state = await readDeliveryState(fixture.outputDir);
  assert.deepEqual(state[NOTE_ID].applicationContext, expected);
  assert.match(state[NOTE_ID].applicationContextHash, /^[a-f0-9]{64}$/u);

  const refreshed = (await fixture.getResults()).body.items[0];
  assert.deepEqual(refreshed.outreach.applicationContext, expected);
  assert.equal(refreshed.draftVersion.qualityStatus, 'stale');
  assert.equal(refreshed.cover_letter_evaluation, null);
});

test('changing application context stales quality and blocks preview and send until rechecked', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const firstContext = {
    channel: 'email',
    contactStage: 'first_contact',
    tone: 'natural',
    resumeAttached: false,
    coverLetterAttached: false,
    recipientType: 'recruiter',
  };
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: initial.outreach,
    applicationContext: firstContext,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    applicationContext: firstContext,
    attachmentIds: [],
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.draftVersion.qualityStatus, 'passed');

  const changed = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: checked.body.draftVersion.draftId,
    baseVersion: checked.body.draftVersion.version,
    outreach: checked.body.outreach,
    applicationContext: { ...firstContext, contactStage: 'follow_up' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.draftVersion.version, checked.body.draftVersion.version);
  assert.equal(changed.body.draftVersion.contentHash, checked.body.draftVersion.contentHash);
  assert.equal(changed.body.draftVersion.qualityStatus, 'stale');

  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: changed.body.draftVersion.draftId,
    version: changed.body.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 400, JSON.stringify(preview.body));
  assert.equal(preview.body.error.code, 'DRAFT_QUALITY_STALE');

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: changed.body.draftVersion.draftId,
    version: changed.body.draftVersion.version,
  });
  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.equal(sent.body.error.code, 'DRAFT_QUALITY_STALE');
  assert.equal(fixture.sentMessages.length, 0);
});

test('preview and send revalidate the persisted application context hash', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const applicationContext = {
    channel: 'email',
    contactStage: 'first_contact',
    tone: 'natural',
    resumeAttached: false,
    coverLetterAttached: false,
    recipientType: 'recruiter',
  };
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: initial.outreach,
    applicationContext,
  });
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    applicationContext,
    attachmentIds: [],
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));

  const state = await readDeliveryState(fixture.outputDir);
  state[NOTE_ID].applicationContext = {
    ...state[NOTE_ID].applicationContext,
    contactStage: 'follow_up',
  };
  await persistFixtureDeliveryState(fixture.outputDir, state);

  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 400, JSON.stringify(preview.body));
  assert.equal(preview.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
  });
  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.equal(sent.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');
  assert.equal(fixture.sentMessages.length, 0);
});

test('changing a peer draft after quality check invalidates preview and send', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: {
      ...initial.outreach,
      cover_letter: `${initial.outreach.cover_letter} Peer corpus binding fixture.`,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const peerNoteId = 'note-http-peer-change';
  const stateWithPeer = await readDeliveryState(fixture.outputDir);
  stateWithPeer[peerNoteId] = {
    action: 'draft_saved',
    draft: { email_body: 'Original peer application email.' },
  };
  await writeDeliveryState(fixture.outputDir, stateWithPeer);

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    attachmentIds: [],
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.draftVersion.qualityStatus, 'passed');

  const changedState = await readDeliveryState(fixture.outputDir);
  changedState[peerNoteId] = {
    ...changedState[peerNoteId],
    draft: { email_body: 'Changed peer application email after quality checking.' },
  };
  await writeDeliveryState(fixture.outputDir, changedState);

  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
    attachmentIds: [],
  });
  assert.equal(preview.status, 400, JSON.stringify(preview.body));
  assert.equal(preview.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');

  const sent = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
  });
  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.equal(sent.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');
  assert.equal(fixture.sentMessages.length, 0);
});

test('quality recheck uses the real selected attachment snapshot and stales when it changes', async (t) => {
  const checkerCalls = [];
  const fixture = await startFixture(t, {
    draftQualityChecker: async (payload) => {
      checkerCalls.push(structuredClone(payload));
      return qualityReport();
    },
  });
  const initial = (await fixture.getResults()).body.items[0];
  const attachmentClaim = {
    ...initial.outreach,
    email_body: `${initial.outreach.email_body}\nAttached my resume.`,
  };
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: attachmentClaim,
  });
  assert.equal(saved.status, 200);

  const blocked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    attachmentIds: [],
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'ATTACHMENT_CLAIM_WITHOUT_FILE');
  assert.equal(checkerCalls.length, 0);

  const form = new FormData();
  form.append('noteId', NOTE_ID);
  form.append('source', 'uploaded');
  form.append('file', new Blob([Buffer.from('%PDF-1.7\nresume\n%%EOF\n')], { type: 'application/pdf' }), 'resume.pdf');
  const uploaded = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const attachmentIds = [uploaded.body.attachment.attachmentId];

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    attachmentIds,
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checkerCalls.length, 1);
  assert.equal(checkerCalls[0].attachmentContext.count, 1);
  assert.equal(checkerCalls[0].attachmentContext.attachments[0].attachmentId, attachmentIds[0]);
  assert.equal(checkerCalls[0].attachmentContext.attachments[0].filename, 'resume.pdf');

  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    attachmentIds,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));

  const renamed = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentIds[0]}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'resume-updated.pdf' }),
  });
  assert.equal(renamed.status, 200);
  const stale = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    attachmentIds,
  });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error.code, 'DRAFT_QUALITY_STALE');
});

test('a failed exact-version quality recheck remains blocked from delivery', async (t) => {
  const fixture = await startFixture(t, {
    draftQualityChecker: async () => qualityReport({
      score: 82,
      passed: false,
      strengths: [],
      problems: ['岗位证据不足'],
      rewrite_instructions: ['补充可核验的岗位相关成果'],
    }),
  });
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, email_body: `${initial.outreach.email_body} 请查收。` },
  });
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.draftVersion.qualityStatus, 'failed');
  assert.equal(checked.body.draftVersion.qualityCheckedVersion, saved.body.draftVersion.version);
  assert.equal(checked.body.draftVersion.qualityCheckedHash, saved.body.draftVersion.contentHash);
  assert.equal(checked.body.cover_letter_evaluation.passed, false);

  const blocked = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DRAFT_QUALITY_STALE');
  assert.equal(fixture.sentMessages.length, 0);
});

test('tampering with a persisted quality report blocks the otherwise-passed stored version', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, cover_letter: `${initial.outreach.cover_letter} verified-edit` },
  });
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.draftVersion.qualityStatus, 'passed');

  const state = await readDeliveryState(fixture.outputDir);
  state[NOTE_ID].qualityChecks[0].evaluation = {
    ...state[NOTE_ID].qualityChecks[0].evaluation,
    score: 10,
    passed: false,
  };
  await persistFixtureDeliveryState(fixture.outputDir, state);

  const blocked = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');
  assert.equal(fixture.sentMessages.length, 0);
});

test('new quality evidence cannot omit its peer corpus hash', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, cover_letter: `${initial.outreach.cover_letter} peer-hash-evidence` },
  });
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
  });
  assert.equal(checked.status, 200);

  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].qualityChecks[0].evidenceSchemaVersion, 2);
  delete state[NOTE_ID].qualityChecks[0].peerCorpusHash;
  await persistFixtureDeliveryState(fixture.outputDir, state);

  const blocked = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: checked.body.draftVersion.draftId,
    version: checked.body.draftVersion.version,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DRAFT_QUALITY_REPORT_INVALID');
  assert.equal(fixture.sentMessages.length, 0);
});

test('a versionless legacy client can save twice against the latest stored version', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const firstEdit = { ...initial.outreach, greeting: `${initial.outreach.greeting} 第一轮补充。` };
  const first = await fixture.post('draft', { noteId: NOTE_ID, outreach: firstEdit });
  assert.equal(first.status, 200);
  assert.equal(first.body.draftVersion.version, 2);

  const secondEdit = { ...first.body.outreach, cover_letter: `${first.body.outreach.cover_letter} 第二轮补充。` };
  const second = await fixture.post('draft', { noteId: NOTE_ID, outreach: secondEdit });
  assert.equal(second.status, 200);
  assert.equal(second.body.draftVersion.version, 3);
  assert.deepEqual(second.body.outreach, secondEdit);

  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].draftStore.currentVersion, 3);
  assert.equal(state[NOTE_ID].draftStore.versions.length, 3);
  assert.deepEqual(state[NOTE_ID].draftStore.versions[1].content, firstEdit);
  assert.deepEqual(state[NOTE_ID].draftStore.versions[2].content, secondEdit);
  const latest = (await fixture.getResults()).body.items[0];
  assert.equal(latest.draftVersion.version, 3);
  assert.deepEqual(latest.outreach, secondEdit);
});

test('direct-message delivery requires an actionable route and accepts a passed draft when one exists', async (t) => {
  const withoutRoute = await startFixture(t);
  const initialWithoutRoute = (await withoutRoute.getResults()).body.items[0];
  const blocked = await withoutRoute.post('delivery', {
    noteId: NOTE_ID,
    action: 'ready_to_message',
    draftId: initialWithoutRoute.draftVersion.draftId,
    version: initialWithoutRoute.draftVersion.version,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'VALIDATION_ERROR');
  assert.match(blocked.body.error.message, /actionable direct-message route/iu);

  const record = applicationRecord();
  record.application_info.application_routes.push({
    type: 'direct_message',
    channel: 'direct_message',
    value: 'xiaohongshu:user/note-http-001',
    evidence: '帖子作者主页可直接私信',
    actionable: true,
    verification_status: 'verified',
    confidence: 100,
  });
  const withRoute = await startFixture(t, { record });
  const initialWithRoute = (await withRoute.getResults()).body.items[0];
  const accepted = await withRoute.post('delivery', {
    noteId: NOTE_ID,
    action: 'ready_to_message',
    draftId: initialWithRoute.draftVersion.draftId,
    version: initialWithRoute.draftVersion.version,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.draftVersion.qualityStatus, 'passed');
  assert.equal(accepted.body.delivery.action, 'ready_to_message');
});

test('retry reconciles a durable SMTP audit after the final delivery-state write fails', async (t) => {
  let stateWrites = 0;
  const deliveryStateWriter = async (outputDir, state) => {
    stateWrites += 1;
    if (stateWrites === 2) throw new Error('fixture final delivery-state write failure');
    await persistFixtureDeliveryState(outputDir, state);
  };
  const fixture = await startFixture(t, { deliveryStateWriter });
  const initial = (await fixture.getResults()).body.items[0];
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    idempotencyKey: 'send-note-http-001-v1',
  };

  const pending = await fixture.post('send-email', request);
  assert.equal(pending.status, 500);
  assert.equal(pending.body.error.code, 'EMAIL_DELIVERED_AUDIT_STATE_PENDING');
  assert.equal(fixture.sentMessages.length, 1);
  assert.equal(stateWrites, 2);
  const firstJournal = await readSendAuditJournal(fixture.outputDir);
  assert.equal(firstJournal.length, 1);
  assert.equal(firstJournal[0].event, 'email_sent');
  assert.equal(firstJournal[0].messageId, 'mail-1');
  const pendingState = await readDeliveryState(fixture.outputDir);
  assert.equal(pendingState[NOTE_ID].pendingSend.contentHash, initial.draftVersion.contentHash);

  const reconciled = await fixture.post('send-email', request);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.delivery.action, 'email_sent');
  assert.equal(reconciled.body.delivery.email.messageId, 'mail-1');
  assert.equal(reconciled.body.delivery.sendAudit.length, 1);
  assert.equal(fixture.sentMessages.length, 1);
  assert.equal(stateWrites, 3);
  const finalJournal = await readSendAuditJournal(fixture.outputDir);
  assert.deepEqual(finalJournal, firstJournal);
  const finalState = await readDeliveryState(fixture.outputDir);
  assert.equal(Object.hasOwn(finalState[NOTE_ID], 'pendingSend'), false);
  assert.equal(finalState[NOTE_ID].sendAudit.length, 1);
});

test('a send-bundle finalization failure persists unknown delivery before returning uncertainty', async (t) => {
  const delivered = [];
  let fixture;
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    send: async (message) => {
      delivered.push(structuredClone(message));
      const bundleRoot = path.join(fixture.outputDir, 'application-attachments', 'send-bundles');
      const entries = await readdir(bundleRoot, { withFileTypes: true });
      const sealed = entries.find((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
      assert.ok(sealed, 'the send bundle must be sealed before SMTP delivery');
      await rm(path.join(bundleRoot, sealed.name, 'manifest.json'));
      return { messageId: 'accepted-before-finalize-failure', accepted: [message.to], rejected: [] };
    },
  };
  fixture = await startFixture(t, { mailSender });
  const initial = (await fixture.getResults()).body.items[0];

  const uncertain = await fixture.post('send-email', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  });
  assert.equal(uncertain.status, 500, JSON.stringify(uncertain.body));
  assert.equal(uncertain.body.error.code, 'EMAIL_DELIVERED_AUDIT_UNCERTAIN');
  assert.equal(delivered.length, 1);

  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].action, 'email_unknown');
  assert.equal(state[NOTE_ID].deliveryStatus, 'unknown');
  assert.equal(state[NOTE_ID].email.status, 'unknown');
  assert.equal(state[NOTE_ID].email.messageId, 'accepted-before-finalize-failure');
  assert.ok(state[NOTE_ID].pendingSend, 'accepted delivery uncertainty must retain the send intent');
  assert.deepEqual(
    state[NOTE_ID].deliveryTransitions.map((transition) => transition.status),
    ['preparing', 'sending', 'unknown'],
  );
});

test('retry recovers a finalized sent bundle when the first audit journal append fails', async (t) => {
  let appendCalls = 0;
  const sendAuditAppender = async (outputDir, audit) => {
    appendCalls += 1;
    if (appendCalls === 1) throw new Error('fixture audit journal failure');
    await appendFile(
      path.join(outputDir, 'delivery-send-audit.jsonl'),
      `${JSON.stringify(audit)}\n`,
      'utf8',
    );
  };
  const fixture = await startFixture(t, { sendAuditAppender });
  const initial = (await fixture.getResults()).body.items[0];
  const form = new FormData();
  form.append('noteId', NOTE_ID);
  form.append('source', 'uploaded');
  form.append('file', new Blob([Buffer.from('%PDF-1.7\nresume\n%%EOF\n')], { type: 'application/pdf' }), 'resume.pdf');
  const uploaded = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const attachmentIds = [uploaded.body.attachment.attachmentId];
  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    contentHash: initial.draftVersion.contentHash,
    attachmentIds,
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const preview = await fixture.post('send-email/preview', {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    attachmentIds,
    attachmentBundleHash: preview.body.attachmentBundleHash,
    previewRevision: preview.body.previewRevision,
    idempotencyKey: 'recover-finalized-bundle-v1',
  };

  const uncertain = await fixture.post('send-email', request);
  assert.equal(uncertain.status, 500);
  assert.equal(uncertain.body.error.code, 'EMAIL_DELIVERED_AUDIT_UNCERTAIN');
  assert.equal(fixture.sentMessages.length, 1);
  const pendingState = await readDeliveryState(fixture.outputDir);
  assert.equal(pendingState[NOTE_ID].action, 'email_unknown');
  assert.equal(pendingState[NOTE_ID].deliveryStatus, 'unknown');
  assert.equal(pendingState[NOTE_ID].email.status, 'unknown');
  assert.equal(pendingState[NOTE_ID].email.messageId, 'mail-1');
  assert.ok(pendingState[NOTE_ID].pendingSend, 'audit uncertainty must retain the send intent');
  assert.deepEqual(
    pendingState[NOTE_ID].deliveryTransitions.map((transition) => transition.status),
    ['preview_ready', 'preparing', 'sending', 'unknown'],
  );
  const sendId = pendingState[NOTE_ID].pendingSend.sendId;
  const bundleManifest = JSON.parse(await readFile(
    path.join(fixture.outputDir, 'application-attachments', 'send-bundles', sendId, 'manifest.json'),
    'utf8',
  ));
  const bundleOutcome = JSON.parse(await readFile(
    path.join(fixture.outputDir, 'application-attachments', 'send-bundles', sendId, 'outcome.json'),
    'utf8',
  ));
  assert.equal(bundleManifest.status, 'prepared');
  assert.equal(bundleOutcome.status, 'sent');
  assert.equal(bundleOutcome.messageId, 'mail-1');

  const deleted = await fixture.request(`/api/jobs/${JOB_ID}/application-attachments/${attachmentIds[0]}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const changedDraft = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting} Updated after SMTP acceptance.` },
  });
  assert.equal(changedDraft.status, 200, JSON.stringify(changedDraft.body));

  const recovered = await fixture.post('send-email', request);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.duplicate, true);
  assert.equal(recovered.body.code, 'EMAIL_DUPLICATE_SEND');
  assert.equal(recovered.body.sendId, sendId);
  assert.equal(fixture.sentMessages.length, 1);
  assert.equal(appendCalls, 2);
  assert.equal(recovered.body.outreach.greeting, changedDraft.body.outreach.greeting);
  const finalState = await readDeliveryState(fixture.outputDir);
  assert.equal(Object.hasOwn(finalState[NOTE_ID], 'pendingSend'), false);
  assert.equal(finalState[NOTE_ID].sendAudit.length, 1);
  assert.equal((await readSendAuditJournal(fixture.outputDir)).length, 1);
});

test('an ambiguous mailer failure retains pending intent and blocks retry without sending twice', async (t) => {
  const sendAttempts = [];
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    send: async (message) => {
      sendAttempts.push(structuredClone(message));
      const error = new Error('SMTP connection closed after DATA; delivery status is unknown');
      error.code = 'MAIL_SEND_FAILED';
      throw error;
    },
  };
  const fixture = await startFixture(t, { mailSender });
  const initial = (await fixture.getResults()).body.items[0];
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
  };

  const failed = await fixture.post('send-email', request);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'MAIL_SEND_FAILED');
  assert.equal(sendAttempts.length, 1);
  const pendingState = await readDeliveryState(fixture.outputDir);
  assert.ok(pendingState[NOTE_ID].pendingSend, 'ambiguous delivery failure must retain the persisted send intent');
  assert.equal(pendingState[NOTE_ID].pendingSend.draftId, initial.draftVersion.draftId);
  assert.equal(pendingState[NOTE_ID].pendingSend.version, initial.draftVersion.version);
  assert.equal(pendingState[NOTE_ID].pendingSend.contentHash, initial.draftVersion.contentHash);

  const retry = await fixture.post('send-email', request);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error.code, 'EMAIL_SEND_STATUS_UNKNOWN');
  assert.equal(sendAttempts.length, 1);
  const retryState = await readDeliveryState(fixture.outputDir);
  assert.deepEqual(retryState[NOTE_ID].pendingSend, pendingState[NOTE_ID].pendingSend);
});

test('repeating the same successful send is idempotent', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    idempotencyKey: 'send-note-http-001-v1',
  };
  const first = await fixture.post('send-email', request);
  const retry = await fixture.post('send-email', request);

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(fixture.sentMessages.length, 1);
  assert.deepEqual(retry.body.delivery.email, first.body.delivery.email);
  assert.deepEqual(retry.body.delivery.sendAudit, first.body.delivery.sendAudit);
  assert.equal(retry.body.delivery.sendAudit.length, 1);
  assert.match(retry.body.delivery.sendAudit[0].idempotencyKey, /^[a-f0-9]{64}$/u);
  assert.equal(retry.body.delivery.sendAudit[0].requestIdempotencyKey, 'send-note-http-001-v1');
  assert.equal(first.body.duplicate, false);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.code, 'EMAIL_DUPLICATE_SEND');
  const journal = await readSendAuditJournal(fixture.outputDir);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].idempotencyKey, retry.body.delivery.sendAudit[0].idempotencyKey);
  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].sendAudit.length, 1);
});

test('concurrent duplicate sends are serialized and produce one SMTP delivery', async (t) => {
  const sentMessages = [];
  let verifyCalls = 0;
  const mailSender = {
    status: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    configure: () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
    verify: async () => {
      verifyCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { configured: true, from: 's***@example.com', authMode: 'login' };
    },
    send: async (message) => {
      sentMessages.push(structuredClone(message));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { messageId: 'mail-concurrent', accepted: [message.to], rejected: [] };
    },
  };
  const fixture = await startFixture(t, { mailSender });
  const initial = (await fixture.getResults()).body.items[0];
  const request = {
    noteId: NOTE_ID,
    to: RECIPIENT,
    draftId: initial.draftVersion.draftId,
    version: initial.draftVersion.version,
    idempotencyKey: 'concurrent-send-v1',
  };

  const responses = await Promise.all([
    fixture.post('send-email', request),
    fixture.post('send-email', request),
  ]);

  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(responses.map((response) => response.body.duplicate).sort(), [false, true]);
  assert.equal(sentMessages.length, 1);
  assert.equal(verifyCalls, 1);
  const journal = await readSendAuditJournal(fixture.outputDir);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, 'sent');
  assert.equal(journal[0].recipient, 'j***@example.com');
});

test('two independent Node processes share one idempotent send attempt', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const readyFile = path.join(fixture.fixture, 'cross-process-ready.log');
  const goFile = path.join(fixture.fixture, 'cross-process-go');
  const sendLog = path.join(fixture.fixture, 'cross-process-sends.log');
  const resultDir = path.join(fixture.fixture, 'cross-process-results');
  await mkdir(resultDir, { recursive: true });
  const appModuleUrl = new URL('./app.mjs', import.meta.url).href;
  const childScript = `
    import path from 'node:path';
    import { appendFile, readFile, writeFile } from 'node:fs/promises';
    const { previewApplicationEmail, sendApplicationEmail } = await import(process.env.APP_MODULE_URL);
    const verifiedAt = '2026-07-31T12:00:00.000Z';
    const publicConfig = {
      provider: 'custom', host: 'smtp.example.com', port: 465, secure: true,
      user: 'sender@example.com', from: 'sender@example.com', revision: 7,
      configHash: 'cross-process-config', credentialRevision: 2, lastVerifiedAt: verifiedAt,
    };
    const verification = {
      configured: true, verificationStatus: 'verified', verifiedAt,
      configHash: publicConfig.configHash, credentialRevision: publicConfig.credentialRevision,
    };
    const smtpConfig = {
      getPublic: () => ({ ...publicConfig }),
      getVerificationState: () => ({ ...verification }),
      getVerificationSnapshot: () => ({
        revision: publicConfig.revision,
        configHash: publicConfig.configHash,
        credentialRevision: publicConfig.credentialRevision,
      }),
      assertReadyForSend: () => ({ ...verification }),
      markVerified: async () => ({ ...verification }),
    };
    const mailer = {
      status: () => ({ configured: true, from: 'sender@example.com', authMode: 'login' }),
      verify: async () => ({ configured: true }),
      send: async (message) => {
        await appendFile(process.env.SEND_LOG, process.pid + '\\n', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { messageId: 'cross-' + process.pid, accepted: [message.to], rejected: [] };
      },
    };
    const requestBase = {
      noteId: process.env.NOTE_ID,
      to: process.env.RECIPIENT,
      draftId: process.env.DRAFT_ID,
      version: Number(process.env.DRAFT_VERSION),
      attachmentIds: [],
    };
    const preview = await previewApplicationEmail(
      process.env.OUTPUT_DIR,
      requestBase,
      '',
      mailer,
      smtpConfig,
    );
    await appendFile(process.env.READY_FILE, process.pid + '\\n', 'utf8');
    while (true) {
      try {
        await readFile(process.env.GO_FILE);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const result = await sendApplicationEmail(process.env.OUTPUT_DIR, {
      ...requestBase,
      attachmentBundleHash: preview.attachmentBundleHash,
      previewRevision: preview.previewRevision,
      idempotencyKey: 'cross-process-idempotency-v1',
    }, mailer, '', smtpConfig);
    await writeFile(path.join(process.env.RESULT_DIR, process.pid + '.json'), JSON.stringify(result), 'utf8');
  `;
  const childEnv = {
    ...process.env,
    APP_MODULE_URL: appModuleUrl,
    OUTPUT_DIR: fixture.outputDir,
    NOTE_ID,
    RECIPIENT,
    DRAFT_ID: initial.draftVersion.draftId,
    DRAFT_VERSION: String(initial.draftVersion.version),
    READY_FILE: readyFile,
    GO_FILE: goFile,
    SEND_LOG: sendLog,
    RESULT_DIR: resultDir,
  };
  const children = Array.from({ length: 2 }, () => spawn(
    process.execPath,
    ['--input-type=module', '--eval', childScript],
    { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  ));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const ready = (await readFile(readyFile, 'utf8')).split(/\r?\n/u).filter(Boolean);
      if (ready.length === 2) break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const ready = (await readFile(readyFile, 'utf8')).split(/\r?\n/u).filter(Boolean);
  assert.equal(ready.length, 2, 'both processes must reach the shared send barrier');
  await writeFile(goFile, 'go', 'utf8');
  await Promise.all(children.map(async (child) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 0, `child exited with code=${code} signal=${signal}: ${stderr}`);
  }));

  const sends = (await readFile(sendLog, 'utf8')).split(/\r?\n/u).filter(Boolean);
  assert.equal(sends.length, 1);
  const resultFiles = await readdir(resultDir);
  assert.equal(resultFiles.length, 2);
  const results = await Promise.all(resultFiles.map(async (filename) => JSON.parse(await readFile(path.join(resultDir, filename), 'utf8'))));
  assert.deepEqual(results.map((item) => item.duplicate).sort(), [false, true]);
  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].sendAudit.length, 1);
  assert.equal((await readSendAuditJournal(fixture.outputDir)).length, 1);
});

test('generation writeback saves a validated draft and provenance metadata', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('application-generation/writeback', {
    runId: 'generation-run-1',
    promptVersion: 'xhs-outreach-v11-snapshot-writeback',
    profileSnapshotId: 'profile-snapshot-1',
    items: [{
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      baseVersion: initial.draftVersion.version,
      outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting} v2` },
      generation: {
        profileSnapshotId: 'profile-snapshot-1',
        usedEvidenceIds: ['e-ai'],
        status: 'validated',
      },
    }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.saved, 1);
  assert.equal(response.body.items[0].status, 'saved');
  assert.equal(response.body.items[0].draftVersion.version, 2);
  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].generation.runId, 'generation-run-1');
  assert.equal(state[NOTE_ID].generation.profileSnapshotId, 'profile-snapshot-1');
  assert.deepEqual(state[NOTE_ID].generation.usedEvidenceIds, ['e-ai']);
});

test('generation writeback reports a version conflict without overwriting a newer draft', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const body = {
    runId: 'generation-run-2',
    profileSnapshotId: 'profile-snapshot-2',
    items: [{
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      baseVersion: 1,
      outreach: { ...initial.outreach, email_subject: `${initial.outreach.email_subject} v2` },
      generation: { profileSnapshotId: 'profile-snapshot-2' },
    }],
  };
  const first = await fixture.post('application-generation/writeback', body);
  const second = await fixture.post('application-generation/writeback', {
    ...body,
    items: [{
      ...body.items[0],
      outreach: { ...body.items[0].outreach, email_subject: `${body.items[0].outreach.email_subject} stale` },
    }],
  });
  assert.equal(first.body.status, 'completed');
  assert.equal(second.body.status, 'failed');
  assert.equal(second.body.conflicts, 1);
  assert.equal(second.body.items[0].status, 'writeback_conflict');
  const state = await readDeliveryState(fixture.outputDir);
  assert.equal(state[NOTE_ID].draftStore.currentVersion, 2);
  assert.equal(state[NOTE_ID].draftStore.versions.length, 2);
  assert.equal(state[NOTE_ID].draftStore.versions[1].content.email_subject, body.items[0].outreach.email_subject);
});

test('generation writeback rejects a resume recommendation outside the snapshot artifacts', async (t) => {
  const fixture = await startFixture(t);
  const initial = (await fixture.getResults()).body.items[0];
  const response = await fixture.post('application-generation/writeback', {
    runId: 'generation-run-invalid-resume',
    profileSnapshotId: 'profile-snapshot-invalid-resume',
    items: [{
      noteId: NOTE_ID,
      draftId: initial.draftVersion.draftId,
      baseVersion: initial.draftVersion.version,
      outreach: initial.outreach,
      generation: {
        profileSnapshotId: 'profile-snapshot-invalid-resume',
        resumeArtifactIds: ['resume-ops'],
        recommendedResumeId: 'resume-stale',
      },
    }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'failed');
  assert.equal(response.body.saved, 0);
  assert.equal(response.body.items[0].status, 'writeback_failed');
  assert.match(response.body.items[0].error.message, /resumeArtifactIds/);
});
