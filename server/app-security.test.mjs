import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from './app.mjs';
import { normalizeAuthOrigin } from './config.mjs';

function createSecurityFixture({
  authRequired = true,
  sessionUser: sessionOverride,
  codexRelayService,
  codexDeviceGatewayService,
  codexNativeMirrorService,
} = {}) {
  const loginCalls = [];
  const mcpCalls = [];
  const copilotMcpCalls = [];
  const copilotSecurityContexts = [];
  const sessionUser = sessionOverride || { email: 'owner@example.com', roles: ['owner'] };
  const authStore = {
    required: authRequired,
    authenticate: (req) => (authRequired ? (req.headers.cookie ? sessionUser : null) : sessionUser),
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
    authRequired,
    authOrigin: authRequired ? 'https://hegelsalon.example.com' : '',
    maxBodyBytes: 1024 * 1024,
    mcpMaxBodyBytes: 64 * 1024,
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
    dataCopilotService: {
      listProjects: (_value, securityContext) => {
        copilotSecurityContexts.push(securityContext);
        return { projects: [] };
      },
      listMcpServers: () => ({ servers: [], tools: [] }),
      upsertMcpServer: async (value) => {
        copilotMcpCalls.push(['upsert', value]);
        return { server: { id: String(value?.id || value?.name || 'server') }, tools: [] };
      },
      refreshMcpServers: async () => ({ servers: [], tools: [] }),
      removeMcpServer: async () => ({ removed: true, servers: [], tools: [] }),
    },
    mcpAccessService: {
      status: () => { mcpCalls.push(['status']); return { ok: true, service: 'test-mcp' }; },
      createGrant: async (value, actor) => {
        mcpCalls.push(['create', value, actor]);
        return { grant: { grantId: 'grant-1' }, token: 'one-time-token' };
      },
    },
    codexRelayService,
    codexDeviceGatewayService,
    codexNativeMirrorService,
  });
  return { app, loginCalls, mcpCalls, copilotMcpCalls, copilotSecurityContexts };
}

