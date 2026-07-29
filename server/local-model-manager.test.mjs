import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalModelManager } from './local-model-manager.mjs';

test('local model status exposes curated and installed extension models', async () => {
  const manager = new LocalModelManager({
    fetchImpl: async (url) => {
      if (url.endsWith('/api/version')) return Response.json({ version: '0.32.5' });
      return Response.json({ models: [
        { name: 'qwen3.5:4b', size: 3389983735, modified_at: '2026-07-29T00:00:00Z' },
        { name: 'qwen3-vl:4b', size: 3500000000, modified_at: '2026-07-29T00:00:00Z' },
      ] });
    },
  });

  const status = await manager.status();
  assert.equal(status.runtime.ready, true);
  assert.equal(status.runtime.version, '0.32.5');
  assert.equal(status.catalog.find((item) => item.id === 'qwen3.5:4b').installed, true);
  assert.equal(status.catalog.find((item) => item.id === 'qwen3.5:4b').recommended, true);
  assert.equal(status.catalog.length, 15);
  assert.equal(new Set(status.catalog.map((item) => item.id)).size, 15);
  assert.deepEqual(
    [...new Set(status.catalog.map((item) => item.family))],
    ['Qwen3.5', 'Qwen3', 'Gemma 3', 'Llama 3.2', 'DeepSeek-R1', '本机扩展'],
  );
  assert.equal(status.catalog.find((item) => item.id === 'gemma3:4b').tier, '均衡');
  assert.equal(status.catalog.find((item) => item.id === 'deepseek-r1:7b').tier, '质量推理');
  assert.equal(status.catalog.find((item) => item.id === 'qwen3-vl:4b').custom, true);
  assert.equal(status.catalog.find((item) => item.id === 'qwen3-vl:4b').installed, true);
});

test('local model installation validates IDs and parses pull progress', async () => {
  const calls = [];
  const manager = new LocalModelManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body || '' });
      if (url.endsWith('/api/version')) return Response.json({ version: '0.32.5' });
      if (url.endsWith('/api/tags')) return Response.json({ models: [] });
      return new Response([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'pulling layer', total: 2_741_192_820, completed: 2_000_000_000 }),
        JSON.stringify({ status: 'pulling checksum', total: 475, completed: 475 }),
        JSON.stringify({ status: 'success' }),
      ].join('\n'));
    },
  });

  await assert.rejects(() => manager.startInstall('../not-allowed'), (error) => error.code === 'LOCAL_MODEL_VALIDATION');
  const started = await manager.startInstall('qwen3.5:2b');
  assert.equal(started.status, 'queued');
  await waitFor(() => manager.publicJob()?.status === 'completed');
  const completed = manager.publicJob();
  assert.equal(completed.progress, 100);
  assert.equal(completed.completedBytes, 2_741_192_820);
  assert.equal(completed.totalBytes, 2_741_192_820);
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith('/api/pull')).body).model, 'qwen3.5:2b');
});

test('local model installation accepts an extensible Ollama model ID', async () => {
  const calls = [];
  const manager = new LocalModelManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body || '' });
      if (url.endsWith('/api/version')) return Response.json({ version: '0.32.5' });
      if (url.endsWith('/api/tags')) return Response.json({ models: [] });
      return new Response(JSON.stringify({ status: 'success' }));
    },
  });

  const modelId = 'hf.co/example/model-GGUF:Q4_K_M';
  const started = await manager.startInstall(modelId);
  assert.equal(started.modelId, modelId);
  await waitFor(() => manager.publicJob()?.status === 'completed');
  const pull = calls.find((call) => call.url.endsWith('/api/pull'));
  assert.equal(JSON.parse(pull.body).model, modelId);
});

test('local model installation reports a missing runtime without starting a pull', async () => {
  const manager = new LocalModelManager({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(
    () => manager.startInstall('qwen3.5:4b'),
    (error) => error.code === 'LOCAL_MODEL_RUNTIME_UNAVAILABLE',
  );
  assert.equal(manager.publicJob(), null);
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}
