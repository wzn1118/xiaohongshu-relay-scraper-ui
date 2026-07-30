import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { buildRunnerArgs } from './lib/contracts.mjs';
import { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';

const TERMINAL = new Set(['succeeded', 'incomplete', 'failed', 'cancelled', 'interrupted']);

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
  }) {
    this.dataDir = dataDir;
    this.historyPath = path.join(dataDir, 'jobs.json');
    this.pythonBin = pythonBin;
    this.runnerPath = runnerPath;
    this.spawnImpl = spawnImpl;
    this.terminateImpl = terminateImpl;
    this.recoverImpl = recoverImpl;
    this.checkpointAnalyzerImpl = checkpointAnalyzerImpl;
    this.jobs = [];
    this.active = null;
    this.processes = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.writeQueue = Promise.resolve();
    this.aiSessions = aiSessions;
    this.profileStore = profileStore;
    this.legacyProfilePath = legacyProfilePath;
    this.runtimeContexts = new Map();
    this.liveCheckpointAnalyses = new Map();
    this.recoveryBlockers = [];
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
      const wasInFlight = job.status === 'queued' || job.status === 'running';
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
        job.error = 'Server restarted before the task finished. Checkpoint preserved; resume is available.';
        if (!cleanupConfirmed) {
          job.error += ` Orphan cleanup failed: ${job.cleanupError}`;
        }
        if (cleanupConfirmed) job.pid = null;
        changed = true;
      } else if (TERMINAL.has(job.status) && job.pid != null && cleanupConfirmed) {
        job.pid = null;
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
      job.workflowSummary = await readWorkflowSummary(job.outputDir);
      job.artifactCount = await countArtifactFiles(job.outputDir);
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

  async start(params) {
    if (this.recoveryBlockers.length > 0) {
      const error = new Error('A previous scrape process could not be cleaned up after restart. Restart cleanup must succeed before a new task can start.');
      error.code = 'JOB_RECOVERY_INCOMPLETE';
      error.jobs = this.recoveryBlockers.map((item) => item.id);
      throw error;
    }
    if (this.active) {
      const error = new Error('A scrape task is already running.');
      error.code = 'JOB_BUSY';
      error.activeJob = publicJob(this.active);
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
    let effectiveParams = params;
    if (params.resumeFromJobId) {
      const source = this.getInternal(params.resumeFromJobId);
      if (!source) {
        const error = new Error('Resume source task was not found.');
        error.code = 'RESUME_SOURCE_NOT_FOUND';
        throw error;
      }
      if (source.params?.searchSort === 'comprehensive') {
        // Legacy comprehensive checkpoints cannot prove latest-first discovery.
        // Preserve the resume relation, but rediscover cards from the live page.
        effectiveParams = Object.freeze({
          ...params,
          searchSort: 'latest',
          completeMissingOnly: false,
        });
      } else {
        await copyResumeCheckpoints(source.outputDir, outputDir);
      }
    }
    const now = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      params: effectiveParams,
      createdAt: now,
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
    };
    this.jobs.unshift(job);
    this.active = job;
    this.runtimeContexts.set(id, { ai, profilePath: runtimeProfilePath });
    await this.persist();
    queueMicrotask(() => this.#run(job));
    return publicJob(job);
  }

  async cancel(id) {
    const job = this.getInternal(id);
    if (!job) return { found: false };
    if (TERMINAL.has(job.status)) return { found: true, job: publicJob(job), changed: false };
    job.cancelRequested = true;
    const child = this.processes.get(id);
    if (child) await this.terminateImpl(child);
    this.#emit(id, 'state', publicJob(job));
    await this.persist();
    return { found: true, job: publicJob(job), changed: true };
  }

  async shutdown() {
    const job = this.active;
    if (!job || TERMINAL.has(job.status)) return { interrupted: false };
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
      job.pid = null;
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

  async #run(job) {
    const log = createWriteStream(job.logPath, { flags: 'a', encoding: 'utf8' });
    const progressBuffers = new Map();
    const append = (stream, chunk) => {
      const message = String(chunk);
      log.write(message);
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
      job.status = 'running';
      job.progress = 10;
      job.startedAt = new Date().toISOString();
      job.progressPhase = 'starting';
      job.progressLabel = '正在启动采集器并连接 Relay';
      job.progressCurrent = 0;
      job.progressTotal = 0;
      job.progressUpdatedAt = job.startedAt;
      const args = [this.runnerPath, ...buildRunnerArgs(job.params, job.outputDir)];
      const runtime = this.runtimeContexts.get(job.id) || {};
      append('system', `Starting scrape task ${job.id}\n`);
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
      job.pid = child.pid || null;
      this.processes.set(job.id, child);
      child.stdout?.on('data', (chunk) => append('stdout', chunk));
      child.stderr?.on('data', (chunk) => append('stderr', chunk));
      const completion = waitForChild(child);
      this.#emit(job.id, 'state', publicJob(job));
      await this.persist();
      const result = await completion;
      job.exitCode = result.code;
      if (job.interruptRequested) {
        job.status = 'interrupted';
        job.error = 'Server shutdown interrupted the task; resume is available from its checkpoint.';
      } else if (job.cancelRequested) {
        job.status = 'cancelled';
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
        job.error = '质量门禁发现未完整岗位；当前岗位卡与投递文案已生成，可从检查点续跑。';
        job.progressPhase = 'incomplete';
        job.progressLabel = '当前检查点已完成分析，仍有岗位正文待补全';
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
      await this.persist();
      this.#emit(job.id, 'state', publicJob(job));
      this.#emit(job.id, 'end', { status: job.status, exitCode: job.exitCode });
      log.end();
    }
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

  #emit(id, type, data) {
    this.events.emit(`job:${id}`, { type, data });
  }

  persist() {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.historyPath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.historyPath);
    });
    return this.writeQueue;
  }
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
  const resumableStatus = ['incomplete', 'interrupted', 'cancelled', 'failed'].includes(job.status)
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
    summaryRateLimit && summaryRateLimit.status === 'stopped'
      ? {
          detected: true,
          status: 'stopped',
          detectedAt: summaryRateLimit.detectedAt || null,
          recoveryAction: summaryRateLimit.recoveryAction || 'wait_then_resume',
        }
      : null
  );
  const resumeAvailable = resumableStatus && (
    Boolean(job.checkpointAvailable)
    || securityRestriction?.status === 'timed_out'
    || rateLimit?.status === 'stopped'
  );
  return {
    id: job.id,
    keyword: job.params.keyword,
    status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    message: job.error,
    pid: job.pid,
    config: job.params,
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

function updateProgressFromLog(job, message) {
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

  if (/RATE_LIMIT detected/gi.test(message)) {
    update({
      progressPhase: 'rate_limited',
      progressLabel: '平台访问频率受限，已停止新增访问并转入检查点智能补全',
      rateLimit: {
        detected: true,
        status: 'stopped',
        detectedAt: job.rateLimit?.detectedAt || new Date().toISOString(),
        recoveryAction: 'wait_then_resume',
      },
    });
  }

  for (const match of message.matchAll(/AUDIENCE_PROGRESS posts=(\d+)\/(\d+) comments=(\d+) users=(\d+) profiles=(\d+)\/(\d+) phase=(comments|profiles)/gi)) {
    const phase = match[7].toLowerCase();
    const current = phase === 'comments' ? Number(match[1]) : Number(match[5]);
    const total = phase === 'comments' ? Number(match[2]) : Number(match[6]);
    update({
      progressPhase: phase === 'comments' ? 'audience_comments' : 'audience_profiles',
      progressLabel: phase === 'comments'
        ? `正在全量采集评论与回复，已处理 ${match[1]} / ${match[2]} 篇，收集 ${match[3]} 条评论`
        : `正在补全评论者公开资料，已处理 ${match[5]} / ${match[6]} 位`,
      progressCurrent: current,
      progressTotal: total,
    });
    setProgress(Math.min(98, 88 + Math.round((current / Math.max(1, total)) * 10)));
  }
  for (const match of message.matchAll(/AUDIENCE_COMPLETE posts=(\d+)\/(\d+) comments=(\d+) users=(\d+) profiles=(\d+)\/(\d+) status=(\w+)/gi)) {
    update({
      progressPhase: match[7] === 'complete' ? 'audience_complete' : 'audience_partial',
      progressLabel: match[7] === 'complete'
        ? `评论与用户公开资料采集完成：${match[3]} 条评论，${match[4]} 位用户`
        : `评论与用户采集已保存检查点：${match[3]} 条评论，仍可续跑`,
      progressCurrent: Number(match[1]),
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

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
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

async function copyResumeCheckpoints(sourceDir, destinationDir) {
  const names = [
    'xiaohongshu_cards_discovered.json',
    'xiaohongshu_cards_latest.json',
    'xiaohongshu_notes_latest.json',
    'xiaohongshu_notes_latest.csv',
    'application_intelligence.json',
    'application_intelligence.checkpoint.json',
    'workflow-summary.json',
    'artifact-manifest.json',
    'audience-comments.json',
    'audience-users.json',
    'audience-posts.json',
    'audience-summary.json',
    'audience-failures.json',
  ];
  const required = new Set(['xiaohongshu_cards_latest.json', 'xiaohongshu_notes_latest.json']);
  let requiredCopied = 0;
  for (const name of names) {
    try {
      await copyFile(path.join(sourceDir, name), path.join(destinationDir, name));
      if (required.has(name)) requiredCopied += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (requiredCopied < required.size) {
    const error = new Error('Resume source does not contain both card and note checkpoints.');
    error.code = 'RESUME_CHECKPOINTS_MISSING';
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
