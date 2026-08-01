import crypto from 'node:crypto';
import path from 'node:path';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';

export const WORKFLOW_STATE_SCHEMA_VERSION = 2;
export const WORKFLOW_STATE_LOCK_TIMEOUT_MS = 10_000;
export const WORKFLOW_STATE_LOCK_RETRY_MS = 50;
export const WORKFLOW_STATE_LOCK_STALE_MS = 30_000;

const writeQueues = new Map();
const WORKFLOW_STAGE_NAMES = ['discovery', 'bodyCompletion', 'analysis', 'audience', 'artifacts'];
const WORKFLOW_STAGE_STATUSES = new Set([
  'not_started',
  'running',
  'partial',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
const BODY_RECORD_STATUSES = new Set([
  'discovered', 'queued', 'attempted', 'succeeded', 'failed', 'not_attempted', 'blocked', 'cancelled',
]);
const ANALYSIS_RECORD_STATUSES = new Set(['not_started', 'running', 'partial', 'completed', 'failed', 'blocked']);
const AUDIENCE_ENTRY_STATUSES = new Set([
  'not_started', 'running', 'complete_reachable', 'partial_limit', 'partial_timeout',
  'partial_verification', 'partial_cancelled', 'blocked', 'failed',
]);

export function workflowStatePath(outputDir) {
  return path.join(path.dirname(path.resolve(outputDir)), 'workflow-state.json');
}

export function emptyWorkflowStages() {
  return {
    discovery: {
      status: 'not_started',
      cursor: null,
      scrollCount: 0,
      stableRoundCount: 0,
      discoveredIds: [],
      discoveredCount: 0,
      stopReason: null,
      lastCheckpointAt: null,
    },
    bodyCompletion: {
      status: 'not_started',
      ledgerSchemaVersion: 1,
      statisticsSource: 'bodyCompletionLedger',
      legacyInferred: false,
      records: {},
      totalCount: 0,
      completedCount: 0,
      remainingCount: 0,
      attemptedCount: 0,
      failedCount: 0,
      notAttemptedCount: 0,
      blockedCount: 0,
      cancelledCount: 0,
      pendingCount: 0,
      conservationValid: true,
      lastCheckpointAt: null,
    },
    analysis: {
      status: 'not_started',
      records: {},
      totalCount: 0,
      completedCount: 0,
      remainingCount: 0,
      lastCheckpointAt: null,
    },
    audience: {
      status: 'not_started',
      checkpointSchemaVersion: 1,
      posts: {},
      replyThreads: {},
      users: {},
      postsTotal: 0,
      postsCompleted: 0,
      usersTotal: 0,
      usersCompleted: 0,
      stopReason: null,
      lastCheckpointAt: null,
    },
    artifacts: {
      status: 'not_started',
      sourceRevision: null,
      manifestRevision: null,
      generatedFiles: [],
      failedFiles: [],
      lastCheckpointAt: null,
    },
  };
}

export async function readWorkflowState(filePath, { allowMissing = false } = {}) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return validateWorkflowState(payload, filePath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      const invalid = new Error(`Workflow state is not valid JSON: ${filePath}`);
      invalid.code = 'WORKFLOW_STATE_INVALID';
      invalid.cause = error;
      throw invalid;
    }
    throw error;
  }
}

export async function initializeWorkflowState(filePath, initialState) {
  return enqueueWrite(filePath, () => withWorkflowStateLock(filePath, async () => {
    const existing = await readWorkflowState(filePath, { allowMissing: true });
    if (existing) return existing;
    const now = new Date().toISOString();
    const state = validateWorkflowState({
      ...initialState,
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      revision: 1,
      updatedAt: initialState.updatedAt || now,
    }, filePath);
    await writeJsonAtomically(filePath, state);
    return state;
  }));
}

