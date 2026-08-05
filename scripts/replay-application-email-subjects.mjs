import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  applicationSubjectRule,
  resolveApplicationEmailSubject,
} from '../server/lib/application-email-draft.mjs';

const dataDir = path.resolve(process.argv[2] || 'data');
const currentProfileArtifact = path.resolve(
  process.argv[3] || 'data/test-runs/real-application-20260804-pdf/application_intelligence.json',
);
const candidateProfileFile = path.resolve(process.argv[4] || 'profiles/candidate_profile.json');

const files = await findFiles(dataDir, 'application_intelligence.json');
const uniqueRecords = new Map();
let rawRecords = 0;
let invalidFiles = 0;

for (const file of files.sort()) {
  try {
    const payload = JSON.parse(await readFile(file, 'utf8'));
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const snapshotCandidate = objectOrEmpty(payload?.profile_snapshot?.candidate);
    rawRecords += records.length;
    records.forEach((record, index) => {
      const noteId = String(record?.note_id || record?.noteId || record?.id || '').trim();
      uniqueRecords.set(noteId || `${file}#${index}`, { file, record, snapshotCandidate });
    });
  } catch {
    invalidFiles += 1;
  }
}

const currentPayload = JSON.parse(await readFile(currentProfileArtifact, 'utf8'));
const currentProfileDocument = JSON.parse(await readFile(candidateProfileFile, 'utf8'));
const currentCandidate = {
  ...objectOrEmpty(currentPayload?.profile_snapshot?.candidate),
  phone: String(currentProfileDocument?.candidate?.contact?.phone || '').trim(),
  education: Array.isArray(currentProfileDocument?.education) ? currentProfileDocument.education : [],
  undergraduateEducation: educationSummary(currentProfileDocument?.education, /(?:本科|学士)/u),
  graduateEducation: educationSummary(currentProfileDocument?.education, /(?:硕士|研究生)/u),
  aiProductExperience: Array.isArray(currentPayload?.profile_snapshot?.evidence)
    && currentPayload.profile_snapshot.evidence.some((item) => /AI产品|AI Agent|AI应用/u.test(String(item?.category || '')))
    ? '有'
    : '',
  relevantExperience: Array.isArray(currentPayload?.profile_snapshot?.evidence)
    && currentPayload.profile_snapshot.evidence.some((item) => /数据分析|产品|用户洞察/u.test(String(item?.category || '')))
    ? '有数据分析与产品策略经验'
    : '',
};

const stats = {
  files: files.length,
  invalidFiles,
  rawRecords,
  uniqueRecords: uniqueRecords.size,
  detectedRules: 0,
  fieldRules: 0,
  literalRules: 0,
  persistedProfileComplete: 0,
  currentProfileComplete: 0,
  currentProfileMissing: 0,
  suspiciousLiteralRules: 0,
  narrativeTailRules: 0,
  residualPlaceholderRules: 0,
};
const fieldFrequency = {};
const missingFieldFrequency = {};
const samples = [];
const unresolvedSamples = [];
const suspiciousSamples = [];
const copyAudit = {
  records: 0,
  outreachRecords: 0,
  outreachMissing: 0,
  coverLetterMinCharsPass: 0,
  aiProductRecords: 0,
  aiMechanismPass: 0,
  roleMappingRecords: 0,
  attachmentClaimRecords: 0,
};
const coverLengths = [];

