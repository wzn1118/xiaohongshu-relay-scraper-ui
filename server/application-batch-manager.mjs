import crypto from 'node:crypto';
import path from 'node:path';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import {
  withCopilotFileLock,
  writeCopilotJsonAtomically,
} from './data-copilot-store.mjs';

export const APPLICATION_BATCH_SCHEMA_VERSION = 1;

export const BATCH_STATUSES = Object.freeze([
  'draft',
  'ready',
  'approved',
  'running',
  'paused',
  'completed',
  'cancelled',
]);

export const APPLICATION_ITEM_STATUSES = Object.freeze([
  'resolving',
  'blocked_no_email',
  'blocked_ambiguous',
  'draft_pending',
  'quality_pending',
  'filename_pending',
  'ready',
  'sending',
  'sent',
  'failed_retryable',
  'unknown_manual_review',
  'skipped',
]);

const BATCH_STATUS_SET = new Set(BATCH_STATUSES);
const ITEM_STATUS_SET = new Set(APPLICATION_ITEM_STATUSES);
const INITIAL_ITEM_STATUSES = new Set([
  'resolving',
  'blocked_no_email',
  'blocked_ambiguous',
  'draft_pending',
  'quality_pending',
  'filename_pending',
  'ready',
  'skipped',
]);
const TERMINAL_ITEM_STATUSES = new Set(['sent', 'skipped']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_METADATA_BYTES = 256 * 1024;
const EVENT_TYPES = new Set([
  'batch_created',
  'batch_updated',
  'batch_approved',
  'batch_resumed',
  'batch_paused',
  'batch_cancelled',
  'batch_recovered',
  'item_updated',
]);

const ITEM_TRANSITIONS = Object.freeze({
  resolving: new Set(['blocked_no_email', 'blocked_ambiguous', 'draft_pending', 'skipped']),
  blocked_no_email: new Set(['resolving', 'skipped']),
  blocked_ambiguous: new Set(['resolving', 'skipped']),
  draft_pending: new Set(['quality_pending', 'blocked_no_email', 'blocked_ambiguous', 'skipped']),
  quality_pending: new Set(['draft_pending', 'filename_pending', 'blocked_ambiguous', 'skipped']),
  filename_pending: new Set(['draft_pending', 'quality_pending', 'ready', 'blocked_ambiguous', 'skipped']),
  ready: new Set(['draft_pending', 'quality_pending', 'filename_pending', 'sending', 'skipped']),
  sending: new Set(['sent', 'failed_retryable', 'unknown_manual_review']),
  sent: new Set(),
  failed_retryable: new Set(['sending', 'skipped']),
  unknown_manual_review: new Set(['sent', 'failed_retryable', 'skipped']),
  skipped: new Set(['resolving']),
});

const BATCH_TRANSITIONS = Object.freeze({
  draft: new Set(['ready', 'cancelled']),
  ready: new Set(['approved', 'cancelled']),
  approved: new Set(['running', 'cancelled']),
  running: new Set(['paused', 'completed', 'cancelled']),
  paused: new Set(['running', 'completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(),
});

export class ApplicationBatchManagerError extends Error {
  constructor(code, message, status = 400, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApplicationBatchManagerError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Durable state store and lifecycle guard for personalized application batches.
 * The manager deliberately does not send mail. A sender/scheduler can use the
 * item transitions here while retaining the existing single-message send path.
 */
export class ApplicationBatchManager {
  constructor({ rootDir, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!String(rootDir || '').trim()) throw batchError('APPLICATION_BATCH_ROOT_REQUIRED', 'Application batch root directory is required.');
    const resolvedRoot = path.resolve(String(rootDir));
    const batchRoot = path.resolve(resolvedRoot, 'artifacts', 'application-batches');
    assertInside(resolvedRoot, batchRoot);
    this.rootDir = resolvedRoot;
    this.batchRoot = batchRoot;
    this.now = now;
    this.idFactory = idFactory;
    this.initialized = false;
    this.initializing = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.#initialize();
    try {
      await this.initializing;
      this.initialized = true;
    } finally {
      this.initializing = null;
    }
  }

  async createBatch(value = {}) {
    await this.#ensureInitialized();
    const batchId = normalizeId(value.batchId || this.idFactory(), 'batch ID');
    const jobId = normalizeId(value.jobId, 'job ID');
    const items = normalizeCreateItems(value.items);
    const title = normalizeText(value.title, 240);
    const metadata = normalizeJson(value.metadata || {}, 'batch metadata', MAX_METADATA_BYTES);
    const settings = normalizeJson(value.settings || {}, 'batch settings', MAX_METADATA_BYTES);
    const directory = this.#batchDirectory(batchId);
    const batchPath = path.join(directory, 'batch.json');
    return this.#withRootLock(async () => {
      if (await exists(directory)) throw batchError('APPLICATION_BATCH_CONFLICT', 'Application batch ID is already in use.', 409);
      await mkdir(path.join(directory, 'items'), { recursive: true });
      const now = isoNow(this.now);
      const normalizedItems = items.map((item, index) => createItemState({
        batchId,
        item,
        fallbackItemId: item.noteId || `item-${index + 1}`,
        now,
      }));
      const batch = createBatchState({
        batchId,
        jobId,
        title,
        metadata,
        settings,
        items: normalizedItems,
        now,
      });
      for (const item of normalizedItems) await writeJsonAtomically(this.#itemPath(batchId, item.itemId), item);
      await writeJsonAtomically(batchPath, batch);
      await appendEvent(directory, eventForBatch(batch, 'batch_created', { itemIds: batch.itemIds }));
      return cloneBatchWithItems(batch, normalizedItems);
    });
  }

  async getBatch(batchId) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      return cloneBatchWithItems(batch, items);
    });
  }

  async getItem(batchId, itemId) {
    await this.#ensureInitialized();
    const batch = await this.getBatch(batchId);
    const id = normalizeId(itemId, 'item ID');
    const item = batch.items.find((candidate) => candidate.itemId === id);
    if (!item) throw batchError('APPLICATION_BATCH_ITEM_NOT_FOUND', 'Application batch item was not found.', 404);
    return structuredClone(item);
  }

  async listBatches({ jobId = null, status = null } = {}) {
    await this.#ensureInitialized();
    const normalizedJobId = jobId === null || jobId === undefined ? null : normalizeId(jobId, 'job ID');
    if (status !== null && status !== undefined && !BATCH_STATUS_SET.has(String(status))) {
      throw batchError('APPLICATION_BATCH_STATUS_INVALID', 'Application batch status is invalid.');
    }
    let entries;
    try {
      entries = await readdir(this.batchRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const results = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory() && SAFE_ID.test(candidate.name) && !WINDOWS_RESERVED_ID.test(candidate.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const batch = await this.#readBatch(entry.name);
      if (normalizedJobId && batch.jobId !== normalizedJobId) continue;
      if (status && batch.status !== status) continue;
      const items = await this.#readItems(batch);
      results.push(cloneBatchWithItems(batch, items));
    }
    return results.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listEvents(batchId, { afterSequence = 0 } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw batchError('APPLICATION_BATCH_SEQUENCE_INVALID', 'Event sequence must be a non-negative integer.');
    }
    return this.#withBatchLock(id, async () => {
      await this.#readBatch(id);
      const filePath = this.#eventsPath(id);
      let text;
      try {
        text = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const events = [];
      let previous = 0;
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          throw batchError('APPLICATION_BATCH_EVENTS_INVALID', `Application batch event log is invalid at line ${index + 1}.`, 500, error);
        }
        validateEvent(event, id);
        if (event.sequence <= previous) throw batchError('APPLICATION_BATCH_EVENTS_INVALID', 'Application batch event sequence is not strictly increasing.', 500);
        previous = event.sequence;
        if (event.sequence > afterSequence) events.push(event);
      }
      return events.map((event) => structuredClone(event));
    });
  }

  async updateBatch(batchId, patch = {}, { expectedRevision = undefined, actor = 'system' } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      assertExpectedRevision(batch.revision, expectedRevision, 'batch');
      if (['approved', 'running', 'paused', 'completed', 'cancelled'].includes(batch.status)) {
        throw batchError('APPLICATION_BATCH_IMMUTABLE', 'Approved or terminal application batches require a new batch for content changes.', 409);
      }
      const next = structuredClone(batch);
      if (Object.hasOwn(patch, 'title')) next.title = normalizeText(patch.title, 240);
      if (Object.hasOwn(patch, 'metadata')) next.metadata = normalizeJson(patch.metadata || {}, 'batch metadata', MAX_METADATA_BYTES);
      if (Object.hasOwn(patch, 'settings')) next.settings = normalizeJson(patch.settings || {}, 'batch settings', MAX_METADATA_BYTES);
      if (Object.hasOwn(patch, 'status')) {
        const requested = String(patch.status || '');
        if (!BATCH_STATUS_SET.has(requested)) throw batchError('APPLICATION_BATCH_STATUS_INVALID', 'Application batch status is invalid.');
        assertBatchTransition(batch.status, requested);
        if (requested !== 'ready' || derivePreApprovalBatchStatus(await this.#readItems(batch)) !== 'ready') {
          throw batchError('APPLICATION_BATCH_STATUS_INVALID', 'A batch can be marked ready only when at least one item is ready.', 409);
        }
        next.status = requested;
      }
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      next.lastEventSequence += 1;
      next.counts = batchCounts(await this.#readItems(batch));
      await writeJsonAtomically(this.#batchPath(id), next);
      await appendEvent(this.#batchDirectory(id), eventForBatch(next, 'batch_updated', {
        actor: normalizeText(actor, 160),
        patch: publicPatch(patch),
      }));
      return cloneBatchWithItems(next, await this.#readItems(next));
    });
  }

  async updateItem(batchId, itemId, patch = {}, { expectedBatchRevision = undefined, expectedItemRevision = undefined, actor = 'system' } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    const itemKey = normalizeId(itemId, 'item ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      const index = items.findIndex((item) => item.itemId === itemKey);
      if (index < 0) throw batchError('APPLICATION_BATCH_ITEM_NOT_FOUND', 'Application batch item was not found.', 404);
      assertExpectedRevision(batch.revision, expectedBatchRevision, 'batch');
      assertExpectedRevision(items[index].revision, expectedItemRevision, 'item');
      const current = items[index];
      const next = structuredClone(current);
      const contentPatch = Object.hasOwn(patch, 'payload') || Object.hasOwn(patch, 'noteId') || Object.hasOwn(patch, 'contactCandidateId');
      if (contentPatch && ['approved', 'running', 'paused'].includes(batch.status)) {
        throw batchError('APPLICATION_BATCH_IMMUTABLE', 'Approved batch item content is immutable.', 409);
      }
      if (Object.hasOwn(patch, 'noteId')) next.noteId = normalizeId(patch.noteId, 'note ID');
      if (Object.hasOwn(patch, 'contactCandidateId')) next.contactCandidateId = normalizeOptionalId(patch.contactCandidateId, 'contact candidate ID');
      if (Object.hasOwn(patch, 'payload')) next.payload = normalizeJson(patch.payload || {}, 'item payload', MAX_METADATA_BYTES);
      if (Object.hasOwn(patch, 'error')) next.error = normalizeError(patch.error);
      if (Object.hasOwn(patch, 'status')) {
        const requested = String(patch.status || '');
        assertItemTransition(current.status, requested);
        if (requested === 'sending') {
          if (batch.status !== 'running') {
            throw batchError('APPLICATION_BATCH_NOT_RUNNING', 'An item can enter sending only while its batch is running.', 409);
          }
          assertApprovalCurrent(batch, items);
        }
        next.status = requested;
      }
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      items[index] = next;
      const nextBatch = structuredClone(batch);
      nextBatch.revision += 1;
      nextBatch.updatedAt = next.updatedAt;
      nextBatch.lastEventSequence += 1;
      nextBatch.counts = batchCounts(items);
      if (!['approved', 'running', 'paused', 'completed', 'cancelled'].includes(batch.status)) {
        nextBatch.status = derivePreApprovalBatchStatus(items);
      } else if (batch.status === 'running' && allItemsTerminal(items)) {
        nextBatch.status = 'completed';
      } else if (batch.status === 'running' && allItemsNeedAttention(items)) {
        nextBatch.status = 'paused';
      }
      await writeJsonAtomically(this.#itemPath(id, itemKey), next);
      await writeJsonAtomically(this.#batchPath(id), nextBatch);
      await appendEvent(this.#batchDirectory(id), eventForBatch(nextBatch, 'item_updated', {
        actor: normalizeText(actor, 160),
        itemId: itemKey,
        fromStatus: current.status,
        toStatus: next.status,
        itemRevision: next.revision,
        error: next.error,
      }));
      return cloneBatchWithItems(nextBatch, items);
    });
  }

  async approveBatch(batchId, { expectedRevision, actor = 'user', reason = '' } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      assertExpectedRevision(batch.revision, expectedRevision, 'batch', true);
      if (batch.status !== 'ready') throw batchError('APPLICATION_BATCH_NOT_READY', 'Only a ready application batch can be approved.', 409);
      if (!items.some((item) => item.status === 'ready')) throw batchError('APPLICATION_BATCH_EMPTY', 'The application batch has no ready items.', 409);
      if (items.some((item) => !['ready', 'skipped'].includes(item.status))) {
        throw batchError('APPLICATION_BATCH_ITEMS_NOT_READY', 'Every non-skipped item must be ready before approval.', 409);
      }
      const next = structuredClone(batch);
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      next.status = 'approved';
      next.approvalRevision += 1;
      next.approval = {
        revision: next.approvalRevision,
        batchRevision: next.revision,
        snapshotHash: approvalSnapshotHash(next, items),
        approvedAt: next.updatedAt,
        actor: normalizeText(actor, 160),
        reason: normalizeText(reason, 1_000),
      };
      next.lastEventSequence += 1;
      await writeJsonAtomically(this.#batchPath(id), next);
      await appendEvent(this.#batchDirectory(id), eventForBatch(next, 'batch_approved', {
        actor: next.approval.actor,
        reason: next.approval.reason,
        approvalRevision: next.approval.revision,
        snapshotHash: next.approval.snapshotHash,
      }));
      return cloneBatchWithItems(next, items);
    });
  }

  async pauseBatch(batchId, { expectedRevision = undefined, actor = 'user', reason = '' } = {}) {
    return this.#transitionBatch(batchId, 'paused', { expectedRevision, actor, reason, eventType: 'batch_paused' });
  }

  async resumeBatch(batchId, { expectedRevision = undefined, actor = 'user', reason = '' } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      assertExpectedRevision(batch.revision, expectedRevision, 'batch');
      if (!['approved', 'paused'].includes(batch.status)) {
        throw batchError('APPLICATION_BATCH_TRANSITION_INVALID', `Application batch cannot resume from ${batch.status}.`, 409);
      }
      assertApprovalCurrent(batch, items);
      if (!items.some((item) => ['ready', 'failed_retryable'].includes(item.status))) {
        throw batchError('APPLICATION_BATCH_NO_SENDABLE_ITEMS', 'The application batch has no sendable items; unknown items require manual review.', 409);
      }
      const next = structuredClone(batch);
      next.status = 'running';
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      next.lastEventSequence += 1;
      await writeJsonAtomically(this.#batchPath(id), next);
      await appendEvent(this.#batchDirectory(id), eventForBatch(next, 'batch_resumed', {
        actor: normalizeText(actor, 160),
        reason: normalizeText(reason, 1_000),
      }));
      return cloneBatchWithItems(next, items);
    });
  }

  async cancelBatch(batchId, { expectedRevision = undefined, actor = 'user', reason = '' } = {}) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      assertExpectedRevision(batch.revision, expectedRevision, 'batch');
      if (['completed', 'cancelled'].includes(batch.status)) {
        if (batch.status === 'cancelled') return cloneBatchWithItems(batch, items);
        throw batchError('APPLICATION_BATCH_TRANSITION_INVALID', `Application batch cannot cancel from ${batch.status}.`, 409);
      }
      const now = isoNow(this.now);
      const changed = [];
      for (const item of items) {
        const nextStatus = item.status === 'sending'
          ? 'unknown_manual_review'
          : TERMINAL_ITEM_STATUSES.has(item.status) || item.status === 'unknown_manual_review'
            ? item.status
            : 'skipped';
        if (nextStatus === item.status) continue;
        item.status = nextStatus;
        item.revision += 1;
        item.updatedAt = now;
        item.error = nextStatus === 'unknown_manual_review'
          ? { code: 'DELIVERY_STATE_UNKNOWN_AFTER_CANCEL', message: 'The item was in flight when its batch was cancelled.' }
          : { code: 'APPLICATION_BATCH_CANCELLED', message: 'The item was skipped because its batch was cancelled.' };
        changed.push(item.itemId);
        await writeJsonAtomically(this.#itemPath(id, item.itemId), item);
      }
      const next = structuredClone(batch);
      next.status = 'cancelled';
      next.revision += 1;
      next.updatedAt = now;
      next.lastEventSequence += 1;
      next.counts = batchCounts(items);
      next.cancelledAt = now;
      next.cancelledBy = normalizeText(actor, 160);
      next.cancellationReason = normalizeText(reason, 1_000);
      await writeJsonAtomically(this.#batchPath(id), next);
      await appendEvent(this.#batchDirectory(id), eventForBatch(next, 'batch_cancelled', {
        actor: next.cancelledBy,
        reason: next.cancellationReason,
        changedItemIds: changed,
      }));
      return cloneBatchWithItems(next, items);
    });
  }

  async #transitionBatch(batchId, requested, { expectedRevision, actor, reason, eventType }) {
    await this.#ensureInitialized();
    const id = normalizeId(batchId, 'batch ID');
    return this.#withBatchLock(id, async () => {
      const batch = await this.#readBatch(id);
      const items = await this.#readItems(batch);
      assertExpectedRevision(batch.revision, expectedRevision, 'batch');
      if (batch.status === requested) return cloneBatchWithItems(batch, items);
      assertBatchTransition(batch.status, requested);
      if (requested === 'paused' && batch.status !== 'running') {
        throw batchError('APPLICATION_BATCH_NOT_RUNNING', 'Only a running application batch can be paused.', 409);
      }
      if (requested === 'paused' && allItemsTerminal(items)) {
        throw batchError('APPLICATION_BATCH_ALREADY_COMPLETE', 'A completed application batch does not need pausing.', 409);
      }
      const next = structuredClone(batch);
      next.status = requested;
      next.revision += 1;
      next.updatedAt = isoNow(this.now);
      next.lastEventSequence += 1;
      if (requested === 'paused') next.pausedAt = next.updatedAt;
      await writeJsonAtomically(this.#batchPath(id), next);
      await appendEvent(this.#batchDirectory(id), eventForBatch(next, eventType, {
        actor: normalizeText(actor, 160),
        reason: normalizeText(reason, 1_000),
      }));
      return cloneBatchWithItems(next, items);
    });
  }

  async #initialize() {
    await mkdir(this.batchRoot, { recursive: true });
    await this.#withRootLock(async () => {
      let entries;
      try {
        entries = await readdir(this.batchRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries.filter((candidate) => candidate.isDirectory() && SAFE_ID.test(candidate.name) && !WINDOWS_RESERVED_ID.test(candidate.name))) {
        const directory = this.#batchDirectory(entry.name);
        if (!await exists(directory)) {
          await rm(directory, { recursive: true, force: true });
          continue;
        }
        await this.#recoverBatch(entry.name);
      }
    });
  }

  async #recoverBatch(batchId) {
    return this.#withBatchLock(batchId, async () => {
      const batch = await this.#readBatch(batchId);
      const items = await this.#readItems(batch);
      const persistedEventSequence = await lastEventSequence(this.#eventsPath(batchId), batchId);
      if (persistedEventSequence > batch.lastEventSequence) {
        throw batchError('APPLICATION_BATCH_EVENTS_INVALID', 'Application batch events are ahead of committed state.', 500);
      }
      const recovering = items.filter((item) => item.status === 'sending');
      const now = isoNow(this.now);
      for (const item of recovering) {
        item.status = 'unknown_manual_review';
        item.revision += 1;
        item.updatedAt = now;
        item.recoveredAt = now;
        item.error = {
          code: 'DELIVERY_STATE_UNKNOWN_AFTER_RESTART',
          message: 'The process restarted while this item was sending; delivery must be reconciled before retrying.',
        };
        await writeJsonAtomically(this.#itemPath(batchId, item.itemId), item);
      }
      const recoveredCounts = batchCounts(items);
      const recoveredStatus = deriveRecoveredBatchStatus(batch.status, items, recovering.length > 0);
      if (!recovering.length && recoveredStatus === batch.status && batchCountsEqual(batch.counts, recoveredCounts)) {
        if (persistedEventSequence < batch.lastEventSequence) {
          await appendEvent(this.#batchDirectory(batchId), eventForBatch(batch, 'batch_recovered', {
            recoveredItemIds: [],
            reason: 'event_log_repaired_after_restart',
            missingAfterSequence: persistedEventSequence,
          }));
        }
        return;
      }
      const next = structuredClone(batch);
      next.revision += 1;
      next.updatedAt = now;
      next.lastEventSequence += 1;
      next.recoveryCount = Number.isSafeInteger(next.recoveryCount) ? next.recoveryCount + 1 : 1;
      next.counts = recoveredCounts;
      next.status = recoveredStatus;
      await writeJsonAtomically(this.#batchPath(batchId), next);
      await appendEvent(this.#batchDirectory(batchId), eventForBatch(next, 'batch_recovered', {
        recoveredItemIds: recovering.map((item) => item.itemId),
        reason: recovering.length ? 'delivery_state_unknown_after_restart' : 'batch_state_reconciled_after_restart',
        fromStatus: batch.status,
        toStatus: next.status,
        previousCounts: batch.counts,
        recoveredCounts: next.counts,
      }));
    });
  }

  async #readBatch(batchId) {
    const filePath = this.#batchPath(batchId);
    let value;
    try {
      value = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw batchError('APPLICATION_BATCH_NOT_FOUND', 'Application batch was not found.', 404);
      if (error instanceof ApplicationBatchManagerError) throw error;
      throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch state is missing or invalid.', 500, error);
    }
    validateBatch(value, batchId);
    return value;
  }

  async #readItems(batch) {
    const items = [];
    for (const itemId of batch.itemIds) {
      const filePath = this.#itemPath(batch.batchId, itemId);
      let value;
      try {
        value = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        throw batchError('APPLICATION_BATCH_ITEM_STATE_INVALID', `Application batch item ${itemId} is missing or invalid.`, 500, error);
      }
      validateItem(value, batch.batchId, itemId);
      items.push(value);
    }
    return items;
  }

  #batchDirectory(batchId) {
    const id = normalizeId(batchId, 'batch ID');
    const target = path.resolve(this.batchRoot, id);
    assertInside(this.batchRoot, target);
    return target;
  }

  #batchPath(batchId) {
    return path.join(this.#batchDirectory(batchId), 'batch.json');
  }

  #itemPath(batchId, itemId) {
    const directory = path.resolve(this.#batchDirectory(batchId), 'items');
    const target = path.resolve(directory, `${normalizeId(itemId, 'item ID')}.json`);
    assertInside(directory, target);
    return target;
  }

  #eventsPath(batchId) {
    return path.join(this.#batchDirectory(batchId), 'events.jsonl');
  }

  #withRootLock(operation) {
    return withCopilotFileLock(path.join(this.batchRoot, '.store.lock'), operation);
  }

  #withBatchLock(batchId, operation) {
    const directory = this.#batchDirectory(batchId);
    return withCopilotFileLock(path.join(directory, '.store.lock'), operation);
  }

  async #ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }
}

