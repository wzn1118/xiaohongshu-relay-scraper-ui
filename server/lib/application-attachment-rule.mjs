import path from 'node:path';

export const DEFAULT_APPLICATION_ATTACHMENT_TEMPLATE = '{candidateName}-{jobTitle}-简历';
export const DEFAULT_APPLICATION_ATTACHMENT_MAX_BYTES = 180;
export const DEFAULT_APPLICATION_ATTACHMENT_EXTENSIONS = Object.freeze([
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
]);

const FIELD_DEFINITIONS = Object.freeze([
  {
    key: 'candidateName',
    labels: ['候选人姓名', '应聘人姓名', '求职者姓名', 'candidate name', 'candidateName', '姓名', '名字', 'name'],
  },
  {
    key: 'jobTitle',
    labels: ['应聘岗位', '投递岗位', '岗位名称', '职位名称', 'job title', 'jobTitle', '岗位', '职位', 'role'],
  },
  {
    key: 'company',
    labels: ['公司名称', 'company name', 'company', '公司'],
  },
  {
    key: 'school',
    labels: ['毕业院校', '学校名称', 'school name', 'university', '院校', '学校', 'school'],
  },
  {
    key: 'major',
    labels: ['所学专业', '专业名称', 'major', '专业'],
  },
  {
    key: 'degreeYear',
    labels: ['毕业年份', '毕业时间', '毕业日期', '毕业年月', '年级', '届别', 'graduation year', 'degreeYear'],
  },
  {
    key: 'availabilityDays',
    labels: [
      '每周实习天数',
      '每周到岗天数',
      '每周出勤天数',
      '一周到岗天数',
      '一周出勤天数',
      '周出勤天数',
      '周出勤x天',
      '一周n天',
      '一周几天',
      '每周几天',
      '可实习天数',
      'availability days',
      'availabilityDays',
    ],
  },
  {
    key: 'internshipDuration',
    labels: ['可实习时长', '实习时长', '实习周期', '实习月数', '实习n个月', 'internship duration', 'internshipDuration'],
  },
  {
    key: 'arrivalDate',
    labels: [
      '最早到岗时间',
      '最快到岗时间',
      '可到岗时间',
      '到岗日期',
      '到岗时间',
      '入职时间',
      'n月n日到岗',
      'arrival date',
      'arrivalDate',
    ],
  },
  {
    key: 'phone',
    labels: ['联系电话', '手机号码', '手机号', '联系方式', 'phone number', 'mobile', 'phone'],
  },
  {
    key: 'email',
    labels: ['电子邮箱', '邮箱', 'email address', 'email'],
  },
]);

const FIELD_BY_KEY = new Map(FIELD_DEFINITIONS.map((field) => [field.key.toLowerCase(), field]));
const FIELD_ALIASES = FIELD_DEFINITIONS
  .flatMap((field) => field.labels.map((label) => ({ field, label })))
  .sort((left, right) => right.label.length - left.label.length);
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const PLACEHOLDER = /\{\{?\s*([^{}]+?)\s*\}?\}|\[\s*([^\[\]]+?)\s*\]|<\s*([^<>]+?)\s*>|【\s*([^【】]+?)\s*】/gu;

const BRACKETED_ATTACHMENT_RULE_PATTERNS = Object.freeze([
  /请以\s*(?:【|\[)\s*([^】\]]{1,180})\s*(?:】|\])\s*为\s*(?:邮件|投递)?(?:标题|主题)\s*(?:和|及|与|、)\s*(?:(?:附件\s*)?简历|附件)(?:文件名称|文件名|命名|名称|文件)?/iu,
  /(?:(?:附件\s*)?简历|(?:简历\s*)?附件|附件)(?:文件)?\s*(?:重命名|改名|命名(?:格式)?|文件名(?:格式)?|名称|格式)\s*(?:要求|规范)?\s*(?:【|\[)\s*([^】\]]{1,180})\s*(?:】|\])/iu,
]);

