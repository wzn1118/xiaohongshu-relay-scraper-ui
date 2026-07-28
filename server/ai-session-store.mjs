import crypto from 'node:crypto';

const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', requiresKey: true },
  codex: { label: 'Codex CLI', baseUrl: '', model: '', requiresKey: false },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', requiresKey: true },
  qwen: { label: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', requiresKey: true },
  custom: { label: 'OpenAI-compatible relay', baseUrl: '', model: '', requiresKey: true },
});

export class AiSessionStore {
  constructor({ ttlMs = 8 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  providers() {
    return Object.entries(PROVIDERS).map(([id, value]) => ({ id, ...value }));
  }

  create(value = {}) {
    this.cleanup();
    const provider = String(value.provider || '').trim().toLowerCase();
    const definition = PROVIDERS[provider];
    if (!definition) throw validation('Unsupported AI provider.');
    const apiKey = String(value.apiKey || '').trim();
    const model = String(value.model ?? definition.model).trim();
    const baseUrl = normalizeBaseUrl(value.baseUrl ?? definition.baseUrl, provider);
    if (definition.requiresKey && !apiKey) throw validation('API key is required for this provider.');
    if (provider !== 'codex' && !model) throw validation('Model is required.');
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      provider,
      apiKey,
      model,
      baseUrl,
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
}

function normalizeBaseUrl(value, provider) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (provider === 'codex') return '';
  if (!text) throw validation('Base URL is required.');
  let parsed;
  try { parsed = new URL(text); } catch { throw validation('Base URL must be a valid URL.'); }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw validation('Base URL must use HTTPS, except localhost development endpoints.');
  }
  return text;
}

function publicSession(session) {
  return {
    id: session.id,
    provider: session.provider,
    model: session.model,
    baseUrl: session.baseUrl,
    configured: true,
    expiresAt: session.expiresAt,
  };
}

function validation(message) {
  const error = new Error(message);
  error.code = 'AI_VALIDATION';
  return error;
}
