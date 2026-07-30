import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readAudienceResults } from './lib/audience-results.mjs';

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
        { user_id: 'user-1', display_name: '用户一', xhs_id: 'xiaohongshu-1', bio: '公开简介', roles: ['commenter'], post_ids: ['post-1'], enrichment_status: 'complete' },
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