const ATTACHMENT_RULE_PATTERNS = Object.freeze([
  /(?:请\s*)?(?:将|把)?\s*(?:(?:附件\s*)?简历|(?:简历\s*)?附件|附件)(?:文件)?\s*(?:请\s*)?(?:重命名|改名|命名(?:格式)?|文件名(?:格式)?|名称|格式)\s*(?:要求|规范)?\s*(?:(?:为|成|是|请按|应为|采用|使用|格式为)\s*|[:：=]\s*|[“"'「『]\s*)(?:[“"'「『]\s*)?([^。；;\n]{1,180})/iu,
  /(?:(?:附件\s*)?简历|(?:简历\s*)?附件)\s*(?:文件)?\s*(?:标题|名称)\s*(?:请\s*)?(?:备注|写|填写|注明)(?:在|为|成|上)?\s*(?:(?:为|成|是|请按|应为|采用|使用|格式为)\s*|[:：=]\s*|[“"'「『]\s*)(?:[“"'「『]\s*)?([^。；;\n]{1,180})/iu,
  /(?:简历(?:附件)?(?:文件)?(?:名称|文件名|命名|格式)|附件(?:简历)?(?:文件)?(?:名称|文件名|命名|格式)|(?:简历|附件)(?:文件)?名|文件名(?:称)?)\s*(?:要求|规范|格式)?\s*(?:(?:为|是|请按|应为|采用|使用|格式为)\s*|[:：=]\s*|[“"'「『]\s*)(?:[“"'「『]\s*)?([^。；;\n]{1,180})/iu,
  /(?:attachment|resume|cv)(?:\s+file)?\s+(?:filename|file name|name|naming format)\s*(?:must\s+be|should\s+be|is|format)?\s*[:=]?\s*[“"']?([^;\n]{1,180}?)(?=\.(?:\s|$)|$)/iu,
  /(?:name|rename)\s+(?:the\s+)?(?:attachment|resume|cv)(?:\s+file)?\s+(?:as|to|using)\s+[“"']?([^;\n]{1,180}?)(?=\.(?:\s|$)|$)/iu,
]);

/**
 * Resolve a recruitment post's attachment naming rule into a safe display name.
 * A non-ready result never exposes a partially rendered display name.
 */
export function buildApplicationAttachmentRule(record, input = {}) {
  const detectedRule = detectApplicationAttachmentRule(record);
  const detected = detectedRule.detected;
  const template = detected
    ? detectedRule.template
    : normalizedTemplate(input.defaultTemplate || DEFAULT_APPLICATION_ATTACHMENT_TEMPLATE);
  const evidence = detected ? detectedRule.evidence : '';
  const values = applicationValues(record, input);
  const fields = attachmentFields(template);
  const unknownFields = unknownPlaceholderFields(template);
  const missingFields = [
    ...fields.filter((key) => !values[key]),
    ...unknownFields,
  ];
  const extensionResult = originalExtension(input, input.allowedExtensions);

  if (missingFields.length) {
    return ruleResult({
      detected,
      template,
      evidence,
      fields,
      status: 'missing_fields',
      missingFields,
    });
  }
  if (!extensionResult.valid) {
    return ruleResult({
      detected,
      template,
      evidence,
      fields,
      status: 'invalid_extension',
      missingFields,
    });
  }

  const templateExtension = explicitTemplateExtension(template);
  if (templateExtension && templateExtension.toLowerCase() !== extensionResult.extension.toLowerCase()) {
    return ruleResult({
      detected,
      template,
      evidence,
      fields,
      status: 'extension_mismatch',
      missingFields,
    });
  }

  const withoutExtension = templateExtension
    ? template.slice(0, -templateExtension.length)
    : template;
  const rendered = renderTemplate(withoutExtension, values);
  const stem = safeFileStem(rendered);
  const maxBytes = normalizedMaxBytes(input.maxUtf8Bytes);
  const boundedStem = truncateUtf8(stem, maxBytes - Buffer.byteLength(extensionResult.extension, 'utf8'));
  const displayName = safeFileStem(boundedStem);
  if (!displayName || Buffer.byteLength(displayName + extensionResult.extension, 'utf8') > maxBytes) {
    return ruleResult({
      detected,
      template,
      evidence,
      fields,
      status: 'invalid_filename',
      missingFields,
    });
  }

  return ruleResult({
    detected,
    template,
    evidence,
    fields,
    status: 'ready',
    missingFields,
    displayName: `${displayName}${extensionResult.extension}`,
  });
}

export function detectApplicationAttachmentRule(record) {
  for (const segment of applicationSourceSegments(record)) {
    for (const pattern of BRACKETED_ATTACHMENT_RULE_PATTERNS) {
      const match = pattern.exec(segment);
      if (!match) continue;
      const template = normalizedTemplate(match[1]);
      if (!template) continue;
      return {
        detected: true,
        template,
        evidence: normalizedEvidence(match[0]),
        fields: attachmentFields(template),
      };
    }
    for (const pattern of ATTACHMENT_RULE_PATTERNS) {
      const match = pattern.exec(segment);
      if (!match) continue;
      const template = normalizedTemplate(match[1]);
      if (!template || isSubjectOnlyRule(template)) continue;
      return {
        detected: true,
        template,
        evidence: ruleEvidence(match, template),
        fields: attachmentFields(template),
      };
    }
  }
  return { detected: false, template: '', evidence: '', fields: [] };
}

function ruleResult({
  detected,
  template,
  evidence,
  fields,
  status,
  missingFields,
  displayName = '',
}) {
  return {
    detected,
    template,
    evidence,
    fields,
    status,
    missingFields: [...new Set(missingFields)],
    displayName,
  };
}

function applicationSourceSegments(record) {
  const requirements = Array.isArray(record?.application_info?.requirements)
    ? record.application_info.requirements
    : record?.application_info?.requirements
      ? [record.application_info.requirements]
      : [];
  const sources = [
    record?.body,
    record?.full_body,
    record?.source_card_text,
    record?.card_text_segments,
    record?.job_card?.source_excerpt,
    ...requirements.map((item) => {
      if (typeof item === 'string') return item;
      return firstString(item?.text, item?.evidence, item?.value, item?.requirement);
    }),
  ];
  return sources
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => String(value || '').split(/[\r\n；;]+/u))
    .map((value) => value.normalize('NFKC').trim().slice(0, 1_000))
    .filter(Boolean);
}

function normalizedTemplate(value) {
  let template = String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[”"'」』]+$/gu, '')
    .replace(/[＃#].*$/u, '')
    .replace(/\s*[【\[]\s*(?:(?:投递|应聘|简历)\s*)?(?:邮箱|邮件地址|email)[^】\]]*[】\]].*$/iu, '')
    .replace(/\s*[📮💌✉📧][\uFE0F\u20E3]?.*$/u, '')
    .replace(/\s+(?:简历(?:合适|通过|筛选)|(?:可以|可)(?:立刻|立即)?(?:直接)?(?:发|投递|发送)).*$/iu, '')
    .replace(/(?:\s+|[\p{Extended_Pictographic}\uFE0F]+)(?:(?:简历|投递)\s*)?(?:邮箱|邮件地址|email)\s*(?:[:：]|是)\s*.*$/iu, '')
    .replace(/[，,]\s*(?:(?:邮件|投递)(?:标题|主题)|email\s+subject)(?:格式|要求)?\s*[:：=]?.*$/iu, '')
    .replace(/[，,]\s*(?=(?:简历\s*)?(?:请\s*)?(?:发送|发|投递)|帖子不删|不删就是还在招|帖子还在|#).*$/iu, '')
    .replace(/\s+(?=(?:(?:邮件|投递)(?:标题|主题)|email\s+subject)(?:格式|要求)?\s*[:：=]).*$/iu, '')
    .replace(/[（(]\s*(?:务必|请|注意|示例|例如|如有).*$/iu, '')
    .replace(/\s+(?=(?:例如|示例|可以|可(?:立刻|立即)到岗|请|务必|记得|注意|优先|发送|投递|邮箱|邮件正文|正文|以下|发布于|编辑于|帖子不删|不删就是还在招|帖子还在|please\s+send)).*$/iu, '')
    .replace(/[，,]\s*(?:例如|示例|可以|可(?:立刻|立即)到岗|请|务必|记得|注意|优先|发送|投递|邮箱|邮件正文|正文|以下|发布于|编辑于|please\s+send).*$/iu, '')
    .replace(/^[\s:：=,，、】\]）)]+/u, '')
    .trim()
    .slice(0, 180);
  const wrapped = /^(?:【([^【】]+)】|\[([^\[\]]+)\])$/u.exec(template);
  if (wrapped) {
    const inner = firstString(wrapped[1], wrapped[2]);
    if (attachmentFields(inner).length) template = inner;
  }
  return template;
}

function normalizedEvidence(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function ruleEvidence(match, template) {
  const fullMatch = String(match?.[0] || '');
  const captured = String(match?.[1] || '');
  const captureIndex = captured ? fullMatch.indexOf(captured) : -1;
  if (captureIndex < 0) return normalizedEvidence(fullMatch);
  const prefix = fullMatch
    .slice(0, captureIndex)
    .replace(/[“"'「『]\s*$/u, '');
  return normalizedEvidence(`${prefix}${template}`);
}

function isSubjectOnlyRule(value) {
  return /^(?:邮件|投递)?(?:标题|主题)(?:格式|要求)?\s*[:：]/iu.test(value);
}

function attachmentFields(template) {
  const matches = [];
  for (const field of FIELD_DEFINITIONS) {
    const positions = [field.key, ...field.labels]
      .map((label) => aliasIndex(template, label))
      .filter((index) => index >= 0);
    if (positions.length) matches.push({ key: field.key, index: Math.min(...positions) });
  }
  return matches
    .sort((left, right) => left.index - right.index)
    .map((item) => item.key);
}

function aliasIndex(value, alias) {
  const source = String(value || '');
  if (/^[A-Za-z][A-Za-z0-9 ]*$/u.test(alias)) {
    const match = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(alias)}(?![A-Za-z0-9])`, 'iu').exec(source);
    return match ? match.index : -1;
  }
  return source.toLowerCase().indexOf(alias.toLowerCase());
}

function unknownPlaceholderFields(template) {
  const missing = [];
  for (const match of String(template || '').matchAll(new RegExp(PLACEHOLDER.source, PLACEHOLDER.flags))) {
    const token = firstString(match[1], match[2], match[3], match[4]).normalize('NFKC').trim();
    if (!token || fieldForAlias(token) || isStaticBracketLabel(match, token)) continue;
    missing.push(`unknown:${token}`);
  }
  return [...new Set(missing)];
}

function isStaticBracketLabel(match, token) {
  const bracketed = Boolean(match[2] || match[4]);
  return bracketed && /^[A-Za-z0-9_-]{1,40}(?:实习|招聘|校招|项目|计划)$/u.test(token);
}

function fieldForAlias(value) {
  const normalized = String(value || '').normalize('NFKC').trim();
  const byKey = FIELD_BY_KEY.get(normalized.toLowerCase());
  if (byKey) return byKey;
  return FIELD_DEFINITIONS.find((field) =>
    field.labels.some((label) => label.toLowerCase() === normalized.toLowerCase())) || null;
}

function applicationValues(record, input) {
  const supplied = input?.values && typeof input.values === 'object' ? input.values : {};
  const candidate = record?.candidate_profile || record?.candidateProfile || {};
  const application = candidate?.candidate_application || candidate?.candidateApplication || candidate;
  const raw = {
    candidateName: firstString(input.candidateName, supplied.candidateName, input.name, application?.name, candidate?.name),
    jobTitle: firstString(input.jobTitle, supplied.jobTitle, record?.job_card?.role_name, record?.job_card?.title, record?.title),
    company: firstString(input.company, supplied.company, record?.job_card?.company_name, record?.company_name, record?.company),
    school: firstString(input.school, supplied.school, application?.school, candidate?.school),
    major: firstString(input.major, supplied.major, application?.major, candidate?.major),
    degreeYear: firstString(input.degreeYear, supplied.degreeYear, application?.degreeYear, application?.graduationYear),
    availabilityDays: firstString(input.availabilityDays, supplied.availabilityDays, application?.availabilityDays),
    internshipDuration: firstString(input.internshipDuration, supplied.internshipDuration, application?.internshipDuration),
    arrivalDate: firstString(input.arrivalDate, supplied.arrivalDate, application?.arrivalDate, application?.availableFrom),
    phone: firstString(
      input.phone,
      supplied.phone,
      input.phoneWeChat,
      supplied.phoneWeChat,
      application?.phone,
      application?.phoneWeChat,
      application?.mobile,
      candidate?.phone,
      candidate?.phoneWeChat,
      candidate?.mobile,
    ),
    email: firstString(input.email, supplied.email, application?.email, candidate?.email),
  };
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, normalizedFieldValue(value)]));
}

function normalizedFieldValue(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
}

function renderTemplate(template, values) {
  const protectedValues = [];
  const protect = (value) => {
    const token = `\uE000${protectedValues.length}\uE001`;
    protectedValues.push(String(value));
    return token;
  };
  let rendered = String(template || '').replace(
    new RegExp(PLACEHOLDER.source, PLACEHOLDER.flags),
    (match, first, second, third, fourth) => {
      const field = fieldForAlias(firstString(first, second, third, fourth));
      return field ? protect(values[field.key]) : match;
    },
  );
  for (const { field, label } of FIELD_ALIASES) {
    const replacement = protect(values[field.key]);
    rendered = rendered.replace(aliasPattern(label), replacement);
  }
  return rendered.replace(/\uE000(\d+)\uE001/gu, (_, index) => protectedValues[Number(index)] || '');
}

function aliasPattern(alias) {
  const escaped = escapeRegExp(alias);
  return /^[A-Za-z][A-Za-z0-9 ]*$/u.test(alias)
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'giu')
    : new RegExp(escaped, 'gu');
}

function originalExtension(input, configuredExtensions) {
  const originalName = firstString(input.originalName, input.filename, input.displayName).normalize('NFKC').trim();
  if (
    !originalName
    || originalName !== path.basename(originalName)
    || originalName !== path.win32.basename(originalName)
    || /[\p{Cc}\p{Cf}<>:"/\\|?*]/u.test(originalName)
  ) {
    return { valid: false, extension: '' };
  }
  const extension = path.extname(originalName);
  const allowed = normalizedAllowedExtensions(configuredExtensions);
  if (!/^\.[A-Za-z0-9]{1,10}$/u.test(extension) || !allowed.has(extension.toLowerCase())) {
    return { valid: false, extension: '' };
  }
  return { valid: true, extension };
}

function normalizedAllowedExtensions(value) {
  const source = Array.isArray(value) && value.length
    ? value
    : DEFAULT_APPLICATION_ATTACHMENT_EXTENSIONS;
  return new Set(source.map((item) => {
    const extension = String(item || '').trim().toLowerCase();
    return extension.startsWith('.') ? extension : `.${extension}`;
  }).filter((item) => /^\.[a-z0-9]{1,10}$/u.test(item)));
}

function explicitTemplateExtension(template) {
  const match = /(\.[A-Za-z0-9]{1,10})\s*$/u.exec(String(template || ''));
  return match ? match[1] : '';
}

function safeFileStem(value) {
  let stem = String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\/\\]+/gu, '-')
    .replace(/[<>:"|?*]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/u, '')
    .trim();
  if (WINDOWS_RESERVED_NAME.test(stem)) stem = `_${stem}`;
  return stem;
}

function normalizedMaxBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_APPLICATION_ATTACHMENT_MAX_BYTES;
  return Math.max(1, Math.min(255, Math.trunc(parsed)));
}

function truncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  let output = '';
  let size = 0;
  for (const character of String(value || '')) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (size + bytes > maxBytes) break;
    output += character;
    size += bytes;
  }
  return output.replace(/[. ]+$/u, '');
}

function firstString(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
