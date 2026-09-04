#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INSTALL_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'XhsCodexConnector',
);
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_INSTALL_ROOT, 'connector-config.json');
const REQUIRED_LAUNCH_FIELDS = ['origin', 'intent', 'code', 'nonce', 'expires', 'sig'];
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const configPath = path.resolve(options.config || DEFAULT_CONFIG_PATH);
  const connectorConfig = await loadConnectorConfig(configPath);
  const allowedOrigins = normalizeAllowedOrigins([
    ...(connectorConfig.allowedOrigins || []),
    ...valuesFor(options, 'allowedOrigin'),
    ...splitOrigins(process.env.XHS_CODEX_CONNECT_ALLOWED_ORIGINS),
  ]);
  const localRelayOrigin = normalizeOrigin(options.localRelay || connectorConfig.localRelayOrigin || 'http://127.0.0.1:4317');

  if (options.health) {
    const health = await probeLocalRelay(localRelayOrigin);
    const installation = await readJsonIfExists(path.join(path.dirname(configPath), 'current.json'));
    process.stdout.write(`${JSON.stringify({ connector: 'ready', configPath, allowedOrigins, installation, health }, null, 2)}\n`);
    return;
  }

  if (options.update) {
    const result = await updateConnector({
      origin: maintenanceOrigin(options.origin, allowedOrigins),
      allowedOrigins,
      localRelayOrigin,
      configPath,
      currentConfig: connectorConfig,
    });
    const restart = options.restart
      ? await restartInstalledConnector({ configPath, localRelayOrigin })
      : null;
    process.stdout.write(`${JSON.stringify({ ...result, ...(restart ? { restart } : {}) }, null, 2)}\n`);
    return;
  }

  if (options.rollback) {
    const result = await rollbackConnector({ configPath });
    const restart = options.restart
      ? await restartInstalledConnector({ configPath, localRelayOrigin })
      : null;
    process.stdout.write(`${JSON.stringify({ ...result, ...(restart ? { restart } : {}) }, null, 2)}\n`);
    return;
  }

  if (options.background) {
    if (connectorConfig.autoUpdate !== false && allowedOrigins.length) {
      try {
        await updateConnector({
          origin: maintenanceOrigin(options.origin, allowedOrigins),
          allowedOrigins,
          localRelayOrigin,
          configPath,
          currentConfig: connectorConfig,
        });
      } catch (error) {
        console.error(`Connector update check failed: ${error.message}`);
      }
    }
    const runtime = await resolveActiveRuntime(configPath, options.relayScript);
    const child = spawn(runtime.nodeExecutable, [
      runtime.relayScript,
      '--local-relay', localRelayOrigin,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const connectUrl = String(options.connectUrl || '').trim();
  if (!connectUrl) throw new Error('--connect-url is required.');
  if (!allowedOrigins.length) throw new Error('No allowed browser origin is configured for the local connector.');
  const launch = parseLaunchUrl(connectUrl, allowedOrigins);
  const runtime = await probeLocalRelay(localRelayOrigin);
  if (!runtime.available) {
    throw new Error(`The local Relay is not ready at ${runtime.origin}. Start the local production package, then retry the connection link.`);
  }

  const activeRuntime = await resolveActiveRuntime(configPath, options.relayScript);
  const deviceName = options.deviceName || connectorConfig.deviceName || os.hostname();
  const child = spawn(activeRuntime.nodeExecutable, [
    activeRuntime.relayScript,
    '--claim-url', `${launch.origin}/api/codex-connect/intents/${encodeURIComponent(launch.intent)}/claim`,
    '--gateway', gatewayUrlForOrigin(launch.origin),
    '--pairing-intent', launch.intent,
    '--code', launch.code,
    '--device-name', deviceName,
    '--local-relay', runtime.origin,
    '--connect-origin', launch.origin,
    '--connect-nonce', launch.nonce,
    '--connect-signature', launch.signature,
    '--replace-pairing',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({
    state: 'connector_started',
    deviceName,
    pid: child.pid,
    localRelay: runtime.origin,
  }, null, 2)}\n`);
}

async function updateConnector({ origin, allowedOrigins, localRelayOrigin, configPath, currentConfig }) {
  if (process.platform !== 'win32') throw new Error('Connector package updates currently require Windows PowerShell.');
  const manifest = await requestJson(`${origin}/api/codex-connect/manifest`);
  const targetVersion = normalizeVersion(manifest.connectorVersion);
  const installer = manifest.installer;
  if (!installer?.available || !installer?.url || !/^[a-f0-9]{64}$/i.test(String(installer.sha256 || ''))) {
    throw new Error('The connector manifest does not contain an available checksummed installer.');
  }
  const installerUrl = new URL(String(installer.url), origin);
  if (installerUrl.origin !== origin) throw new Error('The connector installer must be served by the manifest origin.');
  const installRoot = path.dirname(configPath);
  const before = await readJsonIfExists(path.join(installRoot, 'current.json'));
  const fromVersion = normalizeOptionalVersion(before?.version || currentConfig.connectorVersion);
  const comparison = compareVersions(targetVersion, fromVersion);
  if (comparison <= 0) {
    return {
      ok: true,
      state: comparison === 0 ? 'up_to_date' : 'newer_version_installed',
      fromVersion,
      toVersion: fromVersion,
      availableVersion: targetVersion,
    };
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'xhs-codex-connector-'));
  try {
    const archivePath = path.join(temporaryRoot, `codex-local-connector-${targetVersion}.zip`);
    const response = await fetch(installerUrl, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`Connector installer download failed with HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { flags: 'wx' }));
    const actualSha256 = await hashFile(archivePath);
    if (actualSha256 !== String(installer.sha256).toLowerCase()) {
      throw new Error(`Connector installer checksum mismatch: expected ${installer.sha256}, received ${actualSha256}.`);
    }

    const expandedRoot = path.join(temporaryRoot, 'expanded');
    const expandResult = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `$Archive=${powershellString(archivePath)}; $Destination=${powershellString(expandedRoot)}; Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force`,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assertProcessSucceeded(expandResult, 'Connector archive extraction');
    const installScript = path.join(expandedRoot, 'scripts', 'install-codex-local-connector.ps1');
    await access(installScript, fsConstants.R_OK);
    const installResult = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', installScript,
      '-AllowedOrigin', ...allowedOrigins,
      '-LocalRelayOrigin', localRelayOrigin,
      '-InstallRoot', installRoot,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assertProcessSucceeded(installResult, 'Connector staged installation');
    const after = await readJsonIfExists(path.join(installRoot, 'current.json'));
    if (String(after?.version || '') !== targetVersion) throw new Error('The connector installer did not activate the manifest version.');
    return {
      ok: true,
      state: 'updated',
      fromVersion,
      toVersion: targetVersion,
      sha256: actualSha256,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function rollbackConnector({ configPath }) {
  if (process.platform !== 'win32') throw new Error('Connector rollback currently requires Windows PowerShell.');
  const installRoot = path.dirname(configPath);
  const before = await readJsonIfExists(path.join(installRoot, 'current.json'));
  if (!before?.root) throw new Error('The active connector state is missing.');
  const rollbackScript = path.join(String(before.root), 'scripts', 'rollback-codex-local-connector.ps1');
  await access(rollbackScript, fsConstants.R_OK);
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', rollbackScript,
    '-InstallRoot', installRoot,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assertProcessSucceeded(result, 'Connector rollback');
  const after = await readJsonIfExists(path.join(installRoot, 'current.json'));
  if (!after?.version || after.version === before.version) throw new Error('Connector rollback did not switch the active version.');
  return {
    ok: true,
    state: 'rolled_back',
    fromVersion: String(before.version || ''),
    toVersion: String(after.version || ''),
  };
}

async function restartInstalledConnector({ configPath, localRelayOrigin }) {
  if (process.platform !== 'win32') throw new Error('Connector process switching currently requires Windows PowerShell.');
  const installRoot = path.dirname(configPath);
  const current = await readJsonIfExists(path.join(installRoot, 'current.json'));
  if (!current?.root) throw new Error('The active connector state is missing after maintenance.');
  const nodeExecutable = path.join(String(current.root), 'runtime', 'node.exe');
  const connectorScript = path.join(String(current.root), 'scripts', 'codex-local-connector.mjs');
  await Promise.all([access(nodeExecutable, fsConstants.X_OK), access(connectorScript, fsConstants.R_OK)]);
  const stopScript = [
    `$root=${powershellString(path.resolve(installRoot).toLowerCase())};`,
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'"',
    '| Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root) -and $_.CommandLine -like \'*codex-device-relay.mjs*\' }',
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join(' ');
  const stopped = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', stopScript,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  assertProcessSucceeded(stopped, 'Connector process switch');
  const launcher = spawn(nodeExecutable, [
    connectorScript,
    '--background',
    '--local-relay', localRelayOrigin,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  launcher.unref();
  return { requested: true, version: String(current.version || ''), launcherPid: launcher.pid };
}

async function resolveActiveRuntime(configPath, explicitRelayScript = '') {
  if (explicitRelayScript) {
    const relayScript = path.resolve(explicitRelayScript);
    await access(relayScript, fsConstants.R_OK);
    return { nodeExecutable: process.execPath, relayScript };
  }
  const current = await readJsonIfExists(path.join(path.dirname(configPath), 'current.json'));
  if (current?.root) {
    const nodeExecutable = path.join(String(current.root), 'runtime', 'node.exe');
    const relayScript = path.join(String(current.root), 'scripts', 'codex-device-relay.mjs');
    try {
      await Promise.all([access(nodeExecutable, fsConstants.X_OK), access(relayScript, fsConstants.R_OK)]);
      return { nodeExecutable, relayScript };
    } catch {
      // Fall through to the connector's own package when state is stale.
    }
  }
  const relayScript = path.join(scriptDirectory, 'codex-device-relay.mjs');
  await access(relayScript, fsConstants.R_OK);
  return { nodeExecutable: process.execPath, relayScript };
}

function parseLaunchUrl(value, allowedOrigins) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The connection link is invalid.');
  }
  if (url.protocol !== 'codex-local:' || url.hostname !== 'connect' || url.pathname !== '') {
    throw new Error('The connection link does not target the local connector.');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !REQUIRED_LAUNCH_FIELDS.includes(key)) || REQUIRED_LAUNCH_FIELDS.some((key) => url.searchParams.getAll(key).length !== 1)) {
    throw new Error('The connection link parameters are invalid.');
  }
  const origin = normalizeOrigin(url.searchParams.get('origin'));
  if (!allowedOrigins.includes(origin)) throw new Error('The connection link origin is not permitted by this connector.');
  const intent = String(url.searchParams.get('intent') || '');
  const code = String(url.searchParams.get('code') || '');
  const nonce = String(url.searchParams.get('nonce') || '');
  const signature = String(url.searchParams.get('sig') || '');
  const expiresAt = Date.parse(String(url.searchParams.get('expires') || ''));
  if (!/^pair-[A-Za-z0-9._:-]{8,180}$/.test(intent) || !/^[2-9A-HJ-NP-Z]{8}$/.test(code) || !/^[A-Za-z0-9_-]{16,120}$/.test(nonce) || !/^[A-Za-z0-9_-]{20,120}$/.test(signature)) {
    throw new Error('The connection link credentials are invalid.');
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 6 * 60_000) {
    throw new Error('The connection link is expired.');
  }
  return { origin, intent, code, nonce, signature };
}

async function probeLocalRelay(originInput) {
  const origin = normalizeOrigin(originInput || 'http://127.0.0.1:4317');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${origin}/api/codex-relay/status`, { cache: 'no-store', signal: controller.signal });
    const status = await response.json().catch(() => ({}));
    return {
      origin,
      available: response.ok && status?.adapter?.state === 'compatible',
      status,
    };
  } catch (error) {
    return { origin, available: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${body.code || `HTTP_${response.status}`}: ${body.message || response.statusText}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function loadConnectorConfig(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`The connector configuration could not be read: ${error.message}`);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Connector state could not be read: ${error.message}`);
  }
}

function assertProcessSucceeded(result, label) {
  if (!result.error && result.status === 0) return;
  const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
  throw new Error(`${label} failed: ${detail}`);
}

function powershellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function maintenanceOrigin(value, allowedOrigins) {
  if (!value && !allowedOrigins.length) throw new Error('An allowed browser origin is required for connector maintenance.');
  const fallback = allowedOrigins.find((candidate) => new URL(candidate).protocol === 'https:') || allowedOrigins[0];
  const origin = normalizeOrigin(value || fallback);
  if (allowedOrigins.length && !allowedOrigins.includes(origin)) throw new Error('The maintenance origin is not permitted by this connector.');
  return origin;
}

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (!VERSION_PATTERN.test(version)) throw new Error('The connector version is invalid.');
  return version;
}

