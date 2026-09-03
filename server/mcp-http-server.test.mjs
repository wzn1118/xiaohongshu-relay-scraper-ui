import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpGateway } from './mcp-http-server.mjs';

test('Streamable HTTP MCP performs official initialize, list, call, and session close', async (t) => {
  const port = await reservePort();
  const sessions = new Map();
  const accessService = {
    productionStore: { getMcpSession: (id) => sessions.get(id) || null },
    status: () => ({ ok: true, service: 'test-mcp' }),
    authenticateRequest: async (req) => {
      if (req.headers.authorization !== 'Bearer test-grant') throw Object.assign(new Error('bad token'), { status: 401 });
      return { grant: { grantId: 'grant-1' }, reference: {}, conversation: {} };
    },
    registerSession: (_context, id, client) => sessions.set(id, { sessionId: id, status: 'active', client }),
    touchSession: (_context, id) => {
      if (sessions.get(id)?.status !== 'active') throw Object.assign(new Error('bad session'), { status: 404 });
    },
    closeSession: (_context, id) => sessions.set(id, { ...sessions.get(id), status: 'closed' }),
    listResources: () => [{ name: 'content', uri: 'xhs-data://job/snapshot/content', mimeType: 'application/json' }],
    readResource: async (_context, uri) => ({ contents: [{ uri, mimeType: 'application/json', text: '[]' }] }),
    listTools: () => [{ name: 'records.query', description: 'Query.', inputSchema: { type: 'object' } }],
    executeTool: async () => ({ rows: [{ id: 1 }], total: 1 }),
  };
  const gateway = createMcpHttpGateway({
    accessService,
    config: {
      mcpPort: port,
      mcpPublicHost: 'mcp.hegelsalon.com',
      mcpRequireCloudflareHeaders: true,
      mcpPublicOrigin: 'https://mcp.hegelsalon.com',
      mcpPublicShowcaseEnabled: true,
      mcpPublicShowcaseMaxBodyBytes: 64 * 1024,
      mcpPublicShowcaseMaxCallsPerMinute: 100,
      mcpPublicShowcaseMaxConcurrentRequests: 4,
      mcpMaxBodyBytes: 64 * 1024,
      mcpMaxSessions: 1,
      mcpMaxSessionsPerGrant: 1,
    },
  });
  const server = http.createServer(gateway.handler);
  await listen(server, port);
  t.after(async () => { await gateway.close(); await close(server); });

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.version, '3.1.0');
  assert.equal(health.publicShowcase.mode, 'anonymous-read-only-showcase');

  const untrustedHost = await request(port, '/health', { Host: 'attacker.invalid' });
  assert.equal(untrustedHost.status, 403);

  const missingProxyProof = await request(port, '/health', { Host: 'mcp.hegelsalon.com' });
  assert.equal(missingProxyProof.status, 403);

  const publicHealth = await request(port, '/health', {
    Host: 'mcp.hegelsalon.com',
    'X-Forwarded-Proto': 'https',
    'CF-Ray': 'test-ray',
    'CF-Connecting-IP': '203.0.113.7',
  });
  assert.equal(publicHealth.status, 200);
  assert.equal(JSON.parse(publicHealth.body).ok, true);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer test-grant' } },
  });
  const client = new Client({ name: 'mcp-contract-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  assert.equal((await client.listResources()).resources.length, 1);
  assert.equal((await client.listTools()).tools[0].name, 'records.query');
  const result = await client.callTool({ name: 'records.query', arguments: { dataset: 'content' } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { rows: [{ id: 1 }], total: 1 });
  assert.equal(sessions.size, 1);

  const secondTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer test-grant' } },
  });
  const secondClient = new Client({ name: 'mcp-concurrency-test', version: '1.0.0' }, { capabilities: {} });
  await assert.rejects(secondClient.connect(secondTransport));
  await secondClient.close().catch(() => {});
  assert.equal(gateway.activeSessionCount(), 1);

  const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-grant', Origin: 'https://example.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(rejected.status, 403);

  await transport.terminateSession();
  assert.equal([...sessions.values()][0].status, 'closed');
  await client.close();
});

