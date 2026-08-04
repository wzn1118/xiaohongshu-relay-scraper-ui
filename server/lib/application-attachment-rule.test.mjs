import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildApplicationAttachmentRule,
  detectApplicationAttachmentRule,
} from './application-attachment-rule.mjs';

function record(overrides = {}) {
  return {
    note_id: 'note-attachment-rule-001',
    title: 'AI 产品经理实习生',
    body: [
      '邮件标题：姓名-学校-应聘岗位',
      '附件文件名格式：{姓名}_{岗位}_{公司}.pdf',
    ].join('\n'),
    job_card: {
      role_name: 'AI 产品经理实习生',
      company_name: '示例科技',
    },
    candidate_profile: {
      name: '王小明',
      school: '示例大学',
      major: '计算机科学',
    },
    application_info: { requirements: [] },
    ...overrides,
  };
}

test('detects an attachment filename rule without treating the email subject as one', () => {
  const detected = detectApplicationAttachmentRule(record());
  assert.deepEqual(detected, {
    detected: true,
    template: '{姓名}_{岗位}_{公司}.pdf',
    evidence: '附件文件名格式:{姓名}_{岗位}_{公司}.pdf',
    fields: ['candidateName', 'jobTitle', 'company'],
  });

  const result = buildApplicationAttachmentRule(record(), { originalName: 'resume.pdf' });
  assert.deepEqual(result, {
    detected: true,
    template: '{姓名}_{岗位}_{公司}.pdf',
    evidence: '附件文件名格式:{姓名}_{岗位}_{公司}.pdf',
    fields: ['candidateName', 'jobTitle', 'company'],
    status: 'ready',
    missingFields: [],
    displayName: '王小明_AI 产品经理实习生_示例科技.pdf',
  });
});

test('uses a configurable default when the post only contains a subject rule', () => {
  const value = record({ body: '邮件标题格式：姓名-学校-岗位' });
  const result = buildApplicationAttachmentRule(value, {
    originalName: 'resume.docx',
    defaultTemplate: '{company}-{candidateName}-{jobTitle}-简历',
  });

  assert.equal(result.detected, false);
  assert.equal(result.evidence, '');
  assert.equal(result.template, '{company}-{candidateName}-{jobTitle}-简历');
  assert.deepEqual(result.fields, ['company', 'candidateName', 'jobTitle']);
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '示例科技-王小明-AI 产品经理实习生-简历.docx');
});

test('separates an inline attachment rule from the following email subject rule', () => {
  const value = record({
    body: '附件文件名格式：{岗位}-{姓名}-{学校}-简历.pdf，邮件标题格式：岗位+姓名+到岗时间',
  });
  const result = buildApplicationAttachmentRule(value, { originalName: '个人简历.pdf' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '{岗位}-{姓名}-{学校}-简历.pdf');
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, 'AI 产品经理实习生-王小明-示例大学-简历.pdf');
});

