import { createHash } from 'node:crypto';

export const DRAFT_STORE_SCHEMA_VERSION = 2;
export const DRAFT_CONTENT_FIELDS = Object.freeze([
  'greeting',
  'email_subject',
  'email_body',
  'cover_letter',
]);
export const DRAFT_QUALITY_STATUSES = Object.freeze(['stale', 'passed', 'failed']);

const QUALITY_STATUSES = new Set(DRAFT_QUALITY_STATUSES);
const SHA256 = /^[a-f0-9]{64}$/;

export function normalizeDraftContent(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return freeze({
    greeting: normalizeText(source.greeting),
    email_subject: normalizeText(source.email_subject),
    email_body: normalizeText(source.email_body),
    cover_letter: normalizeText(source.cover_letter),
  });
}

export function hashDraftContent(value = {}) {
  const content = normalizeDraftContent(value);
  const canonical = JSON.stringify(DRAFT_CONTENT_FIELDS.map((field) => [field, content[field]]));
  return createHash('sha256').update(`draft-content:v1\n${canonical}`, 'utf8').digest('hex');
}

export function deterministicDraftId(recordOrNoteId) {
  const identity = typeof recordOrNoteId === 'string'
    ? recordOrNoteId
    : recordOrNoteId?.note_id || recordOrNoteId?.noteId || recordOrNoteId?.id || recordOrNoteId?.note_url;
  const normalized = normalizeText(identity);
  if (!normalized) throw draftError('DRAFT_IDENTITY_REQUIRED', 'A note identity is required to create a draftId.');
  const digest = createHash('sha256').update(`draft-id:v1\n${normalized}`, 'utf8').digest('hex');
  return `draft_${digest}`;
}

export function createDraftStore(record, options = {}) {
  return migrateDraftStore(record, {}, options);
}

export function migrateDraftStore(record, state = {}, options = {}) {
  const draftId = deterministicDraftId(record);
  const existing = findVersionedStore(state);
  if (existing) {
    const normalized = normalizeStore(existing);
    if (normalized.draftId !== draftId) {
      throw draftError('DRAFT_ID_MISMATCH', 'The stored draft does not belong to the supplied record.');
    }
    return normalized;
  }

  const now = timestamp(options.now);
  const generatedContent = normalizeDraftContent(record?.outreach);
  const generatedHash = hashDraftContent(generatedContent);
  const quality = legacyQualityBinding(
    record?.cover_letter_evaluation,
    generatedHash,
    draftId,
    1,
    options.legacyQualityReportRef,
    record?.note_id || record?.noteId || record?.id,
  );
  const first = makeVersion({
    draftId,
    version: 1,
    content: generatedContent,
    contentHash: generatedHash,
    ...quality,
    createdAt: now,
    updatedAt: now,
  });

  const versions = [first];
  const legacyDraft = isPlainObject(state?.draft)
    ? mergeDraftContent(generatedContent, state.draft)
    : null;
  if (legacyDraft) {
    const legacyHash = hashDraftContent(legacyDraft);
    if (legacyHash !== generatedHash) {
      const legacyTime = timestamp(
        options.legacyUpdatedAt
          || state.draftUpdatedAt
          || state.updatedAt
          || now,
      );
      versions.push(makeVersion({
        draftId,
        version: 2,
        content: legacyDraft,
        contentHash: legacyHash,
        qualityStatus: 'stale',
        qualityCheckedVersion: null,
        qualityCheckedHash: null,
        qualityReportRef: null,
        createdAt: legacyTime,
        updatedAt: legacyTime,
      }));
    }
  }

  return freeze({
    schemaVersion: DRAFT_STORE_SCHEMA_VERSION,
    draftId,
    currentVersion: versions.at(-1).version,
    versions: freeze(versions),
  });
}

export function saveDraftVersion(store, input = {}) {
  const currentStore = normalizeStore(store);
  assertDraftId(currentStore, input.draftId);
  const current = currentDraftVersion(currentStore);
  const expectedVersion = input.expectedVersion;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw versionConflict(expectedVersion, currentStore.currentVersion);
  }
  const content = mergeDraftContent(current.content, input.content);
  const contentHash = hashDraftContent(content);

  // A retry of an already-applied save remains idempotent even when it carries
  // the previous expectedVersion.
  if (contentHash === current.contentHash) {
    if (
      expectedVersion === currentStore.currentVersion
      || expectedVersion === currentStore.currentVersion - 1
    ) {
      return currentStore;
    }
    throw versionConflict(expectedVersion, currentStore.currentVersion);
  }

  if (expectedVersion !== currentStore.currentVersion) {
    throw versionConflict(expectedVersion, currentStore.currentVersion);
  }

  const now = timestamp(input.now);
  const next = makeVersion({
    draftId: currentStore.draftId,
    version: currentStore.currentVersion + 1,
    content,
    contentHash,
    qualityStatus: 'stale',
    qualityCheckedVersion: null,
    qualityCheckedHash: null,
    qualityReportRef: null,
    createdAt: now,
    updatedAt: now,
  });
  return freeze({
    ...currentStore,
    currentVersion: next.version,
    versions: freeze([...currentStore.versions, next]),
  });
}

