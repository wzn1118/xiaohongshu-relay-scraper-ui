import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createPublicShowcaseService } from './mcp-public-showcase.mjs';

const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
const SERVER_INFO = Object.freeze({ name: 'xiaohongshu-relay-scraper-mcp', version: PACKAGE_VERSION });

export function createMcpHttpGateway({ accessService, config, diagnostics } = {}) {
  if (!accessService) throw new TypeError('MCP access service is required.');
  const transports = new Map();
  const publicShowcaseEnabled = config?.mcpPublicShowcaseEnabled === true;
  const publicShowcase = publicShowcaseEnabled
    ? createPublicShowcaseService({
      version: PACKAGE_VERSION,
      appUrl: config?.authOrigin || '',
      endpoint: config?.mcpPublicOrigin
        ? `${String(config.mcpPublicOrigin).replace(/\/+$/u, '')}/mcp`
        : `http://${config?.mcpHost || '127.0.0.1'}:${Number(config?.mcpPort) || 4328}/mcp`,
    })
    : null;
  const maximumBodyBytes = Number(config?.mcpMaxBodyBytes) || 1024 * 1024;
  const publicShowcaseMaximumBodyBytes = Math.min(
    maximumBodyBytes,
    Number(config?.mcpPublicShowcaseMaxBodyBytes) || 64 * 1024,
  );
  const publicShowcaseLimiter = publicShowcaseEnabled
    ? createPublicShowcaseLimiter({
      maxCallsPerMinute: Number(config?.mcpPublicShowcaseMaxCallsPerMinute) || 60,
      maxConcurrentRequests: Number(config?.mcpPublicShowcaseMaxConcurrentRequests) || 4,
    })
    : null;
  const maximumSessions = Number(config?.mcpMaxSessions) || 20;
  const maximumSessionsPerGrant = Number(config?.mcpMaxSessionsPerGrant) || 4;
  const sessionIdleMs = (Number(config?.mcpSessionIdleSeconds) || 1800) * 1000;
  let pendingSessions = 0;
  const pendingByGrant = new Map();

  const sweepIdleSessions = async () => {
    const cutoff = Date.now() - sessionIdleMs;
    const idle = [...transports.entries()].filter(([, entry]) => entry.lastSeenAt <= cutoff);
    for (const [sessionId, entry] of idle) {
      transports.delete(sessionId);
      await Promise.resolve(entry.transport.close()).catch(() => {});
      closePersistedSession(accessService, entry.context, sessionId);
      diagnostics?.record?.('mcp_session_idle_closed', { status: 'completed', sessionId });
    }
  };
  const idleTimer = setInterval(() => {
    sweepIdleSessions().catch((error) => diagnostics?.record?.('mcp_session_sweep_failed', {
      status: 'failed', code: String(error?.code || 'MCP_SESSION_SWEEP_FAILED'),
    }));
  }, Math.min(60_000, Math.max(5_000, Math.floor(sessionIdleMs / 2))));
  idleTimer.unref?.();

  const reserveSession = (grantId) => {
    const activeForGrant = [...transports.values()].filter((entry) => entry.grantId === grantId).length;
    const pendingForGrant = pendingByGrant.get(grantId) || 0;
    if (transports.size + pendingSessions >= maximumSessions || activeForGrant + pendingForGrant >= maximumSessionsPerGrant) {
      throw gatewayError('MCP_RATE_LIMITED', 'The MCP session concurrency limit was reached.', 429);
    }
    pendingSessions += 1;
    pendingByGrant.set(grantId, pendingForGrant + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingSessions = Math.max(0, pendingSessions - 1);
      const remaining = Math.max(0, (pendingByGrant.get(grantId) || 1) - 1);
      if (remaining) pendingByGrant.set(grantId, remaining);
      else pendingByGrant.delete(grantId);
    };
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    setHeaders(res);
    const securityError = validateRequestBoundary(req, config);
    if (securityError) return writeRpcError(res, securityError.status, -32003, securityError.message);
    if (url.pathname === '/health' && req.method === 'GET') {
      return writeJson(res, 200, {
        ...accessService.status(),
        publicShowcase: publicShowcase?.status() || { enabled: false },
        version: PACKAGE_VERSION,
        timestamp: new Date().toISOString(),
      });
    }
    if (url.pathname !== '/mcp') return writeRpcError(res, 404, -32004, 'MCP endpoint was not found.');
    if (!['GET', 'POST', 'DELETE'].includes(String(req.method || '').toUpperCase())) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return writeRpcError(res, 405, -32005, 'MCP method is not allowed.');
    }

    let context;
    try {
      const authorization = header(req, 'authorization').trim();
      if (publicShowcase && !authorization) {
        const sessionId = header(req, 'mcp-session-id').trim();
        if (sessionId) {
          return writeRpcError(
            res,
            400,
            -32000,
            'Mcp-Session-Id is not accepted by the stateless public showcase.',
            'MCP_PUBLIC_SESSION_UNSUPPORTED',
          );
        }
        if (req.method === 'GET') {
          if (header(req, 'accept').toLowerCase().includes('text/event-stream')) {
            res.setHeader('Allow', 'POST');
            return writeRpcError(
              res,
              405,
              -32005,
              'The stateless public showcase accepts MCP requests over POST.',
              'MCP_PUBLIC_METHOD_NOT_ALLOWED',
            );
          }
          return writeJson(res, 200, publicShowcase.describe());
        }
        if (req.method === 'DELETE') {
          res.setHeader('Allow', 'GET, POST');
          return writeRpcError(
            res,
            405,
            -32005,
            'The stateless public showcase does not create sessions to delete.',
            'MCP_PUBLIC_METHOD_NOT_ALLOWED',
          );
        }

        const releaseRequest = publicShowcaseLimiter.enter(req);
        try {
          const body = await readJsonBody(req, publicShowcaseMaximumBodyBytes);
          await handlePublicShowcaseRequest({
            req,
            res,
            body,
            service: publicShowcase,
            config,
            diagnostics,
          });
        } finally {
          releaseRequest();
        }
        return;
      }

      context = await accessService.authenticateRequest(req);
      const sessionId = header(req, 'mcp-session-id');
      let entry = sessionId ? transports.get(sessionId) : null;

      if (sessionId) {
        if (!entry || entry.grantId !== context.grant.grantId) {
          return writeRpcError(res, 404, -32001, 'MCP session is invalid for this Grant.');
        }
        accessService.touchSession(context, sessionId);
        entry.lastSeenAt = Date.now();
        entry.context = context;
      } else if (req.method === 'POST') {
        const body = await readJsonBody(req, maximumBodyBytes);
        if (!isInitializeRequest(body)) {
          return writeRpcError(res, 400, -32000, 'An initialize request is required to create an MCP session.');
        }
        await sweepIdleSessions();
        const releaseReservation = reserveSession(context.grant.grantId);
        try {
          entry = await createSession({ body, context, accessService, transports, config, diagnostics });
          await entry.transport.handleRequest(req, res, body);
        } finally {
          releaseReservation();
        }
        return;
      } else {
        return writeRpcError(res, 400, -32000, 'Mcp-Session-Id is required.');
      }

      await entry.transport.handleRequest(req, res);
    } catch (error) {
      diagnostics?.record?.('mcp_request_failed', {
        status: 'failed',
        code: String(error?.code || 'MCP_REQUEST_FAILED'),
      });
      if (!res.headersSent) {
        writeRpcError(
          res,
          Number(error?.status) || 500,
          -32000,
          String(error?.message || 'MCP request failed.'),
          String(error?.code || 'MCP_REQUEST_FAILED'),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };

  return {
    handler,
    activeSessionCount: () => transports.size,
    async close() {
      clearInterval(idleTimer);
      const active = [...transports.values()];
      transports.clear();
      await Promise.allSettled(active.map(async (entry) => {
        await entry.transport.close();
        if (entry.transport.sessionId) closePersistedSession(accessService, entry.context, entry.transport.sessionId);
      }));
    },
  };
}

async function createSession({ body, context, accessService, transports, config, diagnostics }) {
  let transport;
  const server = createSdkServer(context, accessService, () => transport?.sessionId);
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      transports.set(sessionId, {
        transport,
        server,
        grantId: context.grant.grantId,
        context,
        lastSeenAt: Date.now(),
      });
      accessService.registerSession(context, sessionId, body?.params?.clientInfo || {});
      diagnostics?.record?.('mcp_session_opened', { status: 'completed', sessionId });
    },
    onsessionclosed: (sessionId) => {
      transports.delete(sessionId);
      closePersistedSession(accessService, context, sessionId);
    },
    allowedHosts: allowedHosts(config),
    allowedOrigins: [],
    enableDnsRebindingProtection: true,
  });
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (!sessionId) return;
    transports.delete(sessionId);
    closePersistedSession(accessService, context, sessionId);
  };
  transport.onerror = (error) => diagnostics?.record?.('mcp_transport_error', {
    status: 'failed', code: String(error?.code || 'MCP_TRANSPORT_ERROR'),
  });
  await server.connect(transport);
  return { transport, server, grantId: context.grant.grantId };
}

