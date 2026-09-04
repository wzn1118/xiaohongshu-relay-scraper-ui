#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORM_NAMES = new Set(['win32', 'darwin']);
const ARCHITECTURES = new Set(['x64', 'arm64']);

export async function findCodexBinary({ sourceRoot, platform, architecture }) {
  const packageRoot = path.join(sourceRoot, 'node_modules', '@openai', `codex-${platform}-${architecture}`);
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [];
  await walk(packageRoot, candidates, (entry) => entry.isFile && path.basename(entry.path) === binaryName);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${platform}-${architecture} Codex binary in the installed optional package; found ${candidates.length}.`);
  }
  await assertBinary(candidates[0].path, platform, architecture);
  return candidates[0].path;
}

export async function stageCodexRuntime({ sourceRoot, stageRoot, platform, architecture }) {
  const binaryPath = await findCodexBinary({ sourceRoot, platform, architecture });
  const relativeRoot = `runtime/codex/${platform}-${architecture}`;
  const relativeExecutable = `${relativeRoot}/bin/${platform === 'win32' ? 'codex.exe' : 'codex'}`;
  const destinationRoot = path.join(stageRoot, relativeRoot);
  const nativeTargetRoot = path.dirname(path.dirname(binaryPath));
  await mkdir(destinationRoot, { recursive: true });
  await cp(nativeTargetRoot, destinationRoot, { recursive: true, force: true });
  const destination = path.join(stageRoot, relativeExecutable);
  const digest = await sha256(destination);
  const packageName = `@openai/codex-${platform}-${architecture}`;
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'node_modules', '@openai', `codex-${platform}-${architecture}`, 'package.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1,
    edition: 'codex-built-in',
    platform,
    architecture,
    target: `${platform}-${architecture}`,
    executable: relativeExecutable,
    sha256: digest,
    sourcePackage: packageName,
    sourceVersion: String(packageJson.version || ''),
  };
  await writeFile(path.join(stageRoot, 'runtime/codex/codex-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ...manifest, binaryPath };
}

export async function verifyCodexRuntime({ projectRoot, platform, architecture }) {
  const manifestPath = path.join(projectRoot, 'runtime', 'codex', 'codex-runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.edition !== 'codex-built-in') throw new Error('Invalid Codex runtime manifest schema.');
  if (manifest.platform !== platform || manifest.architecture !== architecture || manifest.target !== `${platform}-${architecture}`) {
    throw new Error(`Codex runtime target mismatch: expected ${platform}-${architecture}.`);
  }
  if (!/^runtime\/codex\/(win32|darwin)-(x64|arm64)\/bin\/codex(?:\.exe)?$/u.test(manifest.executable)) throw new Error('Codex runtime executable must be a relative package path.');
  const executablePath = path.join(projectRoot, manifest.executable);
  await stat(executablePath);
  await assertBinary(executablePath, platform, architecture);
  const digest = await sha256(executablePath);
  if (digest !== manifest.sha256) throw new Error('Codex runtime SHA-256 does not match its manifest.');
  return { ok: true, platform, architecture, target: manifest.target, sha256: digest, sourcePackage: manifest.sourcePackage, sourceVersion: manifest.sourceVersion };
}

async function walk(directory, output, predicate) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, output, predicate);
    else if (predicate({ path: entryPath, isFile: entry.isFile() })) output.push({ path: entryPath });
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function assertBinary(filePath, platform, architecture) {
  const bytes = await readFile(filePath);
  if (platform === 'win32') {
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Codex runtime is not a Windows PE executable: ${path.basename(filePath)}.`);
    const peOffset = bytes.readUInt32LE(0x3c);
    if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Codex runtime has an invalid PE header.');
    const machine = bytes.readUInt16LE(peOffset + 4);
    const expected = architecture === 'x64' ? 0x8664 : 0xaa64;
    if (machine !== expected) throw new Error(`Codex runtime PE architecture mismatch: 0x${machine.toString(16)}.`);
    return;
  }
  if (bytes.length < 8) throw new Error('Codex runtime is too small to be Mach-O.');
  const magic = bytes.readUInt32BE(0);
  const cputypes = new Set();
  if ([0xcffaedfe, 0xfeedfacf, 0xcefaedfe, 0xfeedface].includes(magic)) {
    const little = [0xcffaedfe, 0xcefaedfe].includes(magic);
    cputypes.add(little ? bytes.readInt32LE(4) : bytes.readInt32BE(4));
  } else if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const little = magic === 0xbebafeca;
    const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    for (let index = 0; index < count; index += 1) cputypes.add(little ? bytes.readInt32LE(8 + index * 20) : bytes.readInt32BE(8 + index * 20));
  } else throw new Error(`Codex runtime is not a Mach-O executable: ${path.basename(filePath)}.`);
  const expected = architecture === 'x64' ? 0x01000007 : 0x0100000c;
  if (!cputypes.has(expected)) throw new Error(`Codex runtime Mach-O architecture mismatch for ${architecture}.`);
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--')) throw new Error(`Unknown argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    values[name] = args[++index];
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || 'verify';
  if (!PLATFORM_NAMES.has(args.platform) || !ARCHITECTURES.has(args.architecture)) throw new Error('platform must be win32 or darwin and architecture must be x64 or arm64.');
  const result = mode === 'stage'
    ? await stageCodexRuntime({ sourceRoot: path.resolve(args.sourceRoot || process.cwd()), stageRoot: path.resolve(args.stageRoot), platform: args.platform, architecture: args.architecture })
    : await verifyCodexRuntime({ projectRoot: path.resolve(args.projectRoot), platform: args.platform, architecture: args.architecture });
  const { binaryPath: _binaryPath, ...safe } = result;
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}
