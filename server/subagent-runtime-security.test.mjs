import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { SubagentRuntime } from './copilot/subagent-runtime.mjs';

const PARENT_RUN_ID = 'parent-run-security-001';
const PARENT_TOOL_RUN_ID = 'parent-tool-run-security-001';
const CONVERSATION_ID = 'conversation-subagent-security';
const AI_SESSION_ID = 'session-reference-001';
const API_KEY = 'sk-subagent-security-must-not-persist';
const SESSION_TOKEN = 'session-token-must-not-persist';

const REFERENCE = Object.freeze({
  conversationId: CONVERSATION_ID,
  jobId: 'job-subagent-security',
  snapshotId: 'snapshot-subagent-security',
  mode: 'analyze',
  scope: {
    allowedScopes: ['applications'],
    contextSourceIds: ['source-security-001'],
  },
});

test('subagent runtime hard-fixes depth one and rejects plans above the agent cap', async (t) => {
  let modelCalls = 0;
  const fixture = await createFixture(t, {
    limits: { maxDepth: 99, maxAgents: 2 },
    modelCaller: async () => {
      modelCalls += 1;
      return finalResponse('unexpected');
    },
  });

  const description = fixture.runtime.describe();
  assert.equal(description.safeguards.maxDepth, 1);
  assert.equal(description.safeguards.maxAgents, 2);
  assert.equal(description.safeguards.recursiveDelegation, false);

  await assert.rejects(
    fixture.runtime.execute(
      'agent.delegate',
      { objective: 'Attempt a nested delegation.' },
      parentContext({ agentDepth: 1 }),
    ),
    hasCode('SUBAGENT_RECURSION_DENIED'),
  );

  await assert.rejects(
    fixture.runtime.execute(
      'agent.delegate',
      {
        objective: 'Attempt an oversized delegation plan.',
        maxAgents: 99,
        tasks: [task('agent-1'), task('agent-2'), task('agent-3')],
      },
      parentContext(),
    ),
    hasCode('SUBAGENT_AGENT_LIMIT'),
  );

  assert.equal(modelCalls, 0);
  assert.equal(fixture.store.listRuns({ limit: 100 }).length, 0);
});

test('independent agents run under the concurrency cap, bind events, truncate output, and never persist credentials', async (t) => {
  const events = [];
  let active = 0;
  let peak = 0;
  let sessionChecks = 0;
  const fixture = await createFixture(t, {
    limits: {
      maxAgents: 6,
      maxSteps: 1,
      maxOutputChars: 1_000,
      maxAggregateOutputChars: 4_000,
    },
    modelCaller: async (_fetch, session, _messages, tools, _signal, emit) => {
      sessionChecks += 1;
      assert.equal(session.apiKey, API_KEY);
      assert.equal(session.credentials.sessionToken, SESSION_TOKEN);
      assert.deepEqual(tools.map((tool) => tool.name), ['records.query']);
      active += 1;
      peak = Math.max(peak, active);
      emit({ type: 'assistant.delta', delta: 'bounded partial output' });
      try {
        await delay(35);
        return finalResponse('x'.repeat(1_500));
      } finally {
        active -= 1;
      }
    },
  });

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Run six independent evidence checks.',
      maxAgents: 6,
      maxSteps: 1,
      maxOutputChars: 1_000,
      tasks: Array.from({ length: 6 }, (_, index) => task(`agent-${index + 1}`, {
        role: index % 2 ? 'researcher' : 'analyst',
        allowedTools: ['records.query'],
      })),
    },
    parentContext({ events }),
  );

  assert.equal(delegated.type, 'subagent.run.receipt');
  assert.equal(delegated.receipt.status, 'completed');
  assert.equal(delegated.receipt.persisted, true);
  assert.equal(delegated.receipt.counts.completed, 6);
  assert.equal(sessionChecks, 6);
  assert.equal(peak, 3, 'the default orchestrator must cap ready subagents at three');

  const runId = delegated.receipt.runId;
  assert.ok(runId.startsWith('subagent-'));
  assert.equal(delegated.results.length, 3, 'aggregate output must stop at the 4,000 character envelope');
  assert.equal(delegated.results[0].text.length, 1_000);
  assert.equal(delegated.results[1].text.length, 1_000);
  assert.equal(delegated.results[2].text.length, 500);
  assert.ok(delegated.results.every((result) => result.truncated));

  const subagentEvents = events.filter((event) => String(event.type).startsWith('subagent.'));
  assert.ok(subagentEvents.length > 0);
  assertEventIdentity(subagentEvents, runId);
  const eventTypes = new Set(subagentEvents.map((event) => event.type));
  for (const type of [
    'subagent.run.planned',
    'subagent.run.started',
    'subagent.task.started',
    'subagent.output.delta',
    'subagent.task.completed',
    'subagent.run.completed',
    'subagent.run.receipt',
  ]) assert.ok(eventTypes.has(type), `missing ${type}`);

  const run = fixture.store.getRun(runId);
  const durableState = {
    run,
    turn: fixture.store.getTurn(run.turnId),
    planRevisions: fixture.store.listPlanRevisions(runId),
    nodes: fixture.store.listRunNodes(runId),
    attempts: fixture.store.listNodeAttempts({ runId }),
  };
  assert.equal(durableState.nodes.length, 6);
  assert.ok(durableState.nodes.every((node) => node.output.text.length === 1_000));
  assert.ok(durableState.nodes.every((node) => node.output.truncated === true));
  assertCredentialFree(JSON.stringify({ delegated, events, durableState }));

  for (const file of await listFiles(fixture.rootDir)) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from(API_KEY)), false, `${path.basename(file)} persisted the API key`);
    assert.equal(bytes.includes(Buffer.from(SESSION_TOKEN)), false, `${path.basename(file)} persisted the session token`);
  }
});

