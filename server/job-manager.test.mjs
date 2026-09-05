import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  JobManager,
  bodyMetricsForJob,
  persistedProcessBelongsToJob,
  publicJob,
  updateProgressFromLog,
} from './job-manager.mjs';
import { validateExpansionStartRequest, validateRunRequest } from './lib/contracts.mjs';
import {
  WORKFLOW_EVENT_LINE_PREFIX,
  adaptLegacyJobSnapshot,
  mapUserProblem,
} from './lib/job-experience.mjs';
import { emptyWorkflowStages, initializeWorkflowState } from './lib/workflow-state.mjs';

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  return child;
}

test('process isolation ignores the supervised contact OCR sidecar', () => {
  const outputDir = 'c:\\workspace\\data\\jobs\\job-1\\artifacts';
  assert.equal(persistedProcessBelongsToJob({
    CommandLine: `python scripts\\runner.py --output-dir ${outputDir}`,
  }, outputDir), true);
  assert.equal(persistedProcessBelongsToJob({
    CommandLine: `python scripts\\resolve_application_contacts.py --output-dir ${outputDir} --job-id contact-ocr-123 --watch`,
  }, outputDir), false);
});

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

test('JobManager publishes the runner disk summary after loading a stale workflow state', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-final-summary-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const child = createFakeChild(230809);
  await writeFile(fakeRunner, '', 'utf8');
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({
      analysisMode: 'general',
      checkOnly: true,
      keyword: 'public raw collection',
    }));
    await waitForJob(manager, started.id, (job) => job.status === 'running');
    const internal = manager.getInternal(started.id);
    const staleState = JSON.parse(await readFile(internal.statePath, 'utf8'));
    staleState.workflowSummary = {
      status: 'failed',
      rawCollection: true,
      bodyCoveragePercent: 100,
      qualityPending: true,
    };
    staleState.artifactCount = 0;
    await writeFile(internal.statePath, JSON.stringify(staleState, null, 2), 'utf8');

    const diskSummary = {
      status: 'succeeded',
      rawCollection: true,
      postprocessSkipped: true,
      analysisSkipped: true,
      cardsDiscovered: 87,
      bodySucceeded: 87,
      bodyFailed: 0,
      bodyCoveragePercent: 100,
      qualityPending: false,
      qualityPassed: 1,
      issues: [],
    };
    await writeFile(
      path.join(internal.outputDir, 'workflow-summary.json'),
      JSON.stringify(diskSummary, null, 2),
      'utf8',
    );
    await writeFile(path.join(internal.outputDir, 'raw-results.json'), '[]', 'utf8');

    const ended = waitForEnd(manager, started.id);
    child.emit('close', 0, null);
    await ended;

    const completed = manager.get(started.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.workflowSummary.status, 'succeeded');
    assert.equal(completed.workflowSummary.cardsDiscovered, 87);
    assert.equal(completed.workflowSummary.bodySucceeded, 87);
    assert.equal(completed.workflowSummary.qualityPending, false);
    assert.equal(completed.artifactCount, 2);

    const persistedState = JSON.parse(await readFile(internal.statePath, 'utf8'));
    assert.equal(persistedState.workflowSummary.status, 'succeeded');
    assert.equal(persistedState.workflowSummary.bodyCoveragePercent, 100);
    assert.equal(persistedState.artifactCount, 2);
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager restart treats a raw collection disk summary as authoritative', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-raw-restart-summary-'));
  const jobId = '20260809120000-rawrestart';
  const outputDir = path.join(dataDir, jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'completed',
    outputDir,
    params: { analysisMode: 'general', keyword: 'public raw collection' },
    workflowSummary: {
      status: 'failed',
      rawCollection: true,
      qualityPending: true,
      agentStages: [{ id: 8, status: 'failed' }],
    },
  }]), 'utf8');
  await writeFile(path.join(outputDir, 'workflow-summary.json'), JSON.stringify({
    status: 'succeeded',
    rawCollection: true,
    postprocessSkipped: true,
    analysisSkipped: true,
    cardsDiscovered: 87,
    bodySucceeded: 87,
    bodyFailed: 0,
    bodyCoveragePercent: 100,
    qualityPending: false,
    qualityPassed: 1,
    issues: [],
  }), 'utf8');

  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
  });
  try {
    await manager.initialize();
    const restored = manager.get(jobId);
    assert.equal(restored.status, 'completed');
    assert.equal(restored.workflowSummary.status, 'succeeded');
    assert.equal(restored.workflowSummary.cardsDiscovered, 87);
    assert.equal(restored.workflowSummary.bodySucceeded, 87);
    assert.equal(restored.workflowSummary.qualityPending, false);
    assert.equal('agentStages' in restored.workflowSummary, false);
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager preserves raw collection success while materializing result records', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-raw-materialization-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const child = createFakeChild(230810);
  await writeFile(fakeRunner, '', 'utf8');
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    checkpointAnalyzerImpl: async ({ outputDir }) => {
      const notes = JSON.parse(await readFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), 'utf8'));
      await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
        records: notes.map((note) => ({ note_id: note.note_id, body: note.body })),
      }), 'utf8');
      await writeFile(path.join(outputDir, 'workflow-summary.json'), JSON.stringify({
        status: 'completed_partial',
        analysisMode: 'partial_collection',
        agentStages: [{ id: 'coverage-agent', status: 'partial' }],
      }), 'utf8');
      await writeFile(path.join(outputDir, 'artifact-manifest.json'), JSON.stringify({
        status: 'completed_partial',
        artifacts: [
          { path: 'application_intelligence.json', bytes: 1, sha256: 'generated' },
          { path: 'workflow-summary.json', bytes: 1, sha256: 'overwritten' },
        ],
      }), 'utf8');
      return { stdout: `CHECKPOINT_ANALYSIS records=${notes.length}\n`, stderr: '' };
    },
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({
      analysisMode: 'general',
      keyword: 'public raw collection',
      skipPostprocess: true,
    }));
    await waitForJob(manager, started.id, (job) => job.status === 'running');
    const internal = manager.getInternal(started.id);
    const note = { note_id: 'raw-note-1', body: 'complete public result body', access_status: 'detail_ok' };
    await writeFile(path.join(internal.outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([note]), 'utf8');
    await writeFile(path.join(internal.outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([note]), 'utf8');
    await writeFile(path.join(internal.outputDir, 'workflow-summary.json'), JSON.stringify({
      status: 'succeeded',
      rawCollection: true,
      postprocessSkipped: true,
      analysisSkipped: true,
      cardsDiscovered: 1,
      bodySucceeded: 1,
      bodyFailed: 0,
      bodyCoveragePercent: 100,
      qualityPending: false,
      generatedAt: '2026-08-09T12:00:00.000Z',
    }), 'utf8');
    await writeFile(path.join(internal.outputDir, 'artifact-manifest.json'), JSON.stringify({
      status: 'succeeded',
      artifacts: [{ path: 'workflow-summary.json', bytes: 1, sha256: 'initial' }],
    }), 'utf8');

    const ended = waitForEnd(manager, started.id);
    child.emit('close', 0, null);
    await ended;

    const completed = manager.get(started.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.workflowSummary.status, 'succeeded');
    assert.equal(completed.workflowSummary.rawCollection, true);
    assert.equal(completed.workflowSummary.bodySucceeded, 1);
    assert.equal('agentStages' in completed.workflowSummary, false);

    const summaryBytes = await readFile(path.join(internal.outputDir, 'workflow-summary.json'));
    const diskSummary = JSON.parse(summaryBytes.toString('utf8'));
    const manifest = JSON.parse(await readFile(path.join(internal.outputDir, 'artifact-manifest.json'), 'utf8'));
    const summaryArtifact = manifest.artifacts.find((artifact) => artifact.path === 'workflow-summary.json');
    assert.equal(diskSummary.status, 'succeeded');
    assert.equal(diskSummary.rawCollection, true);
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.artifacts.some((artifact) => artifact.path === 'application_intelligence.json'), true);
    assert.equal(summaryArtifact.bytes, summaryBytes.length);
    assert.equal(summaryArtifact.sha256, crypto.createHash('sha256').update(summaryBytes).digest('hex'));
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

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

test('body rate-limit recovery logs keep the task running through cooldown and probe', () => {
  const job = { status: 'running', params: { keyword: 'test' }, progress: 0 };

  assert.equal(
    updateProgressFromLog(job, 'BODY_RATE_LIMIT warm-start attempt=1/6 spacing=30.0s stable_successes=3'),
    true,
  );
  assert.equal(job.progressPhase, 'body_rate_limit_probe');
  assert.equal(job.rateLimit.status, 'waiting');
  assert.equal(job.rateLimit.retryAfterSeconds, 30);
  assert.equal(job.rateLimit.recoveryAction, 'warm_start_probe');

  assert.equal(
    updateProgressFromLog(job, 'BODY_RATE_LIMIT cooldown attempt=1/6 wait=120.0s note=n1'),
    true,
  );
  assert.equal(job.progressPhase, 'body_rate_limit_backoff');
  assert.equal(job.rateLimit.status, 'waiting');
  assert.equal(job.rateLimit.retryAfterSeconds, 120);
  assert.equal(job.rateLimit.recoveryAction, 'automatic_backoff');

  updateProgressFromLog(job, 'BODY_RATE_LIMIT waiting attempt=1/6 remaining=45.0s');
  assert.equal(job.rateLimit.retryAfterSeconds, 45);

  updateProgressFromLog(job, 'BODY_RATE_LIMIT manual_probe attempt=1/6; skipping remaining cooldown');
  assert.equal(job.progressPhase, 'body_rate_limit_probe');
  assert.equal(job.rateLimit.retryAfterSeconds, 0);
  assert.equal(job.rateLimit.recoveryAction, 'manual_probe');

  updateProgressFromLog(job, 'BODY_RATE_LIMIT probe attempt=1/6');
  assert.equal(job.progressPhase, 'body_rate_limit_probe');
  assert.equal(job.rateLimit.recoveryAction, 'automatic_probe');

  updateProgressFromLog(job, 'BODY_RATE_LIMIT cleared stable_successes=3');
  assert.equal(job.progressPhase, 'scraping');
  assert.equal(job.rateLimit.status, 'cleared');
  assert.equal(job.rateLimit.retryAfterSeconds, 0);
});

test('body rate limit clears only after three consecutive network successes', () => {
  const job = {
    status: 'running',
    params: { keyword: 'test' },
    progress: 0,
    rateLimit: {
      detected: true,
      status: 'stopped',
      nextRetryAt: '2026-08-03T02:00:00.000Z',
      retryAfterSeconds: 120,
      recoveryAction: 'wait_then_resume',
    },
  };

  assert.equal(
    updateProgressFromLog(
      job,
      'PARALLEL_PROGRESS processed=12 total=20 complete=9 status=detail_ok round=1 round_processed=12 round_total=20',
    ),
    true,
  );
  assert.equal(job.progressPhase, 'scraping');
  assert.equal(job.rateLimit.status, 'waiting');
  assert.equal(job.rateLimit.stableSuccesses, 1);

  updateProgressFromLog(
    job,
    'PARALLEL_PROGRESS processed=13 total=20 complete=9 status=cached round=1 round_processed=13 round_total=20',
  );
  assert.equal(job.rateLimit.stableSuccesses, 1);

  updateProgressFromLog(
    job,
    'PARALLEL_PROGRESS processed=14 total=20 complete=9 status=detail_error round=1 round_processed=14 round_total=20',
  );
  assert.equal(job.rateLimit.stableSuccesses, 0);

  for (let processed = 15; processed <= 17; processed += 1) {
    updateProgressFromLog(
      job,
      `PARALLEL_PROGRESS processed=${processed} total=20 complete=${processed - 5} status=detail_ok round=1 round_processed=${processed} round_total=20`,
    );
  }
  assert.equal(job.rateLimit.status, 'cleared');
  assert.equal(job.rateLimit.stableSuccesses, 3);
  assert.equal(job.rateLimit.nextRetryAt, null);
  assert.equal(job.rateLimit.retryAfterSeconds, 0);
  assert.equal(job.rateLimit.recoveryAction, null);
  assert.ok(job.rateLimit.clearedAt);
});

test('JobManager persists monotonic workflow events and replays them after restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-events-'));
  const jobId = '20260803090000-events01';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'succeeded',
    outputDir,
    params: { keyword: 'ai产品经理', analysisMode: 'job' },
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:01:00.000Z',
    finishedAt: '2026-08-03T08:01:00.000Z',
    stages: emptyWorkflowStages(),
  }]), 'utf8');

  try {
    const first = new JobManager({ dataDir, pythonBin: 'python', runnerPath: path.join(dataDir, 'runner.py') });
    await first.initialize();
    const observed = [];
    const unsubscribe = first.subscribe(jobId, (event) => observed.push(event));
    await first.refreshArtifactCount(jobId);
    unsubscribe();

    const firstHighWater = await first.getEventHighWater(jobId);
    assert.equal(firstHighWater, 1);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].sequence, 1);
    assert.equal(observed[0].eventId, `${jobId}:1`);
    assert.equal(observed[0].workflowEvent.schemaVersion, 1);
    assert.equal(observed[0].workflowEvent.sequence, 1);
    assert.equal(observed[0].data.experienceSnapshot.throughSequence, 1);

    const firstPage = await first.listEventPage(jobId, 0, { limit: 1, throughSequence: firstHighWater });
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.nextAfter, 1);
    assert.equal(firstPage.hasMore, false);

    const journalPath = path.join(dataDir, 'job-events', `${encodeURIComponent(jobId)}.jsonl`);
    const durableLines = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(durableLines.map((event) => event.sequence), [1]);

    const restarted = new JobManager({ dataDir, pythonBin: 'python', runnerPath: path.join(dataDir, 'runner.py') });
    await restarted.initialize();
    assert.equal(await restarted.getEventHighWater(jobId), 1);
    const replay = await restarted.listEventPage(jobId, 0, { throughSequence: 1 });
    assert.deepEqual(replay.events.map((event) => event.eventId), [`${jobId}:1`]);

    await restarted.refreshArtifactCount(jobId);
    assert.equal(await restarted.getEventHighWater(jobId), 2);
    const secondPage = await restarted.listEventPage(jobId, 1, { throughSequence: 2 });
    assert.deepEqual(secondPage.events.map((event) => event.sequence), [2]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager replays a journal tail into the authoritative experience snapshot after restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-workflow-reducer-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const child = createFakeChild(230803);
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    const fixture = JSON.parse(
      await readFile(new URL('../tests/fixtures/workflow/body-events.json', import.meta.url), 'utf8'),
    );
    await manager.initialize();
    const started = await manager.start(validateRunRequest({ checkOnly: true, keyword: 'ai product manager' }));

    child.stdout.write(`${WORKFLOW_EVENT_LINE_PREFIX}${JSON.stringify(fixture.events[0])}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    const checkpointSnapshot = manager.get(started.id).experienceSnapshot;
    await manager.persist();
    const checkpointHistory = await readFile(path.join(dataDir, 'jobs.json'), 'utf8');

    for (const source of fixture.events.slice(1)) {
      child.stdout.write(`${WORKFLOW_EVENT_LINE_PREFIX}${JSON.stringify(source)}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    let expected = manager.get(started.id).experienceSnapshot;
    assert.ok(expected.throughSequence > checkpointSnapshot.throughSequence);
    assert.equal(expected.issues[0].code, fixture.expected.issueCode);
    const liveHighWater = await manager.getEventHighWater(started.id);
    const livePage = await manager.listEventPage(started.id, 0, { limit: 500, throughSequence: liveHighWater });
    const workflowEvents = livePage.events.filter((event) => event.type === 'workflow');
    assert.equal(workflowEvents.length, fixture.events.length);
    for (const event of workflowEvents) {
      assert.equal(event.data.experienceSnapshot.throughSequence, event.sequence);
      assert.equal(event.data.experienceSnapshot.jobId, started.id);
    }
    child.stdout.write('AGENT_STAGE 1/8\n');
    await new Promise((resolve) => setImmediate(resolve));
    expected = manager.get(started.id).experienceSnapshot;
    assert.equal(expected.state, 'running');
    assert.equal(expected.activeStage, 'classify');
    assert.equal(expected.stages.find((stage) => stage.stage === 'body').state, 'waiting_system');

    const ended = waitForEnd(manager, started.id);
    child.emit('close', 0, null);
    await ended;
    await manager.getEventHighWater(started.id);
    expected = manager.get(started.id).experienceSnapshot;
    assert.equal(expected.state, 'completed');
    assert.equal(expected.activeStage, null);

    // Simulate a crash after the event journal reached disk but before jobs.json caught up.
    await writeFile(path.join(dataDir, 'jobs.json'), checkpointHistory, 'utf8');
    const restarted = new JobManager({
      dataDir,
      pythonBin: 'python',
      runnerPath: fakeRunner,
      recoverImpl: async () => ({ matched: 0, terminated: 0 }),
    });
    await restarted.initialize();

    const replayed = restarted.get(started.id).experienceSnapshot;
    const body = replayed.stages.find((stage) => stage.stage === 'body');
    assert.equal(replayed.throughSequence, expected.throughSequence);
    assert.equal(replayed.activeStage, expected.activeStage);
    assert.equal(replayed.state, expected.state);
    assert.equal(replayed.counts.fullText, fixture.expected.coverageDone);
    assert.equal(replayed.counts.discovered, fixture.expected.coverageTotal);
    assert.equal(body.progress.done, fixture.expected.attemptDone);
    assert.equal(body.progress.total, fixture.expected.attemptTotal);
    assert.equal(body.progress.coverageDone, fixture.expected.coverageDone);
    assert.equal(body.progress.coverageTotal, fixture.expected.coverageTotal);
    assert.deepEqual(replayed.issues, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('proactive body cooldown is exposed as a resumable protection wait', () => {
  const job = { status: 'running', params: { keyword: 'test' }, progress: 0 };

  assert.equal(
    updateProgressFromLog(job, 'BODY_PROACTIVE_COOLDOWN every=120 wait=600.0s'),
    true,
  );
  assert.equal(job.progressPhase, 'body_proactive_cooldown');
  assert.equal(job.proactiveCooldown.status, 'waiting');
  assert.equal(job.proactiveCooldown.requestBatchSize, 120);
  assert.equal(job.proactiveCooldown.waitSeconds, 600);

  updateProgressFromLog(
    job,
    'PARALLEL_PROGRESS processed=121 total=320 complete=100 status=detail_ok round=1 round_processed=121 round_total=248',
  );
  assert.equal(job.progressPhase, 'scraping');
  assert.equal(job.proactiveCooldown.status, 'cleared');
  assert.ok(job.proactiveCooldown.clearedAt);
});

test('body cache reuse logs expose immediate progress before network collection', () => {
  const job = { status: 'running', params: { keyword: 'test' }, progress: 0 };

  assert.equal(
    updateProgressFromLog(job, 'BODY_CACHE_REUSE matched=92 complete=121/602 scanned_jobs=12'),
    true,
  );
  assert.equal(job.progressPhase, 'body_cache_reuse');
  assert.equal(job.progressCurrent, 121);
  assert.equal(job.progressTotal, 602);
  assert.equal(job.scrapedCount, 121);
  assert.equal(job.bodyCacheReusedCount, 92);
  assert.match(job.progressLabel, /92/);
});

test('JobManager restores scoped body ledger metrics instead of stale workflow counts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-body-ledger-reconcile-'));
  const jobId = '20260802092243-b5c73115';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const cards = ['post-1', 'post-2', 'post-3'].map((note_id) => ({ note_id }));
  const records = Object.fromEntries(cards.map(({ note_id }, index) => [note_id, {
    noteId: note_id,
    bodyStatus: index === 0 ? 'succeeded' : 'not_attempted',
    status: index === 0 ? 'succeeded' : 'not_attempted',
    attemptCount: 0,
    recoverable: index !== 0,
  }]));
  const bodyMetrics = {
    statisticsSource: 'bodyCompletionLedger',
    legacyInferred: false,
    discovered: 3,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    notAttempted: 2,
    blocked: 0,
    cancelled: 0,
    pending: 0,
    conservation: { valid: true },
  };
  await Promise.all([
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8'),
    writeFile(path.join(outputDir, 'body-completion-ledger.json'), JSON.stringify({
      schemaVersion: 1,
      statisticsSource: 'bodyCompletionLedger',
      legacyInferred: false,
      records,
    }), 'utf8'),
    writeFile(path.join(outputDir, 'parallel-body-summary.json'), JSON.stringify({
      cards: 3,
      sourceCards: 5,
      bodyMetrics,
      scope: { maxAgeDays: 14 },
      collectionStatus: 'partial',
      stopReason: 'cache_only',
      finishedAt: '2026-08-02T17:17:59Z',
    }), 'utf8'),
    writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
      id: jobId,
      status: 'incomplete',
      outputDir,
      discoveredCount: 5,
      scrapedCount: 2,
      params: { analysisMode: 'general', keyword: 'saved-content', maxAgeDays: 0 },
      workflowSummary: {
        cardsDiscovered: 5,
        notesCollected: 2,
        bodyMetrics: { ...bodyMetrics, discovered: 5, succeeded: 2, notAttempted: 3 },
      },
    }]), 'utf8'),
  ]);

  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
  });
  try {
    await manager.initialize();
    const restored = manager.get(jobId);
    assert.equal(restored.config.maxAgeDays, 14);
    assert.equal(restored.discoveredCount, 3);
    assert.equal(restored.scrapedCount, 1);
    assert.equal(restored.bodyMetrics.discovered, 3);
    assert.equal(restored.bodyMetrics.notAttempted, 2);
    assert.equal(restored.incompleteCount, 2);
    assert.equal(restored.progressCurrent, 1);
    assert.equal(restored.progressTotal, 3);
    assert.match(restored.progressLabel, /2/);
    assert.equal(restored.stages.bodyCompletion.status, 'partial');
    assert.equal(Object.keys(restored.stages.bodyCompletion.records).length, 3);
    assert.equal(restored.stages.bodyCompletion.attemptedCount, 0);
    assert.deepEqual(restored.workflowSummary.sourceCoverage, {
      status: 'partial',
      reason: 'cache_only',
    targetCount: 3,
    readyCount: 1,
    pendingCount: 2,
    totalRecordCount: 1,
    fullBodyCount: 1,
    statisticsSource: 'bodyCompletionLedger',
  });
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
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

    const recovery = await manager.signalRateLimitRecovery(jobId, {
      idempotencyKey: 'manual-probe-1',
    });
    assert.equal(recovery.signaled, true);
    assert.equal(recovery.duplicate, false);
    assert.equal(recovery.job.id, jobId);
    assert.equal(manager.list().length, 1);
    assert.match(
      await readFile(path.join(outputDir, '.rate-limit-recover.request'), 'utf8'),
      /^\d{4}-\d{2}-\d{2}T/,
    );

    await rm(path.join(outputDir, '.rate-limit-recover.request'), { force: true });
    const replay = await manager.signalRateLimitRecovery(jobId, {
      idempotencyKey: 'manual-probe-1',
    });
    assert.equal(replay.signaled, true);
    assert.equal(replay.duplicate, true);
    await assert.rejects(
      readFile(path.join(outputDir, '.rate-limit-recover.request'), 'utf8'),
      (error) => error?.code === 'ENOENT',
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

test('manual body recovery uses the same bounded warm-start probe as automatic recovery', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-rate-limit-manual-body-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260801090500-a11a0002';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
    { note_id: 'post-2', note_url: 'https://example.test/explore/post-2' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', body: 'Saved body', access_status: 'detail_ok' },
  ]), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'job', keyword: 'ai product manager' },
    rateLimit: { detected: true, status: 'stopped', resumeScope: 'body_completion' },
  }]), 'utf8');

  const child = createFakeChild(81011);
  let spawnedArgs = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    legacyProfilePath: path.join(dataDir, 'profiles', 'candidate_profile.json'),
    spawnImpl: (_command, args) => {
      spawnedArgs = args;
      return child;
    },
  });

  try {
    await manager.initialize();
    const started = await manager.resume(jobId, {
      scope: 'body_completion',
      forceCompleted: true,
      requestedBy: 'manual_recovery_test',
      rateLimitRecoveryMode: 'manual',
    });
    await waitForJob(manager, started.id, (job) => job.status === 'running');

    assert.equal(spawnedArgs.includes('--rate-limit-auto-recovery'), true);
    assert.equal(spawnedArgs.includes('--no-rate-limit-auto-recovery'), false);
    assert.equal(spawnedArgs[spawnedArgs.indexOf('--resume-scope') + 1], 'body_completion');

    const ended = waitForEnd(manager, jobId);
    child.emit('close', 0, null);
    await ended;
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('manual recovery starts a new automatic idempotency cycle after earlier attempts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-rate-limit-cycle-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260801090700-a11a0003';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  const oldAttemptId = `${jobId}-attempt-0001-old001`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1' },
    { note_id: 'post-2', note_url: 'https://example.test/explore/post-2' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
    { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', body: 'Saved body', access_status: 'detail_ok' },
  ]), 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir,
    params: { analysisMode: 'job', keyword: 'ai product manager' },
    currentAttemptId: oldAttemptId,
    resumeCount: 1,
    attempts: [{
      attemptId: oldAttemptId,
      sequence: 1,
      kind: 'resume',
      resumeScope: 'body_completion',
      requestedBy: 'rate_limit_auto_recovery',
      idempotencyKey: 'rate-limit-auto-body_completion-1',
      status: 'incomplete',
      startedAt: '2026-08-01T09:00:00.000Z',
      finishedAt: '2026-08-01T09:01:00.000Z',
      stopReason: 'rate_limit',
    }],
    rateLimit: {
      detected: true,
      detectedAt: '2026-08-01T09:00:00.000Z',
      status: 'stopped',
      resumeScope: 'body_completion',
      autoResumeAttempt: 1,
      maxAutoResumeAttempts: 1,
    },
  }]), 'utf8');

  const children = [createFakeChild(81012), createFakeChild(81013)];
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => children[spawnCount++],
    rateLimitRecovery: {
      enabled: true,
      initialDelayMs: 5,
      maxDelayMs: 5,
      maxAttempts: 1,
      busyDelayMs: 5,
    },
  });

  try {
    await manager.initialize();
    const manual = await manager.resume(jobId, {
      scope: 'body_completion',
      forceCompleted: true,
      requestedBy: 'manual_recovery_test',
      rateLimitRecoveryMode: 'manual',
      idempotencyKey: 'manual-cycle-2',
    });
    await waitForJob(manager, manual.id, (job) => job.status === 'running');

    const manualEnded = waitForEnd(manager, jobId);
    children[0].stdout.write('RATE_LIMIT detected; checkpoint preserved\n');
    children[0].emit('close', 1, null);
    await manualEnded;

    await waitForCondition(() => spawnCount === 2, 10_000);
    const automaticallyResumed = manager.get(jobId);
    assert.equal(automaticallyResumed.status, 'running');
    assert.equal(automaticallyResumed.attempts.length, 3);
    assert.match(
      automaticallyResumed.attempts.at(-1).idempotencyKey,
      /^rate-limit-auto-body_completion-[a-f0-9]{12}-1$/,
    );
    assert.notEqual(
      automaticallyResumed.attempts.at(-1).idempotencyKey,
      automaticallyResumed.attempts[0].idempotencyKey,
    );

    const automaticEnded = waitForEnd(manager, jobId);
    children[1].emit('close', 0, null);
    await automaticEnded;
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('completed body coverage clears a stale scheduled body recovery during startup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-complete-body-recovery-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  const jobId = '20260805082000-c0ffee01';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'failed',
    outputDir,
    params: { analysisMode: 'job', keyword: 'ai product manager' },
    progressPhase: 'rate_limit_scheduled',
    bodyMetrics: {
      discovered: 2,
      attempted: 2,
      succeeded: 2,
      failed: 0,
      notAttempted: 0,
      blocked: 0,
      cancelled: 0,
      pending: 0,
    },
    rateLimit: {
      detected: true,
      status: 'scheduled',
      resumeScope: 'body_completion',
      nextRetryAt: '2026-08-05T00:47:29.045Z',
      recoveryAction: 'automatic_resume',
    },
  }]), 'utf8');

  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
  });

  try {
    await manager.initialize();
    const job = manager.get(jobId);
    assert.equal(job.bodyMetrics.discovered, 2);
    assert.equal(job.bodyMetrics.succeeded, 2);
    assert.equal(job.rateLimit.status, 'cleared');
    assert.equal(job.rateLimit.nextRetryAt, null);
    assert.equal(job.rateLimit.recoveryAction, null);
    assert.equal(job.progressPhase, 'body_complete');
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
  const spawnedArgs = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: (_command, args) => {
      spawnedArgs.push(args);
      return children[spawnCount++];
    },
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
    assert.equal(spawnedArgs[0].includes('--no-rate-limit-auto-recovery'), true);
    assert.equal(spawnedArgs[0].includes('--rate-limit-auto-recovery'), false);
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
    assert.equal(spawnedArgs[1].includes('--rate-limit-auto-recovery'), true);
    assert.equal(spawnedArgs[1].includes('--no-rate-limit-auto-recovery'), false);
    assert.equal(spawnedArgs[1].includes('--resume'), true);
    assert.equal(spawnedArgs[1].includes('--audience-only'), true);
    assert.equal(spawnedArgs[1].includes('--collect-audience'), true);
    assert.equal(
      spawnedArgs[1][spawnedArgs[1].indexOf('--rate-limit-stable-successes') + 1],
      '3',
    );
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
  const firstChild = createFakeChild(81234);
  const secondChild = createFakeChild(81235);
  const children = [firstChild, secondChild];
  let spawnArgs = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath,
    spawnImpl: (_command, args) => { spawnArgs = args; return children.shift(); },
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
    firstChild.emit('close', 1, null);
    await waitForJob(manager, id, (job) => job.workflowSummary?.expansion?.runtimeStatus !== 'running');
    assert.equal(manager.get(id).status, parentStatus);
    assert.deepEqual(manager.list().map((job) => job.id), historyBefore);

    const nextRequest = validateExpansionStartRequest({ seedPostIds: ['post-2'], config: { rounds: 2 } });
    const next = await manager.createExpansionAttempt(id, nextRequest);
    assert.notEqual(next.attemptId, started.attemptId);
    assert.equal(next.job.workflowSummary.expansion.action, 'new_attempt');
    assert.deepEqual(next.job.workflowSummary.expansion.seedPostIds, ['post-2']);
    assert.equal(next.job.workflowSummary.expansion.attemptHistory.at(-1).attemptId, started.attemptId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(spawnArgs[0], /run_expansion_workspace\.py$/);
    const nextRequestFile = JSON.parse(await readFile(path.join(dataDir, 'jobs', id, 'expansion-request.json'), 'utf8'));
    assert.equal(nextRequestFile.action, 'new_attempt');
    assert.equal(nextRequestFile.resetExecution, true);
    assert.deepEqual(nextRequestFile.seedPostIds, ['post-2']);
    secondChild.emit('close', 1, null);
    await waitForJob(manager, id, (job) => job.workflowSummary?.expansion?.runtimeStatus !== 'running');
    assert.equal(manager.get(id).workflowSummary.expansion.runtimeStatus, 'failed');
    assert.equal(manager.get(id).workflowSummary.expansion.attemptId, next.attemptId);
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

test('auto-pauses-active-job-on-new-start', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-auto-pause-'));
  const fakeRunner = path.join(dataDir, 'runner.py');
  await writeFile(fakeRunner, '', 'utf8');
  const children = [createFakeChild(12401), createFakeChild(12402)];
  let spawnCount = 0;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    terminateImpl: async (child) => child.kill('SIGTERM'),
    spawnImpl: () => children[spawnCount++],
  });

  try {
    await manager.initialize();
    const first = await manager.start(validateRunRequest({ checkOnly: true, keyword: '旧任务' }));
    await waitForJob(manager, first.id, (job) => job.status === 'running');
    await writeFile(
      path.join(manager.getInternal(first.id).outputDir, 'xiaohongshu_cards_latest.json'),
      JSON.stringify([{ note_id: 'checkpoint-1' }]),
      'utf8',
    );
    const firstEnded = waitForEnd(manager, first.id, 15_000);
    const second = await manager.start(
      validateRunRequest({ checkOnly: true, keyword: '新任务' }),
      { pauseActive: true },
    );

    await firstEnded;
    const paused = manager.get(first.id);
    assert.equal(paused.status, 'interrupted');
    assert.equal(paused.message, '任务已自动暂停，检查点已保存，可从原任务恢复。');
    assert.equal(paused.resumeAvailable, true);
    assert.equal(manager.get(second.id).status, 'running');
    assert.equal(spawnCount, 2);

    const secondEnded = waitForEnd(manager, second.id, 15_000);
    children[1].emit('close', 0, null);
    await secondEnded;
  } finally {
    await manager.shutdown();
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
    const ended = waitForEnd(manager, active.id);
    child.emit('close', 0, null);
    await ended;
    assert.equal(manager.get(active.id).status, 'completed');
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

test('public job refreshes stale unknown runner failures from persisted snapshots', () => {
  const source = {
    id: 'stale-runner-failure',
    status: 'failed',
    params: { keyword: 'test', analysisMode: 'job' },
    bodyMetrics: {
      discovered: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      notAttempted: 0,
      blocked: 0,
      cancelled: 0,
      pending: 0,
    },
    attempts: [{
      attemptId: 'attempt-1',
      status: 'failed',
      errorCode: 'RUNNER_FAILED',
      errorMessage: 'Runner exited with code 1.',
    }],
    currentAttemptId: 'attempt-1',
  };
  const staleSnapshot = adaptLegacyJobSnapshot(source);
  staleSnapshot.headline = '当前步骤遇到未识别问题';
  staleSnapshot.issues = [mapUserProblem('UNKNOWN_ERROR', {
    saved: 0,
    total: 0,
    technicalRef: 'RUNNER_FAILED',
  })];

  const job = publicJob({ ...source, experienceSnapshot: staleSnapshot });

  assert.equal(job.experienceSnapshot.headline, '采集任务意外停止');
  assert.equal(job.experienceSnapshot.issues[0].code, 'RUNNER_FAILED');
  assert.equal(job.experienceSnapshot.issues[0].action.id, 'resume');
  assert.doesNotMatch(job.experienceSnapshot.headline, /未识别|未知/);
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

test('public job reconciles stale workflow and experience totals to the body ledger', () => {
  const source = {
    id: 'body-summary-drift',
    status: 'failed',
    params: { keyword: 'test', analysisMode: 'job' },
    discoveredCount: 912,
    scrapedCount: 715,
    bodyProcessedCount: 715,
    bodyMetrics: {
      schemaVersion: 1,
      statisticsSource: 'bodyCompletionLedger',
      discovered: 715,
      attempted: 715,
      succeeded: 715,
      failed: 0,
      notAttempted: 0,
      blocked: 0,
      cancelled: 0,
      pending: 0,
    },
    workflowSummary: {
      status: 'failed',
      cardsDiscovered: 715,
      notesCollected: 715,
      bodiesCaptured: 692,
      bodyCoveragePercent: 96.78,
      applicationCopyGenerated: 692,
      sourceCoverage: {
        targetCount: 715,
        readyCount: 715,
        pendingCount: 0,
        totalRecordCount: 692,
        fullBodyCount: 692,
      },
    },
    rateLimit: {
      detected: true,
      status: 'scheduled',
      nextRetryAt: '2026-08-04T22:47:29.045Z',
      resumeScope: 'body_completion',
    },
  };
  const staleSnapshot = adaptLegacyJobSnapshot(source);
  staleSnapshot.counts = { ...staleSnapshot.counts, discovered: 912, fullText: 715, pending: 197 };
  staleSnapshot.state = 'waiting_system';
  staleSnapshot.activeStage = 'body';
  staleSnapshot.headline = '平台暂时限制访问';
  staleSnapshot.issues = [mapUserProblem('RATE_LIMITED', {
    saved: 715,
    total: 715,
    retryAt: source.rateLimit.nextRetryAt,
  })];
  staleSnapshot.stages = staleSnapshot.stages.map((stage) => stage.stage === 'body'
    ? { ...stage, progress: { ...stage.progress, total: 912 } }
    : stage);

  const job = publicJob({ ...source, experienceSnapshot: staleSnapshot });
  const bodyStage = job.experienceSnapshot.stages.find((stage) => stage.stage === 'body');

  assert.equal(job.discoveredCount, 715);
  assert.equal(job.bodyMetrics.succeeded, 715);
  assert.equal(job.workflowSummary.bodiesCaptured, 715);
  assert.equal(job.workflowSummary.sourceCoverage.totalRecordCount, 715);
  assert.equal(job.workflowSummary.sourceCoverage.fullBodyCount, 715);
  assert.equal(job.experienceSnapshot.counts.discovered, 715);
  assert.equal(job.experienceSnapshot.counts.fullText, 715);
  assert.equal(job.experienceSnapshot.counts.pending, 0);
  assert.equal(bodyStage.progress.total, 715);
  assert.equal(bodyStage.state, 'completed');
  assert.equal(job.experienceSnapshot.issues.some((issue) => issue.code === 'RATE_LIMITED'), false);
  assert.notEqual(job.experienceSnapshot.state, 'waiting_system');
  assert.notEqual(job.experienceSnapshot.headline, '平台暂时限制访问');
  assert.equal(job.resumeAvailable, false);
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

test('JobManager preserves an in-flight expansion when the workflow state file is stale', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-expansion-restart-'));
  const id = 'stale-expansion-job';
  const jobDir = path.join(dataDir, 'jobs', id);
  const outputDir = path.join(jobDir, 'artifacts');
  const now = new Date().toISOString();
  const stages = emptyWorkflowStages();
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id,
    status: 'succeeded',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    outputDir,
    statePath: path.join(jobDir, 'workflow-state.json'),
    logPath: path.join(jobDir, 'run.log'),
    pid: null,
    expansionPid: 45679,
    params: { analysisMode: 'general', keyword: 'fixture' },
    stages,
    attempts: [],
    workflowSummary: {
      analysisMode: 'general',
      expansion: {
        attemptId: 'expansion-live',
        runtimeStatus: 'running',
        status: 'running',
        seedPostIds: ['post-1'],
        config: { rounds: 1 },
      },
    },
  }]), 'utf8');
  await initializeWorkflowState(path.join(jobDir, 'workflow-state.json'), {
    jobId: id,
    status: 'succeeded',
    createdAt: now,
    updatedAt: now,
    outputDir,
    params: { analysisMode: 'general', keyword: 'fixture' },
    activeAttemptId: null,
    currentAttemptId: null,
    resumeCount: 0,
    lastResumedAt: null,
    stages,
    attempts: [],
    workflowSummary: { analysisMode: 'general' },
    artifactCount: 0,
  });
  const recovered = [];
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: path.join(dataDir, 'runner.py'),
    recoverImpl: async (job) => {
      recovered.push({ id: job.id, pid: job.pid });
      return { matched: 1, terminated: 1, method: 'test' };
    },
  });

  try {
    await manager.initialize();
    const expansion = manager.get(id).workflowSummary.expansion;
    assert.equal(expansion.attemptId, 'expansion-live');
    assert.equal(expansion.runtimeStatus, 'interrupted');
    assert.equal(expansion.stopReason, 'server_restart');
    assert.equal(expansion.resumable, true);
    assert.deepEqual(expansion.seedPostIds, ['post-1']);
    assert.deepEqual(recovered, [{ id, pid: 45679 }]);
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
    assert.equal(job.experienceSnapshot.headline, '采集任务意外停止');
    assert.equal(job.experienceSnapshot.issues[0].code, 'RUNNER_FAILED');
    assert.equal(job.experienceSnapshot.issues[0].action.id, 'resume');
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
      candidateProfile: {
        name: 'Portable Candidate',
        school: 'Portable University',
        major: 'Product',
        email: 'portable@example.com',
      },
    }));
    const resumedOutputDir = manager.getInternal(started.id).outputDir;
    const runtimeProfile = JSON.parse(await readFile(
      path.join(path.dirname(resumedOutputDir), 'candidate-profile.runtime.json'),
      'utf8',
    ));
    assert.equal(runtimeProfile.candidate_application.email, 'portable@example.com');
    assert.equal(started.id, sourceId);
    assert.equal(started.outputDir, original.outputDir);
    assert.equal(started.createdAt, original.createdAt);
    assert.equal(resumedOutputDir, sourceOutputDir);
    assert.equal(manager.list().length, originalListLength);
    assert.equal(started.resumeCount, 1);
    assert.equal(started.attempts.length, originalAttemptCount + 1);
    assert.equal(started.attemptId, started.currentAttemptId);
    assert.equal(started.progress, 0);
    assert.equal(started.attemptProgress.done, 0);
    assert.equal(started.attemptProgress.total, 1);
    assert.equal(started.attemptProgress.coverageCountAtStart, 1);
    assert.equal(started.bodyMetrics.succeeded, 1);
    assert.equal(started.bodyMetrics.discovered, 2);
    assert.equal(started.experienceSnapshot.counts.fullText, 1);
    assert.equal(started.experienceSnapshot.counts.discovered, 2);
    const bodyStage = started.experienceSnapshot.stages.find((stage) => stage.stage === 'body');
    assert.equal(bodyStage.progress.done, 0);
    assert.equal(bodyStage.progress.total, 1);
    assert.equal(bodyStage.progress.coverageDone, 1);
    assert.equal(bodyStage.progress.coverageTotal, 2);
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

