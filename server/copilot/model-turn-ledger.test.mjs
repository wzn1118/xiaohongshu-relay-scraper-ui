import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { createCopilotProductionStore } from './production-store.mjs';
import { createRuntimeV3Repository } from './runtime-v3/index.mjs';
import { createModelTurnLedger } from './model-turn-ledger.mjs';

test('ModelTurnLedger persists redacted model evidence and a completed agent execution', async (t) => {
  const fixture = await createFixture(t);
  const executionContext = modelExecutionContext();
  const session = {
    provider: 'test-provider',
    model: 'reasoning-model',
    wireApi: 'responses',
    reasoningEffort: 'high',
    apiKey: 'provider-secret-key',
  };
  const handle = await fixture.ledger.beginTurn({
    executionContext,
    session,
    round: 1,
    messages: [
      { role: 'system', content: 'private system instruction' },
      { role: 'user', content: 'private user request' },
    ],
    toolDefinitions: [{
      name: 'workspace.read',
      risk: 'read',
      source: 'workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }],
  });
  await fixture.ledger.completeTurn(handle, {
    text: 'private model response',
    responseId: 'response-ledger-1',
    durationMs: 17,
    usage: { inputTokens: 12, outputTokens: 8 },
    calls: [{ id: 'private-call-id', name: 'workspace.read', input: { path: 'private.txt' } }],
  });
  await fixture.ledger.completeExecution(executionContext, {
    steps: 1,
    rounds: 1,
    responseId: 'response-ledger-1',
    durationMs: 17,
  });

  const execution = fixture.repository.getExecution(handle.executionId);
  const steps = fixture.repository.listExecutionSteps({ executionId: handle.executionId });
  const artifacts = fixture.repository.listExecutionArtifacts({ executionId: handle.executionId });
  const events = fixture.repository.listEvents({ streamId: `execution:${handle.executionId}` });
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.kind, 'agent');
  assert.equal(execution.metadata.ledger, 'model_turn');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'model.turn');
  assert.equal(steps[0].status, 'succeeded');
  assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), [
    'model.input.digest',
    'model.output.digest',
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    'agent.execution.started',
    'model.turn.started',
    'model.turn.completed',
    'agent.execution.completed',
  ]);

  const persisted = JSON.stringify({ execution, steps, artifacts, events });
  for (const secret of [
    'provider-secret-key',
    'private system instruction',
    'private user request',
    'private model response',
    'private-call-id',
    'private.txt',
  ]) {
    assert.equal(persisted.includes(secret), false, `ledger persisted secret: ${secret}`);
  }
});

test('ModelTurnLedger records cancellation and resumes the stable root on retry', async (t) => {
  const fixture = await createFixture(t);
  const firstContext = modelExecutionContext({ attempt: 1 });
  const first = await fixture.ledger.beginTurn({
    executionContext: firstContext,
    session: { provider: 'test', model: 'test-model', wireApi: 'chat_completions' },
    messages: [{ role: 'user', content: 'cancel this private request' }],
    round: 1,
  });
  const cancellation = Object.assign(new Error('private cancellation detail'), {
    code: 'COPILOT_RUN_CANCELLED',
  });
  await fixture.ledger.failTurn(first, cancellation);
  await fixture.ledger.failExecution(firstContext, cancellation);

  assert.equal(fixture.repository.getExecution(first.executionId).status, 'cancelled');
  assert.equal(fixture.repository.getExecutionStep(first.stepId).status, 'cancelled');

  const secondContext = modelExecutionContext({ attempt: 2 });
  const second = await fixture.ledger.beginTurn({
    executionContext: secondContext,
    session: { provider: 'test', model: 'test-model', wireApi: 'chat_completions' },
    messages: [{ role: 'user', content: 'retry this private request' }],
    round: 1,
  });
  assert.equal(second.executionId, first.executionId);
  assert.notEqual(second.stepId, first.stepId);
  assert.equal(fixture.repository.getExecution(second.executionId).status, 'running');
  assert.equal(fixture.repository.getExecutionStep(second.stepId).status, 'running');
  assert.ok(fixture.repository.listEvents({ streamId: `execution:${second.executionId}` })
    .some((event) => event.type === 'agent.execution.resumed'));
});

function modelExecutionContext(overrides = {}) {
  return {
    agentKind: 'main',
    conversationId: 'conversation-model-ledger',
    runId: 'legacy-run-model-ledger',
    operationKey: 'operation-model-ledger',
    attempt: 1,
    deadlineAt: '2026-08-17T12:00:00.000Z',
    workspaceMode: 'build',
    workspaceBinding: {
      projectId: 'project-model-ledger',
      workspaceId: 'workspace-model-ledger',
      worktreeId: 'worktree-model-ledger',
      authority: { profile: 'owner_local_full', trustedLocal: true },
    },
    contextManifest: {
      schemaVersion: 1,
      usedTokens: 100,
      remainingTokens: 900,
      includedItems: 2,
      excludedItems: 1,
    },
    ...overrides,
  };
}

async function createFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'model-turn-ledger-'));
  const store = createCopilotProductionStore({ rootDir });
  const repository = createRuntimeV3Repository({ store });
  const ledger = createModelTurnLedger({ repository });
  t.after(async () => {
    repository.close();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, store, repository, ledger };
}
