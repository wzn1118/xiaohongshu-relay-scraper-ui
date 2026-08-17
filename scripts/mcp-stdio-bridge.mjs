import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const endpoint = normalizeEndpoint(process.env.XHS_MCP_URL || 'http://127.0.0.1:4328/mcp');
const token = await resolveToken();
const upstreamTransport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'xiaohongshu-mcp-stdio-bridge', version: '1.0.0' }, { capabilities: {} });
await client.connect(upstreamTransport);

const server = new Server(
  { name: 'xiaohongshu-relay-scraper-mcp-stdio', version: '1.0.0' },
  {
    capabilities: { resources: { listChanged: false }, tools: { listChanged: false } },
    instructions: 'Local stdio bridge to the loopback-only Xiaohongshu MCP Streamable HTTP endpoint.',
  },
);
server.setRequestHandler(ListResourcesRequestSchema, (request) => client.listResources(request.params));
server.setRequestHandler(ReadResourceRequestSchema, (request) => client.readResource(request.params));
server.setRequestHandler(ListToolsRequestSchema, (request) => client.listTools(request.params));
server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params));

const stdio = new StdioServerTransport();
await server.connect(stdio);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), client.close()]);
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
process.once('beforeExit', () => void close());

async function resolveToken() {
  const direct = String(process.env.XHS_MCP_TOKEN || '').trim();
  if (direct) return direct;
  const tokenFile = String(process.env.XHS_MCP_TOKEN_FILE || '').trim();
  if (!tokenFile) {
    throw new Error('Set XHS_MCP_TOKEN or XHS_MCP_TOKEN_FILE before starting the MCP stdio bridge.');
  }
  const stored = String(await readFile(tokenFile, 'utf8')).trim();
  if (!stored) throw new Error('XHS_MCP_TOKEN_FILE is empty.');
  return stored;
}

function normalizeEndpoint(value) {
  const url = new URL(String(value || ''));
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('XHS_MCP_URL must use HTTPS or loopback HTTP.');
  }
  if (url.username || url.password) throw new Error('XHS_MCP_URL must not contain credentials.');
  if (url.pathname !== '/mcp') throw new Error('XHS_MCP_URL must target the /mcp endpoint.');
  return url;
}
