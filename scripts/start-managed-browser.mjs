import path from 'node:path';
import process from 'node:process';
import { ensureNativeBrowser, probeNativeBrowser, resolveManagedBrowserProfileDir } from '../server/lib/native-browser.mjs';
import { openRelayLogin } from '../server/lib/relay-connect.mjs';
import { probeRelay } from '../server/lib/relay.mjs';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 18800);
const profile = args.profile || 'openclaw';
const dataDir = path.resolve(args['data-dir'] || path.join(process.cwd(), 'data', 'browser'));
const profileDir = resolveManagedBrowserProfileDir(dataDir, profile);
const openClawConfigPath = args['openclaw-config'] || process.env.OPENCLAW_CONFIG_PATH || path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.openclaw',
  'openclaw.json',
);

const existing = await probeRelay({ port, openClawConfigPath });
let status = existing.ok
  ? { ...existing, backend: 'existing-cdp', started: false, alreadyRunning: true }
  : args.checkOnly
    ? await probeNativeBrowser({ port })
    : await ensureNativeBrowser({ port, profileDir, url: args.url || 'about:blank', timeoutMs: 20000 });

if (!args.checkOnly && args.ensureTarget && status.running && status.cdpReady && Number(status.xiaohongshuTabs || 0) < 1) {
  const target = await openRelayLogin({
    port,
    openClawConfigPath,
    profile,
    url: args.url || 'https://www.xiaohongshu.com/explore',
    timeoutMs: 15000,
  });
  status = { ...(await probeRelay({ port, openClawConfigPath })), target };
}

console.log(JSON.stringify({
  ...status,
  backend: status.backend || 'native-cdp',
  port,
  profile,
  profileDir,
}, null, 2));
if (!status.running) process.exitCode = 2;

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--check-only') parsed.checkOnly = true;
    else if (value === '--ensure-target') parsed.ensureTarget = true;
    else if (value.startsWith('--')) parsed[value.slice(2)] = values[index + 1];
    if (value.startsWith('--') && !value.includes('=') && values[index + 1] && !values[index + 1].startsWith('--')) index += 1;
  }
  return parsed;
}
