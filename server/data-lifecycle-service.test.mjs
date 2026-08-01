import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DataLifecycleService, ownershipModel } from './data-lifecycle-service.mjs';
import { artifactId } from './lib/artifacts.mjs';
import { ProfileStore } from './profile-store.mjs';

const JOB_A = '20260101000000-aabbccdd';
const JOB_B = '20260102000000-bbccddee';
const PROFILE_A = 'aabbccddeeff0011';
const PROFILE_B = '1122334455667788';
const DRAFT_A = `draft_${'a'.repeat(64)}`;

async function fixture(t, { jobs = [], now, audienceAi } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'jobs');
  const profileRoot = path.join(root, 'profiles');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(profileRoot, { recursive: true })]);
  const profileStore = new ProfileStore({ root: profileRoot, pythonBin: 'python', scriptPath: 'unused.py' });
  await profileStore.initialize();
  const manager = fakeManager(dataDir, jobs);
  await manager.persist();
  const service = new DataLifecycleService({
    manager,
    profileStore,
    audienceAi,
    retentionPath: path.join(root, 'data-retention.json'),
    auditPath: path.join(root, 'deletion-audit.jsonl'),
    ...(now ? { now } : {}),
  });
  await service.initialize();
  return { root, dataDir, profileRoot, profileStore, manager, service };
}

function fakeManager(dataDir, jobs) {
  return {
    dataDir,
    jobs,
    quiesced: [],
    refreshed: [],
    getInternal(id) { return this.jobs.find((job) => job.id === id) || null; },
    async persist() { await writeFile(path.join(dataDir, 'jobs.json'), `${JSON.stringify(this.jobs, null, 2)}\n`); },
    async quiesceForDeletion(id) { this.quiesced.push(id); },
    releaseDeletionIntent() {},
    async removeJobRecord(id) { this.jobs = this.jobs.filter((job) => job.id !== id); await this.persist(); },
    async removeJobRecords(ids) { const selected = new Set(ids); this.jobs = this.jobs.filter((job) => !selected.has(job.id)); await this.persist(); },
    async detachProfile(id) {
      for (const job of this.jobs) if (job.params?.profileId === id) job.params.profileId = null;
      await this.persist();
    },
    async detachJobReferences(id) {
      for (const job of this.jobs) {
        if (job.params?.resumeFromJobId === id) delete job.params.resumeFromJobId;
        if (job.sourceJobId === id) job.sourceJobId = null;
      }
      await this.persist();
    },
    async refreshArtifactCount(id) { this.refreshed.push(id); },
  };
}

function job(id, status = 'succeeded', extra = {}) {
  const outputDir = path.join(extra.dataDir || '', id, 'artifacts');
  return {
    id,
    status,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2025-01-02T00:00:00.000Z',
    params: {},
    outputDir,
    ...extra,
  };
}

async function materializeJob(dataDir, target, { draft = false } = {}) {
  target.outputDir = path.join(dataDir, target.id, 'artifacts');
  await Promise.all([
    mkdir(target.outputDir, { recursive: true }),
    mkdir(path.join(dataDir, target.id, 'attempts'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(dataDir, target.id, 'task.log'), 'log'),
    writeFile(path.join(dataDir, target.id, 'workflow-state.json'), '{}'),
    writeFile(path.join(dataDir, target.id, 'attempts', '1.log'), 'attempt'),
    writeFile(path.join(target.outputDir, 'result.csv'), 'a,b\n1,2\n'),
    writeFile(path.join(target.outputDir, 'artifact-manifest.json'), '{"files":[]}'),
  ]);
  if (draft) {
    const state = {
      note_a: { draftStore: { draftId: DRAFT_A }, draft: { email_body: 'sensitive draft text' } },
    };
    await writeFile(path.join(target.outputDir, 'delivery-state.json'), JSON.stringify(state));
    await writeFile(path.join(target.outputDir, 'delivery-state.v1.backup.json'), JSON.stringify(state));
    await writeFile(path.join(target.outputDir, 'delivery-send-audit.jsonl'), `${JSON.stringify({ draftId: DRAFT_A, to: 'private@example.com' })}\n${JSON.stringify({ draftId: `draft_${'b'.repeat(64)}` })}\n`);
  }
}

async function materializeProfile(root, id, name = 'Candidate') {
  await mkdir(path.join(root, id, 'sources'), { recursive: true });
  await writeFile(path.join(root, id, 'profile_memory.json'), JSON.stringify({ name, updatedAt: '2025-01-01T00:00:00.000Z' }));
  await writeFile(path.join(root, id, 'sources', 'resume.txt'), 'private profile');
}

async function execute(service, spec, extra = {}) {
  const preview = await service.preview(spec);
  return service.execute({ ...spec, confirmationToken: preview.confirmationToken, ...extra });
}

test('ownership model declares every lifecycle edge', () => {
  const relations = ownershipModel().relations;
  assert.deepEqual(new Set(relations.map((item) => item.dependent)), new Set(['job', 'draft', 'artifact', 'checkpoint', 'log']));
});

test('default retention is disabled and does not remove old jobs', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  assert.equal(ctx.service.getRetention().enabled, false);
  const result = await ctx.service.cleanupExpired({ dryRun: false });
  assert.equal(result.enabled, false);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), true);
});

