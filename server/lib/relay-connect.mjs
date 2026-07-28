import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { probeRelay } from './relay.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let activeConnection = null;

export async function connectRelay({
  port,
  openClawConfigPath,
  runnerPath,
  helperPath = process.env.XHS_RELAY_HELPER_PATH || '',
  timeoutMs = 25000,
}) {
  if (activeConnection) return activeConnection;
  activeConnection = performConnection({ port, openClawConfigPath, runnerPath, helperPath, timeoutMs });
  try {
    return await activeConnection;
  } finally {
    activeConnection = null;
  }
}

async function performConnection({ port, openClawConfigPath, runnerPath, helperPath, timeoutMs }) {
  const before = await probeRelay({ port, openClawConfigPath });
  if (isAttached(before)) {
    return { ...before, ready: true, attempted: false, message: 'Relay 已连接。' };
  }

  const resolvedHelper = await resolveHelperPath({ runnerPath, helperPath });
  if (!resolvedHelper) {
    return {
      ...before,
      ready: false,
      attempted: false,
      message: '未找到 Relay 连接助手，请先安装浏览器中继组件。',
    };
  }

  const helper = await runHelper(resolvedHelper, port, timeoutMs);
  const after = await probeRelay({ port, openClawConfigPath });
  const ready = isAttached(after);
  return {
    ...after,
    ready,
    attempted: true,
    helperExitCode: helper.code,
    helperTimedOut: helper.timedOut,
    message: ready
      ? 'Relay 已智能连接。'
      : after.running && after.cdpReady
        ? 'Relay 已启动，等待浏览器标签页附着。'
        : helper.timedOut
          ? 'Relay 连接助手超时，请检查浏览器和扩展状态。'
          : 'Relay 尚未连接，请确认浏览器已打开并允许扩展附着。',
  };
}

function isAttached(status) {
  return Boolean(status?.running && status?.cdpReady && Number(status?.tabs || 0) > 0);
}

async function resolveHelperPath({ runnerPath, helperPath }) {
  const candidates = [
    helperPath,
    runnerPath ? path.join(path.dirname(runnerPath), 'enable_openclaw_relay.ps1') : '',
    path.join(projectRoot, 'scripts', 'enable_openclaw_relay.ps1'),
    process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'skills', 'xiaohongshu-relay-scrape', 'scripts', 'enable_openclaw_relay.ps1')
      : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {
      // Try the next configured location.
    }
  }
  return null;
}

function runHelper(helperPath, port, timeoutMs) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
      '-RelayPort',
      String(port),
      '-TargetUrl',
      '',
    ];
    let settled = false;
    let timer;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      timer = setTimeout(() => {
        child.kill();
        finish({ code: null, timedOut: true });
      }, timeoutMs);
      child.once('error', () => finish({ code: null, timedOut: false }));
      child.once('close', (code) => finish({ code, timedOut: false }));
    } catch {
      finish({ code: null, timedOut: false });
    }
  });
}
