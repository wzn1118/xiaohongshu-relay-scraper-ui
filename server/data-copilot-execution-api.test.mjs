import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { handleDataCopilotRequest } from './data-copilot-http.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';
import {
  createExecutionContext,
  createRuntimeV3Repository,
} from './copilot/runtime-v3/index.mjs';

function executionContext({
  taskId,
  runId,
  actorId,
  idempotencyKey,
  workspaceId = 'workspace-main',
} = {}) {
  return createExecutionContext({
    taskId,
    runId,
    attemptId: `${runId}:attempt:1`,
    traceId: `${runId}:trace`,
    deadlineAt: '2099-01-01T00:00:00.000Z',
    idempotencyKey,
    environment: {
      kind: 'project_workspace',
      projectId: 'project-main',
      workspaceId,
      worktreeId: `${workspaceId}:worktree`,
      rootPath: `C:\\private\\${workspaceId}`,
    },
    authority: {
      actorId,
      profile: 'owner_local_full',
      automatic: true,
      credential: `${actorId}:credential`,
    },
    modelPolicy: { model: 'test-model' },
    contextSnapshotId: `${runId}:snapshot`,
  });
}

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-execution-api-'));
  const repository = createRuntimeV3Repository({ rootDir });
  const cancellationCalls = [];
  const broker = {
    repository,
    async submit() {
      throw new Error('submit is not used by the execution query API fixture');
    },
    async cancel(executionId, { reason = '' } = {}) {
      cancellationCalls.push({ executionId, reason });
      const completedAt = new Date().toISOString();
      return repository.updateExecutionIfStatus(executionId, (current) => ({
        status: 'cancelled',
        metadata: {
          ...current.metadata,
          dispatcher: {
            ...(current.metadata?.dispatcher || {}),
            cancelRequestedAt: completedAt,
            cancelReason: reason,
          },
        },
        completedAt,
      }), { expectedStatuses: ['queued', 'running'] }) || repository.getExecution(executionId);
    },
  };
  const runtime = { emit() {} };
  const terminalSessionManager = { async close() {} };
  const service = new DataCopilotService({
    rootDir,
    store: { rootDir },
    approvals: {},
    artifacts: {},
    runtime,
    policy: { manager: {} },
    repository: {},
    runtimeV3Repository: repository,
    toolExecutionBroker: broker,
    terminalSessionManager,
  });

  const server = createServer(async (req, res) => {
    const handled = await handleDataCopilotRequest({
      req,
      res,
      service,
      url: new URL(req.url || '/', 'http://localhost'),
      securityContext: { trustedLocal: true, actorId: 'owner-a' },
    });
    if (!handled && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await service.close();
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  return {
    repository,
    cancellationCalls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function jsonRequest(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json();
  return { response, body };
}

test('Execution API isolates owners, redacts durable records, replays events, and cancels tools', async (t) => {
  const { repository, cancellationCalls, baseUrl } = await fixture(t);
  const older = repository.createExecution({
    executionId: 'execution-owner-a-old',
    context: executionContext({
      taskId: 'task-owner-a-old',
      runId: 'run-owner-a-old',
      actorId: 'owner-a',
      idempotencyKey: 'execution-owner-a-old:key',
    }),
    kind: 'agent',
    status: 'succeeded',
    metadata: { phase: 'completed', token: 'metadata-secret' },
  });
  repository.updateExecution(older.executionId, {
    status: 'succeeded',
    result: { privateResult: 'must-not-be-returned' },
    completedAt: '2026-08-17T00:00:00.000Z',
  });

  const execution = repository.createExecution({
    executionId: 'execution-owner-a-tool',
    context: executionContext({
      taskId: 'task-owner-a-tool',
      runId: 'run-owner-a-tool',
      actorId: 'owner-a',
      idempotencyKey: 'execution-owner-a-tool:key',
    }),
    kind: 'tool',
    status: 'queued',
    metadata: {
      toolName: 'exec.run',
      source: 'workspace',
      effectClass: 'non_idempotent',
      dispatcher: { handlerKey: 'tool.call' },
      authorization: 'Bearer metadata-secret',
    },
  });
  repository.createExecution({
    executionId: 'execution-owner-b-tool',
    context: executionContext({
      taskId: 'task-owner-b-tool',
      runId: 'run-owner-b-tool',
      actorId: 'owner-b',
      idempotencyKey: 'execution-owner-b-tool:key',
      workspaceId: 'workspace-other',
    }),
    kind: 'tool',
    status: 'queued',
    metadata: { toolName: 'workspace.write', source: 'workspace' },
  });

  const step = repository.createExecutionStep({
    stepId: 'step-owner-a-tool',
    executionId: execution.executionId,
    ordinal: 0,
    kind: 'tool.call',
    status: 'running',
    handlerKey: 'tool.call',
    effectClass: 'non_idempotent',
    descriptorVersion: '1',
    idempotencyKey: 'step-owner-a-tool:key',
    inputHash: 'a'.repeat(64),
    metadata: {
      authorization: 'Bearer step-secret',
      nested: { apiKey: 'step-api-key' },
    },
  });
  repository.createExecutionArtifact({
    artifactId: 'artifact-owner-a-tool',
    executionId: execution.executionId,
    stepId: step.stepId,
    kind: 'tool.output',
    mimeType: 'text/plain',
    contentHash: 'b'.repeat(64),
    storageRef: 'C:\\private\\artifact-owner-a-tool.txt',
    sizeBytes: 42,
    metadata: { apiKey: 'artifact-api-key', label: 'stdout' },
  });
  repository.appendEvent({
    streamId: `execution:${execution.context.runId}:tool:${execution.executionId}`,
    type: 'tool.execution.started',
    taskId: execution.context.taskId,
    runId: execution.context.runId,
    attemptId: execution.context.attemptId,
    payload: {
      authorization: 'Bearer event-secret',
      nested: { token: 'event-token' },
      message: 'api_key=event-api-key',
    },
  });

  const listed = await jsonRequest(baseUrl, '/api/copilot/v1/executions?limit=50');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(
    listed.body.executions.map((item) => item.executionId),
    ['execution-owner-a-tool', 'execution-owner-a-old'],
  );
  assert.equal(JSON.stringify(listed.body).includes('owner-b'), false);
  assert.equal(JSON.stringify(listed.body).includes('privateResult'), false);
  assert.equal(JSON.stringify(listed.body).includes('rootPath'), false);
  assert.equal(JSON.stringify(listed.body).includes('metadata-secret'), false);
  assert.equal(JSON.stringify(listed.body).includes('credential'), false);

  const firstPage = await jsonRequest(baseUrl, '/api/copilot/v1/executions?limit=1');
  assert.equal(firstPage.response.status, 200);
  assert.deepEqual(
    firstPage.body.executions.map((item) => item.executionId),
    ['execution-owner-a-tool'],
  );
  assert.equal(firstPage.body.hasMore, true);

  const completePage = await jsonRequest(baseUrl, '/api/copilot/v1/executions?limit=2');
  assert.equal(completePage.response.status, 200);
  assert.equal(completePage.body.hasMore, false);

  const forbidden = await jsonRequest(baseUrl, '/api/copilot/v1/executions/execution-owner-b-tool');
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, 'COPILOT_EXECUTION_ACTOR_MISMATCH');

  const steps = await jsonRequest(baseUrl, `/api/copilot/v1/executions/${execution.executionId}/steps`);
  assert.equal(steps.response.status, 200);
  assert.equal(steps.body.steps.length, 1);
  assert.equal(steps.body.steps[0].metadata.authorization, '[redacted]');
  assert.equal(steps.body.steps[0].metadata.nested.apiKey, '[redacted]');
  assert.equal(JSON.stringify(steps.body).includes('step-secret'), false);

  const artifacts = await jsonRequest(baseUrl, `/api/copilot/v1/executions/${execution.executionId}/artifacts`);
  assert.equal(artifacts.response.status, 200);
  assert.equal(artifacts.body.artifacts.length, 1);
  assert.equal(artifacts.body.artifacts[0].storageRef, undefined);
  assert.equal(artifacts.body.artifacts[0].metadata.apiKey, '[redacted]');
  assert.equal(JSON.stringify(artifacts.body).includes('C:\\private'), false);

  const events = await jsonRequest(
    baseUrl,
    `/api/copilot/v1/executions/${execution.executionId}/events?scope=execution&afterSequence=0&limit=10`,
  );
  assert.equal(events.response.status, 200);
  assert.equal(events.body.latestSequence, 1);
  assert.equal(events.body.hasMore, false);
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].payload.authorization, '[redacted]');
  assert.equal(events.body.events[0].payload.nested.token, '[redacted]');
  assert.equal(events.body.events[0].payload.message, 'api_key=[redacted]');
  assert.equal(JSON.stringify(events.body).includes('event-secret'), false);

  const invalidScope = await jsonRequest(
    baseUrl,
    `/api/copilot/v1/executions/${execution.executionId}/events?scope=arbitrary-stream`,
  );
  assert.equal(invalidScope.response.status, 400);
  assert.equal(invalidScope.body.error.code, 'COPILOT_EXECUTION_EVENT_SCOPE_INVALID');

  const cancelled = await jsonRequest(baseUrl, `/api/copilot/v1/executions/${execution.executionId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Authorization: Bearer cancellation-secret' }),
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.execution.status, 'cancelled');
  assert.equal(cancelled.body.execution.cancellation.reason, 'Authorization: [redacted]');
  assert.deepEqual(cancellationCalls, [{
    executionId: execution.executionId,
    reason: 'Authorization: Bearer cancellation-secret',
  }]);
});

test('Execution API requires server-derived trusted local ownership', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-execution-api-remote-'));
  const repository = createRuntimeV3Repository({ rootDir });
  const service = new DataCopilotService({
    rootDir,
    store: { rootDir },
    approvals: {},
    artifacts: {},
    runtime: { emit() {} },
    policy: { manager: {} },
    repository: {},
    runtimeV3Repository: repository,
    toolExecutionBroker: { repository, async submit() {} },
    terminalSessionManager: { async close() {} },
  });
  const server = createServer(async (req, res) => {
    await handleDataCopilotRequest({
      req,
      res,
      service,
      url: new URL(req.url || '/', 'http://localhost'),
      securityContext: { trustedLocal: false, actorId: 'owner-a' },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await service.close();
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/copilot/v1/executions`);
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'COPILOT_WORKSPACE_LOCAL_REQUIRED');
});
