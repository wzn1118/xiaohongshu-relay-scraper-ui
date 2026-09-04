import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const SESSION_TICKET_TTL_MS = 60_000;
const STREAM_TICKET_TTL_MS = 30_000;
const CONTROL_LEASE_TTL_MS = 30_000;
const SESSION_IDLE_TTL_MS = 30 * 60_000;
const STREAM_IDLE_TTL_MS = 60_000;
const MAX_EVENT_BATCH = 100;
const SEMANTIC_CAPABILITIES = new Set([
  'thread.read',
  'thread.write',
  'turn.start',
  'approval.respond',
  'artifact.read',
]);

export class CodexRelayServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexRelayServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexRelayService(options = {}) {
  return new CodexRelayService(options);
}

export class CodexRelayService {
  constructor({
    codexDesktopService,
    codexBrowserService,
    nativeMirrorService,
    deviceGatewayService,
    iceService,
    workspaceRoot = process.cwd(),
    deviceId,
    localOwnerId = 'local-owner',
    now = () => new Date(),
    newId = randomUUID,
    newSecret = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.codexDesktopService = codexDesktopService;
    this.codexBrowserService = codexBrowserService;
    this.nativeMirrorService = nativeMirrorService;
    this.deviceGatewayService = deviceGatewayService;
    this.iceService = iceService;
    this.localOwnerId = String(localOwnerId || 'local-owner');
    this.now = now;
    this.newId = newId;
    this.newSecret = newSecret;
    this.sessions = new Map();
    this.streamTickets = new Map();
    this.eventStreams = new Map();
    this.leaseEpoch = 0;
    this.activeLeaseSessionIds = new Map();
    this.device = {
      id: normalizeDeviceId(deviceId) || localDeviceId(workspaceRoot),
      name: 'This Windows device',
      pairedAt: null,
      lastSeenAt: null,
    };
  }

  async status() {
    this._cleanup();
    const desktop = await this._desktopStatus();
    const browser = this.codexBrowserService?.status?.() || {
      running: false,
      initialized: false,
      pid: null,
      sequence: 0,
    };
    const runtimeReady = desktop ? desktop.ready === true : false;
    const browserAvailable = Boolean(this.codexBrowserService?.send && this.codexBrowserService?.listEvents);
    const nativeMirror = this.nativeMirrorService?.status?.() || {
      available: false,
      state: 'not_configured',
      reason: 'Selected-window WebRTC capture is not configured in this local Relay build.',
    };
    return {
      schemaVersion: 1,
      relayVersion: '1.0.0',
      transport: 'loopback-http+websocket',
      inboundPublicPort: false,
      device: this._publicDevice(nativeMirror),
      adapter: {
        contractVersion: 'codex-relay.v1',
        state: runtimeReady && browserAvailable ? 'compatible' : 'unavailable',
        codexVersion: String(desktop?.version || ''),
        buildNumber: String(desktop?.buildNumber || ''),
        runtimeReady,
        browserAvailable,
      },
      modes: {
        semantic: {
          available: runtimeReady && browserAvailable,
          eventProtocol: 'codex-relay.v1',
          eventTransport: 'codex-host-rpc.v1',
          activeSessions: [...this.sessions.values()].filter((session) => session.mode === 'semantic').length,
          activeStreams: this.eventStreams.size,
        },
        nativeMirror,
      },
      gateway: this.deviceGatewayService?.status?.() || {
        transport: 'not_configured',
        pairedDevices: 0,
        onlineDevices: 0,
      },
      ice: this.iceService?.status?.() || {
        configuredServers: 0,
        turnConfigured: false,
        turnCredentialMode: 'not_configured',
      },
      browser,
    };
  }

  pair({ deviceName } = {}) {
    const name = normalizeDeviceName(deviceName);
    if (name) this.device.name = name;
    const timestamp = this._nowIso();
    this.device.pairedAt ||= timestamp;
    this.device.lastSeenAt = timestamp;
    return this._publicDevice(this.nativeMirrorService?.status?.() || null);
  }

  createShareInvite({ deviceId, ownerId = this.localOwnerId } = {}) {
    const browserInstanceId = `shared-${this.newId()}`;
    const created = this.createSession({
      deviceId,
      mode: 'semantic',
      browserSessionId: browserInstanceId,
      browserInstanceId,
      requestedCapabilities: [...SEMANTIC_CAPABILITIES],
      ownerId,
    });
    return {
      session: created.session,
      invite: {
        sessionId: created.session.id,
        ticket: created.ticket.value,
        browserInstanceId,
        expiresAt: created.ticket.expiresAt,
        singleUse: true,
      },
    };
  }

  listDevices({ ownerId = this.localOwnerId } = {}) {
    this._cleanup();
    const remote = this.deviceGatewayService?.listDevices?.({ ownerId }) || [];
    return [this._publicDevice(this.nativeMirrorService?.status?.() || null), ...remote.filter((device) => device.id !== this.device.id)];
  }

  createSession({
    deviceId,
    mode = 'semantic',
    browserSessionId,
    browserInstanceId,
    requestedCapabilities,
    ownerId = this.localOwnerId,
  } = {}) {
    this._cleanup();
    const requestedDeviceId = String(deviceId || this.device.id).trim();
    const remoteDevice = requestedDeviceId === this.device.id
      ? null
      : this.deviceGatewayService?.getDevice?.(requestedDeviceId, { ownerId });
    if (requestedDeviceId !== this.device.id && !remoteDevice) {
      throw new CodexRelayServiceError('CODEX_RELAY_DEVICE_NOT_FOUND', 'The requested paired device is not available.', 404);
    }
    if (remoteDevice && !remoteDevice.online) {
      throw new CodexRelayServiceError('CODEX_RELAY_DEVICE_OFFLINE', 'The requested paired device is offline.', 409);
    }
    if (mode !== 'semantic') {
      throw new CodexRelayServiceError(
        'CODEX_RELAY_NATIVE_MIRROR_UNAVAILABLE',
        'Native Mirror is not configured in this Relay build. Create a semantic session instead.',
        409,
        { fallbackMode: 'semantic' },
      );
    }
    const normalizedBrowserSessionId = normalizeBrowserIdentity(browserSessionId, 'browserSessionId');
    const normalizedBrowserInstanceId = normalizeBrowserIdentity(browserInstanceId || normalizedBrowserSessionId, 'browserInstanceId');
    const capabilities = normalizeCapabilities(requestedCapabilities);
    const createdAt = this._nowIso();
    const ticket = this.newSecret();
    const sessionId = `relay-${this.newId()}`;
    const issuedIce = this.iceService?.issue?.({ subject: sessionId }) || { iceServers: [], expiresAt: null, turnConfigured: false };
    const session = {
      id: sessionId,
      mode,
      deviceId: requestedDeviceId,
      ownerId: String(ownerId || this.localOwnerId),
      remote: Boolean(remoteDevice),
      adapterVersion: 'codex-relay.v1',
      browserSessionId: normalizedBrowserSessionId,
      browserInstanceId: normalizedBrowserInstanceId,
      requestedCapabilities: capabilities,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
      ticketHash: secretHash(ticket),
      ticketExpiresAt: new Date(this._nowMs() + SESSION_TICKET_TTL_MS).toISOString(),
      ticketConsumedAt: null,
      connectionHash: null,
      connectedAt: null,
      lease: null,
      rtcConfiguration: {
        iceServers: issuedIce.iceServers || [],
        expiresAt: issuedIce.expiresAt || null,
      },
    };
    if (!remoteDevice) this.pair();
    this.sessions.set(session.id, session);
    if (remoteDevice) {
      try {
        this.deviceGatewayService.offerSession(session.deviceId, this._publicSession(session), { ownerId: session.ownerId });
      } catch (error) {
        this.sessions.delete(session.id);
        throw error;
      }
    }
    return {
      session: this._publicSession(session),
      ticket: {
        value: ticket,
        expiresAt: session.ticketExpiresAt,
        singleUse: true,
      },
      adapterVersion: session.adapterVersion,
      rtcConfiguration: publicRtcConfiguration(session.rtcConfiguration),
      deviceConfirmationRequired: Boolean(remoteDevice),
    };
  }

  connect(sessionId, { ticket, browserInstanceId } = {}) {
    const session = this._session(sessionId);
    this._assertBrowserInstance(session, browserInstanceId);
    if (session.ticketConsumedAt || !session.ticketHash || this._nowMs() > Date.parse(session.ticketExpiresAt)) {
      throw new CodexRelayServiceError('CODEX_RELAY_TICKET_EXPIRED', 'The Relay session ticket has expired. Create a new session.', 401);
    }
    if (!secretsMatch(session.ticketHash, ticket)) {
      throw new CodexRelayServiceError('CODEX_RELAY_TICKET_INVALID', 'The Relay session ticket is invalid.', 401);
    }
    const connectionToken = this.newSecret();
    const connectedAt = this._nowIso();
    session.ticketConsumedAt = connectedAt;
    session.ticketHash = null;
    session.connectionHash = secretHash(connectionToken);
    session.connectedAt = connectedAt;
    this._touch(session);
    const lease = this._grantLease(session);
    return {
      session: this._publicSession(session),
      connectionToken,
      lease,
      rtcConfiguration: publicRtcConfiguration(session.rtcConfiguration),
    };
  }

  getSession(sessionId, { connectionToken } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    return this._publicSession(session);
  }

  renewLease(sessionId, { connectionToken, browserInstanceId, leaseEpoch } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    this._assertBrowserInstance(session, browserInstanceId);
    const lease = session.lease;
    if (!lease || lease.epoch !== normalizeLeaseEpoch(leaseEpoch) || !this._leaseIsActive(session)) {
      const activeSessionId = this.activeLeaseSessionIds.get(session.deviceId);
      const activeSession = activeSessionId ? this.sessions.get(activeSessionId) : null;
      if (!activeSession || !this._leaseIsActive(activeSession)) {
        const reacquired = this._grantLease(session);
        this._touch(session);
        return reacquired;
      }
      throw new CodexRelayServiceError('CODEX_RELAY_LEASE_EXPIRED', 'The control lease is owned by another active browser.', 409);
    }
    lease.expiresAt = new Date(this._nowMs() + CONTROL_LEASE_TTL_MS).toISOString();
    this._touch(session);
    return { ...lease };
  }

  releaseLease(sessionId, { connectionToken, browserInstanceId, leaseEpoch } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    this._assertBrowserInstance(session, browserInstanceId);
    if (session.lease && session.lease.epoch === normalizeLeaseEpoch(leaseEpoch)) {
      session.lease = null;
      if (this.activeLeaseSessionIds.get(session.deviceId) === session.id) this.activeLeaseSessionIds.delete(session.deviceId);
    }
    this._touch(session);
    return { released: true };
  }

  async send(sessionId, { connectionToken, browserInstanceId, leaseEpoch, message } = {}, forward) {
    const session = this._authorize(sessionId, connectionToken);
    this._assertBrowserInstance(session, browserInstanceId);
    return this._sendForSession(session, { leaseEpoch, message }, forward);
  }

  async sendStreamMessage(streamId, { leaseEpoch, message } = {}, forward) {
    const stream = this._stream(streamId);
    const session = this._session(stream.sessionId);
    this._assertBrowserInstance(session, stream.browserInstanceId);
    return this._sendForSession(session, { leaseEpoch, message }, forward);
  }

  async _sendForSession(session, { leaseEpoch, message } = {}, forward) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CodexRelayServiceError('CODEX_RELAY_MESSAGE_INVALID', 'Relay message must be a JSON object.');
    }
    if (requiresControlLease(message)) this._assertActiveLease(session, leaseEpoch);
    if (session.remote) {
      const result = this.deviceGatewayService.sendSessionMessage(
        session.deviceId,
        session.id,
        message,
        { ownerId: session.ownerId },
      );
      this._touch(session);
      return { accepted: true, transport: 'outbound-websocket', ...result };
    }
    if (typeof forward !== 'function') {
      throw new CodexRelayServiceError('CODEX_RELAY_FORWARDER_UNAVAILABLE', 'The local Codex adapter is unavailable.', 503);
    }
    const result = await forward({
      sessionId: session.browserSessionId,
      message,
      relaySession: this._publicSession(session),
    });
    this._touch(session);
    return result;
  }

  listEvents(sessionId, { connectionToken, after = 0, limit = 30 } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    return this._listEvents(session, { after, limit });
  }

  issueStreamTicket(sessionId, { connectionToken, browserInstanceId, after = 0 } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    this._assertBrowserInstance(session, browserInstanceId);
    const cursor = normalizeCursor(after);
    const ticket = this.newSecret();
    const expiresAt = new Date(this._nowMs() + STREAM_TICKET_TTL_MS).toISOString();
    this.streamTickets.set(secretKey(ticket), {
      sessionId: session.id,
      browserInstanceId: session.browserInstanceId,
      cursor,
      expiresAt,
    });
    this._touch(session);
    return {
      value: ticket,
      expiresAt,
      singleUse: true,
      protocol: 'codex-host-rpc.v1',
      cursor,
    };
  }

  openEventStream(sessionId, { ticket, browserInstanceId } = {}) {
    this._cleanup();
    const ticketKey = secretKey(ticket);
    const issued = this.streamTickets.get(ticketKey);
    this.streamTickets.delete(ticketKey);
    if (!issued || issued.sessionId !== String(sessionId || '') || issued.browserInstanceId !== String(browserInstanceId || '')) {
      throw new CodexRelayServiceError('CODEX_RELAY_STREAM_TICKET_INVALID', 'The event stream ticket is invalid.', 401);
    }
    if (this._nowMs() > Date.parse(issued.expiresAt)) {
      throw new CodexRelayServiceError('CODEX_RELAY_STREAM_TICKET_EXPIRED', 'The event stream ticket has expired.', 401);
    }
    const session = this._session(issued.sessionId);
    this._assertBrowserInstance(session, browserInstanceId);
    for (const [streamId, stream] of this.eventStreams) {
      if (stream.sessionId === session.id && stream.browserInstanceId === session.browserInstanceId) {
        this.eventStreams.delete(streamId);
      }
    }
    const streamId = `stream-${this.newId()}`;
    const openedAt = this._nowIso();
    const stream = {
      id: streamId,
      sessionId: session.id,
      browserInstanceId: session.browserInstanceId,
      cursor: issued.cursor,
      ackedCursor: issued.cursor,
      openedAt,
      lastActivityAt: openedAt,
    };
    this.eventStreams.set(stream.id, stream);
    this._touch(session);
    return this._publicStream(stream);
  }

  listStreamEvents(streamId, { after, limit = MAX_EVENT_BATCH } = {}) {
    const stream = this._stream(streamId);
    const session = this._session(stream.sessionId);
    const cursor = after == null ? stream.cursor : normalizeCursor(after);
    const result = this._listEvents(session, { after: cursor, limit });
    stream.cursor = result.cursor;
    this._touchStream(stream, session);
    return result;
  }

  acknowledgeStream(streamId, cursor) {
    const stream = this._stream(streamId);
    const acknowledged = normalizeCursor(cursor);
    if (acknowledged > stream.cursor) {
      throw new CodexRelayServiceError('CODEX_RELAY_STREAM_ACK_INVALID', 'The acknowledged cursor exceeds the sent cursor.');
    }
    stream.ackedCursor = Math.max(stream.ackedCursor, acknowledged);
    this._touchStream(stream, this._session(stream.sessionId));
    return this._publicStream(stream);
  }

  resumeStream(streamId, cursor) {
    const stream = this._stream(streamId);
    stream.cursor = normalizeCursor(cursor);
    stream.ackedCursor = Math.min(stream.ackedCursor, stream.cursor);
    this._touchStream(stream, this._session(stream.sessionId));
    return this._publicStream(stream);
  }

  closeEventStream(streamId) {
    const stream = this.eventStreams.get(String(streamId || ''));
    if (!stream) return { closed: false, streamId: String(streamId || '') };
    this.eventStreams.delete(stream.id);
    return { closed: true, streamId: stream.id };
  }

  _listEvents(session, { after = 0, limit = 30 } = {}) {
    const cursor = normalizeCursor(after);
    const boundedLimit = Math.min(MAX_EVENT_BATCH, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : 30));
    if (session.remote) {
      const remoteEvents = this.deviceGatewayService.listSessionEvents(session.id, { after: cursor, limit: boundedLimit });
      this._touch(session);
      return {
        events: remoteEvents.events.map((item) => ({
          sequence: Number(item.sequence),
          event: {
            schemaVersion: 1,
            sequence: Number(item.sequence),
            kind: 'remote-event',
            type: String(item.event?.type || ''),
            method: String(item.event?.method || ''),
            emittedAt: item.receivedAt || null,
          },
          message: item.event,
        })),
        cursor: remoteEvents.cursor,
      };
    }
    const sourceEvents = this.codexBrowserService?.listEvents?.({
      after: cursor,
      sessionId: session.browserSessionId,
    }) || [];
    const events = sourceEvents.slice(0, boundedLimit).map((item) => ({
      sequence: Number(item.sequence),
      event: normalizeBrowserEvent(item),
      message: item.message,
    }));
    this._touch(session);
    return {
      events,
      cursor: events.at(-1)?.sequence ?? cursor,
    };
  }

  closeSession(sessionId, { connectionToken } = {}) {
    const session = this._authorize(sessionId, connectionToken);
    this.sessions.delete(session.id);
    for (const [streamId, stream] of this.eventStreams) {
      if (stream.sessionId === session.id) this.eventStreams.delete(streamId);
    }
    for (const [ticketKey, ticket] of this.streamTickets) {
      if (ticket.sessionId === session.id) this.streamTickets.delete(ticketKey);
    }
    if (this.activeLeaseSessionIds.get(session.deviceId) === session.id) this.activeLeaseSessionIds.delete(session.deviceId);
    if (session.remote) this.deviceGatewayService.closeRemoteSession(session.deviceId, session.id, { ownerId: session.ownerId });
    return { closed: true, sessionId: session.id };
  }

  _session(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) throw new CodexRelayServiceError('CODEX_RELAY_SESSION_NOT_FOUND', 'The Relay session was not found.', 404);
    return session;
  }

  _stream(streamId) {
    this._cleanup();
    const stream = this.eventStreams.get(String(streamId || ''));
    if (!stream) throw new CodexRelayServiceError('CODEX_RELAY_STREAM_NOT_FOUND', 'The event stream is no longer active.', 404);
    return stream;
  }

  _authorize(sessionId, connectionToken) {
    this._cleanup();
    const session = this._session(sessionId);
    if (!session.connectionHash || !secretsMatch(session.connectionHash, connectionToken)) {
      throw new CodexRelayServiceError('CODEX_RELAY_CONNECTION_UNAUTHORIZED', 'The Relay connection is not authorized.', 401);
    }
    return session;
  }

  _assertBrowserInstance(session, browserInstanceId) {
    if (String(browserInstanceId || '').trim() !== session.browserInstanceId) {
      throw new CodexRelayServiceError('CODEX_RELAY_BROWSER_INSTANCE_MISMATCH', 'The browser instance does not own this Relay session.', 403);
    }
  }

  _grantLease(session) {
    const activeSessionId = this.activeLeaseSessionIds.get(session.deviceId);
    const active = activeSessionId ? this.sessions.get(activeSessionId) : null;
    if (active && active.id !== session.id) active.lease = null;
    this.leaseEpoch += 1;
    session.lease = {
      epoch: this.leaseEpoch,
      grantedAt: this._nowIso(),
      expiresAt: new Date(this._nowMs() + CONTROL_LEASE_TTL_MS).toISOString(),
      browserInstanceId: session.browserInstanceId,
    };
    this.activeLeaseSessionIds.set(session.deviceId, session.id);
    return { ...session.lease };
  }

  _assertActiveLease(session, leaseEpoch) {
    if (!session.lease || session.lease.epoch !== normalizeLeaseEpoch(leaseEpoch) || !this._leaseIsActive(session)) {
      throw new CodexRelayServiceError('CODEX_RELAY_LEASE_EXPIRED', 'The control lease is no longer active.', 409);
    }
  }

  _leaseIsActive(session) {
    return this.activeLeaseSessionIds.get(session.deviceId) === session.id && Date.parse(session.lease?.expiresAt || '') > this._nowMs();
  }

  _touch(session) {
    const timestamp = this._nowIso();
    session.updatedAt = timestamp;
    session.lastActivityAt = timestamp;
    this.device.lastSeenAt = timestamp;
  }

  _touchStream(stream, session) {
    stream.lastActivityAt = this._nowIso();
    this._touch(session);
  }

  _cleanup() {
    const now = this._nowMs();
    for (const [ticketKey, ticket] of this.streamTickets) {
      if (Date.parse(ticket.expiresAt) <= now || !this.sessions.has(ticket.sessionId)) this.streamTickets.delete(ticketKey);
    }
    for (const [streamId, stream] of this.eventStreams) {
      if (now - Date.parse(stream.lastActivityAt) > STREAM_IDLE_TTL_MS || !this.sessions.has(stream.sessionId)) {
        this.eventStreams.delete(streamId);
      }
    }
    for (const session of this.sessions.values()) {
      if (now - Date.parse(session.lastActivityAt) > SESSION_IDLE_TTL_MS) {
        this.sessions.delete(session.id);
        if (this.activeLeaseSessionIds.get(session.deviceId) === session.id) this.activeLeaseSessionIds.delete(session.deviceId);
        continue;
      }
      if (session.lease && Date.parse(session.lease.expiresAt) <= now && this.activeLeaseSessionIds.get(session.deviceId) === session.id) {
        this.activeLeaseSessionIds.delete(session.deviceId);
      }
    }
  }

  async _desktopStatus() {
    if (!this.codexDesktopService?.status) return null;
    try {
      return await this.codexDesktopService.status();
    } catch {
      return null;
    }
  }

  _publicDevice(nativeMirror = null) {
    const inputEnabled = nativeMirror?.inputEnabled === true;
    return {
      id: this.device.id,
      name: this.device.name,
      paired: Boolean(this.device.pairedAt),
      pairedAt: this.device.pairedAt,
      lastSeenAt: this.device.lastSeenAt,
      transport: 'outbound-not-configured',
      online: true,
      role: 'controller',
      capabilities: [
        'thread.read',
        'thread.write',
        'turn.start',
        'approval.respond',
        'artifact.read',
        'desktop.stream',
        ...(inputEnabled ? ['desktop.input'] : []),
      ],
      relayVersion: '1.0.0',
      codexBuild: '',
      codex: { running: true, windowId: '' },
    };
  }

  _publicSession(session) {
    return {
      id: session.id,
      mode: session.mode,
      deviceId: session.deviceId,
      transport: session.remote ? 'outbound-websocket' : 'loopback-http',
      adapterVersion: session.adapterVersion,
      requestedCapabilities: [...session.requestedCapabilities],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      connectedAt: session.connectedAt,
      ticketExpiresAt: session.ticketExpiresAt,
      lease: session.lease ? { ...session.lease } : null,
    };
  }

  _publicStream(stream) {
    return {
      id: stream.id,
      sessionId: stream.sessionId,
      protocol: 'codex-host-rpc.v1',
      cursor: stream.cursor,
      ackedCursor: stream.ackedCursor,
      openedAt: stream.openedAt,
      lastActivityAt: stream.lastActivityAt,
    };
  }

  _nowMs() {
    const value = this.now();
    const ms = (value instanceof Date ? value : new Date(value)).getTime();
    if (!Number.isFinite(ms)) throw new CodexRelayServiceError('CODEX_RELAY_CLOCK_INVALID', 'The Relay clock returned an invalid value.', 500);
    return ms;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }
}

