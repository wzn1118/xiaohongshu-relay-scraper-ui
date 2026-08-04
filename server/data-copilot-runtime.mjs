import crypto from 'node:crypto';

import {
  collectToolEvidence,
  createAgentPlan,
  markPlanToolCompleted,
  markPlanToolStarted,
  markPlanVerification,
  planText,
  verificationRepairInstruction,
  verifyAgentAnswer,
} from './copilot-agent-kernel.mjs';
import { CopilotCapabilityResolver } from './copilot-capability-resolver.mjs';
import { copilotHash } from './data-copilot-store.mjs';

const DEFAULT_MAX_STEPS = 24;
const MAX_ALLOWED_STEPS = 48;
const DEFAULT_MAX_REPAIR_ROUNDS = 2;
const MODEL_TIMEOUT_MS = 120_000;

export class DataCopilotRuntimeError extends Error {
  constructor(code, message, status = 500, { recoverable = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DataCopilotRuntimeError';
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
  }
}

export class DataCopilotRuntime {
  constructor({
    store,
    approvals,
    registry,
    aiSessions,
    emit = () => {},
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    capabilityResolver = new CopilotCapabilityResolver(),
    maxSteps = DEFAULT_MAX_STEPS,
    maxRepairRounds = DEFAULT_MAX_REPAIR_ROUNDS,
  } = {}) {
    this.store = store;
    this.approvals = approvals;
    this.registry = registry;
    this.aiSessions = aiSessions;
    this.emit = emit;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.idFactory = idFactory;
    this.capabilityResolver = capabilityResolver;
    this.maxSteps = boundedInteger(maxSteps, DEFAULT_MAX_STEPS, 1, MAX_ALLOWED_STEPS);
    this.maxRepairRounds = boundedInteger(maxRepairRounds, DEFAULT_MAX_REPAIR_ROUNDS, 0, 5);
    this.active = new Map();
    this.operationLocks = new Map();
    this.persistenceLocks = new Map();
  }

  describeCapabilities() {
    const tools = this.registry.list();
    const categories = [...new Set(tools.map((tool) => String(tool.category || tool.name?.split('.')[0] || 'other')))];
    return {
      schemaVersion: 1,
      agentKernel: 'planner-executor-verifier-v2',
      planner: true,
      verifier: true,
      dynamicToolDiscovery: true,
      parallelReadTools: true,
      persistentCheckpoints: true,
      approvals: true,
      maxSteps: this.maxSteps,
      maxRepairRounds: this.maxRepairRounds,
      toolCatalog: { total: tools.length, categories },
    };
  }

  async start(reference, value = {}) {
    return this.#withConversationLock(reference?.conversationId, () => this.#start(reference, value));
  }

  async #start(reference, value = {}) {
    const conversation = await requireConversation(this.store, reference);
    const text = String(value.content || '').trim();
    if (!text) throw runtimeError('COPILOT_MESSAGE_EMPTY', 'Message content is required.', 400, false);
    const requestKey = idempotency(value.idempotencyKey || `message:${this.idFactory()}`);
    const workspaceMode = normalizeWorkspaceMode(value.workspaceMode);
    const existing = await findRequestRun(this.store, reference, requestKey);
    if (existing) return { runId: existing.runId, duplicate: true, conversation: await this.store.getConversation(reference) };
    await this.#drainCancelledExecution(reference.conversationId);
    if (this.active.has(reference.conversationId)) throw runtimeError('COPILOT_RUN_ACTIVE', 'A run is already active for this conversation.', 409);

    const attachments = normalizeAttachmentRefs(value.attachments || value.attachmentIds);
    const userMessage = await this.store.appendMessage(reference, {
      role: 'user',
      content: { type: 'user.message', text },
      attachments,
      metadata: {
        modelSessionId: String(value.aiSessionId || ''),
        requestKey,
        workspaceMode,
        contextSourceIds: normalizeContextSourceIds(value.contextSourceIds),
      },
      idempotencyKey: `${requestKey}:user`,
    });
    const runId = this.idFactory();
    await this.store.appendRun(reference, {
      runId,
      status: 'planning',
      event: 'planning',
      attempt: 1,
      metadata: { requestKey, aiSessionId: String(value.aiSessionId || ''), workspaceMode, userMessageId: userMessage.messageId },
      idempotencyKey: `${requestKey}:run:planning`,
    });
    this.#event(reference, { type: 'user.message', runId, message: userMessage });
    const contextSourceIds = normalizeContextSourceIds(value.contextSourceIds);
    const execution = {
      runId,
      requestKey,
      operationKey: requestKey,
      intentText: text,
      aiSessionId: String(value.aiSessionId || ''),
      workspaceMode,
      contextSourceIds,
      attempt: 1,
      controller: new AbortController(),
      state: createExecutionState(),
    };
    this.active.set(reference.conversationId, execution);
    execution.done = this.#execute(reference, execution);
    void execution.done.finally(() => {
      if (this.active.get(reference.conversationId) === execution) this.active.delete(reference.conversationId);
    });
    return { runId, duplicate: false, conversation: await this.store.getConversation(reference) };
  }

  async cancel(reference, value = {}) {
    return this.#withConversationLock(reference?.conversationId, () => this.#cancel(reference, value));
  }

