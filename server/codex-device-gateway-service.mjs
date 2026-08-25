import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { WebSocketServer } from 'ws';

const STATE_VERSION = 1;
const PAIRING_TTL_MS = 5 * 60_000;
const DEVICE_OFFLINE_AFTER_MS = 45_000;
const MAX_CAPABILITIES = 32;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_EVENTS = 1_000;
const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export class CodexDeviceGatewayError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexDeviceGatewayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexDeviceGatewayService(options = {}) {
  return new CodexDeviceGatewayService(options);
}

export class CodexDeviceGatewayService {
  constructor({
    statePath,
    auditPath,
    now = () => new Date(),
    newId = randomUUID,
    newSecret = () => randomBytes(32).toString('base64url'),
    newPairingCode = () => randomPairingCode(),
    heartbeatSeconds = 15,
    mirrorResultTimeoutMs = 8_000,
  } = {}) {
    if (!statePath) throw new CodexDeviceGatewayError('CODEX_GATEWAY_STATE_PATH_REQUIRED', 'A gateway state path is required.', 500);
    this.statePath = path.resolve(statePath);
    this.auditPath = auditPath ? path.resolve(auditPath) : '';
    this.now = now;
    this.newId = newId;
    this.newSecret = newSecret;
    this.newPairingCode = newPairingCode;
    this.heartbeatSeconds = Math.min(60, Math.max(5, Number(heartbeatSeconds) || 15));
    this.mirrorResultTimeoutMs = Math.min(30_000, Math.max(1_000, Number(mirrorResultTimeoutMs) || 8_000));
    this.devices = new Map();
    this.pairingIntents = new Map();
    this.connections = new Map();
    this.sessionEvents = new Map();
    this.mirrorStates = new Map();
    this.pendingMirrorResults = new Map();
    this.persistQueue = Promise.resolve();
    this.webSocketServer = null;
    this.heartbeatTimer = null;
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.devices)) {
        throw new Error('Unsupported gateway state schema.');
      }
      for (const entry of parsed.devices) {
        const device = restoreDevice(entry);
        if (device) this.devices.set(device.id, device);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new CodexDeviceGatewayError('CODEX_GATEWAY_STATE_INVALID', `Device gateway state could not be loaded: ${error.message}`, 500);
      }
      await this._persist();
    }
    return this.status();
  }

  status() {
    this._cleanup();
    const devices = [...this.devices.values()];
    return {
      schemaVersion: 1,
      transport: 'outbound-websocket',
      endpoint: '/v1/device-tunnel',
      pairedDevices: devices.filter((device) => !device.revokedAt).length,
      onlineDevices: devices.filter((device) => this._isOnline(device)).length,
      activeConnections: this.connections.size,
      pendingPairingIntents: this.pairingIntents.size,
      heartbeatSeconds: this.heartbeatSeconds,
      maxMessageBytes: MAX_MESSAGE_BYTES,
    };
  }

  createPairingIntent({ ownerId, orgId = '', requestedRole = 'controller', deviceName = '' } = {}) {
    this._cleanup();
    const normalizedOwnerId = normalizeIdentity(ownerId, 'ownerId');
    const normalizedRole = normalizeRole(requestedRole);
    const nowMs = this._nowMs();
    const code = uniquePairingCode(this.pairingIntents, this.newPairingCode);
    const intent = {
      id: `pair-${this.newId()}`,
      ownerId: normalizedOwnerId,
      orgId: normalizeOptionalIdentity(orgId, 'orgId'),
      requestedRole: normalizedRole,
      deviceName: normalizeDeviceName(deviceName, { optional: true }),
      codeHash: secretHashHex(code),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + PAIRING_TTL_MS).toISOString(),
      consumedAt: null,
    };
    this.pairingIntents.set(intent.id, intent);
    void this._audit('pairing_intent.created', { ownerId: normalizedOwnerId, pairingIntentId: intent.id, requestedRole: normalizedRole });
    return {
      pairingIntent: {
        id: intent.id,
        code,
        expiresAt: intent.expiresAt,
        requestedRole: intent.requestedRole,
        deviceName: intent.deviceName,
      },
    };
  }

  async claimPairing({
    pairingIntentId,
    code,
    deviceName,
    publicKey = '',
    capabilities = [],
    relayVersion = '',
    codexBuild = '',
  } = {}) {
    this._cleanup();
    const intent = this.pairingIntents.get(String(pairingIntentId || '').trim());
    if (!intent || intent.consumedAt || Date.parse(intent.expiresAt) <= this._nowMs()) {
      throw new CodexDeviceGatewayError('CODEX_PAIRING_EXPIRED', 'The pairing intent is missing, expired, or already consumed.', 410);
    }
    if (!secretsMatchHex(intent.codeHash, normalizePairingCode(code))) {
      throw new CodexDeviceGatewayError('CODEX_PAIRING_CODE_INVALID', 'The pairing code is invalid.', 401);
    }
    const token = this.newSecret();
    const timestamp = this._nowIso();
    const device = {
      id: `dev-${this.newId()}`,
      ownerId: intent.ownerId,
      orgId: intent.orgId,
      name: normalizeDeviceName(deviceName || intent.deviceName || 'Windows device'),
      role: intent.requestedRole,
      tokenHash: secretHashHex(token),
      publicKey: normalizePublicKey(publicKey),
      capabilities: normalizeCapabilities(capabilities),
      relayVersion: normalizeVersion(relayVersion),
      codexBuild: normalizeVersion(codexBuild),
      pairedAt: timestamp,
      lastSeenAt: null,
      disconnectedAt: null,
      revokedAt: null,
      presence: { online: false, codex: { running: false, windowId: '' } },
      connector: { lastCommandAt: null, lastCommand: '', lastResultAt: null, lastResult: null },
    };
    intent.consumedAt = timestamp;
    this.pairingIntents.delete(intent.id);
    this.devices.set(device.id, device);
    await this._persist();
    await this._audit('device.paired', { ownerId: device.ownerId, deviceId: device.id, capabilities: device.capabilities });
    return {
      device: this._publicDevice(device),
      credentials: { deviceToken: token, returnedOnce: true },
      gateway: { path: '/v1/device-tunnel', transport: 'outbound-websocket' },
    };
  }

  listDevices({ ownerId } = {}) {
    this._cleanup();
    const normalizedOwnerId = normalizeIdentity(ownerId, 'ownerId');
    return [...this.devices.values()]
      .filter((device) => device.ownerId === normalizedOwnerId && !device.revokedAt)
      .map((device) => this._publicDevice(device))
      .sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
  }

  async heartbeat(deviceId, token, payload = {}) {
    const device = this.authenticateDevice(deviceId, token);
    this._applyPresence(device, payload);
    await this._persist();
    return this._publicDevice(device);
  }

  async revokeDevice(deviceId, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    const timestamp = this._nowIso();
    device.revokedAt = timestamp;
    device.presence = { ...device.presence, online: false };
    device.disconnectedAt = timestamp;
    const connection = this.connections.get(device.id);
    this.connections.delete(device.id);
    connection?.close(4003, 'device revoked');
    await this._persist();
    await this._audit('device.revoked', { ownerId: device.ownerId, deviceId: device.id });
    return { revoked: true, deviceId: device.id, revokedAt: timestamp };
  }

  authenticateDevice(deviceId, token) {
    this._cleanup();
    const device = this.devices.get(String(deviceId || '').trim());
    if (!device || device.revokedAt || !secretsMatchHex(device.tokenHash, String(token || ''))) {
      throw new CodexDeviceGatewayError('CODEX_DEVICE_UNAUTHORIZED', 'The device credentials are invalid or revoked.', 401);
    }
    return device;
  }

  getDevice(deviceId, { ownerId } = {}) {
    return this._publicDevice(this._ownedDevice(deviceId, ownerId));
  }

  isDeviceOnline(deviceId, { ownerId } = {}) {
    return this._isOnline(this._ownedDevice(deviceId, ownerId));
  }

  offerSession(deviceId, session, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    return this._send(device, {
      type: 'session.offer',
      session: sanitizeSessionEnvelope(session),
    });
  }

  sendSessionMessage(deviceId, sessionId, message, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    return this._send(device, {
      type: 'session.message',
      sessionId: normalizeSessionId(sessionId),
      message: sanitizeRelayMessage(message),
    });
  }

  closeRemoteSession(deviceId, sessionId, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    this.sessionEvents.delete(normalizeSessionId(sessionId));
    if (!this._isOnline(device)) return { delivered: false, reason: 'offline' };
    return this._send(device, { type: 'session.close', sessionId: normalizeSessionId(sessionId) });
  }

  async openMirrorSource(deviceId, sessionId, sourceUrl, { ownerId } = {}) {
    const device = this._mirrorDevice(deviceId, ownerId);
    const normalizedSessionId = normalizeMirrorSessionId(sessionId);
    this.mirrorStates.set(mirrorStateKey(device.id, normalizedSessionId), {
      sessionId: normalizedSessionId,
      deviceId: device.id,
      state: 'requested',
      operation: 'open',
      ok: null,
      message: '',
      updatedAt: this._nowIso(),
    });
    return this._sendMirrorAndWait(device, 'open', {
      type: 'mirror.open',
      sessionId: normalizedSessionId,
      sourceUrl: normalizeMirrorSourceUrl(sourceUrl),
    });
  }

  setMirrorInputTarget(deviceId, sessionId, target, { ownerId } = {}) {
    const device = this._mirrorDevice(deviceId, ownerId);
    return this._sendMirrorAndWait(device, 'input-target', {
      type: 'mirror.input-target',
      sessionId: normalizeMirrorSessionId(sessionId),
      target: sanitizeMirrorInputTarget(target),
    });
  }

  sendMirrorInput(deviceId, sessionId, event, { ownerId } = {}) {
    const device = this._mirrorDevice(deviceId, ownerId);
    const normalizedSessionId = normalizeMirrorSessionId(sessionId);
    const envelope = {
      type: 'mirror.input',
      sessionId: normalizedSessionId,
      event: sanitizeMirrorInputEvent(event),
    };
    const isHighFrequencyMove = event?.type === 'mouse' && event?.action === 'move';
    return isHighFrequencyMove
      ? this._send(device, envelope)
      : this._sendMirrorAndWait(device, 'input', {
        ...envelope,
        requestId: `mirror-input-${this.newId()}`,
      });
  }

  closeRemoteMirror(deviceId, sessionId, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    if (!this._isOnline(device)) return { delivered: false, reason: 'offline' };
    return this._send(device, { type: 'mirror.close', sessionId: normalizeMirrorSessionId(sessionId) });
  }

  getMirrorState(deviceId, sessionId, { ownerId } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    const state = this.mirrorStates.get(mirrorStateKey(device.id, normalizeMirrorSessionId(sessionId)));
    return state ? { ...state } : null;
  }

  sendConnectorCommand(deviceId, { ownerId, operation } = {}) {
    const device = this._ownedDevice(deviceId, ownerId);
    const normalizedOperation = normalizeConnectorOperation(operation);
    const delivered = this._send(device, {
      type: 'connector.command',
      operation: normalizedOperation,
    });
    device.connector = {
      ...device.connector,
      lastCommandAt: delivered.sentAt,
      lastCommand: normalizedOperation,
    };
    void this._persist();
    void this._audit('connector.command_sent', {
      ownerId: device.ownerId,
      deviceId: device.id,
      operation: normalizedOperation,
    });
    return { ...delivered, operation: normalizedOperation };
  }

  listSessionEvents(sessionId, { after = 0, limit = 100 } = {}) {
    const cursor = normalizeCursor(after);
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 30));
    const events = (this.sessionEvents.get(normalizeSessionId(sessionId)) || [])
      .filter((entry) => entry.sequence > cursor)
      .slice(0, boundedLimit);
    return { events, cursor: events.at(-1)?.sequence ?? cursor };
  }

  attachServer(server) {
    if (this.webSocketServer) return this.webSocketServer;
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/v1/device-tunnel') return;
      try {
        const deviceId = url.searchParams.get('deviceId') || '';
        const token = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ''))?.[1] || '';
        const device = this.authenticateDevice(deviceId, token);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, device);
        });
      } catch (error) {
        const status = Number(error?.status) || 401;
        socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      }
    });
    webSocketServer.on('connection', (webSocket, request, device) => this._acceptConnection(webSocket, request, device));
    this.webSocketServer = webSocketServer;
    this.heartbeatTimer = setInterval(() => this._heartbeatConnections(), this.heartbeatSeconds * 1_000);
    this.heartbeatTimer.unref?.();
    return webSocketServer;
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const connection of this.connections.values()) connection.close(1001, 'gateway shutdown');
    this.connections.clear();
    if (this.webSocketServer) await new Promise((resolve) => this.webSocketServer.close(resolve));
    this.webSocketServer = null;
    await this.flush();
  }

  async flush() {
    await this.persistQueue;
  }

  _acceptConnection(webSocket, request, device) {
    const previous = this.connections.get(device.id);
    if (previous && previous !== webSocket) previous.close(4001, 'connection replaced');
    this.connections.set(device.id, webSocket);
    webSocket.isAlive = true;
    device.lastSeenAt = this._nowIso();
    device.disconnectedAt = null;
    device.presence = { ...device.presence, online: true };
    void this._persist();
    void this._audit('device.connected', {
      ownerId: device.ownerId,
      deviceId: device.id,
      transport: request.socket?.encrypted ? 'wss' : 'ws-loopback',
    });
    webSocket.on('pong', () => {
      webSocket.isAlive = true;
      device.lastSeenAt = this._nowIso();
    });
    webSocket.on('message', (bytes) => this._handleDeviceMessage(device, webSocket, bytes));
    webSocket.on('error', (error) => {
      void this._audit('device.connection_error', {
        ownerId: device.ownerId,
        deviceId: device.id,
        code: String(error?.code || 'WS_ERROR'),
      });
    });
    webSocket.on('close', () => {
      if (this.connections.get(device.id) === webSocket) this.connections.delete(device.id);
      device.disconnectedAt = this._nowIso();
      device.presence = { ...device.presence, online: false };
      void this._persist();
      void this._audit('device.disconnected', { ownerId: device.ownerId, deviceId: device.id });
    });
    webSocket.send(JSON.stringify({
      type: 'device.accept',
      deviceId: device.id,
      heartbeatSeconds: this.heartbeatSeconds,
      policyRevision: 1,
    }));
  }

  _handleDeviceMessage(device, webSocket, bytes) {
    let message;
    try {
      message = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Message must be an object.');
      const type = String(message.type || '');
      if (type === 'device.hello' || type === 'device.presence') {
        this._applyPresence(device, message);
        void this._persist();
        webSocket.send(JSON.stringify({ type: 'device.presence.ack', receivedAt: this._nowIso() }));
        return;
      }
      if (type === 'session.event') {
        this._recordSessionEvent(device, message);
        return;
      }
      if (type === 'session.ack') {
        void this._audit('session.acknowledged', {
          ownerId: device.ownerId,
          deviceId: device.id,
          sessionId: normalizeSessionId(message.sessionId),
          requestId: normalizeRequestId(message.requestId),
        });
        return;
      }
      if (type === 'connector.result') {
        this._recordConnectorResult(device, message);
        webSocket.send(JSON.stringify({ type: 'connector.result.ack', receivedAt: this._nowIso() }));
        return;
      }
      if (type === 'mirror.result') {
        this._recordMirrorResult(device, message);
        return;
      }
      throw new Error('Unsupported device message type.');
    } catch (error) {
      webSocket.send(JSON.stringify({ type: 'gateway.error', code: 'CODEX_GATEWAY_MESSAGE_INVALID', message: error.message }));
    }
  }

  _recordSessionEvent(device, message) {
    const sessionId = normalizeSessionId(message.sessionId);
    const entries = this.sessionEvents.get(sessionId) || [];
    const previousSequence = entries.at(-1)?.sequence || 0;
    const requestedSequence = Number(message.sequence);
    const sequence = Number.isSafeInteger(requestedSequence) && requestedSequence > previousSequence
      ? requestedSequence
      : previousSequence + 1;
    entries.push({
      sequence,
      event: sanitizeRelayMessage(message.event),
      receivedAt: this._nowIso(),
      deviceId: device.id,
    });
    if (entries.length > MAX_SESSION_EVENTS) entries.splice(0, entries.length - MAX_SESSION_EVENTS);
    this.sessionEvents.set(sessionId, entries);
    device.lastSeenAt = this._nowIso();
  }

  _recordConnectorResult(device, message) {
    const operation = normalizeConnectorOperation(message.operation);
    const result = sanitizeConnectorResult(message.result);
    const timestamp = this._nowIso();
    device.connector = {
      ...device.connector,
      lastResultAt: timestamp,
      lastResult: { operation, ...result },
    };
    device.lastSeenAt = timestamp;
    void this._persist();
    void this._audit('connector.result_received', {
      ownerId: device.ownerId,
      deviceId: device.id,
      operation,
      ok: result.ok,
    });
  }

  _recordMirrorResult(device, message) {
    const sessionId = normalizeMirrorSessionId(message.sessionId);
    const operation = normalizeMirrorOperation(message.operation);
    const ok = message.ok === true;
    const requestId = normalizeRequestId(message.requestId);
    let pendingKey = mirrorPendingKey(device.id, sessionId, operation, requestId);
    let pendingQueue = this.pendingMirrorResults.get(pendingKey);
    if (!pendingQueue && !requestId) {
      const prefix = mirrorPendingKey(device.id, sessionId, operation);
      const fallback = [...this.pendingMirrorResults.entries()]
        .find(([key, queue]) => key.startsWith(prefix) && queue.length);
      if (fallback) [pendingKey, pendingQueue] = fallback;
    }
    const pending = pendingQueue?.shift();
    if (pendingQueue && !pendingQueue.length) this.pendingMirrorResults.delete(pendingKey);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok, message: String(message.message || '').trim().slice(0, 500) });
    }
    this.mirrorStates.set(mirrorStateKey(device.id, sessionId), {
      sessionId,
      deviceId: device.id,
      state: ok ? (operation === 'close' ? 'closed' : 'ready') : 'error',
      operation,
      ok,
      message: String(message.message || '').trim().slice(0, 500),
      updatedAt: this._nowIso(),
    });
    device.lastSeenAt = this._nowIso();
  }

  _applyPresence(device, payload) {
    const timestamp = this._nowIso();
    if (payload.capabilities !== undefined) device.capabilities = normalizeCapabilities(payload.capabilities);
    if (payload.relayVersion !== undefined) device.relayVersion = normalizeVersion(payload.relayVersion);
    if (payload.codexBuild !== undefined) device.codexBuild = normalizeVersion(payload.codexBuild);
    const codex = payload.codex && typeof payload.codex === 'object' ? payload.codex : device.presence?.codex;
    device.presence = {
      online: true,
      codex: {
        running: Boolean(codex?.running),
        windowId: normalizeWindowId(codex?.windowId),
      },
    };
    device.lastSeenAt = timestamp;
    device.disconnectedAt = null;
  }

  _send(device, envelope) {
    const connection = this.connections.get(device.id);
    if (!connection || connection.readyState !== 1 || !this._isOnline(device)) {
      throw new CodexDeviceGatewayError('CODEX_DEVICE_OFFLINE', 'The paired device is offline.', 409);
    }
    const outbound = {
      ...envelope,
      deviceId: device.id,
      sentAt: this._nowIso(),
    };
    const encoded = JSON.stringify(outbound);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      throw new CodexDeviceGatewayError('CODEX_GATEWAY_MESSAGE_TOO_LARGE', 'The gateway envelope exceeds the transport limit.', 413);
    }
    connection.send(encoded);
    return { delivered: true, deviceId: device.id, sentAt: outbound.sentAt };
  }

  _sendMirrorAndWait(device, operation, envelope) {
    const sessionId = normalizeMirrorSessionId(envelope.sessionId);
    const requestId = normalizeRequestId(envelope.requestId);
    const key = mirrorPendingKey(device.id, sessionId, operation, requestId);
    let entry;
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingMirrorResults.get(key) || [];
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length) this.pendingMirrorResults.delete(key);
        reject(new CodexDeviceGatewayError('CODEX_MIRROR_EXECUTION_TIMEOUT', 'The paired device did not confirm the Mirror operation.', 504));
      }, this.mirrorResultTimeoutMs);
      entry = { resolve, reject, timer };
      const queue = this.pendingMirrorResults.get(key) || [];
      queue.push(entry);
      this.pendingMirrorResults.set(key, queue);
    });
    try {
      this._send(device, envelope);
    } catch (error) {
      const queue = this.pendingMirrorResults.get(key) || [];
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) this.pendingMirrorResults.delete(key);
      clearTimeout(entry?.timer);
      entry?.reject(error);
      throw error;
    }
    return pending.then((result) => {
      if (!result.ok) throw new CodexDeviceGatewayError('CODEX_MIRROR_EXECUTION_FAILED', result.message || 'The paired device rejected the Mirror operation.', 409);
      return { delivered: true, deviceId: device.id, operation, requestId: requestId || null };
    });
  }

  _mirrorDevice(deviceId, ownerId) {
    const device = this._ownedDevice(deviceId, ownerId);
    const missing = ['desktop.stream', 'desktop.input'].filter((capability) => !device.capabilities.includes(capability));
    if (missing.length) {
      throw new CodexDeviceGatewayError(
        'CODEX_DEVICE_MIRROR_UNSUPPORTED',
        'The paired device connector must be updated before interactive Mirror can start.',
        409,
        { missingCapabilities: missing },
      );
    }
    return device;
  }

  _heartbeatConnections() {
    for (const [deviceId, connection] of this.connections.entries()) {
      if (connection.isAlive === false) {
        this.connections.delete(deviceId);
        connection.terminate();
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
    this._cleanup();
  }

  _ownedDevice(deviceId, ownerId) {
    const normalizedOwnerId = normalizeIdentity(ownerId, 'ownerId');
    const device = this.devices.get(String(deviceId || '').trim());
    if (!device || device.revokedAt || device.ownerId !== normalizedOwnerId) {
      throw new CodexDeviceGatewayError('CODEX_DEVICE_NOT_FOUND', 'The paired device was not found.', 404);
    }
    return device;
  }

  _publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      role: device.role,
      orgId: device.orgId,
      paired: true,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      online: this._isOnline(device),
      transport: this.connections.has(device.id) ? 'outbound-websocket' : 'offline',
      capabilities: [...device.capabilities],
      relayVersion: device.relayVersion,
      codexBuild: device.codexBuild,
      codex: { ...device.presence.codex },
      connector: publicConnector(device.connector),
    };
  }

  _isOnline(device) {
    if (!device || device.revokedAt || !device.lastSeenAt) return false;
    return this.connections.has(device.id) && this._nowMs() - Date.parse(device.lastSeenAt) <= DEVICE_OFFLINE_AFTER_MS;
  }

  _cleanup() {
    const nowMs = this._nowMs();
    for (const intent of this.pairingIntents.values()) {
      if (intent.consumedAt || Date.parse(intent.expiresAt) <= nowMs) this.pairingIntents.delete(intent.id);
    }
    for (const device of this.devices.values()) {
      if (device.lastSeenAt && nowMs - Date.parse(device.lastSeenAt) > DEVICE_OFFLINE_AFTER_MS) {
        device.presence = { ...device.presence, online: false };
      }
    }
  }

  _nowMs() {
    const value = this.now();
    const milliseconds = (value instanceof Date ? value : new Date(value)).getTime();
    if (!Number.isFinite(milliseconds)) throw new CodexDeviceGatewayError('CODEX_GATEWAY_CLOCK_INVALID', 'The gateway clock is invalid.', 500);
    return milliseconds;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }

  _persist() {
    const document = JSON.stringify({
      version: STATE_VERSION,
      updatedAt: this._nowIso(),
      devices: [...this.devices.values()].map(persistedDevice),
    }, null, 2);
    const operation = async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${document}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    };
    this.persistQueue = this.persistQueue.then(operation, operation);
    return this.persistQueue;
  }

  async _audit(type, metadata) {
    if (!this.auditPath) return;
    await mkdir(path.dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify({
      schemaVersion: 1,
      type,
      at: this._nowIso(),
      ...metadata,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function randomPairingCode() {
  const bytes = randomBytes(8);
  return [...bytes].map((value) => PAIRING_ALPHABET[value % PAIRING_ALPHABET.length]).join('');
}

function uniquePairingCode(intents, factory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = normalizePairingCode(factory());
    const hash = secretHashHex(code);
    if (![...intents.values()].some((intent) => intent.codeHash === hash)) return code;
  }
  throw new CodexDeviceGatewayError('CODEX_PAIRING_CODE_UNAVAILABLE', 'A unique pairing code could not be created.', 503);
}

function normalizePairingCode(value) {
  const normalized = String(value || '').trim().toUpperCase().replaceAll('-', '').replaceAll(' ', '');
  if (!/^[2-9A-HJ-NP-Z]{8}$/.test(normalized)) {
    throw new CodexDeviceGatewayError('CODEX_PAIRING_CODE_INVALID', 'The pairing code must contain eight supported characters.');
  }
  return normalized;
}

function normalizeIdentity(value, field) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9@._:-]{3,180}$/.test(normalized)) {
    throw new CodexDeviceGatewayError('CODEX_GATEWAY_IDENTITY_INVALID', `${field} is invalid.`);
  }
  return normalized;
}

