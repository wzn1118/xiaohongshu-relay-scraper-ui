import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';

import {
  DATA_COPILOT_SCHEMA_VERSION,
  copilotHash,
  copilotJsonValue,
  normalizeCopilotIdempotencyKey,
  normalizeCopilotReference,
  readCopilotJson,
  requiredCopilotId,
  resolveCopilotConversationDirectory,
  withCopilotFileLock,
  writeCopilotJsonAtomically,
} from './data-copilot-store.mjs';

export const COPILOT_APPROVAL_SCHEMA_VERSION = 1;

const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled', 'expired', 'consumed']);
const ACTION_STATUS = Object.freeze({
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
  expire: 'expired',
  consume: 'consumed',
});
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['approve', 'reject', 'cancel', 'expire']),
  approved: new Set(['consume', 'cancel', 'expire']),
  rejected: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  consumed: new Set(),
});

export class CopilotApprovalStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CopilotApprovalStoreError';
    this.code = code;
    this.status = status;
  }
}

export class CopilotApprovalStore {
  constructor({ rootDir, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!String(rootDir || '').trim()) throw approvalError('COPILOT_APPROVAL_ROOT_REQUIRED', 'Approval root directory is required.');
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.idFactory = idFactory;
  }

  async createApproval(reference, value = {}) {
    const normalized = normalizeCopilotReference(reference);
    const approvalId = requiredCopilotId(value.approvalId || this.idFactory(), 'approval ID');
    const idempotencyKey = normalizeCopilotIdempotencyKey(value.idempotencyKey, 'approval idempotency key');
    const conversationDirectory = resolveCopilotConversationDirectory(this.rootDir, normalized);
    const directory = approvalDirectory(this.rootDir, normalized);
    const filePath = path.join(directory, `${approvalId}.json`);
    const request = {
      runId: requiredCopilotId(value.runId, 'run ID'),
      toolRunId: requiredCopilotId(value.toolRunId, 'tool run ID'),
      toolName: requiredCopilotId(value.toolName, 'tool name'),
      riskLevel: normalizeText(value.riskLevel || 'medium', 40),
      summary: normalizeText(value.summary, 1000),
      arguments: copilotJsonValue(value.arguments || {}, 'approval arguments'),
    };
    const expiresAt = normalizeOptionalDate(value.expiresAt);
    const requestHash = copilotHash({ ...request, expiresAt });

    await ensureConversation(this.rootDir, normalized);
    await mkdir(directory, { recursive: true });
    return withCopilotFileLock(path.join(conversationDirectory, '.store.lock'), async () => {
      const duplicate = await findApprovalByCreateKey(directory, normalized, idempotencyKey);
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) {
          throw approvalError('COPILOT_APPROVAL_CONFLICT', 'Approval idempotency key was already used with a different request.', 409);
        }
        return clone(duplicate);
      }
      const existing = await readCopilotJson(filePath, { allowMissing: true });
      if (existing) {
        validateApproval(existing, normalized);
        if (existing.createIdempotencyKey !== idempotencyKey || existing.requestHash !== requestHash) {
          throw approvalError('COPILOT_APPROVAL_CONFLICT', 'Approval identity is already in use with a different request.', 409);
        }
        return clone(existing);
      }
      const now = isoNow(this.now);
      const approval = {
        schemaVersion: COPILOT_APPROVAL_SCHEMA_VERSION,
        revision: 1,
        approvalId,
        conversationId: normalized.conversationId,
        jobId: normalized.jobId,
        snapshotId: normalized.snapshotId,
        mode: normalized.mode,
        scope: normalized.scope,
        scopeHash: normalized.scopeHash,
        ...request,
        requestHash,
        status: 'pending',
        createIdempotencyKey: idempotencyKey,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        decidedAt: null,
        decisionActor: '',
        decisionReason: '',
        consumedAt: null,
        transitions: [],
      };
      await writeCopilotJsonAtomically(filePath, approval);
      return clone(approval);
    });
  }

  async getApproval(reference, approvalId, { expireDue = false } = {}) {
    const normalized = normalizeCopilotReference(reference);
    const id = requiredCopilotId(approvalId, 'approval ID');
    if (expireDue) await this.expireDueApproval(normalized, id);
    const approval = await readCopilotJson(path.join(approvalDirectory(this.rootDir, normalized), `${id}.json`), { allowMissing: true });
    if (!approval) return null;
    validateApproval(approval, normalized);
    return clone(approval);
  }

  async listApprovals(reference, { status = null } = {}) {
    const normalized = normalizeCopilotReference(reference);
    const directory = approvalDirectory(this.rootDir, normalized);
    let filenames;
    try {
      filenames = await readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (status !== null && !APPROVAL_STATUSES.has(status)) throw approvalError('COPILOT_APPROVAL_STATUS_INVALID', 'Approval status is invalid.');
    const approvals = [];
    for (const filename of filenames.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.json$/u.test(name)).sort()) {
      const approval = await readCopilotJson(path.join(directory, filename));
      validateApproval(approval, normalized);
      if (!status || approval.status === status) approvals.push(approval);
    }
    return approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async transitionApproval(reference, approvalId, value = {}) {
    const normalized = normalizeCopilotReference(reference);
    const id = requiredCopilotId(approvalId, 'approval ID');
    const action = String(value.action || '');
    if (!Object.hasOwn(ACTION_STATUS, action)) throw approvalError('COPILOT_APPROVAL_ACTION_INVALID', 'Approval action is invalid.');
    const idempotencyKey = normalizeCopilotIdempotencyKey(value.idempotencyKey, 'approval transition idempotency key');
    const transition = {
      action,
      idempotencyKey,
      actor: normalizeText(value.actor, 160),
      reason: normalizeText(value.reason, 1000),
      expectedRequestHash: normalizeText(value.expectedRequestHash, 128),
    };
    transition.operationHash = transitionOperationHash(transition);
    const filePath = path.join(approvalDirectory(this.rootDir, normalized), `${id}.json`);
    return withCopilotFileLock(`${filePath}.lock`, async () => {
      const current = await requireApproval(filePath, normalized);
      const duplicate = current.transitions.find((item) => item.idempotencyKey === idempotencyKey);
      if (duplicate) {
        if (duplicate.operationHash !== transition.operationHash) {
          throw approvalError('COPILOT_APPROVAL_IDEMPOTENCY_CONFLICT', 'Approval idempotency key was used with different transition content.', 409);
        }
        return clone(current);
      }
      assertExpectedRevision(current, value.expectedRevision);
      if (transition.expectedRequestHash && transition.expectedRequestHash !== current.requestHash) {
        throw approvalError('COPILOT_APPROVAL_REQUEST_MISMATCH', 'Approval request hash no longer matches the tool request.', 409);
      }

      if (approvalIsDue(current, this.now) && action !== 'expire') {
        const expiryTransition = {
          action: 'expire',
          idempotencyKey: `expiry:${current.approvalId}:${current.expiresAt}`.slice(0, 160),
          actor: 'system',
          reason: 'approval_expired',
        };
        expiryTransition.operationHash = transitionOperationHash(expiryTransition);
        const expired = applyTransition(current, expiryTransition, this.now);
        await writeCopilotJsonAtomically(filePath, expired);
        const error = approvalError('COPILOT_APPROVAL_EXPIRED', 'Approval expired before the requested action.', 409);
        error.approval = clone(expired);
        throw error;
      }

      if (!ALLOWED_TRANSITIONS[current.status].has(action)) {
        throw approvalError(
          'COPILOT_APPROVAL_TRANSITION_INVALID',
          `Approval cannot transition from ${current.status} using ${action}.`,
          409,
        );
      }
      const next = applyTransition(current, transition, this.now);
      await writeCopilotJsonAtomically(filePath, next);
      return clone(next);
    });
  }

  approve(reference, approvalId, value) {
    return this.transitionApproval(reference, approvalId, { ...value, action: 'approve' });
  }

  reject(reference, approvalId, value) {
    return this.transitionApproval(reference, approvalId, { ...value, action: 'reject' });
  }

  cancel(reference, approvalId, value) {
    return this.transitionApproval(reference, approvalId, { ...value, action: 'cancel' });
  }

  consume(reference, approvalId, value) {
    return this.transitionApproval(reference, approvalId, { ...value, action: 'consume' });
  }

  expire(reference, approvalId, value) {
    return this.transitionApproval(reference, approvalId, { ...value, action: 'expire' });
  }

  async expireDueApproval(reference, approvalId) {
    const normalized = normalizeCopilotReference(reference);
    const id = requiredCopilotId(approvalId, 'approval ID');
    const filePath = path.join(approvalDirectory(this.rootDir, normalized), `${id}.json`);
    return withCopilotFileLock(`${filePath}.lock`, async () => {
      const current = await requireApproval(filePath, normalized);
      if (!approvalIsDue(current, this.now) || !ALLOWED_TRANSITIONS[current.status].has('expire')) return clone(current);
      const key = `expiry:${current.approvalId}:${current.expiresAt}`.slice(0, 160);
      const duplicate = current.transitions.find((item) => item.idempotencyKey === key);
      if (duplicate) return clone(current);
      const transition = {
        action: 'expire', idempotencyKey: key, actor: 'system', reason: 'approval_expired',
      };
      transition.operationHash = transitionOperationHash(transition);
      const next = applyTransition(current, transition, this.now);
      await writeCopilotJsonAtomically(filePath, next);
      return clone(next);
    });
  }
}

