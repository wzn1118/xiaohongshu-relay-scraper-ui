import { createHash } from 'node:crypto';
import {
  applicationSubjectGuard,
  resolveApplicationEmailSubject,
} from './lib/application-email-draft.mjs';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const INTERNAL_COVER_LETTER_TOKEN = /(?<![\w])(?:exp|resume|evidence)[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}(?![\w])/i;
export const DEFAULT_APPLICATION_DELIVERY_CANDIDATE_LIMIT = 50;
export const MAX_APPLICATION_DELIVERY_CANDIDATE_LIMIT = 100;
const FILTER_FIELDS = Object.freeze([
  'deliveryStatus',
  'recipientStatus',
  'recipientSource',
  'copyStatus',
  'subjectRuleStatus',
  'attachmentStatus',
  'readiness',
]);

export class ApplicationDeliveryCandidateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationDeliveryCandidateError';
    this.code = code;
    this.status = status;
  }
}

export function buildApplicationDeliveryCandidates({
  jobId,
  records = [],
  batches = [],
  query = {},
  limit = DEFAULT_APPLICATION_DELIVERY_CANDIDATE_LIMIT,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const latestBatchItems = latestBatchItemsByNoteId(batches, normalizedQuery.batchId);
  // Every delivery surface receives the same resolved subject view. The
  // persisted draft remains available to the audit trail, while UI/preflight
  // consumers never render a stale social-post title as the send subject.
  const classified = records
    .map(withResolvedApplicationSubject)
    .map((record) => classifyCandidate(record, latestBatchItems.get(noteIdOf(record))));
  const searched = normalizedQuery.q
    ? classified.filter((entry) => candidateSearchText(entry).includes(normalizedQuery.q))
    : classified;
  const facetCounts = buildFacetCounts(searched);
  const filtered = searched.filter((entry) => FILTER_FIELDS.every((field) => (
    !normalizedQuery[field].length || normalizedQuery[field].includes(String(entry.summary[field] || ''))
  ))).filter((entry) => (
    normalizedQuery.hasCoverLetter === null
      || entry.summary.hasCoverLetter === normalizedQuery.hasCoverLetter
  ));
  const sorted = sortCandidates(filtered, normalizedQuery.sort);
  const queryHash = hashJson({ ...normalizedQuery, cursor: undefined });
  const revisions = sorted.map((entry) => ({
    noteId: entry.summary.noteId,
    revision: entry.summary.sourceRevision,
  }));
  const snapshotState = sorted.map(selectionSnapshotState);
  const selectionSnapshotHash = hashJson({ jobId: String(jobId || ''), queryHash, snapshotState });
  const offset = decodeCursor(normalizedQuery.cursor, queryHash, selectionSnapshotHash);
  const safeLimit = normalizeApplicationDeliveryCandidateLimit(limit);
  const page = sorted.slice(offset, offset + safeLimit);
  const nextOffset = offset + page.length;
  const selectableNoteIds = sorted
    .filter((entry) => isSelectableCandidateSummary(entry.summary))
    .map((entry) => entry.summary.noteId);
  const readyNoteIds = sorted
    .filter((entry) => entry.summary.readiness === 'ready_to_preview' && isSelectableCandidateSummary(entry.summary))
    .map((entry) => entry.summary.noteId);

  return {
    schemaVersion: 2,
    available: true,
    jobId: String(jobId || ''),
    total: sorted.length,
    offset,
    limit: safeLimit,
    cursor: normalizedQuery.cursor || null,
    nextCursor: nextOffset < sorted.length ? encodeCursor(nextOffset, queryHash, selectionSnapshotHash) : null,
    items: page.map((entry) => ({ ...entry.record, deliveryManifestSummary: entry.summary })),
    filters: publicQuery(normalizedQuery),
    facetCounts,
    blockerCounts: countValues(searched.flatMap((entry) => entry.summary.blockers.map((item) => item.code))),
    selectionSnapshot: {
      schemaVersion: 1,
      selectionSnapshotId: `selection_${selectionSnapshotHash.slice(0, 24)}`,
      selectionSnapshotHash,
      queryHash,
      candidateCount: sorted.length,
      noteIds: sorted.map((entry) => entry.summary.noteId),
      selectableNoteIds,
      readyNoteIds,
      revisions,
    },
  };
}

export function normalizeApplicationDeliveryCandidateLimit(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_APPLICATION_DELIVERY_CANDIDATE_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_APPLICATION_DELIVERY_CANDIDATE_LIMIT;
  return Math.min(MAX_APPLICATION_DELIVERY_CANDIDATE_LIMIT, Math.max(1, parsed));
}

export function withResolvedApplicationSubject(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const resolution = resolveApplicationEmailSubject(record, record?.outreach?.email_subject);
  return {
    ...record,
    outreach: {
      ...(record.outreach && typeof record.outreach === 'object' ? record.outreach : {}),
      email_subject: resolution.subject,
    },
    emailSubjectPreview: resolution.subject,
    emailSubjectGuard: resolution.subjectGuard,
    emailSubjectRequirement: {
      ...(record.emailSubjectRequirement && typeof record.emailSubjectRequirement === 'object' ? record.emailSubjectRequirement : {}),
      detected: resolution.rule.detected,
      template: resolution.rule.template,
      evidence: resolution.rule.evidence,
      fields: resolution.rule.fields,
      source: resolution.rule.source,
      ...(resolution.rule.attachmentTemplate
        ? { attachmentTemplate: resolution.rule.attachmentTemplate }
        : {}),
      ...(resolution.rule.literal ? { literal: true } : {}),
    },
  };
}

function isSelectableCandidateSummary(summary) {
  return summary?.readiness !== 'completed'
    && !['sent', 'skipped', 'sending', 'frozen'].includes(String(summary?.deliveryStatus || ''));
}

export function applicationDeliveryCandidateRevision(record) {
  return hashJson(applicationDeliveryCandidateRevisionInput(record, true));
}

export function applicationDeliveryCandidateContentRevision(record) {
  return hashJson(applicationDeliveryCandidateRevisionInput(record, false));
}

function applicationDeliveryCandidateRevisionInput(record, includeDeliveryUpdatedAt) {
  const discovery = record?.contactDiscovery || {};
  return {
    noteId: noteIdOf(record),
    collectedAt: record?.collected_at || '',
    publishTime: record?.publish_time?.value || record?.publish_time?.raw || '',
    title: record?.title || '',
    body: record?.body || '',
    draft: record?.draftVersion || null,
    outreach: {
      // Keep the persisted value in the revision so an edited stale subject
      // invalidates an earlier Dry Run. Public delivery views are normalized
      // separately by withResolvedApplicationSubject().
      subject: record?.outreach?.email_subject || '',
      body: record?.outreach?.email_body || '',
      coverLetter: record?.outreach?.cover_letter || '',
      quality: record?.outreach?.content_quality || null,
    },
    ...(includeDeliveryUpdatedAt ? { deliveryUpdatedAt: record?.delivery?.updatedAt || '' } : {}),
    contactEvidence: (Array.isArray(discovery.candidates) ? discovery.candidates : [])
      .map((candidate) => [candidate.address, candidate.evidenceHash, candidate.verificationStatus]),
    subjectRequirement: record?.emailSubjectRequirement || null,
    attachmentRequirement: record?.attachmentRequirement || null,
  };
}

function classifyCandidate(record, latestBatch) {
  const noteId = noteIdOf(record);
  const recipient = classifyRecipient(record);
  const copyStatus = classifyCopy(record);
  const subjectRuleStatus = classifySubject(record);
  const attachmentStatus = classifyAttachment(record, latestBatch);
  const deliveryStatus = classifyDelivery(record, latestBatch, recipient, copyStatus, subjectRuleStatus);
  const blockers = [];
  if (recipient.status === 'missing') blockers.push(blocker('NO_RECIPIENT', 'recipient', '未找到可用收件邮箱'));
  if (recipient.status === 'multiple_candidates' || recipient.status === 'needs_review') {
    blockers.push(blocker('RECIPIENT_REVIEW_REQUIRED', 'recipient', '收件邮箱需要人工确认'));
  }
  if (copyStatus === 'missing_email_body') blockers.push(blocker('EMAIL_BODY_REQUIRED', 'content.emailBody', '缺少邮件正文'));
  if (copyStatus === 'missing_cover_letter') blockers.push(blocker('COVER_LETTER_REQUIRED', 'content.coverLetter', '缺少 Cover Letter'));
  if (copyStatus === 'quality_failed') blockers.push(blocker('COPY_QUALITY_FAILED', 'content.quality', '投递文案未通过质量门禁'));
  if (subjectRuleStatus === 'needs_input') blockers.push(blocker('SUBJECT_REVIEW_REQUIRED', 'subject', '邮件标题规则需要补充或确认'));
  if (['failed', 'unknown'].includes(deliveryStatus)) blockers.push(blocker('DELIVERY_REVIEW_REQUIRED', 'delivery', '历史投递结果需要处理'));
  const readiness = blockers.length === 0 && deliveryStatus !== 'sent' && deliveryStatus !== 'skipped'
    ? 'ready_to_preview'
    : deliveryStatus === 'sent' || deliveryStatus === 'skipped'
      ? 'completed'
      : 'needs_input';
  return {
    record,
    selectionBatchRevision: latestBatch ? {
      batchId: latestBatch.batchId,
      batchStatus: latestBatch.batchStatus,
      batchRevision: latestBatch.batchRevision,
      itemId: latestBatch.item?.itemId,
      itemStatus: latestBatch.item?.status,
      itemRevision: normalizedRevision(latestBatch.item?.revision),
    } : null,
    summary: {
      schemaVersion: 2,
      noteId,
      sourceRevision: applicationDeliveryCandidateRevision(record),
      deliveryStatus,
      recipientStatus: recipient.status,
      recipientSource: recipient.source,
      copyStatus,
      subjectRuleStatus,
      attachmentStatus,
      readiness,
      hasEmailBody: Boolean(String(record?.outreach?.email_body || '').trim()),
      hasCoverLetter: Boolean(String(record?.outreach?.cover_letter || '').trim()),
      recipient: recipient.address ? {
        address: recipient.address,
        normalizedAddress: recipient.address.toLowerCase(),
        source: recipient.source,
        evidenceHash: recipient.evidenceHash || '',
        verificationStatus: recipient.verificationStatus || '',
      } : null,
      latestBatch: latestBatch ? {
        batchId: latestBatch.batchId,
        batchStatus: latestBatch.batchStatus,
        itemId: latestBatch.item?.itemId,
        itemStatus: latestBatch.item?.status,
        updatedAt: latestBatch.updatedAt,
      } : null,
      blockers,
      warnings: attachmentStatus === 'planned_rename'
        ? [{ code: 'WILL_RENAME', field: 'attachments', message: '冻结时将使用岗位要求或批次模板生成发送文件名' }]
        : [],
    },
  };
}

function classifyRecipient(record) {
  const discovery = record?.contactDiscovery || {};
  const candidates = (Array.isArray(discovery.candidates) ? discovery.candidates : [])
    .filter((candidate) => candidate?.actionable !== false && EMAIL.test(String(candidate?.address || '')));
  if (candidates.length > 1 || discovery.requiresReview === true) {
    const selected = candidates[0] || {};
    return {
      status: candidates.length > 1 ? 'multiple_candidates' : 'needs_review',
      address: String(selected.address || '').toLowerCase(),
      source: normalizeRecipientSource(selected.source),
      evidenceHash: selected.evidenceHash,
      verificationStatus: selected.verificationStatus,
    };
  }
  if (candidates.length === 1) {
    const selected = candidates[0];
    return {
      status: selected.verificationStatus === 'manual_confirmed' ? 'manual_confirmed' : 'resolved',
      address: String(selected.address).toLowerCase(),
      source: normalizeRecipientSource(selected.source),
      evidenceHash: selected.evidenceHash,
      verificationStatus: selected.verificationStatus,
    };
  }
  const routes = [
    ...(Array.isArray(record?.application_info?.contacts) ? record.application_info.contacts : []),
    ...(Array.isArray(record?.application_info?.application_routes) ? record.application_info.application_routes : []),
  ];
  for (const route of routes) {
    if (route?.actionable === false) continue;
    const match = `${route?.value || ''}\n${route?.evidence || ''}`.match(EMAIL);
    if (!match) continue;
    const sourceFields = [...(Array.isArray(route?.source_fields) ? route.source_fields : []), route?.source_field]
      .map((field) => String(field || '').toLowerCase());
    return {
      status: 'resolved',
      address: match[0].toLowerCase(),
      source: sourceFields.some((field) => field.includes('image')) ? 'ocr' : 'body',
      verificationStatus: String(route?.verification_status || ''),
    };
  }
  return { status: 'missing', address: '', source: 'none' };
}

function classifyCopy(record) {
  if (!String(record?.outreach?.email_body || '').trim()) return 'missing_email_body';
  if (!String(record?.outreach?.cover_letter || '').trim()) return 'missing_cover_letter';
  const coverLetter = String(record?.outreach?.cover_letter || '').trim();
  const contentQuality = record?.outreach?.content_quality;
  if (
    contentQuality?.batch_ready === false
    || record?.draftVersion?.qualityStatus === 'failed'
    || INTERNAL_COVER_LETTER_TOKEN.test(coverLetter)
    || typeof contentQuality?.cover_letter_chars === 'number' && contentQuality.cover_letter_chars < 800
  ) return 'quality_failed';
  if (record?.draftVersion?.qualityStatus === 'passed') return 'passed';
  return 'pending';
}

function classifySubject(record) {
  const subject = String(record?.outreach?.email_subject || '').trim();
  const subjectGuard = record?.emailSubjectGuard || applicationSubjectGuard(record, subject);
  if (!subject
    || subjectGuard.requiresReview
    || ['rejected_noisy_title', 'rejected_bare_title', 'rejected_unverified_subject'].includes(subjectGuard.sourceStatus)) {
    return 'needs_input';
  }
  if (record?.emailSubjectRequirement?.detected === true) return 'job_requirement_satisfied';
  return 'batch_default';
}

function classifyAttachment(record, latestBatch) {
  if (latestBatch && ['ready', 'approved', 'running', 'paused', 'completed'].includes(latestBatch.batchStatus)) return 'frozen';
  if (record?.attachmentRequirement?.detected === true) return 'planned_rename';
  return 'unchanged';
}

function classifyDelivery(record, latestBatch, recipient, copyStatus, subjectRuleStatus) {
  const itemStatus = String(latestBatch?.item?.status || '');
  if (itemStatus === 'sent' || record?.delivery?.action === 'email_sent' || record?.delivery?.email?.status === 'sent') return 'sent';
  if (itemStatus === 'skipped') return 'skipped';
  if (itemStatus === 'failed_retryable') return 'failed';
  if (itemStatus === 'unknown_manual_review') return 'unknown';
  if (itemStatus === 'sending') return 'sending';
  if (latestBatch && ['ready', 'approved', 'running', 'paused'].includes(latestBatch.batchStatus) && itemStatus === 'ready') return 'frozen';
  if (itemStatus.startsWith('blocked_') || itemStatus.endsWith('_pending') || itemStatus === 'copy_quality_failed') return 'needs_review';
  if (recipient.status === 'resolved' && copyStatus === 'passed' && subjectRuleStatus !== 'needs_input') return 'ready_to_preview';
  return 'unprepared';
}

function latestBatchItemsByNoteId(batches, batchId) {
  const map = new Map();
  const ordered = [...(Array.isArray(batches) ? batches : [])]
    .filter((batch) => !batchId || String(batch?.batchId || '') === batchId)
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  for (const batch of ordered) {
    for (const item of Array.isArray(batch?.items) ? batch.items : []) {
      const noteId = String(item?.noteId || '');
      if (!noteId || map.has(noteId)) continue;
      map.set(noteId, {
        batchId: String(batch.batchId || ''),
        batchStatus: String(batch.status || ''),
        batchRevision: normalizedRevision(batch.revision),
        updatedAt: String(item.updatedAt || batch.updatedAt || ''),
        item,
      });
    }
  }
  return map;
}

function normalizeQuery(query) {
  const normalized = {
    q: String(query?.q ?? query?.query ?? '').trim().toLocaleLowerCase('zh-CN').slice(0, 200),
    sort: ['oldest', 'readiness', 'title'].includes(query?.sort) ? query.sort : 'newest',
    cursor: String(query?.cursor || '').trim(),
    batchId: String(query?.batchId || '').trim(),
    hasCoverLetter: parseBoolean(query?.hasCoverLetter),
  };
  for (const field of FILTER_FIELDS) normalized[field] = parseValues(query?.[field]);
  return normalized;
}

function publicQuery(query) {
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'cursor'));
}