function normalizeOptionalIdentity(value, field) {
  return value ? normalizeIdentity(value, field) : '';
}

function normalizeRole(value) {
  const role = String(value || 'controller').trim().toLowerCase();
  if (!['controller', 'viewer'].includes(role)) throw new CodexDeviceGatewayError('CODEX_PAIRING_ROLE_INVALID', 'The requested device role is invalid.');
  return role;
}

function normalizeDeviceName(value, { optional = false } = {}) {
  const name = String(value || '').trim();
  if (optional && !name) return '';
  if (!name || name.length > 120 || /[\u0000-\u001f]/u.test(name)) {
    throw new CodexDeviceGatewayError('CODEX_DEVICE_NAME_INVALID', 'Device name must contain 1-120 printable characters.');
  }
  return name;
}

function normalizePublicKey(value) {
  const key = String(value || '').trim();
  if (key.length > 8_192) throw new CodexDeviceGatewayError('CODEX_DEVICE_PUBLIC_KEY_INVALID', 'Device public key is too large.');
  return key;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new CodexDeviceGatewayError('CODEX_DEVICE_CAPABILITIES_INVALID', 'Device capabilities are invalid.');
  }
  const normalized = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (normalized.some((item) => !/^[a-z0-9._:-]{2,80}$/.test(item))) {
    throw new CodexDeviceGatewayError('CODEX_DEVICE_CAPABILITIES_INVALID', 'Device capabilities are invalid.');
  }
  return normalized;
}

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (version.length > 120 || /[\u0000-\u001f]/u.test(version)) {
    throw new CodexDeviceGatewayError('CODEX_DEVICE_VERSION_INVALID', 'Device version metadata is invalid.');
  }
  return version;
}

