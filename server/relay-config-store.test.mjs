import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { RelayConfigStore } from './relay-config-store.mjs';

test('relay configuration persists and reloads across store instances', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-relay-config-'));
  const filePath = path.join(fixture, 'relay-config.json');
  try {
    const first = new RelayConfigStore({ filePath });
    assert.deepEqual(await first.initialize(), { port: 18792, profile: 'chrome', autoConnect: true });
    const saved = await first.update({ port: 18801, profile: 'work-profile', autoConnect: false });
    assert.deepEqual(saved, { port: 18801, profile: 'work-profile', autoConnect: false });

    const second = new RelayConfigStore({ filePath });
    assert.deepEqual(await second.initialize(), saved);
    assert.match(await readFile(filePath, 'utf8'), /work-profile/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('relay configuration rejects invalid values', async () => {
  const store = new RelayConfigStore({ filePath: path.join(os.tmpdir(), `xhs-relay-config-${Date.now()}.json`) });
  await store.initialize();
  await assert.rejects(() => store.update({ port: 80 }), { code: 'RELAY_CONFIG_VALIDATION' });
  await assert.rejects(() => store.update({ profile: 'bad profile' }), { code: 'RELAY_CONFIG_VALIDATION' });
  await assert.rejects(() => store.update({ autoConnect: 'yes' }), { code: 'RELAY_CONFIG_VALIDATION' });
});
