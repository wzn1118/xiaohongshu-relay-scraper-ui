import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
  MCP_INTERNAL_TOOL_NAME_MAX_CHARS,
  MCP_MODEL_WIRE_TOOL_NAME_MAX_CHARS,
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_MAX_ITEMS,
  McpClientManager,
} from './mcp-client-manager.mjs';

test('discovers, namespaces, and executes tools through a managed MCP connection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-mcp-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let connected = 0;
  let closed = 0;
  let transportsClosed = 0;
  const client = {
    async connect(transport) {
      connected += 1;
      assert.equal(transport.kind, 'fake');
    },
    async listTools() {
      return {
        tools: [
          {
            name: 'search_code',
            description: 'Search source code.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          {
            name: 'create_issue',
            description: 'Create an issue.',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
          },
        ],
      };
    },
    async callTool(request) {
      calls.push(structuredClone(request));
      return {
        content: [{ type: 'text', text: `result:${request.arguments.query}` }],
        structuredContent: { matches: 2 },
      };
    },
    async close() { closed += 1; },
  };
  const manager = new McpClientManager({
    configPath: path.join(root, 'mcp-servers.json'),
    connectOnInitialize: false,
    clientFactory: () => client,
    transportFactory: () => ({ kind: 'fake', async close() { transportsClosed += 1; } }),
  });
  await manager.initialize();
  const server = await manager.upsertServer({
    id: 'github-main',
    label: 'GitHub MCP',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
  });

  assert.equal(server.status, 'connected');
  assert.equal(connected, 1);
  let tools = manager.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools.find((tool) => tool.remoteName === 'search_code')?.risk, 'approval_required');
  assert.equal(tools.find((tool) => tool.remoteName === 'create_issue')?.risk, 'approval_required');
  await manager.upsertServer({
    id: 'github-main',
    label: 'GitHub MCP',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    readOnlyTools: ['search_code'],
  });
  tools = manager.listTools();
  assert.equal(tools.find((tool) => tool.remoteName === 'search_code')?.risk, 'read');
  assert.equal(tools.find((tool) => tool.remoteName === 'search_code')?.parallelSafe, true);
  const searchTool = tools.find((tool) => tool.remoteName === 'search_code');
  assert.match(searchTool.name, /^mcp\.github-main\.search_code-/u);

  const result = await manager.execute(searchTool.name, { query: 'runtime' });
  assert.deepEqual(calls, [{ name: 'search_code', arguments: { query: 'runtime' } }]);
  assert.equal(result.type, 'mcp.result');
  assert.equal(result.text, 'result:runtime');
  assert.deepEqual(result.structuredContent, { matches: 2 });

  await manager.close();
  assert.equal(closed, 2);
  assert.equal(transportsClosed, 2);
});

test('persists only MCP credential references and restores editable connection fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-mcp-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'mcp-servers.json');
  const manager = new McpClientManager({ configPath, connectOnInitialize: false });
  await manager.initialize();
  await manager.upsertServer({
    id: 'remote-api',
    transport: 'streamable_http',
    url: 'https://mcp.example.test/v1',
    headers: {
      Authorization: 'must-not-persist',
      'X-Client': 'copilot',
      'X-Secret': 'also-must-not-persist',
      Host: 'attacker.example.test',
    },
    headerEnv: { Authorization: 'MCP_REMOTE_TOKEN', 'X-Api-Key': 'MCP_REMOTE_API_KEY' },
    env: ['MCP_STDIO_TOKEN'],
    readOnlyTools: ['search'],
  }, { connect: false });

  const raw = await readFile(configPath, 'utf8');
  assert.doesNotMatch(raw, /must-not-persist/u);
  assert.doesNotMatch(raw, /also-must-not-persist/u);
  assert.doesNotMatch(raw, /attacker\.example/u);
  assert.match(raw, /MCP_REMOTE_TOKEN/u);
  const persisted = JSON.parse(raw).servers[0];
  assert.deepEqual(persisted.headers, { 'X-Client': 'copilot' });
  assert.deepEqual(persisted.readOnlyTools, ['search']);
  const listed = manager.listServers()[0];
  assert.deepEqual(listed.headerEnv, { Authorization: 'MCP_REMOTE_TOKEN', 'X-Api-Key': 'MCP_REMOTE_API_KEY' });
  assert.deepEqual(listed.readOnlyTools, ['search']);

  const restored = new McpClientManager({ configPath, connectOnInitialize: false });
  await restored.initialize();
  assert.deepEqual(restored.listServers()[0].headerEnv, { Authorization: 'MCP_REMOTE_TOKEN', 'X-Api-Key': 'MCP_REMOTE_API_KEY' });
  assert.deepEqual(restored.listServers()[0].readOnlyTools, ['search']);
  assert.equal(restored.listServers()[0].url, 'https://mcp.example.test/v1');
});

test('rejects non-HTTP URLs for streamable HTTP transports', async () => {
  const manager = new McpClientManager({ connectOnInitialize: false });
  await manager.initialize();
  await assert.rejects(
    manager.upsertServer({
      id: 'invalid-transport-url',
      transport: 'streamable_http',
      url: 'file:///tmp/mcp.sock',
    }, { connect: false }),
    (error) => error?.code === 'COPILOT_MCP_URL_INVALID' && error?.status === 400,
  );
});

