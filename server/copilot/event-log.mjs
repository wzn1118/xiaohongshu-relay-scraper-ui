import crypto from 'node:crypto';

export const COPILOT_EVENT_SCHEMA_VERSION = 1;

const ENVELOPE_FIELDS = new Set([
  'eventId', 'seq', 'conversationId', 'runId', 'occurredAt', 'createdAt',
  'type', 'payload', 'idempotencyKey', 'schemaVersion',
]);

export function normalizeCopilotEvent(value = {}, { conversationId = '', seq = 0, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
  const payload = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    ? structuredClone(value.payload)
    : eventPayload(value);
  const eventSeq = Number.isSafeInteger(Number(seq)) && Number(seq) > 0
    ? Number(seq)
    : Number(value.seq || value.eventId || 0);
  const occurredAt = String(value.occurredAt || value.createdAt || now().toISOString());
  const id = String(value.idempotencyKey || '').trim() || `event:${conversationId || 'conversation'}:${eventSeq || idFactory()}`;
  return {
    schemaVersion: COPILOT_EVENT_SCHEMA_VERSION,
    eventId: Number(value.eventId || eventSeq || 0),
    seq: eventSeq,
    conversationId: String(value.conversationId || conversationId || ''),
    ...(value.runId ? { runId: String(value.runId) } : {}),
    occurredAt,
    createdAt: String(value.createdAt || occurredAt),
    type: normalizeEventType(value.type || value.event || value.name),
    payload,
    idempotencyKey: id,
  };
}

export function replayEvents(events = [], { afterSeq = 0, limit = 500 } = {}) {
  const normalized = events
    .map((event) => normalizeCopilotEvent(event))
    .filter((event) => event.seq > 0)
    .sort((left, right) => left.seq - right.seq);
  const after = Number.isSafeInteger(Number(afterSeq)) && Number(afterSeq) >= 0 ? Number(afterSeq) : 0;
  const maximum = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 5000) : 500;
  const firstSeq = normalized[0]?.seq || 0;
  const lastSeq = normalized.at(-1)?.seq || 0;
  const gap = after > 0 && firstSeq > after + 1 ? { from: after + 1, to: firstSeq - 1 } : null;
  const selected = normalized.filter((event) => event.seq > after).slice(0, maximum);
  return {
    schemaVersion: COPILOT_EVENT_SCHEMA_VERSION,
    events: selected,
    nextSeq: selected.at(-1)?.seq || after,
    firstSeq,
    lastSeq,
    gap,
  };
}

export function eventPayload(value = {}) {
  const payload = structuredClone(value);
  for (const key of ENVELOPE_FIELDS) delete payload[key];
  return payload;
}

function normalizeEventType(value) {
  const type = String(value || 'event').trim().replace(/[^A-Za-z0-9_.:-]/gu, '_');
  return type || 'event';
}
