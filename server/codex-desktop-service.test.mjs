import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  CodexDesktopServiceError,
  createCodexDesktopService,
} from './codex-desktop-service.mjs';

const REQUIRED_FILES = [
  'app/ChatGPT.exe',
  'app/chrome.dll',
  'app/resources.pak',
  'app/resources/app.asar',
  'app/resources/app-unpacked/package.json',
  'app/resources/app-unpacked/webview/index.html',
  'app/resources/codex.exe',
  'app/resources/codex-code-mode-host.exe',
  'app/resources/codex-command-runner.exe',
  'app/resources/rg.exe',
  'app/resources/plugins/.keep',
  'app/resources/skills/.keep',
];

test('complete runtime reports frontend, host, and backend readiness and launches the workspace', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'codex-desktop-service-'));
  const workspaceRoot = path.join(fixture, 'workspace');
  const calls = [];
  try {
    await mkdir(workspaceRoot, { recursive: true });
    for (const relative of REQUIRED_FILES) {
      const target = path.join(fixture, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, relative, 'utf8');
    }
    await writeFile(path.join(fixture, 'integration-manifest.json'), JSON.stringify({
      version: '26.803.81509',
      buildNumber: '6415',
      sourceAsarSha256: '55d9fb967596',
      provisionedAt: '2026-08-17T15:00:00.000Z',
      runtime: { fileCount: 10441, totalBytes: 1930000000 },
    }), 'utf8');

    const spawnProcess = (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      child.pid = 3210;
      child.unref = () => { child.unrefCalled = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const service = createCodexDesktopService({
      runtimeRoot: fixture,
      workspaceRoot,
      spawnProcess,
      platform: 'win32',
      now: () => new Date('2026-08-17T15:05:00.000Z'),
    });

    const status = await service.status();
    assert.equal(status.ready, true);
    assert.equal(status.components.frontend.ready, true);
    assert.equal(status.components.backend.ready, true);
    assert.equal(status.fileCount, 10441);

    const launched = await service.launch();
    assert.equal(launched.launched, true);
    assert.equal(launched.mode, 'native');
    assert.equal(launched.pid, 3210);
    assert.deepEqual(calls[0].args, [`--open-project=${path.resolve(workspaceRoot)}`]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.windowsHide, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('incomplete runtime refuses to launch and identifies all three component groups', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'codex-desktop-service-empty-'));
  try {
    const service = createCodexDesktopService({
      runtimeRoot: fixture,
      workspaceRoot: fixture,
      platform: 'win32',
    });
    const status = await service.status();
    assert.equal(status.ready, false);
    assert.equal(status.components.frontend.ready, false);
    assert.equal(status.components.host.ready, false);
    assert.equal(status.components.backend.ready, false);
    await assert.rejects(
      service.launch(),
      (error) => error instanceof CodexDesktopServiceError
        && error.code === 'CODEX_DESKTOP_RUNTIME_INCOMPLETE'
        && error.status === 503,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
