import { ValidationError } from './contracts.mjs';

const ROOT_FIELDS = new Set(['records', 'sourceName', 'analysisMode', 'options']);
const OPTION_FIELDS = new Set([
  'browserProfile',
  'relayPort',
  'gotoTimeoutMs',
  'noteDelaySeconds',
  'speedMode',
  'randomDelayMinSeconds',
  'randomDelayMaxSeconds',
  'securityVerificationTimeoutSeconds',
  'maxAgeDays',
]);
const CARD_STRING_FIELDS = new Map([
  ['note_url', 4_000],
  ['search_result_url', 4_000],
  ['explore_url', 4_000],
  ['title', 1_000],
  ['author', 500],
  ['author_profile', 4_000],
  ['publish_time', 300],
  ['like_count', 100],
  ['collect_count', 100],
  ['comment_count', 100],
  ['card_cover_url', 4_000],
  ['card_cover_alt', 1_000],
  ['source_card_text', 20_000],
]);
const CARD_ARRAY_FIELDS = new Map([
  ['card_tags', 200],
  ['card_badges', 200],
  ['card_link_urls', 4_000],
  ['card_image_urls', 4_000],
  ['card_text_segments', 2_000],
]);
const NOTE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_IMPORT_RECORDS = 5_000;

export function validateBodyImportRequest(value) {
  if (!isPlainObject(value)) throw new ValidationError('Request body must be a JSON object.');
  const unsupported = Object.keys(value).filter((field) => !ROOT_FIELDS.has(field));
  if (unsupported.length) {
    throw new ValidationError('Unsupported body import parameters.', unsupported.map((field) => ({ field, reason: 'not_allowed' })));
  }
  if (!Array.isArray(value.records)) {
    throw new ValidationError('records must be a JSON object array.', [{ field: 'records', reason: 'must_be_array' }]);
  }
  if (value.records.length < 1 || value.records.length > MAX_IMPORT_RECORDS) {
    throw new ValidationError(`records must contain 1-${MAX_IMPORT_RECORDS} items.`, [{ field: 'records', reason: `length_1_to_${MAX_IMPORT_RECORDS}` }]);
  }

  const cards = [];
  const seen = new Set();
  const rejected = [];
  let duplicateCount = 0;
  for (const [index, raw] of value.records.entries()) {
    try {
      const card = normalizeCard(raw, index);
      if (seen.has(card.note_id)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(card.note_id);
      cards.push(card);
    } catch (error) {
      rejected.push({
        index,
        reason: error instanceof ValidationError ? error.details?.[0]?.reason || 'invalid_record' : 'invalid_record',
        message: String(error?.message || error),
      });
    }
  }
  if (cards.length < 1) {
    throw new ValidationError('No valid note links were found in records.', rejected.slice(0, 50));
  }

  const options = normalizeOptions(value.options);
  const sourceName = boundedString(value.sourceName, 'sourceName', '前端导入', 180);
  const analysisMode = value.analysisMode === undefined ? 'general' : value.analysisMode;
  if (!['job', 'general'].includes(analysisMode)) {
    throw new ValidationError('analysisMode must be job or general.', [{ field: 'analysisMode', reason: 'invalid_choice' }]);
  }
  const summary = {
    receivedCount: value.records.length,
    acceptedCount: cards.length,
    duplicateCount,
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 50),
  };
  return {
    cards,
    summary,
    params: buildBodyImportParams({ cards, sourceName, analysisMode, options }),
  };
}

