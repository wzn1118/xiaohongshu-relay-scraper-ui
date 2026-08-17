import { mkdir } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  forceRestart = false,
  browserPath = process.env.XHS_BROWSER_PATH,
  spawnImpl = spawn,
  fetchImpl = fetch,
  webSocketImpl = WebSocket,
  relayToken = '',
}) {
  const existing = await probeNativeBrowser({ port, fetchImpl, relayToken });
  if (existing.running && !forceRestart) return { ...existing, started: false, alreadyRunning: true, restarted: false };

  let restarted = false;
  if (existing.running) {
    const closed = await closeNativeBrowser({ port, timeoutMs, fetchImpl, webSocketImpl, relayToken });
    if (!closed.ok) {
      return {
        ...existing,
        started: false,
        alreadyRunning: true,
        restarted: false,
        message: `Managed browser could not be restarted: ${closed.message}`,
      };
    }
    restarted = true;
  }

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
  let status = await probeNativeBrowser({ port, fetchImpl, relayToken });
  while (Date.now() < deadline) {
    if (status.running) return { ...status, started: true, alreadyRunning: false, restarted, executable, profileDir };
    await delay(250);
    status = await probeNativeBrowser({ port, fetchImpl, relayToken });
  }
  return {
    ...status,
    started: false,
    alreadyRunning: false,
    restarted,
    executable,
    profileDir,
    message: status.message || 'Managed browser did not expose CDP before the timeout.',
  };
}

export async function closeNativeBrowser({
  port,
  timeoutMs = 15000,
  fetchImpl = fetch,
  webSocketImpl = WebSocket,
  relayToken = '',
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1000), 5000));
  try {
    const response = await requestCdp({ port, path: '/json/version', relayToken, fetchImpl, signal: controller.signal });
    if (!response.ok) throw new Error(`Browser CDP responded with HTTP ${response.status}.`);
    const version = await response.json();
    const webSocketUrl = String(version?.webSocketDebuggerUrl || '').trim();
    if (!webSocketUrl) throw new Error('Browser CDP version response has no WebSocket URL.');
    await sendBrowserClose({
      webSocketUrl: appendRelayToken(webSocketUrl, response.authenticated ? relayToken : ''),
      timeoutMs: Math.min(Math.max(timeoutMs, 1000), 8000),
      webSocketImpl,
    });
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }

  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 8000);
  while (Date.now() < deadline) {
    const status = await probeNativeBrowser({ port, fetchImpl, timeoutMs: 750, relayToken });
    if (!status.running) return { ok: true };
    await delay(200);
  }
  return { ok: false, message: 'Managed browser did not release the Relay port before the timeout.' };
}

export async function probeNativeBrowser({ port, fetchImpl = fetch, timeoutMs = 1500, relayToken = '' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestCdp({ port, path: '/json/version', relayToken, fetchImpl, signal: controller.signal });
    if (!response.ok) throw new Error(`Browser CDP responded with HTTP ${response.status}.`);
    const version = await response.json();
    const tabsResponse = await requestCdp({ port, path: '/json/list', relayToken, fetchImpl, signal: controller.signal });
    if (!tabsResponse.ok) throw new Error(`Browser CDP tab list responded with HTTP ${tabsResponse.status}.`);
    const tabs = await tabsResponse.json();
    if (!Array.isArray(tabs)) throw new Error('Browser CDP returned an invalid tab list.');
    return {
      running: true,
      cdpReady: true,
      authenticated: response.authenticated && tabsResponse.authenticated,
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
  const candidates = [
    configured,
    path.join(PROJECT_ROOT, 'runtime', 'browser', 'chrome.exe'),
    path.join(PROJECT_ROOT, 'runtime', 'browser', 'msedge.exe'),
  ].filter(Boolean);
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

async function requestCdp({ port, path: requestPath, relayToken, fetchImpl, signal }) {
  const request = (headers) => fetchImpl(`http://127.0.0.1:${port}${requestPath}`, {
    ...(Object.keys(headers).length ? { headers } : {}),
    signal,
  });
  let response = await request(relayToken ? { 'x-openclaw-relay-token': relayToken } : {});
  const authenticated = Boolean(relayToken && response.ok);
  if (!response.ok && relayToken) response = await request({});
  return {
    ok: response.ok,
    status: response.status,
    authenticated,
    json: (...args) => response.json(...args),
  };
}

function appendRelayToken(webSocketUrl, relayToken) {
  if (!relayToken) return webSocketUrl;
  const parsed = new URL(webSocketUrl);
  parsed.searchParams.set('token', relayToken);
  return parsed.toString();
}

function sendBrowserClose({ webSocketUrl, timeoutMs, webSocketImpl }) {
  return new Promise((resolve, reject) => {
    let socket;
    let commandSent = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close?.(); } catch {}
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Browser close command timed out.')), timeoutMs);
    try {
      socket = new webSocketImpl(webSocketUrl);
      const listen = (event, handler) => {
        if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
        else socket.on?.(event, handler);
      };
      listen('open', () => {
        commandSent = true;
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      });
      listen('message', (event) => {
        const raw = typeof event === 'string' ? event : event?.data ?? event;
        const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
        let payload;
        try { payload = JSON.parse(text); } catch { return; }
        if (payload?.id !== 1) return;
        if (payload.error) finish(new Error(payload.error.message || 'Browser close command failed.'));
        else finish();
      });
      listen('close', () => commandSent && finish());
      listen('error', (event) => finish(new Error(event?.message || 'Browser close WebSocket failed.')));
    } catch (error) {
      finish(error);
    }
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