function createBatchState({ batchId, jobId, title, metadata, settings, items, now }) {
  const status = derivePreApprovalBatchStatus(items);
  const batch = {
    schemaVersion: APPLICATION_BATCH_SCHEMA_VERSION,
    batchId,
    jobId,
    title,
    metadata,
    settings,
    status,
    revision: 1,
    approvalRevision: 0,
    approval: null,
    itemIds: items.map((item) => item.itemId),
    counts: batchCounts(items),
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 1,
    recoveryCount: 0,
    cancelledAt: null,
    cancelledBy: '',
    cancellationReason: '',
  };
  validateBatch(batch, batchId);
  return batch;
}

function createItemState({ batchId, item, fallbackItemId, now }) {
  const itemId = normalizeId(item.itemId || fallbackItemId, 'item ID');
  const noteId = normalizeId(item.noteId || itemId, 'note ID');
  const status = String(item.status || 'resolving');
  if (!INITIAL_ITEM_STATUSES.has(status)) throw batchError('APPLICATION_BATCH_ITEM_STATUS_INVALID', 'Initial item status is invalid.');
  const value = {
    schemaVersion: APPLICATION_BATCH_SCHEMA_VERSION,
    batchId,
    itemId,
    noteId,
    contactCandidateId: normalizeOptionalId(item.contactCandidateId, 'contact candidate ID'),
    status,
    payload: normalizeJson(item.payload || {}, 'item payload', MAX_METADATA_BYTES),
    error: normalizeError(item.error),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    recoveredAt: null,
  };
  validateItem(value, batchId, itemId);
  return value;
}

function normalizeCreateItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw batchError('APPLICATION_BATCH_ITEMS_INVALID', 'An application batch must contain between one and 10,000 items.');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw batchError('APPLICATION_BATCH_ITEM_INVALID', 'Each application batch item must be an object.');
    const candidate = { ...item };
    const itemId = candidate.itemId || candidate.noteId;
    if (itemId) {
      const normalized = normalizeId(itemId, 'item ID');
      if (seen.has(normalized)) throw batchError('APPLICATION_BATCH_ITEM_DUPLICATE', 'Application batch item IDs must be unique.');
      seen.add(normalized);
      candidate.itemId = normalized;
    }
    return candidate;
  });
}

function derivePreApprovalBatchStatus(items) {
  return hasReadyItems(items) && items.every((item) => ['ready', 'skipped'].includes(item.status)) ? 'ready' : 'draft';
}

function hasReadyItems(items) {
  return items.some((item) => item.status === 'ready');
}

function allItemsTerminal(items) {
  return items.every((item) => TERMINAL_ITEM_STATUSES.has(item.status));
}

function allItemsNeedAttention(items) {
  return items.every((item) => TERMINAL_ITEM_STATUSES.has(item.status) || item.status === 'unknown_manual_review');
}

function deriveRecoveredBatchStatus(status, items, recoveredSending) {
  if (status === 'cancelled') return status;
  if (allItemsTerminal(items)) return 'completed';
  if (recoveredSending || ['running', 'paused', 'completed'].includes(status)) return 'paused';
  if (['draft', 'ready'].includes(status)) return derivePreApprovalBatchStatus(items);
  return status;
}

