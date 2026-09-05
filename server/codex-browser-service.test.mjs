import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createCodexBrowserService } from './codex-browser-service.mjs';

function fakeCodexProcess({ mcpServers = [] } = {}) {
  const process = new EventEmitter();
  process.pid = 3210;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.messages = [];
  process.kill = () => {
    process.killed = true;
    process.emit('exit', 0, null);
    return true;
  };

  let pending = '';
  process.stdin.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      process.messages.push(message);
      if (message.method === 'initialize') {
        process.stdout.write(`${JSON.stringify({
          id: message.id,
          result: { userAgent: 'codex-test/1.0.0' },
        })}\n`);
      }
      if (message.method === 'mcpServerStatus/list') {
        process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: mcpServers, nextCursor: null } })}\n`);
      }
    }
  });
  return process;
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('bridges browser requests, responses, notifications, and app-server requests', async () => {
  const child = fakeCodexProcess();
  const spawnCalls = [];
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });

  await service.start();
  assert.equal(service.status().initialized, true);
  assert.equal(service.status().pid, 3210);
  assert.equal(spawnCalls[0][2].env.CODEX_SQLITE_HOME, 'C:\\relay-sqlite');
  assert.equal(child.messages[0].method, 'initialize');
  assert.deepEqual(child.messages[0].params.capabilities, { experimentalApi: true });
  assert.equal(child.messages[1].method, 'initialized');

  const request = { id: 'request-1', method: 'thread/list', params: { limit: 10 } };
  await service.send({ type: 'mcp-request', request }, { sessionId: 'browser-a' });
  assert.deepEqual(child.messages.at(-1), request);

  child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-1' } } })}\n`);
  child.stdout.write(`${JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } })}\n`);
  await nextTask();

  const browserAEvents = service.listEvents({ sessionId: 'browser-a' });
  assert.ok(browserAEvents.some(({ message }) => (
    message.type === 'mcp-response'
      && message.requestMethod === 'thread/list'
      && message.message.result.data.length === 0
  )));
  assert.ok(browserAEvents.some(({ message }) => (
    message.type === 'mcp-notification' && message.method === 'thread/started'
  )));
  assert.ok(browserAEvents.some(({ message }) => (
    message.type === 'mcp-request'
      && message.request.id === 'approval-1'
      && message.request.method === 'item/commandExecution/requestApproval'
  )));

  const browserBEvents = service.listEvents({ sessionId: 'browser-b' });
  assert.equal(browserBEvents.some(({ message }) => (
    message.type === 'mcp-response' && message.message.id === request.id
  )), false);
  assert.ok(browserBEvents.some(({ message }) => message.type === 'mcp-notification'));

  const approvalResponse = { id: 'approval-1', result: { decision: 'accept' } };
  await service.send({ type: 'mcp-response', response: approvalResponse }, { sessionId: 'browser-a' });
  assert.deepEqual(child.messages.at(-1), approvalResponse);

  await service.close();
  assert.equal(child.killed, true);
});

test('injects xhs-context as an app-server-scoped HTTP MCP without exposing its token', async () => {
  const child = fakeCodexProcess();
  const spawnCalls = [];
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    contextMcp: {
      name: 'xhs-context',
      url: 'http://127.0.0.1:46291/api/xhs-context/mcp',
      token: 'local-context-token',
      bearerTokenEnvVar: 'XHS_CONTEXT_TOKEN',
    },
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });

  await service.start();
  assert.deepEqual(spawnCalls[0][1], [
    '-c',
    'features.code_mode_host=true',
    '-c',
    'mcp_servers.xhs-context.url="http://127.0.0.1:46291/api/xhs-context/mcp"',
    '-c',
    'mcp_servers.xhs-context.bearer_token_env_var="XHS_CONTEXT_TOKEN"',
    'app-server',
  ]);
  assert.equal(spawnCalls[0][2].env.XHS_CONTEXT_TOKEN, 'local-context-token');
  assert.deepEqual(service.status().contextMcp, {
    configured: true,
    name: 'xhs-context',
    endpoint: 'http://127.0.0.1:46291/api/xhs-context/mcp',
  });
  assert.equal(JSON.stringify(service.status()).includes('local-context-token'), false);

  await service.close();
});

