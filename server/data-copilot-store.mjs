import crypto from 'node:crypto';
import path from 'node:path';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';

export const DATA_COPILOT_SCHEMA_VERSION = 1;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const IDEMPOTENCY_KEY = /^[\p{L}\p{N}_.:-]{8,160}$/u;
const CONVERSATION_STATUSES = new Set([
  'idle', 'planning', 'executing', 'waiting_input', 'waiting_approval', 'stopping',
  'paused', 'completed', 'partial', 'failed', 'cancelled', 'resumable',
  // Read compatibility for conversations written before semantic run states.
  'queued', 'running', 'cancelling', 'interrupted',
]);
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const RUN_STATUSES = new Set([
  'planning', 'executing', 'waiting_input', 'waiting_approval', 'stopping',
  'paused', 'completed', 'partial', 'failed', 'cancelled', 'resumable',
  'queued', 'running', 'cancelling', 'interrupted',
]);
const TOOL_RUN_STATUSES = new Set([
  'queued', 'waiting_approval', 'approved', 'running', 'succeeded', 'failed',
  'cancelled', 'skipped', 'outcome_unknown',
]);
const LOG_FILES = Object.freeze({
  messages: 'messages.jsonl',
  runs: 'runs.jsonl',
  toolRuns: 'tool-runs.jsonl',
});
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 5 * 60_000;
const ATOMIC_RENAME_RETRY_LIMIT = process.platform === 'win32' ? 8 : 5;
const ATOMIC_RENAME_RETRY_MAX_DELAY_MS = 250;

export class DataCopilotStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DataCopilotStoreError';
    this.code = code;
    this.status = status;
  }
}

export class DataCopilotStore {
  constructor({ rootDir, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!String(rootDir || '').trim()) throw storeError('COPILOT_ROOT_REQUIRED', 'Data Copilot root directory is required.');
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.idFactory = idFactory;
  }

  async createConversation(value = {}) {
    const createKey = normalizeIdempotencyKey(value.idempotencyKey, 'conversation idempotency key');
    const conversationId = value.conversationId || stableConversationId(value, createKey);
    const input = {
      ...value,
      conversationId,
    };
    const reference = normalizeCopilotReference(input);
    const directory = resolveCopilotConversationDirectory(this.rootDir, reference);
    const conversationPath = path.join(directory, 'conversation.json');
    const title = normalizeText(value.title, 240);
    const filters = jsonValue(value.filters || {}, 'conversation filters');
    const selectedModel = jsonValue(value.selectedModel || {}, 'selected model');
    const createHash = hashCanonical({ reference, title, filters, selectedModel });

    await mkdir(directory, { recursive: true });
    return withCopilotFileLock(path.join(directory, '.store.lock'), async () => {
      const existing = await readCopilotJson(conversationPath, { allowMissing: true });
      if (existing) {
        assertConversationIdentity(existing, reference);
        if (existing.createHash !== createHash || existing.createIdempotencyKey !== createKey) {
          throw storeError('COPILOT_CONVERSATION_CONFLICT', 'Conversation identity is already in use with different settings.', 409);
        }
        return clone(existing);
      }

      for (const filename of Object.values(LOG_FILES)) {
        await ensureValidJsonl(path.join(directory, filename));
      }
      const now = isoNow(this.now);
      const conversation = {
        schemaVersion: DATA_COPILOT_SCHEMA_VERSION,
        revision: 1,
        conversationId: reference.conversationId,
        jobId: reference.jobId,
        snapshotId: reference.snapshotId,
        mode: reference.mode,
        scope: reference.scope,
        scopeHash: reference.scopeHash,
        lastContextSourceIds: Array.isArray(reference.scope?.contextSourceIds)
          ? structuredClone(reference.scope.contextSourceIds)
          : [],
        title,
        filters,
        selectedModel,
        status: 'idle',
        createIdempotencyKey: createKey,
        createHash,
        createdAt: now,
        updatedAt: now,
        lastSequences: { messages: 0, runs: 0, toolRuns: 0 },
        lastMessageAt: null,
        lastToolRunAt: null,
        runState: emptyRunState(),
      };
      await writeCopilotJsonAtomically(conversationPath, conversation);
      return clone(conversation);
    });
  }

