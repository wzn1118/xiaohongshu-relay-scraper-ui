import crypto from 'node:crypto';

import { normalizeJsonValue } from './runtime-v3/execution-context.mjs';
import { createRuntimeV3Repository } from './runtime-v3/repository.mjs';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'reconcile_required']);

/**
 * Durable worker for Runtime V3 executions.
 *
 * The repository deliberately exposes small primitives (execution records,
 * ordered events, and fencing leases). This class composes those primitives
 * into the lifecycle used by a local worker without adding another persistence
 * layer. A handler is process-local, while its execution record and recovery
 * decision remain durable.
 */
export class ExecutionDispatcher {
  constructor({
    repository = null,
    rootDir = 'data',
    workerId = `worker-${process.pid}`,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    emit = () => {},
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    retryPolicy = null,
    idempotencyPolicy = null,
    handlers = null,
  } = {}) {
    this.repository = repository || createRuntimeV3Repository({ rootDir, now });
    this.ownsRepository = !repository;
    this.workerId = requiredText(workerId, 'workerId');
    this.now = now;
    this.idFactory = typeof idFactory === 'function' ? idFactory : () => crypto.randomUUID();
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.leaseTtlMs = positiveInteger(leaseTtlMs, 'leaseTtlMs');
    this.retryPolicy = normalizePolicy(retryPolicy, 'retryPolicy');
    this.idempotencyPolicy = normalizePolicy(idempotencyPolicy, 'idempotencyPolicy');
    this.handlers = new Map();
    this.active = new Map();
    this.closed = false;

    if (handlers instanceof Map) {
      for (const [kind, definition] of handlers.entries()) this.#registerDefinition(kind, definition);
    } else if (handlers && typeof handlers === 'object') {
      for (const [kind, definition] of Object.entries(handlers)) this.#registerDefinition(kind, definition);
    }
  }