async function findApprovalByCreateKey(directory, reference, idempotencyKey) {
  let filenames;
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const filename of filenames.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.json$/u.test(name)).sort()) {
    const approval = await readCopilotJson(path.join(directory, filename));
    validateApproval(approval, reference);
    if (approval.createIdempotencyKey === idempotencyKey) return approval;
  }
  return null;
}

function approvalDirectory(rootDir, reference) {
  return path.join(resolveCopilotConversationDirectory(rootDir, reference), 'approvals');
}

async function ensureConversation(rootDir, reference) {
  const conversation = await readCopilotJson(
    path.join(resolveCopilotConversationDirectory(rootDir, reference), 'conversation.json'),
    { allowMissing: true },
  );
  if (!conversation) throw approvalError('COPILOT_CONVERSATION_NOT_FOUND', 'Data Copilot conversation was not found.', 404);
  if (
    conversation.schemaVersion !== DATA_COPILOT_SCHEMA_VERSION
    || conversation.jobId !== reference.jobId
    || conversation.snapshotId !== reference.snapshotId
    || conversation.mode !== reference.mode
    || conversation.scopeHash !== reference.scopeHash
    || conversation.conversationId !== reference.conversationId
  ) {
    throw approvalError('COPILOT_APPROVAL_SCOPE_MISMATCH', 'Approval does not belong to the requested conversation scope.', 409);
  }
}