  async getConversation(reference) {
    const normalized = normalizeCopilotReference(reference);
    const directory = resolveCopilotConversationDirectory(this.rootDir, normalized);
    return withCopilotFileLock(path.join(directory, '.store.lock'), async () => {
      const conversation = await readCopilotJson(path.join(directory, 'conversation.json'), { allowMissing: true });
      if (!conversation) return null;
      validateConversation(conversation);
      assertConversationIdentity(conversation, normalized);
      return clone(conversation);
    });
  }

  async updateConversation(reference, patch = {}, { expectedRevision } = {}) {
    const normalized = normalizeCopilotReference(reference);
    const directory = resolveCopilotConversationDirectory(this.rootDir, normalized);
    return withCopilotFileLock(path.join(directory, '.store.lock'), async () => {
      const filePath = path.join(directory, 'conversation.json');
      const current = await requireConversation(filePath, normalized);
      assertExpectedRevision(current, expectedRevision);
      const next = clone(current);
      if (Object.hasOwn(patch, 'title')) next.title = normalizeText(patch.title, 240);
      if (Object.hasOwn(patch, 'filters')) next.filters = jsonValue(patch.filters || {}, 'conversation filters');
      if (Object.hasOwn(patch, 'selectedModel')) next.selectedModel = jsonValue(patch.selectedModel || {}, 'selected model');
      if (Object.hasOwn(patch, 'lastContextSourceIds')) {
        if (!Array.isArray(patch.lastContextSourceIds)) {
          throw storeError('COPILOT_CONTEXT_SOURCES_INVALID', 'Last context source IDs must be an array.');
        }
        next.lastContextSourceIds = jsonValue(patch.lastContextSourceIds, 'last context source IDs');
      }
      if (Object.hasOwn(patch, 'status')) {
        const status = String(patch.status || '');
        if (!CONVERSATION_STATUSES.has(status)) throw storeError('COPILOT_STATUS_INVALID', 'Conversation status is invalid.');
        next.status = status;
      }
      if (Object.hasOwn(patch, 'runState')) next.runState = normalizeRunState({ ...next.runState, ...patch.runState });
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      validateConversation(next);
      await writeCopilotJsonAtomically(filePath, next);
      return clone(next);
    });
  }

  async appendMessage(reference, value = {}) {
    const role = String(value.role || '');
    if (!MESSAGE_ROLES.has(role)) throw storeError('COPILOT_MESSAGE_ROLE_INVALID', 'Message role is invalid.');
    const normalized = {
      messageId: optionalSafeId(value.messageId),
      role,
      content: jsonValue(value.content, 'message content'),
      attachments: normalizeAttachmentRefs(value.attachments),
      parentMessageId: optionalSafeId(value.parentMessageId),
      metadata: jsonValue(value.metadata || {}, 'message metadata'),
    };
    return this.#append(reference, 'messages', normalized, value.idempotencyKey);
  }

  async appendRun(reference, value = {}, options = {}) {
    const runId = requiredSafeId(value.runId, 'run ID');
    const status = String(value.status || '');
    if (!RUN_STATUSES.has(status)) throw storeError('COPILOT_RUN_STATUS_INVALID', 'Run status is invalid.');
    const normalized = {
      runEventId: optionalSafeId(value.runEventId),
      runId,
      event: normalizeText(value.event || status, 80),
      status,
      attempt: positiveInteger(value.attempt, 1),
      resumeFromRunId: optionalSafeId(value.resumeFromRunId),
      checkpoint: value.checkpoint === undefined ? null : jsonValue(value.checkpoint, 'run checkpoint'),
      recoverable: value.recoverable === true,
      stopReason: normalizeText(value.stopReason, 240),
      errorCode: normalizeText(value.errorCode, 120),
      errorMessage: normalizeText(value.errorMessage, 1000),
      metadata: jsonValue(value.metadata || {}, 'run metadata'),
    };
    return this.#append(reference, 'runs', normalized, value.idempotencyKey, options);
  }

