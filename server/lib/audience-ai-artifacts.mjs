import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { access, readFile, readdir, stat } from 'node:fs/promises';

const DATA_FILES = Object.freeze([
  'analysis.json',
  'analysis.md',
  'comment-insights.jsonl',
  'thread-insights.jsonl',
  'user-insights.jsonl',
  'evidence.jsonl',
  'coverage.json',
  'run-metadata.json',
]);
const REQUIRED_FILES = Object.freeze([...DATA_FILES, 'manifest.json']);
export const AUDIENCE_AI_ARTIFACTS = REQUIRED_FILES;
const JSON_FILES = new Set(['analysis.json', 'coverage.json', 'run-metadata.json']);
const JSONL_FILES = new Set([
  'comment-insights.jsonl',
  'thread-insights.jsonl',
  'user-insights.jsonl',
  'evidence.jsonl',
]);
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export async function validateAudienceAiArtifacts(run, { allowedStatuses = ['complete'] } = {}) {
  for (const name of REQUIRED_FILES) await access(path.join(run.outputDir, name));
  const manifest = await readJson(path.join(run.outputDir, 'manifest.json'), 'manifest.json');
  assertIdentity(manifest, run, 'manifest.json');
  if (!allowedStatuses.includes(manifest.completionStatus) || manifest.status !== manifest.completionStatus) {
    throw artifactError('Audience AI manifest has an invalid completion status.', { runId: run.runId });
  }
  const entries = validateManifestEntries(manifest.files);
  const parsed = new Map();
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(run.outputDir, entry.path);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== entry.size || fileStat.size > MAX_ARTIFACT_BYTES) {
      throw artifactError('Audience AI artifact size does not match its manifest.', { runId: run.runId, path: entry.path });
    }
    const bytes = await readFile(filePath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) {
      throw artifactError('Audience AI artifact hash does not match its manifest.', { runId: run.runId, path: entry.path });
    }
    if (JSON_FILES.has(entry.path)) parsed.set(entry.path, parseJson(bytes.toString('utf8'), entry.path));
    if (JSONL_FILES.has(entry.path)) parsed.set(entry.path, parseJsonLines(bytes.toString('utf8'), entry.path));
  }));

  const analysis = parsed.get('analysis.json');
  const coverage = parsed.get('coverage.json');
  const metadata = parsed.get('run-metadata.json');
  const comments = parsed.get('comment-insights.jsonl');
  const threads = parsed.get('thread-insights.jsonl');
  const users = parsed.get('user-insights.jsonl');
  const evidence = parsed.get('evidence.jsonl');
  for (const [name, value] of [['analysis.json', analysis], ['run-metadata.json', metadata]]) {
    assertIdentity(value, run, name);
  }
  if (analysis.status !== manifest.completionStatus || metadata.status !== manifest.completionStatus) {
    throw artifactError('Audience AI artifact statuses disagree.', { runId: run.runId });
  }
  assertMetadataConsistency({ analysis, metadata, manifest, run });
  if (!sameJson(analysis.coverage, coverage) || !sameJson(manifest.coverage, coverage)) {
    throw artifactError('Audience AI coverage artifacts disagree.', { runId: run.runId });
  }
  assertResultCount(analysis, 'comments', comments.length);
  assertResultCount(analysis, 'threads', threads.length);
  assertResultCount(analysis, 'users', users.length);
  assertResultCount(analysis, 'evidence', evidence.length);
  assertUniqueEntityIds(comments, 'commentId', 'comment insight');
  assertUniqueEntityIds(threads, 'rootThreadId', 'thread insight');
  assertUniqueEntityIds(users, 'userId', 'user insight');
  assertUniqueEntityIds(evidence, 'evidenceId', 'evidence');
  assertEvidenceReferences({ analysis, comments, threads, users, evidence });

  const chunks = await readCheckpointChunks(path.join(run.outputDir, '.checkpoints'));
  return { analysis, coverage, metadata, manifest, comments, threads, users, evidence, chunks };
}