function normalizeOptionalVersion(value) {
  const version = String(value || '').trim();
  return version ? normalizeVersion(version) : '0.0.0';
}

function compareVersions(left, right) {
  const leftParts = String(left).split(/[._-]/);
  const rightParts = String(right).split(/[._-]/);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || '0';
    const rightPart = rightParts[index] || '0';
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : Number.NaN;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : Number.NaN;
    const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? Math.sign(leftNumber - rightNumber)
      : leftPart.localeCompare(rightPart);
    if (comparison) return comparison;
  }
  return 0;
}

function gatewayUrlForOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/device-tunnel';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { values.help = true; continue; }
    if (token === '--health') { values.health = true; continue; }
    if (token === '--background') { values.background = true; continue; }
    if (token === '--update') { values.update = true; continue; }
    if (token === '--rollback') { values.rollback = true; continue; }
    if (token === '--restart') { values.restart = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    if (key === 'allowedOrigin') (values.allowedOrigin ||= []).push(value);
    else values[key] = value;
    index += 1;
  }
  if ([values.update, values.rollback, values.background, values.health].filter(Boolean).length > 1) {
    throw new Error('Choose only one connector maintenance mode.');
  }
  if (values.restart && !values.update && !values.rollback) throw new Error('--restart requires --update or --rollback.');
  return values;
}

