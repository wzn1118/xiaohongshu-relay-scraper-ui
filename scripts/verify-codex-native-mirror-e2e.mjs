import { spawnSync } from 'node:child_process';

import { chromium } from '@playwright/test';

const api = String(process.env.XHS_MIRROR_VERIFY_API || 'http://127.0.0.1:46291').replace(/\/$/u, '');
const web = String(process.env.XHS_MIRROR_VERIFY_WEB || 'http://127.0.0.1:46292').replace(/\/$/u, '');
const sessionOriginOverride = String(process.env.XHS_MIRROR_VERIFY_SESSION_ORIGIN || '').replace(/\/$/u, '');
const captureTitle = String(process.env.XHS_MIRROR_VERIFY_WINDOW || 'ChatGPT').trim();
const inputP95LimitMs = Number(process.env.XHS_MIRROR_VERIFY_INPUT_P95_MAX_MS || 0);
const screenshotPath = String(process.env.XHS_MIRROR_VERIFY_SCREENSHOT || '').trim();
const forceRelay = process.env.XHS_MIRROR_VERIFY_FORCE_RELAY === '1';
let remoteDeviceId = String(process.env.XHS_MIRROR_VERIFY_DEVICE_ID || '').trim();
if (!remoteDeviceId && process.argv.includes('--remote')) {
  const [deviceResult, relayStatus] = await Promise.all([
    fetch(`${api}/api/codex-relay/devices`).then((result) => result.json()),
    fetch(`${api}/api/codex-relay/status`).then((result) => result.json()),
  ]);
  const localDeviceId = String(relayStatus?.device?.id || '');
  remoteDeviceId = String((deviceResult.devices || []).find((device) => (
    device.id !== localDeviceId
      && device.paired === true
      && device.online === true
      && device.capabilities?.includes('desktop.input')
  ))?.id || '');
  if (!remoteDeviceId) throw new Error('No online paired device with desktop input is available for remote Mirror verification.');
}
// Production verification may create a session through the local trusted API while
// loading the viewer from the public origin that is permitted by production CORS.
const sessionOrigin = sessionOriginOverride || (remoteDeviceId ? web : api);
const response = await fetch(`${sessionOrigin}/api/codex-native-mirror/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(remoteDeviceId ? { remote: true, deviceId: remoteDeviceId } : { remote: false }),
});
if (!response.ok) throw new Error(await response.text());
const created = await response.json();
const sessionId = created.session.id;
const sourceHeaders = {
  'Content-Type': 'application/json',
  'X-Codex-Mirror-Role': created.source.role,
  'X-Codex-Mirror-Token': created.source.token,
};
let browser;
let originalCursor = null;
try {
  browser = await chromium.launch({
    headless: Boolean(remoteDeviceId),
    args: remoteDeviceId ? [] : [
      `--auto-select-desktop-capture-source=${captureTitle}`,
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await context.newPage();
  const source = remoteDeviceId ? null : await context.newPage();
  const viewerHash = new URLSearchParams({ sessionId, role: created.viewer.role, token: created.viewer.token, ...(forceRelay ? { forceRelay: '1' } : {}) }).toString();
  await viewer.goto(`${web}/codex-native-mirror.html?v=20260819-telemetry-3#${viewerHash}`);
  if (source) {
    const sourceHash = new URLSearchParams({ sessionId, role: created.source.role, token: created.source.token, ...(forceRelay ? { forceRelay: '1' } : {}) }).toString();
    await source.goto(`${web}/codex-native-mirror.html?v=20260819-telemetry-3#${sourceHash}`);
    await source.locator('#select-window').click();
  }
  await viewer.waitForFunction(() => document.body.dataset.playing === 'true', null, { timeout: 20_000 });
  await viewer.waitForFunction(() => document.body.dataset.state === 'connected', null, { timeout: 20_000 });
  await viewer.waitForFunction(() => {
    const video = document.querySelector('#mirror-video');
    return Boolean(video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0);
  }, null, { timeout: forceRelay ? 2_000 : 20_000 }).catch(async (error) => {
    if (!forceRelay) throw error;
    await viewer.waitForFunction(() => {
      const canvas = document.querySelector('#mirror-relay-canvas');
      return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && document.body.dataset.playing === 'true');
    }, null, { timeout: 30_000 });
  });

  const detailsBefore = await readSession(created.viewer);
  const target = detailsBefore.session?.inputTarget;
  const targetHandle = /^(?:window|screen):(\d+):/u.exec(String(target?.label || ''))?.[1];
  if (!targetHandle) throw new Error(`The selected capture did not expose a window handle: ${target?.label || 'missing label'}`);
  const nativeBefore = probeWindow(targetHandle);
  if (/Codex Native Mirror/iu.test(String(nativeBefore.title || '')) || /^(?:msedge|chrome)$/iu.test(String(nativeBefore.process || ''))) {
    throw new Error(`Mirror selected its browser source instead of the Codex desktop window: ${JSON.stringify({ title: nativeBefore.title, process: nativeBefore.process })}`);
  }
  originalCursor = nativeBefore.cursor;
  const point = { x: 0.35, y: 0.4 };
  const videoPoint = await viewer.locator(forceRelay ? '#mirror-relay-canvas' : '#mirror-video').evaluate((surface, normalized) => {
    const rect = surface.getBoundingClientRect();
    const width = surface.videoWidth || surface.width || rect.width;
    const height = surface.videoHeight || surface.height || rect.height;
    const scale = Math.min(rect.width / width, rect.height / height);
    const renderedWidth = width * scale;
    const renderedHeight = height * scale;
    return {
      clientX: rect.left + (rect.width - renderedWidth) / 2 + renderedWidth * normalized.x,
      clientY: rect.top + (rect.height - renderedHeight) / 2 + renderedHeight * normalized.y,
    };
  }, point);
  await viewer.mouse.move(videoPoint.clientX, videoPoint.clientY);
  await viewer.keyboard.down('Shift');
  await viewer.keyboard.up('Shift');
  for (let sample = 0; sample < 5; sample += 1) {
    await viewer.keyboard.down('Shift');
    await viewer.keyboard.up('Shift');
  }
  try {
    await viewer.waitForFunction(() => (
      Number(document.body.dataset.inputSamples || 0) >= 10
        && document.body.dataset.connectionPath
        && document.body.dataset.connectionPath !== 'unknown'
    ), null, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await viewer.evaluate(() => ({
      state: document.querySelector('#state-label')?.textContent || '',
      path: document.body.dataset.connectionPath || '',
      transport: document.body.dataset.transport || '',
      playing: document.body.dataset.playing || '',
      metrics: window.__codexMirrorMetrics || {},
    })).catch(() => ({}));
    const sourceDiagnostic = source ? await source.evaluate(() => ({
      state: document.querySelector('#state-label')?.textContent || '',
      path: document.body.dataset.connectionPath || '',
      transport: document.body.dataset.transport || '',
      playing: document.body.dataset.playing || '',
    })).catch(() => ({})) : null;
    throw new Error(`Mirror input verification timed out: ${JSON.stringify({ diagnostic, sourceDiagnostic })}; ${error.message}`);
  }
  await viewer.waitForFunction(() => Number(document.body.dataset.inputSamples || 0) >= 10, null, { timeout: 30_000 });
  if (forceRelay) {
    await viewer.waitForFunction(() => document.body.dataset.connectionPath === 'wss-relay', null, { timeout: 10_000 });
    const canvasPixels = await viewer.locator('#mirror-relay-canvas').evaluate((canvas) => {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const data = context?.getImageData(0, 0, Math.min(canvas.width, 64), Math.min(canvas.height, 64)).data || [];
      let nonBlack = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] > 8 || data[index + 1] > 8 || data[index + 2] > 8) nonBlack += 1;
      }
      return { width: canvas.width, height: canvas.height, nonBlack };
    });
    if (canvasPixels.nonBlack < 4) throw new Error(`WSS relay canvas is blank: ${JSON.stringify(canvasPixels)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  const nativeAfter = probeWindow(targetHandle);
  const mappedRect = selectMappedRect(nativeAfter, target);
  const expected = {
    x: Math.round(mappedRect.left + Math.max(0, mappedRect.right - mappedRect.left - 1) * point.x),
    y: Math.round(mappedRect.top + Math.max(0, mappedRect.bottom - mappedRect.top - 1) * point.y),
  };
  const pixelDelta = {
    x: Math.abs(nativeAfter.cursor.x - expected.x),
    y: Math.abs(nativeAfter.cursor.y - expected.y),
  };
  if (pixelDelta.x > 3 || pixelDelta.y > 3) {
    throw new Error(`Mirror coordinate mismatch: expected ${expected.x},${expected.y}; actual ${nativeAfter.cursor.x},${nativeAfter.cursor.y}; target=${JSON.stringify(target)}; point=${JSON.stringify(point)}; videoPoint=${JSON.stringify(videoPoint)}; before=${JSON.stringify(nativeBefore)}; after=${JSON.stringify(nativeAfter)}; mapped=${JSON.stringify(mappedRect)}.`);
  }
  const detailsAfter = await readSession(created.viewer);
  if (!detailsAfter.session?.peerConnected || !detailsAfter.session?.controlConnected || detailsAfter.session?.state !== 'connected') {
    throw new Error('Mirror peer or interactive control channel did not reach connected state.');
  }
  const metrics = await viewer.evaluate(() => ({ ...(window.__codexMirrorMetrics || {}) }));
  if (screenshotPath) await viewer.screenshot({ path: screenshotPath, fullPage: true });
  if (inputP95LimitMs > 0 && Number(metrics.inputP95Ms) > inputP95LimitMs) {
    throw new Error(`Mirror input P95 ${metrics.inputP95Ms} ms exceeded ${inputP95LimitMs} ms: ${JSON.stringify(metrics)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: remoteDeviceId ? 'remote' : 'local',
    transport: metrics.connectionPath,
    deviceId: remoteDeviceId || null,
    sessionId,
    viewerState: await viewer.locator('#state-label').textContent(),
    sourceState: source ? await source.locator('#state-label').textContent() : detailsAfter.session.sourceLaunch?.state,
    sessionState: detailsAfter.session.state,
    peerConnected: detailsAfter.session.peerConnected,
    controlConnected: detailsAfter.session.controlConnected,
    inputTarget: target,
    expected,
    actual: nativeAfter.cursor,
    pixelDelta,
    metrics,
    screenshotPath: screenshotPath || null,
    inputP95LimitMs: inputP95LimitMs > 0 ? inputP95LimitMs : null,
    forceRelay,
  }));
} finally {
  if (originalCursor) setCursor(originalCursor);
  await browser?.close().catch(() => {});
  await fetch(`${api}/api/codex-native-mirror/sessions/${sessionId}`, { method: 'DELETE', headers: sourceHeaders }).catch(() => {});
}