async function handlePublicShowcaseRequest({ req, res, body, service, config, diagnostics }) {
  const server = createSdkServer({}, service, () => '', service.instructions);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts: allowedHosts(config),
    allowedOrigins: [],
    enableDnsRebindingProtection: true,
  });
  transport.onerror = (error) => diagnostics?.record?.('mcp_public_transport_error', {
    status: 'failed', code: String(error?.code || 'MCP_PUBLIC_TRANSPORT_ERROR'),
  });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, body);
  } finally {
    await Promise.resolve(transport.close()).catch(() => {});
    await Promise.resolve(server.close()).catch(() => {});
  }
}

function createSdkServer(
  context,
  provider,
  sessionId,
  instructions = 'All resources and tools are restricted to the Grant-bound conversation snapshot and declared scopes.',
) {
  const server = new Server(SERVER_INFO, {
    capabilities: { resources: { listChanged: false }, tools: { listChanged: false } },
    instructions,
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await provider.listResources(context),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => (
    provider.readResource(context, request.params.uri)
  ));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await provider.listTools(context),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await provider.executeTool(
        context,
        request.params.name,
        request.params.arguments || {},
        {
          sessionId: sessionId() || extra.sessionId || '',
          requestId: String(extra.requestId),
          idempotencyKey: request.params?._meta?.idempotencyKey,
        },
      );
      return toolResult(result, false);
    } catch (error) {
      return toolResult({
        error: {
          code: String(error?.code || 'MCP_TOOL_FAILED'),
          message: String(error?.message || 'MCP tool call failed.'),
        },
      }, true);
    }
  });
  return server;
}