test('child execution enforces the exact task whitelist and excludes recursive or mutating tools', async (t) => {
  const events = [];
  let modelRound = 0;
  const fixture = await createFixture(t, {
    modelCaller: async (_fetch, _session, _messages, tools) => {
      modelRound += 1;
      assert.deepEqual(tools.map((tool) => tool.name), ['records.query']);
      if (modelRound === 1) {
        return toolResponse({
          id: 'forged-call-1',
          name: 'records.secret',
          input: { probe: true },
        });
      }
      return finalResponse('The forged call was rejected.');
    },
  });

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Use only the explicitly approved record query.',
      maxSteps: 2,
      tasks: [task('whitelist-agent', { allowedTools: ['records.query'], maxSteps: 2 })],
    },
    parentContext({ events }),
  );

  assert.equal(modelRound, 2);
  assert.deepEqual(fixture.registryCalls, []);
  assert.equal(delegated.results[0].tools.length, 1);
  assert.equal(delegated.results[0].tools[0].status, 'failed');
  assert.equal(delegated.results[0].tools[0].error.code, 'SUBAGENT_TOOL_NOT_ALLOWED');
  assert.ok(events.some((event) => event.type === 'subagent.tool.failed' && event.toolName === 'records.secret'));
  assertEventIdentity(events.filter((event) => String(event.type).startsWith('subagent.')), delegated.receipt.runId);

  const previousModelRounds = modelRound;
  const unsafe = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Attempt to whitelist a mutating tool.',
      tasks: [task('unsafe-agent', { allowedTools: ['email.send'] })],
    },
    parentContext(),
  );
  assert.equal(unsafe.receipt.status, 'failed');
  assert.equal(unsafe.error.code, 'SUBAGENT_TOOL_NOT_ALLOWED');
  assert.equal(modelRound, previousModelRounds);
  assert.deepEqual(fixture.registryCalls, []);
});

