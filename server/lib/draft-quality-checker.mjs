import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 660_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 4_096;

export class DraftQualityCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DraftQualityCheckError';
    this.code = code;
  }
}

export function createDraftQualityChecker({
  pythonBin = 'python',
  scriptPath,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (!String(scriptPath || '').trim()) {
    throw qualityError('DRAFT_QUALITY_SCRIPT_REQUIRED', 'A draft quality checker script path is required.');
  }
  const resolvedScriptPath = path.resolve(scriptPath);

  return async function checkDraftQuality(payload, ai = {}) {
    let serialized;
    try {
      serialized = `${JSON.stringify(payload)}\n`;
    } catch {
      throw qualityError('DRAFT_QUALITY_INPUT_INVALID', 'Draft quality input must be JSON serializable.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw qualityError('DRAFT_QUALITY_INPUT_INVALID', 'Draft quality input must be an object.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxInputBytes) {
      throw qualityError('DRAFT_QUALITY_INPUT_TOO_LARGE', 'Draft quality input exceeds the allowed size.');
    }

    const aiConfig = normalizeAiConfig(ai);
    const secrets = [aiConfig.apiKey].filter(Boolean);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(String(pythonBin || 'python'), [resolvedScriptPath], {
          cwd: path.dirname(resolvedScriptPath),
          env: {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            XHS_AI_PROVIDER: aiConfig.provider,
            XHS_AI_API_KEY: aiConfig.apiKey,
            XHS_AI_BASE_URL: aiConfig.baseUrl,
            XHS_AI_MODEL: aiConfig.model,
            XHS_AI_WIRE_API: aiConfig.wireApi,
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(qualityError('DRAFT_QUALITY_SPAWN_FAILED', `Draft quality process could not start: ${safeDetail(error?.message, secrets)}`));
        return;
      }

      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let outputExceeded = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const collect = (target, chunk, isStdout) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        if (isStdout) stdoutBytes += buffer.length;
        else stderrBytes += buffer.length;
        if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill?.('SIGKILL');
          return;
        }
        target.push(buffer);
      };
      child.stdout?.on('data', (chunk) => collect(stdout, chunk, true));
      child.stderr?.on('data', (chunk) => collect(stderr, chunk, false));
      child.on?.('error', (error) => finish(() => reject(qualityError(
        'DRAFT_QUALITY_SPAWN_FAILED',
        `Draft quality process failed to start: ${safeDetail(error?.message, secrets)}`,
      ))));
      child.on?.('close', (code, signal) => finish(() => {
        if (outputExceeded) {
          reject(qualityError('DRAFT_QUALITY_OUTPUT_LIMIT', 'Draft quality process exceeded its output limit.'));
          return;
        }
        const errorDetail = safeDetail(Buffer.concat(stderr).toString('utf8'), secrets);
        if (code !== 0) {
          const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
          reject(qualityError(
            'DRAFT_QUALITY_PROCESS_FAILED',
            `Draft quality process ended with ${status}${errorDetail ? `: ${errorDetail}` : '.'}`,
          ));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (!isQualityReport(result)) throw new Error('required quality report fields are missing');
          resolve(result);
        } catch (error) {
          reject(qualityError(
            'DRAFT_QUALITY_OUTPUT_INVALID',
            `Draft quality process returned invalid JSON: ${safeDetail(error?.message, secrets)}`,
          ));
        }
      }));

      const timer = setTimeout(() => {
        child.kill?.('SIGKILL');
        finish(() => reject(qualityError(
          'DRAFT_QUALITY_TIMEOUT',
          `Draft quality process exceeded ${timeoutMs} ms.`,
        )));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

      child.stdin?.on?.('error', (error) => finish(() => reject(qualityError(
        'DRAFT_QUALITY_INPUT_WRITE_FAILED',
        `Draft quality input could not be written: ${safeDetail(error?.message, secrets)}`,
      ))));
      child.stdin?.end?.(serialized, 'utf8');
    });
  };
}

function normalizeAiConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    provider: String(source.provider || 'codex').trim(),
    apiKey: String(source.apiKey || ''),
    baseUrl: String(source.baseUrl || '').trim(),
    model: String(source.model || '').trim(),
    wireApi: String(source.wireApi || 'responses').trim(),
  };
}

function isQualityReport(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Number.isInteger(value.score)
      && Number.isInteger(value.threshold)
      && typeof value.passed === 'boolean'
      && value.rubric && typeof value.rubric === 'object'
      && Array.isArray(value.problems)
      && Array.isArray(value.rewrite_instructions),
  );
}

function safeDetail(value, secrets) {
  let detail = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret) detail = detail.split(secret).join('[REDACTED]');
  }
  return detail.slice(0, MAX_ERROR_DETAIL_CHARS);
}

function qualityError(code, message) {
  return new DraftQualityCheckError(code, message);
}
