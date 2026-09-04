import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { GitWorktreeManager, GitWorktreeError } from './git-worktree-manager.mjs';

const execFile = promisify(execFileCallback);

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-worktree-'));
  await execFile('git', ['init', '-q', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Test User']);
  await writeFile(path.join(root, 'README.md'), 'initial\n');
  await execFile('git', ['-C', root, 'add', 'README.md']);
  await execFile('git', ['-C', root, 'commit', '-qm', 'initial']);
  const worktreeRoot = path.join(root, '.agent-worktrees');
  await mkdir(worktreeRoot, { recursive: true });
  return { root, worktreeRoot };
}

test('creates, reports, diffs, and removes a contained detached worktree', async () => {
  const fixture = await createRepository();
  const manager = new GitWorktreeManager({ repositoryRoot: fixture.root, worktreeRoot: fixture.worktreeRoot });
  await manager.initialize();
  const created = await manager.create({ id: 'task-1' });
  assert.equal(created.id, 'task-1');
  assert.equal(created.detached, true);
  assert.ok(created.path.startsWith(fixture.worktreeRoot));

  await writeFile(path.join(created.path, 'README.md'), 'changed\n');
  const status = await manager.status(created.path);
  assert.equal(status.dirty, true);
  const diff = await manager.diff(created.path);
  assert.match(diff.diff, /changed/);
  const listed = await manager.list();
  assert.ok(listed.some((entry) => entry.path === created.path && entry.managed));
  assert.deepEqual(await manager.remove(created.path, { force: true }), { path: created.path, removed: true });
});

test('rejects path traversal and malformed Git refs before shell-free command execution', async () => {
  const fixture = await createRepository();
  const manager = new GitWorktreeManager({ repositoryRoot: fixture.root, worktreeRoot: fixture.worktreeRoot });
  await manager.initialize();
  await assert.rejects(() => manager.create({ id: '../outside' }), GitWorktreeError);
  await assert.rejects(() => manager.create({ id: 'safe', branch: 'bad ref' }), {
    code: 'WORKTREE_REF_INVALID',
  });
  await assert.rejects(() => manager.status(fixture.root), {
    code: 'WORKTREE_PATH_ESCAPE',
  });
});
