import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 15 * 60_000;
const MAX_SESSION_LIFETIME_MS = 2 * 60 * 60_000;
const MAX_SIGNALS_PER_ROLE = 256;
const MAX_SDP_BYTES = 512 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024;
const SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate', 'ready', 'bye']);

export class CodexNativeMirrorServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexNativeMirrorServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexNativeMirrorService(options = {}) {
  return new CodexNativeMirrorService(options);
}

export class CodexNativeMirrorService {
  constructor({
    now = () => new Date(),
    newId = randomUUID,
    newSecret = () => randomBytes(32).toString('base64url'),
    iceServers = [],
    iceService = null,
    inputService = null,
    remoteInputService = null,
    localSourceService = null,
  } = {}) {
    this.now = now;
    this.newId = newId;
    this.newSecret = newSecret;
    this.iceServers = normalizeIceServers(iceServers);
    this.iceService = iceService;
    this.inputService = inputService;
    this.remoteInputService = remoteInputService;
    this.localSourceService = localSourceService;
    this.sessions = new Map();
  }

  status() {
    this._cleanup();
    const iceStatus = this.iceService?.status?.() || null;
    const inputStatus = this.inputService?.status?.() || { available: false, inputEnabled: false, state: 'view_only' };
    const inputEnabled = inputStatus.inputEnabled === true;
    return {
      schemaVersion: 1,
      available: true,
      state: inputEnabled ? 'interactive' : 'view_only',
      transport: 'webrtc-direct-with-wss-relay-fallback',
      signaling: 'authenticated-http-poll-and-websocket',
      capture: 'browser-selected-window',
      selectedWindowOnly: true,
      viewOnly: !inputEnabled,
      inputEnabled,
      input: inputStatus,
      localCapture: this.localSourceService?.status?.() || { available: false, activeSources: 0 },
      clipboardEnabled: false,
      activeSessions: this.sessions.size,
      iceServersConfigured: iceStatus?.configuredServers ?? this.iceServers.length,
      turnConfigured: iceStatus?.turnConfigured ?? this.iceServers.some((entry) => iceServerHasTurn(entry)),
      turnCredentialMode: iceStatus?.turnCredentialMode || 'static-or-not-configured',
    };
  }