async function readSession(credentials) {
  const result = await fetch(`${api}/api/codex-native-mirror/sessions/${sessionId}`, {
    headers: {
      'X-Codex-Mirror-Role': credentials.role,
      'X-Codex-Mirror-Token': credentials.token,
    },
  });
  if (!result.ok) throw new Error(await result.text());
  return result.json();
}

function selectMappedRect(probe, target) {
  const targetWidth = Number(target?.width || 0);
  const targetHeight = Number(target?.height || 0);
  if (!targetWidth || !targetHeight) return probe.outer;
  return [probe.outer, probe.client].reduce((best, candidate) => {
    const width = candidate.right - candidate.left;
    const height = candidate.bottom - candidate.top;
    const score = Math.abs(width - targetWidth) / targetWidth + Math.abs(height - targetHeight) / targetHeight;
    return !best || score < best.score ? { ...candidate, score } : best;
  }, null);
}

function probeWindow(handle) {
  const script = String.raw`
$source=@'
using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
public static class MirrorVerifyNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  public static string Title(IntPtr h) { var text=new StringBuilder(512); GetWindowText(h,text,text.Capacity); return text.ToString(); }
  public static string ProcessName(IntPtr h) { uint pid=0; GetWindowThreadProcessId(h,out pid); try { return pid==0 ? "" : Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
}
'@
Add-Type $source -ErrorAction SilentlyContinue
[void][MirrorVerifyNative]::SetProcessDPIAware()
$h=[IntPtr]${handle}
$outer=New-Object MirrorVerifyNative+RECT
$client=New-Object MirrorVerifyNative+RECT
$origin=New-Object MirrorVerifyNative+POINT
$cursor=New-Object MirrorVerifyNative+POINT
[void][MirrorVerifyNative]::GetWindowRect($h,[ref]$outer)
[void][MirrorVerifyNative]::GetClientRect($h,[ref]$client)
[void][MirrorVerifyNative]::ClientToScreen($h,[ref]$origin)
[void][MirrorVerifyNative]::GetCursorPos([ref]$cursor)
@{title=[MirrorVerifyNative]::Title($h);process=[MirrorVerifyNative]::ProcessName($h);outer=@{left=$outer.Left;top=$outer.Top;right=$outer.Right;bottom=$outer.Bottom};client=@{left=$origin.X;top=$origin.Y;right=$origin.X+$client.Right-$client.Left;bottom=$origin.Y+$client.Bottom-$client.Top};cursor=@{x=$cursor.X;y=$cursor.Y}}|ConvertTo-Json -Compress
`;
  return JSON.parse(runPowershell(script));
}

function setCursor(point) {
  const script = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class MirrorVerifyCursor { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }' -ErrorAction SilentlyContinue; [void][MirrorVerifyCursor]::SetCursorPos(${Number(point.x)},${Number(point.y)})`;
  runPowershell(script);
}

function runPowershell(script) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'PowerShell verification failed.').trim());
  return String(result.stdout || '').trim();
}
