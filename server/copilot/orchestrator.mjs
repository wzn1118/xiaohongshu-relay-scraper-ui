export class TaskGraphError extends Error {
  constructor(code, message) { super(message); this.name = 'TaskGraphError'; this.code = code; }
}

export class TaskGraph {
  constructor(tasks = []) {
    this.tasks = new Map();
    for (const task of tasks) this.add(task);
    this.#assertAcyclic();
  }

  add(value = {}) {
    const id = String(value.id || '').trim();
    if (!id || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(id)) throw new TaskGraphError('TASK_ID_INVALID', 'Task IDs must be short stable identifiers.');
    if (this.tasks.has(id)) throw new TaskGraphError('TASK_DUPLICATE', `Task ${id} is duplicated.`);
    const dependsOn = [...new Set((Array.isArray(value.dependsOn) ? value.dependsOn : []).map(String))];
    this.tasks.set(id, {
      id,
      kind: String(value.kind || 'analysis'),
      title: String(value.title || id),
      dependsOn,
      status: normalizeStatus(value.status),
      input: value.input ?? null,
      output: value.output ?? null,
      error: value.error ?? null,
      timeoutMs: bounded(value.timeoutMs, 30_000, 100, 300_000),
      budgetUnits: bounded(value.budgetUnits, 1, 1, 1000),
      idempotencyKey: String(value.idempotencyKey || '').trim().slice(0, 240),
      contract: normalizeContract(value.contract),
    });
    return this.get(id);
  }