  async #cancel(reference, value = {}) {
    const conversation = await requireConversation(this.store, reference);
    const active = this.active.get(reference.conversationId);
    if (!active || active.controller.signal.aborted || ['completed', 'failed', 'cancelled'].includes(conversation.status)) {
      return { cancelled: false, conversation };
    }
    const runId = active.runId;
    const key = idempotency(value.idempotencyKey || `cancel:${runId}:${this.idFactory()}`);
    const cancellation = await this.store.requestCancellation(reference, {
      runId,
      status: 'stopping',
      attempt: active.attempt || conversation.runState?.attempt || 1,
      checkpoint: active.checkpoint || conversation.runState?.checkpoint || null,
      idempotencyKey: `${key}:requested`,
    });
    if (!cancellation) {
      return { cancelled: false, conversation: await this.store.getConversation(reference) };
    }
    active.controller.abort(new Error('cancelled'));
    return { cancelled: true, conversation: await this.store.getConversation(reference) };
  }

  async retry(reference, value = {}) {
    return this.#withConversationLock(reference?.conversationId, () => this.#retry(reference, value));
  }

  async #retry(reference, value = {}) {
    const conversation = await requireConversation(this.store, reference);
    const checkpoint = conversation.runState?.checkpoint;
    const previousRunId = conversation.runState?.resumeFromRunId || conversation.runState?.lastRunId;
    if (!checkpoint || !previousRunId) throw runtimeError('COPILOT_RUN_NOT_RESUMABLE', 'No recoverable checkpoint is available.', 409, false);
    const key = idempotency(value.idempotencyKey || `retry:${previousRunId}:${this.idFactory()}`);
    const existing = await findRequestRun(this.store, reference, key);
    if (existing) return { runId: existing.runId, duplicate: true, conversation: await this.store.getConversation(reference) };
    await this.#drainCancelledExecution(reference.conversationId);
    if (this.active.has(reference.conversationId)) throw runtimeError('COPILOT_RUN_ACTIVE', 'A run is already active for this conversation.', 409);
    const runId = this.idFactory();
    const attempt = Number(conversation.runState?.attempt || 1) + 1;
    const aiSessionId = String(value.aiSessionId || checkpoint.aiSessionId || '');
    await this.store.beginResume(reference, {
      runId,
      status: 'executing',
      attempt,
      resumeFromRunId: previousRunId,
      checkpoint,
      metadata: { requestKey: key, aiSessionId },
      idempotencyKey: `${key}:run:resume`,
    });
    const execution = {
      runId, requestKey: key, aiSessionId, attempt,
      workspaceMode: normalizeWorkspaceMode(checkpoint.workspaceMode),
      operationKey: String(checkpoint.operationKey || checkpoint.requestKey || previousRunId),
      intentText: String(checkpoint.intentText || ''),
      contextSourceIds: normalizeContextSourceIds(checkpoint.contextSourceIds),
      controller: new AbortController(), state: createExecutionState(checkpoint), checkpoint,
    };
    this.active.set(reference.conversationId, execution);
    execution.done = this.#execute(reference, execution);
    void execution.done.finally(() => {
      if (this.active.get(reference.conversationId) === execution) this.active.delete(reference.conversationId);
    });
    return { runId, conversation: await this.store.getConversation(reference) };
  }

  async continueApproval(reference, approval, value = {}) {
    return this.#withConversationLock(reference?.conversationId, () => this.#continueApproval(reference, approval, value));
  }

  async #continueApproval(reference, approval, value = {}) {
    const conversation = await requireConversation(this.store, reference);
    const currentApproval = await this.approvals.getApproval(reference, approval?.approvalId);
    if (!currentApproval || currentApproval.status !== 'approved') {
      throw runtimeError('COPILOT_APPROVAL_NOT_APPROVED', 'Approval must be approved before execution.', 409, false);
    }
    await this.#drainCancelledExecution(reference.conversationId);
    if (this.active.has(reference.conversationId)) throw runtimeError('COPILOT_RUN_ACTIVE', 'A run is already active for this conversation.', 409);
    const checkpoint = conversation.runState?.checkpoint;
    if (!checkpoint?.pendingApproval || checkpoint.pendingApproval.approvalId !== currentApproval.approvalId) {
      throw runtimeError('COPILOT_APPROVAL_STALE', 'Approval no longer matches the active run checkpoint.', 409, false);
    }
    const pendingCall = checkpoint.pendingApproval.call || {};
    const pendingToolRunId = checkpoint.pendingApproval.tool?.toolRunId || pendingCall.id;
    const approvedArguments = checkpoint.pendingApproval.approvalArguments || pendingCall.input || {};
    if (
      currentApproval.runId !== checkpoint.runId
      || currentApproval.toolRunId !== pendingToolRunId
      || currentApproval.toolName !== pendingCall.name
      || copilotHash(currentApproval.arguments || {}) !== copilotHash(approvedArguments)
      || (checkpoint.pendingApproval.deliveryFingerprintHash
        && copilotHash(emailDeliveryFingerprint(currentApproval.arguments || {})) !== checkpoint.pendingApproval.deliveryFingerprintHash)
      || (checkpoint.pendingApproval.requestHash && checkpoint.pendingApproval.requestHash !== currentApproval.requestHash)
    ) {
      throw runtimeError('COPILOT_APPROVAL_MISMATCH', 'Approval does not match the exact paused tool request.', 409, false);
    }
    const requestKey = idempotency(value.idempotencyKey || `approval:${currentApproval.approvalId}`);
    const execution = {
      runId: currentApproval.runId,
      requestKey,
      operationKey: String(checkpoint.operationKey || checkpoint.requestKey || currentApproval.runId),
      intentText: String(checkpoint.intentText || ''),
      aiSessionId: String(checkpoint.aiSessionId || ''),
      workspaceMode: normalizeWorkspaceMode(checkpoint.workspaceMode),
      contextSourceIds: normalizeContextSourceIds(checkpoint.contextSourceIds),
      attempt: Number(checkpoint.attempt || conversation.runState?.attempt || 1),
      controller: new AbortController(),
      state: createExecutionState(checkpoint),
      checkpoint,
      approved: currentApproval,
    };
    await this.store.appendRun(reference, {
      runId: execution.runId,
      status: 'executing',
      event: 'approval_confirmed',
      attempt: execution.attempt,
      checkpoint,
      idempotencyKey: `${requestKey}:run:approved`,
    });
    this.active.set(reference.conversationId, execution);
    execution.done = this.#execute(reference, execution);
    void execution.done.finally(() => {
      if (this.active.get(reference.conversationId) === execution) this.active.delete(reference.conversationId);
    });
    return { runId: execution.runId, conversation: await this.store.getConversation(reference) };
  }

  async #withConversationLock(conversationId, operation) {
    const key = String(conversationId || '');
    const previous = this.operationLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.operationLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationLocks.get(key) === tail) this.operationLocks.delete(key);
    }
  }

  async #drainCancelledExecution(conversationId) {
    const active = this.active.get(conversationId);
    if (!active?.controller.signal.aborted || !active.done) return;
    await active.done.catch(() => {});
    if (this.active.get(conversationId) === active) this.active.delete(conversationId);
  }

  async #withPersistenceLock(conversationId, operation) {
    const key = String(conversationId || '');
    const previous = this.persistenceLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.persistenceLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.persistenceLocks.get(key) === tail) this.persistenceLocks.delete(key);
    }
  }

  async #execute(reference, execution) {
    try {
      const conversation = await requireConversation(this.store, reference);
      const session = this.aiSessions.resolve(execution.aiSessionId);
      execution.state.intentText = String(execution.state.intentText || execution.intentText || execution.checkpoint?.intentText || '');
      let modelMessages;
      let startStep = 0;
      if (execution.checkpoint?.modelMessages) {
        modelMessages = execution.checkpoint.modelMessages;
        startStep = Number(execution.checkpoint.step || 0);
      } else {
        modelMessages = await buildModelHistory(this.store, reference, systemPrompt(reference, conversation, execution.workspaceMode));
      }
      if (!execution.state.plan) {
        const plannedTools = this.capabilityResolver.resolve(this.registry.list(), {
          query: execution.state.intentText,
          activeToolNames: execution.state.activeToolNames,
        });
        execution.state.plan = createAgentPlan({
          objective: execution.state.intentText,
          tools: plannedTools,
          now: this.now(),
        });
        execution.checkpoint = checkpointFor(execution, startStep, modelMessages);
        const text = planText(execution.state.plan);
        await this.store.appendRun(reference, {
          runId: execution.runId,
          status: 'planning',
          event: 'plan_created',
          attempt: execution.attempt,
          checkpoint: execution.checkpoint,
          metadata: { plan: execution.state.plan },
          idempotencyKey: `${execution.requestKey}:run:plan:${execution.attempt}`,
        });
        await this.store.appendMessage(reference, {
          role: 'assistant',
          content: { type: 'assistant.plan', text, plan: execution.state.plan },
          metadata: { runId: execution.runId },
          idempotencyKey: `${execution.requestKey}:assistant:plan:${execution.attempt}`,
        });
        this.#event(reference, {
          type: 'assistant.plan',
          runId: execution.runId,
          status: 'planning',
          text,
          plan: execution.state.plan,
          model: modelMetadata(session),
        });
      } else {
        this.#event(reference, {
          type: 'assistant.plan',
          runId: execution.runId,
          status: 'executing',
          text: planText(execution.state.plan),
          plan: execution.state.plan,
          model: modelMetadata(session),
        });
      }
      await this.store.appendRun(reference, {
        runId: execution.runId,
        status: 'executing',
        event: 'started',
        attempt: execution.attempt,
        resumeFromRunId: execution.checkpoint?.runId || null,
        metadata: modelMetadata(session),
        idempotencyKey: `${execution.requestKey}:run:started:${execution.attempt}`,
      });

      if (!execution.approved && execution.checkpoint?.pendingApproval) {
        const recovered = await this.#recoverConsumedApproval(reference, execution, modelMessages);
        if (recovered) {
          modelMessages = recovered.modelMessages;
          startStep = recovered.nextStep;
        }
      }

      if (execution.approved) {
        const pending = execution.checkpoint.pendingApproval;
        const toolRecord = pending.tool || createToolRecord(execution, pending.call, Math.max(0, Number(pending.step ?? execution.checkpoint.step) - 1), 0, {
          sequence: Number(pending.redeliverySequence || 0),
          runId: pending.runId || execution.runId,
        });
        pending.tool = toolRecord;
        toolRecord.status = 'running';
        toolRecord.deliveryAttempt = {
          ...(toolRecord.deliveryAttempt || {}),
          attemptId: toolRecord.toolRunId,
          idempotencyKey: toolRecord.idempotencyKey,
          status: 'started',
          startedAt: toolRecord.deliveryAttempt?.startedAt || this.now().toISOString(),
        };
        await this.#verifyApprovedEmailPreview(reference, execution, pending);
        await this.#persistCheckpoint(reference, execution, Number(execution.checkpoint.step || 0), 'delivery_started');
        let result;
        try {
          result = await this.#executeTool(reference, execution, pending.call, toolRecord, {
            approved: true,
            approvalId: execution.approved.approvalId,
            approvalRequestHash: pending.requestHash,
          });
        } catch (error) {
          if (error?.code === 'COPILOT_EMAIL_DELIVERY_UNKNOWN') {
            await this.#pauseUnknownDelivery(reference, execution, error, modelMessages);
            return;
          }
          throw error;
        }
        toolRecord.status = 'succeeded';
        toolRecord.result = result;
        toolRecord.completedAt = this.now().toISOString();
        toolRecord.deliveryAttempt = {
          ...toolRecord.deliveryAttempt,
          status: 'succeeded',
          completedAt: toolRecord.completedAt,
          receipt: result,
        };
        restoreToolState(execution.state, pending.call, result);
        execution.state.plan = markPlanToolCompleted(execution.state.plan, pending.call.name, this.now());
        this.#emitPlan(reference, execution, 'executing');
        await this.#persistCheckpoint(reference, execution, Number(execution.checkpoint.step || 0), 'delivery_result');
        await this.#consumeApproval(reference, execution, pending);
        modelMessages = appendToolResultOnce(modelMessages, pending.call, result);
        const nextStep = Number(execution.checkpoint.step || 0);
        execution.checkpoint = checkpointFor(execution, nextStep, modelMessages);
        await this.#persistCheckpoint(reference, execution, nextStep, 'approval_completed');
        startStep = nextStep;
      } else if (execution.checkpoint?.pendingApproval) {
        throw runtimeError('COPILOT_APPROVAL_REQUIRED', 'The paused tool requires a current explicit approval.', 409, false);
      }

      if (execution.checkpoint?.pendingTools) {
        const resumed = await this.#resumeToolBatch(reference, execution);
        modelMessages = resumed.modelMessages;
        startStep = resumed.nextStep;
      }

      for (let step = startStep; step < this.maxSteps; step += 1) {
        throwIfAborted(execution.controller.signal);
        execution.checkpoint = checkpointFor(execution, step, modelMessages);
        await this.#persistCheckpoint(reference, execution, step, 'before_model');
        const availableTools = this.capabilityResolver.resolve(this.registry.list(), {
          query: execution.state.intentText,
          activeToolNames: execution.state.activeToolNames,
          plan: execution.state.plan,
        });
        const response = await callModel(this.fetchImpl, session, modelMessages, availableTools, execution.controller.signal);
        throwIfAborted(execution.controller.signal);
        await this.store.appendRun(reference, {
          runId: execution.runId,
          status: 'executing',
          event: 'model_round_completed',
          attempt: execution.attempt,
          checkpoint: execution.checkpoint,
          metadata: {
            round: step + 1,
            durationMs: response.durationMs,
            availableToolCount: availableTools.length,
            availableToolNames: availableTools.map((tool) => tool.name),
            ...modelMetadata(session),
          },
          idempotencyKey: `${execution.requestKey}:run:model:${execution.attempt}:${step}`,
        });
        throwIfAborted(execution.controller.signal);
        if (response.calls.length === 0) {
          const text = String(response.text || '').trim();
          if (!text) throw runtimeError('COPILOT_MODEL_EMPTY', 'The selected model returned no message or tool call.', 502);
          const verification = verifyAgentAnswer({
            objective: execution.state.intentText,
            answer: text,
            evidence: execution.state.evidence,
            modelMessages,
            toolResults: execution.state.toolResults,
          });
          execution.state.plan = markPlanVerification(execution.state.plan, verification, this.now());
          this.#event(reference, {
            type: verification.passed ? 'verification.passed' : 'verification.failed',
            runId: execution.runId,
            verification,
          });
          this.#event(reference, {
            type: 'assistant.plan',
            runId: execution.runId,
            status: verification.passed ? 'completed' : 'executing',
            text: planText(execution.state.plan),
            plan: execution.state.plan,
          });
          if (!verification.passed) {
            execution.state.repairCount = Number(execution.state.repairCount || 0) + 1;
            await this.store.appendRun(reference, {
              runId: execution.runId,
              status: 'executing',
              event: 'verification_failed',
              attempt: execution.attempt,
              metadata: { round: step + 1, repairCount: execution.state.repairCount, verification },
              idempotencyKey: `${execution.requestKey}:run:verification:failed:${execution.attempt}:${execution.state.repairCount}`,
            });
            if (execution.state.repairCount <= this.maxRepairRounds) {
              modelMessages = [...modelMessages, {
                role: 'system',
                content: verificationRepairInstruction(verification),
              }];
              execution.checkpoint = checkpointFor(execution, step + 1, modelMessages);
              await this.#persistCheckpoint(reference, execution, step + 1, `verification_repair_${execution.state.repairCount}`);
              continue;
            }
            throw runtimeError(
              'COPILOT_VERIFICATION_FAILED',
              `The Agent could not verify its result after ${this.maxRepairRounds} repair round(s).`,
              409,
            );
          }
          await this.store.appendRun(reference, {
            runId: execution.runId,
            status: 'executing',
            event: 'verification_passed',
            attempt: execution.attempt,
            metadata: { round: step + 1, verification },
            idempotencyKey: `${execution.requestKey}:run:verification:passed:${execution.attempt}`,
          });
          const message = await this.store.appendMessage(reference, {
            role: 'assistant',
            content: { type: 'assistant.message', text },
            metadata: { runId: execution.runId, ...modelMetadata(session), durationMs: response.durationMs },
            idempotencyKey: `${execution.requestKey}:assistant:${execution.attempt}:${step}`,
          });
          throwIfAborted(execution.controller.signal);
          await this.store.appendRun(reference, {
            runId: execution.runId,
            status: 'completed',
            event: 'completed',
            attempt: execution.attempt,
            metadata: { steps: step + 1, durationMs: response.durationMs, ...modelMetadata(session) },
            idempotencyKey: `${execution.requestKey}:run:completed:${execution.attempt}`,
          });
          throwIfAborted(execution.controller.signal);
          this.#event(reference, { type: 'assistant.message', runId: execution.runId, message });
          this.#event(reference, { type: 'run.completed', runId: execution.runId });
          return;
        }

        modelMessages = appendAssistantToolCalls(modelMessages, response);
        const pendingApproval = response.calls.find((call) => this.registry.get(call.name)?.risk === 'approval_required');
        if (pendingApproval) {
          throwIfAborted(execution.controller.signal);
          assertApprovalPrerequisites(pendingApproval, execution.state);
          const approval = await this.#requestApproval(reference, execution, pendingApproval, step, modelMessages);
          this.#event(reference, { type: 'approval.required', runId: execution.runId, approval });
          return;
        }
        const batch = createToolBatch(execution, step, response.calls);
        execution.checkpoint = checkpointFor(execution, step, modelMessages, { pendingTools: batch });
        await this.#persistCheckpoint(reference, execution, step, 'before_tools');
        const completed = await this.#resumeToolBatch(reference, execution);
        modelMessages = completed.modelMessages;
      }
      throw runtimeError('COPILOT_STEP_LIMIT', `The Agent reached its ${this.maxSteps}-step tool limit. Continue the conversation to resume.`, 409);
    } catch (error) {
      await this.#fail(reference, execution, error);
    }
  }

  async #resumeToolBatch(reference, execution) {
    const batch = execution.checkpoint?.pendingTools;
    if (!batch || !Array.isArray(batch.tools)) {
      throw runtimeError('COPILOT_CHECKPOINT_INVALID', 'The tool checkpoint is incomplete.', 500, false);
    }
    const pending = [];
    for (const toolRecord of batch.tools) {
      const call = toolRecord.call;
      if (toolRecord.status === 'succeeded') {
        restoreToolState(execution.state, call, toolRecord.result);
        continue;
      }
      pending.push(toolRecord);
    }

    const canRunInParallel = pending.length > 1 && pending.every((toolRecord) => {
      const tool = this.registry.get(toolRecord.call.name);
      return tool?.risk === 'read' && tool.parallelSafe !== false;
    });

    if (canRunInParallel) {
      throwIfAborted(execution.controller.signal);
      for (const toolRecord of pending) {
        toolRecord.status = 'running';
        toolRecord.startedAt ||= this.now().toISOString();
        execution.state.plan = markPlanToolStarted(execution.state.plan, toolRecord.call.name, this.now());
      }
      this.#emitPlan(reference, execution, 'executing');
      await this.#persistCheckpoint(reference, execution, batch.step, 'parallel_tools_started');
      const results = await Promise.allSettled(pending.map((toolRecord) => (
        this.#executeTool(reference, execution, toolRecord.call, toolRecord)
      )));
      let firstError = null;
      for (let index = 0; index < pending.length; index += 1) {
        const toolRecord = pending[index];
        const outcome = results[index];
        if (outcome.status === 'fulfilled') {
          toolRecord.status = 'succeeded';
          toolRecord.result = outcome.value;
          toolRecord.completedAt = this.now().toISOString();
          restoreToolState(execution.state, toolRecord.call, outcome.value);
          execution.state.plan = markPlanToolCompleted(execution.state.plan, toolRecord.call.name, this.now());
        } else {
          toolRecord.status = 'failed';
          toolRecord.errorCode = String(outcome.reason?.code || 'COPILOT_TOOL_FAILED');
          toolRecord.errorMessage = safeError(outcome.reason);
          firstError ||= outcome.reason;
        }
      }
      this.#emitPlan(reference, execution, 'executing');
      await this.#persistCheckpoint(reference, execution, batch.step, firstError ? 'parallel_tools_failed' : 'parallel_tools_completed');
      if (firstError) throw firstError;
    } else {
      for (const toolRecord of pending) {
        const call = toolRecord.call;
        throwIfAborted(execution.controller.signal);
        execution.state.plan = markPlanToolStarted(execution.state.plan, call.name, this.now());
        this.#emitPlan(reference, execution, 'executing');
        toolRecord.status = 'running';
        toolRecord.startedAt ||= this.now().toISOString();
        await this.#persistCheckpoint(reference, execution, batch.step, `tool_${toolRecord.toolRunId}_started`);
        try {
          const result = await this.#executeTool(reference, execution, call, toolRecord);
          toolRecord.status = 'succeeded';
          toolRecord.result = result;
          toolRecord.completedAt = this.now().toISOString();
          restoreToolState(execution.state, call, result);
          execution.state.plan = markPlanToolCompleted(execution.state.plan, call.name, this.now());
          this.#emitPlan(reference, execution, 'executing');
          await this.#persistCheckpoint(reference, execution, batch.step, `tool_${toolRecord.toolRunId}_completed`);
        } catch (error) {
          toolRecord.status = 'failed';
          toolRecord.errorCode = String(error?.code || 'COPILOT_TOOL_FAILED');
          toolRecord.errorMessage = safeError(error);
          await this.#persistCheckpoint(reference, execution, batch.step, `tool_${toolRecord.toolRunId}_failed`).catch(() => {});
          throw error;
        }
        throwIfAborted(execution.controller.signal);
      }
    }
    let modelMessages = execution.checkpoint.modelMessages;
    for (const toolRecord of batch.tools) {
      modelMessages = appendToolResultOnce(modelMessages, toolRecord.call, toolRecord.result);
    }
    const nextStep = Number(batch.nextStep ?? (batch.step + 1));
    execution.checkpoint = checkpointFor(execution, nextStep, modelMessages);
    await this.#persistCheckpoint(reference, execution, nextStep, 'after_tools');
    return { modelMessages, nextStep };
  }

  async #executeTool(reference, execution, call, toolRecord, { approved = false, approvalId = null, approvalRequestHash = '' } = {}) {
    const tool = this.registry.get(call.name);
    if (!tool) throw runtimeError('COPILOT_TOOL_UNKNOWN', `The model requested an unknown tool: ${call.name}.`, 400, false);
    const toolRunId = toolRecord.toolRunId;
    const baseKey = toolRecord.idempotencyKey;
    const history = (await this.store.listToolRuns(reference, { limit: 5000 }))
      .filter((item) => item.toolRunId === toolRunId && item.metadata?.executionKey === baseKey);
    const completed = history.findLast((item) => item.status === 'succeeded');
    if (completed) {
      await this.#persistToolMessage(reference, execution, call, toolRecord, completed.output);
      return completed.output;
    }
    const knownNotSent = history.findLast((item) => item.status === 'failed' && item.metadata?.deliveryStatus === 'not_sent');
    if (call.name === 'email.send' && history.some((item) => item.status === 'running') && !knownNotSent) {
      throw deliveryUnknown('A previous SMTP delivery attempt has no durable completion receipt.');
    }
    await this.#withPersistenceLock(reference.conversationId, () => this.store.appendToolRun(reference, {
      toolRunId, runId: toolRecord.runId, toolName: call.name, status: 'running', input: call.input,
      ...(approvalId ? { approvalId } : {}),
      metadata: { executionKey: baseKey, inputHash: toolRecord.inputHash, ...(approvalRequestHash ? { approvalRequestHash } : {}) },
      idempotencyKey: `${baseKey}:started`,
    }));
    this.#event(reference, { type: 'tool.started', runId: execution.runId, toolRunId, name: call.name, input: call.input });
    let result;
    try {
      result = await this.registry.execute(call.name, call.input, {
        reference,
        conversation: await this.store.getConversation(reference),
        state: execution.state,
        signal: execution.controller.signal,
        approved,
        runId: execution.runId,
        toolRunId,
        idempotencyKey: baseKey,
        deliveryAttemptId: call.name === 'email.send' ? toolRunId : undefined,
        contextSourceIds: execution.contextSourceIds,
      });
    } catch (error) {
      if (call.name === 'email.send' && error?.deliveryStatus !== 'not_sent') {
        throw deliveryUnknown(safeError(error), error);
      }
      await this.#withPersistenceLock(reference.conversationId, () => (
        this.#persistToolFailure(reference, execution, call, toolRecord, approvalId, error, approvalRequestHash)
      ));
      throw error;
    }
    try {
      await this.#withPersistenceLock(reference.conversationId, () => this.store.appendToolRun(reference, {
        toolRunId, runId: toolRecord.runId, toolName: call.name, status: 'succeeded', input: call.input, output: result,
        ...(approvalId ? { approvalId } : {}),
        metadata: { executionKey: baseKey, inputHash: toolRecord.inputHash, ...(approvalRequestHash ? { approvalRequestHash } : {}) },
        idempotencyKey: `${baseKey}:completed`,
      }));
    } catch (error) {
      if (call.name === 'email.send') throw deliveryUnknown('SMTP returned, but its completion receipt could not be persisted.', error);
      throw error;
    }
    try {
      const message = await this.#withPersistenceLock(reference.conversationId, () => (
        this.#persistToolMessage(reference, execution, call, toolRecord, result)
      ));
      this.#event(reference, { type: result?.type || 'tool.result', runId: execution.runId, toolRunId, name: call.name, result, message });
      return result;
    } catch (error) {
      // The durable tool receipt already exists; a retry can reconstruct only the local message.
      throw error;
    }
  }

  async #persistToolMessage(reference, execution, call, toolRecord, result) {
    return this.store.appendMessage(reference, {
      role: 'tool',
      content: { type: result?.type || 'tool.result', toolRunId: toolRecord.toolRunId, name: call.name, result },
      metadata: { runId: toolRecord.runId, executionKey: toolRecord.idempotencyKey },
      idempotencyKey: `${toolRecord.idempotencyKey}:message`,
    });
  }

  async #persistToolFailure(reference, execution, call, toolRecord, approvalId, error, approvalRequestHash = '') {
    await this.store.appendToolRun(reference, {
      toolRunId: toolRecord.toolRunId, runId: toolRecord.runId, toolName: call.name, status: 'failed', input: call.input,
      errorCode: String(error?.code || 'COPILOT_TOOL_FAILED'), errorMessage: safeError(error),
      ...(approvalId ? { approvalId } : {}),
      metadata: {
        executionKey: toolRecord.idempotencyKey,
        inputHash: toolRecord.inputHash,
        attempt: execution.attempt,
        deliveryStatus: String(error?.deliveryStatus || ''),
        safeToRetry: error?.safeToRetry === true,
        ...(approvalRequestHash ? { approvalRequestHash } : {}),
      },
      idempotencyKey: idempotency(`${toolRecord.idempotencyKey}:failed:${execution.attempt}:${copilotHash({ code: error?.code, message: safeError(error) }).slice(0, 12)}`),
    });
    this.#event(reference, { type: 'tool.result', runId: execution.runId, toolRunId: toolRecord.toolRunId, name: call.name, error: { code: error?.code, message: safeError(error) } });
  }

  async #requestApproval(reference, execution, call, step, modelMessages, options = {}) {
    const redeliverySequence = Number(options.redeliverySequence || 0);
    const toolRecord = createToolRecord(execution, call, step, 0, { sequence: redeliverySequence });
    const toolRunId = toolRecord.toolRunId;
    const approvalArguments = emailApprovalArguments(call.input, execution.state.emailPreview);
    const deliveryFingerprintHash = copilotHash(emailDeliveryFingerprint(approvalArguments));
    const approval = await this.approvals.createApproval(reference, {
      runId: execution.runId,
      toolRunId,
      toolName: call.name,
      riskLevel: 'high',
      summary: emailApprovalSummary(call.input),
      arguments: approvalArguments,
      idempotencyKey: idempotency(`${execution.operationKey}:approval:${redeliverySequence}:${toolRunId}`),
    });
    await this.store.appendToolRun(reference, {
      toolRunId, runId: execution.runId, toolName: call.name, status: 'waiting_approval', approvalId: approval.approvalId, input: call.input,
      metadata: { executionKey: toolRecord.idempotencyKey, inputHash: toolRecord.inputHash, redeliverySequence },
      idempotencyKey: `${toolRecord.idempotencyKey}:approval`,
    });
    toolRecord.status = 'waiting_approval';
    toolRecord.deliveryAttempt = {
      attemptId: toolRecord.toolRunId,
      idempotencyKey: toolRecord.idempotencyKey,
      status: 'pending_approval',
      sequence: redeliverySequence,
    };
    const checkpoint = checkpointFor(execution, step + 1, modelMessages, {
      pendingApproval: {
        approvalId: approval.approvalId,
        requestHash: approval.requestHash,
        call,
        tool: toolRecord,
        approvalArguments,
        deliveryFingerprintHash,
        step: step + 1,
        redeliverySequence,
      },
      deliveryAttempts: options.deliveryAttempts || execution.checkpoint?.deliveryAttempts || [],
    });
    execution.checkpoint = checkpoint;
    await this.store.appendMessage(reference, {
      role: 'assistant', content: { type: 'email.draft', preview: approvalArguments },
      metadata: { runId: execution.runId, approvalId: approval.approvalId },
      idempotencyKey: `${execution.requestKey}:approval:${approval.approvalId}:draft`,
    });
    await this.store.appendMessage(reference, {
      role: 'assistant', content: { type: 'approval.required', approval },
      metadata: { runId: execution.runId, approvalId: approval.approvalId },
      idempotencyKey: `${execution.requestKey}:approval:${approval.approvalId}:message`,
    });
    await this.store.appendRun(reference, {
      runId: execution.runId, status: options.status || 'waiting_approval', event: options.event || 'approval_required', attempt: execution.attempt,
      checkpoint, metadata: { approvalId: approval.approvalId, redeliverySequence },
      idempotencyKey: `${execution.requestKey}:run:approval:${approval.approvalId}`,
    });
    return approval;
  }

  async #verifyApprovedEmailPreview(reference, execution, pending) {
    const result = await this.registry.execute('email.prepare', pending.call.input, {
      reference,
      conversation: await this.store.getConversation(reference),
      state: execution.state,
      signal: execution.controller.signal,
      approved: false,
      validationOnly: true,
      idempotencyKey: idempotency(`${pending.tool.idempotencyKey}:approval-preview`),
    });
    const preview = result?.preview || execution.state.emailPreview || result;
    const actualHash = copilotHash(emailDeliveryFingerprint(preview));
    const expectedHash = pending.deliveryFingerprintHash
      || copilotHash(emailDeliveryFingerprint(pending.approvalArguments || pending.call.input));
    if (actualHash !== expectedHash) {
      throw runtimeError(
        'COPILOT_EMAIL_APPROVAL_STALE',
        'The email recipient, delivery provenance, quality score, or attachment metadata changed after approval.',
        409,
        false,
      );
    }
    restoreToolState(execution.state, pending.call, { type: 'email.draft', preview });
  }

  async #recoverConsumedApproval(reference, execution, modelMessages) {
    const pending = execution.checkpoint?.pendingApproval;
    if (!pending) return null;
    const approval = await this.approvals.getApproval(reference, pending.approvalId);
    if (approval?.status !== 'consumed') return null;
    const toolRecord = pending.tool;
    const approvedArguments = pending.approvalArguments || pending.call.input || {};
    if (
      !toolRecord
      || approval.runId !== execution.checkpoint.runId
      || approval.toolRunId !== toolRecord.toolRunId
      || approval.toolName !== pending.call.name
      || approval.requestHash !== pending.requestHash
      || copilotHash(approval.arguments || {}) !== copilotHash(approvedArguments)
    ) {
      throw runtimeError('COPILOT_APPROVAL_STALE', 'Consumed approval does not match the paused delivery checkpoint.', 409, false);
    }
    const history = await this.store.listToolRuns(reference, { limit: 5000 });
    const completed = history.findLast((item) => (
      item.status === 'succeeded'
      && item.toolRunId === toolRecord.toolRunId
      && item.approvalId === approval.approvalId
      && item.metadata?.executionKey === toolRecord.idempotencyKey
      && item.metadata?.inputHash === toolRecord.inputHash
      && item.metadata?.approvalRequestHash === approval.requestHash
    ));
    if (!completed) {
      throw runtimeError(
        'COPILOT_EMAIL_DELIVERY_UNKNOWN',
        'The approval was consumed, but no exact durable SMTP completion receipt exists.',
        409,
        false,
      );
    }
    toolRecord.status = 'succeeded';
    toolRecord.result = completed.output;
    toolRecord.completedAt ||= completed.createdAt || this.now().toISOString();
    restoreToolState(execution.state, pending.call, completed.output);
    await this.#persistToolMessage(reference, execution, pending.call, toolRecord, completed.output);
    const resumedMessages = appendToolResultOnce(modelMessages, pending.call, completed.output);
    const nextStep = Number(execution.checkpoint.step || 0);
    execution.checkpoint = checkpointFor(execution, nextStep, resumedMessages);
    await this.#persistCheckpoint(reference, execution, nextStep, 'approval_recovered');
    return { modelMessages: resumedMessages, nextStep };
  }

  async #persistCheckpoint(reference, execution, step, boundary) {
    const checkpointHash = copilotHash(execution.checkpoint).slice(0, 24);
    await this.store.appendRun(reference, {
      runId: execution.runId,
      status: 'executing',
      event: 'checkpoint',
      attempt: execution.attempt,
      checkpoint: execution.checkpoint,
      metadata: { step, boundary },
      idempotencyKey: idempotency(`${execution.operationKey}:checkpoint:${execution.runId}:${boundary}:${checkpointHash}`),
    });
  }

  #emitPlan(reference, execution, status = 'executing') {
    if (!execution.state.plan) return;
    this.#event(reference, {
      type: 'assistant.plan',
      runId: execution.runId,
      status,
      text: planText(execution.state.plan),
      plan: execution.state.plan,
    });
  }

  async #consumeApproval(reference, execution, pending) {
    const current = await this.approvals.getApproval(reference, execution.approved.approvalId);
    if (current?.status === 'consumed') return current;
    if (!current || current.status !== 'approved' || current.requestHash !== pending.requestHash) {
      throw runtimeError('COPILOT_APPROVAL_STALE', 'Approval changed before the durable tool result could be consumed.', 409, false);
    }
    return this.approvals.consume(reference, current.approvalId, {
      idempotencyKey: idempotency(`${execution.operationKey}:consume:${current.approvalId}`),
      actor: 'runtime',
      reason: 'tool_result_persisted',
      expectedRevision: current.revision,
      expectedRequestHash: current.requestHash,
    });
  }

  async #pauseUnknownDelivery(reference, execution, error, modelMessages) {
    const pending = execution.checkpoint.pendingApproval;
    const toolRecord = pending.tool;
    const now = this.now().toISOString();
    toolRecord.status = 'outcome_unknown';
    toolRecord.deliveryAttempt = {
      ...(toolRecord.deliveryAttempt || {}),
      status: 'outcome_unknown',
      outcomeUnknownAt: now,
      errorCode: String(error?.code || 'COPILOT_EMAIL_DELIVERY_UNKNOWN'),
      errorMessage: safeError(error),
    };
    const deliveryAttempts = [
      ...(Array.isArray(execution.checkpoint.deliveryAttempts) ? execution.checkpoint.deliveryAttempts : []),
      { ...toolRecord.deliveryAttempt, approvalId: pending.approvalId, toolRunId: toolRecord.toolRunId },
    ];
    execution.checkpoint.deliveryAttempts = deliveryAttempts;
    await this.store.appendToolRun(reference, {
      toolRunId: toolRecord.toolRunId,
      runId: toolRecord.runId,
      toolName: pending.call.name,
      status: 'outcome_unknown',
      approvalId: pending.approvalId,
      input: pending.call.input,
      errorCode: 'COPILOT_EMAIL_DELIVERY_UNKNOWN',
      errorMessage: safeError(error),
      metadata: {
        executionKey: toolRecord.idempotencyKey,
        inputHash: toolRecord.inputHash,
        ...(pending.requestHash ? { approvalRequestHash: pending.requestHash } : {}),
      },
      idempotencyKey: `${toolRecord.idempotencyKey}:unknown`,
    });
    await this.store.appendRun(reference, {
      runId: execution.runId,
      status: 'waiting_input',
      event: 'delivery_outcome_unknown',
      attempt: execution.attempt,
      checkpoint: execution.checkpoint,
      recoverable: true,
      stopReason: 'delivery_outcome_unknown',
      errorCode: 'COPILOT_EMAIL_DELIVERY_UNKNOWN',
      errorMessage: safeError(error),
      idempotencyKey: idempotency(`${execution.operationKey}:delivery_unknown:${toolRecord.toolRunId}`),
    });
    const currentApproval = await this.approvals.getApproval(reference, pending.approvalId);
    if (currentApproval?.status === 'approved') {
      await this.approvals.cancel(reference, currentApproval.approvalId, {
        idempotencyKey: idempotency(`${execution.operationKey}:invalidate:${currentApproval.approvalId}`),
        actor: 'runtime',
        reason: 'delivery_outcome_unknown',
        expectedRevision: currentApproval.revision,
      });
    }
    const nextSequence = Number(pending.redeliverySequence || 0) + 1;
    const approval = await this.#requestApproval(reference, execution, pending.call, Number(pending.step || execution.checkpoint.step || 1) - 1, modelMessages, {
      redeliverySequence: nextSequence,
      deliveryAttempts,
      status: 'waiting_input',
      event: 'delivery_reapproval_required',
    });
    this.#event(reference, {
      type: 'approval.required',
      runId: execution.runId,
      approval,
      reason: 'delivery_outcome_unknown',
    });
    this.#event(reference, {
      type: 'run.paused',
      runId: execution.runId,
      status: 'waiting_input',
      error: { code: 'COPILOT_EMAIL_DELIVERY_UNKNOWN', message: safeError(error) },
      resumable: true,
    });
  }

  async #fail(reference, execution, error) {
    const aborted = execution.controller.signal.aborted || error?.code === 'COPILOT_RUN_CANCELLED';
    const status = aborted ? 'cancelled' : 'failed';
    const code = aborted ? 'COPILOT_RUN_CANCELLED' : String(error?.code || 'COPILOT_RUN_FAILED');
    const message = aborted ? 'The run was stopped and can be continued.' : safeError(error);
    const recoverable = error?.recoverable !== false;
    try {
      await this.store.appendMessage(reference, {
        role: 'assistant', content: { type: 'run.failed', code, message, recoverable },
        metadata: { runId: execution.runId },
        idempotencyKey: `${execution.requestKey}:error:${execution.attempt}`,
      });
      await this.store.appendRun(reference, {
        runId: execution.runId, status, event: status, attempt: execution.attempt,
        checkpoint: execution.checkpoint || null, recoverable, stopReason: aborted ? 'user_cancelled' : 'runtime_error',
        errorCode: code, errorMessage: message,
        idempotencyKey: `${execution.requestKey}:run:${status}:${execution.attempt}`,
      });
    } catch {
      // Preserve the original provider/tool error if persistence also fails.
    }
    this.#event(reference, { type: aborted ? 'run.paused' : 'run.failed', runId: execution.runId, error: { code, message }, resumable: recoverable });
  }

  #event(reference, event) {
    this.emit(reference, { ...event, createdAt: this.now().toISOString() });
  }
}

