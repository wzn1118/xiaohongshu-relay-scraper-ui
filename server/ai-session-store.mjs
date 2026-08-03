import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_MODEL_CATALOG } from './local-model-manager.mjs';

const PROVIDERS = Object.freeze({
  local_qwen: {
    label: '本地免费模型库',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5:4b',
    models: LOCAL_MODEL_CATALOG.map((item) => item.id),
    requiresKey: false,
    wireApi: 'chat_completions',
    bundled: true,
    local: true,
    free: true,
  },
  relay: {
    label: 'API 中转站（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    models: [],
    requiresKey: true,
    wireApi: 'chat_completions',
    bundled: true,
    relay: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    requiresKey: true,
    wireApi: 'chat_completions',
    bundled: true,
  },
  codex: {
    label: '内置 Codex Runtime',
    baseUrl: '',
    model: 'gpt-5.5',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5', 'gpt-5-mini'],
    requiresKey: true,
    wireApi: 'responses',
    bundled: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-reasoner', 'deepseek-chat'],
    requiresKey: true,
    wireApi: 'chat_completions',
    bundled: true,
  },
  qwen: {
    label: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen-plus', 'qwen-max', 'qwen-turbo'],
    requiresKey: true,
    wireApi: 'chat_completions',
    bundled: true,
  },
  custom: {
    label: '自定义 OpenAI 兼容服务',
    baseUrl: '',
    model: '',
    models: ['gpt-5.6-terra', 'gpt-5.5', 'gpt-4.1-mini', 'deepseek-v4-pro', 'deepseek-chat', 'qwen3.7-plus', 'qwen-plus'],
    requiresKey: true,
    wireApi: 'chat_completions',
    bundled: true,
  },
});

export class AiSessionStore {
  constructor({ ttlMs = 8 * 60 * 60 * 1000, filePath = null, fetchImpl = globalThis.fetch, modelDiscoveryTimeoutMs = 10000 } = {}) {
    this.ttlMs = ttlMs;
    this.filePath = filePath;
    this.fetchImpl = fetchImpl;
    this.modelDiscoveryTimeoutMs = modelDiscoveryTimeoutMs;
    this.sessions = new Map();
    this.configurations = new Map();
  }

  async initialize() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const payload = JSON.parse(await readFile(this.filePath, 'utf8'));
      const entries = payload && typeof payload === 'object' ? payload.providers : null;
      if (!entries || typeof entries !== 'object') return;
      for (const [provider, value] of Object.entries(entries)) {
        if (PROVIDERS[provider] && value && typeof value === 'object') {
          this.configurations.set(provider, sanitizeConfiguration(provider, value));
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`AI configuration could not be loaded: ${error.message}`);
    }
  }

  providers() {
    return Object.entries(PROVIDERS).map(([id, value]) => {
      const saved = this.configurations.get(id);
      return {
        id,
        ...value,
        models: [...value.models],
        baseUrl: saved?.baseUrl || value.baseUrl,
        model: saved?.model || value.model,
        wireApi: saved?.wireApi || value.wireApi,
        configured: Boolean(saved && (!value.requiresKey || saved.apiKey)),
        hasApiKey: Boolean(saved?.apiKey),
      };
    });
  }

  async create(value = {}) {
    this.cleanup();
    const provider = String(value.provider || '').trim().toLowerCase();
    const definition = PROVIDERS[provider];
    if (!definition) throw validation('Unsupported AI provider.');
    const saved = this.configurations.get(provider) || {};
    const suppliedApiKey = String(value.apiKey || '').trim();
    const requestedBaseUrl = normalizeBaseUrl(value.baseUrl || saved.baseUrl || definition.baseUrl);
    if (!suppliedApiKey && saved.apiKey && saved.baseUrl && requestedBaseUrl !== normalizeBaseUrl(saved.baseUrl)) {
      throw validation('Enter the API key again after changing the Base URL.');
    }
    const apiKey = suppliedApiKey || String(saved.apiKey || '').trim();
    const model = String(value.model || saved.model || definition.model || '').trim();
    const baseUrl = requestedBaseUrl;
    const wireApi = normalizeWireApi(value.wireApi || saved.wireApi || definition.wireApi);
    if (definition.requiresKey && !apiKey) throw validation('API key is required for this provider.');
    if (!model) throw validation('Model is required.');
    await this.saveConfiguration(provider, { apiKey, model, baseUrl, wireApi });
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      provider,
      apiKey,
      model,
      baseUrl,
      wireApi,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.sessions.set(session.id, session);
    return publicSession(session);
  }

  async discoverModels(value = {}) {
    const provider = String(value.provider || '').trim().toLowerCase();
    const definition = PROVIDERS[provider];
    if (!definition) throw validation('Unsupported AI provider.');
    const saved = this.configurations.get(provider) || {};
    const suppliedApiKey = String(value.apiKey || '').trim();
    const apiKey = suppliedApiKey || String(saved.apiKey || '').trim();
    const baseUrl = normalizeBaseUrl(value.baseUrl || saved.baseUrl || definition.baseUrl);
    if (definition.requiresKey && !apiKey) throw validation('API key is required to read the model list.');
    if (!suppliedApiKey && saved.apiKey && saved.baseUrl && baseUrl !== normalizeBaseUrl(saved.baseUrl)) {
      throw validation('Enter the API key again after changing the Base URL.');
    }
    if (typeof this.fetchImpl !== 'function') throw discoveryFailure('Model discovery is unavailable in this runtime.');

    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const candidates = modelDiscoveryCandidates(baseUrl, {
      preferVersioned: Boolean(definition.relay || provider === 'custom'),
    });

    for (const [index, candidate] of candidates.entries()) {
      let response;
      try {
        response = await this.fetchImpl(`${candidate.baseUrl}/models`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.modelDiscoveryTimeoutMs),
        });
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? '连接超时' : '无法访问模型服务';
        throw discoveryFailure(`读取模型列表失败：${reason}，请检查 Base URL 和网络连接。`);
      }

      if (!response.ok) {
        if (response.status === 404 && index < candidates.length - 1) continue;
        throw discoveryFailure(discoveryStatusMessage(response.status));
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        if (index < candidates.length - 1) continue;
        throw discoveryFailure('模型服务未返回有效 JSON，请确认填写的是 API Base URL，而不是网站首页。');
      }
      const models = [...new Set(modelEntries(payload).map(modelId).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
      if (!models.length) {
        if (index < candidates.length - 1) continue;
        throw discoveryFailure('模型服务已连接，但响应中没有可用的模型 ID。');
      }
      return { provider, baseUrl: candidate.baseUrl, models, fetchedAt: new Date().toISOString() };
    }

    throw discoveryFailure('未找到兼容的模型列表接口，请检查 Base URL。');
  }

  resolve(id) {
    this.cleanup();
    const session = this.sessions.get(String(id || ''));
    if (!session) throw sessionExpired('AI session is missing or expired. Configure the provider again.');
    return { ...session };
  }

  delete(id) {
    return this.sessions.delete(String(id || ''));
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
    }
  }

  async saveConfiguration(provider, value) {
    this.configurations.set(provider, {
      provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
      wireApi: value.wireApi,
      updatedAt: new Date().toISOString(),
    });
    if (!this.filePath) return;
    const payload = {
      version: 1,
      providers: Object.fromEntries(this.configurations),
    };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* Windows does not expose Unix file modes. */ }
    await rename(temporary, this.filePath);
  }
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw validation('Base URL is required.');
  let parsed;
  try { parsed = new URL(text); } catch { throw validation('Base URL must be a valid URL.'); }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw validation('Base URL must use HTTPS, except localhost development endpoints.');
  }
  if (parsed.username || parsed.password) throw validation('Base URL must not contain account credentials.');
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname
    .replace(/\/(?:chat\/completions|responses|models)\/?$/iu, '')
    .replace(/\/+$/u, '');
  return parsed.toString().replace(/\/+$/u, '');
}

