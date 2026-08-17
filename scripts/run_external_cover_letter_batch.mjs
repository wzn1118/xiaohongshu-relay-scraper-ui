import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveApplicationEmailSubject } from '../server/lib/application-email-draft.mjs';
import {
  classifyApplicationSource,
  prepareApplicationRecord,
} from '../server/lib/application-source-disposition.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED_MODEL = 'gpt-5.6-sol';
const API_BASE = String(process.env.COVER_LETTER_API_BASE || 'http://127.0.0.1:4323').replace(/\/$/, '');
const JOB_ID = String(process.env.COVER_LETTER_JOB_ID || process.env.JOB_ID || '20260804081657-caf8f451').trim();
const BATCH_SIZE = Math.max(1, Math.min(300, Number(process.env.COVER_LETTER_BATCH_SIZE || 300)));
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.COVER_LETTER_CONCURRENCY || 4)));
const API_REQUEST_SIZE = Math.max(1, Math.min(50, Number(process.env.COVER_LETTER_API_REQUEST_SIZE || 1)));
const REQUESTED_QUALITY_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.COVER_LETTER_QUALITY_CONCURRENCY || 1)));
const QUALITY_CONCURRENCY = REQUESTED_QUALITY_CONCURRENCY;
const QUALITY_MAX_ATTEMPTS = Math.max(1, Math.min(6, Number(process.env.COVER_LETTER_QUALITY_MAX_ATTEMPTS || 3)));
const MAX_ATTEMPTS = Math.max(1, Math.min(8, Number(process.env.COVER_LETTER_MAX_ATTEMPTS || 5)));
const LIMIT = Math.max(0, Number(process.env.COVER_LETTER_BATCH_LIMIT || process.env.COVER_LETTER_LIMIT || 0));
const RESUME = String(process.env.COVER_LETTER_RESUME || '1') !== '0';
const PROMPT_VERSION = 'plain-cover-local-contract-v9';
const ACCEPTED_PROMPT_VERSIONS = new Set([
  'plain-cover-local-contract-v8',
  PROMPT_VERSION,
]);
const PYTHON = process.env.COVER_LETTER_PYTHON || 'python';
const PY_SCRIPT = path.join(ROOT, 'scripts', 'rewrite_cover_letter_batch.py');
const BULK_PROMPT_PATH = process.env.COVER_LETTER_PROMPT_PATH
  || path.join(ROOT, 'scripts', 'prompts', 'cover_letter_batch_ascii_en.txt');
const RUNTIME_DIR = path.join(ROOT, '.runtime', 'cover-letter-v2-live');
const AUTH_CREDENTIAL_PATH = process.env.COVER_LETTER_AUTH_CREDENTIAL_PATH
  || path.join(ROOT, '.runtime', 'production', 'admin-credential-20260809.txt');
