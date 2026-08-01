import { spawnSync } from 'node:child_process';

import { listRepositoryFiles } from './repo-files.mjs';

const failures = [];
const nodeFiles = listRepositoryFiles().filter((file) => /\.(?:cjs|js|mjs)$/.test(file));
for (const file of nodeFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(result.stderr.trim() || `${file}: syntax check failed`);
}

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonResult = spawnSync(python, ['-m', 'compileall', '-q', 'scripts', 'tests'], { encoding: 'utf8' });
if (pythonResult.status !== 0) {
  failures.push(pythonResult.stderr.trim() || 'Python compile check failed.');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Syntax checks passed (${nodeFiles.length} Node files plus Python sources).`);
}
