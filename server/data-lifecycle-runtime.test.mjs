import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobManager } from './job-manager.mjs';
import { validateRunRequest } from './lib/contracts.mjs';

function fakeChild(pid, { closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };
  return child;
}

async function runtimeFixture(t, child, terminateImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-lifecycle-runtime-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runnerPath = path.join(dataDir, 'runner.py');
  await writeFile(runnerPath, '', 'utf8');
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath,
    spawnImpl: () => child,
    terminateImpl,
  });
  await manager.initialize();
  return manager;
}

function waitForEnd(manager, id, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${id}`));
    }, timeoutMs);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type !== 'end') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.data);
    });
  });
}

test('Job deletion quiescence terminates the child and releases every runtime owner', async (t) => {
  const child = fakeChild(64001);
  let terminated = 0;
  const manager = await runtimeFixture(t, child, async (target) => {
    terminated += 1;
    target.kill('SIGTERM');
  });
  const started = await manager.start(validateRunRequest({ checkOnly: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const eventTypes = [];
  const unsubscribe = manager.subscribe(started.id, (event) => eventTypes.push(event.type));

  await manager.quiesceForDeletion(started.id, { timeoutMs: 2000 });
  unsubscribe();

  assert.equal(terminated, 1);
  assert.equal(eventTypes[0], 'closing');
  assert.ok(eventTypes.includes('end'));
  assert.equal(manager.processes.has(started.id), false);
  assert.equal(manager.runtimeContexts.has(started.id), false);
  assert.equal(manager.liveCheckpointAnalyses.has(started.id), false);
  assert.notEqual(manager.active?.id, started.id);

  await assert.rejects(
    manager.resume(started.id),
    { code: 'JOB_DELETION_IN_PROGRESS' },
  );

  await manager.removeJobRecord(started.id);
  assert.equal(manager.get(started.id), null);
});

test('Job deletion quiescence fails closed when a child does not release resources', async (t) => {
  const child = fakeChild(64002, { closeOnKill: false });
  let terminated = 0;
  const manager = await runtimeFixture(t, child, async (target) => {
    terminated += 1;
    target.kill('SIGTERM');
  });
  const started = await manager.start(validateRunRequest({ checkOnly: true }));
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    manager.quiesceForDeletion(started.id, { timeoutMs: 30 }),
    { code: 'JOB_STOP_TIMEOUT' },
  );
  assert.equal(terminated, 1);
  assert.equal(manager.processes.has(started.id), true);
  assert.ok(manager.get(started.id));

  const ended = waitForEnd(manager, started.id);
  child.emit('close', null, 'SIGTERM');
  await ended;
});

test('retention quiescence leaves an active task untouched', async (t) => {
  const child = fakeChild(64003);
  let terminated = 0;
  const manager = await runtimeFixture(t, child, async () => { terminated += 1; });
  const started = await manager.start(validateRunRequest({ checkOnly: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const events = [];
  const unsubscribe = manager.subscribe(started.id, (event) => events.push(event.type));

  await assert.rejects(
    manager.quiesceForDeletion(started.id, { rejectActive: true }),
    { code: 'JOB_ACTIVE_RETENTION' },
  );
  unsubscribe();

  assert.equal(terminated, 0);
  assert.equal(manager.active?.id, started.id);
  assert.equal(manager.processes.has(started.id), true);
  assert.equal(events.includes('closing'), false);

  const ended = waitForEnd(manager, started.id);
  child.emit('close', 0, null);
  await ended;
});
