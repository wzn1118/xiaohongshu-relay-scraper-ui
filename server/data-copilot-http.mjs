import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

/**
 * Handles only /api/copilot routes. It returns false for unrelated paths so it
 * can be mounted near the top of the existing application request handler.
 */
export async function handleDataCopilotRequest({
  req,
  res,
  url = new URL(req.url || '/', 'http://localhost'),
  service,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (!url.pathname.startsWith('/api/copilot')) return false;
  if (!service) {
    writeError(res, serviceError('COPILOT_SERVICE_UNAVAILABLE', 'Data Copilot is unavailable.', 503));
    return true;
  }

  try {
    const parts = decodePath(url.pathname);
    const method = String(req.method || 'GET').toUpperCase();
    if (parts[0] !== 'api' || parts[1] !== 'copilot') return false;

    if (parts.length === 3 && parts[2] === 'capabilities' && method === 'GET') {
      writeJson(res, 200, service.getCapabilities());
      return true;
    }

    if (parts.length === 3 && parts[2] === 'tools' && method === 'GET') {
      writeJson(res, 200, service.listTools({
        query: url.searchParams.get('query'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'context' && method === 'GET') {
      writeJson(res, 200, await service.listContextRecords({
        jobId: url.searchParams.get('jobId'),
        mode: url.searchParams.get('mode'),
        kind: url.searchParams.get('kind'),
        query: url.searchParams.get('query'),
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'context' && parts[3] === 'jobs' && method === 'GET') {
      writeJson(res, 200, service.listContextJobs({
        query: url.searchParams.get('query'),
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'conversations') {
      if (method === 'GET') {
        const result = await service.listConversations({
          jobId: url.searchParams.get('jobId'),
          mode: url.searchParams.get('mode'),
          limit: url.searchParams.get('limit'),
        });
        writeJson(res, 200, result);
        return true;
      }
      if (method === 'POST') {
        const result = await service.createConversation(await readJsonBody(req, maxBodyBytes));
        writeJson(res, 201, result);
        return true;
      }
    }

    if (parts[2] === 'conversations' && parts[3]) {
      const conversationId = parts[3];
      if (parts.length === 4 && method === 'GET') {
        writeJson(res, 200, await service.getConversation(conversationId));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'messages') {
        if (method === 'GET') {
          writeJson(res, 200, await service.listMessages(conversationId, {
            afterSequence: url.searchParams.get('afterSequence'),
            limit: url.searchParams.get('limit'),
          }));
          return true;
        }
        if (method === 'POST') {
          const result = await service.sendMessage(conversationId, await readJsonBody(req, maxBodyBytes));
          writeJson(res, 202, result);
          return true;
        }
      }
      if (parts.length === 5 && parts[4] === 'events' && method === 'GET') {
        await openEventStream(req, res, service, conversationId);
        return true;
      }
      if (parts.length === 5 && parts[4] === 'mcp' && method === 'POST') {
        const result = await service.handleMcpRequest(
          conversationId,
          await readJsonBody(req, maxBodyBytes),
        );
        if (result === null) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
        } else {
          writeJson(res, 200, result);
        }
        return true;
      }
      if (parts.length === 5 && parts[4] === 'cancel' && method === 'POST') {
        writeJson(res, 200, await service.cancel(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'retry' && method === 'POST') {
        writeJson(res, 202, await service.retry(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'attachments' && method === 'POST') {
        const result = await service.uploadAttachment(conversationId, req, {
          idempotencyKey: header(req, 'idempotency-key') || undefined,
        });
        writeJson(res, 201, result);
        return true;
      }
      if (
        parts.length === 6
        && parts[4] === 'attachments'
        && ['GET', 'HEAD'].includes(method)
      ) {
        const resolved = await service.resolveAttachment(conversationId, parts[5]);
        await sendStoredFile(req, res, resolved.attachment, resolved.absolutePath, 'attachment');
        return true;
      }
      if (
        parts.length === 6
        && ['artifact', 'artifacts'].includes(parts[4])
        && ['GET', 'HEAD'].includes(method)
      ) {
        await sendArtifact(req, res, service, conversationId, parts[5]);
        return true;
      }
      if (
        parts.length === 7
        && parts[4] === 'approvals'
        && parts[6] === 'confirm'
        && method === 'POST'
      ) {
        const result = await service.confirmApproval(
          conversationId,
          parts[5],
          await readJsonBody(req, maxBodyBytes),
        );
        writeJson(res, result.run ? 202 : 200, result);
        return true;
      }
    }

    writeJson(res, 404, {
      error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Data Copilot endpoint was not found.' },
    });
    return true;
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return true;
    }
    writeError(res, error);
    return true;
  }
}

export async function readDataCopilotJsonBody(request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  return readJsonBody(request, maxBodyBytes);
}

async function openEventStream(req, res, service, conversationId) {
  const details = await service.getConversation(conversationId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  const write = (event) => {
    if (closed || res.destroyed || res.writableEnded) return;
    const type = String(event.type || 'message').replace(/[^A-Za-z0-9_.-]/gu, '_');
    res.write(`id: ${Number(event.eventId || 0)}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const requestedEventId = Number(
    header(req, 'last-event-id')
    || new URL(req.url || '/', 'http://localhost').searchParams.get('afterEventId')
    || 0,
  );
  const afterEventId = Number.isSafeInteger(requestedEventId) && requestedEventId > 0 ? requestedEventId : 0;
  const unsubscribe = service.subscribe(conversationId, write, { afterEventId });
  res.write(`event: ready\ndata: ${JSON.stringify({
    type: 'ready',
    conversationId,
    status: details.conversation.status,
    lastSequences: details.conversation.lastSequences,
  })}\n\n`);
  const heartbeat = setInterval(() => {
    if (!closed && !res.destroyed && !res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.once('aborted', close);
  res.once('close', close);
}

async function sendArtifact(req, res, service, conversationId, artifactId) {
  const { artifact, absolutePath } = await service.resolveArtifact(conversationId, artifactId);
  await sendStoredFile(req, res, artifact, absolutePath, 'artifact');
}

async function sendStoredFile(req, res, record, absolutePath, fallbackPrefix) {
  const displayName = record.displayName || `${fallbackPrefix}.${record.extension || 'bin'}`;
  const fallback = asciiDownloadName(displayName);
  res.writeHead(200, {
    'Content-Type': record.mediaType || 'application/octet-stream',
    'Content-Length': String(record.size),
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(displayName)}`,
    'Cache-Control': 'private, no-store',
    ETag: `"sha256-${record.sha256}"`,
  });
  if (String(req.method).toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(absolutePath), res);
}

async function readJsonBody(req, maxBodyBytes) {
  const maximum = boundedMaximum(maxBodyBytes);
  const declared = Number(header(req, 'content-length') || 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw serviceError('COPILOT_BODY_TOO_LARGE', 'Request body is too large.', 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximum) throw serviceError('COPILOT_BODY_TOO_LARGE', 'Request body is too large.', 413);
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw serviceError('COPILOT_JSON_INVALID', 'Request body must contain valid JSON.', 400, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw serviceError('COPILOT_JSON_INVALID', 'Request body must be a JSON object.');
  }
  return parsed;
}

function writeJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function writeError(res, error) {
  const status = Number.isInteger(Number(error?.status))
    ? Math.min(599, Math.max(400, Number(error.status)))
    : 500;
  writeJson(res, status, {
    error: {
      code: String(error?.code || 'COPILOT_INTERNAL_ERROR'),
      message: status >= 500 && !error?.code
        ? 'Data Copilot request failed.'
        : String(error?.message || 'Data Copilot request failed.'),
    },
  });
}

function decodePath(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch (error) {
    throw serviceError('COPILOT_PATH_INVALID', 'Request path is invalid.', 400, error);
  }
}

function header(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function asciiDownloadName(value) {
  const name = String(value || 'artifact.bin')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 160)
    .trim();
  return name || 'artifact.bin';
}

function boundedMaximum(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1024 ? number : DEFAULT_MAX_BODY_BYTES;
}

function serviceError(code, message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = status;
  return error;
}