function batchCounts(items) {
  const counts = Object.fromEntries(APPLICATION_ITEM_STATUSES.map((status) => [status, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function batchCountsEqual(left, right) {
  return APPLICATION_ITEM_STATUSES.every((status) => Number(left?.[status] || 0) === right[status]);
}

function approvalSnapshotHash(batch, items) {
  return hashCanonical({
    batchId: batch.batchId,
    jobId: batch.jobId,
    settings: batch.settings,
    items: items
      .map((item) => ({
        itemId: item.itemId,
        noteId: item.noteId,
        contactCandidateId: item.contactCandidateId,
        payload: item.payload,
      }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  });
}

function assertApprovalCurrent(batch, items) {
  if (!batch.approval || batch.approval.snapshotHash !== approvalSnapshotHash(batch, items)) {
    throw batchError('APPLICATION_BATCH_APPROVAL_STALE', 'The application batch approval is stale and must be regenerated.', 409);
  }
}

function eventForBatch(batch, type, details = {}) {
  return {
    schemaVersion: APPLICATION_BATCH_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    sequence: batch.lastEventSequence,
    batchId: batch.batchId,
    type,
    batchRevision: batch.revision,
    at: batch.updatedAt,
    ...structuredClone(details),
  };
}

async function appendEvent(directory, event) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'events.jsonl');
  let handle;
  try {
    handle = await open(filePath, 'a', 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function lastEventSequence(filePath, batchId) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let previous = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw batchError('APPLICATION_BATCH_EVENTS_INVALID', 'Application batch event log is invalid.', 500, error);
    }
    validateEvent(event, batchId);
    if (event.sequence <= previous) {
      throw batchError('APPLICATION_BATCH_EVENTS_INVALID', 'Application batch event sequence is invalid.', 500);
    }
    previous = event.sequence;
  }
  return previous;
}

async function writeJsonAtomically(filePath, value) {
  await writeCopilotJsonAtomically(filePath, value);
}

function validateBatch(value, expectedBatchId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch state is invalid.', 500);
  if (value.schemaVersion !== APPLICATION_BATCH_SCHEMA_VERSION || normalizeId(value.batchId, 'batch ID') !== expectedBatchId) {
    throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch identity or schema is invalid.', 500);
  }
  normalizeId(value.jobId, 'job ID');
  if (!BATCH_STATUS_SET.has(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.approvalRevision) || value.approvalRevision < 0) {
    throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch status or revision is invalid.', 500);
  }
  if (!Array.isArray(value.itemIds) || value.itemIds.length < 1 || new Set(value.itemIds).size !== value.itemIds.length) throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch item IDs are invalid.', 500);
  value.itemIds.forEach((itemId) => normalizeId(itemId, 'item ID'));
  if (!Number.isSafeInteger(value.lastEventSequence) || value.lastEventSequence < 1) throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch event sequence is invalid.', 500);
  normalizeJson(value.metadata || {}, 'batch metadata', MAX_METADATA_BYTES);
  normalizeJson(value.settings || {}, 'batch settings', MAX_METADATA_BYTES);
  if (value.approval !== null) {
    if (!value.approval || !Number.isSafeInteger(value.approval.revision) || value.approval.revision < 1 || !Number.isSafeInteger(value.approval.batchRevision) || value.approval.batchRevision < 1 || !/^[a-f0-9]{64}$/u.test(String(value.approval.snapshotHash || ''))) {
      throw batchError('APPLICATION_BATCH_STATE_INVALID', 'Application batch approval is invalid.', 500);
    }
  }
}

function validateItem(value, expectedBatchId, expectedItemId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw batchError('APPLICATION_BATCH_ITEM_STATE_INVALID', 'Application batch item state is invalid.', 500);
  if (value.schemaVersion !== APPLICATION_BATCH_SCHEMA_VERSION || value.batchId !== expectedBatchId || normalizeId(value.itemId, 'item ID') !== expectedItemId) throw batchError('APPLICATION_BATCH_ITEM_STATE_INVALID', 'Application batch item identity or schema is invalid.', 500);
  normalizeId(value.noteId, 'note ID');
  normalizeOptionalId(value.contactCandidateId, 'contact candidate ID');
  if (!ITEM_STATUS_SET.has(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw batchError('APPLICATION_BATCH_ITEM_STATE_INVALID', 'Application batch item status or revision is invalid.', 500);
  normalizeJson(value.payload || {}, 'item payload', MAX_METADATA_BYTES);
  normalizeError(value.error);
}

function validateEvent(value, batchId) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== APPLICATION_BATCH_SCHEMA_VERSION
    || value.batchId !== batchId
    || !SAFE_ID.test(String(value.eventId || ''))
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !EVENT_TYPES.has(value.type)
  ) {
    throw batchError('APPLICATION_BATCH_EVENTS_INVALID', 'Application batch event is invalid.', 500);
  }
}

function assertExpectedRevision(actual, expected, label, required = false) {
  if (expected === undefined || expected === null) {
    if (required) throw batchError('APPLICATION_BATCH_REVISION_REQUIRED', `Expected ${label} revision is required.`);
    return;
  }
  if (!Number.isSafeInteger(expected) || expected < 1 || expected !== actual) throw batchError('APPLICATION_BATCH_REVISION_CONFLICT', `${label} revision is stale.`, 409);
}

function assertItemTransition(from, to) {
  if (!ITEM_STATUS_SET.has(to) || !ITEM_TRANSITIONS[from]?.has(to)) throw batchError('APPLICATION_BATCH_ITEM_TRANSITION_INVALID', `Application batch item cannot transition from ${from} to ${to}.`, 409);
}

function assertBatchTransition(from, to) {
  if (!BATCH_STATUS_SET.has(to) || !BATCH_TRANSITIONS[from]?.has(to)) throw batchError('APPLICATION_BATCH_TRANSITION_INVALID', `Application batch cannot transition from ${from} to ${to}.`, 409);
}

function normalizeId(value, label) {
  const text = String(value || '').trim();
  if (!SAFE_ID.test(text) || WINDOWS_RESERVED_ID.test(text)) throw batchError('APPLICATION_BATCH_ID_INVALID', `${label} contains an invalid path identifier.`);
  return text;
}

function normalizeOptionalId(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return normalizeId(value, label);
}

function normalizeText(value, maxLength) {
  const text = String(value ?? '').normalize('NFC').trim();
  if (text.length > maxLength) throw batchError('APPLICATION_BATCH_TEXT_TOO_LONG', 'Application batch text is too long.');
  if (text.includes('\u0000')) throw batchError('APPLICATION_BATCH_TEXT_INVALID', 'Application batch text contains a NUL character.');
  return text;
}

function normalizeJson(value, label, maxBytes) {
  let text;
  try {
    text = JSON.stringify(value, (_, candidate) => {
      if (typeof candidate === 'bigint') throw new TypeError('bigint is not JSON serializable');
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) throw new TypeError('non-finite number is not JSON serializable');
      return candidate;
    });
  } catch (error) {
    throw batchError('APPLICATION_BATCH_JSON_INVALID', `${label} is not valid JSON.`, 400, error);
  }
  if (Buffer.byteLength(text || '', 'utf8') > maxBytes) throw batchError('APPLICATION_BATCH_JSON_TOO_LARGE', `${label} is too large.`);
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    throw batchError('APPLICATION_BATCH_JSON_INVALID', `${label} is not valid JSON.`, 400, error);
  }
}

function normalizeError(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw batchError('APPLICATION_BATCH_ERROR_INVALID', 'Application batch error metadata is invalid.');
  const normalized = {
    code: normalizeText(value.code, 160),
    message: normalizeText(value.message, 1_000),
  };
  if (Object.hasOwn(value, 'attempt')) {
    const attempt = Number(value.attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000) throw batchError('APPLICATION_BATCH_ERROR_INVALID', 'Application batch retry attempt is invalid.');
    normalized.attempt = attempt;
  }
  if (Object.hasOwn(value, 'backoffMs')) {
    const backoffMs = Number(value.backoffMs);
    if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 86_400_000) throw batchError('APPLICATION_BATCH_ERROR_INVALID', 'Application batch retry delay is invalid.');
    normalized.backoffMs = backoffMs;
  }
  if (Object.hasOwn(value, 'retryAt')) {
    const retryAt = new Date(value.retryAt);
    if (Number.isNaN(retryAt.getTime())) throw batchError('APPLICATION_BATCH_ERROR_INVALID', 'Application batch retry time is invalid.');
    normalized.retryAt = retryAt.toISOString();
  }
  return normalized;
}

function publicPatch(value) {
  return normalizeJson(value || {}, 'batch update patch', MAX_METADATA_BYTES);
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw batchError('APPLICATION_BATCH_CLOCK_INVALID', 'Application batch clock returned an invalid date.', 500);
  return date.toISOString();
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function cloneBatchWithItems(batch, items) {
  return { ...structuredClone(batch), items: items.map((item) => structuredClone(item)) };
}

function assertInside(parent, target) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  if (targetPath !== parentPath && !targetPath.startsWith(`${parentPath}${path.sep}`)) {
    throw batchError('APPLICATION_BATCH_PATH_INVALID', 'Application batch path escapes its configured root.', 500);
  }
}

async function exists(target) {
  try {
    await readFile(path.join(target, 'batch.json'), 'utf8');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

function batchError(code, message, status = 400, cause = undefined) {
  return new ApplicationBatchManagerError(code, message, status, cause);
}