test('workspace auto mode preserves the read-only child catalog', async (t) => {
  let modelCalls = 0;
  const fixture = await createFixture(t, {
    approvalMode: 'workspace_auto',
    definitions: [
      toolDefinition('records.query'),
      toolDefinition('workspace.write', { risk: 'approval_required', idempotent: false, parallelSafe: false }),
      toolDefinition('agent.delegate'),
    ],
    modelCaller: async (_fetch, _session, _messages, tools) => {
      modelCalls += 1;
      assert.deepEqual(tools.map((tool) => tool.name), ['records.query']);
      return finalResponse('Read-only child result.');
    },
  });

  assert.equal(fixture.runtime.describe().safeguards.childTools, 'read_idempotent_parallel_safe');
  assert.equal(fixture.runtime.describe().safeguards.directToolAuthorization, 'not_available');

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Read one record only.',
      tasks: [task('workspace-auto-agent', { allowedTools: ['records.query'] })],
    },
    parentContext(),
  );
  assert.equal(delegated.receipt.status, 'completed');
  assert.equal(modelCalls, 1);

  const denied = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Try to write in workspace auto mode.',
      tasks: [task('workspace-auto-write', { allowedTools: ['workspace.write'] })],
    },
    parentContext(),
  );
  assert.equal(denied.receipt.status, 'failed');
  assert.equal(denied.error.code, 'SUBAGENT_TOOL_NOT_ALLOWED');
  assert.equal(modelCalls, 1);
  assert.deepEqual(fixture.registryCalls, []);
});

test('owner unrestricted child agents receive the full non-agent catalog and direct authorization', async (t) => {
  const events = [];
  const childContexts = [];
  let modelRound = 0;
  const definitions = [
    toolDefinition('tool.search'),
    toolDefinition('tool.describe'),
    toolDefinition('workspace.write', { risk: 'approval_required', idempotent: false, parallelSafe: false }),
    toolDefinition('exec.run', { risk: 'approval_required', idempotent: false, parallelSafe: false }),
    toolDefinition('http.request', { risk: 'approval_required', idempotent: false, parallelSafe: false }),
    toolDefinition('mcp.example.mutate', { risk: 'approval_required', idempotent: false, parallelSafe: false }),
    toolDefinition('agent.delegate'),
  ];
  const fixture = await createFixture(t, {
    approvalMode: 'never',
    definitions,
    limits: { maxSteps: 2, maxAvailableTools: 10 },
    modelCaller: async (_fetch, _session, messages, tools) => {
      modelRound += 1;
      const names = tools.map((tool) => tool.name);
      assert.equal(names.includes('agent.delegate'), false);
      assert.deepEqual(new Set(names), new Set([
        'tool.search',
        'tool.describe',
        'workspace.write',
        'exec.run',
        'http.request',
        'mcp.example.mutate',
      ]));
      if (modelRound === 1) {
        assert.match(messages[0].content, /Owner unrestricted mode/u);
        return {
          text: '',
          calls: ['workspace.write', 'exec.run', 'http.request', 'mcp.example.mutate'].map((name, index) => ({
            id: `owner-call-${index + 1}`,
            wireId: `owner-call-${index + 1}`,
            name,
            input: { objective: 'owner child execution', index },
          })),
          responseId: 'response-owner-tools',
          usage: null,
        };
      }
      return finalResponse('The owner-authorized child tools completed.');
    },
    executeTool: async (name, input, context) => {
      childContexts.push({
        name,
        input,
        approved: context.approved,
        authorizationMode: context.authorizationMode,
        approvalMode: context.approvalMode,
        referenceConversationId: context.reference.conversationId,
        parentRunId: context.parentRunId,
        parentToolRunId: context.parentToolRunId,
        agentDepth: context.agentDepth,
      });
      return { type: 'owner-tool.result', name, ok: true };
    },
  });

  assert.equal(fixture.runtime.describe().safeguards.childTools, 'full_non_agent_catalog');
  assert.equal(fixture.runtime.describe().safeguards.directToolAuthorization, 'automatic_owner');

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Use the local workspace, command, HTTP, and MCP capabilities.',
      maxSteps: 2,
      tasks: [task('owner-agent', { allowedTools: [], maxSteps: 2 })],
    },
    parentContext({ events }),
  );

  assert.equal(delegated.receipt.status, 'completed');
  assert.equal(modelRound, 2);
  assert.deepEqual(childContexts.map((item) => item.name), [
    'workspace.write',
    'exec.run',
    'http.request',
    'mcp.example.mutate',
  ]);
  assert.ok(childContexts.every((item) => item.approved === true));
  assert.ok(childContexts.every((item) => item.authorizationMode === 'automatic_owner'));
  assert.ok(childContexts.every((item) => item.approvalMode === 'never'));
  assert.ok(childContexts.every((item) => item.referenceConversationId === CONVERSATION_ID));
  assert.ok(childContexts.every((item) => item.parentRunId === PARENT_RUN_ID));
  assert.ok(childContexts.every((item) => item.parentToolRunId === PARENT_TOOL_RUN_ID));
  assert.ok(childContexts.every((item) => item.agentDepth === 1));
  assert.ok(events.some((event) => event.type === 'subagent.tool.started' && event.authorizationMode === 'automatic_owner'));
  assertEventIdentity(events.filter((event) => String(event.type).startsWith('subagent.')), delegated.receipt.runId);
});

