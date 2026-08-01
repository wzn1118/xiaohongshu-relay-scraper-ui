import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const KINDS = new Set(['comments', 'users']);
const SUMMARY_STATUSES = new Set(['complete', 'partial', 'pending', 'failed']);

export async function readAudienceResults(outputDir, searchParams = new URLSearchParams(), {
  fallbackOutputDirs = [],
} = {}) {
  const kind = KINDS.has(searchParams.get('kind')) ? searchParams.get('kind') : 'comments';
  const offset = boundedInteger(searchParams.get('offset'), 0, 0, 1_000_000);
  const limit = boundedInteger(searchParams.get('limit'), 40, 1, 500);
  const postId = String(searchParams.get('postId') || '').trim().slice(0, 200);
  const query = String(searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN').slice(0, 100);
  const materialized = await materializeAudienceResults(outputDir, { fallbackOutputDirs });
  const {
    available,
    summary,
    posts: normalizedPosts,
    comments: enrichedComments,
    users: normalizedUsers,
    totals,
  } = materialized;
  const selected = kind === 'users'
    ? normalizedUsers.filter((user) => {
      if (postId && !arrayOfStrings(user.post_ids).includes(postId)) return false;
      if (!query) return true;
      return [user.display_name, user.xhs_id, user.bio, user.ip_location, user.location]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    })
    : enrichedComments.filter((comment) => {
      if (postId && String(comment.post_id || '') !== postId) return false;
      if (!query) return true;
      return [comment.text, comment.ip_location, comment.location, comment.user?.display_name, comment.user?.xhs_id, comment.user?.ip_location]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    });
  const postsById = new Map(normalizedPosts.map((post) => [String(post.post_id || ''), post]));
  const items = selected.slice(offset, offset + limit).map((item) => kind === 'comments'
    ? { ...item, post_title: postsById.get(String(item.post_id || ''))?.title || '' }
    : item);
  return {
    available,
    kind,
    summary,
    posts: normalizedPosts,
    total: selected.length,
    offset,
    limit,
    items,
    totals,
    filters: { postId, query },
  };
}

export async function materializeAudienceResults(outputDir, {
  fallbackOutputDirs = [],
} = {}) {
  const directories = [...new Set([...fallbackOutputDirs, outputDir].filter(Boolean).map((item) => path.resolve(item)))];
  const sources = await Promise.all(directories.map(readAudienceSource));
  const summarySource = sources.reduce(
    (current, source) => source.summary ? mergeRecord(current || {}, source.summary) : current,
    null,
  );
  const checkpointPosts = mergeRecords(sources.flatMap(contentInsightPosts), 'post_id');
  const sourcePostIds = new Set(checkpointPosts.map((post) => String(post.post_id || '')).filter(Boolean));
  const allComments = mergeRecords(sources.flatMap((source) => source.comments), 'comment_id');
  const normalizedComments = sourcePostIds.size
    ? allComments.filter((comment) => sourcePostIds.has(String(comment.post_id || '')))
    : allComments;
  const commentStatsByPost = collectCommentStats(normalizedComments);
  const savedPosts = mergeRecords(sources.flatMap((source) => source.posts), 'post_id');
  const scopedSavedPosts = sourcePostIds.size
    ? savedPosts.filter((post) => sourcePostIds.has(String(post.post_id || '')))
    : savedPosts;
  const normalizedPosts = mergeRecords(
    [...checkpointPosts, ...scopedSavedPosts],
    'post_id',
  ).map((post) => normalizePost(post, commentStatsByPost.get(String(post.post_id || ''))));
  const postAuthorsById = new Map(normalizedPosts
    .map((post) => post.author)
    .filter((author) => author?.user_id)
    .map((author) => [String(author.user_id), author]));
  const allUsers = mergeRecords(sources.flatMap((source) => source.users), 'user_id')
    .map((user) => mergeRecord(postAuthorsById.get(String(user.user_id)) || {}, user));
  const relevantUserIds = new Set([
    ...normalizedComments.map((comment) => String(comment.user?.user_id || comment.user_id || '')).filter(Boolean),
    ...normalizedPosts.map((post) => String(post.author?.user_id || '')).filter(Boolean),
  ]);
  const normalizedUsers = sourcePostIds.size
    ? allUsers.filter((user) => (
      relevantUserIds.has(String(user.user_id || ''))
      || arrayOfStrings(user.post_ids).some((postId) => sourcePostIds.has(postId))
    ))
    : allUsers;
  const usersById = new Map(normalizedUsers.map((user) => [String(user.user_id || ''), user]));
  const enrichedComments = normalizedComments.map((comment) => {
    const userId = String(comment.user?.user_id || comment.user_id || '');
    return {
      ...comment,
      user: mergeRecord(comment.user || {}, usersById.get(userId) || {}),
    };
  });
  return {
    available: Boolean(normalizedPosts.length || normalizedComments.length || normalizedUsers.length),
    summary: normalizeSummary(summarySource, normalizedPosts, enrichedComments, normalizedUsers),
    posts: normalizedPosts,
    comments: enrichedComments,
    users: normalizedUsers,
    totals: {
      posts: normalizedPosts.length,
      comments: normalizedComments.length,
      users: normalizedUsers.length,
    },
  };
}

async function readAudienceSource(outputDir) {
  const [summary, posts, comments, users, notes, cardsPayload, applicationPayload] = await Promise.all([
    readJson(path.join(outputDir, 'audience-summary.json'), null),
    readJson(path.join(outputDir, 'audience-posts.json'), []),
    readJson(path.join(outputDir, 'audience-comments.json'), []),
    readJson(path.join(outputDir, 'audience-users.json'), []),
    readJson(path.join(outputDir, 'xiaohongshu_notes_latest.json'), []),
    readJson(path.join(outputDir, 'xiaohongshu_cards_latest.json'), []),
    readJson(path.join(outputDir, 'application_intelligence.json'), null),
  ]);
  return {
    summary: summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : null,
    posts: arrayOfObjects(posts),
    comments: arrayOfObjects(comments),
    users: arrayOfObjects(users),
    notes: arrayOfObjects(notes),
    cards: arrayOfObjects(Array.isArray(cardsPayload) ? cardsPayload : cardsPayload?.cards),
    applicationRecords: arrayOfObjects(applicationPayload?.records),
  };
}

function contentInsightPosts(source) {
  const owners = source.applicationRecords.length
    ? source.applicationRecords
    : source.cards.length
      ? source.cards
      : source.notes;
  const metadataById = new Map();
  for (const item of [...source.cards, ...source.notes]) {
    const postId = checkpointPostId(item);
    if (!postId) continue;
    metadataById.set(postId, mergeRecord(metadataById.get(postId) || {}, item));
  }
  return owners.map((record) => {
    const postId = checkpointPostId(record);
    const enriched = mergeRecord(record, metadataById.get(postId) || {});
    return postFromCheckpoint(enriched);
  }).filter(Boolean);
}

function postFromCheckpoint(note) {
  const noteUrl = checkpointPostUrl(note);
  let postId = checkpointPostId(note);
  if (!postId && noteUrl) postId = createHash('sha256').update(noteUrl).digest('hex').slice(0, 24);
  if (!postId || !noteUrl) return null;
  return {
    post_id: postId,
    title: firstString(note.title) || 'Untitled post',
    note_url: noteUrl,
    cover_url: checkpointPostCover(note),
    author: {
      user_id: profileId(firstString(note.author_profile, note.author_url)),
      display_name: firstString(note.author, note.nickname),
      profile_url: firstString(note.author_profile, note.author_url),
      avatar_url: checkpointAuthorAvatar(note),
      roles: ['author'],
      post_ids: [postId],
      enrichment_status: 'pending',
    },
    expected_comment_count: numericCount(note.comment_count ?? note.comments),
    status: 'pending',
  };
}

function checkpointPostCover(note) {
  const media = isRecord(note.media) ? note.media : {};
  const mediaImages = arrayOfObjects(media.images).map((image) => firstString(image.url));
  const candidates = [
    media.cover_url,
    ...mediaImages,
    note.card_cover_url,
    ...mediaFieldValues(note.card_image_urls),
    ...mediaFieldValues(note.detail_image_urls),
    ...mediaFieldValues(note.image_urls),
  ];
  return candidates.map((value) => firstString(value)).find(isPostImageUrl) || '';
}

function mediaFieldValues(value) {
  return Array.isArray(value)
    ? value
    : String(value || '').split('|');
}

function isPostImageUrl(value) {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized)
    && !/sns-avatar|\/avatar\/|avatar_/i.test(normalized);
}

