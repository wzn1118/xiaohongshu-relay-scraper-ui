import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildTurnArtifacts } from '../scripts/generate-codex-turn-config.mjs';
import { parseTurnEnvironment, verifyTurnConfig, verifyTurnEnvironment } from '../scripts/verify-codex-turn-config.mjs';

test('verifies generated TURN environment and does not expose its shared secret', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const artifacts = buildTurnArtifacts({
    realm: 'turn.example.test',
    publicIp: '203.0.113.10',
    secret,
  });
  const environment = parseTurnEnvironment(artifacts.productEnvironment);
  const report = verifyTurnEnvironment(environment, { now: () => new Date('2026-08-18T08:00:00.000Z') });
  assert.equal(report.turnConfigured, true);
  assert.equal(report.crossNetworkReady, true);
  assert.equal(report.turnUrlCount, 2);
  assert.equal(report.credentialExpiresAt, '2026-08-18T08:10:00.000Z');
  assert.equal(report.sharedSecretExposed, false);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('rejects partial, weak, malformed, and duplicate TURN environment entries', () => {
  assert.throws(() => verifyTurnEnvironment({
    XHS_CODEX_TURN_URLS_JSON: '["turn:turn.example.test:3478"]',
  }), /32 to 256/);
  assert.throws(() => verifyTurnEnvironment({
    XHS_CODEX_TURN_URLS_JSON: 'not-json',
    XHS_CODEX_TURN_SHARED_SECRET: '0123456789abcdef0123456789abcdef',
  }), /valid JSON array/);
  assert.throws(() => verifyTurnEnvironment({
    XHS_CODEX_TURN_URLS_JSON: '["stun:stun.example.test:3478"]',
    XHS_CODEX_TURN_SHARED_SECRET: '0123456789abcdef0123456789abcdef',
  }), /ICE URLs are invalid/);
  assert.throws(() => parseTurnEnvironment([
    'XHS_CODEX_TURN_SHARED_SECRET=0123456789abcdef0123456789abcdef',
    'XHS_CODEX_TURN_SHARED_SECRET=abcdef0123456789abcdef0123456789',
  ].join('\n')), /Duplicate TURN environment key/);
});

test('connects config verification to the browser relay probe without returning credentials', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'codex-turn-probe-config-'));
  const envFile = join(outputDir, 'product-turn.env');
  const secret = '0123456789abcdef0123456789abcdef';
  const artifacts = buildTurnArtifacts({
    realm: 'turn.example.test',
    publicIp: '203.0.113.10',
    secret,
  });
  let browserClosed = false;
  try {
    await writeFile(envFile, artifacts.productEnvironment, 'utf8');
    const report = await verifyTurnConfig({
      envFile,
      probeRelay: true,
      probeTimeoutMs: 4_000,
      chromiumLauncher: {
        async launch() {
          return {
            async newPage() {
              return {
                async evaluate() {
                  return {
                    relayCandidateFound: true,
                    completionReason: 'relay',
                    candidateCount: 1,
                    candidateTypes: ['relay'],
                    protocols: ['tcp'],
                    tcpTypes: ['passive'],
                    errorCodes: [],
                    gatheringCompleted: false,
                    elapsedMs: 45,
                  };
                },
              };
            },
            async close() {
              browserClosed = true;
            },
          };
        },
      },
    });
    assert.equal(report.relayProbe.relayCandidateFound, true);
    assert.equal(report.relayProbe.protocols[0], 'tcp');
    assert.equal(report.sharedSecretExposed, false);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(browserClosed, true);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
