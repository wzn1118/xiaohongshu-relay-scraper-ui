const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/iu;
const ROLE_CORE_SIGNAL = /(?:AI\s*产品|产品|运营|用户研究|研究|数据|分析|商业|增长|市场|品牌|商务|销售|财务|法务|人力|行政|助理|顾问|经理|专员|管培生|工程师|开发|研发|测试|算法|设计|编辑|剪辑|项目|咨询|内容|电商|社群|海外|视觉|软件|医学|医药|信息|沟通|product|operations?|marketing|design|engineer|developer|analyst|research|sales|finance|legal|human\s+resources?|consult)/iu;
const ROLE_SHAPE_SIGNAL = /(?:实习生|实习岗|实习|intern(?:ship)?|trainee|产品经理|项目经理|经理|专员|助理|工程师|开发|研发|测试|算法|设计|编辑|剪辑|分析师|研究员|顾问|管培生|运营|产品|研究|分析|咨询|策划|市场|品牌|商务|销售|财务|法务|人力|行政|沟通员|信息员|product\s+manager|project\s+manager|manager|specialist|assistant|engineer|developer|analyst|researcher|designer|operator|operations?|marketing)$/iu;
const ROLE_DISQUALIFIER_SIGNAL = /(?:继任|急{1,}|急招|急聘|招聘|招募|内推|直招|速来|投递|到岗|入职|优先|有[^\n]{0,12}实习|能来实习|实习的?吗|找[^\n]{0,12}实习|帮[^\n]{0,12}招|接受无经验|岗位职责|工作职责|职位描述|任职要求|岗位要求|薪资|待遇|工作地点|办公地点|公司\s*[:：]|负责|协助|参与|请将|简历|邮箱|联系方式|为什么|怎么|如何|面试|面经|总结|复盘|而不是|#|＃)/iu;
const RECRUITMENT_NOISE_SIGNAL = /(?:继任|急{1,}|急招|急聘|招聘|招募|内推|直招|招(?:实习)?继任|找(?:个)?(?:实习)?继任|蹲(?:个)?(?:实习)?继任|捞(?:个)?(?:实习)?继任|聘继任|求(?:个)?实习|有\s*\d{1,2}\s*月[^\n]{0,18}(?:实习|到岗)|能来实习|实习的?吗|速来投递|转发|求转|求推荐)/iu;
const APPLICATION_PREFIX = /^\s*(?:主题\s*[:：]\s*)?(?:应聘|申请|求职)(?:岗位|职位)?\s*[:：]?\s*/iu;

const SUBJECT_FIELDS = Object.freeze([
  { key: 'candidateName', labels: ['候选人姓名', '你的名字', '姓名', '名字'] },
  { key: 'jobTitle', labels: ['应聘岗位', '投递岗位', '意向岗位', '岗位名称', '职位名称', '岗位', '职位'] },
  { key: 'company', labels: ['公司名称', '公司'] },
  { key: 'undergraduateEducation', labels: ['本科学校专业', '本科院校专业'] },
  { key: 'graduateEducation', labels: ['硕士学校专业', '研究生学校专业'] },
  { key: 'school', labels: ['本/硕XX大学', '本/硕xx大学', 'xx学校', 'XX学校', '学校学历', '学校名称', '学校名', '院校', '学校'] },
  { key: 'major', labels: ['所学专业', '专业名称', '专业'] },
  { key: 'degreeYear', labels: ['毕业年份', '毕业时间', '在读年级', '年级', '年纪', '届别', '届数', 'xx届', 'XX届'] },
  { key: 'availabilityDays', labels: ['每周可来线下工作的天数', '每周可实习天数', '每周可实习时间', '每周可实习时长', '可实习每周几天', '每周可出勤天数', '每周可到岗x天', '每周到岗天数', '每周实习天数', '每周出勤天数', '一周实习几天', '每周几天', '每周N天', '一周几天', '一周n天', '到岗天数', '出勤天数', '每周天数', '可实习天数'] },
  { key: 'internshipDuration', labels: ['实习持续时间', '连续实习几月', '可实习几个月', '可实习月份', '可实习月数', '实习几个月', '实习n个月', '可实习时间', '可实习X月', '可实习x月', '可持续x月', '持续时长', '持续多久', '持续时间', '实习时长', '可实习时长', '几个月', '时长'] },
  { key: 'arrivalDate', labels: ['最早可入职时间', '最快入职时间', '入职具体时间', '最早到岗M月D日', 'x月x日后到岗', '最快到岗日期', '最早到岗日期', '最早到岗时间', '最快到岗时间', '可到岗日期', '可入职时间', '到岗日期', '入职时间', '可到岗时间', '到岗时间'] },
  { key: 'aiProductExperience', labels: ['有无AI产品经验', 'AI产品经验'] },
  { key: 'relevantExperience', labels: ['是否有互联网战略/商分经验', '最相关经历/优势', '相关经历/优势'] },
  { key: 'phone', labels: ['联系电话', '手机号码', '手机号', '电话号码', '电话'] },
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

/** Return a role suitable for an email subject, excluding recruitment slogans. */
export function normalizeApplicationRoleTitle(value) {
  const original = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!original) return '';
  const bracket = original.match(/^\s*[【\[]\s*(.*?)\s*[】\]]\s*$/u);
  if (bracket && RECRUITMENT_NOISE_SIGNAL.test(bracket[1]) && !ROLE_CORE_SIGNAL.test(bracket[1])) return '';

  let title = bracket ? bracket[1] : original;
  title = title
    .replace(APPLICATION_PREFIX, '')
    .replace(/^\s*[【\[]\s*(?:急+|急招|急聘|招聘|招募|内推|直招|求(?:个)?实习|招继任|找继任)\s*[】\]]\s*/iu, '')
    .replace(/^\s*(?:急+|急招|急聘|招聘|招募|内推|直招|求(?:个)?实习|招继任|找继任)\s*[-—:：|｜]?\s*/iu, '')
    .replace(/(?:招|找|蹲|捞|聘|求)(?:个)?(?:实习)?继任(?:者)?/giu, ' ')
    .replace(/\bASAP\b/giu, ' ')
    .replace(/(?:速来投递|接受无经验|到岗优先|尽快到岗|暑假到岗)/giu, ' ')
    .replace(/\s*[?？!！].*$/u, ' ')
    .trim();

  const pieces = title.split(/\s*[|｜]\s*/u).map(cleanRolePiece).filter(Boolean);
  if (pieces.length > 1) {
    const rolePieces = pieces.filter((item) => ROLE_CORE_SIGNAL.test(item));
    title = rolePieces.length ? rolePieces.join('｜') : pieces[0];
  } else {
    title = pieces[0] || '';
  }

  title = title
    .replace(/(?:\s*[-—:：|｜]+\s*)?(?:招聘|招募|热招|开放)(?:中|进行中)?\s*$/iu, '')
    .replace(/\s*(?:每周|到岗|姓名|候选人|应聘者|作者|发布者)\s*[:：].*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[#＃【】[\]|｜:：\-—，,。；;\s]+|[#＃【】[\]|｜:：\-—，,。；;\s]+$/gu, '');

  if (!title) return '';
  if (!isCredibleRoleTitle(title)) return '';
  return title.slice(0, 60);
}

/** Resolve a role from parsed fields or the post body. The social-post title is never a role source. */
export function applicationRoleTitle(record, input = {}) {
  const structuredCandidates = [
    input?.jobTitle,
    record?.job_card?.role_name,
    record?.application_info?.role_name,
    record?.role_name,
  ];
  for (const candidate of structuredCandidates) {
    const normalized = normalizeApplicationRoleTitle(candidate);
    if (normalized) return normalized;
  }

  const source = applicationSourceText(record);
  const patterns = [
    /(?:招聘岗位|应聘岗位|岗位名称|招聘职位|职位名称|职位)\s*(?:为|是|：|:)\s*([^\n。；;]{2,60})/giu,
    /((?:[A-Z0-9]+\s*)?(?:AI\s*产品|AIGC|产品|运营|用户研究|数据|商业|市场|内容|项目|销售|设计|研发|算法)[A-Z0-9\u4e00-\u9fff /+-]{0,22}(?:经理|专员|实习生|实习岗|实习|助理|工程师|分析师|研究员|intern))/giu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const normalized = normalizeApplicationRoleTitle(match[1]);
      if (normalized && ROLE_CORE_SIGNAL.test(normalized)) return normalized;
    }
  }
  return '';
}

export function isNoisyApplicationTitle(value) {
  const original = String(value || '').trim();
  if (!original) return false;
  const normalized = normalizeApplicationRoleTitle(original);
  return RECRUITMENT_NOISE_SIGNAL.test(original)
    || !normalized
    || normalizeSubjectComparison(normalized) !== normalizeSubjectComparison(original);
}

export function applicationSubjectGuard(record, subject = '', suppliedValues = {}) {
  const values = { ...applicationValues(record, {}), ...suppliedValues };
  const rule = applicationSubjectRule(record);
  const rawTitles = applicationRawRoleTitles(record);
  const noisyTitle = rawTitles.find((value) => isNoisyApplicationTitle(value)) || '';
  const requested = String(subject || '').trim();
  const sourceTitle = String(record?.title || '').trim();
  const resolvedJobTitle = normalizeApplicationRoleTitle(values.jobTitle);
  const sourceTitleIsVerifiedRole = Boolean(
    sourceTitle
    && resolvedJobTitle
    && normalizeSubjectComparison(normalizeApplicationRoleTitle(sourceTitle)) === normalizeSubjectComparison(resolvedJobTitle),
  );
  const requestedSourceTitle = Boolean(
    requested
    && sourceTitle
    && !sourceTitleIsVerifiedRole
    && subjectContainsTitleNoise(requested, sourceTitle),
  );
  const requestedNoisyTitle = Boolean(requested && (
    requestedSourceTitle
    || (noisyTitle && subjectContainsTitleNoise(requested, noisyTitle))
  ));
  const requestedBareTitle = Boolean(requested && rawTitles.some((value) => subjectEqualsRoleTitle(requested, value)));
  const safeDefaultSubject = isSafeDefaultApplicationSubject(requested, resolvedJobTitle);
  const requestedUnverifiedSubject = Boolean(requested && !rule.detected && !safeDefaultSubject);
  const status = rule.detected
    ? 'explicit_rule'
    : requestedNoisyTitle
      ? 'rejected_noisy_title'
      : requestedBareTitle
        ? 'rejected_bare_title'
        : requestedUnverifiedSubject
          ? 'rejected_unverified_subject'
        : !resolvedJobTitle
          ? 'role_title_missing'
          : noisyTitle
            ? 'reconstructed_from_noisy_title'
            : 'clean';
  return {
    status,
    sourceStatus: status,
    requestedNoisyTitle,
    requestedBareTitle,
    requestedSourceTitle,
    requestedUnverifiedSubject,
    safeDefaultSubject,
    explicitRule: rule.detected,
    rawTitle: noisyTitle,
    resolvedJobTitle,
    requiresReview: !rule.detected && !resolvedJobTitle,
    suggestedSubject: defaultSubject(null, { ...values, jobTitle: resolvedJobTitle }),
  };
}

export function applicationSubjectRule(record) {
  const source = applicationSourceText(record);
  const patterns = [
    /(?:邮件(?:的)?(?:主题|标题)(?:要求|格式)?|投递(?:邮件)?(?:主题|标题)(?:要求|格式)?|(?:主题|标题)(?:格式|要求)|(?:投递邮件|投递|邮件)?命名(?:要求|格式)?)\s*(?:是|请按|应为|为|格式(?:为)?|请填写|请写)?\s*[：:]\s*([^\n。；;]{3,120})/giu,
    /(?:邮件(?:的)?(?:主题|标题)|(?:主题|标题))\s*(?:是|请按|需按|需使用|使用|请使用|请填写|填写为|写为|请写|应为|为)\s*[“"'「‘]?([^”"'」’\n。；;]{3,120})[”"'」’]?/giu,
    /(?:请以|请按)\s*[“"'「‘]?([^”"'」’\n。；;]{4,120})[”"'」’]?\s*(?:为|作为)?\s*(?:邮件)?(?:主题|标题)/giu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    if (!isLikelyEmailSubjectInstruction(source, match.index, match[0])) continue;
    const template = cleanSubjectTemplate(match[1]);
    if (!template || EMAIL.test(template)) continue;
    const fields = subjectFields(template);
    if (!fields.length && RECRUITMENT_NOISE_SIGNAL.test(template)) continue;
    const prefix = match[0].slice(0, match[0].indexOf(match[1]));
    const rule = {
      detected: true,
      template,
      evidence: cleanRule(`${prefix}${template}`),
      fields,
    };
    if (fields.length === 0) rule.literal = true;
    return rule;
  }
  return { detected: false, template: '', evidence: '', fields: [] };
}

export function resolveApplicationEmailSubject(record, suppliedSubject = '', input = {}) {
  const values = applicationValues(record, input);
  const rule = applicationSubjectRule(record);
  const generated = rule.detected
    ? subjectFromRule(rule, values)
    : { subject: defaultSubject(record, values), missingFields: [] };
  const requested = String(suppliedSubject || '').trim().slice(0, 300);
  const validation = validateApplicationEmailSubject(record, requested, values);
  const requestedGuard = applicationSubjectGuard(record, requested, values);
  const subject = rule.detected
    ? (validation.status === 'compliant' ? requested : generated.subject)
    : (requested
      && requestedGuard.safeDefaultSubject
      && !requestedGuard.requestedBareTitle
      && !requestedGuard.requestedNoisyTitle
      ? requested
      : generated.subject);
  const subjectGuard = applicationSubjectGuard(record, subject, values);
  return {
    subject: String(subject || '').trim().slice(0, 300),
    rule,
    generated,
    validation,
    subjectGuard: {
      ...subjectGuard,
      rejectedSubject: requestedGuard.requestedUnverifiedSubject
        || requestedGuard.requestedBareTitle
        || requestedGuard.requestedNoisyTitle
        ? requested
        : '',
      sourceStatus: requestedGuard.status,
    },
    missingFields: validation.status === 'compliant'
      ? []
      : [...new Set([...generated.missingFields, ...validation.missingFields])],
  };
}

export function buildApplicationEmailDraft(record, input = {}) {
  const values = applicationValues(record, input);
  const resolvedSubject = resolveApplicationEmailSubject(record, input.subject, input);
  const { rule, generated } = resolvedSubject;
  const subject = resolvedSubject.subject;
  const text = String(input.text || input.body || record?.outreach?.email_body || '').trim().slice(0, 200_000);
  const contacts = applicationContactEmails(record);
  const to = String(input.to || contacts[0] || '').trim().toLowerCase();
  const validation = validateApplicationEmailSubject(record, subject, values);
  const missingFields = validation.status === 'compliant'
    ? []
    : [...new Set([...generated.missingFields, ...validation.missingFields])];
  const subjectGuard = resolvedSubject.subjectGuard;
  const subjectBlocked = subjectGuard.requiresReview
    || (!rule.detected && ['rejected_noisy_title', 'rejected_bare_title'].includes(subjectGuard.sourceStatus));
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
    subjectGuard,
    sourceUrl: sourceUrl(record),
    post: applicationPostPreview(record),
    attachmentIds: uniqueStrings(input.attachmentIds),
    sendReady: Boolean(
      to
      && subject
      && text
      && validation.status !== 'non_compliant'
      && missingFields.length === 0
      && !subjectBlocked,
    ),
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
  if (!rule.fields.length) {
    const actual = normalizeSubjectComparison(subject);
    const expected = normalizeSubjectComparison(rule.template);
    return {
      status: actual && actual === expected ? 'compliant' : 'non_compliant',
      missingFields: [],
      missingValues: actual && actual === expected ? [] : ['subject'],
    };
  }
  const actual = String(subject || '').trim();
  const structurallyCompliant = subjectMatchesRule(rule, actual, values);
  if (structurallyCompliant) {
    return { status: 'compliant', missingFields: [], missingValues: [] };
  }
  const missingValues = rule.fields
    .filter((key) => values[key])
    .filter((key) => !actual.includes(subjectFieldValue(key, values)));
  return {
    status: missingFields.length ? 'missing_fields' : missingValues.length ? 'non_compliant' : 'compliant',
    missingFields,
    missingValues,
  };
}

function applicationValues(record, input) {
  const candidate = record?.candidate_profile || record?.candidateProfile || {};
  const application = candidate.candidate_application || candidate.candidateProfile || candidate;
  const availability = splitInternshipAvailability(firstString(input.internshipDuration, application.internshipDuration));
  return {
    candidateName: firstString(input.candidateName, application.name, candidate.name),
    jobTitle: applicationRoleTitle(record, input),
    company: firstString(input.company, record?.job_card?.company_name, record?.company_name, record?.company),
    school: firstString(input.school, application.school),
    major: firstString(input.major, application.major),
    undergraduateEducation: firstString(
      input.undergraduateEducation,
      application.undergraduateEducation,
      educationSummary(application.education, /(?:本科|学士)/u),
    ),
    graduateEducation: firstString(
      input.graduateEducation,
      application.graduateEducation,
      educationSummary(application.education, /(?:硕士|研究生)/u),
    ),
    degreeYear: firstString(input.degreeYear, application.degreeYear),
    availabilityDays: firstString(input.availabilityDays, application.availabilityDays),
    internshipDuration: availability.duration,
    arrivalDate: firstString(input.arrivalDate, application.arrivalDate, application.availableFrom, availability.arrivalDate),
    aiProductExperience: firstString(input.aiProductExperience, application.aiProductExperience),
    relevantExperience: firstString(input.relevantExperience, application.relevantExperience, application.experienceSummary),
    phone: firstString(input.phone, input.phoneWeChat, application.phone, application.mobile, application.phoneWeChat, application.contact?.phone),
  };
}

function subjectFromRule(rule, values) {
  const missingFields = rule.fields.filter((key) => !String(values[key] || '').trim());
  if (rule.fields.length === 0) {
    return { subject: cleanRule(rule.template), missingFields };
  }
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
  const jobTitle = normalizeApplicationRoleTitle(values.jobTitle) || '岗位';
  return [`应聘${jobTitle}`, values.candidateName].filter(Boolean).join('｜');
}

function applicationRawRoleTitles(record) {
  return [
    record?.job_card?.role_name,
    record?.job_card?.title,
    record?.role_name,
    record?.title,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function subjectContainsTitleNoise(subject, noisyTitle) {
  const actual = normalizeSubjectComparison(String(subject || '').replace(/^主题\s*[:：]\s*/u, ''));
  const title = normalizeSubjectComparison(noisyTitle);
  return Boolean(actual && title && (actual === title || actual.includes(title) || title.includes(actual)));
}

function subjectEqualsRoleTitle(subject, title) {
  const actual = normalizeSubjectComparison(String(subject || '').replace(/^主题\s*[:：]\s*/u, ''));
  const role = normalizeSubjectComparison(title);
  return Boolean(actual && role && actual === role);
}

function cleanRolePiece(value) {
  return String(value || '')
    .replace(/^[#＃【】[\]|｜:：\-—，,。；;\s]+|[#＃【】[\]|｜:：\-—，,。；;\s]+$/gu, '')
    .trim();
}

function isCredibleRoleTitle(value) {
  const title = cleanRolePiece(value);
  const length = Array.from(title).length;
  if (!title || length < 2 || length > 60) return false;
  if (EMAIL.test(title) || /[\n?？！!。；;]/u.test(title)) return false;
  if (ROLE_DISQUALIFIER_SIGNAL.test(title)) return false;
  if (/^(?:岗位|职位|实习|实习生|intern(?:ship)?|招聘信息)$/iu.test(title)) return false;
  if (/^(?:\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/u.test(title)) return false;
  const shapeTitle = title.replace(/[（(][^）)]{1,30}[）)]$/u, '').trim();
  const shapePieces = shapeTitle.split(/[/|｜]/u).map((item) => item.trim()).filter(Boolean);
  return ROLE_CORE_SIGNAL.test(title) && shapePieces.some((item) => ROLE_SHAPE_SIGNAL.test(item));
}

function isSafeDefaultApplicationSubject(subject, jobTitle) {
  const actual = String(subject || '').replace(/^主题\s*[:：]\s*/u, '').trim();
  const role = normalizeApplicationRoleTitle(jobTitle);
  if (!actual || !role || Array.from(actual).length > 120) return false;
  if (/[\n?？！!。；;]/u.test(actual) || RECRUITMENT_NOISE_SIGNAL.test(actual)) return false;
  return normalizeSubjectComparison(actual).includes(normalizeSubjectComparison(role));
}

function subjectFields(template) {
  const labels = SUBJECT_FIELDS.flatMap((field) =>
    field.labels.map((label) => ({ key: field.key, label })),
  ).sort((left, right) => right.label.length - left.label.length);
  const matches = [];
  for (let cursor = 0; cursor < template.length;) {
    const token = labels.find(({ label }) => template.startsWith(label, cursor));
    if (!token) {
      cursor += 1;
      continue;
    }
    if (!matches.includes(token.key)) matches.push(token.key);
    cursor += token.label.length;
  }
  return matches;
}

function subjectFieldValue(key, values) {
  const value = String(values[key] || '').trim();
  if (!value) return '';
  if (key === 'availabilityDays' && !/天/u.test(value)) return `每周${value}天`;
  return value;
}

function subjectMatchesRule(rule, subject, values) {
  if (!subject) return false;
  const labels = SUBJECT_FIELDS.flatMap((field) =>
    field.labels.map((label) => ({ key: field.key, label })),
  ).sort((left, right) => right.label.length - left.label.length);
  let cursor = 0;
  let pattern = '^';
  while (cursor < rule.template.length) {
    const token = labels.find(({ label }) => rule.template.startsWith(label, cursor));
    if (!token) {
      pattern += escapeRegExp(rule.template[cursor]);
      cursor += 1;
      continue;
    }
    const value = subjectFieldValue(token.key, values);
    if (!value && subject.includes(token.label)) return false;
    pattern += value ? escapeRegExp(value) : '.{1,80}?';
    cursor += token.label.length;
  }
  return new RegExp(pattern + '$', 'iu').test(cleanRule(subject));
}

function splitInternshipAvailability(value) {
  const raw = firstString(value);
  if (!raw) return { duration: '', arrivalDate: '' };
  const parts = raw.split(/[，,；;、/]/u).map((item) => item.trim()).filter(Boolean);
  const arrivalDate = parts.find((item) => /(?:到岗|入职)/u.test(item)) || '';
  const durationParts = parts.filter((item) => item !== arrivalDate);
  return {
    duration: durationParts.join('，') || (arrivalDate ? '' : raw),
    arrivalDate,
  };
}

function educationSummary(education, degreePattern) {
  if (!Array.isArray(education)) return '';
  const item = education.find((entry) => degreePattern.test(firstString(entry?.degree, entry?.level)));
  return [firstString(item?.institution, item?.school), firstString(item?.field, item?.major)].filter(Boolean).join('');
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
  return String(value || '').replace(/[“”‘’"'「」]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function isLikelyEmailSubjectInstruction(source, index, matchText) {
  const before = source.slice(Math.max(0, index - 36), index);
  const window = source.slice(Math.max(0, index - 90), index + matchText.length + 120);
  const explicitEmailNaming = /(?:邮件|邮箱|主题|标题)[^\n，。；;]{0,12}(?:命名|格式)/iu.test(window);
  const resumeNaming = /(?:简历|附件|文件|PDF|作品集)[^\n，。；;]{0,18}(?:命名|格式)/iu.test(window);
  const explicitMailSubjectMatch = /(?:邮件(?:的)?(?:主题|标题)|投递(?:邮件)?(?:主题|标题))/iu.test(matchText);
  const attachmentMatchContext = /(?:简历|附件|文件|PDF|作品集)[^\n，。；;]{0,18}(?:命名|主题|标题|格式)/iu.test(`${before}${matchText}`);
  const explicitEmailContext = /(?:邮件|邮箱|投递|简历和邮件|邮件及简历|📮|📩|📬)/iu.test(window)
    || EMAIL.test(window);
  if (resumeNaming && !explicitEmailNaming && !explicitMailSubjectMatch) return false;
  // Resume/file naming is a separate attachment rule, not an email subject.
  if (attachmentMatchContext && !explicitEmailNaming && !explicitMailSubjectMatch) {
    return false;
  }
  // A bare "命名" is accepted only when the nearby post explicitly points to
  // a mail/投递 channel (including the common mailbox emoji marker).
  if (/命名/iu.test(matchText) && !/(?:邮件|邮箱|投递|主题|标题|📮|📩|📬)/iu.test(window)) {
    return false;
  }
  if (/^(?:主题|标题)\s*是/iu.test(matchText.trim()) && !explicitEmailContext) return false;
  if (/(?:课程|文章|帖子|笔记|视频|直播)[^\n，。；;]{0,8}(?:主题|标题)/iu.test(`${before}${matchText}`)
    && !explicitEmailContext) return false;
  return true;
}

function normalizeSubjectComparison(value) {
  return cleanRule(value).replace(/\s+/gu, '').toLocaleLowerCase();
}

function cleanSubjectTemplate(value) {
  return cleanRule(value)
    .replace(/^(?:请按|请以|此格式填写)\s*[：:]?\s*/u, '')
    .replace(/年级[（(](?:研|大)\s*\d(?:\s*[/／]\s*(?:研|大)\s*\d)?[）)]/gu, '年级')
    .replace(/[（(](?:如|例如|写|填写)[^）)]*[）)]/gu, '')
    .replace(/[，,]\s*(?:例如|示例|例)\s*[：:].*$/u, '')
    .replace(/\s+(?:tips?|提示|注意|请在正文|如不满足|投递(?:方式|邮箱)?|联系方式|邮箱|简历(?:格式|要求)?|入职会|有意者|合适(?:者|会)|亲测|二编|补充|正文需要).*$/iu, '')
    .replace(/[，,；;]\s*(?:需附|需要|请附|请提供|简历|作品集|投递|联系方式|邮箱).*$/iu, '')
    .replace(/\s+(?:mentor|老板|有意向|有问题|有任何问题|感兴趣|实习薪资|急招|欢迎|0实习|优先|from|ps\s*[：:]|本人实习|实习生会|不符合要求|收简历|大家尽快|工作地点|薪资).*$/iu, '')
    .replace(/\s*(?:\*|＊)?\s*以上岗位.*$/iu, '')
    .replace(/(?:📮|📩|📬).*$/u, '')
    .replace(/[❗‼⚠].*$/u, '')
    .replace(/\s+[·•].*$/u, '')
    .replace(/\s+(?:[·•]\s*)?(?:【(?:其他要求|投递方式|联系方式)】|邮箱|联系方式|投递方式).*$/iu, '')
    .replace(/\s+(?:[⚠️📍💰]|今年|因为|由于|收到|若|如有|需要|需附|需提供|请注意|不要).*$/iu, '')
    .replace(/(?:#|＃).*$/u, '')
    .replace(/\s+[（(](?:例|例如|如|苯人|本人|我)[^）)]*[）)]/gu, '')
    .replace(/\s+(?=(?:帖子|投递(?:邮箱|方式)|邮箱|简历(?:请|投)|发送至)).*$/u, '')
    .replace(/\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}.*$/iu, '')
    .replace(/\s*(?:进行命名|作为)?\s*$/u, '')
    .replace(/为$/u, '')
    .replace(/~$/u, '')
    .replace(/^[（(]+/u, '')
    .replace(/[）)]$/u, '')
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
