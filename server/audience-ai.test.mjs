import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createApp } from './app.mjs';
import { AudienceAiService } from './audience-ai-service.mjs';
import {
  AudienceAiValidationError,
  validateAudienceAiStartRequest,
} from './lib/audience-ai-contracts.mjs';
import { buildAudienceAiInput } from './lib/audience-ai-input.mjs';
import { buildAudienceProfileEnrichmentPlan } from './lib/audience-ai-profile-enrichment.mjs';
import { AudienceAiStore } from './lib/audience-ai-store.mjs';

const JOB_ID = '20260801010101-abcdef12';
const POST_ID = 'post-1';

test('audience AI request contract rejects unknown fields and enforces explicit recent-post budgets', () => {
  assert.throws(
    () => validateAudienceAiStartRequest({ ...requestScope(), unexpected: true }),
    (error) => error instanceof AudienceAiValidationError
      && error.details.some((item) => item.field === 'unexpected' && item.reason === 'not_allowed'),
  );
  assert.throws(
    () => validateAudienceAiStartRequest({ ...requestScope(), profileMode: 'recent_public_posts' }),
    (error) => error instanceof AudienceAiValidationError
      && error.details.some((item) => ['profilePostLimitPerUser', 'profilePostTotalLimit'].includes(item.field)),
  );
  const parsed = validateAudienceAiStartRequest({
    ...requestScope(),
    profileMode: 'recent_public_posts',
    profileUserLimit: 2,
    profilePostLimitPerUser: 3,
    profilePostTotalLimit: 5,
  });
  assert.equal(parsed.profilePostTotalLimit, 5);
});

test('profile enrichment planning targets only users from the selected post and respects mode limits', () => {
  const snapshot = {
    postId: POST_ID,
    users: [
      { userId: 'u-missing', profile: { available: false, missingFields: ['bio'] } },
      { userId: 'u-complete', profile: { available: true, missingFields: [] } },
      { userId: 'synthetic-user-1', syntheticIdentity: true },
    ],
  };
  const headerPlan = buildAudienceProfileEnrichmentPlan(snapshot, {
    profileMode: 'collect_missing_header', profileUserLimit: 10,
    profilePostLimitPerUser: 0, profilePostTotalLimit: 0,
  });
  assert.deepEqual(headerPlan.userIds, ['u-missing']);
  const postsPlan = buildAudienceProfileEnrichmentPlan(snapshot, {
    profileMode: 'recent_public_posts', profileUserLimit: 1,
    profilePostLimitPerUser: 2, profilePostTotalLimit: 2,
  });
  assert.deepEqual(postsPlan.userIds, ['u-missing']);
  assert.equal(postsPlan.estimatedNetworkRequests, 3);
  assert.equal(buildAudienceProfileEnrichmentPlan(snapshot, { profileMode: 'none' }), null);
  assert.equal(buildAudienceProfileEnrichmentPlan(snapshot, { profileMode: 'available_header' }), null);
});

test('audience AI is disabled unless the feature flag is explicitly enabled', async () => {
  const service = new AudienceAiService({
    manager: {},
    aiSessions: {},
    config: {},
  });
  await assert.rejects(
    service.getState(JOB_ID, POST_ID),
    (error) => error.code === 'AUDIENCE_AI_DISABLED',
  );
  await service.close();
});