async function callModel(fetchImpl, session, messages, toolDefinitions, signal) {
  if (typeof fetchImpl !== 'function') throw runtimeError('COPILOT_PROVIDER_UNAVAILABLE', 'The AI provider transport is unavailable.', 503);
  const startedAt = performance.now();
  const wireApi = session.wireApi === 'responses' ? 'responses' : 'chat_completions';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (session.apiKey) headers.Authorization = `Bearer ${session.apiKey}`;
  const wireTools = toolDefinitions.map((tool) => modelToolDefinition(tool, wireApi));
  const body = wireApi === 'responses'
    ? { model: session.model, input: toResponsesInput(messages), tools: wireTools, tool_choice: 'auto' }
    : { model: session.model, messages, tools: wireTools, tool_choice: 'auto', temperature: 0.1 };
  const endpoints = modelEndpointCandidates(session, wireApi);
  for (const [index, url] of endpoints.entries()) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: combineSignal(signal, MODEL_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw runtimeError('COPILOT_PROVIDER_UNREACHABLE', 'The selected model provider could not be reached.', 502, true, error);
    }
    const payload = await response.json().catch(() => null);
    const hasFallback = index < endpoints.length - 1;
    if (!response.ok) {
      if (hasFallback && [404, 405].includes(response.status)) continue;
      const detail = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 500);
      throw runtimeError(response.status === 429 ? 'COPILOT_PROVIDER_RATE_LIMITED' : 'COPILOT_PROVIDER_FAILED', `The model provider rejected the run: ${detail}`, response.status === 429 ? 429 : 502);
    }
    if (!isCompatibleModelPayload(payload, wireApi)) {
      if (hasFallback) continue;
      throw runtimeError(
        'COPILOT_PROVIDER_INVALID_RESPONSE',
        'The selected model endpoint returned a non-compatible response. Use the API Base URL ending in /v1.',
        502,
      );
    }
    const parsed = wireApi === 'responses' ? parseResponses(payload) : parseChatCompletion(payload);
    return { ...parsed, durationMs: Math.round(performance.now() - startedAt) };
  }
  throw runtimeError('COPILOT_PROVIDER_INVALID_RESPONSE', 'No compatible model endpoint was found.', 502);
}

