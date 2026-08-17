import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  TerminalSessionError,
  createTerminalSessionManager,
} from './terminal-session-manager.mjs';
import { createRuntimeV3Repository } from './runtime-v3/index.mjs';

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-terminal-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace: await realpath(workspace),
  };
}

test('terminal sessions stream stdout, accept input, and retain bounded replay events', async (t) => {
  const fixture = await createWorkspace();
  const manager = createTerminalSessionManager({ maxOutputBytes: 4_096 });
  t.after(async () => manager.close());

  const session = await manager.start({
    workspaceId: 'workspace-main',
    workspaceRoot: fixture.workspace,
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('ready\\n'); process.stdin.setEncoding('utf8'); process.stdin.once('data', (value) => { process.stdout.write(`echo:${value.trim()}\\n`); setImmediate(() => process.exit(0)); });",
    ],
  });

  const events = [];
  const unsubscribe = manager.subscribe(session.sessionId, (event) => events.push(event));
  await manager.write(session.sessionId, 'hello\n');
  const completed = await manager.wait(session.sessionId);
  unsubscribe();

  assert.equal(completed.status, 'completed');
  assert.equal(completed.exitCode, 0);
  assert.match(completed.output.stdout, /ready/);
  assert.match(completed.output.stdout, /echo:hello/);
  assert.ok(events.some((event) => event.type === 'terminal.output' && event.stream === 'stdout'));
  assert.equal(manager.list().length, 1);
});

test('terminal session cancellation terminates a running process', async (t) => {
  const fixture = await createWorkspace();
  const manager = createTerminalSessionManager({ killGraceMs: 50 });
  t.after(async () => manager.close());

  const session = await manager.start({
    workspaceId: 'workspace-main',
    workspaceRoot: fixture.workspace,
    command: process.execPath,
    args: ['-e', "setInterval(() => process.stdout.write('tick\\n'), 20)"],
  });
  await new Promise((resolve) => setTimeout(resolve, 75));

  const cancelled = await manager.cancel(session.sessionId, 'test_cancel');
  const settled = await manager.wait(session.sessionId);

  assert.equal(cancelled.session.sessionId, session.sessionId);
  assert.equal(settled.status, 'cancelled');
  assert.equal(manager.get(session.sessionId).session.status, 'cancelled');
});

test('terminal sessions reject paths outside their verified workspace root', async (t) => {
  const fixture = await createWorkspace();
  const manager = createTerminalSessionManager();
  t.after(async () => manager.close());

  await assert.rejects(
    manager.start({
      workspaceId: 'workspace-main',
      workspaceRoot: fixture.workspace,
      cwd: path.dirname(fixture.workspace),
      command: process.execPath,
      args: ['--version'],
    }),
    (error) => error instanceof TerminalSessionError && error.code === 'TERMINAL_CWD_INVALID',
  );
});

test('terminal sessions persist V3 receipts and replay output after a manager restart', async (t) => {
  const fixture = await createWorkspace();
  const repository = createRuntimeV3Repository({ rootDir: fixture.root });
  const managers = [];
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    repository.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const manager = createTerminalSessionManager({ repository });
  managers.push(manager);
  const session = await manager.start({
    workspaceId: 'workspace-main',
    projectId: 'project-main',
    runId: 'terminal-run-main',
    toolRunId: 'terminal-tool-main',
    workspaceRoot: fixture.workspace,
    command: process.execPath,
    args: [
      '-e',
      "process.stdin.setEncoding('utf8'); process.stdin.once('data', () => process.stdout.write('durable-output\\n', () => process.exit(0)));",
    ],
  });
  manager.write(session.sessionId, 'sensitive input\n');
  const completed = await manager.wait(session.sessionId);

  assert.equal(completed.status, 'completed');
  assert.match(completed.output.stdout, /durable-output/u);
  const receipt = repository.getExecution(session.sessionId);
  assert.equal(receipt.kind, 'terminal_session');
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.result.status, 'completed');
  assert.equal(receipt.context.environment.terminal.workspaceId, 'workspace-main');
  const streamId = `execution:${receipt.context.runId}:terminal:${receipt.executionId}`;
  const durableEvents = repository.listEvents({ streamId, limit: 50 });
  assert.ok(durableEvents.some((event) => event.type === 'terminal.started'));
  assert.ok(durableEvents.some((event) => event.type === 'terminal.output' && /durable-output/u.test(event.payload.text)));
  const inputEvent = durableEvents.find((event) => event.type === 'terminal.input');
  assert.equal(inputEvent.payload.text, '[redacted]');
  assert.equal(inputEvent.payload.textBytes, Buffer.byteLength('sensitive input\n'));

  const restartedManager = createTerminalSessionManager({ repository });
  managers.push(restartedManager);
  const replay = restartedManager.get(session.sessionId);
  assert.equal(replay.session.status, 'completed');
  assert.match(replay.session.output.stdout, /durable-output/u);
  assert.ok(replay.events.some((event) => event.type === 'terminal.output' && /durable-output/u.test(event.text)));
  assert.equal(restartedManager.list({ workspaceId: 'workspace-main' }).length, 1);
});

test('terminal recovery marks unfinished durable sessions for reconciliation without replaying them', async (t) => {
  const fixture = await createWorkspace();
  const repository = createRuntimeV3Repository({ rootDir: fixture.root });
  const manager = createTerminalSessionManager({ repository });
  t.after(async () => {
    await manager.close();
    repository.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  repository.createExecution({
    executionId: 'terminal-orphan',
    kind: 'terminal_session',
    status: 'running',
    context: {
      taskId: 'terminal:project-main:workspace-main:terminal-orphan',
      runId: 'terminal-run-orphan',
      attemptId: 'terminal-orphan',
      traceId: 'terminal-orphan',
      deadlineAt: '2030-01-01T00:00:00.000Z',
      idempotencyKey: 'terminal-orphan',
      environment: {
        terminal: {
          sessionId: 'terminal-orphan',
          projectId: 'project-main',
          workspaceId: 'workspace-main',
          toolRunId: 'terminal-tool-orphan',
        },
      },
      authority: {},
      modelPolicy: { kind: 'terminal_session' },
      contextSnapshotId: 'terminal-orphan',
    },
    metadata: {
      sessionId: 'terminal-orphan',
      projectId: 'project-main',
      workspaceId: 'workspace-main',
      command: process.execPath,
      args: ['--version'],
      cwd: fixture.workspace,
      envKeys: [],
      envReferenceKeys: [],
      startedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  assert.deepEqual(manager.recover(), { recovered: 1 });
  const receipt = repository.getExecution('terminal-orphan');
  assert.equal(receipt.status, 'reconcile_required');
  assert.equal(receipt.result.status, 'reconcile_required');
  assert.equal(receipt.error.code, 'TERMINAL_SESSION_ORPHANED');
  const streamId = `execution:${receipt.context.runId}:terminal:${receipt.executionId}`;
  assert.ok(repository.listEvents({ streamId, limit: 10 }).some((event) => event.type === 'terminal.reconcile_required'));
  assert.equal(manager.get('terminal-orphan').session.status, 'reconcile_required');
});
