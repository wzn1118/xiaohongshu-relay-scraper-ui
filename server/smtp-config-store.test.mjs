import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { detectSmtpSettings, SmtpConfigStore } from './smtp-config-store.mjs';

test('SMTP settings are detected from common mailbox domains', () => {
  assert.deepEqual(detectSmtpSettings('candidate@163.com'), {
    provider: '163', host: 'smtp.163.com', port: 465, secure: true, requireTls: false,
  });
  assert.equal(detectSmtpSettings('candidate@126.com').host, 'smtp.126.com');
  assert.equal(detectSmtpSettings('candidate@foxmail.com').provider, 'qq');
  assert.equal(detectSmtpSettings('candidate@gmail.com').host, 'smtp.gmail.com');
  assert.equal(detectSmtpSettings('candidate@outlook.com').port, 587);
  assert.equal(detectSmtpSettings('candidate@company.example'), null);
});

test('automatic SMTP configuration only needs an email and password', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-auto-'));
  try {
    const store = new SmtpConfigStore({ filePath: path.join(fixture, 'smtp-config.json') });
    await store.initialize();
    const saved = await store.update({
      autoConfigure: true,
      from: 'candidate@163.com',
      password: 'client-authorization-code',
    });

    assert.equal(saved.provider, '163');
    assert.equal(saved.host, 'smtp.163.com');
    assert.equal(saved.user, 'candidate@163.com');
    assert.equal(saved.from, 'candidate@163.com');
    assert.equal(saved.hasPassword, true);
    assert.equal(store.getForMailer().auth, 'login');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('automatic SMTP configuration rejects unknown mailbox domains', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-auto-unknown-'));
  try {
    const store = new SmtpConfigStore({ filePath: path.join(fixture, 'smtp-config.json') });
    await store.initialize();
    await assert.rejects(() => store.update({
      autoConfigure: true,
      from: 'candidate@company.example',
      password: 'secret',
    }), { code: 'SMTP_CONFIG_VALIDATION' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

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

test('OAuth2 configuration preserves hidden secrets while allowing frontend edits', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-oauth-'));
  try {
    const store = new SmtpConfigStore({ filePath: path.join(fixture, 'smtp-config.json') });
    await store.initialize();
    const saved = await store.update({
      provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true,
      auth: 'oauth2', user: 'candidate@outlook.com', from: 'candidate@outlook.com',
      oauth: {
        tenant: 'organizations', clientId: 'client-id', clientSecret: 'client-secret',
        refreshToken: 'refresh-token', scope: 'https://outlook.office.com/SMTP.Send offline_access',
      },
    });
    assert.equal(saved.oauth.hasClientSecret, true);
    assert.equal(saved.oauth.hasRefreshToken, true);
    assert.equal('clientSecret' in saved.oauth, false);
    assert.equal('refreshToken' in saved.oauth, false);

    await store.update({
      from: 'updated@outlook.com', user: 'updated@outlook.com',
      oauth: { tenant: 'consumers', clientId: 'updated-client-id', clientSecret: '', refreshToken: '' },
    });
    const privateConfig = store.getForMailer();
    assert.equal(privateConfig.oauth.tenant, 'consumers');
    assert.equal(privateConfig.oauth.clientSecret, 'client-secret');
    assert.equal(privateConfig.oauth.refreshToken, 'refresh-token');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('SMTP configuration can be cleared completely from the frontend', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-clear-'));
  const filePath = path.join(fixture, 'smtp-config.json');
  try {
    const store = new SmtpConfigStore({ filePath });
    await store.initialize();
    await store.update({
      provider: '163', host: 'smtp.163.com', port: 465, secure: true, requireTls: false,
      auth: 'login', user: 'candidate@163.com', from: 'candidate@163.com', password: 'secret',
    });
    const cleared = await store.clear();
    assert.equal(cleared.from, '');
    assert.equal(cleared.hasPassword, false);
    assert.equal(cleared.oauth.hasRefreshToken, false);
    assert.doesNotMatch(await readFile(filePath, 'utf8'), /candidate@163\.com|secret/);
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
