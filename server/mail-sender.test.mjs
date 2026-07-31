import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySmtpError, createMailSender } from './mail-sender.mjs';

test('mail sender stays disabled without local SMTP configuration', async () => {
  const sender = createMailSender({});
  assert.deepEqual(sender.status(), { configured: false, from: '', authMode: 'none' });
  await assert.rejects(
    sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' }),
    { code: 'SMTP_NOT_CONFIGURED' },
  );
});

test('mail sender preserves subject, text, HTML, attachments, headers, and reply-to', async () => {
  let transportOptions;
  let message;
  const sender = createMailSender(
    {
      host: 'smtp.example.com', port: 465, secure: true,
      user: 'candidate@example.com', pass: 'secret', from: 'candidate@example.com',
    },
    (options) => {
      transportOptions = options;
      return {
        async sendMail(value) {
          message = value;
          return { messageId: 'message-1', accepted: [value.to], rejected: [] };
        },
      };
    },
  );
  const attachments = [{ filename: 'resume.txt', content: 'resume-content' }];
  const headers = { 'X-Trace-Id': 'trace-1' };
  const sent = await sender.send({
    to: 'jobs@example.com',
    subject: 'Edited subject',
    text: 'Edited body',
    html: '<p>Edited body</p>',
    attachments,
    headers,
    replyTo: 'reply@example.com',
  });

  assert.deepEqual(sender.status(), { configured: true, from: 'c***@example.com', authMode: 'login' });
  assert.deepEqual(sent, { messageId: 'message-1', accepted: ['jobs@example.com'], rejected: [] });
  assert.deepEqual(transportOptions, {
    host: 'smtp.example.com', port: 465, secure: true, requireTLS: false,
    auth: { user: 'candidate@example.com', pass: 'secret' },
  });
  assert.deepEqual(message, {
    from: 'candidate@example.com',
    to: 'jobs@example.com',
    subject: 'Edited subject',
    text: 'Edited body',
    html: '<p>Edited body</p>',
    attachments,
    replyTo: 'reply@example.com',
    headers,
  });
});

test('mail sender refreshes an Outlook OAuth2 token and requires STARTTLS', async () => {
  let tokenRequest;
  let transportOptions;
  const sender = createMailSender(
    {
      host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTls: true,
      auth: 'oauth2', user: 'candidate@outlook.com', from: 'candidate@outlook.com',
      oauth: {
        tenant: 'consumers', clientId: 'client-id', refreshToken: 'refresh-token',
        scope: 'https://outlook.office.com/SMTP.Send offline_access',
      },
    },
    (options) => {
      transportOptions = options;
      return { async sendMail(value) { return { messageId: 'oauth-mail', accepted: [value.to], rejected: [] }; } };
    },
    async (url, options) => {
      tokenRequest = { url, body: Object.fromEntries(options.body) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-token', expires_in: 3600 }) };
    },
  );

  await sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' });
  assert.equal(tokenRequest.url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.deepEqual(tokenRequest.body, {
    client_id: 'client-id', refresh_token: 'refresh-token', grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/SMTP.Send offline_access',
  });
  assert.deepEqual(transportOptions, {
    host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true,
    auth: { type: 'OAuth2', user: 'candidate@outlook.com', accessToken: 'access-token' },
  });
});

test('mail sender keeps partially configured Outlook OAuth2 disabled', () => {
  const sender = createMailSender({
    host: 'smtp-mail.outlook.com', from: 'candidate@outlook.com', user: 'candidate@outlook.com',
    auth: 'oauth2', oauth: { clientId: 'client-id' },
  });
  assert.deepEqual(sender.status(), { configured: false, from: '', authMode: 'oauth2' });
});

test('SMTP failures have stable categories and retry semantics', () => {
  const cases = [
    [{ code: 'EAUTH', command: 'AUTH' }, 'SMTP_AUTH_FAILED'],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo failed' }, 'SMTP_DNS_FAILED'],
    [{ code: 'ETIMEDOUT', message: 'connection timeout' }, 'SMTP_CONNECTION_TIMEOUT'],
    [{ code: 'ESOCKET', message: 'self signed TLS certificate' }, 'SMTP_TLS_FAILED'],
    [{ command: 'MAIL FROM', responseCode: 550 }, 'SMTP_SENDER_REJECTED'],
    [{ command: 'RCPT TO', responseCode: 550 }, 'SMTP_RECIPIENT_REJECTED'],
    [{ responseCode: 421, message: 'too many messages' }, 'SMTP_RATE_LIMITED'],
  ];
  for (const [input, code] of cases) {
    const error = classifySmtpError(Object.assign(new Error(input.message || 'SMTP failure'), input), 'verify');
    assert.equal(error.code, code);
    assert.equal(error.deliveryStatus, 'not_sent');
  }
  const ambiguous = classifySmtpError(new Error('unexpected socket close'), 'send');
  assert.equal(ambiguous.code, 'SMTP_SEND_FAILED');
  assert.equal(ambiguous.safeToRetry, false);
  assert.equal(ambiguous.deliveryStatus, 'unknown');
});

test('fully rejected recipients use the recipient rejection category', async () => {
  const sender = createMailSender(
    { host: 'smtp.example.com', from: 'candidate@example.com' },
    () => ({ async sendMail(value) { return { accepted: [], rejected: [value.to] }; } }),
  );
  await assert.rejects(
    sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' }),
    { code: 'SMTP_RECIPIENT_REJECTED', deliveryStatus: 'not_sent' },
  );
});

test('transport verify has a hard timeout and closes the stale transport', async () => {
  let closed = 0;
  const sender = createMailSender(
    { host: 'smtp.example.com', from: 'candidate@example.com' },
    () => ({ verify: () => new Promise(() => {}), close: () => { closed += 1; } }),
    fetch,
    { verifyTimeoutMs: 15 },
  );
  await assert.rejects(sender.verify(), { code: 'SMTP_CONNECTION_TIMEOUT' });
  assert.equal(closed, 1);
});

test('send timeout is marked unknown and not safe to retry', async () => {
  const sender = createMailSender(
    { host: 'smtp.example.com', from: 'candidate@example.com' },
    () => ({ sendMail: () => new Promise(() => {}) }),
    fetch,
    { sendTimeoutMs: 15 },
  );
  await assert.rejects(
    sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' }),
    { code: 'SMTP_CONNECTION_TIMEOUT', safeToRetry: false, deliveryStatus: 'unknown' },
  );
});

test('mail sender can hot-swap accounts and verify the active transport', async () => {
  const transports = [];
  const sender = createMailSender({}, (options) => {
    transports.push(options);
    return { async verify() {}, close() {} };
  });
  sender.configure({
    host: 'smtp.example.com', port: 465, secure: true, requireTls: false,
    auth: 'login', user: 'new@example.com', pass: 'new-secret', from: 'new@example.com',
  });
  assert.deepEqual(await sender.verify(), { configured: true, from: 'n***@example.com', authMode: 'login' });
  assert.equal(transports.length, 1);
  assert.equal(transports[0].auth.pass, 'new-secret');
});
