import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function hasTable(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

export function revokeMcpGrantsAfterRestore(databasePath, { now = new Date().toISOString() } = {}) {
  const resolvedPath = path.resolve(String(databasePath || ''));
  if (!databasePath || !fs.existsSync(resolvedPath)) {
    return { databaseFound: false, mcpSchemaFound: false, revokedGrants: 0, closedSessions: 0, auditEvents: 0 };
  }

  const database = new DatabaseSync(resolvedPath);
  try {
    if (!hasTable(database, 'mcp_grants')) {
      return { databaseFound: true, mcpSchemaFound: false, revokedGrants: 0, closedSessions: 0, auditEvents: 0 };
    }

    const activeGrants = database.prepare("SELECT grant_id, owner FROM mcp_grants WHERE status = 'active'").all();
    const hasSessions = hasTable(database, 'mcp_sessions');
    const hasAudit = hasTable(database, 'mcp_audit');
    let revokedGrants = 0;
    let closedSessions = 0;
    let auditEvents = 0;

    database.exec('BEGIN IMMEDIATE');
    try {
      const revokeGrant = database.prepare("UPDATE mcp_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ? AND status = 'active'");
      const closeSessions = hasSessions
        ? database.prepare("UPDATE mcp_sessions SET status = 'closed', closed_at = ?, last_seen_at = ? WHERE grant_id = ? AND status = 'active'")
        : null;
      const insertAudit = hasAudit
        ? database.prepare(`
            INSERT INTO mcp_audit (audit_id, grant_id, session_id, owner, action, status, detail_json, occurred_at)
            VALUES (?, ?, '', ?, 'grant.restore_revoked', 'completed', ?, ?)
          `)
        : null;

      for (const grant of activeGrants) {
        revokedGrants += Number(revokeGrant.run(now, grant.grant_id).changes || 0);
        if (closeSessions) closedSessions += Number(closeSessions.run(now, now, grant.grant_id).changes || 0);
        if (insertAudit) {
          insertAudit.run(
            crypto.randomUUID(),
            grant.grant_id,
            grant.owner,
            JSON.stringify({ reason: 'restore-boundary', replacementRequired: true }),
            now,
          );
          auditEvents += 1;
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return { databaseFound: true, mcpSchemaFound: true, revokedGrants, closedSessions, auditEvents };
  } finally {
    database.close();
  }
}

function readDatabaseArgument(argv) {
  const index = argv.indexOf('--database');
  if (index < 0 || !argv[index + 1]) throw new Error('Usage: node revoke-mcp-grants-after-restore.mjs --database <copilot-state.sqlite>');
  return argv[index + 1];
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const result = revokeMcpGrantsAfterRestore(readDatabaseArgument(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
