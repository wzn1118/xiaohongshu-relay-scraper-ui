import nodemailer from 'nodemailer';

const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export class MailDeliveryError extends Error {
  constructor(code, message, { safeToRetry = true, deliveryStatus = 'not_sent', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MailDeliveryError';
    this.code = code;
    this.safeToRetry = safeToRetry;
    this.deliveryStatus = deliveryStatus;
  }
}

export function createMailSender(
  smtp = {},
  createTransport = nodemailer.createTransport,
  fetchImpl = fetch,
  { verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {},
) {
  let current = normalizeRuntimeConfig(smtp);
  let tokenProvider = current.authMode === 'oauth2' ? createMicrosoftTokenProvider(current.oauth, fetchImpl) : null;
  let transport = null;
  let transportAccessToken = '';

  const resetTransport = () => {
    transport?.close?.();
    transport = null;
    transportAccessToken = '';
  };

  const ensureTransport = async () => {
    const accessToken = tokenProvider ? await tokenProvider.getAccessToken() : '';
    if (!transport || (accessToken && accessToken !== transportAccessToken)) {
      resetTransport();
      transport = createTransport({
        host: current.host,
        port: current.port,
        secure: current.secure,
        requireTLS: current.requireTls,
        ...buildAuth(current.authMode, { user: current.user, pass: current.pass, accessToken }),
      });
      transportAccessToken = accessToken;
    }
    return transport;
  };

  return {
    status() {
      return {
        configured: current.configured,
        from: current.configured ? maskEmail(current.from) : '',
        authMode: current.authMode,
      };
    },
    configure(next = {}) {
      resetTransport();
      current = normalizeRuntimeConfig(next);
      tokenProvider = current.authMode === 'oauth2' ? createMicrosoftTokenProvider(current.oauth, fetchImpl) : null;
      return this.status();
    },
    async verify() {
      assertConfigured(current);
      try {
        const activeTransport = await ensureTransport();
        if (typeof activeTransport.verify === 'function') {
          await withTimeout(
            activeTransport.verify(),
            verifyTimeoutMs,
            () => new MailDeliveryError('SMTP_CONNECTION_TIMEOUT', 'SMTP 连接验证超时。'),
          );
        }
        return this.status();
      } catch (error) {
        resetTransport();
        throw classifySmtpError(error, 'verify');
      }
    },
    async send(message = {}) {
      assertConfigured(current);
      try {
        const activeTransport = await ensureTransport();
        const payload = buildMessage(current.from, message);
        const result = await withTimeout(
          activeTransport.sendMail(payload),
          sendTimeoutMs,
          () => new MailDeliveryError('SMTP_CONNECTION_TIMEOUT', '邮件发送等待超时，投递结果未知。', {
            safeToRetry: false,
            deliveryStatus: 'unknown',
          }),
        );
        const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
        const rejected = Array.isArray(result.rejected) ? result.rejected.map(String) : [];
        if (!accepted.length && rejected.length) {
          throw new MailDeliveryError('SMTP_RECIPIENT_REJECTED', 'SMTP 服务器拒绝了收件人。');
        }
        return {
          messageId: String(result.messageId || ''),
          accepted,
          rejected,
        };
      } catch (error) {
        const classified = classifySmtpError(error, 'send');
        if (classified.deliveryStatus !== 'not_sent') resetTransport();
        throw classified;
      }
    },
  };
}

export function classifySmtpError(error, operation = 'send') {
  if (error instanceof MailDeliveryError) return error;
  const code = String(error?.code || '').toUpperCase();
  const command = String(error?.command || '').toUpperCase();
  const responseCode = Number(error?.responseCode || error?.statusCode || 0);
  const message = String(error?.message || '').toLowerCase();
  const details = `${code} ${command} ${responseCode} ${message}`;
  const options = { cause: error };

  if (code === 'EAUTH' || command === 'AUTH' || [534, 535].includes(responseCode) || /auth|oauth|credential|password/.test(details)) {
    return new MailDeliveryError('SMTP_AUTH_FAILED', 'SMTP 认证失败，请检查账号和客户端授权凭证。', options);
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(code) || /getaddrinfo|dns/.test(details)) {
    return new MailDeliveryError('SMTP_DNS_FAILED', 'SMTP 主机名解析失败。', options);
  }
  if (['ETIMEDOUT', 'ETIMEOUT'].includes(code) || /timed?\s*out|timeout/.test(details)) {
    return new MailDeliveryError('SMTP_CONNECTION_TIMEOUT', operation === 'send'
      ? '邮件发送等待超时，投递结果未知。'
      : 'SMTP 连接验证超时。', {
      ...options,
      safeToRetry: operation !== 'send',
      deliveryStatus: operation === 'send' ? 'unknown' : 'not_sent',
    });
  }
  if (code === 'ETLS' || /tls|ssl|certificate|starttls|self.signed/.test(details)) {
    return new MailDeliveryError('SMTP_TLS_FAILED', 'SMTP TLS 握手或证书验证失败。', options);
  }
  if ([421, 450, 451, 452].includes(responseCode) || /rate|too many|throttl|temporar.*limit/.test(details)) {
    return new MailDeliveryError('SMTP_RATE_LIMITED', 'SMTP 服务器暂时限制了发送频率。', options);
  }
  if (command.includes('MAIL') || /sender|mail from/.test(details)) {
    return new MailDeliveryError('SMTP_SENDER_REJECTED', 'SMTP 服务器拒绝了发件人。', options);
  }
  if (command.includes('RCPT') || /recipient|rcpt|rejected/.test(details)) {
    return new MailDeliveryError('SMTP_RECIPIENT_REJECTED', 'SMTP 服务器拒绝了收件人。', options);
  }
  return new MailDeliveryError(
    operation === 'verify' ? 'SMTP_VERIFICATION_FAILED' : 'SMTP_SEND_FAILED',
    operation === 'verify' ? 'SMTP 连接验证失败。' : '邮件发送失败。',
    operation === 'send'
      ? { ...options, safeToRetry: false, deliveryStatus: 'unknown' }
      : options,
  );
}

function buildMessage(from, message) {
  const payload = {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  };
  for (const field of ['html', 'attachments', 'replyTo', 'cc', 'bcc', 'headers']) {
    if (message[field] !== undefined && message[field] !== '') payload[field] = message[field];
  }
  return payload;
}

function withTimeout(promise, timeoutMs, timeoutError) {
  const duration = Math.max(1, Number(timeoutMs) || 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), duration);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveAuthMode(value, { user, pass, oauth }) {
  const requested = String(value || 'auto').trim().toLowerCase();
  if (requested === 'oauth2' || requested === 'login' || requested === 'none') return requested;
  if (oauth.clientId || oauth.refreshToken) return 'oauth2';
  if (user || pass) return 'login';
  return 'none';
}

function isAuthConfigured(mode, { user, pass, oauth }) {
  if (mode === 'oauth2') return Boolean(user && oauth.clientId && oauth.refreshToken);
  if (mode === 'login') return Boolean(user && pass);
  return mode === 'none';
}

function buildAuth(mode, { user, pass, accessToken }) {
  if (mode === 'oauth2') return { auth: { type: 'OAuth2', user, accessToken } };
  if (mode === 'login') return { auth: { user, pass } };
  return {};
}

function createMicrosoftTokenProvider(oauth, fetchImpl) {
  const tenant = String(oauth.tenant || 'organizations').trim();
  const clientId = String(oauth.clientId || '').trim();
  const clientSecret = String(oauth.clientSecret || '');
  const refreshToken = String(oauth.refreshToken || '');
  const scope = String(oauth.scope || 'https://outlook.office.com/SMTP.Send offline_access openid profile email').trim();
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  let cachedToken = '';
  let expiresAt = 0;

  return {
    async getAccessToken() {
      if (cachedToken && expiresAt > Date.now() + 60_000) return cachedToken;
      const body = new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope,
      });
      if (clientSecret) body.set('client_secret', clientSecret);
      const response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // Provider responses are deliberately excluded from user-facing errors and logs.
      }
      if (!response.ok || !payload.access_token) {
        const error = new Error('OAuth2 token refresh failed.');
        error.code = 'EAUTH';
        throw error;
      }
      cachedToken = String(payload.access_token);
      expiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
      return cachedToken;
    },
  };
}

function normalizeRuntimeConfig(smtp = {}) {
  const host = String(smtp.host || '').trim();
  const from = String(smtp.from || '').trim();
  const user = String(smtp.user || '').trim();
  const pass = String(smtp.pass || '');
  const oauth = smtp.oauth || {};
  const authMode = resolveAuthMode(smtp.auth, { user, pass, oauth });
  return {
    host,
    from,
    user,
    pass,
    oauth,
    authMode,
    port: Number(smtp.port || 587),
    secure: Boolean(smtp.secure),
    requireTls: Boolean(smtp.requireTls),
    configured: Boolean(host && from && isAuthConfigured(authMode, { user, pass, oauth })),
  };
}

function assertConfigured(current) {
  if (current.configured) return;
  throw new MailDeliveryError('SMTP_NOT_CONFIGURED', current.authMode === 'oauth2'
    ? 'Outlook OAuth2 尚未完成授权。'
    : '请先在工作台中配置发件邮箱和客户端授权密码。');
}

function maskEmail(value) {
  const match = String(value).match(/^(.)([^@]*)(@.+)$/);
  if (!match) return value;
  return `${match[1]}***${match[3]}`;
}
