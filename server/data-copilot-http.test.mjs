import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { CopilotArtifactService } from './copilot-artifact-service.mjs';
import { handleDataCopilotRequest } from './data-copilot-http.mjs';
import { DataCopilotService, hashStableFile } from './data-copilot-service.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { DataPolicyEngine } from './data-policy-engine.mjs';
import { DataToolRegistry } from './data-tool-registry.mjs';
import { McpDataAdapter } from './mcp-data-adapter.mjs';
import { createCopilotProductionStore } from './copilot/production-store.mjs';

async function fixture(t, { production = false, subagentRuntime = null } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-http-'));
  let productionStore = null;
  t.after(async () => { productionStore?.close(); await rm(rootDir, { recursive: true, force: true }); });
  const job = {
    id: 'job-http-001', revision: 3, keyword: 'growth', outputDir: rootDir,
    status: 'completed', createdAt: '2026-08-01T07:00:00.000Z', updatedAt: '2026-08-01T08:00:00.000Z',
    progress: 100, discoveredCount: 4, scrapedCount: 2, applicationCount: 2, artifactCount: 3,
    config: { analysisMode: 'job' },
    workflowSummary: { audience: { commentsCollected: 1, usersDiscovered: 1 } },
  };
  await writeFile(path.join(rootDir, 'application_intelligence.json'), JSON.stringify({
    records: [
      { noteId: 'note-http-001', title: 'Growth role', city: 'Shanghai', body: 'Own product growth and user research.' },
      { noteId: 'note-http-002', title: 'Brand role', city: 'Beijing', body: 'Own brand programs.' },
    ],
  }), 'utf8');
  await writeFile(path.join(rootDir, 'audience-comments.json'), JSON.stringify([
    { commentId: 'comment-http-001', postId: 'note-http-001', text: 'How can I apply?', user: { userId: 'user-http-001', displayName: 'Alice' } },
  ]), 'utf8');
  await writeFile(path.join(rootDir, 'audience-users.json'), JSON.stringify([
    { userId: 'user-http-001', displayName: 'Alice', bio: 'Product student', postIds: ['note-http-001'] },
  ]), 'utf8');
  const manager = {
    getInternal: (id) => id === job.id ? job : null,
    get: (id) => id === job.id ? job : null,
    list: () => [job],
  };
  const store = new DataCopilotStore({ rootDir });
  const approvals = new CopilotApprovalStore({ rootDir });
  const artifacts = new CopilotArtifactService({ rootDir });
  const runtime = {
    emit: () => {},
    async start(reference, value) {
      const message = await store.appendMessage(reference, {
        role: 'user', content: { type: 'user.message', text: value.content }, attachments: value.attachments,
        idempotencyKey: `${value.idempotencyKey}:persisted`,
      });
      this.emit(reference, { type: 'user.message', message });
      return { runId: 'run-http-001', duplicate: false, conversation: await store.getConversation(reference) };
    },
    async cancel(reference) { return { cancelled: true, conversation: await store.getConversation(reference) }; },
    async retry(reference) { return { runId: 'run-http-retry', conversation: await store.getConversation(reference) }; },
    async continueApproval(reference, approval) {
      return { runId: approval.runId, conversation: await store.getConversation(reference) };
    },
  };
  const aiSessions = {
    resolve: () => ({ provider: 'local', model: 'test-model', wireApi: 'chat_completions' }),
  };
  const policy = new DataPolicyEngine({ manager });
  const registry = new DataToolRegistry({ manager, policy, artifactService: artifacts });
  const mcpAdapter = new McpDataAdapter({ policy, registry, artifacts });
  const mcpClientManager = createOutboundMcpFixture();
  const workspaceAdapter = {
    workspaceRoot: rootDir,
    get: (name) => ['workspace.read', 'exec.run', 'http.request'].includes(name) ? { name } : null,
  };
  const capabilityRegistry = {
    describeCapabilities: () => ({
      schemaVersion: 1,
      total: registry.list().length + 6 + mcpClientManager.listTools().length,
      sources: { data: registry.list().length, workspace: 6, mcp: mcpClientManager.listTools().length },
    }),
  };
  productionStore = production ? createCopilotProductionStore({ rootDir }) : null;
  const service = new DataCopilotService({
    rootDir,
    store,
    approvals,
    artifacts,
    runtime,
    policy,
    mcpAdapter,
    capabilityRegistry,
    workspaceAdapter,
    mcpClientManager,
    manager,
    aiSessions,
    productionStore,
    subagentRuntime,
  });
  await service.initialize();

  const server = createServer(async (req, res) => {
    const handled = await handleDataCopilotRequest({
      req, res, service, url: new URL(req.url || '/', 'http://localhost'), maxBodyBytes: 64 * 1024,
    });
    if (!handled && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, job, service, artifacts, productionStore, mcpClientManager };
}

function createOutboundMcpFixture() {
  const servers = new Map();
  const listServers = () => [...servers.values()].map((server) => structuredClone(server));
  const listTools = () => listServers()
    .filter((server) => server.enabled && server.status === 'connected')
    .map((server) => ({
      name: `mcp.${server.id}.ping-test`,
      serverId: server.id,
      remoteName: 'ping',
      risk: 'read',
    }));
  return {
    listServers,
    listTools,
    describe: () => ({ schemaVersion: 1, initialized: true, servers: listServers(), toolCount: listTools().length }),
    async upsertServer(value = {}, { connect = false } = {}) {
      const id = String(value.id || value.name || value.label || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
      const previous = servers.get(id) || {};
      const server = {
        ...previous,
        id,
        label: String(value.label || value.name || previous.label || id),
        enabled: value.enabled !== false,
        transport: value.transport || previous.transport || 'streamable_http',
        command: value.command || previous.command,
        args: value.args || previous.args || [],
        url: value.url || previous.url,
        envKeys: value.envKeys || value.env || previous.envKeys || [],
        headerEnv: value.headerEnv || previous.headerEnv || {},
        status: connect && value.enabled !== false ? 'connected' : 'disconnected',
        lastError: null,
        toolCount: connect && value.enabled !== false ? 1 : 0,
      };
      servers.set(id, server);
      return structuredClone(server);
    },
    async removeServer(id) { return servers.delete(String(id || '')); },
    async refresh(id = null) {
      const selected = id ? [servers.get(String(id))].filter(Boolean) : [...servers.values()];
      for (const server of selected) {
        server.status = server.enabled ? 'connected' : 'disconnected';
        server.toolCount = server.enabled ? 1 : 0;
      }
      return selected.map((server) => structuredClone(server));
    },
  };
}

async function createConversation(baseUrl, jobId, overrides = {}) {
  const response = await fetch(`${baseUrl}/api/copilot/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      mode: 'application',
      aiSessionId: 'ai-http-001',
      idempotencyKey: 'conversation-http-create-001',
      ...overrides,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('HTTP conversation, message, and listing contracts use persisted service state', async (t) => {
  const { baseUrl, job } = await fixture(t);
  const created = await createConversation(baseUrl, job.id);
  const id = created.conversation.conversationId;

  const sent = await fetch(`${baseUrl}/api/copilot/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Summarize the current data.',
      aiSessionId: 'ai-http-001',
      idempotencyKey: 'message-http-send-001',
    }),
  });
  assert.equal(sent.status, 202);
  assert.equal((await sent.json()).runId, 'run-http-001');

  const messagesResponse = await fetch(`${baseUrl}/api/copilot/conversations/${id}/messages`);
  assert.equal(messagesResponse.status, 200);
  const messages = await messagesResponse.json();
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].content.text, 'Summarize the current data.');

  const listed = await (await fetch(`${baseUrl}/api/copilot/conversations?jobId=${job.id}`)).json();
  assert.equal(listed.total, 1);
  const details = await (await fetch(`${baseUrl}/api/copilot/conversations/${id}`)).json();
  assert.equal(details.conversation.selectedModel.model, 'test-model');
});

