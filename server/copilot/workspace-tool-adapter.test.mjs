import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkspaceToolAdapter } from './workspace-tool-adapter.mjs';

async function workspaceFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, adapter: new WorkspaceToolAdapter({ workspaceRoot: root, ...options }) };
}

test('publishes DataToolRegistry-compatible descriptors and stable risk levels', async (t) => {
  const { adapter } = await workspaceFixture(t);
  const tools = adapter.list();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'workspace.list',
    'workspace.read',
    'workspace.write',
    'workspace.patch',
    'exec.run',
    'http.request',
  ]);
  assert.equal(adapter.get('workspace.list').risk, 'read');
  assert.equal(adapter.get('workspace.read').risk, 'read');
  for (const name of ['workspace.write', 'workspace.patch', 'exec.run', 'http.request']) {
    assert.equal(adapter.get(name).risk, 'approval_required');
  }
  assert.equal('handler' in tools[0], false);
  assert.equal(typeof adapter.get('workspace.read').handler, 'function');
  await assert.rejects(adapter.execute('missing.tool'), { code: 'WORKSPACE_TOOL_UNKNOWN', status: 404 });
});

test('lists, reads, atomically writes, and patches files below the workspace root', async (t) => {
  const { root, adapter } = await workspaceFixture(t);

  const writeReceipt = await adapter.execute('workspace.write', {
    path: 'nested/example.txt',
    content: 'alpha\nbeta\n',
  });
  assert.equal(writeReceipt.type, 'workspace.write.receipt');
  assert.equal(writeReceipt.created, true);
  assert.equal(writeReceipt.atomic, true);
  assert.equal(await readFile(path.join(root, 'nested', 'example.txt'), 'utf8'), 'alpha\nbeta\n');
  assert.deepEqual((await readdir(path.join(root, 'nested'))).sort(), ['example.txt']);

  const readReceipt = await adapter.execute('workspace.read', {
    path: 'nested/example.txt',
    maxBytes: 5,
  });
  assert.equal(readReceipt.content, 'alpha');
  assert.equal(readReceipt.bytesRead, 5);
  assert.equal(readReceipt.truncated, true);
  assert.equal(readReceipt.sha256, null);

  const patchReceipt = await adapter.execute('workspace.patch', {
    path: 'nested/example.txt',
    edits: [{ oldText: 'beta', newText: 'gamma' }],
    expectedSha256: writeReceipt.sha256,
  });
  assert.equal(patchReceipt.replacements, 1);
  assert.equal(patchReceipt.changed, true);
  assert.equal(await readFile(path.join(root, 'nested', 'example.txt'), 'utf8'), 'alpha\ngamma\n');

  const diffReceipt = await adapter.execute('workspace.patch', {
    path: 'nested/example.txt',
    patch: [
      '--- a/nested/example.txt',
      '+++ b/nested/example.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-gamma',
      '+delta',
    ].join('\n'),
  });
  assert.equal(diffReceipt.replacements, 2);
  assert.equal(await readFile(path.join(root, 'nested', 'example.txt'), 'utf8'), 'alpha\ndelta\n');

  const listReceipt = await adapter.execute('workspace.list', { recursive: true });
  assert.deepEqual(listReceipt.entries.map((entry) => entry.path), ['nested', 'nested/example.txt']);
  assert.doesNotThrow(() => JSON.stringify(listReceipt));
});