test('audience AI SQLite store isolates posts, atomically replaces snapshots, and recovers interrupted runs', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-store-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dbPath = path.join(fixture, 'audience-ai-state.sqlite3');
  const store = await new AudienceAiStore(dbPath).initialize();
  const createdAt = new Date().toISOString();
  store.createRun(storeRun({ runId: 'run-a', postId: 'post-a', idempotencyKey: 'idem-post-a', semanticKey: 'semantic-a', createdAt }));
  store.createRun(storeRun({ runId: 'run-b', postId: 'post-b', idempotencyKey: 'idem-post-b', semanticKey: 'semantic-b', createdAt }));
  store.saveSnapshot(storeSnapshot({ runId: 'run-a', postId: 'post-a', revision: 'revision-a', createdAt }));
  store.replaceSnapshot(storeSnapshot({
    runId: 'run-a', postId: 'post-a', revision: 'revision-a2', semanticKey: 'semantic-a2', createdAt: new Date().toISOString(),
  }));
  assert.equal(store.getRun('run-a').inputRevision, 'revision-a2');
  assert.equal(store.getSnapshot('run-a').inputRevision, 'revision-a2');
  assert.equal(store.listRuns(JOB_ID, 'post-a').length, 1);
  assert.equal(store.listRuns(JOB_ID, 'post-b').length, 1);
  const semanticReuse = store.createRun({
    ...storeRun({ runId: 'run-c', postId: 'post-a', idempotencyKey: 'idem-post-c', semanticKey: 'semantic-a2', createdAt }),
    inputRevision: 'revision-a2',
    configHash: 'config-run-a',
  });
  assert.equal(semanticReuse.reused, true);
  assert.equal(semanticReuse.run.runId, 'run-a');
  assert.throws(() => store.createRun({
    ...storeRun({ runId: 'run-conflict', postId: 'post-a', idempotencyKey: 'idem-post-a', semanticKey: 'semantic-conflict', createdAt }),
    inputRevision: 'different-revision',
    configHash: 'config-run-a',
  }), { code: 'AUDIENCE_AI_REVISION_CONFLICT' });

  for (let index = 1; index <= 651; index += 1) store.appendEvent('run-a', 'audience_ai_progress', { index });
  const highWater = store.getLatestEventSequence(JOB_ID, 'post-a');
  const firstPage = store.listEvents(JOB_ID, 'post-a', 0, 500, highWater);
  const secondPage = store.listEvents(JOB_ID, 'post-a', firstPage.at(-1).sequence, 500, highWater);
  assert.equal(firstPage.length, 500);
  assert.equal(secondPage.length, 151);
  assert.deepEqual(
    { runId: firstPage[0].runId, jobId: firstPage[0].jobId, postId: firstPage[0].postId },
    { runId: 'run-a', jobId: JOB_ID, postId: 'post-a' },
  );
  assert.deepEqual([...firstPage, ...secondPage].map((event) => event.data.index), Array.from({ length: 651 }, (_, index) => index + 1));

  const cancelled = store.transitionRun('run-b', ['snapshotting'], { status: 'cancelled', cancelledAt: new Date().toISOString() });
  assert.equal(cancelled.changed, true);
  const lateUpdate = store.transitionRun('run-b', ['snapshotting', 'analyzing_comments'], { status: 'completed' });
  assert.equal(lateUpdate.changed, false);
  assert.equal(lateUpdate.run.status, 'cancelled');
  const materialized = store.replaceMaterialization('run-a', {
    chunks: [{ chunkId: 'chunk-1', kind: 'thread_map', entityIds: ['comment-1'], inputHash: 'a'.repeat(64), status: 'complete', attemptCount: 1, outputHash: 'b'.repeat(64) }],
    comments: [{ commentId: 'comment-1', confidence: 0.9 }],
    threads: [{ rootThreadId: 'comment-1', confidence: 0.8 }],
    users: [{ userId: 'user-1', confidence: 0.7 }],
    evidence: [{ evidenceId: 'comment:comment-1', entityType: 'comment', entityId: 'comment-1' }],
  });
  assert.equal(materialized.chunks.length, 1);
  assert.equal(materialized.insights.length, 3);
  assert.equal(materialized.evidence.length, 1);
  assert.equal(materialized.evidence[0].validated, true);
  store.close();

  const reopened = await new AudienceAiStore(dbPath).initialize();
  assert.equal(reopened.getRun('run-a').status, 'interrupted');
  assert.equal(reopened.getRun('run-a').resumable, true);
  reopened.close();
});

test('audience AI input binds the authoritative post body, comment tree, and selected users', async (t) => {
  const fixture = await createAudienceFixture(t);
  t.after(fixture.cleanup);
  const snapshot = await buildAudienceAiInput({
    manager: fixture.manager,
    jobId: JOB_ID,
    postId: POST_ID,
    scope: validateAudienceAiStartRequest(requestScope()),
    model: { provider: 'openai', model: 'test-model', wireApi: 'responses' },
  });
  assert.equal(snapshot.originalPost.body, '原帖完整正文');
  assert.equal(snapshot.comments.length, 2);
  assert.equal(snapshot.comments[1].rootThreadId, 'comment-1');
  assert.deepEqual(snapshot.users.map((item) => item.userId).sort(), ['user-1', 'user-2']);
  assert.equal(snapshot.source.checkpointJobId, JOB_ID);
  assert.match(snapshot.inputRevision, /^[a-f0-9]{64}$/u);
});

