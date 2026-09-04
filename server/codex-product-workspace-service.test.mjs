import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';

import { createCodexProductWorkspaceService } from './codex-product-workspace-service.mjs';

test('builds a writable source project and all historical task workspaces', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-product-workspace-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const jobs = [
    { id: '20260818010101-a1b2c3d4', keyword: '猫粮', status: 'completed', createdAt: '2026-08-18T01:01:01.000Z', updatedAt: '2026-08-18T01:05:01.000Z', artifactCount: 3 },
    { id: '20260818020202-e5f6a7b8', keyword: '咖啡', status: 'running', createdAt: '2026-08-18T02:02:02.000Z', updatedAt: '2026-08-18T02:03:02.000Z', artifactCount: 1 },
  ];
  const internal = new Map();
  for (const job of jobs) {
    const outputDir = path.join(root, 'data', job.id, 'artifacts');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'result.json'), '{}', 'utf8');
    internal.set(job.id, { ...job, outputDir });
  }
  const manager = {
    active: internal.get(jobs[1].id),
    list: () => jobs.map((job) => ({ ...job })),
    get: (id) => jobs.find((job) => job.id === id) || null,
    getInternal: (id) => internal.get(id) || null,
  };
  const service = createCodexProductWorkspaceService({ manager, workspaceRoot: root, productName: '产品源码' });

  const snapshot = service.snapshot();
  assert.equal(snapshot.source.name, '产品源码');
  assert.equal(snapshot.source.metadata.writable, true);
  assert.equal(snapshot.history.length, 2);
  assert.equal(snapshot.activeJobId, jobs[1].id);
  assert.equal(snapshot.history[0].metadata.jobId, jobs[0].id);
  assert.match(snapshot.history[0].name, /^Task - /u);

  const hostState = service.hostState(snapshot.history[0].id);
  assert.equal(hostState.projectOrder.length, 3);
  assert.equal(hostState.selectedProject.projectId, `product-job-${jobs[0].id}`);
  assert.equal(hostState.activeWorkspaceRoots[0], internal.get(jobs[0].id).outputDir);
});

test('source manifest excludes runtime data and caps files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-product-source-manifest-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.tsx'), 'export default 1;', 'utf8');
  await writeFile(path.join(root, 'data', 'secret.txt'), 'must not appear', 'utf8');
  const manager = { active: null, list: () => [], get: () => null, getInternal: () => null };
  const service = createCodexProductWorkspaceService({ manager, workspaceRoot: root });
  const manifest = await service.sourceManifest({ maxFiles: 1 });
  assert.equal(manifest.fileCount, 1);
  assert.ok(manifest.files.some((file) => file.path === 'src/App.tsx'));
  assert.equal(manifest.files.some((file) => file.path.startsWith('data/')), false);
  assert.equal(manifest.truncated, true);
});
