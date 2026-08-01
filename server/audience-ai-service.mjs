import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { assertAudiencePostOwned, buildAudienceAiInput, audienceAiError, resolveAudienceInputDirs } from './lib/audience-ai-input.mjs';
import {
  buildAudienceProfileEnrichmentPlan,
  normalizeProfileEnrichmentEvent,
  normalizeProfileEnrichmentResult,
} from './lib/audience-ai-profile-enrichment.mjs';
import { AUDIENCE_AI_ARTIFACTS, validateAudienceAiArtifacts, writeAudienceAiLatest } from './lib/audience-ai-artifacts.mjs';
import { AudienceAiStore, AUDIENCE_AI_RUNNING_STATUSES } from './lib/audience-ai-store.mjs';

const EVENT_PREFIX = 'AUDIENCE_AI_EVENT ';
const PROMPT_VERSION = 'audience-ai-v1';
const SCHEMA_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RESUMABLE_STATUSES = new Set(['interrupted', 'partial', 'failed', 'cancelled', 'blocked']);
const EXECUTING_STATUSES = AUDIENCE_AI_RUNNING_STATUSES.filter((status) => status !== 'cancelling');
const CANCELLABLE_STATUSES = [...EXECUTING_STATUSES, 'blocked', 'interrupted'];
const RESULT_FILES = Object.freeze({
  analysis: 'analysis.json',
  comments: 'comment-insights.jsonl',
  threads: 'thread-insights.jsonl',
  users: 'user-insights.jsonl',
  evidence: 'evidence.jsonl',
  coverage: 'coverage.json',
});

