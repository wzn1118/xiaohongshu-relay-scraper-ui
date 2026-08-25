import { spawn } from 'node:child_process';

const MAX_TARGET_LABEL = 300;
const MAX_EVENTS_PER_SECOND = 180;
const BRIDGE_RESPONSE_TIMEOUT_MS = 2_000;
const BRIDGE_STARTUP_TIMEOUT_MS = 5_000;

export class CodexNativeInputServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexNativeInputServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexNativeInputService(options = {}) {
  return new CodexNativeInputService(options);
}

export class CodexNativeInputService {
  constructor({
    platform = process.platform,
    spawnProcess = spawn,
    now = () => Date.now(),
  } = {}) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.targets = new Map();
    this.eventWindows = new Map();
    this.bridge = null;
    this.bridgeReady = false;
    this.bridgeStartup = null;
    this.bridgeStartupResolve = null;
    this.bridgeStartupReject = null;
    this.bridgeStartupTimer = null;
    this.bridgeSequence = 0;
    this.bridgeBuffer = '';
    this.bridgePending = new Map();
    this.metrics = {
      events: 0,
      bestEffortMoves: 0,
      acknowledged: 0,
      failed: 0,
      timeouts: 0,
      latencies: [],
      lastLatencyMs: null,
      lastError: '',
    };
  }

  status() {
    return {
      available: this.platform === 'win32',
      transport: this.platform === 'win32' ? 'windows-sendinput' : 'unavailable',
      state: this.platform === 'win32' ? 'interactive' : 'unavailable',
      inputEnabled: this.platform === 'win32',
      targetMode: 'selected-window-title',
      activeTargets: this.targets.size,
      bridgeReady: this.bridgeReady === true && this.bridge != null && this.bridge.killed !== true,
      pending: this.bridgePending.size,
      metrics: {
        events: this.metrics.events,
        bestEffortMoves: this.metrics.bestEffortMoves,
        acknowledged: this.metrics.acknowledged,
        failed: this.metrics.failed,
        timeouts: this.metrics.timeouts,
        lastLatencyMs: this.metrics.lastLatencyMs,
        p50Ms: percentile(this.metrics.latencies, 0.5),
        p95Ms: percentile(this.metrics.latencies, 0.95),
        lastError: this.metrics.lastError,
      },
    };
  }

  setTarget(sessionId, { label = '', width = 0, height = 0, delivery = 'sendinput' } = {}) {
    this._assertAvailable();
    const id = normalizeSessionId(sessionId);
    const normalizedLabel = String(label || '').trim().slice(0, MAX_TARGET_LABEL);
    if (!normalizedLabel) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_TARGET_INVALID', 'The selected window did not expose a usable title.', 409);
    }
    const target = {
      label: normalizedLabel,
      width: normalizeDimension(width),
      height: normalizeDimension(height),
      delivery: String(delivery || '').trim() === 'window-message' ? 'window-message' : 'sendinput',
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.targets.set(id, target);
    void this._ensureBridge().catch(() => {});
    return { accepted: true, sessionId: id, target: { ...target } };
  }

  async send(sessionId, event) {
    this._assertAvailable();
    const id = normalizeSessionId(sessionId);
    const target = this.targets.get(id);
    if (!target) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_TARGET_MISSING', 'The selected window input target is not registered.', 409);
    }
    this._assertRate(id);
    const normalized = normalizeInputEvent(event);
    await this._ensureBridge();
    const requestId = `input-${++this.bridgeSequence}`;
    const payload = JSON.stringify({ ...normalized, requestId, target });
    this.metrics.events += 1;
    const needsAck = !(normalized.type === 'mouse' && normalized.action === 'move');
    const resultPromise = needsAck ? this._awaitBridgeResult(requestId) : null;
    if (!this.bridge?.stdin?.write(payload + '\n')) {
      const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge is not available.', 503);
      if (needsAck) this._rejectBridgeRequest(requestId, error);
      else this._recordFailure(error);
      throw error;
    }
    // Pointer motion is intentionally best-effort. Waiting for a PowerShell
    // acknowledgement on every frame creates input backlog and visible lag;
    // clicks and keyboard events still wait for delivery confirmation below.
    if (normalized.type === 'mouse' && normalized.action === 'move') {
      this.metrics.bestEffortMoves += 1;
      return {
        accepted: true,
        sessionId: id,
        type: normalized.type,
        targetFound: true,
        delivered: true,
      };
    }
    const result = await resultPromise;
    if (result.ok !== true) {
      const code = result.targetFound === false
        ? 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND'
        : 'CODEX_MIRROR_INPUT_BRIDGE_REJECTED';
      throw new CodexNativeInputServiceError(code, String(result.message || 'The Windows input bridge rejected the event.').slice(0, 300), code.endsWith('NOT_FOUND') ? 409 : 503);
    }
    return {
      accepted: true,
      sessionId: id,
      type: normalized.type,
      targetFound: result.targetFound !== false,
      delivered: result.delivered !== false,
    };
  }

  async warm(sessionId = '') {
    this._assertAvailable();
    await this._ensureBridge();
    if (sessionId) {
      const id = normalizeSessionId(sessionId);
      const target = this.targets.get(id);
      if (!target) {
        throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_TARGET_MISSING', 'The selected window input target is not registered.', 409);
      }
      const requestId = `input-${++this.bridgeSequence}`;
      this.metrics.events += 1;
      const resultPromise = this._awaitBridgeResult(requestId);
      if (!this.bridge?.stdin?.write(`${JSON.stringify({ type: 'warmup', requestId, target })}\n`)) {
        const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge is not available.', 503);
        this._rejectBridgeRequest(requestId, error);
        throw error;
      }
      const result = await resultPromise;
      if (result.ok !== true) {
        throw new CodexNativeInputServiceError(
          result.targetFound === false ? 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND' : 'CODEX_MIRROR_INPUT_BRIDGE_REJECTED',
          String(result.message || 'The Windows input bridge could not prepare the selected window.').slice(0, 300),
          result.targetFound === false ? 409 : 503,
        );
      }
    }
    return { ready: true, transport: 'windows-sendinput' };
  }

  clearTarget(sessionId) {
    const id = normalizeSessionId(sessionId);
    this.targets.delete(id);
    this.eventWindows.delete(id);
    if (!this.targets.size && this.bridge) {
      this.bridge.stdin?.end();
      this.bridge.kill?.();
      this.bridge = null;
      this.bridgeReady = false;
      this._settleBridgeStartup(new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge was closed.', 503));
      this._rejectBridgePending(new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge was closed.', 503));
    }
    return { cleared: true, sessionId: id };
  }

  async close() {
    this.targets.clear();
    this.eventWindows.clear();
    if (this.bridge) {
      this.bridge.stdin?.end();
      this.bridge.kill?.();
    }
    this.bridge = null;
    this.bridgeReady = false;
    this._settleBridgeStartup(new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge was closed.', 503));
    this._rejectBridgePending(new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge was closed.', 503));
  }

  _assertAvailable() {
    if (this.platform !== 'win32') {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_UNAVAILABLE', 'Windows input injection is unavailable on this host.', 503);
    }
  }

  _assertRate(sessionId) {
    const now = Number(this.now());
    const current = this.eventWindows.get(sessionId) || { startedAt: now, count: 0 };
    if (now - current.startedAt >= 1_000) {
      current.startedAt = now;
      current.count = 0;
    }
    current.count += 1;
    this.eventWindows.set(sessionId, current);
    if (current.count > MAX_EVENTS_PER_SECOND) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_RATE_LIMITED', 'Native Mirror input rate is too high.', 429);
    }
  }

  async _ensureBridge() {
    if (this.bridge && this.bridgeReady && !this.bridge.killed) return;
    if (this.bridge && this.bridgeStartup && !this.bridge.killed) return this.bridgeStartup;
    const script = powershellBridgeScript();
    const child = this.spawnProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.once?.('exit', () => {
      this.bridgeReady = false;
      if (this.bridge === child) this.bridge = null;
      const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge exited.', 503);
      this._settleBridgeStartup(error);
      this._rejectBridgePending(error);
    });
    child.once?.('error', () => {
      this.bridgeReady = false;
      if (this.bridge === child) this.bridge = null;
      const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_CLOSED', 'The Windows input bridge failed.', 503);
      this._settleBridgeStartup(error);
      this._rejectBridgePending(error);
    });
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => this._handleBridgeOutput(chunk));
    this.bridge = child;
    this.bridgeReady = false;
    this.bridgeStartup = new Promise((resolve, reject) => {
      this.bridgeStartupResolve = resolve;
      this.bridgeStartupReject = reject;
      this.bridgeStartupTimer = setTimeout(() => {
        const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_TIMEOUT', 'The Windows input bridge did not become ready.', 504);
        if (this.bridge === child) {
          this.bridge = null;
          child.kill?.();
        }
        this._settleBridgeStartup(error);
      }, BRIDGE_STARTUP_TIMEOUT_MS);
    });
    return this.bridgeStartup;
  }

  _awaitBridgeResult(requestId) {
    if (!this.bridge?.stdout?.on) {
      // Test doubles and older custom bridges can still acknowledge delivery by write success.
      return Promise.resolve({ ok: true, delivered: true, targetFound: true });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridgePending.delete(requestId);
        const error = new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_BRIDGE_TIMEOUT', 'The Windows input bridge did not confirm delivery.', 504);
        this._recordFailure(error, { timeout: true });
        reject(error);
      }, BRIDGE_RESPONSE_TIMEOUT_MS);
      this.bridgePending.set(requestId, { resolve, reject, timer, startedAt: Number(this.now()) });
    });
  }

  _rejectBridgeRequest(requestId, error) {
    const pending = this.bridgePending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.bridgePending.delete(requestId);
    this._recordFailure(error);
    pending.reject(error);
  }

  _handleBridgeOutput(chunk) {
    this.bridgeBuffer = `${this.bridgeBuffer}${String(chunk || '')}`.slice(-128 * 1024);
    const lines = this.bridgeBuffer.split(/\r?\n/);
    this.bridgeBuffer = lines.pop() || '';
    for (const line of lines) {
      let result;
      try { result = JSON.parse(line); } catch { continue; }
      if (result?.type === 'bridge.ready') {
        this.bridgeReady = true;
        this._settleBridgeStartup();
        continue;
      }
      const requestId = String(result?.requestId || '');
      const pending = this.bridgePending.get(requestId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.bridgePending.delete(requestId);
      this._recordLatency(Math.max(0, Number(this.now()) - pending.startedAt));
      if (result.ok === true) this.metrics.acknowledged += 1;
      else this._recordFailure(new CodexNativeInputServiceError(
        result.targetFound === false ? 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND' : 'CODEX_MIRROR_INPUT_BRIDGE_REJECTED',
        String(result.message || 'The Windows input bridge rejected the event.'),
      ));
      pending.resolve(result);
    }
  }

  _rejectBridgePending(error) {
    for (const pending of this.bridgePending.values()) {
      clearTimeout(pending.timer);
      this._recordFailure(error);
      pending.reject(error);
    }
    this.bridgePending.clear();
  }

  _recordLatency(value) {
    const latency = Number(value);
    if (!Number.isFinite(latency) || latency < 0) return;
    this.metrics.lastLatencyMs = Math.round(latency * 10) / 10;
    this.metrics.latencies.push(this.metrics.lastLatencyMs);
    if (this.metrics.latencies.length > 256) this.metrics.latencies.splice(0, this.metrics.latencies.length - 256);
  }

  _recordFailure(error, { timeout = false } = {}) {
    this.metrics.failed += 1;
    if (timeout) this.metrics.timeouts += 1;
    this.metrics.lastError = String(error?.message || error || '').slice(0, 300);
  }

  _settleBridgeStartup(error = null) {
    if (this.bridgeStartupTimer) clearTimeout(this.bridgeStartupTimer);
    this.bridgeStartupTimer = null;
    const resolve = this.bridgeStartupResolve;
    const reject = this.bridgeStartupReject;
    this.bridgeStartup = null;
    this.bridgeStartupResolve = null;
    this.bridgeStartupReject = null;
    if (error) reject?.(error);
    else resolve?.();
  }
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function normalizeSessionId(value) {
  const id = String(value || '').trim();
  if (!/^mirror-[A-Za-z0-9-]{8,140}$/.test(id)) {
    throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_SESSION_INVALID', 'The Native Mirror session id is invalid.');
  }
  return id;
}

function normalizeDimension(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 32_768) return 0;
  return Math.round(number);
}

function normalizeInputEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'Native Mirror input must be an object.');
  }
  const type = String(value.type || '').trim();
  if (type === 'mouse') {
    const action = String(value.action || '').trim();
    if (!['move', 'down', 'up', 'click', 'doubleclick', 'wheel'].includes(action)) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'The mouse action is invalid.');
    }
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'The mouse coordinates must be normalized between 0 and 1.');
    }
    const rawButton = Number(value.button ?? 0);
    const button = ['move', 'wheel'].includes(action) && rawButton === -1 ? 0 : rawButton;
    const delta = Number(value.delta ?? 0);
    if (!Number.isInteger(button) || button < 0 || button > 4 || !Number.isFinite(delta) || Math.abs(delta) > 10_000) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'The mouse button or wheel delta is invalid.');
    }
    return { type, action, x, y, button, delta: Math.trunc(delta) };
  }
  if (type === 'key') {
    const phase = String(value.phase || '').trim();
    const code = String(value.code || '').trim().slice(0, 80);
    const key = String(value.key || '').slice(0, 32);
    if (!['down', 'up'].includes(phase) || !code) {
      throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'The keyboard event is invalid.');
    }
    return { type, phase, code, key, repeat: Boolean(value.repeat), vk: virtualKeyFor(code) };
  }
  throw new CodexNativeInputServiceError('CODEX_MIRROR_INPUT_INVALID', 'The Native Mirror input type is invalid.');
}

