import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

export const SMTP_PROVIDER_PRESETS = Object.freeze({
  '163': Object.freeze({ host: 'smtp.163.com', port: 465, secure: true, requireTls: false }),
  qq: Object.freeze({ host: 'smtp.qq.com', port: 465, secure: true, requireTls: false }),
  gmail: Object.freeze({ host: 'smtp.gmail.com', port: 465, secure: true, requireTls: false }),
  outlook: Object.freeze({ host: 'smtp.office365.com', port: 587, secure: false, requireTls: true }),
  custom: Object.freeze({ host: '', port: 465, secure: true, requireTls: false }),
});

const SMTP_EMAIL_DOMAIN_PRESETS = Object.freeze({
  '163.com': Object.freeze({ provider: '163', ...SMTP_PROVIDER_PRESETS['163'] }),
  '126.com': Object.freeze({ provider: '163', host: 'smtp.126.com', port: 465, secure: true, requireTls: false }),
  'yeah.net': Object.freeze({ provider: '163', host: 'smtp.yeah.net', port: 465, secure: true, requireTls: false }),
  'qq.com': Object.freeze({ provider: 'qq', ...SMTP_PROVIDER_PRESETS.qq }),
  'foxmail.com': Object.freeze({ provider: 'qq', ...SMTP_PROVIDER_PRESETS.qq }),
  'gmail.com': Object.freeze({ provider: 'gmail', ...SMTP_PROVIDER_PRESETS.gmail }),
  'googlemail.com': Object.freeze({ provider: 'gmail', ...SMTP_PROVIDER_PRESETS.gmail }),
  'outlook.com': Object.freeze({ provider: 'outlook', ...SMTP_PROVIDER_PRESETS.outlook }),
  'hotmail.com': Object.freeze({ provider: 'outlook', ...SMTP_PROVIDER_PRESETS.outlook }),
  'live.com': Object.freeze({ provider: 'outlook', ...SMTP_PROVIDER_PRESETS.outlook }),
  'msn.com': Object.freeze({ provider: 'outlook', ...SMTP_PROVIDER_PRESETS.outlook }),
});

const PROVIDERS = new Set(Object.keys(SMTP_PROVIDER_PRESETS));
const AUTH_MODES = new Set(['login', 'oauth2', 'none']);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i;
const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const SMTP_CONFIG_SCHEMA_VERSION = 3;
const CREDENTIAL_VAULT_VERSION = 1;
const CREDENTIAL_VAULT_ALGORITHM = 'aes-256-gcm';
const CREDENTIAL_KEY_BYTES = 32;
const CREDENTIAL_IV_BYTES = 12;
const CREDENTIAL_AAD = Buffer.from('xiaohongshu-relay-scraper-ui:smtp-credentials:v1', 'utf8');