test('coverage reports persisted profile headers and recent posts when profile analysis is disabled', async (t) => {
  const fixture = await createAudienceFixture();
  t.after(fixture.cleanup);
  const usersPath = path.join(fixture.outputDir, 'audience-users.json');
  const persistedUsers = JSON.parse(await readFile(usersPath, 'utf8'));
  persistedUsers[1].recent_public_posts = [{ post_id: 'profile-note-1', title: 'Recent public post' }];
  await writeFile(usersPath, JSON.stringify(persistedUsers), 'utf8');
  const snapshot = await buildAudienceAiInput({
    manager: fixture.manager,
    jobId: JOB_ID,
    postId: POST_ID,
    scope: validateAudienceAiStartRequest({
      ...requestScope(),
      profileMode: 'none',
      profileUserLimit: 0,
    }),
    model: { provider: 'openai', model: 'test-model', wireApi: 'responses' },
  });
  assert.equal(snapshot.coverage.profilesSelected, 0);
  assert.equal(snapshot.coverage.profilesAvailable, 1);
  assert.equal(snapshot.coverage.profilesComplete, 1);
  assert.equal(snapshot.coverage.profilesMissing, 1);
  assert.equal(snapshot.coverage.profilePostUsersAvailable, 1);
  assert.equal(snapshot.coverage.profilePostsAvailable, 1);
});

test('audience AI service enriches in the same job, refreezes input, runs idempotently, and never persists the API key', async (t) => {
  const fixture = await createAudienceFixture(t);
  const secret = ['s', 'k', '-test-secret-that-must-stay-in-memory'].join('');
  let enrichmentCalls = 0;
  let spawnCapture;
  const profileEnricher = async (request) => {
    enrichmentCalls += 1;
    assert.equal(request.jobId, JOB_ID);
    assert.equal(request.postId, POST_ID);
    assert.deepEqual(request.userIds, ['user-1']);
    assert.match(request.checkpointPath, /audience-ai-profile-checkpoints/u);
    await request.onEvent({ stage: 'waiting_relay', completedUsers: 0, totalUsers: 1, message: 'Relay busy; waiting.' });
    await request.onEvent({ stage: 'collecting_profile_headers', completedUsers: 0, totalUsers: 1 });
    const usersPath = path.join(fixture.outputDir, 'audience-users.json');
    const users = JSON.parse(await readFile(usersPath, 'utf8'));
    users[0] = {
      ...users[0], bio: '补采后的公开简介', follower_count: 42,
      enrichment_status: 'complete', last_enriched_at: new Date().toISOString(),
    };
    await writeFile(usersPath, JSON.stringify(users), 'utf8');
    await request.onEvent({ stage: 'collecting_profile_headers', completedUsers: 1, totalUsers: 1, profilesUsed: 1 });
    return { status: 'completed', coverage: { profilesCompleted: 1 }, checkpoint: { cursor: 1 } };
  };
  const service = new AudienceAiService({
    manager: fixture.manager,
    aiSessions: { resolve: (id) => {
      assert.equal(id, 'session-1');
      return { provider: 'openai', model: 'test-model', wireApi: 'responses', apiKey: secret, baseUrl: 'https://api.example.test' };
    } },
    config: {
      audienceAiEnabled: true,
      audienceAiRunnerPath: path.join(fixture.root, 'run_audience_ai.py'),
      audienceAiMaxConcurrent: 2,
      pythonBin: 'python',
    },
    profileEnricher,
    spawnImpl: createFakeRunner((capture) => { spawnCapture = capture; }),
  });
  t.after(async () => {
    await service.close();
    await fixture.cleanup();
  });

  const before = await service.getState(JOB_ID, POST_ID);
  assert.equal(before.status, 'not_started');
  const preview = await service.preview(JOB_ID, POST_ID, validateAudienceAiStartRequest(requestScope()));
  assert.equal(preview.estimate.estimatedChunks > 0, true);
  assert.equal(preview.estimate.estimatedCalls > 0, true);
  assert.equal(preview.estimate.estimatedNetworkRequests, 1);
  assert.equal(preview.estimatedNetworkRequests, preview.estimate.estimatedNetworkRequests);
  const started = await service.start(JOB_ID, POST_ID, validateAudienceAiStartRequest(requestScope()));
  assert.equal(started.reused, false);
  const completed = await waitForRun(service, started.run.runId, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(enrichmentCalls, 1);
  assert.equal(fixture.startCalls, 0, 'profile enrichment must not create a top-level job');
  assert.equal(spawnCapture.env.XHS_AI_API_KEY, secret);
  assert.ok(!spawnCapture.args.join(' ').includes(secret));
  const frozen = JSON.parse(await readFile(spawnCapture.snapshotPath, 'utf8'));
  assert.equal(frozen.jobId, JOB_ID);
  assert.equal(frozen.postId, POST_ID);
  assert.equal(frozen.profileEnrichment.status, 'completed');
  assert.equal(frozen.profileEnrichment.refrozenAt.length > 0, true);
  assert.equal(frozen.users.find((item) => item.userId === 'user-1').profile.bio, '补采后的公开简介');
  assert.ok(!JSON.stringify(frozen).includes(secret));

  const latest = JSON.parse(await readFile(path.join(path.dirname(spawnCapture.outputDir), 'latest.json'), 'utf8'));
  assert.equal(latest.runId, started.run.runId);
  assert.match(latest.manifestSha256, /^[a-f0-9]{64}$/u);
  const inspectionStore = await new AudienceAiStore(path.join(fixture.root, 'job', 'audience-ai-state.sqlite3')).initialize();
  const materialized = inspectionStore.getMaterialization(started.run.runId);
  assert.equal(materialized.insights.length, 3);
  assert.equal(materialized.evidence.length, 1);
  inspectionStore.close();

  const result = await service.getResults(JOB_ID, POST_ID, { module: 'analysis', offset: 0, limit: 50, runId: started.run.runId });
  assert.deepEqual(result.data.summary, { conclusion: 'fixture' });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.analysis, result.data);
  const comments = await service.getResults(JOB_ID, POST_ID, { module: 'comments', offset: 0, limit: 50, runId: started.run.runId });
  assert.deepEqual(comments.data, comments.items);

  const reused = await service.start(JOB_ID, POST_ID, validateAudienceAiStartRequest({
    ...requestScope(), idempotencyKey: 'audience-ai-test-key-after-refreeze',
  }));
  assert.equal(reused.reused, true);
  assert.equal(reused.run.runId, started.run.runId);
  assert.equal(enrichmentCalls, 1);

  const commentsPath = path.join(fixture.outputDir, 'audience-comments.json');
  const changedComments = JSON.parse(await readFile(commentsPath, 'utf8'));
  changedComments.push({ comment_id: 'comment-3', post_id: POST_ID, text: 'new evidence', user: { user_id: 'user-1' } });
  await writeFile(commentsPath, JSON.stringify(changedComments), 'utf8');
  const stale = await service.getState(JOB_ID, POST_ID);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.activeVersion.stale, true);
  const staleEvents = await service.listEvents(JOB_ID, POST_ID);
  const staleEvent = staleEvents.find((event) => event.type === 'audience_ai_stale');
  assert.ok(staleEvent);
  assert.equal(staleEvent.runId, started.run.runId);
  assert.equal(staleEvent.data.inputRevision, stale.activeVersion.inputRevision);
  assert.notEqual(staleEvent.data.currentInputRevision, stale.activeVersion.inputRevision);
  await service.getState(JOB_ID, POST_ID);
  const repeatedStaleEvents = (await service.listEvents(JOB_ID, POST_ID))
    .filter((event) => event.type === 'audience_ai_stale' && event.runId === started.run.runId);
  assert.equal(repeatedStaleEvents.length, 1);
});

