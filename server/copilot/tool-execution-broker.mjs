import crypto from 'node:crypto';

import {
  canonicalJson,
  createExecutionContext,
  createRuntimeV3Repository,
  normalizeJsonValue,
} from './runtime-v3/index.mjs';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const DEFAULT_EVENT_VALUE_LIMIT = 12 * 1024;

export class ToolExecutionBrokerError extends Error {
  constructor(code, message, status = 500, { cause, retryable = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ToolExecutionBrokerError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Durable execution facade for registry-backed tools.
 *
 * The registry remains responsible for resolving an adapter and validating its
 * input. The broker owns the run-independent lifecycle: an immutable V3
 * execution record, ordered events, cancellation, idempotency, and a receipt
 * that can be inspected after the original caller has gone away.
 */
export class ToolExecutionBroker {
  constructor({
    registry = null,
    repository = null,
    rootDir = 'data',
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    emit = () => {},
    resultLimit = DEFAULT_RESULT_LIMIT,
    eventValueLimit = DEFAULT_EVENT_VALUE_LIMIT,
    dispatcher = null,
    handlerRegistry = null,
    waitIntervalMs = 50,
    waitTimeoutMs = 5 * 60_000,
    heartbeatIntervalMs = 1_000,
  } = {}) {
    this.registry = registry;
    this.repository = repository || createRuntimeV3Repository({ rootDir, now });
    this.ownsRepository = !repository;
    this.now = now;
    this.idFactory = idFactory;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.resultLimit = boundedInteger(resultLimit, DEFAULT_RESULT_LIMIT, 1_024, 4 * 1024 * 1024);
    this.eventValueLimit = boundedInteger(eventValueLimit, DEFAULT_EVENT_VALUE_LIMIT, 256, 256 * 1024);
    this.dispatcher = compatibleDispatcher(dispatcher);
    this.handlerRegistry = compatibleHandlerRegistry(handlerRegistry, this.dispatcher);
    this.waitIntervalMs = boundedInteger(waitIntervalMs, 50, 10, 5_000);
    this.waitTimeoutMs = boundedInteger(waitTimeoutMs, 5 * 60_000, 1_000, 30 * 60_000);
    this.heartbeatIntervalMs = boundedInteger(heartbeatIntervalMs, 1_000, 10, 30_000);
    this.active = new Map();
    // submit() can await recovery or synchronously emit a dispatcher claim
    // before it has an active adapter operation to publish. Keep that narrow
    // interval visible to close(), so shutdown cannot close the repository
    // below a task that is about to start.
    this.starting = new Set();
    this.closeSignal = new Promise((resolve) => {
      this.resolveCloseSignal = resolve;
    });
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
    this.unregisterToolHandler = this.handlerRegistry
      ? this.handlerRegistry.register('tool.call', (request) => (
        this.#handleDispatchedToolCall(request)
      ), {
        version: '1',
        dispatchMode: 'inline',
        executionKinds: ['tool'],
        effectClass: 'non_idempotent',
        maxRetries: 0,
      })
      : this.dispatcher?.registerHandler('tool.call', (request) => (
        this.#handleDispatchedToolCall(request)
      ), {
        effectClass: 'non_idempotent',
        maxRetries: 0,
      }) || null;
  }

  describe() {
    return {
      schemaVersion: 1,
      kind: 'tool_execution_broker',
      durable: Boolean(this.repository),
      active: this.active.size,
      closing: this.closing,
      closed: this.closed,
      repository: this.repository?.describe?.() || null,
      dispatcher: this.dispatcher?.describe?.() || null,
      effectClasses: ['read', 'idempotent_write', 'non_idempotent'],
      states: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'reconcile_required'],
    };
  }

  /**
   * Creates or returns the durable tool execution. A duplicate submission is
   * intentionally safe: a finished receipt is returned instead of rerunning
   * the adapter, while an in-flight local execution is joined.
   */
  async submit({
    registry = this.registry,
    toolName,
    input = {},
    context = {},
    executionContext,
    toolExecutionId = '',
    idempotencyKey = '',
  } = {}) {
    this.#assertAccepting();
    const finishStart = this.#beginStart();
    try {
    const descriptor = requireTool(registry, toolName);
    const effectClass = effectClassFor(descriptor);
    const executionId = String(toolExecutionId || context.toolRunId || this.idFactory()).trim();
    const baseContext = createExecutionContext(executionContext);
    const childContext = toolContext(baseContext, {
      executionId,
      toolName: descriptor.name,
      idempotencyKey: idempotencyKey || context.idempotencyKey || executionId,
    });
    const streamId = toolStreamId(childContext, executionId);
    const rawMetadata = {
      toolName: descriptor.name,
      source: String(descriptor.source || ''),
      effectClass,
      inputHash: contentHash(input),
      authorizationMode: String(context.authorizationMode || ''),
      parentToolRunId: String(context.parentToolRunId || ''),
    };
    const metadata = this.handlerRegistry
      ? this.handlerRegistry.metadataFor('tool.call', rawMetadata)
      : rawMetadata;
    const prior = this.repository.getExecution(executionId)
      || this.repository.getExecutionByIdempotencyKey({
        taskId: childContext.taskId,
        idempotencyKey: childContext.idempotencyKey,
      });
    let record = prior;
    if (record) {
      assertReusableToolExecution(record, childContext, metadata);
    } else {
      try {
        record = this.dispatcher
          ? this.dispatcher.enqueue({
              executionId,
              context: childContext,
              kind: 'tool',
              metadata,
              handlerKey: 'tool.call',
              effectClass,
              maxRetries: 0,
            })
          : this.repository.createExecution({
              executionId,
              context: childContext,
              kind: 'tool',
              status: 'queued',
              metadata,
            });
      } catch (error) {
        throw normalizeBrokerError(error);
      }
      // createExecution may return an existing row when another worker won
      // the race between the lookup above and the insert.
      assertReusableToolExecution(record, childContext, metadata);
    }

    const receipt = receiptFor(record, { toolName: descriptor.name, effectClass });
    if (record.status === 'succeeded' || record.status === 'cancelled' || record.status === 'failed' || record.status === 'reconcile_required') {
      return { receipt, duplicate: true, started: false };
    }
    if (this.closing || this.closed) {
      return await this.#stopBeforeStart(record, null, { toolName: descriptor.name, effectClass });
    }

    const existing = this.active.get(record.executionId);
    if (existing) return { receipt, duplicate: true, started: false, promise: existing.promise };

    if (this.dispatcher && record.status === 'running') {
      // A resubmission after a worker loss supplies the input required to run
      // an idempotent action again. Recovery owns the decision: it requeues
      // only safe work and converts unknown side effects to reconciliation.
      const recovered = await this.#awaitUntilClosing(this.dispatcher.recoverExpired({ limit: 25 }));
      if (!recovered || this.closing || this.closed) {
        return await this.#stopBeforeStart(record, null, { toolName: descriptor.name, effectClass });
      }
      record = this.repository.getExecution(record.executionId) || record;
      if (terminalStatus(record.status)) {
        return { receipt: receiptFor(record, { toolName: descriptor.name, effectClass }), duplicate: true, started: false };
      }
      if (this.closing || this.closed) {
        return await this.#stopBeforeStart(record, null, { toolName: descriptor.name, effectClass });
      }
    }

    let dispatcherClaim = null;
    if (this.dispatcher) {
      if (record.status === 'queued') {
        dispatcherClaim = this.dispatcher.claim(record.executionId);
        if (!dispatcherClaim) {
          return {
            receipt: receiptFor(this.repository.getExecution(record.executionId) || record, { toolName: descriptor.name, effectClass }),
            duplicate: true,
            started: false,
          };
        }
        record = dispatcherClaim.execution;
        // claim() may synchronously notify an observer that starts shutdown.
        // The startup barrier keeps the repository alive while we surrender
        // this lease instead of launching the adapter outside close()'s view.
        if (this.closing || this.closed) {
          return await this.#stopBeforeStart(record, dispatcherClaim, { toolName: descriptor.name, effectClass });
        }
      } else if (record.status === 'running') {
        return { receipt: receiptFor(record, { toolName: descriptor.name, effectClass }), duplicate: true, started: false };
      }
    }

    // Without a dispatcher, a process may have died after persisting `running`
    // but before it wrote a receipt. Retrying a non-idempotent action (commit,
    // send, remote mutation) would create an unbounded duplicate side effect.
    if (!this.dispatcher && prior && effectClass === 'non_idempotent') {
      const reconciled = this.repository.updateExecution(record.executionId, {
        status: 'reconcile_required',
        error: {
          code: 'TOOL_EXECUTION_ORPHANED',
          message: 'A non-idempotent tool execution was recovered without a durable receipt.',
          status: 409,
          retryable: false,
        },
      });
      this.#appendEvent(childContext, streamId, 'tool.execution.reconcile_required', {
        toolExecutionId: record.executionId,
        toolName: descriptor.name,
        effectClass,
      });
      return { receipt: receiptFor(reconciled, { toolName: descriptor.name, effectClass }), duplicate: true, started: false };
    }

    // No further external callbacks are expected below, but retain a final
    // shutdown check before registering the adapter operation. This keeps a
    // closing broker from launching a queued task through an integration that
    // synchronously changes lifecycle state while submit() is progressing.
    if (this.closing || this.closed) {
      return await this.#stopBeforeStart(record, dispatcherClaim, { toolName: descriptor.name, effectClass });
    }

    const controller = new AbortController();
    const abortForward = () => controller.abort(context.signal?.reason || new Error('parent_aborted'));
    context.signal?.addEventListener?.('abort', abortForward, { once: true });
    const operation = {
      executionId: record.executionId,
      toolName: descriptor.name,
      effectClass,
      descriptor,
      registry,
      context,
      executionContext: childContext,
      streamId,
      controller,
      abortForward,
      parentSignal: context.signal,
      dispatcherClaim,
      input,
      abandoned: false,
      shutdownReceipt: null,
      promise: null,
    };
    // Queue the async body after publishing the operation. #run emits its
    // started event before awaiting the adapter, and an event observer can
    // synchronously close the broker. Publishing first makes that close drain
    // this work instead of closing the repository underneath it.
    operation.promise = Promise.resolve().then(() => (
      this.dispatcher
        ? this.#runThroughDispatcher(operation)
        : this.#run(operation, input)
    )).finally(() => {
      context.signal?.removeEventListener?.('abort', abortForward);
      this.active.delete(record.executionId);
    });
    this.active.set(record.executionId, operation);
    return { receipt, duplicate: false, started: true, promise: operation.promise };
    } finally {
      finishStart();
    }
  }

