import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { CodexIceServiceError, createCodexIceService } from './codex-ice-service.mjs';

test('issues short-lived TURN REST credentials without exposing the shared secret', () => {
  const now = new Date('2026-08-18T08:00:00.000Z');
  const service = createCodexIceService({
    staticIceServers: [{ urls: 'stun:stun.example.test:3478' }],
    turnUrls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349?transport=tcp'],
    turnSharedSecret: 'turn-shared-secret',
    credentialTtlSeconds: 600,
    now: () => now,
  });
  const issued = service.issue({ subject: 'session-01' });
  assert.equal(issued.iceServers.length, 2);
  assert.equal(issued.turnConfigured, true);
  assert.equal(issued.expiresAt, '2026-08-18T08:10:00.000Z');
  const turn = issued.iceServers[1];
  assert.equal(turn.username, `${Math.floor(now.getTime() / 1_000) + 600}:session-01`);
  assert.equal(turn.credential, createHmac('sha1', 'turn-shared-secret').update(turn.username).digest('base64'));
  assert.equal(JSON.stringify(issued).includes('turn-shared-secret'), false);
  assert.equal(service.status().turnCredentialMode, 'time-limited-hmac');
  assert.equal(service.status().crossNetworkReady, true);
  assert.equal(service.status().connectivityMode, 'direct-with-relay-fallback');
});

test('keeps direct/STUN-only mode when TURN is not configured and rejects incomplete TURN config', () => {
  const direct = createCodexIceService({ staticIceServers: [{ urls: ['stun:one.test:3478', 'stun:two.test:3478'] }] });
  assert.equal(direct.issue({ subject: 'local' }).turnConfigured, false);
  assert.equal(direct.status().configuredServers, 1);
  assert.equal(direct.status().crossNetworkReady, false);
  assert.equal(direct.status().connectivityMode, 'direct-with-stun');
  assert.equal(createCodexIceService().status().connectivityMode, 'direct-only');
  assert.throws(() => createCodexIceService({ turnUrls: ['turn:turn.example.test:3478'] }), (error) => (
    error instanceof CodexIceServiceError && error.code === 'CODEX_TURN_SECRET_REQUIRED'
  ));
});
