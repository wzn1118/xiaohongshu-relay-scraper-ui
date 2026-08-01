import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { probeRelay } from './relay.mjs';
import { ensureNativeBrowser, resolveManagedBrowserProfileDir } from './native-browser.mjs';

const activeConnections = new Map();

export async function connectRelay({
  port,
  openClawConfigPath,
  managedBrowserDataDir,
  profile = 'openclaw',
  timeoutMs = 25000,
  forceRestart = false,
  probeRelayImpl = probeRelay,
  browserEnsurer = ensureNativeBrowser,
}) {
  const key = String(port);
  while (activeConnections.has(key)) {
    const active = activeConnections.get(key);
    const result = await active.promise;
    if (!forceRestart || active.forceRestart) return { ...result, joinedConnection: true };
  }
  const promise = performConnection({
    port,
    openClawConfigPath,
    managedBrowserDataDir,
    profile,
    timeoutMs,
    forceRestart,
    probeRelayImpl,
    browserEnsurer,
  });
  activeConnections.set(key, { promise, forceRestart });
  try {
    return await promise;
  } finally {
    if (activeConnections.get(key)?.promise === promise) activeConnections.delete(key);
  }
}

export function openRelayLogin({
  port = 18800,
  openClawConfigPath,
  profile = 'openclaw',
  url = 'https://www.xiaohongshu.com',
  timeoutMs = 15000,
  fetchImpl = fetch,
  webSocketImpl = WebSocket,
}) {
  return createManagedTarget({ port, openClawConfigPath, profile, url, timeoutMs, fetchImpl, webSocketImpl });
}

async function performConnection({
  port,
  openClawConfigPath,
  managedBrowserDataDir,
  profile,
  timeoutMs,
  forceRestart,
  probeRelayImpl,
  browserEnsurer,
}) {
  const before = await probeRelayImpl({ port, openClawConfigPath });
  if (!forceRestart && isAttached(before)) {
    return { ...before, ready: true, attempted: false, message: 'Relay is already connected.' };
  }
  if (!forceRestart && before.running && before.cdpReady) {
    return {
      ...before,
      ready: false,
      attempted: false,
      message: 'Browser CDP is running; waiting for an attached browser tab.',
    };
  }

  const started = await browserEnsurer({
    port,
    profileDir: resolveManagedBrowserProfileDir(
      managedBrowserDataDir || path.resolve(process.cwd(), 'data', 'browser'),
      profile,
    ),
    timeoutMs,
    url: 'about:blank',
    profile,
    forceRestart,
    relayToken: await resolveRelayToken({ port, openClawConfigPath }),
  });
  if (!started.running) {
    return {
      ...before,
      ready: false,
      attempted: true,
      startExitCode: null,
      startTimedOut: false,
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
    startExitCode: null,
    startTimedOut: false,
    message: ready
      ? forceRestart ? 'Relay browser was rebuilt and connected.' : 'Relay connected through the browser service.'
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

async function createManagedTarget({ port, openClawConfigPath, url, timeoutMs, fetchImpl, webSocketImpl }) {
  try {
    const relayToken = await resolveRelayToken({ port, openClawConfigPath });
    const headers = relayToken ? { 'x-openclaw-relay-token': relayToken } : {};
    const requestVersion = (requestHeaders) => fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      ...(Object.keys(requestHeaders).length ? { headers: requestHeaders } : {}),
    });
    let response = await requestVersion(headers);
    const authenticated = response.ok && Boolean(relayToken);
    if (!response.ok && relayToken) response = await requestVersion({});
    if (!response.ok) throw new Error(`Browser CDP version endpoint responded with HTTP ${response.status}.`);
    const version = await response.json();
    const rawWebSocketUrl = String(version?.webSocketDebuggerUrl || '').trim();
    if (!rawWebSocketUrl) throw new Error('Browser CDP version endpoint has no WebSocket URL.');
    const webSocketUrl = appendRelayToken(rawWebSocketUrl, authenticated ? relayToken : '');
    const result = await sendCdpCommand({
      webSocketImpl,
      webSocketUrl,
      method: 'Target.createTarget',
      params: { url },
      timeoutMs,
    });
    if (!result?.targetId) throw new Error('Browser CDP did not return a target id.');
    return { opened: true, timedOut: false, targetId: result.targetId, message: 'Login page opened in the managed browser.' };
  } catch (error) {
    return {
      opened: false,
      timedOut: error?.name === 'AbortError' || /timed out/i.test(String(error?.message || '')),
      message: `Managed browser page open failed: ${error?.message || error}`,
    };
  }
}

function sendCdpCommand({ webSocketImpl, webSocketUrl, method, params, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close?.(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    try {
      socket = new webSocketImpl(webSocketUrl);
      const listen = (event, handler) => {
        if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
        else socket.on?.(event, handler);
      };
      listen('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
      listen('message', (event) => {
        const raw = typeof event === 'string' ? event : event?.data;
        const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
        let payload;
        try { payload = JSON.parse(text); } catch { return; }
        if (payload?.id !== 1) return;
        if (payload.error) finish(new Error(payload.error.message || 'Browser CDP command failed.'));
        else finish(null, payload.result || {});
      });
      listen('error', (event) => finish(new Error(event?.message || 'Browser CDP WebSocket failed.')));
      timer = setTimeout(() => finish(new Error('Browser CDP command timed out.')), Math.max(1000, timeoutMs));
    } catch (error) {
      finish(error);
    }
  });
}

async function resolveRelayToken({ port, openClawConfigPath }) {
  if (!openClawConfigPath) return '';
  try {
    const gatewayConfig = JSON.parse(await readFile(openClawConfigPath, 'utf8'));
    const gatewayToken = gatewayConfig?.gateway?.auth?.token;
    if (typeof gatewayToken !== 'string' || !gatewayToken) return '';
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', gatewayToken)
      .update(`openclaw-extension-relay-v1:${port}`)
      .digest('hex');
  } catch {
    return '';
  }
}

function appendRelayToken(webSocketUrl, relayToken) {
  if (!relayToken) return webSocketUrl;
  const parsed = new URL(webSocketUrl);
  parsed.searchParams.set('token', relayToken);
  return parsed.toString();
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
