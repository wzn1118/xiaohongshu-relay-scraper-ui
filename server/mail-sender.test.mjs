import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailSender } from './mail-sender.mjs';

test('mail sender stays disabled without local SMTP configuration', async () => {
  const sender = createMailSender({});
  assert.deepEqual(sender.status(), { configured: false, from: '', authMode: 'none' });
  await assert.rejects(
    sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' }),
    (error) => error.code === 'MAIL_NOT_CONFIGURED',
  );
});

test('mail sender masks the sender and forwards the edited message', async () => {
  let transportOptions;
  let message;
  const sender = createMailSender(
    {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'candidate@example.com',
      pass: 'secret',
      from: 'candidate@example.com',
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

  assert.deepEqual(sender.status(), { configured: true, from: 'c***@example.com', authMode: 'login' });
  assert.deepEqual(
    await sender.send({
      to: 'jobs@example.com',
      subject: 'Edited subject',
      text: 'Edited body',
      replyTo: 'reply@example.com',
    }),
    { messageId: 'message-1', accepted: ['jobs@example.com'], rejected: [] },
  );
  assert.deepEqual(transportOptions, {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    requireTLS: false,
    auth: { user: 'candidate@example.com', pass: 'secret' },
  });
  assert.deepEqual(message, {
    from: 'candidate@example.com',
    to: 'jobs@example.com',
    subject: 'Edited subject',
    text: 'Edited body',
    replyTo: 'reply@example.com',
  });
});

test('mail sender refreshes an Outlook OAuth2 token and requires STARTTLS', async () => {
  let tokenRequest;
  let transportOptions;
  const sender = createMailSender(
    {
      host: 'smtp-mail.outlook.com',
      port: 587,
      secure: false,
      requireTls: true,
      auth: 'oauth2',
      user: 'candidate@outlook.com',
      from: 'candidate@outlook.com',
      oauth: {
        tenant: 'consumers',
        clientId: 'client-id',
        refreshToken: 'refresh-token',
        scope: 'https://outlook.office.com/SMTP.Send offline_access',
      },
    },
    (options) => {
      transportOptions = options;
      return {
        async sendMail(value) {
          return { messageId: 'oauth-mail', accepted: [value.to], rejected: [] };
        },
      };
    },
    async (url, options) => {
      tokenRequest = { url, options, body: Object.fromEntries(options.body) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-token', expires_in: 3600 }) };
    },
  );

  assert.deepEqual(sender.status(), { configured: true, from: 'c***@outlook.com', authMode: 'oauth2' });
  await sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' });
  assert.equal(tokenRequest.url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.deepEqual(tokenRequest.body, {
    client_id: 'client-id',
    refresh_token: 'refresh-token',
    grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/SMTP.Send offline_access',
  });
  assert.deepEqual(transportOptions, {
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { type: 'OAuth2', user: 'candidate@outlook.com', accessToken: 'access-token' },
  });
});

test('mail sender keeps partially configured Outlook OAuth2 disabled', () => {
  const sender = createMailSender({
    host: 'smtp-mail.outlook.com',
    from: 'candidate@outlook.com',
    user: 'candidate@outlook.com',
    auth: 'oauth2',
    oauth: { clientId: 'client-id' },
  });
  assert.deepEqual(sender.status(), { configured: false, from: '', authMode: 'oauth2' });
});

test('mail sender treats a fully rejected recipient as a delivery failure', async () => {
  const sender = createMailSender(
    { host: 'smtp.example.com', from: 'candidate@example.com' },
    () => ({
      async sendMail(value) {
        return { accepted: [], rejected: [value.to] };
      },
    }),
  );

  await assert.rejects(
    sender.send({ to: 'jobs@example.com', subject: 'subject', text: 'body' }),
    (error) => error.code === 'MAIL_SEND_FAILED' && /rejected recipient/.test(error.message),
  );
});