export async function updateWorkflowState(filePath, mutate, { expectedRevision } = {}) {
  return enqueueWrite(filePath, () => withWorkflowStateLock(filePath, async () => {
    const current = await readWorkflowState(filePath);
    if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
      throw revisionConflict(filePath, expectedRevision, current.revision);
    }
    const draft = structuredClone(current);
    const replacement = await mutate(draft, current);
    const candidate = replacement === undefined ? draft : replacement;
    const next = validateWorkflowState({
      ...candidate,
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      jobId: current.jobId,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }, filePath);
    await writeJsonAtomically(filePath, next);
    return next;
  }));
}

export async function writeJsonAtomically(filePath, value) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true });
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, resolved);
    await syncDirectory(directory);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original write error.
    }
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateWorkflowState(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidState(filePath, 'root_must_be_object');
  }
  if (Number(value.schemaVersion) !== WORKFLOW_STATE_SCHEMA_VERSION) {
    throw invalidState(filePath, 'unsupported_schema_version');
  }
  if (!String(value.jobId || '').trim()) throw invalidState(filePath, 'job_id_required');
  if (value.params !== undefined && !isPlainObject(value.params)) {
    throw invalidState(filePath, 'params_must_be_object');
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    throw invalidState(filePath, 'revision_must_be_positive_integer');
  }
  if (!Array.isArray(value.attempts)) throw invalidState(filePath, 'attempts_must_be_array');
  if (!value.stages || typeof value.stages !== 'object' || Array.isArray(value.stages)) {
    throw invalidState(filePath, 'stages_must_be_object');
  }
  const normalized = normalizeWorkflowState(value);
  for (const stageName of WORKFLOW_STAGE_NAMES) {
    const stage = normalized.stages[stageName];
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw invalidState(filePath, `stage_${stageName}_must_be_object`);
    }
    if (!WORKFLOW_STAGE_STATUSES.has(stage.status)) {
      throw invalidState(filePath, `stage_${stageName}_status_invalid`);
    }
    validateStageShape(stageName, stage, filePath);
  }
  return normalized;
}

function normalizeWorkflowState(value) {
  const normalized = structuredClone(value);
  const defaults = emptyWorkflowStages();
  for (const stageName of WORKFLOW_STAGE_NAMES) {
    const original = normalized.stages[stageName];
    if (!isPlainObject(original)) continue;
    const stage = { ...structuredClone(defaults[stageName]), ...original };

    if (stageName === 'discovery' && original.discoveredCount === undefined) {
      stage.discoveredCount = Array.isArray(stage.discoveredIds) ? stage.discoveredIds.length : 0;
    }
    if (stageName === 'bodyCompletion') {
      stage.records = normalizeLedger(stage.records, normalizeBodyRecord);
      const records = isPlainObject(stage.records) ? stage.records : {};
      const counts = bodyRecordCounts(records);
      if (original.ledgerSchemaVersion === undefined) {
        stage.ledgerSchemaVersion = 1;
        stage.statisticsSource = 'legacyInferred';
      }
      stage.legacyInferred = stage.statisticsSource === 'legacyInferred';
      if (original.totalCount === undefined) stage.totalCount = Object.keys(records).length;
      if (original.completedCount === undefined) {
        stage.completedCount = Object.values(records).filter((record) => bodyRecordIsCompleted(record)).length;
      }
      if (original.remainingCount === undefined) {
        stage.remainingCount = Math.max(0, stage.totalCount - stage.completedCount);
      }
      for (const [field, count] of Object.entries(counts)) {
        if (original[field] === undefined) stage[field] = count;
      }
    }
    if (stageName === 'analysis') {
      stage.records = normalizeLedger(stage.records, normalizeAnalysisRecord);
      const records = isPlainObject(stage.records) ? stage.records : {};
      if (original.totalCount === undefined) stage.totalCount = Object.keys(records).length;
      if (original.completedCount === undefined) {
        stage.completedCount = Object.values(records).filter((record) => analysisRecordIsCompleted(record)).length;
      }
      if (original.remainingCount === undefined) {
        stage.remainingCount = Math.max(0, stage.totalCount - stage.completedCount);
      }
    }
    if (stageName === 'audience') {
      stage.posts = normalizeLedger(stage.posts, normalizeAudiencePost);
      stage.replyThreads = normalizeLedger(stage.replyThreads, normalizeAudienceReplyThread);
      stage.users = normalizeLedger(stage.users, normalizeAudienceUser);
      const posts = isPlainObject(stage.posts) ? stage.posts : {};
      const users = isPlainObject(stage.users) ? stage.users : {};
      if (original.postsTotal === undefined) stage.postsTotal = Object.keys(posts).length;
      if (original.postsCompleted === undefined) {
        stage.postsCompleted = original.postsComplete === undefined
          ? Object.values(posts).filter((post) => postIsCompleted(post)).length
          : original.postsComplete;
      }
      if (original.usersTotal === undefined) stage.usersTotal = Object.keys(users).length;
      if (original.usersCompleted === undefined) {
        stage.usersCompleted = original.profilesComplete === undefined
          ? Object.values(users).filter((user) => userIsCompleted(user)).length
          : original.profilesComplete;
      }
    }
    normalized.stages[stageName] = stage;
  }
  return normalized;
}

