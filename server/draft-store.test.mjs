import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindDraftQuality,
  createDraftStore,
  currentDraftVersion,
  deterministicDraftId,
  hashDraftContent,
  migrateDraftStore,
  normalizeDraftContent,
  publicDraftMetadata,
  resolveDraftForSend,
  saveDraftVersion,
} from './lib/draft-store.mjs';

const T1 = '2026-07-31T01:00:00.000Z';
const T2 = '2026-07-31T02:00:00.000Z';
const T3 = '2026-07-31T03:00:00.000Z';

function content(overrides = {}) {
  return {
    greeting: '您好，我想申请这个岗位。',
    email_subject: '申请内容运营实习',
    email_body: '您好，\n我有相关内容运营与数据分析经验，期待进一步沟通。',
    cover_letter: '尊敬的招聘负责人：\n您好！这是完整的 Cover Letter。',
    ...overrides,
  };
}

function record(outreach = content(), evaluation = undefined) {
  return {
    note_id: 'note-001',
    outreach,
    ...(evaluation === undefined ? {} : { cover_letter_evaluation: evaluation }),
  };
}

test('draft content hash is stable across key order, line endings, and Unicode composition', () => {
  const left = {
    cover_letter: 'Cafe\u0301\r\n第二行',
    email_body: '第一行\r第二行',
    greeting: ' 您好 ',
    email_subject: '申请岗位',
    ignored: 'not part of the draft contract',
  };
  const right = {
    email_subject: '申请岗位',
    greeting: '您好',
    email_body: '第一行\n第二行',
    cover_letter: 'Café\n第二行',
  };

  assert.deepEqual(normalizeDraftContent(left), right);
  assert.equal(hashDraftContent(left), hashDraftContent(right));
  assert.match(hashDraftContent(left), /^[a-f0-9]{64}$/);
});

test('changing one character changes the content hash', () => {
  assert.notEqual(hashDraftContent(content()), hashDraftContent(content({ greeting: '您好，我想申请这个岗位！' })));
});

test('draftId is deterministic for the same note and differs across notes', () => {
  assert.equal(deterministicDraftId('note-001'), deterministicDraftId({ note_id: 'note-001' }));
  assert.notEqual(deterministicDraftId('note-001'), deterministicDraftId('note-002'));
});

test('generated v1 binds legacy quality only when its checked hash is exact', () => {
  const outreach = content();
  const contentHash = hashDraftContent(outreach);
  const bound = createDraftStore(record(outreach, {
    passed: true,
    qualityCheckedHash: contentHash,
    qualityReportRef: 'quality/report-001.json',
  }), { now: T1 });
  const checked = currentDraftVersion(bound);
  assert.equal(checked.version, 1);
  assert.equal(checked.qualityStatus, 'passed');
  assert.equal(checked.qualityCheckedVersion, 1);
  assert.equal(checked.qualityCheckedHash, contentHash);
  assert.equal(resolveDraftForSend(bound, { draftId: bound.draftId, version: 1 }).qualityReportRef, 'quality/report-001.json');

  const unbound = createDraftStore(record(outreach, {
    passed: true,
    qualityCheckedHash: hashDraftContent(content({ greeting: 'different' })),
    qualityReportRef: 'quality/old.json',
  }), { now: T1 });
  assert.equal(currentDraftVersion(unbound).qualityStatus, 'stale');
  assert.throws(
    () => resolveDraftForSend(unbound, { draftId: unbound.draftId, version: 1 }),
    { code: 'DRAFT_QUALITY_STALE' },
  );
});

test('legacy artifact quality without a hash binds only to its generated v1 content', () => {
  const generated = content();
  const store = createDraftStore(record(generated, {
    score: 94,
    threshold: 90,
    passed: true,
  }), { now: T1 });
  const generatedVersion = currentDraftVersion(store);

  assert.equal(generatedVersion.qualityStatus, 'passed');
  assert.equal(generatedVersion.qualityCheckedVersion, 1);
  assert.equal(generatedVersion.qualityCheckedHash, hashDraftContent(generated));

  const migrated = migrateDraftStore(record(generated, { score: 94, passed: true }), {
    draft: content({ greeting: `${generated.greeting} 已人工修改。` }),
    updatedAt: T2,
  }, { now: T1 });
  assert.equal(migrated.versions[0].qualityStatus, 'passed');
  assert.equal(migrated.versions[1].qualityStatus, 'stale');
  assert.throws(
    () => resolveDraftForSend(migrated, { draftId: migrated.draftId, version: 2 }),
    { code: 'DRAFT_QUALITY_STALE' },
  );
});

