import crypto from 'node:crypto';

import { canonicalJson } from './runtime-v3/index.mjs';

const ACTIVE_EXECUTION_STATUSES = Object.freeze(['queued', 'running', 'waiting']);
const ACTIVE_STEP_STATUSES = Object.freeze(['pending', 'claimed', 'running', 'waiting_external']);
const TERMINAL_EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'reconcile_required']);
const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'reconcile_required', 'skipped']);
const DEFAULT_DEADLINE_MS = 120_000;

/**
 * Adds durable, redacted evidence for main-agent model turns. The existing
 * ModelRunBroker remains responsible for provider I/O and streaming; this
 * ledger deliberately stores only hashes and summaries, never prompts,
 * provider credentials, tool arguments, or generated text.
 */
export class ModelTurnLedger {
  constructor({ repository = null, now = () => new Date() } = {}) {
    this.repository = isLedgerRepository(repository) ? repository : null;
    this.now = now;
  }

  get enabled() {
    return Boolean(this.repository);
  }

  async beginTurn({ executionContext = {}, session = {}, messages = [], toolDefinitions = [], round = 1 } = {}) {
    if (!this.repository) return null;

    const root = this.#ensureExecution(executionContext, session);
    const agentKind = publicText(root.metadata?.agentKind, 40)
      || publicText(executionContext?.agentKind, 40)
      || 'main';
    const request = modelRequestSummary({ messages, toolDefinitions, session, round });
    const turnHash = sha256(canonicalJson({
      executionId: root.executionId,
      attempt: executionAttempt(executionContext),
      round: positiveInteger(round, 1),
      request,
    }));
    const ids = {
      artifactId: `model-input-${turnHash.slice(0, 32)}`,
      stepId: `model-step-${turnHash.slice(0, 32)}`,
      inputRef: `runtime-v3://executions/${encodeURIComponent(root.executionId)}/model-inputs/${turnHash}`,
    };
    const inputArtifact = this.repository.createExecutionArtifact({
      artifactId: ids.artifactId,
      executionId: root.executionId,
      kind: 'model.input.digest',
      mimeType: 'application/json',
      contentHash: turnHash,
      storageRef: ids.inputRef,
      sizeBytes: Buffer.byteLength(canonicalJson(request)),
      metadata: {
        redacted: true,
        role: 'model_input',
        round: positiveInteger(round, 1),
        attempt: executionAttempt(executionContext),
        messageCount: request.messageCount,
        toolCount: request.toolCount,
      },
    });
    let step = this.repository.getExecutionStep(ids.stepId);
    if (!step) {
      step = this.repository.createExecutionStep({
        stepId: ids.stepId,
        executionId: root.executionId,
        ordinal: Math.max(0, positiveInteger(round, 1) - 1),
        kind: 'model.turn',
        status: 'pending',
        handlerKey: 'model.turn',
        effectClass: 'read',
        descriptorVersion: 'model-run-broker@1',
        idempotencyKey: `model.turn:${turnHash}`,
        inputRef: inputArtifact.storageRef,
        inputHash: turnHash,
        metadata: {
          agentKind,
          round: positiveInteger(round, 1),
          attempt: executionAttempt(executionContext),
          model: request.model,
          messageCount: request.messageCount,
          toolCount: request.toolCount,
        },
        attempt: 1,
        maxAttempts: 1,
      });
    }
    if (ACTIVE_STEP_STATUSES.includes(step.status)) {
      step = transitionOrRead(
        () => this.repository.transitionExecutionStep(step.stepId, {
          expectedStatuses: ACTIVE_STEP_STATUSES,
          patch: (current) => ({
            status: 'running',
            startedAt: current.startedAt || this.#nowIso(),
            attempt: Math.max(1, current.attempt),
            metadata: { ...current.metadata, state: 'running' },
          }),
          event: {
            type: 'model.turn.started',
            payload: {
              round: positiveInteger(round, 1),
              attempt: executionAttempt(executionContext),
              messageCount: request.messageCount,
              toolCount: request.toolCount,
              model: request.model,
            },
          },
        }).step,
        () => this.repository.getExecutionStep(step.stepId),
      );
    }
    return Object.freeze({
      executionId: root.executionId,
      stepId: step.stepId,
      agentKind,
      turnHash,
      inputRef: inputArtifact.storageRef,
    });
  }

