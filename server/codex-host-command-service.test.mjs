import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCodexHostCommandService } from './codex-host-command-service.mjs';

test('executes typed host recipes through one shared command handler', async () => {
  const sent = [];
  const workspaceRoot = resolve('.test-fixtures', 'workspace', 'project');
  const service = createCodexHostCommandService({
    config: { workspaceRoot },
    codexBrowserService: {
      send: async (message, context) => sent.push({ message, context }),
    },
  });

  await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'persist-1',
    message: { type: 'persisted-atom-update', key: 'sidebar', value: { open: true } },
  });
  const persisted = await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'persist-2',
    message: { type: 'persisted-atom-sync-request' },
  });
  assert.deepEqual(persisted.events[0].state, { sidebar: { open: true } });

  const fetched = await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'fetch-1',
    message: { type: 'fetch', requestId: 'request-1', url: 'vscode://codex/active-workspace-roots' },
  });
  assert.deepEqual(JSON.parse(fetched.events[0].bodyJsonString), [workspaceRoot]);
  assert.deepEqual(service.observedMessageTypes(), ['persisted-atom-update', 'persisted-atom-sync-request', 'fetch']);
  assert.equal(sent.length, 3);
  assert.equal(service.status().capabilities.recipes.find((recipe) => recipe.id === 'fetch').state, 'implemented');
  assert.equal(service.status().capabilities.recipes.find((recipe) => recipe.id === 'worker').state, 'implemented-core');
  assert.equal(service.status().capabilities.recipes.find((recipe) => recipe.id === 'clipboard').state, 'not-in-current-preload');
});

test('routes worker messages through the shared relay command path', async () => {
  const calls = [];
  const relayService = {
    sendStreamMessage: async (_streamId, { message }, forward) => forward({ sessionId: 'browser-a', message }),
  };
  const service = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    relayService,
    workerService: {
      capabilities: () => ({ workerIds: ['git'] }),
      status: () => ({ state: 'ready' }),
      handleMessage: async (workerId, message, context) => {
        calls.push({ workerId, message, context });
        return { accepted: true, workerId, messages: [] };
      },
    },
  });
  const result = await service.sendWorkerStream('stream-a', {
    relaySessionId: 'relay-a',
    commandId: 'worker-command-1',
    leaseEpoch: 3,
    workerId: 'git',
    message: { type: 'worker-request-cancel', workerId: 'git', id: 'request-1' },
  });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workerId, 'git');
  assert.equal(calls[0].context.sessionId, 'browser-a');
  assert.ok(service.capabilities().methods.includes('host.worker.send'));
});

test('deduplicates the same command id across websocket and HTTP relay retries', async () => {
  let forwarded = 0;
  const relayService = {
    sendStreamMessage: async (_streamId, { message }, forward) => forward({ sessionId: 'browser-a', message }),
    send: async (_sessionId, { message }, forward) => forward({ sessionId: 'browser-a', message }),
  };
  const service = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    relayService,
    codexBrowserService: {
      send: async () => { forwarded += 1; },
    },
  });
  const command = {
    relaySessionId: 'relay-a',
    commandId: 'command-shared-1',
    leaseEpoch: 1,
    message: { type: 'fetch', requestId: 'request-1', url: 'vscode://codex/is-packaged' },
  };

  const websocketResult = await service.sendStream('stream-a', command);
  const httpResult = await service.sendRelay('relay-a', command);

  assert.deepEqual(httpResult, websocketResult);
  assert.equal(forwarded, 1);
  assert.equal(service.status().commandRequests, 2);
  assert.equal(service.status().commandsExecuted, 1);
  assert.equal(service.status().deduplicatedCommands, 1);
});

test('rejects invalid command ids before forwarding', async () => {
  let forwarded = false;
  const service = createCodexHostCommandService({
    config: { workspaceRoot: 'C:\\workspace' },
    codexBrowserService: { send: async () => { forwarded = true; } },
  });
  await assert.rejects(
    service.sendLegacy({ sessionId: 'browser-a', commandId: 'contains spaces', message: { type: 'fetch' } }),
    (error) => error.code === 'CODEX_HOST_COMMAND_ID_INVALID',
  );
  assert.equal(forwarded, false);
});

