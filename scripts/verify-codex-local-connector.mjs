#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const origin = normalizeOrigin(options.origin || 'http://127.0.0.1:4317');
  const unique = `${process.pid}-${Date.now()}`;
  const statePath = path.join(os.tmpdir(), `codex-connector-verification-${unique}.json`);
  let child = null;
  let deviceId = '';
  let stderr = '';
  try {
    const created = await requestJson(`${origin}/api/codex-connect/intents`, {
      method: 'POST',
      body: JSON.stringify({ deviceName: 'Connector verification device' }),
    });
    const launch = new URL(created.launchUrl);
    const gatewayUrl = new URL(origin);
    gatewayUrl.protocol = gatewayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    gatewayUrl.pathname = '/v1/device-tunnel';
    child = spawn(process.execPath, [
      path.join(scriptDirectory, 'codex-device-relay.mjs'),
      '--state', statePath,
      '--claim-url', `${origin}/api/codex-connect/intents/${encodeURIComponent(created.intent.id)}/claim`,
      '--gateway', gatewayUrl.toString(),
      '--pairing-intent', created.intent.id,
      '--code', launch.searchParams.get('code'),
      '--device-name', 'Connector-verification-device',
      '--local-relay', origin,
      '--connect-origin', launch.searchParams.get('origin'),
      '--connect-nonce', launch.searchParams.get('nonce'),
      '--connect-signature', launch.searchParams.get('sig'),
      '--replace-pairing',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_000);
    });
    let status = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(250);
      status = await requestJson(`${origin}/api/codex-connect/intents/${encodeURIComponent(created.intent.id)}`).catch(() => null);
      if (status?.intent?.state === 'connected') break;
      if (child.exitCode !== null) throw new Error(`Device Relay exited before connecting: ${stderr}`);
    }
    if (status?.intent?.state !== 'connected' || !status?.device?.id) {
      throw new Error(`Device Relay did not reach the connected state: ${stderr}`);
    }
    deviceId = String(status.device.id);
    await stopChild(child);
    child = null;
    const revoked = await requestJson(`${origin}/api/codex-connect/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      body: '{}',
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      intentId: created.intent.id,
      deviceId,
      state: status.intent.state,
      health: status.health?.state || '',
      dpapiStateCreated: true,
      revoked: revoked.revoked === true,
    }, null, 2)}\n`);
    deviceId = '';
  } finally {
    if (child) await stopChild(child).catch(() => {});
    if (deviceId) {
      await requestJson(`${origin}/api/codex-connect/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        body: '{}',
      }).catch(() => {});
    }
    await rm(statePath, { force: true }).catch(() => {});
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${body?.error?.code || `HTTP_${response.status}`}: ${body?.error?.message || body.message || response.statusText}`);
  return body;
}

function normalizeOrigin(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The verification origin must be an HTTP(S) origin without a path.');
  }
  return url.origin;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') && !parsed.origin) {
      parsed.origin = token;
      continue;
    }
    if (token !== '--origin') throw new Error(`Unexpected argument: ${token}`);
    if (!argv[index + 1]) throw new Error('--origin requires a value.');
    parsed.origin = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
