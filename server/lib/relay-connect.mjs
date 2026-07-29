import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeRelay } from './relay.mjs';

let activeConnection = null;

export async function connectRelay({
  port,
  openClawConfigPath,
  profile = 'openclaw',
  timeoutMs = 25000,
  probeRelayImpl = probeRelay,
  spawnImpl = spawn,
  openClawCommand = resolveOpenClawCommand(),
}) {
  if (activeConnection) return activeConnection;
  activeConnection = performConnection({
    port,
    openClawConfigPath,
    profile,
    timeoutMs,
    probeRelayImpl,
    spawnImpl,
    openClawCommand,
  });
  try {
    return await activeConnection;
  } finally {
    activeConnection = null;
  }
}

export function openRelayLogin({
  profile = 'openclaw',
  url = 'https://www.xiaohongshu.com',
  timeoutMs = 15000,
  spawnImpl = spawn,
  openClawCommand = resolveOpenClawCommand(),
}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(
        openClawCommand,
        ['browser', 'open', '--browser-profile', profile, url],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      timer = setTimeout(() => {
        child.kill?.();
        finish({ opened: false, timedOut: true, message: 'Login page open timed out.' });
      }, timeoutMs);
      child.once('error', (error) => finish({ opened: false, timedOut: false, message: `Login page open failed: ${error.message}` }));
      child.once('close', (code) => finish({
        opened: code === 0,
        timedOut: false,
        exitCode: code,
        message: code === 0 ? 'Login page opened in the managed browser.' : `Login page open exited with code ${code}.`,
      }));
    } catch (error) {
      finish({ opened: false, timedOut: false, message: `Login page open failed: ${error.message}` });
    }
  });
}

async function performConnection({
  port,
  openClawConfigPath,
  profile,
  timeoutMs,
  probeRelayImpl,
  spawnImpl,
  openClawCommand,
}) {
  const before = await probeRelayImpl({ port, openClawConfigPath });
  if (isAttached(before)) {
    return { ...before, ready: true, attempted: false, message: 'Relay is already connected.' };
  }

  const started = await startBrowserService({
    command: openClawCommand,
    profile,
    timeoutMs,
    spawnImpl,
  });
  if (!started.started) {
    return {
      ...before,
      ready: false,
      attempted: true,
      startExitCode: started.code,
      startTimedOut: started.timedOut,
      message: started.message,
    };
  }

  const after = await waitForRelay({
    port,
    openClawConfigPath,
    timeoutMs,
    probeRelayImpl,
  });
  const ready = isAttached(after);
  return {
    ...after,
    ready,
    attempted: true,
    startExitCode: started.code,
    startTimedOut: false,
    message: ready
      ? 'Relay connected through the browser service.'
      : after.running && after.cdpReady
        ? 'Relay service is running; waiting for an attached browser tab.'
        : 'Relay service start completed; status is still pending.',
  };
}

function isAttached(status) {
  const tabs = Array.isArray(status?.tabs) ? status.tabs.length : Number(status?.tabs || 0);
  return Boolean(status?.running && status?.cdpReady && tabs > 0);
}

async function waitForRelay({ port, openClawConfigPath, timeoutMs, probeRelayImpl }) {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 5000);
  let status = await probeRelayImpl({ port, openClawConfigPath });
  while (!status.ok && Date.now() < deadline) {
    await delay(250);
    status = await probeRelayImpl({ port, openClawConfigPath });
  }
  return status;
}

function startBrowserService({ command, profile, timeoutMs, spawnImpl }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(
        command,
        ['browser', 'start', '--browser-profile', profile, '--json'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      timer = setTimeout(() => {
        child.kill?.();
        finish({ started: false, code: null, timedOut: true, message: 'Relay service start timed out.' });
      }, timeoutMs);
      child.once('error', (error) => finish({
        started: false,
        code: null,
        timedOut: false,
        message: `Relay service start failed: ${error.message}`,
      }));
      child.once('close', (code) => finish({
        started: code === 0,
        code,
        timedOut: false,
        message: code === 0 ? '' : `Relay service exited with code ${code}.`,
      }));
    } catch (error) {
      finish({
        started: false,
        code: null,
        timedOut: false,
        message: `Relay service start failed: ${error.message}`,
      });
    }
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function resolveOpenClawCommand() {
  const configured = String(process.env.XHS_OPENCLAW_BIN || '').trim();
  if (configured) return configured;
  if (process.platform !== 'win32') return 'openclaw';
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'npm', 'openclaw.cmd');
}
