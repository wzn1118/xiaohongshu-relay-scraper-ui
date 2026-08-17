import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { SubagentRuntime } from './copilot/subagent-runtime.mjs';

const CONVERSATION_ID = 'conversation-subagent-lifecycle';
const OTHER_CONVERSATION_ID = 'conversation-subagent-other';
const AI_SESSION_A = 'session-lifecycle-a';
const AI_SESSION_B = 'session-lifecycle-b';
const AI_SESSION_C = 'session-lifecycle-c';
const PARENT_RUN_ID = 'parent-run-lifecycle-001';
const PARENT_TOOL_RUN_ID = 'parent-tool-lifecycle-001';

const REFERENCE = Object.freeze({
  conversationId: CONVERSATION_ID,
  jobId: 'job-subagent-lifecycle',
  snapshotId: 'snapshot-subagent-lifecycle',
  mode: 'analyze',
  scope: { allowedScopes: ['applications'], contextSourceIds: [] },
});

test('subagent lifecycle enforces conversation ownership and resumes with the current model session', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'subagent-runtime-lifecycle-'));
  const store = createCopilotProductionStore({ rootDir });
  const events = [];
  const registryCalls = [];
  let modelCalls = 0;
  let modelFailure = true;
  const aiSessions = {
    resolve(id) {
      const sessionId = String(id || '');
      assert.ok([AI_SESSION_A, AI_SESSION_B, AI_SESSION_C].includes(sessionId));
      return {
        id: sessionId,
        provider: 'openai_compatible',
        model: `lifecycle-${sessionId.slice(-1)}`,
        wireApi: 'chat_completions',
        baseUrl: 'https://provider.invalid/v1',
        apiKey: `secret-${sessionId}`,
      };
    },
  };
  const registry = {
    list: () => [
      {
        name: 'records.query',
        title: 'Query records',
        description: 'Read records for evidence.',
        category: 'records',
        source: 'test',
        scopes: [],
        risk: 'read',
        idempotent: true,
        parallelSafe: true,
        inputSchema: { type: 'object', additionalProperties: true },
      },
    ],
    execute: async (name, input, context) => {
      registryCalls.push({ name, input, context });
      return { type: 'records.result', rows: [{ id: 'row-1', secret: 'result-must-stay-out-of-events' }] };
    },
  };
  const runtime = new SubagentRuntime({
    productionStore: store,
    registryProvider: () => registry,
    aiSessions,
    modelCaller: async (_fetch, session, _messages, _tools, _signal, emit) => {
      modelCalls += 1;
      if (session.id === AI_SESSION_A && modelFailure) {
        modelFailure = false;
        const error = new Error('provider failed once');
        error.code = 'MODEL_REQUEST_FAILED';
        throw error;
      }
      assert.ok([AI_SESSION_B, AI_SESSION_C].includes(session.id));
      emit({ type: 'assistant.delta', delta: 'bounded lifecycle output' });
      if (session.id === AI_SESSION_B && modelCalls === 2) {
        return {
          text: '',
          calls: [{ id: 'query-1', wireId: 'query-1', name: 'records.query', input: { secret: 'input-must-stay-out-of-events' } }],
          responseId: 'response-query',
          usage: null,
        };
      }
      return {
        text: session.id === AI_SESSION_C ? 'steered result' : 'resumed result',
        calls: [],
        responseId: `response-${session.id}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const context = parentContext({ events });
  const failed = await runtime.execute(
    'agent.delegate',
    { objective: 'Run one lifecycle task.', tasks: [task('lifecycle-task', { maxSteps: 2 })], aiSessionId: AI_SESSION_A },
    context,
  );
  assert.equal(failed.receipt.status, 'failed');
  assert.equal(failed.error.code, 'MODEL_REQUEST_FAILED');
  const runId = failed.receipt.runId;
  assert.equal(store.getRun(runId).provider, 'openai_compatible');
  assert.equal(store.getRun(runId).model, 'lifecycle-a');

  const status = runtime.status(runId, context);
  assert.equal(status.receipt.status, 'failed');
  assert.throws(() => runtime.status(runId, otherContext()), hasCode('SUBAGENT_RUN_CONTEXT_MISMATCH'));
  assert.throws(() => runtime.cancel(runId, otherContext()), hasCode('SUBAGENT_RUN_CONTEXT_MISMATCH'));
  await assert.rejects(() => runtime.resume(runId, otherContext()), hasCode('SUBAGENT_RUN_CONTEXT_MISMATCH'));
  await assert.rejects(() => runtime.steer(runId, { objective: 'wrong conversation' }, otherContext()), hasCode('SUBAGENT_RUN_CONTEXT_MISMATCH'));

  const resumed = await runtime.resume(runId, { ...context, aiSessionId: AI_SESSION_B });
  assert.equal(resumed.receipt.status, 'completed');
  assert.equal(resumed.results[0].text, 'resumed result');
  assert.equal(store.getRun(runId).model, 'lifecycle-b');
  assert.equal(registryCalls.length, 1);
  assert.equal(registryCalls[0].context.aiSessionId, AI_SESSION_B);
  assert.equal(registryCalls[0].context.parentRunId, PARENT_RUN_ID);
  assert.equal(registryCalls[0].context.parentToolRunId, PARENT_TOOL_RUN_ID);

  const toolEvents = events.filter((event) => String(event.type).startsWith('subagent.tool.'));
  assert.ok(toolEvents.some((event) => event.type === 'subagent.tool.started'));
  for (const event of toolEvents) {
    assert.equal(Object.hasOwn(event, 'input'), false, `${event.type} must not expose tool input`);
    assert.equal(Object.hasOwn(event, 'output'), false, `${event.type} must not expose tool output`);
    assert.equal(Object.hasOwn(event, 'result'), false, `${event.type} must not expose tool result`);
    assert.equal(event.parentRunId, PARENT_RUN_ID);
    assert.equal(event.parentToolRunId, PARENT_TOOL_RUN_ID);
    assert.equal(event.conversationId, CONVERSATION_ID);
  }

  const steered = await runtime.steer(runId, {
    objective: 'Replace the incomplete plan with a focused task.',
    tasks: [task('steered-task', { objective: 'Produce the focused result.', maxSteps: 1 })],
  }, { ...context, aiSessionId: AI_SESSION_C });
  assert.equal(steered.type, 'subagent.run.receipt');
  assert.equal(steered.receipt.status, 'completed');
  assert.equal(steered.receipt.planRevision, 2);
  assert.equal(steered.results.some((result) => result.taskId === 'steered-task'), true);
  assert.equal(store.getRun(runId).model, 'lifecycle-c');
  assert.ok(modelCalls >= 3);
});

function parentContext({ events }) {
  return {
    reference: structuredClone(REFERENCE),
    conversation: { ...structuredClone(REFERENCE), filters: {} },
    contextSourceIds: [],
    runId: PARENT_RUN_ID,
    toolRunId: PARENT_TOOL_RUN_ID,
    aiSessionId: AI_SESSION_A,
    agentDepth: 0,
    emit: (event) => events.push(event),
  };
}

function otherContext() {
  return {
    ...parentContext({ events: [] }),
    reference: { ...structuredClone(REFERENCE), conversationId: OTHER_CONVERSATION_ID },
    conversation: { ...structuredClone(REFERENCE), conversationId: OTHER_CONVERSATION_ID, filters: {} },
  };
}

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    objective: `Complete ${id}.`,
    role: 'analyst',
    allowedTools: ['records.query'],
    maxSteps: 1,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}