export class SmtpConfigStore {
  constructor({
    filePath,
    keyPath = `${filePath}.key`,
    defaults = {},
    verificationTtlMs = DEFAULT_VERIFICATION_TTL_MS,
    clock = () => Date.now(),
  }) {
    this.filePath = filePath;
    this.keyPath = keyPath;
    this.credentialKey = null;
    this.defaults = normalizeSmtpConfig(defaults, { allowEmpty: true });
    this.value = cloneConfig(this.defaults);
    this.clock = clock;
    this.verificationTtlMs = Math.max(1, Number(verificationTtlMs) || DEFAULT_VERIFICATION_TTL_MS);
    this.revision = 0;
    this.credentialRevision = hasRuntimeCredential(this.value) ? 1 : 0;
    this.configHash = smtpConfigHash(this.value);
    this.verifiedConfigHash = '';
    this.verifiedCredentialRevision = null;
    this.verifiedAt = '';
    this.verificationStatus = 'unverified';
    this.verificationFailureCode = '';
    this.configurationUpdatedAt = '';
    this.credentialErrorCode = '';
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let saved = null;
    this.credentialErrorCode = '';
    try {
      saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      const legacySecrets = extractSecrets(saved);
      const defaultsSecrets = extractSecrets(this.defaults);
      const encryptedSecrets = saved.credentialVault
        ? await this.decryptPersistedCredentials(saved.credentialVault)
        : null;
      const credentialSource = encryptedSecrets
        ? 'vault'
        : hasRuntimeCredential(legacySecrets)
          ? 'legacy'
          : hasRuntimeCredential(defaultsSecrets)
            ? 'defaults'
            : 'none';
      const runtimeSecrets = encryptedSecrets
        || (credentialSource === 'legacy' ? legacySecrets : defaultsSecrets);
      this.value = normalizeSmtpConfig({
        ...this.defaults,
        ...saved,
        pass: runtimeSecrets.pass,
        oauth: {
          ...this.defaults.oauth,
          ...saved.oauth,
          clientSecret: runtimeSecrets.oauth.clientSecret,
          refreshToken: runtimeSecrets.oauth.refreshToken,
        },
      }, { allowEmpty: true });
      this.revision = normalizeRevision(saved.revision, 1);
      this.credentialRevision = normalizeRevision(saved.credentialRevision, 0)
        + (['legacy', 'defaults'].includes(credentialSource) ? 1 : 0);
      this.configHash = smtpConfigHash(this.value);
      this.configurationUpdatedAt = normalizeTimestamp(saved.configurationUpdatedAt);

      const canRestoreVerification = !['legacy', 'defaults'].includes(credentialSource)
        && isRuntimeConfigured(this.value)
        && saved.configHash === this.configHash
        && saved.verifiedConfigHash === this.configHash
        && Number(saved.verifiedCredentialRevision) === this.credentialRevision;
      this.verifiedConfigHash = canRestoreVerification ? String(saved.verifiedConfigHash) : '';
      this.verifiedCredentialRevision = canRestoreVerification ? this.credentialRevision : null;
      this.verifiedAt = canRestoreVerification ? normalizeTimestamp(saved.verifiedAt || saved.lastVerifiedAt) : '';
      this.verificationStatus = canRestoreVerification && this.verifiedAt ? 'verified' : 'unverified';
      this.verificationFailureCode = canRestoreVerification ? String(saved.verificationFailureCode || '') : '';

      if (containsPersistedSecret(saved) || Number(saved.schemaVersion) !== SMTP_CONFIG_SCHEMA_VERSION) {
        await this.persist();
      }
    } catch (error) {
      if (error.code === 'ENOENT') return this.getPublic();
      if (!isRecoverableCredentialError(error)) throw error;
      this.restoreCredentialRecoveryState(saved, error.code);
    }
    return this.getPublic();
  }

  restoreCredentialRecoveryState(saved, errorCode) {
    const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    this.value = normalizeSmtpConfig({
      ...this.defaults,
      ...source,
      pass: '',
      oauth: {
        ...this.defaults.oauth,
        ...source.oauth,
        clientSecret: '',
        refreshToken: '',
      },
    }, { allowEmpty: true });
    this.revision = normalizeRevision(source.revision, 1);
    this.credentialRevision = normalizeRevision(source.credentialRevision, 0);
    this.configHash = smtpConfigHash(this.value);
    this.verifiedConfigHash = '';
    this.verifiedCredentialRevision = null;
    this.verifiedAt = '';
    this.verificationStatus = 'unverified';
    this.verificationFailureCode = '';
    this.configurationUpdatedAt = normalizeTimestamp(source.configurationUpdatedAt);
    this.credentialErrorCode = String(errorCode);
  }

  getForMailer() {
    return cloneConfig(this.value);
  }

  getVerificationSnapshot() {
    return {
      revision: this.revision,
      configHash: this.configHash,
      fingerprint: this.configHash,
      credentialRevision: this.credentialRevision,
    };
  }

