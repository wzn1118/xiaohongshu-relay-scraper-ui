import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath =
  process.env.XHS_RUNNER_PATH ||
  path.resolve(serverDir, '..', 'scripts', 'run_project_workflow.py');

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: readPort(process.env.PORT, 4317),
  pythonBin: process.env.PYTHON_BIN || 'python',
  runnerPath,
  runnerAvailable: existsSync(runnerPath),
  staticDir: path.resolve(process.env.XHS_STATIC_DIR || path.join(serverDir, '..', 'dist')),
  dataDir: path.resolve(process.env.XHS_SERVER_DATA_DIR || path.join(serverDir, '..', 'data', 'jobs')),
  profileDir: path.resolve(process.env.XHS_PROFILE_DATA_DIR || path.join(serverDir, '..', 'data', 'profiles')),
  profileScriptPath: path.resolve(serverDir, '..', 'scripts', 'profile_memory.py'),
  legacyProfilePath: path.resolve(serverDir, '..', 'profiles', 'candidate_profile.json'),
  openClawConfigPath:
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json'),
  maxHistory: readInt(process.env.XHS_MAX_HISTORY, 100, 10, 1000),
  maxBodyBytes: readInt(process.env.XHS_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
});

function readPort(value, fallback) {
  return readInt(value, fallback, 1, 65535);
}

function readInt(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