function normalizeWindowId(value) {
  const windowId = String(value || '').trim();
  return /^[A-Za-z0-9x_-]{0,80}$/.test(windowId) ? windowId : '';
}

function normalizeConnectorOperation(value) {
  const operation = String(value || '').trim().toLowerCase();
  if (!['reconnect', 'repair', 'rollback'].includes(operation)) {
    throw new CodexDeviceGatewayError('CODEX_CONNECTOR_OPERATION_INVALID', 'The connector operation is invalid.');
  }
  return operation;
}

function sanitizeConnectorResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexDeviceGatewayError('CODEX_CONNECTOR_RESULT_INVALID', 'The connector result is invalid.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024) {
    throw new CodexDeviceGatewayError('CODEX_CONNECTOR_RESULT_INVALID', 'The connector result is too large.');
  }
  return {
    ok: value.ok === true,
    state: String(value.state || '').slice(0, 80),
    message: String(value.message || '').slice(0, 500),
    runtimeReady: Boolean(value.runtimeReady),
    fromVersion: String(value.fromVersion || '').slice(0, 80),
    toVersion: String(value.toVersion || '').slice(0, 80),
  };
}

function publicConnector(value) {
  return {
    lastCommandAt: value?.lastCommandAt || null,
    lastCommand: String(value?.lastCommand || ''),
    lastResultAt: value?.lastResultAt || null,
    lastResult: value?.lastResult && typeof value.lastResult === 'object'
      ? { ...value.lastResult }
      : null,
  };
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(sessionId)) {
    throw new CodexDeviceGatewayError('CODEX_GATEWAY_SESSION_INVALID', 'The gateway session id is invalid.');
  }
  return sessionId;
}

function normalizeMirrorSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^mirror-[A-Za-z0-9-]{8,140}$/.test(sessionId)) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_SESSION_INVALID', 'The Native Mirror session id is invalid.');
  }
  return sessionId;
}

function normalizeMirrorSourceUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_SOURCE_URL_INVALID', 'The Native Mirror source URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/codex-native-mirror.html' || !url.hash || url.toString().length > 4_096) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_SOURCE_URL_INVALID', 'The Native Mirror source URL is invalid.');
  }
  return url.toString();
}

function sanitizeMirrorInputTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_INPUT_TARGET_INVALID', 'The Native Mirror input target is invalid.');
  }
  const label = String(value.label || '').trim().slice(0, 300);
  if (!label) throw new CodexDeviceGatewayError('CODEX_MIRROR_INPUT_TARGET_INVALID', 'The Native Mirror input target is invalid.');
  return {
    label,
    width: normalizeMirrorDimension(value.width),
    height: normalizeMirrorDimension(value.height),
  };
}

function sanitizeMirrorInputEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_INPUT_INVALID', 'The Native Mirror input event is invalid.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 8 * 1024) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_INPUT_INVALID', 'The Native Mirror input event is too large.');
  }
  return JSON.parse(encoded);
}

function normalizeMirrorDimension(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 && number <= 32_768 ? Math.round(number) : 0;
}

