import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationDeliveryCandidateError,
  applicationDeliveryCandidateRevision,
  buildApplicationDeliveryCandidates,
} from './application-delivery-candidates.mjs';

function candidate(noteId, overrides = {}) {
  return {
    note_id: noteId,
    title: `岗位 ${noteId}`,
    body: `正文 ${noteId}`,
    collected_at: `2026-08-0${noteId.slice(-1)}T00:00:00.000Z`,
    publish_time: { value: `2026-08-0${noteId.slice(-1)}T00:00:00.000Z` },
    job_card: { role_name: 'AI产品经理实习生' },
    application_info: { contacts: [], application_routes: [] },
    outreach: {
      email_subject: '应聘AI产品经理实习生',
      email_body: `邮件正文 ${noteId}`,
      cover_letter: `Cover Letter ${noteId}`,
      content_quality: { batch_ready: true },
    },
    draftVersion: { draftId: `draft-${noteId}`, version: 1, qualityStatus: 'passed' },
    emailSubjectRequirement: { detected: false },
    attachmentRequirement: { detected: false },
    contactDiscovery: {
      status: 'ready',
      requiresReview: false,
      candidates: [{
        address: `${noteId}@example.test`,
        source: 'body',
        evidenceHash: `evidence-${noteId}`,
        verificationStatus: 'resolved',
        actionable: true,
      }],
    },
    ...overrides,
  };
}

test('filters the full corpus, returns facet counts, and pages with a stable cursor', () => {
  const records = [candidate('1'), candidate('2'), candidate('3', {
    outreach: { email_subject: '申请 3', email_body: '邮件正文 3', cover_letter: '', content_quality: { batch_ready: true } },
  })];
  const first = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records,
    query: { copyStatus: 'passed', sort: 'oldest' },
    limit: 1,
  });
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].note_id, '1');
  assert.equal(first.facetCounts.copyStatus.passed, 2);
  assert.equal(first.facetCounts.copyStatus.missing_cover_letter, 1);
  assert.equal(first.selectionSnapshot.candidateCount, 2);
  assert.deepEqual(first.selectionSnapshot.selectableNoteIds, ['1', '2']);
  assert.deepEqual(first.selectionSnapshot.readyNoteIds, ['1', '2']);
  assert.ok(first.nextCursor);

  const second = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records,
    query: { copyStatus: 'passed', sort: 'oldest', cursor: first.nextCursor },
    limit: 1,
  });
  assert.equal(second.items[0].note_id, '2');
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.selectionSnapshot.selectableNoteIds, ['1', '2']);
  assert.equal(second.selectionSnapshot.selectionSnapshotHash, first.selectionSnapshot.selectionSnapshotHash);
});

test('defaults to 50 rows and safely caps larger page-size requests at 100', () => {
  const records = Array.from({ length: 130 }, (_, index) => candidate(String(index + 1).padStart(3, '0')));
  const defaultPage = buildApplicationDeliveryCandidates({ jobId: 'job-1', records });
  assert.equal(defaultPage.limit, 50);
  assert.equal(defaultPage.items.length, 50);
  assert.ok(defaultPage.nextCursor);

  const requestedPage = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, limit: 75 });
  assert.equal(requestedPage.limit, 75);
  assert.equal(requestedPage.items.length, 75);

  const cappedPage = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, limit: 1_000 });
  assert.equal(cappedPage.limit, 100);
  assert.equal(cappedPage.items.length, 100);
  assert.ok(cappedPage.nextCursor);

  const secondPage = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records,
    query: { cursor: cappedPage.nextCursor },
    limit: 100,
  });
  assert.equal(secondPage.offset, 100);
  assert.equal(secondPage.items.length, 30);
  assert.equal(secondPage.nextCursor, null);

  const invalidPage = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, limit: 25.5 });
  assert.equal(invalidPage.limit, 50);
  assert.equal(invalidPage.items.length, 50);
});

test('rejects a cursor when filters change', () => {
  const records = [candidate('1'), candidate('2')];
  const first = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, limit: 1 });
  assert.throws(
    () => buildApplicationDeliveryCandidates({ jobId: 'job-1', records, query: { cursor: first.nextCursor, copyStatus: 'passed' }, limit: 1 }),
    (error) => error instanceof ApplicationDeliveryCandidateError
      && error.code === 'APPLICATION_CANDIDATE_CURSOR_INVALID'
      && error.status === 400,
  );
});

