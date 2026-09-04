import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createCodexGitWorkerService } from './codex-git-worker-service.mjs';

const execFileAsync = promisify(execFile);

test('implements the Codex git worker request and live-query envelopes', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const metadata = await send(service, 'metadata-1', 'stable-metadata', { cwd: root, watchForGitInit: false });
    assert.equal(metadata.type, 'worker-response');
    assert.equal(metadata.response.result.type, 'ok');
    assert.equal(metadata.response.result.value.root.toLowerCase(), root.toLowerCase());

    await writeFile(path.join(root, 'untracked.txt'), 'pending\n', 'utf8');
    const status = await send(service, 'status-1', 'status-summary', { cwd: root, includeUntrackedFiles: true });
    assert.deepEqual(status.response.result.value, {
      type: 'success',
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 1,
    });

    await writeFile(path.join(root, 'README.md'), '# fixture\nupdated\n', 'utf8');
    const diffStats = await send(service, 'diff-stats-1', 'branch-diff-stats', {
      cwd: root,
      includeUntrackedFiles: true,
    });
    assert.equal(diffStats.response.result.value.fileCount, 2);
    assert.equal(diffStats.response.result.value.additions, 1);

    const reviewSummary = await send(service, 'review-summary-1', 'review-summary', {
      cwd: root,
      includeUntrackedFiles: true,
      source: 'uncommitted',
    });
    assert.equal(reviewSummary.response.result.value.type, 'success');
    assert.equal(reviewSummary.response.result.value.files.length, 2);
    assert.equal(reviewSummary.response.result.value.stageCounts.untrackedFileCount, 1);
    assert.equal(reviewSummary.response.result.value.files.find((file) => file.path === 'untracked.txt')?.changeKind, 'untracked');
    assert.match(reviewSummary.response.result.value.files.find((file) => file.path === 'README.md')?.revision || '', /^uncommitted:/u);
    const submodules = await send(service, 'submodules-1', 'submodule-paths', { root });
    assert.deepEqual(submodules.response.result.value, { paths: [] });

    const branch = (await git(root, ['branch', '--show-current'])).trim();
    const subscriptionId = `${JSON.stringify(['git', 'local', root, 'current-branch', { root }])}:${'a'.repeat(256)}`;
    const live = await service.handleMessage('git', {
      type: 'worker-request',
      workerId: 'git',
      request: {
        id: 'live-1',
        method: 'subscribe-live-query',
        params: {
          subscriptionId,
          query: { method: 'current-branch', params: { root } },
        },
      },
    }, { sessionId: 'browser-a' });
    assert.equal(live.messages[0].type, 'worker-event');
    assert.equal(live.messages[0].event.type, 'git-live-query-updated');
    assert.equal(live.messages[0].event.subscriptionId, subscriptionId);
    assert.equal(live.messages[0].event.generation, 1);
    assert.equal(live.messages[0].event.requiresRecovery, false);
    assert.equal(live.messages[0].event.result.branch, branch);
    assert.equal(service.status().capabilities.workerIds[0], 'git');
    assert.deepEqual(
      ['commit-message-diff', 'review-diff', 'review-patch', 'review-search'].every((method) => service.status().capabilities.methods.read.includes(method)),
      true,
    );
    assert.deepEqual(
      ['apply-changes', 'apply-patch', 'apply-review-section-changes'].every((method) => service.status().capabilities.methods.mutation.includes(method)),
      true,
    );
    assert.equal(service.status().capabilities.methods.read.includes('worktree-status'), true);
    assert.deepEqual(
      ['create-worktree', 'remove-worktree', 'prune-worktrees'].every((method) => service.status().capabilities.methods.mutation.includes(method)),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns structured worker errors for unknown methods and paths outside the workspace', async () => {
  const root = await createRepository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-git-outside-'));
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const unsupported = await send(service, 'unknown-1', 'arbitrary-command', { cwd: root });
    assert.equal(unsupported.response.result.type, 'error');
    assert.equal(unsupported.response.result.error.code, 'CODEX_GIT_WORKER_METHOD_NOT_IMPLEMENTED');

    const nullableMetadata = await send(service, 'metadata-outside-1', 'stable-metadata', { cwd: outside });
    assert.equal(nullableMetadata.response.result.type, 'ok');
    assert.equal(nullableMetadata.response.result.value, null);

    const escaped = await send(service, 'escape-1', 'current-branch', { root: outside });
    assert.equal(escaped.response.result.type, 'error');
    assert.equal(escaped.response.result.error.code, 'CODEX_GIT_WORKER_PATH_OUTSIDE_WORKSPACE');
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('implements advanced review diffs, patches, search, and commit-message diffs', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    await writeFile(path.join(root, 'README.md'), '# fixture\nstaged needle\n', 'utf8');
    await git(root, ['add', 'README.md']);
    await writeFile(path.join(root, 'README.md'), '# fixture\nstaged needle\nunstaged needle\n', 'utf8');
    await writeFile(path.join(root, 'untracked.txt'), 'untracked needle\n', 'utf8');

    const summary = await send(service, 'advanced-summary-1', 'review-summary', {
      cwd: root,
      includeUntrackedFiles: true,
      source: 'uncommitted',
    });
    const summaryValue = summary.response.result.value;
    assert.equal(summaryValue.type, 'success');
    assert.equal(summaryValue.files.length, 2);

    const patch = await send(service, 'advanced-patch-1', 'review-patch', {
      cwd: root,
      source: 'uncommitted',
    });
    const patchValue = patch.response.result.value;
    assert.equal(patchValue.source, 'uncommitted');
    assert.equal(patchValue.diff.type, 'success');
    assert.match(patchValue.diff.unifiedDiff, /staged needle/u);
    assert.match(patchValue.diff.unifiedDiff, /unstaged needle/u);
    assert.match(patchValue.diff.unifiedDiff, /untracked needle/u);
    assert.equal(patchValue.diff.unifiedDiffBytes, Buffer.byteLength(patchValue.diff.unifiedDiff));

    const reviewDiff = await send(service, 'advanced-review-diff-1', 'review-diff', {
      cwd: root,
      source: 'uncommitted',
      snapshotGeneration: summaryValue.snapshotGeneration,
      files: [
        { path: 'README.md', changeKind: 'modified' },
        { path: 'untracked.txt', changeKind: 'untracked' },
      ],
    });
    const reviewDiffValue = reviewDiff.response.result.value;
    assert.equal(reviewDiffValue.source, 'uncommitted');
    assert.equal(reviewDiffValue.diffs['README.md'].type, 'success');
    assert.match(reviewDiffValue.diffs['README.md'].diff, /unstaged needle/u);
    assert.equal(reviewDiffValue.diffs['untracked.txt'].type, 'success');
    assert.match(reviewDiffValue.diffs['untracked.txt'].diff, /new file mode/u);

    const stale = await send(service, 'advanced-review-diff-stale-1', 'review-diff', {
      cwd: root,
      source: 'uncommitted',
      snapshotGeneration: summaryValue.snapshotGeneration + 1,
      files: [{ path: 'README.md', changeKind: 'modified' }],
    });
    assert.deepEqual(stale.response.result.value, { type: 'stale-snapshot', source: 'uncommitted' });

    const search = await send(service, 'advanced-search-1', 'review-search', {
      cwd: root,
      includeUntrackedFiles: true,
      query: 'needle',
      source: 'uncommitted',
    });
    const searchValue = search.response.result.value;
    assert.equal(searchValue.type, 'success');
    assert.equal(searchValue.totalMatches, 3);
    assert.equal(searchValue.isCapped, false);
    assert.deepEqual(new Set(searchValue.matches.map((entry) => entry.path)), new Set(['README.md', 'untracked.txt']));
    assert.ok(searchValue.matches.every((entry) => entry.snippet.match.toLowerCase() === 'needle'));

    const staged = await send(service, 'advanced-commit-message-staged-1', 'commit-message-diff', {
      cwd: root,
      includeUnstaged: false,
    });
    assert.equal(staged.response.result.value.type, 'success');
    assert.match(staged.response.result.value.unifiedDiff, /staged needle/u);
    assert.doesNotMatch(staged.response.result.value.unifiedDiff, /unstaged needle/u);

    const allTracked = await send(service, 'advanced-commit-message-all-1', 'commit-message-diff', {
      cwd: root,
      includeUnstaged: true,
    });
    assert.equal(allTracked.response.result.value.type, 'success');
    assert.match(allTracked.response.result.value.unifiedDiff, /unstaged needle/u);
    assert.doesNotMatch(allTracked.response.result.value.unifiedDiff, /untracked needle/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects review pathspecs that escape the active repository', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const escaped = await send(service, 'advanced-path-escape-1', 'review-diff', {
      cwd: root,
      source: 'uncommitted',
      files: [{ path: '../outside.txt', changeKind: 'modified' }],
    });
    assert.equal(escaped.response.result.type, 'error');
    assert.equal(escaped.response.result.error.code, 'CODEX_GIT_WORKER_PATHSPEC_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies, reverses, stages, unstages, and reverts review patches in a bounded repository', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const patch = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      ' # fixture',
      '+applied patch',
      '',
    ].join('\n');

    const applied = await send(service, 'apply-patch-1', 'apply-patch', {
      cwd: root,
      atomic: true,
      diff: patch,
      target: 'unstaged',
    });
    assert.deepEqual(applied.response.result.value.appliedPaths, ['README.md']);
    assert.equal(applied.response.result.value.status, 'success');
    assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /applied patch/u);

    const reverted = await send(service, 'apply-patch-2', 'apply-patch', {
      cwd: root,
      atomic: true,
      diff: patch,
      revert: true,
      target: 'unstaged',
    });
    assert.equal(reverted.response.result.value.status, 'success');
    assert.equal(normalizeNewlines(await readFile(path.join(root, 'README.md'), 'utf8')), '# fixture\n');

    await writeFile(path.join(root, 'README.md'), '# fixture\nsection change\n', 'utf8');
    const staged = await send(service, 'section-stage-1', 'apply-review-section-changes', {
      action: 'stage',
      cwd: root,
      files: [{ path: 'README.md', changeKind: 'modified' }],
      source: 'unstaged',
    });
    assert.equal(staged.response.result.value.status, 'success', JSON.stringify(staged.response.result.value));
    assert.match(await git(root, ['diff', '--cached']), /section change/u);

    const unstaged = await send(service, 'section-unstage-1', 'apply-review-section-changes', {
      action: 'unstage',
      cwd: root,
      files: [{ path: 'README.md', changeKind: 'modified' }],
      source: 'staged',
    });
    assert.equal(unstaged.response.result.value.status, 'success');
    assert.equal(await git(root, ['diff', '--cached']), '');
    assert.match(await git(root, ['diff']), /section change/u);

    await send(service, 'section-stage-2', 'apply-review-section-changes', {
      action: 'stage',
      cwd: root,
      files: [{ path: 'README.md', changeKind: 'modified' }],
      source: 'unstaged',
    });
    const sectionReverted = await send(service, 'section-revert-1', 'apply-review-section-changes', {
      action: 'revert',
      cwd: root,
      files: [{ path: 'README.md', changeKind: 'modified' }],
      source: 'staged',
    });
    assert.equal(sectionReverted.response.result.value.status, 'success');
    assert.equal(normalizeNewlines(await readFile(path.join(root, 'README.md'), 'utf8')), '# fixture\n');
    assert.equal(await git(root, ['diff', '--cached']), '');

    await writeFile(path.join(root, 'untracked.txt'), 'untracked section\n', 'utf8');
    const untrackedReverted = await send(service, 'section-untracked-revert-1', 'apply-review-section-changes', {
      action: 'revert',
      cwd: root,
      files: [{ path: 'untracked.txt', changeKind: 'untracked' }],
      source: 'unstaged',
    });
    assert.equal(untrackedReverted.response.result.value.status, 'success');
    await assert.rejects(readFile(path.join(root, 'untracked.txt'), 'utf8'), { code: 'ENOENT' });

    await writeFile(path.join(root, 'README.md'), '# fixture\nfirst revision\n', 'utf8');
    const staleSummary = await send(service, 'section-stale-summary-1', 'review-summary', {
      cwd: root,
      includeUntrackedFiles: true,
      source: 'unstaged',
    });
    const staleFile = staleSummary.response.result.value.files.find((file) => file.path === 'README.md');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(root, 'README.md'), '# fixture\nsecond revision\n', 'utf8');
    const staleApply = await send(service, 'section-stale-apply-1', 'apply-review-section-changes', {
      action: 'stage',
      cwd: root,
      files: [staleFile],
      source: 'unstaged',
    });
    assert.equal(staleApply.response.result.value.status, 'error');
    assert.equal(staleApply.response.result.value.errorCode, 'stale-review');
    assert.equal(await git(root, ['diff', '--cached']), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies a source tree to a destination checkout and rejects patch path escapes', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const initialBranch = (await git(root, ['branch', '--show-current'])).trim();
    await git(root, ['checkout', '-b', 'source-branch']);
    await writeFile(path.join(root, 'README.md'), '# fixture\nfrom source branch\n', 'utf8');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'source change']);
    await git(root, ['checkout', initialBranch]);

    const applied = await send(service, 'apply-changes-1', 'apply-changes', {
      destinationHeadRef: 'HEAD',
      destinationRoot: root,
      sourceHeadRef: 'source-branch',
      sourceTreeRef: 'source-branch^{tree}',
    });
    assert.equal(applied.response.result.value.status, 'success');
    assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /from source branch/u);

    const escaped = await send(service, 'apply-patch-escape-1', 'apply-patch', {
      cwd: root,
      atomic: true,
      diff: 'diff --git a/../outside.txt b/../outside.txt\n--- a/../outside.txt\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+blocked\n',
    });
    assert.equal(escaped.response.result.type, 'error');
    assert.equal(escaped.response.result.error.code, 'CODEX_GIT_WORKER_PATHSPEC_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates, inspects, removes, and prunes managed worktrees through the browser worker', async () => {
  const root = await createRepository();
  try {
    const service = createCodexGitWorkerService({ workspaceRoot: root });
    const created = await send(service, 'worktree-create-1', 'create-worktree', {
      cwd: root,
      id: 'task-a',
      branch: 'codex/task-a',
      baseRef: 'HEAD',
    });
    const createdValue = created.response.result.value;
    assert.equal(created.response.result.type, 'ok');
    assert.equal(createdValue.id, 'task-a');
    assert.equal(createdValue.branch, 'codex/task-a');
    assert.equal(createdValue.detached, false);
    assert.ok(createdValue.path.startsWith(path.join(root, '.agent-worktrees')));

    const status = await send(service, 'worktree-status-1', 'worktree-status', {
      cwd: root,
      path: createdValue.path,
    });
    assert.equal(status.response.result.type, 'ok');
    assert.equal(status.response.result.value.path, createdValue.path);
    assert.equal(status.response.result.value.branch, 'codex/task-a');
    assert.equal(status.response.result.value.dirty, false);

    const invalid = await send(service, 'worktree-create-invalid-1', 'create-worktree', {
      cwd: root,
      id: '../outside',
    });
    assert.equal(invalid.response.result.type, 'error');
    assert.equal(invalid.response.result.error.code, 'WORKTREE_ID_INVALID');

    const removed = await send(service, 'worktree-remove-1', 'remove-worktree', {
      cwd: root,
      path: createdValue.path,
      force: true,
    });
    assert.deepEqual(removed.response.result.value, { path: createdValue.path, removed: true });

    const pruned = await send(service, 'worktree-prune-1', 'prune-worktrees', { cwd: root });
    assert.deepEqual(pruned.response.result.value, { pruned: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRepository() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-git-worker-'));
  const root = await realpath(temporaryRoot);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'codex-worker@example.invalid']);
  await git(root, ['config', 'user.name', 'Codex Worker Test']);
  await writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'fixture']);
  return root;
}

async function git(cwd, args) {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true });
  return result.stdout;
}

async function send(service, id, method, params) {
  const result = await service.handleMessage('git', {
    type: 'worker-request',
    workerId: 'git',
    request: { id, method, params },
  }, { sessionId: 'browser-a' });
  assert.equal(result.accepted, true);
  assert.equal(result.messages.length, 1);
  return result.messages[0];
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/gu, '\n');
}