function publicRtcConfiguration(value) {
  return {
    iceServers: (value?.iceServers || []).map((entry) => ({
      ...entry,
      urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls,
    })),
    expiresAt: value?.expiresAt || null,
  };
}

function localDeviceId(workspaceRoot) {
  return `device-${createHash('sha256').update(String(workspaceRoot || process.cwd())).digest('hex').slice(0, 16)}`;
}

function normalizeDeviceId(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,120}$/.test(normalized) ? normalized : '';
}

function normalizeDeviceName(value) {
  if (value == null || value === '') return '';
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 120) {
    throw new CodexRelayServiceError('CODEX_RELAY_DEVICE_NAME_INVALID', 'Device name must be between 1 and 120 characters.');
  }
  return normalized;
}

function normalizeBrowserIdentity(value, field) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(normalized)) {
    throw new CodexRelayServiceError('CODEX_RELAY_BROWSER_ID_INVALID', `${field} must be a valid browser identity.`);
  }
  return normalized;
}

function normalizeCapabilities(value) {
  if (value == null) return ['thread.read', 'thread.write', 'turn.start', 'approval.respond', 'artifact.read'];
  if (!Array.isArray(value) || value.length > SEMANTIC_CAPABILITIES.size) {
    throw new CodexRelayServiceError('CODEX_RELAY_CAPABILITIES_INVALID', 'Requested capabilities are invalid.');
  }
  const capabilities = [...new Set(value.map((item) => String(item || '').trim()))];
  if (!capabilities.length || capabilities.some((item) => !SEMANTIC_CAPABILITIES.has(item))) {
    throw new CodexRelayServiceError('CODEX_RELAY_CAPABILITIES_INVALID', 'Requested capabilities are invalid.');
  }
  return capabilities;
}