export function writeAudienceAiLatest(run, validated) {
  const latestPath = path.join(path.dirname(run.outputDir), 'latest.json');
  const value = {
    schemaVersion: validated.manifest.schemaVersion,
    jobId: run.jobId,
    postId: run.postId,
    runId: run.runId,
    inputRevision: run.inputRevision,
    status: validated.analysis.status,
    outputDir: run.outputDir,
    manifestSha256: createHash('sha256')
      .update(readFileSync(path.join(run.outputDir, 'manifest.json')))
      .digest('hex'),
    activatedAt: new Date().toISOString(),
  };
  const previous = existsSync(latestPath) ? readFileSync(latestPath) : null;
  atomicWriteSync(latestPath, `${JSON.stringify(value, null, 2)}\n`);
  return {
    path: latestPath,
    value,
    rollback() {
      if (previous === null) {
        try { unlinkSync(latestPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        return;
      }
      atomicWriteSync(latestPath, previous);
    },
  };
}

function atomicWriteSync(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError; }
    throw error;
  }
}

function validateManifestEntries(files) {
  if (!Array.isArray(files) || files.length !== DATA_FILES.length) {
    throw artifactError('Audience AI manifest does not list the required artifacts.');
  }
  const expected = new Set(DATA_FILES);
  const seen = new Set();
  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw artifactError('Audience AI manifest contains an invalid file entry.');
    }
    if (path.basename(entry.path) !== entry.path || !expected.has(entry.path) || seen.has(entry.path)) {
      throw artifactError('Audience AI manifest contains an unsafe or duplicate file path.', { path: entry.path });
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 || '')) {
      throw artifactError('Audience AI manifest contains invalid size or hash metadata.', { path: entry.path });
    }
    seen.add(entry.path);
  }
  if ([...expected].some((name) => !seen.has(name))) {
    throw artifactError('Audience AI manifest is missing a required artifact.');
  }
  return files;
}

async function readCheckpointChunks(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => {
    if (path.basename(name) !== name) throw artifactError('Audience AI checkpoint path is unsafe.', { path: name });
    const checkpoint = await readJson(path.join(directory, name), `.checkpoints/${name}`);
    if (
      typeof checkpoint.chunkId !== 'string'
      || typeof checkpoint.kind !== 'string'
      || typeof checkpoint.inputHash !== 'string'
      || checkpoint.status !== 'complete'
      || !checkpoint.output
      || typeof checkpoint.output !== 'object'
    ) {
      throw artifactError('Audience AI checkpoint is invalid.', { path: name });
    }
    return {
      chunkId: checkpoint.chunkId,
      kind: checkpoint.kind,
      entityIds: collectEntityIds(checkpoint.output),
      inputHash: checkpoint.inputHash,
      status: checkpoint.status,
      attemptCount: 1,
      outputHash: createHash('sha256').update(stableJson(checkpoint.output)).digest('hex'),
      completedAt: checkpoint.completedAt || null,
    };
  }));
}

function assertIdentity(value, run, name) {
  if (
    !value
    || value.jobId !== run.jobId
    || value.postId !== run.postId
    || value.runId !== run.runId
    || value.inputRevision !== run.inputRevision
  ) {
    throw artifactError('Audience AI artifact identity does not match the requested run.', { runId: run.runId, path: name });
  }
}