function modelEndpointCandidates(session, wireApi) {
  const baseUrl = String(session.baseUrl || '').replace(/\/+$/u, '');
  const endpoint = wireApi === 'responses' ? 'responses' : 'chat/completions';
  const direct = `${baseUrl}/${endpoint}`;
  const parsed = new URL(baseUrl);
  if (parsed.pathname.toLowerCase().endsWith('/v1')) return [direct];
  const versioned = `${baseUrl}/v1/${endpoint}`;
  return ['relay', 'custom'].includes(String(session.provider || '').toLowerCase())
    ? [versioned, direct]
    : [direct];
}

function isCompatibleModelPayload(payload, wireApi) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (wireApi === 'responses') return Array.isArray(payload.output) || typeof payload.output_text === 'string';
  return Array.isArray(payload.choices);
}

function modelToolDefinition(tool, wireApi) {
  const definition = {
    name: wireToolName(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
  };
  if (supportsStrictToolSchema(tool.inputSchema)) definition.strict = true;
  return wireApi === 'responses'
    ? { type: 'function', ...definition }
    : { type: 'function', function: definition };
}

function supportsStrictToolSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.every(supportsStrictToolSchema);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.every(supportsStrictToolSchema);
  if (Array.isArray(schema.allOf)) return schema.allOf.every(supportsStrictToolSchema);
  if (schema.type === 'array') return supportsStrictToolSchema(schema.items);
  if (schema.type !== 'object') return typeof schema.type === 'string';
  if (schema.additionalProperties !== false) return false;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(properties).every((name) => required.has(name) && supportsStrictToolSchema(properties[name]));
}

