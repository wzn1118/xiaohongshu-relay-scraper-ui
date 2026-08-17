import path from 'node:path';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MIN_OUTPUT_BYTES = 1_024;
const MIN_TIMEOUT_MS = 50;

export class GitToolError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'GitToolError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = jsonValue(details);
  }
}

/**
 * Structured local Git tools for an already scoped workspace. The adapter does
 * not accept a caller-provided cwd: ProjectWorkspaceService selects a root and
 * callers use forWorkspace() to obtain a confined clone.
 */
export class GitToolAdapter {
  constructor({
    workspaceRoot = process.cwd(),
    gitCommand = 'git',
    spawnImpl = spawn,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    const command = String(gitCommand || 'git').trim();
    if (!command || /[\0\r\n]/u.test(command)) throw new TypeError('gitCommand must be a single executable name or path.');
    if (typeof spawnImpl !== 'function') throw new TypeError('A spawn implementation is required.');
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
    this.gitCommand = command;
    this.spawnImpl = spawnImpl;
    this.maxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.tools = new Map();
    this.#registerBuiltins();
  }

  forWorkspace(workspaceRoot) {
    const root = String(workspaceRoot || '').trim();
    if (!root || !path.isAbsolute(root)) {
      throw gitError('GIT_WORKSPACE_ROOT_INVALID', 'A valid absolute workspace root is required.', 400);
    }
    return new GitToolAdapter({
      workspaceRoot: root,
      gitCommand: this.gitCommand,
      spawnImpl: this.spawnImpl,
      maxOutputBytes: this.maxOutputBytes,
      timeoutMs: this.timeoutMs,
    });
  }

  list({ names = null } = {}) {
    const selected = names ? new Set(arrayOfStrings(names)) : null;
    return [...this.tools.values()]
      .filter((definition) => !selected || selected.has(definition.name))
      .map(({ handler, ...definition }) => structuredClone(definition));
  }

  get(name) {
    return this.tools.get(String(name || '').trim()) || null;
  }

  async execute(name, input = {}, context = {}) {
    const tool = this.get(name);
    if (!tool) throw gitError('GIT_TOOL_UNKNOWN', `Unknown Git tool: ${String(name || '').trim() || 'unknown'}.`, 404);
    assertNotCancelled(context.signal);
    const root = await this.#repositoryRoot(context);
    const result = await tool.handler(normalizeObject(input), context, root);
    assertNotCancelled(context.signal);
    return jsonValue(result);
  }

  #registerBuiltins() {
    this.#register({
      name: 'git.status',
      description: 'Report the scoped worktree branch, revision, staged state, and bounded file changes.',
      risk: 'read',
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema({
        maxOutputBytes: integerSchema(MIN_OUTPUT_BYTES, this.maxOutputBytes),
      }),
      handler: (input, context, root) => this.#status(root, input, context),
    });

    this.#register({
      name: 'git.diff',
      description: 'Read a bounded binary-safe diff for the scoped worktree or index.',
      risk: 'read',
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema({
        baseRef: stringSchema('Optional Git revision to diff against.'),
        staged: booleanSchema('Diff the index instead of the working tree.'),
        paths: arraySchema(stringSchema('Workspace-relative literal path.')),
        maxOutputBytes: integerSchema(MIN_OUTPUT_BYTES, this.maxOutputBytes),
      }),
      handler: (input, context, root) => this.#diff(root, input, context),
    });

    this.#register({
      name: 'git.log',
      description: 'Read a bounded list of recent commits from the scoped worktree.',
      risk: 'read',
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema({
        ref: stringSchema('Git revision to start from. Defaults to HEAD.'),
        limit: integerSchema(1, 100),
        maxOutputBytes: integerSchema(MIN_OUTPUT_BYTES, this.maxOutputBytes),
      }),
      handler: (input, context, root) => this.#log(root, input, context),
    });

    this.#register({
      name: 'git.branch',
      description: 'List local branches and identify the branch checked out in this worktree.',
      risk: 'read',
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema({
        maxOutputBytes: integerSchema(MIN_OUTPUT_BYTES, this.maxOutputBytes),
      }),
      handler: (input, context, root) => this.#branches(root, input, context),
    });

    this.#register({
      name: 'git.branch.create',
      description: 'Create a local branch from an optional revision and optionally check it out in the scoped worktree.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        name: stringSchema('New local branch name.'),
        startPoint: stringSchema('Optional Git revision for the new branch. Defaults to HEAD.'),
        checkout: booleanSchema('Check out the newly created branch in this worktree. Defaults to false.'),
      }, ['name']),
      handler: (input, context, root) => this.#createBranch(root, input, context),
    });

    this.#register({
      name: 'git.branch.switch',
      description: 'Check out an existing local branch in the scoped worktree.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        name: stringSchema('Existing local branch name to check out.'),
      }, ['name']),
      handler: (input, context, root) => this.#switchBranch(root, input, context),
    });

    this.#register({
      name: 'git.worktree.status',
      description: 'List Git worktree metadata while redacting paths outside the scoped worktree.',
      risk: 'read',
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema({
        maxOutputBytes: integerSchema(MIN_OUTPUT_BYTES, this.maxOutputBytes),
      }),
      handler: (input, context, root) => this.#worktreeStatus(root, input, context),
    });

    this.#register({
      name: 'git.stage',
      description: 'Stage explicit workspace-relative paths, or all workspace changes when all is true.',
      risk: 'approval_required',
      idempotent: true,
      parallelSafe: false,
      inputSchema: objectSchema({
        paths: arraySchema(stringSchema('Workspace-relative literal path.')),
        all: booleanSchema('Stage all changes below the scoped worktree.'),
      }),
      handler: (input, context, root) => this.#stage(root, input, context),
    });

    this.#register({
      name: 'git.commit',
      description: 'Create one local commit from the staged index with a supplied message.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        message: stringSchema('Commit message.'),
        sign: booleanSchema('Allow Git signing configuration for this commit. Defaults to false.'),
      }, ['message']),
      handler: (input, context, root) => this.#commit(root, input, context),
    });

    this.#register({
      name: 'git.restore',
      description: 'Restore explicit paths from a Git revision. This can update the worktree and/or index.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        paths: arraySchema(stringSchema('Workspace-relative literal path.')),
        all: booleanSchema('Restore all paths below the scoped worktree.'),
        sourceRef: stringSchema('Git revision to restore from. Defaults to HEAD.'),
        staged: booleanSchema('Restore the index.'),
        worktree: booleanSchema('Restore the worktree. Defaults to true.'),
      }),
      handler: (input, context, root) => this.#restore(root, input, context),
    });
  }

  #register(definition) {
    this.tools.set(definition.name, Object.freeze({
      version: '1.0.0',
      category: 'git',
      tags: ['git', 'workspace', ...definition.name.split('.')],
      scopes: ['workspace'],
      ...definition,
    }));
  }

  async #status(root, input, context) {
    const output = await this.#git(root, ['status', '--porcelain=v1', '--branch'], context, input);
    const revision = await this.#head(root, context);
    const parsed = parseStatus(output.stdout, output.stdoutTruncated);
    return {
      type: 'git.status.receipt',
      root: '.',
      revision,
      ...parsed,
      execution: executionReceipt(output),
    };
  }

  async #diff(root, input, context) {
    const staged = input.staged === true;
    const args = ['diff', '--no-ext-diff', '--binary'];
    if (staged) args.push('--cached');
    if (input.baseRef !== undefined && String(input.baseRef).trim()) args.push(requiredRevision(input.baseRef, 'baseRef'));
    const paths = optionalWorkspacePaths(input.paths);
    if (paths.length) args.push('--', ...paths);
    const output = await this.#git(root, args, context, input);
    return {
      type: 'git.diff.receipt',
      root: '.',
      staged,
      baseRef: input.baseRef === undefined || !String(input.baseRef).trim() ? null : String(input.baseRef).trim(),
      paths,
      diff: output.stdout,
      truncated: output.stdoutTruncated,
      execution: executionReceipt(output),
    };
  }

  async #log(root, input, context) {
    const limit = boundedInteger(input.limit, 20, 1, 100);
    const ref = input.ref === undefined || !String(input.ref).trim() ? 'HEAD' : requiredRevision(input.ref, 'ref');
    const output = await this.#git(root, [
      'log',
      `--max-count=${limit}`,
      '--date=iso-strict',
      '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00',
      ref,
    ], context, input);
    return {
      type: 'git.log.receipt',
      root: '.',
      ref,
      entries: parseLog(output.stdout),
      truncated: output.stdoutTruncated,
      execution: executionReceipt(output),
    };
  }

  async #branches(root, input, context) {
    const output = await this.#git(root, [
      'branch',
      '--format=%(refname:short)%00%(HEAD)%00%(objectname:short)%00%(upstream:short)%00',
    ], context, input);
    const branches = parseBranches(output.stdout);
    const current = branches.find((branch) => branch.current) || null;
    return {
      type: 'git.branch.receipt',
      root: '.',
      current: current?.name || null,
      branches,
      truncated: output.stdoutTruncated,
      execution: executionReceipt(output),
    };
  }

  async #createBranch(root, input, context) {
    const name = requiredBranchName(input.name, 'name');
    const startPoint = input.startPoint === undefined || !String(input.startPoint).trim()
      ? null
      : requiredRevision(input.startPoint, 'startPoint');
    const checkout = input.checkout === true;
    const args = checkout
      ? ['switch', '-c', name, ...(startPoint ? [startPoint] : [])]
      : ['branch', name, ...(startPoint ? [startPoint] : [])];
    const output = await this.#git(root, args, context);
    const branches = await this.#branches(root, {}, context);
    return {
      type: 'git.branch.create.receipt',
      root: '.',
      name,
      startPoint: startPoint || 'HEAD',
      checkout,
      current: branches.current,
      branch: branches.branches.find((branch) => branch.name === name) || null,
      execution: executionReceipt(output),
    };
  }

  async #switchBranch(root, input, context) {
    const name = requiredBranchName(input.name, 'name');
    const output = await this.#git(root, ['switch', name], context);
    const status = await this.#status(root, {}, context);
    return {
      type: 'git.branch.switch.receipt',
      root: '.',
      name,
      current: status.branch,
      revision: status.revision,
      status,
      execution: executionReceipt(output),
    };
  }

  async #worktreeStatus(root, input, context) {
    const output = await this.#git(root, ['worktree', 'list', '--porcelain'], context, input);
    const worktrees = parseWorktrees(output.stdout, root);
    return {
      type: 'git.worktree.status.receipt',
      root: '.',
      worktrees,
      truncated: output.stdoutTruncated,
      execution: executionReceipt(output),
    };
  }

  async #stage(root, input, context) {
    const all = input.all === true;
    const paths = all ? ['.'] : requiredWorkspacePaths(input.paths, 'paths');
    const args = all ? ['add', '-A', '--', '.'] : ['add', '--', ...paths];
    const output = await this.#git(root, args, context);
    const status = await this.#status(root, {}, context);
    return {
      type: 'git.stage.receipt',
      root: '.',
      all,
      paths,
      status,
      execution: executionReceipt(output),
    };
  }

  async #commit(root, input, context) {
    const message = requiredCommitMessage(input.message);
    const args = ['commit'];
    if (input.sign !== true) args.push('--no-gpg-sign');
    args.push('-m', message);
    const output = await this.#git(root, args, context);
    const revision = await this.#head(root, context);
    return {
      type: 'git.commit.receipt',
      root: '.',
      revision,
      message,
      signed: input.sign === true,
      summary: boundedText(output.stdout.trim(), 4_000),
      execution: executionReceipt(output),
    };
  }

  async #restore(root, input, context) {
    const staged = input.staged === true;
    const worktree = input.worktree !== false;
    if (!staged && !worktree) {
      throw gitError('GIT_RESTORE_TARGET_REQUIRED', 'git.restore must target the worktree, index, or both.', 400);
    }
    const all = input.all === true;
    const paths = all ? ['.'] : requiredWorkspacePaths(input.paths, 'paths');
    const sourceRef = input.sourceRef === undefined || !String(input.sourceRef).trim()
      ? 'HEAD'
      : requiredRevision(input.sourceRef, 'sourceRef');
    const args = ['restore', `--source=${sourceRef}`];
    if (staged) args.push('--staged');
    if (worktree) args.push('--worktree');
    args.push('--', ...paths);
    const output = await this.#git(root, args, context);
    const status = await this.#status(root, {}, context);
    return {
      type: 'git.restore.receipt',
      root: '.',
      all,
      paths,
      sourceRef,
      staged,
      worktree,
      status,
      execution: executionReceipt(output),
    };
  }

  async #head(root, context) {
    const output = await this.#git(root, ['rev-parse', '--verify', 'HEAD'], context);
    return output.stdout.trim() || null;
  }

  async #repositoryRoot(context) {
    const root = await realpath(this.workspaceRoot).catch((error) => {
      throw gitError('GIT_WORKSPACE_ROOT_UNAVAILABLE', `Workspace root is unavailable: ${error.message}`, 500);
    });
    const info = await stat(root).catch((error) => {
      throw gitError('GIT_WORKSPACE_ROOT_UNAVAILABLE', `Workspace root is unavailable: ${error.message}`, 500);
    });
    if (!info.isDirectory()) throw gitError('GIT_WORKSPACE_ROOT_INVALID', 'Workspace root must be a directory.', 400);
    let topLevel;
    try {
      const output = await this.#git(root, ['rev-parse', '--show-toplevel'], context);
      topLevel = await realpath(output.stdout.trim());
    } catch (error) {
      if (error?.code === 'GIT_TOOL_COMMAND_FAILED') {
        throw gitError('GIT_WORKSPACE_NOT_REPOSITORY', 'The scoped workspace is not a Git repository.', 409);
      }
      throw error;
    }
    if (!samePath(root, topLevel)) {
      throw gitError('GIT_WORKSPACE_ROOT_MISMATCH', 'The scoped workspace must be the top-level directory of its Git worktree.', 409);
    }
    return root;
  }

  #git(root, args, context = {}, input = {}) {
    return runGitCommand(this.spawnImpl, this.gitCommand, [
      '--no-pager',
      '-C',
      root,
      ...args,
    ], {
      cwd: root,
      maxOutputBytes: boundedInteger(input?.maxOutputBytes, this.maxOutputBytes, MIN_OUTPUT_BYTES, this.maxOutputBytes),
      timeoutMs: boundedInteger(context?.timeoutMs, this.timeoutMs, MIN_TIMEOUT_MS, this.timeoutMs),
      signal: context?.signal,
    });
  }
}

