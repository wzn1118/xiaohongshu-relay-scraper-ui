import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { materializeAudienceResults } from './audience-results.mjs';

const SNAPSHOT_SCHEMA_VERSION = 1;
const PROMPT_VERSION = 'audience-ai-v1';

export async function buildAudienceAiInput({ manager, jobId, postId, scope, model = {} }) {
  const job = manager.getInternal(jobId);
  if (!job) throw audienceAiError('AUDIENCE_AI_JOB_NOT_FOUND', 'The requested task was not found.', { jobId, postId });

  const source = resolveAudienceInputDirs(manager, jobId);
  const materialized = await materializeAudienceResults(source.primaryOutputDir, {
    fallbackOutputDirs: source.fallbackOutputDirs,
  });
  const post = materialized.posts.find((item) => String(item.post_id || '') === postId);
  if (!post) {
    throw audienceAiError('AUDIENCE_AI_POST_NOT_OWNED', 'The post does not belong to this task.', { jobId, postId });
  }

  const fullPost = await resolveFullPost(source.outputDirs, post);
  const comments = normalizeComments(
    materialized.comments.filter((item) => String(item.post_id || '') === postId),
    { jobId, postId, scope },
  );
  const users = normalizeUsers(materialized.users, comments, { scope });
  const originalPost = normalizeOriginalPost(post, fullPost);
  const coverage = buildCoverage({ post, comments, users, materialized, fullPost, scope });
  const quality = {
    flags: [...new Set([
      ...comments.flatMap((comment) => comment.qualityFlags),
      ...(originalPost.body ? [] : ['original_post_body_missing']),
      ...(comments.length ? [] : ['comments_empty']),
    ])],
    skippedCommentCount: Math.max(0, coverage.sourceCommentsForPost - comments.length),
    bodyAvailable: Boolean(originalPost.body),
  };
  const hashManifest = {
    originalPost: stableHash(originalPost),
    comments: stableHash(comments),
    users: stableHash(users),
    scope: stableHash(publicScope(scope)),
    model: stableHash(publicModel(model)),
    promptVersion: PROMPT_VERSION,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
  const inputRevision = stableHash(hashManifest);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    jobId,
    postId,
    inputRevision,
    createdAt: new Date().toISOString(),
    source: {
      sourceJobId: source.sourceJobId,
      checkpointJobId: jobId,
      readThroughJobIds: source.jobIds,
    },
    scope: publicScope(scope),
    model: publicModel(model),
    originalPost,
    comments,
    users,
    coverage,
    quality,
    hashManifest,
  };
}

export async function assertAudiencePostOwned({ manager, jobId, postId }) {
  const job = manager.getInternal(jobId);
  if (!job) throw audienceAiError('AUDIENCE_AI_JOB_NOT_FOUND', 'The requested task was not found.', { jobId, postId });
  const source = resolveAudienceInputDirs(manager, jobId);
  const materialized = await materializeAudienceResults(source.primaryOutputDir, {
    fallbackOutputDirs: source.fallbackOutputDirs,
  });
  const post = materialized.posts.find((item) => String(item.post_id || '') === postId);
  if (!post) throw audienceAiError('AUDIENCE_AI_POST_NOT_OWNED', 'The post does not belong to this task.', { jobId, postId });
  return post;
}

export function resolveAudienceInputDirs(manager, requestedJobId) {
  const lineage = audienceJobLineage(manager, requestedJobId);
  const sourceJobId = lineage.at(-1) || requestedJobId;
  const orderedIds = [sourceJobId];
  const seen = new Set(orderedIds);
  for (const job of [...manager.list()].reverse()) {
    if (!job.config?.audienceOnly || sourceJobIdFor(manager, job.id) !== sourceJobId || seen.has(job.id)) continue;
    seen.add(job.id);
    orderedIds.push(job.id);
  }
  for (const id of [...lineage].reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }
  if (!seen.has(requestedJobId)) orderedIds.push(requestedJobId);
  const readable = orderedIds
    .map((id) => ({ id, outputDir: manager.getInternal(id)?.outputDir }))
    .filter((item) => item.outputDir);
  const primary = readable.at(-1);
  if (!primary) throw audienceAiError('AUDIENCE_AI_JOB_NOT_FOUND', 'The requested task has no readable output.', { jobId: requestedJobId });
  return {
    sourceJobId,
    jobIds: readable.map((item) => item.id),
    outputDirs: readable.map((item) => item.outputDir),
    primaryOutputDir: primary.outputDir,
    fallbackOutputDirs: readable.slice(0, -1).map((item) => item.outputDir),
  };
}