function virtualKeyFor(code) {
  const named = {
    Enter: 0x0d, Escape: 0x1b, Backspace: 0x08, Tab: 0x09, Space: 0x20,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Delete: 0x2e,
    ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
    AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
    CapsLock: 0x14, NumLock: 0x90, PrintScreen: 0x2c, ContextMenu: 0x5d,
  };
  if (named[code]) return named[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1].charCodeAt(0);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return 0x60 + Number(numpad[1]);
  return 0;
}

function powershellBridgeScript() {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexInputBridge {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr hWnd, POINT point, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1, MOUSE_MOVE=0x0001, LEFT_DOWN=0x0002, LEFT_UP=0x0004, RIGHT_DOWN=0x0008, RIGHT_UP=0x0010, MIDDLE_DOWN=0x0020, MIDDLE_UP=0x0040, X_DOWN=0x0080, X_UP=0x0100, WHEEL=0x0800, KEYUP=0x0002, UNICODE=0x0004;
  const uint WM_MOUSEMOVE=0x0200, WM_LBUTTONDOWN=0x0201, WM_LBUTTONUP=0x0202, WM_RBUTTONDOWN=0x0204, WM_RBUTTONUP=0x0205, WM_MBUTTONDOWN=0x0207, WM_MBUTTONUP=0x0208, WM_MOUSEWHEEL=0x020A, WM_XBUTTONDOWN=0x020B, WM_XBUTTONUP=0x020C, WM_KEYDOWN=0x0100, WM_KEYUP=0x0101;
  const uint CWP_SKIPINVISIBLE=0x0001, CWP_SKIPDISABLED=0x0002, CWP_SKIPTRANSPARENT=0x0004;
  static CodexInputBridge() { SetProcessDPIAware(); }
  static bool UsableRect(RECT rect) {
    int width=rect.Right-rect.Left, height=rect.Bottom-rect.Top;
    if(width<320 || height<200) return false;
    int virtualLeft=GetSystemMetrics(76), virtualTop=GetSystemMetrics(77);
    int virtualRight=virtualLeft+GetSystemMetrics(78), virtualBottom=virtualTop+GetSystemMetrics(79);
    return rect.Right>virtualLeft && rect.Left<virtualRight && rect.Bottom>virtualTop && rect.Top<virtualBottom;
  }
  static string ProcessName(IntPtr h) {
    uint processId=0; GetWindowThreadProcessId(h,out processId);
    try { return processId==0 ? "" : Process.GetProcessById((int)processId).ProcessName; } catch { return ""; }
  }
  static bool IsAppAlias(string value) {
    return value.IndexOf("codex",StringComparison.OrdinalIgnoreCase)>=0 || value.IndexOf("chatgpt",StringComparison.OrdinalIgnoreCase)>=0;
  }
  public static IntPtr FindWindow(string title,bool allowHidden) {
    IntPtr found=IntPtr.Zero; int bestScore=-1; string needle=(title??"").Trim(); bool appAlias=IsAppAlias(needle);
    if(appAlias) {
      foreach(var processName in new[]{"ChatGPT","Codex"}) {
        try {
          foreach(var process in Process.GetProcessesByName(processName)) {
            IntPtr candidate=process.MainWindowHandle;
            if(candidate==IntPtr.Zero) continue;
            RECT processRect; if(!GetWindowRect(candidate,out processRect)) continue;
            if(!allowHidden && (!IsWindowVisible(candidate) || !UsableRect(processRect))) continue;
            var processTitle=new StringBuilder(512); GetWindowText(candidate,processTitle,processTitle.Capacity);
            if(processTitle.ToString().Trim().Equals(needle,StringComparison.OrdinalIgnoreCase)) return candidate;
            if(found==IntPtr.Zero) found=candidate;
          }
        } catch { }
      }
      if(found!=IntPtr.Zero) return found;
    }
    EnumWindows((h,p)=>{
      RECT rect; if(!GetWindowRect(h,out rect)) return true;
      if(!allowHidden && (!IsWindowVisible(h) || !UsableRect(rect))) return true;
      var b=new StringBuilder(512); GetWindowText(h,b,b.Capacity); var name=b.ToString().Trim();
      if(name.Length==0 || name.IndexOf("Codex Native Mirror",StringComparison.OrdinalIgnoreCase)>=0) return true;
      if(needle.Length>0 && name.Equals(needle,StringComparison.OrdinalIgnoreCase)) { found=h; bestScore=1200; return false; }
      var process=ProcessName(h);
      bool appProcess=process.Equals("ChatGPT",StringComparison.OrdinalIgnoreCase) || process.Equals("Codex",StringComparison.OrdinalIgnoreCase);
      int score=-1;
      if(needle.Length>0 && name.StartsWith(needle,StringComparison.OrdinalIgnoreCase)) score=1100;
      else if(needle.Length>0 && name.IndexOf(needle,StringComparison.OrdinalIgnoreCase)>=0) score=1000;
      if(appAlias && appProcess) score=Math.Max(score,1150);
      if(needle.Length==0 && appProcess) score=Math.Max(score,900);
      if(score>bestScore) { bestScore=score; found=h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Alive(IntPtr h) { RECT rect; return h!=IntPtr.Zero && IsWindow(h) && IsWindowVisible(h) && GetWindowRect(h,out rect) && UsableRect(rect); }
  public static bool Exists(IntPtr h) { return h!=IntPtr.Zero && IsWindow(h); }
  public static RECT WindowRect(IntPtr h) { RECT r; GetWindowRect(h,out r); return r; }
  public static RECT ClientScreenRect(IntPtr h) { RECT client; GetClientRect(h,out client); POINT point=new POINT { X=client.Left, Y=client.Top }; ClientToScreen(h,ref point); return new RECT { Left=point.X, Top=point.Y, Right=point.X+(client.Right-client.Left), Bottom=point.Y+(client.Bottom-client.Top) }; }
  public static void Focus(IntPtr h) { if(h!=IntPtr.Zero) SetForegroundWindow(h); }
  static uint SendMouse(uint flags, uint mouseData=0) { var input=new INPUT { type=INPUT_MOUSE, data=new INPUTUNION { mi=new MOUSEINPUT { dwFlags=flags, mouseData=mouseData } } }; return SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT))); }
  public static bool Move(int x,int y) { return SetCursorPos(x,y); }
  public static uint Button(int button,bool down) { uint f=button==0?(down?LEFT_DOWN:LEFT_UP):button==1?(down?MIDDLE_DOWN:MIDDLE_UP):button==2?(down?RIGHT_DOWN:RIGHT_UP):(down?X_DOWN:X_UP); return SendMouse(f,button>2?(uint)(button==3?1:2):0); }
  public static uint Wheel(int delta) { return SendMouse(WHEEL,(uint)delta); }
  public static uint Key(ushort vk,bool up) { var input=new INPUT { type=INPUT_KEYBOARD, data=new INPUTUNION { ki=new KEYBDINPUT { wVk=vk, dwFlags=up?KEYUP:0 } } }; return SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT))); }
  public static uint Unicode(char c,bool up) { var input=new INPUT { type=INPUT_KEYBOARD, data=new INPUTUNION { ki=new KEYBDINPUT { wScan=c, dwFlags=UNICODE | (up?KEYUP:0) } } }; return SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT))); }
  static IntPtr PointTarget(IntPtr root,int screenX,int screenY) {
    IntPtr current=root;
    for(int depth=0;depth<12;depth++) {
      POINT point=new POINT { X=screenX, Y=screenY };
      if(!ScreenToClient(current,ref point)) break;
      IntPtr child=ChildWindowFromPointEx(current,point,CWP_SKIPINVISIBLE|CWP_SKIPDISABLED|CWP_SKIPTRANSPARENT);
      if(child==IntPtr.Zero || child==current) break;
      current=child;
    }
    return current;
  }
  static IntPtr PointParam(IntPtr target,int screenX,int screenY) {
    POINT point=new POINT { X=screenX, Y=screenY }; ScreenToClient(target,ref point);
    return (IntPtr)((point.X&0xffff)|((point.Y&0xffff)<<16));
  }
  static bool PostButton(IntPtr target,int button,bool down,IntPtr point) {
    uint message=button==0?(down?WM_LBUTTONDOWN:WM_LBUTTONUP):button==1?(down?WM_MBUTTONDOWN:WM_MBUTTONUP):button==2?(down?WM_RBUTTONDOWN:WM_RBUTTONUP):(down?WM_XBUTTONDOWN:WM_XBUTTONUP);
    uint state=down?(button==0?1u:button==2?2u:button==1?16u:0u):0u;
    if(button>2) state|=(uint)(button==3?1:2)<<16;
    return PostMessage(target,message,(IntPtr)(long)state,point);
  }
  static IntPtr InputTarget(IntPtr root) {
    IntPtr best=IntPtr.Zero; long bestScore=-1;
    EnumChildWindows(root,(h,p)=>{
      RECT rect; if(!GetClientRect(h,out rect)) return true;
      long width=Math.Max(0,rect.Right-rect.Left), height=Math.Max(0,rect.Bottom-rect.Top), area=width*height;
      if(area<10000) return true;
      var name=new StringBuilder(256); GetClassName(h,name,name.Capacity); string className=name.ToString();
      long score=area+(className.IndexOf("Chrome_RenderWidgetHostHWND",StringComparison.OrdinalIgnoreCase)>=0?1000000000L:0L);
      if(score>bestScore) { bestScore=score; best=h; }
      return true;
    },IntPtr.Zero);
    return best==IntPtr.Zero?root:best;
  }
  public static bool PostMouse(IntPtr root,double normalizedX,double normalizedY,int button,string action,int delta) {
    IntPtr target=InputTarget(root); if(target==IntPtr.Zero) return false;
    RECT client; if(!GetClientRect(target,out client)) return false;
    int width=Math.Max(1,client.Right-client.Left), height=Math.Max(1,client.Bottom-client.Top);
    int clientX=(int)Math.Round(Math.Max(0,Math.Min(1,normalizedX))*(width-1));
    int clientY=(int)Math.Round(Math.Max(0,Math.Min(1,normalizedY))*(height-1));
    IntPtr point=(IntPtr)((clientX&0xffff)|((clientY&0xffff)<<16));
    if(action=="move") return PostMessage(target,WM_MOUSEMOVE,IntPtr.Zero,point);
    if(action=="down") return PostButton(target,button,true,point);
    if(action=="up") return PostButton(target,button,false,point);
    if(action=="click") return PostButton(target,button,true,point) && PostButton(target,button,false,point);
    if(action=="doubleclick") { bool first=PostButton(target,button,true,point)&&PostButton(target,button,false,point); System.Threading.Thread.Sleep(40); return first&&PostButton(target,button,true,point)&&PostButton(target,button,false,point); }
    if(action=="wheel") { uint wheelData=((uint)(delta&0xffff))<<16; return PostMessage(target,WM_MOUSEWHEEL,(IntPtr)(long)wheelData,point); }
    return false;
  }
  public static bool PostKey(IntPtr root,ushort vk,bool up) { IntPtr target=InputTarget(root); return PostMessage(target,up?WM_KEYUP:WM_KEYDOWN,(IntPtr)(long)vk,(IntPtr)(long)(up?0xC0000001u:1u)); }
}
"@
$cachedHandle=[IntPtr]::Zero
$cachedLabel=''
$cachedRectHandle=[IntPtr]::Zero
$cachedOuterRect=$null
$cachedClientRect=$null
function Resolve-Target($label,$allowHidden) {
  $rawLabel=([string]$label).Trim()
  $windowMatch=[regex]::Match($rawLabel, '^window:(\d+):')
  if($windowMatch.Success) {
    try {
      $windowHandle=[IntPtr]([Int64]$windowMatch.Groups[1].Value)
      if(($allowHidden -and [CodexInputBridge]::Exists($windowHandle)) -or (-not $allowHidden -and [CodexInputBridge]::Alive($windowHandle))) {
        $script:cachedHandle=$windowHandle
        $script:cachedLabel=$rawLabel
        return $windowHandle
      }
    } catch { }
  }
  $needle=[regex]::Replace($rawLabel, '^(?:window|screen):[^:]*:', '')
  $needle=[regex]::Replace($needle, '^\d+[: ]*', '')
  if($cachedHandle -ne [IntPtr]::Zero -and $cachedLabel -eq $needle -and (($allowHidden -and [CodexInputBridge]::Exists($cachedHandle)) -or (-not $allowHidden -and [CodexInputBridge]::Alive($cachedHandle)))) { return $cachedHandle }
  $h=[CodexInputBridge]::FindWindow($needle,[bool]$allowHidden)
  $script:cachedHandle=$h
  $script:cachedLabel=$needle
  return $h
}
[Console]::Out.WriteLine('{"type":"bridge.ready"}')
[Console]::Out.Flush()
while($line=[Console]::In.ReadLine()) {
  $requestId=''
  $targetFound=$false
  $delivered=$false
  $message=''
  try {
    $m=$line | ConvertFrom-Json
    $requestId=[string]$m.requestId
    $windowMessage=([string]$m.target.delivery -eq 'window-message')
    $h=Resolve-Target $m.target.label $windowMessage
    if($h -ne [IntPtr]::Zero) {
      $targetFound=$true
      $outer=[CodexInputBridge]::WindowRect($h)
      $client=[CodexInputBridge]::ClientScreenRect($h)
      if([CodexInputBridge]::Alive($h)) {
        $script:cachedRectHandle=$h
        $script:cachedOuterRect=$outer
        $script:cachedClientRect=$client
      } elseif($windowMessage -and $script:cachedRectHandle -eq $h -and $null -ne $script:cachedOuterRect -and $null -ne $script:cachedClientRect) {
        $outer=$script:cachedOuterRect
        $client=$script:cachedClientRect
      } elseif($windowMessage) {
        $fallbackWidth=[math]::Max(320,[int]$m.target.width)
        $fallbackHeight=[math]::Max(200,[int]$m.target.height)
        $outer.Left=0; $outer.Top=0; $outer.Right=$fallbackWidth; $outer.Bottom=$fallbackHeight
        $client=$outer
      }
      # Window capture can include the non-client frame or only the client
      # surface. Match the capture dimensions first; this avoids a systematic
      # title-bar offset while still handling browsers that crop the frame.
      $r=$outer
      $targetWidth=[double]$m.target.width
      $targetHeight=[double]$m.target.height
      if($targetWidth -gt 0 -and $targetHeight -gt 0) {
        $bestScore=[double]::MaxValue
        foreach($candidate in @($outer,$client)) {
          $candidateWidth=[double]($candidate.Right-$candidate.Left)
          $candidateHeight=[double]($candidate.Bottom-$candidate.Top)
          if($candidateWidth -le 0 -or $candidateHeight -le 0) { continue }
          $widthError=[math]::Abs($candidateWidth-$targetWidth) / [math]::Max($targetWidth,1)
          $heightError=[math]::Abs($candidateHeight-$targetHeight) / [math]::Max($targetHeight,1)
          $score=$widthError+$heightError
          if($score -lt $bestScore) { $bestScore=$score; $r=$candidate }
        }
      }
    }
    if($m.type -eq 'warmup' -and $h -ne [IntPtr]::Zero) {$delivered=$true}
    elseif($m.type -eq 'mouse' -and $h -ne [IntPtr]::Zero) {
      $x=[int]($r.Left + ([math]::Max(0,($r.Right-$r.Left)-1) * [double]$m.x)); $y=[int]($r.Top + ([math]::Max(0,($r.Bottom-$r.Top)-1) * [double]$m.y))
      $wheel=[int]$m.delta
      if($wheel -ne 0 -and [math]::Abs($wheel) -lt 120) { $wheel=([math]::Sign($wheel) * 120) }
      if($windowMessage) {
        $delivered=[CodexInputBridge]::PostMouse($h,[double]$m.x,[double]$m.y,[int]$m.button,[string]$m.action,$wheel)
      } else {
        [CodexInputBridge]::Focus($h); [CodexInputBridge]::Move($x,$y)
        if($m.action -eq 'move') {$delivered=$true}
        elseif($m.action -eq 'down') {$delivered=([CodexInputBridge]::Button([int]$m.button,$true) -gt 0)}
        elseif($m.action -eq 'up') {$delivered=([CodexInputBridge]::Button([int]$m.button,$false) -gt 0)}
        elseif($m.action -eq 'click') {$a=[CodexInputBridge]::Button([int]$m.button,$true); $b=[CodexInputBridge]::Button([int]$m.button,$false); $delivered=($a -gt 0 -and $b -gt 0)}
        elseif($m.action -eq 'doubleclick') {$a=[CodexInputBridge]::Button([int]$m.button,$true); $b=[CodexInputBridge]::Button([int]$m.button,$false); Start-Sleep -Milliseconds 40; $c=[CodexInputBridge]::Button([int]$m.button,$true); $d=[CodexInputBridge]::Button([int]$m.button,$false); $delivered=($a -gt 0 -and $b -gt 0 -and $c -gt 0 -and $d -gt 0)}
        elseif($m.action -eq 'wheel') {$delivered=([CodexInputBridge]::Wheel($wheel) -gt 0)}
      }
    }
    elseif($m.type -eq 'key' -and $h -ne [IntPtr]::Zero) {
      if($windowMessage -and [int]$m.vk -gt 0) {$delivered=[CodexInputBridge]::PostKey($h,[uint16]$m.vk,$m.phase -eq 'up')}
      else { [CodexInputBridge]::Focus($h); if([int]$m.vk -gt 0) {$delivered=([CodexInputBridge]::Key([uint16]$m.vk, $m.phase -eq 'up') -gt 0)} elseif($m.key.Length -eq 1) {$delivered=([CodexInputBridge]::Unicode($m.key[0], $m.phase -eq 'up') -gt 0)} }
    }
    if(-not $targetFound) {$message='The selected Codex window is not visible.'}
    elseif(-not $delivered) {$message='Windows SendInput did not deliver the event.'}
  } catch { $message=([string]$_.Exception.Message).Substring(0,[math]::Min(300,([string]$_.Exception.Message).Length)) }
  [Console]::Out.WriteLine((@{requestId=$requestId;ok=($targetFound -and $delivered);targetFound=$targetFound;delivered=$delivered;message=$message}|ConvertTo-Json -Compress))
}
`;
}
