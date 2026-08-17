const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_RECOVERY_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_SCAN_LIMIT = 100;

/**
 * Continuously claims only handlers declared durable by the handler registry.
 * Inline handlers remain owned by their request path until their payload can
 * be reconstructed after a restart.
 */
export class ExecutionWorkerSupervisor {
  constructor({
    dispatcher,
    handlerRegistry,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    scanLimit = DEFAULT_SCAN_LIMIT,
    heartbeatIntervalMs = 0,
    now = () => new Date(),
    emit = () => {},
  } = {}) {
    this.dispatcher = requireDispatcher(dispatcher);
    this.handlerRegistry = requireHandlerRegistry(handlerRegistry);
    this.pollIntervalMs = positiveInteger(pollIntervalMs, 'pollIntervalMs');
    this.recoveryIntervalMs = positiveInteger(recoveryIntervalMs, 'recoveryIntervalMs');
    this.maxConcurrency = positiveInteger(maxConcurrency, 'maxConcurrency');
    this.scanLimit = positiveInteger(scanLimit, 'scanLimit');
    this.heartbeatIntervalMs = nonNegativeInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');
    this.now = typeof now === 'function' ? now : () => new Date();
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.active = new Map();
    this.timer = null;
    this.tickPromise = null;
    this.controller = null;
    this.running = false;
    this.closing = false;
    this.closed = false;
    this.lastRecoveryAtMs = 0;
    this.metrics = {
      cycles: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      recovered: 0,
      skippedInline: 0,
    };
  }

  start() {
    if (this.closed) throw supervisorError('EXECUTION_WORKER_SUPERVISOR_CLOSED', 'Execution worker supervisor is closed.', 409);
    if (this.running) return this.describe();
    this.closing = false;
    this.running = true;
    this.controller = new AbortController();
    this.#emit('execution.worker.started', { workerId: this.dispatcher.describe?.().workerId || '' });
    this.#schedule(0);
    return this.describe();
  }

