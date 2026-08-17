import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { revokeMcpGrantsAfterRestore } from '../scripts/revoke-mcp-grants-after-restore.mjs';

test('restore boundary revokes active MCP grants and closes their sessions', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-restore-'));
  const databasePath = path.join(temporary, 'copilot-state.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE mcp_grants (grant_id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, revoked_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE mcp_sessions (session_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, status TEXT NOT NULL, closed_at TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE mcp_audit (audit_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, session_id TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, detail_json TEXT NOT NULL, occurred_at TEXT NOT NULL);
    INSERT INTO mcp_grants (grant_id, owner, status) VALUES ('active-grant', 'owner-a', 'active'), ('old-grant', 'owner-a', 'revoked');
    INSERT INTO mcp_sessions (session_id, grant_id, status) VALUES ('active-session', 'active-grant', 'active'), ('old-session', 'old-grant', 'closed');
  `);
  database.close();

  try {
    const result = revokeMcpGrantsAfterRestore(databasePath, { now: '2026-08-09T00:00:00.000Z' });
    assert.deepEqual(result, {
      databaseFound: true,
      mcpSchemaFound: true,
      revokedGrants: 1,
      closedSessions: 1,
      auditEvents: 1,
    });

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const grant = verified.prepare('SELECT status, revoked_at FROM mcp_grants WHERE grant_id = ?').get('active-grant');
      assert.equal(grant.status, 'revoked');
      assert.equal(grant.revoked_at, '2026-08-09T00:00:00.000Z');
      assert.equal(verified.prepare('SELECT status FROM mcp_sessions WHERE session_id = ?').get('active-session').status, 'closed');
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM mcp_audit WHERE action = 'grant.restore_revoked'").get().count, 1);
    } finally {
      verified.close();
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('restore boundary is a no-op when a database is absent', () => {
  assert.deepEqual(revokeMcpGrantsAfterRestore(path.join(os.tmpdir(), crypto.randomUUID(), 'missing.sqlite')), {
    databaseFound: false,
    mcpSchemaFound: false,
    revokedGrants: 0,
    closedSessions: 0,
    auditEvents: 0,
  });
});
