import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { materializeAudienceResults, readAudienceResults } from './lib/audience-results.mjs';

test('audience results merge public profile enrichment into comment cards', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-results-'));
  try {
    await Promise.all([
      writeFile(path.join(outputDir, 'audience-summary.json'), JSON.stringify({
        status: 'partial', postsTotal: 2, postsComplete: 1, commentsCollected: 2,
        usersDiscovered: 2, profilesComplete: 1,
      }), 'utf8'),
      writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
        { post_id: 'post-1', title: '第一篇', status: 'complete' },
        { post_id: 'post-2', title: '第二篇', status: 'partial' },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([
        { comment_id: 'comment-1', post_id: 'post-1', text: '很有帮助', parent_comment_id: '', user: { user_id: 'user-1', display_name: '旧名称' } },
        { comment_id: 'reply-1', post_id: 'post-2', text: '楼中楼', parent_comment_id: 'root-2', user: { user_id: 'user-2', display_name: '用户二' } },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([
        { user_id: 'user-1', display_name: '用户一', xhs_id: 'xiaohongshu-1', bio: '公开简介', ip_location: '上海', roles: ['commenter'], post_ids: ['post-1'], enrichment_status: 'complete' },
        { user_id: 'user-2', display_name: '用户二', roles: ['author', 'commenter'], post_ids: ['post-2'], enrichment_status: 'partial' },
      ]), 'utf8'),
    ]);

    const comments = await readAudienceResults(outputDir, new URLSearchParams({
      kind: 'comments', postId: 'post-1', query: 'xiaohongshu-1', limit: '10',
    }));
    assert.equal(comments.total, 1);
    assert.equal(comments.items[0].post_title, '第一篇');
    assert.equal(comments.items[0].user.display_name, '用户一');
    assert.equal(comments.items[0].user.bio, '公开简介');
    assert.equal(comments.items[0].user.ip_location, '上海');

    const usersByIpLocation = await readAudienceResults(outputDir, new URLSearchParams({
      kind: 'users', query: '上海', limit: '10',
    }));
    assert.equal(usersByIpLocation.total, 1);
    assert.equal(usersByIpLocation.items[0].display_name, '用户一');

    const users = await readAudienceResults(outputDir, new URLSearchParams({
      kind: 'users', postId: 'post-2', offset: '0', limit: '1',
    }));
    assert.equal(users.total, 1);
    assert.deepEqual(users.items[0].roles, ['author', 'commenter']);
    assert.equal(users.summary.status, 'partial');
    assert.equal(users.totals.comments, 2);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
test('audience results return an explicit pending state before collection starts', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-empty-'));
  try {
    const result = await readAudienceResults(outputDir);
    assert.equal(result.available, false);
    assert.equal(result.summary.status, 'pending');
    assert.equal(result.total, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('audience results expose saved note checkpoints as uncollected post targets', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-targets-'));
  try {
    await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
      { note_id: 'post-1', title: 'First post', note_url: 'https://example.test/explore/post-1' },
      { note_id: 'post-2', title: 'Second post', note_url: 'https://example.test/explore/post-2' },
    ]), 'utf8');

    const result = await readAudienceResults(outputDir);
    assert.equal(result.available, true);
    assert.equal(result.summary.status, 'pending');
    assert.equal(result.summary.postsTotal, 2);
    assert.equal(result.summary.postsPending, 2);
    assert.equal(result.summary.postsUncollected, 2);
    assert.equal(result.summary.postsAttempted, 0);
    assert.equal(result.summary.postsWithComments, 0);
    assert.deepEqual(result.posts.map((post) => post.collectionStatus), ['uncollected', 'uncollected']);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('audience results use the complete content-insight link set as the three-state denominator', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-content-insight-'));
  try {
    await Promise.all([
      writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({ records: [
        { note_id: 'post-1', title: 'First post', note_url: 'https://example.test/explore/post-1' },
        { note_id: 'post-2', title: 'Second post', note_url: 'https://example.test/explore/post-2' },
        { note_id: 'post-3', title: 'Third post', note_url: 'https://example.test/explore/post-3' },
      ] }), 'utf8'),
      writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([
        { note_id: 'post-1', note_url: 'https://example.test/explore/post-1', author: 'Author one', author_profile: 'https://example.test/user/profile/author-1', comment_count: 5 },
        { note_id: 'post-2', note_url: 'https://example.test/explore/post-2', author: 'Author two', author_profile: 'https://example.test/user/profile/author-2' },
        { note_id: 'post-3', note_url: 'https://example.test/explore/post-3', author: 'Author three', author_profile: 'https://example.test/user/profile/author-3' },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
        { note_id: 'post-1', title: 'Only collected body', note_url: 'https://example.test/explore/post-1' },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
        { post_id: 'post-1', status: 'partial', collected_comment_count: 1 },
        { post_id: 'orphan', status: 'complete', collected_comment_count: 1 },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([
        { comment_id: 'comment-1', post_id: 'post-1', user: { user_id: 'user-1' } },
        { comment_id: 'orphan-comment', post_id: 'orphan', user: { user_id: 'orphan-user' } },
      ]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([
        { user_id: 'user-1', post_ids: ['post-1'], enrichment_status: 'partial' },
        { user_id: 'orphan-user', post_ids: ['orphan'], enrichment_status: 'complete' },
      ]), 'utf8'),
    ]);

    const result = await materializeAudienceResults(outputDir);
    assert.equal(result.summary.postsTotal, 3);
    assert.equal(result.summary.postsUncollected, 2);
    assert.equal(result.summary.postsPartial, 1);
    assert.equal(result.summary.postsComplete, 0);
    assert.deepEqual(result.posts.map((post) => post.collectionStatus), ['partial', 'uncollected', 'uncollected']);
    assert.equal(result.posts[0].author.user_id, 'author-1');
    assert.equal(result.totals.comments, 1);
    assert.equal(result.totals.users, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('audience results merge a supplement with its source checkpoint without hiding old rows', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-source-'));
  const supplementDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-supplement-'));
  try {
    await Promise.all([
      writeFile(path.join(sourceDir, 'xiaohongshu_notes_latest.json'), JSON.stringify([
        { note_id: 'post-1', title: 'First post', note_url: 'https://example.test/explore/post-1' },
        { note_id: 'post-2', title: 'Second post', note_url: 'https://example.test/explore/post-2' },
      ]), 'utf8'),
      writeFile(path.join(sourceDir, 'audience-posts.json'), JSON.stringify([
        { post_id: 'post-1', title: 'First post', status: 'complete', collected_comment_count: 1 },
      ]), 'utf8'),
      writeFile(path.join(sourceDir, 'audience-comments.json'), JSON.stringify([
        { comment_id: 'comment-1', post_id: 'post-1', text: 'Saved comment', user: { user_id: 'user-1' } },
      ]), 'utf8'),
      writeFile(path.join(sourceDir, 'audience-users.json'), JSON.stringify([
        { user_id: 'user-1', display_name: 'Saved user', enrichment_status: 'complete', post_ids: ['post-1'] },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-posts.json'), JSON.stringify([
        { post_id: 'post-2', title: 'Second post', status: 'partial', collected_comment_count: 1 },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-comments.json'), JSON.stringify([
        { comment_id: 'comment-2', post_id: 'post-2', text: 'New comment', user: { user_id: 'user-2' } },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-users.json'), JSON.stringify([
        { user_id: 'user-2', display_name: 'New user', enrichment_status: 'partial', post_ids: ['post-2'] },
      ]), 'utf8'),
    ]);

    const result = await readAudienceResults(supplementDir, new URLSearchParams({ limit: '10' }), {
      fallbackOutputDirs: [sourceDir],
    });
    assert.equal(result.summary.postsTotal, 2);
    assert.equal(result.summary.postsComplete, 1);
    assert.equal(result.summary.postsPartial, 1);
    assert.equal(result.totals.comments, 2);
    assert.equal(result.totals.users, 2);
    assert.deepEqual(result.items.map((comment) => comment.comment_id), ['comment-1', 'comment-2']);
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(supplementDir, { recursive: true, force: true }),
    ]);
  }
});

test('audience results keep verified profile fields when a later checkpoint contains an empty discovery record', async () => {
  const enrichedDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-enriched-'));
  const staleDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-stale-'));
  try {
    await Promise.all([
      writeFile(path.join(enrichedDir, 'audience-users.json'), JSON.stringify([{
        user_id: 'user-1',
        display_name: 'Star11',
        following_count: 5,
        follower_count: 44,
        liked_and_collected_count: 180,
        ip_location: '上海',
        location: '上海',
        enrichment_status: 'complete',
        access_status: 'public_profile_ok',
        last_enriched_at: '2026-07-31T05:57:11Z',
        roles: ['author'],
      }]), 'utf8'),
      writeFile(path.join(staleDir, 'audience-users.json'), JSON.stringify([{
        user_id: 'user-1',
        display_name: 'Star11',
        following_count: null,
        follower_count: null,
        liked_and_collected_count: null,
        ip_location: '',
        location: '',
        enrichment_status: 'pending',
        access_status: 'discovered',
        last_enriched_at: '',
        roles: ['commenter'],
      }]), 'utf8'),
    ]);

    const result = await readAudienceResults(staleDir, new URLSearchParams({
      kind: 'users', query: 'Star11', limit: '10',
    }), { fallbackOutputDirs: [enrichedDir] });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].following_count, 5);
    assert.equal(result.items[0].follower_count, 44);
    assert.equal(result.items[0].liked_and_collected_count, 180);
    assert.equal(result.items[0].ip_location, '上海');
    assert.equal(result.items[0].enrichment_status, 'complete');
    assert.equal(result.items[0].access_status, 'public_profile_ok');
    assert.deepEqual(result.items[0].roles, ['author', 'commenter']);
  } finally {
    await Promise.all([
      rm(enrichedDir, { recursive: true, force: true }),
      rm(staleDir, { recursive: true, force: true }),
    ]);
  }
});

test('audience checkpoint merging is monotonic and derives post progress from merged comments', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-monotonic-source-'));
  const supplementDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-monotonic-supplement-'));
  try {
    await Promise.all([
      writeFile(path.join(sourceDir, 'audience-posts.json'), JSON.stringify([
        {
          post_id: 'post-complete', title: 'Keep this title', note_url: 'https://example.test/complete',
          status: 'complete', collected_comment_count: 7, top_level_count: 5,
          author: { user_id: 'author-1', display_name: 'Saved author', enrichment_status: 'complete' },
        },
        {
          post_id: 'post-partial', title: 'Partially collected', note_url: 'https://example.test/partial',
          status: 'pending', expected_comment_count: 5, collected_comment_count: 0,
        },
        {
          post_id: 'post-reached-expected', title: 'Reached expected count', note_url: 'https://example.test/reached',
          status: 'partial', expected_comment_count: 2, collected_comment_count: 1,
        },
      ]), 'utf8'),
      writeFile(path.join(sourceDir, 'audience-comments.json'), JSON.stringify([
        {
          comment_id: 'comment-saved', post_id: 'post-complete', text: 'Keep this comment', like_count: 12,
          user: { user_id: 'user-1', display_name: 'Saved commenter', enrichment_status: 'complete' },
        },
        { comment_id: 'comment-reached-1', post_id: 'post-reached-expected', text: 'First' },
      ]), 'utf8'),
      writeFile(path.join(sourceDir, 'audience-users.json'), JSON.stringify([
        {
          user_id: 'user-1', display_name: 'Saved commenter', bio: 'Keep this bio', follower_count: 20,
          enrichment_status: 'complete', roles: ['commenter'], post_ids: ['post-complete'],
        },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-posts.json'), JSON.stringify([
        {
          post_id: 'post-complete', title: '', note_url: '', status: 'pending', collected_comment_count: 1,
          top_level_count: 0, author: { user_id: 'author-1', display_name: '', enrichment_status: 'pending' },
        },
        { post_id: 'post-partial', status: 'pending', collected_comment_count: 0 },
        { post_id: 'post-reached-expected', status: 'pending', collected_comment_count: 0 },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-comments.json'), JSON.stringify([
        {
          comment_id: 'comment-saved', post_id: 'post-complete', text: '', like_count: 2,
          user: { user_id: 'user-1', display_name: '', enrichment_status: 'pending' },
        },
        { comment_id: 'comment-partial', post_id: 'post-partial', text: 'Collected later' },
        { comment_id: 'comment-reached-2', post_id: 'post-reached-expected', text: 'Second' },
      ]), 'utf8'),
      writeFile(path.join(supplementDir, 'audience-users.json'), JSON.stringify([
        {
          user_id: 'user-1', display_name: '', bio: '', follower_count: 3,
          enrichment_status: 'pending', roles: [], post_ids: [],
        },
      ]), 'utf8'),
    ]);

    const result = await materializeAudienceResults(supplementDir, { fallbackOutputDirs: [sourceDir] });
    const posts = new Map(result.posts.map((post) => [post.post_id, post]));
    const comments = new Map(result.comments.map((comment) => [comment.comment_id, comment]));
    const users = new Map(result.users.map((user) => [user.user_id, user]));

    assert.equal(posts.get('post-complete').status, 'complete');
    assert.equal(posts.get('post-complete').collectionStatus, 'complete');
    assert.equal(posts.get('post-complete').collected_comment_count, 7);
    assert.equal(posts.get('post-complete').top_level_count, 5);
    assert.equal(posts.get('post-complete').title, 'Keep this title');
    assert.equal(posts.get('post-complete').note_url, 'https://example.test/complete');
    assert.equal(posts.get('post-complete').author.display_name, 'Saved author');
    assert.equal(posts.get('post-complete').author.enrichment_status, 'complete');

    assert.equal(posts.get('post-partial').status, 'partial');
    assert.equal(posts.get('post-partial').collectionStatus, 'partial');
    assert.equal(posts.get('post-partial').collected_comment_count, 1);
    assert.equal(posts.get('post-reached-expected').status, 'complete');
    assert.equal(posts.get('post-reached-expected').collectionStatus, 'complete');
    assert.equal(posts.get('post-reached-expected').collected_comment_count, 2);

    assert.equal(comments.get('comment-saved').text, 'Keep this comment');
    assert.equal(comments.get('comment-saved').like_count, 12);
    assert.equal(comments.get('comment-saved').user.display_name, 'Saved commenter');
    assert.equal(comments.get('comment-saved').user.enrichment_status, 'complete');
    assert.equal(users.get('user-1').bio, 'Keep this bio');
    assert.equal(users.get('user-1').follower_count, 20);
    assert.equal(users.get('user-1').enrichment_status, 'complete');
    assert.deepEqual(users.get('user-1').roles, ['commenter']);
    assert.deepEqual(users.get('user-1').post_ids, ['post-complete']);
    assert.equal(result.summary.postsComplete, 2);
    assert.equal(result.summary.postsPartial, 1);
    assert.equal(result.summary.postsPending, 0);
    assert.equal(result.summary.postsAttempted, 3);
    assert.equal(result.summary.postsWithComments, 3);
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(supplementDir, { recursive: true, force: true }),
    ]);
  }
});
