import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { validateAudienceAiArtifacts, writeAudienceAiLatest } from './lib/audience-ai-artifacts.mjs';

const IDENTITY = {
  jobId: '20260801010101-abcdef12',
  postId: 'post-1',
  runId: 'audai-test-1',
  inputRevision: 'a'.repeat(64),
};
const RUN_METADATA = {
  profileMode: 'headers',
  modules: ['comment_insights', 'thread_insights', 'user_insights'],
  model: { provider: 'openai', model: 'test-model', wireApi: 'responses' },
  promptVersion: 'audience-ai-v1',
  schemaVersion: 1,
};

test('audience AI artifact validation verifies identity, bytes, hashes, evidence, and checkpoints before latest activation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = { ...IDENTITY, ...RUN_METADATA, outputDir: path.join(root, 'post-1', 'audai-test-1') };
  await writeFixture(run.outputDir);

  const result = await validateAudienceAiArtifacts(run);
  assert.equal(result.comments.length, 1);
  assert.equal(result.threads.length, 1);
  assert.equal(result.users.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.chunks.length, 1);
  assert.deepEqual(result.chunks[0].entityIds, ['comment-1']);

  const latest = await writeAudienceAiLatest(run, result);
  const persisted = JSON.parse(await readFile(latest.path, 'utf8'));
  assert.equal(persisted.runId, run.runId);
  assert.match(persisted.manifestSha256, /^[a-f0-9]{64}$/u);
});

test('audience AI artifact validation rejects post-manifest tampering and unsafe manifest paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-artifacts-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = { ...IDENTITY, ...RUN_METADATA, outputDir: path.join(root, 'post-1', 'audai-test-1') };
  await writeFixture(run.outputDir);
  await writeFile(path.join(run.outputDir, 'analysis.md'), '# tampered\n', 'utf8');
  await assert.rejects(validateAudienceAiArtifacts(run), (error) => error.code === 'AUDIENCE_AI_SCHEMA_INVALID');

  await writeFixture(run.outputDir);
  const manifestPath = path.join(run.outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../analysis.json';
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await assert.rejects(validateAudienceAiArtifacts(run), (error) => error.code === 'AUDIENCE_AI_SCHEMA_INVALID');
});

test('audience AI artifact validation rejects re-signed cross-file metadata tampering', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audience-ai-artifacts-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      label: 'analysis schemaVersion',
      field: 'schemaVersion',
      mutations: [{ file: 'analysis.json', value: 'audience-ai/2' }],
    },
    {
      label: 'metadata promptVersion',
      field: 'promptVersion',
      mutations: [{ file: 'run-metadata.json', value: 'audience-ai-v2' }],
    },
    {
      label: 'co-signed provider',
      field: 'provider',
      mutations: [
        { file: 'run-metadata.json', value: 'tampered-provider' },
        { file: 'manifest.json', value: 'tampered-provider' },
      ],
    },
    {
      label: 'co-signed model',
      field: 'model',
      mutations: [
        { file: 'run-metadata.json', value: 'tampered-model' },
        { file: 'manifest.json', value: 'tampered-model' },
      ],
    },
    {
      label: 'co-signed profileMode',
      field: 'profileMode',
      mutations: [
        { file: 'run-metadata.json', value: 'none' },
        { file: 'manifest.json', value: 'none' },
      ],
    },
    {
      label: 'co-signed modules',
      field: 'modules',
      mutations: [
        { file: 'run-metadata.json', value: ['comment_insights'] },
        { file: 'manifest.json', value: ['comment_insights'] },
      ],
    },
    {
      label: 'metadata wireApi',
      field: 'wireApi',
      mutations: [{ file: 'run-metadata.json', value: 'chat_completions' }],
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.label, async () => {
      const outputDir = path.join(root, `case-${index}`);
      const run = { ...IDENTITY, ...RUN_METADATA, outputDir };
      await writeFixture(outputDir);
      await tamperAndResign(outputDir, item.field, item.mutations);
      await assert.rejects(
        validateAudienceAiArtifacts(run),
        (error) => error.code === 'AUDIENCE_AI_SCHEMA_INVALID' && error.details?.field === item.field,
      );
    });
  }
});

async function writeFixture(outputDir) {
  await mkdir(path.join(outputDir, '.checkpoints'), { recursive: true });
  const coverage = { commentsAnalyzed: 1, usersAnalyzed: 1, coverageStatus: 'complete' };
  const evidence = { evidenceId: 'comment:comment-1', entityType: 'comment', entityId: 'comment-1', excerpt: 'observable text' };
  const files = new Map([
    ['analysis.json', JSON.stringify({
      ...IDENTITY,
      schemaVersion: 'audience-ai/1',
      promptVersion: 'audience-ai-v1',
      status: 'complete',
      coverage,
      synthesis: { summary: 'fixture', evidenceRefs: [evidence.evidenceId] },
      resultCounts: { comments: 1, threads: 1, users: 1, evidence: 1 },
    })],
    ['analysis.md', '# fixture\n'],
    ['comment-insights.jsonl', `${JSON.stringify({ commentId: 'comment-1', evidenceRefs: [evidence.evidenceId] })}\n`],
    ['thread-insights.jsonl', `${JSON.stringify({ rootThreadId: 'comment-1', evidenceRefs: [evidence.evidenceId] })}\n`],
    ['user-insights.jsonl', `${JSON.stringify({ userId: 'user-1', evidenceRefs: [evidence.evidenceId] })}\n`],
    ['evidence.jsonl', `${JSON.stringify(evidence)}\n`],
    ['coverage.json', JSON.stringify(coverage)],
    ['run-metadata.json', JSON.stringify({
      ...IDENTITY,
      schemaVersion: 'audience-ai/1',
      promptVersion: 'audience-ai-v1',
      status: 'complete',
      provider: 'openai',
      model: 'test-model',
      wireApi: 'responses',
      profileMode: 'headers',
      modules: ['comment_insights', 'thread_insights', 'user_insights'],
      tokenUsage: {},
    })],
  ]);
  for (const [name, contents] of files) await writeFile(path.join(outputDir, name), contents, 'utf8');
  const entries = [...files].map(([name, contents]) => ({
    path: name,
    size: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  }));
  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
    ...IDENTITY,
    schemaVersion: 'audience-ai/1',
    promptVersion: 'audience-ai-v1',
    provider: 'openai',
    model: 'test-model',
    profileMode: 'headers',
    modules: ['comment_insights', 'thread_insights', 'user_insights'],
    status: 'complete',
    completionStatus: 'complete',
    coverage,
    files: entries,
  }), 'utf8');
  await writeFile(path.join(outputDir, '.checkpoints', 'thread-1.json'), JSON.stringify({
    schemaVersion: 'audience-ai/1',
    chunkId: 'thread-1',
    kind: 'thread_map',
    inputHash: 'b'.repeat(64),
    status: 'complete',
    completedAt: new Date().toISOString(),
    output: { commentInsights: [{ commentId: 'comment-1' }] },
  }), 'utf8');
}

async function tamperAndResign(outputDir, field, mutations) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const { file, value } of mutations) {
    const artifact = file === 'manifest.json'
      ? manifest
      : JSON.parse(await readFile(path.join(outputDir, file), 'utf8'));
    artifact[field] = value;
    if (file === 'manifest.json') continue;
    const contents = JSON.stringify(artifact);
    await writeFile(path.join(outputDir, file), contents, 'utf8');
    const entry = manifest.files.find((candidate) => candidate.path === file);
    entry.size = Buffer.byteLength(contents);
    entry.sha256 = createHash('sha256').update(contents).digest('hex');
  }
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
}
