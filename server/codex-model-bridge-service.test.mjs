import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexModelBridgeService, mapResponsesToChat } from './codex-model-bridge-service.mjs';

const upstream = {
  provider: 'relay',
  apiKey: 'upstream-secret',
  baseUrl: 'https://relay.example/v1',
  model: 'gpt-5.6-sol',
  wireApi: 'chat_completions',
};

function sessions() {
  return {
    controlProvider: () => ({ ...upstream }),
    controlProviderStatus: () => ({ configured: true, provider: 'relay', baseUrl: upstream.baseUrl, model: upstream.model, wireApi: upstream.wireApi }),
  };
}

test('maps Responses messages, function outputs, and custom tools to Chat Completions', () => {
  const mapped = mapResponsesToChat({
    instructions: 'Use product tools.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect task.' }] },
      { type: 'function_call', call_id: 'call_list', name: 'list_jobs', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_list', output: { jobs: [1] } },
      { type: 'additional_tools', tools: [{ type: 'function', name: 'product_status', description: 'Read status', input_schema: { type: 'object', properties: {} } }] },
    ],
    tools: [
      { type: 'function', name: 'list_jobs', description: 'List jobs', parameters: { type: 'object', properties: {} } },
      { type: 'custom', name: 'apply_patch', description: 'Apply a patch' },
    ],
  });
  assert.equal(mapped.messages[0].role, 'system');
  assert.equal(mapped.messages[1].content, 'Inspect task.');
  assert.equal(mapped.messages[2].tool_calls[0].function.name, 'list_jobs');
  assert.equal(mapped.messages[3].role, 'tool');
  assert.equal(mapped.tools[0].function.name, 'list_jobs');
  assert.equal(mapped.tools[1].function.parameters.required[0], 'input');
  assert.equal(mapped.tools[2].function.name, 'product_status');
  assert.deepEqual(mapped.tools[2].function.parameters, { type: 'object', properties: {} });
  assert.equal(mapped.toolTypes.get('apply_patch'), 'custom');
});

test('returns a Responses completion and keeps both credentials out of public status', async () => {
  const calls = [];
  const bridge = createCodexModelBridgeService({
    aiSessions: sessions(),
    token: 'bridge-secret',
    now: () => new Date('2026-08-19T00:00:00.000Z'),
    gateway: {
      complete: async (request) => {
        calls.push(request);
        return {
          raw: {
            id: 'chatcmpl_123',
            model: 'gpt-5.6-sol',
            choices: [{ message: { content: 'Ready', tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] } }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          },
        };
      },
    },
  });
  const result = await bridge.responses({
    model: 'gpt-5.6-sol',
    input: 'Update the project.',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
  }, { authorization: 'Bearer bridge-secret', remoteAddress: '127.0.0.1' });
  assert.equal(result.stream, false);
  assert.equal(result.body.object, 'response');
  assert.equal(result.body.output[0].content[0].text, 'Ready');
  assert.equal(result.body.output[1].type, 'custom_tool_call');
  assert.equal(result.body.output[1].input, '*** Begin Patch');
  assert.equal(result.body.usage.input_tokens, 11);
  assert.equal(calls[0].apiKey, 'upstream-secret');
  const publicStatus = JSON.stringify(bridge.status());
  assert.equal(publicStatus.includes('bridge-secret'), false);
  assert.equal(publicStatus.includes('upstream-secret'), false);
  assert.equal(bridge.status().health.state, 'ready');
  assert.equal(bridge.status().health.inFlight, 0);
  assert.equal(bridge.status().health.latency.samples, 1);
});

