import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupRelayRuntime } from './lib/relay-setup.mjs';

test('skips platform installation and lets native CDP handle non-Windows hosts', async () => {
  const result = await setupRelayRuntime({ platform: 'linux' });
  assert.deepEqual(result, {
    ok: true,
    supported: false,
    installed: false,
    skipped: true,
    message: '当前平台直接使用项目原生 CDP 浏览器。',
  });
});

test('passes the configured relay port, profile, and data directory to PowerShell', async () => {
  let command = '';
  let args = [];
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }

    kill() {}
  }
  const child = new FakeChild();
  const resultPromise = setupRelayRuntime({
    platform: 'win32',
    projectRoot: 'C:\\project',
    scriptPath: 'C:\\project\\scripts\\ensure-windows-prerequisites.ps1',
    relayPort: 18901,
    profile: 'work-profile',
    browserDataDir: 'C:\\project\\data\\browser',
    spawnImpl: (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      return child;
    },
    timeoutMs: 1000,
  });
  child.emit('close', 0);
  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(-6), [
    '-RelayPort', '18901',
    '-RelayProfile', 'work-profile',
    '-BrowserDataDir', 'C:\\project\\data\\browser',
  ]);
});
