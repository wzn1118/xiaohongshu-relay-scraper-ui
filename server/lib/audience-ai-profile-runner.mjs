import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolveAudienceInputDirs, audienceAiError } from './audience-ai-input.mjs';

const EVENT_PREFIX = 'AUDIENCE_PROFILE_EVENT ';

export function createAudienceAiProfileRunner({
  manager,
  config,
  getRelayConfig = () => ({}),
  spawnImpl = spawn,
  waitIntervalMs = 1_000,
}) {
  const scriptPath = config.audienceProfileSupplementPath
    || path.join(config.projectRoot || process.cwd(), 'scripts', 'audience_profile_supplement.py');
  const pythonBin = config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3');

  return async function enrichAudienceProfiles(request) {
    const job = manager.getInternal(request.jobId);
    if (!job) {
      throw audienceAiError('AUDIENCE_AI_JOB_NOT_FOUND', 'The requested task was not found.', {
        jobId: request.jobId,
        postId: request.postId,
      });
    }
    const source = resolveAudienceInputDirs(manager, request.jobId);
    const requestPath = `${request.checkpointPath}.request.json`;
    const collectorCheckpointPath = `${request.checkpointPath}.collector.json`;
    const relayConfig = getRelayConfig() || {};
    const payload = {
      schemaVersion: 1,
      jobId: request.jobId,
      postId: request.postId,
      runId: request.runId,
      outputDir: source.primaryOutputDir,
      profileMode: request.mode,
      profileUserLimit: request.limits.userLimit,
      profilePostLimitPerUser: request.limits.postsPerUser,
      profilePostTotalLimit: request.limits.totalPosts,
      relayPort: positiveInteger(job.params?.relayPort, positiveInteger(relayConfig.port, 18800)),
      upstreamScraper: job.params?.upstreamScraper || undefined,
      gotoTimeoutMs: positiveInteger(job.params?.gotoTimeoutMs, 15_000),
      securityVerificationTimeoutSeconds: positiveInteger(job.params?.securityVerificationTimeoutSeconds, 600),
      rateLimitMaxRetries: positiveInteger(job.params?.rateLimitMaxRetries, 5),
      rateLimitInitialDelaySeconds: positiveNumber(job.params?.rateLimitInitialDelaySeconds, 15),
      rateLimitMaxDelaySeconds: positiveNumber(job.params?.rateLimitMaxDelaySeconds, 120),
      noteDelaySeconds: nonNegativeNumber(job.params?.noteDelaySeconds, 1.2),
    };
    await atomicWriteJson(requestPath, payload);

    const operation = () => runCollector({
      pythonBin,
      scriptPath,
      requestPath,
      checkpointPath: collectorCheckpointPath,
      request,
      spawnImpl,
    });

    if (typeof manager.runRelaySubtask === 'function') {
      return manager.runRelaySubtask({
        ownerId: `audience-ai:${request.jobId}:${request.postId}:${request.runId}`,
        signal: request.signal,
        waitIntervalMs,
        onWait: ({ retryAfter }) => request.onEvent?.({
          stage: 'waiting_relay',
          completedUsers: 0,
          totalUsers: request.userIds.length,
          retryAfter,
          message: 'Relay is busy with the existing collection task. This analysis remains inside the same job and will continue when Relay is available.',
        }),
      }, operation);
    }

    while (manager.active) {
      assertNotAborted(request.signal);
      await request.onEvent?.({
        stage: 'waiting_relay',
        completedUsers: 0,
        totalUsers: request.userIds.length,
        retryAfter: Math.max(1, Math.ceil(waitIntervalMs / 1_000)),
        message: 'Relay is busy with the existing collection task. Waiting without creating another job.',
      });
      await abortableDelay(waitIntervalMs, request.signal);
    }
    return operation();
  };
}

