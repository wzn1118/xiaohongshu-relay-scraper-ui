import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  USER_PROBLEM_TITLES,
  WORKFLOW_EVENT_LINE_PREFIX,
  adaptLegacyJobSnapshot,
  createWorkflowEvent,
  mapUserProblem,
  parseWorkflowEventLine,
  reduceWorkflowSnapshot,
} from './lib/job-experience.mjs';

const EXPECTED_TITLES = {
  RATE_LIMITED: '平台暂时限制访问',
  SECURITY_VERIFICATION: '需要完成页面验证',
  LOGIN_REQUIRED: '登录状态已失效',
  NETWORK_TIMEOUT: '页面响应较慢',
  RELAY_DISCONNECTED: '采集浏览器连接中断',
  NOTE_UNAVAILABLE: '这条内容当前不可查看',
  BODY_EMPTY: '正文暂时没有加载出来',
  NOTE_ID_MISMATCH: '打开的内容与目标不一致',
  RUNNER_FAILED: '采集任务意外停止',
  PROCESS_INTERRUPTED: '任务运行被中断',
  WORKFLOW_REVISION_CONFLICT: '保存进度时发生冲突',
  WORKFLOW_STATE_INVALID: '进度文件需要修复',
  DISK_WRITE_FAILED: '无法保存新的进度',
  AI_PROVIDER_BUSY: '智能整理暂时繁忙',
  ANALYSIS_FAILED: '部分岗位尚未整理完成',
  QUALITY_GATE_FAILED: '这份材料还不能标记为可投递',
  EXPORT_FAILED: '下载文件生成失败',
  SMTP_NOT_VERIFIED: '发件邮箱尚未验证',
  SMTP_RECIPIENT_REJECTED: '收件地址未被接受',
  EMAIL_SEND_STATUS_UNKNOWN: '发送结果暂时无法确认',
  UNKNOWN_ERROR: '当前步骤需要重新检查',
};

const SNAPSHOT_KEYS = [
  'schemaVersion', 'revision', 'throughSequence', 'jobId', 'activeAttemptId', 'journey',
  'state', 'activeStage', 'headline', 'detail', 'stages', 'counts', 'speed', 'issues',
  'connection', 'checkpoint',
].sort();

function legacyResumeSnapshot() {
  return legacyResumeSnapshotAtScale(20, 8, 0);
}

function legacyResumeSnapshotAtScale(discovered, coverageCountAtStart, attemptDone, throughSequence = 5) {
  const attemptTotal = discovered - coverageCountAtStart;
  const fullText = coverageCountAtStart + attemptDone;
  return adaptLegacyJobSnapshot({
    id: 'job-fixture',
    status: 'running',
    activeAttemptId: 'attempt-2',
    currentAttemptId: 'attempt-2',
    revision: 7,
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:00:06.000Z',
    progressPhase: 'scraping',
    progressLabel: '正在补全剩余正文',
    params: { keyword: 'ai产品经理', analysisMode: 'job' },
    bodyMetrics: {
      discovered,
      attempted: fullText,
      succeeded: fullText,
      failed: 0,
      notAttempted: discovered - fullText,
      blocked: 0,
      cancelled: 0,
      pending: 0,
    },
    attempts: [{
      attemptId: 'attempt-2', kind: 'resume', resumeScope: 'body_completion',
      coverageCountAtStart, targetCount: attemptTotal, progressUnit: 'body',
      startedAt: '2026-08-03T08:00:00.000Z',
    }],
    attemptProgress: {
      attemptId: 'attempt-2',
      unit: 'body',
      done: attemptDone,
      total: attemptTotal,
      coverageCountAtStart,
    },
  }, { throughSequence });
}