test('JobManager relocates packaged workflow state from an old computer to the current data directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-portable-history-'));
  const dataDir = path.join(root, 'portable', 'data', 'jobs');
  const jobId = '20260731005634-5c619106';
  const portableJobDir = path.join(dataDir, jobId);
  const portableOutputDir = path.join(portableJobDir, 'artifacts');
  const portableStatePath = path.join(portableJobDir, 'workflow-state.json');
  const oldJobDir = path.join(root, 'old-computer', 'data', 'jobs', jobId);
  const oldOutputDir = path.join(oldJobDir, 'artifacts');
  const fakeRunner = path.join(root, 'runner.py');

  await mkdir(portableOutputDir, { recursive: true });
  await writeFile(fakeRunner, '', 'utf8');
  await initializeWorkflowState(portableStatePath, {
    jobId,
    status: 'incomplete',
    createdAt: '2026-07-31T00:56:34.363Z',
    updatedAt: '2026-08-04T11:58:40.954Z',
    outputDir: oldOutputDir,
    params: {
      analysisMode: 'general',
      candidateProfile: { name: 'Portable Candidate', email: 'portable@example.com' },
    },
    activeAttemptId: null,
    currentAttemptId: null,
    resumeCount: 0,
    lastResumedAt: null,
    stages: emptyWorkflowStages(),
    attempts: [],
    workflowSummary: { analysisMode: 'general' },
    artifactCount: 0,
  });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'incomplete',
    outputDir: oldOutputDir,
    logPath: path.join(oldJobDir, 'run.log'),
    statePath: path.join(oldJobDir, 'workflow-state.json'),
    params: {
      analysisMode: 'general',
      candidateProfile: { name: 'Portable Candidate', email: 'portable@example.com' },
    },
  }]), 'utf8');

  const manager = new JobManager({ dataDir, pythonBin: 'python', runnerPath: fakeRunner });
  try {
    await manager.initialize();
    const relocated = manager.getInternal(jobId);
    assert.equal(relocated.outputDir, portableOutputDir);
    assert.equal(relocated.logPath, path.join(portableJobDir, 'run.log'));
    assert.equal(relocated.statePath, portableStatePath);
    const persisted = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(persisted[0].outputDir, portableOutputDir);
    assert.equal(persisted[0].statePath, portableStatePath);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

test('JobManager restores the latest events without loading an oversized journal prefix', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-large-journal-'));
  const jobId = '20260805090000-large-journal';
  const outputDir = path.join(dataDir, 'jobs', jobId, 'artifacts');
  const eventDir = path.join(dataDir, 'job-events');
  await mkdir(outputDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: jobId,
    status: 'succeeded',
    outputDir,
    params: { keyword: 'large journal', analysisMode: 'job' },
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T09:01:00.000Z',
    finishedAt: '2026-08-05T09:01:00.000Z',
    eventSequence: 41,
    stages: emptyWorkflowStages(),
  }]), 'utf8');
  const latestEvent = {
    schemaVersion: 1,
    eventId: `${jobId}:42`,
    sequence: 42,
    jobId,
    attemptId: `${jobId}:legacy`,
    occurredAt: '2026-08-05T09:01:01.000Z',
    type: 'log',
    data: { stream: 'stdout', message: 'latest durable event' },
  };
  await writeFile(
    path.join(eventDir, `${encodeURIComponent(jobId)}.jsonl`),
    `${'x'.repeat(9 * 1024 * 1024)}\n${JSON.stringify(latestEvent)}\n`,
    'utf8',
  );

  try {
    const manager = new JobManager({ dataDir, pythonBin: 'python', runnerPath: path.join(dataDir, 'runner.py') });
    await manager.initialize();
    assert.equal(await manager.getEventHighWater(jobId), 42);
    const page = await manager.listEventPage(jobId, 41, { throughSequence: 42 });
    assert.deepEqual(page.events.map((event) => event.eventId), [`${jobId}:42`]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager list omits stage ledgers while preserving full job details', () => {
  const manager = new JobManager({
    dataDir: path.join(os.tmpdir(), 'xhs-job-list-summary'),
    pythonBin: 'python',
    runnerPath: 'runner.py',
  });
  const id = 'large-ledger-job';
  manager.jobs = [{
    id,
    schemaVersion: 2,
    status: 'completed',
    params: { keyword: 'summary test', analysisMode: 'job' },
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:01:00.000Z',
    stages: {
      discovery: {
        status: 'completed',
        discoveredCount: 2,
        discoveredIds: ['note-1', 'note-2'],
        lastCheckpointAt: '2026-08-05T00:00:20.000Z',
      },
      bodyCompletion: {
        status: 'completed',
        totalCount: 2,
        completedCount: 2,
        records: {
          'note-1': { bodyStatus: 'succeeded', attemptCount: 1, body: 'x'.repeat(100_000) },
          'note-2': { bodyStatus: 'succeeded', attemptCount: 1, body: 'y'.repeat(100_000) },
        },
        lastCheckpointAt: '2026-08-05T00:00:40.000Z',
      },
      analysis: { status: 'completed', records: { 'note-1': { score: 95 } }, completedCount: 2 },
      audience: { status: 'not_started', posts: {}, replyThreads: {}, users: {} },
      artifacts: { status: 'completed', generatedFiles: ['report.json'], failedFiles: [] },
    },
    attempts: [],
  }];

  const listed = manager.list()[0];
  assert.equal(listed.stages.discovery.discoveredIds, undefined);
  assert.equal(listed.stages.bodyCompletion.records, undefined);
  assert.equal(listed.stages.analysis.records, undefined);
  assert.equal(listed.stages.artifacts.completedCount, 1);
  assert.equal(listed.experienceSnapshot.counts.discovered, 2);
  assert.equal(listed.experienceSnapshot.counts.fullText, 2);

  const detailed = manager.get(id);
  assert.equal(detailed.stages.discovery.discoveredIds.length, 2);
  assert.equal(detailed.stages.bodyCompletion.records['note-1'].body.length, 100_000);
});