export function bindDraftQuality(store, input = {}) {
  const currentStore = normalizeStore(store);
  assertDraftId(currentStore, input.draftId);
  const versionNumber = positiveInteger(input.version, 'DRAFT_VERSION_REQUIRED', 'A draft version is required.');
  const index = currentStore.versions.findIndex((item) => item.version === versionNumber);
  if (index < 0) throw draftError('DRAFT_VERSION_NOT_FOUND', `Draft version ${versionNumber} does not exist.`);

  const version = currentStore.versions[index];
  const recomputedHash = hashDraftContent(version.content);
  const checkedHash = normalizeHash(input.contentHash ?? input.qualityCheckedHash);
  if (!checkedHash || checkedHash !== recomputedHash || version.contentHash !== recomputedHash) {
    throw draftError('DRAFT_QUALITY_BINDING_MISMATCH', 'Quality results must match the exact stored draft content hash.');
  }

  const qualityStatus = normalizeQualityStatus(input.qualityStatus, input.passed);
  const qualityReportRef = cloneReportRef(input.qualityReportRef ?? input.reportRef);
  if (qualityReportRef === null) {
    throw draftError('DRAFT_QUALITY_REPORT_REQUIRED', 'A checked quality result requires a quality report reference.');
  }
  if (
    version.qualityStatus === qualityStatus
    && version.qualityCheckedVersion === versionNumber
    && version.qualityCheckedHash === checkedHash
    && stableJson(version.qualityReportRef) === stableJson(qualityReportRef)
  ) {
    return currentStore;
  }

  const updated = makeVersion({
    ...version,
    qualityStatus,
    qualityCheckedVersion: versionNumber,
    qualityCheckedHash: checkedHash,
    qualityReportRef,
    updatedAt: timestamp(input.now),
  });
  const versions = currentStore.versions.map((item, itemIndex) => itemIndex === index ? updated : item);
  return freeze({ ...currentStore, versions: freeze(versions) });
}

export function currentDraftVersion(store) {
  const currentStore = normalizeStore(store);
  const version = currentStore.versions.find((item) => item.version === currentStore.currentVersion);
  if (!version) throw draftError('DRAFT_STORE_INVALID', 'The current draft version does not exist.');
  return cloneAndFreeze(version);
}