test('profile enrichment security blocks are resumable in the same run without launching model analysis', async (t) => {
  const fixture = await createAudienceFixture(t);
  let spawnCalls = 0;
  let enrichmentCalls = 0;
  const service = new AudienceAiService({
    manager: fixture.manager,
    aiSessions: { resolve: () => ({ provider: 'openai', model: 'test', apiKey: 'sk-runtime-only' }) },
    config: { audienceAiEnabled: true, audienceAiRunnerPath: 'runner.py' },
    profileEnricher: async ({ onEvent }) => {
      enrichmentCalls += 1;
      await onEvent({ stage: 'security_verification', message: 'Verification required.' });
      return { status: 'blocked', errorCode: 'AUDIENCE_AI_SECURITY_BLOCKED', message: 'Verification required.' };
    },
    spawnImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
  });
  t.after(async () => {
    await service.close();
    await fixture.cleanup();
  });
  const started = await service.start(JOB_ID, POST_ID, validateAudienceAiStartRequest(requestScope()));
  const blocked = await waitForRun(service, started.run.runId, 'blocked');
  assert.equal(blocked.resumable, true);
  assert.equal(blocked.errorCode, 'AUDIENCE_AI_SECURITY_BLOCKED');
  assert.equal(spawnCalls, 0);
  const events = await service.listEvents(JOB_ID, POST_ID);
  assert.ok(events.some((event) => event.type === 'audience_ai_blocked' && event.data.stage === 'security_verification'));
  const resumed = await Promise.all([
    service.resume(JOB_ID, POST_ID, started.run.runId),
    service.resume(JOB_ID, POST_ID, started.run.runId),
  ]);
  assert.deepEqual(resumed.map((result) => result.reused).sort(), [false, true]);
  await waitForRun(service, started.run.runId, 'blocked');
  assert.equal(spawnCalls, 0);
  assert.equal(enrichmentCalls, 2, 'only one of the concurrent resume calls may launch enrichment');
});

