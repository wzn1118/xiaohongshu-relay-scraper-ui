import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexNativeMirrorServiceError,
  createCodexNativeMirrorService,
} from './codex-native-mirror-service.mjs';

function fixture() {
  let nowMs = Date.parse('2026-08-18T08:00:00.000Z');
  let id = 0;
  let secret = 0;
  const service = createCodexNativeMirrorService({
    now: () => new Date(nowMs),
    newId: () => `id-${++id}`,
    newSecret: () => `mirror-secret-${++secret}-0123456789`,
    iceServers: [{ urls: ['stun:relay.example.test:3478'] }],
  });
  return { service, advance: (milliseconds) => { nowMs += milliseconds; } };
}

test('creates a view-only selected-window mirror session and relays directed WebRTC signals', () => {
  const { service } = fixture();
  const status = service.status();
  assert.equal(status.available, true);
  assert.equal(status.viewOnly, true);
  assert.equal(status.inputEnabled, false);
  assert.equal(status.clipboardEnabled, false);

  const created = service.createSession({ deviceId: 'device-local' });
  assert.equal(created.session.mode, 'nativeMirror');
  assert.equal(created.rtcConfiguration.iceServers.length, 1);
  assert.equal(JSON.stringify(created.session).includes(created.source.token), false);

  const offer = service.postSignal(created.session.id, {
    role: 'source',
    token: created.source.token,
    kind: 'offer',
    payload: { type: 'offer', sdp: 'v=0\r\nsource-offer' },
  });
  assert.equal(offer.target, 'viewer');
  const viewerSignals = service.listSignals(created.session.id, {
    role: 'viewer',
    token: created.viewer.token,
  });
  assert.equal(viewerSignals.signals[0].kind, 'offer');

  service.postSignal(created.session.id, {
    role: 'viewer',
    token: created.viewer.token,
    kind: 'answer',
    payload: { type: 'answer', sdp: 'v=0\r\nviewer-answer' },
  });
  const sourceSignals = service.listSignals(created.session.id, {
    role: 'source',
    token: created.source.token,
  });
  assert.equal(sourceSignals.signals[0].kind, 'answer');

  assert.throws(() => service.postSignal(created.session.id, {
    role: 'viewer',
    token: created.viewer.token,
    kind: 'offer',
    payload: { type: 'offer', sdp: 'v=0' },
  }), (error) => error instanceof CodexNativeMirrorServiceError
    && error.code === 'CODEX_MIRROR_SIGNAL_DIRECTION_INVALID');
});

test('rejects invalid role tokens and expires inactive mirror sessions', () => {
  const { service, advance } = fixture();
  const created = service.createSession();
  assert.throws(() => service.listSignals(created.session.id, {
    role: 'source',
    token: 'wrong-token',
  }), { code: 'CODEX_MIRROR_TOKEN_INVALID' });

  advance(15 * 60_000 + 1);
  assert.equal(service.status().activeSessions, 0);
  assert.throws(() => service.getSession(created.session.id, {
    role: 'viewer',
    token: created.viewer.token,
  }), { code: 'CODEX_MIRROR_SESSION_NOT_FOUND' });
});

test('reports interactive readiness only after both peers open the control channel', () => {
  const { service } = fixture();
  const created = service.createSession();
  for (const credentials of [created.source, created.viewer]) {
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'page' } });
  }
  let session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.sourceConnected, true);
  assert.equal(session.viewerConnected, true);
  assert.equal(session.peerConnected, false);
  assert.equal(session.controlConnected, false);
  assert.equal(session.state, 'waiting');

  for (const credentials of [created.source, created.viewer]) {
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'peer' } });
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'control' } });
  }
  session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.peerConnected, true);
  assert.equal(session.controlConnected, true);
  assert.equal(session.state, 'connected');
});

test('reports the selected direct or TURN relay path without exposing candidate addresses', () => {
  const { service } = fixture();
  const created = service.createSession();
  for (const credentials of [created.source, created.viewer]) {
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'control' } });
    service.postSignal(created.session.id, {
      ...credentials,
      kind: 'ready',
      payload: {
        phase: 'transport',
        localCandidateType: credentials.role === 'source' ? 'relay' : 'srflx',
        remoteCandidateType: 'host',
        protocol: 'udp',
        relayUsed: credentials.role === 'source',
        rttMs: 37.6,
        address: '192.0.2.10',
      },
    });
  }
  const session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.connectionPath, 'relay');
  assert.equal(session.transportDetails.source.localCandidateType, 'relay');
  assert.equal(session.transportDetails.viewer.protocol, 'udp');
  assert.equal(session.transportDetails.source.rttMs, 38);
  assert.equal(JSON.stringify(session.transportDetails).includes('192.0.2.10'), false);
  const queuedSignals = service.listSignals(created.session.id, created.viewer);
  assert.equal(JSON.stringify(queuedSignals.signals).includes('192.0.2.10'), false);
});