async function runCollector({ pythonBin, scriptPath, requestPath, checkpointPath, request, spawnImpl }) {
  assertNotAborted(request.signal);
  const child = spawnImpl(pythonBin, [
    scriptPath,
    '--request', requestPath,
    '--checkpoint', checkpointPath,
  ], {
    cwd: path.dirname(scriptPath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });
  let stdoutBuffer = '';
  let stderrTail = '';
  let lastEvent = null;
  let eventDeliveryError = null;
  let eventTail = Promise.resolve();
  const deliverEvent = (event) => {
    eventTail = eventTail
      .then(() => request.onEvent?.(publicCollectorEvent(event, request)))
      .catch((error) => {
        eventDeliveryError ||= error;
      });
  };
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const event = parseCollectorEvent(line);
      if (!event) continue;
      lastEvent = event;
      deliverEvent(event);
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = sanitizeMessage(`${stderrTail}${chunk}`).slice(-4_000);
  });
  const abort = () => child.kill?.();
  request.signal?.addEventListener?.('abort', abort, { once: true });
  let exit;
  try {
    exit = await childExit(child);
  } finally {
    request.signal?.removeEventListener?.('abort', abort);
  }
  if (stdoutBuffer.trim()) {
    const event = parseCollectorEvent(stdoutBuffer);
    if (event) {
      lastEvent = event;
      deliverEvent(event);
    }
  }
  await eventTail;
  if (eventDeliveryError) throw eventDeliveryError;
  if (request.signal?.aborted) {
    return { status: 'cancelled', message: 'Profile enrichment was cancelled.' };
  }

  const checkpoint = await readOptionalJson(checkpointPath);
  const status = checkpoint?.status || lastEvent?.status;
  if (exit.code === 0 && ['completed', 'partial'].includes(status)) {
    return {
      status,
      message: status === 'completed'
        ? 'Profile enrichment completed in the existing task.'
        : 'Profile enrichment was partial; existing profile data remains available.',
      checkpoint: publicCheckpoint(checkpoint),
      coverage: {
        targetUsers: nonNegativeNumber(checkpoint?.targetUserCount, request.userIds.length),
        completedUsers: nonNegativeNumber(checkpoint?.completedUserCount, 0),
        failedUsers: nonNegativeNumber(checkpoint?.failedUserCount, 0),
        profileHeadersComplete: nonNegativeNumber(checkpoint?.profileHeaderCoverage, 0),
        recentProfileUsersCovered: nonNegativeNumber(checkpoint?.recentPostCoverage, 0),
        recentProfilePostsCollected: nonNegativeNumber(checkpoint?.recentPostsCollected, 0),
      },
    };
  }
  return {
    status: 'failed',
    errorCode: 'AUDIENCE_AI_PROFILE_COLLECTION_FAILED',
    message: sanitizeMessage(lastEvent?.message || stderrTail || `Profile collector exited with code ${exit.code ?? 'unknown'}.`),
    checkpoint: publicCheckpoint(checkpoint),
  };
}

function parseCollectorEvent(line) {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(EVENT_PREFIX.length));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicCollectorEvent(event, request) {
  const rawStatus = String(event.status || '').trim();
  const stage = rawStatus === 'waiting_security_verification'
    ? 'security_verification'
    : rawStatus === 'waiting_rate_limit'
      ? 'waiting_relay'
      : rawStatus === 'collecting_profile_posts'
        ? 'collecting_profile_posts'
        : 'collecting_profile_headers';
  return {
    stage,
    completedUsers: nonNegativeNumber(event.completedUserCount ?? event.processedUsers, 0),
    totalUsers: nonNegativeNumber(event.targetUserCount, request.userIds.length),
    profilesUsed: nonNegativeNumber(event.profileHeaderCoverage, 0),
    message: sanitizeMessage(event.message || statusMessage(stage)),
    checkpoint: {
      status: rawStatus || stage,
      completedUserCount: nonNegativeNumber(event.completedUserCount, 0),
      targetUserCount: nonNegativeNumber(event.targetUserCount, request.userIds.length),
      failedUserCount: nonNegativeNumber(event.failedUserCount, 0),
      recentPostsCollected: nonNegativeNumber(event.recentPostsCollected, 0),
    },
  };
}

function statusMessage(stage) {
  if (stage === 'security_verification') return 'Platform security verification is waiting in the existing Relay browser.';
  if (stage === 'waiting_relay') return 'Profile enrichment is waiting for Relay availability.';
  if (stage === 'collecting_profile_posts') return 'Collecting the explicitly limited recent public posts.';
  return 'Collecting missing public profile headers for users from the selected post.';
}

function publicCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = [
    'schemaVersion', 'jobId', 'postId', 'runId', 'profileMode', 'status', 'targetUserCount',
    'completedUserCount', 'failedUserCount', 'recentPostsCollected', 'profileHeaderCoverage',
    'recentPostCoverage', 'startedAt', 'updatedAt', 'stopReason', 'budgets',
  ];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readOptionalJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function abortableDelay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error('Profile enrichment was cancelled.');
  error.name = 'AbortError';
  error.code = 'AUDIENCE_AI_CANCELLED';
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/(authorization|api[_-]?key|token|cookie|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 4_000);
}
