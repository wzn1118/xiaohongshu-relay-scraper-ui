import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { detectSmtpSettings, smtpConfigHash, SmtpConfigStore } from './smtp-config-store.mjs';

const LOGIN_CONFIG = Object.freeze({
  provider: 'custom',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  auth: 'login',
  user: 'candidate@example.com',
  from: 'candidate@example.com',
  password: 'client-authorization-code',
});

async function fixtureStore(options = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-phase7-'));
  const filePath = path.join(fixture, 'smtp-config.json');
  const store = new SmtpConfigStore({ filePath, ...options });
  await store.initialize();
  return { fixture, filePath, store };
}

test('SMTP settings are detected from common mailbox domains', () => {
  assert.equal(detectSmtpSettings('candidate@163.com').host, 'smtp.163.com');
  assert.equal(detectSmtpSettings('candidate@126.com').host, 'smtp.126.com');
  assert.equal(detectSmtpSettings('candidate@foxmail.com').provider, 'qq');
  assert.equal(detectSmtpSettings('candidate@gmail.com').host, 'smtp.gmail.com');
  assert.equal(detectSmtpSettings('candidate@outlook.com').port, 587);
  assert.equal(detectSmtpSettings('candidate@company.example'), null);
});

test('automatic SMTP configuration keeps its credential in memory only', async () => {
  const { fixture, filePath, store } = await fixtureStore();
  try {
    const saved = await store.update({
      autoConfigure: true,
      from: 'candidate@163.com',
      password: 'client-authorization-code',
    });
    assert.equal(saved.provider, '163');
    assert.equal(saved.user, 'candidate@163.com');
    assert.equal(saved.hasPassword, true);
    assert.equal(store.getForMailer().pass, 'client-authorization-code');
    assert.doesNotMatch(await readFile(filePath, 'utf8'), /client-authorization-code|"pass"|"password"/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('automatic SMTP configuration rejects unknown mailbox domains', async () => {
  const { fixture, store } = await fixtureStore();
  try {
    await assert.rejects(() => store.update({
      autoConfigure: true,
      from: 'candidate@company.example',
      password: 'secret',
    }), { code: 'SMTP_CONFIG_VALIDATION' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('password and OAuth credentials never persist in plaintext or derived hashes', async () => {
  const { fixture, filePath, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    const loginHash = store.getPublic().configHash;
    await store.update({ password: 'different-password' });
    assert.equal(store.getPublic().configHash, loginHash);

    await store.update({
      provider: 'outlook', host: 'smtp.office365.com', port: 587, secure: false, requireTls: true,
      auth: 'oauth2', user: 'candidate@outlook.com', from: 'candidate@outlook.com', clearPassword: true,
      oauth: {
        tenant: 'organizations', clientId: 'client-id', clientSecret: 'client-secret',
        refreshToken: 'refresh-token', scope: 'https://outlook.office.com/SMTP.Send offline_access',
      },
    });
    const raw = await readFile(filePath, 'utf8');
    assert.doesNotMatch(raw, /different-password|client-secret|refresh-token|"pass"|"clientSecret"|"refreshToken"/);
    const persisted = JSON.parse(raw);
    assert.equal(persisted.schemaVersion, 2);
    assert.match(persisted.configHash, /^[a-f0-9]{64}$/);
    assert.equal(persisted.oauth.clientId, 'client-id');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('blank credential fields preserve the existing in-memory credentials', async () => {
  const { fixture, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    await store.update({ user: 'second@example.com', from: 'second@example.com', password: '' });
    assert.equal(store.getForMailer().pass, 'client-authorization-code');

    await store.update({
      auth: 'oauth2', user: 'candidate@outlook.com', from: 'candidate@outlook.com', clearPassword: true,
      oauth: { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' },
    });
    await store.update({ oauth: { tenant: 'consumers', clientSecret: '', refreshToken: '' } });
    assert.equal(store.getForMailer().oauth.clientSecret, 'client-secret');
    assert.equal(store.getForMailer().oauth.refreshToken, 'refresh-token');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('every key non-secret SMTP field change invalidates verification immediately', async () => {
  const cases = [
    ['host', { host: 'smtp2.example.com' }],
    ['port', { port: 2525 }],
    ['secure', { secure: true }],
    ['sender', { from: 'sender2@example.com' }],
    ['user', { user: 'candidate2@example.com' }],
  ];
  for (const [field, change] of cases) {
    const { fixture, store } = await fixtureStore();
    try {
      await store.update(LOGIN_CONFIG);
      await store.markVerified(store.getVerificationSnapshot());
      const before = store.getPublic();
      assert.equal(before.verified, true, `${field} precondition`);
      const after = await store.update(change);
      assert.equal(after.verified, false, `${field} must invalidate`);
      assert.equal(after.verificationStatus, 'unverified');
      assert.notEqual(after.configHash, before.configHash, `${field} must alter configHash`);
      assert.throws(() => store.assertReadyForSend(), { code: 'SMTP_NOT_VERIFIED' });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});

test('credential changes invalidate verification through credentialRevision without changing configHash', async () => {
  const { fixture, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    await store.markVerified(store.getVerificationSnapshot());
    const before = store.getPublic();
    const after = await store.update({ password: 'replacement-secret' });
    assert.equal(after.configHash, before.configHash);
    assert.equal(after.credentialRevision, before.credentialRevision + 1);
    assert.equal(after.verified, false);
    assert.throws(() => store.assertReadyForSend(), { code: 'SMTP_NOT_VERIFIED' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('verification snapshots reject stale config and credential revisions', async () => {
  const { fixture, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    const staleConfig = store.getVerificationSnapshot();
    await store.update({ port: 2525 });
    await assert.rejects(() => store.markVerified(staleConfig), { code: 'SMTP_CONFIG_CONFLICT' });

    const staleCredential = store.getVerificationSnapshot();
    await store.update({ password: 'replacement-secret' });
    await assert.rejects(() => store.markVerified(staleCredential), { code: 'SMTP_CONFIG_CONFLICT' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('verification expires at the configured TTL', async () => {
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const { fixture, store } = await fixtureStore({ verificationTtlMs: 1_000, clock: () => now });
  try {
    await store.update(LOGIN_CONFIG);
    await store.markVerified(store.getVerificationSnapshot());
    assert.doesNotThrow(() => store.assertReadyForSend());
    now += 1_001;
    assert.equal(store.getPublic().verificationStatus, 'expired');
    assert.throws(() => store.assertReadyForSend(), { code: 'SMTP_VERIFICATION_EXPIRED' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('transport verification failures are bound to the active snapshot', async () => {
  const { fixture, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    const snapshot = store.getVerificationSnapshot();
    const failed = await store.markVerificationFailed(snapshot, 'SMTP_AUTH_FAILED');
    assert.equal(failed.verificationStatus, 'failed');
    assert.equal(failed.verificationFailureCode, 'SMTP_AUTH_FAILED');
    assert.equal(failed.verified, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('a restart retains non-secret settings but requires credentials and verification again', async () => {
  const { fixture, filePath, store } = await fixtureStore();
  try {
    await store.update(LOGIN_CONFIG);
    await store.markVerified(store.getVerificationSnapshot());
    const restarted = new SmtpConfigStore({ filePath });
    const loaded = await restarted.initialize();
    assert.equal(loaded.host, LOGIN_CONFIG.host);
    assert.equal(loaded.hasPassword, false);
    assert.equal(loaded.verified, false);
    assert.equal(restarted.getForMailer().pass, '');
    assert.throws(() => restarted.assertReadyForSend(), { code: 'SMTP_NOT_CONFIGURED' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('legacy plaintext files are migrated to v2 and their verification is invalidated', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-smtp-legacy-'));
  const filePath = path.join(fixture, 'smtp-config.json');
  try {
    await writeFile(filePath, JSON.stringify({
      ...LOGIN_CONFIG,
      pass: 'legacy-secret',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
    }));
    const store = new SmtpConfigStore({ filePath });
    const loaded = await store.initialize();
    assert.equal(store.getForMailer().pass, 'legacy-secret');
    assert.equal(loaded.verified, false);
    const raw = await readFile(filePath, 'utf8');
    assert.doesNotMatch(raw, /legacy-secret|"pass"|"password"/);
    assert.equal(JSON.parse(raw).schemaVersion, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('SMTP configuration can be cleared and custom localhost targets remain valid', async () => {
  const { fixture, filePath, store } = await fixtureStore();
  try {
    await store.update({
      provider: 'custom', host: '127.0.0.1', port: 1025, secure: false, requireTls: false,
      auth: 'none', user: '', from: 'candidate@example.com',
    });
    assert.equal(store.getPublic().host, '127.0.0.1');
    const cleared = await store.clear();
    assert.equal(cleared.from, '');
    assert.equal(cleared.hasPassword, false);
    assert.doesNotMatch(await readFile(filePath, 'utf8'), /candidate@example\.com/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('config hashes are stable, strong, and exclude all secret material', () => {
  const first = { ...LOGIN_CONFIG, pass: 'first-secret' };
  const reordered = {
    from: first.from, user: first.user, auth: first.auth, requireTls: first.requireTls,
    secure: first.secure, port: first.port, host: first.host, provider: first.provider, pass: 'second-secret',
  };
  const hash = smtpConfigHash(first);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(smtpConfigHash(reordered), hash);
  assert.notEqual(smtpConfigHash({ ...first, host: 'smtp2.example.com' }), hash);
});

test('incomplete legacy environment defaults do not block server startup', async () => {
  const { fixture, store } = await fixtureStore({
    defaults: { host: 'smtp.example.com', port: 587, from: 'incomplete-placeholder', auth: 'login' },
  });
  try {
    assert.equal(store.getPublic().from, 'incomplete-placeholder');
    assert.equal(store.getPublic().hasPassword, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
