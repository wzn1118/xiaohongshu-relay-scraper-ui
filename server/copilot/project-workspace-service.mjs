import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';

import { createGitWorktreeManager } from './git-worktree-manager.mjs';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const WORKSPACE_KINDS = new Set(['shared', 'worktree']);
const LEASE_MODES = new Set(['read', 'write']);
const MAX_LEASE_MS = 60 * 60 * 1000;
const STATE_RENAME_ATTEMPTS = 4;

export class ProjectWorkspaceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'ProjectWorkspaceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Persistent project and workspace catalog. The service has no model or HTTP
 * dependency, which makes its records usable by interactive runs, background
 * workers, and UI hydration alike.
 */
export class ProjectWorkspaceService {
  constructor({
    rootDir,
    allowedRoots = [],
    stateFile = null,
    worktreeManagerFactory = createGitWorktreeManager,
    now = () => new Date(),
    idFactory = () => randomUUID(),
  } = {}) {
    if (!rootDir) throw new TypeError('A project workspace root directory is required.');
    this.rootDir = path.resolve(rootDir);
    this.stateFile = path.resolve(stateFile || path.join(this.rootDir, 'copilot-project-workspaces.json'));
    this.allowedRoots = [this.rootDir, ...allowedRoots]
      .filter(Boolean)
      .map((value) => path.resolve(value));
    this.worktreeManagerFactory = worktreeManagerFactory;
    this.now = now;
    this.idFactory = idFactory;
    this.state = emptyState();
    this.initialized = false;
    this.saveTail = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return this.describe();
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    this.allowedRoots = await Promise.all(this.allowedRoots.map(async (root) => {
      await mkdir(root, { recursive: true });
      return realpath(root);
    }));
    this.allowedRoots = [...new Set(this.allowedRoots.map((root) => canonicalKey(root)))].map((key) => key);
    this.state = await readState(this.stateFile);
    this.#pruneExpiredLeases();
    await this.#save();
    this.initialized = true;
    return this.describe();
  }

  describe() {
    return {
      schemaVersion: 1,
      projectCount: this.state.projects.length,
      workspaceCount: this.state.workspaces.length,
      allowedRoots: [...this.allowedRoots],
      stateFile: this.stateFile,
    };
  }