test('HTTP capability and tool catalog endpoints expose runtime-safe manifests', async (t) => {
  const { baseUrl } = await fixture(t);
  const capabilitiesResponse = await fetch(`${baseUrl}/api/copilot/capabilities`);
  const toolsResponse = await fetch(`${baseUrl}/api/copilot/tools?query=${encodeURIComponent('评论用户')}&limit=8`);

  assert.equal(capabilitiesResponse.status, 200);
  assert.equal(toolsResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  const tools = await toolsResponse.json();
  assert.ok(capabilities.toolCatalog.total >= 25);
  assert.ok(tools.tools.some((tool) => tool.name === 'comments.query'));
  assert.ok(tools.tools.every((tool) => !Object.hasOwn(tool, 'handler')));
});

test('HTTP subagent delegation binds the selected session and parent execution identity', async (t) => {
  const calls = [];
  const subagentRuntime = {
    describe: () => ({ enabled: true, toolCount: 4 }),
    async delegate(value, context) {
      calls.push({ value: structuredClone(value), context });
      context.emit({
        type: 'subagent.run.planned',
        runId: 'subagent-http-001',
        parentRunId: context.runId,
        parentToolRunId: context.toolRunId,
      });
      return {
        schemaVersion: 1,
        type: 'subagent.run.receipt',
        receipt: {
          runId: 'subagent-http-001',
          parentRunId: context.runId,
          parentToolRunId: context.toolRunId,
          conversationId: context.reference.conversationId,
          status: 'completed',
        },
        results: [],
      };
    },
  };
  const { baseUrl, job } = await fixture(t, { subagentRuntime });
  const created = await createConversation(baseUrl, job.id);
  const conversationId = created.conversation.conversationId;
  const response = await fetch(`${baseUrl}/api/copilot/conversations/${conversationId}/subagent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      objective: 'Delegate a focused evidence task.',
      aiSessionId: 'ai-http-001',
      parentRunId: 'parent-http-run-001',
      parentToolRunId: 'parent-http-tool-001',
    }),
  });
  assert.equal(response.status, 200);
  const delegated = await response.json();
  assert.equal(delegated.receipt.status, 'completed');
  assert.equal(delegated.receipt.conversationId, conversationId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.objective, 'Delegate a focused evidence task.');
  assert.equal(calls[0].context.reference.conversationId, conversationId);
  assert.equal(calls[0].context.conversation.conversationId, conversationId);
  assert.equal(calls[0].context.aiSessionId, 'ai-http-001');
  assert.equal(calls[0].context.runId, 'parent-http-run-001');
  assert.equal(calls[0].context.toolRunId, 'parent-http-tool-001');
  assert.equal(calls[0].context.agentDepth, 0);

  const events = await (await fetch(`${baseUrl}/api/copilot/conversations/${conversationId}/events?format=json`)).json();
  const planned = events.events.find((event) => event.type === 'subagent.run.planned');
  assert.equal(planned.runId, 'subagent-http-001');
  assert.equal(planned.parentRunId, 'parent-http-run-001');
  assert.equal(planned.parentToolRunId, 'parent-http-tool-001');
  assert.equal(planned.conversationId, conversationId);
});

test('HTTP outbound MCP management supports create, list, refresh, update, and delete', async (t) => {
  const { baseUrl } = await fixture(t);
  const rejectedResponse = await fetch(`${baseUrl}/api/copilot/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: 'cross-site-compatible-body' }),
  });
  assert.equal(rejectedResponse.status, 415);
  assert.equal((await rejectedResponse.json()).error.code, 'COPILOT_CONTENT_TYPE_UNSUPPORTED');

  const createdResponse = await fetch(`${baseUrl}/api/copilot/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'remote-tools',
      label: 'Remote Tools',
      connect: true,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/mcp',
      headerEnv: { Authorization: 'MCP_AUTH_HEADER' },
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.server.id, 'remote-tools');
  assert.equal(created.server.status, 'disconnected');
  assert.equal(created.tools.length, 0);

  const listed = await (await fetch(`${baseUrl}/api/copilot/mcp/servers`)).json();
  assert.equal(listed.servers.length, 1);
  assert.deepEqual(listed.servers[0].headerEnv, { Authorization: 'MCP_AUTH_HEADER' });

  const refreshedResponse = await fetch(`${baseUrl}/api/copilot/mcp/servers/remote-tools/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(refreshedResponse.status, 200);
  assert.equal((await refreshedResponse.json()).tools.length, 1);

  const updatedResponse = await fetch(`${baseUrl}/api/copilot/mcp/servers/remote-tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Remote Tools Disabled',
      enabled: false,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/mcp',
    }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).server.status, 'disconnected');

  const capabilities = await (await fetch(`${baseUrl}/api/copilot/capabilities`)).json();
  assert.equal(capabilities.localRuntime.exec, true);
  assert.equal(capabilities.localRuntime.filesystem, true);
  assert.equal(capabilities.localRuntime.http, true);
  assert.equal(capabilities.outboundMcp.initialized, true);

  const removedResponse = await fetch(`${baseUrl}/api/copilot/mcp/servers/remote-tools`, { method: 'DELETE' });
  assert.equal(removedResponse.status, 200);
  assert.equal((await removedResponse.json()).removed, true);
  assert.equal((await (await fetch(`${baseUrl}/api/copilot/mcp/servers`)).json()).servers.length, 0);
});

test('production snapshot excludes symbolic-link directories outside the task output root', async (t) => {
  const { baseUrl, job, productionStore } = await fixture(t, { production: true });
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-external-'));
  t.after(() => rm(externalDir, { recursive: true, force: true }));
  await writeFile(path.join(externalDir, 'escaped.json'), '{"outside":true}', 'utf8');
  try {
    await symlink(externalDir, path.join(job.outputDir, 'linked-output'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`Directory links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }

  await createConversation(baseUrl, job.id);
  const snapshot = productionStore.getSnapshot(job.id, `job-r${job.revision}`);
  assert.ok(snapshot);
  assert.equal(
    snapshot.manifest.artifacts.some((artifact) => artifact.relativePath.startsWith('linked-output/')),
    false,
  );
});

