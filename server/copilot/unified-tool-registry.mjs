import { searchToolCatalog } from '../copilot-capability-resolver.mjs';

/**
 * Presents data, local workspace, and outbound MCP tools through the registry
 * contract already consumed by DataCopilotRuntime. Each adapter remains the
 * authority for its own policy and execution context.
 */
export class UnifiedToolRegistry {
  constructor({ dataRegistry, workspaceAdapter = null, gitAdapter = null, mcpManager = null, subagentAdapter = null } = {}) {
    if (!dataRegistry) throw new TypeError('A data tool registry is required.');
    this.dataRegistry = dataRegistry;
    this.workspaceAdapter = workspaceAdapter;
    this.gitAdapter = gitAdapter;
    this.mcpManager = mcpManager;
    this.subagentAdapter = subagentAdapter;
  }

  list({ names = null } = {}) {
    const selected = names ? new Set(arrayOfStrings(names)) : null;
    return catalogDefinitions(this.#toolIndex())
      .filter((definition) => !selected || selected.has(definition.name));
  }

  get(name) {
    const entry = this.#toolIndex().get(normalizeToolName(name));
    return entry ? structuredClone(entry.definition) : null;
  }

  search(query = '', { limit = 20 } = {}) {
    return searchToolCatalog(catalogDefinitions(this.#toolIndex()), query, { limit: bounded(limit, 20, 1, 200) })
      .map(toolSummary);
  }

  describe(names = []) {
    const selected = new Set(arrayOfStrings(names));
    return catalogDefinitions(this.#toolIndex())
      .filter((definition) => selected.has(definition.name))
      .slice(0, 100);
  }

  async execute(name, input = {}, context = {}) {
    const toolName = normalizeToolName(name);
    const index = this.#toolIndex();
    if (toolName === 'tool.search') {
      const tools = searchToolCatalog(catalogDefinitions(index), input?.query, {
        limit: bounded(input?.limit, 10, 1, 40),
      }).map(toolSummary);
      activateTools(context.state, tools.map((tool) => tool.name));
      return { type: 'tool.catalog', query: String(input?.query || ''), tools, total: index.size };
    }
    if (toolName === 'tool.describe') {
      const selected = new Set(arrayOfStrings(input?.names));
      const tools = catalogDefinitions(index)
        .filter((definition) => selected.has(definition.name))
        .slice(0, 100);
      activateTools(context.state, tools.map((tool) => tool.name));
      return { type: 'tool.catalog', tools };
    }
    const entry = index.get(toolName);
    if (!entry) throw registryError('COPILOT_TOOL_UNKNOWN', `Unknown Copilot tool: ${toolName}.`, 404);
    return entry.execute(toolName, input, context);
  }

  describeCapabilities() {
    const tools = this.list();
    return {
      schemaVersion: 1,
      total: tools.length,
      sources: {
        data: tools.filter((tool) => tool.source === 'data').length,
        workspace: tools.filter((tool) => tool.source === 'workspace').length,
        git: tools.filter((tool) => tool.source === 'git').length,
        mcp: tools.filter((tool) => tool.source === 'mcp').length,
        agent: tools.filter((tool) => tool.source === 'agent').length,
      },
      outboundMcp: this.mcpManager?.describe?.() || { initialized: false, servers: [], toolCount: 0 },
      subagents: this.subagentAdapter?.describe?.() || { enabled: false, toolCount: 0 },
    };
  }

  #toolIndex() {
    const index = new Map();
    const sources = [
      {
        source: 'data',
        definitions: this.dataRegistry.list(),
        execute: (name, input, context) => this.dataRegistry.execute(name, input, context),
      },
      {
        source: 'workspace',
        definitions: this.workspaceAdapter?.list?.() || [],
        execute: (name, input, context) => this.workspaceAdapter.execute(name, input, context),
      },
      {
        source: 'git',
        definitions: this.gitAdapter?.list?.() || [],
        execute: (name, input, context) => this.gitAdapter.execute(name, input, context),
      },
      {
        source: 'mcp',
        definitions: this.mcpManager?.listTools?.() || [],
        // Preserve the caller's durable execution envelope. MCP transports
        // currently consume cancellation and timeout directly, while the
        // remaining fields are available to the broker/transport as the MCP
        // protocol surface grows (trace, authority, and idempotency).
        execute: (name, input, context) => this.mcpManager.execute(name, input, {
          ...context,
          signal: context.signal,
          timeoutMs: context.timeoutMs,
        }),
      },
      {
        source: 'agent',
        definitions: this.subagentAdapter?.list?.() || [],
        execute: (name, input, context) => this.subagentAdapter.execute(name, input, context),
      },
    ];
    for (const adapter of sources) {
      for (const rawDefinition of Array.isArray(adapter.definitions) ? adapter.definitions : []) {
        const name = normalizeToolName(rawDefinition?.name);
        if (!name) continue;
        const existing = index.get(name);
        if (existing) {
          throw registryError(
            'COPILOT_TOOL_NAME_CONFLICT',
            `Tool name "${name}" is registered by both ${existing.source} and ${adapter.source}.`,
            409,
          );
        }
        index.set(name, {
          source: adapter.source,
          definition: structuredClone({ ...rawDefinition, name, source: adapter.source }),
          execute: adapter.execute,
        });
      }
    }
    return index;
  }
}

export function createUnifiedToolRegistry(options) { return new UnifiedToolRegistry(options); }

function catalogDefinitions(index) {
  return [...index.values()].map((entry) => structuredClone(entry.definition));
}

function normalizeToolName(value) {
  return String(value || '').trim();
}

function activateTools(state, names) {
  if (!state || typeof state !== 'object') return;
  state.activeToolNames = [...new Set([...(state.activeToolNames || []), ...names])].slice(0, 100);
}

function toolSummary(tool) {
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description || '',
    category: tool.category || 'general',
    risk: tool.risk || 'read',
    scopes: Array.isArray(tool.scopes) ? tool.scopes : [],
    idempotent: tool.idempotent !== false,
    parallelSafe: tool.parallelSafe !== false,
    source: tool.source || 'unknown',
    serverId: tool.serverId || undefined,
  };
}

function arrayOfStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function registryError(code, message, status) {
  const error = new Error(message);
  error.name = 'UnifiedToolRegistryError';
  error.code = code;
  error.status = status;
  return error;
}