function validateStageShape(stageName, stage, filePath) {
  if (stageName === 'discovery') {
    validateStringArray(stage.discoveredIds, filePath, 'stage_discovery_discovered_ids');
    validateNonNegativeIntegers(stage, ['scrollCount', 'stableRoundCount', 'discoveredCount'], filePath, stageName);
    if (stage.discoveredCount !== stage.discoveredIds.length) {
      throw invalidState(filePath, 'stage_discovery_ledger_count_mismatch');
    }
    return;
  }
  if (stageName === 'bodyCompletion') {
    validateLedger(stage.records, filePath, `stage_${stageName}_records`);
    validateBodyRecords(stage.records, filePath);
    validateNonNegativeIntegers(stage, [
      'totalCount', 'completedCount', 'remainingCount', 'attemptedCount', 'failedCount',
      'notAttemptedCount', 'blockedCount', 'cancelledCount', 'pendingCount',
    ], filePath, stageName);
    const expectedCounts = bodyRecordCounts(stage.records);
    if (stage.conservationValid !== true
      || Object.entries(expectedCounts).some(([field, count]) => stage[field] !== count)) {
      throw invalidState(filePath, 'stage_bodyCompletion_ledger_count_mismatch');
    }
    if (stage.completedCount > stage.totalCount) {
      throw invalidState(filePath, `stage_${stageName}_completed_count_exceeds_total`);
    }
    if (stage.status === 'completed'
      && (stage.completedCount !== stage.totalCount || stage.remainingCount !== 0)) {
      throw invalidState(filePath, `stage_${stageName}_completed_invariant_failed`);
    }
    validateAggregateCounts(
      stage,
      Object.keys(stage.records).length,
      Object.values(stage.records).filter((record) => bodyRecordIsCompleted(record)).length,
      filePath,
      stageName,
    );
    return;
  }
  if (stageName === 'analysis') {
    validateLedger(stage.records, filePath, `stage_${stageName}_records`);
    validateAnalysisRecords(stage.records, filePath);
    validateNonNegativeIntegers(stage, ['totalCount', 'completedCount', 'remainingCount'], filePath, stageName);
    if (stage.completedCount > stage.totalCount) {
      throw invalidState(filePath, `stage_${stageName}_completed_count_exceeds_total`);
    }
    if (stage.status === 'completed'
      && (stage.completedCount !== stage.totalCount || stage.remainingCount !== 0)) {
      throw invalidState(filePath, `stage_${stageName}_completed_invariant_failed`);
    }
    validateAggregateCounts(
      stage,
      Object.keys(stage.records).length,
      Object.values(stage.records).filter((record) => analysisRecordIsCompleted(record)).length,
      filePath,
      stageName,
    );
    return;
  }
  if (stageName === 'audience') {
    validateLedger(stage.posts, filePath, 'stage_audience_posts');
    validateLedger(stage.replyThreads, filePath, 'stage_audience_replyThreads');
    validateLedger(stage.users, filePath, 'stage_audience_users');
    validateAudienceEntries(stage.posts, stage.replyThreads, stage.users, filePath);
    validateNonNegativeIntegers(
      stage,
      ['postsTotal', 'postsCompleted', 'usersTotal', 'usersCompleted'],
      filePath,
      stageName,
    );
    if (stage.postsCompleted > stage.postsTotal || stage.usersCompleted > stage.usersTotal) {
      throw invalidState(filePath, 'stage_audience_completed_count_exceeds_total');
    }
    if (stage.status === 'completed'
      && (stage.postsCompleted !== stage.postsTotal || stage.usersCompleted !== stage.usersTotal)) {
      throw invalidState(filePath, 'stage_audience_completed_invariant_failed');
    }
    const expectedPostsTotal = Object.keys(stage.posts).length;
    const expectedPostsCompleted = Object.values(stage.posts).filter((post) => postIsCompleted(post)).length;
    const expectedUsersTotal = Object.keys(stage.users).length;
    const expectedUsersCompleted = Object.values(stage.users).filter((user) => userIsCompleted(user)).length;
    if (stage.postsTotal !== expectedPostsTotal
      || stage.postsCompleted !== expectedPostsCompleted
      || stage.usersTotal !== expectedUsersTotal
      || stage.usersCompleted !== expectedUsersCompleted) {
      throw invalidState(filePath, 'stage_audience_ledger_count_mismatch');
    }
    return;
  }
  validateStringArray(stage.generatedFiles, filePath, 'stage_artifacts_generated_files');
  validateStringArray(stage.failedFiles, filePath, 'stage_artifacts_failed_files');
  if (stage.status === 'completed' && stage.failedFiles.length > 0) {
    throw invalidState(filePath, 'stage_artifacts_completed_invariant_failed');
  }
}

