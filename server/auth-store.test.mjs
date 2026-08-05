import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthStore } from './auth-store.mjs';

test('auth store bootstraps a hashed account and round-trips a signed cookie', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-auth-'));
  try {
    const store = createAuthStore({
      usersPath: path.join(root, 'users.json'),
      sessionSecretPath: path.join(root, 'session-secret'),
      required: true,
      secureCookie: false,
      now: () => 1_700_000_000_000,
    });
    await store.initialize({ bootstrapEmail: 'demo@example.com', bootstrapPassword: 'demo-password-123' });
    const user = await store.login('DEMO@example.com', 'demo-password-123');
    const response = { headers: new Map(), setHeader(name, value) { this.headers.set(name, value); } };
    store.setSession(response, user);
    const request = { headers: { cookie: response.headers.get('Set-Cookie') } };
    assert.deepEqual(store.authenticate(request), { email: 'demo@example.com', roles: ['owner'] });
    const persisted = await readFile(path.join(root, 'users.json'), 'utf8');
    assert.match(persisted, /"hash"/);
    assert.doesNotMatch(persisted, /demo-password-123/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required auth fails startup when no bootstrap account is supplied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-auth-'));
  try {
    const store = createAuthStore({ usersPath: path.join(root, 'users.json'), sessionSecretPath: path.join(root, 'secret'), required: true });
    await assert.rejects(() => store.initialize(), { code: 'AUTH_BOOTSTRAP_REQUIRED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auth store provisions and replaces an account without persisting the password', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-auth-'));
  try {
    const store = createAuthStore({ usersPath: path.join(root, 'users.json'), sessionSecretPath: path.join(root, 'secret') });
    await store.initialize();
    await store.provision('demo@example.com', 'first-password-123');
    await assert.rejects(() => store.provision('demo@example.com', 'second-password-123'), { code: 'AUTH_ALREADY_PROVISIONED' });
    await store.provision('demo@example.com', 'second-password-123', { replace: true });
    await assert.rejects(() => store.login('demo@example.com', 'first-password-123'), { code: 'AUTH_INVALID_CREDENTIALS' });
    assert.deepEqual(await store.login('demo@example.com', 'second-password-123'), { email: 'demo@example.com', roles: ['owner'] });
    const persisted = await readFile(path.join(root, 'users.json'), 'utf8');
    assert.doesNotMatch(persisted, /second-password-123/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
