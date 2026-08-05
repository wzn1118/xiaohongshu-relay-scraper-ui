import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationContactResolutionService } from './application-contact-resolution-service.mjs';

async function fixtureDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'contact-resolution-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('reuses a stable resolution and refreshes when a comment checkpoint changes', async (t) => {
  const outputDir = await fixtureDir(t);
  const commentsPath = path.join(outputDir, 'audience-comments.json');
  await writeFile(commentsPath, '[]\n', 'utf8');
  const counters = { load: 0, resolve: 0 };
  const service = new ApplicationContactResolutionService({
    loadRecords: async () => {
      counters.load += 1;
      return [{ note_id: 'note-1' }];
    },
    resolveBatch: async () => {
      counters.resolve += 1;
      return [{ status: 'pending' }];
    },
    buildReport: (records, resolutions) => ({
      summary: { totalRecords: records.length, status: resolutions[0].status },
      items: resolutions,
    }),
  });

  const first = await service.refresh({ outputDir });
  const second = await service.refresh({ outputDir });
  assert.equal(first.generatedAt, second.generatedAt);
  assert.deepEqual(counters, { load: 1, resolve: 1 });

  await writeFile(commentsPath, '[{"comment_id":"comment-1","post_id":"note-1"}]\n', 'utf8');
  const future = new Date(Date.now() + 2_000);
  await utimes(commentsPath, future, future);
  const third = await service.refresh({ outputDir });
  assert.notEqual(third.generatedAt, first.generatedAt);
  assert.deepEqual(counters, { load: 2, resolve: 2 });

  const persisted = JSON.parse(await readFile(path.join(outputDir, 'application-contact-resolution.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.match(persisted.sourceSignature, /^algorithm\|body-email-short-circuit:v1\n/u);
  assert.equal(persisted.report.summary.totalRecords, 1);
  assert.equal(persisted.sourceSignature, third.sourceSignature);
});

test('a new service can load a persisted cache without resolving again', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeFile(path.join(outputDir, 'application_intelligence.json'), '[]\n', 'utf8');
  const firstService = new ApplicationContactResolutionService({
    loadRecords: async () => [],
    resolveBatch: async () => [],
    buildReport: () => ({ summary: { totalRecords: 0 }, items: [] }),
  });
  const first = await firstService.refresh({ outputDir });

  let resolved = false;
  const secondService = new ApplicationContactResolutionService({
    loadRecords: async () => [],
    resolveBatch: async () => {
      resolved = true;
      return [];
    },
    buildReport: () => ({ summary: { totalRecords: 0 }, items: [] }),
  });
  const cached = await secondService.refresh({ outputDir });
  assert.equal(cached.sourceSignature, first.sourceSignature);
  assert.equal(resolved, false);
  assert.equal((await secondService.read(outputDir)).generatedAt, first.generatedAt);
});