test('injects both context and product MCP servers into the embedded Codex runtime', async () => {
  const child = fakeCodexProcess();
  const spawnCalls = [];
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    contextMcps: [
      {
        name: 'xhs-context',
        url: 'http://127.0.0.1:46291/api/xhs-context/mcp',
        token: 'context-token',
        bearerTokenEnvVar: 'XHS_CONTEXT_TOKEN',
      },
      {
        name: 'codex-product',
        url: 'http://127.0.0.1:46291/api/codex-product/mcp',
        token: 'product-token',
        bearerTokenEnvVar: 'CODEX_PRODUCT_TOKEN',
      },
    ],
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });

  await service.start();
  const args = spawnCalls[0][1];
  assert.ok(args.includes('mcp_servers.xhs-context.url="http://127.0.0.1:46291/api/xhs-context/mcp"'));
  assert.ok(args.includes('mcp_servers.codex-product.url="http://127.0.0.1:46291/api/codex-product/mcp"'));
  assert.equal(spawnCalls[0][2].env.XHS_CONTEXT_TOKEN, 'context-token');
  assert.equal(spawnCalls[0][2].env.CODEX_PRODUCT_TOKEN, 'product-token');
  assert.deepEqual(service.status().contextMcps.map((server) => server.name), ['xhs-context', 'codex-product']);
  assert.equal(JSON.stringify(service.status()).includes('product-token'), false);

  await service.close();
});

test('publishes version-matched generated protocol capability evidence after initialization', async () => {
  const child = fakeCodexProcess();
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    protocolEvidence: {
      state: 'ready',
      source: 'generated-schema+live-probe',
      protocolVersion: '1.0.0',
      schemaPath: 'schema.json',
      probePath: 'live-probe.json',
      schemaSha256: 'abc',
      methods: {
        all: ['initialize', 'thread/list', 'thread/read', 'thread/start', 'thread/resume'],
      },
      probes: { passed: ['thread/list'], failed: [] },
    },
    spawnProcess: () => child,
  });

  assert.equal(service.status().adapter.capabilities.threads, 'unknown');
  assert.equal(service.status().adapter.evidenceDetail.state, 'pending-runtime');
  await service.start();
  assert.equal(service.status().adapter.capabilities.threads, 'supported');
  assert.equal(service.status().adapter.evidenceDetail.actualVersion, '1.0.0');
  await service.close();
});

test('preserves the complete thread list for history browsing', async () => {
  const child = fakeCodexProcess();
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    modelProvider: {
      id: 'xhs_product_api',
      name: 'Product API',
      baseUrl: 'http://127.0.0.1:4337/api/codex-model/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'bridge-secret',
      apiKeyEnvVar: 'XHS_CODEX_MODEL_BRIDGE_TOKEN',
    },
    spawnProcess: () => child,
  });
  await service.start();
  await service.send({
    type: 'mcp-request',
    request: { id: 'thread-list-filter', method: 'thread/list', params: { limit: 10 } },
  }, { sessionId: 'browser-a' });
  child.stdout.write(`${JSON.stringify({
    id: 'thread-list-filter',
    result: {
      data: [
        { id: 'browser-owned', canAcceptDirectInput: true },
        { id: 'locked-external', canAcceptDirectInput: null },
      ],
    },
  })}\n`);
  await nextTask();

  const response = service.listEvents({ sessionId: 'browser-a' })
    .find(({ message }) => message.type === 'mcp-response' && message.message.id === 'thread-list-filter');
  assert.deepEqual(response.message.message.result.data, [
    { id: 'browser-owned', canAcceptDirectInput: true },
    { id: 'locked-external', canAcceptDirectInput: null },
  ]);
  await service.close();
});

