import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { RelayConfigStore } from './relay-config-store.mjs';

test('relay configuration persists and reloads across store instances', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-relay-config-'));
  const filePath = path.join(fixture, 'relay-config.json');
  try {
    const first = new RelayConfigStore({ filePath });
    assert.deepEqual(await first.initialize(), { port: 18800, profile: 'openclaw', autoConnect: true });
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

test('migrates the old default relay to the managed browser profile', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-relay-legacy-'));
  const filePath = path.join(fixture, 'relay-config.json');
  try {
    await writeFile(filePath, JSON.stringify({
      port: 18792,
      profile: 'chrome',
      autoConnect: true,
    }), 'utf8');
    const store = new RelayConfigStore({ filePath });
    assert.deepEqual(await store.initialize(), { port: 18800, profile: 'openclaw', autoConnect: true });
    assert.match(await readFile(filePath, 'utf8'), /"port": 18800/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
