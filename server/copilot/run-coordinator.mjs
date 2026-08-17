import crypto from 'node:crypto';

import { createOrchestrator, TaskGraph, TaskGraphError } from './orchestrator.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class RunCoordinator {
  constructor({ store, orchestrator = createOrchestrator(), now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!store) throw coordinatorError('RUN_STORE_REQUIRED', 'A durable production store is required.');
    this.store = store;
    this.orchestrator = orchestrator;
    this.now = now;
    this.idFactory = idFactory;
    this.active = new Map();
    this.recoveredRunIds = this.#recoverInterruptedRuns();
  }

  async execute(value = {}) {
    const runId = String(value.runId || this.idFactory());
    if (this.active.has(runId)) throw coordinatorError('RUN_ALREADY_ACTIVE', `Run ${runId} is already active.`, 409);
    const conversationId = required(value.conversationId, 'conversationId');
    const turnId = String(value.turnId || this.idFactory());
    const tasks = normalizeTasks(value.tasks);
    const planRevision = Math.max(1, Number(value.planRevision || 1));
    const now = this.now().toISOString();
    this.store.upsertTurn({
      turnId,
      conversationId,
      goal: String(value.goal || ''),
      mode: String(value.mode || 'analyze'),
      status: 'running',
      contract: value.contract || {},
      createdAt: value.createdAt || now,
      updatedAt: now,
    });
    this.store.upsertRun({
      runId,
      turnId,
      conversationId,
      status: 'running',
      planRevision,
      provider: value.provider,
      model: value.model,
      responseId: value.responseId,
      previousResponseId: value.previousResponseId,
      responseCursor: value.responseCursor,
      background: value.background,
      checkpoint: { boundary: 'run_started', planRevision },
      startedAt: value.startedAt || now,
      updatedAt: now,
    });
    this.#persistPlan(runId, planRevision, tasks, String(value.planReason || 'initial'));
    const controller = new AbortController();
    let resolveSettled;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const active = { runId, turnId, conversationId, controller, intent: 'run', startedAt: now, settled };
    this.active.set(runId, active);
    try {
      const graph = new TaskGraph(tasks);
      const result = await this.orchestrator.run(
        graph,
        value.executeTask,
        {
          signal: controller.signal,
          budget: value.budget || {},
          onEvent: (event) => {
            this.#projectEvent(runId, planRevision, tasks, event);
            value.onEvent?.({ ...event, runId, turnId, conversationId, planRevision });
          },
        },
      );
      const completedAt = this.now().toISOString();
      const run = this.store.upsertRun({
        ...this.store.getRun(runId),
        status: 'completed',
        planRevision,
        checkpoint: { boundary: 'run_completed', planRevision, outputs: Object.keys(result.outputs || {}) },
        completedAt,
        updatedAt: completedAt,
      });
      this.store.upsertTurn({ ...this.store.getTurn(turnId), status: 'completed', updatedAt: completedAt });
      value.onEvent?.({ type: 'run.completed', runId, turnId, conversationId, planRevision, occurredAt: completedAt });
      return { ...result, run, turn: this.store.getTurn(turnId), nodes: this.store.listRunNodes(runId) };
    } catch (error) {
      const activeIntent = active.intent;
      const status = activeIntent === 'pause' ? 'paused' : activeIntent === 'cancel' ? 'cancelled' : 'failed';
      const occurredAt = this.now().toISOString();
      const structured = classifyRunError(error);
      this.store.upsertRun({
        ...this.store.getRun(runId),
        status,
        planRevision,
        checkpoint: { boundary: status, planRevision, resumable: status === 'paused' || structured.retryable },
        error: status === 'paused' ? {} : structured,
        completedAt: TERMINAL.has(status) ? occurredAt : '',
        updatedAt: occurredAt,
      });
      this.store.upsertTurn({ ...this.store.getTurn(turnId), status, updatedAt: occurredAt });
      value.onEvent?.({ type: `run.${status}`, runId, turnId, conversationId, planRevision, error: structured, occurredAt });
      if (status === 'paused' || status === 'cancelled') return this.getState(runId);
      throw error;
    } finally {
      this.active.delete(runId);
      resolveSettled();
    }
  }

  start(value = {}) {
    const runId = String(value.runId || this.idFactory());
    const completion = this.execute({ ...value, runId });
    completion.catch(() => {});
    return { runId, completion };
  }

  pause(runId) {
    const active = this.active.get(required(runId, 'runId'));
    if (!active) return false;
    active.intent = 'pause';
    active.controller.abort(new TaskGraphError('TASK_RUN_PAUSED', 'Run execution was paused.'));
    return true;
  }

  cancel(runId) {
    const id = required(runId, 'runId');
    const active = this.active.get(id);
    if (active) {
      active.intent = 'cancel';
      active.controller.abort(new TaskGraphError('TASK_RUN_ABORTED', 'Run execution was cancelled.'));
      return true;
    }
    const run = this.store.getRun(id);
    if (!run || TERMINAL.has(run.status)) return false;
    const now = this.now().toISOString();
    this.store.upsertRun({ ...run, status: 'cancelled', completedAt: now, updatedAt: now });
    if (run.turnId) {
      const turn = this.store.getTurn(run.turnId);
      if (turn) this.store.upsertTurn({ ...turn, status: 'cancelled', updatedAt: now });
    }
    return true;
  }

  async resume(runId, value = {}) {
    const state = this.getState(runId);
    if (!state.run) throw coordinatorError('RUN_NOT_FOUND', `Run ${runId} was not found.`, 404);
    if (!['paused', 'failed', 'queued'].includes(state.run.status)) {
      throw coordinatorError('RUN_NOT_RESUMABLE', `Run ${runId} is ${state.run.status}.`, 409);
    }
    const persistedTasks = state.nodes.map((node) => ({
      id: node.nodeId,
      kind: node.kind,
      title: node.title,
      dependsOn: node.dependsOn,
      input: node.input,
      output: node.output,
      status: node.status === 'completed' ? 'completed' : 'pending',
      timeoutMs: node.checkpoint.timeoutMs,
      budgetUnits: node.checkpoint.budgetUnits,
      idempotencyKey: node.checkpoint.idempotencyKey,
      contract: node.checkpoint.contract,
    }));
    const tasks = Array.isArray(value.tasks) && value.tasks.length ? normalizeTasks(value.tasks) : persistedTasks;
    return this.execute({
      ...value,
      runId: state.run.runId,
      turnId: state.run.turnId,
      conversationId: state.run.conversationId,
      tasks,
      planRevision: Number(value.planRevision || state.run.planRevision),
      startedAt: state.run.startedAt,
      provider: value.provider || state.run.provider,
      model: value.model || state.run.model,
      responseId: value.responseId || state.run.responseId,
      previousResponseId: value.previousResponseId || state.run.previousResponseId,
      responseCursor: value.responseCursor || state.run.responseCursor,
      background: value.background ?? state.run.background,
      goal: value.goal ?? state.turn?.goal,
      mode: value.mode ?? state.turn?.mode,
      contract: value.contract ?? state.turn?.contract,
    });
  }

  async steer(runId, { reason = 'user_steer', tasks = [], ...value } = {}) {
    const id = required(runId, 'runId');
    const active = this.active.get(id);
    if (active) {
      this.pause(id);
      await active.settled;
    }
    const state = this.getState(id);
    if (!state.run) throw coordinatorError('RUN_NOT_FOUND', `Run ${id} was not found.`, 404);
    const revision = state.run.planRevision + 1;
    const completed = state.nodes.filter((node) => node.status === 'completed').map((node) => ({
      id: node.nodeId,
      kind: node.kind,
      title: node.title,
      dependsOn: node.dependsOn,
      input: node.input,
      output: node.output,
      status: 'completed',
    }));
    const revised = mergeTasks(completed, normalizeTasks(tasks));
    this.#persistPlan(id, revision, revised, String(reason));
    const now = this.now().toISOString();
    this.store.upsertRun({ ...state.run, status: 'queued', planRevision: revision, checkpoint: { boundary: 'steered', planRevision: revision }, updatedAt: now });
    return this.resume(id, { ...value, tasks: revised, planRevision: revision });
  }

  getState(runId) {
    const run = this.store.getRun(required(runId, 'runId'));
    return {
      schemaVersion: 2,
      run,
      turn: run?.turnId ? this.store.getTurn(run.turnId) : null,
      planRevisions: run ? this.store.listPlanRevisions(run.runId) : [],
      nodes: run ? this.store.listRunNodes(run.runId) : [],
      attempts: run ? this.store.listNodeAttempts({ runId: run.runId }) : [],
      active: Boolean(run && this.active.has(run.runId)),
    };
  }

  #persistPlan(runId, revision, tasks, reason) {
    this.store.recordPlanRevision({ runId, revision, reason, plan: { schemaVersion: 2, nodes: tasks } });
    const persisted = new Map(this.store.listRunNodes(runId).map((node) => [node.nodeId, node]));
    for (const task of tasks) {
      const existing = persisted.get(task.id);
      const completed = task.status === 'completed' || existing?.status === 'completed';
      this.store.upsertRunNode({
        ...existing,
        runId,
        nodeId: task.id,
        planRevision: revision,
        kind: task.kind,
        title: task.title,
        status: completed ? 'completed' : task.status,
        dependsOn: task.dependsOn,
        input: task.input || {},
        output: task.output ?? existing?.output,
        attemptCount: Number(existing?.attemptCount || 0),
        checkpoint: { ...existing?.checkpoint, ...taskMetadata(task) },
      });
    }
  }

  #projectEvent(runId, planRevision, tasks, event) {
    const task = tasks.find((item) => item.id === event.taskId) || { id: event.taskId };
    const existing = this.store.listRunNodes(runId).find((node) => node.nodeId === event.taskId);
    const occurredAt = String(event.occurredAt || this.now().toISOString());
    if (event.type === 'task.started') {
      const attempt = Number(existing?.attemptCount || 0) + 1;
      this.store.upsertRunNode({ ...existing, runId, nodeId: task.id, status: 'running', attemptCount: attempt, updatedAt: occurredAt });
      this.store.recordNodeAttempt({ runId, nodeId: task.id, attempt, status: 'running', input: task.input || {}, startedAt: occurredAt });
    } else if (event.type === 'task.completed' || event.type === 'task.reused') {
      const attempt = Math.max(1, Number(existing?.attemptCount || 1));
      this.store.upsertRunNode({ ...existing, runId, nodeId: task.id, status: 'completed', output: event.output ?? existing?.output, attemptCount: attempt, checkpoint: { ...taskMetadata(task), boundary: event.type }, updatedAt: occurredAt });
      this.store.recordNodeAttempt({ runId, nodeId: task.id, attempt, status: 'completed', input: task.input || {}, output: event.output ?? existing?.output, checkpoint: { boundary: event.type, planRevision }, startedAt: existing?.updatedAt || occurredAt, completedAt: occurredAt });
    } else if (event.type === 'task.failed') {
      const attempt = Math.max(1, Number(existing?.attemptCount || 1));
      const error = { code: 'TASK_FAILED', message: String(event.error || 'Task failed.') };
      this.store.upsertRunNode({ ...existing, runId, nodeId: task.id, status: 'failed', error, updatedAt: occurredAt });
      this.store.recordNodeAttempt({ runId, nodeId: task.id, attempt, status: 'failed', input: task.input || {}, error, startedAt: existing?.updatedAt || occurredAt, completedAt: occurredAt });
    }
    this.store.upsertRun({ ...this.store.getRun(runId), status: 'running', checkpoint: { boundary: event.type, nodeId: event.taskId, planRevision }, updatedAt: occurredAt });
  }

  #recoverInterruptedRuns() {
    if (typeof this.store.listRuns !== 'function') return [];
    const interrupted = this.store.listRuns({ status: 'running', limit: 10_000 });
    for (const run of interrupted) {
      const recoveredAt = this.now().toISOString();
      for (const node of this.store.listRunNodes(run.runId)) {
        if (node.status !== 'running') continue;
        const attempt = this.store.listNodeAttempts({ runId: run.runId, nodeId: node.nodeId })
          .findLast((item) => item.status === 'running');
        if (attempt) {
          this.store.recordNodeAttempt({
            ...attempt,
            status: 'failed',
            error: { code: 'RUN_INTERRUPTED', message: 'The process stopped before this node completed.' },
            checkpoint: { ...attempt.checkpoint, boundary: 'process_recovered' },
            completedAt: recoveredAt,
          });
        }
        this.store.upsertRunNode({
          ...node,
          status: 'pending',
          error: {},
          checkpoint: { ...node.checkpoint, boundary: 'process_recovered' },
          updatedAt: recoveredAt,
        });
      }
      this.store.upsertRun({
        ...run,
        status: 'paused',
        checkpoint: { ...run.checkpoint, boundary: 'process_recovered', resumable: true, recoveredAt },
        error: { code: 'RUN_INTERRUPTED', message: 'The previous process stopped while this run was active.' },
        updatedAt: recoveredAt,
      });
      if (run.turnId) {
        const turn = this.store.getTurn(run.turnId);
        if (turn) this.store.upsertTurn({ ...turn, status: 'paused', updatedAt: recoveredAt });
      }
    }
    return interrupted.map((run) => run.runId);
  }
}

