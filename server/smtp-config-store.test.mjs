import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { SmtpConfigStore } from './smtp-config-store.mjs';

test('SMTP configuration persists locally without exposing its password', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-config-'));
  const filePath = path.join(fixture, 'smtp-config.json');
  try {
    const first = new SmtpConfigStore({ filePath });
    await first.initialize();
    const saved = await first.update({
      provider: '163',
      host: 'smtp.163.com',
      port: 465,
      secure: true,
      requireTls: false,
      auth: 'login',
      user: 'candidate@example.com',
      from: 'candidate@example.com',
      password: 'client-authorization-code',
    });
    assert.equal(saved.hasPassword, true);
    assert.equal('pass' in saved, false);
    assert.equal('password' in saved, false);

    const second = new SmtpConfigStore({ filePath });
    await second.initialize();
    assert.equal(second.getPublic().user, 'candidate@example.com');
    assert.equal(second.getForMailer().pass, 'client-authorization-code');
    assert.equal(second.getPublic().lastVerifiedAt, '');
    const verified = await second.markVerified();
    assert.match(verified.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(await readFile(filePath, 'utf8'), /client-authorization-code/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('SMTP configuration preserves an existing password when the UI leaves it blank', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-preserve-'));
  try {
    const store = new SmtpConfigStore({ filePath: path.join(fixture, 'smtp-config.json') });
    await store.initialize();
    await store.update({
      provider: 'custom', host: 'smtp.example.com', port: 587, secure: false, requireTls: true,
      auth: 'login', user: 'first@example.com', from: 'first@example.com', password: 'existing-secret',
    });
    await store.update({ user: 'second@example.com', from: 'second@example.com', password: '' });
    assert.equal(store.getForMailer().pass, 'existing-secret');
    assert.equal(store.getPublic().from, 'second@example.com');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('SMTP configuration validates provider settings', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-invalid-'));
  try {
    const store = new SmtpConfigStore({ filePath: path.join(fixture, 'smtp-config.json') });
    await store.initialize();
    await assert.rejects(() => store.update({
      provider: 'custom', host: 'bad host', port: 465, secure: true, requireTls: false,
      auth: 'login', user: 'candidate@example.com', from: 'candidate@example.com', password: 'secret',
    }), { code: 'SMTP_CONFIG_VALIDATION' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('incomplete legacy environment defaults do not block server startup', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-defaults-'));
  try {
    const store = new SmtpConfigStore({
      filePath: path.join(fixture, 'smtp-config.json'),
      defaults: { host: 'smtp.example.com', port: 587, from: 'incomplete-placeholder', auth: 'login' },
    });
    const value = await store.initialize();
    assert.equal(value.from, 'incomplete-placeholder');
    assert.equal(value.hasPassword, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
