#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const DEFAULT_CAPABILITIES = [
  'thread.read',
  'thread.write',
  'turn.start',
  'approval.respond',
  'artifact.read',
  'context.local_search',
  'workspace.local_access',
  ...(process.platform === 'win32' ? ['desktop.stream', 'desktop.input'] : []),
];
const MAX_GATEWAY_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_STATE_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'XhsCodexRelay',
  'device.json',
);
const DEFAULT_CONNECTOR_SCRIPT = fileURLToPath(new URL('./codex-local-connector.mjs', import.meta.url));
const CONNECTOR_VERSION = '1.2.18';

let stopping = false;
let reconnectAttempt = 0;
let activeSocket = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const statePath = path.resolve(options.state || DEFAULT_STATE_PATH);
  const localRelayOrigin = normalizeHttpOrigin(options.localRelay || process.env.XHS_CODEX_LOCAL_RELAY_URL || 'http://127.0.0.1:4317');
  let state = await loadState(statePath);

  if (!state || options.replacePairing) {
    requireOption(options.claimUrl, '--claim-url');
    requireOption(options.gateway, '--gateway');
    requireOption(options.pairingIntent, '--pairing-intent');
    requireOption(options.code, '--code');
    state = await claimDevice({
      claimUrl: options.claimUrl,
      gateway: options.gateway,
      pairingIntentId: options.pairingIntent,
      code: options.code,
      deviceName: options.deviceName || os.hostname(),
      origin: options.connectOrigin || '',
      nonce: options.connectNonce || '',
      signature: options.connectSignature || '',
      statePath,
    });
    console.log(`Paired ${state.deviceName} as ${state.deviceId}.`);
  }

  if (options.gateway) state.gateway = normalizeWebSocketUrl(options.gateway);
  if (!state.gateway) throw new Error('The Relay state does not contain a Device Gateway URL.');
  const deviceToken = unprotectToken(state);
  if (!deviceToken) throw new Error('The stored device credential could not be read by the current OS user.');
  console.log('Loaded the OS-protected device credential.');

  const controller = new LocalSemanticController({ localRelayOrigin });
  process.on('SIGINT', () => { stopping = true; activeSocket?.close(1000, 'local shutdown'); });
  process.on('SIGTERM', () => { stopping = true; activeSocket?.close(1000, 'local shutdown'); });

  while (!stopping) {
    try {
      await runConnection({ state, deviceToken, controller });
      reconnectAttempt = 0;
    } catch (error) {
      if (stopping) break;
      reconnectAttempt += 1;
      const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, reconnectAttempt - 1)));
      console.error(`Device tunnel disconnected: ${error.message}. Retrying in ${delayMs}ms.`);
      if (options.once) process.exitCode = 1;
      if (options.once) break;
      await sleep(delayMs);
    }
  }

  await controller.closeAll();
}

