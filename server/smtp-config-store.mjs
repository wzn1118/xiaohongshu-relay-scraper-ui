import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

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

export class SmtpConfigStore {
  constructor({ filePath, defaults = {} }) {
    this.filePath = filePath;
    this.defaults = normalizeSmtpConfig(defaults, { allowEmpty: true });
    this.value = { ...this.defaults, oauth: { ...this.defaults.oauth } };
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.value = normalizeSmtpConfig({ ...this.defaults, ...saved, oauth: { ...this.defaults.oauth, ...saved.oauth } });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.getPublic();
  }

  getForMailer() {
    return { ...this.value, oauth: { ...this.value.oauth } };
  }

  getPublic() {
    const { pass, oauth, ...value } = this.value;
    return {
      ...value,
      hasPassword: Boolean(pass),
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
      lastVerifiedAt: '',
    };
    delete next.password;
    delete next.clearPassword;
    delete next.autoConfigure;
    this.value = normalizeSmtpConfig(next);
    await this.persist();
    return this.getPublic();
  }

  async clear() {
    this.value = normalizeSmtpConfig({}, { allowEmpty: true });
    await this.persist();
    return this.getPublic();
  }

  async markVerified() {
    this.value = { ...this.value, lastVerifiedAt: new Date().toISOString() };
    await this.persist();
    return this.getPublic();
  }

  async persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

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
  const lastVerifiedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(value.lastVerifiedAt || '')) ? String(value.lastVerifiedAt) : '';

  if (allowEmpty) return { provider, host, port, secure, requireTls, auth, user, pass, from, oauth, lastVerifiedAt };
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !host.includes('.')) throw validation('SMTP 主机格式无效。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw validation('SMTP 端口必须在 1 到 65535 之间。');
  if (!EMAIL.test(from)) throw validation('发件邮箱格式无效。');
  if (auth === 'login' && !user) throw validation('SMTP 用户名不能为空。');
  if (auth === 'login' && !pass) throw validation('请填写客户端授权密码或 SMTP 密码。');
  if (auth === 'oauth2' && !(user && oauth.clientId && oauth.refreshToken)) throw validation('Outlook OAuth2 配置不完整。');
  if (pass.length > 2048) throw validation('SMTP 密码长度无效。');
  return { provider, host, port, secure, requireTls, auth, user, pass, from, oauth, lastVerifiedAt };
}

export function detectSmtpSettings(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(normalized)) return null;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  const preset = SMTP_EMAIL_DOMAIN_PRESETS[domain];
  return preset ? { ...preset } : null;
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

function validation(message) {
  const error = new Error(message);
  error.code = 'SMTP_CONFIG_VALIDATION';
  return error;
}
