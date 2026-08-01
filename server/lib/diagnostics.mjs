import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_FIELDS = new Set([
  'requestId', 'jobId', 'stageId', 'errorCode', 'durationMs', 'retryCount',
  'stopReason', 'counts', 'migration', 'statusCode', 'method', 'route', 'status',
]);
const MAX_STRING_LENGTH = 120;

export function createDiagnostics({ filePath, clock = () => new Date(), maxEvents = 500, sink } = {}) {
  const events = [];
  let writeQueue = Promise.resolve();

  const record = (event, fields = {}) => {
    const entry = sanitizeEntry({
      timestamp: clock().toISOString(),
      level: fields.level || 'info',
      event,
      ...fields,
    });
    events.push(entry);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    sink?.(entry);
    if (filePath) {
      writeQueue = writeQueue
        .catch(() => {})
        .then(async () => {
          await mkdir(path.dirname(filePath), { recursive: true });
          await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        });
    }
    return entry;
  };

  return {
    requestId(value) {
      const supplied = Array.isArray(value) ? value[0] : value;
      return REQUEST_ID.test(String(supplied || '')) ? String(supplied) : randomUUID();
    },
    record,
    recordJobEvent(jobId, type, data = {}) {
      if (type === 'log') return null;
      const stageId = data.stageId || data.progress?.phase || data.workflow?.currentStage || data.currentStage;
      const retryCount = data.retryCount ?? data.progress?.retryAttempt ?? data.currentAttempt?.retryCount;
      const stopReason = data.stopReason || data.cancelReason || data.cleanupResult?.reason;
      const counts = extractCounts(data);
      return record(type === 'end' ? 'job_completed' : type === 'closing' ? 'job_closing' : 'job_state_changed', {
        jobId,
        stageId,
        retryCount,
        stopReason,
        counts,
        status: data.status,
        errorCode: data.errorCode,
      });
    },
    bundle() {
      return {
        schemaVersion: 1,
        generatedAt: clock().toISOString(),
        runtime: { node: process.version, platform: process.platform, architecture: process.arch },
        events: events.map((entry) => ({ ...entry })),
      };
    },
    flush() {
      return writeQueue;
    },
  };
}

export function normalizeDiagnosticRoute(pathname) {
  return String(pathname || '/')
    .replace(/(\/api\/jobs\/)[^/]+/i, '$1:jobId')
    .replace(/(\/applications\/)[^/]+/i, '$1:applicationId')
    .slice(0, MAX_STRING_LENGTH);
}

function sanitizeEntry(input) {
  const entry = {
    timestamp: String(input.timestamp),
    level: ['debug', 'info', 'warn', 'error'].includes(input.level) ? input.level : 'info',
    event: sanitizeString(input.event),
  };
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null || value === '') continue;
    if (key === 'counts') {
      const counts = sanitizeNumberMap(value);
      if (Object.keys(counts).length) entry.counts = counts;
    } else if (key === 'migration') {
      const migration = sanitizeMigration(value);
      if (Object.keys(migration).length) entry.migration = migration;
    } else if (['durationMs', 'retryCount', 'statusCode'].includes(key)) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) entry[key] = Math.round(number);
    } else {
      entry[key] = sanitizeString(value);
    }
  }
  return entry;
}

function extractCounts(data) {
  const sources = [data.counts, data.coverage, data.progress?.counts, data.stats];
  return Object.assign({}, ...sources.filter((value) => value && typeof value === 'object'));
}

function sanitizeNumberMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) result[key] = Math.round(number);
  }
  return result;
}

function sanitizeMigration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (value.component) result.component = sanitizeString(value.component);
  if (value.status) result.status = sanitizeString(value.status);
  if (Number.isFinite(Number(value.count)) && Number(value.count) >= 0) result.count = Math.round(Number(value.count));
  return result;
}

function sanitizeString(value) {
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, MAX_STRING_LENGTH);
}