test('stable artifact hashing rejects a deterministic replacement after the file handle opens', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-toctou-'));
  const filePath = path.join(root, 'mutable.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(filePath, '{"version":1}', 'utf8');

  await assert.rejects(
    hashStableFile(filePath, {
      beforeRead: async () => writeFile(filePath, '{"version":2,"replaced":true}', 'utf8'),
    }),
    (error) => error?.code === 'COPILOT_ARTIFACT_CHANGED' && error?.status === 409,
  );
});

test('HTTP workbench executes read-only tools and dependency graphs with usage accounting', async (t) => {
  const { baseUrl } = await fixture(t);
  const rows = [
    { segment: 'A', score: 12 },
    { segment: 'B', score: 18 },
  ];

  const profileResponse = await fetch(`${baseUrl}/api/copilot/workbench/tools/dataset.profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal(profile.output.rowCount, 2);
  assert.equal(profile.output.columns.find((column) => column.name === 'score').mean, 15);

  const graphResponse = await fetch(`${baseUrl}/api/copilot/workbench/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tasks: [
        { id: 'profile', toolName: 'dataset.profile', input: { rows } },
        {
          id: 'chart',
          toolName: 'chart.create',
          dependsOn: ['profile'],
          input: { rows, type: 'bar', x: 'segment', y: 'score', title: 'Scores' },
        },
      ],
    }),
  });
  assert.equal(graphResponse.status, 200);
  const graph = await graphResponse.json();
  assert.deepEqual(graph.graph.tasks.map((task) => task.status), ['completed', 'completed']);
  assert.equal(graph.outputs.chart.kind, 'chart');
  assert.deepEqual(graph.events.map((event) => event.type), [
    'task.started',
    'task.completed',
    'task.started',
    'task.completed',
  ]);

  const deniedResponse = await fetch(`${baseUrl}/api/copilot/workbench/tools/sql.query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, sql: 'DELETE FROM data', table: 'data' }),
  });
  assert.equal(deniedResponse.status, 400);
  assert.equal((await deniedResponse.json()).error.code, 'SANDBOX_SQL_READ_ONLY');

  const usageResponse = await fetch(`${baseUrl}/api/copilot/usage`);
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.records, 2);
  assert.equal(usage.toolCalls, 3);
});

test('HTTP schema v2 persists agent runs and manages idempotent context pins', async (t) => {
  const { baseUrl, job } = await fixture(t, { production: true });
  const capabilities = await (await fetch(`${baseUrl}/api/copilot/capabilities`)).json();
  assert.equal(capabilities.schemaVersion, 2);
  assert.equal(capabilities.orchestration.persistentRuns, true);
  const { conversation } = await createConversation(baseUrl, job.id);
  const conversationId = conversation.conversationId;
  const rows = [
    { segment: 'A', score: 12 },
    { segment: 'B', score: 18 },
  ];

  const runResponse = await fetch(`${baseUrl}/api/copilot/workbench/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: 'agent-run-http-001',
      turnId: 'agent-turn-http-001',
      conversationId,
      goal: 'Profile and chart the current rows.',
      tasks: [
        { id: 'profile', toolName: 'dataset.profile', input: { rows } },
        {
          id: 'chart',
          toolName: 'chart.create',
          dependsOn: ['profile'],
          input: { rows, type: 'bar', x: 'segment', y: 'score', title: 'Scores' },
        },
      ],
    }),
  });
  assert.equal(runResponse.status, 200);
  const executed = await runResponse.json();
  assert.equal(executed.schemaVersion, 2);
  assert.equal(executed.run.status, 'completed');
  assert.deepEqual(executed.nodes.map((node) => node.status), ['completed', 'completed']);
  assert.deepEqual(executed.nodes.map((node) => node.attemptCount), [1, 1]);

  const stateResponse = await fetch(
    `${baseUrl}/api/copilot/conversations/${conversationId}/runs/agent-run-http-001`,
  );
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.run.conversationId, conversationId);
  assert.equal(state.planRevisions.length, 1);
  assert.equal(state.attempts.length, 2);

  const pinEndpoint = `${baseUrl}/api/copilot/conversations/${conversationId}/context-pins`;
  const pinResponse = await fetch(pinEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemType: 'source', itemId: 'note-http-001', value: { label: 'Growth role' } }),
  });
  assert.equal(pinResponse.status, 201);
  const firstPin = (await pinResponse.json()).pin;

  const updatedPinResponse = await fetch(pinEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemType: 'source', itemId: 'note-http-001', value: { label: 'Priority role' } }),
  });
  const updatedPin = (await updatedPinResponse.json()).pin;
  assert.equal(updatedPin.pinId, firstPin.pinId);
  assert.equal(updatedPin.value.label, 'Priority role');

  const pins = await (await fetch(pinEndpoint)).json();
  assert.equal(pins.schemaVersion, 2);
  assert.equal(pins.pins.length, 1);
  const removed = await fetch(`${pinEndpoint}/${firstPin.pinId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
});

test('global agent-run controls are unavailable and conversation routes enforce run ownership', async (t) => {
  const { baseUrl, job } = await fixture(t, { production: true });
  const first = await createConversation(baseUrl, job.id);
  const firstConversationId = first.conversation.conversationId;
  const second = await createConversation(baseUrl, job.id, {
    idempotencyKey: 'conversation-http-create-002',
  });
  const secondConversationId = second.conversation.conversationId;
  const runResponse = await fetch(`${baseUrl}/api/copilot/workbench/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: 'agent-run-owner-001',
      turnId: 'agent-turn-owner-001',
      conversationId: firstConversationId,
      goal: 'Create an ownership-bound run.',
      tasks: [{ id: 'profile', toolName: 'dataset.profile', input: { rows: [{ score: 1 }] } }],
    }),
  });
  assert.equal(runResponse.status, 200);

  const unscoped = await fetch(`${baseUrl}/api/copilot/agent-runs/agent-run-owner-001`);
  assert.equal(unscoped.status, 404);
  assert.equal((await unscoped.json()).error.code, 'COPILOT_ROUTE_NOT_FOUND');
  for (const action of ['pause', 'resume', 'cancel', 'steer']) {
    const response = await fetch(`${baseUrl}/api/copilot/agent-runs/agent-run-owner-001/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404, action);
    assert.equal((await response.json()).error.code, 'COPILOT_ROUTE_NOT_FOUND', action);
  }

  const wrongRunPath = `${baseUrl}/api/copilot/conversations/${secondConversationId}/runs/agent-run-owner-001`;
  const wrongState = await fetch(wrongRunPath);
  assert.equal(wrongState.status, 409);
  assert.equal((await wrongState.json()).error.code, 'COPILOT_RUN_CONTEXT_MISMATCH');

  for (const action of ['pause', 'resume', 'cancel', 'steer']) {
    const response = await fetch(`${wrongRunPath}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'steer' ? { tasks: [{ id: 'replacement', toolName: 'dataset.profile', input: { rows: [] } }] } : {}),
    });
    assert.equal(response.status, 409, action);
    assert.equal((await response.json()).error.code, 'COPILOT_RUN_CONTEXT_MISMATCH', action);
  }
});

