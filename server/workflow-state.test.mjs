import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  emptyWorkflowStages,
  initializeWorkflowState,
  readWorkflowState,
  updateWorkflowState,
} from './lib/workflow-state.mjs';

test('workflow state commits atomically and rejects stale revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-workflow-state-'));
  const statePath = path.join(directory, 'workflow-state.json');

  try {
    const initial = await initializeWorkflowState(statePath, {
      jobId: 'stable-job-id',
      status: 'incomplete',
      activeAttemptId: null,
      resumeCount: 0,
      stages: emptyWorkflowStages(),
      attempts: [],
    });
    assert.equal(initial.revision, 1);
    assert.deepEqual(initial.stages.discovery.discoveredIds, []);
    assert.equal(initial.stages.discovery.scrollCount, 0);
    assert.deepEqual(initial.stages.bodyCompletion.records, {});
    assert.equal(initial.stages.analysis.remainingCount, 0);
    assert.deepEqual(initial.stages.audience.posts, {});
    assert.deepEqual(initial.stages.artifacts.generatedFiles, []);

    const results = await Promise.allSettled([
      updateWorkflowState(statePath, (draft) => {
        draft.status = 'resuming';
        draft.resumeCount = 1;
      }, { expectedRevision: 1 }),
      updateWorkflowState(statePath, (draft) => {
        draft.status = 'running';
        draft.resumeCount = 2;
      }, { expectedRevision: 1 }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const conflict = results.find((result) => result.status === 'rejected')?.reason;
    assert.equal(conflict?.code, 'WORKFLOW_REVISION_CONFLICT');
    assert.equal(conflict?.expectedRevision, 1);
    assert.equal(conflict?.actualRevision, 2);

    const persisted = await readWorkflowState(statePath);
    assert.equal(persisted.jobId, 'stable-job-id');
    assert.equal(persisted.revision, 2);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).revision, 2);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow state CAS holds across competing Node processes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-workflow-state-process-'));
  const statePath = path.join(directory, 'workflow-state.json');
  const lockPath = `${statePath}.lock`;

  try {
    await initializeWorkflowState(statePath, {
      jobId: 'cross-process-job',
      status: 'incomplete',
      activeAttemptId: null,
      resumeCount: 0,
      stages: emptyWorkflowStages(),
      attempts: [],
    });
    await writeFile(lockPath, `${JSON.stringify({
      pid: process.pid,
      token: 'stale-owner',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })}\n`, 'utf8');

    const results = await Promise.all([
      runCompetingWriter(statePath, 'writer-a'),
      runCompetingWriter(statePath, 'writer-b'),
    ]);
    const successes = results.filter((result) => result.code === 0);
    const conflicts = results.filter((result) => result.code === 2);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(conflicts.length, 1, JSON.stringify(results));
    assert.equal(conflicts[0].payload.code, 'WORKFLOW_REVISION_CONFLICT');
    assert.equal(conflicts[0].payload.expectedRevision, 1);
    assert.equal(conflicts[0].payload.actualRevision, 2);

    const persisted = await readWorkflowState(statePath);
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.writer, successes[0].payload.writer);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.lock') || name.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow state lock records ownership and release preserves a different token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-workflow-state-token-'));
  const statePath = path.join(directory, 'workflow-state.json');
  const lockPath = `${statePath}.lock`;

  try {
    await initializeWorkflowState(statePath, {
      jobId: 'token-guard-job',
      status: 'incomplete',
      activeAttemptId: null,
      resumeCount: 0,
      stages: emptyWorkflowStages(),
      attempts: [],
    });
    await updateWorkflowState(statePath, async (draft) => {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.match(owner.token, /^[a-f0-9]{32}$/);
      assert.ok(Number.isFinite(Date.parse(owner.createdAt)));
      await writeFile(lockPath, `${JSON.stringify({
        ...owner,
        token: 'replacement-owner-token',
      })}\n`, 'utf8');
      draft.status = 'running';
    }, { expectedRevision: 1 });

    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'replacement-owner-token');
    assert.equal((await readWorkflowState(statePath)).revision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy schema 2 stage fields are normalized before validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-workflow-state-legacy-'));
  const statePath = path.join(directory, 'workflow-state.json');

  try {
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 2,
      jobId: 'legacy-job',
      revision: 7,
      attempts: [],
      stages: {
        discovery: { status: 'completed', discoveredIds: ['note-1'] },
        bodyCompletion: {
          status: 'completed',
          records: { 'note-1': { status: 'succeeded' } },
        },
        analysis: {
          status: 'partial',
          records: { 'note-1': { analysisStatus: 'completed' }, 'note-2': { analysisStatus: 'partial' } },
        },
        audience: {
          status: 'completed',
          posts: { 'note-1': { commentStatus: 'complete' } },
          users: { 'user-1': { profileStatus: 'complete' } },
          postsComplete: 1,
          profilesComplete: 1,
        },
        artifacts: { status: 'not_started', generatedFiles: [] },
      },
    }, null, 2)}\n`, 'utf8');

    const normalized = await readWorkflowState(statePath);
    assert.equal(normalized.stages.discovery.discoveredCount, 1);
    assert.deepEqual(
      [
        normalized.stages.bodyCompletion.totalCount,
        normalized.stages.bodyCompletion.completedCount,
        normalized.stages.bodyCompletion.remainingCount,
      ],
      [1, 1, 0],
    );
    assert.deepEqual(
      [
        normalized.stages.analysis.totalCount,
        normalized.stages.analysis.completedCount,
        normalized.stages.analysis.remainingCount,
      ],
      [2, 1, 1],
    );
    assert.equal(normalized.stages.audience.postsCompleted, 1);
    assert.equal(normalized.stages.audience.usersCompleted, 1);
    assert.deepEqual(normalized.stages.artifacts.failedFiles, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow state rejects invalid stage statuses, shapes, and completed invariants', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-workflow-state-invalid-'));
  const statePath = path.join(directory, 'workflow-state.json');
  const base = {
    schemaVersion: 2,
    jobId: 'invalid-job',
    revision: 1,
    attempts: [],
    stages: emptyWorkflowStages(),
  };
  const cases = [
    ['status_invalid', (state) => { state.stages.discovery.status = 'done'; }],
    ['must_be_non_negative_integer', (state) => { state.stages.bodyCompletion.remainingCount = -1; }],
    ['must_be_object_ledger', (state) => { state.stages.audience.posts = []; }],
    ['completed_invariant_failed', (state) => {
      Object.assign(state.stages.analysis, {
        status: 'completed',
        totalCount: 2,
        completedCount: 1,
        remainingCount: 1,
      });
    }],
    ['completed_invariant_failed', (state) => {
      Object.assign(state.stages.audience, {
        status: 'completed',
        postsTotal: 1,
        postsCompleted: 0,
      });
    }],
    ['completed_invariant_failed', (state) => {
      Object.assign(state.stages.artifacts, {
        status: 'completed',
        failedFiles: ['broken.json'],
      });
    }],
    ['ledger_count_mismatch', (state) => {
      Object.assign(state.stages.discovery, { discoveredIds: [], discoveredCount: 1 });
    }],
    ['ledger_count_mismatch', (state) => {
      Object.assign(state.stages.bodyCompletion, {
        status: 'completed',
        records: { 'note-1': { status: 'failed' } },
        totalCount: 1,
        completedCount: 1,
        remainingCount: 0,
      });
    }],
    ['ledger_count_mismatch', (state) => {
      Object.assign(state.stages.analysis, {
        status: 'completed',
        records: { 'note-1': { analysisStatus: 'partial' } },
        totalCount: 1,
        completedCount: 1,
        remainingCount: 0,
      });
    }],
    ['ledger_count_mismatch', (state) => {
      Object.assign(state.stages.audience, {
        status: 'completed',
        posts: { 'note-1': { commentStatus: 'partial' } },
        postsTotal: 1,
        postsCompleted: 1,
      });
    }],
    ['record_status_invalid', (state) => {
      Object.assign(state.stages.bodyCompletion, {
        records: { 'note-1': { status: 'mystery' } },
        totalCount: 1,
        remainingCount: 1,
      });
    }],
    ['attemptCount_must_be_non_negative_integer', (state) => {
      Object.assign(state.stages.analysis, {
        records: { 'note-1': { analysisStatus: 'partial', attemptCount: -1 } },
        totalCount: 1,
        remainingCount: 1,
      });
    }],
  ];

  try {
    for (const [reason, mutate] of cases) {
      const state = structuredClone(base);
      mutate(state);
      await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');
      await assert.rejects(
        readWorkflowState(statePath),
        (error) => error?.code === 'WORKFLOW_STATE_INVALID' && error.reason.includes(reason),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runCompetingWriter(statePath, writer) {
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'workflow-state.mjs');
  const source = `
    import { updateWorkflowState } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const statePath = process.env.WORKFLOW_STATE_TEST_PATH;
    const writer = process.env.WORKFLOW_STATE_TEST_WRITER;
    try {
      const state = await updateWorkflowState(statePath, async (draft) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        draft.status = 'running';
        draft.writer = writer;
      }, { expectedRevision: 1 });
      process.stdout.write(JSON.stringify({ ok: true, writer, revision: state.revision }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        writer,
        code: error.code,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
        message: error.message,
      }));
      process.exitCode = error.code === 'WORKFLOW_REVISION_CONFLICT' ? 2 : 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: {
      ...process.env,
      WORKFLOW_STATE_TEST_PATH: statePath,
      WORKFLOW_STATE_TEST_WRITER: writer,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    stderr,
    payload: stdout ? JSON.parse(stdout) : { stderr },
  };
}
