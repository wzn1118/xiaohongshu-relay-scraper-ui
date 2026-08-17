import assert from 'node:assert/strict';
import test from 'node:test';
import { PreflightService } from './preflight-service.mjs';

const COMPLETE_CANDIDATE = Object.freeze({
  name: 'Test User',
  school: 'Test University',
  major: 'Computer Science',
  email: 'test@example.com',
});

const BASE_PARAMS = Object.freeze({
  analysisMode: 'job',
  useCodexRuntime: true,
  aiSessionId: 'session-1',
  relayPort: 18800,
  browserProfile: 'openclaw',
  candidateProfile: COMPLETE_CANDIDATE,
});

test('preflight returns the complete contract when every readiness check passes', async () => {
  const report = await createService().run(BASE_PARAMS);

  assert.equal(report.kind, 'preflight');
  assert.equal(report.status, 'ready');
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.map((item) => item.code), [
    'CHROME_RELAY',
    'AI_PROVIDER',
    'AI_MODEL',
    'PROFILE',
    'SMTP',
    'OUTPUT_DIRECTORY',
    'FILE_WRITE_PERMISSION',
    'RUNTIME_DEPENDENCIES',
    'PORT_PROCESS_STATE',
  ]);
  for (const item of report.checks) {
    assert.equal(item.status, 'passed');
    assert.equal(typeof item.blocking, 'boolean');
    assert.equal(typeof item.message, 'string');
    assert.equal(typeof item.action, 'string');
    assert.equal(typeof item.details, 'object');
    assert.equal(typeof item.durationMs, 'number');
  }
});

test('warning-only preflight remains ready when SMTP and optional profile are absent', async () => {
  const service = createService({
    smtpConfig: { getPublic: () => ({ configured: false }) },
    config: { legacyProfilePath: null },
  });
  const report = await service.run({ ...BASE_PARAMS, analysisMode: 'general', candidateProfile: {} });

  assert.equal(report.ready, true);
  assert.equal(find(report, 'SMTP').status, 'warning');
  assert.equal(find(report, 'SMTP').blocking, false);
  assert.equal(find(report, 'PROFILE').status, 'warning');
  assert.equal(find(report, 'PROFILE').blocking, false);
});

test('raw collection does not require an AI session or model', async () => {
  const report = await createService().run({
    ...BASE_PARAMS,
    analysisMode: 'general',
    skipPostprocess: true,
    useCodexRuntime: true,
    aiSessionId: null,
  });

  assert.equal(report.ready, true);
  assert.equal(find(report, 'AI_PROVIDER').status, 'passed');
  assert.equal(find(report, 'AI_PROVIDER').details.enabled, false);
  assert.equal(find(report, 'AI_PROVIDER').details.rawCollection, true);
  assert.equal(find(report, 'AI_MODEL').status, 'passed');
  assert.equal(find(report, 'AI_MODEL').details.enabled, false);
});

test('Relay timeout becomes a structured blocking result without rejecting the run', async () => {
  const service = createService({
    timeoutMs: 15,
    operations: { relayProbe: () => new Promise(() => {}) },
  });
  const report = await service.run(BASE_PARAMS);
  const relay = find(report, 'CHROME_RELAY');

  assert.equal(report.ready, false);
  assert.equal(relay.status, 'blocked');
  assert.equal(relay.details.errorCode, 'PREFLIGHT_TIMEOUT');
  assert.equal(relay.details.timedOut, true);
});

test('AI provider failures block provider and model checks without leaking credentials', async () => {
  const service = createService({
    operations: {
      resolveAiSession: () => { throw Object.assign(new Error('secret credential failure'), { code: 'AI_SESSION_EXPIRED', apiKey: 'do-not-leak' }); },
    },
  });
  const report = await service.run(BASE_PARAMS);

  assert.equal(report.ready, false);
  assert.equal(find(report, 'AI_PROVIDER').status, 'blocked');
  assert.equal(find(report, 'AI_PROVIDER').details.errorCode, 'AI_SESSION_EXPIRED');
  assert.equal(find(report, 'AI_MODEL').status, 'blocked');
  assert.doesNotMatch(JSON.stringify(report), /do-not-leak/);
});

