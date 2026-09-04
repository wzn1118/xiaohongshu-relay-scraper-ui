import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexCanonicalAdapter, extractProtocolVersion } from './codex-canonical-adapter.mjs';

test('maps canonical methods without changing raw app-server envelopes', async () => {
  const sent = [];
  const transport = {
    sendRaw: (message) => { sent.push(message); },
    request: async (message) => ({ echoedMethod: message.method, params: message.params }),
  };
  const adapter = createCodexCanonicalAdapter({
    transport,
    protocolVersion: 'fixture',
    supportedMethods: ['thread/list', 'thread/start', 'thread/read', 'thread/resume'],
  });
  const raw = adapter.toRawRequest({ id: 'canonical-1', method: 'threads.list', params: { limit: 3 } });
  assert.deepEqual(raw, { id: 'canonical-1', method: 'thread/list', params: { limit: 3 } });
  assert.deepEqual(await adapter.request({ id: 'canonical-2', method: 'threads.start', params: { cwd: 'C:\\workspace' } }), {
    echoedMethod: 'thread/start',
    params: { cwd: 'C:\\workspace' },
  });
  assert.equal(adapter.supports('threads'), true);
  assert.equal(adapter.supports('turns'), false);
  assert.equal(adapter.capabilities().evidence, 'schema-or-probe');
  assert.equal(sent.length, 0);
});

test('does not claim runtime capabilities before schema/probe evidence exists', () => {
  const adapter = createCodexCanonicalAdapter({
    transport: { sendRaw() {}, request: async () => ({}) },
  });
  assert.equal(adapter.capabilities().capabilities.threads, 'unknown');
  assert.equal(adapter.supports('threads'), false);
});

test('activates generated schema evidence only when the running app-server version matches', () => {
  let runtimeVersion = '';
  const adapter = createCodexCanonicalAdapter({
    transport: { sendRaw() {}, request: async () => ({}) },
    protocolEvidence: {
      state: 'ready',
      source: 'generated-schema+live-probe',
      protocolVersion: '0.147.0-alpha.6.6',
      schemaPath: 'schema.json',
      probePath: 'live-probe.json',
      schemaSha256: 'abc',
      methods: { all: Object.values({
        initialize: ['initialize'],
        threads: ['thread/list', 'thread/read', 'thread/start', 'thread/resume'],
      }).flat() },
      probes: { passed: ['thread/list'], failed: [] },
    },
    getRuntimeVersion: () => runtimeVersion,
  });

  assert.equal(adapter.capabilities().capabilities.threads, 'unknown');
  assert.equal(adapter.capabilities().evidenceDetail.state, 'pending-runtime');
  runtimeVersion = 'Codex Desktop/0.148.0 (Windows 10; x86_64)';
  assert.equal(adapter.capabilities().capabilities.threads, 'unknown');
  assert.equal(adapter.capabilities().evidence, 'protocol-evidence-mismatch');
  runtimeVersion = 'Codex Desktop/0.147.0-alpha.6.6 (Windows 10; x86_64)';
  assert.equal(adapter.capabilities().capabilities.threads, 'supported');
  assert.equal(adapter.capabilities().capabilityEvidence.threads.liveVerification, 'partial');
  assert.equal(adapter.capabilities().evidence, 'generated-schema+live-probe');
});

test('extracts the protocol version from the initialized app-server user agent', () => {
  assert.equal(extractProtocolVersion('Codex Desktop/0.147.0-alpha.6.6 (Windows 10; x86_64)'), '0.147.0-alpha.6.6');
  assert.equal(extractProtocolVersion(''), null);
});

test('classifies responses, approval requests, notifications, and unknown messages', () => {
  const adapter = createCodexCanonicalAdapter({
    transport: { sendRaw() {}, request: async () => ({}) },
  });
  assert.equal(adapter.normalizeInbound({ id: '1', result: {} }).kind, 'response');
  assert.equal(adapter.normalizeInbound({ id: '2', method: 'item/commandExecution/requestApproval', params: {} }).kind, 'server-request');
  assert.equal(adapter.normalizeInbound({ method: 'thread/started', params: {} }).kind, 'notification');
  assert.equal(adapter.normalizeInbound({ value: true }).kind, 'unknown');
  assert.deepEqual(adapter.fromLegacyMessage({ type: 'mcp-request', request: { id: '3', method: 'thread/list' } }), {
    id: '3',
    method: 'thread/list',
  });
});
