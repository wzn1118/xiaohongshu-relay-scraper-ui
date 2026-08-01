const PROFILE_MODES = new Set([
  'none',
  'available_header',
  'collect_missing_header',
  'recent_public_posts',
]);

const MODULES = new Set([
  'comment_insights',
  'thread_insights',
  'user_insights',
  'audience_segments',
  'content_fit',
  'content_opportunities',
  'profile_insights',
]);

const DEFAULT_MODULES = Object.freeze([
  'comment_insights',
  'thread_insights',
  'user_insights',
  'audience_segments',
  'content_fit',
  'content_opportunities',
]);

export const AUDIENCE_AI_PROFILE_MODES = Object.freeze([...PROFILE_MODES]);
export const AUDIENCE_AI_MODULES = Object.freeze([...MODULES]);

export class AudienceAiValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AudienceAiValidationError';
    this.code = 'AUDIENCE_AI_INVALID_SCOPE';
    this.details = details;
  }
}

export function validateAudienceAiPreviewRequest(value) {
  return validateScope(value, { requireSession: false, requireIdempotency: false });
}

export function validateAudienceAiStartRequest(value) {
  return validateScope(value, { requireSession: true, requireIdempotency: true });
}

export function validateAudienceAiEmptyRequest(value) {
  assertPlainObject(value);
  const unknown = Object.keys(value);
  if (unknown.length) failUnknown(unknown);
  return Object.freeze({});
}

export function validateAudienceAiResultsQuery(searchParams) {
  const allowed = new Set(['module', 'offset', 'limit', 'runId', 'version']);
  const unknown = [...searchParams.keys()].filter((key) => !allowed.has(key));
  if (unknown.length) failUnknown(unknown);
  const module = stringValue(searchParams.get('module') || 'analysis', 'module', 1, 64);
  if (!new Set(['analysis', 'comments', 'threads', 'users', 'evidence', 'coverage']).has(module)) {
    fail('module', 'unsupported_module');
  }
  const runId = optionalIdentifier(searchParams.get('runId'), 'runId');
  const version = optionalIdentifier(searchParams.get('version'), 'version');
  if (runId && version && runId !== version) fail('version', 'conflicts_with_runId');
  return Object.freeze({
    module,
    offset: integerValue(searchParams.get('offset'), 'offset', 0, 0, 1_000_000),
    limit: integerValue(searchParams.get('limit'), 'limit', 100, 1, 500),
    runId: runId || version,
  });
}