test('service shutdown aborts active profile enrichment and persists an interrupted resumable run', async (t) => {
  const fixture = await createAudienceFixture(t);
  let enrichmentStarted;
  const startedSignal = new Promise((resolve) => { enrichmentStarted = resolve; });
  let enrichmentAborted = false;
  const service = new AudienceAiService({
    manager: fixture.manager,
    aiSessions: { resolve: () => ({ provider: 'openai', model: 'test', apiKey: 'sk-runtime-only' }) },
    config: { audienceAiEnabled: true, audienceAiRunnerPath: 'runner.py' },
    profileEnricher: ({ signal }) => new Promise((resolve) => {
      enrichmentStarted();
      signal.addEventListener('abort', () => {
        enrichmentAborted = true;
        resolve({ status: 'cancelled', message: 'stopped' });
      }, { once: true });
    }),
    spawnImpl: () => { throw new Error('model runner must not start during shutdown'); },
  });
  t.after(fixture.cleanup);

  const started = await service.start(JOB_ID, POST_ID, validateAudienceAiStartRequest(requestScope()));
  await startedSignal;
  await service.close();

  assert.equal(enrichmentAborted, true);
  const dbPath = path.join(path.dirname(fixture.outputDir), 'audience-ai-state.sqlite3');
  const reopened = await new AudienceAiStore(dbPath).initialize();
  const interrupted = reopened.getRun(started.run.runId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.resumable, true);
  reopened.close();
});

test('service startup scans existing audience AI stores and recovers abandoned running states', async (t) => {
  const fixture = await createAudienceFixture();
  const dbPath = path.join(path.dirname(fixture.outputDir), 'audience-ai-state.sqlite3');
  const seed = await new AudienceAiStore(dbPath).initialize();
  seed.createRun(storeRun({
    runId: 'run-startup-recovery',
    postId: POST_ID,
    idempotencyKey: 'idem-startup-recovery',
    semanticKey: 'semantic-startup-recovery',
    createdAt: new Date().toISOString(),
  }));
  seed.close();

  let recoveredStatus = null;
  let initializedStores = 0;
  const service = new AudienceAiService({
    manager: fixture.manager,
    aiSessions: {},
    config: { audienceAiEnabled: true },
    storeFactory: (filePath) => {
      const store = new AudienceAiStore(filePath);
      const initialize = store.initialize.bind(store);
      store.initialize = async () => {
        initializedStores += 1;
        await initialize();
        recoveredStatus = store.getRun('run-startup-recovery').status;
        return store;
      };
      return store;
    },
  });
  t.after(async () => {
    await service.close();
    await fixture.cleanup();
  });

  await service.initialize();

  assert.equal(initializedStores, 1);
  assert.equal(recoveredStatus, 'interrupted');
});

test('job quiesce waits for in-flight run setup before closing the audience AI store', async (t) => {
  const fixture = await createAudienceFixture(t);
  let service;
  let quiescePromise;
  const storeFactory = (filePath) => {
    const store = new AudienceAiStore(filePath);
    const createRun = store.createRun.bind(store);
    store.createRun = (value) => {
      const result = createRun(value);
      queueMicrotask(() => { quiescePromise = service.quiesceJob(JOB_ID); });
      return result;
    };
    return store;
  };
  service = new AudienceAiService({
    manager: fixture.manager,
    aiSessions: { resolve: () => ({ provider: 'openai', model: 'test', apiKey: 'sk-runtime-only' }) },
    config: { audienceAiEnabled: true, audienceAiRunnerPath: 'runner.py' },
    storeFactory,
    spawnImpl: () => { throw new Error('quiescing setup must not launch model analysis'); },
  });
  t.after(async () => {
    service.releaseJobQuiesce(JOB_ID);
    await service.close();
    await fixture.cleanup();
  });

  const started = await service.start(JOB_ID, POST_ID, validateAudienceAiStartRequest({
    ...requestScope(),
    profileMode: 'none',
    profileUserLimit: 0,
  }));
  assert.ok(quiescePromise, 'quiesce must begin while the run setup mutation is still in flight');
  await quiescePromise;
  assert.equal(started.run.status, 'cancelled');
  await assert.rejects(
    service.getState(JOB_ID, POST_ID),
    (error) => error.code === 'AUDIENCE_AI_INTERNAL_ERROR',
  );

  const dbPath = path.join(path.dirname(fixture.outputDir), 'audience-ai-state.sqlite3');
  const reopened = await new AudienceAiStore(dbPath).initialize();
  assert.equal(reopened.getRun(started.run.runId).status, 'cancelled');
  reopened.close();
});

