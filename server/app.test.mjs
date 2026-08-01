import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApp } from './app.mjs';
import { createDiagnostics } from './lib/diagnostics.mjs';

function readyPreflightReport() {
  return { schemaVersion: 1, kind: 'preflight', status: 'ready', ready: true, checkedAt: new Date().toISOString(), durationMs: 0, checks: [] };
}

test('HTTP contract exposes direct frontend-compatible responses', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-app-'));
  const staticDir = path.join(fixture, 'dist');
  const outputDir = path.join(fixture, 'artifacts');
  const checkedDraft = {
    greeting: '编辑后的私信',
    email_subject: '应聘内容运营实习｜示例用户',
    email_body: '您好，我希望申请内容运营实习。我曾负责社交媒体内容运营与市场调研，能够围绕目标受众梳理信息，并根据反馈调整内容重点和推进节奏。这段实践与岗位的内容策划和数据分析要求直接相关，期待进一步了解团队当前最需要推进的任务。',
    cover_letter: '编辑后的求职信',
  };
  await mkdir(staticDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>XHS Control</title>', 'utf8');
  await writeFile(path.join(outputDir, 'result.json'), '{"ok":true}', 'utf8');
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: [{
      note_id: 'n1',
      title: '内容运营实习',
      note_url: 'https://www.xiaohongshu.com/explore/n1',
      body: '负责内容运营，请投递 jobs@example.com',
      media: { cover_url: 'https://sns-webpic-qc.xhscdn.com/n1-cover.webp' },
      application_info: {
        contacts: [],
        application_routes: [{ type: 'email', channel: 'email', value: 'email', evidence: '请发送至 jobs@example.com', confidence: 100 }],
        responsibilities: [],
        requirements: [],
      },
      job_card: { parse_basis: 'full_body' },
      outreach: {
        runtime_status: 'fallback_missing_candidate_evidence',
        ...checkedDraft,
      },
      cover_letter_evaluation: { score: 94, passed: true },
    }],
    codex_runtime: { status: 'completed', generated: 1 },
    quality_gate: { passed: true },
  }), 'utf8');
  await writeFile(path.join(outputDir, 'audience-summary.json'), JSON.stringify({
    status: 'partial', postsTotal: 1, postsComplete: 0, commentsCollected: 1,
    usersDiscovered: 1, profilesComplete: 1,
  }), 'utf8');
  await writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
    { post_id: 'n1', title: '内容运营实习', note_url: 'https://www.xiaohongshu.com/explore/n1', status: 'partial' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([
    { comment_id: 'c1', post_id: 'n1', text: '请问还在招吗', user: { user_id: 'u1' } },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([
    { user_id: 'u1', display_name: '公开用户', post_ids: ['n1'], enrichment_status: 'complete' },
  ]), 'utf8');
  const job = {
    id: '20260728080000-abcdef12',
    keyword: '实习继任',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  const internal = {
    ...job,
    outputDir,
    logPath: path.join(fixture, 'run.log'),
    params: { keyword: job.keyword, candidateProfile: { email: 'candidate@example.com' } },
  };
  const startCalls = [];
  const resumeCalls = [];
  const rateLimitSignalCalls = [];
  const expansionCalls = [];
  const manager = {
    active: null,
    list: () => [],
    get: (id) => id === job.id ? job : null,
    getInternal: (id) => id === job.id ? internal : null,
    start: async (...args) => {
      startCalls.push(args);
      return job;
    },
    resume: async (...args) => {
      resumeCalls.push(args);
      return { ...job, status: 'resuming', attemptId: 'attempt-2' };
    },
    signalRateLimitRecovery: async (id) => {
      rateLimitSignalCalls.push(id);
      return {
        signaled: true,
        job: { ...job, rateLimit: { detected: true, status: 'waiting', recoveryAction: 'manual_probe' } },
      };
    },
    cancel: async () => ({ found: true, job: { ...job, status: 'cancelled' }, changed: true }),
    startExpansion: async (id, request) => {
      expansionCalls.push(['start', id, request]);
      return { job: { ...job, workflowSummary: { expansion: { runtimeStatus: 'running', seedPostIds: request.seedPostIds, config: request.config } } }, attemptId: 'expansion-1' };
    },
    resumeExpansion: async (id, request) => {
      expansionCalls.push(['resume', id, request]);
      return { job: { ...job, workflowSummary: { expansion: { runtimeStatus: 'running', seedPostIds: ['n1'], config: { rounds: 1 } } } }, attemptId: 'expansion-2' };
    },
    cancelExpansion: async (id) => {
      expansionCalls.push(['cancel', id]);
      return { changed: true, job: { ...job, workflowSummary: { expansion: { runtimeStatus: 'cancelled', seedPostIds: ['n1'], config: { rounds: 1 } } } } };
    },
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
  const relayRecoveryCalls = [];
  const relayConnectionCalls = [];
  let relayRecoveryFailuresRemaining = 0;
  const modelDiscoveryCalls = [];
  const localInstallCalls = [];
  const diagnostics = createDiagnostics();
  const server = http.createServer(createApp({
    manager,
    config,
    diagnostics,
    preflightService: { run: async () => readyPreflightReport() },
    aiSessions: {
      providers: () => [{ id: 'openai', models: ['gpt-4.1-mini'] }],
      discoverModels: async (value) => {
        modelDiscoveryCalls.push(value);
        return { provider: value.provider, baseUrl: value.baseUrl, models: ['gpt-5.6-terra', 'gpt-4.1-mini'], fetchedAt: new Date().toISOString() };
      },
      create: async () => ({ id: 'ai-session-1', provider: 'openai' }),
      delete: () => true,
    },
    localModels: {
      status: async () => ({
        runtime: { ready: true, endpoint: 'http://127.0.0.1:11434', version: '0.32.5', message: 'ready' },
        catalog: [{ id: 'qwen3.5:4b', label: 'Qwen3.5 4B', downloadBytes: 3389983735, recommended: true, installed: false }],
        installedModels: [],
        install: null,
        fetchedAt: new Date().toISOString(),
      }),
      startInstall: async (modelId) => {
        localInstallCalls.push(modelId);
        return { id: 'local-install-1', modelId, status: 'queued', progress: 0, message: 'queued' };
      },
    },
    relayConfig: {
      get: () => ({ ...relaySettings }),
      update: async (value) => {
        relaySettings = { ...relaySettings, ...value };
        return { ...relaySettings };
      },
    },
    relayConnector: async (options) => {
      relayConnectionCalls.push(options);
      return {
      ok: true,
      ready: true,
      running: true,
      cdpReady: true,
      authenticated: true,
      port: options.port,
      profile: options.profile,
      tabs: 1,
      tabCount: 1,
      message: 'Relay 已智能连接。',
      };
    },
    relayRecoverer: async (options) => {
      relayRecoveryCalls.push(options);
      if (relayRecoveryFailuresRemaining > 0) {
        relayRecoveryFailuresRemaining -= 1;
        return { ok: false, ready: false, warnings: [], message: 'Playwright verification failed.' };
      }
      const summary = {
        targetCount: 1,
        pageCount: 1,
        xiaohongshuPages: 1,
        unrelatedPages: 0,
        iframeCount: 0,
        workerCount: 0,
        securityPages: 0,
        pressure: 'normal',
        pressureReasons: [],
        recoveryRecommended: false,
      };
      return {
        ok: true,
        ready: true,
        running: true,
        cdpReady: true,
        repaired: true,
        port: options.port,
        profile: options.profile,
        tabs: 1,
        xiaohongshuTabs: 1,
        before: { ...summary, targetCount: 12, pageCount: 5, pressure: 'high', recoveryRecommended: true },
        after: summary,
        closedTargets: 5,
        createdFreshTarget: true,
        sessionPreserved: true,
        playwrightVerified: true,
        connectionTimeoutMs: 60000,
        warnings: [],
        message: 'Relay recovered.',
      };
    },
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
    const healthResponse = await fetch(`${origin}/api/health`, { headers: { 'x-request-id': 'phase10-request' } });
    assert.equal(healthResponse.headers.get('x-request-id'), 'phase10-request');
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.service, 'xiaohongshu-relay-scraper');
    assert.equal(health.emailDelivery.configured, true);
    const diagnosticBundle = await fetch(`${origin}/api/diagnostics/bundle`).then((response) => response.json());
    assert.equal(diagnosticBundle.schemaVersion, 1);
    assert.equal(diagnosticBundle.events.some((event) => event.requestId === 'phase10-request'), true);

    const discoveredModels = await fetch(`${origin}/api/ai/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' }),
    });
    assert.equal(discoveredModels.status, 200);
    assert.deepEqual((await discoveredModels.json()).models, ['gpt-5.6-terra', 'gpt-4.1-mini']);
    assert.equal(modelDiscoveryCalls.length, 1);

    const localModels = await fetch(`${origin}/api/ai/local-models`).then((response) => response.json());
    assert.equal(localModels.runtime.ready, true);
    assert.equal(localModels.catalog[0].id, 'qwen3.5:4b');
    const localInstall = await fetch(`${origin}/api/ai/local-models/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'qwen3.5:4b' }),
    });
    assert.equal(localInstall.status, 202);
    assert.equal((await localInstall.json()).modelId, 'qwen3.5:4b');
    assert.deepEqual(localInstallCalls, ['qwen3.5:4b']);

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

    const recovered = await fetch(`${origin}/api/relay/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(recovered.status, 200);
    const recoveredPayload = await recovered.json();
    assert.equal(recoveredPayload.playwrightVerified, true);
    assert.equal(recoveredPayload.closedTargets, 5);
    assert.equal(relayRecoveryCalls.length, 1);
    assert.equal(relayRecoveryCalls[0].port, 18801);
    assert.equal(relayRecoveryCalls[0].profile, 'work-profile');

    relayRecoveryFailuresRemaining = 1;
    const rebuilt = await fetch(`${origin}/api/relay/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(rebuilt.status, 200);
    const rebuiltPayload = await rebuilt.json();
    assert.equal(rebuiltPayload.playwrightVerified, true);
    assert.equal(rebuiltPayload.hardRestarted, true);
    assert.equal(rebuiltPayload.recoveryAttempts, 2);
    assert.equal(relayConnectionCalls.at(-1).forceRestart, true);
    assert.equal(relayRecoveryCalls.length, 3);

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
    assert.equal(artifacts.length, 6);
    assert.ok(artifacts.some((artifact) => artifact.name === 'result.json'));
    assert.ok(artifacts.some((artifact) => artifact.name === 'audience-comments.json'));
    assert.ok(artifacts.some((artifact) => artifact.name === 'audience-users.json'));

    const results = await fetch(`${origin}/api/jobs/${job.id}/results?limit=20`).then((response) => response.json());
    assert.equal(results.available, true);
    assert.equal(results.total, 1);
    assert.equal(results.items[0].note_id, 'n1');
    assert.equal(results.codexRuntime.status, 'completed');
    assert.equal(results.filters.stats.incomplete, 0);

    const audience = await fetch(`${origin}/api/jobs/${job.id}/audience?kind=comments&postId=n1`).then((response) => response.json());
    assert.equal(audience.available, true);
    assert.equal(audience.total, 1);
    assert.equal(audience.items[0].post_title, '内容运营实习');
    assert.equal(audience.items[0].user.display_name, '公开用户');

    const expansion = await fetch(`${origin}/api/jobs/${job.id}/expansion`).then((response) => response.json());
    assert.equal(expansion.available, true);
    assert.equal(expansion.seeds[0].postId, 'n1');
    assert.equal(expansion.seeds[0].coverUrl, `/api/jobs/${job.id}/media?url=${encodeURIComponent('https://sns-webpic-qc.xhscdn.com/n1-cover.webp')}`);
    assert.equal(expansion.seeds[0].coverOriginalUrl, 'https://sns-webpic-qc.xhscdn.com/n1-cover.webp');

    const expansionStart = await fetch(`${origin}/api/jobs/${job.id}/expansion/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seedPostIds: ['n1'], config: { rounds: 1 } }),
    });
    assert.equal(expansionStart.status, 202);
    assert.equal((await expansionStart.json()).job.id, job.id);
    assert.deepEqual(expansionCalls[0].slice(0, 2), ['start', job.id]);

    const foreignSeed = await fetch(`${origin}/api/jobs/${job.id}/expansion/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seedPostIds: ['foreign-post'], config: { rounds: 1 } }),
    });
    assert.equal(foreignSeed.status, 400);
    assert.equal(expansionCalls.length, 1);

    assert.equal((await fetch(`${origin}/api/jobs/${job.id}/expansion/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"retryIncomplete":true}' })).status, 202);
    assert.equal((await fetch(`${origin}/api/jobs/${job.id}/expansion/cancel`, { method: 'POST' })).status, 202);
    assert.deepEqual(expansionCalls.map((item) => item[0]), ['start', 'resume', 'cancel']);

    const audienceResume = await fetch(`${origin}/api/jobs/${job.id}/audience/resume`, { method: 'POST' });
    assert.equal(audienceResume.status, 200);
    const audienceResumePayload = await audienceResume.json();
    assert.equal(audienceResumePayload.action, 'attached');
    assert.equal(audienceResumePayload.sourceJobId, job.id);
    assert.equal(audienceResumePayload.job.id, job.id);
    assert.equal(resumeCalls.length, 0);

    const runningRateLimitRecovery = await fetch(`${origin}/api/jobs/${job.id}/audience/recover-rate-limit`, { method: 'POST' });
    assert.equal(runningRateLimitRecovery.status, 202);
    const runningRateLimitPayload = await runningRateLimitRecovery.json();
    assert.equal(runningRateLimitPayload.action, 'signaled');
    assert.equal(runningRateLimitPayload.job.rateLimit.recoveryAction, 'manual_probe');
    assert.deepEqual(rateLimitSignalCalls, [job.id]);
    assert.equal(resumeCalls.length, 0);

    const restoredEmailConfig = await fetch(`${origin}/api/email/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: 'login',
        user: 'sender@example.com',
        from: 'sender@example.com',
        password: 'replacement',
      }),
    });
    assert.equal(restoredEmailConfig.status, 200);
    assert.equal((await fetch(`${origin}/api/email/test`, { method: 'POST' })).status, 200);

    const savedDraft = await fetch(`${origin}/api/jobs/${job.id}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        noteId: 'n1',
        outreach: checkedDraft,
      }),
    });
    assert.equal(savedDraft.status, 200);
    assert.equal((await savedDraft.json()).delivery.action, 'draft_saved');

    const resultsWithDraft = await fetch(`${origin}/api/jobs/${job.id}/results?limit=20`).then((response) => response.json());
    assert.equal(resultsWithDraft.items[0].outreach.email_subject, '应聘内容运营实习｜示例用户');

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
    assert.equal(sentMessages[0].subject, '应聘内容运营实习｜示例用户');

    const rejectedLowQualityEdit = await fetch(`${origin}/api/jobs/${job.id}/send-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        noteId: 'n1',
        to: 'jobs@example.com',
        outreach: {
          ...resultsWithDraft.items[0].outreach,
          email_subject: '申请岗位',
          email_body: '您好，附件是我的简历。',
        },
      }),
    });
    assert.equal(rejectedLowQualityEdit.status, 400);
    assert.equal(sentMessages.length, 1);

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

