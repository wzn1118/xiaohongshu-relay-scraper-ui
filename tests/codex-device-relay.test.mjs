import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { attachLocalMirrorInputBridge, buildWindowsMirrorBrowserLaunch, handleGatewayMessage, LocalSemanticController, mirrorBrowserProfilePath, validateMirrorSourceUrl } from '../scripts/codex-device-relay.mjs';

const sessionId = 'mirror-12345678';
const trustedUrl = `https://relay.example.test/codex-native-mirror.html#sessionId=${sessionId}&role=source&token=0123456789abcdef&remote=1`;

test('device relay accepts only same-origin source URLs bound to the requested Mirror session', () => {
  assert.equal(validateMirrorSourceUrl(trustedUrl, 'wss://relay.example.test/v1/device-tunnel', sessionId), trustedUrl);
  assert.throws(() => validateMirrorSourceUrl(
    trustedUrl.replace('relay.example.test', 'attacker.example.test'),
    'wss://relay.example.test/v1/device-tunnel',
    sessionId,
  ), /not trusted/);
  assert.throws(() => validateMirrorSourceUrl(
    trustedUrl.replace(sessionId, 'mirror-87654321'),
    'wss://relay.example.test/v1/device-tunnel',
    sessionId,
  ), /not trusted/);
});

test('device relay builds an isolated one-click Windows Mirror capture browser launch', () => {
  const sourceUrl = attachLocalMirrorInputBridge(trustedUrl, {
    origin: 'http://127.0.0.1:4317',
    sessionId: 'mirror-local-1234',
    role: 'source',
    token: 'local-source-token-1234',
  });
  const launch = buildWindowsMirrorBrowserLaunch(sourceUrl, {
    browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    profilePath: 'C:\\Users\\viewer\\AppData\\Local\\XhsCodexConnector\\mirror-browser',
    captureTitle: 'ChatGPT',
  });
  assert.match(launch.command, /msedge\.exe$/i);
  assert.ok(launch.args.includes('--auto-select-desktop-capture-source=ChatGPT'));
  assert.ok(launch.args.some((value) => value.startsWith('--user-data-dir=')));
  assert.ok(launch.args.includes('--allow-running-insecure-content'));
  assert.ok(launch.args.includes('--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:4317'));
  assert.ok(launch.args.includes(`--app=${sourceUrl}`));
});

test('device relay injects only a loopback local input bridge into the isolated source fragment', () => {
  const value = attachLocalMirrorInputBridge(trustedUrl, {
    origin: 'http://127.0.0.1:4317',
    sessionId: 'mirror-local-1234',
    role: 'source',
    token: 'local-source-token-1234',
  });
  const fragment = new URLSearchParams(new URL(value).hash.slice(1));
  assert.equal(fragment.get('sessionId'), sessionId);
  assert.equal(fragment.get('localInputOrigin'), 'http://127.0.0.1:4317');
  assert.equal(fragment.get('localInputSessionId'), 'mirror-local-1234');
  assert.equal(fragment.get('localInputToken'), 'local-source-token-1234');
  assert.throws(() => attachLocalMirrorInputBridge(trustedUrl, {
    origin: 'https://relay.example.test',
    sessionId: 'mirror-local-1234',
    role: 'source',
    token: 'local-source-token-1234',
  }), /loopback/);
});

test('device relay derives a unique browser profile from each Mirror session', () => {
  assert.match(mirrorBrowserProfilePath(trustedUrl), /mirror-mirror-12345678$/u);
});

test('device relay dispatches remote Mirror lifecycle and input messages in order', async () => {
  const calls = [];
  const results = [];
  const controller = {
    openMirror: (...args) => calls.push(['open', ...args]),
    setMirrorInputTarget: (...args) => calls.push(['target', ...args]),
    sendMirrorInput: (...args) => calls.push(['input', ...args]),
    closeMirror: (...args) => calls.push(['close', ...args]),
  };
  const socket = { send: (value) => results.push(JSON.parse(value)) };
  const context = { gatewayUrl: 'wss://relay.example.test/v1/device-tunnel' };
  await handleGatewayMessage(socket, controller, { type: 'mirror.open', sessionId, sourceUrl: trustedUrl }, context);
  await handleGatewayMessage(socket, controller, { type: 'mirror.input-target', sessionId, target: { label: 'Codex' } }, context);
  await handleGatewayMessage(socket, controller, {
    type: 'mirror.input',
    sessionId,
    requestId: 'mirror-input-1',
    event: { type: 'key', code: 'Enter' },
  }, context);
  await handleGatewayMessage(socket, controller, { type: 'mirror.close', sessionId }, context);
  assert.deepEqual(calls.map(([kind]) => kind), ['open', 'target', 'input', 'close']);
  assert.deepEqual(results.map((result) => [result.operation, result.ok]), [
    ['open', true], ['input-target', true], ['input', true], ['close', true],
  ]);
  assert.equal(results[2].requestId, 'mirror-input-1');
});