async function requireApproval(filePath, reference) {
  const approval = await readCopilotJson(filePath, { allowMissing: true });
  if (!approval) throw approvalError('COPILOT_APPROVAL_NOT_FOUND', 'Approval was not found.', 404);
  validateApproval(approval, reference);
  return approval;
}

function validateApproval(value, reference) {
  if (
    value.schemaVersion !== COPILOT_APPROVAL_SCHEMA_VERSION
    || !Number.isInteger(value.revision)
    || value.revision < 1
    || !APPROVAL_STATUSES.has(value.status)
    || !Array.isArray(value.transitions)
  ) {
    throw approvalError('COPILOT_APPROVAL_STATE_INVALID', 'Approval state is invalid.', 500);
  }
  if (
    value.jobId !== reference.jobId
    || value.snapshotId !== reference.snapshotId
    || value.mode !== reference.mode
    || value.scopeHash !== reference.scopeHash
    || value.conversationId !== reference.conversationId
  ) {
    throw approvalError('COPILOT_APPROVAL_SCOPE_MISMATCH', 'Approval does not belong to the requested conversation scope.', 409);
  }
  const expectedRequestHash = copilotHash({
    runId: value.runId,
    toolRunId: value.toolRunId,
    toolName: value.toolName,
    riskLevel: value.riskLevel,
    summary: value.summary,
    arguments: value.arguments,
    expiresAt: value.expiresAt,
  });
  if (
    copilotHash(value.scope) !== value.scopeHash
    || value.requestHash !== expectedRequestHash
    || value.revision !== value.transitions.length + 1
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw approvalError('COPILOT_APPROVAL_STATE_INVALID', 'Approval state integrity check failed.', 500);
  }

  let derivedStatus = 'pending';
  const transitionKeys = new Set();
  for (const [index, transition] of value.transitions.entries()) {
    if (
      transition.sequence !== index + 1
      || !Object.hasOwn(ACTION_STATUS, transition.action)
      || !ALLOWED_TRANSITIONS[derivedStatus].has(transition.action)
      || transition.fromStatus !== derivedStatus
      || transition.toStatus !== ACTION_STATUS[transition.action]
      || transition.operationHash !== transitionOperationHash(transition)
      || transitionKeys.has(transition.idempotencyKey)
      || !Number.isFinite(Date.parse(transition.createdAt))
    ) {
      throw approvalError('COPILOT_APPROVAL_STATE_INVALID', 'Approval transition history is invalid.', 500);
    }
    normalizeCopilotIdempotencyKey(transition.idempotencyKey, 'persisted approval transition idempotency key');
    transitionKeys.add(transition.idempotencyKey);
    derivedStatus = transition.toStatus;
  }
  if (derivedStatus !== value.status) {
    throw approvalError('COPILOT_APPROVAL_STATE_INVALID', 'Approval status does not match its transition history.', 500);
  }
}

