import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  enrichApplicationRecordContacts,
  resolveApplicationContacts,
  resolveApplicationContactsBatch,
} from './lib/application-contact-resolver.mjs';

async function fixtureDir(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-contact-resolver-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return outputDir;
}

function applicationRecord(applicationInfo = {}) {
  return {
    note_id: 'post-1',
    note_url: 'https://www.xiaohongshu.com/explore/post-1',
    title: '产品经理实习生',
    application_info: {
      contacts: [],
      application_routes: [],
      ...applicationInfo,
    },
  };
}

async function writeAudience(outputDir, { posts = [], comments = [] } = {}) {
  await Promise.all([
    writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify(posts), 'utf8'),
    writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify(comments), 'utf8'),
  ]);
}

test('a verified body email wins without reading comment artifacts', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeFile(path.join(outputDir, 'audience-comments.json'), '{invalid', 'utf8');
  const result = await resolveApplicationContacts(applicationRecord({
    contacts: [{
      type: 'email',
      channel: 'email',
      value: 'Jobs@Example.com',
      evidence: '请将简历投递至 Jobs@Example.com',
      source_field: 'body',
      verification_status: 'body_verified',
      confidence: 98,
      actionable: true,
    }],
  }), { outputDir });

  assert.equal(result.status, 'ready');
  assert.equal(result.commentFallbackUsed, false);
  assert.equal(result.selectedCandidate.address, 'jobs@example.com');
  assert.equal(result.selectedCandidate.source, 'body');
  assert.equal(result.selectedCandidate.confidence, 98);
  assert.equal(result.selectedCandidate.collectionStatus, 'complete');
  assert.match(result.selectedCandidate.evidenceHash, /^[a-f0-9]{64}$/u);
});

test('an all-body-email batch skips the comment artifact entirely', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeFile(path.join(outputDir, 'audience-comments.json'), '{invalid', 'utf8');
  const records = ['first@example.com', 'second@example.com'].map((address, index) => ({
    ...applicationRecord({
      contacts: [{
        type: 'email',
        value: address,
        evidence: `Apply at ${address}`,
        source_field: 'body',
        verification_status: 'body_verified',
        confidence: 98,
        actionable: true,
      }],
    }),
    note_id: `post-${index + 1}`,
    note_url: `https://www.xiaohongshu.com/explore/post-${index + 1}`,
  }));

  const results = await resolveApplicationContactsBatch(records, { outputDir });

  assert.deepEqual(results.map((result) => result.status), ['ready', 'ready']);
  assert.deepEqual(results.map((result) => result.selectedCandidate.address), [
    'first@example.com',
    'second@example.com',
  ]);
  assert.deepEqual(results.map((result) => result.commentFallbackUsed), [false, false]);
});

test('an actionable image route is retained as an image candidate', async () => {
  const result = await resolveApplicationContacts(applicationRecord({
    application_routes: [{
      type: 'email',
      channel: 'email',
      value: 'image@example.com',
      evidence: '图片文字：image@example.com',
      source_field: 'image',
      source_image_index: 1,
      verification_status: 'image_format_verified',
      confidence: 87,
      actionable: true,
    }],
  }));

  assert.equal(result.status, 'ready');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'image');
  assert.deepEqual(result.candidates[0].sourceFields, ['image']);
});