  createSession({ deviceId = '', remote = false, ownerId = '' } = {}) {
    this._cleanup();
    const createdAtMs = this._nowMs();
    const sourceToken = this.newSecret();
    const viewerToken = this.newSecret();
    const sessionId = `mirror-${this.newId()}`;
    const issuedIce = this.iceService?.issue?.({ subject: sessionId }) || {
      iceServers: this.iceServers.map(cloneIceServer),
      expiresAt: null,
      turnConfigured: this.iceServers.some((entry) => iceServerHasTurn(entry)),
    };
    const session = {
      id: sessionId,
      deviceId: String(deviceId || '').trim(),
      remote: remote === true,
      ownerId: remote === true ? String(ownerId || '').trim() : '',
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + SESSION_TTL_MS).toISOString(),
      maximumExpiresAt: new Date(createdAtMs + MAX_SESSION_LIFETIME_MS).toISOString(),
      sourceTokenHash: secretHash(sourceToken),
      viewerTokenHash: secretHash(viewerToken),
      sequence: 0,
      signals: { source: [], viewer: [] },
      connected: { source: false, viewer: false },
      peerConnected: { source: false, viewer: false },
      controlConnected: { source: false, viewer: false },
      transportDetails: { source: null, viewer: null },
      connectionErrors: { source: null, viewer: null },
      inputTarget: null,
      rtcConfiguration: {
        iceServers: normalizeIceServers(issuedIce.iceServers),
        expiresAt: issuedIce.expiresAt || null,
      },
    };
    this.sessions.set(session.id, session);
    return {
      session: this._publicSession(session),
      source: { role: 'source', token: sourceToken },
      viewer: { role: 'viewer', token: viewerToken },
      rtcConfiguration: publicRtcConfiguration(session.rtcConfiguration),
    };
  }

  async launchRemoteSource(sessionId, credentials = {}, { sourceUrl = '' } = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    if (role !== 'source' || !session.remote) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_REMOTE_SOURCE_INVALID', 'This session does not use a remote Mirror source.', 409);
    }
    if (!this.remoteInputService?.openMirrorSource) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_REMOTE_UNAVAILABLE', 'Remote Native Mirror is unavailable.', 503);
    }
    const result = await this.remoteInputService.openMirrorSource(session.deviceId, session.id, sourceUrl, { ownerId: session.ownerId });
    const openedAt = this._nowIso();
    session.sourceLaunch = { state: 'ready', requestedAt: openedAt, openedAt };
    this._touch(session);
    return { ...result, session: this._publicSession(session) };
  }

  async launchLocalSource(sessionId, credentials = {}, { sourceUrl = '', captureTitle = 'ChatGPT' } = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    if (role !== 'source' || session.remote) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_LOCAL_SOURCE_INVALID', 'This session does not use a local Mirror source.', 409);
    }
    if (!this.localSourceService?.launch) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_LOCAL_CAPTURE_UNAVAILABLE', 'Local Native Mirror capture is unavailable.', 503);
    }
    try {
      const result = await this.localSourceService.launch(session.id, sourceUrl, { captureTitle });
      session.sourceLaunch = { ...result, state: 'ready' };
      this._touch(session);
      return { launch: result, session: this._publicSession(session) };
    } catch (error) {
      session.sourceLaunch = {
        state: 'error',
        requestedAt: this._nowIso(),
        message: String(error?.message || error || 'Local Native Mirror source launch failed.').slice(0, 300),
      };
      this._touch(session);
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_LOCAL_CAPTURE_FAILED', session.sourceLaunch.message, 503);
    }
  }

  async setInputTarget(sessionId, credentials = {}, target = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    if (role !== 'source') {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_INPUT_ROLE_INVALID', 'Only the selected-window source can register an input target.', 403);
    }
    const inputService = this._inputService(session);
    if (!this._inputEnabled(session)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_INPUT_UNAVAILABLE', 'Interactive Native Mirror input is not available on this host.', 503);
    }
    let result;
    if (session.remote) {
      result = await inputService.setMirrorInputTarget(session.deviceId, session.id, target, { ownerId: session.ownerId });
    } else {
      result = inputService.setTarget(session.id, target);
      try {
        await inputService.warm?.(session.id);
      } catch (error) {
        inputService.clearTarget?.(session.id);
        throw error;
      }
    }
    session.inputTarget = result.target || normalizePublicInputTarget(target);
    session.inputMode = String(target?.mode || '').trim() === 'input-only' ? 'input-only' : 'capture';
    this._touch(session);
    return { ...result, session: this._publicSession(session) };
  }

  async sendInput(sessionId, credentials = {}, event = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    if (role !== 'source') {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_INPUT_ROLE_INVALID', 'Only the selected-window source can submit input events.', 403);
    }
    const inputService = this._inputService(session);
    if (!this._inputEnabled(session)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_INPUT_UNAVAILABLE', 'Interactive Native Mirror input is not available on this host.', 503);
    }
    const result = session.remote
      ? await inputService.sendMirrorInput(session.deviceId, session.id, event, { ownerId: session.ownerId })
      : await inputService.send(session.id, event);
    this._touch(session);
    return { ...result, session: this._publicSession(session) };
  }

  async sendViewerInput(sessionId, credentials = {}, event = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    if (role !== 'viewer') {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_VIEWER_INPUT_ROLE_INVALID', 'Only the authenticated viewer can use the local direct input path.', 403);
    }
    if (session.remote) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_VIEWER_INPUT_REMOTE_INVALID', 'Remote Mirror input must be delivered through its paired source.', 409);
    }
    if (session.inputTarget?.delivery !== 'window-message') {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_VIEWER_INPUT_TARGET_INVALID', 'The local direct input target is not ready.', 409);
    }
    if (!this._inputEnabled(session)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_INPUT_UNAVAILABLE', 'Interactive Native Mirror input is not available on this host.', 503);
    }
    const result = await this.inputService.send(session.id, event);
    this._touch(session);
    return { ...result, session: this._publicSession(session) };
  }

  getSession(sessionId, credentials = {}) {
    const { session } = this._authorize(sessionId, credentials);
    return {
      session: this._publicSession(session),
      rtcConfiguration: publicRtcConfiguration(session.rtcConfiguration),
    };
  }

  postSignal(sessionId, { role, token, kind, payload } = {}) {
    const authorized = this._authorize(sessionId, { role, token });
    const signalKind = normalizeSignalKind(kind);
    assertRoleCanSend(authorized.role, signalKind);
    const normalizedPayload = normalizeSignalPayload(signalKind, payload);
    const target = authorized.role === 'source' ? 'viewer' : 'source';
    const signal = {
      sequence: ++authorized.session.sequence,
      from: authorized.role,
      kind: signalKind,
      payload: normalizedPayload,
      createdAt: this._nowIso(),
    };
    const queue = authorized.session.signals[target];
    queue.push(signal);
    if (queue.length > MAX_SIGNALS_PER_ROLE) queue.splice(0, queue.length - MAX_SIGNALS_PER_ROLE);
    if (signalKind === 'ready') {
      const phase = String(normalizedPayload.phase || 'page');
      if (phase !== 'connection-error') authorized.session.connected[authorized.role] = true;
      if (phase === 'peer') {
        authorized.session.peerConnected[authorized.role] = true;
        authorized.session.connectionErrors[authorized.role] = null;
      }
      if (phase === 'control') {
        authorized.session.peerConnected[authorized.role] = true;
        authorized.session.controlConnected[authorized.role] = true;
        authorized.session.connectionErrors[authorized.role] = null;
      }
      if (phase === 'transport') {
        authorized.session.transportDetails[authorized.role] = normalizeTransportDetails(normalizedPayload);
      }
      if (phase === 'connection-error') {
        authorized.session.peerConnected[authorized.role] = false;
        authorized.session.controlConnected[authorized.role] = false;
        authorized.session.connectionErrors[authorized.role] = normalizeConnectionError(normalizedPayload.state);
      }
    }
    if (signalKind === 'bye') {
      authorized.session.connected[authorized.role] = false;
      authorized.session.peerConnected[authorized.role] = false;
      authorized.session.controlConnected[authorized.role] = false;
      authorized.session.transportDetails[authorized.role] = null;
      authorized.session.connectionErrors[authorized.role] = null;
      if (authorized.role === 'source') {
        this._clearInputTarget(authorized.session);
        authorized.session.inputTarget = null;
      }
    }
    this._touch(authorized.session);
    return { accepted: true, sequence: signal.sequence, target };
  }

  listSignals(sessionId, { role, token, after = 0 } = {}) {
    const authorized = this._authorize(sessionId, { role, token });
    const cursor = normalizeCursor(after);
    const signals = authorized.session.signals[authorized.role]
      .filter((signal) => signal.sequence > cursor);
    this._touch(authorized.session);
    return {
      signals,
      cursor: signals.at(-1)?.sequence ?? cursor,
      session: this._publicSession(authorized.session),
    };
  }

  closeSession(sessionId, credentials = {}) {
    const { session, role } = this._authorize(sessionId, credentials);
    this._clearInputTarget(session);
    this.sessions.delete(session.id);
    return { closed: true, sessionId: session.id, closedBy: role };
  }

  async close() {
    await this.localSourceService?.closeAll?.();
    for (const session of this.sessions.values()) this._clearInputTarget(session);
    this.sessions.clear();
  }

  _authorize(sessionId, { role, token } = {}) {
    this._cleanup();
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_SESSION_NOT_FOUND', 'The Native Mirror session was not found.', 404);
    }
    const normalizedRole = normalizeRole(role);
    const expected = normalizedRole === 'source' ? session.sourceTokenHash : session.viewerTokenHash;
    if (!secretsMatch(expected, token)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_TOKEN_INVALID', 'The Native Mirror role token is invalid.', 401);
    }
    return { session, role: normalizedRole };
  }

  _publicSession(session) {
    const remoteState = session.remote
      ? this.remoteInputService?.getMirrorState?.(session.deviceId, session.id, { ownerId: session.ownerId })
      : null;
    const localSourceState = session.remote ? null : this.localSourceService?.get?.(session.id);
    const connectionError = publicConnectionError(session.connectionErrors);
    const connectionPath = publicConnectionPath(session.transportDetails, session.controlConnected);
    return {
      id: session.id,
      deviceId: session.deviceId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      mode: 'nativeMirror',
      remote: session.remote,
      state: connectionError
        ? 'error'
        : session.controlConnected.source && session.controlConnected.viewer ? 'connected' : 'waiting',
      sourceConnected: session.connected.source,
      viewerConnected: session.connected.viewer,
      peerConnected: session.peerConnected.source && session.peerConnected.viewer,
      controlConnected: session.controlConnected.source && session.controlConnected.viewer,
      connectionPath,
      connectionError,
      transportDetails: {
        source: session.transportDetails.source ? { ...session.transportDetails.source } : null,
        viewer: session.transportDetails.viewer ? { ...session.transportDetails.viewer } : null,
      },
      viewOnly: !this._inputEnabled(session),
      inputEnabled: this._inputEnabled(session),
      inputTarget: session.inputTarget ? { ...session.inputTarget } : null,
      inputMode: session.inputMode || null,
      sourceLaunch: remoteState || localSourceState || (session.sourceLaunch ? { ...session.sourceLaunch } : null),
    };
  }

  _touch(session) {
    const next = Math.min(this._nowMs() + SESSION_TTL_MS, Date.parse(session.maximumExpiresAt));
    session.expiresAt = new Date(next).toISOString();
  }

  _cleanup() {
    const now = this._nowMs();
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= now || Date.parse(session.maximumExpiresAt) <= now) {
        this._clearInputTarget(session);
        this.sessions.delete(session.id);
      }
    }
  }

  _nowMs() {
    const value = this.now();
    const milliseconds = (value instanceof Date ? value : new Date(value)).getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_CLOCK_INVALID', 'The Native Mirror clock returned an invalid value.', 500);
    }
    return milliseconds;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }

  _inputService(session) {
    return session.remote ? this.remoteInputService : this.inputService;
  }

  _inputEnabled(session) {
    if (session.remote) return Boolean(this.remoteInputService?.sendMirrorInput);
    return this.inputService?.status?.().inputEnabled === true;
  }

  _clearInputTarget(session) {
    if (session.remote) {
      if (session.sourceLaunch?.state !== 'requested' && !session.inputTarget) return;
      try {
        this.remoteInputService?.closeRemoteMirror?.(session.deviceId, session.id, { ownerId: session.ownerId });
      } catch {
        // Session cleanup is best effort when a remote connector has gone offline.
      }
      session.sourceLaunch = {
        ...(session.sourceLaunch || {}),
        state: 'closed',
        closedAt: this._nowIso(),
      };
    } else {
      if (session.inputTarget) this.inputService?.clearTarget?.(session.id);
      if (session.sourceLaunch || this.localSourceService?.get?.(session.id)) {
        void this.localSourceService?.close?.(session.id);
        session.sourceLaunch = {
          ...(session.sourceLaunch || {}),
          state: 'closed',
          closedAt: this._nowIso(),
        };
      }
    }
    session.inputTarget = null;
  }
}

