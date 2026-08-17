import { randomUUID } from 'node:crypto';

const LOCAL_AUTONOMOUS_TOOL_NAMES = new Set([
  'workspace.write',
  'workspace.patch',
  'exec.run',
]);

const AUTHORITY_PROFILES = new Set([
  'observe',
  'workspace_auto',
  'owner_local_full',
  'delegated',
]);

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

/**
 * Error shape shared by API callers, the planner, and the event projection.
 * The underlying adapter error stays in the receipt so a model can recover
 * from a failed patch or command without being given credentials.
 */
export class CapabilityRuntimeError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CapabilityRuntimeError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * The execution boundary for every non-data capability.  It intentionally
 * wraps the existing unified registry instead of replacing its adapters: the
 * registry continues to own tool discovery and adapter dispatch, while this
 * class owns run-scoped authority and durable-friendly receipts.
 */
export class CapabilityRuntime {
  constructor({ registry, now = () => new Date(), idFactory = () => randomUUID() } = {}) {
    if (!registry || typeof registry.get !== 'function' || typeof registry.execute !== 'function') {
      throw new TypeError('CapabilityRuntime requires a unified tool registry.');
    }
    this.registry = registry;
    this.now = now;
    this.idFactory = idFactory;
  }

  list(options) {
    return this.registry.list(options);
  }

  get(name) {
    return this.registry.get(name);
  }

  search(query, options) {
    return this.registry.search(query, options);
  }

  describeCapabilities() {
    const base = this.registry.describeCapabilities?.() || {};
    return {
      ...base,
      execution: {
        schemaVersion: 1,
        authorityProfiles: [...AUTHORITY_PROFILES],
        localAutonomousTools: [...LOCAL_AUTONOMOUS_TOOL_NAMES],
        receiptSchema: 'capability.receipt.v1',
      },
    };
  }

  /**
   * Creates a serializable authority object.  Request handlers supply
   * trustedLocal from server-derived transport information; client JSON alone
   * is never treated as proof of local ownership.
   */
  createExecution(input = {}) {
    const authority = normalizeAuthority(input.authority, {
      idFactory: this.idFactory,
      now: this.now,
    });
    return Object.freeze({
      runId: optionalId(input.runId),
      toolRunId: optionalId(input.toolRunId),
      conversationId: optionalId(input.conversationId),
      projectId: optionalId(input.projectId),
      workspaceId: optionalId(input.workspaceId),
      worktreeId: optionalId(input.worktreeId),
      agentDepth: boundedInteger(input.agentDepth, 0, 0, 8),
      signal: input.signal,
      timeoutMs: positiveInteger(input.timeoutMs),
      state: input.state && typeof input.state === 'object' ? input.state : undefined,
      authority,
    });
  }

  authorize(tool, executionInput = {}) {
    const execution = hasAuthority(executionInput)
      ? executionInput
      : this.createExecution(executionInput);
    if (!tool?.name) {
      throw new CapabilityRuntimeError('CAPABILITY_TOOL_UNKNOWN', 'The requested capability is unavailable.', 404);
    }
    const risk = String(tool.risk || 'read').trim().toLowerCase();
    const source = String(tool.source || '').trim().toLowerCase();
    const toolName = String(tool.name).trim();
    const authority = execution.authority;
    const allowed = authorizationFor({ toolName, source, risk, authority, execution });
    if (!allowed) {
      throw new CapabilityRuntimeError(
        'CAPABILITY_AUTHORITY_DENIED',
        `Authority ${authority.profile} does not grant ${toolName}.`,
        403,
        { tool: toolName, source, profile: authority.profile },
      );
    }
    return Object.freeze({
      automatic: authority.profile === 'workspace_auto' || authority.profile === 'owner_local_full',
      mode: authority.profile,
      tool: toolName,
      source,
      authorityId: authority.id,
    });
  }