test('hydrates the Codex sidebar with the product source and historical task workspaces', async () => {
  const sourceRoot = resolve('.test-fixtures', 'workspace', 'project');
  const historyRoot = resolve('.test-fixtures', 'workspace', 'data', 'jobs', 'task-a');
  const workspaceService = {
    status: () => ({ available: true, historyProjects: 1 }),
    developerInstructions: () => 'Use the product MCP and edit the source workspace.',
    hostState: (selectedProjectId = '') => {
      const source = { id: 'source', name: 'Product source', rootPaths: [sourceRoot] };
      const history = { id: 'job-a', name: 'Task A', rootPaths: [historyRoot] };
      const selected = selectedProjectId === history.id ? history : source;
      return {
        source,
        history: [history],
        projects: { source, [history.id]: history },
        projectOrder: ['source', history.id],
        selectedProject: { type: 'local', projectId: selected.id },
        activeWorkspaceRoots: selected.rootPaths,
        workspaceRoots: [sourceRoot, historyRoot],
        workspaceRootLabels: { [sourceRoot]: source.name, [historyRoot]: history.name },
        selectedProjectRoot: selected.rootPaths[0],
      };
    },
  };
  const service = createCodexHostCommandService({
    config: { workspaceRoot: sourceRoot },
    workspaceService,
    codexBrowserService: { send: async () => {} },
  });
  const projects = await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'workspace-projects',
    message: { type: 'fetch', requestId: 'projects', url: 'vscode://codex/get-global-state', body: JSON.stringify({ key: 'local-projects' }) },
  });
  const projectMap = JSON.parse(projects.events[0].bodyJsonString).value;
  assert.deepEqual(Object.keys(projectMap), ['source', 'job-a']);

  await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'workspace-select',
    message: { type: 'fetch', requestId: 'select', url: 'vscode://codex/set-global-state', body: JSON.stringify({ key: 'selected-project', value: { type: 'local', projectId: 'job-a' } }) },
  });
  const roots = await service.sendLegacy({
    sessionId: 'browser-a',
    commandId: 'workspace-roots',
    message: { type: 'fetch', requestId: 'roots', url: 'vscode://codex/active-workspace-roots' },
  });
  assert.deepEqual(JSON.parse(roots.events[0].bodyJsonString), [historyRoot]);
});

test('starts an interactive browser-owned task in the selected product workspace', async () => {
  const sourceRoot = resolve('.test-fixtures', 'workspace', 'product');
  const historyRoot = resolve('.test-fixtures', 'workspace', 'data', 'jobs', 'task-a');
  const requests = [];
  const workspaceService = {
    developerInstructions: () => 'Use the product MCP.',
    project: (id) => id === 'job-a'
      ? {
        id,
        kind: 'job-history',
        name: 'Task A',
        rootPaths: [historyRoot],
        metadata: { jobId: 'task-a', writable: false },
      }
      : null,
  };
  const service = createCodexHostCommandService({
    config: { workspaceRoot: sourceRoot },
    workspaceService,
    codexBrowserService: {
      request: async (method, params) => {
        requests.push({ method, params });
        return { thread: { id: 'browser-owned-task' }, model: 'gpt-test', cwd: historyRoot };
      },
    },
  });

  const started = await service.startWorkspaceThread('job-a');
  assert.equal(started.accepted, true);
  assert.equal(started.thread.id, 'browser-owned-task');
  assert.equal(started.thread.name, 'Task A - Analysis');
  assert.equal(started.project.jobId, 'task-a');
  assert.equal(requests[0].method, 'threads.start');
  assert.equal(requests[0].params.cwd, historyRoot);
  assert.equal(requests[0].params.sandbox, 'read-only');
  assert.match(requests[0].params.developerInstructions, /job task-a/u);
  assert.deepEqual(requests[1], {
    method: 'thread/name/set',
    params: { threadId: 'browser-owned-task', name: 'Task A - Analysis' },
  });
});

test('starts a writable browser-owned task in the product source workspace', async () => {
  const sourceRoot = resolve('.test-fixtures', 'workspace', 'product');
  const requests = [];
  const service = createCodexHostCommandService({
    config: { workspaceRoot: sourceRoot },
    workspaceService: {
      developerInstructions: () => 'Use the product MCP.',
      project: (id) => id === 'source'
        ? {
          id,
          kind: 'source',
          name: 'Product source',
          rootPaths: [sourceRoot],
          metadata: { writable: true },
        }
        : null,
    },
    codexBrowserService: {
      request: async (method, params) => {
        requests.push({ method, params });
        return { thread: { id: 'browser-owned-source' }, cwd: sourceRoot };
      },
    },
  });

  const started = await service.startWorkspaceThread('source');
  assert.equal(started.project.writable, true);
  assert.equal(requests[0].params.sandbox, 'workspace-write');
  assert.match(requests[0].params.developerInstructions, /make source changes/u);
  assert.equal(requests[1].method, 'thread/name/set');
});
