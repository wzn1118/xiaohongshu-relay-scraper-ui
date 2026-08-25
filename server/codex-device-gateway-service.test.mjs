import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { CodexDeviceGatewayError, createCodexDeviceGatewayService } from './codex-device-gateway-service.mjs';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-device-gateway-'));
  let nowMs = Date.parse('2026-08-18T08:00:00.000Z');
  let id = 0;
  let secret = 0;
  const service = createCodexDeviceGatewayService({
    statePath: path.join(root, 'gateway.json'),
    auditPath: path.join(root, 'audit.jsonl'),
    now: () => new Date(nowMs),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    newSecret: () => `device-secret-${++secret}-0123456789abcdef`,
    newPairingCode: () => 'ABCDEFGH',
  });
  await service.initialize();
  return {
    root,
    service,
    advance(milliseconds) { nowMs += milliseconds; },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function pairDevice(fixture) {
  const created = fixture.service.createPairingIntent({
    ownerId: 'owner@example.com',
    orgId: 'org-main',
    requestedRole: 'controller',
  });
  const claimed = await fixture.service.claimPairing({
    pairingIntentId: created.pairingIntent.id,
    code: created.pairingIntent.code,
    deviceName: 'Office PC',
    capabilities: ['thread.read', 'turn.start', 'desktop.stream', 'desktop.input'],
    relayVersion: '1.0.0',
    codexBuild: '6415',
  });
  return { created, claimed };
}

test('pairs once, persists only the token hash, reports presence, and revokes the device', async () => {
  const fixture = await createFixture();
  try {
    const { created, claimed } = await pairDevice(fixture);
    assert.equal(claimed.credentials.returnedOnce, true);
    assert.equal(fixture.service.listDevices({ ownerId: 'owner@example.com' }).length, 1);
    await assert.rejects(() => fixture.service.claimPairing({
      pairingIntentId: created.pairingIntent.id,
      code: created.pairingIntent.code,
      deviceName: 'Second claim',
    }), (error) => error instanceof CodexDeviceGatewayError && error.code === 'CODEX_PAIRING_EXPIRED');

    const presence = await fixture.service.heartbeat(
      claimed.device.id,
      claimed.credentials.deviceToken,
      { codex: { running: true, windowId: '0x00123A' } },
    );
    assert.equal(presence.codex.running, true);
    const persisted = await readFile(path.join(fixture.root, 'gateway.json'), 'utf8');
    assert.equal(persisted.includes(claimed.credentials.deviceToken), false);
    assert.match(persisted, /"tokenHash": "[a-f0-9]{64}"/);

    const revoked = await fixture.service.revokeDevice(claimed.device.id, { ownerId: 'owner@example.com' });
    assert.equal(revoked.revoked, true);
    assert.equal(fixture.service.listDevices({ ownerId: 'owner@example.com' }).length, 0);
    assert.throws(() => fixture.service.authenticateDevice(claimed.device.id, claimed.credentials.deviceToken), (error) => (
      error instanceof CodexDeviceGatewayError && error.code === 'CODEX_DEVICE_UNAUTHORIZED'
    ));
  } finally {
    await fixture.close();
  }
});

test('accepts an authenticated outbound WebSocket, routes a session envelope, and resumes device events by cursor', async () => {
  const fixture = await createFixture();
  const server = http.createServer((_request, response) => response.end('ok'));
  try {
    const { claimed } = await pairDevice(fixture);
    fixture.service.attachServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/device-tunnel?deviceId=${encodeURIComponent(claimed.device.id)}`, {
      headers: { Authorization: `Bearer ${claimed.credentials.deviceToken}` },
    });
    const received = [];
    webSocket.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      webSocket.once('open', resolve);
      webSocket.once('error', reject);
    });
    await waitFor(() => received.some((message) => message.type === 'device.accept'));
    webSocket.send(JSON.stringify({
      type: 'device.hello',
      relayVersion: '1.0.1',
      codexBuild: '6415',
      capabilities: ['thread.read', 'turn.start', 'desktop.stream', 'desktop.input'],
      codex: { running: true, windowId: '0xA1' },
    }));
    await waitFor(() => received.some((message) => message.type === 'device.presence.ack'));
    assert.equal(fixture.service.listDevices({ ownerId: 'owner@example.com' })[0].online, true);

    const maintenance = fixture.service.sendConnectorCommand(claimed.device.id, {
      ownerId: 'owner@example.com',
      operation: 'rollback',
    });
    assert.equal(maintenance.delivered, true);
    await waitFor(() => received.some((message) => message.type === 'connector.command' && message.operation === 'rollback'));
    webSocket.send(JSON.stringify({
      type: 'connector.result',
      operation: 'rollback',
      result: {
        ok: true,
        state: 'rolled_back',
        message: 'Connector rollback completed.',
        runtimeReady: true,
        fromVersion: '1.1.0',
        toVersion: '1.0.0',
      },
    }));
    await waitFor(() => fixture.service.getDevice(claimed.device.id, { ownerId: 'owner@example.com' }).connector.lastResult?.state === 'rolled_back');
    const maintainedDevice = fixture.service.getDevice(claimed.device.id, { ownerId: 'owner@example.com' });
    assert.equal(maintainedDevice.connector.lastResult.operation, 'rollback');
    assert.equal(maintainedDevice.connector.lastResult.toVersion, '1.0.0');

    const delivered = fixture.service.offerSession(claimed.device.id, {
      id: 'relay-session-0001',
      mode: 'semantic',
      requestedCapabilities: ['thread.read'],
      ticketExpiresAt: '2026-08-18T08:01:00.000Z',
      adapterVersion: 'codex-relay.v1',
    }, { ownerId: 'owner@example.com' });
    assert.equal(delivered.delivered, true);
    await waitFor(() => received.some((message) => message.type === 'session.offer'));

    const mirrorSessionId = 'mirror-12345678';
    const mirrorUrl = `https://relay.example.test/codex-native-mirror.html#sessionId=${mirrorSessionId}&role=source&token=0123456789abcdef&remote=1`;
    const openPromise = fixture.service.openMirrorSource(claimed.device.id, mirrorSessionId, mirrorUrl, { ownerId: 'owner@example.com' });
    await waitFor(() => received.some((message) => message.type === 'mirror.open'));
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: mirrorSessionId,
      operation: 'open',
      ok: true,
      message: 'Mirror source opened.',
    }));
    assert.equal((await openPromise).delivered, true);
    const targetPromise = fixture.service.setMirrorInputTarget(claimed.device.id, mirrorSessionId, { label: 'Codex', width: 1280, height: 720 }, { ownerId: 'owner@example.com' });
    await waitFor(() => received.some((message) => message.type === 'mirror.input-target'));
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: mirrorSessionId,
      operation: 'input-target',
      ok: true,
      message: 'Codex target registered.',
    }));
    assert.equal((await targetPromise).delivered, true);

    const inputPromise = fixture.service.sendMirrorInput(claimed.device.id, mirrorSessionId, { type: 'mouse', action: 'click', x: 0.5, y: 0.5, button: 0 }, { ownerId: 'owner@example.com' });
    await waitFor(() => received.some((message) => message.type === 'mirror.input'));
    const initialInput = received.find((message) => message.type === 'mirror.input');
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: mirrorSessionId,
      operation: 'input',
      requestId: initialInput.requestId,
      ok: true,
      message: 'Click delivered.',
    }));
    assert.equal((await inputPromise).delivered, true);

    const firstConcurrentInput = fixture.service.sendMirrorInput(
      claimed.device.id,
      mirrorSessionId,
      { type: 'key', action: 'down', code: 'KeyA', key: 'a' },
      { ownerId: 'owner@example.com' },
    );
    const secondConcurrentInput = fixture.service.sendMirrorInput(
      claimed.device.id,
      mirrorSessionId,
      { type: 'key', action: 'down', code: 'KeyB', key: 'b' },
      { ownerId: 'owner@example.com' },
    );
    await waitFor(() => received.filter((message) => message.type === 'mirror.input').length === 3);
    const concurrentInputs = received.filter((message) => message.type === 'mirror.input').slice(-2);
    assert.notEqual(concurrentInputs[0].requestId, concurrentInputs[1].requestId);
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: mirrorSessionId,
      operation: 'input',
      requestId: concurrentInputs[1].requestId,
      ok: true,
      message: 'Second input delivered first.',
    }));
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: mirrorSessionId,
      operation: 'input',
      requestId: concurrentInputs[0].requestId,
      ok: true,
      message: 'First input delivered second.',
    }));
    const [firstResult, secondResult] = await Promise.all([firstConcurrentInput, secondConcurrentInput]);
    assert.equal(firstResult.requestId, concurrentInputs[0].requestId);
    assert.equal(secondResult.requestId, concurrentInputs[1].requestId);

    fixture.service.closeRemoteMirror(claimed.device.id, mirrorSessionId, { ownerId: 'owner@example.com' });
    await waitFor(() => received.some((message) => message.type === 'mirror.close'));
    assert.deepEqual(
      received.filter((message) => message.type.startsWith('mirror.')).map((message) => message.type),
      ['mirror.open', 'mirror.input-target', 'mirror.input', 'mirror.input', 'mirror.input', 'mirror.close'],
    );
    await waitFor(() => fixture.service.getMirrorState(claimed.device.id, mirrorSessionId, { ownerId: 'owner@example.com' })?.state === 'ready');

    webSocket.send(JSON.stringify({
      type: 'session.event',
      sessionId: 'relay-session-0001',
      sequence: 7,
      event: { type: 'turn.completed', turnId: 'turn-1', snapshot: 'x'.repeat(96 * 1024) },
    }));
    await waitFor(() => fixture.service.listSessionEvents('relay-session-0001', { after: 0 }).events.length === 1);
    const events = fixture.service.listSessionEvents('relay-session-0001', { after: 6 });
    assert.equal(events.cursor, 7);
    assert.equal(events.events[0].event.type, 'turn.completed');
    assert.equal(events.events[0].event.snapshot.length, 96 * 1024);
    webSocket.close();
    await new Promise((resolve) => webSocket.once('close', resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test('rejects interactive Mirror when a paired connector has not advertised input support', async () => {
  const fixture = await createFixture();
  try {
    const { claimed } = await pairDevice(fixture);
    const device = fixture.service.devices.get(claimed.device.id);
    device.capabilities = ['desktop.stream'];
    await assert.rejects(() => fixture.service.openMirrorSource(
      claimed.device.id,
      'mirror-12345678',
      'https://relay.example.test/codex-native-mirror.html#sessionId=mirror-12345678&role=source&token=0123456789abcdef',
      { ownerId: 'owner@example.com' },
    ), (error) => error instanceof CodexDeviceGatewayError && error.code === 'CODEX_DEVICE_MIRROR_UNSUPPORTED');
  } finally {
    await fixture.close();
  }
});

test('expires unused pairing intents after five minutes', async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.service.createPairingIntent({ ownerId: 'owner@example.com' });
    fixture.advance(5 * 60_000 + 1);
    await assert.rejects(() => fixture.service.claimPairing({
      pairingIntentId: created.pairingIntent.id,
      code: created.pairingIntent.code,
      deviceName: 'Late PC',
    }), (error) => error instanceof CodexDeviceGatewayError && error.code === 'CODEX_PAIRING_EXPIRED');
  } finally {
    await fixture.close();
  }
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for gateway state.');
}
