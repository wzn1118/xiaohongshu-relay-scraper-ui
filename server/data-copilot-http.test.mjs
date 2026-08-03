import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { CopilotArtifactService } from './copilot-artifact-service.mjs';
import { handleDataCopilotRequest } from './data-copilot-http.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { DataPolicyEngine } from './data-policy-engine.mjs';
import { DataToolRegistry } from './data-tool-registry.mjs';
import { McpDataAdapter } from './mcp-data-adapter.mjs';

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-http-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
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
  const service = new DataCopilotService({
    rootDir, store, approvals, artifacts, runtime, policy, mcpAdapter, manager, aiSessions,
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, job, service, artifacts };
}

async function createConversation(baseUrl, jobId) {
  const response = await fetch(`${baseUrl}/api/copilot/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      mode: 'application',
      aiSessionId: 'ai-http-001',
      idempotencyKey: 'conversation-http-create-001',
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