  async execute(request = {}) {
    const submission = await this.submit(request);
    const receipt = submission.promise
      ? await submission.promise
      : await this.wait(submission.receipt.toolExecutionId, { signal: request.context?.signal });
    return resultForReceipt(receipt);
  }

  get(toolExecutionId) {
    const record = this.repository.getExecution(toolExecutionId);
    if (!record) return null;
    return receiptFor(record);
  }

  list({ runId = '', status = '', limit = 100 } = {}) {
    return this.repository.listExecutions({ runId, status, limit })
      .filter((record) => record.kind === 'tool')
      .map((record) => receiptFor(record));
  }

  async wait(toolExecutionId, {
    signal = null,
    timeoutMs = this.waitTimeoutMs,
    pollIntervalMs = this.waitIntervalMs,
  } = {}) {
    const id = requiredText(toolExecutionId, 'toolExecutionId');
    const active = this.active.get(id);
    if (active) {
      if (signal?.aborted) throw brokerError('TOOL_EXECUTION_WAIT_ABORTED', 'Waiting for the tool execution was cancelled.', 499);
      return active.promise;
    }
    const timeout = boundedInteger(timeoutMs, this.waitTimeoutMs, 1_000, 30 * 60_000);
    const interval = boundedInteger(pollIntervalMs, this.waitIntervalMs, 10, 5_000);
    const deadline = Date.now() + timeout;
    for (;;) {
      if (signal?.aborted) {
        throw brokerError('TOOL_EXECUTION_WAIT_ABORTED', 'Waiting for the tool execution was cancelled.', 499);
      }
      const receipt = this.get(id);
      if (!receipt) throw brokerError('TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
      if (terminalStatus(receipt.status)) return receipt;
      if (Date.now() >= deadline) {
        throw brokerError('TOOL_EXECUTION_WAIT_TIMEOUT', 'Timed out waiting for the durable tool receipt.', 504, { retryable: true });
      }
      await pause(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
    }
  }

  async cancel(toolExecutionId, { reason = 'cancelled', waitForAdapter = true } = {}) {
    const id = requiredText(toolExecutionId, 'toolExecutionId');
    const active = this.active.get(id);
    const record = this.repository.getExecution(id);
    if (!record) throw brokerError('TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    if (terminalStatus(record.status)) return receiptFor(record);
    const cancellationReason = redactText(reason || 'cancelled', this.eventValueLimit);
    // This marker is the cancellation authority. It must be committed before
    // emitting an observable event: an observer may synchronously complete a
    // tool run, and Dispatcher.complete() needs to see the marker inside its
    // fenced transaction to resolve that completion as cancelled.
    const requested = this.#requestCancellationIntent(record, cancellationReason);
    if (terminalStatus(requested.status)) return receiptFor(requested);
    this.#appendEvent(requested.context, active?.streamId || toolStreamId(requested.context, id), 'tool.execution.cancel_requested', {
      toolExecutionId: id,
      reason: cancellationReason,
    });

    // Event subscribers are allowed to synchronously drive a completion. The
    // cancellation marker was persisted before the callback above, so a
    // Dispatcher completion resolves as cancelled. Re-read the receipt before
    // deciding whether this caller should signal or terminalize anything else.
    const current = this.repository.getExecution(id) || requested;
    if (terminalStatus(current.status)) return receiptFor(current);

    if (!active && this.dispatcher) {
      if (current.status === 'queued') {
        // A queued cancellation has no active handler to observe it. A
        // successful claim terminalizes it inside the dispatcher; a failed
        // claim means another worker now owns the same cancellation marker.
        this.dispatcher.claim(id);
        const afterClaim = this.repository.getExecution(id) || current;
        if (afterClaim.status === 'cancelled' && afterClaim.error?.reason === 'cancel_requested_before_claim') {
          this.#appendEvent(afterClaim.context, toolStreamId(afterClaim.context, id), 'tool.execution.cancelled', {
            toolExecutionId: id,
            toolName: String(afterClaim.metadata?.toolName || ''),
            status: afterClaim.status,
            reason: cancellationReason,
          });
        }
        return receiptFor(afterClaim);
      }
      // A different worker owns the running lease. Its next heartbeat observes
      // the already-durable cancellation marker and aborts its adapter.
      return receiptFor(current);
    }