function parseChatCompletion(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const text = contentText(message.content) || contentText(choice.text);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : message.function_call
      ? [{ id: message.function_call.id, function: message.function_call }]
      : [];
  const calls = toolCalls.map((call) => ({
    id: String(call.id || crypto.randomUUID()), name: fromWireToolName(call.function?.name), input: parseArguments(call.function?.arguments), wireId: call.id,
  }));
  return calls.length ? { text, calls, rawAssistant: message } : parseJsonIntent(text);
}

function parseResponses(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const calls = output.filter((item) => item?.type === 'function_call').map((call) => ({
    id: String(call.call_id || call.id || crypto.randomUUID()), name: fromWireToolName(call.name), input: parseArguments(call.arguments), wireId: call.call_id || call.id,
  }));
  const text = String(payload?.output_text || output.flatMap((item) => Array.isArray(item?.content) ? item.content : []).filter((item) => ['output_text', 'text'].includes(item?.type)).map((item) => item.text).join('\n') || '');
  return calls.length ? { text, calls, rawAssistant: output } : parseJsonIntent(text);
}

function parseJsonIntent(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    const value = JSON.parse(cleaned);
    const source = Array.isArray(value?.toolCalls) ? value.toolCalls : value?.tool ? [value] : [];
    const calls = source.map((item) => ({ id: String(item.id || crypto.randomUUID()), name: String(item.tool || item.name || ''), input: item.arguments || item.input || {} })).filter((item) => item.name);
    if (calls.length) return { text: String(value.message || ''), calls, rawAssistant: value };
  } catch { /* Ordinary assistant prose is expected here. */ }
  return { text: String(text || ''), calls: [], rawAssistant: text };
}