function parseValues(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(','))
    .map((item) => String(item || '').trim())
    .filter(Boolean))].sort();
}

function parseBoolean(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return null;
}

function sortCandidates(entries, sort) {
  const readinessRank = { ready_to_preview: 0, needs_input: 1, completed: 2 };
  return [...entries].sort((left, right) => {
    if (sort === 'title') {
      const compared = String(left.record?.title || '').localeCompare(String(right.record?.title || ''), 'zh-CN');
      if (compared) return compared;
    } else if (sort === 'readiness') {
      const compared = (readinessRank[left.summary.readiness] ?? 9) - (readinessRank[right.summary.readiness] ?? 9);
      if (compared) return compared;
    } else {
      const leftTime = candidateTimestamp(left.record);
      const rightTime = candidateTimestamp(right.record);
      if (leftTime !== rightTime) return sort === 'oldest' ? leftTime - rightTime : rightTime - leftTime;
    }
    return left.summary.noteId.localeCompare(right.summary.noteId);
  });
}

function candidateTimestamp(record) {
  const value = record?.publish_time?.value || record?.collected_at || record?.publish_time?.raw;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function candidateSearchText(entry) {
  const record = entry.record;
  const routes = [
    ...(Array.isArray(record?.application_info?.contacts) ? record.application_info.contacts : []),
    ...(Array.isArray(record?.application_info?.application_routes) ? record.application_info.application_routes : []),
  ];
  return [
    entry.summary.noteId,
    record?.title,
    record?.body,
    record?.job_card?.role_name,
    record?.job_card?.title,
    record?.outreach?.email_subject,
    record?.outreach?.email_body,
    record?.outreach?.cover_letter,
    ...(Array.isArray(record?.application_info?.responsibilities) ? record.application_info.responsibilities.flatMap((item) => [item?.text, item?.evidence]) : []),
    ...(Array.isArray(record?.application_info?.requirements) ? record.application_info.requirements.flatMap((item) => [item?.text, item?.evidence]) : []),
    entry.summary.recipient?.address,
    record?.emailSubjectRequirement?.evidence,
    record?.attachmentRequirement?.evidence,
    ...routes.flatMap((route) => [route?.value, route?.evidence]),
  ].map((value) => String(value || '')).join('\n').toLocaleLowerCase('zh-CN');
}

function buildFacetCounts(entries) {
  return Object.fromEntries(FILTER_FIELDS.map((field) => [
    field,
    countValues(entries.map((entry) => entry.summary[field])),
  ]));
}

function countValues(values) {
  const counts = {};
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (value) counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function normalizeRecipientSource(source) {
  return ({ image: 'ocr', author_comment: 'comment', other_comment: 'comment' })[source] || String(source || 'body');
}

function blocker(code, field, message) {
  return { code, field, message };
}

function noteIdOf(record) {
  return String(record?.note_id || record?.noteId || record?.post_id || record?.id || '');
}

function selectionSnapshotState(entry) {
  return {
    noteId: entry.summary.noteId,
    revision: hashJson({
      sourceRevision: entry.summary.sourceRevision,
      latestBatch: entry.selectionBatchRevision,
    }),
  };
}

function normalizedRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function encodeCursor(offset, queryHash, selectionSnapshotHash) {
  return Buffer.from(JSON.stringify({ v: 2, offset, queryHash, selectionSnapshotHash }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, queryHash, selectionSnapshotHash) {
  if (!cursor) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ApplicationDeliveryCandidateError('APPLICATION_CANDIDATE_CURSOR_INVALID', '候选列表游标已失效，请从第一页重新加载。');
  }
  if (parsed?.v !== 2 || parsed?.queryHash !== queryHash || !Number.isSafeInteger(parsed?.offset) || parsed.offset < 0) {
    throw new ApplicationDeliveryCandidateError('APPLICATION_CANDIDATE_CURSOR_INVALID', '候选列表游标已失效，请从第一页重新加载。');
  }
  if (parsed.selectionSnapshotHash !== selectionSnapshotHash) {
    throw new ApplicationDeliveryCandidateError(
      'APPLICATION_CANDIDATE_CURSOR_STALE',
      '候选列表在翻页期间已更新，请从第一页重新加载。',
      409,
    );
  }
  return parsed.offset;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