test('audience supplements read through queued checkpoints and resume from the latest terminal checkpoint', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-chain-'));
  const rootOutputDir = path.join(fixture, 'root-artifacts');
  const childOutputDir = path.join(fixture, 'child-artifacts');
  await Promise.all([
    mkdir(rootOutputDir, { recursive: true }),
    mkdir(childOutputDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(rootOutputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
      { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'First saved post' },
      { note_id: 'post-2', note_url: 'https://example.test/explore/post-2', title: 'Second saved post' },
    ]), 'utf8'),
    writeFile(path.join(rootOutputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'First saved post', status: 'complete', collected_comment_count: 1 },
    ]), 'utf8'),
    writeFile(path.join(rootOutputDir, 'audience-comments.json'), JSON.stringify([
      { comment_id: 'comment-1', post_id: 'post-1', text: 'Previously collected', user: { user_id: 'user-1' } },
    ]), 'utf8'),
    writeFile(path.join(rootOutputDir, 'audience-users.json'), JSON.stringify([
      { user_id: 'user-1', display_name: 'Saved user', enrichment_status: 'complete', post_ids: ['post-1'] },
    ]), 'utf8'),
  ]);

  const rootId = '20260730080000-aaaa1111';
  const childId = '20260730090000-bbbb2222';
  const rootParams = {
    analysisMode: 'general',
    keyword: 'original-content-query',
    collectAudience: false,
  };
  const childParams = {
    ...rootParams,
    mode: 'resume',
    resumeFromJobId: rootId,
    collectAudience: true,
    audienceOnly: true,
  };
  const rootJob = { id: rootId, status: 'incomplete', config: rootParams };
  const childJob = { id: childId, status: 'queued', config: childParams };
  const rootInternal = { ...rootJob, params: rootParams, outputDir: rootOutputDir };
  const childInternal = {
    ...childJob,
    params: childParams,
    outputDir: childOutputDir,
    resumeCheckpointsPending: true,
  };
  const jobs = new Map([[rootId, rootJob], [childId, childJob]]);
  const internals = new Map([[rootId, rootInternal], [childId, childInternal]]);
  const resumeCalls = [];
  const manager = {
    active: null,
    list: () => [childJob, rootJob],
    get: (id) => jobs.get(id) || null,
    getInternal: (id) => internals.get(id) || null,
    resume: async (...args) => {
      resumeCalls.push(args);
      return { ...jobs.get(args[0]), status: 'resuming', attemptId: 'attempt-audience-2' };
    },
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 4096,
      staticDir: null,
      runnerAvailable: true,
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const queuedSnapshot = await fetch(`${origin}/api/jobs/${childId}/audience?limit=20`).then((response) => response.json());
    assert.equal(queuedSnapshot.sourceJobId, rootId);
    assert.equal(queuedSnapshot.checkpointJobId, childId);
    assert.deepEqual(queuedSnapshot.readThroughJobIds, [childId, rootId]);
    assert.equal(queuedSnapshot.total, 1);
    assert.equal(queuedSnapshot.items[0].comment_id, 'comment-1');
    assert.deepEqual(
      queuedSnapshot.posts.map((post) => post.collectionStatus),
      ['complete', 'uncollected'],
    );
    rootJob.status = 'queued';
    rootInternal.status = 'queued';
    const attachedResponse = await fetch(`${origin}/api/jobs/${rootId}/audience/resume`, { method: 'POST' });
    assert.equal(attachedResponse.status, 200);
    const attached = await attachedResponse.json();
    assert.equal(attached.action, 'attached');
    assert.equal(attached.checkpointJobId, rootId);
    assert.equal(attached.stateOwnerJobId, childId);
    assert.equal(attached.job.id, rootId);
    assert.equal(resumeCalls.length, 0);
    rootJob.status = 'incomplete';
    rootInternal.status = 'incomplete';

    await Promise.all([
      writeFile(path.join(childOutputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
        { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
        { note_id: 'post-2', note_url: 'https://example.test/explore/post-2' },
      ]), 'utf8'),
      writeFile(path.join(childOutputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
        { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'First saved post' },
        { note_id: 'post-2', note_url: 'https://example.test/explore/post-2', title: 'Second saved post' },
      ]), 'utf8'),
      writeFile(path.join(childOutputDir, 'audience-posts.json'), JSON.stringify([
        { post_id: 'post-2', note_url: 'https://example.test/explore/post-2', title: 'Second saved post', status: 'partial', collected_comment_count: 1 },
      ]), 'utf8'),
      writeFile(path.join(childOutputDir, 'audience-comments.json'), JSON.stringify([
        { comment_id: 'comment-2', post_id: 'post-2', text: 'Newly collected', user: { user_id: 'user-2' } },
      ]), 'utf8'),
      writeFile(path.join(childOutputDir, 'audience-users.json'), JSON.stringify([
        { user_id: 'user-2', display_name: 'New user', enrichment_status: 'partial', post_ids: ['post-2'] },
      ]), 'utf8'),
    ]);
    childJob.status = 'incomplete';
    childInternal.status = 'incomplete';
    childInternal.resumeCheckpointsPending = false;

    const mergedSnapshot = await fetch(`${origin}/api/jobs/${childId}/audience?limit=20`).then((response) => response.json());
    assert.deepEqual(mergedSnapshot.items.map((comment) => comment.comment_id), ['comment-1', 'comment-2']);
    assert.deepEqual(
      mergedSnapshot.posts.map((post) => post.collectionStatus),
      ['complete', 'partial'],
    );

    const canonicalResume = await fetch(`${origin}/api/jobs/${rootId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'audience', idempotencyKey: 'legacy-audience-owner' }),
    });
    assert.equal(canonicalResume.status, 202);
    assert.equal((await canonicalResume.json()).id, rootId);
    assert.equal(resumeCalls[0][0], rootId);
    assert.equal(resumeCalls[0][1].scope, 'audience');
    assert.deepEqual(resumeCalls[0][1].resumeCheckpointJobIds, [rootId, childId]);

    const resumed = await fetch(`${origin}/api/jobs/${rootId}/audience/resume`, { method: 'POST' });
    assert.equal(resumed.status, 202);
    const payload = await resumed.json();
    assert.equal(payload.action, 'started');
    assert.equal(payload.sourceJobId, rootId);
    assert.equal(payload.checkpointJobId, rootId);
    assert.equal(payload.stateOwnerJobId, childId);
    assert.equal(payload.job.id, rootId);
    assert.equal(resumeCalls[1][0], rootId);
    assert.equal(resumeCalls[1][1].scope, 'audience');
    assert.equal(resumeCalls[1][1].params.resumeFromJobId, rootId);
    assert.equal(resumeCalls[1][1].params.keyword, 'original-content-query');
    assert.deepEqual(resumeCalls[1][1].resumeCheckpointJobIds, [rootId, childId]);

    const rateLimitRecovery = await fetch(`${origin}/api/jobs/${rootId}/audience/recover-rate-limit`, {
      method: 'POST',
    });
    assert.equal(rateLimitRecovery.status, 202);
    const rateLimitPayload = await rateLimitRecovery.json();
    assert.equal(rateLimitPayload.action, 'started');
    assert.equal(rateLimitPayload.sourceJobId, rootId);
    assert.equal(rateLimitPayload.stateOwnerJobId, childId);
    assert.equal(resumeCalls[2][0], rootId);
    assert.equal(resumeCalls[2][1].scope, 'audience');
    assert.equal(resumeCalls[2][1].forceCompleted, true);
    assert.equal(resumeCalls[2][1].requestedBy, 'rate_limit_manual_recovery');
    assert.equal(resumeCalls[2][1].rateLimitRecoveryMode, 'manual');
    assert.deepEqual(resumeCalls[2][1].resumeCheckpointJobIds, [rootId, childId]);

    const grown = await fetch(`${origin}/api/jobs/${rootId}/audience/grow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxScrolls: 100 }),
    });
    assert.equal(grown.status, 202);
    const growthPayload = await grown.json();
    assert.equal(growthPayload.action, 'started');
    assert.equal(growthPayload.sourceJobId, rootId);
    assert.equal(growthPayload.stateOwnerJobId, childId);
    assert.equal(growthPayload.maxScrolls, 100);
    assert.equal(resumeCalls[3][0], rootId);
    assert.equal(resumeCalls[3][1].scope, 'full');
    assert.equal(resumeCalls[3][1].forceCompleted, true);
    assert.equal(resumeCalls[3][1].params.discoverMore, true);
    assert.equal(resumeCalls[3][1].params.audienceOnly, false);
    assert.equal(resumeCalls[3][1].params.collectAudience, true);
    assert.equal(resumeCalls[3][1].params.searchSort, 'latest');
    assert.equal(resumeCalls[3][1].params.maxScrolls, 100);
    assert.deepEqual(resumeCalls[3][1].resumeCheckpointJobIds, [rootId, childId]);

  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('audience history keeps richer sibling checkpoints when the latest sibling failed empty', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-siblings-'));
  const rootOutputDir = path.join(fixture, 'root-artifacts');
  const earlierOutputDir = path.join(fixture, 'earlier-audience-artifacts');
  const latestOutputDir = path.join(fixture, 'latest-empty-artifacts');
  const outputDirs = [rootOutputDir, earlierOutputDir, latestOutputDir];
  await Promise.all(outputDirs.map((outputDir) => mkdir(outputDir, { recursive: true })));

  const cards = [{ note_id: 'post-1', note_url: 'https://example.test/explore/post-1' }];
  const notes = [{ note_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'Saved post' }];
  await Promise.all(outputDirs.flatMap((outputDir) => [
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(notes), 'utf8'),
  ]));

  const comments = Array.from({ length: 34 }, (_, index) => ({
    comment_id: `comment-${index + 1}`,
    post_id: 'post-1',
    text: `Saved comment ${index + 1}`,
    user: { user_id: `user-${index + 1}` },
  }));
  const users = Array.from({ length: 84 }, (_, index) => ({
    user_id: `user-${index + 1}`,
    display_name: `Saved user ${index + 1}`,
    enrichment_status: 'complete',
    post_ids: ['post-1'],
  }));
  await Promise.all([
    writeFile(path.join(earlierOutputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-1', note_url: notes[0].note_url, title: 'Saved post', status: 'partial', collected_comment_count: 34 },
    ]), 'utf8'),
    writeFile(path.join(earlierOutputDir, 'audience-comments.json'), JSON.stringify(comments), 'utf8'),
    writeFile(path.join(earlierOutputDir, 'audience-users.json'), JSON.stringify(users), 'utf8'),
    writeFile(path.join(earlierOutputDir, 'audience-summary.json'), JSON.stringify({
      status: 'partial',
      postsTotal: 1,
      postsComplete: 0,
      postsPartial: 1,
      commentsCollected: 34,
      usersDiscovered: 84,
      profilesComplete: 84,
    }), 'utf8'),
  ]);

  const rootId = '20260730080000-aaaa1111';
  const earlierId = '20260730090000-bbbb2222';
  const latestId = '20260730100000-cccc3333';
  const rootParams = {
    analysisMode: 'general',
    keyword: 'original-content-query',
    collectAudience: false,
  };
  const earlierParams = {
    ...rootParams,
    mode: 'resume',
    resumeFromJobId: rootId,
    collectAudience: true,
    audienceOnly: true,
  };
  const latestParams = { ...earlierParams };
  const rootJob = { id: rootId, status: 'incomplete', config: rootParams };
  const earlierJob = { id: earlierId, status: 'incomplete', config: earlierParams };
  const latestJob = { id: latestId, status: 'failed', config: latestParams };
  const jobs = new Map([[rootId, rootJob], [earlierId, earlierJob], [latestId, latestJob]]);
  const internals = new Map([
    [rootId, { ...rootJob, params: rootParams, outputDir: rootOutputDir }],
    [earlierId, { ...earlierJob, params: earlierParams, outputDir: earlierOutputDir, resumeCheckpointsPending: false }],
    [latestId, { ...latestJob, params: latestParams, outputDir: latestOutputDir, resumeCheckpointsPending: false }],
  ]);
  const resumeCalls = [];
  const manager = {
    active: null,
    list: () => [latestJob, earlierJob, rootJob],
    get: (id) => jobs.get(id) || null,
    getInternal: (id) => internals.get(id) || null,
    resume: async (...args) => {
      resumeCalls.push(args);
      return { ...jobs.get(args[0]), status: 'resuming', attemptId: 'attempt-audience-3' };
    },
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 4096,
      staticDir: null,
      runnerAvailable: true,
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const fromRoot = await fetch(`${origin}/api/jobs/${rootId}/audience?kind=comments&limit=100`).then((response) => response.json());
    assert.equal(fromRoot.sourceJobId, rootId);
    assert.equal(fromRoot.checkpointJobId, rootId);
    assert.deepEqual(fromRoot.mergedCheckpointJobIds, [rootId, earlierId, latestId]);
    assert.equal(fromRoot.total, 34);
    assert.equal(fromRoot.totals.users, 84);

    const fromLatest = await fetch(`${origin}/api/jobs/${latestId}/audience?kind=users&limit=100`).then((response) => response.json());
    assert.equal(fromLatest.sourceJobId, rootId);
    assert.equal(fromLatest.checkpointJobId, latestId);
    assert.deepEqual(fromLatest.mergedCheckpointJobIds, [rootId, earlierId, latestId]);
    assert.equal(fromLatest.total, 84);
    assert.equal(fromLatest.totals.comments, 34);

    const canonicalResume = await fetch(`${origin}/api/jobs/${latestId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'audience', idempotencyKey: 'richer-audience-owner' }),
    });
    assert.equal(canonicalResume.status, 202);
    assert.equal((await canonicalResume.json()).id, latestId);
    assert.equal(resumeCalls[0][0], latestId);
    assert.equal(resumeCalls[0][1].scope, 'audience');
    assert.deepEqual(resumeCalls[0][1].resumeCheckpointJobIds, [rootId, earlierId, latestId]);

    const resumed = await fetch(`${origin}/api/jobs/${latestId}/audience/resume`, { method: 'POST' });
    assert.equal(resumed.status, 202);
    const payload = await resumed.json();
    assert.equal(payload.action, 'started');
    assert.equal(payload.sourceJobId, rootId);
    assert.equal(payload.checkpointJobId, latestId);
    assert.equal(payload.stateOwnerJobId, earlierId);
    assert.equal(payload.job.id, latestId);
    assert.equal(resumeCalls[1][0], latestId);
    assert.equal(resumeCalls[1][1].scope, 'audience');
    assert.equal(resumeCalls[1][1].params.resumeFromJobId, rootId);
    assert.deepEqual(resumeCalls[1][1].resumeCheckpointJobIds, [rootId, earlierId, latestId]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('resume endpoint keeps the original job identity and forwards scope and idempotency', async () => {
  const id = '20260731123000-acde1234';
  const createdAt = '2026-07-31T04:30:00.000Z';
  const job = {
    id,
    keyword: '原地续跑',
    status: 'interrupted',
    createdAt,
    outputDir: 'C:\\jobs\\original\\artifacts',
    resumeCount: 0,
    attempts: [{ attemptId: 'attempt-1', sequence: 1, kind: 'initial' }],
  };
  const resumeCalls = [];
  const manager = {
    active: null,
    list: () => [job],
    get: (jobId) => jobId === id ? job : null,
    getInternal: (jobId) => jobId === id ? job : null,
    resume: async (jobId, options) => {
      resumeCalls.push([jobId, options]);
      return {
        ...job,
        status: 'resuming',
        resumeCount: 1,
        attemptId: 'attempt-2',
        attempts: [...job.attempts, { attemptId: 'attempt-2', sequence: 2, kind: 'resume', resumeScope: options.scope }],
      };
    },
  };
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, staticDir: null, runnerAvailable: true },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${origin}/api/jobs/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'body_completion',
        aiSessionId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'resume-click-1',
      }),
    });
    assert.equal(response.status, 202);
    const resumed = await response.json();
    assert.equal(resumed.id, id);
    assert.equal(resumed.createdAt, createdAt);
    assert.equal(resumed.outputDir, job.outputDir);
    assert.equal(resumed.resumeCount, 1);
    assert.equal(resumed.attemptId, 'attempt-2');
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0][0], id);
    assert.deepEqual(resumeCalls[0][1], {
      scope: 'body_completion',
      aiSessionId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'resume-click-1',
      requestedBy: 'resume_api',
    });
    const listed = await fetch(`${origin}/api/jobs`).then((item) => item.json());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, id);

    const audienceResponse = await fetch(`${origin}/api/jobs/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'audience', idempotencyKey: 'resume-audience-1' }),
    });
    assert.equal(audienceResponse.status, 202);
    assert.equal((await audienceResponse.json()).id, id);
    assert.equal(resumeCalls.length, 2);
    assert.deepEqual(resumeCalls[1], [id, {
      scope: 'audience',
      idempotencyKey: 'resume-audience-1',
      requestedBy: 'resume_api',
      resumeCheckpointJobIds: [id],
    }]);

    const invalid = await fetch(`${origin}/api/jobs/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'unknown', idempotencyKey: 'invalid-scope' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'RESUME_SCOPE_INVALID');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
