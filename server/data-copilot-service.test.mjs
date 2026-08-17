import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { CopilotArtifactService } from './copilot-artifact-service.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { DataPolicyEngine } from './data-policy-engine.mjs';

const JOB = Object.freeze({
  id: 'job-copilot-001',
  revision: 7,
  keyword: 'product operations',
  outputDir: 'unused',
});

class FakeRuntime {
  constructor(store) {
    this.store = store;
    this.emit = () => {};
    this.starts = [];
    this.cancels = [];
    this.retries = [];
    this.continued = [];
  }

  async start(reference, value) {
    this.starts.push({ reference, value });
    await this.store.appendRun(reference, {
      runId: 'run-start-001', status: 'queued', event: 'queued', attempt: 1,
      metadata: { requestKey: value.idempotencyKey },
      idempotencyKey: `${value.idempotencyKey}:queued`,
    });
    return { runId: 'run-start-001', duplicate: false, conversation: await this.store.getConversation(reference) };
  }

  async cancel(reference, value) {
    this.cancels.push({ reference, value });
    return { cancelled: true, conversation: await this.store.getConversation(reference) };
  }

  async retry(reference, value) {
    this.retries.push({ reference, value });
    return { runId: 'run-retry-001', conversation: await this.store.getConversation(reference) };
  }

  async continueApproval(reference, approval, value) {
    this.continued.push({ reference, approval, value });
    return { runId: approval.runId, conversation: await this.store.getConversation(reference) };
  }

  setModelRunBroker(broker) {
    this.modelRunBroker = broker;
  }
}

async function fixture(t, { runCoordinator = null, modelRunBroker = null, subagentRuntime = null } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-service-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const job = { ...JOB };
  const manager = {
    getInternal: (id) => id === JOB.id ? job : null,
    get: (id) => id === JOB.id ? job : null,
    list: () => [job],
  };
  const store = new DataCopilotStore({ rootDir });
  const approvals = new CopilotApprovalStore({ rootDir });
  const artifacts = new CopilotArtifactService({ rootDir });
  const runtime = new FakeRuntime(store);
  const aiSessions = {
    resolve(id) {
      if (id === 'ai-session-001') {
        return { id, provider: 'openai_compatible', model: 'model-a', wireApi: 'responses', apiKey: 'secret' };
      }
      if (id === 'ai-session-chat-001') {
        return { id, provider: 'openai_compatible', model: 'model-b', wireApi: 'chat_completions', apiKey: 'secret' };
      }
      throw Object.assign(new Error('expired'), { code: 'AI_SESSION_EXPIRED', status: 401 });
    },
  };
  const policy = new DataPolicyEngine({ manager });
  const service = new DataCopilotService({
    rootDir, store, approvals, artifacts, runtime, policy, manager, aiSessions, runCoordinator, modelRunBroker, subagentRuntime,
  });
  await service.initialize();
  return { rootDir, job, manager, store, approvals, artifacts, runtime, aiSessions, policy, service };
}

test('explicit ModelRunBroker is assembled into primary and subagent runtimes', async (t) => {
  let subagentBroker = null;
  const broker = {
    runTurn: async () => ({}),
    retrieve: async () => ({}),
    cancel: async () => ({}),
  };
  const { runtime, service } = await fixture(t, {
    modelRunBroker: broker,
    subagentRuntime: { setModelRunBroker: (value) => { subagentBroker = value; } },
  });

  assert.equal(runtime.modelRunBroker, broker);
  assert.equal(subagentBroker, broker);
  const capabilities = service.getCapabilities().modelGateway;
  assert.equal(capabilities.implementation, 'model-run-broker-v1');
  assert.equal(capabilities.statefulResponses, true);
  assert.equal(capabilities.backgroundLifecycle, true);
});

async function create(service, overrides = {}) {
  return service.createConversation({
    jobId: JOB.id,
    mode: 'application',
    aiSessionId: 'ai-session-001',
    idempotencyKey: 'conversation-service-create-001',
    ...overrides,
  });
}