async function runConnection({ state: currentState, deviceToken: token, controller: localController }) {
  const tunnelUrl = new URL(currentState.gateway);
  tunnelUrl.searchParams.set('deviceId', currentState.deviceId);
  console.log(`Connecting outbound tunnel to ${tunnelUrl.origin}.`);
  const webSocket = new WebSocket(tunnelUrl, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: MAX_GATEWAY_MESSAGE_BYTES,
    handshakeTimeout: 10_000,
  });
  activeSocket = webSocket;
  await new Promise((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  reconnectAttempt = 0;
  console.log(`Connected to ${tunnelUrl.origin} as ${currentState.deviceName}.`);
  const localStatus = await localController.status();
  webSocket.send(JSON.stringify({
    type: 'device.hello',
    relayVersion: CONNECTOR_VERSION,
    codexBuild: String(localStatus?.adapter?.buildNumber || ''),
    capabilities: DEFAULT_CAPABILITIES,
    codex: {
      running: Boolean(localStatus?.browser?.running || localStatus?.adapter?.runtimeReady),
      windowId: '',
    },
  }));
  const presenceTimer = setInterval(() => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    void localController.status().then((status) => webSocket.send(JSON.stringify({
      type: 'device.presence',
      relayVersion: CONNECTOR_VERSION,
      codexBuild: String(status?.adapter?.buildNumber || ''),
      capabilities: DEFAULT_CAPABILITIES,
      codex: { running: Boolean(status?.browser?.running || status?.adapter?.runtimeReady), windowId: '' },
    }))).catch(() => {});
  }, 15_000);
  presenceTimer.unref?.();

  localController.setEventSink((event) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(event));
  });
  let inboundQueue = Promise.resolve();
  const mirrorInputTasks = new Set();
  webSocket.on('message', (bytes) => {
    const encoded = Buffer.from(bytes).toString('utf8');
    let message;
    try {
      message = JSON.parse(encoded);
    } catch (error) {
      sendGatewayError(webSocket, '', error);
      return;
    }
    if (message?.type === 'mirror.input') {
      const task = handleGatewayMessage(webSocket, localController, message, { gatewayUrl: tunnelUrl })
        .catch((error) => sendGatewayError(webSocket, message.sessionId, error));
      mirrorInputTasks.add(task);
      void task.finally(() => mirrorInputTasks.delete(task));
      return;
    }
    inboundQueue = inboundQueue.then(async () => {
      try {
        if (message?.type === 'mirror.close' && mirrorInputTasks.size) {
          await Promise.allSettled([...mirrorInputTasks]);
        }
        await handleGatewayMessage(webSocket, localController, message, { gatewayUrl: tunnelUrl });
      } catch (error) {
        sendGatewayError(webSocket, message?.sessionId || message?.session?.id, error);
      }
    });
  });
  await new Promise((resolve, reject) => {
    webSocket.once('close', (code, reason) => {
      clearInterval(presenceTimer);
      activeSocket = null;
      if (stopping || code === 1000) resolve();
      else reject(new Error(`WebSocket closed (${code} ${String(reason)})`));
    });
    webSocket.once('error', reject);
  });
}

export async function handleGatewayMessage(webSocket, localController, message, {
  gatewayUrl = '',
  restartConnector = scheduleConnectorRestart,
} = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Gateway sent an invalid message.');
  if (message.type === 'device.accept' || message.type === 'device.presence.ack' || message.type === 'connector.result.ack') return;
  if (message.type === 'session.offer') {
    await localController.open(message.session);
    webSocket.send(JSON.stringify({
      type: 'session.ack',
      sessionId: message.session.id,
      requestId: '',
      status: 'ready',
    }));
    return;
  }
  if (message.type === 'session.message') {
    await localController.send(message.sessionId, message.message);
    return;
  }
  if (message.type === 'session.close') {
    await localController.close(message.sessionId);
    return;
  }
  if (message.type === 'mirror.open') {
    return handleMirrorCommand(webSocket, message, 'open', () => localController.openMirror(message, gatewayUrl));
  }
  if (message.type === 'mirror.input-target') {
    return handleMirrorCommand(webSocket, message, 'input-target', () => localController.setMirrorInputTarget(message.sessionId, message.target));
  }
  if (message.type === 'mirror.input') {
    return handleMirrorCommand(webSocket, message, 'input', () => localController.sendMirrorInput(message.sessionId, message.event));
  }
  if (message.type === 'mirror.close') {
    return handleMirrorCommand(webSocket, message, 'close', () => localController.closeMirror(message.sessionId));
  }
  if (message.type === 'connector.command') {
    let result;
    try {
      result = await localController.maintain(message.operation, { gatewayUrl });
    } catch (error) {
      result = {
        ok: false,
        state: 'maintenance_failed',
        message: String(error?.message || error).slice(0, 500),
        runtimeReady: false,
      };
    }
    webSocket.send(JSON.stringify({ type: 'connector.result', operation: message.operation, result }));
    if (result.ok && ['updated', 'rolled_back'].includes(result.state)) {
      restartConnector(webSocket, localController.origin);
    }
    return;
  }
  if (message.type === 'gateway.error') throw new Error(`${message.code || 'GATEWAY_ERROR'}: ${message.message || 'Gateway error'}`);
}

