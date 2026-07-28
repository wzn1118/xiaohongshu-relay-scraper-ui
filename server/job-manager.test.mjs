import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JobManager } from './job-manager.mjs';
import { validateRunRequest } from './lib/contracts.mjs';

test('JobManager persists history and enforces a single active task', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-manager-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  let spawnOptions;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    maxHistory: 10,
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });

  try {
    await manager.initialize();
    const job = await manager.start(validateRunRequest({ checkOnly: true }));
    assert.equal(spawnOptions.env.PYTHONUTF8, '1');
    assert.equal(spawnOptions.env.PYTHONIOENCODING, 'utf-8');
    await assert.rejects(manager.start(validateRunRequest({})), (error) => error.code === 'JOB_BUSY');
    assert.equal(manager.get(job.id).status, 'running');
    const ended = new Promise((resolve) => {
      const unsubscribe = manager.subscribe(job.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve();
        }
      });
    });
    const cancellation = await manager.cancel(job.id);
    assert.equal(cancellation.changed, true);
    await ended;
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].id, job.id);
    assert.equal(history[0].status, 'cancelled');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