function normalizePublicInputTarget(value) {
  return {
    label: String(value?.label || '').trim().slice(0, 300),
    width: Math.max(0, Math.min(32_768, Math.round(Number(value?.width) || 0))),
    height: Math.max(0, Math.min(32_768, Math.round(Number(value?.height) || 0))),
    delivery: String(value?.delivery || '').trim() === 'window-message' ? 'window-message' : 'sendinput',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  if (role !== 'source' && role !== 'viewer') {
    throw new CodexNativeMirrorServiceError('CODEX_MIRROR_ROLE_INVALID', 'Native Mirror role must be source or viewer.');
  }
  return role;
}

function normalizeSignalKind(value) {
  const kind = String(value || '').trim();
  if (!SIGNAL_KINDS.has(kind)) {
    throw new CodexNativeMirrorServiceError('CODEX_MIRROR_SIGNAL_INVALID', 'Native Mirror signal kind is invalid.');
  }
  return kind;
}

function assertRoleCanSend(role, kind) {
  if ((kind === 'offer' && role !== 'source') || (kind === 'answer' && role !== 'viewer')) {
    throw new CodexNativeMirrorServiceError('CODEX_MIRROR_SIGNAL_DIRECTION_INVALID', `${role} cannot send a ${kind} signal.`, 403);
  }
}

function normalizeSignalPayload(kind, payload) {
  if (kind === 'offer' || kind === 'answer') {
    const type = String(payload?.type || '');
    const sdp = String(payload?.sdp || '');
    if (type !== kind || !sdp || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_SDP_INVALID', `Native Mirror ${kind} SDP is invalid.`);
    }
    return { type, sdp };
  }
  if (kind === 'candidate') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_CANDIDATE_INVALID', 'Native Mirror ICE candidate is invalid.');
    }
    const candidate = String(payload.candidate || '');
    if (Buffer.byteLength(candidate) > MAX_CANDIDATE_BYTES) {
      throw new CodexNativeMirrorServiceError('CODEX_MIRROR_CANDIDATE_INVALID', 'Native Mirror ICE candidate is too large.');
    }
    return {
      candidate,
      sdpMid: payload.sdpMid == null ? null : String(payload.sdpMid).slice(0, 128),
      sdpMLineIndex: Number.isSafeInteger(Number(payload.sdpMLineIndex)) ? Number(payload.sdpMLineIndex) : null,
      usernameFragment: payload.usernameFragment == null ? null : String(payload.usernameFragment).slice(0, 256),
    };
  }
  if (kind === 'ready') {
    const phase = new Set(['page', 'peer', 'control', 'transport', 'connection-error'])
      .has(String(payload?.phase || '').trim().toLowerCase())
      ? String(payload.phase).trim().toLowerCase()
      : 'page';
    if (phase === 'transport') return { phase, ...normalizeTransportDetails(payload) };
    if (phase === 'connection-error') return { phase, state: normalizeConnectionError(payload?.state) };
    if (phase === 'page') {
      return {
        phase,
        interactive: payload?.interactive === true,
        selectedWindow: payload?.selectedWindow === true,
      };
    }
    return { phase };
  }
  const normalized = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_CANDIDATE_BYTES) {
    throw new CodexNativeMirrorServiceError('CODEX_MIRROR_SIGNAL_INVALID', 'Native Mirror signal payload is too large.');
  }
  return normalized;
}