test('dry-run reports entities, files, bytes and does not delete', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  const preview = await ctx.service.preview({ entityType: 'job', jobId: JOB_A });
  assert.equal(preview.status, 'ready');
  assert.ok(preview.fileCount >= 5);
  assert.ok(preview.totalBytes > 0);
  assert.equal(preview.entities[0].id, JOB_A);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), true);
});

test('deletion requires a fresh one-time dry-run token', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await assert.rejects(ctx.service.execute({ entityType: 'job', jobId: JOB_A }), { code: 'DELETION_CONFIRMATION_REQUIRED' });
  const preview = await ctx.service.preview({ entityType: 'job', jobId: JOB_A });
  await ctx.service.execute({ entityType: 'job', jobId: JOB_A, confirmationToken: preview.confirmationToken });
  await assert.rejects(ctx.service.execute({ entityType: 'job', jobId: JOB_A, confirmationToken: preview.confirmationToken }), { code: 'DELETION_CONFIRMATION_INVALID' });
});

test('changed data invalidates a preview token', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  const preview = await ctx.service.preview({ entityType: 'job', jobId: JOB_A });
  await writeFile(path.join(target.outputDir, 'new.json'), '{}');
  await assert.rejects(ctx.service.execute({ entityType: 'job', jobId: JOB_A, confirmationToken: preview.confirmationToken }), { code: 'DELETION_PLAN_CHANGED' });
});

test('unreferenced Profile is physically deleted', async (t) => {
  const ctx = await fixture(t);
  await materializeProfile(ctx.profileRoot, PROFILE_A);
  await execute(ctx.service, { entityType: 'profile', profileId: PROFILE_A });
  assert.equal(existsSync(path.join(ctx.profileRoot, PROFILE_A)), false);
  await assert.rejects(ctx.profileStore.get(PROFILE_A), { code: 'PROFILE_NOT_FOUND' });
});

test('referenced Profile is blocked with impact details', async (t) => {
  const target = job(JOB_A, 'succeeded', { params: { profileId: PROFILE_A } });
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await materializeProfile(ctx.profileRoot, PROFILE_A);
  const preview = await ctx.service.preview({ entityType: 'profile', profileId: PROFILE_A });
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.references[0].id, JOB_A);
  assert.equal(preview.blockedReasons[0].code, 'PROFILE_REFERENCED');
  await assert.rejects(ctx.service.execute({ entityType: 'profile', profileId: PROFILE_A, confirmationToken: preview.confirmationToken }), { code: 'DELETION_BLOCKED' });
});

test('force Profile deletion detaches references after impact review', async (t) => {
  const target = job(JOB_A, 'succeeded', { params: { profileId: PROFILE_A } });
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await materializeProfile(ctx.profileRoot, PROFILE_A);
  const preview = await ctx.service.preview({ entityType: 'profile', profileId: PROFILE_A, force: true });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.references.length, 1);
  await ctx.service.execute({ entityType: 'profile', profileId: PROFILE_A, force: true, confirmationToken: preview.confirmationToken });
  assert.equal(target.params.profileId, null);
});