function validateLedger(value, filePath, reason) {
  if (!isPlainObject(value) || Object.values(value).some((entry) => !isPlainObject(entry))) {
    throw invalidState(filePath, `${reason}_must_be_object_ledger`);
  }
}

function validateBodyRecords(records, filePath) {
  for (const record of Object.values(records)) {
    if (!BODY_RECORD_STATUSES.has(record.bodyStatus)) {
      throw invalidState(filePath, 'stage_bodyCompletion_record_status_invalid');
    }
    validateEntryNonNegativeIntegers(record, ['attemptCount'], filePath, 'stage_bodyCompletion_record');
  }
}

function validateAnalysisRecords(records, filePath) {
  for (const record of Object.values(records)) {
    if (!ANALYSIS_RECORD_STATUSES.has(record.analysisStatus)) {
      throw invalidState(filePath, 'stage_analysis_record_status_invalid');
    }
    validateEntryNonNegativeIntegers(record, ['attemptCount'], filePath, 'stage_analysis_record');
    if (!Array.isArray(record.completedStages)
      || record.completedStages.some((value) => !Number.isInteger(value) || value < 0)) {
      throw invalidState(filePath, 'stage_analysis_record_completedStages_must_be_non_negative_integer_array');
    }
  }
}

function validateAudienceEntries(posts, replyThreads, users, filePath) {
  for (const post of Object.values(posts)) {
    if (!AUDIENCE_ENTRY_STATUSES.has(post.commentStatus)) {
      throw invalidState(filePath, 'stage_audience_post_status_invalid');
    }
    validateEntryNonNegativeIntegers(
      post,
      [
        'attemptCount', 'commentPage', 'commentsCollected', 'repliesCollected',
        'repeatedRequests', 'duplicateCommentsSeen',
      ],
      filePath,
      'stage_audience_post',
    );
  }
  for (const thread of Object.values(replyThreads)) {
    if (!AUDIENCE_ENTRY_STATUSES.has(thread.replyStatus)) {
      throw invalidState(filePath, 'stage_audience_reply_thread_status_invalid');
    }
    validateEntryNonNegativeIntegers(
      thread,
      ['attemptCount', 'repliesCollected'],
      filePath,
      'stage_audience_reply_thread',
    );
  }
  for (const user of Object.values(users)) {
    if (!AUDIENCE_ENTRY_STATUSES.has(user.profileStatus)) {
      throw invalidState(filePath, 'stage_audience_user_status_invalid');
    }
    validateEntryNonNegativeIntegers(user, ['attemptCount'], filePath, 'stage_audience_user');
  }
}

