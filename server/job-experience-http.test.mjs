import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.mjs';
import { createDiagnostics } from './lib/diagnostics.mjs';

const JOB_ID = '20260804090000-abcdef12';

function workflowProblem(overrides = {}) {
  return {
    code: 'RATE_LIMITED',
    category: 'access',
    severity: 'warning',
    userTitle: 'Platform access is temporarily paused',
    userMessage: 'Saved 12 of 20 items; recovery will be checked shortly.',
    preservedResultCount: 12,
    automaticAction: 'Wait before the next recovery probe.',
    retryable: true,
    retryAt: '2026-08-04T02:00:00.000Z',
    requiresUserAction: false,
    action: { id: 'check_recovery', label: 'Check recovery now' },
    affectedStage: 'body',
    technicalRef: 'evt-rate-limit-1',
    ...overrides,
  };
}

function workflowSnapshot(overrides = {}) {
  return {
    schemaVersion: 3,
    revision: 7,
    throughSequence: 19,
    jobId: JOB_ID,
    activeAttemptId: 'attempt-2',
    journey: 'job',
    state: 'waiting_system',
    activeStage: 'body',
    headline: 'Waiting for recovery',
    detail: 'Existing results are saved.',
    stages: [],
    counts: {
      discovered: 20,
      fullText: 12,
      confirmedJobs: 0,
      nonJobs: 0,
      matchReady: 0,
      draftReady: 0,
      applicationReady: 0,
      pending: 8,
      retryable: 8,
      unavailable: 0,
    },
    speed: {
      activePerMinute: 9,
      wallPerMinute: 6,
      cacheHits: 2,
      networkSuccess: 10,
      etaMinSeconds: 80,
      etaMaxSeconds: 120,
      confidence: 'medium',
    },
    issues: [workflowProblem()],
    connection: { state: 'live', lastEventAt: '2026-08-04T01:59:00.000Z' },
    checkpoint: { revision: 7, savedAt: '2026-08-04T01:59:00.000Z', resumeAvailable: true },
    ...overrides,
  };
}