export function createRunCoordinator(options) { return new RunCoordinator(options); }

function normalizeTasks(value) {
  const tasks = Array.isArray(value) ? value : [];
  if (!tasks.length) throw coordinatorError('RUN_PLAN_EMPTY', 'At least one plan node is required.');
  return tasks.map((task) => ({
    ...structuredClone(task),
    id: required(task.id || task.nodeId, 'task.id'),
    kind: String(task.kind || task.toolName || 'analysis'),
    title: String(task.title || task.id || task.nodeId),
    dependsOn: Array.isArray(task.dependsOn) ? [...new Set(task.dependsOn.map(String))] : [],
    status: task.status === 'completed' ? 'completed' : 'pending',
  }));
}

function mergeTasks(left, right) {
  const merged = new Map(left.map((task) => [task.id, task]));
  for (const task of right) merged.set(task.id, task);
  return [...merged.values()];
}

function taskMetadata(task) {
  return {
    timeoutMs: task.timeoutMs,
    budgetUnits: task.budgetUnits,
    idempotencyKey: task.idempotencyKey,
    contract: task.contract || {},
  };
}

function classifyRunError(error) {
  const code = String(error?.code || 'RUN_FAILED');
  return {
    code,
    message: String(error?.message || error || 'Run failed.').slice(0, 2000),
    retryable: ['TASK_TIMEOUT', 'TASK_RUN_TIMEOUT', 'MODEL_REQUEST_FAILED', 'MODEL_REQUEST_ABORTED'].includes(code),
  };
}

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw coordinatorError('RUN_VALUE_REQUIRED', `${name} is required.`);
  return text;
}

function coordinatorError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
