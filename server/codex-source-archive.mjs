import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';

import { SOURCE_EXCLUDED_DIRECTORIES } from './codex-product-workspace-service.mjs';

const SOURCE_EXCLUDED_PATTERNS = [
  ...SOURCE_EXCLUDED_DIRECTORIES,
  '.env*',
  '*.pem',
  '*.key',
];

export class CodexSourceArchiveError extends Error {
  constructor(message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CodexSourceArchiveError';
    this.code = 'CODEX_SOURCE_ARCHIVE_FAILED';
  }
}

export async function createCodexSourceArchive({ workspaceRoot, fileName = 'xiaohongshu-relay-scraper-source.tar.gz', tempDirectory = tmpdir(), spawnProcess = spawn } = {}) {
  const configuredRoot = String(workspaceRoot || '').trim();
  if (!configuredRoot) throw new CodexSourceArchiveError('The product workspace root is missing.');
  const root = path.resolve(configuredRoot);
  const temporaryRoot = await mkdtemp(path.join(path.resolve(tempDirectory), 'xhs-codex-source-'));
  const archivePath = path.join(temporaryRoot, fileName);
  try {
    await createTarGzip({ root, archivePath, spawnProcess });
    const info = await stat(archivePath);
    if (!info.isFile() || info.size <= 0) throw new CodexSourceArchiveError('The source archive is empty.');
    return {
      archivePath,
      fileName,
      size: Number(info.size),
      release: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof CodexSourceArchiveError) throw error;
    throw new CodexSourceArchiveError('The product source archive could not be created.', error);
  }
}

function createTarGzip({ root, archivePath, spawnProcess }) {
  const args = [
    '-czf',
    archivePath,
    ...SOURCE_EXCLUDED_PATTERNS.map((pattern) => `--exclude=${pattern}`),
    '-C',
    root,
    '.',
  ];
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    let child;
    try {
      child = spawnProcess('tar', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      settle(new CodexSourceArchiveError('The system tar command could not start.', error));
      return;
    }
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr = `${stderr}${String(chunk || '')}`.slice(-8 * 1024); });
    child.once?.('error', (error) => settle(new CodexSourceArchiveError('The system tar command could not start.', error)));
    child.once?.('close', (code) => {
      if (code === 0) return settle();
      settle(new CodexSourceArchiveError(`The system tar command exited with code ${code}.${stderr ? ` ${stderr.trim()}` : ''}`));
    });
  });
}
