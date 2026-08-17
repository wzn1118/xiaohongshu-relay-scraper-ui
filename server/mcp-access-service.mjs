import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ACTIVE_GRANTS = 20;
const MAX_GRANTS_PER_MINUTE = 5;
const RISK_RANK = Object.freeze({ read: 0, write: 1, approval_required: 2 });
const RESOURCE_SCOPES = Object.freeze({
  applications: 'applications:read',
  content: 'content:read',
  audience: 'audience:read',
  expansion: 'expansion:read',
  attachments: 'attachment:read',
  artifacts: 'artifact:read',
});

export class McpAccessService {
  constructor({
    productionStore,
    dataCopilotService,
    adapter,
    registry,
    approvals,
    tokenPepperPath,
    endpoint = 'http://127.0.0.1:4328/mcp',
    limits = {},
    now = () => new Date(),
  } = {}) {
    if (!productionStore || !dataCopilotService || !adapter || !registry || !approvals) {
      throw new TypeError('MCP production store, Copilot service, adapter, registry, and approval store are required.');
    }
    this.productionStore = productionStore;
    this.dataCopilotService = dataCopilotService;
    this.adapter = adapter;
    this.registry = registry;
    this.approvals = approvals;
    this.tokenPepperPath = path.resolve(String(tokenPepperPath || path.join(process.cwd(), 'data', 'auth', 'mcp-token-pepper')));
    this.endpoint = String(endpoint);
    this.now = now;
    this.pepper = null;
    this.limits = Object.freeze({
      maxOutputBytes: boundedInteger(limits.maxOutputBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024),
      toolTimeoutMs: boundedInteger(limits.toolTimeoutMs, 120_000, 1_000, 15 * 60 * 1000),
      maxConcurrentToolsPerGrant: boundedInteger(limits.maxConcurrentToolsPerGrant, 4, 1, 32),
      maxCallsPerMinute: boundedInteger(limits.maxCallsPerMinute, 120, 1, 10_000),
    });
    this.toolActivity = new Map();
  }

