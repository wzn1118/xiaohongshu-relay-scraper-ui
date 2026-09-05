import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexAppServerCommand } from './codex-runtime-resolver.mjs';

test('prefers the bundled cross-platform Codex package', () => {
  const root = path.resolve('fixture-workspace');
  const bundled = path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  const command = resolveCodexAppServerCommand({
    workspaceRoot: root,
    desktopRuntimeRoot: path.join(root, 'runtime'),
    nodeExecutable: '/node',
    platform: 'darwin',
    architecture: 'arm64',
    exists: (candidate) => candidate === bundled,
  });
  assert.equal(command.executablePath, bundled);
  assert.deepEqual(command.executableArgs, []);
  assert.equal(command.source, 'bundled-native');
});

test('prefers the packaged release runtime over npm optional packages', () => {
  const root = path.resolve('fixture-workspace');
  const packaged = path.join(root, 'runtime', 'codex', 'darwin-x64', 'bin', 'codex');
  const npmBinary = path.join(root, 'node_modules', '@openai', 'codex-darwin-x64', 'vendor', 'x86_64-apple-darwin', 'bin', 'codex');
  const command = resolveCodexAppServerCommand({
    workspaceRoot: root,
    platform: 'darwin',
    architecture: 'x64',
    exists: (candidate) => candidate === packaged || candidate === npmBinary,
  });
  assert.equal(command.executablePath, packaged);
  assert.equal(command.source, 'bundled-packaged-native');
});

test('honors an explicit native executable before bundled discovery', () => {
  const command = resolveCodexAppServerCommand({
    workspaceRoot: path.resolve('fixture-workspace'),
    executableOverride: './runtime/codex',
    nodeExecutable: '/node',
    platform: 'darwin',
    exists: () => true,
  });
  assert.equal(command.executablePath, path.resolve('fixture-workspace', 'runtime', 'codex'));
  assert.deepEqual(command.executableArgs, []);
  assert.equal(command.source, 'environment');
});
