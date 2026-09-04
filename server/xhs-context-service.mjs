import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';

const TEXT_EXTENSIONS = new Set(['.csv', '.html', '.json', '.jsonl', '.log', '.md', '.text', '.txt']);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const TOKEN_PATTERN = /[A-Za-z0-9_]+|[\u4e00-\u9fff]/gu;

export class XhsContextServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'XhsContextServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class XhsContextService {
  constructor({ rootDir, now = () => new Date(), token = '' } = {}) {
    if (!rootDir) throw new TypeError('Xhs context root directory is required.');
    this.rootDir = path.resolve(rootDir);
    this.bundleDir = path.join(this.rootDir, 'bundles');
    this.chunkDir = path.join(this.rootDir, 'chunks');
    this.indexPath = path.join(this.rootDir, 'index.sqlite');
    this.tokenPath = path.join(this.rootDir, 'local-token');
    this.now = now;
    this.localToken = token || loadOrCreateToken(this.tokenPath);
    mkdirSync(this.rootDir, { recursive: true });
    this.database = new DatabaseSync(this.indexPath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bundles (
        bundle_id TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        manifest_hash TEXT NOT NULL UNIQUE,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        index_mode TEXT NOT NULL DEFAULT 'token-index'
      );
      CREATE TABLE IF NOT EXISTS records (
        record_id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        source_path TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (bundle_id) REFERENCES bundles(bundle_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS records_bundle ON records(bundle_id);
      CREATE TABLE IF NOT EXISTS record_tokens (
        token TEXT NOT NULL,
        record_id TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (token, record_id),
        FOREIGN KEY (record_id) REFERENCES records(record_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS record_tokens_record ON record_tokens(record_id);
    `);
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  status() {
    const counts = this.database
      ? this.database.prepare('SELECT COUNT(*) AS bundles, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(record_count), 0) AS records FROM bundles').get()
      : { bundles: 0, bytes: 0, records: 0 };
    return {
      schemaVersion: 1,
      service: 'xhs-context',
      rootDir: this.rootDir,
      transport: 'loopback-http',
      localOnly: true,
      indexMode: 'token-index',
      fts5Available: false,
      bundles: Number(counts?.bundles || 0),
      bytes: Number(counts?.bytes || 0),
      records: Number(counts?.records || 0),
    };
  }

  listBundles() {
    return this.database.prepare(`
      SELECT bundle_id AS bundleId, source_job_id AS sourceJobId, title, manifest_hash AS manifestHash,
        created_at AS createdAt, bytes, file_count AS fileCount, record_count AS recordCount, index_mode AS indexMode
      FROM bundles ORDER BY created_at DESC
    `).all();
  }

  async createBundleFromJob({ jobId, outputDir, title = '' } = {}) {
    const sourceJobId = String(jobId || '').trim();
    const resolvedOutputDir = path.resolve(String(outputDir || '').trim());
    if (!sourceJobId) throw new XhsContextServiceError('XHS_CONTEXT_JOB_REQUIRED', 'A job id is required.');
    if (!resolvedOutputDir || !existsSync(resolvedOutputDir)) {
      throw new XhsContextServiceError('XHS_CONTEXT_OUTPUT_NOT_FOUND', 'The job artifact directory was not found.', 404);
    }
    const files = await enumerateArtifacts(resolvedOutputDir);
    const manifestFiles = [];
    const records = [];
    let totalBytes = 0;
    for (const file of files) {
      const absolute = (await resolveDownload(resolvedOutputDir, file.id)).absolute;
      const info = await stat(absolute);
      const hash = await sha256File(absolute);
      const ext = path.extname(file.path).toLowerCase();
      const textEligible = TEXT_EXTENSIONS.has(ext) && info.size <= MAX_TEXT_BYTES;
      const entry = {
        path: file.path,
        sha256: hash,
        size: info.size,
        mimeType: mimeTypeFor(ext),
        mode: textEligible ? 'eager' : 'lazy',
        chunkHash: textEligible ? hash : null,
      };
      manifestFiles.push(entry);
      totalBytes += info.size;
      if (textEligible) {
        const content = await readFile(absolute, 'utf8');
        await this.#storeChunk(hash, Buffer.from(content, 'utf8'));
        records.push(...extractRecords(content, file.path, hash, sourceJobId));
      }
    }
    const manifestBase = {
      schemaVersion: 2,
      source: { type: 'job-artifacts', jobId: sourceJobId },
      sync: { compression: 'none', resumable: true, indexMode: 'token-index' },
      files: manifestFiles,
      records: records.map((record, ordinal) => ({
        ordinal,
        sourcePath: record.sourcePath,
        title: record.title,
        contentHash: record.contentHash,
      })),
    };
    const manifestHash = sha256Text(canonicalJson(manifestBase));
    const bundleId = `bundle-${manifestHash.slice(0, 24)}`;
    const indexedRecords = records.map((record) => ({
      ...record,
      recordId: `${bundleId}:${record.recordId}`,
    }));
    const manifest = {
      ...manifestBase,
      records: manifestBase.records.map((record, index) => ({
        ...record,
        recordId: indexedRecords[index].recordId,
      })),
      bundleId,
      manifestHash,
      title: String(title || '').trim() || `Job ${sourceJobId}`,
      createdAt: this.#nowIso(),
    };
    const existing = this.database.prepare('SELECT bundle_id AS bundleId FROM bundles WHERE manifest_hash = ?').get(manifestHash);
    if (existing) return this.overview(existing.bundleId);
    await mkdir(path.join(this.bundleDir, bundleId), { recursive: true });
    await writeFile(path.join(this.bundleDir, bundleId, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
    this.database.exec('BEGIN');
    try {
      this.database.prepare(`
        INSERT INTO bundles (bundle_id, source_job_id, title, manifest_hash, manifest_json, created_at, bytes, file_count, record_count, index_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(bundleId, sourceJobId, manifest.title, manifestHash, JSON.stringify(manifest), manifest.createdAt, totalBytes, manifestFiles.length, indexedRecords.length, 'token-index');
      const recordInsert = this.database.prepare(`
        INSERT INTO records (record_id, bundle_id, title, body, source_path, content_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const tokenInsert = this.database.prepare('INSERT INTO record_tokens (token, record_id, occurrences) VALUES (?, ?, ?)');
      for (const record of indexedRecords) {
        recordInsert.run(record.recordId, bundleId, record.title, record.body, record.sourcePath, record.contentHash, JSON.stringify(record.metadata));
        for (const [token, occurrences] of tokenCounts(`${record.title}\n${record.body}`)) tokenInsert.run(token, record.recordId, occurrences);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.overview(bundleId);
  }

  overview(bundleId) {
    const bundle = this.database.prepare('SELECT * FROM bundles WHERE bundle_id = ?').get(String(bundleId || ''));
    if (!bundle) throw new XhsContextServiceError('XHS_CONTEXT_BUNDLE_NOT_FOUND', 'The context bundle was not found.', 404);
    const manifest = JSON.parse(bundle.manifest_json);
    return {
      bundleId: bundle.bundle_id,
      sourceJobId: bundle.source_job_id,
      title: bundle.title,
      manifestHash: bundle.manifest_hash,
      createdAt: bundle.created_at,
      bytes: Number(bundle.bytes),
      fileCount: Number(bundle.file_count),
      recordCount: Number(bundle.record_count),
      indexMode: bundle.index_mode,
      files: manifest.files,
      records: manifest.records,
    };
  }

  search(bundleId, query, { limit = 20 } = {}) {
    const id = String(bundleId || '');
    this.#assertBundle(id);
    const terms = [...new Set(tokenize(String(query || '')))].slice(0, 32);
    if (!terms.length) return { bundleId: id, query: String(query || ''), results: [], indexMode: 'token-index' };
    const placeholders = terms.map(() => '?').join(', ');
    const rows = this.database.prepare(`
      SELECT r.record_id AS recordId, r.title, r.source_path AS sourcePath, r.content_hash AS contentHash,
        SUM(rt.occurrences) AS score
      FROM records r JOIN record_tokens rt ON rt.record_id = r.record_id
      WHERE r.bundle_id = ? AND rt.token IN (${placeholders})
      GROUP BY r.record_id ORDER BY score DESC, r.title ASC LIMIT ?
    `).all(id, ...terms, Math.min(100, Math.max(1, Number(limit) || 20)));
    return { bundleId: id, query: String(query || ''), terms, indexMode: 'token-index', results: rows.map((row) => ({ ...row, score: Number(row.score || 0) })) };
  }

  openRecord(recordId) {
    const row = this.database.prepare(`
      SELECT record_id AS recordId, bundle_id AS bundleId, title, body, source_path AS sourcePath,
        content_hash AS contentHash, metadata_json AS metadataJson FROM records WHERE record_id = ?
    `).get(String(recordId || ''));
    if (!row) throw new XhsContextServiceError('XHS_CONTEXT_RECORD_NOT_FOUND', 'The context record was not found.', 404);
    return { recordId: row.recordId, bundleId: row.bundleId, title: row.title, body: row.body, sourcePath: row.sourcePath, contentHash: row.contentHash, metadata: JSON.parse(row.metadataJson || '{}') };
  }

  async readArtifact(bundleId, relativePath, { maxBytes = MAX_TEXT_BYTES } = {}) {
    const bundle = this.#bundleManifest(bundleId);
    const normalized = normalizeRelativePath(relativePath);
    const entry = bundle.files.find((item) => item.path === normalized);
    if (!entry) throw new XhsContextServiceError('XHS_CONTEXT_ARTIFACT_NOT_FOUND', 'The context artifact was not found.', 404);
    if (entry.mode !== 'eager' || !entry.chunkHash) return { bundleId: String(bundleId), path: normalized, mode: 'lazy', size: entry.size, sha256: entry.sha256, content: null };
    if (entry.size > maxBytes) throw new XhsContextServiceError('XHS_CONTEXT_ARTIFACT_TOO_LARGE', 'The context artifact exceeds the read limit.', 413);
    const bytes = await readFile(path.join(this.chunkDir, entry.chunkHash));
    const actualHash = sha256Bytes(bytes);
    if (actualHash !== entry.sha256) throw new XhsContextServiceError('XHS_CONTEXT_INTEGRITY_FAILED', 'The cached context chunk failed integrity verification.', 409, { path: normalized });
    return { bundleId: String(bundleId), path: normalized, mode: 'eager', size: bytes.length, sha256: actualHash, content: bytes.toString('utf8') };
  }

  aggregate(bundleId, { field = '', limit = 50 } = {}) {
    const id = String(bundleId || '');
    this.#assertBundle(id);
    const rows = this.database.prepare('SELECT metadata_json AS metadataJson FROM records WHERE bundle_id = ?').all(id);
    const key = String(field || '').trim();
    if (!key) return { bundleId: id, records: rows.length, groups: [] };
    const counts = new Map();
    for (const row of rows) {
      const value = JSON.parse(row.metadataJson || '{}')[key];
      const label = value == null || value === '' ? '(empty)' : String(value);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return { bundleId: id, field: key, groups: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.min(100, Math.max(1, Number(limit) || 50))).map(([value, count]) => ({ value, count })) };
  }

  cite(bundleId, recordIds = []) {
    const id = String(bundleId || '');
    this.#assertBundle(id);
    const ids = Array.isArray(recordIds) ? recordIds.map(String).slice(0, 100) : [];
    const citations = ids.map((recordId) => this.openRecord(recordId)).filter((record) => record.bundleId === id).map((record) => ({ recordId: record.recordId, title: record.title, sourcePath: record.sourcePath, contentHash: record.contentHash, citation: `[${record.title || record.recordId}](xhs-context://${id}/${encodeURIComponent(record.recordId)})` }));
    return { bundleId: id, citations };
  }

  verify(bundleId) {
    const manifest = this.#bundleManifest(bundleId);
    const errors = [];
    for (const file of manifest.files) {
      if (!file.chunkHash) continue;
      const chunkPath = path.join(this.chunkDir, file.chunkHash);
      if (!existsSync(chunkPath)) { errors.push({ path: file.path, code: 'CHUNK_MISSING' }); continue; }
      const actual = sha256Bytes(readFileSync(chunkPath));
      if (actual !== file.sha256) errors.push({ path: file.path, code: 'CHUNK_HASH_MISMATCH', expected: file.sha256, actual });
    }
    const expectedManifestHash = sha256Text(canonicalJson(stripManifestIdentity(manifest)));
    if (expectedManifestHash !== manifest.manifestHash) errors.push({ code: 'MANIFEST_HASH_MISMATCH', expected: manifest.manifestHash, actual: expectedManifestHash });
    return { bundleId: String(bundleId), verified: errors.length === 0, errors, checkedAt: this.#nowIso() };
  }

  async handleMcpRequest(body) {
    const request = body && typeof body === 'object' ? body : {};
    const id = request.id ?? null;
    if (request.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'xhs-context', version: '1.0.0' } } };
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
    if (request.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (request.method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    if (request.method !== 'tools/call') throw new XhsContextServiceError('XHS_CONTEXT_MCP_METHOD_NOT_FOUND', 'The xhs-context MCP method was not found.', 400);
    const name = String(request.params?.name || '');
    const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
    const value = await this.callTool(name, args);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } };
  }

  async callTool(name, args = {}) {
    switch (String(name || '')) {
      case 'list_bundles': return { bundles: this.listBundles() };
      case 'overview': return this.overview(args.bundleId);
      case 'search': return this.search(args.bundleId, args.query, args);
      case 'open_record': return this.openRecord(args.recordId);
      case 'read_artifact': return this.readArtifact(args.bundleId, args.path, args);
      case 'aggregate': return this.aggregate(args.bundleId, args);
      case 'cite': return this.cite(args.bundleId, args.recordIds);
      case 'verify': return this.verify(args.bundleId);
      default: throw new XhsContextServiceError('XHS_CONTEXT_TOOL_NOT_FOUND', `Unknown xhs-context tool: ${name}`, 404);
    }
  }

  authorizeHttp(req, token) {
    if (!isLoopbackAddress(req?.socket?.remoteAddress) || !isLoopbackHost(req?.headers?.host)) throw new XhsContextServiceError('XHS_CONTEXT_LOOPBACK_ONLY', 'xhs-context accepts loopback requests only.', 403);
    if (!safeEqualSecret(this.localToken, String(token || ''))) throw new XhsContextServiceError('XHS_CONTEXT_TOKEN_INVALID', 'The xhs-context local token is invalid.', 401);
  }

  #assertBundle(bundleId) {
    if (!this.database.prepare('SELECT 1 FROM bundles WHERE bundle_id = ?').get(String(bundleId || ''))) throw new XhsContextServiceError('XHS_CONTEXT_BUNDLE_NOT_FOUND', 'The context bundle was not found.', 404);
  }

  #bundleManifest(bundleId) {
    const row = this.database.prepare('SELECT manifest_json AS manifestJson FROM bundles WHERE bundle_id = ?').get(String(bundleId || ''));
    if (!row) throw new XhsContextServiceError('XHS_CONTEXT_BUNDLE_NOT_FOUND', 'The context bundle was not found.', 404);
    return JSON.parse(row.manifestJson);
  }

  async #storeChunk(hash, bytes) {
    await mkdir(this.chunkDir, { recursive: true });
    const target = path.join(this.chunkDir, hash);
    if (existsSync(target) && sha256Bytes(await readFile(target)) === hash) return;
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rm(target, { force: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #nowIso() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new XhsContextServiceError('XHS_CONTEXT_CLOCK_INVALID', 'The context service clock is invalid.', 500);
    return date.toISOString();
  }
}

export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'list_bundles', description: 'List local immutable context bundles.', inputSchema: { type: 'object', properties: {} } },
  { name: 'overview', description: 'Read a bundle manifest and summary.', inputSchema: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string' } } } },
  { name: 'search', description: 'Search local bundle records using the token index.', inputSchema: { type: 'object', required: ['bundleId', 'query'], properties: { bundleId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'open_record', description: 'Open one indexed source record.', inputSchema: { type: 'object', required: ['recordId'], properties: { recordId: { type: 'string' } } } },
  { name: 'read_artifact', description: 'Read an eagerly cached text artifact or inspect a lazy media reference.', inputSchema: { type: 'object', required: ['bundleId', 'path'], properties: { bundleId: { type: 'string' }, path: { type: 'string' }, maxBytes: { type: 'integer' } } } },
  { name: 'aggregate', description: 'Aggregate indexed record metadata.', inputSchema: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string' }, field: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'cite', description: 'Create stable citations for local records.', inputSchema: { type: 'object', required: ['bundleId', 'recordIds'], properties: { bundleId: { type: 'string' }, recordIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'verify', description: 'Verify bundle manifest and cached chunk hashes.', inputSchema: { type: 'object', required: ['bundleId'], properties: { bundleId: { type: 'string' } } } },
]);

function extractRecords(content, sourcePath, contentHash, sourceJobId) {
  const recordPrefix = `source:${sha256Text(`${sourceJobId}\u0000${sourcePath}\u0000${contentHash}`)}`;
  const ext = path.extname(sourcePath).toLowerCase();
  const parsed = parseStructuredRecords(content, ext);
  if (!parsed.length) return [{ recordId: recordPrefix, title: path.basename(sourcePath), body: content, sourcePath, contentHash, metadata: { sourcePath } }];
  return parsed.map((value, index) => {
    const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
    const title = firstString(metadata.title, metadata.note_title, metadata.name, metadata.id, metadata.note_id, metadata.post_id) || `${path.basename(sourcePath)} #${index + 1}`;
    return { recordId: `${recordPrefix}:${index + 1}`, title, body: flattenValue(value), sourcePath, contentHash, metadata: { ...metadata, sourcePath } };
  });
}

function parseStructuredRecords(content, ext) {
  if (ext === '.jsonl') return content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => tryJson(line)).filter((value) => value !== null);
  if (ext === '.json') {
    const value = tryJson(content);
    return Array.isArray(value) ? value : value ? [value] : [];
  }
  return [];
}

function tryJson(value) { try { return JSON.parse(value); } catch { return null; } }
function firstString(...values) { return values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''; }
function flattenValue(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function tokenize(value) { return String(value || '').toLocaleLowerCase('zh-CN').match(TOKEN_PATTERN) || []; }
function tokenCounts(value) { const counts = new Map(); for (const token of tokenize(value)) counts.set(token, (counts.get(token) || 0) + 1); return counts; }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function stripManifestIdentity(manifest) {
  const { bundleId, manifestHash, title, createdAt, ...base } = manifest;
  if (Number(base.schemaVersion) >= 2) {
    base.records = base.records.map(({ recordId, ...record }) => record);
  }
  return base;
}
function sha256Bytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256Text(value) { return sha256Bytes(Buffer.from(value, 'utf8')); }
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function mimeTypeFor(ext) { return ({ '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.csv': 'text/csv', '.html': 'text/html', '.md': 'text/markdown', '.log': 'text/plain', '.txt': 'text/plain', '.text': 'text/plain' })[ext] || 'application/octet-stream'; }
function normalizeRelativePath(value) { const normalized = String(value || '').replaceAll('\\', '/'); if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some((part) => part === '..')) throw new XhsContextServiceError('XHS_CONTEXT_PATH_INVALID', 'The artifact path is invalid.', 400); return normalized; }
function loadOrCreateToken(filePath) { try { const token = readFileSync(filePath, 'utf8').trim(); if (token) return token; } catch (error) { if (error.code !== 'ENOENT') throw error; } const token = crypto.randomBytes(32).toString('base64url'); mkdirSync(path.dirname(filePath), { recursive: true }); writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 }); return token; }
function safeEqualSecret(expected, actual) { const a = Buffer.from(String(expected || '')); const b = Buffer.from(String(actual || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function isLoopbackAddress(value) { const normalized = String(value || '').trim().toLowerCase(); return normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.'); }
function isLoopbackHost(value) { try { const host = new URL(`http://${String(value || '').trim()}`).hostname.toLowerCase(); return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'; } catch { return false; } }