function normalizeMirrorOperation(value) {
  const operation = String(value || '').trim();
  if (!['open', 'input-target', 'input', 'close'].includes(operation)) {
    throw new CodexDeviceGatewayError('CODEX_MIRROR_OPERATION_INVALID', 'The Native Mirror operation is invalid.');
  }
  return operation;
}

function mirrorStateKey(deviceId, sessionId) {
  return `${deviceId}:${sessionId}`;
}

function mirrorPendingKey(deviceId, sessionId, operation, requestId = '') {
  return `${deviceId}:${sessionId}:${operation}:${requestId}`;
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{0,180}$/.test(requestId) ? requestId : '';
}

function normalizeCursor(value) {
  const cursor = Number(value || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new CodexDeviceGatewayError('CODEX_GATEWAY_CURSOR_INVALID', 'The gateway cursor is invalid.');
  return cursor;
}

function sanitizeSessionEnvelope(session) {
  return {
    id: normalizeSessionId(session?.id),
    mode: String(session?.mode || 'semantic') === 'semantic' ? 'semantic' : 'native_mirror',
    requestedCapabilities: normalizeCapabilities(session?.requestedCapabilities || []),
    ticketExpiresAt: String(session?.ticketExpiresAt || ''),
    adapterVersion: normalizeVersion(session?.adapterVersion || ''),
  };
}

function sanitizeRelayMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexDeviceGatewayError('CODEX_GATEWAY_MESSAGE_INVALID', 'Relay messages must be JSON objects.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES / 2) {
    throw new CodexDeviceGatewayError('CODEX_GATEWAY_MESSAGE_TOO_LARGE', 'Relay message exceeds the gateway limit.', 413);
  }
  return JSON.parse(encoded);
}

