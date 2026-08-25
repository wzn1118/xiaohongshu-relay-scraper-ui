import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCodexNativeMirrorSourceService } from './codex-native-mirror-source-service.mjs';

test('launches an isolated Chromium app with automatic Codex window capture', async () => {
  const spawns = [];
  const terminated = [];
  const removed = [];
  const browserPath = resolve('.test-fixtures', 'browser', 'msedge.exe');
  const service = createCodexNativeMirrorSourceService({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\LocalAppData' },
    browserPath,
    pathExists: () => true,
    spawnProcess: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = 4321;
      child.unref = () => {};
      spawns.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    terminateProcess: async (launch) => { terminated.push(launch.pid); },
    removeDirectory: async (profilePath) => { removed.push(profilePath); },
    now: () => new Date('2026-08-19T09:00:00.000Z'),
  });

  const launched = await service.launch(
    'mirror-local-source-0001',
    'http://127.0.0.1:4337/codex-native-mirror.html#sessionId=mirror-local-source-0001',
    { captureTitle: 'ChatGPT' },
  );

  assert.equal(launched.pid, 4321);
  assert.equal(service.status().activeSources, 1);
  assert.equal(spawns[0].command, browserPath);
  assert.ok(spawns[0].args.includes('--auto-select-desktop-capture-source=ChatGPT'));
  assert.ok(spawns[0].args.includes('--disable-background-timer-throttling'));
  assert.ok(spawns[0].args.some((value) => value.startsWith('--app=http://127.0.0.1:4337/')));
  assert.equal(spawns[0].options.detached, true);

  await service.close('mirror-local-source-0001');
  assert.deepEqual(terminated, [4321]);
  assert.equal(removed.length, 1);
  assert.equal(service.status().activeSources, 0);
});

test('rejects non-loopback source URLs before launching a browser', async () => {
  const service = createCodexNativeMirrorSourceService({
    platform: 'win32',
    browserPath: resolve('.test-fixtures', 'browser', 'msedge.exe'),
    pathExists: () => true,
    spawnProcess: () => { throw new Error('must not spawn'); },
  });
  await assert.rejects(
    () => service.launch('mirror-local-source-0002', 'https://public.example.test/mirror'),
    /loopback/u,
  );
});
