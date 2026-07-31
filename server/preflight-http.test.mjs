import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createApp } from './app.mjs';

test('preflight API is isolated from formal history, metrics, artifacts, and JobManager', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-preflight-http-'));
  const history = [
    { id: '20260801010101-aaaaaaaa', status: 'completed', createdAt: '2026-08-01T01:01:01.000Z', endedAt: '2026-08-01T01:01:03.000Z' },
    { id: '20260801010201-bbbbbbbb', status: 'failed', createdAt: '2026-08-01T01:02:01.000Z', endedAt: '2026-08-01T01:02:06.000Z' },
  ];
  const starts = [];
  const manager = {
    active: null,
    list: () => history.map((item) => ({ ...item })),
    start: async (params) => {
      starts.push(params);
      return { id: '20260801010301-cccccccc', status: 'queued', createdAt: '2026-08-01T01:03:01.000Z', config: params };
    },
  };
  const preflightService = {
    run: async (params) => params.keyword === 'blocked'
      ? report(false, [{ code: 'CHROME_RELAY', status: 'blocked', blocking: true }])
      : params.keyword === 'expired'
        ? report(false, [{ code: 'AI_PROVIDER', status: 'blocked', blocking: true, details: { errorCode: 'AI_SESSION_EXPIRED' } }])
      : params.keyword === 'warning'
        ? report(true, [{ code: 'SMTP', status: 'warning', blocking: false }])
        : report(true, [{ code: 'CHROME_RELAY', status: 'passed', blocking: true }]),
  };
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 64 * 1024, dataDir: root, staticDir: root, runnerAvailable: true },
    aiSessions: { providers: () => [] },
    profileStore: { list: async () => [] },
    relayConfig: { get: () => ({ port: 18800, profile: 'openclaw' }) },
    smtpConfig: { getPublic: () => ({}) },
    relaySupervisor: { snapshot: () => ({ state: 'ready' }) },
    preflightService,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const beforeHistory = await getJson(origin, '/api/jobs');
  const beforeMetrics = metrics(beforeHistory);

  for (let index = 0; index < 10; index += 1) {
    const response = await postJson(origin, '/api/preflight', { analysisMode: 'general', keyword: `check-${index}` });
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, 'preflight');
    assert.equal(response.body.ready, true);
    assertContract(response.body.checks[0]);
  }

  assert.deepEqual(await getJson(origin, '/api/jobs'), beforeHistory);
  assert.deepEqual(metrics(await getJson(origin, '/api/jobs')), beforeMetrics);
  assert.deepEqual(await readdir(root), []);
  assert.equal(starts.length, 0);

  const legacy = await postJson(origin, '/api/jobs', { analysisMode: 'general', keyword: 'legacy-check', checkOnly: true });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.kind, 'preflight');
  assert.equal(starts.length, 0);

  const blocked = await postJson(origin, '/api/jobs', { analysisMode: 'general', keyword: 'blocked' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PREFLIGHT_BLOCKED');
  assert.equal(blocked.body.preflight.ready, false);
  assert.equal(starts.length, 0);

  const expired = await postJson(origin, '/api/jobs', { analysisMode: 'general', keyword: 'expired' });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error.code, 'AI_SESSION_EXPIRED');
  assert.equal(starts.length, 0);

  const warning = await postJson(origin, '/api/jobs', { analysisMode: 'general', keyword: 'warning' });
  assert.equal(warning.status, 202);
  assert.equal(warning.body.status, 'queued');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].keyword, 'warning');
  assert.equal(starts[0].checkOnly, false);
  assert.equal(starts[0].searchSort, 'latest');
  assert.deepEqual(await getJson(origin, '/api/jobs'), beforeHistory);
});

function report(ready, partialChecks) {
  return {
    schemaVersion: 1,
    kind: 'preflight',
    status: ready ? 'ready' : 'blocked',
    ready,
    checkedAt: new Date().toISOString(),
    durationMs: 1,
    checks: partialChecks.map((item) => ({
      ...item,
      message: `${item.code} result`,
      action: 'Follow the documented action.',
      details: item.details || {},
      durationMs: 1,
    })),
  };
}

function assertContract(item) {
  for (const field of ['code', 'status', 'blocking', 'message', 'action', 'details', 'durationMs']) assert.ok(Object.hasOwn(item, field), field);
}

function metrics(items) {
  const terminal = items.filter((item) => item.endedAt);
  return {
    count: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'failed').length,
    averageDurationMs: terminal.reduce((sum, item) => sum + Date.parse(item.endedAt) - Date.parse(item.createdAt), 0) / terminal.length,
  };
}

async function getJson(origin, pathname) {
  return fetch(`${origin}${pathname}`).then((response) => response.json());
}

async function postJson(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