  async initialize() {
    await mkdir(path.dirname(this.tokenPepperPath), { recursive: true });
    try {
      this.pepper = await readFile(this.tokenPepperPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const generated = crypto.randomBytes(32);
      try {
        await writeFile(this.tokenPepperPath, generated, { flag: 'wx', mode: 0o600 });
        this.pepper = generated;
      } catch (writeError) {
        if (writeError?.code !== 'EEXIST') throw writeError;
        this.pepper = await readFile(this.tokenPepperPath);
      }
    }
    if (!this.pepper || this.pepper.length < 32) {
      throw accessError('MCP_TOKEN_PEPPER_INVALID', 'The MCP token pepper must contain at least 32 bytes.', 500);
    }
    this.reconcilePersistedSessions();
    return this.status();
  }

  reconcilePersistedSessions() {
    const activeSessions = this.productionStore.listMcpSessions({ limit: 500 })
      .filter((session) => session.status === 'active');
    for (const session of activeSessions) {
      this.productionStore.closeMcpSession(session.sessionId);
    }
    return activeSessions.length;
  }

  async getCapabilities(conversationId) {
    const { reference, conversation, snapshot } = await this.dataCopilotService.getMcpContext(requiredText(conversationId, 'conversationId'));
    const resources = this.adapter.listResources(reference, conversation).map((resource) => ({
      name: resource.name,
      uri: resource.uri,
      mimeType: resource.mimeType,
      scope: RESOURCE_SCOPES[resource.name],
    }));
    const tools = this.adapter.listTools(reference, conversation).map((tool) => ({
      name: tool.name,
      description: tool.description,
      scopes: normalizeStrings(tool._meta?.scopes),
      risk: normalizeRisk(tool._meta?.risk),
      version: String(tool._meta?.version || '1.0.0'),
      idempotent: tool._meta?.idempotent !== false,
      parallelSafe: tool._meta?.parallelSafe !== false,
    }));
    return {
      conversationId: reference.conversationId,
      jobId: reference.jobId,
      snapshotId: reference.snapshotId,
      manifestHash: snapshot.manifestHash,
      mode: reference.mode,
      scopes: normalizeStrings([
        ...tools.flatMap((tool) => tool.scopes),
        ...resources.map((resource) => resource.scope),
      ]),
      resources,
      tools,
      riskLevels: Object.keys(RISK_RANK),
    };
  }

  async createGrant(value = {}, actor = {}, internal = {}) {
    this.#requireInitialized();
    const owner = actorIdentity(actor);
    rejectServerBoundFields(value);
    this.#assertCreationAllowed(owner, internal.exemptActiveGrantId);
    const conversationId = requiredText(value.conversationId, 'conversationId');
    const { reference, conversation, snapshot } = await this.dataCopilotService.getMcpContext(conversationId);
    const availableTools = this.adapter.listTools(reference, conversation);
    const availableByName = new Map(availableTools.map((tool) => [tool.name, tool]));
    const conversationScopes = normalizeStrings(reference.scope?.allowedScopes);
    const availableResources = this.adapter.listResources(reference, conversation);
    const allAvailableScopes = normalizeStrings([
      ...availableTools.flatMap((tool) => tool._meta?.scopes || []),
      ...availableResources.map((resource) => RESOURCE_SCOPES[resource.name]),
    ]);
    const suppliedScopes = normalizeStrings(value.allowedScopes || value.scopes);
    const requestedScopes = suppliedScopes.length
      ? suppliedScopes
      : allAvailableScopes;
    if (conversationScopes.length && !conversationScopes.includes('*')) {
      for (const scope of requestedScopes) {
        if (!conversationScopes.includes(scope)) {
          throw accessError('MCP_GRANT_SCOPE_DENIED', `Scope ${scope} is not present in the conversation grant.`, 403);
        }
      }
    }
    const maxRisk = normalizeRisk(value.maxRisk || 'approval_required');
    const requestedTools = normalizeStrings(value.allowedTools);
    const allowedTools = requestedTools.length
      ? requestedTools
      : availableTools
          .filter((tool) => normalizeStrings(tool._meta?.scopes).every((scope) => requestedScopes.includes(scope)))
          .filter((tool) => riskAllowed(tool._meta?.risk, maxRisk))
          .map((tool) => tool.name);
    for (const toolName of allowedTools) {
      const tool = availableByName.get(toolName);
      if (!tool) throw accessError('MCP_GRANT_TOOL_DENIED', `Tool ${toolName} is not available in the bound conversation.`, 403);
      const missing = normalizeStrings(tool._meta?.scopes).find((scope) => !requestedScopes.includes(scope));
      if (missing) throw accessError('MCP_GRANT_SCOPE_DENIED', `Tool ${toolName} requires scope ${missing}.`, 403);
      if (!riskAllowed(tool._meta?.risk, maxRisk)) {
        throw accessError('MCP_GRANT_RISK_DENIED', `Tool ${toolName} exceeds maxRisk ${maxRisk}.`, 403);
      }
    }

    const availableResourceNames = new Set(availableResources.map((resource) => resource.name));
    const suppliedResources = normalizeStrings(value.allowedResources);
    const allowedResources = suppliedResources.length
      ? suppliedResources
      : availableResources
          .filter((resource) => requestedScopes.includes(RESOURCE_SCOPES[resource.name]))
          .map((resource) => resource.name);
    for (const resourceName of allowedResources) {
      if (!availableResourceNames.has(resourceName)) {
        throw accessError('MCP_GRANT_RESOURCE_DENIED', `Resource ${resourceName} is not available in the bound conversation.`, 403);
      }
      const requiredScope = RESOURCE_SCOPES[resourceName];
      if (!requiredScope || !requestedScopes.includes(requiredScope)) {
        throw accessError('MCP_GRANT_SCOPE_DENIED', `Resource ${resourceName} requires scope ${requiredScope || 'unknown'}.`, 403);
      }
    }

    const ttlSeconds = boundedInteger(value.ttlSeconds ?? value.expiresInSeconds, DEFAULT_TTL_SECONDS, 60, MAX_TTL_SECONDS);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    const grantId = crypto.randomUUID();
    const token = `xhs_mcp_${grantId}.${crypto.randomBytes(32).toString('base64url')}`;
    const tokenPrefix = `xhs_mcp_${grantId.slice(0, 8)}`;
    const grant = this.productionStore.createMcpGrant({
      grantId,
      tokenHash: this.#tokenHash(token),
      tokenPrefix,
      name: boundedText(value.name || 'Local MCP access', 'name', 100),
      owner,
      conversationId,
      jobId: reference.jobId,
      snapshotId: reference.snapshotId,
      manifestHash: snapshot.manifestHash,
      mode: reference.mode,
      scopes: requestedScopes,
      allowedTools,
      allowedResources,
      maxRisk,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      metadata: objectValue(value.metadata),
    });
    this.#audit(grant, 'grant.created', 'completed', {
      scopes: grant.scopes,
      allowedTools: grant.allowedTools,
      expiresAt: grant.expiresAt,
    });
    return { grant: publicGrant(grant, this.endpoint, this.now()), token, tokenReturnedOnce: true };
  }

  listGrants(actor = {}, options = {}) {
    const owner = actorIdentity(actor);
    return {
      grants: this.productionStore.listMcpGrants({ owner, limit: options.limit })
        .map((grant) => publicGrant(grant, this.endpoint, this.now())),
    };
  }

  getGrant(grantId, actor = {}) {
    return { grant: publicGrant(this.#ownedGrant(grantId, actorIdentity(actor)), this.endpoint, this.now()) };
  }

  revokeGrant(grantId, actor = {}) {
    const owner = actorIdentity(actor);
    const grant = this.#ownedGrant(grantId, owner);
    const revoked = this.productionStore.revokeMcpGrant(grant.grantId);
    for (const session of this.productionStore.listMcpSessions({ grantId: grant.grantId, limit: 500 })) {
      if (session.status === 'active') this.productionStore.closeMcpSession(session.sessionId);
    }
    this.#audit(revoked, 'grant.revoked', 'completed');
    return { grant: publicGrant(revoked, this.endpoint, this.now()) };
  }

  async rotateGrant(grantId, value = {}, actor = {}) {
    const owner = actorIdentity(actor);
    const previous = this.#ownedGrant(grantId, owner);
    if (previous.status !== 'active') throw accessError('MCP_GRANT_NOT_ACTIVE', 'Only an active Grant can be rotated.', 409);
    const replacement = await this.createGrant({
      name: value.name || previous.name,
      conversationId: previous.conversationId,
      allowedScopes: previous.scopes,
      allowedTools: previous.allowedTools,
      allowedResources: previous.allowedResources,
      maxRisk: previous.maxRisk,
      ttlSeconds: value.ttlSeconds ?? value.expiresInSeconds ?? remainingSeconds(previous.expiresAt, this.now()),
      metadata: { ...previous.metadata, rotatedFromGrantId: previous.grantId },
    }, actor, { exemptActiveGrantId: previous.grantId });
    this.revokeGrant(previous.grantId, actor);
    this.#audit(this.productionStore.getMcpGrant(replacement.grant.grantId), 'grant.rotated', 'completed', {
      previousGrantId: previous.grantId,
    });
    return { ...replacement, previousGrantId: previous.grantId };
  }

  async rebindGrant(grantId, value = {}, actor = {}) {
    const owner = actorIdentity(actor);
    const previous = this.#ownedGrant(grantId, owner);
    if (previous.status !== 'active') throw accessError('MCP_GRANT_NOT_ACTIVE', 'Only an active Grant can be rebound.', 409);
    const conversationId = requiredText(value.conversationId, 'conversationId');
    const replacement = await this.createGrant({
      name: value.name || previous.name,
      conversationId,
      allowedScopes: value.allowedScopes || previous.scopes,
      allowedTools: value.allowedTools || previous.allowedTools,
      allowedResources: value.allowedResources || previous.allowedResources,
      maxRisk: value.maxRisk || previous.maxRisk,
      ttlSeconds: value.ttlSeconds ?? value.expiresInSeconds ?? remainingSeconds(previous.expiresAt, this.now()),
      metadata: { ...previous.metadata, reboundFromGrantId: previous.grantId },
    }, actor, { exemptActiveGrantId: previous.grantId });
    this.revokeGrant(previous.grantId, actor);
    this.#audit(this.productionStore.getMcpGrant(replacement.grant.grantId), 'grant.rebound', 'completed', {
      previousGrantId: previous.grantId,
    });
    return { ...replacement, previousGrantId: previous.grantId };
  }

  listGrantAudit(grantId, actor = {}, options = {}) {
    const grant = this.#ownedGrant(grantId, actorIdentity(actor));
    return { events: this.productionStore.listMcpAudit({ grantId: grant.grantId, limit: options.limit }) };
  }

  async authenticateRequest(req) {
    const header = String(req?.headers?.authorization || '');
    const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
    if (!match) throw accessError('MCP_AUTH_REQUIRED', 'A Bearer Grant token is required.', 401);
    return this.authenticateToken(match[1]);
  }

  async authenticateToken(token) {
    this.#requireInitialized();
    const grant = this.productionStore.findMcpGrantByTokenHash(this.#tokenHash(requiredText(token, 'token')));
    if (!grant) throw accessError('MCP_GRANT_INVALID', 'The MCP Grant token is invalid.', 401);
    if (grant.status !== 'active') throw accessError('MCP_GRANT_REVOKED', 'The MCP Grant is not active.', 401);
    if (Date.parse(grant.expiresAt) <= this.now().getTime()) throw accessError('MCP_GRANT_EXPIRED', 'The MCP Grant has expired.', 401);
    const { reference, conversation, snapshot } = await this.dataCopilotService.getMcpContext(grant.conversationId);
    if (
      reference.jobId !== grant.jobId
      || reference.snapshotId !== grant.snapshotId
      || reference.mode !== grant.mode
      || snapshot.manifestHash !== grant.manifestHash
    ) throw accessError('MCP_GRANT_CONTEXT_STALE', 'The MCP Grant no longer matches its bound snapshot.', 409);
    this.productionStore.touchMcpGrant(grant.grantId, this.now().toISOString());
    return { grant, reference, conversation };
  }

  listResources(context) {
    const allowed = new Set(context.grant.allowedResources);
    return this.adapter.listResources(context.reference, context.conversation)
      .filter((resource) => allowed.has(resource.name))
      .filter((resource) => context.grant.scopes.includes(RESOURCE_SCOPES[resource.name]));
  }

  listTools(context) {
    const allowed = new Set(context.grant.allowedTools);
    return this.adapter.listTools(context.reference, context.conversation)
      .filter((tool) => allowed.has(tool.name))
      .filter((tool) => normalizeStrings(tool._meta?.scopes).every((scope) => context.grant.scopes.includes(scope)))
      .filter((tool) => riskAllowed(tool._meta?.risk, context.grant.maxRisk));
  }

  async readResource(context, uri) {
    const release = this.#beginToolRequest(context.grant.grantId);
    try {
      const resource = this.listResources(context).find((item) => item.uri === String(uri || ''));
      if (!resource) throw accessError('MCP_RESOURCE_DENIED', 'The resource is outside this Grant.', 403);
      const result = await this.#withToolTimeout(() => this.adapter.readResource(context.reference, context.conversation, resource.uri));
      return this.#boundedResource(result, resource.uri);
    } finally {
      release();
    }
  }

  async executeTool(context, name, input = {}, options = {}) {
    const release = this.#beginToolRequest(context.grant.grantId);
    try {
      return await this.#executeTool(context, name, input, options);
    } finally {
      release();
    }
  }

  async #executeTool(context, name, input = {}, options = {}) {
    const tool = this.registry.get(name);
    if (!tool || !this.listTools(context).some((item) => item.name === name)) {
      throw accessError('MCP_TOOL_DENIED', 'The tool is outside this Grant.', 403);
    }
    const request = { name, input: objectValue(input) };
    const requestHash = sha256(stableJson(request));
    const actionHash = actionDigest(context.grant, tool, name, request.input);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey || `request:${options.sessionId || 'stdio'}:${options.requestId || requestHash}`);
    const begun = this.productionStore.beginMcpToolRun({
      grantId: context.grant.grantId,
      sessionId: String(options.sessionId || ''),
      idempotencyKey,
      requestHash,
      actionHash,
      toolName: name,
    });
    if (begun.duplicate) return duplicateToolResult(begun.run);
    const run = begun.run;

    if (tool.risk === 'approval_required') {
      const approval = await this.approvals.createApproval(context.reference, {
        runId: `mcp-${run.callId}`,
        toolRunId: run.callId,
        toolName: name,
        riskLevel: 'high',
        summary: `MCP Grant requested ${name}.`,
        arguments: request.input,
        binding: {
          source: 'mcp',
          grantId: context.grant.grantId,
          snapshotId: context.grant.snapshotId,
          manifestHash: context.grant.manifestHash,
          actionHash,
          toolVersion: String(tool.version || tool._meta?.version || '1.0.0'),
        },
        expiresAt: new Date(this.now().getTime() + 15 * 60 * 1000).toISOString(),
        idempotencyKey: `mcp-approval:${run.callId}`,
      });
      const pending = this.productionStore.updateMcpToolRun(run.callId, {
        status: 'approval_required',
        approvalId: approval.approvalId,
        result: { status: 'approval_required', approvalId: approval.approvalId, requestHash, actionHash },
      });
      this.#audit(context.grant, 'tool.approval_required', 'pending', {
        sessionId: options.sessionId,
        callId: run.callId,
        toolName: name,
        approvalId: approval.approvalId,
        requestHash,
        actionHash,
      });
      return pending.result;
    }

    try {
      const result = this.#boundedToolResult(await this.#withToolTimeout(() => this.adapter.callTool(
        context.reference,
        context.conversation,
        name,
        request.input,
        { requestId: options.requestId, idempotencyKey },
      )));
      this.productionStore.updateMcpToolRun(run.callId, {
        status: 'completed', result, completedAt: this.now().toISOString(),
      });
      this.#audit(context.grant, 'tool.completed', 'completed', {
        sessionId: options.sessionId, callId: run.callId, toolName: name, requestHash, actionHash,
      });
      return result;
    } catch (error) {
      this.productionStore.updateMcpToolRun(run.callId, {
        status: 'failed',
        error: errorValue(error),
        completedAt: this.now().toISOString(),
      });
      this.#audit(context.grant, 'tool.failed', 'failed', {
        sessionId: options.sessionId, callId: run.callId, toolName: name,
        requestHash, actionHash, code: String(error?.code || 'MCP_TOOL_FAILED'),
      });
      throw error;
    }
  }

  async decideApproval(approvalId, value = {}, actor = {}) {
    const owner = actorIdentity(actor);
    const run = this.productionStore.getMcpToolRunByApprovalId(approvalId);
    if (!run) throw accessError('MCP_APPROVAL_NOT_FOUND', 'The MCP approval was not found.', 404);
    const grant = this.#ownedGrant(run.grantId, owner);
    const context = await this.authenticateGrantRecord(grant);
    const approval = await this.approvals.getApproval(context.reference, approvalId, { expireDue: true });
    if (!approval) throw accessError('MCP_APPROVAL_NOT_FOUND', 'The MCP approval was not found.', 404);
    const approved = value.approved === true || value.action === 'approve';
    const rejected = value.approved === false || value.action === 'reject';
    if (!approved && !rejected) throw accessError('MCP_APPROVAL_DECISION_REQUIRED', 'Approval decision must be approve or reject.', 400);
    if (!approved) {
      const rejectedApproval = approval.status === 'pending'
        ? await this.approvals.reject(context.reference, approval.approvalId, {
            idempotencyKey: `mcp-reject:${approval.approvalId}`,
            expectedRequestHash: approval.requestHash,
            actor: owner,
            reason: String(value.reason || 'user_rejected').slice(0, 1000),
          })
        : approval;
      const rejectedRun = this.productionStore.updateMcpToolRun(run.callId, {
        status: 'rejected',
        error: { code: 'MCP_APPROVAL_REJECTED', message: 'The MCP tool call was rejected.' },
        completedAt: this.now().toISOString(),
      });
      this.#audit(grant, 'approval.rejected', 'completed', { callId: run.callId, approvalId });
      return { approval: rejectedApproval, toolRun: rejectedRun };
    }
    if (run.status === 'completed') return { approval, toolRun: run, duplicate: true };
    const tool = this.registry.get(run.toolName);
    const expectedActionHash = tool ? actionDigest(context.grant, tool, run.toolName, approval.arguments) : '';
    if (
      !tool
      || !this.listTools(context).some((item) => item.name === run.toolName)
      || !run.actionHash
      || run.actionHash !== expectedActionHash
      || approval.binding?.source !== 'mcp'
      || approval.binding?.grantId !== grant.grantId
      || approval.binding?.snapshotId !== grant.snapshotId
      || approval.binding?.manifestHash !== grant.manifestHash
      || approval.binding?.actionHash !== run.actionHash
    ) {
      throw accessError('MCP_APPROVAL_MISMATCH', 'The approval no longer matches the exact Grant-bound action.', 409);
    }
    const approvedApproval = approval.status === 'pending'
      ? await this.approvals.approve(context.reference, approval.approvalId, {
          idempotencyKey: `mcp-approve:${approval.approvalId}`,
          expectedRequestHash: approval.requestHash,
          actor: owner,
          reason: String(value.reason || 'user_approved').slice(0, 1000),
        })
      : approval;
    if (approvedApproval.status !== 'approved') {
      throw accessError('MCP_APPROVAL_STATE_INVALID', `Approval is ${approvedApproval.status}.`, 409);
    }
    try {
      const result = this.#boundedToolResult(await this.#withToolTimeout(() => this.adapter.callTool(
        context.reference,
        context.conversation,
        run.toolName,
        approval.arguments,
        { requestId: run.callId, approved: true, idempotencyKey: run.idempotencyKey },
      )), { summarize: true });
      const consumed = await this.approvals.consume(context.reference, approval.approvalId, {
        idempotencyKey: `mcp-consume:${approval.approvalId}`,
        expectedRequestHash: approval.requestHash,
        actor: 'mcp-runtime',
        reason: 'tool_completed',
      });
      const completed = this.productionStore.updateMcpToolRun(run.callId, {
        status: 'completed', result, completedAt: this.now().toISOString(),
      });
      this.#audit(grant, 'approval.consumed', 'completed', { callId: run.callId, approvalId });
      return { approval: consumed, toolRun: completed };
    } catch (error) {
      this.productionStore.updateMcpToolRun(run.callId, {
        status: 'failed',
        error: errorValue(error),
        completedAt: this.now().toISOString(),
      });
      this.#audit(grant, 'approval.execution_failed', 'failed', {
        callId: run.callId,
        approvalId,
        toolName: run.toolName,
        code: String(error?.code || 'MCP_TOOL_FAILED'),
      });
      throw error;
    }
  }

  async authenticateGrantRecord(grant) {
    if (!grant || grant.status !== 'active') throw accessError('MCP_GRANT_REVOKED', 'The MCP Grant is not active.', 401);
    if (Date.parse(grant.expiresAt) <= this.now().getTime()) throw accessError('MCP_GRANT_EXPIRED', 'The MCP Grant has expired.', 401);
    const { reference, conversation, snapshot } = await this.dataCopilotService.getMcpContext(grant.conversationId);
    if (reference.jobId !== grant.jobId || reference.snapshotId !== grant.snapshotId || reference.mode !== grant.mode || snapshot.manifestHash !== grant.manifestHash) {
      throw accessError('MCP_GRANT_CONTEXT_STALE', 'The MCP Grant no longer matches its bound snapshot.', 409);
    }
    return { grant, reference, conversation };
  }

  registerSession(context, sessionId, client = {}, transport = 'streamable-http') {
    const session = this.productionStore.upsertMcpSession({
      sessionId, grantId: context.grant.grantId, client, transport,
    });
    this.#audit(context.grant, 'session.opened', 'completed', { sessionId, transport });
    return session;
  }

  touchSession(context, sessionId) {
    const existing = this.productionStore.getMcpSession(sessionId);
    if (!existing || existing.grantId !== context.grant.grantId || existing.status !== 'active') {
      throw accessError('MCP_SESSION_INVALID', 'The MCP session is invalid or belongs to another Grant.', 404);
    }
    return this.productionStore.upsertMcpSession({ ...existing, lastSeenAt: this.now().toISOString() });
  }

  closeSession(context, sessionId) {
    this.touchSession(context, sessionId);
    const session = this.productionStore.closeMcpSession(sessionId);
    this.#audit(context.grant, 'session.closed', 'completed', { sessionId });
    return session;
  }

  listSessions(actor = {}, options = {}) {
    const owner = actorIdentity(actor);
    const ownedGrantIds = new Set(this.productionStore.listMcpGrants({ owner, limit: 500 }).map((grant) => grant.grantId));
    return {
      sessions: this.productionStore.listMcpSessions({ grantId: options.grantId, limit: options.limit })
        .filter((session) => ownedGrantIds.has(session.grantId)),
    };
  }

  listToolRuns(actor = {}, options = {}) {
    const owner = actorIdentity(actor);
    const ownedGrantIds = new Set(this.productionStore.listMcpGrants({ owner, limit: 500 }).map((grant) => grant.grantId));
    return {
      toolRuns: this.productionStore.listMcpToolRuns(options).filter((run) => ownedGrantIds.has(run.grantId)),
    };
  }

  listAudit(actor = {}, options = {}) {
    const owner = actorIdentity(actor);
    return {
      events: this.productionStore.listMcpAudit(options).filter((event) => !event.owner || event.owner === owner),
    };
  }

  status() {
    const grants = this.productionStore.listMcpGrants({ limit: 500 });
    const sessions = this.productionStore.listMcpSessions({ limit: 500 });
    return {
      ok: true,
      service: 'xiaohongshu-relay-scraper-mcp',
      protocol: 'streamable-http',
      schemaVersion: this.productionStore.describe().schemaVersion,
      grants: {
        active: grants.filter((grant) => grant.status === 'active' && Date.parse(grant.expiresAt) > this.now().getTime()).length,
        total: grants.length,
      },
      sessions: {
        active: sessions.filter((session) => session.status === 'active').length,
        total: sessions.length,
      },
    };
  }

  #ownedGrant(grantId, owner) {
    const grant = this.productionStore.getMcpGrant(requiredText(grantId, 'grantId'));
    if (!grant) throw accessError('MCP_GRANT_NOT_FOUND', 'The MCP Grant was not found.', 404);
    if (grant.owner !== owner) throw accessError('MCP_GRANT_NOT_FOUND', 'The MCP Grant was not found.', 404);
    return grant;
  }

  #assertCreationAllowed(owner, exemptActiveGrantId = '') {
    const now = this.now();
    const grants = this.productionStore.listMcpGrants({ owner, limit: 500 });
    const active = grants.filter((grant) => grant.grantId !== exemptActiveGrantId
      && grant.status === 'active' && Date.parse(grant.expiresAt) > now.getTime());
    if (active.length >= MAX_ACTIVE_GRANTS) {
      throw accessError('MCP_GRANT_LIMIT_REACHED', `At most ${MAX_ACTIVE_GRANTS} active Grants are allowed.`, 429);
    }
    const cutoff = now.getTime() - 60_000;
    const recent = this.productionStore.listMcpAudit({ limit: 1000 })
      .filter((event) => event.owner === owner && event.action === 'grant.created' && Date.parse(event.occurredAt) > cutoff);
    if (recent.length >= MAX_GRANTS_PER_MINUTE) {
      throw accessError('MCP_GRANT_RATE_LIMITED', 'Grant creation is limited to five requests per minute.', 429);
    }
  }

  #beginToolRequest(grantId) {
    const now = this.now().getTime();
    const cutoff = now - 60_000;
    const current = this.toolActivity.get(grantId) || { active: 0, timestamps: [] };
    current.timestamps = current.timestamps.filter((timestamp) => timestamp > cutoff);
    if (current.timestamps.length >= this.limits.maxCallsPerMinute) {
      throw accessError('MCP_RATE_LIMITED', 'The MCP Grant exceeded its operation rate limit.', 429);
    }
    if (current.active >= this.limits.maxConcurrentToolsPerGrant) {
      throw accessError('MCP_RATE_LIMITED', 'The MCP Grant exceeded its concurrent operation limit.', 429);
    }
    current.timestamps.push(now);
    current.active += 1;
    this.toolActivity.set(grantId, current);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      current.active = Math.max(0, current.active - 1);
    };
  }

  async #withToolTimeout(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(accessError('MCP_TOOL_TIMEOUT', 'The MCP operation exceeded its time limit.', 504)), this.limits.toolTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #boundedToolResult(value, { summarize = false } = {}) {
    const bytes = jsonBytes(value);
    if (bytes <= this.limits.maxOutputBytes) return value;
    if (summarize) {
      return {
        truncated: true,
        code: 'MCP_OUTPUT_TRUNCATED',
        originalBytes: bytes,
        maximumBytes: this.limits.maxOutputBytes,
        summary: summarizeValue(value),
      };
    }
    throw accessError('MCP_OUTPUT_LIMIT_EXCEEDED', 'The MCP tool result exceeded the configured output limit.', 413);
  }

  #boundedResource(value, uri) {
    const bytes = jsonBytes(value);
    if (bytes <= this.limits.maxOutputBytes) return value;
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          truncated: true,
          code: 'MCP_OUTPUT_TRUNCATED',
          originalBytes: bytes,
          maximumBytes: this.limits.maxOutputBytes,
          continuationCursor: null,
          summary: summarizeValue(value),
          next: 'Use a scoped query tool with a smaller limit and cursor.',
        }),
      }],
    };
  }

  #tokenHash(token) {
    return crypto.createHmac('sha256', this.pepper).update(token).digest('hex');
  }

  #audit(grant, action, status, detail = {}) {
    this.productionStore.recordMcpAudit({
      grantId: grant?.grantId,
      sessionId: detail.sessionId,
      owner: grant?.owner,
      action,
      status,
      detail: objectValue(detail),
    });
  }

  #requireInitialized() {
    if (!this.pepper) throw accessError('MCP_ACCESS_NOT_INITIALIZED', 'The MCP access service is not initialized.', 503);
  }
}

