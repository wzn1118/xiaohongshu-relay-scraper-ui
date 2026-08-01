import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiagnostics, normalizeDiagnosticRoute } from './lib/diagnostics.mjs';

test('diagnostics retain only allowlisted operational fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-diagnostics-'));
  const filePath = path.join(root, 'diagnostics.jsonl');
  const diagnostics = createDiagnostics({
    filePath,
    clock: () => new Date('2026-08-01T00:00:00.000Z'),
  });

  diagnostics.record('request_failed', {
    level: 'error',
    requestId: 'request-1',
    errorCode: 'SMTP_AUTH_FAILED',
    durationMs: 12.8,
    password: 'must-not-appear',
    email: 'person@example.test',
    message: 'private prompt',
  });
  diagnostics.recordJobEvent('job-1', 'state', {
    status: 'running',
    progress: { phase: 'audience', retryAttempt: 2, counts: { notes: 7, unsafe_key: 'secret' } },
    searchTerm: 'private query',
  });
  await diagnostics.flush();

  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /must-not-appear|person@example|private prompt|private query/);
  assert.match(persisted, /SMTP_AUTH_FAILED/);
  assert.match(persisted, /\"stageId\":\"audience\"/);
  assert.deepEqual(diagnostics.bundle().events[1].counts, { notes: 7 });
});

test('diagnostics normalize request ids and dynamic routes', () => {
  const diagnostics = createDiagnostics();
  assert.equal(diagnostics.requestId('client_request-1'), 'client_request-1');
  assert.match(diagnostics.requestId('bad request id'), /^[0-9a-f-]{36}$/);
  assert.equal(
    normalizeDiagnosticRoute('/api/jobs/1785440142000/applications/user-123/draft'),
    '/api/jobs/:jobId/applications/:applicationId/draft',
  );
});

test('job log events are excluded from structured diagnostics', () => {
  const diagnostics = createDiagnostics();
  assert.equal(diagnostics.recordJobEvent('job-1', 'log', { message: 'raw collector output' }), null);
  assert.equal(diagnostics.bundle().events.length, 0);
});
