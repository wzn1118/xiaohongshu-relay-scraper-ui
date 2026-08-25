import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexRelayServiceError, createCodexRelayService } from './codex-relay-service.mjs';

function createFixture() {
  let nowMs = Date.parse('2026-08-18T08:00:00.000Z');
  let id = 0;
  let secret = 0;
  const forwarded = [];
  const browserEvents = [
    {
      sequence: 3,
      message: {
        type: 'mcp-notification',
        method: 'thread/started',
        params: { thread: { id: 'thread-1' } },
      },
    },
    {
      sequence: 4,
      message: {
        type: 'mcp-request',
        request: { id: 'approval-1', method: 'item/commandExecution/requestApproval' },
      },
    },
  ];
  const service = createCodexRelayService({
    workspaceRoot: 'C:\\workspace',
    codexDesktopService: {
      status: async () => ({ ready: true, version: '26.803.81509', buildNumber: '6415' }),
    },
    codexBrowserService: {
      status: () => ({ running: true, initialized: true, pid: 3210, sequence: 4 }),
      send: async () => {},
      listEvents: ({ after, sessionId }) => browserEvents
        .filter((event) => event.sequence > after && sessionId === 'browser-instance-a'),
    },
    now: () => new Date(nowMs),
    newId: () => `id-${++id}`,
    newSecret: () => `secret-${++secret}-0123456789abcdef`,
  });
  return {
    service,
    forwarded,
    advance(milliseconds) { nowMs += milliseconds; },
  };
}

async function createConnectedSession(fixture, browserInstanceId = 'browser-instance-a') {
  const created = fixture.service.createSession({
    mode: 'semantic',
    browserSessionId: browserInstanceId,
    browserInstanceId,
    requestedCapabilities: ['thread.read', 'thread.write', 'turn.start', 'approval.respond'],
  });
  const connected = fixture.service.connect(created.session.id, {
    ticket: created.ticket.value,
    browserInstanceId,
  });
  return { created, connected };
}

test('creates a paired semantic session with a one-time ticket, control lease, normalized events, and adapter forwarding', async () => {
  const fixture = createFixture();
  const status = await fixture.service.status();
  assert.equal(status.adapter.state, 'compatible');
  assert.equal(status.modes.semantic.available, true);
  assert.equal(status.modes.nativeMirror.available, false);

  const { created, connected } = await createConnectedSession(fixture);
  assert.equal(created.session.deviceId, status.device.id);
  assert.equal(created.ticket.singleUse, true);
  assert.equal(connected.lease.epoch, 1);
  assert.equal(fixture.service.listDevices()[0].paired, true);

  const sent = await fixture.service.send(created.session.id, {
    connectionToken: connected.connectionToken,
    browserInstanceId: 'browser-instance-a',
    leaseEpoch: connected.lease.epoch,
    message: { type: 'mcp-request', request: { id: 'request-1', method: 'thread/list' } },
  }, async (payload) => {
    fixture.forwarded.push(payload);
    return { accepted: true, events: [{ type: 'fetch-response' }] };
  });
  assert.deepEqual(sent, { accepted: true, events: [{ type: 'fetch-response' }] });
  assert.equal(fixture.forwarded[0].sessionId, 'browser-instance-a');

  const events = fixture.service.listEvents(created.session.id, {
    connectionToken: connected.connectionToken,
    after: 0,
  });
  assert.equal(events.cursor, 4);
  assert.equal(events.events[0].event.kind, 'notification');
  assert.equal(events.events[0].event.method, 'thread/started');
  assert.equal(events.events[1].event.kind, 'approval-request');

  fixture.advance(10_000);
  const renewed = fixture.service.renewLease(created.session.id, {
    connectionToken: connected.connectionToken,
    browserInstanceId: 'browser-instance-a',
    leaseEpoch: connected.lease.epoch,
  });
  assert.equal(renewed.epoch, connected.lease.epoch);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(connected.lease.expiresAt));
});

test('consumes tickets once and revokes the old controller when another browser receives the device lease', async () => {
  const fixture = createFixture();
  const first = await createConnectedSession(fixture, 'browser-instance-a');
  assert.throws(() => fixture.service.connect(first.created.session.id, {
    ticket: first.created.ticket.value,
    browserInstanceId: 'browser-instance-a',
  }), (error) => error instanceof CodexRelayServiceError && error.code === 'CODEX_RELAY_TICKET_EXPIRED');

  const second = await createConnectedSession(fixture, 'browser-instance-b');
  assert.equal(second.connected.lease.epoch, 2);
  assert.throws(() => fixture.service.renewLease(first.created.session.id, {
    connectionToken: first.connected.connectionToken,
    browserInstanceId: 'browser-instance-a',
    leaseEpoch: first.connected.lease.epoch,
  }), (error) => error instanceof CodexRelayServiceError && error.code === 'CODEX_RELAY_LEASE_EXPIRED');

  fixture.service.releaseLease(second.created.session.id, {
    connectionToken: second.connected.connectionToken,
    browserInstanceId: 'browser-instance-b',
    leaseEpoch: second.connected.lease.epoch,
  });
  const reacquired = fixture.service.renewLease(first.created.session.id, {
    connectionToken: first.connected.connectionToken,
    browserInstanceId: 'browser-instance-a',
    leaseEpoch: first.connected.lease.epoch,
  });
  assert.ok(reacquired.epoch > second.connected.lease.epoch);
  assert.equal(reacquired.browserInstanceId, 'browser-instance-a');
});

