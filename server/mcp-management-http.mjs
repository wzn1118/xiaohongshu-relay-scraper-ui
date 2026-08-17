const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Cookie-authenticated MCP control plane. The MCP data plane is served by the
 * dedicated loopback listener and never accepts browser session cookies.
 */
export async function handleMcpManagementRequest({
  req,
  res,
  url = new URL(req.url || '/', 'http://localhost'),
  service,
  actor,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (!url.pathname.startsWith('/api/mcp')) return false;
  if (!service) {
    writeError(res, managementError('MCP_SERVICE_UNAVAILABLE', 'MCP access management is unavailable.', 503));
    return true;
  }

  try {
    const method = String(req.method || 'GET').toUpperCase();
    const parts = decodePath(url.pathname);
    if (parts[0] !== 'api' || parts[1] !== 'mcp') return false;

    if (parts.length === 3 && parts[2] === 'status' && method === 'GET') {
      writeJson(res, 200, service.status());
      return true;
    }
    if (parts.length === 3 && parts[2] === 'capabilities' && method === 'GET') {
      writeJson(res, 200, await service.getCapabilities(url.searchParams.get('conversationId') || '', actor));
      return true;
    }
    if (parts.length === 3 && parts[2] === 'grants' && method === 'GET') {
      writeJson(res, 200, service.listGrants(actor, { limit: queryLimit(url) }));
      return true;
    }
    if (parts.length === 3 && parts[2] === 'grants' && method === 'POST') {
      writeJson(res, 201, await service.createGrant(await readJsonBody(req, maxBodyBytes), actor));
      return true;
    }
    if (parts.length === 4 && parts[2] === 'grants' && method === 'DELETE') {
      writeJson(res, 200, service.revokeGrant(parts[3], actor));
      return true;
    }
    if (parts.length === 4 && parts[2] === 'grants' && method === 'GET') {
      writeJson(res, 200, service.getGrant(parts[3], actor));
      return true;
    }
    if (parts.length === 5 && parts[2] === 'grants' && parts[4] === 'revoke' && method === 'POST') {
      writeJson(res, 200, service.revokeGrant(parts[3], actor));
      return true;
    }
    if (parts.length === 5 && parts[2] === 'grants' && parts[4] === 'rotate' && method === 'POST') {
      writeJson(res, 201, await service.rotateGrant(parts[3], await readJsonBody(req, maxBodyBytes), actor));
      return true;
    }
    if (parts.length === 5 && parts[2] === 'grants' && parts[4] === 'rebind' && method === 'POST') {
      writeJson(res, 201, await service.rebindGrant(parts[3], await readJsonBody(req, maxBodyBytes), actor));
      return true;
    }
    if (parts.length === 5 && parts[2] === 'grants' && parts[4] === 'audit' && method === 'GET') {
      writeJson(res, 200, service.listGrantAudit(parts[3], actor, { limit: queryLimit(url) }));
      return true;
    }
    if (parts.length === 3 && parts[2] === 'sessions' && method === 'GET') {
      writeJson(res, 200, service.listSessions(actor, {
        grantId: url.searchParams.get('grantId') || '',
        limit: queryLimit(url),
      }));
      return true;
    }
    if (parts.length === 3 && parts[2] === 'tool-runs' && method === 'GET') {
      writeJson(res, 200, service.listToolRuns(actor, {
        grantId: url.searchParams.get('grantId') || '',
        status: url.searchParams.get('status') || '',
        limit: queryLimit(url),
      }));
      return true;
    }
    if (parts.length === 3 && parts[2] === 'audit' && method === 'GET') {
      writeJson(res, 200, service.listAudit(actor, {
        grantId: url.searchParams.get('grantId') || '',
        limit: queryLimit(url),
      }));
      return true;
    }
    if (parts.length === 5 && parts[2] === 'approvals' && parts[4] === 'decision' && method === 'POST') {
      writeJson(res, 200, await service.decideApproval(
        parts[3],
        await readJsonBody(req, maxBodyBytes),
        actor,
      ));
      return true;
    }

    writeError(res, managementError('MCP_ROUTE_NOT_FOUND', 'MCP management route was not found.', 404));
    return true;
  } catch (error) {
    writeError(res, error);
    return true;
  }
}

function queryLimit(url) {
  const value = Number(url.searchParams.get('limit') || 100);
  return Number.isSafeInteger(value) ? Math.min(500, Math.max(1, value)) : 100;
}

async function readJsonBody(req, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw managementError('MCP_BODY_TOO_LARGE', 'MCP request body is too large.', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('object required');
    return value;
  } catch {
    throw managementError('MCP_BODY_INVALID', 'MCP request body must be a JSON object.', 400);
  }
}

function decodePath(pathname) {
  try {
    return String(pathname || '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw managementError('MCP_PATH_INVALID', 'MCP request path is invalid.', 400);
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function writeError(res, error) {
  writeJson(res, Number(error?.status) || 500, {
    error: {
      code: String(error?.code || 'MCP_MANAGEMENT_FAILED'),
      message: String(error?.message || 'MCP management request failed.'),
    },
  });
}

function managementError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
