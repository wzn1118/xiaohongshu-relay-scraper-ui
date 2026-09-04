import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCodexAppServerTransport } from './codex-app-server-transport.mjs';

function fakeProcess({ respondToInitialize = true } = {}) {
  const process = new EventEmitter();
  process.pid = 8123;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.messages = [];
  process.kill = () => { process.killed = true; process.emit('exit', 0, null); return true; };
  let pending = '';
  process.stdin.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      process.messages.push(message);
      if (respondToInitialize && message.method === 'initialize') {
        process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex-fixture/1.0' } })}\n`);
      }
    }
  });
  return process;
}

test('owns stdio framing and initialization while forwarding non-internal messages', async () => {
  const child = fakeProcess();
  const sqliteHome = path.join(await mkdtemp(path.join(os.tmpdir(), 'codex-transport-')), 'state');
  const connections = [];
  const messages = [];
  const transport = createCodexAppServerTransport({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome,
    spawnProcess: () => child,
  });
  transport.onConnection((event) => connections.push(event));
  transport.onMessage((message) => messages.push(message));
  const initialized = await transport.start();
  assert.equal((await stat(sqliteHome)).isDirectory(), true);
  assert.equal(initialized.userAgent, 'codex-fixture/1.0');
  assert.equal(transport.status().initialized, true);
  assert.equal(transport.status().transport, 'stdio-jsonl');
  assert.equal(child.messages[0].method, 'initialize');
  assert.equal(child.messages[1].method, 'initialized');
  assert.equal(connections.at(-1).state, 'connected');

  const response = transport.request({ id: 'request-1', method: 'thread/list', params: {} });
  child.stdout.write(`${JSON.stringify({ id: 'request-1', result: { data: [] } })}\n`);
  assert.deepEqual(await response, { data: [] });
  child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ method: 'thread/started', params: {} }]);
  await transport.close();
  assert.equal(child.killed, true);
  await rm(path.dirname(sqliteHome), { recursive: true, force: true });
});

test('terminates a timed-out initialization before allowing a clean retry', async () => {
  const first = fakeProcess({ respondToInitialize: false });
  const second = fakeProcess();
  const processes = [first, second];
  const connections = [];
  const transport = createCodexAppServerTransport({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\sqlite',
    initializationTimeoutMs: 10,
    spawnProcess: () => processes.shift(),
  });
  transport.onConnection((event) => connections.push(event));

  await assert.rejects(transport.start(), (error) => error.code === 'CODEX_APP_SERVER_REQUEST_TIMEOUT');
  assert.equal(first.killed, true);
  assert.equal(transport.status().running, false);
  assert.equal(connections.at(-1).state, 'error');

  await transport.start();
  assert.equal(second.messages[0].method, 'initialize');
  assert.equal(transport.status().initialized, true);
  await transport.close();
});

test('includes app-server stderr when initialization exits', async () => {
  const child = fakeProcess({ respondToInitialize: false });
  const transport = createCodexAppServerTransport({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    spawnProcess: () => child,
  });
  const starting = transport.start();
  child.stderr.write('state database is unavailable\n');
  child.emit('exit', 17, null);
  await assert.rejects(starting, (error) => (
    error.code === 'CODEX_APP_SERVER_EXITED'
      && error.message.includes('code 17')
      && error.message.includes('state database is unavailable')
  ));
});

test('injects a private Responses bridge provider without exposing its credential in status', async () => {
  const child = fakeProcess();
  let spawned = null;
  const transport = createCodexAppServerTransport({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    modelProvider: {
      id: 'xhs_product_api',
      name: 'Product API',
      baseUrl: 'http://127.0.0.1:4337/api/codex-model/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'bridge-secret',
      apiKeyEnvVar: 'XHS_CODEX_MODEL_BRIDGE_TOKEN',
    },
    spawnProcess: (executablePath, args, options) => {
      spawned = { executablePath, args, options };
      return child;
    },
  });
  await transport.start();
  assert.equal(spawned.executablePath, 'codex.exe');
  assert.ok(spawned.args.includes('model_provider="xhs_product_api"'));
  assert.ok(spawned.args.includes('model="gpt-5.6-sol"'));
  assert.ok(spawned.args.includes('model_providers.xhs_product_api.wire_api="responses"'));
  assert.ok(spawned.args.includes('model_providers.xhs_product_api.env_key="XHS_CODEX_MODEL_BRIDGE_TOKEN"'));
  assert.equal(spawned.options.env.XHS_CODEX_MODEL_BRIDGE_TOKEN, 'bridge-secret');
  assert.notEqual(spawned.options.env.CODEX_HOME, path.resolve(spawned.options.env.CODEX_SQLITE_HOME));
  assert.equal(spawned.options.env.CODEX_HOME, path.join(path.resolve(spawned.options.env.CODEX_SQLITE_HOME), 'home'));
  assert.equal('OPENAI_BASE_URL' in spawned.options.env, false);
  assert.equal('OPENAI_API_KEY' in spawned.options.env, false);
  assert.deepEqual(transport.status().modelProvider, {
    configured: true,
    id: 'xhs_product_api',
    name: 'Product API',
    endpoint: 'http://127.0.0.1:4337/api/codex-model/v1',
    model: 'gpt-5.6-sol',
    wireApi: 'responses',
  });
  assert.equal(JSON.stringify(transport.status()).includes('bridge-secret'), false);
  await transport.close();
});

test('isolates the embedded runtime when no product model provider is configured', async () => {
  const child = fakeProcess();
  let spawned = null;
  const transport = createCodexAppServerTransport({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\sqlite',
    spawnProcess: (executablePath, args, options) => {
      spawned = { executablePath, args, options };
      return child;
    },
  });
  await transport.start();
  assert.equal(spawned.options.env.CODEX_HOME, path.resolve('C:\\sqlite\\home'));
  assert.equal(spawned.options.env.CODEX_SQLITE_HOME, path.resolve('C:\\sqlite'));
  assert.equal('OPENAI_BASE_URL' in spawned.options.env, false);
  assert.equal('OPENAI_API_KEY' in spawned.options.env, false);
  await transport.close();
});
