import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalJson,
  createExecutionContext,
  deepFreeze,
  fingerprintExecutionContext,
  normalizeJsonObject,
  normalizeJsonValue,
} from './execution-context.mjs';
import {
  createRuntimeEvent,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from './runtime-event.mjs';

const MIGRATION_VERSION = 2;
const DEFAULT_TTL_MS = 30_000;
const EXECUTION_STEP_STATUSES = new Set([
  'pending', 'claimed', 'running', 'waiting_external',
  'succeeded', 'failed', 'cancelled', 'reconcile_required', 'skipped',
]);
const EXECUTION_EFFECT_STATUSES = new Set([
  'prepared', 'started', 'unknown', 'committed', 'rolled_back', 'reconciled',
]);
const AUTHORITY_GRANT_STATUSES = new Set(['active', 'revoked']);

export class RuntimeV3Repository {
  constructor({ database = null, store = null, rootDir = 'data', filePath = '', now = () => new Date() } = {}) {
    const injectedDatabase = database || store?.database || null;
    this.now = now;
    this.ownsDatabase = !injectedDatabase;
    this.filePath = injectedDatabase
      ? String(store?.filePath || filePath || '')
      : path.resolve(filePath || path.join(rootDir, 'copilot', 'copilot-state.sqlite'));
    if (!injectedDatabase) mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = injectedDatabase || new DatabaseSync(this.filePath);
    this.closed = false;
    this.#migrate();
  }

  describe() {
    this.#assertOpen();
    const migrationVersion = Number(this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM runtime_v3_schema_migrations
    `).get()?.version || 0);
    const journalMode = this.database.prepare('PRAGMA journal_mode').get()?.journal_mode || '';
    return {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      migrationVersion,
      engine: 'sqlite',
      journalMode,
      filePath: this.filePath,
      ownsDatabase: this.ownsDatabase,
    };
  }

  createExecution({ executionId = crypto.randomUUID(), context, kind = 'agent', status = 'queued', metadata = {} } = {}) {
    this.#assertOpen();
    const normalizedContext = createExecutionContext(context);
    const record = {
      executionId: requiredText(executionId, 'executionId'),
      kind: requiredText(kind, 'kind'),
      status: requiredText(status, 'status'),
      context: normalizedContext,
      contextHash: fingerprintExecutionContext(normalizedContext),
      metadata: normalizeJsonObject(metadata, 'metadata'),
    };
    const now = this.#nowIso();

    return this.#transaction(() => {
      const idempotent = this.database.prepare(`
        SELECT * FROM executions WHERE task_id = ? AND idempotency_key = ?
      `).get(normalizedContext.taskId, normalizedContext.idempotencyKey);
      if (idempotent) return this.#resolveExecutionCollision(idempotent, record, 'idempotencyKey');

      const existing = this.database.prepare('SELECT * FROM executions WHERE execution_id = ?').get(record.executionId);
      if (existing) return this.#resolveExecutionCollision(existing, record, 'executionId');

      this.database.prepare(`
        INSERT INTO executions (
          execution_id, task_id, run_id, attempt_id, parent_execution_id, trace_id,
          deadline_at, idempotency_key, context_snapshot_id, kind, status,
          context_json, context_hash, metadata_json, result_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', '{}', ?, ?, '')
      `).run(
        record.executionId,
        normalizedContext.taskId,
        normalizedContext.runId,
        normalizedContext.attemptId,
        normalizedContext.parentExecutionId || '',
        normalizedContext.traceId,
        normalizedContext.deadlineAt,
        normalizedContext.idempotencyKey,
        normalizedContext.contextSnapshotId,
        record.kind,
        record.status,
        canonicalJson(normalizedContext),
        record.contextHash,
        canonicalJson(record.metadata),
        now,
        now,
      );
      return this.getExecution(record.executionId);
    });
  }

  getExecution(executionId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM executions WHERE execution_id = ?')
      .get(requiredText(executionId, 'executionId'));
    return row ? executionRecord(row) : null;
  }

  getExecutionByIdempotencyKey({ taskId, idempotencyKey } = {}) {
    this.#assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM executions WHERE task_id = ? AND idempotency_key = ?
    `).get(requiredText(taskId, 'taskId'), requiredText(idempotencyKey, 'idempotencyKey'));
    return row ? executionRecord(row) : null;
  }

  listExecutions({ taskId = '', runId = '', actorId = '', status = '', limit = 100, order = 'asc' } = {}) {
    this.#assertOpen();
    const filters = [];
    const values = [];
    if (taskId) { filters.push('task_id = ?'); values.push(String(taskId)); }
    if (runId) { filters.push('run_id = ?'); values.push(String(runId)); }
    if (actorId) {
      filters.push("json_extract(context_json, '$.authority.actorId') = ?");
      values.push(String(actorId));
    }
    if (status) { filters.push('status = ?'); values.push(String(status)); }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const maximum = boundedInteger(limit, 100, 1, 1_000);
    const direction = String(order || 'asc').trim().toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') {
      throw repositoryError('RUNTIME_V3_EXECUTION_ORDER_INVALID', 'Execution order must be asc or desc.', 400);
    }
    return this.database.prepare(`
      SELECT * FROM executions${where} ORDER BY created_at ${direction}, execution_id ${direction} LIMIT ?
    `).all(...values, maximum).map(executionRecord);
  }

  updateExecution(executionId, patch = {}) {
    this.#assertOpen();
    const current = this.getExecution(executionId);
    if (!current) throw repositoryError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
    const next = this.#executionPatch(current, patch);
    this.database.prepare(`
      UPDATE executions
      SET status = ?, metadata_json = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
      WHERE execution_id = ?
    `).run(
      next.status,
      canonicalJson(next.metadata),
      canonicalJson(next.result),
      canonicalJson(next.error),
      next.updatedAt,
      next.completedAt,
      current.executionId,
    );
    return this.getExecution(current.executionId);
  }

  /**
   * Applies an execution transition and its durable event in the same SQLite
   * transaction.  New Runtime V3 callers should use this instead of an
   * update followed by appendEvent, which leaves a crash window between the
   * receipt and the event stream.
   */
  transitionExecution(executionId, {
    expectedStatuses = ['queued', 'running', 'waiting'],
    patch = {},
    event = null,
    lease = null,
  } = {}) {
    this.#assertOpen();
    const id = requiredText(executionId, 'executionId');
    const statuses = expectedExecutionStatuses(expectedStatuses);
    const leaseRequirement = lease ? normalizedLeaseRequirement(lease) : null;
    return this.#transaction(() => {
      const current = this.getExecution(id);
      if (!current) throw repositoryError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = this.#executionPatch(current, resolvedPatch);
      const statusPlaceholders = statuses.map(() => '?').join(', ');
      const conditions = ['execution_id = ?', `status IN (${statusPlaceholders})`];
      const values = [
        next.status,
        canonicalJson(next.metadata),
        canonicalJson(next.result),
        canonicalJson(next.error),
        next.updatedAt,
        next.completedAt,
        id,
        ...statuses,
      ];
      if (leaseRequirement) {
        conditions.push(`EXISTS (
          SELECT 1 FROM runtime_leases
          WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
            AND released_at = '' AND expires_at > ?
        )`);
        values.push(
          leaseRequirement.leaseKey,
          leaseRequirement.ownerId,
          leaseRequirement.fencingToken,
          this.#nowIso(),
        );
      }
      const result = this.database.prepare(`
        UPDATE executions
        SET status = ?, metadata_json = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
        WHERE ${conditions.join(' AND ')}
      `).run(...values);
      if (result.changes !== 1) {
        if (leaseRequirement) this.#throwLeaseOrStateConflict(id, statuses, leaseRequirement);
        throw repositoryError('RUNTIME_V3_EXECUTION_STATE_CONFLICT', 'Execution state changed before the transition committed.', 409);
      }
      const execution = this.getExecution(id);
      const appendedEvent = event
        ? this.#appendEventWithinTransaction(this.#eventForExecution(execution, event), {
            expectedSequence: event.expectedSequence,
          })
        : null;
      return deepFreeze({ execution, event: appendedEvent });
    });
  }

  /**
   * Atomically updates a running execution only while the caller still owns
   * its current fencing lease. The lease predicate is part of the SQL UPDATE,
   * rather than a prior read, so an expired worker cannot overwrite a newer
   * worker's terminal receipt in the check-then-write window.
   */
  updateExecutionWithLease(executionId, patch = {}, {
    leaseKey,
    ownerId,
    fencingToken,
    expectedStatuses = ['running'],
  } = {}) {
    this.#assertOpen();
    const key = requiredText(leaseKey, 'leaseKey');
    const owner = requiredText(ownerId, 'ownerId');
    const token = positiveInteger(fencingToken, 'fencingToken');
    const statuses = expectedExecutionStatuses(expectedStatuses);
    const id = requiredText(executionId, 'executionId');

    return this.#transaction(() => {
      const current = this.getExecution(id);
      if (!current) throw repositoryError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
      // Resolve the terminal patch while holding the same SQLite transaction
      // that verifies the fencing lease. This lets callers make a durable
      // cancellation intent win over a concurrent successful completion.
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = this.#executionPatch(current, resolvedPatch);
      const now = this.#nowIso();
      const statusPlaceholders = statuses.map(() => '?').join(', ');
      const result = this.database.prepare(`
        UPDATE executions
        SET status = ?, metadata_json = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
        WHERE execution_id = ?
          AND status IN (${statusPlaceholders})
          AND EXISTS (
            SELECT 1 FROM runtime_leases
            WHERE lease_key = ?
              AND owner_id = ?
              AND fencing_token = ?
              AND released_at = ''
              AND expires_at > ?
          )
      `).run(
        next.status,
        canonicalJson(next.metadata),
        canonicalJson(next.result),
        canonicalJson(next.error),
        next.updatedAt,
        next.completedAt,
        id,
        ...statuses,
        key,
        owner,
        token,
        now,
      );
      if (result.changes !== 1) {
        const latest = this.getExecution(id);
        const lease = this.#getLeaseRow(key);
        const active = leaseRowIsActive(lease, this.#nowDate());
        if (!lease || !active || lease.owner_id !== owner || Number(lease.fencing_token) !== token) {
          throw repositoryError('RUNTIME_V3_EXECUTION_LEASE_STALE', 'Execution lease is stale.', 409);
        }
        throw repositoryError(
          'RUNTIME_V3_EXECUTION_STATE_CONFLICT',
          `Execution ${id} is no longer in an expected state (${statuses.join(', ')}); current state is ${latest?.status || 'missing'}.`,
          409,
        );
      }
      return this.getExecution(id);
    });
  }

  /**
   * Persists a non-terminal control-plane patch without claiming a worker
   * lease. It is intentionally conditional so a remote cancellation request
   * cannot resurrect or mutate an already completed receipt.
   */
  updateExecutionIfStatus(executionId, patch = {}, { expectedStatuses = ['queued', 'running'] } = {}) {
    this.#assertOpen();
    const statuses = expectedExecutionStatuses(expectedStatuses);
    const id = requiredText(executionId, 'executionId');
    return this.#transaction(() => {
      const current = this.getExecution(id);
      if (!current) throw repositoryError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
      // Control-plane decisions such as cancellation must inspect the same
      // row that this transaction updates. A precomputed object patch can
      // otherwise overwrite metadata written by another process immediately
      // before this transaction acquired SQLite's writer lock.
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = this.#executionPatch(current, resolvedPatch);
      const statusPlaceholders = statuses.map(() => '?').join(', ');
      const result = this.database.prepare(`
        UPDATE executions
        SET status = ?, metadata_json = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
        WHERE execution_id = ? AND status IN (${statusPlaceholders})
      `).run(
        next.status,
        canonicalJson(next.metadata),
        canonicalJson(next.result),
        canonicalJson(next.error),
        next.updatedAt,
        next.completedAt,
        id,
        ...statuses,
      );
      return result.changes === 1 ? this.getExecution(id) : null;
    });
  }

  createExecutionStep({
    stepId = crypto.randomUUID(),
    executionId,
    parentStepId = '',
    ordinal = 0,
    kind,
    status = 'pending',
    handlerKey = '',
    effectClass = 'read',
    descriptorVersion = '',
    idempotencyKey,
    inputRef = '',
    inputHash,
    metadata = {},
    resultRef = '',
    error = {},
    attempt = 0,
    maxAttempts = 1,
  } = {}) {
    this.#assertOpen();
    const record = {
      stepId: requiredText(stepId, 'stepId'),
      executionId: requiredText(executionId, 'executionId'),
      parentStepId: optionalText(parentStepId),
      ordinal: nonNegativeInteger(ordinal, 'ordinal'),
      kind: requiredText(kind, 'kind'),
      status: enumValue(status, EXECUTION_STEP_STATUSES, 'status'),
      handlerKey: optionalText(handlerKey),
      effectClass: requiredText(effectClass, 'effectClass'),
      descriptorVersion: optionalText(descriptorVersion),
      idempotencyKey: requiredText(idempotencyKey, 'idempotencyKey'),
      inputRef: optionalText(inputRef),
      inputHash: requiredText(inputHash, 'inputHash'),
      metadata: normalizeJsonObject(metadata, 'metadata'),
      resultRef: optionalText(resultRef),
      error: normalizeJsonObject(error, 'error'),
      attempt: nonNegativeInteger(attempt, 'attempt'),
      maxAttempts: positiveInteger(maxAttempts, 'maxAttempts'),
    };
    const now = this.#nowIso();
    return this.#transaction(() => {
      this.#requireExecution(record.executionId);
      const existingByKey = this.database.prepare(`
        SELECT * FROM execution_steps WHERE execution_id = ? AND idempotency_key = ?
      `).get(record.executionId, record.idempotencyKey);
      if (existingByKey) return this.#resolveStepCollision(existingByKey, record, 'idempotencyKey');
      const existingById = this.database.prepare('SELECT * FROM execution_steps WHERE step_id = ?')
        .get(record.stepId);
      if (existingById) return this.#resolveStepCollision(existingById, record, 'stepId');
      this.database.prepare(`
        INSERT INTO execution_steps (
          step_id, execution_id, parent_step_id, ordinal, kind, status,
          handler_key, effect_class, descriptor_version, idempotency_key,
          input_ref, input_hash, metadata_json, result_ref, error_json,
          attempt, max_attempts, created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')
      `).run(
        record.stepId, record.executionId, record.parentStepId, record.ordinal,
        record.kind, record.status, record.handlerKey, record.effectClass,
        record.descriptorVersion, record.idempotencyKey, record.inputRef,
        record.inputHash, canonicalJson(record.metadata), record.resultRef,
        canonicalJson(record.error), record.attempt, record.maxAttempts, now, now,
      );
      return this.getExecutionStep(record.stepId);
    });
  }

  getExecutionStep(stepId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_steps WHERE step_id = ?')
      .get(requiredText(stepId, 'stepId'));
    return row ? executionStepRecord(row) : null;
  }

  listExecutionSteps({ executionId, status = '', limit = 500 } = {}) {
    this.#assertOpen();
    const filters = ['execution_id = ?'];
    const values = [requiredText(executionId, 'executionId')];
    if (status) {
      filters.push('status = ?');
      values.push(enumValue(status, EXECUTION_STEP_STATUSES, 'status'));
    }
    return this.database.prepare(`
      SELECT * FROM execution_steps
      WHERE ${filters.join(' AND ')}
      ORDER BY ordinal, created_at, step_id
      LIMIT ?
    `).all(...values, boundedInteger(limit, 500, 1, 2_000)).map(executionStepRecord);
  }

  transitionExecutionStep(stepId, {
    expectedStatuses = ['pending', 'claimed', 'running', 'waiting_external'],
    patch = {},
    event = null,
    lease = null,
  } = {}) {
    this.#assertOpen();
    const id = requiredText(stepId, 'stepId');
    const statuses = expectedEnumValues(expectedStatuses, EXECUTION_STEP_STATUSES, 'expectedStatuses');
    const leaseRequirement = lease ? normalizedLeaseRequirement(lease) : null;
    return this.#transaction(() => {
      const current = this.getExecutionStep(id);
      if (!current) throw repositoryError('RUNTIME_V3_STEP_NOT_FOUND', 'Execution step was not found.', 404);
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = executionStepPatch(current, resolvedPatch, this.#nowIso());
      const conditions = ['step_id = ?', `status IN (${statuses.map(() => '?').join(', ')})`];
      const values = [
        next.status, next.resultRef, canonicalJson(next.error), canonicalJson(next.metadata),
        next.attempt, next.startedAt, next.completedAt, next.updatedAt, id, ...statuses,
      ];
      if (leaseRequirement) {
        conditions.push(`EXISTS (
          SELECT 1 FROM runtime_leases
          WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
            AND released_at = '' AND expires_at > ?
        )`);
        values.push(
          leaseRequirement.leaseKey, leaseRequirement.ownerId,
          leaseRequirement.fencingToken, this.#nowIso(),
        );
      }
      const result = this.database.prepare(`
        UPDATE execution_steps
        SET status = ?, result_ref = ?, error_json = ?, metadata_json = ?,
          attempt = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE ${conditions.join(' AND ')}
      `).run(...values);
      if (result.changes !== 1) {
        if (leaseRequirement) this.#throwLeaseOrStateConflict(current.executionId, statuses, leaseRequirement, id);
        throw repositoryError('RUNTIME_V3_STEP_STATE_CONFLICT', 'Execution step state changed before the transition committed.', 409);
      }
      const step = this.getExecutionStep(id);
      const execution = this.#requireExecution(step.executionId);
      const appendedEvent = event
        ? this.#appendEventWithinTransaction(this.#eventForExecution(execution, {
            ...event,
            payload: { ...(event.payload || {}), stepId: step.stepId },
          }), { expectedSequence: event.expectedSequence })
        : null;
      return deepFreeze({ step, event: appendedEvent });
    });
  }

  createExecutionEffect({
    effectId = crypto.randomUUID(),
    executionId,
    stepId = '',
    effectClass,
    requestHash,
    probeKey = '',
    status = 'prepared',
    reconciliationPolicy = 'manual',
    preStateRef = '',
    postStateRef = '',
    receiptRef = '',
    metadata = {},
  } = {}) {
    this.#assertOpen();
    const record = {
      effectId: requiredText(effectId, 'effectId'),
      executionId: requiredText(executionId, 'executionId'),
      stepId: optionalText(stepId),
      effectClass: requiredText(effectClass, 'effectClass'),
      requestHash: requiredText(requestHash, 'requestHash'),
      probeKey: optionalText(probeKey),
      status: enumValue(status, EXECUTION_EFFECT_STATUSES, 'status'),
      reconciliationPolicy: requiredText(reconciliationPolicy, 'reconciliationPolicy'),
      preStateRef: optionalText(preStateRef),
      postStateRef: optionalText(postStateRef),
      receiptRef: optionalText(receiptRef),
      metadata: normalizeJsonObject(metadata, 'metadata'),
    };
    const now = this.#nowIso();
    return this.#transaction(() => {
      this.#requireExecution(record.executionId);
      if (record.stepId) this.#requireStep(record.stepId, record.executionId);
      const existingByHash = this.database.prepare(`
        SELECT * FROM execution_effects WHERE execution_id = ? AND request_hash = ?
      `).get(record.executionId, record.requestHash);
      if (existingByHash) return this.#resolveEffectCollision(existingByHash, record, 'requestHash');
      const existingById = this.database.prepare('SELECT * FROM execution_effects WHERE effect_id = ?')
        .get(record.effectId);
      if (existingById) return this.#resolveEffectCollision(existingById, record, 'effectId');
      this.database.prepare(`
        INSERT INTO execution_effects (
          effect_id, execution_id, step_id, effect_class, request_hash, probe_key,
          status, reconciliation_policy, pre_state_ref, post_state_ref,
          receipt_ref, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.effectId, record.executionId, record.stepId, record.effectClass,
        record.requestHash, record.probeKey, record.status, record.reconciliationPolicy,
        record.preStateRef, record.postStateRef, record.receiptRef,
        canonicalJson(record.metadata), now, now,
      );
      return this.getExecutionEffect(record.effectId);
    });
  }

  getExecutionEffect(effectId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_effects WHERE effect_id = ?')
      .get(requiredText(effectId, 'effectId'));
    return row ? executionEffectRecord(row) : null;
  }

  listExecutionEffects({ executionId, stepId = '', status = '', limit = 500 } = {}) {
    this.#assertOpen();
    const filters = ['execution_id = ?'];
    const values = [requiredText(executionId, 'executionId')];
    if (stepId) { filters.push('step_id = ?'); values.push(String(stepId)); }
    if (status) {
      filters.push('status = ?');
      values.push(enumValue(status, EXECUTION_EFFECT_STATUSES, 'status'));
    }
    return this.database.prepare(`
      SELECT * FROM execution_effects
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at, effect_id
      LIMIT ?
    `).all(...values, boundedInteger(limit, 500, 1, 2_000)).map(executionEffectRecord);
  }

  transitionExecutionEffect(effectId, {
    expectedStatuses = ['prepared', 'started', 'unknown'],
    patch = {},
    lease = null,
  } = {}) {
    this.#assertOpen();
    const id = requiredText(effectId, 'effectId');
    const statuses = expectedEnumValues(expectedStatuses, EXECUTION_EFFECT_STATUSES, 'expectedStatuses');
    const leaseRequirement = lease ? normalizedLeaseRequirement(lease) : null;
    return this.#transaction(() => {
      const current = this.getExecutionEffect(id);
      if (!current) throw repositoryError('RUNTIME_V3_EFFECT_NOT_FOUND', 'Execution effect was not found.', 404);
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = executionEffectPatch(current, resolvedPatch, this.#nowIso());
      const conditions = ['effect_id = ?', `status IN (${statuses.map(() => '?').join(', ')})`];
      const values = [
        next.status, next.preStateRef, next.postStateRef, next.receiptRef,
        canonicalJson(next.metadata), next.updatedAt, id, ...statuses,
      ];
      if (leaseRequirement) {
        conditions.push(`EXISTS (
          SELECT 1 FROM runtime_leases
          WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
            AND released_at = '' AND expires_at > ?
        )`);
        values.push(
          leaseRequirement.leaseKey, leaseRequirement.ownerId,
          leaseRequirement.fencingToken, this.#nowIso(),
        );
      }
      const result = this.database.prepare(`
        UPDATE execution_effects
        SET status = ?, pre_state_ref = ?, post_state_ref = ?, receipt_ref = ?,
          metadata_json = ?, updated_at = ?
        WHERE ${conditions.join(' AND ')}
      `).run(...values);
      if (result.changes !== 1) {
        if (leaseRequirement) this.#throwLeaseOrStateConflict(current.executionId, statuses, leaseRequirement, current.stepId);
        throw repositoryError('RUNTIME_V3_EFFECT_STATE_CONFLICT', 'Execution effect state changed before the transition committed.', 409);
      }
      return this.getExecutionEffect(id);
    });
  }

  createExecutionArtifact({
    artifactId = crypto.randomUUID(),
    executionId,
    stepId = '',
    kind,
    mimeType = 'application/octet-stream',
    contentHash,
    storageRef,
    sizeBytes = 0,
    metadata = {},
  } = {}) {
    this.#assertOpen();
    const record = {
      artifactId: requiredText(artifactId, 'artifactId'),
      executionId: requiredText(executionId, 'executionId'),
      stepId: optionalText(stepId),
      kind: requiredText(kind, 'kind'),
      mimeType: requiredText(mimeType, 'mimeType'),
      contentHash: requiredText(contentHash, 'contentHash'),
      storageRef: requiredText(storageRef, 'storageRef'),
      sizeBytes: nonNegativeInteger(sizeBytes, 'sizeBytes'),
      metadata: normalizeJsonObject(metadata, 'metadata'),
    };
    const now = this.#nowIso();
    return this.#transaction(() => {
      this.#requireExecution(record.executionId);
      if (record.stepId) this.#requireStep(record.stepId, record.executionId);
      const existing = this.database.prepare('SELECT * FROM execution_artifacts WHERE artifact_id = ?')
        .get(record.artifactId);
      if (existing) return this.#resolveArtifactCollision(existing, record);
      this.database.prepare(`
        INSERT INTO execution_artifacts (
          artifact_id, execution_id, step_id, kind, mime_type, content_hash,
          storage_ref, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactId, record.executionId, record.stepId, record.kind,
        record.mimeType, record.contentHash, record.storageRef, record.sizeBytes,
        canonicalJson(record.metadata), now,
      );
      return this.getExecutionArtifact(record.artifactId);
    });
  }

  getExecutionArtifact(artifactId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_artifacts WHERE artifact_id = ?')
      .get(requiredText(artifactId, 'artifactId'));
    return row ? executionArtifactRecord(row) : null;
  }

  listExecutionArtifacts({ executionId, stepId = '', kind = '', limit = 500 } = {}) {
    this.#assertOpen();
    const filters = ['execution_id = ?'];
    const values = [requiredText(executionId, 'executionId')];
    if (stepId) { filters.push('step_id = ?'); values.push(String(stepId)); }
    if (kind) { filters.push('kind = ?'); values.push(String(kind)); }
    return this.database.prepare(`
      SELECT * FROM execution_artifacts
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at, artifact_id
      LIMIT ?
    `).all(...values, boundedInteger(limit, 500, 1, 2_000)).map(executionArtifactRecord);
  }

  createAuthorityGrant({
    grantId = crypto.randomUUID(),
    executionId,
    actorId,
    projectId,
    workspaceId,
    worktreeId = '',
    status = 'active',
    policyHash,
    capabilities = {},
    maxAgentDepth = 0,
    expiresAt,
    metadata = {},
  } = {}) {
    this.#assertOpen();
    const record = {
      grantId: requiredText(grantId, 'grantId'),
      executionId: requiredText(executionId, 'executionId'),
      actorId: requiredText(actorId, 'actorId'),
      projectId: requiredText(projectId, 'projectId'),
      workspaceId: requiredText(workspaceId, 'workspaceId'),
      worktreeId: optionalText(worktreeId),
      status: enumValue(status, AUTHORITY_GRANT_STATUSES, 'status'),
      policyHash: requiredText(policyHash, 'policyHash'),
      capabilities: normalizeJsonValue(capabilities, 'capabilities'),
      maxAgentDepth: nonNegativeInteger(maxAgentDepth, 'maxAgentDepth'),
      expiresAt: requiredTimestamp(expiresAt, 'expiresAt'),
      metadata: normalizeJsonObject(metadata, 'metadata'),
    };
    const now = this.#nowIso();
    return this.#transaction(() => {
      this.#requireExecution(record.executionId);
      const existingByPolicy = this.database.prepare(`
        SELECT * FROM execution_authority_grants WHERE execution_id = ? AND policy_hash = ?
      `).get(record.executionId, record.policyHash);
      if (existingByPolicy) return this.#resolveGrantCollision(existingByPolicy, record, 'policyHash');
      const existingById = this.database.prepare('SELECT * FROM execution_authority_grants WHERE grant_id = ?')
        .get(record.grantId);
      if (existingById) return this.#resolveGrantCollision(existingById, record, 'grantId');
      this.database.prepare(`
        INSERT INTO execution_authority_grants (
          grant_id, execution_id, actor_id, project_id, workspace_id, worktree_id,
          status, policy_hash, capabilities_json, max_agent_depth, expires_at,
          revoked_at, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(
        record.grantId, record.executionId, record.actorId, record.projectId,
        record.workspaceId, record.worktreeId, record.status, record.policyHash,
        canonicalJson(record.capabilities), record.maxAgentDepth, record.expiresAt,
        canonicalJson(record.metadata), now, now,
      );
      return this.getAuthorityGrant(record.grantId);
    });
  }

  getAuthorityGrant(grantId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_authority_grants WHERE grant_id = ?')
      .get(requiredText(grantId, 'grantId'));
    return row ? authorityGrantRecord(row) : null;
  }

  listAuthorityGrants({ executionId, status = '', limit = 100 } = {}) {
    this.#assertOpen();
    const filters = ['execution_id = ?'];
    const values = [requiredText(executionId, 'executionId')];
    if (status) {
      filters.push('status = ?');
      values.push(enumValue(status, AUTHORITY_GRANT_STATUSES, 'status'));
    }
    return this.database.prepare(`
      SELECT * FROM execution_authority_grants
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at, grant_id
      LIMIT ?
    `).all(...values, boundedInteger(limit, 100, 1, 1_000)).map(authorityGrantRecord);
  }

  revokeAuthorityGrant(grantId, { reason = '' } = {}) {
    this.#assertOpen();
    const id = requiredText(grantId, 'grantId');
    return this.#transaction(() => {
      const current = this.getAuthorityGrant(id);
      if (!current) throw repositoryError('RUNTIME_V3_AUTHORITY_GRANT_NOT_FOUND', 'Authority grant was not found.', 404);
      if (current.status === 'revoked') return current;
      const now = this.#nowIso();
      this.database.prepare(`
        UPDATE execution_authority_grants
        SET status = 'revoked', revoked_at = ?, metadata_json = ?, updated_at = ?
        WHERE grant_id = ? AND status = 'active'
      `).run(now, canonicalJson({ ...current.metadata, revokeReason: optionalText(reason) }), now, id);
      return this.getAuthorityGrant(id);
    });
  }

  appendEvent(value = {}, { expectedSequence } = {}) {
    this.#assertOpen();
    return this.#transaction(() => this.#appendEventWithinTransaction(value, { expectedSequence }));
  }

  #appendEventWithinTransaction(value = {}, { expectedSequence } = {}) {
    const occurredAtProvided = value.occurredAt !== undefined && value.occurredAt !== null && String(value.occurredAt).trim() !== '';
    const input = {
      ...value,
      eventId: value.eventId || crypto.randomUUID(),
      occurredAt: value.occurredAt || this.#nowIso(),
    };
    const streamId = requiredText(input.streamId, 'streamId');
    const eventId = requiredText(input.eventId, 'eventId');

    const duplicate = this.database.prepare('SELECT * FROM runtime_events WHERE event_id = ?').get(eventId);
    if (duplicate) return this.#resolveEventCollision(duplicate, input, { occurredAtProvided });

    const currentSequence = Number(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_events WHERE stream_id = ?
    `).get(streamId)?.sequence || 0);
    if (expectedSequence !== undefined) {
      const expected = nonNegativeInteger(expectedSequence, 'expectedSequence');
      if (expected !== currentSequence) {
        throw repositoryError(
          'RUNTIME_V3_EVENT_SEQUENCE_CONFLICT',
          `Expected stream ${streamId} at sequence ${expected}, but current sequence is ${currentSequence}.`,
          409,
        );
      }
    }
    const nextSequence = currentSequence + 1;
    if (!Number.isSafeInteger(nextSequence)) {
      throw repositoryError('RUNTIME_V3_EVENT_SEQUENCE_EXHAUSTED', `Stream ${streamId} exhausted safe integer sequences.`, 409);
    }
    if (value.sequence !== undefined && Number(value.sequence) !== nextSequence) {
      throw repositoryError(
        'RUNTIME_V3_EVENT_SEQUENCE_CONFLICT',
        `Requested sequence ${value.sequence} is not the next sequence ${nextSequence} for stream ${streamId}.`,
        409,
      );
    }
    const event = createRuntimeEvent({ ...input, streamId, sequence: nextSequence });
    this.database.prepare(`
      INSERT INTO runtime_events (
        event_id, stream_id, sequence, schema_version, type, occurred_at,
        task_id, run_id, agent_id, attempt_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.streamId,
      event.sequence,
      event.schemaVersion,
      event.type,
      event.occurredAt,
      event.taskId,
      event.runId,
      event.agentId || '',
      event.attemptId || '',
      canonicalJson(event.payload),
    );
    return event;
  }

  getEvent(eventId) {
    this.#assertOpen();
    const row = this.database.prepare('SELECT * FROM runtime_events WHERE event_id = ?')
      .get(requiredText(eventId, 'eventId'));
    return row ? runtimeEventRecord(row) : null;
  }

  listEvents({ streamId, afterSequence = 0, limit = 500 } = {}) {
    this.#assertOpen();
    const sequence = nonNegativeInteger(afterSequence, 'afterSequence');
    const maximum = boundedInteger(limit, 500, 1, 1_000);
    return this.database.prepare(`
      SELECT * FROM runtime_events
      WHERE stream_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(requiredText(streamId, 'streamId'), sequence, maximum).map(runtimeEventRecord);
  }

  latestSequence(streamId) {
    this.#assertOpen();
    return Number(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_events WHERE stream_id = ?
    `).get(requiredText(streamId, 'streamId'))?.sequence || 0);
  }

  acquireLease({ leaseKey, ownerId, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.#assertOpen();
    const key = requiredText(leaseKey, 'leaseKey');
    const owner = requiredText(ownerId, 'ownerId');
    const ttl = positiveInteger(ttlMs, 'ttlMs');
    return this.#transaction(() => {
      const now = this.#nowDate();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttl).toISOString();
      const row = this.database.prepare('SELECT * FROM runtime_leases WHERE lease_key = ?').get(key);
      if (!row) {
        this.database.prepare(`
          INSERT INTO runtime_leases (
            lease_key, owner_id, fencing_token, acquired_at, renewed_at, expires_at, released_at
          ) VALUES (?, ?, 1, ?, ?, ?, '')
        `).run(key, owner, nowIso, nowIso, expiresAt);
        return leaseResult('acquired', this.#getLeaseRow(key), now);
      }

      const active = leaseRowIsActive(row, now);
      if (active && row.owner_id !== owner) return leaseResult('contended', row, now);
      if (active && row.owner_id === owner) {
        this.database.prepare(`
          UPDATE runtime_leases SET renewed_at = ?, expires_at = ?, released_at = '' WHERE lease_key = ?
        `).run(nowIso, expiresAt, key);
        return leaseResult('renewed', this.#getLeaseRow(key), now);
      }

      const fencingToken = nextFencingToken(row.fencing_token, key);
      this.database.prepare(`
        UPDATE runtime_leases
        SET owner_id = ?, fencing_token = ?, acquired_at = ?, renewed_at = ?, expires_at = ?, released_at = ''
        WHERE lease_key = ?
      `).run(owner, fencingToken, nowIso, nowIso, expiresAt, key);
      return leaseResult('acquired', this.#getLeaseRow(key), now);
    });
  }

  renewLease({ leaseKey, ownerId, fencingToken, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.#assertOpen();
    const key = requiredText(leaseKey, 'leaseKey');
    const owner = requiredText(ownerId, 'ownerId');
    const token = positiveInteger(fencingToken, 'fencingToken');
    const ttl = positiveInteger(ttlMs, 'ttlMs');
    return this.#transaction(() => {
      const now = this.#nowDate();
      const row = this.#getLeaseRow(key);
      if (!row || !leaseRowIsActive(row, now) || row.owner_id !== owner || Number(row.fencing_token) !== token) {
        return leaseResult('stale', row, now);
      }
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttl).toISOString();
      this.database.prepare(`
        UPDATE runtime_leases SET renewed_at = ?, expires_at = ?
        WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
      `).run(nowIso, expiresAt, key, owner, token);
      return leaseResult('renewed', this.#getLeaseRow(key), now);
    });
  }

  releaseLease({ leaseKey, ownerId, fencingToken } = {}) {
    this.#assertOpen();
    const key = requiredText(leaseKey, 'leaseKey');
    const owner = requiredText(ownerId, 'ownerId');
    const token = positiveInteger(fencingToken, 'fencingToken');
    return this.#transaction(() => {
      const now = this.#nowDate();
      const row = this.#getLeaseRow(key);
      if (!row || !leaseRowIsActive(row, now) || row.owner_id !== owner || Number(row.fencing_token) !== token) {
        return leaseResult('stale', row, now);
      }
      const nowIso = now.toISOString();
      this.database.prepare(`
        UPDATE runtime_leases
        SET owner_id = '', renewed_at = ?, expires_at = ?, released_at = ?
        WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
      `).run(nowIso, nowIso, nowIso, key, owner, token);
      return leaseResult('released', this.#getLeaseRow(key), now);
    });
  }

  getLease(leaseKey) {
    this.#assertOpen();
    const row = this.#getLeaseRow(requiredText(leaseKey, 'leaseKey'));
    return row ? leaseRecord(row, this.#nowDate()) : null;
  }

  close() {
    if (this.closed) return;
    if (this.ownsDatabase) this.database.close();
    this.closed = true;
  }

  #migrate() {
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (this.ownsDatabase) this.database.exec('PRAGMA journal_mode = WAL;');
    this.#transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_v3_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS executions (
          execution_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          parent_execution_id TEXT NOT NULL DEFAULT '',
          trace_id TEXT NOT NULL,
          deadline_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          context_snapshot_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'agent',
          status TEXT NOT NULL DEFAULT 'queued',
          context_json TEXT NOT NULL,
          context_hash TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT NOT NULL DEFAULT 'null',
          error_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT NOT NULL DEFAULT '',
          UNIQUE(task_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS executions_run_created
          ON executions(run_id, created_at, execution_id);
        CREATE INDEX IF NOT EXISTS executions_status_updated
          ON executions(status, updated_at, execution_id);
        CREATE TABLE IF NOT EXISTS runtime_events (
          event_id TEXT PRIMARY KEY,
          stream_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          schema_version INTEGER NOT NULL CHECK(schema_version = 3),
          type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          task_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          attempt_id TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(stream_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS runtime_events_run_sequence
          ON runtime_events(run_id, stream_id, sequence);
        CREATE INDEX IF NOT EXISTS runtime_events_task_occurred
          ON runtime_events(task_id, occurred_at, event_id);
        CREATE TABLE IF NOT EXISTS runtime_leases (
          lease_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT '',
          fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
          acquired_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT NOT NULL DEFAULT ''
        );
      `);
      this.database.prepare(`
        INSERT OR IGNORE INTO runtime_v3_schema_migrations (version, name, applied_at)
        VALUES (1, 'runtime-v3-foundation', ?)
      `).run(this.#nowIso());
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS execution_steps (
          step_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          parent_step_id TEXT NOT NULL DEFAULT '',
          ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          handler_key TEXT NOT NULL DEFAULT '',
          effect_class TEXT NOT NULL DEFAULT 'read',
          descriptor_version TEXT NOT NULL DEFAULT '',
          idempotency_key TEXT NOT NULL,
          input_ref TEXT NOT NULL DEFAULT '',
          input_hash TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          result_ref TEXT NOT NULL DEFAULT '',
          error_json TEXT NOT NULL DEFAULT '{}',
          attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT '',
          completed_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
          UNIQUE(execution_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS execution_steps_execution_ordinal
          ON execution_steps(execution_id, ordinal, step_id);
        CREATE INDEX IF NOT EXISTS execution_steps_status_updated
          ON execution_steps(status, updated_at, step_id);

        CREATE TABLE IF NOT EXISTS execution_effects (
          effect_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          step_id TEXT NOT NULL DEFAULT '',
          effect_class TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          probe_key TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'prepared',
          reconciliation_policy TEXT NOT NULL DEFAULT 'manual',
          pre_state_ref TEXT NOT NULL DEFAULT '',
          post_state_ref TEXT NOT NULL DEFAULT '',
          receipt_ref TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
          UNIQUE(execution_id, request_hash)
        );
        CREATE INDEX IF NOT EXISTS execution_effects_execution_step
          ON execution_effects(execution_id, step_id, created_at, effect_id);
        CREATE INDEX IF NOT EXISTS execution_effects_status_updated
          ON execution_effects(status, updated_at, effect_id);

        CREATE TABLE IF NOT EXISTS execution_artifacts (
          artifact_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          step_id TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          storage_ref TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS execution_artifacts_execution_step
          ON execution_artifacts(execution_id, step_id, created_at, artifact_id);

        CREATE TABLE IF NOT EXISTS execution_authority_grants (
          grant_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          policy_hash TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          max_agent_depth INTEGER NOT NULL DEFAULT 0 CHECK(max_agent_depth >= 0),
          expires_at TEXT NOT NULL,
          revoked_at TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
          UNIQUE(execution_id, policy_hash)
        );
        CREATE INDEX IF NOT EXISTS execution_authority_grants_execution_status
          ON execution_authority_grants(execution_id, status, expires_at, grant_id);
      `);
      this.database.prepare(`
        INSERT OR IGNORE INTO runtime_v3_schema_migrations (version, name, applied_at)
        VALUES (?, 'runtime-v3-ledger', ?)
      `).run(MIGRATION_VERSION, this.#nowIso());
    });
  }

  #resolveExecutionCollision(row, input, field) {
    if (row.context_hash === input.contextHash && row.kind === input.kind) return executionRecord(row);
    throw repositoryError(
      'RUNTIME_V3_EXECUTION_IDEMPOTENCY_COLLISION',
      `${field} is already bound to a different execution context.`,
      409,
    );
  }

  #resolveEventCollision(row, input, { occurredAtProvided = true } = {}) {
    const existing = runtimeEventRecord(row);
    const comparable = createRuntimeEvent({
      ...input,
      occurredAt: occurredAtProvided ? input.occurredAt : existing.occurredAt,
      sequence: existing.sequence,
    });
    if (canonicalJson(existing) === canonicalJson(comparable)) return existing;
    throw repositoryError(
      'RUNTIME_V3_EVENT_ID_COLLISION',
      `eventId ${existing.eventId} is already bound to a different event.`,
      409,
    );
  }

  #resolveStepCollision(row, input, field) {
    const existing = executionStepRecord(row);
    const same = existing.executionId === input.executionId
      && existing.parentStepId === input.parentStepId
      && existing.ordinal === input.ordinal
      && existing.kind === input.kind
      && existing.handlerKey === input.handlerKey
      && existing.effectClass === input.effectClass
      && existing.descriptorVersion === input.descriptorVersion
      && existing.idempotencyKey === input.idempotencyKey
      && existing.inputRef === input.inputRef
      && existing.inputHash === input.inputHash;
    if (same) return existing;
    throw repositoryError(
      'RUNTIME_V3_STEP_IDEMPOTENCY_COLLISION',
      `${field} is already bound to a different execution step.`,
      409,
    );
  }

  #resolveEffectCollision(row, input, field) {
    const existing = executionEffectRecord(row);
    const same = existing.executionId === input.executionId
      && existing.stepId === input.stepId
      && existing.effectClass === input.effectClass
      && existing.requestHash === input.requestHash
      && existing.probeKey === input.probeKey
      && existing.reconciliationPolicy === input.reconciliationPolicy;
    if (same) return existing;
    throw repositoryError(
      'RUNTIME_V3_EFFECT_IDEMPOTENCY_COLLISION',
      `${field} is already bound to a different execution effect.`,
      409,
    );
  }

  #resolveArtifactCollision(row, input) {
    const existing = executionArtifactRecord(row);
    const same = existing.executionId === input.executionId
      && existing.stepId === input.stepId
      && existing.kind === input.kind
      && existing.mimeType === input.mimeType
      && existing.contentHash === input.contentHash
      && existing.storageRef === input.storageRef
      && existing.sizeBytes === input.sizeBytes;
    if (same) return existing;
    throw repositoryError(
      'RUNTIME_V3_ARTIFACT_ID_COLLISION',
      'artifactId is already bound to a different artifact.',
      409,
    );
  }

  #resolveGrantCollision(row, input, field) {
    const existing = authorityGrantRecord(row);
    const same = existing.executionId === input.executionId
      && existing.actorId === input.actorId
      && existing.projectId === input.projectId
      && existing.workspaceId === input.workspaceId
      && existing.worktreeId === input.worktreeId
      && existing.policyHash === input.policyHash
      && canonicalJson(existing.capabilities) === canonicalJson(input.capabilities)
      && existing.maxAgentDepth === input.maxAgentDepth
      && existing.expiresAt === input.expiresAt;
    if (same) return existing;
    throw repositoryError(
      'RUNTIME_V3_AUTHORITY_GRANT_COLLISION',
      `${field} is already bound to a different authority grant.`,
      409,
    );
  }

  #requireExecution(executionId) {
    const execution = this.getExecution(executionId);
    if (!execution) throw repositoryError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
    return execution;
  }

  #requireStep(stepId, executionId) {
    const step = this.getExecutionStep(stepId);
    if (!step || step.executionId !== executionId) {
      throw repositoryError('RUNTIME_V3_STEP_NOT_FOUND', 'Execution step was not found for this execution.', 404);
    }
    return step;
  }

  #eventForExecution(execution, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw repositoryError('RUNTIME_V3_TRANSITION_EVENT_INVALID', 'Transition event must be an object.');
    }
    return {
      ...value,
      streamId: value.streamId || `execution:${execution.executionId}`,
      taskId: value.taskId || execution.context.taskId,
      runId: value.runId || execution.context.runId,
      attemptId: value.attemptId || execution.context.attemptId,
      payload: value.payload || {},
    };
  }

  #throwLeaseOrStateConflict(executionId, statuses, leaseRequirement, resourceId = executionId) {
    const leaseRow = this.#getLeaseRow(leaseRequirement.leaseKey);
    const active = leaseRowIsActive(leaseRow, this.#nowDate());
    if (!leaseRow || !active || leaseRow.owner_id !== leaseRequirement.ownerId
      || Number(leaseRow.fencing_token) !== leaseRequirement.fencingToken) {
      throw repositoryError('RUNTIME_V3_EXECUTION_LEASE_STALE', 'Execution lease is stale.', 409);
    }
    throw repositoryError(
      'RUNTIME_V3_EXECUTION_STATE_CONFLICT',
      `Resource ${resourceId} for execution ${executionId} is no longer in an expected state (${statuses.join(', ')}).`,
      409,
    );
  }

  #getLeaseRow(leaseKey) {
    return this.database.prepare('SELECT * FROM runtime_leases WHERE lease_key = ?').get(leaseKey) || null;
  }

  #executionPatch(current, patch) {
    return {
      status: patch.status === undefined ? current.status : requiredText(patch.status, 'status'),
      metadata: patch.metadata === undefined ? current.metadata : normalizeJsonObject(patch.metadata, 'metadata'),
      result: patch.result === undefined ? current.result : normalizeJsonValue(patch.result, 'result'),
      error: patch.error === undefined ? current.error : normalizeJsonObject(patch.error, 'error'),
      completedAt: patch.completedAt === undefined
        ? current.completedAt
        : optionalTimestamp(patch.completedAt, 'completedAt'),
      updatedAt: this.#nowIso(),
    };
  }

  #transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #nowDate() {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw repositoryError('RUNTIME_V3_CLOCK_INVALID', 'Repository clock returned an invalid date.');
    return date;
  }

  #nowIso() {
    return this.#nowDate().toISOString();
  }

  #assertOpen() {
    if (this.closed) throw repositoryError('RUNTIME_V3_REPOSITORY_CLOSED', 'RuntimeV3Repository is closed.', 409);
  }
}

export function createRuntimeV3Repository(options = {}) {
  return new RuntimeV3Repository(options);
}

function executionRecord(row) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    executionId: row.execution_id,
    kind: row.kind,
    status: row.status,
    context: createExecutionContext(parseJson(row.context_json, {})),
    contextHash: row.context_hash,
    metadata: normalizeJsonObject(parseJson(row.metadata_json, {}), 'metadata'),
    result: normalizeJsonValue(parseJson(row.result_json, null), 'result'),
    error: normalizeJsonObject(parseJson(row.error_json, {}), 'error'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
}

function executionStepRecord(row) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    stepId: row.step_id,
    executionId: row.execution_id,
    parentStepId: row.parent_step_id,
    ordinal: Number(row.ordinal),
    kind: row.kind,
    status: row.status,
    handlerKey: row.handler_key,
    effectClass: row.effect_class,
    descriptorVersion: row.descriptor_version,
    idempotencyKey: row.idempotency_key,
    inputRef: row.input_ref,
    inputHash: row.input_hash,
    metadata: normalizeJsonObject(parseJson(row.metadata_json, {}), 'metadata'),
    resultRef: row.result_ref,
    error: normalizeJsonObject(parseJson(row.error_json, {}), 'error'),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function executionEffectRecord(row) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    effectId: row.effect_id,
    executionId: row.execution_id,
    stepId: row.step_id,
    effectClass: row.effect_class,
    requestHash: row.request_hash,
    probeKey: row.probe_key,
    status: row.status,
    reconciliationPolicy: row.reconciliation_policy,
    preStateRef: row.pre_state_ref,
    postStateRef: row.post_state_ref,
    receiptRef: row.receipt_ref,
    metadata: normalizeJsonObject(parseJson(row.metadata_json, {}), 'metadata'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function executionArtifactRecord(row) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    artifactId: row.artifact_id,
    executionId: row.execution_id,
    stepId: row.step_id,
    kind: row.kind,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    storageRef: row.storage_ref,
    sizeBytes: Number(row.size_bytes),
    metadata: normalizeJsonObject(parseJson(row.metadata_json, {}), 'metadata'),
    createdAt: row.created_at,
  });
}

function authorityGrantRecord(row) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    grantId: row.grant_id,
    executionId: row.execution_id,
    actorId: row.actor_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    worktreeId: row.worktree_id,
    status: row.status,
    policyHash: row.policy_hash,
    capabilities: normalizeJsonValue(parseJson(row.capabilities_json, {}), 'capabilities'),
    maxAgentDepth: Number(row.max_agent_depth),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    metadata: normalizeJsonObject(parseJson(row.metadata_json, {}), 'metadata'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function runtimeEventRecord(row) {
  return createRuntimeEvent({
    schemaVersion: Number(row.schema_version),
    eventId: row.event_id,
    streamId: row.stream_id,
    sequence: Number(row.sequence),
    type: row.type,
    occurredAt: row.occurred_at,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    attemptId: row.attempt_id,
    payload: parseJson(row.payload_json, {}),
  });
}

function leaseResult(state, row, now) {
  const lease = row ? leaseRecord(row, now) : null;
  return deepFreeze({
    acquired: state === 'acquired' || state === 'renewed',
    renewed: state === 'renewed',
    released: state === 'released',
    state,
    lease,
    leaseKey: lease?.leaseKey || '',
    ownerId: lease?.ownerId || '',
    fencingToken: lease?.fencingToken || 0,
    expiresAt: lease?.expiresAt || '',
  });
}

function leaseRecord(row, now) {
  return deepFreeze({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    leaseKey: row.lease_key,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    active: leaseRowIsActive(row, now),
  });
}

function leaseRowIsActive(row, now) {
  return Boolean(row?.owner_id) && !row.released_at && Date.parse(row.expires_at) > now.getTime();
}

function nextFencingToken(value, leaseKey) {
  const current = Number(value);
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw repositoryError('RUNTIME_V3_LEASE_TOKEN_EXHAUSTED', `Lease ${leaseKey} exhausted fencing tokens.`, 409);
  }
  return current + 1;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function optionalTimestamp(value, name) {
  if (value === '' || value === null) return '';
  const timestamp = new Date(requiredText(value, name));
  if (!Number.isFinite(timestamp.getTime())) throw repositoryError('RUNTIME_V3_TIMESTAMP_INVALID', `${name} must be an ISO-8601 timestamp.`);
  return timestamp.toISOString();
}

function requiredTimestamp(value, name) {
  const timestamp = optionalTimestamp(value, name);
  if (!timestamp) throw repositoryError('RUNTIME_V3_TIMESTAMP_REQUIRED', `${name} is required.`);
  return timestamp;
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requiredText(value, name) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw repositoryError('RUNTIME_V3_VALUE_REQUIRED', `${name} is required.`);
  return text;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw repositoryError('RUNTIME_V3_INTEGER_INVALID', `${name} must be a non-negative safe integer.`);
  }
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw repositoryError('RUNTIME_V3_INTEGER_INVALID', `${name} must be a positive safe integer.`);
  }
  return number;
}

function expectedExecutionStatuses(value) {
  const source = Array.isArray(value) ? value : [value];
  const statuses = [...new Set(source.map((status) => requiredText(status, 'expectedStatuses')))];
  if (!statuses.length) {
    throw repositoryError('RUNTIME_V3_EXECUTION_STATE_REQUIRED', 'expectedStatuses must not be empty.');
  }
  return statuses;
}

function expectedEnumValues(value, allowed, name) {
  const source = Array.isArray(value) ? value : [value];
  const values = [...new Set(source.map((entry) => enumValue(entry, allowed, name)))];
  if (!values.length) throw repositoryError('RUNTIME_V3_STATE_REQUIRED', `${name} must not be empty.`);
  return values;
}

function enumValue(value, allowed, name) {
  const text = requiredText(value, name);
  if (!allowed.has(text)) {
    throw repositoryError('RUNTIME_V3_STATE_INVALID', `${name} must be one of: ${[...allowed].join(', ')}.`);
  }
  return text;
}

function normalizedLeaseRequirement(value = {}) {
  return {
    leaseKey: requiredText(value.leaseKey, 'leaseKey'),
    ownerId: requiredText(value.ownerId, 'ownerId'),
    fencingToken: positiveInteger(value.fencingToken, 'fencingToken'),
  };
}

function executionStepPatch(current, patch = {}, updatedAt) {
  return {
    status: patch.status === undefined ? current.status : enumValue(patch.status, EXECUTION_STEP_STATUSES, 'status'),
    resultRef: patch.resultRef === undefined ? current.resultRef : optionalText(patch.resultRef),
    error: patch.error === undefined ? current.error : normalizeJsonObject(patch.error, 'error'),
    metadata: patch.metadata === undefined ? current.metadata : normalizeJsonObject(patch.metadata, 'metadata'),
    attempt: patch.attempt === undefined ? current.attempt : nonNegativeInteger(patch.attempt, 'attempt'),
    startedAt: patch.startedAt === undefined ? current.startedAt : optionalTimestamp(patch.startedAt, 'startedAt'),
    completedAt: patch.completedAt === undefined ? current.completedAt : optionalTimestamp(patch.completedAt, 'completedAt'),
    updatedAt,
  };
}

function executionEffectPatch(current, patch = {}, updatedAt) {
  return {
    status: patch.status === undefined ? current.status : enumValue(patch.status, EXECUTION_EFFECT_STATUSES, 'status'),
    preStateRef: patch.preStateRef === undefined ? current.preStateRef : optionalText(patch.preStateRef),
    postStateRef: patch.postStateRef === undefined ? current.postStateRef : optionalText(patch.postStateRef),
    receiptRef: patch.receiptRef === undefined ? current.receiptRef : optionalText(patch.receiptRef),
    metadata: patch.metadata === undefined ? current.metadata : normalizeJsonObject(patch.metadata, 'metadata'),
    updatedAt,
  };
}

function repositoryError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