  async appendToolRun(reference, value = {}) {
    const status = String(value.status || '');
    if (!TOOL_RUN_STATUSES.has(status)) throw storeError('COPILOT_TOOL_RUN_STATUS_INVALID', 'Tool run status is invalid.');
    const normalized = {
      toolRunEventId: optionalSafeId(value.toolRunEventId),
      toolRunId: requiredSafeId(value.toolRunId, 'tool run ID'),
      runId: requiredSafeId(value.runId, 'run ID'),
      toolName: requiredSafeId(value.toolName, 'tool name'),
      status,
      approvalId: optionalSafeId(value.approvalId),
      input: value.input === undefined ? null : jsonValue(value.input, 'tool input'),
      output: value.output === undefined ? null : jsonValue(value.output, 'tool output'),
      errorCode: normalizeText(value.errorCode, 120),
      errorMessage: normalizeText(value.errorMessage, 1000),
      metadata: jsonValue(value.metadata || {}, 'tool run metadata'),
    };
    return this.#append(reference, 'toolRuns', normalized, value.idempotencyKey);
  }

  async requestCancellation(reference, value = {}) {
    return this.appendRun(reference, {
      ...value,
      event: 'cancel_requested',
      status: 'stopping',
      recoverable: value.recoverable !== false,
    }, { rejectTerminalConversation: true });
  }

  async beginResume(reference, value = {}) {
    return this.appendRun(reference, {
      ...value,
      event: 'resumed',
      status: 'executing',
      recoverable: false,
    });
  }

  async listMessages(reference, options = {}) {
    return this.#list(reference, 'messages', options);
  }

  async listRuns(reference, options = {}) {
    return this.#list(reference, 'runs', options);
  }

  async listToolRuns(reference, options = {}) {
    return this.#list(reference, 'toolRuns', options);
  }

  async #append(reference, logName, payload, idempotencyKey, options = {}) {
    const normalized = normalizeCopilotReference(reference);
    const directory = resolveCopilotConversationDirectory(this.rootDir, normalized);
    const key = normalizeIdempotencyKey(idempotencyKey, `${logName} idempotency key`);
    const payloadHash = hashCanonical(payload);
    return withCopilotFileLock(path.join(directory, '.store.lock'), async () => {
      const conversationPath = path.join(directory, 'conversation.json');
      let conversation = await requireConversation(conversationPath, normalized);
      const logPath = path.join(directory, LOG_FILES[logName]);
      const records = await readCopilotJsonl(logPath);
      conversation = await reconcileConversationTail(conversationPath, conversation, logName, records, this.now);
      if (
        options.rejectTerminalConversation === true
        && ['completed', 'failed', 'cancelled'].includes(conversation.status)
      ) {
        return null;
      }
      const existing = records.find((item) => item.idempotencyKey === key);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw storeError('COPILOT_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different content.', 409);
        }
        return clone(existing);
      }

