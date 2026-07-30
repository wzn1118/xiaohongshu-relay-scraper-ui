import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRelayToken } from './relay.mjs';
import { planRelayRecovery, relayTargetSummary } from './relay-targets.mjs';

const execFileAsync = promisify(execFile);
export const RELAY_CONNECT_TIMEOUT_MS = 60000;

export async function recoverRelay({
  port,
  profile = 'openclaw',
  openClawConfigPath,
  pythonBin,
  connectionCheckScriptPath,
  timeoutMs = 8000,
  connectTimeoutMs = RELAY_CONNECT_TIMEOUT_MS,
  fetchImpl = fetch,
  webSocketImpl = WebSocket,
  connectionChecker = checkPlaywrightRelayConnection,
}) {
  const relayToken = await resolveRelayToken({ port, openClawConfigPath });
  const beforeTargets = await readRelayTargets({ port, relayToken, timeoutMs, fetchImpl });
  const plan = planRelayRecovery(beforeTargets);
  const versionResponse = await readRelayJson({ port, path: '/json/version', relayToken, timeoutMs, fetchImpl });
  const rawWebSocketUrl = String(versionResponse.value?.webSocketDebuggerUrl || '').trim();
  if (!rawWebSocketUrl) throw new Error('Relay version response has no WebSocket endpoint.');

  const client = await createCdpClient({
    webSocketUrl: appendRelayToken(rawWebSocketUrl, versionResponse.authenticated ? relayToken : ''),
    timeoutMs,
    webSocketImpl,
  });
  const warnings = [];
  let keeperId = String(plan.keeper?.id || '');
  let createdFreshTarget = false;
  let closedTargets = 0;

  try {
    if (plan.replaceWithFreshPage) {
      const created = await client.command('Target.createTarget', { url: 'https://www.xiaohongshu.com/explore' });
      keeperId = String(created?.targetId || '');
      if (!keeperId) throw new Error('Relay did not return a replacement Xiaohongshu target id.');
      createdFreshTarget = true;
    }

    for (const target of plan.closeTargets) {
      try {
        const result = await client.command('Target.closeTarget', { targetId: String(target.id) });
        if (result?.success !== false) closedTargets += 1;
      } catch (error) {
        warnings.push(`Could not close target ${target.id}: ${publicError(error)}`);
      }
    }

    if (keeperId) {
      try {
        await client.command('Target.activateTarget', { targetId: keeperId });
      } catch (error) {
        warnings.push(`Could not activate the clean target: ${publicError(error)}`);
      }
    }
    await client.command('Browser.getVersion');
  } finally {
    client.close();
  }

  await delay(900);
  const afterTargets = await readRelayTargets({ port, relayToken, timeoutMs, fetchImpl });
  const after = relayTargetSummary(afterTargets);
  const check = await connectionChecker({
    pythonBin,
    scriptPath: connectionCheckScriptPath,
    port,
    timeoutMs: connectTimeoutMs,
  });
  const ok = Boolean(check.ok && after.xiaohongshuPages > 0);

  return {
    ok,
    ready: ok,
    running: true,
    cdpReady: true,
    authenticated: versionResponse.authenticated,
    repaired: createdFreshTarget || closedTargets > 0,
    port,
    profile,
    tabs: after.targetCount,
    tabCount: after.targetCount,
    xiaohongshuTabs: after.xiaohongshuPages,
    pageCount: after.pageCount,
    targetPressure: after.pressure,
    recoveryRecommended: after.recoveryRecommended,
    before: plan.summary,
    after,
    closedTargets,
    createdFreshTarget,
    sessionPreserved: true,
    playwrightVerified: Boolean(check.ok),
    connectionTimeoutMs: connectTimeoutMs,
    checkedAt: new Date().toISOString(),
    warnings,
    message: ok
      ? `Relay recovered: closed ${closedTargets} stale page(s), kept a clean Xiaohongshu page, and verified Playwright.`
      : `Relay cleanup finished, but Playwright verification failed: ${check.message || 'unknown error'}`,
    check,
  };
}

