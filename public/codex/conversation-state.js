const RUNNING_STATUSES = new Set(['active', 'inProgress', 'in_progress', 'running', 'started']);
const FAILED_STATUSES = new Set(['failed', 'error']);
const COMPLETE_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success']);

export function createConversationProjection(threadId = '', cursor = 0) {
  return {
    threadId: String(threadId || ''),
    cursor: safeCursor(cursor),
    status: 'idle',
    connection: 'connected',
    messages: [],
  };
}

export function projectionFromThreadRead(value, { cursor = 0 } = {}) {
  const thread = value?.thread && typeof value.thread === 'object' ? value.thread : value;
  const projection = createConversationProjection(thread?.id, cursor);
  projection.status = normalizeRunStatus(thread?.status);
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      upsertItem(projection, item, turn?.id, true);
    }
    if (turn?.error) upsertError(projection, turn.error, turn?.id);
    projection.status = normalizeRunStatus(turn?.status, projection.status);
  }
  return projection;
}

export function addPendingUserMessage(projection, text, id = `local:user:${Date.now()}`) {
  const next = cloneProjection(projection);
  upsertMessage(next, {
    id,
    role: 'user',
    kind: 'message',
    text: String(text || ''),
    status: 'pending',
  });
  return next;
}

export function applyCodexBrowserEvent(projection, entry) {
  const sequence = safeCursor(entry?.sequence);
  if (sequence && sequence <= projection.cursor) return projection;
  const next = cloneProjection(projection);
  if (sequence) next.cursor = sequence;

  const envelope = entry?.message && typeof entry.message === 'object' ? entry.message : entry;
  if (envelope?.type === 'codex-app-server-connection-changed') {
    next.connection = envelope.state === 'connected' ? 'connected' : 'reconnecting';
    return next;
  }
  if (envelope?.type !== 'mcp-notification' && typeof envelope?.method !== 'string') return next;

  const method = String(envelope.method || '');
  const params = envelope.params && typeof envelope.params === 'object' ? envelope.params : {};
  const eventThreadId = String(params.threadId || params.thread?.id || '');
  if (next.threadId && eventThreadId && eventThreadId !== next.threadId) return next;

  if (isAssistantDelta(method)) {
    const itemId = String(params.itemId || params.item?.id || params.messageId || '');
    const delta = String(params.delta ?? params.text ?? '');
    if (itemId && delta) appendAssistantDelta(next, itemId, delta, params.turnId);
    next.status = 'running';
    return next;
  }
  if (method === 'item/started' || method === 'item/completed') {
    if (params.item) upsertItem(next, params.item, params.turnId, method === 'item/completed');
    if (method === 'item/started') next.status = 'running';
    return next;
  }
  if (method === 'turn/started') {
    next.status = 'running';
    return next;
  }
  if (method === 'turn/completed') {
    next.status = normalizeRunStatus(params.turn?.status, 'completed');
    if (params.turn?.error) upsertError(next, params.turn.error, params.turn?.id || params.turnId);
    return next;
  }
  if (method === 'thread/status/changed' || method === 'turn/status' || method === 'turn/status/changed') {
    next.status = normalizeRunStatus(params.status ?? params.thread?.status, next.status);
    return next;
  }
  if (method === 'error' || method === 'turn/error') {
    upsertError(next, params.error || params, params.turnId, params.willRetry);
    next.status = params.willRetry ? 'running' : 'failed';
    return next;
  }
  if (method === 'thread/closed' || method === 'thread/deleted') next.status = 'completed';
  return next;
}

export function reconcileEventCursor(saved, backend) {
  const through = safeCursor(backend?.sequence);
  const cursor = safeCursor(saved?.cursor);
  const sameProcess = String(saved?.processId || '') !== ''
    && String(saved.processId) === String(backend?.pid || '');
  return sameProcess && cursor <= through ? cursor : through;
}

export function eventCheckpoint(cursor, backend) {
  return { cursor: safeCursor(cursor), processId: backend?.pid ?? null };
}

function cloneProjection(projection) {
  return { ...projection, messages: projection.messages.map((message) => ({ ...message })) };
}

