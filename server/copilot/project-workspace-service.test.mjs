import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { ProjectWorkspaceError, ProjectWorkspaceService } from './project-workspace-service.mjs';

async function fixture(t, { now = () => new Date('2026-08-16T00:00:00.000Z'), worktreeManagerFactory } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-projects-'));
  const projectsRoot = path.join(root, 'projects');
  const projectRoot = path.join(projectsRoot, 'sample');
  await mkdir(projectRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ProjectWorkspaceService({
    rootDir: path.join(root, 'data'),
    allowedRoots: [projectsRoot],
    now,
    idFactory: (() => { let index = 0; return () => `id-${++index}`; })(),
    worktreeManagerFactory,
  });
  await service.initialize();
  return { root, projectsRoot, projectRoot, service };
}

test('persists projects, shared workspaces, and an exclusive write lease', async (t) => {
  const { projectRoot, service } = await fixture(t);
  const project = await service.createProject({ id: 'project-a', name: 'Project A', rootPath: projectRoot });
  const workspace = await service.createWorkspace(project.id, { id: 'shared-a', name: 'Shared workspace' });
  assert.equal(workspace.kind, 'shared');
  assert.equal(workspace.rootPath, project.rootPath);
  assert.equal(service.listProjects()[0].workspaceCount, 1);

  const lease = await service.acquireLease(workspace.id, { runId: 'run-a', actorId: 'local-owner', ttlMs: 5_000 });
  assert.equal(lease.runId, 'run-a');
  assert.equal(Object.hasOwn(service.getWorkspace(workspace.id).lease, 'id'), false);
  assert.equal(Object.hasOwn(service.getWorkspace(workspace.id).lease, 'runId'), false);
  await assert.rejects(() => service.acquireLease(workspace.id, { runId: 'run-b' }), {
    code: 'WORKSPACE_LEASE_CONFLICT',
    status: 409,
  });
  await assert.rejects(() => service.releaseLease(workspace.id, { leaseId: lease.id, runId: 'run-other', actorId: 'local-owner' }), {
    code: 'WORKSPACE_LEASE_MISMATCH',
    status: 403,
  });
  await assert.rejects(() => service.releaseLease(workspace.id, { leaseId: lease.id, runId: lease.runId, actorId: 'other-owner' }), {
    code: 'WORKSPACE_LEASE_MISMATCH',
    status: 403,
  });
  assert.deepEqual(await service.releaseLease(workspace.id, {
    leaseId: lease.id,
    runId: lease.runId,
    actorId: 'local-owner',
  }), { released: true, workspaceId: workspace.id });
  const execution = service.executionContext(workspace.id, { profile: 'workspace_auto' });
  assert.deepEqual(execution, {
    projectId: project.id,
    workspaceId: workspace.id,
    worktreeId: undefined,
    workspaceRoot: project.rootPath,
    authority: { profile: 'workspace_auto' },
  });
  const persisted = JSON.parse(await readFile(service.stateFile, 'utf8'));
  assert.equal(persisted.projects[0].id, project.id);
  assert.equal(persisted.workspaces[0].lease, null);
});

test('only accepts project roots below allowed roots and removes an isolated worktree after its lease ends', async (t) => {
  const calls = [];
  const manager = {
    async initialize() { calls.push(['initialize']); },
    async create(input) { calls.push(['create', input]); return { id: input.id, path: 'C:/managed/task-a', branch: null, detached: true, locked: false }; },
    async remove(worktreePath, input) { calls.push(['remove', worktreePath, input]); return { removed: true }; },
    async status(worktreePath) { calls.push(['status', worktreePath]); return { path: worktreePath, dirty: false, changes: [] }; },
  };
  const { root, projectRoot, service } = await fixture(t, { worktreeManagerFactory: () => manager });
  await assert.rejects(() => service.createProject({ name: 'Outside', rootPath: root }), {
    code: 'PROJECT_ROOT_NOT_ALLOWED',
    status: 403,
  });
  const project = await service.createProject({ id: 'project-a', name: 'Project A', rootPath: projectRoot });
  const workspace = await service.createWorkspace(project.id, { id: 'task-a', name: 'Task A', kind: 'worktree', baseRef: 'HEAD' });
  assert.equal(workspace.kind, 'worktree');
  assert.equal(workspace.rootPath, 'C:/managed/task-a');
  assert.deepEqual(calls.find(([kind]) => kind === 'create')?.[1], { id: 'task-a', branch: '', baseRef: 'HEAD' });
  const lease = await service.acquireLease(workspace.id, { runId: 'run-a' });
  await assert.rejects(() => service.archiveWorkspace(workspace.id, { removeWorktree: true }), {
    code: 'WORKSPACE_LEASE_ACTIVE',
  });
  await service.releaseLease(workspace.id, { leaseId: lease.id, runId: lease.runId });
  const archived = await service.archiveWorkspace(workspace.id, { removeWorktree: true, force: true });
  assert.ok(archived.archivedAt);
  assert.deepEqual(calls.find(([kind]) => kind === 'remove')?.slice(1), ['C:/managed/task-a', { force: true }]);
});

test('invalid service state and malformed IDs use structured errors', async (t) => {
  const { service } = await fixture(t);
  assert.throws(() => service.getProject('missing'), ProjectWorkspaceError);
  await assert.rejects(() => service.createProject({ id: '../bad', name: 'Bad', rootPath: process.cwd() }), {
    code: 'PROJECT_WORKSPACE_ID_INVALID',
  });
});

test('serializes concurrent catalog saves without losing project records', async (t) => {
  const { projectRoot, service } = await fixture(t);
  await Promise.all([
    service.createProject({ id: 'project-a', name: 'Project A', rootPath: projectRoot }),
    service.createProject({ id: 'project-b', name: 'Project B', rootPath: projectRoot }),
  ]);

  const persisted = JSON.parse(await readFile(service.stateFile, 'utf8'));
  assert.deepEqual(persisted.projects.map((project) => project.id).sort(), ['project-a', 'project-b']);
});