test('remote Native Mirror launches on the owned device and its role token works without a browser login', async () => {
  const calls = [];
  const mirror = {
    createSession: (value) => {
      calls.push(['create', value]);
      return {
        session: { id: 'mirror-12345678', deviceId: value.deviceId, mode: 'nativeMirror', state: 'waiting' },
        source: { role: 'source', token: 'source-token-0123456789' },
        viewer: { role: 'viewer', token: 'viewer-token-0123456789' },
        rtcConfiguration: { iceServers: [] },
      };
    },
    launchRemoteSource: (sessionId, credentials, value) => {
      calls.push(['launch', sessionId, credentials, value]);
      return { delivered: true, session: { id: sessionId, deviceId: 'dev-remote', mode: 'nativeMirror', state: 'waiting', remote: true } };
    },
    getSession: (sessionId, credentials) => {
      calls.push(['get', sessionId, credentials]);
      return { session: { id: sessionId }, rtcConfiguration: { iceServers: [] } };
    },
    closeSession: () => ({ closed: true }),
    status: () => ({ available: true }),
  };
  const { server, origin } = await startFixture({ codexNativeMirrorService: mirror });
  try {
    const createdResponse = await fetch(`${origin}/api/codex-native-mirror/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
      body: JSON.stringify({ deviceId: 'dev-remote', remote: true }),
    });
    assert.equal(createdResponse.status, 201);
    assert.equal(calls[0][1].ownerId, 'owner@example.com');
    const sourceUrl = new URL(calls[1][3].sourceUrl);
    assert.equal(sourceUrl.origin, 'https://hegelsalon.example.com');
    assert.equal(new URLSearchParams(sourceUrl.hash.slice(1)).get('remote'), '1');

    const roleRequest = await fetch(`${origin}/api/codex-native-mirror/sessions/mirror-12345678`, {
      headers: {
        'X-Codex-Mirror-Role': 'source',
        'X-Codex-Mirror-Token': 'source-token-0123456789',
      },
    });
    assert.equal(roleRequest.status, 200);
    assert.equal(calls.at(-1)[0], 'get');

    const noToken = await fetch(`${origin}/api/codex-native-mirror/sessions/mirror-12345678`);
    assert.equal(noToken.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Codex device pairing uses browser ownership while claims and heartbeats use device credentials', async () => {
  const calls = [];
  const gateway = {
    status: () => ({ transport: 'outbound-websocket', pairedDevices: 1, onlineDevices: 1 }),
    createPairingIntent: (value) => {
      calls.push(['intent', value]);
      return { pairingIntent: { id: 'pair-00000001', code: 'ABCDEFGH', expiresAt: '2026-08-18T08:05:00.000Z' } };
    },
    claimPairing: async (value) => {
      calls.push(['claim', value]);
      return { device: { id: 'dev-00000001' }, credentials: { deviceToken: 'returned-once' } };
    },
    heartbeat: async (deviceId, token, value) => {
      calls.push(['heartbeat', deviceId, token, value]);
      return { id: deviceId, online: true };
    },
    revokeDevice: async (deviceId, value) => {
      calls.push(['revoke', deviceId, value]);
      return { revoked: true, deviceId };
    },
  };
  const relay = {
    status: async () => ({}),
    listDevices: ({ ownerId }) => [{ id: 'local-device', ownerId }],
  };
  const { server, origin } = await startFixture({ codexRelayService: relay, codexDeviceGatewayService: gateway });
  try {
    const unauthenticated = await fetch(`${origin}/api/codex-relay/pairing-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://hegelsalon.example.com' },
      body: '{}',
    });
    assert.equal(unauthenticated.status, 401);

    const intent = await fetch(`${origin}/api/codex-relay/pairing-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
      body: JSON.stringify({ requestedRole: 'controller' }),
    });
    assert.equal(intent.status, 201);
    assert.equal(calls[0][1].ownerId, 'owner@example.com');
    const intentBody = await intent.json();
    assert.equal(intentBody.gateway.websocketUrl, 'wss://hegelsalon.example.com/v1/device-tunnel');

    const claim = await fetch(`${origin}/api/codex-relay/device-claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingIntentId: 'pair-00000001', code: 'ABCDEFGH' }),
    });
    assert.equal(claim.status, 201);
    assert.equal(calls[1][0], 'claim');

    const heartbeat = await fetch(`${origin}/api/codex-relay/devices/dev-00000001/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-token' },
      body: JSON.stringify({ codex: { running: true } }),
    });
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(calls[2].slice(0, 3), ['heartbeat', 'dev-00000001', 'device-token']);

    const revoke = await fetch(`${origin}/api/codex-relay/devices/dev-00000001`, {
      method: 'DELETE',
      headers: { Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
    });
    assert.equal(revoke.status, 200);
    assert.equal(calls[3][2].ownerId, 'owner@example.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('local connector control-plane routes create a signed launch and permit only the matching one-time claim', async () => {
  const calls = [];
  const gateway = {
    createPairingIntent: (value) => {
      calls.push(['intent', value]);
      return { pairingIntent: { id: 'pair-00000001', code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } };
    },
    claimPairing: async (value) => {
      calls.push(['claim', value]);
      return { device: { id: 'dev-00000001', name: 'This Windows device', online: false }, credentials: { deviceToken: 'returned-once' } };
    },
    getDevice: () => ({ id: 'dev-00000001', name: 'This Windows device', online: false, codex: { running: false } }),
    listDevices: () => [],
    sendConnectorCommand: (_deviceId, value) => {
      calls.push(['connector-command', value]);
      return { delivered: true, sentAt: new Date().toISOString() };
    },
    revokeDevice: async () => ({ revoked: true }),
  };
  const relay = { status: async () => ({}), listDevices: () => [] };
  const { server, origin } = await startFixture({ codexRelayService: relay, codexDeviceGatewayService: gateway });
  try {
    const createdResponse = await fetch(`${origin}/api/codex-connect/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
      body: JSON.stringify({ deviceName: 'This Windows device' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const launch = new URL(created.launchUrl);
    assert.equal(launch.protocol, 'codex-local:');
    assert.equal(launch.searchParams.get('origin'), 'https://hegelsalon.example.com');
    assert.equal(calls[0][1].ownerId, 'owner@example.com');

    const claimResponse = await fetch(`${origin}/api/codex-connect/intents/${created.intent.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: launch.searchParams.get('origin'),
        code: launch.searchParams.get('code'),
        nonce: launch.searchParams.get('nonce'),
        signature: launch.searchParams.get('sig'),
        deviceName: 'This Windows device',
      }),
    });
    assert.equal(claimResponse.status, 201);
    assert.equal(calls[1][0], 'claim');

    const statusResponse = await fetch(`${origin}/api/codex-connect/intents/${created.intent.id}`, {
      headers: { Cookie: 'xhs_session=test' },
    });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).intent.state, 'paired');

    const secondClaim = await fetch(`${origin}/api/codex-connect/intents/${created.intent.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: launch.searchParams.get('origin'),
        code: launch.searchParams.get('code'),
        nonce: launch.searchParams.get('nonce'),
        signature: launch.searchParams.get('sig'),
      }),
    });
    assert.equal(secondClaim.status, 410);
    assert.equal((await secondClaim.json()).error.code, 'CODEX_CONNECT_INTENT_CONSUMED');

    const rollbackResponse = await fetch(`${origin}/api/codex-connect/devices/dev-00000001/rollback`, {
      method: 'POST',
      headers: { Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
    });
    assert.equal(rollbackResponse.status, 202);
    assert.equal((await rollbackResponse.json()).operation, 'rollback');
    assert.equal(calls.at(-1)[1].operation, 'rollback');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function startFixture(options = {}) {
  const fixture = createSecurityFixture(options);
  const server = http.createServer(fixture.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ...fixture, server, origin: `http://127.0.0.1:${server.address().port}` };
}

function requestFixture(server, { path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path,
      headers,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
    });
    request.once('error', reject);
    request.end();
  });
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