test('surfaces WebRTC failures and clears them after peer and control recovery', () => {
  const { service } = fixture();
  const created = service.createSession();
  service.postSignal(created.session.id, {
    ...created.viewer,
    kind: 'ready',
    payload: { phase: 'connection-error', state: 'disconnected', detail: 'private detail' },
  });
  let session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.state, 'error');
  assert.equal(session.connectionError, 'viewer: disconnected');
  assert.equal(JSON.stringify(session).includes('private detail'), false);

  for (const credentials of [created.source, created.viewer]) {
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'peer' } });
    service.postSignal(created.session.id, { ...credentials, kind: 'ready', payload: { phase: 'control' } });
    service.postSignal(created.session.id, {
      ...credentials,
      kind: 'ready',
      payload: { phase: 'transport', localCandidateType: 'srflx', remoteCandidateType: 'host', protocol: 'udp' },
    });
  }
  session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.state, 'connected');
  assert.equal(session.connectionError, null);
  assert.equal(session.connectionPath, 'direct');
});

test('issues and retains session-scoped ICE credentials for both mirror roles', () => {
  const base = fixture();
  const service = createCodexNativeMirrorService({
    now: () => new Date('2026-08-18T08:00:00.000Z'),
    newId: () => 'ice-session',
    newSecret: () => 'mirror-secret-0123456789abcdef',
    iceService: {
      status: () => ({ configuredServers: 1, turnConfigured: true, turnCredentialMode: 'time-limited-hmac' }),
      issue: ({ subject }) => ({
        iceServers: [{ urls: ['turn:relay.example.test:3478'], username: subject, credential: 'temporary' }],
        expiresAt: '2026-08-18T08:10:00.000Z',
        turnConfigured: true,
      }),
    },
  });
  const created = service.createSession({ deviceId: 'device-local' });
  assert.equal(created.rtcConfiguration.iceServers[0].username, created.session.id);
  assert.equal(created.rtcConfiguration.expiresAt, '2026-08-18T08:10:00.000Z');
  const viewer = service.getSession(created.session.id, created.viewer);
  assert.deepEqual(viewer.rtcConfiguration, created.rtcConfiguration);
  assert.equal(service.status().turnCredentialMode, 'time-limited-hmac');
  assert.equal(base.service.status().turnConfigured, false);
});

test('enables interactive control only through the authenticated source role', async () => {
  const inputEvents = [];
  let inputWarmed = false;
  const service = createCodexNativeMirrorService({
    inputService: {
      status: () => ({ available: true, inputEnabled: true, state: 'interactive' }),
      setTarget: (sessionId, target) => ({ accepted: true, sessionId, target }),
      warm: async (sessionId) => { inputWarmed = sessionId; },
      send: async (sessionId, event) => { inputEvents.push({ sessionId, event }); return { accepted: true, sessionId, type: event.type }; },
      clearTarget: () => {},
    },
  });
  assert.equal(service.status().inputEnabled, true);
  assert.equal(service.status().viewOnly, false);
  const created = service.createSession();
  await service.setInputTarget(created.session.id, created.source, { label: 'Codex', width: 100, height: 100 });
  const inputOnlySession = service.getSession(created.session.id, created.viewer).session;
  assert.equal(inputOnlySession.inputMode, 'capture');
  assert.equal(inputWarmed, created.session.id);
  await service.sendInput(created.session.id, created.source, { type: 'mouse', action: 'click', x: 0.4, y: 0.6 });
  assert.equal(inputEvents.length, 1);
  await assert.rejects(() => service.sendInput(created.session.id, created.viewer, { type: 'mouse', action: 'click', x: 0, y: 0 }), { code: 'CODEX_MIRROR_INPUT_ROLE_INVALID' });
});

test('allows the authenticated viewer to bypass the source only for a same-host window-message target', async () => {
  const inputEvents = [];
  const service = createCodexNativeMirrorService({
    inputService: {
      status: () => ({ available: true, inputEnabled: true, state: 'interactive' }),
      setTarget: (sessionId, target) => ({ accepted: true, sessionId, target }),
      warm: async () => {},
      send: async (sessionId, event) => {
        inputEvents.push({ sessionId, event });
        return { accepted: true, delivered: true, targetFound: true };
      },
      clearTarget: () => {},
    },
  });
  const created = service.createSession();
  await assert.rejects(
    () => service.sendViewerInput(created.session.id, created.viewer, { type: 'key', phase: 'down', code: 'Enter' }),
    { code: 'CODEX_MIRROR_VIEWER_INPUT_TARGET_INVALID' },
  );
  await service.setInputTarget(created.session.id, created.source, {
    label: 'ChatGPT',
    width: 1920,
    height: 1080,
    delivery: 'window-message',
  });
  const delivered = await service.sendViewerInput(
    created.session.id,
    created.viewer,
    { type: 'key', phase: 'down', code: 'Enter' },
  );
  assert.equal(delivered.delivered, true);
  assert.equal(inputEvents.length, 1);
  await assert.rejects(
    () => service.sendViewerInput(created.session.id, created.source, { type: 'key', phase: 'down', code: 'Enter' }),
    { code: 'CODEX_MIRROR_VIEWER_INPUT_ROLE_INVALID' },
  );
});

