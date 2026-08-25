import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/v1/native-mirror/relay';
const DEFAULT_MAX_PAYLOAD = 2 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const CONTROL_TYPES = Object.freeze({
  source: new Set(['mirror.media-config', 'mirror.media-state', 'mirror.input-result', 'mirror.pong', 'mirror.activate']),
  viewer: new Set(['mirror.input', 'mirror.pointer', 'mirror.ping', 'mirror.activate']),
});

export class CodexNativeMirrorRelayChannelError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CodexNativeMirrorRelayChannelError';
    this.code = code;
    this.status = status;
  }
}

export function createCodexNativeMirrorRelayChannel(options = {}) {
  return new CodexNativeMirrorRelayChannel(options);
}

export class CodexNativeMirrorRelayChannel {
  constructor({
    mirrorService,
    path = DEFAULT_PATH,
    maxPayload = DEFAULT_MAX_PAYLOAD,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  } = {}) {
    if (!mirrorService || typeof mirrorService.getSession !== 'function') {
      throw new CodexNativeMirrorRelayChannelError(
        'CODEX_MIRROR_RELAY_SERVICE_REQUIRED',
        'A Native Mirror service is required.',
        500,
      );
    }
    this.mirrorService = mirrorService;
    this.path = String(path || DEFAULT_PATH);
    this.maxPayload = Math.min(8 * 1024 * 1024, Math.max(256 * 1024, Number(maxPayload) || DEFAULT_MAX_PAYLOAD));
    this.maxBufferedBytes = Math.min(32 * 1024 * 1024, Math.max(this.maxPayload, Number(maxBufferedBytes) || DEFAULT_MAX_BUFFERED_BYTES));
    this.webSocketServer = null;
    this.server = null;
    this.upgradeHandler = null;
    this.sessions = new Map();
  }

  status() {
    let sourceConnections = 0;
    let viewerConnections = 0;
    let activeSessions = 0;
    for (const session of this.sessions.values()) {
      if (session['source:control']) sourceConnections += 1;
      if (session['viewer:control']) viewerConnections += 1;
      if (session.active) activeSessions += 1;
    }
    return {
      available: true,
      transport: 'authenticated-websocket',
      path: this.path,
      sessions: this.sessions.size,
      activeSessions,
      sourceConnections,
      viewerConnections,
    };
  }