test('rejects a cursor with 409 when the filtered candidate dataset changes', () => {
  const records = [candidate('1'), candidate('2')];
  const first = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, limit: 1 });
  assert.ok(first.nextCursor);

  assert.throws(
    () => buildApplicationDeliveryCandidates({
      jobId: 'job-1',
      records: [...records, candidate('3')],
      query: { cursor: first.nextCursor },
      limit: 1,
    }),
    (error) => error instanceof ApplicationDeliveryCandidateError
      && error.code === 'APPLICATION_CANDIDATE_CURSOR_STALE'
      && error.status === 409,
  );
});

test('classifies recipient, content, naming, and historical delivery blockers', () => {
  const ambiguous = candidate('1', {
    attachmentRequirement: { detected: true, evidence: '附件请命名为姓名-岗位' },
    contactDiscovery: {
      requiresReview: true,
      candidates: [
        { address: 'first@example.test', source: 'image', evidenceHash: 'a', actionable: true },
        { address: 'second@example.test', source: 'author_comment', evidenceHash: 'b', actionable: true },
      ],
    },
  });
  const result = buildApplicationDeliveryCandidates({ jobId: 'job-1', records: [ambiguous] });
  const summary = result.items[0].deliveryManifestSummary;
  assert.equal(summary.recipientStatus, 'multiple_candidates');
  assert.equal(summary.recipientSource, 'ocr');
  assert.equal(summary.attachmentStatus, 'planned_rename');
  assert.equal(summary.readiness, 'needs_input');
  assert.deepEqual(summary.blockers.map((item) => item.code), ['RECIPIENT_REVIEW_REQUIRED']);
  assert.deepEqual(summary.warnings.map((item) => item.code), ['WILL_RENAME']);
});

test('blocks short or internal-token Cover Letters from batch readiness', () => {
  const result = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records: [candidate('1', {
      outreach: {
        email_subject: '应聘 AI 产品经理实习生',
        email_body: '邮件正文',
        cover_letter: 'exp_2022_xinhua 这是尚未清理的内部草稿',
        content_quality: { batch_ready: true, cover_letter_chars: 373 },
      },
    })],
  });

  const summary = result.items[0].deliveryManifestSummary;
  assert.equal(summary.copyStatus, 'quality_failed');
  assert.equal(summary.readiness, 'needs_input');
  assert.ok(summary.blockers.some((blocker) => blocker.code === 'COPY_QUALITY_FAILED'));
  assert.deepEqual(result.selectionSnapshot.readyNoteIds, []);
});

test('selection snapshot changes when a source revision changes', () => {
  const before = candidate('1');
  const after = candidate('1', { outreach: { ...candidate('1').outreach, cover_letter: 'updated' } });
  const first = buildApplicationDeliveryCandidates({ jobId: 'job-1', records: [before] });
  const second = buildApplicationDeliveryCandidates({ jobId: 'job-1', records: [after] });
  assert.notEqual(applicationDeliveryCandidateRevision(before), applicationDeliveryCandidateRevision(after));
  assert.notEqual(first.selectionSnapshot.selectionSnapshotHash, second.selectionSnapshot.selectionSnapshotHash);
});

test('selection snapshot hash includes latest batch identity, statuses, and revisions', () => {
  const record = candidate('1');
  const batch = {
    batchId: 'batch-1',
    status: 'ready',
    revision: 1,
    updatedAt: '2026-08-05T00:00:00.000Z',
    items: [{
      itemId: 'item-1',
      noteId: '1',
      status: 'ready',
      revision: 1,
      updatedAt: '2026-08-05T00:00:00.000Z',
    }],
  };
  const first = buildApplicationDeliveryCandidates({ jobId: 'job-1', records: [record], batches: [batch] });
  const firstRevision = first.selectionSnapshot.revisions[0].revision;

  const variants = [
    { ...batch, batchId: 'batch-2' },
    { ...batch, status: 'approved' },
    { ...batch, revision: 2 },
    { ...batch, items: [{ ...batch.items[0], status: 'sending' }] },
    { ...batch, items: [{ ...batch.items[0], revision: 2 }] },
  ];
  for (const changedBatch of variants) {
    const changed = buildApplicationDeliveryCandidates({ jobId: 'job-1', records: [record], batches: [changedBatch] });
    assert.equal(changed.selectionSnapshot.revisions[0].revision, firstRevision);
    assert.notEqual(changed.selectionSnapshot.selectionSnapshotHash, first.selectionSnapshot.selectionSnapshotHash);
  }
});