    if (!active && (current.status === 'queued' || current.status === 'running')) {
      const orphanedNonIdempotent = current.status === 'running'
        && String(current.metadata?.effectClass || '') === 'non_idempotent';
      const status = orphanedNonIdempotent ? 'reconcile_required' : 'cancelled';
      const cancelled = this.repository.updateExecutionIfStatus(id, {
        status,
        error: {
          code: orphanedNonIdempotent ? 'TOOL_EXECUTION_RECONCILE_REQUIRED' : 'TOOL_EXECUTION_CANCELLED',
          message: orphanedNonIdempotent
            ? 'The running non-idempotent tool execution requires reconciliation after worker loss.'
            : 'The tool execution was cancelled before a local worker could complete it.',
          status: orphanedNonIdempotent ? 409 : 499,
          retryable: false,
        },
        completedAt: this.#nowIso(),
      }, { expectedStatuses: ['queued', 'running'] }) || this.repository.getExecution(id) || current;
      if (cancelled.status === status) {
        this.#appendEvent(cancelled.context, toolStreamId(cancelled.context, id), orphanedNonIdempotent
          ? 'tool.execution.reconcile_required'
          : 'tool.execution.cancelled', {
          toolExecutionId: id,
          toolName: String(cancelled.metadata?.toolName || ''),
          status,
          reason: cancellationReason,
        });
      }
      return receiptFor(cancelled);
    }
    active?.controller.abort(new Error(cancellationReason));
    const cancel = active?.descriptor?.cancel;
    if (typeof cancel === 'function') {
      const adapterCancellation = Promise.resolve().then(() => cancel({
        toolExecutionId: id,
        context: active.context,
        signal: active.controller.signal,
      })).catch(() => {});
      // Shutdown must not let an uncooperative adapter's cleanup hook hold the
      // repository open forever. Direct user cancellation still waits by
      // default so existing callers can observe adapter cleanup deterministically.
      if (waitForAdapter) await adapterCancellation;
    }
    return this.get(id);
  }

  /**
   * A non-idempotent execution is never blindly replayed after a worker loss.
   * Adapters may supply reconcile(); otherwise the durable state remains an
   * explicit `reconcile_required` receipt for the supervisor/UI to resolve.
   */
  async reconcile(toolExecutionId, { registry = this.registry, context = {} } = {}) {
    this.#assertAccepting();
    const finishStart = this.#beginStart();
    try {
      const id = requiredText(toolExecutionId, 'toolExecutionId');
      const local = this.active.get(id);
      if (local?.kind === 'reconcile') return local.promise;
      const record = this.repository.getExecution(id);
      if (!record) throw brokerError('TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
      if (record.status !== 'reconcile_required') return receiptFor(record);
      const toolName = String(record.metadata?.toolName || '');
      const descriptor = requireTool(registry, toolName);
      if (typeof descriptor.reconcile !== 'function') return receiptFor(record);
      let claim = null;
      let working = record;
      if (this.dispatcher) {
        claim = this.dispatcher.claim(id, {
          statuses: ['reconcile_required'],
          includeReconcileRequired: true,
        });
        // Another worker owns the reconciliation. Its fenced receipt is the
        // only observable outcome; never run the adapter without that claim.
        if (!claim) return receiptFor(this.repository.getExecution(id) || record);
        working = claim.execution;
      }
      // `claim()` can synchronously notify an observer that starts shutdown.
      // Surrender the fenced claim instead of leaving a running lease without an
      // active reconciliation operation for close() to drain.
      if (this.closing || this.closed) {
        const stopped = await this.#stopBeforeStart(working, claim, {
          toolName,
          effectClass: String(working.metadata?.effectClass || 'non_idempotent'),
        });
        return stopped.receipt;
      }
      const controller = new AbortController();
      const operation = {
        kind: 'reconcile',
        executionId: id,
        toolName,
        effectClass: String(working.metadata?.effectClass || 'non_idempotent'),
        descriptor,
        registry,
        context,
        executionContext: working.context,
        streamId: toolStreamId(working.context, id),
        controller,
        dispatcherClaim: claim,
        abandoned: false,
        shutdownReceipt: null,
        promise: null,
      };
      this.active.set(id, operation);
      operation.promise = this.#runReconciliation(operation, working).finally(() => {
        if (this.active.get(id) === operation) this.active.delete(id);
      });
      return operation.promise;
    } finally {
      finishStart();
    }
  }

  async #runReconciliation(operation, working) {
    const {
      executionId: id,
      toolName,
      descriptor,
      context,
      streamId,
      controller,
      dispatcherClaim: claim,
    } = operation;
    this.#appendEvent(working.context, streamId, 'tool.execution.reconciling', { toolExecutionId: id, toolName });
    if (this.closing || this.closed) {
      controller.abort(new Error('broker_shutdown'));
    }
    let reconciliationHeartbeat = null;
    let reconciliationLeaseLost = false;
    const loseReconciliationLease = (reason) => {
      reconciliationLeaseLost = true;
      if (!controller.signal.aborted) {
        controller.abort(reason instanceof Error ? reason : new Error(String(reason || 'dispatcher_lease_lost')));
      }
    };
    const heartbeat = () => {
      if (!this.dispatcher || !claim) return { renewed: true, execution: working };
      const result = this.dispatcher.heartbeat(claim);
      if (!result.renewed) loseReconciliationLease(new Error('dispatcher_lease_lost'));
      const cancellation = dispatcherCancellation(result.execution || this.repository.getExecution(id));
      if (cancellation && !controller.signal.aborted) {
        controller.abort(new Error(cancellation.reason));
      }
      return result;
    };
    if (claim) {
      try {
        if (!heartbeat().renewed) return receiptFor(this.repository.getExecution(id) || working);
      } catch {
        return receiptFor(this.repository.getExecution(id) || working);
      }
      reconciliationHeartbeat = setInterval(() => {
        try { heartbeat(); } catch (error) { loseReconciliationLease(error); }
      }, renewalInterval(this.dispatcher, this.heartbeatIntervalMs));
    }
    try {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const result = await descriptor.reconcile({
        toolExecutionId: id,
        receipt: receiptFor(working),
        context,
        signal: controller.signal,
      });
      if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      if (reconciliationLeaseLost) return receiptFor(this.repository.getExecution(id) || working);
      const next = this.dispatcher
        ? this.dispatcher.complete(claim, boundedResult(result, this.resultLimit))
        : this.#settleWithoutDispatcher(id, {
            status: 'succeeded',
            result: boundedResult(result, this.resultLimit),
            error: {},
            expectedStatuses: ['reconcile_required', 'running'],
          });
      const outcomeStatus = String(next.status || 'succeeded');
      const eventType = outcomeStatus === 'succeeded'
        ? 'tool.execution.reconciled'
        : outcomeStatus === 'cancelled'
          ? 'tool.execution.cancelled'
          : outcomeStatus === 'reconcile_required'
            ? 'tool.execution.reconcile_required'
            : 'tool.execution.completed';
      this.#appendEvent(working.context, streamId, eventType, {
        toolExecutionId: id,
        toolName,
        status: outcomeStatus,
      });
      return receiptFor(next);
    } catch (error) {
      // close() can time out an adapter and close its owned repository while
      // the adapter later rejects. The late completion has no fence anymore;
      // return the shutdown receipt rather than reading or mutating storage.
      if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
      let next;
      try {
        const cancellation = dispatcherCancellation(this.repository.getExecution(id));
        const cancelled = controller.signal.aborted || isAbort(error) || Boolean(cancellation);
        next = this.dispatcher
          ? cancelled
            ? this.dispatcher.cancel(claim, { reason: abortReason(controller.signal.reason || cancellation?.reason || error) })
            : this.dispatcher.reconcile(claim, { reason: 'tool_reconcile_failed', error })
          : this.#settleWithoutDispatcher(id, {
              status: cancelled ? 'cancelled' : 'reconcile_required',
              error: cancelled
                ? cancellationErrorForBroker(controller.signal.reason || cancellation?.reason || error)
                : storedError(error),
              expectedStatuses: ['reconcile_required', 'running'],
            });
      } catch {
        // A fenced-off worker must not turn a successor's reconciliation into
        // a second effect. Report the persisted outcome instead.
        next = this.repository.getExecution(id) || working;
      }
      const outcomeStatus = String(next?.status || 'reconcile_required');
      this.#appendEvent(working.context, streamId, outcomeStatus === 'cancelled'
        ? 'tool.execution.cancelled'
        : 'tool.execution.reconcile_failed', {
        toolExecutionId: id,
        toolName,
        status: outcomeStatus,
        error: eventError(error, this.eventValueLimit),
      });
      return receiptFor(next);
    } finally {
      if (reconciliationHeartbeat) clearInterval(reconciliationHeartbeat);
    }
  }

  /**
   * Marks pre-claim queued tool rows left by a previous process as requiring
   * reconciliation. Tool inputs are intentionally not persisted in V3, so a
   * fresh process must not guess at or replay an unknown request payload.
   */
  async reconcileQueuedOrphans({
    limit = 1_000,
    reason = 'worker_restarted_without_tool_payload',
  } = {}) {
    this.#assertAccepting();
    const maximum = boundedInteger(limit, 1_000, 1, 10_000);
    const reconciled = [];
    for (const record of this.repository.listExecutions({ status: 'queued', limit: maximum })) {
      this.#assertAccepting();
      // Older/default-broker rows predate dispatcher.handlerKey. toolName is
      // the stable identity that tells us this queued record had a side
      // effect request whose payload was intentionally not persisted.
      if (record.kind !== 'tool' || !String(record.metadata?.toolName || '').trim()) continue;
      const next = this.repository.updateExecutionIfStatus(record.executionId, {
        status: 'reconcile_required',
        error: {
          code: 'TOOL_EXECUTION_PAYLOAD_UNAVAILABLE',
          message: 'The queued tool execution cannot be resumed because its request payload was not persisted.',
          status: 409,
          retryable: false,
          reason,
        },
        completedAt: this.#nowIso(),
      }, { expectedStatuses: ['queued'] });
      if (!next) continue;
      const streamId = toolStreamId(next.context, next.executionId);
      this.#appendEvent(next.context, streamId, 'tool.execution.reconcile_required', {
        toolExecutionId: next.executionId,
        toolName: String(next.metadata?.toolName || ''),
        status: next.status,
        reason,
      });
      this.#appendRuntimeEvent(next, 'execution.reconcile_required', {
        executionId: next.executionId,
        reason,
      });
      reconciled.push(receiptFor(next));
    }
    return Object.freeze(reconciled);
  }

  close({ timeoutMs = 8_000 } = {}) {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.resolveCloseSignal?.();
    this.closePromise = this.#close(timeoutMs);
    return this.closePromise;
  }

  async #run(operation, input) {
    const {
      executionId,
      descriptor,
      registry,
      context,
      executionContext,
      streamId,
      controller,
      effectClass,
    } = operation;
    if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
    // The dispatcher revalidates the current durable lease for every terminal
    // transition. Use it as the ownership authority instead of relying on the
    // claim object captured before a long-running adapter call.
    const dispatcher = this.dispatcher;
    const existing = this.repository.getExecution(executionId);
    if (!existing) throw brokerError('TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    const running = dispatcher
      ? this.repository.getExecution(executionId)
      : this.#startWithoutDispatcher(executionId);
    if (!running || terminalStatus(running.status)) return receiptFor(running || existing);
    let heartbeatTimer = null;
    const heartbeat = () => {
      if (!dispatcher) return;
      const result = dispatcher.heartbeat(operation.dispatcherClaim || running);
      const cancellation = dispatcherCancellation(result.execution);
      if (cancellation) {
        controller.abort(new Error(cancellation.reason || 'cancelled'));
        return;
      }
      if (!result.renewed) controller.abort(new Error('dispatcher_lease_lost'));
    };
    if (dispatcher) {
      try { heartbeat(); } catch (error) { controller.abort(error); }
      heartbeatTimer = setInterval(() => {
        try { heartbeat(); } catch (error) { controller.abort(error); }
      }, renewalInterval(dispatcher, this.heartbeatIntervalMs));
    }
    this.#appendEvent(executionContext, streamId, 'tool.execution.started', {
      toolExecutionId: executionId,
      toolName: descriptor.name,
      source: String(descriptor.source || ''),
      effectClass,
    });
    // Event delivery is synchronous. A UI or lifecycle observer may begin
    // broker shutdown from the started event, so do not cross the adapter
    // boundary until the shutdown signal has been observed once more.
    if (this.closing || this.closed) {
      controller.abort(new Error('broker_shutdown'));
    }
    try {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const result = await registry.execute(descriptor.name, input, {
        ...context,
        signal: controller.signal,
        toolExecutionId: executionId,
        executionContext,
        effectClass,
        emit: (event) => {
          context.emit?.(event);
          this.#appendEvent(executionContext, streamId, 'tool.execution.progress', {
            toolExecutionId: executionId,
            toolName: descriptor.name,
            event: summarizeEvent(event, this.eventValueLimit),
          });
        },
      });
      if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
      const completed = dispatcher
        ? dispatcher.complete(operation.dispatcherClaim || running, boundedResult(result, this.resultLimit))
        : this.#settleWithoutDispatcher(executionId, {
            status: 'succeeded',
            result: boundedResult(result, this.resultLimit),
            error: {},
          });
      const outcomeStatus = String(completed?.status || 'succeeded');
      const eventType = outcomeStatus === 'cancelled'
        ? 'tool.execution.cancelled'
        : outcomeStatus === 'reconcile_required'
          ? 'tool.execution.reconcile_required'
          : outcomeStatus === 'succeeded'
            ? 'tool.execution.completed'
            : 'tool.execution.failed';
      this.#appendEvent(executionContext, streamId, eventType, {
        toolExecutionId: executionId,
        toolName: descriptor.name,
        status: outcomeStatus,
      });
      return receiptFor(completed);
    } catch (error) {
      if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
      const cancellation = dispatcherCancellation(this.repository.getExecution(executionId));
      const cancelled = controller.signal.aborted || isAbort(error) || Boolean(cancellation);
      const status = cancelled ? 'cancelled' : 'failed';
      let failed;
      try {
        failed = dispatcher
          ? cancelled
            ? dispatcher.cancel(operation.dispatcherClaim || running, { reason: abortReason(controller.signal.reason || error) })
            : await dispatcher.fail(operation.dispatcherClaim || running, error, { allowRetry: false, reason: 'tool_failed' })
          : this.#settleWithoutDispatcher(executionId, {
              status,
              error: cancelled
                ? cancellationErrorForBroker(controller.signal.reason || cancellation?.reason || error)
                : storedError(error),
            });
      } catch {
        // A worker that lost its fence cannot publish a competing terminal
        // receipt. The current durable record is the only valid outcome.
        failed = this.repository.getExecution(executionId) || existing;
      }
      const outcomeStatus = String(failed?.status || status);
      // A durable cancellation requested by another worker can turn a local
      // adapter error into a legitimate cancelled receipt. That is distinct
      // from losing the fencing lease to another owner.
      const cancellationWon = outcomeStatus === 'cancelled' && Boolean(dispatcherCancellation(failed));
      const ownershipLost = Boolean(dispatcher && outcomeStatus !== status && !cancellationWon);
      const eventType = ownershipLost
        ? 'tool.execution.lease_lost'
        : outcomeStatus === 'cancelled'
          ? 'tool.execution.cancelled'
          : outcomeStatus === 'reconcile_required'
            ? 'tool.execution.reconcile_required'
            : outcomeStatus === 'succeeded'
              ? 'tool.execution.completed'
              : 'tool.execution.failed';
      this.#appendEvent(executionContext, streamId, eventType, {
        toolExecutionId: executionId,
        toolName: descriptor.name,
        status: outcomeStatus,
        error: eventError(cancellationWon ? failed?.error || error : error, this.eventValueLimit),
        ...(ownershipLost ? { observedStatus: outcomeStatus } : {}),
      });
      return receiptFor(failed);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  async #runThroughDispatcher(operation) {
    const {
      executionId,
      descriptor,
      executionContext,
      streamId,
      controller,
      effectClass,
      dispatcherClaim,
    } = operation;
    let settled;
    try {
      settled = await this.dispatcher.execute(dispatcherClaim || executionId, {
        handlerKey: 'tool.call',
        signal: controller.signal,
        heartbeatIntervalMs: renewalInterval(this.dispatcher, this.heartbeatIntervalMs),
      });
    } catch (error) {
      if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);
      const current = this.repository.getExecution(executionId);
      if (!current || !terminalStatus(current.status)) throw normalizeBrokerError(error);
      settled = current;
    }
    if (operation.abandoned) return operation.shutdownReceipt || this.#syntheticShutdownReceipt(operation);

    const status = String(settled?.status || 'failed');
    const eventType = status === 'succeeded'
      ? 'tool.execution.completed'
      : status === 'cancelled'
        ? 'tool.execution.cancelled'
        : status === 'reconcile_required'
          ? 'tool.execution.reconcile_required'
          : 'tool.execution.failed';
    this.#appendEvent(executionContext, streamId, eventType, {
      toolExecutionId: executionId,
      toolName: descriptor.name,
      status,
      ...(status === 'failed' || status === 'reconcile_required'
        ? { error: eventError(settled?.error, this.eventValueLimit) }
        : {}),
    });
    return receiptFor(settled, { toolName: descriptor.name, effectClass });
  }

  async #handleDispatchedToolCall({ execution, signal, heartbeat, emit } = {}) {
    const executionId = requiredText(execution?.executionId, 'execution.executionId');
    const operation = this.active.get(executionId);
    if (!operation || operation.kind === 'reconcile') {
      throw brokerError(
        'TOOL_EXECUTION_PAYLOAD_UNAVAILABLE',
        'The tool request payload is unavailable on the worker that claimed this execution.',
        409,
      );
    }
    operation.dispatcherClaim = operation.dispatcherClaim || execution;
    const {
      descriptor,
      registry,
      context,
      executionContext,
      streamId,
      effectClass,
      input,
    } = operation;
    this.#appendEvent(executionContext, streamId, 'tool.execution.started', {
      toolExecutionId: executionId,
      toolName: descriptor.name,
      source: String(descriptor.source || ''),
      effectClass,
    });
    if (this.closing || this.closed || signal?.aborted) {
      throw abortError(signal?.reason || new Error('broker_shutdown'));
    }
    heartbeat?.();
    const result = await registry.execute(descriptor.name, input, {
      ...context,
      signal,
      toolExecutionId: executionId,
      executionContext,
      effectClass,
      emit: (event) => {
        context.emit?.(event);
        const summary = summarizeEvent(event, this.eventValueLimit);
        this.#appendEvent(executionContext, streamId, 'tool.execution.progress', {
          toolExecutionId: executionId,
          toolName: descriptor.name,
          event: summary,
        });
        emit?.({
          toolExecutionId: executionId,
          toolName: descriptor.name,
          event: summary,
        });
      },
    });
    return boundedResult(result, this.resultLimit);
  }

  async #close(timeoutMs) {
    const timeout = boundedInteger(timeoutMs, 8_000, 100, 30_000);
    // A submit can be waiting for recovery or inside a synchronous dispatcher
    // callback before it has an entry in active. New submissions fail as soon
    // as close() sets `closing`; wait for the already-admitted starts to either
    // publish a cancellable operation or surrender their queued/claimed row.
    const starts = [...this.starting];
    // Avoid a gratuitous microtask yield when there is no pre-active start in
    // flight. That yield previously allowed a synchronous started observer to
    // call close(), then let the adapter begin before close() aborted it.
    if (starts.length > 0) {
      await settlesWithin(Promise.allSettled(starts), timeout);
    }
    const operations = [...this.active.values()];
    // First publish durable cancellation intent and give cooperative adapters
    // a chance to settle while the repository and dispatcher still exist.
    await Promise.allSettled(operations.map((operation) => this.cancel(operation.executionId, {
      reason: 'broker_shutdown',
      waitForAdapter: false,
    })));
    const drained = await settlesWithin(
      Promise.allSettled(operations.map((operation) => operation.promise)),
      timeout,
    );
    if (!drained) {
      for (const operation of operations) {
        if (!this.active.has(operation.executionId)) continue;
        const record = this.#markShutdownReconcile(operation);
        operation.shutdownReceipt = this.#shutdownReceipt(operation, record);
        // The adapter may resolve after its owner has shut down. It must not
        // access a closed repository or publish a competing terminal state.
        operation.abandoned = true;
      }
    }
    this.unregisterToolHandler?.();
    this.unregisterToolHandler = null;
    this.closed = true;
    if (this.ownsRepository) this.repository?.close?.();
  }

  #beginStart() {
    let resolveBarrier;
    const barrier = new Promise((resolve) => {
      resolveBarrier = resolve;
    });
    this.starting.add(barrier);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.starting.delete(barrier);
      resolveBarrier();
    };
  }

  async #awaitUntilClosing(promise) {
    return Promise.race([
      Promise.resolve(promise).then(() => true),
      this.closeSignal.then(() => false),
    ]);
  }

  async #stopBeforeStart(record, dispatcherClaim, { toolName = '', effectClass = '' } = {}) {
    const reason = 'broker_shutdown_before_start';
    let next = record;
    try {
      if (this.dispatcher && dispatcherClaim) {
        next = this.dispatcher.cancel(dispatcherClaim, { reason });
      } else {
        await this.cancel(record.executionId, { reason, waitForAdapter: false });
        next = this.repository.getExecution(record.executionId) || record;
      }
    } catch {
      // A concurrent owner may have terminalized the record while shutdown
      // waited for this submit. Its durable result is the only valid receipt.
      try { next = this.repository.getExecution(record.executionId) || record; } catch { /* repository may already be closed */ }
    }
    return {
      receipt: receiptFor(next, { toolName, effectClass }),
      duplicate: true,
      started: false,
    };
  }

  #markShutdownReconcile(operation) {
    let current;
    try {
      current = this.repository.getExecution(operation.executionId);
    } catch {
      return null;
    }
    if (!current || terminalStatus(current.status)) return current;
    const error = brokerError(
      'TOOL_EXECUTION_RECONCILE_REQUIRED',
      'The tool did not stop before broker shutdown and requires reconciliation.',
      409,
    );
    let next = current;
    try {
      next = this.dispatcher && current.status === 'running'
          ? this.dispatcher.reconcile(operation.dispatcherClaim || current, {
            reason: 'broker_shutdown_timeout',
            error,
            preserveUnknownEffect: true,
          })
        : this.repository.updateExecutionIfStatus(operation.executionId, {
            status: 'reconcile_required',
            result: null,
            error: storedError(error),
            completedAt: this.#nowIso(),
          }, { expectedStatuses: ['queued', 'running'] }) || this.repository.getExecution(operation.executionId) || current;
    } catch {
      next = this.repository.getExecution(operation.executionId) || current;
    }
    if (next?.status === 'reconcile_required') {
      this.#appendEvent(next.context, toolStreamId(next.context, next.executionId), 'tool.execution.reconcile_required', {
        toolExecutionId: next.executionId,
        toolName: String(next.metadata?.toolName || operation.toolName || ''),
        status: next.status,
        reason: 'broker_shutdown_timeout',
      });
    }
    return next;
  }

  #shutdownReceipt(operation, record) {
    return receiptFor(record || {
      executionId: operation.executionId,
      status: 'reconcile_required',
      metadata: {
        toolName: operation.toolName,
        effectClass: operation.effectClass,
      },
      result: null,
      error: {
        code: 'TOOL_EXECUTION_RECONCILE_REQUIRED',
        message: 'The broker stopped before the tool could settle.',
        status: 409,
        retryable: false,
      },
      createdAt: '',
      updatedAt: '',
      completedAt: '',
      context: operation.executionContext,
    });
  }

  #syntheticShutdownReceipt(operation) {
    return this.#shutdownReceipt(operation, null);
  }

  #settleWithoutDispatcher(executionId, {
    status,
    result = undefined,
    error = {},
    expectedStatuses = ['queued', 'running'],
  } = {}) {
    const current = this.repository.getExecution(executionId);
    if (!current || terminalStatus(current.status)) return current;
    return this.repository.updateExecutionIfStatus(executionId, (latest) => {
      // Resolve this inside updateExecutionIfStatus' SQLite transaction. A
      // remote cancellation that lands between an adapter result and this
      // write must win, even for the legacy no-dispatcher compatibility path.
      const cancellation = dispatcherCancellation(latest);
      const cancelled = Boolean(cancellation);
      const patch = {
        status: cancelled ? 'cancelled' : status,
        error: cancelled ? cancellationErrorForBroker(cancellation.reason) : error,
        completedAt: this.#nowIso(),
      };
      if (cancelled || status === 'succeeded') patch.result = cancelled ? null : result;
      return patch;
    }, { expectedStatuses })
      || this.repository.getExecution(executionId)
      || current;
  }

  #startWithoutDispatcher(executionId) {
    const current = this.repository.getExecution(executionId);
    if (!current || terminalStatus(current.status)) return current;
    return this.repository.updateExecutionIfStatus(executionId, (latest) => {
      // Starting must be conditional too. A remote cancellation can land
      // after submit creates the queued row but before this worker reaches the
      // adapter; never revive that terminal intent into a side effect.
      const cancellation = dispatcherCancellation(latest);
      if (cancellation) {
        return {
          status: 'cancelled',
          result: null,
          error: cancellationErrorForBroker(cancellation.reason),
          completedAt: this.#nowIso(),
        };
      }
      return latest.status === 'queued' ? { status: 'running' } : {};
    }, { expectedStatuses: ['queued', 'running'] })
      || this.repository.getExecution(executionId)
      || current;
  }

  #requestCancellationIntent(record, reason) {
    const current = this.repository.getExecution(record.executionId) || record;
    if (terminalStatus(current.status)) return current;
    const requested = this.repository.updateExecutionIfStatus(current.executionId, (latest) => {
      const dispatcher = latest.metadata?.dispatcher;
      return {
        metadata: {
          ...(latest.metadata || {}),
          dispatcher: {
            ...(dispatcher && typeof dispatcher === 'object' ? dispatcher : {}),
            cancelRequestedAt: this.#nowIso(),
            cancelReason: reason,
          },
        },
      };
    }, {
      expectedStatuses: ['queued', 'running'],
    }) || this.repository.getExecution(current.executionId) || current;
    if (terminalStatus(requested.status)) return requested;
    this.#appendRuntimeEvent(requested, 'execution.cancel_requested', {
      executionId: requested.executionId,
      reason,
    });
    return requested;
  }

  #appendEvent(executionContext, streamId, type, payload) {
    let event;
    try {
      event = this.repository.appendEvent({
        streamId,
        type,
        occurredAt: this.#nowIso(),
        taskId: executionContext.taskId,
        runId: executionContext.runId,
        attemptId: executionContext.attemptId,
        payload: normalizeJsonValue(payload),
      });
    } catch (error) {
      // Tool completion is the source of truth. A best-effort mirror must not
      // turn a completed local file edit into an arbitrary retry.
      return null;
    }
    try { this.emit(event); } catch { /* Observers must not affect execution. */ }
    return event;
  }

  #appendRuntimeEvent(record, type, payload) {
    try {
      const event = this.repository.appendEvent({
        streamId: `run:${record.context.runId}`,
        type,
        occurredAt: this.#nowIso(),
        taskId: record.context.taskId,
        runId: record.context.runId,
        attemptId: record.context.attemptId,
        payload: normalizeJsonValue(payload),
      });
      try { this.emit(event); } catch { /* Observers must not affect execution. */ }
      return event;
    } catch {
      return null;
    }
  }

  #nowIso() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw brokerError('TOOL_EXECUTION_CLOCK_INVALID', 'The broker clock returned an invalid date.', 500);
    return date.toISOString();
  }

  #assertAccepting() {
    if (this.closing || this.closed) {
      throw brokerError('TOOL_EXECUTION_BROKER_CLOSED', 'Tool execution broker is closing or closed.', 409);
    }
  }
}

