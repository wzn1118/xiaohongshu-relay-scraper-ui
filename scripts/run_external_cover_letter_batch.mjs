import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API_BASE = String(process.env.COVER_LETTER_API_BASE || 'http://127.0.0.1:4323').replace(/\/$/, '');
const JOB_ID = String(process.env.COVER_LETTER_JOB_ID || '20260804081657-caf8f451').trim();
const BATCH_SIZE = Math.max(1, Math.min(300, Number(process.env.COVER_LETTER_BATCH_SIZE || 300)));
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.COVER_LETTER_CONCURRENCY || 4)));
const MAX_ATTEMPTS = Math.max(1, Math.min(8, Number(process.env.COVER_LETTER_MAX_ATTEMPTS || 5)));
const LIMIT = Math.max(0, Number(process.env.COVER_LETTER_BATCH_LIMIT || 0));
const RESUME = String(process.env.COVER_LETTER_RESUME || '1') !== '0';
const PROMPT_VERSION = 'cover-letter-external-parallel-v2';
const PYTHON = process.env.COVER_LETTER_PYTHON || 'python';
const PY_SCRIPT = path.join(ROOT, 'scripts', 'rewrite_cover_letter_batch.py');
const RUNTIME_DIR = path.join(ROOT, '.runtime', 'cover-letter-v2-live');
const PROGRESS_PATH = process.env.COVER_LETTER_PROGRESS || path.join(RUNTIME_DIR, `external-batch-progress-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
const INSTRUCTIONS = [
  '使用外部高级模型批量生成岗位专属求职信。',
  '主题(email_subject)与正文(cover_letter)严格分开，正文不少于800个非空白字符。',
  '必须逐条结合岗位职责，并引用上传简历中的真实经历、行动和结果，禁止通用回退文案和任何未经材料支持的事实。',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally { clearTimeout(timer); }
}

async function loadAllResults() {
  const results = [];
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    const page = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/results?limit=100&offset=${offset}`);
    const items = Array.isArray(page?.items) ? page.items : [];
    if (total === null) total = Number(page?.total) || items.length;
    results.push(...items);
    if (!items.length) break;
    offset += items.length;
  }
  return results;
}

function contentFor(item) {
  const outreach = item?.outreach && typeof item.outreach === 'object' ? item.outreach : {};
  return {
    greeting: String(outreach.greeting || ''),
    email_subject: String(outreach.email_subject || ''),
    email_body: String(outreach.email_body || ''),
    cover_letter: String(outreach.cover_letter || ''),
  };
}

async function ensureDraftVersions(items) {
  const queue = items.filter((item) => !item?.draftVersion?.draftId || !Number.isInteger(Number(item?.draftVersion?.version)));
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const noteId = String(item.note_id || '').trim();
      const saved = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/draft`, {
        method: 'POST',
        body: JSON.stringify({ noteId, outreach: contentFor(item), applicationContext: item?.outreach?.applicationContext || { channel: 'email', contactStage: 'first_contact', tone: 'natural', recipientType: 'recruiter' } }),
      });
      item.draftVersion = saved?.draftVersion;
      if (!item.draftVersion?.draftId) throw new Error(`draftVersion unavailable for ${noteId}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, Math.max(1, queue.length)) }, () => worker()));
}

async function loadCandidateProfile(job) {
  const profileId = String(job?.config?.profileId || '').trim();
  const basic = job?.config?.candidateProfile && typeof job.config.candidateProfile === 'object' ? job.config.candidateProfile : {};
  let memory = {};
  if (profileId) {
    try { memory = JSON.parse(await readFile(path.join(ROOT, 'data', 'profiles', profileId, 'profile_memory.json'), 'utf8')); } catch { memory = {}; }
  }
  return { ...memory, ...basic, profileSnapshotId: memory.profileSnapshotId || profileId, profileId };
}

