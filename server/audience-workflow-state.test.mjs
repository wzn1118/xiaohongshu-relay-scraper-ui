import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyWorkflowStages, readWorkflowState } from './lib/workflow-state.mjs';

test('Node validates detailed audience cursor, reply thread, and profile checkpoints', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-cursor-state-'));
  const statePath = path.join(directory, 'workflow-state.json');
  try {
    const stages = emptyWorkflowStages();
    stages.audience = {
      ...stages.audience,
      status: 'partial',
      posts: {
        'post-1': {
          postId: 'post-1', commentStatus: 'partial_timeout', commentCursor: 'cursor-3',
          commentPage: 3, replyCursor: 'reply-3', hasMoreComments: true,
          commentsCollected: 5, repliesCollected: 2, attemptCount: 2,
          repeatedRequests: 2, duplicateCommentsSeen: 5,
          resumeStrategy: 'anchor_comment', fallbackReason: 'relay_cursor_resume_unavailable',
        },
      },
      replyThreads: {
        'post-1:comment-1': {
          postId: 'post-1', commentId: 'comment-1', replyStatus: 'running',
          replyCursor: 'reply-3', hasMoreReplies: true, repliesCollected: 2, attemptCount: 2,
        },
      },
      users: {
        'user-1': {
          userId: 'user-1', profileStatus: 'partial_verification', attemptCount: 2,
          userPostCursor: 'user-post-4', failureCode: 'security_verification', recoverable: true,
        },
      },
      postsTotal: 1,
      postsCompleted: 0,
      usersTotal: 1,
      usersCompleted: 0,
    };
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 2,
      jobId: 'logical-job',
      revision: 8,
      attempts: [],
      stages,
    })}\n`, 'utf8');

    const state = await readWorkflowState(statePath);
    assert.equal(state.jobId, 'logical-job');
    assert.equal(state.stages.audience.posts['post-1'].commentCursor, 'cursor-3');
    assert.equal(state.stages.audience.replyThreads['post-1:comment-1'].replyCursor, 'reply-3');
    assert.equal(state.stages.audience.users['user-1'].userPostCursor, 'user-post-4');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy audience statuses normalize without changing logical job identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-legacy-state-'));
  const statePath = path.join(directory, 'workflow-state.json');
  try {
    const stages = emptyWorkflowStages();
    Object.assign(stages.audience, {
      status: 'completed',
      posts: { old: { commentStatus: 'complete' } },
      users: { old: { profileStatus: 'complete' } },
      postsTotal: 1, postsCompleted: 1, usersTotal: 1, usersCompleted: 1,
    });
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 2, jobId: 'same-job', revision: 4, attempts: [], stages,
    })}\n`, 'utf8');
    const state = await readWorkflowState(statePath);
    assert.equal(state.jobId, 'same-job');
    assert.equal(state.stages.audience.posts.old.commentStatus, 'complete_reachable');
    assert.equal(state.stages.audience.users.old.profileStatus, 'complete_reachable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
