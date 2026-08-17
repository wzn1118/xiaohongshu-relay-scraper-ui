import test from 'node:test';
import assert from 'node:assert/strict';

import { answerAstFromText, answerAstToText, normalizeAnswerAst } from './copilot/answer-ast.mjs';
import { createContextManager } from './copilot/context-manager.mjs';
import { normalizeCopilotEvent, replayEvents } from './copilot/event-log.mjs';
import { EvidenceGraph } from './copilot/evidence-graph.mjs';
import { createModelGateway } from './copilot/model-gateway.mjs';
import { createOrchestrator, TaskGraph } from './copilot/orchestrator.mjs';
import { aggregateRows, createReadOnlySandbox, profileRows, queryRows } from './copilot/sandbox.mjs';
import { createSkillRegistry } from './copilot/skills.mjs';
import { createSpecialistRouter } from './copilot/specialists.mjs';
import { createUsageTracker } from './copilot/usage-tracker.mjs';
import { verifyAnswer } from './copilot/verifier.mjs';

test('answer AST preserves headings, lists, tables, code and round-trips to text', () => {
  const ast = answerAstFromText('# Summary\n\n- first\n- second\n\n| name | value |\n| --- | --- |\n| a | 1 |\n\n```sql\nselect 1\n```');
  assert.equal(ast.schemaVersion, 1);
  assert.deepEqual(ast.blocks.map((block) => block.kind), ['heading', 'list', 'table', 'code']);
  assert.match(answerAstToText(ast), /select 1/u);
});

test('context manager ranks relevant items and reports budget omissions', () => {
  const manager = createContextManager({ budget: 256, now: () => new Date('2026-08-03T00:00:00.000Z') });
  const result = manager.buildWorkingSet({
    query: 'growth',
    messages: [{ messageId: 'm1', content: 'growth analysis' }, { messageId: 'm2', content: 'x'.repeat(2000) }],
    sources: [{ sourceId: 's1', title: 'growth source' }],
    budget: 256,
  });
  assert.equal(result.schemaVersion, 2);
  assert.ok(result.included.some((item) => item.id === 'm1' || item.id === 's1'));
  assert.ok(result.excluded.length >= 1);
  assert.equal(result.createdAt, '2026-08-03T00:00:00.000Z');
});

