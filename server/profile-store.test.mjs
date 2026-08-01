import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileStore, profileAiEnvironment } from './profile-store.mjs';

test('profile AI environment mirrors the selected model session exactly', () => {
  assert.deepEqual(
    profileAiEnvironment({
      provider: 'relay',
      apiKey: 'relay-key',
      baseUrl: 'https://relay.example/v1',
      model: 'selected-model',
      wireApi: 'chat_completions',
    }),
    {
      XHS_AI_PROVIDER: 'relay',
      XHS_AI_API_KEY: 'relay-key',
      XHS_AI_BASE_URL: 'https://relay.example/v1',
      XHS_AI_MODEL: 'selected-model',
      XHS_AI_WIRE_API: 'chat_completions',
    },
  );
  assert.throws(
    () => profileAiEnvironment({
      provider: 'relay',
      apiKey: '',
      baseUrl: 'https://relay.example/v1',
      model: 'selected-model',
      wireApi: 'chat_completions',
    }),
    (error) => error.code === 'PROFILE_AI_SESSION_REQUIRED',
  );
  assert.doesNotThrow(() => profileAiEnvironment({
    provider: 'local_qwen',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5:4b',
    wireApi: 'chat_completions',
  }));
});

test('profile import passes the selected route to the parser process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-profile-store-'));
  const parserPath = path.join(directory, 'fake-profile-parser.mjs');
  const profileRoot = path.join(directory, 'profiles');
  try {
    await writeFile(parserPath, `
      import { writeFileSync } from 'node:fs';
      const outputIndex = process.argv.indexOf('--output');
      const output = process.argv[outputIndex + 1];
      writeFileSync(output, JSON.stringify({
        display_name: 'route-check',
        updatedAt: '2026-08-01T00:00:00Z',
        analysis_runtime: {
          provider: process.env.XHS_AI_PROVIDER,
          model: process.env.XHS_AI_MODEL,
          base_url: process.env.XHS_AI_BASE_URL,
          wire_api: process.env.XHS_AI_WIRE_API,
          fallback_used: false
        }
      }));
    `, 'utf8');
    const store = new ProfileStore({
      root: profileRoot,
      pythonBin: process.execPath,
      scriptPath: parserPath,
    });
    await store.initialize();
    const profile = await store.create(
      { files: [{ name: 'resume.txt', base64: Buffer.from('resume').toString('base64') }] },
      {
        provider: 'relay',
        apiKey: 'relay-key',
        baseUrl: 'https://relay.example/v1',
        model: 'selected-model',
        wireApi: 'chat_completions',
      },
    );

    assert.deepEqual(profile.analysis_runtime, {
      provider: 'relay',
      model: 'selected-model',
      base_url: 'https://relay.example/v1',
      wire_api: 'chat_completions',
      fallback_used: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