  async runOnce({ recover = undefined } = {}) {
    this.#assertAvailable();
    if (this.tickPromise) return this.tickPromise;
    const operation = this.#runCycle({ recover });
    this.tickPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.tickPromise === operation) this.tickPromise = null;
    }
  }

  describe() {
    const queued = this.closed ? [] : this.dispatcher.list({ status: 'queued', limit: this.scanLimit });
    const durableBacklog = queued.filter((execution) => this.handlerRegistry.canDispatch(execution)).length;
    return Object.freeze({
      schemaVersion: 1,
      kind: 'execution_worker_supervisor',
      state: this.closed ? 'closed' : this.closing ? 'closing' : this.running ? 'running' : 'stopped',
      activeExecutions: this.active.size,
      durableBacklog,
      inlineBacklog: queued.length - durableBacklog,
      pollIntervalMs: this.pollIntervalMs,
      recoveryIntervalMs: this.recoveryIntervalMs,
      maxConcurrency: this.maxConcurrency,
      metrics: Object.freeze({ ...this.metrics }),
      handlers: this.handlerRegistry.describe(),
    });
  }

  async close({ timeoutMs = 8_000 } = {}) {
    if (this.closed) return this.describe();
    if (this.closing) return this.#waitForClose(timeoutMs);
    this.closing = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(new Error('worker_supervisor_shutdown'));

    const deadline = Date.now() + positiveInteger(timeoutMs, 'timeoutMs');
    await settleWithin(Promise.allSettled([
      ...(this.tickPromise ? [this.tickPromise] : []),
      ...[...this.active.values()].map(({ promise }) => promise),
    ]), Math.max(1, deadline - Date.now()));

    const timedOut = [...this.active.values()];
    for (const operation of timedOut) {
      try {
        this.dispatcher.reconcile(operation.claim, {
          reason: 'worker_supervisor_shutdown_timeout',
          preserveUnknownEffect: true,
        });
      } catch { /* A successor or terminal state already owns the result. */ }
    }
    this.active.clear();
    this.closed = true;
    this.closing = false;
    this.#emit('execution.worker.stopped', { timedOut: timedOut.length });
    return this.describe();
  }

  async #waitForClose(timeoutMs) {
    const deadline = Date.now() + positiveInteger(timeoutMs, 'timeoutMs');
    while (!this.closed && Date.now() < deadline) await delay(10);
    return this.describe();
  }

  async #runCycle({ recover = undefined } = {}) {
    if (!this.running || this.closing || this.closed) return cycleResult();
    this.metrics.cycles += 1;
    const nowMs = timeMs(this.now());
    const shouldRecover = recover === true
      || (recover !== false && nowMs - this.lastRecoveryAtMs >= this.recoveryIntervalMs);
    let recovered = [];
    if (shouldRecover) {
      recovered = await this.dispatcher.recoverExpired({ limit: this.scanLimit });
      this.lastRecoveryAtMs = nowMs;
      this.metrics.recovered += recovered.length;
    }
    if (!this.running || this.closing || this.closed) return cycleResult({ recovered });

    const capacity = Math.max(0, this.maxConcurrency - this.active.size);
    if (!capacity) return cycleResult({ recovered });
    const queued = this.dispatcher.list({ status: 'queued', limit: this.scanLimit });
    const candidates = [];
    for (const execution of queued) {
      const definition = this.handlerRegistry.resolveExecution(execution);
      if (!definition || definition.dispatchMode !== 'durable') {
        this.metrics.skippedInline += 1;
        continue;
      }
      candidates.push({ execution, definition });
      if (candidates.length >= capacity) break;
    }

    const claimed = [];
    for (const candidate of candidates) {
      if (!this.running || this.closing || this.closed) break;

      // claim() emits synchronously. Publish a reservation before that call so
      // an event observer which starts shutdown cannot make the claim invisible
      // to close() and let a handler cross an effect boundary afterwards.
      const reservation = deferred();
      const reservationOperation = {
        claim: null,
        handlerKey: candidate.definition.key,
        promise: reservation.promise,
      };
      this.active.set(candidate.execution.executionId, reservationOperation);

      let claim = null;
      try {
        claim = this.dispatcher.claim(candidate.execution.executionId);
      } catch (error) {
        this.metrics.failed += 1;
        this.#emit('execution.worker.claim_failed', {
          executionId: candidate.execution.executionId,
          error: String(error?.message || error),
        });
      }

      if (!claim) {
        this.active.delete(candidate.execution.executionId);
        reservation.resolve();
        continue;
      }

      reservationOperation.claim = claim;
      if (!this.running || this.closing || this.closed) {
        try {
          this.dispatcher.reconcile(claim, {
            reason: 'worker_supervisor_shutdown_before_start',
            preserveUnknownEffect: true,
          });
        } catch { /* A successor or terminal state owns the result. */ }
        this.active.delete(candidate.execution.executionId);
        reservation.resolve();
        break;
      }

      claimed.push(claim.executionId);
      this.metrics.claimed += 1;
      const operation = {
        claim,
        handlerKey: candidate.definition.key,
        promise: null,
      };
      operation.promise = Promise.resolve().then(() => this.dispatcher.execute(claim, {
        handlerKey: candidate.definition.key,
        signal: this.controller?.signal || null,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
      })).then((execution) => {
        if (execution?.status === 'succeeded' || execution?.status === 'cancelled') this.metrics.completed += 1;
        else this.metrics.failed += 1;
        return execution;
      }).catch((error) => {
        this.metrics.failed += 1;
        this.#emit('execution.worker.operation_failed', {
          executionId: claim.executionId,
          error: String(error?.message || error),
        });
        return null;
      }).finally(() => {
        this.active.delete(claim.executionId);
        if (this.running && !this.closing && !this.closed) this.#schedule(0);
      });
      this.active.set(claim.executionId, operation);
      reservation.resolve();
    }
    return cycleResult({ recovered, claimed });
  }

  #schedule(delayMs) {
    if (!this.running || this.closing || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().catch((error) => {
        this.metrics.failed += 1;
        this.#emit('execution.worker.cycle_failed', { error: String(error?.message || error) });
      }).finally(() => {
        if (this.running && !this.closing && !this.closed) this.#schedule(this.pollIntervalMs);
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  #emit(type, payload) {
    try { this.emit({ type, occurredAt: new Date(timeMs(this.now())).toISOString(), payload }); } catch { /* Observers are non-authoritative. */ }
  }

  #assertAvailable() {
    if (this.closed) throw supervisorError('EXECUTION_WORKER_SUPERVISOR_CLOSED', 'Execution worker supervisor is closed.', 409);
  }
}

export class ExecutionWorkerSupervisorError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'ExecutionWorkerSupervisorError';
    this.code = code;
    this.status = status;
  }
}

export function createExecutionWorkerSupervisor(options = {}) {
  return new ExecutionWorkerSupervisor(options);
}

function requireDispatcher(dispatcher) {
  const methods = ['claim', 'describe', 'execute', 'list', 'recoverExpired', 'reconcile'];
  if (!dispatcher || methods.some((method) => typeof dispatcher[method] !== 'function')) {
    throw supervisorError(
      'EXECUTION_WORKER_DISPATCHER_INVALID',
      `dispatcher must implement ${methods.join(', ')}.`,
    );
  }
  return dispatcher;
}

function requireHandlerRegistry(registry) {
  const methods = ['canDispatch', 'describe', 'resolveExecution'];
  if (!registry || methods.some((method) => typeof registry[method] !== 'function')) {
    throw supervisorError(
      'EXECUTION_WORKER_HANDLER_REGISTRY_INVALID',
      `handlerRegistry must implement ${methods.join(', ')}.`,
    );
  }
  return registry;
}

function cycleResult({ recovered = [], claimed = [] } = {}) {
  return Object.freeze({
    recovered: Object.freeze([...recovered]),
    claimed: Object.freeze([...claimed]),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw supervisorError('EXECUTION_WORKER_CLOCK_INVALID', 'Worker clock returned an invalid date.');
  return ms;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw supervisorError('EXECUTION_WORKER_NUMBER_INVALID', `${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw supervisorError('EXECUTION_WORKER_NUMBER_INVALID', `${name} must be a non-negative integer.`);
  }
  return parsed;
}

function supervisorError(code, message, status = 400) {
  return new ExecutionWorkerSupervisorError(code, message, status);
}
