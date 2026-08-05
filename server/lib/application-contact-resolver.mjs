import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const INVALID_VERIFICATION_STATUSES = new Set(['invalid', 'rejected', 'unverified']);
const COLLECTION_STATUS_RANK = Object.freeze({ pending: 0, partial: 1, complete: 2 });
const AUDIENCE_SNAPSHOT_CACHE_LIMIT = 8;
const audienceSnapshotCache = new Map();
const audienceSnapshotLoads = new Map();
const RECRUITMENT_CONTEXT = /(?:简历|投递|岗位|职位|招聘|应聘|申请|邮箱|邮件|发送|联系)/iu;
const EMAIL_MATCH = /(?<![A-Z0-9._%+*\-/])([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+)(?![A-Z0-9._%+*\-/])/giu;
const EMAIL_ROUTE_KIND = /(?:e-?mail|邮箱|邮件)/iu;
const KEYCAP_CHARACTER = /([0-9#*])\uFE0F?\u20E3/gu;
const ZERO_WIDTH_CHARACTER = /[\u200B-\u200D\u2060\uFEFF]/gu;
const EMAIL_ICON_CHARACTER = /(?<=[A-Z0-9._%+-])\s*(?:📧|✉|📨|📩|📤|📮|💌|(?:[\[【])?(?:邮箱|邮件)图标(?:[\]】])?)\s*(?=[A-Z0-9\u4E00-\u9FFF])/giu;
const CHINESE_DIGITS = Object.freeze({
  零: '0', 〇: '0', 洞: '0',
  一: '1', 幺: '1', 壹: '1',
  二: '2', 两: '2', 贰: '2',
  三: '3', 叁: '3',
  四: '4', 肆: '4',
  五: '5', 伍: '5',
  六: '6', 陆: '6',
  七: '7', 柒: '7',
  八: '8', 捌: '8',
  九: '9', 玖: '9',
});
const REDACTED_EMAIL_MATCHES = Object.freeze([
  /(?:[A-Z0-9._%+-]*[*＊•·]{2,}[A-Z0-9._%+-]*|[*＊•·]{2,})\s*[@＠]\s*[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu,
  /[A-Z0-9._%+-]+\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\s+at\s+)\s*[A-Z0-9-]+(?:\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\s+dot\s+)\s*[A-Z0-9-]+)+/giu,
  /[A-Z0-9._%+-]+@[A-Z0-9-]+\b(?!\s*\.)/giu,
  /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.(?:\*{2,}|[A-Z]{0,1})\b/giu,
]);

export async function resolveApplicationContacts(record, {
  outputDir = '',
  fallbackOutputDirs = [],
  audienceSnapshot = null,
} = {}) {
  const { noteId, postId } = applicationRecordIds(record);
  const primaryCandidates = applicationRecordCandidates(record, { noteId, postId });
  const recordRedactedEvidence = redactedEmailEvidence(applicationRecordEvidence(record));
  if (primaryCandidates.length) {
    return resolutionFromCandidates({
      noteId,
      postId,
      candidates: primaryCandidates,
      collectionStatus: 'complete',
      source: 'application_record',
    });
  }

  if (!postId) {
    if (recordRedactedEvidence.length) {
      return redactedContactResult({
        noteId,
        postId,
        collectionStatus: 'pending',
        evidence: recordRedactedEvidence,
      });
    }
    return unresolvedResult({
      noteId,
      postId,
      collectionStatus: 'pending',
      reason: 'post_id_missing',
    });
  }

  const audience = audienceSnapshot || await readAudienceArtifacts(outputDir, fallbackOutputDirs);
  const { comments: matchedComments, posts: matchedPosts } = audienceRecordsForPost(audience, postId);
  const collectionStatus = audienceCollectionStatus(matchedPosts, matchedComments);
  const redactedEvidence = uniqueStrings([
    ...recordRedactedEvidence,
    ...redactedEmailEvidence(matchedComments.map((comment) => comment.text ?? comment.content ?? comment.comment_content)),
  ]);

  if (audience.issues.length) {
    return {
      ...unresolvedResult({
        noteId,
        postId,
        collectionStatus,
        reason: 'audience_artifact_invalid',
        status: 'manual_review',
      }),
      issues: audience.issues,
    };
  }

  if (!audience.commentsArtifactFound) {
    return unresolvedResult({
      noteId,
      postId,
      collectionStatus: 'pending',
      reason: 'comments_unavailable',
    });
  }

  const authorIdentity = postAuthorIdentity(record, matchedPosts);
  const commentCandidates = commentEmailCandidates(matchedComments, {
    noteId,
    postId,
    collectionStatus,
    authorIdentity,
  });
  if (commentCandidates.length) {
    return resolutionFromCandidates({
      noteId,
      postId,
      candidates: commentCandidates,
      collectionStatus,
      source: 'comments',
      forceReview: true,
      reason: commentResolutionReason(commentCandidates, authorIdentity),
    });
  }

  if (redactedEvidence.length) {
    return redactedContactResult({ noteId, postId, collectionStatus, evidence: redactedEvidence });
  }

  if (collectionStatus !== 'complete') {
    return unresolvedResult({
      noteId,
      postId,
      collectionStatus,
      reason: collectionStatus === 'partial'
        ? 'comment_collection_incomplete'
        : 'comment_collection_pending',
    });
  }

  return unresolvedResult({
    noteId,
    postId,
    collectionStatus,
    reason: 'no_email_found',
    status: 'no_email',
  });
}

export async function resolveApplicationContactsBatch(records, {
  outputDir = '',
  fallbackOutputDirs = [],
} = {}) {
  const items = Array.isArray(records) ? records : [];
  const needsCommentFallback = items.some((record) => {
    const { noteId, postId } = applicationRecordIds(record);
    return Boolean(postId) && applicationRecordCandidates(record, { noteId, postId }).length === 0;
  });
  const audienceSnapshot = needsCommentFallback
    ? await readAudienceArtifacts(outputDir, fallbackOutputDirs)
    : null;
  return Promise.all(items.map((record) => (
    resolveApplicationContacts(record, audienceSnapshot ? { audienceSnapshot } : {})
  )));
}

export function applicationContactSourceRevision(candidate) {
  return sha256(JSON.stringify([
    'application-contact-source:v1',
    String(candidate?.noteId || ''),
    String(candidate?.postId || ''),
    String(candidate?.commentId || ''),
    String(candidate?.authorId || ''),
    String(candidate?.source || ''),
    String(candidate?.evidenceHash || ''),
    sha256(candidate?.evidenceText || ''),
    String(candidate?.collectionStatus || ''),
    String(candidate?.verificationStatus || ''),
  ]));
}

/**
 * Add deterministic, actionable email routes to a hydrated result record.
 * Persisted artifacts remain unchanged; this view-layer enrichment lets old
 * records benefit from the same resolver used by batch preflight.
 */
export function enrichApplicationRecordContacts(record) {
  if (!isRecord(record)) return record;
  const { noteId, postId } = applicationRecordIds(record);
  const candidates = applicationRecordCandidates(record, { noteId, postId })
    .filter((candidate) => candidate.actionable !== false);
  if (!candidates.length) return record;

  const applicationInfo = isRecord(record.application_info) ? record.application_info : {};
  const contacts = asRecords(applicationInfo.contacts);
  const routes = asRecords(applicationInfo.application_routes);
  const existingAddresses = new Set(
    [...contacts, ...routes].flatMap((route) => extractExactEmails(route.value)),
  );
  const generated = candidates
    .filter((candidate) => !existingAddresses.has(candidate.address))
    .map((candidate) => ({
      type: 'email',
      channel: 'email',
      value: candidate.address,
      evidence: candidate.evidenceText,
      confidence: candidate.confidence,
      source_field: candidate.source,
      source_fields: candidate.sourceFields,
      verification_status: candidate.verificationStatus,
      normalization_applied: candidate.normalizationApplied,
      evidence_hash: candidate.evidenceHash,
      source_revision: applicationContactSourceRevision(candidate),
      actionable: true,
    }));
  if (!generated.length) return record;
  return {
    ...record,
    application_info: {
      ...applicationInfo,
      contacts: [...contacts, ...generated],
      application_routes: routes,
    },
  };
}

function redactedContactResult({ noteId, postId, collectionStatus, evidence }) {
  return {
    ...unresolvedResult({
      noteId,
      postId,
      collectionStatus,
      reason: 'redacted_email_requires_review',
      status: 'manual_review',
    }),
    redactedEvidence: evidence.map((text) => ({
      evidenceText: text,
      evidenceHash: sha256(text),
    })),
  };
}

function applicationRecordEvidence(record) {
  const routes = [
    ...asRecords(record?.application_info?.contacts),
    ...asRecords(record?.application_info?.application_routes),
  ];
  return [
    ...bodyEvidenceValues(record),
    ...imageEvidenceValues(record),
    ...routes.flatMap((route) => [route.value, route.evidence]),
  ];
}

function redactedEmailEvidence(values) {
  const evidence = [];
  for (const value of values) {
    const text = cleanEvidence(value);
    if (!text || extractExactEmails(text).length) continue;
    const normalized = normalizeObfuscatedEmailText(text);
    if (REDACTED_EMAIL_MATCHES.some((pattern) => {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return true;
      pattern.lastIndex = 0;
      return pattern.test(normalized);
    })) evidence.push(text);
  }
  return uniqueStrings(evidence);
}

function applicationRecordCandidates(record, { noteId, postId }) {
  const routes = [
    ...asRecords(record?.application_info?.contacts),
    ...asRecords(record?.application_info?.application_routes),
  ];
  const candidates = [];
  const rejectedAddresses = new Set();

  for (const route of routes) {
    const verificationStatus = firstString(route.verification_status, route.verificationStatus).toLowerCase();
    if (route.actionable !== false && !INVALID_VERIFICATION_STATUSES.has(verificationStatus)) continue;
    for (const value of [route.value, route.evidence]) {
      for (const address of extractExactEmails(value)) rejectedAddresses.add(address);
    }
  }

  for (const route of routes) {
    if (route.actionable === false) continue;
    const verificationStatus = firstString(route.verification_status, route.verificationStatus).toLowerCase();
    if (INVALID_VERIFICATION_STATUSES.has(verificationStatus)) continue;
    const source = routeSource(route);
    const sourceTexts = [route.value, route.evidence].map(cleanEvidence).filter(Boolean);
    const valueAddresses = extractExactEmails(route.value);
    const routeKind = `${route.type || ''} ${route.channel || ''}`;
    if (!EMAIL_ROUTE_KIND.test(routeKind) && !valueAddresses.length) continue;
    for (const address of uniqueStrings(sourceTexts.flatMap(extractExactEmails))) {
      if (rejectedAddresses.has(address)) continue;
      const evidenceText = sourceTexts.find((text) => extractExactEmails(text).includes(address)) || address;
      const normalizationApplied = !extractLiteralEmails(evidenceText).includes(address);
      candidates.push(contactCandidate({
        address,
        source,
        noteId,
        postId,
        evidenceText,
        confidence: routeConfidence(route, source),
        verificationStatus: verificationStatus || normalizedVerificationStatus(source, normalizationApplied),
        actionable: true,
        sourceFields: routeSourceFields(route),
        normalizationApplied,
      }));
    }
  }

  for (const { source, evidenceText } of rawApplicationEvidence(record)) {
    for (const address of extractExactEmails(evidenceText)) {
      if (rejectedAddresses.has(address)) continue;
      const normalizationApplied = !extractLiteralEmails(evidenceText).includes(address);
      candidates.push(contactCandidate({
        address,
        source,
        noteId,
        postId,
        evidenceText,
        confidence: source === 'image' ? 80 : 90,
        verificationStatus: normalizedVerificationStatus(source, normalizationApplied),
        actionable: true,
        sourceFields: [source],
        normalizationApplied,
      }));
    }
  }
  return mergeCandidates(candidates);
}

function bodyEvidenceValues(record) {
  return flattenEvidenceValues([
    record?.body,
    record?.full_body,
    record?.source_card_text,
    record?.card_text_segments,
    record?.job_card?.source_excerpt,
  ]);
}

function imageEvidenceValues(record) {
  return flattenEvidenceValues([
    record?.media?.analysis?.visible_text,
    record?.media?.analysis?.ocr_text,
    record?.image_analysis?.visible_text,
    record?.image_analysis?.ocr_text,
    record?.ocr_text,
    record?.application_info?.image_analysis?.visible_text,
    record?.application_info?.image_analysis?.ocr_text,
    ...asRecords(record?.media?.images).flatMap((image) => [
      image.visible_text,
      image.ocr_text,
      image.analysis?.visible_text,
      image.analysis?.ocr_text,
    ]),
  ]);
}

function rawApplicationEvidence(record) {
  return [
    ...bodyEvidenceValues(record).map((evidenceText) => ({ source: 'body', evidenceText: focusEmailEvidence(evidenceText) })),
    ...imageEvidenceValues(record).map((evidenceText) => ({ source: 'image', evidenceText: focusEmailEvidence(evidenceText) })),
  ];
}

function flattenEvidenceValues(values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map(cleanEvidence)
    .filter(Boolean);
}

function normalizedVerificationStatus(source, normalizationApplied) {
  if (source === 'image') return normalizationApplied ? 'image_format_normalized' : 'image_format_verified';
  return normalizationApplied ? 'body_format_normalized' : 'body_verified';
}

function commentEmailCandidates(comments, {
  noteId,
  postId,
  collectionStatus,
  authorIdentity,
}) {
  const candidates = [];
  for (const comment of comments) {
    const evidenceText = cleanEvidence(comment.text ?? comment.content ?? comment.comment_content);
    const addresses = extractExactEmails(evidenceText);
    if (!addresses.length) continue;
    const authorId = commentAuthorId(comment);
    const isPostAuthor = Boolean(
      authorId
      && authorIdentity.id
      && !authorIdentity.ambiguous
      && authorId === authorIdentity.id,
    );
    const source = isPostAuthor ? 'author_comment' : 'other_comment';
    const hasRecruitmentContext = RECRUITMENT_CONTEXT.test(evidenceText);
    for (const address of addresses) {
      candidates.push(contactCandidate({
        address,
        source,
        noteId,
        postId,
        commentId: commentId(comment),
        authorId,
        evidenceText,
        confidence: commentConfidence({ isPostAuthor, hasRecruitmentContext }),
        collectionStatus,
        verificationStatus: 'needs_manual_review',
        actionable: false,
        normalizationApplied: !extractLiteralEmails(evidenceText).includes(address),
        ownershipStatus: isPostAuthor
          ? 'post_author_verified'
          : authorIdentity.ambiguous
            ? 'post_author_ambiguous'
            : authorIdentity.id
              ? 'third_party'
              : 'post_author_unknown',
      }));
    }
  }
  return mergeCandidates(candidates);
}

function resolutionFromCandidates({
  noteId,
  postId,
  candidates,
  collectionStatus,
  source,
  forceReview = false,
  reason = '',
}) {
  const multiple = candidates.length > 1;
  const requiresReview = forceReview || multiple || candidates.some((candidate) => candidate.requiresReview);
  const finalized = candidates.map((candidate) => ({
    ...candidate,
    collectionStatus,
    requiresReview: requiresReview || candidate.requiresReview,
  }));
  const status = requiresReview ? 'manual_review' : 'ready';
  return {
    schemaVersion: 1,
    noteId,
    postId,
    status,
    reason: reason || (
      multiple
        ? 'multiple_email_candidates'
        : requiresReview
          ? 'application_contact_requires_review'
          : 'resolved_from_application_record'
    ),
    source,
    collectionStatus,
    commentFallbackUsed: source === 'comments',
    requiresReview,
    selectedCandidate: status === 'ready' ? finalized[0] : null,
    candidates: finalized,
    issues: [],
  };
}

function unresolvedResult({ noteId, postId, collectionStatus, reason, status = 'pending' }) {
  return {
    schemaVersion: 1,
    noteId,
    postId,
    status,
    reason,
    source: 'none',
    collectionStatus,
    commentFallbackUsed: true,
    requiresReview: status === 'manual_review',
    selectedCandidate: null,
    candidates: [],
    issues: [],
  };
}

function contactCandidate({
  address,
  source,
  noteId,
  postId,
  commentId: sourceCommentId = '',
  authorId = '',
  evidenceText,
  confidence,
  collectionStatus = 'complete',
  verificationStatus,
  actionable,
  sourceFields = [source],
  ownershipStatus = 'not_applicable',
  normalizationApplied = false,
}) {
  const canonicalAddress = address.toLowerCase();
  const normalizedEvidence = cleanEvidence(evidenceText);
  return {
    address: canonicalAddress,
    source,
    noteId,
    postId,
    commentId: sourceCommentId,
    authorId,
    evidenceText: normalizedEvidence,
    evidenceHash: sha256(JSON.stringify({
      address: canonicalAddress,
      source,
      noteId,
      postId,
      commentId: sourceCommentId,
      authorId,
      evidenceText: normalizedEvidence,
    })),
    confidence: boundedConfidence(confidence),
    collectionStatus,
    verificationStatus,
    actionable,
    requiresReview: !actionable || verificationStatus === 'needs_manual_review',
    ownershipStatus,
    sourceFields: uniqueStrings(sourceFields),
    normalizationApplied: Boolean(normalizationApplied),
  };
}

function mergeCandidates(candidates) {
  const byAddress = new Map();
  for (const candidate of candidates) {
    const current = byAddress.get(candidate.address);
    if (!current) {
      byAddress.set(candidate.address, candidate);
      continue;
    }
    const preferred = candidatePriority(candidate) < candidatePriority(current) ? candidate : current;
    const secondary = preferred === candidate ? current : candidate;
    byAddress.set(candidate.address, {
      ...preferred,
      confidence: Math.max(preferred.confidence, secondary.confidence),
      sourceFields: uniqueStrings([...preferred.sourceFields, ...secondary.sourceFields]),
      normalizationApplied: preferred.normalizationApplied || secondary.normalizationApplied,
      verificationStatus: preferred.source !== secondary.source
        ? 'cross_verified'
        : preferred.verificationStatus,
    });
  }
  return [...byAddress.values()].sort((left, right) => (
    candidatePriority(left) - candidatePriority(right)
    || left.address.localeCompare(right.address)
  ));
}

function candidatePriority(candidate) {
  return ({ body: 0, image: 1, author_comment: 2, other_comment: 3 })[candidate.source] ?? 9;
}

function commentResolutionReason(candidates, authorIdentity) {
  if (candidates.length > 1) return 'multiple_comment_email_candidates';
  if (authorIdentity.ambiguous) return 'post_author_ambiguous';
  if (candidates[0]?.source === 'author_comment') return 'author_comment_requires_approval';
  return authorIdentity.id
    ? 'third_party_comment_requires_review'
    : 'post_author_unknown';
}

async function readAudienceArtifacts(outputDir, fallbackOutputDirs) {
  const directories = uniqueStrings([
    ...asStrings(fallbackOutputDirs),
    outputDir,
  ]).map((directory) => path.resolve(directory));
  const cacheKey = directories.join('\n');
  const signature = await audienceArtifactSignature(directories);
  const cached = audienceSnapshotCache.get(cacheKey);
  if (cached?.signature === signature) {
    audienceSnapshotCache.delete(cacheKey);
    audienceSnapshotCache.set(cacheKey, cached);
    return cached.snapshot;
  }

  const active = audienceSnapshotLoads.get(cacheKey);
  if (active?.signature === signature) return active.operation;

  const operation = loadAudienceArtifacts(directories);
  const load = { signature, operation };
  audienceSnapshotLoads.set(cacheKey, load);
  try {
    const snapshot = await operation;
    if (audienceSnapshotLoads.get(cacheKey) === load) {
      audienceSnapshotCache.delete(cacheKey);
      audienceSnapshotCache.set(cacheKey, { signature, snapshot });
      while (audienceSnapshotCache.size > AUDIENCE_SNAPSHOT_CACHE_LIMIT) {
        audienceSnapshotCache.delete(audienceSnapshotCache.keys().next().value);
      }
    }
    return snapshot;
  } finally {
    if (audienceSnapshotLoads.get(cacheKey) === load) audienceSnapshotLoads.delete(cacheKey);
  }
}

async function loadAudienceArtifacts(directories) {
  const commentsById = new Map();
  const posts = [];
  const issues = [];
  let commentsArtifactFound = false;

  const artifactResults = await Promise.all(directories.map(async (directory) => {
    const [commentsResult, postsResult] = await Promise.all([
      readJsonArray(path.join(directory, 'audience-comments.json')),
      readJsonArray(path.join(directory, 'audience-posts.json')),
    ]);
    return { commentsResult, postsResult };
  }));
  for (const { commentsResult, postsResult } of artifactResults) {
    commentsArtifactFound ||= commentsResult.found;
    if (commentsResult.issue) issues.push(commentsResult.issue);
    if (postsResult.issue) issues.push(postsResult.issue);
    for (const comment of commentsResult.items) {
      const key = firstString(commentId(comment), sha256(JSON.stringify(comment)));
      commentsById.set(key, mergeArtifactRecord(commentsById.get(key), comment));
    }
    for (const post of postsResult.items) {
      if (audiencePostId(post)) posts.push(post);
    }
  }

  return indexAudienceSnapshot({
    comments: [...commentsById.values()],
    posts,
    commentsArtifactFound,
    issues,
  });
}

async function audienceArtifactSignature(directories) {
  const filePaths = directories.flatMap((directory) => [
    path.join(directory, 'audience-comments.json'),
    path.join(directory, 'audience-posts.json'),
  ]);
  const revisions = await Promise.all(filePaths.map(async (filePath) => {
    try {
      const metadata = await stat(filePath);
      return `${filePath}|${metadata.mtimeMs}|${metadata.size}`;
    } catch (error) {
      return `${filePath}|${error?.code === 'ENOENT' ? 'missing' : `error:${error?.code || 'unknown'}`}`;
    }
  }));
  return revisions.join('\n');
}

function indexAudienceSnapshot(snapshot) {
  return {
    ...snapshot,
    commentsByPostId: groupAudienceRecords(snapshot.comments, commentPostId),
    postsByPostId: groupAudienceRecords(snapshot.posts, audiencePostId),
  };
}

function groupAudienceRecords(records, idForRecord) {
  const grouped = new Map();
  for (const record of records) {
    const postId = idForRecord(record);
    if (!postId) continue;
    const current = grouped.get(postId);
    if (current) current.push(record);
    else grouped.set(postId, [record]);
  }
  return grouped;
}

function audienceRecordsForPost(audience, postId) {
  return {
    comments: audience.commentsByPostId instanceof Map
      ? audience.commentsByPostId.get(postId) || []
      : audience.comments.filter((comment) => commentPostId(comment) === postId),
    posts: audience.postsByPostId instanceof Map
      ? audience.postsByPostId.get(postId) || []
      : audience.posts.filter((post) => audiencePostId(post) === postId),
  };
}

async function readJsonArray(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    if (!Array.isArray(value)) {
      return {
        found: true,
        items: [],
        issue: { code: 'AUDIENCE_ARTIFACT_INVALID', artifact: path.basename(filePath), reason: 'expected_array' },
      };
    }
    return { found: true, items: asRecords(value), issue: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { found: false, items: [], issue: null };
    return {
      found: true,
      items: [],
      issue: {
        code: 'AUDIENCE_ARTIFACT_INVALID',
        artifact: path.basename(filePath),
        reason: error instanceof SyntaxError ? 'invalid_json' : 'read_failed',
      },
    };
  }
}

function audienceCollectionStatus(posts, comments) {
  let status = comments.length ? 'partial' : 'pending';
  for (const post of posts) {
    status = maxCollectionStatus(status, normalizedCollectionStatus(post));
  }
  return status;
}

function normalizedCollectionStatus(post) {
  const explicit = firstString(post.collectionStatus, post.collection_status).toLowerCase();
  if (explicit === 'complete') return 'complete';
  if (['partial', 'failed'].includes(explicit)) return 'partial';
  if (['pending', 'uncollected'].includes(explicit)) return 'pending';
  const status = firstString(post.status).toLowerCase();
  if (status === 'complete') return 'complete';
  if (['partial', 'failed'].includes(status)) return 'partial';
  const collected = Number(post.collected_comment_count ?? post.collectedCommentCount ?? 0);
  return Number.isFinite(collected) && collected > 0 ? 'partial' : 'pending';
}

function maxCollectionStatus(left, right) {
  return COLLECTION_STATUS_RANK[right] > COLLECTION_STATUS_RANK[left] ? right : left;
}

function applicationRecordIds(record) {
  const noteId = firstString(record?.note_id, record?.noteId, record?.id);
  const postId = firstString(
    record?.post_id,
    record?.postId,
    postIdFromUrl(sourceUrl(record)),
    noteId,
  );
  return { noteId: noteId || postId, postId };
}

function postAuthorIdentity(record, posts) {
  const ids = uniqueStrings([
    record?.author?.user_id,
    record?.author?.userId,
    record?.user?.user_id,
    record?.author_id,
    record?.authorId,
    record?.author_user_id,
    profileId(firstString(record?.author_profile, record?.author_url)),
    ...posts.flatMap((post) => [
      post?.author?.user_id,
      post?.author?.userId,
      post?.author_id,
      post?.authorId,
      profileId(firstString(post?.author?.profile_url, post?.author_profile, post?.author_url)),
    ]),
  ]);
  return { id: ids.length === 1 ? ids[0] : '', ambiguous: ids.length > 1, ids };
}

function routeSource(route) {
  return routeSourceFields(route).includes('image') ? 'image' : 'body';
}

function routeSourceFields(route) {
  const fields = uniqueStrings([
    ...asStrings(route.source_fields),
    route.source_field,
    route.source,
    Number(route.source_image_index) > 0 ? 'image' : '',
  ]).map((value) => value.toLowerCase());
  return fields.length ? fields : ['body'];
}

function routeConfidence(route, source) {
  const supplied = Number(route.confidence);
  if (Number.isFinite(supplied) && supplied > 0) {
    return supplied <= 1 ? supplied * 100 : supplied;
  }
  const verification = firstString(route.verification_status, route.verificationStatus).toLowerCase();
  if (verification === 'cross_verified') return 100;
  if (verification === 'body_verified') return 98;
  if (verification === 'image_format_verified') return 85;
  return source === 'image' ? 80 : 90;
}

function commentConfidence({ isPostAuthor, hasRecruitmentContext }) {
  if (isPostAuthor && hasRecruitmentContext) return 85;
  if (isPostAuthor) return 70;
  if (hasRecruitmentContext) return 45;
  return 30;
}

function extractExactEmails(value) {
  return uniqueStrings([
    ...extractLiteralEmails(value),
    ...extractLiteralEmails(normalizeObfuscatedEmailText(value)),
  ]);
}

function extractLiteralEmails(value) {
  const text = String(value ?? '');
  const matches = [];
  for (const match of text.matchAll(EMAIL_MATCH)) {
    const address = match[1].toLowerCase();
    if (validEmailAddress(address)) matches.push(address);
  }
  return uniqueStrings(matches);
}

function normalizeObfuscatedEmailText(value) {
  let text = String(value ?? '')
    .replace(KEYCAP_CHARACTER, '$1')
    .normalize('NFKC')
    .replace(KEYCAP_CHARACTER, '$1')
    .replace(ZERO_WIDTH_CHARACTER, '')
    .replace(/\uFE0F/gu, '')
    .replace(/[🅰]/gu, 'a')
    .replace(/[🅱]/gu, 'b')
    .replace(/[🅾]/gu, 'o')
    .replace(/[🅿]/gu, 'p')
    .replace(EMAIL_ICON_CHARACTER, '@')
    .replace(/[零〇洞一幺壹二两贰三叁四肆五伍六陆七柒八捌九玖]/gu, (character) => CHINESE_DIGITS[character])
    .replace(/扣\s*扣/gu, 'qq')
    .replace(/q\s*q/giu, 'qq');

  text = text
    .replace(/[（(\[【]\s*at\s*[）)\]】]/giu, '\uE000')
    .replace(/[（(\[【]\s*dot\s*[）)\]】]/giu, '\uE001')
    .replace(/(?<![A-Z0-9])at(?![A-Z0-9])/giu, '\uE000')
    .replace(/(?<![A-Z0-9])dot(?![A-Z0-9])/giu, '\uE001')
    .replace(/(?:艾\s*特|圈\s*[aA])/gu, '\uE000')
    .replace(/(?:点儿|点|點)/gu, '\uE001')
    .replace(/[\s/\\|()[\]{}<>【】（）]*\uE000[\s/\\|()[\]{}<>【】（）]*/gu, '@')
    .replace(/[\s/\\|()[\]{}<>【】（）]*\uE001[\s/\\|()[\]{}<>【】（）]*/gu, '.')
    .replace(/\s*@\s*/gu, '@');

  let compacted = text;
  do {
    text = compacted;
    compacted = text.replace(/([0-9])\s+(?=[0-9])/gu, '$1');
  } while (compacted !== text);
  return compacted.replace(/(?:\b[A-Z0-9]\s+){2,}[A-Z0-9]\b/giu, (match) => match.replace(/\s+/gu, ''));
}

function validEmailAddress(address) {
  if (address.length > 254) return false;
  const [local, domain, ...extra] = address.split('@');
  if (!local || !domain || extra.length || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !/^[a-z]{2,63}$/iu.test(labels.at(-1))) return false;
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[a-z0-9-]+$/iu.test(label)
  ));
}