test('rejects embedded URL credentials for streamable HTTP transports', async () => {
  const manager = new McpClientManager({ connectOnInitialize: false });
  await manager.initialize();
  await assert.rejects(
    manager.upsertServer({
      id: 'credentialed-url',
      transport: 'streamable_http',
      url: 'https://user:secret@mcp.example.test/v1',
    }, { connect: false }),
    (error) => error?.code === 'COPILOT_MCP_URL_USERINFO_FORBIDDEN' && error?.status === 400,
  );
});

test('keeps internal and model-wire MCP tool names stable within 64 characters', async () => {
  const remoteName = `remote_${'tool_name_'.repeat(80)}`;
  const client = {
    async connect() {},
    async listTools() { return { tools: [{ name: remoteName, inputSchema: { type: 'object' } }] }; },
    async close() {},
  };
  const manager = new McpClientManager({
    connectOnInitialize: false,
    clientFactory: () => client,
    transportFactory: () => ({ async close() {} }),
  });
  await manager.initialize();
  await manager.upsertServer({
    id: `server-${'very-long-id-'.repeat(20)}`,
    transport: 'stdio',
    command: 'node',
  });
  const firstName = manager.listTools()[0].name;
  const firstWireName = `copilot_${firstName.replaceAll('.', '__')}`;
  assert.ok(firstName.length <= MCP_INTERNAL_TOOL_NAME_MAX_CHARS);
  assert.ok(firstWireName.length <= MCP_MODEL_WIRE_TOOL_NAME_MAX_CHARS);

  await manager.refresh();
  assert.equal(manager.listTools()[0].name, firstName);
  await manager.close();
});

test('degrades malformed config and invalid server entries into diagnostics', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-mcp-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'mcp-servers.json');
  await writeFile(configPath, '{not-json', 'utf8');
  const malformed = new McpClientManager({ configPath, connectOnInitialize: false });
  const malformedDescription = await malformed.initialize();
  assert.equal(malformedDescription.servers.length, 0);
  assert.equal(malformedDescription.diagnostics[0]?.code, 'COPILOT_MCP_CONFIG_INVALID');

  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    servers: [
      { id: 'valid-disabled', enabled: false, transport: 'stdio', command: 'node' },
      { id: 'bad-url', transport: 'streamable_http', url: 'file:///tmp/socket' },
      { transport: 'stdio', command: 'node' },
    ],
  }), 'utf8');
  const partial = new McpClientManager({ configPath, connectOnInitialize: false });
  const partialDescription = await partial.initialize();
  assert.deepEqual(partialDescription.servers.map((server) => server.id), ['valid-disabled']);
  assert.equal(partialDescription.diagnostics.filter((item) => item.code === 'COPILOT_MCP_CONFIG_SERVER_INVALID').length, 2);
});

test('drains stdio stderr with bounded accounting and closes clients and transports', async () => {
  const stderr = new PassThrough();
  let clientClosed = 0;
  let transportClosed = 0;
  const transport = {
    stderr,
    async close() {
      transportClosed += 1;
      stderr.end();
    },
  };
  const client = {
    async connect() { stderr.write(Buffer.alloc(70_000, 120)); },
    async listTools() { return { tools: [] }; },
    async close() { clientClosed += 1; },
  };
  const manager = new McpClientManager({
    connectOnInitialize: false,
    clientFactory: () => client,
    transportFactory: () => transport,
  });
  await manager.initialize();
  await manager.upsertServer({ id: 'stderr-server', transport: 'stdio', command: 'node' });
  assert.deepEqual(manager.listServers()[0].stderrDrain, { bytesDrained: 64_000, truncated: true });

  await manager.close();
  await manager.close();
  assert.equal(clientClosed, 1);
  assert.equal(transportClosed, 1);
});

test('bounds MCP response item count and total serialized bytes', async () => {
  const remoteName = `large_result_${'z'.repeat(200_000)}`;
  const client = {
    async connect() {},
    async listTools() { return { tools: [{ name: remoteName, inputSchema: { type: 'object' } }] }; },
    async callTool() {
      return {
        content: Array.from({ length: 200 }, (_, index) => ({ type: 'text', text: `${index}:${'x'.repeat(12_000)}` })),
        structuredContent: { rows: Array.from({ length: 200 }, () => 'y'.repeat(12_000)) },
      };
    },
    async close() {},
  };
  const manager = new McpClientManager({
    connectOnInitialize: false,
    clientFactory: () => client,
    transportFactory: () => ({ async close() {} }),
  });
  await manager.initialize();
  await manager.upsertServer({ id: 'large-result', transport: 'stdio', command: 'node' });
  const tool = manager.listTools()[0];
  const result = await manager.execute(tool.name, {});

  assert.ok(result.content.length <= MCP_RESULT_MAX_ITEMS);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MCP_RESULT_MAX_BYTES);
  assert.ok(result.toolName.length <= 1_000);
  assert.equal(result.truncated, true);
  await manager.close();
});
