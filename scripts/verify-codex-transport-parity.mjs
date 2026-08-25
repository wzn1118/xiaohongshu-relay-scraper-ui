#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { createCodexAppServerTransport } from '../server/codex-app-server-transport.mjs';
import { loadCodexProtocolEvidence } from '../server/codex-protocol-evidence.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, '..');
const evidenceRoot = path.resolve(
  process.env.XHS_CODEX_PROTOCOL_EVIDENCE_ROOT
    || path.join(workspaceRoot, 'output', 'codex-web-runtime-probe'),
);
const evidence = await loadCodexProtocolEvidence({ root: evidenceRoot });
if (evidence.state !== 'ready') throw new Error(`Codex protocol evidence is unavailable under ${evidenceRoot}.`);

const runtimeRoot = path.resolve(
  process.env.XHS_CODEX_DESKTOP_RUNTIME_DIR
    || path.join(workspaceRoot, 'output', 'codex-desktop-runtime-55d9fb967596'),
);
const executablePath = path.resolve(
  process.env.XHS_CODEX_EXECUTABLE
    || path.join(runtimeRoot, 'app', 'resources', 'codex.exe'),
);
const reportRoot = path.join(evidence.root, 'transport-parity');
const reportPath = path.join(reportRoot, 'stdio-websocket-parity.json');
const cases = [
  ['thread/list', { limit: 3, useStateDbOnly: true }],
  ['model/list', { limit: 10 }],
  ['skills/list', { cwds: [workspaceRoot], forceReload: false }],
  ['mcpServerStatus/list', { limit: 20, detail: 'toolsAndAuthOnly' }],
  ['plugin/list', { cwds: [workspaceRoot], forceRefetch: false, marketplaceKinds: ['local'] }],
];

await mkdir(reportRoot, { recursive: true });
const stdio = await runStdio();
const websocket = await runWebSocket();
const comparisons = cases.map(([method, params]) => {
  const left = stdio.results[method];
  const right = websocket.results[method];
  return {
    method,
    params,
    stdio: left,
    websocket: right,
    parity: left.status === 'pass'
      && right.status === 'pass'
      && JSON.stringify(left.contract) === JSON.stringify(right.contract),
  };
});
const initializationParity = stdio.initialization.status === 'pass'
  && websocket.initialization.status === 'pass'
  && JSON.stringify(stdio.initialization.contract) === JSON.stringify(websocket.initialization.contract);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  protocolVersion: evidence.protocolVersion,
  executablePath,
  evidence: {
    schemaPath: evidence.schemaPath,
    schemaSha256: evidence.schemaSha256,
    probePath: evidence.probePath,
  },
  initialization: {
    parity: initializationParity,
    stdio: stdio.initialization,
    websocket: websocket.initialization,
  },
  comparisons,
  summary: {
    total: comparisons.length,
    passed: comparisons.filter((entry) => entry.parity).length,
    failed: comparisons.filter((entry) => !entry.parity).length,
    initializationParity,
  },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
if (!initializationParity || report.summary.failed) process.exitCode = 1;

async function runStdio() {
  return retryTransport('stdio', runStdioAttempt);
}

async function runStdioAttempt() {
  const transport = createCodexAppServerTransport({
    executablePath,
    workspaceRoot,
    sqliteHome: path.join(reportRoot, 'stdio-sqlite'),
    clientInfo: { name: 'codex-stdio-parity-probe', version: '1.0.0' },
  });
  const results = {};
  try {
    const initialized = await transport.start();
    for (let index = 0; index < cases.length; index += 1) {
      const [method, params] = cases[index];
      results[method] = await capture(() => transport.request({ id: `stdio-${index + 1}`, method, params }));
    }
    return { initialization: passed(initialized), results };
  } catch (error) {
    const detail = transport.status().stderrTail.slice(-10).join('\n');
    throw new Error(`${error?.message || error}${detail ? `\napp-server stderr:\n${detail}` : ''}`);
  } finally {
    await transport.close();
  }
}

async function runWebSocket() {
  return retryTransport('websocket', runWebSocketAttempt);
}

async function runWebSocketAttempt() {
  const port = await reservePort();
  const endpoint = `ws://127.0.0.1:${port}`;
  const child = spawn(executablePath, [
    '-c',
    'features.code_mode_host=true',
    'app-server',
    '--listen',
    endpoint,
  ], {
    cwd: workspaceRoot,
    env: { ...process.env, CODEX_SQLITE_HOME: path.join(reportRoot, 'websocket-sqlite') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(...String(chunk).split(/\r?\n/u).filter(Boolean));
    if (stderr.length > 30) stderr.splice(0, stderr.length - 30);
  });
  let socket;
  const pending = new Map();
  try {
    socket = await connectWithRetry(endpoint, child);
    socket.on('message', (data) => handleWebSocketMessage(socket, pending, JSON.parse(String(data))));
    const initialized = await requestWebSocket(socket, pending, 'ws-initialize', 'initialize', {
      clientInfo: { name: 'codex-websocket-parity-probe', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const results = {};
    for (let index = 0; index < cases.length; index += 1) {
      const [method, params] = cases[index];
      results[method] = await capture(() => requestWebSocket(socket, pending, `ws-${index + 1}`, method, params));
    }
    return { initialization: passed(initialized), results };
  } catch (error) {
    throw new Error(`${error?.message || error}${stderr.length ? `\napp-server stderr:\n${stderr.slice(-10).join('\n')}` : ''}`);
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error('WebSocket parity probe terminated.'));
    }
    pending.clear();
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'parity complete');
    if (!child.killed) child.kill();
  }
}

async function retryTransport(label, operation, attempts = 3) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      errors.push(`attempt ${attempt}: ${String(error?.message || error)}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`${label} parity transport failed after ${attempts} attempts:\n${errors.join('\n')}`);
}

async function capture(operation) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    return { ...passed(result), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      errorCode: error?.code ?? null,
      errorMessage: String(error?.message || error).slice(0, 300),
    };
  }
}

function passed(result) {
  return { status: 'pass', contract: shapeContract(result) };
}

function shapeContract(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const variants = [...new Set(value.slice(0, 5).map((entry) => JSON.stringify(shapeContract(entry, depth + 1))))]
      .map((entry) => JSON.parse(entry));
    return { type: 'array', variants };
  }
  if (typeof value !== 'object') return { type: typeof value };
  const keys = Object.keys(value).sort();
  if (depth >= 2) return { type: 'object', keys };
  return {
    type: 'object',
    keys,
    properties: Object.fromEntries(keys.map((key) => [key, shapeContract(value[key], depth + 1)])),
  };
}

function requestWebSocket(socket, pending, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      const error = new Error(`${method} timed out.`);
      error.code = 'CODEX_APP_SERVER_REQUEST_TIMEOUT';
      reject(error);
    }, 45_000);
    pending.set(id, { method, resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function handleWebSocketMessage(socket, pending, message) {
  if (message?.id != null && message?.method == null) {
    const entry = pending.get(String(message.id));
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(String(message.id));
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
      error: { code: -32601, message: 'Read-only parity probe does not implement server requests.' },
    }));
  }
}

async function connectWithRetry(url, process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode != null) throw new Error(`WebSocket app-server exited with code ${process.exitCode}.`);
    try {
      return await connect(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Timed out connecting to ${url}.`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    const onOpen = () => { cleanup(); resolve(socket); };
    const onError = (error) => { cleanup(); socket.close(); reject(error); };
    socket.once('open', onOpen);
    socket.once('error', onError);
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
