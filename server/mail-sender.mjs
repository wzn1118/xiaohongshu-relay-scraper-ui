import nodemailer from 'nodemailer';

export class MailDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDeliveryError';
    this.code = code;
  }
}

export function createMailSender(smtp = {}, createTransport = nodemailer.createTransport, fetchImpl = fetch) {
  const host = String(smtp.host || '').trim();
  const from = String(smtp.from || '').trim();
  const user = String(smtp.user || '').trim();
  const pass = String(smtp.pass || '');
  const oauth = smtp.oauth || {};
  const authMode = resolveAuthMode(smtp.auth, { user, pass, oauth });
  const configured = Boolean(host && from && isAuthConfigured(authMode, { user, pass, oauth }));
  const tokenProvider = authMode === 'oauth2' ? createMicrosoftTokenProvider(oauth, fetchImpl) : null;
  let transport = null;
  let transportAccessToken = '';

  return {
    status() {
      return {
        configured,
        from: configured ? maskEmail(from) : '',
        authMode,
      };
    },
    async send({ to, subject, text, replyTo }) {
      if (!configured) {
        throw new MailDeliveryError('MAIL_NOT_CONFIGURED', authMode === 'oauth2'
          ? '请先在 .env 中完成 Outlook OAuth2 账号授权配置。'
          : '请先在 .env 中配置 SMTP_HOST、SMTP_FROM 及账号信息。');
      }
      try {
        const accessToken = tokenProvider ? await tokenProvider.getAccessToken() : '';
        if (!transport || (accessToken && accessToken !== transportAccessToken)) {
          transport?.close?.();
          transport = createTransport({
            host,
            port: Number(smtp.port || 587),
            secure: Boolean(smtp.secure),
            requireTLS: Boolean(smtp.requireTls),
            ...buildAuth(authMode, { user, pass, accessToken }),
          });
          transportAccessToken = accessToken;
        }
        const result = await transport.sendMail({ from, to, subject, text, ...(replyTo ? { replyTo } : {}) });
        const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
        const rejected = Array.isArray(result.rejected) ? result.rejected.map(String) : [];
        if (!accepted.length && rejected.length) {
          throw new Error(`SMTP rejected recipient: ${rejected.join(', ')}`);
        }
        return {
          messageId: String(result.messageId || ''),
          accepted,
          rejected,
        };
      } catch (error) {
        throw new MailDeliveryError('MAIL_SEND_FAILED', `邮件发送失败：${String(error?.message || error)}`);
      }
    },
  };
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
        // The normalized error below avoids leaking a provider response into app logs.
      }
      if (!response.ok || !payload.access_token) {
        const providerCode = String(payload.error || `HTTP_${response.status}`);
        throw new Error(`Outlook OAuth2 token refresh failed (${providerCode})`);
      }
      cachedToken = String(payload.access_token);
      expiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
      return cachedToken;
    },
  };
}

function maskEmail(value) {
  const match = String(value).match(/^(.)([^@]*)(@.+)$/);
  if (!match) return value;
  return `${match[1]}***${match[3]}`;
}
