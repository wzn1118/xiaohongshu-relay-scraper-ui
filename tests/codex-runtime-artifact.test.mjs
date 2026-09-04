import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageCodexRuntime, verifyCodexRuntime } from '../scripts/codex-runtime-artifact.mjs';

test('stages and verifies only the declared Windows PE architecture', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-pe-'));
  try {
    const sourceRoot = path.join(root, 'source');
    const stageRoot = path.join(root, 'stage');
    const packageRoot = path.join(sourceRoot, 'node_modules/@openai/codex-win32-x64');
    const binaryPath = path.join(packageRoot, 'vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version: 'fixture-win32-x64' }));
    await writeFile(binaryPath, peBinary(0x8664));
    const staged = await stageCodexRuntime({ sourceRoot, stageRoot, platform: 'win32', architecture: 'x64' });
    assert.equal(staged.executable, 'runtime/codex/win32-x64/bin/codex.exe');
    const verified = await verifyCodexRuntime({ projectRoot: stageRoot, platform: 'win32', architecture: 'x64' });
    assert.equal(verified.ok, true);
    await assert.rejects(() => verifyCodexRuntime({ projectRoot: stageRoot, platform: 'win32', architecture: 'arm64' }), /target mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a Linux or wrong-architecture binary presented as macOS', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-macho-'));
  try {
    const executable = 'runtime/codex/darwin-arm64/bin/codex';
    const binaryPath = path.join(root, executable);
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    await writeManifest(root, executable, 'darwin', 'arm64', binaryPath);
    await assert.rejects(() => verifyCodexRuntime({ projectRoot: root, platform: 'darwin', architecture: 'arm64' }), /not a Mach-O/u);

    await writeFile(binaryPath, machoBinary(0x01000007));
    await writeManifest(root, executable, 'darwin', 'arm64', binaryPath);
    await assert.rejects(() => verifyCodexRuntime({ projectRoot: root, platform: 'darwin', architecture: 'arm64' }), /architecture mismatch/u);

    await writeFile(binaryPath, machoBinary(0x0100000c));
    await writeManifest(root, executable, 'darwin', 'arm64', binaryPath);
    assert.equal((await verifyCodexRuntime({ projectRoot: root, platform: 'darwin', architecture: 'arm64' })).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function peBinary(machine) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

function machoBinary(cpuType) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0xcffaedfe, 0);
  bytes.writeInt32LE(cpuType, 4);
  return bytes;
}

async function writeManifest(root, executable, platform, architecture, binaryPath) {
  const sha256 = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  await writeFile(path.join(root, 'runtime/codex/codex-runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    edition: 'codex-built-in',
    platform,
    architecture,
    target: `${platform}-${architecture}`,
    executable,
    sha256,
    sourcePackage: '@openai/codex-fixture',
    sourceVersion: 'fixture',
  }));
}