function valuesFor(options, key) {
  const value = options[key];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function splitOrigins(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeAllowedOrigins(values) {
  return [...new Set(values.map(normalizeOrigin))];
}

function normalizeOrigin(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('An allowed connector origin must be an HTTP(S) origin without a path.');
  }
  return url.origin;
}

function printHelp() {
  console.log(`Codex Local Connector

Protocol launch:
  node scripts/codex-local-connector.mjs --connect-url "codex-local://connect?..."

Maintenance:
  node scripts/codex-local-connector.mjs --health
  node scripts/codex-local-connector.mjs --update [--origin HTTP_ORIGIN] [--restart]
  node scripts/codex-local-connector.mjs --rollback [--restart]
  node scripts/codex-local-connector.mjs --background

Options:
  --connect-url URL       Signed connection link from the browser
  --background            Check for an update, then start the active Device Relay
  --update                Download, verify, stage, and activate a newer connector
  --rollback              Atomically switch current and previous connector versions
  --restart               Switch the running Device Relay after update or rollback
  --origin ORIGIN         Browser/control-plane origin for maintenance
  --config PATH           Connector configuration path
  --allowed-origin ORIGIN Allowed browser origin, repeatable for maintenance
  --local-relay ORIGIN    Loopback local Relay origin
  --device-name NAME      Device display name
  --relay-script PATH     Device Relay script path
`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
