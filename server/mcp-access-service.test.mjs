import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { McpAccessService } from './mcp-access-service.mjs';

test('MCP Grant is one-time, snapshot-bound, scoped, revocable, and idempotent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-access-'));
  const productionStore = createCopilotProductionStore({ rootDir: root });
  t.after(async () => { productionStore.close(); await rm(root, { recursive: true, force: true }); });
  const reference = {
    conversationId: 'conversation-1', jobId: 'job-1', snapshotId: 'job-1-r1', mode: 'application',
    scope: { allowedScopes: ['dataset:read', 'content:read'], jobRevision: 1 },
  };
  const conversation = { ...reference };
  const snapshot = { jobId: reference.jobId, snapshotId: reference.snapshotId, manifestHash: 'manifest-1' };
  let calls = 0;
  const safeTool = {
    name: 'records.query', description: 'Query records.', inputSchema: { type: 'object' },
    _meta: { scopes: ['dataset:read'], risk: 'read' },
  };
  const adapter = {
    listTools: () => [safeTool],
    listResources: () => [{ name: 'content', uri: 'xhs-data://job-1/job-1-r1/content', mimeType: 'application/json' }],
    readResource: async (_reference, _conversation, uri) => ({ contents: [{ uri, text: '[]' }] }),
    callTool: async () => { calls += 1; return { rows: [{ id: 1 }] }; },
  };
  const service = new McpAccessService({
    productionStore,
    dataCopilotService: { getMcpContext: async () => ({ reference, conversation, snapshot }) },
    adapter,
    registry: { get: (name) => name === safeTool.name ? { ...safeTool, risk: 'read' } : null },
    approvals: {},
    tokenPepperPath: path.join(root, 'auth', 'pepper'),
  });
  await service.initialize();

  const created = await service.createGrant({ conversationId: reference.conversationId, expiresInSeconds: 600 }, { id: 'owner-1' });
  assert.match(created.token, /^xhs_mcp_[0-9a-f-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(created.grant.tokenHash, undefined);
  assert.equal(created.grant.owner, undefined);
  assert.equal(created.grant.manifestHash, snapshot.manifestHash);
  assert.deepEqual(created.grant.scopes, ['content:read', 'dataset:read']);
  assert.deepEqual(created.grant.allowedTools, ['records.query']);
  assert.deepEqual(created.grant.allowedResources, ['content']);
  assert.equal(JSON.stringify(service.listGrants({ id: 'owner-1' })).includes(created.token), false);

  const context = await service.authenticateToken(created.token);
  assert.equal(context.grant.snapshotId, reference.snapshotId);
  assert.equal(service.listResources(context).length, 1);
  assert.equal(service.listTools(context).length, 1);
  const first = await service.executeTool(context, 'records.query', { dataset: 'content' }, {
    requestId: 'request-1', idempotencyKey: 'same-request',
  });
  const duplicate = await service.executeTool(context, 'records.query', { dataset: 'content' }, {
    requestId: 'request-2', idempotencyKey: 'same-request',
  });
  assert.deepEqual(duplicate, first);
  assert.equal(calls, 1);
  await assert.rejects(
    service.executeTool(context, 'records.query', { dataset: 'applications' }, { idempotencyKey: 'same-request' }),
    (error) => error.code === 'MCP_IDEMPOTENCY_CONFLICT',
  );

  const rotated = await service.rotateGrant(created.grant.grantId, {}, { id: 'owner-1' });
  await assert.rejects(service.authenticateToken(created.token), (error) => error.code === 'MCP_GRANT_REVOKED');
  assert.equal((await service.authenticateToken(rotated.token)).grant.manifestHash, snapshot.manifestHash);
  snapshot.manifestHash = 'manifest-changed';
  await assert.rejects(service.authenticateToken(rotated.token), (error) => error.code === 'MCP_GRANT_CONTEXT_STALE');
  snapshot.manifestHash = 'manifest-1';
  service.revokeGrant(rotated.grant.grantId, { id: 'owner-1' });
});