test('conversation creation is idempotent, model-safe, and persisted under data/copilot', async (t) => {
  const { rootDir, service } = await fixture(t);
  const first = await create(service);
  const second = await create(service);

  assert.equal(first.conversation.conversationId, second.conversation.conversationId);
  assert.equal(first.conversation.snapshotId, 'job-r7');
  assert.deepEqual(first.conversation.selectedModel, {
    aiSessionId: 'ai-session-001', provider: 'openai_compatible', model: 'model-a', wireApi: 'responses',
  });
  assert.equal(JSON.stringify(first).includes('secret'), false);
  const persisted = JSON.parse(await readFile(
    path.join(rootDir, 'copilot', first.conversation.conversationId, 'conversation.json'),
    'utf8',
  ));
  assert.equal(persisted.jobId, JOB.id);
  assert.deepEqual(persisted.scope.allowedScopes, ['*']);

  const listed = await service.listConversations({ jobId: JOB.id });
  assert.equal(listed.total, 1);
  assert.equal(listed.conversations[0].conversationId, first.conversation.conversationId);
});

test('reasoning effort is a persisted model setting reused by send and retry', async (t) => {
  const { service, runtime } = await fixture(t);
  const created = await create(service, {
    idempotencyKey: 'conversation-reasoning-001',
    selectedModel: { reasoningEffort: 'high' },
  });
  const conversationId = created.conversation.conversationId;

  assert.equal(created.conversation.selectedModel.aiSessionId, 'ai-session-001');
  assert.equal(created.conversation.selectedModel.reasoningEffort, 'high');

  const updated = await service.updateConversation(conversationId, {
    selectedModel: { reasoningEffort: 'max' },
  });
  assert.equal(updated.conversation.selectedModel.reasoningEffort, 'max');

  await service.sendMessage(conversationId, {
    content: 'Inspect the workspace and continue.',
    workspaceMode: 'build',
    idempotencyKey: 'reasoning-message-001',
  });
  assert.equal(runtime.starts.at(-1).value.aiSessionId, 'ai-session-001');
  assert.equal(runtime.starts.at(-1).value.reasoningEffort, 'max');

  await service.retry(conversationId, { idempotencyKey: 'reasoning-retry-001' });
  assert.equal(runtime.retries.at(-1).value.aiSessionId, 'ai-session-001');
  assert.equal(runtime.retries.at(-1).value.reasoningEffort, 'max');

  const unsupported = await create(service, {
    aiSessionId: 'ai-session-chat-001',
    idempotencyKey: 'conversation-reasoning-chat-001',
    selectedModel: { reasoningEffort: 'high' },
  });
  assert.equal(unsupported.conversation.selectedModel.wireApi, 'chat_completions');
  assert.equal('reasoningEffort' in unsupported.conversation.selectedModel, false);
});

test('workbench run controls require an explicit owning conversation', async (t) => {
  let ownerConversationId = '';
  const runId = 'service-owned-run-001';
  const coordinator = {
    getState(id) {
      return id === runId
        ? { run: { runId, conversationId: ownerConversationId, status: 'paused' }, nodes: [], attempts: [] }
        : { run: null, nodes: [], attempts: [] };
    },
    pause: () => true,
    cancel: () => true,
    resume: async () => ({ run: { runId, conversationId: ownerConversationId, status: 'completed' } }),
    steer: async () => ({ run: { runId, conversationId: ownerConversationId, status: 'completed' } }),
  };
  const { service } = await fixture(t, { runCoordinator: coordinator });
  const owner = await create(service);
  ownerConversationId = owner.conversation.conversationId;
  const other = await create(service, { idempotencyKey: 'conversation-service-create-002' });
  const otherConversationId = other.conversation.conversationId;

  for (const operation of [
    () => service.getWorkbenchRun(runId),
    () => service.pauseWorkbenchRun(runId),
    () => service.cancelWorkbenchRun(runId),
  ]) {
    assert.throws(operation, (error) => error?.code === 'COPILOT_ID_INVALID');
  }
  await assert.rejects(
    service.resumeWorkbenchRun(runId),
    (error) => error?.code === 'COPILOT_ID_INVALID',
  );
  await assert.rejects(
    service.steerWorkbenchRun(runId),
    (error) => error?.code === 'COPILOT_ID_INVALID',
  );

  for (const operation of [
    () => service.getWorkbenchRun(runId, otherConversationId),
    () => service.pauseWorkbenchRun(runId, otherConversationId),
    () => service.cancelWorkbenchRun(runId, otherConversationId),
  ]) {
    assert.throws(operation, (error) => error?.code === 'COPILOT_RUN_CONTEXT_MISMATCH' && error?.status === 409);
  }
  await assert.rejects(
    service.resumeWorkbenchRun(runId, otherConversationId),
    (error) => error?.code === 'COPILOT_RUN_CONTEXT_MISMATCH' && error?.status === 409,
  );
  await assert.rejects(
    service.steerWorkbenchRun(runId, otherConversationId),
    (error) => error?.code === 'COPILOT_RUN_CONTEXT_MISMATCH' && error?.status === 409,
  );
});