  getVerificationState() {
    const configured = isRuntimeConfigured(this.value);
    let status = this.verificationStatus;
    let failureCode = this.verificationFailureCode;
    if (!configured) {
      status = 'unverified';
      failureCode = 'SMTP_NOT_CONFIGURED';
    } else if (this.verificationStatus === 'failed') {
      status = 'failed';
      failureCode ||= 'SMTP_VERIFICATION_FAILED';
    } else if (
      this.verifiedConfigHash !== this.configHash
      || this.verifiedCredentialRevision !== this.credentialRevision
    ) {
      status = 'unverified';
      failureCode = 'SMTP_NOT_VERIFIED';
    } else if (!this.verifiedAt) {
      status = this.verificationStatus === 'failed' ? 'failed' : 'unverified';
      failureCode ||= 'SMTP_NOT_VERIFIED';
    } else if (this.clock() - Date.parse(this.verifiedAt) > this.verificationTtlMs) {
      status = 'expired';
      failureCode = 'SMTP_VERIFICATION_EXPIRED';
    }
    return {
      configured,
      configHash: this.configHash,
      verifiedConfigHash: this.verifiedConfigHash,
      credentialRevision: this.credentialRevision,
      verifiedCredentialRevision: this.verifiedCredentialRevision,
      verifiedAt: this.verifiedAt,
      verificationStatus: status,
      verificationFailureCode: failureCode,
    };
  }

  isVerified() {
    return this.getVerificationState().verificationStatus === 'verified';
  }

  assertReadyForSend() {
    const state = this.getVerificationState();
    if (!state.configured) throw smtpStateError('SMTP_NOT_CONFIGURED', '请先配置 SMTP 邮件发送。');
    if (state.verificationStatus === 'expired') {
      throw smtpStateError('SMTP_VERIFICATION_EXPIRED', 'SMTP 验证已过期，请重新测试连接后再发送。');
    }
    if (state.verificationStatus !== 'verified') {
      throw smtpStateError('SMTP_NOT_VERIFIED', '当前 SMTP 配置尚未通过连接验证。');
    }
    return state;
  }

  getPublic() {
    const { pass, oauth, lastVerifiedAt: _lastVerifiedAt, ...value } = this.value;
    const verification = this.getVerificationState();
    const credentialStatus = this.credentialErrorCode
      ? 'error'
      : hasRuntimeCredential(this.value)
        ? 'available'
        : 'empty';
    return {
      ...value,
      revision: this.revision,
      configHash: this.configHash,
      verifiedConfigHash: this.verifiedConfigHash,
      verifiedAt: this.verifiedAt,
      lastVerifiedAt: this.verifiedAt,
      verificationStatus: verification.verificationStatus,
      verificationFailureCode: verification.verificationFailureCode,
      configurationUpdatedAt: this.configurationUpdatedAt,
      credentialRevision: this.credentialRevision,
      verified: verification.verificationStatus === 'verified',
      hasPassword: Boolean(pass),
      credentialStatus,
      credentialErrorCode: this.credentialErrorCode,
      resetRequired: credentialStatus === 'error',
      oauth: {
        tenant: oauth.tenant,
        clientId: oauth.clientId,
        scope: oauth.scope,
        hasClientSecret: Boolean(oauth.clientSecret),
        hasRefreshToken: Boolean(oauth.refreshToken),
      },
    };
  }

