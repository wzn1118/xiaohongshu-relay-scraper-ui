import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { createModelTurnLedger } from './copilot/model-turn-ledger.mjs';
import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { createRuntimeV3Repository } from './copilot/runtime-v3/index.mjs';
import { DataCopilotRuntime } from './data-copilot-runtime.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { SubagentRuntime } from './copilot/subagent-runtime.mjs';

const REFERENCE = Object.freeze({
  conversationId: 'conversation-broker-integration',
  jobId: 'job-broker-integration',
  snapshotId: 'snapshot-broker-integration',
  mode: 'analyze',
  scope: { allowedScopes: ['applications'], contextSourceIds: [] },
});

test('main runtime executes through an injected ModelRunBroker and keeps the legacy transport unused', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'model-broker-runtime-'));
  const productionStore = createCopilotProductionStore({ rootDir });
  const runtimeV3Repository = createRuntimeV3Repository({ store: productionStore });
  const modelTurnLedger = createModelTurnLedger({ repository: runtimeV3Repository });
  t.after(async () => {
    runtimeV3Repository.close();
    productionStore.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const store = new DataCopilotStore({ rootDir });
  const approvals = new CopilotApprovalStore({ rootDir });
  await store.createConversation({
    ...REFERENCE,
    title: 'Broker integration',
    filters: {},
    selectedModel: { provider: 'test-provider', model: 'test-model', wireApi: 'chat_completions' },
    idempotencyKey: 'broker-integration-conversation',
  });
  const events = [];
  const calls = [];
  const broker = {
    async runTurn(input) {
      calls.push(input);
      input.onEvent({ type: 'assistant.delta', delta: 'broker answer' });
      return {
        text: 'broker answer',
        calls: [],
        rawAssistant: { role: 'assistant', content: 'broker answer' },
        responseId: 'broker-response-main',
        usage: { inputTokens: 2, outputTokens: 2 },
        durationMs: 1,
      };
    },
  };
  const runtime = new DataCopilotRuntime({
    store,
    approvals,
    registry: { list: () => [], get: () => null, execute: async () => ({}) },
    aiSessions: { resolve: () => ({ provider: 'test-provider', model: 'test-model', wireApi: 'chat_completions', apiKey: 'secret' }) },
    fetchImpl: async () => { throw new Error('legacy fetch must not be called'); },
    modelRunBroker: broker,
    modelTurnLedger,
    emit: (_reference, event) => events.push(event),
    idFactory: (() => { let index = 0; return () => `broker-main-${++index}`; })(),
  });

  const started = await runtime.start(REFERENCE, {
    content: 'Use the injected model broker.',
    aiSessionId: 'session-broker-main',
    idempotencyKey: 'broker-main-message',
  });
  const completed = await waitForConversation(store, REFERENCE, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session.apiKey, 'secret');
  assert.ok(Array.isArray(calls[0].toolDefinitions));
  assert.ok(events.some((event) => event.type === 'assistant.delta' && event.delta === 'broker answer'));
  assert.equal(completed.runState.lastRunId, started.runId);
  const durableExecution = runtimeV3Repository.listExecutions({ limit: 20 })
    .find((item) => item.metadata?.ledger === 'model_turn');
  assert.ok(durableExecution);
  assert.equal(durableExecution.status, 'succeeded');
  const durableSteps = runtimeV3Repository.listExecutionSteps({ executionId: durableExecution.executionId });
  assert.equal(durableSteps.length, 1);
  assert.equal(durableSteps[0].kind, 'model.turn');
  assert.equal(durableSteps[0].status, 'succeeded');
  const durableEvents = runtimeV3Repository.listEvents({ streamId: `execution:${durableExecution.executionId}` });
  assert.ok(durableEvents.some((event) => event.type === 'model.turn.completed'));
  assert.equal(JSON.stringify({ durableExecution, durableSteps, durableEvents }).includes('broker answer'), false);
});

test('subagent runtime delegates through the same broker while preserving its event projection', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'model-broker-subagent-'));
  const store = createCopilotProductionStore({ rootDir });
  t.after(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const events = [];
  const calls = [];
  const broker = {
    async runTurn(input) {
      calls.push(input);
      input.onEvent({ type: 'assistant.delta', delta: 'child broker answer' });
      return {
        text: 'child broker answer',
        calls: [],
        rawAssistant: { role: 'assistant', content: 'child broker answer' },
        responseId: 'broker-response-child',
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    },
  };
  const runtime = new SubagentRuntime({
    productionStore: store,
    registryProvider: () => ({
      list: () => [{
        name: 'records.query',
        description: 'Read records.',
        risk: 'read',
        idempotent: true,
        parallelSafe: true,
        inputSchema: { type: 'object', additionalProperties: true },
      }],
      execute: async () => ({ type: 'records.result', rows: [] }),
    }),
    aiSessions: { resolve: () => ({ provider: 'test-provider', model: 'test-model', wireApi: 'chat_completions', apiKey: 'secret' }) },
    modelCaller: async () => { throw new Error('legacy model caller must not be called'); },
    modelRunBroker: broker,
    idFactory: (() => { let index = 0; return () => `broker-child-${++index}`; })(),
  });

  const result = await runtime.execute('agent.delegate', {
    objective: 'Produce one broker-backed specialist result.',
    tasks: [{ id: 'broker-child-task', title: 'Broker child', objective: 'Return a short result.', role: 'analyst', maxSteps: 1 }],
    aiSessionId: 'session-broker-child',
    maxSteps: 1,
  }, {
    reference: REFERENCE,
    conversation: { ...REFERENCE, filters: {} },
    contextSourceIds: [],
    runId: 'parent-broker-run',
    toolRunId: 'parent-broker-tool',
    aiSessionId: 'session-broker-child',
    emit: (event) => events.push(event),
  });

  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.results[0].text, 'child broker answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionContext.taskId, 'broker-child-task');
  assert.ok(events.some((event) => event.type === 'subagent.output.delta' && event.delta === 'child broker answer'));
});

async function waitForConversation(store, reference, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conversation = await store.getConversation(reference);
    if (conversation?.status === expected) return conversation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const conversation = await store.getConversation(reference);
  assert.fail(`Timed out waiting for ${expected}; status=${conversation?.status}; error=${conversation?.runState?.errorCode || ''}.`);
}
