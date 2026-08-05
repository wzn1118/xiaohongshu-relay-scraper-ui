import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 660_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 4_096;

export class CoverLetterRewriteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoverLetterRewriteError';
    this.code = code;
  }
}

export function createCoverLetterRewriter({
  pythonBin = 'python',
  scriptPath,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (!String(scriptPath || '').trim()) {
    throw rewriteError('COVER_LETTER_REWRITE_SCRIPT_REQUIRED', 'A Cover Letter rewrite script path is required.');
  }
  const resolvedScriptPath = path.resolve(scriptPath);

  return async function runCoverLetterRewrite(payload, ai = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw rewriteError('COVER_LETTER_REWRITE_INPUT_INVALID', 'Cover Letter rewrite input must be an object.');
    }
    let serialized;
    try {
      serialized = `${JSON.stringify(payload)}\n`;
    } catch {
      throw rewriteError('COVER_LETTER_REWRITE_INPUT_INVALID', 'Cover Letter rewrite input must be JSON serializable.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxInputBytes) {
      throw rewriteError('COVER_LETTER_REWRITE_INPUT_TOO_LARGE', 'Cover Letter rewrite input exceeds the allowed size.');
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
            XHS_AI_MAX_OUTPUT_TOKENS: String(aiConfig.maxOutputTokens),
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(rewriteError(
          'COVER_LETTER_REWRITE_SPAWN_FAILED',
          `Cover Letter rewrite process could not start: ${safeDetail(error?.message, secrets)}`,
        ));
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
      child.on?.('error', (error) => finish(() => reject(rewriteError(
        'COVER_LETTER_REWRITE_SPAWN_FAILED',
        `Cover Letter rewrite process failed to start: ${safeDetail(error?.message, secrets)}`,
      ))));
      child.on?.('close', (code, signal) => finish(() => {
        if (outputExceeded) {
          reject(rewriteError('COVER_LETTER_REWRITE_OUTPUT_LIMIT', 'Cover Letter rewrite process exceeded its output limit.'));
          return;
        }
        const errorDetail = safeDetail(Buffer.concat(stderr).toString('utf8'), secrets);
        if (code !== 0) {
          const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
          reject(rewriteError(
            'COVER_LETTER_REWRITE_PROCESS_FAILED',
            `Cover Letter rewrite process ended with ${status}${errorDetail ? `: ${errorDetail}` : '.'}`,
          ));
          return;
        }
        try {
          const output = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (!isRewriteOutput(output)) throw new Error('required rewrite result fields are missing');
          resolve({ ...output.result, runtime: output.runtime || {} });
        } catch (error) {
          reject(rewriteError(
            'COVER_LETTER_REWRITE_OUTPUT_INVALID',
            `Cover Letter rewrite process returned invalid JSON: ${safeDetail(error?.message, secrets)}`,
          ));
        }
      }));

      const timer = setTimeout(() => {
        child.kill?.('SIGKILL');
        finish(() => reject(rewriteError(
          'COVER_LETTER_REWRITE_TIMEOUT',
          `Cover Letter rewrite process exceeded ${timeoutMs} ms.`,
        )));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

      child.stdin?.on?.('error', (error) => finish(() => reject(rewriteError(
        'COVER_LETTER_REWRITE_INPUT_WRITE_FAILED',
        `Cover Letter rewrite input could not be written: ${safeDetail(error?.message, secrets)}`,
      ))));
      child.stdin?.end?.(serialized, 'utf8');
    });
  };
}

function normalizeAiConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const requestedMaxOutputTokens = Number(source.maxOutputTokens || 0);
  return {
    provider: String(source.provider || 'codex').trim(),
    apiKey: String(source.apiKey || ''),
    baseUrl: String(source.baseUrl || '').trim(),
    model: String(source.model || '').trim(),
    wireApi: String(source.wireApi || 'responses').trim(),
    maxOutputTokens: Number.isFinite(requestedMaxOutputTokens)
      ? Math.max(4_096, Math.min(16_384, requestedMaxOutputTokens || 4_096))
      : 4_096,
  };
}

function isRewriteOutput(value) {
  const result = value?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const coverLetter = String(result.cover_letter || '').trim();
  const charCount = Array.from(coverLetter.replace(/\s+/gu, '')).length;
  return Boolean(
    coverLetter
      && charCount >= 800
      && charCount <= 1_600
      && Number(result.char_count) === charCount
      && Array.isArray(result.used_evidence_ids)
      && Array.isArray(result.evidence_coverage)
      && Array.isArray(result.responsibility_coverage),
  );
}

function safeDetail(value, secrets) {
  let detail = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret) detail = detail.split(secret).join('[REDACTED]');
  }
  return detail.slice(0, MAX_ERROR_DETAIL_CHARS);
}

function rewriteError(code, message) {
  return new CoverLetterRewriteError(code, message);
}
