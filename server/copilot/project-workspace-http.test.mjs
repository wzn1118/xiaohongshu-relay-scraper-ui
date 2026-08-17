import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { CopilotApprovalStore } from '../copilot-approval-store.mjs';
import { CopilotArtifactService } from '../copilot-artifact-service.mjs';
import { handleDataCopilotRequest } from '../data-copilot-http.mjs';
import { DataCopilotService } from '../data-copilot-service.mjs';
import { DataCopilotStore } from '../data-copilot-store.mjs';
import { DataPolicyEngine } from '../data-policy-engine.mjs';
import { DataToolRegistry } from '../data-tool-registry.mjs';
import { createExecutionDispatcher } from './execution-dispatcher.mjs';
import { createProjectWorkspaceService } from './project-workspace-service.mjs';
import { createRuntimeV3Repository } from './runtime-v3/index.mjs';
import { createToolExecutionBroker } from './tool-execution-broker.mjs';
import { GitToolAdapter } from './git-tool-adapter.mjs';
import { WorkspaceToolAdapter } from './workspace-tool-adapter.mjs';

const LOCAL_SECURITY = Object.freeze({ actorId: 'local-owner', trustedLocal: true, ownerLocal: true });
const OTHER_LOCAL_SECURITY = Object.freeze({ actorId: 'another-local-owner', trustedLocal: true, ownerLocal: true });
const REMOTE_SECURITY = Object.freeze({ actorId: 'remote-user', trustedLocal: false, ownerLocal: false });
const execFile = promisify(execFileCallback);

