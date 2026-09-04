import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';

import { createCodexNativeMirrorRelayChannel } from './codex-native-mirror-relay-channel.mjs';

function onceMessage(webSocket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for relay packet.')), 2_000);
    webSocket.once('message', (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
    webSocket.once('error', reject);
  });
}

async function open(url) {
  const webSocket = new WebSocket(url);
  const ready = onceMessage(webSocket);
  await new Promise((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  await ready;
  return webSocket;
}

async function fixture() {
  const mirrorService = {
    getSession(sessionId, credentials) {
      assert.equal(sessionId, 'mirror-relay-001');
      const expected = credentials.role === 'source' ? 'source-token' : 'viewer-token';
      if (credentials.token !== expected) throw Object.assign(new Error('invalid token'), { status: 401 });
      return { session: { id: sessionId } };
    },
  };
  const server = http.createServer((_request, response) => response.end('ok'));
  const channel = createCodexNativeMirrorRelayChannel({ mirrorService });
  channel.attachServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `ws://127.0.0.1:${server.address().port}/v1/native-mirror/relay?sessionId=mirror-relay-001`;
  return {
    channel,
    server,
    origin,
    async close() {
      await channel.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('pairs authenticated roles and forwards viewer control plus source media', async () => {
  const state = await fixture();
  try {
    const source = await open(`${state.origin}&role=source&token=source-token`);
    const sourcePackets = [];
    source.on('message', (data) => sourcePackets.push(JSON.parse(String(data))));
    const viewer = await open(`${state.origin}&role=viewer&token=viewer-token`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for relay peer.')), 2_000);
      const tick = () => {
        if (sourcePackets.some((packet) => packet.type === 'mirror.relay-peer')) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(tick, 5);
      };
      tick();
    });

    const sourceControl = onceMessage(source);
    viewer.send(JSON.stringify({ type: 'mirror.input', requestId: 'input-1', event: { type: 'key', phase: 'down', code: 'ShiftLeft' } }));
    const controlPacket = JSON.parse(String((await sourceControl).data));
    assert.equal(controlPacket.requestId, 'input-1');

    const sourceMedia = await open(`${state.origin}&channel=media&role=source&token=source-token`);
    const viewerMedia = await open(`${state.origin}&channel=media&role=viewer&token=viewer-token`);
    const mediaPacketPromise = onceMessage(viewerMedia);
    sourceMedia.send(Buffer.from([1, 1, 2, 3]), { binary: true });
    const mediaPacket = await mediaPacketPromise;
    assert.equal(mediaPacket.isBinary, true);
    assert.deepEqual([...mediaPacket.data], [1, 1, 2, 3]);
    source.close();
    viewer.close();
    sourceMedia.close();
    viewerMedia.close();
  } finally {
    await state.close();
  }
});

test('retains relay activation until the source connects', async () => {
  const state = await fixture();
  try {
    const viewer = await open(`${state.origin}&role=viewer&token=viewer-token`);
    viewer.send(JSON.stringify({ type: 'mirror.activate', reason: 'forced-test' }));
    await onceMessage(viewer);
    const sourceSocket = new WebSocket(`${state.origin}&role=source&token=source-token`);
    const sourcePackets = [];
    sourceSocket.on('message', (data) => sourcePackets.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      sourceSocket.once('open', resolve);
      sourceSocket.once('error', reject);
    });
    const source = sourceSocket;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sourcePackets.some((packet) => packet.type === 'mirror.activate'), true);
    source.close();
    viewer.close();
  } finally {
    await state.close();
  }
});

test('rejects invalid credentials and closes reversed binary media direction', async () => {
  const state = await fixture();
  try {
    await new Promise((resolve) => {
      const webSocket = new WebSocket(`${state.origin}&role=viewer&token=wrong-token`);
      webSocket.once('error', resolve);
      webSocket.once('open', () => resolve(new Error('invalid credentials unexpectedly opened')));
    }).then((error) => {
      if (error instanceof Error && error.message.includes('unexpectedly')) throw error;
    });
    const viewer = await open(`${state.origin}&role=viewer&token=viewer-token`);
    const closed = new Promise((resolve) => viewer.once('close', resolve));
    viewer.send(Buffer.from([1, 2, 3]), { binary: true });
    await closed;
  } finally {
    await state.close();
  }
});
