import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_TIMEOUT_MS = 120_000;
export const MCP_INTERNAL_TOOL_NAME_MAX_CHARS = 54;
export const MCP_MODEL_WIRE_TOOL_NAME_MAX_CHARS = 64;
export const MCP_RESULT_MAX_ITEMS = 64;
export const MCP_RESULT_MAX_BYTES = 120_000;
const MAX_RESULT_ITEM_BYTES = 32_000;
const MAX_STRUCTURED_STRING_BYTES = 4_000;
const MAX_NORMALIZED_NODES = 512;
const MAX_CONFIG_SERVERS = 256;
const MAX_TOOLS_PER_SERVER = 512;
const MAX_DIAGNOSTICS = 100;
const MAX_STDERR_DRAIN_BYTES = 64_000;
const STATIC_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'x-client',
  'x-client-name',
  'x-client-version',
]);
const FORBIDDEN_HEADER_NAMES = new Set([
  '__proto__',
  'connection',
  'constructor',
  'content-length',
  'host',
  'keep-alive',
  'proxy-connection',
  'prototype',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const REQUIRED_PROCESS_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
];

/**
 * Owns outbound MCP connections. The existing MCP access service is an
 * inbound server; this manager intentionally keeps the client lifecycle and
 * credentials separate from it.
 */
export class McpClientManager {
  constructor({
    configPath = null,
    fetchImpl = globalThis.fetch,
    env = process.env,
    now = () => new Date(),
    clientInfo = { name: 'xiaohongshu-data-copilot', version: '1.0.0' },
    connectOnInitialize = true,
    clientFactory = (info) => new Client(info, { capabilities: {} }),
    transportFactory = createTransport,
  } = {}) {
    this.configPath = configPath ? path.resolve(configPath) : null;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.now = now;
    this.clientInfo = clientInfo;
    this.connectOnInitialize = connectOnInitialize;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.servers = new Map();
    this.connections = new Map();
    this.toolIndex = new Map();
    this.diagnostics = [];
    this.initialized = false;
    this.closed = false;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ connect = this.connectOnInitialize } = {}) {
    if (this.initialized) return this.describe();
    const config = await this.#readConfig();
    for (const server of config.servers) this.servers.set(server.id, server);
    this.initialized = true;
    if (connect) await this.refresh();
    return this.describe();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const ids = [...this.connections.keys()];
    await Promise.all(ids.map((id) => this.#disconnect(id)));
    this.toolIndex.clear();
    try { await this.writeQueue; } catch { /* a caller already received the persistence error */ }
  }

  describe() {
    return {
      schemaVersion: 1,
      initialized: this.initialized,
      configPath: this.configPath,
      servers: this.listServers(),
      toolCount: this.toolIndex.size,
      diagnostics: structuredClone(this.diagnostics),
    };
  }

  listServers() {
    return [...this.servers.values()].map((server) => {
      const connection = this.connections.get(server.id);
      return {
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        transport: server.transport,
        url: server.transport === 'streamable_http' ? server.url : undefined,
        command: server.transport === 'stdio' ? server.command : undefined,
        args: server.transport === 'stdio' ? [...server.args] : undefined,
        cwd: server.transport === 'stdio' ? server.cwd : undefined,
        readOnlyTools: [...(server.readOnlyTools || [])],
        headerEnv: { ...(server.headerEnv || {}) },
        envKeys: [...(server.envKeys || [])],
        status: connection?.status || server.status || 'disconnected',
        lastError: connection?.lastError || server.lastError || null,
        toolCount: connection?.tools?.length || 0,
        connectedAt: connection?.connectedAt || server.connectedAt || null,
        updatedAt: server.updatedAt || null,
        stderrDrain: connection?.stderrDrain?.describe() || undefined,
      };
    });
  }

  async upsertServer(value = {}, { connect = true } = {}) {
    const server = normalizeServer(value);
    const previous = this.servers.get(server.id);
    if (previous) await this.#disconnect(server.id);
    this.servers.set(server.id, server);
    await this.#persist();
    if (connect && server.enabled) await this.#connect(server.id);
    return this.listServers().find((item) => item.id === server.id) || null;
  }

  async removeServer(id) {
    const serverId = normalizeId(id);
    if (!serverId) return false;
    await this.#disconnect(serverId);
    const removed = this.servers.delete(serverId);
    if (removed) await this.#persist();
    return removed;
  }

  async refresh(id = null) {
    const ids = id ? [normalizeId(id)] : [...this.servers.keys()];
    const results = [];
    for (const serverId of ids) {
      if (!serverId || !this.servers.has(serverId)) continue;
      const server = this.servers.get(serverId);
      if (!server.enabled) {
        await this.#disconnect(serverId);
        continue;
      }
      try {
        await this.#connect(serverId);
      } catch { /* status is retained for the management endpoint */ }
      results.push(this.listServers().find((item) => item.id === serverId));
    }
    return results;
  }

  listTools() {
    return [...this.toolIndex.values()].map(({ definition }) => structuredClone(definition));
  }

  getTool(name) {
    const record = this.toolIndex.get(String(name || ''));
    return record ? structuredClone(record.definition) : null;
  }

  async execute(name, input = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const record = this.toolIndex.get(String(name || ''));
    if (!record) throw managerError('COPILOT_MCP_TOOL_UNKNOWN', `Unknown MCP tool: ${name}.`, 404);
    const connection = await this.#ensureConnected(record.serverId);
    if (!connection) throw managerError('COPILOT_MCP_SERVER_UNAVAILABLE', `MCP server ${record.serverId} is not connected.`, 503);
    const tool = record.remote;
    const result = await connection.client.callTool(
      { name: tool.name, arguments: input && typeof input === 'object' ? input : {} },
      undefined,
      { signal, timeout: Math.max(1_000, Math.min(15 * 60 * 1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) },
    );
    return normalizeCallResult(result, record.serverId, tool.name);
  }

  async #ensureConnected(serverId) {
    const connection = this.connections.get(serverId);
    if (connection?.status === 'connected') return connection;
    const server = this.servers.get(serverId);
    if (!server?.enabled) return null;
    try { return await this.#connect(serverId); } catch { return null; }
  }

  async #connect(serverId) {
    if (this.closed) throw managerError('COPILOT_MCP_MANAGER_CLOSED', 'The MCP client manager is closed.', 503);
    const server = this.servers.get(serverId);
    if (!server) throw managerError('COPILOT_MCP_SERVER_UNKNOWN', `Unknown MCP server: ${serverId}.`, 404);
    await this.#disconnect(serverId);
    const transport = this.transportFactory(server, this.env, this.fetchImpl);
    const client = this.clientFactory(this.clientInfo, server);
    const stderrDrain = attachBoundedStderrDrain(transport?.stderr);
    const connection = {
      serverId,
      client,
      transport,
      status: 'connecting',
      tools: [],
      connectedAt: null,
      lastError: null,
      stderrDrain,
    };
    this.connections.set(serverId, connection);
    transport.onerror = (error) => {
      connection.status = 'error';
      connection.lastError = safeError(error);
      this.#removeTools(serverId);
    };
    transport.onclose = () => {
      if (this.connections.get(serverId) === connection) {
        connection.status = 'disconnected';
        this.#removeTools(serverId);
      }
    };
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const listedTools = Array.isArray(listed?.tools) ? listed.tools : [];
      connection.tools = listedTools.slice(0, MAX_TOOLS_PER_SERVER);
      if (listedTools.length > MAX_TOOLS_PER_SERVER) {
        this.#recordDiagnostic('COPILOT_MCP_TOOL_LIMIT', `Only the first ${MAX_TOOLS_PER_SERVER} tools from MCP server ${server.id} were indexed.`, {
          serverId: server.id,
          discoveredCount: listedTools.length,
        });
      }
      connection.status = 'connected';
      connection.connectedAt = this.now().toISOString();
      connection.lastError = null;
      this.#indexTools(server, connection.tools);
      server.status = 'connected';
      server.lastError = null;
      server.connectedAt = connection.connectedAt;
      server.updatedAt = connection.connectedAt;
      await this.#persist();
      return connection;
    } catch (error) {
      connection.status = 'error';
      connection.lastError = safeError(error);
      server.status = 'error';
      server.lastError = connection.lastError;
      server.updatedAt = this.now().toISOString();
      this.#removeTools(serverId);
      try { await client.close(); } catch { /* best effort */ }
      try { await transport.close?.(); } catch { /* best effort */ }
      stderrDrain?.close();
      await this.#persist();
      throw managerError('COPILOT_MCP_CONNECT_FAILED', `Could not connect to MCP server ${server.label}.`, 502, error);
    }
  }

  async #disconnect(serverId) {
    const connection = this.connections.get(serverId);
    if (!connection) {
      this.#removeTools(serverId);
      return;
    }
    this.connections.delete(serverId);
    this.#removeTools(serverId);
    try { await connection.client.close(); } catch { /* best effort */ }
    try { await connection.transport.close?.(); } catch { /* best effort */ }
    connection.stderrDrain?.close();
  }

  #indexTools(server, tools) {
    this.#removeTools(server.id);
    for (const remote of tools) {
      const remoteName = String(remote?.name || '').trim();
      if (!remoteName) continue;
      const name = namespacedToolName(server.id, remoteName);
      const explicitlyReadOnly = server.readOnlyTools.includes(remoteName);
      const displayRemoteName = truncateUtf8(remoteName, 1_000).value;
      const definition = {
        name,
        version: 'mcp-1.0.0',
        category: 'mcp',
        tags: ['mcp', server.id, displayRemoteName],
        title: truncateUtf8(remote.title || remote.annotations?.title || displayRemoteName, 500).value,
        description: truncateUtf8(remote.description || `MCP tool ${displayRemoteName} on ${server.label}.`, 4_000).value,
        risk: explicitlyReadOnly ? 'read' : 'approval_required',
        scopes: [`mcp:${server.id}`],
        idempotent: explicitlyReadOnly,
        parallelSafe: explicitlyReadOnly,
        source: 'mcp',
        serverId: server.id,
        remoteName: displayRemoteName,
        inputSchema: isObject(remote.inputSchema) ? structuredClone(remote.inputSchema) : { type: 'object', properties: {} },
      };
      this.toolIndex.set(name, { serverId: server.id, remote, definition });
    }
  }

  #removeTools(serverId) {
    for (const [name, record] of this.toolIndex) {
      if (record.serverId === serverId) this.toolIndex.delete(name);
    }
  }

  async #readConfig() {
    if (!this.configPath) return { servers: [] };
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.configPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { servers: [] };
      this.#recordDiagnostic('COPILOT_MCP_CONFIG_INVALID', 'The MCP client configuration could not be read; outbound MCP started without persisted servers.', {
        detail: safeError(error),
      });
      return { servers: [] };
    }
    if (!isObject(parsed) || !Array.isArray(parsed.servers)) {
      this.#recordDiagnostic('COPILOT_MCP_CONFIG_SERVERS_INVALID', 'The MCP client configuration has no valid servers array; outbound MCP started without persisted servers.');
      return { servers: [] };
    }
    const servers = [];
    const seen = new Set();
    const values = parsed.servers.slice(0, MAX_CONFIG_SERVERS);
    if (parsed.servers.length > MAX_CONFIG_SERVERS) {
      this.#recordDiagnostic('COPILOT_MCP_CONFIG_SERVER_LIMIT', `Only the first ${MAX_CONFIG_SERVERS} MCP server entries were loaded.`, {
        configuredCount: parsed.servers.length,
      });
    }
    for (const [index, value] of values.entries()) {
      try {
        const server = normalizeServer(value);
        if (seen.has(server.id)) {
          this.#recordDiagnostic('COPILOT_MCP_CONFIG_SERVER_DUPLICATE', `Duplicate MCP server id ${server.id} was skipped.`, { index, serverId: server.id });
          continue;
        }
        seen.add(server.id);
        servers.push(server);
      } catch (error) {
        this.#recordDiagnostic('COPILOT_MCP_CONFIG_SERVER_INVALID', 'An invalid MCP server entry was skipped.', {
          index,
          serverId: normalizeId(value?.id || value?.name || value?.label) || null,
          detail: safeError(error),
        });
      }
    }
    return { servers };
  }

  async #persist() {
    if (!this.configPath) return;
    const payload = JSON.stringify({ schemaVersion: 1, servers: [...this.servers.values()].map(persistedServer) }, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.configPath), { recursive: true });
      const temporary = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${payload}\n`, 'utf8');
      try {
        await rename(temporary, this.configPath);
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
        try { await unlink(this.configPath); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
        await rename(temporary, this.configPath);
      }
    });
    return this.writeQueue;
  }

  #recordDiagnostic(code, message, details = {}) {
    this.diagnostics.push({
      code,
      message,
      ...details,
      recordedAt: this.now().toISOString(),
    });
    if (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
    }
  }
}

export function createMcpClientManager(options) { return new McpClientManager(options); }

function createTransport(server, env, fetchImpl) {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      cwd: server.cwd || undefined,
      stderr: 'pipe',
      env: resolveEnvironment(server.envKeys, env),
    });
  }
  const headers = resolveHeaders(server, env);
  const url = new URL(server.url);
  return new StreamableHTTPClientTransport(url, {
    fetch: fetchImpl,
    requestInit: { headers },
  });
}

function normalizeServer(value = {}) {
  const id = normalizeId(value.id || value.name || value.label);
  if (!id) throw managerError('COPILOT_MCP_SERVER_ID_REQUIRED', 'MCP server id is required.', 400);
  const transport = String(value.transport || (value.command ? 'stdio' : 'streamable_http')).toLowerCase();
  if (!['stdio', 'streamable_http'].includes(transport)) throw managerError('COPILOT_MCP_TRANSPORT_INVALID', 'MCP transport must be stdio or streamable_http.', 400);
  const server = {
    id,
    label: String(value.label || id).trim().slice(0, 120) || id,
    enabled: value.enabled !== false,
    transport,
    command: transport === 'stdio' ? String(value.command || '').trim() : '',
    args: transport === 'stdio' ? arrayOfStrings(value.args).slice(0, 64) : [],
    cwd: transport === 'stdio' && value.cwd ? path.resolve(String(value.cwd)) : '',
    envKeys: transport === 'stdio' ? uniqueStrings(value.envKeys || value.env).slice(0, 64) : [],
    readOnlyTools: uniqueStrings(value.readOnlyTools).slice(0, 256),
    url: transport === 'streamable_http' ? String(value.url || '').trim() : '',
    headers: transport === 'streamable_http' ? normalizeHeaders(value.headers) : {},
    headerEnv: transport === 'streamable_http' ? normalizeHeaderEnv(value.headerEnv) : {},
    status: String(value.status || 'disconnected'),
    lastError: value.lastError ? String(value.lastError).slice(0, 1000) : null,
    connectedAt: value.connectedAt ? String(value.connectedAt) : null,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
  };
  if (transport === 'stdio' && !server.command) throw managerError('COPILOT_MCP_COMMAND_REQUIRED', 'stdio MCP servers require a command.', 400);
  if (transport === 'streamable_http') {
    let parsed;
    try { parsed = new URL(server.url); } catch { throw managerError('COPILOT_MCP_URL_INVALID', 'streamable_http MCP servers require a valid URL.', 400); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw managerError('COPILOT_MCP_URL_INVALID', 'streamable_http MCP servers require an HTTP or HTTPS URL.', 400);
    }
    if (parsed.username || parsed.password) {
      throw managerError('COPILOT_MCP_URL_USERINFO_FORBIDDEN', 'streamable_http MCP server URLs must not contain embedded credentials.', 400);
    }
  }
  return server;
}

function persistedServer(server) {
  const { status, lastError, connectedAt, updatedAt, ...stable } = server;
  return stable;
}

function resolveEnvironment(keys, env) {
  const result = {};
  for (const key of REQUIRED_PROCESS_ENV_KEYS) {
    if (env?.[key] !== undefined) setOwn(result, key, String(env[key]));
  }
  for (const key of keys || []) {
    const name = String(key || '').trim();
    if (isValidEnvName(name) && env?.[name] !== undefined) setOwn(result, name, String(env[name]));
  }
  return result;
}

function resolveHeaders(server, env) {
  const headers = { ...server.headers };
  for (const [header, key] of Object.entries(server.headerEnv || {})) {
    const value = env?.[key];
    if (value !== undefined && value !== '' && !/[\r\n]/u.test(String(value))) setOwn(headers, header, String(value));
  }
  return headers;
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    const name = String(key || '').trim();
    const val = String(raw ?? '').trim();
    if (!name || !val || !isValidHeaderName(name) || /[\r\n]/u.test(val)) continue;
    if (!STATIC_HEADER_ALLOWLIST.has(name.toLowerCase())) continue;
    setOwn(result, name, val.slice(0, 2000));
  }
  return result;
}

function normalizeHeaderEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    const header = String(key || '').trim();
    const envName = String(raw || '').trim();
    if (isValidHeaderName(header) && isValidEnvName(envName)) setOwn(result, header, envName);
  }
  return result;
}

function namespacedToolName(serverId, remoteName) {
  const serverPart = slug(serverId, 12) || 'server';
  const digest = crypto.createHash('sha256').update(`${serverId}:${remoteName}`).digest('hex').slice(0, 12);
  const prefix = `mcp.${serverPart}.`;
  const suffix = `-${digest}`;
  const remoteBudget = Math.max(1, MCP_INTERNAL_TOOL_NAME_MAX_CHARS - prefix.length - suffix.length);
  const remotePart = slug(remoteName, remoteBudget) || 'tool';
  return `${prefix}${remotePart}${suffix}`;
}

function slug(value, max) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, max);
}

function normalizeCallResult(result, serverId, remoteName) {
  const sourceContent = Array.isArray(result?.content) ? result.content : [];
  const resultValue = {
    type: 'mcp.result',
    serverId: truncateUtf8(serverId, 200).value,
    toolName: truncateUtf8(remoteName, 1_000).value,
    isError: Boolean(result?.isError),
    content: [],
    text: '',
    truncated: sourceContent.length > MCP_RESULT_MAX_ITEMS,
  };
  for (const item of sourceContent.slice(0, MCP_RESULT_MAX_ITEMS)) {
    const normalized = normalizeContentItem(item);
    const nextContent = [...resultValue.content, normalized.value];
    const nextText = contentText(nextContent);
    const candidate = { ...resultValue, content: nextContent, text: nextText, truncated: resultValue.truncated || normalized.truncated };
    if (jsonBytes(candidate) > MCP_RESULT_MAX_BYTES) {
      resultValue.truncated = true;
      break;
    }
    resultValue.content = nextContent;
    resultValue.text = nextText;
    resultValue.truncated ||= normalized.truncated;
  }
  if (resultValue.content.length < Math.min(sourceContent.length, MCP_RESULT_MAX_ITEMS)) resultValue.truncated = true;
  if (result?.structuredContent !== undefined) {
    const state = normalizationState(40_000);
    const structuredContent = normalizeJson(result.structuredContent, 0, state);
    const candidate = { ...resultValue, structuredContent, truncated: resultValue.truncated || state.truncated };
    if (jsonBytes(candidate) <= MCP_RESULT_MAX_BYTES) {
      resultValue.structuredContent = structuredContent;
      resultValue.truncated ||= state.truncated;
    } else {
      resultValue.structuredContent = { truncated: true };
      resultValue.truncated = true;
    }
  }
  return enforceResultBudget(resultValue);
}

function normalizeContentItem(item) {
  if (item?.type === 'text') {
    const text = truncateUtf8(item.text, MAX_RESULT_ITEM_BYTES);
    return { value: { type: 'text', text: text.value }, truncated: text.truncated };
  }
  if (item?.type === 'resource') {
    const state = normalizationState(MAX_RESULT_ITEM_BYTES);
    return { value: { type: 'resource', resource: normalizeJson(item.resource, 0, state) }, truncated: state.truncated };
  }
  if (item?.type === 'image' || item?.type === 'audio') {
    const data = truncateUtf8(item.data, MAX_RESULT_ITEM_BYTES);
    return {
      value: { type: item.type, mimeType: truncateUtf8(item.mimeType, 500).value, data: data.value },
      truncated: data.truncated,
    };
  }
  if (item?.type === 'resource_link') {
    const uri = truncateUtf8(item.uri, 8_000);
    const name = truncateUtf8(item.name, 2_000);
    const mimeType = truncateUtf8(item.mimeType, 500);
    return {
      value: { type: 'resource_link', uri: uri.value, name: name.value, mimeType: mimeType.value },
      truncated: uri.truncated || name.truncated || mimeType.truncated,
    };
  }
  const state = normalizationState(MAX_RESULT_ITEM_BYTES);
  return { value: normalizeJson(item, 0, state), truncated: state.truncated };
}

function normalizeJson(value, depth = 0, state = normalizationState(MAX_RESULT_ITEM_BYTES)) {
  if (state.remainingNodes <= 0 || state.remainingBytes <= 0) {
    state.truncated = true;
    return '[budget-limited]';
  }
  state.remainingNodes -= 1;
  if (depth > 6) {
    state.truncated = true;
    return '[depth-limited]';
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    state.remainingBytes -= Math.min(state.remainingBytes, 16);
    return value;
  }
  if (typeof value === 'string') {
    const text = truncateUtf8(value, Math.min(MAX_STRUCTURED_STRING_BYTES, state.remainingBytes));
    state.truncated ||= text.truncated;
    state.remainingBytes -= Buffer.byteLength(text.value, 'utf8');
    return text.value;
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      state.truncated = true;
      return '[circular]';
    }
    state.seen.add(value);
    state.truncated ||= value.length > 64;
    const result = [];
    for (const item of value.slice(0, 64)) {
      if (state.remainingNodes <= 0 || state.remainingBytes <= 0) {
        state.truncated = true;
        break;
      }
      result.push(normalizeJson(item, depth + 1, state));
    }
    state.seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (state.seen.has(value)) {
      state.truncated = true;
      return '[circular]';
    }
    state.seen.add(value);
    const entries = Object.entries(value);
    state.truncated ||= entries.length > 64;
    const result = [];
    for (const [key, item] of entries.slice(0, 64)) {
      if (state.remainingNodes <= 0 || state.remainingBytes <= 0) {
        state.truncated = true;
        break;
      }
      const normalizedKey = truncateUtf8(key, Math.min(200, state.remainingBytes));
      state.truncated ||= normalizedKey.truncated;
      state.remainingBytes -= Buffer.byteLength(normalizedKey.value, 'utf8');
      result.push([normalizedKey.value, normalizeJson(item, depth + 1, state)]);
    }
    state.seen.delete(value);
    return Object.fromEntries(result);
  }
  state.truncated = true;
  const text = truncateUtf8(String(value), Math.min(MAX_STRUCTURED_STRING_BYTES, state.remainingBytes));
  state.remainingBytes -= Buffer.byteLength(text.value, 'utf8');
  return text.value;
}

function contentText(content) {
  return content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n');
}

function enforceResultBudget(value) {
  if (jsonBytes(value) <= MCP_RESULT_MAX_BYTES) return value;
  value.truncated = true;
  if (value.structuredContent !== undefined) value.structuredContent = { truncated: true };
  while (value.content.length && jsonBytes(value) > MCP_RESULT_MAX_BYTES) {
    value.content.pop();
    value.text = contentText(value.content);
  }
  if (jsonBytes(value) > MCP_RESULT_MAX_BYTES) value.text = '';
  if (jsonBytes(value) > MCP_RESULT_MAX_BYTES) value.content = [];
  if (jsonBytes(value) > MCP_RESULT_MAX_BYTES) {
    value.toolName = truncateUtf8(value.toolName, 200).value;
    value.serverId = truncateUtf8(value.serverId, 100).value;
  }
  return value;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { value: text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return { value: text.slice(0, end), truncated: true };
}

function attachBoundedStderrDrain(stream) {
  if (!stream || typeof stream.on !== 'function') return null;
  let bytesDrained = 0;
  let truncated = false;
  const onData = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk ?? ''), 'utf8');
    const remaining = Math.max(0, MAX_STDERR_DRAIN_BYTES - bytesDrained);
    bytesDrained += Math.min(remaining, bytes);
    truncated ||= bytes > remaining;
  };
  stream.on('data', onData);
  return {
    describe: () => ({ bytesDrained, truncated }),
    close: () => stream.off?.('data', onData),
  };
}

function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function normalizationState(remainingBytes) {
  return { truncated: false, seen: new WeakSet(), remainingBytes, remainingNodes: MAX_NORMALIZED_NODES };
}
function isHighSurrogate(value) { return value >= 0xD800 && value <= 0xDBFF; }
function isLowSurrogate(value) { return value >= 0xDC00 && value <= 0xDFFF; }
function isValidHeaderName(value) {
  const name = String(value || '').trim();
  return Boolean(name && HEADER_NAME_PATTERN.test(name) && !FORBIDDEN_HEADER_NAMES.has(name.toLowerCase()));
}
function isValidEnvName(value) {
  const name = String(value || '').trim();
  return Boolean(name && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()));
}
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function arrayOfStrings(value) { return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []; }
function uniqueStrings(value) { return [...new Set(arrayOfStrings(value))]; }
function normalizeId(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48); }
function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safeError(error) { return String(error?.message || error || 'Unknown MCP error').slice(0, 1000); }
function managerError(code, message, status = 400, cause = undefined) { const error = new McpClientManagerError(code, message, status, cause); return error; }

export class McpClientManagerError extends Error {
  constructor(code, message, status = 400, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'McpClientManagerError';
    this.code = code;
    this.status = status;
  }
}
