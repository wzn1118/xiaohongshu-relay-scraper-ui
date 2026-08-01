import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JobManager, bodyMetricsForJob, publicJob, updateProgressFromLog } from './job-manager.mjs';
import { validateExpansionStartRequest, validateRunRequest } from './lib/contracts.mjs';
import { emptyWorkflowStages } from './lib/workflow-state.mjs';

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  return child;
}

function waitForJob(manager, id, predicate, timeoutMs = 3000) {
  const current = manager.get(id);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for job ${id}; current status: ${manager.get(id)?.status || 'missing'}`));
    }, timeoutMs);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type !== 'state' || !predicate(event.data)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.data);
    });
  });
}

function waitForEnd(manager, id, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for job ${id} to end`));
    }, timeoutMs);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type !== 'end') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.data);
    });
  });
}

async function waitForCondition(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

test('audience partial completion keeps attempted coverage separate from strict completion', () => {
  const job = { progress: 0 };

  const changed = updateProgressFromLog(
    job,
    'AUDIENCE_COMPLETE posts=0/80 comments=34 users=84 profiles=2/84 status=partial attempted=7 with_comments=4',
  );

  assert.equal(changed, true);
  assert.equal(job.progressCurrent, 7);
  assert.equal(job.progressTotal, 80);
  assert.match(job.progressLabel, /7 \/ 80/);
  assert.match(job.progressLabel, /4/);
  assert.doesNotMatch(job.progressLabel, /84 \/ 80/);
});

test('audience rate limits expose automatic backoff, recovery, and exhaustion states', () => {
  const job = { progress: 0 };

  assert.equal(updateProgressFromLog(job, 'AUDIENCE_RATE_LIMIT retry=2/5 wait=30s; checkpoint preserved'), true);
  assert.equal(job.progressPhase, 'rate_limit_backoff');
  assert.equal(job.rateLimit.status, 'waiting');
  assert.equal(job.rateLimit.retryAttempt, 2);
  assert.equal(job.rateLimit.maxRetries, 5);
  assert.equal(job.rateLimit.retryAfterSeconds, 30);

  assert.equal(updateProgressFromLog(job, 'AUDIENCE_RATE_LIMIT waiting attempt=2/5 remaining=10s'), true);
  assert.equal(job.rateLimit.retryAfterSeconds, 10);
  assert.match(job.progressLabel, /剩余 10 秒/);

  assert.equal(updateProgressFromLog(job, 'AUDIENCE_RATE_LIMIT manual_probe attempt=2/5; skipping remaining cooldown'), true);
  assert.equal(job.progressPhase, 'rate_limit_probe');
  assert.equal(job.rateLimit.status, 'waiting');
  assert.equal(job.rateLimit.retryAfterSeconds, 0);
  assert.equal(job.rateLimit.recoveryAction, 'manual_probe');

  assert.equal(updateProgressFromLog(job, 'AUDIENCE_RATE_LIMIT cleared retry=2/5; resuming'), true);
  assert.equal(job.rateLimit.status, 'cleared');
  assert.equal(job.progressPhase, 'audience_comments');

  assert.equal(updateProgressFromLog(job, 'AUDIENCE_RATE_LIMIT exhausted retries=5; checkpoint preserved'), true);
  assert.equal(job.rateLimit.status, 'stopped');
  assert.equal(job.progressPhase, 'rate_limited');
  assert.equal(job.rateLimit.recoveryAction, 'wait_then_resume');
});

test('manual rate-limit recovery signals a running audience collector without replacing its checkpoint', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-rate-limit-manual-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260801090000-a11a0001';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'Saved post' },
  ]), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'general', keyword: 'saved-content' },
  }]), 'utf8');

  const child = createFakeChild(81001);
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
  });

  try {
    await manager.initialize();
    const started = await manager.resume(jobId, {
      scope: 'audience',
      params: validateRunRequest({
        analysisMode: 'general',
        keyword: 'saved-content',
        mode: 'resume',
        resumeFromJobId: jobId,
        collectAudience: true,
        audienceOnly: true,
        checkOnly: false,
      }),
    });
    await waitForJob(manager, started.id, (job) => job.status === 'running');
    child.stdout.write('AUDIENCE_RATE_LIMIT retry=1/5 wait=30s; checkpoint preserved\n');
    await waitForJob(manager, jobId, (job) => job.rateLimit?.status === 'waiting');

    const recovery = await manager.signalRateLimitRecovery(jobId);
    assert.equal(recovery.signaled, true);
    assert.equal(recovery.job.id, jobId);
    assert.equal(manager.list().length, 1);
    assert.match(
      await readFile(path.join(outputDir, '.rate-limit-recover.request'), 'utf8'),
      /^\d{4}-\d{2}-\d{2}T/,
    );

    child.stdout.write('AUDIENCE_RATE_LIMIT manual_probe attempt=1/5; skipping remaining cooldown\n');
    await waitForJob(manager, jobId, (job) => job.progressPhase === 'rate_limit_probe');
    assert.equal(manager.get(jobId).rateLimit.recoveryAction, 'manual_probe');

    const ended = waitForEnd(manager, jobId);
    child.stdout.write('AUDIENCE_RATE_LIMIT cleared retry=1/5; resuming\n');
    child.emit('close', 0, null);
    await ended;
    assert.equal(manager.get(jobId).status, 'completed');
    assert.equal(manager.get(jobId).rateLimit.status, 'cleared');
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('exhausted audience rate limits automatically resume the same task from its checkpoint', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-rate-limit-auto-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260801091000-a1700001';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', title: 'Saved post' },
  ]), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'general', keyword: 'saved-content' },
  }]), 'utf8');

  const children = [createFakeChild(81002), createFakeChild(81003)];
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => children[spawnCount++],
    rateLimitRecovery: {
      enabled: true,
      initialDelayMs: 250,
      maxDelayMs: 250,
      maxAttempts: 2,
      busyDelayMs: 5,
    },
  });

  try {
    await manager.initialize();
    const first = await manager.resume(jobId, {
      scope: 'audience',
      params: validateRunRequest({
        analysisMode: 'general',
        keyword: 'saved-content',
        mode: 'resume',
        resumeFromJobId: jobId,
        collectAudience: true,
        audienceOnly: true,
        checkOnly: false,
      }),
    });
    await waitForJob(manager, first.id, (job) => job.status === 'running');
    const firstEnded = waitForEnd(manager, jobId);
    children[0].stdout.write('AUDIENCE_RATE_LIMIT exhausted retries=5; checkpoint preserved\n');
    children[0].emit('close', 1, null);
    await firstEnded;

    const scheduled = manager.get(jobId);
    assert.equal(scheduled.status, 'failed');
    assert.equal(scheduled.rateLimit.status, 'scheduled');
    assert.equal(scheduled.rateLimit.autoRecoveryEnabled, true);
    assert.equal(scheduled.rateLimit.autoResumeAttempt, 0);
    assert.equal(manager.list().length, 1);

    const automaticallyResumed = await waitForJob(
      manager,
      jobId,
      (job) => job.status === 'running' && job.rateLimit?.autoResumeAttempt === 1,
    );
    await waitForCondition(() => spawnCount === 2);
    assert.equal(spawnCount, 2);
    assert.equal(automaticallyResumed.id, jobId);
    assert.equal(automaticallyResumed.outputDir, outputDir);
    assert.equal(automaticallyResumed.attempts.at(-1).requestedBy, 'rate_limit_auto_recovery');
    assert.equal(automaticallyResumed.attempts.at(-1).resumeScope, 'audience');

    const secondEnded = waitForEnd(manager, jobId);
    children[1].stdout.write('AUDIENCE_RATE_LIMIT cleared retry=1/5; resuming\n');
    children[1].stdout.write('AUDIENCE_PROGRESS posts=1/1 comments=3 users=2 profiles=2/2 processed=1/1 phase=comments\n');
    children[1].emit('close', 0, null);
    await secondEnded;
    const completed = manager.get(jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.rateLimit.status, 'cleared');
    assert.equal(completed.resumeCount, 2);
    assert.equal(manager.list().length, 1);
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('body completion falls back from an inherited expired AI session but rejects an explicit expired session', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-body-ai-session-recovery-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260801110000-b0d10001';
  const staleSessionId = '33333333-3333-4333-8333-333333333333';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
    { note_id: 'post-2', note_url: 'https://example.test/explore/post-2' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', body: 'saved body' },
  ]), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'job', keyword: 'data internship', aiSessionId: staleSessionId },
  }]), 'utf8');

  const child = createFakeChild(81004);
  let spawnOptions = null;
  let resolveCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
    aiSessions: {
      resolve: () => {
        resolveCount += 1;
        const error = new Error('expired');
        error.code = 'AI_SESSION_EXPIRED';
        throw error;
      },
    },
  });

  const params = validateRunRequest({
    analysisMode: 'job',
    keyword: 'data internship',
    mode: 'resume',
    resumeFromJobId: jobId,
    completeMissingOnly: true,
    checkOnly: false,
    aiSessionId: staleSessionId,
  });

  try {
    await manager.initialize();
    await assert.rejects(
      manager.resume(jobId, { scope: 'body_completion', params, aiSessionId: staleSessionId }),
      (error) => error.code === 'AI_SESSION_EXPIRED',
    );

    const started = await manager.resume(jobId, { scope: 'body_completion', params });
    await waitForJob(manager, started.id, (job) => job.status === 'running');
    assert.equal(resolveCount, 2);
    assert.equal(spawnOptions?.env?.XHS_AI_PROVIDER, 'codex');
    assert.equal(spawnOptions?.env?.XHS_AI_API_KEY, '');
    assert.equal(spawnOptions?.env?.XHS_AI_MODEL, '');

    const ended = waitForEnd(manager, jobId);
    child.emit('close', 0, null);
    await ended;
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('audience profile catch-up logs expose cumulative and current-batch progress', () => {
  const job = { progress: 0 };

  const changed = updateProgressFromLog(
    job,
    'AUDIENCE_PROGRESS posts=81/197 comments=3187 users=1187 profiles=77/1187 processed=9/12 phase=profile_catchup',
  );

  assert.equal(changed, true);
  assert.equal(job.progressPhase, 'audience_profiles');
  assert.equal(job.progressCurrent, 77);
  assert.equal(job.progressTotal, 1187);
  assert.match(job.progressLabel, /9 \/ 12/);
  assert.match(job.progressLabel, /77 \/ 1187/);
});

test('audience comment logs keep current batch progress separate from cumulative completion', () => {
  const job = { progress: 0 };

  const changed = updateProgressFromLog(
    job,
    'AUDIENCE_PROGRESS posts=92/197 comments=3434 users=1271 profiles=89/1271 processed=17/105 phase=comments',
  );

  assert.equal(changed, true);
  assert.equal(job.progressPhase, 'audience_comments');
  assert.equal(job.progressCurrent, 92);
  assert.equal(job.progressTotal, 197);
  assert.match(job.progressLabel, /17 \/ 105/);
  assert.match(job.progressLabel, /92 \/ 197/);
  assert.match(job.progressLabel, /3434/);
});

test('expansion log events update the existing SSE job state without replacing prior summary fields', () => {
  const job = {
    progress: 0,
    params: { expansion: { enabled: true, rounds: 2 } },
    workflowSummary: { analysisMode: 'general' },
  };

  assert.equal(updateProgressFromLog(
    job,
    'EXPANSION_EVENT expansion_frontier_updated {"roundIndex":1,"completedRounds":0,"frontierCount":3,"stopReason":"","status":"partial","counters":{"users":7,"posts":2,"comments":12}}',
  ), true);
  assert.equal(job.progressPhase, undefined);
  assert.equal(job.progressCurrent, undefined);
  assert.equal(job.progressTotal, undefined);
  assert.equal(job.workflowSummary.analysisMode, 'general');
  assert.equal(job.workflowSummary.expansion.frontierCount, 3);
  assert.equal(job.workflowSummary.expansion.counters.comments, 12);

  assert.equal(updateProgressFromLog(
    job,
    'EXPANSION_EVENT expansion_round_completed {"roundIndex":1,"frontierUserCount":3,"expandedUserCount":2,"stopReason":"round_completed"}',
  ), true);
  assert.equal(job.workflowSummary.expansion.roundSummaries.length, 1);
  assert.equal(job.workflowSummary.expansion.roundSummaries[0].expandedUserCount, 2);
});

test('relationship expansion runs inside the persisted task without creating history or changing its main status', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-expansion-in-place-'));
  const id = 'content-task-1';
  const outputDir = path.join(dataDir, 'jobs', id, 'artifacts');
  const runnerPath = path.join(dataDir, 'scripts', 'run_project_workflow.py');
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.dirname(runnerPath), { recursive: true });
  await writeFile(runnerPath, '', 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id,
    status: 'succeeded',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outputDir,
    logPath: path.join(dataDir, 'jobs', id, 'run.log'),
    pid: null,
    params: { analysisMode: 'general', keyword: 'fixture', relayPort: 18800 },
    workflowSummary: { analysisMode: 'general', contentPostCount: 1 },
  }]), 'utf8');
  const child = createFakeChild(81234);
  let spawnArgs = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath,
    spawnImpl: (_command, args) => { spawnArgs = args; return child; },
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const parentStatus = manager.get(id).status;
    const historyBefore = manager.list().map((job) => job.id);
    const request = validateExpansionStartRequest({ seedPostIds: ['post-1'], config: { rounds: 1 } });
    const started = await manager.startExpansion(id, request);
    assert.equal(started.job.id, id);
    assert.deepEqual(manager.list().map((job) => job.id), historyBefore);
    assert.equal(manager.get(id).status, parentStatus);
    assert.equal(manager.get(id).workflowSummary.expansion.runtimeStatus, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(spawnArgs[0], /run_expansion_workspace\.py$/);
    const requestFile = JSON.parse(await readFile(path.join(dataDir, 'jobs', id, 'expansion-request.json'), 'utf8'));
    assert.equal(requestFile.outputDir, outputDir);
    assert.deepEqual(requestFile.seedPostIds, ['post-1']);
    child.emit('close', 1, null);
    await waitForJob(manager, id, (job) => job.workflowSummary?.expansion?.runtimeStatus !== 'running');
    assert.equal(manager.get(id).status, parentStatus);
    assert.deepEqual(manager.list().map((job) => job.id), historyBefore);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

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
    terminateImpl: async (target) => target.kill('SIGTERM'),
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
    assert.equal(spawnOptions.env.XHS_RELAY_CONNECT_TIMEOUT_MS, '60000');
    await assert.rejects(manager.start(validateRunRequest({})), (error) => error.code === 'JOB_BUSY');
    assert.equal(manager.get(job.id).status, 'running');
    const progressStates = [];
    const unsubscribeProgress = manager.subscribe(job.id, (event) => {
      if (event.type === 'state') progressStates.push(event.data);
    });
    child.stdout.write('scroll 1/40: collected 12 note links\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'discovering');
    assert.equal(manager.get(job.id).progressCurrent, 1);
    assert.equal(manager.get(job.id).progressTotal, 40);
    assert.equal(manager.get(job.id).discoveredCount, 12);
    assert.equal(manager.get(job.id).bodyProcessedCount, 0);
    child.stdout.write('Scraping note 1/999: https://example.test/1\n');
    child.stdout.write('Scraping note 2/999: https://example.test/2\n');
    child.stdout.write('NOTE_PROGRESS processed=2 total=999 saved=1 status=saved\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).bodyProcessedCount, 1);
    assert.equal(manager.get(job.id).bodyMetrics.legacyInferred, true);
    child.stdout.write('PARALLEL_ROUND 1/3 pending=997 workers=3\n');
    child.stdout.write('CARD_DISCOVERY complete=999; detail access delegated to guarded body completion\n');
    child.stdout.write('CARD_CHECKPOINT_NORMALIZED before=999 after=998 duplicates=1\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressLabel, '已合并 1 条重复卡片，继续处理 998 篇');
    assert.equal(manager.get(job.id).progressTotal, 998);
    assert.equal(manager.get(job.id).discoveredCount, 998);
    child.stdout.write('PARALLEL_PROGRESS processed=999 total=999 complete=998 status=detail_ok round=2 round_processed=1 round_total=4\n');
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribeProgress();
    assert.equal(progressStates.length, 8);
    assert.equal(manager.get(job.id).progressPhase, 'scraping');
    assert.equal(manager.get(job.id).progressLabel, '第 2 轮补采 1 / 4 · 正文 998 / 999 篇');
    assert.equal(manager.get(job.id).progressCurrent, 999);
    assert.equal(manager.get(job.id).progressTotal, 999);
    assert.equal(manager.get(job.id).discoveredCount, 999);
    assert.equal(manager.get(job.id).scrapedCount, 998);
    assert.equal(manager.get(job.id).bodyProcessedCount, 998);
    assert.ok(manager.get(job.id).progressUpdatedAt);
    child.stdout.write('SECURITY_VERIFICATION detected timeout=600s; new collection paused while waiting for manual completion\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'security_verification');
    assert.equal(manager.get(job.id).securityRestriction.status, 'waiting');
    assert.equal(manager.get(job.id).securityRestriction.timeoutSeconds, 600);
    child.stdout.write('AUDIENCE_PROGRESS posts=3/10 comments=8 users=5 profiles=0/5 phase=comments\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'audience_comments');
    assert.equal(manager.get(job.id).securityRestriction.status, 'cleared');
    child.stdout.write('SECURITY_VERIFICATION detected timeout=600s; new collection paused while waiting for manual completion\n');
    child.stdout.write('SECURITY_VERIFICATION cleared; resuming collection\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'scraping');
    assert.equal(manager.get(job.id).securityRestriction.status, 'cleared');
    child.stdout.write('SECURITY_VERIFICATION detected timeout=600s; new collection paused while waiting for manual completion\n');
    child.stdout.write('SECURITY_VERIFICATION timed_out; stopping new collection and preserving checkpoint\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'security_restricted');
    assert.equal(manager.get(job.id).securityRestriction.status, 'timed_out');
    assert.equal(manager.get(job.id).securityRestriction.recoveryAction, 'manual_verification_then_resume');
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
    const finalJob = manager.get(job.id);
    assert.equal(finalJob.attempts.length, 1);
    assert.equal(finalJob.attempts[0].status, 'cancelled');
    assert.match(
      await readFile(finalJob.attempts[0].logPath, 'utf8'),
      new RegExp(finalJob.attempts[0].attemptId),
    );
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].id, job.id);
    assert.equal(history[0].status, 'cancelled');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('legacy resume requests never queue a child Job while the original Job is active', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-queue-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = createFakeChild(31001);
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
  });

  try {
    await manager.initialize();
    const active = await manager.start(validateRunRequest({ checkOnly: true, keyword: 'active' }));
    await waitForJob(manager, active.id, (job) => job.status === 'running');

    await assert.rejects(
      manager.start(
        validateRunRequest({
          checkOnly: true,
          keyword: 'audience',
          analysisMode: 'general',
          mode: 'resume',
          resumeFromJobId: active.id,
          audienceOnly: true,
          collectAudience: true,
        }),
        { queueIfBusy: true },
      ),
      (error) => error.code === 'JOB_ALREADY_RUNNING',
    );
    assert.equal(spawnCount, 1);
    assert.equal(manager.list().length, 1);

    const ended = waitForEnd(manager, active.id);
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a queued task can be cancelled before it starts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-queue-cancel-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = createFakeChild(32001);
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
  });

  try {
    await manager.initialize();
    const active = await manager.start(validateRunRequest({ checkOnly: true, keyword: 'active' }));
    await waitForJob(manager, active.id, (job) => job.status === 'running');
    const queued = await manager.start(validateRunRequest({ checkOnly: true, keyword: 'queued' }), { queueIfBusy: true });

    const cancellation = await manager.cancel(queued.id);
    assert.equal(cancellation.changed, true);
    assert.equal(cancellation.job.status, 'cancelled');
    child.emit('close', 0, null);
    await waitForJob(manager, active.id, (job) => job.status === 'completed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCount, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('security timeout can resume before the first card is discovered', () => {
  const job = publicJob({
    id: 'security-before-first-card',
    status: 'failed',
    params: { keyword: 'test', searchSort: 'latest' },
    checkpointAvailable: false,
    workflowSummary: {
      cardsDiscovered: 0,
      notesCollected: 0,
      securityVerification: {
        status: 'timed_out',
        timeoutSeconds: 600,
        recoveryAction: 'manual_verification_then_resume',
      },
    },
  });

  assert.equal(job.discoveredCount, 0);
  assert.equal(job.securityRestriction.status, 'timed_out');
  assert.equal(job.resumeAvailable, true);
});

test('public job derives body progress only from the persisted per-note ledger', () => {
  const job = publicJob({
    id: 'persisted-body-progress',
    status: 'incomplete',
    params: { keyword: 'test' },
    discoveredCount: 258,
    scrapedCount: 93,
    bodyProcessedCount: 107,
    stages: {
      ...emptyWorkflowStages(),
      bodyCompletion: {
        ...emptyWorkflowStages().bodyCompletion,
        status: 'partial',
        statisticsSource: 'bodyCompletionLedger',
        records: {
          ok: { bodyStatus: 'succeeded', attemptCount: 1 },
          failed: { bodyStatus: 'failed', attemptCount: 1 },
          missing: { bodyStatus: 'not_attempted', attemptCount: 0 },
          blocked: { bodyStatus: 'blocked', attemptCount: 1 },
          cancelled: { bodyStatus: 'cancelled', attemptCount: 1 },
        },
      },
    },
    workflowSummary: {
      cardsDiscovered: 258,
      notesCollected: 93,
      bodyAttempted: 181,
    },
  });

  assert.equal(job.discoveredCount, 5);
  assert.equal(job.bodyProcessedCount, 4);
  assert.deepEqual(job.bodyMetrics, {
    schemaVersion: 1,
    statisticsSource: 'bodyCompletionLedger',
    legacyInferred: false,
    discovered: 5,
    attempted: 4,
    succeeded: 1,
    failed: 1,
    notAttempted: 1,
    blocked: 1,
    cancelled: 1,
    pending: 0,
    completionRatePercent: 20,
    statusCounts: {
      discovered: 0,
      queued: 0,
      attempted: 0,
      succeeded: 1,
      failed: 1,
      not_attempted: 1,
      blocked: 1,
      cancelled: 1,
    },
    conservation: {
      left: 5,
      right: 5,
      valid: true,
      terminal: true,
      formula: 'discovered = succeeded + failed + not_attempted + blocked + cancelled + pending',
    },
  });
  assert.deepEqual(job.workflowSummary.bodyMetrics, job.bodyMetrics);
});

test('legacy body summaries remain readable and are explicitly marked inferred', () => {
  const metrics = bodyMetricsForJob({
    discoveredCount: 4,
    workflowSummary: {
      cardsDiscovered: 4,
      bodyAttempted: 0,
      bodySucceeded: 2,
      bodyCancelled: 1,
    },
  });

  assert.equal(metrics.legacyInferred, true);
  assert.equal(metrics.statisticsSource, 'legacyInferred');
  assert.equal(metrics.attempted, 3);
  assert.equal(metrics.notAttempted, 1);
  assert.equal(metrics.conservation.valid, true);
});

test('rate limiting is exposed as a resumable incomplete state instead of manual verification', () => {
  const job = publicJob({
    id: 'rate-limited-checkpoint',
    status: 'incomplete',
    params: { keyword: 'test' },
    workflowSummary: {
      cardsDiscovered: 20,
      notesCollected: 8,
      rateLimit: {
        status: 'stopped',
        recoveryAction: 'wait_then_resume',
      },
    },
  });

  assert.equal(job.rateLimit.status, 'stopped');
  assert.equal(job.rateLimit.recoveryAction, 'wait_then_resume');
  assert.equal(job.securityRestriction, null);
  assert.equal(job.resumeAvailable, true);
});

test('general content checkpoints use content completeness instead of job fields', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-general-checkpoint-'));
  const outputDir = path.join(dataDir, 'general-result', 'artifacts');
  const fakeRunner = path.join(dataDir, 'runner.py');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    analysis_mode: 'general',
    keyword: '城市展览',
    records: [{
      note_id: 'content-1',
      body: '完整正文',
      application_info: { responsibilities: [], requirements: [], application_routes: [] },
      outreach: { runtime_status: 'fallback_missing_job_body' },
      media: { images: [], analysis: { status: 'no_images', source: 'none' } },
      content_analysis: {
        status: 'completed',
        overview: '这是一条城市展览内容。',
        grounded_evidence_count: 1,
        modules: [{ id: 'highlights', title: '展览亮点', summary: '聚焦公共空间。', items: [], evidence: ['完整正文'] }],
      },
    }, {
      note_id: 'content-2',
      body: '另一条完整正文',
      media: { images: [], analysis: { status: 'no_images', source: 'none' } },
      content_analysis: {
        status: 'completed',
        overview: '只有模型概括，没有原文证据。',
        modules: [{ id: 'highlights', title: '展览亮点', summary: '无法复核。', items: [], evidence: [] }],
      },
    }],
  }), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: '20260730150000-abcdef12',
    status: 'succeeded',
    params: { keyword: '城市展览', analysisMode: 'general' },
    outputDir,
    createdAt: '2026-07-30T15:00:00.000Z',
    startedAt: '2026-07-30T15:00:00.000Z',
    finishedAt: '2026-07-30T15:01:00.000Z',
    discoveredCount: 0,
    scrapedCount: 0,
  }]), 'utf8');
  const manager = new JobManager({ dataDir, pythonBin: 'python', runnerPath: fakeRunner });

  try {
    await manager.initialize();
    assert.equal(manager.list()[0].applicationCount, 2);
    assert.equal(manager.list()[0].incompleteCount, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('quality-gate exit code is classified as incomplete instead of failed', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-incomplete-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = new EventEmitter();
  child.pid = 22335;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({ checkOnly: true }));
    const ended = new Promise((resolve) => {
      const unsubscribe = manager.subscribe(started.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve();
        }
      });
    });
    child.emit('close', 3, null);
    await ended;

    const job = manager.get(started.id);
    assert.equal(job.status, 'incomplete');
    assert.match(job.message, /质量门禁/);
    assert.equal(job.exitCode, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager materializes only body-backed jobs while scraping and preserves them after cancellation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-checkpoint-analysis-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = new EventEmitter();
  child.pid = 22334;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  const analyzed = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
    checkpointAnalyzerImpl: async ({ outputDir }) => {
      const notes = JSON.parse(await readFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), 'utf8'));
      analyzed.push(notes.length);
      await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
        records: notes.map((note) => ({ note_id: note.note_id, body: note.body })),
      }), 'utf8');
      await writeFile(path.join(outputDir, 'workflow-summary.json'), JSON.stringify({
        cardsDiscovered: 3,
        jobCardsGenerated: notes.length,
        applicationCopyGenerated: notes.length,
      }), 'utf8');
      return { stdout: `CHECKPOINT_ANALYSIS records=${notes.length}\n`, stderr: '' };
    },
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({ checkOnly: true }));
    const outputDir = manager.getInternal(started.id).outputDir;
    const cards = Array.from({ length: 3 }, (_, index) => ({ note_id: `note-${index + 1}` }));
    await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8');
    await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
      { ...cards[0], body: 'complete job body', access_status: 'detail_ok' },
    ]), 'utf8');
    await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
      records: Array.from({ length: 3 }, (_, index) => ({ note_id: `stale-${index + 1}` })),
    }), 'utf8');
    child.stdout.write('Collected 3 note links. Starting note extraction...\n');
    for (let attempt = 0; attempt < 100 && manager.get(started.id).applicationCount !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(analyzed, [1]);
    assert.equal(manager.get(started.id).status, 'running');
    assert.equal(manager.get(started.id).applicationCount, 1);
    const livePayload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
    assert.equal(livePayload.records.length, 1);
    assert.deepEqual(livePayload.records.map((record) => record.note_id), [cards[0].note_id]);
    const ended = new Promise((resolve) => {
      const unsubscribe = manager.subscribe(started.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve();
        }
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    await manager.cancel(started.id);
    await ended;

    const job = manager.get(started.id);
    assert.equal(job.status, 'cancelled');
    assert.deepEqual(analyzed, [1]);
    assert.equal(job.workflowSummary.jobCardsGenerated, 1);
    assert.equal(job.workflowSummary.applicationCopyGenerated, 1);
    const payload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
    assert.equal(payload.records.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager cleans persisted process identity before marking a restarted job interrupted', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-restart-'));
  const outputDir = path.join(dataDir, 'jobs', 'stale-job', 'artifacts');
  const stages = emptyWorkflowStages();
  stages.audience.status = 'running';
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ id: index }))), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(Array.from({ length: 4 }, (_, index) => ({ id: index }))), 'utf8');
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: Array.from({ length: 10 }, (_, index) => ({
      note_id: `note-${index}`,
      body: index < 7 ? 'complete job body' : '',
      job_card: { parse_basis: index < 7 ? 'full_body' : 'search_card' },
      outreach: { runtime_status: index === 0 ? 'fallback_missing_candidate_evidence' : '' },
    })),
  }), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: 'stale-job',
    status: 'running',
    pid: 45678,
    outputDir,
    params: { keyword: 'test' },
    stages,
  }]), 'utf8');
  const recovered = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
    recoverImpl: async (job) => {
      recovered.push({ id: job.id, pid: job.pid, outputDir: job.outputDir });
      return { matched: 2, terminated: 2, method: 'test' };
    },
  });

  try {
    await manager.initialize();
    const job = manager.get('stale-job');
    assert.equal(job.status, 'interrupted');
    assert.equal(job.pid, null);
    assert.match(job.message, /Server restarted/);
    assert.match(job.message, /Checkpoint preserved/);
    assert.equal(job.discoveredCount, 10);
    assert.equal(job.scrapedCount, 4);
    assert.equal(job.applicationCount, 10);
    assert.equal(job.incompleteCount, 3);
    assert.equal(job.progress, 48);
    assert.equal(job.resumeAvailable, true);
    assert.equal(job.activeAttemptId, null);
    assert.equal(job.attempts.length, 1);
    assert.equal(job.attempts[0].status, 'interrupted');
    assert.equal(job.attempts[0].stopReason, 'server_restart');
    assert.equal(job.attempts[0].errorCode, 'SERVER_RESTART');
    assert.equal(job.attempts[0].checkpointRevisionAtEnd, job.revision);
    assert.equal(job.stages.audience.status, 'partial');
    assert.equal(job.stages.audience.stopReason, 'server_restart');
    assert.ok(job.stages.audience.lastCheckpointAt);
    assert.deepEqual(recovered, [{ id: 'stale-job', pid: 45678, outputDir }]);
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].cleanupResult.terminated, 2);
    assert.ok(history[0].cleanupConfirmedAt);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager repairs a terminal task whose audience stage was left running', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-terminal-audience-'));
  const outputDir = path.join(dataDir, 'jobs', 'failed-audience-job', 'artifacts');
  const stages = emptyWorkflowStages();
  stages.audience.status = 'running';
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: 'failed-audience-job',
    status: 'failed',
    error: 'Runner exited with code 1.',
    finishedAt: '2026-07-31T20:11:59.302Z',
    outputDir,
    params: { keyword: 'test' },
    stages,
  }]), 'utf8');
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
  });

  try {
    await manager.initialize();
    const job = manager.get('failed-audience-job');
    assert.equal(job.status, 'failed');
    assert.equal(job.stages.audience.status, 'partial');
    assert.equal(job.stages.audience.stopReason, 'runner_failed');
    assert.equal(job.stages.audience.lastCheckpointAt, '2026-07-31T20:11:59.302Z');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager resumes in place with a stable Job identity and a new Attempt', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-resume-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const sourceId = '20260729120000-deadbeef';
  const sourceOutputDir = path.join(dataDir, 'jobs', sourceId, 'artifacts');
  const cards = [{ note_id: 'note-1' }, { note_id: 'note-2' }];
  const notes = [{ note_id: 'note-1', access_status: 'detail_ok' }];
  const notesCsv = 'note_id,access_status\nnote-1,detail_ok\n';
  const application = { records: [{ note_id: 'note-1', outreach: { runtime_status: 'completed' } }] };
  const applicationCheckpoint = { records: [{ note_id: 'note-2', outreach: { runtime_status: 'fallback_missing_job_body' } }] };
  const audienceComments = [{ comment_id: 'comment-1', post_id: 'note-1', text: '评论' }];
  const audienceUsers = [{ user_id: 'user-1', display_name: '用户一' }];
  const audiencePosts = [{ post_id: 'note-1', status: 'partial' }];
  const audienceSummary = { status: 'partial', postsTotal: 1, commentsCollected: 1 };
  await mkdir(sourceOutputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_cards_discovered.json'), JSON.stringify(cards), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(notes), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_notes_latest.csv'), notesCsv, 'utf8');
  await writeFile(path.join(sourceOutputDir, 'application_intelligence.json'), JSON.stringify(application), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'application_intelligence.checkpoint.json'), JSON.stringify(applicationCheckpoint), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'audience-comments.json'), JSON.stringify(audienceComments), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'audience-users.json'), JSON.stringify(audienceUsers), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'audience-posts.json'), JSON.stringify(audiencePosts), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'audience-summary.json'), JSON.stringify(audienceSummary), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: sourceId,
    status: 'interrupted',
    outputDir: sourceOutputDir,
    params: { keyword: 'test' },
  }]), 'utf8');

  const child = new EventEmitter();
  child.pid = 78901;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  let spawnedArgs;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: (_command, args) => {
      spawnedArgs = args;
      return child;
    },
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const original = manager.get(sourceId);
    assert.equal(original.resumeAvailable, true);
    const originalListLength = manager.list().length;
    const originalAttemptCount = original.attempts.length;
    const started = await manager.start(validateRunRequest({
      checkOnly: true,
      mode: 'resume',
      resumeFromJobId: sourceId,
    }));
    const resumedOutputDir = manager.getInternal(started.id).outputDir;
    assert.equal(started.id, sourceId);
    assert.equal(started.outputDir, original.outputDir);
    assert.equal(started.createdAt, original.createdAt);
    assert.equal(resumedOutputDir, sourceOutputDir);
    assert.equal(manager.list().length, originalListLength);
    assert.equal(started.resumeCount, 1);
    assert.equal(started.attempts.length, originalAttemptCount + 1);
    assert.equal(started.attemptId, started.currentAttemptId);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'xiaohongshu_cards_discovered.json'), 'utf8')),
      cards,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'xiaohongshu_cards_latest.json'), 'utf8')),
      cards,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'xiaohongshu_notes_latest.json'), 'utf8')),
      notes,
    );
    assert.equal(
      await readFile(path.join(resumedOutputDir, 'xiaohongshu_notes_latest.csv'), 'utf8'),
      notesCsv,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'application_intelligence.json'), 'utf8')),
      application,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'application_intelligence.checkpoint.json'), 'utf8')),
      applicationCheckpoint,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'audience-comments.json'), 'utf8')),
      audienceComments,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'audience-users.json'), 'utf8')),
      audienceUsers,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'audience-posts.json'), 'utf8')),
      audiencePosts,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumedOutputDir, 'audience-summary.json'), 'utf8')),
      audienceSummary,
    );

    const ended = new Promise((resolve) => {
      const unsubscribe = manager.subscribe(started.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve();
        }
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(started.id).status, 'running');
    assert.equal(spawnedArgs[spawnedArgs.indexOf('--output-dir') + 1], sourceOutputDir);
    child.emit('close', 0, null);
    await ended;
    const completed = manager.get(sourceId);
    const latestAttempt = completed.attempts.at(-1);
    assert.equal(completed.id, sourceId);
    assert.equal(completed.outputDir, sourceOutputDir);
    assert.equal(completed.createdAt, original.createdAt);
    assert.equal(completed.resumeCount, 1);
    assert.equal(latestAttempt.kind, 'recovery_after_restart');
    assert.equal(latestAttempt.resumeScope, 'full');
    assert.equal(latestAttempt.status, 'succeeded');
    assert.equal(latestAttempt.entryStatus, 'interrupted');
    assert.equal(latestAttempt.exitStatus, 'succeeded');
    assert.ok(Number.isInteger(latestAttempt.processedCount));
    assert.ok(latestAttempt.processedCount >= 0);
    assert.equal(latestAttempt.pid, 78901);
    assert.ok(latestAttempt.finishedAt);
    assert.match(latestAttempt.logPath, new RegExp(`${sourceId}.*attempts.*run\\.log`));
    assert.match(await readFile(latestAttempt.logPath, 'utf8'), new RegExp(latestAttempt.attemptId));
    assert.match(await readFile(path.join(path.dirname(sourceOutputDir), 'run.log'), 'utf8'), new RegExp(latestAttempt.attemptId));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('stage-scoped resume uses stage state and clears inherited legacy mode flags', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-stage-resume-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260729120500-stage001';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(
    path.join(outputDir, 'xiaohongshu_cards_latest.json'),
    JSON.stringify([{ note_id: 'note-1' }]),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'xiaohongshu_notes_latest.json'),
    JSON.stringify([{ note_id: 'note-1', access_status: 'detail_ok' }]),
    'utf8',
  );
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'succeeded',
    outputDir,
    params: {
      keyword: 'test',
      analysisMode: 'general',
      mode: 'resume',
      resumeFromJobId: '20260728120500-parent01',
      collectAudience: true,
      audienceOnly: true,
      completeMissingOnly: true,
    },
  }]), 'utf8');

  const child = createFakeChild(78905);
  let spawnedArgs;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: (_command, args) => {
      spawnedArgs = args;
      return child;
    },
  });

  try {
    await manager.initialize();
    const resumed = await manager.resume(jobId, {
      scope: 'discovery',
      idempotencyKey: 'stage-discovery-1',
    });
    assert.equal(resumed.id, jobId);
    assert.equal(manager.list().length, 1);
    assert.equal(resumed.attempts.at(-1).entryStatus, 'succeeded');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(Array.isArray(spawnedArgs));
    assert.equal(spawnedArgs.includes('--audience-only'), false);
    assert.equal(spawnedArgs.includes('--complete-missing-only'), false);
    assert.equal(spawnedArgs[spawnedArgs.indexOf('--resume-scope') + 1], 'discovery');
    const ended = waitForEnd(manager, jobId);
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('resume is revision-guarded and idempotent for concurrent retries', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-resume-idempotent-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260729121000-idempotent';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(
    path.join(outputDir, 'xiaohongshu_cards_latest.json'),
    JSON.stringify([{ note_id: 'note-1' }]),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'xiaohongshu_notes_latest.json'),
    JSON.stringify([{ note_id: 'note-1', access_status: 'detail_ok' }]),
    'utf8',
  );
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { keyword: 'test' },
  }]), 'utf8');

  const child = createFakeChild(78911);
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
  });

  try {
    await manager.initialize();
    const revision = manager.get(jobId).revision;
    const params = validateRunRequest({ checkOnly: true });
    await assert.rejects(
      manager.resume(jobId, {
        scope: 'body_completion',
        params,
        expectedRevision: revision + 1,
      }),
      (error) => error.code === 'WORKFLOW_REVISION_CONFLICT'
        && error.expectedRevision === revision + 1
        && error.actualRevision === revision,
    );
    assert.equal(manager.get(jobId).attempts.length, 1);
    assert.equal(spawnCount, 0);

    const options = {
      scope: 'body_completion',
      params,
      idempotencyKey: 'retry-key-1',
      expectedRevision: revision,
    };
    const [first, second, otherPage] = await Promise.all([
      manager.resume(jobId, options),
      manager.resume(jobId, options),
      manager.resume(jobId, {
        ...options,
        idempotencyKey: 'other-page-key-1',
      }),
    ]);
    assert.equal(first.id, jobId);
    assert.equal(second.id, jobId);
    assert.equal(otherPage.id, jobId);
    assert.equal(first.attemptId, second.attemptId);
    assert.equal(first.attemptId, otherPage.attemptId);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(jobId).resumeCount, 1);
    assert.equal(manager.get(jobId).attempts.length, 2);
    assert.equal(spawnCount, 1);

    const persistedState = JSON.parse(await readFile(path.join(dataDir, 'jobs', jobId, 'workflow-state.json'), 'utf8'));
    assert.deepEqual(persistedState.params, { keyword: 'test' });

    const ended = waitForEnd(manager, jobId);
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager rejects resume without a checkpoint and does not create a child Job', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-latest-rediscovery-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const sourceId = '20260729120000-cafefeed';
  const sourceOutputDir = path.join(dataDir, 'jobs', sourceId, 'artifacts');
  await mkdir(sourceOutputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: sourceId,
    status: 'interrupted',
    outputDir: sourceOutputDir,
    params: { keyword: 'test', searchSort: 'comprehensive' },
  }]), 'utf8');

  const child = new EventEmitter();
  child.pid = 78902;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const original = manager.get(sourceId);
    await assert.rejects(
      manager.start(validateRunRequest({
        checkOnly: true,
        mode: 'resume',
        resumeFromJobId: sourceId,
        completeMissingOnly: true,
      })),
      (error) => error.code === 'RESUME_CHECKPOINTS_MISSING',
    );
    assert.equal(spawnCount, 0);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(sourceId).id, original.id);
    assert.equal(manager.get(sourceId).outputDir, original.outputDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a completed content Job can resume the unfinished audience stage in place', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-checkpoint-copy-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const sourceId = '20260729130000-deadbeef';
  const sourceOutputDir = path.join(dataDir, 'jobs', sourceId, 'artifacts');
  const cards = [{ note_id: 'saved-post', note_url: 'https://example.test/explore/saved-post' }];
  const notes = [{ note_id: 'saved-post', note_url: 'https://example.test/explore/saved-post', title: 'Saved post' }];
  await mkdir(sourceOutputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8');
  await writeFile(path.join(sourceOutputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(notes), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: sourceId,
    status: 'succeeded',
    outputDir: sourceOutputDir,
    params: { analysisMode: 'general', keyword: 'old-search', searchSort: 'comprehensive' },
  }]), 'utf8');

  const child = createFakeChild(78903);
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const original = manager.get(sourceId);
    const originalListLength = manager.list().length;
    const started = await manager.start(validateRunRequest({
      analysisMode: 'general',
      keyword: 'old-search',
      checkOnly: true,
      mode: 'resume',
      resumeFromJobId: sourceId,
      audienceOnly: true,
    }));
    const resumed = manager.getInternal(started.id);
    assert.equal(started.id, sourceId);
    assert.equal(started.outputDir, original.outputDir);
    assert.equal(started.createdAt, original.createdAt);
    assert.equal(manager.list().length, originalListLength);
    assert.equal(started.resumeCount, 1);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumed.outputDir, 'xiaohongshu_cards_latest.json'), 'utf8')),
      cards,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(resumed.outputDir, 'xiaohongshu_notes_latest.json'), 'utf8')),
      notes,
    );

    const ended = waitForEnd(manager, started.id);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an audience runner crash preserves the checkpoint as resumable incomplete work', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-runner-exit-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260731130000-acde1234';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  const cards = [{ note_id: 'saved-post', note_url: 'https://example.test/explore/saved-post' }];
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(cards), 'utf8');
  const staleTemp = path.join(outputDir, '.audience-posts.json.86224.abcd1234.tmp');
  await writeFile(staleTemp, 'stale concurrent writer', 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'general', keyword: 'saved-content' },
  }]), 'utf8');

  const child = createFakeChild(78906);
  let recoverCalls = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    recoverImpl: async () => {
      recoverCalls += 1;
      return recoverCalls === 1
        ? { matched: 1, terminated: 1, method: 'test-pre-resume' }
        : { matched: 0, terminated: 0, method: 'test-runner-exit' };
    },
  });

  try {
    await manager.initialize();
    const started = await manager.resume(jobId, {
      scope: 'audience',
      params: validateRunRequest({
        analysisMode: 'general',
        keyword: 'saved-content',
        mode: 'resume',
        resumeFromJobId: jobId,
        collectAudience: true,
        audienceOnly: true,
        checkOnly: false,
      }),
      requestedBy: 'runner-exit-test',
    });
    await assert.rejects(readFile(staleTemp, 'utf8'), (error) => error.code === 'ENOENT');
    const ended = waitForEnd(manager, started.id);
    child.stdout.write(
      'AUDIENCE_PROGRESS posts=1/3 comments=232 users=97 profiles=51/94 processed=8/12 phase=profile_catchup\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.getInternal(jobId).progressPhase, 'audience_profiles');
    child.emit('close', 1, null);
    await ended;

    const finalJob = manager.get(jobId);
    assert.equal(finalJob.status, 'incomplete', finalJob.message);
    assert.equal(finalJob.resumeAvailable, true);
    assert.match(finalJob.message, /检查点/);
    assert.match(finalJob.message, /继续补采/);
    assert.equal(finalJob.attempts.at(-1).errorCode, 'AUDIENCE_RUNNER_INTERRUPTED');
    assert.equal(finalJob.attempts.at(-1).exitCode, 1);
    assert.equal(recoverCalls, 2);
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].cleanupResult.reason, 'runner_exit');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager does not merge legacy sibling artifacts into the selected state owner', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-sibling-merge-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const rootId = '20260729130000-11111111';
  const firstId = '20260729140000-22222222';
  const secondId = '20260729150000-33333333';
  const rootOutputDir = path.join(dataDir, 'jobs', rootId, 'artifacts');
  const firstOutputDir = path.join(dataDir, 'jobs', firstId, 'artifacts');
  const secondOutputDir = path.join(dataDir, 'jobs', secondId, 'artifacts');
  const outputDirs = [rootOutputDir, firstOutputDir, secondOutputDir];
  const cards = [
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
    { note_id: 'post-2', note_url: 'https://example.test/explore/post-2' },
  ];
  const notes = [
    { ...cards[0], title: 'First saved post' },
    { ...cards[1], title: 'Second saved post' },
  ];
  await Promise.all(outputDirs.map((outputDir) => mkdir(outputDir, { recursive: true })));
  await writeFile(fakeRunner, '', 'utf8');
  await Promise.all(outputDirs.flatMap((outputDir) => [
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(notes), 'utf8'),
  ]));
  await Promise.all([
    writeFile(path.join(firstOutputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-1', note_url: cards[0].note_url, status: 'complete', collected_comment_count: 1 },
    ]), 'utf8'),
    writeFile(path.join(firstOutputDir, 'audience-comments.json'), JSON.stringify([
      { comment_id: 'comment-1', post_id: 'post-1', text: 'First sibling comment', user: { user_id: 'user-1' } },
    ]), 'utf8'),
    writeFile(path.join(firstOutputDir, 'audience-users.json'), JSON.stringify([
      { user_id: 'user-1', display_name: 'First sibling user', enrichment_status: 'complete', post_ids: ['post-1'] },
    ]), 'utf8'),
    writeFile(path.join(secondOutputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-2', note_url: cards[1].note_url, status: 'complete', collected_comment_count: 1 },
    ]), 'utf8'),
    writeFile(path.join(secondOutputDir, 'audience-comments.json'), JSON.stringify([
      { comment_id: 'comment-2', post_id: 'post-2', text: 'Second sibling comment', user: { user_id: 'user-2' } },
    ]), 'utf8'),
    writeFile(path.join(secondOutputDir, 'audience-users.json'), JSON.stringify([
      { user_id: 'user-2', display_name: 'Second sibling user', enrichment_status: 'complete', post_ids: ['post-2'] },
    ]), 'utf8'),
  ]);
  const rootParams = { analysisMode: 'general', keyword: 'saved-content' };
  const audienceParams = (resumeFromJobId) => ({
    ...rootParams,
    mode: 'resume',
    resumeFromJobId,
    audienceOnly: true,
    collectAudience: true,
  });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([
    { id: secondId, status: 'incomplete', outputDir: secondOutputDir, params: audienceParams(rootId) },
    { id: firstId, status: 'incomplete', outputDir: firstOutputDir, params: audienceParams(rootId) },
    { id: rootId, status: 'incomplete', outputDir: rootOutputDir, params: rootParams },
  ]), 'utf8');

  const audienceChild = createFakeChild(78905);
  let spawnCount = 0;
  let spawnedArgs = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: (_python, args) => {
      spawnCount += 1;
      spawnedArgs = args;
      return audienceChild;
    },
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const rootBefore = manager.get(rootId);
    const listLength = manager.list().length;
    const started = await manager.resume(rootId, {
      scope: 'audience',
      params: validateRunRequest({
        ...audienceParams(rootId),
        checkOnly: true,
      }),
      resumeCheckpointJobIds: [rootId, firstId, secondId],
    });
    assert.equal(started.id, rootId);
    assert.equal(started.outputDir, rootBefore.outputDir);
    assert.equal(started.createdAt, rootBefore.createdAt);
    assert.equal(manager.list().length, listLength);
    assert.equal(spawnCount, 1);
    assert.deepEqual(
      spawnedArgs.flatMap((value, index) => value === '--resume-checkpoint-dir' ? [spawnedArgs[index + 1]] : []),
      [firstOutputDir, secondOutputDir],
    );
    const resumedOutputDir = manager.getInternal(started.id).outputDir;
    const resumedNotes = JSON.parse(await readFile(
      path.join(resumedOutputDir, 'xiaohongshu_notes_latest.json'),
      'utf8',
    ));
    assert.deepEqual(resumedNotes, notes);
    await assert.rejects(
      readFile(path.join(resumedOutputDir, 'audience-comments.json'), 'utf8'),
      (error) => error.code === 'ENOENT',
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(firstOutputDir, 'audience-comments.json'), 'utf8')),
      [{ comment_id: 'comment-1', post_id: 'post-1', text: 'First sibling comment', user: { user_id: 'user-1' } }],
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(secondOutputDir, 'audience-comments.json'), 'utf8')),
      [{ comment_id: 'comment-2', post_id: 'post-2', text: 'Second sibling comment', user: { user_id: 'user-2' } }],
    );

    const ended = waitForEnd(manager, started.id);
    audienceChild.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager blocks new work when restart cleanup cannot be confirmed', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-recovery-block-'));
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: 'orphaned-job',
    status: 'running',
    pid: 56789,
    outputDir: path.join(dataDir, 'jobs', 'orphaned-job', 'artifacts'),
    params: { keyword: 'test' },
  }]), 'utf8');
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
    recoverImpl: async () => {
      throw new Error('matching process remains');
    },
  });

  try {
    await manager.initialize();
    const interrupted = manager.get('orphaned-job');
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.pid, 56789);
    assert.equal(interrupted.resumeAvailable, false);
    assert.match(interrupted.message, /Orphan cleanup failed/);
    await assert.rejects(
      manager.start(validateRunRequest({ checkOnly: true })),
      (error) => error.code === 'JOB_RECOVERY_INCOMPLETE' && error.jobs.includes('orphaned-job'),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager shutdown interrupts active work and waits for its process tree', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-shutdown-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = new EventEmitter();
  child.pid = 67890;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  let terminated = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => {
      terminated += 1;
      target.kill('SIGTERM');
    },
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({ checkOnly: true }));
    await new Promise((resolve) => setImmediate(resolve));
    const result = await manager.shutdown();
    assert.equal(result.interrupted, true);
    assert.equal(terminated, 1);
    assert.equal(manager.get(started.id).status, 'interrupted');
    assert.equal(manager.get(started.id).resumeAvailable, false);
    assert.match(manager.get(started.id).message, /resume is available/);
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].status, 'interrupted');
    assert.equal(history[0].pid, null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager keeps every persisted task when new history is added', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-unlimited-history-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const history = [];
  for (let index = 0; index < 12; index += 1) {
    const id = `history-${String(index).padStart(2, '0')}`;
    const outputDir = path.join(dataDir, id, 'artifacts');
    await mkdir(outputDir, { recursive: true });
    history.push({
      id,
      status: 'failed',
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 6, 1, 0, index, 30)).toISOString(),
      outputDir,
      logPath: path.join(dataDir, id, 'run.log'),
      pid: null,
      params: { keyword: `history ${index}` },
    });
  }
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify(history), 'utf8');

  const child = new EventEmitter();
  child.pid = 78903;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    maxHistory: 10,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    assert.equal(manager.list().length, 12);
    const started = await manager.start(validateRunRequest({ checkOnly: true }));
    assert.equal(manager.list().length, 13);
    const persisted = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(persisted.length, 13);

    const ended = new Promise((resolve) => {
      const unsubscribe = manager.subscribe(started.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve();
        }
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