test('historical post context normalizes legacy image schemas without stringifying objects', async (t) => {
  const { service, runtime } = await fixture(t);
  runtime.registry = {
    async execute(name) {
      assert.equal(name, 'records.query');
      return {
        total: 1,
        rows: [{
          note_id: 'legacy-note-001',
          title: 'Legacy post',
          media: {
            image_list: [{ info_list: [{ url: 'https://img.example.test/legacy-a.webp' }] }],
            coverUrl: '//img.example.test/legacy-cover.webp',
          },
          images: [{ originalUrl: 'https://img.example.test/legacy-b.webp' }],
          image_urls: ['https://img.example.test/legacy-c.webp'],
          cover_url: { src: 'https://img.example.test/legacy-d.webp' },
          cardCoverUrl: { urlDefault: 'https://img.example.test/legacy-e.webp' },
          imageUrl: { unsupported: 'must-not-be-stringified' },
        }],
      };
    },
  };

  const result = await service.listContextRecords({
    jobId: JOB.id,
    mode: 'application',
    kind: 'posts',
    limit: 25,
  });

  assert.equal(result.total, 1);
  assert.deepEqual(result.items[0].images, [
    'https://img.example.test/legacy-a.webp',
    'https://img.example.test/legacy-b.webp',
    'https://img.example.test/legacy-c.webp',
    'https://img.example.test/legacy-cover.webp',
    'https://img.example.test/legacy-d.webp',
    'https://img.example.test/legacy-e.webp',
  ]);
  assert.equal(result.items[0].imageUrl, 'https://img.example.test/legacy-a.webp');
  assert.equal(JSON.stringify(result.items[0]).includes('[object Object]'), false);
});

test('snapshot identity is server-derived and stale conversations cannot execute against newer task data', async (t) => {
  const { service, job, runtime } = await fixture(t);
  await assert.rejects(
    create(service, { snapshotId: 'job-r6' }),
    (error) => error?.code === 'COPILOT_SNAPSHOT_MISMATCH' && error?.status === 409,
  );

  const { conversation } = await create(service);
  job.revision = 8;
  const historical = await service.getConversation(conversation.conversationId);
  assert.equal(historical.conversation.snapshotId, 'job-r7');
  await assert.rejects(
    service.sendMessage(conversation.conversationId, {
      content: 'Read the updated task data.',
      idempotencyKey: 'message-stale-snapshot-001',
    }),
    (error) => error?.code === 'COPILOT_SNAPSHOT_STALE' && error?.status === 409,
  );
  assert.equal(runtime.starts.length, 0);
});

test('message dispatch resolves attachment metadata and binds only public model fields', async (t) => {
  const { service, artifacts, runtime } = await fixture(t);
  const { conversation } = await create(service);
  const reference = {
    conversationId: conversation.conversationId,
    jobId: conversation.jobId,
    snapshotId: conversation.snapshotId,
    mode: conversation.mode,
    scope: conversation.scope,
  };
  const attachment = await artifacts.createAttachment(reference, {
    file: {
      originalName: 'targets.csv',
      clientMediaType: 'text/csv',
      buffer: Buffer.from('name,score\nA,1\n', 'utf8'),
    },
    idempotencyKey: 'attachment-service-001',
  });

  const result = await service.sendMessage(conversation.conversationId, {
    content: 'Filter the uploaded targets.',
    attachmentIds: [attachment.attachment.attachmentId],
    contextSourceIds: ['application-001', 'application-001'],
    aiSessionId: 'ai-session-001',
    idempotencyKey: 'message-service-send-001',
  });
  assert.equal(result.runId, 'run-start-001');
  assert.equal(runtime.starts.length, 1);
  assert.equal(runtime.starts[0].value.attachments[0].sha256, attachment.attachment.sha256);
  assert.equal(Object.hasOwn(runtime.starts[0].value.attachments[0], 'absolutePath'), false);
  assert.deepEqual(runtime.starts[0].value.contextSourceIds, ['application-001']);
});

