import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { DataCopilotRuntime } from './data-copilot-runtime.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';

const REFERENCE = Object.freeze({
  conversationId: 'conversation-runtime-001',
  jobId: 'job-runtime-001',
  snapshotId: 'snapshot-runtime-001',
  mode: 'application',
  scope: {
    allowedScopes: ['applications', 'artifacts', 'email'],
    contextSourceIds: ['xhs-data://jobs/job-runtime-001/applications'],
  },
});

const EMAIL = Object.freeze({
  to: 'talent@example.test',
  subject: 'Data analyst application',
  text: 'Please find the selected applications attached.',
  attachmentIds: ['artifact-runtime-001'],
});

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'records.query',
    description: 'Query application records in the bound snapshot.',
    inputSchema: { type: 'object', properties: { dataset: { type: 'string' } }, required: ['dataset'], additionalProperties: false },
    risk: 'read',
  },
  {
    name: 'email.prepare',
    description: 'Prepare and preview an email.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risk: 'write',
  },
  {
    name: 'email.send',
    description: 'Send an approved email.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risk: 'approval_required',
  },
]);

async function fixture(t, { fetchImpl, definitions = TOOL_DEFINITIONS, executeTool = null, sessionOverrides = {} } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'data-copilot-runtime-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let generated = 0;
  const store = new DataCopilotStore({ rootDir, idFactory: () => `store-${++generated}` });
  const approvals = new CopilotApprovalStore({ rootDir, idFactory: () => `approval-${++generated}` });
  await store.createConversation({
    ...REFERENCE,
    title: 'Runtime contract',
    filters: {},
    selectedModel: { provider: 'openai_compatible', model: 'model-runtime', wireApi: 'chat_completions' },
    idempotencyKey: 'conversation-runtime-create-001',
  });
  const executions = [];
  const registry = {
    list: () => definitions.map((item) => ({ ...item })),
    get: (name) => definitions.find((item) => item.name === name) || null,
    async execute(name, input, context) {
      executions.push({
        name,
        input: structuredClone(input),
        approved: context.approved,
        reference: context.reference,
        runId: context.runId,
        toolRunId: context.toolRunId,
        idempotencyKey: context.idempotencyKey,
        deliveryAttemptId: context.deliveryAttemptId,
      });
      if (executeTool) return executeTool(name, input, context, executions.length);
      if (name === 'records.query') {
        return {
          type: 'table.result',
          columns: ['id', 'city'],
          rows: [{ id: 'application-001', city: 'Shanghai' }],
          total: 1,
          source: 'xhs-data://jobs/job-runtime-001/applications',
        };
      }
      if (name === 'email.prepare') {
        context.state.emailPreview = structuredClone(input);
        return { type: 'email.draft', ...input };
      }
      if (name === 'email.send') {
        assert.equal(context.approved, true);
        return { type: 'email.sent', messageId: 'smtp-message-runtime-001', ...input };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  const events = [];
  const runtime = new DataCopilotRuntime({
    store,
    approvals,
    registry,
    aiSessions: {
      resolve(id) {
        assert.equal(id, 'ai-session-runtime-001');
        return {
          id,
          provider: 'openai_compatible',
          model: 'model-runtime',
          wireApi: 'chat_completions',
          baseUrl: 'http://provider.example.test/v1',
          apiKey: 'secret-runtime',
          ...sessionOverrides,
        };
      },
    },
    fetchImpl,
    emit: (_reference, event) => events.push(event),
    idFactory: () => `runtime-${++generated}`,
  });
  return { rootDir, store, approvals, runtime, executions, events };
}

function chatTool(name, input, id = `call-${name.replaceAll('.', '-')}`) {
  return chatResponse({
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: `copilot_${name.replaceAll('.', '__')}`, arguments: JSON.stringify(input) },
    }],
  });
}

function chatTools(calls) {
  return chatResponse({
    content: null,
    tool_calls: calls.map(({ name, input, id }) => ({
      id,
      type: 'function',
      function: { name: `copilot_${name.replaceAll('.', '__')}`, arguments: JSON.stringify(input) },
    })),
  });
}