  async completeTurn(handle, response = {}) {
    if (!this.repository || !validHandle(handle)) return null;
    const step = this.repository.getExecutionStep(handle.stepId);
    if (!step) return null;
    const output = modelResponseSummary(response);
    const outputHash = sha256(canonicalJson(output));
    const outputRef = `runtime-v3://executions/${encodeURIComponent(handle.executionId)}/model-outputs/${outputHash}`;
    const outputArtifact = this.repository.createExecutionArtifact({
      artifactId: `model-output-${sha256(`${handle.stepId}:${outputHash}`).slice(0, 32)}`,
      executionId: handle.executionId,
      stepId: handle.stepId,
      kind: 'model.output.digest',
      mimeType: 'application/json',
      contentHash: outputHash,
      storageRef: outputRef,
      sizeBytes: Buffer.byteLength(canonicalJson(output)),
      metadata: {
        redacted: true,
        role: 'model_output',
        callCount: output.callCount,
        hasText: output.text.length > 0,
      },
    });
    const completed = TERMINAL_STEP_STATUSES.has(step.status)
      ? step
      : transitionOrRead(
        () => this.repository.transitionExecutionStep(step.stepId, {
          expectedStatuses: ACTIVE_STEP_STATUSES,
          patch: (current) => ({
            status: 'succeeded',
            resultRef: outputArtifact.storageRef,
            completedAt: this.#nowIso(),
            metadata: { ...current.metadata, state: 'succeeded', response: output },
          }),
          event: {
            type: 'model.turn.completed',
            payload: {
              responseId: output.responseId,
              durationMs: output.durationMs,
              usage: output.usage,
              callCount: output.callCount,
              hasText: output.text.length > 0,
            },
          },
        }).step,
        () => this.repository.getExecutionStep(step.stepId),
      );
    return Object.freeze({ step: completed, artifact: outputArtifact, output });
  }

  async failTurn(handle, error) {
    if (!this.repository || !validHandle(handle)) return null;
    const step = this.repository.getExecutionStep(handle.stepId);
    if (!step || TERMINAL_STEP_STATUSES.has(step.status)) return step;
    const cancelled = isCancellation(error);
    const status = cancelled ? 'cancelled' : 'failed';
    return transitionOrRead(
      () => this.repository.transitionExecutionStep(step.stepId, {
        expectedStatuses: ACTIVE_STEP_STATUSES,
        patch: (current) => ({
          status,
          error: { code: publicErrorCode(error, cancelled) },
          completedAt: this.#nowIso(),
          metadata: { ...current.metadata, state: status },
        }),
        event: {
          type: cancelled ? 'model.turn.cancelled' : 'model.turn.failed',
          payload: { code: publicErrorCode(error, cancelled) },
        },
      }).step,
      () => this.repository.getExecutionStep(step.stepId),
    );
  }

  async completeExecution(executionContext = {}, summary = {}) {
    if (!this.repository) return null;
    const execution = this.#findExecution(executionContext);
    if (!execution || TERMINAL_EXECUTION_STATUSES.has(execution.status)) return execution;
    const publicSummary = completionSummary(summary);
    return transitionOrRead(
      () => this.repository.transitionExecution(execution.executionId, {
        expectedStatuses: ACTIVE_EXECUTION_STATUSES,
        patch: (current) => ({
          status: 'succeeded',
          result: publicSummary,
          completedAt: this.#nowIso(),
          metadata: { ...current.metadata, state: 'succeeded', completion: publicSummary },
        }),
        event: { type: 'agent.execution.completed', payload: publicSummary },
      }).execution,
      () => this.repository.getExecution(execution.executionId),
    );
  }

  async failExecution(executionContext = {}, error) {
    if (!this.repository) return null;
    const execution = this.#findExecution(executionContext);
    if (!execution || TERMINAL_EXECUTION_STATUSES.has(execution.status)) return execution;
    const cancelled = isCancellation(error);
    const status = cancelled ? 'cancelled' : 'failed';
    const code = publicErrorCode(error, cancelled);
    return transitionOrRead(
      () => this.repository.transitionExecution(execution.executionId, {
        expectedStatuses: ACTIVE_EXECUTION_STATUSES,
        patch: (current) => ({
          status,
          error: { code },
          completedAt: this.#nowIso(),
          metadata: { ...current.metadata, state: status },
        }),
        event: { type: cancelled ? 'agent.execution.cancelled' : 'agent.execution.failed', payload: { code } },
      }).execution,
      () => this.repository.getExecution(execution.executionId),
    );
  }

