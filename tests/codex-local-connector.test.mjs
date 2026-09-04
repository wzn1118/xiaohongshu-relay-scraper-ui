import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { maintenanceOrigin } from '../scripts/codex-local-connector.mjs';

test('connector maintenance prefers an allowed HTTPS control plane over a local development origin', () => {
  assert.equal(
    maintenanceOrigin('', ['http://127.0.0.1:46292', 'https://relay.example.test']),
    'https://relay.example.test',
  );
});

test('connector maintenance honors an explicit allowed control-plane origin', () => {
  assert.equal(
    maintenanceOrigin('http://127.0.0.1:46292', ['http://127.0.0.1:46292', 'https://relay.example.test']),
    'http://127.0.0.1:46292',
  );
});

test('connector packaging supports the public deployment and local production origin', async () => {
  const packaging = await readFile(new URL('../scripts/package-codex-local-connector.ps1', import.meta.url), 'utf8');
  const installation = await readFile(new URL('../scripts/install-local-connector-package.ps1', import.meta.url), 'utf8');
  assert.match(packaging, /@\('https:\/\/relay\.hegelsalon\.com', 'http:\/\/127\.0\.0\.1:4327'\)/u);
  assert.match(installation, /AllowedOrigin = @\(\$AllowedOrigin\)/u);
  assert.doesNotMatch(installation, /powershell\.exe @installerArgs/u);
});