function chatText(content) {
  return chatResponse({ content });
}

function chatResponse(message) {
  return {
    ok: true,
    status: 200,
    async json() { return { choices: [{ message }] }; },
  };
}

function queuedFetch(responses, requests = []) {
  return async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const response = responses.shift();
    assert.ok(response, 'Unexpected provider request.');
    return response;
  };
}

async function waitForConversation(store, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conversation = await store.getConversation(REFERENCE);
    if ((Array.isArray(expected) ? expected : [expected]).includes(conversation.status)) return conversation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const conversation = await store.getConversation(REFERENCE);
  assert.fail(`Timed out waiting for ${expected}; current status is ${conversation.status}; code=${conversation.runState?.errorCode || ''}; message=${conversation.runState?.errorMessage || ''}.`);
}

async function waitForEvent(events, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = events.filter(predicate);
    if (matches.length) return matches.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for runtime event; received: ${events.map((event) => event.type).join(', ')}.`);
}

test('relay sessions prefer the versioned completion endpoint when configured with a host root', async (t) => {
  const urls = [];
  const { store, runtime, events } = await fixture(t, {
    sessionOverrides: { provider: 'relay', baseUrl: 'https://relay.example' },
    fetchImpl: async (url) => {
      urls.push(url);
      return chatText('Relay endpoint is ready.');
    },
  });

  await runtime.start(REFERENCE, {
    content: 'Check the relay endpoint.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-relay-v1-001',
  });
  const terminal = await waitForEvent(events, (event) => ['run.completed', 'run.failed'].includes(event.type));
  assert.equal(terminal.type, 'run.completed', JSON.stringify(terminal.error || {}));
  assert.deepEqual(urls, ['https://relay.example/v1/chat/completions']);
});

test('relay sessions fall back to a root-only completion endpoint', async (t) => {
  const urls = [];
  const { runtime, events } = await fixture(t, {
    sessionOverrides: { provider: 'relay', baseUrl: 'https://relay.example' },
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/v1/')) return { ok: false, status: 404, async json() { return {}; } };
      return chatText('Root endpoint is ready.');
    },
  });

  await runtime.start(REFERENCE, {
    content: 'Check the root-only relay endpoint.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-relay-root-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.deepEqual(urls, [
    'https://relay.example/v1/chat/completions',
    'https://relay.example/chat/completions',
  ]);
});

test('optional tool schemas omit strict mode while strict-compatible schemas retain it', async (t) => {
  let request;
  const { runtime, events } = await fixture(t, {
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return chatText('Schema compatibility checked.');
    },
  });

  await runtime.start(REFERENCE, {
    content: 'Check tool schema compatibility.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-tool-schema-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal(request.tools[0].function.strict, true);
  assert.equal(Object.hasOwn(request.tools[1].function, 'strict'), false);
});

test('tool results, selected sources, and model metadata persist across conversation turns', async (t) => {
  const requests = [];
  const fetchImpl = queuedFetch([
    chatTool('records.query', { dataset: 'applications' }, 'call-query-001'),
    chatText('Found one application in Shanghai.'),
    chatText('The refined result still contains one application.'),
  ], requests);
  const { store, runtime, executions, events } = await fixture(t, { fetchImpl });

  await runtime.start(REFERENCE, {
    content: 'Find Shanghai applications.',
    contextSourceIds: ['application-001', 'application-001'],
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-query-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].reference, REFERENCE);
  assert.match(executions[0].runId, /^runtime-/u);
  assert.match(executions[0].toolRunId, /^tool-/u);
  assert.deepEqual((await store.listMessages(REFERENCE))[0].metadata.contextSourceIds, ['application-001']);
  assert.match(JSON.stringify(requests[1].messages), /application-001/u);

  await runtime.start(REFERENCE, {
    content: 'Only keep records with a complete city.',
    contextSourceIds: ['application-001'],
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-followup-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed'
    && events.filter((item) => item.type === 'run.completed').length >= 2);
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');

  const secondTurnHistory = JSON.stringify(requests[2].messages);
  assert.match(secondTurnHistory, /Recorded result from records\.query/u);
  assert.match(secondTurnHistory, /Shanghai/u);
  assert.match(secondTurnHistory, /Selected context sources: application-001/u);
  const runs = await store.listRuns(REFERENCE, { limit: 100 });
  const modelRounds = runs.filter((run) => run.event === 'model_round_completed');
  assert.equal(modelRounds.length, 3);
  assert.ok(modelRounds.every((run) => run.metadata.provider === 'openai_compatible'));
  assert.ok(modelRounds.every((run) => run.metadata.model === 'model-runtime'));
  assert.ok(modelRounds.every((run) => Number.isInteger(run.metadata.durationMs)));
  assert.ok(events.some((event) => event.type === 'table.result'));
  assert.ok(events.some((event) => event.type === 'run.completed'));
});

test('email send pauses for exact approval and resumes without losing the prepared preview', async (t) => {
  const fetchImpl = queuedFetch([
    chatTool('email.prepare', EMAIL, 'call-email-prepare-001'),
    chatTool('email.send', EMAIL, 'call-email-send-001'),
    chatText('The approved email was sent.'),
  ]);
  const { store, approvals, runtime, executions, events } = await fixture(t, { fetchImpl });

  const started = await runtime.start(REFERENCE, {
    content: 'Prepare and send the application email.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-001',
  });
  await waitForEvent(events, (event) => event.type === 'approval.required');
  const waiting = await store.getConversation(REFERENCE);
  assert.equal(waiting.status, 'waiting_approval');
  const pending = await approvals.listApprovals(REFERENCE, { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].runId, started.runId);
  assert.deepEqual(pending[0].arguments, EMAIL);
  assert.deepEqual(waiting.runState.checkpoint.emailPreview, EMAIL);

  const approved = await approvals.approve(REFERENCE, pending[0].approvalId, {
    actor: 'user',
    reason: 'preview_confirmed',
    idempotencyKey: 'approval-runtime-email-001',
  });
  await runtime.continueApproval(REFERENCE, approved, { idempotencyKey: 'approval-runtime-continue-001' });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');

  assert.deepEqual(executions.map((item) => item.name), ['email.prepare', 'email.prepare', 'email.send']);
  assert.equal(executions[2].approved, true);
  assert.equal((await approvals.getApproval(REFERENCE, pending[0].approvalId)).status, 'consumed');
  assert.ok((await store.listMessages(REFERENCE)).some((message) => message.content.type === 'email.sent'));
});

test('email.send cannot request approval before an identical email preview exists', async (t) => {
  const fetchImpl = queuedFetch([chatTool('email.send', EMAIL, 'call-email-send-direct-001')]);
  const { store, approvals, runtime, executions, events } = await fixture(t, { fetchImpl });
  await runtime.start(REFERENCE, {
    content: 'Send this email immediately.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-direct-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.failed');
  const failed = await store.getConversation(REFERENCE);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.runState.errorCode, 'COPILOT_EMAIL_PREVIEW_REQUIRED');
  assert.equal((await approvals.listApprovals(REFERENCE, { status: 'pending' })).length, 0);
  assert.equal(executions.length, 0);
});

test('stop keeps a checkpoint and retry continues the same conversation in a new run', async (t) => {
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    if (calls > 1) return chatText('Continued from the saved checkpoint.');
    providerStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')), { once: true });
    });
  };
  const { store, runtime, events } = await fixture(t, { fetchImpl });
  const first = await runtime.start(REFERENCE, {
    content: 'Run a long analysis.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-stop-001',
  });
  await started;
  await runtime.cancel(REFERENCE, { idempotencyKey: 'message-runtime-cancel-001' });
  await waitForEvent(events, (event) => event.type === 'run.paused');
  const cancelled = await store.getConversation(REFERENCE);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.runState.resumable, true);
  assert.equal(cancelled.runState.checkpoint.runId, first.runId);
  assert.ok(Array.isArray(cancelled.runState.checkpoint.modelMessages));

  const retried = await runtime.retry(REFERENCE, {
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-retry-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');
  assert.notEqual(retried.runId, first.runId);
  assert.equal((await store.getConversation(REFERENCE)).conversationId, REFERENCE.conversationId);
  assert.equal(calls, 2);
});

test('cancel is serialized with start and never downgrades a completed conversation', async (t) => {
  const { store, runtime, events } = await fixture(t, { fetchImpl: queuedFetch([chatText('Already complete.')]) });
  await runtime.start(REFERENCE, {
    content: 'Complete this request.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-complete-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');

  const cancellation = await runtime.cancel(REFERENCE, { idempotencyKey: 'message-runtime-cancel-complete-001' });
  assert.equal(cancellation.cancelled, false);
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');
  assert.equal((await store.listRuns(REFERENCE)).some((run) => run.status === 'cancelled'), false);
});

test('cancel racing a persisted model round fences the final completed write', async (t) => {
  const { store, runtime, events } = await fixture(t, { fetchImpl: queuedFetch([chatText('Must not commit after cancellation.')]) });
  const appendRun = store.appendRun.bind(store);
  let enterBarrier;
  let releaseBarrier;
  const barrierEntered = new Promise((resolve) => { enterBarrier = resolve; });
  const barrierRelease = new Promise((resolve) => { releaseBarrier = resolve; });
  store.appendRun = async (reference, value) => {
    const result = await appendRun(reference, value);
    if (value.event === 'model_round_completed') {
      enterBarrier();
      await barrierRelease;
    }
    return result;
  };
  await runtime.start(REFERENCE, {
    content: 'Cancel while the completed model round is returning.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-cancel-race-001',
  });
  await barrierEntered;
  const cancellation = runtime.cancel(REFERENCE, { idempotencyKey: 'message-runtime-cancel-race-request-001' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseBarrier();
  const cancelled = await cancellation;
  assert.equal(cancelled.cancelled, true);
  await waitForEvent(events, (event) => event.type === 'run.paused');
  const finalConversation = await waitForConversation(store, 'cancelled');
  assert.equal(finalConversation.status, 'cancelled');
  assert.equal(events.some((event) => event.type === 'run.completed'), false);
  assert.equal((await store.listRuns(REFERENCE, { limit: 100 })).some((item) => item.status === 'completed'), false);
});

test('retry resumes the first incomplete tool and does not repeat completed query or artifact work', async (t) => {
  const definitions = [
    ...TOOL_DEFINITIONS,
    {
      name: 'artifact.create',
      description: 'Create an export artifact.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      risk: 'write',
    },
  ];
  let queryAttempts = 0;
  const fetchImpl = queuedFetch([
    chatTools([
      { name: 'artifact.create', input: { name: 'resume.csv' }, id: 'call-artifact-resume-001' },
      { name: 'records.query', input: { dataset: 'applications' }, id: 'call-query-resume-001' },
    ]),
    chatText('Recovered without rebuilding the artifact.'),
  ]);
  const { store, runtime, executions, events } = await fixture(t, {
    fetchImpl,
    definitions,
    executeTool: async (name) => {
      if (name === 'artifact.create') return { type: 'artifact.ready', artifactId: 'artifact-resume-001' };
      if (name === 'records.query') {
        queryAttempts += 1;
        if (queryAttempts === 1) throw Object.assign(new Error('temporary query failure'), { code: 'QUERY_TEMPORARY' });
        return { type: 'table.result', rows: [{ id: 'application-001' }], total: 1 };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  });
  await runtime.start(REFERENCE, {
    content: 'Create an artifact and query the source.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-tool-resume-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.failed');
  const failed = await store.getConversation(REFERENCE);
  assert.equal(failed.runState.checkpoint.pendingTools.tools[0].status, 'succeeded');
  assert.equal(failed.runState.checkpoint.pendingTools.tools[1].status, 'failed');

  await runtime.retry(REFERENCE, {
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-tool-retry-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal(executions.filter((item) => item.name === 'artifact.create').length, 1);
  assert.equal(executions.filter((item) => item.name === 'records.query').length, 2);
  const queryKeys = executions.filter((item) => item.name === 'records.query').map((item) => item.idempotencyKey);
  assert.equal(new Set(queryKeys).size, 1);
  assert.equal((await store.listToolRuns(REFERENCE)).filter((item) => item.toolName === 'artifact.create' && item.status === 'succeeded').length, 1);
});

test('unknown SMTP outcome pauses for a new approval and never resends under the old approval', async (t) => {
  let sends = 0;
  const fetchImpl = queuedFetch([
    chatTool('email.prepare', EMAIL, 'call-email-prepare-unknown-001'),
    chatTool('email.send', EMAIL, 'call-email-send-unknown-001'),
    chatText('The explicitly reapproved delivery completed.'),
  ]);
  const { store, approvals, runtime, executions, events } = await fixture(t, {
    fetchImpl,
    executeTool: async (name, input, context) => {
      if (name === 'email.prepare') {
        context.state.emailPreview = structuredClone(input);
        return { type: 'email.draft', preview: structuredClone(input) };
      }
      if (name === 'email.send') {
        sends += 1;
        if (sends === 1) {
          const error = Object.assign(new Error('SMTP accepted the request but the local receipt was lost.'), {
            code: 'SMTP_CONNECTION_TIMEOUT',
            deliveryStatus: 'unknown',
            safeToRetry: false,
          });
          throw error;
        }
        return { type: 'email.sent', messageId: 'smtp-message-runtime-reapproved-001' };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  });
  await runtime.start(REFERENCE, {
    content: 'Prepare and send this email.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-unknown-001',
  });
  await waitForEvent(events, (event) => event.type === 'approval.required' && !event.reason);
  const firstPending = (await approvals.listApprovals(REFERENCE, { status: 'pending' }))[0];
  const firstApproved = await approvals.approve(REFERENCE, firstPending.approvalId, {
    actor: 'user',
    reason: 'initial_send',
    idempotencyKey: 'approval-runtime-email-unknown-first-001',
  });
  await runtime.continueApproval(REFERENCE, firstApproved, { idempotencyKey: 'approval-runtime-email-unknown-continue-001' });
  await waitForEvent(events, (event) => event.type === 'approval.required' && event.reason === 'delivery_outcome_unknown');
  assert.equal((await store.getConversation(REFERENCE)).status, 'waiting_input');
  assert.equal(sends, 1);
  assert.equal((await approvals.getApproval(REFERENCE, firstPending.approvalId)).status, 'cancelled');
  await assert.rejects(
    runtime.continueApproval(REFERENCE, firstApproved, { idempotencyKey: 'approval-runtime-email-old-reuse-001' }),
    (error) => error.code === 'COPILOT_APPROVAL_NOT_APPROVED',
  );
  assert.equal(sends, 1);

  const secondPending = (await approvals.listApprovals(REFERENCE, { status: 'pending' }))[0];
  assert.ok(secondPending);
  assert.notEqual(secondPending.approvalId, firstPending.approvalId);
  const secondApproved = await approvals.approve(REFERENCE, secondPending.approvalId, {
    actor: 'user',
    reason: 'explicit_redelivery',
    idempotencyKey: 'approval-runtime-email-unknown-second-001',
  });
  await runtime.continueApproval(REFERENCE, secondApproved, { idempotencyKey: 'approval-runtime-email-redelivery-001' });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal(sends, 2);
  assert.equal((await approvals.getApproval(REFERENCE, secondPending.approvalId)).status, 'consumed');
  const sendExecutions = executions.filter((item) => item.name === 'email.send');
  assert.equal(new Set(sendExecutions.map((item) => item.idempotencyKey)).size, 2);
  assert.equal(new Set(sendExecutions.map((item) => item.deliveryAttemptId)).size, 2);
  assert.ok((await store.listToolRuns(REFERENCE)).some((item) => item.status === 'outcome_unknown'));
});

test('approval binds every delivery field and blocks changed attachment bytes before SMTP', async (t) => {
  const email = {
    ...EMAIL,
    cc: ['cc@example.test'],
    bcc: ['audit@example.test'],
    replyTo: 'reply@example.test',
    deliveryMethod: 'smtp',
    deliverySource: 'configured_smtp',
    jobRecordSource: 'xhs-data://jobs/job-runtime-001/applications',
    qualityScore: 91,
  };
  let artifactSha256 = 'a'.repeat(64);
  let sends = 0;
  const fetchImpl = queuedFetch([
    chatTool('email.prepare', email, 'call-email-prepare-fingerprint-001'),
    chatTool('email.send', email, 'call-email-send-fingerprint-001'),
  ]);
  const { store, approvals, runtime, events } = await fixture(t, {
    fetchImpl,
    executeTool: async (name, input, context) => {
      if (name === 'email.prepare') {
        const preview = {
          ...structuredClone(input),
          attachments: [{ artifactId: input.attachmentIds[0], sha256: artifactSha256, size: 4096 }],
        };
        context.state.emailPreview = preview;
        return { type: 'email.draft', preview };
      }
      if (name === 'email.send') {
        sends += 1;
        return { type: 'email.sent', messageId: 'must-not-send' };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  });
  await runtime.start(REFERENCE, {
    content: 'Prepare the exact delivery and send it after approval.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-fingerprint-001',
  });
  await waitForEvent(events, (event) => event.type === 'approval.required');
  const pending = (await approvals.listApprovals(REFERENCE, { status: 'pending' }))[0];
  assert.deepEqual(pending.arguments.cc, email.cc);
  assert.deepEqual(pending.arguments.bcc, email.bcc);
  assert.equal(pending.arguments.replyTo, email.replyTo);
  assert.equal(pending.arguments.deliveryMethod, email.deliveryMethod);
  assert.equal(pending.arguments.deliverySource, email.deliverySource);
  assert.equal(pending.arguments.jobRecordSource, email.jobRecordSource);
  assert.equal(pending.arguments.qualityScore, email.qualityScore);
  assert.deepEqual(pending.arguments.attachments, [{
    artifactId: EMAIL.attachmentIds[0],
    sha256: 'a'.repeat(64),
    size: 4096,
  }]);

  const approved = await approvals.approve(REFERENCE, pending.approvalId, {
    actor: 'user',
    reason: 'fingerprint_confirmed',
    idempotencyKey: 'approval-runtime-email-fingerprint-001',
  });
  artifactSha256 = 'b'.repeat(64);
  await runtime.continueApproval(REFERENCE, approved, { idempotencyKey: 'approval-runtime-email-fingerprint-continue-001' });
  const failed = await waitForConversation(store, 'failed');
  assert.equal(failed.runState.errorCode, 'COPILOT_EMAIL_APPROVAL_STALE');
  assert.equal(sends, 0);
  assert.equal((await approvals.getApproval(REFERENCE, pending.approvalId)).status, 'approved');
});

test('retry reconciles a consumed approval from the exact durable receipt without sending twice', async (t) => {
  let sends = 0;
  const fetchImpl = queuedFetch([
    chatTool('email.prepare', EMAIL, 'call-email-prepare-consumed-001'),
    chatTool('email.send', EMAIL, 'call-email-send-consumed-001'),
    chatText('Recovered the persisted delivery receipt.'),
  ]);
  const { store, approvals, runtime, executions, events } = await fixture(t, {
    fetchImpl,
    executeTool: async (name, input, context) => {
      if (name === 'email.prepare') {
        context.state.emailPreview = structuredClone(input);
        return { type: 'email.draft', preview: structuredClone(input) };
      }
      if (name === 'email.send') {
        sends += 1;
        return { type: 'email.sent', messageId: 'smtp-message-runtime-consumed-001' };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
  });
  await runtime.start(REFERENCE, {
    content: 'Send once and recover from a crash after approval consumption.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-consumed-001',
  });
  await waitForEvent(events, (event) => event.type === 'approval.required');
  const pending = (await approvals.listApprovals(REFERENCE, { status: 'pending' }))[0];
  const approved = await approvals.approve(REFERENCE, pending.approvalId, {
    actor: 'user',
    reason: 'send_once',
    idempotencyKey: 'approval-runtime-email-consumed-001',
  });

  const appendRun = store.appendRun.bind(store);
  let crashWindow = true;
  store.appendRun = async (reference, value) => {
    if (crashWindow && (value.metadata?.boundary === 'approval_completed' || value.event === 'failed')) {
      throw new Error('Injected process loss after approval consumption.');
    }
    return appendRun(reference, value);
  };
  await runtime.continueApproval(REFERENCE, approved, { idempotencyKey: 'approval-runtime-email-consumed-continue-001' });
  await waitForEvent(events, (event) => event.type === 'run.failed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  crashWindow = false;

  assert.equal(sends, 1);
  assert.equal((await approvals.getApproval(REFERENCE, pending.approvalId)).status, 'consumed');
  const interrupted = await store.getConversation(REFERENCE);
  assert.ok(interrupted.runState.checkpoint.pendingApproval);

  await runtime.retry(REFERENCE, {
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-email-consumed-retry-001',
  });
  await waitForEvent(events, (event) => event.type === 'run.completed');
  assert.equal((await store.getConversation(REFERENCE)).status, 'completed');
  assert.equal(sends, 1);
  assert.equal(executions.filter((item) => item.name === 'email.send').length, 1);
  assert.ok((await store.listRuns(REFERENCE, { limit: 100 })).some((item) => item.metadata?.boundary === 'approval_recovered'));
});

test('verifier repairs an unsupported data answer before completing the same run', async (t) => {
  const requests = [];
  const fetchImpl = queuedFetch([
    chatText('There is one Shanghai application.'),
    chatTool('records.query', { dataset: 'applications' }, 'call-verifier-query-001'),
    chatText('There is one Shanghai application from the bound task data.'),
  ], requests);
  const { store, runtime, events, executions } = await fixture(t, { fetchImpl });

  const started = await runtime.start(REFERENCE, {
    content: 'Find Shanghai applications in the current task data.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-verifier-001',
  });
  const completed = await waitForConversation(store, 'completed');

  assert.equal(requests.length, 3);
  assert.equal(executions.filter((item) => item.name === 'records.query').length, 1);
  assert.ok(events.some((event) => event.type === 'verification.failed'));
  assert.ok(events.some((event) => event.type === 'verification.passed'));
  assert.equal(completed.runState.lastRunId, started.runId);
});

test('independent read tools execute in parallel inside one durable batch', async (t) => {
  const definitions = [
    { name: 'check.alpha', description: 'Alpha check.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read', parallelSafe: true },
    { name: 'check.beta', description: 'Beta check.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read', parallelSafe: true },
  ];
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = queuedFetch([
    chatTools([
      { name: 'check.alpha', input: {}, id: 'call-check-alpha-001' },
      { name: 'check.beta', input: {}, id: 'call-check-beta-001' },
    ]),
    chatText('Both checks completed.'),
  ]);
  const { store, runtime } = await fixture(t, {
    fetchImpl,
    definitions,
    executeTool: async (name) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      // Keep the execution window wider than a loaded Windows filesystem's
      // durable preflight so the assertion measures tool work, not disk speed.
      await new Promise((resolve) => setTimeout(resolve, 500));
      active -= 1;
      return { type: 'check.result', name, ok: true };
    },
  });

  await runtime.start(REFERENCE, {
    content: 'Run both independent checks.',
    aiSessionId: 'ai-session-runtime-001',
    idempotencyKey: 'message-runtime-parallel-001',
  });
  await waitForConversation(store, 'completed');
  assert.equal(maximumActive, 2);
});