for (const status of ['succeeded', 'failed']) {
  test(`a ${status} Job cascades checkpoints, logs, exports and manifest`, async (t) => {
    const target = job(JOB_A, status);
    const ctx = await fixture(t, { jobs: [target] });
    await materializeJob(ctx.dataDir, target);
    await execute(ctx.service, { entityType: 'job', jobId: JOB_A });
    assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), false);
    assert.equal(ctx.manager.jobs.length, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(ctx.dataDir, 'jobs.json'), 'utf8')), []);
  });
}

test('running Job deletion quiesces resources before physical removal', async (t) => {
  const target = job(JOB_A, 'running');
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await execute(ctx.service, { entityType: 'job', jobId: JOB_A });
  assert.deepEqual(ctx.manager.quiesced, [JOB_A]);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), false);
});

test('Job deletion quiesces audience AI before removing its ownership tree and releases the guard', async (t) => {
  const target = job(JOB_A, 'running');
  const calls = [];
  let dataDir;
  const audienceAi = {
    async quiesceJob(id, options) {
      calls.push(['quiesce', id, options]);
      assert.equal(existsSync(path.join(dataDir, id)), true);
    },
    releaseJobQuiesce(id) {
      calls.push(['release', id]);
      assert.equal(existsSync(path.join(dataDir, id)), false);
    },
  };
  const ctx = await fixture(t, { jobs: [target], audienceAi });
  dataDir = ctx.dataDir;
  await materializeJob(ctx.dataDir, target);

  await execute(ctx.service, { entityType: 'job', jobId: JOB_A });

  assert.deepEqual(calls, [
    ['quiesce', JOB_A, { rejectActive: false }],
    ['release', JOB_A],
  ]);
});

test('deleting a source Job detaches historical lineage references', async (t) => {
  const source = job(JOB_A);
  const dependent = job(JOB_B, 'succeeded', { params: { resumeFromJobId: JOB_A }, sourceJobId: JOB_A });
  const ctx = await fixture(t, { jobs: [source, dependent] });
  await Promise.all([materializeJob(ctx.dataDir, source), materializeJob(ctx.dataDir, dependent)]);
  const preview = await ctx.service.preview({ entityType: 'job', jobId: JOB_A });
  assert.equal(preview.references[0].id, JOB_B);
  await ctx.service.execute({ entityType: 'job', jobId: JOB_A, confirmationToken: preview.confirmationToken });
  assert.equal(dependent.params.resumeFromJobId, undefined);
  assert.equal(dependent.sourceJobId, null);
});

test('single Draft deletion updates state, backup and send audit', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target, { draft: true });
  await execute(ctx.service, { entityType: 'draft', jobId: JOB_A, draftId: DRAFT_A });
  assert.deepEqual(JSON.parse(await readFile(path.join(target.outputDir, 'delivery-state.json'), 'utf8')), {});
  assert.doesNotMatch(await readFile(path.join(target.outputDir, 'delivery-send-audit.jsonl'), 'utf8'), new RegExp(DRAFT_A));
  await assert.rejects(ctx.service.preview({ entityType: 'draft', jobId: JOB_A, draftId: DRAFT_A }), { code: 'DRAFT_NOT_FOUND' });
});

test('legacy Draft remains deletable through its deterministic compatibility ID', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await writeFile(path.join(target.outputDir, 'delivery-state.json'), JSON.stringify({
    note_legacy: { draft: { email_body: 'legacy draft' }, action: 'ready_to_apply' },
  }));
  await execute(ctx.service, { entityType: 'draft', jobId: JOB_A, draftId: 'legacy_note_legacy' });
  assert.deepEqual(JSON.parse(await readFile(path.join(target.outputDir, 'delivery-state.json'), 'utf8')), {});
});

test('single Artifact deletion removes the file and invalidates manifest', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  const id = artifactId('result.csv');
  await execute(ctx.service, { entityType: 'artifact', jobId: JOB_A, artifactId: id });
  assert.equal(existsSync(path.join(target.outputDir, 'result.csv')), false);
  assert.equal(existsSync(path.join(target.outputDir, 'artifact-manifest.json')), false);
  assert.deepEqual(ctx.manager.refreshed, [JOB_A]);
  await assert.rejects(ctx.service.preview({ entityType: 'artifact', jobId: JOB_A, artifactId: id }), { code: 'ARTIFACT_NOT_FOUND' });
});

