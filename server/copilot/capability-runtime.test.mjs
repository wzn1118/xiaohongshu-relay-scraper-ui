import assert from 'node:assert/strict';
import test from 'node:test';

import { CapabilityRuntime, CapabilityRuntimeError } from './capability-runtime.mjs';

function createRegistry(definitions, execute = async () => ({ ok: true })) {
  return {
    list: () => definitions,
    get: (name) => definitions.find((tool) => tool.name === name) || null,
    search: () => [],
    describeCapabilities: () => ({ schemaVersion: 1, total: definitions.length }),
    execute,
  };
}

function tool(name, { source = 'workspace', risk = 'approval_required' } = {}) {
  return { name, source, risk, description: name, inputSchema: { type: 'object' } };
}

test('workspace_auto permits only local top-level write, patch, and command capabilities', async () => {
  const calls = [];
  const registry = createRegistry([
    tool('workspace.read', { risk: 'read' }),
    tool('workspace.write'),
    tool('workspace.patch'),
    tool('exec.run'),
    tool('http.request', { source: 'workspace' }),
    tool('mcp.github.create-issue', { source: 'mcp' }),
  ], async (name, input, context) => {
    calls.push({ name, input, context });
    return { name, apiKey: 'hidden' };
  });
  const runtime = new CapabilityRuntime({ registry, idFactory: (() => { let index = 0; return () => `id-${++index}`; })() });
  const execution = runtime.createExecution({
    runId: 'run-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    authority: { profile: 'workspace_auto', trustedLocal: true },
  });

  const receipt = await runtime.execute('workspace.write', { path: 'a.txt', content: 'hello', apiKey: 'secret' }, execution);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.authority.automatic, true);
  assert.equal(receipt.input.apiKey, '[redacted]');
  assert.equal(receipt.result.apiKey, '[redacted]');
  assert.equal(calls[0].context.authorizationMode, 'workspace_auto');
  assert.equal(calls[0].context.approved, true);
  assert.equal(calls[0].context.projectId, 'project-1');

  assert.throws(() => runtime.authorize(registry.get('http.request'), execution), {
    code: 'CAPABILITY_AUTHORITY_DENIED',
    status: 403,
  });
  assert.throws(() => runtime.authorize(registry.get('mcp.github.create-issue'), execution), {
    code: 'CAPABILITY_AUTHORITY_DENIED',
  });
  assert.throws(() => runtime.authorize(registry.get('exec.run'), runtime.createExecution({
    agentDepth: 1,
    authority: { profile: 'workspace_auto', trustedLocal: true },
  })), { code: 'CAPABILITY_AUTHORITY_DENIED' });
});

test('owner_local_full requires server-derived local trust while delegated mode follows exact grants', async () => {
  const registry = createRegistry([
    tool('exec.run'),
    tool('mcp.repo.push', { source: 'mcp' }),
  ]);
  const runtime = new CapabilityRuntime({ registry });
  const ownerWithoutLocalTrust = runtime.createExecution({ authority: { profile: 'owner_local_full' } });
  assert.throws(() => runtime.authorize(registry.get('exec.run'), ownerWithoutLocalTrust), { code: 'CAPABILITY_AUTHORITY_DENIED' });

  const owner = runtime.createExecution({ authority: { profile: 'owner_local_full', trustedLocal: true } });
  assert.equal(runtime.authorize(registry.get('mcp.repo.push'), owner).automatic, true);

  const delegated = runtime.createExecution({ authority: { profile: 'delegated', grants: ['mcp.repo.push'] } });
  assert.equal(runtime.authorize(registry.get('mcp.repo.push'), delegated).mode, 'delegated');
  assert.throws(() => runtime.authorize(registry.get('exec.run'), delegated), { code: 'CAPABILITY_AUTHORITY_DENIED' });
});

test('failed adapters become bounded, redacted receipts that retain run linkage', async () => {
  const runtime = new CapabilityRuntime({
    registry: createRegistry([tool('workspace.patch')], async () => {
      const error = new Error('authorization=Bearer secret-value patch context missing');
      error.code = 'WORKSPACE_PATCH_CONTEXT_MISSING';
      error.status = 409;
      throw error;
    }),
    now: (() => { let tick = 0; return () => new Date(`2026-08-16T00:00:0${tick++}Z`); })(),
    idFactory: () => 'fixed',
  });
  const receipt = await runtime.execute('workspace.patch', { token: 'value' }, {
    runId: 'run-42',
    conversationId: 'conversation-42',
    authority: { profile: 'workspace_auto', trustedLocal: true },
  });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.runId, 'run-42');
  assert.equal(receipt.conversationId, 'conversation-42');
  assert.equal(receipt.input.token, '[redacted]');
  assert.equal(receipt.error.code, 'WORKSPACE_PATCH_CONTEXT_MISSING');
  assert.ok(receipt.error.message.includes('[redacted]'));
  assert.equal(receipt.durationMs, 1_000);
});

test('rejects malformed authority profiles and missing tools with stable errors', () => {
  const runtime = new CapabilityRuntime({ registry: createRegistry([]) });
  assert.throws(() => runtime.createExecution({ authority: { profile: 'anything' } }), CapabilityRuntimeError);
  assert.rejects(() => runtime.execute('unknown', {}, { authority: { profile: 'observe' } }), {
    code: 'CAPABILITY_TOOL_UNKNOWN',
    status: 404,
  });
});
