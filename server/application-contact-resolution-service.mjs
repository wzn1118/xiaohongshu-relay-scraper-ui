import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_FILE = 'application-contact-resolution.json';
const CACHE_SCHEMA_VERSION = 2;
const RESOLUTION_ALGORITHM_REVISION = 'body-email-short-circuit:v1';
const SOURCE_FILES = Object.freeze([
  'application_intelligence.checkpoint.json',
  'application_intelligence.json',
  'xiaohongshu_notes_latest.json',
  'xiaohongshu_cards_latest.json',
  'application-contact-ocr.json',
  'delivery-state.json',
  'audience-posts.json',
  'audience-comments.json',
]);

/**
 * Incremental, crash-safe contact resolution. The resolver is deterministic,
 * so a source-file fingerprint is sufficient to avoid repeating full-batch
 * work on every UI poll while still reacting to new OCR/comments checkpoints.
 */
export class ApplicationContactResolutionService {
  constructor({
    loadRecords,
    resolveBatch,
    buildReport,
    now = () => new Date(),
  } = {}) {
    if (typeof loadRecords !== 'function') throw new TypeError('loadRecords is required.');
    if (typeof resolveBatch !== 'function') throw new TypeError('resolveBatch is required.');
    if (typeof buildReport !== 'function') throw new TypeError('buildReport is required.');
    this.loadRecords = loadRecords;
    this.resolveBatch = resolveBatch;
    this.buildReport = buildReport;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async refresh({ outputDir, fallbackOutputDirs = [], task = {}, force = false } = {}) {
    const resolved = path.resolve(String(outputDir || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
      throw new TypeError('outputDir is required.');
    }
    const fallback = uniqueDirectories(fallbackOutputDirs, resolved);
    const sourceSignature = await buildSourceSignature([resolved, ...fallback]);
    const cached = this.cache.get(resolved);
    if (!force && cached?.sourceSignature === sourceSignature) return cached.payload;

    const pending = this.inFlight.get(resolved);
    if (pending) return pending;

    const operation = this.#refresh({
      resolved,
      fallback,
      sourceSignature,
      task,
      force,
    });
    this.inFlight.set(resolved, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(resolved) === operation) this.inFlight.delete(resolved);
    }
  }

  async read(outputDir) {
    const resolved = path.resolve(String(outputDir || ''));
    const cached = this.cache.get(resolved);
    if (cached) return cached.payload;
    const persisted = await readJson(path.join(resolved, CACHE_FILE));
    if (persisted?.schemaVersion === CACHE_SCHEMA_VERSION && persisted?.sourceSignature && persisted.report) {
      this.cache.set(resolved, { sourceSignature: persisted.sourceSignature, payload: persisted });
      return persisted;
    }
    return null;
  }

  async #refresh({ resolved, fallback, sourceSignature, task, force }) {
    const persisted = await readJson(path.join(resolved, CACHE_FILE));
    if (
      !force
      && persisted?.schemaVersion === CACHE_SCHEMA_VERSION
      && persisted?.sourceSignature === sourceSignature
      && persisted.report
    ) {
      this.cache.set(resolved, { sourceSignature, payload: persisted });
      return persisted;
    }

    const records = await this.loadRecords(resolved, task);
    const resolutions = await this.resolveBatch(records, {
      outputDir: resolved,
      fallbackOutputDirs: fallback,
    });
    const report = this.buildReport(records, resolutions);
    const payload = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      sourceSignature,
      outputDir: resolved,
      fallbackOutputDirs: fallback,
      report,
    };
    await writeJsonAtomically(path.join(resolved, CACHE_FILE), payload);
    this.cache.set(resolved, { sourceSignature, payload });
    return payload;
  }
}

async function buildSourceSignature(directories) {
  const parts = [`algorithm|${RESOLUTION_ALGORITHM_REVISION}`];
  for (const directory of directories) {
    for (const filename of SOURCE_FILES) {
      const filePath = path.join(directory, filename);
      try {
        const metadata = await stat(filePath);
        parts.push(`${filePath}|${metadata.mtimeMs}|${metadata.size}`);
      } catch (error) {
        if (error?.code === 'ENOENT') parts.push(`${filePath}|missing`);
        else throw error;
      }
    }
  }
  return parts.join('\n');
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function uniqueDirectories(values, exclude = '') {
  const seen = new Set([path.resolve(exclude)]);
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}