export function publicDraftMetadata(store) {
  const currentStore = normalizeStore(store);
  const current = currentDraftVersion(currentStore);
  return freeze({
    schemaVersion: currentStore.schemaVersion,
    draftId: currentStore.draftId,
    currentVersion: currentStore.currentVersion,
    versionCount: currentStore.versions.length,
    contentHash: current.contentHash,
    qualityStatus: current.qualityStatus,
    qualityCheckedVersion: current.qualityCheckedVersion,
    qualityCheckedHash: current.qualityCheckedHash,
    qualityReportRef: cloneReportRef(current.qualityReportRef),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
}

export function resolveDraftForSend(store, input = {}) {
  const currentStore = normalizeStore(store);
  assertDraftId(currentStore, input.draftId);
  const versionNumber = positiveInteger(input.version, 'DRAFT_VERSION_REQUIRED', 'A draft version is required.');
  const version = currentStore.versions.find((item) => item.version === versionNumber);
  if (!version) throw draftError('DRAFT_VERSION_NOT_FOUND', `Draft version ${versionNumber} does not exist.`);

  const contentHash = hashDraftContent(version.content);
  if (contentHash !== version.contentHash) {
    throw draftError('DRAFT_HASH_MISMATCH', 'The stored draft content does not match its content hash.');
  }
  if (
    version.qualityStatus !== 'passed'
    || version.qualityCheckedVersion !== version.version
    || version.qualityCheckedHash !== contentHash
  ) {
    throw draftError('DRAFT_QUALITY_STALE', 'The requested draft version has not passed quality checks for its exact content hash.');
  }
  if (version.qualityReportRef === null) {
    throw draftError('DRAFT_QUALITY_REPORT_REQUIRED', 'The requested draft version has no quality report reference.');
  }

  return freeze({
    draftId: version.draftId,
    version: version.version,
    content: cloneAndFreeze(version.content),
    contentHash,
    qualityStatus: version.qualityStatus,
    qualityCheckedVersion: version.qualityCheckedVersion,
    qualityCheckedHash: version.qualityCheckedHash,
    qualityReportRef: cloneReportRef(version.qualityReportRef),
  });
}

function legacyQualityBinding(evaluation, contentHash, draftId, version, fallbackReportRef, noteId) {
  if (!isPlainObject(evaluation)) return staleQuality();
  const rawCheckedHash = evaluation.qualityCheckedHash
    ?? evaluation.contentHash
    ?? evaluation.content_hash
    ?? evaluation.draftHash
    ?? evaluation.draft_hash;
  const checkedHash = rawCheckedHash == null ? contentHash : normalizeHash(rawCheckedHash);
  const checkedVersion = evaluation.qualityCheckedVersion ?? evaluation.version ?? version;
  if (checkedHash !== contentHash || Number(checkedVersion) !== version) return staleQuality();

  let qualityStatus;
  try {
    qualityStatus = normalizeQualityStatus(evaluation.qualityStatus, evaluation.passed);
  } catch (error) {
    if (error?.code === 'DRAFT_QUALITY_STATUS_INVALID') return staleQuality();
    throw error;
  }
  if (rawCheckedHash == null && qualityStatus === 'passed') {
    const threshold = Math.max(90, Number(evaluation.threshold || 90));
    const score = Number(evaluation.score);
    if (!Number.isFinite(score) || score < threshold) return staleQuality();
  }
  const qualityReportRef = cloneReportRef(
    evaluation.qualityReportRef
      ?? evaluation.reportRef
      ?? fallbackReportRef
      ?? `application_intelligence.json#note-id=${encodeURIComponent(String(noteId || draftId))}/cover_letter_evaluation`,
  );
  return {
    qualityStatus,
    qualityCheckedVersion: version,
    qualityCheckedHash: contentHash,
    qualityReportRef,
  };
}

function staleQuality() {
  return {
    qualityStatus: 'stale',
    qualityCheckedVersion: null,
    qualityCheckedHash: null,
    qualityReportRef: null,
  };
}

function findVersionedStore(state) {
  if (!isPlainObject(state)) return null;
  const candidates = [state, state.draftStore, state.draft_store, state.draftVersions];
  return candidates.find((candidate) => (
    isPlainObject(candidate)
    && Number(candidate.schemaVersion) === DRAFT_STORE_SCHEMA_VERSION
    && Array.isArray(candidate.versions)
  )) || null;
}

function normalizeStore(store) {
  if (!isPlainObject(store) || Number(store.schemaVersion) !== DRAFT_STORE_SCHEMA_VERSION) {
    throw draftError('DRAFT_STORE_INVALID', `Draft store schemaVersion must be ${DRAFT_STORE_SCHEMA_VERSION}.`);
  }
  const draftId = String(store.draftId || '').trim();
  if (!draftId) throw draftError('DRAFT_STORE_INVALID', 'Draft store draftId is required.');
  if (!Array.isArray(store.versions) || store.versions.length === 0) {
    throw draftError('DRAFT_STORE_INVALID', 'Draft store versions must be a non-empty array.');
  }

  const versions = store.versions.map((item, index) => normalizeVersion(item, draftId, index + 1));
  const currentVersion = positiveInteger(
    store.currentVersion ?? versions.at(-1).version,
    'DRAFT_STORE_INVALID',
    'Draft store currentVersion must be a positive integer.',
  );
  if (currentVersion !== versions.at(-1).version) {
    throw draftError('DRAFT_STORE_INVALID', 'Draft store currentVersion must identify the latest immutable version.');
  }
  return freeze({
    schemaVersion: DRAFT_STORE_SCHEMA_VERSION,
    draftId,
    currentVersion,
    versions: freeze(versions),
  });
}

function normalizeVersion(value, draftId, expectedVersion) {
  if (!isPlainObject(value)) throw draftError('DRAFT_STORE_INVALID', 'Every draft version must be an object.');
  if (String(value.draftId || '').trim() !== draftId) {
    throw draftError('DRAFT_STORE_INVALID', 'Every draft version must use the store draftId.');
  }
  if (Number(value.version) !== expectedVersion) {
    throw draftError('DRAFT_STORE_INVALID', 'Draft versions must be contiguous and ordered from version 1.');
  }
  const content = normalizeDraftContent(value.content);
  const contentHash = normalizeHash(value.contentHash);
  if (!contentHash || contentHash !== hashDraftContent(content)) {
    throw draftError('DRAFT_STORE_INVALID', `Draft version ${expectedVersion} has an invalid content hash.`);
  }
  const qualityStatus = normalizeStoredQualityStatus(value.qualityStatus);
  const qualityCheckedVersion = nullablePositiveInteger(value.qualityCheckedVersion);
  const qualityCheckedHash = value.qualityCheckedHash == null ? null : normalizeHash(value.qualityCheckedHash);
  const qualityReportRef = cloneReportRef(value.qualityReportRef);
  if (qualityStatus === 'stale') {
    if (qualityCheckedVersion !== null || qualityCheckedHash !== null || qualityReportRef !== null) {
      throw draftError('DRAFT_STORE_INVALID', 'A stale draft version cannot retain a bound quality result.');
    }
  } else if (
    qualityCheckedVersion !== expectedVersion
    || qualityCheckedHash !== contentHash
    || qualityReportRef === null
  ) {
    throw draftError('DRAFT_STORE_INVALID', 'A checked draft version must bind quality to its exact version and content hash.');
  }
  return makeVersion({
    draftId,
    version: expectedVersion,
    content,
    contentHash,
    qualityStatus,
    qualityCheckedVersion,
    qualityCheckedHash,
    qualityReportRef,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function makeVersion(value) {
  return freeze({
    draftId: String(value.draftId),
    version: Number(value.version),
    content: cloneAndFreeze(value.content),
    contentHash: String(value.contentHash),
    qualityStatus: String(value.qualityStatus),
    qualityCheckedVersion: value.qualityCheckedVersion == null ? null : Number(value.qualityCheckedVersion),
    qualityCheckedHash: value.qualityCheckedHash == null ? null : String(value.qualityCheckedHash),
    qualityReportRef: cloneReportRef(value.qualityReportRef),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function normalizeQualityStatus(status, passed) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'passed' || normalized === 'failed') return normalized;
  if (typeof passed === 'boolean') return passed ? 'passed' : 'failed';
  throw draftError('DRAFT_QUALITY_STATUS_INVALID', 'Quality status must be passed or failed.');
}

function normalizeStoredQualityStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!QUALITY_STATUSES.has(normalized)) {
    throw draftError('DRAFT_STORE_INVALID', `Unsupported draft quality status: ${normalized || 'empty'}.`);
  }
  return normalized;
}

function assertDraftId(store, requestedDraftId) {
  if (String(requestedDraftId || '').trim() !== store.draftId) {
    throw draftError('DRAFT_ID_MISMATCH', 'The requested draftId does not match the stored draft.');
  }
}

function versionConflict(expected, actual) {
  const error = draftError(
    'DRAFT_VERSION_CONFLICT',
    `Draft version conflict: expected ${String(expected)}, current ${actual}.`,
  );
  error.expectedVersion = expected;
  error.currentVersion = actual;
  return error;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function mergeDraftContent(base, patch) {
  const normalizedBase = normalizeDraftContent(base);
  const source = isPlainObject(patch) ? patch : {};
  return normalizeDraftContent(Object.fromEntries(DRAFT_CONTENT_FIELDS.map((field) => [
    field,
    Object.prototype.hasOwnProperty.call(source, field) ? source[field] : normalizedBase[field],
  ])));
}

function normalizeHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function timestamp(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved === undefined || resolved === null || resolved === ''
    ? new Date()
    : resolved instanceof Date
      ? resolved
      : new Date(resolved);
  if (Number.isNaN(date.getTime())) throw draftError('DRAFT_TIMESTAMP_INVALID', 'Draft timestamp is invalid.');
  return date.toISOString();
}

function positiveInteger(value, code, message) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw draftError(code, message);
  return number;
}

function nullablePositiveInteger(value) {
  if (value === undefined || value === null) return null;
  return positiveInteger(value, 'DRAFT_STORE_INVALID', 'Quality checked version must be a positive integer or null.');
}

function cloneReportRef(value) {
  if (value === undefined || value === null || value === '') return null;
  return cloneAndFreeze(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function cloneAndFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  return deepFreeze(structuredClone(value));
}

function freeze(value) {
  return Object.freeze(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function draftError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
