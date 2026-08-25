import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexNativeInputService } from './codex-native-input-service.mjs';

test('normalizes selected-window targets and writes ordered input events to the Windows bridge', async () => {
  const writes = [];
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  child.killed = false;
  child.stdin = {
    write(value) {
      writes.push(value);
      const request = JSON.parse(value);
      queueMicrotask(() => stdout.emit('data', `${JSON.stringify({ requestId: request.requestId, ok: true, delivered: true, targetFound: true })}\n`));
      return true;
    },
    end() {},
  };
  child.kill = () => { child.killed = true; };
  const service = createCodexNativeInputService({
    platform: 'win32',
    spawnProcess: () => {
      queueMicrotask(() => stdout.emit('data', '{"type":"bridge.ready"}\n'));
      return child;
    },
    now: () => 1_000,
  });
  assert.equal(service.status().inputEnabled, true);
  const target = service.setTarget('mirror-12345678', { label: 'Codex', width: 1280, height: 720, delivery: 'window-message' });
  assert.equal(target.target.label, 'Codex');
  assert.equal(target.target.delivery, 'window-message');
  await service.send('mirror-12345678', { type: 'mouse', action: 'click', x: 0.5, y: 0.25, button: 0 });
  await service.send('mirror-12345678', { type: 'mouse', action: 'move', x: 0.6, y: 0.35, button: -1 });
  await service.send('mirror-12345678', { type: 'key', phase: 'down', code: 'KeyA', key: 'a' });
  assert.equal(writes.length, 3);
  assert.match(writes[0], /"type":"mouse"/);
  assert.match(writes[0], /"delivery":"window-message"/);
  assert.match(writes[1], /"action":"move"/);
  assert.match(writes[1], /"button":0/);
  assert.match(writes[2], /"vk":65/);
  assert.match(writes[0], /"requestId":"input-1"/);
});

test('rejects an input event when the Windows bridge cannot find the selected window', async () => {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  child.killed = false;
  child.stdin = {
    write(value) {
      const request = JSON.parse(value);
      queueMicrotask(() => stdout.emit('data', `${JSON.stringify({ requestId: request.requestId, ok: false, delivered: false, targetFound: false, message: 'window missing' })}\n`));
      return true;
    },
    end() {},
  };
  child.kill = () => { child.killed = true; };
  const service = createCodexNativeInputService({
    platform: 'win32',
    spawnProcess: () => {
      queueMicrotask(() => stdout.emit('data', '{"type":"bridge.ready"}\n'));
      return child;
    },
  });
  service.setTarget('mirror-12345678', { label: 'Codex', width: 1280, height: 720 });
  await assert.rejects(
    () => service.send('mirror-12345678', { type: 'mouse', action: 'click', x: 0.5, y: 0.5, button: 0 }),
    { code: 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND' },
  );
});

test('captures a synchronous bridge acknowledgement without timing out', async () => {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  child.killed = false;
  child.stdin = {
    write(value) {
      const request = JSON.parse(value);
      stdout.emit('data', `${JSON.stringify({ requestId: request.requestId, ok: true, delivered: true, targetFound: true })}\n`);
      return true;
    },
    end() {},
  };
  child.kill = () => { child.killed = true; };
  const service = createCodexNativeInputService({
    platform: 'win32',
    spawnProcess: () => {
      queueMicrotask(() => stdout.emit('data', '{"type":"bridge.ready"}\n'));
      return child;
    },
    now: () => 1_000,
  });
  service.setTarget('mirror-12345678', { label: 'Codex', width: 1280, height: 720 });
  const result = await service.send('mirror-12345678', { type: 'mouse', action: 'click', x: 0.5, y: 0.5, button: 0 });
  assert.equal(result.delivered, true);
  assert.equal(service.status().metrics.acknowledged, 1);
  assert.equal(service.status().metrics.failed, 0);
});

test('does not wait for a bridge acknowledgement on high-frequency pointer movement', async () => {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  child.killed = false;
  child.stdin = { write: () => true, end() {} };
  child.kill = () => { child.killed = true; };
  const service = createCodexNativeInputService({
    platform: 'win32',
    spawnProcess: () => {
      queueMicrotask(() => stdout.emit('data', '{"type":"bridge.ready"}\n'));
      return child;
    },
  });
  service.setTarget('mirror-12345678', { label: 'Codex', width: 1280, height: 720 });
  const result = await Promise.race([
    service.send('mirror-12345678', { type: 'mouse', action: 'move', x: 0.5, y: 0.5, button: -1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pointer move waited for bridge acknowledgement')), 100)),
  ]);
  assert.equal(result.delivered, true);
});

test('rejects input without a target and reports unavailable hosts', async () => {
  const service = createCodexNativeInputService({ platform: 'linux' });
  assert.equal(service.status().inputEnabled, false);
  await assert.rejects(() => service.send('mirror-12345678', { type: 'key', phase: 'down', code: 'Enter' }), { code: 'CODEX_MIRROR_INPUT_UNAVAILABLE' });
});

test('rejects a selected window without a stable title', () => {
  const service = createCodexNativeInputService({ platform: 'win32' });
  assert.throws(
    () => service.setTarget('mirror-12345678', { label: '   ', width: 1280, height: 720 }),
    { code: 'CODEX_MIRROR_INPUT_TARGET_INVALID' },
  );
});
