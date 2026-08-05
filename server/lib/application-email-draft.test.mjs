import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applicationContactEmails,
  applicationRoleTitle,
  applicationSubjectGuard,
  applicationSubjectRule,
  buildApplicationEmailDraft,
  normalizeApplicationRoleTitle,
  resolveApplicationEmailSubject,
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

test('does not use a recruitment-post slogan as an email subject or role title', () => {
  const value = record();
  value.title = '【急急急！有8月能来实习的吗？聘继任】';
  value.job_card = { company_name: '示例科技' };
  value.body = '请将简历发送到 talent@example.com。';
  value.outreach.email_subject = '急急急！有8月能来实习的吗？聘继任';

  assert.equal(normalizeApplicationRoleTitle(value.title), '');
  const resolved = resolveApplicationEmailSubject(value, value.outreach.email_subject);
  assert.equal(resolved.subject, '应聘岗位｜王梓楠');
  assert.equal(resolved.subjectGuard.sourceStatus, 'rejected_noisy_title');
  assert.equal(resolved.subjectGuard.requiresReview, true);
  assert.equal(applicationSubjectGuard(value, value.outreach.email_subject).requestedNoisyTitle, true);

  const draft = buildApplicationEmailDraft(value);
  assert.equal(draft.jobTitle, '');
  assert.equal(draft.subject, '应聘岗位｜王梓楠');
  assert.equal(draft.sendReady, false);
});

test('rebuilds a noisy title with the extracted role and rejects a bare role title', () => {
  const value = record();
  value.title = '【急急急！有8月能来实习的吗？聘继任】';
  value.job_card.role_name = 'AI产品经理实习生';
  value.outreach.email_subject = value.title;
  value.body = '请将简历发送到 talent@example.com。';

  const reconstructed = resolveApplicationEmailSubject(value, value.outreach.email_subject);
  assert.equal(reconstructed.subject, '应聘AI产品经理实习生｜王梓楠');
  assert.equal(reconstructed.subjectGuard.status, 'reconstructed_from_noisy_title');
  assert.equal(reconstructed.subjectGuard.requiresReview, false);

  const bare = resolveApplicationEmailSubject(value, 'AI产品经理实习生');
  assert.equal(bare.subject, '应聘AI产品经理实习生｜王梓楠');
  assert.equal(bare.subjectGuard.rejectedSubject, 'AI产品经理实习生');
  assert.equal(bare.subjectGuard.sourceStatus, 'rejected_bare_title');
});

test('recovers a role from an explicit role line when the source title is only a recruitment slogan', () => {
  const value = record();
  value.title = '急急急！有8月能来实习的吗？聘继任';
  value.job_card.role_name = '';
  value.job_card.title = '';
  value.body = '招聘岗位：AI产品经理实习生\n请将简历发送到 talent@example.com';
  assert.equal(applicationRoleTitle(value), 'AI产品经理实习生');
  const draft = buildApplicationEmailDraft(value);
  assert.equal(draft.jobTitle, 'AI产品经理实习生');
  assert.equal(draft.subject, '应聘AI产品经理实习生｜王梓楠');
  assert.equal(draft.subjectGuard.status, 'reconstructed_from_noisy_title');
  assert.equal(draft.subjectGuard.requiresReview, false);
});

test('never promotes a social-post title into a default application subject', () => {
  const value = record();
  value.title = '小红书产品运营实习生｜组招继任';
  value.job_card.role_name = '';
  value.job_card.title = value.title;
  value.outreach.email_subject = value.title;
  value.body = '请将简历发送到 talent@example.com。';

  assert.equal(applicationRoleTitle(value), '');
  const draft = buildApplicationEmailDraft(value);
  assert.equal(draft.jobTitle, '');
  assert.equal(draft.subject, '应聘岗位｜王梓楠');
  assert.equal(draft.subjectGuard.requiresReview, true);
  assert.equal(draft.sendReady, false);
});

test('does not mistake a responsibilities paragraph for a role name', () => {
  const value = record();
  value.title = '爱奇艺TV端内容推荐实习生招继任急';
  value.job_card.role_name = '';
  value.job_card.title = '';
  value.body = '岗位职责：1. 协助产品需求分析、竞品研究和项目跟进。\n请将简历发送到 talent@example.com。';

  assert.equal(applicationRoleTitle(value), '');
  assert.equal(buildApplicationEmailDraft(value).subjectGuard.requiresReview, true);
});