async function loadExternalConfig() {
  const configPath = path.join(ROOT, '.runtime', 'cover-letter-v2-live', 'ai-config.json');
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { config = {}; }
  const relay = config?.providers?.relay || {};
  const provider = process.env.XHS_AI_PROVIDER || 'relay';
  const apiKey = process.env.XHS_AI_API_KEY || relay.apiKey || '';
  if (!apiKey) throw new Error('external relay API key is missing; set XHS_AI_API_KEY or configure .runtime/cover-letter-v2-live/ai-config.json');
  return {
    XHS_AI_PROVIDER: provider,
    XHS_AI_API_KEY: apiKey,
    XHS_AI_BASE_URL: process.env.XHS_AI_BASE_URL || relay.baseUrl || 'https://openqi.sbs/v1',
    XHS_AI_MODEL: process.env.XHS_AI_MODEL || relay.model || 'gpt-5.6-sol',
    XHS_AI_WIRE_API: process.env.XHS_AI_WIRE_API || relay.wireApi || 'chat_completions',
    XHS_AI_TIMEOUT_SECONDS: process.env.XHS_AI_TIMEOUT_SECONDS || '1800',
    XHS_AI_MAX_OUTPUT_TOKENS: process.env.XHS_AI_MAX_OUTPUT_TOKENS || '131072',
  };
}

function invokePython(items, candidateProfile, env, batchLabel) {
  return new Promise((resolve, reject) => {
    const requestedOutputTokens = Math.min(
      Number(env.XHS_AI_MAX_OUTPUT_TOKENS || 131072),
      Math.max(6144, items.length * 1800),
    );
    const child = spawn(PYTHON, [PY_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, XHS_AI_MAX_OUTPUT_TOKENS: String(requestedOutputTokens), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let data = null;
      try { data = JSON.parse(stdout.trim()); } catch { /* surfaced below */ }
      if (!data || data.error) return reject(new Error(`${batchLabel} failed: ${data?.error || stderr.slice(-1200) || 'invalid Python JSON'}`));
      if (code && !data.generated) return reject(new Error(`${batchLabel} exited ${code}: ${stderr.slice(-1200)}`));
      resolve(data);
    });
    child.stdin.end(JSON.stringify({ items, candidateProfile, instructions: INSTRUCTIONS }));
  });
}

