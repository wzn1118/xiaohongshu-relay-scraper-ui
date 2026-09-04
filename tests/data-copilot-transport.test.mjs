import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const moduleUrl = new URL('../src/data-copilot-transport.ts', import.meta.url).href

function project(events) {
  const script = `
    import { reduceDataCopilotSubagentRun } from ${JSON.stringify(moduleUrl)};
    let run;
    for (const event of JSON.parse(process.env.COPILOT_SUBAGENT_EVENTS || '[]')) {
      run = reduceDataCopilotSubagentRun(run, event, 'conversation-test');
    }
    process.stdout.write(JSON.stringify(run));
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, COPILOT_SUBAGENT_EVENTS: JSON.stringify(events) },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function captureWorkspaceBindingRequests() {
  const script = `
    import { createDataCopilotTransport } from ${JSON.stringify(moduleUrl)};

    const requests = [];
    const conversation = {
      conversationId: 'conversation-test',
      jobId: 'job-test',
      mode: 'application',
      snapshotId: 'job-r1',
      status: 'idle',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      selectedModel: { aiSessionId: 'model-test' },
      scope: { contextSourceIds: ['job:job-test'] },
    };

    globalThis.fetch = async (input, init = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url: String(input), method: init.method || 'GET', body });
      return {
        ok: true,
        status: 201,
        async json() {
          return { conversation, messages: [] };
        },
      };
    };

    const transport = createDataCopilotTransport({
      jobId: 'job-test',
      mode: 'application',
      snapshotId: 'job-r1',
      aiSessionId: 'model-test',
      apiBaseUrl: 'http://copilot.test',
    });
    const authority = {
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      allowAllTools: true,
    };

    await transport.createSession({
      modelId: 'model-test',
      contextSourceIds: ['job:job-test'],
      projectId: ' project-1 ',
      workspaceId: ' workspace-1 ',
      worktreeId: ' worktree-1 ',
      authority,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    });
    await transport.sendMessage({
      sessionId: 'conversation-test',
      content: 'bound message',
      modelId: 'model-test',
      workspaceMode: 'build',
      reasoningEffort: 'high',
      attachmentIds: [],
      contextSourceIds: ['job:job-test'],
      projectId: ' project-1 ',
      workspaceId: ' workspace-1 ',
      worktreeId: ' worktree-1 ',
      authority,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    });
    await transport.createSession({
      modelId: 'model-test',
      contextSourceIds: ['job:job-test'],
      authority,
    });
    await transport.sendMessage({
      sessionId: 'conversation-test',
      content: 'legacy message',
      modelId: 'model-test',
      workspaceMode: 'ask',
      attachmentIds: [],
      contextSourceIds: ['job:job-test'],
      authority,
    });
    await transport.sendMessage({
      sessionId: 'conversation-test',
      content: 'partial binding',
      modelId: 'model-test',
      workspaceMode: 'ask',
      attachmentIds: [],
      contextSourceIds: ['job:job-test'],
      projectId: 'project-only',
      authority,
    });

    process.stdout.write(JSON.stringify(requests));
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

