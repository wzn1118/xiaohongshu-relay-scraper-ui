import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'], requiresKey: true, wireApi: 'chat_completions', bundled: true },
  codex: { label: '内置 Codex Runtime', baseUrl: '', model: 'gpt-5.5', models: ['gpt-5.5', 'gpt-5', 'gpt-5-mini'], requiresKey: true, wireApi: 'responses', bundled: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], requiresKey: true, wireApi: 'chat_completions', bundled: true },
  qwen: { label: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], requiresKey: true, wireApi: 'chat_completions', bundled: true },
  custom: { label: '自定义 OpenAI 兼容服务', baseUrl: '', model: '', models: ['gpt-4.1-mini', 'deepseek-chat', 'qwen-plus'], requiresKey: true, wireApi: 'chat_completions', bundled: true },
});

export class AiSessionStore {
  constructor({ ttlMs = 8 * 60 * 60 * 1000, filePath = null } = {}) {
    this.ttlMs = ttlMs;
    this.filePath = filePath;
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
        configured: Boolean(saved?.apiKey),
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
    const apiKey = String(value.apiKey || saved.apiKey || '').trim();
    const model = String(value.model || saved.model || definition.model || '').trim();
    const baseUrl = normalizeBaseUrl(value.baseUrl || saved.baseUrl || definition.baseUrl);
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

  resolve(id) {
    this.cleanup();
    const session = this.sessions.get(String(id || ''));
    if (!session) throw validation('AI session is missing or expired. Configure the provider again.');
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
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) throw validation('Base URL is required.');
  let parsed;
  try { parsed = new URL(text); } catch { throw validation('Base URL must be a valid URL.'); }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw validation('Base URL must use HTTPS, except localhost development endpoints.');
  }
  return text;
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
    baseUrl: String(value.baseUrl || definition.baseUrl || '').trim().replace(/\/+$/, ''),
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

function validation(message) {
  const error = new Error(message);
  error.code = 'AI_VALIDATION';
  return error;
}
