import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';

import { createCodexNativeMirrorInputChannel } from './codex-native-mirror-input-channel.mjs';

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for test state.'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function fixture({ holdDiscrete = false, remote = false } = {}) {
  const calls = [];
  let firstMoveResolve;
  const firstMove = new Promise((resolve) => { firstMoveResolve = resolve; });
  const discreteResolvers = [];
  const mirrorService = {
    getSession(sessionId, credentials) {
      assert.equal(sessionId, 'mirror-test-001');
      assert.ok(
        credentials.role === 'source' && credentials.token === 'source-token'
        || credentials.role === 'viewer' && credentials.token === 'viewer-token',
      );
      return { session: { id: sessionId, remote } };
    },
    async sendInput(sessionId, credentials, event) {
      calls.push({ sessionId, credentials, event });
      if (calls.length === 1 && event.action === 'move') await firstMove;
      if (holdDiscrete && event.action !== 'move') {
        await new Promise((resolve) => discreteResolvers.push(resolve));
      }
      return { delivered: true, targetFound: true };
    },
    async sendViewerInput(sessionId, credentials, event) {
      calls.push({ sessionId, credentials, event, directViewer: true });
      return { delivered: true, targetFound: true };
    },
  };
  const server = http.createServer((_request, response) => response.end('ok'));
  const channel = createCodexNativeMirrorInputChannel({ mirrorService });
  channel.attachServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    firstMoveResolve,
    releaseDiscrete() {
      for (const resolve of discreteResolvers.splice(0)) resolve();
    },
    channel,
    server,
    async close() {
      await channel.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('keeps discrete input acknowledged over the persistent source channel', async () => {
  const fixtureState = await fixture();
  try {
    const port = fixtureState.server.address().port;
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/native-mirror/input?sessionId=mirror-test-001&role=source&token=source-token`);
    const received = [];
    webSocket.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { webSocket.once('open', resolve); webSocket.once('error', reject); });
    await waitFor(() => received.some((packet) => packet.type === 'mirror.input-channel'));
    webSocket.send(JSON.stringify({
      type: 'mirror.input',
      requestId: 'control-1',
      telemetry: { viewerSentAt: 100, sourceReceivedAt: 120 },
      event: { type: 'mouse', action: 'click', x: 0.4, y: 0.6, button: 0 },
    }));
    await waitFor(() => received.some((packet) => packet.type === 'mirror.input-result'));
    const result = received.find((packet) => packet.type === 'mirror.input-result');
    assert.equal(result.requestId, 'control-1');
    assert.equal(result.telemetry.viewerSentAt, 100);
    assert.equal(result.telemetry.sourceReceivedAt, 120);
    assert.ok(result.telemetry.relayAcceptedAt > 0);
    assert.ok(result.telemetry.bridgeDeliveredAt >= result.telemetry.relayAcceptedAt);
    assert.equal(fixtureState.calls[0].event.action, 'click');
    webSocket.close();
  } finally {
    await fixtureState.close();
  }
});

test('delivers authenticated local viewer input without a source browser round trip', async () => {
  const fixtureState = await fixture();
  try {
    const port = fixtureState.server.address().port;
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/native-mirror/input?sessionId=mirror-test-001&role=viewer&token=viewer-token`);
    const received = [];
    webSocket.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { webSocket.once('open', resolve); webSocket.once('error', reject); });
    await waitFor(() => received.some((packet) => packet.type === 'mirror.input-channel'));
    webSocket.send(JSON.stringify({
      type: 'mirror.input',
      requestId: 'viewer-control-1',
      telemetry: { viewerSentAt: 100 },
      event: { type: 'mouse', action: 'click', x: 0.25, y: 0.75, button: 0 },
    }));
    await waitFor(() => received.some((packet) => packet.type === 'mirror.input-result'));
    assert.equal(fixtureState.calls.length, 1);
    assert.equal(fixtureState.calls[0].directViewer, true);
    assert.deepEqual(fixtureState.calls[0].credentials, {
      sessionId: 'mirror-test-001',
      role: 'viewer',
      token: 'viewer-token',
    });
    assert.equal(received.find((packet) => packet.type === 'mirror.input-result').requestId, 'viewer-control-1');
    webSocket.close();
  } finally {
    await fixtureState.close();
  }
});

test('dispatches discrete input in order without waiting for earlier acknowledgements', async () => {
  const fixtureState = await fixture({ holdDiscrete: true });
  try {
    const port = fixtureState.server.address().port;
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/native-mirror/input?sessionId=mirror-test-001&role=source&token=source-token`);
    const received = [];
    webSocket.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { webSocket.once('open', resolve); webSocket.once('error', reject); });
    webSocket.send(JSON.stringify({
      type: 'mirror.input',
      requestId: 'control-a',
      event: { type: 'key', action: 'down', code: 'KeyA', key: 'a' },
    }));
    webSocket.send(JSON.stringify({
      type: 'mirror.input',
      requestId: 'control-b',
      event: { type: 'key', action: 'down', code: 'KeyB', key: 'b' },
    }));
    await waitFor(() => fixtureState.calls.length === 2);
    assert.deepEqual(fixtureState.calls.map(({ event }) => event.code), ['KeyA', 'KeyB']);
    fixtureState.releaseDiscrete();
    await waitFor(() => received.filter((packet) => packet.type === 'mirror.input-result').length === 2);
    assert.deepEqual(
      received.filter((packet) => packet.type === 'mirror.input-result').map((packet) => packet.requestId).sort(),
      ['control-a', 'control-b'],
    );
    webSocket.close();
  } finally {
    fixtureState.releaseDiscrete();
    await fixtureState.close();
  }
});

test('coalesces high-frequency pointer movement while preserving the newest point', async () => {
  const fixtureState = await fixture();
  try {
    const port = fixtureState.server.address().port;
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/native-mirror/input?sessionId=mirror-test-001&role=source&token=source-token`);
    await new Promise((resolve, reject) => { webSocket.once('open', resolve); webSocket.once('error', reject); });
    webSocket.send(JSON.stringify({ type: 'mirror.pointer', event: { type: 'mouse', action: 'move', x: 0.1, y: 0.1 } }));
    await waitFor(() => fixtureState.calls.length === 1);
    webSocket.send(JSON.stringify({ type: 'mirror.pointer', event: { type: 'mouse', action: 'move', x: 0.9, y: 0.8 } }));
    webSocket.send(JSON.stringify({ type: 'mirror.pointer', event: { type: 'mouse', action: 'move', x: 0.95, y: 0.85 } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixtureState.firstMoveResolve();
    await waitFor(() => fixtureState.calls.length === 2);
    assert.deepEqual(fixtureState.calls.map(({ event }) => [event.x, event.y]), [[0.1, 0.1], [0.95, 0.85]]);
    webSocket.close();
  } finally {
    await fixtureState.close();
  }
});

test('rejects viewer-role input channel upgrades for remote sessions', async () => {
  const fixtureState = await fixture({ remote: true });
  try {
    const port = fixtureState.server.address().port;
    await assert.rejects(new Promise((resolve, reject) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/native-mirror/input?sessionId=mirror-test-001&role=viewer&token=viewer-token`);
      webSocket.once('open', resolve);
      webSocket.once('error', reject);
    }));
  } finally {
    await fixtureState.close();
  }
});