test('device relay reports a remote Mirror execution failure to the gateway', async () => {
  const results = [];
  await handleGatewayMessage({ send: (value) => results.push(JSON.parse(value)) }, {
    openMirror: async () => { throw new Error('source launch failed'); },
  }, { type: 'mirror.open', sessionId, sourceUrl: trustedUrl }, {
    gatewayUrl: 'wss://relay.example.test/v1/device-tunnel',
  });
  assert.equal(results[0].type, 'mirror.result');
  assert.equal(results[0].ok, false);
  assert.match(results[0].message, /source launch failed/);
});

test('connector uses the persistent local Mirror input channel for movement and acknowledged controls', async () => {
  const sent = [];
  class FakeSocket extends EventEmitter {
    readyState = 1;

    send(value) {
      const packet = JSON.parse(value);
      sent.push(packet);
      if (packet.type === 'mirror.input') {
        queueMicrotask(() => this.emit('message', JSON.stringify({
          type: 'mirror.input-result',
          requestId: packet.requestId,
          ok: true,
          delivered: true,
          targetFound: true,
        })));
      }
    }

    close() { this.readyState = 3; this.emit('close'); }
  }
  const controller = new LocalSemanticController({
    localRelayOrigin: 'http://127.0.0.1:4317',
    webSocketFactory: () => new FakeSocket(),
  });
  controller.mirrors.set(sessionId, {
    remoteSessionId: sessionId,
    localSessionId: 'mirror-local-1234',
    sourceRole: 'source',
    sourceToken: 'source-token',
    inputSocket: null,
    inputSequence: 0,
    inputPending: new Map(),
  });
  controller._connectMirrorInput(controller.mirrors.get(sessionId));
  const move = await controller.sendMirrorInput(sessionId, { type: 'mouse', action: 'move', x: 0.2, y: 0.3 });
  const click = await controller.sendMirrorInput(sessionId, { type: 'mouse', action: 'click', x: 0.2, y: 0.3, button: 0 });
  assert.equal(move.transport, 'persistent-websocket');
  assert.equal(click.transport, 'persistent-websocket');
  assert.deepEqual(sent.map((packet) => packet.type), ['mirror.pointer', 'mirror.input']);
  assert.equal(sent[1].requestId, 'connector-input-1');
});

test('connector closes the session-owned source browser with the remote Mirror', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ closed: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  let browserCloseCalls = 0;
  const controller = new LocalSemanticController({ localRelayOrigin: 'http://127.0.0.1:4317' });
  controller.mirrors.set(sessionId, {
    remoteSessionId: sessionId,
    localSessionId: 'mirror-local-1234',
    sourceRole: 'source',
    sourceToken: 'source-token',
    inputSocket: null,
    inputSequence: 0,
    inputPending: new Map(),
    externalLaunch: { close: async () => { browserCloseCalls += 1; } },
  });

  await controller.closeMirror(sessionId);

  assert.equal(browserCloseCalls, 1);
  assert.equal(controller.mirrors.has(sessionId), false);
});

test('device relay switches to the newly activated runtime after a successful connector update', async () => {
  const sent = [];
  const restarts = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const controller = {
    origin: 'http://127.0.0.1:4317',
    maintain: async () => ({ ok: true, state: 'updated', fromVersion: '1.2.2', toVersion: '1.2.3' }),
  };
  await handleGatewayMessage(socket, controller, { type: 'connector.command', operation: 'repair' }, {
    restartConnector: (...args) => restarts.push(args),
  });
  assert.equal(sent[0].type, 'connector.result');
  assert.equal(sent[0].result.toVersion, '1.2.3');
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0][1], controller.origin);
});
