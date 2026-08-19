import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');
const macosArchiveName = 'xiaohongshu-relay-scraper-ui-one-click-macos.zip';
const macosArchivePattern = macosArchiveName.replace(/\./gu, '\\.');

test('macOS GitHub Release package has separate build, verification, and publishing contracts', async () => {
  const packageScript = await readFile(path.join(repositoryRoot, 'scripts', 'package-github-release-macos.sh'), 'utf8');
  const verifierScript = await readFile(path.join(repositoryRoot, 'scripts', 'verify-github-release-macos.sh'), 'utf8');
  const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  const launchGuide = await readFile(path.join(repositoryRoot, 'ONE_CLICK_START.md'), 'utf8');
  const oneClickScript = await readFile(path.join(repositoryRoot, 'scripts', 'one-click.sh'), 'utf8');

  assert.match(packageScript, /git -C "\$repository_root" archive --format=tar/);
  assert.match(packageScript, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(packageScript, /command -v zip/);
  assert.match(packageScript, /shasum -a 256/);
  assert.match(packageScript, /node_modules\|dist\|data\|runtime/);
  assert.match(packageScript, /grep -Ev '\\\.example\$'/);
  assert.match(packageScript, /scripts\/verify-github-release-macos\.sh/);
  assert.match(packageScript, /Start-App\.command/);
  assert.match(packageScript, /chmod 755/);
  assert.doesNotMatch(packageScript, /\(\?:/);

  assert.match(verifierScript, /unzip -q/);
  assert.match(verifierScript, /exec \.\/Start-App\.command --no-browser --port/);
  assert.match(verifierScript, /launcherFirstRun/);
  assert.doesNotMatch(verifierScript, /exec node server\/index\.mjs/);
  assert.match(verifierScript, /api\/health/);
  assert.match(verifierScript, /XHS_MCP_ENABLED=false/);
  assert.match(verifierScript, /chromium\.launch\(\{ headless: true \}\)/);
  assert.match(verifierScript, /root\.waitFor\(\{ state: 'visible'/);
  assert.match(verifierScript, /interactiveCount/);
  assert.match(verifierScript, /pageErrors/);

  assert.match(workflow, /one-click-macos:/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /package-github-release-macos\.sh/);
  assert.match(workflow, /verify-github-release-macos\.sh/);
  assert.match(workflow, /--browser-smoke/);
  assert.match(workflow, /macos-open-smoke\.png/);
  assert.match(workflow, /publish-release:/);
  assert.match(workflow, /needs: \[one-click-windows, one-click-macos\]/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, new RegExp(macosArchivePattern));

  assert.match(readme, new RegExp(macosArchivePattern));
  assert.match(readme, /Start-App\.command/);
  assert.match(launchGuide, new RegExp(macosArchivePattern));
  assert.match(launchGuide, /Start-App\.command/);
  assert.match(oneClickScript, /export "\$env_key=\$env_value"/);
});

test('macOS release shell scripts pass POSIX shell syntax validation', async (context) => {
  const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
  try {
    await access(shell);
  } catch {
    context.skip(`POSIX shell is unavailable: ${shell}`);
    return;
  }
  for (const script of ['package-github-release-macos.sh', 'verify-github-release-macos.sh']) {
    const result = spawnSync(shell, ['-n', path.join(repositoryRoot, 'scripts', script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const finderLauncher = spawnSync(shell, ['-n', path.join(repositoryRoot, 'Start-App.command')], { encoding: 'utf8' });
  assert.equal(finderLauncher.status, 0, finderLauncher.stderr || finderLauncher.stdout);
});

test('POSIX one-click launcher loads unquoted environment values containing spaces', async (context) => {
  const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
  try {
    await access(shell);
  } catch {
    context.skip(`POSIX shell is unavailable: ${shell}`);
    return;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'xhs-macos-env-'));
  try {
    await mkdir(path.join(temporaryRoot, 'scripts'));
    await mkdir(path.join(temporaryRoot, 'node_modules'));
    await mkdir(path.join(temporaryRoot, 'dist'));
    await copyFile(path.join(repositoryRoot, 'scripts', 'one-click.sh'), path.join(temporaryRoot, 'scripts', 'one-click.sh'));
    await writeFile(path.join(temporaryRoot, '.env'), [
      'HOST=127.0.0.1',
      'PORT=65430',
      `PYTHON_BIN=${process.platform === 'win32' ? 'python' : 'python3'}`,
      'SMTP_OAUTH_SCOPE=https://outlook.office.com/SMTP.Send offline_access openid profile email',
      'QUOTED_VALUE="hello from mac"',
    ].join('\n'), 'utf8');

    const args = process.platform === 'win32'
      ? ['-lc', `cd '${temporaryRoot.replaceAll('\\', '/').replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)}' && sh scripts/one-click.sh --check-only --no-browser`]
      : ['scripts/one-click.sh', '--check-only', '--no-browser'];
    const result = spawnSync(shell, args, { cwd: temporaryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.url, 'http://127.0.0.1:65430');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