async function handleMirrorCommand(webSocket, message, operation, callback) {
  try {
    await callback();
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: message.sessionId,
      operation,
      requestId: message.requestId || '',
      ok: true,
      message: '',
    }));
  } catch (error) {
    webSocket.send(JSON.stringify({
      type: 'mirror.result',
      sessionId: message.sessionId,
      operation,
      requestId: message.requestId || '',
      ok: false,
      message: String(error?.message || error).slice(0, 500),
    }));
  }
}

export class LocalSemanticController {
  constructor({ localRelayOrigin, openExternal = openExternalUrl, webSocketFactory = (url) => new WebSocket(url) }) {
    this.origin = localRelayOrigin;
    this.sessions = new Map();
    this.mirrors = new Map();
    this.eventSink = () => {};
    this.openExternal = openExternal;
    this.webSocketFactory = webSocketFactory;
  }

  setEventSink(callback) {
    this.eventSink = typeof callback === 'function' ? callback : () => {};
  }

  async status() {
    return requestJson(`${this.origin}/api/codex-relay/status`);
  }

  async open(remoteSession) {
    const remoteSessionId = normalizeSessionId(remoteSession?.id);
    if (this.sessions.has(remoteSessionId)) return this.sessions.get(remoteSessionId);
    await fetch(`${this.origin}/codex/`, { redirect: 'manual' }).catch(() => {});
    const browserIdentity = `gateway:${remoteSessionId}`;
    const created = await requestJson(`${this.origin}/api/codex-relay/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'semantic',
        browserSessionId: browserIdentity,
        browserInstanceId: browserIdentity,
        requestedCapabilities: remoteSession?.requestedCapabilities || ['thread.read'],
      }),
    });
    const connected = await requestJson(`${this.origin}/api/codex-relay/sessions/${encodeURIComponent(created.session.id)}/connect`, {
      method: 'POST',
      body: JSON.stringify({ ticket: created.ticket.value, browserInstanceId: browserIdentity }),
    });
    const state = {
      remoteSessionId,
      localSessionId: created.session.id,
      browserIdentity,
      connectionToken: connected.connectionToken,
      lease: connected.lease,
      cursor: 0,
      closed: false,
      pollTimer: null,
      renewTimer: null,
    };
    this.sessions.set(remoteSessionId, state);
    state.pollTimer = setInterval(() => void this._poll(state), 500);
    state.renewTimer = setInterval(() => void this._renew(state), 10_000);
    state.pollTimer.unref?.();
    state.renewTimer.unref?.();
    await this._poll(state);
    return state;
  }

  async send(remoteSessionId, message) {
    const state = this.sessions.get(normalizeSessionId(remoteSessionId));
    if (!state || state.closed) throw new Error('The local semantic session is not active.');
    const result = await requestJson(`${this.origin}/api/codex-relay/sessions/${encodeURIComponent(state.localSessionId)}/messages`, {
      method: 'POST',
      headers: { 'X-Codex-Relay-Connection': state.connectionToken },
      body: JSON.stringify({
        browserInstanceId: state.browserIdentity,
        leaseEpoch: state.lease.epoch,
        message,
      }),
    });
    for (const event of result.events || []) {
      this.eventSink({
        type: 'session.event',
        sessionId: state.remoteSessionId,
        event,
      });
    }
    return result;
  }

  async close(remoteSessionId) {
    const state = this.sessions.get(normalizeSessionId(remoteSessionId));
    if (!state) return;
    state.closed = true;
    clearInterval(state.pollTimer);
    clearInterval(state.renewTimer);
    this.sessions.delete(state.remoteSessionId);
    await requestJson(`${this.origin}/api/codex-relay/sessions/${encodeURIComponent(state.localSessionId)}`, {
      method: 'DELETE',
      headers: { 'X-Codex-Relay-Connection': state.connectionToken },
    }).catch(() => {});
  }

  async closeAll() {
    await Promise.allSettled([
      ...[...this.sessions.keys()].map((sessionId) => this.close(sessionId)),
      ...[...this.mirrors.keys()].map((sessionId) => this.closeMirror(sessionId)),
    ]);
  }

  async openMirror({ sessionId, sourceUrl }, gatewayUrl) {
    const remoteSessionId = normalizeMirrorSessionId(sessionId);
    const validatedSourceUrl = validateMirrorSourceUrl(sourceUrl, gatewayUrl, remoteSessionId);
    await this.closeMirror(remoteSessionId);
    await requestJson(`${this.origin}/api/codex-desktop/launch`, { method: 'POST', body: '{}' }).catch(() => {});
    const created = await requestJson(`${this.origin}/api/codex-native-mirror/sessions`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'connector-local-mirror' }),
    });
    const state = {
      remoteSessionId,
      localSessionId: created.session.id,
      sourceRole: created.source.role,
      sourceToken: created.source.token,
      inputSocket: null,
      inputSequence: 0,
      inputPending: new Map(),
      externalLaunch: null,
    };
    this.mirrors.set(remoteSessionId, state);
    this._connectMirrorInput(state);
    const sourceWithLocalInput = attachLocalMirrorInputBridge(validatedSourceUrl, {
      origin: this.origin,
      sessionId: state.localSessionId,
      role: state.sourceRole,
      token: state.sourceToken,
    });
    try {
      state.externalLaunch = await this.openExternal(sourceWithLocalInput) || null;
    } catch (error) {
      await this.closeMirror(remoteSessionId);
      throw error;
    }
    return { opened: true, sessionId: remoteSessionId };
  }

  async setMirrorInputTarget(remoteSessionId, target) {
    const state = this._mirror(remoteSessionId);
    return requestJson(`${this.origin}/api/codex-native-mirror/sessions/${encodeURIComponent(state.localSessionId)}/input-target`, {
      method: 'POST',
      headers: mirrorHeaders(state),
      body: JSON.stringify(target || {}),
    });
  }

  async sendMirrorInput(remoteSessionId, event) {
    const state = this._mirror(remoteSessionId);
    const socket = state.inputSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      const normalizedEvent = event || {};
      if (normalizedEvent.type === 'mouse' && normalizedEvent.action === 'move') {
        socket.send(JSON.stringify({ type: 'mirror.pointer', event: normalizedEvent }));
        // Pointer packets use an unreliable fast path. Keep an immediate HTTP
        // replay as a lossless backstop for public gateways that drop a UDP/
        // WebRTC packet while preserving the persistent socket latency.
        void requestJson(`${this.origin}/api/codex-native-mirror/sessions/${encodeURIComponent(state.localSessionId)}/input`, {
          method: 'POST',
          headers: mirrorHeaders(state),
          body: JSON.stringify({ event: normalizedEvent }),
        }).catch(() => {});
        return { delivered: true, transport: 'persistent-websocket' };
      }
      const requestId = `connector-input-${++state.inputSequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.inputPending.delete(requestId);
          reject(new Error('The local Mirror input channel did not acknowledge the event.'));
        }, 2_000);
        state.inputPending.set(requestId, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ type: 'mirror.input', requestId, event: normalizedEvent }));
        } catch (error) {
          clearTimeout(timer);
          state.inputPending.delete(requestId);
          reject(error);
        }
      });
    }
    return requestJson(`${this.origin}/api/codex-native-mirror/sessions/${encodeURIComponent(state.localSessionId)}/input`, {
      method: 'POST',
      headers: mirrorHeaders(state),
      body: JSON.stringify(event || {}),
    });
  }

  async closeMirror(remoteSessionId) {
    const id = normalizeMirrorSessionId(remoteSessionId);
    const state = this.mirrors.get(id);
    if (!state) return;
    this.mirrors.delete(id);
    this._closeMirrorInput(state);
    await Promise.allSettled([
      closeExternalMirrorLaunch(state.externalLaunch),
      requestJson(`${this.origin}/api/codex-native-mirror/sessions/${encodeURIComponent(state.localSessionId)}`, {
        method: 'DELETE',
        headers: mirrorHeaders(state),
      }),
    ]);
  }

  _mirror(remoteSessionId) {
    const id = normalizeMirrorSessionId(remoteSessionId);
    const state = this.mirrors.get(id);
    if (!state) throw new Error('The local Native Mirror input session is not active.');
    return state;
  }

  _connectMirrorInput(state) {
    const url = new URL(this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/v1/native-mirror/input';
    url.search = '';
    url.hash = '';
    url.searchParams.set('sessionId', state.localSessionId);
    url.searchParams.set('role', state.sourceRole);
    url.searchParams.set('token', state.sourceToken);
    let socket;
    try {
      socket = this.webSocketFactory(url.toString());
    } catch {
      return;
    }
    state.inputSocket = socket;
    const onMessage = (bytes) => {
      let packet;
      try { packet = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return; }
      if (packet?.type !== 'mirror.input-result') return;
      const pending = state.inputPending.get(String(packet.requestId || ''));
      if (!pending) return;
      state.inputPending.delete(String(packet.requestId));
      clearTimeout(pending.timer);
      if (packet.ok === true && packet.delivered !== false) {
        pending.resolve({ delivered: true, targetFound: packet.targetFound !== false, transport: 'persistent-websocket' });
      } else {
        pending.reject(new Error(String(packet.message || 'The local Mirror input event was rejected.')));
      }
    };
    const onClose = () => {
      if (state.inputSocket !== socket) return;
      state.inputSocket = null;
      for (const pending of state.inputPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The local Mirror input channel closed.'));
      }
      state.inputPending.clear();
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', () => {});
  }

  _closeMirrorInput(state) {
    for (const pending of state.inputPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The local Mirror input channel closed.'));
    }
    state.inputPending.clear();
    state.inputSocket?.close?.(1000, 'mirror closed');
    state.inputSocket = null;
  }

  async maintain(operation, { gatewayUrl = '' } = {}) {
    const normalizedOperation = String(operation || '').trim().toLowerCase();
    if (!['reconnect', 'repair', 'rollback'].includes(normalizedOperation)) {
      throw new Error('The connector operation is invalid.');
    }
    if (normalizedOperation === 'repair' || normalizedOperation === 'rollback') {
      const maintenanceOrigin = publicOriginFromGateway(gatewayUrl) || this.origin;
      const maintenance = await runConnectorMaintenance(normalizedOperation, maintenanceOrigin);
      const status = await this.status().catch(() => ({}));
      const runtimeReady = status?.adapter?.state === 'compatible';
      return {
        ok: maintenance.ok === true,
        state: String(maintenance.state || 'maintenance_completed'),
        message: normalizedOperation === 'repair'
          ? `Connector update check completed: ${maintenance.state || 'updated'}.`
          : `Connector rollback completed: ${maintenance.fromVersion || ''} -> ${maintenance.toVersion || ''}.`,
        runtimeReady,
        fromVersion: String(maintenance.fromVersion || ''),
        toVersion: String(maintenance.toVersion || ''),
      };
    }
    const status = await this.status();
    const runtimeReady = status?.adapter?.state === 'compatible';
    return {
      ok: true,
      state: runtimeReady ? 'runtime_ready' : 'runtime_unavailable',
      message: 'Connector presence was refreshed.',
      runtimeReady,
    };
  }

  async _poll(state) {
    if (state.closed || state.polling) return;
    state.polling = true;
    try {
      const result = await requestJson(`${this.origin}/api/codex-relay/sessions/${encodeURIComponent(state.localSessionId)}/events?after=${state.cursor}&limit=100`, {
        headers: { 'X-Codex-Relay-Connection': state.connectionToken },
      });
      for (const entry of result.events || []) {
        state.cursor = Math.max(state.cursor, Number(entry.sequence) || 0);
        this.eventSink({
          type: 'session.event',
          sessionId: state.remoteSessionId,
          sequence: state.cursor,
          event: entry.message || entry.event,
        });
      }
    } catch (error) {
      this.eventSink({ type: 'session.event', sessionId: state.remoteSessionId, event: { type: 'relay.error', message: error.message } });
    } finally {
      state.polling = false;
    }
  }

  async _renew(state) {
    if (state.closed || state.renewing) return;
    state.renewing = true;
    try {
      state.lease = await requestJson(`${this.origin}/api/codex-relay/sessions/${encodeURIComponent(state.localSessionId)}/lease/renew`, {
        method: 'POST',
        headers: { 'X-Codex-Relay-Connection': state.connectionToken },
        body: JSON.stringify({ browserInstanceId: state.browserIdentity, leaseEpoch: state.lease.epoch }),
      });
    } catch (error) {
      this.eventSink({ type: 'session.event', sessionId: state.remoteSessionId, event: { type: 'lease.error', message: error.message } });
    } finally {
      state.renewing = false;
    }
  }
}

function runConnectorMaintenance(operation, localRelayOrigin) {
  const mode = operation === 'rollback' ? '--rollback' : '--update';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      DEFAULT_CONNECTOR_SCRIPT,
      mode,
      '--local-relay', localRelayOrigin,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(String(stderr || stdout || `Connector maintenance exited with code ${code}.`).trim()));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (!result || typeof result !== 'object' || result.ok !== true) throw new Error('Connector maintenance returned an invalid result.');
        resolve(result);
      } catch (error) {
        reject(new Error(`Connector maintenance output was invalid: ${error.message}`));
      }
    });
  });
}

