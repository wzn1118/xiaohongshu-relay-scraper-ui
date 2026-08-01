import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { buildRunnerArgs } from './lib/contracts.mjs';
import { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';
import {
  WORKFLOW_STATE_SCHEMA_VERSION,
  emptyWorkflowStages,
  initializeWorkflowState,
  readWorkflowState,
  updateWorkflowState,
  workflowStatePath,
  writeJsonAtomically,
} from './lib/workflow-state.mjs';

const TERMINAL = new Set(['succeeded', 'incomplete', 'failed', 'cancelled', 'interrupted', 'blocked']);
const ACTIVE_ATTEMPT_STATUSES = new Set(['queued', 'resuming', 'running']);
const RESUMABLE_JOB_STATUSES = new Set(['incomplete', 'interrupted', 'failed', 'cancelled', 'blocked']);
const RESUME_SCOPES = new Set(['full', 'discovery', 'body_completion', 'analysis', 'audience', 'artifacts']);
const RATE_LIMIT_RECOVERY_STATUSES = new Set(['waiting', 'stopped', 'scheduled', 'resuming']);
const RATE_LIMIT_TERMINAL_STATUSES = new Set(['stopped', 'scheduled']);

export class JobManager {
  constructor({
    dataDir,
    pythonBin,
    runnerPath,
    spawnImpl = spawn,
    terminateImpl = terminateChildTree,
    recoverImpl = terminatePersistedJobProcesses,
    checkpointAnalyzerImpl = analyzeCheckpoint,
    aiSessions,
    profileStore,
    legacyProfilePath,
    diagnostics,
    rateLimitRecovery,
  }) {
    this.dataDir = dataDir;
    this.historyPath = path.join(dataDir, 'jobs.json');
    this.pythonBin = pythonBin;
    this.runnerPath = runnerPath;
    this.spawnImpl = spawnImpl;
    this.terminateImpl = terminateImpl;
    this.recoverImpl = recoverImpl;
    this.processIsolationEnabled = spawnImpl === spawn || recoverImpl !== terminatePersistedJobProcesses;
    this.checkpointAnalyzerImpl = checkpointAnalyzerImpl;
    this.jobs = [];
    this.active = null;
    this.relaySubtask = null;
    this.processes = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.writeQueue = Promise.resolve();
    this.aiSessions = aiSessions;
    this.profileStore = profileStore;
    this.legacyProfilePath = legacyProfilePath;
    this.diagnostics = diagnostics;
    this.runtimeContexts = new Map();
    this.liveCheckpointAnalyses = new Map();
    this.recoveryBlockers = [];
    this.jobLocks = new Map();
    this.deletingJobs = new Set();
    this.rateLimitRecovery = normalizeRateLimitRecoveryOptions(rateLimitRecovery);
    this.rateLimitRecoveryTimers = new Map();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.historyPath, 'utf8'));
      this.jobs = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const now = new Date().toISOString();
    let changed = false;
    for (const job of this.jobs) {
      changed = migrateLegacyJob(job, this.dataDir, now) || changed;
      const state = await initializeWorkflowState(job.statePath, workflowStateFromJob(job));
      changed = applyWorkflowStateToJob(job, state) || changed;
      const expansionWasInFlight = ['running', 'cancelling'].includes(job.workflowSummary?.expansion?.runtimeStatus);
      if (expansionWasInFlight) {
        try {
          await this.recoverImpl({ ...job, pid: job.expansionPid || job.pid });
        } catch (error) {
          job.cleanupError = String(error?.message || error);
        }
        job.workflowSummary = {
          ...(job.workflowSummary || {}),
          expansion: {
            ...job.workflowSummary.expansion,
            runtimeStatus: 'interrupted',
            status: 'interrupted',
            stopReason: 'server_restart',
            resumable: true,
            finishedAt: now,
          },
        };
        job.expansionPid = null;
        changed = true;
      }
      const activeAttempt = currentActiveAttempt(job);
      const wasInFlight = ['queued', 'resuming', 'running'].includes(job.status)
        || Boolean(state.activeAttemptId)
        || Boolean(activeAttempt);
      const needsLegacyRecovery = job.status === 'interrupted'
        && String(job.error || '').startsWith('Server restarted before the task finished.')
        && !job.cleanupConfirmedAt;
      const needsRecovery = wasInFlight || job.pid != null || needsLegacyRecovery;
      if (TERMINAL.has(job.status) || wasInFlight) {
        if (await reconcileJobCheckpoint(job)) changed = true;
      }
      if (job.status === 'interrupted' && job.error === 'Server restarted before the task finished.') {
        job.error = 'Server restarted before the task finished. Checkpoint preserved; resume is available.';
        changed = true;
      }
      let cleanupConfirmed = !needsRecovery;
      if (needsRecovery) {
        try {
          const cleanup = await this.recoverImpl(job);
          job.cleanupConfirmedAt = now;
          job.cleanupResult = cleanup || { matched: 0, terminated: 0 };
          delete job.cleanupError;
          cleanupConfirmed = true;
        } catch (error) {
          job.cleanupError = String(error?.message || error);
          this.recoveryBlockers.push({ id: job.id, error: job.cleanupError });
        }
        changed = true;
      }
      if (wasInFlight) {
        job.status = 'interrupted';
        job.finishedAt = now;
        job.updatedAt = now;
        job.error = 'Server restarted before the task finished. Checkpoint preserved; resume is available.';
        if (!cleanupConfirmed) {
          job.error += ` Orphan cleanup failed: ${job.cleanupError}`;
        }
        if (cleanupConfirmed) job.pid = null;
        finalizeRunningAudienceStage(job, 'server_restart', now);
        finishAttempt(activeAttempt, {
          status: 'interrupted',
          finishedAt: now,
          stopReason: 'server_restart',
          errorCode: cleanupConfirmed ? 'SERVER_RESTART' : 'ORPHAN_CLEANUP_FAILED',
          errorMessage: job.error,
          exitCode: null,
          processedCount: attemptProcessedCount(activeAttempt, job),
          checkpointRevisionAtEnd: Number(state.revision || job.revision || 0) + 1,
        });
        job.activeAttemptId = null;
        const nextState = await this.#commitWorkflowState(job);
        applyWorkflowStateToJob(job, nextState);
        changed = true;
      } else if (TERMINAL.has(job.status) && job.pid != null && cleanupConfirmed) {
        job.pid = null;
        changed = true;
      }
      if (!wasInFlight && TERMINAL.has(job.status) && finalizeRunningAudienceStage(
        job,
        stopReasonForJob(job),
        job.finishedAt || now,
      )) {
        const nextState = await this.#commitWorkflowState(job);
        applyWorkflowStateToJob(job, nextState);
        changed = true;
      }
    }
    for (const job of this.jobs) {
      if (!TERMINAL.has(job.status)) continue;
      try {
        if (await this.#materializeCheckpointApplications(job)) changed = true;
      } catch (error) {
        job.checkpointAnalysisError = String(error?.message || error);
        changed = true;
      }
      const persistedExpansion = job.workflowSummary?.expansion;
      const diskSummary = await readWorkflowSummary(job.outputDir);
      job.workflowSummary = persistedExpansion
        ? { ...(diskSummary || {}), expansion: { ...(diskSummary?.expansion || {}), ...persistedExpansion } }
        : diskSummary;
      if (!job.rateLimit && job.workflowSummary?.rateLimit?.status === 'stopped') {
        job.rateLimit = {
          detected: true,
          ...job.workflowSummary.rateLimit,
          recoveryAction: job.workflowSummary.rateLimit.recoveryAction || 'wait_then_resume',
        };
        changed = true;
      }
      job.artifactCount = await countArtifactFiles(job.outputDir);
    }
    for (const job of this.jobs) {
      changed = this.#armRateLimitRecovery(job, { restore: true }) || changed;
    }
    if (changed) await this.persist();
  }

  list() {
    return this.jobs.map(publicJob);
  }

  get(id) {
    const job = this.jobs.find((item) => item.id === id);
    return job ? publicJob(job) : null;
  }

  getInternal(id) {
    return this.jobs.find((item) => item.id === id) || null;
  }

  async runRelaySubtask(options, operation) {
    if (typeof operation !== 'function') throw new TypeError('Relay subtask operation must be a function.');
    const ownerId = String(options?.ownerId || `relay-subtask-${Date.now()}`);
    const waitIntervalMs = Math.max(100, Number(options?.waitIntervalMs) || 1_000);
    while (this.active || this.relaySubtask) {
      assertRelaySubtaskNotAborted(options?.signal);
      await options?.onWait?.({
        activeJobId: this.active?.id || null,
        activeSubtaskId: this.relaySubtask?.ownerId || null,
        retryAfter: Math.max(1, Math.ceil(waitIntervalMs / 1_000)),
      });
      await relaySubtaskDelay(waitIntervalMs, options?.signal);
    }
    this.relaySubtask = { ownerId, startedAt: new Date().toISOString() };
    try {
      assertRelaySubtaskNotAborted(options?.signal);
      return await operation();
    } finally {
      if (this.relaySubtask?.ownerId === ownerId) this.relaySubtask = null;
      queueMicrotask(() => this.#startNextQueued());
    }
  }

  async start(params, options = {}) {
    if (params?.resumeFromJobId) {
      return this.resume(params.resumeFromJobId, {
        scope: inferResumeScope(params),
        params,
        aiSessionId: params.aiSessionId,
        requestedBy: options.requestedBy || 'legacy_api',
        idempotencyKey: options.idempotencyKey,
        resumeCheckpointJobIds: options.resumeCheckpointJobIds,
      });
    }
    const { queueIfBusy = false } = options;
    if (this.recoveryBlockers.length > 0) {
      const error = new Error('A previous scrape process could not be cleaned up after restart. Restart cleanup must succeed before a new task can start.');
      error.code = 'JOB_RECOVERY_INCOMPLETE';
      error.jobs = this.recoveryBlockers.map((item) => item.id);
      throw error;
    }
    const queuedBehind = this.active;
    const relaySubtaskBusy = Boolean(this.relaySubtask);
    const runtimeBusy = Boolean(queuedBehind || relaySubtaskBusy);
    if (runtimeBusy && !queueIfBusy) {
      const error = new Error('A scrape task is already running.');
      error.code = 'JOB_BUSY';
      if (queuedBehind) error.activeJob = publicJob(queuedBehind);
      if (relaySubtaskBusy) error.activeSubtask = { ...this.relaySubtask };
      throw error;
    }
    const id = `${timestampId()}-${crypto.randomBytes(4).toString('hex')}`;
    const ai = params.aiSessionId
      ? this.aiSessions.resolve(params.aiSessionId)
      : { provider: 'codex', apiKey: '', baseUrl: '', model: '', wireApi: 'responses' };
    const profilePath = params.profileId
      ? await this.profileStore.resolvePath(params.profileId)
      : this.legacyProfilePath;
    const jobDir = path.join(this.dataDir, id);
    const outputDir = path.join(jobDir, 'artifacts');
    const logPath = path.join(jobDir, 'run.log');
    await mkdir(outputDir, { recursive: true });
    const runtimeProfilePath = await createRuntimeProfile(profilePath, params.candidateProfile, jobDir);
    const now = new Date().toISOString();
    const attempt = createAttempt({
      jobId: id,
      jobDir,
      sequence: 1,
      kind: 'initial',
      resumeScope: 'full',
      requestedBy: options.requestedBy || 'user',
      idempotencyKey: options.idempotencyKey || null,
      checkpointRevisionAtStart: 0,
      entryStatus: 'queued',
      processedCountAtStart: 0,
    });
    await mkdir(path.dirname(attempt.logPath), { recursive: true });
    const job = {
      id,
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      status: 'queued',
      params,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      outputDir,
      logPath,
      pid: null,
      progress: 8,
      discoveredCount: 0,
      scrapedCount: 0,
      bodyProcessedCount: 0,
      progressPhase: 'queued',
      progressLabel: '任务已创建，等待启动',
      progressCurrent: 0,
      progressTotal: 0,
      progressUpdatedAt: now,
      workflowSummary: null,
      queuedBehindJobId: queuedBehind?.id || null,
      currentAttemptId: attempt.attemptId,
      activeAttemptId: attempt.attemptId,
      resumeCount: 0,
      lastResumedAt: null,
      revision: 0,
      stages: emptyWorkflowStages(),
      attempts: [attempt],
      statePath: workflowStatePath(outputDir),
      artifactCount: 0,
    };
    if (runtimeBusy) job.progressLabel = '任务已排队，当前采集或任务内补采结束后将自动启动';
    const state = await initializeWorkflowState(job.statePath, workflowStateFromJob(job));
    applyWorkflowStateToJob(job, state);
    this.jobs.unshift(job);
    this.runtimeContexts.set(id, {
      ai,
      profilePath: runtimeProfilePath,
      runnerParams: params,
      attemptId: attempt.attemptId,
    });
    if (!runtimeBusy) {
      this.active = job;
      await this.#markAttemptRunning(job);
    }
    await this.persist();
    if (!runtimeBusy) queueMicrotask(() => this.#run(job));
    return publicJob(job);
  }

  async resume(jobId, options = {}) {
    return this.#withJobLock(jobId, async () => {
      const job = this.getInternal(jobId);
      if (!job) throw jobError('RESUME_SOURCE_NOT_FOUND', 'Resume source task was not found.');
      if (this.deletingJobs.has(jobId)) {
        throw jobError('JOB_DELETION_IN_PROGRESS', 'The task is being deleted and cannot be resumed.');
      }
      const scope = normalizeResumeScope(options.scope);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const duplicate = idempotencyKey
        ? job.attempts?.find((attempt) => (
            attempt.kind !== 'initial'
            && attempt.resumeScope === scope
            && attempt.idempotencyKey === idempotencyKey
          ))
        : null;
      if (duplicate) return { ...publicJob(job), attemptId: duplicate.attemptId };

      if (this.recoveryBlockers.length > 0) {
        const error = jobError(
          'JOB_RECOVERY_INCOMPLETE',
          'A previous scrape process could not be cleaned up after restart. Restart cleanup must succeed before a task can resume.',
        );
        error.jobs = this.recoveryBlockers.map((item) => item.id);
        throw error;
      }
      if (this.active || this.relaySubtask) {
        if (this.active?.id === job.id) {
          const error = jobError('JOB_ALREADY_RUNNING', 'The task already has an active attempt.');
          error.activeJob = publicJob(job);
          throw error;
        }
        const error = jobError('JOB_BUSY', 'Another scrape task is already running.');
        if (this.active) error.activeJob = publicJob(this.active);
        if (this.relaySubtask) error.activeSubtask = { ...this.relaySubtask };
        throw error;
      }
      const activeAttempt = currentActiveAttempt(job);
      if (activeAttempt) {
        const error = jobError('JOB_ATTEMPT_ACTIVE', 'The task already has an active attempt.');
        error.attemptId = activeAttempt.attemptId;
        error.activeJob = publicJob(job);
        throw error;
      }

      try {
        const cleanup = await this.#isolatePersistedProcesses(job, 'before_resume');
        if (cleanup.matched > 0 || cleanup.staleTempsRemoved > 0) await this.persist();
      } catch (error) {
        job.cleanupError = String(error?.message || error);
        job.updatedAt = new Date().toISOString();
        await this.persist();
        const isolationError = jobError(
          'JOB_PROCESS_ISOLATION_FAILED',
          `The previous collection process could not be isolated before resume: ${job.cleanupError}`,
        );
        isolationError.cause = error;
        throw isolationError;
      }

      await reconcileJobCheckpoint(job);
      const state = await readWorkflowState(job.statePath);
      applyWorkflowStateToJob(job, state);
      if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== state.revision) {
        const error = jobError(
          'WORKFLOW_REVISION_CONFLICT',
          `Workflow state revision conflict: expected ${options.expectedRevision}, found ${state.revision}.`,
        );
        error.expectedRevision = Number(options.expectedRevision);
        error.actualRevision = state.revision;
        throw error;
      }
      const exposed = publicJob(job);
      if (!options.forceCompleted && job.status === 'succeeded' && resumeScopeIsComplete(state, exposed, scope)) {
        throw jobError('JOB_ALREADY_COMPLETED', 'The task is already complete.');
      }
      if (!RESUMABLE_JOB_STATUSES.has(job.status) && job.status !== 'succeeded') {
        throw jobError('JOB_NOT_RESUMABLE', `Task status ${job.status} cannot be resumed.`);
      }
      if (!hasRecoverableCheckpoint(job, state, scope)) {
        throw jobError('RESUME_CHECKPOINTS_MISSING', 'The task does not have a recoverable checkpoint.');
      }
      try {
        await readdir(job.outputDir);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        throw jobError('RESUME_OUTPUT_MISSING', 'The original task output directory is missing.');
      }

      const runnerParams = resumeRunnerParams(job.params, options.params, scope);
      const resumeCheckpointJobIds = normalizeInPlaceCheckpointJobIds(
        job.id,
        options.resumeCheckpointJobIds,
      );
      const resumeCheckpointDirs = await this.#prepareInPlaceResume(
        job,
        runnerParams,
        resumeCheckpointJobIds,
      );
      const runtime = await this.#resolveResumeRuntime(job, runnerParams, options);
      const now = new Date().toISOString();
      if (options.rateLimitRecoveryMode) {
        this.#cancelRateLimitRecovery(job.id);
        const manual = options.rateLimitRecoveryMode === 'manual';
        job.rateLimit = {
          ...(job.rateLimit || {}),
          detected: true,
          status: 'resuming',
          nextRetryAt: null,
          retryAfterSeconds: 0,
          recoveryAction: manual ? 'manual_resume' : 'automatic_resume',
          ...(manual
            ? { autoResumeAttempt: 0, lastManualResumeAt: now }
            : { lastAutoResumeAt: now }),
        };
      }
      const sequence = nextAttemptSequence(job.attempts);
      const attempt = createAttempt({
        jobId: job.id,
        jobDir: path.dirname(job.outputDir),
        sequence,
        kind: isRestartInterruption(job) ? 'recovery_after_restart' : 'resume',
        resumeScope: scope,
        requestedBy: options.requestedBy || 'user',
        idempotencyKey,
        checkpointRevisionAtStart: state.revision,
        entryStatus: job.status,
        processedCountAtStart: processedCountForJob(job),
      });
      await mkdir(path.dirname(attempt.logPath), { recursive: true });
      backfillLatestAttemptOutcome(job);
      job.status = 'resuming';
      job.updatedAt = now;
      job.finishedAt = null;
      job.exitCode = null;
      job.error = null;
      job.pid = null;
      job.cancelRequested = false;
      job.interruptRequested = false;
      job.progressPhase = 'resuming';
      job.progressLabel = '正在恢复原任务';
      job.progressUpdatedAt = now;
      job.currentAttemptId = attempt.attemptId;
      job.activeAttemptId = attempt.attemptId;
      job.resumeCount = Number(job.resumeCount || 0) + 1;
      job.lastResumedAt = now;
      job.attempts.push(attempt);
      const nextState = await this.#commitWorkflowState(job, { expectedRevision: state.revision });
      applyWorkflowStateToJob(job, nextState);
      this.runtimeContexts.set(job.id, {
        ...runtime,
        runnerParams,
        attemptId: attempt.attemptId,
        resumeScope: scope,
        resumeCheckpointDirs,
      });
      this.active = job;
      await this.#markAttemptRunning(job);
      await this.persist();
      this.#emit(job.id, 'state', publicJob(job));
      queueMicrotask(() => this.#run(job));
      return { ...publicJob(job), attemptId: attempt.attemptId };
    });
  }

  async signalRateLimitRecovery(id) {
    const job = this.getInternal(id);
    if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');
    if (this.active?.id !== id || job.rateLimit?.status !== 'waiting') {
      return { signaled: false, job: publicJob(job) };
    }
    const now = new Date().toISOString();
    await writeFile(path.join(job.outputDir, '.rate-limit-recover.request'), `${now}\n`, 'utf8');
    job.rateLimit = {
      ...job.rateLimit,
      manualProbeRequestedAt: now,
      recoveryAction: 'manual_probe',
    };
    job.progressLabel = '已收到手动恢复指令，正在跳过剩余冷却并立即探测页面';
    job.progressUpdatedAt = now;
    job.updatedAt = now;
    await this.persist();
    this.#emit(id, 'state', publicJob(job));
    return { signaled: true, job: publicJob(job) };
  }

  #cancelRateLimitRecovery(id) {
    const timer = this.rateLimitRecoveryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.rateLimitRecoveryTimers.delete(id);
  }

  #armRateLimitRecovery(job, { restore = false, busy = false } = {}) {
    this.#cancelRateLimitRecovery(job.id);
    const resumeScope = rateLimitResumeScope(job);
    if (
      !this.rateLimitRecovery.enabled
      || !RATE_LIMIT_TERMINAL_STATUSES.has(job.rateLimit?.status)
      || !RESUMABLE_JOB_STATUSES.has(job.status)
      || !resumeScope
    ) return false;

    const completedAttempts = Math.max(0, Number(job.rateLimit.autoResumeAttempt || 0));
    if (completedAttempts >= this.rateLimitRecovery.maxAttempts) {
      const changed = job.rateLimit.status !== 'stopped'
        || job.rateLimit.recoveryAction !== 'manual_resume';
      job.rateLimit = {
        ...job.rateLimit,
        status: 'stopped',
        autoRecoveryEnabled: false,
        nextRetryAt: null,
        retryAfterSeconds: 0,
        maxAutoResumeAttempts: this.rateLimitRecovery.maxAttempts,
        resumeScope,
        recoveryAction: 'manual_resume',
      };
      return changed;
    }

    const now = Date.now();
    const persistedDueAt = Date.parse(job.rateLimit.nextRetryAt || '');
    const exponentialDelay = Math.min(
      this.rateLimitRecovery.maxDelayMs,
      this.rateLimitRecovery.initialDelayMs * (2 ** completedAttempts),
    );
    const delayMs = busy
      ? this.rateLimitRecovery.busyDelayMs
      : restore && Number.isFinite(persistedDueAt)
        ? Math.max(0, persistedDueAt - now)
        : exponentialDelay;
    const nextRetryAt = new Date(now + delayMs).toISOString();
    job.rateLimit = {
      ...job.rateLimit,
      detected: true,
      status: 'scheduled',
      autoRecoveryEnabled: true,
      autoResumeAttempt: completedAttempts,
      maxAutoResumeAttempts: this.rateLimitRecovery.maxAttempts,
      resumeScope,
      nextRetryAt,
      retryAfterSeconds: Math.ceil(delayMs / 1000),
      recoveryAction: 'automatic_resume',
    };
    job.progressPhase = 'rate_limit_scheduled';
    job.progressLabel = busy
      ? '其他任务正在运行，限流断点续跑已顺延且不会丢失'
      : `平台限流冷却中，将自动进行第 ${completedAttempts + 1} / ${this.rateLimitRecovery.maxAttempts} 轮断点续跑`;
    job.progressUpdatedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      void this.#runScheduledRateLimitRecovery(job.id);
    }, delayMs);
    timer.unref?.();
    this.rateLimitRecoveryTimers.set(job.id, timer);
    return true;
  }

  async #runScheduledRateLimitRecovery(id) {
    this.rateLimitRecoveryTimers.delete(id);
    const job = this.getInternal(id);
    if (!job || !RATE_LIMIT_TERMINAL_STATUSES.has(job.rateLimit?.status)) return;
    const resumeScope = rateLimitResumeScope(job);
    if (!resumeScope) return;
    if (this.active || this.relaySubtask) {
      this.#armRateLimitRecovery(job, { busy: true });
      await this.persist();
      this.#emit(id, 'state', publicJob(job));
      return;
    }

    const attempt = Math.max(0, Number(job.rateLimit.autoResumeAttempt || 0)) + 1;
    const now = new Date().toISOString();
    job.rateLimit = {
      ...job.rateLimit,
      status: 'resuming',
      autoResumeAttempt: attempt,
      maxAutoResumeAttempts: this.rateLimitRecovery.maxAttempts,
      resumeScope,
      nextRetryAt: null,
      retryAfterSeconds: 0,
      lastAutoResumeAt: now,
      recoveryAction: 'automatic_resume',
    };
    job.progressPhase = 'rate_limit_resuming';
    job.progressLabel = `限流冷却结束，正在自动执行第 ${attempt} / ${this.rateLimitRecovery.maxAttempts} 轮断点续跑`;
    job.progressUpdatedAt = now;
    await this.persist();
    this.#emit(id, 'state', publicJob(job));
    try {
      await this.resume(id, {
        scope: resumeScope,
        forceCompleted: true,
        requestedBy: 'rate_limit_auto_recovery',
        idempotencyKey: `rate-limit-auto-${resumeScope}-${attempt}`,
        rateLimitRecoveryMode: 'auto',
      });
    } catch (error) {
      const current = this.getInternal(id);
      if (!current || ACTIVE_ATTEMPT_STATUSES.has(current.status)) return;
      current.rateLimit = {
        ...(current.rateLimit || {}),
        detected: true,
        status: 'stopped',
        resumeScope,
        autoResumeAttempt: attempt,
        lastAutoResumeError: String(error?.message || error),
        recoveryAction: 'automatic_resume',
      };
      this.#armRateLimitRecovery(current, { busy: error?.code === 'JOB_BUSY' });
      await this.persist();
      this.#emit(id, 'state', publicJob(current));
    }
  }

  async cancel(id) {
    const job = this.getInternal(id);
    if (!job) return { found: false };
    if (TERMINAL.has(job.status)) return { found: true, job: publicJob(job), changed: false };
    job.cancelRequested = true;
    const child = this.processes.get(id);
    if (job.status === 'queued' && !child && this.active?.id !== job.id) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.progressLabel = '排队任务已取消';
      job.progressUpdatedAt = job.finishedAt;
      finishAttempt(currentAttempt(job), {
        status: 'cancelled',
        finishedAt: job.finishedAt,
        stopReason: 'user_cancelled',
        processedCount: 0,
        checkpointRevisionAtEnd: Number(job.revision || 0) + 1,
      });
      job.activeAttemptId = null;
      const state = await this.#commitWorkflowState(job, { expectedRevision: job.revision });
      applyWorkflowStateToJob(job, state);
      this.runtimeContexts.delete(id);
      this.#emit(id, 'state', publicJob(job));
      this.#emit(id, 'end', { status: job.status, exitCode: job.exitCode });
      await this.persist();
      if (!this.active && !this.relaySubtask) queueMicrotask(() => this.#startNextQueued());
      return { found: true, job: publicJob(job), changed: true };
    }
    if (child) await this.terminateImpl(child);
    this.#emit(id, 'state', publicJob(job));
    await this.persist();
    return { found: true, job: publicJob(job), changed: true };
  }

  async startExpansion(id, { seedPostIds, config }) {
    return this.#withJobLock('__active_runtime__', () => this.#withJobLock(id, async () => {
      const job = this.getInternal(id);
      if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');
      if (job.params?.analysisMode !== 'general') throw jobError('EXPANSION_SOURCE_INVALID', 'Relationship expansion requires a content research task.');
      if (this.active || this.relaySubtask) {
        const error = jobError('JOB_BUSY', 'A collection process is already running.');
        if (this.active) error.activeJob = publicJob(this.active);
        if (this.relaySubtask) error.activeSubtask = { ...this.relaySubtask };
        throw error;
      }
      const previous = job.workflowSummary?.expansion;
      if (previous?.attemptId || previous?.seedPostIds?.length) {
        throw jobError('EXPANSION_ALREADY_INITIALIZED', 'Relationship expansion already has persisted state; resume it instead.');
      }
      return this.#beginExpansion(job, { seedPostIds, config, kind: 'initial' });
    }));
  }

  async resumeExpansion(id, { retryIncomplete = false } = {}) {
    return this.#withJobLock('__active_runtime__', () => this.#withJobLock(id, async () => {
      const job = this.getInternal(id);
      if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');
      if (this.active || this.relaySubtask) {
        const error = jobError('JOB_BUSY', 'A collection process is already running.');
        if (this.active) error.activeJob = publicJob(this.active);
        if (this.relaySubtask) error.activeSubtask = { ...this.relaySubtask };
        throw error;
      }
      const previous = job.workflowSummary?.expansion;
      if (!previous?.seedPostIds?.length || !previous?.config) {
        throw jobError('EXPANSION_NOT_RESUMABLE', 'Relationship expansion has no saved checkpoint to resume.');
      }
      if (['running', 'cancelling'].includes(previous.runtimeStatus)) {
        throw jobError('EXPANSION_ALREADY_RUNNING', 'Relationship expansion is already running.');
      }
      return this.#beginExpansion(job, {
        seedPostIds: previous.seedPostIds,
        config: previous.config,
        kind: retryIncomplete ? 'retry_incomplete' : 'resume',
      });
    }));
  }

  async cancelExpansion(id) {
    const job = this.getInternal(id);
    if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');
    const expansion = job.workflowSummary?.expansion;
    if (!expansion || !['running', 'cancelling'].includes(expansion.runtimeStatus)) {
      return { changed: false, job: publicJob(job) };
    }
    const cancelRequestedAt = new Date().toISOString();
    job.workflowSummary = {
      ...(job.workflowSummary || {}),
      expansion: { ...expansion, runtimeStatus: 'cancelling', cancelRequestedAt },
    };
    job.updatedAt = cancelRequestedAt;
    await this.persist();
    this.#emit(id, 'state', publicJob(job));
    await writeFile(expansion.cancelPath, 'cancel\n', 'utf8');
    return { changed: true, job: publicJob(job) };
  }

  async #beginExpansion(job, { seedPostIds, config, kind }) {
    const now = new Date().toISOString();
    const attemptId = `expansion-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const jobDir = path.dirname(job.outputDir);
    const requestPath = path.join(jobDir, 'expansion-request.json');
    const cancelPath = path.join(jobDir, 'expansion-cancel.request');
    await unlink(cancelPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const request = {
      outputDir: job.outputDir,
      attemptId,
      seedPostIds,
      config,
      keyword: job.params?.keyword || '',
      relayPort: job.params?.relayPort || 18800,
      gotoTimeoutMs: job.params?.gotoTimeoutMs || 15000,
      noteDelaySeconds: job.params?.noteDelaySeconds || 1.2,
      stableRounds: job.params?.stableRounds || 5,
      cancelPath,
    };
    await writeJsonAtomically(requestPath, request);
    const previous = job.workflowSummary && typeof job.workflowSummary === 'object' ? job.workflowSummary : {};
    job.workflowSummary = {
      ...previous,
      expansion: {
        ...(previous.expansion && typeof previous.expansion === 'object' ? previous.expansion : {}),
        enabled: true,
        runtimeStatus: 'running',
        status: 'running',
        action: kind,
        attemptId,
        seedPostIds,
        config,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        stopReason: '',
        cancelPath,
      },
    };
    job.updatedAt = now;
    this.active = job;
    await this.persist();
    this.#emit(job.id, 'state', publicJob(job));
    queueMicrotask(() => this.#runExpansion(job, requestPath));
    return { job: publicJob(job), attemptId };
  }

  async quiesceForDeletion(id, { timeoutMs = 15000, rejectActive = false } = {}) {
    const job = this.getInternal(id);
    if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');

    return this.#withJobLock(id, async () => {
      const ownsRuntime = !TERMINAL.has(job.status)
        || this.processes.has(id)
        || this.runtimeContexts.has(id)
        || this.liveCheckpointAnalyses.has(id)
        || this.active?.id === id;
      if (rejectActive && ownsRuntime) {
        throw jobError('JOB_ACTIVE_RETENTION', 'Automatic cleanup skipped a task that became active.');
      }
      this.deletingJobs.add(id);
      this.#emit(id, 'closing', { reason: 'deletion' });
      try {
        if (TERMINAL.has(job.status) && !this.processes.has(id) && this.active?.id !== id && !this.liveCheckpointAnalyses.has(id)) {
          this.runtimeContexts.delete(id);
        }
        const requiresExit = !TERMINAL.has(job.status)
          || this.processes.has(id)
          || this.runtimeContexts.has(id)
          || this.liveCheckpointAnalyses.has(id)
          || this.active?.id === id;
        if (requiresExit) {
          const mustObserveEnd = !TERMINAL.has(job.status)
            || this.processes.has(id)
            || this.runtimeContexts.has(id)
            || this.active?.id === id;
          let unsubscribeEnd = () => {};
          const ended = new Promise((resolve) => {
            unsubscribeEnd = this.subscribe(id, (event) => {
              if (event.type !== 'end') return;
              unsubscribeEnd();
              resolve(true);
            });
          });
          const child = this.processes.get(id);
          if (TERMINAL.has(job.status) && child) {
            job.cancelRequested = true;
            await this.terminateImpl(child);
          } else if (!TERMINAL.has(job.status)) {
            await this.cancel(id);
          }
          if (mustObserveEnd) {
            let timeoutId;
            let completed;
            try {
              completed = await Promise.race([
                ended,
                new Promise((resolve) => {
                  timeoutId = setTimeout(() => resolve(false), timeoutMs);
                }),
              ]);
            } finally {
              clearTimeout(timeoutId);
              unsubscribeEnd();
            }
            if (!completed) throw jobError('JOB_STOP_TIMEOUT', 'The task process did not release its resources before deletion.');
          } else {
            unsubscribeEnd();
          }
        }
        const liveAnalysis = this.liveCheckpointAnalyses.get(id);
        if (liveAnalysis) await liveAnalysis;
        await this.writeQueue;
        if (this.processes.has(id) || this.runtimeContexts.has(id) || this.liveCheckpointAnalyses.has(id) || this.active?.id === id) {
          throw jobError('JOB_RESOURCES_BUSY', 'The task still owns live process or file resources.');
        }
        return publicJob(job);
      } catch (error) {
        this.deletingJobs.delete(id);
        throw error;
      }
    });
  }

  releaseDeletionIntent(id) {
    this.deletingJobs.delete(id);
  }

  async removeJobRecord(id) {
    const removed = await this.removeJobRecords([id]);
    if (!removed.length) throw jobError('JOB_NOT_FOUND', 'Task not found.');
    return removed[0];
  }

  async removeJobRecords(ids) {
    const selected = new Set(ids.map(String));
    for (const id of selected) {
      if (this.processes.has(id) || this.runtimeContexts.has(id) || this.liveCheckpointAnalyses.has(id) || this.active?.id === id) {
        throw jobError('JOB_RESOURCES_BUSY', 'The task still owns live process or file resources.');
      }
    }
    const removed = this.jobs.filter((job) => selected.has(job.id));
    if (!removed.length) return [];
    this.jobs = this.jobs.filter((job) => !selected.has(job.id));
    for (const job of removed) {
      this.deletingJobs.delete(job.id);
      this.runtimeContexts.delete(job.id);
      this.liveCheckpointAnalyses.delete(job.id);
      this.events.removeAllListeners(`job:${job.id}`);
    }
    await this.persist();
    return removed.map(publicJob);
  }

  async detachProfile(profileId) {
    const now = new Date().toISOString();
    let changed = 0;
    for (const job of this.jobs) {
      const referenced = job.params?.profileId === profileId || job.config?.profileId === profileId;
      if (!referenced) continue;
      if (job.params && Object.hasOwn(job.params, 'profileId')) job.params.profileId = null;
      if (job.config && Object.hasOwn(job.config, 'profileId')) job.config.profileId = null;
      job.profileReferenceRemovedAt = now;
      job.updatedAt = now;
      changed += 1;
    }
    if (changed) await this.persist();
    return changed;
  }

  async detachJobReferences(jobId) {
    const now = new Date().toISOString();
    let changed = 0;
    for (const job of this.jobs) {
      if (job.id === jobId) continue;
      let detached = false;
      if (job.params?.resumeFromJobId === jobId) {
        delete job.params.resumeFromJobId;
        detached = true;
      }
      if (job.sourceJobId === jobId) {
        job.sourceJobId = null;
        detached = true;
      }
      if (job.legacyResumeLineage?.sourceJobId === jobId) {
        job.legacyResumeLineage = { ...job.legacyResumeLineage, sourceJobId: null };
        detached = true;
      }
      if (!detached) continue;
      job.historyReferenceRemovedAt = now;
      job.updatedAt = now;
      changed += 1;
    }
    if (changed) await this.persist();
    return changed;
  }

  async refreshArtifactCount(id) {
    const job = this.getInternal(id);
    if (!job) throw jobError('JOB_NOT_FOUND', 'Task not found.');
    job.artifactCount = await countArtifactFiles(job.outputDir);
    job.updatedAt = new Date().toISOString();
    await this.persist();
    this.#emit(id, 'state', publicJob(job));
    return job.artifactCount;
  }

  async shutdown() {
    for (const timer of this.rateLimitRecoveryTimers.values()) clearTimeout(timer);
    this.rateLimitRecoveryTimers.clear();
    const job = this.active;
    if (!job) return { interrupted: false };
    const expansion = job.workflowSummary?.expansion;
    if (TERMINAL.has(job.status) && ['running', 'cancelling'].includes(expansion?.runtimeStatus)) {
      const settled = new Promise((resolve) => {
        const unsubscribe = this.subscribe(job.id, (event) => {
          if (event.type !== 'state' || ['running', 'cancelling'].includes(event.data?.workflowSummary?.expansion?.runtimeStatus)) return;
          unsubscribe();
          resolve(true);
        });
      });
      job.expansionInterruptRequested = true;
      await writeFile(expansion.cancelPath, 'cancel\n', 'utf8').catch(() => {});
      const child = this.processes.get(job.id);
      if (child) await this.terminateImpl(child);
      const completed = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(false), 10000))]);
      if (!completed) {
        const now = new Date().toISOString();
        job.workflowSummary = {
          ...(job.workflowSummary || {}),
          expansion: { ...expansion, runtimeStatus: 'interrupted', status: 'interrupted', stopReason: 'server_shutdown', resumable: true, finishedAt: now, updatedAt: now },
        };
        job.updatedAt = now;
        job.expansionPid = null;
        this.processes.delete(job.id);
        if (this.active?.id === job.id) this.active = null;
        await this.persist();
        this.#emit(job.id, 'state', publicJob(job));
      }
      return { interrupted: true };
    }
    if (TERMINAL.has(job.status)) return { interrupted: false };
    const ended = new Promise((resolve) => {
      const unsubscribe = this.subscribe(job.id, (event) => {
        if (event.type === 'end') {
          unsubscribe();
          resolve(true);
        }
      });
    });
    job.interruptRequested = true;
    const child = this.processes.get(job.id);
    if (child) await this.terminateImpl(child);
    this.#emit(job.id, 'state', publicJob(job));
    await this.persist();
    let timeoutId;
    const completed = await Promise.race([
      ended,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), 10000);
      }),
    ]);
    clearTimeout(timeoutId);
    if (!completed) {
      await this.recoverImpl(job);
      job.status = 'interrupted';
      job.error = 'Server shutdown interrupted the task; resume is available from its checkpoint.';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.pid = null;
      finalizeRunningAudienceStage(job, 'server_shutdown', job.finishedAt);
      finishAttempt(currentAttempt(job), {
        status: 'interrupted',
        finishedAt: job.finishedAt,
        stopReason: 'server_shutdown',
        errorCode: 'SERVER_SHUTDOWN',
        errorMessage: job.error,
        processedCount: attemptProcessedCount(currentAttempt(job), job),
        checkpointRevisionAtEnd: Number(job.revision || 0) + 1,
      });
      job.activeAttemptId = null;
      const state = await this.#commitWorkflowState(job, { expectedRevision: job.revision });
      applyWorkflowStateToJob(job, state);
      if (this.active?.id === job.id) this.active = null;
      await this.persist();
    }
    return { interrupted: true, job: publicJob(job) };
  }

  subscribe(id, listener) {
    const event = `job:${id}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async #prepareInPlaceResume(job, params, checkpointJobIds = []) {
    if (checkpointJobIds.length < 1 || (!params?.audienceOnly && !params?.collectAudience)) return [];
    const outputDir = path.resolve(job.outputDir);
    const checkpointDirs = [];
    const seen = new Set();
    for (const id of checkpointJobIds) {
      const checkpoint = this.getInternal(id);
      if (!checkpoint) {
        throw jobError('RESUME_SOURCE_NOT_FOUND', `Resume checkpoint task ${id} was not found.`);
      }
      const checkpointDir = path.resolve(checkpoint.outputDir);
      if (checkpointDir === outputDir || seen.has(checkpointDir)) continue;
      seen.add(checkpointDir);
      checkpointDirs.push(checkpointDir);
    }
    return checkpointDirs;
  }

  async #resolveResumeRuntime(job, params, options) {
    const aiSessionId = options.aiSessionId || params.aiSessionId;
    let ai = { provider: 'codex', apiKey: '', baseUrl: '', model: '', wireApi: 'responses' };
    if (aiSessionId) {
      try {
        ai = this.aiSessions.resolve(aiSessionId);
      } catch (error) {
        const unavailable = jobError('AI_SESSION_UNAVAILABLE', 'The AI session required by this task is unavailable.');
        unavailable.cause = error;
        throw unavailable;
      }
    }
    let profilePath;
    try {
      profilePath = params.profileId
        ? await this.profileStore.resolvePath(params.profileId)
        : await resolveCheckpointProfilePath(job, this.legacyProfilePath);
      profilePath = await createRuntimeProfile(
        profilePath,
        params.candidateProfile,
        path.dirname(job.outputDir),
      );
    } catch (error) {
      const unavailable = jobError('PROFILE_UNAVAILABLE', 'The profile required by this task is unavailable.');
      unavailable.cause = error;
      throw unavailable;
    }
    return { ai, profilePath };
  }

  #withJobLock(jobId, operation) {
    const key = String(jobId);
    const previous = this.jobLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.jobLocks.set(key, current);
    return current.finally(() => {
      if (this.jobLocks.get(key) === current) this.jobLocks.delete(key);
    });
  }

  async #commitWorkflowState(job, { expectedRevision } = {}) {
    return updateWorkflowState(job.statePath, (draft) => {
      draft.status = job.status;
      draft.createdAt = job.createdAt;
      draft.outputDir = job.outputDir;
      draft.activeAttemptId = job.activeAttemptId || null;
      draft.currentAttemptId = job.currentAttemptId || null;
      draft.resumeCount = Number(job.resumeCount || 0);
      draft.lastResumedAt = job.lastResumedAt || null;
      draft.stages = structuredClone(job.stages || draft.stages || emptyWorkflowStages());
      draft.attempts = mergeAttempts(draft.attempts, job.attempts);
      draft.workflowSummary = job.workflowSummary || null;
      draft.artifactCount = Number(job.artifactCount || 0);
      return draft;
    }, { expectedRevision });
  }

  async #markAttemptRunning(job) {
    const now = new Date().toISOString();
    const attempt = currentAttempt(job);
    job.status = 'running';
    job.progress = Math.max(10, Number(job.progress || 0));
    job.startedAt ||= now;
    job.updatedAt = now;
    job.progressPhase = 'starting';
    job.progressLabel = '正在启动采集器并连接 Relay';
    job.progressCurrent = 0;
    job.progressTotal = 0;
    job.progressUpdatedAt = now;
    if (attempt) {
      attempt.status = 'running';
      attempt.startedAt ||= now;
      attempt.checkpointRevisionAtStart ||= Number(job.revision || 0);
    }
    const state = await this.#commitWorkflowState(job, { expectedRevision: job.revision });
    applyWorkflowStateToJob(job, state);
    return state;
  }

  async #runExpansion(job, requestPath) {
    const logPath = path.join(path.dirname(job.outputDir), 'expansion.log');
    const log = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    const buffers = new Map();
    const append = (stream, chunk) => {
      const message = String(chunk);
      log.write(message);
      this.#emit(job.id, 'log', { stream, message, at: new Date().toISOString() });
      const buffered = `${buffers.get(stream) || ''}${message}`;
      const lines = buffered.split(/\r?\n/);
      buffers.set(stream, lines.pop() || '');
      if (lines.some((line) => updateProgressFromLog(job, line))) {
        job.updatedAt = new Date().toISOString();
        this.#emit(job.id, 'state', publicJob(job));
        void this.persist();
      }
    };
    let result = { code: null, error: null };
    try {
      append('system', `Starting expansion attempt ${job.workflowSummary?.expansion?.attemptId} inside task ${job.id}\n`);
      const scriptPath = path.join(path.dirname(this.runnerPath), 'run_expansion_workspace.py');
      const child = this.spawnImpl(this.pythonBin, [scriptPath, '--request-file', requestPath], {
        cwd: path.dirname(this.runnerPath),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          XHS_RELAY_CONNECT_TIMEOUT_MS: process.env.XHS_RELAY_CONNECT_TIMEOUT_MS || '60000',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.expansionPid = child.pid || null;
      this.processes.set(job.id, child);
      child.stdout?.on('data', (chunk) => append('stdout', chunk));
      child.stderr?.on('data', (chunk) => append('stderr', chunk));
      this.#emit(job.id, 'state', publicJob(job));
      result = await waitForChild(child);
    } catch (error) {
      result = { code: null, error };
      append('stderr', `${String(error?.message || error)}\n`);
    } finally {
      for (const line of buffers.values()) {
        if (line) updateProgressFromLog(job, line);
      }
      const diskSummary = await readWorkflowSummary(job.outputDir);
      const previous = job.workflowSummary?.expansion || {};
      const fromDisk = diskSummary?.expansion && typeof diskSummary.expansion === 'object' ? diskSummary.expansion : {};
      const stopReason = String(fromDisk.stopReason || previous.stopReason || (previous.cancelRequestedAt ? 'user_cancelled' : result.error ? 'runner_error' : result.code === 2 ? 'invalid_seed' : 'runner_exit'));
      const interrupted = Boolean(job.expansionInterruptRequested);
      const runtimeStatus = interrupted ? 'interrupted' : expansionRuntimeStatus(fromDisk.status, stopReason, result);
      const priorBusinessStatus = previous.status && !['running', 'cancelling'].includes(previous.status) ? previous.status : '';
      const businessStatus = String(fromDisk.status || priorBusinessStatus || (runtimeStatus === 'completed' ? 'complete' : runtimeStatus));
      const finishedAt = new Date().toISOString();
      job.workflowSummary = {
        ...(job.workflowSummary || {}),
        ...diskSummary,
        expansion: {
          ...previous,
          ...fromDisk,
          runtimeStatus,
          status: businessStatus,
          stopReason: interrupted ? 'server_shutdown' : stopReason,
          finishedAt,
          updatedAt: finishedAt,
          resumable: ['partial', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(runtimeStatus),
          exitCode: result.code,
          error: result.error ? String(result.error.message || result.error) : null,
        },
      };
      job.expansionPid = null;
      job.expansionInterruptRequested = false;
      job.updatedAt = finishedAt;
      job.artifactCount = await countArtifactFiles(job.outputDir);
      this.processes.delete(job.id);
      if (this.active?.id === job.id) this.active = null;
      await this.persist();
      this.#emit(job.id, 'state', publicJob(job));
      await closeWriteStream(log);
      queueMicrotask(() => this.#startNextQueued());
    }
  }

  async #run(job) {
    let attempt = currentAttempt(job);
    let executionPid = attempt?.pid || null;
    const runtime = this.runtimeContexts.get(job.id) || {};
    const runnerParams = runtime.runnerParams || job.params;
    const log = createWriteStream(job.logPath, { flags: 'a', encoding: 'utf8' });
    const attemptLog = attempt?.logPath
      ? createWriteStream(attempt.logPath, { flags: 'a', encoding: 'utf8' })
      : null;
    const progressBuffers = new Map();
    const append = (stream, chunk) => {
      const message = String(chunk);
      log.write(message);
      attemptLog?.write(message);
      this.#emit(job.id, 'log', { stream, message, at: new Date().toISOString() });
      const buffered = `${progressBuffers.get(stream) || ''}${message}`;
      const lines = buffered.split(/\r?\n/);
      progressBuffers.set(stream, lines.pop() || '');
      if (lines.some((line) => updateProgressFromLog(job, line))) {
        this.#emit(job.id, 'state', publicJob(job));
      }
      if (
        job.status === 'running'
        && lines.some((line) => /(?:Collected\s+\d+\s+note links\.|CARD_DISCOVERY\s+complete=\d+)/i.test(line))
      ) {
        void this.#queueLiveCheckpointAnalysis(job, append);
      }
    };
    try {
      if (job.interruptRequested) {
        job.status = 'interrupted';
        job.error = 'Server shutdown interrupted the task; resume is available from its checkpoint.';
        append('system', `Task ${job.id} was interrupted by server shutdown before it started.\n`);
        return;
      }
      if (job.cancelRequested) {
        job.status = 'cancelled';
        append('system', `Task ${job.id} was cancelled before it started.\n`);
        return;
      }
      const runnerState = {
        resumeScope: runtime.resumeScope || attempt?.resumeScope || 'full',
        attemptId: attempt?.attemptId || runtime.attemptId,
        statePath: job.statePath,
        expectedStateRevision: job.revision,
        resumeCheckpointDirs: runtime.resumeCheckpointDirs || [],
      };
      const args = [this.runnerPath, ...buildRunnerArgs(runnerParams, job.outputDir, runnerState)];
      append('system', `Starting ${attempt?.attemptId || 'attempt'} for task ${job.id}\n`);
      const child = this.spawnImpl(this.pythonBin, args, {
        cwd: path.dirname(this.runnerPath),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          XHS_RELAY_CONNECT_TIMEOUT_MS: process.env.XHS_RELAY_CONNECT_TIMEOUT_MS || '60000',
          XHS_AI_PROVIDER: runtime.ai?.provider || 'codex',
          XHS_AI_API_KEY: runtime.ai?.apiKey || '',
          XHS_AI_BASE_URL: runtime.ai?.baseUrl || '',
          XHS_AI_MODEL: runtime.ai?.model || '',
          XHS_AI_WIRE_API: runtime.ai?.wireApi || 'responses',
          XHS_PROFILE_PATH: runtime.profilePath || this.legacyProfilePath,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      executionPid = child.pid || null;
      job.pid = executionPid;
      if (attempt) attempt.pid = job.pid;
      this.processes.set(job.id, child);
      child.stdout?.on('data', (chunk) => append('stdout', chunk));
      child.stderr?.on('data', (chunk) => append('stderr', chunk));
      const completion = waitForChild(child);
      this.#emit(job.id, 'state', publicJob(job));
      await this.persist();
      const result = await completion;
      let cleanupFailure = null;
      try {
        const cleanup = await this.#isolatePersistedProcesses(job, 'runner_exit');
        if (cleanup.matched > 0) {
          append('system', `Cleaned ${cleanup.terminated} orphaned collection process(es) after runner exit.\n`);
        }
      } catch (error) {
        cleanupFailure = error;
        job.cleanupError = String(error?.message || error);
        append('system', `Runner process isolation failed: ${job.cleanupError}\n`);
      }
      job.exitCode = result.code;
      if (job.interruptRequested) {
        job.status = 'interrupted';
        job.error = 'Server shutdown interrupted the task; resume is available from its checkpoint.';
      } else if (job.cancelRequested) {
        job.status = 'cancelled';
      } else if (cleanupFailure) {
        job.status = 'failed';
        job.error = `Runner exited, but orphan process cleanup failed: ${job.cleanupError}`;
      } else if (result.error) {
        job.status = 'failed';
        job.error = result.error.message;
      } else if (result.code === 0) {
        job.status = 'succeeded';
        job.progress = 100;
        job.progressPhase = 'completed';
        job.progressLabel = '任务已完成';
        job.progressUpdatedAt = new Date().toISOString();
      } else if (result.code === 3) {
        job.status = 'incomplete';
        job.error = job.params?.analysisMode === 'general'
          ? '质量门禁发现内容正文或证据分析未完整；当前结果已保存，可从检查点续跑。'
          : '质量门禁发现未完整岗位；当前岗位卡与投递文案已生成，可从检查点续跑。';
        job.progressPhase = 'incomplete';
        job.progressLabel = job.params?.analysisMode === 'general'
          ? '当前检查点已完成分析，仍有内容正文或可回溯证据待补全'
          : '当前检查点已完成分析，仍有岗位正文待补全';
        job.progressUpdatedAt = new Date().toISOString();
      } else if (isRecoverableAudienceRunnerExit(job, runnerParams)) {
        job.status = 'incomplete';
        job.error = '受众采集进程意外中断；已保存的评论、用户与主页检查点完整保留，可继续补采未完成部分。';
        job.progressPhase = 'audience_incomplete';
        job.progressLabel = '本轮采集已中断，检查点已保存，可继续补采未完成评论与用户主页';
        job.progressUpdatedAt = new Date().toISOString();
      } else {
        job.status = 'failed';
        job.error = `Runner exited with code ${result.code ?? 'unknown'}.`;
      }
    } catch (error) {
      job.status = job.interruptRequested ? 'interrupted' : job.cancelRequested ? 'cancelled' : 'failed';
      job.error = String(error?.message || error);
      append('system', `${job.error}\n`);
    } finally {
      let flushedProgress = false;
      for (const line of progressBuffers.values()) {
        flushedProgress = Boolean(line && updateProgressFromLog(job, line)) || flushedProgress;
      }
      if (flushedProgress) {
        this.#emit(job.id, 'state', publicJob(job));
      }
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.pid = null;
      this.processes.delete(job.id);
      if (this.active?.id === job.id) this.active = null;
      const liveAnalysis = this.liveCheckpointAnalyses.get(job.id);
      if (liveAnalysis) await liveAnalysis;
      await reconcileJobCheckpoint(job);
      try {
        const materialized = await this.#materializeCheckpointApplications(job, append);
        if (materialized) {
          job.progressPhase = 'analyzing';
          job.progressLabel = job.params?.analysisMode === 'general'
            ? '已解析当前检查点中的全部内容，等待 AI 动态栏目补全'
            : '已解析当前检查点中的全部岗位并生成投递语';
          job.progressUpdatedAt = new Date().toISOString();
        }
      } catch (error) {
        job.checkpointAnalysisError = String(error?.message || error);
        append('system', `Checkpoint analysis failed: ${job.checkpointAnalysisError}\n`);
      }
      this.runtimeContexts.delete(job.id);
      job.workflowSummary = await readWorkflowSummary(job.outputDir);
      job.artifactCount = await countArtifactFiles(job.outputDir);
      let latestState;
      try {
        latestState = await readWorkflowState(job.statePath);
        applyWorkflowStateToJob(job, latestState, { preserveStatus: true });
        attempt = currentAttempt(job);
      } catch (error) {
        job.status = 'failed';
        job.error = String(error?.message || error);
        append('system', `${job.error}\n`);
      }
      if (job.status !== 'succeeded') {
        finalizeRunningAudienceStage(job, stopReasonForJob(job), job.finishedAt);
      }
      finishAttempt(attempt, {
        status: job.status,
        finishedAt: job.finishedAt,
        pid: executionPid,
        exitCode: job.exitCode,
        stopReason: stopReasonForJob(job),
        errorCode: errorCodeForJob(job),
        errorMessage: job.error || null,
        processedCount: attemptProcessedCount(attempt, job),
        checkpointRevisionAtEnd: Number(latestState?.revision || job.revision || 0) + 1,
      });
      job.activeAttemptId = null;
      try {
        const finalState = await this.#commitWorkflowState(job, {
          expectedRevision: latestState?.revision ?? job.revision,
        });
        applyWorkflowStateToJob(job, finalState);
      } catch (error) {
        job.status = 'failed';
        job.error = String(error?.message || error);
        append('system', `${job.error}\n`);
      }
      this.#armRateLimitRecovery(job);
      await this.persist();
      this.#emit(job.id, 'state', publicJob(job));
      await Promise.all([closeWriteStream(log), closeWriteStream(attemptLog)]);
      this.#emit(job.id, 'end', { status: job.status, exitCode: job.exitCode });
      queueMicrotask(() => this.#startNextQueued());
    }
  }

  async #startNextQueued() {
    if (this.active || this.relaySubtask) return;
    const next = [...this.jobs].reverse().find((job) => job.status === 'queued' && !job.cancelRequested);
    if (!next) return;
    this.active = next;
    next.queuedBehindJobId = null;
    next.progressLabel = '排队结束，正在启动任务';
    next.progressUpdatedAt = new Date().toISOString();
    await this.#markAttemptRunning(next);
    await this.persist();
    queueMicrotask(() => this.#run(next));
  }

  async #materializeCheckpointApplications(job, append = () => {}) {
    await reconcileJobCheckpoint(job);
    const expected = Number(job.discoveredCount || 0);
    if (expected < 1) return false;
    const existing = await countApplicationRecords(path.join(job.outputDir, 'application_intelligence.json'));
    const matchesCheckpoint = existing >= expected && await applicationRecordsMatchCheckpoint(job.outputDir);
    if (matchesCheckpoint) {
      delete job.checkpointAnalysisError;
      return false;
    }
    const runtime = this.runtimeContexts.get(job.id) || {};
    const profilePath = await resolveCheckpointProfilePath(job, runtime.profilePath || this.legacyProfilePath);
    append('system', `Parsing ${expected} discovered jobs from the saved checkpoint.\n`);
    const result = await this.checkpointAnalyzerImpl({
      pythonBin: this.pythonBin,
      runnerPath: this.runnerPath,
      outputDir: job.outputDir,
      profilePath,
      analysisMode: job.params?.analysisMode === 'general' ? 'general' : 'job',
      keyword: String(job.params?.keyword || ''),
      contentPreset: String(job.params?.contentPreset || 'auto'),
      contentGoal: String(job.params?.contentGoal || ''),
    });
    if (result?.stdout) append('stdout', result.stdout);
    if (result?.stderr) append('stderr', result.stderr);
    const generated = await countApplicationRecords(path.join(job.outputDir, 'application_intelligence.json'));
    if (generated < expected || !await applicationRecordsMatchCheckpoint(job.outputDir)) {
      throw new Error(`Checkpoint analysis generated ${generated} of ${expected} required job cards.`);
    }
    job.checkpointAnalysisAt = new Date().toISOString();
    job.checkpointAnalysisCount = generated;
    delete job.checkpointAnalysisError;
    return true;
  }

  #queueLiveCheckpointAnalysis(job, append) {
    const active = this.liveCheckpointAnalyses.get(job.id);
    if (active) return active;
    const analysis = (async () => {
      try {
        const materialized = await this.#materializeCheckpointApplications(job, append);
        if (!materialized) return;
        job.workflowSummary = await readWorkflowSummary(job.outputDir);
        job.artifactCount = await countArtifactFiles(job.outputDir);
        await this.persist();
        append('system', job.params?.analysisMode === 'general'
          ? `Live result panel now contains ${job.checkpointAnalysisCount} parsed content records.\n`
          : `Live result panel now contains ${job.checkpointAnalysisCount} parsed jobs.\n`);
        this.#emit(job.id, 'state', publicJob(job));
      } catch (error) {
        job.checkpointAnalysisError = String(error?.message || error);
        append('system', `Live checkpoint analysis failed: ${job.checkpointAnalysisError}\n`);
      }
    })();
    this.liveCheckpointAnalyses.set(job.id, analysis);
    void analysis.finally(() => {
      if (this.liveCheckpointAnalyses.get(job.id) === analysis) {
        this.liveCheckpointAnalyses.delete(job.id);
      }
    });
    return analysis;
  }

  async #isolatePersistedProcesses(job, reason) {
    if (!this.processIsolationEnabled) {
      return { matched: 0, terminated: 0, staleTempsRemoved: 0, method: 'disabled-for-injected-runner' };
    }
    const cleanup = await this.recoverImpl(job) || { matched: 0, terminated: 0 };
    const staleTempsRemoved = await removeStaleAtomicTemps(job.outputDir);
    job.cleanupConfirmedAt = new Date().toISOString();
    job.cleanupResult = {
      ...cleanup,
      staleTempsRemoved,
      reason,
    };
    delete job.cleanupError;
    return job.cleanupResult;
  }

  #emit(id, type, data) {
    this.diagnostics?.recordJobEvent?.(id, type, data);
    this.events.emit(`job:${id}`, { type, data });
  }

  persist() {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => writeJsonAtomically(this.historyPath, JSON.parse(snapshot)));
    return this.writeQueue;
  }
}

