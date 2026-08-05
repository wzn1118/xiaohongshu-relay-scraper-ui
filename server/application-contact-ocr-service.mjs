import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATE_FILE = 'contact-resolution-job.json';
const REPORT_FILE = 'contact-resolution-report.json';

export class ApplicationContactOcrService {
  constructor({ config, spawnImpl = spawn } = {}) {
    this.pythonBin = config?.pythonBin || (process.platform === 'win32' ? 'python' : 'python3');
    this.scriptPath = config?.applicationContactOcrPath
      || path.join(config?.projectRoot || process.cwd(), 'scripts', 'resolve_application_contacts.py');
    this.aiConfigPath = config?.aiConfigPath
      || path.join(config?.projectRoot || process.cwd(), 'data', 'ai-config.json');
    this.timeoutSeconds = boundedInteger(config?.applicationContactOcrTimeoutSeconds, 180, 30, 600);
    this.checkpointEvery = boundedInteger(config?.applicationContactOcrCheckpointEvery, 5, 1, 50);
    this.maxAttempts = boundedInteger(config?.applicationContactOcrMaxAttempts, 2, 1, 3);
    this.concurrency = boundedInteger(config?.applicationContactOcrConcurrency, 2, 1, 8);
    this.prefetchConcurrency = boundedInteger(config?.applicationContactOcrPrefetchConcurrency, 12, 1, 32);
    this.imageBatchSize = boundedInteger(config?.applicationContactOcrImageBatchSize, 4, 1, 4);
    this.baseUrls = Array.isArray(config?.applicationContactOcrBaseUrls)
      ? [...new Set(config.applicationContactOcrBaseUrls.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 4)
      : [];
    this.model = String(config?.applicationContactOcrModel || '').trim();
    this.contextTokens = boundedInteger(config?.applicationContactOcrContextTokens, 4096, 2048, 8192);
    this.maxOutputTokens = boundedInteger(config?.applicationContactOcrMaxOutputTokens, 256, 128, 2048);
    this.keepAlive = normalizedKeepAlive(config?.applicationContactOcrKeepAlive, '60m');
    this.spawnImpl = spawnImpl;
    this.active = new Map();
  }

  async getState(outputDir) {
    const resolved = path.resolve(outputDir);
    const [state, report, artifactModifiedAt] = await Promise.all([
      readJson(path.join(resolved, STATE_FILE)),
      readJson(path.join(resolved, REPORT_FILE)),
      latestArtifactModifiedAt(resolved),
    ]);
    const active = this.active.get(resolved);
    if (!state) {
      return {
        schemaVersion: 1,
        status: active ? 'running' : 'idle',
        active: Boolean(active),
        report: report || null,
      };
    }
    const persistedRunning = ['running', 'watching'].includes(state.status) && processIsAlive(state.pid);
    const staleRunning = ['running', 'watching'].includes(state.status) && !active && !persistedRunning;
    return {
      ...state,
      status: staleRunning ? 'interrupted' : state.status,
      active: Boolean(active || persistedRunning),
      staleRunning,
      sourceAvailable: artifactModifiedAt > 0,
      sourceArtifactModifiedAt: artifactModifiedAt || null,
      sourceArtifactChanged: Boolean(
        report?.finishedAt
        && artifactModifiedAt
        && artifactModifiedAt > Date.parse(report.finishedAt),
      ),
      report: report || null,
    };
  }

  async ensureStarted(outputDir, options = {}) {
    const state = await this.getState(outputDir);
    const pending = Number(state.report?.after?.imageOcrPending ?? state.baseline?.imageOcrPending ?? 0);
    if (state.active) return { action: 'attached', state };
    if (!state.sourceAvailable) return { action: 'waiting_for_source', state };
    if (options.watch === true) return this.start(outputDir, options);
    if (
      !state.sourceArtifactChanged
      && ['completed', 'partial', 'watching'].includes(state.status)
      && pending === 0
    ) {
      return { action: 'already_complete', state };
    }
    if (!state.sourceArtifactChanged && state.status === 'partial' && options.retryPartial !== true) {
      return { action: 'manual_retry_required', state };
    }
    return this.start(outputDir, options);
  }

  async start(outputDir, {
    force = false,
    maxRecords = 0,
    noteIds = [],
    watch = false,
    pollSeconds = 2,
    watchIdleExitSeconds = 0,
  } = {}) {
    const resolved = path.resolve(outputDir);
    const current = this.active.get(resolved);
    if (current) return { action: 'attached', state: await this.getState(resolved) };
    const persisted = await this.getState(resolved);
    if (persisted.active) return { action: 'attached', state: persisted };

    const jobId = `contact-ocr-${randomUUID()}`;
    const args = [
      this.scriptPath,
      '--output-dir', resolved,
      '--ai-config', this.aiConfigPath,
      '--job-id', jobId,
      '--timeout-seconds', String(this.timeoutSeconds),
      '--checkpoint-every', String(this.checkpointEvery),
      '--max-attempts', String(this.maxAttempts),
      '--concurrency', String(this.concurrency),
      '--prefetch-concurrency', String(this.prefetchConcurrency),
      '--image-batch-size', String(this.imageBatchSize),
    ];
    for (const baseUrl of this.baseUrls) args.push('--base-url', baseUrl);
    if (watch) {
      args.push('--watch', '--poll-seconds', String(Math.max(0.5, Math.min(Number(pollSeconds) || 2, 15))));
      args.push('--watch-idle-exit-seconds', String(Math.max(0, Math.min(Number(watchIdleExitSeconds) || 0, 3600))));
    }
    const boundedMax = boundedInteger(maxRecords, 0, 0, 1000000);
    if (boundedMax > 0) args.push('--max-records', String(boundedMax));
    if (force) args.push('--force');
    for (const noteId of uniqueNoteIds(noteIds)) args.push('--note-id', noteId);

    const log = createWriteStream(path.join(resolved, 'contact-resolution.log'), { flags: 'a', encoding: 'utf8' });
    log.write(`[${new Date().toISOString()}] Starting ${jobId}\n`);
    let child;
    try {
      child = this.spawnImpl(this.pythonBin, args, {
        cwd: path.dirname(this.scriptPath),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          ...(this.model ? { XHS_APPLICATION_CONTACT_OCR_MODEL: this.model } : {}),
          XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS: String(this.contextTokens),
          XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS: String(this.maxOutputTokens),
          XHS_AI_KEEP_ALIVE: this.keepAlive,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      log.end(`[${new Date().toISOString()}] Spawn failed: ${error?.message || error}\n`);
      throw error;
    }
    const entry = { child, jobId, startedAt: new Date().toISOString() };
    this.active.set(resolved, entry);
    child.stdout?.on('data', (chunk) => log.write(chunk));
    child.stderr?.on('data', (chunk) => log.write(chunk));
    child.once('error', (error) => log.write(`\n[process error] ${error?.message || error}\n`));
    child.once('close', (code, signal) => {
      if (this.active.get(resolved) === entry) this.active.delete(resolved);
      log.end(`\n[${new Date().toISOString()}] Finished code=${code} signal=${signal || ''}\n`);
    });
    return {
      action: 'started',
      state: {
        schemaVersion: 1,
        jobId,
        status: 'starting',
        active: true,
        pid: child.pid || null,
        startedAt: entry.startedAt,
      },
    };
  }

  async stop(outputDir, reason = 'supervisor') {
    const resolved = path.resolve(outputDir);
    const entry = this.active.get(resolved);
    if (!entry) return { action: 'already_stopped' };
    entry.stopping = true;
    try {
      entry.child.kill();
    } catch {
      // The child may have exited between the active-map lookup and kill.
    }
    return { action: 'stopping', reason };
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function latestArtifactModifiedAt(outputDir) {
  const values = await Promise.all([
    'application_intelligence.checkpoint.json',
    'application_intelligence.json',
    'xiaohongshu_notes_latest.json',
    'xiaohongshu_cards_latest.json',
  ].map(async (filename) => {
    try {
      return (await stat(path.join(outputDir, filename))).mtimeMs;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }));
  return Math.max(...values, 0);
}

function processIsAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizedKeepAlive(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  return /^(?:-1|0|\d+(?:ms|s|m|h))$/.test(text) ? text : fallback;
}

function uniqueNoteIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^[\p{L}\p{N}_.:-]{1,160}$/u.test(value)))];
}