function checkpointAuthorAvatar(note) {
  const explicit = firstString(note.author_avatar, note.author_avatar_url, note.avatar_url);
  if (explicit) return explicit;
  const candidates = [note.card_image_urls, note.detail_image_urls, note.image_urls]
    .flatMap((value) => Array.isArray(value) ? value : String(value || '').split('|'))
    .map((value) => String(value || '').trim());
  return candidates.find((value) => /sns-avatar|\/avatar\//i.test(value)) || '';
}

function checkpointPostUrl(note) {
  return firstString(
    note.note_url,
    note.search_result_url,
    note.explore_url,
    note.card_search_result_url,
    note.card_explore_url,
    note.job_card?.source_url,
  );
}

function checkpointPostId(note) {
  const noteUrl = checkpointPostUrl(note);
  const urlId = noteUrl.match(/\/(?:search_result|explore)\/([^/?#]+)/)?.[1] || '';
  return firstString(urlId, note.note_id, note.id);
}

function normalizePost(post, commentStats = null) {
  const storedStatus = normalizedProgressStatus(post.status) || 'pending';
  const storedCount = numericCount(post.collected_comment_count) ?? 0;
  const collected = Math.max(storedCount, commentStats?.total || 0);
  const expected = numericCount(post.expected_comment_count);
  let status = storedStatus;
  if (status !== 'complete' && expected !== null && collected > 0 && collected >= expected) {
    status = 'complete';
  } else if (status === 'pending' && collected > 0) {
    status = 'partial';
  }
  const collectionStatus = status === 'complete'
    ? 'complete'
    : status === 'partial' || status === 'failed' || collected > 0
      ? 'partial'
      : 'uncollected';
  return {
    ...post,
    status,
    collected_comment_count: collected,
    top_level_count: Math.max(numericCount(post.top_level_count) ?? 0, commentStats?.topLevel || 0),
    reply_count: Math.max(numericCount(post.reply_count) ?? 0, commentStats?.replies || 0),
    unique_user_count: Math.max(numericCount(post.unique_user_count) ?? 0, commentStats?.userIds.size || 0),
    collectionStatus,
  };
}

function normalizeSummary(value, posts, comments, users) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const postsComplete = posts.filter((post) => post.collectionStatus === 'complete').length;
  const postsPartial = posts.filter((post) => post.collectionStatus === 'partial').length;
  const postsUncollected = posts.filter((post) => post.collectionStatus === 'uncollected').length;
  const postsFailed = posts.filter((post) => post.status === 'failed').length;
  const postsAttempted = postsComplete + postsPartial;
  const postsWithComments = posts.filter((post) => numericCount(post.collected_comment_count) > 0).length;
  const profilesComplete = users.filter((user) => user.enrichment_status === 'complete').length;
  let status = 'pending';
  if (posts.length && postsComplete === posts.length && profilesComplete === users.length) status = 'complete';
  else if (postsComplete || postsPartial || comments.length || users.length) status = 'partial';
  else if (source.status === 'failed') status = 'failed';
  return {
    schemaVersion: Number(source.schemaVersion || 1),
    status,
    postsTotal: posts.length,
    postsComplete,
    postsPartial,
    postsPending: postsUncollected,
    postsUncollected,
    postsFailed,
    postsAttempted,
    postsWithComments,
    commentsCollected: comments.length,
    topLevelComments: comments.filter((item) => !item.parent_comment_id).length,
    repliesCollected: comments.filter((item) => item.parent_comment_id).length,
    usersDiscovered: users.length,
    profilesComplete,
    postCoveragePercent: posts.length ? (postsComplete / posts.length) * 100 : 0,
    postAttemptPercent: posts.length ? (postsAttempted / posts.length) * 100 : 0,
    profileCoveragePercent: users.length ? (profilesComplete / users.length) * 100 : 0,
    checkpointSchemaVersion: Number(source.checkpointSchemaVersion || 1),
    resumeStrategyCounts: isRecord(source.resumeStrategyCounts)
      ? source.resumeStrategyCounts
      : {},
    repeatedRequests: numericCount(source.repeatedRequests) ?? 0,
    duplicateCommentsSeen: numericCount(source.duplicateCommentsSeen) ?? 0,
    performancePenalty: Number.isFinite(Number(source.performancePenalty))
      ? Number(source.performancePenalty)
      : 0,
    stopReason: String(source.stopReason || ''),
    generatedAt: String(source.generatedAt || ''),
  };
}

function mergeRecords(items, keyName) {
  const merged = [];
  const positions = new Map();
  for (const item of items) {
    const key = String(item?.[keyName] || '');
    if (!key) {
      merged.push(item);
      continue;
    }
    if (!positions.has(key)) {
      positions.set(key, merged.length);
      merged.push(item);
      continue;
    }
    const index = positions.get(key);
    merged[index] = mergeRecord(merged[index], item);
  }
  return merged;
}

function mergeRecord(previous, current) {
  const previousRecord = isRecord(previous) ? previous : {};
  const currentRecord = isRecord(current) ? current : {};
  const merged = {};
  for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(currentRecord)])) {
    const previousValue = previousRecord[key];
    const currentValue = currentRecord[key];
    if (key === 'roles' || key === 'post_ids') {
      merged[key] = mergeStringArrays(previousValue, currentValue);
    } else if (MERGE_STATUS_RANKS[key]) {
      merged[key] = mergeRankedValue(previousValue, currentValue, MERGE_STATUS_RANKS[key]);
    } else if (isCountField(key)) {
      merged[key] = mergeCount(previousValue, currentValue);
    } else if (isRecord(previousValue) && isRecord(currentValue)) {
      merged[key] = mergeRecord(previousValue, currentValue);
    } else {
      merged[key] = isMissingMergeValue(currentValue) && !isMissingMergeValue(previousValue)
        ? previousValue
        : currentValue;
    }
  }
  return merged;
}

