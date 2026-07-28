import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');

test('root launchers delegate to the portable one-click scripts', async () => {
  const windows = await readFile(path.join(repositoryRoot, 'start-windows.cmd'), 'utf8');
  const unix = await readFile(path.join(repositoryRoot, 'start-linux-macos.sh'), 'utf8');
  assert.match(windows, /scripts\\one-click\.ps1/);
  assert.match(windows, /%\*/);
  assert.match(unix, /scripts\/one-click\.sh/);
  assert.match(unix, /"\$@"/);
});

test('one-click check mode verifies the current platform prerequisites without starting a server', () => {
  const port = '65431';
  const result = process.platform === 'win32'
    ? spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/one-click.ps1', '-CheckOnly', '-NoBrowser', '-Port', port],
        { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true },
      )
    : spawnSync(
        'sh',
        ['scripts/one-click.sh', '--check-only', '--no-browser', '--port', port],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.nodeMajor >= 22, true);
  assert.equal(Number.parseFloat(payload.pythonVersion) >= 3.11, true);
  assert.equal(payload.url, `http://127.0.0.1:${port}`);
});