function normalizeCursor(value) {
  const cursor = Number(value || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CodexNativeMirrorServiceError('CODEX_MIRROR_CURSOR_INVALID', 'Native Mirror signal cursor is invalid.');
  }
  return cursor;
}

function normalizeTransportDetails(value) {
  const candidateTypes = new Set(['host', 'srflx', 'prflx', 'relay', 'unknown']);
  const protocols = new Set(['udp', 'tcp', 'tls', 'wss', 'unknown']);
  const localCandidateType = candidateTypes.has(String(value?.localCandidateType || '').toLowerCase())
    ? String(value.localCandidateType).toLowerCase()
    : 'unknown';
  const remoteCandidateType = candidateTypes.has(String(value?.remoteCandidateType || '').toLowerCase())
    ? String(value.remoteCandidateType).toLowerCase()
    : 'unknown';
  const protocol = protocols.has(String(value?.protocol || '').toLowerCase())
    ? String(value.protocol).toLowerCase()
    : 'unknown';
  const measuredRttMs = Number(value?.rttMs);
  const rttMs = Number.isFinite(measuredRttMs) && measuredRttMs >= 0 && measuredRttMs <= 60_000
    ? Math.round(measuredRttMs)
    : null;
  return {
    localCandidateType,
    remoteCandidateType,
    protocol,
    relayUsed: value?.relayUsed === true || localCandidateType === 'relay' || remoteCandidateType === 'relay',
    rttMs,
  };
}

