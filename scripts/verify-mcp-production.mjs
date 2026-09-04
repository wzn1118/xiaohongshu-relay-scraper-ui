import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = normalizeEndpoint(process.env.XHS_MCP_URL || 'http://127.0.0.1:4328/mcp');
const token = await resolveToken();
const healthUrl = new URL('/health', endpoint);
const startedAt = Date.now();
let client;
let transport;

try {
  const healthResponse = await fetch(healthUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!healthResponse.ok) throw new Error(`MCP health check returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  if (health?.ok !== true || health?.service !== 'xiaohongshu-relay-scraper-mcp') {
    throw new Error('MCP health response did not identify a ready production service.');
  }

  transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  client = new Client(
    { name: 'xiaohongshu-mcp-production-verifier', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  const [resourceResult, toolResult] = await Promise.all([
    client.listResources(),
    client.listTools(),
  ]);
  const resources = Array.isArray(resourceResult.resources) ? resourceResult.resources : [];
  const tools = Array.isArray(toolResult.tools) ? toolResult.tools : [];
  let resourceRead = { attempted: false, contentBlocks: 0 };
  if (resources[0]?.uri && process.env.XHS_MCP_VERIFY_SKIP_RESOURCE_READ !== 'true') {
    const result = await client.readResource({ uri: resources[0].uri });
    resourceRead = {
      attempted: true,
      contentBlocks: Array.isArray(result.contents) ? result.contents.length : 0,
      firstResourceName: String(resources[0].name || ''),
    };
  }
  let toolCall = { attempted: false, contentBlocks: 0, isError: false };
  if (process.env.XHS_MCP_VERIFY_SKIP_TOOL_CALL !== 'true') {
    const safeTool = tools.find((tool) => tool.name === 'task.status')
      || tools.find((tool) => tool.annotations?.readOnlyHint === true);
    if (safeTool?.name) {
      const result = await client.callTool({ name: safeTool.name, arguments: {} });
      toolCall = {
        attempted: true,
        name: String(safeTool.name),
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        isError: result.isError === true,
      };
      if (toolCall.isError) throw new Error(`Read-only MCP tool ${toolCall.name} returned an error result.`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
    service: health.service,
    serverVersion: String(health.version || ''),
    transport: 'streamable-http',
    officialSdkClient: true,
    resourceCount: resources.length,
    toolCount: tools.length,
    resourceRead,
    toolCall,
    durationMs: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  await transport?.terminateSession().catch(() => {});
  await client?.close().catch(() => {});
}

async function resolveToken() {
  const tokenFile = String(process.env.XHS_MCP_TOKEN_FILE || '').trim();
  if (tokenFile) {
    const value = String(await readFile(tokenFile, 'utf8')).trim();
    if (!value) throw new Error('XHS_MCP_TOKEN_FILE is empty.');
    return value;
  }
  const direct = String(process.env.XHS_MCP_TOKEN || '').trim();
  if (direct) return direct;
  throw new Error('Set XHS_MCP_TOKEN_FILE or XHS_MCP_TOKEN before verifying MCP production.');
}

function normalizeEndpoint(value) {
  const url = new URL(String(value || ''));
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!(loopback && url.protocol === 'http:') && url.protocol !== 'https:') {
    throw new Error('XHS_MCP_URL must use HTTPS or loopback HTTP.');
  }
  if (url.username || url.password) throw new Error('XHS_MCP_URL must not contain credentials.');
  if (url.pathname !== '/mcp' || url.search || url.hash) {
    throw new Error('XHS_MCP_URL must target the exact /mcp endpoint without query or fragment.');
  }
  return url;
}
