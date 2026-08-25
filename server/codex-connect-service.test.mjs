import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import { createCodexConnectService } from './codex-connect-service.mjs';
import { createCodexDeviceGatewayService } from './codex-device-gateway-service.mjs';

test('creates a signed one-time local connector launch and exposes the paired device health', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-connect-'));
  let now = new Date('2026-08-18T00:00:00.000Z');
  const gateway = createCodexDeviceGatewayService({
    statePath: path.join(root, 'devices.json'),
    now: () => now,
    newId: (() => {
      let value = 0;
      return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
    })(),
    newSecret: () => 'device-token-returned-once',
    newPairingCode: () => 'ABCDEFGH',
  });
  await gateway.initialize();
  const service = createCodexConnectService({
    deviceGatewayService: gateway,
    now: () => now,
    signingSecret: 'fixture-signing-secret',
    allowedOrigins: ['https://app.example.com'],
  });

  try {
    const created = service.createIntent({ ownerId: 'owner@example.com', origin: 'https://app.example.com' });
    const launch = new URL(created.launchUrl);
    assert.equal(launch.protocol, 'codex-local:');
    assert.equal(launch.hostname, 'connect');
    assert.equal(created.intent.state, 'waiting_for_connector');
    assert.equal(launch.searchParams.get('origin'), 'https://app.example.com');

    const claimed = await service.claimIntent(created.intent.id, {
      origin: launch.searchParams.get('origin'),
      code: launch.searchParams.get('code'),
      nonce: launch.searchParams.get('nonce'),
      signature: launch.searchParams.get('sig'),
      deviceName: 'Fixture Windows',
      capabilities: ['thread.read'],
      relayVersion: '1.0.0',
    });
    assert.equal(claimed.device.name, 'Fixture Windows');
    assert.equal(claimed.gateway.websocketUrl, 'wss://app.example.com/v1/device-tunnel');
    assert.equal(claimed.credentials.deviceToken, 'device-token-returned-once');

    const current = service.getIntent(created.intent.id, { ownerId: 'owner@example.com' });
    assert.equal(current.intent.state, 'paired');
    assert.equal(current.device.id, claimed.device.id);
    assert.equal(current.health.state, 'offline');
    assert.throws(
      () => service.rollbackDevice(claimed.device.id, { ownerId: 'owner@example.com' }),
      { code: 'CODEX_DEVICE_OFFLINE' },
    );
    await assert.rejects(
      () => service.claimIntent(created.intent.id, {
        origin: launch.searchParams.get('origin'),
        code: launch.searchParams.get('code'),
        nonce: launch.searchParams.get('nonce'),
        signature: launch.searchParams.get('sig'),
      }),
      { code: 'CODEX_CONNECT_INTENT_CONSUMED' },
    );
    assert.throws(
      () => service.getIntent(created.intent.id, { ownerId: 'other@example.com' }),
      { code: 'CODEX_CONNECT_INTENT_NOT_FOUND' },
    );

    const replacement = service.createIntent({
      ownerId: 'owner@example.com',
      origin: 'https://app.example.com',
      replaceDeviceId: claimed.device.id,
    });
    const replacementLaunch = new URL(replacement.launchUrl);
    const replaced = await service.claimIntent(replacement.intent.id, {
      origin: replacementLaunch.searchParams.get('origin'),
      code: replacementLaunch.searchParams.get('code'),
      nonce: replacementLaunch.searchParams.get('nonce'),
      signature: replacementLaunch.searchParams.get('sig'),
      deviceName: 'Fixture Windows reconnected',
      capabilities: ['thread.read'],
    });
    assert.equal(replaced.replacedDeviceId, claimed.device.id);
    assert.notEqual(replaced.device.id, claimed.device.id);
    assert.throws(
      () => gateway.getDevice(claimed.device.id, { ownerId: 'owner@example.com' }),
      { code: 'CODEX_DEVICE_NOT_FOUND' },
    );
  } finally {
    now = new Date('2026-08-18T00:10:00.000Z');
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a launch signature that was not produced by the control plane', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-connect-'));
  const gateway = createCodexDeviceGatewayService({
    statePath: path.join(root, 'devices.json'),
    newPairingCode: () => 'ABCDEFGH',
  });
  await gateway.initialize();
  const service = createCodexConnectService({
    deviceGatewayService: gateway,
    signingSecret: 'fixture-signing-secret',
    allowedOrigins: ['https://app.example.com'],
  });

  try {
    const created = service.createIntent({ ownerId: 'owner@example.com', origin: 'https://app.example.com' });
    const launch = new URL(created.launchUrl);
    await assert.rejects(
      () => service.claimIntent(created.intent.id, {
        origin: launch.searchParams.get('origin'),
        code: launch.searchParams.get('code'),
        nonce: launch.searchParams.get('nonce'),
        signature: 'wrong-signature',
      }),
      { code: 'CODEX_CONNECT_SIGNATURE_INVALID' },
    );
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});
