import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { artifactId, artifactPathFromId, assertPathInside } from './lib/artifacts.mjs';
import { ValidationError, buildRunnerArgs, validateAudienceGrowthRequest, validateExpansionCancelRequest, validateExpansionResumeRequest, validateExpansionStartRequest, validateRunRequest } from './lib/contracts.mjs';

test('validateRunRequest applies bounded production defaults', () => {
  const result = validateRunRequest({});
  assert.equal(result.analysisMode, 'job');
  assert.equal(result.keyword, '实习继任');
  assert.equal(result.contentPreset, 'auto');
  assert.equal(result.contentGoal, '');
  assert.equal(result.searchSort, 'latest');
  assert.equal(result.maxAgeDays, 14);
  assert.equal(result.limit, 0);
  assert.equal(result.maxScrolls, 40);
  assert.equal(result.stableRounds, 4);
  assert.equal(result.relayPort, 18800);
  assert.equal(result.speedMode, 'random');
  assert.equal(result.randomDelayMinSeconds, 0.8);
  assert.equal(result.randomDelayMaxSeconds, 2.4);
  assert.equal(result.noAutoAttach, true);
  assert.equal(result.mode, 'fresh');
  assert.equal(result.completeMissingOnly, false);
  assert.equal(result.collectAudience, false);
  assert.equal(result.audienceOnly, false);
  assert.deepEqual(result.expansion, {
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
  });
  assert.equal(result.securityVerificationTimeoutSeconds, 600);
  assert.equal(result.useCodexRuntime, true);
  assert.equal(result.codexBatchSize, 8);
  assert.equal(result.candidateProfile.availabilityDays, '5');
  assert.equal(result.candidateProfile.internshipDuration, '6个月');
});

test('validateRunRequest rejects unknown and malformed parameters', () => {
  assert.throws(() => validateRunRequest({ searchUrl: 'https://example.com' }), ValidationError);
  assert.throws(() => validateRunRequest({ browserProfile: '../../profile' }), ValidationError);
  assert.throws(() => validateRunRequest({ limit: 1001 }), ValidationError);
  assert.throws(() => validateRunRequest({ keyword: 'bad\nvalue' }), ValidationError);
  assert.throws(() => validateRunRequest({ searchSort: 'oldest' }), ValidationError);
  assert.throws(() => validateRunRequest({ maxAgeDays: 366 }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'marketing' }), ValidationError);
  assert.throws(() => validateRunRequest({ contentPreset: 'recruitment' }), ValidationError);
  assert.throws(() => validateRunRequest({ contentGoal: 'bad\nvalue' }), ValidationError);
});

test('validateRunRequest allows a full day for manual security verification', () => {
  const result = validateRunRequest({
    analysisMode: 'general',
    keyword: 'test',
    securityVerificationTimeoutSeconds: 86400,
  });

  assert.equal(result.securityVerificationTimeoutSeconds, 86400);
});

test('validateRunRequest accepts a bounded non-job research brief', () => {
  const result = validateRunRequest({
    analysisMode: 'general',
    keyword: '城市徒步',
    contentPreset: 'experience',
    contentGoal: '提炼适合第一次徒步者的路线、准备事项和常见踩坑。',
  });
  assert.equal(result.analysisMode, 'general');
  assert.equal(result.keyword, '城市徒步');
  assert.equal(result.contentPreset, 'experience');
  assert.equal(result.contentGoal, '提炼适合第一次徒步者的路线、准备事项和常见踩坑。');
  assert.equal(result.collectAudience, true);
});

test('audience-only collection requires a general resume source', () => {
  const sourceId = '20260728034820-6b942873';
  const result = validateRunRequest({
    analysisMode: 'general',
    mode: 'resume',
    resumeFromJobId: sourceId,
    collectAudience: true,
    audienceOnly: true,
  });
  assert.equal(result.collectAudience, true);
  assert.equal(result.audienceOnly, true);
  assert.throws(() => validateRunRequest({ audienceOnly: true }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'job', mode: 'resume', resumeFromJobId: sourceId, audienceOnly: true }), ValidationError);
});

test('expansion parameters are optional, strict, bounded, and general-mode only', () => {
  const result = validateRunRequest({
    analysisMode: 'general',
    expansion: {
      enabled: true,
      rounds: 2,
      maxUsersPerRound: 50,
      postSelectionStrategy: 'keyword_match',
    },
  });
  assert.equal(result.collectAudience, true);
  assert.equal(result.expansion.rounds, 2);
  assert.equal(result.expansion.maxUsersPerRound, 50);
  assert.equal(result.expansion.maxPostsPerUser, 3);
  assert.throws(() => validateRunRequest({ expansion: { enabled: true } }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'general', expansion: { enabled: true, unknown: 1 } }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'general', expansion: { enabled: true, rounds: '2' } }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'general', expansion: { enabled: true, rounds: 11 } }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'general', expansion: { enabled: true, concurrency: 2 } }), ValidationError);
  assert.throws(() => validateRunRequest({ analysisMode: 'general', expansion: { enabled: true, postSelectionStrategy: 'random' } }), ValidationError);
});

