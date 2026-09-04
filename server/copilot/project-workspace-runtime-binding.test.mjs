import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { CopilotApprovalStore } from '../copilot-approval-store.mjs';
import { CopilotArtifactService } from '../copilot-artifact-service.mjs';
import { DataCopilotRuntime } from '../data-copilot-runtime.mjs';
import { DataCopilotService } from '../data-copilot-service.mjs';
import { DataCopilotStore } from '../data-copilot-store.mjs';
import { DataPolicyEngine } from '../data-policy-engine.mjs';
import { GitToolAdapter } from './git-tool-adapter.mjs';
import { createProjectWorkspaceService } from './project-workspace-service.mjs';
import { WorkspaceToolAdapter } from './workspace-tool-adapter.mjs';

const execFile = promisify(execFileCallback);

const JOB = Object.freeze({
  id: 'job-workspace-runtime-001',
  revision: 1,
  title: 'Project workspace runtime contract',
  status: 'completed',
});

const LOCAL_SECURITY = Object.freeze({ actorId: 'local-owner', trustedLocal: true, ownerLocal: true });
const REMOTE_SECURITY = Object.freeze({ actorId: 'remote-user', trustedLocal: false, ownerLocal: false });

function chatResponse(message) {
  return {
    ok: true,
    status: 200,
    async json() { return { choices: [{ message }] }; },
  };
}

function chatTool(name, input, id) {
  return chatResponse({
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name: `copilot_${name.replaceAll('.', '__')}`,
        arguments: JSON.stringify(input),
      },
    }],
  });
}

function queuedFetch(responses, requests) {
  return async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const response = responses.shift();
    assert.ok(response, 'The runtime sent an unexpected model request.');
    return response;
  };
}

async function waitForStatus(service, conversationId, expected, timeoutMs = 10_000) {
  const wanted = new Set(Array.isArray(expected) ? expected : [expected]);
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await service.getConversation(conversationId);
    if (wanted.has(current.conversation.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    `Timed out waiting for ${[...wanted].join(', ')}; current=${current?.conversation?.status || 'missing'}; `
      + `error=${current?.conversation?.runState?.errorCode || ''}.`,
  );
}

async function fixture(t, responses) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-workspace-runtime-'));
  const projectRoot = path.join(rootDir, 'project');
  await mkdir(projectRoot, { recursive: true });
  await execFile('git', ['init', '-q', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'config', 'user.email', 'workspace-runtime@example.test']);
  await execFile('git', ['-C', projectRoot, 'config', 'user.name', 'Workspace Runtime Test']);
  await writeFile(path.join(projectRoot, 'README.md'), 'workspace runtime fixture\n');
  await execFile('git', ['-C', projectRoot, 'add', 'README.md']);
  await execFile('git', ['-C', projectRoot, 'commit', '-qm', 'Initialize workspace runtime fixture']);
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  let id = 0;
  const manager = {
    get: (jobId) => (jobId === JOB.id ? JOB : null),
    getInternal: (jobId) => (jobId === JOB.id ? JOB : null),
    list: () => [JOB],
  };
  const store = new DataCopilotStore({ rootDir, idFactory: () => `store-${++id}` });
  const approvals = new CopilotApprovalStore({ rootDir, idFactory: () => `approval-${++id}` });
  const artifacts = new CopilotArtifactService({ rootDir });
  const policy = new DataPolicyEngine({ manager });
  const globalRegistry = {
    list: () => [{
      name: 'records.query',
      source: 'data',
      description: 'This data tool must not be exposed to a project-bound model run.',
      inputSchema: { type: 'object', additionalProperties: true },
      risk: 'read',
    }],
    get: (name) => (name === 'records.query' ? globalRegistry.list()[0] : null),
    async execute() {
      throw new Error('A project-bound model run must never execute the global data registry.');
    },
  };
  const requests = [];
  const runtime = new DataCopilotRuntime({
    store,
    approvals,
    registry: globalRegistry,
    aiSessions: {
      resolve(sessionId) {
        assert.equal(sessionId, 'workspace-runtime-session');
        return {
          id: sessionId,
          provider: 'openai_compatible',
          model: 'workspace-runtime-model',
          wireApi: 'chat_completions',
          baseUrl: 'http://provider.example.test/v1',
          apiKey: 'workspace-runtime-secret',
        };
      },
    },
    fetchImpl: queuedFetch(responses, requests),
    idFactory: () => `runtime-${++id}`,
    approvalMode: 'required',
  });
  const workspaceAdapter = new WorkspaceToolAdapter({ workspaceRoot: projectRoot });
  const gitAdapter = new GitToolAdapter({ workspaceRoot: projectRoot });
  const projectWorkspaceService = createProjectWorkspaceService({
    rootDir: path.join(rootDir, 'project-state'),
    allowedRoots: [projectRoot],
  });
  const service = new DataCopilotService({
    rootDir,
    store,
    approvals,
    artifacts,
    runtime,
    policy,
    manager,
    workspaceAdapter,
    gitAdapter,
    projectWorkspaceService,
  });
  await service.initialize();

  const project = await service.createProject({
    id: 'runtime-project',
    name: 'Runtime project',
    rootPath: projectRoot,
  }, LOCAL_SECURITY);
  const workspace = await service.createProjectWorkspace(project.project.id, {
    id: 'runtime-shared',
    name: 'Runtime shared workspace',
  }, LOCAL_SECURITY);
  const conversation = await service.createConversation({
    conversationId: `workspace-conversation-${++id}`,
    jobId: JOB.id,
    mode: 'application',
    title: 'Bound workspace conversation',
    aiSessionId: 'workspace-runtime-session',
    idempotencyKey: `create-workspace-conversation-${id}`,
  });
  return {
    projectRoot,
    projectId: project.project.id,
    workspaceId: workspace.workspace.id,
    conversationId: conversation.conversation.conversationId,
    requests,
    service,
  };
}

