import path from 'node:path';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';

export function artifactId(relativePath) {
  return Buffer.from(normalizeRelativePath(relativePath), 'utf8').toString('base64url');
}

export function artifactPathFromId(root, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(id)) throw new Error('Invalid artifact id.');
  let decoded;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid artifact id.');
  }
  const relative = normalizeRelativePath(decoded);
  const absolute = path.resolve(root, relative);
  assertPathInside(root, absolute);
  return { absolute, relative };
}

export function assertPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new Error('Path escapes artifact root.');
}

export async function enumerateArtifacts(root) {
  const files = [];
  await walk(root, '', files);
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}

export async function resolveDownload(root, id) {
  const { absolute, relative } = artifactPathFromId(root, id);
  const [rootReal, targetReal, info] = await Promise.all([realpath(root), realpath(absolute), stat(absolute)]);
  assertPathInside(rootReal, targetReal);
  if (!info.isFile()) throw new Error('Artifact is not a file.');
  return { absolute: targetReal, relative, size: info.size };
}

async function walk(root, relativeDir, files) {
  const dir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    const absolute = path.join(root, relative);
    const linkInfo = await lstat(absolute);
    if (linkInfo.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(root, relative, files);
    if (entry.isFile()) {
      const info = await stat(absolute);
      const normalized = normalizeRelativePath(relative);
      files.push({
        id: artifactId(normalized),
        name: entry.name,
        path: normalized,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error('Invalid artifact path.');
  const portable = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable)) throw new Error('Artifact path must be relative.');
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('Path escapes artifact root.');
  return normalized;
}