test('validateRunRequest keeps unlimited count and requested recency scope', () => {
  assert.equal(validateRunRequest({ limit: 0 }).limit, 0);
  assert.equal(validateRunRequest({ limit: 1000 }).limit, 0);
  assert.equal(validateRunRequest({ maxAgeDays: 30 }).maxAgeDays, 30);
});

test('validateRunRequest always normalizes collection to latest-first search', () => {
  assert.equal(validateRunRequest({ searchSort: 'latest' }).searchSort, 'latest');
  assert.equal(validateRunRequest({ searchSort: 'comprehensive' }).searchSort, 'latest');
});

test('validateRunRequest validates collection pacing ranges', () => {
  const result = validateRunRequest({
    speedMode: 'steady',
    noteDelaySeconds: 3,
    randomDelayMinSeconds: 1,
    randomDelayMaxSeconds: 5,
  });
  assert.equal(result.speedMode, 'steady');
  assert.equal(result.noteDelaySeconds, 3);
  assert.throws(() => validateRunRequest({ speedMode: 'burst' }), ValidationError);
  assert.throws(() => validateRunRequest({ randomDelayMinSeconds: 5, randomDelayMaxSeconds: 1 }), ValidationError);
});

test('validateRunRequest accepts only valid resume source ids in resume mode', () => {
  const params = validateRunRequest({ mode: 'resume', resumeFromJobId: '20260728034820-6b942873', completeMissingOnly: true });
  assert.equal(params.resumeFromJobId, '20260728034820-6b942873');
  assert.equal(params.completeMissingOnly, true);
  assert.throws(() => validateRunRequest({ mode: 'fresh', resumeFromJobId: '20260728034820-6b942873' }), ValidationError);
  assert.throws(() => validateRunRequest({ mode: 'resume', resumeFromJobId: '../escape' }), ValidationError);
  assert.throws(() => validateRunRequest({ mode: 'resume', completeMissingOnly: true }), ValidationError);
});

test('validateRunRequest accepts bounded runtime candidate application fields', () => {
  const result = validateRunRequest({
    candidateProfile: {
      name: 'Example Candidate',
      school: 'Example University',
      major: 'Data Analytics',
      degreeYear: 'Year 2',
      phoneWeChat: 'contact-placeholder',
      email: 'candidate@example.com',
      availabilityDays: '5',
      internshipDuration: '6 months',
    },
  });
  assert.equal(result.candidateProfile.name, 'Example Candidate');
  assert.equal(result.candidateProfile.email, 'candidate@example.com');
  assert.throws(() => validateRunRequest({ candidateProfile: { unknown: 'value' } }), ValidationError);
  assert.throws(() => validateRunRequest({ candidateProfile: { name: 'line\nvalue' } }), ValidationError);
});

test('buildRunnerArgs only emits the normalized whitelist', () => {
  const params = validateRunRequest({
    keyword: '测试',
    mode: 'resume',
    resumeFromJobId: '20260728034820-6b942873',
    completeMissingOnly: true,
    skipPostprocess: true,
  });
  const args = buildRunnerArgs(params, path.resolve('output'));
  assert.equal(args[args.indexOf('--keyword') + 1], '测试');
  assert.equal(args[args.indexOf('--output-dir') + 1], path.resolve('output'));
  assert.equal(args[args.indexOf('--analysis-mode') + 1], 'job');
  assert.equal(args[args.indexOf('--content-preset') + 1], 'auto');
  assert.equal(args[args.indexOf('--content-goal') + 1], '');
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('--complete-missing-only'));
  assert.ok(args.includes('--skip-postprocess'));
  assert.ok(args.includes('--no-auto-attach'));
  assert.ok(args.includes('--codex-runtime'));
  assert.ok(args.includes('--no-collect-audience'));
  assert.equal(args[args.indexOf('--search-sort') + 1], 'latest');
  const tamperedArgs = buildRunnerArgs({ ...params, searchSort: 'comprehensive' }, path.resolve('output'));
  assert.equal(tamperedArgs[tamperedArgs.indexOf('--search-sort') + 1], 'latest');
  assert.equal(args[args.indexOf('--max-age-days') + 1], '14');
  const tamperedAgeArgs = buildRunnerArgs({ ...params, maxAgeDays: 30 }, path.resolve('output'));
  assert.equal(tamperedAgeArgs[tamperedAgeArgs.indexOf('--max-age-days') + 1], '30');
  assert.equal(args[args.indexOf('--security-verification-timeout-seconds') + 1], '600');
  assert.equal(args[args.indexOf('--speed-mode') + 1], 'random');
  assert.equal(args[args.indexOf('--random-delay-min-seconds') + 1], '0.8');
  assert.equal(args[args.indexOf('--random-delay-max-seconds') + 1], '2.4');
  assert.equal(args.some((arg) => /[;&|]/.test(arg)), false);
});