test('trusted loopback Origin can use local browser control routes', async () => {
  const { server, origin } = await startFixture();
  try {
    const response = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: 'xhs_session=test' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authenticated, false);
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

test('MCP management routes require browser authentication and trusted Origin', async () => {
  const { server, origin, mcpCalls } = await startFixture();
  try {
    const anonymous = await fetch(`${origin}/api/mcp/status`, {
      headers: { Origin: 'https://hegelsalon.example.com' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'AUTH_REQUIRED');
    assert.equal(mcpCalls.length, 0);

    const authenticated = await fetch(`${origin}/api/mcp/status`, {
      headers: { Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).service, 'test-mcp');
    assert.deepEqual(mcpCalls, [['status']]);

    const foreignWrite = await fetch(`${origin}/api/mcp/grants`, {
      method: 'POST',
      headers: { Cookie: 'xhs_session=test', Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conversation-1' }),
    });
    assert.equal(foreignWrite.status, 403);
    assert.equal((await foreignWrite.json()).error.code, 'CSRF_ORIGIN_REJECTED');
    assert.equal(mcpCalls.length, 1);

    const trustedWrite = await fetch(`${origin}/api/mcp/grants`, {
      method: 'POST',
      headers: { Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conversation-1' }),
    });
    assert.equal(trustedWrite.status, 201);
    assert.equal((await trustedWrite.json()).token, 'one-time-token');
    assert.equal(mcpCalls[1][0], 'create');
    assert.equal(mcpCalls[1][2].email, 'owner@example.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('outbound MCP control stays loopback-only and JSON-only when login is disabled', async () => {
  const { server, origin, copilotMcpCalls } = await startFixture({ authRequired: false });
  try {
    const crossSite = await fetch(`${origin}/api/copilot/mcp/servers`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'blocked-server', transport: 'stdio', command: 'node' }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error.code, 'CSRF_ORIGIN_REJECTED');

    const wrongContentType = await fetch(`${origin}/api/copilot/mcp/servers`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'plain-text-server' }),
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal((await wrongContentType.json()).error.code, 'COPILOT_CONTENT_TYPE_UNSUPPORTED');

    const localJson = await fetch(`${origin}/api/copilot/mcp/servers`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'local-server', transport: 'streamable_http', url: 'https://example.test/mcp' }),
    });
    assert.equal(localJson.status, 201);
    assert.equal((await localJson.json()).server.id, 'local-server');
    assert.deepEqual(copilotMcpCalls.map(([operation]) => operation), ['upsert']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('local no-auth project workspace requests receive the server-derived owner identity', async () => {
  const { server, origin, copilotSecurityContexts } = await startFixture({ authRequired: false });
  try {
    const response = await fetch(`${origin}/api/copilot/projects`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: [] });
    assert.deepEqual(copilotSecurityContexts, [{
      actorId: 'local-owner',
      trustedLocal: true,
      ownerLocal: false,
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('outbound MCP control requires an owner role in authenticated deployments', async () => {
  const { server, origin, copilotMcpCalls } = await startFixture({
    sessionUser: { email: 'viewer@example.com', roles: ['viewer'] },
  });
  try {
    const response = await fetch(`${origin}/api/copilot/mcp/servers`, {
      headers: { Cookie: 'xhs_session=test', Origin: 'https://hegelsalon.example.com' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'COPILOT_MCP_OWNER_REQUIRED');
    assert.equal(copilotMcpCalls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public HTTP requests from a trusted proxy redirect to the configured HTTPS origin', async () => {
  const { server } = await startFixture();
  try {
    const redirected = await requestFixture(server, {
      path: '/api/health?probe=1',
      headers: {
        Host: 'hegelsalon.example.com',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(redirected.statusCode, 301);
    assert.equal(redirected.headers.location, 'https://hegelsalon.example.com/api/health?probe=1');
    assert.equal(redirected.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.match(redirected.headers['content-security-policy'], /default-src 'self'/);
    assert.match(redirected.headers['content-security-policy'], /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
    assert.doesNotMatch(redirected.headers['content-security-policy'], /script-src[^;]*\*/);
    assert.match(redirected.headers['permissions-policy'], /camera=\(\)/);

    const cloudflareVisitor = await requestFixture(server, {
      path: '/api/health?probe=1',
      headers: {
        Host: 'hegelsalon.example.com',
        'CF-Visitor': '{"scheme":"http"}',
      },
    });
    assert.equal(cloudflareVisitor.statusCode, 301);
    assert.equal(cloudflareVisitor.headers.location, 'https://hegelsalon.example.com/api/health?probe=1');

    const alreadySecure = await requestFixture(server, {
      path: '/api/health',
      headers: {
        Host: 'hegelsalon.example.com',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(alreadySecure.statusCode, 200);
    assert.equal(alreadySecure.headers.location, undefined);

    const foreignHost = await requestFixture(server, {
      path: '/api/health',
      headers: {
        Host: 'attacker.example',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(foreignHost.statusCode, 200);
    assert.equal(foreignHost.headers.location, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Native Mirror alone may open the authenticated loopback input WebSocket', async () => {
  const { server } = await startFixture();
  try {
    const mirror = await requestFixture(server, {
      path: '/codex-native-mirror.html',
      headers: { Host: 'hegelsalon.example.com', 'X-Forwarded-Proto': 'https' },
    });
    assert.match(mirror.headers['content-security-policy'], /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);

    const codex = await requestFixture(server, {
      path: '/codex/',
      headers: { Host: 'hegelsalon.example.com', 'X-Forwarded-Proto': 'https' },
    });
    assert.doesNotMatch(codex.headers['content-security-policy'], /ws:\/\/127\.0\.0\.1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
