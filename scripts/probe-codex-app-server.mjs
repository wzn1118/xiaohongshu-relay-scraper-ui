#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, '..');
const protocolVersion = process.env.XHS_CODEX_PROTOCOL_VERSION || '0.147.0-alpha.6.6';
const probeRoot = path.resolve(
  process.env.XHS_CODEX_PROBE_DIR
    || path.join(workspaceRoot, 'output', 'codex-web-runtime-probe', protocolVersion),
);
const runtimeRoot = path.resolve(
  process.env.XHS_CODEX_DESKTOP_RUNTIME_DIR
    || path.join(workspaceRoot, 'output', 'codex-desktop-runtime-55d9fb967596'),
);
const executablePath = path.resolve(
  process.env.XHS_CODEX_EXECUTABLE
    || path.join(runtimeRoot, 'app', 'resources', 'codex.exe'),
);
const sqliteHome = path.join(probeRoot, 'live-sqlite');
const reportPath = path.join(probeRoot, 'live-probe.json');
const port = await reservePort();
const endpoint = `ws://127.0.0.1:${port}`;
const startedAt = Date.now();
const stderr = [];

await mkdir(sqliteHome, { recursive: true });

const child = spawn(executablePath, [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--listen',
  endpoint,
], {
  cwd: workspaceRoot,
  env: {
    ...process.env,
    CODEX_SQLITE_HOME: sqliteHome,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stderr.on('data', (chunk) => {
  stderr.push(...String(chunk).split(/\r?\n/u).filter(Boolean));
  if (stderr.length > 100) stderr.splice(0, stderr.length - 100);
});

let socket;
let nextId = 1;
const pending = new Map();

try {
  socket = await connectWithRetry(endpoint, child);
  socket.on('message', (data) => handleMessage(JSON.parse(String(data))));

  const initialize = await request('initialize', {
    clientInfo: { name: 'codex-web-runtime-probe', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));

  const probes = [];
  for (const candidate of [
    ['thread/list', { limit: 3, useStateDbOnly: true }],
    ['model/list', { limit: 10 }],
    ['skills/list', { cwds: [workspaceRoot], forceReload: false }],
    ['mcpServerStatus/list', { limit: 20, detail: 'toolsAndAuthOnly' }],
    ['plugin/list', { cwds: [workspaceRoot], forceRefetch: false, marketplaceKinds: ['local'] }],
  ]) {
    probes.push(await probe(candidate[0], candidate[1]));
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    protocolVersion,
    transport: {
      kind: 'websocket',
      endpoint,
      loopbackOnly: true,
      processPid: child.pid,
      sqliteIsolation: sqliteHome,
    },
    initialization: {
      ok: true,
      resultShape: summarizeShape(initialize),
    },
    probes,
    elapsedMs: Date.now() - startedAt,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
} catch (error) {
  const detail = stderr.slice(-10).join('\n');
  throw new Error(`${error?.message || error}${detail ? `\napp-server stderr:\n${detail}` : ''}`);
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error('Probe terminated.'));
  }
  pending.clear();
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'probe complete');
  if (!child.killed) child.kill();
}

async function probe(method, params) {
  const before = Date.now();
  try {
    const result = await request(method, params);
    return {
      method,
      status: 'pass',
      latencyMs: Date.now() - before,
      resultShape: summarizeShape(result),
    };
  } catch (error) {
    return {
      method,
      status: 'fail',
      latencyMs: Date.now() - before,
      errorCode: error?.code ?? null,
      errorMessage: String(error?.message || error).slice(0, 300),
    };
  }
}

function request(method, params) {
  const id = `probe-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 30_000);
    pending.set(id, { method, resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function handleMessage(message) {
  if (message?.id != null && message?.method == null) {
    const id = String(message.id);
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(id);
    if (message.error) {
      const error = new Error(message.error.message || `${entry.method} failed.`);
      error.code = message.error.code;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
    return;
  }
  if (message?.id != null && typeof message?.method === 'string') {
    socket.send(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: 'Read-only probe does not implement server requests.' },
    }));
  }
}

function summarizeShape(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (typeof value !== 'object') return { type: typeof value };
  const keys = Object.keys(value).sort();
  const shape = { type: 'object', keys };
  if (depth >= 1) return shape;
  const collections = {};
  for (const key of keys) {
    if (Array.isArray(value[key])) collections[key] = value[key].length;
  }
  if (Object.keys(collections).length) shape.collectionCounts = collections;
  return shape;
}

async function connectWithRetry(url, process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode != null) throw new Error(`app-server exited with code ${process.exitCode}.`);
    try {
      return await connect(url);
    } catch {
      await delay(150);
    }
  }
  throw new Error(`Timed out connecting to ${url}.`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const candidate = new WebSocket(url);
    const cleanup = () => {
      candidate.off('open', onOpen);
      candidate.off('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve(candidate);
    };
    const onError = (error) => {
      cleanup();
      candidate.close();
      reject(error);
    };
    candidate.once('open', onOpen);
    candidate.once('error', onError);
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