function appendAssistantToolCalls(messages, response) {
  return [...messages, {
    role: 'assistant', content: response.text || null,
    tool_calls: response.calls.map((call) => ({ id: call.wireId || call.id, type: 'function', function: { name: wireToolName(call.name), arguments: JSON.stringify(call.input) } })),
  }];
}

function appendToolResult(messages, call, result) {
  return [...messages, { role: 'tool', tool_call_id: call.wireId || call.id, content: JSON.stringify(result) }];
}

function appendToolResultOnce(messages, call, result) {
  const toolCallId = call.wireId || call.id;
  if (messages.some((message) => message.role === 'tool' && message.tool_call_id === toolCallId)) return messages;
  return appendToolResult(messages, call, result);
}

async function buildModelHistory(store, reference, system) {
  const records = await store.listMessages(reference, { limit: 200 });
  const entries = [];
  for (const record of records) {
    if (record.role === 'tool') {
      const text = toolHistoryText(record.content);
      if (text) entries.push({ role: 'system', content: text });
      continue;
    }
    if (!['user', 'assistant'].includes(record.role)) continue;
    const text = record.role === 'user' ? userHistoryText(record) : messageText(record.content);
    if (text) entries.push({ role: record.role, content: text });
  }
  const selected = [];
  let characterBudget = 60_000;
  for (let index = entries.length - 1; index >= 0 && selected.length < 60; index -= 1) {
    const entry = entries[index];
    if (entry.content.length > characterBudget && selected.length > 0) break;
    const boundedContent = entry.content.slice(0, Math.max(0, characterBudget));
    selected.unshift({ ...entry, content: boundedContent });
    characterBudget -= boundedContent.length;
  }
  return [{ role: 'system', content: system }, ...selected];
}

