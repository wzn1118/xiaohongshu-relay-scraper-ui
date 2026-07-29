import path from 'node:path';
import { spawn } from 'node:child_process';

export function setupRelayRuntime({
  projectRoot = path.resolve(process.cwd()),
  scriptPath = path.join(projectRoot, 'scripts', 'ensure-windows-prerequisites.ps1'),
  relayPort = 18800,
  profile = 'openclaw',
  browserDataDir = path.join(projectRoot, 'data', 'browser'),
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 120000,
} = {}) {
  if (platform !== 'win32') {
    return Promise.resolve({
      ok: true,
      supported: false,
      installed: false,
      skipped: true,
      message: '当前平台直接使用项目原生 CDP 浏览器。',
    });
  }

  const args = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-InstallRuntime',
    '-EnsureBrowserRelay',
    '-RelayPort',
    String(relayPort),
    '-RelayProfile',
    profile,
    '-BrowserDataDir',
    browserDataDir,
  ];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
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
      child = spawnImpl('powershell.exe', args, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', (error) => finish({
        ok: false,
        supported: true,
        installed: false,
        message: `Relay 安装启动失败：${error.message}`,
      }));
      child.once('close', (code) => finish(code === 0
        ? { ok: true, supported: true, installed: true, message: '浏览器运行时已准备，正在接入 Relay。' }
        : {
            ok: false,
            supported: true,
            installed: false,
            exitCode: code,
            message: lastOutput(stderr, stdout) || `Relay 安装脚本退出码：${code}`,
          }));
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ ok: false, supported: true, installed: false, timedOut: true, message: 'Relay 安装超过 2 分钟，请检查 winget 或浏览器安装状态。' });
      }, Math.max(1000, timeoutMs));
    } catch (error) {
      finish({ ok: false, supported: true, installed: false, message: `Relay 安装启动失败：${error.message}` });
    }
  });
}

function lastOutput(...values) {
  return values
    .map((value) => String(value || '').trim())
    .find(Boolean)
    ?.split(/\r?\n/)
    .filter(Boolean)
    .slice(-1)[0] || '';
}