test('legacy quality without a hash must still satisfy the original score threshold', () => {
  const outreach = content();
  const belowThreshold = createDraftStore(record(outreach, {
    score: 89,
    threshold: 90,
    passed: true,
  }), { now: T1 });

  assert.equal(currentDraftVersion(belowThreshold).qualityStatus, 'stale');
  assert.throws(
    () => resolveDraftForSend(belowThreshold, { draftId: belowThreshold.draftId, version: 1 }),
    { code: 'DRAFT_QUALITY_STALE' },
  );
});

test('incomplete legacy quality metadata remains readable as stale', () => {
  const outreach = content();
  const store = createDraftStore(record(outreach, {
    score: 95,
    problems: [],
  }), { now: T1 });

  assert.equal(currentDraftVersion(store).qualityStatus, 'stale');
  assert.throws(
    () => resolveDraftForSend(store, { draftId: store.draftId, version: 1 }),
    { code: 'DRAFT_QUALITY_STALE' },
  );
});

test('legacy edited draft migrates to stale v2 while preserving generated v1', () => {
  const generated = content();
  const edited = content({ email_body: `${generated.email_body}\n补充一句。` });
  const store = migrateDraftStore(record(generated), { draft: edited, updatedAt: T2 }, { now: T1 });

  assert.equal(store.schemaVersion, 2);
  assert.equal(store.currentVersion, 2);
  assert.equal(store.versions.length, 2);
  assert.deepEqual(store.versions[0].content, generated);
  assert.deepEqual(store.versions[1].content, edited);
  assert.equal(store.versions[1].qualityStatus, 'stale');
  assert.equal(store.versions[1].qualityCheckedHash, null);
  assert.equal(publicDraftMetadata(store).versionCount, 2);
});

test('legacy draft identical to generated content remains a single v1', () => {
  const generated = content();
  const store = migrateDraftStore(record(generated), { draft: { ...generated } }, { now: T1 });
  assert.equal(store.currentVersion, 1);
  assert.equal(store.versions.length, 1);
});

test('saving appends an immutable stale version without mutating history', () => {
  const original = createDraftStore(record(), { now: T1 });
  const snapshot = structuredClone(original);
  const edited = content({ cover_letter: `${content().cover_letter}\n新增一个字符。` });
  const saved = saveDraftVersion(original, {
    draftId: original.draftId,
    expectedVersion: 1,
    content: edited,
    now: T2,
  });

  assert.deepEqual(original, snapshot);
  assert.equal(Object.isFrozen(original.versions), true);
  assert.equal(Object.isFrozen(original.versions[0].content), true);
  assert.equal(saved.currentVersion, 2);
  assert.equal(saved.versions.length, 2);
  assert.deepEqual(saved.versions[0], original.versions[0]);
  assert.equal(saved.versions[1].qualityStatus, 'stale');
  assert.equal(saved.versions[1].createdAt, T2);
});

test('saving the current hash is idempotent even when retrying the prior expectedVersion', () => {
  const original = createDraftStore(record(), { now: T1 });
  const edited = content({ greeting: `${content().greeting}谢谢。` });
  const saved = saveDraftVersion(original, {
    draftId: original.draftId,
    expectedVersion: 1,
    content: edited,
    now: T2,
  });
  const retried = saveDraftVersion(saved, {
    draftId: saved.draftId,
    expectedVersion: 1,
    content: edited,
    now: T3,
  });

  assert.deepEqual(retried, saved);
  assert.equal(retried.versions.length, 2);
});

test('stale save requests cannot overwrite the latest version', () => {
  const original = createDraftStore(record(), { now: T1 });
  const saved = saveDraftVersion(original, {
    draftId: original.draftId,
    expectedVersion: 1,
    content: content({ greeting: 'version two' }),
    now: T2,
  });

  assert.throws(() => saveDraftVersion(saved, {
    draftId: saved.draftId,
    expectedVersion: 1,
    content: content({ greeting: 'stale client edit' }),
    now: T3,
  }), (error) => {
    assert.equal(error.code, 'DRAFT_VERSION_CONFLICT');
    assert.equal(error.expectedVersion, 1);
    assert.equal(error.currentVersion, 2);
    return true;
  });
});