function normalizeCard(raw, index) {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`Record ${index + 1} must be an object.`, [{ field: `records.${index}`, reason: 'must_be_object' }]);
  }
  const candidateUrls = ['note_url', 'search_result_url', 'explore_url']
    .map((field) => normalizeXhsUrl(raw[field]))
    .filter(Boolean);
  const noteId = boundedString(raw.note_id ?? raw.noteId, `records.${index}.note_id`, '', 80)
    || noteIdFromUrls(candidateUrls);
  if (!NOTE_ID.test(noteId)) {
    throw new ValidationError(`Record ${index + 1} is missing a valid note_id.`, [{ field: `records.${index}.note_id`, reason: 'invalid_or_missing' }]);
  }
  if (candidateUrls.length < 1) {
    throw new ValidationError(`Record ${index + 1} is missing a valid Xiaohongshu note URL.`, [{ field: `records.${index}.note_url`, reason: 'invalid_or_missing' }]);
  }

  const card = { note_id: noteId };
  for (const [field, max] of CARD_STRING_FIELDS) {
    const normalized = ['note_url', 'search_result_url', 'explore_url'].includes(field)
      ? normalizeXhsUrl(raw[field])
      : boundedString(raw[field], `records.${index}.${field}`, '', max);
    if (normalized) card[field] = normalized;
  }
  for (const [field, max] of CARD_ARRAY_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const values = Array.isArray(raw[field])
      ? raw[field]
      : typeof raw[field] === 'string' || typeof raw[field] === 'number'
        ? String(raw[field]).split(/\s+\|\s+/u)
        : null;
    if (!values) {
      throw new ValidationError(`${field} must be an array or delimited string.`, [{ field: `records.${index}.${field}`, reason: 'must_be_array_or_string' }]);
    }
    card[field] = values
      .slice(0, 500)
      .map((item) => boundedString(item, `records.${index}.${field}`, '', max))
      .filter(Boolean);
  }
  const rank = Number(raw.card_rank);
  if (Number.isInteger(rank) && rank > 0) card.card_rank = rank;

  const preferredUrl = normalizeXhsUrl(card.note_url)
    || normalizeXhsUrl(card.search_result_url)
    || normalizeXhsUrl(card.explore_url)
    || candidateUrls[0];
  card.note_url = preferredUrl;
  card.search_result_url ||= preferredUrl;
  card.explore_url ||= `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
  return card;
}

function normalizeOptions(value) {
  if (value === undefined || value === null) value = {};
  if (!isPlainObject(value)) throw new ValidationError('options must be an object.', [{ field: 'options', reason: 'must_be_object' }]);
  const unsupported = Object.keys(value).filter((field) => !OPTION_FIELDS.has(field));
  if (unsupported.length) {
    throw new ValidationError('Unsupported body import options.', unsupported.map((field) => ({ field: `options.${field}`, reason: 'not_allowed' })));
  }
  const speedMode = value.speedMode ?? 'random';
  if (!['steady', 'random'].includes(speedMode)) {
    throw new ValidationError('Invalid speedMode.', [{ field: 'options.speedMode', reason: 'invalid_choice' }]);
  }
  const options = {
    browserProfile: boundedString(value.browserProfile, 'options.browserProfile', 'openclaw', 80),
    relayPort: boundedNumber(value.relayPort, 'options.relayPort', 18800, 1024, 65535, true),
    gotoTimeoutMs: boundedNumber(value.gotoTimeoutMs, 'options.gotoTimeoutMs', 30000, 1000, 120000, true),
    noteDelaySeconds: boundedNumber(value.noteDelaySeconds, 'options.noteDelaySeconds', 1.2, 0, 60),
    speedMode,
    randomDelayMinSeconds: boundedNumber(value.randomDelayMinSeconds, 'options.randomDelayMinSeconds', 0.8, 0, 60),
    randomDelayMaxSeconds: boundedNumber(value.randomDelayMaxSeconds, 'options.randomDelayMaxSeconds', 2.4, 0, 60),
    securityVerificationTimeoutSeconds: boundedNumber(value.securityVerificationTimeoutSeconds, 'options.securityVerificationTimeoutSeconds', 600, 60, 86400, true),
    maxAgeDays: boundedNumber(value.maxAgeDays, 'options.maxAgeDays', 14, 0, 365, true),
  };
  if (options.randomDelayMinSeconds > options.randomDelayMaxSeconds) {
    throw new ValidationError('Random delay minimum cannot exceed maximum.', [{ field: 'options.randomDelayMinSeconds', reason: 'exceeds_maximum' }]);
  }
  return options;
}

function buildBodyImportParams({ cards, sourceName, analysisMode, options }) {
  const label = sourceName.replace(/\.(json|txt)$/i, '').trim() || '前端导入';
  return {
    analysisMode,
    keyword: `批量正文 · ${label.slice(0, 42)} · ${cards.length} 条`,
    contentPreset: 'auto',
    contentGoal: '',
    searchSort: 'latest',
    maxAgeDays: options.maxAgeDays,
    ...options,
    limit: 0,
    maxScrolls: 1,
    stableRounds: 1,
    mode: 'resume',
    completeMissingOnly: false,
    collectAudience: false,
    audienceOnly: false,
    skipPostprocess: true,
    noAutoAttach: true,
    checkOnly: false,
    useCodexRuntime: false,
    codexBatchSize: 8,
    codexTimeoutSeconds: 300,
    aiSessionId: null,
    profileId: null,
    candidateProfile: {
      name: '', school: '', major: '', degreeYear: '', phoneWeChat: '', email: '',
      availabilityDays: '', internshipDuration: '',
    },
    coverLetterThreshold: 90,
    coverLetterMaxAttempts: 4,
    expansion: {
      enabled: false,
      rounds: 0,
      includeReplies: true,
      maxReplyDepth: 2,
      maxUsersPerRound: 20,
      maxPostsPerUser: 3,
      maxCommentsPerPost: 100,
      maxTotalUsers: 250,
      maxTotalPosts: 500,
      maxTotalComments: 5000,
      timeBudgetMinutes: 30,
      maxFailureCount: 10,
      concurrency: 1,
      postSelectionStrategy: 'latest',
      schemaVersion: 1,
    },
    bodyOnly: true,
    importSourceName: sourceName,
    importedBodyCount: cards.length,
  };
}

function noteIdFromUrls(urls) {
  for (const value of urls) {
    const match = new URL(value).pathname.match(/\/(?:explore|search_result)\/([^/?#]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return '';
}

function normalizeXhsUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (hostname !== 'xiaohongshu.com' && !hostname.endsWith('.xiaohongshu.com'))) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function boundedString(value, field, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${field} must be a string.`, [{ field, reason: 'must_be_string' }]);
  }
  const normalized = String(value).trim();
  if ([...normalized].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new ValidationError(`${field} is invalid.`, [{ field, reason: `length_0_to_${max}` }]);
  }
  return normalized;
}

function boundedNumber(value, field, fallback, min, max, integer = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max || (integer && !Number.isInteger(normalized))) {
    throw new ValidationError(`${field} is invalid.`, [{ field, reason: `${integer ? 'integer_' : ''}${min}_to_${max}` }]);
  }
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