  describe() {
    return Object.freeze({
      schemaVersion: 1,
      kind: 'runtime_v3_execution_dispatcher',
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      activeExecutions: this.active.size,
      handlerKinds: [...this.handlers.keys()].sort(),
      states: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'reconcile_required'],
      repository: this.repository?.describe?.() || null,
    });
  }

  registerHandler(kind, handler, options = {}) {
    this.#assertOpen();
    const name = requiredText(kind, 'kind');
    if (typeof handler !== 'function') {
      throw dispatcherError('RUNTIME_V3_HANDLER_REQUIRED', 'handler must be a function.');
    }
    const definition = Object.freeze({
      handler,
      effectClass: normalizeEffectClass(options.effectClass, options.idempotent),
      idempotencyPolicy: normalizePolicy(options.idempotencyPolicy ?? options.idempotency, 'idempotencyPolicy'),
      retryPolicy: normalizePolicy(options.retryPolicy, 'retryPolicy'),
      maxRetries: optionalNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries'),
    });
    this.handlers.set(name, definition);
    return () => this.handlers.delete(name);
  }

  unregisterHandler(kind) {
    this.#assertOpen();
    return this.handlers.delete(requiredText(kind, 'kind'));
  }

  /**
   * Creates a durable queued execution. Supplying a handler is a convenience
   * for local callers; after a restart the same kind must be registered again.
   */
  enqueue({
    executionId = '',
    context,
    kind = 'agent',
    metadata = {},
    handler = null,
    handlerOptions = {},
    handlerKey = '',
    effectClass = '',
    idempotent = undefined,
    maxRetries = undefined,
  } = {}) {
    this.#assertOpen();
    const requestedKind = requiredText(kind, 'kind');
    const key = String(handlerKey || requestedKind).trim() || requestedKind;
    if (handler !== null && handler !== undefined) {
      this.registerHandler(key, handler, handlerOptions);
    }
    const definition = this.handlers.get(key);
    const selectedEffectClass = normalizeEffectClass(
      effectClass || metadata?.effectClass || definition?.effectClass,
      idempotent ?? metadata?.idempotent,
    );
    const selectedMaxRetries = maxRetries === undefined
      ? optionalNonNegativeInteger(metadata?.dispatcher?.maxRetries, definition?.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries')
      : optionalNonNegativeInteger(maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries');
    const id = String(executionId || this.idFactory()).trim();
    if (!id) throw dispatcherError('RUNTIME_V3_EXECUTION_ID_REQUIRED', 'executionId must not be empty.');

    const prior = this.repository.getExecution(id)
      || this.repository.getExecutionByIdempotencyKey({
        taskId: requiredText(context?.taskId, 'context.taskId'),
        idempotencyKey: requiredText(context?.idempotencyKey, 'context.idempotencyKey'),
      });
    const record = this.repository.createExecution({
      executionId: id,
      context,
      kind: requestedKind,
      status: 'queued',
      metadata: withDispatcherMetadata(metadata, {
        handlerKey: key,
        effectClass: selectedEffectClass,
        maxRetries: selectedMaxRetries,
        retryCount: existingRetryCount(metadata),
        leaseKey: executionLeaseKey(id),
      }),
    });
    if (!prior && record.status === 'queued') {
      this.#appendEvent(record, 'execution.queued', {
        executionId: record.executionId,
        kind: record.kind,
        handlerKey: key,
        effectClass: selectedEffectClass,
      });
    }
    return record;
  }

  get(executionId) {
    this.#assertOpen();
    return this.repository.getExecution(requiredText(executionId, 'executionId'));
  }

  list({ taskId = '', runId = '', status = '', kind = '', limit = 100 } = {}) {
    this.#assertOpen();
    return this.repository.listExecutions({ taskId, runId, status, limit })
      .filter((execution) => !kind || execution.kind === kind);
  }

  /** Claim the next eligible execution using a per-execution fencing lease. */
  claimNext({
    taskId = '',
    runId = '',
    kind = '',
    statuses = ['queued'],
    includeReconcileRequired = false,
    leaseTtlMs = this.leaseTtlMs,
    scanLimit = 100,
  } = {}) {
    this.#assertOpen();
    const candidates = this.#claimCandidates({
      taskId,
      runId,
      kind,
      statuses: claimableStatuses(statuses, includeReconcileRequired),
      scanLimit,
    });
    for (const execution of candidates) {
      const claim = this.#claimExecution(execution.executionId, {
        statuses: claimableStatuses(statuses, includeReconcileRequired),
        leaseTtlMs,
      });
      if (claim) return claim;
    }
    return null;
  }

  claimQueued({ limit = 1, ...options } = {}) {
    this.#assertOpen();
    const maximum = positiveInteger(limit, 'limit');
    const claimed = [];
    for (let index = 0; index < maximum; index += 1) {
      const next = this.claimNext(options);
      if (!next) break;
      claimed.push(next);
    }
    return claimed;
  }

  claim(executionId, { statuses = ['queued'], includeReconcileRequired = false, leaseTtlMs = this.leaseTtlMs } = {}) {
    this.#assertOpen();
    return this.#claimExecution(requiredText(executionId, 'executionId'), {
      statuses: claimableStatuses(statuses, includeReconcileRequired),
      leaseTtlMs,
    });
  }

  /** Renew the fencing lease held by this worker and persist a heartbeat. */
  heartbeat(executionOrClaim, { leaseTtlMs = this.leaseTtlMs } = {}) {
    this.#assertOpen();
    const executionId = executionIdOf(executionOrClaim);
    const expectedFencingToken = fencingTokenOf(executionOrClaim);
    const execution = this.get(executionId);
    if (!execution) throw dispatcherError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
    const state = dispatcherState(execution);
    if (expectedFencingToken !== null && Number(state.fencingToken) !== expectedFencingToken) {
      return Object.freeze({ renewed: false, state: 'stale', execution, lease: null });
    }
    if (!state.leaseKey || !state.fencingToken || state.workerId !== this.workerId) {
      return Object.freeze({ renewed: false, state: 'stale', execution, lease: null });
    }
    const lease = this.repository.renewLease({
      leaseKey: state.leaseKey,
      ownerId: this.workerId,
      fencingToken: state.fencingToken,
      ttlMs: positiveInteger(leaseTtlMs, 'leaseTtlMs'),
    });
    if (!lease.renewed) {
      this.#appendEvent(execution, 'execution.lease_lost', {
        executionId: execution.executionId,
        leaseKey: state.leaseKey,
        fencingToken: state.fencingToken,
      });
      return Object.freeze({ renewed: false, state: lease.state, execution, lease: lease.lease || null });
    }
    // The lease is the heartbeat authority. Do not rewrite the execution
    // metadata here: another worker may have persisted a cancellation request
    // between the initial ownership read and this renewal. Re-reading after
    // the fenced lease renewal preserves that request for the active handler.
    const refreshed = this.get(execution.executionId) || execution;
    this.#appendEvent(refreshed, 'execution.heartbeat', {
      executionId: refreshed.executionId,
      fencingToken: state.fencingToken,
      expiresAt: lease.expiresAt,
    });
    return Object.freeze({ renewed: true, state: lease.state, execution: refreshed, lease: lease.lease || null });
  }

  /**
   * Execute a claim owned by this worker. The promise always resolves with the
   * persisted terminal/current record unless throwOnError is explicitly set.
   */
  async execute(executionOrClaim, {
    handlerKey = '',
    signal = null,
    throwOnError = false,
    heartbeatIntervalMs = 0,
    includeReconcileRequired = false,
  } = {}) {
    this.#assertOpen();
    const executionId = executionIdOf(executionOrClaim);
    let execution = this.get(executionId);
    let expectedFencingToken = fencingTokenOf(executionOrClaim);
    if (!execution) throw dispatcherError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
    if (execution.status === 'reconcile_required' && !includeReconcileRequired) {
      throw dispatcherError(
        'RUNTIME_V3_EXECUTION_RECONCILE_REQUIRED',
        'Execution requires explicit reconciliation before it can run again.',
        409,
      );
    }
    if (TERMINAL_STATUSES.has(execution.status)
      && !(execution.status === 'reconcile_required' && includeReconcileRequired)) return execution;
    if (execution.status === 'queued' || execution.status === 'reconcile_required') {
      const claim = this.claim(executionId, {
        includeReconcileRequired: execution.status === 'reconcile_required',
      });
      if (!claim) throw dispatcherError('RUNTIME_V3_EXECUTION_UNAVAILABLE', 'Execution is claimed by another worker.', 409, { retryable: true });
      execution = claim.execution;
      expectedFencingToken = claim.fencingToken;
    }
    this.#assertOwned(execution, expectedFencingToken);
    const existing = this.active.get(executionId);
    if (existing) return existing.promise;

    const operation = this.#run(execution, { handlerKey, signal, throwOnError, heartbeatIntervalMs });
    this.active.set(executionId, { promise: operation });
    try {
      return await operation;
    } finally {
      this.active.delete(executionId);
    }
  }

  complete(executionOrClaim, result = null) {
    this.#assertOpen();
    const ownership = this.#executionForMutation(executionOrClaim);
    const { execution } = ownership;
    if (TERMINAL_STATUSES.has(execution.status)) return execution;
    // Resolve the outcome inside the fenced repository transaction. A user
    // cancellation can arrive while an adapter is returning a late success;
    // the durable cancellation intent must win over that late completion.
    const completed = this.#updateOwned(ownership, (current) => {
      const cancellation = cancellationRequest(current);
      if (cancellation) {
        return {
          status: 'cancelled',
          result: null,
          error: cancellationError(cancellation.reason, 'cancel_requested'),
          completedAt: this.#nowIso(),
        };
      }
      return {
        status: 'succeeded',
        result: jsonValue(result),
        error: {},
        completedAt: this.#nowIso(),
      };
    });
    const cancelled = completed.status === 'cancelled';
    this.#appendEvent(completed, cancelled ? 'execution.cancelled' : 'execution.completed', {
      executionId: completed.executionId,
      status: completed.status,
      ...(cancelled ? { reason: truncateText(completed.error?.message || 'cancelled', 2_000) } : {}),
    });
    this.#release(ownership);
    return completed;
  }

  /**
   * Records a cooperative cancellation while this worker still owns the
   * fencing lease.  Handlers receive an AbortSignal, but only the dispatcher
   * is allowed to publish the terminal state and release that lease.
   */
  cancel(executionOrClaim, { reason = 'cancelled' } = {}) {
    this.#assertOpen();
    const ownership = this.#executionForMutation(executionOrClaim);
    const { execution } = ownership;
    if (TERMINAL_STATUSES.has(execution.status)) return execution;
    const cancelled = this.#updateOwned(ownership, {
      status: 'cancelled',
      error: {
        code: 'RUNTIME_V3_EXECUTION_CANCELLED',
        message: truncateText(reason, 2_000),
        status: 499,
        retryable: false,
        reason: 'cancelled',
      },
      completedAt: this.#nowIso(),
    });
    this.#appendEvent(cancelled, 'execution.cancelled', {
      executionId: cancelled.executionId,
      status: cancelled.status,
      reason: truncateText(reason, 2_000),
    });
    this.#release(ownership);
    return cancelled;
  }

  /**
   * Terminalizes a currently owned execution as reconcile_required. This is
   * deliberately separate from fail(): a reconciliation probe can itself
   * have side effects and must never be silently converted into a retry.
   */
  reconcile(executionOrClaim, {
    reason = 'reconcile_required',
    error = null,
    preserveUnknownEffect = false,
  } = {}) {
    this.#assertOpen();
    const ownership = this.#executionForMutation(executionOrClaim);
    const { execution } = ownership;
    if (TERMINAL_STATUSES.has(execution.status)) return execution;
    const storedError = error
      ? errorRecord(error, reason)
      : {
        code: 'RUNTIME_V3_EXECUTION_RECONCILE_REQUIRED',
        message: truncateText(reason || 'Execution requires reconciliation.', 2_000),
        status: 409,
        retryable: false,
        reason,
    };
    const reconciled = this.#updateOwned(ownership, (current) => {
      // A shutdown timeout means the adapter may still have committed a
      // non-idempotent effect after observing cancellation. Preserve that
      // uncertainty for reconciliation instead of reporting a false cancel.
      const cancellation = preserveUnknownEffect === true
        ? null
        : cancellationRequest(current);
      if (cancellation) {
        return {
          status: 'cancelled',
          result: null,
          error: cancellationError(cancellation.reason, 'cancel_requested'),
          completedAt: this.#nowIso(),
        };
      }
      return {
        status: 'reconcile_required',
        result: null,
        error: storedError,
        completedAt: this.#nowIso(),
      };
    });
    const eventType = reconciled.status === 'cancelled'
      ? 'execution.cancelled'
      : 'execution.reconcile_required';
    this.#appendEvent(reconciled, eventType, {
      executionId: reconciled.executionId,
      status: reconciled.status,
      reason: reconciled.status === 'cancelled' ? 'cancel_requested' : reason,
      error: eventError(reconciled.error || storedError),
    });
    this.#release(ownership);
    return reconciled;
  }

  async fail(executionOrClaim, error, {
    retryPolicy = undefined,
    idempotencyPolicy = undefined,
    reason = 'handler_failed',
    allowRetry = true,
  } = {}) {
    this.#assertOpen();
    const ownership = this.#executionForMutation(executionOrClaim);
    const { execution } = ownership;
    if (TERMINAL_STATUSES.has(execution.status)) return execution;
    const storedError = errorRecord(error, reason);
    const decision = allowRetry
      ? await this.#recoveryDecision(execution, {
        reason,
        error: storedError,
        retryPolicy,
        idempotencyPolicy,
        retryOnDefault: false,
      })
      : { status: 'failed', idempotent: false, retryCount: existingRetryCount(execution.metadata) };
    // A handler returned a known failure, rather than disappearing mid-effect.
    // Idempotent work can therefore retain an ordinary failed receipt. An
    // unknown non-idempotent effect remains explicitly reconcilable.
    const nextStatus = decision.status === 'queued'
      ? 'queued'
      : decision.status === 'reconcile_required' && !decision.idempotent
        ? 'reconcile_required'
        : 'failed';
    const next = this.#updateOwned(ownership, (current) => {
      // A cancellation request can be persisted by another worker after this
      // handler started but before it publishes its failure. Resolve that race
      // inside the fenced update so a requested cancellation always wins.
      const cancellation = cancellationRequest(current);
      if (cancellation) {
        return {
          status: 'cancelled',
          result: null,
          error: cancellationError(cancellation.reason, 'cancel_requested'),
          completedAt: this.#nowIso(),
        };
      }
      return {
        status: nextStatus,
        metadata: withDispatcherMetadata(current.metadata, {
          ...dispatcherState(current),
          retryCount: decision.status === 'queued' ? decision.retryCount + 1 : decision.retryCount,
          lastErrorAt: this.#nowIso(),
        }),
        error: storedError,
        completedAt: nextStatus === 'queued' ? '' : this.#nowIso(),
      };
    });
    const eventType = next.status === 'queued'
      ? 'execution.requeued'
      : next.status === 'reconcile_required'
        ? 'execution.reconcile_required'
        : next.status === 'cancelled'
          ? 'execution.cancelled'
        : 'execution.failed';
    this.#appendEvent(next, eventType, {
      executionId: next.executionId,
      status: next.status,
      reason: next.status === 'cancelled' ? 'cancel_requested' : reason,
      retryCount: dispatcherState(next).retryCount,
      error: eventError(next.error || storedError),
    });
    this.#release(ownership);
    return next;
  }

  /**
   * Reclaims orphaned running executions. Only an idempotent operation with a
   * retry allowance returns to queued; every other orphan is retained for
   * reconciliation instead of being executed again blindly.
   */
  async recoverExpired({
    limit = 100,
    retryPolicy = undefined,
    idempotencyPolicy = undefined,
  } = {}) {
    this.#assertOpen();
    const maximum = positiveInteger(limit, 'limit');
    const candidates = this.repository.listExecutions({ status: 'running', limit: maximum });
    const recovered = [];
    for (const candidate of candidates) {
      const priorLease = this.repository.getLease(executionLeaseKey(candidate.executionId));
      if (priorLease?.active) continue;

      const leaseKey = executionLeaseKey(candidate.executionId);
      const recoveryLease = this.repository.acquireLease({
        leaseKey,
        ownerId: this.workerId,
        ttlMs: this.leaseTtlMs,
      });
      if (!recoveryLease.acquired) continue;
      try {
        const fresh = this.get(candidate.executionId);
        if (!fresh || fresh.status !== 'running') continue;
        const cancellation = cancellationRequest(fresh);
        if (cancellation) {
          const cancelled = this.repository.updateExecutionWithLease(fresh.executionId, {
            status: 'cancelled',
            error: {
              code: 'RUNTIME_V3_EXECUTION_CANCELLED',
              message: truncate(cancellation.reason || 'cancelled', 2_000),
              status: 499,
              retryable: false,
              reason: 'cancel_requested_after_worker_loss',
            },
            completedAt: this.#nowIso(),
          }, {
            leaseKey,
            ownerId: this.workerId,
            fencingToken: recoveryLease.fencingToken,
            expectedStatuses: ['running'],
          });
          this.#appendEvent(cancelled, 'execution.cancelled', {
            executionId: cancelled.executionId,
            status: cancelled.status,
            reason: truncate(cancellation.reason || 'cancelled', 2_000),
          });
          recovered.push(cancelled);
          continue;
        }
        const decision = await this.#recoveryDecision(fresh, {
          reason: 'lease_expired',
          retryPolicy,
          idempotencyPolicy,
          retryOnDefault: true,
        });
        const error = errorRecord(
          decision.status === 'queued'
            ? { code: 'RUNTIME_V3_EXECUTION_REQUEUED', message: 'An expired idempotent execution was requeued.' }
            : { code: 'RUNTIME_V3_EXECUTION_RECONCILE_REQUIRED', message: 'An expired execution requires reconciliation before retry.' },
          'lease_expired',
        );
        const next = this.repository.updateExecutionWithLease(fresh.executionId, (current) => {
          // The retry policy can take time to resolve. Re-read cancellation
          // intent under the fenced write so that a request arriving during
          // that policy evaluation cannot be erased by stale metadata or
          // accidentally requeue the command.
          const cancellation = cancellationRequest(current);
          if (cancellation) {
            return {
              status: 'cancelled',
              result: null,
              error: cancellationError(cancellation.reason, 'cancel_requested_after_worker_loss'),
              completedAt: this.#nowIso(),
            };
          }
          return {
            status: decision.status,
            metadata: withDispatcherMetadata(current.metadata, {
              ...dispatcherState(current),
              workerId: this.workerId,
              leaseKey,
              fencingToken: recoveryLease.fencingToken,
              recoveredAt: this.#nowIso(),
              recoveryReason: 'lease_expired',
              retryCount: decision.status === 'queued' ? decision.retryCount + 1 : decision.retryCount,
            }),
            error,
            completedAt: '',
          };
        }, {
          leaseKey,
          ownerId: this.workerId,
          fencingToken: recoveryLease.fencingToken,
          expectedStatuses: ['running'],
        });
        const terminalCancellation = cancellationRequest(next);
        const cancelled = next.status === 'cancelled';
        this.#appendEvent(next, cancelled
          ? 'execution.cancelled'
          : decision.status === 'queued'
            ? 'execution.requeued'
            : 'execution.reconcile_required', {
          executionId: next.executionId,
          status: next.status,
          reason: cancelled ? truncate(terminalCancellation?.reason || 'cancelled', 2_000) : 'lease_expired',
          effectClass: effectClassFor(fresh),
          idempotent: decision.idempotent,
          retryCount: dispatcherState(next).retryCount,
        });
        recovered.push(next);
      } catch (error) {
        // A concurrent worker may have claimed or completed the record while
        // a slow recovery policy was running. Its fenced state wins.
        if (!isLeaseContention(error)) throw error;
      } finally {
        this.repository.releaseLease({
          leaseKey,
          ownerId: this.workerId,
          fencingToken: recoveryLease.fencingToken,
        });
      }
    }
    return recovered;
  }

  /** One bounded dispatcher pass, suitable for an HTTP worker or scheduler. */
  async dispatch({
    limit = 1,
    recover = true,
    recovery = {},
    ...claimOptions
  } = {}) {
    this.#assertOpen();
    const maximum = positiveInteger(limit, 'limit');
    const recovered = recover ? await this.recoverExpired(recovery) : [];
    const executions = [];
    for (let index = 0; index < maximum; index += 1) {
      const claim = this.claimNext(claimOptions);
      if (!claim) break;
      executions.push(await this.execute(claim));
    }
    return Object.freeze({ recovered, executions });
  }

  drain(options = {}) {
    return this.dispatch(options);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsRepository) this.repository?.close?.();
    this.active.clear();
  }

  async #run(execution, { handlerKey, signal, throwOnError, heartbeatIntervalMs }) {
    const state = dispatcherState(execution);
    const key = String(handlerKey || state.handlerKey || execution.kind).trim();
    const definition = this.handlers.get(key);
    this.#appendEvent(execution, 'execution.started', {
      executionId: execution.executionId,
      kind: execution.kind,
      handlerKey: key,
      attempt: Number(state.attempt || existingRetryCount(execution.metadata) + 1),
    });
    if (!definition) {
      const error = dispatcherError('RUNTIME_V3_HANDLER_NOT_FOUND', `No handler is registered for "${key}".`, 404);
      const failed = await this.fail(execution, error, { allowRetry: false });
      if (throwOnError) throw error;
      return failed;
    }

    const controller = new AbortController();
    const abortForward = () => controller.abort(signal?.reason || new Error('parent_aborted'));
    if (signal?.aborted) abortForward();
    signal?.addEventListener?.('abort', abortForward, { once: true });
    const interval = optionalNonNegativeInteger(heartbeatIntervalMs, 0, 'heartbeatIntervalMs');
    const beat = () => {
      const heartbeat = this.heartbeat(execution);
      const cancellation = cancellationRequest(heartbeat.execution);
      if (cancellation) controller.abort(new Error(cancellation.reason || 'cancelled'));
      if (!heartbeat.renewed) controller.abort(new Error('dispatcher_lease_lost'));
      return heartbeat;
    };
    const timer = interval > 0
      ? setInterval(() => {
        try { beat(); } catch { /* Recovery handles a lost lease. */ }
      }, interval)
      : null;
    try {
      const result = await definition.handler({
        execution,
        context: execution.context,
        signal: controller.signal,
        dispatcher: this,
        heartbeat: beat,
        emit: (payload) => this.#appendEvent(this.get(execution.executionId) || execution, 'execution.progress', {
          executionId: execution.executionId,
          payload: jsonValue(payload),
        }),
      });
      return this.complete(execution, result);
    } catch (error) {
      try {
        const failed = controller.signal.aborted
          ? this.cancel(execution, { reason: abortReason(controller.signal.reason) })
          : await this.fail(execution, error);
        if (throwOnError) throw error;
        return failed;
      } catch (failure) {
        if (throwOnError) throw error;
        // A fenced-off worker must not overwrite a successor's receipt. The
        // recovery controller owns the eventual reconciliation of that record.
        return this.get(execution.executionId) || execution;
      }
    } finally {
      if (timer) clearInterval(timer);
      signal?.removeEventListener?.('abort', abortForward);
    }
  }

  #claimCandidates({ taskId, runId, kind, statuses, scanLimit }) {
    const maximum = positiveInteger(scanLimit, 'scanLimit');
    const deduplicated = new Map();
    for (const status of statuses) {
      for (const execution of this.repository.listExecutions({ taskId, runId, status, limit: maximum })) {
        if (!kind || execution.kind === kind) deduplicated.set(execution.executionId, execution);
      }
    }
    return [...deduplicated.values()].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.executionId.localeCompare(right.executionId)
    ));
  }

  #claimExecution(executionId, { statuses, leaseTtlMs }) {
    const initial = this.get(executionId);
    if (!initial || !statuses.includes(initial.status)) return null;
    const leaseKey = executionLeaseKey(initial.executionId);
    const lease = this.repository.acquireLease({
      leaseKey,
      ownerId: this.workerId,
      ttlMs: positiveInteger(leaseTtlMs, 'leaseTtlMs'),
    });
    if (!lease.acquired) return null;
    const fresh = this.get(initial.executionId);
    if (!fresh || !statuses.includes(fresh.status)) {
      this.repository.releaseLease({ leaseKey, ownerId: this.workerId, fencingToken: lease.fencingToken });
      return null;
    }
    let running;
    try {
      running = this.repository.updateExecutionWithLease(fresh.executionId, (current) => {
        // A remote actor can persist cancellation after the read above but
        // before the fenced transition. Merge against transaction-current
        // metadata and terminalize that cancellation instead of losing it.
        const cancellation = cancellationRequest(current);
        if (cancellation) {
          return {
            status: 'cancelled',
            result: null,
            error: cancellationError(cancellation.reason, 'cancel_requested_before_claim'),
            completedAt: this.#nowIso(),
          };
        }
        const priorState = dispatcherState(current);
        return {
          status: 'running',
          metadata: withDispatcherMetadata(current.metadata, {
            ...priorState,
            handlerKey: priorState.handlerKey || current.kind,
            effectClass: effectClassFor(current),
            leaseKey,
            workerId: this.workerId,
            fencingToken: lease.fencingToken,
            claimedAt: this.#nowIso(),
            heartbeatAt: this.#nowIso(),
            attempt: existingRetryCount(current.metadata) + 1,
          }),
          error: {},
          completedAt: '',
        };
      }, {
        leaseKey,
        ownerId: this.workerId,
        fencingToken: lease.fencingToken,
        expectedStatuses: statuses,
      });
    } catch (error) {
      this.repository.releaseLease({ leaseKey, ownerId: this.workerId, fencingToken: lease.fencingToken });
      if (isLeaseContention(error)) return null;
      throw error;
    }
    if (running.status === 'cancelled') {
      const cancellation = cancellationRequest(running);
      this.#appendEvent(running, 'execution.cancelled', {
        executionId: running.executionId,
        status: running.status,
        reason: truncateText(cancellation?.reason || 'cancelled', 2_000),
      });
      this.repository.releaseLease({ leaseKey, ownerId: this.workerId, fencingToken: lease.fencingToken });
      return null;
    }
    this.#appendEvent(running, 'execution.claimed', {
      executionId: running.executionId,
      workerId: this.workerId,
      fencingToken: lease.fencingToken,
      priorStatus: fresh.status,
    });
    return claimRecord(running, lease, this.workerId);
  }

  #executionForMutation(executionOrClaim) {
    const executionId = executionIdOf(executionOrClaim);
    const execution = this.get(executionId);
    if (!execution) throw dispatcherError('RUNTIME_V3_EXECUTION_NOT_FOUND', 'Execution was not found.', 404);
    const expectedFencingToken = fencingTokenOf(executionOrClaim);
    if (TERMINAL_STATUSES.has(execution.status)) {
      return { execution, fencingToken: expectedFencingToken };
    }
    this.#assertOwned(execution, expectedFencingToken);
    return {
      execution,
      fencingToken: Number(dispatcherState(execution).fencingToken),
    };
  }

  #assertOwned(execution, expectedFencingToken = null) {
    if (execution.status !== 'running') {
      throw dispatcherError('RUNTIME_V3_EXECUTION_NOT_RUNNING', 'Execution is not running.', 409);
    }
    const state = dispatcherState(execution);
    if (!state.leaseKey || state.workerId !== this.workerId || !state.fencingToken) {
      throw dispatcherError('RUNTIME_V3_EXECUTION_LEASE_NOT_OWNED', 'Execution is not owned by this dispatcher.', 409);
    }
    if (expectedFencingToken !== null && Number(state.fencingToken) !== expectedFencingToken) {
      throw dispatcherError('RUNTIME_V3_EXECUTION_LEASE_STALE', 'Execution fencing token is stale.', 409, { retryable: true });
    }
    const lease = this.repository.getLease(state.leaseKey);
    if (!lease?.active || lease.ownerId !== this.workerId || lease.fencingToken !== Number(state.fencingToken)) {
      throw dispatcherError('RUNTIME_V3_EXECUTION_LEASE_STALE', 'Execution lease is stale.', 409, { retryable: true });
    }
  }

  #updateOwned(ownership, patch) {
    const { execution, fencingToken } = ownership;
    const state = dispatcherState(execution);
    return this.repository.updateExecutionWithLease(execution.executionId, patch, {
      leaseKey: state.leaseKey,
      ownerId: this.workerId,
      fencingToken,
      expectedStatuses: ['running'],
    });
  }

  #release(ownership) {
    const { execution, fencingToken } = ownership;
    const state = dispatcherState(execution);
    if (!state.leaseKey || !fencingToken || state.workerId !== this.workerId) return null;
    return this.repository.releaseLease({
      leaseKey: state.leaseKey,
      ownerId: this.workerId,
      fencingToken,
    });
  }

  async #recoveryDecision(execution, {
    reason,
    error = null,
    retryPolicy = undefined,
    idempotencyPolicy = undefined,
    retryOnDefault = true,
  } = {}) {
    const state = dispatcherState(execution);
    const definition = this.handlers.get(String(state.handlerKey || execution.kind));
    const retryCount = existingRetryCount(execution.metadata);
    const maxRetries = optionalNonNegativeInteger(state.maxRetries, definition?.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries');
    let idempotent = false;
    let requested = false;
    try {
      idempotent = await resolveIdempotency(
        idempotencyPolicy === undefined ? (definition?.idempotencyPolicy || this.idempotencyPolicy) : idempotencyPolicy,
        execution,
        { reason, error, retryCount, maxRetries },
      );
      const selectedRetryPolicy = retryPolicy === undefined ? (definition?.retryPolicy || this.retryPolicy) : retryPolicy;
      const retryResult = selectedRetryPolicy
        ? await invokePolicy(selectedRetryPolicy, { execution, reason, error, idempotent, retryCount, maxRetries })
        : (retryOnDefault && idempotent && retryCount < maxRetries);
      requested = retryDecision(retryResult);
    } catch {
      // A policy fault must never turn an unknown side effect into a retry.
      idempotent = false;
      requested = false;
    }
    const canRetry = idempotent && retryCount < maxRetries && requested;
    return Object.freeze({
      status: canRetry ? 'queued' : 'reconcile_required',
      idempotent,
      retryCount,
      maxRetries,
    });
  }

  #appendEvent(execution, type, payload) {
    try {
      const event = this.repository.appendEvent({
        streamId: `run:${execution.context.runId}`,
        type,
        occurredAt: this.#nowIso(),
        taskId: execution.context.taskId,
        runId: execution.context.runId,
        attemptId: execution.context.attemptId,
        payload: jsonValue(payload),
      });
      try { this.emit(event); } catch { /* Observers cannot affect durable work. */ }
      return event;
    } catch {
      // The execution state is authoritative. A delivery mirror failure must
      // not cause a local side effect to be replayed.
      return null;
    }
  }

  #nowIso() {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw dispatcherError('RUNTIME_V3_DISPATCHER_CLOCK_INVALID', 'Dispatcher clock returned an invalid date.', 500);
    }
    return date.toISOString();
  }

  #registerDefinition(kind, definition) {
    if (typeof definition === 'function') {
      this.registerHandler(kind, definition);
      return;
    }
    this.registerHandler(kind, definition?.handler, definition || {});
  }

  #assertOpen() {
    if (this.closed) throw dispatcherError('RUNTIME_V3_DISPATCHER_CLOSED', 'Execution dispatcher is closed.', 409);
  }
}

