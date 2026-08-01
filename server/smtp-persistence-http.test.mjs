import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PASSWORD = 'smtp-persistence-integration-secret';

test('SMTP credentials survive a real API process restart without plaintext exposure', { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-http-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const smtpConfigPath = path.join(fixture, 'smtp-config.json');
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    XHS_SERVER_DATA_DIR: path.join(fixture, 'jobs'),
    XHS_PROFILE_DATA_DIR: path.join(fixture, 'profiles'),
    XHS_BROWSER_DATA_DIR: path.join(fixture, 'browser'),
    XHS_RELAY_CONFIG_PATH: path.join(fixture, 'relay-config.json'),
    XHS_AI_CONFIG_PATH: path.join(fixture, 'ai-config.json'),
    XHS_SMTP_CONFIG_PATH: smtpConfigPath,
    XHS_DATA_RETENTION_PATH: path.join(fixture, 'data-retention.json'),
    XHS_DELETION_AUDIT_PATH: path.join(fixture, 'deletion-audit.jsonl'),
    XHS_DIAGNOSTICS_PATH: path.join(fixture, 'diagnostics.jsonl'),
    OPENCLAW_CONFIG_PATH: path.join(fixture, 'openclaw.json'),
    XHS_RELAY_MONITOR_INTERVAL_MS: '300000',
  };
  let child = null;

  try {
    child = await startServer({ environment, baseUrl });
    const firstPid = child.pid;
    const savedResponse = await fetch(`${baseUrl}/api/email/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        requireTls: false,
        auth: 'login',
        user: 'candidate@example.test',
        from: 'candidate@example.test',
        password: TEST_PASSWORD,
      }),
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.configured, true);
    assert.equal(saved.hasPassword, true);
    assert.equal('password' in saved, false);

    await stopServer(child);
    child = await startServer({ environment, baseUrl });
    assert.notEqual(child.pid, firstPid);

    const restoredResponse = await fetch(`${baseUrl}/api/email/config`);
    assert.equal(restoredResponse.status, 200);
    const restored = await restoredResponse.json();
    assert.equal(restored.configured, true);
    assert.equal(restored.hasPassword, true);
    assert.equal('password' in restored, false);

    const raw = await readFile(smtpConfigPath, 'utf8');
    const persisted = JSON.parse(raw);
    assert.doesNotMatch(raw, new RegExp(TEST_PASSWORD));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.credentialVault.algorithm, 'aes-256-gcm');
    assert.equal((await readFile(`${smtpConfigPath}.key`)).length, 32);
  } finally {
    await stopServer(child);
    await rm(fixture, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer({ environment, baseUrl }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`SMTP integration server exited during startup (${child.exitCode}).\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return child;
    } catch {
      // The process needs a short window to initialize its local stores.
    }
    await delay(250);
  }

  await stopServer(child);
  throw new Error(`Timed out waiting for SMTP integration server.\n${output}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
