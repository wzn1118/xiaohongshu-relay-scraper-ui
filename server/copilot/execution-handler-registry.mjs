const DISPATCH_MODES = new Set(['durable', 'inline']);

/**
 * Process-local handlers with durable, versioned identities.
 *
 * Functions cannot be persisted. Executions therefore store a stable handler
 * key/version while every worker recreates the matching definition at boot.
 * The dispatch mode prevents request-coupled handlers whose payload only lives
 * in memory from being claimed by the background worker.
 */
export class ExecutionHandlerRegistry {
  constructor({ dispatcher = null } = {}) {
    this.dispatcher = compatibleDispatcher(dispatcher);
    this.definitions = new Map();
    this.closed = false;
  }

  register(key, handler, {
    version = '1',
    dispatchMode = 'durable',
    executionKinds = [],
    effectClass = 'non_idempotent',
    idempotencyPolicy = null,
    retryPolicy = null,
    maxRetries = 1,
  } = {}) {
    this.#assertOpen();
    const handlerKey = requiredText(key, 'key');
    if (typeof handler !== 'function') {
      throw registryError('EXECUTION_HANDLER_REQUIRED', 'handler must be a function.');
    }
    if (this.definitions.has(handlerKey)) {
      throw registryError(
        'EXECUTION_HANDLER_CONFLICT',
        `Execution handler "${handlerKey}" is already registered.`,
        409,
      );
    }
    const mode = normalizeDispatchMode(dispatchMode);
    const kinds = normalizeKinds(executionKinds, handlerKey);
    const definition = Object.freeze({
      key: handlerKey,
      version: requiredText(version, 'version'),
      dispatchMode: mode,
      executionKinds: Object.freeze(kinds),
      effectClass: normalizeEffectClass(effectClass),
      idempotencyPolicy,
      retryPolicy,
      maxRetries: nonNegativeInteger(maxRetries, 'maxRetries'),
      handler,
    });
    const unregisterDispatcher = this.dispatcher?.registerHandler(handlerKey, handler, {
      effectClass: definition.effectClass,
      idempotencyPolicy,
      retryPolicy,
      maxRetries: definition.maxRetries,
    }) || null;
    this.definitions.set(handlerKey, { definition, unregisterDispatcher });

    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const current = this.definitions.get(handlerKey);
      if (current?.definition !== definition) return false;
      this.definitions.delete(handlerKey);
      try { current.unregisterDispatcher?.(); } catch { /* Dispatcher may already be closed. */ }
      return true;
    };
  }

  get(key) {
    this.#assertOpen();
    return this.definitions.get(requiredText(key, 'key'))?.definition || null;
  }

  list({ dispatchMode = '' } = {}) {
    this.#assertOpen();
    const mode = dispatchMode ? normalizeDispatchMode(dispatchMode) : '';
    return [...this.definitions.values()]
      .map(({ definition }) => definition)
      .filter((definition) => !mode || definition.dispatchMode === mode)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  resolveExecution(execution, { dispatchMode = '' } = {}) {
    this.#assertOpen();
    const key = executionHandlerKey(execution);
    if (!key) return null;
    const definition = this.definitions.get(key)?.definition || null;
    if (!definition) return null;
    if (dispatchMode && definition.dispatchMode !== normalizeDispatchMode(dispatchMode)) return null;
    if (!definition.executionKinds.includes(String(execution?.kind || ''))) return null;
    const storedVersion = String(execution?.metadata?.dispatcher?.handlerVersion || '').trim();
    if (storedVersion && storedVersion !== definition.version) return null;
    return definition;
  }

  canDispatch(execution) {
    return Boolean(this.resolveExecution(execution, { dispatchMode: 'durable' }));
  }

  metadataFor(key, metadata = {}) {
    this.#assertOpen();
    const definition = this.get(key);
    if (!definition) {
      throw registryError('EXECUTION_HANDLER_NOT_FOUND', `Execution handler "${key}" is not registered.`, 404);
    }
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const dispatcher = base.dispatcher && typeof base.dispatcher === 'object' && !Array.isArray(base.dispatcher)
      ? base.dispatcher
      : {};
    return {
      ...base,
      dispatcher: {
        ...dispatcher,
        handlerKey: definition.key,
        handlerVersion: definition.version,
        dispatchMode: definition.dispatchMode,
      },
    };
  }

  describe() {
    return Object.freeze({
      schemaVersion: 1,
      kind: 'execution_handler_registry',
      closed: this.closed,
      handlers: Object.freeze([...this.definitions.values()]
        .map(({ definition }) => Object.freeze({
          key: definition.key,
          version: definition.version,
          dispatchMode: definition.dispatchMode,
          executionKinds: definition.executionKinds,
          effectClass: definition.effectClass,
          maxRetries: definition.maxRetries,
        }))
        .sort((left, right) => left.key.localeCompare(right.key))),
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { unregisterDispatcher } of this.definitions.values()) {
      try { unregisterDispatcher?.(); } catch { /* Dispatcher may already be closed. */ }
    }
    this.definitions.clear();
  }

  #assertOpen() {
    if (this.closed) {
      throw registryError('EXECUTION_HANDLER_REGISTRY_CLOSED', 'Execution handler registry is closed.', 409);
    }
  }
}

export class ExecutionHandlerRegistryError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'ExecutionHandlerRegistryError';
    this.code = code;
    this.status = status;
  }
}

export function createExecutionHandlerRegistry(options = {}) {
  return new ExecutionHandlerRegistry(options);
}

export function executionHandlerKey(execution) {
  return String(execution?.metadata?.dispatcher?.handlerKey || execution?.kind || '').trim();
}

function compatibleDispatcher(dispatcher) {
  if (dispatcher === null || dispatcher === undefined) return null;
  if (typeof dispatcher.registerHandler !== 'function') {
    throw registryError(
      'EXECUTION_HANDLER_DISPATCHER_INVALID',
      'dispatcher must implement registerHandler().',
    );
  }
  return dispatcher;
}

function normalizeDispatchMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!DISPATCH_MODES.has(mode)) {
    throw registryError(
      'EXECUTION_HANDLER_DISPATCH_MODE_INVALID',
      'dispatchMode must be "durable" or "inline".',
    );
  }
  return mode;
}

function normalizeKinds(value, fallback) {
  const source = Array.isArray(value) ? value : value ? [value] : [fallback];
  const kinds = [...new Set(source.map((kind) => String(kind || '').trim()).filter(Boolean))];
  if (!kinds.length) throw registryError('EXECUTION_HANDLER_KIND_REQUIRED', 'executionKinds must not be empty.');
  return kinds.sort();
}

function normalizeEffectClass(value) {
  const effectClass = String(value || '').trim();
  if (['read', 'idempotent_write', 'non_idempotent'].includes(effectClass)) return effectClass;
  throw registryError(
    'EXECUTION_HANDLER_EFFECT_CLASS_INVALID',
    'effectClass must be read, idempotent_write, or non_idempotent.',
  );
}

function requiredText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw registryError('EXECUTION_HANDLER_FIELD_REQUIRED', `${name} must not be empty.`);
  return text;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw registryError('EXECUTION_HANDLER_NUMBER_INVALID', `${name} must be a non-negative integer.`);
  }
  return parsed;
}

function registryError(code, message, status = 400) {
  return new ExecutionHandlerRegistryError(code, message, status);
}
