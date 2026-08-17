import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GitToolAdapter } from './git-tool-adapter.mjs';

const execFile = promisify(execFileCallback);

async function repositoryFixture(t, { maxOutputBytes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-git-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('git', ['init', '-q', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'git-tools@example.test']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Git Tool Test']);
  await execFile('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, 'README.md'), 'initial\n');
  await execFile('git', ['-C', root, 'add', 'README.md']);
  await execFile('git', ['-C', root, 'commit', '-qm', 'initial commit']);
  return { root, adapter: new GitToolAdapter({ workspaceRoot: root, maxOutputBytes }) };
}

test('publishes structured Git catalog metadata for durable tool execution', async (t) => {
  const { adapter } = await repositoryFixture(t);
  const tools = adapter.list();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'git.status',
    'git.diff',
    'git.log',
    'git.branch',
    'git.branch.create',
    'git.branch.switch',
    'git.worktree.status',
    'git.stage',
    'git.commit',
    'git.restore',
  ]);
  assert.equal(adapter.get('git.status').risk, 'read');
  assert.equal(adapter.get('git.status').idempotent, true);
  assert.equal(adapter.get('git.status').parallelSafe, true);
  assert.equal(adapter.get('git.stage').risk, 'approval_required');
  assert.equal(adapter.get('git.stage').idempotent, true);
  assert.equal(adapter.get('git.stage').parallelSafe, false);
  assert.equal(adapter.get('git.commit').idempotent, false);
  assert.equal(adapter.get('git.restore').parallelSafe, false);
  assert.equal(adapter.get('git.branch.create').risk, 'approval_required');
  assert.equal(adapter.get('git.branch.switch').parallelSafe, false);
  assert.equal('handler' in tools[0], false);
});

test('returns bounded structured status, diff, log, branch, and worktree receipts', async (t) => {
  const { root, adapter } = await repositoryFixture(t);
  await writeFile(path.join(root, 'README.md'), 'changed\n');

  const status = await adapter.execute('git.status');
  assert.equal(status.type, 'git.status.receipt');
  assert.equal(status.root, '.');
  assert.equal(status.dirty, true);
  assert.equal(status.execution.shell, false);
  assert.equal(status.execution.status, 'completed');
  assert.ok(status.revision.length >= 7);
  assert.ok(status.changes.some((change) => change.endsWith('README.md')));

  const diff = await adapter.execute('git.diff', { paths: ['README.md'] });
  assert.equal(diff.type, 'git.diff.receipt');
  assert.match(diff.diff, /changed/u);
  assert.equal(diff.execution.shell, false);

  const log = await adapter.execute('git.log', { limit: 5 });
  assert.equal(log.type, 'git.log.receipt');
  assert.equal(log.entries[0].subject, 'initial commit');
  assert.ok(log.entries[0].hash.length >= 7);

  const branches = await adapter.execute('git.branch');
  assert.equal(branches.type, 'git.branch.receipt');
  assert.ok(branches.current);
  assert.ok(branches.branches.some((branch) => branch.current));

  const worktrees = await adapter.execute('git.worktree.status');
  assert.equal(worktrees.type, 'git.worktree.status.receipt');
  assert.ok(worktrees.worktrees.some((worktree) => worktree.path === '.' && worktree.scoped));
});

test('creates and switches only validated local branches in the scoped Git worktree', async (t) => {
  const { adapter } = await repositoryFixture(t);
  const initial = await adapter.execute('git.branch');
  assert.ok(initial.current);

  const created = await adapter.execute('git.branch.create', {
    name: 'codex/branch-lifecycle',
    checkout: true,
  });
  assert.equal(created.type, 'git.branch.create.receipt');
  assert.equal(created.name, 'codex/branch-lifecycle');
  assert.equal(created.startPoint, 'HEAD');
  assert.equal(created.checkout, true);
  assert.equal(created.current, 'codex/branch-lifecycle');
  assert.equal(created.branch?.current, true);
  assert.equal(created.execution.shell, false);

  const switched = await adapter.execute('git.branch.switch', { name: initial.current });
  assert.equal(switched.type, 'git.branch.switch.receipt');
  assert.equal(switched.current, initial.current);
  assert.equal(switched.status.branch, initial.current);
  assert.equal(switched.execution.shell, false);

  await assert.rejects(
    () => adapter.execute('git.branch.create', { name: '../outside' }),
    { code: 'GIT_BRANCH_NAME_INVALID', status: 400 },
  );
  await assert.rejects(
    () => adapter.execute('git.branch.switch', { name: '-config' }),
    { code: 'GIT_BRANCH_NAME_INVALID', status: 400 },
  );
});

test('stages, commits, and restores only files in the scoped Git worktree', async (t) => {
  const { root, adapter } = await repositoryFixture(t);
  await writeFile(path.join(root, 'README.md'), 'staged version\n');

  const staged = await adapter.execute('git.stage', { paths: ['README.md'] });
  assert.equal(staged.type, 'git.stage.receipt');
  assert.deepEqual(staged.paths, ['README.md']);
  assert.ok(staged.status.changes.some((change) => change.startsWith('M ')));

  const commit = await adapter.execute('git.commit', { message: 'Record staged README' });
  assert.equal(commit.type, 'git.commit.receipt');
  assert.equal(commit.message, 'Record staged README');
  assert.ok(commit.revision.length >= 7);
  assert.equal(commit.execution.shell, false);

  await writeFile(path.join(root, 'README.md'), 'uncommitted replacement\n');
  const restored = await adapter.execute('git.restore', { paths: ['README.md'] });
  assert.equal(restored.type, 'git.restore.receipt');
  assert.equal(restored.worktree, true);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'staged version\n');
  assert.equal(restored.status.dirty, false);
});

test('enforces workspace containment, invokes Git without a shell, and bounds diff output', async (t) => {
  const { root } = await repositoryFixture(t);
  const spawns = [];
  const adapter = new GitToolAdapter({
    workspaceRoot: root,
    maxOutputBytes: 1_024,
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return spawn(command, args, options);
    },
  });
  await writeFile(path.join(root, 'README.md'), `${'x'.repeat(8_192)}\n`);

  const diff = await adapter.execute('git.diff', { paths: ['README.md'], maxOutputBytes: 1_024 });
  assert.equal(diff.truncated, true);
  assert.equal(diff.diff.length <= 1_024, true);
  assert.ok(spawns.length >= 2);
  assert.ok(spawns.every(({ options }) => options.shell === false && options.cwd === root));

  await assert.rejects(
    () => adapter.execute('git.stage', { paths: ['../outside.txt'] }),
    { code: 'GIT_PATH_ESCAPE', status: 403 },
  );
  await mkdir(path.join(root, 'nested'));
  await assert.rejects(
    () => adapter.forWorkspace(path.join(root, 'nested')).execute('git.status'),
    { code: 'GIT_WORKSPACE_ROOT_MISMATCH' },
  );
});