const PROGRESS_PATH = process.env.COVER_LETTER_PROGRESS || path.join(RUNTIME_DIR, `external-batch-progress-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
const INSTRUCTIONS = [
  'Generate complete, send-ready, role-specific outreach in Simplified Chinese.',
  'Generate greeting, email_subject, email_body, and an 800-1600 character cover letter.',
  'Use only supplied resume evidence facts and map core responsibilities to exact evidence ids.',
  'Keep TARGET_ROLE and CANDIDATE_NAME markers for verified local replacement.',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let apiCookie = '';

async function fetchJson(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiCookie ? { cookie: apiCookie } : {}),
        ...(options.headers || {}),
      },
    });
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
  // Match the profile shape returned by the server so generation and quality
  // validation hash the same candidate evidence.
  return { ...(profileId ? { id: profileId } : {}), ...memory, ...basic, ...(profileId ? { profileId } : {}) };
}

function firstText(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function candidateEvidence(candidateProfile) {
  return ['evidence_items', 'evidence', 'experiences', 'projects']
    .flatMap((key) => Array.isArray(candidateProfile?.[key]) ? candidateProfile[key] : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function verifiedRelevantExperience(candidateProfile, usedEvidenceIds = []) {
  const used = new Set((Array.isArray(usedEvidenceIds) ? usedEvidenceIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const evidence = candidateEvidence(candidateProfile);
  const ranked = [
    ...evidence.filter((item) => used.has(String(item.id || '').trim())),
    ...evidence.filter((item) => !used.has(String(item.id || '').trim())),
  ];
  const selected = ranked.find((item) => firstText(item.label, item.title, item.name, item.role));
  return firstText(selected?.label, selected?.title, selected?.name, selected?.role).slice(0, 48);
}

function subjectContext(candidateProfile, usedEvidenceIds = []) {
  const application = candidateProfile?.candidate_application
    && typeof candidateProfile.candidate_application === 'object'
    && !Array.isArray(candidateProfile.candidate_application)
    ? candidateProfile.candidate_application
    : {};
  const direct = (key, ...aliases) => firstText(
    candidateProfile?.[key],
    ...aliases.map((alias) => candidateProfile?.[alias]),
    application?.[key],
    ...aliases.map((alias) => application?.[alias]),
  );
  return {
    candidateProfile,
    candidateName: direct('name', 'candidateName'),
    school: direct('school', 'university'),
    major: direct('major', 'programme', 'program'),
    degreeYear: direct('degreeYear', 'degree_year'),
    undergraduateEducation: direct('undergraduateEducation'),
    graduateEducation: direct('graduateEducation'),
    availabilityDays: direct('availabilityDays', 'availability_days'),
    internshipDuration: direct('internshipDuration', 'internship_duration'),
    arrivalDate: direct('arrivalDate', 'availableFrom'),
    aiProductExperience: direct('aiProductExperience'),
    relevantExperience: direct('relevantExperience', 'experienceSummary')
      || verifiedRelevantExperience(candidateProfile, usedEvidenceIds),
    phone: direct('phone', 'mobile', 'phoneWeChat'),
    email: direct('email'),
  };
}

async function loadExternalConfig() {
  const configPath = path.join(ROOT, '.runtime', 'cover-letter-v2-live', 'ai-config.json');
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { config = {}; }
  const relay = config?.providers?.relay || {};
  const provider = process.env.XHS_AI_PROVIDER || 'relay';
  const apiKey = process.env.XHS_AI_API_KEY || relay.apiKey || '';
  if (!apiKey) throw new Error('external relay API key is missing; set XHS_AI_API_KEY or configure .runtime/cover-letter-v2-live/ai-config.json');
  const configuredModel = process.env.XHS_AI_MODEL || relay.model || REQUIRED_MODEL;
  if (configuredModel !== REQUIRED_MODEL) {
    throw new Error(`external batch model must be ${REQUIRED_MODEL}, received ${configuredModel}`);
  }
  return {
    XHS_AI_PROVIDER: provider,
    XHS_AI_API_KEY: apiKey,
    XHS_AI_BASE_URL: process.env.XHS_AI_BASE_URL || relay.baseUrl || 'https://openqi.sbs/v1',
    XHS_AI_MODEL: REQUIRED_MODEL,
    XHS_AI_WIRE_API: process.env.XHS_AI_WIRE_API || relay.wireApi || 'chat_completions',
    XHS_AI_TIMEOUT_SECONDS: process.env.XHS_AI_TIMEOUT_SECONDS
      || process.env.COVER_LETTER_REQUEST_TIMEOUT_SECONDS
      || '180',
    XHS_AI_MAX_OUTPUT_TOKENS: process.env.XHS_AI_MAX_OUTPUT_TOKENS || '131072',
  };
}

function invokePython(items, candidateProfile, env, batchLabel, validationFeedback = []) {
  return new Promise((resolve, reject) => {
    const requestedOutputTokens = Math.min(
      Number(env.XHS_AI_MAX_OUTPUT_TOKENS || 131072),
      Math.max(2200, items.length * 1700),
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
      if (code === 1) return reject(new Error(`${batchLabel} exited ${code}: ${stderr.slice(-1200)}`));
      resolve(data);
    });
    const feedbackItems = Array.isArray(validationFeedback)
      ? validationFeedback.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const feedback = feedbackItems.length
      ? `\nThe previous draft failed strict validation. Rewrite every field and correct every issue below without repeating the rejected wording:\n${feedbackItems.map((value) => `- ${value}`).join('\n')}`
      : '';
    child.stdin.end(JSON.stringify({
      items,
      candidateProfile,
      instructions: `${INSTRUCTIONS}${feedback}`,
      promptPath: BULK_PROMPT_PATH,
    }));
  });
}

async function createQualityAiSession(env) {
  const session = await fetchJson(`${API_BASE}/api/ai/sessions`, {
    method: 'POST',
    body: JSON.stringify({
      provider: env.XHS_AI_PROVIDER,
      apiKey: env.XHS_AI_API_KEY,
      baseUrl: env.XHS_AI_BASE_URL,
      model: env.XHS_AI_MODEL,
      wireApi: env.XHS_AI_WIRE_API,
    }),
  });
  const sessionId = String(session?.id || '').trim();
  if (!sessionId) throw new Error('quality AI session could not be created');
  return sessionId;
}

function createQualityAiSessionManager(env) {
  let currentId = '';
  let refreshPromise = null;
  let refreshCount = 0;

  const get = async () => {
    if (currentId) return currentId;
    if (!refreshPromise) {
      refreshPromise = createQualityAiSession(env)
        .then((sessionId) => {
          currentId = sessionId;
          return sessionId;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };

  const refresh = async (staleId) => {
    if (currentId && currentId !== staleId) return currentId;
    if (currentId === staleId) {
      currentId = '';
      refreshCount += 1;
    }
    return get();
  };

  return {
    get,
    refresh,
    get refreshCount() { return refreshCount; },
  };
}

async function probeQualityAiSession(sessionId) {
  const startedAt = Date.now();
  const probe = await fetchJson(`${API_BASE}/api/ai/sessions/${encodeURIComponent(sessionId)}/probe`, {
    method: 'POST',
    body: '{}',
  }, 180_000);
  return {
    ok: probe?.ok === true,
    provider: String(probe?.provider || ''),
    model: String(probe?.model || ''),
    latencyMs: Number(probe?.latencyMs) || (Date.now() - startedAt),
    checkedAt: new Date().toISOString(),
  };
}

function credentialValue(text, label) {
  const match = String(text || '').match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'imu'));
  return String(match?.[1] || '').trim();
}

async function authenticateApi() {
  const me = await fetchJson(`${API_BASE}/api/auth/me`);
  if (!me?.required || me?.authenticated) return;
  let credentialText = '';
  try { credentialText = await readFile(AUTH_CREDENTIAL_PATH, 'utf8'); } catch { credentialText = ''; }
  const email = String(process.env.COVER_LETTER_AUTH_EMAIL || credentialValue(credentialText, 'Email')).trim();
  const password = String(process.env.COVER_LETTER_AUTH_PASSWORD || credentialValue(credentialText, 'Password')).trim();
  if (!email || !password) {
    throw new Error('API authentication is required; configure COVER_LETTER_AUTH_EMAIL and COVER_LETTER_AUTH_PASSWORD');
  }
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.authenticated) throw new Error(body?.message || `API login failed with HTTP ${response.status}`);
  apiCookie = String(response.headers.get('set-cookie') || '').split(';', 1)[0].trim();
  if (!apiCookie) throw new Error('API login succeeded without a session cookie');
}

async function writeback(items, generated, candidateProfile, env, runId, profileSnapshotId) {
  const byId = new Map(items.map((item) => [String(item.note_id), item]));
  const values = [];
  for (const result of generated) {
    const source = byId.get(String(result.note_id));
    if (!source?.draftVersion?.draftId) continue;
    const subjectValues = subjectContext(candidateProfile, result.used_evidence_ids);
    const subjectResolution = resolveApplicationEmailSubject(source, result.email_subject, subjectValues);
    if (!subjectResolution.subject || subjectResolution.missingFields.length > 0) {
      throw new Error(`email subject could not satisfy the source rule for ${result.note_id}: ${subjectResolution.missingFields.join(', ') || 'empty subject'}`);
    }
    values.push({
      noteId: String(result.note_id),
      draftId: source.draftVersion.draftId,
      baseVersion: Number(source.draftVersion.version),
      outreach: {
        greeting: result.greeting,
        email_subject: subjectResolution.subject,
        email_body: result.email_body,
        cover_letter: result.cover_letter,
        ...subjectValues,
      },
      generation: {
        runId, promptVersion: PROMPT_VERSION, model: env.XHS_AI_MODEL,
        provider: env.XHS_AI_PROVIDER, profileSnapshotId,
        targetRole: String(source?.job_card?.role_name || '').trim(),
        usedEvidenceIds: result.used_evidence_ids || [],
        capabilityMatches: result.capability_matches || [],
        sourceHash: result.source_hash || '',
        resumeArtifactIds: [], status: 'validated',
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
let deliveryStateMutationQueue = Promise.resolve();
let baselineQualityPassedIds = new Set();
const qualityPassedThisRunIds = new Set();

function currentQualityPassedCount() {
  return new Set([...baselineQualityPassedIds, ...qualityPassedThisRunIds]).size;
}

function queueProgressSave(progress) {
  const snapshot = JSON.parse(JSON.stringify(progress));
  progressSaveQueue = progressSaveQueue.then(() => saveProgress(snapshot));
  return progressSaveQueue;
}

function withDeliveryStateMutationLock(operation) {
  const current = deliveryStateMutationQueue.then(operation, operation);
  deliveryStateMutationQueue = current.catch(() => {});
  return current;
}

function retryDelay(error, attempt) {
  const message = String(error?.message || error);
  if (/HTTP 429|rate limit/i.test(message)) return Math.min(180_000, 30_000 * (2 ** (attempt - 1)));
  if (/HTTP (?:500|502|503|504)|temporarily unavailable/i.test(message)) return Math.min(60_000, 8_000 * (2 ** (attempt - 1)));
  return Math.min(30_000, 4_000 * attempt);
}

function responseErrorCode(error) {
  return String(error?.body?.code || error?.body?.error?.code || error?.code || '').trim();
}

function isLocalDeliveryContention(error) {
  const code = responseErrorCode(error);
  return code === 'APPLICATION_DELIVERY_LOCK_TIMEOUT'
    || code === 'DRAFT_PEER_CORPUS_CHANGED'
    || /Timed out waiting for this Job delivery workspace lock|Another saved application email changed/iu.test(String(error?.message || error));
}

function isQualityArtifactUnavailable(error) {
  return responseErrorCode(error) === 'ARTIFACT_NOT_FOUND'
    || (Number(error?.status) === 404 && /artifact not found/iu.test(String(error?.message || error)));
}

function isProviderUnavailable(error) {
  if (isLocalDeliveryContention(error)) return false;
  return /HTTP (?:408|425|429|500|502|503|504)|rate limit|temporarily unavailable|provider request failed|timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network error|AbortError|暂时不可用|推理超时|无法访问推理服务|请求过于频繁|额度不足/iu.test(String(error?.message || error));
}

function isMissingQualityAiSession(error) {
  return responseErrorCode(error) === 'AI_SESSION_NOT_FOUND'
    || /AI session is missing or expired|quality AI session.*(?:missing|expired)/iu.test(String(error?.message || error));
}

async function waitForProviderWindow() {
  const delay = providerNotBefore - Date.now();
  if (delay > 0) await sleep(delay);
}

async function generateOne(item, candidateProfile, env, label, initialFeedback = []) {
  let lastError;
  let validationFeedback = Array.isArray(initialFeedback) ? [...initialFeedback].slice(0, 12) : [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (providerCircuitError) throw providerCircuitError;
    await waitForProviderWindow();
    try {
      const response = await invokePython(
        [item],
        candidateProfile,
        env,
        `${label}-attempt-${attempt}`,
        validationFeedback,
      );
      const generated = Array.isArray(response?.items) ? response.items[0] : null;
      if (!generated || String(generated.note_id) !== String(item.note_id)) {
        validationFeedback = Array.isArray(response?.rejected)
          ? response.rejected.flatMap((entry) => Array.isArray(entry?.problems) ? entry.problems : []).slice(0, 12)
          : [];
        const detail = validationFeedback.length ? `: ${validationFeedback.join('；')}` : '';
        throw new Error(`model response failed the complete outreach quality contract${detail}`);
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

async function writebackOne(item, generated, candidateProfile, env, runId, profileSnapshotId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const responses = await writeback([item], [generated], candidateProfile, env, runId, profileSnapshotId);
      const saved = responses.reduce((sum, response) => sum + Number(response?.saved || 0), 0);
      const result = responses.flatMap((response) => response?.items || [])
        .find((entry) => String(entry?.noteId) === String(item.note_id));
      if (result?.status === 'writeback_conflict' && Number.isInteger(Number(result?.error?.currentVersion))) {
        item.draftVersion = {
          ...item.draftVersion,
          version: Number(result.error.currentVersion),
        };
        const conflict = new Error(result?.error?.message || `draft version changed for ${item.note_id}`);
        conflict.code = 'DRAFT_VERSION_CONFLICT';
        throw conflict;
      }
      if (saved !== 1 || result?.status !== 'saved') {
        throw new Error(result?.error?.message || `writeback saved ${saved} records instead of 1`);
      }
      if (!result?.draftVersion?.draftId) throw new Error(`writeback did not return a draft version for ${item.note_id}`);
      item.draftVersion = result.draftVersion;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2_000 * attempt);
    }
  }
  throw lastError || new Error(`writeback failed for ${item.note_id}`);
}

function qualityFeedback(evaluation) {
  return [...new Set([
    ...(Array.isArray(evaluation?.problems) ? evaluation.problems : []),
    ...(Array.isArray(evaluation?.rewrite_instructions) ? evaluation.rewrite_instructions : []),
  ].map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 12);
}

async function checkQuality(item, qualityAiSessions) {
  const version = item?.draftVersion;
  if (!version?.draftId || !Number.isInteger(Number(version?.version))) {
    throw new Error(`quality check requires a stored draft version for ${item?.note_id || 'unknown item'}`);
  }
  let aiSessionId = await qualityAiSessions.get();
  let sessionRefreshAttempts = 0;
  for (let conflictAttempt = 1; conflictAttempt <= 12; conflictAttempt += 1) {
    try {
      const checked = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}/draft/quality`, {
        method: 'POST',
        body: JSON.stringify({
          noteId: String(item.note_id),
          draftId: version.draftId,
          version: Number(version.version),
          aiSessionId,
          evaluationMode: 'deterministic_strict',
        }),
      }, 720_000);
      providerFailureStreak = 0;
      return checked;
    } catch (error) {
      if (isMissingQualityAiSession(error) && sessionRefreshAttempts < 2) {
        sessionRefreshAttempts += 1;
        aiSessionId = await qualityAiSessions.refresh(aiSessionId);
        console.log(JSON.stringify({
          event: 'quality_session_refreshed',
          noteId: String(item.note_id),
          refreshCount: qualityAiSessions.refreshCount,
        }));
        continue;
      }
      const localContention = isLocalDeliveryContention(error);
      if (localContention && conflictAttempt < 12) {
        providerFailureStreak = 0;
        await sleep(Math.min(15_000, 1_000 * conflictAttempt));
        continue;
      }
      if (isQualityArtifactUnavailable(error) && conflictAttempt < 12) {
        providerFailureStreak = 0;
        await sleep(Math.min(10_000, 750 * conflictAttempt));
        continue;
      }
      if (isProviderUnavailable(error)) {
        providerFailureStreak += 1;
        if (providerFailureStreak >= 3) {
          providerCircuitError = new Error(`provider circuit opened during quality checks after ${providerFailureStreak} consecutive upstream failures: ${String(error?.message || error).slice(0, 600)}`);
          providerCircuitError.code = 'PROVIDER_UNAVAILABLE';
          providerCircuitError.cause = error;
          throw providerCircuitError;
        }
      } else {
        providerFailureStreak = 0;
      }
      throw error;
    }
  }
  throw new Error(`quality check conflict retry exhausted for ${item?.note_id || 'unknown item'}`);
}

