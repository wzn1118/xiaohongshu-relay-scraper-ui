import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { artifactId, artifactPathFromId, assertPathInside } from './lib/artifacts.mjs';
import { ValidationError, buildRunnerArgs, validateRunRequest } from './lib/contracts.mjs';

test('validateRunRequest applies bounded production defaults', () => {
  const result = validateRunRequest({});
  assert.equal(result.keyword, '实习继任');
  assert.equal(result.searchSort, 'latest');
  assert.equal(result.maxAgeDays, 30);
  assert.equal(result.limit, 0);
  assert.equal(result.maxScrolls, 40);
  assert.equal(result.stableRounds, 4);
  assert.equal(result.relayPort, 18800);
  assert.equal(result.speedMode, 'random');
  assert.equal(result.randomDelayMinSeconds, 0.8);
  assert.equal(result.randomDelayMaxSeconds, 2.4);
  assert.equal(result.noAutoAttach, true);
  assert.equal(result.mode, 'fresh');
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
});

test('validateRunRequest always normalizes collection to full-body mode', () => {
  assert.equal(validateRunRequest({ limit: 0 }).limit, 0);
  assert.equal(validateRunRequest({ limit: 1000 }).limit, 0);
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
  const params = validateRunRequest({ mode: 'resume', resumeFromJobId: '20260728034820-6b942873' });
  assert.equal(params.resumeFromJobId, '20260728034820-6b942873');
  assert.throws(() => validateRunRequest({ mode: 'fresh', resumeFromJobId: '20260728034820-6b942873' }), ValidationError);
  assert.throws(() => validateRunRequest({ mode: 'resume', resumeFromJobId: '../escape' }), ValidationError);
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
  const params = validateRunRequest({ keyword: '测试', mode: 'resume', skipPostprocess: true });
  const args = buildRunnerArgs(params, path.resolve('output'));
  assert.deepEqual(args.slice(0, 4), ['--keyword', '测试', '--output-dir', path.resolve('output')]);
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('--skip-postprocess'));
  assert.ok(args.includes('--no-auto-attach'));
  assert.ok(args.includes('--codex-runtime'));
  assert.equal(args[args.indexOf('--search-sort') + 1], 'latest');
  assert.equal(args[args.indexOf('--max-age-days') + 1], '30');
  assert.equal(args[args.indexOf('--security-verification-timeout-seconds') + 1], '600');
  assert.equal(args[args.indexOf('--speed-mode') + 1], 'random');
  assert.equal(args[args.indexOf('--random-delay-min-seconds') + 1], '0.8');
  assert.equal(args[args.indexOf('--random-delay-max-seconds') + 1], '2.4');
  assert.equal(args.some((arg) => /[;&|]/.test(arg)), false);
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