  #ensureExecution(executionContext, session) {
    const identity = executionIdentity(executionContext);
    const existing = this.repository.getExecutionByIdempotencyKey({
      taskId: identity.taskId,
      idempotencyKey: identity.idempotencyKey,
    });
    if (existing) {
      if (['failed', 'cancelled', 'reconcile_required'].includes(existing.status)) {
        return transitionOrRead(
          () => this.repository.transitionExecution(existing.executionId, {
            expectedStatuses: ['failed', 'cancelled', 'reconcile_required'],
            patch: (current) => ({
              status: 'running',
              error: {},
              completedAt: '',
              metadata: {
                ...current.metadata,
                state: 'running',
                resumedAttempt: executionAttempt(executionContext),
              },
            }),
            event: {
              type: 'agent.execution.resumed',
              payload: { attempt: executionAttempt(executionContext) },
            },
          }).execution,
          () => this.repository.getExecution(existing.executionId),
        );
      }
      return existing;
    }
    const context = rootExecutionContext(identity, executionContext, session, this.#deadlineAt(executionContext));
    const execution = this.repository.createExecution({
      executionId: identity.executionId,
      context,
      kind: 'agent',
      status: 'running',
      metadata: {
        ledger: 'model_turn',
        agentKind: identity.agentKind,
        state: 'running',
        conversationId: publicText(executionContext?.conversationId, 200),
      },
    });
    return transitionOrRead(
      () => this.repository.transitionExecution(execution.executionId, {
        expectedStatuses: ['running'],
        patch: (current) => ({ metadata: { ...current.metadata, startedAt: this.#nowIso() } }),
        event: {
          type: 'agent.execution.started',
          payload: { agentKind: identity.agentKind, attempt: executionAttempt(executionContext) },
        },
      }).execution,
      () => this.repository.getExecution(execution.executionId),
    );
  }

  #findExecution(executionContext) {
    const identity = executionIdentity(executionContext);
    return this.repository.getExecutionByIdempotencyKey({
      taskId: identity.taskId,
      idempotencyKey: identity.idempotencyKey,
    });
  }

  #deadlineAt(executionContext) {
    const supplied = new Date(executionContext?.deadlineAt || '');
    if (Number.isFinite(supplied.getTime())) return supplied.toISOString();
    const now = this.#now();
    return new Date(now.getTime() + DEFAULT_DEADLINE_MS).toISOString();
  }

  #now() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  #nowIso() {
    return this.#now().toISOString();
  }
}

export function createModelTurnLedger(options = {}) {
  return new ModelTurnLedger(options);
}

function rootExecutionContext(identity, executionContext, session, deadlineAt) {
  const environment = {
    kind: 'data_copilot_conversation',
    conversationId: publicText(executionContext?.conversationId, 200),
    workspaceMode: publicText(executionContext?.workspaceMode, 40) || 'ask',
    ...(object(executionContext?.workspaceBinding).projectId ? {
      projectId: publicText(executionContext.workspaceBinding.projectId, 200),
      workspaceId: publicText(executionContext.workspaceBinding.workspaceId, 200),
      ...(publicText(executionContext.workspaceBinding.worktreeId, 200) ? {
        worktreeId: publicText(executionContext.workspaceBinding.worktreeId, 200),
      } : {}),
    } : {}),
  };
  const bindingAuthority = object(executionContext?.workspaceBinding?.authority);
  return {
    schemaVersion: 3,
    taskId: identity.taskId,
    runId: identity.runId,
    attemptId: identity.attemptId,
    traceId: identity.traceId,
    deadlineAt,
    idempotencyKey: identity.idempotencyKey,
    environment,
    authority: {
      source: 'server_derived',
      profile: publicText(bindingAuthority.profile, 80) || 'observe',
      trustedLocal: bindingAuthority.trustedLocal === true,
    },
    modelPolicy: publicModelPolicy(session),
    contextSnapshotId: `model-context:${identity.scopeHash}`,
  };
}

function executionIdentity(executionContext) {
  const agentKind = publicText(executionContext?.agentKind, 40) || 'main';
  const conversationId = publicText(executionContext?.conversationId, 200) || 'unbound-conversation';
  const operationKey = publicText(
    executionContext?.operationKey || executionContext?.requestKey || executionContext?.runId,
    400,
  ) || 'unbound-operation';
  const scopeHash = sha256(canonicalJson({ agentKind, conversationId, operationKey }));
  return {
    agentKind,
    scopeHash,
    executionId: `model-agent-${scopeHash.slice(0, 32)}`,
    taskId: `model-agent:${scopeHash}`,
    idempotencyKey: `model-agent:${scopeHash}`,
    runId: `model-agent:${scopeHash.slice(0, 24)}`,
    attemptId: operationKey,
    traceId: `model-agent:${scopeHash}`,
  };
}