test('user-facing problem codes have stable Chinese titles and complete actions', () => {
  assert.deepEqual(USER_PROBLEM_TITLES, EXPECTED_TITLES);
  for (const [code, title] of Object.entries(EXPECTED_TITLES)) {
    const problem = mapUserProblem(code, {
      saved: 9,
      total: 20,
      retryAt: '2026-08-03T08:10:00.000Z',
      technicalRef: `fixture:${code}`,
    });
    assert.equal(problem.code, code);
    assert.equal(problem.userTitle, title);
    assert.equal(problem.preservedResultCount, 9);
    assert.equal(problem.technicalRef, `fixture:${code}`);
    assert.deepEqual(
      Object.keys(problem).sort(),
      ['code', 'category', 'severity', 'userTitle', 'userMessage', 'preservedResultCount', 'automaticAction', 'retryable', 'retryAt', 'requiresUserAction', 'action', 'affectedStage', 'technicalRef'].sort(),
    );
  }
  assert.equal(mapUserProblem('RATE_LIMITED').action.id, 'check_recovery');
  assert.equal(mapUserProblem('SECURITY_VERIFICATION').action.id, 'open_verification');
  assert.equal(mapUserProblem('LOGIN_REQUIRED').action.id, 'open_login');
  assert.equal(mapUserProblem('PROCESS_INTERRUPTED').action.id, 'resume');
});

test('a runner that exits before collecting content shows a concrete restart message', () => {
  const snapshot = adaptLegacyJobSnapshot({
    id: 'startup-failure-fixture',
    status: 'failed',
    revision: 2,
    progressPhase: 'starting',
    progressLabel: '正在启动采集器并连接 Relay',
    bodyMetrics: {
      discovered: 0, attempted: 0, succeeded: 0, failed: 0,
      notAttempted: 0, blocked: 0, cancelled: 0, pending: 0,
    },
    attempts: [{
      attemptId: 'attempt-1',
      status: 'failed',
      errorCode: 'RUNNER_FAILED',
      errorMessage: 'Runner exited with code 1.',
    }],
    currentAttemptId: 'attempt-1',
  });

  assert.equal(snapshot.headline, '采集任务意外停止');
  assert.equal(snapshot.issues.length, 1);
  assert.equal(snapshot.issues[0].code, 'RUNNER_FAILED');
  assert.equal(snapshot.issues[0].severity, 'warning');
  assert.equal(snapshot.issues[0].userMessage, '本次尚未采集到内容，可重新启动；若再次停止，请先刷新浏览器连接');
  assert.deepEqual(snapshot.issues[0].action, { id: 'resume', label: '重新启动采集' });
  assert.doesNotMatch(snapshot.headline, /未识别|未知/);
});

test('legacy jobs adapt to schema V3 with separate attempt and lifetime coverage progress', () => {
  const snapshot = legacyResumeSnapshot();

  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.throughSequence, 5);
  assert.equal(snapshot.counts.fullText, 8);
  assert.equal(snapshot.counts.discovered, 20);
  const body = snapshot.stages.find((stage) => stage.stage === 'body');
  assert.ok(body);
  assert.equal(body.progress.done, 0);
  assert.equal(body.progress.total, 12);
  assert.equal(body.progress.coverageDone, 8);
  assert.equal(body.progress.coverageTotal, 20);
  for (const stage of snapshot.stages) {
    assert.equal(typeof stage.stage, 'string');
    assert.equal(typeof stage.state, 'string');
    assert.ok(Object.hasOwn(stage.progress, 'done'));
    assert.ok(Object.hasOwn(stage.progress, 'total'));
  }
});

