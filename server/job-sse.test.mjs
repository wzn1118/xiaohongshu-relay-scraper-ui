import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamEvents } from './app.mjs';

function workflowEvent(sequence, total = 5) {
  return {
    schemaVersion: 1,
    eventId: `job-1:${sequence}`,
    sequence,
    jobId: 'job-1',
    attemptId: 'attempt-1',
    occurredAt: new Date(Date.UTC(2026, 7, 3, 8, 0, sequence)).toISOString(),
    type: 'workflow',
    data: null,
    workflowEvent: {
      schemaVersion: 1,
      eventId: `job-1:${sequence}`,
      sequence,
      jobId: 'job-1',
      attemptId: 'attempt-1',
      occurredAt: new Date(Date.UTC(2026, 7, 3, 8, 0, sequence)).toISOString(),
      type: 'item',
      stage: 'body',
      state: 'running',
      progress: { unit: 'body', done: sequence, total, succeeded: sequence, reused: 0, retryable: 0, failed: 0, blocked: 0 },
      message: { code: 'body.item.processed' },
    },
  };
}

function transportEvent(sequence, type, data, total = 5) {
  return { ...workflowEvent(sequence, total), type, data };
}

function parseSseFrames(output) {
  return output.split('\n\n').filter(Boolean).map((frame) => {
    const event = frame.match(/^event: (.+)$/m)?.[1] || '';
    const id = frame.match(/^id: (\d+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return {
      event,
      id: id === undefined ? null : Number(id),
      data: data ? JSON.parse(data) : null,
    };
  });
}

function responseRecorder() {
  return {
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

test('job SSE replays after Last-Event-ID and drains events emitted during the high-water race', async () => {
  const request = new EventEmitter();
  request.url = '/api/jobs/job-1/events';
  request.headers = { 'last-event-id': '1' };
  const response = responseRecorder();
  const events = [workflowEvent(1), workflowEvent(2), workflowEvent(3)];
  let listener = null;
  const snapshot = {
    schemaVersion: 3,
    revision: 4,
    throughSequence: 3,
    jobId: 'job-1',
  };
  const job = { id: 'job-1', activeAttemptId: 'attempt-1', experienceSnapshot: snapshot };
  const manager = {
    get: () => job,
    subscribe: (_id, next) => {
      listener = next;
      return () => { listener = null; };
    },
    getEventHighWater: async () => {
      listener(workflowEvent(4));
      return 3;
    },
    listEventPage: async (_id, after, { throughSequence }) => {
      const page = events.filter((event) => event.sequence > after && event.sequence <= throughSequence);
      return {
        events: page,
        nextAfter: page.at(-1)?.sequence || after,
        hasMore: false,
        throughSequence,
      };
    },
  };

  await streamEvents(request, response, manager, 'job-1');
  listener(workflowEvent(5));

  const output = response.chunks.join('');
  const ids = [...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, [2, 3, 4, 5]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(output, /event: snapshot/);
  assert.match(output, /"sequence":1/);
  assert.match(output, /"throughSequence":3/);
  assert.match(output, /"experienceSnapshot":\{"schemaVersion":3/);
  assert.equal(response.status, 200);
  assert.equal(response.headers['X-Accel-Buffering'], 'no');

  request.emit('close');
  assert.equal(response.ended, true);
  assert.equal(listener, null);
});

test('job SSE gives the reconnect Last-Event-ID header precedence over the initial query cursor', async () => {
  const request = new EventEmitter();
  request.url = '/api/jobs/job-1/events?after=0';
  request.headers = { 'last-event-id': '2' };
  const response = responseRecorder();
  const events = [workflowEvent(1), workflowEvent(2), workflowEvent(3)];
  const job = {
    id: 'job-1', activeAttemptId: 'attempt-1',
    experienceSnapshot: { schemaVersion: 3, throughSequence: 3, jobId: 'job-1' },
  };
  const manager = {
    get: () => job,
    subscribe: () => () => {},
    getEventHighWater: async () => 3,
    listEventPage: async (_id, after, { throughSequence }) => ({
      events: events.filter((event) => event.sequence > after && event.sequence <= throughSequence),
      nextAfter: 3,
      hasMore: false,
      throughSequence,
    }),
  };

  await streamEvents(request, response, manager, 'job-1');
  request.emit('close');

  const ids = parseSseFrames(response.chunks.join('')).map((frame) => frame.id).filter((id) => id !== null);
  assert.deepEqual(ids, [3]);
  assert.equal(parseSseFrames(response.chunks.join(''))[0].data.sequence, 2);
});

test('job SSE rejects malformed cursors before subscribing', async () => {
  const request = new EventEmitter();
  request.url = '/api/jobs/job-1/events?after=1.5';
  request.headers = {};
  const response = responseRecorder();
  let subscribed = false;
  const manager = {
    get: () => ({ id: 'job-1' }),
    subscribe: () => {
      subscribed = true;
      return () => {};
    },
  };

  await assert.rejects(
    streamEvents(request, response, manager, 'job-1'),
    (error) => error?.code === 'EVENT_CURSOR_INVALID',
  );
  assert.equal(subscribed, false);
});

test('job SSE retains legacy snapshot/log/status/done names and payload fields while adding replay metadata', async () => {
  const request = new EventEmitter();
  request.url = '/api/jobs/job-1/events';
  request.headers = {};
  const response = responseRecorder();
  const snapshot = { schemaVersion: 3, throughSequence: 3, jobId: 'job-1' };
  const liveJob = { id: 'job-1', status: 'completed', experienceSnapshot: snapshot };
  const runningJob = { id: 'job-1', status: 'running', experienceSnapshot: snapshot };
  const events = [
    transportEvent(1, 'log', { stream: 'stderr', message: 'legacy log line' }),
    transportEvent(2, 'state', runningJob),
    transportEvent(3, 'end', { status: 'completed', exitCode: 0 }),
  ];
  const manager = {
    get: () => liveJob,
    subscribe: () => () => {},
    getEventHighWater: async () => 3,
    listEventPage: async (_id, after, { throughSequence }) => {
      const page = events.filter((event) => event.sequence > after && event.sequence <= throughSequence);
      return {
        events: page,
        nextAfter: page.at(-1)?.sequence || after,
        hasMore: false,
        throughSequence,
      };
    },
  };

  await streamEvents(request, response, manager, 'job-1');
  request.emit('close');

  const frames = parseSseFrames(response.chunks.join(''));
  assert.deepEqual(frames.map((frame) => frame.event), ['snapshot', 'log', 'status', 'done']);
  assert.equal(frames[0].data.type, 'snapshot');
  assert.equal(frames[0].data.job.id, 'job-1');
  assert.equal(frames[1].data.type, 'log');
  assert.equal(frames[1].data.line, 'legacy log line');
  assert.equal(frames[1].data.level, 'error');
  assert.equal(frames[2].data.type, 'status');
  assert.equal(frames[2].data.job.status, 'running');
  assert.equal(frames[3].data.type, 'done');
  assert.equal(frames[3].data.job.status, 'completed');
  for (const frame of frames.slice(1)) {
    assert.equal(frame.id, frame.data.sequence);
    assert.equal(frame.data.jobId, 'job-1');
    assert.equal(frame.data.attemptId, 'attempt-1');
    assert.equal(typeof frame.data.eventId, 'string');
    assert.equal(typeof frame.data.occurredAt, 'string');
  }
});

test('job SSE replays fixed 20/50/320 event samples without gaps or duplicates', async (t) => {
  for (const total of [20, 50, 320]) {
    await t.test(`${total} events`, async () => {
      const after = Math.floor(total / 4);
      const request = new EventEmitter();
      request.url = `/api/jobs/job-1/events?after=${after}`;
      request.headers = {};
      const response = responseRecorder();
      const events = Array.from({ length: total }, (_, index) => workflowEvent(index + 1, total));
      const job = {
        id: 'job-1',
        activeAttemptId: 'attempt-1',
        experienceSnapshot: { schemaVersion: 3, throughSequence: total, jobId: 'job-1' },
      };
      const manager = {
        get: () => job,
        subscribe: () => () => {},
        getEventHighWater: async () => total,
        listEventPage: async (_id, cursor, { throughSequence }) => {
          const eligible = events.filter((event) => event.sequence > cursor && event.sequence <= throughSequence);
          const page = eligible.slice(0, 37);
          return {
            events: page,
            nextAfter: page.at(-1)?.sequence || cursor,
            hasMore: eligible.length > page.length,
            throughSequence,
          };
        },
      };

      await streamEvents(request, response, manager, 'job-1');
      request.emit('close');

      const ids = parseSseFrames(response.chunks.join(''))
        .map((frame) => frame.id)
        .filter((id) => id !== null);
      assert.deepEqual(ids, Array.from({ length: total - after }, (_, index) => after + index + 1));
      assert.equal(new Set(ids).size, ids.length);
    });
  }
});
