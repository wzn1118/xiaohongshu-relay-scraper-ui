import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { listRepositoryFiles } from './repo-files.mjs';

const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['credential in connection URL', /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^:\s/@]+:[^@\s/]+@/gi],
];
const BINARY_EXTENSIONS = new Set([
  '.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.sqlite', '.webp', '.zip',
]);

export function scanCredentialText(text, file = '<memory>') {
  const findings = [];
  for (const [label, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ file, line, label });
    }
  }
  return findings;
}

export async function scanRepositoryCredentials(files = listRepositoryFiles()) {
  const findings = [];
  for (const file of files) {
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) continue;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanCredentialText(text, file));
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = await scanRepositoryCredentials();
  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: possible ${finding.label}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Credential scan passed.');
  }
}
