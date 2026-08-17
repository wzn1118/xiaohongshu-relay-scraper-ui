import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelGateway } from './copilot/model-gateway.mjs';
import { createModelRunBroker, ModelRunBrokerError } from './copilot/model-run-broker.mjs';

const TOOL = {
  name: 'workspace.read',
  description: 'Read a workspace file.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

test('ModelRunBroker streams Responses events into legacy turn output without credential events', async () => {
  const events = [];
  let request;
  const gateway = {
    async *stream(input) {
      request = input;
      yield { raw: { type: 'response.output_text.delta', delta: 'Reading ' } };
      yield { raw: { type: 'response.reasoning.delta', delta: 'Need the selected file.' } };
      yield { raw: { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'copilot_workspace__read', arguments: '' } } };
      yield { raw: { type: 'response.function_call_arguments.delta', item_id: 'item-1', call_id: 'call-1', delta: '{"path":"src/' } };
      yield { raw: { type: 'response.function_call_arguments.delta', item_id: 'item-1', call_id: 'call-1', delta: 'main.ts"}' } };
      yield {
        raw: {
          type: 'response.completed',
          response: {
            id: 'resp-1',
            output: [{ type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'copilot_workspace__read', arguments: '{"path":"src/main.ts"}' }],
            usage: { input_tokens: 7, output_tokens: 3 },
          },
        },
      };
    },
    async complete() { throw new Error('completion should not be used'); },
  };
  const broker = createModelRunBroker({ gateway, clock: sequenceClock() });

  const result = await broker.runTurn({
    session: { provider: 'responses', model: 'gpt-5.6-sol', baseUrl: 'https://models.example/v1', apiKey: 'do-not-project', wireApi: 'responses', reasoningEffort: 'max' },
    messages: [{ role: 'user', content: 'Read the entry file.' }],
    toolDefinitions: [TOOL],
    onEvent: (event) => events.push(event),
    executionContext: { runId: 'run-1', apiKey: 'also-do-not-project' },
  });

  assert.equal(request.input[0].content, 'Read the entry file.');
  assert.equal(request.reasoningEffort, 'max');
  assert.deepEqual(request.tools[0], {
    type: 'function',
    name: 'copilot_workspace__read',
    description: 'Read a workspace file.',
    parameters: TOOL.inputSchema,
    strict: true,
  });
  assert.equal(result.text, '');
  assert.deepEqual(result.calls, [{ id: 'call-1', wireId: 'call-1', name: 'workspace.read', input: { path: 'src/main.ts' } }]);
  assert.equal(result.responseId, 'resp-1');
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal(events.some((event) => event.type === 'assistant.delta' && event.text === 'Reading '), true);
  assert.equal(events.some((event) => event.type === 'assistant.reasoning.delta' && event.text === 'Need the selected file.'), true);
  assert.equal(events.some((event) => event.type === 'tool.call.delta' && event.name === 'workspace.read'), true);
  assert.equal(JSON.stringify(events).includes('do-not-project'), false);
});

test('ModelRunBroker uses ModelGateway streaming for Chat tool calls and emits legacy deltas', async () => {
  let captured;
  const gateway = createModelGateway({
    fetchImpl: async (_url, options) => {
      captured = { headers: options.headers, body: JSON.parse(options.body) };
      return sseResponse([
        { id: 'chat-1', choices: [{ delta: { content: 'Opening ' } }] },
        { id: 'chat-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-chat-1', function: { name: 'copilot_workspace__read', arguments: '{"path":"README.md"}' } }] } }] },
        '[DONE]',
      ]);
    },
    providers: { chat: { baseUrl: 'https://models.example/v1', apiKey: 'gateway-secret' } },
  });
  const broker = createModelRunBroker({ gateway, clock: sequenceClock() });
  const events = [];

  const result = await broker.runTurn({
    session: { provider: 'chat', model: 'chat-model', baseUrl: 'https://models.example/v1', wireApi: 'chat_completions' },
    messages: [{ role: 'user', content: 'Open README.' }],
    toolDefinitions: [TOOL],
    onEvent: (event) => events.push(event),
  });

  assert.equal(captured.headers.Accept, 'text/event-stream, application/json');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.tools[0].function.name, 'copilot_workspace__read');
  assert.equal(captured.body.tool_choice, 'auto');
  assert.equal(result.text, 'Opening ');
  assert.deepEqual(result.calls, [{ id: 'call-chat-1', wireId: 'call-chat-1', name: 'workspace.read', input: { path: 'README.md' } }]);
  assert.equal(events.some((event) => event.type === 'assistant.delta' && event.delta === 'Opening '), true);
  assert.equal(events.some((event) => event.type === 'tool.call.delta' && event.callId === 'call-chat-1'), true);
});