test('does not mistake interview questions or topic directions for a role name', () => {
  const value = record();
  value.title = '27届AI PM｜面试复盘';
  value.job_card.role_name = '';
  value.job_card.title = '';
  value.body = 'AI PM都会围绕这几个方向：① 为什么做AI，而不是传统产品？② 如何做需求分析？';

  assert.equal(applicationRoleTitle(value), '');
  assert.equal(buildApplicationEmailDraft(value).subjectGuard.requiresReview, true);
});

test('accepts only an explicit body role line when structured role data is absent', () => {
  const value = record();
  value.title = '爱奇艺TV端内容推荐实习生招继任急';
  value.job_card.role_name = '';
  value.job_card.title = '';
  value.body = '职位名称：TV端内容推荐实习生\n岗位职责：协助产品需求分析。';

  assert.equal(applicationRoleTitle(value), 'TV端内容推荐实习生');
  assert.equal(buildApplicationEmailDraft(value).subject, '应聘TV端内容推荐实习生｜王梓楠');
});

test('replaces an unrelated persisted subject with the reviewed role default', () => {
  const value = record();
  value.title = 'AI产品实习招聘';
  value.job_card.role_name = 'AI产品经理实习生';
  value.outreach.email_subject = '市场营销实习申请｜王梓楠';
  value.body = '请将简历发送到 talent@example.com。';

  const resolved = resolveApplicationEmailSubject(value, value.outreach.email_subject);
  assert.equal(resolved.subject, '应聘AI产品经理实习生｜王梓楠');
  assert.equal(resolved.subjectGuard.rejectedSubject, value.outreach.email_subject);
  assert.equal(resolved.subjectGuard.sourceStatus, 'rejected_unverified_subject');
});