test('MCP startup reconciliation closes sessions persisted by a prior server process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-session-reconcile-'));
  const productionStore = createCopilotProductionStore({ rootDir: root });
  t.after(async () => { productionStore.close(); await rm(root, { recursive: true, force: true }); });
  const reference = {
    conversationId: 'conversation-reconcile', jobId: 'job-reconcile', snapshotId: 'job-reconcile-r1', mode: 'application',
    scope: { allowedScopes: ['content:read'], jobRevision: 1 },
  };
  const conversation = { ...reference };
  const snapshot = { jobId: reference.jobId, snapshotId: reference.snapshotId, manifestHash: 'manifest-reconcile' };
  const tool = {
    name: 'records.query', description: 'Query records.', inputSchema: { type: 'object' },
    _meta: { scopes: ['content:read'], risk: 'read' },
  };
  const dependencies = {
    productionStore,
    dataCopilotService: { getMcpContext: async () => ({ reference, conversation, snapshot }) },
    adapter: {
      listTools: () => [tool],
      listResources: () => [{ name: 'content', uri: 'xhs-data://job-reconcile/job-reconcile-r1/content', mimeType: 'application/json' }],
    },
    registry: { get: () => tool },
    approvals: {},
    tokenPepperPath: path.join(root, 'auth', 'pepper'),
  };
  const firstProcess = new McpAccessService(dependencies);
  await firstProcess.initialize();
  const created = await firstProcess.createGrant({ conversationId: reference.conversationId }, { id: 'owner-reconcile' });
  const context = await firstProcess.authenticateToken(created.token);
  firstProcess.registerSession(context, 'session-left-by-prior-process', { name: 'prior-process' });
  assert.equal(firstProcess.status().sessions.active, 1);

  const restartedProcess = new McpAccessService(dependencies);
  await restartedProcess.initialize();
  assert.equal(restartedProcess.status().sessions.active, 0);
  assert.equal(productionStore.getMcpSession('session-left-by-prior-process').status, 'closed');
});

test('approved MCP tool failures are persisted and audited', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-approval-'));
  const productionStore = createCopilotProductionStore({ rootDir: root });
  t.after(async () => { productionStore.close(); await rm(root, { recursive: true, force: true }); });
  const reference = {
    conversationId: 'conversation-approval', jobId: 'job-approval', snapshotId: 'job-approval-r1', mode: 'application',
    scope: { allowedScopes: ['applications:send'], jobRevision: 1 },
  };
  const conversation = { ...reference };
  const snapshot = { jobId: reference.jobId, snapshotId: reference.snapshotId, manifestHash: 'manifest-approval' };
  const tool = {
    name: 'applications.send_email', description: 'Send an application email.', inputSchema: { type: 'object' },
    _meta: { scopes: ['applications:send'], risk: 'approval_required' },
  };
  let approval;
  const approvals = {
    createApproval: async (_context, value) => {
      approval = {
        ...value, approvalId: 'approval-failure', requestHash: 'request-hash', status: 'pending',
      };
      return approval;
    },
    getApproval: async () => approval,
    approve: async () => { approval = { ...approval, status: 'approved' }; return approval; },
    consume: async () => { throw new Error('consume must not run after tool failure'); },
  };
  const adapter = {
    listTools: () => [tool],
    listResources: () => [],
    callTool: async () => { throw Object.assign(new Error('SMTP is unavailable.'), { code: 'SMTP_UNAVAILABLE' }); },
  };
  const service = new McpAccessService({
    productionStore,
    dataCopilotService: { getMcpContext: async () => ({ reference, conversation, snapshot }) },
    adapter,
    registry: { get: (name) => name === tool.name ? { ...tool, risk: 'approval_required' } : null },
    approvals,
    tokenPepperPath: path.join(root, 'auth', 'pepper'),
  });
  await service.initialize();
  const created = await service.createGrant({ conversationId: reference.conversationId }, { id: 'owner-approval' });
  const context = await service.authenticateToken(created.token);
  const pending = await service.executeTool(context, tool.name, { applicationId: 'app-1' }, {
    idempotencyKey: 'approval-failure-run',
  });
  assert.equal(pending.status, 'approval_required');
  assert.match(pending.actionHash, /^[a-f0-9]{64}$/u);
  assert.equal(approval.binding.actionHash, pending.actionHash);
  assert.equal(approval.binding.grantId, created.grant.grantId);
  assert.equal(approval.binding.snapshotId, snapshot.snapshotId);

  const actionHash = approval.binding.actionHash;
  approval.binding.actionHash = '0'.repeat(64);
  await assert.rejects(
    service.decideApproval(pending.approvalId, { action: 'approve' }, { id: 'owner-approval' }),
    (error) => error.code === 'MCP_APPROVAL_MISMATCH',
  );
  approval.binding.actionHash = actionHash;

  await assert.rejects(
    service.decideApproval(pending.approvalId, { action: 'approve' }, { id: 'owner-approval' }),
    (error) => error.code === 'SMTP_UNAVAILABLE',
  );
  const [run] = service.listToolRuns({ id: 'owner-approval' }).toolRuns;
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.error, { code: 'SMTP_UNAVAILABLE', message: 'SMTP is unavailable.' });
  assert.equal(service.listAudit({ id: 'owner-approval' }).events.some((event) => (
    event.action === 'approval.execution_failed' && event.status === 'failed'
  )), true);
});