test('context manager preserves pins, partitions budgets, and reports missing context', () => {
  const manager = createContextManager({
    budget: 256,
    reservedOutputTokens: 64,
    tokenCounter: { count: () => ({ tokens: 120, method: 'provider' }) },
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  const result = manager.buildWorkingSet({
    query: 'growth',
    messages: [{ messageId: 'm1', content: 'growth' }, { messageId: 'm2', content: 'history' }],
    sources: [{ sourceId: 's1', title: 'source' }],
    pins: [{ itemId: 's1' }],
    requiredContextIds: ['s1', 'missing'],
  });
  assert.equal(result.tokenMethod, 'provider');
  assert.ok(result.included.some((item) => item.id === 's1' && item.pinned));
  assert.ok(result.partitions.some((partition) => partition.id === 'sources' && partition.pinnedItems === 1));
  assert.equal(result.canExecute, false);
  assert.ok(result.missingContext.some((item) => item.code === 'required_context_missing'));
});

test('verifier flags missing evidence and unknown source references', () => {
  const answer = normalizeAnswerAst({ blocks: [{ kind: 'paragraph', content: 'claim', sourceRefs: ['source-missing'], claimIds: ['claim-1'] }] });
  const result = verifyAnswer({ answer, evidence: [{ sourceId: 'source-known' }], requireEvidence: true });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_source'));
  const graph = new EvidenceGraph({ now: () => new Date('2026-08-03T00:00:00.000Z') });
  graph.addSource({ sourceId: 'source-known', label: 'Dataset' });
  graph.addClaim({ claimId: 'claim-1', sourceRefs: ['source-known'], text: 'claim' });
  assert.equal(graph.snapshot().claims[0].sourceRefs[0], 'source-known');
});

test('read-only sandbox profiles and aggregates rows without mutation', () => {
  const input = [{ city: 'Shanghai', score: 2 }, { city: 'Shanghai', score: 4 }, { city: 'Beijing', score: 3 }];
  const profile = profileRows(input);
  assert.equal(profile.rowCount, 3);
  assert.equal(profile.columns.find((column) => column.name === 'score').nonNull, 3);
  assert.deepEqual(aggregateRows(input, { groupBy: 'city', metric: 'score', operation: 'avg' }), [
    { city: 'Beijing', value: 3 },
    { city: 'Shanghai', value: 3 },
  ]);
  assert.deepEqual(input[0], { city: 'Shanghai', score: 2 });
});

test('workbench sandbox executes bounded SQL, analysis, chart and report tools', async () => {
  const input = [{ city: 'Shanghai', score: 2 }, { city: 'Shanghai', score: 4 }, { city: 'Beijing', score: 3 }];
  assert.deepEqual(queryRows(input, { sql: 'select city, avg(score) as average from data group by city order by city asc' }).rows, [
    { city: 'Beijing', average: 3 },
    { city: 'Shanghai', average: 3 },
  ]);
  assert.throws(() => queryRows(input, { sql: 'delete from data' }), { code: 'SANDBOX_SQL_READ_ONLY' });
  const sandbox = createReadOnlySandbox();
  const chart = await sandbox.execute('chart.create', { rows: input, type: 'bar', x: 'city', y: 'score' });
  assert.equal(chart.kind, 'chart');
  const report = await sandbox.execute('report.compose', { title: 'Result', sections: [{ title: 'Finding', content: 'Stable.' }] });
  assert.deepEqual(report.blocks.map((block) => block.kind), ['heading', 'heading', 'paragraph']);
});

test('typed event replay detects cursor gaps and preserves payloads', () => {
  const event = normalizeCopilotEvent({ eventId: 4, type: 'tool.completed', toolName: 'dataset.profile' }, { conversationId: 'conversation-1' });
  assert.equal(event.seq, 4);
  assert.equal(event.payload.toolName, 'dataset.profile');
  const replay = replayEvents([event, { eventId: 5, conversationId: 'conversation-1', event: 'run.completed' }], { afterSeq: 1 });
  assert.deepEqual(replay.gap, { from: 2, to: 3 });
  assert.equal(replay.nextSeq, 5);
});

test('task graph executes dependency batches in deterministic order', async () => {
  const graph = new TaskGraph([
    { id: 'inspect' },
    { id: 'analyze', dependsOn: ['inspect'] },
    { id: 'verify', dependsOn: ['analyze'] },
  ]);
  const events = [];
  const result = await createOrchestrator({ now: () => new Date('2026-08-03T00:00:00.000Z') }).run(
    graph,
    async (task) => `${task.id}:done`,
    { onEvent: (event) => events.push(event.type) },
  );
  assert.equal(result.outputs.verify, 'verify:done');
  assert.deepEqual(events, ['task.started', 'task.completed', 'task.started', 'task.completed', 'task.started', 'task.completed']);
  assert.throws(() => new TaskGraph([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), { code: 'TASK_CYCLE' });
});

test('task graph enforces budgets, timeouts, output contracts and idempotency', async () => {
  const orchestrator = createOrchestrator({ cacheLimit: 10 });
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { rows: 3 };
  };
  const task = {
    id: 'profile',
    idempotencyKey: 'dataset-1:profile:v1',
    contract: { outputType: 'object', requiredKeys: ['rows'] },
  };
  await orchestrator.run(new TaskGraph([task]), execute);
  const events = [];
  const reused = await orchestrator.run(new TaskGraph([task]), execute, { onEvent: (event) => events.push(event.type) });
  assert.equal(executions, 1);
  assert.equal(reused.governance.reusedTasks, 1);
  assert.deepEqual(events, ['task.reused']);

  await assert.rejects(
    orchestrator.run(new TaskGraph([{ id: 'expensive', budgetUnits: 2 }]), async () => true, { budget: { maxUnits: 1 } }),
    { code: 'TASK_BUDGET_EXCEEDED' },
  );
  await assert.rejects(
    orchestrator.run(new TaskGraph([{ id: 'slow', timeoutMs: 100 }]), async () => new Promise((resolve) => setTimeout(resolve, 200))),
    { code: 'TASK_TIMEOUT' },
  );
  await assert.rejects(
    orchestrator.run(
      new TaskGraph([{ id: 'contract', contract: { outputType: 'object', requiredKeys: ['rows'] } }]),
      async () => ({ count: 3 }),
    ),
    { code: 'TASK_OUTPUT_CONTRACT_FAILED' },
  );
});

test('model gateway normalizes chat-completion responses and request metadata', async () => {
  let request;
  const gateway = createModelGateway({
    fetchImpl: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ model: 'model-1', choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    providers: { primary: { baseUrl: 'https://models.example/v1', apiKey: 'token' } },
  });
  const result = await gateway.complete({ provider: 'primary', model: 'model-1', messages: [{ role: 'user', content: 'question' }] });
  assert.equal(result.text, 'answer');
  assert.equal(request.url, 'https://models.example/v1/chat/completions');
  assert.equal(request.body.model, 'model-1');
  assert.equal(request.headers.Authorization, 'Bearer token');
});

test('model gateway persists Responses state and supports background retrieval and cancellation', async () => {
  const requests = [];
  const gateway = createModelGateway({
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ id: 'resp-2', model: 'model-2', status: 'completed', conversation: { id: 'conv-1' }, output_text: 'done', background: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    providers: {
      responses: {
        baseUrl: 'https://models.example/v1',
        apiKey: 'token',
        wireApi: 'responses',
        capabilities: { background: true, statefulResponses: true, conversationState: true, reasoningSummary: true, reasoningEffort: true },
      },
    },
  });
  const completed = await gateway.complete({ provider: 'responses', model: 'gpt-5.6-sol', input: 'continue', previousResponseId: 'resp-1', conversationId: 'conv-1', background: true, reasoningSummary: 'auto', reasoningEffort: 'max' });
  assert.equal(completed.responseId, 'resp-2');
  assert.equal(requests[0].body.previous_response_id, 'resp-1');
  assert.equal(requests[0].body.conversation, 'conv-1');
  assert.deepEqual(requests[0].body.reasoning, { summary: 'auto', effort: 'max' });
  await gateway.retrieve({ provider: 'responses', responseId: 'resp-2' });
  await gateway.cancel({ provider: 'responses', responseId: 'resp-2' });
  assert.deepEqual(requests.slice(1).map((request) => [request.method, request.url]), [
    ['GET', 'https://models.example/v1/responses/resp-2'],
    ['POST', 'https://models.example/v1/responses/resp-2/cancel'],
  ]);
});

test('strict verifier recalculates numeric claims and rejects uncovered lineage', () => {
  const answer = normalizeAnswerAst({ blocks: [{ kind: 'paragraph', content: 'Total is 7.', claimIds: ['claim-total', 'claim-uncovered'], sourceRefs: ['source-1'] }] });
  const result = verifyAnswer({
    answer,
    strict: true,
    evidence: [{ sourceId: 'source-1' }],
    claims: [
      { claimId: 'claim-total', sourceRefs: ['source-1'], calculationRefs: ['calc-1'] },
      { claimId: 'claim-uncovered' },
    ],
    calculations: [{ calculationId: 'calc-1', operation: 'sum', inputs: [2, 3], result: 7 }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => issue.code === 'calculation_mismatch' && issue.actual === 5));
  assert.ok(result.issues.some((issue) => issue.code === 'claim_without_evidence'));
  assert.equal(result.metrics.claimCoverage, 0.5);
});

test('skills, specialists and usage tracking expose workbench routing metadata', () => {
  assert.ok(createSkillRegistry().resolve('analyze').some((skill) => skill.id === 'analyze'));
  assert.deepEqual(createSpecialistRouter().route({ mode: 'build' }).map((item) => item.id), ['analyst', 'verifier']);
  const usage = createUsageTracker({ now: () => new Date('2026-08-03T00:00:00.000Z') });
  usage.record({ conversationId: 'c1', inputTokens: 10, outputTokens: 3, toolCalls: 1 });
  assert.deepEqual(usage.summarize({ conversationId: 'c1' }), { records: 1, inputTokens: 10, outputTokens: 3, toolCalls: 1, latencyMs: 0 });
});
