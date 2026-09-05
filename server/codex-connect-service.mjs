import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PAIRING_TTL_MS = 5 * 60_000;
const CONNECTOR_PROTOCOL = 'codex-local:';
const CONNECTOR_VERSION = '1.2.5';

export class CodexConnectServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexConnectServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexConnectService(options = {}) {
  return new CodexConnectService(options);
}

export class CodexConnectService {
  constructor({
    deviceGatewayService,
    now = () => new Date(),
    signingSecret = randomBytes(32).toString('base64url'),
    allowedOrigins = [],
    localRelayOrigin = 'http://127.0.0.1:4317',
    connectorVersion = CONNECTOR_VERSION,
  } = {}) {
    if (!deviceGatewayService?.createPairingIntent || !deviceGatewayService?.claimPairing) {
      throw new CodexConnectServiceError('CODEX_CONNECT_GATEWAY_REQUIRED', 'The device gateway is required.', 500);
    }
    this.deviceGatewayService = deviceGatewayService;
    this.now = now;
    this.signingSecret = Buffer.from(String(signingSecret), 'utf8');
    this.allowedOrigins = new Set((allowedOrigins || []).map(normalizeOrigin));
    this.localRelayOrigin = normalizeOrigin(localRelayOrigin);
    this.connectorVersion = normalizeVersion(connectorVersion);
    this.intents = new Map();
  }

  createIntent({ ownerId, origin, deviceName = '', requestedRole = 'controller', replaceDeviceId = '' } = {}) {
    this._cleanup();
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    const normalizedOrigin = this._assertAllowedOrigin(origin);
    const replacedDevice = replaceDeviceId
      ? this.deviceGatewayService.getDevice(String(replaceDeviceId), { ownerId: normalizedOwnerId })
      : null;
    const created = this.deviceGatewayService.createPairingIntent({
      ownerId: normalizedOwnerId,
      deviceName,
      requestedRole,
    });
    const pairingIntent = created?.pairingIntent;
    if (!pairingIntent?.id || !pairingIntent?.code || !pairingIntent?.expiresAt) {
      throw new CodexConnectServiceError('CODEX_CONNECT_GATEWAY_RESPONSE_INVALID', 'The device gateway did not create a valid pairing intent.', 502);
    }
    const intent = {
      id: String(pairingIntent.id),
      ownerId: normalizedOwnerId,
      origin: normalizedOrigin,
      nonce: randomBytes(18).toString('base64url'),
      expiresAt: String(pairingIntent.expiresAt),
      requestedRole: String(pairingIntent.requestedRole || requestedRole),
      deviceName: String(pairingIntent.deviceName || deviceName || ''),
      claimedAt: null,
      deviceId: '',
      replaceDeviceId: String(replacedDevice?.id || ''),
    };
    this.intents.set(intent.id, intent);
    return {
      intent: this._publicIntent(intent),
      launchUrl: this._launchUrl(intent, pairingIntent.code),
      connector: {
        protocol: CONNECTOR_PROTOCOL.slice(0, -1),
        version: this.connectorVersion,
      },
    };
  }

  getIntent(intentId, { ownerId } = {}) {
    this._cleanup();
    const intent = this._ownedIntent(intentId, ownerId);
    const device = this._intentDevice(intent);
    return {
      intent: this._publicIntent(intent, device),
      ...(device ? { device, health: healthForDevice(device) } : {}),
    };
  }

