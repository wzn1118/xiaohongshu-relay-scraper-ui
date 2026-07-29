import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailSender } from './mail-sender.mjs';

test('mail sender stays disabled without local SMTP configuration', async () => {
  const sender = createMailSender({});
  assert.deepEqual(sender.status(), { configured: false, from: '' });
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

  assert.deepEqual(sender.status(), { configured: true, from: 'c***@example.com' });
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
