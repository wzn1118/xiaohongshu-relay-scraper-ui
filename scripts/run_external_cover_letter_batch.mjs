import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API_BASE = String(process.env.COVER_LETTER_API_BASE || 'http://127.0.0.1:4323').replace(/\/$/, '');
const JOB_ID = String(process.env.COVER_LETTER_JOB_ID || '20260804081657-caf8f451').trim();
const BATCH_SIZE = Math.max(1, Math.min(300, Number(process.env.COVER_LETTER_BATCH_SIZE || 300)));
const FALLBACK_SIZE = Math.max(10, Math.min(100, Number(process.env.COVER_LETTER_FALLBACK_SIZE || 30)));
const LIMIT = Math.max(0, Number(process.env.COVER_LETTER_BATCH_LIMIT || 0));
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
    const child = spawn(PYTHON, [PY_SCRIPT], { cwd: ROOT, env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
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

async function invokePythonWithRetry(items, candidateProfile, env, batchLabel, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await invokePython(items, candidateProfile, env, batchLabel);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(8_000 * attempt);
    }
  }
  throw lastError || new Error(`${batchLabel} failed`);
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
        runId, promptVersion: 'cover-letter-external-batch-v1', model: env.XHS_AI_MODEL,
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
      body: JSON.stringify({ runId, promptVersion: 'cover-letter-external-batch-v1', model: env.XHS_AI_MODEL, provider: env.XHS_AI_PROVIDER, profileSnapshotId, items: chunk }),
    }, 180_000));
  }
  return responses;
}

async function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

const runId = `cover-letter-external-${Date.now()}`;
const job = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}`);
let items = await loadAllResults();
if (LIMIT > 0) items = items.slice(0, LIMIT);
await ensureDraftVersions(items);
const candidateProfile = await loadCandidateProfile(job);
const env = await loadExternalConfig();
const progress = { schemaVersion: 1, runId, jobId: JOB_ID, apiBase: API_BASE, provider: env.XHS_AI_PROVIDER, model: env.XHS_AI_MODEL, total: items.length, batchSize: BATCH_SIZE, mode: 'single_model_batch', saved: 0, failed: 0, batches: [], startedAt: new Date().toISOString() };
await saveProgress(progress);

for (let index = 0; index < items.length; index += BATCH_SIZE) {
  const batch = items.slice(index, index + BATCH_SIZE);
  const label = `batch-${Math.floor(index / BATCH_SIZE) + 1}`;
  let generated;
  try {
    generated = await invokePythonWithRetry(batch, candidateProfile, env, label, 1);
  } catch (error) {
    // A provider may reject a very large context. Retry only this batch in
    // smaller groups so the run remains resumable while the normal path is 300.
    progress.mode = 'fallback_chunks';
    const fallbackResults = [];
    for (let start = 0; start < batch.length; start += FALLBACK_SIZE) {
      const part = batch.slice(start, start + FALLBACK_SIZE);
      const partResult = await invokePythonWithRetry(part, candidateProfile, env, `${label}-fallback-${start}`, 3);
      fallbackResults.push(...(partResult.items || []));
    }
    generated = { items: fallbackResults, requested: batch.length, generated: fallbackResults.length, fallbackError: String(error?.message || error) };
  }
  const responses = await writeback(batch, generated.items || [], env, runId, candidateProfile.profileSnapshotId || job?.config?.profileId || JOB_ID);
  const saved = responses.reduce((sum, response) => sum + Number(response?.saved || 0), 0);
  const failed = (generated.items || []).length - saved;
  progress.saved += saved;
  progress.failed += Math.max(0, failed);
  progress.batches.push({ label, requested: batch.length, generated: generated.generated || 0, saved, failed: Math.max(0, failed), fallbackError: generated.fallbackError || '' });
  await saveProgress(progress);
  console.log(JSON.stringify({ event: 'batch', label, requested: batch.length, generated: generated.generated || 0, saved, total: items.length, progressPath: PROGRESS_PATH }));
}

progress.status = progress.failed ? 'partial' : 'completed';
progress.finishedAt = new Date().toISOString();
await saveProgress(progress);
console.log(JSON.stringify({ event: 'finished', jobId: JOB_ID, total: items.length, saved: progress.saved, failed: progress.failed, mode: progress.mode, progressPath: PROGRESS_PATH }));
