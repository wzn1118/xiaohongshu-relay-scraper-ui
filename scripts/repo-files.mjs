import { spawnSync } from 'node:child_process';

export function listRepositoryFiles() {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: 'buffer',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || 'git ls-files failed.');
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('test-results/'))
    .sort();
}
