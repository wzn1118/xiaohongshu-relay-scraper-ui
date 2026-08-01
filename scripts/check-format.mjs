import { readFile } from 'node:fs/promises';

import { listRepositoryFiles } from './repo-files.mjs';

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.py',
  '.sh', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const IGNORED_FILES = new Set(['package-lock.json']);

const failures = [];
for (const file of listRepositoryFiles()) {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) || IGNORED_FILES.has(file)) continue;
  const text = await readFile(file, 'utf8');
  if (text.includes('\0')) {
    failures.push(`${file}: contains a NUL byte`);
    continue;
  }
  if (text && !text.endsWith('\n')) failures.push(`${file}: missing final newline`);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (/[ \t]+$/.test(lines[index])) failures.push(`${file}:${index + 1}: trailing whitespace`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Format check passed.');
}
