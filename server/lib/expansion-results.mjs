import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { enumerateArtifacts } from './artifacts.mjs';
import { materializeAudienceResults } from './audience-results.mjs';

const KINDS = new Set(['users', 'posts', 'comments', 'relations']);
const ARTIFACTS = new Set([
  'expansion_summary.json', 'expansion_rounds.json', 'expansion_frontier.json',
  'graph.json', 'users.csv', 'posts.csv', 'comments.csv', 'relations.csv',
]);

export async function readExpansionSeeds(outputDir) {
  const audience = await materializeAudienceResults(outputDir);
  return audience.posts.map((post, index) => {
    const persistedPostId = String(post.post_id || '');
    const url = String(post.note_url || '');
    const unavailableReason = !persistedPostId ? '缺少稳定 postId' : !url ? '缺少可访问链接' : '';
    return {
      postId: persistedPostId || `unavailable-${index + 1}`,
      title: String(post.title || '未命名帖子'),
      author: post.author || {},
      url,
      available: !unavailableReason,
      unavailableReason,
      contentStatus: url ? 'complete' : 'partial',
      commentStatus: post.collectionStatus || 'uncollected',
      collectionReason: String(post.status || ''),
      collectedComments: Number(post.collected_comment_count || 0),
    };
  });
}

export async function readExpansionSnapshot(outputDir, searchParams = new URLSearchParams(), runtime = {}) {
  const kind = KINDS.has(searchParams.get('kind')) ? searchParams.get('kind') : 'users';
  const offset = boundedInteger(searchParams.get('offset'), 0, 0, 1_000_000);
  const limit = boundedInteger(searchParams.get('limit'), 50, 1, 100);
  const roundFilter = searchParams.get('round') || '';
  const statusFilter = searchParams.get('status') || '';
  const seedFilter = searchParams.get('seed') || '';
  const [seeds, diskSummary, rounds, frontier, graph, allArtifacts] = await Promise.all([
    readExpansionSeeds(outputDir),
    readJson(path.join(outputDir, 'expansion_summary.json'), {}),
    readJson(path.join(outputDir, 'expansion_rounds.json'), []),
    readJson(path.join(outputDir, 'expansion_frontier.json'), {}),
    readJson(path.join(outputDir, 'graph.json'), {}),
    enumerateArtifacts(outputDir),
  ]);
  const summary = { ...(diskSummary || {}), ...(runtime || {}) };
  const selected = new Set(Array.isArray(summary.seedPostIds) ? summary.seedPostIds.map(String) : []);
  const businessStatus = String(summary.status || 'idle');
  const runtimeStatus = String(summary.runtimeStatus || (businessStatus === 'complete' ? 'completed' : businessStatus));
  const seedItems = seeds.map((seed) => ({
    ...seed,
    selected: selected.has(seed.postId),
    expansionStatus: selected.has(seed.postId) ? (runtimeStatus === 'running' ? 'expanding' : 'used') : 'available',
  }));
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const sourceRows = kind === 'relations'
    ? (Array.isArray(graph?.edges) ? graph.edges : [])
    : nodes.filter((item) => String(item?.type || '').toLowerCase() === kind.slice(0, -1));
  const rows = sourceRows.filter((item) => {
    const itemRound = String(item?.roundIndex ?? item?.round ?? '');
    const itemStatus = String(item?.profileStatus ?? item?.commentStatus ?? item?.state ?? item?.status ?? '');
    const itemSeed = String(item?.sourceSeedPostId ?? '');
    return (!roundFilter || itemRound === roundFilter)
      && (!statusFilter || itemStatus === statusFilter)
      && (!seedFilter || itemSeed === seedFilter);
  });
  const counters = summary.counters && typeof summary.counters === 'object' ? summary.counters : {};
  const roundItems = Array.isArray(rounds) ? rounds : [];
  const timeBudgetMinutes = Number(summary.config?.timeBudgetMinutes ?? summary.budgets?.timeBudgetMinutes ?? 0);
  const elapsedMinutes = summary.startedAt ? Math.max(0, (Date.now() - Date.parse(summary.startedAt)) / 60000) : 0;
  return {
    available: Boolean(seeds.length),
    status: runtimeStatus,
    runtimeStatus,
    businessStatus,
    stopReason: String(summary.stopReason || ''),
    resumable: actionState(runtimeStatus) === 'resumable',
    hasResults: rows.length > 0 || roundItems.length > 0 || allArtifacts.some((item) => ARTIFACTS.has(item.path.replaceAll('\\', '/'))),
    actionState: actionState(runtimeStatus),
    summary,
    seeds: seedItems,
    config: summary.config || summary.budgets || null,
    metrics: {
      rounds: Number(summary.completedRounds || 0),
      currentRound: Number(summary.roundIndex ?? summary.currentRoundIndex ?? 0),
      frontier: Number(summary.frontierCount ?? frontier?.frontier?.length ?? frontier?.items?.length ?? 0),
      users: Number(counters.users ?? summary.usersDiscovered ?? 0),
      expandedUsers: roundItems.reduce((total, item) => total + Number(item?.expandedUserCount || 0), 0),
      posts: Number(counters.posts ?? summary.postsTotal ?? 0),
      comments: Number(counters.comments ?? summary.commentsCollected ?? 0),
      duplicates: Number(summary.duplicateUserCount || 0),
      failures: Number(summary.failureCount || 0),
      remainingMinutes: timeBudgetMinutes ? Math.max(0, Math.ceil(timeBudgetMinutes - elapsedMinutes)) : null,
    },
    rounds: roundItems,
    results: {
      kind, total: rows.length, offset, limit, items: rows.slice(offset, offset + limit),
      filters: { round: roundFilter, status: statusFilter, seed: seedFilter },
    },
    artifacts: allArtifacts.filter((item) => ARTIFACTS.has(item.path.replaceAll('\\', '/'))),
  };
}

function actionState(status) {
  if (status === 'running' || status === 'cancelling') return 'running';
  if (['partial', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status)) return 'resumable';
  if (status === 'completed' || status === 'complete') return 'completed';
  return 'ready';
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function boundedInteger(raw, fallback, min, max) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