function normalizeWireApi(value) {
  const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (text === 'responses' || text === 'chat_completions') return text;
  throw validation('Wire API must be responses or chat_completions.');
}

function sanitizeConfiguration(provider, value) {
  const definition = PROVIDERS[provider];
  return {
    provider,
    apiKey: String(value.apiKey || '').trim(),
    model: String(value.model || definition.model || '').trim(),
    baseUrl: normalizeBaseUrl(value.baseUrl || definition.baseUrl),
    wireApi: normalizeWireApi(value.wireApi || definition.wireApi),
    updatedAt: String(value.updatedAt || ''),
  };
}

function publicSession(session) {
  return {
    id: session.id,
    provider: session.provider,
    model: session.model,
    baseUrl: session.baseUrl,
    wireApi: session.wireApi,
    configured: true,
    expiresAt: session.expiresAt,
  };
}

function modelId(value) {
  const candidate = typeof value === 'string' ? value : value?.id || value?.name || value?.model;
  const text = String(candidate || '').trim();
  return /^[^\s<>"']{1,160}$/u.test(text) ? text : '';
}

function modelDiscoveryCandidates(baseUrl, { preferVersioned = false } = {}) {
  const direct = { baseUrl };
  const parsed = new URL(baseUrl);
  if (parsed.pathname.toLowerCase().endsWith('/v1')) return [direct];
  const versioned = { baseUrl: `${baseUrl}/v1` };
  return preferVersioned ? [versioned, direct] : [direct, versioned];
}

function modelEntries(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.data, payload?.models, payload?.result?.data, payload?.result?.models];
  return candidates.find(Array.isArray) || [];
}

function discoveryStatusMessage(status) {
  if (status === 401 || status === 403) return `模型服务返回 HTTP ${status}：API Key 无效或没有访问权限。`;
  if (status === 404) return '模型列表接口不存在，请确认 Base URL；系统已自动尝试当前地址和 /v1。';
  if (status === 429) return '模型服务返回 HTTP 429：请求过于频繁或账号额度不足。';
  if (status >= 500) return `模型服务返回 HTTP ${status}：中转服务或其上游暂时不可用。`;
  return `模型服务返回 HTTP ${status}，请检查 Base URL、API Key 和服务状态。`;
}

function validation(message) {
  const error = new Error(message);
  error.code = 'AI_VALIDATION';
  return error;
}

function sessionExpired(message) {
  const error = new Error(message);
  error.code = 'AI_SESSION_EXPIRED';
  return error;
}

function discoveryFailure(message) {
  const error = new Error(message);
  error.code = 'AI_MODEL_DISCOVERY_FAILED';
  return error;
}