async function ensureQualityPass(item, generated, candidateProfile, env, runId, profileSnapshotId, qualityAiSessions, label) {
  let current = generated;
  let feedback = [];
  for (let attempt = 1; attempt <= QUALITY_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const regenerated = await generateOne(item, candidateProfile, env, `${label}-quality-rewrite-${attempt}`, feedback);
      current = regenerated.generated;
      await writebackOne(item, current, candidateProfile, env, runId, profileSnapshotId);
    }
    const checked = await checkQuality(item, qualityAiSessions);
    const evaluation = checked?.cover_letter_evaluation || {};
    if (evaluation?.passed === true && Number(evaluation?.score) >= Number(evaluation?.threshold || 90)) {
      return { generated: current, evaluation, qualityAttempt: attempt };
    }
    feedback = qualityFeedback(evaluation);
    if (!feedback.length) feedback = [`质量评分 ${Number(evaluation?.score) || 0} 未达到 ${Number(evaluation?.threshold) || 90} 分`];
  }
  const error = new Error(`quality gate did not pass after ${QUALITY_MAX_ATTEMPTS} attempts: ${feedback.join('；')}`);
  error.code = 'QUALITY_GATE_FAILED';
  error.feedback = feedback;
  throw error;
}

async function generateBulkChunk(items, candidateProfile, env, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (providerCircuitError) throw providerCircuitError;
    await waitForProviderWindow();
    try {
      const response = await invokePython(items, candidateProfile, env, `${label}-bulk-attempt-${attempt}`);
      const generatedById = new Map(
        (Array.isArray(response?.items) ? response.items : [])
          .map((item) => [String(item?.note_id || ''), item])
          .filter(([noteId]) => noteId),
      );
      const rejectedById = new Map(
        (Array.isArray(response?.rejected) ? response.rejected : [])
          .map((item) => [String(item?.note_id || ''), Array.isArray(item?.problems) ? item.problems : []]),
      );
      const missing = items.filter((item) => !generatedById.has(String(item.note_id)));
      providerFailureStreak = 0;
      if (missing.length) {
        let cursor = 0;
        const worker = async () => {
          while (cursor < missing.length) {
            const item = missing[cursor++];
            const noteId = String(item.note_id);
            const fallback = await generateOne(
              item,
              candidateProfile,
              env,
              `${label}-fallback-${noteId}`,
              rejectedById.get(noteId) || [],
            );
            generatedById.set(noteId, fallback.generated);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));
      }
      const generated = items.map((item) => generatedById.get(String(item.note_id))).filter(Boolean);
      if (generated.length !== items.length) throw new Error(`bulk generation returned ${generated.length}/${items.length} complete items`);
      return { generated, attempt, bulkGenerated: items.length - missing.length, fallbackGenerated: missing.length };
    } catch (error) {
      lastError = error;
      if (isProviderUnavailable(error)) {
        providerFailureStreak += 1;
        if (providerFailureStreak >= 3) {
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
  throw lastError || new Error(`${label} bulk generation failed`);
}

async function runParallelBatch(batch, batchNumber, candidateProfile, env, runId, profileSnapshotId, qualityAiSessions, progress) {
  const batchProgress = {
    label: `batch-${batchNumber}`,
    requested: batch.length,
    generated: 0,
    saved: 0,
    qualityPassed: 0,
    failed: 0,
    deferred: 0,
    items: [],
    startedAt: new Date().toISOString(),
  };
  progress.batches.push(batchProgress);
  await queueProgressSave(progress);

  const qualityQueue = [];
  let generationCursor = 0;
  const generationWorker = async () => {
    while (generationCursor < batch.length) {
      if (providerCircuitError) break;
      const chunkStart = generationCursor;
      const chunk = batch.slice(chunkStart, chunkStart + API_REQUEST_SIZE);
      generationCursor += chunk.length;
      const startedAt = new Date().toISOString();
      try {
        const generatedResult = await generateBulkChunk(
          chunk,
          candidateProfile,
          env,
          `${batchProgress.label}-items-${chunkStart + 1}-${chunkStart + chunk.length}`,
        );
        batchProgress.generated += generatedResult.generated.length;
        progress.generated += generatedResult.generated.length;

        const responses = await withDeliveryStateMutationLock(() => writeback(
          chunk,
          generatedResult.generated,
          candidateProfile,
          env,
          runId,
          profileSnapshotId,
        ));
        const writeResults = responses.flatMap((response) => Array.isArray(response?.items) ? response.items : []);
        const writeResultById = new Map(writeResults.map((result) => [String(result?.noteId || ''), result]));
        const generatedById = new Map(generatedResult.generated.map((item) => [String(item.note_id), item]));
        for (const item of chunk) {
          const noteId = String(item.note_id || '');
          let result = writeResultById.get(noteId);
          const generated = generatedById.get(noteId);
          if (result?.status === 'writeback_conflict' && item && generated) {
            if (Number.isInteger(Number(result?.error?.currentVersion))) {
              item.draftVersion = {
                ...item.draftVersion,
                version: Number(result.error.currentVersion),
              };
            }
            try {
              result = await withDeliveryStateMutationLock(() => writebackOne(
                item,
                generated,
                candidateProfile,
                env,
                runId,
                profileSnapshotId,
              ));
            } catch (error) {
              result = {
                noteId,
                status: 'writeback_failed',
                error: { message: String(error?.message || error) },
              };
            }
          }
          if (result?.status === 'saved' && item && generated && result?.draftVersion?.draftId) {
            item.draftVersion = result.draftVersion;
            baselineQualityPassedIds.delete(noteId);
            qualityPassedThisRunIds.delete(noteId);
            batchProgress.saved += 1;
            progress.saved += 1;
            qualityQueue.push({
              item,
              generated,
              startedAt,
              bulkAttempt: generatedResult.attempt,
            });
          } else if (item) {
            batchProgress.failed += 1;
            progress.failed += 1;
            batchProgress.items.push({
              noteId,
              status: 'writeback_failed',
              error: String(result?.error?.message || result?.status || 'writeback result missing').slice(0, 1200),
              startedAt,
              finishedAt: new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        const deferred = error?.code === 'PROVIDER_UNAVAILABLE' || isProviderUnavailable(error);
        for (const item of chunk) {
          const noteId = String(item.note_id || '').trim();
          if (deferred) {
            batchProgress.deferred += 1;
            progress.deferred += 1;
          }
          else {
            batchProgress.failed += 1;
            progress.failed += 1;
          }
          batchProgress.items.push({ noteId, status: deferred ? 'deferred' : 'failed', attempts: Number(error?.attempt || MAX_ATTEMPTS), error: String(error?.message || error).slice(0, 1200), startedAt, finishedAt: new Date().toISOString() });
          console.error(JSON.stringify({ event: deferred ? 'item_deferred' : 'item_failed', noteId, batch: batchProgress.label, error: String(error?.message || error).slice(0, 500) }));
        }
      }
      await queueProgressSave(progress);
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(CONCURRENCY, Math.ceil(batch.length / API_REQUEST_SIZE)) },
    () => generationWorker(),
  ));
  const untouched = batch.slice(generationCursor).map((item) => String(item.note_id || '').trim()).filter(Boolean);
  batchProgress.deferred += untouched.length;
  progress.deferred += untouched.length;
  batchProgress.pendingNoteIds = untouched;
  console.log(JSON.stringify({
    event: 'batch_generation_finished',
    batch: batchProgress.label,
    generated: batchProgress.generated,
    saved: batchProgress.saved,
    queuedForQuality: qualityQueue.length,
  }));
  await queueProgressSave(progress);

  let qualityCursor = 0;
  const qualityWorker = async () => {
    while (qualityCursor < qualityQueue.length) {
      const pair = qualityQueue[qualityCursor++];
      const noteId = String(pair.item.note_id);
      try {
        // The API evaluates outside its per-job state lock and serializes only
        // the final persisted mutation, so independent quality checks may run in parallel.
        const passed = await ensureQualityPass(
          pair.item,
          pair.generated,
          candidateProfile,
          env,
          runId,
          profileSnapshotId,
          qualityAiSessions,
          `${batchProgress.label}-${noteId}`,
        );
        batchProgress.qualityPassed += 1;
        progress.qualityPassed += 1;
        qualityPassedThisRunIds.add(noteId);
        batchProgress.items.push({
          noteId,
          status: 'quality_passed',
          bulkAttempt: pair.bulkAttempt,
          qualityAttempt: passed.qualityAttempt,
          score: Number(passed.evaluation?.score) || 0,
          threshold: Number(passed.evaluation?.threshold) || 90,
          greetingChars: String(passed.generated.greeting || '').length,
          emailChars: String(passed.generated.email_body || '').length,
          coverLetterChars: passed.generated.char_count,
          capabilityMatchCount: Array.isArray(passed.generated.capability_matches) ? passed.generated.capability_matches.length : 0,
          startedAt: pair.startedAt,
          finishedAt: new Date().toISOString(),
        });
        console.log(JSON.stringify({ event: 'quality_passed', noteId, batch: batchProgress.label, qualityPassed: progress.qualityPassed, total: progress.total }));
      } catch (error) {
        const deferred = error?.code === 'PROVIDER_UNAVAILABLE' || isProviderUnavailable(error);
        if (deferred) {
          batchProgress.deferred += 1;
          progress.deferred += 1;
          batchProgress.items.push({ noteId, status: 'deferred', error: String(error?.message || error).slice(0, 1200), startedAt: pair.startedAt, finishedAt: new Date().toISOString() });
        } else {
          batchProgress.failed += 1;
          progress.failed += 1;
          batchProgress.items.push({ noteId, status: 'quality_failed', error: String(error?.message || error).slice(0, 1200), startedAt: pair.startedAt, finishedAt: new Date().toISOString() });
        }
        console.error(JSON.stringify({ event: deferred ? 'item_deferred' : 'quality_failed', noteId, batch: batchProgress.label, error: String(error?.message || error).slice(0, 500) }));
      }
      await queueProgressSave(progress);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(QUALITY_CONCURRENCY, qualityQueue.length) },
    () => qualityWorker(),
  ));
  batchProgress.finishedAt = new Date().toISOString();
  await queueProgressSave(progress);
}

function isCurrentQualityPass(item) {
  return ACCEPTED_PROMPT_VERSIONS.has(item?.delivery?.generation?.promptVersion)
    && item?.draftVersion?.qualityStatus === 'passed';
}

const runId = `cover-letter-external-${Date.now()}`;
await authenticateApi();
const job = await fetchJson(`${API_BASE}/api/jobs/${encodeURIComponent(JOB_ID)}`);
const allItems = await loadAllResults();
const candidateProfile = await loadCandidateProfile(job);
baselineQualityPassedIds = new Set(
  allItems.filter(isCurrentQualityPass).map((item) => String(item?.note_id || '')).filter(Boolean),
);
const alreadyQualityPassed = baselineQualityPassedIds.size;
const sourceDispositions = allItems.map((item) => ({
  item,
  disposition: classifyApplicationSource(item),
}));
const sourceBlocked = sourceDispositions
  .filter(({ item, disposition }) => !isCurrentQualityPass(item) && disposition.status !== 'sendable')
  .map(({ item, disposition }) => ({
    noteId: String(item?.note_id || ''),
    title: String(item?.title || ''),
    status: disposition.status,
    reasonCode: disposition.reasonCode,
    reason: disposition.reason,
  }));
const subjectValues = subjectContext(candidateProfile, []);
const sendableItems = sourceDispositions
  .filter(({ item, disposition }) => disposition.status === 'sendable' && (!RESUME || !isCurrentQualityPass(item)))
  .map(({ item, disposition }) => prepareApplicationRecord(item, disposition));
let items = [];
if (!subjectValues.candidateName) {
  for (const item of sendableItems) {
    sourceBlocked.push({
      noteId: String(item?.note_id || ''),
      title: String(item?.title || ''),
      status: 'needs_profile_data',
      reasonCode: 'CANDIDATE_NAME_MISSING',
      reason: '任务未绑定包含候选人姓名的档案，无法生成可验证、可发送的邮件正文和求职信。',
      missingFields: ['candidateName'],
    });
  }
} else {
  for (const item of sendableItems) {
    const subjectResolution = resolveApplicationEmailSubject(item, '', subjectValues);
    if (subjectResolution.missingFields.length > 0) {
      sourceBlocked.push({
        noteId: String(item?.note_id || ''),
        title: String(item?.title || ''),
        status: 'needs_profile_data',
        reasonCode: 'SUBJECT_REQUIRED_FIELDS_MISSING',
        reason: `投递主题要求候选人资料字段：${subjectResolution.missingFields.join('、')}`,
        missingFields: subjectResolution.missingFields,
      });
    } else {
      items.push(item);
    }
  }
}
if (LIMIT > 0) items = items.slice(0, LIMIT);
const env = await loadExternalConfig();
const qualityAiSessions = createQualityAiSessionManager(env);
const qualityAiSessionId = items.length ? await qualityAiSessions.get() : '';
const profileSnapshotId = job?.config?.profileId || JOB_ID;
const progress = {
  schemaVersion: 4,
  runId,
  jobId: JOB_ID,
  apiBase: API_BASE,
  provider: env.XHS_AI_PROVIDER,
  model: env.XHS_AI_MODEL,
  promptVersion: PROMPT_VERSION,
  profileSnapshotId,
  sourceTotal: allItems.length,
  alreadyQualityPassed,
  sourceBlockedCount: sourceBlocked.length,
  sourceBlocked,
  total: items.length,
  batchSize: BATCH_SIZE,
  concurrency: CONCURRENCY,
  apiRequestSize: API_REQUEST_SIZE,
  qualityConcurrency: QUALITY_CONCURRENCY,
  requestedQualityConcurrency: REQUESTED_QUALITY_CONCURRENCY,
  qualityMaxAttempts: QUALITY_MAX_ATTEMPTS,
  maxAttempts: MAX_ATTEMPTS,
  mode: 'external_bulk_quality_closed_loop',
  generated: 0,
  saved: 0,
  qualityPassed: 0,
  deferred: 0,
  failed: 0,
  pending: items.length,
  batches: [],
  startedAt: new Date().toISOString(),
};

if (items.length === 0) {
  progress.providerProbe = {
    ok: true,
    skipped: true,
    reason: 'no_pending_items',
    model: env.XHS_AI_MODEL,
    checkedAt: new Date().toISOString(),
  };
} else {
  try {
    progress.providerProbe = await probeQualityAiSession(qualityAiSessionId);
    if (!progress.providerProbe.ok) throw new Error('real model probe returned no usable output');
  } catch (error) {
    if (!isProviderUnavailable(error)) throw error;
    providerCircuitError = new Error(`provider preflight probe failed: ${String(error?.message || error).slice(0, 900)}`);
    providerCircuitError.code = 'PROVIDER_UNAVAILABLE';
    progress.providerProbe = {
      ok: false,
      model: env.XHS_AI_MODEL,
      error: String(error?.message || error).slice(0, 900),
      checkedAt: new Date().toISOString(),
    };
  }
}
await saveProgress(progress);

for (let index = 0; !providerCircuitError && index < items.length; index += BATCH_SIZE) {
  const batch = items.slice(index, index + BATCH_SIZE);
  await ensureDraftVersions(batch);
  await runParallelBatch(
    batch,
    Math.floor(index / BATCH_SIZE) + 1,
    candidateProfile,
    env,
    runId,
    profileSnapshotId,
    qualityAiSessions,
    progress,
  );
  progress.qualitySessionRefreshes = qualityAiSessions.refreshCount;
  progress.pending = Math.max(0, progress.total - progress.qualityPassed - progress.failed - progress.deferred);
  progress.overallQualityPassed = currentQualityPassedCount();
  progress.overallResolved = progress.overallQualityPassed + progress.sourceBlockedCount;
  console.log(JSON.stringify({ event: 'batch_finished', batch: Math.floor(index / BATCH_SIZE) + 1, requested: batch.length, generated: progress.generated, saved: progress.saved, qualityPassed: progress.qualityPassed, deferred: progress.deferred, failed: progress.failed, total: items.length, progressPath: PROGRESS_PATH }));
  if (providerCircuitError) break;
}

progress.pending = Math.max(0, progress.total - progress.qualityPassed - progress.failed - progress.deferred);
progress.overallQualityPassed = currentQualityPassedCount();
progress.overallResolved = progress.overallQualityPassed + progress.sourceBlockedCount;
progress.status = providerCircuitError
  ? 'paused_provider_unavailable'
  : (progress.pending > 0 || progress.failed > 0 ? 'partial' : 'completed');
progress.providerError = providerCircuitError ? String(providerCircuitError.message).slice(0, 1200) : '';
progress.finishedAt = new Date().toISOString();
await queueProgressSave(progress);
await progressSaveQueue;
console.log(JSON.stringify({ event: 'finished', jobId: JOB_ID, status: progress.status, sourceTotal: progress.sourceTotal, alreadyQualityPassed: progress.alreadyQualityPassed, sourceBlockedCount: progress.sourceBlockedCount, total: items.length, generated: progress.generated, saved: progress.saved, qualityPassed: progress.qualityPassed, overallQualityPassed: progress.overallQualityPassed, overallResolved: progress.overallResolved, deferred: progress.deferred, failed: progress.failed, pending: progress.pending, mode: progress.mode, progressPath: PROGRESS_PATH }));
