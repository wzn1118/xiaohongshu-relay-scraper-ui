import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCopilotContextSourceId,
  filterRowsByContextSelection,
  normalizeCopilotContextSourceIds,
  parseCopilotContextSourceId,
} from './copilot-context-source.mjs';

test('context source IDs round-trip and reject records from another task', () => {
  const sourceId = createCopilotContextSourceId('job-001', 'posts', 'note/001', 'body');
  assert.deepEqual(parseCopilotContextSourceId(sourceId), {
    sourceId,
    jobId: 'job-001',
    kind: 'posts',
    recordId: 'note/001',
    section: 'body',
  });
  assert.deepEqual(normalizeCopilotContextSourceIds([sourceId, sourceId], { jobId: 'job-001' }), [sourceId]);
  assert.throws(
    () => normalizeCopilotContextSourceIds([sourceId], { jobId: 'job-002' }),
    (error) => error.code === 'COPILOT_CONTEXT_JOB_MISMATCH',
  );
});

test('record selection filters rows and body selection exposes only body-related fields', () => {
  const rows = [
    {
      noteId: 'note-001', title: 'First', body: 'Full body', media: { images: ['one.jpg'] },
      analysis: { score: 92 }, secretExtra: 'must not leak',
    },
    { noteId: 'note-002', title: 'Second', body: 'Other body', secretExtra: 'other' },
  ];
  const sourceId = createCopilotContextSourceId('job-001', 'posts', 'note-001', 'body');
  const filtered = filterRowsByContextSelection(rows, 'applications', [sourceId], 'job-001');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].noteId, 'note-001');
  assert.equal(filtered[0].body, 'Full body');
  assert.equal(filtered[0].title, 'First');
  assert.equal(Object.hasOwn(filtered[0], 'media'), false);
  assert.equal(Object.hasOwn(filtered[0], 'analysis'), false);
  assert.equal(Object.hasOwn(filtered[0], 'secretExtra'), false);
});

test('audience section selects only comments and users related to one post', () => {
  const sourceId = createCopilotContextSourceId('job-001', 'posts', 'note-001', 'audience');
  const comments = filterRowsByContextSelection([
    { commentId: 'comment-001', postId: 'note-001', text: 'Included' },
    { commentId: 'comment-002', postId: 'note-002', text: 'Excluded' },
  ], 'comments', [sourceId], 'job-001');
  const users = filterRowsByContextSelection([
    { userId: 'user-001', postIds: ['note-001'] },
    { userId: 'user-002', postIds: ['note-002'] },
  ], 'users', [sourceId], 'job-001');
  assert.deepEqual(comments.map((item) => item.commentId), ['comment-001']);
  assert.deepEqual(users.map((item) => item.userId), ['user-001']);
});

test('legacy aggregate and opaque source IDs remain readable', () => {
  const rows = [{ noteId: 'note-001' }, { noteId: 'note-002' }];
  assert.equal(filterRowsByContextSelection(rows, 'applications', ['dataset:content'], 'job-001').length, 2);
  assert.equal(filterRowsByContextSelection(rows, 'applications', ['application-001'], 'job-001').length, 2);
  assert.deepEqual(
    normalizeCopilotContextSourceIds(['application-001'], { jobId: 'job-001' }),
    ['application-001'],
  );
});