test('reports event window gaps and stale cursors so the browser can rebuild from thread/read', async () => {
  const child = fakeCodexProcess();
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    spawnProcess: () => child,
  });
  await service.start();
  child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })}\n`);
  await nextTask();

  const current = service.readEvents({ after: 0, limit: 30 });
  assert.equal(current.resetRequired, false);
  assert.equal(current.events.at(-1).message.method, 'turn/started');
  assert.equal(current.cursor, current.throughCursor);

  const stale = service.readEvents({ after: current.throughCursor + 100 });
  assert.equal(stale.resetRequired, true);
  assert.deepEqual(stale.events, []);
  assert.equal(stale.throughCursor, current.throughCursor);
  await service.close();
});

test('exposes direct canonical requests for browser-owned workspace tasks', async () => {
  const child = fakeCodexProcess();
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    modelProvider: {
      id: 'xhs_product_api',
      name: 'Product API',
      baseUrl: 'http://127.0.0.1:4337/api/codex-model/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'bridge-secret',
      apiKeyEnvVar: 'XHS_CODEX_MODEL_BRIDGE_TOKEN',
    },
    spawnProcess: () => child,
  });
  const request = service.request('threads.start', { cwd: 'C:\\workspace', sandbox: 'workspace-write' });
  await nextTask();
  const sent = child.messages.at(-1);
  assert.equal(sent.method, 'thread/start');
  assert.equal(sent.params.modelProvider, 'xhs_product_api');
  assert.equal(sent.params.model, 'gpt-5.6-sol');
  assert.equal(sent.params.allowProviderModelFallback, false);
  child.stdout.write(`${JSON.stringify({ id: sent.id, result: { thread: { id: 'browser-owned' } } })}\n`);
  assert.deepEqual(await request, { thread: { id: 'browser-owned' } });

  await service.send({
    type: 'mcp-request',
    request: { id: 'resume-from-renderer', method: 'thread/resume', params: { threadId: 'browser-owned', modelProvider: 'OpenAI', model: 'old-model' } },
  });
  assert.equal(child.messages.at(-1).params.modelProvider, 'xhs_product_api');
  assert.equal(child.messages.at(-1).params.model, 'gpt-5.6-sol');
  await service.close();
});

test('exposes every connected MCP as dynamic namespaces and executes product calls in the host', async () => {
  const child = fakeCodexProcess({
    mcpServers: [{
      name: 'codex-product',
      tools: {
        list_jobs: {
          name: 'list_jobs',
          description: 'List product jobs.',
          inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
        },
      },
    }],
  });
  const calls = [];
  const service = createCodexBrowserService({
    executablePath: 'codex.exe',
    workspaceRoot: 'C:\\workspace',
    sqliteHome: 'C:\\relay-sqlite',
    dynamicToolHandler: async (call) => {
      calls.push(call);
      return { handled: true, value: { jobs: [{ id: 'job-1', status: 'completed' }] } };
    },
    spawnProcess: () => child,
  });
  const starting = service.request('threads.start', { cwd: 'C:\\workspace' });
  await nextTask();
  const sent = child.messages.find((message) => message.method === 'thread/start');
  assert.equal(sent.params.dynamicTools[0].type, 'function');
  assert.equal(sent.params.dynamicTools[0].name, 'codex_product__list_jobs');
  assert.equal(service.status().dynamicMcp.catalogReady, true);
  assert.equal(service.status().dynamicMcp.catalogError, '');
  child.stdout.write(`${JSON.stringify({ id: sent.id, result: { thread: { id: 'dynamic-thread' } } })}\n`);
  await starting;

  child.stdout.write(`${JSON.stringify({
    id: 'dynamic-call-1',
    method: 'item/tool/call',
    params: { threadId: 'dynamic-thread', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'codex_product__list_jobs', arguments: { limit: 1 } },
  })}\n`);
  await nextTask();
  await nextTask();
  assert.equal(calls[0].server, 'codex-product');
  assert.equal(calls[0].tool, 'list_jobs');
  const response = child.messages.find((message) => message.id === 'dynamic-call-1');
  assert.equal(response.result.success, true);
  assert.match(response.result.contentItems[0].text, /job-1/u);
  assert.equal(service.status().dynamicMcp.calls, 1);
  assert.equal(service.status().dynamicMcp.completed, 1);
  await service.close();
});