  listProjects({ includeArchived = false } = {}) {
    this.#assertInitialized();
    return this.state.projects
      .filter((project) => includeArchived || !project.archivedAt)
      .map((project) => this.#publicProject(project));
  }

  getProject(projectId) {
    this.#assertInitialized();
    const project = this.#project(projectId);
    return this.#publicProject(project);
  }

  async createProject({ id = '', name, rootPath, description = '' } = {}) {
    this.#assertInitialized();
    const projectId = optionalId(id) || this.#nextId('project');
    if (this.state.projects.some((project) => project.id === projectId)) {
      throw projectError('PROJECT_EXISTS', `Project ${projectId} already exists.`, 409);
    }
    const resolvedRoot = await this.#resolveAllowedDirectory(rootPath, 'project root');
    const project = {
      id: projectId,
      name: requiredLabel(name, 'Project name'),
      description: optionalText(description, 1_000),
      rootPath: resolvedRoot,
      createdAt: this.#timestamp(),
      updatedAt: this.#timestamp(),
      archivedAt: null,
    };
    this.state.projects.push(project);
    await this.#save();
    return this.#publicProject(project);
  }

  async updateProject(projectId, patch = {}) {
    this.#assertInitialized();
    const project = this.#project(projectId);
    if (patch.name !== undefined) project.name = requiredLabel(patch.name, 'Project name');
    if (patch.description !== undefined) project.description = optionalText(patch.description, 1_000);
    if (patch.rootPath !== undefined) project.rootPath = await this.#resolveAllowedDirectory(patch.rootPath, 'project root');
    if (patch.archived !== undefined) project.archivedAt = patch.archived ? this.#timestamp() : null;
    project.updatedAt = this.#timestamp();
    await this.#save();
    return this.#publicProject(project);
  }

  async archiveProject(projectId) {
    return this.updateProject(projectId, { archived: true });
  }

  listWorkspaces(projectId, { includeArchived = false } = {}) {
    this.#assertInitialized();
    this.#project(projectId);
    this.#pruneExpiredLeases();
    return this.state.workspaces
      .filter((workspace) => workspace.projectId === projectId && (includeArchived || !workspace.archivedAt))
      .map((workspace) => this.#publicWorkspace(workspace));
  }

  getWorkspace(workspaceId) {
    this.#assertInitialized();
    this.#pruneExpiredLeases();
    return this.#publicWorkspace(this.#workspace(workspaceId));
  }

  /**
   * Creates either a project-root shared workspace or a Git-isolated write
   * workspace. Git state is changed before catalog state, so no persisted row
   * points at a worktree that failed to materialize.
   */
  async createWorkspace(projectId, {
    id = '',
    name,
    kind = 'shared',
    rootPath: requestedRootPath = '',
    branch = '',
    baseRef: requestedBaseRef = undefined,
    ref = undefined,
  } = {}) {
    this.#assertInitialized();
    const project = this.#project(projectId);
    if (project.archivedAt) throw projectError('PROJECT_ARCHIVED', 'Archived projects cannot create workspaces.', 409);
    const normalizedKind = String(kind || 'shared').trim().toLowerCase();
    if (!WORKSPACE_KINDS.has(normalizedKind)) {
      throw projectError('WORKSPACE_KIND_INVALID', 'Workspace kind must be shared or worktree.', 400);
    }
    const workspaceId = optionalId(id) || this.#nextId('workspace');
    if (this.state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw projectError('WORKSPACE_EXISTS', `Workspace ${workspaceId} already exists.`, 409);
    }
    const baseRef = String(requestedBaseRef ?? ref ?? 'HEAD').trim() || 'HEAD';
    let rootPath = project.rootPath;
    if (normalizedKind === 'shared' && String(requestedRootPath || '').trim()) {
      const candidate = await this.#resolveAllowedDirectory(requestedRootPath, 'workspace root');
      if (!isPathInside(project.rootPath, candidate)) {
        throw projectError('WORKSPACE_ROOT_OUTSIDE_PROJECT', 'A shared workspace root must be inside its project root.', 403);
      }
      rootPath = candidate;
    }
    let worktree = null;
    if (normalizedKind === 'worktree') {
      const manager = this.worktreeManagerFactory({
        repositoryRoot: project.rootPath,
        worktreeRoot: path.join(project.rootPath, '.agent-worktrees'),
      });
      await manager.initialize();
      worktree = await manager.create({ id: workspaceId, branch, baseRef });
      rootPath = worktree.path;
    }
    const timestamp = this.#timestamp();
    const workspace = {
      id: workspaceId,
      projectId: project.id,
      name: requiredLabel(name || workspaceId, 'Workspace name'),
      kind: normalizedKind,
      rootPath,
      branch: worktree?.branch || null,
      baseRef: normalizedKind === 'worktree' ? String(baseRef || 'HEAD') : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      lease: null,
    };
    this.state.workspaces.push(workspace);
    await this.#save();
    return this.#publicWorkspace(workspace);
  }

  async archiveWorkspace(workspaceId, { removeWorktree = false, force = false } = {}) {
    this.#assertInitialized();
    const workspace = this.#workspace(workspaceId);
    if (workspace.lease && !isLeaseExpired(workspace.lease, this.now())) {
      throw projectError('WORKSPACE_LEASE_ACTIVE', 'The workspace has an active lease.', 409, { lease: publicLease(workspace.lease) });
    }
    if (removeWorktree && workspace.kind === 'worktree') {
      const project = this.#project(workspace.projectId);
      const manager = this.worktreeManagerFactory({
        repositoryRoot: project.rootPath,
        worktreeRoot: path.join(project.rootPath, '.agent-worktrees'),
      });
      await manager.initialize();
      await manager.remove(workspace.rootPath, { force });
    }
    workspace.archivedAt = this.#timestamp();
    workspace.updatedAt = this.#timestamp();
    await this.#save();
    return this.#publicWorkspace(workspace);
  }

  async acquireLease(workspaceId, {
    runId,
    mode = 'write',
    ttlMs = 15 * 60 * 1000,
    actorId = '',
  } = {}) {
    this.#assertInitialized();
    const workspace = this.#workspace(workspaceId);
    if (workspace.archivedAt) throw projectError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot be leased.', 409);
    const normalizedMode = String(mode || 'write').trim().toLowerCase();
    if (!LEASE_MODES.has(normalizedMode)) throw projectError('WORKSPACE_LEASE_MODE_INVALID', 'Lease mode must be read or write.', 400);
    const holder = requiredId(runId, 'run ID');
    const holderActor = optionalLeaseActor(actorId);
    const now = this.now();
    if (workspace.lease && isLeaseExpired(workspace.lease, now)) workspace.lease = null;
    if (workspace.lease && (
      workspace.lease.runId !== holder
      || (workspace.lease.actorId && workspace.lease.actorId !== holderActor)
    )) {
      throw projectError('WORKSPACE_LEASE_CONFLICT', 'The workspace is leased by another run.', 409, {
        lease: publicLease(workspace.lease),
      });
    }
    // A retried idempotent tool request deliberately uses the same run ID.
    // Reusing the active lease avoids replacing its lease ID while the first
    // request is still responsible for releasing it after completion.
    if (workspace.lease) {
      return { ...leaseReceipt(workspace.lease), reused: true };
    }
    const lease = {
      id: `lease-${this.idFactory()}`,
      runId: holder,
      actorId: holderActor,
      mode: normalizedMode,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + boundedLeaseTtl(ttlMs)).toISOString(),
    };
    workspace.lease = lease;
    workspace.updatedAt = this.#timestamp();
    await this.#save();
    return leaseReceipt(lease);
  }

  async releaseLease(workspaceId, { leaseId = '', runId = '', actorId = '' } = {}) {
    this.#assertInitialized();
    const workspace = this.#workspace(workspaceId);
    const active = workspace.lease;
    if (!active || isLeaseExpired(active, this.now())) {
      workspace.lease = null;
      await this.#save();
      return { released: false, workspaceId: workspace.id };
    }
    if (
      !String(leaseId || '')
      || !String(runId || '')
      || String(leaseId || '') !== active.id
      || String(runId || '') !== active.runId
      || (active.actorId && active.actorId !== optionalLeaseActor(actorId))
    ) {
      throw projectError('WORKSPACE_LEASE_MISMATCH', 'The lease does not belong to this request.', 403);
    }
    workspace.lease = null;
    workspace.updatedAt = this.#timestamp();
    await this.#save();
    return { released: true, workspaceId: workspace.id };
  }

  executionContext(workspaceId, authority = {}) {
    this.#assertInitialized();
    const workspace = this.#workspace(workspaceId);
    return {
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      worktreeId: workspace.kind === 'worktree' ? workspace.id : undefined,
      workspaceRoot: workspace.rootPath,
      authority: structuredClone(authority),
    };
  }

  async worktreeStatus(workspaceId) {
    this.#assertInitialized();
    const workspace = this.#workspace(workspaceId);
    if (workspace.kind !== 'worktree') {
      return { workspaceId: workspace.id, kind: workspace.kind, dirty: null, changes: [] };
    }
    const project = this.#project(workspace.projectId);
    const manager = this.worktreeManagerFactory({
      repositoryRoot: project.rootPath,
      worktreeRoot: path.join(project.rootPath, '.agent-worktrees'),
    });
    await manager.initialize();
    return { workspaceId: workspace.id, kind: workspace.kind, ...(await manager.status(workspace.rootPath)) };
  }

  async #resolveAllowedDirectory(value, label) {
    const raw = String(value || '').trim();
    if (!raw) throw projectError('PROJECT_ROOT_REQUIRED', `${label} is required.`, 400);
    const candidate = await realpath(path.resolve(raw)).catch(() => {
      throw projectError('PROJECT_ROOT_NOT_FOUND', `${label} does not exist.`, 404);
    });
    const info = await stat(candidate);
    if (!info.isDirectory()) throw projectError('PROJECT_ROOT_NOT_DIRECTORY', `${label} must be a directory.`, 400);
    if (!this.allowedRoots.some((root) => isPathInside(root, candidate))) {
      throw projectError('PROJECT_ROOT_NOT_ALLOWED', `${label} is outside the configured workspace roots.`, 403);
    }
    return candidate;
  }

