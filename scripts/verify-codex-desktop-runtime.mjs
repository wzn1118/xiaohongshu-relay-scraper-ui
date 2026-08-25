import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexDesktopService } from '../server/codex-desktop-service.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, '..');
const runtimeRoot = path.resolve(
  process.env.XHS_CODEX_DESKTOP_RUNTIME_DIR
    || path.join(workspaceRoot, 'output', 'codex-desktop-runtime-55d9fb967596'),
);
const service = createCodexDesktopService({ runtimeRoot, workspaceRoot });
const status = await service.status();
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
if (!status.ready) process.exitCode = 1;