test('cross-Job Artifact deletion is rejected', async (t) => {
  const first = job(JOB_A);
  const second = job(JOB_B);
  const ctx = await fixture(t, { jobs: [first, second] });
  await Promise.all([materializeJob(ctx.dataDir, first), materializeJob(ctx.dataDir, second)]);
  const attack = Buffer.from(`../../${JOB_B}/artifacts/result.csv`, 'utf8').toString('base64url');
  await assert.rejects(ctx.service.preview({ entityType: 'artifact', jobId: JOB_A, artifactId: attack }), { code: 'ARTIFACT_NOT_FOUND' });
  assert.equal(existsSync(path.join(second.outputDir, 'result.csv')), true);
});

test('path traversal identifiers are rejected before filesystem access', async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(ctx.service.preview({ entityType: 'job', jobId: '../outside' }), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(ctx.service.preview({ entityType: 'profile', profileId: '..\\outside' }), { code: 'PROFILE_NOT_FOUND' });
});

test('symbolic-link escape blocks deletion and preserves the external target', async (t) => {
  const ctx = await fixture(t);
  const external = path.join(ctx.root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'keep.txt'), 'keep');
  await symlink(external, path.join(ctx.profileRoot, PROFILE_A), 'junction');
  ctx.profileStore.get = async () => ({ id: PROFILE_A, name: 'linked' });
  const preview = await ctx.service.preview({ entityType: 'profile', profileId: PROFILE_A });
  assert.equal(preview.blockedReasons[0].code, 'UNSAFE_SYMLINK');
  await assert.rejects(ctx.service.execute({ entityType: 'profile', profileId: PROFILE_A, confirmationToken: preview.confirmationToken }), { code: 'DELETION_BLOCKED' });
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});

test('enabled retention deletes expired jobs but skips running and pinned jobs', async (t) => {
  const old = job(JOB_A);
  const running = job(JOB_B, 'running');
  const pinnedId = '20260103000000-ccddeeaa';
  const pinned = job(pinnedId);
  const ctx = await fixture(t, { jobs: [old, running, pinned], now: () => new Date('2026-08-01T00:00:00.000Z') });
  await Promise.all([materializeJob(ctx.dataDir, old), materializeJob(ctx.dataDir, running), materializeJob(ctx.dataDir, pinned)]);
  await ctx.service.updateRetention({ enabled: true, days: 30, pinnedJobIds: [pinnedId] });
  const dryRun = await ctx.service.cleanupExpired({ dryRun: true });
  assert.deepEqual(dryRun.eligible.map((plan) => plan.entities[0].id), [JOB_A]);
  assert.deepEqual(new Set(dryRun.skipped.map((item) => item.reason)), new Set(['active', 'pinned']));
  await ctx.service.cleanupExpired({ dryRun: false });
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), false);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_B)), true);
  assert.equal(existsSync(path.join(ctx.dataDir, pinnedId)), true);
});

test('retention rechecks eligibility under the deletion lock and skips a task that starts resuming', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target], now: () => new Date('2026-08-01T00:00:00.000Z') });
  await materializeJob(ctx.dataDir, target);
  await ctx.service.updateRetention({ enabled: true, days: 30, pinnedJobIds: [] });
  ctx.manager.quiesceForDeletion = async (_id, options) => {
    assert.equal(options.rejectActive, true);
    target.status = 'resuming';
    throw Object.assign(new Error('became active'), { code: 'JOB_ACTIVE_RETENTION' });
  };

  const result = await ctx.service.cleanupExpired({ dryRun: false });

  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, [{ type: 'job', id: JOB_A, reason: 'became_active' }]);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), true);
  assert.ok(ctx.manager.getInternal(JOB_A));
});