function duplicateToolResult(run) {
  if (run.status === 'completed' || run.status === 'approval_required') return structuredClone(run.result);
  if (run.status === 'running') throw accessError('MCP_TOOL_RUN_ACTIVE', 'The identical MCP tool call is already running.', 409);
  const error = run.error || {};
  throw accessError(String(error.code || 'MCP_TOOL_RUN_FAILED'), String(error.message || `The prior MCP tool call ended as ${run.status}.`), 409);
}

function publicGrant(grant, endpoint, now) {
  const { tokenHash: _tokenHash, owner: _owner, ...value } = structuredClone(grant);
  if (value.status === 'active' && Date.parse(value.expiresAt) <= now.getTime()) value.status = 'expired';
  return { ...value, endpoint };
}

function actorIdentity(actor) {
  return requiredText(actor?.email || actor?.id || actor, 'actor');
}

function normalizeStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

function normalizeRisk(value) {
  const risk = String(value || 'read').trim();
  if (!Object.hasOwn(RISK_RANK, risk)) {
    throw accessError('MCP_GRANT_RISK_INVALID', 'maxRisk must be read, write, or approval_required.', 400);
  }
  return risk;
}

function riskAllowed(value, maximum) {
  return RISK_RANK[normalizeRisk(value)] <= RISK_RANK[normalizeRisk(maximum)];
}