test('strips the complete social-post title even when it contains the reviewed role', () => {
  const value = record();
  value.title = 'AI产品经理居然不是管理岗';
  value.job_card.role_name = 'AI产品经理';
  value.body = '请将简历发送到 talent@example.com。';
  value.outreach.email_subject = `应聘${value.title}｜王梓楠`;

  const resolved = resolveApplicationEmailSubject(value, value.outreach.email_subject);
  assert.equal(resolved.subject, '应聘AI产品经理｜王梓楠');
  assert.equal(resolved.subjectGuard.sourceStatus, 'rejected_noisy_title');
  assert.equal(resolved.subjectGuard.rejectedSubject, value.outreach.email_subject);
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

test('extracts subject requirements written as a requirement or quoted instruction', () => {
  const value = record();
  value.body = '邮件标题要求：姓名-应聘岗位\n请将简历发至 talent@example.com';
  assert.deepEqual(applicationSubjectRule(value), {
    detected: true,
    template: '姓名-应聘岗位',
    evidence: '邮件标题要求：姓名-应聘岗位',
    fields: ['candidateName', 'jobTitle'],
  });

  value.body = '请以“AI产品经理实习申请”作为邮件标题';
  const rule = applicationSubjectRule(value);
  assert.equal(rule.literal, true);
  assert.equal(buildApplicationEmailDraft(value).subject, 'AI产品经理实习申请');
  assert.equal(validateApplicationEmailSubject(value, '其他标题').status, 'non_compliant');

  value.body = '邮件的标题要求：姓名-学校-应聘岗位';
  assert.deepEqual(applicationSubjectRule(value).fields, ['candidateName', 'school', 'jobTitle']);

  value.body = '标题请使用“姓名-学校-应聘岗位”';
  assert.deepEqual(applicationSubjectRule(value).fields, ['candidateName', 'school', 'jobTitle']);

  value.body = '标题请使用‘姓名-学校-应聘岗位’';
  assert.equal(buildApplicationEmailDraft(value).subject, '王梓楠-示例大学-AI 产品经理实习生');
});

test('normalizes a model-provided subject to the extracted rule', () => {
  const value = record();
  value.body = '标题格式为：姓名-学校-应聘岗位';
  const resolved = resolveApplicationEmailSubject(value, '应聘AI产品经理｜王梓楠', {});
  assert.equal(resolved.subject, '王梓楠-示例大学-AI 产品经理实习生');
  assert.equal(resolved.validation.status, 'non_compliant');
});

test('keeps attachment instructions and follow-up copy out of email subjects', () => {
  const value = record();
  value.body = '邮件标题：[辉瑞实习]姓名+年级学校+入职时间+一周几天，需附上简历和作品集，作品集可提供海报、长图文等相关设计作品';
  assert.equal(applicationSubjectRule(value).template, '[辉瑞实习]姓名+年级学校+入职时间+一周几天');

  value.body = '标题格式：姓名-学校-到岗时间-实习时长 合适会尽快安排面试！';
  assert.equal(applicationSubjectRule(value).template, '姓名-学校-到岗时间-实习时长');

  value.body = '简历命名：学校-姓名-到岗时间\n投递邮箱 talent@example.com';
  assert.equal(applicationSubjectRule(value).detected, false);

  value.body = '请将PDF版本简历按照以下格式命名：姓名-学校-每周可实习时间-可实习月份\n投递邮箱 talent@example.com';
  assert.equal(applicationSubjectRule(value).detected, false);

  value.body = '邮件及简历标题请命名为：姓名-学校-到岗时间';
  assert.equal(applicationSubjectRule(value).template, '姓名-学校-到岗时间');
});

test('fills field aliases from the real profile and splits duration from arrival', () => {
  const value = record();
  value.body = '邮件标题：姓名-届数-最快入职时间-持续时长-一周几天-手机号';
  value.candidate_profile.degreeYear = '2026-12';
  value.candidate_profile.internshipDuration = '6个月，2周内到岗';
  value.candidate_profile.phone = '13811817014';

  const draft = buildApplicationEmailDraft(value);
  assert.deepEqual(draft.subjectRule.fields, [
    'candidateName',
    'degreeYear',
    'arrivalDate',
    'internshipDuration',
    'availabilityDays',
    'phone',
  ]);
  assert.equal(draft.subject, '王梓楠-2026-12-2周内到岗-6个月-每周4天-13811817014');
  assert.equal(draft.subjectRule.status, 'compliant');
  assert.equal(draft.sendReady, true);
});

test('accepts a structurally compliant persisted subject when the old record lacks a profile', () => {
  const value = record();
  value.body = '邮件标题：姓名-学校-应聘岗位';
  delete value.candidate_profile;
  const subject = '王梓楠-曼彻斯特大学-AI 产品经理实习生';

  assert.equal(validateApplicationEmailSubject(value, subject).status, 'compliant');
  const draft = buildApplicationEmailDraft(value, { subject });
  assert.equal(draft.subject, subject);
  assert.deepEqual(draft.subjectRule.missingFields, []);
  assert.equal(draft.sendReady, true);
});

test('does not treat course topics or wishful post titles as email instructions', () => {
  const value = record();
  value.body = '今天的课程主题是「AI产品经理辩论」。';
  assert.equal(applicationSubjectRule(value).detected, false);

  value.body = '标题是我许愿的hh。。';
  assert.equal(applicationSubjectRule(value).detected, false);
});

test('keeps undergraduate and graduate education distinct in real title formats', () => {
  const value = record();
  value.body = '邮件标题：姓名-年级-本科学校专业-硕士学校专业-可实习时间-联系电话';
  value.candidate_profile.degreeYear = '2026-12';
  value.candidate_profile.internshipDuration = '6个月，2周内到岗';
  value.candidate_profile.phone = '13811817014';
  value.candidate_profile.education = [
    { degree: '本科', institution: '首都经济贸易大学', field: '电子商务' },
    { degree: '硕士', institution: '曼彻斯特大学', field: '全球发展' },
  ];

  const draft = buildApplicationEmailDraft(value);
  assert.deepEqual(draft.subjectRule.fields, [
    'candidateName',
    'degreeYear',
    'undergraduateEducation',
    'graduateEducation',
    'internshipDuration',
    'phone',
  ]);
  assert.equal(
    draft.subject,
    '王梓楠-2026-12-首都经济贸易大学电子商务-曼彻斯特大学全球发展-6个月-13811817014',
  );
  assert.equal(draft.sendReady, true);
});

test('cleans instruction prefixes and trailing job notes from a real title rule', () => {
  const value = record();
  value.body = '邮件标题：此格式填写：[增长实习] 姓名 - 每周N天 - 最早到岗M月D日';
  value.candidate_profile.arrivalDate = '0810';
  assert.equal(applicationSubjectRule(value).template, '[增长实习] 姓名 - 每周N天 - 最早到岗M月D日');

  value.body = '邮件标题：意向岗位 - 姓名 - 最快到岗时间 *以上岗位base上海，需接受出差';
  assert.equal(applicationSubjectRule(value).template, '意向岗位 - 姓名 - 最快到岗时间');
  assert.equal(buildApplicationEmailDraft(value).subject, 'AI 产品经理实习生 - 王梓楠 - 0810');
});