function createPublicShowcaseLimiter({ maxCallsPerMinute, maxConcurrentRequests }) {
  const entries = new Map();
  const windowMs = 60_000;
  const staleMs = 2 * windowMs;
  const maximumEntries = 2048;

  const prune = (now) => {
    for (const [key, entry] of entries) {
      if (entry.active === 0 && now - entry.windowStartedAt >= staleMs) entries.delete(key);
    }
    if (entries.size < maximumEntries) return;
    const inactive = [...entries.entries()]
      .filter(([, entry]) => entry.active === 0)
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
    while (entries.size >= maximumEntries && inactive.length) {
      entries.delete(inactive.shift()[0]);
    }
  };

  return {
    enter(req) {
      const now = Date.now();
      prune(now);
      const source = header(req, 'cf-connecting-ip').split(',')[0].trim()
        || String(req?.socket?.remoteAddress || 'unknown');
      const key = crypto.createHash('sha256').update(source).digest('hex');
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maximumEntries) {
          throw gatewayError('MCP_PUBLIC_RATE_LIMITED', 'The public showcase is at capacity.', 429);
        }
        entry = { windowStartedAt: now, calls: 0, active: 0, lastSeenAt: now };
        entries.set(key, entry);
      } else if (now - entry.windowStartedAt >= windowMs) {
        entry.windowStartedAt = now;
        entry.calls = 0;
      }
      entry.lastSeenAt = now;
      if (entry.calls >= maxCallsPerMinute) {
        throw gatewayError('MCP_PUBLIC_RATE_LIMITED', 'The public showcase request limit was reached.', 429);
      }
      entry.calls += 1;
      if (entry.active >= maxConcurrentRequests) {
        throw gatewayError('MCP_PUBLIC_CONCURRENCY_LIMITED', 'The public showcase concurrency limit was reached.', 429);
      }
      entry.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.active = Math.max(0, entry.active - 1);
        entry.lastSeenAt = Date.now();
      };
    },
  };
}

function toolResult(value, isError) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent,
    isError,
  };
}

function closePersistedSession(accessService, context, sessionId) {
  try {
    const session = accessService.productionStore.getMcpSession(sessionId);
    if (session?.status === 'active') accessService.closeSession(context, sessionId);
  } catch {
    // Session closure is best-effort after the transport has already ended.
  }
}

function validateRequestBoundary(req, config) {
  if (header(req, 'origin')) {
    return { status: 403, message: 'Browser-origin MCP requests are not accepted.' };
  }
  const host = header(req, 'host').toLowerCase();
  if (!allowedHosts(config).map((value) => value.toLowerCase()).includes(host)) {
    return { status: 403, message: 'MCP Host header is not allowed.' };
  }
  const publicHost = String(config?.mcpPublicHost || '').toLowerCase();
  if (publicHost && host === publicHost) {
    const forwardedProto = header(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
    if (forwardedProto !== 'https') {
      return { status: 403, message: 'Public MCP requests must arrive through an HTTPS reverse proxy.' };
    }
    if (config?.mcpRequireCloudflareHeaders) {
      if (!header(req, 'cf-ray') || !header(req, 'cf-connecting-ip')) {
        return { status: 403, message: 'Public MCP requests must arrive through the configured Cloudflare Tunnel.' };
      }
    }
  }
  return null;
}

function allowedHosts(config) {
  const port = Number(config?.mcpPort) || 4328;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const publicHost = String(config?.mcpPublicHost || '').trim();
  if (publicHost) hosts.push(publicHost);
  return hosts;
}

async function readJsonBody(req, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw gatewayError('MCP_BODY_TOO_LARGE', 'MCP request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) throw gatewayError('MCP_BODY_REQUIRED', 'MCP request body is required.', 400);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw gatewayError('MCP_BODY_INVALID', 'MCP request body must be valid JSON.', 400);
  }
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function writeRpcError(res, status, rpcCode, message, applicationCode = 'MCP_HTTP_ERROR') {
  return writeJson(res, status, {
    jsonrpc: '2.0',
    error: { code: rpcCode, message, data: { code: applicationCode, status } },
    id: null,
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function header(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function gatewayError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