export class AudienceAiService {
  constructor({
    manager,
    aiSessions,
    config = {},
    spawnImpl = spawn,
    storeFactory = (filePath) => new AudienceAiStore(filePath),
    profileEnricher = null,
  }) {
    this.manager = manager;
    this.aiSessions = aiSessions;
    this.enabled = config.audienceAiEnabled === true;
    this.pythonBin = config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3');
    this.runnerPath = config.audienceAiRunnerPath || path.join(config.projectRoot || process.cwd(), 'scripts', 'run_audience_ai.py');
    this.maxConcurrent = positiveInteger(config.audienceAiMaxConcurrent, 2);
    this.spawnImpl = spawnImpl;
    this.storeFactory = storeFactory;
    this.profileEnricher = profileEnricher
      || (typeof manager.enrichAudienceProfiles === 'function' ? manager.enrichAudienceProfiles.bind(manager) : null);
    this.storePromises = new Map();
    this.processes = new Map();
    this.launchPromises = new Map();
    this.pending = [];
    this.quiescingJobs = new Set();
    this.inFlightMutations = new Map();
    this.closed = false;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  async initialize() {
    if (!this.enabled) return this;
    for (const job of this.manager.list?.() || []) {
      const internal = this.manager.getInternal?.(job.id);
      if (!internal?.outputDir) continue;
      const dbPath = path.join(path.dirname(internal.outputDir), 'audience-ai-state.sqlite3');
      try {
        await access(dbPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const store = this.storeFactory(dbPath);
      try {
        await store.initialize();
      } finally {
        store.close();
      }
    }
    return this;
  }

  async getState(jobId, postId) {
    this.#assertEnabled();
    this.#assertJob(jobId);
    await assertAudiencePostOwned({ manager: this.manager, jobId, postId });
    const store = await this.#store(jobId);
    let overview = store.getOverview(jobId, postId);
    await this.#refreshStaleness(store, overview);
    overview = store.getOverview(jobId, postId);
    const activeRun = overview.currentRun;
    const latest = overview.versions[0] || overview.activeVersion || null;
    const actions = {
      canStart: !activeRun,
      canCancel: Boolean(activeRun && activeRun.status !== 'cancelling'),
      canResume: Boolean(!activeRun && latest && RESUMABLE_STATUSES.has(latest.status) && latest.resumable),
      canReanalyze: Boolean(!activeRun && overview.activeVersion),
      canViewResult: Boolean(overview.activeVersion || latest?.status === 'partial'),
    };
    return {
      featureEnabled: true,
      jobId,
      postId,
      status: activeRun?.status || (latest?.stale ? 'stale' : latest?.status || 'not_started'),
      activeRun,
      currentRun: activeRun,
      activeVersion: overview.activeVersion,
      versions: overview.versions,
      coverage: latest?.coverage || null,
      actions,
      availableActions: actions,
      latestResult: latest ? resultDescriptor(jobId, postId, latest) : null,
    };
  }

  async preview(jobId, postId, scope) {
    this.#assertEnabled();
    this.#assertJob(jobId);
    const model = scope.aiSessionId ? publicModel(this.#resolveAi(scope.aiSessionId)) : {};
    const snapshot = await buildAudienceAiInput({ manager: this.manager, jobId, postId, scope, model });
    const estimate = {
      ...estimateSnapshot(snapshot, scope.modules.length),
      estimatedNetworkRequests: estimateProfileRequests(snapshot, scope),
    };
    const blockers = previewBlockers(snapshot, scope, estimate);
    return {
      jobId,
      postId,
      inputRevision: snapshot.inputRevision,
      coverage: snapshot.coverage,
      quality: snapshot.quality,
      estimate,
      estimatedChunks: estimate.estimatedChunks,
      estimatedCalls: estimate.estimatedCalls,
      estimatedTokens: estimate.estimatedTotalTokens,
      estimatedCost: estimate.estimatedCost,
      estimatedNetworkRequests: estimate.estimatedNetworkRequests,
      estimated: true,
      blockers,
      canStart: blockers.every((item) => item.blocking !== true),
    };
  }

  async start(jobId, postId, scope) {
    return this.#withJobMutation(jobId, () => this.#start(jobId, postId, scope));
  }

  async #start(jobId, postId, scope) {
    this.#assertEnabled();
    const job = this.#assertJob(jobId);
    this.#assertAvailable(jobId);
    const ai = this.#resolveAi(scope.aiSessionId);
    const model = publicModel(ai);
    const baseSnapshot = await buildAudienceAiInput({ manager: this.manager, jobId, postId, scope, model });
    const estimate = estimateSnapshot(baseSnapshot, scope.modules.length);
    const blockers = previewBlockers(baseSnapshot, scope, estimate).filter((item) => item.blocking);
    if (blockers.length) {
      throw audienceAiError(blockers[0].code, blockers[0].message, { blockers, jobId, postId });
    }

    const runId = `audai-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobRoot = path.dirname(job.outputDir);
    const safePostId = safeSegment(postId);
    const snapshotDir = path.join(jobRoot, 'audience-ai-inputs', safePostId, runId);
    const snapshotPath = path.join(snapshotDir, 'snapshot.json');
    const outputDir = path.join(job.outputDir, 'audience-ai', safePostId, runId);
    const publicScope = scopeWithoutSecrets(scope);
    const configHash = stableHash({ scope: publicScope, model, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION });
    const semanticKey = stableHash({ jobId, postId, inputRevision: baseSnapshot.inputRevision, configHash });
    const createdAt = new Date().toISOString();
    const store = await this.#store(jobId);
    this.#assertAvailable(jobId);
    const created = store.createRun({
      runId,
      jobId,
      postId,
      profileMode: scope.profileMode,
      modules: scope.modules,
      outputLanguage: scope.outputLanguage,
      model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      inputRevision: baseSnapshot.inputRevision,
      idempotencyKey: scope.idempotencyKey,
      semanticKey,
      configHash,
      config: { ...publicScope, aiSessionId: scope.aiSessionId },
      snapshotPath,
      outputDir,
      coverage: baseSnapshot.coverage,
      createdAt,
    });
    if (created.reused) {
      return { reused: true, run: created.run, state: await this.getState(jobId, postId) };
    }

    const snapshot = { ...baseSnapshot, runId };
    try {
      await mkdir(snapshotDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });
      await atomicWriteJson(snapshotPath, snapshot);
      store.saveSnapshot({
        snapshotId: `snapshot-${runId}`,
        runId,
        jobId,
        postId,
        inputRevision: snapshot.inputRevision,
        source: snapshot.source,
        coverage: snapshot.coverage,
        hashManifest: snapshot.hashManifest,
        snapshotPath,
        createdAt,
      });
      await this.#refreshStaleness(store, store.getOverview(jobId, postId));
      await this.#record(store, created.run, 'audience_ai_status', {
        status: 'snapshotting',
        stage: 'snapshotting',
        message: 'Audience AI input snapshot created.',
        completedUnits: 0,
        totalUnits: estimate.estimatedUnits,
      });
      this.#schedule({ store, run: store.getRunRuntime(runId), ai, resume: false });
    } catch (error) {
      store.transitionRun(runId, EXECUTING_STATUSES, {
        status: 'failed',
        resumable: false,
        errorCode: error.code || 'AUDIENCE_AI_INTERNAL_ERROR',
        errorMessage: error.message,
      });
      throw error;
    }
    return { reused: false, run: store.getRun(runId), state: await this.getState(jobId, postId) };
  }

  async getRun(jobId, postId, runId) {
    this.#assertEnabled();
    const store = await this.#store(jobId);
    return this.#ownedRun(store, jobId, postId, runId);
  }

  async resume(jobId, postId, runId) {
    return this.#withJobMutation(jobId, () => this.#resume(jobId, postId, runId));
  }

  async #resume(jobId, postId, runId) {
    this.#assertEnabled();
    this.#assertJob(jobId);
    this.#assertAvailable(jobId);
    const store = await this.#store(jobId);
    const run = this.#ownedRuntime(store, jobId, postId, runId);
    if (AUDIENCE_AI_RUNNING_STATUSES.includes(run.status)) {
      return { reused: true, run: store.getRun(runId), state: await this.getState(jobId, postId) };
    }
    if (!run.resumable || !RESUMABLE_STATUSES.has(run.status)) {
      throw audienceAiError('AUDIENCE_AI_RUN_NOT_RESUMABLE', 'This audience AI run cannot be resumed.', { runId, status: run.status });
    }
    await access(run.snapshotPath);
    const ai = this.#resolveAi(run.config.aiSessionId);
    await rm(path.join(run.outputDir, 'cancel.requested'), { force: true });
    this.#assertAvailable(jobId);
    const transition = store.transitionRun(runId, [...RESUMABLE_STATUSES], {
      status: 'snapshotting',
      resumable: true,
      errorCode: null,
      errorMessage: null,
      cancelledAt: null,
    });
    if (!transition.changed) {
      if (AUDIENCE_AI_RUNNING_STATUSES.includes(transition.run.status)) {
        return { reused: true, run: transition.run, state: await this.getState(jobId, postId) };
      }
      throw audienceAiError('AUDIENCE_AI_RUN_NOT_RESUMABLE', 'This audience AI run cannot be resumed.', { runId, status: transition.run.status });
    }
    const updated = transition.run;
    await this.#record(store, updated, 'audience_ai_status', {
      status: 'snapshotting',
      stage: 'snapshotting',
      message: 'Audience AI run queued for resume.',
    });
    this.#schedule({ store, run: store.getRunRuntime(runId), ai, resume: true });
    return { reused: false, run: store.getRun(runId), state: await this.getState(jobId, postId) };
  }

  async cancel(jobId, postId, runId) {
    return this.#withJobMutation(jobId, () => this.#cancel(jobId, postId, runId));
  }

  async #cancel(jobId, postId, runId) {
    this.#assertEnabled();
    this.#assertJob(jobId);
    this.#assertAvailable(jobId);
    const store = await this.#store(jobId);
    const run = this.#ownedRuntime(store, jobId, postId, runId);
    if (TERMINAL_STATUSES.has(run.status)) {
      return { changed: false, run: store.getRun(runId), state: await this.getState(jobId, postId) };
    }
    const process = this.processes.get(runId);
    if (!process) {
      const transition = store.transitionRun(runId, CANCELLABLE_STATUSES, {
        status: 'cancelled',
        resumable: true,
        cancelledAt: new Date().toISOString(),
      });
      if (!transition.changed) {
        return { changed: false, run: transition.run, state: await this.getState(jobId, postId) };
      }
      const queuedIndex = this.pending.findIndex((item) => item.run.runId === runId);
      if (queuedIndex >= 0) this.pending.splice(queuedIndex, 1);
      await mkdir(run.outputDir, { recursive: true });
      await writeFile(path.join(run.outputDir, 'cancel.requested'), `${new Date().toISOString()}\n`, 'utf8');
      const cancelled = transition.run;
      await this.#record(store, cancelled, 'audience_ai_cancelled', {
        status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled before execution.',
      });
    } else {
      const transition = store.transitionRun(runId, EXECUTING_STATUSES, { status: 'cancelling', resumable: true });
      if (!transition.changed) {
        return { changed: false, run: transition.run, state: await this.getState(jobId, postId) };
      }
      await mkdir(run.outputDir, { recursive: true });
      await writeFile(path.join(run.outputDir, 'cancel.requested'), `${new Date().toISOString()}\n`, 'utf8');
      process.controller?.abort();
      const cancelling = transition.run;
      await this.#record(store, cancelling, 'audience_ai_status', {
        status: 'cancelling', stage: 'cancelling', message: 'Audience AI cancellation requested.',
      });
    }
    return { changed: true, run: store.getRun(runId), state: await this.getState(jobId, postId) };
  }

  async getResults(jobId, postId, query) {
    this.#assertEnabled();
    const store = await this.#store(jobId);
    const selected = query.runId
      ? this.#ownedRuntime(store, jobId, postId, query.runId)
      : store.getActiveVersion(jobId, postId)
        ? this.#ownedRuntime(store, jobId, postId, store.getActiveVersion(jobId, postId).runId)
        : store.listRuns(jobId, postId).find((run) => run.status === 'partial')
          ? this.#ownedRuntime(store, jobId, postId, store.listRuns(jobId, postId).find((run) => run.status === 'partial').runId)
          : null;
    if (!selected) throw audienceAiError('AUDIENCE_AI_RESULT_NOT_FOUND', 'No audience AI result is available for this post.', { jobId, postId });
    if (!['completed', 'partial'].includes(selected.status)) {
      throw audienceAiError('AUDIENCE_AI_RESULT_NOT_FOUND', 'The selected audience AI run has no readable result yet.', { runId: selected.runId });
    }
    const filename = RESULT_FILES[query.module];
    const filePath = path.join(selected.outputDir, filename);
    if (filename.endsWith('.jsonl')) {
      const records = parseJsonLines(await readFile(filePath, 'utf8'));
      const items = records.slice(query.offset, query.offset + query.limit);
      return {
        jobId, postId, runId: selected.runId, status: selected.status, module: query.module,
        offset: query.offset, limit: query.limit, total: records.length,
        items,
        data: items,
      };
    }
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      jobId, postId, runId: selected.runId, status: selected.status, module: query.module,
      offset: 0,
      limit: 1,
      total: 1,
      items: [data],
      data,
      ...(query.module === 'analysis' ? { analysis: data } : {}),
      ...(query.module === 'coverage' ? { coverage: data } : {}),
    };
  }

  async getAnchor(jobId, postId, entityType, entityId, pageSize = 50) {
    this.#assertEnabled();
    const store = await this.#store(jobId);
    const active = store.getActiveVersion(jobId, postId) || store.listRuns(jobId, postId)[0];
    if (!active) throw audienceAiError('AUDIENCE_AI_RESULT_NOT_FOUND', 'No audience AI run exists for this post.', { jobId, postId });
    const runtime = this.#ownedRuntime(store, jobId, postId, active.runId);
    const snapshot = JSON.parse(await readFile(runtime.snapshotPath, 'utf8'));
    const collection = entityType === 'comment' ? snapshot.comments : snapshot.users;
    const key = entityType === 'comment' ? 'commentId' : 'userId';
    const index = Array.isArray(collection) ? collection.findIndex((item) => item?.[key] === entityId) : -1;
    if (index < 0) throw audienceAiError('AUDIENCE_AI_ANCHOR_NOT_FOUND', `${entityType} anchor not found.`, { entityId });
    return { jobId, postId, runId: active.runId, entityType, entityId, index, offset: Math.floor(index / pageSize) * pageSize, pageSize };
  }

  async getEventHighWater(jobId, postId) {
    await assertAudiencePostOwned({ manager: this.manager, jobId, postId });
    const store = await this.#store(jobId);
    return store.getLatestEventSequence(jobId, postId);
  }

  async listEventPage(jobId, postId, afterSequence = 0, { limit = 500, throughSequence = Number.MAX_SAFE_INTEGER } = {}) {
    await assertAudiencePostOwned({ manager: this.manager, jobId, postId });
    const store = await this.#store(jobId);
    const highWater = Math.min(
      Number.isSafeInteger(throughSequence) ? throughSequence : Number.MAX_SAFE_INTEGER,
      store.getLatestEventSequence(jobId, postId),
    );
    const events = store.listEvents(jobId, postId, afterSequence, limit, highWater);
    const nextAfter = events.at(-1)?.sequence ?? afterSequence;
    return { events, nextAfter, hasMore: nextAfter < highWater, throughSequence: highWater };
  }

  async listEvents(jobId, postId, afterSequence = 0) {
    const throughSequence = await this.getEventHighWater(jobId, postId);
    const events = [];
    let cursor = afterSequence;
    while (cursor < throughSequence) {
      const page = await this.listEventPage(jobId, postId, cursor, { limit: 500, throughSequence });
      events.push(...page.events);
      if (!page.hasMore || page.nextAfter <= cursor) break;
      cursor = page.nextAfter;
    }
    return events;
  }

  subscribe(jobId, postId, listener) {
    const key = eventKey(jobId, postId);
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.#waitForAllMutations();
    const pending = this.pending.splice(0);
    for (const item of pending) {
      item.store.transitionRun(item.run.runId, EXECUTING_STATUSES, {
        status: 'interrupted', resumable: true,
        errorCode: 'AUDIENCE_AI_INTERNAL_ERROR', errorMessage: 'The server stopped before this analysis started.',
      });
    }
    for (const { child, controller, store, run } of this.processes.values()) {
      const current = store.getRun(run.runId);
      store.transitionRun(run.runId, AUDIENCE_AI_RUNNING_STATUSES, current?.status === 'cancelling'
        ? { status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString() }
        : {
            status: 'interrupted', resumable: true,
            errorCode: 'AUDIENCE_AI_INTERNAL_ERROR', errorMessage: 'The server stopped before this analysis completed.',
          });
      controller?.abort();
      child?.kill?.();
    }
    await Promise.allSettled([...this.launchPromises.values()].map((item) => item.promise));
    const stores = await Promise.allSettled(this.storePromises.values());
    for (const result of stores) if (result.status === 'fulfilled') result.value.close();
    this.storePromises.clear();
    this.emitter.removeAllListeners();
  }

  async quiesceJob(jobId, { rejectActive = false } = {}) {
    if (this.closed) return;
    this.quiescingJobs.add(jobId);
    try {
      await this.#waitForJobMutations(jobId);
      const storePromise = this.storePromises.get(jobId);
      const storeResult = storePromise ? await Promise.resolve(storePromise).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ) : null;
      if (storeResult?.status === 'rejected') throw storeResult.reason;
      const store = storeResult?.value || null;
      const queued = this.pending.filter((item) => item.run.jobId === jobId);
      const running = [...this.processes.values()].filter((item) => item.run.jobId === jobId);
      const active = queued.length > 0 || running.length > 0 || Boolean(store?.hasActiveRuns(jobId));
      if (rejectActive && active) {
        throw audienceAiError('JOB_ACTIVE_RETENTION', 'The task became active while retention cleanup was preparing to delete it.', { jobId });
      }

      this.pending = this.pending.filter((item) => item.run.jobId !== jobId);
      const cancelledAt = new Date().toISOString();
      for (const item of queued) {
        store?.transitionRun(item.run.runId, AUDIENCE_AI_RUNNING_STATUSES, {
          status: 'cancelled', resumable: true, cancelledAt,
        });
      }
      for (const item of running) {
        item.store.transitionRun(item.run.runId, AUDIENCE_AI_RUNNING_STATUSES, {
          status: 'cancelling', resumable: true,
        });
        item.controller?.abort();
        item.child?.kill?.();
      }

      const launches = [...this.launchPromises.values()]
        .filter((item) => item.jobId === jobId)
        .map((item) => item.promise);
      await Promise.allSettled(launches);
      if (store) {
        for (const run of store.listActiveRuns(jobId)) {
          store.transitionRun(run.runId, AUDIENCE_AI_RUNNING_STATUSES, {
            status: 'cancelled', resumable: true, cancelledAt,
          });
        }
        store.close();
      }
      this.storePromises.delete(jobId);
      for (const key of this.emitter.eventNames()) {
        if (typeof key === 'string' && key.startsWith(`${jobId}\u0000`)) this.emitter.removeAllListeners(key);
      }
    } catch (error) {
      this.quiescingJobs.delete(jobId);
      throw error;
    }
  }

  releaseJobQuiesce(jobId) {
    this.quiescingJobs.delete(jobId);
  }

  #schedule(item) {
    if (this.closed || this.quiescingJobs.has(item.run.jobId)) {
      item.store.transitionRun(item.run.runId, AUDIENCE_AI_RUNNING_STATUSES, this.closed
        ? {
            status: 'interrupted', resumable: true,
            errorCode: 'AUDIENCE_AI_INTERNAL_ERROR', errorMessage: 'The server stopped before this analysis started.',
          }
        : { status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString() });
      return;
    }
    if (this.processes.has(item.run.runId) || this.pending.some((candidate) => candidate.run.runId === item.run.runId)) return;
    if (this.processes.size >= this.maxConcurrent) {
      this.pending.push(item);
      void this.#record(item.store, item.run, 'audience_ai_status', {
        status: 'snapshotting', stage: 'queued', message: 'Audience AI run is waiting for an execution slot.',
      });
      return;
    }
    const promise = this.#launch(item);
    this.launchPromises.set(item.run.runId, { jobId: item.run.jobId, promise });
    void promise.then(
      () => this.launchPromises.delete(item.run.runId),
      () => this.launchPromises.delete(item.run.runId),
    );
  }

  async #launch({ store, run, ai, resume }) {
    const runId = run.runId;
    let child;
    const controller = new AbortController();
    this.processes.set(runId, { child: null, controller, store, run });
    try {
      run = await this.#prepareProfiles({ store, run, resume, signal: controller.signal });
      if (!run) return;
      const beforeSpawn = store.getRun(run.runId);
      if (controller.signal.aborted || beforeSpawn?.status === 'cancelling' || beforeSpawn?.status === 'cancelled') {
        const transition = store.transitionRun(run.runId, AUDIENCE_AI_RUNNING_STATUSES, {
          status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
        });
        if (transition.changed) {
          await this.#record(store, transition.run, 'audience_ai_cancelled', {
            status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled before model analysis.',
          });
        }
        return;
      }
      const started = store.transitionRun(run.runId, EXECUTING_STATUSES, { status: 'analyzing_comments', resumable: true });
      if (!started.changed) return;
      const args = [this.runnerPath, '--input', run.snapshotPath, '--output-dir', run.outputDir, '--run-id', run.runId, '--cancel-file', path.join(run.outputDir, 'cancel.requested')];
      if (resume) args.push('--resume');
      child = this.spawnImpl(this.pythonBin, args, {
        cwd: path.dirname(this.runnerPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          XHS_AI_PROVIDER: ai.provider || 'codex',
          XHS_AI_API_KEY: ai.apiKey || '',
          XHS_AI_BASE_URL: ai.baseUrl || '',
          XHS_AI_MODEL: ai.model || '',
          XHS_AI_WIRE_API: ai.wireApi || 'responses',
        },
      });
      this.processes.set(run.runId, { child, controller, store, run });
      await this.#record(store, started.run, 'audience_ai_status', {
        status: 'analyzing_comments', stage: 'analyzing_comments', message: resume ? 'Audience AI analysis resumed.' : 'Audience AI analysis started.',
      });
      let stdoutBuffer = '';
      let stderrTail = '';
      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/u);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) void this.#handleRunnerLine(store, run, line);
      });
      child.stderr?.on('data', (chunk) => {
        stderrTail = sanitizeMessage(`${stderrTail}${chunk}`).slice(-4_000);
      });
      const exit = await childExit(child);
      if (stdoutBuffer.trim()) await this.#handleRunnerLine(store, run, stdoutBuffer);
      await this.#finalizeProcess(store, run, exit, stderrTail);
    } catch (error) {
      const current = store.getRun(runId);
      if (current?.status === 'cancelling') {
        const transition = store.transitionRun(runId, ['cancelling'], {
          status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
        });
        if (transition.changed) await this.#record(store, transition.run, 'audience_ai_cancelled', {
          status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled.',
        });
      } else if (!TERMINAL_STATUSES.has(current?.status)) {
        const transition = store.transitionRun(runId, EXECUTING_STATUSES, {
          status: 'failed', resumable: true,
          errorCode: error.code || 'AUDIENCE_AI_INTERNAL_ERROR', errorMessage: error.message,
        });
        if (transition.changed) await this.#record(store, transition.run, 'audience_ai_failed', {
          status: 'failed', stage: 'failed', message: sanitizeMessage(error.message),
        });
      }
    } finally {
      this.processes.delete(runId);
      if (!this.closed) {
        let next = this.pending.shift();
        while (next && this.quiescingJobs.has(next.run.jobId)) {
          next.store.transitionRun(next.run.runId, AUDIENCE_AI_RUNNING_STATUSES, {
            status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
          });
          next = this.pending.shift();
        }
        if (next) this.#schedule(next);
      }
    }
  }

  async #prepareProfiles({ store, run, resume, signal }) {
    const scope = run.config || {};
    const initialSnapshot = await readJson(run.snapshotPath);
    const plan = buildAudienceProfileEnrichmentPlan(initialSnapshot, scope);
    if (!plan) return run;

    const prior = run.progress?.profileEnrichment;
    if (prior?.snapshotRefrozen === true) return run;

    const jobRoot = path.dirname(this.#assertJob(run.jobId).outputDir);
    const checkpointPath = path.join(jobRoot, 'audience-ai-profile-checkpoints', safeSegment(run.postId), `${run.runId}.json`);
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    const checkpointBase = {
      schemaVersion: 1,
      jobId: run.jobId,
      postId: run.postId,
      runId: run.runId,
      mode: plan.mode,
      targetUserIds: plan.userIds,
      limits: plan.limits,
      resumed: Boolean(resume),
    };
    await atomicWriteJson(checkpointPath, {
      ...checkpointBase,
      status: 'waiting_profile_enrichment',
      updatedAt: new Date().toISOString(),
    });
    const waitingTransition = store.transitionRun(run.runId, ['snapshotting'], {
      status: 'waiting_profile_enrichment',
      progress: {
        profileEnrichment: {
          status: 'waiting_profile_enrichment',
          mode: plan.mode,
          targetedUsers: plan.userIds.length,
          estimatedNetworkRequests: plan.estimatedNetworkRequests,
          checkpointPath: publicJobRelativePath(jobRoot, checkpointPath),
          snapshotRefrozen: false,
        },
      },
    });
    if (!waitingTransition.changed) return null;
    let waiting = waitingTransition.run;
    await this.#record(store, waiting, 'audience_ai_status', {
      status: 'waiting_profile_enrichment',
      stage: 'waiting_profile_enrichment',
      message: plan.userIds.length
        ? 'Waiting to enrich profiles for users from the selected post.'
        : 'No profile enrichment targets are missing for the selected post.',
      completedUnits: 0,
      totalUnits: plan.userIds.length,
    });

    if (plan.userIds.length === 0) {
      const readyTransition = store.transitionRun(run.runId, ['waiting_profile_enrichment'], {
        status: 'snapshotting',
        progress: {
          profileEnrichment: {
            ...waiting.progress.profileEnrichment,
            status: 'completed',
            snapshotRefrozen: true,
          },
        },
      });
      if (!readyTransition.changed) return null;
      const ready = readyTransition.run;
      await atomicWriteJson(checkpointPath, {
        ...checkpointBase, status: 'completed', completedUsers: 0, updatedAt: new Date().toISOString(),
      });
      return store.getRunRuntime(ready.runId);
    }

    const onEvent = async (rawEvent) => {
      const event = normalizeProfileEnrichmentEvent(rawEvent, plan.mode);
      const current = store.getRun(run.runId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      const transition = store.transitionRun(run.runId, [
        'waiting_profile_enrichment', 'collecting_profile_headers', 'collecting_profile_posts',
      ], {
        status: event.status,
        progress: {
          completedUnits: event.completedUnits,
          totalUnits: event.totalUnits || plan.userIds.length,
          profilesUsed: event.profilesUsed,
          profileEnrichment: {
            ...(current.progress?.profileEnrichment || {}),
            status: event.stage,
            completedUsers: event.completedUnits,
            totalUsers: event.totalUnits || plan.userIds.length,
            checkpoint: event.checkpoint,
            retryAfter: event.retryAfter,
          },
        },
      });
      if (!transition.changed) return;
      const updated = transition.run;
      await atomicWriteJson(checkpointPath, {
        ...checkpointBase,
        status: event.stage,
        completedUsers: event.completedUnits,
        totalUsers: event.totalUnits || plan.userIds.length,
        checkpoint: event.checkpoint,
        retryAfter: event.retryAfter,
        updatedAt: new Date().toISOString(),
      });
      await this.#record(store, updated, event.type, {
        ...event,
        postId: run.postId,
        runId: run.runId,
      });
    };

    let outcome;
    if (!this.profileEnricher) {
      outcome = normalizeProfileEnrichmentResult({
        status: 'partial',
        errorCode: 'AUDIENCE_AI_PROFILE_ENRICHER_UNAVAILABLE',
        message: 'Profile collection is unavailable; analysis will use the already persisted profile data.',
      });
    } else {
      try {
        const invoke = typeof this.profileEnricher === 'function'
          ? this.profileEnricher
          : this.profileEnricher.enrich?.bind(this.profileEnricher);
        if (!invoke) throw audienceAiError('AUDIENCE_AI_INTERNAL_ERROR', 'The profile enrichment adapter is invalid.');
        outcome = normalizeProfileEnrichmentResult(await invoke({
          jobId: run.jobId,
          postId: run.postId,
          runId: run.runId,
          mode: plan.mode,
          users: plan.users,
          userIds: plan.userIds,
          limits: plan.limits,
          outputDir: resolveAudienceInputDirs(this.manager, run.jobId).primaryOutputDir,
          checkpointPath,
          cancelFile: path.join(run.outputDir, 'cancel.requested'),
          resume: Boolean(resume),
          signal,
          onEvent,
        }));
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError' || error?.code === 'AUDIENCE_AI_CANCELLED') {
          outcome = normalizeProfileEnrichmentResult({ status: 'cancelled', message: 'Profile enrichment was cancelled.' });
        } else if (['AUDIENCE_AI_SECURITY_BLOCKED', 'AUDIENCE_AI_RELAY_BUSY'].includes(error?.code)) {
          outcome = normalizeProfileEnrichmentResult({
            status: 'blocked', errorCode: error.code, message: error.message, retryAfter: error.retryAfter,
          });
        } else {
          outcome = normalizeProfileEnrichmentResult({
            status: 'failed', errorCode: error?.code || 'AUDIENCE_AI_PROVIDER_FAILED', message: error?.message,
          });
        }
      }
    }

    await atomicWriteJson(checkpointPath, {
      ...checkpointBase,
      ...outcome,
      updatedAt: new Date().toISOString(),
    });
    if (outcome.status === 'cancelled') {
      const transition = store.transitionRun(run.runId, [...EXECUTING_STATUSES, 'cancelling'], {
        status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
      });
      if (transition.changed) await this.#record(store, transition.run, 'audience_ai_cancelled', {
        status: 'cancelled', stage: 'cancelled', message: outcome.message || 'Profile enrichment was cancelled.',
      });
      return null;
    }
    if (outcome.status === 'blocked') {
      const blockedCode = outcome.errorCode === 'AUDIENCE_AI_RELAY_BUSY'
        ? 'AUDIENCE_AI_RELAY_BUSY'
        : 'AUDIENCE_AI_SECURITY_BLOCKED';
      const transition = store.transitionRun(run.runId, [
        'waiting_profile_enrichment', 'collecting_profile_headers', 'collecting_profile_posts',
      ], {
        status: 'blocked', resumable: true, errorCode: blockedCode, errorMessage: outcome.message,
        progress: {
          profileEnrichment: {
            ...(store.getRun(run.runId)?.progress?.profileEnrichment || {}),
            status: 'blocked', retryAfter: outcome.retryAfter, checkpoint: outcome.checkpoint,
          },
        },
      });
      if (!transition.changed) return null;
      const blocked = transition.run;
      await this.#record(store, blocked, 'audience_ai_blocked', {
        status: 'blocked',
        stage: blockedCode === 'AUDIENCE_AI_RELAY_BUSY' ? 'waiting_relay' : 'security_verification',
        errorCode: blockedCode,
        retryAfter: outcome.retryAfter,
        message: outcome.message || 'Profile enrichment is blocked and can be resumed in the same run.',
      });
      return null;
    }

    const beforeRefreeze = store.getRun(run.runId);
    if (signal.aborted || beforeRefreeze?.status === 'cancelling' || beforeRefreeze?.status === 'cancelled') {
      const transition = store.transitionRun(run.runId, [...EXECUTING_STATUSES, 'cancelling'], {
        status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
      });
      if (transition.changed) await this.#record(store, transition.run, 'audience_ai_cancelled', {
        status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled during profile enrichment.',
      });
      return null;
    }

    const refreshed = await buildAudienceAiInput({
      manager: this.manager,
      jobId: run.jobId,
      postId: run.postId,
      scope,
      model: run.model,
    });
    const afterRefresh = store.getRun(run.runId);
    if (signal.aborted || afterRefresh?.status === 'cancelling' || afterRefresh?.status === 'cancelled') {
      const transition = store.transitionRun(run.runId, [...EXECUTING_STATUSES, 'cancelling'], {
        status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
      });
      if (transition.changed) await this.#record(store, transition.run, 'audience_ai_cancelled', {
        status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled before the enriched snapshot was frozen.',
      });
      return null;
    }
    const refrozenAt = new Date().toISOString();
    const snapshot = {
      ...refreshed,
      runId: run.runId,
      profileEnrichment: {
        mode: plan.mode,
        status: outcome.status,
        targetedUsers: plan.userIds.length,
        degraded: outcome.status !== 'completed',
        errorCode: outcome.errorCode,
        message: outcome.message,
        checkpoint: outcome.checkpoint,
        refrozenAt,
      },
    };
    await atomicWriteJson(run.snapshotPath, snapshot);
    store.replaceSnapshot({
      snapshotId: `snapshot-${run.runId}`,
      runId: run.runId,
      jobId: run.jobId,
      postId: run.postId,
      inputRevision: snapshot.inputRevision,
      semanticKey: stableHash({
        jobId: run.jobId,
        postId: run.postId,
        inputRevision: snapshot.inputRevision,
        configHash: run.configHash,
      }),
      source: snapshot.source,
      coverage: snapshot.coverage,
      hashManifest: snapshot.hashManifest,
      snapshotPath: run.snapshotPath,
      createdAt: refrozenAt,
    });
    await this.#refreshStaleness(store, store.getOverview(run.jobId, run.postId));
    const readyTransition = store.transitionRun(run.runId, [
      'waiting_profile_enrichment', 'collecting_profile_headers', 'collecting_profile_posts',
    ], {
      status: 'snapshotting',
      coverage: snapshot.coverage,
      errorCode: null,
      errorMessage: null,
      progress: {
        profileEnrichment: {
          mode: plan.mode,
          status: outcome.status,
          targetedUsers: plan.userIds.length,
          degraded: outcome.status !== 'completed',
          errorCode: outcome.errorCode,
          checkpoint: outcome.checkpoint,
          checkpointPath: publicJobRelativePath(jobRoot, checkpointPath),
          snapshotRefrozen: true,
          refrozenAt,
        },
      },
    });
    if (!readyTransition.changed) return null;
    const ready = readyTransition.run;
    await this.#record(store, ready, 'audience_ai_profile_progress', {
      status: 'snapshotting',
      stage: 'profile_snapshot_refrozen',
      completedUnits: plan.userIds.length,
      totalUnits: plan.userIds.length,
      degraded: outcome.status !== 'completed',
      message: outcome.status === 'completed'
        ? 'Profile enrichment completed and the AI input snapshot was refrozen.'
        : 'Profile enrichment was partial; the AI input snapshot was refrozen with existing data.',
    });
    return store.getRunRuntime(run.runId);
  }

  async #handleRunnerLine(store, run, line) {
    if (!line.startsWith(EVENT_PREFIX)) return;
    let event;
    try { event = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { return; }
    if (!event || typeof event !== 'object' || event.runId !== run.runId || event.postId !== run.postId) return;
    const type = String(event.type || 'audience_ai_progress');
    const status = runnerStatus(type, event.status, event.stage);
    const progress = publicProgress(event, run);
    const patch = { progress, tokenUsage: progress.tokenUsage, estimatedUsage: progress.estimatedUsage };
    if (status) patch.status = status;
    if (status === 'cancelled') Object.assign(patch, { resumable: true, cancelledAt: new Date().toISOString() });
    if (status === 'partial') Object.assign(patch, { resumable: true, completedAt: new Date().toISOString() });
    if (status === 'failed') Object.assign(patch, { resumable: true, errorCode: event.errorCode || 'AUDIENCE_AI_PROVIDER_FAILED', errorMessage: event.message });
    const transition = store.transitionRun(
      run.runId,
      status === 'cancelled' ? [...EXECUTING_STATUSES, 'cancelling'] : EXECUTING_STATUSES,
      patch,
    );
    if (!transition.changed) return;
    const updated = transition.run;
    await this.#record(store, updated, type, { ...progress, status: status || updated.status, message: sanitizeMessage(event.message) });
  }

  async #finalizeProcess(store, run, exit, stderrTail) {
    let current = store.getRun(run.runId);
    if (!current || current.status === 'cancelled' || current.status === 'interrupted') return;
    if (['partial', 'failed'].includes(current.status)) {
      try {
        const validated = await validateAudienceAiArtifacts(run, { allowedStatuses: [current.status] });
        store.replaceMaterialization(run.runId, validated);
        store.updateRun(run.runId, {
          coverage: validated.coverage,
          tokenUsage: validated.metadata.tokenUsage || current.tokenUsage,
          cost: validated.metadata.cost ?? current.cost,
          estimatedUsage: Boolean(validated.metadata.estimatedUsage),
        });
      } catch (error) {
        store.updateRun(run.runId, {
          status: 'failed',
          resumable: true,
          errorCode: error.code || 'AUDIENCE_AI_SCHEMA_INVALID',
          errorMessage: error.message,
        });
      }
      return;
    }
    if (current.status === 'completed') return;
    if (exit.code === 0) {
      const validated = await validateAudienceAiArtifacts(run);
      store.replaceMaterialization(run.runId, validated);
      const publishing = store.transitionRun(run.runId, EXECUTING_STATUSES, {
        status: 'exporting', resumable: true,
        coverage: validated.coverage,
        tokenUsage: validated.metadata.tokenUsage || current.tokenUsage,
        cost: validated.metadata.cost ?? current.cost,
        estimatedUsage: Boolean(validated.metadata.estimatedUsage),
        errorCode: null, errorMessage: null,
      });
      if (publishing.changed) {
        const publication = writeAudienceAiLatest(run, validated);
        let completed;
        try {
          completed = store.transitionRun(run.runId, ['exporting'], {
            status: 'completed', resumable: false, stale: false,
            completedAt: new Date().toISOString(),
          });
          if (!completed.changed) {
            throw audienceAiError('AUDIENCE_AI_INTERNAL_ERROR', 'Audience AI publication lost ownership before activation.', {
              runId: run.runId, status: completed.run.status,
            });
          }
          store.activateVersion(run.runId);
        } catch (error) {
          publication.rollback();
          throw error;
        }
        await this.#record(store, completed.run, 'audience_ai_completed', {
          ...completed.run.progress, status: 'completed', stage: 'completed', message: 'Audience AI analysis completed and validated.',
        });
      } else if (publishing.run.status === 'cancelling') {
        const cancelled = store.transitionRun(run.runId, ['cancelling'], {
          status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
        });
        if (cancelled.changed) await this.#record(store, cancelled.run, 'audience_ai_cancelled', {
          ...cancelled.run.progress, status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled.',
        });
      }
      return;
    }
    current = store.getRun(run.runId);
    if (exit.code === 2 || current?.status === 'cancelling') {
      const transition = store.transitionRun(run.runId, [...EXECUTING_STATUSES, 'cancelling'], {
        status: 'cancelled', resumable: true, cancelledAt: new Date().toISOString(),
      });
      if (transition.changed) await this.#record(store, transition.run, 'audience_ai_cancelled', {
        ...transition.run.progress, status: 'cancelled', stage: 'cancelled', message: 'Audience AI run cancelled.',
      });
      return;
    }
    let validated = null;
    try {
      validated = await validateAudienceAiArtifacts(run, { allowedStatuses: ['partial', 'failed'] });
      store.replaceMaterialization(run.runId, validated);
    } catch { /* missing or invalid partial output is handled as a failed run below */ }
    const status = validated?.analysis?.status === 'partial' ? 'partial' : 'failed';
    const transition = store.transitionRun(run.runId, EXECUTING_STATUSES, {
      status, resumable: true,
      coverage: validated?.coverage || current.coverage,
      tokenUsage: validated?.metadata?.tokenUsage || current.tokenUsage,
      cost: validated?.metadata?.cost ?? current.cost,
      estimatedUsage: validated ? Boolean(validated.metadata.estimatedUsage) : current.estimatedUsage,
      completedAt: status === 'partial' ? new Date().toISOString() : null,
      errorCode: status === 'partial' ? null : 'AUDIENCE_AI_PROVIDER_FAILED',
      errorMessage: status === 'partial' ? null : stderrTail || `Audience AI runner exited with code ${exit.code ?? 'unknown'}.`,
    });
    if (transition.changed) await this.#record(store, transition.run, status === 'partial' ? 'audience_ai_partial' : 'audience_ai_failed', {
      ...transition.run.progress, status, stage: status,
      message: status === 'partial' ? 'Audience AI produced a partial, resumable result.' : transition.run.errorMessage,
    });
  }

  async #record(store, run, type, data) {
    const clean = scrubSecrets(data);
    const event = store.appendEvent(run.runId, type, clean);
    this.emitter.emit(eventKey(run.jobId, run.postId), { ...event, runId: run.runId, postId: run.postId, jobId: run.jobId });
    return event;
  }

  async #refreshStaleness(store, overview) {
    const candidates = overview.versions.filter((run) => ['completed', 'partial'].includes(run.status));
    const revisions = new Map();
    for (const run of candidates) {
      if (!revisions.has(run.configHash)) {
        const runtime = store.getRunRuntime(run.runId);
        const snapshot = await buildAudienceAiInput({
          manager: this.manager,
          jobId: run.jobId,
          postId: run.postId,
          scope: runtime.config,
          model: runtime.model,
        });
        revisions.set(run.configHash, snapshot.inputRevision);
      }
      const currentInputRevision = revisions.get(run.configHash);
      const transition = store.setRunStale(run.runId, run.inputRevision !== currentInputRevision);
      if (transition.changed && transition.run?.stale) {
        await this.#record(store, transition.run, 'audience_ai_stale', {
          ...transition.run.progress,
          status: 'stale',
          stage: 'stale',
          stale: true,
          inputRevision: transition.run.inputRevision,
          currentInputRevision,
          message: 'Audience AI input changed; the previous version remains available.',
        });
      }
    }
  }

  async #store(jobId) {
    this.#assertJob(jobId);
    if (!this.storePromises.has(jobId)) {
      this.#assertAvailable(jobId);
      const jobRoot = path.dirname(this.manager.getInternal(jobId).outputDir);
      const store = this.storeFactory(path.join(jobRoot, 'audience-ai-state.sqlite3'));
      this.storePromises.set(jobId, Promise.resolve(store.initialize()).then(() => store));
    }
    return this.storePromises.get(jobId);
  }

  async #withJobMutation(jobId, action) {
    this.#assertAvailable(jobId);
    let entry = this.inFlightMutations.get(jobId);
    if (!entry) {
      entry = { count: 0, waiters: new Set() };
      this.inFlightMutations.set(jobId, entry);
    }
    entry.count += 1;
    try {
      return await action();
    } finally {
      entry.count -= 1;
      if (entry.count === 0) {
        this.inFlightMutations.delete(jobId);
        for (const resolve of entry.waiters) resolve();
        entry.waiters.clear();
      }
    }
  }

  async #waitForJobMutations(jobId) {
    const entry = this.inFlightMutations.get(jobId);
    if (!entry || entry.count === 0) return;
    await new Promise((resolve) => entry.waiters.add(resolve));
  }

  async #waitForAllMutations() {
    await Promise.all([...this.inFlightMutations.keys()].map((jobId) => this.#waitForJobMutations(jobId)));
  }

  #assertEnabled() {
    if (!this.enabled) throw audienceAiError('AUDIENCE_AI_DISABLED', 'Audience AI analysis is disabled.');
  }

  #assertAvailable(jobId) {
    if (this.closed || this.quiescingJobs.has(jobId)) {
      throw audienceAiError('AUDIENCE_AI_INTERNAL_ERROR', 'Audience AI analysis is stopping for this task. Try again after the task is available.', { jobId });
    }
  }

  #assertJob(jobId) {
    const job = this.manager.getInternal(jobId);
    if (!job) throw audienceAiError('AUDIENCE_AI_JOB_NOT_FOUND', 'The requested task was not found.', { jobId });
    return job;
  }

  #resolveAi(aiSessionId) {
    if (!aiSessionId) throw audienceAiError('AUDIENCE_AI_SESSION_REQUIRED', 'An AI session is required for audience analysis.');
    try {
      return this.aiSessions.resolve(aiSessionId);
    } catch (error) {
      throw audienceAiError('AUDIENCE_AI_SESSION_EXPIRED', 'The AI session is missing or expired. Configure the provider again.', { cause: error });
    }
  }

  #ownedRun(store, jobId, postId, runId) {
    const run = store.getRun(runId);
    if (!run || run.jobId !== jobId || run.postId !== postId) {
      throw audienceAiError('AUDIENCE_AI_RUN_NOT_FOUND', 'Audience AI run not found for this task and post.', { jobId, postId, runId });
    }
    return run;
  }

  #ownedRuntime(store, jobId, postId, runId) {
    const run = store.getRunRuntime(runId);
    if (!run || run.jobId !== jobId || run.postId !== postId) {
      throw audienceAiError('AUDIENCE_AI_RUN_NOT_FOUND', 'Audience AI run not found for this task and post.', { jobId, postId, runId });
    }
    return run;
  }
}

function runnerStatus(type, status, stage) {
  if (type === 'audience_ai_completed') return 'validating';
  if (type === 'audience_ai_partial') return 'partial';
  if (type === 'audience_ai_failed') return 'failed';
  if (type === 'audience_ai_cancelled') return 'cancelled';
  const candidate = String(status || stage || '');
  return [...AUDIENCE_AI_RUNNING_STATUSES, 'interrupted'].includes(candidate) ? candidate : null;
}

function publicProgress(event, run) {
  return {
    runId: run.runId,
    postId: run.postId,
    stage: String(event.stage || event.status || 'analyzing_comments'),
    completedUnits: nonNegativeNumber(event.completedUnits),
    totalUnits: nonNegativeNumber(event.totalUnits),
    commentsAnalyzed: nonNegativeNumber(event.commentsAnalyzed),
    usersAnalyzed: nonNegativeNumber(event.usersAnalyzed),
    profilesUsed: nonNegativeNumber(event.profilesUsed),
    tokenUsage: event.tokenUsage && typeof event.tokenUsage === 'object' ? event.tokenUsage : {},
    estimatedUsage: event.estimatedUsage !== false,
    updatedAt: String(event.updatedAt || new Date().toISOString()),
  };
}

function previewBlockers(snapshot, scope, estimate) {
  const blockers = [];
  if (!snapshot.originalPost.body) blockers.push({ code: 'AUDIENCE_AI_BODY_MISSING', message: 'The original post body must be collected before analysis.', blocking: true });
  if (!snapshot.comments.length) blockers.push({ code: 'AUDIENCE_AI_INPUT_EMPTY', message: 'At least one selected comment is required for analysis.', blocking: true });
  if (scope.maxEstimatedTokens && estimate.estimatedTotalTokens > scope.maxEstimatedTokens) blockers.push({ code: 'AUDIENCE_AI_ESTIMATE_EXCEEDED', message: 'Estimated token use exceeds the configured limit.', blocking: true });
  if (scope.maxEstimatedCost && estimate.estimatedCost !== null && estimate.estimatedCost > scope.maxEstimatedCost) blockers.push({ code: 'AUDIENCE_AI_ESTIMATE_EXCEEDED', message: 'Estimated cost exceeds the configured limit.', blocking: true });
  if (scope.profileMode !== 'none' && snapshot.coverage.profilesAvailable === 0) blockers.push({ code: 'AUDIENCE_AI_PROFILE_DATA_MISSING', message: 'No profile headers are currently available; analysis can continue with comment evidence.', blocking: false });
  return blockers;
}

function estimateSnapshot(snapshot, moduleCount) {
  const characters = JSON.stringify({ originalPost: snapshot.originalPost, comments: snapshot.comments, users: snapshot.users }).length;
  const estimatedInputTokens = Math.ceil(characters / 3.2);
  const estimatedOutputTokens = Math.max(1_200, Math.ceil((snapshot.comments.length * 110 + snapshot.users.length * 90) * Math.max(1, moduleCount / 4)));
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    estimatedUnits: snapshot.comments.length + snapshot.users.length + 1,
    estimatedChunks: Math.max(1, Math.ceil(snapshot.comments.length / 40)) + Math.max(1, Math.ceil(snapshot.users.length / 30)),
    estimatedCalls: Math.max(1, Math.ceil(snapshot.comments.length / 40)) + Math.max(1, Math.ceil(snapshot.users.length / 30)) + 1,
    estimatedCost: null,
    costEstimated: true,
  };
}

function estimateProfileRequests(snapshot, scope) {
  return buildAudienceProfileEnrichmentPlan(snapshot, scope)?.estimatedNetworkRequests || 0;
}

function scopeWithoutSecrets(scope) {
  const { aiSessionId: _session, idempotencyKey: _idempotency, ...publicScope } = scope;
  return publicScope;
}

function publicModel(ai) {
  return { provider: ai.provider || null, model: ai.model || null, wireApi: ai.wireApi || null };
}

function resultDescriptor(jobId, postId, run) {
  return {
    runId: run.runId,
    status: run.status,
    inputRevision: run.inputRevision,
    resultsUrl: `/api/jobs/${encodeURIComponent(jobId)}/audience/posts/${encodeURIComponent(postId)}/ai/results?runId=${encodeURIComponent(run.runId)}`,
    manifestArtifact: `audience-ai/${safeSegment(postId)}/${run.runId}/manifest.json`,
  };
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readOptionalJson(filePath) {
  try { return await readJson(filePath); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function parseJsonLines(value) {
  return value.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/api.?key|secret|authorization|token$/iu.test(key))
      .map(([key, item]) => [key, scrubSecrets(item)]));
  }
  return typeof value === 'string' ? sanitizeMessage(value) : value;
}

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/giu, '[redacted]')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/gu, '[redacted]')
    .slice(0, 2_000);
}

function stableHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function safeSegment(value) {
  return String(value || '').replace(/[^\p{L}\p{N}_.:-]+/gu, '_').slice(0, 160) || 'post';
}

function publicJobRelativePath(jobRoot, filePath) {
  const relative = path.relative(jobRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(filePath);
  return relative.split(path.sep).join('/');
}

function eventKey(jobId, postId) {
  return `${jobId}\u0000${postId}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export { AUDIENCE_AI_ARTIFACTS };
