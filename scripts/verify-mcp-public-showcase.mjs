import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = normalizeEndpoint(process.env.XHS_MCP_URL || 'https://mcp.hegelsalon.com/mcp');
const healthUrl = new URL('/health', endpoint);
const startedAt = Date.now();
let client;

try {
  const browserResponse = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (browserResponse.status !== 200) {
    throw new Error(`Public MCP browser response returned HTTP ${browserResponse.status}.`);
  }
  const browserInfo = await browserResponse.json();
  if (browserInfo?.ok !== true || browserInfo?.mode !== 'anonymous-read-only-showcase') {
    throw new Error('Public MCP browser response did not identify the anonymous showcase.');
  }

  const healthResponse = await fetch(healthUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!healthResponse.ok) throw new Error(`MCP health check returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  if (
    health?.ok !== true
    || health?.service !== 'xiaohongshu-relay-scraper-mcp'
    || health?.publicShowcase?.mode !== 'anonymous-read-only-showcase'
  ) {
    throw new Error('MCP health response did not identify a ready public showcase.');
  }

  const transport = new StreamableHTTPClientTransport(endpoint);
  client = new Client(
    { name: 'xiaohongshu-mcp-public-showcase-verifier', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  const resourceResult = await client.listResources();
  const toolResult = await client.listTools();
  const resources = Array.isArray(resourceResult.resources) ? resourceResult.resources : [];
  const tools = Array.isArray(toolResult.tools) ? toolResult.tools : [];
  const expectedResourceUris = [
    'showcase://today-you-applied/overview',
    'showcase://today-you-applied/capabilities',
    'showcase://today-you-applied/sample-jobs',
  ];
  const expectedToolNames = [
    'showcase.get_overview',
    'showcase.search_sample_jobs',
    'showcase.build_application_plan',
  ];
  assertExact(resources.map((resource) => resource.uri), expectedResourceUris, 'public resource URI');
  assertExact(tools.map((tool) => tool.name), expectedToolNames, 'public tool name');
  if (!tools.every((tool) => tool.annotations?.readOnlyHint === true)) {
    throw new Error('Every public showcase tool must declare readOnlyHint=true.');
  }
  if (resources.some((resource) => String(resource.uri).startsWith('xhs-data://'))) {
    throw new Error('A private xhs-data resource leaked into the public showcase.');
  }
  if (tools.some((tool) => ['artifact.create', 'email.send', 'records.query'].includes(tool.name))) {
    throw new Error('A private or write-capable tool leaked into the public showcase.');
  }

  const sampleResource = await client.readResource({ uri: expectedResourceUris[2] });
  const sampleText = String(sampleResource.contents?.[0]?.text || '');
  if (!sampleText.includes('synthetic-demo-only')) {
    throw new Error('The public sample resource was not marked as synthetic demo data.');
  }
  const search = await client.callTool({
    name: 'showcase.search_sample_jobs',
    arguments: { query: 'AI', city: 'Shanghai', limit: 2 },
  });
  if (search.isError === true || search.structuredContent?.dataClassification !== 'synthetic-demo-only') {
    throw new Error('The public showcase search tool did not return a synthetic success result.');
  }
  const forbiddenCall = await client.callTool({ name: 'artifact.create', arguments: {} });
  if (forbiddenCall.isError !== true) throw new Error('The public showcase accepted a forbidden write tool.');

  const invalidAuthResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer public-verifier-invalid-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(initializeRequest()),
    signal: AbortSignal.timeout(10_000),
  });
  if (invalidAuthResponse.status !== 401) {
    throw new Error(`Invalid Bearer token returned HTTP ${invalidAuthResponse.status} instead of 401.`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
    service: health.service,
    serverVersion: String(health.version || ''),
    mode: browserInfo.mode,
    dataClassification: browserInfo.dataClassification,
    browserGetStatus: browserResponse.status,
    healthStatus: healthResponse.status,
    officialSdkClient: true,
    stateless: true,
    resourceCount: resources.length,
    resourceReadContentBlocks: sampleResource.contents?.length || 0,
    toolCount: tools.length,
    toolCall: {
      name: 'showcase.search_sample_jobs',
      resultCount: Number(search.structuredContent?.total || 0),
      isError: search.isError === true,
    },
    forbiddenWriteToolRejected: forbiddenCall.isError === true,
    invalidBearerStatus: invalidAuthResponse.status,
    durationMs: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  await client?.close().catch(() => {});
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

function assertExact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected ${label} set: ${JSON.stringify(actual)}.`);
  }
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'invalid-auth-verifier', version: '1.0.0' },
    },
  };
}
