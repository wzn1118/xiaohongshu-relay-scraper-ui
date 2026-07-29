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
  const sentMessages = [];
  const server = http.createServer(createApp({
    manager,
    config,
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
    relayLoginOpener: async ({ profile, url }) => ({
      opened: true,
      profile,
      url,
      message: 'Login page opened.',
    }),
    mailSender: {
      status: () => ({ configured: true, from: 's***@example.com' }),
      send: async (message) => {
        sentMessages.push(message);
        return { messageId: 'mail-1', accepted: [message.to], rejected: [] };
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
