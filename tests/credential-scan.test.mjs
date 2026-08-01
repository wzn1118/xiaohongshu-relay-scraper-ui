import assert from 'node:assert/strict';
import test from 'node:test';

import { scanCredentialText } from '../scripts/check-credentials.mjs';

test('credential scanner detects strong token and private-key signatures', () => {
  const fakeToken = `sk-${'A'.repeat(32)}`;
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const findings = scanCredentialText(`${fakeToken}\n${privateKey}\n`, 'fixture.txt');
  assert.deepEqual(findings.map(({ label }) => label), ['private key', 'OpenAI-style key']);
});

test('credential scanner ignores documented placeholders and environment access', () => {
  const source = 'AI_API_KEY=YOUR_API_KEY\nconst token = process.env.AI_API_KEY;\n';
  assert.deepEqual(scanCredentialText(source, '.env.example'), []);
});
