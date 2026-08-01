const ALLOWED_KEYS = new Set([
  'analysisMode',
  'keyword',
  'contentPreset',
  'contentGoal',
  'searchSort',
  'maxAgeDays',
  'browserProfile',
  'relayPort',
  'limit',
  'maxScrolls',
  'stableRounds',
  'gotoTimeoutMs',
  'noteDelaySeconds',
  'speedMode',
  'randomDelayMinSeconds',
  'randomDelayMaxSeconds',
  'mode',
  'completeMissingOnly',
  'collectAudience',
  'audienceOnly',
  'skipPostprocess',
  'noAutoAttach',
  'checkOnly',
  'resumeFromJobId',
  'securityVerificationTimeoutSeconds',
  'useCodexRuntime',
  'codexBatchSize',
  'codexTimeoutSeconds',
  'aiSessionId',
  'profileId',
  'candidateProfile',
  'coverLetterThreshold',
  'coverLetterMaxAttempts',
  'expansion',
]);

const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/;
const RESUME_SCOPES = new Set(['full', 'discovery', 'body_completion', 'analysis', 'audience', 'artifacts']);
const ATTEMPT_ID = /^[\p{L}\p{N}_.:-]{1,160}$/u;

export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export function validateRunRequest(value) {
  if (!isPlainObject(value)) throw new ValidationError('Request body must be a JSON object.');

  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) {
    throw new ValidationError('Unsupported parameters.', unknown.map((key) => ({ field: key, reason: 'not_allowed' })));
  }

  const analysisMode = value.analysisMode ?? 'job';
  if (analysisMode !== 'job' && analysisMode !== 'general') {
    throw fieldError('analysisMode', 'must_be_job_or_general');
  }

  const keyword = stringField(value.keyword, 'keyword', { defaultValue: '实习继任', min: 1, max: 80 });
  if (/\p{Cc}/u.test(keyword)) throw fieldError('keyword', 'contains_control_character');

  const contentPreset = value.contentPreset ?? 'auto';
  if (!['auto', 'experience', 'people', 'trend', 'product', 'place', 'custom'].includes(contentPreset)) {
    throw fieldError('contentPreset', 'unsupported_content_preset');
  }
  const contentGoal = boundedCandidateString(value.contentGoal, 'contentGoal', '', 500);

  const requestedSearchSort = value.searchSort ?? 'latest';
  if (requestedSearchSort !== 'latest' && requestedSearchSort !== 'comprehensive') {
    throw fieldError('searchSort', 'must_be_latest_or_comprehensive');
  }
  // Collection is latest-first by product policy. Accept the legacy value so
  // stale clients upgrade cleanly, but never let it reach the runner.
  const searchSort = 'latest';

  const browserProfile = stringField(value.browserProfile, 'browserProfile', {
    defaultValue: 'openclaw',
    min: 1,
    max: 64,
  });
  if (!/^[\p{L}\p{N}_.-]+$/u.test(browserProfile)) throw fieldError('browserProfile', 'invalid_format');

  const mode = value.mode ?? 'fresh';
  if (mode !== 'fresh' && mode !== 'resume') throw fieldError('mode', 'must_be_fresh_or_resume');
  integerField(value.limit, 'limit', 0, 0, 1000);
  const resumeFromJobId = optionalStringField(value.resumeFromJobId, 'resumeFromJobId', 64);
  if (resumeFromJobId && !JOB_ID.test(resumeFromJobId)) throw fieldError('resumeFromJobId', 'invalid_job_id');
  if (resumeFromJobId && mode !== 'resume') throw fieldError('resumeFromJobId', 'requires_resume_mode');
  const completeMissingOnly = booleanField(value.completeMissingOnly, 'completeMissingOnly', false);
  if (completeMissingOnly && (!resumeFromJobId || mode !== 'resume')) {
    throw fieldError('completeMissingOnly', 'requires_resume_source');
  }
  const audienceOnly = booleanField(value.audienceOnly, 'audienceOnly', false);
  if (audienceOnly && (analysisMode !== 'general' || !resumeFromJobId || mode !== 'resume')) {
    throw fieldError('audienceOnly', 'requires_general_resume_source');
  }
  const collectAudience = analysisMode === 'general'
    ? booleanField(value.collectAudience, 'collectAudience', true)
    : false;
  const expansion = expansionField(value.expansion);
  if (expansion.enabled && analysisMode !== 'general') {
    throw fieldError('expansion.enabled', 'requires_general_analysis_mode');
  }

  const speedMode = value.speedMode ?? 'random';
  if (speedMode !== 'steady' && speedMode !== 'random') throw fieldError('speedMode', 'must_be_steady_or_random');
  const noteDelaySeconds = numberField(value.noteDelaySeconds, 'noteDelaySeconds', 1.2, 0, 60);
  const randomDelayMinSeconds = numberField(value.randomDelayMinSeconds, 'randomDelayMinSeconds', 0.8, 0, 60);
  const randomDelayMaxSeconds = numberField(value.randomDelayMaxSeconds, 'randomDelayMaxSeconds', 2.4, 0, 60);
  if (randomDelayMinSeconds > randomDelayMaxSeconds) {
    throw fieldError('randomDelayMaxSeconds', 'must_be_greater_than_or_equal_to_randomDelayMinSeconds');
  }

  // Validate the legacy field so malformed clients still receive a useful
  // response, then normalize collection to lossless discovery. Recency is a
  // result-view filter and must never delete cards before body collection.
  integerField(value.maxAgeDays, 'maxAgeDays', 0, 0, 365);

  return Object.freeze({
    analysisMode,
    keyword,
    contentPreset,
    contentGoal,
    searchSort,
    maxAgeDays: 0,
    browserProfile,
    relayPort: integerField(value.relayPort, 'relayPort', 18800, 1, 65535),
    // Every production run must collect the body for every discovered card.
    // Keep the field for request compatibility, but normalize any submitted
    // cap to the only supported collection mode.
    limit: 0,
    maxScrolls: integerField(value.maxScrolls, 'maxScrolls', 40, 1, 100),
    stableRounds: integerField(value.stableRounds, 'stableRounds', 4, 1, 20),
    gotoTimeoutMs: integerField(value.gotoTimeoutMs, 'gotoTimeoutMs', 15000, 3000, 120000),
    noteDelaySeconds,
    speedMode,
    randomDelayMinSeconds,
    randomDelayMaxSeconds,
    mode,
    completeMissingOnly,
    collectAudience: collectAudience || audienceOnly || expansion.enabled,
    audienceOnly,
    skipPostprocess: booleanField(value.skipPostprocess, 'skipPostprocess', false),
    noAutoAttach: booleanField(value.noAutoAttach, 'noAutoAttach', true),
    checkOnly: booleanField(value.checkOnly, 'checkOnly', false),
    securityVerificationTimeoutSeconds: integerField(value.securityVerificationTimeoutSeconds, 'securityVerificationTimeoutSeconds', 600, 60, 86400),
    useCodexRuntime: analysisMode === 'general'
      ? true
      : booleanField(value.useCodexRuntime, 'useCodexRuntime', true),
    codexBatchSize: integerField(value.codexBatchSize, 'codexBatchSize', 8, 1, 20),
    codexTimeoutSeconds: integerField(value.codexTimeoutSeconds, 'codexTimeoutSeconds', 300, 30, 1800),
    aiSessionId: optionalUuidField(value.aiSessionId, 'aiSessionId'),
    profileId: optionalPatternField(value.profileId, 'profileId', /^[a-f0-9]{16}$/),
    candidateProfile: candidateProfileField(value.candidateProfile),
    coverLetterThreshold: integerField(value.coverLetterThreshold, 'coverLetterThreshold', 90, 90, 100),
    coverLetterMaxAttempts: integerField(value.coverLetterMaxAttempts, 'coverLetterMaxAttempts', 4, 1, 6),
    expansion,
    resumeFromJobId,
  });
}