export function createToolExecutionBroker(options = {}) {
  return new ToolExecutionBroker(options);
}

function compatibleDispatcher(dispatcher) {
  if (dispatcher === null || dispatcher === undefined) return null;
  const required = [
    'enqueue',
    'claim',
    'heartbeat',
    'complete',
    'fail',
    'cancel',
    'reconcile',
    'recoverExpired',
    'registerHandler',
    'execute',
  ];
  if (!required.every((name) => typeof dispatcher[name] === 'function')) {
    throw brokerError(
      'TOOL_EXECUTION_DISPATCHER_INVALID',
      'dispatcher must implement enqueue(), claim(), execute(), heartbeat(), complete(), fail(), cancel(), reconcile(), recoverExpired(), and registerHandler().',
      500,
    );
  }
  return dispatcher;
}

function compatibleHandlerRegistry(registry, dispatcher) {
  if (registry === null || registry === undefined) return null;
  const required = ['metadataFor', 'register'];
  if (!required.every((name) => typeof registry[name] === 'function')) {
    throw brokerError(
      'TOOL_EXECUTION_HANDLER_REGISTRY_INVALID',
      'handlerRegistry must implement register() and metadataFor().',
      500,
    );
  }
  if (dispatcher && registry.dispatcher && registry.dispatcher !== dispatcher) {
    throw brokerError(
      'TOOL_EXECUTION_HANDLER_REGISTRY_DISPATCHER_MISMATCH',
      'handlerRegistry and dispatcher must share the same dispatcher instance.',
      500,
    );
  }
  return registry;
}

