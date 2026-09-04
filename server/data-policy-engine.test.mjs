import test from 'node:test';
import assert from 'node:assert/strict';

import { DataPolicyEngine } from './data-policy-engine.mjs';

function reference(allowedScopes) {
  return {
    conversationId: 'conversation-1',
    jobId: 'job-1',
    snapshotId: 'job-r1',
    mode: 'application',
    scope: { jobRevision: 1, allowedScopes },
  };
}

test('tool authorization requires every declared scope', () => {
  const job = { id: 'job-1', revision: 1 };
  const policy = new DataPolicyEngine({ manager: { getInternal: () => job } });

  assert.throws(
    () => policy.authorizeTool(
      reference(['email:draft']),
      'applications.compose_email',
      null,
      ['applications:read', 'email:draft'],
    ),
    (error) => error.code === 'COPILOT_SCOPE_DENIED',
  );

  const authorization = policy.authorizeTool(
    reference(['applications:read', 'email:draft']),
    'applications.compose_email',
    null,
    ['applications:read', 'email:draft'],
  );
  assert.deepEqual(authorization.requiredScopes, ['email:draft', 'applications:read']);
});
