import { createHmac } from 'node:crypto';

export class CodexIceServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CodexIceServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createCodexIceService(options = {}) {
  return new CodexIceService(options);
}

export class CodexIceService {
  constructor({
    staticIceServers = [],
    turnUrls = [],
    turnSharedSecret = '',
    credentialTtlSeconds = 600,
    now = () => new Date(),
  } = {}) {
    this.staticIceServers = normalizeStaticIceServers(staticIceServers);
    this.turnUrls = normalizeTurnUrls(turnUrls);
    this.turnSharedSecret = String(turnSharedSecret || '');
    this.credentialTtlSeconds = Math.min(3_600, Math.max(60, Number(credentialTtlSeconds) || 600));
    this.now = now;
    if (this.turnUrls.length && !this.turnSharedSecret) {
      throw new CodexIceServiceError('CODEX_TURN_SECRET_REQUIRED', 'TURN URLs require XHS_CODEX_TURN_SHARED_SECRET.', 500);
    }
  }

  status() {
    const turnConfigured = this.turnUrls.length > 0;
    return {
      schemaVersion: 1,
      configuredServers: this.staticIceServers.length + (this.turnUrls.length ? 1 : 0),
      staticServers: this.staticIceServers.length,
      turnConfigured,
      crossNetworkReady: turnConfigured,
      connectivityMode: turnConfigured
        ? 'direct-with-relay-fallback'
        : this.staticIceServers.length ? 'direct-with-stun' : 'direct-only',
      turnCredentialMode: turnConfigured ? 'time-limited-hmac' : 'not_configured',
      credentialTtlSeconds: turnConfigured ? this.credentialTtlSeconds : 0,
    };
  }

  issue({ subject = 'codex-session' } = {}) {
    const iceServers = this.staticIceServers.map((entry) => cloneIceServer(entry));
    let expiresAt = null;
    if (this.turnUrls.length) {
      const nowMs = this._nowMs();
      const expiresAtSeconds = Math.floor(nowMs / 1_000) + this.credentialTtlSeconds;
      const username = `${expiresAtSeconds}:${normalizeSubject(subject)}`;
      const credential = createHmac('sha1', this.turnSharedSecret).update(username).digest('base64');
      iceServers.push({ urls: [...this.turnUrls], username, credential });
      expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
    }
    return {
      iceServers,
      expiresAt,
      turnConfigured: this.turnUrls.length > 0,
    };
  }

  _nowMs() {
    const value = this.now();
    const milliseconds = (value instanceof Date ? value : new Date(value)).getTime();
    if (!Number.isFinite(milliseconds)) throw new CodexIceServiceError('CODEX_ICE_CLOCK_INVALID', 'The ICE service clock is invalid.', 500);
    return milliseconds;
  }
}

function normalizeStaticIceServers(value) {
  if (!Array.isArray(value) || value.length > 8) throw new CodexIceServiceError('CODEX_ICE_SERVERS_INVALID', 'Static ICE servers must be an array of at most eight entries.', 500);
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CodexIceServiceError('CODEX_ICE_SERVERS_INVALID', 'An ICE server entry is invalid.', 500);
    const urls = normalizeUrls(entry.urls, ['stun:', 'stuns:', 'turn:', 'turns:']);
    const normalized = { urls: urls.length === 1 ? urls[0] : urls };
    if (entry.username !== undefined) normalized.username = normalizeCredentialField(entry.username, 'username');
    if (entry.credential !== undefined) normalized.credential = normalizeCredentialField(entry.credential, 'credential');
    return Object.freeze(normalized);
  });
}

function normalizeTurnUrls(value) {
  if (!Array.isArray(value) || value.length > 8) throw new CodexIceServiceError('CODEX_TURN_URLS_INVALID', 'TURN URLs must be an array of at most eight entries.', 500);
  if (!value.length) return Object.freeze([]);
  return Object.freeze(normalizeUrls(value, ['turn:', 'turns:']));
}

function normalizeUrls(value, protocols) {
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.length || entries.length > 8) throw new CodexIceServiceError('CODEX_ICE_URL_INVALID', 'ICE URLs are invalid.', 500);
  return entries.map((entry) => {
    const url = String(entry || '').trim();
    if (!url || url.length > 2_048 || !protocols.some((protocol) => url.toLowerCase().startsWith(protocol))) {
      throw new CodexIceServiceError('CODEX_ICE_URL_INVALID', 'ICE URLs are invalid.', 500);
    }
    return url;
  });
}

function normalizeCredentialField(value, field) {
  const normalized = String(value || '');
  if (!normalized || normalized.length > 1_024) throw new CodexIceServiceError('CODEX_ICE_CREDENTIAL_INVALID', `ICE ${field} is invalid.`, 500);
  return normalized;
}

function normalizeSubject(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
  return normalized || 'codex-session';
}

function cloneIceServer(entry) {
  return {
    ...entry,
    urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls,
  };
}
