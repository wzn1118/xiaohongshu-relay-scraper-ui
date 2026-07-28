import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PROFILE_ID = /^[a-f0-9]{16}$/;
const ALLOWED = new Set(['.pdf', '.docx', '.txt', '.md', '.json', '.csv', '.rtf']);

export class ProfileStore {
  constructor({ root, pythonBin, scriptPath, maxFileBytes = 12 * 1024 * 1024 }) {
    this.root = root;
    this.pythonBin = pythonBin;
    this.scriptPath = scriptPath;
    this.maxFileBytes = maxFileBytes;
  }

  async initialize() { await mkdir(this.root, { recursive: true }); }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROFILE_ID.test(entry.name)) continue;
      try { profiles.push(await this.get(entry.name)); } catch { /* incomplete import */ }
    }
    return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id) {
    if (!PROFILE_ID.test(String(id || ''))) throw notFound();
    const file = path.join(this.root, id, 'profile_memory.json');
    try {
      const profile = JSON.parse(await readFile(file, 'utf8'));
      return { id, ...profile };
    } catch (error) {
      if (error.code === 'ENOENT') throw notFound();
      throw error;
    }
  }

  async resolvePath(id) {
    await this.get(id);
    return path.join(this.root, id, 'profile_memory.json');
  }

  async create(body, aiSession) {
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length || files.length > 8) throw validation('Upload between 1 and 8 background files.');
    const id = crypto.randomBytes(8).toString('hex');
    const directory = path.join(this.root, id);
    const sourceDir = path.join(directory, 'sources');
    await mkdir(sourceDir, { recursive: true });
    const paths = [];
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index] || {};
      const original = path.basename(String(item.name || `file-${index + 1}`));
      const extension = path.extname(original).toLowerCase();
      if (!ALLOWED.has(extension)) throw validation(`Unsupported file type: ${extension || 'unknown'}.`);
      let buffer;
      try { buffer = Buffer.from(String(item.base64 || ''), 'base64'); } catch { throw validation(`Invalid file payload: ${original}.`); }
      if (!buffer.length || buffer.length > this.maxFileBytes) throw validation(`File size is invalid: ${original}.`);
      const safeName = `${String(index + 1).padStart(2, '0')}-${original.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`;
      const target = path.join(sourceDir, safeName);
      await writeFile(target, buffer, { flag: 'wx' });
      paths.push(target);
    }
    const output = path.join(directory, 'profile_memory.json');
    const extra = String(body.backgroundText || '').trim();
    const args = [this.scriptPath, '--source-dir', sourceDir, '--output', output, '--profile-id', id];
    if (extra) args.push('--background-text', extra.slice(0, 12000));
    await runChild(this.pythonBin, args, {
      XHS_AI_PROVIDER: aiSession.provider,
      XHS_AI_API_KEY: aiSession.apiKey,
      XHS_AI_BASE_URL: aiSession.baseUrl,
      XHS_AI_MODEL: aiSession.model,
    });
    return this.get(id);
  }
}

function runChild(command, args, envPatch) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.dirname(args[0]),
      env: { ...process.env, ...envPatch, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) return resolve(stdout);
      reject(Object.assign(new Error((stderr || stdout || `Profile parser exited with ${code}`).slice(-1200)), { code: 'PROFILE_IMPORT_FAILED' }));
    });
  });
}

function validation(message) { return Object.assign(new Error(message), { code: 'PROFILE_VALIDATION' }); }
function notFound() { return Object.assign(new Error('Profile not found.'), { code: 'PROFILE_NOT_FOUND' }); }
