import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from './app.mjs';
import { normalizeAuthOrigin } from './config.mjs';

function createSecurityFixture() {
  const loginCalls = [];
  const sessionUser = { email: 'owner@example.com', roles: ['owner'] };
  const authStore = {
    required: true,
    authenticate: (req) => (req.headers.cookie ? sessionUser : null),
    login: async (...args) => {
      loginCalls.push(args);
      return sessionUser;
    },
    setSession: (res) => res.setHeader('Set-Cookie', 'xhs_session=test; Path=/; HttpOnly; Secure; SameSite=Lax'),
    clearSession: (res) => res.setHeader('Set-Cookie', 'xhs_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'),
  };
  const config = {
    host: '127.0.0.1',
    port: 4317,
    authRequired: true,
    authOrigin: 'https://hegelsalon.example.com',
    maxBodyBytes: 1024 * 1024,
    attachmentMaxFiles: 5,
    attachmentMaxFileBytes: 1024 * 1024,
    attachmentMaxTotalBytes: 2 * 1024 * 1024,
    projectRoot: process.cwd(),
    runnerAvailable: false,
    audienceAiEnabled: false,
    audienceAiRunnerAvailable: false,
    applicationContactOcrEnabled: false,
    managedBrowserDataDir: process.cwd(),
    openClawConfigPath: process.cwd(),
  };
  const manager = {
    active: null,
    list: () => [],
    get: () => null,
    getInternal: () => null,
  };
  const app = createApp({
    manager,
    config,
    authStore,
    aiSessions: {},
    relayConfig: { get: () => ({}) },
    smtpConfig: { getPublic: () => ({ configured: false }), getForMailer: () => ({}) },
    mailSender: { status: () => ({ configured: false, from: '' }), configure: () => {}, verify: async () => ({}), send: async () => ({}) },
    localModels: {},
    relaySupervisor: { snapshot: () => ({ ready: false }), start: () => {}, stop: () => {} },
    preflightService: { run: async () => ({ ready: true }) },
    audienceAiService: {},
    applicationContactOcrService: { getState: async () => null, ensureStarted: async () => {}, stop: () => {} },
    applicationContactResolutionService: { refresh: async () => ({ report: { items: [] } }) },
  });
  return { app, loginCalls };
}

async function startFixture() {
  const fixture = createSecurityFixture();
  const server = http.createServer(fixture.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ...fixture, server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('production auth origin is required and normalized to an origin', () => {
  assert.equal(normalizeAuthOrigin('https://hegelsalon.example.com/', true), 'https://hegelsalon.example.com');
  assert.throws(() => normalizeAuthOrigin('', true), /XHS_AUTH_ORIGIN is required/);
  assert.throws(() => normalizeAuthOrigin('https://hegelsalon.example.com/app', true), /only an HTTP\(S\) origin/);
  assert.throws(() => normalizeAuthOrigin('http://public.example.com', true), /must use HTTPS/);
  assert.equal(normalizeAuthOrigin('http://127.0.0.1:4317', true), 'http://127.0.0.1:4317');
});

test('CORS preflight is restricted to the configured origin and headers', async () => {
  const { server, origin } = await startFixture();
  try {
    const allowed = await fetch(`${origin}/api/jobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://hegelsalon.example.com',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type, x-request-id',
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://hegelsalon.example.com');
    assert.match(allowed.headers.get('access-control-allow-methods'), /PATCH/);
    assert.match(allowed.headers.get('access-control-allow-headers'), /X-Request-Id/);

    const foreign = await fetch(`${origin}/api/jobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);

    const unknownHeader = await fetch(`${origin}/api/jobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://hegelsalon.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(unknownHeader.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('state-changing auth routes reject a foreign Origin, including login and logout', async () => {
  const { server, origin, loginCalls } = await startFixture();
  try {
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'test-password' }),
    });
    assert.equal(login.status, 403);
    assert.equal((await login.json()).error.code, 'CSRF_ORIGIN_REJECTED');
    assert.equal(loginCalls.length, 0);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    assert.equal(logout.status, 403);

    const protectedWrite = await fetch(`${origin}/api/jobs`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(protectedWrite.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unauthenticated production health stays minimal and does not expose runtime details', async () => {
  const { server, origin } = await startFixture();
  try {
    const response = await fetch(`${origin}/api/health`, { headers: { Origin: 'https://hegelsalon.example.com' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['authRequired', 'ok', 'service', 'timestamp'].sort());
    assert.equal(body.authRequired, true);
    assert.equal('pid' in body, false);
    assert.equal('host' in body, false);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://hegelsalon.example.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