test('missing SMTP is reported as a non-blocking warning', async () => {
  const report = await createService({ smtpConfig: { getPublic: () => ({}) } }).run(BASE_PARAMS);
  const smtp = find(report, 'SMTP');

  assert.equal(report.ready, true);
  assert.equal(smtp.status, 'warning');
  assert.equal(smtp.blocking, false);
});

test('incomplete job profile blocks formal readiness', async () => {
  const service = createService({ config: { legacyProfilePath: null } });
  const report = await service.run({ ...BASE_PARAMS, candidateProfile: {} });

  assert.equal(report.ready, false);
  assert.equal(find(report, 'PROFILE').status, 'blocked');
  assert.equal(find(report, 'PROFILE').blocking, true);
});

test('unwritable output is isolated to a structured file-permission failure', async () => {
  const service = createService({
    operations: {
      testWritePermission: () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); },
    },
  });
  const report = await service.run(BASE_PARAMS);

  assert.equal(report.ready, false);
  assert.equal(find(report, 'OUTPUT_DIRECTORY').status, 'passed');
  assert.equal(find(report, 'FILE_WRITE_PERMISSION').status, 'blocked');
  assert.equal(find(report, 'FILE_WRITE_PERMISSION').details.errorCode, 'EACCES');
});

test('missing runtime dependency blocks readiness while other checks complete', async () => {
  const service = createService({
    operations: {
      checkRuntimeDependencies: () => { throw Object.assign(new Error('runner missing'), { code: 'ENOENT' }); },
    },
  });
  const report = await service.run(BASE_PARAMS);

  assert.equal(report.ready, false);
  assert.equal(find(report, 'RUNTIME_DEPENDENCIES').status, 'blocked');
  assert.equal(find(report, 'RUNTIME_DEPENDENCIES').details.errorCode, 'ENOENT');
  assert.equal(report.checks.length, 9);
});

test('non-blocking check exceptions become warnings and do not crash the service', async () => {
  const report = await createService({
    operations: { smtpStatus: () => { throw Object.assign(new Error('SMTP store unavailable'), { code: 'SMTP_STORE_DOWN' }); } },
  }).run(BASE_PARAMS);

  assert.equal(report.ready, true);
  assert.equal(find(report, 'SMTP').status, 'warning');
  assert.equal(find(report, 'SMTP').details.errorCode, 'SMTP_STORE_DOWN');
});

function createService(overrides = {}) {
  const config = {
    port: 4317,
    dataDir: process.cwd(),
    pythonBin: 'python',
    runnerPath: new URL('../scripts/run_project_workflow.py', import.meta.url).pathname,
    legacyProfilePath: null,
    ...overrides.config,
  };
  return new PreflightService({
    config,
    timeoutMs: overrides.timeoutMs || 200,
    aiSessions: { resolve: () => ({ provider: 'openai', model: 'test-model', baseUrl: 'http://127.0.0.1:11434/v1', wireApi: 'responses' }) },
    profileStore: { get: async () => null },
    smtpConfig: overrides.smtpConfig || { getPublic: () => ({ provider: 'custom', host: 'smtp.example.com', from: 'sender@example.com', auth: 'login', hasPassword: true, verified: true }) },
    relayRuntime: { probe: async () => ({ ok: true, ready: true, running: true, cdpReady: true, tabs: 1, xiaohongshuTabs: 1 }) },
    getRelayConfig: () => ({ port: 18800, profile: 'openclaw' }),
    operations: {
      ensureOutputDirectory: async () => {},
      testWritePermission: async () => {},
      checkRuntimeDependencies: async ({ pythonBin, runnerPath }) => ({ pythonBin, runnerPath, pythonVersion: 'Python 3' }),
      checkPort: async () => true,
      ...overrides.operations,
    },
  });
}

function find(report, code) {
  return report.checks.find((item) => item.code === code);
}
