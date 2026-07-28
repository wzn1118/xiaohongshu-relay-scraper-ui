import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { assertPathInside, enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';
import { ValidationError, validateRunRequest } from './lib/contracts.mjs';
import { probeRelay } from './lib/relay.mjs';

const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/;

export function createApp({ manager, config, aiSessions, profileStore }) {
  return async function app(req, res) {
    setSecurityHeaders(res);
    if (req.method === 'OPTIONS') return noContent(res);
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'xiaohongshu-relay-scraper',
          version: '3.0.0',
          runnerAvailable: config.runnerAvailable,
          timestamp: new Date().toISOString(),
          pid: process.pid,
          host: config.host,
          port: config.port,
          activeJob: manager.active?.id || null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/relay/status') {
        const requested = url.searchParams.get('port');
        const port = requested === null ? 18800 : Number(requested);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        const status = await probeRelay({ port, openClawConfigPath: config.openClawConfigPath });
        return json(res, status.ok ? 200 : 503, status);
      }
      if (req.method === 'GET' && url.pathname === '/api/ai/providers') return json(res, 200, aiSessions.providers());
      if (req.method === 'POST' && url.pathname === '/api/ai/sessions') {
        return json(res, 201, aiSessions.create(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'ai' && parts[2] === 'sessions' && parts[3]) {
        return json(res, aiSessions.delete(parts[3]) ? 200 : 404, { deleted: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/profiles') return json(res, 200, await profileStore.list());
      if (req.method === 'POST' && url.pathname === '/api/profiles/import') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const session = aiSessions.resolve(body.aiSessionId);
        return json(res, 201, await profileStore.create(body, session));
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, manager.list());
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const job = await manager.start(validateRunRequest(body));
        return json(res, 202, job);
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
        const id = parts[2];
        if (!JOB_ID.test(id)) return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        const internal = manager.getInternal(id);
        if (!internal) return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, manager.get(id));
        if (req.method === 'POST' && parts[3] === 'cancel' && parts.length === 4) {
          const result = await manager.cancel(id);
          return json(res, 202, { ...result.job, cancelRequested: result.changed });
        }
        if (req.method === 'GET' && parts[3] === 'events' && parts.length === 4) return streamEvents(req, res, manager, id);
        if (req.method === 'GET' && parts[3] === 'logs' && parts.length === 4) {
          const maxBytes = 256 * 1024;
          try {
            const content = await readFile(internal.logPath, 'utf8');
            return json(res, 200, { log: content.slice(-maxBytes), truncated: content.length > maxBytes });
          } catch (error) {
            if (error.code === 'ENOENT') return json(res, 200, { log: '', truncated: false });
            throw error;
          }
        }
        if (req.method === 'GET' && parts[3] === 'results' && parts.length === 4) {
          return json(res, 200, await readApplicationResults(internal.outputDir, url.searchParams));
        }
        if (req.method === 'POST' && parts[3] === 'delivery' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await updateDeliveryState(internal.outputDir, body));
        }
        if (req.method === 'GET' && parts[3] === 'artifacts' && parts.length === 4) {
          return json(res, 200, await enumerateArtifacts(internal.outputDir));
        }
        if (req.method === 'GET' && parts[3] === 'artifacts' && parts[4] && parts.length === 5) {
          const file = await resolveDownload(internal.outputDir, parts[4]);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': file.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.relative))}`,
          });
          return createReadStream(file.absolute).pipe(res);
        }
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, errorBody('NOT_FOUND', 'Endpoint not found.'));
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveSpa(req, res, config.staticDir, url.pathname)) return;
      return json(res, 404, errorBody('NOT_FOUND', 'Endpoint not found.'));
    } catch (error) {
      if (error instanceof ValidationError) return json(res, 400, errorBody('VALIDATION_ERROR', error.message, error.details));
      if (error.code === 'JOB_BUSY') return json(res, 409, { ...errorBody('JOB_BUSY', error.message), activeJob: error.activeJob });
      if (error.code === 'RESUME_SOURCE_NOT_FOUND' || error.code === 'RESUME_CHECKPOINTS_MISSING') {
        return json(res, 400, errorBody(error.code, error.message));
      }
      if (error.code === 'BODY_TOO_LARGE') return json(res, 413, errorBody('BODY_TOO_LARGE', 'Request body is too large.'));
      if (['AI_VALIDATION', 'PROFILE_VALIDATION'].includes(error.code)) return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'PROFILE_NOT_FOUND') return json(res, 404, errorBody(error.code, error.message));
      if (error.code === 'PROFILE_IMPORT_FAILED') return json(res, 422, errorBody(error.code, error.message));
      if (error instanceof SyntaxError) return json(res, 400, errorBody('INVALID_JSON', 'Request body must contain valid JSON.'));
      if (error.code === 'ENOENT' || /artifact/i.test(error.message) || /Path escapes/.test(error.message)) {
        return json(res, 404, errorBody('ARTIFACT_NOT_FOUND', 'Artifact not found.'));
      }
      console.error(error);
      return json(res, 500, errorBody('INTERNAL_ERROR', 'Unexpected server error.'));
    }
  };
}