test('quality binding is version-and-hash specific and enables exact send resolution', () => {
  const original = createDraftStore(record(), { now: T1 });
  const saved = saveDraftVersion(original, {
    draftId: original.draftId,
    expectedVersion: 1,
    content: content({ email_subject: '申请内容策略实习' }),
    now: T2,
  });
  const current = currentDraftVersion(saved);

  assert.throws(() => bindDraftQuality(saved, {
    draftId: saved.draftId,
    version: 2,
    contentHash: saved.versions[0].contentHash,
    qualityStatus: 'passed',
    qualityReportRef: 'quality/wrong.json',
    now: T3,
  }), { code: 'DRAFT_QUALITY_BINDING_MISMATCH' });

  const checked = bindDraftQuality(saved, {
    draftId: saved.draftId,
    version: 2,
    contentHash: current.contentHash,
    qualityStatus: 'passed',
    qualityReportRef: 'quality/report-002.json',
    now: T3,
  });
  const resolved = resolveDraftForSend(checked, { draftId: checked.draftId, version: 2 });
  assert.equal(resolved.version, 2);
  assert.equal(resolved.contentHash, current.contentHash);
  assert.deepEqual(resolved.content, current.content);
  assert.equal(resolved.qualityReportRef, 'quality/report-002.json');
  assert.deepEqual(checked.versions[0], original.versions[0]);
  assert.equal(original.versions[0].qualityStatus, 'stale');
});

test('partial legacy and save payloads preserve all omitted draft fields', () => {
  const generated = content();
  const migrated = migrateDraftStore(record(generated), {
    draft: { greeting: 'legacy greeting edit' },
  }, { now: T1 });
  assert.equal(migrated.currentVersion, 2);
  assert.deepEqual(currentDraftVersion(migrated).content, {
    ...generated,
    greeting: 'legacy greeting edit',
  });

  const saved = saveDraftVersion(migrated, {
    draftId: migrated.draftId,
    expectedVersion: 2,
    content: { email_subject: 'edited subject only' },
    now: T2,
  });
  assert.deepEqual(currentDraftVersion(saved).content, {
    ...generated,
    greeting: 'legacy greeting edit',
    email_subject: 'edited subject only',
  });
});

test('failed quality results require and retain a report reference', () => {
  const store = createDraftStore(record(), { now: T1 });
  const current = currentDraftVersion(store);
  assert.throws(() => bindDraftQuality(store, {
    draftId: store.draftId,
    version: 1,
    contentHash: current.contentHash,
    qualityStatus: 'failed',
  }), { code: 'DRAFT_QUALITY_REPORT_REQUIRED' });

  const checked = bindDraftQuality(store, {
    draftId: store.draftId,
    version: 1,
    contentHash: current.contentHash,
    qualityStatus: 'failed',
    qualityReportRef: 'quality/failed-001.json',
    now: T2,
  });
  assert.equal(currentDraftVersion(checked).qualityStatus, 'failed');
  assert.equal(currentDraftVersion(checked).qualityReportRef, 'quality/failed-001.json');
  assert.throws(
    () => resolveDraftForSend(checked, { draftId: checked.draftId, version: 1 }),
    { code: 'DRAFT_QUALITY_STALE' },
  );
});

test('same-hash retries reject missing, future, and deeply stale expected versions', () => {
  const original = createDraftStore(record(), { now: T1 });
  const second = saveDraftVersion(original, {
    draftId: original.draftId,
    expectedVersion: 1,
    content: { greeting: 'version two' },
    now: T2,
  });
  const third = saveDraftVersion(second, {
    draftId: second.draftId,
    expectedVersion: 2,
    content: { greeting: 'version three' },
    now: T3,
  });
  const retry = { draftId: third.draftId, content: { greeting: 'version three' } };

  assert.throws(() => saveDraftVersion(third, retry), { code: 'DRAFT_VERSION_CONFLICT' });
  assert.throws(
    () => saveDraftVersion(third, { ...retry, expectedVersion: 999 }),
    { code: 'DRAFT_VERSION_CONFLICT' },
  );
  assert.throws(
    () => saveDraftVersion(third, { ...retry, expectedVersion: 1 }),
    { code: 'DRAFT_VERSION_CONFLICT' },
  );
});

test('an existing v2 store must belong to the supplied record', () => {
  const existing = createDraftStore(record(), { now: T1 });
  assert.throws(() => migrateDraftStore({
    ...record(),
    note_id: 'note-002',
  }, { draftStore: existing }), { code: 'DRAFT_ID_MISMATCH' });
});
