import crypto from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { open, readFile, readdir, realpath, rm } from 'node:fs/promises';

import {
  normalizeCopilotIdempotencyKey,
  normalizeCopilotReference,
  readCopilotJson,
  requiredCopilotId,
  writeCopilotJsonlAtomically,
} from './data-copilot-store.mjs';
import {
  createCopilotContextSourceId,
  normalizeCopilotContextSourceIds as normalizeBoundContextSourceIds,
} from './copilot-context-source.mjs';
import { createContextManager } from './copilot/context-manager.mjs';
import { createCapabilityRuntime } from './copilot/capability-runtime.mjs';
import { createConversationRepository } from './copilot/conversation-repository.mjs';
import { runGoldenEvaluation as executeGoldenEvaluation } from './copilot/evaluation-suite.mjs';
import { createModelGateway } from './copilot/model-gateway.mjs';
import { createOrchestrator, TaskGraph } from './copilot/orchestrator.mjs';
import { createReadOnlySandbox } from './copilot/sandbox.mjs';
import { createRunCoordinator } from './copilot/run-coordinator.mjs';
import { createSkillRegistry } from './copilot/skills.mjs';
import { createSpecialistRouter } from './copilot/specialists.mjs';
import { createTerminalSessionManager } from './copilot/terminal-session-manager.mjs';
import {
  describeToolExecutionLedger,
  synchronizeToolExecutionLedger,
} from './copilot/tool-execution-ledger.mjs';
import { createUsageTracker } from './copilot/usage-tracker.mjs';
import { verifyAnswer } from './copilot/verifier.mjs';

const ACTIVE_STATUSES = new Set([
  'planning', 'executing', 'waiting_input', 'stopping',
  'queued', 'running', 'cancelling',
]);
const DEFAULT_ALLOWED_SCOPES = Object.freeze(['*']);
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const EVENT_BUFFER_LIMIT = 250;
const STREAM_EVENT_TYPES = new Set([
  'assistant.delta',
  'assistant.reasoning.delta',
  'message.delta',
  'reasoning.delta',
  'subagent.output.delta',
  'subagent.reasoning.delta',
  'subagent.tool.call.delta',
  'tool.progress',
]);

export class DataCopilotServiceError extends Error {
  constructor(code, message, status = 400, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DataCopilotServiceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Coordinates persisted conversations without duplicating Store, Runtime,
 * Approval, or Artifact ownership. rootDir is the shared data directory, so
 * conversations are discovered below data/copilot/<conversationId>.
 */
export class DataCopilotService {
  constructor({
    rootDir,
    store,
    approvals,
    artifacts,
    runtime,
    policy,
    mcpAdapter = null,
    capabilityRegistry = null,
    workspaceAdapter = null,
    gitAdapter = null,
    projectWorkspaceService = null,
    capabilityRuntimeFactory = createCapabilityRuntime,
    terminalSessionManager = null,
    runtimeV3Repository = null,
    mcpClientManager = null,
    manager,
    aiSessions = runtime?.aiSessions,
    contextManager = null,
    repository = null,
    modelGateway = null,
    modelRunBroker = null,
    toolExecutionBroker = null,
    executionWorkerSupervisor = null,
    orchestrator = null,
    sandbox = null,
    skillRegistry = null,
    specialistRouter = null,
    usageTracker = null,
    productionStore = null,
    runCoordinator = null,
    subagentRuntime = null,
    now = () => new Date(),
  } = {}) {
    if (!store || !approvals || !artifacts || !runtime || !policy) {
      throw serviceError(
        'COPILOT_SERVICE_DEPENDENCIES_REQUIRED',
        'Data Copilot store, approvals, artifacts, runtime, and policy are required.',
        500,
      );
    }
    this.rootDir = path.resolve(rootDir || store.rootDir || 'data');
    this.store = store;
    this.approvals = approvals;
    this.artifacts = artifacts;
    this.runtime = runtime;
    this.policy = policy;
    this.mcpAdapter = mcpAdapter;
    this.capabilityRegistry = capabilityRegistry || runtime.registry || null;
    this.workspaceAdapter = workspaceAdapter;
    this.gitAdapter = gitAdapter;
    this.projectWorkspaceService = projectWorkspaceService;
    this.capabilityRuntimeFactory = capabilityRuntimeFactory;
    this.terminalSessionManager = terminalSessionManager || createTerminalSessionManager({
      now,
      repository: runtimeV3Repository,
    });
    this.terminalLeases = new Map();
    this.mcpClientManager = mcpClientManager;
    this.manager = manager || policy.manager;
    this.aiSessions = aiSessions;
    this.contextManager = contextManager || createContextManager({ now });
    this.repository = repository || createConversationRepository({ store });
    this.modelGateway = modelGateway || createModelGateway({ now });
    this.modelRunBroker = modelRunBroker && typeof modelRunBroker.runTurn === 'function'
      ? modelRunBroker
      : null;
    this.toolExecutionBroker = toolExecutionBroker && typeof toolExecutionBroker.submit === 'function'
      ? toolExecutionBroker
      : null;
    this.runtimeV3Repository = runtimeV3Repository || this.toolExecutionBroker?.repository || null;
    this.executionWorkerSupervisor = executionWorkerSupervisor
      && typeof executionWorkerSupervisor.describe === 'function'
      ? executionWorkerSupervisor
      : null;
    this.orchestrator = orchestrator || createOrchestrator({ now });
    this.sandbox = sandbox || createReadOnlySandbox();
    this.skillRegistry = skillRegistry || createSkillRegistry();
    this.specialistRouter = specialistRouter || createSpecialistRouter();
    this.usageTracker = usageTracker || createUsageTracker({ now });
    this.productionStore = productionStore;
    this.runCoordinator = runCoordinator || (productionStore
      ? createRunCoordinator({ store: productionStore, orchestrator: this.orchestrator, now })
      : null);
    this.subagentRuntime = subagentRuntime;
    this.now = now;
    this.references = new Map();
    this.listeners = new Map();
    this.eventBuffers = new Map();
    this.eventSequences = new Map();
    this.modelSessions = new Map();
    this.operations = new Map();
    this.discoveryErrors = [];
    this.terminalSessionsRecovered = 0;
    this.initialized = false;

    const previousEmit = typeof runtime.emit === 'function' ? runtime.emit.bind(runtime) : null;
    runtime.emit = (reference, event) => {
      previousEmit?.(reference, event);
      this.emit(reference, event);
    };
    if (typeof runtime.setWorkspaceBindingResolver === 'function') {
      runtime.setWorkspaceBindingResolver((binding, execution) => (
        this.#resolveRuntimeWorkspaceBinding(binding, execution)
      ));
    }
    if (this.modelRunBroker) {
      runtime.setModelRunBroker?.(this.modelRunBroker);
      this.subagentRuntime?.setModelRunBroker?.(this.modelRunBroker);
    }
  }

  async initialize() {
    if (this.initialized) {
      return {
        conversations: this.references.size,
        interrupted: 0,
        terminalSessionsRecovered: this.terminalSessionsRecovered,
        errors: structuredClone(this.discoveryErrors),
      };
    }
    if (this.projectWorkspaceService?.initialize) await this.projectWorkspaceService.initialize();
    this.references.clear();
    this.discoveryErrors = [];
    try {
      const recovery = await this.terminalSessionManager?.recover?.();
      this.terminalSessionsRecovered = Number.isSafeInteger(recovery?.recovered) && recovery.recovered >= 0
        ? recovery.recovered
        : 0;
    } catch (error) {
      this.terminalSessionsRecovered = 0;
      this.discoveryErrors.push({
        conversationId: 'terminal-sessions',
        code: String(error?.code || 'COPILOT_TERMINAL_RECOVERY_FAILED'),
        message: String(error?.message || error).slice(0, 500),
      });
    }
    const directory = path.join(this.rootDir, 'copilot');
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    let interrupted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const id = requiredCopilotId(entry.name, 'conversation ID');
        const conversation = await readCopilotJson(path.join(directory, id, 'conversation.json'), { allowMissing: true });
        if (!conversation) continue;
        const reference = normalizeCopilotReference(conversation);
        const persisted = await this.store.getConversation(reference);
        if (!persisted) continue;
        this.references.set(reference.conversationId, reference);
        await this.#loadPersistedEvents(reference);
        if (ACTIVE_STATUSES.has(persisted.status) && persisted.runState?.currentRunId) {
          const checkpoint = persisted.runState?.checkpoint || null;
          await this.store.appendRun(reference, {
            runId: persisted.runState.currentRunId,
            status: 'resumable',
            event: 'service_restarted',
            attempt: Number(persisted.runState.attempt || 1),
            checkpoint,
            recoverable: Boolean(checkpoint),
            stopReason: 'service_restart',
            errorCode: 'COPILOT_SERVICE_RESTARTED',
            errorMessage: checkpoint
              ? 'The service restarted. The saved run can be continued.'
              : 'The service restarted before a recoverable checkpoint was saved.',
            idempotencyKey: restartKey(reference.conversationId, persisted.runState.currentRunId),
          });
          interrupted += 1;
        }
      } catch (error) {
        this.discoveryErrors.push({
          conversationId: entry.name,
          code: String(error?.code || 'COPILOT_DISCOVERY_FAILED'),
          message: String(error?.message || error).slice(0, 500),
        });
      }
    }
    this.initialized = true;
    return {
      conversations: this.references.size,
      interrupted,
      terminalSessionsRecovered: this.terminalSessionsRecovered,
      errors: structuredClone(this.discoveryErrors),
    };
  }

  async close() {
    await this.terminalSessionManager?.close?.();
    this.terminalLeases.clear();
  }