async function readApplicationResults(outputDir, searchParams) {
  const offset = boundedInteger(searchParams.get('offset'), 0, 0, 1000000);
  const limit = boundedInteger(searchParams.get('limit'), 50, 1, 100);
  const query = String(searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN').slice(0, 100);
  try {
    const payload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
    const delivery = await readDeliveryState(outputDir);
    const source = Array.isArray(payload.records)
      ? payload.records.map((record) => ({ ...record, delivery: delivery[record.note_id] || null }))
      : [];
    const records = query
      ? source.filter((record) => `${record.title || ''}\n${record.body || ''}`.toLocaleLowerCase('zh-CN').includes(query))
      : source;
    return {
      available: true,
      total: records.length,
      offset,
      limit,
      items: records.slice(offset, offset + limit),
      codexRuntime: payload.ai_workflow || payload.codex_runtime || null,
      qualityGate: payload.quality_gate || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, total: 0, offset, limit, items: [], codexRuntime: null, qualityGate: null };
    throw error;
  }
}

async function readDeliveryState(outputDir) {
  try {
    const value = JSON.parse(await readFile(path.join(outputDir, 'delivery-state.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function updateDeliveryState(outputDir, value) {
  const noteId = String(value?.noteId || '').trim();
  const action = String(value?.action || '').trim();
  if (!/^[\p{L}\p{N}_.:-]{1,160}$/u.test(noteId)) throw new ValidationError('Invalid noteId.');
  if (!['ready_to_apply', 'ready_to_message', 'applied', 'messaged', 'reset'].includes(action)) {
    throw new ValidationError('Invalid delivery action.');
  }
  const state = await readDeliveryState(outputDir);
  if (action === 'reset') delete state[noteId];
  else state[noteId] = { action, updatedAt: new Date().toISOString() };
  const target = path.join(outputDir, 'delivery-state.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, target);
  return { noteId, delivery: state[noteId] || null };
}

function boundedInteger(raw, fallback, min, max) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function streamEvents(req, res, manager, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  writeEvent(res, 'snapshot', { type: 'snapshot', job: manager.get(id) });
  const unsubscribe = manager.subscribe(id, ({ type, data }) => {
    if (type === 'log') {
      const level = data.stream === 'stderr' ? 'error' : data.stream === 'system' ? 'info' : 'info';
      return writeEvent(res, 'log', { type: 'log', line: data.message, level });
    }
    if (type === 'state') return writeEvent(res, 'status', { type: 'status', job: data });
    if (type === 'end') return writeEvent(res, 'done', { type: 'done', job: manager.get(id) });
  });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('Request body is too large.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function noContent(res) {
  res.writeHead(204);
  res.end();
}

function errorBody(code, message, details) {
  return { message, error: { code, message, ...(details?.length ? { details } : {}) } };
}

async function serveSpa(req, res, staticDir, pathname) {
  if (!staticDir) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded.replace(/^\/+/, '').replaceAll('/', path.sep);
  const requested = path.resolve(staticDir, relative || 'index.html');
  try {
    assertPathInside(staticDir, requested);
  } catch {
    return false;
  }

  let file = await safeStaticFile(staticDir, requested);
  if (!file && !path.extname(relative)) file = await safeStaticFile(staticDir, path.join(staticDir, 'index.html'));
  if (!file) return false;
  const cacheControl = /[\\/]assets[\\/]/.test(file.absolute)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': mimeType(file.absolute),
    'Content-Length': file.size,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file.absolute).pipe(res);
  return true;
}

async function safeStaticFile(root, candidate) {
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(candidate)]);
    assertPathInside(rootReal, targetReal);
    const info = await stat(targetReal);
    return info.isFile() ? { absolute: targetReal, size: info.size } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || /Path escapes/.test(error.message)) return null;
    throw error;
  }
}

function mimeType(file) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
