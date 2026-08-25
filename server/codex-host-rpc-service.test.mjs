import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { createCodexHostCommandService } from './codex-host-command-service.mjs';
import { createCodexHostRpcService, RPC_PROTOCOL } from './codex-host-rpc-service.mjs';

test('streams typed events and accepts acknowledgements and resume commands', async () => {
  const calls = { ack: [], resume: [], close: [] };
  let browserCommands = 0;
  let workerCommands = 0;
  let listed = false;
  const relayService = {
    openEventStream(sessionId, { ticket, browserInstanceId }) {
      assert.equal(sessionId, 'relay-session-1');
      assert.equal(ticket, 'stream-secret');
      assert.equal(browserInstanceId, 'browser-instance-a');
      return { id: 'stream-1', sessionId, protocol: RPC_PROTOCOL, cursor: 0, ackedCursor: 0 };
    },
    listStreamEvents(streamId) {
      assert.equal(streamId, 'stream-1');
      if (listed) return { events: [], cursor: 3 };
      listed = true;
      return {
        events: [{ sequence: 3, event: { kind: 'notification' }, message: { type: 'mcp-notification', method: 'thread/started' } }],
        cursor: 3,
      };
    },
    acknowledgeStream(streamId, cursor) {
      calls.ack.push([streamId, cursor]);
      return { id: streamId, cursor: 3, ackedCursor: cursor };
    },
    resumeStream(streamId, cursor) {
      calls.resume.push([streamId, cursor]);
      return { id: streamId, cursor, ackedCursor: cursor };
    },
    sendStreamMessage(streamId, { leaseEpoch, message }, forward) {
      assert.equal(streamId, 'stream-1');
      assert.equal(leaseEpoch, 7);
      return forward({ sessionId: 'browser-instance-a', message });
    },
    closeEventStream(streamId) { calls.close.push(streamId); return { closed: true }; },
  };
  const commandService = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    relayService,
    codexBrowserService: {
      send: async (message) => {
        browserCommands += 1;
        if (message.type === 'test-error') {
          const error = new Error('adapter rejected command');
          error.code = 'CODEX_TEST_ADAPTER_ERROR';
          throw error;
        }
      },
    },
    workerService: {
      capabilities: () => ({ workerIds: ['git'] }),
      status: () => ({ state: 'ready' }),
      handleMessage: async (workerId, message) => {
        workerCommands += 1;
        return { accepted: true, workerId, messages: [{ type: 'worker-response', workerId, response: { id: message.request.id } }] };
      },
    },
  });
  const service = createCodexHostRpcService({ relayService, commandService, pollIntervalMs: 10, heartbeatMs: 5_000 });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  service.attachServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/codex-relay/sessions/relay-session-1/stream?browserInstanceId=browser-instance-a`,
    [RPC_PROTOCOL, 'codex-ticket.stream-secret'],
    { origin: 'http://127.0.0.1:5173' },
  );
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));
  await waitFor(() => messages.some((message) => message.kind === 'event'));
  assert.equal(messages[0].kind, 'hello');
  assert.ok(messages[0].capabilities.includes('host.message.send'));
  assert.ok(messages[0].capabilities.includes('host.worker.send'));
  assert.equal(messages[0].recipes.find((recipe) => recipe.id === 'fetch').state, 'implemented');
  assert.equal(messages.find((message) => message.kind === 'event').message.method, 'thread/started');

  socket.send(JSON.stringify({ rpc: RPC_PROTOCOL, version: 1, kind: 'ack', cursor: 3 }));
  socket.send(JSON.stringify({ rpc: RPC_PROTOCOL, version: 1, kind: 'resume', id: 'resume-1', cursor: 2 }));
  await waitFor(() => messages.some((message) => message.kind === 'result' && message.id === 'resume-1'));
  assert.deepEqual(calls.ack, [['stream-1', 3]]);
  assert.deepEqual(calls.resume, [['stream-1', 2]]);

  const commandEnvelope = JSON.stringify({
    rpc: RPC_PROTOCOL,
    version: 1,
    kind: 'request',
    id: 'command-1',
    method: 'host.message.send',
    params: {
      leaseEpoch: 7,
      message: { type: 'fetch', requestId: 'fetch-1', url: 'vscode://codex/is-packaged' },
    },
  });
  socket.send(commandEnvelope);
  socket.send(commandEnvelope);
  await waitFor(() => messages.filter((message) => message.kind === 'result' && message.id === 'command-1').length === 2);
  assert.equal(browserCommands, 1);
  assert.equal(commandService.status().deduplicatedCommands, 1);

  socket.send(JSON.stringify({
    rpc: RPC_PROTOCOL,
    version: 1,
    kind: 'request',
    id: 'worker-command-1',
    method: 'host.worker.send',
    params: {
      leaseEpoch: 7,
      workerId: 'git',
      message: { type: 'worker-request', workerId: 'git', request: { id: 'git-1', method: 'availability', params: {} } },
    },
  }));
  await waitFor(() => messages.some((message) => message.kind === 'result' && message.id === 'worker-command-1'));
  assert.equal(workerCommands, 1);
  assert.equal(messages.find((message) => message.id === 'worker-command-1').result.messages[0].response.id, 'git-1');

  socket.send(JSON.stringify({
    rpc: RPC_PROTOCOL,
    version: 1,
    kind: 'request',
    id: 'command-error-1',
    method: 'host.message.send',
    params: { leaseEpoch: 7, message: { type: 'test-error' } },
  }));
  await waitFor(() => messages.some((message) => message.kind === 'error' && message.id === 'command-error-1'));
  assert.equal(messages.find((message) => message.id === 'command-error-1').code, 'CODEX_TEST_ADAPTER_ERROR');

  socket.close();
  await waitFor(() => calls.close.length === 1);
  assert.equal(service.status().eventsSent, 1);
  assert.equal(service.status().commandRequests, 4);
  assert.equal(service.status().commandResults, 3);
  assert.equal(service.status().commandErrors, 1);
  assert.equal(service.status().activeStreams, 0);
  await service.close();
  await new Promise((resolve) => server.close(resolve));
});

test('rejects non-loopback browser origins before consuming a stream ticket', async () => {
  let opened = false;
  const service = createCodexHostRpcService({
    relayService: {
      openEventStream() { opened = true; return { id: 'stream-1' }; },
      listStreamEvents() { return { events: [], cursor: 0 }; },
      closeEventStream() {},
    },
  });
  const server = http.createServer();
  service.attachServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/codex-relay/sessions/relay-session-1/stream?browserInstanceId=browser-instance-a`,
    [RPC_PROTOCOL, 'codex-ticket.stream-secret'],
    { origin: 'https://attacker.example' },
  );
  const error = await new Promise((resolve) => socket.once('error', resolve));
  assert.match(error.message, /403/u);
  assert.equal(opened, false);
  assert.equal(service.status().rejectedConnections, 1);
  await service.close();
  await new Promise((resolve) => server.close(resolve));
});

test('accepts a loopback browser origin when a public origin is also configured', async () => {
  let opened = false;
  const service = createCodexHostRpcService({
    allowedOrigin: 'https://relay.example.com',
    relayService: {
      openEventStream() {
        opened = true;
        return { id: 'stream-loopback', sessionId: 'relay-session-1', cursor: 0, ackedCursor: 0 };
      },
      listStreamEvents() { return { events: [], cursor: 0 }; },
      closeEventStream() {},
    },
  });
  const server = http.createServer();
  service.attachServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/codex-relay/sessions/relay-session-1/stream?browserInstanceId=browser-instance-a`,
    [RPC_PROTOCOL, 'codex-ticket.stream-secret'],
    { origin: 'http://127.0.0.1:4327' },
  );
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.equal(opened, true);
  socket.close();
  await service.close();
  await new Promise((resolve) => server.close(resolve));
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Host RPC test state.');
}