function validateAggregateCounts(stage, expectedTotal, expectedCompleted, filePath, stageName) {
  const expectedRemaining = expectedTotal - expectedCompleted;
  if (stage.totalCount !== expectedTotal
    || stage.completedCount !== expectedCompleted
    || stage.remainingCount !== expectedRemaining) {
    throw invalidState(filePath, `stage_${stageName}_ledger_count_mismatch`);
  }
}

function validateStringArray(value, filePath, reason) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidState(filePath, `${reason}_must_be_string_array`);
  }
}

function validateNonNegativeIntegers(stage, fields, filePath, stageName) {
  for (const field of fields) {
    if (!Number.isInteger(stage[field]) || stage[field] < 0) {
      throw invalidState(filePath, `stage_${stageName}_${field}_must_be_non_negative_integer`);
    }
  }
}

function validateEntryNonNegativeIntegers(entry, fields, filePath, reason) {
  for (const field of fields) {
    if (!Number.isInteger(entry[field]) || entry[field] < 0) {
      throw invalidState(filePath, `${reason}_${field}_must_be_non_negative_integer`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLedger(value, normalizeEntry) {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isPlainObject(entry) ? normalizeEntry(entry) : entry,
  ]));
}

function normalizeBodyRecord(value) {
  const rawStatus = value.bodyStatus || value.status || 'not_attempted';
  const status = rawStatus === 'completed' ? 'succeeded' : rawStatus;
  return {
    ...value,
    bodyStatus: status,
    status,
    attemptCount: value.attemptCount ?? 0,
    noteId: String(value.noteId || ''),
    discoveredAt: value.discoveredAt ?? null,
    firstAttemptAt: value.firstAttemptAt ?? null,
    lastAttemptAt: value.lastAttemptAt ?? null,
    completedAt: value.completedAt ?? null,
    failureCode: String(value.failureCode || ''),
    failureMessage: String(value.failureMessage || ''),
    recoverable: value.recoverable ?? (status !== 'succeeded'),
    stopReason: String(value.stopReason || ''),
    updatedAt: value.updatedAt ?? null,
  };
}

function bodyRecordCounts(records) {
  const statuses = Object.fromEntries([...BODY_RECORD_STATUSES].map((status) => [status, 0]));
  for (const record of Object.values(records)) {
    const status = record.bodyStatus || record.status || 'not_attempted';
    statuses[BODY_RECORD_STATUSES.has(status) ? status : 'not_attempted'] += 1;
  }
  const pendingCount = statuses.discovered + statuses.queued + statuses.attempted;
  const terminalCount = statuses.succeeded + statuses.failed + statuses.not_attempted
    + statuses.blocked + statuses.cancelled;
  return {
    attemptedCount: Object.values(records).filter((record) => Number(record.attemptCount || 0) > 0).length,
    failedCount: statuses.failed,
    notAttemptedCount: statuses.not_attempted,
    blockedCount: statuses.blocked,
    cancelledCount: statuses.cancelled,
    pendingCount,
    conservationValid: Object.keys(records).length === terminalCount + pendingCount,
  };
}

function normalizeAnalysisRecord(value) {
  let analysisStatus = value.analysisStatus || value.status || 'not_started';
  if (analysisStatus === 'succeeded' || analysisStatus === 'complete') analysisStatus = 'completed';
  return {
    ...value,
    analysisStatus,
    attemptCount: value.attemptCount ?? 0,
    completedStages: value.completedStages ?? [],
  };
}

function normalizeAudiencePost(value) {
  const commentStatus = normalizeAudienceStatus(value.commentStatus || value.comment_status || value.status);
  return {
    ...value,
    commentStatus,
    attemptCount: value.attemptCount ?? value.attempt_count ?? 0,
    commentCursor: value.commentCursor ?? value.comment_cursor ?? '',
    commentPage: value.commentPage ?? value.comment_page ?? 0,
    replyCursor: value.replyCursor ?? value.reply_cursor ?? '',
    hasMoreComments: value.hasMoreComments ?? value.has_more_comments ?? true,
    commentsCollected: value.commentsCollected ?? value.comments_collected ?? value.collected_comment_count ?? 0,
    repliesCollected: value.repliesCollected ?? value.replies_collected ?? value.reply_count ?? 0,
    lastVisibleCommentId: String(value.lastVisibleCommentId || value.last_visible_comment_id || ''),
    lastSuccessfulCursor: String(value.lastSuccessfulCursor || value.last_successful_cursor || ''),
    resumeStrategy: String(value.resumeStrategy || value.resume_strategy || ''),
    fallbackReason: String(value.fallbackReason || value.fallback_reason || ''),
    repeatedRequests: value.repeatedRequests ?? value.repeated_requests ?? 0,
    duplicateCommentsSeen: value.duplicateCommentsSeen ?? value.duplicate_comments_seen ?? 0,
    resumedFromAnchor: String(value.resumedFromAnchor || value.resumed_from_anchor || ''),
    performancePenalty: value.performancePenalty ?? value.performance_penalty ?? 0,
    recoverable: value.recoverable ?? commentStatus !== 'complete_reachable',
    stopReason: String(value.stopReason || value.stop_reason || value.failure_reason || ''),
  };
}

function normalizeAudienceUser(value) {
  const profileStatus = normalizeAudienceStatus(value.profileStatus
    || value.enrichmentStatus
    || value.enrichment_status
    || value.status
    || 'not_started');
  return {
    ...value,
    profileStatus,
    attemptCount: value.attemptCount ?? value.profile_attempt_count ?? 0,
    userPostCursor: String(value.userPostCursor || value.user_post_cursor || ''),
    failureCode: String(value.failureCode || value.failure_code || value.access_status || ''),
    recoverable: value.recoverable ?? profileStatus !== 'complete_reachable',
  };
}

function normalizeAudienceReplyThread(value) {
  return {
    ...value,
    commentId: String(value.commentId || value.comment_id || ''),
    replyStatus: normalizeAudienceStatus(value.replyStatus || value.reply_status),
    replyCursor: String(value.replyCursor || value.reply_cursor || ''),
    hasMoreReplies: value.hasMoreReplies ?? value.has_more_replies ?? true,
    repliesCollected: value.repliesCollected ?? value.replies_collected ?? 0,
    attemptCount: value.attemptCount ?? value.attempt_count ?? 0,
  };
}

function normalizeAudienceStatus(value) {
  const status = String(value || 'not_started');
  return {
    pending: 'not_started',
    partial: 'partial_limit',
    complete: 'complete_reachable',
    completed: 'complete_reachable',
    succeeded: 'complete_reachable',
    cancelled: 'partial_cancelled',
  }[status] || status;
}

function bodyRecordIsCompleted(record) {
  return isPlainObject(record) && (record.bodyStatus || record.status) === 'succeeded';
}

function analysisRecordIsCompleted(record) {
  return isPlainObject(record) && record.analysisStatus === 'completed';
}

function postIsCompleted(post) {
  return isPlainObject(post) && normalizeAudienceStatus(post.commentStatus || post.status) === 'complete_reachable';
}

function userIsCompleted(user) {
  return isPlainObject(user)
    && normalizeAudienceStatus(user.profileStatus || user.enrichmentStatus || user.status) === 'complete_reachable';
}

function invalidState(filePath, reason) {
  const error = new Error(`Workflow state is invalid (${reason}): ${filePath}`);
  error.code = 'WORKFLOW_STATE_INVALID';
  error.reason = reason;
  return error;
}

function revisionConflict(filePath, expected, actual) {
  const error = new Error(`Workflow state revision conflict: expected ${expected}, found ${actual}.`);
  error.code = 'WORKFLOW_REVISION_CONFLICT';
  error.statePath = filePath;
  error.expectedRevision = Number(expected);
  error.actualRevision = Number(actual);
  return error;
}

function enqueueWrite(filePath, operation) {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}

async function withWorkflowStateLock(filePath, operation) {
  const lock = await acquireWorkflowStateLock(filePath);
  try {
    return await operation();
  } finally {
    await releaseWorkflowStateLock(lock);
  }
}

async function acquireWorkflowStateLock(filePath) {
  const statePath = path.resolve(filePath);
  const lockPath = `${statePath}.lock`;
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const metadata = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  };
  const encoded = `${JSON.stringify(metadata)}\n`;

  await mkdir(path.dirname(statePath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      return { lockPath, token };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') {
        if (handle) await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }

      if (await reclaimStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= WORKFLOW_STATE_LOCK_TIMEOUT_MS) {
        throw workflowStateLockTimeout(statePath, lockPath);
      }
      await sleep(WORKFLOW_STATE_LOCK_RETRY_MS);
    }
  }
}