  get(id) { return structuredClone(this.tasks.get(String(id)) || null); }
  ready() { return [...this.tasks.values()].filter((task) => task.status === 'pending' && task.dependsOn.every((id) => this.tasks.get(id)?.status === 'completed')).map((task) => structuredClone(task)); }
  markStarted(id) { return this.#transition(id, 'running'); }
  markCompleted(id, output = null) { const task = this.#transition(id, 'completed'); this.tasks.get(task.id).output = structuredClone(output); return this.get(task.id); }
  markFailed(id, error) { const task = this.#transition(id, 'failed'); this.tasks.get(task.id).error = String(error?.message || error || 'Task failed'); return this.get(task.id); }
  snapshot() { return { schemaVersion: 2, tasks: [...this.tasks.values()].map((task) => structuredClone(task)) }; }

  #transition(id, status) {
    const task = this.tasks.get(String(id));
    if (!task) throw new TaskGraphError('TASK_NOT_FOUND', `Task ${id} was not found.`);
    if (status === 'running' && task.status !== 'pending') throw new TaskGraphError('TASK_TRANSITION_INVALID', `Task ${id} is not pending.`);
    if (status === 'completed' && task.status !== 'running') throw new TaskGraphError('TASK_TRANSITION_INVALID', `Task ${id} is not running.`);
    task.status = status;
    return structuredClone(task);
  }

  #assertAcyclic() {
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new TaskGraphError('TASK_CYCLE', `Task graph contains a cycle at ${id}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      const task = this.tasks.get(id);
      for (const dependency of task.dependsOn) {
        if (!this.tasks.has(dependency)) throw new TaskGraphError('TASK_DEPENDENCY_MISSING', `Task ${id} depends on missing task ${dependency}.`);
        visit(dependency);
      }
      visiting.delete(id); visited.add(id);
    };
    for (const id of this.tasks.keys()) visit(id);
  }
}

export class Orchestrator {
  constructor({ now = () => new Date(), concurrency = 3, cacheLimit = 1000 } = {}) {
    this.now = now;
    this.concurrency = Math.max(1, Math.min(8, Number(concurrency) || 3));
    this.cacheLimit = bounded(cacheLimit, 1000, 0, 10_000);
    this.cache = new Map();
  }

  async run(graph, executeTask, { signal, onEvent = () => {}, budget = {} } = {}) {
    if (!(graph instanceof TaskGraph)) throw new TaskGraphError('TASK_GRAPH_REQUIRED', 'A TaskGraph is required.');
    if (typeof executeTask !== 'function') throw new TaskGraphError('TASK_EXECUTOR_REQUIRED', 'A task executor is required.');
    const limits = {
      maxTasks: bounded(budget.maxTasks, 100, 1, 1000),
      maxUnits: bounded(budget.maxUnits, 1000, 1, 1_000_000),
      maxDurationMs: bounded(budget.maxDurationMs, 300_000, 100, 3_600_000),
    };
    const taskCount = graph.snapshot().tasks.length;
    if (taskCount > limits.maxTasks) throw new TaskGraphError('TASK_BUDGET_EXCEEDED', `Task graph has ${taskCount} tasks; the limit is ${limits.maxTasks}.`);
    const startedAt = Date.now();
    let consumedUnits = 0;
    let reusedTasks = 0;
    const outputs = new Map(
      graph.snapshot().tasks
        .filter((task) => task.status === 'completed')
        .map((task) => [task.id, structuredClone(task.output)]),
    );
    while (graph.ready().length) {
      if (signal?.aborted) throw new TaskGraphError('TASK_RUN_ABORTED', 'Task graph execution was aborted.');
      if (Date.now() - startedAt >= limits.maxDurationMs) throw new TaskGraphError('TASK_RUN_TIMEOUT', `Task graph exceeded ${limits.maxDurationMs} ms.`);
      const batch = graph.ready().slice(0, this.concurrency);
      const batchUnits = batch.reduce((sum, task) => sum + task.budgetUnits, 0);
      if (consumedUnits + batchUnits > limits.maxUnits) throw new TaskGraphError('TASK_BUDGET_EXCEEDED', `Task graph exceeded ${limits.maxUnits} budget units.`);
      consumedUnits += batchUnits;
      await Promise.all(batch.map(async (task) => {
        graph.markStarted(task.id);
        const cached = task.idempotencyKey ? this.cache.get(task.idempotencyKey) : undefined;
        if (cached !== undefined) {
          const output = structuredClone(cached);
          outputs.set(task.id, output);
          graph.markCompleted(task.id, output);
          reusedTasks += 1;
          onEvent({ type: 'task.reused', taskId: task.id, idempotencyKey: task.idempotencyKey, occurredAt: this.now().toISOString() });
          return;
        }
        onEvent({ type: 'task.started', taskId: task.id, occurredAt: this.now().toISOString() });
        try {
          const remainingMs = Math.max(1, limits.maxDurationMs - (Date.now() - startedAt));
          const output = await executeWithControls(
            (taskSignal) => executeTask(task, { outputs, signal: taskSignal }),
            { signal, timeoutMs: Math.min(task.timeoutMs, remainingMs), taskId: task.id },
          );
          validateOutputContract(task, output);
          outputs.set(task.id, output);
          graph.markCompleted(task.id, output);
          if (task.idempotencyKey) this.#cache(task.idempotencyKey, output);
          onEvent({ type: 'task.completed', taskId: task.id, output, occurredAt: this.now().toISOString() });
        } catch (error) {
          graph.markFailed(task.id, error);
          onEvent({ type: 'task.failed', taskId: task.id, error: String(error?.message || error), occurredAt: this.now().toISOString() });
          throw error;
        }
      }));
    }
    const unfinished = graph.snapshot().tasks.filter((task) => ['pending', 'running'].includes(task.status));
    if (unfinished.length) throw new TaskGraphError('TASK_GRAPH_STALLED', `Task graph stalled at ${unfinished.map((task) => task.id).join(', ')}.`);
    return {
      schemaVersion: 2,
      graph: graph.snapshot(),
      outputs: Object.fromEntries(outputs),
      governance: { taskCount, consumedUnits, reusedTasks, durationMs: Date.now() - startedAt, limits },
    };
  }

  #cache(key, value) {
    if (this.cacheLimit === 0) return;
    this.cache.set(key, structuredClone(value));
    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
  }
}

export function createOrchestrator(options) { return new Orchestrator(options); }
function normalizeStatus(value) { return ['pending', 'running', 'completed', 'failed'].includes(value) ? value : 'pending'; }

function normalizeContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { requiredKeys: [], outputType: '' };
  return {
    requiredKeys: [...new Set((Array.isArray(value.requiredKeys) ? value.requiredKeys : []).map(String).filter(Boolean))].slice(0, 100),
    outputType: ['array', 'object', 'string', 'number', 'boolean'].includes(String(value.outputType)) ? String(value.outputType) : '',
  };
}

function validateOutputContract(task, output) {
  const { requiredKeys, outputType } = task.contract;
  const actualType = Array.isArray(output) ? 'array' : output === null ? 'null' : typeof output;
  if (outputType && actualType !== outputType) throw new TaskGraphError('TASK_OUTPUT_CONTRACT_FAILED', `Task ${task.id} must return ${outputType}, received ${actualType}.`);
  if (requiredKeys.length) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TaskGraphError('TASK_OUTPUT_CONTRACT_FAILED', `Task ${task.id} must return an object.`);
    const missing = requiredKeys.filter((key) => !Object.hasOwn(output, key));
    if (missing.length) throw new TaskGraphError('TASK_OUTPUT_CONTRACT_FAILED', `Task ${task.id} is missing output keys: ${missing.join(', ')}.`);
  }
}

function executeWithControls(operation, { signal, timeoutMs, taskId }) {
  if (signal?.aborted) return Promise.reject(new TaskGraphError('TASK_RUN_ABORTED', 'Task graph execution was aborted.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      controller.abort(signal?.reason);
      finish(reject, new TaskGraphError('TASK_RUN_ABORTED', 'Task graph execution was aborted.'));
    };
    const timer = setTimeout(() => {
      controller.abort(new TaskGraphError('TASK_TIMEOUT', `Task ${taskId} exceeded ${timeoutMs} ms.`));
      finish(reject, controller.signal.reason);
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => operation(controller.signal)).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}