async function startHarness(options = {}) {
  const calls = { resume: [], signal: [], connect: [], open: [] };
  let job = {
    id: JOB_ID,
    status: 'interrupted',
    currentAttemptId: 'attempt-2',
    activeAttemptId: null,
    revision: 7,
    throughSequence: 19,
    resumeAvailable: true,
    rateLimit: {
      detected: true,
      status: 'waiting',
      nextRetryAt: '2026-08-04T02:00:00.000Z',
      stableSuccesses: 1,
      recoveryAction: 'warm_start_probe',
      privatePath: 'must-not-leak',
    },
    securityRestriction: null,
    experienceSnapshot: workflowSnapshot(),
    ...options.job,
  };
  const manager = {
    active: null,
    list: () => [job],
    get: (id) => id === JOB_ID ? job : null,
    getInternal: (id) => id === JOB_ID ? { ...job, outputDir: 'private-output-dir' } : null,
    resume: async (id, resumeOptions) => {
      calls.resume.push([id, resumeOptions]);
      if (options.resumeError) throw options.resumeError;
      job = {
        ...job,
        status: 'resuming',
        activeAttemptId: 'attempt-3',
        experienceSnapshot: workflowSnapshot({
          activeAttemptId: 'attempt-3',
          state: 'retrying',
          issues: [],
        }),
      };
      return job;
    },
    signalRateLimitRecovery: async (id, signalOptions) => {
      calls.signal.push([id, signalOptions]);
      if (options.signalResult) return options.signalResult(job);
      return { signaled: true, job: { ...job, status: 'running' } };
    },
  };
  const diagnostics = createDiagnostics();
  diagnostics.recordJobEvent(JOB_ID, 'state', { status: 'interrupted', stageId: 'body', errorCode: 'RATE_LIMITED' });
  diagnostics.recordJobEvent('20260804090000-deadbeef', 'state', { status: 'running', stageId: 'discovery' });
  const relaySupervisor = {
    snapshot: () => ({ phase: 'idle' }),
    connect: async (relayOptions) => {
      calls.connect.push(relayOptions);
      return options.connection || { ready: true, running: true, cdpReady: true, message: 'ready' };
    },
  };
  const app = createApp({
    manager,
    diagnostics,
    relaySupervisor,
    relayConfig: { get: () => ({ port: 18792, profile: 'saved-profile' }) },
    relayLoginOpener: async (openOptions) => {
      calls.open.push(openOptions);
      return options.opened || { opened: true, message: 'Login page opened.' };
    },
    preflightService: { run: async () => ({ ready: true, checks: [] }) },
    audienceAiService: {},
    aiSessions: {},
    profileStore: {},
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 4096,
      openClawConfigPath: 'unused',
      staticDir: 'unused',
      runnerAvailable: true,
    },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    calls,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('job experience read APIs expose snapshot, issues, and job-scoped safe diagnostics', async (t) => {
  const harness = await startHarness();
  t.after(harness.close);

  const snapshot = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/experience-snapshot`).then((response) => response.json());
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.jobId, JOB_ID);
  assert.equal(snapshot.throughSequence, 19);

  const issues = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/issues`).then((response) => response.json());
  assert.equal(issues.jobId, JOB_ID);
  assert.equal(issues.throughSequence, 19);
  assert.deepEqual(issues.issues.map((item) => item.code), ['RATE_LIMITED']);

  const diagnostics = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/technical-diagnostics`).then((response) => response.json());
  assert.equal(diagnostics.jobId, JOB_ID);
  assert.equal(diagnostics.revision, 7);
  assert.equal(diagnostics.events.length, 1);
  assert.equal(diagnostics.events[0].jobId, JOB_ID);
  assert.equal(diagnostics.rateLimit.privatePath, undefined);
  assert.equal(JSON.stringify(diagnostics).includes('private-output-dir'), false);
  assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'), false);
});

test('job experience actions retry the mapped stage, signal recovery, and open only the fixed login URL', async (t) => {
  const harness = await startHarness();
  t.after(harness.close);

  const retriedResponse = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/actions/retry-stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'quality', idempotencyKey: 'retry-quality-1' }),
  });
  const retried = await retriedResponse.json();
  assert.equal(retriedResponse.status, 202);
  assert.equal(retried.action, 'started');
  assert.equal(retried.scope, 'analysis');
  assert.equal(harness.calls.resume[0][1].requestedBy, 'experience_retry_stage_api');
  assert.equal(harness.calls.resume[0][1].idempotencyKey, 'retry-quality-1');

  const checkedResponse = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/actions/check-recovery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: 'manual-probe-http-1' }),
  });
  const checked = await checkedResponse.json();
  assert.equal(checkedResponse.status, 202);
  assert.equal(checked.action, 'signaled');
  assert.deepEqual(harness.calls.signal, [[JOB_ID, { idempotencyKey: 'manual-probe-http-1' }]]);

  const injected = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/actions/open-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(injected.status, 400);
  assert.equal(harness.calls.open.length, 0);

  const openedResponse = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/actions/open-login`, { method: 'POST' });
  const opened = await openedResponse.json();
  assert.equal(openedResponse.status, 200);
  assert.equal(opened.action, 'opened');
  assert.equal(opened.url, 'https://www.xiaohongshu.com');
  assert.equal(harness.calls.open[0].url, 'https://www.xiaohongshu.com');
  assert.equal(harness.calls.open[0].profile, 'saved-profile');
});

test('job experience action failures retain the technical code and current user problem', async (t) => {
  const error = Object.assign(new Error('The saved checkpoint cannot be resumed yet.'), { code: 'JOB_NOT_RESUMABLE' });
  const harness = await startHarness({ resumeError: error });
  t.after(harness.close);

  const response = await fetch(`${harness.origin}/api/jobs/${JOB_ID}/actions/retry-stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'body' }),
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'JOB_NOT_RESUMABLE');
  assert.equal(body.error.code, 'JOB_NOT_RESUMABLE');
  assert.equal(body.problem.code, 'RATE_LIMITED');
  assert.equal(body.retryAt, '2026-08-04T02:00:00.000Z');
  assert.deepEqual(body.action, { id: 'check_recovery', label: 'Check recovery now' });
  assert.equal(body.resumable, true);
});