function applyTransition(current, transition, nowProvider) {
  const next = clone(current);
  const now = isoNow(nowProvider);
  next.status = ACTION_STATUS[transition.action];
  next.revision += 1;
  next.updatedAt = now;
  next.transitions.push({
    sequence: next.transitions.length + 1,
    action: transition.action,
    fromStatus: current.status,
    toStatus: next.status,
    idempotencyKey: transition.idempotencyKey,
    operationHash: transition.operationHash,
    actor: transition.actor,
    reason: transition.reason,
    expectedRequestHash: transition.expectedRequestHash || '',
    createdAt: now,
  });
  if (['approve', 'reject', 'cancel', 'expire'].includes(transition.action)) {
    next.decidedAt = now;
    next.decisionActor = transition.actor;
    next.decisionReason = transition.reason;
  }
  if (transition.action === 'consume') next.consumedAt = now;
  return next;
}

function transitionOperationHash(value) {
  const operation = {
    action: value.action,
    actor: String(value.actor || ''),
    reason: String(value.reason || ''),
  };
  if (value.expectedRequestHash) operation.expectedRequestHash = String(value.expectedRequestHash);
  return copilotHash(operation);
}

function approvalIsDue(value, nowProvider) {
  if (!value.expiresAt || !['pending', 'approved'].includes(value.status)) return false;
  return Date.parse(value.expiresAt) <= Date.parse(isoNow(nowProvider));
}

function normalizeOptionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw approvalError('COPILOT_APPROVAL_EXPIRY_INVALID', 'Approval expiry is invalid.');
  return date.toISOString();
}

function normalizeText(value, maximum) {
  const text = String(value || '').trim();
  if (text.length > maximum) throw approvalError('COPILOT_APPROVAL_VALUE_INVALID', `Text exceeds ${maximum} characters.`);
  return text;
}

function assertExpectedRevision(current, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (Number(expectedRevision) !== current.revision) {
    const error = approvalError('COPILOT_APPROVAL_REVISION_CONFLICT', 'Approval revision conflict.', 409);
    error.expectedRevision = Number(expectedRevision);
    error.actualRevision = current.revision;
    throw error;
  }
}

function isoNow(provider) {
  const value = provider();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw approvalError('COPILOT_APPROVAL_CLOCK_INVALID', 'Approval clock returned an invalid date.', 500);
  return date.toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function approvalError(code, message, status = 400) {
  return new CopilotApprovalStoreError(code, message, status);
}