function secretHashHex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function secretsMatchHex(expectedHex, value) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedHex || '')) || typeof value !== 'string') return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(secretHashHex(value), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function persistedDevice(device) {
  return {
    id: device.id,
    ownerId: device.ownerId,
    orgId: device.orgId,
    name: device.name,
    role: device.role,
    tokenHash: device.tokenHash,
    publicKey: device.publicKey,
    capabilities: [...device.capabilities],
    relayVersion: device.relayVersion,
    codexBuild: device.codexBuild,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    disconnectedAt: device.disconnectedAt,
    revokedAt: device.revokedAt,
    presence: {
      online: false,
      codex: { ...device.presence.codex },
    },
    connector: publicConnector(device.connector),
  };
}

function restoreDevice(value) {
  try {
    const device = {
      id: String(value?.id || ''),
      ownerId: normalizeIdentity(value?.ownerId, 'ownerId'),
      orgId: normalizeOptionalIdentity(value?.orgId, 'orgId'),
      name: normalizeDeviceName(value?.name),
      role: normalizeRole(value?.role),
      tokenHash: String(value?.tokenHash || ''),
      publicKey: normalizePublicKey(value?.publicKey),
      capabilities: normalizeCapabilities(value?.capabilities || []),
      relayVersion: normalizeVersion(value?.relayVersion),
      codexBuild: normalizeVersion(value?.codexBuild),
      pairedAt: String(value?.pairedAt || ''),
      lastSeenAt: value?.lastSeenAt ? String(value.lastSeenAt) : null,
      disconnectedAt: value?.disconnectedAt ? String(value.disconnectedAt) : null,
      revokedAt: value?.revokedAt ? String(value.revokedAt) : null,
      presence: {
        online: false,
        codex: {
          running: Boolean(value?.presence?.codex?.running),
          windowId: normalizeWindowId(value?.presence?.codex?.windowId),
        },
      },
      connector: publicConnector(value?.connector),
    };
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(device.id) || !/^[a-f0-9]{64}$/i.test(device.tokenHash)) return null;
    return device;
  } catch {
    return null;
  }
}