test('transport sends only complete public workspace bindings for create and message requests', () => {
  const requests = captureWorkspaceBindingRequests()
  assert.equal(requests.length, 5)

  const [boundCreate, boundMessage, legacyCreate, legacyMessage, partialMessage] = requests
  assert.equal(boundCreate.url, 'http://copilot.test/api/copilot/conversations')
  assert.match(boundMessage.url, /\/api\/copilot\/conversations\/conversation-test\/messages$/u)
  assert.equal(boundMessage.body.reasoningEffort, 'high')
  assert.deepEqual(
    {
      projectId: boundCreate.body.projectId,
      workspaceId: boundCreate.body.workspaceId,
      worktreeId: boundCreate.body.worktreeId,
    },
    { projectId: 'project-1', workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
  )
  assert.deepEqual(
    {
      projectId: boundMessage.body.projectId,
      workspaceId: boundMessage.body.workspaceId,
      worktreeId: boundMessage.body.worktreeId,
    },
    { projectId: 'project-1', workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
  )

  for (const request of requests) {
    assert.equal('authority' in request.body, false)
    assert.equal('approvalPolicy' in request.body, false)
    assert.equal('sandboxMode' in request.body, false)
    assert.equal('workspaceBinding' in request.body, false)
  }
  for (const request of [legacyCreate, legacyMessage, partialMessage]) {
    assert.equal('projectId' in request.body, false)
    assert.equal('workspaceId' in request.body, false)
    assert.equal('worktreeId' in request.body, false)
  }
  assert.equal(legacyCreate.body.jobId, 'job-test')
  assert.equal(legacyCreate.body.snapshotId, 'job-r1')
  assert.equal(legacyMessage.body.content, 'legacy message')
})

test('transport persists reasoning effort with the session model and reuses it for retry', () => {
  const script = `
    import { createDataCopilotTransport } from ${JSON.stringify(moduleUrl)};

    const requests = [];
    let selectedModel = { aiSessionId: 'model-test', reasoningEffort: 'high' };
    const conversation = () => ({
      conversationId: 'conversation-test',
      jobId: 'job-test',
      mode: 'application',
      snapshotId: 'job-r1',
      status: 'idle',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      selectedModel,
      scope: { contextSourceIds: ['job:job-test'] },
    });

    globalThis.fetch = async (input, init = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url: String(input), method: init.method || 'GET', body });
      if (body.selectedModel) selectedModel = { ...selectedModel, ...body.selectedModel };
      return {
        ok: true,
        status: 200,
        async json() {
          return { conversation: conversation(), messages: [] };
        },
      };
    };

    const transport = createDataCopilotTransport({
      jobId: 'job-test',
      mode: 'application',
      snapshotId: 'job-r1',
      aiSessionId: 'model-test',
      apiBaseUrl: 'http://copilot.test',
    });
    const created = await transport.createSession({
      modelId: 'model-test',
      reasoningEffort: 'high',
      contextSourceIds: ['job:job-test'],
    });
    const updated = await transport.updateSessionSettings('conversation-test', {
      modelId: 'model-test',
      reasoningEffort: 'max',
    });
    await transport.retryMessage('conversation-test', 'message-test', {
      modelId: 'model-test',
      reasoningEffort: 'max',
    });
    process.stdout.write(JSON.stringify({ requests, created, updated }));
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 },
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const captured = JSON.parse(result.stdout)
  const [createRequest, settingsRequest, retryRequest] = captured.requests

  assert.equal(createRequest.body.selectedModel.aiSessionId, 'model-test')
  assert.equal(createRequest.body.selectedModel.reasoningEffort, 'high')
  assert.equal(settingsRequest.method, 'PATCH')
  assert.deepEqual(settingsRequest.body.selectedModel, {
    aiSessionId: 'model-test',
    reasoningEffort: 'max',
  })
  assert.equal(retryRequest.body.aiSessionId, 'model-test')
  assert.equal(retryRequest.body.reasoningEffort, 'max')
  assert.equal(captured.created.reasoningEffort, 'high')
  assert.equal(captured.updated.reasoningEffort, 'max')
})

test('subagent reducer projects task output and tool lifecycle without duplicate nodes', () => {
  const run = project([
    {
      type: 'subagent.run.planned',
      runId: 'sub-run-1',
      parentRunId: 'main-run-1',
      conversationId: 'conversation-test',
      objective: '并行研究并汇总',
      planRevision: 2,
      createdAt: '2026-08-15T01:00:00.000Z',
      tasks: [
        { taskId: 'research', role: 'researcher', title: '研究数据', dependsOn: [] },
        { taskId: 'synthesis', role: 'writer', title: '汇总结论', dependsOn: ['research'] },
      ],
    },
    { type: 'subagent.run.started', runId: 'sub-run-1', parentRunId: 'main-run-1', createdAt: '2026-08-15T01:00:01.000Z' },
    { type: 'subagent.task.started', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', title: '研究数据', dependsOn: [], createdAt: '2026-08-15T01:00:02.000Z' },
    { type: 'subagent.task.started', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', title: '研究数据', dependsOn: [], createdAt: '2026-08-15T01:00:02.000Z' },
    { type: 'subagent.reasoning.delta', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', delta: '内部推理不进入聊天。', createdAt: '2026-08-15T01:00:02.500Z' },
    { type: 'subagent.output.delta', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', delta: '完成数据剖析。', createdAt: '2026-08-15T01:00:03.000Z' },
    { type: 'subagent.tool.call.delta', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'tool-1', argumentDeltaChars: 12, createdAt: '2026-08-15T01:00:03.500Z' },
    { type: 'subagent.tool.started', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'tool-1', createdAt: '2026-08-15T01:00:04.000Z' },
    { type: 'subagent.tool.completed', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'tool-1', createdAt: '2026-08-15T01:00:05.000Z' },
    { type: 'subagent.tool.completed', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', toolName: 'dataset.profile', toolCallId: 'tool-1', createdAt: '2026-08-15T01:00:05.000Z' },
    { type: 'subagent.task.completed', runId: 'sub-run-1', parentRunId: 'main-run-1', taskId: 'research', role: 'researcher', summary: '数据研究完成', createdAt: '2026-08-15T01:00:06.000Z' },
  ])

  assert.equal(run.runId, 'sub-run-1')
  assert.equal(run.parentRunId, 'main-run-1')
  assert.equal(run.planRevision, 2)
  assert.equal(run.status, 'running')
  assert.equal(run.tasks.length, 2)
  assert.equal(run.tasks[0].status, 'completed')
  assert.equal(run.tasks[0].output, '完成数据剖析。')
  assert.equal(run.tasks[0].tools.length, 1)
  assert.equal(run.tasks[0].tools[0].status, 'completed')
  assert.deepEqual(run.tasks[1].dependsOn, ['research'])
})

test('subagent reducer preserves task failure and terminal run status', () => {
  const run = project([
    {
      type: 'subagent.run.planned',
      runId: 'sub-run-2',
      conversationId: 'conversation-test',
      objective: '汇总任务',
      tasks: [{ taskId: 'synthesis', role: 'writer', title: '汇总结论', dependsOn: [] }],
      createdAt: '2026-08-15T02:00:00.000Z',
    },
    { type: 'subagent.task.started', runId: 'sub-run-2', taskId: 'synthesis', role: 'writer', title: '汇总结论', createdAt: '2026-08-15T02:00:01.000Z' },
    { type: 'subagent.task.failed', runId: 'sub-run-2', taskId: 'synthesis', role: 'writer', error: { code: 'INVALID_OUTPUT', message: '汇总校验失败' }, createdAt: '2026-08-15T02:00:02.000Z' },
    { type: 'subagent.run.failed', runId: 'sub-run-2', conversationId: 'conversation-test', status: 'failed', error: { code: 'SUBAGENT_FAILED', message: '子任务未全部完成' }, createdAt: '2026-08-15T02:00:03.000Z' },
    { type: 'subagent.run.receipt', runId: 'sub-run-2', conversationId: 'conversation-test', receipt: { status: 'failed' }, createdAt: '2026-08-15T02:00:04.000Z' },
  ])

  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'SUBAGENT_FAILED')
  assert.equal(run.tasks[0].status, 'failed')
  assert.equal(run.tasks[0].error.code, 'INVALID_OUTPUT')
  assert.equal(run.tasks[0].error.message, '汇总校验失败')
})

function createSubagentEventLog(totalEvents) {
  const common = {
    conversationId: 'conversation-test',
    runId: 'sub-run-replay',
    parentRunId: 'main-run-replay',
  }
  const events = [
    {
      ...common,
      eventId: 1,
      seq: 1,
      type: 'subagent.run.planned',
      objective: 'Replay a long child-agent run.',
      tasks: [{ taskId: 'research', role: 'researcher', title: 'Research', dependsOn: [] }],
    },
    {
      ...common,
      eventId: 2,
      seq: 2,
      type: 'subagent.task.started',
      taskId: 'research',
      role: 'researcher',
      title: 'Research',
    },
  ]
  for (let eventId = 3; eventId < totalEvents; eventId += 1) {
    events.push({
      ...common,
      eventId,
      seq: eventId,
      type: 'subagent.output.delta',
      taskId: 'research',
      role: 'researcher',
      delta: 'x',
    })
  }
  events.push({
    ...common,
    eventId: totalEvents,
    seq: totalEvents,
    type: 'subagent.task.completed',
    taskId: 'research',
    role: 'researcher',
    summary: 'Research complete.',
  })
  return events
}

function captureStreamedMessageBatches(deltaCount) {
  const script = `
    import { subscribeToConversation } from ${JSON.stringify(moduleUrl)};

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { conversationId: 'conversation-test', events: [], lastSeq: 0 };
      },
    });

    class MockEventSource {
      static CLOSED = 2;
      static instances = [];

      constructor() {
        this.readyState = 1;
        this.listeners = new Map();
        MockEventSource.instances.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(event) {
        const message = { data: JSON.stringify(event), lastEventId: String(event.eventId) };
        for (const listener of this.listeners.get(event.type) || []) listener(message);
      }

      close() {
        this.readyState = MockEventSource.CLOSED;
      }
    }
    globalThis.EventSource = MockEventSource;

    const batches = [];
    const errors = [];
    const stop = subscribeToConversation(
      (suffix = '') => 'http://copilot.test/api/copilot/conversations' + suffix,
      'conversation-test',
      {
        onMessages(messages) {
          batches.push(messages.map((message) => ({ id: message.id, content: message.content, status: message.status })));
        },
        onError(error) {
          errors.push(error.message);
        },
      },
    );

    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    for (let index = 0; index < 100 && MockEventSource.instances.length === 0; index += 1) await wait(5);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error('event stream did not open');
    for (let eventId = 1; eventId <= Number(process.env.COPILOT_DELTA_COUNT); eventId += 1) {
      source.emit({
        type: 'assistant.delta',
        eventId,
        seq: eventId,
        runId: 'run-stream',
        delta: 'x',
      });
    }
    await wait(50);
    stop();
    process.stdout.write(JSON.stringify({ batches, errors }));
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, COPILOT_DELTA_COUNT: String(deltaCount) },
    },
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