async function resolveFullPost(outputDirs, audiencePost) {
  const candidates = [];
  for (let order = 0; order < outputDirs.length; order += 1) {
    for (const filename of ['application_intelligence.json', 'application_intelligence.checkpoint.json']) {
      const filePath = path.join(outputDirs[order], filename);
      let metadata;
      try {
        metadata = await stat(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      for (const record of Array.isArray(payload?.records) ? payload.records : []) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const match = postMatchKind(record, audiencePost);
        if (match) candidates.push({ record, filePath, filename, order, modifiedAt: metadata.mtimeMs, match });
      }
    }
  }
  if (!candidates.length) return null;
  const exact = candidates.filter((item) => item.match === 'id');
  const usable = exact.length ? exact : candidates.filter((item) => item.match === 'url');
  const identities = new Set(usable.map((item) => normalizedRecordId(item.record)).filter(Boolean));
  if (!exact.length && identities.size > 1) {
    throw audienceAiError('AUDIENCE_AI_REVISION_CONFLICT', 'The post URL matched multiple source records.', {
      postId: String(audiencePost.post_id || ''),
    });
  }
  return usable.sort((left, right) => (
    postCompleteness(right.record) - postCompleteness(left.record)
    || right.order - left.order
    || right.modifiedAt - left.modifiedAt
  ))[0];
}

function normalizeOriginalPost(post, fullPost) {
  const record = fullPost?.record || {};
  const media = record.media && typeof record.media === 'object' && !Array.isArray(record.media) ? record.media : {};
  return {
    postId: String(post.post_id || ''),
    noteId: firstString(record.note_id, record.post_id, post.post_id),
    title: firstString(record.title, post.title),
    body: firstString(record.body, record.content, record.desc),
    author: normalizeAuthor(record, post),
    publishTime: record.publish_time ?? post.publish_time ?? null,
    sourceUrl: firstString(record.note_url, record.source_url, post.note_url),
    media,
    ocr: record.ocr ?? media.ocr ?? media.ocr_text ?? null,
    visualAnalysis: record.visual_analysis ?? media.visual_analysis ?? media.image_analysis ?? null,
    existingContentAnalysis: record.content_analysis ?? null,
    sourceArtifact: fullPost?.filename || null,
    collectedAt: firstString(record.collected_at, post.last_collected_at) || null,
    contentHash: stableHash({
      title: firstString(record.title, post.title),
      body: firstString(record.body, record.content, record.desc),
      media,
      contentAnalysis: record.content_analysis ?? null,
    }),
  };
}

function normalizeComments(sourceComments, { jobId, postId, scope }) {
  const filtered = sourceComments.filter((comment) => {
    const hasParent = Boolean(firstString(comment.parent_comment_id, comment.parentCommentId));
    return hasParent ? scope.includeReplies : scope.includeTopLevelComments;
  });
  const byId = new Map(filtered.map((comment) => [firstString(comment.comment_id, comment.commentId), comment]).filter(([id]) => id));
  return filtered.map((comment, index) => {
    const commentId = firstString(comment.comment_id, comment.commentId) || `synthetic-comment-${stableHash({ jobId, postId, index, text: comment.text }).slice(0, 20)}`;
    const parentCommentId = firstString(comment.parent_comment_id, comment.parentCommentId) || null;
    const sourceUser = comment.user && typeof comment.user === 'object' ? comment.user : {};
    const explicitUserId = firstString(sourceUser.user_id, comment.user_id);
    const userId = explicitUserId || `synthetic-user-${stableHash({ jobId, postId, commentId }).slice(0, 20)}`;
    const qualityFlags = [];
    if (!firstString(comment.comment_id, comment.commentId)) qualityFlags.push('synthetic_comment_id');
    if (!explicitUserId) qualityFlags.push('synthetic_user_id');
    if (parentCommentId && !byId.has(parentCommentId)) qualityFlags.push('missing_parent');
    if (!firstString(comment.text)) qualityFlags.push('empty_text');
    return {
      commentId,
      postId,
      parentCommentId,
      rootThreadId: resolveRootThread(commentId, parentCommentId, byId, qualityFlags),
      replyToUserId: firstString(comment.reply_to_user_id, comment.replyToUserId, comment.reply_to_user?.user_id) || null,
      level: nonNegativeInteger(comment.level, parentCommentId ? 1 : 0),
      text: firstString(comment.text),
      likes: nonNegativeInteger(comment.likes, 0),
      publishTime: comment.publish_time ?? null,
      location: firstString(comment.location, comment.ip_location) || null,
      sourceUrl: firstString(comment.source_url) || null,
      userId,
      userDisplayName: firstString(sourceUser.display_name, comment.display_name) || null,
      collectedAt: firstString(comment.collected_at) || null,
      syntheticIdentity: !explicitUserId,
      qualityFlags,
      normalizedContentHash: stableHash({ commentId, parentCommentId, text: firstString(comment.text), userId }),
    };
  });
}

function resolveRootThread(commentId, parentId, byId, flags) {
  if (!parentId) return commentId;
  let current = parentId;
  const visited = new Set([commentId]);
  for (let depth = 0; depth < 50; depth += 1) {
    if (visited.has(current)) {
      flags.push('comment_parent_cycle');
      return commentId;
    }
    visited.add(current);
    const parent = byId.get(current);
    if (!parent) return current;
    const next = firstString(parent.parent_comment_id, parent.parentCommentId);
    if (!next) return current;
    current = next;
  }
  flags.push('comment_parent_depth_exceeded');
  return commentId;
}

function normalizeUsers(sourceUsers, comments, { scope }) {
  if (!scope.includeUsers) return [];
  const sourceById = new Map(sourceUsers.map((user) => [String(user.user_id || ''), user]));
  const commentGroups = new Map();
  for (const comment of comments) {
    if (!commentGroups.has(comment.userId)) commentGroups.set(comment.userId, []);
    commentGroups.get(comment.userId).push(comment.commentId);
  }
  const ranked = [...commentGroups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
  const profileBudget = scope.profileMode === 'none'
    ? 0
    : scope.profileUserLimit > 0
      ? Math.min(scope.profileUserLimit, ranked.length)
      : ranked.length;
  let recentPostBudget = scope.profilePostTotalLimit > 0 ? scope.profilePostTotalLimit : Number.POSITIVE_INFINITY;
  return ranked.map(([userId, commentIds], index) => {
    const source = sourceById.get(userId) || {};
    const base = {
      userId,
      displayName: firstString(source.display_name, comments.find((item) => item.userId === userId)?.userDisplayName) || null,
      xhsId: firstString(source.xhs_id) || null,
      commentIds,
      commentCount: commentIds.length,
      syntheticIdentity: userId.startsWith('synthetic-user-'),
    };
    if (scope.profileMode === 'none' || index >= profileBudget) return base;
    const profileAvailable = hasProfileHeader(source);
    const recentPublicPosts = scope.profileMode === 'recent_public_posts'
      ? normalizeRecentPosts(source.recent_public_posts ?? source.public_posts)
          .slice(0, Math.min(scope.profilePostLimitPerUser || 0, recentPostBudget))
      : [];
    recentPostBudget -= recentPublicPosts.length;
    return {
      ...base,
      profile: {
        profileUrl: firstString(source.profile_url) || null,
        avatarUrl: firstString(source.avatar_url) || null,
        bio: firstString(source.bio) || null,
        ipLocation: firstString(source.ip_location, source.location) || null,
        followingCount: nullableCount(source.following_count),
        followerCount: nullableCount(source.follower_count),
        likedAndCollectedCount: nullableCount(source.liked_and_collected_count),
        roles: Array.isArray(source.roles) ? source.roles.map(String) : [],
        enrichmentStatus: firstString(source.enrichment_status) || 'pending',
        accessStatus: firstString(source.access_status) || null,
        missingFields: Array.isArray(source.missing_profile_fields) ? source.missing_profile_fields.map(String) : [],
        lastEnrichedAt: firstString(source.last_enriched_at) || null,
        available: profileAvailable,
      },
      ...(scope.profileMode === 'recent_public_posts'
        ? { recentPublicPosts }
        : {}),
    };
  });
}

function buildCoverage({ post, comments, users, materialized, fullPost, scope }) {
  const allForPost = materialized.comments.filter((item) => String(item.post_id || '') === String(post.post_id || ''));
  const topLevel = comments.filter((item) => !item.parentCommentId).length;
  const replies = comments.length - topLevel;
  const relevantUserIds = new Set(allForPost
    .map((comment) => firstString(comment.user?.user_id, comment.user_id))
    .filter(Boolean));
  const persistedUsers = materialized.users.filter((user) => relevantUserIds.has(firstString(user.user_id)));
  const profilesAvailable = persistedUsers.filter(hasProfileHeader).length;
  const profilesComplete = persistedUsers.filter((user) => (
    hasProfileHeader(user) && firstString(user.enrichment_status).toLowerCase() === 'complete'
  )).length;
  const profilePosts = persistedUsers.map((user) => normalizeRecentPosts(user.recent_public_posts ?? user.public_posts));
  const profilePostUsersAvailable = profilePosts.filter((posts) => posts.length > 0).length;
  const profilePostsAvailable = profilePosts.reduce((total, posts) => total + posts.length, 0);
  const eligibleUsers = users.filter((user) => !user.syntheticIdentity);
  const profilesSelected = scope.includeUsers && scope.profileMode !== 'none'
    ? Math.min(scope.profileUserLimit > 0 ? scope.profileUserLimit : eligibleUsers.length, eligibleUsers.length)
    : 0;
  return {
    sourceCommentsForPost: allForPost.length,
    commentsIncluded: comments.length,
    topLevelCommentsIncluded: topLevel,
    repliesIncluded: replies,
    uniqueUsersIncluded: users.length,
    profilesAvailable,
    profilesSelected,
    profilesComplete,
    profilesPartial: profilesAvailable - profilesComplete,
    profilesMissing: Math.max(0, relevantUserIds.size - profilesAvailable),
    profilePostUsersAvailable,
    profilePostsAvailable,
    originalBodyAvailable: Boolean(fullPost?.record && firstString(fullPost.record.body, fullPost.record.content, fullPost.record.desc)),
    expectedComments: nullableCount(post.expected_comment_count),
    collectionStatus: firstString(post.collectionStatus, post.status) || 'pending',
    profileMode: scope.profileMode,
  };
}

function resolveAudienceRecordId(record) {
  const url = firstString(record.note_url, record.source_url, record.search_result_url, record.explore_url);
  return firstString(record.note_id, record.post_id, record.id, url.match(/\/(?:explore|search_result)\/([^/?#]+)/u)?.[1]);
}

function postMatchKind(record, post) {
  const requestedId = String(post.post_id || '');
  if (resolveAudienceRecordId(record) === requestedId) return 'id';
  const recordUrl = normalizePostUrl(firstString(record.note_url, record.source_url, record.search_result_url, record.explore_url));
  const postUrl = normalizePostUrl(firstString(post.note_url));
  return recordUrl && postUrl && recordUrl === postUrl ? 'url' : null;
}

function normalizedRecordId(record) {
  return resolveAudienceRecordId(record) || normalizePostUrl(firstString(record.note_url, record.source_url));
}

function normalizePostUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return '';
  }
}

function postCompleteness(record) {
  return Number(Boolean(firstString(record.body, record.content, record.desc))) * 100
    + Number(Boolean(record.media)) * 20
    + Number(Boolean(record.content_analysis)) * 10
    + Number(Boolean(record.ocr || record.media?.ocr)) * 5;
}

function normalizeAuthor(record, post) {
  const recordAuthor = record.author && typeof record.author === 'object' ? record.author : {};
  const postAuthor = post.author && typeof post.author === 'object' ? post.author : {};
  return {
    userId: firstString(recordAuthor.user_id, record.author_id, postAuthor.user_id) || null,
    displayName: firstString(recordAuthor.display_name, record.author, record.nickname, postAuthor.display_name) || null,
    profileUrl: firstString(recordAuthor.profile_url, record.author_profile, postAuthor.profile_url) || null,
  };
}

function publicScope(scope) {
  return {
    includeTopLevelComments: scope.includeTopLevelComments,
    includeReplies: scope.includeReplies,
    includeUsers: scope.includeUsers,
    profileMode: scope.profileMode,
    profileUserLimit: scope.profileUserLimit,
    profilePostLimitPerUser: scope.profilePostLimitPerUser,
    profilePostTotalLimit: scope.profilePostTotalLimit,
    modules: [...scope.modules],
    outputLanguage: scope.outputLanguage,
    evidenceStrictness: scope.evidenceStrictness,
    incrementalOnly: scope.incrementalOnly,
    maxEstimatedTokens: scope.maxEstimatedTokens,
    maxEstimatedCost: scope.maxEstimatedCost,
  };
}

function publicModel(model) {
  return {
    provider: firstString(model.provider) || null,
    model: firstString(model.model) || null,
    wireApi: firstString(model.wireApi) || null,
  };
}

function normalizeRecentPosts(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
    postId: firstString(item.post_id, item.note_id, item.id) || null,
    title: firstString(item.title) || null,
    body: firstString(item.body, item.content, item.desc) || null,
    sourceUrl: firstString(item.note_url, item.source_url) || null,
    publishTime: item.publish_time ?? null,
  }));
}

function audienceJobLineage(manager, jobId) {
  const result = [];
  const seen = new Set();
  let current = jobId;
  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    const job = manager.getInternal(current);
    if (!job?.params?.audienceOnly || !job.params.resumeFromJobId) break;
    current = job.params.resumeFromJobId;
  }
  return result;
}

function sourceJobIdFor(manager, jobId) {
  return audienceJobLineage(manager, jobId).at(-1) || jobId;
}

function stableHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function nullableCount(value) {
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasProfileHeader(source) {
  if (['complete', 'partial'].includes(firstString(source.enrichment_status))) return true;
  return Boolean(
    firstString(source.bio, source.ip_location, source.location, source.last_enriched_at)
    || nullableCount(source.following_count) !== null
    || nullableCount(source.follower_count) !== null
    || nullableCount(source.liked_and_collected_count) !== null,
  );
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

export function audienceAiError(code, message, context = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, context);
  return error;
}
