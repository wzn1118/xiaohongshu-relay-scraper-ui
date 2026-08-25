import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelGateway } from './model-gateway.mjs';

test('ModelGateway retries transient provider responses before returning the final response', async () => {
  let attempts = 0;
  const gateway = new ModelGateway({
    retryAttempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'READY' } }] }), { status: 200 });
    },
  });

  const result = await gateway.complete({
    provider: 'relay',
    model: 'gpt-5.6-sol',
    baseUrl: 'https://gateway.example/v1',
    wireApi: 'chat_completions',
    messages: [{ role: 'user', content: 'Reply READY.' }],
  });
  assert.equal(result.text, 'READY');
  assert.equal(attempts, 3);
  assert.deepEqual(gateway.reliability(), {
    timeoutMs: 120_000,
    retryAttempts: 3,
    retryDelayMs: 400,
    maxRetryDelayMs: 5_000,
    retryableStatuses: [408, 409, 425, 429, '5xx'],
  });
});

test('ModelGateway retries a streaming 503 before exposing the stream', async () => {
  let attempts = 0;
  const encoder = new TextEncoder();
  const gateway = new ModelGateway({
    retryAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('{}', { status: 503 });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"READY"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const events = [];
  for await (const event of gateway.stream({
    provider: 'relay',
    model: 'gpt-5.6-sol',
    baseUrl: 'https://gateway.example/v1',
    wireApi: 'chat_completions',
    messages: [{ role: 'user', content: 'Reply READY.' }],
  })) events.push(event);
  assert.equal(attempts, 2);
  assert.equal(events[0].delta, 'READY');
});
