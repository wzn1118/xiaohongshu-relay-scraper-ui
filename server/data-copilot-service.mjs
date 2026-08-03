import crypto from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import {
  normalizeCopilotIdempotencyKey,
  normalizeCopilotReference,
  readCopilotJson,
  requiredCopilotId,
  writeCopilotJsonlAtomically,
} from './data-copilot-store.mjs';
import {
  createCopilotContextSourceId,
  normalizeCopilotContextSourceIds as normalizeBoundContextSourceIds,
} from './copilot-context-source.mjs';

const ACTIVE_STATUSES = new Set([
  'planning', 'executing', 'waiting_input', 'stopping',
  'queued', 'running', 'cancelling',
]);
const DEFAULT_ALLOWED_SCOPES = Object.freeze(['*']);
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const EVENT_BUFFER_LIMIT = 250;

export class DataCopilotServiceError extends Error {
  constructor(code, message, status = 400, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DataCopilotServiceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Coordinates persisted conversations without duplicating Store, Runtime,
 * Approval, or Artifact ownership. rootDir is the shared data directory, so
 * conversations are discovered below data/copilot/<conversationId>.
 */
export class DataCopilotService {
  constructor({
    rootDir,
    store,
    approvals,
    artifacts,
    runtime,
    policy,
    mcpAdapter = null,
    manager,
    aiSessions = runtime?.aiSessions,
    now = () => new Date(),
  } = {}) {
    if (!store || !approvals || !artifacts || !runtime || !policy) {
      throw serviceError(
        'COPILOT_SERVICE_DEPENDENCIES_REQUIRED',
        'Data Copilot store, approvals, artifacts, runtime, and policy are required.',
        500,
      );
    }
    this.rootDir = path.resolve(rootDir || store.rootDir || 'data');
    this.store = store;
    this.approvals = approvals;
    this.artifacts = artifacts;
    this.runtime = runtime;
    this.policy = policy;
    this.mcpAdapter = mcpAdapter;
    this.manager = manager || policy.manager;
    this.aiSessions = aiSessions;
    this.now = now;
    this.references = new Map();
    this.listeners = new Map();
    this.eventBuffers = new Map();
    this.eventSequences = new Map();
    this.modelSessions = new Map();
    this.operations = new Map();
    this.discoveryErrors = [];
    this.initialized = false;

    const previousEmit = typeof runtime.emit === 'function' ? runtime.emit.bind(runtime) : null;
    runtime.emit = (reference, event) => {
      previousEmit?.(reference, event);
      this.emit(reference, event);
    };
  }

  async initialize() {
    if (this.initialized) {
      return {
        conversations: this.references.size,
        interrupted: 0,
        errors: structuredClone(this.discoveryErrors),
      };
    }
    this.references.clear();
    this.discoveryErrors = [];
    const directory = path.join(this.rootDir, 'copilot');
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    let interrupted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const id = requiredCopilotId(entry.name, 'conversation ID');
        const conversation = await readCopilotJson(path.join(directory, id, 'conversation.json'), { allowMissing: true });
        if (!conversation) continue;
        const reference = normalizeCopilotReference(conversation);
        const persisted = await this.store.getConversation(reference);
        if (!persisted) continue;
        this.references.set(reference.conversationId, reference);
        await this.#loadPersistedEvents(reference);
        if (ACTIVE_STATUSES.has(persisted.status) && persisted.runState?.currentRunId) {
          const checkpoint = persisted.runState?.checkpoint || null;
          await this.store.appendRun(reference, {
            runId: persisted.runState.currentRunId,
            status: 'resumable',
            event: 'service_restarted',
            attempt: Number(persisted.runState.attempt || 1),
            checkpoint,
            recoverable: Boolean(checkpoint),
            stopReason: 'service_restart',
            errorCode: 'COPILOT_SERVICE_RESTARTED',
            errorMessage: checkpoint
              ? 'The service restarted. The saved run can be continued.'
              : 'The service restarted before a recoverable checkpoint was saved.',
            idempotencyKey: restartKey(reference.conversationId, persisted.runState.currentRunId),
          });
          interrupted += 1;
        }
      } catch (error) {
        this.discoveryErrors.push({
          conversationId: entry.name,
          code: String(error?.code || 'COPILOT_DISCOVERY_FAILED'),
          message: String(error?.message || error).slice(0, 500),
        });
      }
    }
    this.initialized = true;
    return {
      conversations: this.references.size,
      interrupted,
      errors: structuredClone(this.discoveryErrors),
    };
  }