export function validateExpansionStartRequest(value) {
  if (!isPlainObject(value)) throw new ValidationError('Request body must be a JSON object.');
  const unknown = Object.keys(value).filter((key) => !['seedPostIds', 'config'].includes(key));
  if (unknown.length) throw new ValidationError('Unsupported expansion parameters.', unknown.map((field) => ({ field, reason: 'not_allowed' })));
  if (!Array.isArray(value.seedPostIds) || value.seedPostIds.length < 1 || value.seedPostIds.length > 200) {
    throw fieldError('seedPostIds', 'array_length_1_to_200');
  }
  const seedPostIds = [...new Set(value.seedPostIds.map((item) => {
    if (typeof item !== 'string' || !/^[\p{L}\p{N}_.:-]{1,200}$/u.test(item.trim())) throw fieldError('seedPostIds', 'invalid_post_id');
    return item.trim();
  }))];
  if (value.config !== undefined && !isPlainObject(value.config)) throw fieldError('config', 'must_be_object');
  const config = expansionField({ ...(value.config || {}), enabled: true });
  if (config.rounds < 1) throw fieldError('config.rounds', 'must_be_between_1_and_10');
  return Object.freeze({ seedPostIds, config });
}

export function validateExpansionResumeRequest(value) {
  if (!isPlainObject(value)) throw new ValidationError('Request body must be a JSON object.');
  const unknown = Object.keys(value).filter((key) => key !== 'retryIncomplete');
  if (unknown.length) throw new ValidationError('Unsupported expansion resume parameters.', unknown.map((field) => ({ field, reason: 'not_allowed' })));
  return Object.freeze({ retryIncomplete: booleanField(value.retryIncomplete, 'retryIncomplete', false) });
}