test('HTTP routes return stable audience AI job errors and strict request errors', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-http-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const internal = { id: JOB_ID, outputDir: path.join(fixture, 'artifacts'), logPath: path.join(fixture, 'run.log') };
  await mkdir(internal.outputDir, { recursive: true });
  const manager = {
    active: null,
    getInternal: (id) => id === JOB_ID ? internal : null,
    get: () => null,
    list: () => [],
  };
  const audienceAiService = {
    getState: async (jobId, postId) => ({ jobId, postId, status: 'not_started', currentRun: null, activeVersion: null, versions: [] }),
  };
  const server = http.createServer(createApp({
    manager,
    config: { maxBodyBytes: 32_768, staticDir: fixture, audienceAiEnabled: true, audienceAiRunnerAvailable: true },
    aiSessions: {},
    audienceAiService,
    relaySupervisor: { snapshot: () => ({}) },
    preflightService: {},
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const missing = await fetch(`${base}/api/jobs/20260801010101-deadbeef/audience/posts/${POST_ID}/ai`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).errorCode, 'AUDIENCE_AI_JOB_NOT_FOUND');
  const invalid = await fetch(`${base}/api/jobs/${JOB_ID}/audience/posts/${POST_ID}/ai/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestScope(), unexpected: true }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.errorCode, 'AUDIENCE_AI_INVALID_SCOPE');
  assert.equal(invalidBody.jobId, JOB_ID);
  assert.equal(invalidBody.postId, POST_ID);
});

test('audience AI SSE snapshots first, pages the complete backlog, and closes the subscribe race', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-sse-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const internal = { id: JOB_ID, outputDir: path.join(fixture, 'artifacts'), logPath: path.join(fixture, 'run.log') };
  await mkdir(internal.outputDir, { recursive: true });
  const persisted = Array.from({ length: 650 }, (_, index) => ({
    sequence: index + 1,
    runId: 'run-sse',
    jobId: JOB_ID,
    postId: POST_ID,
    type: 'audience_ai_progress',
    data: { index: index + 1, postId: 'untrusted-post-context' },
  }));
  let listener = null;
  const audienceAiService = {
    subscribe(jobId, postId, next) {
      assert.equal(jobId, JOB_ID);
      assert.equal(postId, POST_ID);
      listener = next;
      return () => { listener = null; };
    },
    async getEventHighWater() {
      listener?.({
        sequence: 651,
        runId: 'run-sse',
        jobId: JOB_ID,
        postId: POST_ID,
        type: 'audience_ai_progress',
        data: { index: 651, postId: 'untrusted-post-context' },
      });
      return 650;
    },
    async getState(jobId, postId) {
      return { jobId, postId, status: 'running', currentRun: { runId: 'run-sse' }, activeVersion: null, versions: [] };
    },
    async listEventPage(_jobId, _postId, afterSequence, { limit, throughSequence }) {
      assert.equal(limit, 500);
      assert.equal(throughSequence, 650);
      const events = persisted.filter((event) => event.sequence > afterSequence && event.sequence <= throughSequence).slice(0, limit);
      const nextAfter = events.at(-1)?.sequence ?? afterSequence;
      return { events, nextAfter, hasMore: nextAfter < throughSequence, throughSequence };
    },
  };
  const server = http.createServer(createApp({
    manager: {
      active: null,
      getInternal: (id) => id === JOB_ID ? internal : null,
      get: () => null,
      list: () => [],
    },
    config: { maxBodyBytes: 32_768, staticDir: fixture, audienceAiEnabled: true, audienceAiRunnerAvailable: true },
    aiSessions: {},
    audienceAiService,
    relaySupervisor: { snapshot: () => ({}) },
    preflightService: {},
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${JOB_ID}/audience/posts/${POST_ID}/ai/events`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/u);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (!body.includes('id: 651\n')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'SSE stream ended before the buffered live event was delivered');
    body += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  controller.abort();
  server.closeAllConnections();

  const blocks = body.split('\n\n').filter(Boolean);
  assert.match(blocks[0], /event: audience_ai_snapshot/u);
  const sequences = blocks
    .map((block) => /^id: (\d+)$/mu.exec(block)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.equal(sequences.length, 651);
  assert.deepEqual(sequences, Array.from({ length: 651 }, (_, index) => index + 1));
  assert.equal(new Set(sequences).size, sequences.length);
  const firstProgress = JSON.parse(/^data: (.+)$/mu.exec(blocks[1])[1]);
  assert.deepEqual(
    { runId: firstProgress.runId, jobId: firstProgress.jobId, postId: firstProgress.postId },
    { runId: 'run-sse', jobId: JOB_ID, postId: POST_ID },
  );
});

function requestScope() {
  return {
    aiSessionId: 'session-1',
    includeTopLevelComments: true,
    includeReplies: true,
    includeUsers: true,
    profileMode: 'collect_missing_header',
    profileUserLimit: 10,
    profilePostLimitPerUser: 0,
    profilePostTotalLimit: 0,
    modules: ['comment_insights', 'thread_insights', 'user_insights', 'audience_segments', 'content_fit', 'content_opportunities'],
    outputLanguage: 'zh-CN',
    evidenceStrictness: 'strict',
    incrementalOnly: false,
    idempotencyKey: 'audience-ai-test-key',
  };
}

async function createAudienceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-service-'));
  const outputDir = path.join(root, 'job', 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({ records: [{
    note_id: POST_ID,
    title: '原帖标题',
    body: '原帖完整正文',
    note_url: `https://www.xiaohongshu.com/explore/${POST_ID}`,
    author: { user_id: 'author-1', display_name: '作者' },
    media: { images: ['cover.webp'] },
  }] }), 'utf8');
  await writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([{
    post_id: POST_ID, title: '原帖标题', note_url: `https://www.xiaohongshu.com/explore/${POST_ID}`,
    expected_comment_count: 2, status: 'complete',
  }]), 'utf8');
  await writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([
    { comment_id: 'comment-1', post_id: POST_ID, text: '一级评论', user: { user_id: 'user-1', display_name: '用户一' } },
    { comment_id: 'comment-2', post_id: POST_ID, parent_comment_id: 'comment-1', text: '回复评论', user: { user_id: 'user-2', display_name: '用户二' } },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([
    { user_id: 'user-1', display_name: '用户一', post_ids: [POST_ID], enrichment_status: 'pending', missing_profile_fields: ['bio'] },
    { user_id: 'user-2', display_name: '用户二', post_ids: [POST_ID], bio: '已有简介', enrichment_status: 'complete' },
  ]), 'utf8');
  await writeFile(path.join(outputDir, 'audience-summary.json'), JSON.stringify({ status: 'complete', commentsCollected: 2, usersDiscovered: 2 }), 'utf8');
  let startCalls = 0;
  const internal = { id: JOB_ID, outputDir, logPath: path.join(root, 'job', 'run.log'), params: {} };
  const manager = {
    active: null,
    getInternal: (id) => id === JOB_ID ? internal : null,
    get: (id) => id === JOB_ID ? { id: JOB_ID, config: {} } : null,
    list: () => [{ id: JOB_ID, config: {} }],
    start: async () => { startCalls += 1; throw new Error('must not create a new job'); },
  };
  return {
    root,
    outputDir,
    internal,
    manager,
    cleanup: () => rm(root, { recursive: true, force: true }),
    get startCalls() { return startCalls; },
  };
}

function createFakeRunner(onSpawn) {
  return (_command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 2, 'SIGTERM');
    const inputIndex = args.indexOf('--input');
    const outputIndex = args.indexOf('--output-dir');
    const runIndex = args.indexOf('--run-id');
    const snapshotPath = args[inputIndex + 1];
    const outputDir = args[outputIndex + 1];
    const runId = args[runIndex + 1];
    onSpawn({ args, env: options.env, snapshotPath, outputDir, runId });
    setImmediate(async () => {
      try {
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
        await writeArtifacts(outputDir, snapshot, runId);
        child.stdout.write(`AUDIENCE_AI_EVENT ${JSON.stringify({ type: 'audience_ai_completed', runId, postId: snapshot.postId, stage: 'completed', completedUnits: 4, totalUnits: 4 })}\n`);
        child.stdout.end();
        child.emit('exit', 0, null);
      } catch (error) {
        child.stderr.end(String(error.stack || error));
        child.emit('exit', 3, null);
      }
    });
    return child;
  };
}