test('subscription batches a burst of streamed assistant deltas into one UI commit', () => {
  const result = captureStreamedMessageBatches(96)
  assert.deepEqual(result.errors, [])
  assert.equal(result.batches.length, 1)
  assert.deepEqual(result.batches[0], [{
    id: 'stream:run-stream',
    content: 'x'.repeat(96),
    status: 'streaming',
  }])
})

function subscribeScenario({ events, initialVisibleCount, sseEvents, expectedRunCalls }) {
  const script = `
    import { subscribeToConversation } from ${JSON.stringify(moduleUrl)};

    const allEvents = JSON.parse(process.env.COPILOT_REPLAY_EVENTS || '[]');
    const liveEvents = JSON.parse(process.env.COPILOT_SSE_EVENTS || '[]');
    const initialVisibleCount = Number(process.env.COPILOT_INITIAL_VISIBLE || allEvents.length);
    const expectedRunCalls = Number(process.env.COPILOT_EXPECTED_RUN_CALLS || 0);
    const requests = [];
    let streamCreated = false;

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const afterSeq = Number(url.searchParams.get('afterSeq') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      const visible = streamCreated ? allEvents : allEvents.slice(0, initialVisibleCount);
      const events = visible.filter((event) => event.eventId > afterSeq).slice(0, limit);
      requests.push({ afterSeq, limit, streamCreated });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            schemaVersion: 1,
            conversationId: 'conversation-test',
            events,
            nextSeq: events.at(-1)?.eventId || afterSeq,
            lastSeq: visible.at(-1)?.eventId || 0,
          };
        },
      };
    };

    class MockEventSource {
      static CLOSED = 2;
      static instances = [];

      constructor(url) {
        this.url = String(url);
        this.readyState = 1;
        this.listeners = new Map();
        streamCreated = true;
        MockEventSource.instances.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(event) {
        const message = { data: JSON.stringify(event), lastEventId: String(event.eventId || '') };
        for (const listener of this.listeners.get(event.type) || []) listener(message);
      }

      close() {
        this.readyState = MockEventSource.CLOSED;
      }
    }
    globalThis.EventSource = MockEventSource;

    let runCalls = 0;
    let finalRun;
    const errors = [];
    const stop = subscribeToConversation(
      (suffix = '') => 'http://copilot.test/api/copilot/conversations' + suffix,
      'conversation-test',
      {
        onMessage() {},
        onSubagentRun(run) {
          runCalls += 1;
          finalRun = run;
        },
        onError(error) {
          errors.push(error.message);
        },
      },
    );

    const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 400 && MockEventSource.instances.length === 0 && errors.length === 0; index += 1) {
      await wait();
    }
    const source = MockEventSource.instances[0];
    if (source) {
      for (const event of liveEvents) source.emit(event);
    } else {
      errors.push('event stream did not open');
    }
    for (let index = 0; index < 800 && runCalls < expectedRunCalls && errors.length === 0; index += 1) {
      await wait();
    }
    await wait();
    stop();
    process.stdout.write(JSON.stringify({
      requests,
      streamUrl: source?.url || '',
      runCalls,
      finalRun: finalRun ? {
        status: finalRun.status,
        taskStatus: finalRun.tasks[0]?.status,
        outputLength: finalRun.tasks[0]?.output.length,
      } : null,
      errors,
    }));
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        COPILOT_REPLAY_EVENTS: JSON.stringify(events),
        COPILOT_SSE_EVENTS: JSON.stringify(sseEvents),
        COPILOT_INITIAL_VISIBLE: String(initialVisibleCount),
        COPILOT_EXPECTED_RUN_CALLS: String(expectedRunCalls),
      },
    },
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

test('subscription cold start and refresh replay more than 250 persisted events before SSE without duplicates', () => {
  const events = createSubagentEventLog(321)
  const completed = {
    conversationId: 'conversation-test',
    runId: 'sub-run-replay',
    parentRunId: 'main-run-replay',
    eventId: 322,
    seq: 322,
    type: 'subagent.run.completed',
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = subscribeScenario({
      events,
      initialVisibleCount: events.length,
      sseEvents: [events.at(-1), completed, completed],
      expectedRunCalls: 322,
    })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.requests.map((request) => request.afterSeq), [0, 200])
    assert.match(result.streamUrl, /afterEventId=321/u)
    assert.equal(result.runCalls, 322)
    assert.deepEqual(result.finalRun, {
      status: 'completed',
      taskStatus: 'completed',
      outputLength: 318,
    })
  }
})

test('subscription repairs stream.gap from the durable log before projecting queued SSE events', () => {
  const events = createSubagentEventLog(320)
  const gap = {
    conversationId: 'conversation-test',
    eventId: 70,
    seq: 70,
    type: 'stream.gap',
    payload: { from: 3, to: 70, recovery: 'GET ?format=json&afterSeq=<cursor>' },
  }
  const result = subscribeScenario({
    events,
    initialVisibleCount: 2,
    sseEvents: [gap, events[69], ...events.slice(70), events.at(-1)],
    expectedRunCalls: 320,
  })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.requests.map((request) => request.afterSeq), [0, 2])
  assert.match(result.streamUrl, /afterEventId=2/u)
  assert.equal(result.runCalls, 320)
  assert.deepEqual(result.finalRun, {
    status: 'running',
    taskStatus: 'completed',
    outputLength: 317,
  })
})
