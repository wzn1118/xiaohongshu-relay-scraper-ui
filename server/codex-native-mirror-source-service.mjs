import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function createCodexNativeMirrorSourceService(options = {}) {
  return new CodexNativeMirrorSourceService(options);
}

export class CodexNativeMirrorSourceService {
  constructor({
    platform = process.platform,
    env = process.env,
    browserPath = '',
    pathExists = existsSync,
    spawnProcess = spawn,
    terminateProcess = defaultTerminateProcess,
    removeDirectory = rm,
    now = () => new Date(),
  } = {}) {
    this.platform = platform;
    this.env = env;
    this.browserPath = String(browserPath || '');
    this.pathExists = pathExists;
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;
    this.removeDirectory = removeDirectory;
    this.now = now;
    this.launches = new Map();
  }

  status() {
    const browserPath = this._browserPath();
    return {
      available: this.platform === 'win32' && Boolean(browserPath),
      browserPath,
      activeSources: this.launches.size,
      capture: 'chromium-auto-selected-window',
    };
  }

  async launch(sessionId, sourceUrl, { captureTitle = 'ChatGPT' } = {}) {
    const id = normalizeSessionId(sessionId);
    const url = normalizeLoopbackUrl(sourceUrl);
    const title = String(captureTitle || '').trim().slice(0, 200);
    const browserPath = this._browserPath();
    if (this.platform !== 'win32' || !browserPath) {
      throw new Error('A Windows Edge or Chrome installation is required for local Native Mirror capture.');
    }
    if (!title || /[\r\n]/u.test(title)) throw new Error('The Native Mirror capture title is invalid.');
    await this.close(id);
    const profilePath = this._profilePath(id);
    const args = [
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--autoplay-policy=no-user-gesture-required',
      `--auto-select-desktop-capture-source=${title}`,
      `--app=${url}`,
    ];
    const child = this.spawnProcess(browserPath, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    await waitForSpawn(child);
    child.unref?.();
    const launchedAt = normalizeDate(this.now()).toISOString();
    const launch = {
      sessionId: id,
      state: 'ready',
      pid: Number(child.pid) || null,
      browserPath,
      profilePath,
      captureTitle: title,
      launchedAt,
    };
    this.launches.set(id, { ...launch, child });
    return publicLaunch(launch);
  }

  get(sessionId) {
    const launch = this.launches.get(normalizeSessionId(sessionId));
    return launch ? publicLaunch(launch) : null;
  }

  async close(sessionId) {
    const id = normalizeSessionId(sessionId);
    const launch = this.launches.get(id);
    if (!launch) return { closed: false, sessionId: id };
    this.launches.delete(id);
    await this.terminateProcess(launch).catch(() => {});
    await this.removeDirectory(launch.profilePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => {});
    return { closed: true, sessionId: id };
  }

  async closeAll() {
    await Promise.allSettled([...this.launches.keys()].map((sessionId) => this.close(sessionId)));
  }

  _browserPath() {
    if (this.browserPath && this.pathExists(this.browserPath)) return path.resolve(this.browserPath);
    if (this.platform !== 'win32') return '';
    const roots = [this.env['PROGRAMFILES(X86)'], this.env.PROGRAMFILES, this.env.LOCALAPPDATA].filter(Boolean);
    const candidates = roots.flatMap((root) => [
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
    return candidates.find((candidate) => this.pathExists(candidate)) || '';
  }

  _profilePath(sessionId) {
    const root = this.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'XhsCodexConnector', 'mirror-browser', sessionId);
  }
}

function normalizeSessionId(value) {
  const id = String(value || '').trim();
  if (!/^mirror-[A-Za-z0-9_-]{8,120}$/u.test(id)) throw new Error('The Native Mirror session id is invalid.');
  return id;
}

function normalizeLoopbackUrl(value) {
  const url = new URL(String(value || ''));
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('The local Native Mirror source must use a loopback HTTP(S) URL.');
  }
  return url.toString();
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The Native Mirror source clock is invalid.');
  return date;
}

function publicLaunch(value) {
  return {
    sessionId: value.sessionId,
    state: value.state,
    pid: value.pid,
    browserPath: value.browserPath,
    profilePath: value.profilePath,
    captureTitle: value.captureTitle,
    launchedAt: value.launchedAt,
  };
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
      callback(value);
    };
    const onSpawn = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

async function defaultTerminateProcess(launch) {
  const pid = Number(launch?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch {}
}
