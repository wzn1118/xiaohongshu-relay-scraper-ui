import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { JobManager } from './job-manager.mjs';
import { createAudienceAiProfileRunner } from './lib/audience-ai-profile-runner.mjs';

test('JobManager serializes internal Relay subtasks without creating top-level jobs', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'relay-subtask-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const manager = new JobManager({ dataDir, pythonBin: 'python', runnerPath: 'runner.py' });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = manager.runRelaySubtask({ ownerId: 'first' }, async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  await waitFor(() => manager.relaySubtask?.ownerId === 'first');

  let waitEvents = 0;
  const second = manager.runRelaySubtask({
    ownerId: 'second',
    waitIntervalMs: 10,
    onWait: () => { waitEvents += 1; },
  }, async () => {
    order.push('second:start');
    order.push('second:end');
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['first:start']);
  assert.ok(waitEvents > 0);
  assert.equal(manager.list().length, 0);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(manager.relaySubtask, null);
  assert.equal(manager.list().length, 0);
});

test('profile runner passes explicit budgets, reports progress, and keeps collector checkpoint separate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audience-profile-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const job = { id: '20260801010101-abcdef12', outputDir, params: { relayPort: 19999 } };
  let leaseCalls = 0;
  let requestPayload;
  const events = [];
  const manager = {
    active: null,
    getInternal: (id) => id === job.id ? job : null,
    list: () => [{ id: job.id, config: {} }],
    runRelaySubtask: async (_options, operation) => {
      leaseCalls += 1;
      return operation();
    },
  };
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 2, 'SIGTERM');
    setImmediate(async () => {
      const requestPath = args[args.indexOf('--request') + 1];
      const checkpointPath = args[args.indexOf('--checkpoint') + 1];
      requestPayload = JSON.parse(await readFile(requestPath, 'utf8'));
      await writeFile(checkpointPath, JSON.stringify({
        schemaVersion: 1,
        jobId: job.id,
        postId: 'post-1',
        runId: 'run-1',
        profileMode: 'recent_public_posts',
        status: 'completed',
        targetUserCount: 2,
        completedUserCount: 2,
        failedUserCount: 0,
        profileHeaderCoverage: 2,
        recentPostCoverage: 2,
        recentPostsCollected: 3,
      }), 'utf8');
      child.stdout.write(`AUDIENCE_PROFILE_EVENT ${JSON.stringify({ status: 'collecting_profile_posts', completedUserCount: 1, targetUserCount: 2 })}\n`);
      child.stdout.end();
      child.emit('exit', 0, null);
    });
    return child;
  };
  const runner = createAudienceAiProfileRunner({
    manager,
    config: { projectRoot: root, pythonBin: 'python', audienceProfileSupplementPath: path.join(root, 'supplement.py') },
    spawnImpl,
  });
  const serviceCheckpointPath = path.join(root, 'checkpoint.json');
  const result = await runner({
    jobId: job.id,
    postId: 'post-1',
    runId: 'run-1',
    mode: 'recent_public_posts',
    userIds: ['user-1', 'user-2'],
    limits: { userLimit: 2, postsPerUser: 2, totalPosts: 3 },
    checkpointPath: serviceCheckpointPath,
    signal: new AbortController().signal,
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(leaseCalls, 1);
  assert.equal(requestPayload.outputDir, outputDir);
  assert.equal(requestPayload.profileUserLimit, 2);
  assert.equal(requestPayload.profilePostLimitPerUser, 2);
  assert.equal(requestPayload.profilePostTotalLimit, 3);
  assert.equal(requestPayload.relayPort, 19999);
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.recentProfilePostsCollected, 3);
  assert.ok(events.some((event) => event.stage === 'collecting_profile_posts'));
  await assert.rejects(readFile(serviceCheckpointPath, 'utf8'), { code: 'ENOENT' });
  const collectorCheckpoint = JSON.parse(await readFile(`${serviceCheckpointPath}.collector.json`, 'utf8'));
  assert.equal(collectorCheckpoint.completedUserCount, 2);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition.');
}
