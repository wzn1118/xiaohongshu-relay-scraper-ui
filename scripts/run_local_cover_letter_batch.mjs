import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = String(process.env.COVER_LETTER_API_BASE || 'http://127.0.0.1:4317').replace(/\/$/, '');
const JOB_ID = String(process.env.COVER_LETTER_JOB_ID || '20260804081657-caf8f451').trim();
const AI_SESSION_ID = String(process.env.COVER_LETTER_AI_SESSION_ID || '3a0eff54-e7f4-4041-b311-8318259fa8a2').trim();
const MODEL = String(process.env.COVER_LETTER_MODEL || 'qwen3.5:4b').trim();
const LOCAL_MODEL_BASE_URL = String(process.env.COVER_LETTER_LOCAL_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const RUNTIME_DIR = path.join(WORKSPACE, '.runtime', 'cover-letter-v2-live');
const DEFAULT_PROGRESS = path.join(RUNTIME_DIR, `local-batch-progress-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
const PROGRESS_PATH = String(process.env.COVER_LETTER_PROGRESS || DEFAULT_PROGRESS);
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const RETRIES = 2;
const SKIP_ALREADY_REWRITTEN = new Set(['6a7020c00000000005033be5']);
const INSTRUCTIONS = [
  '使用本地高级模型完成全量岗位定制求职信重写。',
  '主题(email_subject)与正文(cover_letter)必须分开返回，正文不得出现主题行。',
  '正文不少于800字，必须逐项回应岗位职责，并优先引用候选人简历中的真实经历、项目、组织、行动和结果；没有简历证据时只写可证实的已有材料，不编造。',
  '保留事实边界，避免通用回退文案；正文要能直接发送，使用自然中文和候选人第一人称。',
].join('\n');
let activeAiSessionId = AI_SESSION_ID;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = body?.code || body?.error?.code || '';
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function readProgress() {
  try {
    const parsed = JSON.parse(await readFile(PROGRESS_PATH, 'utf8'));
    if (parsed && parsed.jobId === JOB_ID && Array.isArray(parsed.items)) return parsed;
  } catch {
    // Start a fresh progress ledger when no usable ledger exists.
  }
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    apiBase: API_BASE,
    provider: 'local_qwen',
    model: MODEL,
    aiSessionId: AI_SESSION_ID,
    startedAt: now(),
    updatedAt: now(),
    status: 'running',
    total: 0,
    currentIndex: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
}

async function saveProgress(progress) {
  progress.completed = progress.items.filter((entry) => entry.status === 'saved').length;
  progress.skipped = progress.items.filter((entry) => entry.status === 'skipped').length;
  progress.failed = progress.items.filter((entry) => entry.status === 'failed').length;
  progress.updatedAt = now();
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

async function refreshAiSession(progress) {
  const session = await fetchJson(`${API_BASE}/api/ai/sessions`, {
    method: 'POST',
    body: JSON.stringify({
      provider: 'local_qwen',
      apiKey: '',
      model: MODEL,
      baseUrl: LOCAL_MODEL_BASE_URL,
      wireApi: 'chat_completions',
    }),
  }, 60_000);
  if (!session?.id) throw new Error('local AI session refresh returned no id');
  activeAiSessionId = String(session.id);
  progress.aiSessionId = activeAiSessionId;
  await saveProgress(progress);
}

async function loadAllResults() {
  const items = [];
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    const payload = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/results?limit=${PAGE_SIZE}&offset=${offset}`, {}, 60_000);
    const page = Array.isArray(payload?.items) ? payload.items : [];
    if (total === null) total = Number(payload?.total) || page.length;
    items.push(...page);
    if (page.length === 0) break;
    offset += page.length;
  }
  return items;
}