function jobError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expansionRuntimeStatus(summaryStatus, stopReason, result) {
  if (stopReason === 'user_cancelled') return 'cancelled';
  if (stopReason === 'verification_blocked') return 'blocked';
  if (result?.error || ['relay_unavailable', 'fatal_error', 'runner_error', 'invalid_seed'].includes(stopReason)) return 'failed';
  if (summaryStatus === 'complete') return 'completed';
  if (stopReason === 'interrupted') return 'interrupted';
  return 'partial';
}

function normalizeResumeScope(value) {
  const scope = String(value || 'full').trim().toLowerCase();
  if (!RESUME_SCOPES.has(scope)) {
    const error = jobError('RESUME_SCOPE_INVALID', `Unsupported resume scope: ${scope || '(empty)'}.`);
    error.scope = scope;
    throw error;
  }
  return scope;
}

function inferResumeScope(params) {
  if (params?.audienceOnly) return 'audience';
  if (params?.completeMissingOnly) return 'body_completion';
  if (params?.analysisOnly) return 'analysis';
  if (params?.artifactOnly) return 'artifacts';
  return 'full';
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw jobError('IDEMPOTENCY_KEY_INVALID', 'The idempotency key is invalid.');
  }
  return key;
}

function resumeRunnerParams(original, override, scope) {
  const params = {
    ...(original && typeof original === 'object' ? original : {}),
    ...(override && typeof override === 'object' ? override : {}),
    mode: 'resume',
  };
  delete params.resumeFromJobId;
  params.completeMissingOnly = false;
  params.audienceOnly = false;
  if (scope === 'body_completion') params.completeMissingOnly = true;
  if (scope === 'audience') {
    params.audienceOnly = true;
    params.collectAudience = true;
  }
  return params;
}