  async claimIntent(intentId, {
    origin,
    code,
    nonce,
    signature,
    deviceName,
    publicKey = '',
    capabilities = [],
    relayVersion = '',
    codexBuild = '',
  } = {}) {
    this._cleanup();
    const intent = this._intent(intentId);
    if (intent.claimedAt || intent.deviceId) {
      throw new CodexConnectServiceError('CODEX_CONNECT_INTENT_CONSUMED', 'The connection intent was already used.', 410);
    }
    if (Date.parse(intent.expiresAt) <= this._nowMs()) {
      throw new CodexConnectServiceError('CODEX_CONNECT_INTENT_EXPIRED', 'The connection intent expired.', 410);
    }
    const normalizedOrigin = normalizeOrigin(origin);
    if (normalizedOrigin !== intent.origin || String(nonce || '') !== intent.nonce) {
      throw new CodexConnectServiceError('CODEX_CONNECT_LAUNCH_INVALID', 'The connection launch parameters are invalid.', 401);
    }
    const expectedSignature = this._signature(intent, code);
    if (!safeEqual(expectedSignature, String(signature || ''))) {
      throw new CodexConnectServiceError('CODEX_CONNECT_SIGNATURE_INVALID', 'The connection launch signature is invalid.', 401);
    }
    const claimed = await this.deviceGatewayService.claimPairing({
      pairingIntentId: intent.id,
      code,
      deviceName: deviceName || intent.deviceName || 'Windows device',
      publicKey,
      capabilities,
      relayVersion,
      codexBuild,
    });
    intent.claimedAt = this._nowIso();
    intent.deviceId = String(claimed?.device?.id || '');
    if (!intent.deviceId) {
      throw new CodexConnectServiceError('CODEX_CONNECT_CLAIM_INVALID', 'The device gateway did not return a device id.', 502);
    }
    if (intent.replaceDeviceId && intent.replaceDeviceId !== intent.deviceId) {
      await this.deviceGatewayService.revokeDevice(intent.replaceDeviceId, { ownerId: intent.ownerId });
    }
    return {
      device: claimed.device,
      credentials: claimed.credentials,
      gateway: {
        websocketUrl: gatewayUrlForOrigin(intent.origin),
      },
      relay: {
        localOrigin: this.localRelayOrigin,
        protocol: 'codex-relay.v1',
      },
      connector: {
        version: this.connectorVersion,
        pairedAt: intent.claimedAt,
      },
      ...(intent.replaceDeviceId ? { replacedDeviceId: intent.replaceDeviceId } : {}),
    };
  }

  listDevices({ ownerId } = {}) {
    return this.deviceGatewayService.listDevices({ ownerId: normalizeOwnerId(ownerId) }).map((device) => ({
      ...device,
      health: healthForDevice(device),
    }));
  }

  getDeviceHealth(deviceId, { ownerId } = {}) {
    const device = this.deviceGatewayService.getDevice(String(deviceId || ''), { ownerId: normalizeOwnerId(ownerId) });
    return { device, health: healthForDevice(device) };
  }

  reconnectDevice(deviceId, { ownerId } = {}) {
    const device = this.deviceGatewayService.getDevice(String(deviceId || ''), { ownerId: normalizeOwnerId(ownerId) });
    const delivery = this.deviceGatewayService.sendConnectorCommand?.(device.id, {
      ownerId: normalizeOwnerId(ownerId),
      operation: 'reconnect',
    }) || { delivered: false, reason: 'connector_command_unsupported' };
    return { device, operation: 'reconnect', ...delivery };
  }

  repairDevice(deviceId, { ownerId } = {}) {
    const device = this.deviceGatewayService.getDevice(String(deviceId || ''), { ownerId: normalizeOwnerId(ownerId) });
    const delivery = this.deviceGatewayService.sendConnectorCommand?.(device.id, {
      ownerId: normalizeOwnerId(ownerId),
      operation: 'repair',
    }) || { delivered: false, reason: 'connector_command_unsupported' };
    return { device, operation: 'repair', ...delivery };
  }

  rollbackDevice(deviceId, { ownerId } = {}) {
    const device = this.deviceGatewayService.getDevice(String(deviceId || ''), { ownerId: normalizeOwnerId(ownerId) });
    const delivery = this.deviceGatewayService.sendConnectorCommand?.(device.id, {
      ownerId: normalizeOwnerId(ownerId),
      operation: 'rollback',
    }) || { delivered: false, reason: 'connector_command_unsupported' };
    return { device, operation: 'rollback', ...delivery };
  }

  async revokeDevice(deviceId, { ownerId } = {}) {
    return this.deviceGatewayService.revokeDevice(String(deviceId || ''), { ownerId: normalizeOwnerId(ownerId) });
  }

  manifest({ installerUrl = '', installerAvailable = false, installerSha256 = '' } = {}) {
    const installer = {
      url: String(installerUrl || ''),
      available: Boolean(installerAvailable),
      sha256: String(installerSha256 || ''),
    };
    const signed = JSON.stringify({
      schemaVersion: 1,
      connectorVersion: this.connectorVersion,
      protocol: CONNECTOR_PROTOCOL.slice(0, -1),
      installer,
    });
    return {
      schemaVersion: 1,
      connectorVersion: this.connectorVersion,
      protocol: CONNECTOR_PROTOCOL.slice(0, -1),
      installer,
      signature: createHmac('sha256', this.signingSecret).update(signed).digest('base64url'),
      signedAt: this._nowIso(),
    };
  }