export function validateExpansionCancelRequest(value) {
  if (!isPlainObject(value)) throw new ValidationError('Request body must be a JSON object.');
  const unknown = Object.keys(value);
  if (unknown.length) throw new ValidationError('Unsupported expansion cancel parameters.', unknown.map((field) => ({ field, reason: 'not_allowed' })));
  return Object.freeze({});
}

function expansionField(value) {
  const defaults = {
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
  };
  if (value === undefined || value === null) return Object.freeze(defaults);
  if (!isPlainObject(value)) throw fieldError('expansion', 'must_be_object');
  const allowed = new Set(Object.keys(defaults));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ValidationError(
      'Unsupported expansion parameters.',
      unknown.map((key) => ({ field: `expansion.${key}`, reason: 'not_allowed' })),
    );
  }
  const postSelectionStrategy = value.postSelectionStrategy ?? defaults.postSelectionStrategy;
  if (!['latest', 'keyword_match', 'top_engagement', 'all_reachable'].includes(postSelectionStrategy)) {
    throw fieldError('expansion.postSelectionStrategy', 'unsupported_strategy');
  }
  const schemaVersion = integerField(value.schemaVersion, 'expansion.schemaVersion', 1, 1, 1);
  return Object.freeze({
    enabled: booleanField(value.enabled, 'expansion.enabled', defaults.enabled),
    rounds: integerField(value.rounds, 'expansion.rounds', defaults.rounds, 0, 10),
    includeReplies: booleanField(value.includeReplies, 'expansion.includeReplies', defaults.includeReplies),
    maxReplyDepth: integerField(value.maxReplyDepth, 'expansion.maxReplyDepth', defaults.maxReplyDepth, 0, 10),
    maxUsersPerRound: integerField(value.maxUsersPerRound, 'expansion.maxUsersPerRound', defaults.maxUsersPerRound, 1, 1000),
    maxPostsPerUser: integerField(value.maxPostsPerUser, 'expansion.maxPostsPerUser', defaults.maxPostsPerUser, 1, 100),
    maxCommentsPerPost: integerField(value.maxCommentsPerPost, 'expansion.maxCommentsPerPost', defaults.maxCommentsPerPost, 1, 5000),
    maxTotalUsers: integerField(value.maxTotalUsers, 'expansion.maxTotalUsers', defaults.maxTotalUsers, 1, 100000),
    maxTotalPosts: integerField(value.maxTotalPosts, 'expansion.maxTotalPosts', defaults.maxTotalPosts, 1, 100000),
    maxTotalComments: integerField(value.maxTotalComments, 'expansion.maxTotalComments', defaults.maxTotalComments, 1, 1000000),
    timeBudgetMinutes: integerField(value.timeBudgetMinutes, 'expansion.timeBudgetMinutes', defaults.timeBudgetMinutes, 1, 1440),
    maxFailureCount: integerField(value.maxFailureCount, 'expansion.maxFailureCount', defaults.maxFailureCount, 1, 1000),
    concurrency: integerField(value.concurrency, 'expansion.concurrency', defaults.concurrency, 1, 1),
    postSelectionStrategy,
    schemaVersion,
  });
}

function candidateProfileField(value) {
  const defaults = {
    name: '',
    school: '',
    major: '',
    degreeYear: '研二',
    phoneWeChat: '',
    email: '',
    availabilityDays: '5',
    internshipDuration: '6个月',
  };
  if (value === undefined || value === null) return defaults;
  if (!isPlainObject(value)) throw fieldError('candidateProfile', 'must_be_object');
  const allowed = new Set(Object.keys(defaults));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError('Unsupported candidate profile fields.', unknown.map((key) => ({ field: `candidateProfile.${key}`, reason: 'not_allowed' })));
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
    key,
    boundedCandidateString(value[key], `candidateProfile.${key}`, fallback, key === 'email' ? 254 : 160),
  ]));
}

function boundedCandidateString(value, field, defaultValue, max) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'string') throw fieldError(field, 'must_be_string');
  const normalized = value.trim();
  if ([...normalized].length > max) throw fieldError(field, `length_0_to_${max}`);
  if (/\p{Cc}/u.test(normalized)) throw fieldError(field, 'contains_control_character');
  return normalized;
}