export function createGitToolAdapter(options = {}) {
  return new GitToolAdapter(options);
}

function runGitCommand(spawnImpl, command, args, { cwd, maxOutputBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(gitError('GIT_TOOL_CANCELLED', 'Git tool execution was cancelled.', 499));
      return;
    }
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
        },
      });
    } catch (error) {
      reject(gitSpawnError(error));
      return;
    }

    const startedAt = Date.now();
    const stdout = boundedCollector(maxOutputBytes);
    const stderr = boundedCollector(maxOutputBytes);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const stop = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(); } catch { /* The close handler resolves the outcome. */ }
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    child.stdout?.on('data', stdout.append);
    child.stderr?.on('data', stderr.append);
    child.once('error', (error) => settle(reject, gitSpawnError(error)));
    child.once('close', (exitCode, closeSignal) => {
      const receipt = {
        shell: false,
        status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'completed',
        exitCode,
        signal: closeSignal || null,
        durationMs: Math.max(0, Date.now() - startedAt),
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.totalBytes(),
        stderrBytes: stderr.totalBytes(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      };
      if (cancelled) {
        settle(reject, gitError('GIT_TOOL_CANCELLED', 'Git tool execution was cancelled.', 499, receipt));
      } else if (timedOut) {
        settle(reject, gitError('GIT_TOOL_TIMEOUT', `Git tool execution exceeded ${timeoutMs}ms.`, 504, receipt));
      } else if (exitCode === 0) {
        settle(resolve, receipt);
      } else {
        settle(reject, gitError(
          'GIT_TOOL_COMMAND_FAILED',
          `Git command failed with ${closeSignal ? `signal ${closeSignal}` : `exit code ${exitCode}`}.`,
          422,
          receipt,
        ));
      }
    });
  });
}

