import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const RUNNING_STATUSES = [
  'snapshotting',
  'waiting_profile_enrichment',
  'collecting_profile_headers',
  'collecting_profile_posts',
  'analyzing_comments',
  'analyzing_users',
  'synthesizing',
  'validating',
  'exporting',
  'cancelling',
];

export class AudienceAiStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.db = null;
  }

  async initialize() {
    if (this.db) return this;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    const now = new Date().toISOString();
    const placeholders = RUNNING_STATUSES.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE analysis_runs
      SET status = 'interrupted', resumable = 1, updated_at = ?,
          error_code = 'AUDIENCE_AI_INTERNAL_ERROR',
          error_message = 'The server restarted before this analysis completed.'
      WHERE status IN (${placeholders})
    `).run(now, ...RUNNING_STATUSES);
    return this;
  }

  createRun(value) {
    this.#required();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingByIdempotency = this.db.prepare('SELECT * FROM analysis_runs WHERE idempotency_key = ?').get(value.idempotencyKey);
      if (existingByIdempotency) {
        const run = publicRun(existingByIdempotency);
        if (
          run.configHash !== value.configHash
          || run.inputRevision !== value.inputRevision
          || run.jobId !== value.jobId
          || run.postId !== value.postId
        ) {
          throw storeError('AUDIENCE_AI_REVISION_CONFLICT', 'The idempotency key was already used with different analysis settings.', run);
        }
        this.db.exec('COMMIT');
        return { run, reused: true };
      }
      const existingSemantic = this.db.prepare('SELECT * FROM analysis_runs WHERE semantic_key = ?').get(value.semanticKey);
      if (existingSemantic) {
        this.db.exec('COMMIT');
        return { run: publicRun(existingSemantic), reused: true };
      }
      const active = this.db.prepare(`SELECT * FROM analysis_runs WHERE job_id = ? AND post_id = ? AND status IN (${RUNNING_STATUSES.map(() => '?').join(',')})`).get(value.jobId, value.postId, ...RUNNING_STATUSES);
      if (active) throw storeError('AUDIENCE_AI_ALREADY_RUNNING', 'This post already has an active audience AI analysis.', publicRun(active));
      this.db.prepare(`
        INSERT INTO analysis_runs (
          run_id, job_id, post_id, status, profile_mode, modules_json, output_language,
          model_provider, model_id, wire_api, prompt_version, schema_version,
          input_revision, idempotency_key, semantic_key, config_hash, config_json,
          snapshot_path, output_dir, coverage_json, progress_json,
          created_at, started_at, updated_at, resumable, estimated_usage
        ) VALUES (?, ?, ?, 'snapshotting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).run(
        value.runId,
        value.jobId,
        value.postId,
        value.profileMode,
        JSON.stringify(value.modules),
        value.outputLanguage,
        value.model.provider || null,
        value.model.model || null,
        value.model.wireApi || null,
        value.promptVersion,
        value.schemaVersion,
        value.inputRevision,
        value.idempotencyKey,
        value.semanticKey,
        value.configHash,
        JSON.stringify(value.config),
        value.snapshotPath,
        value.outputDir,
        JSON.stringify(value.coverage || {}),
        JSON.stringify(emptyProgress(value.postId, value.runId, 'snapshotting')),
        value.createdAt,
        value.createdAt,
        value.createdAt,
      );
      this.db.prepare(`
        INSERT INTO analysis_versions (job_id, post_id, run_id, input_revision, created_at, is_active)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(value.jobId, value.postId, value.runId, value.inputRevision, value.createdAt);
      const run = this.getRun(value.runId);
      this.db.exec('COMMIT');
      return { run, reused: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  saveSnapshot(value) {
    this.#required();
    this.db.prepare(`
      INSERT OR REPLACE INTO input_snapshots (
        snapshot_id, run_id, job_id, post_id, input_revision, source_json,
        counts_json, hash_manifest_json, snapshot_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.snapshotId,
      value.runId,
      value.jobId,
      value.postId,
      value.inputRevision,
      JSON.stringify(value.source || {}),
      JSON.stringify(value.coverage || {}),
      JSON.stringify(value.hashManifest || {}),
      value.snapshotPath,
      value.createdAt,
    );
  }

  replaceSnapshot(value) {
    this.#required();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveSnapshot(value);
      this.db.prepare(`
        UPDATE analysis_runs
        SET input_revision = ?, semantic_key = COALESCE(?, semantic_key), coverage_json = ?, updated_at = ?
        WHERE run_id = ?
      `).run(value.inputRevision, value.semanticKey || null, JSON.stringify(value.coverage || {}), value.createdAt, value.runId);
      this.db.prepare(`
        UPDATE analysis_versions SET input_revision = ? WHERE run_id = ?
      `).run(value.inputRevision, value.runId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
    return this.getSnapshot(value.runId);
  }

  getRun(runId) {
    this.#required();
    const row = this.db.prepare('SELECT * FROM analysis_runs WHERE run_id = ?').get(runId);
    return row ? publicRun(row) : null;
  }

  getRunRuntime(runId) {
    this.#required();
    const row = this.db.prepare('SELECT * FROM analysis_runs WHERE run_id = ?').get(runId);
    if (!row) return null;
    return {
      ...publicRun(row),
      config: parseJson(row.config_json, {}),
      snapshotPath: row.snapshot_path,
      outputDir: row.output_dir,
    };
  }

  getSnapshot(runId) {
    this.#required();
    const row = this.db.prepare('SELECT * FROM input_snapshots WHERE run_id = ?').get(runId);
    if (!row) return null;
    return {
      snapshotId: row.snapshot_id,
      runId: row.run_id,
      jobId: row.job_id,
      postId: row.post_id,
      inputRevision: row.input_revision,
      source: parseJson(row.source_json, {}),
      coverage: parseJson(row.counts_json, {}),
      hashManifest: parseJson(row.hash_manifest_json, {}),
      snapshotPath: row.snapshot_path,
      createdAt: row.created_at,
    };
  }

  listRuns(jobId, postId) {
    this.#required();
    return this.db.prepare('SELECT * FROM analysis_runs WHERE job_id = ? AND post_id = ? ORDER BY created_at DESC').all(jobId, postId).map(publicRun);
  }

  getActiveVersion(jobId, postId) {
    this.#required();
    const row = this.db.prepare(`
      SELECT r.* FROM analysis_versions v
      JOIN analysis_runs r ON r.run_id = v.run_id
      WHERE v.job_id = ? AND v.post_id = ? AND v.is_active = 1
      LIMIT 1
    `).get(jobId, postId);
    return row ? publicRun(row) : null;
  }

  getOverview(jobId, postId) {
    const runs = this.listRuns(jobId, postId);
    return {
      activeVersion: this.getActiveVersion(jobId, postId),
      currentRun: runs.find((run) => RUNNING_STATUSES.includes(run.status)) || null,
      versions: runs,
    };
  }

  updateRun(runId, patch) {
    this.#required();
    const current = this.getRun(runId);
    if (!current) throw storeError('AUDIENCE_AI_POST_NOT_FOUND', 'Audience AI run not found.', { runId });
    const { fields, values } = runPatch(current, patch);
    this.db.prepare(`UPDATE analysis_runs SET ${fields.join(', ')} WHERE run_id = ?`).run(...values, runId);
    return this.getRun(runId);
  }

  transitionRun(runId, expectedStatuses, patch) {
    this.#required();
    const current = this.getRun(runId);
    if (!current) throw storeError('AUDIENCE_AI_POST_NOT_FOUND', 'Audience AI run not found.', { runId });
    const expected = [...new Set(expectedStatuses || [])].filter(Boolean);
    if (!expected.includes(current.status)) return { changed: false, run: current };
    const { fields, values } = runPatch(current, patch);
    const placeholders = expected.map(() => '?').join(',');
    const result = this.db.prepare(`
      UPDATE analysis_runs SET ${fields.join(', ')}
      WHERE run_id = ? AND status IN (${placeholders})
    `).run(...values, runId, ...expected);
    return { changed: Number(result.changes) === 1, run: this.getRun(runId) };
  }

  setRunStale(runId, stale) {
    this.#required();
    const result = this.db.prepare(`
      UPDATE analysis_runs SET stale = ?, updated_at = ? WHERE run_id = ? AND stale <> ?
    `).run(stale ? 1 : 0, new Date().toISOString(), runId, stale ? 1 : 0);
    return { changed: Number(result.changes) === 1, run: this.getRun(runId) };
  }

  listActiveRuns(jobId) {
    this.#required();
    const placeholders = RUNNING_STATUSES.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM analysis_runs WHERE job_id = ? AND status IN (${placeholders})
      ORDER BY created_at ASC
    `).all(jobId, ...RUNNING_STATUSES).map(publicRun);
  }

  hasActiveRuns(jobId) {
    return this.listActiveRuns(jobId).length > 0;
  }

  getLatestEventSequence(jobId, postId) {
    this.#required();
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM run_events WHERE job_id = ? AND post_id = ?
    `).get(jobId, postId);
    return Number(row?.sequence || 0);
  }

  listEvents(jobId, postId, afterSequence = 0, limit = 500, throughSequence = Number.MAX_SAFE_INTEGER) {
    this.#required();
    const pageSize = Math.max(1, Math.min(1_000, Number(limit) || 500));
    return this.db.prepare(`
      SELECT sequence, run_id, job_id, post_id, event_type, event_json, created_at
      FROM run_events
      WHERE job_id = ? AND post_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC LIMIT ?
    `).all(jobId, postId, afterSequence, throughSequence, pageSize).map((row) => ({
      sequence: Number(row.sequence),
      runId: row.run_id,
      jobId: row.job_id,
      postId: row.post_id,
      type: row.event_type,
      data: parseJson(row.event_json, {}),
      createdAt: row.created_at,
    }));
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  activateVersion(runId) {
    this.#required();
    const run = this.getRun(runId);
    if (!run || run.status !== 'completed') {
      throw storeError('AUDIENCE_AI_SCHEMA_INVALID', 'Only a validated completed run can become the active version.', { runId });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE analysis_versions SET is_active = 0 WHERE job_id = ? AND post_id = ?').run(run.jobId, run.postId);
      this.db.prepare('UPDATE analysis_versions SET is_active = 1, activated_at = ? WHERE run_id = ?')
        .run(new Date().toISOString(), runId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
    return this.getActiveVersion(run.jobId, run.postId);
  }

  replaceMaterialization(runId, { chunks = [], comments = [], threads = [], users = [], evidence = [] }) {
    this.#required();
    if (!this.getRun(runId)) throw storeError('AUDIENCE_AI_POST_NOT_FOUND', 'Audience AI run not found.', { runId });
    const createdAt = new Date().toISOString();
    const insights = [
      ...comments.map((value) => ({ entityType: 'comment', entityId: value.commentId, value })),
      ...threads.map((value) => ({ entityType: 'thread', entityId: value.rootThreadId, value })),
      ...users.map((value) => ({ entityType: 'user', entityId: value.userId, value })),
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM analysis_chunks WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM entity_insights WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM evidence_refs WHERE run_id = ?').run(runId);
      const insertChunk = this.db.prepare(`
        INSERT INTO analysis_chunks (
          chunk_id, run_id, kind, entity_ids_json, input_hash, status,
          attempt_count, output_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        insertChunk.run(
          `${runId}:${chunk.chunkId}`,
          runId,
          chunk.kind,
          JSON.stringify(chunk.entityIds || []),
          chunk.inputHash,
          chunk.status,
          Number(chunk.attemptCount || 0),
          chunk.outputHash || null,
          chunk.completedAt || createdAt,
        );
      }
      const insertInsight = this.db.prepare(`
        INSERT INTO entity_insights (
          insight_id, run_id, entity_type, entity_id, insight_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const insight of insights) {
        insertInsight.run(
          `${runId}:${insight.entityType}:${insight.entityId}`,
          runId,
          insight.entityType,
          insight.entityId,
          JSON.stringify(insight.value),
          createdAt,
        );
      }
      const insertEvidence = this.db.prepare(`
        INSERT INTO evidence_refs (
          evidence_id, run_id, entity_type, entity_id, evidence_json, validated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of evidence) {
        insertEvidence.run(
          `${runId}:${item.evidenceId}`,
          runId,
          item.entityType || 'unknown',
          item.entityId || '',
          JSON.stringify(item),
          1,
          createdAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
    return this.getMaterialization(runId);
  }

  getMaterialization(runId) {
    this.#required();
    return {
      chunks: this.db.prepare(`
        SELECT kind, entity_ids_json, input_hash, status, attempt_count,
               output_hash, error_code, error_message, started_at, completed_at
        FROM analysis_chunks WHERE run_id = ? ORDER BY chunk_id
      `).all(runId).map((row) => ({
        kind: row.kind,
        entityIds: parseJson(row.entity_ids_json, []),
        inputHash: row.input_hash,
        status: row.status,
        attemptCount: Number(row.attempt_count),
        outputHash: row.output_hash || null,
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
      })),
      insights: this.db.prepare(`
        SELECT entity_type, entity_id, insight_json, created_at
        FROM entity_insights WHERE run_id = ? ORDER BY entity_type, entity_id
      `).all(runId).map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        value: parseJson(row.insight_json, {}),
        createdAt: row.created_at,
      })),
      evidence: this.db.prepare(`
        SELECT entity_type, entity_id, evidence_json, validated, created_at
        FROM evidence_refs WHERE run_id = ? ORDER BY evidence_id
      `).all(runId).map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        value: parseJson(row.evidence_json, {}),
        validated: Boolean(row.validated),
        createdAt: row.created_at,
      })),
    };
  }

  appendEvent(runId, type, data = {}) {
    this.#required();
    const run = this.getRun(runId);
    if (!run) throw storeError('AUDIENCE_AI_POST_NOT_FOUND', 'Audience AI run not found.', { runId });
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO run_events (run_id, job_id, post_id, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, run.jobId, run.postId, type, JSON.stringify(data), createdAt);
    return {
      sequence: Number(result.lastInsertRowid),
      runId,
      jobId: run.jobId,
      postId: run.postId,
      type,
      data,
      createdAt,
    };
  }

  #migrate() {
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version || 0);
    if (current > SCHEMA_VERSION) throw storeError('AUDIENCE_AI_INTERNAL_ERROR', 'Audience AI state schema is newer than this application.');
    if (current < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS analysis_runs (
          run_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          status TEXT NOT NULL,
          profile_mode TEXT NOT NULL,
          modules_json TEXT NOT NULL,
          output_language TEXT NOT NULL,
          model_provider TEXT,
          model_id TEXT,
          wire_api TEXT,
          prompt_version TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          input_revision TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          semantic_key TEXT NOT NULL UNIQUE,
          config_hash TEXT NOT NULL,
          config_json TEXT NOT NULL,
          snapshot_path TEXT NOT NULL,
          output_dir TEXT NOT NULL,
          coverage_json TEXT NOT NULL DEFAULT '{}',
          progress_json TEXT NOT NULL DEFAULT '{}',
          token_usage_json TEXT NOT NULL DEFAULT '{}',
          cost REAL,
          estimated_usage INTEGER NOT NULL DEFAULT 1,
          resumable INTEGER NOT NULL DEFAULT 1,
          stale INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          cancelled_at TEXT
        );
        CREATE INDEX IF NOT EXISTS analysis_runs_post_created_idx ON analysis_runs(job_id, post_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_one_active_post_idx
          ON analysis_runs(job_id, post_id)
          WHERE status IN (
            'snapshotting', 'waiting_profile_enrichment', 'collecting_profile_headers',
            'collecting_profile_posts', 'analyzing_comments', 'analyzing_users',
            'synthesizing', 'validating', 'exporting', 'cancelling'
          );

        CREATE TABLE IF NOT EXISTS input_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          input_revision TEXT NOT NULL,
          source_json TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          hash_manifest_json TEXT NOT NULL,
          snapshot_path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS analysis_chunks (
          chunk_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          entity_ids_json TEXT NOT NULL DEFAULT '[]',
          input_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          output_hash TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS entity_insights (
          insight_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          insight_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS evidence_refs (
          evidence_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          validated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_events_post_sequence_idx ON run_events(job_id, post_id, sequence);

        CREATE TABLE IF NOT EXISTS analysis_versions (
          job_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
          input_revision TEXT NOT NULL,
          created_at TEXT NOT NULL,
          activated_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_id, post_id, run_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_active_idx
          ON analysis_versions(job_id, post_id) WHERE is_active = 1;
        PRAGMA user_version = 1;
      `);
    }
  }

  #required() {
    if (!this.db) throw storeError('AUDIENCE_AI_INTERNAL_ERROR', 'Audience AI state store is not initialized.');
  }
}

function runPatch(current, patch) {
  const fields = [];
  const values = [];
  const add = (column, value) => { fields.push(`${column} = ?`); values.push(value); };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.progress !== undefined) add('progress_json', JSON.stringify({ ...current.progress, ...patch.progress }));
  if (patch.coverage !== undefined) add('coverage_json', JSON.stringify(patch.coverage));
  if (patch.resumable !== undefined) add('resumable', patch.resumable ? 1 : 0);
  if (patch.errorCode !== undefined) add('error_code', patch.errorCode || null);
  if (patch.errorMessage !== undefined) add('error_message', sanitizeErrorMessage(patch.errorMessage));
  if (patch.tokenUsage !== undefined) add('token_usage_json', JSON.stringify(patch.tokenUsage || {}));
  if (patch.cost !== undefined) add('cost', Number.isFinite(Number(patch.cost)) ? Number(patch.cost) : null);
  if (patch.estimatedUsage !== undefined) add('estimated_usage', patch.estimatedUsage ? 1 : 0);
  if (patch.completedAt !== undefined) add('completed_at', patch.completedAt || null);
  if (patch.cancelledAt !== undefined) add('cancelled_at', patch.cancelledAt || null);
  if (patch.stale !== undefined) add('stale', patch.stale ? 1 : 0);
  add('updated_at', patch.updatedAt || new Date().toISOString());
  return { fields, values };
}

function publicRun(row) {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    postId: row.post_id,
    status: row.status,
    profileMode: row.profile_mode,
    modules: parseJson(row.modules_json, []),
    outputLanguage: row.output_language,
    model: { provider: row.model_provider, model: row.model_id, wireApi: row.wire_api },
    promptVersion: row.prompt_version,
    schemaVersion: Number(row.schema_version),
    inputRevision: row.input_revision,
    configHash: row.config_hash,
    coverage: parseJson(row.coverage_json, {}),
    progress: parseJson(row.progress_json, {}),
    tokenUsage: parseJson(row.token_usage_json, {}),
    cost: row.cost === null ? null : Number(row.cost),
    estimatedUsage: Boolean(row.estimated_usage),
    resumable: Boolean(row.resumable),
    stale: Boolean(row.stale),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

function emptyProgress(postId, runId, stage) {
  return {
    runId,
    postId,
    stage,
    completedUnits: 0,
    totalUnits: 0,
    commentsAnalyzed: 0,
    usersAnalyzed: 0,
    profilesUsed: 0,
    tokenUsage: {},
    estimatedUsage: true,
    updatedAt: new Date().toISOString(),
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function sanitizeErrorMessage(value) {
  return String(value || '').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/giu, '[redacted]').slice(0, 1_000) || null;
}

function storeError(code, message, context = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, context);
  return error;
}

export const AUDIENCE_AI_RUNNING_STATUSES = Object.freeze([...RUNNING_STATUSES]);
