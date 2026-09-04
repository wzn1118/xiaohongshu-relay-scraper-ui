import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 4;

export class CopilotProductionStore {
  constructor({ rootDir = 'data', now = () => new Date(), filePath = '' } = {}) {
    this.now = now;
    this.filePath = path.resolve(filePath || path.join(rootDir, 'copilot', 'copilot-state.sqlite'));
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS snapshots (
        job_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, snapshot_id)
      );
      CREATE INDEX IF NOT EXISTS snapshots_job_revision
        ON snapshots(job_id, revision DESC);
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_conversation_created
        ON traces(conversation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS usage_records (
        usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_conversation_time
        ON usage_records(conversation_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        evaluation_id TEXT PRIMARY KEY,
        suite TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_suite_time
        ON evaluation_runs(suite, created_at DESC);
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_ready
        ON outbox(status, available_at);
      CREATE TABLE IF NOT EXISTS worker_leases (
        lease_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'ask',
        status TEXT NOT NULL DEFAULT 'pending',
        contract_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_conversation_created
        ON turns(conversation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS runs_v2 (
        run_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        plan_revision INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        response_id TEXT NOT NULL DEFAULT '',
        previous_response_id TEXT NOT NULL DEFAULT '',
        response_cursor TEXT NOT NULL DEFAULT '',
        background INTEGER NOT NULL DEFAULT 0,
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS runs_v2_conversation_updated
        ON runs_v2(conversation_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS plan_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, revision)
      );
      CREATE TABLE IF NOT EXISTS run_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'analysis',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT NOT NULL DEFAULT 'null',
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT NOT NULL DEFAULT '{}',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS run_nodes_status
        ON run_nodes(run_id, status, node_id);
      CREATE TABLE IF NOT EXISTS node_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT NOT NULL DEFAULT 'null',
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS node_attempts_run_node_attempt
        ON node_attempts(run_id, node_id, attempt);
      CREATE TABLE IF NOT EXISTS context_compactions (
        compaction_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_compactions_conversation
        ON context_compactions(conversation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS context_pins (
        pin_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        value_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, item_type, item_id)
      );
      CREATE TABLE IF NOT EXISTS evidence_claims (
        claim_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_claims_run
        ON evidence_claims(run_id, created_at);
      CREATE TABLE IF NOT EXISTS mcp_grants (
        grant_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT 'Local MCP access',
        owner TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        manifest_hash TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        allowed_resources_json TEXT NOT NULL DEFAULT '[]',
        max_risk TEXT NOT NULL DEFAULT 'approval_required',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT '',
        last_used_at TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS mcp_grants_owner_created
        ON mcp_grants(owner, created_at DESC);
      CREATE INDEX IF NOT EXISTS mcp_grants_conversation_status
        ON mcp_grants(conversation_id, status);
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        session_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'streamable-http',
        status TEXT NOT NULL DEFAULT 'active',
        client_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        closed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS mcp_sessions_grant_status
        ON mcp_sessions(grant_id, status, last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS mcp_tool_runs (
        call_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        action_hash TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT 'null',
        error_json TEXT NOT NULL DEFAULT '{}',
        approval_id TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        UNIQUE(grant_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS mcp_tool_runs_grant_started
        ON mcp_tool_runs(grant_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS mcp_audit (
        audit_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_audit_occurred
        ON mcp_audit(occurred_at DESC);
    `);
    ensureSqliteColumn(this.database, 'mcp_grants', 'token_prefix', "TEXT NOT NULL DEFAULT ''");
    ensureSqliteColumn(this.database, 'mcp_grants', 'name', "TEXT NOT NULL DEFAULT 'Local MCP access'");
    ensureSqliteColumn(this.database, 'mcp_grants', 'manifest_hash', "TEXT NOT NULL DEFAULT ''");
    ensureSqliteColumn(this.database, 'mcp_grants', 'allowed_resources_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureSqliteColumn(this.database, 'mcp_grants', 'max_risk', "TEXT NOT NULL DEFAULT 'approval_required'");
    ensureSqliteColumn(this.database, 'mcp_tool_runs', 'action_hash', "TEXT NOT NULL DEFAULT ''");
    this.database.exec(`
      UPDATE mcp_grants
      SET manifest_hash = COALESCE((
        SELECT snapshots.manifest_hash
        FROM snapshots
        WHERE snapshots.job_id = mcp_grants.job_id
          AND snapshots.snapshot_id = mcp_grants.snapshot_id
      ), '')
      WHERE manifest_hash = '';
    `);
    const appliedAt = this.now().toISOString();
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'legacy-production-state', ?)`).run(appliedAt);
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, 'durable-agent-runtime', ?)`).run(appliedAt);
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, 'mcp-access-plane', ?)`).run(appliedAt);
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (4, 'mcp-grant-snapshot-boundaries', ?)`).run(appliedAt);
  }

  describe() {
    const journalMode = this.database.prepare('PRAGMA journal_mode').get()?.journal_mode || '';
    const schemaVersion = Number(this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version || 0);
    return { schemaVersion, engine: 'sqlite', journalMode, filePath: this.filePath };
  }

  upsertTurn(value = {}) {
    const now = String(value.updatedAt || this.now().toISOString());
    const turnId = required(value.turnId, 'turnId');
    const contract = jsonObject(value.contract || {});
    this.database.prepare(`
      INSERT INTO turns (turn_id, conversation_id, goal, mode, status, contract_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        goal = excluded.goal,
        mode = excluded.mode,
        status = excluded.status,
        contract_json = excluded.contract_json,
        updated_at = excluded.updated_at
    `).run(
      turnId,
      required(value.conversationId, 'conversationId'),
      String(value.goal || ''),
      String(value.mode || 'ask'),
      String(value.status || 'pending'),
      JSON.stringify(contract),
      String(value.createdAt || now),
      now,
    );
    return this.getTurn(turnId);
  }

  getTurn(turnId) {
    const row = this.database.prepare('SELECT * FROM turns WHERE turn_id = ?').get(required(turnId, 'turnId'));
    return row ? turnRecord(row) : null;
  }

  upsertRun(value = {}) {
    const now = String(value.updatedAt || this.now().toISOString());
    const runId = required(value.runId, 'runId');
    this.database.prepare(`
      INSERT INTO runs_v2 (
        run_id, turn_id, conversation_id, status, plan_revision, provider, model,
        response_id, previous_response_id, response_cursor, background,
        checkpoint_json, error_json, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        plan_revision = excluded.plan_revision,
        provider = excluded.provider,
        model = excluded.model,
        response_id = excluded.response_id,
        previous_response_id = excluded.previous_response_id,
        response_cursor = excluded.response_cursor,
        background = excluded.background,
        checkpoint_json = excluded.checkpoint_json,
        error_json = excluded.error_json,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run(
      runId,
      String(value.turnId || ''),
      String(value.conversationId || ''),
      String(value.status || 'queued'),
      integer(value.planRevision),
      String(value.provider || ''),
      String(value.model || ''),
      String(value.responseId || ''),
      String(value.previousResponseId || ''),
      String(value.responseCursor || value.cursor || ''),
      value.background === true ? 1 : 0,
      JSON.stringify(jsonObject(value.checkpoint || {})),
      JSON.stringify(jsonObject(value.error || {})),
      String(value.startedAt || now),
      now,
      String(value.completedAt || ''),
    );
    return this.getRun(runId);
  }

  getRun(runId) {
    const row = this.database.prepare('SELECT * FROM runs_v2 WHERE run_id = ?').get(required(runId, 'runId'));
    return row ? runRecord(row) : null;
  }

  listRuns({ status = '', conversationId = '', limit = 1_000 } = {}) {
    const maximum = Math.min(10_000, Math.max(1, integer(limit, 1_000)));
    if (status && conversationId) {
      return this.database.prepare(`
        SELECT * FROM runs_v2 WHERE status = ? AND conversation_id = ? ORDER BY updated_at DESC LIMIT ?
      `).all(String(status), String(conversationId), maximum).map(runRecord);
    }
    if (status) {
      return this.database.prepare('SELECT * FROM runs_v2 WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
        .all(String(status), maximum).map(runRecord);
    }
    if (conversationId) {
      return this.database.prepare('SELECT * FROM runs_v2 WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(String(conversationId), maximum).map(runRecord);
    }
    return this.database.prepare('SELECT * FROM runs_v2 ORDER BY updated_at DESC LIMIT ?').all(maximum).map(runRecord);
  }

  recordPlanRevision({ runId, revision, reason = '', plan = {}, createdAt = '' } = {}) {
    const encoded = stableJson(jsonObject(plan));
    const record = {
      runId: required(runId, 'runId'),
      revision: Math.max(1, integer(revision, 1)),
      reason: String(reason || ''),
      plan: parseJson(encoded, {}),
      planHash: sha256(encoded),
      createdAt: String(createdAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT OR IGNORE INTO plan_revisions (run_id, revision, reason, plan_json, plan_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.runId, record.revision, record.reason, encoded, record.planHash, record.createdAt);
    this.database.prepare('UPDATE runs_v2 SET plan_revision = MAX(plan_revision, ?), updated_at = ? WHERE run_id = ?')
      .run(record.revision, record.createdAt, record.runId);
    return record;
  }

  listPlanRevisions(runId) {
    return this.database.prepare('SELECT * FROM plan_revisions WHERE run_id = ? ORDER BY revision').all(required(runId, 'runId')).map(planRevisionRecord);
  }

  upsertRunNode(value = {}) {
    const now = String(value.updatedAt || this.now().toISOString());
    const runId = required(value.runId, 'runId');
    const nodeId = required(value.nodeId || value.id, 'nodeId');
    this.database.prepare(`
      INSERT INTO run_nodes (
        run_id, node_id, plan_revision, kind, title, status, depends_on_json,
        input_json, output_json, checkpoint_json, error_json, attempt_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        plan_revision = excluded.plan_revision,
        kind = excluded.kind,
        title = excluded.title,
        status = excluded.status,
        depends_on_json = excluded.depends_on_json,
        input_json = excluded.input_json,
        output_json = excluded.output_json,
        checkpoint_json = excluded.checkpoint_json,
        error_json = excluded.error_json,
        attempt_count = excluded.attempt_count,
        updated_at = excluded.updated_at
    `).run(
      runId,
      nodeId,
      Math.max(1, integer(value.planRevision, 1)),
      String(value.kind || 'analysis'),
      String(value.title || nodeId),
      String(value.status || 'pending'),
      JSON.stringify(arrayValue(value.dependsOn)),
      JSON.stringify(jsonObject(value.input || {})),
      JSON.stringify(value.output ?? null),
      JSON.stringify(jsonObject(value.checkpoint || {})),
      JSON.stringify(jsonObject(value.error || {})),
      integer(value.attemptCount),
      now,
    );
    return runNodeRecord(this.database.prepare('SELECT * FROM run_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId));
  }

  listRunNodes(runId) {
    return this.database.prepare('SELECT * FROM run_nodes WHERE run_id = ? ORDER BY node_id').all(required(runId, 'runId')).map(runNodeRecord);
  }

  recordNodeAttempt(value = {}) {
    const runId = required(value.runId, 'runId');
    const nodeId = required(value.nodeId, 'nodeId');
    const attempt = Math.max(1, integer(value.attempt, 1));
    const startedAt = String(value.startedAt || this.now().toISOString());
    const attemptId = String(value.attemptId || `${runId}:${nodeId}:${attempt}`);
    this.database.prepare(`
      INSERT INTO node_attempts (
        attempt_id, run_id, node_id, attempt, status, input_json, output_json,
        checkpoint_json, error_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        status = excluded.status,
        output_json = excluded.output_json,
        checkpoint_json = excluded.checkpoint_json,
        error_json = excluded.error_json,
        completed_at = excluded.completed_at
    `).run(
      attemptId,
      runId,
      nodeId,
      attempt,
      String(value.status || 'running'),
      JSON.stringify(jsonObject(value.input || {})),
      JSON.stringify(value.output ?? null),
      JSON.stringify(jsonObject(value.checkpoint || {})),
      JSON.stringify(jsonObject(value.error || {})),
      startedAt,
      String(value.completedAt || ''),
    );
    return nodeAttemptRecord(this.database.prepare('SELECT * FROM node_attempts WHERE attempt_id = ?').get(attemptId));
  }

  listNodeAttempts({ runId, nodeId = '' } = {}) {
    const rows = nodeId
      ? this.database.prepare('SELECT * FROM node_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt').all(required(runId, 'runId'), String(nodeId))
      : this.database.prepare('SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt').all(required(runId, 'runId'));
    return rows.map(nodeAttemptRecord);
  }

  recordCompaction(value = {}) {
    const record = {
      compactionId: String(value.compactionId || crypto.randomUUID()),
      conversationId: required(value.conversationId, 'conversationId'),
      runId: String(value.runId || ''),
      summary: jsonObject(value.summary || {}),
      sourceRefs: arrayValue(value.sourceRefs),
      inputTokens: integer(value.inputTokens),
      outputTokens: integer(value.outputTokens),
      createdAt: String(value.createdAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT INTO context_compactions (
        compaction_id, conversation_id, run_id, summary_json, source_refs_json,
        input_tokens, output_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.compactionId, record.conversationId, record.runId, JSON.stringify(record.summary), JSON.stringify(record.sourceRefs), record.inputTokens, record.outputTokens, record.createdAt);
    return record;
  }

  upsertContextPin(value = {}) {
    const record = {
      pinId: String(value.pinId || crypto.randomUUID()),
      conversationId: required(value.conversationId, 'conversationId'),
      itemType: required(value.itemType || value.type, 'itemType'),
      itemId: required(value.itemId || value.id, 'itemId'),
      value: jsonObject(value.value || {}),
      createdAt: String(value.createdAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT INTO context_pins (pin_id, conversation_id, item_type, item_id, value_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, item_type, item_id) DO UPDATE SET
        value_json = excluded.value_json
    `).run(record.pinId, record.conversationId, record.itemType, record.itemId, JSON.stringify(record.value), record.createdAt);
    return this.listContextPins(record.conversationId)
      .find((pin) => pin.itemType === record.itemType && pin.itemId === record.itemId);
  }

  listContextPins(conversationId) {
    return this.database.prepare('SELECT * FROM context_pins WHERE conversation_id = ? ORDER BY created_at').all(required(conversationId, 'conversationId')).map((row) => ({
      pinId: row.pin_id,
      conversationId: row.conversation_id,
      itemType: row.item_type,
      itemId: row.item_id,
      value: parseJson(row.value_json, {}),
      createdAt: row.created_at,
    }));
  }

  removeContextPin(pinId) {
    return Number(this.database.prepare('DELETE FROM context_pins WHERE pin_id = ?').run(required(pinId, 'pinId')).changes || 0) > 0;
  }

  upsertSnapshot({ jobId, snapshotId, revision = 0, manifest = {} } = {}) {
    const now = this.now().toISOString();
    const normalized = jsonObject(manifest);
    const encoded = stableJson(normalized);
    const manifestHash = sha256(encoded);
    const normalizedJobId = required(jobId, 'jobId');
    const normalizedSnapshotId = required(snapshotId, 'snapshotId');
    const current = this.getSnapshot(normalizedJobId, normalizedSnapshotId);
    if (current && current.manifestHash !== manifestHash) {
      throw storeError(
        'COPILOT_SNAPSHOT_COLLISION',
        `Snapshot ${normalizedSnapshotId} already exists with different content. Advance the task revision before creating a new snapshot.`,
        409,
      );
    }
    this.database.prepare(`
      INSERT INTO snapshots (
        job_id, snapshot_id, revision, manifest_json, manifest_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, snapshot_id) DO NOTHING
    `).run(normalizedJobId, normalizedSnapshotId, integer(revision), encoded, manifestHash, now, now);
    return this.getSnapshot(normalizedJobId, normalizedSnapshotId);
  }

  getSnapshot(jobId, snapshotId) {
    const row = this.database.prepare(`
      SELECT * FROM snapshots WHERE job_id = ? AND snapshot_id = ?
    `).get(required(jobId, 'jobId'), required(snapshotId, 'snapshotId'));
    if (!row) return null;
    const snapshot = snapshotRecord(row);
    const actualHash = sha256(stableJson(snapshot.manifest));
    if (actualHash !== snapshot.manifestHash) {
      throw storeError('COPILOT_SNAPSHOT_INTEGRITY_FAILED', `Snapshot ${snapshot.snapshotId} failed manifest verification.`, 409);
    }
    return snapshot;
  }

  listSnapshots({ jobId, limit = 100 } = {}) {
    const maximum = Math.min(500, Math.max(1, integer(limit, 100)));
    const rows = jobId
      ? this.database.prepare(`SELECT * FROM snapshots WHERE job_id = ? ORDER BY revision DESC, created_at DESC LIMIT ?`).all(String(jobId), maximum)
      : this.database.prepare(`SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ?`).all(maximum);
    return rows.map(snapshotRecord);
  }

  diffSnapshots({ jobId, fromSnapshotId, toSnapshotId } = {}) {
    const from = this.getSnapshot(jobId, fromSnapshotId);
    const to = this.getSnapshot(jobId, toSnapshotId);
    if (!from || !to) throw storeError('COPILOT_SNAPSHOT_NOT_FOUND', 'Both snapshots are required for diff.', 404);
    const changes = diffValues(from.manifest, to.manifest);
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: String(jobId),
      from: snapshotSummary(from),
      to: snapshotSummary(to),
      changed: changes.length > 0,
      changes,
    };
  }

  recordTrace(value = {}) {
    const createdAt = String(value.createdAt || this.now().toISOString());
    const traceId = String(value.traceId || crypto.randomUUID());
    this.database.prepare(`
      INSERT INTO traces (
        trace_id, conversation_id, run_id, operation, status, duration_ms, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      String(value.conversationId || ''),
      String(value.runId || ''),
      required(value.operation, 'operation'),
      String(value.status || 'completed'),
      integer(value.durationMs),
      JSON.stringify(jsonObject(value.payload || {})),
      createdAt,
    );
    return { traceId, createdAt };
  }

  listTraces({ conversationId = '', runId = '', limit = 100 } = {}) {
    const maximum = Math.min(500, Math.max(1, integer(limit, 100)));
    let rows;
    if (conversationId) {
      rows = this.database.prepare(`SELECT * FROM traces WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`).all(String(conversationId), maximum);
    } else if (runId) {
      rows = this.database.prepare(`SELECT * FROM traces WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`).all(String(runId), maximum);
    } else {
      rows = this.database.prepare(`SELECT * FROM traces ORDER BY created_at DESC LIMIT ?`).all(maximum);
    }
    return rows.map((row) => ({
      traceId: row.trace_id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      operation: row.operation,
      status: row.status,
      durationMs: row.duration_ms,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  recordUsage(value = {}) {
    const record = {
      conversationId: String(value.conversationId || ''),
      runId: String(value.runId || ''),
      provider: String(value.provider || ''),
      model: String(value.model || ''),
      inputTokens: integer(value.inputTokens),
      outputTokens: integer(value.outputTokens),
      toolCalls: integer(value.toolCalls),
      latencyMs: integer(value.latencyMs),
      estimatedCostUsd: number(value.estimatedCostUsd),
      occurredAt: String(value.occurredAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT INTO usage_records (
        conversation_id, run_id, provider, model, input_tokens, output_tokens,
        tool_calls, latency_ms, estimated_cost_usd, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...Object.values(record));
    return record;
  }

  summarizeUsage({ conversationId = '', runId = '' } = {}) {
    const clauses = [];
    const values = [];
    if (conversationId) { clauses.push('conversation_id = ?'); values.push(String(conversationId)); }
    if (runId) { clauses.push('run_id = ?'); values.push(String(runId)); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const row = this.database.prepare(`
      SELECT COUNT(*) AS records,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tool_calls), 0) AS tool_calls,
        COALESCE(SUM(latency_ms), 0) AS latency_ms,
        COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
      FROM usage_records${where}
    `).get(...values);
    return {
      records: Number(row.records || 0),
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      toolCalls: Number(row.tool_calls || 0),
      latencyMs: Number(row.latency_ms || 0),
      estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    };
  }

  recordEvaluation(result = {}) {
    const evaluationId = String(result.evaluationId || crypto.randomUUID());
    const createdAt = String(result.createdAt || this.now().toISOString());
    this.database.prepare(`
      INSERT OR REPLACE INTO evaluation_runs (evaluation_id, suite, status, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(evaluationId, String(result.suite || 'golden-30'), String(result.status || 'completed'), JSON.stringify(result), createdAt);
    return { ...structuredClone(result), evaluationId, createdAt };
  }

  listEvaluations({ suite = '', limit = 20 } = {}) {
    const maximum = Math.min(100, Math.max(1, integer(limit, 20)));
    const rows = suite
      ? this.database.prepare(`SELECT result_json FROM evaluation_runs WHERE suite = ? ORDER BY created_at DESC LIMIT ?`).all(String(suite), maximum)
      : this.database.prepare(`SELECT result_json FROM evaluation_runs ORDER BY created_at DESC LIMIT ?`).all(maximum);
    return rows.map((row) => parseJson(row.result_json, {}));
  }

  enqueueOutbox({ eventId = crypto.randomUUID(), topic, payload = {}, availableAt = '' } = {}) {
    const now = this.now().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO outbox (
        event_id, topic, payload_json, status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(String(eventId), required(topic, 'topic'), JSON.stringify(jsonObject(payload)), String(availableAt || now), now, now);
    return { eventId: String(eventId), topic: String(topic), availableAt: String(availableAt || now) };
  }

  acquireLease({ leaseKey, ownerId, ttlMs = 30_000 } = {}) {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + Math.max(1_000, integer(ttlMs, 30_000))).toISOString();
    const updatedAt = now.toISOString();
    const result = this.database.prepare(`
      INSERT INTO worker_leases (lease_key, owner_id, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE worker_leases.expires_at <= excluded.updated_at OR worker_leases.owner_id = excluded.owner_id
    `).run(required(leaseKey, 'leaseKey'), required(ownerId, 'ownerId'), expiresAt, updatedAt);
    return { acquired: Number(result.changes || 0) > 0, leaseKey: String(leaseKey), ownerId: String(ownerId), expiresAt };
  }

  createMcpGrant(value = {}) {
    const record = {
      grantId: required(value.grantId, 'grantId'),
      tokenHash: required(value.tokenHash, 'tokenHash'),
      tokenPrefix: required(value.tokenPrefix, 'tokenPrefix'),
      name: required(value.name, 'name'),
      owner: required(value.owner, 'owner'),
      conversationId: required(value.conversationId, 'conversationId'),
      jobId: required(value.jobId, 'jobId'),
      snapshotId: required(value.snapshotId, 'snapshotId'),
      manifestHash: required(value.manifestHash, 'manifestHash'),
      mode: required(value.mode, 'mode'),
      scopes: arrayValue(value.scopes),
      allowedTools: arrayValue(value.allowedTools),
      allowedResources: arrayValue(value.allowedResources),
      maxRisk: required(value.maxRisk, 'maxRisk'),
      status: String(value.status || 'active'),
      createdAt: String(value.createdAt || this.now().toISOString()),
      expiresAt: required(value.expiresAt, 'expiresAt'),
      metadata: jsonObject(value.metadata || {}),
    };
    this.database.prepare(`
      INSERT INTO mcp_grants (
        grant_id, token_hash, token_prefix, name, owner, conversation_id, job_id,
        snapshot_id, manifest_hash, mode, scopes_json, allowed_tools_json,
        allowed_resources_json, max_risk, status, created_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.grantId, record.tokenHash, record.tokenPrefix, record.name, record.owner,
      record.conversationId, record.jobId, record.snapshotId, record.manifestHash,
      record.mode, JSON.stringify(record.scopes), JSON.stringify(record.allowedTools),
      JSON.stringify(record.allowedResources), record.maxRisk, record.status,
      record.createdAt, record.expiresAt, JSON.stringify(record.metadata),
    );
    return this.getMcpGrant(record.grantId);
  }

  getMcpGrant(grantId) {
    const row = this.database.prepare('SELECT * FROM mcp_grants WHERE grant_id = ?').get(required(grantId, 'grantId'));
    return row ? mcpGrantRecord(row) : null;
  }

  findMcpGrantByTokenHash(tokenHash) {
    const row = this.database.prepare('SELECT * FROM mcp_grants WHERE token_hash = ?').get(required(tokenHash, 'tokenHash'));
    return row ? mcpGrantRecord(row) : null;
  }

  listMcpGrants({ owner = '', conversationId = '', limit = 100 } = {}) {
    const maximum = Math.min(500, Math.max(1, integer(limit, 100)));
    let rows;
    if (owner) rows = this.database.prepare('SELECT * FROM mcp_grants WHERE owner = ? ORDER BY created_at DESC LIMIT ?').all(String(owner), maximum);
    else if (conversationId) rows = this.database.prepare('SELECT * FROM mcp_grants WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?').all(String(conversationId), maximum);
    else rows = this.database.prepare('SELECT * FROM mcp_grants ORDER BY created_at DESC LIMIT ?').all(maximum);
    return rows.map(mcpGrantRecord);
  }

  touchMcpGrant(grantId, occurredAt = this.now().toISOString()) {
    this.database.prepare('UPDATE mcp_grants SET last_used_at = ? WHERE grant_id = ?').run(String(occurredAt), required(grantId, 'grantId'));
    return this.getMcpGrant(grantId);
  }

  revokeMcpGrant(grantId, revokedAt = this.now().toISOString()) {
    this.database.prepare(`UPDATE mcp_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ? AND status = 'active'`)
      .run(String(revokedAt), required(grantId, 'grantId'));
    return this.getMcpGrant(grantId);
  }

  upsertMcpSession(value = {}) {
    const now = String(value.lastSeenAt || this.now().toISOString());
    this.database.prepare(`
      INSERT INTO mcp_sessions (session_id, grant_id, transport, status, client_json, created_at, last_seen_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        client_json = excluded.client_json,
        last_seen_at = excluded.last_seen_at,
        closed_at = excluded.closed_at
    `).run(
      required(value.sessionId, 'sessionId'), required(value.grantId, 'grantId'),
      String(value.transport || 'streamable-http'), String(value.status || 'active'),
      JSON.stringify(jsonObject(value.client || {})), String(value.createdAt || now), now,
      String(value.closedAt || ''),
    );
    return this.getMcpSession(value.sessionId);
  }

  getMcpSession(sessionId) {
    const row = this.database.prepare('SELECT * FROM mcp_sessions WHERE session_id = ?').get(required(sessionId, 'sessionId'));
    return row ? mcpSessionRecord(row) : null;
  }

  listMcpSessions({ grantId = '', limit = 100 } = {}) {
    const maximum = Math.min(500, Math.max(1, integer(limit, 100)));
    const rows = grantId
      ? this.database.prepare('SELECT * FROM mcp_sessions WHERE grant_id = ? ORDER BY last_seen_at DESC LIMIT ?').all(String(grantId), maximum)
      : this.database.prepare('SELECT * FROM mcp_sessions ORDER BY last_seen_at DESC LIMIT ?').all(maximum);
    return rows.map(mcpSessionRecord);
  }

  closeMcpSession(sessionId, closedAt = this.now().toISOString()) {
    this.database.prepare(`UPDATE mcp_sessions SET status = 'closed', closed_at = ?, last_seen_at = ? WHERE session_id = ?`)
      .run(String(closedAt), String(closedAt), required(sessionId, 'sessionId'));
    return this.getMcpSession(sessionId);
  }

  beginMcpToolRun(value = {}) {
    const grantId = required(value.grantId, 'grantId');
    const idempotencyKey = required(value.idempotencyKey, 'idempotencyKey');
    const requestHash = required(value.requestHash, 'requestHash');
    const actionHash = required(value.actionHash || requestHash, 'actionHash');
    const existing = this.getMcpToolRunByIdempotency(grantId, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.actionHash !== actionHash) {
        throw storeError('MCP_IDEMPOTENCY_CONFLICT', 'The MCP idempotency key was reused with a different request.', 409);
      }
      return { run: existing, duplicate: true };
    }
    const record = {
      callId: required(value.callId || crypto.randomUUID(), 'callId'),
      grantId,
      sessionId: String(value.sessionId || ''),
      idempotencyKey,
      requestHash,
      actionHash,
      toolName: required(value.toolName, 'toolName'),
      status: String(value.status || 'running'),
      startedAt: String(value.startedAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT INTO mcp_tool_runs (
        call_id, grant_id, session_id, idempotency_key, request_hash, action_hash, tool_name, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...Object.values(record));
    return { run: this.getMcpToolRun(record.callId), duplicate: false };
  }

  getMcpToolRun(callId) {
    const row = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE call_id = ?').get(required(callId, 'callId'));
    return row ? mcpToolRunRecord(row) : null;
  }

  getMcpToolRunByIdempotency(grantId, idempotencyKey) {
    const row = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE grant_id = ? AND idempotency_key = ?')
      .get(required(grantId, 'grantId'), required(idempotencyKey, 'idempotencyKey'));
    return row ? mcpToolRunRecord(row) : null;
  }

  getMcpToolRunByApprovalId(approvalId) {
    const row = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE approval_id = ?').get(required(approvalId, 'approvalId'));
    return row ? mcpToolRunRecord(row) : null;
  }

  updateMcpToolRun(callId, value = {}) {
    const current = this.getMcpToolRun(callId);
    if (!current) throw storeError('MCP_TOOL_RUN_NOT_FOUND', 'The MCP tool run was not found.', 404);
    const next = {
      status: String(value.status || current.status),
      result: Object.hasOwn(value, 'result') ? value.result : current.result,
      error: Object.hasOwn(value, 'error') ? jsonObject(value.error) : current.error,
      approvalId: String(value.approvalId ?? current.approvalId ?? ''),
      completedAt: String(value.completedAt ?? current.completedAt ?? ''),
    };
    this.database.prepare(`
      UPDATE mcp_tool_runs SET status = ?, result_json = ?, error_json = ?, approval_id = ?, completed_at = ?
      WHERE call_id = ?
    `).run(next.status, JSON.stringify(next.result ?? null), JSON.stringify(next.error), next.approvalId, next.completedAt, current.callId);
    return this.getMcpToolRun(current.callId);
  }

  listMcpToolRuns({ grantId = '', status = '', limit = 100 } = {}) {
    const maximum = Math.min(500, Math.max(1, integer(limit, 100)));
    let rows;
    if (grantId && status) rows = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE grant_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?').all(String(grantId), String(status), maximum);
    else if (grantId) rows = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE grant_id = ? ORDER BY started_at DESC LIMIT ?').all(String(grantId), maximum);
    else if (status) rows = this.database.prepare('SELECT * FROM mcp_tool_runs WHERE status = ? ORDER BY started_at DESC LIMIT ?').all(String(status), maximum);
    else rows = this.database.prepare('SELECT * FROM mcp_tool_runs ORDER BY started_at DESC LIMIT ?').all(maximum);
    return rows.map(mcpToolRunRecord);
  }

  recordMcpAudit(value = {}) {
    const record = {
      auditId: String(value.auditId || crypto.randomUUID()),
      grantId: String(value.grantId || ''),
      sessionId: String(value.sessionId || ''),
      owner: String(value.owner || ''),
      action: required(value.action, 'action'),
      status: String(value.status || 'completed'),
      detail: jsonObject(value.detail || {}),
      occurredAt: String(value.occurredAt || this.now().toISOString()),
    };
    this.database.prepare(`
      INSERT INTO mcp_audit (audit_id, grant_id, session_id, owner, action, status, detail_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.auditId, record.grantId, record.sessionId, record.owner, record.action, record.status, JSON.stringify(record.detail), record.occurredAt);
    return record;
  }

  listMcpAudit({ grantId = '', limit = 100 } = {}) {
    const maximum = Math.min(1000, Math.max(1, integer(limit, 100)));
    const rows = grantId
      ? this.database.prepare('SELECT * FROM mcp_audit WHERE grant_id = ? ORDER BY occurred_at DESC LIMIT ?').all(String(grantId), maximum)
      : this.database.prepare('SELECT * FROM mcp_audit ORDER BY occurred_at DESC LIMIT ?').all(maximum);
    return rows.map((row) => ({
      auditId: row.audit_id, grantId: row.grant_id, sessionId: row.session_id,
      owner: row.owner, action: row.action, status: row.status,
      detail: parseJson(row.detail_json, {}), occurredAt: row.occurred_at,
    }));
  }

  close() {
    this.database.close();
  }
}

export function createCopilotProductionStore(options) {
  return new CopilotProductionStore(options);
}

function turnRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    goal: row.goal,
    mode: row.mode,
    status: row.status,
    contract: parseJson(row.contract_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: row.run_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    status: row.status,
    planRevision: Number(row.plan_revision || 0),
    provider: row.provider,
    model: row.model,
    responseId: row.response_id,
    previousResponseId: row.previous_response_id,
    responseCursor: row.response_cursor,
    background: Boolean(row.background),
    checkpoint: parseJson(row.checkpoint_json, {}),
    error: parseJson(row.error_json, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function planRevisionRecord(row) {
  return {
    runId: row.run_id,
    revision: Number(row.revision),
    reason: row.reason,
    plan: parseJson(row.plan_json, {}),
    planHash: row.plan_hash,
    createdAt: row.created_at,
  };
}

function runNodeRecord(row) {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    planRevision: Number(row.plan_revision),
    kind: row.kind,
    title: row.title,
    status: row.status,
    dependsOn: parseJson(row.depends_on_json, []),
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, null),
    checkpoint: parseJson(row.checkpoint_json, {}),
    error: parseJson(row.error_json, {}),
    attemptCount: Number(row.attempt_count || 0),
    updatedAt: row.updated_at,
  };
}

function nodeAttemptRecord(row) {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt),
    status: row.status,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, null),
    checkpoint: parseJson(row.checkpoint_json, {}),
    error: parseJson(row.error_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mcpGrantRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    grantId: row.grant_id,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    name: row.name,
    owner: row.owner,
    conversationId: row.conversation_id,
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    manifestHash: row.manifest_hash,
    mode: row.mode,
    scopes: parseJson(row.scopes_json, []),
    allowedTools: parseJson(row.allowed_tools_json, []),
    allowedResources: parseJson(row.allowed_resources_json, []),
    maxRisk: row.max_risk,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function ensureSqliteColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mcpSessionRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: row.session_id,
    grantId: row.grant_id,
    transport: row.transport,
    status: row.status,
    client: parseJson(row.client_json, {}),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
  };
}

function mcpToolRunRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    callId: row.call_id,
    grantId: row.grant_id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    actionHash: row.action_hash,
    toolName: row.tool_name,
    status: row.status,
    result: parseJson(row.result_json, null),
    error: parseJson(row.error_json, {}),
    approvalId: row.approval_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function snapshotRecord(row) {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    revision: Number(row.revision),
    manifest: parseJson(row.manifest_json, {}),
    manifestHash: row.manifest_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotSummary(value) {
  return {
    snapshotId: value.snapshotId,
    revision: value.revision,
    manifestHash: value.manifestHash,
    createdAt: value.createdAt,
  };
}

function diffValues(left, right, prefix = '') {
  if (stableJson(left) === stableJson(right)) return [];
  if (!isObject(left) || !isObject(right)) return [{ path: prefix || '$', before: left ?? null, after: right ?? null }];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => diffValues(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function jsonObject(value) {
  const cloned = structuredClone(value || {});
  return isObject(cloned) ? cloned : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function required(value, name) { const text = String(value || '').trim(); if (!text) throw storeError('COPILOT_STORE_VALUE_REQUIRED', `${name} is required.`); return text; }
function integer(value, fallback = 0) { const result = Number(value); return Number.isFinite(result) ? Math.max(0, Math.floor(result)) : fallback; }
function number(value) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : 0; }
function storeError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