test('adapted snapshot validates against the shared workflow-snapshot-v3 JSON Schema', () => {
  const schemaDir = fileURLToPath(new URL('../schemas/', import.meta.url));
  const validator = String.raw`
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

schema_dir = Path(sys.argv[1])
problem = json.loads((schema_dir / 'user-problem-v1.schema.json').read_text(encoding='utf-8'))
snapshot_schema = json.loads((schema_dir / 'workflow-snapshot-v3.schema.json').read_text(encoding='utf-8'))
registry = Registry().with_resource(problem['$id'], Resource.from_contents(problem))
Draft202012Validator(snapshot_schema, registry=registry).validate(json.load(sys.stdin))
`;
  const validation = spawnSync(process.env.PYTHON_BIN || 'python', ['-c', validator, schemaDir], {
    input: JSON.stringify(legacyResumeSnapshot()),
    encoding: 'utf8',
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
});

test('fixed 20/50/320 acceptance samples keep attempt progress separate from lifetime coverage', () => {
  const samples = [
    { discovered: 20, baseline: 8, attemptDone: 3 },
    { discovered: 50, baseline: 20, attemptDone: 7 },
    { discovered: 320, baseline: 251, attemptDone: 12 },
  ];

  for (const sample of samples) {
    const snapshot = legacyResumeSnapshotAtScale(sample.discovered, sample.baseline, sample.attemptDone);
    const body = snapshot.stages.find((stage) => stage.stage === 'body');
    assert.equal(snapshot.counts.discovered, sample.discovered);
    assert.equal(snapshot.counts.fullText, sample.baseline + sample.attemptDone);
    assert.equal(body.progress.done, sample.attemptDone);
    assert.equal(body.progress.total, sample.discovered - sample.baseline);
    assert.equal(body.progress.coverageDone, sample.baseline + sample.attemptDone);
    assert.equal(body.progress.coverageTotal, sample.discovered);
  }
});

test('Node consumes the shared Python WORKFLOW_EVENT line fixture without losing contract fields', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/workflow/body-events.json', import.meta.url), 'utf8'));
  for (const source of fixture.events) {
    assert.deepEqual(
      parseWorkflowEventLine(`${WORKFLOW_EVENT_LINE_PREFIX}${JSON.stringify(source)}`),
      source,
    );
  }
  assert.equal(parseWorkflowEventLine('ordinary log line'), null);
  assert.equal(parseWorkflowEventLine(`${WORKFLOW_EVENT_LINE_PREFIX}{broken`), null);

  const source = fixture.events.at(-1);
  const event = createWorkflowEvent({
    id: 'job-server',
    status: 'running',
    activeAttemptId: 'attempt-server',
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:00:08.000Z',
    bodyMetrics: { discovered: 20, attempted: 2, succeeded: 9, failed: 0, notAttempted: 11, blocked: 1, cancelled: 0, pending: 0 },
  }, {
    type: 'workflow',
    sequence: 11,
    eventId: 'job-server:11',
    jobId: 'job-server',
    attemptId: 'attempt-server',
    occurredAt: '2026-08-03T08:00:09.000Z',
    supplied: source,
  });

  assert.equal(event.sequence, 11);
  assert.equal(event.eventId, 'job-server:11');
  assert.equal(event.jobId, 'job-server');
  assert.equal(event.attemptId, 'attempt-server');
  assert.equal(event.type, source.type);
  assert.equal(event.stage, source.stage);
  assert.deepEqual(event.progress, source.progress);
  assert.deepEqual(event.problem, source.problem);
  assert.deepEqual(
    Object.keys(event.progress).sort(),
    ['unit', 'done', 'total', 'succeeded', 'reused', 'retryable', 'failed', 'blocked'].sort(),
  );
});

test('shared Python event fixture reduces to its expected authoritative snapshot', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/workflow/body-events.json', import.meta.url), 'utf8'));
  let snapshot = legacyResumeSnapshotAtScale(20, 8, 0, 0);

  for (const event of fixture.events) snapshot = reduceWorkflowSnapshot(snapshot, event);

  const body = snapshot.stages.find((stage) => stage.stage === 'body');
  assert.equal(snapshot.throughSequence, fixture.expected.throughSequence);
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.activeStage, 'body');
  assert.equal(body.progress.done, fixture.expected.attemptDone);
  assert.equal(body.progress.total, fixture.expected.attemptTotal);
  assert.equal(body.progress.coverageDone, fixture.expected.coverageDone);
  assert.equal(body.progress.coverageTotal, fixture.expected.coverageTotal);
  assert.equal(snapshot.counts.fullText, fixture.expected.coverageDone);
  assert.equal(snapshot.counts.discovered, fixture.expected.coverageTotal);
  assert.equal(snapshot.issues[0].code, fixture.expected.issueCode);
  assert.equal(snapshot.issues[0].action.id, 'check_recovery');
  assert.equal(snapshot.speed.activePerMinute, fixture.expected.activePerMinute);
});

test('a completed body stage does not mark the whole task completed', () => {
  const initial = legacyResumeSnapshotAtScale(20, 8, 0, 0);
  const event = createWorkflowEvent({
    id: 'job-fixture', status: 'running', activeAttemptId: 'attempt-2', experienceSnapshot: initial,
  }, {
    type: 'workflow', sequence: 1, eventId: 'job-fixture:1', jobId: 'job-fixture', attemptId: 'attempt-2',
    supplied: {
      type: 'stage', stage: 'body', state: 'completed',
      progress: { unit: 'body', done: 12, total: 12, succeeded: 12, reused: 8, retryable: 0, failed: 0, blocked: 0 },
      message: { code: 'body.completed', params: { coverageDone: 20, coverageTotal: 20 } },
    },
  });

  const snapshot = reduceWorkflowSnapshot(initial, event);
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.activeStage, 'body');
  assert.equal(snapshot.stages.find((stage) => stage.stage === 'body').state, 'completed');
});

