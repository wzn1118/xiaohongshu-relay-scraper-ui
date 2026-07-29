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
  const oneClick = await readFile(path.join(repositoryRoot, 'scripts', 'one-click.ps1'), 'utf8');
  const bootstrap = await readFile(path.join(repositoryRoot, 'scripts', 'bootstrap.ps1'), 'utf8');
  const codexConfig = await readFile(path.join(repositoryRoot, 'scripts', 'ensure-codex-config.ps1'), 'utf8');
  const bundledRuntime = await readFile(path.join(repositoryRoot, 'vendor', 'xiaohongshu-relay-scrape', 'scripts', 'run_xiaohongshu_relay_scrape.py'), 'utf8');
  const prerequisites = await readFile(path.join(repositoryRoot, 'scripts', 'ensure-windows-prerequisites.ps1'), 'utf8');
  const nativeBrowser = await readFile(path.join(repositoryRoot, 'scripts', 'start-managed-browser.mjs'), 'utf8');
  assert.match(windows, /scripts\\one-click\.ps1/);
  assert.match(windows, /%\*/);
  assert.match(unix, /scripts\/one-click\.sh/);
  assert.match(unix, /"\$@"/);
  assert.match(oneClick, /ensure-windows-prerequisites\.ps1/);
  assert.match(bootstrap, /ensure-windows-prerequisites\.ps1/);
  assert.match(prerequisites, /OpenJS\.NodeJS\.LTS/);
  assert.match(prerequisites, /Python\.Python\.3\.13/);
  assert.match(prerequisites, /@openai\/codex/);
  assert.match(prerequisites, /(?:openclaw|start-managed-browser\.mjs)/);
  assert.match(prerequisites, /(?:Google\.Chrome|start-managed-browser\.mjs)/);
  assert.match(prerequisites, /(?:browser start --browser-profile openclaw|start-managed-browser\.mjs)/);
  assert.match(oneClick, /-EnsureBrowserRelay/);
  assert.match(bootstrap, /-EnsureBrowserRelay/);
  assert.match(oneClick, /relayServiceReady/);
  assert.match(oneClick, /api\/relay\/login/);
  assert.match(oneClick, /ensure-codex-config\.ps1/);
  assert.match(bootstrap, /ensure-codex-config\.ps1/);
  assert.match(codexConfig, /codex-config\.example\.toml/);
  assert.match(bundledRuntime, /DEFAULT_RELAY_PORT = 18800/);
  assert.match(bundledRuntime, /DEFAULT_BROWSER_PROFILE = "openclaw"/);
  assert.match(nativeBrowser, /native-cdp/);
  assert.match(nativeBrowser, /(?:remote-debugging-port|native-cdp)/);
});

test('one-click check mode verifies the current platform prerequisites without starting a server', () => {
  const port = '65431';
  const result = process.platform === 'win32'
    ? spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/one-click.ps1', '-CheckOnly', '-NoBrowser', '-SkipBrowserRelayCheck', '-Port', port],
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