async function writeArtifacts(outputDir, snapshot, runId) {
  await mkdir(outputDir, { recursive: true });
  const identity = { jobId: snapshot.jobId, postId: snapshot.postId, runId, inputRevision: snapshot.inputRevision };
  const coverage = { ...snapshot.coverage, commentsAnalyzed: snapshot.comments.length, usersAnalyzed: snapshot.users.length };
  const artifactMetadata = {
    schemaVersion: 'audience-ai/1',
    promptVersion: snapshot.promptVersion,
    provider: snapshot.model.provider,
    model: snapshot.model.model,
    wireApi: snapshot.model.wireApi,
    profileMode: snapshot.scope.profileMode,
    modules: snapshot.scope.modules,
  };
  const metadata = {
    ...identity,
    ...artifactMetadata,
    status: 'complete',
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    estimatedUsage: false,
    cost: 0.01,
  };
  const evidenceId = 'comment:comment-1';
  const analysis = {
    ...identity,
    schemaVersion: 'audience-ai/1',
    promptVersion: 'audience-ai-v1',
    status: 'complete',
    summary: { conclusion: 'fixture' },
    synthesis: { conclusion: 'fixture', evidenceRefs: [evidenceId] },
    coverage,
    resultCounts: { comments: 1, threads: 1, users: 1, evidence: 1 },
  };
  const contents = new Map([
    ['analysis.json', JSON.stringify(analysis)],
    ['analysis.md', '# fixture\n'],
    ['comment-insights.jsonl', `${JSON.stringify({ commentId: 'comment-1', confidence: 0.9, evidenceRefs: [evidenceId] })}\n`],
    ['thread-insights.jsonl', `${JSON.stringify({ rootThreadId: 'comment-1', evidenceRefs: [evidenceId] })}\n`],
    ['user-insights.jsonl', `${JSON.stringify({ userId: 'user-1', evidenceRefs: [evidenceId] })}\n`],
    ['evidence.jsonl', `${JSON.stringify({ evidenceId, entityType: 'comment', entityId: 'comment-1' })}\n`],
    ['coverage.json', JSON.stringify(coverage)],
    ['run-metadata.json', JSON.stringify(metadata)],
  ]);
  await Promise.all([...contents].map(([name, value]) => writeFile(path.join(outputDir, name), value, 'utf8')));
  const files = [...contents].map(([name, value]) => ({
    path: name,
    size: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex'),
  }));
  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
    ...identity,
    ...artifactMetadata,
    status: 'complete',
    completionStatus: 'complete',
    coverage,
    files,
  }), 'utf8');
}

