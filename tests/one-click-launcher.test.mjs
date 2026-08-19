import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');

test('root launchers delegate to the portable one-click scripts', async () => {
  const windows = await readFile(path.join(repositoryRoot, 'start-windows.cmd'), 'utf8');
  const mcpLauncher = await readFile(path.join(repositoryRoot, 'start-mcp.cmd'), 'utf8');
  const mcpStdio = await readFile(path.join(repositoryRoot, 'mcp-stdio.cmd'), 'utf8');
  const mcpVerify = await readFile(path.join(repositoryRoot, 'verify-mcp.cmd'), 'utf8');
  const packageMcpVerify = await readFile(path.join(repositoryRoot, 'scripts', 'verify-public-package-mcp.ps1'), 'utf8');
  const mcpClient = JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'mcp-client.example.json'), 'utf8'));
  const mcpPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'MCP_PACKAGE_INFO.json'), 'utf8'));
  const unix = await readFile(path.join(repositoryRoot, 'start-linux-macos.sh'), 'utf8');
  const macosFinder = await readFile(path.join(repositoryRoot, 'Start-App.command'), 'utf8');
  const oneClick = await readFile(path.join(repositoryRoot, 'scripts', 'one-click.ps1'), 'utf8');
  const competitionLauncher = await readFile(path.join(repositoryRoot, 'scripts', 'start-competition-windows.ps1'), 'utf8');
  const bootstrap = await readFile(path.join(repositoryRoot, 'scripts', 'bootstrap.ps1'), 'utf8');
  const codexConfig = await readFile(path.join(repositoryRoot, 'scripts', 'ensure-codex-config.ps1'), 'utf8');
  const bundledRuntime = await readFile(path.join(repositoryRoot, 'vendor', 'xiaohongshu-relay-scrape', 'scripts', 'run_xiaohongshu_relay_scrape.py'), 'utf8');
  const prerequisites = await readFile(path.join(repositoryRoot, 'scripts', 'ensure-windows-prerequisites.ps1'), 'utf8');
  const releasePackager = await readFile(path.join(repositoryRoot, 'scripts', 'package-windows-production.ps1'), 'utf8');
  const githubReleasePackager = await readFile(path.join(repositoryRoot, 'scripts', 'package-github-release.ps1'), 'utf8');
  const githubReleaseVerifier = await readFile(path.join(repositoryRoot, 'scripts', 'verify-github-release.ps1'), 'utf8');
  const githubReleaseWorkflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const oneClickGuide = await readFile(path.join(repositoryRoot, 'ONE_CLICK_START.md'), 'utf8');
  const nativeBrowser = await readFile(path.join(repositoryRoot, 'scripts', 'start-managed-browser.mjs'), 'utf8');
  assert.match(windows, /scripts\\one-click\.ps1/);
  assert.match(windows, /%\*/);
  assert.match(mcpLauncher, /scripts\\one-click\.ps1/);
  assert.match(mcpLauncher, /-EnableMcp/);
  assert.match(mcpLauncher, /-NoBrowser/);
  assert.match(mcpLauncher, /%\*/);
  assert.match(mcpStdio, /runtime\\node\\node\.exe/);
  assert.match(mcpStdio, /scripts\\mcp-stdio-bridge\.mjs/);
  assert.match(mcpStdio, /XHS_MCP_TOKEN_FILE/);
  assert.match(mcpVerify, /scripts\\verify-mcp-production\.mjs/);
  assert.match(packageMcpVerify, /runtime\\node\\node\.exe/);
  assert.match(packageMcpVerify, /mcpStatusProtocol/);
  assert.match(packageMcpVerify, /mcpUnauthorizedStatus/);
  assert.equal(mcpClient.mcpServers['today-you-applied'].env.XHS_MCP_URL, 'http://127.0.0.1:4328/mcp');
  assert.match(mcpClient.mcpServers['today-you-applied'].env.XHS_MCP_TOKEN_FILE, /\.token$/);
  assert.equal(mcpPackage.bundled, true);
  assert.equal(mcpPackage.credentialsIncluded, false);
  assert.match(unix, /scripts\/one-click\.sh/);
  assert.match(unix, /"\$@"/);
  assert.match(macosFinder, /start-linux-macos\.sh/);
  assert.match(macosFinder, /"\$@"/);
  assert.match(oneClick, /ensure-windows-prerequisites\.ps1/);
  assert.match(bootstrap, /ensure-windows-prerequisites\.ps1/);
  assert.match(prerequisites, /OpenJS\.NodeJS\.LTS/);
  assert.match(prerequisites, /Python\.Python\.3\.13/);
  assert.match(prerequisites, /bundled AI runtime/);
  assert.match(releasePackager, /\$entry\.Open\(\)/);
  assert.match(releasePackager, /WriteAllText\(\$checksumPath/);
  assert.match(githubReleasePackager, /git.*archive/is);
  assert.match(githubReleasePackager, /Get-FileHash -Algorithm SHA256/);
  assert.match(githubReleasePackager, /node_modules\|dist\|data\|runtime/);
  assert.match(githubReleaseVerifier, /Expand-Archive/);
  assert.match(githubReleaseVerifier, /npm.*ci/is);
  assert.match(githubReleaseVerifier, /api\/health/);
  assert.match(githubReleaseWorkflow, /push:\s*[\s\S]*branches: \[main\]/);
  assert.match(githubReleaseWorkflow, /Verify clean archive installation and health/);
  assert.match(githubReleaseWorkflow, /gh release create/);
  assert.match(oneClickGuide, /start-windows\.cmd/);
  assert.match(oneClickGuide, /SHA-256/);
  assert.match(prerequisites, /builtInAiReady/);
  assert.match(prerequisites, /(?:openclaw|start-managed-browser\.mjs)/);
  assert.match(prerequisites, /(?:Google\.Chrome|start-managed-browser\.mjs)/);
  assert.match(prerequisites, /(?:browser start --browser-profile openclaw|start-managed-browser\.mjs)/);
  assert.match(oneClick, /-EnsureBrowserRelay/);
  assert.match(oneClick, /Get-RelayLaunchOptions/);
  assert.match(oneClick, /-RelayPort \$relayLaunch\.Port -RelayProfile \$relayLaunch\.Profile/);
  assert.match(bootstrap, /-EnsureBrowserRelay/);
  assert.match(oneClick, /relayServiceReady/);
  assert.match(oneClick, /api\/relay\/login/);
  assert.match(oneClick, /-WindowStyle Hidden/);
  assert.match(oneClick, /\[switch\]\$EnableMcp/);
  assert.match(oneClick, /Enable-McpRuntime/);
  assert.match(competitionLauncher, /\$oneClickParameters\s*=\s*@\{/);
  assert.match(competitionLauncher, /EnableMcp\s*=\s*\$true/);
  assert.match(competitionLauncher, /@oneClickParameters/);
  assert.doesNotMatch(competitionLauncher, /@arguments/);
  assert.match(oneClick, /RedirectStandardOutput/);
  assert.doesNotMatch(oneClick, /\.WaitForExit\(\)/);
  assert.doesNotMatch(oneClick, /ensure-codex-config\.ps1/);
  assert.doesNotMatch(bootstrap, /ensure-codex-config\.ps1/);
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

test('Windows one-click check mode reports the forced MCP endpoint', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/one-click.ps1', '-CheckOnly', '-NoBrowser', '-SkipBrowserRelayCheck', '-EnableMcp', '-Port', '65433', '-McpPort', '65434'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, XHS_MCP_ENABLED: 'false' },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mcpEnabled, true);
  assert.equal(payload.mcpHost, '127.0.0.1');
  assert.equal(payload.mcpPort, 65434);
  assert.equal(payload.mcpEndpoint, 'http://127.0.0.1:65434/mcp');
});

test('Windows one-click check mode reports the configured Relay port and profile', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-one-click-relay-'));
  const relayConfigPath = path.join(directory, 'relay-config.json');
  await writeFile(relayConfigPath, JSON.stringify({ port: 18994, profile: 'portable-smoke', autoConnect: true }), 'utf8');
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/one-click.ps1', '-CheckOnly', '-NoBrowser', '-SkipBrowserRelayCheck', '-Port', '65432'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, XHS_RELAY_CONFIG_PATH: relayConfigPath },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.relayPort, 18994);
    assert.equal(payload.relayProfile, 'portable-smoke');
    assert.equal(payload.relayCheckSkipped, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows tracked-process helpers parse PID files without colliding with the built-in PID variable', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-process-tracking-'));
  try {
    const command = [
      ". $env:XHS_COMMON_PATH",
      "Set-Content -LiteralPath (Join-Path $env:XHS_RUNTIME_TEST_PATH 'server.pid') -Value ([string]$PID) -Encoding ASCII",
      '$tracked = Get-HegelSalonTrackedServerProcess -RuntimeRoot $env:XHS_RUNTIME_TEST_PATH',
      "if (-not $tracked -or $tracked.Id -ne $PID) { throw 'Current process was not resolved from server.pid.' }",
      "Set-Content -LiteralPath (Join-Path $env:XHS_RUNTIME_TEST_PATH 'server.pid') -Value 'not-a-pid' -Encoding ASCII",
      '$missing = Get-HegelSalonTrackedServerProcess -RuntimeRoot $env:XHS_RUNTIME_TEST_PATH',
      "if ($null -ne $missing -or (Test-Path -LiteralPath (Join-Path $env:XHS_RUNTIME_TEST_PATH 'server.pid'))) { throw 'Invalid server.pid was not removed.' }",
      "Set-Content -LiteralPath (Join-Path $env:XHS_RUNTIME_TEST_PATH 'tunnel.pid') -Value 'not-a-pid' -Encoding ASCII",
      '$missingTunnel = Get-HegelSalonTrackedTunnelProcess -RuntimeRoot $env:XHS_RUNTIME_TEST_PATH',
      "if ($null -ne $missingTunnel -or (Test-Path -LiteralPath (Join-Path $env:XHS_RUNTIME_TEST_PATH 'tunnel.pid'))) { throw 'Invalid tunnel.pid was not removed.' }",
    ].join('; ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          XHS_COMMON_PATH: path.join(repositoryRoot, 'scripts', 'hegelsalon-common.ps1'),
          XHS_RUNTIME_TEST_PATH: directory,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