function remainingSeconds(expiresAt, now) {
  return Math.max(60, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 1000));
}

function boundedText(value, field, maximum) {
  const text = requiredText(value, field);
  if (text.length > maximum) throw accessError('MCP_VALUE_INVALID', `${field} must contain at most ${maximum} characters.`, 400);
  return text;
}

function rejectServerBoundFields(value) {
  const forbidden = ['owner', 'ownerKey', 'jobId', 'snapshotId', 'revision', 'manifestHash', 'tokenHash', 'tokenPrefix'];
  const supplied = forbidden.find((field) => Object.hasOwn(value, field));
  if (supplied) throw accessError('MCP_SERVER_BOUND_FIELD', `${supplied} is assigned by the server.`, 400);
}

function normalizeIdempotencyKey(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 200) throw accessError('MCP_IDEMPOTENCY_KEY_INVALID', 'The MCP idempotency key must contain 1-200 characters.', 400);
  return text;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw accessError('MCP_VALUE_REQUIRED', `${field} is required.`, 400);
  return text;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
}

function errorValue(error) {
  return {
    code: String(error?.code || 'MCP_TOOL_FAILED'),
    message: String(error?.message || 'The MCP tool call failed.').slice(0, 1000),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function actionDigest(grant, tool, name, input) {
  return sha256(stableJson({
    grantId: grant.grantId,
    snapshotId: grant.snapshotId,
    manifestHash: grant.manifestHash,
    toolName: name,
    toolVersion: String(tool.version || tool._meta?.version || '1.0.0'),
    arguments: objectValue(input),
  }));
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw accessError('MCP_OUTPUT_INVALID', 'The MCP operation returned a non-serializable result.', 500);
  }
}

function summarizeValue(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (!value || typeof value !== 'object') return { type: typeof value };
  const summary = { type: 'object', keys: Object.keys(value).slice(0, 50) };
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (Array.isArray(item)) summary[`${key}Count`] = item.length;
    else if (item && typeof item === 'object' && Number.isSafeInteger(item.total)) summary[`${key}Total`] = item.total;
  }
  return summary;
}

function accessError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