function assertMetadataConsistency({ analysis, metadata, manifest, run }) {
  assertMatchingMetadata('schemaVersion', [analysis.schemaVersion, metadata.schemaVersion, manifest.schemaVersion]);
  assertMatchingMetadata('promptVersion', [analysis.promptVersion, metadata.promptVersion, manifest.promptVersion]);
  assertMatchingMetadata('provider', [metadata.provider, manifest.provider]);
  assertMatchingMetadata('model', [metadata.model, manifest.model]);
  assertMatchingMetadata('wireApi', [metadata.wireApi]);
  assertMatchingMetadata('profileMode', [metadata.profileMode, manifest.profileMode]);
  if (!Array.isArray(metadata.modules) || !Array.isArray(manifest.modules) || !sameJson(metadata.modules, manifest.modules)) {
    throw artifactError('Audience AI artifact metadata disagrees.', { runId: run.runId, field: 'modules' });
  }

  const expectedSchemaVersion = normalizeRunSchemaVersion(run.schemaVersion);
  if (expectedSchemaVersion !== null) {
    assertMatchingMetadata('schemaVersion', [manifest.schemaVersion, expectedSchemaVersion], run.runId);
  }
  if (run.promptVersion !== undefined && run.promptVersion !== null) {
    assertMatchingMetadata('promptVersion', [manifest.promptVersion, run.promptVersion], run.runId);
  }
  if (run.profileMode !== undefined && run.profileMode !== null) {
    assertMatchingMetadata('profileMode', [manifest.profileMode, run.profileMode], run.runId);
  }
  if (run.modules !== undefined) {
    if (!Array.isArray(run.modules) || !sameJson(manifest.modules, run.modules)) {
      throw artifactError('Audience AI artifact metadata does not match the requested run.', {
        runId: run.runId, field: 'modules',
      });
    }
  }
  const expectedModel = run.model && typeof run.model === 'object' ? run.model : null;
  if (expectedModel) {
    for (const field of ['provider', 'model']) {
      if (expectedModel[field] !== undefined && expectedModel[field] !== null) {
        assertMatchingMetadata(field, [metadata[field], expectedModel[field]], run.runId);
      }
    }
    if (expectedModel.wireApi !== undefined && expectedModel.wireApi !== null) {
      assertMatchingMetadata('wireApi', [metadata.wireApi, expectedModel.wireApi], run.runId);
    }
  }
}

function assertMatchingMetadata(field, values, runId = undefined) {
  if (
    values.some((value) => typeof value !== 'string' || !value)
    || values.some((value) => value !== values[0])
  ) {
    throw artifactError(
      runId
        ? 'Audience AI artifact metadata does not match the requested run.'
        : 'Audience AI artifact metadata disagrees.',
      { ...(runId ? { runId } : {}), field },
    );
  }
}

function normalizeRunSchemaVersion(value) {
  if (value === undefined || value === null) return null;
  if (Number.isSafeInteger(value) && value >= 0) return `audience-ai/${value}`;
  return value;
}

function assertResultCount(analysis, key, actual) {
  if (!analysis.resultCounts || analysis.resultCounts[key] !== actual) {
    throw artifactError('Audience AI result counts do not match entity artifacts.', { entityType: key });
  }
}

function assertUniqueEntityIds(records, key, label) {
  const seen = new Set();
  for (const record of records) {
    const id = record?.[key];
    if (typeof id !== 'string' || !id || seen.has(id)) {
      throw artifactError(`Audience AI ${label} identifiers are missing or duplicated.`);
    }
    seen.add(id);
  }
}

function assertEvidenceReferences({ analysis, comments, threads, users, evidence }) {
  const available = new Set(evidence.map((item) => item.evidenceId));
  const refs = collectEvidenceRefs({ synthesis: analysis.synthesis, comments, threads, users });
  const missing = refs.filter((ref) => !available.has(ref));
  if (missing.length) {
    throw artifactError('Audience AI result references evidence that is not present.', { missingEvidenceRefs: [...new Set(missing)].slice(0, 20) });
  }
}

function collectEvidenceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'evidenceRefs' && Array.isArray(item)) refs.push(...item.filter((ref) => typeof ref === 'string'));
      else collectEvidenceRefs(item, refs);
    }
  }
  return refs;
}

function collectEntityIds(value) {
  const ids = new Set();
  walk(value, (key, item) => {
    if (['commentId', 'rootThreadId', 'userId'].includes(key) && typeof item === 'string' && item) ids.add(item);
  });
  return [...ids].sort();
}

function walk(value, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      visitor(key, item);
      walk(item, visitor);
    });
  }
}

function parseJsonLines(text, name) {
  return text.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch {
      throw artifactError('Audience AI JSONL artifact is invalid.', { path: name, line: index + 1 });
    }
  });
}

async function readJson(filePath, name) {
  return parseJson(await readFile(filePath, 'utf8'), name);
}

function parseJson(text, name) {
  try { return JSON.parse(text); } catch {
    throw artifactError('Audience AI JSON artifact is invalid.', { path: name });
  }
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function artifactError(message, details = {}) {
  const error = new Error(message);
  error.code = 'AUDIENCE_AI_SCHEMA_INVALID';
  error.statusCode = 422;
  error.details = details;
  return error;
}
