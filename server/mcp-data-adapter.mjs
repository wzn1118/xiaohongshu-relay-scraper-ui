import crypto from 'node:crypto';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const TASK_RESOURCES = Object.freeze(['applications', 'content', 'audience', 'expansion']);
const CONVERSATION_RESOURCES = Object.freeze(['attachments', 'artifacts']);

export class McpDataAdapter {
  constructor({ policy, registry, artifacts = null } = {}) {
    if (!policy || !registry) throw new TypeError('MCP data policy and tool registry are required.');
    this.policy = policy;
    this.registry = registry;
    this.artifacts = artifacts;
  }

  listResources(reference, conversation = null) {
    this.policy.validateReference(reference, conversation);
    const names = reference.mode === 'application'
      ? [...TASK_RESOURCES, ...CONVERSATION_RESOURCES]
      : [...TASK_RESOURCES.filter((name) => name !== 'applications'), ...CONVERSATION_RESOURCES];
    return names.map((name) => ({
      name,
      uri: this.policy.resourceUri(reference, name),
      mimeType: 'application/json',
      description: resourceDescription(name),
    }));
  }

  listTools(reference = null, conversation = null) {
    if (reference) this.policy.validateSnapshot(reference, conversation);
    return this.registry.list()
      .filter((tool) => {
        if (!reference) return true;
        try {
          this.policy.authorizeTool(reference, tool.name, conversation, tool.scopes);
          return true;
        } catch (error) {
          if (error?.code === 'COPILOT_SCOPE_DENIED') return false;
          throw error;
        }
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.risk === 'read',
          destructiveHint: tool.risk === 'approval_required',
          idempotentHint: tool.idempotent !== false,
        },
        _meta: {
          scopes: tool.scopes,
          risk: tool.risk,
          version: tool.version,
          idempotent: tool.idempotent !== false,
          parallelSafe: tool.parallelSafe !== false,
        },
      }));
  }

  async readResource(reference, conversation, uri) {
    const resource = this.listResources(reference, conversation)
      .find((candidate) => candidate.uri === String(uri || ''));
    if (!resource) throw adapterError('COPILOT_RESOURCE_DENIED', 'The MCP resource URI is not in the conversation whitelist.', 403);

    let value;
    if (resource.name === 'attachments') {
      if (!this.artifacts?.listAttachments) throw adapterError('COPILOT_MCP_RESOURCE_UNAVAILABLE', 'Attachment resources are unavailable.', 503);
      value = await this.artifacts.listAttachments(reference);
    } else if (resource.name === 'artifacts') {
      if (!this.artifacts?.listArtifacts) throw adapterError('COPILOT_MCP_RESOURCE_UNAVAILABLE', 'Artifact resources are unavailable.', 503);
      value = await this.artifacts.listArtifacts(reference);
    } else {
      this.policy.validateSnapshot(reference, conversation);
      value = await this.#readTaskResource(reference, conversation, resource.name);
    }
    return {
      contents: [{
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: JSON.stringify(value),
      }],
    };
  }

  async callTool(reference, conversation, name, input, {
    requestId = null,
    approved = false,
    idempotencyKey = '',
  } = {}) {
    const tool = this.registry.get(name);
    if (!tool) throw adapterError('COPILOT_TOOL_UNKNOWN', `Unknown data tool: ${name}.`, 404);
    if (tool.risk === 'approval_required' && !approved) {
      throw adapterError(
        'COPILOT_APPROVAL_REQUIRED',
        'This tool requires confirmation in the Data Copilot conversation and cannot run directly over MCP.',
        409,
      );
    }
    return this.registry.execute(name, input, this.#toolContext(
      reference,
      conversation,
      requestId,
      name,
      input,
      { approved, idempotencyKey },
    ));
  }

  async handleRequest(reference, conversation, request = {}) {
    const id = Object.hasOwn(request, 'id') ? request.id : null;
    if (request?.jsonrpc !== '2.0' || typeof request?.method !== 'string') {
      return rpcError(id, -32600, 'Invalid MCP JSON-RPC request.', 'COPILOT_MCP_REQUEST_INVALID');
    }
    try {
      let result;
      if (request.method === 'initialize') {
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { resources: { listChanged: false }, tools: { listChanged: false } },
          serverInfo: { name: 'xiaohongshu-data-copilot', version: '1.0.0' },
          instructions: 'Access is limited to the bound Data Copilot snapshot and whitelisted xhs-data resources and tools.',
        };
      } else if (request.method === 'ping') {
        result = {};
      } else if (request.method === 'resources/list') {
        result = { resources: this.listResources(reference, conversation) };
      } else if (request.method === 'resources/read') {
        result = await this.readResource(reference, conversation, request.params?.uri);
      } else if (request.method === 'tools/list') {
        result = { tools: this.listTools(reference, conversation) };
      } else if (request.method === 'tools/call') {
        try {
          const output = await this.callTool(
            reference,
            conversation,
            request.params?.name,
            objectValue(request.params?.arguments),
            { requestId: id },
          );
          result = toolResult(output, false);
        } catch (error) {
          result = toolResult({
            error: {
              code: String(error?.code || 'COPILOT_TOOL_FAILED'),
              message: String(error?.message || 'The MCP tool call failed.'),
            },
          }, true);
        }
      } else if (request.method === 'notifications/initialized') {
        return null;
      } else {
        return rpcError(id, -32601, 'MCP method was not found.', 'COPILOT_MCP_METHOD_NOT_FOUND');
      }
      if (!Object.hasOwn(request, 'id')) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return rpcError(
        id,
        -32000,
        String(error?.message || 'MCP request failed.'),
        String(error?.code || 'COPILOT_MCP_FAILED'),
        Number(error?.status || 500),
      );
    }
  }

  async #readTaskResource(reference, conversation, name) {
    if (name === 'applications' || name === 'content') {
      return this.registry.execute('records.query', { dataset: name, limit: 200 }, this.#toolContext(reference, conversation, name, 'records.query', { dataset: name }));
    }
    if (name === 'audience') {
      const context = this.#toolContext(reference, conversation, name, 'records.query', { dataset: 'audience' });
      const [comments, users, posts] = await Promise.all([
        this.registry.execute('records.query', { dataset: 'comments', limit: 200 }, context),
        this.registry.execute('records.query', { dataset: 'users', limit: 200 }, context),
        this.registry.execute('records.query', { dataset: 'audience.posts', limit: 200 }, context),
      ]);
      return { comments, users, posts };
    }
    if (name === 'expansion') {
      const kinds = ['users', 'posts', 'comments', 'relations'];
      const entries = await Promise.all(kinds.map(async (kind) => [
        kind,
        await this.registry.execute(
          'expansion.trace',
          { kind, limit: 500 },
          this.#toolContext(reference, conversation, kind, 'expansion.trace', { kind }),
        ),
      ]));
      return Object.fromEntries(entries);
    }
    throw adapterError('COPILOT_RESOURCE_DENIED', 'The MCP task resource is not available.', 403);
  }

  #toolContext(reference, conversation, requestId, name, input, { approved = false, idempotencyKey = '' } = {}) {
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify({ conversationId: reference.conversationId, requestId, name, input }))
      .digest('hex');
    return {
      reference,
      conversation,
      state: {},
      approved,
      idempotencyKey: idempotencyKey || `mcp:${digest.slice(0, 48)}`,
    };
  }
}

function toolResult(value, isError) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function rpcError(id, code, message, applicationCode, status = 400) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data: { code: applicationCode, status } },
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resourceDescription(name) {
  return {
    applications: 'Application records in the bound task snapshot.',
    content: 'Collected post content in the bound task snapshot.',
    audience: 'Audience comments, users, and source posts in the bound task snapshot.',
    expansion: 'Relationship expansion records in the bound task snapshot.',
    attachments: 'Files uploaded to this conversation.',
    artifacts: 'Files generated by this conversation.',
  }[name];
}

function adapterError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