test('HTTP production routes expose snapshot migration, verified artifacts, traces, and golden evaluations', async (t) => {
  const { baseUrl, job } = await fixture(t, { production: true });
  const created = await createConversation(baseUrl, job.id);
  const conversationId = created.conversation.conversationId;

  const snapshots = await (await fetch(`${baseUrl}/api/copilot/snapshots?jobId=${job.id}`)).json();
  assert.equal(snapshots.snapshots[0].snapshotId, 'job-r3');

  const artifactResponse = await fetch(`${baseUrl}/api/copilot/conversations/${conversationId}/artifacts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'json', name: 'result.json', data: { status: 'verified' } }),
  });
  assert.equal(artifactResponse.status, 201);
  const artifact = await artifactResponse.json();
  assert.equal(artifact.verification.passed, true);
  assert.equal((await fetch(`${baseUrl}/api/copilot/conversations/${conversationId}/artifacts/${artifact.artifact.artifactId}`)).status, 200);

  job.revision = 4;
  job.discoveredCount = 8;
  const upgradeResponse = await fetch(`${baseUrl}/api/copilot/conversations/${conversationId}/snapshot/upgrade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ copyMessages: false }),
  });
  assert.equal(upgradeResponse.status, 201);
  const upgrade = await upgradeResponse.json();
  assert.equal(upgrade.conversation.snapshotId, 'job-r4');
  const diffResponse = await fetch(`${baseUrl}/api/copilot/snapshots/diff?jobId=${job.id}&from=job-r3&to=job-r4`);
  assert.equal(diffResponse.status, 200);
  assert.equal((await diffResponse.json()).changed, true);

  const evaluationResponse = await fetch(`${baseUrl}/api/copilot/evaluations/golden`, { method: 'POST' });
  assert.equal(evaluationResponse.status, 201);
  assert.equal((await evaluationResponse.json()).summary.passed, 30);
  const evaluations = await (await fetch(`${baseUrl}/api/copilot/evaluations`)).json();
  assert.equal(evaluations.evaluations.length, 1);
  const traces = await (await fetch(`${baseUrl}/api/copilot/traces?conversationId=${conversationId}`)).json();
  assert.ok(traces.traces.some((trace) => trace.operation === 'artifact.create:json'));
});

