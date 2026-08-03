const MODES = new Set(['application', 'research']);

const TOOL_SCOPES = Object.freeze({
  'tool.search': 'dataset:read',
  'tool.describe': 'dataset:read',
  'task.status': 'dataset:read',
  'task.workflow': 'dataset:read',
  'dataset.describe': 'dataset:read',
  'dataset.list': 'dataset:read',
  'records.search': 'dataset:read',
  'records.query': 'dataset:read',
  'records.filter': 'dataset:read',
  'records.sort': 'dataset:read',
  'records.aggregate': 'dataset:read',
  'records.group': 'dataset:read',
  'records.join': 'dataset:read',
  'records.get': 'dataset:read',
  'content.inspect': 'content:read',
  'content.image_understanding': 'content:read',
  'jobs.extract_links': 'applications:read',
  'jobs.compare': 'applications:read',
  'applications.get_delivery': 'applications:read',
  'applications.compose_email': 'email:draft',
  'audience.segment': 'audience:read',
  'audience.coverage': 'audience:read',
  'users.query': 'audience:read',
  'comments.query': 'audience:read',
  'expansion.trace': 'expansion:read',
  'expansion.summary': 'expansion:read',
  'artifact.create': 'artifact:write',
  'artifact.preview': 'artifact:read',
  'artifact.list': 'artifact:read',
  'attachment.parse': 'attachment:read',
  'attachment.join_dataset': 'attachment:read',
  'attachment.list': 'attachment:read',
  'email.prepare': 'email:draft',
  'email.preview': 'email:draft',
  'email.send': 'email:send',
});

const MODE_SCOPES = Object.freeze({
  application: new Set([
    'dataset:read', 'content:read', 'applications:read', 'audience:read',
    'expansion:read', 'artifact:read', 'artifact:write', 'attachment:read',
    'email:draft', 'email:send',
  ]),
  research: new Set([
    'dataset:read', 'content:read', 'audience:read', 'expansion:read',
    'artifact:read', 'artifact:write', 'attachment:read', 'email:draft',
    'email:send',
  ]),
});

export class DataPolicyError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'DataPolicyError';
    this.code = code;
    this.status = status;
  }
}

export class DataPolicyEngine {
  constructor({ manager } = {}) {
    this.manager = manager;
  }

  validateReference(reference, conversation = null) {
    const mode = String(reference?.mode || '');
    if (!MODES.has(mode)) throw policyError('COPILOT_MODE_INVALID', 'Conversation mode is invalid.', 400);
    for (const field of ['conversationId', 'jobId', 'snapshotId']) {
      if (!String(reference?.[field] || '').trim()) {
        throw policyError('COPILOT_CONTEXT_INVALID', `Conversation ${field} is required.`, 400);
      }
    }
    const job = this.manager?.getInternal?.(reference.jobId) || this.manager?.get?.(reference.jobId);
    if (!job) throw policyError('COPILOT_JOB_NOT_FOUND', 'The bound task no longer exists.', 404);
    if (conversation) {
      for (const field of ['conversationId', 'jobId', 'snapshotId', 'mode']) {
        if (String(conversation[field]) !== String(reference[field])) {
          throw policyError('COPILOT_CONTEXT_MISMATCH', 'Conversation context does not match its persisted snapshot.', 409);
        }
      }
    }
    return job;
  }

  validateSnapshot(reference, conversation = null) {
    const job = this.validateReference(reference, conversation);
    const currentRevision = normalizeRevision(job.revision);
    const scopeRevision = normalizeRevision(reference?.scope?.jobRevision, { optional: true });
    const snapshotRevision = revisionFromSnapshotId(reference?.snapshotId);
    if (scopeRevision === null && snapshotRevision === null) {
      throw policyError(
        'COPILOT_SNAPSHOT_UNBOUND',
        'The conversation snapshot is not bound to a task revision. Create a new conversation.',
        409,
      );
    }
    if (scopeRevision !== null && snapshotRevision !== null && scopeRevision !== snapshotRevision) {
      throw policyError(
        'COPILOT_SNAPSHOT_INVALID',
        'The persisted snapshot ID and task revision do not match.',
        409,
      );
    }
    const boundRevision = scopeRevision ?? snapshotRevision;
    if (boundRevision !== currentRevision) {
      throw policyError(
        'COPILOT_SNAPSHOT_STALE',
        `The conversation is bound to task revision ${boundRevision}, but the task is now revision ${currentRevision}. Create a new conversation to read the updated data.`,
        409,
      );
    }
    return { job, revision: currentRevision, snapshotId: `job-r${currentRevision}` };
  }

  authorizeTool(reference, toolName, conversation = null, declaredScopes = []) {
    const { job } = this.validateSnapshot(reference, conversation);
    const declared = normalizeDeclaredScopes(declaredScopes);
    const required = TOOL_SCOPES[toolName] || declared[0];
    if (!required) throw policyError('COPILOT_TOOL_NOT_ALLOWED', 'The requested tool is not registered.', 403);
    if (declared.length && !declared.includes(required)) {
      throw policyError('COPILOT_TOOL_SCOPE_INVALID', 'The tool scope does not match its registered policy.', 403);
    }
    if (!MODE_SCOPES[reference.mode].has(required)) {
      throw policyError('COPILOT_SCOPE_DENIED', 'The tool is outside the conversation mode.', 403);
    }
    const configured = allowedScopes(reference.scope);
    if (configured && !configured.has(required) && !configured.has('*')) {
      throw policyError('COPILOT_SCOPE_DENIED', 'The conversation did not grant this tool scope.', 403);
    }
    return { job, requiredScope: required };
  }

  resourceUri(reference, resource) {
    const suffix = String(resource || '').replace(/^\/+|\/+$/gu, '');
    const allowed = new Set(['applications', 'content', 'audience', 'expansion', 'attachments', 'artifacts']);
    if (!allowed.has(suffix)) throw policyError('COPILOT_RESOURCE_DENIED', 'The requested resource is not available.', 403);
    if (suffix === 'attachments' || suffix === 'artifacts') {
      return `xhs-data://conversations/${encodeURIComponent(reference.conversationId)}/${suffix}`;
    }
    return `xhs-data://jobs/${encodeURIComponent(reference.jobId)}/${suffix}`;
  }
}

function normalizeDeclaredScopes(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

export function scopeForTool(toolName) {
  return TOOL_SCOPES[toolName] || null;
}

function allowedScopes(scope) {
  const value = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? scope.allowedScopes
    : null;
  if (!Array.isArray(value) || value.length === 0) return null;
  return new Set(value.map(String));
}

function revisionFromSnapshotId(value) {
  const match = /^job-r(0|[1-9]\d*)$/u.exec(String(value || ''));
  if (!match) return null;
  return normalizeRevision(match[1]);
}

function normalizeRevision(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const revision = Number(value ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw policyError('COPILOT_SNAPSHOT_INVALID', 'The task revision is invalid.', 409);
  }
  return revision;
}

function policyError(code, message, status) {
  return new DataPolicyError(code, message, status);
}
