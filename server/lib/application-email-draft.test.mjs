import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applicationContactEmails,
  applicationSubjectRule,
  buildApplicationEmailDraft,
  validateApplicationEmailSubject,
} from './application-email-draft.mjs';

function record() {
  return {
    note_id: 'note-application-001',
    title: 'AI 产品经理实习生',
    body: [
      '请将简历发送到 talent@example.com。',
      '邮件标题：姓名-学校-应聘岗位-每周实习天数',
      '岗位要求：每周至少到岗 4 天。',
    ].join('\n'),
    job_card: {
      role_name: 'AI 产品经理实习生',
      company_name: '示例科技',
      source_url: 'https://www.xiaohongshu.com/explore/note-application-001?xsec_token=secret',
    },
    media: {
      cover_url: 'https://img.example.test/cover.webp',
      images: [
        { url: 'https://img.example.test/detail-1.webp', source: 'detail' },
        { url: 'https://img.example.test/detail-1.webp', source: 'card' },
      ],
    },
    application_info: {
      contacts: [
        { type: 'email', value: 'talent@example.com', evidence: '投递邮箱 talent@example.com' },
      ],
    },
    candidate_profile: {
      name: '王梓楠',
      school: '示例大学',
      availabilityDays: '4',
    },
    outreach: {
      email_body: '尊敬的招聘负责人：\n您好，我是王梓楠，希望应聘 AI 产品经理实习生岗位，期待进一步沟通。',
    },
  };
}

test('extracts recruitment contacts and an explicit subject-format rule', () => {
  assert.deepEqual(applicationContactEmails(record()), ['talent@example.com']);
  assert.deepEqual(applicationSubjectRule(record()), {
    detected: true,
    template: '姓名-学校-应聘岗位-每周实习天数',
    evidence: '邮件标题：姓名-学校-应聘岗位-每周实习天数',
    fields: ['candidateName', 'school', 'jobTitle', 'availabilityDays'],
  });
});

test('builds and validates a job-specific email subject without inventing missing fields', () => {
  const draft = buildApplicationEmailDraft(record());
  assert.equal(draft.to, 'talent@example.com');
  assert.equal(draft.subject, '王梓楠-示例大学-AI 产品经理实习生-每周4天');
  assert.equal(draft.subjectRule.status, 'compliant');
  assert.equal(draft.sendReady, true);
  assert.deepEqual(draft.post, {
    title: 'AI 产品经理实习生',
    body: [
      '请将简历发送到 talent@example.com。',
      '邮件标题：姓名-学校-应聘岗位-每周实习天数',
      '岗位要求：每周至少到岗 4 天。',
    ].join('\n'),
    images: [
      'https://img.example.test/detail-1.webp',
      'https://img.example.test/cover.webp',
    ],
    requirements: [],
    sourceUrl: 'https://www.xiaohongshu.com/explore/note-application-001?xsec_token=secret',
  });
  assert.equal(
    validateApplicationEmailSubject(record(), '随便写一个标题').status,
    'non_compliant',
  );

  const incomplete = record();
  delete incomplete.candidate_profile.school;
  const missing = buildApplicationEmailDraft(incomplete);
  assert.equal(missing.subjectRule.status, 'missing_fields');
  assert.deepEqual(missing.subjectRule.missingFields, ['school']);
  assert.equal(missing.sendReady, false);
});

test('uses the existing role draft when the recruitment post has no subject rule', () => {
  const value = record();
  value.body = '请将简历发送到 talent@example.com。';
  value.outreach.email_subject = '应聘AI 产品经理实习生｜王梓楠';
  const draft = buildApplicationEmailDraft(value);
  assert.equal(draft.subject, value.outreach.email_subject);
  assert.equal(draft.subjectRule.status, 'not_applicable');
});

test('supports historical records with one contact object and a generic naming requirement', () => {
  const value = record();
  value.body = '📮命名要求：学校-专业-可实习时长-姓名\n投递邮箱 2906010796@example.com';
  value.application_info.contacts = {
    type: 'email',
    value: '2906010796@example.com',
    evidence: '投递邮箱 2906010796@example.com',
  };
  value.candidate_profile.major = '市场营销';
  value.candidate_profile.internshipDuration = '3个月';

  assert.deepEqual(applicationContactEmails(value), ['2906010796@example.com']);
  assert.deepEqual(applicationSubjectRule(value).fields, [
    'school',
    'major',
    'internshipDuration',
    'candidateName',
  ]);
  assert.equal(buildApplicationEmailDraft(value).subject, '示例大学-市场营销-3个月-王梓楠');
});

test('removes examples from the title rule and requires AI product experience when requested', () => {
  const value = record();
  value.body = '邮件命名格式：姓名+学校+专业+最早到岗时间（如：0810）+有无AI产品经验（写有/无就可），例如：张三+复旦大学+计算机+0810+有';
  value.candidate_profile.major = '市场营销';
  value.candidate_profile.arrivalDate = '0810';

  const incomplete = buildApplicationEmailDraft(value);
  assert.equal(
    incomplete.subjectRule.template,
    '姓名+学校+专业+最早到岗时间+有无AI产品经验',
  );
  assert.deepEqual(incomplete.subjectRule.missingFields, ['aiProductExperience']);
  assert.equal(incomplete.sendReady, false);

  const complete = buildApplicationEmailDraft(value, { aiProductExperience: '有' });
  assert.equal(complete.subject, '王梓楠+示例大学+市场营销+0810+有');
  assert.equal(complete.subjectRule.status, 'compliant');
});