export function effectClassFor(descriptor = {}) {
  if (String(descriptor.risk || 'read') === 'read') return 'read';
  return descriptor.idempotent === true ? 'idempotent_write' : 'non_idempotent';
}

export function toolContext(parent, { executionId, toolName, idempotencyKey } = {}) {
  const parentContext = createExecutionContext(parent);
  const id = requiredText(executionId, 'toolExecutionId');
  const name = requiredText(toolName, 'toolName');
  return createExecutionContext({
    ...parentContext,
    taskId: `tool:${parentContext.taskId}:${id}`,
    attemptId: id,
    parentExecutionId: parentContext.parentExecutionId || parentContext.taskId,
    idempotencyKey: `tool:${parentContext.idempotencyKey}:${requiredText(idempotencyKey, 'idempotencyKey')}`,
    environment: {
      ...parentContext.environment,
      tool: { name, toolExecutionId: id },
    },
  });
}

function requireTool(registry, toolName) {
  if (!registry?.get || !registry?.execute) {
    throw brokerError('TOOL_EXECUTION_REGISTRY_REQUIRED', 'A registry with get() and execute() is required.', 500);
  }
  const name = requiredText(toolName, 'toolName');
  const descriptor = registry.get(name);
  if (!descriptor) throw brokerError('COPILOT_TOOL_UNKNOWN', `Unknown Copilot tool: ${name}.`, 404);
  return descriptor;
}