  #project(projectId) {
    const id = requiredId(projectId, 'project ID');
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) throw projectError('PROJECT_NOT_FOUND', `Project ${id} does not exist.`, 404);
    return project;
  }

  #workspace(workspaceId) {
    const id = requiredId(workspaceId, 'workspace ID');
    const workspace = this.state.workspaces.find((item) => item.id === id);
    if (!workspace) throw projectError('WORKSPACE_NOT_FOUND', `Workspace ${id} does not exist.`, 404);
    return workspace;
  }

  #publicProject(project) {
    return {
      ...structuredClone(project),
      workspaceCount: this.state.workspaces.filter((workspace) => workspace.projectId === project.id && !workspace.archivedAt).length,
    };
  }

  #publicWorkspace(workspace) {
    return {
      ...structuredClone(workspace),
      lease: publicLease(workspace.lease),
    };
  }

  #nextId(prefix) {
    return `${prefix}-${this.idFactory()}`.replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
  }

  #timestamp() {
    return this.now().toISOString();
  }

  #pruneExpiredLeases() {
    const now = this.now();
    for (const workspace of this.state.workspaces) {
      if (workspace.lease && isLeaseExpired(workspace.lease, now)) workspace.lease = null;
    }
  }

  #assertInitialized() {
    if (!this.initialized) throw projectError('PROJECT_WORKSPACE_NOT_INITIALIZED', 'Project workspace service has not initialized.', 503);
  }

  async #save() {
    const save = this.saveTail.catch(() => {}).then(() => this.#writeState());
    this.saveTail = save.catch(() => {});
    return save;
  }

  async #writeState() {
    const payload = JSON.stringify(this.state, null, 2);
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameStateFile(temporary, this.stateFile);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export function createProjectWorkspaceService(options) {
  return new ProjectWorkspaceService(options);
}

