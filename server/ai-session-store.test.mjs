import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiSessionStore } from './ai-session-store.mjs';

test('AI provider relay configuration persists without exposing the API key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-ai-config-'));
  const filePath = path.join(directory, 'ai-config.json');
  try {
    const first = new AiSessionStore({ filePath });
    await first.initialize();
    const session = await first.create({
      provider: 'codex',
      apiKey: 'secret-key',
      baseUrl: 'https://relay.example/v1',
      model: 'gpt-5.5',
      wireApi: 'responses',
    });
    assert.equal(session.wireApi, 'responses');
    assert.equal('apiKey' in session, false);
    const provider = first.providers().find((item) => item.id === 'codex');
    assert.equal(provider.hasApiKey, true);
    assert.ok(provider.models.includes('gpt-5.6-terra'));
    assert.ok(provider.models.includes('gpt-5.5'));
    assert.equal('apiKey' in provider, false);

    const second = new AiSessionStore({ filePath });
    await second.initialize();
    const reused = await second.create({ provider: 'codex', apiKey: '', baseUrl: 'https://relay.example/v1', model: 'gpt-5.5', wireApi: 'responses' });
    assert.equal(reused.baseUrl, 'https://relay.example/v1');
    assert.equal((JSON.parse(await readFile(filePath, 'utf8')).providers.codex.apiKey), 'secret-key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired or server-restarted AI sessions expose a recoverable error code', () => {
  const store = new AiSessionStore();
  assert.throws(
    () => store.resolve('missing-session'),
    (error) => error.code === 'AI_SESSION_EXPIRED' && /missing or expired/i.test(error.message),
  );
});

test('AI model discovery reuses a saved key only for its saved Base URL', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'model-10' }, { id: 'model-2' }, { id: 'model-2' }, { id: 'invalid model' }] }),
      };
    },
  });
  await store.create({
    provider: 'openai',
    apiKey: 'secret-key',
    baseUrl: 'https://api.example/v1',
    model: 'model-2',
    wireApi: 'chat_completions',
  });

  const result = await store.discoverModels({ provider: 'openai', apiKey: '', baseUrl: 'https://api.example/v1/' });
  assert.deepEqual(result.models, ['model-2', 'model-10']);
  assert.deepEqual(calls, [{ url: 'https://api.example/v1/models', authorization: 'Bearer secret-key' }]);
  assert.equal('apiKey' in result, false);

  await assert.rejects(
    store.discoverModels({ provider: 'openai', apiKey: '', baseUrl: 'https://other.example/v1' }),
    (error) => error.code === 'AI_VALIDATION',
  );
});

test('AI session creation never reuses a saved key for a different Base URL', async () => {
  const store = new AiSessionStore();
  await store.create({
    provider: 'openai',
    apiKey: 'secret-key',
    baseUrl: 'https://first.example/v1',
    model: 'model-a',
    wireApi: 'chat_completions',
  });

  await assert.rejects(
    store.create({
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://second.example/v1',
      model: 'model-b',
      wireApi: 'chat_completions',
    }),
    (error) => error.code === 'AI_VALIDATION' && /API key/i.test(error.message),
  );
});

test('local free model creates a session and discovers installed models without an API key', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen3.5:4b' }] }),
      };
    },
  });

  const provider = store.providers().find((item) => item.id === 'local_qwen');
  assert.equal(provider.requiresKey, false);
  assert.equal(provider.free, true);
  assert.equal(provider.local, true);

  const discovered = await store.discoverModels({
    provider: 'local_qwen',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  assert.equal(provider.model, 'qwen3.5:4b');
  assert.ok(provider.models.includes('qwen3.5:2b'));
  assert.ok(provider.models.includes('gemma3:4b'));
  assert.ok(provider.models.includes('llama3.2:3b'));
  assert.ok(provider.models.includes('deepseek-r1:7b'));
  assert.deepEqual(discovered.models, ['qwen3.5:4b']);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:11434/v1/models', authorization: undefined }]);

  const session = await store.create({
    provider: 'local_qwen',
    apiKey: '',
    model: 'qwen3.5:4b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    wireApi: 'chat_completions',
  });
  assert.equal(session.provider, 'local_qwen');
  assert.equal(session.configured, true);
});

test('local free model uses the configured internal HTTPS runtime endpoint', () => {
  const store = new AiSessionStore({ localModelEndpoint: 'https://ollama.internal.example/' });
  const provider = store.providers().find((item) => item.id === 'local_qwen');
  assert.equal(provider.baseUrl, 'https://ollama.internal.example/v1');
});

test('local free model ignores a browser-supplied endpoint and keeps the deployment endpoint', async () => {
  const store = new AiSessionStore({ localModelEndpoint: 'https://ollama.internal.example' });
  const session = await store.create({
    provider: 'local_qwen',
    model: 'qwen3.5:4b',
    baseUrl: 'https://untrusted.example/v1',
    wireApi: 'chat_completions',
  });
  assert.equal(session.baseUrl, 'https://ollama.internal.example/v1');
});

test('relay provider normalizes a pasted endpoint and exposes relay capabilities', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { models: [{ name: 'relay-model-2' }, { id: 'relay-model-1' }] } }),
      };
    },
  });

  const provider = store.providers().find((item) => item.id === 'relay');
  assert.equal(provider.relay, true);
  assert.equal(provider.wireApi, 'chat_completions');

  const discovered = await store.discoverModels({
    provider: 'relay',
    apiKey: 'relay-key',
    baseUrl: 'https://gateway.example/v1/chat/completions?ignored=true',
  });
  assert.equal(discovered.baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(discovered.models, ['relay-model-1', 'relay-model-2']);
  assert.deepEqual(calls, ['https://gateway.example/v1/models']);

  const session = await store.create({
    provider: 'relay',
    apiKey: 'relay-key',
    baseUrl: 'https://gateway.example/v1/responses',
    model: 'relay-model-1',
    wireApi: 'chat_completions',
  });
  assert.equal(session.baseUrl, 'https://gateway.example/v1');
  assert.equal(session.provider, 'relay');
});

test('relay model discovery prefers the standard v1 endpoint from a host root', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ([{ id: 'fallback-model' }]),
      };
    },
  });

  const discovered = await store.discoverModels({
    provider: 'relay',
    apiKey: 'relay-key',
    baseUrl: 'https://gateway.example',
  });
  assert.equal(discovered.baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(discovered.models, ['fallback-model']);
  assert.deepEqual(calls, ['https://gateway.example/v1/models']);
});

test('relay model discovery falls back to a root-only compatible endpoint', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://gateway.example/v1/models') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'root-model' }] }) };
    },
  });

  const discovered = await store.discoverModels({
    provider: 'relay',
    apiKey: 'relay-key',
    baseUrl: 'https://gateway.example',
  });
  assert.equal(discovered.baseUrl, 'https://gateway.example');
  assert.deepEqual(discovered.models, ['root-model']);
  assert.deepEqual(calls, ['https://gateway.example/v1/models', 'https://gateway.example/models']);
});

test('relay model discovery explains authentication failures without trying another path', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: false, status: 401, json: async () => ({}) };
    },
  });

  await assert.rejects(
    store.discoverModels({ provider: 'relay', apiKey: 'bad-key', baseUrl: 'https://gateway.example' }),
    (error) => error.code === 'AI_MODEL_DISCOVERY_FAILED' && /API Key/u.test(error.message),
  );
  assert.deepEqual(calls, ['https://gateway.example/v1/models']);
});