function itemKey(item) {
  return String(item?.note_id || item?.noteId || '').trim();
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

async function rewrite(item) {
  const noteId = itemKey(item);
  if (!noteId) throw new Error('missing note_id');
  let current = item;
  let draftVersion = current?.draftVersion;
  if (!draftVersion?.draftId || !Number.isInteger(Number(draftVersion.version))) {
    const saved = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/draft`, {
      method: 'POST',
      body: JSON.stringify({
        noteId,
        outreach: contentFor(current),
        applicationContext: current?.outreach?.applicationContext || { channel: 'email', contactStage: 'first_contact', tone: 'natural', recipientType: 'recruiter' },
      }),
    });
    draftVersion = saved?.draftVersion;
  }
  if (!draftVersion?.draftId || !Number.isInteger(Number(draftVersion.version))) {
    throw new Error('draftVersion unavailable');
  }
  const response = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/draft/rewrite`, {
    method: 'POST',
    body: JSON.stringify({
      noteId,
      aiSessionId: activeAiSessionId,
      instructions: INSTRUCTIONS,
      outreach: contentFor(current),
      applicationContext: current?.outreach?.applicationContext || { channel: 'email', contactStage: 'first_contact', tone: 'natural', recipientType: 'recruiter' },
      draftId: draftVersion.draftId,
      baseVersion: Number(draftVersion.version),
    }),
  });
  const generated = response?.outreach || {};
  return {
    noteId,
    status: 'saved',
    version: response?.draftVersion?.version ?? null,
    charCount: String(generated.cover_letter || '').replace(/\s/g, '').length,
    subject: String(generated.email_subject || ''),
    reviewScore: response?.cover_letter_evaluation?.score ?? response?.generation?.reviewScore ?? null,
    provider: response?.generation?.provider || 'local_qwen',
    model: response?.generation?.model || MODEL,
    strategy: response?.generation?.strategy || '',
  };
}

async function processOne(item) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const started = Date.now();
    try {
      const result = await rewrite(item);
      return { ...result, elapsedMs: Date.now() - started, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (error?.code === 'AI_SESSION_EXPIRED' && attempt < RETRIES) {
        await refreshAiSession(progress);
      }
      if (error?.status === 409 && attempt < RETRIES) {
        const refreshed = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/results?limit=1&offset=0`, {}, 60_000).catch(() => null);
        const refreshedItem = refreshed?.items?.find((candidate) => itemKey(candidate) === itemKey(item));
        if (refreshedItem) item = refreshedItem;
      }
      if (attempt < RETRIES && (error?.code === 'AI_SESSION_EXPIRED' || error?.status === 409 || error?.status >= 500 || error?.name === 'AbortError')) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  const error = new Error(lastError?.message || 'rewrite failed');
  error.status = lastError?.status;
  error.code = lastError?.code;
  throw error;
}

const progress = await readProgress();
progress.aiSessionId = activeAiSessionId;
const results = await loadAllResults();
progress.total = results.length;
progress.status = 'running';
await saveProgress(progress);

const prior = new Map(progress.items.map((entry) => [entry.noteId, entry]));
for (let index = 0; index < results.length; index += 1) {
  const item = results[index];
  const noteId = itemKey(item);
  progress.currentIndex = index + 1;
  if (!noteId) continue;
  const existing = prior.get(noteId);
  if (existing?.status === 'saved' || existing?.status === 'skipped') {
    continue;
  }
  if (SKIP_ALREADY_REWRITTEN.has(noteId)) {
    const entry = { noteId, status: 'skipped', reason: 'live_sample_already_rewritten', version: item?.draftVersion?.version ?? null, elapsedMs: 0 };
    progress.items = [...progress.items.filter((value) => value.noteId !== noteId), entry];
    progress.skipped += 1;
    await saveProgress(progress);
    console.log(JSON.stringify({ event: 'progress', index: index + 1, total: results.length, ...entry }));
    continue;
  }
  try {
    const entry = await processOne(item);
    progress.items = [...progress.items.filter((value) => value.noteId !== noteId), entry];
    await saveProgress(progress);
    console.log(JSON.stringify({ event: 'progress', index: index + 1, total: results.length, ...entry }));
  } catch (error) {
    const entry = { noteId, status: 'failed', error: String(error?.message || error), code: error?.code || '', httpStatus: error?.status || null };
    progress.items = [...progress.items.filter((value) => value.noteId !== noteId), entry];
    await saveProgress(progress);
    console.error(JSON.stringify({ event: 'failed', index: index + 1, total: results.length, ...entry }));
  }
}

progress.status = progress.failed > 0 ? 'partial' : 'completed';
await saveProgress(progress);
console.log(JSON.stringify({ event: 'finished', progressPath: PROGRESS_PATH, jobId: JOB_ID, total: progress.total, completed: progress.completed, skipped: progress.skipped, failed: progress.failed }));