test('extracts a continuous article filename rule without copying topics, contact details, or trailing prose', () => {
  const value = record({
    body: [
      '感兴趣欢迎投递，附件简历命名：姓名+学校+周出勤天数+最快到岗时间+实习n个月',
      '#互联网大厂实习 💌投递邮箱：hr@example.com 可以立刻到岗优先。',
    ].join(' '),
    candidate_profile: {
      name: '王小明',
      school: '示例大学',
      availabilityDays: '4天',
      arrivalDate: '2026年8月10日',
      internshipDuration: '3个月',
    },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: '个人简历.pdf' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '姓名+学校+周出勤天数+最快到岗时间+实习n个月');
  assert.equal(result.evidence, '附件简历命名:姓名+学校+周出勤天数+最快到岗时间+实习n个月');
  assert.deepEqual(result.fields, ['candidateName', 'school', 'availabilityDays', 'arrivalDate', 'internshipDuration']);
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '王小明+示例大学+4天+2026年8月10日+3个月.pdf');
  assert.doesNotMatch(result.displayName, /[#@]|互联网|邮箱|可以/u);
});

test('uses a shared subject-and-resume naming instruction when the article explicitly names both', () => {
  const value = record({
    body: '请以【姓名+学校+年级+一周n天+实习n个月+n月n日到岗】为主题和简历文件名（务必严格遵守格式要求）',
    candidate_profile: {
      name: '王小明',
      school: '示例大学',
      degreeYear: '研二',
      availabilityDays: '4天',
      internshipDuration: '3个月',
      arrivalDate: '8月10日',
    },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.pdf' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '姓名+学校+年级+一周n天+实习n个月+n月n日到岗');
  assert.deepEqual(result.fields, ['candidateName', 'school', 'degreeYear', 'availabilityDays', 'internshipDuration', 'arrivalDate']);
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '王小明+示例大学+研二+4天+3个月+8月10日.pdf');
});

test('reads direct bracketed naming formats and article aliases including contact phone', () => {
  const value = record({
    body: '简历命名格式【入职时间-毕业时间-姓名-联系电话-一周到岗天数】👍以下信息仅供参考',
    candidate_profile: {
      name: '王小明',
      degreeYear: '2027年毕业',
      availabilityDays: '5天',
      arrivalDate: '2026年9月1日',
      phoneWeChat: '13800138000',
    },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.pdf' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '入职时间-毕业时间-姓名-联系电话-一周到岗天数');
  assert.deepEqual(result.fields, ['arrivalDate', 'degreeYear', 'candidateName', 'phone', 'availabilityDays']);
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '2026年9月1日-2027年毕业-王小明-13800138000-5天.pdf');
});

test('extracts a resume title remark as the attachment filename rule', () => {
  const value = record({
    body: '简历标题备注上：岗位-姓名-最早到岗时间-可实习时长，简历请发送至 hr@example.com #实习生',
    candidate_profile: {
      name: '王小明',
      arrivalDate: '8月10日',
      internshipDuration: '3个月',
    },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.PDF' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '岗位-姓名-最早到岗时间-可实习时长');
  assert.equal(result.evidence, '简历标题备注上:岗位-姓名-最早到岗时间-可实习时长');
  assert.deepEqual(result.fields, ['jobTitle', 'candidateName', 'arrivalDate', 'internshipDuration']);
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, 'AI 产品经理实习生-王小明-8月10日-3个月.PDF');
});

test('keeps an English rule extension while excluding sentence punctuation', () => {
  const value = record({
    body: 'Email subject: Candidate Name - Job Title. Please name the resume as {candidateName}-{jobTitle}.pdf. Please send it by Friday.',
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.pdf' });

  assert.equal(result.template, '{candidateName}-{jobTitle}.pdf');
  assert.equal(result.evidence, 'name the resume as {candidateName}-{jobTitle}.pdf');
  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '王小明-AI 产品经理实习生.pdf');
});

test('reads requirements and fails closed when a required field is missing', () => {
  const value = record({
    body: '欢迎投递。',
    candidate_profile: { name: '王小明', school: '示例大学' },
    application_info: {
      requirements: [
        { type: 'attachment', text: '请将简历命名为“学校-专业-姓名.docx”' },
      ],
    },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.docx' });

  assert.equal(result.detected, true);
  assert.equal(result.template, '学校-专业-姓名.docx');
  assert.deepEqual(result.fields, ['school', 'major', 'candidateName']);
  assert.equal(result.status, 'missing_fields');
  assert.deepEqual(result.missingFields, ['major']);
  assert.equal(result.displayName, '');
});

test('fails closed for unknown placeholders instead of emitting a partial filename', () => {
  const value = record({ body: '附件命名格式：{姓名}-{内部编号}.pdf' });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.pdf' });

  assert.equal(result.status, 'missing_fields');
  assert.deepEqual(result.missingFields, ['unknown:内部编号']);
  assert.equal(result.displayName, '');
});

test('normalizes NFKC and removes controls and path separators from interpolated values', () => {
  const value = record({
    body: '附件命名格式：{姓名}.pdf',
    candidate_profile: { name: 'Ａ\r\n/B\\C' },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.pdf' });

  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, 'A-B-C.pdf');
  assert.doesNotMatch(result.displayName, /[\r\n/\\]/u);
});

test('guards Windows reserved names and preserves the original extension spelling', () => {
  const value = record({
    body: '附件命名格式：{姓名}',
    candidate_profile: { name: 'CON' },
  });
  const result = buildApplicationAttachmentRule(value, { originalName: 'resume.PDF' });

  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '_CON.PDF');
});

test('truncates by UTF-8 bytes without splitting a Unicode character', () => {
  const value = record({
    body: '附件命名格式：{姓名}.pdf',
    candidate_profile: { name: '一二三四五六七八九十' },
  });
  const result = buildApplicationAttachmentRule(value, {
    originalName: 'resume.pdf',
    maxUtf8Bytes: 20,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.displayName, '一二三四五.pdf');
  assert.ok(Buffer.byteLength(result.displayName, 'utf8') <= 20);
  assert.equal(result.displayName.includes('\uFFFD'), false);

  const tooSmall = buildApplicationAttachmentRule(value, {
    originalName: 'resume.pdf',
    maxUtf8Bytes: 4,
  });
  assert.equal(tooSmall.status, 'invalid_filename');
  assert.equal(tooSmall.displayName, '');
});

test('rejects unsupported, traversing, and rule-conflicting extensions', () => {
  const supportedRule = record({ body: '附件命名格式：{姓名}.pdf' });
  for (const originalName of ['resume.exe', '../resume.pdf', 'folder\\resume.pdf']) {
    const result = buildApplicationAttachmentRule(supportedRule, { originalName });
    assert.equal(result.status, 'invalid_extension');
    assert.equal(result.displayName, '');
  }

  const mismatch = buildApplicationAttachmentRule(
    record({ body: '附件命名格式：{姓名}.docx' }),
    { originalName: 'resume.pdf' },
  );
  assert.equal(mismatch.status, 'extension_mismatch');
  assert.equal(mismatch.displayName, '');
});
