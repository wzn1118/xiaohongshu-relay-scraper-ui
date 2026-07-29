import nodemailer from 'nodemailer';

export class MailDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDeliveryError';
    this.code = code;
  }
}

export function createMailSender(smtp = {}, createTransport = nodemailer.createTransport) {
  const host = String(smtp.host || '').trim();
  const from = String(smtp.from || '').trim();
  const user = String(smtp.user || '').trim();
  const pass = String(smtp.pass || '');
  const configured = Boolean(host && from && ((!user && !pass) || (user && pass)));
  let transport = null;

  return {
    status() {
      return {
        configured,
        from: configured ? maskEmail(from) : '',
      };
    },
    async send({ to, subject, text, replyTo }) {
      if (!configured) {
        throw new MailDeliveryError('MAIL_NOT_CONFIGURED', '请先在 .env 中配置 SMTP_HOST、SMTP_FROM 及账号信息。');
      }
      transport ||= createTransport({
        host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        ...(user ? { auth: { user, pass } } : {}),
      });
      try {
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

function maskEmail(value) {
  const match = String(value).match(/^(.)([^@]*)(@.+)$/);
  if (!match) return value;
  return `${match[1]}***${match[3]}`;
}
