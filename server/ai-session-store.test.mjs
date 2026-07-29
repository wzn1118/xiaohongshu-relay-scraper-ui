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

test('local free model creates a session and discovers installed models without an API key', async () => {
  const calls = [];
  const store = new AiSessionStore({
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen3:4b' }] }),
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
  assert.deepEqual(discovered.models, ['qwen3:4b']);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:11434/v1/models', authorization: undefined }]);

  const session = await store.create({
    provider: 'local_qwen',
    apiKey: '',
    model: 'qwen3:4b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    wireApi: 'chat_completions',
  });
  assert.equal(session.provider, 'local_qwen');
  assert.equal(session.configured, true);
});
