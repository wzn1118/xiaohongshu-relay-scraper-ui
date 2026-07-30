import path from 'node:path';
import { readFile } from 'node:fs/promises';

const KINDS = new Set(['comments', 'users']);

export async function readAudienceResults(outputDir, searchParams = new URLSearchParams()) {
  const kind = KINDS.has(searchParams.get('kind')) ? searchParams.get('kind') : 'comments';
  const offset = boundedInteger(searchParams.get('offset'), 0, 0, 1_000_000);
  const limit = boundedInteger(searchParams.get('limit'), 40, 1, 100);
  const postId = String(searchParams.get('postId') || '').trim().slice(0, 200);
  const query = String(searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN').slice(0, 100);
  const [summary, posts, comments, users] = await Promise.all([
    readJson(path.join(outputDir, 'audience-summary.json'), null),
    readJson(path.join(outputDir, 'audience-posts.json'), []),
    readJson(path.join(outputDir, 'audience-comments.json'), []),
    readJson(path.join(outputDir, 'audience-users.json'), []),
  ]);
  const normalizedPosts = arrayOfObjects(posts);
  const normalizedComments = arrayOfObjects(comments);
  const normalizedUsers = arrayOfObjects(users);
  const usersById = new Map(normalizedUsers.map((user) => [String(user.user_id || ''), user]));
  const enrichedComments = normalizedComments.map((comment) => {
    const userId = String(comment.user?.user_id || comment.user_id || '');
    return {
      ...comment,
      user: usersById.get(userId) || comment.user || {},
    };
  });
  const available = Boolean(summary || normalizedPosts.length || normalizedComments.length || normalizedUsers.length);
  const selected = kind === 'users'
    ? normalizedUsers.filter((user) => {
      if (postId && !arrayOfStrings(user.post_ids).includes(postId)) return false;
      if (!query) return true;
      return [user.display_name, user.xhs_id, user.bio, user.location]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    })
    : enrichedComments.filter((comment) => {
      if (postId && String(comment.post_id || '') !== postId) return false;
      if (!query) return true;
      return [comment.text, comment.location, comment.user?.display_name, comment.user?.xhs_id]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    });
  const postsById = new Map(normalizedPosts.map((post) => [String(post.post_id || ''), post]));
  const items = selected.slice(offset, offset + limit).map((item) => kind === 'comments'
    ? { ...item, post_title: postsById.get(String(item.post_id || ''))?.title || '' }
    : item);
  return {
    available,
    kind,
    summary: normalizeSummary(summary, normalizedPosts, enrichedComments, normalizedUsers),
    posts: normalizedPosts,
    total: selected.length,
    offset,
    limit,
    items,
    totals: {
      posts: normalizedPosts.length,
      comments: normalizedComments.length,
      users: normalizedUsers.length,
    },
    filters: { postId, query },
  };
}

function normalizeSummary(value, posts, comments, users) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const postsComplete = posts.filter((post) => post.status === 'complete').length;
  const profilesComplete = users.filter((user) => user.enrichment_status === 'complete').length;
  return {
    schemaVersion: Number(source.schemaVersion || 1),
    status: ['complete', 'partial', 'pending', 'failed'].includes(source.status) ? source.status : 'pending',
    postsTotal: Number(source.postsTotal ?? posts.length),
    postsComplete: Number(source.postsComplete ?? postsComplete),
    postsPartial: Number(source.postsPartial ?? posts.filter((post) => post.status === 'partial').length),
    postsFailed: Number(source.postsFailed ?? posts.filter((post) => post.status === 'failed').length),
    commentsCollected: Number(source.commentsCollected ?? comments.length),
    topLevelComments: Number(source.topLevelComments ?? comments.filter((item) => !item.parent_comment_id).length),
    repliesCollected: Number(source.repliesCollected ?? comments.filter((item) => item.parent_comment_id).length),
    usersDiscovered: Number(source.usersDiscovered ?? users.length),
    profilesComplete: Number(source.profilesComplete ?? profilesComplete),
    postCoveragePercent: Number(source.postCoveragePercent ?? (posts.length ? (postsComplete / posts.length) * 100 : 0)),
    profileCoveragePercent: Number(source.profileCoveragePercent ?? (users.length ? (profilesComplete / users.length) * 100 : 0)),
    stopReason: String(source.stopReason || ''),
    generatedAt: String(source.generatedAt || ''),
  };
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