test('ModelRunBroker preserves relay host-root endpoint fallback through ModelGateway', async () => {
  const urls = [];
  const gateway = createModelGateway({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/v1/')) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return sseResponse([
        { id: 'relay-root-response', choices: [{ delta: { content: 'Relay root works.' } }] },
        '[DONE]',
      ]);
    },
  });
  const broker = createModelRunBroker({ gateway, clock: sequenceClock() });

  const result = await broker.runTurn({
    session: { provider: 'relay', model: 'relay-model', baseUrl: 'https://relay.example', wireApi: 'chat_completions' },
    messages: [{ role: 'user', content: 'Use the root endpoint fallback.' }],
  });

  assert.equal(result.text, 'Relay root works.');
  assert.deepEqual(urls, [
    'https://relay.example/v1/chat/completions',
    'https://relay.example/chat/completions',
  ]);
});

test('ModelRunBroker supports deterministic compatibility callers plus retrieval and cancellation facades', async () => {
  let compatibilityInput;
  const lifecycleCalls = [];
  const gateway = {
    async retrieve(input) {
      lifecycleCalls.push(['retrieve', input]);
      return { responseId: 'resp-retrieved', raw: { id: 'resp-retrieved', output_text: 'Retrieved.' } };
    },
    async cancel(input) {
      lifecycleCalls.push(['cancel', input]);
      return { responseId: 'resp-cancelled', raw: { id: 'resp-cancelled', output_text: 'Cancelled.' } };
    },
  };
  const broker = createModelRunBroker({
    gateway,
    clock: sequenceClock(),
    compatibilityCaller: async (input) => {
      compatibilityInput = input;
      input.onEvent({ type: 'assistant.delta', delta: 'Fixture', text: 'Fixture' });
      return {
        text: 'Fixture complete.',
        calls: [{ id: 'fixture-call', name: 'copilot_workspace__read', input: { path: 'fixture.txt' } }],
        responseId: 'fixture-response',
        usage: { input_tokens: 2, output_tokens: 1 },
      };
    },
  });
  const events = [];
  const session = { provider: 'responses', model: 'model', baseUrl: 'https://models.example/v1', apiKey: 'session-secret', wireApi: 'responses' };

  const turn = await broker.runTurn({
    session,
    messages: [{ role: 'user', content: 'fixture' }],
    toolDefinitions: [TOOL],
    executionContext: { runId: 'run-fixture', token: 'hidden-token' },
    onEvent: (event) => events.push(event),
  });
  const retrieved = await broker.retrieve({ session, responseId: 'resp-retrieved' });
  const cancelled = await broker.cancel({ session, responseId: 'resp-cancelled' });

  assert.equal(compatibilityInput.executionContext.token, '[redacted]');
  assert.equal(compatibilityInput.session.apiKey, 'session-secret');
  assert.deepEqual(turn.calls, [{ id: 'fixture-call', wireId: 'fixture-call', name: 'workspace.read', input: { path: 'fixture.txt' } }]);
  assert.equal(events[0].type, 'assistant.delta');
  assert.equal(retrieved.text, 'Retrieved.');
  assert.equal(cancelled.text, 'Cancelled.');
  assert.deepEqual(lifecycleCalls.map(([name, input]) => [name, input.responseId]), [['retrieve', 'resp-retrieved'], ['cancel', 'resp-cancelled']]);
  assert.equal(Object.hasOwn(lifecycleCalls[0][1], '_executionContext'), false);
});

test('ModelRunBroker preserves cancellation before a transport call', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const broker = createModelRunBroker({
    gateway: { async complete() { throw new Error('should not execute'); } },
  });

  await assert.rejects(
    broker.runTurn({ session: { wireApi: 'chat_completions' }, signal: controller.signal }),
    (error) => error instanceof ModelRunBrokerError && error.code === 'MODEL_REQUEST_ABORTED',
  );
});

function sseResponse(records) {
  const body = records.map((item) => item === '[DONE]' ? 'data: [DONE]' : `data: ${JSON.stringify(item)}`).join('\n\n');
  return new Response(`${body}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sequenceClock() {
  let value = 0;
  return () => value += 10;
}