function modelRequestSummary({ messages, toolDefinitions, session, round }) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const normalizedTools = Array.isArray(toolDefinitions) ? toolDefinitions : [];
  const messageDigests = normalizedMessages.slice(-200).map((message) => ({
    role: publicText(message?.role, 40) || 'unknown',
    contentHash: stableDigest(message?.content),
    contentBytes: byteLength(message?.content),
    toolCalls: toolCallNames(message),
  }));
  const toolNames = normalizedTools
    .map((tool) => publicText(tool?.name, 160))
    .filter(Boolean)
    .sort();
  return {
    schemaVersion: 1,
    round: positiveInteger(round, 1),
    model: publicModelPolicy(session),
    messageCount: normalizedMessages.length,
    messages: messageDigests,
    toolCount: toolNames.length,
    toolNames,
    toolDefinitionHash: stableDigest(normalizedTools.map((tool) => ({
      name: publicText(tool?.name, 160),
      source: publicText(tool?.source, 80),
      risk: publicText(tool?.risk, 80),
      schema: tool?.inputSchema || tool?.parameters || {},
    }))),
  };
}

function modelResponseSummary(response) {
  const calls = Array.isArray(response?.calls) ? response.calls : [];
  const text = String(response?.text || '');
  return {
    schemaVersion: 1,
    responseId: publicText(response?.responseId, 240),
    durationMs: finiteInteger(response?.durationMs),
    usage: publicUsage(response?.usage),
    text: { contentHash: sha256(text), length: Buffer.byteLength(text) },
    callCount: calls.length,
    calls: calls.slice(0, 100).map((call) => ({
      name: publicText(call?.name, 160),
      callIdHash: stableDigest(call?.id || call?.toolCallId || ''),
      argumentsHash: stableDigest(call?.input ?? call?.arguments ?? {}),
    })),
  };
}

function completionSummary(summary) {
  return {
    schemaVersion: 1,
    steps: finiteInteger(summary?.steps),
    rounds: finiteInteger(summary?.rounds || summary?.steps),
    responseId: publicText(summary?.responseId, 240),
    durationMs: finiteInteger(summary?.durationMs),
  };
}

function publicModelPolicy(session) {
  return {
    provider: publicText(session?.provider, 120),
    model: publicText(session?.model, 240),
    wireApi: publicText(session?.wireApi, 80),
    ...(publicText(session?.reasoningEffort, 40) ? { reasoningEffort: publicText(session.reasoningEffort, 40) } : {}),
  };
}

function publicUsage(value) {
  const source = object(value);
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'number' && Number.isFinite(item)) result[String(key).slice(0, 80)] = item;
  }
  return result;
}

function toolCallNames(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.slice(0, 100).map((call) => publicText(call?.function?.name || call?.name, 160)).filter(Boolean);
}

function byteLength(value) {
  try {
    return Buffer.byteLength(canonicalJson(value === undefined ? null : value));
  } catch {
    return 0;
  }
}

function stableDigest(value) {
  try {
    return sha256(canonicalJson(value === undefined ? null : value));
  } catch {
    return sha256('[unserializable]');
  }
}

function transitionOrRead(transition, read) {
  try {
    return transition();
  } catch (error) {
    if (!['RUNTIME_V3_EXECUTION_STATE_CONFLICT', 'RUNTIME_V3_STEP_STATE_CONFLICT'].includes(error?.code)) throw error;
    const current = read();
    if (!current) throw error;
    return current;
  }
}

function validHandle(value) {
  return Boolean(publicText(value?.executionId, 200) && publicText(value?.stepId, 200));
}

function executionAttempt(executionContext) {
  return positiveInteger(executionContext?.attempt, 1);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function isCancellation(error) {
  return error?.name === 'AbortError'
    || ['COPILOT_RUN_CANCELLED', 'MODEL_REQUEST_ABORTED', 'ABORT_ERR'].includes(String(error?.code || ''));
}

function publicErrorCode(error, cancelled) {
  if (cancelled) return 'MODEL_TURN_CANCELLED';
  const candidate = publicText(error?.code, 80).toUpperCase();
  return /^[A-Z0-9_]+$/.test(candidate) ? candidate : 'MODEL_TURN_FAILED';
}

function publicText(value, maxLength) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, maxLength);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isLedgerRepository(value) {
  return Boolean(
    value
    && typeof value.getExecution === 'function'
    && typeof value.getExecutionByIdempotencyKey === 'function'
    && typeof value.createExecution === 'function'
    && typeof value.transitionExecution === 'function'
    && typeof value.getExecutionStep === 'function'
    && typeof value.createExecutionStep === 'function'
    && typeof value.transitionExecutionStep === 'function'
    && typeof value.createExecutionArtifact === 'function',
  );
}