function normalizeConnectionError(value) {
  const state = String(value || '').trim().toLowerCase();
  return new Set(['failed', 'disconnected', 'closed', 'control-closed']).has(state) ? state : 'failed';
}

function publicConnectionError(errors) {
  for (const role of ['source', 'viewer']) {
    if (errors?.[role]) return `${role}: ${errors[role]}`;
  }
  return null;
}

function publicConnectionPath(details, controlConnected) {
  const entries = [details?.source, details?.viewer].filter(Boolean);
  if (entries.some((entry) => entry.relayUsed)) return 'relay';
  if (controlConnected?.source && controlConnected?.viewer && entries.length === 2) return 'direct';
  return 'unknown';
}

function normalizeIceServers(value) {
  if (!Array.isArray(value) || value.length > 8) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const urls = Array.isArray(entry.urls)
      ? entry.urls.map(String).filter(Boolean).slice(0, 8)
      : String(entry.urls || '').trim();
    if (!urls || (Array.isArray(urls) && !urls.length)) return null;
    return {
      urls,
      ...(entry.username ? { username: String(entry.username) } : {}),
      ...(entry.credential ? { credential: String(entry.credential) } : {}),
    };
  }).filter(Boolean);
}

function secretHash(value) {
  return createHash('sha256').update(String(value || '')).digest();
}

function secretsMatch(expected, value) {
  if (!expected || typeof value !== 'string') return false;
  const received = secretHash(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function publicRtcConfiguration(value) {
  return {
    iceServers: (value?.iceServers || []).map(cloneIceServer),
    expiresAt: value?.expiresAt || null,
  };
}

function cloneIceServer(entry) {
  return {
    ...entry,
    urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls,
  };
}

function iceServerHasTurn(entry) {
  const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
  return urls.some((url) => /^turns?:/i.test(String(url || '')));
}
