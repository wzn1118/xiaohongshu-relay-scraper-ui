import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readExpansionSeeds, readExpansionSnapshot } from './lib/expansion-results.mjs';

test('expansion snapshot is task-local, paged, and merges persisted runtime state', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-expansion-results-'));
  try {
    await writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-1', title: 'Seed one', note_url: 'https://www.xiaohongshu.com/explore/post-1', cover_url: 'https://sns-webpic-qc.xhscdn.com/post-1.webp', status: 'partial', collected_comment_count: 2 },
      { post_id: 'post-2', title: 'Seed two', note_url: 'https://www.xiaohongshu.com/explore/post-2', status: 'complete', collected_comment_count: 8 },
      { post_id: 'post-3', title: 'Seed unavailable', note_url: '', status: 'partial', collected_comment_count: 0 },
    ]), 'utf8');
    await writeFile(path.join(outputDir, 'audience-comments.json'), '[]', 'utf8');
    await writeFile(path.join(outputDir, 'audience-users.json'), '[]', 'utf8');
    await writeFile(path.join(outputDir, 'expansion_summary.json'), JSON.stringify({ status: 'partial', completedRounds: 1, counters: { users: 2, posts: 1, comments: 4 } }), 'utf8');
    await writeFile(path.join(outputDir, 'expansion_rounds.json'), JSON.stringify([{ roundIndex: 1, usersCompleted: 2 }]), 'utf8');
    await writeFile(path.join(outputDir, 'expansion_frontier.json'), JSON.stringify({ frontier: ['u-2'] }), 'utf8');
    await writeFile(path.join(outputDir, 'graph.json'), JSON.stringify({
      nodes: [
        { type: 'USER', userId: 'u-1', roundIndex: 1, profileStatus: 'complete_reachable', sourceSeedPostId: 'post-1' },
        { type: 'USER', userId: 'u-2', roundIndex: 2, profileStatus: 'partial_limit', sourceSeedPostId: 'post-2' },
        { type: 'POST', postId: 'p-1' },
      ],
      edges: [{ type: 'COMMENTED_ON', sourceId: 'u-1', targetId: 'post-1' }],
    }), 'utf8');
    await writeFile(path.join(outputDir, 'users.csv'), 'userId\nu-1\n', 'utf8');
    await writeFile(path.join(outputDir, 'unrelated.txt'), 'not an expansion export', 'utf8');

    const seeds = await readExpansionSeeds(outputDir);
    assert.deepEqual(seeds.map((seed) => seed.postId), ['post-1', 'post-2', 'post-3']);
    assert.equal(seeds[0].coverUrl, 'https://sns-webpic-qc.xhscdn.com/post-1.webp');
    assert.equal(seeds[2].available, false);
    assert.match(seeds[2].unavailableReason, /链接/);
    const snapshot = await readExpansionSnapshot(outputDir, new URLSearchParams('kind=users&offset=1&limit=1'), {
      runtimeStatus: 'running', seedPostIds: ['post-1'], config: { rounds: 2 },
    });
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.runtimeStatus, 'running');
    assert.equal(snapshot.businessStatus, 'partial');
    assert.equal(snapshot.resumable, false);
    assert.equal(snapshot.hasResults, true);
    assert.equal(snapshot.actionState, 'running');
    assert.equal(snapshot.seeds[0].expansionStatus, 'expanding');
    assert.equal(snapshot.seeds[1].expansionStatus, 'available');
    assert.equal(snapshot.results.total, 2);
    assert.equal(snapshot.results.items[0].userId, 'u-2');
    assert.deepEqual(snapshot.metrics, { rounds: 1, currentRound: 0, frontier: 1, users: 2, expandedUsers: 0, posts: 1, comments: 4, duplicates: 0, failures: 0, remainingMinutes: null });
    assert.ok(snapshot.artifacts.some((artifact) => artifact.path === 'graph.json'));
    assert.ok(snapshot.artifacts.some((artifact) => artifact.path === 'users.csv'));
    assert.equal(snapshot.artifacts.some((artifact) => artifact.path === 'unrelated.txt'), false);

    const filtered = await readExpansionSnapshot(outputDir, new URLSearchParams('kind=users&round=1&status=complete_reachable&seed=post-1'));
    assert.equal(filtered.results.total, 1);
    assert.equal(filtered.results.items[0].userId, 'u-1');
    assert.deepEqual(filtered.results.filters, { round: '1', status: 'complete_reachable', seed: 'post-1' });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('expansion result paging never renders a thousand-node graph in one response', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-expansion-large-'));
  try {
    await writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'seed-1', title: 'Seed', note_url: 'https://www.xiaohongshu.com/explore/seed-1', status: 'complete' },
    ]), 'utf8');
    await writeFile(path.join(outputDir, 'audience-comments.json'), '[]', 'utf8');
    await writeFile(path.join(outputDir, 'audience-users.json'), '[]', 'utf8');
    await writeFile(path.join(outputDir, 'graph.json'), JSON.stringify({
      nodes: Array.from({ length: 1005 }, (_, index) => ({ type: 'USER', userId: `user-${index + 1}`, roundIndex: 1 })),
      edges: [],
    }), 'utf8');

    const first = await readExpansionSnapshot(outputDir, new URLSearchParams('kind=users&offset=0&limit=50'));
    const last = await readExpansionSnapshot(outputDir, new URLSearchParams('kind=users&offset=1000&limit=50'));
    assert.equal(first.results.total, 1005);
    assert.equal(first.results.items.length, 50);
    assert.equal(last.results.items.length, 5);
    assert.equal(last.results.items[0].userId, 'user-1001');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