test('concurrent message retries with one idempotency key produce one runtime start', async (t) => {
  const { service, runtime } = await fixture(t);
  const { conversation } = await create(service);
  const request = {
    content: 'Compare the collected records.',
    aiSessionId: 'ai-session-001',
    idempotencyKey: 'message-concurrent-service-001',
  };
  const [first, second] = await Promise.all([
    service.sendMessage(conversation.conversationId, request),
    service.sendMessage(conversation.conversationId, request),
  ]);
  assert.equal(runtime.starts.length, 1);
  assert.equal(first.runId, second.runId);
  assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true]);
});

test('approval decisions continue an approved run or cancel a rejected run', async (t) => {
  const { service, approvals, runtime } = await fixture(t);
  const { conversation } = await create(service);
  const reference = {
    conversationId: conversation.conversationId,
    jobId: conversation.jobId,
    snapshotId: conversation.snapshotId,
    mode: conversation.mode,
    scope: conversation.scope,
  };
  const approvedRequest = await approvals.createApproval(reference, {
    approvalId: 'approval-001', runId: 'run-approval-001', toolRunId: 'tool-approval-001',
    toolName: 'email.send', summary: 'Send the prepared email.', arguments: { to: 'a@example.test' },
    idempotencyKey: 'approval-service-create-001',
  });
  const approved = await service.confirmApproval(conversation.conversationId, approvedRequest.approvalId, {
    approved: true, idempotencyKey: 'approval-service-confirm-001',
  });
  assert.equal(approved.approval.status, 'approved');
  assert.equal(runtime.continued.length, 1);

  const rejectedRequest = await approvals.createApproval(reference, {
    approvalId: 'approval-002', runId: 'run-approval-002', toolRunId: 'tool-approval-002',
    toolName: 'email.send', summary: 'Send another email.', arguments: { to: 'b@example.test' },
    idempotencyKey: 'approval-service-create-002',
  });
  const rejected = await service.confirmApproval(conversation.conversationId, rejectedRequest.approvalId, {
    approved: false, idempotencyKey: 'approval-service-reject-001',
  });
  assert.equal(rejected.approval.status, 'rejected');
  assert.equal(runtime.cancels.length, 1);
});

test('runtime events are buffered and replayed from an event cursor', async (t) => {
  const { service, runtime } = await fixture(t);
  const { conversation } = await create(service);
  runtime.emit({ conversationId: conversation.conversationId }, { type: 'tool.started', name: 'records.query' });
  runtime.emit({ conversationId: conversation.conversationId }, { type: 'tool.result', rows: 2 });

  const received = [];
  const unsubscribe = service.subscribe(conversation.conversationId, (event) => received.push(event), { afterEventId: 2 });
  unsubscribe();
  assert.deepEqual(received.map((event) => event.type), ['tool.result']);
  assert.equal(received[0].eventId, 3);
});

test('event IDs and replay buffers survive service restart without swallowing an advanced cursor', async (t) => {
  const context = await fixture(t);
  const { conversation } = await create(context.service);
  context.runtime.emit({ conversationId: conversation.conversationId }, { type: 'tool.started', name: 'records.query' });
  context.runtime.emit({ conversationId: conversation.conversationId }, { type: 'tool.result', rows: 2 });

  const persistedEvents = (await readFile(
    path.join(context.rootDir, 'copilot', conversation.conversationId, 'events.jsonl'),
    'utf8',
  )).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(persistedEvents.map((event) => event.eventId), [1, 2, 3]);

  const restartedRuntime = new FakeRuntime(context.store);
  const restarted = new DataCopilotService({
    rootDir: context.rootDir,
    store: context.store,
    approvals: context.approvals,
    artifacts: context.artifacts,
    runtime: restartedRuntime,
    policy: context.policy,
    manager: context.manager,
    aiSessions: context.aiSessions,
  });
  await restarted.initialize();

  const resumed = [];
  const unsubscribe = restarted.subscribe(conversation.conversationId, (event) => resumed.push(event), { afterEventId: 3 });
  restartedRuntime.emit({ conversationId: conversation.conversationId }, { type: 'run.completed' });
  unsubscribe();
  assert.deepEqual(resumed.map((event) => event.eventId), [4]);

  const resetReplay = [];
  const stopReplay = restarted.subscribe(conversation.conversationId, (event) => resetReplay.push(event), { afterEventId: 999 });
  stopReplay();
  assert.deepEqual(resetReplay.map((event) => event.eventId), [1, 2, 3, 4]);
});