function receiptFor(record, fallback = {}) {
  const metadata = record.metadata || {};
  return Object.freeze({
    schemaVersion: 1,
    toolExecutionId: record.executionId,
    executionId: record.executionId,
    status: record.status,
    toolName: String(metadata.toolName || fallback.toolName || ''),
    effectClass: String(metadata.effectClass || fallback.effectClass || ''),
    inputHash: String(metadata.inputHash || ''),
    authorizationMode: String(metadata.authorizationMode || ''),
    result: record.result,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    context: record.context,
  });
}

function assertReusableToolExecution(record, context, metadata) {
  const previousContext = record?.context || {};
  const sameTask = String(previousContext.taskId || '') === String(context.taskId || '');
  const sameKey = String(previousContext.idempotencyKey || '') === String(context.idempotencyKey || '');
  const sameTool = !record?.metadata?.toolName || String(record.metadata.toolName) === String(metadata.toolName);
  const sameInput = !record?.metadata?.inputHash || String(record.metadata.inputHash) === String(metadata.inputHash);
  if (record?.kind !== 'tool' || !sameTask || !sameKey || !sameTool || !sameInput) {
    throw brokerError(
      'TOOL_EXECUTION_IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to a different tool intent.',
      409,
    );
  }
}

function storedFailure(receipt) {
  const error = receipt?.error && typeof receipt.error === 'object' ? receipt.error : {};
  return brokerError(
    String(error.code || 'TOOL_EXECUTION_FAILED'),
    String(error.message || 'The tool execution failed.'),
    Number.isInteger(error.status) ? error.status : 502,
    { retryable: error.retryable === true },
  );
}

