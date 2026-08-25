import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractEnvelopeMethods, loadCodexProtocolEvidence } from './codex-protocol-evidence.mjs';

function envelope(methods) {
  return { oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } })) };
}

test('extracts protocol directions from generated app-server schema envelopes', () => {
  const methods = extractEnvelopeMethods({
    definitions: {
      ClientRequest: envelope(['initialize', 'thread/list']),
      ServerRequest: envelope(['item/tool/call']),
      ClientNotification: envelope(['initialized']),
      ServerNotification: envelope(['thread/started']),
    },
  });
  assert.deepEqual(methods, {
    clientRequests: ['initialize', 'thread/list'],
    serverRequests: ['item/tool/call'],
    clientNotifications: ['initialized'],
    serverNotifications: ['thread/started'],
  });
});

test('selects the latest complete generated schema and merges live probe evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-protocol-evidence-'));
  const older = path.join(root, '0.1.0');
  const current = path.join(root, '0.2.0');
  for (const directory of [older, current]) await mkdir(path.join(directory, 'json-schema'), { recursive: true });
  const schema = {
    definitions: {
      ClientRequest: envelope(['initialize', 'thread/list', 'model/list']),
      ServerRequest: envelope(['item/tool/call']),
      ClientNotification: envelope(['initialized']),
      ServerNotification: envelope(['thread/started']),
    },
  };
  for (const directory of [older, current]) {
    await writeFile(path.join(directory, 'json-schema', 'codex_app_server_protocol.schemas.json'), JSON.stringify(schema));
  }
  await writeFile(path.join(older, 'live-probe.json'), JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z', protocolVersion: '0.1.0', probes: [],
  }));
  await writeFile(path.join(current, 'live-probe.json'), JSON.stringify({
    generatedAt: '2026-02-01T00:00:00.000Z',
    protocolVersion: '0.2.0',
    initialization: { ok: true },
    probes: [
      { method: 'thread/list', status: 'pass' },
      { method: 'model/list', status: 'fail' },
    ],
  }));

  const evidence = await loadCodexProtocolEvidence({ root });
  assert.equal(evidence.state, 'ready');
  assert.equal(evidence.protocolVersion, '0.2.0');
  assert.equal(evidence.source, 'generated-schema+live-probe');
  assert.equal(evidence.methods.all.includes('item/tool/call'), true);
  assert.deepEqual(evidence.probes, {
    initialization: 'pass',
    passed: ['thread/list'],
    failed: ['model/list'],
  });
  assert.match(evidence.schemaSha256, /^[a-f0-9]{64}$/);
});

test('returns unavailable evidence when no complete schema exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-protocol-empty-'));
  const evidence = await loadCodexProtocolEvidence({ root });
  assert.equal(evidence.state, 'unavailable');
  assert.deepEqual(evidence.methods.all, []);
});