async function waitForRun(service, runId, expectedStatus) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await service.getRun(JOB_ID, POST_ID, runId);
    if (run.status === expectedStatus) return run;
    if (['failed', 'cancelled'].includes(run.status) && run.status !== expectedStatus) {
      assert.fail(`run reached ${run.status}: ${run.errorCode || ''} ${run.errorMessage || ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`run did not reach ${expectedStatus}`);
}

function storeRun({ runId, postId, idempotencyKey, semanticKey, createdAt }) {
  return {
    runId, jobId: JOB_ID, postId, profileMode: 'none', modules: ['comment_insights'], outputLanguage: 'zh-CN',
    model: {}, promptVersion: 'audience-ai-v1', schemaVersion: 1, inputRevision: `revision-${runId}`,
    idempotencyKey, semanticKey, configHash: `config-${runId}`, config: {},
    snapshotPath: path.join(os.tmpdir(), `${runId}.json`), outputDir: path.join(os.tmpdir(), runId), coverage: {}, createdAt,
  };
}

function storeSnapshot({ runId, postId, revision, semanticKey, createdAt }) {
  return {
    snapshotId: `snapshot-${runId}`, runId, jobId: JOB_ID, postId, inputRevision: revision,
    source: {}, coverage: {}, hashManifest: {}, snapshotPath: path.join(os.tmpdir(), `${runId}.json`), createdAt,
    ...(semanticKey ? { semanticKey } : {}),
  };
}