  /**
   * Executes a tool once and returns a normalized receipt for persistence and
   * replay. Adapter failures are represented as failed receipts rather than
   * leaking input values or destabilizing the parent task loop.
   */
  async execute(name, input = {}, executionInput = {}) {
    const execution = hasAuthority(executionInput)
      ? executionInput
      : this.createExecution(executionInput);
    const descriptor = this.registry.get(name);
    if (!descriptor) {
      throw new CapabilityRuntimeError('CAPABILITY_TOOL_UNKNOWN', `Unknown capability: ${String(name || '').trim()}.`, 404);
    }
    const authorization = this.authorize(descriptor, execution);
    const started = this.now();
    const receiptBase = {
      type: 'capability.receipt',
      schemaVersion: 1,
      receiptId: `capability-${this.idFactory()}`,
      runId: execution.runId || undefined,
      toolRunId: execution.toolRunId || undefined,
      conversationId: execution.conversationId || undefined,
      projectId: execution.projectId || undefined,
      workspaceId: execution.workspaceId || undefined,
      worktreeId: execution.worktreeId || undefined,
      tool: descriptor.name,
      source: descriptor.source || authorization.source,
      authority: {
        id: authorization.authorityId,
        profile: authorization.mode,
        automatic: authorization.automatic,
      },
      startedAt: started.toISOString(),
      input: redactValue(input),
    };
    try {
      const result = await this.registry.execute(descriptor.name, input, executionContext(execution, authorization));
      const completed = this.now();
      return Object.freeze({
        ...receiptBase,
        status: 'completed',
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        result: redactValue(result),
      });
    } catch (error) {
      const completed = this.now();
      return Object.freeze({
        ...receiptBase,
        status: 'failed',
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        error: normalizeError(error),
      });
    }
  }
}

export function createCapabilityRuntime(options) {
  return new CapabilityRuntime(options);
}

function executionContext(execution, authorization) {
  return {
    runId: execution.runId,
    toolRunId: execution.toolRunId,
    conversationId: execution.conversationId,
    projectId: execution.projectId,
    workspaceId: execution.workspaceId,
    worktreeId: execution.worktreeId,
    agentDepth: execution.agentDepth,
    signal: execution.signal,
    timeoutMs: execution.timeoutMs,
    state: execution.state,
    authority: execution.authority,
    approved: authorization.automatic,
    authorizationMode: authorization.mode,
  };
}

function normalizeAuthority(value, { idFactory, now }) {
  const source = value && typeof value === 'object' ? value : {};
  const profile = String(source.profile || 'observe').trim().toLowerCase();
  if (!AUTHORITY_PROFILES.has(profile)) {
    throw new CapabilityRuntimeError('CAPABILITY_AUTHORITY_PROFILE_INVALID', `Unsupported authority profile: ${profile || 'unknown'}.`, 400);
  }
  const issuedAt = source.issuedAt ? new Date(source.issuedAt) : now();
  if (Number.isNaN(issuedAt.getTime())) {
    throw new CapabilityRuntimeError('CAPABILITY_AUTHORITY_ISSUED_AT_INVALID', 'Authority issuedAt must be a valid date.', 400);
  }
  return Object.freeze({
    id: optionalId(source.id) || `authority-${idFactory()}`,
    profile,
    actorId: optionalId(source.actorId),
    trustedLocal: source.trustedLocal === true,
    grants: uniqueStrings(source.grants),
    issuedAt: issuedAt.toISOString(),
    expiresAt: normalizeExpiry(source.expiresAt),
  });
}

function authorizationFor({ toolName, source, risk, authority, execution }) {
  if (isExpired(authority.expiresAt)) return false;
  if (risk === 'read') return true;
  if (authority.profile === 'observe') return false;
  if (authority.profile === 'workspace_auto') {
    return authority.trustedLocal
      && execution.agentDepth === 0
      && source === 'workspace'
      && LOCAL_AUTONOMOUS_TOOL_NAMES.has(toolName);
  }
  if (authority.profile === 'owner_local_full') {
    return authority.trustedLocal;
  }
  return authority.grants.includes(toolName);
}

function redactValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.length > 16_384 ? `${value.slice(0, 16_384)}...[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(nested, depth + 1);
  }
  return result;
}

function normalizeError(error) {
  const raw = error && typeof error === 'object' ? error : {};
  return {
    code: optionalId(raw.code) || 'CAPABILITY_EXECUTION_FAILED',
    message: redactMessage(raw.message || String(error || 'Capability execution failed.')),
    status: positiveInteger(raw.status),
  };
}

function redactMessage(value) {
  return String(value || 'Capability execution failed.')
    .replace(/(bearer\s+)[^\s]+/ig, '$1[redacted]')
    .replace(/([a-z0-9_-]*(?:token|secret|key)[a-z0-9_-]*\s*[=:]\s*)[^\s,;]+/ig, '$1[redacted]')
    .slice(0, 2_000);
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function optionalId(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 200) : '';
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function normalizeExpiry(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CapabilityRuntimeError('CAPABILITY_AUTHORITY_EXPIRY_INVALID', 'Authority expiresAt must be a valid date.', 400);
  }
  return parsed.toISOString();
}

function isExpired(value) {
  return Boolean(value) && new Date(value).getTime() <= Date.now();
}

function hasAuthority(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && value.authority
      && typeof value.authority === 'object'
      && typeof value.authority.id === 'string'
      && typeof value.authority.profile === 'string'
      && typeof value.agentDepth === 'number',
  );
}
