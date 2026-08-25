import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/v1/native-mirror/input';
const DEFAULT_MAX_PAYLOAD = 64 * 1024;
const DEFAULT_MAX_DISCRETE_IN_FLIGHT = 64;

export class CodexNativeMirrorInputChannelError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CodexNativeMirrorInputChannelError';
    this.code = code;
    this.status = status;
  }
}

export function createCodexNativeMirrorInputChannel(options = {}) {
  return new CodexNativeMirrorInputChannel(options);
}

export class CodexNativeMirrorInputChannel {
  constructor({
    mirrorService,
    path = DEFAULT_PATH,
    maxPayload = DEFAULT_MAX_PAYLOAD,
    maxDiscreteInFlight = DEFAULT_MAX_DISCRETE_IN_FLIGHT,
  } = {}) {
    if (
      !mirrorService
      || typeof mirrorService.getSession !== 'function'
      || typeof mirrorService.sendInput !== 'function'
      || typeof mirrorService.sendViewerInput !== 'function'
    ) {
      throw new CodexNativeMirrorInputChannelError(
        'CODEX_MIRROR_INPUT_CHANNEL_SERVICE_REQUIRED',
        'A Native Mirror service is required.',
        500,
      );
    }
    this.mirrorService = mirrorService;
    this.path = String(path || DEFAULT_PATH);
    this.maxPayload = Math.min(256 * 1024, Math.max(8 * 1024, Number(maxPayload) || DEFAULT_MAX_PAYLOAD));
    this.maxDiscreteInFlight = Math.min(256, Math.max(8, Number(maxDiscreteInFlight) || DEFAULT_MAX_DISCRETE_IN_FLIGHT));
    this.webSocketServer = null;
    this.connections = new Set();
  }

  attachServer(server) {
    if (this.webSocketServer) return this.webSocketServer;
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    server.on('upgrade', (request, socket, head) => {
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
    });
    webSocketServer.on('connection', (webSocket, _request, context) => this._accept(webSocket, context));
    this.webSocketServer = webSocketServer;
    return webSocketServer;
  }

  async close() {
    for (const connection of this.connections) connection.webSocket?.terminate();
    this.connections.clear();
    if (!this.webSocketServer) return;
    await new Promise((resolve) => this.webSocketServer.close(resolve));
    this.webSocketServer = null;
  }

  _authorizeQuery(url) {
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    const role = String(url.searchParams.get('role') || '').trim();
    const token = String(url.searchParams.get('token') || '');
    if (!sessionId || !token) {
      throw new CodexNativeMirrorInputChannelError('CODEX_MIRROR_INPUT_CHANNEL_CREDENTIALS_REQUIRED', 'Mirror input credentials are required.', 401);
    }
    if (role !== 'source' && role !== 'viewer') {
      throw new CodexNativeMirrorInputChannelError('CODEX_MIRROR_INPUT_CHANNEL_ROLE_INVALID', 'The Mirror input channel role is invalid.', 403);
    }
    const details = this.mirrorService.getSession(sessionId, { role, token });
    if (role === 'viewer' && details?.session?.remote !== false) {
      throw new CodexNativeMirrorInputChannelError(
        'CODEX_MIRROR_INPUT_CHANNEL_VIEWER_REMOTE_INVALID',
        'Remote viewers must use the paired Mirror source for input.',
        403,
      );
    }
    return { sessionId, role, token };
  }

  _accept(webSocket, context) {
    const connection = {
      webSocket,
      context,
      closed: false,
      dispatchQueue: Promise.resolve(),
      discreteInFlight: 0,
      moveInFlight: false,
      latestMove: null,
    };
    this.connections.add(connection);
    webSocket.on('close', () => {
      connection.closed = true;
      connection.latestMove = null;
      this.connections.delete(connection);
    });
    webSocket.on('error', () => {
      connection.closed = true;
      connection.latestMove = null;
      this.connections.delete(connection);
    });
    webSocket.on('message', (bytes) => {
      let packet;
      try {
        packet = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        this._send(webSocket, { type: 'mirror.input-error', code: 'CODEX_MIRROR_INPUT_PACKET_INVALID', message: 'The input packet is invalid JSON.' });
        return;
      }
      this._dispatch(connection, packet);
    });
    this._send(webSocket, { type: 'mirror.input-channel', state: 'ready' });
  }

