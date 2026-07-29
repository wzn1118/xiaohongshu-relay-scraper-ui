import { mkdir } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const WINDOWS_BROWSER_CANDIDATES = [
  ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
];

const POSIX_BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export async function ensureNativeBrowser({
  port,
  profileDir,
  url = 'about:blank',
  timeoutMs = 15000,
  browserPath = process.env.XHS_BROWSER_PATH,
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  const existing = await probeNativeBrowser({ port, fetchImpl });
  if (existing.running) return { ...existing, started: false, alreadyRunning: true };

  const executable = resolveBrowserExecutable(browserPath);
  if (!executable) {
    return {
      started: false,
      alreadyRunning: false,
      running: false,
      message: 'No Chromium-based browser was found. Install Chrome or set XHS_BROWSER_PATH.',
    };
  }

  await mkdir(profileDir, { recursive: true });
  const child = spawnImpl(executable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-popup-blocking',
    '--remote-allow-origins=http://127.0.0.1:*',
    url,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref?.();

  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let status = await probeNativeBrowser({ port, fetchImpl });
  while (Date.now() < deadline) {
    if (status.running) return { ...status, started: true, alreadyRunning: false, executable, profileDir };
    await delay(250);
    status = await probeNativeBrowser({ port, fetchImpl });
  }
  return {
    ...status,
    started: false,
    alreadyRunning: false,
    executable,
    profileDir,
    message: status.message || 'Managed browser did not expose CDP before the timeout.',
  };
}

export async function probeNativeBrowser({ port, fetchImpl = fetch, timeoutMs = 1500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Browser CDP responded with HTTP ${response.status}.`);
    const version = await response.json();
    const tabsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!tabsResponse.ok) throw new Error(`Browser CDP tab list responded with HTTP ${tabsResponse.status}.`);
    const tabs = await tabsResponse.json();
    if (!Array.isArray(tabs)) throw new Error('Browser CDP returned an invalid tab list.');
    return {
      running: true,
      cdpReady: true,
      authenticated: false,
      port,
      tabs: tabs.length,
      tabCount: tabs.length,
      xiaohongshuTabs: tabs.filter((tab) => /xiaohongshu\.com/i.test(String(tab?.url || ''))).length,
      browser: String(version?.Browser || 'Chromium'),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      running: false,
      cdpReady: false,
      authenticated: false,
      port,
      tabs: 0,
      tabCount: 0,
      xiaohongshuTabs: 0,
      checkedAt: new Date().toISOString(),
      message: error?.name === 'AbortError' ? 'Browser CDP status check timed out.' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveManagedBrowserProfileDir(baseDir, profile = 'openclaw') {
  const safeProfile = String(profile || 'openclaw').trim().replace(/[^\p{L}\p{N}_.-]+/gu, '-');
  return path.resolve(baseDir, safeProfile || 'openclaw');
}

export function resolveBrowserExecutable(configured = process.env.XHS_BROWSER_PATH) {
  const candidates = [configured].filter(Boolean);
  if (process.platform === 'win32') {
    for (const [variable, suffix] of WINDOWS_BROWSER_CANDIDATES) {
      const value = process.env[variable];
      if (value) candidates.push(path.join(value, suffix));
    }
    candidates.push(...resolveFromPath(['chrome.exe', 'msedge.exe']));
  } else {
    candidates.push(...POSIX_BROWSER_CANDIDATES, ...resolveFromPath(['google-chrome', 'chromium', 'microsoft-edge']));
  }
  return candidates.find((candidate) => isExecutable(candidate)) || null;
}

function resolveFromPath(names) {
  return names.flatMap((name) => {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
    return result.status === 0 ? String(result.stdout || '').split(/\r?\n/).filter(Boolean) : [];
  });
}

function isExecutable(candidate) {
  if (!candidate) return false;
  if (path.isAbsolute(candidate)) {
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(resolveFromPath([candidate]).length);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
