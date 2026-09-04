import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildTurnArtifacts, generateTurnConfig } from '../scripts/generate-codex-turn-config.mjs';

test('builds matching coturn and product TURN REST configuration', () => {
  const artifacts = buildTurnArtifacts({
    realm: 'turn.example.test',
    publicIp: '203.0.113.10',
    secret: '0123456789abcdef0123456789abcdef',
  });
  assert.match(artifacts.turnserverConfig, /use-auth-secret/);
  assert.match(artifacts.turnserverConfig, /static-auth-secret=0123456789abcdef0123456789abcdef/);
  assert.match(artifacts.turnserverConfig, /min-port=49160/);
  assert.match(artifacts.productEnvironment, /XHS_CODEX_TURN_SHARED_SECRET=0123456789abcdef0123456789abcdef/);
  assert.deepEqual(artifacts.turnUrls, [
    'turn:turn.example.test:3478?transport=udp',
    'turn:turn.example.test:3478?transport=tcp',
  ]);
  assert.doesNotMatch(artifacts.turnserverConfig, /tls-listening-port/);
});

test('adds TURN TLS only when both certificate paths are configured', () => {
  const artifacts = buildTurnArtifacts({
    realm: 'turn.example.test',
    publicIp: '2001:db8::10',
    secret: '0123456789abcdef0123456789abcdef',
    cert: '/etc/letsencrypt/live/turn.example.test/fullchain.pem',
    pkey: '/etc/letsencrypt/live/turn.example.test/privkey.pem',
  });
  assert.equal(artifacts.turnUrls.at(-1), 'turns:turn.example.test:5349?transport=tcp');
  assert.match(artifacts.turnserverConfig, /tls-listening-port=5349/);
  assert.throws(() => buildTurnArtifacts({
    realm: 'turn.example.test',
    publicIp: '203.0.113.10',
    secret: '0123456789abcdef0123456789abcdef',
    cert: '/tmp/cert.pem',
  }), /both --cert and --pkey/);
});

test('writes a complete deployment bundle without returning the secret', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'codex-turn-'));
  try {
    const result = await generateTurnConfig({
      realm: 'turn.example.test',
      publicIp: '203.0.113.10',
      secret: '0123456789abcdef0123456789abcdef',
      outputDir,
    });
    assert.equal(result.secret, '[generated and written to protected files]');
    assert.equal(JSON.stringify(result).includes('0123456789abcdef0123456789abcdef'), false);
    assert.match(await readFile(result.files.turnserverConfig, 'utf8'), /realm=turn\.example\.test/);
    assert.match(await readFile(result.files.productEnvironment, 'utf8'), /XHS_CODEX_TURN_URLS_JSON=/);
    const readme = await readFile(result.files.readme, 'utf8');
    assert.match(readme, /Allow TCP and UDP 3478/);
    assert.match(readme, /verify:codex:turn/);
    assert.match(readme, /verify:codex:turn-relay/);
    assert.match(readme, /-TurnEnvFile/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('rejects invalid network and relay range inputs', () => {
  const base = { realm: 'turn.example.test', publicIp: '203.0.113.10', secret: '0123456789abcdef0123456789abcdef' };
  assert.throws(() => buildTurnArtifacts({ ...base, publicIp: 'not-an-ip' }), /valid --public-ip/);
  assert.throws(() => buildTurnArtifacts({ ...base, relayMinPort: 55000, relayMaxPort: 54000 }), /must not exceed/);
});