function validateScope(value, { requireSession, requireIdempotency }) {
  assertPlainObject(value);
  const allowed = new Set([
    'aiSessionId',
    'includeTopLevelComments',
    'includeReplies',
    'includeUsers',
    'profileMode',
    'profileUserLimit',
    'profilePostLimitPerUser',
    'profilePostTotalLimit',
    'modules',
    'outputLanguage',
    'evidenceStrictness',
    'incrementalOnly',
    'idempotencyKey',
    'maxEstimatedTokens',
    'maxEstimatedCost',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) failUnknown(unknown);

  const aiSessionId = optionalIdentifier(value.aiSessionId, 'aiSessionId');
  if (requireSession && !aiSessionId) fail('aiSessionId', 'required');
  const idempotencyKey = optionalIdempotencyKey(value.idempotencyKey);
  if (requireIdempotency && !idempotencyKey) fail('idempotencyKey', 'required');

  const profileMode = value.profileMode ?? 'none';
  if (!PROFILE_MODES.has(profileMode)) fail('profileMode', 'unsupported_profile_mode');
  const includeTopLevelComments = booleanValue(value.includeTopLevelComments, 'includeTopLevelComments', true);
  const includeReplies = booleanValue(value.includeReplies, 'includeReplies', true);
  const includeUsers = booleanValue(value.includeUsers, 'includeUsers', true);
  if (!includeTopLevelComments && !includeReplies) fail('includeTopLevelComments', 'comments_or_replies_required');

  const modules = moduleList(value.modules);
  if (!includeUsers && modules.some((item) => ['user_insights', 'audience_segments', 'profile_insights'].includes(item))) {
    fail('modules', 'user_modules_require_includeUsers');
  }
  if (profileMode === 'none' && modules.includes('profile_insights')) {
    fail('modules', 'profile_insights_require_profile_mode');
  }

  const profileUserLimit = integerValue(value.profileUserLimit, 'profileUserLimit', 0, 0, 2_000);
  const profilePostLimitPerUser = integerValue(value.profilePostLimitPerUser, 'profilePostLimitPerUser', 0, 0, 20);
  const profilePostTotalLimit = integerValue(value.profilePostTotalLimit, 'profilePostTotalLimit', 0, 0, 2_000);
  if (profileMode === 'recent_public_posts') {
    if (profileUserLimit < 1) fail('profileUserLimit', 'required_for_recent_public_posts');
    if (profilePostLimitPerUser < 1) fail('profilePostLimitPerUser', 'required_for_recent_public_posts');
    if (profilePostTotalLimit < 1) fail('profilePostTotalLimit', 'required_for_recent_public_posts');
    if (profilePostTotalLimit > profileUserLimit * profilePostLimitPerUser) {
      fail('profilePostTotalLimit', 'exceeds_user_budget');
    }
  } else if (profilePostLimitPerUser || profilePostTotalLimit) {
    fail('profilePostLimitPerUser', 'only_valid_for_recent_public_posts');
  }

  const outputLanguage = stringValue(value.outputLanguage ?? 'zh-CN', 'outputLanguage', 2, 20);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(outputLanguage)) fail('outputLanguage', 'invalid_language_tag');
  const evidenceStrictness = value.evidenceStrictness ?? 'strict';
  if (!['strict', 'balanced'].includes(evidenceStrictness)) fail('evidenceStrictness', 'must_be_strict_or_balanced');

  return Object.freeze({
    aiSessionId,
    includeTopLevelComments,
    includeReplies,
    includeUsers,
    profileMode,
    profileUserLimit,
    profilePostLimitPerUser,
    profilePostTotalLimit,
    modules,
    outputLanguage,
    evidenceStrictness,
    incrementalOnly: booleanValue(value.incrementalOnly, 'incrementalOnly', false),
    idempotencyKey,
    maxEstimatedTokens: integerValue(value.maxEstimatedTokens, 'maxEstimatedTokens', 0, 0, 20_000_000),
    maxEstimatedCost: numberValue(value.maxEstimatedCost, 'maxEstimatedCost', 0, 0, 100_000),
  });
}

function moduleList(value) {
  if (value === undefined) return [...DEFAULT_MODULES];
  if (!Array.isArray(value) || value.length < 1 || value.length > MODULES.size) fail('modules', 'array_length_1_to_7');
  const normalized = value.map((item) => {
    if (typeof item !== 'string' || !MODULES.has(item)) fail('modules', 'unsupported_module');
    return item;
  });
  if (new Set(normalized).size !== normalized.length) fail('modules', 'duplicate_module');
  return normalized;
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AudienceAiValidationError('Request body must be a JSON object.', [{ field: '$', reason: 'must_be_object' }]);
  }
}

function booleanValue(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(field, 'must_be_boolean');
  return value;
}

function integerValue(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(field, `must_be_integer_${min}_to_${max}`);
  return parsed;
}

function numberValue(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(field, `must_be_number_${min}_to_${max}`);
  return value;
}

function optionalIdentifier(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return stringValue(value, field, 1, 160, /^[\p{L}\p{N}_.:-]+$/u);
}

function optionalIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  return stringValue(value, 'idempotencyKey', 8, 160, /^[\p{L}\p{N}_.:-]+$/u);
}

function stringValue(value, field, min, max, pattern = null) {
  if (typeof value !== 'string') fail(field, 'must_be_string');
  const text = value.trim();
  const length = [...text].length;
  if (length < min || length > max || /\p{Cc}/u.test(text) || (pattern && !pattern.test(text))) {
    fail(field, `invalid_length_or_format_${min}_to_${max}`);
  }
  return text;
}

function failUnknown(fields) {
  throw new AudienceAiValidationError(
    'Unsupported audience AI parameters.',
    fields.map((field) => ({ field, reason: 'not_allowed' })),
  );
}

function fail(field, reason) {
  throw new AudienceAiValidationError('Invalid audience AI request.', [{ field, reason }]);
}