function wireToolNames(request) {
  return (request?.tools || []).map((tool) => String(tool?.function?.name || tool?.name || ''));
}

test('a trusted project-bound model run sees only its workspace and automatically writes there', async (t) => {
  const { projectRoot, projectId, workspaceId, conversationId, requests, service } = await fixture(t, [
    chatTool('workspace.write', { path: 'notes/result.txt', content: 'bound workspace content' }, 'call-bound-write'),
    chatResponse({ content: 'Created notes/result.txt and verified the project workspace change.' }),
  ]);

  await service.sendMessage(conversationId, {
    content: 'Create notes/result.txt with the requested content, then verify it.',
    aiSessionId: 'workspace-runtime-session',
    workspaceMode: 'build',
    projectId,
    workspaceId,
    idempotencyKey: 'bound-workspace-message-001',
  }, {
    actorId: 'local-owner',
    trustedLocal: true,
    ownerLocal: true,
  });

  const completed = await waitForStatus(service, conversationId, 'completed');
  assert.equal(await readFile(path.join(projectRoot, 'notes', 'result.txt'), 'utf8'), 'bound workspace content');
  assert.equal(completed.approvals.length, 0);
  assert.ok(requests.length >= 2);
  assert.ok(wireToolNames(requests[0]).includes('copilot_workspace__write'));
  assert.ok(!wireToolNames(requests[0]).includes('copilot_records__query'));

  const runs = await service.listRuns(conversationId, { limit: 100 });
  const planning = runs.runs.find((run) => run.event === 'planning');
  assert.deepEqual(planning?.metadata?.workspaceBinding, {
    projectId,
    workspaceId,
    authority: { profile: 'owner_local_full', trustedLocal: true },
  });
  const toolRuns = await service.store.listToolRuns({
    conversationId,
    jobId: JOB.id,
    snapshotId: 'job-r1',
    mode: 'application',
    scope: { allowedScopes: ['*'], contextSourceIds: [], jobRevision: 1 },
  }, { limit: 100 });
  assert.equal(toolRuns.filter((run) => run.toolName === 'workspace.write' && run.status === 'succeeded').length, 1);
  assert.equal((await service.getProjectWorkspace(projectId, workspaceId, {}, LOCAL_SECURITY)).workspace.lease, null);
});

test('a remote connection cannot bind a project workspace to a model run', async (t) => {
  const { projectRoot, projectId, workspaceId, conversationId, requests, service } = await fixture(t, [
    chatTool('workspace.write', { path: 'blocked.txt', content: 'must not be written' }, 'call-remote-write'),
  ]);

  await assert.rejects(
    () => service.sendMessage(conversationId, {
      content: 'Write blocked.txt.',
      aiSessionId: 'workspace-runtime-session',
      workspaceMode: 'build',
      projectId,
      workspaceId,
      idempotencyKey: 'remote-workspace-message-001',
    }, REMOTE_SECURITY),
    (error) => error?.code === 'COPILOT_WORKSPACE_LOCAL_REQUIRED',
  );

  assert.equal(requests.length, 0);
  await assert.rejects(readFile(path.join(projectRoot, 'blocked.txt'), 'utf8'));
  assert.equal((await service.getProjectWorkspace(projectId, workspaceId, {}, LOCAL_SECURITY)).workspace.lease, null);
});

test('a project-bound model run discovers and executes Git tools inside its selected worktree', async (t) => {
  const { projectId, conversationId, requests, service } = await fixture(t, [
    chatTool('git.status', {}, 'call-bound-git-status'),
    chatResponse({ content: 'The selected project worktree is clean and its Git status was verified.' }),
  ]);
  const worktree = await service.createProjectWorkspace(projectId, {
    id: 'runtime-git-worktree',
    name: 'Runtime Git worktree',
    kind: 'worktree',
    branch: 'agent/runtime-git-status',
    baseRef: 'HEAD',
  }, LOCAL_SECURITY);
  const workspaceId = worktree.workspace.id;

  await service.sendMessage(conversationId, {
    content: 'Inspect the Git status of this project worktree and report the result.',
    aiSessionId: 'workspace-runtime-session',
    workspaceMode: 'build',
    projectId,
    workspaceId,
    worktreeId: workspaceId,
    idempotencyKey: 'bound-workspace-git-status-001',
  }, LOCAL_SECURITY);

  const completed = await waitForStatus(service, conversationId, 'completed');
  assert.equal(completed.approvals.length, 0);
  assert.ok(requests.length >= 2);
  assert.ok(wireToolNames(requests[0]).includes('copilot_git__status'));
  assert.ok(!wireToolNames(requests[0]).includes('copilot_records__query'));

  const toolRuns = await service.store.listToolRuns({
    conversationId,
    jobId: JOB.id,
    snapshotId: 'job-r1',
    mode: 'application',
    scope: { allowedScopes: ['*'], contextSourceIds: [], jobRevision: 1 },
  }, { limit: 100 });
  assert.equal(toolRuns.filter((run) => run.toolName === 'git.status' && run.status === 'succeeded').length, 1);
  const selected = await service.getProjectWorkspace(projectId, workspaceId, { includeStatus: true }, LOCAL_SECURITY);
  assert.equal(selected.workspace.kind, 'worktree');
  assert.equal(selected.workspace.lease, null);
  assert.equal(selected.status?.dirty, false);
});