async function claimDevice({ claimUrl, gateway, pairingIntentId, code, deviceName, origin, nonce, signature, statePath: filePath }) {
  const claimed = await requestJson(claimUrl, {
    method: 'POST',
    body: JSON.stringify({
      pairingIntentId,
      code,
      deviceName,
      ...(origin ? { origin } : {}),
      ...(nonce ? { nonce } : {}),
      ...(signature ? { signature } : {}),
      capabilities: DEFAULT_CAPABILITIES,
      relayVersion: '1.2.3',
      codexBuild: '',
    }),
  });
  const state = {
    schemaVersion: 1,
    deviceId: claimed.device.id,
    deviceName: claimed.device.name || deviceName,
    gateway: normalizeWebSocketUrl(gateway),
    pairedAt: claimed.device.pairedAt || new Date().toISOString(),
    ...protectToken(claimed.credentials.deviceToken),
  };
  await saveState(filePath, state);
  return state;
}

function protectToken(token) {
  if (process.platform !== 'win32') return { deviceToken: String(token) };
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$plain=[Console]::In.ReadToEnd()',
    '$bytes=[Text.Encoding]::UTF8.GetBytes($plain)',
    '$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
  ].join(';');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: String(token),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error(`DPAPI credential protection failed: ${String(result.stderr || '').trim()}`);
  return { deviceTokenDpapi: String(result.stdout).trim() };
}