test('anonymous MCP showcase is stateless, synthetic, bounded, and never downgrades invalid auth', async (t) => {
  const port = await reservePort();
  let authenticationCalls = 0;
  let persistedSessionCalls = 0;
  const accessService = {
    productionStore: { getMcpSession: () => null },
    status: () => ({ ok: true, service: 'test-mcp' }),
    authenticateRequest: async () => {
      authenticationCalls += 1;
      throw Object.assign(new Error('bad token'), { code: 'MCP_AUTH_REQUIRED', status: 401 });
    },
    registerSession: () => { persistedSessionCalls += 1; },
    touchSession: () => { persistedSessionCalls += 1; },
    closeSession: () => { persistedSessionCalls += 1; },
    listResources: () => { throw new Error('private provider must not be reached'); },
    readResource: () => { throw new Error('private provider must not be reached'); },
    listTools: () => { throw new Error('private provider must not be reached'); },
    executeTool: () => { throw new Error('private provider must not be reached'); },
  };
  const gateway = createMcpHttpGateway({
    accessService,
    config: {
      authOrigin: 'https://relay.hegelsalon.com',
      mcpPort: port,
      mcpPublicOrigin: 'https://mcp.hegelsalon.com',
      mcpPublicHost: 'mcp.hegelsalon.com',
      mcpPublicShowcaseEnabled: true,
      mcpPublicShowcaseMaxBodyBytes: 1024,
      mcpPublicShowcaseMaxCallsPerMinute: 100,
      mcpPublicShowcaseMaxConcurrentRequests: 4,
      mcpMaxBodyBytes: 64 * 1024,
    },
  });
  const server = http.createServer(gateway.handler);
  await listen(server, port);
  t.after(async () => { await gateway.close(); await close(server); });

  const browserResponse = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(browserResponse.status, 200);
  const browserInfo = await browserResponse.json();
  assert.equal(browserInfo.mode, 'anonymous-read-only-showcase');
  assert.equal(browserInfo.dataClassification, 'synthetic-demo-only');
  assert.equal(browserInfo.resources.length, 3);
  assert.equal(browserInfo.tools.length, 3);

  const sseGet = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(sseGet.status, 405);
  const anonymousDelete = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
  assert.equal(anonymousDelete.status, 405);
  const fakeSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { 'Mcp-Session-Id': 'private-session-probe' },
  });
  assert.equal(fakeSession.status, 400);
  assert.equal((await fakeSession.json()).error.data.code, 'MCP_PUBLIC_SESSION_UNSUPPORTED');

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'mcp-public-showcase-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map((resource) => resource.uri), [
    'showcase://today-you-applied/overview',
    'showcase://today-you-applied/capabilities',
    'showcase://today-you-applied/sample-jobs',
  ]);
  const resource = await client.readResource({ uri: resources[2].uri });
  assert.match(resource.contents[0].text, /synthetic-demo-only/u);

  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'showcase.get_overview',
    'showcase.search_sample_jobs',
    'showcase.build_application_plan',
  ]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.ok(tools.every((tool) => !['artifact.create', 'email.send', 'records.query'].includes(tool.name)));
  const searchResult = await client.callTool({
    name: 'showcase.search_sample_jobs',
    arguments: { query: 'AI', city: 'Shanghai', limit: 2 },
  });
  assert.equal(searchResult.isError, false);
  assert.equal(searchResult.structuredContent.dataClassification, 'synthetic-demo-only');
  assert.equal(searchResult.structuredContent.total, 1);
  const unknownResult = await client.callTool({ name: 'artifact.create', arguments: {} });
  assert.equal(unknownResult.isError, true);
  const invalidInput = await client.callTool({
    name: 'showcase.build_application_plan',
    arguments: { targetRole: 'x'.repeat(81) },
  });
  assert.equal(invalidInput.isError, true);
  await client.close();

  assert.equal(gateway.activeSessionCount(), 0);
  assert.equal(persistedSessionCalls, 0);
  assert.equal(authenticationCalls, 0);

  const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(1025),
  });
  assert.equal(oversized.status, 413);

  for (const authorization of ['Bearer invalid-grant', 'Basic invalid']) {
    const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(initializeRequest()),
    });
    assert.equal(rejected.status, 401);
  }
  assert.equal(authenticationCalls, 2);
  assert.equal(persistedSessionCalls, 0);
});

test('anonymous MCP showcase enforces the per-source request limit', async (t) => {
  const port = await reservePort();
  const gateway = createMcpHttpGateway({
    accessService: {
      productionStore: { getMcpSession: () => null },
      status: () => ({ ok: true, service: 'test-mcp' }),
      authenticateRequest: async () => { throw Object.assign(new Error('bad token'), { status: 401 }); },
    },
    config: {
      mcpPort: port,
      mcpPublicShowcaseEnabled: true,
      mcpPublicShowcaseMaxBodyBytes: 64 * 1024,
      mcpPublicShowcaseMaxCallsPerMinute: 1,
      mcpPublicShowcaseMaxConcurrentRequests: 1,
      mcpMaxBodyBytes: 64 * 1024,
    },
  });
  const server = http.createServer(gateway.handler);
  await listen(server, port);
  t.after(async () => { await gateway.close(); await close(server); });

  const first = await postJson(port, initializeRequest());
  assert.equal(first.status, 200);
  const second = await postJson(port, initializeRequest());
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.data.code, 'MCP_PUBLIC_RATE_LIMITED');
});

async function reservePort() {
  const server = http.createServer();
  await listen(server, 0);
  const port = server.address().port;
  await close(server);
  return port;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw-contract-test', version: '1.0.0' },
    },
  };
}

function postJson(port, body) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}
