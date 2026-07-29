import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApp } from './app.mjs';

test('HTTP contract exposes direct frontend-compatible responses', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-app-'));
  const staticDir = path.join(fixture, 'dist');
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(staticDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>XHS Control</title>', 'utf8');
  await writeFile(path.join(outputDir, 'result.json'), '{"ok":true}', 'utf8');
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: [{
      note_id: 'n1',
      title: '内容运营实习',
      body: '负责内容运营，请投递 jobs@example.com',
      application_info: {
        contacts: [],
        application_routes: [{ type: 'email', channel: 'email', value: 'email', evidence: '请发送至 jobs@example.com', confidence: 100 }],
        responsibilities: [],
        requirements: [],
      },
      outreach: {
        greeting: '您好，我希望申请内容运营实习。',
        email_subject: '内容运营实习申请',
        email_body: '您好，我希望申请内容运营实习。',
        cover_letter: '我具备内容运营和数据分析经验。',
      },
      cover_letter_evaluation: { score: 94, passed: true },
    }],
    codex_runtime: { status: 'completed', generated: 1 },
    quality_gate: { passed: true },
  }), 'utf8');
  const job = {
    id: '20260728080000-abcdef12',
    keyword: '实习继任',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  const internal = { ...job, outputDir, logPath: path.join(fixture, 'run.log'), config: { candidateProfile: { email: 'candidate@example.com' } } };
  const manager = {
    active: null,
    list: () => [],
    get: (id) => id === job.id ? job : null,
    getInternal: (id) => id === job.id ? internal : null,
    start: async () => job,
    cancel: async () => ({ found: true, job: { ...job, status: 'cancelled' }, changed: true }),
  };
  const config = {
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 4096,
    openClawConfigPath: 'unused',
    staticDir,
    runnerAvailable: true,
  };
  let relaySettings = { port: 18792, profile: 'chrome', autoConnect: true };
  let smtpSettings = {
    provider: 'custom', host: 'smtp.example.com', port: 465, secure: true, requireTls: false,
    auth: 'login', user: 'sender@example.com', from: 'sender@example.com', hasPassword: true,
  };
  let smtpDeliveryStatus = { configured: true, from: 's***@example.com', authMode: 'login' };
  const sentMessages = [];
  const relaySetupCalls = [];
  const modelDiscoveryCalls = [];
  const server = http.createServer(createApp({
    manager,
    config,
    aiSessions: {
      providers: () => [{ id: 'openai', models: ['gpt-4.1-mini'] }],
      discoverModels: async (value) => {
        modelDiscoveryCalls.push(value);
        return { provider: value.provider, baseUrl: value.baseUrl, models: ['gpt-5.6-terra', 'gpt-4.1-mini'], fetchedAt: new Date().toISOString() };
      },
      create: async () => ({ id: 'ai-session-1', provider: 'openai' }),
      delete: () => true,
    },
    relayConfig: {
      get: () => ({ ...relaySettings }),
      update: async (value) => {
        relaySettings = { ...relaySettings, ...value };
        return { ...relaySettings };
      },
    },
    relayConnector: async ({ port, profile }) => ({
      ok: true,
      ready: true,
      running: true,
      cdpReady: true,
      authenticated: true,
      port,
      profile,
      tabs: 1,
      tabCount: 1,
      message: 'Relay 已智能连接。',
    }),
    relaySetup: async (options) => {
      relaySetupCalls.push(options);
      return { ok: true, supported: true, installed: true, message: 'Relay runtime prepared.' };
    },
    relayLoginOpener: async ({ profile, url }) => ({
      opened: true,
      profile,
      url,
      message: 'Login page opened.',
    }),
    mailSender: {
      status: () => ({ ...smtpDeliveryStatus }),
      configure: (value) => {
        smtpDeliveryStatus = {
          configured: Boolean(value.host && value.from),
          from: value.from ? 's***@example.com' : '',
          authMode: value.auth || 'login',
        };
        return { ...smtpDeliveryStatus };
      },
      verify: async () => ({ configured: true, from: 's***@example.com', authMode: 'login' }),
      send: async (message) => {
        sentMessages.push(message);
        return { messageId: 'mail-1', accepted: [message.to], rejected: [] };
      },
    },
    smtpConfig: {
      getPublic: () => ({ ...smtpSettings }),
      getForMailer: () => ({ ...smtpSettings, pass: 'stored-secret' }),
      markVerified: async () => {
        smtpSettings = { ...smtpSettings, lastVerifiedAt: new Date().toISOString() };
        return { ...smtpSettings };
      },
      update: async (value) => {
        smtpSettings = { ...smtpSettings, ...value, hasPassword: true };
        delete smtpSettings.password;
        return { ...smtpSettings };
      },
      clear: async () => {
        smtpSettings = {
          provider: 'custom', host: '', port: 465, secure: true, requireTls: false,
          auth: 'login', user: '', from: '', hasPassword: false,
          oauth: { tenant: 'organizations', clientId: '', scope: '', hasClientSecret: false, hasRefreshToken: false },
        };
        return { ...smtpSettings };
      },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'xiaohongshu-relay-scraper');
    assert.equal(health.emailDelivery.configured, true);

    const discoveredModels = await fetch(`${origin}/api/ai/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' }),
    });
    assert.equal(discoveredModels.status, 200);
    assert.deepEqual((await discoveredModels.json()).models, ['gpt-5.6-terra', 'gpt-4.1-mini']);
    assert.equal(modelDiscoveryCalls.length, 1);

    const emailConfig = await fetch(`${origin}/api/email/config`).then((response) => response.json());
    assert.equal(emailConfig.configured, true);
    assert.equal(emailConfig.hasPassword, true);
    assert.equal('password' in emailConfig, false);
    const updatedEmailConfig = await fetch(`${origin}/api/email/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...emailConfig, user: 'updated@example.com', from: 'updated@example.com', password: 'replacement' }),
    });
    assert.equal(updatedEmailConfig.status, 200);
    const updatedEmailBody = await updatedEmailConfig.json();
    assert.equal(updatedEmailBody.user, 'updated@example.com');
    assert.equal('password' in updatedEmailBody, false);
    const testedEmail = await fetch(`${origin}/api/email/test`, { method: 'POST' });
    assert.equal(testedEmail.status, 200);
    assert.equal((await testedEmail.json()).ok, true);

    const clearedEmail = await fetch(`${origin}/api/email/config`, { method: 'DELETE' });
    assert.equal(clearedEmail.status, 200);
    const clearedEmailBody = await clearedEmail.json();
    assert.equal(clearedEmailBody.configured, false);
    assert.equal(clearedEmailBody.from, '');
    assert.equal(clearedEmailBody.hasPassword, false);

    const jobs = await fetch(`${origin}/api/jobs`).then((response) => response.json());
    assert.deepEqual(jobs, []);

    const invalid = await fetch(`${origin}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchUrl: 'https://example.com' }),
    });
    assert.equal(invalid.status, 400);
    const error = await invalid.json();
    assert.equal(error.error.code, 'VALIDATION_ERROR');

    const invalidPort = await fetch(`${origin}/api/relay/status?port=0`);
    assert.equal(invalidPort.status, 400);

    const relayConfig = await fetch(`${origin}/api/relay/config`).then((response) => response.json());
    assert.deepEqual(relayConfig, { port: 18792, profile: 'chrome', autoConnect: true });
    const updatedRelayConfig = await fetch(`${origin}/api/relay/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 18801, profile: 'work-profile', autoConnect: false }),
    });
    assert.equal(updatedRelayConfig.status, 200);
    assert.deepEqual(await updatedRelayConfig.json(), { port: 18801, profile: 'work-profile', autoConnect: false });

    const connected = await fetch(`${origin}/api/relay/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(connected.status, 200);
    assert.equal((await connected.json()).ready, true);

    const setup = await fetch(`${origin}/api/relay/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 18802, profile: 'work-profile' }),
    });
    assert.equal(setup.status, 200);
    const setupPayload = await setup.json();
    assert.equal(setupPayload.ready, true);
    assert.equal(setupPayload.setup.installed, true);
    assert.equal(relaySetupCalls[0].relayPort, 18802);
    assert.equal(relaySetupCalls[0].profile, 'work-profile');

    const loginPage = await fetch(`${origin}/api/relay/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(loginPage.status, 200);
    const loginPayload = await loginPage.json();
    assert.equal(loginPayload.opened, true);
    assert.equal(loginPayload.profile, 'work-profile');
    assert.equal(loginPayload.url, 'https://www.xiaohongshu.com');

    const invalidProfile = await fetch(`${origin}/api/relay/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'work profile' }),
    });
    assert.equal(invalidProfile.status, 400);
    assert.equal((await invalidProfile.json()).error.code, 'INVALID_PROFILE');

    const created = await fetch(`${origin}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(created.status, 202);
    assert.equal((await created.json()).id, job.id);

    const cancelled = await fetch(`${origin}/api/jobs/${job.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).status, 'cancelled');

    const artifacts = await fetch(`${origin}/api/jobs/${job.id}/artifacts`).then((response) => response.json());
    assert.equal(artifacts.length, 2);
    assert.ok(artifacts.some((artifact) => artifact.name === 'result.json'));

    const results = await fetch(`${origin}/api/jobs/${job.id}/results?limit=20`).then((response) => response.json());
    assert.equal(results.available, true);
    assert.equal(results.total, 1);
    assert.equal(results.items[0].note_id, 'n1');
    assert.equal(results.codexRuntime.status, 'completed');

    const savedDraft = await fetch(`${origin}/api/jobs/${job.id}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        noteId: 'n1',
        outreach: {
          greeting: '编辑后的私信',
          email_subject: '编辑后的主题',
          email_body: '编辑后的邮件正文',
          cover_letter: '编辑后的求职信',
        },
      }),
    });
    assert.equal(savedDraft.status, 200);
    assert.equal((await savedDraft.json()).delivery.action, 'draft_saved');

    const resultsWithDraft = await fetch(`${origin}/api/jobs/${job.id}/results?limit=20`).then((response) => response.json());
    assert.equal(resultsWithDraft.items[0].outreach.email_subject, '编辑后的主题');

    const sentEmail = await fetch(`${origin}/api/jobs/${job.id}/send-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        noteId: 'n1',
        to: 'jobs@example.com',
        outreach: resultsWithDraft.items[0].outreach,
      }),
    });
    assert.equal(sentEmail.status, 200);
    assert.equal((await sentEmail.json()).delivery.action, 'email_sent');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].to, 'jobs@example.com');
    assert.equal(sentMessages[0].replyTo, 'candidate@example.com');
    assert.equal(sentMessages[0].subject, '编辑后的主题');

    const invalidRecipient = await fetch(`${origin}/api/jobs/${job.id}/send-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteId: 'n1', to: 'other@example.com', outreach: resultsWithDraft.items[0].outreach }),
    });
    assert.equal(invalidRecipient.status, 400);

    const homepage = await fetch(`${origin}/`).then((response) => response.text());
    assert.match(homepage, /XHS Control/);
    const spaRoute = await fetch(`${origin}/history/${job.id}`).then((response) => response.text());
    assert.match(spaRoute, /XHS Control/);
    const apiMiss = await fetch(`${origin}/api/not-a-route`);
    assert.equal(apiMiss.status, 404);
    assert.match(apiMiss.headers.get('content-type'), /application\/json/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(fixture, { recursive: true, force: true });
  }
});
