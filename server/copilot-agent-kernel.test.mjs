import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectToolEvidence,
  createAgentPlan,
  markPlanToolCompleted,
  markPlanToolStarted,
  markPlanVerification,
  verifyAgentAnswer,
} from './copilot-agent-kernel.mjs';

test('data answers require traceable evidence and pass after a sourced tool result', () => {
  const rejected = verifyAgentAnswer({
    objective: '查找上海的岗位',
    answer: '找到 3 条。',
  });
  assert.equal(rejected.passed, false);
  assert.equal(rejected.issues[0].code, 'missing_data_evidence');

  const result = { rows: [{ id: 1 }], source: 'xhs-data://jobs/job-001/applications' };
  const accepted = verifyAgentAnswer({
    objective: '查找上海的岗位',
    answer: '找到 1 条。',
    evidence: collectToolEvidence('records.query', result),
    toolResults: [result],
  });
  assert.equal(accepted.passed, true);
  assert.equal(accepted.evidence[0].source, result.source);
});

test('export requests require a durable artifact receipt', () => {
  const rejected = verifyAgentAnswer({
    objective: '导出 CSV 文件',
    answer: '已经整理完成。',
    evidence: [{ toolName: 'records.query', source: 'xhs-data://jobs/job-001/content' }],
  });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.issues.some((issue) => issue.code === 'missing_artifact'));

  const accepted = verifyAgentAnswer({
    objective: '导出 CSV 文件',
    answer: '文件已生成。',
    evidence: [{ toolName: 'records.query', source: 'xhs-data://jobs/job-001/content' }],
    toolResults: [{ type: 'artifact.ready', artifact: { artifactId: 'artifact-001' } }],
  });
  assert.equal(accepted.passed, true);
});

test('plan state records execution and verification transitions', () => {
  const initial = createAgentPlan({ objective: '分析评论数据', tools: [{ name: 'audience.comments' }] });
  const running = markPlanToolStarted(initial, 'audience.comments');
  const completed = markPlanToolCompleted(running, 'audience.comments');
  const verified = markPlanVerification(completed, { passed: true, issues: [] });

  assert.equal(running.steps.find((step) => step.id === 'inspect').status, 'in_progress');
  assert.equal(completed.steps.find((step) => step.id === 'inspect').status, 'completed');
  assert.equal(verified.status, 'completed');
  assert.equal(verified.steps.find((step) => step.id === 'verify').status, 'completed');
  assert.equal(verified.steps.find((step) => step.id === 'respond').status, 'completed');
});