test('streams low-latency Responses text and function-call events', async () => {
  const bridge = createCodexModelBridgeService({
    aiSessions: sessions(),
    token: 'bridge-secret',
    gateway: {
      async *stream() {
        yield { raw: { model: 'gpt-5.6-sol', choices: [{ delta: { content: 'A' } }] } };
        yield { raw: { choices: [{ delta: { content: 'B' } }] } };
        yield { raw: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_jobs', function: { name: 'list_jobs', arguments: '{' } }] } }] } };
        yield {
          raw: {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          },
        };
      },
    },
  });
  const result = await bridge.responses({
    stream: true,
    input: 'List jobs.',
    tools: [{ type: 'function', name: 'list_jobs', parameters: { type: 'object', properties: {} } }],
  }, { authorization: 'Bearer bridge-secret', remoteAddress: '::1' });
  const events = [];
  for await (const event of result.events) events.push(event);
  assert.equal(events[0].type, 'response.created');
  assert.deepEqual(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta), ['A', 'B']);
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.done' && event.arguments === '{}'), true);
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.status, 'completed');
  assert.equal(completed.response.output.some((item) => item.name === 'list_jobs'), true);
  assert.equal(completed.response.usage.total_tokens, 7);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.equal(bridge.status().health.state, 'ready');
  assert.equal(bridge.status().health.inFlight, 0);
});

test('probes the configured upstream and publishes readiness without counting a user turn', async () => {
  const calls = [];
  const bridge = createCodexModelBridgeService({
    aiSessions: sessions(),
    token: 'bridge-secret',
    now: () => new Date('2026-08-19T00:00:00.000Z'),
    gateway: {
      complete: async (request) => {
        calls.push(request);
        return { text: 'READY', raw: { choices: [{ message: { content: 'READY' } }] } };
      },
      reliability: () => ({ timeoutMs: 30_000, retryAttempts: 3, retryDelayMs: 400 }),
    },
  });
  const result = await bridge.probe();
  assert.equal(result.ok, true);
  assert.equal(result.response, 'READY');
  assert.equal(result.health.state, 'ready');
  assert.equal(calls[0].model, upstream.model);
  assert.equal(calls[0].apiKey, 'upstream-secret');
  assert.equal(bridge.status().requests, 0);
  assert.equal(bridge.status().health.probes.total, 1);
  assert.equal(JSON.stringify(bridge.status()).includes('upstream-secret'), false);
});

test('marks a failed upstream probe as degraded and keeps the bridge available for recovery', async () => {
  const upstreamError = Object.assign(new Error('temporary upstream failure'), { code: 'MODEL_UPSTREAM_UNAVAILABLE', status: 503 });
  const bridge = createCodexModelBridgeService({
    aiSessions: sessions(),
    token: 'bridge-secret',
    now: () => new Date('2026-08-19T00:00:00.000Z'),
    gateway: { complete: async () => { throw upstreamError; } },
  });
  await assert.rejects(bridge.probe(), (error) => (
    error.code === 'CODEX_MODEL_PROBE_FAILED'
    && error.status === 503
    && error.details?.health?.state === 'degraded'
  ));
  const status = bridge.status();
  assert.equal(status.health.state, 'degraded');
  assert.equal(status.health.inFlight, 0);
  assert.equal(status.health.consecutiveFailures, 1);
  assert.equal(status.health.probes.failed, 1);
  assert.equal(status.failed, 0);
});

test('rejects non-loopback and invalid bridge credentials', async () => {
  const bridge = createCodexModelBridgeService({ aiSessions: sessions(), token: 'bridge-secret', gateway: {} });
  await assert.rejects(
    bridge.responses({ input: 'hello' }, { authorization: 'Bearer bridge-secret', remoteAddress: '10.0.0.2' }),
    (error) => error.code === 'CODEX_MODEL_BRIDGE_LOOPBACK_REQUIRED' && error.status === 403,
  );
  await assert.rejects(
    bridge.responses({ input: 'hello' }, { authorization: 'Bearer wrong', remoteAddress: '127.0.0.1' }),
    (error) => error.code === 'CODEX_MODEL_BRIDGE_UNAUTHORIZED' && error.status === 401,
  );
});