      const sequence = records.reduce((maximum, item) => Math.max(maximum, Number(item.sequence || 0)), 0) + 1;
      const generatedIdField = {
        messages: 'messageId',
        runs: 'runEventId',
        toolRuns: 'toolRunEventId',
      }[logName];
      const persistedPayload = generatedIdField && !payload[generatedIdField]
        ? { ...payload, [generatedIdField]: requiredSafeId(this.idFactory(), `${logName} record ID`) }
        : payload;
      const record = {
        schemaVersion: DATA_COPILOT_SCHEMA_VERSION,
        sequence,
        ...persistedPayload,
        idempotencyKey: key,
        payloadHash,
        createdAt: isoNow(this.now),
      };
      records.push(record);
      await writeCopilotJsonlAtomically(logPath, records);
      await reconcileConversationTail(conversationPath, conversation, logName, records, this.now);
      return clone(record);
    });
  }

  async #list(reference, logName, options) {
    const normalized = normalizeCopilotReference(reference);
    const directory = resolveCopilotConversationDirectory(this.rootDir, normalized);
    return withCopilotFileLock(path.join(directory, '.store.lock'), async () => {
      await requireConversation(path.join(directory, 'conversation.json'), normalized);
      const afterSequence = Math.max(0, Number(options.afterSequence || 0));
      const limit = Math.min(5000, Math.max(1, Number(options.limit || 1000)));
      const records = await readCopilotJsonl(path.join(directory, LOG_FILES[logName]));
      return records.filter((item) => item.sequence > afterSequence).slice(0, limit).map(clone);
    });
  }
}

export function normalizeCopilotReference(value = {}) {
  const scope = normalizeScope(value.scope);
  return {
    jobId: requiredSafeId(value.jobId, 'job ID'),
    snapshotId: requiredSafeId(value.snapshotId, 'snapshot ID'),
    mode: requiredSafeId(value.mode, 'mode'),
    scope,
    scopeHash: hashCanonical(scope),
    conversationId: requiredSafeId(value.conversationId, 'conversation ID'),
  };
}

export function resolveCopilotConversationDirectory(rootDir, reference) {
  const normalized = normalizeCopilotReference(reference);
  return path.join(
    path.resolve(rootDir),
    'copilot',
    normalized.conversationId,
  );
}

function stableConversationId(value, createKey) {
  const identity = {
    jobId: requiredSafeId(value.jobId, 'job ID'),
    snapshotId: requiredSafeId(value.snapshotId, 'snapshot ID'),
    mode: requiredSafeId(value.mode, 'mode'),
    scope: normalizeScope(value.scope),
    createKey,
  };
  return `copilot-${hashCanonical(identity).slice(0, 32)}`;
}

export async function readCopilotJson(filePath, { allowMissing = false } = {}) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error instanceof DataCopilotStoreError) throw error;
    throw storeError('COPILOT_STATE_INVALID', 'Data Copilot state is missing or invalid.', 500, error);
  }
}

export async function readCopilotJsonl(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record must be an object');
      records.push(value);
    } catch (error) {
      throw storeError('COPILOT_LOG_INVALID', `Data Copilot log contains an invalid record at line ${index + 1}.`, 500, error);
    }
  }
  return records;
}

export async function writeCopilotJsonAtomically(filePath, value) {
  await writeCopilotTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeCopilotJsonlAtomically(filePath, records) {
  const text = records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  await writeCopilotTextAtomically(filePath, text);
}

export async function writeCopilotTextAtomically(filePath, text) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withCopilotFileLock(lockPath, operation) {
  const lock = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await releaseLock(lock);
  }
}

export function requiredCopilotId(value, label = 'ID') {
  return requiredSafeId(value, label);
}

export function normalizeCopilotIdempotencyKey(value, label = 'idempotency key') {
  return normalizeIdempotencyKey(value, label);
}

export function copilotHash(value) {
  return hashCanonical(value);
}

export function copilotJsonValue(value, label = 'value') {
  return jsonValue(value, label);
}

async function requireConversation(filePath, reference) {
  const conversation = await readCopilotJson(filePath, { allowMissing: true });
  if (!conversation) throw storeError('COPILOT_CONVERSATION_NOT_FOUND', 'Data Copilot conversation was not found.', 404);
  validateConversation(conversation);
  assertConversationIdentity(conversation, reference);
  return conversation;
}