function parseStatus(value, truncated) {
  const lines = String(value || '').split(/\r?\n/u).filter(Boolean);
  const header = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  const match = /^([^\. ]+)(?:\.\.\.([^ ]+))?(?: \[(.+)\])?$/u.exec(header);
  const current = match?.[1] || null;
  const upstream = match?.[2] || null;
  const counts = match?.[3] || '';
  const ahead = /ahead (\d+)/u.exec(counts)?.[1];
  const behind = /behind (\d+)/u.exec(counts)?.[1];
  const changes = lines.slice(0, 500);
  return {
    branch: current,
    upstream,
    ahead: ahead ? Number(ahead) : 0,
    behind: behind ? Number(behind) : 0,
    changes,
    changeCount: changes.length,
    changesTruncated: truncated || lines.length > changes.length,
    dirty: changes.length > 0,
  };
}

function parseLog(value) {
  const fields = String(value || '').split('\0');
  const entries = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, shortHash, author, committedAt, subject] = fields.slice(index, index + 5);
    if (!hash) continue;
    entries.push({ hash, shortHash, author, committedAt, subject });
  }
  return entries;
}

function parseBranches(value) {
  const fields = String(value || '').split('\0');
  const branches = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [name, head, revision, upstream] = fields.slice(index, index + 4);
    if (!name) continue;
    branches.push({ name, current: head === '*', revision, upstream: upstream || null });
  }
  return branches;
}

