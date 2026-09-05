import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const INITIALIZATION_TIMEOUT_MS = 60_000;
const BACKFILL_RECOVERY_STALE_MS = 120_000;

export function createCodexAppServerTransport({
  executablePath,
  executableArgs = [],
  workspaceRoot,
  sqliteHome = process.env.XHS_CODEX_SQLITE_HOME || path.join(os.tmpdir(), 'xiaohongshu-relay-codex-sqlite'),
  codexHome = process.env.XHS_CODEX_CHILD_HOME || path.join(sqliteHome, 'home'),
  contextMcp = null,
  contextMcps = null,
  modelProvider = null,
  clientInfo = { name: 'codex-browser-host', version: '1.0.0' },
  capabilities = { experimentalApi: true },
  initializationTimeoutMs = INITIALIZATION_TIMEOUT_MS,
  backfillRecoveryStaleMs = BACKFILL_RECOVERY_STALE_MS,
  spawnProcess = spawn,
}) {
  const configuredContextMcps = normalizeContextMcps(contextMcps ?? (contextMcp ? [contextMcp] : []));
  const configuredModelProvider = normalizeModelProvider(modelProvider);
  let child = null;
  let starting = null;
  let initialized = false;
  let appServerVersion = '';
  let stderrTail = [];
  let backfillRecovery = {
    checked: false,
    recovered: false,
    reason: 'not-checked',
    backupPath: null,
    error: '',
  };
  const internalRequests = new Map();
  const messageListeners = new Set();
  const connectionListeners = new Set();

  function onMessage(listener) {
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  }

  function onConnection(listener) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }

  function emitMessage(message) {
    for (const listener of messageListeners) listener(message);
  }

  function emitConnection(event) {
    for (const listener of connectionListeners) listener(event);
  }

  function sendRaw(message) {
    if (!child?.stdin?.writable) {
      const error = new Error('Codex app-server stdin is unavailable.');
      error.code = 'CODEX_APP_SERVER_STDIN_UNAVAILABLE';
      throw error;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(message, { timeoutMs = INITIALIZATION_TIMEOUT_MS } = {}) {
    if (message?.id == null) throw new Error('Codex app-server request id is required.');
    const id = String(message.id);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        internalRequests.delete(id);
        const error = new Error(`Codex app-server request timed out: ${message.method || id}`);
        error.code = 'CODEX_APP_SERVER_REQUEST_TIMEOUT';
        reject(error);
      }, timeoutMs);
      internalRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        sendRaw(message);
      } catch (error) {
        clearTimeout(timeout);
        internalRequests.delete(id);
        reject(error);
      }
    });
  }

  function handleMessage(message) {
    if (message?.id != null && message?.method == null && internalRequests.has(String(message.id))) {
      const pending = internalRequests.get(String(message.id));
      internalRequests.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message || 'Codex app-server request failed.');
        error.code = message.error.code;
        error.details = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    emitMessage(message);
  }

  async function start() {
    if (child && initialized) return { userAgent: appServerVersion };
    if (starting) return starting;
    starting = (async () => {
      mkdirSync(sqliteHome, { recursive: true });
      recordBackfillRecovery(recoverStaleBackfillState(sqliteHome, {
        staleAfterMs: backfillRecoveryStaleMs,
      }));
      let retryAvailable = true;

      while (true) {
        let process = null;
        try {
          const isolatedCodexHome = path.resolve(String(codexHome || sqliteHome));
          mkdirSync(isolatedCodexHome, { recursive: true });
          const appServerArgs = [
            '-c',
            'features.code_mode_host=true',
            ...modelProviderOverrides(configuredModelProvider),
            ...contextMcpOverrides(configuredContextMcps),
            'app-server',
          ];
          const environment = {
            ...globalThis.process.env,
            CODEX_HOME: isolatedCodexHome,
            CODEX_SQLITE_HOME: sqliteHome,
          };
          // Never let a host Codex/proxy configuration leak into the embedded runtime.
          // The product bridge is the only model route this child is allowed to use.
          delete environment.OPENAI_BASE_URL;
          delete environment.OPENAI_API_KEY;
          delete environment.OPENAI_ORG_ID;
          delete environment.OPENAI_PROJECT_ID;
          for (const server of configuredContextMcps) environment[server.bearerTokenEnvVar] = server.token;
          if (configuredModelProvider) environment[configuredModelProvider.apiKeyEnvVar] = configuredModelProvider.apiKey;
          process = spawnProcess(executablePath, [...executableArgs, ...appServerArgs], {
            cwd: workspaceRoot,
            env: environment,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child = process;
          initialized = false;
          appServerVersion = '';
          const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
          lines.on('line', (line) => {
            const text = String(line || '').trim();
            if (!text) return;
            try {
              handleMessage(JSON.parse(text));
            } catch {
              appendStderr(`stdout: ${text}`);
            }
          });
          process.stderr.on('data', (chunk) => {
            for (const line of String(chunk).split(/\r?\n/u).filter(Boolean)) appendStderr(line);
          });
          process.once('exit', (code, signal) => {
            if (child !== process) return;
            child = null;
            initialized = false;
            const detail = stderrTail.slice(-5).join('\n');
            const error = new Error(`Codex app-server exited${code == null ? '' : ` with code ${code}`}.${detail ? `\n${detail}` : ''}`);
            error.code = 'CODEX_APP_SERVER_EXITED';
            for (const pending of internalRequests.values()) pending.reject(error);
            internalRequests.clear();
            emitConnection({ state: 'disconnected', code, signal });
          });
          process.once('error', (error) => {
            appendStderr(error?.message || error);
            if (child !== process) return;
            for (const pending of internalRequests.values()) pending.reject(error);
            internalRequests.clear();
          });

          const requestId = `app-server-init-${randomUUID()}`;
          const result = await request({
            id: requestId,
            method: 'initialize',
            params: { clientInfo, capabilities },
          }, { timeoutMs: initializationTimeoutMs });
          if (process !== child) throw new Error('Codex app-server restarted during initialization.');
          sendRaw({ method: 'initialized', params: {} });
          appServerVersion = String(result?.userAgent || '');
          initialized = true;
          emitConnection({ state: 'connected', result });
          return result;
        } catch (error) {
          if (process && child === process) {
            child = null;
            initialized = false;
            appServerVersion = '';
            terminateProcess(process);
          }
          if (retryAvailable && isBackfillInitializationTimeout(error, stderrTail)) {
            retryAvailable = false;
            const recovery = recoverStaleBackfillState(sqliteHome, { staleAfterMs: 0 });
            recordBackfillRecovery(recovery);
            if (recovery.recovered) continue;
          }
          emitConnection({ state: 'error', code: error?.code || null, message: String(error?.message || error) });
          throw error;
        }
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  function status() {
    return {
      transport: 'stdio-jsonl',
      running: Boolean(child),
      initialized,
      pid: child?.pid || null,
      appServerVersion,
      executablePath,
      executableArgs: [...executableArgs],
      stderrTail: stderrTail.slice(-10),
      backfillRecovery: { ...backfillRecovery },
      contextMcp: configuredContextMcps[0] ? {
        configured: true,
        name: configuredContextMcps[0].name,
        endpoint: configuredContextMcps[0].url,
      } : { configured: false },
      contextMcps: configuredContextMcps.map((server) => ({ configured: true, name: server.name, endpoint: server.url })),
      modelProvider: configuredModelProvider ? {
        configured: true,
        id: configuredModelProvider.id,
        name: configuredModelProvider.name,
        endpoint: configuredModelProvider.baseUrl,
        model: configuredModelProvider.model,
        wireApi: 'responses',
      } : { configured: false },
    };
  }

  async function close() {
    const process = child;
    child = null;
    initialized = false;
    appServerVersion = '';
    if (!process) return;
    const exited = new Promise((resolve) => process.once('exit', resolve));
    try { process.stdin.end(); } catch { /* process is already closing */ }

    if (globalThis.process.platform === 'win32' && process.spawnfile && Number.isInteger(process.pid)) {
      spawnSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await Promise.race([exited, delay(2_000)]);
      return;
    }

    // A real app-server uses SQLite and needs a short window to flush after EOF.
    // Test doubles do not expose spawnfile, so terminate them immediately.
    const exitedGracefully = process.spawnfile
      ? await Promise.race([exited.then(() => true), delay(1_000).then(() => false)])
      : false;
    if (!exitedGracefully) {
      try { process.kill(); } catch { /* process has already exited */ }
      await Promise.race([exited, delay(2_000)]);
    }
  }

  return Object.freeze({ start, request, sendRaw, onMessage, onConnection, status, close });

  function appendStderr(value) {
    stderrTail.push(String(value));
    if (stderrTail.length > 50) stderrTail = stderrTail.slice(-50);
  }

  function recordBackfillRecovery(result) {
    if (!result.checked && !result.error) return;
    backfillRecovery = result;
    if (result.recovered) {
      appendStderr(`Recovered interrupted Codex state backfill; backup: ${result.backupPath}`);
    } else if (result.error) {
      appendStderr(`Failed to inspect interrupted Codex state backfill: ${result.error}`);
    }
  }

  function terminateProcess(process) {
    try { process.stdin.end(); } catch { /* process is already closing */ }
    try { process.kill(); } catch { /* process has already exited */ }
  }
}

function isBackfillInitializationTimeout(error, stderrTail) {
  const detail = `${String(error?.message || error)}\n${stderrTail.join('\n')}`.toLowerCase();
  return detail.includes('timed out waiting for state db backfill')
    && detail.includes('status: running');
}

function recoverStaleBackfillState(sqliteHome, { staleAfterMs = BACKFILL_RECOVERY_STALE_MS } = {}) {
  const statePath = path.join(path.resolve(sqliteHome), 'state_5.sqlite');
  const result = {
    checked: false,
    recovered: false,
    reason: 'state-db-missing',
    backupPath: null,
    error: '',
  };
  if (!existsSync(statePath)) return result;

  let database;
  try {
    result.checked = true;
    database = new DatabaseSync(statePath, { readOnly: true });
    const row = database.prepare('SELECT status, updated_at FROM backfill_state WHERE id = 1').get();
    database.close();
    database = null;
    if (String(row?.status || '').toLowerCase() !== 'running') {
      result.reason = `status-${String(row?.status || 'missing').toLowerCase()}`;
      return result;
    }
    const updatedAtMs = Number(row.updated_at) * 1_000;
    if (staleAfterMs > 0 && Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < staleAfterMs) {
      result.reason = 'running-not-stale';
      return result;
    }

    const backupSuffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const backupPath = `${statePath}.stale-backfill-${backupSuffix}.bak`;
    copyFileSync(statePath, backupPath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecarPath = `${statePath}${suffix}`;
      if (existsSync(sidecarPath)) copyFileSync(sidecarPath, `${backupPath}${suffix}`);
    }

    database = new DatabaseSync(statePath);
    const update = database.prepare(`
      UPDATE backfill_state
      SET status = 'pending', updated_at = ?
      WHERE id = 1 AND status = 'running' AND updated_at = ?
    `).run(Math.floor(Date.now() / 1_000), row.updated_at);
    database.close();
    database = null;
    if (Number(update.changes) !== 1) {
      result.reason = 'state-changed-during-recovery';
      return result;
    }
    result.recovered = true;
    result.reason = 'interrupted-running-backfill';
    result.backupPath = backupPath;
    return result;
  } catch (error) {
    result.reason = 'inspection-failed';
    result.error = String(error?.message || error);
    return result;
  } finally {
    try { database?.close(); } catch { /* database is already closed */ }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeContextMcp(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || 'xhs-context').trim();
  const url = String(value.url || '').trim();
  const token = String(value.token || '');
  const bearerTokenEnvVar = String(value.bearerTokenEnvVar || 'XHS_CONTEXT_TOKEN').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^https?:\/\/[^\s]+$/i.test(url) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar) || !token) return null;
  return { name, url, token, bearerTokenEnvVar };
}

export function normalizeContextMcps(value) {
  const values = Array.isArray(value) ? value : [];
  const normalized = [];
  const names = new Set();
  for (const item of values) {
    const server = normalizeContextMcp(item);
    if (!server || names.has(server.name)) continue;
    names.add(server.name);
    normalized.push(server);
  }
  return normalized;
}

export function normalizeModelProvider(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || 'xhs_product_api').trim();
  const name = String(value.name || 'Product API').trim();
  const baseUrl = String(value.baseUrl || '').replace(/\/+$/u, '');
  const model = String(value.model || '').trim();
  const apiKey = String(value.apiKey || '');
  const apiKeyEnvVar = String(value.apiKeyEnvVar || 'XHS_CODEX_MODEL_BRIDGE_TOKEN').trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(id)
    || !name
    || !/^https?:\/\/[^\s]+$/iu.test(baseUrl)
    || !model
    || !apiKey
    || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnvVar)) return null;
  return { id, name, baseUrl, model, apiKey, apiKeyEnvVar };
}

function contextMcpOverrides(contextMcps) {
  return contextMcps.flatMap((contextMcp) => [
    '-c',
    `mcp_servers.${contextMcp.name}.url=${JSON.stringify(contextMcp.url)}`,
    '-c',
    `mcp_servers.${contextMcp.name}.bearer_token_env_var=${JSON.stringify(contextMcp.bearerTokenEnvVar)}`,
  ]);
}

function modelProviderOverrides(modelProvider) {
  if (!modelProvider) return [];
  const prefix = `model_providers.${modelProvider.id}`;
  return [
    '-c',
    `model_provider=${JSON.stringify(modelProvider.id)}`,
    '-c',
    `model=${JSON.stringify(modelProvider.model)}`,
    '-c',
    `${prefix}.name=${JSON.stringify(modelProvider.name)}`,
    '-c',
    `${prefix}.base_url=${JSON.stringify(modelProvider.baseUrl)}`,
    '-c',
    `${prefix}.wire_api=${JSON.stringify('responses')}`,
    '-c',
    `${prefix}.env_key=${JSON.stringify(modelProvider.apiKeyEnvVar)}`,
    '-c',
    `${prefix}.requires_openai_auth=false`,
  ];
}