  _dispatch(connection, packet) {
    if (connection.closed || !packet || typeof packet !== 'object' || Array.isArray(packet)) return;
    const event = packet.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      this._send(connection.webSocket, { type: 'mirror.input-error', code: 'CODEX_MIRROR_INPUT_EVENT_INVALID', message: 'The input event is invalid.' });
      return;
    }
    const requestId = String(packet.requestId || '').trim();
    const telemetry = normalizeTelemetry(packet.telemetry);
    const isMove = event.type === 'mouse' && event.action === 'move';
    if (isMove) {
      connection.latestMove = event;
      if (!connection.moveInFlight) void this._flushMove(connection);
      return;
    }
    if (connection.discreteInFlight >= this.maxDiscreteInFlight) {
      if (requestId) this._send(connection.webSocket, {
        type: 'mirror.input-result',
        requestId,
        ok: false,
        delivered: false,
        targetFound: true,
        message: 'The Mirror input pipeline is full. Retry the event.',
      });
      return;
    }
    connection.discreteInFlight += 1;
    connection.dispatchQueue = connection.dispatchQueue
      .then(() => {
        void this._deliverDiscrete(connection, { event, requestId, telemetry });
      })
      .catch(() => {});
  }

  async _deliverDiscrete(connection, { event, requestId, telemetry }) {
    const relayAcceptedAt = Date.now();
    try {
      const result = await this._sendInput(connection, event);
      const bridgeDeliveredAt = Date.now();
      if (requestId) this._send(connection.webSocket, {
        type: 'mirror.input-result',
        requestId,
        ok: true,
        delivered: result?.delivered !== false,
        targetFound: result?.targetFound !== false,
        acceptedAt: relayAcceptedAt,
        deliveredAt: bridgeDeliveredAt,
        telemetry: { ...telemetry, relayAcceptedAt, bridgeDeliveredAt },
      });
    } catch (error) {
      const bridgeDeliveredAt = Date.now();
      if (requestId) this._send(connection.webSocket, {
        type: 'mirror.input-result',
        requestId,
        ok: false,
        delivered: false,
        targetFound: error?.code !== 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND',
        message: String(error?.message || error).slice(0, 500),
        acceptedAt: relayAcceptedAt,
        deliveredAt: bridgeDeliveredAt,
        telemetry: { ...telemetry, relayAcceptedAt, bridgeDeliveredAt },
      });
    } finally {
      connection.discreteInFlight = Math.max(0, connection.discreteInFlight - 1);
    }
  }

  async _flushMove(connection) {
    const event = connection.latestMove;
    connection.latestMove = null;
    if (!event || connection.closed) return;
    connection.moveInFlight = true;
    try {
      await this._sendInput(connection, event);
    } catch {
      // Pointer motion is best effort; the next move or a discrete event will surface recovery.
    } finally {
      connection.moveInFlight = false;
      if (connection.latestMove && !connection.closed) void this._flushMove(connection);
    }
  }

  _send(webSocket, packet) {
    if (webSocket.readyState === webSocket.OPEN) webSocket.send(JSON.stringify(packet));
  }

  _sendInput(connection, event) {
    return connection.context.role === 'viewer'
      ? this.mirrorService.sendViewerInput(connection.context.sessionId, connection.context, event)
      : this.mirrorService.sendInput(connection.context.sessionId, connection.context, event);
  }
}

function normalizeTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const key of ['viewerSentAt', 'sourceReceivedAt']) {
    const timestamp = Number(value[key]);
    if (Number.isFinite(timestamp) && timestamp > 0) normalized[key] = timestamp;
  }
  return normalized;
}

function rejectUpgrade(socket, error) {
  const status = Math.min(599, Math.max(400, Number(error?.status) || 401));
  const body = `${String(error?.message || 'Unauthorized')}\n`;
  socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}
