import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildRunnerArgs } from './lib/contracts.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export class JobManager {
  constructor({ dataDir, pythonBin, runnerPath, maxHistory = 100, spawnImpl = spawn, aiSessions, profileStore, legacyProfilePath }) {
    this.dataDir = dataDir;
    this.historyPath = path.join(dataDir, 'jobs.json');
    this.pythonBin = pythonBin;
    this.runnerPath = runnerPath;
    this.maxHistory = maxHistory;
    this.spawnImpl = spawnImpl;
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
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'interrupted';
        job.finishedAt = now;
        job.error = 'Server restarted before the task finished.';
        changed = true;
      }
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
    if (this.active) {
      const error = new Error('A scrape task is already running.');
      error.code = 'JOB_BUSY';
      error.activeJob = publicJob(this.active);
      throw error;
    }
    const id = `${timestampId()}-${crypto.randomBytes(4).toString('hex')}`;
    const ai = params.aiSessionId
      ? this.aiSessions.resolve(params.aiSessionId)
      : { provider: 'codex', apiKey: '', baseUrl: '', model: '' };
    const profilePath = params.profileId
      ? await this.profileStore.resolvePath(params.profileId)
      : this.legacyProfilePath;
    const jobDir = path.join(this.dataDir, id);
    const outputDir = path.join(jobDir, 'artifacts');
    const logPath = path.join(jobDir, 'run.log');
    await mkdir(outputDir, { recursive: true });
    if (params.resumeFromJobId) {
      const source = this.getInternal(params.resumeFromJobId);
      if (!source) {
        const error = new Error('Resume source task was not found.');
        error.code = 'RESUME_SOURCE_NOT_FOUND';
        throw error;
      }
      await copyResumeCheckpoints(source.outputDir, outputDir);
    }
    const now = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      params,
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
      workflowSummary: null,
    };
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, this.maxHistory);
    this.active = job;
    this.runtimeContexts.set(id, { ai, profilePath });
    await this.persist();
    queueMicrotask(() => this.#run(job));
    return publicJob(job);
  }

  async cancel(id) {
    const job = this.getInternal(id);
    if (!job) return { found: false };
    if (TERMINAL.has(job.status)) return { found: true, job: publicJob(job), changed: false };
    const child = this.processes.get(id);
    if (child) child.kill('SIGTERM');
    job.cancelRequested = true;
    this.#emit(id, 'state', publicJob(job));
    await this.persist();
    return { found: true, job: publicJob(job), changed: true };
  }

  subscribe(id, listener) {
    const event = `job:${id}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async #run(job) {
    const log = createWriteStream(job.logPath, { flags: 'a', encoding: 'utf8' });
    const append = (stream, chunk) => {
      const message = String(chunk);
      log.write(message);
      this.#emit(job.id, 'log', { stream, message, at: new Date().toISOString() });
      if (updateProgressFromLog(job, message)) this.#emit(job.id, 'state', publicJob(job));
    };
    try {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        append('system', `Task ${job.id} was cancelled before it started.\n`);
        return;
      }
      job.status = 'running';
      job.progress = 10;
      job.startedAt = new Date().toISOString();
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
          XHS_AI_PROVIDER: runtime.ai?.provider || 'codex',
          XHS_AI_API_KEY: runtime.ai?.apiKey || '',
          XHS_AI_BASE_URL: runtime.ai?.baseUrl || '',
          XHS_AI_MODEL: runtime.ai?.model || '',
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
      if (job.cancelRequested) {
        job.status = 'cancelled';
      } else if (result.error) {
        job.status = 'failed';
        job.error = result.error.message;
      } else if (result.code === 0) {
        job.status = 'succeeded';
        job.progress = 100;
      } else {
        job.status = 'failed';
        job.error = `Runner exited with code ${result.code ?? 'unknown'}.`;
      }
    } catch (error) {
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      job.error = String(error?.message || error);
      append('system', `${job.error}\n`);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.pid = null;
      this.processes.delete(job.id);
      this.runtimeContexts.delete(job.id);
      if (this.active?.id === job.id) this.active = null;
      log.end();
      job.workflowSummary = await readWorkflowSummary(job.outputDir);
      job.artifactCount = await countArtifactFiles(job.outputDir);
      await this.persist();
      this.#emit(job.id, 'state', publicJob(job));
      this.#emit(job.id, 'end', { status: job.status, exitCode: job.exitCode });
    }
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
  const status = job.status === 'succeeded' ? 'completed' : job.status === 'interrupted' ? 'failed' : job.status;
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
    progress: job.progress || 0,
    discoveredCount: job.discoveredCount || job.workflowSummary?.cardsDiscovered || 0,
    scrapedCount: job.scrapedCount || job.workflowSummary?.notesCollected || 0,
    workflowSummary: job.workflowSummary || null,
  };
}

function updateProgressFromLog(job, message) {
  let changed = false;
  for (const match of message.matchAll(/Collected\s+(\d+)\s+note links/gi)) {
    job.discoveredCount = Number(match[1]);
    const next = Math.max(job.progress || 0, 25);
    changed ||= next !== job.progress;
    job.progress = next;
  }
  for (const match of message.matchAll(/(?:Scraping note|Skipping existing note)\s+(\d+)\/(\d+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    job.discoveredCount = Math.max(job.discoveredCount || 0, total);
    job.scrapedCount = Math.max(job.scrapedCount || 0, current);
    const next = Math.max(job.progress || 0, Math.min(82, 25 + Math.round((current / Math.max(1, total)) * 57)));
    changed ||= next !== job.progress;
    job.progress = next;
  }
  for (const match of message.matchAll(/AGENT_STAGE\s+(\d+)\/(\d+)/gi)) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    const next = Math.max(job.progress || 0, Math.min(98, 82 + Math.round((current / Math.max(1, total)) * 16)));
    changed ||= next !== job.progress;
    job.progress = next;
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
    'xiaohongshu_cards_latest.json',
    'xiaohongshu_notes_latest.json',
    'xiaohongshu_notes_latest.csv',
  ];
  let copied = 0;
  for (const name of names) {
    try {
      await copyFile(path.join(sourceDir, name), path.join(destinationDir, name));
      copied += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (copied < 2) {
    const error = new Error('Resume source does not contain both card and note checkpoints.');
    error.code = 'RESUME_CHECKPOINTS_MISSING';
    throw error;
  }
}