function unprotectToken(state) {
  if (state.deviceTokenDpapi && process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$encoded=[Console]::In.ReadToEnd()',
      '$bytes=[Convert]::FromBase64String($encoded)',
      '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
    ].join(';');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: String(state.deviceTokenDpapi),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`DPAPI credential decryption failed: ${String(result.stderr || '').trim()}`);
    return String(result.stdout || '');
  }
  return String(state.deviceToken || '');
}

async function loadState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${body.code || `HTTP_${response.status}`}: ${body.message || response.statusText}`);
  return body;
}

function sendGatewayError(webSocket, sessionId, error) {
  console.error(`Device session error${sessionId ? ` (${sessionId})` : ''}: ${error.message}`);
  if (webSocket.readyState !== WebSocket.OPEN || !sessionId) return;
  webSocket.send(JSON.stringify({
    type: 'session.event',
    sessionId,
    event: { type: 'relay.error', message: error.message },
  }));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { parsed.help = true; continue; }
    if (token === '--once') { parsed.once = true; continue; }
    if (token === '--replace-pairing') { parsed.replacePairing = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function normalizeHttpOrigin(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') throw new Error('The local Relay URL must be an HTTP(S) origin.');
  return url.origin;
}

function normalizeWebSocketUrl(value) {
  const url = new URL(String(value || ''));
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('The Device Gateway URL must use ws:// or wss://.');
  url.pathname = '/v1/device-tunnel';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function publicOriginFromGateway(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['ws:', 'wss:'].includes(url.protocol)) return '';
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(sessionId)) throw new Error('The session id is invalid.');
  return sessionId;
}

function normalizeMirrorSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^mirror-[A-Za-z0-9-]{8,140}$/.test(sessionId)) throw new Error('The Native Mirror session id is invalid.');
  return sessionId;
}

export function validateMirrorSourceUrl(value, gatewayUrl, expectedSessionId) {
  const source = new URL(String(value || ''));
  const gateway = new URL(String(gatewayUrl || ''));
  const expectedProtocol = gateway.protocol === 'wss:' ? 'https:' : 'http:';
  const expectedOrigin = `${expectedProtocol}//${gateway.host}`;
  const fragment = new URLSearchParams(source.hash.slice(1));
  if (
    source.origin !== expectedOrigin
    || source.pathname !== '/codex-native-mirror.html'
    || fragment.get('sessionId') !== normalizeMirrorSessionId(expectedSessionId)
    || fragment.get('role') !== 'source'
    || String(fragment.get('token') || '').length < 16
    || fragment.get('remote') !== '1'
  ) {
    throw new Error('The remote Native Mirror source URL is not trusted.');
  }
  return source.toString();
}

