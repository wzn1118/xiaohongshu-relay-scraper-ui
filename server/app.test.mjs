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
    records: [{ note_id: 'n1', title: '内容运营实习', body: '负责内容运营' }],
    codex_runtime: { status: 'completed', generated: 1 },
    quality_gate: { passed: true },
  }), 'utf8');
  const job = {
    id: '20260728080000-abcdef12',
    keyword: '实习继任',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  const internal = { ...job, outputDir, logPath: path.join(fixture, 'run.log') };
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
  const server = http.createServer(createApp({ manager, config }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, 'xiaohongshu-relay-scraper');

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
