import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPendingUserMessage,
  applyCodexBrowserEvent,
  eventCheckpoint,
  projectionFromThreadRead,
  reconcileEventCursor,
} from '../public/codex/conversation-state.js';

function notification(sequence, method, params) {
  return {
    sequence,
    message: { type: 'mcp-notification', method, params },
  };
}

test('projects thread/read turns into stable user, assistant, and tool history', () => {
  const projection = projectionFromThreadRead({
    thread: {
      id: 'thread-1',
      status: { type: 'idle' },
      turns: [{
        id: 'turn-1',
        status: 'completed',
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Inspect the workspace.' }] },
          { id: 'assistant-1', type: 'agentMessage', text: 'The workspace is ready.' },
          { id: 'command-1', type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', status: 'completed' },
        ],
      }],
    },
  }, { cursor: 12 });

  assert.equal(projection.threadId, 'thread-1');
  assert.equal(projection.cursor, 12);
  assert.equal(projection.status, 'completed');
  assert.deepEqual(projection.messages.map(({ id, role, text }) => ({ id, role, text })), [
    { id: 'user-1', role: 'user', text: 'Inspect the workspace.' },
    { id: 'assistant-1', role: 'assistant', text: 'The workspace is ready.' },
    { id: 'command-1', role: 'tool', text: 'git status\nclean' },
  ]);
});

test('merges assistant deltas and treats item/completed as authoritative without duplicates', () => {
  let projection = projectionFromThreadRead({ thread: { id: 'thread-1', status: 'active', turns: [] } });
  projection = applyCodexBrowserEvent(projection, notification(1, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'Hello ',
  }));
  projection = applyCodexBrowserEvent(projection, notification(2, 'item/agentMessage/delta', {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'world',
  }));
  projection = applyCodexBrowserEvent(projection, notification(3, 'item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'Hello world.' },
  }));
  projection = applyCodexBrowserEvent(projection, notification(3, 'item/completed', {
    threadId: 'thread-1', turnId: 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'duplicate' },
  }));

  assert.equal(projection.messages.length, 1);
  assert.deepEqual(projection.messages[0], {
    id: 'assistant-1',
    turnId: 'turn-1',
    role: 'assistant',
    kind: 'message',
    text: 'Hello world.',
    status: 'complete',
  });
  assert.equal(projection.cursor, 3);
});

test('replaces an optimistic user message when the canonical item arrives', () => {
  let projection = projectionFromThreadRead({ thread: { id: 'thread-1', turns: [] } });
  projection = addPendingUserMessage(projection, 'Run tests.', 'local:user:1');
  projection = applyCodexBrowserEvent(projection, notification(7, 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id: 'user-1', type: 'userMessage', content: [{ type: 'input_text', text: 'Run tests.' }] },
  }));

  assert.deepEqual(projection.messages.map(({ id, status }) => ({ id, status })), [
    { id: 'user-1', status: 'complete' },
  ]);
});

test('advances the global cursor without projecting another thread and maps status and errors', () => {
  let projection = projectionFromThreadRead({ thread: { id: 'thread-1', turns: [] } });
  projection = applyCodexBrowserEvent(projection, notification(8, 'item/agentMessage/delta', {
    threadId: 'thread-2', turnId: 'turn-2', itemId: 'assistant-2', delta: 'not visible',
  }));
  assert.equal(projection.cursor, 8);
  assert.equal(projection.messages.length, 0);

  projection = applyCodexBrowserEvent(projection, notification(9, 'thread/status/changed', {
    threadId: 'thread-1', status: { type: 'active' },
  }));
  projection = applyCodexBrowserEvent(projection, notification(10, 'turn/status', {
    threadId: 'thread-1', turnId: 'turn-1', status: 'completed',
  }));
  projection = applyCodexBrowserEvent(projection, notification(11, 'error', {
    threadId: 'thread-1', turnId: 'turn-1', error: { code: 'rate_limited', message: 'Try again.' }, willRetry: false,
  }));
  assert.equal(projection.status, 'failed');
  assert.equal(projection.messages[0].kind, 'error');
  assert.equal(projection.messages[0].text, 'Try again.');
});

test('restores a valid cursor only for the same app-server process', () => {
  const checkpoint = eventCheckpoint(17, { pid: 42 });
  assert.deepEqual(checkpoint, { cursor: 17, processId: 42 });
  assert.equal(reconcileEventCursor(checkpoint, { pid: 42, sequence: 20 }), 17);
  assert.equal(reconcileEventCursor(checkpoint, { pid: 99, sequence: 3 }), 3);
  assert.equal(reconcileEventCursor({ cursor: 50, processId: 42 }, { pid: 42, sequence: 20 }), 20);
});

test('projects app-server disconnect and reconnect events without adding messages', () => {
  let projection = projectionFromThreadRead({ thread: { id: 'thread-1', turns: [] } });
  projection = applyCodexBrowserEvent(projection, {
    sequence: 1,
    message: { type: 'codex-app-server-connection-changed', state: 'disconnected' },
  });
  assert.equal(projection.connection, 'reconnecting');
  projection = applyCodexBrowserEvent(projection, {
    sequence: 2,
    message: { type: 'codex-app-server-connection-changed', state: 'connected' },
  });
  assert.equal(projection.connection, 'connected');
  assert.equal(projection.messages.length, 0);
});