function parseWorktrees(value, root) {
  const entries = [];
  let current = null;
  for (const line of String(value || '').split(/\r?\n/u)) {
    if (!line) {
      if (current?.path) entries.push(publicWorktree(current, root));
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const payload = rest.join(' ');
    if (key === 'worktree') {
      if (current?.path) entries.push(publicWorktree(current, root));
      current = { path: payload, branch: null, head: null, detached: false, locked: false, bare: false };
    } else if (current && key === 'HEAD') current.head = payload;
    else if (current && key === 'branch') current.branch = payload.replace(/^refs\/heads\//u, '');
    else if (current && key === 'detached') current.detached = true;
    else if (current && key === 'locked') current.locked = true;
    else if (current && key === 'bare') current.bare = true;
  }
  if (current?.path) entries.push(publicWorktree(current, root));
  return entries;
}

function publicWorktree(entry, root) {
  const absolute = path.resolve(entry.path);
  const contained = isPathInside(root, absolute);
  return {
    path: contained ? portableRelative(root, absolute) : '<external-worktree>',
    scoped: samePath(root, absolute),
    external: !contained,
    branch: entry.branch,
    head: entry.head,
    detached: entry.detached,
    locked: entry.locked,
    bare: entry.bare,
  };
}

function executionReceipt(output) {
  return {
    shell: false,
    status: output.status,
    exitCode: output.exitCode,
    signal: output.signal,
    durationMs: output.durationMs,
    stdoutBytes: output.stdoutBytes,
    stderrBytes: output.stderrBytes,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    stderr: boundedText(output.stderr, 4_000),
  };
}

function requiredWorkspacePaths(value, field) {
  const paths = optionalWorkspacePaths(value);
  if (!paths.length) throw gitError('GIT_PATHS_REQUIRED', `${field} must contain at least one workspace-relative path.`, 400);
  return paths;
}

function optionalWorkspacePaths(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(values.map((item) => workspacePath(item)))];
}

function workspacePath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw gitError('GIT_PATH_INVALID', 'Git paths must be non-empty strings.', 400);
  if (raw.length > 1_024 || /[\0\r\n]/u.test(raw)) throw gitError('GIT_PATH_INVALID', 'Git paths contain unsupported characters.', 400);
  const portable = raw.replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/u.test(portable)) {
    throw gitError('GIT_PATH_ABSOLUTE', 'Git paths must be workspace-relative.', 400);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw gitError('GIT_PATH_ESCAPE', 'Git paths must stay below the scoped workspace root.', 403);
  }
  if (/[*?\[\]]/u.test(normalized) || normalized.startsWith(':')) {
    throw gitError('GIT_PATHSPEC_UNSUPPORTED', 'Git pathspec expressions are not supported; use explicit workspace-relative paths.', 400);
  }
  return normalized;
}

