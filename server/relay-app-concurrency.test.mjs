import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.mjs';

test('concurrent HTTP recovery requests share one backend recovery flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let recoveryCalls = 0;
  const targetSummary = {
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
  const app = createApp({
    manager: { active: null },
    config: { maxBodyBytes: 4096, openClawConfigPath: 'unused' },
    relayConfig: { get: () => ({ port: 18800, profile: 'openclaw', autoConnect: true }) },
    relayConnector: async ({ port, profile }) => ({ ok: true, ready: true, running: true, cdpReady: true, port, profile }),
    relayRecoverer: async ({ port, profile }) => {
      recoveryCalls += 1;
      await gate;
      return {
        ok: true,
        ready: true,
        running: true,
        cdpReady: true,
        repaired: true,
        playwrightVerified: true,
        port,
        profile,
        before: targetSummary,
        after: targetSummary,
        warnings: [],
        message: 'Relay recovered.',
      };
    },
  });
  let requestsEntered = 0;
  let releaseRequestsEntered;
  const requestsEnteredGate = new Promise((resolve) => { releaseRequestsEntered = resolve; });
  const server = http.createServer((req, res) => {
    requestsEntered += 1;
    if (requestsEntered === 2) releaseRequestsEntered();
    return app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const request = () => fetch(`http://127.0.0.1:${port}/api/relay/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => response.json());

  try {
    const first = request();
    const second = request();
    await requestsEnteredGate;
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);

    assert.equal(recoveryCalls, 1);
    assert.deepEqual(results.map((result) => result.joinedRecovery).sort(), [false, true]);
    assert.equal(results.every((result) => result.playwrightVerified), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