export function createExecutionDispatcher(options = {}) {
  return new ExecutionDispatcher(options);
}

export class ExecutionDispatcherError extends Error {
  constructor(code, message, status = 500, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExecutionDispatcherError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function executionLeaseKey(executionId) {
  return `runtime-v3:execution:${requiredText(executionId, 'executionId')}`;
}

function claimRecord(execution, lease, workerId) {
  return Object.freeze({
    ...execution,
    execution,
    lease: lease.lease || null,
    workerId,
    fencingToken: lease.fencingToken,
  });
}

function dispatcherState(execution) {
  const value = execution?.metadata?.dispatcher;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cancellationRequest(execution) {
  const state = dispatcherState(execution);
  if (!state.cancelRequestedAt) return null;
  return {
    requestedAt: String(state.cancelRequestedAt),
    reason: String(state.cancelReason || 'cancelled'),
  };
}

function cancellationError(reason, codeReason = 'cancelled') {
  return {
    code: 'RUNTIME_V3_EXECUTION_CANCELLED',
    message: truncateText(reason || 'cancelled', 2_000),
    status: 499,
    retryable: false,
    reason: codeReason,
  };
}

function withDispatcherMetadata(metadata, state) {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return {
    ...base,
    effectClass: normalizeEffectClass(state.effectClass || base.effectClass, base.idempotent),
    dispatcher: {
      ...dispatcherState({ metadata: base }),
      ...compactObject(state),
    },
  };
}

function existingRetryCount(metadata) {
  return optionalNonNegativeInteger(metadata?.dispatcher?.retryCount, 0, 'retryCount');
}

function effectClassFor(execution) {
  return normalizeEffectClass(execution?.metadata?.effectClass, execution?.metadata?.idempotent);
}

function normalizeEffectClass(value, idempotent = undefined) {
  const effectClass = String(value || '').trim();
  if (effectClass === 'read' || effectClass === 'idempotent_write' || effectClass === 'non_idempotent') return effectClass;
  return idempotent === true ? 'idempotent_write' : 'non_idempotent';
}

function claimableStatuses(statuses, includeReconcileRequired) {
  const source = Array.isArray(statuses) ? statuses : [statuses];
  const normalized = [...new Set(source.map((status) => String(status || '').trim()).filter(Boolean))];
  if (includeReconcileRequired && !normalized.includes('reconcile_required')) normalized.push('reconcile_required');
  if (!normalized.length) normalized.push('queued');
  return normalized.filter((status) => status === 'queued' || status === 'reconcile_required');
}

function executionIdOf(value) {
  if (typeof value === 'string') return requiredText(value, 'executionId');
  return requiredText(value?.executionId || value?.execution?.executionId, 'executionId');
}

function fencingTokenOf(value) {
  if (!value || typeof value === 'string') return null;
  const raw = value.fencingToken ?? dispatcherState(value.execution || value).fencingToken;
  const token = Number(raw);
  return Number.isInteger(token) && token > 0 ? token : null;
}

function normalizePolicy(value, name) {
  if (value === null || value === undefined || typeof value === 'function' || typeof value === 'boolean') return value;
  throw dispatcherError('RUNTIME_V3_POLICY_INVALID', `${name} must be a function, boolean, or null.`);
}

async function resolveIdempotency(policy, execution, details) {
  if (policy !== null && policy !== undefined) {
    const value = await invokePolicy(policy, { execution, ...details });
    if (value && typeof value === 'object' && !Array.isArray(value) && 'idempotent' in value) return value.idempotent === true;
    if (typeof value === 'string') return value === 'idempotent' || value === 'safe' || value === 'retry';
    return value === true;
  }
  return effectClassFor(execution) === 'read' || effectClassFor(execution) === 'idempotent_write';
}

async function invokePolicy(policy, input) {
  return typeof policy === 'function' ? policy(Object.freeze(input)) : policy;
}

function retryDecision(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('retry' in value) return value.retry === true;
    const decision = String(value.decision || value.status || '').trim();
    return decision === 'retry' || decision === 'queued' || decision === 'requeue';
  }
  return value === true || value === 'retry' || value === 'queued' || value === 'requeue';
}

function isLeaseContention(error) {
  return error?.code === 'RUNTIME_V3_EXECUTION_LEASE_STALE'
    || error?.code === 'RUNTIME_V3_EXECUTION_STATE_CONFLICT';
}

function errorRecord(error, reason) {
  return {
    code: String(error?.code || 'RUNTIME_V3_EXECUTION_FAILED'),
    message: truncate(String(error?.message || error || 'Execution failed.'), 2_000),
    status: Number.isSafeInteger(error?.status) ? error.status : 502,
    retryable: error?.retryable === true || error?.recoverable === true,
    reason: String(reason || 'execution_failed'),
  };
}

function eventError(error) {
  return {
    code: String(error?.code || 'RUNTIME_V3_EXECUTION_FAILED'),
    message: truncate(String(error?.message || 'Execution failed.'), 512),
    retryable: error?.retryable === true,
  };
}

function jsonValue(value) {
  return normalizeJsonValue(value === undefined ? null : value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

function requiredText(value, name) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw dispatcherError('RUNTIME_V3_VALUE_REQUIRED', `${name} is required.`);
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw dispatcherError('RUNTIME_V3_INTEGER_INVALID', `${name} must be a positive safe integer.`);
  }
  return number;
}

function optionalNonNegativeInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw dispatcherError('RUNTIME_V3_INTEGER_INVALID', `${name} must be a non-negative safe integer.`);
  }
  return number;
}

function truncate(value, maximum) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 3))}...`;
}

function truncateText(value, maximum) {
  return truncate(value, maximum);
}

function abortReason(reason) {
  if (reason instanceof Error) return truncate(reason.message || reason.name || 'cancelled', 2_000);
  return truncate(reason || 'cancelled', 2_000);
}

function dispatcherError(code, message, status = 500, details = {}) {
  return new ExecutionDispatcherError(code, message, status, details);
}