async function releaseWorkflowStateLock({ lockPath, token }) {
  const current = await readLockSnapshot(lockPath);
  if (!current || current.metadata?.token !== token) return;
  await rm(lockPath, { force: true });
}

async function reclaimStaleLock(lockPath) {
  const observed = await readLockSnapshot(lockPath);
  if (!observed) return true;

  const ownerAlive = lockOwnerIsAlive(observed.metadata?.pid);
  if (ownerAlive !== false && observed.ageMs < WORKFLOW_STATE_LOCK_STALE_MS) return false;

  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(16).toString('hex')}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }

  const moved = await readLockSnapshot(quarantine);
  if (!moved || moved.raw === observed.raw) {
    await rm(quarantine, { force: true }).catch(() => {});
    return true;
  }

  // Another cleaner replaced the stale lock before our rename. Restore that
  // newer lock without overwriting a lock acquired in the meantime.
  await restoreQuarantinedLock(quarantine, lockPath, moved.raw);
  return false;
}

async function restoreQuarantinedLock(quarantine, lockPath, raw) {
  try {
    await link(quarantine, lockPath);
    await rm(quarantine, { force: true });
    return;
  } catch (error) {
    if (error?.code === 'EEXIST') return;
  }

  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rm(quarantine, { force: true });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function readLockSnapshot(lockPath) {
  try {
    const [raw, details] = await Promise.all([
      readFile(lockPath, 'utf8'),
      stat(lockPath),
    ]);
    let metadata = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      // An owner may have crashed before finishing the metadata write.
    }
    const createdAtMs = Date.parse(metadata?.createdAt);
    const referenceMs = Number.isFinite(createdAtMs) ? createdAtMs : details.mtimeMs;
    return {
      raw,
      metadata,
      ageMs: Math.max(0, Date.now() - referenceMs),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return {
      raw: '',
      metadata: null,
      ageMs: 0,
    };
  }
}

function lockOwnerIsAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return null;
  }
}

function workflowStateLockTimeout(statePath, lockPath) {
  const error = new Error(`Timed out waiting for workflow-state lock: ${lockPath}`);
  error.code = 'WORKFLOW_STATE_LOCK_TIMEOUT';
  error.statePath = statePath;
  error.lockPath = lockPath;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
    }
  }
}