test('child agents can discover and activate an allowed read-only tool outside the initial model catalog', async (t) => {
  const targetTool = 'mcp.analytics.deep-insight';
  const definitions = [
    toolDefinition('tool.search'),
    toolDefinition('tool.describe'),
    toolDefinition('records.query'),
    ...Array.from({ length: 12 }, (_, index) => toolDefinition(`records.filler-${index + 1}`)),
    toolDefinition(targetTool),
  ];
  let modelRound = 0;
  const fixture = await createFixture(t, {
    definitions,
    limits: { maxSteps: 3, maxAvailableTools: 4 },
    modelCaller: async (_fetch, _session, _messages, tools) => {
      modelRound += 1;
      const names = tools.map((tool) => tool.name);
      if (modelRound === 1) {
        assert.ok(names.includes('tool.search'));
        assert.equal(names.includes(targetTool), false);
        return toolResponse({
          id: 'discover-call-1',
          name: 'tool.search',
          input: { query: targetTool, limit: 5 },
        });
      }
      if (modelRound === 2) {
        assert.ok(names.includes(targetTool), 'the discovered tool must be available in the next model round');
        return toolResponse({
          id: 'target-call-1',
          name: targetTool,
          input: { metric: 'quality' },
        });
      }
      return finalResponse('The dynamically discovered MCP evidence was collected.');
    },
  });

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Find and use the deep insight MCP capability.',
      maxSteps: 3,
      tasks: [task('discovery-agent', { allowedTools: [], maxSteps: 3 })],
    },
    parentContext(),
  );

  assert.equal(delegated.receipt.status, 'completed');
  assert.equal(modelRound, 3);
  assert.deepEqual(fixture.registryCalls.map((call) => call.name), [targetTool]);
  assert.deepEqual(delegated.results[0].tools.map((tool) => [tool.toolName, tool.status]), [
    ['tool.search', 'completed'],
    [targetTool, 'completed'],
  ]);
});

test('parallel child tool calls are rejected before registry execution', async (t) => {
  const fixture = await createFixture(t, {
    limits: { maxParallelTools: 2 },
    modelCaller: async () => ({
      text: '',
      calls: [1, 2, 3].map((index) => ({
        id: `call-${index}`,
        wireId: `call-${index}`,
        name: 'records.query',
        input: { index },
      })),
      responseId: 'response-tool-fanout',
      usage: null,
    }),
  });

  const delegated = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Attempt excessive parallel tool fanout.',
      tasks: [task('fanout-agent', { allowedTools: ['records.query'] })],
    },
    parentContext(),
  );
  assert.equal(delegated.receipt.status, 'failed');
  assert.equal(delegated.error.code, 'SUBAGENT_PARALLEL_TOOL_LIMIT');
  assert.deepEqual(fixture.registryCalls, []);
});