test('durable event logs retain history beyond the memory window and report replay gaps', async (t) => {
  const context = await fixture(t);
  const { conversation } = await create(context.service);
  for (let index = 0; index < 260; index += 1) {
    context.service.emit(conversation.conversationId, { type: 'message.delta', delta: String(index) });
  }

  const received = [];
  const unsubscribe = context.service.subscribe(conversation.conversationId, (event) => received.push(event), { afterEventId: 1 });
  unsubscribe();
  assert.equal(received[0].type, 'stream.gap');
  assert.deepEqual(received[0].payload, { from: 2, to: 11, recovery: 'GET ?format=json&afterSeq=<cursor>' });
  assert.equal(received.at(-1).eventId, 261);

  const coldReplay = [];
  const stopColdReplay = context.service.subscribe(
    conversation.conversationId,
    (event) => coldReplay.push(event),
    { afterEventId: 0 },
  );
  stopColdReplay();
  assert.equal(coldReplay[0].type, 'stream.gap');
  assert.deepEqual(coldReplay[0].payload, { from: 1, to: 11, recovery: 'GET ?format=json&afterSeq=<cursor>' });

  const firstPage = await context.service.listEvents(conversation.conversationId, { afterSeq: 0, limit: 200 });
  const secondPage = await context.service.listEvents(conversation.conversationId, { afterSeq: firstPage.nextSeq, limit: 200 });
  assert.deepEqual(
    [firstPage.events.length, firstPage.nextSeq, firstPage.lastSeq, firstPage.hasMore],
    [200, 200, 261, true],
  );
  assert.deepEqual(
    [secondPage.events.length, secondPage.nextSeq, secondPage.lastSeq, secondPage.hasMore],
    [61, 261, 261, false],
  );

  const eventFile = path.join(context.rootDir, 'copilot', conversation.conversationId, 'events.jsonl');
  assert.equal((await readFile(eventFile, 'utf8')).trim().split(/\r?\n/u).length, 261);
  const restarted = new DataCopilotService({
    rootDir: context.rootDir,
    store: context.store,
    approvals: context.approvals,
    artifacts: context.artifacts,
    runtime: new FakeRuntime(context.store),
    policy: context.policy,
    manager: context.manager,
    aiSessions: context.aiSessions,
  });
  await restarted.initialize();
  assert.equal((await readFile(eventFile, 'utf8')).trim().split(/\r?\n/u).length, 261);
  const restartedPage = await restarted.listEvents(conversation.conversationId, { afterSeq: 200, limit: 200 });
  assert.deepEqual(
    [restartedPage.events.length, restartedPage.nextSeq, restartedPage.lastSeq, restartedPage.hasMore],
    [61, 261, 261, false],
  );
});

test('initialization marks an active persisted run interrupted without creating a new conversation', async (t) => {
  const context = await fixture(t);
  const { conversation } = await create(context.service);
  const reference = {
    conversationId: conversation.conversationId,
    jobId: conversation.jobId,
    snapshotId: conversation.snapshotId,
    mode: conversation.mode,
    scope: conversation.scope,
  };
  await context.store.appendRun(reference, {
    runId: 'run-before-restart', status: 'running', event: 'running', attempt: 1,
    checkpoint: { step: 2 }, idempotencyKey: 'run-before-restart-001',
  });
  const restarted = new DataCopilotService({
    rootDir: context.rootDir,
    store: context.store,
    approvals: context.approvals,
    artifacts: context.artifacts,
    runtime: new FakeRuntime(context.store),
    policy: context.policy,
    manager: context.manager,
    aiSessions: context.aiSessions,
  });
  const initialized = await restarted.initialize();
  assert.equal(initialized.conversations, 1);
  assert.equal(initialized.interrupted, 1);
  const current = await restarted.getConversation(conversation.conversationId);
  assert.equal(current.conversation.status, 'resumable');
  assert.equal(current.conversation.runState.resumable, true);
});
