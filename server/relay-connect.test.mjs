import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectRelay } from './lib/relay-connect.mjs';

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

test('starts the relay through the browser service without UI automation', async () => {
  const calls = [];
  const statuses = [relayStatus({ ok: false }), relayStatus({ ok: true, tabs: 2 })];
  const result = await connectRelay({
    port: 18792,
    openClawConfigPath: 'unused',
    timeoutMs: 1000,
    openClawCommand: 'openclaw.cmd',
    probeRelayImpl: async () => statuses.shift(),
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempted, true);
  assert.deepEqual(calls, [{
    command: 'openclaw.cmd',
    args: ['browser', 'start', '--browser-profile', 'chrome', '--json'],
    options: { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  }]);
});

test('does not start another process when the relay is already attached', async () => {
  let starts = 0;
  const result = await connectRelay({
    port: 18792,
    openClawConfigPath: 'unused',
    probeRelayImpl: async () => relayStatus({ ok: true, tabs: 1 }),
    spawnImpl: () => {
      starts += 1;
      throw new Error('unexpected start');
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempted, false);
  assert.equal(starts, 0);
});
