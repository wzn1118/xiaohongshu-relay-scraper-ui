import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createMcpHttpGateway } from './mcp-http-server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('stdio bridge works from a Windows-style Chinese and space path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-stdio-中文 空格-'));
  const workspaceAlias = path.join(root, 'MCP 工作区 with spaces');
  t.after(() => rm(workspaceAlias, { recursive: false, force: true }));
  try {
    await symlink(PROJECT_ROOT, workspaceAlias, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`Directory links are unavailable in this environment: ${error.code}`);
      await rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const tokenFile = path.join(root, 'grant.token');
  await writeFile(tokenFile, 'test-grant\n', { mode: 0o600 });
  const sessions = new Map();
  const accessService = {
    productionStore: { getMcpSession: (id) => sessions.get(id) || null },
    status: () => ({ ok: true, service: 'test-mcp' }),
    authenticateRequest: async (req) => {
      if (req.headers.authorization !== 'Bearer test-grant') throw Object.assign(new Error('bad token'), { status: 401 });
      return { grant: { grantId: 'grant-stdio' }, reference: {}, conversation: {} };
    },
    registerSession: (_context, id, client) => sessions.set(id, { sessionId: id, status: 'active', client }),
    touchSession: (_context, id) => {
      if (sessions.get(id)?.status !== 'active') throw Object.assign(new Error('bad session'), { status: 404 });
    },
    closeSession: (_context, id) => sessions.set(id, { ...sessions.get(id), status: 'closed' }),
    listResources: () => [{ name: 'content', uri: 'xhs-data://job/snapshot/content', mimeType: 'application/json' }],
    readResource: async (_context, uri) => ({ contents: [{ uri, mimeType: 'application/json', text: '[{"id":1}]' }] }),
    listTools: () => [{ name: 'records.query', description: 'Query.', inputSchema: { type: 'object' } }],
    executeTool: async () => ({ rows: [{ id: 1 }], total: 1 }),
  };
  const port = await reservePort();
  const gateway = createMcpHttpGateway({ accessService, config: { mcpPort: port, mcpMaxBodyBytes: 64 * 1024 } });
  const httpServer = http.createServer(gateway.handler);
  await listen(httpServer, port);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(workspaceAlias, 'scripts', 'mcp-stdio-bridge.mjs')],
    cwd: workspaceAlias,
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      XHS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      XHS_MCP_TOKEN_FILE: tokenFile,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-contract-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => {
    await Promise.allSettled([client.close(), gateway.close()]);
    await close(httpServer);
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  assert.equal((await client.listResources()).resources[0].name, 'content');
  assert.equal((await client.readResource({ uri: 'xhs-data://job/snapshot/content' })).contents[0].text, '[{"id":1}]');
  assert.equal((await client.listTools()).tools[0].name, 'records.query');
  const result = await client.callTool({ name: 'records.query', arguments: { dataset: 'content' } });
  assert.deepEqual(result.structuredContent, { rows: [{ id: 1 }], total: 1 });
  assert.equal(sessions.size, 1);
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = http.createServer();
  await listen(server, 0);
  const { port } = server.address();
  await close(server);
  return port;
}