test('MCP runtime enforces output, rate, and concurrent operation limits per Grant', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-limits-'));
  const productionStore = createCopilotProductionStore({ rootDir: root });
  t.after(async () => { productionStore.close(); await rm(root, { recursive: true, force: true }); });
  const reference = {
    conversationId: 'conversation-limits', jobId: 'job-limits', snapshotId: 'job-limits-r1', mode: 'application',
    scope: { allowedScopes: ['dataset:read', 'content:read'], jobRevision: 1 },
  };
  const conversation = { ...reference };
  const snapshot = { jobId: reference.jobId, snapshotId: reference.snapshotId, manifestHash: 'manifest-limits' };
  const tool = {
    name: 'records.query', description: 'Query records.', inputSchema: { type: 'object' },
    version: '2.0.0', risk: 'read', _meta: { scopes: ['dataset:read'], risk: 'read', version: '2.0.0' },
  };
  let releaseSlowCall;
  const slowCall = new Promise((resolve) => { releaseSlowCall = resolve; });
  let mode = 'large';
  const adapter = {
    listTools: () => [tool],
    listResources: () => [{ name: 'content', uri: 'xhs-data://job-limits/job-limits-r1/content', mimeType: 'application/json' }],
    readResource: async (_reference, _conversation, uri) => ({ contents: [{ uri, text: 'x'.repeat(2_000) }] }),
    callTool: async () => {
      if (mode === 'slow') return slowCall;
      if (mode === 'large') return { value: 'x'.repeat(2_000) };
      return { ok: true };
    },
  };
  const service = new McpAccessService({
    productionStore,
    dataCopilotService: { getMcpContext: async () => ({ reference, conversation, snapshot }) },
    adapter,
    registry: { get: (name) => name === tool.name ? tool : null },
    approvals: {},
    tokenPepperPath: path.join(root, 'auth', 'pepper'),
    limits: { maxOutputBytes: 1_024, maxConcurrentToolsPerGrant: 1, maxCallsPerMinute: 10 },
  });
  await service.initialize();
  const created = await service.createGrant({ conversationId: reference.conversationId }, { id: 'owner-limits' });
  const context = await service.authenticateToken(created.token);

  await assert.rejects(
    service.executeTool(context, tool.name, {}, { idempotencyKey: 'large-result' }),
    (error) => error.code === 'MCP_OUTPUT_LIMIT_EXCEEDED' && error.status === 413,
  );
  const boundedResource = await service.readResource(context, 'xhs-data://job-limits/job-limits-r1/content');
  const boundedResourcePayload = JSON.parse(boundedResource.contents[0].text);
  assert.equal(boundedResourcePayload.code, 'MCP_OUTPUT_TRUNCATED');
  assert.equal(boundedResourcePayload.maximumBytes, 1_024);

  mode = 'slow';
  const active = service.executeTool(context, tool.name, {}, { idempotencyKey: 'slow-result' });
  await assert.rejects(
    service.executeTool(context, tool.name, {}, { idempotencyKey: 'concurrent-result' }),
    (error) => error.code === 'MCP_RATE_LIMITED' && error.status === 429,
  );
  releaseSlowCall({ ok: true });
  assert.deepEqual(await active, { ok: true });
});

test('MCP runtime enforces the per-Grant operation rate limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-mcp-rate-'));
  const productionStore = createCopilotProductionStore({ rootDir: root });
  t.after(async () => { productionStore.close(); await rm(root, { recursive: true, force: true }); });
  const reference = {
    conversationId: 'conversation-rate', jobId: 'job-rate', snapshotId: 'job-rate-r1', mode: 'application',
    scope: { allowedScopes: ['dataset:read'], jobRevision: 1 },
  };
  const conversation = { ...reference };
  const snapshot = { jobId: reference.jobId, snapshotId: reference.snapshotId, manifestHash: 'manifest-rate' };
  const tool = {
    name: 'records.query', description: 'Query records.', inputSchema: { type: 'object' },
    risk: 'read', _meta: { scopes: ['dataset:read'], risk: 'read' },
  };
  const service = new McpAccessService({
    productionStore,
    dataCopilotService: { getMcpContext: async () => ({ reference, conversation, snapshot }) },
    adapter: { listTools: () => [tool], listResources: () => [], callTool: async () => ({ ok: true }) },
    registry: { get: () => tool }, approvals: {},
    tokenPepperPath: path.join(root, 'auth', 'pepper'),
    limits: { maxCallsPerMinute: 1 },
  });
  await service.initialize();
  const created = await service.createGrant({ conversationId: reference.conversationId }, { id: 'owner-rate' });
  const context = await service.authenticateToken(created.token);
  assert.deepEqual(await service.executeTool(context, tool.name, {}, { idempotencyKey: 'rate-1' }), { ok: true });
  await assert.rejects(
    service.executeTool(context, tool.name, {}, { idempotencyKey: 'rate-2' }),
    (error) => error.code === 'MCP_RATE_LIMITED' && error.status === 429,
  );
});