export async function checkPlaywrightRelayConnection({ pythonBin, scriptPath, port, timeoutMs }) {
  if (!pythonBin || !scriptPath) {
    return { ok: false, message: 'Relay Playwright checker is not configured.' };
  }
  try {
    const { stdout } = await execFileAsync(pythonBin, [
      scriptPath,
      '--relay-port', String(port),
      '--timeout-ms', String(timeoutMs),
    ], {
      timeout: timeoutMs + 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    return parseCheckerOutput(stdout);
  } catch (error) {
    const parsed = parseCheckerOutput(error?.stdout || '');
    return parsed.ok ? parsed : {
      ok: false,
      message: parsed.message || publicError(error),
      timedOut: Boolean(error?.killed || error?.signal),
    };
  }
}

async function readRelayTargets(options) {
  const response = await readRelayJson({ ...options, path: '/json/list' });
  if (!Array.isArray(response.value)) throw new Error('Relay returned an invalid target list.');
  return response.value;
}

async function readRelayJson({ port, path, relayToken, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = (headers) => fetchImpl(`http://127.0.0.1:${port}${path}`, {
      ...(Object.keys(headers).length ? { headers } : {}),
      signal: controller.signal,
    });
    let response = await request(relayToken ? { 'x-openclaw-relay-token': relayToken } : {});
    const authenticated = Boolean(relayToken && response.ok);
    if (!response.ok && relayToken) response = await request({});
    if (!response.ok) throw new Error(`Relay responded with HTTP ${response.status}.`);
    return { value: await response.json(), authenticated };
  } finally {
    clearTimeout(timer);
  }
}

function createCdpClient({ webSocketUrl, timeoutMs, webSocketImpl }) {
  return new Promise((resolve, reject) => {
    let socket;
    let nextId = 0;
    let opened = false;
    const pending = new Map();
    const openTimer = setTimeout(() => finishOpen(new Error('Relay CDP WebSocket open timed out.')), timeoutMs);

    const listen = (event, handler) => {
      if (typeof socket?.addEventListener === 'function') socket.addEventListener(event, handler);
      else socket?.on?.(event, handler);
    };
    const finishOpen = (error) => {
      if (opened) return;
      opened = true;
      clearTimeout(openTimer);
      if (error) reject(error);
      else resolve({
        command(method, params = {}) {
          const id = ++nextId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`Relay CDP command ${method} timed out.`));
            }, timeoutMs);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { socket.close(); } catch {}
        },
      });
    };

    try {
      socket = new webSocketImpl(webSocketUrl);
      listen('open', () => finishOpen());
      listen('message', (event) => {
        const raw = typeof event === 'string' ? event : event?.data ?? event;
        const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
        let payload;
        try { payload = JSON.parse(text); } catch { return; }
        const request = pending.get(payload?.id);
        if (!request) return;
        pending.delete(payload.id);
        clearTimeout(request.timer);
        if (payload.error) request.reject(new Error(payload.error.message || 'Relay CDP command failed.'));
        else request.resolve(payload.result || {});
      });
      listen('error', (event) => finishOpen(new Error(event?.message || 'Relay CDP WebSocket failed.')));
      listen('close', () => {
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Relay CDP WebSocket closed.'));
        }
        pending.clear();
      });
    } catch (error) {
      finishOpen(error);
    }
  });
}

function appendRelayToken(webSocketUrl, relayToken) {
  if (!relayToken) return webSocketUrl;
  const parsed = new URL(webSocketUrl);
  parsed.searchParams.set('token', relayToken);
  return parsed.toString();
}

function parseCheckerOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  try {
    return JSON.parse(lines.at(-1) || '{}');
  } catch {
    return { ok: false, message: lines.at(-1) || 'Relay checker returned no result.' };
  }
}

function publicError(error) {
  if (error?.name === 'AbortError') return 'Relay request timed out.';
  return String(error?.message || error).replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
