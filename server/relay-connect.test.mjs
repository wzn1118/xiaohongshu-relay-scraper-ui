import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectRelay, openRelayLogin } from './lib/relay-connect.mjs';

function relayStatus({ ok, tabs = 0 }) {
  return {
    ok,
    running: ok,
    cdpReady: ok,
    authenticated: ok,
    port: 18792,
    tabs,
    tabCount: tabs,
  };
}

test('starts the project-managed browser through native CDP without UI automation', async () => {
  const calls = [];
  const statuses = [relayStatus({ ok: false }), relayStatus({ ok: true, tabs: 2 })];
  const result = await connectRelay({
    port: 18792,
    openClawConfigPath: 'unused',
    managedBrowserDataDir: 'data/browser',
    timeoutMs: 1000,
    probeRelayImpl: async () => statuses.shift(),
    browserEnsurer: (options) => {
      calls.push(options);
      return { running: true, cdpReady: true };
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].profileDir, /data[\\/]browser[\\/]openclaw$/);
});

test('does not start another process when the relay is already attached', async () => {
  let starts = 0;
  const result = await connectRelay({
    port: 18792,
    openClawConfigPath: 'unused',
    probeRelayImpl: async () => relayStatus({ ok: true, tabs: 1 }),
    browserEnsurer: () => {
      starts += 1;
      throw new Error('unexpected start');
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempted, false);
  assert.equal(starts, 0);
});

test('force restart rebuilds an attached managed browser', async () => {
  const calls = [];
  const statuses = [relayStatus({ ok: true, tabs: 2 }), relayStatus({ ok: true, tabs: 1 })];
  const result = await connectRelay({
    port: 18792,
    openClawConfigPath: 'unused',
    managedBrowserDataDir: 'data/browser',
    timeoutMs: 1000,
    forceRestart: true,
    probeRelayImpl: async () => statuses.shift(),
    browserEnsurer: async (options) => {
      calls.push(options);
      return { running: true, cdpReady: true, restarted: true };
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].forceRestart, true);
});

test('a force restart waits for a normal connection and then escalates exactly once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const starts = [];
  let probes = 0;
  const options = {
    port: 18793,
    openClawConfigPath: 'unused',
    managedBrowserDataDir: 'data/browser',
    timeoutMs: 1000,
    probeRelayImpl: async () => {
      probes += 1;
      return relayStatus({ ok: probes > 1, tabs: probes > 1 ? 1 : 0 });
    },
    browserEnsurer: async ({ forceRestart }) => {
      starts.push(Boolean(forceRestart));
      if (!forceRestart) await gate;
      return { running: true, cdpReady: true };
    },
  };

  const normal = connectRelay(options);
  const forced = connectRelay({ ...options, forceRestart: true });
  release();
  const [normalResult, forcedResult] = await Promise.all([normal, forced]);

  assert.equal(normalResult.ready, true);
  assert.equal(forcedResult.ready, true);
  assert.deepEqual(starts, [false, true]);
});

test('opens the login page through the managed browser CDP endpoint', async () => {
  const calls = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
    }

    addEventListener(event, handler) {
      this.listeners.set(event, handler);
      if (event === 'open') queueMicrotask(() => handler({}));
    }

    send(value) {
      calls.push(JSON.parse(value));
      queueMicrotask(() => this.listeners.get('message')?.({
        data: JSON.stringify({ id: 1, result: { targetId: 'target-1' } }),
      }));
    }

    close() {}
  }

  const result = await openRelayLogin({
    profile: 'openclaw',
    url: 'https://www.xiaohongshu.com',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/test' }),
    }),
    webSocketImpl: FakeWebSocket,
  });

  assert.equal(result.opened, true);
  assert.deepEqual(calls[0], {
    id: 1,
    method: 'Target.createTarget',
    params: { url: 'https://www.xiaohongshu.com' },
  });
});

test('supports EventEmitter-style WebSocket clients', async () => {
  const result = await openRelayLogin({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/test' }),
    }),
    webSocketImpl: class extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('open'));
      }

      send() {
        queueMicrotask(() => this.emit('message', JSON.stringify({ id: 1, result: { targetId: 'target-2' } })));
      }

      close() {}
    },
  });

  assert.equal(result.opened, true);
});
