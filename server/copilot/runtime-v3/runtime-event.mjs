import {
  deepFreeze,
  normalizeJsonValue,
} from './execution-context.mjs';

export const RUNTIME_EVENT_SCHEMA_VERSION = 3;

export function createRuntimeEvent(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw eventError('RUNTIME_V3_EVENT_INVALID', 'RuntimeEvent must be an object.');
  }
  if (value.schemaVersion !== undefined && Number(value.schemaVersion) !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw eventError(
      'RUNTIME_V3_EVENT_VERSION_UNSUPPORTED',
      `RuntimeEvent schemaVersion must be ${RUNTIME_EVENT_SCHEMA_VERSION}.`,
    );
  }

  const sequence = Number(value.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw eventError('RUNTIME_V3_EVENT_SEQUENCE_INVALID', 'sequence must be a positive safe integer.');
  }

  const event = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: requiredText(value.eventId, 'eventId'),
    streamId: requiredText(value.streamId, 'streamId'),
    sequence,
    type: requiredText(value.type, 'type'),
    occurredAt: requiredTimestamp(value.occurredAt, 'occurredAt'),
    taskId: requiredText(value.taskId, 'taskId'),
    runId: requiredText(value.runId, 'runId'),
    payload: normalizeJsonValue(value.payload ?? {}, 'payload'),
  };
  const agentId = optionalText(value.agentId);
  const attemptId = optionalText(value.attemptId);
  if (agentId) event.agentId = agentId;
  if (attemptId) event.attemptId = attemptId;
  return deepFreeze(event);
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw eventError('RUNTIME_V3_EVENT_VALUE_REQUIRED', `${name} is required.`);
  return text;
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) {
    throw eventError('RUNTIME_V3_EVENT_TIMESTAMP_INVALID', `${name} must be an ISO-8601 timestamp.`);
  }
  return timestamp.toISOString();
}

function eventError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