test('issues single-use stream tickets and supports event acknowledgement and resume', async () => {
  const fixture = createFixture();
  const { created, connected } = await createConnectedSession(fixture);
  const ticket = fixture.service.issueStreamTicket(created.session.id, {
    connectionToken: connected.connectionToken,
    browserInstanceId: 'browser-instance-a',
    after: 0,
  });
  assert.equal(ticket.protocol, 'codex-host-rpc.v1');
  assert.equal(ticket.singleUse, true);

  const stream = fixture.service.openEventStream(created.session.id, {
    ticket: ticket.value,
    browserInstanceId: 'browser-instance-a',
  });
  assert.equal(stream.cursor, 0);
  assert.throws(() => fixture.service.openEventStream(created.session.id, {
    ticket: ticket.value,
    browserInstanceId: 'browser-instance-a',
  }), (error) => error.code === 'CODEX_RELAY_STREAM_TICKET_INVALID');

  const first = fixture.service.listStreamEvents(stream.id);
  assert.equal(first.cursor, 4);
  assert.deepEqual(first.events.map((event) => event.sequence), [3, 4]);
  assert.equal(fixture.service.acknowledgeStream(stream.id, 4).ackedCursor, 4);
  assert.throws(() => fixture.service.acknowledgeStream(stream.id, 5), (error) => (
    error.code === 'CODEX_RELAY_STREAM_ACK_INVALID'
  ));

  assert.equal(fixture.service.resumeStream(stream.id, 3).cursor, 3);
  const replay = fixture.service.listStreamEvents(stream.id);
  assert.deepEqual(replay.events.map((event) => event.sequence), [4]);

  const streamedCommand = await fixture.service.sendStreamMessage(stream.id, {
    leaseEpoch: connected.lease.epoch,
    message: { type: 'mcp-request', request: { id: 'request-stream-1', method: 'thread/list' } },
  }, async (payload) => {
    fixture.forwarded.push(payload);
    return { accepted: true, events: [] };
  });
  assert.deepEqual(streamedCommand, { accepted: true, events: [] });
  assert.equal(fixture.forwarded.at(-1).sessionId, 'browser-instance-a');

  assert.deepEqual(fixture.service.closeEventStream(stream.id), { closed: true, streamId: stream.id });
});

test('rejects native mirror requests until a selected-window capture adapter is configured', () => {
  const fixture = createFixture();
  assert.throws(() => fixture.service.createSession({
    mode: 'native_mirror',
    browserSessionId: 'browser-instance-a',
  }), (error) => (
    error instanceof CodexRelayServiceError
      && error.code === 'CODEX_RELAY_NATIVE_MIRROR_UNAVAILABLE'
      && error.status === 409
  ));
});

test('reports an installed view-only native mirror adapter without changing semantic defaults', async () => {
  const service = createCodexRelayService({
    workspaceRoot: 'C:\\workspace',
    codexDesktopService: {
      status: async () => ({ ready: true, version: '26.803.81509', buildNumber: '6415' }),
    },
    codexBrowserService: {
      status: () => ({ running: true, initialized: true, pid: 3210, sequence: 4 }),
      send: async () => {},
      listEvents: () => [],
    },
    nativeMirrorService: {
      status: () => ({ available: true, state: 'view_only', transport: 'webrtc', inputEnabled: false }),
    },
  });
  const status = await service.status();
  assert.equal(status.modes.nativeMirror.available, true);
  assert.equal(status.modes.nativeMirror.state, 'view_only');
  assert.equal(status.modes.nativeMirror.inputEnabled, false);
  assert.equal(status.modes.semantic.available, true);
});

test('advertises desktop input when the local native mirror bridge is interactive', async () => {
  const service = createCodexRelayService({
    workspaceRoot: 'C:\\workspace',
    codexDesktopService: {
      status: async () => ({ ready: true, version: '26.803.81509', buildNumber: '6415' }),
    },
    codexBrowserService: {
      status: () => ({ running: true, initialized: true }),
      send: async () => {},
      listEvents: () => [],
    },
    nativeMirrorService: {
      status: () => ({ available: true, state: 'interactive', transport: 'webrtc', inputEnabled: true }),
    },
  });

  const status = await service.status();
  assert.equal(status.device.capabilities.includes('desktop.stream'), true);
  assert.equal(status.device.capabilities.includes('desktop.input'), true);
  assert.equal(service.listDevices()[0].capabilities.includes('desktop.input'), true);
});