function systemPrompt(reference, conversation, workspaceMode = 'ask') {
  const mode = normalizeWorkspaceMode(workspaceMode);
  const modeInstruction = mode === 'build'
    ? 'Build mode: produce a reusable artifact or implementation-ready result, and verify it before completion.'
    : mode === 'analyze'
      ? 'Analyze mode: inspect the relevant data, use deterministic analysis tools, quantify findings, and cite evidence.'
      : 'Ask mode: answer directly, using the minimum tool work needed for a grounded response.';
  return [
    'You are the interactive Data Copilot embedded in a local data workbench.',
    'Operate as a Planner, Executor, and Verifier. Keep a concise execution plan, use tools, then verify the result before the final answer.',
    'Use tools for every factual claim about task data. Never invent rows, files, recipients, send results, or tool output.',
    'The available tool list is selected dynamically. If a needed capability is absent, call tool.search and then tool.describe before continuing.',
    'Plan multi-step work, execute independent read tools in parallel, retain the current result across follow-up messages, and cite returned source URIs.',
    modeInstruction,
    'For all, batch, multiple, or per-job email requirement requests, call applications.extract_email_requirements. Return one result row for every matched application, report matched/scanned/returned/missing coverage, and continue with nextOffset until coverage.complete is true; never stop after the first record.',
    'For a job-application email, call applications.compose_email before email.prepare. Use the recruitment post subject rule, the extracted recruitment recipient, and the record-specific draft; never dump raw email lists, access-token query strings, or pipe-separated records into prose.',
    'Before email.send, first call email.prepare or email.preview and show the exact recipient, subject, body, and attachments. Email sending requires user approval.',
    'Use artifact.create for requested exports. State missing-field counts and date precision when they affect the result.',
    `Bound context: conversation=${reference.conversationId}; job=${reference.jobId}; snapshot=${reference.snapshotId}; mode=${reference.mode}.`,
    `Allowed scope: ${JSON.stringify(conversation.scope)}.`,
  ].join('\n');
}

function toResponsesInput(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') return { type: 'function_call_output', call_id: message.tool_call_id, output: message.content };
    if (message.tool_calls) {
      const items = [];
      if (message.content) items.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      return items;
    }
    return { role: message.role, content: message.content };
  }).flat();
}

async function findRequestRun(store, reference, requestKey) {
  const runs = await store.listRuns(reference, { limit: 5000 });
  return runs.find((run) => run.metadata?.requestKey === requestKey) || null;
}

async function requireConversation(store, reference) {
  const conversation = await store.getConversation(reference);
  if (!conversation) throw runtimeError('COPILOT_CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404, false);
  return conversation;
}

function normalizeAttachmentRefs(value) {
  const items = Array.isArray(value) ? value : [];
  return items.slice(0, 20).map((item) => typeof item === 'string'
    ? { attachmentId: item, name: '', mediaType: '', size: 0, sha256: '' }
    : item);
}

function modelMetadata(session) {
  return { provider: session.provider, model: session.model, wireApi: session.wireApi };
}

function emailApprovalSummary(input) {
  return `Send email to ${String(input?.to || '').slice(0, 200)} with subject ${String(input?.subject || '').slice(0, 300)} and ${(Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0)} attachment(s).`;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => item?.text || item?.content || '').filter(Boolean).join('\n');
  return '';
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (content?.text) return String(content.text);
  if (content?.type === 'email.draft') return `Email draft: ${JSON.stringify(content.preview)}`;
  return '';
}

function userHistoryText(record) {
  const text = messageText(record.content);
  const sources = normalizeContextSourceIds(record.metadata?.contextSourceIds);
  const attachments = normalizeAttachmentRefs(record.attachments).map((item) => item.attachmentId).filter(Boolean);
  const context = [];
  if (sources.length) context.push(`Selected context sources: ${sources.join(', ')}`);
  if (attachments.length) context.push(`Attached files available to attachment.parse: ${attachments.join(', ')}`);
  return context.length ? `${text}\n[${context.join('; ')}]` : text;
}

function toolHistoryText(content) {
  if (!content || typeof content !== 'object') return '';
  const name = String(content.name || 'tool');
  const result = content.result;
  if (result === undefined) return '';
  let serialized;
  try { serialized = JSON.stringify(result); } catch { serialized = String(result); }
  return `Recorded result from ${name}: ${serialized.slice(0, 12_000)}`;
}

function checkpointFor(execution, step, modelMessages, extra = {}) {
  const previous = execution.checkpoint || {};
  return {
    schemaVersion: 2,
    runId: execution.runId,
    operationKey: execution.operationKey,
    aiSessionId: execution.aiSessionId,
    workspaceMode: normalizeWorkspaceMode(execution.workspaceMode || previous.workspaceMode),
    contextSourceIds: normalizeContextSourceIds(execution.contextSourceIds),
    attempt: execution.attempt,
    step,
    modelMessages,
    intentText: execution.state.intentText || execution.intentText || previous.intentText || '',
    plan: execution.state.plan || previous.plan || null,
    evidence: Array.isArray(execution.state.evidence) ? execution.state.evidence : [],
    toolResults: Array.isArray(execution.state.toolResults) ? execution.state.toolResults.slice(-100) : [],
    activeToolNames: Array.isArray(execution.state.activeToolNames) ? execution.state.activeToolNames : [],
    completedToolNames: Array.isArray(execution.state.completedToolNames) ? execution.state.completedToolNames : [],
    repairCount: Number(execution.state.repairCount || 0),
    emailPreview: execution.state.emailPreview || null,
    emailPreviewInput: execution.state.emailPreviewInput || null,
    emailDeliveryFingerprint: execution.state.emailDeliveryFingerprint || null,
    applicationEmailDraft: execution.state.applicationEmailDraft || null,
    deliveryAttempts: Array.isArray(previous.deliveryAttempts) ? previous.deliveryAttempts : [],
    ...extra,
  };
}