function validateConversation(value) {
  if (value.schemaVersion !== DATA_COPILOT_SCHEMA_VERSION || !Number.isInteger(value.revision) || value.revision < 1) {
    throw storeError('COPILOT_STATE_INVALID', 'Data Copilot conversation state is invalid.', 500);
  }
  if (!CONVERSATION_STATUSES.has(value.status)) throw storeError('COPILOT_STATE_INVALID', 'Data Copilot conversation status is invalid.', 500);
  normalizeCopilotReference(value);
  normalizeRunState(value.runState);
  jsonValue(value.filters || {}, 'conversation filters');
  jsonValue(value.selectedModel || {}, 'selected model');
  if (value.lastContextSourceIds !== undefined && !Array.isArray(value.lastContextSourceIds)) {
    throw storeError('COPILOT_STATE_INVALID', 'Data Copilot context source state is invalid.', 500);
  }
}

function assertConversationIdentity(value, reference) {
  if (
    value.jobId !== reference.jobId
    || value.snapshotId !== reference.snapshotId
    || value.mode !== reference.mode
    || value.scopeHash !== reference.scopeHash
    || value.conversationId !== reference.conversationId
    || canonicalJson(value.scope) !== canonicalJson(reference.scope)
  ) {
    throw storeError('COPILOT_SCOPE_MISMATCH', 'Conversation does not belong to the requested job snapshot, mode, or scope.', 409);
  }
}

async function reconcileConversationTail(filePath, current, logName, records, nowProvider) {
  const next = clone(current);
  const cursor = Number(next.lastSequences[logName] || 0);
  const tail = records
    .filter((record) => Number(record.sequence) > cursor)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (tail.length === 0) return current;

  let expectedSequence = cursor + 1;
  for (const record of tail) {
    if (!Number.isInteger(Number(record.sequence)) || Number(record.sequence) !== expectedSequence) {
      throw storeError('COPILOT_LOG_SEQUENCE_INVALID', 'Data Copilot log sequence is invalid.', 500);
    }
    next.lastSequences[logName] = expectedSequence;
    if (logName === 'messages') next.lastMessageAt = record.createdAt;
    if (logName === 'toolRuns') next.lastToolRunAt = record.createdAt;
    if (logName === 'runs') applyRunRecord(next, record);
    expectedSequence += 1;
  }
  next.revision = current.revision + 1;
  next.updatedAt = isoNow(nowProvider);
  validateConversation(next);
  await writeCopilotJsonAtomically(filePath, next);
  return next;
}

function applyRunRecord(conversation, record) {
  const state = normalizeRunState(conversation.runState);
  state.status = record.status;
  state.lastRunId = record.runId;
  state.attempt = record.attempt;
  if (record.checkpoint !== null) {
    state.checkpoint = record.checkpoint;
    state.checkpointedAt = record.createdAt;
  }
  if (
    record.status === 'planning' || record.status === 'executing'
    || record.status === 'waiting_input' || record.status === 'waiting_approval'
    || record.status === 'queued' || record.status === 'running'
  ) {
    state.currentRunId = record.runId;
    state.resumeFromRunId = record.resumeFromRunId || null;
    state.resumable = false;
    state.cancelRequestedAt = null;
    state.cancelledAt = null;
  } else if (record.status === 'stopping' || record.status === 'cancelling') {
    state.currentRunId = record.runId;
    state.cancelRequestedAt = record.createdAt;
  } else if (
    record.status === 'cancelled' || record.status === 'paused' || record.status === 'resumable'
    || record.status === 'partial' || record.status === 'interrupted' || record.status === 'failed'
  ) {
    state.currentRunId = null;
    state.resumable = record.status === 'resumable' || record.recoverable === true;
    state.resumeFromRunId = state.resumable ? record.runId : null;
    if (record.status === 'cancelled') state.cancelledAt = record.createdAt;
  } else if (record.status === 'completed') {
    state.currentRunId = null;
    state.resumable = false;
    state.resumeFromRunId = null;
    state.checkpoint = null;
    state.checkpointedAt = null;
  }
  state.stopReason = record.stopReason || '';
  state.errorCode = record.errorCode || '';
  state.errorMessage = record.errorMessage || '';
  conversation.runState = state;
  conversation.status = record.status;
}