function resultForReceipt(receipt) {
  if (receipt?.status === 'succeeded') return receipt.result;
  if (receipt?.status === 'cancelled') {
    throw brokerError('TOOL_EXECUTION_CANCELLED', 'The tool execution was cancelled.', 499);
  }
  if (receipt?.status === 'reconcile_required') {
    throw brokerError('TOOL_EXECUTION_RECONCILE_REQUIRED', 'The previous non-idempotent tool attempt requires reconciliation.', 409);
  }
  if (receipt?.status === 'failed') throw storedFailure(receipt);
  throw brokerError('TOOL_EXECUTION_UNAVAILABLE', 'The durable tool receipt did not reach a terminal state.', 409, { retryable: true });
}

function storedError(error) {
  return {
    code: String(error?.code || 'TOOL_EXECUTION_FAILED'),
    message: redactText(error?.message || error || 'The tool execution failed.', 2_000),
    status: Number.isInteger(error?.status) ? error.status : 502,
    retryable: error?.retryable === true || error?.recoverable === true,
  };
}

function cancellationErrorForBroker(reason) {
  return {
    code: 'TOOL_EXECUTION_CANCELLED',
    message: abortReason(reason),
    status: 499,
    retryable: false,
    reason: 'cancel_requested',
  };
}

function eventError(error, maximum) {
  const value = storedError(error);
  value.message = truncate(value.message, maximum);
  return value;
}