test('buildRunnerArgs supports the internal body-only workflow mode', () => {
  const params = validateRunRequest({ analysisMode: 'general', keyword: 'batch body import' });
  const args = buildRunnerArgs({ ...params, bodyOnly: true }, path.resolve('output'));
  assert.equal(args.includes('--body-only'), true);
});

test('buildRunnerArgs applies adaptive high-throughput pacing to imported body tasks', () => {
  const params = validateRunRequest({ analysisMode: 'general', keyword: 'batch body import' });
  const args = buildRunnerArgs({
    ...params,
    bodyOnly: true,
    importedBodyCount: 602,
  }, path.resolve('output'));

  assert.equal(args[args.indexOf('--note-delay-seconds') + 1], '1.2');
  assert.equal(args[args.indexOf('--random-delay-min-seconds') + 1], '0.8');
  assert.equal(args[args.indexOf('--random-delay-max-seconds') + 1], '2.4');
  assert.equal(args[args.indexOf('--page-recovery-delay-seconds') + 1], '0.5');
  assert.equal(args[args.indexOf('--body-batch-size') + 1], '6');
  assert.equal(args[args.indexOf('--body-batch-pause-min-seconds') + 1], '8');
  assert.equal(args[args.indexOf('--body-batch-pause-max-seconds') + 1], '15');
  assert.equal(args[args.indexOf('--proactive-rest-every') + 1], '120');
  assert.equal(args[args.indexOf('--proactive-rest-seconds') + 1], '600');
  assert.equal(args.includes('--adaptive-pacing'), true);
  assert.equal(args[args.indexOf('--adaptive-max-delay-seconds') + 1], '20');
  assert.equal(args.includes('--block-heavy-resources'), true);
  assert.equal(args.includes('--rate-limit-auto-recovery'), true);
  assert.equal(args[args.indexOf('--rate-limit-initial-delay-seconds') + 1], '120');
  assert.equal(args[args.indexOf('--rate-limit-max-delay-seconds') + 1], '900');
  assert.equal(args[args.indexOf('--rate-limit-recovery-spacing-seconds') + 1], '30');
  assert.equal(args[args.indexOf('--rate-limit-max-recovery-spacing-seconds') + 1], '120');
  assert.equal(args.includes('--reuse-body-cache'), true);
  assert.equal(args[args.indexOf('--body-cache-max-age-days') + 1], '30');
});

test('audience growth requests are bounded and emit a dedicated runner flag', () => {
  assert.deepEqual(validateAudienceGrowthRequest({}), { maxScrolls: 60 });
  assert.deepEqual(validateAudienceGrowthRequest({ maxScrolls: 100 }), { maxScrolls: 100 });
  assert.throws(() => validateAudienceGrowthRequest({ maxScrolls: 101 }), ValidationError);
  assert.throws(() => validateAudienceGrowthRequest({ maxScrolls: 60, unknown: true }), ValidationError);

  const params = validateRunRequest({
    analysisMode: 'general',
    mode: 'resume',
    resumeFromJobId: '20260728034820-6b942873',
    collectAudience: true,
    discoverMore: true,
  });
  const args = buildRunnerArgs(params, path.resolve('output'));
  assert.equal(args.includes('--discover-more'), true);
  assert.equal(args.includes('--audience-only'), false);
});

test('buildRunnerArgs emits the isolated audience resume mode', () => {
  const params = validateRunRequest({
    analysisMode: 'general',
    keyword: 'must-not-open-a-new-search',
    mode: 'resume',
    resumeFromJobId: '20260728034820-6b942873',
    audienceOnly: true,
  });
  const args = buildRunnerArgs(params, path.resolve('output'));
  assert.ok(args.includes('--collect-audience'));
  assert.ok(args.includes('--audience-only'));
  assert.equal(args.includes('--no-collect-audience'), false);
  assert.equal(args[args.indexOf('--keyword') + 1], '');
});