test('HTTP context catalog lists real task records with counts, search, and stable selectable IDs', async (t) => {
  const { baseUrl, job } = await fixture(t);
  const jobsResponse = await fetch(`${baseUrl}/api/copilot/context/jobs?query=growth&offset=0&limit=25`);
  assert.equal(jobsResponse.status, 200);
  const jobs = await jobsResponse.json();
  assert.equal(jobs.total, 1);
  assert.deepEqual(jobs.items[0].counts, { posts: 2, comments: 1, users: 1, artifacts: 3 });
  assert.equal(jobs.items[0].snapshotId, 'job-r3');

  const summaryResponse = await fetch(`${baseUrl}/api/copilot/context?jobId=${job.id}&mode=application`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.counts.posts, 2);
  assert.equal(summary.counts.comments, 1);
  assert.equal(summary.counts.users, 1);
  assert.ok(summary.counts.artifacts >= 1);

  const recordsResponse = await fetch(
    `${baseUrl}/api/copilot/context?jobId=${job.id}&mode=application&kind=posts&query=${encodeURIComponent('Growth')}&offset=0&limit=25`,
  );
  assert.equal(recordsResponse.status, 200);
  const records = await recordsResponse.json();
  assert.equal(records.total, 1);
  assert.equal(records.items[0].recordId, 'note-http-001');
  assert.match(records.items[0].sourceId, /^xhs-context:\/\/jobs\/job-http-001\/posts\//u);
  assert.ok(records.items[0].sections.some((section) => section.label === '正文'));
  assert.equal(records.items[0].body, 'Own product growth and user research.');
});

test('multipart uploads and generated artifacts stay scoped to their conversation', async (t) => {
  const { baseUrl, job, service, artifacts } = await fixture(t);
  const { conversation } = await createConversation(baseUrl, job.id);
  const form = new FormData();
  form.set('idempotencyKey', 'attachment-http-upload-001');
  form.set('file', new Blob(['name,score\nA,10\n'], { type: 'text/csv' }), 'scores.csv');
  const upload = await fetch(`${baseUrl}/api/copilot/conversations/${conversation.conversationId}/attachments`, {
    method: 'POST', body: form,
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.attachment.format, 'csv');
  const attachmentDownload = await fetch(
    `${baseUrl}/api/copilot/conversations/${conversation.conversationId}/attachments/${uploaded.attachment.attachmentId}`,
  );
  assert.equal(attachmentDownload.status, 200);
  assert.match(attachmentDownload.headers.get('content-disposition'), /scores\.csv/u);
  assert.match(await attachmentDownload.text(), /name,score/u);

  const details = await service.getConversation(conversation.conversationId);
  const reference = {
    conversationId: conversation.conversationId,
    jobId: conversation.jobId,
    snapshotId: conversation.snapshotId,
    mode: conversation.mode,
    scope: conversation.scope,
  };
  const artifact = await artifacts.createArtifact(reference, {
    format: 'csv', name: 'report.csv', data: [{ name: 'A', score: 10 }],
    idempotencyKey: 'artifact-http-create-001',
  });
  assert.equal(details.attachments.length, 1);
  const download = await fetch(
    `${baseUrl}/api/copilot/conversations/${conversation.conversationId}/artifacts/${artifact.artifact.artifactId}`,
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /report\.csv/u);
  assert.match(await download.text(), /name,score/u);
});

test('SSE emits a ready frame and resumes buffered events after Last-Event-ID', async (t) => {
  const { baseUrl, job, service } = await fixture(t);
  const { conversation } = await createConversation(baseUrl, job.id);
  service.emit(conversation.conversationId, { type: 'tool.started', name: 'records.query' });

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/copilot/conversations/${conversation.conversationId}/events`, {
    headers: { 'Last-Event-ID': '2' }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, { stream: true });
  }
  service.emit(conversation.conversationId, { type: 'tool.result', rows: 2 });
  while (!text.includes('event: tool.result')) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.match(text, /event: tool\.result/u);
  assert.doesNotMatch(text, /event: tool\.started/u);
  assert.match(text, /event: ready/u);
});

test('MCP JSON-RPC transport exposes only bound xhs-data resources and policy-checked tools', async (t) => {
  const { baseUrl, job } = await fixture(t);
  const { conversation } = await createConversation(baseUrl, job.id);
  const endpoint = `${baseUrl}/api/copilot/conversations/${conversation.conversationId}/mcp`;
  const call = async (body) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const initialized = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
  const applicationResource = listed.result.resources.find((item) => item.name === 'applications');
  assert.equal(applicationResource.uri, `xhs-data://jobs/${job.id}/applications`);
  assert.equal(listed.result.resources.every((item) => item.uri.startsWith('xhs-data://')), true);

  const read = await call({
    jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: applicationResource.uri },
  });
  const payload = JSON.parse(read.result.contents[0].text);
  assert.equal(payload.rows[0].title, 'Growth role');

  const denied = await call({
    jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'file:///etc/passwd' },
  });
  assert.equal(denied.error.data.code, 'COPILOT_RESOURCE_DENIED');

  const tools = await call({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  assert.equal(tools.result.tools.some((tool) => tool.name === 'records.query'), true);
  const queried = await call({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'records.query', arguments: { dataset: 'applications', limit: 10 } },
  });
  assert.equal(queried.result.isError, false);
  assert.equal(queried.result.structuredContent.rows[0].noteId, 'note-http-001');

  const sendBlocked = await call({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'email.send', arguments: { to: 'target@example.test', subject: 'Test', text: 'Body' } },
  });
  assert.equal(sendBlocked.result.isError, true);
  assert.equal(sendBlocked.result.structuredContent.error.code, 'COPILOT_APPROVAL_REQUIRED');

  job.revision = 4;
  const staleRead = await call({
    jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: applicationResource.uri },
  });
  assert.equal(staleRead.error.data.code, 'COPILOT_SNAPSHOT_STALE');
  const staleTool = await call({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'records.query', arguments: { dataset: 'applications', limit: 10 } },
  });
  assert.equal(staleTool.result.isError, true);
  assert.equal(staleTool.result.structuredContent.error.code, 'COPILOT_SNAPSHOT_STALE');
});

test('HTTP errors are structured and unrelated paths remain unhandled', async (t) => {
  const { baseUrl } = await fixture(t);
  const invalid = await fetch(`${baseUrl}/api/copilot/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'COPILOT_JSON_INVALID');

  const unrelated = await fetch(`${baseUrl}/api/health`);
  assert.equal(unrelated.status, 404);
  assert.equal(await unrelated.text(), 'not found');
});