test('retention skips a task when its audience AI run becomes active under the deletion lock', async (t) => {
  const target = job(JOB_A);
  const calls = [];
  const audienceAi = {
    async quiesceJob(id, options) {
      calls.push(['quiesce', id, options]);
      throw Object.assign(new Error('audience AI became active'), { code: 'JOB_ACTIVE_RETENTION' });
    },
    releaseJobQuiesce(id) { calls.push(['release', id]); },
  };
  const ctx = await fixture(t, {
    jobs: [target],
    audienceAi,
    now: () => new Date('2026-08-01T00:00:00.000Z'),
  });
  await materializeJob(ctx.dataDir, target);
  await ctx.service.updateRetention({ enabled: true, days: 30, pinnedJobIds: [] });

  const result = await ctx.service.cleanupExpired({ dryRun: false });

  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, [{ type: 'job', id: JOB_A, reason: 'became_active' }]);
  assert.deepEqual(calls, [
    ['quiesce', JOB_A, { rejectActive: true }],
    ['release', JOB_A],
  ]);
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), true);
  assert.ok(ctx.manager.getInternal(JOB_A));
});

test('clear-all requires the strong confirmation phrase', async (t) => {
  const ctx = await fixture(t);
  const preview = await ctx.service.preview({ entityType: 'all' });
  await assert.rejects(ctx.service.execute({ entityType: 'all', confirmationToken: preview.confirmationToken }), { code: 'CLEAR_ALL_CONFIRMATION_REQUIRED' });
  assert.equal(preview.confirmationPhrase, 'DELETE ALL LOCAL DATA');
});

test('clear-all physically removes every Profile and Job ownership tree', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target, { draft: true });
  await Promise.all([materializeProfile(ctx.profileRoot, PROFILE_A), materializeProfile(ctx.profileRoot, PROFILE_B)]);
  const preview = await ctx.service.preview({ entityType: 'all' });
  await ctx.service.execute({ entityType: 'all', confirmationToken: preview.confirmationToken, confirmationPhrase: preview.confirmationPhrase });
  assert.deepEqual(await ctx.profileStore.list(), []);
  assert.equal(ctx.manager.jobs.length, 0);
  assert.deepEqual((await readdir(ctx.dataDir)).sort(), ['jobs.json']);
});

test('clear-all quiesces every audience AI job before removing any ownership tree', async (t) => {
  const first = job(JOB_A);
  const second = job(JOB_B);
  const quiesced = [];
  const released = [];
  let dataDir;
  const audienceAi = {
    async quiesceJob(id) {
      quiesced.push(id);
      assert.equal(existsSync(path.join(dataDir, JOB_A)), true);
      assert.equal(existsSync(path.join(dataDir, JOB_B)), true);
    },
    releaseJobQuiesce(id) { released.push(id); },
  };
  const ctx = await fixture(t, { jobs: [first, second], audienceAi });
  dataDir = ctx.dataDir;
  await Promise.all([materializeJob(ctx.dataDir, first), materializeJob(ctx.dataDir, second)]);
  const preview = await ctx.service.preview({ entityType: 'all' });

  await ctx.service.execute({
    entityType: 'all',
    confirmationToken: preview.confirmationToken,
    confirmationPhrase: preview.confirmationPhrase,
  });

  assert.deepEqual(quiesced, [JOB_A, JOB_B]);
  assert.deepEqual(released, [JOB_A, JOB_B]);
  assert.deepEqual(ctx.manager.jobs, []);
});

test('audit records are redacted and never contain entity ids or content', async (t) => {
  const ctx = await fixture(t);
  await materializeProfile(ctx.profileRoot, PROFILE_A, 'Sensitive Name');
  await execute(ctx.service, { entityType: 'profile', profileId: PROFILE_A });
  const audit = await readFile(path.join(ctx.root, 'deletion-audit.jsonl'), 'utf8');
  assert.doesNotMatch(audit, new RegExp(PROFILE_A));
  assert.doesNotMatch(audit, /Sensitive Name|private profile/);
  assert.match(audit, /entityIdHash/);
});

test('existing legacy-shaped Profile and Job remain readable without migration', async (t) => {
  const target = job(JOB_A);
  const ctx = await fixture(t, { jobs: [target] });
  await materializeJob(ctx.dataDir, target);
  await materializeProfile(ctx.profileRoot, PROFILE_A, 'Legacy');
  assert.equal((await ctx.profileStore.get(PROFILE_A)).name, 'Legacy');
  assert.equal(ctx.manager.getInternal(JOB_A).id, JOB_A);
  await ctx.service.preview({ entityType: 'job', jobId: JOB_A });
  assert.equal(existsSync(path.join(ctx.dataDir, JOB_A)), true);
});
