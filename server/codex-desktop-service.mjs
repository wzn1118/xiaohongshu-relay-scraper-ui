import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

const FRONTEND_REQUIREMENTS = Object.freeze([
  'resources/app.asar',
  'resources/app-unpacked/package.json',
  'resources/app-unpacked/webview/index.html',
]);

const HOST_REQUIREMENTS = Object.freeze([
  'ChatGPT.exe',
  'chrome.dll',
  'resources.pak',
]);

const BACKEND_REQUIREMENTS = Object.freeze([
  'resources/codex.exe',
  'resources/codex-code-mode-host.exe',
  'resources/codex-command-runner.exe',
  'resources/rg.exe',
  'resources/plugins',
  'resources/skills',
]);

export class CodexDesktopServiceError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = 'CodexDesktopServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexDesktopService(options = {}) {
  return new CodexDesktopService(options);
}

export class CodexDesktopService {
  constructor({
    runtimeRoot,
    workspaceRoot,
    executablePath,
    userDataDirectory,
    spawnProcess = spawn,
    platform = process.platform,
    now = () => new Date(),
  } = {}) {
    this.runtimeRoot = path.resolve(String(runtimeRoot || ''));
    this.workspaceRoot = path.resolve(String(workspaceRoot || ''));
    this.appRoot = path.join(this.runtimeRoot, 'app');
    this.executablePath = path.resolve(executablePath || path.join(this.appRoot, 'ChatGPT.exe'));
    this.userDataDirectory = userDataDirectory ? path.resolve(userDataDirectory) : '';
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.now = now;
    this.lastLaunch = null;
  }

  async status() {
    const manifest = await readJson(path.join(this.runtimeRoot, 'integration-manifest.json'));
    const [frontend, host, backend] = await Promise.all([
      inspectRequirements(this.appRoot, FRONTEND_REQUIREMENTS),
      inspectRequirements(this.appRoot, HOST_REQUIREMENTS),
      inspectRequirements(this.appRoot, BACKEND_REQUIREMENTS),
    ]);
    const executableReady = await pathExists(this.executablePath);
    const supported = this.platform === 'win32';
    return {
      schemaVersion: 1,
      ready: supported && executableReady && frontend.ready && host.ready && backend.ready && Boolean(manifest),
      supported,
      version: String(manifest?.version || ''),
      buildNumber: String(manifest?.buildNumber || ''),
      sourceAsarSha256: String(manifest?.sourceAsarSha256 || ''),
      runtimeRoot: this.runtimeRoot,
      workspaceRoot: this.workspaceRoot,
      executablePath: this.executablePath,
      provisionedAt: manifest?.provisionedAt || null,
      fileCount: Number(manifest?.runtime?.fileCount || 0),
      totalBytes: Number(manifest?.runtime?.totalBytes || 0),
      components: {
        frontend,
        host: { ...host, executableReady },
        backend,
      },
      lastLaunch: this.lastLaunch ? { ...this.lastLaunch } : null,
    };
  }

  async launch() {
    const current = await this.status();
    if (!current.supported) {
      throw new CodexDesktopServiceError(
        'CODEX_DESKTOP_PLATFORM_UNSUPPORTED',
        'The bundled Codex desktop runtime currently requires Windows.',
        409,
      );
    }
    if (!current.ready) {
      throw new CodexDesktopServiceError(
        'CODEX_DESKTOP_RUNTIME_INCOMPLETE',
        'The complete Codex desktop runtime has not been provisioned.',
        503,
        current.components,
      );
    }

    const args = [
      ...(this.userDataDirectory ? [`--user-data-dir=${this.userDataDirectory}`] : []),
      // The portable Electron host treats a following bare path as an app
      // directory before Codex can parse it. The inline form reaches Codex's
      // newThread(path) deep-link parser without changing the app entrypoint.
      `--open-project=${this.workspaceRoot}`,
    ];
    let child;
    try {
      child = this.spawnProcess(this.executablePath, args, {
        cwd: this.appRoot,
        detached: true,
        env: { ...process.env },
        stdio: 'ignore',
        windowsHide: false,
      });
      await waitForSpawn(child);
      child.unref?.();
    } catch (error) {
      throw new CodexDesktopServiceError(
        'CODEX_DESKTOP_LAUNCH_FAILED',
        `Failed to start the complete Codex desktop runtime: ${error?.message || error}`,
        503,
      );
    }

    this.lastLaunch = {
      pid: Number(child.pid || 0) || null,
      launchedAt: this.now().toISOString(),
      workspaceRoot: this.workspaceRoot,
    };
    return {
      launched: true,
      mode: 'native',
      version: current.version,
      buildNumber: current.buildNumber,
      runtimeRoot: this.runtimeRoot,
      executablePath: this.executablePath,
      ...this.lastLaunch,
    };
  }
}

async function inspectRequirements(root, requirements) {
  const missing = [];
  for (const relative of requirements) {
    if (!await pathExists(path.join(root, ...relative.split('/')))) missing.push(relative);
  }
  return { ready: missing.length === 0, missing };
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function waitForSpawn(child) {
  if (!child || typeof child.once !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off?.('error', onError);
      resolve();
    };
    const onError = (error) => {
      child.off?.('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
