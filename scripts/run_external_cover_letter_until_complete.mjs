import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = path.join(ROOT, 'scripts', 'run_external_cover_letter_batch.mjs');
const RUNTIME_DIR = path.join(ROOT, '.runtime', 'cover-letter-v2-live');
const PROGRESS_PATH = process.env.COVER_LETTER_PROGRESS
  || path.join(RUNTIME_DIR, 'external-batch-until-complete.json');
const RETRY_INTERVAL_MS = Math.max(
  5_000,
  Math.min(3_600_000, Number(process.env.COVER_LETTER_AUTO_RESUME_INTERVAL_MS || 120_000)),
);
const PARTIAL_RETRY_INTERVAL_MS = Math.max(
  1_000,
  Math.min(300_000, Number(process.env.COVER_LETTER_PARTIAL_RETRY_INTERVAL_MS || 5_000)),
);
const MAX_RECOVERY_CYCLES = Math.max(0, Number(process.env.COVER_LETTER_AUTO_RESUME_MAX_CYCLES || 0));
const MAX_NO_PROGRESS_CYCLES = Math.max(
  1,
  Number(process.env.COVER_LETTER_MAX_NO_PROGRESS_CYCLES || 6),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readProgress() {
  try {
    return JSON.parse(await readFile(PROGRESS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function writeProgress(progress) {
  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeFile(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

function runBatch() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: ROOT,
      env: {
        ...process.env,
        COVER_LETTER_PROGRESS: PROGRESS_PATH,
        COVER_LETTER_RESUME: '1',
      },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: Number(code ?? 1), signal: signal || '' }));
  });
}

async function waitForRetry(progress, recoveryCycle, reason) {
  const retryIntervalMs = reason === 'provider_unavailable'
    ? RETRY_INTERVAL_MS
    : PARTIAL_RETRY_INTERVAL_MS;
  const waitStartedAt = new Date();
  const nextRetryAt = new Date(waitStartedAt.getTime() + retryIntervalMs);
  const waiting = {
    ...progress,
    status: reason === 'provider_unavailable' ? 'waiting_provider_recovery' : 'waiting_quality_retry',
    supervisor: {
      recoveryCycle,
      reason,
      retryIntervalMs,
      waitingSince: waitStartedAt.toISOString(),
      nextRetryAt: nextRetryAt.toISOString(),
    },
    updatedAt: waitStartedAt.toISOString(),
  };
  delete waiting.finishedAt;
  await writeProgress(waiting);
  console.log(JSON.stringify({
    event: waiting.status,
    recoveryCycle,
    nextRetryAt: nextRetryAt.toISOString(),
    progressPath: PROGRESS_PATH,
  }));
  await sleep(retryIntervalMs);
}

let recoveryCycle = 0;
let previousOverallQualityPassed = -1;
let noProgressCycles = 0;
while (true) {
  const child = await runBatch();
  const progress = await readProgress();
  if (!progress) {
    throw new Error(`batch runner exited without a readable progress file (code ${child.code}, signal ${child.signal || 'none'})`);
  }

  const sourceTotal = Number(progress.sourceTotal || 0);
  const overallQualityPassed = Number(progress.overallQualityPassed || progress.alreadyQualityPassed || 0);
  const sourceBlockedCount = Number(progress.sourceBlockedCount || 0);
  const overallResolved = Number(progress.overallResolved || (overallQualityPassed + sourceBlockedCount));
  if (progress.status === 'completed' && sourceTotal > 0 && overallResolved === sourceTotal) {
    console.log(JSON.stringify({
      event: 'all_records_quality_resolved',
      jobId: progress.jobId,
      model: progress.model,
      sourceTotal,
      overallQualityPassed,
      sourceBlockedCount,
      overallResolved,
      progressPath: PROGRESS_PATH,
    }));
    break;
  }

  const providerUnavailable = progress.status === 'paused_provider_unavailable';
  const partial = progress.status === 'partial';
  if (!providerUnavailable && !partial) {
    const error = new Error(`batch stopped with non-recoverable status ${progress.status || 'unknown'}; inspect ${PROGRESS_PATH}`);
    error.code = 'BATCH_NOT_COMPLETE';
    throw error;
  }

  if (overallQualityPassed > previousOverallQualityPassed) {
    noProgressCycles = 0;
  } else {
    noProgressCycles += 1;
  }
  previousOverallQualityPassed = overallQualityPassed;
  if (noProgressCycles >= MAX_NO_PROGRESS_CYCLES) {
    const stalled = {
      ...progress,
      status: 'stalled_quality_gate',
      supervisor: {
        recoveryCycle,
        noProgressCycles,
        maxNoProgressCycles: MAX_NO_PROGRESS_CYCLES,
        stoppedAt: new Date().toISOString(),
      },
    };
    await writeProgress(stalled);
    const error = new Error(`batch made no quality-pass progress for ${noProgressCycles} cycles; inspect ${PROGRESS_PATH}`);
    error.code = 'BATCH_STALLED';
    throw error;
  }

  if (partial) {
    await waitForRetry(progress, recoveryCycle, 'quality_partial');
    continue;
  }

  recoveryCycle += 1;
  if (MAX_RECOVERY_CYCLES > 0 && recoveryCycle >= MAX_RECOVERY_CYCLES) {
    const stopped = {
      ...progress,
      status: 'paused_provider_unavailable',
      supervisor: {
        recoveryCycle,
        retryIntervalMs: RETRY_INTERVAL_MS,
        maxRecoveryCycles: MAX_RECOVERY_CYCLES,
        stoppedAt: new Date().toISOString(),
      },
    };
    await writeProgress(stopped);
    console.error(JSON.stringify({
      event: 'provider_recovery_limit_reached',
      recoveryCycle,
      progressPath: PROGRESS_PATH,
    }));
    process.exitCode = 3;
    break;
  }

  await waitForRetry(progress, recoveryCycle, 'provider_unavailable');
}
