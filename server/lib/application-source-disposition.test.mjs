import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyApplicationSource,
  prepareApplicationRecord,
} from './application-source-disposition.mjs';

test('blocks a job-search commentary post even when it mentions recruitment', () => {
  const disposition = classifyApplicationSource({
    note_id: 'commentary-1',
    title: '\u522b\u88abJD\u9a97\u4e86\uff01AI\u4ea7\u54c1\u7ecf\u7406\u6c42\u804c\u771f\u76f8',
    body: '\u4f01\u4e1a\u62db\u8058\u6709\u9690\u5f62\u8003\u70b9\uff0c\u8fd9\u662f\u6c42\u804c\u89e3\u8bfb\u5185\u5bb9\u3002',
    job_card: { role_name: 'AI \u4ea7\u54c1\u7ecf\u7406\u5b9e\u4e60\u751f' },
  });
  assert.equal(disposition.status, 'not_job');
  assert.equal(disposition.reasonCode, 'NON_JOB_SOURCE_CONTEXT');
});

test('accepts a verifiable vacancy and restores its role from the body', () => {
  const record = {
    note_id: 'vacancy-1',
    title: '爱奇艺TV端内容推荐实习生招继任急',
    body: '职位名称：TV端内容推荐实习生\n岗位职责：协助内容推荐。\n请发送简历到 talent@example.com',
    job_card: { role_name: '' },
  };
  const disposition = classifyApplicationSource(record);
  assert.equal(disposition.status, 'sendable');
  assert.equal(disposition.roleName, 'TV端内容推荐实习生');
  assert.equal(prepareApplicationRecord(record, disposition).job_card.role_name, 'TV端内容推荐实习生');
});

test('blocks recruitment copy whose exact role cannot be confirmed', () => {
  const disposition = classifyApplicationSource({
    title: '急急急！有8月能来实习的吗？蹲继任',
    body: '招聘多个业务方向，欢迎投递简历。',
    job_card: { role_name: '' },
  });
  assert.equal(disposition.status, 'needs_role_review');
  assert.equal(disposition.reasonCode, 'ROLE_NAME_MISSING');
});

test('blocks course marketing without a verifiable recruitment signal', () => {
  const disposition = classifyApplicationSource({
    title: '两光年AI产品经理课程到底学什么？',
    body: '课程包含需求分析、竞品分析和产品设计练习。',
    job_card: { role_name: '' },
  });
  assert.equal(disposition.status, 'not_job');
  assert.equal(disposition.reasonCode, 'APPLICATION_SIGNAL_MISSING');
});

test('blocks non-job retrospectives even when they mention an email', () => {
  const disposition = classifyApplicationSource({
    title: '产品经理面试复盘',
    body: '整理后发送到 notes@example.com。',
    job_card: { role_name: '产品经理实习生' },
  });
  assert.equal(disposition.status, 'not_job');
  assert.equal(disposition.reasonCode, 'NON_JOB_SOURCE_TITLE');
});

test('does not treat a recruitment hashtag as the source headline', () => {
  const disposition = classifyApplicationSource({
    title: '招聘AI产品经理实习生，请投递简历 #令人心动的实习日记 #找实习',
    body: '职位名称：AI产品经理实习生\n投递邮箱 talent@example.com。',
    job_card: { role_name: 'AI产品经理实习生' },
  });
  assert.equal(disposition.status, 'sendable');
});

test('blocks full-body sources with no verifiable role responsibilities', () => {
  const disposition = classifyApplicationSource({
    note_id: 'source-blocked-1',
    title: '\u9879\u76ee\u7ec4\u7ecf\u7406\u5b9e\u4e60',
    body: '\u4f5c\u8005\u63d0\u5230\u66fe\u7ecf\u6536\u5230\u90ae\u4ef6\u56de\u590d\uff0c\u4f46\u6ca1\u6709\u53d1\u5e03\u5c97\u4f4d\u804c\u8d23\u3002 talent@example.com',
    job_card: {
      role_name: '\u9879\u76ee\u7ec4\u7ecf\u7406',
      parse_basis: 'full_body',
      responsibility_count: 0,
      requirement_count: 1,
      route_count: 1,
    },
    application_info: {
      responsibilities: [],
      application_routes: [{ type: 'email', value: 'email' }],
    },
  });
  assert.equal(disposition.status, 'source_blocked');
  assert.equal(disposition.reasonCode, 'JOB_DETAIL_MISSING');
});