function summarizeEvent(value, maximum) {
  return sanitize(value, maximum);
}

function boundedResult(value, maximum) {
  return sanitize(value, maximum);
}

function sanitize(value, maximum, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactText(value, maximum);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, maximum, seen));
  if (!value || typeof value !== 'object') return truncate(String(value || ''), maximum);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    output[key] = secretKey(key) ? '[redacted]' : sanitize(item, maximum, seen);
  }
  return output;
}

function secretKey(key) {
  return /(?:api[_-]?key|authorization|password|secret|token|cookie|credential)/iu.test(String(key));
}

function redactText(value, maximum) {
  return truncate(String(value || '')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/giu, 'Basic [redacted]')
    .replace(/\b((?:api[_-]?key|authorization|password|secret|token|cookie|credential)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/(https?:\/\/[^:\s/?#]+:)[^@\s/]+@/giu, '$1[redacted]@'), maximum);
}

function contentHash(value) {
  // Idempotency must bind to the complete input, including values that are
  // redacted in receipts and events. Redacting before hashing makes distinct
  // credentials look like the same tool request.
  const source = canonicalJson(value);
  return crypto.createHash('sha256').update(source).digest('hex');
}

function toolStreamId(context, executionId) {
  return `execution:${context.runId}:tool:${executionId}`;
}

function terminalStatus(status) {
  return ['succeeded', 'failed', 'cancelled', 'reconcile_required'].includes(String(status));
}

function dispatcherCancellation(record) {
  const dispatcher = record?.metadata?.dispatcher;
  if (!dispatcher || typeof dispatcher !== 'object' || !dispatcher.cancelRequestedAt) return null;
  return {
    requestedAt: String(dispatcher.cancelRequestedAt),
    reason: redactText(dispatcher.cancelReason || 'cancelled', 2_000),
  };
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'TOOL_EXECUTION_CANCELLED';
}

function abortError(reason) {
  const error = new Error(redactText(reason instanceof Error ? reason.message : reason || 'cancelled', 2_000));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function abortReason(reason) {
  return redactText(reason instanceof Error ? reason.message : reason || 'cancelled', 2_000);
}

function normalizeBrokerError(error) {
  if (error instanceof ToolExecutionBrokerError) return error;
  return brokerError(
    String(error?.code || 'TOOL_EXECUTION_PERSISTENCE_FAILED'),
    String(error?.message || 'Unable to persist the tool execution.'),
    Number.isInteger(error?.status) ? error.status : 500,
    { cause: error, retryable: error?.retryable === true },
  );
}

function brokerError(code, message, status = 500, options = {}) {
  return new ToolExecutionBrokerError(code, message, status, options);
}

function requiredText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw brokerError('TOOL_EXECUTION_VALUE_REQUIRED', `${name} is required.`, 400);
  return text;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function renewalInterval(dispatcher, requestedIntervalMs) {
  const configured = boundedInteger(requestedIntervalMs, 1_000, 10, 30_000);
  const ttl = Number(dispatcher?.leaseTtlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return configured;
  return Math.max(10, Math.min(configured, Math.max(10, Math.floor(ttl / 3))));
}

function truncate(value, maximum) {
  const text = String(value || '');
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 15))}\n...[truncated]`;
}

function pause(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(brokerError('TOOL_EXECUTION_WAIT_ABORTED', 'Waiting for the tool execution was cancelled.', 499));
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => signal?.removeEventListener?.('abort', abort);
    const abort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(brokerError('TOOL_EXECUTION_WAIT_ABORTED', 'Waiting for the tool execution was cancelled.', 499));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function settlesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(() => finish(true), () => finish(true));
  });
}