for (const { file, record, snapshotCandidate } of uniqueRecords.values()) {
  copyAudit.records += 1;
  const outreach = objectOrEmpty(record?.outreach);
  if (Object.keys(outreach).length) copyAudit.outreachRecords += 1;
  else copyAudit.outreachMissing += 1;
  const cover = String(outreach.cover_letter || '');
  const coverChars = cover.replace(/\s+/gu, '').length;
  if (cover) coverLengths.push(coverChars);
  if (coverChars >= 800) copyAudit.coverLetterMinCharsPass += 1;
  if (Array.isArray(outreach.requirement_matches) && outreach.requirement_matches.length) {
    copyAudit.roleMappingRecords += 1;
  }
  if (/(?:简历随信附上|附件已附|见附件)/u.test(String(outreach.email_body || ''))) {
    copyAudit.attachmentClaimRecords += 1;
  }
  const applicationInfo = objectOrEmpty(record?.application_info);
  const roleTarget = [
    record?.title,
    record?.job_card?.role_name,
    ...(Array.isArray(applicationInfo.responsibilities) ? applicationInfo.responsibilities.map((item) => item?.text) : []),
    ...(Array.isArray(applicationInfo.requirements) ? applicationInfo.requirements.map((item) => item?.text) : []),
  ].filter(Boolean).join(' ');
  const aiRole = /(?:AI\s*产品|AI\s*策略|chatbot|大模型|\bAgent\b|智能体)/iu.test(roleTarget);
  if (aiRole) {
    copyAudit.aiProductRecords += 1;
    const aiMechanismPass = [
      /query|反馈/iu,
      /场景|分类/iu,
      /案例库|评测集|策略/iu,
      /指标|验证|复盘/iu,
      /迭代|回写|优化/iu,
    ].every((pattern) => pattern.test(cover));
    if (aiMechanismPass) copyAudit.aiMechanismPass += 1;
  }
  const rule = applicationSubjectRule(record);
  if (!rule.detected) continue;
  stats.detectedRules += 1;
  if (rule.fields.length) stats.fieldRules += 1;
  else stats.literalRules += 1;
  for (const field of rule.fields) fieldFrequency[field] = (fieldFrequency[field] || 0) + 1;

  const recordWithSnapshot = Object.keys(snapshotCandidate).length && !record?.candidate_profile
    ? { ...record, candidate_profile: snapshotCandidate }
    : record;
  const suppliedSubject = String(record?.outreach?.email_subject || '').trim();
  const persisted = resolveApplicationEmailSubject(recordWithSnapshot, suppliedSubject);
  const current = resolveApplicationEmailSubject(recordWithSnapshot, suppliedSubject, {
    candidateName: currentCandidate.name,
    school: currentCandidate.school,
    major: currentCandidate.major,
    degreeYear: currentCandidate.degreeYear,
    availabilityDays: currentCandidate.availabilityDays,
    internshipDuration: currentCandidate.internshipDuration,
    undergraduateEducation: currentCandidate.undergraduateEducation,
    graduateEducation: currentCandidate.graduateEducation,
    phone: currentCandidate.phone,
    aiProductExperience: currentCandidate.aiProductExperience,
    relevantExperience: currentCandidate.relevantExperience,
  });

  if (persisted.missingFields.length === 0) stats.persistedProfileComplete += 1;
  if (current.missingFields.length === 0) stats.currentProfileComplete += 1;
  else {
    stats.currentProfileMissing += 1;
    for (const field of current.missingFields) {
      missingFieldFrequency[field] = (missingFieldFrequency[field] || 0) + 1;
    }
    if (unresolvedSamples.length < 12) {
      unresolvedSamples.push(sample(file, record, rule, current));
    }
  }

  const suspiciousLiteral = rule.fields.length === 0
    && /(?:姓名|学校|院校|年级|届数|到岗|入职|实习|每周|手机号|电话|岗位|职位)/u.test(rule.template);
  if (suspiciousLiteral) stats.suspiciousLiteralRules += 1;
  const narrativeTail = rule.template.length > 100
    || /(?:有意向|有问题|作品集|投递邮箱|工作地点|合适会|课程主题|许愿)/u.test(rule.template);
  const residualPlaceholder = /(?:可实习时间|一周实习几天|可实习[Xx]月|本科学校专业|硕士学校专业|此格式填写|以上岗位|(^|[-+｜])时长($|[-+｜]))/u.test(current.subject);
  if (narrativeTail) stats.narrativeTailRules += 1;
  if (residualPlaceholder) stats.residualPlaceholderRules += 1;
  if ((suspiciousLiteral || narrativeTail || residualPlaceholder) && suspiciousSamples.length < 12) {
    suspiciousSamples.push(sample(file, record, rule, current));
  }
  if (samples.length < 12) samples.push(sample(file, record, rule, current));
}

const targetRecord = currentPayload?.records?.[0] || {};
const targetResolution = resolveApplicationEmailSubject(
  { ...targetRecord, candidate_profile: currentCandidate },
  targetRecord?.outreach?.email_subject,
  currentCandidate,
);

console.log(JSON.stringify({
  stats,
  copyAudit: {
    ...copyAudit,
    coverLetterChars: summarizeNumbers(coverLengths),
    coverLetterMinPassRate: coverAuditRate(copyAudit.coverLetterMinCharsPass, copyAudit.records),
    aiMechanismPassRate: coverAuditRate(copyAudit.aiMechanismPass, copyAudit.aiProductRecords),
  },
  fieldFrequency: sortObject(fieldFrequency),
  missingFieldFrequency: sortObject(missingFieldFrequency),
  currentProfile: {
    name: currentCandidate.name,
    school: currentCandidate.school,
    major: currentCandidate.major,
    degreeYear: currentCandidate.degreeYear,
    availabilityDays: currentCandidate.availabilityDays,
    internshipDuration: currentCandidate.internshipDuration,
    phonePresent: Boolean(currentCandidate.phone),
    undergraduateEducationPresent: Boolean(currentCandidate.undergraduateEducation),
    graduateEducationPresent: Boolean(currentCandidate.graduateEducation),
    aiProductExperience: currentCandidate.aiProductExperience,
    relevantExperiencePresent: Boolean(currentCandidate.relevantExperience),
  },
  targetReplay: {
    noteId: targetRecord?.note_id,
    detected: targetResolution.rule.detected,
    suppliedSubject: targetRecord?.outreach?.email_subject,
    resolvedSubject: targetResolution.subject,
    status: targetResolution.validation.status,
    missingFields: targetResolution.missingFields,
  },
  samples,
  unresolvedSamples,
  suspiciousSamples,
}, null, 2));

async function findFiles(directory, filename) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await findFiles(fullPath, filename));
    else if (entry.name === filename) output.push(fullPath);
  }
  return output;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sample(file, record, rule, resolution) {
  return {
    file: path.relative(process.cwd(), file),
    noteId: String(record?.note_id || record?.noteId || record?.id || ''),
    title: String(record?.title || ''),
    template: rule.template,
    fields: rule.fields,
    subject: resolution.subject,
    missingFields: resolution.missingFields,
  };
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort((left, right) => right[1] - left[1]));
}

function educationSummary(education, degreePattern) {
  if (!Array.isArray(education)) return '';
  const item = education.find((entry) => degreePattern.test(String(entry?.degree || entry?.level || '')));
  return [item?.institution || item?.school, item?.field || item?.major]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('');
}

function summarizeNumbers(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(0.5),
    p90: percentile(0.9),
  };
}

function coverAuditRate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 1;
}
