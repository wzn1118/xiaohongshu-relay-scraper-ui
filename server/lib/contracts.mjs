const ALLOWED_KEYS = new Set([
  'keyword',
  'browserProfile',
  'relayPort',
  'limit',
  'maxScrolls',
  'stableRounds',
  'gotoTimeoutMs',
  'noteDelaySeconds',
  'mode',
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
  'coverLetterThreshold',
  'coverLetterMaxAttempts',
]);

const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/;

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

  const keyword = stringField(value.keyword, 'keyword', { defaultValue: '实习继任', min: 1, max: 80 });
  if (/\p{Cc}/u.test(keyword)) throw fieldError('keyword', 'contains_control_character');

  const browserProfile = stringField(value.browserProfile, 'browserProfile', {
    defaultValue: 'openclaw',
    min: 1,
    max: 64,
  });
  if (!/^[\p{L}\p{N}_.-]+$/u.test(browserProfile)) throw fieldError('browserProfile', 'invalid_format');

  const mode = value.mode ?? 'fresh';
  if (mode !== 'fresh' && mode !== 'resume') throw fieldError('mode', 'must_be_fresh_or_resume');
  const resumeFromJobId = optionalStringField(value.resumeFromJobId, 'resumeFromJobId', 64);
  if (resumeFromJobId && !JOB_ID.test(resumeFromJobId)) throw fieldError('resumeFromJobId', 'invalid_job_id');
  if (resumeFromJobId && mode !== 'resume') throw fieldError('resumeFromJobId', 'requires_resume_mode');

  return Object.freeze({
    keyword,
    browserProfile,
    relayPort: integerField(value.relayPort, 'relayPort', 18800, 1, 65535),
    // The upstream scraper uses 0 to mean every unique card found before the
    // search result stream stabilizes.
    limit: integerField(value.limit, 'limit', 0, 0, 1000),
    maxScrolls: integerField(value.maxScrolls, 'maxScrolls', 40, 1, 100),
    stableRounds: integerField(value.stableRounds, 'stableRounds', 4, 1, 20),
    gotoTimeoutMs: integerField(value.gotoTimeoutMs, 'gotoTimeoutMs', 15000, 3000, 120000),
    noteDelaySeconds: numberField(value.noteDelaySeconds, 'noteDelaySeconds', 0.2, 0, 10),
    mode,
    skipPostprocess: booleanField(value.skipPostprocess, 'skipPostprocess', false),
    noAutoAttach: booleanField(value.noAutoAttach, 'noAutoAttach', true),
    checkOnly: booleanField(value.checkOnly, 'checkOnly', false),
    securityVerificationTimeoutSeconds: integerField(value.securityVerificationTimeoutSeconds, 'securityVerificationTimeoutSeconds', 600, 60, 3600),
    useCodexRuntime: booleanField(value.useCodexRuntime, 'useCodexRuntime', true),
    codexBatchSize: integerField(value.codexBatchSize, 'codexBatchSize', 8, 1, 20),
    codexTimeoutSeconds: integerField(value.codexTimeoutSeconds, 'codexTimeoutSeconds', 300, 30, 1800),
    aiSessionId: optionalUuidField(value.aiSessionId, 'aiSessionId'),
    profileId: optionalPatternField(value.profileId, 'profileId', /^[a-f0-9]{16}$/),
    coverLetterThreshold: integerField(value.coverLetterThreshold, 'coverLetterThreshold', 90, 90, 100),
    coverLetterMaxAttempts: integerField(value.coverLetterMaxAttempts, 'coverLetterMaxAttempts', 4, 1, 6),
    resumeFromJobId,
  });
}

export function buildRunnerArgs(params, outputDir) {
  const args = [
    '--keyword', params.keyword,
    '--output-dir', outputDir,
    '--browser-profile', params.browserProfile,
    '--relay-port', String(params.relayPort),
    '--limit', String(params.limit),
    '--max-scrolls', String(params.maxScrolls),
    '--stable-rounds', String(params.stableRounds),
    '--goto-timeout-ms', String(params.gotoTimeoutMs),
    '--note-delay-seconds', String(params.noteDelaySeconds),
    params.mode === 'resume' ? '--resume' : '--fresh',
    '--security-verification-timeout-seconds', String(params.securityVerificationTimeoutSeconds),
    '--codex-batch-size', String(params.codexBatchSize),
    '--codex-timeout-seconds', String(params.codexTimeoutSeconds),
    '--cover-letter-threshold', String(params.coverLetterThreshold),
    '--cover-letter-max-attempts', String(params.coverLetterMaxAttempts),
  ];
  args.push(params.useCodexRuntime ? '--codex-runtime' : '--no-codex-runtime');
  if (params.skipPostprocess) args.push('--skip-postprocess');
  if (params.noAutoAttach) args.push('--no-auto-attach');
  if (params.checkOnly) args.push('--check-only');
  return args;
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