const MERGE_STATUS_RANKS = {
  enrichment_status: { pending: 1, failed: 2, partial: 2, complete: 3 },
  access_status: {
    discovered: 1,
    profile_refresh_required: 1,
    public_profile_rate_limited: 2,
    public_profile_restricted: 2,
    public_profile_ok: 3,
  },
  status: { pending: 1, failed: 2, partial: 2, complete: 3 },
};

function isMissingMergeValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim();
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.length === 0 || value.every(isMissingMergeValue);
  if (isRecord(value)) {
    const values = Object.values(value);
    return values.length === 0 || values.every(isMissingMergeValue);
  }
  return false;
}

function mergeRankedValue(previous, current, ranks) {
  if (isMissingMergeValue(current)) return previous;
  if (isMissingMergeValue(previous)) return normalizedRankedValue(current, ranks) || current;
  const previousStatus = normalizedRankedValue(previous, ranks);
  const currentStatus = normalizedRankedValue(current, ranks);
  if (previousStatus && currentStatus) {
    return ranks[previousStatus] > ranks[currentStatus] ? previousStatus : currentStatus;
  }
  if (previousStatus) return previousStatus;
  if (currentStatus) return currentStatus;
  return current;
}

function normalizedRankedValue(value, ranks) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  return Object.hasOwn(ranks, normalized) ? normalized : '';
}

