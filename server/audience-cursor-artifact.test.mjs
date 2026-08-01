import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAudienceResults } from './lib/audience-results.mjs';

test('audience API preserves cursor recovery fields and legacy result fields', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-cursor-artifact-'));
  try {
    await Promise.all([
      writeFile(path.join(outputDir, 'audience-summary.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'partial',
        commentsCollected: 1,
        resumeStrategyCounts: { anchor_comment: 1 },
        repeatedRequests: 2,
        duplicateCommentsSeen: 4,
        performancePenalty: 25,
      }), 'utf8'),
      writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([{
        post_id: 'post-1',
        title: 'Existing title',
        note_url: 'https://example.test/explore/post-1',
        status: 'partial',
        collected_comment_count: 1,
        comment_status: 'partial_timeout',
        comment_cursor: 'cursor-3',
        comment_page: 3,
        reply_cursor: 'reply-2',
        has_more_comments: true,
        comments_collected: 1,
        replies_collected: 0,
        last_visible_comment_id: 'comment-1',
        last_successful_cursor: 'cursor-2',
        attempt_count: 2,
        stop_reason: 'runner_timeout',
        resume_strategy: 'anchor_comment',
        fallback_reason: 'relay_cursor_resume_unavailable',
        repeated_requests: 2,
        duplicate_comments_seen: 4,
        resumed_from_anchor: 'comment-1',
        performance_penalty: 25,
        reply_threads: {
          'comment-1': {
            comment_id: 'comment-1', reply_status: 'running', reply_cursor: 'reply-2',
            has_more_replies: true, replies_collected: 0, attempt_count: 1,
          },
        },
      }]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([{
        comment_id: 'comment-1', post_id: 'post-1', text: 'Existing comment',
        user: { user_id: 'user-1', display_name: 'Existing user' },
      }]), 'utf8'),
      writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([{
        user_id: 'user-1', display_name: 'Existing user', enrichment_status: 'partial',
        profile_status: 'partial_verification', profile_attempt_count: 2,
        user_post_cursor: 'user-post-3', failure_code: 'security_verification',
      }]), 'utf8'),
    ]);

    const result = await readAudienceResults(outputDir);
    const post = result.posts[0];
    const user = result.items[0].user;
    assert.equal(post.title, 'Existing title');
    assert.equal(post.status, 'partial');
    assert.equal(post.comment_status, 'partial_timeout');
    assert.equal(post.comment_cursor, 'cursor-3');
    assert.equal(post.comment_page, 3);
    assert.equal(post.resume_strategy, 'anchor_comment');
    assert.equal(post.fallback_reason, 'relay_cursor_resume_unavailable');
    assert.equal(post.reply_threads['comment-1'].reply_cursor, 'reply-2');
    assert.equal(user.profile_status, 'partial_verification');
    assert.equal(user.user_post_cursor, 'user-post-3');
    assert.deepEqual(result.summary.resumeStrategyCounts, { anchor_comment: 1 });
    assert.equal(result.summary.repeatedRequests, 2);
    assert.equal(result.summary.duplicateCommentsSeen, 4);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