  attachServer(server) {
    if (this.webSocketServer) return this.webSocketServer;
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    this.server = server;
    this.upgradeHandler = (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== this.path) return;
      try {
        const context = this._authorizeQuery(url);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, context);
        });
      } catch (error) {
        rejectUpgrade(socket, error);
      }
    };
    server.on('upgrade', this.upgradeHandler);
    webSocketServer.on('connection', (webSocket, _request, context) => this._accept(webSocket, context));
    this.webSocketServer = webSocketServer;
    return webSocketServer;
  }

  async close() {
    if (this.server && this.upgradeHandler) this.server.off('upgrade', this.upgradeHandler);
    this.server = null;
    this.upgradeHandler = null;
    for (const session of this.sessions.values()) {
      for (const connection of Object.values(session)) {
        connection?.webSocket?.terminate();
      }
    }
    this.sessions.clear();
    if (!this.webSocketServer) return;
    await new Promise((resolve) => this.webSocketServer.close(resolve));
    this.webSocketServer = null;
  }

  _authorizeQuery(url) {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    const role = String(url.searchParams.get('role') || '').trim();
    const channel = String(url.searchParams.get('channel') || 'control').trim();
    const token = String(url.searchParams.get('token') || '');
    if (!sessionId || !token) {
      throw new CodexNativeMirrorRelayChannelError('CODEX_MIRROR_RELAY_CREDENTIALS_REQUIRED', 'Mirror relay credentials are required.', 401);
    }
    if (!['source', 'viewer'].includes(role)) {
      throw new CodexNativeMirrorRelayChannelError('CODEX_MIRROR_RELAY_ROLE_INVALID', 'Mirror relay role is invalid.', 403);
    }
    if (!['control', 'media'].includes(channel)) {
      throw new CodexNativeMirrorRelayChannelError('CODEX_MIRROR_RELAY_CHANNEL_INVALID', 'Mirror relay channel is invalid.', 400);
    }
    this.mirrorService.getSession(sessionId, { role, token });
    return { sessionId, role, token, channel };
  }

  _accept(webSocket, context) {
    const relaySession = this.sessions.get(context.sessionId) || {
      'source:control': null,
      'viewer:control': null,
      'source:media': null,
      'viewer:media': null,
      active: false,
      mediaConfig: null,
    };
    this.sessions.set(context.sessionId, relaySession);
    const connectionKey = `${context.role}:${context.channel}`;
    const previous = relaySession[connectionKey];
    if (previous) previous.webSocket.close(4001, 'mirror relay role replaced');
    const connection = { webSocket, context, closed: false };
    relaySession[connectionKey] = connection;

    webSocket.on('message', (data, isBinary) => this._receive(connection, relaySession, data, isBinary));
    webSocket.on('close', () => this._disconnect(connection, relaySession));
    webSocket.on('error', () => this._disconnect(connection, relaySession));
    const peer = this._peer(relaySession, context);
    this._sendJson(connection, { type: 'mirror.relay-ready', role: context.role, channel: context.channel, peerConnected: Boolean(peer) });
    if (peer) {
      if (context.channel === 'control') {
        this._sendJson(peer, { type: 'mirror.relay-peer', connected: true, active: relaySession.active });
        this._sendJson(connection, { type: 'mirror.relay-peer', connected: true, active: relaySession.active });
        if (relaySession.active) this._sendJson(relaySession['source:control'], { type: 'mirror.activate', reason: 'peer-resumed' });
      }
      if (context.channel === 'media' && relaySession.mediaConfig) this._sendJson(relaySession['viewer:control'], relaySession.mediaConfig);
    }
  }

  _receive(connection, relaySession, data, isBinary) {
    const connectionKey = `${connection.context.role}:${connection.context.channel}`;
    if (connection.closed || relaySession[connectionKey] !== connection) return;
    try {
      this.mirrorService.getSession(connection.context.sessionId, connection.context);
    } catch {
      connection.webSocket.close(4003, 'mirror session expired');
      return;
    }
    if (isBinary) {
      if (connection.context.role !== 'source' || connection.context.channel !== 'media') {
        connection.webSocket.close(4004, 'binary media is source-only');
        return;
      }
      this._forwardBinary(relaySession['viewer:media'], data);
      return;
    }

    if (connection.context.channel !== 'control') {
      connection.webSocket.close(4006, 'control packets require control channel');
      return;
    }

    let packet;
    try {
      packet = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      connection.webSocket.close(4005, 'invalid mirror relay packet');
      return;
    }
    const type = String(packet?.type || '');
    if (!CONTROL_TYPES[connection.context.role].has(type)) {
      connection.webSocket.close(4006, 'mirror relay direction rejected');
      return;
    }
    if (type === 'mirror.activate') {
      relaySession.active = true;
      this._sendJson(relaySession['source:control'], {
        type: 'mirror.activate',
        reason: String(packet.reason || 'fallback').slice(0, 80),
      });
      this._sendJson(relaySession['viewer:control'], { type: 'mirror.relay-peer', connected: Boolean(relaySession['source:control']), active: true });
      return;
    }
    if (type === 'mirror.media-config') {
      try {
        relaySession.mediaConfig = sanitizeMediaConfig(packet);
      } catch {
        connection.webSocket.close(4007, 'invalid mirror media config');
        return;
      }
    }
    const peer = connection.context.role === 'source' ? relaySession['viewer:control'] : relaySession['source:control'];
    this._sendJson(peer, type === 'mirror.media-config' ? relaySession.mediaConfig : packet);
  }

  _forwardBinary(connection, data) {
    if (!connection || connection.closed || connection.webSocket.readyState !== 1) return;
    if (connection.webSocket.bufferedAmount > this.maxBufferedBytes) return;
    connection.webSocket.send(data, { binary: true });
  }

  _sendJson(connection, packet) {
    if (!connection || connection.closed || connection.webSocket.readyState !== 1) return false;
    const payload = JSON.stringify(packet);
    if (Buffer.byteLength(payload) > 64 * 1024) return false;
    if (connection.webSocket.bufferedAmount > this.maxBufferedBytes) return false;
    connection.webSocket.send(payload);
    return true;
  }

  _disconnect(connection, relaySession) {
    if (connection.closed) return;
    connection.closed = true;
    const role = connection.context.role;
    const connectionKey = `${role}:${connection.context.channel}`;
    if (relaySession[connectionKey] === connection) relaySession[connectionKey] = null;
    if (connection.context.channel === 'control') {
      const peer = role === 'source' ? relaySession['viewer:control'] : relaySession['source:control'];
      this._sendJson(peer, { type: 'mirror.relay-peer', connected: false, active: relaySession.active });
    }
    if (!Object.values(relaySession).some((value) => value && value.webSocket)) this.sessions.delete(connection.context.sessionId);
  }

  _peer(relaySession, context) {
    const peerRole = context.role === 'source' ? 'viewer' : 'source';
    return relaySession[`${peerRole}:${context.channel}`];
  }
}

function sanitizeMediaConfig(packet) {
  const codec = String(packet.codec || '').toLowerCase();
  if (!['vp8', 'vp09.00.10.08', 'image/jpeg'].includes(codec)) {
    throw new CodexNativeMirrorRelayChannelError('CODEX_MIRROR_RELAY_CODEC_INVALID', 'Mirror relay codec is not allowed.', 400);
  }
  const codedWidth = Math.min(7680, Math.max(16, Number(packet.codedWidth) || 0));
  const codedHeight = Math.min(4320, Math.max(16, Number(packet.codedHeight) || 0));
  return {
    type: 'mirror.media-config',
    codec,
    codedWidth,
    codedHeight,
    displayAspectWidth: Math.min(7680, Math.max(16, Number(packet.displayAspectWidth) || codedWidth)),
    displayAspectHeight: Math.min(4320, Math.max(16, Number(packet.displayAspectHeight) || codedHeight)),
  };
}

function rejectUpgrade(socket, error) {
  const status = Math.min(599, Math.max(400, Number(error?.status) || 401));
  const body = `${String(error?.message || 'Unauthorized')}\n`;
  socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}