function upsertItem(projection, item, turnId, completed) {
  const message = messageFromItem(item, turnId, completed);
  if (!message) return;
  if (message.role === 'user') {
    const pendingIndex = projection.messages.findIndex((candidate) => (
      candidate.role === 'user'
      && candidate.status === 'pending'
      && candidate.text === message.text
    ));
    if (pendingIndex >= 0) projection.messages.splice(pendingIndex, 1);
  }
  upsertMessage(projection, message, { authoritative: completed });
}

function messageFromItem(item, turnId, completed) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '');
  if (!id) return null;
  const common = { id, turnId: String(turnId || ''), status: completed ? 'complete' : 'streaming' };
  if (item.type === 'userMessage' || item.type === 'user_message') {
    return { ...common, role: 'user', kind: 'message', text: inputText(item.content) };
  }
  if (item.type === 'agentMessage' || item.type === 'assistantMessage' || item.type === 'assistant_message') {
    return { ...common, role: 'assistant', kind: 'message', text: String(item.text || outputText(item.content)) };
  }
  if (item.type === 'plan') {
    return { ...common, role: 'assistant', kind: 'event', text: String(item.text || '') };
  }
  if (item.type === 'reasoning') {
    const text = [...asStrings(item.summary), ...asStrings(item.content)].join('\n');
    return text ? { ...common, role: 'assistant', kind: 'event', text } : null;
  }
  if (item.type === 'commandExecution') {
    const output = String(item.aggregatedOutput || '').trim();
    return { ...common, role: 'tool', kind: 'event', text: [String(item.command || ''), output].filter(Boolean).join('\n') };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const name = [item.server, item.tool].filter(Boolean).join('.') || item.type;
    return { ...common, role: 'tool', kind: 'event', text: `${name} · ${String(item.status || (completed ? 'completed' : 'running'))}` };
  }
  if (item.type === 'fileChange') {
    return { ...common, role: 'tool', kind: 'event', text: `文件变更 · ${String(item.status || (completed ? 'completed' : 'running'))}` };
  }
  return null;
}

function appendAssistantDelta(projection, itemId, delta, turnId) {
  const existing = projection.messages.find((message) => message.id === itemId);
  if (existing?.status === 'complete') return;
  if (existing) {
    existing.text += delta;
    existing.status = 'streaming';
    return;
  }
  upsertMessage(projection, {
    id: itemId,
    turnId: String(turnId || ''),
    role: 'assistant',
    kind: 'message',
    text: delta,
    status: 'streaming',
  });
}

function upsertError(projection, error, turnId, willRetry = false) {
  const id = `error:${String(turnId || error?.code || 'thread')}`;
  upsertMessage(projection, {
    id,
    turnId: String(turnId || ''),
    role: 'system',
    kind: 'error',
    text: String(error?.message || error?.code || error || 'Codex 运行失败。'),
    status: willRetry ? 'streaming' : 'complete',
  }, { authoritative: true });
}

function upsertMessage(projection, incoming, { authoritative = false } = {}) {
  const index = projection.messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) {
    if (incoming.text) projection.messages.push(incoming);
    return;
  }
  const existing = projection.messages[index];
  projection.messages[index] = authoritative
    ? { ...existing, ...incoming }
    : { ...existing, ...incoming, text: incoming.text || existing.text };
}

function isAssistantDelta(method) {
  return method === 'item/agentMessage/delta'
    || method === 'assistant/delta'
    || method === 'assistant.delta'
    || method === 'message/delta';
}

function normalizeRunStatus(value, fallback = 'idle') {
  const status = typeof value === 'object' && value ? value.type || value.status : value;
  const text = String(status || '');
  if (RUNNING_STATUSES.has(text)) return 'running';
  if (FAILED_STATUSES.has(text)) return 'failed';
  if (COMPLETE_STATUSES.has(text)) return 'completed';
  if (text === 'interrupted' || text === 'cancelled' || text === 'canceled') return 'interrupted';
  if (text === 'idle' || text === 'notLoaded' || text === 'not_loaded') return 'idle';
  return fallback;
}

function inputText(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => String(part?.text || part?.content || ''))
    .filter(Boolean)
    .join('\n');
}

function outputText(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => String(part?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function asStrings(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(Boolean);
}

function safeCursor(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