test('buildRunnerArgs emits expansion configuration only when enabled', () => {
  const disabled = validateRunRequest({ analysisMode: 'general' });
  assert.equal(buildRunnerArgs(disabled, path.resolve('output')).includes('--expansion-config-json'), false);

  const enabled = validateRunRequest({
    analysisMode: 'general',
    expansion: { enabled: true, rounds: 1 },
  });
  const args = buildRunnerArgs(enabled, path.resolve('output'));
  const index = args.indexOf('--expansion-config-json');
  assert.ok(index > -1);
  assert.deepEqual(JSON.parse(args[index + 1]), enabled.expansion);
});

test('expansion workspace requests are strict, bounded, and deduplicate seeds', () => {
  const request = validateExpansionStartRequest({
    seedPostIds: ['post-1', 'post-1', 'post:2'],
    config: { rounds: 3, maxUsersPerRound: 25 },
  });
  assert.deepEqual(request.seedPostIds, ['post-1', 'post:2']);
  assert.equal(request.config.enabled, true);
  assert.equal(request.config.rounds, 3);
  assert.equal(request.config.maxUsersPerRound, 25);
  assert.throws(() => validateExpansionStartRequest({ seedPostIds: [] }), ValidationError);
  assert.throws(() => validateExpansionStartRequest({ seedPostIds: ['../escape'] }), ValidationError);
  assert.throws(() => validateExpansionStartRequest({ seedPostIds: ['post-1'], config: 'bad' }), ValidationError);
  assert.throws(() => validateExpansionStartRequest({ seedPostIds: ['post-1'], unexpected: true }), ValidationError);
  assert.deepEqual(validateExpansionResumeRequest({ retryIncomplete: true }), { retryIncomplete: true });
  assert.throws(() => validateExpansionResumeRequest({ retryIncomplete: true, seedPostIds: ['post-1'] }), ValidationError);
  assert.deepEqual(validateExpansionCancelRequest({}), {});
  assert.throws(() => validateExpansionCancelRequest({ force: true }), ValidationError);
});

test('buildRunnerArgs emits the complete workflow-state execution context', () => {
  const params = validateRunRequest({});
  const statePath = path.resolve('data', 'jobs', 'job-1', 'workflow-state.json');
  const checkpointDirs = [
    path.resolve('data', 'jobs', 'legacy-a', 'artifacts'),
    path.resolve('data', 'jobs', 'legacy-b', 'artifacts'),
  ];
  const args = buildRunnerArgs(params, path.resolve('output'), {
    resumeScope: 'body_completion',
    attemptId: 'attempt-2',
    statePath,
    expectedStateRevision: 17,
    resumeCheckpointDirs: [...checkpointDirs, checkpointDirs[0]],
  });
  assert.equal(args[args.indexOf('--resume-scope') + 1], 'body_completion');
  assert.equal(args[args.indexOf('--attempt-id') + 1], 'attempt-2');
  assert.equal(args[args.indexOf('--state-path') + 1], statePath);
  assert.equal(args[args.indexOf('--expected-state-revision') + 1], '17');
  assert.deepEqual(
    args.flatMap((value, index) => value === '--resume-checkpoint-dir' ? [args[index + 1]] : []),
    checkpointDirs,
  );
});

test('buildRunnerArgs rejects partial or invalid workflow-state execution context', () => {
  const params = validateRunRequest({});
  assert.throws(
    () => buildRunnerArgs(params, path.resolve('output'), { resumeScope: 'full' }),
    ValidationError,
  );
  assert.throws(
    () => buildRunnerArgs(params, path.resolve('output'), {
      resumeScope: 'unknown',
      attemptId: 'attempt-2',
      statePath: path.resolve('workflow-state.json'),
      expectedStateRevision: 1,
    }),
    ValidationError,
  );
  assert.throws(
    () => buildRunnerArgs(params, path.resolve('output'), {
      resumeScope: 'full',
      attemptId: 'attempt-2',
      statePath: path.resolve('workflow-state.json'),
      expectedStateRevision: 1,
      resumeCheckpointDirs: ['valid', 'bad\npath'],
    }),
    ValidationError,
  );
});

test('artifact ids round-trip safe nested paths', () => {
  const root = path.resolve('artifacts');
  const id = artifactId('reports/result.json');
  const resolved = artifactPathFromId(root, id);
  assert.equal(resolved.relative, 'reports/result.json');
  assert.equal(resolved.absolute, path.join(root, 'reports', 'result.json'));
});

test('artifact paths reject traversal and absolute paths', () => {
  const root = path.resolve('artifacts');
  assert.throws(() => artifactPathFromId(root, Buffer.from('../secret').toString('base64url')));
  assert.throws(() => artifactPathFromId(root, Buffer.from('C:/secret').toString('base64url')));
  assert.throws(() => assertPathInside(root, path.resolve(root, '..', 'secret')));
});
