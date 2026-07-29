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
    assert.equal(first.providers().find((item) => item.id === 'codex').hasApiKey, true);

    const second = new AiSessionStore({ filePath });
    await second.initialize();
    const reused = await second.create({ provider: 'codex', apiKey: '', baseUrl: 'https://relay.example/v1', model: 'gpt-5.5', wireApi: 'responses' });
    assert.equal(reused.baseUrl, 'https://relay.example/v1');
    assert.equal((JSON.parse(await readFile(filePath, 'utf8')).providers.codex.apiKey), 'secret-key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
