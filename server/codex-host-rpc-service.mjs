import { WebSocket, WebSocketServer } from 'ws';

const RPC_PROTOCOL = 'codex-host-rpc.v1';
const RPC_VERSION = 1;
const STREAM_PATH = /^\/api\/codex-relay\/sessions\/([^/]+)\/stream$/u;
const TICKET_PROTOCOL_PREFIX = 'codex-ticket.';

export function createCodexHostRpcService(options = {}) {
  return new CodexHostRpcService(options);
}

export class CodexHostRpcService {
  constructor({
    relayService,
    commandService,
    allowedOrigin = '',
    pollIntervalMs = 75,
    heartbeatMs = 15_000,
    maxPayloadBytes = 2 * 1024 * 1024,
    maxBufferedBytes = 2 * 1024 * 1024,
  } = {}) {
    if (!relayService?.openEventStream || !relayService?.listStreamEvents) {
      throw new Error('Codex Relay stream service is required.');
    }
    this.relayService = relayService;
    this.commandService = commandService;
    this.allowedOrigin = String(allowedOrigin || '');
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatMs = heartbeatMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.connections = new Map();
    this.server = null;
    this.upgradeHandler = null;
    this.pumpTimer = null;
    this.heartbeatTimer = null;
    this.stats = {
      acceptedConnections: 0,
      rejectedConnections: 0,
      eventsSent: 0,
      acknowledgements: 0,
      resumes: 0,
      backpressurePauses: 0,
      protocolErrors: 0,
      commandRequests: 0,
      commandResults: 0,
      commandErrors: 0,
    };
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: maxPayloadBytes,
      handleProtocols(protocols) {
        return protocols.has(RPC_PROTOCOL) ? RPC_PROTOCOL : false;
      },
    });
  }

  attachServer(server) {
    if (this.server) return this.webSocketServer;
    this.server = server;
    this.upgradeHandler = (request, socket, head) => this._handleUpgrade(request, socket, head);
    server.on('upgrade', this.upgradeHandler);
    this.webSocketServer.on('connection', (webSocket, request, stream) => this._accept(webSocket, request, stream));
    this.pumpTimer = setInterval(() => this._pumpAll(), this.pollIntervalMs);
    this.pumpTimer.unref?.();
    this.heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    return this.webSocketServer;
  }

  status() {
    return {
      schemaVersion: 1,
      protocol: RPC_PROTOCOL,
      version: RPC_VERSION,
      available: Boolean(this.server),
      path: '/api/codex-relay/sessions/:sessionId/stream',
      activeStreams: this.connections.size,
      commandService: this.commandService?.status?.() || null,
      ...this.stats,
    };
  }

  async close() {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pumpTimer = null;
    this.heartbeatTimer = null;
    if (this.server && this.upgradeHandler) this.server.off('upgrade', this.upgradeHandler);
    this.server = null;
    this.upgradeHandler = null;
    for (const connection of this.connections.values()) connection.webSocket.close(1001, 'host rpc shutdown');
    for (const streamId of this.connections.keys()) this.relayService.closeEventStream(streamId);
    this.connections.clear();
    await new Promise((resolve) => this.webSocketServer.close(() => resolve()));
  }

  _handleUpgrade(request, socket, head) {
    const url = new URL(request.url || '/', 'http://localhost');
    const matched = STREAM_PATH.exec(url.pathname);
    if (!matched) return;
    try {
      if (!originAllowed(request.headers.origin, this.allowedOrigin)) {
        this.stats.rejectedConnections += 1;
        this._rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const protocols = String(request.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!protocols.includes(RPC_PROTOCOL)) throw new Error('Host RPC protocol is required.');
      const ticket = protocols.find((entry) => entry.startsWith(TICKET_PROTOCOL_PREFIX))?.slice(TICKET_PROTOCOL_PREFIX.length) || '';
      const sessionId = decodeURIComponent(matched[1]);
      const browserInstanceId = String(url.searchParams.get('browserInstanceId') || '');
      const stream = this.relayService.openEventStream(sessionId, { ticket, browserInstanceId });
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit('connection', webSocket, request, stream);
      });
    } catch (error) {
      this.stats.rejectedConnections += 1;
      this._rejectUpgrade(socket, Number(error?.status) || 401, 'Unauthorized');
    }
  }

  _accept(webSocket, request, stream) {
    const connection = {
      webSocket,
      streamId: stream.id,
      sessionId: stream.sessionId,
      cursor: stream.cursor,
      pumping: false,
      alive: true,
    };
    this.connections.set(stream.id, connection);
    this.stats.acceptedConnections += 1;
    webSocket.on('pong', () => { connection.alive = true; });
    webSocket.on('message', (data) => void this._handleMessage(connection, data));
    webSocket.on('close', () => this._closeConnection(connection));
    webSocket.on('error', () => this._closeConnection(connection));
    const commandCapabilities = this.commandService?.capabilities?.() || null;
    this._send(webSocket, {
      rpc: RPC_PROTOCOL,
      version: RPC_VERSION,
      kind: 'hello',
      stream,
      capabilities: [
        'events',
        'ack',
        'resume',
        'ping',
        ...(commandCapabilities ? ['commands', ...commandCapabilities.methods] : []),
        'http-message-fallback',
      ],
      recipes: commandCapabilities?.recipes || [],
    });
    void this._pump(connection);
  }

  async _handleMessage(connection, data) {
    let requestId = null;
    try {
      const message = JSON.parse(String(data));
      requestId = message?.id ?? null;
      if (message?.rpc !== RPC_PROTOCOL || message?.version !== RPC_VERSION) {
        throw new Error('Unsupported Host RPC envelope.');
      }
      if (message.kind === 'ack') {
        const stream = this.relayService.acknowledgeStream(connection.streamId, message.cursor);
        this.stats.acknowledgements += 1;
        if (message.id != null) this._sendResult(connection.webSocket, message.id, { stream });
        return;
      }
      if (message.kind === 'resume') {
        const stream = this.relayService.resumeStream(connection.streamId, message.cursor);
        connection.cursor = stream.cursor;
        this.stats.resumes += 1;
        this._sendResult(connection.webSocket, message.id, { stream });
        void this._pump(connection);
        return;
      }
      if (message.kind === 'ping') {
        this._send(connection.webSocket, { rpc: RPC_PROTOCOL, version: RPC_VERSION, kind: 'pong', id: message.id ?? null });
        return;
      }
      if (message.kind === 'request') {
        if (!['host.message.send', 'host.worker.send'].includes(message.method)) {
          const error = new Error(`Unsupported Host RPC request method: ${String(message?.method || '')}`);
          error.code = 'CODEX_HOST_RPC_METHOD_NOT_FOUND';
          error.status = 404;
          throw error;
        }
        if (typeof message.id !== 'string' || !message.id) {
          const error = new Error('Host RPC requests require a string id.');
          error.code = 'CODEX_HOST_RPC_REQUEST_ID_REQUIRED';
          throw error;
        }
        this.stats.commandRequests += 1;
        try {
          const result = message.method === 'host.worker.send'
            ? await this.commandService.sendWorkerStream(connection.streamId, {
              relaySessionId: connection.sessionId,
              commandId: message.id,
              leaseEpoch: message.params?.leaseEpoch,
              workerId: message.params?.workerId,
              message: message.params?.message,
            })
            : await this.commandService.sendStream(connection.streamId, {
              relaySessionId: connection.sessionId,
              commandId: message.id,
              leaseEpoch: message.params?.leaseEpoch,
              message: message.params?.message,
            });
          this.stats.commandResults += 1;
          this._sendResult(connection.webSocket, message.id, result);
        } catch (error) {
          this.stats.commandErrors += 1;
          this._sendError(connection.webSocket, message.id, error);
        }
        return;
      }
      throw new Error(`Unsupported Host RPC message kind: ${String(message?.kind || '')}`);
    } catch (error) {
      this.stats.protocolErrors += 1;
      this._sendError(connection.webSocket, requestId, error, 'CODEX_HOST_RPC_PROTOCOL_ERROR');
    }
  }

  _pumpAll() {
    for (const connection of this.connections.values()) void this._pump(connection);
  }

  async _pump(connection) {
    if (connection.pumping || connection.webSocket.readyState !== WebSocket.OPEN) return;
    if (connection.webSocket.bufferedAmount > this.maxBufferedBytes) {
      this.stats.backpressurePauses += 1;
      return;
    }
    connection.pumping = true;
    try {
      const result = this.relayService.listStreamEvents(connection.streamId, {
        after: connection.cursor,
        limit: 100,
      });
      for (const item of result.events) {
        if (connection.webSocket.readyState !== WebSocket.OPEN) break;
        this._send(connection.webSocket, {
          rpc: RPC_PROTOCOL,
          version: RPC_VERSION,
          kind: 'event',
          sequence: item.sequence,
          event: item.event,
          message: item.message,
        });
        connection.cursor = Number(item.sequence);
        this.stats.eventsSent += 1;
      }
    } catch (error) {
      this._send(connection.webSocket, {
        rpc: RPC_PROTOCOL,
        version: RPC_VERSION,
        kind: 'error',
        code: error?.code || 'CODEX_HOST_RPC_STREAM_ERROR',
        message: String(error?.message || error),
      });
      connection.webSocket.close(1011, 'stream unavailable');
    } finally {
      connection.pumping = false;
    }
  }

  _heartbeat() {
    for (const connection of this.connections.values()) {
      if (!connection.alive) {
        connection.webSocket.terminate();
        this._closeConnection(connection);
        continue;
      }
      connection.alive = false;
      connection.webSocket.ping();
    }
  }

  _closeConnection(connection) {
    if (this.connections.get(connection.streamId) !== connection) return;
    this.connections.delete(connection.streamId);
    this.relayService.closeEventStream(connection.streamId);
  }

  _sendResult(webSocket, id, result) {
    this._send(webSocket, { rpc: RPC_PROTOCOL, version: RPC_VERSION, kind: 'result', id: id ?? null, result });
  }

  _sendError(webSocket, id, error, fallbackCode = 'CODEX_HOST_RPC_COMMAND_ERROR') {
    this._send(webSocket, {
      rpc: RPC_PROTOCOL,
      version: RPC_VERSION,
      kind: 'error',
      id: id ?? null,
      code: error?.code || fallbackCode,
      message: String(error?.message || error),
    });
  }

  _send(webSocket, payload) {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(payload));
  }

  _rejectUpgrade(socket, status, label) {
    socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}

function originAllowed(value, allowedOrigin) {
  const origin = String(value || '');
  if (allowedOrigin && origin === allowedOrigin) return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export { RPC_PROTOCOL, RPC_VERSION };
