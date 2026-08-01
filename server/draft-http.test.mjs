import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createApp } from './app.mjs';
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
  assert.equal(audit.timestamp, audit.sentAt);
  assert.equal(Object.hasOwn(audit, 'text'), false);
  assert.equal(Object.hasOwn(audit, 'body'), false);
  assert.equal(Object.hasOwn(audit, 'password'), false);
  assert.ok(Date.parse(audit.sentAt) >= before);
  assert.ok(Date.parse(audit.sentAt) <= after);

  const persisted = await readDeliveryState(fixture.outputDir);
  assert.deepEqual(persisted[NOTE_ID].sendAudit, [audit]);
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

test('a malformed legacy delivery-state remains readable and is backed up before repair', async (t) => {
  const legacyStateText = '{"broken":';
  const fixture = await startFixture(t, { legacyStateText });
  const initialResponse = await fixture.getResults();
  assert.equal(initialResponse.status, 200);
  const initial = initialResponse.body.items[0];
  assert.equal(initial.draftVersion.version, 1);

  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: { ...initial.outreach, greeting: `${initial.outreach.greeting}.` },
  });
  assert.equal(saved.status, 200);

  const backup = await readFile(path.join(fixture.outputDir, 'delivery-state.v1.backup.json'), 'utf8');
  assert.equal(backup, legacyStateText);
  const persisted = await readDeliveryState(fixture.outputDir);
  assert.equal(persisted._schemaVersion, 2);
  assert.equal(persisted[NOTE_ID].draftStore.currentVersion, 2);
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
  const saved = await fixture.post('draft', {
    noteId: NOTE_ID,
    draftId: initial.draftVersion.draftId,
    baseVersion: initial.draftVersion.version,
    outreach: edited,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.draftVersion.qualityStatus, 'stale');

  const checked = await fixture.post('draft/quality', {
    noteId: NOTE_ID,
    draftId: saved.body.draftVersion.draftId,
    version: saved.body.draftVersion.version,
    contentHash: saved.body.draftVersion.contentHash,
    aiSessionId: 'quality-session-001',
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
  assert.equal(checkerCalls[0].payload.threshold, 90);
  assert.equal(checkerCalls[0].ai, aiRuntime);

  const located = await resolveQualityReportRef(fixture.outputDir, checked.body.draftVersion.qualityReportRef);
  assert.equal(located.absolutePath, path.join(fixture.outputDir, 'delivery-state.json'));
  assert.equal(located.value.draftId, saved.body.draftVersion.draftId);
  assert.equal(located.value.version, saved.body.draftVersion.version);
  assert.equal(located.value.contentHash, saved.body.draftVersion.contentHash);
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