function mergeArtifactRecord(previous, current) {
  if (!previous) return current;
  const merged = { ...previous, ...current };
  for (const [key, value] of Object.entries(current)) {
    if (isMissing(value) && !isMissing(previous[key])) merged[key] = previous[key];
    if (isRecord(value) && isRecord(previous[key])) {
      merged[key] = mergeArtifactRecord(previous[key], value);
    }
  }
  return merged;
}

function isMissing(value) {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function sourceUrl(record) {
  return firstString(
    record?.note_url,
    record?.noteUrl,
    record?.search_result_url,
    record?.explore_url,
    record?.job_card?.source_url,
  );
}

function postIdFromUrl(value) {
  return String(value || '').match(/\/(?:search_result|explore)\/([^/?#]+)/iu)?.[1] || '';
}

function profileId(value) {
  return String(value || '').match(/\/user\/profile\/([^/?#]+)/iu)?.[1] || '';
}

function audiencePostId(post) {
  return firstString(post?.post_id, post?.postId, post?.note_id, post?.noteId, post?.id);
}

function commentPostId(comment) {
  return firstString(comment?.post_id, comment?.postId, comment?.note_id, comment?.noteId);
}

function commentId(comment) {
  return firstString(comment?.comment_id, comment?.commentId, comment?.id);
}

function commentAuthorId(comment) {
  return firstString(
    comment?.user?.user_id,
    comment?.user?.userId,
    comment?.user_id,
    comment?.userId,
  );
}

function cleanEvidence(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim().slice(0, 8_000);
}

function focusEmailEvidence(value) {
  const text = cleanEvidence(value);
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const matchingLine = lines.find((line) => extractExactEmails(line).length);
  if (matchingLine && matchingLine.length <= 320) return matchingLine;
  if (text.length <= 320) return text;
  const marker = text.search(/[@＠]|艾特|圈\s*[aA]|\bat\b/iu);
  if (marker < 0) return text.slice(0, 320).trimEnd();
  const start = Math.max(0, marker - 180);
  const end = Math.min(text.length, marker + 180);
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function boundedConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(100, Math.max(0, number))) : 0;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function asStrings(value) {
  return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
}

function asRecords(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
