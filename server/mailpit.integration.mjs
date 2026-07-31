import assert from 'node:assert/strict';
import test from 'node:test';

import { createMailSender } from './mail-sender.mjs';

const smtpPort = Number(process.env.MAILPIT_SMTP_PORT);
const apiBase = String(process.env.MAILPIT_HTTP_URL || '').replace(/\/$/, '');

if (!smtpPort || !apiBase) {
  throw new Error('MAILPIT_SMTP_PORT and MAILPIT_HTTP_URL are required.');
}

test('Mailpit receives the expected UTF-8 body, attachment, and raw MIME', async () => {
  const purgeResponse = await fetch(`${apiBase}/api/v1/messages`, { method: 'DELETE' });
  assert.equal(purgeResponse.ok, true, `Mailpit purge failed with ${purgeResponse.status}`);

  const sender = createMailSender({
    host: '127.0.0.1',
    port: smtpPort,
    secure: false,
    requireTls: false,
    auth: 'none',
    from: 'sender@example.test',
  });

  await sender.verify();
  const delivery = await sender.send({
    to: 'recipient@example.test',
    replyTo: 'reply@example.test',
    subject: '阶段七 SMTP MIME 验收',
    text: '这是 UTF-8 纯文本正文。\n第二行保持可见。',
    html: '<p>这是 <strong>UTF-8</strong> HTML 正文。</p>',
    attachments: [{
      filename: 'phase7-验收.txt',
      content: Buffer.from('阶段七附件内容\n', 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    }],
  });
  assert.match(delivery.messageId, /.+/);
  assert.deepEqual(delivery.accepted, ['recipient@example.test']);
  assert.deepEqual(delivery.rejected, []);

  const listResponse = await fetch(`${apiBase}/api/v1/messages`);
  assert.equal(listResponse.ok, true);
  const list = await listResponse.json();
  assert.equal(list.messages_count, 1);
  assert.equal(list.messages.length, 1);

  const id = list.messages[0].ID;
  const detailResponse = await fetch(`${apiBase}/api/v1/message/${encodeURIComponent(id)}`);
  assert.equal(detailResponse.ok, true);
  const message = await detailResponse.json();
  assert.equal(message.Subject, '阶段七 SMTP MIME 验收');
  assert.equal(message.Text.trim(), '这是 UTF-8 纯文本正文。\n第二行保持可见。');
  assert.match(message.HTML, /这是 <strong>UTF-8<\/strong> HTML 正文/);
  assert.equal(message.From.Address, 'sender@example.test');
  assert.equal(message.To[0].Address, 'recipient@example.test');
  assert.equal(message.ReplyTo[0].Address, 'reply@example.test');
  assert.equal(message.Attachments.length, 1);
  assert.equal(message.Attachments[0].FileName, 'phase7-验收.txt');
  assert.equal(message.Attachments[0].ContentType, 'text/plain');
  assert.ok(message.Attachments[0].Size > 0);

  const rawResponse = await fetch(`${apiBase}/api/v1/message/${encodeURIComponent(id)}/raw`);
  assert.equal(rawResponse.ok, true);
  const raw = await rawResponse.text();
  assert.match(raw, /MIME-Version: 1\.0/i);
  assert.match(raw, /Content-Type: multipart\/mixed/i);
  assert.match(raw, /Content-Disposition: attachment/i);
  assert.match(raw, /filename\*0\*=utf-8''phase7-/i);
  assert.match(raw, /Content-Transfer-Encoding: base64/i);
});
