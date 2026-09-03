import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveCodexAppServerCommand({
  workspaceRoot,
  desktopRuntimeRoot,
  executableOverride = process.env.XHS_CODEX_EXECUTABLE,
  nodeExecutable = process.execPath,
  platform = process.platform,
  architecture = process.arch,
  preferBundled = true,
  exists = existsSync,
} = {}) {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const override = String(executableOverride || '').trim();
  if (override) return commandForPath(path.resolve(root, override), nodeExecutable, 'environment');

  if (preferBundled) {
    const native = bundledNativePath(root, platform, architecture);
    if (native && exists(native)) return commandForPath(native, nodeExecutable, 'bundled-native');
    const bundledEntrypoint = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (exists(bundledEntrypoint)) return commandForPath(bundledEntrypoint, nodeExecutable, 'bundled-npm');
  }

  const runtimeRoot = path.resolve(String(desktopRuntimeRoot || path.join(root, 'output', 'codex-desktop-runtime-55d9fb967596')));
  const desktopExecutable = path.join(runtimeRoot, 'app', 'resources', platform === 'win32' ? 'codex.exe' : 'codex');
  return commandForPath(desktopExecutable, nodeExecutable, 'desktop-runtime');
}

function bundledNativePath(root, platform, architecture) {
  const targets = {
    'darwin:arm64': ['darwin-arm64', 'aarch64-apple-darwin', 'codex'],
    'darwin:x64': ['darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'linux:arm64': ['linux-arm64', 'aarch64-unknown-linux-musl', 'codex'],
    'linux:x64': ['linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
    'win32:arm64': ['win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'win32:x64': ['win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
  };
  const target = targets[`${platform}:${architecture}`];
  return target
    ? path.join(root, 'node_modules', '@openai', `codex-${target[0]}`, 'vendor', target[1], 'bin', target[2])
    : null;
}

function commandForPath(executablePath, nodeExecutable, source) {
  if (path.extname(executablePath).toLowerCase() === '.js') {
    return Object.freeze({ executablePath: nodeExecutable, executableArgs: [executablePath], source, resolvedPath: executablePath });
  }
  return Object.freeze({ executablePath, executableArgs: [], source, resolvedPath: executablePath });
}