  async update(input = {}) {
    return this.enqueueMutation(async () => {
      const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const oauth = mergeOAuth(this.value.oauth, source.oauth);
      const autoConfigure = source.autoConfigure === true;
      const automatic = autoConfigure ? detectSmtpSettings(source.from || source.user) : null;
      if (autoConfigure && !automatic) {
        throw validation('暂不支持自动识别这个邮箱，请展开高级设置并填写服务商提供的 SMTP 参数。');
      }
      const next = {
        ...this.value,
        ...source,
        ...(automatic ? {
          ...automatic,
          auth: 'login',
          user: String(source.from || source.user || '').trim(),
          from: String(source.from || source.user || '').trim(),
        } : {}),
        pass: source.clearPassword ? '' : Object.hasOwn(source, 'password') && source.password !== ''
          ? String(source.password)
          : this.value.pass,
        oauth,
      };
      delete next.password;
      delete next.clearPassword;
      delete next.autoConfigure;
      const value = normalizeSmtpConfig(next);
      const nextHash = smtpConfigHash(value);
      const credentialChanged = credentialsDiffer(this.value, value);
      const configChanged = nextHash !== this.configHash;
      const changed = credentialChanged || configChanged;
      await this.commit({
        value,
        revision: changed ? this.revision + 1 : this.revision,
        credentialRevision: credentialChanged ? this.credentialRevision + 1 : this.credentialRevision,
        configurationUpdatedAt: changed ? new Date(this.clock()).toISOString() : this.configurationUpdatedAt,
        invalidateVerification: changed,
        clearCredentialError: true,
      });
      return this.getPublic();
    });
  }

  async clear() {
    return this.enqueueMutation(async () => {
      await this.commit({
        value: normalizeSmtpConfig({}, { allowEmpty: true }),
        revision: this.revision + 1,
        credentialRevision: this.credentialRevision + 1,
        configurationUpdatedAt: new Date(this.clock()).toISOString(),
        invalidateVerification: true,
        clearCredentialError: true,
      });
      await this.removeCredentialKey();
      return this.getPublic();
    });
  }

  async markVerified(expected = this.getVerificationSnapshot()) {
    return this.enqueueMutation(async () => {
      if (this.credentialErrorCode) return this.getPublic();
      const snapshot = normalizeExpectedSnapshot(expected, this.credentialRevision);
      if (snapshot.configHash !== this.configHash || snapshot.credentialRevision !== this.credentialRevision) {
        throw conflict(this.revision);
      }
      const verifiedAt = new Date(this.clock()).toISOString();
      await this.commit({
        value: this.value,
        revision: this.revision,
        credentialRevision: this.credentialRevision,
        configurationUpdatedAt: this.configurationUpdatedAt,
        verification: {
          verifiedConfigHash: this.configHash,
          verifiedCredentialRevision: this.credentialRevision,
          verifiedAt,
          verificationStatus: 'verified',
          verificationFailureCode: '',
        },
      });
      return this.getPublic();
    });
  }

  async markVerificationFailed(expected, failureCode = 'SMTP_VERIFICATION_FAILED') {
    return this.enqueueMutation(async () => {
      if (this.credentialErrorCode) return this.getPublic();
      const snapshot = normalizeExpectedSnapshot(expected, this.credentialRevision);
      if (snapshot.configHash !== this.configHash || snapshot.credentialRevision !== this.credentialRevision) {
        throw conflict(this.revision);
      }
      await this.commit({
        value: this.value,
        revision: this.revision,
        credentialRevision: this.credentialRevision,
        configurationUpdatedAt: this.configurationUpdatedAt,
        verification: {
          verifiedConfigHash: '',
          verifiedCredentialRevision: null,
          verifiedAt: '',
          verificationStatus: 'failed',
          verificationFailureCode: String(failureCode || 'SMTP_VERIFICATION_FAILED'),
        },
      });
      return this.getPublic();
    });
  }

  enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async commit({
    value,
    revision,
    credentialRevision,
    configurationUpdatedAt,
    invalidateVerification = false,
    verification,
    clearCredentialError = false,
  }) {
    const previous = this.snapshotState();
    this.value = cloneConfig(value);
    this.revision = revision;
    this.credentialRevision = credentialRevision;
    this.configHash = smtpConfigHash(value);
    this.configurationUpdatedAt = configurationUpdatedAt;
    if (invalidateVerification) {
      this.verifiedConfigHash = '';
      this.verifiedCredentialRevision = null;
      this.verifiedAt = '';
      this.verificationStatus = 'unverified';
      this.verificationFailureCode = '';
    }
    if (verification) Object.assign(this, verification);
    if (clearCredentialError) this.credentialErrorCode = '';
    try {
      await this.persist();
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    }
  }