  _publicIntent(intent, device = this._intentDevice(intent)) {
    const expired = Date.parse(intent.expiresAt) <= this._nowMs();
    const state = intent.deviceId
      ? (device?.online ? 'connected' : 'paired')
      : (expired ? 'expired' : 'waiting_for_connector');
    return {
      id: intent.id,
      state,
      expiresAt: intent.expiresAt,
      requestedRole: intent.requestedRole,
      ...(intent.deviceName ? { deviceName: intent.deviceName } : {}),
      ...(intent.deviceId ? { deviceId: intent.deviceId } : {}),
      ...(intent.claimedAt ? { claimedAt: intent.claimedAt } : {}),
    };
  }

  _launchUrl(intent, code) {
    const query = new URLSearchParams({
      origin: intent.origin,
      intent: intent.id,
      code: String(code),
      nonce: intent.nonce,
      expires: intent.expiresAt,
      sig: this._signature(intent, code),
    });
    return `${CONNECTOR_PROTOCOL}//connect?${query.toString()}`;
  }

  _signature(intent, code) {
    return createHmac('sha256', this.signingSecret)
      .update([intent.origin, intent.id, String(code || ''), intent.nonce, intent.expiresAt].join('\n'))
      .digest('base64url');
  }

  _ownedIntent(intentId, ownerId) {
    const intent = this._intent(intentId);
    if (intent.ownerId !== normalizeOwnerId(ownerId)) {
      throw new CodexConnectServiceError('CODEX_CONNECT_INTENT_NOT_FOUND', 'The connection intent was not found.', 404);
    }
    return intent;
  }

  _intent(intentId) {
    const intent = this.intents.get(String(intentId || '').trim());
    if (!intent) throw new CodexConnectServiceError('CODEX_CONNECT_INTENT_NOT_FOUND', 'The connection intent was not found.', 404);
    return intent;
  }

  _intentDevice(intent) {
    if (!intent?.deviceId) return null;
    try {
      return this.deviceGatewayService.getDevice(intent.deviceId, { ownerId: intent.ownerId });
    } catch {
      return null;
    }
  }

  _assertAllowedOrigin(origin) {
    const normalized = normalizeOrigin(origin);
    if (this.allowedOrigins.size && !this.allowedOrigins.has(normalized)) {
      throw new CodexConnectServiceError('CODEX_CONNECT_ORIGIN_REJECTED', 'The browser origin is not permitted for local connection.', 403);
    }
    return normalized;
  }

  _cleanup() {
    const now = this._nowMs();
    for (const [id, intent] of this.intents) {
      if (Date.parse(intent.expiresAt) + PAIRING_TTL_MS <= now) this.intents.delete(id);
    }
  }

  _nowMs() {
    const value = this.now();
    const milliseconds = (value instanceof Date ? value : new Date(value)).getTime();
    if (!Number.isFinite(milliseconds)) throw new CodexConnectServiceError('CODEX_CONNECT_CLOCK_INVALID', 'The connection service clock is invalid.', 500);
    return milliseconds;
  }

  _nowIso() {
    return new Date(this._nowMs()).toISOString();
  }
}

function gatewayUrlForOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/device-tunnel';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function healthForDevice(device) {
  const online = Boolean(device?.online);
  const runtimeReady = Boolean(device?.codex?.running);
  return {
    state: !online ? 'offline' : runtimeReady ? 'ready' : 'degraded',
    online,
    runtimeReady,
    relayVersion: String(device?.relayVersion || ''),
    codexBuild: String(device?.codexBuild || ''),
    checkedAt: new Date().toISOString(),
  };
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new CodexConnectServiceError('CODEX_CONNECT_ORIGIN_INVALID', 'The browser origin is invalid.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new CodexConnectServiceError('CODEX_CONNECT_ORIGIN_INVALID', 'The browser origin must be an HTTP(S) origin without a path.');
  }
  return url.origin;
}

function normalizeOwnerId(value) {
  const ownerId = String(value || '').trim();
  if (!/^[A-Za-z0-9@._:-]{3,180}$/.test(ownerId)) {
    throw new CodexConnectServiceError('CODEX_CONNECT_OWNER_INVALID', 'The connection owner is invalid.');
  }
  return ownerId;
}

function normalizeVersion(value) {
  const version = String(value || CONNECTOR_VERSION).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(version)) {
    throw new CodexConnectServiceError('CODEX_CONNECT_VERSION_INVALID', 'The connector version is invalid.', 500);
  }
  return version;
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left), 'utf8');
  const rightBytes = Buffer.from(String(right), 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