function emptyRunState() {
  return {
    status: 'idle',
    currentRunId: null,
    lastRunId: null,
    attempt: 0,
    resumable: false,
    resumeFromRunId: null,
    checkpoint: null,
    checkpointedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    stopReason: '',
    errorCode: '',
    errorMessage: '',
  };
}

function normalizeRunState(value = {}) {
  const result = { ...emptyRunState(), ...jsonValue(value, 'run state') };
  if (!CONVERSATION_STATUSES.has(result.status)) throw storeError('COPILOT_STATE_INVALID', 'Run state status is invalid.', 500);
  for (const key of ['currentRunId', 'lastRunId', 'resumeFromRunId']) {
    result[key] = optionalSafeId(result[key]);
  }
  result.attempt = Math.max(0, Number(result.attempt || 0));
  result.resumable = result.resumable === true;
  return result;
}

function normalizeAttachmentRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw storeError('COPILOT_ATTACHMENT_REF_INVALID', 'Message attachment references are invalid.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw storeError('COPILOT_ATTACHMENT_REF_INVALID', 'Message attachment reference is invalid.');
    if (['path', 'absolutePath', 'relativePath', 'filePath'].some((key) => Object.hasOwn(item, key))) {
      throw storeError('COPILOT_ATTACHMENT_PATH_FORBIDDEN', 'Message attachments must use stored attachment IDs, not filesystem paths.');
    }
    const attachmentId = optionalSafeId(item.attachmentId);
    const artifactId = optionalSafeId(item.artifactId);
    if (!attachmentId && !artifactId) throw storeError('COPILOT_ATTACHMENT_REF_INVALID', 'Message attachment ID is required.');
    return {
      attachmentId,
      artifactId,
      name: normalizeText(item.name, 240),
      mediaType: normalizeText(item.mediaType, 160),
      size: Math.max(0, Number(item.size || 0)),
      sha256: item.sha256 ? String(item.sha256).toLowerCase() : '',
    };
  });
}

function normalizeScope(value) {
  if (value === undefined || value === null || value === '') throw storeError('COPILOT_SCOPE_REQUIRED', 'Data Copilot scope is required.');
  const normalized = jsonValue(value, 'scope');
  const encoded = canonicalJson(normalized);
  if (encoded.length > 8192) throw storeError('COPILOT_SCOPE_INVALID', 'Data Copilot scope is too large.');
  return JSON.parse(encoded);
}

function requiredSafeId(value, label) {
  const text = String(value || '').trim();
  if (!SAFE_ID.test(text) || text.endsWith('.') || WINDOWS_RESERVED_ID.test(text)) {
    throw storeError('COPILOT_ID_INVALID', `${label} is invalid.`);
  }
  return text;
}

function optionalSafeId(value) {
  if (value === undefined || value === null || value === '') return null;
  return requiredSafeId(value, 'ID');
}

function normalizeIdempotencyKey(value, label) {
  const text = String(value || '').trim();
  if (!IDEMPOTENCY_KEY.test(text)) throw storeError('COPILOT_IDEMPOTENCY_KEY_INVALID', `${label} is invalid.`);
  return text;
}

function normalizeText(value, maximum) {
  const text = String(value || '').trim();
  if (text.length > maximum) throw storeError('COPILOT_VALUE_INVALID', `Text exceeds ${maximum} characters.`);
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1) throw storeError('COPILOT_VALUE_INVALID', 'Attempt must be a positive integer.');
  return number;
}

