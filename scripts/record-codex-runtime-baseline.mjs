#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexRuntimeCompatibility, writeCodexRuntimeBaseline } from '../server/codex-runtime-compatibility.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, '..');
const runtimeRoot = path.resolve(
  process.env.XHS_CODEX_DESKTOP_RUNTIME_DIR
    || path.join(workspaceRoot, 'output', 'codex-desktop-runtime-55d9fb967596'),
);
const baselinePath = path.resolve(
  process.env.XHS_CODEX_RUNTIME_BASELINE_PATH
    || path.join(workspaceRoot, 'output', 'codex-runtimes', 'known-good.json'),
);
const compatibility = createCodexRuntimeCompatibility({ runtimeRoot, baselinePath });
const baseline = await writeCodexRuntimeBaseline({ compatibility, baselinePath });
process.stdout.write(`${JSON.stringify({ baselinePath, baseline }, null, 2)}\n`);