test('normalizes keycap digits, spacing, and Chinese QQ domain aliases in post text', async () => {
  const evidence = '仅限27、28届，简历fa：📮 1️⃣3️⃣9️⃣6️⃣33450 6️⃣@扣扣点com，标题备注岗位-姓名';
  const result = await resolveApplicationContacts({
    ...applicationRecord(),
    body: evidence,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.selectedCandidate.address, '1396334506@qq.com');
  assert.equal(result.selectedCandidate.source, 'body');
  assert.equal(result.selectedCandidate.confidence, 90);
  assert.equal(result.selectedCandidate.verificationStatus, 'body_format_normalized');
  assert.equal(result.selectedCandidate.normalizationApplied, true);
  assert.equal(result.selectedCandidate.evidenceText, evidence);
});

test('enriches a legacy result record so the product can display the normalized email', () => {
  const evidence = '简历fa：📮1️⃣3️⃣9️⃣6️⃣33450 6️⃣@扣扣点com';
  const record = enrichApplicationRecordContacts({
    ...applicationRecord(),
    body: evidence,
  });

  assert.equal(record.application_info.contacts[0].value, '1396334506@qq.com');
  assert.equal(record.application_info.contacts[0].source_field, 'body');
  assert.equal(record.application_info.contacts[0].verification_status, 'body_format_normalized');
  assert.equal(record.application_info.contacts[0].normalization_applied, true);
  assert.equal(record.application_info.contacts[0].evidence, evidence);
});

test('normalizes full-width OCR letters and Chinese at/dot markers while retaining image evidence', async () => {
  const evidence = '投递📮：ｊｏｂｓ（艾特）扣扣（点）ｃｏｍ';
  const result = await resolveApplicationContacts({
    ...applicationRecord(),
    media: { analysis: { visible_text: evidence } },
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.selectedCandidate.address, 'jobs@qq.com');
  assert.equal(result.selectedCandidate.source, 'image');
  assert.equal(result.selectedCandidate.confidence, 80);
  assert.equal(result.selectedCandidate.verificationStatus, 'image_format_normalized');
  assert.equal(result.selectedCandidate.normalizationApplied, true);
  assert.equal(result.selectedCandidate.evidenceText, evidence);
});

test('normalizes an envelope emoji used between the local part and domain in image OCR', async () => {
  const evidence = '图片投递邮箱：talent📧example点com';
  const result = await resolveApplicationContacts({
    ...applicationRecord(),
    media: { images: [{ analysis: { visible_text: evidence } }] },
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.selectedCandidate.address, 'talent@example.com');
  assert.equal(result.selectedCandidate.source, 'image');
  assert.equal(result.selectedCandidate.verificationStatus, 'image_format_normalized');
  assert.equal(result.selectedCandidate.normalizationApplied, true);
  assert.equal(result.selectedCandidate.evidenceText, evidence);
});

test('scans alternate OCR fields used by image analysis artifacts', async () => {
  const evidence = '投递邮箱：candidate@163点com';
  const result = await resolveApplicationContacts({
    ...applicationRecord(),
    application_info: {
      contacts: [],
      application_routes: [],
      image_analysis: { ocr_text: evidence },
    },
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.selectedCandidate.address, 'candidate@163.com');
  assert.equal(result.selectedCandidate.source, 'image');
  assert.equal(result.selectedCandidate.verificationStatus, 'image_format_normalized');
  assert.equal(result.selectedCandidate.evidenceText, evidence);
});

test('normalizes reversible English at/dot separators in an author comment', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'complete', author: { user_id: 'author-1' } }],
    comments: [{
      comment_id: 'normalized-author-comment',
      post_id: 'post-1',
      text: '简历投递 jobs / at / q q / dot / com',
      user: { user_id: 'author-1' },
    }],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'author_comment_requires_approval');
  assert.equal(result.candidates[0].address, 'jobs@qq.com');
  assert.equal(result.candidates[0].source, 'author_comment');
  assert.equal(result.candidates[0].normalizationApplied, true);
  assert.equal(result.candidates[0].evidenceText, '简历投递 jobs / at / q q / dot / com');
});

test('comment fallback uses an exact post id and identifies the post author by id', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{
      post_id: 'post-1',
      status: 'partial',
      author: { user_id: 'author-1', display_name: 'Poster' },
    }],
    comments: [
      {
        comment_id: 'foreign-comment',
        post_id: 'post-10',
        text: '简历投递 foreign@example.com',
        user: { user_id: 'author-1' },
      },
      {
        comment_id: 'author-comment',
        post_id: 'post-1',
        text: '简历请投递 author@example.com',
        user: { user_id: 'author-1' },
      },
    ],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'author_comment_requires_approval');
  assert.equal(result.collectionStatus, 'partial');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].address, 'author@example.com');
  assert.equal(result.candidates[0].source, 'author_comment');
  assert.equal(result.candidates[0].commentId, 'author-comment');
  assert.equal(result.candidates[0].authorId, 'author-1');
  assert.equal(result.candidates[0].ownershipStatus, 'post_author_verified');
  assert.equal(result.candidates[0].actionable, false);
  assert.equal(result.selectedCandidate, null);
});

test('a third-party comment is distinguished and always requires review', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'complete', author: { user_id: 'author-1' } }],
    comments: [{
      comment_id: 'third-party-comment',
      post_id: 'post-1',
      text: '可以试试 thirdparty@example.com',
      user: { user_id: 'user-2' },
    }],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'third_party_comment_requires_review');
  assert.equal(result.candidates[0].source, 'other_comment');
  assert.equal(result.candidates[0].ownershipStatus, 'third_party');
  assert.ok(result.candidates[0].confidence < 50);
});

test('multiple distinct application emails are not selected automatically', async () => {
  const result = await resolveApplicationContacts(applicationRecord({
    contacts: [
      { type: 'email', value: 'first@example.com', actionable: true, verification_status: 'verified' },
      { type: 'email', value: 'second@example.com', actionable: true, verification_status: 'verified' },
    ],
  }));

  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'multiple_email_candidates');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.selectedCandidate, null);
  assert.ok(result.candidates.every((candidate) => candidate.requiresReview));
});

test('partial comment collection without an email remains pending rather than no_email', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'partial', collected_comment_count: 1 }],
    comments: [{ comment_id: 'comment-1', post_id: 'post-1', text: '请问还在招聘吗' }],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'pending');
  assert.equal(result.collectionStatus, 'partial');
  assert.equal(result.reason, 'comment_collection_incomplete');
  assert.equal(result.candidates.length, 0);
});