function normalizeCursor(value) {
  const cursor = Number(value || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CodexRelayServiceError('CODEX_RELAY_CURSOR_INVALID', 'Relay event cursor is invalid.');
  }
  return cursor;
}

function normalizeLeaseEpoch(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
}

function secretHash(value) {
  return createHash('sha256').update(String(value || '')).digest();
}

function secretKey(value) {
  return secretHash(value).toString('hex');
}

function secretsMatch(expected, value) {
  if (!expected || typeof value !== 'string') return false;
  const received = secretHash(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function requiresControlLease(message) {
  const type = String(message?.type || '');
  return type === 'mcp-request'
    || type === 'mcp-response'
    || type === 'thread-prewarm-start'
    || type === 'worker-request'
    || type === 'worker-request-cancel';
}

function normalizeBrowserEvent({ sequence, message }) {
  const type = String(message?.type || '');
  const method = String(message?.method || message?.request?.method || message?.requestMethod || '');
  let kind = 'notification';
  if (type === 'mcp-response') kind = 'response';
  else if (type === 'mcp-request') kind = 'approval-request';
  else if (type === 'codex-app-server-connection-changed') kind = 'connection';
  return {
    schemaVersion: 1,
    sequence: Number(sequence),
    kind,
    type,
    method,
    emittedAt: message?.emittedAtMs ? new Date(Number(message.emittedAtMs)).toISOString() : null,
  };
}