export function buildRunnerArgs(params, outputDir, execution = null) {
  const args = [
    '--analysis-mode', params.analysisMode,
    '--keyword', params.audienceOnly ? '' : params.keyword,
    '--content-preset', params.contentPreset,
    '--content-goal', params.contentGoal,
    '--output-dir', outputDir,
    '--search-sort', 'latest',
    '--max-age-days', '0',
    '--browser-profile', params.browserProfile,
    '--relay-port', String(params.relayPort),
    '--limit', String(params.limit),
    '--max-scrolls', String(params.maxScrolls),
    '--stable-rounds', String(params.stableRounds),
    '--goto-timeout-ms', String(params.gotoTimeoutMs),
    '--note-delay-seconds', String(params.noteDelaySeconds),
    '--speed-mode', params.speedMode,
    '--random-delay-min-seconds', String(params.randomDelayMinSeconds),
    '--random-delay-max-seconds', String(params.randomDelayMaxSeconds),
    params.mode === 'resume' ? '--resume' : '--fresh',
    '--security-verification-timeout-seconds', String(params.securityVerificationTimeoutSeconds),
    '--codex-batch-size', String(params.codexBatchSize),
    '--codex-timeout-seconds', String(params.codexTimeoutSeconds),
    '--cover-letter-threshold', String(params.coverLetterThreshold),
    '--cover-letter-max-attempts', String(params.coverLetterMaxAttempts),
  ];
  args.push(params.useCodexRuntime ? '--codex-runtime' : '--no-codex-runtime');
  if (params.completeMissingOnly) args.push('--complete-missing-only');
  args.push(params.collectAudience ? '--collect-audience' : '--no-collect-audience');
  if (params.expansion?.enabled) {
    args.push('--expansion-config-json', JSON.stringify(params.expansion));
  }
  if (params.audienceOnly) args.push('--audience-only');
  if (params.skipPostprocess) args.push('--skip-postprocess');
  if (params.noAutoAttach) args.push('--no-auto-attach');
  if (params.checkOnly) args.push('--check-only');
  if (execution !== null && execution !== undefined) {
    appendWorkflowStateArgs(args, execution);
  }
  return args;
}

function appendWorkflowStateArgs(args, execution) {
  if (!isPlainObject(execution)) throw new ValidationError('Runner execution context must be an object.');
  const required = ['resumeScope', 'attemptId', 'statePath', 'expectedStateRevision'];
  const missing = required.filter((key) => execution[key] === undefined || execution[key] === null || execution[key] === '');
  if (missing.length) {
    throw new ValidationError(
      'Runner execution context is incomplete.',
      missing.map((field) => ({ field, reason: 'required' })),
    );
  }
  if (!RESUME_SCOPES.has(execution.resumeScope)) throw fieldError('resumeScope', 'unsupported_resume_scope');
  if (typeof execution.attemptId !== 'string' || !ATTEMPT_ID.test(execution.attemptId)) {
    throw fieldError('attemptId', 'invalid_format');
  }
  if (
    typeof execution.statePath !== 'string'
    || !execution.statePath.trim()
    || execution.statePath.length > 1024
    || /\p{Cc}/u.test(execution.statePath)
  ) {
    throw fieldError('statePath', 'invalid_path');
  }
  if (!Number.isInteger(execution.expectedStateRevision) || execution.expectedStateRevision < 1) {
    throw fieldError('expectedStateRevision', 'positive_integer_required');
  }
  const checkpointDirs = execution.resumeCheckpointDirs ?? [];
  if (!Array.isArray(checkpointDirs) || checkpointDirs.length > 128) {
    throw fieldError('resumeCheckpointDirs', 'invalid_checkpoint_directories');
  }
  const normalizedCheckpointDirs = [...new Set(checkpointDirs.map((directory) => {
    if (
      typeof directory !== 'string'
      || !directory.trim()
      || directory.length > 1024
      || /\p{Cc}/u.test(directory)
    ) {
      throw fieldError('resumeCheckpointDirs', 'invalid_checkpoint_directory');
    }
    return directory;
  }))];
  args.push(
    '--resume-scope', execution.resumeScope,
    '--attempt-id', execution.attemptId,
    '--state-path', execution.statePath,
    '--expected-state-revision', String(execution.expectedStateRevision),
  );
  for (const directory of normalizedCheckpointDirs) {
    args.push('--resume-checkpoint-dir', directory);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stringField(value, field, { defaultValue, min, max }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string') throw fieldError(field, 'must_be_string');
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < min || length > max) throw fieldError(field, `length_${min}_to_${max}`);
  return normalized;
}

function optionalStringField(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw fieldError(field, 'must_be_string');
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw fieldError(field, `length_1_to_${max}`);
  return normalized;
}

function optionalUuidField(value, field) {
  return optionalPatternField(value, field, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

function optionalPatternField(value, field, pattern) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw fieldError(field, 'invalid_format');
  return value.trim();
}

function integerField(value, field, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) throw fieldError(field, `integer_${min}_to_${max}`);
  return value;
}

function numberField(value, field, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw fieldError(field, `number_${min}_to_${max}`);
  }
  return value;
}

function booleanField(value, field, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw fieldError(field, 'must_be_boolean');
  return value;
}

function fieldError(field, reason) {
  return new ValidationError(`Invalid ${field}.`, [{ field, reason }]);
}