function jsonValue(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw storeError('COPILOT_VALUE_INVALID', `${label} must be JSON serializable.`, 400, error);
  }
  if (encoded === undefined || encoded.length > 1024 * 1024) throw storeError('COPILOT_VALUE_INVALID', `${label} is invalid or too large.`);
  return JSON.parse(encoded);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function isoNow(provider) {
  const value = provider();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw storeError('COPILOT_CLOCK_INVALID', 'Data Copilot clock returned an invalid date.', 500);
  return date.toISOString();
}

function assertExpectedRevision(current, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (Number(expectedRevision) !== current.revision) {
    const error = storeError('COPILOT_REVISION_CONFLICT', 'Data Copilot revision conflict.', 409);
    error.expectedRevision = Number(expectedRevision);
    error.actualRevision = current.revision;
    throw error;
  }
}

async function ensureValidJsonl(filePath) {
  try {
    await readFile(filePath, 'utf8');
    await readCopilotJsonl(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeCopilotTextAtomically(filePath, '');
  }
}

async function acquireLock(lockPath) {
  const target = path.resolve(lockPath);
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  await mkdir(path.dirname(target), { recursive: true });
  while (true) {
    let handle;
    let createdLock = false;
    try {
      handle = await open(target, 'wx', 0o600);
      createdLock = true;
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return { lockPath: target, token };
    } catch (error) {
      await handle?.close().catch(() => {});
      const retryableContention = ['EEXIST', 'EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryableContention) {
        if (createdLock) await rm(target, { force: true }).catch(() => {});
        throw error;
      }
      if (error?.code === 'EEXIST' && await reclaimStaleCopilotLock(target)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw storeError('COPILOT_LOCK_TIMEOUT', 'Data Copilot store lock timed out.', 503);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function reclaimStaleCopilotLock(lockPath) {
  const observed = await readCopilotLockSnapshot(lockPath);
  if (!observed) return true;
  const ownerAlive = lockOwnerIsAlive(observed.metadata?.pid);
  if (ownerAlive !== false && (observed.metadata || observed.ageMs < LOCK_STALE_MS)) return false;

  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(16).toString('hex')}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  const moved = await readCopilotLockSnapshot(quarantine);
  if (!moved || moved.raw === observed.raw) {
    await rm(quarantine, { force: true }).catch(() => {});
    return true;
  }
  await restoreQuarantinedCopilotLock(quarantine, lockPath, moved.raw);
  return false;
}

async function restoreQuarantinedCopilotLock(quarantine, lockPath, raw) {
  try {
    await link(quarantine, lockPath);
    await rm(quarantine, { force: true });
    return;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await rm(quarantine, { force: true }).catch(() => {});
      return;
    }
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
  } finally {
    await rm(quarantine, { force: true }).catch(() => {});
  }
}

async function readCopilotLockSnapshot(lockPath) {
  try {
    const [raw, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    let metadata = null;
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed?.schemaVersion === 1
        && Number.isInteger(Number(parsed.pid))
        && Number(parsed.pid) > 0
        && SAFE_ID.test(String(parsed.token || ''))
        && Number.isFinite(Date.parse(parsed.createdAt))
      ) {
        metadata = parsed;
      }
    } catch {
      // The owner can terminate between exclusive creation and metadata flush.
    }
    const createdAt = Date.parse(metadata?.createdAt);
    return {
      raw,
      metadata,
      ageMs: Math.max(0, Date.now() - (Number.isFinite(createdAt) ? createdAt : details.mtimeMs)),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { raw: '', metadata: null, ageMs: 0 };
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

async function releaseLock({ lockPath, token }) {
  try {
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current?.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
        || attempt >= ATOMIC_RENAME_RETRY_LIMIT
      ) throw error;
      await sleep(Math.min(ATOMIC_RENAME_RETRY_MAX_DELAY_MS, 10 * (2 ** attempt)));
    }
  }
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function storeError(code, message, status = 400, cause = undefined) {
  const error = new DataCopilotStoreError(code, message, status);
  if (cause) error.cause = cause;
  return error;
}
