const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/iu;

const SUBJECT_FIELDS = Object.freeze([
  { key: 'candidateName', labels: ['候选人姓名', '姓名', '名字'] },
  { key: 'jobTitle', labels: ['应聘岗位', '投递岗位', '岗位名称', '职位名称', '岗位', '职位'] },
  { key: 'company', labels: ['公司名称', '公司'] },
  { key: 'school', labels: ['学校名称', '院校', '学校'] },
  { key: 'major', labels: ['所学专业', '专业'] },
  { key: 'degreeYear', labels: ['毕业年份', '毕业时间', '年级', '届别'] },
  { key: 'availabilityDays', labels: ['每周实习天数', '每周到岗天数', '每周天数', '可实习天数'] },
  { key: 'internshipDuration', labels: ['实习时长', '可实习时长'] },
  { key: 'arrivalDate', labels: ['最早到岗时间', '到岗时间', '到岗日期'] },
  { key: 'aiProductExperience', labels: ['有无AI产品经验', 'AI产品经验'] },
]);

export function applicationContactEmails(record) {
  const routes = [
    ...asObjects(record?.application_info?.contacts),
    ...asObjects(record?.application_info?.application_routes),
  ];
  const values = routes.flatMap((route) => {
    if (!route || typeof route !== 'object' || route.actionable === false) return [];
    const verification = String(route.verification_status || route.verificationStatus || '').toLowerCase();
    if (['invalid', 'rejected', 'unverified'].includes(verification)) return [];
    const type = `${route.type || ''} ${route.channel || ''}`;
    const value = String(route.value || '').trim();
    if (!/(?:e-?mail|邮箱|邮件)/iu.test(type) && !EMAIL.test(value)) return [];
    return `${value}\n${route.evidence || ''}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) || [];
  });
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

export function applicationSubjectRule(record) {
  const source = applicationSourceText(record);
  const patterns = [
    /(?:邮件(?:主题|标题)|投递(?:主题|标题)|主题格式|标题格式|(?:邮件|简历(?:邮件)?)?命名(?:要求|格式)?)\s*(?:请按|应为|为|格式(?:为)?)?\s*[：:]\s*([^\n。；;]{3,120})/giu,
    /(?:请以|请按)\s*[“"'「]?([^”"'」\n。；;]{4,120})[”"'」]?\s*(?:为|作为)?\s*(?:邮件)?(?:主题|标题)/giu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const template = cleanSubjectTemplate(match[1]);
    if (!template || EMAIL.test(template)) continue;
    const fields = subjectFields(template);
    const prefix = match[0].slice(0, match[0].indexOf(match[1]));
    return {
      detected: true,
      template,
      evidence: cleanRule(`${prefix}${template}`),
      fields,
    };
  }
  return { detected: false, template: '', evidence: '', fields: [] };
}

export function buildApplicationEmailDraft(record, input = {}) {
  const values = applicationValues(record, input);
  const rule = applicationSubjectRule(record);
  const generated = rule.detected
    ? subjectFromRule(rule, values)
    : { subject: defaultSubject(record, values), missingFields: [] };
  const subject = String(input.subject || generated.subject || '').trim().slice(0, 300);
  const text = String(input.text || input.body || record?.outreach?.email_body || '').trim().slice(0, 200_000);
  const contacts = applicationContactEmails(record);
  const to = String(input.to || contacts[0] || '').trim().toLowerCase();
  const validation = validateApplicationEmailSubject(record, subject, values);
  const missingFields = [...new Set([...generated.missingFields, ...validation.missingFields])];
  return {
    type: 'application.email_draft',
    noteId: recordId(record),
    jobTitle: values.jobTitle,
    company: values.company,
    to,
    availableRecipients: contacts,
    subject,
    text,
    subjectRule: {
      ...rule,
      status: validation.status,
      missingFields,
    },
    sourceUrl: sourceUrl(record),
    post: applicationPostPreview(record),
    attachmentIds: uniqueStrings(input.attachmentIds),
    sendReady: Boolean(to && subject && text && validation.status !== 'non_compliant' && missingFields.length === 0),
    requiresApproval: true,
  };
}

export function applicationPostPreview(record) {
  const images = uniqueStrings([
    ...asObjects(record?.media?.images).flatMap((image) => [
      image.url,
      image.original_url,
      image.originalUrl,
    ]),
    record?.media?.cover_url,
    record?.media?.cover_original_url,
    ...mediaStrings(record?.image_urls),
    ...mediaStrings(record?.images),
    record?.cover_url,
    record?.card_cover_url,
  ]).filter((value) => /^https?:\/\//iu.test(value)).slice(0, 12);
  const requirements = asObjects(record?.application_info?.requirements)
    .map((item) => firstString(item.text, item.evidence))
    .filter(Boolean)
    .slice(0, 12);
  return {
    title: firstString(record?.title, record?.job_card?.title, record?.job_card?.role_name),
    body: firstString(record?.body, record?.full_body, record?.source_card_text),
    images,
    requirements,
    sourceUrl: sourceUrl(record),
  };
}

export function validateApplicationEmailSubject(record, subject, suppliedValues = {}) {
  const rule = applicationSubjectRule(record);
  if (!rule.detected) return { status: 'not_applicable', missingFields: [], missingValues: [] };
  const values = { ...applicationValues(record, {}), ...suppliedValues };
  const missingFields = rule.fields.filter((key) => !String(values[key] || '').trim());
  const missingValues = rule.fields
    .filter((key) => values[key])
    .filter((key) => !String(subject || '').includes(subjectFieldValue(key, values)));
  return {
    status: missingFields.length ? 'missing_fields' : missingValues.length ? 'non_compliant' : 'compliant',
    missingFields,
    missingValues,
  };
}

function applicationValues(record, input) {
  const candidate = record?.candidate_profile || record?.candidateProfile || {};
  const application = candidate.candidate_application || candidate.candidateProfile || candidate;
  return {
    candidateName: firstString(input.candidateName, application.name, candidate.name),
    jobTitle: firstString(input.jobTitle, record?.job_card?.role_name, record?.title, record?.job_card?.title),
    company: firstString(input.company, record?.job_card?.company_name, record?.company_name, record?.company),
    school: firstString(input.school, application.school),
    major: firstString(input.major, application.major),
    degreeYear: firstString(input.degreeYear, application.degreeYear),
    availabilityDays: firstString(input.availabilityDays, application.availabilityDays),
    internshipDuration: firstString(input.internshipDuration, application.internshipDuration),
    arrivalDate: firstString(input.arrivalDate, application.arrivalDate, application.availableFrom),
    aiProductExperience: firstString(input.aiProductExperience, application.aiProductExperience),
  };
}

function subjectFromRule(rule, values) {
  const missingFields = rule.fields.filter((key) => !String(values[key] || '').trim());
  const looksLikeTemplate = /[{}【】\[\]<>《》+＋|｜/_-]/u.test(rule.template)
    || rule.fields.length >= 2;
  if (!looksLikeTemplate) {
    return { subject: defaultSubject(null, values), missingFields };
  }
  let subject = rule.template;
  const replacements = SUBJECT_FIELDS.flatMap((field) =>
    field.labels.map((label) => ({ key: field.key, label })),
  ).sort((left, right) => right.label.length - left.label.length);
  for (const { key, label } of replacements) {
    const value = subjectFieldValue(key, values);
    if (!value) continue;
    subject = subject.replaceAll(`{${label}}`, value)
      .replaceAll(`【${label}】`, value)
      .replaceAll(`[${label}]`, value)
      .replaceAll(`<${label}>`, value)
      .replaceAll(`《${label}》`, value)
      .replace(new RegExp(escapeRegExp(label), 'gu'), value);
  }
  subject = cleanRule(subject)
    .replace(/^(?:请按|请以|格式(?:为)?|命名(?:为)?|填写)\s*/u, '')
    .replace(/(?:发送|投递|命名)$/u, '')
    .trim();
  if (/(?:包含|注明|写明|格式|命名)/u.test(subject)) {
    const separator = preferredSeparator(rule.template);
    subject = rule.fields.map((key) => subjectFieldValue(key, values)).filter(Boolean).join(separator);
  }
  return { subject: subject || defaultSubject(null, values), missingFields };
}

function defaultSubject(record, values) {
  const existing = String(record?.outreach?.email_subject || '').trim();
  if (existing) return existing;
  return [`应聘${values.jobTitle || '岗位'}`, values.candidateName].filter(Boolean).join('｜');
}

function subjectFields(template) {
  const matches = [];
  for (const field of SUBJECT_FIELDS) {
    const positions = field.labels.map((label) => template.indexOf(label)).filter((index) => index >= 0);
    if (positions.length) matches.push({ key: field.key, index: Math.min(...positions) });
  }
  return matches.sort((left, right) => left.index - right.index).map((item) => item.key);
}

function subjectFieldValue(key, values) {
  const value = String(values[key] || '').trim();
  if (!value) return '';
  if (key === 'availabilityDays' && !/天/u.test(value)) return `每周${value}天`;
  return value;
}

function preferredSeparator(template) {
  for (const separator of ['｜', '|', '-', '_', '+', '＋', '/']) {
    if (template.includes(separator)) return separator === '|' ? '｜' : separator;
  }
  return '｜';
}

function applicationSourceText(record) {
  return [
    record?.body,
    record?.full_body,
    record?.source_card_text,
    record?.card_text_segments,
    record?.job_card?.source_excerpt,
    ...(Array.isArray(record?.application_info?.requirements)
      ? record.application_info.requirements.map((item) => item?.text || item?.evidence)
      : []),
  ].flatMap((value) => Array.isArray(value) ? value : [value]).map(String).filter(Boolean).join('\n');
}

function sourceUrl(record) {
  return firstString(record?.note_url, record?.source_url, record?.job_card?.source_url);
}

function recordId(record) {
  return firstString(record?.note_id, record?.noteId, record?.id);
}

function cleanRule(value) {
  return String(value || '').replace(/[“”"'「」]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function cleanSubjectTemplate(value) {
  return cleanRule(value)
    .replace(/[（(](?:如|例如|写|填写)[^）)]*[）)]/gu, '')
    .replace(/[，,]\s*(?:例如|示例|例)\s*[：:].*$/u, '')
    .replace(/\s+(?=(?:帖子|投递(?:邮箱|方式)|邮箱|简历(?:请|投)|发送至)).*$/u, '')
    .replace(/\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}.*$/iu, '')
    .trim();
}

function firstString(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function asObjects(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  return value && typeof value === 'object' ? [value] : [];
}

function mediaStrings(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      item && typeof item === 'object'
        ? [item.url, item.original_url, item.originalUrl, item.src]
        : [item],
    );
  }
  return value ? [value] : [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