async function writeback(items, generated, env, runId, profileSnapshotId) {
  const byId = new Map(items.map((item) => [String(item.note_id), item]));
  const values = [];
  for (const result of generated) {
    const source = byId.get(String(result.note_id));
    if (!source?.draftVersion?.draftId) continue;
    const old = contentFor(source);
    values.push({
      noteId: String(result.note_id),
      draftId: source.draftVersion.draftId,
      baseVersion: Number(source.draftVersion.version),
      outreach: { ...old, email_subject: result.email_subject, cover_letter: result.cover_letter },
      generation: {
        runId, promptVersion: PROMPT_VERSION, model: env.XHS_AI_MODEL,
        provider: env.XHS_AI_PROVIDER, profileSnapshotId,
        usedEvidenceIds: result.used_evidence_ids || [], resumeArtifactIds: [], status: 'validated',
      },
    });
  }
  const responses = [];
  for (let index = 0; index < values.length; index += 100) {
    const chunk = values.slice(index, index + 100);
    responses.push(await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/application-generation/writeback`, {
      method: 'POST',
      body: JSON.stringify({ runId, promptVersion: PROMPT_VERSION, model: env.XHS_AI_MODEL, provider: env.XHS_AI_PROVIDER, profileSnapshotId, items: chunk }),
    }, 180_000));
  }
  return responses;
}

async function saveProgress(progress) {
  const snapshot = { ...progress, updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

let providerNotBefore = 0;
let providerFailureStreak = 0;
let providerCircuitError = null;
let progressSaveQueue = Promise.resolve();

function queueProgressSave(progress) {
  const snapshot = JSON.parse(JSON.stringify(progress));
  progressSaveQueue = progressSaveQueue.then(() => saveProgress(snapshot));
  return progressSaveQueue;
}

function retryDelay(error, attempt) {
  const message = String(error?.message || error);
  if (/HTTP 429|rate limit/i.test(message)) return Math.min(180_000, 30_000 * (2 ** (attempt - 1)));
  if (/HTTP (?:500|502|503|504)|temporarily unavailable/i.test(message)) return Math.min(60_000, 8_000 * (2 ** (attempt - 1)));
  return Math.min(30_000, 4_000 * attempt);
}

function isProviderUnavailable(error) {
  return /HTTP (?:429|500|502|503|504)|rate limit|temporarily unavailable|provider request failed/i.test(String(error?.message || error));
}

async function waitForProviderWindow() {
  const delay = providerNotBefore - Date.now();
  if (delay > 0) await sleep(delay);
}

async function generateOne(item, candidateProfile, env, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (providerCircuitError) throw providerCircuitError;
    await waitForProviderWindow();
    try {
      const response = await invokePython([item], candidateProfile, env, `${label}-attempt-${attempt}`);
      const generated = Array.isArray(response?.items) ? response.items[0] : null;
      if (!generated || String(generated.note_id) !== String(item.note_id)) {
        throw new Error('external model response failed note_id or cover-letter validation');
      }
      providerFailureStreak = 0;
      return { generated, attempt };
    } catch (error) {
      lastError = error;
      if (isProviderUnavailable(error)) {
        providerFailureStreak += 1;
        if (providerFailureStreak >= Math.min(4, CONCURRENCY)) {
          providerCircuitError = new Error(`provider circuit opened after ${providerFailureStreak} consecutive upstream failures: ${String(error?.message || error).slice(0, 600)}`);
          providerCircuitError.code = 'PROVIDER_UNAVAILABLE';
          providerCircuitError.attempt = attempt;
          throw providerCircuitError;
        }
      } else {
        providerFailureStreak = 0;
      }
      if (attempt >= MAX_ATTEMPTS) break;
      const delay = retryDelay(error, attempt);
      providerNotBefore = Math.max(providerNotBefore, Date.now() + delay);
    }
  }
  if (lastError && !lastError.attempt) lastError.attempt = MAX_ATTEMPTS;
  throw lastError || new Error(`${label} failed`);
}

async function writebackOne(item, generated, env, runId, profileSnapshotId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const responses = await writeback([item], [generated], env, runId, profileSnapshotId);
      const saved = responses.reduce((sum, response) => sum + Number(response?.saved || 0), 0);
      if (saved !== 1) throw new Error(`writeback saved ${saved} records instead of 1`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2_000 * attempt);
    }
  }
  throw lastError || new Error(`writeback failed for ${item.note_id}`);
}

async function runParallelBatch(batch, batchNumber, candidateProfile, env, runId, profileSnapshotId, progress) {
  const batchProgress = {
    label: `batch-${batchNumber}`,
    requested: batch.length,
    generated: 0,
    saved: 0,
    failed: 0,
    deferred: 0,
    items: [],
    startedAt: new Date().toISOString(),
  };
  progress.batches.push(batchProgress);
  await queueProgressSave(progress);

  let cursor = 0;
  const worker = async () => {
    while (cursor < batch.length) {
      if (providerCircuitError) break;
      const itemIndex = cursor++;
      const item = batch[itemIndex];
      const noteId = String(item.note_id || '').trim();
      const startedAt = new Date().toISOString();
      try {
        const { generated, attempt } = await generateOne(
          item,
          candidateProfile,
          env,
          `${batchProgress.label}-item-${itemIndex + 1}-${noteId}`,
        );
        batchProgress.generated += 1;
        await writebackOne(item, generated, env, runId, profileSnapshotId);
        batchProgress.saved += 1;
        progress.saved += 1;
        batchProgress.items.push({ noteId, status: 'saved', attempt, charCount: generated.char_count, startedAt, finishedAt: new Date().toISOString() });
        console.log(JSON.stringify({ event: 'item_saved', noteId, batch: batchProgress.label, saved: progress.saved, total: progress.total }));
      } catch (error) {
        const deferred = error?.code === 'PROVIDER_UNAVAILABLE' || isProviderUnavailable(error);
        if (deferred) {
          batchProgress.deferred += 1;
          batchProgress.items.push({ noteId, status: 'deferred', attempts: Number(error?.attempt || MAX_ATTEMPTS), error: String(error?.message || error).slice(0, 1200), startedAt, finishedAt: new Date().toISOString() });
          console.error(JSON.stringify({ event: 'item_deferred', noteId, batch: batchProgress.label, error: String(error?.message || error).slice(0, 500) }));
        } else {
          batchProgress.failed += 1;
          progress.failed += 1;
          batchProgress.items.push({ noteId, status: 'failed', attempts: MAX_ATTEMPTS, error: String(error?.message || error).slice(0, 1200), startedAt, finishedAt: new Date().toISOString() });
          console.error(JSON.stringify({ event: 'item_failed', noteId, batch: batchProgress.label, error: String(error?.message || error).slice(0, 500) }));
        }
      }
      await queueProgressSave(progress);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));
  const untouched = batch.slice(cursor).map((item) => String(item.note_id || '').trim()).filter(Boolean);
  batchProgress.deferred += untouched.length;
  batchProgress.pendingNoteIds = untouched;
  batchProgress.finishedAt = new Date().toISOString();
  await queueProgressSave(progress);
}

const runId = `cover-letter-external-${Date.now()}`;
const job = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}`);
let items = await loadAllResults();
if (RESUME) {
  items = items.filter((item) => ![
    'cover-letter-external-batch-v1',
    PROMPT_VERSION,
  ].includes(item?.delivery?.generation?.promptVersion));
}
if (LIMIT > 0) items = items.slice(0, LIMIT);
const candidateProfile = await loadCandidateProfile(job);
const env = await loadExternalConfig();
const profileSnapshotId = candidateProfile.profileSnapshotId || job?.config?.profileId || JOB_ID;
const progress = {
  schemaVersion: 2,
  runId,
  jobId: JOB_ID,
  apiBase: API_BASE,
  provider: env.XHS_AI_PROVIDER,
  model: env.XHS_AI_MODEL,
  promptVersion: PROMPT_VERSION,
  profileSnapshotId,
  total: items.length,
  batchSize: BATCH_SIZE,
  concurrency: CONCURRENCY,
  maxAttempts: MAX_ATTEMPTS,
  mode: 'external_parallel_requests',
  saved: 0,
  failed: 0,
  pending: items.length,
  batches: [],
  startedAt: new Date().toISOString(),
};
await saveProgress(progress);

for (let index = 0; index < items.length; index += BATCH_SIZE) {
  const batch = items.slice(index, index + BATCH_SIZE);
  await ensureDraftVersions(batch);
  await runParallelBatch(
    batch,
    Math.floor(index / BATCH_SIZE) + 1,
    candidateProfile,
    env,
    runId,
    profileSnapshotId,
    progress,
  );
  progress.pending = Math.max(0, progress.total - progress.saved - progress.failed);
  console.log(JSON.stringify({ event: 'batch_finished', batch: Math.floor(index / BATCH_SIZE) + 1, requested: batch.length, saved: progress.saved, failed: progress.failed, total: items.length, progressPath: PROGRESS_PATH }));
  if (providerCircuitError) break;
}

progress.pending = Math.max(0, progress.total - progress.saved - progress.failed);
progress.status = providerCircuitError ? 'paused_provider_unavailable' : (progress.failed ? 'partial' : 'completed');
progress.providerError = providerCircuitError ? String(providerCircuitError.message).slice(0, 1200) : '';
progress.finishedAt = new Date().toISOString();
await queueProgressSave(progress);
await progressSaveQueue;
console.log(JSON.stringify({ event: 'finished', jobId: JOB_ID, status: progress.status, total: items.length, saved: progress.saved, failed: progress.failed, pending: progress.pending, mode: progress.mode, progressPath: PROGRESS_PATH }));