function normalizeInPlaceCheckpointJobIds(jobId, checkpointJobIds) {
  return [...new Set([
    jobId,
    ...(Array.isArray(checkpointJobIds) ? checkpointJobIds : []),
  ].map((id) => String(id || '').trim()).filter(Boolean))];
}

function createAttempt({
  jobId,
  jobDir,
  sequence,
  kind,
  resumeScope,
  requestedBy,
  idempotencyKey,
  checkpointRevisionAtStart,
  entryStatus,
  processedCountAtStart,
  attemptId,
  status,
}) {
  const id = attemptId || `${jobId}-attempt-${String(sequence).padStart(4, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    attemptId: id,
    sequence,
    kind,
    resumeScope,
    startedAt: null,
    finishedAt: null,
    status: status || (kind === 'initial' ? 'queued' : 'resuming'),
    entryStatus: entryStatus || status || (kind === 'initial' ? 'queued' : 'incomplete'),
    exitStatus: null,
    pid: null,
    exitCode: null,
    stopReason: null,
    errorCode: null,
    errorMessage: null,
    logPath: path.join(jobDir, 'attempts', id, 'run.log'),
    checkpointRevisionAtStart: Number(checkpointRevisionAtStart || 0),
    checkpointRevisionAtEnd: null,
    processedCountAtStart: Math.max(0, Number(processedCountAtStart || 0)),
    processedCount: 0,
    requestedBy: requestedBy || 'user',
    idempotencyKey: idempotencyKey || null,
  };
}

function nextAttemptSequence(attempts) {
  return Math.max(0, ...(Array.isArray(attempts) ? attempts : []).map((item) => Number(item.sequence || 0))) + 1;
}

function currentAttempt(job) {
  if (!Array.isArray(job?.attempts)) return null;
  return job.attempts.find((attempt) => attempt.attemptId === job.currentAttemptId)
    || job.attempts.at(-1)
    || null;
}

function rateLimitResumeScope(job) {
  const explicitScope = job?.rateLimit?.resumeScope;
  if (explicitScope === 'audience' || explicitScope === 'body_completion') return explicitScope;

  const attemptScope = currentAttempt(job)?.resumeScope;
  if (attemptScope === 'audience' || attemptScope === 'body_completion') return attemptScope;
  if (job?.params?.audienceOnly) return 'audience';

  const summary = job?.workflowSummary || {};
  const discovered = Math.max(
    Number(summary.cardsDiscovered || 0),
    Number(summary.discovered || 0),
    Number(job?.discoveredCount || 0),
  );
  const completedBodies = Math.max(
    Number(summary.bodySucceeded || 0),
    Number(summary.bodiesCaptured || 0),
    Number(job?.bodyProcessedCount || 0),
  );
  const bodyStageStatus = String(job?.stages?.bodyCompletion?.status || '');
  const collectionStopReason = String(summary.collectionStopReason || '');
  if (
    discovered > completedBodies
    || ['blocked', 'partial'].includes(bodyStageStatus)
    || ['rate_limited', 'security_verification_timeout'].includes(collectionStopReason)
  ) return 'body_completion';

  if (job?.params?.collectAudience || summary.audience) return 'audience';
  return null;
}

function currentActiveAttempt(job) {
  if (!Array.isArray(job?.attempts)) return null;
  const identified = job.attempts.find((attempt) => attempt.attemptId === job.activeAttemptId);
  if (identified && ACTIVE_ATTEMPT_STATUSES.has(identified.status)) return identified;
  return job.attempts.find((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) || null;
}

function finishAttempt(attempt, values = {}) {
  if (!attempt) return;
  Object.assign(attempt, {
    status: values.status || attempt.status,
    exitStatus: values.exitStatus || values.status || attempt.exitStatus || null,
    finishedAt: values.finishedAt || attempt.finishedAt || new Date().toISOString(),
    pid: values.pid ?? attempt.pid ?? null,
    exitCode: values.exitCode ?? attempt.exitCode ?? null,
    stopReason: values.stopReason ?? attempt.stopReason ?? null,
    errorCode: values.errorCode ?? attempt.errorCode ?? null,
    errorMessage: values.errorMessage ?? attempt.errorMessage ?? null,
    checkpointRevisionAtEnd: values.checkpointRevisionAtEnd ?? attempt.checkpointRevisionAtEnd ?? null,
    processedCount: Math.max(0, Number(values.processedCount ?? attempt.processedCount ?? 0)),
  });
}

function processedCountForJob(job) {
  const audience = job?.workflowSummary?.audience || {};
  return Math.max(
    0,
    Number(job?.bodyProcessedCount || 0),
    Number(job?.scrapedCount || 0),
    Number(job?.workflowSummary?.bodyAttempted || 0),
    Number(audience.postsAttempted || 0),
    Number(audience.commentsCollected || 0),
    Number(audience.usersDiscovered || 0),
  );
}

function attemptProcessedCount(attempt, job) {
  return Math.max(
    0,
    processedCountForJob(job) - Math.max(0, Number(attempt?.processedCountAtStart || 0)),
  );
}

function isRecoverableAudienceRunnerExit(job, runnerParams = job?.params) {
  return Boolean(
    runnerParams?.audienceOnly
    && runnerParams?.collectAudience
    && (
      String(job?.progressPhase || '').startsWith('audience_')
      || Number(job?.workflowSummary?.audience?.commentsCollected || 0) > 0
      || Number(job?.stages?.audience?.postsTotal || 0) > 0
    )
  );
}

function backfillLatestAttemptOutcome(job) {
  const previous = currentAttempt(job);
  if (!previous || !ACTIVE_ATTEMPT_STATUSES.has(previous.status)) return;
  finishAttempt(previous, {
    status: job.status,
    finishedAt: job.finishedAt || job.updatedAt,
    exitCode: job.exitCode,
    stopReason: stopReasonForJob(job),
    errorCode: errorCodeForJob(job),
    errorMessage: job.error || null,
    processedCount: attemptProcessedCount(previous, job),
    checkpointRevisionAtEnd: job.revision || null,
  });
}

function isRestartInterruption(job) {
  const previous = currentAttempt(job);
  return previous?.stopReason === 'server_restart'
    || /server restarted|server restart/i.test(String(job?.error || ''));
}

function hasRecoverableCheckpoint(job, state, scope) {
  if (job.checkpointAvailable || Number(job.artifactCount || 0) > 0) return true;
  if (job.securityRestriction?.status === 'timed_out' || RATE_LIMIT_RECOVERY_STATUSES.has(job.rateLimit?.status)) return true;
  const stages = state?.stages || {};
  const relevant = scope === 'full'
    ? Object.values(stages)
    : [stages[stageKeyForScope(scope)]];
  const metadataFields = new Set(['status', 'ledgerSchemaVersion', 'statisticsSource', 'conservationValid']);
  return relevant.filter(Boolean).some((stage) => {
    if (stage.status && stage.status !== 'not_started') return true;
    return Object.entries(stage).some(([key, value]) => (
      !metadataFields.has(key)
      && value != null
      && (
        typeof value === 'object'
          ? Object.keys(value).length > 0
          : typeof value === 'number'
            ? value > 0
            : typeof value === 'boolean'
              ? value
              : String(value).trim().length > 0
      )
    ));
  });
}

function hasRecoverableStageState(stages) {
  return Object.values(stages || {}).some((stage) => (
    stage && typeof stage === 'object' && stage.status && stage.status !== 'not_started'
  ));
}

function stageKeyForScope(scope) {
  return {
    discovery: 'discovery',
    body_completion: 'bodyCompletion',
    analysis: 'analysis',
    audience: 'audience',
    artifacts: 'artifacts',
  }[scope] || 'discovery';
}

function resumeScopeIsComplete(state, exposedJob, scope) {
  const stages = state?.stages || {};
  const selected = {
    discovery: ['discovery'],
    body_completion: ['bodyCompletion', 'analysis', 'artifacts'],
    analysis: ['analysis', 'artifacts'],
    audience: ['audience', 'artifacts'],
    artifacts: ['artifacts'],
  }[scope] || [
    'discovery',
    'bodyCompletion',
    'analysis',
    ...(exposedJob.config?.analysisMode === 'general' && exposedJob.config?.collectAudience
      ? ['audience']
      : []),
    'artifacts',
  ];
  return selected.every((stageName) => stages[stageName]?.status === 'completed');
}

function migrateLegacyJob(job, dataDir, now) {
  let changed = false;
  const assign = (key, value) => {
    if (job[key] !== undefined && job[key] !== null) return;
    job[key] = value;
    changed = true;
  };
  if (job.status === 'completed') {
    job.status = 'succeeded';
    changed = true;
  }
  assign('schemaVersion', WORKFLOW_STATE_SCHEMA_VERSION);
  assign('params', {});
  assign('createdAt', job.startedAt || now);
  assign('updatedAt', job.finishedAt || job.startedAt || job.createdAt || now);
  assign('outputDir', path.join(dataDir, job.id, 'artifacts'));
  assign('logPath', path.join(path.dirname(job.outputDir), 'run.log'));
  assign('statePath', workflowStatePath(job.outputDir));
  assign('resumeCount', 0);
  assign('lastResumedAt', null);
  assign('revision', 0);
  assign('stages', emptyWorkflowStages());
  assign('artifactCount', 0);
  if (job.params?.resumeFromJobId && !job.legacyResumeLineage) {
    job.legacyResumeLineage = {
      sourceJobId: job.params.resumeFromJobId,
      mode: 'legacy_child',
      detectedAt: now,
    };
    changed = true;
  }
  if (!Array.isArray(job.attempts) || job.attempts.length === 0) {
    const kind = job.params?.resumeFromJobId ? 'resume' : 'initial';
    const attempt = createAttempt({
      jobId: job.id,
      jobDir: path.dirname(job.outputDir),
      sequence: 1,
      kind,
      resumeScope: inferResumeScope(job.params),
      requestedBy: 'legacy_migration',
      idempotencyKey: null,
      checkpointRevisionAtStart: 0,
      attemptId: `${job.id}-attempt-0001`,
      status: job.status || 'interrupted',
      entryStatus: job.status || 'interrupted',
      processedCountAtStart: 0,
    });
    attempt.startedAt = job.startedAt || job.createdAt;
    if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
      finishAttempt(attempt, {
        status: attempt.status,
        finishedAt: job.finishedAt || job.updatedAt,
        exitCode: job.exitCode,
        stopReason: stopReasonForJob(job),
        errorCode: errorCodeForJob(job),
        errorMessage: job.error || null,
        processedCount: processedCountForJob(job),
      });
    }
    job.attempts = [attempt];
    job.currentAttemptId = attempt.attemptId;
    job.activeAttemptId = ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ? attempt.attemptId : null;
    changed = true;
  } else {
    assign('currentAttemptId', job.attempts.at(-1)?.attemptId || null);
    assign('activeAttemptId', currentActiveAttempt(job)?.attemptId || null);
  }
  return changed;
}

function workflowStateFromJob(job) {
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    jobId: job.id,
    revision: Math.max(1, Number(job.revision || 1)),
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    outputDir: job.outputDir,
    activeAttemptId: job.activeAttemptId || null,
    currentAttemptId: job.currentAttemptId || null,
    resumeCount: Number(job.resumeCount || 0),
    lastResumedAt: job.lastResumedAt || null,
    stages: structuredClone(job.stages || emptyWorkflowStages()),
    attempts: structuredClone(job.attempts || []),
    workflowSummary: job.workflowSummary || null,
    artifactCount: Number(job.artifactCount || 0),
  };
}

function applyWorkflowStateToJob(job, state, { preserveStatus = false } = {}) {
  if (state.jobId !== job.id) {
    throw jobError('WORKFLOW_STATE_INVALID', `Workflow state belongs to ${state.jobId}, not ${job.id}.`);
  }
  let changed = false;
  const apply = (key, value) => {
    if (JSON.stringify(job[key]) === JSON.stringify(value)) return;
    job[key] = structuredClone(value);
    changed = true;
  };
  apply('schemaVersion', state.schemaVersion);
  apply('revision', state.revision);
  if (!preserveStatus && state.status) apply('status', state.status);
  apply('activeAttemptId', state.activeAttemptId || null);
  apply('currentAttemptId', state.currentAttemptId || job.currentAttemptId || null);
  apply('resumeCount', Number(state.resumeCount || 0));
  apply('lastResumedAt', state.lastResumedAt || null);
  apply('stages', state.stages || emptyWorkflowStages());
  apply('attempts', state.attempts || []);
  if (state.workflowSummary) apply('workflowSummary', state.workflowSummary);
  if (state.artifactCount !== undefined) apply('artifactCount', Number(state.artifactCount || 0));
  if (state.updatedAt) apply('updatedAt', state.updatedAt);
  return changed;
}

function mergeAttempts(existing, incoming) {
  const byId = new Map();
  for (const attempt of Array.isArray(existing) ? existing : []) {
    if (attempt?.attemptId) byId.set(attempt.attemptId, structuredClone(attempt));
  }
  for (const attempt of Array.isArray(incoming) ? incoming : []) {
    if (!attempt?.attemptId) continue;
    byId.set(attempt.attemptId, { ...(byId.get(attempt.attemptId) || {}), ...structuredClone(attempt) });
  }
  return [...byId.values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function stopReasonForJob(job) {
  if (job.interruptRequested) return 'server_shutdown';
  if (job.cancelRequested || job.status === 'cancelled') return 'user_cancelled';
  if (job.securityRestriction?.status === 'timed_out') return 'security_verification';
  if (RATE_LIMIT_RECOVERY_STATUSES.has(job.rateLimit?.status)) return 'rate_limit';
  if (job.status === 'incomplete') return 'quality_gate';
  if (job.status === 'succeeded') return 'completed';
  if (job.status === 'failed') return 'runner_failed';
  if (job.status === 'interrupted') return 'server_restart';
  return null;
}

function finalizeRunningAudienceStage(job, stopReason, timestamp = new Date().toISOString()) {
  const stage = job.stages?.audience;
  if (stage?.status !== 'running') return false;
  stage.status = 'partial';
  stage.stopReason = stage.stopReason || stopReason || 'interrupted';
  stage.lastCheckpointAt ||= timestamp;
  return true;
}

function errorCodeForJob(job) {
  if (job.status === 'succeeded' || job.status === 'cancelled') return null;
  if (job.securityRestriction?.status === 'timed_out') return 'SECURITY_VERIFICATION_TIMEOUT';
  if (RATE_LIMIT_RECOVERY_STATUSES.has(job.rateLimit?.status)) return 'RATE_LIMITED';
  if (job.status === 'incomplete' && job.progressPhase === 'audience_incomplete') {
    return 'AUDIENCE_RUNNER_INTERRUPTED';
  }
  if (job.status === 'incomplete') return 'QUALITY_GATE_INCOMPLETE';
  if (job.status === 'interrupted') return job.cleanupError ? 'ORPHAN_CLEANUP_FAILED' : 'SERVER_RESTART';
  if (job.status === 'failed') return 'RUNNER_FAILED';
  return null;
}

export function publicJob(job) {
  const status = job.status === 'succeeded' ? 'completed' : job.status;
  const discoveredCount = Number(job.discoveredCount || job.workflowSummary?.cardsDiscovered || 0);
  const scrapedCount = Number(job.scrapedCount || job.workflowSummary?.notesCollected || 0);
  const rawBodyProcessedCount = Math.max(
    Number(job.bodyProcessedCount || 0),
    Number(job.workflowSummary?.bodyAttempted || 0),
    scrapedCount,
  );
  const bodyProcessedCount = discoveredCount > 0
    ? Math.min(discoveredCount, Math.max(scrapedCount, rawBodyProcessedCount))
    : Math.max(scrapedCount, rawBodyProcessedCount);
  const incompleteCount = Number.isFinite(job.checkpointIncompleteCount)
    ? Number(job.checkpointIncompleteCount)
    : Math.max(0, discoveredCount - scrapedCount);
  const resumableStatus = ['incomplete', 'interrupted', 'cancelled', 'failed', 'blocked'].includes(job.status)
    || (job.status === 'succeeded' && incompleteCount > 0);
  const summarySecurity = job.workflowSummary?.securityVerification;
  const securityRestriction = job.securityRestriction || (
    summarySecurity && summarySecurity.status && summarySecurity.status !== 'not_detected'
      ? {
          detected: true,
          status: summarySecurity.status,
          detectedAt: summarySecurity.detectedAt || null,
          timeoutSeconds: Number(summarySecurity.timeoutSeconds || 0),
          recoveryAction: summarySecurity.recoveryAction || null,
        }
      : null
  );
  const summaryRateLimit = job.workflowSummary?.rateLimit;
  const rateLimit = job.rateLimit || (
    summaryRateLimit && RATE_LIMIT_RECOVERY_STATUSES.has(summaryRateLimit.status)
      ? {
          detected: true,
          ...summaryRateLimit,
          detectedAt: summaryRateLimit.detectedAt || null,
          recoveryAction: summaryRateLimit.recoveryAction || 'wait_then_resume',
        }
      : null
  );
  const resumeAvailable = resumableStatus && (
    Boolean(job.checkpointAvailable)
    || securityRestriction?.status === 'timed_out'
    || RATE_LIMIT_RECOVERY_STATUSES.has(rateLimit?.status)
    || hasRecoverableStageState(job.stages)
  );
  return {
    id: job.id,
    schemaVersion: Number(job.schemaVersion || 1),
    keyword: job.params?.keyword,
    status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    message: job.error,
    pid: job.pid,
    config: job.params,
    outputDir: job.outputDir,
    currentAttemptId: job.currentAttemptId || null,
    activeAttemptId: job.activeAttemptId || null,
    resumeCount: Number(job.resumeCount || 0),
    lastResumedAt: job.lastResumedAt || null,
    revision: Number(job.revision || 0),
    stages: structuredClone(job.stages || emptyWorkflowStages()),
    attempts: structuredClone(job.attempts || []),
    legacyResumeLineage: job.legacyResumeLineage || null,
    artifactCount: job.artifactCount || 0,
    applicationCount: Number(job.checkpointAnalysisCount || job.workflowSummary?.applicationCopyGenerated || 0),
    progress: job.progress || 0,
    discoveredCount,
    scrapedCount,
    bodyProcessedCount,
    incompleteCount,
    progressPhase: job.progressPhase || null,
    progressLabel: job.progressLabel || null,
    progressCurrent: Number(job.progressCurrent || 0),
    progressTotal: Number(job.progressTotal || 0),
    progressUpdatedAt: job.progressUpdatedAt || null,
    workflowSummary: job.workflowSummary || null,
    securityRestriction,
    rateLimit,
    resumeAvailable,
  };
}

export function updateProgressFromLog(job, message) {
  let changed = false;
  const update = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && job[key] !== value) {
        job[key] = value;
        changed = true;
      }
    }
  };
  const setProgress = (next) => update({ progress: Math.max(job.progress || 0, next) });

  for (const match of message.matchAll(/EXPANSION_EVENT\s+([a-z_]+)\s+(\{[^\r\n]*\})/gi)) {
    let payload;
    try {
      payload = JSON.parse(match[2]);
    } catch {
      continue;
    }
    const event = match[1].toLowerCase();
    const previousSummary = job.workflowSummary && typeof job.workflowSummary === 'object'
      ? job.workflowSummary
      : {};
    const previousExpansion = previousSummary.expansion && typeof previousSummary.expansion === 'object'
      ? previousSummary.expansion
      : {};
    const previousRounds = Array.isArray(previousExpansion.roundSummaries)
      ? previousExpansion.roundSummaries
      : [];
    const roundSummaries = event === 'expansion_round_completed'
      ? [...previousRounds.filter((item) => Number(item?.roundIndex) !== Number(payload.roundIndex)), payload]
          .sort((left, right) => Number(left.roundIndex) - Number(right.roundIndex))
      : previousRounds;
    const roundIndex = Number(payload.roundIndex ?? previousExpansion.roundIndex ?? 0);
    const maxRounds = Number(previousExpansion.config?.rounds ?? job.params?.expansion?.rounds ?? previousExpansion.maxRounds ?? 0);
    const eventBusinessStatus = event === 'expansion_blocked'
      ? 'blocked'
      : event === 'expansion_budget_reached'
        ? 'partial'
        : String(payload.status ?? previousExpansion.status ?? 'running');
    const expansion = {
      ...previousExpansion,
      enabled: true,
      runtimeStatus: 'running',
      roundIndex,
      maxRounds,
      completedRounds: Number(payload.completedRounds ?? previousExpansion.completedRounds ?? 0),
      frontierCount: Number(payload.frontierCount ?? previousExpansion.frontierCount ?? 0),
      stopReason: String(payload.stopReason ?? (event === 'expansion_blocked' ? 'verification_blocked' : previousExpansion.stopReason) ?? ''),
      status: eventBusinessStatus,
      counters: payload.counters && typeof payload.counters === 'object'
        ? payload.counters
        : previousExpansion.counters || {},
      roundSummaries,
      lastCheckpointAt: new Date().toISOString(),
    };
    update({
      workflowSummary: { ...previousSummary, expansion },
    });
  }

  for (const match of message.matchAll(/AUDIENCE_RATE_LIMIT retry=(\d+)\/(\d+) wait=([\d.]+)s/gi)) {
    const now = new Date().toISOString();
    update({
      progressPhase: 'rate_limit_backoff',
      progressLabel: `平台访问频率受限，自动冷却 ${match[3]} 秒后进行第 ${match[1]} / ${match[2]} 次恢复探测`,
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'waiting',
        resumeScope: 'audience',
        detectedAt: job.rateLimit?.detectedAt || now,
        retryAttempt: Number(match[1]),
        maxRetries: Number(match[2]),
        retryAfterSeconds: Number(match[3]),
        recoveryAction: 'automatic_backoff',
      },
    });
  }
  for (const match of message.matchAll(/AUDIENCE_RATE_LIMIT manual_probe attempt=(\d+)\/(\d+)/gi)) {
    update({
      progressPhase: 'rate_limit_probe',
      progressLabel: `已跳过剩余冷却，正在执行第 ${match[1]} / ${match[2]} 次恢复探测`,
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'waiting',
        resumeScope: 'audience',
        retryAttempt: Number(match[1]),
        maxRetries: Number(match[2]),
        retryAfterSeconds: 0,
        manualProbeConsumedAt: new Date().toISOString(),
        recoveryAction: 'manual_probe',
      },
    });
  }
  for (const match of message.matchAll(/AUDIENCE_RATE_LIMIT waiting attempt=(\d+)\/(\d+) remaining=([\d.]+)s/gi)) {
    update({
      progressPhase: 'rate_limit_backoff',
      progressLabel: `平台限流自动冷却中，剩余 ${match[3]} 秒，第 ${match[1]} / ${match[2]} 次恢复探测`,
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'waiting',
        resumeScope: 'audience',
        retryAttempt: Number(match[1]),
        maxRetries: Number(match[2]),
        retryAfterSeconds: Number(match[3]),
        recoveryAction: 'automatic_backoff',
      },
    });
  }
  if (/AUDIENCE_RATE_LIMIT cleared/gi.test(message)) {
    update({
      progressPhase: 'audience_comments',
      progressLabel: '平台限流已解除，正在从检查点自动继续采集',
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'cleared',
        resumeScope: 'audience',
        clearedAt: new Date().toISOString(),
        retryAfterSeconds: 0,
        recoveryAction: null,
      },
    });
  }
  if (/AUDIENCE_RATE_LIMIT exhausted/gi.test(message)) {
    update({
      progressPhase: 'rate_limited',
      progressLabel: '平台限流自动恢复重试已耗尽，检查点已保存，可稍后续跑',
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'stopped',
        resumeScope: 'audience',
        exhaustedAt: new Date().toISOString(),
        retryAfterSeconds: 0,
        recoveryAction: 'wait_then_resume',
      },
    });
  }

  if (/RATE_LIMIT detected/gi.test(message)) {
    update({
      progressPhase: 'rate_limited',
      progressLabel: '平台访问频率受限，已停止新增访问并转入检查点智能补全',
      rateLimit: {
        ...(job.rateLimit || {}),
        detected: true,
        status: 'stopped',
        resumeScope: 'body_completion',
        detectedAt: job.rateLimit?.detectedAt || new Date().toISOString(),
        recoveryAction: 'wait_then_resume',
      },
    });
  }

  for (const match of message.matchAll(/AUDIENCE_PROGRESS posts=(\d+)\/(\d+) comments=(\d+) users=(\d+) profiles=(\d+)\/(\d+)(?: processed=(\d+)\/(\d+))? phase=(comments|profiles|profile_catchup)/gi)) {
    const phase = match[9].toLowerCase();
    const current = phase === 'comments' ? Number(match[1]) : Number(match[5]);
    const total = phase === 'comments' ? Number(match[2]) : Number(match[6]);
    const batchCurrent = Number(match[7] || 0);
    const batchTotal = Number(match[8] || 0);
    const recoveredSecurity = job.securityRestriction?.status === 'waiting'
      ? {
          ...job.securityRestriction,
          status: 'cleared',
          clearedAt: new Date().toISOString(),
          recoveryAction: null,
        }
      : job.securityRestriction;
    const recoveredRateLimit = RATE_LIMIT_RECOVERY_STATUSES.has(job.rateLimit?.status)
      ? {
          ...job.rateLimit,
          status: 'cleared',
          clearedAt: new Date().toISOString(),
          nextRetryAt: null,
          retryAfterSeconds: 0,
          recoveryAction: null,
        }
      : job.rateLimit;
    update({
      progressPhase: phase === 'comments' ? 'audience_comments' : 'audience_profiles',
      progressLabel: phase === 'comments'
        ? batchTotal > 0
          ? `正在全量采集评论与回复，本轮已处理 ${batchCurrent} / ${batchTotal} 篇，累计完整 ${match[1]} / ${match[2]} 篇，已收集 ${match[3]} 条评论`
          : `正在全量采集评论与回复，累计完整 ${match[1]} / ${match[2]} 篇，已收集 ${match[3]} 条评论`
        : batchTotal > 0
          ? `正在补全评论者公开资料，本轮已处理 ${batchCurrent} / ${batchTotal} 位，累计完成 ${match[5]} / ${match[6]} 位`
          : `正在补全评论者公开资料，累计完成 ${match[5]} / ${match[6]} 位`,
      progressCurrent: current,
      progressTotal: total,
      securityRestriction: recoveredSecurity,
      rateLimit: recoveredRateLimit,
    });
    setProgress(Math.min(98, 88 + Math.round((current / Math.max(1, total)) * 10)));
  }
  for (const match of message.matchAll(/AUDIENCE_COMPLETE posts=(\d+)\/(\d+) comments=(\d+) users=(\d+) profiles=(\d+)\/(\d+) status=(\w+)(?: attempted=(\d+) with_comments=(\d+))?/gi)) {
    const attempted = Number(match[8] || match[1]);
    const withComments = Number(match[9] || 0);
    update({
      progressPhase: match[7] === 'complete' ? 'audience_complete' : 'audience_partial',
      progressLabel: match[7] === 'complete'
        ? `评论与用户公开资料采集完成：${match[3]} 条评论，${match[4]} 位用户`
        : `受众检查点已保存：已检查 ${attempted} / ${match[2]} 篇，${withComments} 篇有评论结果，共 ${match[3]} 条评论`,
      progressCurrent: attempted,
      progressTotal: Number(match[2]),
    });
    setProgress(match[7] === 'complete' ? 99 : 96);
  }

  for (const match of message.matchAll(/SECURITY_VERIFICATION detected timeout=(\d+)s/gi)) {
    const now = new Date().toISOString();
    update({
      progressPhase: 'security_verification',
      progressLabel: '检测到安全验证，已暂停新增访问，等待人工处理',
      securityRestriction: {
        detected: true,
        status: 'waiting',
        detectedAt: job.securityRestriction?.detectedAt || now,
        timeoutSeconds: Number(match[1]),
        recoveryAction: 'manual_verification',
      },
    });
  }
  if (/SECURITY_VERIFICATION cleared/gi.test(message)) {
    update({
      progressPhase: 'scraping',
      progressLabel: '安全验证已完成，正在恢复采集',
      securityRestriction: {
        ...(job.securityRestriction || {}),
        detected: true,
        status: 'cleared',
        clearedAt: new Date().toISOString(),
        recoveryAction: null,
      },
    });
  }
  if (/SECURITY_VERIFICATION timed_out/gi.test(message)) {
    update({
      progressPhase: 'security_restricted',
      progressLabel: '安全验证未完成，已停止新增访问并保留检查点',
      securityRestriction: {
        ...(job.securityRestriction || {}),
        detected: true,
        status: 'timed_out',
        timedOutAt: new Date().toISOString(),
        recoveryAction: 'manual_verification_then_resume',
      },
    });
  }

  for (const match of message.matchAll(/scroll\s+(\d+)\/(\d+):\s+collected\s+(\d+)\s+note links/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    const discovered = Number(match[3]);
    update({
      progressPhase: 'discovering',
      progressLabel: `正在扫描${job.params?.searchSort === 'comprehensive' ? '综合' : '最新'}搜索结果，已发现 ${discovered} 篇`,
      progressCurrent: current,
      progressTotal: total,
      discoveredCount: Math.max(job.discoveredCount || 0, discovered),
    });
    setProgress(Math.min(24, 10 + Math.round((current / Math.max(1, total)) * 14)));
  }
  if (/Selecting latest-first search order/gi.test(message)) {
    update({
      progressPhase: 'sorting',
      progressLabel: '正在切换小红书搜索排序',
      progressCurrent: 0,
      progressTotal: 0,
    });
    setProgress(12);
  }
  if (/Search sort verified:\s*最新/giu.test(message)) {
    update({
      progressPhase: 'sorting',
      progressLabel: '已确认按最新发布排序',
    });
    setProgress(14);
  }
  for (const match of message.matchAll(/Recency filter kept\s+(\d+)\s+cards within\s+(\d+)\s+days;\s+removed\s+(\d+)\s+older cards;\s+kept\s+(\d+)\s+cards with unknown dates/gi)) {
    const kept = Number(match[1]);
    const days = Number(match[2]);
    const removed = Number(match[3]);
    const unknown = Number(match[4]);
    update({
      progressPhase: 'filtering',
      progressLabel: `近 ${days} 天保留 ${kept} 篇，排除 ${removed} 篇旧帖，日期待确认 ${unknown} 篇`,
      discoveredCount: kept,
    });
    setProgress(22);
  }
  // Match only the standalone discovery summary. Scroll lines also contain
  // "collected N note links" and must remain in the discovery phase.
  for (const match of message.matchAll(/^(?:\[[^\]\r\n]+\]\s*)?Collected\s+(\d+)\s+note links\.?\s*$/gim)) {
    const total = Number(match[1]);
    update({
      progressPhase: 'scraping',
      progressLabel: `已发现 ${total} 篇，准备逐篇采集正文`,
      progressCurrent: Math.min(Number(job.scrapedCount || 0), total),
      progressTotal: total,
      discoveredCount: total,
    });
    setProgress(25);
  }
  for (const match of message.matchAll(/CARD_DISCOVERY\s+complete=(\d+)/gi)) {
    const total = Number(match[1]);
    update({
      progressPhase: 'scraping',
      progressLabel: `已保存 ${total} 张岗位卡，准备安全采集正文`,
      progressCurrent: Math.min(Number(job.scrapedCount || 0), total),
      progressTotal: total,
      discoveredCount: total,
    });
    setProgress(25);
  }
  for (const match of message.matchAll(/CARD_CHECKPOINT_NORMALIZED\s+before=(\d+)\s+after=(\d+)\s+duplicates=(\d+)/gi)) {
    const total = Number(match[2]);
    const duplicates = Number(match[3]);
    update({
      progressPhase: 'scraping',
      progressLabel: `已合并 ${duplicates} 条重复卡片，继续处理 ${total} 篇`,
      progressCurrent: Math.min(Number(job.scrapedCount || 0), total),
      progressTotal: total,
      discoveredCount: total,
    });
  }
  for (const match of message.matchAll(/PARALLEL_ROUND\s+(\d+)\/(\d+)\s+pending=(\d+)\s+workers=(\d+)/gi)) {
    const round = Number(match[1]);
    const attempts = Number(match[2]);
    const pending = Number(match[3]);
    const total = Number(job.discoveredCount || job.progressTotal || pending);
    const processed = Math.max(Number(job.bodyProcessedCount || 0), total - pending, 0);
    update({
      progressPhase: 'scraping',
      progressLabel: round > 1
        ? `第 ${round} / ${attempts} 轮补采准备中 · 待检查 ${pending} 篇`
        : `正文采集已启动 · 待检查 ${pending} 篇`,
      progressCurrent: processed,
      progressTotal: total,
      bodyProcessedCount: processed,
    });
  }
  for (const match of message.matchAll(/PARALLEL_PROGRESS\s+processed=(\d+)\s+total=(\d+)\s+complete=(\d+)\s+status=([a-z_]+)(?:\s+round=(\d+)\s+round_processed=(\d+)\s+round_total=(\d+))?/gi)) {
    const processed = Number(match[1]);
    const total = Number(match[2]);
    const complete = Number(match[3]);
    const status = String(match[4]).toLowerCase();
    const round = Number(match[5] || 1);
    const roundProcessed = Number(match[6] || 0);
    const roundTotal = Number(match[7] || 0);
    update({
      progressPhase: 'scraping',
      progressLabel: round > 1
        ? `第 ${round} 轮补采 ${roundProcessed} / ${roundTotal} · 正文 ${complete} / ${total} 篇`
        : status === 'detail_ok'
          ? `正文已保存 · 已检查 ${processed} / ${total} 篇`
          : `已记录 ${status} · 已检查 ${processed} / ${total} 篇`,
      progressCurrent: processed,
      progressTotal: total,
      discoveredCount: total,
      scrapedCount: complete,
      bodyProcessedCount: processed,
    });
    setProgress(Math.min(82, 25 + Math.round((processed / Math.max(1, total)) * 57)));
  }
  for (const match of message.matchAll(/PARALLEL_COMPLETE\s+cards=(\d+)\s+bodies=(\d+)\s+missing=(\d+)/gi)) {
    const total = Number(match[1]);
    const complete = Number(match[2]);
    const missing = Number(match[3]);
    update({
      progressPhase: 'analyzing',
      progressLabel: `正文采集结束：完整 ${complete} 篇，待补全 ${missing} 篇`,
      progressCurrent: total,
      progressTotal: total,
      discoveredCount: total,
      scrapedCount: complete,
      bodyProcessedCount: total,
    });
    setProgress(82);
  }
  for (const match of message.matchAll(/Scraping note\s+(\d+)\/(\d+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    update({
      progressPhase: 'scraping',
      progressLabel: `正在采集第 ${current} / ${total} 篇正文`,
      progressCurrent: current,
      progressTotal: total,
      discoveredCount: total,
    });
    setProgress(Math.min(82, 25 + Math.round((current / Math.max(1, total)) * 57)));
  }
  for (const match of message.matchAll(/NOTE_PROGRESS\s+processed=(\d+)\s+total=(\d+)\s+saved=(\d+)\s+status=([a-z_]+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    const saved = Number(match[3]);
    const status = String(match[4]).toLowerCase();
    const statusLabel = status === 'cached'
      ? '已从检查点跳过'
      : status === 'saved'
        ? '正文已保存'
        : status === 'empty'
          ? '正文为空，已记录状态'
          : '采集失败，已记录状态';
    update({
      progressPhase: 'scraping',
      progressLabel: `${statusLabel} · 已处理 ${current} / ${total} 篇`,
      progressCurrent: current,
      progressTotal: total,
      discoveredCount: total,
      scrapedCount: saved,
      bodyProcessedCount: current,
    });
    setProgress(Math.min(82, 25 + Math.round((current / Math.max(1, total)) * 57)));
  }
  for (const match of message.matchAll(/\[(\d+)\/(\d+)\]\s+Saved/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    update({
      progressPhase: 'scraping',
      progressLabel: `正文已保存 · ${current} / ${total} 篇`,
      progressCurrent: current,
      progressTotal: total,
      discoveredCount: total,
      scrapedCount: Math.max(job.scrapedCount || 0, current),
      bodyProcessedCount: current,
    });
    setProgress(Math.min(82, 25 + Math.round((current / Math.max(1, total)) * 57)));
  }
  for (const match of message.matchAll(/AGENT_STAGE\s+(\d+)\/(\d+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    const labels = [
      '全量正文覆盖检查',
      '发布时间标准化',
      '候选人背景匹配',
      '投递方式提取',
      '岗位能力匹配',
      'AI 求职文案生成',
      '雇主评分与自动重写',
      '质量门禁与文件导出',
    ];
    update({
      progressPhase: current === total ? 'exporting' : 'analyzing',
      progressLabel: labels[current - 1] || `正在执行分析阶段 ${current}`,
      progressCurrent: current,
      progressTotal: total,
    });
    setProgress(Math.min(98, 82 + Math.round((current / Math.max(1, total)) * 16)));
  }
  for (const match of message.matchAll(/AI_RECORD\s+(\d+)\/(\d+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    update({
      progressPhase: 'analyzing',
      progressLabel: `正在生成并复核求职文案 · ${current} / ${total}`,
      progressCurrent: current,
      progressTotal: total,
    });
    setProgress(Math.min(97, 86 + Math.round((current / Math.max(1, total)) * 11)));
  }
  if (changed) {
    job.progressUpdatedAt = new Date().toISOString();
  }
  return changed;
}

async function readWorkflowSummary(outputDir) {
  try {
    const payload = JSON.parse(await readFile(path.join(outputDir, 'workflow-summary.json'), 'utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, error });
      }
    });
    child.once('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal, error: null });
      }
    });
  });
}

function closeWriteStream(stream) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function reconcileJobCheckpoint(job) {
  if (!job?.outputDir) return false;
  const [cards, notes, applications] = await Promise.all([
    countJsonArray(path.join(job.outputDir, 'xiaohongshu_cards_latest.json')),
    countJsonArray(path.join(job.outputDir, 'xiaohongshu_notes_latest.json')),
    inspectApplicationRecords(path.join(job.outputDir, 'application_intelligence.json'), job.params?.analysisMode),
  ]);
  let changed = false;
  if (cards > Number(job.discoveredCount || 0)) {
    job.discoveredCount = cards;
    changed = true;
  }
  if (notes > Number(job.scrapedCount || 0)) {
    job.scrapedCount = notes;
    changed = true;
  }
  if (applications.total > 0 && job.checkpointAnalysisCount !== applications.total) {
    job.checkpointAnalysisCount = applications.total;
    changed = true;
  }
  if (applications.total > 0 && job.checkpointIncompleteCount !== applications.incomplete) {
    job.checkpointIncompleteCount = applications.incomplete;
    changed = true;
  }
  const discovered = Number(job.discoveredCount || 0);
  const scraped = Number(job.scrapedCount || 0);
  const checkpointAvailable = discovered > 0;
  if (job.checkpointAvailable !== checkpointAvailable) {
    job.checkpointAvailable = checkpointAvailable;
    changed = true;
  }
  if (discovered > 0) {
    const checkpointProgress = Math.min(82, 25 + Math.round((scraped / discovered) * 57));
    if (checkpointProgress > Number(job.progress || 0)) {
      job.progress = checkpointProgress;
      changed = true;
    }
  }
  return changed;
}

async function countJsonArray(filePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(payload) ? payload.length : 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return 0;
    throw error;
  }
}

async function countApplicationRecords(filePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(payload?.records) ? payload.records.length : 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return 0;
    throw error;
  }
}

function recordCheckpointKey(record) {
  return String(record?.note_id || record?.note_url || '').trim();
}

async function applicationRecordsMatchCheckpoint(outputDir) {
  try {
    const [cardsPayload, applicationPayload] = await Promise.all([
      readFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), 'utf8').then(JSON.parse),
      readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8').then(JSON.parse),
    ]);
    const cards = Array.isArray(cardsPayload) ? cardsPayload : [];
    const records = Array.isArray(applicationPayload?.records) ? applicationPayload.records : [];
    const cardKeys = cards.map(recordCheckpointKey).filter(Boolean);
    const recordKeys = records.map(recordCheckpointKey).filter(Boolean);
    if (cardKeys.length !== cards.length || recordKeys.length !== records.length || cardKeys.length !== recordKeys.length) {
      return false;
    }
    const expected = new Set(cardKeys);
    return expected.size === cardKeys.length && recordKeys.every((key) => expected.has(key));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function inspectApplicationRecords(filePath, analysisMode = 'job') {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const incompleteRecord = payload?.analysis_mode === 'general' || analysisMode === 'general'
      ? isIncompleteGeneralRecord
      : isIncompleteApplicationRecord;
    return {
      total: records.length,
      incomplete: records.filter(incompleteRecord).length,
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { total: 0, incomplete: 0 };
    throw error;
  }
}

async function resolveCheckpointProfilePath(job, fallback) {
  const runtimePath = path.join(path.dirname(job.outputDir), 'candidate-profile.runtime.json');
  try {
    await readFile(runtimePath, 'utf8');
    return runtimePath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function analyzeCheckpoint({ pythonBin, runnerPath, outputDir, profilePath, analysisMode = 'job', keyword = '', contentPreset = 'auto', contentGoal = '' }) {
  const args = [
    runnerPath,
    '--analysis-mode',
    analysisMode,
    '--keyword',
    keyword,
    '--content-preset',
    contentPreset,
    '--content-goal',
    contentGoal,
    '--analyze-checkpoint',
    '--output-dir',
    outputDir,
    '--candidate-profile',
    profilePath,
    '--no-codex-runtime',
  ];
  const result = await execFileSettled(pythonBin, args, {
    cwd: path.dirname(runnerPath),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      XHS_PROFILE_PATH: profilePath,
    },
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    const detail = String(result.stderr || result.stdout || result.error.message).trim();
    throw new Error(`Checkpoint analysis process failed${detail ? `: ${detail}` : '.'}`);
  }
  return result;
}

async function terminateChildTree(child) {
  if (!child?.pid || process.platform !== 'win32') {
    child?.kill('SIGTERM');
    return;
  }
  await new Promise((resolve) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      () => resolve(),
    );
  });
  try {
    child.kill('SIGTERM');
  } catch {
    // taskkill may have already reaped the child process.
  }
}

async function terminatePersistedJobProcesses(job) {
  if (process.platform !== 'win32') {
    if (Number.isInteger(Number(job?.pid)) && Number(job.pid) > 0) {
      try {
        process.kill(Number(job.pid), 'SIGTERM');
        return { matched: 1, terminated: 1, method: 'pid' };
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    return { matched: 0, terminated: 0, method: 'pid' };
  }

  const outputDir = String(job?.outputDir || '').trim().toLowerCase();
  if (!outputDir) {
    throw new Error('Cannot identify the persisted job process without its unique output directory.');
  }

  const matchesJob = (item) => {
    const commandLine = String(item.CommandLine || '').toLowerCase();
    return Boolean(commandLine) && commandLine.includes(outputDir);
  };
  const before = await listWindowsProcesses();
  const matches = before.filter(matchesJob).filter((item) => Number(item.ProcessId) !== process.pid);
  if (matches.length === 0) {
    return { matched: 0, terminated: 0, method: 'command-line-identity' };
  }

  const matchedIds = new Set(matches.map((item) => Number(item.ProcessId)));
  const roots = matches.filter((item) => !matchedIds.has(Number(item.ParentProcessId)));
  for (const item of roots) {
    await execFileSettled('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true });
  }

  let remaining = (await listWindowsProcesses()).filter(matchesJob);
  for (const item of remaining) {
    await execFileSettled('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true });
  }
  remaining = (await listWindowsProcesses()).filter(matchesJob);
  if (remaining.length > 0) {
    throw new Error(`Persisted job process cleanup left ${remaining.length} matching process(es) running.`);
  }
  return { matched: matches.length, terminated: matches.length, method: 'command-line-identity' };
}

async function removeStaleAtomicTemps(outputDir) {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  const staleTemps = entries.filter((entry) => (
    entry.isFile()
    && entry.name.startsWith('.')
    && entry.name.endsWith('.tmp')
    && /\.\d+\.[a-f0-9-]+\.tmp$/i.test(entry.name)
  ));
  await Promise.all(staleTemps.map(async (entry) => {
    try {
      await unlink(path.join(outputDir, entry.name));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
  return staleTemps.length;
}

async function listWindowsProcesses() {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await execFileSettled(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const text = String(result.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : [payload];
}

function execFileSettled(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

function relaySubtaskDelay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(relaySubtaskAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function assertRelaySubtaskNotAborted(signal) {
  if (signal?.aborted) throw relaySubtaskAbortError();
}

function relaySubtaskAbortError() {
  const error = new Error('Relay subtask was cancelled.');
  error.name = 'AbortError';
  error.code = 'AUDIENCE_AI_CANCELLED';
  return error;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function normalizeRateLimitRecoveryOptions(options = {}) {
  const enabledValue = options.enabled ?? process.env.XHS_RATE_LIMIT_AUTO_RECOVERY;
  const positiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const initialDelayMs = positiveInteger(
    options.initialDelayMs ?? process.env.XHS_RATE_LIMIT_AUTO_RECOVERY_INITIAL_MS,
    5 * 60 * 1000,
  );
  return {
    enabled: enabledValue !== false && String(enabledValue ?? '1').toLowerCase() !== '0',
    initialDelayMs,
    maxDelayMs: Math.max(initialDelayMs, positiveInteger(
      options.maxDelayMs ?? process.env.XHS_RATE_LIMIT_AUTO_RECOVERY_MAX_MS,
      30 * 60 * 1000,
    )),
    maxAttempts: positiveInteger(
      options.maxAttempts ?? process.env.XHS_RATE_LIMIT_AUTO_RECOVERY_ATTEMPTS,
      6,
    ),
    busyDelayMs: positiveInteger(
      options.busyDelayMs ?? process.env.XHS_RATE_LIMIT_AUTO_RECOVERY_BUSY_MS,
      60 * 1000,
    ),
  };
}

async function countArtifactFiles(root) {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function createRuntimeProfile(profilePath, candidateProfile, jobDir) {
  const values = candidateProfile && typeof candidateProfile === 'object' ? candidateProfile : {};
  const hasCandidateValues = Object.values(values).some((value) => typeof value === 'string' && value.trim());
  if (!profilePath || !hasCandidateValues) return profilePath;

  const base = JSON.parse(await readFile(profilePath, 'utf8'));
  const runtimePath = path.join(jobDir, 'candidate-profile.runtime.json');
  const merged = {
    ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}),
    candidate_application: values,
  };
  await writeFile(runtimePath, JSON.stringify(merged, null, 2), 'utf8');
  return runtimePath;
}
