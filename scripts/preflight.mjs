import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const codexHome = process.env.CODEX_HOME || '';
const runnerCandidates = [
  process.env.XHS_UPSTREAM_RUNNER,
  path.join(root, 'vendor', 'xiaohongshu-relay-scrape', 'scripts', 'run_xiaohongshu_relay_scrape.py'),
  codexHome && path.join(codexHome, 'skills', 'xiaohongshu-relay-scrape', 'scripts', 'run_xiaohongshu_relay_scrape.py'),
].filter(Boolean);
const scraperCandidates = [
  process.env.XHS_UPSTREAM_SCRAPER,
  path.join(root, 'vendor', 'xiaohongshu-relay-scrape', 'scripts', 'scrape_xiaohongshu_search.py'),
  codexHome && path.join(codexHome, 'skills', 'xiaohongshu-relay-scrape', 'scripts', 'scrape_xiaohongshu_search.py'),
].filter(Boolean);
const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const checks = {
  node: commandVersion(process.execPath, ['--version']),
  python: commandVersion(python, ['--version']),
  build: fileCheck(path.join(root, 'dist', 'index.html')),
  upstreamRunner: firstFile(runnerCandidates),
  upstreamScraper: firstFile(scraperCandidates),
  builtInAiRuntime: { ok: true, value: 'Python AIProvider with Responses/Chat Completions support' },
  codexCli: commandVersion(process.env.CODEX_CLI_BIN || 'codex', ['--version']),
  openClawConfig: fileCheck(
    process.env.OPENCLAW_CONFIG_PATH
      || path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json'),
  ),
};
const required = ['node', 'python', 'build', 'upstreamRunner', 'upstreamScraper'];
const ready = required.every((key) => checks[key].ok);
console.log(JSON.stringify({ ready, checks }, null, 2));
process.exitCode = ready ? 0 : 2;

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return result.status === 0
    ? { ok: true, value: String(result.stdout || result.stderr).trim() }
    : { ok: false, value: result.error?.message || String(result.stderr || '').trim() || 'not found' };
}

function fileCheck(file) {
  try {
    accessSync(file, constants.R_OK);
    return { ok: true, value: path.resolve(file) };
  } catch {
    return { ok: false, value: path.resolve(file || '.') };
  }
}

function firstFile(candidates) {
  const file = candidates.find((candidate) => existsSync(candidate));
  return file ? { ok: true, value: path.resolve(file) } : { ok: false, value: candidates.map((item) => path.resolve(item)) };
}