test('a terminal body failure is removed from unavailable after a later successful retry', () => {
  let snapshot = legacyResumeSnapshotAtScale(20, 8, 0, 0);
  const base = {
    schemaVersion: 1, jobId: 'job-fixture', attemptId: 'attempt-2', stage: 'body',
    occurredAt: '2026-08-03T08:00:00.000Z',
  };
  snapshot = reduceWorkflowSnapshot(snapshot, {
    ...base, eventId: 'job-fixture:1', sequence: 1, type: 'item', state: 'running',
    progress: { unit: 'body', done: 1, total: 12, succeeded: 0, reused: 8, retryable: 11, failed: 1, blocked: 0 },
    message: { code: 'body.item.processed', params: { coverageDone: 8, coverageTotal: 20 } },
  });
  assert.equal(snapshot.counts.unavailable, 1);
  snapshot = reduceWorkflowSnapshot(snapshot, {
    ...base, eventId: 'job-fixture:2', sequence: 2, type: 'item', state: 'running',
    progress: { unit: 'body', done: 1, total: 12, succeeded: 1, reused: 8, retryable: 11, failed: 0, blocked: 0 },
    message: { code: 'body.item.processed', params: { coverageDone: 9, coverageTotal: 20 } },
  });
  assert.equal(snapshot.counts.unavailable, 0);
  assert.equal(snapshot.counts.fullText, 9);
});

test('fixed 20/50/320 reducer samples are monotonic and ignore duplicate or out-of-order events', () => {
  for (const total of [20, 50, 320]) {
    const baseline = total === 320 ? 251 : Math.floor(total * 0.4);
    const attemptTotal = total - baseline;
    let snapshot = legacyResumeSnapshotAtScale(total, baseline, 0, 0);
    let previous = snapshot;

    for (let done = 1; done <= attemptTotal; done += 1) {
      const event = createWorkflowEvent({
        id: 'job-fixture',
        status: done === attemptTotal ? 'succeeded' : 'running',
        activeAttemptId: 'attempt-2',
        experienceSnapshot: snapshot,
      }, {
        type: 'workflow',
        sequence: done,
        eventId: `job-fixture:${done}`,
        jobId: 'job-fixture',
        attemptId: 'attempt-2',
        occurredAt: new Date(Date.UTC(2026, 7, 3, 8, 0, done)).toISOString(),
        supplied: {
          type: done === attemptTotal ? 'stage' : 'item',
          stage: 'body',
          state: done === attemptTotal ? 'completed' : 'running',
          progress: {
            unit: 'body', done, total: attemptTotal, succeeded: done, reused: baseline,
            retryable: attemptTotal - done, failed: 0, blocked: 0,
          },
          message: { code: 'body.item.processed', params: { coverageDone: baseline + done, coverageTotal: total } },
        },
      });
      snapshot = reduceWorkflowSnapshot(snapshot, event);
      const body = snapshot.stages.find((stage) => stage.stage === 'body');
      assert.ok(snapshot.throughSequence > previous.throughSequence);
      assert.ok(snapshot.counts.fullText >= previous.counts.fullText);
      assert.ok(body.progress.done >= previous.stages.find((stage) => stage.stage === 'body').progress.done);
      previous = snapshot;
    }

    const finalSnapshot = structuredClone(snapshot);
    const duplicate = createWorkflowEvent({
      id: 'job-fixture', activeAttemptId: 'attempt-2', experienceSnapshot: snapshot,
    }, {
      type: 'workflow', sequence: Math.max(1, attemptTotal - 1), eventId: 'duplicate',
      jobId: 'job-fixture', attemptId: 'attempt-2',
      supplied: { type: 'item', stage: 'body', state: 'running' },
    });
    assert.deepEqual(reduceWorkflowSnapshot(snapshot, duplicate), finalSnapshot);
    assert.equal(snapshot.counts.fullText, total);
    assert.equal(snapshot.counts.pending, 0);
  }
});