function requiredRevision(value, field) {
  const revision = String(value || '').trim();
  if (!revision || revision.length > 256 || /[\0\r\n\s]/u.test(revision) || revision.startsWith('-') || revision === '--') {
    throw gitError('GIT_REVISION_INVALID', `${field} must be a single Git revision.`, 400);
  }
  return revision;
}

function requiredBranchName(value, field) {
  const name = String(value || '').trim();
  const valid = name.length <= 255
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/u.test(name)
    && !name.includes('..')
    && !name.includes('//')
    && !name.includes('@{')
    && !name.includes('.lock')
    && !name.startsWith('.')
    && !name.endsWith('.')
    && !name.endsWith('/');
  if (!valid) {
    throw gitError(
      'GIT_BRANCH_NAME_INVALID',
      `${field} must be a safe local branch name containing only ASCII letters, digits, '.', '_', '-', and '/'.`,
      400,
    );
  }
  return name;
}

function requiredCommitMessage(value) {
  if (typeof value !== 'string') throw gitError('GIT_COMMIT_MESSAGE_REQUIRED', 'message is required.', 400);
  const message = value.trim();
  if (!message || message.length > 8_000 || message.includes('\0')) {
    throw gitError('GIT_COMMIT_MESSAGE_INVALID', 'message must contain 1 to 8,000 non-null characters.', 400);
  }
  return message;
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw gitError('GIT_TOOL_CANCELLED', 'Git tool execution was cancelled.', 499);
}

function gitSpawnError(error) {
  return gitError(
    'GIT_TOOL_UNAVAILABLE',
    'Git could not be started for the requested operation.',
    503,
    { code: String(error?.code || 'GIT_SPAWN_FAILED') },
  );
}

function gitError(code, message, status = 400, details = undefined) {
  return new GitToolError(code, message, status, details);
}

function objectSchema(properties = {}, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

function stringSchema(description = '') {
  return { type: 'string', ...(description ? { description } : {}) };
}

function booleanSchema(description = '') {
  return { type: 'boolean', ...(description ? { description } : {}) };
}

function integerSchema(minimum, maximum) {
  return { type: 'integer', minimum, maximum };
}

function arraySchema(items) {
  return { type: 'array', items, maxItems: 1_000 };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayOfStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function boundedText(value, limit) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function boundedCollector(maximum) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  return {
    append(raw) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      if (kept >= maximum) return;
      const next = chunk.subarray(0, maximum - kept);
      chunks.push(next);
      kept += next.length;
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    totalBytes() { return total; },
    truncated() { return total > maximum; },
  };
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function portableRelative(root, target) {
  const value = path.relative(root, target).split(path.sep).join('/');
  return value || '.';
}

function jsonValue(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
