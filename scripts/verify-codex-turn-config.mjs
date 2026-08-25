import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCodexIceService } from '../server/codex-ice-service.mjs';
import { probeCodexTurnRelay } from './probe-codex-turn-relay.mjs';

const DEFAULT_ENV_FILE = '.runtime/codex-turn/product-turn.env';

export function parseTurnEnvironment(text) {
  const environment = {};
  const supportedKeys = new Set([
    'XHS_CODEX_MIRROR_ICE_SERVERS_JSON',
    'XHS_CODEX_TURN_URLS_JSON',
    'XHS_CODEX_TURN_SHARED_SECRET',
    'XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS',
  ]);
  for (const [index, sourceLine] of String(text || '').split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid environment entry at line ${index + 1}.`);
    const [, name, rawValue] = match;
    if (!supportedKeys.has(name)) continue;
    if (Object.hasOwn(environment, name)) throw new Error(`Duplicate TURN environment key: ${name}.`);
    environment[name] = unquote(rawValue.trim());
  }
  return environment;
}

export function verifyTurnEnvironment(environment, { now = () => new Date() } = {}) {
  return createVerifiedTurnRuntime(environment, { now }).report;
}

function createVerifiedTurnRuntime(environment, { now = () => new Date() } = {}) {
  const turnUrls = parseJsonArray(environment.XHS_CODEX_TURN_URLS_JSON, 'XHS_CODEX_TURN_URLS_JSON');
  if (turnUrls.length < 1 || turnUrls.length > 8) {
    throw new Error('XHS_CODEX_TURN_URLS_JSON must contain from one to eight TURN URLs.');
  }
  const sharedSecret = String(environment.XHS_CODEX_TURN_SHARED_SECRET || '');
  if (sharedSecret.length < 32 || sharedSecret.length > 256 || /\r|\n/.test(sharedSecret)) {
    throw new Error('XHS_CODEX_TURN_SHARED_SECRET must contain 32 to 256 characters without line breaks.');
  }
  const staticIceServers = environment.XHS_CODEX_MIRROR_ICE_SERVERS_JSON
    ? parseJsonArray(environment.XHS_CODEX_MIRROR_ICE_SERVERS_JSON, 'XHS_CODEX_MIRROR_ICE_SERVERS_JSON')
    : [];
  const credentialTtlSeconds = parseTtl(environment.XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS);
  const service = createCodexIceService({
    staticIceServers,
    turnUrls,
    turnSharedSecret: sharedSecret,
    credentialTtlSeconds,
    now,
  });
  const status = service.status();
  const issued = service.issue({ subject: 'turn-config-verification' });
  const turnServer = issued.iceServers.at(-1);
  if (!status.turnConfigured || !status.crossNetworkReady || status.turnCredentialMode !== 'time-limited-hmac') {
    throw new Error('TURN configuration did not activate relay fallback.');
  }
  if (!turnServer?.username || !turnServer?.credential || !issued.expiresAt) {
    throw new Error('TURN configuration did not issue temporary credentials.');
  }
  if (JSON.stringify({ status, issued }).includes(sharedSecret)) {
    throw new Error('TURN verification output exposed the shared secret.');
  }
  const report = {
    turnConfigured: true,
    crossNetworkReady: true,
    connectivityMode: status.connectivityMode,
    turnCredentialMode: status.turnCredentialMode,
    credentialTtlSeconds: status.credentialTtlSeconds,
    staticServers: status.staticServers,
    turnUrlCount: turnUrls.length,
    credentialExpiresAt: issued.expiresAt,
    sharedSecretExposed: false,
  };
  return { report, issued };
}

export async function verifyTurnConfig({
  envFile = DEFAULT_ENV_FILE,
  statusUrl = '',
  probeRelay = false,
  probeTimeoutMs = 15_000,
  chromiumLauncher,
} = {}) {
  const absoluteEnvFile = resolve(envFile);
  const environment = parseTurnEnvironment(await readFile(absoluteEnvFile, 'utf8'));
  const { report, issued } = createVerifiedTurnRuntime(environment);
  const runtime = statusUrl ? await verifyRuntimeStatus(statusUrl) : null;
  const relayProbe = probeRelay
    ? await probeCodexTurnRelay({ iceServers: issued.iceServers, timeoutMs: probeTimeoutMs, chromiumLauncher })
    : null;
  return {
    ok: true,
    envFile: absoluteEnvFile,
    ...report,
    runtime,
    relayProbe,
  };
}

async function verifyRuntimeStatus(statusUrl) {
  const response = await fetch(statusUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`TURN runtime status request failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload?.ice?.turnConfigured !== true || payload?.ice?.crossNetworkReady !== true) {
    throw new Error('The running API has not activated TURN relay fallback.');
  }
  return {
    statusUrl,
    turnConfigured: true,
    crossNetworkReady: true,
    connectivityMode: String(payload.ice.connectivityMode || ''),
  };
}

function parseJsonArray(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch (error) {
    throw new Error(`${name} must be a valid JSON array: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array.`);
  return parsed;
}

function parseTtl(value) {
  const normalized = value === undefined || value === '' ? 600 : Number(value);
  if (!Number.isInteger(normalized) || normalized < 60 || normalized > 3_600) {
    throw new Error('XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS must be an integer from 60 to 3600.');
  }
  return normalized;
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--probe-relay') {
      options.probeRelay = true;
      continue;
    }
    const key = ({
      '--env': 'envFile',
      '--status-url': 'statusUrl',
      '--probe-timeout-ms': 'probeTimeoutMs',
    })[name];
    if (!key) throw new Error(`Unknown argument: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  verifyTurnConfig(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: {
          code: String(error.code || 'CODEX_TURN_VERIFICATION_FAILED'),
          message: error.message,
          details: error.details || null,
        },
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