async function renameStateFile(temporary, stateFile) {
  let lastError = null;
  for (let attempt = 1; attempt <= STATE_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(temporary, stateFile);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRenameError(error) || attempt === STATE_RENAME_ATTEMPTS) break;
      await delay(attempt * 15);
    }
  }
  throw lastError;
}

function isTransientRenameError(error) {
  return process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EBUSY');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readState(filePath) {
  try {
    const source = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(source);
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.workspaces)) {
      throw projectError('PROJECT_WORKSPACE_STATE_INVALID', 'Project workspace state has an unsupported schema.', 500);
    }
    return {
      schemaVersion: 1,
      projects: parsed.projects.map(normalizeProjectRecord),
      workspaces: parsed.workspaces.map(normalizeWorkspaceRecord),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    if (error instanceof ProjectWorkspaceError) throw error;
    throw projectError('PROJECT_WORKSPACE_STATE_INVALID', 'Project workspace state could not be read.', 500);
  }
}

function emptyState() {
  return { schemaVersion: 1, projects: [], workspaces: [] };
}

function normalizeProjectRecord(value) {
  return {
    id: requiredId(value?.id, 'project ID'),
    name: requiredLabel(value?.name, 'Project name'),
    description: optionalText(value?.description, 1_000),
    rootPath: path.resolve(String(value?.rootPath || '')),
    createdAt: normalizedTimestamp(value?.createdAt),
    updatedAt: normalizedTimestamp(value?.updatedAt),
    archivedAt: value?.archivedAt ? normalizedTimestamp(value.archivedAt) : null,
  };
}

function normalizeWorkspaceRecord(value) {
  const kind = String(value?.kind || '').trim();
  if (!WORKSPACE_KINDS.has(kind)) throw projectError('PROJECT_WORKSPACE_STATE_INVALID', 'Workspace has an invalid kind.', 500);
  return {
    id: requiredId(value?.id, 'workspace ID'),
    projectId: requiredId(value?.projectId, 'project ID'),
    name: requiredLabel(value?.name, 'Workspace name'),
    kind,
    rootPath: path.resolve(String(value?.rootPath || '')),
    branch: value?.branch ? String(value.branch) : null,
    baseRef: value?.baseRef ? String(value.baseRef) : null,
    createdAt: normalizedTimestamp(value?.createdAt),
    updatedAt: normalizedTimestamp(value?.updatedAt),
    archivedAt: value?.archivedAt ? normalizedTimestamp(value.archivedAt) : null,
    lease: value?.lease ? normalizeLease(value.lease) : null,
  };
}

function normalizeLease(value) {
  const mode = String(value?.mode || '').trim();
  if (!LEASE_MODES.has(mode)) throw projectError('PROJECT_WORKSPACE_STATE_INVALID', 'Workspace lease has an invalid mode.', 500);
  return {
    id: String(value?.id || '').trim(),
    runId: requiredId(value?.runId, 'run ID'),
    actorId: optionalLeaseActor(value?.actorId),
    mode,
    acquiredAt: normalizedTimestamp(value?.acquiredAt),
    expiresAt: normalizedTimestamp(value?.expiresAt),
  };
}

function publicLease(lease) {
  if (!lease) return null;
  return {
    mode: lease.mode,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function leaseReceipt(lease) {
  if (!lease) return null;
  return {
    id: lease.id,
    runId: lease.runId,
    mode: lease.mode,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function optionalLeaseActor(value) {
  const actorId = String(value || '').trim();
  if (!actorId) return '';
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/u.test(actorId)) {
    throw projectError('WORKSPACE_LEASE_ACTOR_INVALID', 'Lease actor ID is invalid.', 400);
  }
  return actorId;
}

function isLeaseExpired(lease, now) {
  return new Date(lease.expiresAt).getTime() <= now.getTime();
}

function boundedLeaseTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15 * 60 * 1000;
  return Math.max(1_000, Math.min(MAX_LEASE_MS, Math.trunc(parsed)));
}

function requiredId(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_PATTERN.test(normalized)) {
    throw projectError('PROJECT_WORKSPACE_ID_INVALID', `${label} must use letters, digits, dashes, or underscores.`, 400);
  }
  return normalized;
}

function optionalId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return requiredId(normalized, 'ID');
}

function requiredLabel(value, label) {
  const normalized = optionalText(value, 160);
  if (!normalized) throw projectError('PROJECT_WORKSPACE_LABEL_REQUIRED', `${label} is required.`, 400);
  return normalized;
}

function optionalText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function normalizedTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw projectError('PROJECT_WORKSPACE_STATE_INVALID', 'State contains an invalid timestamp.', 500);
  return parsed.toISOString();
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function projectError(code, message, status, details) {
  return new ProjectWorkspaceError(code, message, status, details);
}
