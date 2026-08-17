import crypto from 'node:crypto';

export const EXECUTION_CONTEXT_SCHEMA_VERSION = 3;

export function createExecutionContext(value = {}) {
  if (!isPlainObject(value)) {
    throw contractError('RUNTIME_V3_EXECUTION_CONTEXT_INVALID', 'ExecutionContext must be an object.');
  }
  if (value.schemaVersion !== undefined && Number(value.schemaVersion) !== EXECUTION_CONTEXT_SCHEMA_VERSION) {
    throw contractError(
      'RUNTIME_V3_EXECUTION_CONTEXT_VERSION_UNSUPPORTED',
      `ExecutionContext schemaVersion must be ${EXECUTION_CONTEXT_SCHEMA_VERSION}.`,
    );
  }

  const context = {
    schemaVersion: EXECUTION_CONTEXT_SCHEMA_VERSION,
    taskId: requiredText(value.taskId, 'taskId'),
    runId: requiredText(value.runId, 'runId'),
    attemptId: requiredText(value.attemptId, 'attemptId'),
    traceId: requiredText(value.traceId, 'traceId'),
    deadlineAt: requiredTimestamp(value.deadlineAt, 'deadlineAt'),
    idempotencyKey: requiredText(value.idempotencyKey, 'idempotencyKey'),
    environment: normalizeJsonObject(value.environment, 'environment'),
    authority: normalizeJsonObject(value.authority, 'authority'),
    modelPolicy: normalizeJsonObject(value.modelPolicy, 'modelPolicy'),
    contextSnapshotId: requiredText(value.contextSnapshotId, 'contextSnapshotId'),
  };
  const parentExecutionId = optionalText(value.parentExecutionId);
  if (parentExecutionId) context.parentExecutionId = parentExecutionId;
  return deepFreeze(context);
}

export function fingerprintExecutionContext(value) {
  const context = createExecutionContext(value);
  return crypto.createHash('sha256').update(canonicalJson(context)).digest('hex');
}

export function normalizeJsonObject(value, name = 'value') {
  const normalized = normalizeJsonValue(value ?? {}, name);
  if (!isPlainObject(normalized)) {
    throw contractError('RUNTIME_V3_JSON_OBJECT_REQUIRED', `${name} must be a JSON object.`);
  }
  return normalized;
}

export function normalizeJsonValue(value, name = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    throw contractError('RUNTIME_V3_JSON_VALUE_INVALID', `${name} must contain only finite numbers.`);
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, name, ancestors);
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((item, index) => normalizeJsonValue(item, `${name}[${index}]`, nextAncestors));
  }
  if (isPlainObject(value)) {
    assertNotCircular(value, name, ancestors);
    const nextAncestors = new Set(ancestors).add(value);
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => {
        if (value[key] === undefined) {
          throw contractError('RUNTIME_V3_JSON_VALUE_INVALID', `${name}.${key} must not be undefined.`);
        }
        return [key, normalizeJsonValue(value[key], `${name}.${key}`, nextAncestors)];
      }),
    );
  }
  throw contractError('RUNTIME_V3_JSON_VALUE_INVALID', `${name} must be JSON-compatible.`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertNotCircular(value, name, ancestors) {
  if (ancestors.has(value)) {
    throw contractError('RUNTIME_V3_JSON_VALUE_CIRCULAR', `${name} must not contain circular references.`);
  }
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw contractError('RUNTIME_V3_EXECUTION_CONTEXT_REQUIRED', `${name} is required.`);
  return text;
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) {
    throw contractError('RUNTIME_V3_EXECUTION_CONTEXT_TIMESTAMP_INVALID', `${name} must be an ISO-8601 timestamp.`);
  }
  return timestamp.toISOString();
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function contractError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