test('no_email is emitted only after a complete matching-post comment checkpoint', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'complete', collected_comment_count: 1 }],
    comments: [
      { comment_id: 'matching', post_id: 'post-1', text: '详情请看正文' },
      { comment_id: 'foreign', post_id: 'post-2', text: 'jobs@example.com' },
    ],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'no_email');
  assert.equal(result.collectionStatus, 'complete');
  assert.equal(result.reason, 'no_email_found');
});

test('masked or incomplete addresses are not guessed and require manual review', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'complete', author: { user_id: 'author-1' } }],
    comments: [{
      comment_id: 'masked',
      post_id: 'post-1',
      text: '邮箱 h***r@example.com、hr(at)example(dot) 或 hr@example',
      user: { user_id: 'author-1' },
    }],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'redacted_email_requires_review');
  assert.equal(result.collectionStatus, 'complete');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.redactedEvidence.length, 1);
  assert.match(result.redactedEvidence[0].evidenceHash, /^[a-f0-9]{64}$/u);
});

test('a masked address in the post remains reviewable while comments are unavailable', async () => {
  const result = await resolveApplicationContacts({
    ...applicationRecord(),
    post_id: '',
    note_id: '',
    note_url: '',
    body: '申请邮箱：j***s(at)example(dot)com',
  });

  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'redacted_email_requires_review');
  assert.equal(result.collectionStatus, 'pending');
  assert.equal(result.candidates.length, 0);
});

test('unknown or conflicting post ownership keeps comment emails in manual review', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'complete' }],
    comments: [{
      comment_id: 'unknown-owner',
      post_id: 'post-1',
      text: '简历发送至 unknown@example.com',
      user: { user_id: 'someone' },
    }],
  });

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'post_author_unknown');
  assert.equal(result.candidates[0].source, 'other_comment');
  assert.equal(result.candidates[0].ownershipStatus, 'post_author_unknown');
});

test('conflicting author ids across resumed checkpoints remain ambiguous', async (t) => {
  const sourceDir = await fixtureDir(t);
  const outputDir = await fixtureDir(t);
  await writeAudience(sourceDir, {
    posts: [{ post_id: 'post-1', status: 'complete', author: { user_id: 'author-1' } }],
    comments: [{
      comment_id: 'saved-comment',
      post_id: 'post-1',
      text: '简历投递 saved@example.com',
      user: { user_id: 'author-1' },
    }],
  });
  await writeAudience(outputDir, {
    posts: [{ post_id: 'post-1', status: 'partial', author: { user_id: 'author-2' } }],
    comments: [],
  });

  const result = await resolveApplicationContacts(applicationRecord(), {
    outputDir,
    fallbackOutputDirs: [sourceDir],
  });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'post_author_ambiguous');
  assert.equal(result.collectionStatus, 'complete');
  assert.equal(result.candidates[0].source, 'other_comment');
  assert.equal(result.candidates[0].ownershipStatus, 'post_author_ambiguous');
});

test('invalid audience JSON fails closed instead of reporting no_email', async (t) => {
  const outputDir = await fixtureDir(t);
  await Promise.all([
    writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([
      { post_id: 'post-1', status: 'complete' },
    ]), 'utf8'),
    writeFile(path.join(outputDir, 'audience-comments.json'), '{broken', 'utf8'),
  ]);

  const result = await resolveApplicationContacts(applicationRecord(), { outputDir });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'audience_artifact_invalid');
  assert.equal(result.issues[0].code, 'AUDIENCE_ARTIFACT_INVALID');
  assert.equal(result.issues[0].artifact, 'audience-comments.json');
});

test('batch resolution reuses one audience snapshot while preserving exact post matching', async (t) => {
  const outputDir = await fixtureDir(t);
  await writeAudience(outputDir, {
    posts: [
      { post_id: 'post-1', status: 'complete', author: { user_id: 'author-1' } },
      { post_id: 'post-2', status: 'partial', author: { user_id: 'author-2' } },
    ],
    comments: [
      {
        comment_id: 'comment-1',
        post_id: 'post-1',
        text: '简历投递 first@example.com',
        user: { user_id: 'author-1' },
      },
      {
        comment_id: 'comment-2',
        post_id: 'post-2',
        text: '仍在招聘，邮箱 second@example.com',
        user: { user_id: 'author-2' },
      },
    ],
  });

  const records = [
    applicationRecord(),
    { ...applicationRecord(), note_id: 'post-2', note_url: 'https://www.xiaohongshu.com/explore/post-2' },
  ];
  const results = await resolveApplicationContactsBatch(records, { outputDir });

  assert.deepEqual(results.map((result) => result.candidates[0].address), [
    'first@example.com',
    'second@example.com',
  ]);
  assert.deepEqual(results.map((result) => result.candidates[0].commentId), ['comment-1', 'comment-2']);
  assert.deepEqual(results.map((result) => result.collectionStatus), ['complete', 'partial']);
});
