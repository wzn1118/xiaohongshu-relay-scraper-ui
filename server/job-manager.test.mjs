import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JobManager, publicJob } from './job-manager.mjs';
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
    assert.equal(manager.get(job.id).bodyProcessedCount, 2);
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
    assert.equal(manager.get(job.id).bodyProcessedCount, 999);
    assert.ok(manager.get(job.id).progressUpdatedAt);
    child.stdout.write('SECURITY_VERIFICATION detected timeout=600s; new collection paused while waiting for manual completion\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(job.id).progressPhase, 'security_verification');
    assert.equal(manager.get(job.id).securityRestriction.status, 'waiting');
    assert.equal(manager.get(job.id).securityRestriction.timeoutSeconds, 600);
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
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].id, job.id);
    assert.equal(history[0].status, 'cancelled');
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

test('public job keeps the furthest body progress from live and persisted counters', () => {
  const job = publicJob({
    id: 'persisted-body-progress',
    status: 'incomplete',
    params: { keyword: 'test' },
    discoveredCount: 258,
    scrapedCount: 93,
    bodyProcessedCount: 107,
    workflowSummary: {
      cardsDiscovered: 258,
      notesCollected: 93,
      bodyAttempted: 181,
    },
  });

  assert.equal(job.bodyProcessedCount, 181);
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
        modules: [{ id: 'highlights', title: '展览亮点', summary: '聚焦公共空间。', items: [], evidence: [] }],
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
    assert.equal(manager.list()[0].applicationCount, 1);
    assert.equal(manager.list()[0].incompleteCount, 0);
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

test('JobManager materializes every discovered job while scraping and preserves it after cancellation', async () => {
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
      const cards = JSON.parse(await readFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), 'utf8'));
      analyzed.push(cards.length);
      await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
        records: cards.map((card) => ({ note_id: card.note_id })),
      }), 'utf8');
      await writeFile(path.join(outputDir, 'workflow-summary.json'), JSON.stringify({
        cardsDiscovered: cards.length,
        jobCardsGenerated: cards.length,
        applicationCopyGenerated: cards.length,
      }), 'utf8');
      return { stdout: `CHECKPOINT_ANALYSIS records=${cards.length}\n`, stderr: '' };
    },
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({ checkOnly: true }));
    const outputDir = manager.getInternal(started.id).outputDir;
    const cards = Array.from({ length: 3 }, (_, index) => ({ note_id: `note-${index + 1}` }));
    await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify(cards), 'utf8');
    await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify(cards.slice(0, 1)), 'utf8');
    await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
      records: Array.from({ length: 3 }, (_, index) => ({ note_id: `stale-${index + 1}` })),
    }), 'utf8');
    child.stdout.write('Collected 3 note links. Starting note extraction...\n');
    for (let attempt = 0; attempt < 100 && manager.get(started.id).applicationCount !== 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(analyzed, [3]);
    assert.equal(manager.get(started.id).status, 'running');
    assert.equal(manager.get(started.id).applicationCount, 3);
    const livePayload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
    assert.equal(livePayload.records.length, 3);
    assert.deepEqual(livePayload.records.map((record) => record.note_id), cards.map((card) => card.note_id));
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
    assert.deepEqual(analyzed, [3]);
    assert.equal(job.workflowSummary.jobCardsGenerated, 3);
    assert.equal(job.workflowSummary.applicationCopyGenerated, 3);
    const payload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
    assert.equal(payload.records.length, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager cleans persisted process identity before marking a restarted job interrupted', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-job-restart-'));
  const outputDir = path.join(dataDir, 'jobs', 'stale-job', 'artifacts');
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
    assert.deepEqual(recovered, [{ id: 'stale-job', pid: 45678, outputDir }]);
    const history = JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(history[0].cleanupResult.terminated, 2);
    assert.ok(history[0].cleanupConfirmedAt);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager copies card and note checkpoints into a resumed task', async () => {
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
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    assert.equal(manager.get(sourceId).resumeAvailable, true);
    const started = await manager.start(validateRunRequest({
      checkOnly: true,
      mode: 'resume',
      resumeFromJobId: sourceId,
    }));
    const resumedOutputDir = manager.getInternal(started.id).outputDir;
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
    child.emit('close', 0, null);
    await ended;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('JobManager rediscovers latest cards instead of copying a legacy comprehensive checkpoint', async () => {
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
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath: fakeRunner,
    spawnImpl: () => child,
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const started = await manager.start(validateRunRequest({
      checkOnly: true,
      mode: 'resume',
      resumeFromJobId: sourceId,
      completeMissingOnly: true,
    }));
    const resumed = manager.getInternal(started.id);
    assert.equal(resumed.params.searchSort, 'latest');
    assert.equal(resumed.params.completeMissingOnly, false);
    await assert.rejects(
      readFile(path.join(resumed.outputDir, 'xiaohongshu_cards_latest.json'), 'utf8'),
      (error) => error.code === 'ENOENT',
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
    child.emit('close', 0, null);
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