function createToolBatch(execution, step, calls) {
  return {
    schemaVersion: 1,
    step,
    nextStep: step + 1,
    tools: calls.map((call, index) => createToolRecord(execution, call, step, index)),
  };
}

function createToolRecord(execution, call, step, index, { sequence = 0, runId = execution.runId } = {}) {
  const inputHash = copilotHash(call.input || {});
  const identityHash = copilotHash({
    operationKey: execution.operationKey,
    step,
    index,
    sequence,
    name: call.name,
    inputHash,
    providerCallId: String(call.wireId || call.id || ''),
  });
  return {
    call,
    step,
    index,
    sequence,
    runId,
    toolRunId: `tool-${identityHash.slice(0, 40)}`,
    idempotencyKey: `copilot-tool-${identityHash.slice(0, 40)}`,
    inputHash,
    status: 'pending',
    result: null,
  };
}

function restoreToolState(state, call, result) {
  state.toolResults ||= [];
  const resultKey = copilotHash({ name: call?.name, result });
  if (!state.toolResults.some((item) => item?.resultKey === resultKey)) {
    state.toolResults.push({ toolName: String(call?.name || ''), resultKey, ...structuredClone(result) });
    state.toolResults = state.toolResults.slice(-100);
  }
  state.evidence ||= [];
  const knownSources = new Set(state.evidence.map((item) => item.source));
  for (const item of collectToolEvidence(call?.name, result)) {
    if (!knownSources.has(item.source)) {
      knownSources.add(item.source);
      state.evidence.push(item);
    }
  }
  state.activeToolNames ||= [];
  if (['tool.search', 'tool.describe'].includes(call?.name)) {
    const discovered = (Array.isArray(result?.tools) ? result.tools : [])
      .map((item) => String(item?.name || item || '').trim())
      .filter(Boolean);
    state.activeToolNames = [...new Set([...state.activeToolNames, ...discovered])].slice(0, 100);
  }
  state.completedToolNames = [...new Set([...(state.completedToolNames || []), String(call?.name || '')].filter(Boolean))];
  if (['email.prepare', 'email.preview'].includes(call?.name)) {
    const preview = result?.preview || state.emailPreview || result;
    if (preview && typeof preview === 'object') {
      state.emailPreview = preview;
      state.emailPreviewInput = call.input || {};
      state.emailDeliveryFingerprint = emailDeliveryFingerprint(preview);
    }
  }
  if (call?.name === 'applications.compose_email' && result?.type === 'application.email_draft') {
    state.applicationEmailDraft = structuredClone(result);
  }
}

function createExecutionState(checkpoint = null) {
  return {
    datasets: new Map(),
    intentText: String(checkpoint?.intentText || ''),
    plan: checkpoint?.plan ? structuredClone(checkpoint.plan) : null,
    evidence: Array.isArray(checkpoint?.evidence) ? structuredClone(checkpoint.evidence) : [],
    toolResults: Array.isArray(checkpoint?.toolResults) ? structuredClone(checkpoint.toolResults) : [],
    activeToolNames: Array.isArray(checkpoint?.activeToolNames) ? [...checkpoint.activeToolNames] : [],
    completedToolNames: Array.isArray(checkpoint?.completedToolNames) ? [...checkpoint.completedToolNames] : [],
    repairCount: Number(checkpoint?.repairCount || 0),
    ...(checkpoint?.emailPreview ? { emailPreview: checkpoint.emailPreview } : {}),
    ...(checkpoint?.emailPreviewInput ? { emailPreviewInput: checkpoint.emailPreviewInput } : {}),
    ...(checkpoint?.emailDeliveryFingerprint ? { emailDeliveryFingerprint: checkpoint.emailDeliveryFingerprint } : {}),
    ...(checkpoint?.applicationEmailDraft ? { applicationEmailDraft: checkpoint.applicationEmailDraft } : {}),
  };
}

function normalizeWorkspaceMode(value) {
  const mode = String(value || 'ask').trim().toLowerCase();
  return ['ask', 'analyze', 'build'].includes(mode) ? mode : 'ask';
}

function assertApprovalPrerequisites(call, state) {
  if (call.name !== 'email.send') return;
  const preview = state?.emailPreview;
  const previewInput = state?.emailPreviewInput || preview;
  if (!preview || copilotHash(emailRequestFingerprint(previewInput)) !== copilotHash(emailRequestFingerprint(call.input))) {
    throw runtimeError(
      'COPILOT_EMAIL_PREVIEW_REQUIRED',
      'The exact email recipient, subject, body, and attachments must be prepared or previewed before approval.',
      409,
    );
  }
}

function emailApprovalArguments(input = {}, preview = null) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return { ...input };
  const keys = [
    'to', 'cc', 'bcc', 'replyTo', 'subject', 'text', 'body', 'attachmentIds', 'attachments',
    'deliveryMethod', 'deliverySource', 'source', 'jobRecordSource', 'qualityScore',
    'applicationNoteId', 'application',
  ];
  const result = { ...input };
  for (const key of keys) {
    if (Object.hasOwn(preview, key)) result[key] = preview[key];
  }
  return result;
}

function emailRequestFingerprint(value = {}) {
  return {
    to: String(value.to || '').trim().toLowerCase(),
    cc: normalizeEmailRecipients(value.cc),
    bcc: normalizeEmailRecipients(value.bcc),
    replyTo: String(value.replyTo || '').trim().toLowerCase(),
    subject: String(value.subject || '').trim(),
    text: String(value.text || value.body || '').trim(),
    attachmentIds: normalizeContextSourceIds(value.attachmentIds).sort(),
    deliveryMethod: String(value.deliveryMethod || 'smtp').trim().toLowerCase(),
    deliverySource: String(value.deliverySource || value.source || '').trim(),
    jobRecordSource: String(value.jobRecordSource || '').trim(),
    qualityScore: normalizeQualityScore(value.qualityScore),
    applicationNoteId: String(value.applicationNoteId || value.application?.noteId || '').trim(),
  };
}

function emailDeliveryFingerprint(value = {}) {
  const attachmentIds = normalizeContextSourceIds(value.attachmentIds).sort();
  const attachments = (Array.isArray(value.attachments) ? value.attachments : [])
    .map((item) => ({
      artifactId: String(item?.artifactId || item?.attachmentId || '').trim(),
      sha256: String(item?.sha256 || '').trim().toLowerCase(),
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : 0,
    }))
    .filter((item) => item.artifactId)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  const known = new Set(attachments.map((item) => item.artifactId));
  for (const artifactId of attachmentIds) {
    if (!known.has(artifactId)) attachments.push({ artifactId, sha256: '', size: 0 });
  }
  attachments.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  return { ...emailRequestFingerprint(value), attachmentIds, attachments };
}

function normalizeEmailRecipients(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeQualityScore(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : String(value);
}

function normalizeContextSourceIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { throw runtimeError('COPILOT_TOOL_ARGUMENTS_INVALID', 'The model returned invalid tool arguments.', 502); }
}

function wireToolName(name) { return `copilot_${String(name).replaceAll('.', '__')}`; }
function fromWireToolName(name) { return String(name || '').replace(/^copilot_/u, '').replaceAll('__', '.'); }
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}
function idempotency(value) {
  const text = String(value || '').trim().replace(/[^\p{L}\p{N}_.:-]/gu, '_');
  if (text.length < 8) throw runtimeError('COPILOT_IDEMPOTENCY_INVALID', 'Idempotency key must contain at least 8 characters.', 400, false);
  if (text.length <= 64) return text;
  return `${text.slice(0, 40)}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}
function safeError(error) { return String(error?.message || error || 'Unknown error').slice(0, 1000); }
function throwIfAborted(signal) { if (signal.aborted) throw cancelled(); }
function cancelled() { return runtimeError('COPILOT_RUN_CANCELLED', 'The run was cancelled.', 409); }
function deliveryUnknown(message, cause) {
  const error = runtimeError(
    'COPILOT_EMAIL_DELIVERY_UNKNOWN',
    message || 'The SMTP delivery outcome is unknown.',
    409,
    true,
    cause,
  );
  error.deliveryStatus = 'unknown';
  error.safeToRetry = false;
  return error;
}
function runtimeError(code, message, status, recoverable = true, cause) { return new DataCopilotRuntimeError(code, message, status, { recoverable, cause }); }
function combineSignal(signal, timeoutMs) { return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal; }
