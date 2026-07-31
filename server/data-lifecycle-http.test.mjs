import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from './app.mjs';

const JOB_ID = '20260801090000-aabbccdd';

function createServer({ dataLifecycle, manager = emptyManager() }) {
  return http.createServer(createApp({
    manager,
    dataLifecycle,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 16 * 1024,
      openClawConfigPath: 'unused',
      staticDir: 'unused',
      runnerAvailable: true,
    },
    relaySupervisor: {
      snapshot: () => ({ status: 'idle' }),
      probe: async () => ({ ready: false }),
      connect: async () => ({ ready: false }),
      recover: async () => ({ ready: false }),
    },
    preflightService: { run: async () => ({ status: 'ready', ready: true, checks: [] }) },
  }));
}

function emptyManager() {
  return {
    active: null,
    list: () => [],
    get: () => null,
    getInternal: () => null,
  };
}

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function requestJson(baseUrl, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('data lifecycle HTTP routes preserve preview, execute and retention contracts', async (t) => {
  const calls = [];
  let retention = { schemaVersion: 1, enabled: false, days: 30, pinnedJobIds: [] };
  const dataLifecycle = {
    ownership: () => ({ schemaVersion: 1, relations: [{ owner: 'job', dependent: 'artifact' }] }),
    preview: async (spec) => {
      calls.push(['preview', spec]);
      return { status: 'ready', confirmationToken: 'one-time-token', entities: [{ type: spec.entityType }] };
    },
    execute: async (spec) => {
      calls.push(['execute', spec]);
      return { deleted: true, operation: `delete_${spec.entityType}`, audit: { recorded: true } };
    },
    getRetention: () => retention,
    updateRetention: async (value) => {
      calls.push(['retention', value]);
      retention = { ...retention, ...value };
      return retention;
    },
    cleanupExpired: async (value) => {
      calls.push(['cleanup', value]);
      return { enabled: true, dryRun: value.dryRun, deleted: value.dryRun ? [] : [{ operation: 'delete_job' }] };
    },
  };
  const baseUrl = await listen(t, createServer({ dataLifecycle }));

  const ownership = await requestJson(baseUrl, '/api/data/ownership');
  assert.equal(ownership.status, 200);
  assert.equal(ownership.body.relations[0].dependent, 'artifact');

  const preview = await requestJson(baseUrl, '/api/data/deletions/preview', {
    method: 'POST',
    body: { entityType: 'job', jobId: JOB_ID },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.confirmationToken, 'one-time-token');

  const execution = await requestJson(baseUrl, '/api/data/deletions/execute', {
    method: 'POST',
    body: { entityType: 'job', jobId: JOB_ID, confirmationToken: 'one-time-token' },
  });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.audit.recorded, true);

  const before = await requestJson(baseUrl, '/api/data/retention');
  assert.equal(before.body.enabled, false);
  const updated = await requestJson(baseUrl, '/api/data/retention', {
    method: 'PUT',
    body: { enabled: true, days: 14, pinnedJobIds: [JOB_ID] },
  });
  assert.equal(updated.body.days, 14);
  const cleanup = await requestJson(baseUrl, '/api/data/retention/cleanup', {
    method: 'POST',
    body: { dryRun: false },
  });
  assert.equal(cleanup.body.deleted.length, 1);
  assert.deepEqual(calls.map(([name]) => name), ['preview', 'execute', 'retention', 'cleanup']);
  assert.deepEqual(calls.at(-1), ['cleanup', { dryRun: false }]);
});

test('data lifecycle HTTP routes map blocked deletion and missing entities without hiding impact', async (t) => {
  const dataLifecycle = {
    ownership: () => ({ schemaVersion: 1, relations: [] }),
    preview: async () => {
      const error = new Error('Task not found.');
      error.code = 'JOB_NOT_FOUND';
      throw error;
    },
    execute: async () => {
      const error = new Error('Profile is referenced.');
      error.code = 'DELETION_BLOCKED';
      error.plan = { status: 'blocked', references: [{ type: 'job', id: JOB_ID }] };
      throw error;
    },
    getRetention: () => ({ enabled: false, days: 30, pinnedJobIds: [] }),
  };
  const baseUrl = await listen(t, createServer({ dataLifecycle }));

  const missing = await requestJson(baseUrl, '/api/data/deletions/preview', {
    method: 'POST',
    body: { entityType: 'job', jobId: JOB_ID },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'JOB_NOT_FOUND');

  const blocked = await requestJson(baseUrl, '/api/data/deletions/execute', {
    method: 'POST',
    body: { entityType: 'profile', profileId: 'aabbccddeeff0011', confirmationToken: 'token' },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'DELETION_BLOCKED');
  assert.equal(blocked.body.plan.references[0].id, JOB_ID);
});

test('deleting an observed Job closes SSE after a compatible closing status event', async (t) => {
  const listeners = new Set();
  const job = { id: JOB_ID, status: 'running', keyword: 'fixture' };
  const manager = {
    active: job,
    list: () => [job],
    get: (id) => id === JOB_ID ? job : null,
    getInternal: (id) => id === JOB_ID ? { ...job, outputDir: 'unused' } : null,
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const baseUrl = await listen(t, createServer({ manager, dataLifecycle: { ownership: () => ({}) } }));

  const output = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSE stream did not close')), 2000);
    http.get(`${baseUrl}/api/jobs/${JOB_ID}/events`, (response) => {
      let text = '';
      let emitted = false;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (!emitted && text.includes('event: snapshot')) {
          emitted = true;
          for (const listener of [...listeners]) listener({ type: 'closing', data: { reason: 'deletion' } });
        }
      });
      response.on('end', () => {
        clearTimeout(timeout);
        resolve(text);
      });
    }).on('error', reject);
  });

  assert.match(output, /event: snapshot/);
  assert.match(output, /event: status/);
  assert.match(output, /"lifecycle":"closing"/);
  assert.equal(listeners.size, 0);
});