export function attachLocalMirrorInputBridge(value, { origin, sessionId, role, token } = {}) {
  const source = new URL(String(value || ''));
  const local = new URL(String(origin || ''));
  if (!['http:', 'https:'].includes(local.protocol) || !isLoopbackHost(local.hostname)) {
    throw new Error('The Native Mirror local input bridge must use a loopback HTTP(S) origin.');
  }
  const localSessionId = normalizeMirrorSessionId(sessionId);
  if (role !== 'source' || String(token || '').length < 16) {
    throw new Error('The Native Mirror local input bridge credentials are invalid.');
  }
  const fragment = new URLSearchParams(source.hash.slice(1));
  fragment.set('localInputOrigin', local.origin);
  fragment.set('localInputSessionId', localSessionId);
  fragment.set('localInputRole', role);
  fragment.set('localInputToken', String(token));
  source.hash = fragment.toString();
  return source.toString();
}

function isLoopbackHost(value) {
  const host = String(value || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function mirrorHeaders(state) {
  return {
    'X-Codex-Mirror-Role': state.sourceRole,
    'X-Codex-Mirror-Token': state.sourceToken,
  };
}

async function openExternalUrl(value) {
  const url = String(value || '');
  if (process.platform === 'win32') {
    const browserPath = resolveWindowsMirrorBrowser();
    if (browserPath) {
      const profilePath = mirrorBrowserProfilePath(url);
      const launch = buildWindowsMirrorBrowserLaunch(url, {
        browserPath,
        captureTitle: process.env.XHS_CODEX_MIRROR_CAPTURE_TITLE || 'ChatGPT',
        profilePath,
      });
      const child = await spawnDetached(launch.command, launch.args);
      return {
        ...child,
        profilePath,
        close: () => closeDetachedMirrorBrowser(child.pid, profilePath),
      };
    }
  }
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return spawnDetached(command, args);
}

async function closeExternalMirrorLaunch(launch) {
  if (typeof launch?.close !== 'function') return;
  await launch.close();
}

async function closeDetachedMirrorBrowser(pid, profilePath) {
  const processId = Number(pid);
  if (Number.isInteger(processId) && processId > 0) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try { process.kill(-processId, 'SIGTERM'); } catch {}
    }
  }
  if (profilePath) {
    await rm(path.resolve(profilePath), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

export function mirrorBrowserProfilePath(value) {
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'XhsCodexConnector',
    'mirror-browser',
  );
  let sessionId = 'default';
  try {
    const url = new URL(String(value || ''));
    const candidate = new URLSearchParams(url.hash.slice(1)).get('sessionId');
    if (candidate) sessionId = candidate;
  } catch {
    // The URL has already been validated before this helper is called.
  }
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || 'default';
  return path.join(base, `mirror-${safeSessionId}`);
}

export function buildWindowsMirrorBrowserLaunch(value, {
  browserPath,
  captureTitle = 'ChatGPT',
  profilePath,
} = {}) {
  const url = String(value || '').trim();
  const executable = path.resolve(String(browserPath || ''));
  const profile = path.resolve(String(profilePath || ''));
  const title = String(captureTitle || '').trim();
  if (!/^https?:\/\//iu.test(url)) throw new Error('The Mirror source URL must use HTTP or HTTPS.');
  if (!executable || !profile || !title || /[\r\n]/u.test(title)) throw new Error('The Mirror browser launch configuration is invalid.');
  const source = new URL(url);
  const localInputOrigin = new URLSearchParams(source.hash.slice(1)).get('localInputOrigin') || '';
  const localInput = localInputOrigin ? new URL(localInputOrigin) : null;
  if (localInput && (!['http:', 'https:'].includes(localInput.protocol) || !isLoopbackHost(localInput.hostname))) {
    throw new Error('The Mirror browser local input origin is invalid.');
  }
  return {
    command: executable,
    args: [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--disable-default-apps',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      ...(localInput ? [
        '--allow-running-insecure-content',
        '--disable-features=PrivateNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults',
        `--unsafely-treat-insecure-origin-as-secure=${localInput.origin}`,
      ] : []),
      `--auto-select-desktop-capture-source=${title}`,
      `--app=${url}`,
    ],
  };
}

function resolveWindowsMirrorBrowser() {
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

function scheduleConnectorRestart(webSocket, localRelayOrigin) {
  stopping = true;
  const timer = setTimeout(() => {
    const child = spawn(process.execPath, [
      DEFAULT_CONNECTOR_SCRIPT,
      '--background',
      '--local-relay', localRelayOrigin,
    ], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', (error) => console.error(`Connector restart failed: ${error.message}`));
    child.unref();
    webSocket.close(1012, 'connector runtime switched');
  }, 300);
  timer.unref?.();
}

function requireOption(value, name) {
  if (!String(value || '').trim()) throw new Error(`${name} is required for first-time pairing.`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Codex Device Relay

First pairing:
  node scripts/codex-device-relay.mjs --claim-url HTTPS_URL --gateway WSS_URL \\
    --pairing-intent PAIRING_ID --code PAIRING_CODE [--device-name NAME]

Subsequent starts:
  node scripts/codex-device-relay.mjs [--state PATH] [--local-relay HTTP_ORIGIN]

Options:
  --claim-url URL        Public device-claim endpoint
  --gateway URL          Outbound ws:// or wss:// Device Gateway
  --pairing-intent ID    Pairing intent created by the signed-in browser
  --code CODE            One-time eight-character pairing code
  --device-name NAME     Name shown in the browser device selector
  --connect-origin URL    Bound browser origin for a signed connector launch
  --connect-nonce VALUE  One-time connector launch nonce
  --connect-signature    One-time connector launch signature
  --replace-pairing      Replace a persisted pairing with the signed intent
  --local-relay ORIGIN   Local Relay origin (default http://127.0.0.1:4317)
  --state PATH           Device credential state file
  --once                 Exit instead of reconnecting after tunnel failure
`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