  async createConversation(value = {}) {
    const jobId = requiredCopilotId(value.jobId, 'job ID');
    const job = this.#getJob(jobId);
    const mode = normalizeMode(value.mode);
    const jobRevision = normalizeJobRevision(job.revision);
    const snapshotId = `job-r${jobRevision}`;
    if (String(value.snapshotId || '').trim()) {
      const suppliedSnapshotId = requiredCopilotId(value.snapshotId, 'snapshot ID');
      if (suppliedSnapshotId !== snapshotId) {
        throw serviceError(
          'COPILOT_SNAPSHOT_MISMATCH',
          `The requested snapshot does not match current task revision ${jobRevision}.`,
          409,
        );
      }
    }
    const scope = normalizeScopeInput(value.scope, value.contextSourceIds, job);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `conversation:${crypto.randomUUID()}`,
      'conversation idempotency key',
    );
    const selectedModel = this.#resolveSelectedModel(
      value.aiSessionId || objectValue(value.selectedModel).aiSessionId,
      value.selectedModel,
    );
    const snapshot = await this.#captureSnapshot(job);
    const conversation = await this.store.createConversation({
      ...(value.conversationId ? { conversationId: requiredCopilotId(value.conversationId, 'conversation ID') } : {}),
      jobId,
      snapshotId,
      mode,
      scope,
      title: normalizeTitle(value.title, job),
      filters: objectValue(value.filters),
      selectedModel,
      idempotencyKey,
    });
    const reference = normalizeCopilotReference(conversation);
    this.policy.validateReference(reference, conversation);
    this.references.set(reference.conversationId, reference);
    if (selectedModel.aiSessionId) {
      this.modelSessions.set(reference.conversationId, selectedModel.aiSessionId);
    }
    this.emit(reference, { type: 'conversation.created', conversation: publicConversation(conversation) });
    return { conversation: publicConversation(conversation), ...(snapshot ? { snapshot } : {}) };
  }

  async listConversations({ jobId = null, mode = null, limit = 100 } = {}) {
    await this.#ensureInitialized();
    const maximum = boundedInteger(limit, 100, 1, 500);
    const conversations = [];
    for (const reference of this.references.values()) {
      if (jobId && reference.jobId !== String(jobId)) continue;
      if (mode && reference.mode !== String(mode)) continue;
      try {
        const conversation = await this.store.getConversation(reference);
        if (conversation) conversations.push(publicConversation(conversation));
      } catch (error) {
        this.discoveryErrors.push({
          conversationId: reference.conversationId,
          code: String(error?.code || 'COPILOT_READ_FAILED'),
          message: String(error?.message || error).slice(0, 500),
        });
      }
    }
    conversations.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return {
      conversations: conversations.slice(0, maximum),
      total: conversations.length,
      discoveryErrors: structuredClone(this.discoveryErrors),
    };
  }

  async getConversation(conversationId) {
    const { reference, conversation } = await this.#conversation(conversationId);
    const [approvals, attachmentResult, artifactResult] = await Promise.all([
      this.approvals.listApprovals(reference),
      this.artifacts.listAttachments(reference),
      this.artifacts.listArtifacts(reference),
    ]);
    return {
      conversation: publicConversation(conversation),
      approvals,
      attachments: attachmentResult.attachments,
      artifacts: artifactResult.artifacts,
    };
  }

  async listMessages(conversationId, options = {}) {
    const { reference } = await this.#conversation(conversationId);
    const messages = await this.store.listMessages(reference, {
      afterSequence: boundedInteger(options.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(options.limit, 1000, 1, 5000),
    });
    return {
      messages,
      nextSequence: messages.length ? messages.at(-1).sequence : Number(options.afterSequence || 0),
    };
  }

  async getMcpContext(conversationId) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    this.#requireProductionStore();
    const snapshot = this.productionStore.getSnapshot(reference.jobId, reference.snapshotId);
    if (!snapshot) {
      throw serviceError('COPILOT_SNAPSHOT_NOT_FOUND', 'The MCP-bound snapshot was not found.', 404);
    }
    return {
      reference: structuredClone(reference),
      conversation: structuredClone(conversation),
      snapshot: structuredClone(snapshot),
    };
  }

  async listRuns(conversationId, options = {}) {
    const { reference } = await this.#conversation(conversationId);
    const runs = await this.store.listRuns(reference, {
      afterSequence: boundedInteger(options.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: boundedInteger(options.limit, 100, 1, 1000),
    });
    return {
      runs,
      nextSequence: runs.length ? runs.at(-1).sequence : Number(options.afterSequence || 0),
    };
  }

  async updateConversation(conversationId, value = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    const patch = {};
    for (const key of ['title', 'filters', 'lastContextSourceIds']) {
      if (Object.hasOwn(value, key)) patch[key] = value[key];
    }
    if (Object.hasOwn(value, 'selectedModel')) {
      const existing = normalizeSelectedModel(conversation.selectedModel);
      const requested = objectValue(value.selectedModel);
      const aiSessionId = String(
        requested.aiSessionId || existing.aiSessionId || this.modelSessions.get(reference.conversationId) || '',
      ).trim();
      patch.selectedModel = this.#resolveSelectedModel(aiSessionId, { ...existing, ...requested });
      if (patch.selectedModel.aiSessionId) {
        this.modelSessions.set(reference.conversationId, patch.selectedModel.aiSessionId);
      }
    }
    const updated = await this.store.updateConversation(reference, patch, { expectedRevision: value.expectedRevision });
    this.emit(reference, { type: 'conversation.updated', conversation: publicConversation(updated) });
    return { conversation: publicConversation(updated), previousRevision: conversation.revision };
  }

  async deleteConversation(conversationId) {
    const { reference, conversation } = await this.#conversation(conversationId);
    if (ACTIVE_STATUSES.has(conversation.status)) {
      throw serviceError('COPILOT_CONVERSATION_ACTIVE', 'Active conversations must be cancelled before deletion.', 409);
    }
    await rm(path.join(this.rootDir, 'copilot', reference.conversationId), { recursive: true, force: true });
    this.references.delete(reference.conversationId);
    this.eventBuffers.delete(reference.conversationId);
    this.eventSequences.delete(reference.conversationId);
    this.listeners.delete(reference.conversationId);
    return { deleted: true, conversationId: reference.conversationId };
  }

  async listEvents(conversationId, { afterSeq = 0, limit = 500, runId = '' } = {}) {
    const { reference } = await this.#conversation(conversationId);
    const after = boundedInteger(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const maximum = boundedInteger(limit, 500, 1, 5000);
    const events = await readEventLog(this.#eventFile(reference.conversationId));
    const lastSeq = Number(this.eventSequences.get(reference.conversationId) || events.at(-1)?.seq || events.at(-1)?.eventId || 0);
    const firstSeq = Number(events[0]?.seq || events[0]?.eventId || 0);
    const gap = after > 0 && firstSeq > after + 1 ? { from: after + 1, to: firstSeq - 1 } : null;
    const matching = events
      .filter((event) => Number(event.seq || event.eventId || 0) > after)
      .filter((event) => !runId || event.runId === runId || event.payload?.runId === runId);
    const selected = matching.slice(0, maximum);
    const nextSeq = Number(selected.at(-1)?.seq || after);
    const replayLastSeq = Number(matching.at(-1)?.seq || after);
    return {
      schemaVersion: 1,
      conversationId: reference.conversationId,
      events: selected,
      nextSeq,
      lastSeq,
      hasMore: nextSeq < replayLastSeq,
      gap,
    };
  }

  async listRunEvents(runId, options = {}) {
    const id = requiredCopilotId(runId, 'run ID');
    for (const reference of this.references.values()) {
      const runs = await this.repository.listRuns(reference, { afterSequence: 0, limit: 5000 });
      if (!runs.some((run) => run.runId === id)) continue;
      const replay = await this.listEvents(reference.conversationId, { ...options, runId: id });
      return {
        ...replay,
        runId: id,
      };
    }
    throw serviceError('COPILOT_RUN_NOT_FOUND', 'Data Copilot run was not found.', 404);
  }

  async buildWorkingSet(conversationId, value = {}) {
    const { reference } = await this.#conversation(conversationId);
    const sourceKinds = value.kind ? [String(value.kind)] : ['posts', 'comments', 'users', 'artifacts'];
    const [messages, sources] = await Promise.all([
      this.repository.listMessages(reference, { afterSequence: 0, limit: 5000 }),
      Promise.all(sourceKinds.map((kind) => this.listContextRecords({ jobId: reference.jobId, mode: reference.mode, kind, query: value.query, offset: 0, limit: 100 }))),
    ]);
    const pins = this.productionStore?.listContextPins(reference.conversationId) || [];
    const result = this.contextManager.buildWorkingSet({
      query: value.query,
      constraints: value.constraints || [],
      goal: value.goal,
      messages,
      sources: sources.flatMap((entry) => entry.items || []),
      tools: value.tools || [],
      memories: value.memories || [],
      pins,
      requiredContextIds: value.requiredContextIds || [],
      budget: value.budget,
      reservedOutputTokens: value.reservedOutputTokens,
      conversationId: reference.conversationId,
      runId: value.runId,
      compact: value.compact !== false,
    });
    if (result.compaction && this.productionStore) this.productionStore.recordCompaction(result.compaction);
    return result;
  }

  async pinContext(conversationId, value = {}) {
    const { reference } = await this.#conversation(conversationId);
    this.#requireProductionStore();
    return {
      schemaVersion: 2,
      pin: this.productionStore.upsertContextPin({
        conversationId: reference.conversationId,
        itemType: value.itemType || value.type,
        itemId: value.itemId || value.id,
        value: value.value || {},
      }),
    };
  }

  async listContextPins(conversationId) {
    const { reference } = await this.#conversation(conversationId);
    this.#requireProductionStore();
    return { schemaVersion: 2, pins: this.productionStore.listContextPins(reference.conversationId) };
  }

  async removeContextPin(conversationId, pinId) {
    const { reference } = await this.#conversation(conversationId);
    this.#requireProductionStore();
    const id = requiredCopilotId(pinId, 'pin ID');
    const pin = this.productionStore.listContextPins(reference.conversationId).find((item) => item.pinId === id);
    if (!pin) throw serviceError('COPILOT_CONTEXT_PIN_NOT_FOUND', 'Context pin was not found.', 404);
    return { schemaVersion: 2, removed: this.productionStore.removeContextPin(id), pinId: id };
  }

  verifyAnswer(value = {}) {
    return verifyAnswer(value);
  }

  async delegateSubagents(conversationId, value = {}) {
    this.#requireSubagentRuntime();
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const aiSessionId = String(value.aiSessionId || this.modelSessions.get(reference.conversationId) || '').trim();
    if (!aiSessionId) throw serviceError('COPILOT_AI_SESSION_REQUIRED', 'A selected model session is required to delegate subagent work.', 409);
    this.#resolveSelectedModel(aiSessionId, conversation.selectedModel);
    if (aiSessionId) this.modelSessions.set(reference.conversationId, aiSessionId);
    const parentRunId = String(value.parentRunId || `api-run-${crypto.randomUUID()}`);
    const parentToolRunId = String(value.parentToolRunId || `api-tool-${crypto.randomUUID()}`);
    return this.subagentRuntime.delegate(value, {
      reference,
      conversation,
      contextSourceIds: value.contextSourceIds || conversation.lastContextSourceIds || reference.scope?.contextSourceIds || [],
      aiSessionId,
      runId: parentRunId,
      toolRunId: parentToolRunId,
      agentDepth: 0,
      signal: isAbortSignal(value.signal) ? value.signal : undefined,
      emit: (event) => this.emit(reference, event),
    });
  }

  async executeWorkbenchTool(toolName, input = {}, securityContext = {}, executionOptions = {}) {
    const startedAt = Date.now();
    const body = objectValue(input);
    const conversationId = String(body.conversationId || '');
    try {
      // A workbench task becomes a real workspace capability only when both
      // identifiers are present. This keeps existing data-only workbench
      // calls on the legacy sandbox while giving project tasks a scoped root,
      // lease, authority, and replayable receipt.
      if (body.projectId && body.workspaceId) {
        const { projectId, workspaceId, conversationId: ignoredConversationId, ...workspaceInput } = body;
        return await this.executeProjectWorkspaceTool(
          projectId,
          workspaceId,
          toolName,
          workspaceInput,
          securityContext,
          executionOptions,
        );
      }
      const output = await this.sandbox.execute(toolName, body);
      const durationMs = Date.now() - startedAt;
      this.#recordUsage({ conversationId, toolCalls: 1, latencyMs: durationMs });
      this.#recordTrace({ conversationId, operation: `workbench.tool:${String(toolName)}`, status: 'completed', durationMs, payload: { outputType: output?.kind || typeof output } });
      return { schemaVersion: 1, toolName: String(toolName), output };
    } catch (error) {
      this.#recordTrace({ conversationId, operation: `workbench.tool:${String(toolName)}`, status: 'failed', durationMs: Date.now() - startedAt, payload: { code: String(error?.code || ''), message: String(error?.message || error).slice(0, 500) } });
      throw error;
    }
  }

  async executeWorkbenchGraph(value = {}, securityContext = {}) {
    const tasks = (Array.isArray(value.tasks) ? value.tasks : []).map((task) => ({
      ...task,
      kind: String(task.toolName || task.kind || ''),
    }));
    if (!tasks.length) throw serviceError('COPILOT_TASK_GRAPH_EMPTY', 'At least one workbench task is required.');
    const conversationId = String(value.conversationId || '');
    const executeTask = async (task) => {
      const taskInput = objectValue(task.input);
      if (taskInput.projectId && taskInput.workspaceId) {
        const { projectId, workspaceId, conversationId: ignoredConversationId, ...workspaceInput } = taskInput;
        return this.executeProjectWorkspaceTool(projectId, workspaceId, task.kind, workspaceInput, securityContext);
      }
      return this.sandbox.execute(task.kind, taskInput);
    };
    if (this.runCoordinator && conversationId) {
      const { reference } = await this.#conversation(conversationId);
      const events = [];
      const startedAt = Date.now();
      try {
        const result = await this.runCoordinator.execute({
          ...value,
          conversationId: reference.conversationId,
          tasks,
          executeTask,
          onEvent: (event) => {
            events.push(event);
            this.emit(reference, event);
          },
        });
        const durationMs = Date.now() - startedAt;
        this.#recordUsage({ conversationId: reference.conversationId, runId: result.run?.runId, toolCalls: tasks.length, latencyMs: durationMs });
        this.#recordTrace({ conversationId: reference.conversationId, runId: result.run?.runId, operation: 'workbench.graph.v2', status: 'completed', durationMs, payload: { tasks: tasks.length, completed: Object.keys(result.outputs || {}).length, governance: result.governance } });
        return { schemaVersion: 2, ...result, events };
      } catch (error) {
        this.#recordTrace({ conversationId: reference.conversationId, runId: String(value.runId || ''), operation: 'workbench.graph.v2', status: 'failed', durationMs: Date.now() - startedAt, payload: { code: String(error?.code || ''), message: String(error?.message || error).slice(0, 500) } });
        throw error;
      }
    }
    const graph = new TaskGraph(tasks);
    const events = [];
    const startedAt = Date.now();
    const result = await this.orchestrator.run(
      graph,
      executeTask,
      {
        budget: objectValue(value.budget),
        onEvent: (event) => events.push(event),
      },
    );
    const durationMs = Date.now() - startedAt;
    this.#recordUsage({ conversationId, toolCalls: tasks.length, latencyMs: durationMs });
    this.#recordTrace({
      conversationId,
      operation: 'workbench.graph',
      status: 'completed',
      durationMs,
      payload: { tasks: tasks.length, completed: Object.keys(result.outputs || {}).length, governance: result.governance },
    });
    return { schemaVersion: 1, ...result, events };
  }

  getWorkbenchRun(runId, conversationId) {
    this.#requireRunCoordinator();
    const id = requiredCopilotId(runId, 'run ID');
    const ownerId = requiredCopilotId(conversationId, 'conversation ID');
    const state = this.runCoordinator.getState(id);
    if (!state.run) throw serviceError('COPILOT_RUN_NOT_FOUND', 'Data Copilot run was not found.', 404);
    if (state.run.conversationId !== ownerId) {
      throw serviceError('COPILOT_RUN_CONTEXT_MISMATCH', 'The run does not belong to this conversation.', 409);
    }
    return state;
  }

  pauseWorkbenchRun(runId, conversationId) {
    this.#requireRunCoordinator();
    const id = requiredCopilotId(runId, 'run ID');
    this.getWorkbenchRun(id, conversationId);
    const accepted = this.runCoordinator.pause(id);
    if (!accepted && !this.runCoordinator.getState(id).run) throw serviceError('COPILOT_RUN_NOT_FOUND', 'Data Copilot run was not found.', 404);
    return { schemaVersion: 2, accepted, action: 'pause', runId: id };
  }

  cancelWorkbenchRun(runId, conversationId) {
    this.#requireRunCoordinator();
    const id = requiredCopilotId(runId, 'run ID');
    const state = this.getWorkbenchRun(id, conversationId);
    if (isSubagentRunState(state)) {
      this.#requireSubagentRuntime();
      const parent = subagentParentIds(state);
      return this.subagentRuntime.cancel(id, {
        conversationId: state.run.conversationId,
        runId: parent.parentRunId,
        toolRunId: parent.parentToolRunId,
        agentDepth: 0,
        emit: (event) => this.emit(state.run.conversationId, event),
      });
    }
    const accepted = this.runCoordinator.cancel(id);
    if (!accepted && !state.run) throw serviceError('COPILOT_RUN_NOT_FOUND', 'Data Copilot run was not found.', 404);
    return { schemaVersion: 2, accepted, action: 'cancel', runId: id };
  }

  async resumeWorkbenchRun(runId, conversationId, value = {}) {
    this.#requireRunCoordinator();
    const id = requiredCopilotId(runId, 'run ID');
    const state = this.getWorkbenchRun(id, conversationId);
    if (isSubagentRunState(state)) {
      this.#requireSubagentRuntime();
      const { reference, conversation } = await this.#conversation(state.run.conversationId);
      const aiSessionId = resolveSubagentSessionId(value, state, this.modelSessions.get(reference.conversationId));
      if (!aiSessionId) throw serviceError('COPILOT_AI_SESSION_REQUIRED', 'A selected model session is required to resume the subagent run.', 409);
      this.#resolveSelectedModel(aiSessionId, conversation.selectedModel);
      this.modelSessions.set(reference.conversationId, aiSessionId);
      const parent = subagentParentIds(state);
      return this.subagentRuntime.resume(id, {
        reference,
        conversation,
        contextSourceIds: value.contextSourceIds || firstSubagentInput(state).contextSourceIds || [],
        aiSessionId,
        runId: parent.parentRunId,
        toolRunId: parent.parentToolRunId,
        agentDepth: 0,
        signal: isAbortSignal(value.signal) ? value.signal : undefined,
        emit: (event) => this.emit(reference, event),
      });
    }
    return this.runCoordinator.resume(id, {
      ...value,
      executeTask: (task) => this.sandbox.execute(task.kind, task.input || {}),
    });
  }

  async steerWorkbenchRun(runId, conversationId, value = {}) {
    this.#requireRunCoordinator();
    const id = requiredCopilotId(runId, 'run ID');
    const state = this.getWorkbenchRun(id, conversationId);
    if (isSubagentRunState(state)) {
      this.#requireSubagentRuntime();
      const { reference, conversation } = await this.#conversation(state.run.conversationId);
      const aiSessionId = resolveSubagentSessionId(value, state, this.modelSessions.get(reference.conversationId));
      if (!aiSessionId) throw serviceError('COPILOT_AI_SESSION_REQUIRED', 'A selected model session is required to steer the subagent run.', 409);
      this.#resolveSelectedModel(aiSessionId, conversation.selectedModel);
      this.modelSessions.set(reference.conversationId, aiSessionId);
      const parent = subagentParentIds(state);
      return this.subagentRuntime.steer(id, value, {
        reference,
        conversation,
        contextSourceIds: value.contextSourceIds || firstSubagentInput(state).contextSourceIds || [],
        aiSessionId,
        runId: parent.parentRunId,
        toolRunId: parent.parentToolRunId,
        agentDepth: 0,
        signal: isAbortSignal(value.signal) ? value.signal : undefined,
        emit: (event) => this.emit(reference, event),
      });
    }
    const tasks = (Array.isArray(value.tasks) ? value.tasks : []).map((task) => ({ ...task, kind: String(task.toolName || task.kind || '') }));
    if (!tasks.length) throw serviceError('COPILOT_TASK_GRAPH_EMPTY', 'At least one revised workbench task is required.');
    return this.runCoordinator.steer(id, {
      ...value,
      tasks,
      executeTask: (task) => this.sandbox.execute(task.kind, task.input || {}),
    });
  }

  listProjects(value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      projects: this.projectWorkspaceService.listProjects({
        includeArchived: value.includeArchived === true,
      }),
    };
  }

  getProject(projectId, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      project: this.projectWorkspaceService.getProject(projectId),
    };
  }

  async createProject(value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      project: await this.projectWorkspaceService.createProject(value),
    };
  }

  async updateProject(projectId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      project: await this.projectWorkspaceService.updateProject(projectId, value),
    };
  }

  listProjectWorkspaces(projectId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      project: this.projectWorkspaceService.getProject(projectId),
      workspaces: this.projectWorkspaceService.listWorkspaces(projectId, {
        includeArchived: value.includeArchived === true,
      }),
    };
  }

  async createProjectWorkspace(projectId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    return {
      schemaVersion: 1,
      workspace: await this.projectWorkspaceService.createWorkspace(projectId, value),
    };
  }

  async getProjectWorkspace(projectId, workspaceId, { includeStatus = false } = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      project,
      workspace,
      status: includeStatus ? await this.projectWorkspaceService.worktreeStatus(workspace.id) : undefined,
    };
  }

  async archiveProjectWorkspace(projectId, workspaceId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      workspace: await this.projectWorkspaceService.archiveWorkspace(workspace.id, {
        removeWorktree: value.removeWorktree === true,
        force: value.force === true,
      }),
    };
  }

  async acquireProjectWorkspaceLease(projectId, workspaceId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      workspaceId: workspace.id,
      lease: await this.projectWorkspaceService.acquireLease(workspace.id, { ...objectValue(value), actorId }),
    };
  }

  async releaseProjectWorkspaceLease(projectId, workspaceId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      ...await this.projectWorkspaceService.releaseLease(workspace.id, { ...objectValue(value), actorId }),
    };
  }

  /**
   * Executes a local capability in a project-bound workspace.  The client can
   * choose a tool input only; authority comes exclusively from the HTTP
   * security context derived by the server.
   */
  async executeProjectWorkspaceTool(projectId, workspaceId, toolName, input = {}, securityContext = {}, executionOptions = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    if (!this.workspaceAdapter?.forWorkspace) {
      throw serviceError('COPILOT_WORKSPACE_RUNTIME_UNAVAILABLE', 'The local workspace runtime is unavailable.', 503);
    }
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    const adapter = this.workspaceAdapter.forWorkspace(workspace.rootPath);
    const gitAdapter = this.gitAdapter?.forWorkspace?.(workspace.rootPath) || null;
    const requestedTool = String(toolName || '').trim();
    const registry = createScopedWorkspaceRegistry(adapter, { gitAdapter });
    const descriptor = registry.get(requestedTool);
    if (!descriptor) {
      throw serviceError('COPILOT_WORKSPACE_TOOL_UNKNOWN', `Unknown project workspace tool: ${requestedTool || 'unknown'}.`, 404);
    }
    const runtime = this.capabilityRuntimeFactory({ registry, now: this.now });
    const body = objectValue(input);
    const timeoutMs = body.timeoutMs;
    const toolInput = body;
    const awaitCompletion = executionOptions?.awaitCompletion !== false;
    const operation = projectWorkspaceToolOperation({
      projectId: project.id,
      workspaceId: workspace.id,
      idempotencyKey: executionOptions?.idempotencyKey,
    });
    const runId = operation.runId;
    const authority = workspaceAuthority(securityContext);
    const execution = runtime.createExecution({
      ...this.projectWorkspaceService.executionContext(workspace.id, authority),
      runId,
      toolRunId: operation.toolExecutionId,
      timeoutMs,
      authority,
    });
    const lease = await this.projectWorkspaceService.acquireLease(workspace.id, {
      runId,
      actorId,
      mode: String(descriptor.risk || 'read') === 'read' ? 'read' : 'write',
      ttlMs: Number(timeoutMs) > 0 ? Number(timeoutMs) + 30_000 : undefined,
    });
    const leaseOwner = lease.reused !== true;
    let releaseLeaseOnReturn = leaseOwner;
    let receipt;
    let completion = null;
    try {
      const durableExecution = this.toolExecutionBroker
        ? await this.#executeProjectWorkspaceToolDurably({
          broker: this.toolExecutionBroker,
          registry,
          runtime,
          descriptor,
          toolInput,
          execution,
          authority,
          project,
          workspace,
          timeoutMs,
          idempotencyKey: operation.idempotencyKey,
          awaitCompletion,
        })
        : {
          receipt: await runtime.execute(descriptor.name, toolInput, execution),
          completion: null,
          started: leaseOwner,
          duplicate: false,
        };
      receipt = durableExecution.receipt;
      completion = durableExecution.completion;
      const pendingDuplicate = durableExecution.duplicate === true && isPendingCapabilityReceipt(receipt);
      const ownsLeaseLifecycle = durableExecution.started === true || (leaseOwner && !pendingDuplicate);
      const ownsExecutionLifecycle = durableExecution.started === true
        || (leaseOwner && durableExecution.duplicate !== true);
      releaseLeaseOnReturn = ownsLeaseLifecycle;
      if (!awaitCompletion && ownsExecutionLifecycle && isPendingCapabilityReceipt(receipt) && completion) {
        releaseLeaseOnReturn = false;
        void this.#completeProjectWorkspaceToolExecution({
          completion,
          project,
          workspace,
          descriptor,
          runId,
          lease,
          actorId,
        });
      } else if (ownsExecutionLifecycle) {
        this.#recordProjectWorkspaceToolOutcome({ runId, descriptor, project, workspace, receipt });
      }
    } finally {
      if (releaseLeaseOnReturn) {
        await this.projectWorkspaceService.releaseLease(workspace.id, { leaseId: lease.id, runId, actorId });
      }
    }
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      receipt,
    };
  }

  getProjectWorkspaceToolExecution(projectId, workspaceId, toolExecutionId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    if (!this.toolExecutionBroker?.get) {
      throw serviceError('COPILOT_TOOL_EXECUTION_UNAVAILABLE', 'Durable tool execution receipts are unavailable.', 503);
    }
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    const executionId = String(toolExecutionId || '').trim();
    if (!executionId) {
      throw serviceError('COPILOT_TOOL_EXECUTION_ID_REQUIRED', 'A tool execution ID is required.', 400);
    }
    const durableReceipt = this.toolExecutionBroker.get(executionId);
    if (!durableReceipt) {
      throw serviceError('COPILOT_TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    }
    const environment = objectValue(durableReceipt.context?.environment);
    if (
      environment.kind !== 'project_workspace'
      || String(environment.projectId || '') !== project.id
      || String(environment.workspaceId || '') !== workspace.id
    ) {
      throw serviceError('COPILOT_TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    }
    this.#requireProjectWorkspaceToolExecutionActor(durableReceipt, actorId);
    const authority = workspaceAuthority(securityContext);
    const events = this.toolExecutionBroker.repository?.listEvents
      ? this.toolExecutionBroker.repository.listEvents({
        streamId: `execution:${String(durableReceipt.context?.runId || '')}:tool:${durableReceipt.toolExecutionId}`,
        afterSequence: nonNegativeInteger(value.afterSequence, 0),
        limit: boundedInteger(value.limit, 200, 1, 1_000),
      })
      : [];
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      receipt: projectWorkspaceCapabilityReceipt(durableReceipt, {
        project,
        workspace,
        authority,
        executionLedger: describeToolExecutionLedger({
          repository: this.runtimeV3Repository || this.toolExecutionBroker?.repository,
          durableReceipt,
        }),
      }),
      events,
    };
  }

  async cancelProjectWorkspaceToolExecution(projectId, workspaceId, toolExecutionId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    if (!this.toolExecutionBroker?.get || !this.toolExecutionBroker?.cancel) {
      throw serviceError('COPILOT_TOOL_EXECUTION_UNAVAILABLE', 'Durable tool execution cancellation is unavailable.', 503);
    }
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    const executionId = String(toolExecutionId || '').trim();
    if (!executionId) {
      throw serviceError('COPILOT_TOOL_EXECUTION_ID_REQUIRED', 'A tool execution ID is required.', 400);
    }
    const existing = this.toolExecutionBroker.get(executionId);
    if (!existing) {
      throw serviceError('COPILOT_TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    }
    const environment = objectValue(existing.context?.environment);
    if (
      environment.kind !== 'project_workspace'
      || String(environment.projectId || '') !== project.id
      || String(environment.workspaceId || '') !== workspace.id
    ) {
      throw serviceError('COPILOT_TOOL_EXECUTION_NOT_FOUND', 'The tool execution was not found.', 404);
    }
    this.#requireProjectWorkspaceToolExecutionActor(existing, actorId);
    const cancellation = objectValue(value);
    const durableReceipt = await this.toolExecutionBroker.cancel(executionId, {
      reason: boundedToolCancellationReason(cancellation.reason),
    });
    const authority = workspaceAuthority(securityContext);
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      receipt: projectWorkspaceCapabilityReceipt(durableReceipt, {
        project,
        workspace,
        authority,
        executionLedger: synchronizeToolExecutionLedger({
          repository: this.runtimeV3Repository || this.toolExecutionBroker?.repository,
          durableReceipt,
          descriptor: { name: durableReceipt.toolName, source: 'workspace' },
          project,
          workspace,
          authority,
        }),
      }),
    };
  }

  listExecutions(value = {}, securityContext = {}) {
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    const repository = this.#requireRuntimeV3Repository();
    const query = objectValue(value);
    const limit = boundedInteger(query.limit, 100, 1, 500);
    const records = repository.listExecutions({
      taskId: String(query.taskId || '').trim(),
      runId: String(query.runId || '').trim(),
      actorId,
      status: String(query.status || '').trim(),
      limit: Math.min(limit + 1, 1_000),
      order: 'desc',
    }).filter((record) => executionActorId(record) === actorId);
    return {
      schemaVersion: 1,
      executions: records.slice(0, limit).map(executionProjection),
      hasMore: records.length > limit,
    };
  }

  getExecution(executionId, securityContext = {}) {
    const execution = this.#executionForActor(executionId, securityContext);
    return {
      schemaVersion: 1,
      execution: executionProjection(execution),
    };
  }

  listExecutionSteps(executionId, value = {}, securityContext = {}) {
    const execution = this.#executionForActor(executionId, securityContext);
    const repository = this.#requireRuntimeV3Repository();
    const query = objectValue(value);
    return {
      schemaVersion: 1,
      execution: executionProjection(execution),
      steps: repository.listExecutionSteps({
        executionId: execution.executionId,
        status: String(query.status || '').trim(),
        limit: boundedInteger(query.limit, 200, 1, 1_000),
      }).map(executionStepProjection),
    };
  }

  listExecutionArtifacts(executionId, value = {}, securityContext = {}) {
    const execution = this.#executionForActor(executionId, securityContext);
    const repository = this.#requireRuntimeV3Repository();
    const query = objectValue(value);
    return {
      schemaVersion: 1,
      execution: executionProjection(execution),
      artifacts: repository.listExecutionArtifacts({
        executionId: execution.executionId,
        stepId: String(query.stepId || '').trim(),
        kind: String(query.kind || '').trim(),
        limit: boundedInteger(query.limit, 200, 1, 1_000),
      }).map(executionArtifactProjection),
    };
  }

  listExecutionEvents(executionId, value = {}, securityContext = {}) {
    const execution = this.#executionForActor(executionId, securityContext);
    const repository = this.#requireRuntimeV3Repository();
    const query = objectValue(value);
    const streams = executionEventStreams(execution);
    const requestedScope = String(query.scope || (execution.kind === 'tool' ? 'execution' : 'run')).trim();
    const selected = streams.find((stream) => stream.scope === requestedScope);
    if (!selected) {
      throw serviceError(
        'COPILOT_EXECUTION_EVENT_SCOPE_INVALID',
        `Execution event scope must be one of: ${streams.map((stream) => stream.scope).join(', ')}.`,
        400,
      );
    }
    const afterSequence = nonNegativeInteger(query.afterSequence, 0);
    const limit = boundedInteger(query.limit, 200, 1, 1_000);
    const events = repository.listEvents({
      streamId: selected.streamId,
      afterSequence,
      limit,
    }).map(executionEventProjection);
    const latestSequence = repository.latestSequence(selected.streamId);
    return {
      schemaVersion: 1,
      executionId: execution.executionId,
      scope: selected.scope,
      streamId: selected.streamId,
      availableStreams: streams,
      afterSequence,
      latestSequence,
      hasMore: events.length > 0 && events.at(-1).sequence < latestSequence,
      events,
    };
  }

  async cancelExecution(executionId, value = {}, securityContext = {}) {
    const execution = this.#executionForActor(executionId, securityContext);
    if (execution.kind !== 'tool' || !this.toolExecutionBroker?.cancel) {
      throw serviceError(
        'COPILOT_EXECUTION_CANCEL_UNSUPPORTED',
        `Cancellation is not available for execution kind ${execution.kind || 'unknown'}.`,
        409,
      );
    }
    const cancellation = objectValue(value);
    await this.toolExecutionBroker.cancel(execution.executionId, {
      reason: boundedToolCancellationReason(cancellation.reason),
    });
    const current = this.#executionForActor(execution.executionId, securityContext);
    return {
      schemaVersion: 1,
      execution: executionProjection(current),
    };
  }

  async #executeProjectWorkspaceToolDurably({
    broker,
    registry,
    runtime,
    descriptor,
    toolInput,
    execution,
    authority,
    project,
    workspace,
    timeoutMs,
    idempotencyKey,
    awaitCompletion = true,
  }) {
    const authorization = runtime.authorize(descriptor, execution);
    const toolExecutionId = execution.toolRunId;
    const executionContext = projectWorkspaceToolExecutionContext({
      project,
      workspace,
      execution,
      authority,
      timeoutMs,
      idempotencyKey,
      now: this.now,
    });
    const submission = await broker.submit({
      registry,
      toolName: descriptor.name,
      input: toolInput,
      toolExecutionId,
      idempotencyKey,
      context: {
        runId: execution.runId,
        toolRunId: execution.toolRunId,
        projectId: project.id,
        workspaceId: workspace.id,
        worktreeId: workspace.kind === 'worktree' ? workspace.id : undefined,
        authority,
        approved: authorization.automatic,
        authorizationMode: authorization.mode === 'owner_local_full' ? 'automatic_owner' : 'automatic_local',
        timeoutMs,
      },
      executionContext,
    });
    this.#requireProjectWorkspaceToolExecutionActor(submission.receipt, authority.actorId);
    const toReceipt = (durableReceipt) => projectWorkspaceCapabilityReceipt(durableReceipt, {
      project,
      workspace,
      descriptor,
      authority,
      authorization,
      runId: execution.runId,
      toolRunId: execution.toolRunId,
      executionLedger: synchronizeToolExecutionLedger({
        repository: this.runtimeV3Repository || broker.repository,
        durableReceipt,
        descriptor,
        project,
        workspace,
        authority,
      }),
    });
    const completion = submission.promise ? submission.promise.then(toReceipt) : null;
    return {
      receipt: awaitCompletion && completion ? await completion : toReceipt(submission.receipt),
      completion,
      started: submission.started === true,
      duplicate: submission.duplicate === true,
    };
  }

  async #completeProjectWorkspaceToolExecution({ completion, project, workspace, descriptor, runId, lease, actorId }) {
    try {
      const receipt = await completion;
      this.#recordProjectWorkspaceToolOutcome({ runId, descriptor, project, workspace, receipt });
    } catch (error) {
      this.#recordTrace({
        runId,
        operation: `workspace.tool:${descriptor.name}`,
        status: 'failed',
        durationMs: 0,
        payload: {
          projectId: project.id,
          workspaceId: workspace.id,
          receiptId: String(lease.runId || ''),
          error: String(error?.code || error?.message || 'execution_completion_failed').slice(0, 400),
        },
      });
    } finally {
      await this.projectWorkspaceService.releaseLease(workspace.id, {
        leaseId: lease.id,
        runId,
        actorId,
      }).catch(() => {});
    }
  }

  #recordProjectWorkspaceToolOutcome({ runId, descriptor, project, workspace, receipt }) {
    this.#recordUsage({ runId, toolCalls: 1, latencyMs: receipt.durationMs || 0 });
    this.#recordTrace({
      runId,
      operation: `workspace.tool:${descriptor.name}`,
      status: receipt.status,
      durationMs: receipt.durationMs || 0,
      payload: {
        projectId: project.id,
        workspaceId: workspace.id,
        receiptId: receipt.receiptId,
        authority: receipt.authority?.profile,
      },
    });
  }

  listProjectWorkspaceTerminals(projectId, workspaceId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      sessions: this.terminalSessionManager.list({
        workspaceId: workspace.id,
        includeCompleted: value.includeCompleted !== false,
      }),
    };
  }

  getProjectWorkspaceTerminal(projectId, workspaceId, sessionId, value = {}, securityContext = {}) {
    const { project, workspace, session } = this.#terminalForProject(projectId, workspaceId, sessionId, securityContext);
    const details = this.terminalSessionManager.get(session.sessionId, value);
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      ...details,
    };
  }

  async startProjectWorkspaceTerminal(projectId, workspaceId, value = {}, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    if (!this.workspaceAdapter?.forWorkspace) {
      throw serviceError('COPILOT_WORKSPACE_RUNTIME_UNAVAILABLE', 'The local workspace runtime is unavailable.', 503);
    }
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    const adapter = this.workspaceAdapter.forWorkspace(workspace.rootPath);
    const descriptor = adapter.get('exec.run');
    if (!descriptor) {
      throw serviceError('COPILOT_WORKSPACE_TERMINAL_UNAVAILABLE', 'The local terminal capability is unavailable.', 503);
    }
    const authority = workspaceAuthority(securityContext);
    const capabilityRuntime = this.capabilityRuntimeFactory({
      registry: createScopedWorkspaceRegistry(adapter),
      now: this.now,
    });
    const runId = `terminal-run-${crypto.randomUUID()}`;
    const execution = capabilityRuntime.createExecution({
      ...this.projectWorkspaceService.executionContext(workspace.id, authority),
      runId,
      toolRunId: `terminal-tool-${crypto.randomUUID()}`,
      timeoutMs: objectValue(value).timeoutMs,
      authority,
    });
    const authorization = capabilityRuntime.authorize({ ...descriptor, source: 'workspace' }, execution);
    const input = objectValue(value);
    const lease = await this.projectWorkspaceService.acquireLease(workspace.id, {
      runId,
      actorId,
      mode: 'write',
      ttlMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) + 30_000 : undefined,
    });
    let session;
    try {
      session = await this.terminalSessionManager.start({
        workspaceId: workspace.id,
        projectId: project.id,
        runId,
        toolRunId: execution.toolRunId,
        authority,
        workspaceRoot: workspace.rootPath,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        envRefs: input.envRefs,
        inheritEnv: input.inheritEnv,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        stdin: input.stdin,
        onSettled: async (settled) => {
          this.terminalLeases.delete(settled.sessionId);
          await this.projectWorkspaceService.releaseLease(workspace.id, { leaseId: lease.id, runId, actorId }).catch(() => {});
          this.#recordTrace({
            runId,
            operation: 'workspace.terminal',
            status: settled.status,
            payload: {
              projectId: project.id,
              workspaceId: workspace.id,
              sessionId: settled.sessionId,
              exitCode: settled.exitCode,
              authorization: authorization.mode,
            },
          });
        },
      });
    } catch (error) {
      await this.projectWorkspaceService.releaseLease(workspace.id, { leaseId: lease.id, runId, actorId }).catch(() => {});
      throw error;
    }
    this.terminalLeases.set(session.sessionId, { projectId: project.id, workspaceId: workspace.id, leaseId: lease.id, runId });
    this.#recordUsage({ runId, toolCalls: 1, latencyMs: 0 });
    return {
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      authorization: { mode: authorization.mode, automatic: authorization.automatic },
      session,
    };
  }

  writeProjectWorkspaceTerminal(projectId, workspaceId, sessionId, value = {}, securityContext = {}) {
    const { session } = this.#terminalForProject(projectId, workspaceId, sessionId, securityContext);
    const input = objectValue(value);
    return {
      schemaVersion: 1,
      ...this.terminalSessionManager.write(session.sessionId, input.input),
    };
  }

  async cancelProjectWorkspaceTerminal(projectId, workspaceId, sessionId, value = {}, securityContext = {}) {
    const { session } = this.#terminalForProject(projectId, workspaceId, sessionId, securityContext);
    const input = objectValue(value);
    return {
      schemaVersion: 1,
      ...await this.terminalSessionManager.cancel(session.sessionId, { reason: input.reason || 'cancelled' }),
    };
  }

  getUsage(value = {}) {
    const summary = this.productionStore
      ? this.productionStore.summarizeUsage(value)
      : this.usageTracker.summarize(value);
    return { schemaVersion: 1, ...summary };
  }

  listTraces(value = {}) {
    this.#requireProductionStore();
    return { schemaVersion: 1, traces: this.productionStore.listTraces(value) };
  }

  listSnapshots(value = {}) {
    this.#requireProductionStore();
    return { schemaVersion: 1, snapshots: this.productionStore.listSnapshots(value) };
  }

  getSnapshot(jobId, snapshotId) {
    this.#requireProductionStore();
    const snapshot = this.productionStore.getSnapshot(requiredCopilotId(jobId, 'job ID'), requiredCopilotId(snapshotId, 'snapshot ID'));
    if (!snapshot) throw serviceError('COPILOT_SNAPSHOT_NOT_FOUND', 'The requested snapshot was not found.', 404);
    return snapshot;
  }

  diffSnapshots(value = {}) {
    this.#requireProductionStore();
    return this.productionStore.diffSnapshots({
      jobId: requiredCopilotId(value.jobId, 'job ID'),
      fromSnapshotId: requiredCopilotId(value.fromSnapshotId || value.from, 'from snapshot ID'),
      toSnapshotId: requiredCopilotId(value.toSnapshotId || value.to, 'to snapshot ID'),
    });
  }

  async upgradeConversationSnapshot(conversationId, value = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    const job = this.#getJob(reference.jobId);
    const currentSnapshotId = `job-r${normalizeJobRevision(job.revision)}`;
    await this.#captureSnapshot(job);
    if (currentSnapshotId === reference.snapshotId) {
      return { upgraded: false, reason: 'already_current', conversation: publicConversation(conversation) };
    }
    const diff = this.diffSnapshots({ jobId: reference.jobId, from: reference.snapshotId, to: currentSnapshotId });
    const created = await this.createConversation({
      jobId: reference.jobId,
      mode: reference.mode,
      scope: { ...reference.scope, jobRevision: normalizeJobRevision(job.revision) },
      contextSourceIds: conversation.lastContextSourceIds || reference.scope?.contextSourceIds || [],
      title: conversation.title,
      filters: conversation.filters,
      selectedModel: conversation.selectedModel,
      idempotencyKey: value.idempotencyKey || `snapshot-upgrade:${reference.conversationId}:${currentSnapshotId}`,
    });
    const targetReference = this.references.get(created.conversation.conversationId);
    let inheritedMessages = 0;
    if (value.copyMessages !== false) {
      const messages = await this.repository.listMessages(reference, { afterSequence: 0, limit: 5000 });
      for (const message of messages) {
        await this.repository.appendMessage(targetReference, {
          role: message.role,
          content: message.content,
          attachments: [],
          parentMessageId: null,
          metadata: { ...objectValue(message.metadata), inheritedFromConversationId: reference.conversationId, inheritedSequence: message.sequence },
          idempotencyKey: `snapshot-upgrade-message:${reference.conversationId}:${message.sequence}`,
        });
        inheritedMessages += 1;
      }
    }
    this.#recordTrace({ conversationId: created.conversation.conversationId, operation: 'snapshot.upgrade', status: 'completed', payload: { fromConversationId: reference.conversationId, fromSnapshotId: reference.snapshotId, toSnapshotId: currentSnapshotId, inheritedMessages } });
    return { upgraded: true, sourceConversationId: reference.conversationId, conversation: created.conversation, inheritedMessages, diff };
  }

  async createArtifact(conversationId, value = {}) {
    const { reference } = await this.#conversation(conversationId);
    const startedAt = Date.now();
    const result = await this.artifacts.createArtifact(reference, value);
    const resolved = await this.artifacts.resolveArtifact(reference, result.artifact.artifactId);
    const verification = {
      passed: resolved.artifact.status === 'ready' && resolved.artifact.sha256 === result.artifact.sha256,
      sha256: resolved.artifact.sha256,
      size: resolved.artifact.size,
    };
    const durationMs = Date.now() - startedAt;
    this.#recordUsage({ conversationId: reference.conversationId, toolCalls: 1, latencyMs: durationMs });
    this.#recordTrace({ conversationId: reference.conversationId, operation: `artifact.create:${result.artifact.format}`, status: verification.passed ? 'completed' : 'failed', durationMs, payload: { artifactId: result.artifact.artifactId, sha256: result.artifact.sha256, size: result.artifact.size } });
    this.productionStore?.enqueueOutbox({ topic: 'copilot.artifact.ready', payload: { conversationId: reference.conversationId, artifact: result.artifact } });
    this.emit(reference, { type: 'artifact.ready', artifact: result.artifact, verification });
    return { schemaVersion: 1, ...result, verification };
  }

  async runGoldenEvaluation() {
    const result = await executeGoldenEvaluation({ sandbox: this.sandbox, now: this.now });
    const persisted = this.productionStore?.recordEvaluation(result) || result;
    this.#recordTrace({ operation: 'evaluation.golden-30', status: result.status, durationMs: result.durationMs, payload: result.summary });
    return persisted;
  }

  listEvaluations(value = {}) {
    this.#requireProductionStore();
    return { schemaVersion: 1, evaluations: this.productionStore.listEvaluations(value) };
  }

  listTools({ query = '', limit = 100 } = {}) {
    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    const maximum = boundedInteger(limit, 100, 1, 500);
    const catalogTools = String(query || '').trim() && typeof registry?.search === 'function'
      ? registry.search(query, { limit: maximum })
      : registry?.list?.().slice(0, maximum) || [];
    const analysisTools = this.sandbox.listTools().map((name) => ({
      name,
      category: 'analysis',
      riskLevel: 'read',
      source: 'workbench',
    }));
    const needle = String(query || '').trim().toLocaleLowerCase();
    const matchingAnalysisTools = analysisTools.filter((tool) => !needle || `${tool.name} ${tool.category}`.toLocaleLowerCase().includes(needle));
    const tools = [...catalogTools, ...matchingAnalysisTools]
      .filter((tool, index, items) => items.findIndex((candidate) => candidate.name === tool.name) === index)
      .slice(0, maximum);
    return {
      schemaVersion: 1,
      query: String(query || '').trim(),
      total: tools.length,
      tools,
    };
  }

  listMcpServers() {
    this.#requireMcpClientManager();
    return {
      schemaVersion: 1,
      servers: this.mcpClientManager.listServers(),
      tools: this.mcpClientManager.listTools(),
    };
  }

  async upsertMcpServer(value = {}) {
    this.#requireMcpClientManager();
    const server = await this.mcpClientManager.upsertServer(value, { connect: false });
    return {
      schemaVersion: 1,
      server,
      tools: this.mcpClientManager.listTools().filter((tool) => tool.serverId === server?.id),
    };
  }

  async removeMcpServer(id) {
    this.#requireMcpClientManager();
    const removed = await this.mcpClientManager.removeServer(id);
    if (!removed) throw serviceError('COPILOT_MCP_SERVER_NOT_FOUND', 'MCP server was not found.', 404);
    return { schemaVersion: 1, removed: true, id: String(id || '') };
  }

  async refreshMcpServers(id = null) {
    this.#requireMcpClientManager();
    const servers = await this.mcpClientManager.refresh(id);
    return {
      schemaVersion: 1,
      servers,
      tools: this.mcpClientManager.listTools(),
    };
  }

  getCapabilities() {
    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    const capabilities = this.runtime.describeCapabilities?.() || {
      schemaVersion: 1,
      agentKernel: 'legacy',
      toolCatalog: { total: registry?.list?.().length || 0, categories: [] },
    };
    return {
      ...capabilities,
      schemaVersion: 2,
      protocol: {
        answerAst: { schemaVersion: 1, blockKinds: ['heading', 'paragraph', 'list', 'table', 'code', 'quote', 'callout', 'chart', 'citation', 'artifact', 'checklist', 'diff', 'tool_summary', 'error'] },
        events: { schemaVersion: 1, typed: true, replay: true, gapDetection: true },
      },
      contextManager: { enabled: true, schemaVersion: 2, tokenBudget: true, reservedOutputBudget: true, partitions: true, rankedSources: true, pins: Boolean(this.productionStore), structuredCompaction: true, missingContextContract: true },
      verifier: { enabled: true, schemaVersion: 2, evidenceGraph: true, claimCoverage: true, numericRecalculation: true, strictMode: true },
      modelGateway: {
        enabled: true,
        implementation: this.modelRunBroker ? 'model-run-broker-v1' : 'runtime-stream-adapter',
        wireApis: ['responses', 'chat_completions'],
        streaming: true,
        statefulResponses: Boolean(this.modelRunBroker?.retrieve),
        backgroundLifecycle: Boolean(this.modelRunBroker?.cancel),
        capabilityNegotiation: true,
      },
      localRuntime: {
        workspaceRoot: this.workspaceAdapter?.workspaceRoot || null,
        tools: this.capabilityRegistry?.describeCapabilities?.() || null,
        exec: Boolean(this.workspaceAdapter?.get?.('exec.run')),
        filesystem: Boolean(this.workspaceAdapter?.get?.('workspace.read')),
        http: Boolean(this.workspaceAdapter?.get?.('http.request')),
        automaticToolExecution: capabilities.automaticToolExecution || {
          enabled: false,
          mode: 'required',
          scope: 'approval_required',
          tools: [],
          approvalRequiredByDefault: true,
        },
      },
      executionWorker: this.executionWorkerSupervisor?.describe?.() || {
        schemaVersion: 1,
        kind: 'execution_worker_supervisor',
        state: 'unavailable',
        activeExecutions: 0,
        durableBacklog: 0,
        inlineBacklog: 0,
      },
      executionApi: {
        schemaVersion: 1,
        enabled: Boolean(this.runtimeV3Repository),
        durableEvents: Boolean(this.runtimeV3Repository?.listEvents),
        steps: Boolean(this.runtimeV3Repository?.listExecutionSteps),
        artifacts: Boolean(this.runtimeV3Repository?.listExecutionArtifacts),
        cancellationKinds: this.toolExecutionBroker?.cancel ? ['tool'] : [],
      },
      projectWorkspaces: this.projectWorkspaceService
        ? { enabled: true, ...this.projectWorkspaceService.describe(), worktreeIsolation: true, leases: true, receipts: true }
        : { enabled: false, worktreeIsolation: false, leases: false, receipts: false },
      outboundMcp: this.mcpClientManager?.describe?.() || { initialized: false, servers: [], toolCount: 0 },
      orchestration: {
        enabled: true,
        taskGraph: true,
        parallelReadTasks: true,
        taskTimeouts: true,
        runBudgets: true,
        idempotencyCache: true,
        outputContracts: true,
        persistentRuns: Boolean(this.runCoordinator),
        nodeCheckpoints: Boolean(this.runCoordinator),
        pauseResumeCancel: Boolean(this.runCoordinator),
        planRevisions: Boolean(this.runCoordinator),
        startupRecovery: Boolean(this.runCoordinator),
        startupRecoveredRuns: this.runCoordinator?.recoveredRunIds?.length || 0,
        subagents: this.subagentRuntime?.describe?.() || { enabled: false, toolCount: 0 },
      },
      workbench: {
        modes: ['ask', 'analyze', 'build'],
        tools: this.sandbox.listTools(),
        skills: this.skillRegistry.list(),
        specialists: this.specialistRouter.list(),
      },
      quality: { goldenTasks: 30, persistedEvaluations: Boolean(this.productionStore), traces: Boolean(this.productionStore) },
      snapshots: { manifest: Boolean(this.productionStore), diff: Boolean(this.productionStore), explicitUpgrade: Boolean(this.productionStore) },
      artifacts: { verified: true, formats: ['json', 'csv', 'markdown', 'xlsx'], idempotent: true },
      persistence: {
        repository: 'jsonl-compat',
        durableEventLog: true,
        cursorReplay: true,
        productionState: this.productionStore?.describe() || { engine: 'memory', journalMode: '', schemaVersion: 0 },
      },
    };
  }

  listContextJobs(value = {}) {
    const query = String(value.query || '').trim().slice(0, 500).toLocaleLowerCase();
    const offset = boundedInteger(value.offset, 0, 0, 1_000_000);
    const limit = boundedInteger(value.limit, 25, 1, 100);
    const jobs = (this.manager?.list?.() || [])
      .map(contextJobRecord)
      .filter((job) => !query || [
        job.id, job.title, job.modeLabel, job.status, job.createdAt, job.updatedAt,
      ].join(' ').toLocaleLowerCase().includes(query))
      .sort((left, right) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)));
    return {
      schemaVersion: 1,
      total: jobs.length,
      offset,
      limit,
      items: jobs.slice(offset, offset + limit),
    };
  }

  async listContextRecords(value = {}) {
    const jobId = requiredCopilotId(value.jobId, 'job ID');
    const job = this.#getJob(jobId);
    const mode = normalizeMode(value.mode || 'application');
    const kind = String(value.kind || '').trim().toLowerCase();
    const query = String(value.query || '').trim().slice(0, 500);
    const offset = boundedInteger(value.offset, 0, 0, 1_000_000);
    const limit = boundedInteger(value.limit, 25, 1, 100);

    if (!kind) {
      const counts = {};
      for (const category of ['posts', 'comments', 'users', 'artifacts']) {
        const result = await this.listContextRecords({ jobId, mode, kind: category, offset: 0, limit: 1 });
        counts[category] = result.total;
      }
      return { schemaVersion: 1, jobId, mode, counts };
    }
    if (!['posts', 'comments', 'users', 'artifacts'].includes(kind)) {
      throw serviceError('COPILOT_CONTEXT_KIND_INVALID', 'Context kind must be posts, comments, users, or artifacts.');
    }

    if (kind === 'artifacts') {
      const files = await listTaskArtifactFiles(job.outputDir, {
        excludedRoots: [path.join(this.rootDir, 'copilot')],
      });
      const matched = query
        ? files.filter((item) => `${item.name} ${item.relativePath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        : files;
      return {
        schemaVersion: 1,
        jobId,
        mode,
        kind,
        total: matched.length,
        offset,
        limit,
        items: matched.slice(offset, offset + limit).map((item) => contextArtifactRecord(jobId, item)),
      };
    }

    const registry = this.runtime.registry || this.mcpAdapter?.registry;
    if (!registry?.execute) throw serviceError('COPILOT_CONTEXT_CATALOG_UNAVAILABLE', 'The context catalog is unavailable.', 503);
    const revision = normalizeJobRevision(job.revision);
    const reference = {
      conversationId: `context-${crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`,
      jobId,
      snapshotId: `job-r${revision}`,
      mode,
      scope: { allowedScopes: ['*'], contextSourceIds: [], jobRevision: revision },
    };
    const result = await registry.execute('records.query', {
      dataset: contextDataset(kind, mode),
      query,
      offset,
      limit,
    }, {
      reference,
      conversation: reference,
      state: {},
      contextSourceIds: [],
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return {
      schemaVersion: 1,
      jobId,
      mode,
      kind,
      total: Number(result?.total || 0),
      offset,
      limit,
      items: rows.map((row) => contextDataRecord(jobId, kind, row)),
    };
  }

  async sendMessage(conversationId, value = {}, securityContext = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const text = String(value.content || '').trim();
    if (!text) throw serviceError('COPILOT_MESSAGE_EMPTY', 'Message content is required.');
    const attachmentIds = normalizeIdList(value.attachmentIds, 'attachment ID', MAX_ATTACHMENTS_PER_MESSAGE);
    const contextSourceIds = normalizeContextSourceIds(value.contextSourceIds, reference.jobId);
    const attachments = await Promise.all(attachmentIds.map(async (attachmentId) => {
      const resolved = await this.artifacts.resolveAttachment(reference, attachmentId);
      return resolved.attachment;
    }));
    const persistedSelectedModel = normalizeSelectedModel(conversation.selectedModel);
    const aiSessionId = String(
      value.aiSessionId || persistedSelectedModel.aiSessionId || this.modelSessions.get(reference.conversationId) || '',
    ).trim();
    const workspaceMode = normalizeWorkspaceMode(value.workspaceMode);
    const requestedReasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
    const workspaceBinding = this.#workspaceBindingFromRequest(value, securityContext);
    const selectedModel = this.#resolveSelectedModel(aiSessionId, {
      ...persistedSelectedModel,
      ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
    });
    const reasoningEffort = normalizeReasoningEffort(selectedModel.reasoningEffort);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `message:${crypto.randomUUID()}`,
      'message idempotency key',
    );
    return this.#withConversationLock(reference.conversationId, async () => {
      const requestKey = runtimeRequestKey(idempotencyKey);
      const priorRuns = await this.store.listRuns(reference, { limit: 5000 });
      const existing = priorRuns.find((run) => run.metadata?.requestKey === requestKey);
      if (existing) {
        return {
          runId: existing.runId,
          duplicate: true,
          conversation: publicConversation(await this.store.getConversation(reference)),
        };
      }
      if (Object.keys(selectedModel).length > 0 && canonicalJson(selectedModel) !== canonicalJson(conversation.selectedModel || {})) {
        await this.store.updateConversation(reference, { selectedModel });
      }
      if (canonicalJson(contextSourceIds) !== canonicalJson(conversation.lastContextSourceIds || conversation.scope?.contextSourceIds || [])) {
        await this.store.updateConversation(reference, { lastContextSourceIds: contextSourceIds });
      }
      if (aiSessionId) this.modelSessions.set(reference.conversationId, aiSessionId);
      const result = await this.runtime.start(reference, {
        content: text,
        attachments,
        contextSourceIds,
        aiSessionId,
        workspaceMode,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(workspaceBinding ? { workspaceBinding } : {}),
        idempotencyKey,
      });
      return { ...result, conversation: publicConversation(result.conversation) };
    });
  }

  async cancel(conversationId, value = {}) {
    const { reference } = await this.#conversation(conversationId);
    const result = await this.runtime.cancel(reference, {
      idempotencyKey: normalizeCopilotIdempotencyKey(
        value.idempotencyKey || `cancel:${crypto.randomUUID()}`,
        'cancel idempotency key',
      ),
    });
    return { ...result, conversation: publicConversation(result.conversation) };
  }

  async retry(conversationId, value = {}, securityContext = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const persistedSelectedModel = normalizeSelectedModel(conversation.selectedModel);
    const aiSessionId = String(
      value.aiSessionId || persistedSelectedModel.aiSessionId || this.modelSessions.get(reference.conversationId) || '',
    ).trim();
    const requestedReasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
    const selectedModel = this.#resolveSelectedModel(aiSessionId, {
      ...persistedSelectedModel,
      ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
    });
    const reasoningEffort = normalizeReasoningEffort(selectedModel.reasoningEffort);
    const workspaceBinding = this.#workspaceBindingFromRequest(
      value,
      securityContext,
      conversation.runState?.checkpoint?.workspaceBinding,
    );
    if (Object.keys(selectedModel).length > 0 && canonicalJson(selectedModel) !== canonicalJson(conversation.selectedModel || {})) {
      await this.store.updateConversation(reference, { selectedModel });
    }
    const result = await this.runtime.retry(reference, {
      aiSessionId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(workspaceBinding ? { workspaceBinding } : {}),
      idempotencyKey: normalizeCopilotIdempotencyKey(
        value.idempotencyKey || `retry:${crypto.randomUUID()}`,
        'retry idempotency key',
      ),
    });
    if (aiSessionId) this.modelSessions.set(reference.conversationId, aiSessionId);
    return { ...result, conversation: publicConversation(result.conversation) };
  }

  async uploadAttachment(conversationId, request, options = {}) {
    const { reference } = await this.#conversation(conversationId);
    const result = await this.artifacts.uploadAttachment(reference, request, options);
    this.emit(reference, { type: 'attachment.ready', attachment: result.attachment, duplicate: result.duplicate });
    return result;
  }

  async resolveArtifact(conversationId, artifactId) {
    const { reference } = await this.#conversation(conversationId);
    return this.artifacts.resolveArtifact(reference, artifactId);
  }

  async resolveAttachment(conversationId, attachmentId) {
    const { reference } = await this.#conversation(conversationId);
    return this.artifacts.resolveAttachment(reference, attachmentId);
  }

  async confirmApproval(conversationId, approvalId, value = {}, securityContext = {}) {
    const { reference, conversation } = await this.#conversation(conversationId);
    this.policy.validateSnapshot(reference, conversation);
    const id = requiredCopilotId(approvalId, 'approval ID');
    const current = await this.approvals.getApproval(reference, id, { expireDue: true });
    if (!current) throw serviceError('COPILOT_APPROVAL_NOT_FOUND', 'Approval was not found.', 404);
    const approved = value.approved === true || value.action === 'approve';
    const rejected = value.approved === false || value.action === 'reject';
    if (!approved && !rejected) {
      throw serviceError('COPILOT_APPROVAL_DECISION_REQUIRED', 'Approval decision must be approve or reject.');
    }
    const baseKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `approval:${id}:${approved ? 'approve' : 'reject'}`,
      'approval idempotency key',
    );
    const checkpointWorkspaceBinding = conversation.runState?.checkpoint?.workspaceBinding;
    const workspaceBinding = checkpointWorkspaceBinding
      ? this.#workspaceBindingFromRequest(value, securityContext, checkpointWorkspaceBinding)
      : null;
    if (workspaceBinding && !sameApprovalWorkspaceBinding(current.binding, approvalWorkspaceBinding(workspaceBinding))) {
      throw serviceError(
        'COPILOT_APPROVAL_BINDING_MISMATCH',
        'Approval does not belong to the saved project workspace binding.',
        409,
      );
    }
    const approvalActor = approvalActorFor(securityContext);

    if (!approved) {
      const approval = current.status === 'pending'
        ? await this.approvals.reject(reference, id, {
            idempotencyKey: childKey(baseKey, 'decision'),
            expectedRevision: value.expectedRevision,
            actor: approvalActor,
            reason: String(value.reason || 'user_rejected').slice(0, 1000),
          })
        : current;
      if (approval.status !== 'rejected') {
        throw serviceError('COPILOT_APPROVAL_TRANSITION_INVALID', `Approval is already ${approval.status}.`, 409);
      }
      const run = await this.runtime.cancel(reference, { idempotencyKey: childKey(baseKey, 'cancel') });
      this.emit(reference, { type: 'approval.rejected', approval });
      return { approval, run };
    }

    let approval = current;
    if (approval.status === 'pending') {
      approval = await this.approvals.approve(reference, id, {
        idempotencyKey: childKey(baseKey, 'decision'),
        expectedRevision: value.expectedRevision,
        actor: approvalActor,
        reason: String(value.reason || 'user_approved').slice(0, 1000),
      });
    }
    if (approval.status === 'consumed') return { approval, duplicate: true };
    if (approval.status !== 'approved') {
      throw serviceError('COPILOT_APPROVAL_TRANSITION_INVALID', `Approval is already ${approval.status}.`, 409);
    }
    try {
      const run = await this.runtime.continueApproval(reference, approval, {
        ...(workspaceBinding ? { workspaceBinding } : {}),
        idempotencyKey: childKey(baseKey, 'continue'),
      });
      this.emit(reference, { type: 'approval.confirmed', approval, runId: run.runId });
      return { approval, run, duplicate: false };
    } catch (error) {
      if (error?.code === 'COPILOT_RUN_ACTIVE') return { approval, duplicate: true };
      throw error;
    }
  }

  emit(referenceOrId, event = {}) {
    const conversationId = typeof referenceOrId === 'string'
      ? requiredCopilotId(referenceOrId, 'conversation ID')
      : requiredCopilotId(referenceOrId?.conversationId, 'conversation ID');
    const nextId = Number(this.eventSequences.get(conversationId) || 0) + 1;
    if (!Number.isSafeInteger(nextId)) {
      throw serviceError('COPILOT_EVENT_SEQUENCE_EXHAUSTED', 'The event sequence cannot be advanced.', 500);
    }
    const normalized = {
      ...structuredClone(event),
      eventId: nextId,
      seq: nextId,
      conversationId,
      createdAt: event.createdAt || isoNow(this.now),
    };
    normalized.occurredAt = normalized.occurredAt || normalized.createdAt;
    normalized.type = normalized.type || mapLegacyEventType(normalized.event || normalized.name || 'event');
    normalized.payload = normalized.payload && typeof normalized.payload === 'object'
      ? structuredClone(normalized.payload)
      : eventPayload(normalized);
    normalized.idempotencyKey = normalized.idempotencyKey || `event:${conversationId}:${nextId}`;
    const persisted = jsonEvent(normalized);
    // Every event remains append-only and immediately replayable. Streaming
    // chunks skip fsync because the next terminal event provides the durable
    // barrier, avoiding one full disk sync per generated token.
    appendEventDurably(this.#eventFile(conversationId), persisted, {
      sync: !STREAM_EVENT_TYPES.has(normalized.type),
    });
    this.eventSequences.set(conversationId, nextId);
    const buffer = this.eventBuffers.get(conversationId) || [];
    buffer.push(persisted);
    if (buffer.length > EVENT_BUFFER_LIMIT) buffer.splice(0, buffer.length - EVENT_BUFFER_LIMIT);
    this.eventBuffers.set(conversationId, buffer);
    for (const listener of this.listeners.get(conversationId) || []) {
      try { listener(structuredClone(persisted)); } catch { /* A disconnected listener cannot stop a run. */ }
    }
    return persisted;
  }

  subscribe(conversationId, listener, { afterEventId = 0 } = {}) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    if (typeof listener !== 'function') throw new TypeError('Data Copilot event listener must be a function.');
    const listeners = this.listeners.get(id) || new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const buffer = this.eventBuffers.get(id) || [];
    const lastEventId = Number(this.eventSequences.get(id) || 0);
    const requestedEventId = Number(afterEventId || 0);
    const firstBufferedEventId = Number(buffer[0]?.eventId || lastEventId + 1);
    let effectiveEventId = Number.isSafeInteger(requestedEventId) && requestedEventId >= 0 && requestedEventId <= lastEventId
      ? requestedEventId
      : Math.max(0, firstBufferedEventId - 1);
    let recoveryFrom = 0;
    if (requestedEventId > lastEventId) {
      effectiveEventId = Math.max(0, firstBufferedEventId - 1);
      if (firstBufferedEventId > 1) recoveryFrom = 1;
    } else if (firstBufferedEventId > requestedEventId + 1) {
      recoveryFrom = requestedEventId + 1;
      effectiveEventId = firstBufferedEventId - 1;
    }
    if (recoveryFrom > 0) {
      try {
        listener({
          schemaVersion: 1,
          eventId: effectiveEventId,
          seq: effectiveEventId,
          conversationId: id,
          type: 'stream.gap',
          occurredAt: isoNow(this.now),
          createdAt: isoNow(this.now),
          payload: { from: recoveryFrom, to: effectiveEventId, recovery: 'GET ?format=json&afterSeq=<cursor>' },
          idempotencyKey: `stream-gap:${id}:${requestedEventId}:${effectiveEventId}`,
        });
      } catch { /* Gap notification is isolated per subscriber. */ }
    }
    for (const event of buffer) {
      if (event.eventId > effectiveEventId) {
        try { listener(structuredClone(event)); } catch { /* Replay is isolated per subscriber. */ }
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  async handleMcpRequest(conversationId, request = {}) {
    if (!this.mcpAdapter?.handleRequest) {
      throw serviceError('COPILOT_MCP_UNAVAILABLE', 'The Data Copilot MCP transport is unavailable.', 503);
    }
    const { reference, conversation } = await this.#conversation(conversationId);
    return this.mcpAdapter.handleRequest(reference, conversation, request);
  }

  async #conversation(conversationId) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    await this.#ensureInitialized();
    let reference = this.references.get(id);
    if (!reference) {
      const value = await readCopilotJson(path.join(this.rootDir, 'copilot', id, 'conversation.json'), { allowMissing: true });
      if (!value) throw serviceError('COPILOT_CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404);
      reference = normalizeCopilotReference(value);
      if (reference.conversationId !== id) throw serviceError('COPILOT_CONTEXT_MISMATCH', 'Conversation identity is invalid.', 409);
      this.references.set(id, reference);
    }
    const conversation = await this.store.getConversation(reference);
    if (!conversation) throw serviceError('COPILOT_CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404);
    this.policy.validateReference(reference, conversation);
    return { reference, conversation };
  }

  async #loadPersistedEvents(reference) {
    const filePath = this.#eventFile(reference.conversationId);
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const events = [];
    const seen = new Set();
    let invalidCount = 0;
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (
          !event
          || typeof event !== 'object'
          || Array.isArray(event)
          || event.conversationId !== reference.conversationId
          || !Number.isSafeInteger(event.eventId)
          || event.eventId < 1
          || seen.has(event.eventId)
        ) throw new Error('event identity is invalid');
        seen.add(event.eventId);
        events.push(event);
      } catch (error) {
        invalidCount += 1;
        this.discoveryErrors.push({
          conversationId: reference.conversationId,
          code: 'COPILOT_EVENT_LOG_INVALID',
          message: `Ignored invalid event log record at line ${index + 1}: ${String(error?.message || error).slice(0, 300)}`,
        });
      }
    }
    events.sort((left, right) => left.eventId - right.eventId);
    const latest = events.slice(-EVENT_BUFFER_LIMIT);
    this.eventBuffers.set(reference.conversationId, latest);
    this.eventSequences.set(reference.conversationId, Number(events.at(-1)?.eventId || 0));
    if (invalidCount > 0) {
      await writeCopilotJsonlAtomically(filePath, events);
    }
  }

  #eventFile(conversationId) {
    const id = requiredCopilotId(conversationId, 'conversation ID');
    return path.join(this.rootDir, 'copilot', id, 'events.jsonl');
  }

  async #captureSnapshot(job) {
    if (!this.productionStore) return null;
    const summary = contextJobRecord(job);
    const files = await listTaskArtifactFiles(job.outputDir, {
      excludedRoots: [path.join(this.rootDir, 'copilot')],
    });
    return this.productionStore.upsertSnapshot({
      jobId: summary.id,
      snapshotId: summary.snapshotId,
      revision: summary.revision,
      manifest: {
        task: {
          id: summary.id,
          title: summary.title,
          mode: summary.mode,
          status: summary.status,
          revision: summary.revision,
          progress: summary.progress,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        counts: summary.counts,
        artifacts: files.map((file) => ({
          relativePath: file.relativePath,
          size: file.size,
          updatedAt: file.updatedAt,
          sha256: file.sha256,
        })),
      },
    });
  }

  #recordUsage(value = {}) {
    const record = this.usageTracker.record(value);
    this.productionStore?.recordUsage(record);
    return record;
  }

  #recordTrace(value = {}) {
    return this.productionStore?.recordTrace(value) || null;
  }

  #requireProductionStore() {
    if (!this.productionStore) {
      throw serviceError('COPILOT_PRODUCTION_STORE_UNAVAILABLE', 'The Data Copilot production state store is unavailable.', 503);
    }
  }

  #requireRunCoordinator() {
    if (!this.runCoordinator) {
      throw serviceError('COPILOT_RUN_COORDINATOR_UNAVAILABLE', 'The durable Data Copilot run coordinator is unavailable.', 503);
    }
  }

  #requireSubagentRuntime() {
    if (!this.subagentRuntime) {
      throw serviceError('COPILOT_SUBAGENT_RUNTIME_UNAVAILABLE', 'The Data Copilot subagent runtime is unavailable.', 503);
    }
  }

  #requireMcpClientManager() {
    if (!this.mcpClientManager) {
      throw serviceError('COPILOT_MCP_CLIENT_UNAVAILABLE', 'The outbound MCP client manager is unavailable.', 503);
    }
  }

  /**
   * Converts a public project/workspace selection into the only binding the
   * runtime is allowed to persist.  In particular, this deliberately ignores
   * a client-provided authority object: ownership is established by the app
   * request handler and is refreshed for each message, retry, and approval.
   */
  #workspaceBindingFromRequest(value = {}, securityContext = {}, fallback = null) {
    const body = objectValue(value);
    const requestedProjectId = String(body.projectId || '').trim();
    const requestedWorkspaceId = String(body.workspaceId || '').trim();
    const prior = fallback && typeof fallback === 'object' ? fallback : null;
    const priorProjectId = String(prior?.projectId || '').trim();
    const priorWorkspaceId = String(prior?.workspaceId || '').trim();
    const hasPrior = Boolean(priorProjectId || priorWorkspaceId);
    if (hasPrior && (!priorProjectId || !priorWorkspaceId)) {
      throw serviceError('COPILOT_WORKSPACE_BINDING_INVALID', 'The saved project workspace binding is incomplete.', 409);
    }
    if ((requestedProjectId && !requestedWorkspaceId) || (!requestedProjectId && requestedWorkspaceId)) {
      throw serviceError(
        'COPILOT_WORKSPACE_BINDING_INCOMPLETE',
        'A project-bound conversation requires both projectId and workspaceId.',
      );
    }
    if (hasPrior && requestedProjectId && (
      requestedProjectId !== priorProjectId || requestedWorkspaceId !== priorWorkspaceId
    )) {
      throw serviceError(
        'COPILOT_WORKSPACE_BINDING_IMMUTABLE',
        'A recoverable run must resume in its original project workspace.',
        409,
      );
    }
    const projectId = hasPrior ? priorProjectId : requestedProjectId;
    const workspaceId = hasPrior ? priorWorkspaceId : requestedWorkspaceId;
    if (!projectId && !workspaceId) return null;
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    const priorActorId = String(prior?.authority?.actorId || '').trim();
    if (priorActorId && priorActorId !== actorId) {
      throw serviceError(
        'COPILOT_WORKSPACE_BINDING_ACTOR_MISMATCH',
        'The project workspace binding belongs to a different local owner.',
        403,
      );
    }
    this.#requireProjectWorkspaceService();
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    return {
      schemaVersion: 1,
      projectId: project.id,
      workspaceId: workspace.id,
      ...(workspace.kind === 'worktree' ? { worktreeId: workspace.id } : {}),
      authority: workspaceAuthority(securityContext),
    };
  }

  /**
   * Builds an execution-local registry for a model run.  It never exposes the
   * application-wide workspace adapter: each invocation reopens the adapter
   * at the cataloged workspace root and brackets it with a short-lived lease.
   */
  #resolveRuntimeWorkspaceBinding(binding, runtimeContext = {}) {
    this.#requireProjectWorkspaceService();
    const actorId = this.#requireLocalWorkspaceAccess(binding?.authority || {});
    if (!this.workspaceAdapter?.forWorkspace) {
      throw serviceError('COPILOT_WORKSPACE_RUNTIME_UNAVAILABLE', 'The local workspace runtime is unavailable.', 503);
    }
    const project = this.projectWorkspaceService.getProject(binding.projectId);
    const workspace = this.#workspaceForProject(project, binding.workspaceId);
    if (binding.worktreeId && binding.worktreeId !== workspace.id) {
      throw serviceError('COPILOT_WORKSPACE_BINDING_MISMATCH', 'The requested worktree does not match this workspace.', 409);
    }
    const projectWorkspaceService = this.projectWorkspaceService;
    const adapter = this.workspaceAdapter.forWorkspace(workspace.rootPath);
    const gitAdapter = this.gitAdapter?.forWorkspace?.(workspace.rootPath) || null;
    const registry = createScopedWorkspaceRegistry(adapter, { serial: true, gitAdapter });
    const capabilityRuntime = this.capabilityRuntimeFactory({ registry, now: this.now });
    const authority = workspaceAuthorityFromBinding(binding.authority);
    const createExecution = (tool, context = {}) => capabilityRuntime.createExecution({
      ...projectWorkspaceService.executionContext(workspace.id, authority),
      runId: String(context.runId || runtimeContext.runId || `workspace-run-${crypto.randomUUID()}`),
      toolRunId: String(context.toolRunId || `workspace-tool-${crypto.randomUUID()}`),
      conversationId: String(context.reference?.conversationId || runtimeContext.reference?.conversationId || ''),
      agentDepth: Number(context.agentDepth ?? runtimeContext.agentDepth ?? 0),
      signal: context.signal || runtimeContext.signal,
      timeoutMs: context.timeoutMs ?? context.input?.timeoutMs,
      state: context.state,
      authority,
    });
    const authorize = (tool, context) => capabilityRuntime.authorize(tool, createExecution(tool, context));

    return {
      registry: {
        list: (options) => registry.list(options),
        get: (name) => registry.get(name),
        async execute(name, input = {}, context = {}) {
          const descriptor = registry.get(name);
          if (!descriptor) {
            throw serviceError('COPILOT_WORKSPACE_TOOL_UNKNOWN', `Unknown project workspace tool: ${String(name || '').trim() || 'unknown'}.`, 404);
          }
          const execution = createExecution(descriptor, { ...context, input });
          const lease = await projectWorkspaceService.acquireLease(workspace.id, {
            runId: execution.runId,
            actorId,
            mode: String(descriptor.risk || 'read') === 'read' ? 'read' : 'write',
            ttlMs: Number(execution.timeoutMs) > 0 ? Number(execution.timeoutMs) + 30_000 : undefined,
          });
          try {
            return await capabilityRuntime.execute(descriptor.name, input, execution);
          } finally {
            await projectWorkspaceService.releaseLease(workspace.id, {
              leaseId: lease.id,
              runId: execution.runId,
              actorId,
            }).catch(() => {});
          }
        },
      },
      canAutoExecute: (tool, { execution } = {}) => {
        try {
          return authorize(tool, {
            runId: execution?.runId,
            conversationId: runtimeContext.reference?.conversationId,
            agentDepth: execution?.agentDepth,
            signal: execution?.controller?.signal,
            state: execution?.state,
          }).automatic === true;
        } catch {
          return false;
        }
      },
      authorizationMode: (tool, { execution } = {}) => {
        try {
          const authorization = authorize(tool, {
            runId: execution?.runId,
            conversationId: runtimeContext.reference?.conversationId,
            agentDepth: execution?.agentDepth,
            signal: execution?.controller?.signal,
            state: execution?.state,
          });
          if (!authorization.automatic) return 'explicit_approval';
          return authorization.mode === 'owner_local_full' ? 'automatic_owner' : 'automatic_local';
        } catch {
          return 'explicit_approval';
        }
      },
    };
  }

  #requireProjectWorkspaceService() {
    if (!this.projectWorkspaceService) {
      throw serviceError('COPILOT_PROJECT_WORKSPACE_UNAVAILABLE', 'Project workspaces are unavailable.', 503);
    }
  }

  #requireLocalWorkspaceAccess(securityContext = {}) {
    const actorId = String(securityContext?.actorId || '').trim();
    if (securityContext?.trustedLocal !== true || !actorId) {
      throw serviceError(
        'COPILOT_WORKSPACE_LOCAL_REQUIRED',
        'Project workspaces are available only to a trusted local owner connection.',
        403,
      );
    }
    return actorId;
  }

  #requireRuntimeV3Repository() {
    const repository = this.runtimeV3Repository || this.toolExecutionBroker?.repository;
    if (!repository?.getExecution || !repository?.listExecutions) {
      throw serviceError(
        'COPILOT_EXECUTION_STORE_UNAVAILABLE',
        'The durable execution store is unavailable.',
        503,
      );
    }
    return repository;
  }

  #executionForActor(executionId, securityContext = {}) {
    const actorId = this.#requireLocalWorkspaceAccess(securityContext);
    const repository = this.#requireRuntimeV3Repository();
    const id = String(executionId || '').trim();
    if (!id) {
      throw serviceError('COPILOT_EXECUTION_ID_REQUIRED', 'An execution ID is required.', 400);
    }
    const execution = repository.getExecution(id);
    if (!execution) {
      throw serviceError('COPILOT_EXECUTION_NOT_FOUND', 'The execution was not found.', 404);
    }
    if (executionActorId(execution) !== actorId) {
      throw serviceError(
        'COPILOT_EXECUTION_ACTOR_MISMATCH',
        'The execution belongs to a different local owner.',
        403,
      );
    }
    return execution;
  }

  #requireProjectWorkspaceToolExecutionActor(durableReceipt, actorId) {
    const executionActorId = String(durableReceipt?.context?.authority?.actorId || '').trim();
    if (!executionActorId || executionActorId !== actorId) {
      throw serviceError(
        'COPILOT_WORKSPACE_TOOL_EXECUTION_ACTOR_MISMATCH',
        'The tool execution belongs to a different local owner.',
        403,
      );
    }
  }

  #workspaceForProject(project, workspaceId) {
    const workspace = this.projectWorkspaceService.getWorkspace(workspaceId);
    if (workspace.projectId !== project.id) {
      throw serviceError('COPILOT_WORKSPACE_PROJECT_MISMATCH', 'The workspace does not belong to this project.', 409);
    }
    return workspace;
  }

  #terminalForProject(projectId, workspaceId, sessionId, securityContext = {}) {
    this.#requireProjectWorkspaceService();
    this.#requireLocalWorkspaceAccess(securityContext);
    const project = this.projectWorkspaceService.getProject(projectId);
    const workspace = this.#workspaceForProject(project, workspaceId);
    const details = this.terminalSessionManager.get(sessionId, { limit: 1 });
    const session = details.session;
    if (session.projectId !== project.id || session.workspaceId !== workspace.id) {
      throw serviceError('COPILOT_TERMINAL_WORKSPACE_MISMATCH', 'The terminal session does not belong to this project workspace.', 404);
    }
    return { project, workspace, session };
  }

  #getJob(jobId) {
    const job = this.manager?.getInternal?.(jobId) || this.manager?.get?.(jobId);
    if (!job) throw serviceError('COPILOT_JOB_NOT_FOUND', 'The bound task was not found.', 404);
    return job;
  }

  #resolveSelectedModel(aiSessionId, fallback = {}) {
    const preference = normalizeSelectedModel(fallback);
    const sessionId = String(aiSessionId || preference.aiSessionId || '').trim();
    if (!sessionId) return preference;
    if (!this.aiSessions?.resolve) {
      throw serviceError('COPILOT_AI_SESSION_UNAVAILABLE', 'The selected model session is unavailable.', 503);
    }
    const session = this.aiSessions.resolve(sessionId);
    const resolved = normalizeSelectedModel(session);
    return {
      ...resolved,
      aiSessionId: sessionId,
      ...(resolved.wireApi === 'responses' && preference.reasoningEffort
        ? { reasoningEffort: preference.reasoningEffort }
        : {}),
    };
  }

  async #ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  async #withConversationLock(conversationId, operation) {
    const previous = this.operations.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(conversationId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(conversationId) === current) this.operations.delete(conversationId);
    }
  }
}

function createScopedWorkspaceRegistry(adapter, { serial = false, gitAdapter = null } = {}) {
  const adapters = [
    { source: 'workspace', adapter },
    ...(gitAdapter ? [{ source: 'git', adapter: gitAdapter }] : []),
  ];
  const descriptor = (tool, source) => ({
    ...tool,
    source,
    ...(serial ? { parallelSafe: false } : {}),
  });
  const entryFor = (name) => {
    const toolName = String(name || '').trim();
    for (const entry of adapters) {
      const tool = entry.adapter?.get?.(toolName);
      if (tool) return { ...entry, tool };
    }
    return null;
  };
  return {
    list: (options) => adapters.flatMap((entry) => {
      const tools = entry.adapter?.list?.(options) || [];
      return tools.map((tool) => descriptor(tool, entry.source));
    }),
    get: (name) => {
      const entry = entryFor(name);
      return entry ? descriptor(entry.tool, entry.source) : null;
    },
    execute: (name, input, context) => {
      const entry = entryFor(name);
      if (!entry) {
        throw serviceError('COPILOT_WORKSPACE_TOOL_UNKNOWN', `Unknown project workspace tool: ${String(name || '').trim() || 'unknown'}.`, 404);
      }
      return entry.adapter.execute(name, input, context);
    },
  };
}

function workspaceAuthority(securityContext = {}) {
  const trustedLocal = securityContext?.trustedLocal === true;
  const ownerLocal = trustedLocal && securityContext?.ownerLocal === true;
  return {
    profile: ownerLocal ? 'owner_local_full' : trustedLocal ? 'workspace_auto' : 'observe',
    actorId: String(securityContext?.actorId || '').trim().slice(0, 200),
    trustedLocal,
  };
}

function workspaceAuthorityFromBinding(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const trustedLocal = source.trustedLocal === true;
  const requestedProfile = String(source.profile || 'observe').trim().toLowerCase();
  const profile = trustedLocal && ['workspace_auto', 'owner_local_full'].includes(requestedProfile)
    ? requestedProfile
    : 'observe';
  return {
    profile,
    actorId: String(source.actorId || '').trim().slice(0, 200),
    trustedLocal,
  };
}

function projectWorkspaceToolExecutionContext({ project, workspace, execution, authority, timeoutMs, idempotencyKey, now }) {
  const startedAt = now instanceof Date ? now : new Date(now());
  const timeout = Number(timeoutMs);
  const deadlineAt = new Date(startedAt.getTime() + (
    Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 24 * 60 * 60 * 1000) : 15 * 60 * 1000
  ));
  const toolRunId = String(execution.toolRunId || `workspace-tool-${crypto.randomUUID()}`);
  return {
    schemaVersion: 3,
    taskId: `workspace:${project.id}:${workspace.id}`,
    runId: String(execution.runId),
    attemptId: toolRunId,
    traceId: `trace:${toolRunId}`,
    deadlineAt: deadlineAt.toISOString(),
    idempotencyKey: String(idempotencyKey || `workspace-tool:${project.id}:${workspace.id}:${toolRunId}`),
    environment: {
      kind: 'project_workspace',
      projectId: project.id,
      workspaceId: workspace.id,
      ...(workspace.kind === 'worktree' ? { worktreeId: workspace.id } : {}),
    },
    authority: {
      profile: authority.profile,
      actorId: authority.actorId || '',
      trustedLocal: authority.trustedLocal === true,
    },
    modelPolicy: { origin: 'workbench', execution: 'local' },
    contextSnapshotId: `workspace:${workspace.id}`,
  };
}

function projectWorkspaceToolOperation({ projectId, workspaceId, idempotencyKey }) {
  const normalizedKey = normalizeCopilotIdempotencyKey(
    idempotencyKey || `workspace-tool:${crypto.randomUUID()}`,
    'workspace tool idempotency key',
  );
  const digest = crypto.createHash('sha256')
    .update(`${projectId}:${workspaceId}:${normalizedKey}`)
    .digest('hex')
    .slice(0, 32);
  return {
    idempotencyKey: normalizedKey,
    runId: `workspace-run-${digest}`,
    toolExecutionId: `workspace-tool-${digest}`,
  };
}

function projectWorkspaceCapabilityReceipt(durableReceipt, {
  project,
  workspace,
  descriptor = null,
  authority = {},
  authorization = null,
  runId = '',
  toolRunId = '',
  executionLedger = null,
} = {}) {
  const durable = durableReceipt && typeof durableReceipt === 'object' ? durableReceipt : {};
  const status = durableStatus(durable.status);
  const startedAt = String(durable.createdAt || '');
  const completedAt = String(durable.completedAt || durable.updatedAt || '');
  const durationMs = durationBetween(startedAt, completedAt);
  return {
    type: 'capability.receipt',
    schemaVersion: 1,
    receiptId: String(durable.executionId || durable.toolExecutionId || toolRunId || ''),
    toolExecutionId: String(durable.toolExecutionId || durable.executionId || toolRunId || ''),
    executionId: String(durable.executionId || durable.toolExecutionId || toolRunId || ''),
    runId: String(runId || durable.context?.runId || ''),
    toolRunId: String(toolRunId || durable.toolExecutionId || durable.executionId || ''),
    projectId: project?.id,
    workspaceId: workspace?.id,
    ...(workspace?.kind === 'worktree' ? { worktreeId: workspace.id } : {}),
    tool: String(durable.toolName || descriptor?.name || ''),
    source: String(descriptor?.source || durable.context?.environment?.tool?.source || 'workspace'),
    status,
    startedAt: startedAt || undefined,
    completedAt: completedAt || undefined,
    durationMs,
    authority: {
      profile: String(authorization?.mode || authority.profile || 'observe'),
      automatic: authorization?.automatic === true,
    },
    effectClass: String(durable.effectClass || ''),
    ...(durable.result !== undefined ? { result: structuredClone(durable.result) } : {}),
    ...(durable.error && Object.keys(durable.error).length > 0 ? { error: structuredClone(durable.error) } : {}),
    durable: {
      status: String(durable.status || ''),
      createdAt: startedAt || undefined,
      updatedAt: String(durable.updatedAt || '') || undefined,
      completedAt: String(durable.completedAt || '') || undefined,
    },
    ...(executionLedger ? { executionLedger } : {}),
  };
}

function durableStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'succeeded') return 'completed';
  if (['queued', 'running', 'failed', 'cancelled', 'reconcile_required'].includes(status)) return status;
  return 'failed';
}

function durationBetween(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

function isPendingCapabilityReceipt(receipt = {}) {
  const status = String(receipt?.status || '').trim().toLowerCase();
  return status === 'queued' || status === 'running';
}

function boundedToolCancellationReason(value) {
  const reason = String(value || 'user_cancelled').trim();
  return (reason || 'user_cancelled').slice(0, 400);
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function approvalWorkspaceBinding(value = {}) {
  const binding = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectId = String(binding.projectId || '').trim();
  const workspaceId = String(binding.workspaceId || '').trim();
  if (!projectId || !workspaceId) return null;
  return {
    schemaVersion: 1,
    projectId,
    workspaceId,
    ...(String(binding.worktreeId || '').trim() ? { worktreeId: String(binding.worktreeId).trim() } : {}),
    actorId: String(binding.authority?.actorId || '').trim(),
  };
}

function sameApprovalWorkspaceBinding(left, right) {
  if (!left && !right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return String(left.projectId || '') === String(right.projectId || '')
    && String(left.workspaceId || '') === String(right.workspaceId || '')
    && String(left.worktreeId || '') === String(right.worktreeId || '')
    && String(left.actorId || '') === String(right.actorId || '');
}

function approvalActorFor(securityContext = {}) {
  return String(securityContext?.actorId || '').trim().slice(0, 200) || 'user';
}

function isSubagentRunState(state) {
  return state?.turn?.contract?.type === 'subagent.run'
    || (Array.isArray(state?.nodes) && state.nodes.some((node) => String(node.kind || '').startsWith('subagent.')));
}

function firstSubagentInput(state) {
  return state?.nodes?.[0]?.input || {};
}

function subagentParentIds(state) {
  const contract = state?.turn?.contract || {};
  const input = firstSubagentInput(state);
  return {
    parentRunId: String(contract.parentRunId || input.parentRunId || state?.run?.runId || ''),
    parentToolRunId: String(contract.parentToolRunId || input.parentToolRunId || `subagent:${state?.run?.runId || 'run'}`),
  };
}

function resolveSubagentSessionId(value, state, currentSessionId) {
  return String(value?.aiSessionId || currentSessionId || firstSubagentInput(state).aiSessionId || '').trim();
}

function isAbortSignal(value) {
  return Boolean(value && typeof value === 'object' && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean');
}

function publicConversation(value) {
  if (!value) return null;
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    conversationId: value.conversationId,
    jobId: value.jobId,
    snapshotId: value.snapshotId,
    mode: value.mode,
    scope: {
      ...structuredClone(value.scope || {}),
      contextSourceIds: structuredClone(value.lastContextSourceIds || value.scope?.contextSourceIds || []),
    },
    title: String(value.title || ''),
    filters: structuredClone(value.filters || {}),
    selectedModel: normalizeSelectedModel(value.selectedModel),
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastMessageAt: value.lastMessageAt,
    lastToolRunAt: value.lastToolRunAt,
    lastSequences: structuredClone(value.lastSequences || {}),
    runState: structuredClone(value.runState || {}),
  };
}

function normalizeScopeInput(scope, contextSourceIds, job) {
  const value = objectValue(scope);
  const sources = normalizeContextSourceIds(
    contextSourceIds === undefined ? value.contextSourceIds : contextSourceIds,
    job.id,
  );
  return {
    ...value,
    allowedScopes: Array.isArray(value.allowedScopes) && value.allowedScopes.length
      ? [...new Set(value.allowedScopes.map(String))].slice(0, 50)
      : [...DEFAULT_ALLOWED_SCOPES],
    contextSourceIds: sources,
    jobRevision: normalizeJobRevision(job.revision),
  };
}

function normalizeContextSourceIds(value, jobId = null) {
  return normalizeBoundContextSourceIds(value, { jobId, maximum: 100 });
}

function contextJobRecord(job) {
  const value = objectValue(job);
  const mode = value.config?.analysisMode === 'general' ? 'research' : 'application';
  const audience = objectValue(value.workflowSummary?.audience);
  const revision = normalizeJobRevision(value.revision);
  return {
    id: String(value.id || ''),
    title: String(value.keyword || value.config?.keyword || value.id || '未命名任务'),
    mode,
    modeLabel: mode === 'application' ? '岗位任务' : '非岗位任务',
    status: String(value.status || 'unknown'),
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || value.createdAt || ''),
    snapshotId: `job-r${revision}`,
    revision,
    progress: Math.max(0, Math.min(100, Number(value.progress || 0))),
    counts: {
      posts: Math.max(0, Number(mode === 'application'
        ? value.applicationCount || value.scrapedCount || value.discoveredCount || 0
        : value.discoveredCount || value.scrapedCount || 0)),
      comments: Math.max(0, Number(audience.commentsCollected || 0)),
      users: Math.max(0, Number(audience.usersDiscovered || 0)),
      artifacts: Math.max(0, Number(value.artifactCount || 0)),
    },
  };
}

function contextDataset(kind, mode) {
  if (kind === 'posts') return mode === 'application' ? 'applications' : 'content';
  if (kind === 'comments') return 'comments';
  if (kind === 'users') return 'users';
  throw serviceError('COPILOT_CONTEXT_KIND_INVALID', `Unsupported context kind: ${kind}.`);
}

function contextDataRecord(jobId, kind, row) {
  const value = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  if (kind === 'posts') return contextPostRecord(jobId, value);
  if (kind === 'comments') return contextCommentRecord(jobId, value);
  return contextUserRecord(jobId, value);
}

function contextPostRecord(jobId, row) {
  const recordId = stableRecordId('post', row, row.note_id, row.noteId, row.post_id, row.postId, row.id);
  const title = firstText(row.title, row.note_title, row.job_card?.position_title, '未命名原帖');
  const body = firstText(row.body, row.content, row.note_text, row.desc);
  const images = contextImages(row);
  const sourceId = createCopilotContextSourceId(jobId, 'posts', recordId);
  const analysis = row.content_analysis || row.analysis || null;
  return {
    sourceId,
    recordId,
    kind: 'post',
    title: title.slice(0, 240),
    subtitle: (body || firstText(row.author, row.nickname, row.access_status)).slice(0, 240),
    status: firstText(row.access_status, row.bodyStatus, row.status),
    timestamp: displayTime(row.publish_time, row.publishTime, row.created_at),
    imageUrl: images[0] || '',
    url: firstText(row.note_url, row.noteUrl, row.source_url, row.url),
    fields: compactFields([
      ['记录 ID', recordId],
      ['作者', firstText(row.author, row.nickname, row.user?.display_name)],
      ['发布时间', displayTime(row.publish_time, row.publishTime)],
      ['访问状态', firstText(row.access_status, row.bodyStatus, row.status)],
      ['评论数', numberText(row.comment_count, row.comments)],
    ]),
    body: body.slice(0, 12_000),
    images: images.slice(0, 12),
    analysis,
    sections: [
      contextSection(sourceId, '整条记录', '标题、正文、时间与来源链接'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'body'), '正文', body ? '完整正文内容' : '当前记录没有正文'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'images'), '图片', `${images.length} 张图片及已有识别结果`),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'analysis'), 'AI 分析', analysis ? '现有内容分析与岗位字段' : '当前记录没有 AI 分析'),
      contextSection(createCopilotContextSourceId(jobId, 'posts', recordId, 'audience'), '相关评论与用户', '限定到这条原帖的受众数据'),
    ],
  };
}

function contextCommentRecord(jobId, row) {
  const recordId = stableRecordId('comment', row, row.comment_id, row.commentId, row.id);
  const user = row.user && typeof row.user === 'object' ? row.user : {};
  const userId = firstText(user.user_id, user.userId, row.user_id, row.userId);
  const text = firstText(row.text, row.content, row.comment_text);
  const sourceId = createCopilotContextSourceId(jobId, 'comments', recordId);
  const sections = [
    contextSection(sourceId, '整条评论', '评论文本、时间、点赞与层级'),
    contextSection(createCopilotContextSourceId(jobId, 'comments', recordId, 'thread'), '评论线程', '父评论与回复关系'),
  ];
  if (userId) {
    sections.push(contextSection(
      createCopilotContextSourceId(jobId, 'users', userId, 'profile'),
      '评论用户',
      firstText(user.display_name, user.nickname, '关联用户资料'),
    ));
  }
  return {
    sourceId,
    recordId,
    kind: 'comment',
    title: firstText(user.display_name, user.nickname, '匿名用户').slice(0, 240),
    subtitle: text.slice(0, 320),
    status: firstText(row.status, row.replyStatus),
    timestamp: displayTime(row.publish_time, row.publishTime, row.created_at),
    imageUrl: firstText(user.avatar_url, user.avatarUrl),
    url: firstText(row.url, row.comment_url),
    fields: compactFields([
      ['评论 ID', recordId],
      ['原帖 ID', firstText(row.post_id, row.postId)],
      ['层级', firstText(row.level, row.parent_comment_id ? '回复' : '主评论')],
      ['点赞', numberText(row.likes, row.like_count)],
      ['发布时间', displayTime(row.publish_time, row.publishTime)],
    ]),
    body: text.slice(0, 12_000),
    images: [],
    analysis: row.analysis || null,
    sections,
  };
}

function contextUserRecord(jobId, row) {
  const recordId = stableRecordId('user', row, row.user_id, row.userId, row.id);
  const sourceId = createCopilotContextSourceId(jobId, 'users', recordId);
  const bio = firstText(row.bio, row.description, row.signature);
  const roles = Array.isArray(row.roles) ? row.roles.map(String).join('、') : firstText(row.roles);
  const postIds = Array.isArray(row.post_ids) ? row.post_ids : Array.isArray(row.postIds) ? row.postIds : [];
  return {
    sourceId,
    recordId,
    kind: 'user',
    title: firstText(row.display_name, row.nickname, row.name, '未命名用户').slice(0, 240),
    subtitle: (bio || roles || `${Number(row.comment_count || 0)} 条评论`).slice(0, 240),
    status: firstText(row.profileStatus, row.enrichment_status, row.status),
    timestamp: firstText(row.lastAttemptAt, row.updatedAt),
    imageUrl: firstText(row.avatar_url, row.avatarUrl),
    url: firstText(row.profile_url, row.profileUrl, row.url),
    fields: compactFields([
      ['用户 ID', recordId],
      ['角色', roles],
      ['评论数', numberText(row.comment_count, row.commentCount)],
      ['关联原帖', postIds.length ? String(postIds.length) : ''],
      ['主页状态', firstText(row.profileStatus, row.enrichment_status, row.status)],
    ]),
    body: bio.slice(0, 12_000),
    images: [],
    analysis: row.analysis || row.profile_analysis || null,
    sections: [
      contextSection(sourceId, '整条用户记录', '身份、角色与关联统计'),
      contextSection(createCopilotContextSourceId(jobId, 'users', recordId, 'profile'), '公开主页', bio ? '简介与公开主页字段' : '当前记录没有主页简介'),
      contextSection(createCopilotContextSourceId(jobId, 'users', recordId, 'activity'), '评论与原帖关联', `${Number(row.comment_count || 0)} 条评论，${postIds.length} 条关联原帖`),
    ],
  };
}

function contextArtifactRecord(jobId, item) {
  const sourceId = createCopilotContextSourceId(jobId, 'artifacts', item.relativePath);
  return {
    sourceId,
    recordId: item.relativePath,
    kind: 'artifact',
    title: item.name,
    subtitle: item.relativePath,
    status: '可用',
    timestamp: item.updatedAt,
    imageUrl: '',
    url: '',
    fields: compactFields([
      ['相对路径', item.relativePath],
      ['文件大小', formatBytes(item.size)],
      ['更新时间', item.updatedAt],
    ]),
    body: '',
    images: [],
    analysis: null,
    sections: [contextSection(sourceId, '完整产物', '作为本轮对话的数据来源或邮件附件')],
  };
}

async function listTaskArtifactFiles(outputDir, { excludedRoots = [] } = {}) {
  const root = path.resolve(String(outputDir || ''));
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const exclusions = await Promise.all(excludedRoots.map(async (value) => {
    const resolved = path.resolve(String(value));
    return realpath(resolved).catch((error) => {
      if (error?.code === 'ENOENT') return resolved;
      throw error;
    });
  }));
  const pending = [''];
  const files = [];
  while (pending.length && files.length < 5000) {
    const relativeDirectory = pending.shift();
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['run.log', 'workflow-state.json'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.resolve(root, relativePath);
      if (!pathIsWithin(canonicalRoot, absolutePath)) continue;
      let canonicalPath;
      try {
        canonicalPath = await realpath(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!pathIsWithin(canonicalRoot, canonicalPath)) continue;
      if (exclusions.some((excludedRoot) => pathIsWithin(excludedRoot, canonicalPath))) continue;
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const snapshot = await hashStableFile(canonicalPath);
      const canonicalPathAfterHash = await realpath(absolutePath).catch(() => '');
      if (canonicalPathAfterHash !== canonicalPath) {
        throw serviceError(
          'COPILOT_ARTIFACT_CHANGED',
          `Artifact path changed while capturing snapshot: ${relativePath}`,
          409,
        );
      }
      files.push({
        name: entry.name,
        relativePath: relativePath.split(path.sep).join('/'),
        size: snapshot.metadata.size,
        updatedAt: snapshot.metadata.mtime.toISOString(),
        sha256: snapshot.sha256,
      });
    }
  }
  return files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function hashStableFile(filePath, { beforeRead } = {}) {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw serviceError('COPILOT_ARTIFACT_INVALID', 'Snapshot artifacts must be regular files.', 409);
    }
    await beforeRead?.({ filePath, handle, metadata: before });
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = handle.createReadStream({ autoClose: false });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('end', resolve);
      stream.once('error', reject);
    });
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw serviceError('COPILOT_ARTIFACT_CHANGED', 'Artifact changed while capturing snapshot.', 409);
    }
    return { metadata: after, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function contextSection(sourceId, label, description) {
  return { sourceId, label, description };
}

function compactFields(entries) {
  return entries
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => ({ label, value: String(value).slice(0, 1000) }));
}

function contextImages(row) {
  const media = row.media && typeof row.media === 'object' && !Array.isArray(row.media) ? row.media : {};
  const noteCard = row.note_card && typeof row.note_card === 'object'
    ? row.note_card
    : row.noteCard && typeof row.noteCard === 'object'
      ? row.noteCard
      : {};
  const images = [];
  const seenObjects = new WeakSet();

  const append = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      value.forEach((item) => append(item, depth + 1));
      return;
    }
    if (typeof value === 'string') {
      const candidate = value.trim();
      if (!candidate) return;
      const normalized = candidate.startsWith('//') ? `https:${candidate}` : candidate;
      if (/^(?:https?:\/\/|data:image\/|blob:|\/api\/)/iu.test(normalized)) images.push(normalized);
      return;
    }
    if (typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    [
      'url', 'src', 'original_url', 'originalUrl', 'url_original', 'urlOriginal',
      'large_url', 'largeUrl', 'master_url', 'masterUrl', 'url_default', 'urlDefault',
      'image_url', 'imageUrl', 'cover_url', 'coverUrl',
    ].forEach((key) => append(value[key], depth + 1));
    [
      'urls', 'url_list', 'urlList', 'info_list', 'infoList', 'images',
      'image_list', 'imageList', 'image_urls', 'imageUrls',
    ].forEach((key) => append(value[key], depth + 1));
  };

  [
    media.images, media.image_list, media.imageList, media.image_urls, media.imageUrls,
    row.images, row.image_list, row.imageList, row.image_urls, row.imageUrls,
    noteCard.images, noteCard.image_list, noteCard.imageList,
    media.cover, media.cover_url, media.coverUrl,
    row.cover, row.cover_url, row.coverUrl, row.card_cover_url, row.cardCoverUrl,
    row.image_url, row.imageUrl, noteCard.cover, noteCard.cover_url, noteCard.coverUrl,
  ].forEach((value) => append(value));

  return [...new Set(images)];
}

function firstText(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function displayTime(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const structured = firstText(value.value, value.iso, value.datetime, value.raw);
      if (structured) return structured;
      continue;
    }
    const text = firstText(value);
    if (text) return text;
  }
  return '';
}

function stableRecordId(prefix, row, ...values) {
  const supplied = firstText(...values);
  if (supplied) return supplied;
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(row)).digest('hex').slice(0, 20)}`;
}

function numberText(...values) {
  const value = values.find((item) => Number.isFinite(Number(item)));
  return value === undefined ? '' : String(Number(value));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function normalizeSelectedModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const field of ['aiSessionId', 'provider', 'model', 'wireApi']) {
    const text = String(value[field] || '').trim();
    if (text) result[field] = text.slice(0, 500);
  }
  const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
  if (reasoningEffort) result.reasoningEffort = reasoningEffort;
  return result;
}

function normalizeTitle(value, job) {
  const supplied = String(value || '').trim();
  if (supplied) return supplied.slice(0, 240);
  const keyword = String(job.keyword || job.params?.keyword || '').trim();
  return keyword ? `Data Copilot: ${keyword}`.slice(0, 240) : 'Data Copilot';
}

function normalizeMode(value) {
  const mode = String(value || '').trim();
  if (!['application', 'research'].includes(mode)) {
    throw serviceError('COPILOT_MODE_INVALID', 'Conversation mode must be application or research.');
  }
  return mode;
}

function normalizeIdList(value, label, maximum) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw serviceError('COPILOT_ATTACHMENTS_INVALID', 'attachmentIds must be an array.');
  if (value.length > maximum) throw serviceError('COPILOT_ATTACHMENTS_EXCEEDED', `At most ${maximum} attachments are allowed.`, 413);
  return [...new Set(value.map((item) => requiredCopilotId(item, label)))];
}

function executionActorId(execution) {
  return String(execution?.context?.authority?.actorId || '').trim();
}

function executionProjection(execution) {
  const context = objectValue(execution?.context);
  const metadata = objectValue(execution?.metadata);
  const dispatcher = objectValue(metadata.dispatcher);
  const environment = objectValue(context.environment);
  const error = objectValue(execution?.error);
  return {
    schemaVersion: 1,
    executionId: String(execution?.executionId || ''),
    kind: String(execution?.kind || ''),
    status: String(execution?.status || ''),
    phase: String(metadata.phase || dispatcher.phase || ''),
    taskId: String(context.taskId || ''),
    runId: String(context.runId || ''),
    attemptId: String(context.attemptId || ''),
    traceId: String(context.traceId || ''),
    parentExecutionId: String(context.parentExecutionId || ''),
    contextSnapshotId: String(context.contextSnapshotId || ''),
    deadlineAt: String(context.deadlineAt || ''),
    environment: executionEnvironmentProjection(environment),
    authority: {
      profile: String(context.authority?.profile || context.authority?.mode || ''),
      automatic: context.authority?.automatic === true,
    },
    tool: execution.kind === 'tool' ? {
      name: String(metadata.toolName || ''),
      source: String(metadata.source || ''),
      effectClass: String(metadata.effectClass || dispatcher.effectClass || ''),
    } : undefined,
    handler: String(dispatcher.handlerKey || metadata.handlerKey || ''),
    cancellation: dispatcher.cancelRequestedAt ? {
      requestedAt: String(dispatcher.cancelRequestedAt),
      reason: redactExecutionText(dispatcher.cancelReason || 'cancelled', 2_000),
    } : null,
    hasResult: execution?.result !== null && execution?.result !== undefined,
    error: Object.keys(error).length > 0 ? {
      code: String(error.code || 'COPILOT_EXECUTION_FAILED'),
      message: redactExecutionText(error.message || 'Execution failed.', 4_000),
      status: Number(error.status || 0) || undefined,
      retryable: error.retryable === true,
    } : null,
    eventStreams: executionEventStreams(execution),
    createdAt: String(execution?.createdAt || ''),
    updatedAt: String(execution?.updatedAt || ''),
    completedAt: String(execution?.completedAt || ''),
  };
}

function executionEnvironmentProjection(environment = {}) {
  return Object.fromEntries([
    ['kind', environment.kind],
    ['projectId', environment.projectId],
    ['workspaceId', environment.workspaceId],
    ['worktreeId', environment.worktreeId],
    ['conversationId', environment.conversationId],
    ['jobId', environment.jobId],
    ['snapshotId', environment.snapshotId],
  ].filter(([, value]) => String(value || '').trim()).map(([key, value]) => [key, String(value)]));
}

function executionEventStreams(execution) {
  const runId = String(execution?.context?.runId || '').trim();
  const executionId = String(execution?.executionId || '').trim();
  const streams = runId ? [{ scope: 'run', streamId: `run:${runId}` }] : [];
  if (execution?.kind === 'tool' && runId && executionId) {
    streams.unshift({ scope: 'execution', streamId: `execution:${runId}:tool:${executionId}` });
  }
  return streams;
}

function executionStepProjection(step) {
  return {
    schemaVersion: 1,
    stepId: String(step?.stepId || ''),
    executionId: String(step?.executionId || ''),
    parentStepId: String(step?.parentStepId || ''),
    ordinal: Number(step?.ordinal || 0),
    kind: String(step?.kind || ''),
    status: String(step?.status || ''),
    handler: String(step?.handlerKey || ''),
    effectClass: String(step?.effectClass || ''),
    descriptorVersion: String(step?.descriptorVersion || ''),
    inputHash: String(step?.inputHash || ''),
    resultRef: String(step?.resultRef || ''),
    metadata: redactExecutionValue(step?.metadata),
    error: redactExecutionValue(step?.error),
    attempt: Number(step?.attempt || 0),
    maxAttempts: Number(step?.maxAttempts || 1),
    createdAt: String(step?.createdAt || ''),
    updatedAt: String(step?.updatedAt || ''),
    startedAt: String(step?.startedAt || ''),
    completedAt: String(step?.completedAt || ''),
  };
}

function executionArtifactProjection(artifact) {
  return {
    schemaVersion: 1,
    artifactId: String(artifact?.artifactId || ''),
    executionId: String(artifact?.executionId || ''),
    stepId: String(artifact?.stepId || ''),
    kind: String(artifact?.kind || ''),
    mimeType: String(artifact?.mimeType || 'application/octet-stream'),
    contentHash: String(artifact?.contentHash || ''),
    sizeBytes: Number(artifact?.sizeBytes || 0),
    metadata: redactExecutionValue(artifact?.metadata),
    createdAt: String(artifact?.createdAt || ''),
  };
}

function executionEventProjection(event) {
  return {
    schemaVersion: Number(event?.schemaVersion || 1),
    eventId: String(event?.eventId || ''),
    streamId: String(event?.streamId || ''),
    sequence: Number(event?.sequence || 0),
    type: String(event?.type || ''),
    occurredAt: String(event?.occurredAt || ''),
    taskId: String(event?.taskId || ''),
    runId: String(event?.runId || ''),
    agentId: String(event?.agentId || ''),
    attemptId: String(event?.attemptId || ''),
    payload: redactExecutionValue(event?.payload),
  };
}

function redactExecutionValue(value, maximum = 12_000, seen = new WeakSet()) {
  if (value === undefined || value === null) return value ?? null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactExecutionText(value, maximum);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactExecutionValue(item, maximum, seen));
  if (typeof value !== 'object') return redactExecutionText(String(value), maximum);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [
    key,
    executionSecretKey(key) ? '[redacted]' : redactExecutionValue(item, maximum, seen),
  ]));
}

