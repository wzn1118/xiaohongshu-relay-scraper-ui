import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { handleMcpManagementRequest } from './mcp-management-http.mjs';

test('MCP management API routes control-plane operations and validates JSON', async (t) => {
  const calls = [];
  const service = {
    status: () => ({ ok: true, service: 'test-mcp' }),
    getCapabilities: async (conversationId) => ({ conversationId, scopes: ['dataset:read'] }),
    listGrants: (actor, options) => ({ grants: [], actor, options }),
    getGrant: (grantId) => ({ grant: { grantId } }),
    createGrant: async (value, actor) => {
      calls.push(['create', value, actor]);
      return { grant: { grantId: 'grant-1' }, token: 'one-time-token' };
    },
    revokeGrant: (grantId, actor) => {
      calls.push(['revoke', grantId, actor]);
      return { grant: { grantId, status: 'revoked' } };
    },
    rotateGrant: async (grantId, value, actor) => {
      calls.push(['rotate', grantId, value, actor]);
      return { grant: { grantId: 'grant-2' }, token: 'rotated-token' };
    },
    rebindGrant: async (grantId, value, actor) => {
      calls.push(['rebind', grantId, value, actor]);
      return { grant: { grantId: 'grant-3', conversationId: value.conversationId }, token: 'rebound-token' };
    },
    listGrantAudit: (grantId) => ({ events: [{ grantId }] }),
    listSessions: () => ({ sessions: [] }),
    listToolRuns: () => ({ toolRuns: [] }),
    listAudit: () => ({ events: [] }),
    decideApproval: async (approvalId, value, actor) => {
      calls.push(['decision', approvalId, value, actor]);
      return { approval: { approvalId, status: value.action === 'approve' ? 'consumed' : 'rejected' } };
    },
  };
  const actor = { id: 'owner-1' };
  const server = http.createServer(async (req, res) => {
    const handled = await handleMcpManagementRequest({ req, res, service, actor, maxBodyBytes: 256 });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await listen(server, 0);
  t.after(() => close(server));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const status = await fetch(`${base}/api/mcp/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).service, 'test-mcp');

  const create = await fetch(`${base}/api/mcp/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: 'conversation-1', expiresInSeconds: 3600 }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).token, 'one-time-token');

  const capabilities = await fetch(`${base}/api/mcp/capabilities?conversationId=conversation-1`);
  assert.equal((await capabilities.json()).scopes[0], 'dataset:read');

  const rotate = await fetch(`${base}/api/mcp/grants/grant-1/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(rotate.status, 201);
  assert.equal((await rotate.json()).token, 'rotated-token');

  const rebind = await fetch(`${base}/api/mcp/grants/grant-2/rebind`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: 'conversation-2' }),
  });
  assert.equal(rebind.status, 201);
  assert.equal((await rebind.json()).grant.conversationId, 'conversation-2');

  const decision = await fetch(`${base}/api/mcp/approvals/approval-1/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(decision.status, 200);
  assert.equal((await decision.json()).approval.status, 'consumed');

  const revoke = await fetch(`${base}/api/mcp/grants/grant-1`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).grant.status, 'revoked');
  assert.deepEqual(calls.map((entry) => entry[0]), ['create', 'rotate', 'rebind', 'decision', 'revoke']);
  assert.deepEqual(calls[0][2], actor);

  const invalid = await fetch(`${base}/api/mcp/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2,3]',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'MCP_BODY_INVALID');
  const missing = await fetch(`${base}/api/mcp/not-a-route`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'MCP_ROUTE_NOT_FOUND');
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