  snapshotState() {
    return {
      value: this.value,
      revision: this.revision,
      credentialRevision: this.credentialRevision,
      configHash: this.configHash,
      verifiedConfigHash: this.verifiedConfigHash,
      verifiedCredentialRevision: this.verifiedCredentialRevision,
      verifiedAt: this.verifiedAt,
      verificationStatus: this.verificationStatus,
      verificationFailureCode: this.verificationFailureCode,
      configurationUpdatedAt: this.configurationUpdatedAt,
      credentialErrorCode: this.credentialErrorCode,
    };
  }

  async removeCredentialKey() {
    if (this.credentialKey) this.credentialKey.fill(0);
    this.credentialKey = null;
    await rm(this.keyPath, { force: true });
  }

  async persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const credentialVault = hasRuntimeCredential(this.value)
      ? await this.encryptCredentials(extractSecrets(this.value))
      : null;
    const saved = persistentSmtpConfig(this.value, {
      revision: this.revision,
      credentialRevision: this.credentialRevision,
      configHash: this.configHash,
      verifiedConfigHash: this.verifiedConfigHash,
      verifiedCredentialRevision: this.verifiedCredentialRevision,
      verifiedAt: this.verifiedAt,
      verificationStatus: this.verificationStatus,
      verificationFailureCode: this.verificationFailureCode,
      configurationUpdatedAt: this.configurationUpdatedAt,
    }, credentialVault);
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  async encryptCredentials(secrets) {
    const key = await this.getCredentialKey({ create: true });
    const iv = randomBytes(CREDENTIAL_IV_BYTES);
    const cipher = createCipheriv(CREDENTIAL_VAULT_ALGORITHM, key, iv);
    cipher.setAAD(CREDENTIAL_AAD);
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        version: CREDENTIAL_VAULT_VERSION,
        algorithm: CREDENTIAL_VAULT_ALGORITHM,
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  async decryptPersistedCredentials(vault) {
    try {
      validateCredentialVault(vault);
      const key = await this.getCredentialKey({ create: false });
      const decipher = createDecipheriv(
        CREDENTIAL_VAULT_ALGORITHM,
        key,
        Buffer.from(vault.iv, 'base64'),
      );
      decipher.setAAD(CREDENTIAL_AAD);
      decipher.setAuthTag(Buffer.from(vault.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(vault.ciphertext, 'base64')),
        decipher.final(),
      ]);
      try {
        return extractSecrets(JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (isRecoverableCredentialError(error)) throw error;
      const wrapped = smtpStateError(
        'SMTP_CREDENTIAL_DECRYPT_FAILED',
        '本机 SMTP 凭据无法解密，请恢复对应的本机密钥文件或清除后重新配置。',
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async getCredentialKey({ create }) {
    if (this.credentialKey) return this.credentialKey;
    try {
      const existing = await readFile(this.keyPath);
      this.credentialKey = validateCredentialKey(existing);
      return this.credentialKey;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) {
        throw smtpStateError(
          'SMTP_CREDENTIAL_KEY_MISSING',
          'SMTP 本机密钥文件缺失，请恢复密钥文件或清除后重新配置。',
        );
      }
    }

    await mkdir(path.dirname(this.keyPath), { recursive: true });
    const generated = randomBytes(CREDENTIAL_KEY_BYTES);
    try {
      await writeFile(this.keyPath, generated, { mode: 0o600, flag: 'wx' });
      this.credentialKey = generated;
    } catch (error) {
      generated.fill(0);
      if (error.code !== 'EEXIST') throw error;
      this.credentialKey = validateCredentialKey(await readFile(this.keyPath));
    }
    return this.credentialKey;
  }
}

export function smtpConfigHash(value = {}) {
  const normalized = normalizeSmtpConfig(value, { allowEmpty: true });
  const canonical = {
    provider: normalized.provider,
    host: normalized.host.toLowerCase(),
    port: normalized.port,
    secure: normalized.secure,
    requireTls: normalized.requireTls,
    auth: normalized.auth,
    user: normalized.user,
    from: normalized.from,
    oauth: {
      tenant: normalized.oauth.tenant,
      clientId: normalized.oauth.clientId,
      scope: normalized.oauth.scope,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const smtpConfigFingerprint = smtpConfigHash;

export function normalizeSmtpConfig(value = {}, { allowEmpty = false } = {}) {
  const host = String(value.host || '').trim();
  const from = String(value.from || '').trim();
  const user = String(value.user || '').trim();
  const pass = String(value.pass || '');
  const inferredProvider = providerForHost(host);
  const provider = PROVIDERS.has(String(value.provider || '')) ? String(value.provider) : inferredProvider;
  const auth = AUTH_MODES.has(String(value.auth || '').toLowerCase())
    ? String(value.auth).toLowerCase()
    : inferAuth(value);
  const port = Number(value.port || SMTP_PROVIDER_PRESETS[provider].port);
  const secure = typeof value.secure === 'boolean' ? value.secure : port === 465;
  const requireTls = typeof value.requireTls === 'boolean' ? value.requireTls : port === 587;
  const oauth = normalizeOAuth(value.oauth);

  if (allowEmpty) return { provider, host, port, secure, requireTls, auth, user, pass, from, oauth, lastVerifiedAt: '' };
  if (!isValidSmtpHost(host)) throw validation('SMTP 主机格式无效。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw validation('SMTP 端口必须在 1 到 65535 之间。');
  if (!EMAIL.test(from)) throw validation('发件邮箱格式无效。');
  if (auth === 'login' && !user) throw validation('SMTP 用户名不能为空。');
  if (auth === 'login' && !pass) throw validation('请填写客户端授权密码或 SMTP 密码。');
  if (auth === 'oauth2' && !(user && oauth.clientId && oauth.refreshToken)) throw validation('Outlook OAuth2 配置不完整。');
  if (pass.length > 2048) throw validation('SMTP 密码长度无效。');
  return { provider, host, port, secure, requireTls, auth, user, pass, from, oauth, lastVerifiedAt: '' };
}

export function detectSmtpSettings(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(normalized)) return null;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  const preset = SMTP_EMAIL_DOMAIN_PRESETS[domain];
  return preset ? { ...preset } : null;
}

function persistentSmtpConfig(value, metadata, credentialVault) {
  return {
    schemaVersion: SMTP_CONFIG_SCHEMA_VERSION,
    provider: value.provider,
    host: value.host,
    port: value.port,
    secure: value.secure,
    requireTls: value.requireTls,
    auth: value.auth,
    user: value.user,
    from: value.from,
    oauth: {
      tenant: value.oauth.tenant,
      clientId: value.oauth.clientId,
      scope: value.oauth.scope,
    },
    ...(credentialVault ? { credentialVault } : {}),
    ...metadata,
  };
}

function validateCredentialKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== CREDENTIAL_KEY_BYTES) {
    throw smtpStateError(
      'SMTP_CREDENTIAL_KEY_INVALID',
      'SMTP 本机密钥文件格式无效，请恢复密钥文件或清除后重新配置。',
    );
  }
  return key;
}

function validateCredentialVault(vault) {
  const valid = vault
    && Number(vault.version) === CREDENTIAL_VAULT_VERSION
    && vault.algorithm === CREDENTIAL_VAULT_ALGORITHM
    && Buffer.from(String(vault.iv || ''), 'base64').length === CREDENTIAL_IV_BYTES
    && Buffer.from(String(vault.authTag || ''), 'base64').length === 16
    && Buffer.from(String(vault.ciphertext || ''), 'base64').length > 0;
  if (!valid) {
    throw smtpStateError('SMTP_CREDENTIAL_VAULT_INVALID', 'SMTP 本机凭据存储格式无效。');
  }
}

function isRecoverableCredentialError(error) {
  return [
    'SMTP_CREDENTIAL_KEY_MISSING',
    'SMTP_CREDENTIAL_KEY_INVALID',
    'SMTP_CREDENTIAL_VAULT_INVALID',
    'SMTP_CREDENTIAL_DECRYPT_FAILED',
  ].includes(String(error?.code || ''));
}

function extractSecrets(value = {}) {
  return {
    pass: String(value.pass || value.password || ''),
    oauth: {
      clientSecret: String(value.oauth?.clientSecret || ''),
      refreshToken: String(value.oauth?.refreshToken || ''),
    },
  };
}

function containsPersistedSecret(value = {}) {
  return Boolean(value.pass || value.password || value.oauth?.clientSecret || value.oauth?.refreshToken);
}

function credentialsDiffer(first, second) {
  return first.pass !== second.pass
    || first.oauth.clientSecret !== second.oauth.clientSecret
    || first.oauth.refreshToken !== second.oauth.refreshToken;
}

function hasRuntimeCredential(value = {}) {
  return Boolean(value.pass || value.oauth?.clientSecret || value.oauth?.refreshToken);
}

function isRuntimeConfigured(value) {
  if (!(value.host && EMAIL.test(value.from))) return false;
  if (value.auth === 'login') return Boolean(value.user && value.pass);
  if (value.auth === 'oauth2') return Boolean(value.user && value.oauth.clientId && value.oauth.refreshToken);
  return value.auth === 'none';
}

function cloneConfig(value) {
  return { ...value, oauth: { ...value.oauth } };
}

function isValidSmtpHost(host) {
  if (!host || !/^[A-Za-z0-9.:-]+$/.test(host)) return false;
  return host === 'localhost' || host.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function providerForHost(host) {
  return Object.entries(SMTP_PROVIDER_PRESETS).find(([, preset]) => preset.host === host)?.[0] || 'custom';
}

function inferAuth(value) {
  if (value.oauth?.clientId || value.oauth?.refreshToken) return 'oauth2';
  if (value.user || value.pass) return 'login';
  return 'login';
}

function normalizeOAuth(value = {}) {
  return {
    tenant: String(value.tenant || 'organizations').trim(),
    clientId: String(value.clientId || '').trim(),
    clientSecret: String(value.clientSecret || ''),
    refreshToken: String(value.refreshToken || ''),
    scope: String(value.scope || 'https://outlook.office.com/SMTP.Send offline_access openid profile email').trim(),
  };
}

function mergeOAuth(current, input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const next = {
    ...current,
    ...source,
    clientSecret: source.clearClientSecret
      ? ''
      : Object.hasOwn(source, 'clientSecret') && source.clientSecret !== ''
        ? String(source.clientSecret)
        : current.clientSecret,
    refreshToken: source.clearRefreshToken
      ? ''
      : Object.hasOwn(source, 'refreshToken') && source.refreshToken !== ''
        ? String(source.refreshToken)
        : current.refreshToken,
  };
  delete next.clearClientSecret;
  delete next.clearRefreshToken;
  return next;
}

function normalizeExpectedSnapshot(value, credentialRevision) {
  if (typeof value === 'string') return { configHash: value, credentialRevision };
  return {
    configHash: String(value?.configHash || value?.fingerprint || ''),
    credentialRevision: Number(value?.credentialRevision),
  };
}

function normalizeRevision(value, fallback) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : fallback;
}

function normalizeTimestamp(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}

function smtpStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function conflict(revision) {
  const error = smtpStateError('SMTP_CONFIG_CONFLICT', 'SMTP 配置已变化，请重新测试当前配置。');
  error.currentRevision = revision;
  return error;
}

function validation(message) {
  return smtpStateError('SMTP_CONFIG_VALIDATION', message);
}