test('rejects lexical root escapes, absolute paths, and symbolic-link escapes', async (t) => {
  const { root, adapter } = await workspaceFixture(t);
  await assert.rejects(adapter.execute('workspace.read', { path: '../outside.txt' }), { code: 'WORKSPACE_PATH_ESCAPE' });
  await assert.rejects(adapter.execute('workspace.write', { path: path.resolve(root, 'absolute.txt'), content: 'x' }), { code: 'WORKSPACE_PATH_ABSOLUTE' });

  const outside = await mkdtemp(path.join(tmpdir(), 'workspace-tools-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(adapter.execute('workspace.read', { path: 'outside-link/secret.txt' }), { code: 'WORKSPACE_PATH_ESCAPE' });
  await assert.rejects(adapter.execute('workspace.write', { path: 'outside-link/new.txt', content: 'nope' }), { code: 'WORKSPACE_SYMLINK_WRITE_DENIED' });
  const listReceipt = await adapter.execute('workspace.list', {});
  const link = listReceipt.entries.find((entry) => entry.name === 'outside-link');
  assert.equal(link.type, 'symlink');
  assert.equal(link.targetInsideRoot, false);
});

test('exec.run uses shell false and returns bounded stdout and stderr receipts', async (t) => {
  const { adapter } = await workspaceFixture(t, { env: { TOOL_SECRET: 'not-returned' } });
  const receipt = await adapter.execute('exec.run', {
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(80)); process.stderr.write('y'.repeat(60));"],
    inheritEnv: false,
    envRefs: { CHILD_SECRET: 'TOOL_SECRET' },
    maxOutputBytes: 24,
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.shell, false);
  assert.equal(receipt.stdout, 'x'.repeat(24));
  assert.equal(receipt.stderr, 'y'.repeat(24));
  assert.equal(receipt.stdoutBytes, 80);
  assert.equal(receipt.stderrBytes, 60);
  assert.equal(receipt.stdoutTruncated, true);
  assert.equal(receipt.stderrTruncated, true);
  assert.deepEqual(receipt.envReferenceKeys, ['CHILD_SECRET']);
  assert.equal(JSON.stringify(receipt).includes('not-returned'), false);
});

test('exec.run resolves the real Windows npm command shim without enabling a shell', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { adapter } = await workspaceFixture(t);
  const receipt = await adapter.execute('exec.run', {
    command: 'npm',
    args: ['--version'],
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.shell, false);
  assert.equal(receipt.resolvedCommand.toLowerCase(), process.execPath.toLowerCase());
  assert.match(receipt.commandShim, /npm\.cmd$/iu);
  assert.match(receipt.stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test('exec.run timeout and cancellation terminate descendants without touching an unrelated process', async (t) => {
  const { root, adapter } = await workspaceFixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForSpawn(unrelated);
  t.after(() => stopTestProcess(unrelated));

  const timeoutPidFile = path.join(root, 'timeout-child.pid');
  const timedOut = await adapter.execute('exec.run', {
    command: process.execPath,
    args: ['-e', processTreeFixtureSource(), timeoutPidFile],
    timeoutMs: 250,
  });
  const timeoutChildPid = Number(await waitForFile(timeoutPidFile));
  t.after(() => stopTestPid(timeoutChildPid));
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.timedOut, true);
  await waitForProcessExit(timeoutChildPid);
  assert.equal(isProcessAlive(unrelated.pid), true);

  const cancellationPidFile = path.join(root, 'cancelled-child.pid');
  const controller = new AbortController();
  const pending = adapter.execute('exec.run', {
    command: process.execPath,
    args: ['-e', processTreeFixtureSource(), cancellationPidFile],
    timeoutMs: 5_000,
  }, { signal: controller.signal });
  const cancellationChildPid = Number(await waitForFile(cancellationPidFile));
  t.after(() => stopTestPid(cancellationChildPid));
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'COPILOT_RUN_CANCELLED');
    assert.equal(error.receipt.cancelled, true);
    assert.equal(error.receipt.status, 'cancelled');
    return true;
  });
  await waitForProcessExit(cancellationChildPid);
  assert.equal(isProcessAlive(unrelated.pid), true);
});

test('http.request resolves sensitive headers from env and truncates response bodies', async (t) => {
  let receivedAuthorization = '';
  const server = createServer((request, response) => {
    receivedAuthorization = String(request.headers.authorization || '');
    response.setHeader('content-type', 'text/plain');
    response.setHeader('set-cookie', 'session=server-secret');
    response.end('z'.repeat(128));
  });
  const address = await listen(server);
  t.after(() => close(server));
  const { adapter } = await workspaceFixture(t, { env: { API_TOKEN: 'top-secret' } });

  const receipt = await adapter.execute('http.request', {
    url: `http://127.0.0.1:${address.port}/resource`,
    headers: {
      authorization: { env: 'API_TOKEN', prefix: 'Bearer ' },
      'x-client': 'workspace-test',
    },
    maxResponseBytes: 20,
  });
  assert.equal(receivedAuthorization, 'Bearer top-secret');
  assert.deepEqual(receipt.requestHeaders.authorization, { env: 'API_TOKEN', redacted: true });
  assert.equal(receipt.responseHeaders['set-cookie'], '<redacted>');
  assert.equal(receipt.body, 'z'.repeat(20));
  assert.equal(receipt.responseTruncated, true);
  assert.equal(receipt.responseBytes, 128);
  assert.equal(JSON.stringify(receipt).includes('top-secret'), false);

  await assert.rejects(adapter.execute('http.request', {
    url: `http://127.0.0.1:${address.port}/resource`,
    headers: { authorization: 'Bearer inline-secret' },
  }), { code: 'WORKSPACE_HTTP_SENSITIVE_HEADER_ENV_REQUIRED' });
});

test('http.request aborts requests that exceed the configured timeout', async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end('late'), 500);
  });
  const address = await listen(server);
  t.after(() => close(server));
  const { adapter } = await workspaceFixture(t);

  await assert.rejects(adapter.execute('http.request', {
    url: `http://127.0.0.1:${address.port}/slow`,
    timeoutMs: 50,
  }), (error) => {
    assert.equal(error.code, 'WORKSPACE_HTTP_TIMEOUT');
    assert.equal(error.receipt.status, 'timed_out');
    assert.equal(error.receipt.timeoutMs, 50);
    return true;
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function processTreeFixtureSource() {
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'writeFileSync(process.argv[1], String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(20);
  }
  assert.fail(`Process ${pid} survived process-tree cleanup.`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function stopTestProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Best-effort test cleanup.
  }
}

function stopTestPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort test cleanup.
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
