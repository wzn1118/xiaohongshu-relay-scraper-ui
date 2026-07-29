import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const SMTP_PROVIDER_PRESETS = Object.freeze({
  '163': Object.freeze({ host: 'smtp.163.com', port: 465, secure: true, requireTls: false }),
  qq: Object.freeze({ host: 'smtp.qq.com', port: 465, secure: true, requireTls: false }),
  gmail: Object.freeze({ host: 'smtp.gmail.com', port: 465, secure: true, requireTls: false }),
  outlook: Object.freeze({ host: 'smtp.office365.com', port: 587, secure: false, requireTls: true }),
  custom: Object.freeze({ host: '', port: 465, secure: true, requireTls: false }),
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
    const next = {
      ...this.value,
      ...source,
      pass: source.clearPassword ? '' : Object.hasOwn(source, 'password') && source.password !== ''
        ? String(source.password)
        : this.value.pass,
      oauth: { ...this.value.oauth, ...(source.oauth || {}) },
      lastVerifiedAt: '',
    };
    delete next.password;
    delete next.clearPassword;
    this.value = normalizeSmtpConfig(next);
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

function validation(message) {
  const error = new Error(message);
  error.code = 'SMTP_CONFIG_VALIDATION';
  return error;
}