test('rejects an existing cursor after latest batch state changes', () => {
  const records = [candidate('1'), candidate('2')];
  const batch = {
    batchId: 'batch-1',
    status: 'ready',
    revision: 1,
    updatedAt: '2026-08-05T00:00:00.000Z',
    items: [{ itemId: 'item-1', noteId: '1', status: 'ready', revision: 1 }],
  };
  const first = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, batches: [batch], limit: 1 });
  assert.ok(first.nextCursor);

  assert.throws(
    () => buildApplicationDeliveryCandidates({
      jobId: 'job-1',
      records,
      batches: [{ ...batch, revision: 2, items: [{ ...batch.items[0], status: 'sent', revision: 2 }] }],
      query: { cursor: first.nextCursor },
      limit: 1,
    }),
    (error) => error instanceof ApplicationDeliveryCandidateError
      && error.code === 'APPLICATION_CANDIDATE_CURSOR_STALE'
      && error.status === 409,
  );
});

test('latest batch state is included and sent candidates can be filtered', () => {
  const records = [candidate('1'), candidate('2')];
  const batches = [{
    batchId: 'batch-1',
    status: 'completed',
    updatedAt: '2026-08-05T00:00:00.000Z',
    items: [{ itemId: 'item-1', noteId: '1', status: 'sent', updatedAt: '2026-08-05T00:00:00.000Z' }],
  }];
  const result = buildApplicationDeliveryCandidates({ jobId: 'job-1', records, batches, query: { deliveryStatus: 'sent' } });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].note_id, '1');
  assert.equal(result.items[0].deliveryManifestSummary.latestBatch.batchId, 'batch-1');
  assert.deepEqual(result.selectionSnapshot.selectableNoteIds, []);
  assert.deepEqual(result.selectionSnapshot.readyNoteIds, []);
});

test('delivery candidates expose the globally resolved subject instead of a noisy post title', () => {
  const rawTitle = '急急急！有8月能来实习的吗？蹲继任';
  const staleSubject = `应聘${rawTitle}｜王梓楠`;
  const result = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records: [candidate('1', {
      title: rawTitle,
      job_card: { role_name: '', title: rawTitle },
      outreach: {
        email_subject: staleSubject,
        email_body: '邮件正文',
        cover_letter: 'Cover Letter',
        content_quality: { batch_ready: true },
      },
    })],
  });
  const item = result.items[0];
  assert.equal(item.emailSubjectPreview, '应聘岗位');
  assert.equal(item.outreach.email_subject, '应聘岗位');
  assert.equal(item.emailSubjectGuard.requiresReview, true);
  assert.equal(item.deliveryManifestSummary.subjectRuleStatus, 'needs_input');
});

test('delivery candidates expose an attachment-derived subject and its effective rule metadata', () => {
  const result = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records: [candidate('1', {
      body: '简历命名：学校-姓名-到岗时间.pdf\n投递邮箱 one@example.test',
      candidate_profile: {
        name: '王梓楠',
        school: '示例大学',
        arrivalDate: '9月1日',
      },
      outreach: {
        email_subject: '',
        email_body: '邮件正文 1',
        cover_letter: 'Cover Letter 1',
        content_quality: { batch_ready: true },
      },
    })],
  });

  const item = result.items[0];
  assert.equal(item.outreach.email_subject, '示例大学-王梓楠-9月1日');
  assert.equal(item.emailSubjectPreview, '示例大学-王梓楠-9月1日');
  assert.equal(item.emailSubjectRequirement.source, 'attachment_requirement');
  assert.equal(item.emailSubjectRequirement.template, '学校-姓名-到岗时间');
  assert.equal(item.emailSubjectRequirement.attachmentTemplate, '学校-姓名-到岗时间.pdf');
  assert.match(item.emailSubjectRequirement.evidence, /简历命名/u);
  assert.equal(item.deliveryManifestSummary.subjectRuleStatus, 'job_requirement_satisfied');
  assert.equal(item.deliveryManifestSummary.readiness, 'ready_to_preview');
});

test('delivery candidates keep an unverified source subject blocked after generating a safe preview', () => {
  const result = buildApplicationDeliveryCandidates({
    jobId: 'job-1',
    records: [candidate('1', {
      outreach: {
        email_subject: 'Weekly update',
        email_body: 'Email body',
        cover_letter: 'Cover Letter',
        content_quality: { batch_ready: true },
      },
    })],
  });
  const item = result.items[0];
  assert.equal(item.emailSubjectGuard.sourceStatus, 'rejected_unverified_subject');
  assert.equal(item.deliveryManifestSummary.subjectRuleStatus, 'needs_input');
  assert.equal(item.deliveryManifestSummary.readiness, 'needs_input');
  assert.ok(item.deliveryManifestSummary.blockers.some((blocker) => blocker.code === 'SUBJECT_REVIEW_REQUIRED'));
});