test('retains an input-only target when browser window capture is unavailable', async () => {
  const service = createCodexNativeMirrorService({
    inputService: {
      status: () => ({ available: true, inputEnabled: true, state: 'interactive' }),
      setTarget: (sessionId, target) => ({ accepted: true, sessionId, target }),
      warm: async () => {},
      clearTarget: () => {},
    },
  });
  const created = service.createSession();
  await service.setInputTarget(created.session.id, created.source, { label: 'ChatGPT', width: 1920, height: 1080, mode: 'input-only' });
  const session = service.getSession(created.session.id, created.viewer).session;
  assert.equal(session.inputMode, 'input-only');
  assert.equal(session.inputTarget.label, 'ChatGPT');
  assert.equal(session.inputEnabled, true);
});

test('clears the selected input target when the source leaves or the session expires', async () => {
  let nowMs = Date.parse('2026-08-18T08:00:00.000Z');
  const cleared = [];
  const service = createCodexNativeMirrorService({
    now: () => new Date(nowMs),
    inputService: {
      status: () => ({ available: true, inputEnabled: true, state: 'interactive' }),
      setTarget: (sessionId, target) => ({ accepted: true, sessionId, target }),
      clearTarget: (sessionId) => { cleared.push(sessionId); },
    },
  });

  const disconnected = service.createSession();
  await service.setInputTarget(disconnected.session.id, disconnected.source, { label: 'Codex', width: 1280, height: 720 });
  service.postSignal(disconnected.session.id, { ...disconnected.source, kind: 'ready', payload: {} });
  service.postSignal(disconnected.session.id, { ...disconnected.source, kind: 'bye', payload: {} });
  assert.equal(service.getSession(disconnected.session.id, disconnected.viewer).session.inputTarget, null);
  assert.deepEqual(cleared, [disconnected.session.id]);

  const expired = service.createSession();
  await service.setInputTarget(expired.session.id, expired.source, { label: 'Codex', width: 1280, height: 720 });
  nowMs += 15 * 60_000 + 1;
  assert.equal(service.status().activeSessions, 0);
  assert.deepEqual(cleared, [disconnected.session.id, expired.session.id]);
});

test('launches and closes a dedicated local capture source', async () => {
  const calls = [];
  const launches = new Map();
  const service = createCodexNativeMirrorService({
    localSourceService: {
      status: () => ({ available: true, activeSources: launches.size }),
      launch: async (sessionId, sourceUrl, options) => {
        calls.push(['launch', sessionId, sourceUrl, options]);
        const result = { sessionId, state: 'ready', pid: 4321, launchedAt: '2026-08-19T09:00:00.000Z' };
        launches.set(sessionId, result);
        return result;
      },
      get: (sessionId) => launches.get(sessionId) || null,
      close: async (sessionId) => { calls.push(['close', sessionId]); launches.delete(sessionId); },
      closeAll: async () => { launches.clear(); },
    },
  });
  const created = service.createSession();
  const launched = await service.launchLocalSource(created.session.id, created.source, {
    sourceUrl: 'http://127.0.0.1:4337/codex-native-mirror.html#source',
    captureTitle: 'ChatGPT',
  });
  assert.equal(launched.session.sourceLaunch.state, 'ready');
  assert.equal(launched.session.sourceLaunch.pid, 4321);
  assert.equal(service.status().localCapture.activeSources, 1);
  service.closeSession(created.session.id, created.viewer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(([kind]) => kind), ['launch', 'close']);
});

test('routes a remote Mirror source and input through its paired device without using local input', async () => {
  const calls = [];
  const service = createCodexNativeMirrorService({
    newId: () => 'remote-0001',
    newSecret: () => `remote-secret-${calls.length}-0123456789`,
    inputService: { status: () => ({ inputEnabled: false }) },
    remoteInputService: {
      openMirrorSource: (...args) => { calls.push(['open', ...args]); return { delivered: true }; },
      setMirrorInputTarget: (...args) => { calls.push(['target', ...args]); return { delivered: true }; },
      sendMirrorInput: (...args) => { calls.push(['input', ...args]); return { delivered: true }; },
      closeRemoteMirror: (...args) => { calls.push(['close', ...args]); return { delivered: true }; },
    },
  });
  const created = service.createSession({ deviceId: 'dev-remote-1', remote: true, ownerId: 'owner-1' });
  const launched = await service.launchRemoteSource(created.session.id, created.source, {
    sourceUrl: 'https://relay.example.test/codex-native-mirror.html#source',
  });
  assert.equal(launched.session.remote, true);
  assert.equal(launched.session.inputEnabled, true);
  await service.setInputTarget(created.session.id, created.source, { label: 'Codex', width: 1280, height: 720 });
  await service.sendInput(created.session.id, created.source, { type: 'key', phase: 'down', code: 'Enter' });
  service.closeSession(created.session.id, created.viewer);
  assert.deepEqual(calls.map(([kind]) => kind), ['open', 'target', 'input', 'close']);
  assert.equal(calls[0][1], 'dev-remote-1');
  assert.equal(calls[0][4].ownerId, 'owner-1');
});