async function fixture(t, { git = false } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-project-http-'));
  const projectRoot = path.join(rootDir, 'project');
  await mkdir(projectRoot, { recursive: true });
  if (git) await initializeGitRepository(projectRoot);
  let closeDurableBroker = async () => {};
  t.after(async () => {
    await closeDurableBroker();
    await rm(rootDir, { recursive: true, force: true });
  });

  const manager = { get: () => null, getInternal: () => null, list: () => [] };
  const store = new DataCopilotStore({ rootDir });
  const approvals = new CopilotApprovalStore({ rootDir });
  const artifacts = new CopilotArtifactService({ rootDir });
  const policy = new DataPolicyEngine({ manager });
  const dataRegistry = new DataToolRegistry({ manager, policy, artifactService: artifacts });
  const runtime = {
    registry: dataRegistry,
    emit: () => {},
    describeCapabilities: () => ({ schemaVersion: 1, toolCatalog: { total: dataRegistry.list().length, categories: [] } }),
  };
  const workspaceAdapter = new WorkspaceToolAdapter({ workspaceRoot: projectRoot });
  const gitAdapter = git ? new GitToolAdapter({ workspaceRoot: projectRoot }) : null;
  const runtimeV3Repository = createRuntimeV3Repository({ rootDir: path.join(rootDir, 'runtime-v3') });
  const executionDispatcher = createExecutionDispatcher({
    repository: runtimeV3Repository,
    workerId: 'project-workspace-http-worker',
  });
  const toolExecutionBroker = createToolExecutionBroker({
    repository: runtimeV3Repository,
    dispatcher: executionDispatcher,
  });
  closeDurableBroker = async () => {
    await toolExecutionBroker.close();
    executionDispatcher.close();
    runtimeV3Repository.close();
  };
  const projectWorkspaceService = createProjectWorkspaceService({
    rootDir: path.join(rootDir, 'state'),
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
    runtimeV3Repository,
    toolExecutionBroker,
  });
  await service.initialize();

  const server = createServer(async (req, res) => {
    await handleDataCopilotRequest({
      req,
      res,
      url: new URL(req.url || '/', 'http://localhost'),
      service,
      maxBodyBytes: 128 * 1024,
      securityContext: req.headers['x-test-remote'] === '1'
        ? REMOTE_SECURITY
        : req.headers['x-test-other-local'] === '1'
          ? OTHER_LOCAL_SECURITY
          : LOCAL_SECURITY,
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    projectRoot,
    service,
    toolExecutionBroker,
    executionDispatcher,
  };
}

async function initializeGitRepository(root) {
  await execFile('git', ['init', '-q', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'project-workspace@example.test']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Project Workspace Test']);
  await writeFile(path.join(root, 'README.md'), 'project workspace fixture\n');
  await execFile('git', ['-C', root, 'add', 'README.md']);
  await execFile('git', ['-C', root, 'commit', '-qm', 'Initialize project workspace fixture']);
}

async function request(baseUrl, pathname, { method = 'GET', body, remote = false, otherLocal = false, idempotencyKey = '' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(remote ? { 'x-test-remote': '1' } : {}),
      ...(otherLocal ? { 'x-test-other-local': '1' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForToolExecution(baseUrl, projectId, workspaceId, toolExecutionId, {
  timeoutMs = 8_000,
  intervalMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let response;
  do {
    response = await request(
      baseUrl,
      `/api/copilot/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/tool-executions/${encodeURIComponent(toolExecutionId)}`,
    );
    if (['completed', 'failed', 'cancelled', 'reconcile_required'].includes(response.body.receipt?.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for tool execution ${toolExecutionId}.`);
}

test('project workspace API scopes file and command execution to the created workspace', async (t) => {
  const { baseUrl, projectRoot, service, toolExecutionBroker } = await fixture(t);
  const projectResponse = await request(baseUrl, '/api/copilot/projects', {
    method: 'POST',
    body: { id: 'demo-project', name: 'Demo project', rootPath: projectRoot },
  });
  assert.equal(projectResponse.status, 201);
  assert.equal(projectResponse.body.project.id, 'demo-project');

  const workspaceResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces', {
    method: 'POST',
    body: { id: 'shared-main', name: 'Shared main', kind: 'shared' },
  });
  assert.equal(workspaceResponse.status, 201);
  assert.equal(workspaceResponse.body.workspace.rootPath, projectRoot);

  const writeResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/workspace.write', {
    method: 'POST',
    body: { path: 'src/hello.txt', content: 'hello workspace' },
    idempotencyKey: 'workspace-write-once',
  });
  assert.equal(writeResponse.status, 202);
  assert.ok(['queued', 'running'].includes(writeResponse.body.receipt.status));
  const completedWrite = await waitForToolExecution(
    baseUrl,
    'demo-project',
    'shared-main',
    writeResponse.body.receipt.toolExecutionId,
  );
  assert.equal(completedWrite.status, 200);
  assert.equal(completedWrite.body.receipt.status, 'completed');
  assert.equal(completedWrite.body.receipt.result.path, 'src/hello.txt');
  assert.equal(await readFile(path.join(projectRoot, 'src', 'hello.txt'), 'utf8'), 'hello workspace');

  const executionLedger = completedWrite.body.receipt.executionLedger;
  assert.ok(executionLedger);
  assert.equal(executionLedger.executionId, completedWrite.body.receipt.executionId);
  assert.deepEqual(executionLedger.environment, {
    kind: 'project_workspace',
    projectId: 'demo-project',
    workspaceId: 'shared-main',
  });
  assert.equal(executionLedger.step.kind, 'tool.call');
  assert.equal(executionLedger.step.status, 'succeeded');
  assert.equal(executionLedger.effect.status, 'committed');
  assert.equal(executionLedger.authority.profile, 'owner_local_full');
  assert.ok(executionLedger.authority.grantId);
  assert.equal('actorId' in executionLedger.authority, false);
  assert.ok(executionLedger.artifacts.some((artifact) => artifact.kind === 'tool.input.digest'));
  assert.ok(executionLedger.artifacts.some((artifact) => artifact.kind === 'tool.output.digest'));
  assert.equal(JSON.stringify(executionLedger).includes('hello workspace'), false);
  assert.equal(JSON.stringify(executionLedger).includes(projectRoot), false);

  const durableLedger = {
    steps: toolExecutionBroker.repository.listExecutionSteps({
      executionId: completedWrite.body.receipt.executionId,
    }),
    effects: toolExecutionBroker.repository.listExecutionEffects({
      executionId: completedWrite.body.receipt.executionId,
    }),
    artifacts: toolExecutionBroker.repository.listExecutionArtifacts({
      executionId: completedWrite.body.receipt.executionId,
    }),
    grants: toolExecutionBroker.repository.listAuthorityGrants({
      executionId: completedWrite.body.receipt.executionId,
    }),
  };
  assert.equal(durableLedger.steps.length, 1);
  assert.equal(durableLedger.effects.length, 1);
  assert.equal(durableLedger.grants.length, 1);
  assert.equal(durableLedger.steps[0].status, 'succeeded');
  assert.match(durableLedger.steps[0].resultRef, /^runtime-v3:\/\/executions\//u);
  assert.equal(durableLedger.effects[0].status, 'committed');
  assert.match(durableLedger.effects[0].postStateRef, /^runtime-v3:\/\/executions\//u);
  assert.match(durableLedger.effects[0].receiptRef, /^runtime-v3:\/\/executions\//u);
  assert.ok(durableLedger.artifacts.some((artifact) => artifact.kind === 'tool.input.digest'));
  assert.ok(durableLedger.artifacts.some((artifact) => artifact.kind === 'tool.output.digest'));
  assert.equal(JSON.stringify(durableLedger.artifacts).includes('hello workspace'), false);
  assert.equal(JSON.stringify(durableLedger.artifacts).includes(projectRoot), false);

  const duplicateWriteResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/workspace.write', {
    method: 'POST',
    body: { path: 'src/hello.txt', content: 'hello workspace' },
    idempotencyKey: 'workspace-write-once',
  });
  assert.equal(duplicateWriteResponse.status, 200);
  assert.equal(duplicateWriteResponse.body.receipt.toolExecutionId, writeResponse.body.receipt.toolExecutionId);

  assert.equal(completedWrite.body.receipt.toolExecutionId, writeResponse.body.receipt.toolExecutionId);
  assert.deepEqual(completedWrite.body.events.map((event) => event.type), [
    'tool.execution.started',
    'tool.execution.completed',
  ]);

  const conflictingWriteResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/workspace.write', {
    method: 'POST',
    body: { path: 'src/hello.txt', content: 'different content' },
    idempotencyKey: 'workspace-write-once',
  });
  assert.equal(conflictingWriteResponse.status, 409);
  assert.equal(conflictingWriteResponse.body.error.code, 'TOOL_EXECUTION_IDEMPOTENCY_CONFLICT');
  assert.equal(await readFile(path.join(projectRoot, 'src', 'hello.txt'), 'utf8'), 'hello workspace');

  const readResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/workspace.read', {
    method: 'POST',
    body: { path: 'src/hello.txt' },
  });
  assert.equal(readResponse.status, 202);
  const completedRead = await waitForToolExecution(
    baseUrl,
    'demo-project',
    'shared-main',
    readResponse.body.receipt.toolExecutionId,
  );
  assert.equal(completedRead.body.receipt.status, 'completed');
  assert.equal(completedRead.body.receipt.result.content, 'hello workspace');

  const commandResponse = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/exec.run', {
    method: 'POST',
    body: { command: process.execPath, args: ['-e', 'process.stdout.write("workspace-command-ok")'] },
  });
  assert.equal(commandResponse.status, 202);
  const completedCommand = await waitForToolExecution(
    baseUrl,
    'demo-project',
    'shared-main',
    commandResponse.body.receipt.toolExecutionId,
  );
  assert.equal(completedCommand.body.receipt.status, 'completed');
  assert.equal(completedCommand.body.receipt.result.exitCode, 0);
  assert.match(completedCommand.body.receipt.result.stdout, /workspace-command-ok/u);

  const timeoutStartedAt = Date.now();
  const timedCommand = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/exec.run', {
    method: 'POST',
    body: {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("too-late"), 1000)'],
      timeoutMs: 100,
    },
    idempotencyKey: 'workspace-command-timeout',
  });
  assert.equal(timedCommand.status, 202);
  const timedCompletion = await waitForToolExecution(
    baseUrl,
    'demo-project',
    'shared-main',
    timedCommand.body.receipt.toolExecutionId,
  );
  assert.equal(timedCompletion.body.receipt.status, 'completed');
  assert.equal(timedCompletion.body.receipt.result.status, 'timed_out');
  assert.equal(timedCompletion.body.receipt.result.timeoutMs, 100);
  assert.ok(Date.now() - timeoutStartedAt < 2_000);

  const cancellableCommand = await request(baseUrl, '/api/copilot/projects/demo-project/workspaces/shared-main/tools/exec.run', {
    method: 'POST',
    body: {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("should-not-complete"), 5000)'],
      timeoutMs: 10_000,
    },
    idempotencyKey: 'workspace-cancellable-command',
  });
  assert.equal(cancellableCommand.status, 202);
  const cancelled = await request(
    baseUrl,
    `/api/copilot/projects/demo-project/workspaces/shared-main/tool-executions/${encodeURIComponent(cancellableCommand.body.receipt.toolExecutionId)}/cancel`,
    { method: 'POST', body: { reason: 'test_cancel' } },
  );
  assert.ok([200, 202].includes(cancelled.status));
  const cancelledCommand = await waitForToolExecution(
    baseUrl,
    'demo-project',
    'shared-main',
    cancellableCommand.body.receipt.toolExecutionId,
  );
  assert.equal(cancelledCommand.body.receipt.status, 'cancelled');
  assert.ok(cancelledCommand.body.events.some((event) => event.type === 'tool.execution.cancel_requested'));
  assert.ok(cancelledCommand.body.events.some((event) => event.type === 'tool.execution.cancelled'));
  assert.equal(cancelledCommand.body.receipt.executionLedger.step.status, 'cancelled');
  assert.equal(cancelledCommand.body.receipt.executionLedger.effect.status, 'unknown');

  const workbenchCommandResponse = await request(baseUrl, '/api/copilot/workbench/tools/exec.run', {
    method: 'POST',
    body: {
      projectId: 'demo-project',
      workspaceId: 'shared-main',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("workbench-project-command-ok")'],
    },
  });
  assert.equal(workbenchCommandResponse.status, 200);
  assert.equal(workbenchCommandResponse.body.receipt.type, 'capability.receipt');
  assert.equal(workbenchCommandResponse.body.receipt.status, 'completed');
  assert.match(workbenchCommandResponse.body.receipt.result.stdout, /workbench-project-command-ok/u);
  assert.equal(workbenchCommandResponse.body.receipt.durable.status, 'succeeded');
  assert.equal('inputHash' in workbenchCommandResponse.body.receipt.durable, false);
  assert.ok(workbenchCommandResponse.body.receipt.toolExecutionId);
  const durableReceipt = toolExecutionBroker.get(workbenchCommandResponse.body.receipt.toolExecutionId);
  assert.equal(durableReceipt.status, 'succeeded');
  const durableEvents = toolExecutionBroker.repository.listEvents({
    streamId: `execution:${workbenchCommandResponse.body.receipt.runId}:tool:${durableReceipt.toolExecutionId}`,
  });
  assert.deepEqual(durableEvents.map((event) => event.type), [
    'tool.execution.started',
    'tool.execution.completed',
  ]);

  const workspace = (await service.getProjectWorkspace('demo-project', 'shared-main', {}, LOCAL_SECURITY)).workspace;
  assert.equal(workspace.lease, null);
});

test('project workspace API executes the scoped Git branch lifecycle', async (t) => {
  const { baseUrl, projectRoot } = await fixture(t, { git: true });
  const project = await request(baseUrl, '/api/copilot/projects', {
    method: 'POST',
    body: { id: 'git-project', name: 'Git project', rootPath: projectRoot },
  });
  assert.equal(project.status, 201);
  const workspace = await request(baseUrl, '/api/copilot/projects/git-project/workspaces', {
    method: 'POST',
    body: { id: 'git-main', name: 'Git main', kind: 'shared' },
  });
  assert.equal(workspace.status, 201);

  const before = await request(baseUrl, '/api/copilot/projects/git-project/workspaces/git-main/tools/git.branch', {
    method: 'POST',
    body: {},
  });
  assert.equal(before.status, 202);
  const initialBranches = await waitForToolExecution(
    baseUrl,
    'git-project',
    'git-main',
    before.body.receipt.toolExecutionId,
  );
  assert.equal(initialBranches.body.receipt.status, 'completed');
  const initialBranch = initialBranches.body.receipt.result.current;
  assert.ok(initialBranch);

  const created = await request(baseUrl, '/api/copilot/projects/git-project/workspaces/git-main/tools/git.branch.create', {
    method: 'POST',
    body: { name: 'codex/project-workspace', checkout: true },
    idempotencyKey: 'create-project-workspace-branch',
  });
  assert.equal(created.status, 202);
  const completedCreation = await waitForToolExecution(
    baseUrl,
    'git-project',
    'git-main',
    created.body.receipt.toolExecutionId,
  );
  assert.equal(completedCreation.body.receipt.status, 'completed');
  assert.equal(completedCreation.body.receipt.result.type, 'git.branch.create.receipt');
  assert.equal(completedCreation.body.receipt.result.current, 'codex/project-workspace');
  assert.equal(completedCreation.body.receipt.result.branch.current, true);

  const switched = await request(baseUrl, '/api/copilot/projects/git-project/workspaces/git-main/tools/git.branch.switch', {
    method: 'POST',
    body: { name: initialBranch },
    idempotencyKey: 'switch-project-workspace-branch',
  });
  assert.equal(switched.status, 202);
  const completedSwitch = await waitForToolExecution(
    baseUrl,
    'git-project',
    'git-main',
    switched.body.receipt.toolExecutionId,
  );
  assert.equal(completedSwitch.body.receipt.status, 'completed');
  assert.equal(completedSwitch.body.receipt.result.type, 'git.branch.switch.receipt');
  assert.equal(completedSwitch.body.receipt.result.current, initialBranch);
});

test('a non-local connection cannot enumerate or mutate a project workspace', async (t) => {
  const { baseUrl, projectRoot, service } = await fixture(t);
  const project = await service.createProject({ id: 'remote-project', name: 'Remote project', rootPath: projectRoot }, LOCAL_SECURITY);
  const workspace = await service.createProjectWorkspace(project.project.id, { id: 'remote-shared', name: 'Remote shared' }, LOCAL_SECURITY);
  assert.throws(
    () => service.listProjects({}, REMOTE_SECURITY),
    (error) => error?.code === 'COPILOT_WORKSPACE_LOCAL_REQUIRED',
  );
  await assert.rejects(
    () => service.executeProjectWorkspaceTool(
      project.project.id,
      workspace.workspace.id,
      'workspace.write',
      { path: 'blocked.txt', content: 'blocked' },
      REMOTE_SECURITY,
    ),
    (error) => error?.code === 'COPILOT_WORKSPACE_LOCAL_REQUIRED',
  );
  const response = await request(baseUrl, '/api/copilot/projects', { remote: true });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'COPILOT_WORKSPACE_LOCAL_REQUIRED');
  await assert.rejects(readFile(path.join(projectRoot, 'blocked.txt'), 'utf8'));
});

test('same-key concurrent submissions keep the workspace lease until the first execution completes', async (t) => {
  const { baseUrl, projectRoot, toolExecutionBroker } = await fixture(t);
  const project = await request(baseUrl, '/api/copilot/projects', {
    method: 'POST',
    body: { id: 'lease-project', name: 'Lease project', rootPath: projectRoot },
  });
  assert.equal(project.status, 201);
  const workspace = await request(baseUrl, '/api/copilot/projects/lease-project/workspaces', {
    method: 'POST',
    body: { id: 'lease-main', name: 'Lease main', kind: 'shared' },
  });
  assert.equal(workspace.status, 201);

  const originalSubmit = toolExecutionBroker.submit.bind(toolExecutionBroker);
  let submitCalls = 0;
  toolExecutionBroker.submit = async (input) => {
    submitCalls += 1;
    if (submitCalls === 1) await new Promise((resolve) => setTimeout(resolve, 40));
    return originalSubmit(input);
  };
  const longCommand = {
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("lease-finished"), 1000)'],
  };
  try {
    const [first, second] = await Promise.all([
      request(baseUrl, '/api/copilot/projects/lease-project/workspaces/lease-main/tools/exec.run', {
        method: 'POST',
        body: longCommand,
        idempotencyKey: 'lease-same-key',
      }),
      request(baseUrl, '/api/copilot/projects/lease-project/workspaces/lease-main/tools/exec.run', {
        method: 'POST',
        body: longCommand,
        idempotencyKey: 'lease-same-key',
      }),
    ]);
    assert.equal(submitCalls, 2);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(first.body.receipt.toolExecutionId, second.body.receipt.toolExecutionId);

    const competing = await request(baseUrl, '/api/copilot/projects/lease-project/workspaces/lease-main/tools/workspace.write', {
      method: 'POST',
      body: { path: 'blocked-by-running-lease.txt', content: 'must wait' },
      idempotencyKey: 'lease-different-key',
    });
    assert.equal(competing.status, 409);
    assert.equal(competing.body.error.code, 'WORKSPACE_LEASE_CONFLICT');

    const completed = await waitForToolExecution(
      baseUrl,
      'lease-project',
      'lease-main',
      first.body.receipt.toolExecutionId,
      { timeoutMs: 5_000 },
    );
    assert.equal(completed.body.receipt.status, 'completed');
    assert.equal(completed.body.receipt.result.stdout, 'lease-finished');
  } finally {
    toolExecutionBroker.submit = originalSubmit;
  }
});

test('project workspace tool execution receipts are scoped to the submitting local actor', async (t) => {
  const { baseUrl, projectRoot } = await fixture(t);
  const project = await request(baseUrl, '/api/copilot/projects', {
    method: 'POST',
    body: { id: 'actor-project', name: 'Actor project', rootPath: projectRoot },
  });
  assert.equal(project.status, 201);
  const workspace = await request(baseUrl, '/api/copilot/projects/actor-project/workspaces', {
    method: 'POST',
    body: { id: 'actor-main', name: 'Actor main', kind: 'shared' },
  });
  assert.equal(workspace.status, 201);

  const started = await request(baseUrl, '/api/copilot/projects/actor-project/workspaces/actor-main/tools/workspace.write', {
    method: 'POST',
    body: { path: 'actor.txt', content: 'actor scoped receipt' },
    idempotencyKey: 'actor-scoped-tool-execution',
  });
  assert.equal(started.status, 202);
  const executionPath = `/api/copilot/projects/actor-project/workspaces/actor-main/tool-executions/${encodeURIComponent(started.body.receipt.toolExecutionId)}`;
  const completed = await waitForToolExecution(
    baseUrl,
    'actor-project',
    'actor-main',
    started.body.receipt.toolExecutionId,
  );
  assert.equal(completed.body.receipt.status, 'completed');

  const otherActorRead = await request(baseUrl, executionPath, { otherLocal: true });
  assert.equal(otherActorRead.status, 403);
  assert.equal(otherActorRead.body.error.code, 'COPILOT_WORKSPACE_TOOL_EXECUTION_ACTOR_MISMATCH');

  const otherActorCancel = await request(baseUrl, `${executionPath}/cancel`, {
    method: 'POST',
    body: { reason: 'different_actor' },
    otherLocal: true,
  });
  assert.equal(otherActorCancel.status, 403);
  assert.equal(otherActorCancel.body.error.code, 'COPILOT_WORKSPACE_TOOL_EXECUTION_ACTOR_MISMATCH');

  const otherActorDuplicate = await request(baseUrl, '/api/copilot/projects/actor-project/workspaces/actor-main/tools/workspace.write', {
    method: 'POST',
    body: { path: 'actor.txt', content: 'actor scoped receipt' },
    idempotencyKey: 'actor-scoped-tool-execution',
    otherLocal: true,
  });
  assert.equal(otherActorDuplicate.status, 403);
  assert.equal(otherActorDuplicate.body.error.code, 'COPILOT_WORKSPACE_TOOL_EXECUTION_ACTOR_MISMATCH');
});

test('project workspace terminal API starts and replays a real local command', async (t) => {
  const { baseUrl, projectRoot, service } = await fixture(t);
  await service.createProject({ id: 'terminal-project', name: 'Terminal project', rootPath: projectRoot }, LOCAL_SECURITY);
  await service.createProjectWorkspace('terminal-project', { id: 'terminal-main', name: 'Terminal main' }, LOCAL_SECURITY);

  const started = await request(baseUrl, '/api/copilot/projects/terminal-project/workspaces/terminal-main/terminals', {
    method: 'POST',
    body: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("terminal-api-ok")'],
    },
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.authorization.automatic, true);
  const sessionId = started.body.session.sessionId;
  assert.ok(sessionId);

  let details;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    details = await request(baseUrl, `/api/copilot/projects/terminal-project/workspaces/terminal-main/terminals/${sessionId}`);
    if (details.body.session.status !== 'running' && details.body.session.status !== 'starting') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(details.status, 200);
  assert.equal(details.body.session.status, 'completed');
  assert.match(details.body.session.output.stdout, /terminal-api-ok/u);
  assert.ok(
    details.body.events.some((event) => event.type === 'terminal.output'),
    `Expected terminal output event, got ${JSON.stringify(details.body.events)}`,
  );

  const workspace = (await service.getProjectWorkspace('terminal-project', 'terminal-main', {}, LOCAL_SECURITY)).workspace;
  assert.equal(workspace.lease, null);
});