test('parent cancellation aborts the active child model and completes with a cancelled receipt', async (t) => {
  const events = [];
  const started = deferred();
  let childAborted = false;
  const fixture = await createFixture(t, {
    modelCaller: async (_fetch, _session, _messages, _tools, signal) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          childAborted = true;
          reject(signal.reason || new Error('child model aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  const controller = new AbortController();

  const completion = fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Keep running until the parent cancels.',
      tasks: [task('cancel-agent', { allowedTools: ['records.query'], timeoutMs: 10_000 })],
    },
    parentContext({ events, signal: controller.signal }),
  );
  await started.promise;
  controller.abort(new Error('parent cancelled'));
  const delegated = await completion;

  assert.equal(childAborted, true);
  assert.equal(delegated.receipt.status, 'cancelled');
  assert.equal(delegated.receipt.active, false);
  assert.ok(events.some((event) => event.type === 'subagent.run.cancelled'));
  assertEventIdentity(events.filter((event) => String(event.type).startsWith('subagent.')), delegated.receipt.runId);
});

test('agent.cancel aborts the active child and emits a parent-bound cancellation receipt', async (t) => {
  const events = [];
  const started = deferred();
  let childAborted = false;
  const fixture = await createFixture(t, {
    modelCaller: async (_fetch, _session, _messages, _tools, signal) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          childAborted = true;
          reject(signal.reason || new Error('child model aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  });

  const completion = fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Keep running until agent.cancel is invoked.',
      tasks: [task('explicit-cancel-agent', { allowedTools: ['records.query'], timeoutMs: 10_000 })],
    },
    parentContext({ events }),
  );
  await started.promise;
  const runId = events.find((event) => event.type === 'subagent.run.planned')?.runId;
  assert.ok(runId);

  const cancellation = await fixture.runtime.execute(
    'agent.cancel',
    { runId },
    parentContext({ events }),
  );
  const delegated = await completion;

  assert.equal(cancellation.accepted, true);
  assert.equal(childAborted, true);
  assert.equal(delegated.receipt.status, 'cancelled');
  assert.ok(events.some((event) => event.type === 'subagent.run.cancel.requested' && event.accepted === true));
  assertEventIdentity(events.filter((event) => String(event.type).startsWith('subagent.')), runId);
});

test('task timeout aborts an in-flight child tool and records the timeout failure', async (t) => {
  const events = [];
  let toolAborted = false;
  const fixture = await createFixture(t, {
    modelCaller: async () => toolResponse({
      id: 'timeout-call-1',
      name: 'records.query',
      input: { wait: true },
    }),
    executeTool: async (_name, _input, context) => new Promise((resolve, reject) => {
      const abort = () => {
        toolAborted = true;
        reject(context.signal.reason || new Error('child tool aborted'));
      };
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
    }),
  });

  const timedOut = await fixture.runtime.execute(
    'agent.delegate',
    {
      objective: 'Exercise timeout propagation to an active child tool.',
      timeoutMs: 2_000,
      tasks: [task('timeout-agent', {
        allowedTools: ['records.query'],
        maxSteps: 2,
        timeoutMs: 1_000,
      })],
    },
    parentContext({ events }),
  );
  await delay(0);

  assert.equal(timedOut.receipt.status, 'failed');
  assert.equal(timedOut.error.code, 'TASK_TIMEOUT');
  assert.equal(toolAborted, true);
  assert.equal(fixture.registryCalls.length, 1);
  assert.ok(events.some((event) => event.type === 'subagent.tool.started'));
  const planned = events.find((event) => event.type === 'subagent.run.planned');
  assert.ok(planned?.runId);
  assert.deepEqual(fixture.registryCalls[0].context, {
    runId: planned.runId,
    parentRunId: PARENT_RUN_ID,
    parentToolRunId: PARENT_TOOL_RUN_ID,
    subagentTaskId: 'timeout-agent',
    agentDepth: 1,
    aiSessionId: AI_SESSION_ID,
    signalAborted: false,
  });
  assertEventIdentity(events.filter((event) => String(event.type).startsWith('subagent.')), planned.runId);
  const failedRun = fixture.store.getRun(planned.runId);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.error.code, 'TASK_TIMEOUT');
});

async function createFixture(t, {
  limits = {},
  modelCaller,
  executeTool = null,
  definitions: suppliedDefinitions = null,
  approvalMode = 'required',
} = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'subagent-runtime-security-'));
  const store = createCopilotProductionStore({ rootDir });
  const registryCalls = [];
  let nextId = 0;
  const definitions = suppliedDefinitions || [
    toolDefinition('records.query'),
    toolDefinition('records.secret'),
    toolDefinition('email.send', { risk: 'write', idempotent: false, parallelSafe: false }),
    toolDefinition('workspace.serial-read', { parallelSafe: false }),
    toolDefinition('agent.delegate'),
  ];
  const registry = {
    list: () => structuredClone(definitions),
    execute: async (name, input, context) => {
      registryCalls.push({ name, input: structuredClone(input), context: safeContext(context) });
      if (executeTool) return executeTool(name, input, context);
      return { type: 'tool.result', name, rows: [] };
    },
  };
  const aiSessions = {
    resolve(id) {
      assert.equal(id, AI_SESSION_ID);
      return {
        id,
        provider: 'openai_compatible',
        model: 'subagent-security-model',
        wireApi: 'chat_completions',
        baseUrl: 'https://provider.invalid/v1',
        apiKey: API_KEY,
        credentials: { sessionToken: SESSION_TOKEN },
        headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
      };
    },
  };
  const runtime = new SubagentRuntime({
    productionStore: store,
    registryProvider: () => registry,
    aiSessions,
    modelCaller,
    idFactory: () => `security-${++nextId}`,
    limits,
    approvalMode,
  });
  t.after(async () => {
    runtime.close();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, store, registry, registryCalls, runtime };
}

function parentContext({ events = [], signal = undefined, agentDepth = 0 } = {}) {
  return {
    reference: structuredClone(REFERENCE),
    conversation: { ...structuredClone(REFERENCE), filters: {} },
    contextSourceIds: ['source-security-001'],
    runId: PARENT_RUN_ID,
    toolRunId: PARENT_TOOL_RUN_ID,
    aiSessionId: AI_SESSION_ID,
    agentDepth,
    signal,
    emit: (event) => events.push(event),
  };
}

function task(id, overrides = {}) {
  return {
    id,
    title: `Security task ${id}`,
    objective: `Complete security task ${id}.`,
    role: 'analyst',
    dependsOn: [],
    allowedTools: ['records.query'],
    maxSteps: 1,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function toolDefinition(name, { risk = 'read', idempotent = true, parallelSafe = true } = {}) {
  return {
    name,
    title: name,
    description: `${name} test definition`,
    category: 'test',
    source: 'test',
    scopes: [],
    risk,
    idempotent,
    parallelSafe,
    inputSchema: { type: 'object', additionalProperties: true },
  };
}

function finalResponse(text) {
  return {
    text,
    calls: [],
    responseId: 'response-final',
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function toolResponse(call) {
  return {
    text: '',
    calls: [{ ...call, wireId: call.wireId || call.id }],
    responseId: 'response-tool-call',
    usage: null,
  };
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function assertEventIdentity(events, runId) {
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.runId, runId, `${event.type} must bind to the child run`);
    assert.equal(event.parentRunId, PARENT_RUN_ID, `${event.type} must bind to the parent run`);
    assert.equal(event.parentToolRunId, PARENT_TOOL_RUN_ID, `${event.type} must bind to the parent tool run`);
    assert.equal(event.conversationId, CONVERSATION_ID, `${event.type} must bind to the conversation`);
  }
}

function assertCredentialFree(serialized) {
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes(SESSION_TOKEN), false);
  assert.equal(serialized.includes('"apiKey"'), false);
  assert.equal(serialized.includes('"sessionToken"'), false);
  assert.equal(serialized.includes('"Authorization"'), false);
}

function safeContext(context) {
  return {
    runId: context.runId,
    parentRunId: context.parentRunId,
    parentToolRunId: context.parentToolRunId,
    subagentTaskId: context.subagentTaskId,
    agentDepth: context.agentDepth,
    aiSessionId: context.aiSessionId,
    signalAborted: context.signal?.aborted || false,
  };
}

async function listFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(rootDir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