function executionSecretKey(key) {
  return /(?:api[_-]?key|authorization|password|secret|token|cookie|credential)/iu.test(String(key));
}

function redactExecutionText(value, maximum = 12_000) {
  return String(value || '')
    .replace(
      /\b((?:api[_-]?key|authorization|password|secret|token|cookie|credential)\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/giu,
      '$1[redacted]',
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/giu, 'Basic [redacted]')
    .replace(/(https?:\/\/[^:\s/?#]+:)[^@\s/]+@/giu, '$1[redacted]@')
    .slice(0, maximum);
}

function objectValue(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('COPILOT_VALUE_INVALID', 'Expected an object.');
  }
  return structuredClone(value);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeJobRevision(value) {
  const revision = Number(value ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw serviceError('COPILOT_JOB_REVISION_INVALID', 'The task revision is invalid.', 409);
  }
  return revision;
}

function jsonEvent(value) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) throw new Error('event is empty');
    return JSON.parse(serialized);
  } catch (error) {
    throw serviceError('COPILOT_EVENT_INVALID', 'Data Copilot event data must be JSON serializable.', 500, error);
  }
}

function appendEventDurably(filePath, event, { sync = true } = {}) {
  const buffer = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  let descriptor;
  try {
    descriptor = openSync(filePath, 'a', 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (written <= 0) throw new Error('Event log write did not advance.');
      offset += written;
    }
    if (sync) fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function restartKey(conversationId, runId) {
  return `restart:${crypto.createHash('sha256').update(`${conversationId}:${runId}`).digest('hex').slice(0, 32)}`;
}

function childKey(parent, operation) {
  const candidate = `${parent}:${operation}`;
  if (candidate.length <= 160) return candidate;
  return `${String(parent).slice(0, 120)}:${crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 32)}`;
}

function runtimeRequestKey(value) {
  const text = String(value || '').trim().replace(/[^\p{L}\p{N}_.:-]/gu, '_');
  if (text.length <= 64) return text;
  return `${text.slice(0, 40)}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readEventLog(filePath) {
  let content = '';
  try { content = await readFile(filePath, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return content.split(/\r?\n/u).filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    const seq = Number(event.seq || event.eventId || 0);
    return {
      ...event,
      eventId: Number(event.eventId || seq),
      seq,
      occurredAt: event.occurredAt || event.createdAt,
      type: event.type || mapLegacyEventType(event.event || 'event'),
      payload: event.payload || eventPayload(event),
      idempotencyKey: event.idempotencyKey || `event:${event.conversationId || 'conversation'}:${seq}`,
    };
  }).filter((event) => event.seq > 0);
}

function eventPayload(event) {
  const payload = { ...event };
  for (const field of ['eventId', 'seq', 'conversationId', 'createdAt', 'occurredAt', 'type', 'payload', 'idempotencyKey']) delete payload[field];
  return payload;
}

function mapLegacyEventType(value) {
  const type = String(value || 'event');
  if (type === 'conversation.created') return 'run.created';
  if (type === 'assistant.delta' || type === 'message.delta') return 'message.delta';
  if (type === 'assistant.completed' || type === 'message.completed') return 'message.completed';
  if (type.startsWith('tool.')) return type;
  if (type.startsWith('approval.')) return type === 'approval.confirmed' ? 'approval.resolved' : 'approval.required';
  if (type.includes('verification')) return type.startsWith('verification.') ? type : 'verification.completed';
  if (type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled') return type;
  if (type === 'run.started' || type === 'plan.created' || type === 'plan.updated') return type;
  return type.replace(/[^A-Za-z0-9_.-]/gu, '_');
}

function normalizeWorkspaceMode(value) {
  const mode = String(value || 'ask').trim().toLowerCase();
  if (!['ask', 'analyze', 'build'].includes(mode)) throw serviceError('COPILOT_WORKSPACE_MODE_INVALID', 'Workspace mode must be ask, analyze, or build.');
  return mode;
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return '';
  const effort = String(value).trim().toLowerCase();
  if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort;
  throw serviceError(
    'COPILOT_REASONING_EFFORT_INVALID',
    'Reasoning effort must be none, low, medium, high, xhigh, or max.',
    400,
  );
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw serviceError('COPILOT_CLOCK_INVALID', 'Data Copilot clock is invalid.', 500);
  return date.toISOString();
}

function serviceError(code, message, status, cause) {
  return new DataCopilotServiceError(code, message, status, cause);
}