  async createConversation(value = {}) {
    const jobId = requiredCopilotId(value.jobId, 'job ID');
    const job = this.#getJob(jobId);
    const mode = normalizeMode(value.mode);
    const jobRevision = normalizeJobRevision(job.revision);
    const snapshotId = `job-r${jobRevision}`;
    if (String(value.snapshotId || '').trim()) {
      const suppliedSnapshotId = requiredCopilotId(value.snapshotId, 'snapshot ID');
      if (suppliedSnapshotId !== snapshotId) {
        throw serviceError(
          'COPILOT_SNAPSHOT_MISMATCH',
          `The requested snapshot does not match current task revision ${jobRevision}.`,
          409,
        );
      }
    }
    const scope = normalizeScopeInput(value.scope, value.contextSourceIds, job);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `conversation:${crypto.randomUUID()}`,
      'conversation idempotency key',
    );
    const selectedModel = this.#resolveSelectedModel(value.aiSessionId, value.selectedModel);
    const conversation = await this.store.createConversation({
      ...(value.conversationId ? { conversationId: requiredCopilotId(value.conversationId, 'conversation ID') } : {}),
      jobId,
      snapshotId,
      mode,
      scope,
      title: normalizeTitle(value.title, job),
      filters: objectValue(value.filters),
      selectedModel,
      idempotencyKey,
    });
    const reference = normalizeCopilotReference(conversation);
    this.policy.validateReference(reference, conversation);
    this.references.set(reference.conversationId, reference);
    if (String(value.aiSessionId || '').trim()) {
      this.modelSessions.set(reference.conversationId, String(value.aiSessionId).trim());
    }
    this.emit(reference, { type: 'conversation.created', conversation: publicConversation(conversation) });
    return { conversation: publicConversation(conversation) };
  }

  async listConversations({ jobId = null, mode = null, limit = 100 } = {}) {
    await this.#ensureInitialized();
    const maximum = boundedInteger(limit, 100, 1, 500);
    const conversations = [];
    for (const reference of this.references.values()) {
      if (jobId && reference.jobId !== String(jobId)) continue;
      if (mode && reference.mode !== String(mode)) continue;
      try {
        const conversation = await this.store.getConversation(reference);
        if (conversation) conversations.push(publicConversation(conversation));
      } catch (error) {
        this.discoveryErrors.push({
          conversationId: reference.conversationId,
          code: String(error?.code || 'COPILOT_READ_FAILED'),
          message: String(error?.message || error).slice(0, 500),
        });
      }
    }
    conversations.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return {
      conversations: conversations.slice(0, maximum),
      total: conversations.length,
      discoveryErrors: structuredClone(this.discoveryErrors),
    };
  }

  async getConversation(conversationId) {
    const { reference, conversation } = await this.#conversation(conversationId);
    const [approvals, attachmentResult, artifactResult] = await Promise.all([
      this.approvals.listApprovals(reference),
      this.artifacts.listAttachments(reference),
      this.artifacts.listArtifacts(reference),
    ]);
    return {
      conversation: publicConversation(conversation),
      approvals,
      attachments: attachmentResult.attachments,
      artifacts: artifactResult.artifacts,
    };
  }

  async listMessages(conversationId, options = {}) {
    const { reference } = await this.#conversation(conversationId);
    const messages = await this.store.listMessages(reference, {
      afterSequence: boundedInteger(options.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(options.limit, 1000, 1, 5000),
    });
    return {
      messages,
      nextSequence: messages.length ? messages.at(-1).sequence : Number(options.afterSequence || 0),
    };
  }

  listTools({ query = '', limit = 100 } = {}) {
    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    const maximum = boundedInteger(limit, 100, 1, 500);
    const tools = String(query || '').trim() && typeof registry?.search === 'function'
      ? registry.search(query, { limit: maximum })
      : registry?.list?.().slice(0, maximum) || [];
    return {
      schemaVersion: 1,
      query: String(query || '').trim(),
      total: tools.length,
      tools,
    };
  }

  getCapabilities() {
    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    return this.runtime.describeCapabilities?.() || {
      schemaVersion: 1,
      agentKernel: 'legacy',
      toolCatalog: { total: registry?.list?.().length || 0, categories: [] },
    };
  }

  listContextJobs(value = {}) {
    const query = String(value.query || '').trim().slice(0, 500).toLocaleLowerCase();
    const offset = boundedInteger(value.offset, 0, 0, 1_000_000);
    const limit = boundedInteger(value.limit, 25, 1, 100);
    const jobs = (this.manager?.list?.() || [])
      .map(contextJobRecord)
      .filter((job) => !query || [
        job.id, job.title, job.modeLabel, job.status, job.createdAt, job.updatedAt,
      ].join(' ').toLocaleLowerCase().includes(query))
      .sort((left, right) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)));
    return {
      schemaVersion: 1,
      total: jobs.length,
      offset,
      limit,
      items: jobs.slice(offset, offset + limit),
    };
  }

  async listContextRecords(value = {}) {
    const jobId = requiredCopilotId(value.jobId, 'job ID');
    const job = this.#getJob(jobId);
    const mode = normalizeMode(value.mode || 'application');
    const kind = String(value.kind || '').trim().toLowerCase();
    const query = String(value.query || '').trim().slice(0, 500);
    const offset = boundedInteger(value.offset, 0, 0, 1_000_000);
    const limit = boundedInteger(value.limit, 25, 1, 100);

    if (!kind) {
      const counts = {};
      for (const category of ['posts', 'comments', 'users', 'artifacts']) {
        const result = await this.listContextRecords({ jobId, mode, kind: category, offset: 0, limit: 1 });
        counts[category] = result.total;
      }
      return { schemaVersion: 1, jobId, mode, counts };
    }
    if (!['posts', 'comments', 'users', 'artifacts'].includes(kind)) {
      throw serviceError('COPILOT_CONTEXT_KIND_INVALID', 'Context kind must be posts, comments, users, or artifacts.');
    }

    if (kind === 'artifacts') {
      const files = await listTaskArtifactFiles(job.outputDir);
      const matched = query
        ? files.filter((item) => `${item.name} ${item.relativePath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        : files;
      return {
        schemaVersion: 1,
        jobId,
        mode,
        kind,
        total: matched.length,
        offset,
        limit,
        items: matched.slice(offset, offset + limit).map((item) => contextArtifactRecord(jobId, item)),
      };
    }

    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    if (!registry?.execute) throw serviceError('COPILOT_CONTEXT_CATALOG_UNAVAILABLE', 'The context catalog is unavailable.', 503);
    const revision = normalizeJobRevision(job.revision);
    const reference = {
      conversationId: `context-${crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`,
      jobId,
      snapshotId: `job-r${revision}`,
      mode,
      scope: { allowedScopes: ['*'], contextSourceIds: [], jobRevision: revision },
    };
    const result = await registry.execute('records.query', {
      dataset: contextDataset(kind, mode),
      query,
      offset,
      limit,
    }, {
      reference,
      conversation: reference,
      state: {},
      contextSourceIds: [],
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return {
      schemaVersion: 1,
      jobId,
      mode,
      kind,
      total: Number(result?.total || 0),
      offset,
      limit,
      items: rows.map((row) => contextDataRecord(jobId, kind, row)),
    };
  }

  async sendMessage(conversationId, value = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const text = String(value.content || '').trim();
    if (!text) throw serviceError('COPILOT_MESSAGE_EMPTY', 'Message content is required.');
    const attachmentIds = normalizeIdList(value.attachmentIds, 'attachment ID', MAX_ATTACHMENTS_PER_MESSAGE);
    const contextSourceIds = normalizeContextSourceIds(value.contextSourceIds, reference.jobId);
    const attachments = await Promise.all(attachmentIds.map(async (attachmentId) => {
      const resolved = await this.artifacts.resolveAttachment(reference, attachmentId);
      return resolved.attachment;
    }));
    const aiSessionId = String(value.aiSessionId || this.modelSessions.get(reference.conversationId) || '').trim();
    const selectedModel = this.#resolveSelectedModel(aiSessionId, conversation.selectedModel);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `message:${crypto.randomUUID()}`,
      'message idempotency key',
    );
    return this.#withConversationLock(reference.conversationId, async () => {
      const requestKey = runtimeRequestKey(idempotencyKey);
      const priorRuns = await this.store.listRuns(reference, { limit: 5000 });
      const existing = priorRuns.find((run) => run.metadata?.requestKey === requestKey);
      if (existing) {
        return {
          runId: existing.runId,
          duplicate: true,
          conversation: publicConversation(await this.store.getConversation(reference)),
        };
      }
      if (Object.keys(selectedModel).length > 0 && canonicalJson(selectedModel) !== canonicalJson(conversation.selectedModel || {})) {
        await this.store.updateConversation(reference, { selectedModel });
      }
      if (canonicalJson(contextSourceIds) !== canonicalJson(conversation.lastContextSourceIds || conversation.scope?.contextSourceIds || [])) {
        await this.store.updateConversation(reference, { lastContextSourceIds: contextSourceIds });
      }
      if (aiSessionId) this.modelSessions.set(reference.conversationId, aiSessionId);
      const result = await this.runtime.start(reference, {
        content: text,
        attachments,
        contextSourceIds,
        aiSessionId,
        idempotencyKey,
      });
      return { ...result, conversation: publicConversation(result.conversation) };
    });
  }

  async cancel(conversationId, value = {}) {
    const { reference } = await this.#conversation(conversationId);
    const result = await this.runtime.cancel(reference, {
      idempotencyKey: normalizeCopilotIdempotencyKey(
        value.idempotencyKey || `cancel:${crypto.randomUUID()}`,
        'cancel idempotency key',
      ),
    });
    return { ...result, conversation: publicConversation(result.conversation) };
  }

  async retry(conversationId, value = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const aiSessionId = String(value.aiSessionId || this.modelSessions.get(reference.conversationId) || '').trim();
    const selectedModel = this.#resolveSelectedModel(aiSessionId, conversation.selectedModel);
    if (Object.keys(selectedModel).length > 0 && canonicalJson(selectedModel) !== canonicalJson(conversation.selectedModel || {})) {
      await this.store.updateConversation(reference, { selectedModel });
    }
    const result = await this.runtime.retry(reference, {
      aiSessionId,
      idempotencyKey: normalizeCopilotIdempotencyKey(
        value.idempotencyKey || `retry:${crypto.randomUUID()}`,
        'retry idempotency key',
      ),
    });
    if (aiSessionId) this.modelSessions.set(reference.conversationId, aiSessionId);
    return { ...result, conversation: publicConversation(result.conversation) };
  }

  async uploadAttachment(conversationId, request, options = {}) {
    const { reference } = await this.#conversation(conversationId);
    const result = await this.artifacts.uploadAttachment(reference, request, options);
    this.emit(reference, { type: 'attachment.ready', attachment: result.attachment, duplicate: result.duplicate });
    return result;
  }

  async resolveArtifact(conversationId, artifactId) {
    const { reference } = await this.#conversation(conversationId);
    return this.artifacts.resolveArtifact(reference, artifactId);
  }

  async resolveAttachment(conversationId, attachmentId) {
    const { reference } = await this.#conversation(conversationId);
    return this.artifacts.resolveAttachment(reference, attachmentId);
  }

  async confirmApproval(conversationId, approvalId, value = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const id = requiredCopilotId(approvalId, 'approval ID');
    const current = await this.approvals.getApproval(reference, id, { expireDue: true });
    if (!current) throw serviceError('COPILOT_APPROVAL_NOT_FOUND', 'Approval was not found.', 404);
    const approved = value.approved === true || value.action === 'approve';
    const rejected = value.approved === false || value.action === 'reject';
    if (!approved && !rejected) {
      throw serviceError('COPILOT_APPROVAL_DECISION_REQUIRED', 'Approval decision must be approve or reject.');
    }
    const baseKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `approval:${id}:${approved ? 'approve' : 'reject'}`,
      'approval idempotency key',
    );

    if (!approved) {
      const approval = current.status === 'pending'
        ? await this.approvals.reject(reference, id, {
            idempotencyKey: childKey(baseKey, 'decision'),
            expectedRevision: value.expectedRevision,
            actor: 'user',
            reason: String(value.reason || 'user_rejected').slice(0, 1000),
          })
        : current;
      if (approval.status !== 'rejected') {
        throw serviceError('COPILOT_APPROVAL_TRANSITION_INVALID', `Approval is already ${approval.status}.`, 409);
      }
      const run = await this.runtime.cancel(reference, { idempotencyKey: childKey(baseKey, 'cancel') });
      this.emit(reference, { type: 'approval.rejected', approval });
      return { approval, run };
    }

    let approval = current;
    if (approval.status === 'pending') {
      approval = await this.approvals.approve(reference, id, {
        idempotencyKey: childKey(baseKey, 'decision'),
        expectedRevision: value.expectedRevision,
        actor: 'user',
        reason: String(value.reason || 'user_approved').slice(0, 1000),
      });
    }
    if (approval.status === 'consumed') return { approval, duplicate: true };
    if (approval.status !== 'approved') {
      throw serviceError('COPILOT_APPROVAL_TRANSITION_INVALID', `Approval is already ${approval.status}.`, 409);
    }
    try {
      const run = await this.runtime.continueApproval(reference, approval, {
        idempotencyKey: childKey(baseKey, 'continue'),
      });
      this.emit(reference, { type: 'approval.confirmed', approval, runId: run.runId });
      return { approval, run, duplicate: false };
    } catch (error) {
      if (error?.code === 'COPILOT_RUN_ACTIVE') return { approval, duplicate: true };
      throw error;
    }
  }

  emit(referenceOrId, event = {}) {
    const conversationId = typeof referenceOrId === 'string'
      ? requiredCopilotId(referenceOrId, 'conversation ID')
      : requiredCopilotId(referenceOrId?.conversationId, 'conversation ID');
    const nextId = Number(this.eventSequences.get(conversationId) || 0) + 1;
    if (!Number.isSafeInteger(nextId)) {
      throw serviceError('COPILOT_EVENT_SEQUENCE_EXHAUSTED', 'The event sequence cannot be advanced.', 500);
    }
    const normalized = {
      ...structuredClone(event),
      eventId: nextId,
      conversationId,
      createdAt: event.createdAt || isoNow(this.now),
    };
    const persisted = jsonEvent(normalized);
    appendEventDurably(this.#eventFile(conversationId), persisted);
    this.eventSequences.set(conversationId, nextId);
    const buffer = this.eventBuffers.get(conversationId) || [];
    buffer.push(persisted);
    if (buffer.length > EVENT_BUFFER_LIMIT) buffer.splice(0, buffer.length - EVENT_BUFFER_LIMIT);
    this.eventBuffers.set(conversationId, buffer);
    for (const listener of this.listeners.get(conversationId) || []) {
      try { listener(structuredClone(persisted)); } catch { /* A disconnected listener cannot stop a run. */ }
    }
    return persisted;
  }

  subscribe(conversationId, listener, { afterEventId = 0 } = {}) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    if (typeof listener !== 'function') throw new TypeError('Data Copilot event listener must be a function.');
    const listeners = this.listeners.get(id) || new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const buffer = this.eventBuffers.get(id) || [];
    const lastEventId = Number(this.eventSequences.get(id) || 0);
    const requestedEventId = Number(afterEventId || 0);
    const effectiveEventId = Number.isSafeInteger(requestedEventId)
      && requestedEventId >= 0
      && requestedEventId <= lastEventId
      ? requestedEventId
      : Math.max(0, Number(buffer[0]?.eventId || 1) - 1);
    for (const event of buffer) {
      if (event.eventId > effectiveEventId) {
        try { listener(structuredClone(event)); } catch { /* Replay is isolated per subscriber. */ }
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  async handleMcpRequest(conversationId, request = {}) {
    if (!this.mcpAdapter?.handleRequest) {
      throw serviceError('COPILOT_MCP_UNAVAILABLE', 'The Data Copilot MCP transport is unavailable.', 503);
    }
    const { reference, conversation } = await this.#conversation(conversationId);
    return this.mcpAdapter.handleRequest(reference, conversation, request);
  }

  async #conversation(conversationId) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    await this.#ensureInitialized();
    let reference = this.references.get(id);
    if (!reference) {
      const value = await readCopilotJson(path.join(this.rootDir, 'copilot', id, 'conversation.json'), { allowMissing: true });
      if (!value) throw serviceError('COPILOT_CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404);
      reference = normalizeCopilotReference(value);
      if (reference.conversationId !== id) throw serviceError('COPILOT_CONTEXT_MISMATCH', 'Conversation identity is invalid.', 409);
      this.references.set(id, reference);
    }
    const conversation = await this.store.getConversation(reference);
    if (!conversation) throw serviceError('COPILOT_CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404);
    this.policy.validateReference(reference, conversation);
    return { reference, conversation };
  }

  async #loadPersistedEvents(reference) {
    const filePath = this.#eventFile(reference.conversationId);
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const events = [];
    const seen = new Set();
    let invalidCount = 0;
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (
          !event
          || typeof event !== 'object'
          || Array.isArray(event)
          || event.conversationId !== reference.conversationId
          || !Number.isSafeInteger(event.eventId)
          || event.eventId < 1
          || seen.has(event.eventId)
        ) throw new Error('event identity is invalid');
        seen.add(event.eventId);
        events.push(event);
      } catch (error) {
        invalidCount += 1;
        this.discoveryErrors.push({
          conversationId: reference.conversationId,
          code: 'COPILOT_EVENT_LOG_INVALID',
          message: `Ignored invalid event log record at line ${index + 1}: ${String(error?.message || error).slice(0, 300)}`,
        });
      }
    }
    events.sort((left, right) => left.eventId - right.eventId);
    const latest = events.slice(-EVENT_BUFFER_LIMIT);
    this.eventBuffers.set(reference.conversationId, latest);
    this.eventSequences.set(reference.conversationId, Number(events.at(-1)?.eventId || 0));
    if (events.length !== latest.length || invalidCount > 0) {
      await writeCopilotJsonlAtomically(filePath, latest);
    }
  }

  #eventFile(conversationId) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    return path.join(this.rootDir, 'copilot', id, 'events.jsonl');
  }

  #getJob(jobId) {
    const job = this.manager?.getInternal?.(jobId) || this.manager?.get?.(jobId);
    if (!job) throw serviceError('COPILOT_JOB_NOT_FOUND', 'The bound task was not found.', 404);
    return job;
  }

  #resolveSelectedModel(aiSessionId, fallback = {}) {
    const sessionId = String(aiSessionId || '').trim();
    if (!sessionId) return normalizeSelectedModel(fallback);
    if (!this.aiSessions?.resolve) {
      throw serviceError('COPILOT_AI_SESSION_UNAVAILABLE', 'The selected model session is unavailable.', 503);
    }
    const session = this.aiSessions.resolve(sessionId);
    return normalizeSelectedModel(session);
  }

  async #ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  async #withConversationLock(conversationId, operation) {
    const previous = this.operations.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(conversationId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(conversationId) === current) this.operations.delete(conversationId);
    }
  }
}

function publicConversation(value) {
  if (!value) return null;
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    conversationId: value.conversationId,
    jobId: value.jobId,
    snapshotId: value.snapshotId,
    mode: value.mode,
    scope: {
      ...structuredClone(value.scope || {}),
      contextSourceIds: structuredClone(value.lastContextSourceIds || value.scope?.contextSourceIds || []),
    },
    title: String(value.title || ''),
    filters: structuredClone(value.filters || {}),
    selectedModel: normalizeSelectedModel(value.selectedModel),
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastMessageAt: value.lastMessageAt,
    lastToolRunAt: value.lastToolRunAt,
    lastSequences: structuredClone(value.lastSequences || {}),
    runState: structuredClone(value.runState || {}),
  };
}

function normalizeScopeInput(scope, contextSourceIds, job) {
  const value = objectValue(scope);
  const sources = normalizeContextSourceIds(
    contextSourceIds === undefined ? value.contextSourceIds : contextSourceIds,
    job.id,
  );
  return {
    ...value,
    allowedScopes: Array.isArray(value.allowedScopes) && value.allowedScopes.length
      ? [...new Set(value.allowedScopes.map(String))].slice(0, 50)
      : [...DEFAULT_ALLOWED_SCOPES],
    contextSourceIds: sources,
    jobRevision: normalizeJobRevision(job.revision),
  };
}

function normalizeContextSourceIds(value, jobId = null) {
  return normalizeBoundContextSourceIds(value, { jobId, maximum: 100 });
}

function contextJobRecord(job) {
  const value = objectValue(job);
  const mode = value.config?.analysisMode === 'general' ? 'research' : 'application';
  const audience = objectValue(value.workflowSummary?.audience);
  const revision = normalizeJobRevision(value.revision);
  return {
    id: String(value.id || ''),
    title: String(value.keyword || value.config?.keyword || value.id || '未命名任务'),
    mode,
    modeLabel: mode === 'application' ? '岗位任务' : '非岗位任务',
    status: String(value.status || 'unknown'),
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || value.createdAt || ''),
    snapshotId: `job-r${revision}`,
    revision,
    progress: Math.max(0, Math.min(100, Number(value.progress || 0))),
    counts: {
      posts: Math.max(0, Number(mode === 'application'
        ? value.applicationCount || value.scrapedCount || value.discoveredCount || 0
        : value.discoveredCount || value.scrapedCount || 0)),
      comments: Math.max(0, Number(audience.commentsCollected || 0)),
      users: Math.max(0, Number(audience.usersDiscovered || 0)),
      artifacts: Math.max(0, Number(value.artifactCount || 0)),
    },
  };
}

function contextDataset(kind, mode) {
  if (kind === 'posts') return mode === 'application' ? 'applications' : 'content';
  if (kind === 'comments') return 'comments';
  if (kind === 'users') return 'users';
  throw serviceError('COPILOT_CONTEXT_KIND_INVALID', `Unsupported context kind: ${kind}.`);
}

function contextDataRecord(jobId, kind, row) {
  const value = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  if (kind === 'posts') return contextPostRecord(jobId, value);
  if (kind === 'comments') return contextCommentRecord(jobId, value);
  return contextUserRecord(jobId, value);
}

function contextPostRecord(jobId, row) {
  const recordId = stableRecordId('post', row, row.note_id, row.noteId, row.post_id, row.postId, row.id);
  const title = firstText(row.title, row.note_title, row.job_card?.position_title, '未命名原帖');
  const body = firstText(row.body, row.content, row.note_text, row.desc);
  const images = contextImages(row);
  const sourceId = createCopilotContextSourceId(jobId, 'posts', recordId);
  const analysis = row.content_analysis || row.analysis || null;
  return {
    sourceId,
    recordId,
    kind: 'post',
    title: title.slice(0, 240),
    subtitle: (body || firstText(row.author, row.nickname, row.access_status)).slice(0, 240),
    status: firstText(row.access_status, row.bodyStatus, row.status),
    timestamp: displayTime(row.publish_time, row.publishTime, row.created_at),
    imageUrl: images[0] || '',
    url: firstText(row.note_url, row.noteUrl, row.source_url, row.url),
    fields: compactFields([
      ['记录 ID', recordId],
      ['作者', firstText(row.author, row.nickname, row.user?.display_name)],
      ['发布时间', displayTime(row.publish_time, row.publishTime)],
      ['访问状态', firstText(row.access_status, row.bodyStatus, row.status)],
      ['评论数', numberText(row.comment_count, row.comments)],
    ]),
    body: body.slice(0, 12_000),
    images: images.slice(0, 12),
    analysis,
    sections: [
      contextSection(sourceId, '整条记录', '标题、正文、时间与来源链接'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'body'), '正文', body ? '完整正文内容' : '当前记录没有正文'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'images'), '图片', `${images.length} 张图片及已有识别结果`),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'analysis'), 'AI 分析', analysis ? '现有内容分析与岗位字段' : '当前记录没有 AI 分析'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'audience'), '相关评论与用户', '限定到这条原帖的受众数据'),
    ],
  };
}

function contextCommentRecord(jobId, row) {
  const recordId = stableRecordId('comment', row, row.comment_id, row.commentId, row.id);
  const user = row.user && typeof row.user === 'object' ? row.user : {};
  const userId = firstText(user.user_id, user.userId, row.user_id, row.userId);
  const text = firstText(row.text, row.content, row.comment_text);
  const sourceId = createCopilotContextSourceId(jobId, 'comments', recordId);
  const sections = [
    contextSection(sourceId, '整条评论', '评论文本、时间、点赞与层级'),
    contextSection(createCopilotContextSourceId(jobId, 'comments', recordId, 'thread'), '评论线程', '父评论与回复关系'),
  ];
  if (userId) {
    sections.push(contextSection(
      createCopilotContextSourceId(jobId, 'users', userId, 'profile'),
      '评论用户',
      firstText(user.display_name, user.nickname, '关联用户资料'),
    ));
  }
  return {
    sourceId,
    recordId,
    kind: 'comment',
    title: firstText(user.display_name, user.nickname, '匿名用户').slice(0, 240),
    subtitle: text.slice(0, 320),
    status: firstText(row.status, row.replyStatus),
    timestamp: displayTime(row.publish_time, row.publishTime, row.created_at),
    imageUrl: firstText(user.avatar_url, user.avatarUrl),
    url: firstText(row.url, row.comment_url),
    fields: compactFields([
      ['评论 ID', recordId],
      ['原帖 ID', firstText(row.post_id, row.postId)],
      ['层级', firstText(row.level, row.parent_comment_id ? '回复' : '主评论')],
      ['点赞', numberText(row.likes, row.like_count)],
      ['发布时间', displayTime(row.publish_time, row.publishTime)],
    ]),
    body: text.slice(0, 12_000),
    images: [],
    analysis: row.analysis || null,
    sections,
  };
}

function contextUserRecord(jobId, row) {
  const recordId = stableRecordId('user', row, row.user_id, row.userId, row.id);
  const sourceId = createCopilotContextSourceId(jobId, 'users', recordId);
  const bio = firstText(row.bio, row.description, row.signature);
  const roles = Array.isArray(row.roles) ? row.roles.map(String).join('、') : firstText(row.roles);
  const postIds = Array.isArray(row.post_ids) ? row.post_ids : Array.isArray(row.postIds) ? row.postIds : [];
  return {
    sourceId,
    recordId,
    kind: 'user',
    title: firstText(row.display_name, row.nickname, row.name, '未命名用户').slice(0, 240),
    subtitle: (bio || roles || `${Number(row.comment_count || 0)} 条评论`).slice(0, 240),
    status: firstText(row.profileStatus, row.enrichment_status, row.status),
    timestamp: firstText(row.lastAttemptAt, row.updatedAt),
    imageUrl: firstText(row.avatar_url, row.avatarUrl),
    url: firstText(row.profile_url, row.profileUrl, row.url),
    fields: compactFields([
      ['用户 ID', recordId],
      ['角色', roles],
      ['评论数', numberText(row.comment_count, row.commentCount)],
      ['关联原帖', postIds.length ? String(postIds.length) : ''],
      ['主页状态', firstText(row.profileStatus, row.enrichment_status, row.status)],
    ]),
    body: bio.slice(0, 12_000),
    images: [],
    analysis: row.analysis || row.profile_analysis || null,
    sections: [
      contextSection(sourceId, '整条用户记录', '身份、角色与关联统计'),
      contextSection(createCopilotContextSourceId(jobId, 'users', recordId, 'profile'), '公开主页', bio ? '简介与公开主页字段' : '当前记录没有主页简介'),
      contextSection(createCopilotContextSourceId(jobId, 'users', recordId, 'activity'), '评论与原帖关联', `${Number(row.comment_count || 0)} 条评论，${postIds.length} 条关联原帖`),
    ],
  };
}

function contextArtifactRecord(jobId, item) {
  const sourceId = createCopilotContextSourceId(jobId, 'artifacts', item.relativePath);
  return {
    sourceId,
    recordId: item.relativePath,
    kind: 'artifact',
    title: item.name,
    subtitle: item.relativePath,
    status: '可用',
    timestamp: item.updatedAt,
    imageUrl: '',
    url: '',
    fields: compactFields([
      ['相对路径', item.relativePath],
      ['文件大小', formatBytes(item.size)],
      ['更新时间', item.updatedAt],
    ]),
    body: '',
    images: [],
    analysis: null,
    sections: [contextSection(sourceId, '完整产物', '作为本轮对话的数据来源或邮件附件')],
  };
}

async function listTaskArtifactFiles(outputDir) {
  const root = path.resolve(String(outputDir || ''));
  const pending = [''];
  const files = [];
  while (pending.length && files.length < 5000) {
    const relativeDirectory = pending.shift();
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['run.log', 'workflow-state.json'].includes(entry.name)) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(path.join(root, relativePath));
      files.push({
        name: entry.name,
        relativePath: relativePath.split(path.sep).join('/'),
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      });
    }
  }
  return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function contextSection(sourceId, label, description) {
  return { sourceId, label, description };
}

function compactFields(entries) {
  return entries
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => ({ label, value: String(value).slice(0, 1000) }));
}

function contextImages(row) {
  const media = row.media && typeof row.media === 'object' && !Array.isArray(row.media) ? row.media : {};
  const noteCard = row.note_card && typeof row.note_card === 'object'
    ? row.note_card
    : row.noteCard && typeof row.noteCard === 'object'
      ? row.noteCard
      : {};
  const images = [];
  const seenObjects = new WeakSet();

  const append = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      value.forEach((item) => append(item, depth + 1));
      return;
    }
    if (typeof value === 'string') {
      const candidate = value.trim();
      if (!candidate) return;
      const normalized = candidate.startsWith('//') ? `https:${candidate}` : candidate;
      if (/^(?:https?:\/\/|data:image\/|blob:|\/api\/)/iu.test(normalized)) images.push(normalized);
      return;
    }
    if (typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    [
      'url', 'src', 'original_url', 'originalUrl', 'url_original', 'urlOriginal',
      'large_url', 'largeUrl', 'master_url', 'masterUrl', 'url_default', 'urlDefault',
      'image_url', 'imageUrl', 'cover_url', 'coverUrl',
    ].forEach((key) => append(value[key], depth + 1));
    [
      'urls', 'url_list', 'urlList', 'info_list', 'infoList', 'images',
      'image_list', 'imageList', 'image_urls', 'imageUrls',
    ].forEach((key) => append(value[key], depth + 1));
  };

  [
    media.images, media.image_list, media.imageList, media.image_urls, media.imageUrls,
    row.images, row.image_list, row.imageList, row.image_urls, row.imageUrls,
    noteCard.images, noteCard.image_list, noteCard.imageList,
    media.cover, media.cover_url, media.coverUrl,
    row.cover, row.cover_url, row.coverUrl, row.card_cover_url, row.cardCoverUrl,
    row.image_url, row.imageUrl, noteCard.cover, noteCard.cover_url, noteCard.coverUrl,
  ].forEach((value) => append(value));

  return [...new Set(images)];
}

function firstText(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function displayTime(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const structured = firstText(value.value, value.iso, value.datetime, value.raw);
      if (structured) return structured;
      continue;
    }
    const text = firstText(value);
    if (text) return text;
  }
  return '';
}

function stableRecordId(prefix, row, ...values) {
  const supplied = firstText(...values);
  if (supplied) return supplied;
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(row)).digest('hex').slice(0, 20)}`;
}

function numberText(...values) {
  const value = values.find((item) => Number.isFinite(Number(item)));
  return value === undefined ? '' : String(Number(value));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function normalizeSelectedModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const field of ['provider', 'model', 'wireApi']) {
    const text = String(value[field] || '').trim();
    if (text) result[field] = text.slice(0, 500);
  }
  return result;
}

function normalizeTitle(value, job) {
  const supplied = String(value || '').trim();
  if (supplied) return supplied.slice(0, 240);
  const keyword = String(job.keyword || job.params?.keyword || '').trim();
  return keyword ? `Data Copilot: ${keyword}`.slice(0, 240) : 'Data Copilot';
}

function normalizeMode(value) {
  const mode = String(value || '').trim();
  if (!['application', 'research'].includes(mode)) {
    throw serviceError('COPILOT_MODE_INVALID', 'Conversation mode must be application or research.');
  }
  return mode;
}

function normalizeIdList(value, label, maximum) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw serviceError('COPILOT_ATTACHMENTS_INVALID', 'attachmentIds must be an array.');
  if (value.length > maximum) throw serviceError('COPILOT_ATTACHMENTS_EXCEEDED', `At most ${maximum} attachments are allowed.`, 413);
  return [...new Set(value.map((item) => requiredCopilotId(item, label)))];
}

function objectValue(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('COPILOT_VALUE_INVALID', 'Expected an object.');
  }
  return structuredClone(value);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeJobRevision(value) {
  const revision = Number(value ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw serviceError('COPILOT_JOB_REVISION_INVALID', 'The task revision is invalid.', 409);
  }
  return revision;
}

function jsonEvent(value) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) throw new Error('event is empty');
    return JSON.parse(serialized);
  } catch (error) {
    throw serviceError('COPILOT_EVENT_INVALID', 'Data Copilot event data must be JSON serializable.', 500, error);
  }
}

function appendEventDurably(filePath, event) {
  const buffer = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  let descriptor;
  try {
    descriptor = openSync(filePath, 'a', 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (written <= 0) throw new Error('Event log write did not advance.');
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function restartKey(conversationId, runId) {
  return `restart:${crypto.createHash('sha256').update(`${conversationId}:${runId}`).digest('hex').slice(0, 32)}`;
}

function childKey(parent, operation) {
  const candidate = `${parent}:${operation}`;
  if (candidate.length <= 160) return candidate;
  return `${String(parent).slice(0, 120)}:${crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 32)}`;
}

function runtimeRequestKey(value) {
  const text = String(value || '').trim().replace(/[^\p{L}\p{N}_.:-]/gu, '_');
  if (text.length <= 64) return text;
  return `${text.slice(0, 40)}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw serviceError('COPILOT_CLOCK_INVALID', 'Data Copilot clock is invalid.', 500);
  return date.toISOString();
}

function serviceError(code, message, status, cause) {
  return new DataCopilotServiceError(code, message, status, cause);
}