test('routes a paired remote device through the outbound gateway while retaining per-device control leases', async () => {
  const offered = [];
  const sent = [];
  const closed = [];
  const remoteDevice = {
    id: 'dev-remote-office',
    name: 'Office PC',
    online: true,
    paired: true,
    transport: 'outbound-websocket',
    capabilities: ['thread.read', 'turn.start'],
  };
  let secret = 0;
  const service = createCodexRelayService({
    workspaceRoot: 'C:\\workspace',
    codexDesktopService: { status: async () => ({ ready: true, version: '26.803.81509', buildNumber: '6415' }) },
    codexBrowserService: { status: () => ({ running: true, initialized: true }), send: async () => {}, listEvents: () => [] },
    deviceGatewayService: {
      status: () => ({ transport: 'outbound-websocket', onlineDevices: 1 }),
      listDevices: () => [remoteDevice],
      getDevice: (deviceId, { ownerId }) => deviceId === remoteDevice.id && ownerId === 'owner@example.com' ? remoteDevice : null,
      offerSession: (deviceId, session) => { offered.push({ deviceId, session }); return { delivered: true }; },
      sendSessionMessage: (deviceId, sessionId, message) => { sent.push({ deviceId, sessionId, message }); return { delivered: true }; },
      listSessionEvents: () => ({ events: [{ sequence: 9, event: { type: 'turn.completed' }, receivedAt: '2026-08-18T08:00:10.000Z' }], cursor: 9 }),
      closeRemoteSession: (deviceId, sessionId) => { closed.push({ deviceId, sessionId }); return { delivered: true }; },
    },
    iceService: {
      status: () => ({ configuredServers: 1, turnConfigured: true, turnCredentialMode: 'time-limited-hmac' }),
      issue: ({ subject }) => ({ iceServers: [{ urls: 'turn:relay.example.test:3478', username: subject, credential: 'temporary' }], expiresAt: '2026-08-18T08:10:00.000Z' }),
    },
    now: () => new Date('2026-08-18T08:00:00.000Z'),
    newId: (() => { let id = 0; return () => `remote-${++id}`; })(),
    newSecret: () => `secret-${++secret}-0123456789abcdef`,
  });

  assert.equal(service.listDevices({ ownerId: 'owner@example.com' }).length, 2);
  const localCreated = service.createSession({
    ownerId: 'owner@example.com',
    browserSessionId: 'browser-local-01',
    browserInstanceId: 'browser-local-01',
  });
  const localConnected = service.connect(localCreated.session.id, {
    ticket: localCreated.ticket.value,
    browserInstanceId: 'browser-local-01',
  });
  const remoteCreated = service.createSession({
    ownerId: 'owner@example.com',
    deviceId: remoteDevice.id,
    browserSessionId: 'browser-remote-01',
    browserInstanceId: 'browser-remote-01',
    requestedCapabilities: ['thread.read', 'turn.start'],
  });
  assert.equal(remoteCreated.session.transport, 'outbound-websocket');
  assert.equal(remoteCreated.deviceConfirmationRequired, true);
  assert.equal(remoteCreated.rtcConfiguration.iceServers[0].username, remoteCreated.session.id);
  assert.equal(offered.length, 1);
  const remoteConnected = service.connect(remoteCreated.session.id, {
    ticket: remoteCreated.ticket.value,
    browserInstanceId: 'browser-remote-01',
  });

  // A remote controller does not revoke a controller on another device.
  assert.doesNotThrow(() => service.renewLease(localCreated.session.id, {
    connectionToken: localConnected.connectionToken,
    browserInstanceId: 'browser-local-01',
    leaseEpoch: localConnected.lease.epoch,
  }));
  const result = await service.send(remoteCreated.session.id, {
    connectionToken: remoteConnected.connectionToken,
    browserInstanceId: 'browser-remote-01',
    leaseEpoch: remoteConnected.lease.epoch,
    message: { type: 'mcp-request', request: { method: 'thread/list' } },
  });
  assert.equal(result.transport, 'outbound-websocket');
  assert.equal(sent[0].deviceId, remoteDevice.id);
  const events = service.listEvents(remoteCreated.session.id, { connectionToken: remoteConnected.connectionToken });
  assert.equal(events.cursor, 9);
  assert.equal(events.events[0].event.kind, 'remote-event');
  service.closeSession(remoteCreated.session.id, { connectionToken: remoteConnected.connectionToken });
  assert.equal(closed.length, 1);
});

test('creates a single-use semantic session invite for one-click browser access', () => {
  const fixture = createFixture();
  const invite = fixture.service.createShareInvite({ deviceId: fixture.service.device.id });
  assert.equal(invite.invite.singleUse, true);
  assert.equal(invite.invite.sessionId, invite.session.id);
  const connected = fixture.service.connect(invite.session.id, {
    ticket: invite.invite.ticket,
    browserInstanceId: invite.invite.browserInstanceId,
  });
  assert.equal(connected.session.id, invite.session.id);
  assert.throws(() => fixture.service.connect(invite.session.id, {
    ticket: invite.invite.ticket,
    browserInstanceId: invite.invite.browserInstanceId,
  }), { code: 'CODEX_RELAY_TICKET_EXPIRED' });
});
