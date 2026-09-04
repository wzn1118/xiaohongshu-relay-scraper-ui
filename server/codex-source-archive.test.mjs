import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createCodexSourceArchive } from './codex-source-archive.mjs';

test('creates a portable source archive without runtime or secret material', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'xhs-codex-source-fixture-'));
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'xhs-codex-source-output-'));
  try {
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'node_modules', 'private-package'), { recursive: true });
    await mkdir(path.join(fixtureRoot, '.runtime'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'runtime'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'output'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'package.json'), '{}\n');
    await writeFile(path.join(fixtureRoot, 'src', 'keep.txt'), 'keep\n');
    await writeFile(path.join(fixtureRoot, '.env'), 'SECRET=fixture\n');
    await writeFile(path.join(fixtureRoot, '.env.example'), 'SECRET=\n');
    await writeFile(path.join(fixtureRoot, 'private.pem'), 'PRIVATE KEY\n');
    await writeFile(path.join(fixtureRoot, 'node_modules', 'private-package', 'hidden.txt'), 'hidden\n');
    await writeFile(path.join(fixtureRoot, '.runtime', 'hidden.txt'), 'hidden\n');
    await writeFile(path.join(fixtureRoot, 'runtime', 'hidden.txt'), 'hidden\n');
    await writeFile(path.join(fixtureRoot, 'output', 'hidden.txt'), 'hidden\n');

    const archive = await createCodexSourceArchive({ workspaceRoot: fixtureRoot, tempDirectory: archiveRoot });
    try {
      const listing = execFileSync('tar', ['-tzf', archive.archivePath], { encoding: 'utf8' });
      assert.match(listing, /\.\/package\.json/);
      assert.match(listing, /\.\/src\/keep\.txt/);
      assert.doesNotMatch(listing, /\.env/);
      assert.doesNotMatch(listing, /private\.pem/);
      assert.doesNotMatch(listing, /node_modules/);
      assert.doesNotMatch(listing, /\.runtime/);
      assert.doesNotMatch(listing, /(^|\/)runtime(\/|$)/);
      assert.doesNotMatch(listing, /output/);
    } finally {
      const archivePath = archive.archivePath;
      await archive.release();
      await assert.rejects(access(archivePath));
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});