function normalizedProgressStatus(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  return SUMMARY_STATUSES.has(normalized) ? normalized : '';
}

function mergeCount(previous, current) {
  const previousCount = numericCount(previous);
  const currentCount = numericCount(current);
  if (previousCount !== null && currentCount !== null) return Math.max(previousCount, currentCount);
  if (previousCount !== null) return previousCount;
  if (currentCount !== null) return currentCount;
  return isMissingMergeValue(current) && !isMissingMergeValue(previous) ? previous : current;
}

function isCountField(key) {
  return key === 'count' || /_count$/i.test(key) || /Count$/.test(key);
}

function mergeStringArrays(previous, current) {
  const values = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(current) ? current : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  return [...new Set(values)];
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectCommentStats(comments) {
  const byPost = new Map();
  for (const comment of comments) {
    const postId = String(comment.post_id || '').trim();
    if (!postId) continue;
    if (!byPost.has(postId)) byPost.set(postId, { total: 0, topLevel: 0, replies: 0, userIds: new Set() });
    const stats = byPost.get(postId);
    stats.total += 1;
    if (comment.parent_comment_id) stats.replies += 1;
    else stats.topLevel += 1;
    const userId = String(comment.user?.user_id || comment.user_id || '').trim();
    if (userId) stats.userIds.add(userId);
  }
  return byPost;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function profileId(profileUrl) {
  const match = profileUrl.match(/\/user\/profile\/([^/?]+)/);
  return match?.[1] || '';
}

function numericCount(value) {
  if (isMissingMergeValue(value)) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
